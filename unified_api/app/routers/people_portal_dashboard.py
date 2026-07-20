from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_require_user,
    people_fetch_profile,
    people_fetch_profile_context,
    people_competence_score,
    people_clean,
)

router = APIRouter()


@router.get("/people/context/{id_effectif}")
def people_context(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = people_fetch_profile(cur, id_effectif=id_effectif, email=(u.get("email") or ""), is_super_admin=bool(u.get("is_super_admin")))
        return profile
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/context error: {e}")

@router.get("/people/dashboard/{id_effectif}")
def people_dashboard(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""
                id_poste = profile.get("id_poste_actuel") or ""

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_effectif_client_competence ec
                    WHERE ec.id_effectif_client = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                    """,
                    (id_effectif,),
                )
                nb_comp = int((cur.fetchone() or {}).get("nb") or 0)

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_action_formation_effectif aef
                    JOIN public.tbl_action_formation af
                      ON af.id_action_formation = aef.id_action_formation
                     AND COALESCE(af.archive, FALSE) = FALSE
                    WHERE aef.id_effectif = %s
                      AND COALESCE(aef.archive, FALSE) = FALSE
                      AND COALESCE(af.date_fin_formation, af.date_debut_formation, CURRENT_DATE) >= CURRENT_DATE
                    """,
                    (id_effectif,),
                )
                nb_form = int((cur.fetchone() or {}).get("nb") or 0)

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_effectif_client_break b
                    WHERE b.id_effectif = %s
                      AND COALESCE(b.archive, FALSE) = FALSE
                      AND b.date_fin >= CURRENT_DATE
                    """,
                    (id_effectif,),
                )
                nb_break = int((cur.fetchone() or {}).get("nb") or 0)

                mastery = 0
                current_poste_rows = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          pc.niveau_requis,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        LIMIT 8
                        """,
                        (id_effectif, id_poste),
                    )
                    current_poste_rows = cur.fetchall() or []
                    scores = [people_competence_score(r.get("niveau_actuel"), r.get("niveau_requis")) for r in current_poste_rows]
                    mastery = int(round(sum(scores) / len(scores))) if scores else 0

                cur.execute(
                    """
                    SELECT MAX(a.date_audit) AS last_date
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    WHERE ec.id_effectif_client = %s
                    """,
                    (id_effectif,),
                )
                last_audit = people_clean((cur.fetchone() or {}).get("last_date"))

        return {
            "profile": profile,
            "kpis": {
                "nb_competences": nb_comp,
                "nb_formations_programmees": nb_form,
                "nb_indisponibilites": nb_break,
                "maitrise_poste": mastery,
                "derniere_evaluation": last_audit,
            },
            "competences_prioritaires": current_poste_rows,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/dashboard error: {e}")
