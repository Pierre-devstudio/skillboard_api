import json
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    fetch_contact_with_entreprise,
    get_conn,
    resolve_insights_effectif_for_request,
)

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"
ALL_ID = "__ALL__"
CALENDAR_UUID_NAMESPACE = UUID("8d36d045-8ce7-4d8b-8cb6-82f4f13b4751")


class CalendrierEventPayload(BaseModel):
    type_evenement: Optional[str] = "evenement_rh"
    titre: Optional[str] = None
    date_debut: str
    date_fin: Optional[str] = None
    statut: Optional[str] = "planifie"
    source: Optional[str] = "manuel"
    id_effectif: Optional[str] = None
    payload_json: Dict[str, Any] = Field(default_factory=dict)


class CalendrierEventPatchPayload(BaseModel):
    type_evenement: Optional[str] = None
    titre: Optional[str] = None
    date_debut: Optional[str] = None
    date_fin: Optional[str] = None
    statut: Optional[str] = None
    id_effectif: Optional[str] = None
    payload_json: Optional[Dict[str, Any]] = None


class CalendrierFromSuggestionPayload(BaseModel):
    id_suggestion: str
    date_debut: str
    date_fin: Optional[str] = None
    titre: Optional[str] = None
    statut: Optional[str] = "planifie"


# ======================================================
# Helpers généraux
# ======================================================
def _clean(value: Any) -> str:
    return str(value or "").strip()


def _date_to_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
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


def _parse_date_param(label: str, value: Optional[str]) -> date:
    raw = _clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{label} manquant.")
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{label} invalide. Format attendu : YYYY-MM-DD.")


def _parse_datetime_param(label: str, value: Optional[str]) -> datetime:
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
            return datetime.combine(date.fromisoformat(raw[:10]), time(hour=9))
        except Exception:
            raise HTTPException(status_code=400, detail=f"{label} invalide. Format attendu : YYYY-MM-DDTHH:MM.")


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
        raise HTTPException(status_code=409, detail="Table tbl_calendrier_rh absente. Exécute le script SQL fourni avec le patch.")
    if not _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh"):
        raise HTTPException(status_code=409, detail="Table tbl_calendrier_suggestion_rh absente. Exécute le script SQL fourni avec le patch.")


def _suggestion_id(*parts: Any) -> str:
    raw = "|".join(_clean(p).lower() for p in parts if _clean(p))
    return str(uuid5(CALENDAR_UUID_NAMESPACE, raw or str(uuid4())))


def _priority_from_due(due_value: Optional[date], base: str = "normale") -> str:
    if due_value is None:
        return base
    today = date.today()
    if due_value < today:
        return "urgente"
    if due_value <= today + timedelta(days=14):
        return "haute"
    if due_value <= today + timedelta(days=45):
        return "normale"
    return "basse"


def _priority_rank(value: Optional[str]) -> int:
    v = _clean(value).lower()
    if v in ("urgente", "urgent"):
        return 4
    if v in ("haute", "élevée", "elevee"):
        return 3
    if v in ("normale", "normal"):
        return 2
    return 1


def _normalize_role_code(value: Any) -> str:
    v = _clean(value).lower()
    if v in ("admin", "administrator", "administrateur"):
        return "admin"
    if v in ("supervisor", "superviseur", "manager"):
        return "supervisor"
    return "user"


def _role_label(role_code: str) -> str:
    role = _normalize_role_code(role_code)
    if role == "admin":
        return "Administrateur"
    if role == "supervisor":
        return "Superviseur"
    return "Utilisateur"


def _fetch_role_for_request(cur, request: Request) -> str:
    email = ""
    try:
        auth = request.headers.get("Authorization", "")
        from app.routers.skills_portal_common import skills_require_user
        user = skills_require_user(auth)
        email = _clean(user.get("email")).lower()
    except Exception:
        email = ""

    if not email:
        return "user"

    cur.execute(
        """
        SELECT role_code
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND console_code = 'insights'
          AND lower(COALESCE(user_ref_type, '')) IN ('effectif_client', 'utilisateur')
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        ORDER BY
          CASE lower(COALESCE(role_code, ''))
            WHEN 'admin' THEN 0
            WHEN 'supervisor' THEN 1
            WHEN 'superviseur' THEN 1
            WHEN 'manager' THEN 1
            WHEN 'user' THEN 2
            ELSE 9
          END,
          id_access DESC
        LIMIT 1
        """,
        (email,),
    )
    row = cur.fetchone() or {}
    return _normalize_role_code(row.get("role_code"))


def _normalize_requested_service(value: Optional[str]) -> Optional[str]:
    raw = _clean(value)
    if not raw or raw in (ALL_ID, "__TOUS__"):
        return None
    return raw


def _fetch_service_name(cur, id_ent: str, id_service: Optional[str]) -> str:
    svc = _clean(id_service)
    if not svc:
        return "Tous les services"
    if svc == NON_LIE_ID:
        return "Non liés"
    cur.execute(
        """
        SELECT nom_service
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, svc),
    )
    row = cur.fetchone() or {}
    return row.get("nom_service") or "Service"


def _resolve_context(cur, id_contact: str, request: Request, requested_service: Optional[str] = None) -> Dict[str, Any]:
    id_effectif = resolve_insights_effectif_for_request(cur, id_contact, request)
    row_contact, row_ent = fetch_contact_with_entreprise(cur, id_effectif)

    id_ent = _clean(row_contact.get("id_ent") or row_ent.get("id_ent"))
    if not id_ent:
        raise HTTPException(status_code=403, detail="Entreprise Insights introuvable.")

    role = _fetch_role_for_request(cur, request)
    user_service = _clean(row_contact.get("id_service")) or None
    locked = role not in ("admin", "supervisor")

    if locked:
        effective_service = user_service or NON_LIE_ID
    else:
        effective_service = _normalize_requested_service(requested_service)

    return {
        "id_ent": id_ent,
        "id_manager": id_effectif,
        "id_service_user": user_service,
        "role_code": role,
        "role_label": _role_label(role),
        "locked_service": locked,
        "effective_service": effective_service,
        "nom_service": _fetch_service_name(cur, id_ent, effective_service),
        "nom_entreprise": row_ent.get("nom_ent"),
    }


def _service_where(alias: str, id_service: Optional[str], params: List[Any]) -> str:
    svc = _clean(id_service)
    if not svc:
        return ""
    if svc == NON_LIE_ID:
        return f" AND (COALESCE({alias}.id_service, '') = '') "
    params.append(svc)
    return f" AND {alias}.id_service = %s "


def _validate_effectif_in_scope(cur, ctx: Dict[str, Any], id_effectif: Optional[str]) -> Optional[Dict[str, Any]]:
    eff = _clean(id_effectif)
    if not eff:
        return None

    params: List[Any] = [ctx["id_ent"], eff]
    svc_where = _service_where("ec", ctx.get("effective_service"), params)
    cur.execute(
        f"""
        SELECT
          ec.id_effectif,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_effectif_client ec
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE ec.id_ent = %s
          AND ec.id_effectif = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(ec.statut_actif, TRUE) = TRUE
          {svc_where}
        LIMIT 1
        """,
        tuple(params),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=403, detail="Collaborateur hors périmètre ou archivé.")
    return row


def _event_type_label(value: Optional[str]) -> str:
    mapping = {
        "entretien_annuel": "Entretien annuel",
        "preparation_entretien": "Préparation entretien",
        "evaluation_competence": "Évaluation compétence",
        "signature": "Signature / validation",
        "suivi_post_formation": "Suivi post-formation",
        "campagne_rh": "Campagne RH",
        "action_rh": "Action RH",
        "evenement_rh": "Événement RH",
    }
    return mapping.get(_clean(value), _clean(value) or "Événement RH")


def _row_to_event(row: Dict[str, Any]) -> Dict[str, Any]:
    collaborateur = " ".join(
        [x for x in [_clean(row.get("prenom_effectif")), _clean(row.get("nom_effectif")).upper()] if x]
    ).strip()
    return {
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
        "source": row.get("source"),
        "id_suggestion_origine": row.get("id_suggestion_origine"),
        "id_service": row.get("id_service"),
        "nom_service": row.get("nom_service") or ("Non lié" if not _clean(row.get("id_service")) and row.get("id_effectif") else None),
        "collaborateur": collaborateur or None,
        "payload_json": row.get("payload_json") or {},
        "notification_json": row.get("notification_json") or {},
        "archive": bool(row.get("archive")),
        "created_at": _dt_to_str(row.get("created_at")),
        "updated_at": _dt_to_str(row.get("updated_at")),
        "is_overdue": bool(row.get("is_overdue")),
    }


def _row_to_suggestion(row: Dict[str, Any]) -> Dict[str, Any]:
    collaborateur = " ".join(
        [x for x in [_clean(row.get("prenom_effectif")), _clean(row.get("nom_effectif")).upper()] if x]
    ).strip()
    return {
        "id_suggestion": row.get("id_suggestion"),
        "id_ent": row.get("id_ent"),
        "id_manager": row.get("id_manager"),
        "id_effectif": row.get("id_effectif"),
        "collaborateur": collaborateur or row.get("collaborateur"),
        "id_service": row.get("id_service"),
        "nom_service": row.get("nom_service") or ("Non lié" if not _clean(row.get("id_service")) and row.get("id_effectif") else None),
        "type_suggestion": row.get("type_suggestion"),
        "type_label": _event_type_label(row.get("type_suggestion")),
        "titre": row.get("titre"),
        "date_echeance": _date_to_str(row.get("date_echeance")),
        "priorite": row.get("priorite") or "normale",
        "source": row.get("source") or "moteur",
        "statut": row.get("statut") or "proposee",
        "id_evenement": row.get("id_evenement"),
        "payload_json": row.get("payload_json") or {},
        "notification_json": row.get("notification_json") or {},
    }


# ======================================================
# Suggestions calculées V1
# ======================================================
def _fetch_suggestion_statuses(cur, ctx: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh"):
        return {}

    cur.execute(
        """
        SELECT id_suggestion, statut, id_evenement, archive
        FROM public.tbl_calendrier_suggestion_rh
        WHERE id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (ctx["id_ent"],),
    )
    return {str(r.get("id_suggestion")): dict(r) for r in (cur.fetchall() or []) if r.get("id_suggestion")}


def _apply_suggestion_status_filter(rows: List[Dict[str, Any]], statuses: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for row in rows:
        sid = _clean(row.get("id_suggestion"))
        st = statuses.get(sid) or {}
        statut = _clean(st.get("statut")).lower()
        if statut in ("ignoree", "ignorée", "planifiee", "planifiée"):
            continue
        if st.get("id_evenement"):
            continue
        out.append(row)
    return out


def _fetch_annual_interview_suggestions(cur, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    params: List[Any] = [ctx["id_ent"]]
    svc_where = _service_where("ec", ctx.get("effective_service"), params)
    cur.execute(
        f"""
        WITH last_entretien AS (
          SELECT
            ei.id_effectif_client AS id_effectif,
            MAX(COALESCE(ei.date_realisee, ei.date_prevue, ei.created_at::date)) AS last_date
          FROM public.tbl_entretien_individuel ei
          WHERE ei.id_ent = %s
            AND COALESCE(ei.archive, FALSE) = FALSE
            AND lower(COALESCE(ei.type_entretien, '')) LIKE '%%entretien%%'
          GROUP BY ei.id_effectif_client
        )
        SELECT
          ec.id_effectif,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service,
          le.last_date,
          COALESCE((le.last_date + INTERVAL '12 months')::date, CURRENT_DATE + 30) AS date_echeance
        FROM public.tbl_effectif_client ec
        LEFT JOIN last_entretien le
          ON le.id_effectif = ec.id_effectif
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE ec.id_ent = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(ec.statut_actif, TRUE) = TRUE
          {svc_where}
          AND (
            le.last_date IS NULL
            OR le.last_date <= (CURRENT_DATE - INTERVAL '11 months')::date
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_entretien_individuel future_ei
            WHERE future_ei.id_ent = ec.id_ent
              AND future_ei.id_effectif_client = ec.id_effectif
              AND COALESCE(future_ei.archive, FALSE) = FALSE
              AND future_ei.date_prevue >= CURRENT_DATE
              AND lower(COALESCE(future_ei.statut, '')) IN ('à réaliser', 'a réaliser', 'en cours', 'à signer', 'a signer', 'à signer 1/2', 'a signer 1/2', 'à signer 2/2', 'a signer 2/2')
          )
        ORDER BY date_echeance ASC, ec.nom_effectif ASC, ec.prenom_effectif ASC
        LIMIT 120
        """,
        tuple([ctx["id_ent"]] + params),
    )
    rows = cur.fetchall() or []

    out = []
    for r in rows:
        due = r.get("date_echeance")
        name = " ".join([_clean(r.get("prenom_effectif")), _clean(r.get("nom_effectif")).upper()]).strip() or "Collaborateur"
        out.append(
            {
                "id_suggestion": _suggestion_id(ctx["id_ent"], "entretien_annuel", r.get("id_effectif")),
                "id_ent": ctx["id_ent"],
                "id_manager": ctx["id_manager"],
                "id_effectif": r.get("id_effectif"),
                "nom_effectif": r.get("nom_effectif"),
                "prenom_effectif": r.get("prenom_effectif"),
                "id_service": r.get("id_service"),
                "nom_service": r.get("nom_service"),
                "type_suggestion": "entretien_annuel",
                "titre": f"Entretien annuel à planifier · {name}",
                "date_echeance": due,
                "priorite": _priority_from_due(due),
                "source": "moteur_entretien",
                "statut": "proposee",
                "payload_json": {
                    "regle": "dernier_entretien_absent_ou_ancien",
                    "last_entretien_date": _date_to_str(r.get("last_date")),
                },
                "notification_json": {"eligible": True, "canal_cible": ["in_app", "email"], "delai_rappel_jours": [7, 1]},
            }
        )
    return out


def _fetch_preparation_suggestions(cur, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    params: List[Any] = [ctx["id_ent"]]
    svc_where = _service_where("ec", ctx.get("effective_service"), params)
    cur.execute(
        f"""
        SELECT
          ei.id_entretien,
          ei.id_effectif_client AS id_effectif,
          ei.date_prevue,
          ei.preparation,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_entretien_individuel ei
        JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = ei.id_effectif_client
         AND ec.id_ent = ei.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
         AND COALESCE(ec.statut_actif, TRUE) = TRUE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE ei.id_ent = %s
          AND COALESCE(ei.archive, FALSE) = FALSE
          AND ei.date_prevue BETWEEN CURRENT_DATE AND (CURRENT_DATE + 21)
          AND lower(COALESCE(ei.statut, '')) IN ('à réaliser', 'a réaliser', 'en cours')
          AND (
            ei.preparation IS NULL
            OR ei.preparation = '{{}}'::jsonb
            OR ei.preparation::text = 'null'
          )
          {svc_where}
        ORDER BY ei.date_prevue ASC, ec.nom_effectif ASC, ec.prenom_effectif ASC
        LIMIT 80
        """,
        tuple(params),
    )
    rows = cur.fetchall() or []

    out = []
    for r in rows:
        due = r.get("date_prevue")
        name = " ".join([_clean(r.get("prenom_effectif")), _clean(r.get("nom_effectif")).upper()]).strip() or "Collaborateur"
        out.append(
            {
                "id_suggestion": _suggestion_id(ctx["id_ent"], "preparation_entretien", r.get("id_entretien")),
                "id_ent": ctx["id_ent"],
                "id_manager": ctx["id_manager"],
                "id_effectif": r.get("id_effectif"),
                "nom_effectif": r.get("nom_effectif"),
                "prenom_effectif": r.get("prenom_effectif"),
                "id_service": r.get("id_service"),
                "nom_service": r.get("nom_service"),
                "type_suggestion": "preparation_entretien",
                "titre": f"Préparation d’entretien à réaliser · {name}",
                "date_echeance": due,
                "priorite": _priority_from_due(due, "haute"),
                "source": "moteur_entretien",
                "statut": "proposee",
                "payload_json": {"id_entretien": r.get("id_entretien"), "date_prevue": _date_to_str(due)},
                "notification_json": {"eligible": True, "canal_cible": ["in_app"], "delai_rappel_jours": [5, 1]},
            }
        )
    return out


def _fetch_signature_suggestions(cur, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    params: List[Any] = [ctx["id_ent"]]
    svc_where = _service_where("ec", ctx.get("effective_service"), params)
    cur.execute(
        f"""
        SELECT
          ei.id_entretien,
          ei.id_effectif_client AS id_effectif,
          ei.date_realisee,
          ei.date_prevue,
          ei.statut,
          COALESCE(v.nb_signatures, 0) AS nb_signatures,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service
        FROM public.tbl_entretien_individuel ei
        JOIN public.tbl_effectif_client ec
          ON ec.id_effectif = ei.id_effectif_client
         AND ec.id_ent = ei.id_ent
         AND COALESCE(ec.archive, FALSE) = FALSE
         AND COALESCE(ec.statut_actif, TRUE) = TRUE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS nb_signatures
          FROM public.tbl_validations_electroniques ve
          WHERE ve.type_document = 'entretien_individuel'
            AND ve.id_document_ref = ei.id_entretien
            AND ve.id_ent = ei.id_ent
            AND COALESCE(ve.archive, FALSE) = FALSE
        ) v ON TRUE
        WHERE ei.id_ent = %s
          AND COALESCE(ei.archive, FALSE) = FALSE
          AND (
            lower(COALESCE(ei.statut, '')) IN ('à signer', 'a signer', 'à signer 1/2', 'a signer 1/2', 'à signer 2/2', 'a signer 2/2')
            OR (ei.date_realisee IS NOT NULL AND lower(COALESCE(ei.statut, '')) NOT IN ('terminé', 'termine', 'archivé', 'archive'))
          )
          AND COALESCE(v.nb_signatures, 0) < 2
          {svc_where}
        ORDER BY COALESCE(ei.date_realisee, ei.date_prevue, CURRENT_DATE) ASC, ec.nom_effectif ASC
        LIMIT 80
        """,
        tuple(params),
    )
    rows = cur.fetchall() or []

    out = []
    for r in rows:
        due = r.get("date_realisee") or r.get("date_prevue") or date.today()
        name = " ".join([_clean(r.get("prenom_effectif")), _clean(r.get("nom_effectif")).upper()]).strip() or "Collaborateur"
        out.append(
            {
                "id_suggestion": _suggestion_id(ctx["id_ent"], "signature", r.get("id_entretien")),
                "id_ent": ctx["id_ent"],
                "id_manager": ctx["id_manager"],
                "id_effectif": r.get("id_effectif"),
                "nom_effectif": r.get("nom_effectif"),
                "prenom_effectif": r.get("prenom_effectif"),
                "id_service": r.get("id_service"),
                "nom_service": r.get("nom_service"),
                "type_suggestion": "signature",
                "titre": f"Signature en attente · {name}",
                "date_echeance": due,
                "priorite": _priority_from_due(due, "haute"),
                "source": "moteur_signature",
                "statut": "proposee",
                "payload_json": {"id_entretien": r.get("id_entretien"), "nb_signatures": int(r.get("nb_signatures") or 0)},
                "notification_json": {"eligible": True, "canal_cible": ["in_app", "email"], "relance_retard": True},
            }
        )
    return out


def _fetch_competence_evaluation_suggestions(cur, ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    params: List[Any] = [ctx["id_ent"]]
    svc_where = _service_where("ec", ctx.get("effective_service"), params)
    cur.execute(
        f"""
        SELECT
          ec.id_effectif,
          ec.nom_effectif,
          ec.prenom_effectif,
          ec.id_service,
          org.nom_service,
          fp.id_poste,
          fp.intitule_poste,
          c.id_comp,
          c.code,
          c.intitule,
          fpc.poids_criticite,
          ecc.date_derniere_eval
        FROM public.tbl_effectif_client ec
        JOIN public.tbl_fiche_poste fp
          ON fp.id_poste = ec.id_poste_actuel
         AND fp.id_ent = ec.id_ent
         AND COALESCE(fp.actif, TRUE) = TRUE
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_poste = fp.id_poste
         AND COALESCE(fpc.masque, FALSE) = FALSE
         AND COALESCE(fpc.statut_eval, 'valide') <> 'refusé'
        JOIN public.tbl_competence c
          ON c.id_comp = fpc.id_competence
         AND COALESCE(c.masque, FALSE) = FALSE
         AND COALESCE(c.etat, 'valide') <> 'archive'
        LEFT JOIN public.tbl_effectif_client_competence ecc
          ON ecc.id_effectif_client = ec.id_effectif
         AND ecc.id_comp = c.id_comp
         AND COALESCE(ecc.archive, FALSE) = FALSE
         AND COALESCE(ecc.actif, TRUE) = TRUE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_service = ec.id_service
         AND org.id_ent = ec.id_ent
         AND COALESCE(org.archive, FALSE) = FALSE
        WHERE ec.id_ent = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(ec.statut_actif, TRUE) = TRUE
          AND COALESCE(fpc.poids_criticite, 0) >= 70
          AND (
            ecc.id_effectif_competence IS NULL
            OR ecc.date_derniere_eval IS NULL
            OR ecc.date_derniere_eval <= (CURRENT_DATE - INTERVAL '6 months')::date
          )
          {svc_where}
        ORDER BY COALESCE(fpc.poids_criticite, 0) DESC, ecc.date_derniere_eval ASC NULLS FIRST, ec.nom_effectif ASC
        LIMIT 120
        """,
        tuple(params),
    )
    rows = cur.fetchall() or []

    out = []
    for r in rows:
        due = date.today() + timedelta(days=30)
        name = " ".join([_clean(r.get("prenom_effectif")), _clean(r.get("nom_effectif")).upper()]).strip() or "Collaborateur"
        comp = _clean(r.get("intitule")) or "compétence critique"
        crit = int(r.get("poids_criticite") or 0)
        out.append(
            {
                "id_suggestion": _suggestion_id(ctx["id_ent"], "evaluation_competence", r.get("id_effectif"), r.get("id_comp")),
                "id_ent": ctx["id_ent"],
                "id_manager": ctx["id_manager"],
                "id_effectif": r.get("id_effectif"),
                "nom_effectif": r.get("nom_effectif"),
                "prenom_effectif": r.get("prenom_effectif"),
                "id_service": r.get("id_service"),
                "nom_service": r.get("nom_service"),
                "type_suggestion": "evaluation_competence",
                "titre": f"Évaluation compétence à programmer · {name}",
                "date_echeance": due,
                "priorite": "haute" if crit >= 85 else "normale",
                "source": "moteur_competences",
                "statut": "proposee",
                "payload_json": {
                    "id_comp": r.get("id_comp"),
                    "code_competence": r.get("code"),
                    "intitule_competence": comp,
                    "id_poste": r.get("id_poste"),
                    "intitule_poste": r.get("intitule_poste"),
                    "criticite": crit,
                    "date_derniere_eval": _date_to_str(r.get("date_derniere_eval")),
                },
                "notification_json": {"eligible": True, "canal_cible": ["in_app"], "delai_rappel_jours": [10, 2]},
            }
        )
    return out


def _computed_suggestions(cur, ctx: Dict[str, Any], type_filter: Optional[str] = None, priorite_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    requested_type = _clean(type_filter)

    if not requested_type or requested_type == "entretien_annuel":
        rows.extend(_fetch_annual_interview_suggestions(cur, ctx))
    if not requested_type or requested_type == "preparation_entretien":
        rows.extend(_fetch_preparation_suggestions(cur, ctx))
    if not requested_type or requested_type == "signature":
        rows.extend(_fetch_signature_suggestions(cur, ctx))
    if not requested_type or requested_type == "evaluation_competence":
        rows.extend(_fetch_competence_evaluation_suggestions(cur, ctx))

    statuses = _fetch_suggestion_statuses(cur, ctx)
    rows = _apply_suggestion_status_filter(rows, statuses)

    prio = _clean(priorite_filter).lower()
    if prio:
        rows = [r for r in rows if _clean(r.get("priorite")).lower() == prio]

    rows.sort(key=lambda r: (-_priority_rank(r.get("priorite")), r.get("date_echeance") or date.max, _clean(r.get("titre")).lower()))
    return [_row_to_suggestion(r) for r in rows]


def _find_computed_suggestion(cur, ctx: Dict[str, Any], id_suggestion: str) -> Optional[Dict[str, Any]]:
    wanted = _clean(id_suggestion)
    if not wanted:
        return None
    rows = _computed_suggestions(cur, ctx)
    for row in rows:
        if _clean(row.get("id_suggestion")) == wanted:
            return row
    return None


# ======================================================
# Routes API
# ======================================================
@router.get("/skills/calendrier/bootstrap/{id_contact}")
def calendrier_bootstrap(id_contact: str, request: Request, id_service: Optional[str] = Query(default=None)):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, id_service)
                sql_ready = _calendar_table_exists(cur, "tbl_calendrier_rh") and _calendar_table_exists(cur, "tbl_calendrier_suggestion_rh")

                cur.execute(
                    """
                    SELECT id_service, nom_service
                    FROM public.tbl_entreprise_organigramme
                    WHERE id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY lower(nom_service), nom_service
                    """,
                    (ctx["id_ent"],),
                )
                service_rows = cur.fetchall() or []

        services = []
        if ctx["locked_service"]:
            services.append({"id_service": ctx.get("effective_service"), "nom_service": ctx.get("nom_service")})
        else:
            services.append({"id_service": ALL_ID, "nom_service": "Tous les services"})
            services.extend({"id_service": r.get("id_service"), "nom_service": r.get("nom_service")} for r in service_rows)
            services.append({"id_service": NON_LIE_ID, "nom_service": "Non liés"})

        return {
            "context": {
                "id_ent": ctx["id_ent"],
                "id_manager": ctx["id_manager"],
                "nom_entreprise": ctx.get("nom_entreprise"),
                "role_code": ctx["role_code"],
                "role_label": ctx["role_label"],
            },
            "access": {
                "locked_service": ctx["locked_service"],
                "id_service_user": ctx.get("id_service_user"),
                "scope_id_service": ctx.get("effective_service"),
                "scope_label": ctx.get("nom_service"),
            },
            "services": services,
            "types_evenements": [
                {"id": "entretien_annuel", "label": "Entretien annuel"},
                {"id": "preparation_entretien", "label": "Préparation entretien"},
                {"id": "evaluation_competence", "label": "Évaluation compétence"},
                {"id": "signature", "label": "Signature / validation"},
                {"id": "suivi_post_formation", "label": "Suivi post-formation"},
                {"id": "campagne_rh", "label": "Campagne RH"},
                {"id": "action_rh", "label": "Action RH"},
                {"id": "evenement_rh", "label": "Événement RH"},
            ],
            "statuts": ["planifie", "en_cours", "réalisé", "annulé", "reporté"],
            "sql_ready": sql_ready,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur calendrier : {e}")


@router.get("/skills/calendrier/events/{id_contact}")
def calendrier_events(
    id_contact: str,
    request: Request,
    start: str = Query(...),
    end: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    type: Optional[str] = Query(default=None),
    statut: Optional[str] = Query(default=None),
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
                ctx = _resolve_context(cur, id_contact, request, id_service)
                if not _calendar_table_exists(cur, "tbl_calendrier_rh"):
                    return []

                params: List[Any] = [ctx["id_ent"], start_dt, end_dt]
                where = """
                    WHERE ev.id_ent = %s
                      AND COALESCE(ev.archive, FALSE) = FALSE
                      AND COALESCE(ev.date_fin, ev.date_debut) >= %s
                      AND ev.date_debut < %s
                """

                svc = _clean(ctx.get("effective_service"))
                if svc == NON_LIE_ID:
                    where += " AND (ev.id_effectif IS NULL OR COALESCE(ec.id_service, '') = '') "
                elif svc:
                    where += " AND ec.id_service = %s "
                    params.append(svc)

                typ = _clean(type)
                if typ:
                    where += " AND ev.type_evenement = %s "
                    params.append(typ)

                stat = _clean(statut)
                if stat:
                    where += " AND ev.statut = %s "
                    params.append(stat)

                eff = _clean(id_effectif)
                if eff:
                    where += " AND ev.id_effectif = %s "
                    params.append(eff)

                cur.execute(
                    f"""
                    SELECT
                      ev.*,
                      ec.nom_effectif,
                      ec.prenom_effectif,
                      ec.id_service,
                      org.nom_service,
                      (
                        ev.statut NOT IN ('réalisé', 'realise', 'annulé', 'annule')
                        AND COALESCE(ev.date_fin, ev.date_debut) < NOW()
                      ) AS is_overdue
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
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        return [_row_to_event(dict(r)) for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur calendrier : {e}")


@router.get("/skills/calendrier/suggestions/{id_contact}")
def calendrier_suggestions(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    type: Optional[str] = Query(default=None),
    priorite: Optional[str] = Query(default=None),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, id_service)
                return _computed_suggestions(cur, ctx, type, priorite)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur calendrier : {e}")


@router.post("/skills/calendrier/events/{id_contact}")
def calendrier_create_event(id_contact: str, payload: CalendrierEventPayload, request: Request):
    try:
        date_debut = _parse_datetime_param("date_debut", payload.date_debut)
        date_fin = _parse_datetime_param("date_fin", payload.date_fin) if _clean(payload.date_fin) else date_debut + timedelta(hours=1)
        if date_fin < date_debut:
            raise HTTPException(status_code=400, detail="date_fin doit être postérieure à date_debut.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, None)
                _ensure_calendar_tables(cur)
                eff = _validate_effectif_in_scope(cur, ctx, payload.id_effectif)

                id_evenement = str(uuid4())
                titre = _clean(payload.titre) or _event_type_label(payload.type_evenement)
                typ = _clean(payload.type_evenement) or "evenement_rh"
                statut = _clean(payload.statut) or "planifie"
                source = _clean(payload.source) or "manuel"

                cur.execute(
                    """
                    INSERT INTO public.tbl_calendrier_rh
                    (
                      id_evenement,
                      id_ent,
                      id_manager,
                      id_utilisateur,
                      id_effectif,
                      type_evenement,
                      titre,
                      date_debut,
                      date_fin,
                      statut,
                      source,
                      id_suggestion_origine,
                      payload_json,
                      notification_json,
                      archive,
                      created_at,
                      updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s::jsonb, %s::jsonb, FALSE, NOW(), NOW())
                    RETURNING *
                    """,
                    (
                        id_evenement,
                        ctx["id_ent"],
                        ctx["id_manager"],
                        ctx["id_manager"],
                        eff.get("id_effectif") if eff else None,
                        typ,
                        titre,
                        date_debut,
                        date_fin,
                        statut,
                        source,
                        json.dumps(payload.payload_json or {}, ensure_ascii=False),
                        json.dumps({"eligible": True, "source": source}, ensure_ascii=False),
                    ),
                )
                row = cur.fetchone()
                conn.commit()

                return _row_to_event(dict(row or {}))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur création événement calendrier : {e}")


@router.post("/skills/calendrier/events/from-suggestion/{id_contact}")
def calendrier_create_event_from_suggestion(id_contact: str, payload: CalendrierFromSuggestionPayload, request: Request):
    try:
        date_debut = _parse_datetime_param("date_debut", payload.date_debut)
        date_fin = _parse_datetime_param("date_fin", payload.date_fin) if _clean(payload.date_fin) else date_debut + timedelta(hours=1)
        if date_fin < date_debut:
            raise HTTPException(status_code=400, detail="date_fin doit être postérieure à date_debut.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, None)
                _ensure_calendar_tables(cur)

                suggestion = _find_computed_suggestion(cur, ctx, payload.id_suggestion)
                if not suggestion:
                    raise HTTPException(status_code=404, detail="Suggestion introuvable ou déjà traitée.")

                eff = _validate_effectif_in_scope(cur, ctx, suggestion.get("id_effectif"))
                id_evenement = str(uuid4())
                titre = _clean(payload.titre) or _clean(suggestion.get("titre")) or _event_type_label(suggestion.get("type_suggestion"))
                typ = _clean(suggestion.get("type_suggestion")) or "evenement_rh"
                statut = _clean(payload.statut) or "planifie"

                event_payload = dict(suggestion.get("payload_json") or {})
                event_payload.update({"id_suggestion": suggestion.get("id_suggestion"), "source_suggestion": suggestion.get("source")})
                notification_payload = dict(suggestion.get("notification_json") or {})
                notification_payload.update({"eligible": True, "base_calendrier": True})

                cur.execute(
                    """
                    INSERT INTO public.tbl_calendrier_rh
                    (
                      id_evenement,
                      id_ent,
                      id_manager,
                      id_utilisateur,
                      id_effectif,
                      type_evenement,
                      titre,
                      date_debut,
                      date_fin,
                      statut,
                      source,
                      id_suggestion_origine,
                      payload_json,
                      notification_json,
                      archive,
                      created_at,
                      updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, FALSE, NOW(), NOW())
                    RETURNING *
                    """,
                    (
                        id_evenement,
                        ctx["id_ent"],
                        ctx["id_manager"],
                        ctx["id_manager"],
                        eff.get("id_effectif") if eff else None,
                        typ,
                        titre,
                        date_debut,
                        date_fin,
                        statut,
                        "suggestion",
                        suggestion.get("id_suggestion"),
                        json.dumps(event_payload, ensure_ascii=False),
                        json.dumps(notification_payload, ensure_ascii=False),
                    ),
                )
                row = cur.fetchone()

                cur.execute(
                    """
                    INSERT INTO public.tbl_calendrier_suggestion_rh
                    (
                      id_suggestion,
                      id_ent,
                      id_manager,
                      id_effectif,
                      type_suggestion,
                      titre,
                      date_echeance,
                      priorite,
                      source,
                      statut,
                      id_evenement,
                      payload_json,
                      notification_json,
                      archive,
                      created_at,
                      updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'planifiee', %s, %s::jsonb, %s::jsonb, FALSE, NOW(), NOW())
                    ON CONFLICT (id_suggestion)
                    DO UPDATE SET
                      statut = 'planifiee',
                      id_evenement = EXCLUDED.id_evenement,
                      updated_at = NOW(),
                      archive = FALSE
                    """,
                    (
                        suggestion.get("id_suggestion"),
                        ctx["id_ent"],
                        ctx["id_manager"],
                        suggestion.get("id_effectif"),
                        suggestion.get("type_suggestion"),
                        suggestion.get("titre"),
                        _parse_date_param("date_echeance", suggestion.get("date_echeance")) if suggestion.get("date_echeance") else None,
                        suggestion.get("priorite") or "normale",
                        suggestion.get("source") or "moteur",
                        id_evenement,
                        json.dumps(suggestion.get("payload_json") or {}, ensure_ascii=False),
                        json.dumps(suggestion.get("notification_json") or {}, ensure_ascii=False),
                    ),
                )
                conn.commit()

                return _row_to_event(dict(row or {}))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur planification suggestion calendrier : {e}")


@router.patch("/skills/calendrier/events/{id_contact}/{id_evenement}")
def calendrier_patch_event(id_contact: str, id_evenement: str, payload: CalendrierEventPatchPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, None)
                _ensure_calendar_tables(cur)

                cur.execute(
                    """
                    SELECT id_evenement, id_effectif
                    FROM public.tbl_calendrier_rh
                    WHERE id_evenement = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (_clean(id_evenement), ctx["id_ent"]),
                )
                current = cur.fetchone()
                if current is None:
                    raise HTTPException(status_code=404, detail="Événement calendrier introuvable.")

                updates = []
                params: List[Any] = []

                if payload.type_evenement is not None:
                    updates.append("type_evenement = %s")
                    params.append(_clean(payload.type_evenement) or "evenement_rh")
                if payload.titre is not None:
                    updates.append("titre = %s")
                    params.append(_clean(payload.titre) or "Événement RH")
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
                    eff = _validate_effectif_in_scope(cur, ctx, payload.id_effectif)
                    updates.append("id_effectif = %s")
                    params.append(eff.get("id_effectif") if eff else None)
                if payload.payload_json is not None:
                    updates.append("payload_json = %s::jsonb")
                    params.append(json.dumps(payload.payload_json or {}, ensure_ascii=False))

                if not updates:
                    raise HTTPException(status_code=400, detail="Aucune modification fournie.")

                updates.append("updated_at = NOW()")
                params.extend([_clean(id_evenement), ctx["id_ent"]])

                cur.execute(
                    f"""
                    UPDATE public.tbl_calendrier_rh
                    SET {', '.join(updates)}
                    WHERE id_evenement = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING *
                    """,
                    tuple(params),
                )
                row = cur.fetchone()
                conn.commit()
                return _row_to_event(dict(row or {}))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur modification événement calendrier : {e}")


@router.patch("/skills/calendrier/suggestions/{id_contact}/{id_suggestion}/ignore")
def calendrier_ignore_suggestion(id_contact: str, id_suggestion: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = _resolve_context(cur, id_contact, request, None)
                _ensure_calendar_tables(cur)

                suggestion = _find_computed_suggestion(cur, ctx, id_suggestion) or {
                    "id_suggestion": _clean(id_suggestion),
                    "id_effectif": None,
                    "type_suggestion": "evenement_rh",
                    "titre": "Suggestion ignorée",
                    "date_echeance": None,
                    "priorite": "normale",
                    "source": "moteur",
                    "payload_json": {},
                    "notification_json": {},
                }

                cur.execute(
                    """
                    INSERT INTO public.tbl_calendrier_suggestion_rh
                    (
                      id_suggestion,
                      id_ent,
                      id_manager,
                      id_effectif,
                      type_suggestion,
                      titre,
                      date_echeance,
                      priorite,
                      source,
                      statut,
                      id_evenement,
                      payload_json,
                      notification_json,
                      archive,
                      created_at,
                      updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'ignoree', NULL, %s::jsonb, %s::jsonb, FALSE, NOW(), NOW())
                    ON CONFLICT (id_suggestion)
                    DO UPDATE SET
                      statut = 'ignoree',
                      id_evenement = NULL,
                      updated_at = NOW(),
                      archive = FALSE
                    """,
                    (
                        suggestion.get("id_suggestion"),
                        ctx["id_ent"],
                        ctx["id_manager"],
                        suggestion.get("id_effectif"),
                        suggestion.get("type_suggestion"),
                        suggestion.get("titre"),
                        _parse_date_param("date_echeance", suggestion.get("date_echeance")) if suggestion.get("date_echeance") else None,
                        suggestion.get("priorite") or "normale",
                        suggestion.get("source") or "moteur",
                        json.dumps(suggestion.get("payload_json") or {}, ensure_ascii=False),
                        json.dumps(suggestion.get("notification_json") or {}, ensure_ascii=False),
                    ),
                )
                conn.commit()

        return {"ok": True, "id_suggestion": _clean(id_suggestion), "statut": "ignoree"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur archivage suggestion calendrier : {e}")
