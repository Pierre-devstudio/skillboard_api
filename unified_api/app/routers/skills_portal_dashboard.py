from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn, fetch_contact_with_entreprise

router = APIRouter()


class SkillsContext(BaseModel):
    id_contact: str
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: str


@router.get(
    "/skills/context/{id_contact}",
    response_model=SkillsContext,
)
def get_skills_context(id_contact: str):
    """
    Contexte minimal pour le dashboard / topbar :
    id_contact, civilité, prénom, nom.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, _ = fetch_contact_with_entreprise(cur, id_contact)

        return SkillsContext(
            id_contact=row_contact["id_contact"],
            civilite=row_contact.get("civ_ca"),
            prenom=row_contact.get("prenom_ca"),
            nom=row_contact["nom_ca"],
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
