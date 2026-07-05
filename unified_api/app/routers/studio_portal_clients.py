from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from typing import Optional, Dict, Any, List
from uuid import uuid4
import re
import json
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from urllib.error import HTTPError, URLError
from datetime import date

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner, studio_require_min_role, studio_fetch_role_code
from app.services.skills_analyse_engine import _fetch_service_label
from app.routers.skills_portal_dashboard import (
    DashboardAccess,
    DashboardRiskOverview,
    DashboardScope,
    build_dashboard_risk_overview_for_scope,
    _service_options,
)

router = APIRouter()

RE_APE = re.compile(r"^\d{2}\.\d{2}$")

ALLOWED_PROFILS_STRUCTURELS = {
    "site_unique",
    "multi_site",
    "holding_multi_entreprise",
    "holding_multi_entreprise_multi_site",
}


def _normalize_profil_structurel(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip().lower()
    if not v:
        return None
    if v not in ALLOWED_PROFILS_STRUCTURELS:
        raise HTTPException(status_code=400, detail="Profil structurel invalide.")
    return v


def _is_holding_profile(value: Optional[str]) -> bool:
    return value in ("holding_multi_entreprise", "holding_multi_entreprise_multi_site")

ALLOWED_TYPES_STRUCTURE = {
    "site",
    "entreprise",
}

CORE_OFFER_CODES = ("essential", "studio_solo", "studio_reseau")
CORE_OFFER_ORDER = {"essential": 1, "studio_solo": 2, "studio_reseau": 3}
CORE_OFFER_RULES = {
    "essential": {
        "studio_actif": False,
        "insights_actif": True,
        "people_actif": True,
        "gestion_acces_studio_autorisee": False,
    },
    "studio_solo": {
        "studio_actif": True,
        "insights_actif": True,
        "people_actif": True,
        "gestion_acces_studio_autorisee": False,
    },
    "studio_reseau": {
        "studio_actif": True,
        "insights_actif": True,
        "people_actif": True,
        "gestion_acces_studio_autorisee": True,
    },
}



def _normalize_type_structure(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip().lower()
    if not v:
        return None
    if v not in ALLOWED_TYPES_STRUCTURE:
        raise HTTPException(status_code=400, detail="Type de structure invalide.")
    return v

class ClientPayload(BaseModel):
    nom_ent: Optional[str] = None
    adresse_ent: Optional[str] = None
    adresse_cplt_ent: Optional[str] = None
    cp_ent: Optional[str] = None
    ville_ent: Optional[str] = None
    pays_ent: Optional[str] = None
    email_ent: Optional[str] = None
    telephone_ent: Optional[str] = None
    site_web: Optional[str] = None
    siret_ent: Optional[str] = None
    code_ape_ent: Optional[str] = None
    num_tva_ent: Optional[str] = None
    effectif_ent: Optional[str] = None
    id_opco: Optional[str] = None
    date_creation: Optional[str] = None
    num_entreprise: Optional[str] = None
    idcc: Optional[str] = None
    nom_groupe: Optional[str] = None
    type_groupe: Optional[str] = None
    tete_groupe: Optional[bool] = None
    group_ok: Optional[bool] = None
    profil_structurel: Optional[str] = None
    type_structure: Optional[str] = None


class ContactPayload(BaseModel):
    civ_ca: Optional[str] = None
    nom_ca: Optional[str] = None
    prenom_ca: Optional[str] = None
    role_ca: Optional[str] = None
    tel_ca: Optional[str] = None
    tel2_ca: Optional[str] = None
    mail_ca: Optional[str] = None
    obs_ca: Optional[str] = None
    est_principal: Optional[bool] = None

class ContactsFromEffectifsPayload(BaseModel):
    effectif_ids: List[str] = []

class CommercialPayload(BaseModel):
    offer_code: Optional[str] = None
    statut_commercial: Optional[str] = None
    date_debut: Optional[str] = None
    date_fin: Optional[str] = None

    studio_actif: Optional[bool] = None
    insights_actif: Optional[bool] = None
    people_actif: Optional[bool] = None
    partner_actif: Optional[bool] = None
    learn_actif: Optional[bool] = None

    nb_acces_studio_max: Optional[int] = None
    nb_acces_insights_max: Optional[int] = None
    nb_acces_people_max: Optional[int] = None
    nb_acces_partner_max: Optional[int] = None
    nb_acces_learn_max: Optional[int] = None

    nb_clients_max: Optional[int] = None
    nb_sites_max: Optional[int] = None

    commentaire: Optional[str] = None
    gestion_acces_studio_autorisee: Optional[bool] = None

def _build_patch_set(payload) -> Dict[str, Any]:
    fields = payload.__fields_set__ or set()
    data = payload.dict()
    return {k: data.get(k) for k in fields}


def _normalize_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip()
    return v or None


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    v = str(value).strip().lower()
    return v in ("1", "true", "vrai", "yes", "oui", "on")

def _normalize_digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _map_public_effectif(value: Any) -> Optional[str]:
    v = str(value or "").strip()
    if not v or v == "NN":
        return None

    mapping = {
        "00": None,
        "01": "1 à 9",
        "02": "1 à 9",
        "03": "1 à 9",
        "11": "10 à 19",
        "12": "20 à 49",
        "21": "50 à 99",
        "22": "100 à 199",
        "31": "200 à 499",
        "32": "200 à 499",
        "41": "500 à 999",
        "42": "1000 et +",
        "51": "1000 et +",
        "52": "1000 et +",
        "53": "1000 et +",
    }
    return mapping.get(v)


def _clean_public_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    return re.sub(r"\s+", " ", v)


def _choose_public_search_result(results: list, query: str) -> Optional[dict]:
    if not results:
        return None

    digits = _normalize_digits(query)
    if digits:
        if len(digits) == 14:
            for item in results:
                siege = item.get("siege") or {}
                if _normalize_digits(siege.get("siret")) == digits:
                    return item
                for etab in item.get("matching_etablissements") or []:
                    if _normalize_digits(etab.get("siret")) == digits:
                        return item
        elif len(digits) == 9:
            for item in results:
                if _normalize_digits(item.get("siren")) == digits:
                    return item

    return results[0]


def _map_public_company_result(item: dict, query: str) -> dict:
    siege = item.get("siege") or {}
    matching = item.get("matching_etablissements") or []
    digits = _normalize_digits(query)
    selected_etab = siege

    if len(digits) == 14:
        for etab in matching:
            if _normalize_digits(etab.get("siret")) == digits:
                selected_etab = etab
                break
        else:
            if _normalize_digits(siege.get("siret")) == digits:
                selected_etab = siege
    elif matching:
        selected_etab = matching[0]

    idcc_list = []
    complements = item.get("complements") or {}
    for src in (selected_etab, siege, complements):
        values = src.get("liste_idcc") or []
        if isinstance(values, list):
            for val in values:
                v = _clean_public_text(val)
                if v and v not in idcc_list:
                    idcc_list.append(v)

    cp = _clean_public_text(selected_etab.get("code_postal"))
    pays = _clean_public_text(selected_etab.get("libelle_pays_etranger"))
    if not pays and cp:
        pays = "France"

    return {
        "source": "annuaire_entreprises",
        "query": _clean_public_text(query),
        "nom_ent": _clean_public_text(item.get("nom_complet") or item.get("nom_raison_sociale")),
        "siren": _clean_public_text(item.get("siren")),
        "siret_ent": _clean_public_text(selected_etab.get("siret") or siege.get("siret")),
        "date_creation": _clean_public_text(item.get("date_creation") or selected_etab.get("date_creation")),
        "code_ape_ent": _clean_public_text((item.get("activite_principale") or selected_etab.get("activite_principale") or "")[:5]),
        "effectif_ent": _map_public_effectif(item.get("tranche_effectif_salarie")),
        "adresse_ent": _clean_public_text(selected_etab.get("adresse")),
        "adresse_cplt_ent": _clean_public_text(selected_etab.get("complement_adresse")),
        "cp_ent": cp,
        "ville_ent": _clean_public_text(selected_etab.get("libelle_commune") or selected_etab.get("libelle_commune_etranger")),
        "pays_ent": pays,
        "idcc": idcc_list[0] if idcc_list else None,
    }


def _fetch_public_company_data(query: str) -> dict:
    q = _clean_public_text(query)
    if not q:
        raise HTTPException(status_code=400, detail="Saisissez un SIRET, un SIREN ou un nom de structure.")

    params = {
        "q": q,
        "per_page": 5,
        "page": 1,
    }
    url = f"https://recherche-entreprises.api.gouv.fr/search?{urlencode(params)}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "NovoskillStudio/1.0 (+https://novoskill.fr)",
    }

    try:
        req = UrlRequest(url, headers=headers, method="GET")
        with urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        if e.code == 429:
            raise HTTPException(status_code=503, detail="Service public temporairement saturé. Réessaie dans quelques secondes.")
        raise HTTPException(status_code=502, detail=f"Erreur API publique ({e.code}).")
    except URLError:
        raise HTTPException(status_code=502, detail="Impossible de joindre l’API publique des entreprises.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recherche entreprise publique impossible: {e}")

    results = payload.get("results") or []
    item = _choose_public_search_result(results, q)
    if not item:
        raise HTTPException(status_code=404, detail="Aucune structure trouvée via l’API publique.")

    return _map_public_company_result(item, q)

def _require_owner_access(cur, u: dict, id_owner: str) -> str:
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = (u.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (email, oid),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _validate_idcc_exists(cur, idcc: Optional[str]):
    if idcc is None or str(idcc).strip() == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        LIMIT 1
        """,
        (idcc,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="IDCC inconnu (référentiel).")


def _validate_ape_exists(cur, code_ape: Optional[str]):
    if code_ape is None or str(code_ape).strip() == "":
        return
    v = str(code_ape).strip()
    if not RE_APE.match(v):
        raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        LIMIT 1
        """,
        (v,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="Code APE inconnu (référentiel).")


def _validate_opco_exists(cur, id_opco: Optional[str]):
    if id_opco is None or str(id_opco).strip() == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_opco,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="OPCO inconnu ou masqué (référentiel).")


def _fetch_owner_feature_flags(cur, id_owner: str) -> dict:
    cur.execute(
        """
        SELECT
            COALESCE(oc.studio_actif, FALSE) AS studio_actif,
            COALESCE(oc.gestion_acces_studio_autorisee, FALSE) AS gestion_acces_studio_autorisee,
            COALESCE(oc.nb_acces_studio_max, 0) AS nb_acces_studio_max,
            COALESCE(o.type_owner, '') AS owner_type,
            COALESCE(e.profil_structurel, '') AS owner_profil_structurel
        FROM public.tbl_novoskill_owner o
        LEFT JOIN public.tbl_novoskill_owner_commercial oc
          ON oc.id_owner = o.id_owner
         AND COALESCE(oc.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise e
          ON e.id_ent = o.id_owner
         AND COALESCE(e.masque, FALSE) = FALSE
        WHERE o.id_owner = %s
          AND COALESCE(o.archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_owner,),
    )
    r = cur.fetchone() or {}
    return {
        "studio_actif": bool(r.get("studio_actif")),
        "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
        "nb_acces_studio_max": int(r.get("nb_acces_studio_max") or 0),
        "owner_type": (r.get("owner_type") or "").strip().lower(),
        "owner_profil_structurel": (r.get("owner_profil_structurel") or "").strip().lower(),
    }


def _lookup_idcc(cur, idcc: Optional[str]) -> Optional[str]:
    if not idcc:
        return None
    cur.execute(
        """
        SELECT libelle
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        LIMIT 1
        """,
        (idcc,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("libelle"))


def _lookup_ape(cur, code_ape: Optional[str]) -> Optional[str]:
    if not code_ape:
        return None
    cur.execute(
        """
        SELECT intitule_ape
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        LIMIT 1
        """,
        (code_ape,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("intitule_ape"))


def _lookup_opco(cur, id_opco: Optional[str]) -> Optional[str]:
    if not id_opco:
        return None
    cur.execute(
        """
        SELECT nom_opco
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_opco,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("nom_opco"))

def _normalize_statut_commercial(value: Any) -> str:
    v = str(value or "actif").strip().lower()
    if v not in ("actif", "suspendu", "test"):
        raise HTTPException(status_code=400, detail="Statut commercial invalide.")
    return v


def _normalize_quota(value: Any) -> int:
    if value is None or str(value).strip() == "":
        return 0
    try:
        iv = int(value)
    except Exception:
        raise HTTPException(status_code=400, detail="Quota invalide.")
    if iv < 0:
        raise HTTPException(status_code=400, detail="Quota invalide.")
    return iv


def _normalize_core_offer_code(value: Any) -> str:
    v = str(value or "").strip().lower()
    if not v:
        return ""
    replacements = {
        "é": "e", "è": "e", "ê": "e", "ë": "e",
        "à": "a", "â": "a", "ä": "a",
        "ù": "u", "û": "u", "ü": "u",
        "î": "i", "ï": "i",
        "ô": "o", "ö": "o",
        "ç": "c",
        "-": "_", " ": "_",
    }
    for src, dst in replacements.items():
        v = v.replace(src, dst)
    v = re.sub(r"_+", "_", v).strip("_")
    aliases = {
        "essential": "essential",
        "essentiel": "essential",
        "ess": "essential",
        "ins_ess": "essential",
        "insights_essential": "essential",
        "insights_essentiel": "essential",
        "insightsessential": "essential",
        "insightsessentiel": "essential",
        "studio_solo": "studio_solo",
        "stu_solo": "studio_solo",
        "studiosolo": "studio_solo",
        "studio_reseau": "studio_reseau",
        "studio_reseaux": "studio_reseau",
        "studio_res": "studio_reseau",
        "stu_res": "studio_reseau",
        "studioreseau": "studio_reseau",
    }
    return aliases.get(v, v)


def _quota_when_active(value: Any, active: bool, minimum: Any = 0) -> int:
    if not active:
        return 0
    return max(_normalize_quota(value), _normalize_quota(minimum))


def _table_has_column(cur, table_name: str, column_name: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = %s
          AND column_name = %s
        LIMIT 1
        """,
        (table_name, column_name),
    )
    return cur.fetchone() is not None


def _normalize_extension_console(value: Any) -> str:
    v = _normalize_core_offer_code(value)
    if v in ("studio_reseau", "studio_network", "reseau"):
        return "studio_reseau"
    if v in ("studio", "insights", "people", "learn", "partner"):
        return v
    return ""


def _int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _apply_core_offer_rules(item: dict) -> dict:
    code = _normalize_core_offer_code(item.get("offer_code"))
    rules = CORE_OFFER_RULES.get(code)
    if not rules:
        code = _normalize_core_offer_code(item.get("offer_label"))
        rules = CORE_OFFER_RULES.get(code)
    if not rules:
        return item

    item["offer_code_normalized"] = code
    item["offer_kind"] = "abonnement"
    item["studio_actif"] = bool(rules["studio_actif"])
    item["insights_actif"] = bool(rules["insights_actif"])
    item["people_actif"] = bool(rules["people_actif"])
    item["gestion_acces_studio_autorisee"] = bool(rules["gestion_acces_studio_autorisee"])
    item["learn_actif"] = False
    item["partner_actif"] = False

    if not item["studio_actif"]:
        item["nb_acces_studio_max"] = 0
    if not item["insights_actif"]:
        item["nb_acces_insights_max"] = 0
    if not item["people_actif"]:
        item["nb_acces_people_max"] = 0
    item["nb_acces_learn_max"] = 0
    item["nb_acces_partner_max"] = 0

    if not item["gestion_acces_studio_autorisee"]:
        item["nb_clients_max"] = 0
        item["nb_sites_max"] = 0

    item["ordre_affichage"] = int(item.get("ordre_affichage") or CORE_OFFER_ORDER.get(code, 99))
    return item


def _fetch_offer_catalog(cur) -> list:
    cur.execute(
        """
        SELECT
            offer_code,
            offer_label,
            segment_code,
            offer_family,
            palier_code,
            palier_label,
            ia_incluse,
            studio_actif,
            insights_actif,
            people_actif,
            partner_actif,
            learn_actif,
            gestion_acces_studio_autorisee,
            nb_acces_studio_max,
            nb_acces_insights_max,
            nb_acces_people_max,
            nb_acces_partner_max,
            nb_acces_learn_max,
            nb_clients_max,
            nb_sites_max,
            nb_collaborateurs_couverts_max,
            commentaire,
            ordre_affichage
        FROM public.tbl_novoskill_offer_catalog
        WHERE COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_catalogue, 'actif') = 'actif'
          AND (
                upper(trim(COALESCE(offer_code, ''))) IN ('INS_ESS', 'STU_SOLO', 'STU_RES')
             OR (
                    lower(trim(COALESCE(segment_code, ''))) = 'insights'
                AND lower(trim(COALESCE(offer_family, ''))) = 'essential'
                )
             OR (
                    lower(trim(COALESCE(segment_code, ''))) = 'studio'
                AND lower(trim(COALESCE(offer_family, ''))) IN ('solo', 'reseau')
                )
             OR lower(replace(replace(replace(replace(COALESCE(offer_label, ''), 'é', 'e'), 'É', 'e'), '-', '_'), ' ', '_')) IN ('insights_essential', 'studio_solo', 'studio_reseau')
          )
        ORDER BY
            CASE
              WHEN upper(trim(COALESCE(offer_code, ''))) = 'INS_ESS' THEN 10
              WHEN upper(trim(COALESCE(offer_code, ''))) = 'STU_SOLO' THEN 20
              WHEN upper(trim(COALESCE(offer_code, ''))) = 'STU_RES' THEN 30
              WHEN lower(trim(COALESCE(segment_code, ''))) = 'insights'
               AND lower(trim(COALESCE(offer_family, ''))) = 'essential' THEN 10
              WHEN lower(trim(COALESCE(segment_code, ''))) = 'studio'
               AND lower(trim(COALESCE(offer_family, ''))) = 'solo' THEN 20
              WHEN lower(trim(COALESCE(segment_code, ''))) = 'studio'
               AND lower(trim(COALESCE(offer_family, ''))) = 'reseau' THEN 30
              WHEN lower(replace(replace(replace(replace(COALESCE(offer_label, ''), 'é', 'e'), 'É', 'e'), '-', '_'), ' ', '_')) = 'insights_essential' THEN 10
              WHEN lower(replace(replace(replace(replace(COALESCE(offer_label, ''), 'é', 'e'), 'É', 'e'), '-', '_'), ' ', '_')) = 'studio_solo' THEN 20
              WHEN lower(replace(replace(replace(replace(COALESCE(offer_label, ''), 'é', 'e'), 'É', 'e'), '-', '_'), ' ', '_')) = 'studio_reseau' THEN 30
              ELSE 99
            END,
            ordre_affichage,
            lower(COALESCE(offer_label, '')),
            offer_code
        """
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        item = {
            "offer_code": r.get("offer_code"),
            "offer_label": r.get("offer_label"),
            "segment_code": r.get("segment_code"),
            "offer_family": r.get("offer_family"),
            "palier_code": r.get("palier_code"),
            "palier_label": r.get("palier_label"),
            "ia_incluse": bool(r.get("ia_incluse")),
            "studio_actif": bool(r.get("studio_actif")),
            "insights_actif": bool(r.get("insights_actif")),
            "people_actif": bool(r.get("people_actif")),
            "partner_actif": bool(r.get("partner_actif")),
            "learn_actif": bool(r.get("learn_actif")),
            "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
            "nb_acces_studio_max": r.get("nb_acces_studio_max"),
            "nb_acces_insights_max": r.get("nb_acces_insights_max"),
            "nb_acces_people_max": r.get("nb_acces_people_max"),
            "nb_acces_partner_max": r.get("nb_acces_partner_max"),
            "nb_acces_learn_max": r.get("nb_acces_learn_max"),
            "nb_clients_max": r.get("nb_clients_max"),
            "nb_sites_max": r.get("nb_sites_max"),
            "nb_collaborateurs_couverts_max": r.get("nb_collaborateurs_couverts_max"),
            "commentaire": r.get("commentaire"),
            "ordre_affichage": int(r.get("ordre_affichage") or 0),
        }
        items.append(_apply_core_offer_rules(item))
    return items


def _fetch_offer_defaults(cur, offer_code: str) -> dict:
    wanted = _normalize_core_offer_code(offer_code)
    if wanted not in CORE_OFFER_CODES:
        raise HTTPException(status_code=400, detail="Offre commerciale invalide. Abonnements autorisés : Insights Essential, Studio Solo, Studio Réseau.")

    for item in _fetch_offer_catalog(cur):
        item_code = item.get("offer_code") or ""
        item_norm = item.get("offer_code_normalized") or _normalize_core_offer_code(item_code or item.get("offer_label"))
        if item_code == offer_code or item_norm == wanted:
            return _apply_core_offer_rules(item)

    raise HTTPException(status_code=400, detail="Offre commerciale introuvable ou archivée.")


def _extension_target_from_row(row: dict) -> dict:
    configured_console = _normalize_extension_console(row.get("console_code"))
    configured_scope = str(row.get("extension_scope") or "").strip().lower()

    candidates = [
        ("studio_reseau", "clients", "nb_clients_max", "delta_nb_clients", _int_or_zero(row.get("delta_nb_clients"))),
        ("studio_reseau", "sites", "nb_sites_max", "delta_nb_sites", _int_or_zero(row.get("delta_nb_sites"))),
        ("studio", "acces", "nb_acces_studio_max", "delta_nb_acces_studio", _int_or_zero(row.get("delta_nb_acces_studio"))),
        ("insights", "acces", "nb_acces_insights_max", "delta_nb_acces_insights", _int_or_zero(row.get("delta_nb_acces_insights"))),
        ("people", "acces", "nb_acces_people_max", "delta_nb_acces_people", _int_or_zero(row.get("delta_nb_acces_people"))),
        ("learn", "acces", "nb_acces_learn_max", "delta_nb_acces_learn", _int_or_zero(row.get("delta_nb_acces_learn"))),
        ("partner", "acces", "nb_acces_partner_max", "delta_nb_acces_partner", _int_or_zero(row.get("delta_nb_acces_partner"))),
    ]

    for console_code, scope, target_quota, delta_column, delta in candidates:
        if delta <= 0:
            continue
        if configured_console and configured_console != console_code:
            continue
        if configured_scope and configured_scope not in (scope, ""):
            continue
        return {
            "console_code": configured_console or console_code,
            "extension_scope": configured_scope or scope,
            "target_quota": target_quota,
            "delta_column": delta_column,
            "delta": delta,
        }

    return {
        "console_code": configured_console,
        "extension_scope": configured_scope,
        "target_quota": "",
        "delta_column": "",
        "delta": 0,
    }


def _fetch_extension_catalog(cur) -> list:
    has_console_code = _table_has_column(cur, "tbl_novoskill_offer_extension_catalog", "console_code")
    has_extension_scope = _table_has_column(cur, "tbl_novoskill_offer_extension_catalog", "extension_scope")

    console_select = "console_code" if has_console_code else "NULL::text AS console_code"
    scope_select = "extension_scope" if has_extension_scope else "NULL::text AS extension_scope"

    cur.execute(
        f"""
        SELECT
            extension_code,
            extension_label,
            {console_select},
            {scope_select},
            cible_segment_code,
            cible_offer_family,
            delta_nb_acces_studio,
            delta_nb_acces_insights,
            delta_nb_acces_people,
            delta_nb_acces_partner,
            delta_nb_acces_learn,
            delta_nb_clients,
            delta_nb_sites,
            delta_nb_collaborateurs_couverts,
            commentaire,
            ordre_affichage
        FROM public.tbl_novoskill_offer_extension_catalog
        WHERE COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_catalogue, 'actif') = 'actif'
        ORDER BY ordre_affichage, lower(extension_label), extension_code
        """
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        target = _extension_target_from_row(r)
        if not target.get("console_code") or not target.get("target_quota") or target.get("delta", 0) <= 0:
            continue
        items.append(
            {
                "extension_code": r.get("extension_code"),
                "extension_label": r.get("extension_label"),
                "console_code": target.get("console_code"),
                "extension_scope": target.get("extension_scope"),
                "target_quota": target.get("target_quota"),
                "delta_column": target.get("delta_column"),
                "delta": int(target.get("delta") or 0),
                "commentaire": r.get("commentaire"),
                "ordre_affichage": int(r.get("ordre_affichage") or 0),
            }
        )
    return items


def _ensure_offer_exists(cur, offer_code: str) -> None:
    return _fetch_offer_defaults(cur, offer_code)


def _ensure_client_owner_scope(cur, id_ent: str) -> None:
    ent_id = _normalize_text(id_ent)
    if not ent_id:
        raise HTTPException(status_code=400, detail="Structure obligatoire.")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_owner
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (ent_id,),
    )
    if cur.fetchone() is not None:
        return

    cur.execute(
        """
        SELECT
            nom_ent,
            lower(COALESCE(type_entreprise, '')) AS type_entreprise,
            id_owner_gestionnaire
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (ent_id,),
    )
    src = cur.fetchone() or {}
    ent_type = (src.get("type_entreprise") or "").strip().lower()
    if not ent_type:
        raise HTTPException(status_code=404, detail="Structure introuvable.")

    nom_owner = _normalize_text(src.get("nom_ent")) or ent_id
    id_owner_parent = _normalize_text(src.get("id_owner_gestionnaire"))
    owner_type = "site" if ent_type == "site" else "entreprise"

    cur.execute(
        """
        INSERT INTO public.tbl_novoskill_owner (
            id_owner,
            nom_owner,
            type_owner,
            id_owner_parent,
            archive,
            statut_owner,
            created_at,
            updated_at
        ) VALUES (%s, %s, %s, %s, FALSE, 'actif', NOW(), NOW())
        ON CONFLICT (id_owner)
        DO UPDATE SET
            nom_owner = EXCLUDED.nom_owner,
            type_owner = EXCLUDED.type_owner,
            id_owner_parent = EXCLUDED.id_owner_parent,
            archive = FALSE,
            statut_owner = 'actif',
            updated_at = NOW()
        """,
        (ent_id, nom_owner, owner_type, id_owner_parent),
    )



def _sync_client_skills_eligibility(cur, id_ent: str) -> bool:
    """
    Synchronise l'éligibilité Skills historique de tbl_entreprise avec
    l'abonnement commercial porté par le scope owner de la structure.

    Le portail Insights filtre encore tbl_entreprise.contrat_skills.
    Une offre Studio/Insights active doit donc ouvrir ce flag, sinon
    l'utilisateur peut avoir ses droits applicatifs mais rester bloqué
    au chargement du dashboard.
    """
    ent_id = _normalize_text(id_ent)
    if not ent_id:
        raise HTTPException(status_code=400, detail="Structure obligatoire.")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_owner_commercial oc
        WHERE oc.id_owner = %s
          AND COALESCE(oc.archive, FALSE) = FALSE
          AND COALESCE(oc.statut_commercial, 'actif') = 'actif'
          AND COALESCE(oc.insights_actif, FALSE) = TRUE
          AND COALESCE(oc.date_debut, CURRENT_DATE) <= CURRENT_DATE
          AND (oc.date_fin IS NULL OR oc.date_fin >= CURRENT_DATE)
        LIMIT 1
        """,
        (ent_id,),
    )
    eligible = cur.fetchone() is not None

    cur.execute(
        """
        UPDATE public.tbl_entreprise
        SET contrat_skills = %s
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (eligible, ent_id),
    )
    return eligible


def _initialiser_referentiel_studio_client(cur, id_ent: str) -> dict:
    """
    Initialise une seule fois le référentiel exploitable d'un client qui devient Studio.

    Règle métier :
    - les postes rattachés à l'entreprise cliente deviennent portés par son owner ;
    - les compétences externes utilisées dans ses postes sont copiées dans son owner ;
    - les codes compétences sont conservés ;
    - les liens opérationnels basculent vers les copies client ;
    - les données source du gestionnaire restent intactes.

    La fonction est idempotente : si les liens pointent déjà vers des compétences client,
    elle ne recopie rien. En cas de downgrade puis réactivation Studio, la propriété reste
    donc stable et aucune nouvelle copie n'est déclenchée.
    """
    ent_id = _normalize_text(id_ent)
    if not ent_id:
        raise HTTPException(status_code=400, detail="Structure obligatoire.")

    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"studio_referentiel:{ent_id}",))

    cur.execute(
        """
        SELECT id_owner_gestionnaire
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (ent_id,),
    )
    ent_row = cur.fetchone() or {}
    if not ent_row:
        raise HTTPException(status_code=404, detail="Structure introuvable.")

    cur.execute(
        """
        SELECT
            id_comp,
            id_owner,
            code,
            intitule,
            description,
            domaine,
            niveaua,
            niveaub,
            niveauc,
            niveaud,
            grille_evaluation,
            etat
        FROM (
            SELECT DISTINCT
                c.id_comp,
                c.id_owner,
                c.code,
                c.intitule,
                c.description,
                c.domaine,
                c.niveaua,
                c.niveaub,
                c.niveauc,
                c.niveaud,
                c.grille_evaluation,
                COALESCE(c.etat, 'valide') AS etat,
                lower(COALESCE(c.code, '')) AS sort_code,
                lower(COALESCE(c.intitule, '')) AS sort_intitule
            FROM public.tbl_fiche_poste p
            JOIN public.tbl_fiche_poste_competence pc
              ON pc.id_poste = p.id_poste
             AND COALESCE(pc.masque, FALSE) = FALSE
            JOIN public.tbl_competence c
              ON c.id_comp = pc.id_competence
             AND COALESCE(c.masque, FALSE) = FALSE
            WHERE p.id_ent = %s
              AND COALESCE(c.id_owner, '') <> %s
        ) src
        ORDER BY sort_code, sort_intitule
        """,
        (ent_id, ent_id),
    )
    source_rows = cur.fetchall() or []

    comp_map: Dict[str, str] = {}
    copied_count = 0
    reused_count = 0

    for src in source_rows:
        source_id = _normalize_text(src.get("id_comp"))
        if not source_id:
            continue

        code = _normalize_text(src.get("code")) or source_id
        intitule = _normalize_text(src.get("intitule")) or code

        cur.execute(
            """
            SELECT id_comp
            FROM public.tbl_competence
            WHERE id_owner = %s
              AND lower(COALESCE(code, '')) = lower(%s)
              AND lower(COALESCE(intitule, '')) = lower(%s)
            ORDER BY COALESCE(masque, FALSE), date_creation DESC NULLS LAST, id_comp DESC
            LIMIT 1
            """,
            (ent_id, code, intitule),
        )
        existing = cur.fetchone() or {}
        target_id = _normalize_text(existing.get("id_comp"))

        if target_id:
            reused_count += 1
        else:
            target_id = str(uuid4())
            cur.execute(
                """
                INSERT INTO public.tbl_competence (
                    id_comp,
                    id_owner,
                    code,
                    intitule,
                    description,
                    domaine,
                    niveaua,
                    niveaub,
                    niveauc,
                    niveaud,
                    grille_evaluation,
                    etat,
                    masque,
                    date_creation,
                    date_modification
                ) VALUES (
                    %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s,
                    FALSE, NOW(), NOW()
                )
                """,
                (
                    target_id,
                    ent_id,
                    code,
                    intitule,
                    src.get("description"),
                    src.get("domaine"),
                    src.get("niveaua"),
                    src.get("niveaub"),
                    src.get("niveauc"),
                    src.get("niveaud"),
                    src.get("grille_evaluation"),
                    _normalize_text(src.get("etat")) or "valide",
                ),
            )
            copied_count += 1

        if target_id != source_id:
            comp_map[source_id] = target_id

    updated_poste_links = 0
    masked_poste_links = 0
    updated_effectif_links = 0
    archived_effectif_links = 0
    updated_demandes = 0
    updated_contenus = 0

    for source_id, target_id in comp_map.items():
        cur.execute(
            """
            UPDATE public.tbl_fiche_poste_competence pc
            SET id_competence = %s,
                date_modification = NOW()
            WHERE pc.id_competence = %s
              AND COALESCE(pc.masque, FALSE) = FALSE
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_poste = pc.id_poste
                      AND p.id_ent = %s
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.tbl_fiche_poste_competence pc2
                    WHERE pc2.id_poste = pc.id_poste
                      AND pc2.id_competence = %s
              )
            """,
            (target_id, source_id, ent_id, target_id),
        )
        updated_poste_links += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_fiche_poste_competence pc
            SET masque = TRUE,
                date_modification = NOW()
            WHERE pc.id_competence = %s
              AND COALESCE(pc.masque, FALSE) = FALSE
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_poste = pc.id_poste
                      AND p.id_ent = %s
              )
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_fiche_poste_competence pc2
                    WHERE pc2.id_poste = pc.id_poste
                      AND pc2.id_competence = %s
                      AND COALESCE(pc2.masque, FALSE) = FALSE
              )
            """,
            (source_id, ent_id, target_id),
        )
        masked_poste_links += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_effectif_client_competence ecc
            SET id_comp = %s
            WHERE ecc.id_comp = %s
              AND COALESCE(ecc.archive, FALSE) = FALSE
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_effectif_client ec
                    WHERE ec.id_effectif = ecc.id_effectif_client
                      AND ec.id_ent = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.tbl_effectif_client_competence ecc2
                    WHERE ecc2.id_effectif_client = ecc.id_effectif_client
                      AND ecc2.id_comp = %s
                      AND COALESCE(ecc2.archive, FALSE) = FALSE
              )
            """,
            (target_id, source_id, ent_id, target_id),
        )
        updated_effectif_links += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_effectif_client_competence ecc
            SET archive = TRUE,
                actif = FALSE
            WHERE ecc.id_comp = %s
              AND COALESCE(ecc.archive, FALSE) = FALSE
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_effectif_client ec
                    WHERE ec.id_effectif = ecc.id_effectif_client
                      AND ec.id_ent = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
              )
              AND EXISTS (
                    SELECT 1
                    FROM public.tbl_effectif_client_competence ecc2
                    WHERE ecc2.id_effectif_client = ecc.id_effectif_client
                      AND ecc2.id_comp = %s
                      AND COALESCE(ecc2.archive, FALSE) = FALSE
              )
            """,
            (source_id, ent_id, target_id),
        )
        archived_effectif_links += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_insights_besoin_formation
            SET id_comp = %s,
                updated_at = NOW()
            WHERE id_ent_source = %s
              AND id_comp = %s
              AND COALESCE(archive, FALSE) = FALSE
            """,
            (target_id, ent_id, source_id),
        )
        updated_demandes += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_contenu_ligne
            SET id_competence = %s,
                date_modification = NOW()
            WHERE id_owner = %s
              AND id_competence = %s
              AND COALESCE(archive, FALSE) = FALSE
            """,
            (target_id, ent_id, source_id),
        )
        updated_contenus += cur.rowcount or 0

        cur.execute(
            """
            UPDATE public.tbl_contenu_ligne
            SET competences_liees = (
                    SELECT COALESCE(
                        jsonb_agg(
                            CASE
                              WHEN src.value = %s THEN to_jsonb(%s::text)
                              ELSE to_jsonb(src.value)
                            END
                            ORDER BY src.ord
                        ),
                        '[]'::jsonb
                    )
                    FROM jsonb_array_elements_text(COALESCE(competences_liees, '[]'::jsonb)) WITH ORDINALITY AS src(value, ord)
                ),
                date_modification = NOW()
            WHERE id_owner = %s
              AND COALESCE(archive, FALSE) = FALSE
              AND COALESCE(competences_liees, '[]'::jsonb) @> %s::jsonb
            """,
            (source_id, target_id, ent_id, json.dumps([source_id])),
        )
        updated_contenus += cur.rowcount or 0

    cur.execute(
        """
        UPDATE public.tbl_fiche_poste
        SET id_owner = %s,
            date_maj = NOW()
        WHERE id_ent = %s
          AND COALESCE(id_owner, '') <> %s
        """,
        (ent_id, ent_id, ent_id),
    )
    updated_postes = cur.rowcount or 0

    return {
        "competences_source": len(source_rows),
        "competences_copiees": copied_count,
        "competences_reutilisees": reused_count,
        "liens_postes_mis_a_jour": updated_poste_links,
        "liens_postes_masques": masked_poste_links,
        "evaluations_mises_a_jour": updated_effectif_links,
        "evaluations_archivees": archived_effectif_links,
        "demandes_mises_a_jour": updated_demandes,
        "contenus_mis_a_jour": updated_contenus,
        "postes_transferes": updated_postes,
    }

def _fetch_client_commercial(cur, id_ent: str) -> dict:
    cur.execute(
        """
        SELECT
            id_owner_commercial,
            id_owner,
            offer_code,
            archive,
            created_at,
            updated_at,
            statut_commercial,
            date_debut,
            date_fin,
            studio_actif,
            insights_actif,
            people_actif,
            partner_actif,
            learn_actif,
            nb_acces_studio_max,
            nb_acces_insights_max,
            nb_acces_people_max,
            nb_acces_partner_max,
            nb_acces_learn_max,
            nb_clients_max,
            nb_sites_max,
            commentaire,
            gestion_acces_studio_autorisee
        FROM public.tbl_novoskill_owner_commercial
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY created_at DESC, id_owner_commercial DESC
        LIMIT 1
        """,
        (id_ent,),
    )
    r = cur.fetchone()
    if not r:
        return {
            "exists": False,
            "id_owner_commercial": None,
            "id_owner": id_ent,
            "offer_code": "",
            "statut_commercial": "actif",
            "date_debut": date.today().isoformat(),
            "date_fin": None,
            "studio_actif": False,
            "insights_actif": False,
            "people_actif": False,
            "partner_actif": False,
            "learn_actif": False,
            "nb_acces_studio_max": 0,
            "nb_acces_insights_max": 0,
            "nb_acces_people_max": 0,
            "nb_acces_partner_max": 0,
            "nb_acces_learn_max": 0,
            "nb_clients_max": 0,
            "nb_sites_max": 0,
            "commentaire": None,
            "gestion_acces_studio_autorisee": False,
        }

    return {
        "exists": True,
        "id_owner_commercial": r.get("id_owner_commercial"),
        "id_owner": r.get("id_owner"),
        "offer_code": r.get("offer_code") or "",
        "statut_commercial": r.get("statut_commercial") or "actif",
        "date_debut": r.get("date_debut").isoformat() if r.get("date_debut") else None,
        "date_fin": r.get("date_fin").isoformat() if r.get("date_fin") else None,
        "studio_actif": bool(r.get("studio_actif")),
        "insights_actif": bool(r.get("insights_actif")),
        "people_actif": bool(r.get("people_actif")),
        "partner_actif": bool(r.get("partner_actif")),
        "learn_actif": bool(r.get("learn_actif")),
        "nb_acces_studio_max": int(r.get("nb_acces_studio_max") or 0),
        "nb_acces_insights_max": int(r.get("nb_acces_insights_max") or 0),
        "nb_acces_people_max": int(r.get("nb_acces_people_max") or 0),
        "nb_acces_partner_max": int(r.get("nb_acces_partner_max") or 0),
        "nb_acces_learn_max": int(r.get("nb_acces_learn_max") or 0),
        "nb_clients_max": int(r.get("nb_clients_max") or 0),
        "nb_sites_max": int(r.get("nb_sites_max") or 0),
        "commentaire": r.get("commentaire"),
        "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
    }

def _structure_exists_for_owner(cur, id_owner: str, id_ent: str, include_masked: bool = False) -> bool:
    sql = """
        SELECT 1
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
    """
    params = [id_ent, id_owner]
    if not include_masked:
        sql += " AND COALESCE(masque, FALSE) = FALSE"
    sql += " LIMIT 1"
    cur.execute(sql, tuple(params))
    return cur.fetchone() is not None

def _fetch_structure_subtree_ids(cur, id_owner: str, root_id: str, archive_state: Optional[bool] = None) -> list:
    archive_filter = ""
    if archive_state is True:
        archive_filter = " AND COALESCE(l.archive, FALSE) = TRUE "
    elif archive_state is False:
        archive_filter = " AND COALESCE(l.archive, FALSE) = FALSE "

    cur.execute(
        f"""
        WITH RECURSIVE subtree AS (
            SELECT %s::text AS id_ent

            UNION ALL

            SELECT l.id_ent_enfant
            FROM public.tbl_entreprise_liaison l
            JOIN subtree s
              ON s.id_ent = l.id_ent_parent
            JOIN public.tbl_entreprise e
              ON e.id_ent = l.id_ent_enfant
            WHERE e.id_owner_gestionnaire = %s
              {archive_filter}
        )
        SELECT DISTINCT id_ent
        FROM subtree
        """,
        (root_id, id_owner),
    )
    rows = cur.fetchall() or []
    return [str((r.get("id_ent") or "")).strip() for r in rows if (r.get("id_ent") or "").strip()]

def _fetch_clients_summary(cur, id_owner: str) -> dict:
    cur.execute(
        """
        SELECT
            COUNT(*) AS total_clients,
            COUNT(*) FILTER (WHERE COALESCE(group_ok, FALSE) = TRUE) AS nb_groupes,
            COUNT(*) FILTER (WHERE COALESCE(tete_groupe, FALSE) = TRUE) AS nb_tetes_groupe,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner o
                    WHERE o.id_owner = e.id_ent
                      AND COALESCE(o.archive, FALSE) = FALSE
                )
            ) AS nb_owner_scope,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner_commercial oc
                    WHERE oc.id_owner = e.id_ent
                      AND COALESCE(oc.archive, FALSE) = FALSE
                      AND COALESCE(oc.studio_actif, FALSE) = TRUE
                )
            ) AS nb_studio_actif,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner_commercial oc
                    WHERE oc.id_owner = e.id_ent
                      AND COALESCE(oc.archive, FALSE) = FALSE
                      AND COALESCE(oc.gestion_acces_studio_autorisee, FALSE) = TRUE
                )
            ) AS nb_studio_delegue
        FROM public.tbl_entreprise e
        WHERE e.id_owner_gestionnaire = %s
          AND e.type_entreprise = 'Client'
          AND COALESCE(e.masque, FALSE) = FALSE
        """,
        (id_owner,),
    )
    r = cur.fetchone() or {}
    return {
        "total_clients": int(r.get("total_clients") or 0),
        "nb_groupes": int(r.get("nb_groupes") or 0),
        "nb_tetes_groupe": int(r.get("nb_tetes_groupe") or 0),
        "nb_owner_scope": int(r.get("nb_owner_scope") or 0),
        "nb_studio_actif": int(r.get("nb_studio_actif") or 0),
        "nb_studio_delegue": int(r.get("nb_studio_delegue") or 0),
    }


def _fetch_clients_list(cur, id_owner: str) -> list:
    cur.execute(
        """
        SELECT
            e.id_ent,
            e.nom_ent,
            e.cp_ent,
            e.ville_ent,
            e.pays_ent,
            e.email_ent,
            e.telephone_ent,
            e.site_web,
            e.nom_groupe,
            e.type_groupe,
            e.group_ok,
            e.tete_groupe,
            e.profil_structurel,
            EXISTS (
                SELECT 1
                FROM public.tbl_novoskill_owner o
                WHERE o.id_owner = e.id_ent
                  AND COALESCE(o.archive, FALSE) = FALSE
            ) AS has_owner_scope,
            COALESCE((
                SELECT oc.studio_actif
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS studio_actif,
            COALESCE((
                SELECT oc.gestion_acces_studio_autorisee
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS gestion_acces_studio_autorisee
        FROM public.tbl_entreprise e
        WHERE e.id_owner_gestionnaire = %s
          AND e.type_entreprise = 'Client'
          AND COALESCE(e.masque, FALSE) = FALSE
        ORDER BY lower(e.nom_ent), e.id_ent
        """,
        (id_owner,),
    )
    rows = cur.fetchall() or []
    out = []
    for r in rows:
        out.append(
            {
                "id_ent": r.get("id_ent"),
                "nom_ent": r.get("nom_ent"),
                "cp_ent": r.get("cp_ent"),
                "ville_ent": r.get("ville_ent"),
                "pays_ent": r.get("pays_ent"),
                "email_ent": r.get("email_ent"),
                "telephone_ent": r.get("telephone_ent"),
                "site_web": r.get("site_web"),
                "nom_groupe": r.get("nom_groupe"),
                "type_groupe": r.get("type_groupe"),
                "group_ok": bool(r.get("group_ok")),
                "tete_groupe": bool(r.get("tete_groupe")),
                "profil_structurel": r.get("profil_structurel"),
                "has_owner_scope": bool(r.get("has_owner_scope")),
                "studio_actif": bool(r.get("studio_actif")),
                "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
            }
        )
    return out


def _fetch_client_detail(cur, id_owner: str, id_ent: str) -> dict:
    cur.execute(
        """
        SELECT
            e.id_ent,
            e.nom_ent,
            e.adresse_ent,
            e.adresse_cplt_ent,
            e.cp_ent,
            e.ville_ent,
            e.pays_ent,
            e.email_ent,
            e.telephone_ent,
            e.siret_ent,
            e.code_ape_ent,
            e.num_tva_ent,
            e.effectif_ent,
            e.id_opco,
            e.date_creation,
            e.num_entreprise,
            e.type_entreprise,
            e.site_web,
            e.idcc,
            e.nom_groupe,
            e.type_groupe,
            e.tete_groupe,
            e.group_ok,
            e.id_owner_gestionnaire,
            e.profil_structurel,
            CASE
                WHEN lower(COALESCE(e.type_entreprise, '')) = 'site' THEN 'site'
                ELSE COALESCE((
                    SELECT o.type_owner
                    FROM public.tbl_novoskill_owner o
                    WHERE o.id_owner = e.id_ent
                      AND COALESCE(o.archive, FALSE) = FALSE
                    LIMIT 1
                ), 'entreprise')
            END AS owner_type_client,
            EXISTS (
                SELECT 1
                FROM public.tbl_novoskill_owner o
                WHERE o.id_owner = e.id_ent
                  AND COALESCE(o.archive, FALSE) = FALSE
            ) AS has_owner_scope,
            COALESCE((
                SELECT oc.studio_actif
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS studio_actif,
            COALESCE((
                SELECT oc.gestion_acces_studio_autorisee
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS gestion_acces_studio_autorisee,
            COALESCE((
                SELECT oc.nb_acces_studio_max
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), 0) AS nb_acces_studio_max,
            COALESCE((
                SELECT COUNT(*)
                FROM public.tbl_entreprise_liaison l
                WHERE l.id_ent_parent = e.id_ent
                  AND COALESCE(l.archive, FALSE) = FALSE
            ), 0) AS nb_entites_enfants,
            COALESCE((
                SELECT COUNT(*)
                FROM public.tbl_entreprise_liaison l
                WHERE l.id_ent_enfant = e.id_ent
                  AND COALESCE(l.archive, FALSE) = FALSE
            ), 0) AS nb_entites_parents
        FROM public.tbl_entreprise e
        WHERE e.id_ent = %s
          AND e.id_owner_gestionnaire = %s
          AND COALESCE(e.masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_owner),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Structure introuvable.")

    return {
        "id_ent": r.get("id_ent"),
        "nom_ent": r.get("nom_ent"),
        "adresse_ent": r.get("adresse_ent"),
        "adresse_cplt_ent": r.get("adresse_cplt_ent"),
        "cp_ent": r.get("cp_ent"),
        "ville_ent": r.get("ville_ent"),
        "pays_ent": r.get("pays_ent"),
        "email_ent": r.get("email_ent"),
        "telephone_ent": r.get("telephone_ent"),
        "siret_ent": r.get("siret_ent"),
        "code_ape_ent": r.get("code_ape_ent"),
        "num_tva_ent": r.get("num_tva_ent"),
        "effectif_ent": r.get("effectif_ent"),
        "id_opco": r.get("id_opco"),
        "date_creation": r.get("date_creation").isoformat() if r.get("date_creation") else None,
        "num_entreprise": r.get("num_entreprise"),
        "type_entreprise": r.get("type_entreprise"),
        "site_web": r.get("site_web"),
        "idcc": r.get("idcc"),
        "idcc_libelle": _lookup_idcc(cur, r.get("idcc")),
        "code_ape_intitule": _lookup_ape(cur, r.get("code_ape_ent")),
        "opco_nom": _lookup_opco(cur, r.get("id_opco")),
        "nom_groupe": r.get("nom_groupe"),
        "type_groupe": r.get("type_groupe"),
        "tete_groupe": bool(r.get("tete_groupe")),
        "group_ok": bool(r.get("group_ok")),
        "id_owner_gestionnaire": r.get("id_owner_gestionnaire"),
        "profil_structurel": r.get("profil_structurel"),
        "owner_type_client": (r.get("owner_type_client") or "entreprise"),
        "has_owner_scope": bool(r.get("has_owner_scope")),
        "studio_actif": bool(r.get("studio_actif")),
        "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
        "nb_acces_studio_max": int(r.get("nb_acces_studio_max") or 0),
        "nb_entites_enfants": int(r.get("nb_entites_enfants") or 0),
        "nb_entites_parents": int(r.get("nb_entites_parents") or 0),
    }


@router.get("/studio/clients/{id_owner}")
def get_studio_clients(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                return {
                    "summary": _fetch_clients_summary(cur, oid),
                    "owner_features": _fetch_owner_feature_flags(cur, oid),
                    "items": _fetch_clients_list(cur, oid),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}")
def get_studio_client_detail(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                return _fetch_client_detail(cur, oid, id_ent)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/detail error: {e}")


@router.get("/studio/offers/{id_owner}")
def get_studio_offer_catalog(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                return {"items": _fetch_offer_catalog(cur)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/offers error: {e}")


@router.get("/studio/offer-extensions/{id_owner}")
def get_studio_offer_extension_catalog(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                return {"items": _fetch_extension_catalog(cur)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/offer-extensions error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}/commercial")
def get_studio_client_commercial(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent, include_masked=True):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                detail = _fetch_client_commercial(cur, id_ent)
                return detail

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/commercial/detail error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/commercial")
def upsert_studio_client_commercial(id_owner: str, id_ent: str, payload: CommercialPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent, include_masked=True):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                offer_code = _normalize_text(payload.offer_code)
                if not offer_code:
                    raise HTTPException(status_code=400, detail="Offre obligatoire.")

                _ensure_offer_exists(cur, offer_code)
                _ensure_client_owner_scope(cur, id_ent)

                statut_commercial = _normalize_statut_commercial(payload.statut_commercial)
                date_debut = payload.date_debut or date.today().isoformat()
                date_fin = payload.date_fin or None

                offer_defaults = _fetch_offer_defaults(cur, offer_code)

                studio_actif = bool(offer_defaults.get("studio_actif"))
                insights_actif = bool(offer_defaults.get("insights_actif"))
                people_actif = bool(offer_defaults.get("people_actif"))
                gestion_acces_studio_autorisee = bool(offer_defaults.get("gestion_acces_studio_autorisee"))

                partner_actif = bool(payload.partner_actif)
                learn_actif = bool(payload.learn_actif)

                nb_acces_studio_max = _quota_when_active(payload.nb_acces_studio_max, studio_actif, offer_defaults.get("nb_acces_studio_max"))
                nb_acces_insights_max = _quota_when_active(payload.nb_acces_insights_max, insights_actif, offer_defaults.get("nb_acces_insights_max"))
                nb_acces_people_max = _quota_when_active(payload.nb_acces_people_max, people_actif, offer_defaults.get("nb_acces_people_max"))
                nb_acces_partner_max = _quota_when_active(payload.nb_acces_partner_max, partner_actif, 0)
                nb_acces_learn_max = _quota_when_active(payload.nb_acces_learn_max, learn_actif, 0)
                nb_clients_max = _quota_when_active(payload.nb_clients_max, gestion_acces_studio_autorisee, offer_defaults.get("nb_clients_max"))
                nb_sites_max = _quota_when_active(payload.nb_sites_max, gestion_acces_studio_autorisee, offer_defaults.get("nb_sites_max"))
                commentaire = _normalize_text(payload.commentaire)

                cur.execute(
                    """
                    SELECT id_owner_commercial
                    FROM public.tbl_novoskill_owner_commercial
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY created_at DESC, id_owner_commercial DESC
                    LIMIT 1
                    """,
                    (id_ent,),
                )
                existing = cur.fetchone() or {}

                if existing.get("id_owner_commercial"):
                    cur.execute(
                        """
                        UPDATE public.tbl_novoskill_owner_commercial
                        SET
                            offer_code = %s,
                            updated_at = NOW(),
                            statut_commercial = %s,
                            date_debut = %s,
                            date_fin = %s,
                            studio_actif = %s,
                            insights_actif = %s,
                            people_actif = %s,
                            partner_actif = %s,
                            learn_actif = %s,
                            nb_acces_studio_max = %s,
                            nb_acces_insights_max = %s,
                            nb_acces_people_max = %s,
                            nb_acces_partner_max = %s,
                            nb_acces_learn_max = %s,
                            nb_clients_max = %s,
                            nb_sites_max = %s,
                            commentaire = %s,
                            gestion_acces_studio_autorisee = %s,
                            archive = FALSE
                        WHERE id_owner_commercial = %s
                        """,
                        (
                            offer_code,
                            statut_commercial,
                            date_debut,
                            date_fin,
                            studio_actif,
                            insights_actif,
                            people_actif,
                            partner_actif,
                            learn_actif,
                            nb_acces_studio_max,
                            nb_acces_insights_max,
                            nb_acces_people_max,
                            nb_acces_partner_max,
                            nb_acces_learn_max,
                            nb_clients_max,
                            nb_sites_max,
                            commentaire,
                            gestion_acces_studio_autorisee,
                            existing.get("id_owner_commercial"),
                        ),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO public.tbl_novoskill_owner_commercial (
                            id_owner_commercial,
                            id_owner,
                            offer_code,
                            archive,
                            created_at,
                            updated_at,
                            statut_commercial,
                            date_debut,
                            date_fin,
                            studio_actif,
                            insights_actif,
                            people_actif,
                            partner_actif,
                            learn_actif,
                            nb_acces_studio_max,
                            nb_acces_insights_max,
                            nb_acces_people_max,
                            nb_acces_partner_max,
                            nb_acces_learn_max,
                            nb_clients_max,
                            nb_sites_max,
                            commentaire,
                            gestion_acces_studio_autorisee
                        ) VALUES (
                            %s, %s, %s, FALSE, NOW(), NOW(), %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s
                        )
                        """,
                        (
                            str(uuid4()),
                            id_ent,
                            offer_code,
                            statut_commercial,
                            date_debut,
                            date_fin,
                            studio_actif,
                            insights_actif,
                            people_actif,
                            partner_actif,
                            learn_actif,
                            nb_acces_studio_max,
                            nb_acces_insights_max,
                            nb_acces_people_max,
                            nb_acces_partner_max,
                            nb_acces_learn_max,
                            nb_clients_max,
                            nb_sites_max,
                            commentaire,
                            gestion_acces_studio_autorisee,
                        ),
                    )

                referentiel_studio = None
                if studio_actif:
                    referentiel_studio = _initialiser_referentiel_studio_client(cur, id_ent)

                _sync_client_skills_eligibility(cur, id_ent)
                conn.commit()

                detail = _fetch_client_commercial(cur, id_ent)
                if referentiel_studio is not None:
                    detail["referentiel_studio"] = referentiel_studio
                return detail

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/commercial/upsert error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/commercial/archive")
def archive_studio_client_commercial(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent, include_masked=True):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_novoskill_owner_commercial
                    SET archive = TRUE,
                        updated_at = NOW()
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (id_ent,),
                )
                _sync_client_skills_eligibility(cur, id_ent)
                conn.commit()
                return {"ok": True, "id_owner": id_ent}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/commercial/archive error: {e}")

@router.post("/studio/clients/{id_owner}")
def create_studio_client(id_owner: str, payload: ClientPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)
        nom_ent = _normalize_text(patch.get("nom_ent"))
        if not nom_ent:
            raise HTTPException(status_code=400, detail="Le nom de l'entreprise est obligatoire.")

        group_ok = _normalize_bool(patch.get("group_ok"))
        tete_groupe = _normalize_bool(patch.get("tete_groupe")) if group_ok else False
        profil_structurel = _normalize_profil_structurel(patch.get("profil_structurel"))

        if not _is_holding_profile(profil_structurel):
            group_ok = False
            tete_groupe = False

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                _validate_idcc_exists(cur, _normalize_text(patch.get("idcc")))
                _validate_ape_exists(cur, _normalize_text(patch.get("code_ape_ent")))
                _validate_opco_exists(cur, _normalize_text(patch.get("id_opco")))

                new_id = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise (
                        id_ent,
                        nom_ent,
                        adresse_ent,
                        adresse_cplt_ent,
                        cp_ent,
                        ville_ent,
                        pays_ent,
                        email_ent,
                        telephone_ent,
                        siret_ent,
                        code_ape_ent,
                        num_tva_ent,
                        effectif_ent,
                        id_opco,
                        date_creation,
                        num_entreprise,
                        type_entreprise,
                        masque,
                        site_web,
                        idcc,
                        nom_groupe,
                        type_groupe,
                        tete_groupe,
                        group_ok,
                        profil_structurel,
                        id_owner_gestionnaire
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        'Client', FALSE, %s, %s,
                        %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        new_id,
                        nom_ent,
                        _normalize_text(patch.get("adresse_ent")),
                        _normalize_text(patch.get("adresse_cplt_ent")),
                        _normalize_text(patch.get("cp_ent")),
                        _normalize_text(patch.get("ville_ent")),
                        _normalize_text(patch.get("pays_ent")),
                        _normalize_text(patch.get("email_ent")),
                        _normalize_text(patch.get("telephone_ent")),
                        _normalize_text(patch.get("siret_ent")),
                        _normalize_text(patch.get("code_ape_ent")),
                        _normalize_text(patch.get("num_tva_ent")),
                        _normalize_text(patch.get("effectif_ent")),
                        _normalize_text(patch.get("id_opco")),
                        patch.get("date_creation"),
                        _normalize_text(patch.get("num_entreprise")),
                        _normalize_text(patch.get("site_web")),
                        _normalize_text(patch.get("idcc")),
                        _normalize_text(patch.get("nom_groupe")) if group_ok else None,
                        _normalize_text(patch.get("type_groupe")) if group_ok else None,
                        tete_groupe,
                        group_ok,
                        profil_structurel,
                        oid,
                    ),
                )
                conn.commit()
                return _fetch_client_detail(cur, oid, new_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/create error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}")
def update_studio_client(id_owner: str, id_ent: str, payload: ClientPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)
        if "nom_ent" in patch:
            patch["nom_ent"] = _normalize_text(patch.get("nom_ent"))
            if not patch["nom_ent"]:
                raise HTTPException(status_code=400, detail="Le nom de l'entreprise est obligatoire.")

        if "group_ok" in patch:
            patch["group_ok"] = _normalize_bool(patch.get("group_ok"))

        if "tete_groupe" in patch:
            patch["tete_groupe"] = _normalize_bool(patch.get("tete_groupe"))

        if "profil_structurel" in patch:
            patch["profil_structurel"] = _normalize_profil_structurel(patch.get("profil_structurel"))

        profil_structurel_final = patch.get("profil_structurel")

        if profil_structurel_final is not None and not _is_holding_profile(profil_structurel_final):
            patch["group_ok"] = False
            patch["nom_groupe"] = None
            patch["type_groupe"] = None
            patch["tete_groupe"] = False
        elif patch.get("group_ok") is False:
            patch["nom_groupe"] = None
            patch["type_groupe"] = None
            patch["tete_groupe"] = False

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                _validate_idcc_exists(cur, _normalize_text(patch.get("idcc")))
                _validate_ape_exists(cur, _normalize_text(patch.get("code_ape_ent")))
                _validate_opco_exists(cur, _normalize_text(patch.get("id_opco")))

                allowed = {
                    "nom_ent", "adresse_ent", "adresse_cplt_ent", "cp_ent", "ville_ent", "pays_ent",
                    "email_ent", "telephone_ent", "site_web", "siret_ent", "code_ape_ent", "num_tva_ent",
                    "effectif_ent", "id_opco", "date_creation", "num_entreprise", "idcc",
                    "nom_groupe", "type_groupe", "tete_groupe", "group_ok", "profil_structurel"
                }
                cols = []
                vals = []

                for k, v in patch.items():
                    if k not in allowed:
                        continue

                    if k in ("group_ok", "tete_groupe"):
                        vv = _normalize_bool(v)
                    elif k == "date_creation":
                        vv = v
                    elif k == "profil_structurel":
                        vv = _normalize_profil_structurel(v)
                    else:
                        vv = _normalize_text(v)

                    cols.append(f"{k} = %s")
                    vals.append(vv)

                if cols:
                    vals.extend([id_ent, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                          AND id_owner_gestionnaire = %s
                          AND COALESCE(masque, FALSE) = FALSE
                        """,
                        tuple(vals),
                    )
                    conn.commit()

                return _fetch_client_detail(cur, oid, id_ent)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/update error: {e}")




def _normalize_civilite_contact(value: Any) -> str:
    v = str(value or "-").strip()
    if v not in ("Mme", "M.", "-"):
        return "-"
    return v


def _normalize_email(value: Any) -> Optional[str]:
    v = _normalize_text(value)
    return v.lower() if v else None


def _normalize_nom(value: Any) -> Optional[str]:
    v = _normalize_text(value)
    return v.upper() if v else None


def _normalize_prenom(value: Any) -> Optional[str]:
    v = _normalize_text(value)
    if not v:
        return None
    return v[:1].upper() + v[1:].lower()


def _contact_row_to_dict(row: dict) -> dict:
    return {
        "id_contact": row.get("id_contact"),
        "id_effectif_client": row.get("id_effectif_client"),
        "civ_ca": row.get("civ_ca"),
        "nom_ca": row.get("nom_ca"),
        "prenom_ca": row.get("prenom_ca"),
        "role_ca": row.get("role_ca"),
        "tel_ca": row.get("tel_ca"),
        "tel2_ca": row.get("tel2_ca"),
        "mail_ca": row.get("mail_ca"),
        "obs_ca": row.get("obs_ca"),
        "est_principal": bool(row.get("est_principal")),
        "source_contact": "effectif" if row.get("id_effectif_client") else "manuel",
    }


def _fetch_client_contacts(cur, id_ent: str) -> list:
    cur.execute(
        """
        SELECT
            id_contact,
            id_effectif_client,
            civ_ca,
            nom_ca,
            prenom_ca,
            role_ca,
            tel_ca,
            tel2_ca,
            mail_ca,
            obs_ca,
            COALESCE(est_principal, FALSE) AS est_principal
        FROM public.tbl_contact
        WHERE code_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        ORDER BY COALESCE(est_principal, FALSE) DESC,
                 lower(COALESCE(nom_ca, '')),
                 lower(COALESCE(prenom_ca, '')),
                 id_contact
        """,
        (id_ent,),
    )
    return [_contact_row_to_dict(r) for r in (cur.fetchall() or [])]


def _ensure_contact_scope(cur, id_ent: str, id_contact: str) -> dict:
    cur.execute(
        """
        SELECT
            id_contact,
            id_effectif_client,
            civ_ca,
            nom_ca,
            prenom_ca,
            role_ca,
            tel_ca,
            tel2_ca,
            mail_ca,
            obs_ca,
            COALESCE(est_principal, FALSE) AS est_principal
        FROM public.tbl_contact
        WHERE id_contact = %s
          AND code_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_contact, id_ent),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    return row


def _set_unique_principal_contact(cur, id_ent: str, id_contact: Optional[str] = None) -> None:
    """
    Garantit un seul contact principal actif par entreprise.
    On évite le pattern SQL (%s IS NULL OR ...), car PostgreSQL ne peut pas typer
    un paramètre NULL utilisé uniquement dans un test IS NULL.
    """
    if id_contact:
        cur.execute(
            """
            UPDATE public.tbl_contact
            SET est_principal = FALSE
            WHERE code_ent = %s
              AND COALESCE(masque, FALSE) = FALSE
              AND id_contact <> %s
            """,
            (id_ent, id_contact),
        )
        return

    cur.execute(
        """
        UPDATE public.tbl_contact
        SET est_principal = FALSE
        WHERE code_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (id_ent,),
    )

def _build_contact_values(payload: ContactPayload) -> dict:
    nom = _normalize_nom(payload.nom_ca)
    prenom = _normalize_prenom(payload.prenom_ca)
    if not nom:
        raise HTTPException(status_code=400, detail="Le nom du contact est obligatoire.")
    if not prenom:
        raise HTTPException(status_code=400, detail="Le prénom du contact est obligatoire.")

    return {
        "civ_ca": _normalize_civilite_contact(payload.civ_ca),
        "nom_ca": nom,
        "prenom_ca": prenom,
        "role_ca": _normalize_text(payload.role_ca),
        "tel_ca": _normalize_text(payload.tel_ca),
        "tel2_ca": _normalize_text(payload.tel2_ca),
        "mail_ca": _normalize_email(payload.mail_ca),
        "obs_ca": _normalize_text(payload.obs_ca),
        "est_principal": _normalize_bool(payload.est_principal),
    }


def _sync_linked_effectif_from_contact(cur, id_ent: str, id_effectif: Optional[str], values: dict) -> None:
    if not id_effectif:
        return
    cur.execute(
        """
        UPDATE public.tbl_effectif_client
        SET civilite_effectif = %s,
            nom_effectif = %s,
            prenom_effectif = %s,
            email_effectif = %s,
            telephone_effectif = %s,
            telephone2_effectif = %s,
            dernier_update = NOW()
        WHERE id_effectif = %s
          AND id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (
            values.get("civ_ca"),
            values.get("nom_ca"),
            values.get("prenom_ca"),
            values.get("mail_ca"),
            values.get("tel_ca"),
            values.get("tel2_ca"),
            id_effectif,
            id_ent,
        ),
    )


@router.get("/studio/clients/{id_owner}/{id_ent}/contacts")
def get_studio_client_contacts(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")
                return {"items": _fetch_client_contacts(cur, id_ent)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/contacts error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}/contacts/effectifs-disponibles")
def get_studio_client_contact_effectifs(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                cur.execute(
                    """
                    SELECT
                        ec.id_effectif,
                        ec.civilite_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.email_effectif,
                        ec.telephone_effectif,
                        ec.telephone2_effectif,
                        COALESCE(fp.intitule_poste, '') AS role_effectif
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = ec.id_poste_actuel
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE ec.id_ent = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.statut_actif, TRUE) = TRUE
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.tbl_contact c
                          WHERE c.code_ent = ec.id_ent
                            AND COALESCE(c.masque, FALSE) = FALSE
                            AND (
                                c.id_effectif_client = ec.id_effectif
                                OR (
                                    c.mail_ca IS NOT NULL
                                    AND ec.email_effectif IS NOT NULL
                                    AND lower(c.mail_ca) = lower(ec.email_effectif)
                                )
                            )
                      )
                    ORDER BY lower(ec.nom_effectif), lower(ec.prenom_effectif), ec.id_effectif
                    """,
                    (id_ent,),
                )
                rows = cur.fetchall() or []
                items = []
                for r in rows:
                    items.append({
                        "id_effectif": r.get("id_effectif"),
                        "civilite_effectif": r.get("civilite_effectif"),
                        "nom_effectif": r.get("nom_effectif"),
                        "prenom_effectif": r.get("prenom_effectif"),
                        "email_effectif": r.get("email_effectif"),
                        "telephone_effectif": r.get("telephone_effectif"),
                        "telephone2_effectif": r.get("telephone2_effectif"),
                        "role_effectif": r.get("role_effectif"),
                    })
                return {"items": items}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/contacts/effectifs error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/contacts/from-effectifs")
def create_studio_client_contacts_from_effectifs(id_owner: str, id_ent: str, payload: ContactsFromEffectifsPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    ids = [str(x or "").strip() for x in (payload.effectif_ids or []) if str(x or "").strip()]
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise HTTPException(status_code=400, detail="Aucun effectif sélectionné.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                cur.execute(
                    """
                    SELECT
                        ec.id_effectif,
                        ec.civilite_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.email_effectif,
                        ec.telephone_effectif,
                        ec.telephone2_effectif,
                        COALESCE(fp.intitule_poste, '') AS role_effectif
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = ec.id_poste_actuel
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE ec.id_ent = %s
                      AND ec.id_effectif = ANY(%s)
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.statut_actif, TRUE) = TRUE
                    """,
                    (id_ent, ids),
                )
                rows = cur.fetchall() or []
                if not rows:
                    raise HTTPException(status_code=400, detail="Aucun effectif actif éligible.")

                for r in rows:
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_contact c
                        WHERE c.code_ent = %s
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND (
                              c.id_effectif_client = %s
                              OR (
                                  c.mail_ca IS NOT NULL
                                  AND %s IS NOT NULL
                                  AND lower(c.mail_ca) = lower(%s)
                              )
                          )
                        LIMIT 1
                        """,
                        (id_ent, r.get("id_effectif"), r.get("email_effectif"), r.get("email_effectif")),
                    )
                    if cur.fetchone() is not None:
                        continue

                    cur.execute(
                        """
                        INSERT INTO public.tbl_contact
                            (id_contact, code_ent, civ_ca, nom_ca, prenom_ca, role_ca, tel_ca, tel2_ca, mail_ca, obs_ca, created_at, masque, est_principal, id_effectif_client)
                        VALUES
                            (%s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, CURRENT_DATE, FALSE, FALSE, %s)
                        """,
                        (
                            str(uuid4()),
                            id_ent,
                            _normalize_civilite_contact(r.get("civilite_effectif")),
                            _normalize_nom(r.get("nom_effectif")),
                            _normalize_prenom(r.get("prenom_effectif")),
                            _normalize_text(r.get("role_effectif")),
                            _normalize_text(r.get("telephone_effectif")),
                            _normalize_text(r.get("telephone2_effectif")),
                            _normalize_email(r.get("email_effectif")),
                            r.get("id_effectif"),
                        ),
                    )

                conn.commit()
                return {"items": _fetch_client_contacts(cur, id_ent)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/contacts/from-effectifs error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/contacts/manual")
def create_studio_client_contact_manual(id_owner: str, id_ent: str, payload: ContactPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        values = _build_contact_values(payload)
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                if values.get("est_principal"):
                    _set_unique_principal_contact(cur, id_ent)

                id_effectif = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client
                        (id_effectif, id_ent, nom_effectif, prenom_effectif, civilite_effectif,
                         email_effectif, telephone_effectif, telephone2_effectif, statut_actif,
                         archive, date_creation, dernier_update, is_temp)
                    VALUES
                        (%s, %s, %s, %s, %s, %s, %s, %s, TRUE, FALSE, CURRENT_DATE, NOW(), FALSE)
                    """,
                    (
                        id_effectif,
                        id_ent,
                        values.get("nom_ca"),
                        values.get("prenom_ca"),
                        values.get("civ_ca"),
                        values.get("mail_ca"),
                        values.get("tel_ca"),
                        values.get("tel2_ca"),
                    ),
                )

                cur.execute(
                    """
                    INSERT INTO public.tbl_contact
                        (id_contact, code_ent, civ_ca, nom_ca, prenom_ca, role_ca, tel_ca, tel2_ca, mail_ca, obs_ca, created_at, masque, est_principal, id_effectif_client)
                    VALUES
                        (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_DATE, FALSE, %s, %s)
                    """,
                    (
                        str(uuid4()),
                        id_ent,
                        values.get("civ_ca"),
                        values.get("nom_ca"),
                        values.get("prenom_ca"),
                        values.get("role_ca"),
                        values.get("tel_ca"),
                        values.get("tel2_ca"),
                        values.get("mail_ca"),
                        values.get("obs_ca"),
                        values.get("est_principal"),
                        id_effectif,
                    ),
                )

                conn.commit()
                return {"items": _fetch_client_contacts(cur, id_ent)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/contacts/manual error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/contacts/{id_contact}")
def update_studio_client_contact(id_owner: str, id_ent: str, id_contact: str, payload: ContactPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        values = _build_contact_values(payload)
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                row = _ensure_contact_scope(cur, id_ent, id_contact)
                if values.get("est_principal"):
                    _set_unique_principal_contact(cur, id_ent, id_contact)

                cur.execute(
                    """
                    UPDATE public.tbl_contact
                    SET civ_ca = %s,
                        nom_ca = %s,
                        prenom_ca = %s,
                        role_ca = %s,
                        tel_ca = %s,
                        tel2_ca = %s,
                        mail_ca = %s,
                        obs_ca = %s,
                        est_principal = %s
                    WHERE id_contact = %s
                      AND code_ent = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (
                        values.get("civ_ca"),
                        values.get("nom_ca"),
                        values.get("prenom_ca"),
                        values.get("role_ca"),
                        values.get("tel_ca"),
                        values.get("tel2_ca"),
                        values.get("mail_ca"),
                        values.get("obs_ca"),
                        values.get("est_principal"),
                        id_contact,
                        id_ent,
                    ),
                )

                _sync_linked_effectif_from_contact(cur, id_ent, row.get("id_effectif_client"), values)
                conn.commit()
                return {"items": _fetch_client_contacts(cur, id_ent)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/contacts/update error: {e}")

@router.post("/studio/clients/{id_owner}/{id_ent}/archive")
def archive_studio_client(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET masque = TRUE
                    WHERE id_ent = %s
                      AND id_owner_gestionnaire = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (id_ent, oid),
                )
                conn.commit()
                return {"ok": True, "id_ent": id_ent}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/archive error: {e}")

@router.get("/studio/clients/{id_owner}/{id_ent}/dashboard/risk-overview", response_model=DashboardRiskOverview)
def get_studio_client_dashboard_risk_overview(
    id_owner: str,
    id_ent: str,
    request: Request,
    id_service: Optional[str] = None,
    criticite_min: Optional[int] = None,
):
    """
    Dashboard Insights embarqué dans Studio > Espace de gestion.
    Important : l'authentification et le périmètre sont Studio, mais le moteur de calcul
    reste celui du dashboard Insights via build_dashboard_risk_overview_for_scope().
    Ne pas conditionner cette route à insights_actif : elle dépend de Studio actif.
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                requested_service = (id_service or "").strip()
                effective_service = None if not requested_service or requested_service == "__ALL__" else requested_service
                scope_raw = _fetch_service_label(cur, id_ent, effective_service)
                scope = DashboardScope(
                    id_service=scope_raw.id_service,
                    nom_service=scope_raw.nom_service,
                )

                role_code = studio_fetch_role_code(
                    cur,
                    (u.get("email") or ""),
                    oid,
                    bool(u.get("is_super_admin")),
                )
                access = DashboardAccess(
                    role_code=role_code,
                    locked_service=False,
                    id_service_user=None,
                )
                services = _service_options(cur, id_ent, access, scope)

                return build_dashboard_risk_overview_for_scope(
                    cur,
                    id_ent=id_ent,
                    access=access,
                    scope=scope,
                    services=services,
                    criticite_min=criticite_min,
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/dashboard/risk-overview error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}/structures")
def get_studio_child_structures(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")

                cur.execute(
                    """
                    WITH RECURSIVE tree AS (
                        SELECT
                            l.id_ent_parent,
                            l.id_ent_enfant,
                            l.type_liaison,
                            1 AS depth
                        FROM public.tbl_entreprise_liaison l
                        JOIN public.tbl_entreprise e
                          ON e.id_ent = l.id_ent_enfant
                        WHERE l.id_ent_parent = %s
                          AND e.id_owner_gestionnaire = %s
                          AND COALESCE(l.archive, FALSE) = FALSE
                          AND COALESCE(e.masque, FALSE) = FALSE

                        UNION ALL

                        SELECT
                            l.id_ent_parent,
                            l.id_ent_enfant,
                            l.type_liaison,
                            t.depth + 1 AS depth
                        FROM public.tbl_entreprise_liaison l
                        JOIN public.tbl_entreprise e
                          ON e.id_ent = l.id_ent_enfant
                        JOIN tree t
                          ON t.id_ent_enfant = l.id_ent_parent
                        WHERE e.id_owner_gestionnaire = %s
                          AND COALESCE(l.archive, FALSE) = FALSE
                          AND COALESCE(e.masque, FALSE) = FALSE
                    )
                    SELECT
                        t.id_ent_parent,
                        t.id_ent_enfant AS id_ent,
                        t.type_liaison,
                        t.depth,
                        e.nom_ent,
                        e.ville_ent,
                        e.type_entreprise,
                        e.profil_structurel,
                        EXISTS (
                            SELECT 1
                            FROM public.tbl_novoskill_owner o
                            WHERE o.id_owner = e.id_ent
                              AND COALESCE(o.archive, FALSE) = FALSE
                        ) AS has_owner_scope,
                        EXISTS (
                            SELECT 1
                            FROM public.tbl_entreprise_liaison l2
                            JOIN public.tbl_entreprise e2
                              ON e2.id_ent = l2.id_ent_enfant
                            WHERE l2.id_ent_parent = e.id_ent
                              AND e2.id_owner_gestionnaire = %s
                              AND COALESCE(l2.archive, FALSE) = FALSE
                              AND COALESCE(e2.masque, FALSE) = FALSE
                        ) AS has_children
                    FROM tree t
                    JOIN public.tbl_entreprise e
                      ON e.id_ent = t.id_ent_enfant
                    ORDER BY
                      t.depth,
                      CASE
                        WHEN lower(COALESCE(e.type_entreprise, '')) = 'entreprise' THEN 0
                        WHEN lower(COALESCE(e.type_entreprise, '')) = 'site' THEN 1
                        ELSE 2
                      END,
                      lower(e.nom_ent),
                      e.id_ent
                    """,
                    (id_ent, oid, oid, oid),
                )
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    items.append(
                        {
                            "id_ent_parent": r.get("id_ent_parent"),
                            "id_ent": r.get("id_ent"),
                            "nom_ent": r.get("nom_ent"),
                            "ville_ent": r.get("ville_ent"),
                            "type_entreprise": r.get("type_entreprise"),
                            "profil_structurel": r.get("profil_structurel"),
                            "type_liaison": r.get("type_liaison"),
                            "depth": int(r.get("depth") or 0),
                            "has_owner_scope": bool(r.get("has_owner_scope")),
                            "has_children": bool(r.get("has_children")),
                        }
                    )

                return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/structures/{id_child}/detach")
def detach_studio_child_structure(id_owner: str, id_ent: str, id_child: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure parente introuvable.")

                if not _structure_exists_for_owner(cur, oid, id_child):
                    raise HTTPException(status_code=404, detail="Structure enfant introuvable.")

                branch_ids = _fetch_structure_subtree_ids(cur, oid, id_child, archive_state=False)
                if not branch_ids:
                    branch_ids = [id_child]

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = TRUE
                    WHERE COALESCE(archive, FALSE) = FALSE
                      AND (
                        (id_ent_parent = %s AND id_ent_enfant = %s)
                        OR
                        (id_ent_parent = ANY(%s) AND id_ent_enfant = ANY(%s))
                      )
                    """,
                    (id_ent, id_child, branch_ids, branch_ids),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET masque = TRUE
                    WHERE id_owner_gestionnaire = %s
                      AND id_ent = ANY(%s)
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (oid, branch_ids),
                )

                conn.commit()
                return {
                    "ok": True,
                    "id_ent_parent": id_ent,
                    "id_ent_enfant": id_child,
                    "nb_structures_archivees": len(branch_ids),
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures/detach error: {e}")

@router.get("/studio/clients/{id_owner}/{id_ent}/structures/history")
def get_studio_child_structures_history(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure courante introuvable.")

                cur.execute(
                    """
                    SELECT
                        e.id_ent,
                        e.nom_ent,
                        e.ville_ent,
                        e.type_entreprise,
                        e.profil_structurel,
                        EXISTS (
                            SELECT 1
                            FROM public.tbl_novoskill_owner o
                            WHERE o.id_owner = e.id_ent
                              AND COALESCE(o.archive, FALSE) = FALSE
                        ) AS has_owner_scope,
                        (
                            SELECT p.nom_ent
                            FROM public.tbl_entreprise_liaison l
                            JOIN public.tbl_entreprise p
                              ON p.id_ent = l.id_ent_parent
                            WHERE l.id_ent_enfant = e.id_ent
                              AND COALESCE(l.archive, FALSE) = TRUE
                              AND p.id_owner_gestionnaire = %s
                            ORDER BY p.nom_ent
                            LIMIT 1
                        ) AS previous_parent_name
                    FROM public.tbl_entreprise e
                    WHERE e.id_owner_gestionnaire = %s
                      AND COALESCE(e.masque, FALSE) = TRUE
                      AND lower(COALESCE(e.type_entreprise, '')) IN ('client', 'entreprise', 'site')
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_entreprise_liaison lp
                        JOIN public.tbl_entreprise pe
                          ON pe.id_ent = lp.id_ent_parent
                        WHERE lp.id_ent_enfant = e.id_ent
                          AND COALESCE(lp.archive, FALSE) = TRUE
                          AND pe.id_owner_gestionnaire = %s
                          AND COALESCE(pe.masque, FALSE) = TRUE
                      )
                    ORDER BY lower(e.nom_ent), e.id_ent
                    """,
                    (oid, oid, oid),
                )
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    subtree_ids = _fetch_structure_subtree_ids(cur, oid, r.get("id_ent"), archive_state=None)
                    items.append(
                        {
                            "id_ent": r.get("id_ent"),
                            "nom_ent": r.get("nom_ent"),
                            "ville_ent": r.get("ville_ent"),
                            "type_entreprise": r.get("type_entreprise"),
                            "profil_structurel": r.get("profil_structurel"),
                            "has_owner_scope": bool(r.get("has_owner_scope")),
                            "previous_parent_name": r.get("previous_parent_name"),
                            "nb_descendants": max(0, len(subtree_ids) - 1),
                        }
                    )

                return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures/history error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/structures/{id_child}/restore_here")
def restore_studio_child_structure_here(id_owner: str, id_ent: str, id_child: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure de rattachement introuvable.")

                if not _structure_exists_for_owner(cur, oid, id_child, include_masked=True):
                    raise HTTPException(status_code=404, detail="Structure à réactiver introuvable.")

                cur.execute(
                    """
                    SELECT lower(COALESCE(type_entreprise, '')) AS type_entreprise
                    FROM public.tbl_entreprise
                    WHERE id_ent = %s
                      AND id_owner_gestionnaire = %s
                    LIMIT 1
                    """,
                    (id_child, oid),
                )
                child_row = cur.fetchone() or {}
                child_type = (child_row.get("type_entreprise") or "").strip().lower()
                if not child_type:
                    raise HTTPException(status_code=404, detail="Structure à réactiver introuvable.")

                branch_ids = _fetch_structure_subtree_ids(cur, oid, id_child, archive_state=None)
                if not branch_ids:
                    branch_ids = [id_child]

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET masque = FALSE
                    WHERE id_owner_gestionnaire = %s
                      AND id_ent = ANY(%s)
                    """,
                    (oid, branch_ids),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = FALSE
                    WHERE id_ent_parent = ANY(%s)
                      AND id_ent_enfant = ANY(%s)
                    """,
                    (branch_ids, branch_ids),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = TRUE
                    WHERE id_ent_enfant = %s
                      AND id_ent_parent <> %s
                    """,
                    (id_child, id_ent),
                )

                if child_type == "site":
                    cur.execute(
                        """
                        UPDATE public.tbl_entreprise
                        SET type_entreprise = 'Site'
                        WHERE id_ent = %s
                          AND id_owner_gestionnaire = %s
                        """,
                        (id_child, oid),
                    )
                    type_liaison = "site"
                else:
                    cur.execute(
                        """
                        UPDATE public.tbl_entreprise
                        SET type_entreprise = 'Entreprise'
                        WHERE id_ent = %s
                          AND id_owner_gestionnaire = %s
                        """,
                        (id_child, oid),
                    )
                    type_liaison = "filiale"

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = FALSE,
                        type_liaison = %s
                    WHERE id_ent_parent = %s
                      AND id_ent_enfant = %s
                    """,
                    (type_liaison, id_ent, id_child),
                )

                if cur.rowcount <= 0:
                    cur.execute(
                        """
                        INSERT INTO public.tbl_entreprise_liaison (
                            id_ent_parent,
                            id_ent_enfant,
                            type_liaison,
                            archive
                        ) VALUES (%s, %s, %s, FALSE)
                        """,
                        (id_ent, id_child, type_liaison),
                    )

                conn.commit()
                return {"ok": True, "id_ent_parent": id_ent, "id_ent_enfant": id_child}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures/restore_here error: {e}")

@router.post("/studio/clients/{id_owner}/{id_ent}/structures/{id_child}/promote_direct")
def promote_studio_child_structure_direct(id_owner: str, id_ent: str, id_child: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure courante introuvable.")

                if not _structure_exists_for_owner(cur, oid, id_child, include_masked=True):
                    raise HTTPException(status_code=404, detail="Structure à réactiver introuvable.")

                branch_ids = _fetch_structure_subtree_ids(cur, oid, id_child, archive_state=None)
                if not branch_ids:
                    branch_ids = [id_child]

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET masque = FALSE
                    WHERE id_owner_gestionnaire = %s
                      AND id_ent = ANY(%s)
                    """,
                    (oid, branch_ids),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = FALSE
                    WHERE id_ent_parent = ANY(%s)
                      AND id_ent_enfant = ANY(%s)
                    """,
                    (branch_ids, branch_ids),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_liaison
                    SET archive = TRUE
                    WHERE id_ent_enfant = %s
                    """,
                    (id_child,),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET type_entreprise = 'Client'
                    WHERE id_ent = %s
                      AND id_owner_gestionnaire = %s
                    """,
                    (id_child, oid),
                )

                conn.commit()
                return {"ok": True, "id_ent": id_child}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures/promote_direct error: {e}")

@router.post("/studio/clients/{id_owner}/{id_ent}/structures")
def create_studio_child_structure(id_owner: str, id_ent: str, payload: ClientPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)

        nom_ent = _normalize_text(patch.get("nom_ent"))
        if not nom_ent:
            raise HTTPException(status_code=400, detail="Le nom de la structure est obligatoire.")

        type_structure = _normalize_type_structure(patch.get("type_structure"))
        profil_structurel = _normalize_profil_structurel(patch.get("profil_structurel"))

        if type_structure == "site" and profil_structurel not in ("site_unique", "multi_site"):
            raise HTTPException(status_code=400, detail="Un site ne peut pas avoir ce profil structurel.")

        group_ok = _normalize_bool(patch.get("group_ok"))
        tete_groupe = _normalize_bool(patch.get("tete_groupe")) if group_ok else False

        if not _is_holding_profile(profil_structurel):
            group_ok = False
            tete_groupe = False

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure parente introuvable.")

                _validate_idcc_exists(cur, _normalize_text(patch.get("idcc")))
                _validate_ape_exists(cur, _normalize_text(patch.get("code_ape_ent")))
                _validate_opco_exists(cur, _normalize_text(patch.get("id_opco")))

                new_id = str(uuid4())
                type_entreprise = "Site" if type_structure == "site" else "Entreprise"
                type_liaison = "site" if type_structure == "site" else "filiale"

                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise (
                        id_ent,
                        nom_ent,
                        adresse_ent,
                        adresse_cplt_ent,
                        cp_ent,
                        ville_ent,
                        pays_ent,
                        email_ent,
                        telephone_ent,
                        siret_ent,
                        code_ape_ent,
                        num_tva_ent,
                        effectif_ent,
                        id_opco,
                        date_creation,
                        num_entreprise,
                        type_entreprise,
                        masque,
                        site_web,
                        idcc,
                        nom_groupe,
                        type_groupe,
                        tete_groupe,
                        group_ok,
                        profil_structurel,
                        id_owner_gestionnaire
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, FALSE, %s, %s,
                        %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        new_id,
                        nom_ent,
                        _normalize_text(patch.get("adresse_ent")),
                        _normalize_text(patch.get("adresse_cplt_ent")),
                        _normalize_text(patch.get("cp_ent")),
                        _normalize_text(patch.get("ville_ent")),
                        _normalize_text(patch.get("pays_ent")),
                        _normalize_text(patch.get("email_ent")),
                        _normalize_text(patch.get("telephone_ent")),
                        _normalize_text(patch.get("siret_ent")),
                        _normalize_text(patch.get("code_ape_ent")),
                        _normalize_text(patch.get("num_tva_ent")),
                        _normalize_text(patch.get("effectif_ent")),
                        _normalize_text(patch.get("id_opco")),
                        patch.get("date_creation"),
                        None,
                        type_entreprise,
                        _normalize_text(patch.get("site_web")),
                        _normalize_text(patch.get("idcc")),
                        _normalize_text(patch.get("nom_groupe")) if group_ok else None,
                        _normalize_text(patch.get("type_groupe")) if group_ok else None,
                        tete_groupe,
                        group_ok,
                        profil_structurel,
                        oid,
                    ),
                )

                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise_liaison (
                        id_ent_parent,
                        id_ent_enfant,
                        type_liaison,
                        archive
                    ) VALUES (%s, %s, %s, FALSE)
                    """,
                    (id_ent, new_id, type_liaison),
                )

                conn.commit()
                return _fetch_client_detail(cur, oid, new_id)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/structures/create error: {e}")

@router.get("/studio/referentiels/codes-postaux/{id_owner}")
def get_studio_postal_codes(id_owner: str, request: Request, code_postal: Optional[str] = None, ville: Optional[str] = None, limit: int = 20):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                cp = re.sub(r"\D+", "", (code_postal or "").strip())[:5]
                city = _normalize_text(ville)
                city = city.upper() if city else None

                try:
                    limit_val = int(limit or 20)
                except Exception:
                    limit_val = 20

                limit_val = max(1, min(limit_val, 50))

                if not cp and not city:
                    return {"items": []}

                if city and not cp and len(city) < 2:
                    return {"items": []}

                sql = """
                    SELECT DISTINCT
                        TRIM(code_postal) AS code_postal,
                        UPPER(TRIM(ville)) AS ville,
                        TRIM(code_insee) AS code_insee
                    FROM public.tbl_code_postal
                    WHERE COALESCE(TRIM(code_postal), '') <> ''
                      AND COALESCE(TRIM(ville), '') <> ''
                """
                params = []

                if cp and city:
                    sql += """
                      AND TRIM(code_postal) = %s
                      AND UPPER(TRIM(ville)) = %s
                    """
                    params.extend([cp, city])
                elif cp:
                    sql += " AND TRIM(code_postal) LIKE %s"
                    params.append(f"{cp}%")
                else:
                    sql += " AND UPPER(TRIM(ville)) LIKE %s"
                    params.append(f"{city}%")

                sql += """
                    ORDER BY code_postal, ville
                    LIMIT %s
                """
                params.append(limit_val)

                cur.execute(sql, tuple(params))
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    items.append(
                        {
                            "code_postal": (r.get("code_postal") or "").strip(),
                            "ville": (r.get("ville") or "").strip().upper(),
                            "code_insee": (r.get("code_insee") or "").strip(),
                        }
                    )

                return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/codes-postaux error: {e}")

@router.get("/studio/referentiels/entreprises-publiques/{id_owner}")
def get_studio_public_company(id_owner: str, request: Request, q: str):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                item = _fetch_public_company_data(q)

                idcc = _normalize_text(item.get("idcc"))
                code_ape = _normalize_text(item.get("code_ape_ent"))

                return {
                    "item": {
                        **item,
                        "idcc_libelle": _lookup_idcc(cur, idcc),
                        "code_ape_intitule": _lookup_ape(cur, code_ape),
                    }
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/entreprises-publiques error: {e}")

@router.get("/studio/referentiels/opco/{id_owner}")
def get_studio_referentiel_opco(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")

                cur.execute(
                    """
                    SELECT
                        id_opco,
                        nom_opco,
                        site_web
                    FROM public.tbl_opco
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY lower(nom_opco), id_opco
                    """
                )
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    items.append(
                        {
                            "id_opco": (r.get("id_opco") or "").strip(),
                            "nom_opco": (r.get("nom_opco") or "").strip(),
                            "site_web": (r.get("site_web") or "").strip(),
                        }
                    )

                return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/opco error: {e}")