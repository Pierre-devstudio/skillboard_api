from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from psycopg.rows import dict_row

from app.routers.consultant_portal_common import get_conn, fetch_consultant_with_entreprise

router = APIRouter()


class ConsultantContext(BaseModel):
    id_consultant: str
    civilite: Optional[str] = None
    prenom: str
    nom: str


@router.get(
    "/consultant/context/{id_consultant}",
    response_model=ConsultantContext,
)
def get_consultant_context(id_consultant: str):
    """
    Contexte minimal pour le dashboard / topbar :
    id, civilité, prénom, nom.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row, _ = fetch_consultant_with_entreprise(cur, id_consultant)

        return ConsultantContext(
            id_consultant=row["id_consultant"],
            civilite=row.get("civilite"),
            prenom=row["prenom"],
            nom=row["nom"],
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
