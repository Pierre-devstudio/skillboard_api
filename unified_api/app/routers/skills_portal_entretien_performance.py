# unified_api/app/routers/skills_portal_entretien_performance.py

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from uuid import uuid4
from datetime import date
import json

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_context,
    skills_require_user,
    skills_validate_enterprise,
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
                        COALESCE(NULLIF(TRIM(c.domaine), ''), 'Sans domaine') AS domaine
                    FROM public.tbl_fiche_poste_competence fp
                    JOIN public.tbl_competence c
                      ON c.id_comp = fp.id_competence
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'valide') <> 'inactive'
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

                    expected[id_comp] = {
                        "id_comp": id_comp,
                        "code": (r.get("code") or "").strip(),
                        "intitule": (r.get("intitule") or "").strip(),
                        "domaine": (r.get("domaine") or "Sans domaine").strip(),
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

                        dom = meta["domaine"] or "Sans domaine"
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

                domaines_out = []
                for dom, pts in sorted(domain_points.items(), key=lambda kv: kv[0].lower()):
                    if not pts:
                        continue

                    domaines_out.append(
                        {
                            "id": dom,
                            "label": dom,
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
    """
    Résolution entreprise:
    - Si header X-Ent-Id présent => mode super-admin (Supabase auth obligatoire)
    - Sinon => legacy via resolve_insights_context (id_contact = id_effectif)
    """
    x_ent = ""
    try:
        x_ent = (request.headers.get("X-Ent-Id") or "").strip()
    except Exception:
        x_ent = ""

    if x_ent:
        auth = ""
        try:
            auth = request.headers.get("Authorization", "")
        except Exception:
            auth = ""

        u = skills_require_user(auth)
        if not u.get("is_super_admin"):
            raise HTTPException(status_code=403, detail="Accès refusé (X-Ent-Id réservé super-admin).")

        ent = skills_validate_enterprise(cur, x_ent)
        return ent.get("id_ent")

    ctx = resolve_insights_context(cur, id_contact)  # legacy
    return ctx["id_ent"]

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
                      AND ec.actif = TRUE
                      AND ec.archive = FALSE
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
                      AND ec.actif = TRUE
                      AND ec.archive = FALSE
                      AND e.archive = FALSE
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
                        nametable_evaluateur,
                        nom_evaluateur
                    )
                    VALUES
                    (
                        %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s,
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
