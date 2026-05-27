# unified_api/app/routers/skills_portal_entretien_performance.py

from fastapi import APIRouter, HTTPException, Query, Request, Response, UploadFile, File, Form
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from uuid import uuid4
from datetime import date
import json
import base64
from io import BytesIO

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
)



router = APIRouter()
ALL_SERVICES_ID = "__ALL__"

# ======================================================
# Models
# ======================================================
class ContactEntInfo(BaseModel):
    id_contact: str
    code_ent: str
    civ_ca: Optional[str] = None
    prenom_ca: Optional[str] = None
    nom_ca: Optional[str] = None


class ScoringPonderation(BaseModel):
    nb_criteres: int
    coefficient: float


class ScoringNiveau(BaseModel):
    code: str  # "A" | "B" | "C"
    libelle: str
    score_min: float
    score_max: float


class ScoringConfig(BaseModel):
    note_min: int = 1
    note_max: int = 4
    score_max: int = 24
    score_min_theorique: int = 6
    ponderations: List[ScoringPonderation]
    niveaux: List[ScoringNiveau]


class EntretienPerformanceBootstrapResponse(BaseModel):
    contact: ContactEntInfo
    scoring: ScoringConfig


class EffectifContext(BaseModel):
    id_effectif: str
    nom_effectif: str
    prenom_effectif: str
    matricule_interne: Optional[str] = None
    id_service: Optional[str] = None
    nom_service: Optional[str] = None
    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None


class ChecklistCompetenceItem(BaseModel):
    id_effectif_competence: str
    id_comp: str
    code: str
    intitule: str
    domaine: Optional[str] = None
    niveau_actuel: Optional[str] = None
    date_derniere_eval: Optional[str] = None

    # Criticité (référentiel poste) pour filtrage côté UI
    # - poids_criticite : valeur brute (int) issue de tbl_fiche_poste_competence
    # - poids_criticite_pct : poids normalisé en % par rapport au total du poste
    poids_criticite: Optional[int] = None
    poids_criticite_pct: Optional[float] = None


class EffectifChecklistResponse(BaseModel):
    effectif: EffectifContext
    competences: List[ChecklistCompetenceItem]


class CollaborateurListItem(BaseModel):
    id_effectif: str
    nom_effectif: str
    prenom_effectif: str
    code_effectif: Optional[str] = None

    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None

    ismanager: Optional[bool] = None

class AuditCritereItem(BaseModel):
    code_critere: str  # "Critere1".."Critere4"
    niveau: int        # 1..4
    commentaire: Optional[str] = None


class AuditSavePayload(BaseModel):
    id_effectif_competence: str
    id_comp: Optional[str] = None
    resultat_eval: float                 # score /24
    niveau_actuel: str                   # "Initial" | "Avancé" | "Expert"
    observation: Optional[str] = None
    criteres: List[AuditCritereItem]
    methode_eval: Optional[str] = "Entretien de performance"
    id_entretien_individuel: Optional[str] = None
    role_competence_entretien: Optional[str] = None

class AuditSaveResponse(BaseModel):
    id_audit_competence: str
    date_audit: str

class AuditHistoryItem(BaseModel):
    date_audit: Optional[str] = None
    id_evaluateur: Optional[str] = None
    nom_evaluateur: Optional[str] = None

    id_comp: Optional[str] = None
    code: Optional[str] = None
    intitule: Optional[str] = None

    resultat_eval: Optional[float] = None
    observation: Optional[str] = None
    methode_eval: Optional[str] = None

    id_audit_competence: Optional[str] = None
    id_effectif_competence: Optional[str] = None
    detail_eval: Optional[Dict[str, Any]] = None
    modifiable: bool = False

class EntretienIndividuelPayload(BaseModel):
    type_entretien: Optional[str] = "Entretien individuel"
    statut: Optional[str] = "à réaliser"

    date_prevue: Optional[str] = None
    date_realisee: Optional[str] = None
    periode_debut: Optional[str] = None
    periode_fin: Optional[str] = None

    # Nouvelle structure
    preparation: Optional[Dict[str, Any]] = None
    realisation: Optional[Dict[str, Any]] = None
    competences_entretien: Optional[List[Dict[str, Any]]] = None
    documents: Optional[Dict[str, Any]] = None
    synthese: Optional[Dict[str, Any]] = None

    # Compat ancienne structure : conservée pour éviter de casser un appel encore ancien.
    bilan: Optional[Dict[str, Any]] = None
    objectifs: Optional[Dict[str, Any]] = None
    developpement: Optional[Dict[str, Any]] = None
    plan_actions: Optional[Dict[str, Any]] = None


class EntretienIndividuelItem(BaseModel):
    id_entretien: str
    id_effectif_client: str
    id_manager: Optional[str] = None

    type_entretien: str
    statut: str

    date_prevue: Optional[str] = None
    date_realisee: Optional[str] = None
    periode_debut: Optional[str] = None
    periode_fin: Optional[str] = None

    preparation: Dict[str, Any] = {}
    realisation: Dict[str, Any] = {}
    competences_entretien: List[Dict[str, Any]] = []
    documents: Dict[str, Any] = {}
    synthese: Dict[str, Any] = {}

    nb_documents: int = 0

    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CatalogueCompetenceItem(BaseModel):
    id_comp: str
    code: Optional[str] = None
    intitule: str
    domaine: Optional[str] = None
    domaine_couleur: Optional[str] = None


class EnsureEffectifCompetencePayload(BaseModel):
    id_comp: str

# ======================================================
# Constantes
# ======================================================
ALL_SERVICES_ID = "__ALL__"


# ======================================================
# Models (liste collaborateurs)
# ======================================================
class CollaborateurListItem(BaseModel):
    id_effectif: str
    nom_effectif: str
    prenom_effectif: str
    code_effectif: Optional[str] = None

    id_poste_actuel: Optional[str] = None
    codif_poste: Optional[str] = None
    intitule_poste: Optional[str] = None

    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    ismanager: Optional[bool] = None

    nb_competences_total: int = 0
    nb_competences_jamais_auditees: int = 0
    date_derniere_eval: Optional[str] = None
    mois_depuis_derniere_eval: Optional[int] = None
    priorite_eval: Optional[str] = None    


# ======================================================
# Progression collaborateur
# ======================================================

@router.get("/skills/entretien-performance/progression/{id_contact}/{id_effectif}")
def get_entretien_performance_progression(
    id_contact: str,
    id_effectif: str,
    request: Request,
    criticite_min: float = Query(default=0.0, ge=0.0, le=100.0),
    methode_eval: Optional[str] = Query(default=None),
):
    """
    Progression dans le temps :
    - par compétence
    - par domaine
    - maîtrise du poste

    Règle métier :
    à chaque date d'audit, on reconstruit l'état connu.
    Le dernier point correspond toujours à l'état actuel à la date du jour.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                eff = _fetch_effectif_context(cur, id_ent, id_effectif)
                id_poste = (eff.get("id_poste_actuel") or "").strip()

                seuil = max(0.0, min(100.0, float(criticite_min or 0.0)))
                methode = (methode_eval or "").strip()

                if not id_poste:
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": None,
                        "criticite_min": seuil,
                        "methode_eval": methode,
                        "methodes": [],
                        "competences": [],
                        "domaines": [],
                        "poste": {"label": "Maîtrise du poste", "points": []},
                        "message": "Poste actuel non renseigné pour ce collaborateur.",
                    }

                def _crit_pct(v) -> float:
                    try:
                        x = float(v)
                    except Exception:
                        return 1.0

                    if x <= 0:
                        return 1.0
                    if x <= 1.0:
                        return x * 100.0
                    return x

                def _target_lvl(niv: str) -> float:
                    n = (niv or "").strip().upper()

                    if n in ["A", "INITIAL"]:
                        return 10.0
                    if n in ["B", "AVANCE", "AVANCÉ"]:
                        return 19.0
                    if n in ["C", "EXPERT"]:
                        return 24.0

                    return 24.0

                def _safe_score(v) -> float:
                    try:
                        x = float(v)
                    except Exception:
                        return 0.0
                    return max(0.0, min(24.0, x))

                def _attainment_pct(score: float, target: float) -> float:
                    if target <= 0:
                        return 0.0
                    return max(0.0, min((float(score) / float(target)) * 100.0, 100.0))

                # Compétences attendues du poste, filtrées par criticité minimale
                cur.execute(
                    """
                    SELECT
                        fp.id_competence AS id_comp,
                        fp.niveau_requis,
                        COALESCE(NULLIF(fp.poids_criticite,0),1) AS poids_criticite,
                        c.code,
                        c.intitule,

                        COALESCE(NULLIF(TRIM(c.domaine), ''), 'Sans domaine') AS domaine_id,

                        COALESCE(
                            NULLIF(TRIM(dc.titre_court), ''),
                            NULLIF(TRIM(c.domaine), ''),
                            'Sans domaine'
                        ) AS domaine_titre,

                        dc.couleur::text AS domaine_couleur

                    FROM public.tbl_fiche_poste_competence fp

                    JOIN public.tbl_competence c
                      ON c.id_comp = fp.id_competence
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'valide') <> 'inactive'

                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine

                    WHERE fp.id_poste = %s
                    ORDER BY c.code, c.intitule
                    """,
                    (id_poste,),
                )

                expected_rows = cur.fetchall() or []

                expected = {}
                comp_ids = []

                for r in expected_rows:
                    id_comp = (r.get("id_comp") or "").strip()
                    if not id_comp:
                        continue

                    crit = _crit_pct(r.get("poids_criticite"))

                    if crit + 0.0001 < seuil:
                        continue

                    domaine_id = (r.get("domaine_id") or "Sans domaine").strip()
                    domaine_titre = (r.get("domaine_titre") or domaine_id or "Sans domaine").strip()
                    domaine_couleur = (r.get("domaine_couleur") or "").strip()

                    expected[id_comp] = {
                        "id_comp": id_comp,
                        "code": (r.get("code") or "").strip(),
                        "intitule": (r.get("intitule") or "").strip(),
                        "domaine_id": domaine_id,
                        "domaine": domaine_titre,
                        "domaine_couleur": domaine_couleur,
                        "niveau_requis": (r.get("niveau_requis") or "").strip(),
                        "criticite": crit,
                        "target": _target_lvl(r.get("niveau_requis")),
                    }
                    comp_ids.append(id_comp)

                # Méthodes disponibles
                cur.execute(
                    """
                    SELECT DISTINCT
                        COALESCE(NULLIF(TRIM(a.methode_eval), ''), 'Non renseignée') AS methode_eval
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE ec.id_effectif_client = %s
                      AND e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND ec.archive = FALSE
                      AND ec.actif = TRUE
                    ORDER BY 1
                    """,
                    (id_effectif, id_ent),
                )
                methodes = [
                    (r.get("methode_eval") or "").strip()
                    for r in (cur.fetchall() or [])
                    if (r.get("methode_eval") or "").strip()
                ]

                if not comp_ids:
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": id_poste,
                        "criticite_min": seuil,
                        "methode_eval": methode,
                        "methodes": methodes,
                        "competences": [],
                        "domaines": [],
                        "poste": {"label": "Maîtrise du poste", "points": []},
                        "message": "Aucune compétence retenue avec le seuil de criticité défini.",
                    }

                placeholders = ",".join(["%s"] * len(comp_ids))
                params: List[Any] = [id_effectif, id_ent, *comp_ids]

                method_sql = ""
                if methode:
                    method_sql = " AND COALESCE(NULLIF(TRIM(a.methode_eval), ''), 'Non renseignée') = %s "
                    params.append(methode)

                cur.execute(
                    f"""
                    SELECT
                        ec.id_comp,
                        a.date_audit,
                        a.resultat_eval,
                        COALESCE(NULLIF(TRIM(a.methode_eval), ''), 'Non renseignée') AS methode_eval
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE ec.id_effectif_client = %s
                      AND e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND ec.archive = FALSE
                      AND ec.actif = TRUE
                      AND ec.id_comp IN ({placeholders})
                      AND a.date_audit IS NOT NULL
                      {method_sql}
                    ORDER BY a.date_audit ASC, ec.id_comp ASC
                    """,
                    tuple(params),
                )

                audit_rows = cur.fetchall() or []

                audits_by_date: Dict[str, List[Dict[str, Any]]] = {}
                for r in audit_rows:
                    d = str(r["date_audit"]) if r.get("date_audit") else ""
                    if not d:
                        continue

                    audits_by_date.setdefault(d, []).append(
                        {
                            "id_comp": r.get("id_comp"),
                            "score": _safe_score(r.get("resultat_eval")),
                            "methode_eval": r.get("methode_eval"),
                        }
                    )

                dates = sorted(audits_by_date.keys())
                today = str(date.today())

                if today not in dates:
                    dates.append(today)

                # Dernier état connu par compétence
                known_scores: Dict[str, float] = {}

                comp_points: Dict[str, List[Dict[str, Any]]] = {idc: [] for idc in comp_ids}
                domain_points: Dict[str, List[Dict[str, Any]]] = {}
                poste_points: List[Dict[str, Any]] = []

                for d in dates:
                    for a in audits_by_date.get(d, []):
                        idc = (a.get("id_comp") or "").strip()
                        if idc in expected:
                            known_scores[idc] = _safe_score(a.get("score"))

                    # Courbes compétences : on ne commence la courbe qu'à partir du premier audit connu
                    for idc, meta in expected.items():
                        if idc not in known_scores:
                            continue

                        val = _attainment_pct(known_scores[idc], meta["target"])
                        comp_points[idc].append(
                            {
                                "date": d,
                                "value": round(val, 1),
                                "score": round(known_scores[idc], 1),
                            }
                        )

                    # Courbes domaines : moyenne pondérée des compétences connues du domaine
                    domain_acc: Dict[str, Dict[str, float]] = {}

                    for idc, meta in expected.items():
                        if idc not in known_scores:
                            continue

                        dom = meta["domaine_id"] or "Sans domaine"
                        val = _attainment_pct(known_scores[idc], meta["target"])
                        w = max(float(meta["criticite"]), 1.0)

                        if dom not in domain_acc:
                            domain_acc[dom] = {"num": 0.0, "den": 0.0}

                        domain_acc[dom]["num"] += val * w
                        domain_acc[dom]["den"] += w

                    for dom, acc in domain_acc.items():
                        if acc["den"] <= 0:
                            continue

                        domain_points.setdefault(dom, []).append(
                            {
                                "date": d,
                                "value": round(acc["num"] / acc["den"], 1),
                            }
                        )

                    # Maîtrise du poste : toutes les compétences retenues comptent.
                    # Jamais évaluée = 0.
                    p_num = 0.0
                    p_den = 0.0

                    for idc, meta in expected.items():
                        score = known_scores.get(idc, 0.0)
                        val = _attainment_pct(score, meta["target"])
                        w = max(float(meta["criticite"]), 1.0)

                        p_num += val * w
                        p_den += w

                    poste_points.append(
                        {
                            "date": d,
                            "value": round((p_num / p_den) if p_den > 0 else 0.0, 1),
                        }
                    )

                competences_out = []
                for idc, meta in expected.items():
                    pts = comp_points.get(idc) or []
                    if not pts:
                        continue

                    competences_out.append(
                        {
                            "id": idc,
                            "code": meta["code"],
                            "label": meta["intitule"],
                            "domaine": meta["domaine"],
                            "points": pts,
                            "last_date": pts[-1]["date"] if pts else None,
                        }
                    )

                domaine_meta = {}

                for meta in expected.values():
                    did = meta.get("domaine_id") or "Sans domaine"

                    if did not in domaine_meta:
                        domaine_meta[did] = {
                            "id": did,
                            "label": meta.get("domaine") or did,
                            "couleur": meta.get("domaine_couleur") or None,
                        }

                domaines_out = []

                for dom, pts in sorted(
                    domain_points.items(),
                    key=lambda kv: (domaine_meta.get(kv[0], {}).get("label") or kv[0]).lower()
                ):
                    if not pts:
                        continue

                    meta = domaine_meta.get(dom, {"id": dom, "label": dom, "couleur": None})

                    domaines_out.append(
                        {
                            "id": meta.get("id") or dom,
                            "label": meta.get("label") or dom,
                            "couleur": meta.get("couleur"),
                            "points": pts,
                            "last_date": pts[-1]["date"] if pts else None,
                        }
                    )

                return {
                    "id_effectif": id_effectif,
                    "id_poste": id_poste,
                    "criticite_min": seuil,
                    "methode_eval": methode,
                    "methodes": methodes,
                    "competences": competences_out,
                    "domaines": domaines_out,
                    "poste": {
                        "label": "Maîtrise du poste",
                        "points": poste_points,
                    },
                    "message": None,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Couverture poste actuel (jauge)
# ======================================================
class CouverturePosteDetailItem(BaseModel):
    id_comp: str
    code: str
    intitule: str
    niveau_requis: str
    poids_criticite: int = 1
    score: float = 0.0
    date_audit: Optional[str] = None
    methode_eval: Optional[str] = None


class CouverturePosteVariant(BaseModel):
    ponderer: bool
    gauge_min: float
    gauge_max: float
    expected_min: float
    expected_max: float
    score: float
    pct_attendus: float
    pct_max: float
    details: List[CouverturePosteDetailItem] = []


class CouverturePosteResponse(BaseModel):
    id_effectif: str
    id_poste: Optional[str] = None
    intitule_poste: Optional[str] = None
    nb_competences: int = 0
    plain: CouverturePosteVariant
    weighted: CouverturePosteVariant
    message: Optional[str] = None

# ======================================================
# Helpers
# ======================================================
def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)

def _fetch_effectif_context(cur, id_ent: str, id_effectif: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
            e.id_effectif,
            e.nom_effectif,
            e.prenom_effectif,
            e.matricule_interne,
            e.id_service,
            o.nom_service,
            e.id_poste_actuel,
            fp.intitule_poste
        FROM public.tbl_effectif_client e
        LEFT JOIN public.tbl_entreprise_organigramme o
            ON o.id_ent = e.id_ent
           AND o.id_service = e.id_service
           AND o.archive = FALSE
        LEFT JOIN public.tbl_fiche_poste fp
            ON fp.id_poste = e.id_poste_actuel
           AND COALESCE(fp.actif, TRUE) = TRUE
        WHERE e.id_effectif = %s
          AND e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
        """,
        (id_effectif, id_ent),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
    return row

def _ensure_effectif_competences_for_poste(cur, id_effectif: str, id_poste: Optional[str]) -> None:
    """
    Aligne la checklist d'entretien sur les compétences attendues du poste actuel.

    Problème corrigé :
    - la checklist part de tbl_effectif_client_competence ;
    - si une compétence requise par le poste n'est pas encore rattachée au collaborateur,
      elle n'apparaît pas dans l'entretien ;
    - or l'entretien doit auditer les compétences du poste, pas seulement les compétences
      déjà présentes sur la fiche collaborateur.

    On crée donc les lignes manquantes sans audit, sans niveau, actives et non archivées.
    """
    id_eff = (id_effectif or "").strip()
    id_pos = (id_poste or "").strip()

    if not id_eff or not id_pos:
        return

    cur.execute(
        """
        SELECT DISTINCT
            fpc.id_competence AS id_comp
        FROM public.tbl_fiche_poste_competence fpc
        JOIN public.tbl_competence c
          ON c.id_comp = fpc.id_competence
         AND COALESCE(c.masque, FALSE) = FALSE
         AND COALESCE(c.etat, 'valide') <> 'inactive'
        WHERE fpc.id_poste = %s
          AND COALESCE(fpc.id_competence, '') <> ''
          AND NOT EXISTS (
              SELECT 1
              FROM public.tbl_effectif_client_competence ec
              WHERE ec.id_effectif_client = %s
                AND ec.id_comp = fpc.id_competence
                AND COALESCE(ec.archive, FALSE) = FALSE
          )
        """,
        (id_pos, id_eff),
    )

    missing = cur.fetchall() or []

    for r in missing:
        id_comp = (r.get("id_comp") or "").strip()
        if not id_comp:
            continue

        cur.execute(
            """
            INSERT INTO public.tbl_effectif_client_competence
            (
                id_effectif_competence,
                id_effectif_client,
                id_comp,
                niveau_actuel,
                id_dernier_audit,
                actif,
                archive,
                date_derniere_eval
            )
            VALUES
            (
                %s, %s, %s,
                NULL,
                NULL,
                TRUE,
                FALSE,
                NULL
            )
            """,
            (
                str(uuid4()),
                id_eff,
                id_comp,
            ),
        )

def _ep_json_dict(value) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value

    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    return {}

def _ep_json_list(value) -> List[Dict[str, Any]]:
    if isinstance(value, list):
        return [x for x in value if isinstance(x, dict)]

    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return [x for x in parsed if isinstance(x, dict)] if isinstance(parsed, list) else []
        except Exception:
            return []

    return []

def _ep_humanize_json_key(key: str) -> str:
    labels = {
        "missions": "Missions",
        "reussites": "Réussites",
        "difficultes": "Difficultés",
        "contexte": "Organisation / conditions de travail",

        "objectifs": "Objectifs",
        "indicateurs": "Indicateurs / attendus",
        "moyens": "Moyens nécessaires",
        "echeances": "Échéances",

        "besoins_formation": "Besoins de formation",
        "souhaits": "Souhaits du collaborateur",
        "evolution": "Évolution / mobilité",
        "accompagnement": "Accompagnement",

        "actions": "Actions",
        "references": "Documents",
    }

    k = (key or "").strip()
    if not k:
        return ""

    if k in labels:
        return labels[k]

    return k.replace("_", " ").strip().capitalize()


def _ep_json_to_text(value) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return "" if value.strip() == "[object Object]" else value.strip()

    if isinstance(value, (int, float, bool)):
        return str(value)

    if isinstance(value, list):
        parts = [
            _ep_json_to_text(v).strip()
            for v in value
        ]

        return "\n".join([p for p in parts if p])

    if isinstance(value, dict):
        parts = []

        for k, v in value.items():
            txt = _ep_json_to_text(v).strip()
            if not txt:
                continue

            label = _ep_humanize_json_key(k)
            parts.append(f"{label} : {txt}" if label else txt)

        return "\n".join(parts)

    return ""


def _ep_is_empty_json_value(value) -> bool:
    return value is None or value == "" or value == {} or value == []

def _ep_parse_date(value: Optional[str], field_name: str):
    raw = (value or "").strip()
    if not raw:
        return None

    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} invalide. Format attendu : YYYY-MM-DD.")


def _ep_valid_entretien_statut(value: Optional[str]) -> str:
    statut = (value or "à réaliser").strip().lower()

    mapping = {
        "brouillon": "à réaliser",
        "préparation": "à réaliser",
        "preparation": "à réaliser",

        "à réaliser": "à réaliser",
        "a réaliser": "à réaliser",
        "à realiser": "à réaliser",
        "a realiser": "à réaliser",

        "en cours": "en cours",

        "à signer": "à signer 2/2",
        "a signer": "à signer 2/2",
        "à signer 2/2": "à signer 2/2",
        "a signer 2/2": "à signer 2/2",
        "à signer 1/2": "à signer 1/2",
        "a signer 1/2": "à signer 1/2",

        "terminé": "terminé",
        "termine": "terminé",

        "validé": "terminé",
        "valide": "terminé",

        "archivé": "archivé",
        "archive": "archivé",
    }

    if statut not in mapping:
        raise HTTPException(status_code=400, detail="Statut entretien invalide.")

    return mapping[statut]


def _ep_entretien_item_from_row(r) -> EntretienIndividuelItem:
    preparation = _ep_json_dict(r.get("preparation"))
    realisation_raw = _ep_json_dict(r.get("realisation"))
    competences_entretien = _ep_json_list(r.get("competences_entretien"))

    old_bilan = _ep_json_dict(r.get("bilan"))
    old_objectifs = _ep_json_dict(r.get("objectifs"))
    old_developpement = _ep_json_dict(r.get("developpement"))
    old_plan_actions = _ep_json_dict(r.get("plan_actions"))

    # L'UI actuelle de l'onglet Réalisation attend 4 champs texte.
    # Les anciennes colonnes sont des JSONB structurés, donc on les convertit proprement.
    realisation = {
        "bilan": _ep_json_to_text(
            realisation_raw.get("bilan")
            if not _ep_is_empty_json_value(realisation_raw.get("bilan"))
            else old_bilan
        ),
        "objectifs": _ep_json_to_text(
            realisation_raw.get("objectifs")
            if not _ep_is_empty_json_value(realisation_raw.get("objectifs"))
            else old_objectifs
        ),
        "developpement": _ep_json_to_text(
            realisation_raw.get("developpement")
            if not _ep_is_empty_json_value(realisation_raw.get("developpement"))
            else old_developpement
        ),
        "plan_actions": _ep_json_to_text(
            realisation_raw.get("plan_actions")
            if not _ep_is_empty_json_value(realisation_raw.get("plan_actions"))
            else old_plan_actions
        ),
    }

    return EntretienIndividuelItem(
        id_entretien=r["id_entretien"],
        id_effectif_client=r["id_effectif_client"],
        id_manager=r.get("id_manager"),
        type_entretien=r.get("type_entretien") or "Entretien individuel",
        statut=r.get("statut") or "à réaliser",
        date_prevue=str(r["date_prevue"]) if r.get("date_prevue") else None,
        date_realisee=str(r["date_realisee"]) if r.get("date_realisee") else None,
        periode_debut=str(r["periode_debut"]) if r.get("periode_debut") else None,
        periode_fin=str(r["periode_fin"]) if r.get("periode_fin") else None,
        preparation=preparation,
        realisation=realisation,
        competences_entretien=competences_entretien,
        documents=_ep_json_dict(r.get("documents")),
        synthese=_ep_json_dict(r.get("synthese")),
        nb_documents=int(r.get("nb_documents") or 0),
        created_at=str(r["created_at"]) if r.get("created_at") else None,
        updated_at=str(r["updated_at"]) if r.get("updated_at") else None,
    )

def _ep_payload_realisation(payload: EntretienIndividuelPayload) -> Dict[str, Any]:
    """
    Construit la nouvelle structure realisation.
    Compatible avec les anciens champs bilan/objectifs/developpement/plan_actions.
    """
    if isinstance(payload.realisation, dict):
        return payload.realisation

    return {
        "bilan": payload.bilan or {},
        "objectifs": payload.objectifs or {},
        "developpement": payload.developpement or {},
        "plan_actions": payload.plan_actions or {},
    }


def _ep_payload_preparation(payload: EntretienIndividuelPayload) -> Dict[str, Any]:
    return payload.preparation or {}


def _ep_payload_competences(payload: EntretienIndividuelPayload) -> List[Dict[str, Any]]:
    if isinstance(payload.competences_entretien, list):
        return [x for x in payload.competences_entretien if isinstance(x, dict)]

    return []


def _ep_has_active_validation(cur, id_ent: str, id_entretien: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_validations_electroniques
        WHERE type_document = 'entretien_individuel'
          AND id_document_ref = %s
          AND id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_entretien, id_ent),
    )
    return cur.fetchone() is not None

def _get_scoring_config() -> ScoringConfig:
    # Règle Skillboard (historique): pondération = 6 / nb_criteres, score final sur 24
    ponderations = [
        ScoringPonderation(nb_criteres=4, coefficient=1.5),
        ScoringPonderation(nb_criteres=3, coefficient=2.0),
        ScoringPonderation(nb_criteres=2, coefficient=3.0),
        ScoringPonderation(nb_criteres=1, coefficient=6.0),
    ]

    niveaux = [
        ScoringNiveau(code="A", libelle="Initial", score_min=6.0, score_max=9.0),
        ScoringNiveau(code="B", libelle="Avancé", score_min=10.0, score_max=18.0),
        ScoringNiveau(code="C", libelle="Expert", score_min=19.0, score_max=24.0),
    ]

    return ScoringConfig(
        note_min=1,
        note_max=4,
        score_max=24,
        score_min_theorique=6,
        ponderations=ponderations,
        niveaux=niveaux,
    )


# ======================================================
# Endpoints (squelette)
# ======================================================
@router.get("/skills/entretien-performance/healthz")
def entretien_performance_healthz():
    return {"status": "ok"}


@router.get(
    "/skills/entretien-performance/bootstrap/{id_contact}",
    response_model=EntretienPerformanceBootstrapResponse,
)
def get_entretien_performance_bootstrap(id_contact: str, request: Request):
    """
    Squelette: retourne les infos contact/entreprise + configuration de scoring.
    (Pas encore de contenu métier: effectifs, compétences, audits, etc.)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                return EntretienPerformanceBootstrapResponse(
                    contact=ContactEntInfo(
                        id_contact=id_contact,   # compat (on garde l'id de l'appelant)
                        code_ent=id_ent,
                        civ_ca=None,
                        prenom_ca=None,
                        nom_ca=None,
                    ),
                    scoring=_get_scoring_config(),
                )


    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Endpoints Collaborateurs
# ======================================================
@router.get(
    "/skills/entretien-performance/collaborateurs/{id_contact}/{id_service}",
    response_model=List[CollaborateurListItem],
)
def get_entretien_performance_collaborateurs(
    id_contact: str,
    request: Request,
    id_service: str,
    q: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                where_parts: List[str] = [
                    "e.id_ent = %s",
                    "COALESCE(e.archive, FALSE) = FALSE",
                    "COALESCE(e.statut_actif, TRUE) = TRUE",
                ]
                params: List[Any] = [id_ent]

                if id_service != ALL_SERVICES_ID:
                    where_parts.append("e.id_service = %s")
                    params.append(id_service)

                if q and q.strip():
                    like = f"%{q.strip()}%"
                    where_parts.append(
                        "("
                        "e.nom_effectif ILIKE %s OR "
                        "e.prenom_effectif ILIKE %s OR "
                        "COALESCE(e.code_effectif,'') ILIKE %s OR "
                        "COALESCE(e.matricule_interne,'') ILIKE %s"
                        ")"
                    )
                    params.extend([like, like, like, like])

                where_sql = " AND ".join(where_parts)

                cur.execute(
                    f"""
                    WITH comp_eval AS (
                        SELECT
                            ec.id_effectif_client,
                            COUNT(ec.id_effectif_competence)::int AS nb_competences_total,
                            SUM(CASE WHEN ec.date_derniere_eval IS NULL THEN 1 ELSE 0 END)::int AS nb_competences_jamais_auditees,
                            MAX(ec.date_derniere_eval) AS date_derniere_eval
                        FROM public.tbl_effectif_client_competence ec
                        JOIN public.tbl_competence c
                          ON c.id_comp = ec.id_comp
                         AND COALESCE(c.masque, FALSE) = FALSE
                         AND COALESCE(c.etat, 'valide') <> 'inactive'
                        WHERE ec.actif = TRUE
                          AND ec.archive = FALSE
                        GROUP BY ec.id_effectif_client
                    )
                    SELECT
                        e.id_effectif,
                        e.nom_effectif,
                        e.prenom_effectif,
                        e.code_effectif,
                        e.id_service,
                        o.nom_service,
                        e.id_poste_actuel,
                        fp.intitule_poste,
                        e.ismanager,

                        COALESCE(comp.nb_competences_total, 0)::int AS nb_competences_total,
                        COALESCE(comp.nb_competences_jamais_auditees, 0)::int AS nb_competences_jamais_auditees,
                        comp.date_derniere_eval::text AS date_derniere_eval,

                        CASE
                            WHEN comp.date_derniere_eval IS NULL THEN NULL
                            ELSE (
                                EXTRACT(YEAR FROM age(CURRENT_DATE, comp.date_derniere_eval))::int * 12
                                + EXTRACT(MONTH FROM age(CURRENT_DATE, comp.date_derniere_eval))::int
                            )
                        END AS mois_depuis_derniere_eval,

                        CASE
                            WHEN COALESCE(comp.nb_competences_total, 0) = 0 THEN 'none'
                            WHEN COALESCE(comp.nb_competences_jamais_auditees, 0) > 0 THEN 'high'
                            WHEN comp.date_derniere_eval IS NULL THEN 'high'
                            WHEN comp.date_derniere_eval < (CURRENT_DATE - INTERVAL '12 months') THEN 'plan'
                            ELSE 'ok'
                        END AS priorite_eval

                    FROM public.tbl_effectif_client e

                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_ent = e.id_ent
                       AND o.id_service = e.id_service
                       AND COALESCE(o.archive, FALSE) = FALSE

                    LEFT JOIN public.tbl_fiche_poste fp
                        ON fp.id_poste = e.id_poste_actuel
                       AND fp.id_ent = e.id_ent
                       AND COALESCE(fp.actif, TRUE) = TRUE

                    LEFT JOIN comp_eval comp
                        ON comp.id_effectif_client = e.id_effectif

                    WHERE {where_sql}

                    ORDER BY
                        CASE
                            WHEN COALESCE(comp.nb_competences_total, 0) = 0 THEN 3
                            WHEN COALESCE(comp.nb_competences_jamais_auditees, 0) > 0 THEN 0
                            WHEN comp.date_derniere_eval IS NULL THEN 0
                            WHEN comp.date_derniere_eval < (CURRENT_DATE - INTERVAL '12 months') THEN 1
                            ELSE 2
                        END,
                        e.nom_effectif,
                        e.prenom_effectif

                    LIMIT %s
                    """,
                    tuple([*params, limit]),
                )

                rows = cur.fetchall() or []
                return [
                    CollaborateurListItem(
                        id_effectif=r["id_effectif"],
                        nom_effectif=r.get("nom_effectif") or "",
                        prenom_effectif=r.get("prenom_effectif") or "",
                        code_effectif=r.get("code_effectif"),
                        id_service=r.get("id_service"),
                        nom_service=r.get("nom_service"),
                        id_poste_actuel=r.get("id_poste_actuel"),
                        intitule_poste=r.get("intitule_poste"),
                        ismanager=r.get("ismanager"),
                        nb_competences_total=int(r.get("nb_competences_total") or 0),
                        nb_competences_jamais_auditees=int(r.get("nb_competences_jamais_auditees") or 0),
                        date_derniere_eval=r.get("date_derniere_eval"),
                        mois_depuis_derniere_eval=r.get("mois_depuis_derniere_eval"),
                        priorite_eval=r.get("priorite_eval"),
                    )
                    for r in rows
                ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Endpoints Checklist competences
# ======================================================
@router.get(
    "/skills/entretien-performance/effectif-checklist/{id_contact}/{id_effectif}",
    response_model=EffectifChecklistResponse,
)
def get_effectif_checklist(id_contact: str, id_effectif: str, request: Request):
    """
    Contexte réel du collaborateur + checklist des compétences (niveau actuel, date dernière eval).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                eff = _fetch_effectif_context(cur, id_ent, id_effectif)
                id_poste = eff.get("id_poste_actuel")
                _ensure_effectif_competences_for_poste(cur, id_effectif, id_poste)

                # Les lignes compétence manquantes peuvent être créées juste au-dessus.
                # On commit explicitement avant de renvoyer la checklist, sinon le front
                # peut afficher une ligne que la route POST d'enregistrement ne retrouvera pas ensuite.
                conn.commit()

                cur.execute(
                    """
                    WITH poste_total AS (
                        SELECT
                            id_poste,
                            SUM(COALESCE(NULLIF(poids_criticite,0),1))::float AS total_weight
                        FROM public.tbl_fiche_poste_competence
                        WHERE id_poste = %s
                        GROUP BY id_poste
                    )
                    SELECT
                        ec.id_effectif_competence,
                        ec.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine,
                        ec.niveau_actuel,
                        ec.date_derniere_eval::text AS date_derniere_eval,

                        CASE
                            WHEN fp.id_competence IS NULL THEN NULL
                            ELSE fp.poids_criticite
                        END AS poids_criticite,

                        CASE
                            WHEN fp.id_competence IS NULL OR fp.poids_criticite IS NULL THEN 0.0
                            -- au cas où la valeur serait stockée en 0.xx au lieu de xx
                            WHEN fp.poids_criticite::float <= 1.0 THEN ROUND((fp.poids_criticite::float * 100.0)::numeric, 2)::float
                            ELSE fp.poids_criticite::float
                        END AS poids_criticite_pct

                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_effectif_client e
                        ON e.id_effectif = ec.id_effectif_client
                    JOIN public.tbl_competence c
                        ON c.id_comp = ec.id_comp

                    LEFT JOIN public.tbl_fiche_poste_competence fp
                        ON fp.id_poste = %s
                       AND fp.id_competence = ec.id_comp

                    LEFT JOIN poste_total pt
                        ON pt.id_poste = %s

                    WHERE ec.id_effectif_client = %s
                      AND e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'valide') <> 'inactive'
                    ORDER BY c.code, c.intitule
                    """,
                    (id_poste, id_poste, id_poste, id_effectif, id_ent),
                )
                rows = cur.fetchall() or []

                effectif = EffectifContext(
                    id_effectif=eff["id_effectif"],
                    nom_effectif=eff.get("nom_effectif") or "",
                    prenom_effectif=eff.get("prenom_effectif") or "",
                    matricule_interne=eff.get("matricule_interne"),
                    id_service=eff.get("id_service"),
                    nom_service=eff.get("nom_service"),
                    id_poste_actuel=eff.get("id_poste_actuel"),
                    intitule_poste=eff.get("intitule_poste"),
                )

                competences = [
                    ChecklistCompetenceItem(
                        id_effectif_competence=r["id_effectif_competence"],
                        id_comp=r["id_comp"],
                        code=r["code"],
                        intitule=r["intitule"],
                        domaine=r.get("domaine"),
                        niveau_actuel=r.get("niveau_actuel"),
                        date_derniere_eval=r.get("date_derniere_eval"),
                        poids_criticite=r.get("poids_criticite"),
                        poids_criticite_pct=r.get("poids_criticite_pct"),
                    )
                    for r in rows
                ]


                return EffectifChecklistResponse(effectif=effectif, competences=competences)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Entretien individuel
# ======================================================

@router.get(
    "/skills/entretien-performance/entretiens/{id_contact}/{id_effectif}",
    response_model=List[EntretienIndividuelItem],
)
def ep_list_entretiens_individuels(
    id_contact: str,
    id_effectif: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                _fetch_effectif_context(cur, id_ent, id_effectif)

                cur.execute(
                    """
                    SELECT
                        id_entretien,
                        id_effectif_client,
                        id_manager,
                        type_entretien,
                        statut,
                        date_prevue,
                        date_realisee,
                        periode_debut,
                        periode_fin,
                        preparation,
                        realisation,
                        competences_entretien,
                        documents,
                        synthese,
                        bilan,
                        objectifs,
                        developpement,
                        plan_actions,
                        created_at,
                        updated_at,
                        (
                            SELECT COUNT(*)::int
                            FROM public.tbl_entretien_individuel_document d
                            WHERE d.id_entretien = tbl_entretien_individuel.id_entretien
                            AND COALESCE(d.archive, FALSE) = FALSE
                        ) AS nb_documents
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY
                        COALESCE(date_realisee, date_prevue, created_at::date) DESC,
                        updated_at DESC
                    LIMIT 100
                    """,
                    (id_ent, id_effectif),
                )

                return [_ep_entretien_item_from_row(r) for r in (cur.fetchall() or [])]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}",
    response_model=EntretienIndividuelItem,
)
def ep_get_entretien_individuel(
    id_contact: str,
    id_entretien: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                        id_entretien,
                        id_effectif_client,
                        id_manager,
                        type_entretien,
                        statut,
                        date_prevue,
                        date_realisee,
                        periode_debut,
                        periode_fin,
                        preparation,
                        realisation,
                        competences_entretien,
                        documents,
                        synthese,
                        bilan,
                        objectifs,
                        developpement,
                        plan_actions,
                        created_at,
                        updated_at,
                        (
                            SELECT COUNT(*)::int
                            FROM public.tbl_entretien_individuel_document d
                            WHERE d.id_entretien = tbl_entretien_individuel.id_entretien
                            AND COALESCE(d.archive, FALSE) = FALSE
                        ) AS nb_documents
                    FROM public.tbl_entretien_individuel
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (id_entretien, id_ent),
                )

                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")

                return _ep_entretien_item_from_row(row)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/entretien-performance/entretien/{id_contact}/{id_effectif}",
    response_model=EntretienIndividuelItem,
)
def ep_create_entretien_individuel(
    id_contact: str,
    id_effectif: str,
    payload: EntretienIndividuelPayload,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                _fetch_effectif_context(cur, id_ent, id_effectif)

                id_entretien = str(uuid4())
                statut = _ep_valid_entretien_statut(payload.statut)

                cur.execute(
                    """
                    INSERT INTO public.tbl_entretien_individuel
                    (
                        id_entretien,
                        id_ent,
                        id_effectif_client,
                        id_manager,
                        type_entretien,
                        statut,
                        date_prevue,
                        date_realisee,
                        periode_debut,
                        periode_fin,
                        preparation,
                        realisation,
                        competences_entretien,
                        documents,
                        synthese,
                        bilan,
                        objectifs,
                        developpement,
                        plan_actions,
                        created_at,
                        updated_at,
                        (
                            SELECT COUNT(*)::int
                            FROM public.tbl_entretien_individuel_document d
                            WHERE d.id_entretien = tbl_entretien_individuel.id_entretien
                            AND COALESCE(d.archive, FALSE) = FALSE
                        ) AS nb_documents
                    )
                    VALUES
                    (
                        %s, %s, %s, %s,
                        %s, %s,
                        %s, %s, %s, %s,
                        %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                        %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb,
                        FALSE,
                        NOW(),
                        NOW()
                    )
                    RETURNING
                        id_entretien,
                        id_effectif_client,
                        id_manager,
                        type_entretien,
                        statut,
                        date_prevue,
                        date_realisee,
                        periode_debut,
                        periode_fin,
                        preparation,
                        realisation,
                        competences_entretien,
                        documents,
                        synthese,
                        bilan,
                        objectifs,
                        developpement,
                        plan_actions,
                        created_at,
                        updated_at,
                        (
                            SELECT COUNT(*)::int
                            FROM public.tbl_entretien_individuel_document d
                            WHERE d.id_entretien = tbl_entretien_individuel.id_entretien
                            AND COALESCE(d.archive, FALSE) = FALSE
                        ) AS nb_documents
                    """,
                    (
                        id_entretien,
                        id_ent,
                        id_effectif,
                        id_contact,
                        (payload.type_entretien or "Entretien individuel").strip() or "Entretien individuel",
                        statut,
                        _ep_parse_date(payload.date_prevue, "date_prevue"),
                        _ep_parse_date(payload.date_realisee, "date_realisee"),
                        _ep_parse_date(payload.periode_debut, "periode_debut"),
                        _ep_parse_date(payload.periode_fin, "periode_fin"),
                        json.dumps(_ep_payload_preparation(payload), ensure_ascii=False),
                        json.dumps(_ep_payload_realisation(payload), ensure_ascii=False),
                        json.dumps(_ep_payload_competences(payload), ensure_ascii=False),
                        json.dumps(payload.documents or {}, ensure_ascii=False),
                        json.dumps(payload.synthese or {}, ensure_ascii=False),

                        # Compat ancienne structure
                        json.dumps(payload.bilan or {}, ensure_ascii=False),
                        json.dumps(payload.objectifs or {}, ensure_ascii=False),
                        json.dumps(payload.developpement or {}, ensure_ascii=False),
                        json.dumps(payload.plan_actions or {}, ensure_ascii=False),
                    ),
                )

                row = cur.fetchone()
                conn.commit()

                return _ep_entretien_item_from_row(row)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.put(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}",
    response_model=EntretienIndividuelItem,
)
def ep_update_entretien_individuel(
    id_contact: str,
    id_entretien: str,
    payload: EntretienIndividuelPayload,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT id_entretien
                    FROM public.tbl_entretien_individuel
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (id_entretien, id_ent),
                )

                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")

                if _ep_has_active_validation(cur, id_ent, id_entretien):
                    raise HTTPException(
                        status_code=409,
                        detail="Entretien déjà signé : modification bloquée. Réouverture/versionnement à traiter dans un flux dédié.",
                    )

                statut = _ep_valid_entretien_statut(payload.statut)

                cur.execute(
                    """
                    UPDATE public.tbl_entretien_individuel
                    SET
                        type_entretien = %s,
                        statut = %s,
                        date_prevue = %s,
                        date_realisee = %s,
                        periode_debut = %s,
                        periode_fin = %s,
                        preparation = %s::jsonb,
                        realisation = %s::jsonb,
                        competences_entretien = %s::jsonb,
                        documents = %s::jsonb,
                        synthese = %s::jsonb,

                        -- Compat ancienne structure
                        bilan = %s::jsonb,
                        objectifs = %s::jsonb,
                        developpement = %s::jsonb,
                        plan_actions = %s::jsonb,

                        updated_at = NOW()
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING
                        id_entretien,
                        id_effectif_client,
                        id_manager,
                        type_entretien,
                        statut,
                        date_prevue,
                        date_realisee,
                        periode_debut,
                        periode_fin,
                        preparation,
                        realisation,
                        competences_entretien,
                        documents,
                        synthese,
                        bilan,
                        objectifs,
                        developpement,
                        plan_actions,
                        created_at,
                        updated_at,
                        (
                            SELECT COUNT(*)::int
                            FROM public.tbl_entretien_individuel_document d
                            WHERE d.id_entretien = tbl_entretien_individuel.id_entretien
                            AND COALESCE(d.archive, FALSE) = FALSE
                        ) AS nb_documents
                    """,
                    (
                        (payload.type_entretien or "Entretien individuel").strip() or "Entretien individuel",
                        statut,
                        _ep_parse_date(payload.date_prevue, "date_prevue"),
                        _ep_parse_date(payload.date_realisee, "date_realisee"),
                        _ep_parse_date(payload.periode_debut, "periode_debut"),
                        _ep_parse_date(payload.periode_fin, "periode_fin"),
                        json.dumps(_ep_payload_preparation(payload), ensure_ascii=False),
                        json.dumps(_ep_payload_realisation(payload), ensure_ascii=False),
                        json.dumps(_ep_payload_competences(payload), ensure_ascii=False),
                        json.dumps(payload.documents or {}, ensure_ascii=False),
                        json.dumps(payload.synthese or {}, ensure_ascii=False),

                        # Compat ancienne structure
                        json.dumps(payload.bilan or {}, ensure_ascii=False),
                        json.dumps(payload.objectifs or {}, ensure_ascii=False),
                        json.dumps(payload.developpement or {}, ensure_ascii=False),
                        json.dumps(payload.plan_actions or {}, ensure_ascii=False),
                        id_entretien,
                        id_ent,
                    ),
                )

                row = cur.fetchone()
                conn.commit()

                return _ep_entretien_item_from_row(row)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}/archive",
)
def ep_archive_entretien_individuel(
    id_contact: str,
    id_entretien: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    UPDATE public.tbl_entretien_individuel
                    SET archive = TRUE,
                        updated_at = NOW()
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_entretien
                    """,
                    (id_entretien, id_ent),
                )

                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")

                conn.commit()

                return {"ok": True, "id_entretien": id_entretien}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/entretien-performance/catalogue-competences/{id_contact}",
    response_model=List[CatalogueCompetenceItem],
)
def ep_catalogue_competences(
    id_contact: str,
    request: Request,
    q: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _resolve_id_ent_for_request(cur, id_contact, request)

                where_sql = [
                    "COALESCE(c.masque, FALSE) = FALSE",
                    "COALESCE(c.etat, 'valide') <> 'inactive'",
                ]
                params: List[Any] = []

                if q and q.strip():
                    like = f"%{q.strip()}%"
                    where_sql.append("(COALESCE(c.code,'') ILIKE %s OR COALESCE(c.intitule,'') ILIKE %s)")
                    params.extend([like, like])

                cur.execute(
                    f"""
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        COALESCE(NULLIF(TRIM(dc.titre_court), ''), NULLIF(TRIM(c.domaine), ''), 'Sans domaine') AS domaine,
                        dc.couleur::text AS domaine_couleur
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                    WHERE {" AND ".join(where_sql)}
                    ORDER BY c.code, c.intitule
                    LIMIT %s
                    """,
                    tuple([*params, limit]),
                )

                rows = cur.fetchall() or []

                return [
                    CatalogueCompetenceItem(
                        id_comp=r["id_comp"],
                        code=r.get("code"),
                        intitule=r.get("intitule") or "",
                        domaine=r.get("domaine"),
                        domaine_couleur=r.get("domaine_couleur"),
                    )
                    for r in rows
                ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/entretien-performance/effectif-competence/{id_contact}/{id_effectif}",
)
def ep_ensure_effectif_competence(
    id_contact: str,
    id_effectif: str,
    payload: EnsureEffectifCompetencePayload,
    request: Request,
):
    try:
        id_comp = (payload.id_comp or "").strip()
        if not id_comp:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                _fetch_effectif_context(cur, id_ent, id_effectif)

                cur.execute(
                    """
                    SELECT id_effectif_competence
                    FROM public.tbl_effectif_client_competence
                    WHERE id_effectif_client = %s
                      AND id_comp = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_effectif, id_comp),
                )

                row = cur.fetchone()
                if row:
                    return {"id_effectif_competence": row["id_effectif_competence"]}

                id_effectif_competence = str(uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_competence
                    (
                        id_effectif_competence,
                        id_effectif_client,
                        id_comp,
                        niveau_actuel,
                        id_dernier_audit,
                        actif,
                        archive,
                        date_derniere_eval
                    )
                    VALUES (%s, %s, %s, NULL, NULL, TRUE, FALSE, NULL)
                    """,
                    (id_effectif_competence, id_effectif, id_comp),
                )

                conn.commit()

                return {"id_effectif_competence": id_effectif_competence}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.post(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}/document",
)
def ep_upload_entretien_document(
    id_contact: str,
    id_entretien: str,
    request: Request,
    type_document: str = Form(default="document_entretien"),
    file: UploadFile = File(...),
):
    try:
        if not file:
            raise HTTPException(status_code=400, detail="Fichier manquant.")

        content = file.file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Fichier vide.")

        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Fichier trop volumineux. Limite : 10 Mo.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT id_entretien
                    FROM public.tbl_entretien_individuel
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (id_entretien, id_ent),
                )

                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")

                id_document = str(uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_entretien_individuel_document
                    (
                        id_document,
                        id_entretien,
                        id_ent,
                        type_document,
                        nom_fichier,
                        mime_type,
                        taille_octets,
                        fichier,
                        archive,
                        created_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW())
                    """,
                    (
                        id_document,
                        id_entretien,
                        id_ent,
                        (type_document or "document_entretien").strip() or "document_entretien",
                        file.filename or "document",
                        file.content_type,
                        len(content),
                        content,
                    ),
                )

                conn.commit()

                return {
                    "ok": True,
                    "id_document": id_document,
                    "nom_fichier": file.filename,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}/documents",
)
def ep_list_entretien_documents(
    id_contact: str,
    id_entretien: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                        id_document,
                        type_document,
                        nom_fichier,
                        mime_type,
                        taille_octets,
                        created_at
                    FROM public.tbl_entretien_individuel_document
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY created_at DESC
                    """,
                    (id_entretien, id_ent),
                )

                rows = cur.fetchall() or []
                return [
                    {
                        "id_document": r.get("id_document"),
                        "type_document": r.get("type_document"),
                        "nom_fichier": r.get("nom_fichier"),
                        "mime_type": r.get("mime_type"),
                        "taille_octets": r.get("taille_octets"),
                        "created_at": str(r["created_at"]) if r.get("created_at") else None,
                    }
                    for r in rows
                ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/entretien-performance/entretien/{id_contact}/{id_entretien}/rapport-pdf",
)
def ep_entretien_individuel_pdf(
    id_contact: str,
    id_entretien: str,
    request: Request,
):
    """
    Rapport PDF simple d'un entretien individuel.
    Version socle : synthèse lisible + blocs RH + plan d'action.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                        ei.*,
                        e.nom_effectif,
                        e.prenom_effectif,
                        fp.intitule_poste
                    FROM public.tbl_entretien_individuel ei
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ei.id_effectif_client
                     AND e.id_ent = ei.id_ent
                     AND COALESCE(e.archive, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = e.id_poste_actuel
                     AND fp.id_ent = e.id_ent
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE ei.id_entretien = %s
                      AND ei.id_ent = %s
                      AND COALESCE(ei.archive, FALSE) = FALSE
                    """,
                    (id_entretien, id_ent),
                )

                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")

                cur.execute(
                    """
                    SELECT
                        id_validation,
                        type_signataire,
                        nom_signataire,
                        prenom_signataire,
                        mode_validation,
                        signature_image,
                        date_validation
                    FROM public.tbl_validations_electroniques
                    WHERE type_document = 'entretien_individuel'
                      AND id_document_ref = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY
                        CASE lower(type_signataire)
                            WHEN 'evaluateur' THEN 1
                            WHEN 'collaborateur' THEN 2
                            ELSE 9
                        END,
                        date_validation ASC
                    """,
                    (id_entretien, id_ent),
                )
                validation_rows = cur.fetchall() or []

                try:
                    from reportlab.lib.pagesizes import A4
                    from reportlab.pdfgen import canvas
                    from reportlab.lib.utils import ImageReader
                except Exception:
                    raise HTTPException(status_code=500, detail="Module PDF indisponible côté serveur.")

                buffer = BytesIO()
                pdf = canvas.Canvas(buffer, pagesize=A4)
                width, height = A4

                margin_x = 42
                y = height - 48
                line_h = 14

                def _clean(v):
                    return (v or "").toString().strip() if hasattr(v, "toString") else str(v or "").strip()

                def _section(title):
                    nonlocal y
                    if y < 90:
                        pdf.showPage()
                        y = height - 48

                    pdf.setFont("Helvetica-Bold", 12)
                    pdf.drawString(margin_x, y, title)
                    y -= 16
                    pdf.setFont("Helvetica", 9)

                def _lines(text, max_chars=95):
                    raw = str(text or "").replace("\r", "\n")
                    out = []

                    for part in raw.split("\n"):
                        s = part.strip()
                        if not s:
                            out.append("")
                            continue

                        while len(s) > max_chars:
                            cut = s.rfind(" ", 0, max_chars)
                            if cut <= 0:
                                cut = max_chars
                            out.append(s[:cut].strip())
                            s = s[cut:].strip()

                        out.append(s)

                    return out

                def _write_text(text):
                    nonlocal y
                    pdf.setFont("Helvetica", 9)

                    for line in _lines(text):
                        if y < 55:
                            pdf.showPage()
                            y = height - 48
                            pdf.setFont("Helvetica", 9)

                        pdf.drawString(margin_x, y, line)
                        y -= line_h

                    y -= 4

                def _write_dict(data):
                    if not isinstance(data, dict):
                        _write_text("")
                        return

                    for k, v in data.items():
                        label = str(k).replace("_", " ").strip().capitalize()
                        value = str(v or "").strip()
                        if not value:
                            continue

                        _write_text(f"{label} : {value}")

                def _write_validation_signature(vrow):
                    nonlocal y

                    if y < 125:
                        pdf.showPage()
                        y = height - 48

                    role = (vrow.get("type_signataire") or "signataire").strip().capitalize()
                    signataire = " ".join([
                        (vrow.get("prenom_signataire") or "").strip(),
                        (vrow.get("nom_signataire") or "").strip(),
                    ]).strip() or "—"
                    signed_at = str(vrow.get("date_validation") or "—")
                    ident = str(vrow.get("id_validation") or "—")

                    pdf.setFont("Helvetica-Bold", 9)
                    pdf.drawString(margin_x, y, f"{role} : {signataire}")
                    y -= 12
                    pdf.setFont("Helvetica", 8)
                    pdf.drawString(margin_x, y, f"Validation électronique : {signed_at} — Identifiant : {ident}")
                    y -= 10

                    raw_img = str(vrow.get("signature_image") or "").strip()
                    try:
                        if raw_img.startswith("data:image/png;base64,"):
                            raw_img = raw_img.split(",", 1)[1].strip()
                        img_bytes = base64.b64decode(raw_img, validate=True)
                        img = ImageReader(BytesIO(img_bytes))
                        pdf.drawImage(img, margin_x, y - 45, width=170, height=45, preserveAspectRatio=True, mask='auto')
                        y -= 55
                    except Exception:
                        pdf.setFont("Helvetica-Oblique", 8)
                        pdf.drawString(margin_x, y, "Signature image indisponible")
                        y -= 14

                    y -= 6

                nom = " ".join(
                    [
                        (row.get("prenom_effectif") or "").strip(),
                        (row.get("nom_effectif") or "").strip(),
                    ]
                ).strip()

                pdf.setFont("Helvetica-Bold", 16)
                pdf.drawString(margin_x, y, "Entretien individuel")
                y -= 20

                pdf.setFont("Helvetica", 10)
                _write_text(f"Collaborateur : {nom or '—'}")
                _write_text(f"Poste : {(row.get('intitule_poste') or '—')}")
                _write_text(f"Type : {(row.get('type_entretien') or 'Entretien individuel')}")
                _write_text(f"Statut : {(row.get('statut') or 'brouillon')}")
                _write_text(f"Date prévue : {str(row.get('date_prevue') or '—')}")
                _write_text(f"Date réalisée : {str(row.get('date_realisee') or '—')}")

                _section("Bilan")
                _write_dict(_ep_json_dict(row.get("bilan")))

                _section("Objectifs")
                _write_dict(_ep_json_dict(row.get("objectifs")))

                _section("Développement")
                _write_dict(_ep_json_dict(row.get("developpement")))

                _section("Plan d'action")
                _write_dict(_ep_json_dict(row.get("plan_actions")))

                _section("Documents")
                _write_dict(_ep_json_dict(row.get("documents")))

                _section("Synthèse")
                _write_dict(_ep_json_dict(row.get("synthese")))

                _section("Validations électroniques")
                if validation_rows:
                    for vrow in validation_rows:
                        _write_validation_signature(vrow)
                else:
                    _write_text("Aucune validation électronique enregistrée.")

                pdf.save()

                content = buffer.getvalue()
                buffer.close()

                filename = f"entretien_individuel_{id_entretien}.pdf"

                return Response(
                    content=content,
                    media_type="application/pdf",
                    headers={
                        "Content-Disposition": f'inline; filename="{filename}"'
                    },
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
    
# ======================================================
# Endpoints Save Audit
# ======================================================
@router.post(
    "/skills/entretien-performance/audit/{id_contact}",
    response_model=AuditSaveResponse,
)
def save_entretien_competence_audit(id_contact: str, payload: AuditSavePayload, request: Request):
    """
    Enregistre un audit compétence (tbl_effectif_client_audit_competence)
    + met à jour le niveau actuel (tbl_effectif_client_competence).
    """
    try:
        # validations simples (front fait déjà le gros du job)
        niveau_ok = payload.niveau_actuel in ["Initial", "Avancé", "Expert"]
        if not niveau_ok:
            raise HTTPException(status_code=400, detail="niveau_actuel invalide (Initial/Avancé/Expert attendu).")

        if not payload.criteres or len(payload.criteres) > 4:
            raise HTTPException(status_code=400, detail="Liste de critères invalide.")

        for c in payload.criteres:
            if c.niveau < 1 or c.niveau > 4:
                raise HTTPException(status_code=400, detail="Note critère invalide (1..4).")
            if c.code_critere not in ["Critere1", "Critere2", "Critere3", "Critere4"]:
                raise HTTPException(status_code=400, detail="code_critere invalide (Critere1..4).")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # Vérifie appartenance entreprise + actif/non archivé
                cur.execute(
                    """
                    SELECT
                        ec.id_effectif_competence,
                        ec.id_effectif_client,
                        ec.id_comp
                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE ec.id_effectif_competence = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND e.id_ent = %s
                    """,
                    (payload.id_effectif_competence, id_ent),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Ligne compétence salarié introuvable (ou hors périmètre).")

                if payload.id_comp and payload.id_comp != row.get("id_comp"):
                    raise HTTPException(status_code=400, detail="id_comp ne correspond pas à la ligne effectif_competence.")
                

                
                id_entretien_individuel = (payload.id_entretien_individuel or "").strip() or None
                role_competence_entretien = (payload.role_competence_entretien or "").strip() or None

                if id_entretien_individuel:
                    cur.execute(
                        """
                        SELECT id_entretien
                        FROM public.tbl_entretien_individuel
                        WHERE id_entretien = %s
                          AND id_ent = %s
                          AND id_effectif_client = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        """,
                        (
                            id_entretien_individuel,
                            id_ent,
                            row.get("id_effectif_client"),
                        ),
                    )

                    if cur.fetchone() is None:
                        raise HTTPException(
                            status_code=400,
                            detail="L'entretien individuel sélectionné ne correspond pas au collaborateur.",
                        )

                    if cur.fetchone() is None:
                        raise HTTPException(
                            status_code=400,
                            detail="L'entretien individuel sélectionné est introuvable ou ne correspond pas au collaborateur.",
                        )

                id_audit = str(uuid4())
                today = date.today()

                # Evaluateur = effectif (celui qui est connecté)
                cur.execute(
                    """
                    SELECT
                        ec.nom_effectif,
                        ec.prenom_effectif
                    FROM public.tbl_effectif_client ec
                    WHERE ec.id_effectif = %s
                    AND COALESCE(ec.archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_contact,),
                )
                ev = cur.fetchone() or {}
                nom_eval = " ".join(
                    [x for x in [(ev.get("prenom_effectif") or "").strip(), (ev.get("nom_effectif") or "").strip()] if x]
                ).strip() or None


                detail_eval = {
                    "criteres": [
                        {
                            "niveau": int(c.niveau),
                            "code_critere": c.code_critere,
                            **({"commentaire": (c.commentaire or "").strip()} if (c.commentaire or "").strip() else {}),
                        }
                        for c in payload.criteres
                    ]
                }

                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_audit_competence
                    (
                        id_audit_competence,
                        id_effectif_competence,
                        date_audit,
                        id_evaluateur,
                        methode_eval,
                        resultat_eval,
                        detail_eval,
                        observation,
                        id_entretien_individuel,
                        role_competence_entretien,
                        nametable_evaluateur,
                        nom_evaluateur
                    )
                    VALUES
                    (
                        %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s,
                        %s, %s,
                        %s, %s
                    )
                    """,
                    (
                        id_audit,
                        payload.id_effectif_competence,
                        today,
                        id_contact,
                        payload.methode_eval,
                        round(float(payload.resultat_eval), 1),
                        json.dumps(detail_eval, ensure_ascii=False),
                        (payload.observation or None),
                        id_entretien_individuel,
                        role_competence_entretien,
                        "tbl_effectif_client",
                        nom_eval,
                    ),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_competence
                    SET
                        niveau_actuel = %s,
                        date_derniere_eval = %s,
                        id_dernier_audit = %s
                    WHERE id_effectif_competence = %s
                    """,
                    (
                        payload.niveau_actuel,
                        today,
                        id_audit,
                        payload.id_effectif_competence,
                    ),
                )

                conn.commit()

                return AuditSaveResponse(
                    id_audit_competence=id_audit,
                    date_audit=str(today),
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.put(
    "/skills/entretien-performance/audit/{id_contact}/{id_audit_competence}",
    response_model=AuditSaveResponse,
)
def update_entretien_competence_audit(
    id_contact: str,
    id_audit_competence: str,
    payload: AuditSavePayload,
    request: Request,
):
    """
    Modifie un audit compétence existant.

    Règles :
    - seul l'évaluateur d'origine peut modifier son audit ;
    - aucune nouvelle ligne d'audit n'est créée ;
    - si l'audit modifié est le dernier audit actif de la ligne compétence,
      le niveau actuel du collaborateur est remis à jour.
    """
    try:
        niveau_ok = payload.niveau_actuel in ["Initial", "Avancé", "Expert"]
        if not niveau_ok:
            raise HTTPException(status_code=400, detail="niveau_actuel invalide (Initial/Avancé/Expert attendu).")

        if not payload.criteres or len(payload.criteres) > 4:
            raise HTTPException(status_code=400, detail="Liste de critères invalide.")

        for c in payload.criteres:
            if c.niveau < 1 or c.niveau > 4:
                raise HTTPException(status_code=400, detail="Note critère invalide (1..4).")
            if c.code_critere not in ["Critere1", "Critere2", "Critere3", "Critere4"]:
                raise HTTPException(status_code=400, detail="code_critere invalide (Critere1..4).")

        id_audit = (id_audit_competence or "").strip()
        if not id_audit:
            raise HTTPException(status_code=400, detail="id_audit_competence manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                        a.id_audit_competence,
                        a.id_effectif_competence,
                        a.date_audit,
                        a.id_evaluateur,
                        ec.id_effectif_client,
                        ec.id_comp,
                        ec.id_dernier_audit
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE a.id_audit_competence = %s
                      AND e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                    """,
                    (id_audit, id_ent),
                )

                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="Audit compétence introuvable ou hors périmètre.")

                if str(row.get("id_evaluateur") or "").strip() != str(id_contact or "").strip():
                    raise HTTPException(status_code=403, detail="Seul l'évaluateur d'origine peut modifier cet audit.")

                if payload.id_effectif_competence and payload.id_effectif_competence != row.get("id_effectif_competence"):
                    raise HTTPException(status_code=400, detail="id_effectif_competence ne correspond pas à l'audit.")

                if payload.id_comp and payload.id_comp != row.get("id_comp"):
                    raise HTTPException(status_code=400, detail="id_comp ne correspond pas à l'audit.")

                detail_eval = {
                    "criteres": [
                        {
                            "niveau": int(c.niveau),
                            "code_critere": c.code_critere,
                            **({"commentaire": (c.commentaire or "").strip()} if (c.commentaire or "").strip() else {}),
                        }
                        for c in payload.criteres
                    ]
                }

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_audit_competence
                    SET
                        methode_eval = %s,
                        resultat_eval = %s,
                        detail_eval = %s::jsonb,
                        observation = %s
                    WHERE id_audit_competence = %s
                    """,
                    (
                        payload.methode_eval,
                        round(float(payload.resultat_eval), 1),
                        json.dumps(detail_eval, ensure_ascii=False),
                        (payload.observation or None),
                        id_audit,
                    ),
                )

                if str(row.get("id_dernier_audit") or "").strip() == id_audit:
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client_competence
                        SET
                            niveau_actuel = %s,
                            date_derniere_eval = %s
                        WHERE id_effectif_competence = %s
                        """,
                        (
                            payload.niveau_actuel,
                            row.get("date_audit"),
                            row.get("id_effectif_competence"),
                        ),
                    )

                conn.commit()

                return AuditSaveResponse(
                    id_audit_competence=id_audit,
                    date_audit=str(row["date_audit"]) if row.get("date_audit") else str(date.today()),
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Historique (audits compétences par collaborateur)
# ======================================================

@router.get(
    "/skills/entretien-performance/historique/{id_contact}/{id_effectif_client}",
    response_model=List[AuditHistoryItem],
)
def get_entretien_performance_historique(id_contact: str, id_effectif_client: str, request: Request):
    """
    Retourne l'historique des audits compétences d'un collaborateur (derniers en premier).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # Sécurité périmètre entreprise
                cur.execute(
                    """
                    SELECT e.id_effectif
                    FROM public.tbl_effectif_client e
                    WHERE e.id_effectif = %s
                      AND e.id_ent = %s
                      AND e.archive = FALSE
                    """,
                    (id_effectif_client, id_ent),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable (ou archivé).")

                cur.execute(
                    """
                    SELECT
                        a.id_audit_competence,
                        a.id_effectif_competence,
                        a.date_audit,
                        a.id_evaluateur,
                        a.nom_evaluateur,
                        a.methode_eval,
                        a.resultat_eval,
                        a.detail_eval,
                        a.observation,

                        c.id_comp,
                        c.code,
                        c.intitule
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                    WHERE ec.id_effectif_client = %s
                      AND ec.archive = FALSE
                      AND ec.actif = TRUE
                    ORDER BY a.date_audit DESC
                    LIMIT 200
                    """,
                    (id_effectif_client,),
                )

                rows = cur.fetchall() or []
                out: List[AuditHistoryItem] = []

                for r in rows:
                    detail_eval = r.get("detail_eval")

                    if isinstance(detail_eval, str):
                        try:
                            detail_eval = json.loads(detail_eval)
                        except Exception:
                            detail_eval = None

                    if not isinstance(detail_eval, dict):
                        detail_eval = None

                    out.append(
                        AuditHistoryItem(
                            id_audit_competence=r.get("id_audit_competence"),
                            id_effectif_competence=r.get("id_effectif_competence"),
                            date_audit=str(r["date_audit"]) if r.get("date_audit") else None,
                            id_evaluateur=r.get("id_evaluateur"),
                            nom_evaluateur=r.get("nom_evaluateur"),
                            methode_eval=r.get("methode_eval"),
                            resultat_eval=float(r["resultat_eval"]) if r.get("resultat_eval") is not None else None,
                            detail_eval=detail_eval,
                            observation=r.get("observation"),
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            modifiable=(
                                str(r.get("id_evaluateur") or "").strip()
                                == str(id_contact or "").strip()
                            ),
                        )
                    )

                return out

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
    

# ======================================================
# Couverture poste actuel (jauge)
# - plain : sans pondération
# - weighted : pondéré par criticité (poids normalisés)
# Limites jauge: min = nb_comp * 6, max = nb_comp * 24
# ======================================================

@router.get(
    "/skills/entretien-performance/couverture-poste-actuel/{id_contact}/{id_effectif}",
    response_model=CouverturePosteResponse,
)
def ep_get_couverture_poste_actuel(
    id_contact: str,
    id_effectif: str,
    request: Request,
    criticite_min: float = Query(default=0.0, ge=0.0, le=100.0),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # Sécurité + périmètre entreprise via contact
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                # Contexte effectif (inclut poste actuel + intitulé poste)
                eff = _fetch_effectif_context(cur, id_ent, id_effectif)

                id_poste = (eff.get("id_poste_actuel") or "").strip()
                intitule_poste = (eff.get("intitule_poste") or "").strip() or None

                seuil_criticite = max(0.0, min(100.0, float(criticite_min or 0.0)))

                def _empty_variant(ponderer: bool = True):
                    return {
                        "ponderer": ponderer,
                        "gauge_min": 0.0,
                        "gauge_max": 100.0,
                        "expected_min": 0.0,
                        "expected_max": 100.0,
                        "score": 0.0,
                        "pct_attendus": 0.0,
                        "pct_max": 0.0,
                        "details": [],
                    }

                # Poste non renseigné -> réponse vide mais propre
                if not id_poste:
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": None,
                        "intitule_poste": None,
                        "nb_competences": 0,
                        "plain": _empty_variant(False),
                        "weighted": _empty_variant(True),
                        "message": "Poste actuel non renseigné pour ce collaborateur.",
                    }

                # Cible de maîtrise = borne haute continue du niveau attendu.
                # A: [6 ; 10[  => 100% à 10
                # B: [10 ; 19[ => 100% à 19
                # C: [19 ; 24] => 100% à 24
                def _target_lvl(niv: str) -> float:
                    n = (niv or "").strip().upper()
                    if n == "A":
                        return 10.0
                    if n == "B":
                        return 19.0
                    if n == "C":
                        return 24.0
                    return 24.0

                def _crit_pct(v) -> float:
                    try:
                        x = float(v)
                    except Exception:
                        return 1.0

                    if x <= 0:
                        return 1.0
                    if x <= 1.0:
                        return x * 100.0
                    return x

                def _safe_score(v) -> float:
                    try:
                        x = float(v)
                    except Exception:
                        return 0.0
                    return max(0.0, x)

                def _attainment(score: float, target: float) -> float:
                    if target <= 0:
                        return 0.0
                    return max(0.0, min(float(score) / float(target), 1.0))

                # --- attendus poste + score salarié (dernier audit via id_dernier_audit) ---
                cur.execute(
                    """
                    SELECT
                        fp.id_competence     AS id_comp,
                        fp.niveau_requis     AS niveau_requis,
                        COALESCE(NULLIF(fp.poids_criticite,0),1) AS poids_criticite,
                        c.code              AS code,
                        c.intitule          AS intitule,
                        a.resultat_eval     AS resultat_eval,
                        a.date_audit        AS date_audit,
                        a.methode_eval      AS methode_eval
                    FROM public.tbl_fiche_poste_competence fp
                    JOIN public.tbl_competence c
                      ON c.id_comp = fp.id_competence
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'valide') <> 'inactive'
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_client = %s
                     AND ec.id_comp = fp.id_competence
                     AND ec.actif = TRUE
                     AND ec.archive = FALSE
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = ec.id_dernier_audit
                    WHERE fp.id_poste = %s
                    ORDER BY c.code
                    """,
                    (id_effectif, id_poste),
                )
                rows = cur.fetchall() or []

                details: List[Dict[str, Any]] = []
                weighted_sum = 0.0
                weight_total = 0.0

                for r in rows:
                    id_comp = (r.get("id_comp") or "").strip()
                    if not id_comp:
                        continue

                    crit_pct = _crit_pct(r.get("poids_criticite"))

                    # Le seuil de criticité filtre le périmètre de calcul.
                    if crit_pct + 0.0001 < seuil_criticite:
                        continue

                    score = _safe_score(r.get("resultat_eval"))
                    target = _target_lvl(r.get("niveau_requis"))
                    attainment = _attainment(score, target)

                    # La criticité du poste pondère toujours le calcul.
                    weight = max(crit_pct, 1.0)
                    weighted_sum += weight * attainment
                    weight_total += weight

                    details.append(
                        {
                            "id_comp": id_comp,
                            "code": (r.get("code") or "").strip(),
                            "intitule": (r.get("intitule") or "").strip(),
                            "niveau_requis": (r.get("niveau_requis") or "").strip(),
                            "poids_criticite": int(round(crit_pct)),
                            "score": round(score, 1),
                            "date_audit": str(r["date_audit"]) if r.get("date_audit") else None,
                            "methode_eval": r.get("methode_eval"),
                        }
                    )

                n = len(details)

                if n == 0:
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": id_poste,
                        "intitule_poste": intitule_poste,
                        "nb_competences": 0,
                        "plain": _empty_variant(False),
                        "weighted": _empty_variant(True),
                        "message": "Aucune compétence attendue n'est retenue avec le seuil de criticité défini.",
                    }

                maitrise_pct = 0.0
                if weight_total > 0:
                    maitrise_pct = max(0.0, min(100.0, (weighted_sum / weight_total) * 100.0))

                variant_weighted = {
                    "ponderer": True,
                    "gauge_min": 0.0,
                    "gauge_max": 100.0,
                    "expected_min": 0.0,
                    "expected_max": 100.0,
                    "score": round(maitrise_pct, 1),
                    "pct_attendus": round(maitrise_pct, 1),
                    "pct_max": round(maitrise_pct, 1),
                    "details": details,
                }

                # Compat front : on renvoie la même lecture dans plain et weighted.
                # La criticité est désormais toujours prise en compte ; le seuil filtre le périmètre.
                variant_plain = {**variant_weighted, "ponderer": False}

                return {
                    "id_effectif": id_effectif,
                    "id_poste": id_poste,
                    "intitule_poste": intitule_poste,
                    "nb_competences": n,
                    "plain": variant_plain,
                    "weighted": variant_weighted,
                    "message": None,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
