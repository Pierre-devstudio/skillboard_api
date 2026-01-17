# unified_api/app/routers/skills_portal_entretien_performance.py

from fastapi import APIRouter, HTTPException, Query
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
    """
    Liste des collaborateurs (tbl_effectif_client) filtrée par service.
    - id_service = "__ALL__" => tous les services (dans l’état actuel, pas de contrôle de droits ici)
    - filtre entreprise via code_ent du contact
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                where_parts: List[str] = [
                    "e.id_ent = %s",
                    "e.archive = FALSE",
                    "e.statut_actif = TRUE",
                    "e.is_temp = FALSE",
                ]
                params: List[Any] = [id_ent]

                if id_service != ALL_SERVICES_ID:
                    where_parts.append("e.id_service = %s")
                    params.append(id_service)

                like = None
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

                        e.id_poste_actuel,
                        fp.codif_poste,
                        fp.intitule_poste,

                        e.id_service,
                        o.nom_service,

                        e.ismanager
                    FROM public.tbl_effectif_client e
                    LEFT JOIN public.tbl_fiche_poste fp
                        ON fp.id_poste = e.id_poste_actuel
                       AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_service = e.id_service
                       AND o.id_ent = %s
                       AND o.archive = FALSE
                    WHERE {where_sql}
                    ORDER BY e.nom_effectif, e.prenom_effectif
                    LIMIT %s
                    """,
                    tuple([*params, id_ent, limit]),
                )

                rows = cur.fetchall() or []
                return [
                    CollaborateurListItem(
                        id_effectif=r["id_effectif"],
                        nom_effectif=r.get("nom_effectif") or "",
                        prenom_effectif=r.get("prenom_effectif") or "",
                        code_effectif=r.get("code_effectif"),

                        id_poste_actuel=r.get("id_poste_actuel"),
                        codif_poste=r.get("codif_poste"),
                        intitule_poste=r.get("intitule_poste"),

                        id_service=r.get("id_service"),
                        nom_service=r.get("nom_service"),

                        ismanager=r.get("ismanager"),
                    )
                    for r in rows
                ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
