from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import datetime

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class AnalyseRisquesTile(BaseModel):
    postes_fragiles: int = 0
    comp_critiques_sans_porteur: int = 0
    comp_bus_factor_1: int = 0


class AnalyseMatchingTile(BaseModel):
    postes_sans_candidat: int = 0
    candidats_prets: int = 0
    candidats_prets_6m: int = 0


class AnalysePrevisionsTile(BaseModel):
    sorties_12m: int = 0
    comp_critiques_impactees: int = 0
    postes_rouges_12m: int = 0


class AnalyseSummaryTiles(BaseModel):
    risques: AnalyseRisquesTile
    matching: AnalyseMatchingTile
    previsions: AnalysePrevisionsTile


class AnalyseSummaryResponse(BaseModel):
    scope: ServiceScope
    updated_at: str
    tiles: AnalyseSummaryTiles


# ======================================================
# Helpers
# ======================================================
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
            c.id_contact,
            c.code_ent
        FROM public.tbl_contact c
        WHERE c.id_contact = %s
          AND COALESCE(c.masque, FALSE) = FALSE
        """,
        (id_contact,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    if not row.get("code_ent"):
        raise HTTPException(status_code=404, detail="Entreprise introuvable pour ce contact.")
    return row


def _fetch_service_label(cur, id_ent: str, id_service: Optional[str]) -> ServiceScope:
    if not id_service:
        return ServiceScope(id_service=None, nom_service="Tous les services")

    if id_service == NON_LIE_ID:
        return ServiceScope(id_service=NON_LIE_ID, nom_service="Non liés (sans service)")

    cur.execute(
        """
        SELECT o.id_service, o.nom_service
        FROM public.tbl_entreprise_organigramme o
        WHERE o.id_ent = %s
          AND o.id_service = %s
          AND o.archive = FALSE
        """,
        (id_ent, id_service),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")

    return ServiceScope(
        id_service=row["id_service"],
        nom_service=row.get("nom_service") or "Service",
    )


# ======================================================
# Endpoint: Summary (tuiles)
# ======================================================
@router.get(
    "/skills/analyse/summary/{id_contact}",
    response_model=AnalyseSummaryResponse,
)
def get_analyse_summary(
    id_contact: str,
    id_service: Optional[str] = Query(default=None),
):
    """
    V1: summary des tuiles (Risques / Matching / Prévisions).
    - Sert à afficher des KPI "macro" dans l’écran Analyse des compétences.
    - On garde le contrat stable; les calculs viendront ensuite.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                # V1: valeurs par défaut (0) => UI propre, pas d’erreur, pas de “—”
                tiles = AnalyseSummaryTiles(
                    risques=AnalyseRisquesTile(
                        postes_fragiles=0,
                        comp_critiques_sans_porteur=0,
                        comp_bus_factor_1=0,
                    ),
                    matching=AnalyseMatchingTile(
                        postes_sans_candidat=0,
                        candidats_prets=0,
                        candidats_prets_6m=0,
                    ),
                    previsions=AnalysePrevisionsTile(
                        sorties_12m=0,
                        comp_critiques_impactees=0,
                        postes_rouges_12m=0,
                    ),
                )

                return AnalyseSummaryResponse(
                    scope=scope,
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    tiles=tiles,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
