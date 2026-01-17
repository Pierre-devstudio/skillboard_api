# unified_api/app/routers/skills_portal_entretien_performance.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn


router = APIRouter()


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
