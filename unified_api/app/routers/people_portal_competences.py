from typing import Optional
from uuid import uuid4
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_clean,
    people_fetch_profile_context,
)
router = APIRouter()

class PeopleAddCompetencePayload(BaseModel):
    id_comp: str
    niveau_actuel: Optional[str] = None

@router.get("/people/competences/{id_effectif}")
def people_competences(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_poste = profile.get("id_poste_actuel") or ""

                current = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                          pc.niveau_requis,
                          COALESCE(pc.poids_criticite, 0) AS criticite,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                          ec.date_derniere_eval
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_domaine_competence dc
                          ON dc.id_domaine_competence = c.domaine
                         AND COALESCE(dc.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        """,
                        (id_effectif, id_poste),
                    )
                    current = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                      ec.date_derniere_eval
                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE ec.id_effectif_client = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_fiche_poste_competence pc
                        WHERE pc.id_poste = %s
                          AND pc.id_competence = ec.id_comp
                          AND COALESCE(pc.masque, FALSE) = FALSE
                      )
                    ORDER BY c.intitule
                    """,
                    (id_effectif, id_poste or ""),
                )
                autres = cur.fetchall() or []

        return {"profile": profile, "poste": current, "autres": autres}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences error: {e}")


@router.get("/people/competences/{id_effectif}/catalogue")
def people_competences_catalogue(id_effectif: str, request: Request, q: str = ""):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""
                id_poste = profile.get("id_poste_actuel") or ""
                search = f"%{people_clean(q).lower()}%"

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      COALESCE(c.description, '') AS description
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE c.id_owner = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') NOT IN ('archivée', 'archive', 'inactive')
                      AND (
                        %s = '%%'
                        OR lower(COALESCE(c.code, '')) LIKE %s
                        OR lower(COALESCE(c.intitule, '')) LIKE %s
                        OR lower(COALESCE(c.description, '')) LIKE %s
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_competence ec
                        WHERE ec.id_effectif_client = %s
                          AND ec.id_comp = c.id_comp
                          AND COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.actif, TRUE) = TRUE
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_fiche_poste_competence pc
                        WHERE pc.id_poste = %s
                          AND pc.id_competence = c.id_comp
                          AND COALESCE(pc.masque, FALSE) = FALSE
                      )
                    ORDER BY c.intitule
                    LIMIT 80
                    """,
                    (id_owner, search, search, search, search, id_effectif, id_poste or ""),
                )
                rows = cur.fetchall() or []
        return {"items": rows}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences/catalogue error: {e}")


@router.post("/people/competences/{id_effectif}/add")
def people_competences_add(id_effectif: str, payload: PeopleAddCompetencePayload, request: Request):
    id_comp = people_clean(payload.id_comp)
    if not id_comp:
        raise HTTPException(status_code=400, detail="Compétence manquante.")

    niveau = people_clean(payload.niveau_actuel).upper()
    if niveau not in ("", "A", "B", "C", "D"):
        niveau = ""

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT id_comp
                    FROM public.tbl_competence
                    WHERE id_comp = %s
                      AND id_owner = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_comp, id_owner),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Compétence introuvable dans le catalogue.")

                cur.execute(
                    """
                    SELECT id_effectif_competence
                    FROM public.tbl_effectif_client_competence
                    WHERE id_effectif_client = %s
                      AND id_comp = %s
                    LIMIT 1
                    """,
                    (id_effectif, id_comp),
                )
                existing = cur.fetchone() or {}
                if existing:
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client_competence
                        SET actif = TRUE,
                            archive = FALSE,
                            niveau_actuel = COALESCE(NULLIF(%s, ''), niveau_actuel),
                            date_derniere_eval = COALESCE(date_derniere_eval, CURRENT_DATE)
                        WHERE id_effectif_competence = %s
                        RETURNING id_effectif_competence
                        """,
                        (niveau, existing.get("id_effectif_competence")),
                    )
                    row = cur.fetchone() or {}
                else:
                    id_ec = str(uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_effectif_client_competence
                          (id_effectif_competence, id_effectif_client, id_comp, niveau_actuel, date_derniere_eval, actif, archive)
                        VALUES
                          (%s, %s, %s, NULLIF(%s, ''), CURRENT_DATE, TRUE, FALSE)
                        RETURNING id_effectif_competence
                        """,
                        (id_ec, id_effectif, id_comp, niveau),
                    )
                    row = cur.fetchone() or {}
            conn.commit()
        return {"added": row}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences/add error: {e}")
