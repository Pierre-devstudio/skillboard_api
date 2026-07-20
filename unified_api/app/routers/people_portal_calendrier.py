from datetime import date
from uuid import uuid4
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import people_fetch_profile_context, people_clean

router = APIRouter()

class PeopleBreakPayload(BaseModel):
    date_debut: str
    date_fin: str

def _parse_date(value: str, field_name: str) -> date:
    raw = people_clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{field_name} manquant.")
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} invalide.")

@router.get("/people/calendrier/{id_effectif}")
def people_calendrier(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)

                cur.execute(
                    """
                    SELECT id_break, date_debut, date_fin
                    FROM public.tbl_effectif_client_break
                    WHERE id_effectif = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_debut DESC, date_fin DESC
                    LIMIT 30
                    """,
                    (id_effectif,),
                )
                breaks = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      aef.id_action_formation_effectif,
                      af.id_action_formation,
                      COALESCE(ff.titre, 'Formation programmée') AS titre,
                      COALESCE(ff.fournisseur_formation, '') AS organisme,
                      af.date_debut_formation,
                      af.date_fin_formation,
                      COALESCE(af.etat_action, '') AS etat_action,
                      COALESCE(aef.etat_invitation, '') AS etat_invitation,
                      COALESCE(aef.etat_attestation, '') AS etat_attestation
                    FROM public.tbl_action_formation_effectif aef
                    JOIN public.tbl_action_formation af
                      ON af.id_action_formation = aef.id_action_formation
                     AND COALESCE(af.archive, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_formation ff
                      ON ff.id_form = af.id_form
                     AND ff.id_owner = %s
                     AND COALESCE(ff.archive, FALSE) = FALSE
                    WHERE aef.id_effectif = %s
                      AND COALESCE(aef.archive, FALSE) = FALSE
                    ORDER BY COALESCE(af.date_debut_formation, CURRENT_DATE) ASC
                    LIMIT 40
                    """,
                    (profile.get("id_owner") or "", id_effectif),
                )
                formations = cur.fetchall() or []

        return {"profile": profile, "indisponibilites": breaks, "formations": formations}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar error: {e}")


@router.post("/people/calendrier/{id_effectif}/breaks")
def people_calendrier_add_break(id_effectif: str, payload: PeopleBreakPayload, request: Request):
    date_debut = _parse_date(payload.date_debut, "date_debut")
    date_fin = _parse_date(payload.date_fin, "date_fin")
    if date_fin < date_debut:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure ou égale à la date de début.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_break = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_break
                      (id_break, id_ent, id_effectif, date_debut, date_fin, archive, date_creation, dernier_update)
                    VALUES
                      (%s, %s, %s, %s, %s, FALSE, NOW(), NOW())
                    RETURNING id_break, date_debut, date_fin
                    """,
                    (id_break, profile.get("id_owner") or "", id_effectif, date_debut, date_fin),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"created": row}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar/breaks error: {e}")


@router.post("/people/calendrier/{id_effectif}/breaks/{id_break}/archive")
def people_calendrier_archive_break(id_effectif: str, id_break: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_break
                    SET archive = TRUE,
                        dernier_update = NOW()
                    WHERE id_break = %s
                      AND id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_break
                    """,
                    (id_break, id_effectif, profile.get("id_owner") or ""),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"archived": bool(row), "id_break": id_break}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar/archive error: {e}")
