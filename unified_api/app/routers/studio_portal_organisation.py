from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List, Any
from psycopg.rows import dict_row
import uuid
import os
import json
import re
import unicodedata
from difflib import SequenceMatcher
from datetime import date as py_date

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

router = APIRouter()


# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
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
        SELECT id_owner
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email,),
    )
    r = cur.fetchone() or {}
    db_owner = (r.get("id_owner") or "").strip()
    if not db_owner or db_owner != oid:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _service_exists_active(cur, id_ent: str, id_service: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_service),
    )
    return cur.fetchone() is not None

def _nsf_groupe_exists_active(cur, code: str) -> bool:
    c = (code or "").strip()
    if not c:
        return False
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_nsf_groupe
        WHERE code = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (c,),
    )
    return cur.fetchone() is not None

def _norm_service_id(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip()
    if not s or s in ("__all__", "__none__"):
        return None
    return s

def _norm_rh_statut(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    if not s:
        return "actif"
    allowed = {"actif", "a_pourvoir", "gele", "temporaire", "archive"}
    if s not in allowed:
        raise HTTPException(status_code=400, detail="statut_poste invalide.")
    return s


def _norm_rh_strategie(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    if not s:
        return "mixte"
    allowed = {"interne", "externe", "mixte"}
    if s not in allowed:
        raise HTTPException(status_code=400, detail="strategie_pourvoi invalide.")
    return s


def _norm_rh_nb_titulaires(v: Optional[int]) -> int:
    if v is None:
        return 1
    try:
        n = int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="nb_titulaires_cible invalide.")
    if n < 1:
        raise HTTPException(status_code=400, detail="nb_titulaires_cible doit être >= 1.")
    return n


def _norm_rh_criticite(v: Optional[int]) -> int:
    if v is None:
        return 2
    try:
        n = int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="criticite_poste invalide.")
    if n < 1 or n > 3:
        raise HTTPException(status_code=400, detail="criticite_poste doit être compris entre 1 et 3.")
    return n


def _norm_iso_date(v: Optional[str]) -> Optional[py_date]:
    s = (v or "").strip()
    if not s:
        return None
    try:
        return py_date.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Date invalide (format attendu YYYY-MM-DD).")


def _validate_rh_dates(date_debut_validite: Optional[py_date], date_fin_validite: Optional[py_date]) -> None:
    if date_debut_validite and date_fin_validite and date_fin_validite < date_debut_validite:
        raise HTTPException(status_code=400, detail="date_fin_validite doit être >= date_debut_validite.")
    
def _next_pt_code(cur, oid: str, id_ent: str) -> str:
    # Sérialise les créations pour une entreprise (évite doublons)
    lock_key = f"poste_code:{oid}:{id_ent}"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))

    cur.execute(
        """
        SELECT COALESCE(
          MAX( (regexp_match(p.codif_poste, '^PT([0-9]{4})$'))[1]::int ),
          0
        ) AS max_n
        FROM public.tbl_fiche_poste p
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND p.codif_poste ~ '^PT[0-9]{4}$'
        """,
        (oid, id_ent),
    )
    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1
    if nxt > 9999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (PT9999) pour cette entreprise.")
    return f"PT{nxt:04d}"


def _poste_exists(cur, oid: str, id_ent: str, id_poste: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
          AND id_ent = %s
        LIMIT 1
        """,
        (id_poste, oid, id_ent),
    )
    return cur.fetchone() is not None


def _poste_code_exists(cur, oid: str, id_ent: str, codif_poste: str, exclude_poste: Optional[str] = None) -> bool:
    code = (codif_poste or "").strip()
    if not code:
        return False

    if exclude_poste:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
              AND id_poste <> %s
            LIMIT 1
            """,
            (oid, id_ent, code, exclude_poste),
        )
    else:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
            LIMIT 1
            """,
            (oid, id_ent, code),
        )
    return cur.fetchone() is not None

def _clamp_0_10(v) -> int:
    try:
        n = int(v)
    except Exception:
        n = 0
    if n < 0:
        return 0
    if n > 10:
        return 10
    return n


def _calc_poids_criticite_100(freq_usage_0_10: int, impact_0_10: int, dependance_0_10: int) -> int:
    fu = _clamp_0_10(freq_usage_0_10)   # pondération /20 => *2
    im = _clamp_0_10(impact_0_10)       # pondération /50 => *5
    de = _clamp_0_10(dependance_0_10)   # pondération /30 => *3
    total = (fu * 2) + (im * 5) + (de * 3)
    if total < 0:
        total = 0
    if total > 100:
        total = 100
    return int(total)

def _next_comp_code(cur, oid: str) -> str:
    lock_key = f"comp_code:{oid}:CO"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))

    cur.execute(
        """
        SELECT COALESCE(
          MAX( (regexp_match(code, '^CO([0-9]{5})$'))[1]::int ),
          0
        ) AS max_n
        FROM public.tbl_competence
        WHERE id_owner = %s
          AND code ~ '^CO[0-9]{5}$'
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1
    if nxt > 99999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (CO99999).")
    return f"CO{nxt:05d}"


def _norm_text_search(v: Optional[str]) -> str:
    s = unicodedata.normalize("NFD", (v or "").strip().lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _token_set(v: Optional[str]) -> set:
    toks = [t for t in _norm_text_search(v).split(" ") if len(t) >= 3]
    stop = {"des", "les", "une", "pour", "avec", "dans", "sur", "aux", "par", "and", "the"}
    return {t for t in toks if t not in stop}


def _similarity_score(a: Optional[str], b: Optional[str]) -> float:
    na = _norm_text_search(a)
    nb = _norm_text_search(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    ta = _token_set(na)
    tb = _token_set(nb)
    overlap = (len(ta & tb) / max(1, len(ta | tb))) if (ta or tb) else 0.0
    contains = 1.0 if (na in nb or nb in na) and min(len(ta), len(tb)) >= 2 else 0.0
    return max(ratio, overlap, contains * 0.9)


def _html_to_text(v: Optional[str]) -> str:
    s = (v or "").strip()
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>|</li>|</ol>|</ul>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\u00a0", " ", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _response_output_text(resp) -> str:
    txt = (getattr(resp, "output_text", None) or "").strip()
    if txt:
        return txt

    parts = []
    for item in (getattr(resp, "output", None) or []):
        if getattr(item, "type", None) != "message":
            continue
        for c in (getattr(item, "content", None) or []):
            t = getattr(c, "text", None)
            if t:
                parts.append(t)
            elif isinstance(c, dict) and c.get("text"):
                parts.append(c.get("text"))
    return "\n".join([p for p in parts if p]).strip()


def _openai_responses_json(model: str, schema_name: str, schema: dict, system_prompt: str, user_prompt: str, use_web: bool = False) -> dict:
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="Lib OpenAI manquante (pip install openai).")

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY non configurée.")

    client = OpenAI(api_key=api_key)
    kwargs = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema,
                "strict": True,
            }
        },
    }
    if use_web:
        kwargs["tools"] = [{"type": "web_search"}]
        kwargs["tool_choice"] = "auto"

    resp = client.responses.create(**kwargs)
    content = _response_output_text(resp)
    if not content:
        raise HTTPException(status_code=500, detail="Réponse IA vide.")
    try:
        return json.loads(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Réponse IA invalide (JSON): {e}")


def _resolve_domain_id(cur, hint: Optional[str]) -> Optional[str]:
    h = (hint or "").strip()
    if not h:
        return None
    cur.execute(
        """
        SELECT id_domaine_competence, titre, titre_court
        FROM public.tbl_domaine_competence
        WHERE COALESCE(masque, FALSE) = FALSE
        ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre_court, titre, id_domaine_competence))
        """
    )
    rows = cur.fetchall() or []
    best = None
    best_score = 0.0
    for r in rows:
        for label in [r.get("titre_court"), r.get("titre"), r.get("id_domaine_competence")]:
            score = _similarity_score(h, label)
            if score > best_score:
                best_score = score
                best = r.get("id_domaine_competence")
    return best if best_score >= 0.72 else None


def _find_best_existing_competence(cur, oid: str, title: str, search_terms: List[str]) -> Optional[dict]:
    t = (title or "").strip()
    if not t:
        return None

    terms = []
    for raw in [t] + list(search_terms or []):
        s = (raw or "").strip()
        if len(s) < 3:
            continue
        if s.lower() not in [x.lower() for x in terms]:
            terms.append(s)
        if len(terms) >= 4:
            break

    if not terms:
        return None

    where_parts = []
    params = [oid]
    for s in terms:
        like = f"%{s}%"
        where_parts.append("(c.intitule ILIKE %s OR c.code ILIKE %s OR COALESCE(c.description,'') ILIKE %s)")
        params.extend([like, like, like])

    sql = f"""
        SELECT
          c.id_comp,
          c.code,
          c.intitule,
          c.description,
          c.domaine,
          dc.titre_court AS domaine_titre_court,
          dc.couleur AS domaine_couleur
        FROM public.tbl_competence c
        LEFT JOIN public.tbl_domaine_competence dc
          ON dc.id_domaine_competence = c.domaine
         AND COALESCE(dc.masque, FALSE) = FALSE
        WHERE c.id_owner = %s
          AND COALESCE(c.masque, FALSE) = FALSE
          AND ({' OR '.join(where_parts)})
        ORDER BY lower(c.intitule)
        LIMIT 30
    """
    cur.execute(sql, tuple(params))
    rows = cur.fetchall() or []
    best = None
    best_score = 0.0
    for r in rows:
        score = _similarity_score(t, r.get("intitule"))
        if score > best_score:
            best_score = score
            best = r
    return best if best_score >= 0.80 else None


def _sanitize_grille(v: Any) -> dict:
    ge = v if isinstance(v, dict) else {}
    out = {}
    for idx in range(1, 5):
        k = f"Critere{idx}"
        item = ge.get(k) or {}
        nom = (item.get("Nom") or "").strip() if isinstance(item, dict) else ""
        evals = item.get("Eval") if isinstance(item, dict) else None
        evals = evals if isinstance(evals, list) else []
        evals = [str(x or "").strip()[:120] for x in evals[:4]]
        while len(evals) < 4:
            evals.append("")
        out[k] = {"Nom": nom[:140], "Eval": evals}
    return out


def _upsert_poste_comp_assoc(cur, id_poste: str, id_competence: str, niveau_requis: str, freq_usage: int, impact_resultat: int, dependance: int) -> None:
    cur.execute(
        """
        INSERT INTO public.tbl_fiche_poste_competence
          (id_poste, id_competence, niveau_requis, freq_usage, impact_resultat, dependance, poids_criticite, archive)
        VALUES
          (%s, %s, %s, %s, %s, %s, %s, FALSE)
        ON CONFLICT (id_poste, id_competence)
        DO UPDATE SET
          niveau_requis = EXCLUDED.niveau_requis,
          freq_usage = EXCLUDED.freq_usage,
          impact_resultat = EXCLUDED.impact_resultat,
          dependance = EXCLUDED.dependance,
          poids_criticite = EXCLUDED.poids_criticite,
          archive = FALSE
        """,
        (
            id_poste,
            id_competence,
            (niveau_requis or "A").strip()[:1].upper() or "A",
            _clamp_0_10(freq_usage),
            _clamp_0_10(impact_resultat),
            _clamp_0_10(dependance),
            _calc_poids_criticite_100(freq_usage, impact_resultat, dependance),
        ),
    )

# ------------------------------------------------------
# Models
# ------------------------------------------------------
class CreateServicePayload(BaseModel):
    nom_service: str
    id_service_parent: Optional[str] = None


class UpdateServicePayload(BaseModel):
    nom_service: Optional[str] = None
    id_service_parent: Optional[str] = None


class AssignPostePayload(BaseModel):
    id_poste: str
    id_service: str


class DetachPostePayload(BaseModel):
    id_poste: str

class CreatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None  # ignoré (auto)
    codif_client: Optional[str] = None
    intitule_poste: str
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None

    # Exigences > Contraintes
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    # Paramétrage RH
    statut_poste: Optional[str] = None
    date_debut_validite: Optional[str] = None
    date_fin_validite: Optional[str] = None
    nb_titulaires_cible: Optional[int] = None
    criticite_poste: Optional[int] = None
    strategie_pourvoi: Optional[str] = None
    param_rh_verrouille: Optional[bool] = None
    param_rh_commentaire: Optional[str] = None


class UpdatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None  # interdit (lock serveur)
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None

    # Exigences > Contraintes
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    # Paramétrage RH
    statut_poste: Optional[str] = None
    date_debut_validite: Optional[str] = None
    date_fin_validite: Optional[str] = None
    nb_titulaires_cible: Optional[int] = None
    criticite_poste: Optional[int] = None
    strategie_pourvoi: Optional[str] = None
    param_rh_verrouille: Optional[bool] = None
    param_rh_commentaire: Optional[str] = None


class ArchivePosteOrgPayload(BaseModel):
    # archive=True => actif FALSE ; archive=False => actif TRUE (restauration)
    archive: bool = True


class DuplicatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None

class UpsertPosteCompetencePayload(BaseModel):
    id_competence: str
    niveau_requis: str  # A/B/C
    freq_usage: Optional[int] = 0        # 0..10
    impact_resultat: Optional[int] = 0   # 0..10
    dependance: Optional[int] = 0        # 0..10

class UpsertPosteCertificationPayload(BaseModel):
    id_certification: str
    validite_override: Optional[int] = None
    niveau_exigence: Optional[str] = "requis"
    commentaire: Optional[str] = None

class CreateCertificationPayload(BaseModel):
    nom_certification: str
    description: Optional[str] = None
    categorie: Optional[str] = None
    duree_validite: Optional[int] = None
    delai_renouvellement: Optional[int] = None

class AiPosteDraftPayload(BaseModel):
    mode: Optional[str] = "create"
    id_poste: Optional[str] = None
    current_intitule_poste: Optional[str] = None
    current_mission_principale: Optional[str] = None
    current_responsabilites_html: Optional[str] = None
    intitule: str
    contexte: Optional[str] = None
    taches: Optional[str] = None
    outils: Optional[str] = None
    environnement: Optional[str] = None
    interactions: Optional[str] = None
    contraintes: Optional[str] = None


class AiPosteCompetenceSearchPayload(BaseModel):
    id_poste: Optional[str] = None
    intitule_poste: Optional[str] = None
    mission_principale: Optional[str] = None
    responsabilites_html: Optional[str] = None
    ai_contexte: Optional[str] = None
    ai_taches: Optional[str] = None
    ai_outils: Optional[str] = None
    ai_environnement: Optional[str] = None
    ai_interactions: Optional[str] = None
    ai_contraintes: Optional[str] = None
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None
    existing_competence_ids: Optional[List[str]] = None


class AiPosteCompetenceCreatePayload(BaseModel):
    id_poste: str
    draft: dict

@router.post("/studio/org/postes/{id_owner}/ai_draft")
def studio_org_ai_draft_poste(id_owner: str, payload: AiPosteDraftPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        oid = (id_owner or "").strip()
        title = (payload.intitule or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        model = (os.getenv("OPENAI_MODEL_POSTE_DRAFT") or "gpt-5").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, oid)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT code, titre
                    FROM public.tbl_nsf_groupe
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY code
                    """
                )
                nsf_rows = cur.fetchall() or []

        nsf_txt = "\n".join([f"- {r.get('code')} : {r.get('titre')}" for r in nsf_rows]) or "- aucune donnée"
        mode = (payload.mode or "create").strip().lower()
        current_resp = _html_to_text(payload.current_responsabilites_html)

        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "intitule_poste", "mission_principale", "responsabilites_html",
                "niveau_education_minimum", "nsf_groupe_code", "nsf_groupe_obligatoire",
                "mobilite", "risque_physique", "perspectives_evolution",
                "niveau_contrainte", "detail_contrainte"
            ],
            "properties": {
                "intitule_poste": {"type": "string", "minLength": 1, "maxLength": 180},
                "mission_principale": {"type": "string", "maxLength": 2400},
                "responsabilites_html": {"type": "string", "maxLength": 16000},
                "niveau_education_minimum": {"type": "string", "maxLength": 4},
                "nsf_groupe_code": {"type": "string", "maxLength": 12},
                "nsf_groupe_obligatoire": {"type": "boolean"},
                "mobilite": {"type": "string", "maxLength": 30},
                "risque_physique": {"type": "string", "maxLength": 20},
                "perspectives_evolution": {"type": "string", "maxLength": 20},
                "niveau_contrainte": {"type": "string", "maxLength": 20},
                "detail_contrainte": {"type": "string", "maxLength": 2400},
            },
        }

        system_prompt = (
            "Tu rédiges des fiches de poste RH opérationnelles en français. "
            "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
            "Tu t'appuies sur les éléments utilisateur ET sur une recherche web. "
            "Si mode=edit, tu proposes des textes de remplacement plus propres et plus solides sans changer le métier cible. "
            "La mission principale doit être rédigée en 1 paragraphe clair. "
            "responsabilites_html doit être du HTML simple, propre et directement exploitable: "
            "un <ol> contenant plusieurs <li>, chaque <li> commençant par un titre de tâche en gras, puis un <ul> d'activités rattachées. "
            "Les contraintes doivent rester prudentes: n'invente pas un diplôme ou un domaine NSF si ce n'est pas assez clair. "
            "Valeurs autorisées: niveau_education_minimum parmi '',0,3,4,5,6,7,8 ; mobilite parmi '',Aucune,Rare,Occasionnelle,Fréquente ; "
            "risque_physique parmi '',Aucun,Faible,Modéré,Élevé,Critique ; perspectives_evolution parmi '',Aucune,Faible,Modérée,Forte,Rapide ; "
            "niveau_contrainte parmi '',Aucune,Modérée,Élevée,Critique. "
            "nsf_groupe_code doit être vide ou reprendre exactement un code fourni dans la liste NSF. "
            "detail_contrainte doit synthétiser les contraintes concrètes du poste, sans blabla marketing."
        )

        user_prompt = (
            f"mode={mode}\n"
            f"intitule visé: {title}\n\n"
            f"fiche actuelle - intitulé: {(payload.current_intitule_poste or '').strip()}\n"
            f"fiche actuelle - mission: {(payload.current_mission_principale or '').strip()}\n"
            f"fiche actuelle - responsabilités (texte): {current_resp}\n\n"
            f"contexte: {(payload.contexte or '').strip()}\n"
            f"tâches: {(payload.taches or '').strip()}\n"
            f"outils: {(payload.outils or '').strip()}\n"
            f"environnement: {(payload.environnement or '').strip()}\n"
            f"interactions: {(payload.interactions or '').strip()}\n"
            f"contraintes / vigilance: {(payload.contraintes or '').strip()}\n\n"
            f"Liste NSF disponible (code : titre):\n{nsf_txt}\n"
        )

        data = _openai_responses_json(model, "poste_draft", schema, system_prompt, user_prompt, use_web=True)
        data["niveau_education_minimum"] = (data.get("niveau_education_minimum") or "").strip()
        data["nsf_groupe_code"] = (data.get("nsf_groupe_code") or "").strip()
        allowed_edu = {"", "0", "3", "4", "5", "6", "7", "8"}
        allowed_mob = {"", "Aucune", "Rare", "Occasionnelle", "Fréquente"}
        allowed_risk = {"", "Aucun", "Faible", "Modéré", "Élevé", "Critique"}
        allowed_persp = {"", "Aucune", "Faible", "Modérée", "Forte", "Rapide"}
        allowed_ctr = {"", "Aucune", "Modérée", "Élevée", "Critique"}
        if data["niveau_education_minimum"] not in allowed_edu:
            data["niveau_education_minimum"] = ""
        if (data.get("mobilite") or "") not in allowed_mob:
            data["mobilite"] = ""
        if (data.get("risque_physique") or "") not in allowed_risk:
            data["risque_physique"] = ""
        if (data.get("perspectives_evolution") or "") not in allowed_persp:
            data["perspectives_evolution"] = ""
        if (data.get("niveau_contrainte") or "") not in allowed_ctr:
            data["niveau_contrainte"] = ""
        nsf_codes = {str(r.get("code") or "").strip() for r in nsf_rows}
        if data["nsf_groupe_code"] not in nsf_codes:
            data["nsf_groupe_code"] = ""
        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_draft error: {e}")


@router.post("/studio/org/postes/{id_owner}/ai_comp_search")
def studio_org_ai_comp_search(id_owner: str, payload: AiPosteCompetenceSearchPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        model = (os.getenv("OPENAI_MODEL_POSTE_COMP_SEARCH") or "gpt-5").strip()
        existing_ids = {str(x).strip() for x in (payload.existing_competence_ids or []) if str(x).strip()}
        title = (payload.intitule_poste or "").strip()
        if not title and payload.id_poste:
            with get_conn() as conn:
                with conn.cursor(row_factory=dict_row) as cur:
                    oid = _require_owner_access(cur, u, id_owner)
                    studio_fetch_owner(cur, oid)
                    studio_require_min_role(cur, u, oid, "admin")
                    cur.execute(
                        "SELECT intitule_poste, mission_principale, responsabilites FROM public.tbl_fiche_poste WHERE id_poste = %s AND id_owner = %s AND id_ent = %s LIMIT 1",
                        (payload.id_poste, oid, oid)
                    )
                    row = cur.fetchone() or {}
                    title = (row.get("intitule_poste") or "").strip()
                    if not payload.mission_principale:
                        payload.mission_principale = row.get("mission_principale")
                    if not payload.responsabilites_html:
                        payload.responsabilites_html = row.get("responsabilites")
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé du poste obligatoire pour la recherche IA.")

        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["competences"],
            "properties": {
                "competences": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": [
                            "intitule", "description", "why_needed", "search_terms", "recommended_level",
                            "freq_usage", "impact_resultat", "dependance", "domaine_hint",
                            "niveaua", "niveaub", "niveauc", "grille_evaluation"
                        ],
                        "properties": {
                            "intitule": {"type": "string", "minLength": 1, "maxLength": 140},
                            "description": {"type": "string", "maxLength": 1200},
                            "why_needed": {"type": "string", "maxLength": 600},
                            "search_terms": {"type": "array", "minItems": 1, "maxItems": 4, "items": {"type": "string", "maxLength": 80}},
                            "recommended_level": {"type": "string", "enum": ["A", "B", "C"]},
                            "freq_usage": {"type": "integer", "minimum": 0, "maximum": 10},
                            "impact_resultat": {"type": "integer", "minimum": 0, "maximum": 10},
                            "dependance": {"type": "integer", "minimum": 0, "maximum": 10},
                            "domaine_hint": {"type": "string", "maxLength": 120},
                            "niveaua": {"type": "string", "maxLength": 230},
                            "niveaub": {"type": "string", "maxLength": 230},
                            "niveauc": {"type": "string", "maxLength": 230},
                            "grille_evaluation": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["Critere1", "Critere2", "Critere3", "Critere4"],
                                "properties": {
                                    **{f"Critere{i}": {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "required": ["Nom", "Eval"],
                                        "properties": {
                                            "Nom": {"type": "string", "maxLength": 140},
                                            "Eval": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "string", "maxLength": 120}}
                                        }
                                    } for i in range(1,5)}
                                }
                            }
                        }
                    }
                }
            }
        }

        system_prompt = (
            "Tu identifies les compétences techniques et métier nécessaires à la tenue réelle d'un poste. "
            "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
            "Tu t'appuies sur les informations fournies ET sur une recherche web. "
            "Tu proposes uniquement des compétences utiles au poste. Pas de soft skills génériques sauf si elles sont vraiment indispensables à l'exécution. "
            "Tu évites les doublons. Tu privilégies des intitulés de compétences réutilisables dans un référentiel RH. "
            "recommended_level: A initial, B autonome fiable, C expert / référent. "
            "Les trois scores freq_usage / impact_resultat / dependance doivent être cohérents et réalistes. "
            "Les niveaux A/B/C doivent être rédigés et observables. La grille d'évaluation doit être exploitable."
        )

        user_prompt = (
            f"intitulé du poste: {title}\n"
            f"mission principale: {(payload.mission_principale or '').strip()}\n"
            f"responsabilités: {_html_to_text(payload.responsabilites_html)}\n"
            f"contexte: {(payload.ai_contexte or '').strip()}\n"
            f"tâches complémentaires: {(payload.ai_taches or '').strip()}\n"
            f"outils: {(payload.ai_outils or '').strip()}\n"
            f"environnement: {(payload.ai_environnement or '').strip()}\n"
            f"interactions: {(payload.ai_interactions or '').strip()}\n"
            f"contraintes complémentaires: {(payload.ai_contraintes or '').strip()}\n"
            f"contraintes fiche: niveau étude={payload.niveau_education_minimum or ''}, nsf={payload.nsf_groupe_code or ''}, mobilité={payload.mobilite or ''}, risques={payload.risque_physique or ''}, perspectives={payload.perspectives_evolution or ''}, niveau_contrainte={payload.niveau_contrainte or ''}, détail={payload.detail_contrainte or ''}\n"
            "Produis 5 à 8 compétences maximum, les plus structurantes pour réussir le poste.\n"
        )

        drafted = _openai_responses_json(model, "poste_comp_search", schema, system_prompt, user_prompt, use_web=True)
        drafted_items = drafted.get("competences") or []

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                existing = []
                missing = []
                seen_ids = set()
                seen_titles = set()

                for item in drafted_items:
                    intitule = (item.get("intitule") or "").strip()
                    if not intitule:
                        continue
                    norm_title = _norm_text_search(intitule)
                    if norm_title in seen_titles:
                        continue
                    seen_titles.add(norm_title)

                    search_terms = [str(x or "").strip() for x in (item.get("search_terms") or []) if str(x or "").strip()]
                    match = _find_best_existing_competence(cur, oid, intitule, search_terms)
                    lvl = (item.get("recommended_level") or "A").strip().upper()[:1] or "A"
                    fu = _clamp_0_10(item.get("freq_usage"))
                    im = _clamp_0_10(item.get("impact_resultat"))
                    de = _clamp_0_10(item.get("dependance"))
                    poids = _calc_poids_criticite_100(fu, im, de)

                    if match and str(match.get("id_comp") or "") not in existing_ids and str(match.get("id_comp") or "") not in seen_ids:
                        seen_ids.add(str(match.get("id_comp") or ""))
                        existing.append({
                            "id_comp": match.get("id_comp"),
                            "code": match.get("code"),
                            "intitule": match.get("intitule"),
                            "domaine_titre_court": match.get("domaine_titre_court"),
                            "domaine_couleur": match.get("domaine_couleur"),
                            "why_needed": (item.get("why_needed") or "").strip(),
                            "recommended_level": lvl,
                            "recommended_level_label": {"A": "Initial", "B": "Avancé", "C": "Expert"}.get(lvl, lvl),
                            "freq_usage": fu,
                            "impact_resultat": im,
                            "dependance": de,
                            "poids_criticite": poids,
                        })
                    else:
                        domaine_id = _resolve_domain_id(cur, item.get("domaine_hint"))
                        domaine_label = None
                        if domaine_id:
                            cur.execute(
                                "SELECT COALESCE(titre_court, titre, id_domaine_competence) AS label FROM public.tbl_domaine_competence WHERE id_domaine_competence = %s LIMIT 1",
                                (domaine_id,)
                            )
                            rr = cur.fetchone() or {}
                            domaine_label = rr.get("label")
                        missing.append({
                            "intitule": intitule,
                            "description": (item.get("description") or "").strip(),
                            "why_needed": (item.get("why_needed") or "").strip(),
                            "domaine_id": domaine_id,
                            "domaine_label": domaine_label or (item.get("domaine_hint") or "").strip(),
                            "recommended_level": lvl,
                            "recommended_level_label": {"A": "Initial", "B": "Avancé", "C": "Expert"}.get(lvl, lvl),
                            "freq_usage": fu,
                            "impact_resultat": im,
                            "dependance": de,
                            "poids_criticite": poids,
                            "niveaua": (item.get("niveaua") or "").strip(),
                            "niveaub": (item.get("niveaub") or "").strip(),
                            "niveauc": (item.get("niveauc") or "").strip(),
                            "grille_evaluation": _sanitize_grille(item.get("grille_evaluation")),
                        })

        return {"existing": existing, "missing": missing}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_comp_search error: {e}")


@router.post("/studio/org/postes/{id_owner}/ai_comp_create")
def studio_org_ai_comp_create(id_owner: str, payload: AiPosteCompetenceCreatePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        draft = payload.draft or {}
        title = (draft.get("intitule") or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste obligatoire.")
        if not title:
            raise HTTPException(status_code=400, detail="Brouillon de compétence invalide (intitulé manquant).")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _poste_exists(cur, oid, oid, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    SELECT id_comp, code
                    FROM public.tbl_competence
                    WHERE id_owner = %s
                      AND lower(intitule) = lower(%s)
                    LIMIT 1
                    """,
                    (oid, title),
                )
                existing = cur.fetchone() or None

                if existing:
                    cid = existing.get("id_comp")
                    code = existing.get("code")
                    created = False
                else:
                    cid = str(uuid.uuid4())
                    code = _next_comp_code(cur, oid)
                    cur.execute(
                        """
                        INSERT INTO public.tbl_competence
                          (id_comp, id_owner, code, intitule, description, domaine, niveaua, niveaub, niveauc, grille_evaluation, etat, masque, date_creation, date_modification)
                        VALUES
                          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW(), NOW())
                        """,
                        (
                            cid,
                            oid,
                            code,
                            title,
                            (draft.get("description") or None),
                            (draft.get("domaine_id") or None),
                            (draft.get("niveaua") or None),
                            (draft.get("niveaub") or None),
                            (draft.get("niveauc") or None),
                            _sanitize_grille(draft.get("grille_evaluation")),
                            "à valider",
                        ),
                    )
                    created = True

                _upsert_poste_comp_assoc(
                    cur,
                    pid,
                    cid,
                    (draft.get("recommended_level") or "A"),
                    draft.get("freq_usage") or 0,
                    draft.get("impact_resultat") or 0,
                    draft.get("dependance") or 0,
                )
                conn.commit()

        return {"ok": True, "created": created, "id_comp": cid, "code": code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_comp_create error: {e}")

# ------------------------------------------------------
# Endpoints: Services
# ------------------------------------------------------
@router.get("/studio/org/services/{id_owner}")
def studio_org_list_services(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)

                # owner Studio doit exister (périmètre)
                studio_fetch_owner(cur, oid)

                # Services (arbre)
                cur.execute(
                    """
                    WITH RECURSIVE svc AS (
                      SELECT
                        s.id_service, s.id_ent, s.nom_service, s.id_service_parent, COALESCE(s.archive,FALSE) AS archive,
                        0 AS depth,
                        (s.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme s
                      WHERE s.id_ent = %s
                        AND COALESCE(s.archive,FALSE) = FALSE
                        AND s.id_service_parent IS NULL

                      UNION ALL

                      SELECT
                        c.id_service, c.id_ent, c.nom_service, c.id_service_parent, COALESCE(c.archive,FALSE) AS archive,
                        p.depth + 1 AS depth,
                        (p.path || ' > ' || c.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme c
                      JOIN svc p ON p.id_service = c.id_service_parent
                      WHERE c.id_ent = %s
                        AND COALESCE(c.archive,FALSE) = FALSE
                    )
                    SELECT
                      svc.id_service,
                      svc.nom_service,
                      svc.id_service_parent,
                      svc.depth,

                      -- nb postes actifs dans le service
                      (SELECT COUNT(1)
                       FROM public.tbl_fiche_poste p
                       WHERE p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                         AND p.id_service = svc.id_service
                      ) AS nb_postes,

                      -- nb collaborateurs actifs dans le service
                      (SELECT COUNT(1)
                       FROM public.tbl_effectif_client e
                       WHERE e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         AND e.id_service = svc.id_service
                      ) AS nb_collabs

                    FROM svc
                    ORDER BY svc.path
                    """,
                    (oid, oid, oid, oid),
                )
                rows = cur.fetchall() or []

                services = []
                for r in rows:
                    services.append(
                        {
                            "id_service": r.get("id_service"),
                            "nom_service": r.get("nom_service"),
                            "id_service_parent": r.get("id_service_parent"),
                            "depth": int(r.get("depth") or 0),
                            "nb_postes": int(r.get("nb_postes") or 0),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                        }
                    )

                # Totaux (Tous les services)
                cur.execute(
                    """
                    SELECT
                        (SELECT COUNT(1)
                        FROM public.tbl_fiche_poste p
                        WHERE p.id_ent = %s
                            AND COALESCE(p.actif, TRUE) = TRUE
                            AND p.id_service IS NOT NULL
                        ) AS nb_postes,
                        (SELECT COUNT(1)
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                            AND e.id_service IS NOT NULL
                        ) AS nb_collabs
                    """,
                    (oid, oid),
                )
                tot = cur.fetchone() or {}

                # Totaux (Non lié)
                cur.execute(
                    """
                    SELECT
                      (SELECT COUNT(1)
                       FROM public.tbl_fiche_poste p
                       WHERE p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                         AND p.id_service IS NULL
                      ) AS nb_postes,
                      (SELECT COUNT(1)
                       FROM public.tbl_effectif_client e
                       WHERE e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         AND e.id_service IS NULL
                      ) AS nb_collabs
                    """,
                    (oid, oid),
                )
                none = cur.fetchone() or {}

        return {
            "totaux": {"nb_postes": int(tot.get("nb_postes") or 0), "nb_collabs": int(tot.get("nb_collabs") or 0)},
            "non_lie": {"nb_postes": int(none.get("nb_postes") or 0), "nb_collabs": int(none.get("nb_collabs") or 0)},
            "services": services,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services error: {e}")


@router.post("/studio/org/services/{id_owner}")
def studio_org_create_service(id_owner: str, payload: CreateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        nom = (payload.nom_service or "").strip()
        if not nom:
            raise HTTPException(status_code=400, detail="Nom de service obligatoire.")

        parent = (payload.id_service_parent or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if parent and not _service_exists_active(cur, oid, parent):
                    raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                sid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise_organigramme
                      (id_service, id_ent, nom_service, id_service_parent, archive, date_creation)
                    VALUES
                      (%s, %s, %s, %s, FALSE, CURRENT_DATE)
                    """,
                    (sid, oid, nom, parent),
                )
                conn.commit()

        return {"id_service": sid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services create error: {e}")


@router.post("/studio/org/services/{id_owner}/{id_service}")
def studio_org_update_service(id_owner: str, id_service: str, payload: UpdateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou archivé.")

                cols = []
                vals = []

                if "nom_service" in patch_fields:
                    nom = (payload.nom_service or "").strip()
                    if not nom:
                        raise HTTPException(status_code=400, detail="Nom de service obligatoire.")
                    cols.append("nom_service = %s")
                    vals.append(nom)

                if "id_service_parent" in patch_fields:
                    parent = (payload.id_service_parent or "").strip() or None
                    if parent == sid:
                        raise HTTPException(status_code=400, detail="Un service ne peut pas être son propre parent.")
                    if parent and not _service_exists_active(cur, oid, parent):
                        raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                    # anti-cycle simple : si le parent est un descendant du service
                    if parent:
                        cur.execute(
                            """
                            WITH RECURSIVE up AS (
                              SELECT id_service, id_service_parent
                              FROM public.tbl_entreprise_organigramme
                              WHERE id_ent = %s AND id_service = %s

                              UNION ALL
                              SELECT e.id_service, e.id_service_parent
                              FROM public.tbl_entreprise_organigramme e
                              JOIN up u ON u.id_service_parent = e.id_service
                              WHERE e.id_ent = %s
                            )
                            SELECT 1
                            FROM up
                            WHERE id_service = %s
                            LIMIT 1
                            """,
                            (oid, parent, oid, sid),
                        )
                        if cur.fetchone():
                            raise HTTPException(status_code=400, detail="Cycle détecté dans l’organigramme.")

                    cols.append("id_service_parent = %s")
                    vals.append(parent)

                if cols:
                    vals.extend([oid, sid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise_organigramme
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                          AND id_service = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services update error: {e}")


@router.post("/studio/org/services/{id_owner}/{id_service}/archive")
def studio_org_archive_service(id_owner: str, id_service: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou déjà archivé.")

                # Archiver service
                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_organigramme
                    SET archive = TRUE
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid, sid),
                )

                # Détacher les postes rattachés (=> "Non lié")
                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (oid, sid),
                )

                # Détacher les collaborateurs rattachés (=> "Non lié")
                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client
                    SET id_service = NULL, dernier_update = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid, sid),
                )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services archive error: {e}")


# ------------------------------------------------------
# Endpoints: Postes (liste + catalogue + affectation)
# ------------------------------------------------------
@router.get("/studio/org/postes/{id_owner}")
def studio_org_list_postes(
    id_owner: str,
    request: Request,
    service: str = "__all__",
    q: str = "",
    include_archived: int = 0,
):
    """
    service:
      - "__all__" : tous les postes
      - "__none__": postes non liés (id_service IS NULL)
      - "<uuid>"  : postes rattachés au service
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        svc = (service or "__all__").strip()
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                inc_arch = int(include_archived or 0) == 1

                where = ["p.id_owner = %s", "p.id_ent = %s"]
                params = [oid, oid]

                if not inc_arch:
                    where.append("COALESCE(p.actif, TRUE) = TRUE")

                if svc == "__none__":
                    where.append("p.id_service IS NULL")
                elif svc == "__all__":
                    # "Tous les services" = uniquement les postes rattachés à un service
                    where.append("p.id_service IS NOT NULL")
                else:
                    where.append("p.id_service = %s")
                    params.append(svc)

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT
                    p.id_poste,
                    p.codif_poste,
                    p.codif_client,
                    p.intitule_poste,
                    p.id_service,
                    COALESCE(p.actif, TRUE) AS actif,
                    COALESCE(cnt.nb_collabs, 0) AS nb_collabs
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN (
                    SELECT e.id_poste_actuel AS id_poste, COUNT(1) AS nb_collabs
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                        AND COALESCE(e.archive, FALSE) = FALSE
                        AND COALESCE(e.statut_actif, TRUE) = TRUE
                        AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                    ) cnt ON cnt.id_poste = p.id_poste
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    """,
                    tuple([oid] + params),
                )
                rows = cur.fetchall() or []

                postes = []
                for r in rows:
                    code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
                    postes.append(
                        {
                            "id_poste": r.get("id_poste"),
                            "code": code,
                            "intitule": r.get("intitule_poste"),
                            "id_service": r.get("id_service"),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                            "actif": bool(r.get("actif")),
                        }
                    )

        return {"postes": postes}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes error: {e}")

@router.get("/studio/org/poste_detail/{id_owner}/{id_poste}")
def studio_org_poste_detail(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      p.id_poste,
                      p.id_service,
                      COALESCE(p.actif, TRUE) AS actif,
                      p.codif_poste,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites,
                      p.date_maj,

                      -- Contraintes
                      p.niveau_education_minimum,
                      p.nsf_groupe_code,
                      COALESCE(p.nsf_groupe_obligatoire, FALSE) AS nsf_groupe_obligatoire,
                      ng.titre AS nsf_groupe_titre,
                      p.mobilite,
                      p.risque_physique,
                      p.perspectives_evolution,
                      p.niveau_contrainte,
                      p.detail_contrainte,

                      -- Paramétrage RH
                      COALESCE(pr.statut_poste, 'actif') AS statut_poste,
                      pr.date_debut_validite,
                      pr.date_fin_validite,
                      COALESCE(pr.nb_titulaires_cible, 1) AS nb_titulaires_cible,
                      COALESCE(pr.criticite_poste, 2) AS criticite_poste,
                      COALESCE(pr.strategie_pourvoi, 'mixte') AS strategie_pourvoi,
                      pr.param_rh_source,
                      pr.param_rh_date_maj,
                      COALESCE(pr.param_rh_verrouille, FALSE) AS param_rh_verrouille,
                      pr.param_rh_commentaire

                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_nsf_groupe ng
                      ON ng.code = p.nsf_groupe_code
                     AND COALESCE(ng.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_poste_param_rh pr
                      ON pr.id_poste = p.id_poste
                    WHERE p.id_owner = %s
                      AND p.id_ent = %s
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (oid, oid, pid),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

        return {
            "id_poste": r.get("id_poste"),
            "id_service": r.get("id_service"),
            "actif": bool(r.get("actif")),
            "codif_poste": r.get("codif_poste"),
            "codif_client": r.get("codif_client"),
            "intitule_poste": r.get("intitule_poste"),
            "mission_principale": r.get("mission_principale"),
            "responsabilites": r.get("responsabilites"),
            "date_maj": r.get("date_maj"),
            "niveau_education_minimum": r.get("niveau_education_minimum"),
            "nsf_groupe_code": r.get("nsf_groupe_code"),
            "nsf_groupe_obligatoire": bool(r.get("nsf_groupe_obligatoire")),
            "nsf_groupe_titre": r.get("nsf_groupe_titre"),
            "mobilite": r.get("mobilite"),
            "risque_physique": r.get("risque_physique"),
            "perspectives_evolution": r.get("perspectives_evolution"),
            "niveau_contrainte": r.get("niveau_contrainte"),
            "detail_contrainte": r.get("detail_contrainte"),
            "statut_poste": r.get("statut_poste"),
            "date_debut_validite": r.get("date_debut_validite"),
            "date_fin_validite": r.get("date_fin_validite"),
            "nb_titulaires_cible": int(r.get("nb_titulaires_cible") or 1),
            "criticite_poste": int(r.get("criticite_poste") or 2),
            "strategie_pourvoi": r.get("strategie_pourvoi"),
            "param_rh_source": r.get("param_rh_source"),
            "param_rh_date_maj": r.get("param_rh_date_maj"),
            "param_rh_verrouille": bool(r.get("param_rh_verrouille")),
            "param_rh_commentaire": r.get("param_rh_commentaire"),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_detail error: {e}")


@router.post("/studio/org/postes/{id_owner}")
def studio_org_create_poste(id_owner: str, payload: CreatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        title = (payload.intitule_poste or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        sid = _norm_service_id(payload.id_service)
        if not sid:
            raise HTTPException(status_code=400, detail="Service obligatoire.")

        # Code interne: auto uniquement (on ignore toute saisie)
        codif = None
        cod_cli = (payload.codif_client or "").strip() or None
        mission = (payload.mission_principale or "").strip() or None
        resp = (payload.responsabilites or "").strip() or None
        edu_min = (payload.niveau_education_minimum or "").strip() or None
        nsf_code = (payload.nsf_groupe_code or "").strip() or None
        nsf_oblig = bool(payload.nsf_groupe_obligatoire) if payload.nsf_groupe_obligatoire is not None else False
        mobilite = (payload.mobilite or "").strip() or None
        risque = (payload.risque_physique or "").strip() or None
        persp = (payload.perspectives_evolution or "").strip() or None
        niv_ctr = (payload.niveau_contrainte or "").strip() or None
        det_ctr = (payload.detail_contrainte or "").strip() or None
        statut_poste = _norm_rh_statut(payload.statut_poste)
        date_debut_validite = _norm_iso_date(payload.date_debut_validite)
        date_fin_validite = _norm_iso_date(payload.date_fin_validite)
        _validate_rh_dates(date_debut_validite, date_fin_validite)
        nb_titulaires_cible = _norm_rh_nb_titulaires(payload.nb_titulaires_cible)
        criticite_poste = _norm_rh_criticite(payload.criticite_poste)
        strategie_pourvoi = _norm_rh_strategie(payload.strategie_pourvoi)
        param_rh_verrouille = bool(payload.param_rh_verrouille) if payload.param_rh_verrouille is not None else False
        param_rh_commentaire = (payload.param_rh_commentaire or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                codif = _next_pt_code(cur, oid, oid)

                if nsf_code and not _nsf_groupe_exists_active(cur, nsf_code):
                    raise HTTPException(status_code=400, detail="Domaine NSF introuvable ou masqué.")

                pid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service,
                       codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites,
                       actif, date_maj,

                       -- Contraintes
                       niveau_education_minimum,
                       nsf_groupe_code,
                       nsf_groupe_obligatoire,
                       mobilite,
                       risque_physique,
                       perspectives_evolution,
                       niveau_contrainte,
                       detail_contrainte)
                    VALUES
                      (%s, %s, %s, %s,
                       %s, %s, %s,
                       %s, %s,
                       TRUE, NOW(),

                       %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        pid, oid, oid, sid,
                        codif, cod_cli, title,
                        mission, resp,

                        edu_min,
                        nsf_code,
                        nsf_oblig,
                        mobilite,
                        risque,
                        persp,
                        niv_ctr,
                        det_ctr,
                    ),
                )
                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_param_rh
                      (
                        id_poste,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_source,
                        param_rh_date_maj,
                        param_rh_verrouille,
                        param_rh_commentaire
                      )
                    VALUES
                      (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        'studio',
                        NOW(),
                        %s,
                        %s
                      )
                    """,
                    (
                        pid,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_verrouille,
                        param_rh_commentaire,
                    ),
                )

                conn.commit()

        return {"id_poste": pid, "codif_poste": codif}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes create error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}")
def studio_org_update_poste(id_owner: str, id_poste: str, payload: UpdatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}
        
        if "codif_poste" in patch_fields:
            raise HTTPException(status_code=400, detail="Le code interne est généré automatiquement et ne peut pas être modifié.")
        
        rh_patch_fields = {
            "statut_poste",
            "date_debut_validite",
            "date_fin_validite",
            "nb_titulaires_cible",
            "criticite_poste",
            "strategie_pourvoi",
            "param_rh_verrouille",
            "param_rh_commentaire",
        }

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _poste_exists(cur, oid, oid, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cols = []
                vals = []
                need_commit = False

                if "id_service" in patch_fields:
                    sid = _norm_service_id(payload.id_service)
                    if not sid:
                        raise HTTPException(status_code=400, detail="Service obligatoire.")
                    if not _service_exists_active(cur, oid, sid):
                        raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")
                    cols.append("id_service = %s")
                    vals.append(sid)

                if "codif_client" in patch_fields:
                    codc = (payload.codif_client or "").strip() or None
                    cols.append("codif_client = %s")
                    vals.append(codc)

                if "intitule_poste" in patch_fields:
                    title = (payload.intitule_poste or "").strip()
                    if not title:
                        raise HTTPException(status_code=400, detail="Intitulé obligatoire.")
                    cols.append("intitule_poste = %s")
                    vals.append(title)

                if "mission_principale" in patch_fields:
                    mission = (payload.mission_principale or "").strip() or None
                    cols.append("mission_principale = %s")
                    vals.append(mission)

                if "responsabilites" in patch_fields:
                    resp = (payload.responsabilites or "").strip() or None
                    cols.append("responsabilites = %s")
                    vals.append(resp)

                if "niveau_education_minimum" in patch_fields:
                    edu_min = (payload.niveau_education_minimum or "").strip() or None
                    cols.append("niveau_education_minimum = %s")
                    vals.append(edu_min)

                if "nsf_groupe_code" in patch_fields:
                    nsf_code = (payload.nsf_groupe_code or "").strip() or None
                    if nsf_code and not _nsf_groupe_exists_active(cur, nsf_code):
                        raise HTTPException(status_code=400, detail="Domaine NSF introuvable ou masqué.")
                    cols.append("nsf_groupe_code = %s")
                    vals.append(nsf_code)

                if "nsf_groupe_obligatoire" in patch_fields:
                    nsf_oblig = bool(payload.nsf_groupe_obligatoire) if payload.nsf_groupe_obligatoire is not None else False
                    cols.append("nsf_groupe_obligatoire = %s")
                    vals.append(nsf_oblig)

                if "mobilite" in patch_fields:
                    mobilite = (payload.mobilite or "").strip() or None
                    cols.append("mobilite = %s")
                    vals.append(mobilite)

                if "risque_physique" in patch_fields:
                    risque = (payload.risque_physique or "").strip() or None
                    cols.append("risque_physique = %s")
                    vals.append(risque)

                if "perspectives_evolution" in patch_fields:
                    persp = (payload.perspectives_evolution or "").strip() or None
                    cols.append("perspectives_evolution = %s")
                    vals.append(persp)

                if "niveau_contrainte" in patch_fields:
                    niv_ctr = (payload.niveau_contrainte or "").strip() or None
                    cols.append("niveau_contrainte = %s")
                    vals.append(niv_ctr)

                if "detail_contrainte" in patch_fields:
                    det_ctr = (payload.detail_contrainte or "").strip() or None
                    cols.append("detail_contrainte = %s")
                    vals.append(det_ctr)

                if cols:
                    cols.append("date_maj = NOW()")
                    vals.extend([pid, oid, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_fiche_poste
                        SET {", ".join(cols)}
                        WHERE id_poste = %s
                          AND id_owner = %s
                          AND id_ent = %s
                        """,
                        tuple(vals),
                    )
                    need_commit = True

                if patch_fields.intersection(rh_patch_fields):
                    statut_poste = _norm_rh_statut(payload.statut_poste)
                    date_debut_validite = _norm_iso_date(payload.date_debut_validite)
                    date_fin_validite = _norm_iso_date(payload.date_fin_validite)
                    _validate_rh_dates(date_debut_validite, date_fin_validite)
                    nb_titulaires_cible = _norm_rh_nb_titulaires(payload.nb_titulaires_cible)
                    criticite_poste = _norm_rh_criticite(payload.criticite_poste)
                    strategie_pourvoi = _norm_rh_strategie(payload.strategie_pourvoi)
                    param_rh_verrouille = bool(payload.param_rh_verrouille) if payload.param_rh_verrouille is not None else False
                    param_rh_commentaire = (payload.param_rh_commentaire or "").strip() or None

                    cur.execute(
                        """
                        INSERT INTO public.tbl_fiche_poste_param_rh
                          (
                            id_poste,
                            statut_poste,
                            date_debut_validite,
                            date_fin_validite,
                            nb_titulaires_cible,
                            criticite_poste,
                            strategie_pourvoi,
                            param_rh_source,
                            param_rh_date_maj,
                            param_rh_verrouille,
                            param_rh_commentaire
                          )
                        VALUES
                          (
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            'studio',
                            NOW(),
                            %s,
                            %s
                          )
                        ON CONFLICT (id_poste)
                        DO UPDATE SET
                          statut_poste = EXCLUDED.statut_poste,
                          date_debut_validite = EXCLUDED.date_debut_validite,
                          date_fin_validite = EXCLUDED.date_fin_validite,
                          nb_titulaires_cible = EXCLUDED.nb_titulaires_cible,
                          criticite_poste = EXCLUDED.criticite_poste,
                          strategie_pourvoi = EXCLUDED.strategie_pourvoi,
                          param_rh_source = 'studio',
                          param_rh_date_maj = NOW(),
                          param_rh_verrouille = EXCLUDED.param_rh_verrouille,
                          param_rh_commentaire = EXCLUDED.param_rh_commentaire
                        """,
                        (
                            pid,
                            statut_poste,
                            date_debut_validite,
                            date_fin_validite,
                            nb_titulaires_cible,
                            criticite_poste,
                            strategie_pourvoi,
                            param_rh_verrouille,
                            param_rh_commentaire,
                        ),
                    )
                    need_commit = True

                if need_commit:
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes update error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/archive")
def studio_org_archive_poste(id_owner: str, id_poste: str, payload: ArchivePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        set_actif = not bool(payload.archive)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _poste_exists(cur, oid, oid, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET actif = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    """,
                    (set_actif, pid, oid, oid),
                )
                conn.commit()

        return {"ok": True, "actif": bool(set_actif)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes archive error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/duplicate")
def studio_org_duplicate_poste(id_owner: str, id_poste: str, payload: DuplicatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        target_sid = _norm_service_id(payload.id_service) if payload else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      p.id_service,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites,

                      -- Contraintes
                      p.niveau_education_minimum,
                      p.nsf_groupe_code,
                      COALESCE(p.nsf_groupe_obligatoire, FALSE) AS nsf_groupe_obligatoire,
                      p.mobilite,
                      p.risque_physique,
                      p.perspectives_evolution,
                      p.niveau_contrainte,
                      p.detail_contrainte,

                      -- Paramétrage RH
                      COALESCE(pr.statut_poste, 'actif') AS statut_poste,
                      pr.date_debut_validite,
                      pr.date_fin_validite,
                      COALESCE(pr.nb_titulaires_cible, 1) AS nb_titulaires_cible,
                      COALESCE(pr.criticite_poste, 2) AS criticite_poste,
                      COALESCE(pr.strategie_pourvoi, 'mixte') AS strategie_pourvoi,
                      COALESCE(pr.param_rh_verrouille, FALSE) AS param_rh_verrouille,
                      pr.param_rh_commentaire

                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_fiche_poste_param_rh pr
                      ON pr.id_poste = p.id_poste
                    WHERE p.id_poste = %s
                      AND p.id_owner = %s
                      AND p.id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, oid),
                )
                src = cur.fetchone()
                if not src:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                sid = target_sid or (src.get("id_service") or "").strip()
                if not sid:
                    raise HTTPException(status_code=400, detail="Service obligatoire.")
                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                new_id = str(uuid.uuid4())
                new_code = _next_pt_code(cur, oid, oid)

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service,
                       codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites,
                       actif, date_maj,

                       -- Contraintes
                       niveau_education_minimum,
                       nsf_groupe_code,
                       nsf_groupe_obligatoire,
                       mobilite,
                       risque_physique,
                       perspectives_evolution,
                       niveau_contrainte,
                       detail_contrainte)
                    VALUES
                      (%s, %s, %s, %s,
                       %s, %s, %s,
                       %s, %s,
                       TRUE, NOW(),

                       %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        new_id,
                        oid,
                        oid,
                        sid,
                        new_code,
                        src.get("codif_client"),
                        src.get("intitule_poste"),
                        src.get("mission_principale"),
                        src.get("responsabilites"),

                        src.get("niveau_education_minimum"),
                        src.get("nsf_groupe_code"),
                        bool(src.get("nsf_groupe_obligatoire")),
                        src.get("mobilite"),
                        src.get("risque_physique"),
                        src.get("perspectives_evolution"),
                        src.get("niveau_contrainte"),
                        src.get("detail_contrainte"),
                    ),
                )
                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_param_rh
                      (
                        id_poste,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_source,
                        param_rh_date_maj,
                        param_rh_verrouille,
                        param_rh_commentaire
                      )
                    VALUES
                      (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        'studio',
                        NOW(),
                        %s,
                        %s
                      )
                    """,
                    (
                        new_id,
                        src.get("statut_poste") or "actif",
                        src.get("date_debut_validite"),
                        src.get("date_fin_validite"),
                        int(src.get("nb_titulaires_cible") or 1),
                        int(src.get("criticite_poste") or 2),
                        src.get("strategie_pourvoi") or "mixte",
                        bool(src.get("param_rh_verrouille")),
                        src.get("param_rh_commentaire"),
                    ),
                )

                conn.commit()

        return {"id_poste": new_id, "codif_poste": new_code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes duplicate error: {e}")

@router.get("/studio/org/postes_catalogue/{id_owner}")
def studio_org_list_postes_catalogue(id_owner: str, request: Request, q: str = ""):
    """
    Catalogue V1 = postes existants non liés (id_service IS NULL).
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                where = ["p.id_ent = %s", "COALESCE(p.actif, TRUE) = TRUE", "p.id_service IS NULL"]
                params = [oid]

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT p.id_poste, p.codif_poste, p.codif_client, p.intitule_poste
                    FROM public.tbl_fiche_poste p
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    LIMIT 200
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
            items.append({"id_poste": r.get("id_poste"), "code": code, "intitule": r.get("intitule_poste")})
        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes_catalogue error: {e}")


@router.post("/studio/org/postes/assign/{id_owner}")
def studio_org_assign_poste(id_owner: str, payload: AssignPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        sid = (payload.id_service or "").strip()
        if not pid or not sid:
            raise HTTPException(status_code=400, detail="id_poste et id_service obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only (page organisation admin-only)
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (pid, oid),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Poste introuvable ou inactif.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (sid, pid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/assign error: {e}")


@router.post("/studio/org/postes/detach/{id_owner}")
def studio_org_detach_poste(id_owner: str, payload: DetachPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (pid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/detach error: {e}")
    
@router.get("/studio/org/nsf_groupes/{id_owner}")
def studio_org_list_nsf_groupes(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT code, titre
                    FROM public.tbl_nsf_groupe
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY titre, code
                    """
                )
                rows = cur.fetchall() or []

        return {"items": [{"code": r.get("code"), "titre": r.get("titre")} for r in rows]}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/nsf_groupes error: {e}")
    
@router.get("/studio/org/poste_competences/{id_owner}/{id_poste}")
def studio_org_list_poste_competences(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      pc.id_competence,
                      pc.niveau_requis,
                      pc.poids_criticite,
                      pc.freq_usage,
                      pc.impact_resultat,
                      pc.dependance,
                      pc.date_valorisation,

                      c.code,
                      c.intitule,
                      c.etat,
                      c.domaine,
                      c.niveaua,
                      c.niveaub,
                      c.niveauc,

                      dc.titre_court AS domaine_titre_court,
                      dc.couleur AS domaine_couleur

                    FROM public.tbl_fiche_poste_competence pc
                    JOIN public.tbl_fiche_poste p
                      ON p.id_poste = pc.id_poste
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                    JOIN public.tbl_competence c
                      ON c.id_comp = pc.id_competence
                     AND c.id_owner = %s
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE pc.id_poste = %s
                      AND COALESCE(pc.masque, FALSE) = FALSE
                    ORDER BY lower(c.code), lower(c.intitule)
                    """,
                    (oid, oid, oid, pid),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_competence": r.get("id_competence"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "etat": r.get("etat"),
                    "domaine": r.get("domaine"),
                    "domaine_titre_court": r.get("domaine_titre_court"),
                    "domaine_couleur": r.get("domaine_couleur"),

                    "niveaua": r.get("niveaua"),
                    "niveaub": r.get("niveaub"),
                    "niveauc": r.get("niveauc"),

                    "niveau_requis": r.get("niveau_requis"),
                    "poids_criticite": r.get("poids_criticite"),
                    "freq_usage": r.get("freq_usage"),
                    "impact_resultat": r.get("impact_resultat"),
                    "dependance": r.get("dependance"),
                    "date_valorisation": r.get("date_valorisation"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences list error: {e}")
    
@router.post("/studio/org/poste_competences/{id_owner}/{id_poste}")
def studio_org_upsert_poste_competence(id_owner: str, id_poste: str, payload: UpsertPosteCompetencePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (payload.id_competence or "").strip()
        niv = (payload.niveau_requis or "").strip().upper()

        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")
        if not cid:
            raise HTTPException(status_code=400, detail="id_competence manquant.")
        if niv not in ("A", "B", "C"):
            raise HTTPException(status_code=400, detail="niveau_requis invalide (A/B/C).")

        fu = _clamp_0_10(payload.freq_usage or 0)
        im = _clamp_0_10(payload.impact_resultat or 0)
        de = _clamp_0_10(payload.dependance or 0)
        poids = _calc_poids_criticite_100(fu, im, de)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                # Vérifie poste
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, oid),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                # Vérifie compétence (owner uniquement, masque=false, etat accepté)
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_competence
                    WHERE id_comp = %s
                      AND id_owner = %s
                      AND COALESCE(masque, FALSE) = FALSE
                      AND COALESCE(etat,'') IN ('active','valide','à valider')
                    LIMIT 1
                    """,
                    (cid, oid),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=400, detail="Compétence non autorisée (owner/etat/masque).")

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_competence
                      (id_poste, id_competence, niveau_requis,
                       poids_criticite, freq_usage, impact_resultat, dependance,
                       date_valorisation, masque, date_modification)
                    VALUES
                      (%s, %s, %s,
                       %s, %s, %s, %s,
                       NOW(), FALSE, NOW())
                    ON CONFLICT (id_poste, id_competence)
                    DO UPDATE SET
                      niveau_requis = EXCLUDED.niveau_requis,
                      poids_criticite = EXCLUDED.poids_criticite,
                      freq_usage = EXCLUDED.freq_usage,
                      impact_resultat = EXCLUDED.impact_resultat,
                      dependance = EXCLUDED.dependance,
                      date_valorisation = NOW(),
                      masque = FALSE,
                      date_modification = NOW()
                    """,
                    (pid, cid, niv, poids, fu, im, de),
                )
                conn.commit()

        return {"ok": True, "poids_criticite": poids}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences upsert error: {e}")
    
@router.post("/studio/org/poste_competences/{id_owner}/{id_poste}/{id_competence}/remove")
def studio_org_remove_poste_competence(id_owner: str, id_poste: str, id_competence: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (id_competence or "").strip()
        if not pid or not cid:
            raise HTTPException(status_code=400, detail="Paramètres manquants.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste_competence
                    SET masque = TRUE, date_modification = NOW()
                    WHERE id_poste = %s
                      AND id_competence = %s
                    """,
                    (pid, cid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences remove error: {e}")


@router.get("/studio/org/certifications_catalogue/{id_owner}")
def studio_org_list_certifications_catalogue(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        q = (request.query_params.get("q") or "").strip()
        categorie = (request.query_params.get("categorie") or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      c.id_certification,
                      c.nom_certification,
                      c.description,
                      c.categorie,
                      c.duree_validite,
                      c.delai_renouvellement
                    FROM public.tbl_certification c
                    WHERE COALESCE(c.masque, FALSE) = FALSE
                      AND (
                            %s = ''
                         OR lower(c.nom_certification) LIKE '%%' || lower(%s) || '%%'
                         OR lower(COALESCE(c.description,'')) LIKE '%%' || lower(%s) || '%%'
                         OR lower(COALESCE(c.categorie,'')) LIKE '%%' || lower(%s) || '%%'
                      )
                      AND (
                            %s = ''
                         OR (%s = '__none__' AND COALESCE(c.categorie,'') = '')
                         OR lower(COALESCE(c.categorie,'')) = lower(%s)
                      )
                    ORDER BY lower(COALESCE(c.categorie,'')), lower(c.nom_certification)
                    """,
                    (q, q, q, q, categorie, categorie, categorie),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "description": r.get("description"),
                    "categorie": r.get("categorie"),
                    "duree_validite": r.get("duree_validite"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/certifications_catalogue error: {e}")

@router.post("/studio/org/certifications_catalogue/{id_owner}")
def studio_org_create_certification_catalogue(id_owner: str, payload: CreateCertificationPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        nom = (payload.nom_certification or "").strip()
        if not nom:
            raise HTTPException(status_code=400, detail="nom_certification obligatoire.")

        categorie = (payload.categorie or "").strip() or None
        description = (payload.description or "").strip() or None

        duree_validite = payload.duree_validite
        if duree_validite is not None:
            try:
                duree_validite = int(duree_validite)
            except Exception:
                raise HTTPException(status_code=400, detail="duree_validite invalide.")
            if duree_validite <= 0:
                raise HTTPException(status_code=400, detail="duree_validite doit être > 0.")

        delai_renouvellement = payload.delai_renouvellement
        if delai_renouvellement is not None:
            try:
                delai_renouvellement = int(delai_renouvellement)
            except Exception:
                raise HTTPException(status_code=400, detail="delai_renouvellement invalide.")
            if delai_renouvellement <= 0:
                raise HTTPException(status_code=400, detail="delai_renouvellement doit être > 0.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_certification
                    WHERE lower(nom_certification) = lower(%s)
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (nom,),
                )
                if cur.fetchone():
                    raise HTTPException(status_code=400, detail="Une certification active porte déjà ce nom.")

                cid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_certification
                      (
                        id_certification,
                        nom_certification,
                        description,
                        categorie,
                        duree_validite,
                        date_creation,
                        masque,
                        delai_renouvellement
                      )
                    VALUES
                      (%s, %s, %s, %s, %s, CURRENT_DATE, FALSE, %s)
                    """,
                    (cid, nom, description, categorie, duree_validite, delai_renouvellement),
                )
                conn.commit()

        return {
            "ok": True,
            "item": {
                "id_certification": cid,
                "nom_certification": nom,
                "description": description,
                "categorie": categorie,
                "duree_validite": duree_validite,
                "delai_renouvellement": delai_renouvellement,
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/certifications_catalogue create error: {e}")

@router.get("/studio/org/poste_certifications/{id_owner}/{id_poste}")
def studio_org_list_poste_certifications(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      pc.id_certification,
                      pc.validite_override,
                      pc.niveau_exigence,
                      pc.commentaire,

                      c.nom_certification,
                      c.description,
                      c.categorie,
                      c.duree_validite,
                      c.delai_renouvellement

                    FROM public.tbl_fiche_poste_certification pc
                    JOIN public.tbl_fiche_poste p
                      ON p.id_poste = pc.id_poste
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                    JOIN public.tbl_certification c
                      ON c.id_certification = pc.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    WHERE pc.id_poste = %s
                    ORDER BY lower(COALESCE(c.categorie,'')), lower(c.nom_certification)
                    """,
                    (oid, oid, pid),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "description": r.get("description"),
                    "categorie": r.get("categorie"),
                    "duree_validite": r.get("duree_validite"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                    "validite_override": r.get("validite_override"),
                    "niveau_exigence": r.get("niveau_exigence"),
                    "commentaire": r.get("commentaire"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications list error: {e}")


@router.post("/studio/org/poste_certifications/{id_owner}/{id_poste}")
def studio_org_upsert_poste_certification(id_owner: str, id_poste: str, payload: UpsertPosteCertificationPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (payload.id_certification or "").strip()
        lvl_raw = (payload.niveau_exigence or "requis").strip().lower()

        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")
        if not cid:
            raise HTTPException(status_code=400, detail="id_certification manquant.")

        if lvl_raw == "requis":
            niveau = "requis"
        elif lvl_raw in ("souhaite", "souhaité"):
            niveau = "souhaité"
        else:
            raise HTTPException(status_code=400, detail="niveau_exigence invalide (requis/souhaité).")

        validite_override = payload.validite_override
        if validite_override is not None:
            try:
                validite_override = int(validite_override)
            except Exception:
                raise HTTPException(status_code=400, detail="validite_override invalide.")
            if validite_override <= 0:
                raise HTTPException(status_code=400, detail="validite_override doit être > 0.")

        commentaire = (payload.commentaire or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, oid),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_certification
                    WHERE id_certification = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (cid,),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=400, detail="Certification non autorisée (masque/introuvable).")

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_certification
                      (id_poste, id_certification, validite_override, niveau_exigence, commentaire)
                    VALUES
                      (%s, %s, %s, %s, %s)
                    ON CONFLICT (id_poste, id_certification)
                    DO UPDATE SET
                      validite_override = EXCLUDED.validite_override,
                      niveau_exigence = EXCLUDED.niveau_exigence,
                      commentaire = EXCLUDED.commentaire
                    """,
                    (pid, cid, validite_override, niveau, commentaire),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications upsert error: {e}")


@router.post("/studio/org/poste_certifications/{id_owner}/{id_poste}/{id_certification}/remove")
def studio_org_remove_poste_certification(id_owner: str, id_poste: str, id_certification: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (id_certification or "").strip()
        if not pid or not cid:
            raise HTTPException(status_code=400, detail="Paramètres manquants.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    DELETE FROM public.tbl_fiche_poste_certification pc
                    USING public.tbl_fiche_poste p
                    WHERE pc.id_poste = p.id_poste
                      AND p.id_owner = %s
                      AND p.id_ent = %s
                      AND pc.id_poste = %s
                      AND pc.id_certification = %s
                    """,
                    (oid, oid, pid, cid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications remove error: {e}")