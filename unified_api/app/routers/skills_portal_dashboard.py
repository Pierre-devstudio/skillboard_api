from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

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

class AgePyramidBand(BaseModel):
    label: str
    femmes: int = 0
    hommes: int = 0


class AgePyramidResponse(BaseModel):
    bands: List[AgePyramidBand]
    total_actifs: int = 0
    unknown_birth: int = 0
    unknown_gender: int = 0


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
    

@router.get(
    "/skills/dashboard/age-pyramid/{id_contact}",
    response_model=AgePyramidResponse,
)
def get_dashboard_age_pyramid(id_contact: str):
    """
    Pyramide des âges (actifs uniquement).
    - Femmes (F) à gauche
    - Hommes (M) à droite
    - Tranches affichées du bas (<25) vers le haut (60+)
      => on renvoie dans l'ordre: 60+, 55-59, 45-54, 35-44, 25-34, <25
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                # fetch_contact_with_entreprise fournit id_ent (pas id_entreprise)
                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return AgePyramidResponse(bands=[])

                # Meta qualité de données
                cur.execute(
                    """
                    SELECT
                        COUNT(*)::int AS total_actifs,
                        SUM(CASE WHEN date_naissance_effectif IS NULL THEN 1 ELSE 0 END)::int AS unknown_birth,
                        SUM(
                            CASE
                                WHEN date_naissance_effectif IS NOT NULL
                                 AND (civilite_effectif IS NULL OR civilite_effectif NOT IN ('M','F'))
                                THEN 1 ELSE 0
                            END
                        )::int AS unknown_gender
                    FROM public.tbl_effectif_client
                    WHERE id_ent = %s
                      AND archive = FALSE
                      AND statut_actif = TRUE
                    """,
                    (id_ent,),
                )
                meta = cur.fetchone() or {}

                # Comptage par tranches
                cur.execute(
                    """
                    WITH base AS (
                        SELECT
                            civilite_effectif,
                            EXTRACT(YEAR FROM age(CURRENT_DATE, date_naissance_effectif))::int AS age
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                          AND archive = FALSE
                          AND statut_actif = TRUE
                          AND date_naissance_effectif IS NOT NULL
                    ),
                    binned AS (
                        SELECT
                            CASE
                                WHEN age < 25 THEN '<25'
                                WHEN age BETWEEN 25 AND 34 THEN '25-34'
                                WHEN age BETWEEN 35 AND 44 THEN '35-44'
                                WHEN age BETWEEN 45 AND 54 THEN '45-54'
                                WHEN age BETWEEN 55 AND 59 THEN '55-59'
                                ELSE '60+'
                            END AS tranche,
                            civilite_effectif
                        FROM base
                        WHERE age IS NOT NULL AND age >= 0
                    )
                    SELECT
                        tranche,
                        SUM(CASE WHEN civilite_effectif = 'F' THEN 1 ELSE 0 END)::int AS femmes,
                        SUM(CASE WHEN civilite_effectif = 'M' THEN 1 ELSE 0 END)::int AS hommes
                    FROM binned
                    GROUP BY tranche
                    """,
                    (id_ent,),
                )
                rows = cur.fetchall() or []

        # Normalisation + ordre d'affichage (haut -> bas)
        order = ["60+", "55-59", "45-54", "35-44", "25-34", "<25"]
        by_tranche = {k: {"femmes": 0, "hommes": 0} for k in order}

        for r in rows:
            t = r.get("tranche")
            if t in by_tranche:
                by_tranche[t]["femmes"] = int(r.get("femmes") or 0)
                by_tranche[t]["hommes"] = int(r.get("hommes") or 0)

        bands = [
            AgePyramidBand(label=t, femmes=by_tranche[t]["femmes"], hommes=by_tranche[t]["hommes"])
            for t in order
        ]

        return AgePyramidResponse(
            bands=bands,
            total_actifs=int(meta.get("total_actifs") or 0),
            unknown_birth=int(meta.get("unknown_birth") or 0),
            unknown_gender=int(meta.get("unknown_gender") or 0),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
