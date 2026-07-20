from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import people_fetch_profile_context
router = APIRouter()

@router.get("/people/parcours/{id_effectif}")
def people_parcours(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT
                      hp.id_effectif_historique_poste,
                      hp.id_poste,
                      COALESCE(fp.intitule_poste, 'Poste') AS intitule_poste,
                      hp.date_debut,
                      hp.date_fin,
                      COALESCE(hp.commentaire, '') AS commentaire,
                      COALESCE(hp.source_changement, '') AS source_changement
                    FROM public.tbl_effectif_client_historique_poste hp
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = hp.id_poste
                     AND fp.id_owner = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE hp.id_effectif = %s
                      AND COALESCE(hp.archive, FALSE) = FALSE
                    ORDER BY COALESCE(hp.date_debut, CURRENT_DATE) ASC, hp.date_creation ASC
                    """,
                    (id_owner, id_effectif),
                )
                postes = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      a.date_audit,
                      a.resultat_eval,
                      COALESCE(a.methode_eval, '') AS methode_eval
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                     AND ec.id_effectif_client = %s
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE a.resultat_eval IS NOT NULL
                    ORDER BY a.date_audit ASC, c.intitule ASC
                    LIMIT 240
                    """,
                    (id_effectif,),
                )
                audits = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      hf.id_historique_formation,
                      hf.date_formation,
                      hf.date_debut_formation,
                      hf.date_fin_formation,
                      hf.intitule,
                      COALESCE(hf.organisme, '') AS organisme,
                      COALESCE(hf.source, '') AS source
                    FROM public.tbl_effectif_client_historique_formation hf
                    WHERE hf.id_effectif = %s
                      AND hf.id_ent = %s
                      AND COALESCE(hf.archive, FALSE) = FALSE
                    ORDER BY hf.date_formation DESC
                    LIMIT 20
                    """,
                    (id_effectif, id_owner),
                )
                formations = cur.fetchall() or []

        return {"profile": profile, "postes": postes, "audits": audits, "formations": formations}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/parcours error: {e}")
