import json
from datetime import date, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import people_fetch_profile_context, people_clean

router = APIRouter()

PEOPLE_EVENT_TYPES = {
    "demande_entretien_manager",
    "demande_entretien_rh",
    "preparation_entretien",
    "evenement_personnel",
}


class PeopleBreakPayload(BaseModel):
    date_debut: str
    date_fin: str


class PeopleEventPayload(BaseModel):
    type_evenement: str
    titre: str = ""
    date_debut: str
    date_fin: str = ""
    description: str = ""


def _parse_date(value: str, field_name: str) -> date:
    raw = people_clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{field_name} manquant.")
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} invalide.")


def _parse_datetime(value: str, field_name: str) -> datetime:
    raw = people_clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{field_name} manquant.")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} invalide.")


def _event_title(event_type: str) -> str:
    return {
        "demande_entretien_manager": "Demande d’entretien avec le manager",
        "demande_entretien_rh": "Demande d’entretien avec les RH",
        "preparation_entretien": "Préparation d’entretien",
        "evenement_personnel": "Événement personnel professionnel",
    }.get(event_type, "Événement personnel")


def _serialize_rows(rows):
    out = []
    for row in rows or []:
        item = dict(row)
        for key, value in list(item.items()):
            if isinstance(value, (date, datetime)):
                item[key] = value.isoformat()
        out.append(item)
    return out


@router.get("/people/calendrier/{id_effectif}")
def people_calendrier(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT id_break, date_debut, date_fin
                    FROM public.tbl_effectif_client_break
                    WHERE id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_debut ASC, date_fin ASC
                    """,
                    (id_effectif, id_owner),
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
                    """,
                    (id_owner, id_effectif),
                )
                formations = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_entretien,
                      type_entretien,
                      statut,
                      date_prevue,
                      date_realisee
                    FROM public.tbl_entretien_individuel
                    WHERE id_effectif_client = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(date_prevue, date_realisee) IS NOT NULL
                    ORDER BY COALESCE(date_prevue, date_realisee) ASC
                    """,
                    (id_effectif, id_owner),
                )
                entretiens = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_evenement,
                      type_evenement,
                      titre,
                      date_debut,
                      date_fin,
                      statut,
                      source,
                      payload_json
                    FROM public.tbl_calendrier_rh
                    WHERE id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_debut ASC
                    """,
                    (id_effectif, id_owner),
                )
                events = cur.fetchall() or []

        return {
            "profile": profile,
            "indisponibilites": _serialize_rows(breaks),
            "formations": _serialize_rows(formations),
            "entretiens": _serialize_rows(entretiens),
            "evenements": _serialize_rows(events),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar error: {e}")


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
                    VALUES (%s, %s, %s, %s, %s, FALSE, NOW(), NOW())
                    RETURNING id_break, date_debut, date_fin
                    """,
                    (id_break, profile.get("id_owner") or "", id_effectif, date_debut, date_fin),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"created": _serialize_rows([row])[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/breaks error: {e}")


@router.patch("/people/calendrier/{id_effectif}/breaks/{id_break}")
def people_calendrier_update_break(id_effectif: str, id_break: str, payload: PeopleBreakPayload, request: Request):
    date_debut = _parse_date(payload.date_debut, "date_debut")
    date_fin = _parse_date(payload.date_fin, "date_fin")
    if date_fin < date_debut:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure ou égale à la date de début.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_break
                    SET date_debut = %s,
                        date_fin = %s,
                        dernier_update = NOW()
                    WHERE id_break = %s
                      AND id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_break, date_debut, date_fin
                    """,
                    (date_debut, date_fin, id_break, id_effectif, profile.get("id_owner") or ""),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Indisponibilité introuvable.")
            conn.commit()
        return {"updated": _serialize_rows([row])[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/breaks/update error: {e}")


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
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Indisponibilité introuvable.")
            conn.commit()
        return {"archived": True, "id_break": id_break}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/archive error: {e}")


@router.post("/people/calendrier/{id_effectif}/events")
def people_calendrier_add_event(id_effectif: str, payload: PeopleEventPayload, request: Request):
    event_type = people_clean(payload.type_evenement)
    if event_type not in PEOPLE_EVENT_TYPES:
        raise HTTPException(status_code=400, detail="Type d’événement People invalide.")
    date_debut = _parse_datetime(payload.date_debut, "date_debut")
    date_fin = _parse_datetime(payload.date_fin, "date_fin") if people_clean(payload.date_fin) else date_debut + timedelta(hours=1)
    if date_fin < date_debut:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure ou égale à la date de début.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_event = str(uuid4())
                event_payload = {"description": people_clean(payload.description), "created_by": "people"}
                cur.execute(
                    """
                    INSERT INTO public.tbl_calendrier_rh
                      (id_evenement, id_ent, id_utilisateur, id_effectif, type_evenement, titre,
                       date_debut, date_fin, statut, source, payload_json, notification_json,
                       archive, created_at, updated_at)
                    VALUES
                      (%s, %s, %s, %s, %s, %s, %s, %s, 'planifie', 'people', %s::jsonb,
                       %s::jsonb, FALSE, NOW(), NOW())
                    RETURNING id_evenement, type_evenement, titre, date_debut, date_fin, statut, source, payload_json
                    """,
                    (
                        id_event,
                        profile.get("id_owner") or "",
                        None,
                        id_effectif,
                        event_type,
                        people_clean(payload.titre) or _event_title(event_type),
                        date_debut,
                        date_fin,
                        json.dumps(event_payload, ensure_ascii=False),
                        json.dumps({"requested_from": "manager" if event_type.endswith("manager") else "rh" if event_type.endswith("rh") else ""}, ensure_ascii=False),
                    ),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"created": _serialize_rows([row])[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/events error: {e}")


@router.patch("/people/calendrier/{id_effectif}/events/{id_event}")
def people_calendrier_update_event(id_effectif: str, id_event: str, payload: PeopleEventPayload, request: Request):
    event_type = people_clean(payload.type_evenement)
    if event_type not in PEOPLE_EVENT_TYPES:
        raise HTTPException(status_code=400, detail="Type d’événement People invalide.")
    date_debut = _parse_datetime(payload.date_debut, "date_debut")
    date_fin = _parse_datetime(payload.date_fin, "date_fin") if people_clean(payload.date_fin) else date_debut + timedelta(hours=1)
    if date_fin < date_debut:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure ou égale à la date de début.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_calendrier_rh
                    SET type_evenement = %s,
                        titre = %s,
                        date_debut = %s,
                        date_fin = %s,
                        payload_json = %s::jsonb,
                        updated_at = NOW()
                    WHERE id_evenement = %s
                      AND id_effectif = %s
                      AND id_ent = %s
                      AND source = 'people'
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_evenement, type_evenement, titre, date_debut, date_fin, statut, source, payload_json
                    """,
                    (
                        event_type,
                        people_clean(payload.titre) or _event_title(event_type),
                        date_debut,
                        date_fin,
                        json.dumps({"description": people_clean(payload.description), "created_by": "people"}, ensure_ascii=False),
                        id_event,
                        id_effectif,
                        profile.get("id_owner") or "",
                    ),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Événement personnel introuvable.")
            conn.commit()
        return {"updated": _serialize_rows([row])[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/events/update error: {e}")


@router.post("/people/calendrier/{id_effectif}/events/{id_event}/archive")
def people_calendrier_archive_event(id_effectif: str, id_event: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_calendrier_rh
                    SET archive = TRUE,
                        updated_at = NOW()
                    WHERE id_evenement = %s
                      AND id_effectif = %s
                      AND id_ent = %s
                      AND source = 'people'
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_evenement
                    """,
                    (id_event, id_effectif, profile.get("id_owner") or ""),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Événement personnel introuvable.")
            conn.commit()
        return {"archived": True, "id_evenement": id_event}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/calendar/events/archive error: {e}")
