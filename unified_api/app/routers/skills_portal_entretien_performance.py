# unified_api/app/routers/skills_portal_entretien_performance.py

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from uuid import uuid4
from datetime import date
import json

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn


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
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict[str, Any]:
    # Aligné sur les autres routers Skills (mêmes champs, mêmes règles)
    cur.execute(
        """
        SELECT
            c.id_contact,
            c.code_ent,
            c.civ_ca,
            c.prenom_ca,
            c.nom_ca
        FROM public.tbl_contact c
        WHERE c.id_contact = %s
          AND COALESCE(c.masque, FALSE) = FALSE
        """,
        (id_contact,),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    if not row.get("code_ent"):
        raise HTTPException(status_code=400, detail="Contact sans code_ent associé.")
    return row

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
def get_entretien_performance_bootstrap(id_contact: str):
    """
    Squelette: retourne les infos contact/entreprise + configuration de scoring.
    (Pas encore de contenu métier: effectifs, compétences, audits, etc.)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact_row = _fetch_contact_and_ent(cur, id_contact)

                return EntretienPerformanceBootstrapResponse(
                    contact=ContactEntInfo(
                        id_contact=contact_row["id_contact"],
                        code_ent=contact_row["code_ent"],
                        civ_ca=contact_row.get("civ_ca"),
                        prenom_ca=contact_row.get("prenom_ca"),
                        nom_ca=contact_row.get("nom_ca"),
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
    id_service: str,
    q: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact_row = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact_row["code_ent"]

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
                    SELECT
                        e.id_effectif,
                        e.nom_effectif,
                        e.prenom_effectif,
                        e.code_effectif,
                        e.id_service,
                        o.nom_service,
                        e.id_poste_actuel,
                        fp.intitule_poste,
                        e.ismanager
                    FROM public.tbl_effectif_client e
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_service = e.id_service
                    LEFT JOIN public.tbl_fiche_poste fp
                        ON fp.id_poste = e.id_poste_actuel
                       AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE {where_sql}
                    ORDER BY e.nom_effectif, e.prenom_effectif
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
def get_effectif_checklist(id_contact: str, id_effectif: str):
    """
    Contexte réel du collaborateur + checklist des compétences (niveau actuel, date dernière eval).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact_row = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact_row["code_ent"]

                eff = _fetch_effectif_context(cur, id_ent, id_effectif)
                id_poste = eff.get("id_poste_actuel")

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
                            ELSE COALESCE(NULLIF(fp.poids_criticite,0),1)
                        END AS poids_criticite,

                        CASE
                            WHEN fp.id_competence IS NULL THEN 0.0
                            WHEN pt.total_weight IS NULL OR pt.total_weight <= 0 THEN 0.0
                            ELSE ROUND(
                                ((COALESCE(NULLIF(fp.poids_criticite,0),1)::float / pt.total_weight) * 100.0)::numeric,
                                2
                            )::float
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
def save_entretien_competence_audit(id_contact: str, payload: AuditSavePayload):
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
                contact_row = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact_row["code_ent"]

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

                civ = (contact_row.get("civ_ca") or "").strip()
                prenom = (contact_row.get("prenom_ca") or "").strip()
                nom = (contact_row.get("nom_ca") or "").strip()
                nom_eval = " ".join([x for x in [civ, prenom, nom] if x]).strip() or None

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
                        "tbl_contact",
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
def get_entretien_performance_historique(id_contact: str, id_effectif_client: str):
    """
    Retourne l'historique des audits compétences d'un collaborateur (derniers en premier).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

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
                        a.date_audit,
                        a.id_evaluateur,
                        a.nom_evaluateur,
                        a.methode_eval,
                        a.resultat_eval,
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
                    out.append(
                        AuditHistoryItem(
                            date_audit=str(r["date_audit"]) if r.get("date_audit") else None,
                            id_evaluateur=r.get("id_evaluateur"),
                            nom_evaluateur=r.get("nom_evaluateur"),
                            methode_eval=r.get("methode_eval"),
                            resultat_eval=float(r["resultat_eval"]) if r.get("resultat_eval") is not None else None,
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
def ep_get_couverture_poste_actuel(id_contact: str, id_effectif: str):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # Sécurité + périmètre entreprise via contact
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                # Contexte effectif (inclut poste actuel + intitulé poste)
                eff = _fetch_effectif_context(cur, id_ent, id_effectif)

                id_poste = (eff.get("id_poste_actuel") or "").strip()
                intitule_poste = (eff.get("intitule_poste") or "").strip() or None

                # Poste non renseigné -> réponse vide mais propre
                if not id_poste:
                    empty_variant = {
                        "ponderer": False,
                        "gauge_min": 0.0,
                        "gauge_max": 0.0,
                        "expected_min": 0.0,
                        "expected_max": 0.0,
                        "score": 0.0,
                        "pct_attendus": 0.0,
                        "pct_max": 0.0,
                        "details": [],
                    }
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": None,
                        "intitule_poste": None,
                        "nb_competences": 0,
                        "plain": {**empty_variant, "ponderer": False},
                        "weighted": {**empty_variant, "ponderer": True},
                        "message": "Poste actuel non renseigné pour ce collaborateur.",
                    }

                # --- mapping min/max attendus par niveau requis ---
                # A: [6 ; 10[
                # B: [10 ; 19[
                # C: [19 ; 24]
                def _range_lvl(niv: str):
                    n = (niv or "").strip().upper()
                    if n == "A":
                        return 6.0, 10.0
                    if n == "B":
                        return 10.0, 19.0
                    if n == "C":
                        return 19.0, 24.0
                    return 6.0, 24.0

                def _w(v):
                    try:
                        x = int(v)
                        return x if x > 0 else 1
                    except Exception:
                        return 1

                def _pct(num, den):
                    if den is None:
                        return 0.0
                    try:
                        denf = float(den)
                        if denf <= 0:
                            return 0.0
                        return (float(num) / denf) * 100.0
                    except Exception:
                        return 0.0

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

                details = []
                weights = []
                tmp = []

                n = 0
                sum_exp_min = 0.0
                sum_exp_max = 0.0
                sum_score = 0.0

                for r in rows:
                    id_comp = (r.get("id_comp") or "").strip()
                    if not id_comp:
                        continue

                    n += 1

                    w_raw = _w(r.get("poids_criticite"))
                    weights.append(w_raw)

                    try:
                        sc = float(r.get("resultat_eval")) if r.get("resultat_eval") is not None else 0.0
                    except Exception:
                        sc = 0.0

                    # compétence jamais évaluée = 0 (déjà géré par fallback)
                    exp_min, exp_max = _range_lvl(r.get("niveau_requis"))

                    sum_exp_min += exp_min
                    sum_exp_max += exp_max
                    sum_score += sc

                    details.append(
                        {
                            "id_comp": id_comp,
                            "code": (r.get("code") or "").strip(),
                            "intitule": (r.get("intitule") or "").strip(),
                            "niveau_requis": (r.get("niveau_requis") or "").strip(),
                            "poids_criticite": w_raw,
                            "score": round(sc, 1),
                            "date_audit": str(r["date_audit"]) if r.get("date_audit") else None,
                            "methode_eval": r.get("methode_eval"),
                        }
                    )

                    tmp.append((w_raw, exp_min, exp_max, sc))

                gauge_min = float(n) * 6.0
                gauge_max = float(n) * 24.0

                # Aucun attendu sur le poste
                if n == 0:
                    empty_variant = {
                        "ponderer": False,
                        "gauge_min": 0.0,
                        "gauge_max": 0.0,
                        "expected_min": 0.0,
                        "expected_max": 0.0,
                        "score": 0.0,
                        "pct_attendus": 0.0,
                        "pct_max": 0.0,
                        "details": [],
                    }
                    return {
                        "id_effectif": id_effectif,
                        "id_poste": id_poste,
                        "intitule_poste": intitule_poste,
                        "nb_competences": 0,
                        "plain": {**empty_variant, "ponderer": False},
                        "weighted": {**empty_variant, "ponderer": True},
                        "message": "Aucune compétence attendue n'est valorisée sur ce poste.",
                    }

                # --- weighted (normalisé) : somme(wn)=n pour garder gauge_min/max inchangés ---
                w_sum = float(sum(weights)) if weights else 0.0

                def _wnorm(wr: float):
                    if w_sum <= 0:
                        return 1.0
                    return (float(wr) * float(n)) / w_sum

                w_exp_min = 0.0
                w_exp_max = 0.0
                w_score = 0.0

                for w_raw, exp_min, exp_max, sc in tmp:
                    wn = _wnorm(w_raw)
                    w_exp_min += exp_min * wn
                    w_exp_max += exp_max * wn
                    w_score += sc * wn

                plain = {
                    "ponderer": False,
                    "gauge_min": round(gauge_min, 1),
                    "gauge_max": round(gauge_max, 1),
                    "expected_min": round(sum_exp_min, 1),
                    "expected_max": round(sum_exp_max, 1),
                    "score": round(sum_score, 1),
                    "pct_attendus": round(_pct(sum_score, sum_exp_max), 1),
                    "pct_max": round(_pct(sum_score, gauge_max), 1),
                    "details": details,
                }

                weighted = {
                    "ponderer": True,
                    "gauge_min": round(gauge_min, 1),
                    "gauge_max": round(gauge_max, 1),
                    "expected_min": round(w_exp_min, 1),
                    "expected_max": round(w_exp_max, 1),
                    "score": round(w_score, 1),
                    "pct_attendus": round(_pct(w_score, w_exp_max), 1),
                    "pct_max": round(_pct(w_score, gauge_max), 1),
                    "details": details,
                }

                return {
                    "id_effectif": id_effectif,
                    "id_poste": id_poste,
                    "intitule_poste": intitule_poste,
                    "nb_competences": n,
                    "plain": plain,
                    "weighted": weighted,
                    "message": None,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
