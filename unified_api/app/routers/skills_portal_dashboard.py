from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    fetch_contact_with_entreprise,
    resolve_insights_effectif_for_request,
)
from app.services.skills_analyse_engine import (
    CRITICITE_MIN_DEFAULT,
    NON_LIE_ID,
    _dashboard_compute_health_from_records,
    _dashboard_compute_postes_watch_from_records,
    _dashboard_fetch_current_competence_records,
    _dashboard_compute_reliability,
    _dashboard_compute_risk_timeline,
    _dashboard_compute_risks_without_action,
    _dashboard_compute_transmission_capacity,
    _dashboard_fetch_current_poste_records,
    _dashboard_normalize_criticite_min,
    _dashboard_enrich_records_poste_criticite as _enrich_records_poste_criticite,
    _fetch_service_label,
)

router = APIRouter()

DASHBOARD_DANGER_MIN = 65
DASHBOARD_WATCH_MIN = 25
DASHBOARD_CRITICAL_POSTE_MIN = 3
DASHBOARD_RELIABILITY_MONTHS = 6
DASHBOARD_NO_ACTION_LIMIT = 100


# ======================================================
# Modèles
# ======================================================
class SkillsContext(BaseModel):
    id_contact: str
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: str
    role_code: Optional[str] = None
    id_service: Optional[str] = None


class DashboardServiceOption(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class DashboardAccess(BaseModel):
    role_code: str = "user"
    locked_service: bool = True
    id_service_user: Optional[str] = None


class DashboardScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str = "Tous les services"


class DashboardFilters(BaseModel):
    criticite_min: int = CRITICITE_MIN_DEFAULT


class DashboardHealth(BaseModel):
    pct: float = 0.0
    score: float = 0.0
    max_score: float = 0.0
    nb_items: int = 0
    scope_label: str = "Tous les services"
    components: List[Dict[str, Any]] = Field(default_factory=list)
    postes_fragilite_moyenne: int = 0
    competences_fragilite_moyenne: int = 0


class DashboardRiskTimelinePoint(BaseModel):
    date_ref: str
    label: str
    indice_fragilite: int = 0
    nb_postes_fragiles: int = 0
    nb_postes_total: int = 0


class DashboardPostesWatch(BaseModel):
    total_postes: int = 0
    postes_danger: int = 0
    postes_surveillance: int = 0
    postes_stables: int = 0
    postes_critiques_danger: int = 0


class DashboardTransmission(BaseModel):
    pct: float = 0.0
    # Champs historiques conservés pour compatibilité API.
    # Ils reprennent désormais les volumes de compétences, car la capacité
    # de transmission ne se calcule plus par poste.
    postes_total: int = 0
    postes_transmissibles: int = 0
    postes_risque: int = 0
    competences_total: int = 0
    competences_transmissibles: int = 0
    competences_risque: int = 0
    transmission_valides_count: int = 0
    transmission_confirm_count: int = 0
    transmission_review_count: int = 0
    sans_transmetteur_count: int = 0
    transmetteurs_identifies_count: int = 0
    threshold_score: int = 63
    threshold_label: str = "Avancé haut ou Expert"
    seuil_mois: int = DASHBOARD_RELIABILITY_MONTHS


class DashboardReliability(BaseModel):
    pct: float = 0.0
    fresh_items: int = 0
    stale_items: int = 0
    total_items: int = 0
    seuil_mois: int = DASHBOARD_RELIABILITY_MONTHS


class DashboardRiskWithoutActionRow(BaseModel):
    id_poste: str
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: str
    nom_service: Optional[str] = None
    indice_fragilite: int = 0
    criticite_poste: int = 0
    nb_titulaires: int = 0
    nb_titulaires_cible: int = 0
    nb_critiques_fragiles: int = 0
    nb_critiques_sans_porteur: int = 0
    nb_critiques_sans_releve: int = 0


class DashboardRisksWithoutAction(BaseModel):
    total: int = 0
    items: List[DashboardRiskWithoutActionRow] = []


class DashboardRiskOverview(BaseModel):
    access: DashboardAccess
    scope: DashboardScope
    services: List[DashboardServiceOption]
    filters: DashboardFilters
    health: DashboardHealth
    risk_timeline: List[DashboardRiskTimelinePoint]
    postes_watch: DashboardPostesWatch
    transmission: DashboardTransmission
    reliability: DashboardReliability
    risks_without_action: DashboardRisksWithoutAction


# ======================================================
# Helpers contexte / scope
# ======================================================
def _resolve_effectif_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_effectif_for_request(cur, id_contact, request)


def _normalize_role_code(v: Any) -> str:
    s = str(v or "").strip().lower()
    if s in ("admin", "administrator", "administrateur"):
        return "admin"
    if s in ("supervisor", "superviseur", "manager"):
        return "supervisor"
    return "user"


def _role_rank(role_code: str) -> int:
    r = _normalize_role_code(role_code)
    if r == "admin":
        return 0
    if r == "supervisor":
        return 1
    return 2


def _fetch_role_for_request(cur, id_effectif: str, request: Request) -> str:
    email = ""
    try:
        auth = request.headers.get("Authorization", "")
        from app.routers.skills_portal_common import skills_require_user
        u = skills_require_user(auth)
        email = (u.get("email") or "").strip().lower()
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


def _service_options(cur, id_ent: str, access: DashboardAccess, scope: DashboardScope) -> List[DashboardServiceOption]:
    if access.locked_service:
        return [DashboardServiceOption(id_service=scope.id_service, nom_service=scope.nom_service)]

    cur.execute(
        """
        SELECT o.id_service, o.nom_service
        FROM public.tbl_entreprise_organigramme o
        WHERE o.id_ent = %s
          AND COALESCE(o.archive, FALSE) = FALSE
        ORDER BY lower(o.nom_service), o.nom_service
        """,
        (id_ent,),
    )
    rows = cur.fetchall() or []

    out = [DashboardServiceOption(id_service=None, nom_service="Tout")]
    out.extend(
        DashboardServiceOption(
            id_service=r.get("id_service"),
            nom_service=r.get("nom_service") or "Service",
        )
        for r in rows
    )
    out.append(DashboardServiceOption(id_service=NON_LIE_ID, nom_service="Non liés (sans service)"))
    return out


def _dashboard_context(cur, id_contact: str, request: Request, requested_service: Optional[str]) -> Tuple[str, DashboardAccess, DashboardScope, List[DashboardServiceOption]]:
    eff_id = _resolve_effectif_for_request(cur, id_contact, request)
    row_contact, row_ent = fetch_contact_with_entreprise(cur, eff_id)

    id_ent = (row_contact.get("id_ent") or row_ent.get("id_ent") or "").strip()
    if not id_ent:
        raise HTTPException(status_code=403, detail="Entreprise Insights introuvable.")

    role = _fetch_role_for_request(cur, eff_id, request)
    id_service_user = (row_contact.get("id_service") or "").strip() or None

    is_global_allowed = role in ("admin", "supervisor")
    locked = not is_global_allowed

    if locked:
        effective_service = id_service_user or NON_LIE_ID
    else:
        rs = (requested_service or "").strip()
        effective_service = None if not rs or rs == "__ALL__" else rs

    scope_raw = _fetch_service_label(cur, id_ent, effective_service)
    scope = DashboardScope(
        id_service=scope_raw.id_service,
        nom_service=scope_raw.nom_service,
    )
    access = DashboardAccess(
        role_code=role,
        locked_service=locked,
        id_service_user=id_service_user,
    )
    services = _service_options(cur, id_ent, access, scope)
    return id_ent, access, scope, services


# ======================================================
# Calculs
# ======================================================
# Les calculs métier du dashboard sont centralisés dans
# app.services.skills_analyse_engine. Ce routeur ne fait plus que résoudre
# le contexte, appeler le moteur et mapper les dictionnaires vers les modèles API.


def _model(model_cls, payload):
    if isinstance(payload, model_cls):
        return payload
    return model_cls(**dict(payload or {}))


def _model_list(model_cls, rows):
    return [_model(model_cls, r) for r in (rows or [])]


def _as_payload(value):
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return dict(value or {})


# ======================================================
# Builder commun
# ======================================================
def build_dashboard_risk_overview_for_scope(
    cur,
    id_ent: str,
    access: DashboardAccess,
    scope: DashboardScope,
    services: List[DashboardServiceOption],
    criticite_min: Optional[int] = None,
) -> DashboardRiskOverview:
    """
    Moteur unique du dashboard Insights.
    Utilisé par :
    - la console Insights classique (/skills/dashboard/...), avec auth Insights ;
    - Studio > Espace de gestion en mode embarqué (/studio/clients/.../dashboard/...), avec auth Studio.

    Toute évolution des indicateurs doit passer ici pour éviter deux calculs divergents.
    """
    criticite = _dashboard_normalize_criticite_min(criticite_min)

    current_records = _dashboard_fetch_current_poste_records(
        cur,
        id_ent,
        scope.id_service,
        criticite,
    )

    competence_records = _dashboard_fetch_current_competence_records(
        cur,
        id_ent,
        scope.id_service,
        criticite,
    )

    risk_timeline = _model_list(
        DashboardRiskTimelinePoint,
        _dashboard_compute_risk_timeline(cur, id_ent, scope.id_service, current_records, criticite),
    )
    postes_watch = _model(
        DashboardPostesWatch,
        _dashboard_compute_postes_watch_from_records(
            current_records,
            danger_min=DASHBOARD_DANGER_MIN,
            watch_min=DASHBOARD_WATCH_MIN,
            critical_poste_min=DASHBOARD_CRITICAL_POSTE_MIN,
        ),
    )
    transmission = _model(
        DashboardTransmission,
        _dashboard_compute_transmission_capacity(
            cur,
            id_ent,
            scope.id_service,
            criticite,
            seuil_mois=DASHBOARD_RELIABILITY_MONTHS,
        ),
    )
    reliability = _model(
        DashboardReliability,
        _dashboard_compute_reliability(
            cur,
            id_ent,
            scope.id_service,
            criticite,
            seuil_mois=DASHBOARD_RELIABILITY_MONTHS,
        ),
    )
    health = _model(
        DashboardHealth,
        _dashboard_compute_health_from_records(
            current_records,
            scope.nom_service,
            competence_records=competence_records,
            transmission=_as_payload(transmission),
            reliability=_as_payload(reliability),
        ),
    )
    risks_without_action = _model(
        DashboardRisksWithoutAction,
        _dashboard_compute_risks_without_action(
            cur,
            id_ent,
            scope.id_service,
            current_records,
            danger_min=DASHBOARD_DANGER_MIN,
            limit=DASHBOARD_NO_ACTION_LIMIT,
        ),
    )

    return DashboardRiskOverview(
        access=access,
        scope=scope,
        services=services,
        filters=DashboardFilters(criticite_min=criticite),
        health=health,
        risk_timeline=risk_timeline,
        postes_watch=postes_watch,
        transmission=transmission,
        reliability=reliability,
        risks_without_action=risks_without_action,
    )


# ======================================================
# Routes
# ======================================================
@router.get("/skills/context/{id_contact}", response_model=SkillsContext)
def get_skills_context(id_contact: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                eff_id = _resolve_effectif_for_request(cur, id_contact, request)
                row_contact, _ = fetch_contact_with_entreprise(cur, eff_id)
                role = _fetch_role_for_request(cur, eff_id, request)

        return SkillsContext(
            id_contact=row_contact["id_contact"],
            civilite=row_contact.get("civ_ca"),
            prenom=row_contact.get("prenom_ca"),
            nom=row_contact["nom_ca"],
            role_code=role,
            id_service=row_contact.get("id_service"),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get("/skills/dashboard/risk-overview/{id_contact}", response_model=DashboardRiskOverview)
def get_dashboard_risk_overview(id_contact: str, request: Request, id_service: Optional[str] = None, criticite_min: Optional[int] = None):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent, access, scope, services = _dashboard_context(cur, id_contact, request, id_service)
                return build_dashboard_risk_overview_for_scope(
                    cur,
                    id_ent=id_ent,
                    access=access,
                    scope=scope,
                    services=services,
                    criticite_min=criticite_min,
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
