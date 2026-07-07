from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional
from uuid import uuid4
import json

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_fetch_owner,
    studio_require_min_role,
    studio_require_user,
)

router = APIRouter()

ALL_SERVICE_ID = "__ALL__"
NON_LIE_SERVICE_ID = "__NON_LIE__"


class StudioRhIndisponibilitePayload(BaseModel):
    id_effectif: str
    date_debut: str
    date_fin: str
    type_indisponibilite: Optional[str] = None
    commentaire: Optional[str] = None
    statut: Optional[str] = None


class StudioRhCampagnePayload(BaseModel):
    nom_campagne: str
    periode_debut: str
    periode_fin: str
    perimetre: Optional[str] = "entreprise"
    id_service: Optional[str] = None
    collaborateurs_inclus: List[str] = Field(default_factory=list)
    collaborateurs_exclus: List[str] = Field(default_factory=list)
    id_manager: Optional[str] = None
    statut: Optional[str] = "a_planifier"
    commentaire: Optional[str] = None


class StudioRhCompetencePayload(BaseModel):
    id_effectif: str
    type_entretien: Optional[str] = "entretien_competence"
    id_competence: Optional[str] = None
    date_cible: Optional[str] = None
    id_manager: Optional[str] = None
    commentaire: Optional[str] = None
    statut: Optional[str] = "a_planifier"


class StudioRhEventPatchPayload(BaseModel):
    titre: Optional[str] = None
    type_evenement: Optional[str] = None
    date_debut: Optional[str] = None
    date_fin: Optional[str] = None
    statut: Optional[str] = None
    id_effectif: Optional[str] = None
    id_manager: Optional[str] = None
    payload_json: Optional[Dict[str, Any]] = None
    archive: Optional[bool] = None


class StudioRhSuggestionPatchPayload(BaseModel):
    statut: Optional[str] = None
    archive: Optional[bool] = None


class StudioRhFromSuggestionPayload(BaseModel):
    id_suggestion: str
    date_debut: str
    date_fin: Optional[str] = None
    statut: Optional[str] = "planifie"


# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def _clean(value: Any) -> str:
    return str(value or "").strip()


def _date_to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _dt_to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(timespec="minutes")
    if isinstance(value, date):
        return datetime.combine(value, time.min).isoformat(timespec="minutes")
    return str(value)


def _json_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _parse_date_param(label: str, value: Optional[str]) -> date:
    raw = _clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{label} manquant.")
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{label} invalide. Format attendu : YYYY-MM-DD.")


def _parse_datetime_param(label: str, value: Optional[str], default_hour: int = 9) -> datetime:
    raw = _clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{label} manquant.")
    normalized = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt.replace(second=0, microsecond=0)
    except Exception:
        try:
            return datetime.combine(date.fromisoformat(raw[:10]), time(hour=default_hour))
        except Exception:
            raise HTTPException(status_code=400, detail=f"{label} invalide. Format attendu : YYYY-MM-DD ou YYYY-MM-DDTHH:MM.")


def _calendar_table_exists(cur, table_name: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = %s
        LIMIT 1
        """,
        (table_name,),
    )
    return cur.fetchone() is not None


def _ensure_calendar_tables(cur):
    if not _calendar_table_exists(cur, "tbl_calendrier_rh"):
        raise HTTPException(status_code=409, detail="Table tbl_calendrier_rh absente. Exécute le script SQL calendrier RH.")
    if not _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh"):
        raise HTTPException(status_code=409, detail="Table tbl_calendrier_suggestion_rh absente. Exécute le script SQL calendrier RH.")


def _require_owner_access(cur, u: dict, id_owner: str):
    oid = _clean(id_owner)
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = _clean(meta.get("id_owner"))
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = _clean(u.get("email"))
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (email, oid),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _resolve_owner_source(cur, oid: str, request: Request) -> dict:
    scope_ent = _clean(request.query_params.get("id_ent"))
    if scope_ent:
        cur.execute(
            """
            SELECT id_ent, nom_ent
            FROM public.tbl_entreprise
            WHERE id_ent = %s
              AND id_owner_gestionnaire = %s
              AND COALESCE(masque, FALSE) = FALSE
            LIMIT 1
            """,
            (scope_ent, oid),
        )
        r = cur.fetchone() or {}
        if r.get("id_ent"):
            return {
                "source_kind": "entreprise",
                "source_label": "Client",
                "source_name": _clean(r.get("nom_ent")),
                "id_ent": scope_ent,
            }

    cur.execute(
        """
        SELECT id_mon_ent, nom_ent
        FROM public.tbl_mon_entreprise
        WHERE id_mon_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_mon_ent"):
        return {
            "source_kind": "mon_entreprise",
            "source_label": "Mon entreprise",
            "source_name": _clean(r.get("nom_ent")),
            "id_ent": oid,
        }

    cur.execute(
        """
        SELECT id_ent, nom_ent
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_ent"):
        return {
            "source_kind": "entreprise",
            "source_label": "Client",
            "source_name": _clean(r.get("nom_ent")),
            "id_ent": oid,
        }

    raise HTTPException(status_code=404, detail="Owner non rattaché à une entreprise exploitable.")


def _resolve_context(cur, id_owner: str, request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    oid = _require_owner_access(cur, u, id_owner)
    owner = studio_fetch_owner(cur, oid)
    studio_require_min_role(cur, u, oid, "supervisor")
    src = _resolve_owner_source(cur, oid, request)
    return {
        "id_owner": oid,
        "nom_owner": owner.get("nom_owner"),
        "id_ent": src["id_ent"],
        "source_kind": src["source_kind"],
        "source_label": src["source_label"],
        "source_name": src["source_name"],
        "user_id": _clean(u.get("id")) or None,
        "user_email": _clean(u.get("email")) or None,
    }


def _normalize_service_filter(value: Optional[str]) -> Optional[str]:
    raw = _clean(value)
    if not raw or raw in (ALL_SERVICE_ID, "__all__", "__TOUS__"):
        return None
    return raw


def _validate_effectif(cur, id_ent: str, id_effectif: Optional[str]) -> Optional[dict]:
    eid = _clean(id_effectif)
    if not eid:
        return None
    cur.execute(
        """
        SELECT
          ec.id_effectif,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_effectif_client ec
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_ent = ec.id_ent
         AND org.id_service = ec.id_service
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE ec.id_ent = %s
          AND ec.id_effectif = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, eid),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=400, detail="Collaborateur invalide pour ce périmètre.")
    return dict(row)


def _validate_competence(cur, id_owner: str, id_ent: str, id_competence: Optional[str]) -> Optional[dict]:
    cid = _clean(id_competence)
    if not cid:
        return None
    cur.execute(
        """
        SELECT id_comp, intitule, domaine
        FROM public.tbl_competence
        WHERE id_comp = %s
          AND COALESCE(masque, FALSE) = FALSE
          AND COALESCE(etat, 'valide') <> 'archive'
          AND (id_owner = %s OR id_owner = %s OR id_owner IS NULL)
        LIMIT 1
        """,
        (cid, id_owner, id_ent),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=400, detail="Compétence invalide pour ce périmètre.")
    return dict(row)


def _event_type_label(value: Optional[str]) -> str:
    mapping = {
        "indisponibilite": "Indisponibilité",
        "entretien_annuel": "Entretien annuel",
        "entretien_competence": "Entretien compétence",
        "evaluation_competence": "Évaluation compétence",
        "campagne_entretien_annuel": "Campagne entretiens annuels",
        "evenement_rh": "Événement RH",
    }
    return mapping.get(_clean(value), _clean(value) or "Événement RH")


def _statut_label(value: Optional[str]) -> str:
    raw = _clean(value).lower()
    mapping = {
        "prevue": "Prévue",
        "prévue": "Prévue",
        "en_cours": "En cours",
        "terminee": "Terminée",
        "terminée": "Terminée",
        "a_planifier": "À planifier",
        "à_planifier": "À planifier",
        "proposee": "À planifier",
        "proposée": "À planifier",
        "planifie": "Planifié",
        "planifiée": "Planifié",
        "planifiee": "Planifié",
        "realise": "Réalisé",
        "réalisé": "Réalisé",
        "realisee": "Réalisé",
        "annule": "Annulé",
        "annulé": "Annulé",
        "brouillon": "Brouillon",
        "cloturee": "Clôturée",
        "clôturée": "Clôturée",
        "archive": "Archivé",
        "archivée": "Archivé",
        "archivé": "Archivé",
    }
    return mapping.get(raw, _clean(value) or "—")


def _collab_label(row: Dict[str, Any]) -> Optional[str]:
    label = " ".join(
        [x for x in [_clean(row.get("prenom_effectif")), _clean(row.get("nom_effectif")).upper()] if x]
    ).strip()
    return label or None


def _row_to_event(row: Dict[str, Any]) -> Dict[str, Any]:
    payload = _json_dict(row.get("payload_json"))
    return {
        "kind": "event",
        "id": row.get("id_evenement"),
        "id_evenement": row.get("id_evenement"),
        "id_ent": row.get("id_ent"),
        "id_manager": row.get("id_manager"),
        "id_effectif": row.get("id_effectif"),
        "type_evenement": row.get("type_evenement"),
        "type_label": _event_type_label(row.get("type_evenement")),
        "titre": row.get("titre"),
        "date_debut": _dt_to_str(row.get("date_debut")),
        "date_fin": _dt_to_str(row.get("date_fin")),
        "statut": row.get("statut"),
        "statut_label": _statut_label(row.get("statut")),
        "source": row.get("source"),
        "id_suggestion_origine": row.get("id_suggestion_origine"),
        "id_service": row.get("id_service") or payload.get("id_service"),
        "nom_service": row.get("nom_service") or payload.get("nom_service"),
        "collaborateur": _collab_label(row) or payload.get("collaborateur"),
        "payload_json": payload,
        "notification_json": _json_dict(row.get("notification_json")),
        "archive": bool(row.get("archive")),
        "created_at": _dt_to_str(row.get("created_at")),
        "updated_at": _dt_to_str(row.get("updated_at")),
    }


def _row_to_suggestion(row: Dict[str, Any]) -> Dict[str, Any]:
    payload = _json_dict(row.get("payload_json"))
    return {
        "kind": "suggestion",
        "id": row.get("id_suggestion"),
        "id_suggestion": row.get("id_suggestion"),
        "id_ent": row.get("id_ent"),
        "id_manager": row.get("id_manager"),
        "id_effectif": row.get("id_effectif"),
        "type_suggestion": row.get("type_suggestion"),
        "type_evenement": row.get("type_suggestion"),
        "type_label": _event_type_label(row.get("type_suggestion")),
        "titre": row.get("titre"),
        "date_echeance": _date_to_str(row.get("date_echeance")),
        "statut": row.get("statut") or "a_planifier",
        "statut_label": _statut_label(row.get("statut") or "a_planifier"),
        "priorite": row.get("priorite") or "normale",
        "source": row.get("source") or "studio_planification",
        "id_evenement": row.get("id_evenement"),
        "id_service": row.get("id_service") or payload.get("id_service"),
        "nom_service": row.get("nom_service") or payload.get("nom_service"),
        "collaborateur": _collab_label(row) or payload.get("collaborateur"),
        "payload_json": payload,
        "notification_json": _json_dict(row.get("notification_json")),
        "archive": bool(row.get("archive")),
        "created_at": _dt_to_str(row.get("created_at")),
        "updated_at": _dt_to_str(row.get("updated_at")),
    }


def _load_bootstrap_refs(cur, ctx: dict) -> dict:
    id_ent = ctx["id_ent"]
    id_owner = ctx["id_owner"]

    cur.execute(
        """
        SELECT id_service, nom_service, id_service_parent
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY lower(nom_service), nom_service
        """,
        (id_ent,),
    )
    services = [dict(r) for r in (cur.fetchall() or [])]

    cur.execute(
        """
        SELECT
          ec.id_effectif,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.email_effectif,
          ec.id_service,
          ec.ismanager,
          org.nom_service,
          fp.intitule_poste
        FROM public.tbl_effectif_client ec
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_ent = ec.id_ent
         AND org.id_service = ec.id_service
         AND COALESCE(org.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste fp
          ON fp.id_ent = ec.id_ent
         AND fp.id_poste = ec.id_poste_actuel
         AND COALESCE(fp.actif, TRUE) = TRUE
        WHERE ec.id_ent = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(ec.statut_actif, TRUE) = TRUE
        ORDER BY lower(ec.nom_effectif), lower(ec.prenom_effectif)
        """,
        (id_ent,),
    )
    collaborateurs = []
    managers = []
    for r in (cur.fetchall() or []):
        item = dict(r)
        item["label"] = _collab_label(item) or _clean(item.get("id_effectif"))
        collaborateurs.append(item)
        if item.get("ismanager"):
            managers.append(item)

    cur.execute(
        """
        SELECT id_comp, intitule, domaine
        FROM public.tbl_competence
        WHERE COALESCE(masque, FALSE) = FALSE
          AND COALESCE(etat, 'valide') <> 'archive'
          AND (id_owner = %s OR id_owner = %s OR id_owner IS NULL)
        ORDER BY lower(intitule)
        LIMIT 500
        """,
        (id_owner, id_ent),
    )
    competences = [dict(r) for r in (cur.fetchall() or [])]

    return {"services": services, "collaborateurs": collaborateurs, "managers": managers, "competences": competences}


def _insert_calendar_event(
    cur,
    ctx: dict,
    *,
    type_evenement: str,
    titre: str,
    date_debut: datetime,
    date_fin: Optional[datetime],
    statut: str,
    id_effectif: Optional[str],
    id_manager: Optional[str],
    source: str,
    payload_json: Optional[Dict[str, Any]] = None,
    notification_json: Optional[Dict[str, Any]] = None,
    id_suggestion_origine: Optional[str] = None,
) -> dict:
    id_evenement = str(uuid4())
    payload = dict(payload_json or {})
    notifications = dict(notification_json or {})
    is_archived = _clean(statut).lower() in ("archive", "archivé", "archivée")

    cur.execute(
        """
        INSERT INTO public.tbl_calendrier_rh
        (
          id_evenement, id_ent, id_manager, id_utilisateur, id_effectif,
          type_evenement, titre, date_debut, date_fin, statut, source,
          id_suggestion_origine, payload_json, notification_json, archive,
          created_at, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, NOW(), NOW())
        RETURNING *
        """,
        (
            id_evenement,
            ctx["id_ent"],
            _clean(id_manager) or None,
            ctx.get("user_id"),
            _clean(id_effectif) or None,
            _clean(type_evenement) or "evenement_rh",
            _clean(titre) or _event_type_label(type_evenement),
            date_debut,
            date_fin,
            _clean(statut) or "planifie",
            _clean(source) or "studio_planification",
            _clean(id_suggestion_origine) or None,
            json.dumps(payload, ensure_ascii=False),
            json.dumps(notifications, ensure_ascii=False),
            is_archived,
        ),
    )
    return dict(cur.fetchone() or {})


def _insert_suggestion(
    cur,
    ctx: dict,
    *,
    type_suggestion: str,
    titre: str,
    date_echeance: Optional[date],
    statut: str,
    id_effectif: Optional[str],
    id_manager: Optional[str],
    payload_json: Optional[Dict[str, Any]] = None,
    notification_json: Optional[Dict[str, Any]] = None,
) -> dict:
    id_suggestion = str(uuid4())
    payload = dict(payload_json or {})
    notifications = dict(notification_json or {})
    is_archived = _clean(statut).lower() in ("archive", "archivé", "archivée")

    cur.execute(
        """
        INSERT INTO public.tbl_calendrier_suggestion_rh
        (
          id_suggestion, id_ent, id_manager, id_effectif, type_suggestion,
          titre, date_echeance, priorite, source, statut, id_evenement,
          payload_json, notification_json, archive, created_at, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'normale', 'studio_planification', %s, NULL, %s::jsonb, %s::jsonb, %s, NOW(), NOW())
        RETURNING *
        """,
        (
            id_suggestion,
            ctx["id_ent"],
            _clean(id_manager) or None,
            _clean(id_effectif) or None,
            _clean(type_suggestion) or "evenement_rh",
            _clean(titre) or _event_type_label(type_suggestion),
            date_echeance,
            _clean(statut) or "a_planifier",
            json.dumps(payload, ensure_ascii=False),
            json.dumps(notifications, ensure_ascii=False),
            is_archived,
        ),
    )
    return dict(cur.fetchone() or {})


def _ensure_entretien_annuel(cur, ctx: dict, event_row: dict) -> Optional[str]:
    if _clean(event_row.get("type_evenement")) != "entretien_annuel":
        return None
    id_effectif = _clean(event_row.get("id_effectif"))
    if not id_effectif:
        return None

    payload = _json_dict(event_row.get("payload_json"))
    if _clean(payload.get("id_entretien")):
        return _clean(payload.get("id_entretien"))

    date_debut = event_row.get("date_debut")
    if not isinstance(date_debut, datetime):
        return None

    cur.execute(
        """
        SELECT id_entretien
        FROM public.tbl_entretien_individuel
        WHERE id_ent = %s
          AND id_effectif_client = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND date_prevue = %s
          AND lower(COALESCE(type_entretien, '')) LIKE '%%entretien%%annuel%%'
        LIMIT 1
        """,
        (ctx["id_ent"], id_effectif, date_debut.date()),
    )
    row = cur.fetchone() or {}
    id_entretien = _clean(row.get("id_entretien"))

    if not id_entretien:
        id_entretien = str(uuid4())
        periode_debut = payload.get("periode_debut") or None
        periode_fin = payload.get("periode_fin") or None
        cur.execute(
            """
            INSERT INTO public.tbl_entretien_individuel
            (
              id_entretien, id_ent, id_effectif_client, id_manager,
              type_entretien, statut, date_prevue, periode_debut, periode_fin,
              bilan, objectifs, developpement, plan_actions, documents, synthese,
              preparation, realisation, competences_entretien, archive, created_at, updated_at
            )
            VALUES (%s, %s, %s, %s, 'Entretien annuel', 'à réaliser', %s, %s, %s,
                    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                    %s::jsonb, '{}'::jsonb, '{}'::jsonb, FALSE, NOW(), NOW())
            """,
            (
                id_entretien,
                ctx["id_ent"],
                id_effectif,
                _clean(event_row.get("id_manager")) or None,
                date_debut.date(),
                _parse_date_param("periode_debut", periode_debut) if periode_debut else None,
                _parse_date_param("periode_fin", periode_fin) if periode_fin else None,
                json.dumps({"source": "studio_planification", "id_evenement": event_row.get("id_evenement")}, ensure_ascii=False),
            ),
        )

    payload["id_entretien"] = id_entretien
    cur.execute(
        """
        UPDATE public.tbl_calendrier_rh
        SET payload_json = %s::jsonb,
            updated_at = NOW()
        WHERE id_evenement = %s
        """,
        (json.dumps(payload, ensure_ascii=False), event_row.get("id_evenement")),
    )
    return id_entretien


def _events_query(cur, ctx: dict, *, start_dt: Optional[datetime] = None, end_dt: Optional[datetime] = None,
                  type_filter: Optional[str] = None, statut: Optional[str] = None,
                  id_service: Optional[str] = None, id_effectif: Optional[str] = None,
                  limit: Optional[int] = None, include_archived: bool = False) -> List[dict]:
    typ = _clean(type_filter)
    if typ == "indisponibilite":
        return []

    params: List[Any] = [ctx["id_ent"]]
    where = """
      WHERE ev.id_ent = %s
        AND COALESCE(ev.type_evenement, '') <> 'indisponibilite'
    """
    if not include_archived:
        where += " AND COALESCE(ev.archive, FALSE) = FALSE "
    if start_dt is not None and end_dt is not None:
        where += " AND COALESCE(ev.date_fin, ev.date_debut) >= %s AND ev.date_debut < %s "
        params.extend([start_dt, end_dt])
    if typ:
        where += " AND ev.type_evenement = %s "
        params.append(typ)
    stat = _clean(statut)
    if stat:
        if stat in ("archive", "archivé", "archivée"):
            where += " AND COALESCE(ev.archive, FALSE) = TRUE "
        else:
            where += " AND ev.statut = %s "
            params.append(stat)
    svc = _normalize_service_filter(id_service)
    if svc == NON_LIE_SERVICE_ID:
        where += " AND (ev.id_effectif IS NULL OR COALESCE(ec.id_service, '') = '') "
    elif svc:
        where += " AND ec.id_service = %s "
        params.append(svc)
    eff = _clean(id_effectif)
    if eff:
        where += " AND ev.id_effectif = %s "
        params.append(eff)

    limit_sql = ""
    if limit and int(limit) > 0:
        limit_sql = " LIMIT %s"
        params.append(int(limit))

    cur.execute(
        f"""
        SELECT
          ev.*,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_calendrier_rh ev
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = ev.id_effectif
         AND ec.id_ent = ev.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        {where}
        ORDER BY ev.date_debut ASC, ev.titre ASC
        {limit_sql}
        """,
        tuple(params),
    )
    return [_row_to_event(dict(r)) for r in (cur.fetchall() or [])]


def _suggestions_query(cur, ctx: dict, *, type_filter: Optional[str] = None, statut: Optional[str] = None,
                       id_service: Optional[str] = None, id_effectif: Optional[str] = None,
                       limit: Optional[int] = None, include_archived: bool = False) -> List[dict]:
    params: List[Any] = [ctx["id_ent"]]
    where = """
      WHERE sg.id_ent = %s
    """
    if not include_archived:
        where += " AND COALESCE(sg.archive, FALSE) = FALSE "
    where += " AND sg.id_evenement IS NULL "
    typ = _clean(type_filter)
    if typ:
        where += " AND sg.type_suggestion = %s "
        params.append(typ)
    stat = _clean(statut)
    if stat:
        if stat in ("archive", "archivé", "archivée"):
            where += " AND COALESCE(sg.archive, FALSE) = TRUE "
        elif stat in ("a_planifier", "à_planifier", "proposee", "proposée"):
            where += " AND sg.statut IN ('a_planifier', 'à_planifier', 'proposee', 'proposée') "
        else:
            where += " AND sg.statut = %s "
            params.append(stat)
    else:
        where += " AND sg.statut NOT IN ('ignoree', 'ignorée', 'planifiee', 'planifiée', 'archive', 'archivé', 'archivée') "
    svc = _normalize_service_filter(id_service)
    if svc == NON_LIE_SERVICE_ID:
        where += " AND (sg.id_effectif IS NULL OR COALESCE(ec.id_service, '') = '') "
    elif svc:
        where += " AND ec.id_service = %s "
        params.append(svc)
    eff = _clean(id_effectif)
    if eff:
        where += " AND sg.id_effectif = %s "
        params.append(eff)

    limit_sql = ""
    if limit and int(limit) > 0:
        limit_sql = " LIMIT %s"
        params.append(int(limit))

    cur.execute(
        f"""
        SELECT
          sg.*,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_calendrier_suggestion_rh sg
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = sg.id_effectif
         AND ec.id_ent = sg.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        {where}
        ORDER BY sg.date_echeance NULLS LAST, sg.created_at DESC
        {limit_sql}
        """,
        tuple(params),
    )
    return [_row_to_suggestion(dict(r)) for r in (cur.fetchall() or [])]


def _ranges_overlap(start_a: date, end_a: date, start_b: date, end_b: date) -> bool:
    return start_a <= end_b and start_b <= end_a


def _check_break_overlap_db(cur, id_ent: str, id_effectif: str, new_start: date, new_end: date,
                            exclude_id_break: Optional[str] = None):
    sql = """
        SELECT id_break, date_debut, date_fin
        FROM public.tbl_effectif_client_break
        WHERE id_ent = %s
          AND id_effectif = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND date_debut <= %s
          AND date_fin >= %s
    """
    params: List[Any] = [id_ent, id_effectif, new_end, new_start]
    if _clean(exclude_id_break):
        sql += " AND id_break <> %s "
        params.append(_clean(exclude_id_break))

    cur.execute(sql, tuple(params))
    for row in (cur.fetchall() or []):
        if _ranges_overlap(row.get("date_debut"), row.get("date_fin"), new_start, new_end):
            raise HTTPException(status_code=400, detail="Chevauchement avec une indisponibilité existante.")


def _break_status(row: Dict[str, Any]) -> str:
    if bool(row.get("archive")):
        return "archive"
    end_value = row.get("date_fin")
    if isinstance(end_value, datetime):
        end_value = end_value.date()
    if isinstance(end_value, date) and end_value < date.today():
        return "realise"
    return "planifie"


def _row_to_break(row: Dict[str, Any]) -> Dict[str, Any]:
    statut = _break_status(row)
    payload = {
        "source_table": "tbl_effectif_client_break",
        "date_debut": _date_to_str(row.get("date_debut")),
        "date_fin": _date_to_str(row.get("date_fin")),
    }
    return {
        "kind": "break",
        "id": row.get("id_break"),
        "id_break": row.get("id_break"),
        "id_evenement": row.get("id_break"),
        "id_ent": row.get("id_ent"),
        "id_manager": None,
        "id_effectif": row.get("id_effectif"),
        "type_evenement": "indisponibilite",
        "type_label": "Indisponibilité",
        "titre": f"Indisponibilité · {_collab_label(row) or 'Collaborateur'}",
        "date_debut": _date_to_str(row.get("date_debut")),
        "date_fin": _date_to_str(row.get("date_fin")),
        "statut": statut,
        "statut_label": "Archivé" if statut == "archive" else ("Terminée" if statut == "realise" else "Planifié"),
        "source": "effectif_break",
        "id_suggestion_origine": None,
        "id_service": row.get("id_service"),
        "nom_service": row.get("nom_service"),
        "collaborateur": _collab_label(row),
        "payload_json": payload,
        "notification_json": {},
        "archive": bool(row.get("archive")),
        "created_at": _dt_to_str(row.get("date_creation")),
        "updated_at": _dt_to_str(row.get("dernier_update")),
    }


def _breaks_query(cur, ctx: dict, *, start_dt: Optional[datetime] = None, end_dt: Optional[datetime] = None,
                  type_filter: Optional[str] = None, statut: Optional[str] = None,
                  id_service: Optional[str] = None, id_effectif: Optional[str] = None,
                  limit: Optional[int] = None, include_archived: bool = False) -> List[dict]:
    typ = _clean(type_filter)
    if typ and typ != "indisponibilite":
        return []

    params: List[Any] = [ctx["id_ent"]]
    where = """
      WHERE b.id_ent = %s
    """

    stat = _clean(statut).lower()
    if stat in ("archive", "archivé", "archivée"):
        where += " AND COALESCE(b.archive, FALSE) = TRUE "
    elif not include_archived:
        where += " AND COALESCE(b.archive, FALSE) = FALSE "

    if stat in ("a_planifier", "à_planifier", "proposee", "proposée", "annule", "annulé"):
        return []

    today = date.today()
    if stat in ("realise", "réalisé", "realisee", "terminée", "terminee"):
        where += " AND b.date_fin < %s "
        params.append(today)
    elif stat in ("planifie", "planifiée", "planifiee", "prevue", "prévue", "en_cours"):
        where += " AND b.date_fin >= %s "
        params.append(today)

    if start_dt is not None and end_dt is not None:
        where += " AND b.date_fin >= %s AND b.date_debut < %s "
        params.extend([start_dt.date(), end_dt.date()])

    svc = _normalize_service_filter(id_service)
    if svc == NON_LIE_SERVICE_ID:
        where += " AND (ec.id_service IS NULL OR COALESCE(ec.id_service, '') = '') "
    elif svc:
        where += " AND ec.id_service = %s "
        params.append(svc)

    eff = _clean(id_effectif)
    if eff:
        where += " AND b.id_effectif = %s "
        params.append(eff)

    limit_sql = ""
    if limit and int(limit) > 0:
        limit_sql = " LIMIT %s"
        params.append(int(limit))

    cur.execute(
        f"""
        SELECT
          b.id_break,
          b.id_ent,
          b.id_effectif,
          b.date_debut,
          b.date_fin,
          b.archive,
          b.date_creation,
          b.dernier_update,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_effectif_client_break b
        JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = b.id_effectif
         AND ec.id_ent = b.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        {where}
        ORDER BY b.date_debut ASC, b.date_fin ASC, ec.nom_effectif ASC, ec.prenom_effectif ASC
        {limit_sql}
        """,
        tuple(params),
    )
    return [_row_to_break(dict(r)) for r in (cur.fetchall() or [])]


def _insert_break(cur, ctx: dict, *, id_effectif: str, date_debut: date, date_fin: date) -> dict:
    eff = _validate_effectif(cur, ctx["id_ent"], id_effectif)
    _check_break_overlap_db(cur, ctx["id_ent"], eff.get("id_effectif"), date_debut, date_fin)
    id_break = str(uuid4())
    cur.execute(
        """
        INSERT INTO public.tbl_effectif_client_break
          (id_break, id_ent, id_effectif, date_debut, date_fin, archive, date_creation, dernier_update)
        VALUES
          (%s, %s, %s, %s, %s, FALSE, NOW(), NOW())
        RETURNING *
        """,
        (id_break, ctx["id_ent"], eff.get("id_effectif"), date_debut, date_fin),
    )
    row = dict(cur.fetchone() or {})
    row.update(eff)
    return row

def _fetch_break_by_id(cur, ctx: dict, id_break: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          b.id_break,
          b.id_ent,
          b.id_effectif,
          b.date_debut,
          b.date_fin,
          b.archive,
          b.date_creation,
          b.dernier_update,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_effectif_client_break b
        JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = b.id_effectif
         AND ec.id_ent = b.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE b.id_ent = %s
          AND b.id_break = %s
        LIMIT 1
        """,
        (ctx["id_ent"], _clean(id_break)),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _patch_break(cur, ctx: dict, id_break: str, payload: StudioRhEventPatchPayload) -> dict:
    current = _fetch_break_by_id(cur, ctx, id_break)
    if not current:
        raise HTTPException(status_code=404, detail="Événement calendrier introuvable.")

    updates = []
    params: List[Any] = []

    new_start = current.get("date_debut")
    new_end = current.get("date_fin")
    if payload.date_debut is not None:
        new_start = _parse_date_param("date_debut", payload.date_debut)
        updates.append("date_debut = %s")
        params.append(new_start)
    if payload.date_fin is not None:
        new_end = _parse_date_param("date_fin", payload.date_fin)
        updates.append("date_fin = %s")
        params.append(new_end)
    if new_end < new_start:
        raise HTTPException(status_code=400, detail="date_fin doit être postérieure à date_debut.")

    should_archive = bool(payload.archive) or _clean(payload.statut).lower() in ("annule", "annulé", "archive", "archivé", "archivée")
    if payload.archive is not None or payload.statut is not None:
        updates.append("archive = %s")
        params.append(should_archive)

    if not updates:
        raise HTTPException(status_code=400, detail="Aucune modification fournie.")

    if not bool(current.get("archive")) or (payload.date_debut is not None or payload.date_fin is not None):
        _check_break_overlap_db(cur, ctx["id_ent"], current.get("id_effectif"), new_start, new_end, exclude_id_break=id_break)

    updates.append("dernier_update = NOW()")
    params.extend([ctx["id_ent"], _clean(id_break)])
    cur.execute(
        f"""
        UPDATE public.tbl_effectif_client_break
        SET {', '.join(updates)}
        WHERE id_ent = %s
          AND id_break = %s
        """,
        tuple(params),
    )
    row = _fetch_break_by_id(cur, ctx, id_break)
    if not row:
        raise HTTPException(status_code=404, detail="Indisponibilité introuvable après mise à jour.")
    return row



# ------------------------------------------------------
# Routes
# ------------------------------------------------------
@router.get("/studio/planification/bootstrap/{id_owner}")
def studio_planification_bootstrap(id_owner: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                sql_ready = _calendar_table_exists(cur, "tbl_calendrier_rh") and _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh")
                refs = _load_bootstrap_refs(cur, ctx)

                kpis = {"a_planifier": 0, "planifies": 0, "realises": 0, "annules_archives": 0}
                if sql_ready:
                    cur.execute(
                        """
                        SELECT
                          COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = FALSE AND statut IN ('a_planifier', 'proposee', 'proposée')) AS a_planifier
                        FROM public.tbl_calendrier_suggestion_rh
                        WHERE id_ent = %s
                        """,
                        (ctx["id_ent"],),
                    )
                    s1 = cur.fetchone() or {}
                    cur.execute(
                        """
                        SELECT
                          COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = FALSE AND statut IN ('planifie', 'planifiée', 'planifiee')) AS planifies,
                          COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = FALSE AND statut IN ('realise', 'réalisé', 'realisee')) AS realises,
                          COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = TRUE OR statut IN ('annule', 'annulé', 'archive', 'archivé', 'archivée')) AS annules_archives
                        FROM public.tbl_calendrier_rh
                        WHERE id_ent = %s
                          AND COALESCE(type_evenement, '') <> 'indisponibilite'
                        """,
                        (ctx["id_ent"],),
                    )
                    s2 = cur.fetchone() or {}
                    kpis = {
                        "a_planifier": int(s1.get("a_planifier") or 0),
                        "planifies": int(s2.get("planifies") or 0),
                        "realises": int(s2.get("realises") or 0),
                        "annules_archives": int(s2.get("annules_archives") or 0),
                    }

                cur.execute(
                    """
                    SELECT
                      COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = FALSE AND date_fin >= CURRENT_DATE) AS planifies,
                      COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = FALSE AND date_fin < CURRENT_DATE) AS realises,
                      COUNT(1) FILTER (WHERE COALESCE(archive, FALSE) = TRUE) AS annules_archives
                    FROM public.tbl_effectif_client_break
                    WHERE id_ent = %s
                    """,
                    (ctx["id_ent"],),
                )
                breaks_kpis = cur.fetchone() or {}
                kpis["planifies"] += int(breaks_kpis.get("planifies") or 0)
                kpis["realises"] += int(breaks_kpis.get("realises") or 0)
                kpis["annules_archives"] += int(breaks_kpis.get("annules_archives") or 0)

        return {
            "context": ctx,
            "services": refs["services"],
            "collaborateurs": refs["collaborateurs"],
            "managers": refs["managers"],
            "competences": refs["competences"],
            "types_evenements": [
                {"id": "indisponibilite", "label": "Indisponibilité"},
                {"id": "entretien_annuel", "label": "Entretien annuel"},
                {"id": "entretien_competence", "label": "Entretien compétence"},
                {"id": "evaluation_competence", "label": "Évaluation compétence"},
            ],
            "statuts": ["a_planifier", "planifie", "realise", "annule", "archive"],
            "kpis": kpis,
            "sql_ready": sql_ready,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur bootstrap planification RH : {e}")


@router.get("/studio/planification/items/{id_owner}")
def studio_planification_items(
    id_owner: str,
    request: Request,
    type: Optional[str] = Query(default=None),
    statut: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),
    id_effectif: Optional[str] = Query(default=None),
    limit: int = Query(default=80),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                include_archived = _clean(statut).lower() in ("archive", "archivé", "archivée")
                events = _events_query(cur, ctx, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, limit=limit, include_archived=include_archived)
                suggestions = _suggestions_query(cur, ctx, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, limit=limit, include_archived=include_archived)
                breaks = _breaks_query(cur, ctx, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, limit=limit, include_archived=include_archived)
        items = suggestions + events + breaks
        items.sort(key=lambda x: (x.get("date_debut") or x.get("date_echeance") or "9999-12-31", x.get("titre") or ""))
        return {"items": items[: max(1, int(limit or 80))]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur liste planification RH : {e}")


@router.get("/studio/calendrier/events/{id_owner}")
def studio_calendrier_events(
    id_owner: str,
    request: Request,
    start: str = Query(...),
    end: str = Query(...),
    type: Optional[str] = Query(default=None),
    statut: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),
    id_effectif: Optional[str] = Query(default=None),
):
    try:
        start_date = _parse_date_param("start", start)
        end_date = _parse_date_param("end", end)
        if end_date < start_date:
            raise HTTPException(status_code=400, detail="Période invalide : end < start.")
        start_dt = datetime.combine(start_date, time.min)
        end_dt = datetime.combine(end_date + timedelta(days=1), time.min)
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                include_archived = _clean(statut).lower() in ("archive", "archivé", "archivée")
                events = []
                if _calendar_table_exists(cur, "tbl_calendrier_rh"):
                    events = _events_query(cur, ctx, start_dt=start_dt, end_dt=end_dt, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, include_archived=include_archived)
                breaks = _breaks_query(cur, ctx, start_dt=start_dt, end_dt=end_dt, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, include_archived=include_archived)
                items = events + breaks
                items.sort(key=lambda x: (x.get("date_debut") or "9999-12-31", x.get("titre") or ""))
                return items
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur calendrier RH : {e}")


@router.get("/studio/calendrier/suggestions/{id_owner}")
def studio_calendrier_suggestions(
    id_owner: str,
    request: Request,
    type: Optional[str] = Query(default=None),
    statut: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),
    id_effectif: Optional[str] = Query(default=None),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                if not _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh"):
                    return []
                include_archived = _clean(statut).lower() in ("archive", "archivé", "archivée")
                return _suggestions_query(cur, ctx, type_filter=type, statut=statut, id_service=id_service, id_effectif=id_effectif, limit=100, include_archived=include_archived)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur suggestions calendrier RH : {e}")


@router.post("/studio/planification/indisponibilites/{id_owner}")
def studio_planification_create_indisponibilite(id_owner: str, payload: StudioRhIndisponibilitePayload, request: Request):
    try:
        date_debut = _parse_date_param("date_debut", payload.date_debut)
        date_fin = _parse_date_param("date_fin", payload.date_fin)
        if date_fin < date_debut:
            raise HTTPException(status_code=400, detail="date_fin doit être postérieure à date_debut.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                row = _insert_break(
                    cur,
                    ctx,
                    id_effectif=payload.id_effectif,
                    date_debut=date_debut,
                    date_fin=date_fin,
                )
                conn.commit()
                return _row_to_break(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur création indisponibilité : {e}")


@router.post("/studio/planification/campagnes/{id_owner}")
def studio_planification_create_campagne(id_owner: str, payload: StudioRhCampagnePayload, request: Request):
    try:
        periode_debut = _parse_date_param("periode_debut", payload.periode_debut)
        periode_fin = _parse_date_param("periode_fin", payload.periode_fin)
        if periode_fin < periode_debut:
            raise HTTPException(status_code=400, detail="periode_fin doit être postérieure à periode_debut.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                perimetre = _clean(payload.perimetre).lower() or "entreprise"
                excluded = {_clean(x) for x in (payload.collaborateurs_exclus or []) if _clean(x)}
                included = [_clean(x) for x in (payload.collaborateurs_inclus or []) if _clean(x)]
                params: List[Any] = [ctx["id_ent"]]
                where = """
                  WHERE ec.id_ent = %s
                    AND COALESCE(ec.archive, FALSE) = FALSE
                    AND COALESCE(ec.statut_actif, TRUE) = TRUE
                """
                if perimetre == "service":
                    sid = _clean(payload.id_service)
                    if not sid:
                        raise HTTPException(status_code=400, detail="Service obligatoire pour une campagne par service.")
                    where += " AND ec.id_service = %s "
                    params.append(sid)
                elif perimetre == "selection":
                    if not included:
                        raise HTTPException(status_code=400, detail="Sélection de collaborateurs vide.")
                    where += " AND ec.id_effectif = ANY(%s) "
                    params.append(included)

                cur.execute(
                    f"""
                    SELECT ec.id_effectif, ec.nom_effectif, ec.prenom_effectif, ec.id_service, org.nom_service
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_entreprise_organigramme org
                      ON org.id_ent = ec.id_ent
                     AND org.id_service = ec.id_service
                     AND COALESCE(org.archive, FALSE) = FALSE
                    {where}
                    ORDER BY lower(ec.nom_effectif), lower(ec.prenom_effectif)
                    """,
                    tuple(params),
                )
                rows = [dict(r) for r in (cur.fetchall() or []) if _clean(r.get("id_effectif")) not in excluded]
                if not rows:
                    raise HTTPException(status_code=400, detail="Aucun collaborateur dans le périmètre de campagne.")

                campagne_id = str(uuid4())
                created = []
                for eff in rows:
                    event_payload = {
                        "id_campagne": campagne_id,
                        "nom_campagne": _clean(payload.nom_campagne),
                        "perimetre": perimetre,
                        "periode_debut": periode_debut.isoformat(),
                        "periode_fin": periode_fin.isoformat(),
                        "commentaire": _clean(payload.commentaire),
                        "id_service": eff.get("id_service"),
                        "nom_service": eff.get("nom_service"),
                        "collaborateur": _collab_label(eff),
                    }
                    titre = f"Entretien annuel · {_collab_label(eff) or 'Collaborateur'}"
                    row = _insert_suggestion(
                        cur,
                        ctx,
                        type_suggestion="entretien_annuel",
                        titre=titre,
                        date_echeance=periode_debut,
                        statut=_clean(payload.statut) or "a_planifier",
                        id_effectif=eff.get("id_effectif"),
                        id_manager=payload.id_manager,
                        payload_json=event_payload,
                    )
                    created.append(_row_to_suggestion(row))
                conn.commit()
                return {"id_campagne": campagne_id, "created": len(created), "items": created}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur création campagne entretiens : {e}")


@router.post("/studio/planification/competence/{id_owner}")
def studio_planification_create_competence_event(id_owner: str, payload: StudioRhCompetencePayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                eff = _validate_effectif(cur, ctx["id_ent"], payload.id_effectif)
                comp = _validate_competence(cur, ctx["id_owner"], ctx["id_ent"], payload.id_competence)
                typ = _clean(payload.type_entretien) or "entretien_competence"
                if typ not in ("entretien_competence", "evaluation_competence"):
                    typ = "entretien_competence"
                titre_base = "Évaluation compétence" if typ == "evaluation_competence" else "Entretien compétence"
                titre = f"{titre_base} · {_collab_label(eff) or 'Collaborateur'}"
                event_payload = {
                    "id_competence": comp.get("id_comp") if comp else None,
                    "competence": comp.get("intitule") if comp else None,
                    "commentaire": _clean(payload.commentaire),
                    "id_service": eff.get("id_service"),
                    "nom_service": eff.get("nom_service"),
                    "collaborateur": _collab_label(eff),
                }

                date_cible_raw = _clean(payload.date_cible)
                if date_cible_raw:
                    date_debut = _parse_datetime_param("date_cible", date_cible_raw)
                    row = _insert_calendar_event(
                        cur,
                        ctx,
                        type_evenement=typ,
                        titre=titre,
                        date_debut=date_debut,
                        date_fin=date_debut + timedelta(hours=1),
                        statut="planifie" if _clean(payload.statut) == "a_planifier" else (_clean(payload.statut) or "planifie"),
                        id_effectif=eff.get("id_effectif"),
                        id_manager=payload.id_manager,
                        source="studio_planification",
                        payload_json=event_payload,
                    )
                    conn.commit()
                    return _row_to_event(row)

                row = _insert_suggestion(
                    cur,
                    ctx,
                    type_suggestion=typ,
                    titre=titre,
                    date_echeance=None,
                    statut=_clean(payload.statut) or "a_planifier",
                    id_effectif=eff.get("id_effectif"),
                    id_manager=payload.id_manager,
                    payload_json=event_payload,
                )
                conn.commit()
                return _row_to_suggestion(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur création entretien compétence : {e}")


@router.post("/studio/calendrier/events/from-suggestion/{id_owner}")
def studio_calendrier_event_from_suggestion(id_owner: str, payload: StudioRhFromSuggestionPayload, request: Request):
    try:
        date_debut = _parse_datetime_param("date_debut", payload.date_debut)
        date_fin = _parse_datetime_param("date_fin", payload.date_fin) if _clean(payload.date_fin) else date_debut + timedelta(hours=1)
        if date_fin < date_debut:
            raise HTTPException(status_code=400, detail="date_fin doit être postérieure à date_debut.")
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                cur.execute(
                    """
                    SELECT *
                    FROM public.tbl_calendrier_suggestion_rh
                    WHERE id_ent = %s
                      AND id_suggestion = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND id_evenement IS NULL
                    LIMIT 1
                    """,
                    (ctx["id_ent"], _clean(payload.id_suggestion)),
                )
                suggestion = dict(cur.fetchone() or {})
                if not suggestion:
                    raise HTTPException(status_code=404, detail="Événement à planifier introuvable.")
                event_row = _insert_calendar_event(
                    cur,
                    ctx,
                    type_evenement=_clean(suggestion.get("type_suggestion")) or "evenement_rh",
                    titre=_clean(suggestion.get("titre")) or "Événement RH",
                    date_debut=date_debut,
                    date_fin=date_fin,
                    statut=_clean(payload.statut) or "planifie",
                    id_effectif=suggestion.get("id_effectif"),
                    id_manager=suggestion.get("id_manager"),
                    source="studio_planification",
                    payload_json=_json_dict(suggestion.get("payload_json")),
                    notification_json=_json_dict(suggestion.get("notification_json")),
                    id_suggestion_origine=suggestion.get("id_suggestion"),
                )
                _ensure_entretien_annuel(cur, ctx, event_row)
                cur.execute(
                    """
                    UPDATE public.tbl_calendrier_suggestion_rh
                    SET statut = 'planifiee',
                        id_evenement = %s,
                        updated_at = NOW()
                    WHERE id_suggestion = %s
                      AND id_ent = %s
                    """,
                    (event_row.get("id_evenement"), suggestion.get("id_suggestion"), ctx["id_ent"]),
                )
                conn.commit()
                return _row_to_event(event_row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur planification depuis brique : {e}")


@router.patch("/studio/calendrier/events/{id_owner}/{id_evenement}")
def studio_calendrier_patch_event(id_owner: str, id_evenement: str, payload: StudioRhEventPatchPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                cur.execute(
                    """
                    SELECT *
                    FROM public.tbl_calendrier_rh
                    WHERE id_ent = %s
                      AND id_evenement = %s
                    LIMIT 1
                    """,
                    (ctx["id_ent"], _clean(id_evenement)),
                )
                current = dict(cur.fetchone() or {})
                if not current:
                    row = _patch_break(cur, ctx, id_evenement, payload)
                    conn.commit()
                    return _row_to_break(row)

                updates = []
                params: List[Any] = []
                if payload.titre is not None:
                    updates.append("titre = %s")
                    params.append(_clean(payload.titre) or _event_type_label(current.get("type_evenement")))
                if payload.type_evenement is not None:
                    updates.append("type_evenement = %s")
                    params.append(_clean(payload.type_evenement) or "evenement_rh")
                if payload.date_debut is not None:
                    updates.append("date_debut = %s")
                    params.append(_parse_datetime_param("date_debut", payload.date_debut))
                if payload.date_fin is not None:
                    updates.append("date_fin = %s")
                    params.append(_parse_datetime_param("date_fin", payload.date_fin))
                if payload.statut is not None:
                    updates.append("statut = %s")
                    params.append(_clean(payload.statut) or "planifie")
                if payload.id_effectif is not None:
                    eff = _validate_effectif(cur, ctx["id_ent"], payload.id_effectif)
                    updates.append("id_effectif = %s")
                    params.append(eff.get("id_effectif") if eff else None)
                if payload.id_manager is not None:
                    mgr = _validate_effectif(cur, ctx["id_ent"], payload.id_manager) if _clean(payload.id_manager) else None
                    updates.append("id_manager = %s")
                    params.append(mgr.get("id_effectif") if mgr else None)
                if payload.payload_json is not None:
                    updates.append("payload_json = %s::jsonb")
                    params.append(json.dumps(payload.payload_json or {}, ensure_ascii=False))
                if payload.archive is not None:
                    updates.append("archive = %s")
                    params.append(bool(payload.archive))
                    if bool(payload.archive) and payload.statut is None:
                        updates.append("statut = %s")
                        params.append("archive")

                if not updates:
                    raise HTTPException(status_code=400, detail="Aucune modification fournie.")

                updates.append("updated_at = NOW()")
                params.extend([ctx["id_ent"], _clean(id_evenement)])
                cur.execute(
                    f"""
                    UPDATE public.tbl_calendrier_rh
                    SET {', '.join(updates)}
                    WHERE id_ent = %s
                      AND id_evenement = %s
                    RETURNING *
                    """,
                    tuple(params),
                )
                row = dict(cur.fetchone() or {})
                _ensure_entretien_annuel(cur, ctx, row)
                conn.commit()
                return _row_to_event(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur modification calendrier RH : {e}")


@router.patch("/studio/calendrier/suggestions/{id_owner}/{id_suggestion}")
def studio_calendrier_patch_suggestion(id_owner: str, id_suggestion: str, payload: StudioRhSuggestionPatchPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_owner, request)
                _ensure_calendar_tables(cur)
                updates = []
                params: List[Any] = []
                if payload.statut is not None:
                    updates.append("statut = %s")
                    params.append(_clean(payload.statut) or "a_planifier")
                if payload.archive is not None:
                    updates.append("archive = %s")
                    params.append(bool(payload.archive))
                    if bool(payload.archive) and payload.statut is None:
                        updates.append("statut = %s")
                        params.append("archive")
                if not updates:
                    raise HTTPException(status_code=400, detail="Aucune modification fournie.")
                updates.append("updated_at = NOW()")
                params.extend([ctx["id_ent"], _clean(id_suggestion)])
                cur.execute(
                    f"""
                    UPDATE public.tbl_calendrier_suggestion_rh
                    SET {', '.join(updates)}
                    WHERE id_ent = %s
                      AND id_suggestion = %s
                    RETURNING *
                    """,
                    tuple(params),
                )
                row = dict(cur.fetchone() or {})
                if not row:
                    raise HTTPException(status_code=404, detail="Brique à planifier introuvable.")
                conn.commit()
                return _row_to_suggestion(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur modification brique RH : {e}")
