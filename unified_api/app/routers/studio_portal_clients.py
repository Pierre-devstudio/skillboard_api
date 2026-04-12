from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from typing import Optional, Dict, Any
from uuid import uuid4
import re
import json
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen
from urllib.error import HTTPError, URLError
from datetime import date

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner, studio_require_min_role

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
        ORDER BY
            segment_code,
            ordre_affichage,
            lower(offer_label),
            offer_code
        """
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        items.append(
            {
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
        )
    return items


def _ensure_offer_exists(cur, offer_code: str) -> None:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_offer_catalog
        WHERE offer_code = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_catalogue, 'actif') = 'actif'
        LIMIT 1
        """,
        (offer_code,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="Offre commerciale introuvable ou archivée.")


def _ensure_client_owner_scope(cur, id_ent: str) -> None:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_owner
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent,),
    )
    if cur.fetchone() is not None:
        return

    cur.execute(
        """
        SELECT lower(COALESCE(type_entreprise, '')) AS type_entreprise
        FROM public.tbl_entreprise
        WHERE id_ent = %s
        LIMIT 1
        """,
        (id_ent,),
    )
    src = cur.fetchone() or {}
    ent_type = (src.get("type_entreprise") or "").strip().lower()
    if not ent_type:
        raise HTTPException(status_code=404, detail="Structure introuvable.")

    owner_type = "site" if ent_type == "site" else "entreprise"

    cur.execute(
        """
        INSERT INTO public.tbl_novoskill_owner (
            id_owner,
            type_owner,
            archive
        ) VALUES (%s, %s, FALSE)
        ON CONFLICT (id_owner)
        DO UPDATE SET
            type_owner = EXCLUDED.type_owner,
            archive = FALSE
        """,
        (id_ent, owner_type),
    )


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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")
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
                studio_require_min_role(cur, u, oid, "editor")
                return {"items": _fetch_offer_catalog(cur)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/offers error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}/commercial")
def get_studio_client_commercial(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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

                studio_actif = bool(payload.studio_actif)
                insights_actif = bool(payload.insights_actif)
                people_actif = bool(payload.people_actif)
                partner_actif = bool(payload.partner_actif)
                learn_actif = bool(payload.learn_actif)

                gestion_acces_studio_autorisee = bool(payload.gestion_acces_studio_autorisee)
                if gestion_acces_studio_autorisee and not studio_actif:
                    raise HTTPException(status_code=400, detail="La délégation Studio nécessite Studio actif.")

                nb_acces_studio_max = _normalize_quota(payload.nb_acces_studio_max)
                nb_acces_insights_max = _normalize_quota(payload.nb_acces_insights_max)
                nb_acces_people_max = _normalize_quota(payload.nb_acces_people_max)
                nb_acces_partner_max = _normalize_quota(payload.nb_acces_partner_max)
                nb_acces_learn_max = _normalize_quota(payload.nb_acces_learn_max)
                nb_clients_max = _normalize_quota(payload.nb_clients_max)
                nb_sites_max = _normalize_quota(payload.nb_sites_max)
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

                conn.commit()
                return _fetch_client_commercial(cur, id_ent)

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, 'Client', FALSE, %s, %s,
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
                studio_require_min_role(cur, u, oid, "editor")

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


@router.post("/studio/clients/{id_owner}/{id_ent}/archive")
def archive_studio_client(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

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

@router.get("/studio/clients/{id_owner}/{id_ent}/structures")
def get_studio_child_structures(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, FALSE, %s, %s,
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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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
                studio_require_min_role(cur, u, oid, "editor")

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