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

class DashboardBanner(BaseModel):
    titre: Optional[str] = None
    message: str = ""


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
    

@router.get(
    "/skills/dashboard/banner/{id_contact}",
    response_model=DashboardBanner,
)
def get_dashboard_banner(id_contact: str):
    """
    Bandeau d'information du dashboard.
    - Si aucun contenu => message vide (le front masque le bandeau)
    - Si tbl_publicite n'existe pas encore => message vide (squelette safe)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                # On tente de récupérer l'entreprise (selon ce que renvoie fetch_contact_with_entreprise)
                id_entreprise = None
                if isinstance(row_ent, dict):
                    id_entreprise = row_ent.get("id_entreprise")
                if not id_entreprise and isinstance(row_contact, dict):
                    id_entreprise = row_contact.get("id_entreprise")

                # Squelette: si pas d'entreprise => rien à afficher
                if not id_entreprise:
                    return DashboardBanner()

                # IMPORTANT: tant que tbl_publicite n'existe pas, on ne casse rien.
                try:
                    cur.execute(
                        """
                        SELECT
                            titre,
                            message
                        FROM tbl_publicite
                        WHERE archive = FALSE
                          AND (id_entreprise IS NULL OR id_entreprise = %s)
                          AND (date_debut IS NULL OR date_debut <= NOW())
                          AND (date_fin   IS NULL OR date_fin   >= NOW())
                        ORDER BY
                            COALESCE(ordre_affichage, 999999) ASC,
                            date_creation DESC NULLS LAST
                        LIMIT 1
                        """,
                        (id_entreprise,),
                    )
                    row = cur.fetchone()
                except Exception:
                    # table/colonnes pas prêtes => bandeau invisible
                    row = None

        if not row:
            return DashboardBanner()

        titre = (row.get("titre") or None)
        message = (row.get("message") or "")
        message = str(message).strip()

        # si vide => le front masque
        if not message:
            return DashboardBanner()

        return DashboardBanner(
            titre=str(titre).strip() if titre else None,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
