from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner
from app.routers.skills_portal_dashboard import (
    DASHBOARD_CRITICAL_POSTE_MIN,
    DASHBOARD_DANGER_MIN,
    DASHBOARD_WATCH_MIN,
    DashboardScope,
    _enrich_records_poste_criticite,
    DashboardAccess,
    build_dashboard_risk_overview_for_scope,
    _service_options,
)
from app.services.skills_analyse_engine import _fetch_postes_fragility_records, _fetch_service_label

router = APIRouter()


class StudioContext(BaseModel):
    id_owner: str
    nom_owner: str
    email: str
    prenom: Optional[str] = None
    role_code: Optional[str] = None
    role_label: Optional[str] = None


def _require_owner_access(cur, u: dict, id_owner: str):
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = (u.get("email") or "").strip()
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
    ok = cur.fetchone()
    if not ok:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid

def _has_column(cur, table_name: str, column_name: str, schema: str = "public") -> bool:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
          AND column_name = %s
        LIMIT 1
        """,
        (schema, table_name, column_name),
    )
    return cur.fetchone() is not None

def _resolve_prenom(cur, email: str, id_owner: str) -> Optional[str]:
    e = (email or "").strip()
    oid = (id_owner or "").strip()
    if not e or not oid:
        return None

    cur.execute(
        """
        SELECT user_ref_type, id_user_ref
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (e, oid),
    )
    m = cur.fetchone() or {}
    ref_type = (m.get("user_ref_type") or "").strip().lower()
    ref_id = (m.get("id_user_ref") or "").strip()

    if ref_type == "utilisateur" and ref_id:
        has_arch = _has_column(cur, "tbl_utilisateur", "archive")
        if has_arch:
            cur.execute(
                """
                SELECT ut_prenom
                FROM public.tbl_utilisateur
                WHERE id_utilisateur = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (ref_id,),
            )
        else:
            cur.execute(
                """
                SELECT ut_prenom
                FROM public.tbl_utilisateur
                WHERE id_utilisateur = %s
                LIMIT 1
                """,
                (ref_id,),
            )

        r = cur.fetchone() or {}
        v = (r.get("ut_prenom") or "").strip()
        return v or None

    if ref_type == "effectif_client" and ref_id:
        has_arch = _has_column(cur, "tbl_effectif_client", "archive")
        if has_arch:
            cur.execute(
                """
                SELECT prenom_effectif
                FROM public.tbl_effectif_client
                WHERE id_effectif = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (ref_id,),
            )
        else:
            cur.execute(
                """
                SELECT prenom_effectif
                FROM public.tbl_effectif_client
                WHERE id_effectif = %s
                LIMIT 1
                """,
                (ref_id,),
            )

        r = cur.fetchone() or {}
        v = (r.get("prenom_effectif") or "").strip()
        return v or None

    return None

def _role_code_to_label(code: str) -> Optional[str]:
    c = (code or "").strip().lower()
    if c == "admin":
        return "Administrateur"
    if c == "supervisor":
        return "Superviseur"
    if c == "user":
        return "Utilisateur"
    return None


def _fetch_role_code(cur, email: str, id_owner: str, is_super_admin: bool) -> str:
    if is_super_admin:
        return "admin"

    e = (email or "").strip()
    oid = (id_owner or "").strip()
    if not e or not oid:
        return "user"

    cur.execute(
        """
        SELECT role_code
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (e, oid),
    )
    r = cur.fetchone() or {}
    rc = (r.get("role_code") or "user").strip().lower()
    if rc not in ("admin", "supervisor", "user"):
        rc = "user"
    return rc

@router.get("/studio/context/{id_owner}", response_model=StudioContext)
def get_studio_context(id_owner: str, request: Request):
    """
    Contexte minimal pour dashboard/topbar Studio:
    - owner (id_owner, nom_owner)
    - user (email, prenom)
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                ow = studio_fetch_owner(cur, oid)
                prenom = _resolve_prenom(cur, u.get("email") or "", oid)

                role_code = _fetch_role_code(cur, u.get("email") or "", oid, bool(u.get("is_super_admin")))
                role_label = _role_code_to_label(role_code)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/context error: {e}")

    return StudioContext(
        id_owner=ow.get("id_owner"),
        nom_owner=ow.get("nom_owner"),
        email=(u.get("email") or "").strip(),
        prenom=prenom,
        role_code=role_code,
        role_label=role_label,
    )


# ======================================================
# Dashboard Studio global : ma structure d'abord / supervision liée ensuite
# ======================================================
def _studio_i(v, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(v))
    except Exception:
        return default


def _studio_f(v, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except Exception:
        return default


def _studio_s(v) -> str:
    return (v or "").strip() if isinstance(v, str) else str(v or "").strip()


def _studio_has_table(cur, table_name: str, schema: str = "public") -> bool:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = %s
          AND table_name = %s
        LIMIT 1
        """,
        (schema, table_name),
    )
    return cur.fetchone() is not None


def _studio_norm_priorite(v: str) -> str:
    s = _studio_s(v).lower()
    return s if s in ("tous", "danger", "surveillance", "stable") else "tous"


def _studio_norm_criticite(v) -> int:
    n = _studio_i(v, 70)
    return max(0, min(100, n))


def _studio_fetch_owner_structure(cur, id_owner: str, nom_owner: str = "") -> Dict[str, Any]:
    """
    Retourne la structure interne du Studio owner.

    Règle de raccordement : dans Studio, "ma structure" reste l'id_owner.
    Si la ligne tbl_entreprise n'existe pas encore pour cet id, on analyse tout de
    même les postes, effectifs, entretiens et demandes rattachés à id_ent = id_owner.
    On ne bascule jamais sur le premier client lié.
    """
    cur.execute(
        """
        SELECT e.id_ent, e.nom_ent, e.type_entreprise, e.ville_ent, e.pays_ent, e.effectif_ent,
               TRUE AS is_real_entity
        FROM public.tbl_entreprise e
        WHERE e.id_ent = %s
          AND COALESCE(e.masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_owner,),
    )
    r = cur.fetchone()
    if r:
        return dict(r)

    return {
        "id_ent": id_owner,
        "nom_ent": nom_owner or "Ma structure",
        "type_entreprise": "Structure gestionnaire",
        "ville_ent": None,
        "pays_ent": None,
        "effectif_ent": None,
        "is_real_entity": True,
    }

def _studio_fetch_linked_structures(cur, id_owner: str, root_id: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if _studio_has_table(cur, "tbl_entreprise_liaison"):
        cur.execute(
            """
            WITH RECURSIVE subtree AS (
              SELECT l.id_ent_enfant AS id_ent, 1 AS depth
              FROM public.tbl_entreprise_liaison l
              WHERE l.id_ent_parent = %s
                AND COALESCE(l.archive, FALSE) = FALSE

              UNION ALL

              SELECT l2.id_ent_enfant AS id_ent, s.depth + 1 AS depth
              FROM public.tbl_entreprise_liaison l2
              JOIN subtree s ON s.id_ent = l2.id_ent_parent
              WHERE COALESCE(l2.archive, FALSE) = FALSE
                AND s.depth < 8
            )
            SELECT DISTINCT ON (e.id_ent)
                e.id_ent, e.nom_ent, e.type_entreprise, e.ville_ent, e.pays_ent, e.effectif_ent, s.depth
            FROM subtree s
            JOIN public.tbl_entreprise e ON e.id_ent = s.id_ent
            WHERE e.id_owner_gestionnaire = %s
              AND COALESCE(e.masque, FALSE) = FALSE
              AND e.id_ent <> %s
            ORDER BY e.id_ent, s.depth
            """,
            (root_id, id_owner, root_id),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]

    if rows:
        return sorted(rows, key=lambda x: (_studio_i(x.get("depth"), 1), (_studio_s(x.get("nom_ent"))).lower(), _studio_s(x.get("id_ent"))))

    cur.execute(
        """
        SELECT e.id_ent, e.nom_ent, e.type_entreprise, e.ville_ent, e.pays_ent, e.effectif_ent, 1 AS depth
        FROM public.tbl_entreprise e
        WHERE e.id_owner_gestionnaire = %s
          AND e.id_ent <> %s
          AND COALESCE(e.masque, FALSE) = FALSE
        ORDER BY lower(e.nom_ent), e.id_ent
        LIMIT 160
        """,
        (id_owner, root_id),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _studio_fetch_services(cur, id_ent: str) -> List[Dict[str, Any]]:
    if not _studio_has_table(cur, "tbl_entreprise_organigramme"):
        return []
    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT s.id_service, s.nom_service, s.id_service_parent, 0 AS depth, (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') IS NULL

          UNION ALL

          SELECT c.id_service, c.nom_service, c.id_service_parent, p.depth + 1 AS depth, (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p ON p.id_service = c.id_service_parent
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        )
        SELECT id_service, nom_service, id_service_parent, depth
        FROM svc
        ORDER BY path
        """,
        (id_ent, id_ent),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _studio_priority_from_risk(risk_pct: float, postes_danger: int, critical_danger: int) -> tuple[str, str]:
    if critical_danger > 0 or risk_pct >= 60:
        return "danger", "En danger"
    if postes_danger > 0 or risk_pct >= 1:
        return "surveillance", "À surveiller"
    return "stable", "Stable"


def _studio_model_to_dict(obj) -> Dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return dict(obj) if hasattr(obj, "items") else {}


def _studio_fetch_insights_overview(cur, id_ent: str, id_service: Optional[str], criticite: int) -> Dict[str, Any]:
    """
    Appel du moteur officiel du dashboard Insights.
    Studio ne recalcule pas les KPI principaux : il les consomme, sinon les écarts
    Insights/Studio réapparaissent et tout le monde finit par comparer des pourcentages
    au lieu de travailler. Passionnant, mais non.
    """
    scope_raw = _fetch_service_label(cur, id_ent, id_service)
    scope = DashboardScope(
        id_service=getattr(scope_raw, "id_service", None),
        nom_service=getattr(scope_raw, "nom_service", None) or "Tous les services",
    )
    access = DashboardAccess(role_code="admin", locked_service=False, id_service_user=None)
    services = _service_options(cur, id_ent, access, scope)
    overview = build_dashboard_risk_overview_for_scope(
        cur,
        id_ent=id_ent,
        access=access,
        scope=scope,
        services=services,
        criticite_min=criticite,
    )
    return _studio_model_to_dict(overview)


def _studio_empty_main_for_missing_structure(current: Dict[str, Any]) -> Dict[str, Any]:
    label = current.get("nom_ent") or "Ma structure"
    return {
        "scope_label": f"{label} n'est pas encore rattachée à une structure entreprise exploitable.",
        "risk_title": "Services à surveiller",
        "risk_subtitle": "Aucune structure interne exploitable pour ce Studio owner.",
        "risk_kind": "service",
        "no_structure": True,
        "portfolio": {
            "postes_total": 0,
            "postes_danger": 0,
            "postes_surveillance": 0,
            "postes_stables": 0,
            "postes_critiques_danger": 0,
            "risk_pct": 0,
            "health_pct": 0,
            "health_label": "Structure non créée",
            "risques_sans_action": 0,
            "items_danger": 0,
            "items_surveillance": 0,
            "items_stables": 0,
        },
        "risk_items": [],
        "demandes_formation": {"ouvertes": 0, "urgentes": 0, "prises_en_charge": 0, "a_instruire": 0, "items": []},
        "entretiens": {"a_realiser": 0, "en_cours": 0, "a_signer": 0, "ouverts": 0},
        "referentiel": {"postes_total": 0, "postes_sans_competence": 0, "competences_sans_domaine": 0, "collaborateurs_sans_poste": 0},
        "transmission": {"pct": 0, "postes_total": 0, "postes_transmissibles": 0, "postes_risque": 0},
        "reliability": {"pct": 0},
        "actions_prioritaires": [{
            "type_action": "referentiel",
            "priority": "surveillance",
            "priority_label": "Structure",
            "title": "Créer ou rattacher la structure interne",
            "subtitle": "Structure interne à compléter.",
        }],
    }



def _studio_risk_items_by_service(cur, id_ent: str, services: List[Dict[str, Any]], criticite_min: int) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for s in services:
        sid = _studio_s(s.get("id_service"))
        if not sid:
            continue
        try:
            overview = _studio_fetch_insights_overview(cur, id_ent, sid, criticite_min)
        except Exception:
            overview = {}

        health = overview.get("health") or {}
        watch = overview.get("postes_watch") or {}
        no_action = overview.get("risks_without_action") or {}

        postes_total = _studio_i(watch.get("total_postes"))
        postes_danger = _studio_i(watch.get("postes_danger"))
        postes_surveillance = _studio_i(watch.get("postes_surveillance"))
        postes_critiques = _studio_i(watch.get("postes_critiques_danger"))
        health_pct = round(_studio_f(health.get("pct")), 1)
        risk_pct = round(max(0.0, 100.0 - health_pct), 1) if postes_total else 0.0
        priority, priority_label = _studio_priority_from_risk(risk_pct, postes_danger, postes_critiques)

        items.append({
            "kind": "service",
            "id_service": sid,
            "label": s.get("nom_service") or "Service",
            "nom_service": s.get("nom_service") or "Service",
            "postes_total": postes_total,
            "postes_danger": postes_danger,
            "postes_surveillance": postes_surveillance,
            "risques_sans_action": _studio_i(no_action.get("total")),
            "risk_pct": risk_pct,
            "priority": priority,
            "priority_label": priority_label,
        })
    return sorted(items, key=lambda x: (0 if x.get("priority") == "danger" else 1 if x.get("priority") == "surveillance" else 2, -_studio_f(x.get("risk_pct")), x.get("label") or ""))

def _studio_risk_items_by_poste(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for r in records or []:
        frag = _studio_f(r.get("indice_fragilite"))
        crit = _studio_i(r.get("criticite_poste"), 2)
        priority, priority_label = _studio_priority_from_risk(frag, 1 if frag >= DASHBOARD_DANGER_MIN else 0, 1 if (frag >= DASHBOARD_DANGER_MIN and crit >= DASHBOARD_CRITICAL_POSTE_MIN) else 0)
        items.append({
            "kind": "poste",
            "id_poste": r.get("id_poste"),
            "label": r.get("intitule_poste") or r.get("poste") or "Poste",
            "intitule_poste": r.get("intitule_poste") or r.get("poste") or "Poste",
            "postes_total": 1,
            "postes_danger": 1 if frag >= DASHBOARD_DANGER_MIN else 0,
            "postes_surveillance": 1 if DASHBOARD_WATCH_MIN <= frag < DASHBOARD_DANGER_MIN else 0,
            "risques_sans_action": 1 if frag >= DASHBOARD_DANGER_MIN else 0,
            "risk_pct": round(frag, 1),
            "priority": priority,
            "priority_label": priority_label,
        })
    return sorted(items, key=lambda x: (0 if x.get("priority") == "danger" else 1 if x.get("priority") == "surveillance" else 2, -_studio_f(x.get("risk_pct")), x.get("label") or ""))


def _studio_fetch_risk_by_structure(cur, structures: List[Dict[str, Any]], criticite_min: int) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    total_postes = 0
    total_danger = 0
    total_watch = 0
    total_stable = 0
    total_health_weighted = 0.0
    total_transmission_ok = 0
    total_transmission_postes = 0
    total_no_action = 0

    for st in structures:
        id_ent = _studio_s(st.get("id_ent"))
        if not id_ent:
            continue
        try:
            overview = _studio_fetch_insights_overview(cur, id_ent, None, criticite_min)
        except Exception:
            overview = {}
        health = overview.get("health") or {}
        watch = overview.get("postes_watch") or {}
        tr = overview.get("transmission") or {}
        no_action = overview.get("risks_without_action") or {}

        postes_total = _studio_i(watch.get("total_postes"))
        postes_danger = _studio_i(watch.get("postes_danger"))
        postes_watch = _studio_i(watch.get("postes_surveillance"))
        postes_stables = _studio_i(watch.get("postes_stables"))
        postes_critiques = _studio_i(watch.get("postes_critiques_danger"))
        health_pct = round(_studio_f(health.get("pct")), 1)
        risk_pct = round(max(0.0, 100.0 - health_pct), 1) if postes_total else 0.0
        priority, priority_label = _studio_priority_from_risk(risk_pct, postes_danger, postes_critiques)

        total_postes += postes_total
        total_danger += postes_danger
        total_watch += postes_watch
        total_stable += postes_stables
        total_health_weighted += health_pct * postes_total
        total_no_action += _studio_i(no_action.get("total"))
        total_transmission_ok += _studio_i(tr.get("postes_transmissibles"))
        total_transmission_postes += _studio_i(tr.get("postes_total"))

        items.append({
            "kind": "structure",
            "id_ent": id_ent,
            "nom_ent": st.get("nom_ent") or "Structure",
            "type_entreprise": st.get("type_entreprise") or "Organisation",
            "ville_ent": st.get("ville_ent"),
            "postes_total": postes_total,
            "postes_danger": postes_danger,
            "postes_surveillance": postes_watch,
            "postes_stables": postes_stables,
            "postes_critiques_danger": postes_critiques,
            "risques_sans_action": _studio_i(no_action.get("total")),
            "risk_pct": risk_pct,
            "health_pct": health_pct,
            "priority": priority,
            "priority_label": priority_label,
        })

    health_pct = round(total_health_weighted / total_postes, 1) if total_postes else 0.0
    risk_avg = round(max(0.0, 100.0 - health_pct), 1) if total_postes else 0.0
    health_label = "Sous contrôle"
    if health_pct <= 0 and total_postes == 0:
        health_label = "Aucune donnée"
    elif health_pct < 40:
        health_label = "Critique"
    elif health_pct < 70:
        health_label = "Sous surveillance"

    sorted_items = sorted(items, key=lambda x: (0 if x.get("priority") == "danger" else 1 if x.get("priority") == "surveillance" else 2, -_studio_f(x.get("risk_pct")), x.get("nom_ent") or ""))
    return {
        "items": sorted_items,
        "portfolio": {
            "structures_total": len(items),
            "structures_danger": sum(1 for x in items if x.get("priority") == "danger"),
            "structures_surveillance": sum(1 for x in items if x.get("priority") == "surveillance"),
            "structures_stables": sum(1 for x in items if x.get("priority") == "stable"),
            "postes_total": total_postes,
            "postes_danger": total_danger,
            "postes_surveillance": total_watch,
            "postes_stables": total_stable,
            "risk_pct": risk_avg,
            "health_pct": health_pct,
            "health_label": health_label,
            "risques_sans_action": total_no_action,
        },
        "transmission": {
            "pct": round((total_transmission_ok / total_transmission_postes * 100.0), 1) if total_transmission_postes else 0.0,
            "postes_total": total_transmission_postes,
            "postes_transmissibles": total_transmission_ok,
            "postes_risque": max(total_transmission_postes - total_transmission_ok, 0),
        },
    }

def _studio_fetch_formation_demandes(cur, id_owner: str, id_ents: List[str], id_service: Optional[str] = None) -> Dict[str, Any]:
    if not id_ents or not _studio_has_table(cur, "tbl_insights_besoin_formation"):
        return {"ouvertes": 0, "urgentes": 0, "prises_en_charge": 0, "a_instruire": 0, "items": []}
    open_status = ["envoye_studio", "pris_en_charge"]
    svc_filter = ""
    params: List[Any] = [id_owner, id_ents, open_status]
    if id_service:
        svc_filter = " AND bf.id_service = %s"
        params.append(id_service)
    cur.execute(
        f"""
        SELECT
            COUNT(*)::int AS ouvertes,
            COUNT(*) FILTER (
                WHERE COALESCE(criticite, 0)::int >= 70
                   OR COALESCE(score_anticipation, 0)::int >= 70
                   OR lower(COALESCE(priorite, '')) IN ('haute', 'urgent', 'urgente', 'critique', 'elevee', 'élevée')
            )::int AS urgentes,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) = 'pris_en_charge')::int AS prises_en_charge,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) = 'envoye_studio')::int AS a_instruire
        FROM public.tbl_insights_besoin_formation bf
        WHERE bf.id_owner_destinataire = %s
          AND bf.id_ent_source = ANY(%s)
          AND COALESCE(bf.archive, FALSE) = FALSE
          AND lower(COALESCE(bf.statut, '')) = ANY(%s)
          {svc_filter}
        """,
        tuple(params),
    )
    r = cur.fetchone() or {}
    cur.execute(
        f"""
        SELECT
            bf.id_besoin_formation,
            bf.id_ent_source AS id_ent,
            e.nom_ent,
            bf.intitule_competence,
            bf.intitule_poste,
            bf.id_service,
            bf.nom_service,
            bf.nom_effectif,
            bf.prenom_effectif,
            bf.statut,
            bf.priorite,
            COALESCE(bf.criticite, 0)::int AS criticite,
            COALESCE(bf.score_anticipation, 0)::int AS score_anticipation,
            bf.created_at
        FROM public.tbl_insights_besoin_formation bf
        LEFT JOIN public.tbl_entreprise e ON e.id_ent = bf.id_ent_source
        WHERE bf.id_owner_destinataire = %s
          AND bf.id_ent_source = ANY(%s)
          AND COALESCE(bf.archive, FALSE) = FALSE
          AND lower(COALESCE(bf.statut, '')) = ANY(%s)
          {svc_filter}
        ORDER BY
          CASE WHEN COALESCE(bf.criticite, 0)::int >= 70 OR COALESCE(bf.score_anticipation, 0)::int >= 70 THEN 0 ELSE 1 END,
          bf.created_at DESC NULLS LAST
        LIMIT 8
        """,
        tuple(params),
    )
    rows = cur.fetchall() or []
    return {"ouvertes": _studio_i(r.get("ouvertes")), "urgentes": _studio_i(r.get("urgentes")), "prises_en_charge": _studio_i(r.get("prises_en_charge")), "a_instruire": _studio_i(r.get("a_instruire")), "items": [dict(x) for x in rows]}


def _studio_fetch_entretiens(cur, id_ents: List[str], id_service: Optional[str] = None) -> Dict[str, Any]:
    if not id_ents or not _studio_has_table(cur, "tbl_entretien_individuel"):
        return {"a_realiser": 0, "en_cours": 0, "a_signer": 0, "ouverts": 0}
    svc_join = "LEFT JOIN public.tbl_effectif_client e ON e.id_effectif = ei.id_effectif_client" if id_service else ""
    svc_filter = "AND e.id_service = %s" if id_service else ""
    params: List[Any] = [id_ents]
    if id_service:
        params.append(id_service)
    cur.execute(
        f"""
        SELECT
            COUNT(*) FILTER (WHERE lower(COALESCE(ei.statut, '')) IN ('à réaliser', 'a réaliser', 'à realiser'))::int AS a_realiser,
            COUNT(*) FILTER (WHERE lower(COALESCE(ei.statut, '')) IN ('en cours', 'en-cours'))::int AS en_cours,
            COUNT(*) FILTER (WHERE lower(COALESCE(ei.statut, '')) IN ('à signer 1/2', 'a signer 1/2'))::int AS a_signer,
            COUNT(*) FILTER (WHERE lower(COALESCE(ei.statut, '')) NOT IN ('terminé', 'termine', 'annulé', 'annule'))::int AS ouverts
        FROM public.tbl_entretien_individuel ei
        {svc_join}
        WHERE ei.id_ent = ANY(%s)
          AND COALESCE(ei.archive, FALSE) = FALSE
          {svc_filter}
        """,
        tuple(params),
    )
    r = cur.fetchone() or {}
    return {"a_realiser": _studio_i(r.get("a_realiser")), "en_cours": _studio_i(r.get("en_cours")), "a_signer": _studio_i(r.get("a_signer")), "ouverts": _studio_i(r.get("ouverts"))}


def _studio_fetch_referentiel_quality(cur, id_owner: str, id_ents: List[str], id_service: Optional[str] = None) -> Dict[str, Any]:
    out = {
        "postes_total": 0,
        "postes_sans_competence": 0,
        "competences_sans_domaine": 0,
        "collaborateurs_sans_poste": 0,
        "quality_pct": 0.0,
    }
    if not id_ents:
        return out

    svc_poste = "AND p.id_service = %s" if id_service else ""
    params_poste: List[Any] = [id_owner, id_ents]
    if id_service:
        params_poste.append(id_service)

    if _studio_has_table(cur, "tbl_fiche_poste"):
        cur.execute(
            f"""
            SELECT
                COUNT(*)::int AS postes_total,
                COUNT(*) FILTER (
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_fiche_poste_competence fpc
                        WHERE fpc.id_poste = p.id_poste
                          AND COALESCE(fpc.masque, FALSE) = FALSE
                    )
                )::int AS postes_sans_competence
            FROM public.tbl_fiche_poste p
            WHERE p.id_owner = %s
              AND p.id_ent = ANY(%s)
              AND COALESCE(p.actif, TRUE) = TRUE
              {svc_poste}
            """,
            tuple(params_poste),
        )
        r = cur.fetchone() or {}
        out["postes_total"] = _studio_i(r.get("postes_total"))
        out["postes_sans_competence"] = _studio_i(r.get("postes_sans_competence"))

    if _studio_has_table(cur, "tbl_fiche_poste") and _studio_has_table(cur, "tbl_fiche_poste_competence") and _studio_has_table(cur, "tbl_competence"):
        svc_comp = "AND p.id_service = %s" if id_service else ""
        params_comp: List[Any] = [id_owner, id_ents]
        if id_service:
            params_comp.append(id_service)
        cur.execute(
            f"""
            SELECT COUNT(DISTINCT c.id_comp)::int AS n
            FROM public.tbl_fiche_poste p
            JOIN public.tbl_fiche_poste_competence fpc
              ON fpc.id_poste = p.id_poste
             AND COALESCE(fpc.masque, FALSE) = FALSE
            JOIN public.tbl_competence c
              ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
            WHERE p.id_owner = %s
              AND p.id_ent = ANY(%s)
              AND COALESCE(p.actif, TRUE) = TRUE
              AND COALESCE(c.masque, FALSE) = FALSE
              AND lower(COALESCE(c.etat, 'active')) IN ('active', 'valide', 'validé', 'validee', 'validée')
              AND COALESCE(NULLIF(BTRIM(c.domaine), ''), '') = ''
              {svc_comp}
            """,
            tuple(params_comp),
        )
        out["competences_sans_domaine"] = _studio_i((cur.fetchone() or {}).get("n"))

    if _studio_has_table(cur, "tbl_effectif_client"):
        svc_eff = "AND e.id_service = %s" if id_service else ""
        params_eff: List[Any] = [id_ents]
        if id_service:
            params_eff.append(id_service)
        cur.execute(
            f"""
            SELECT COUNT(*)::int AS n
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = ANY(%s)
              AND COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND COALESCE(NULLIF(BTRIM(e.id_poste_actuel), ''), '') = ''
              {svc_eff}
            """,
            tuple(params_eff),
        )
        out["collaborateurs_sans_poste"] = _studio_i((cur.fetchone() or {}).get("n"))

    issues = out["postes_sans_competence"] + out["collaborateurs_sans_poste"] + out["competences_sans_domaine"]
    base = max(out["postes_total"] + issues, 1)
    out["quality_pct"] = round(max(0.0, 100.0 - (issues / base * 100.0)), 1)
    return out


def _studio_build_actions(risk_items: List[Dict[str, Any]], demandes: Dict[str, Any], entretiens: Dict[str, Any], ref: Dict[str, Any], structure_label: str = "") -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    if _studio_i(demandes.get("a_instruire")) > 0:
        actions.append({"type_action": "formation", "priority": "danger" if _studio_i(demandes.get("urgentes")) > 0 else "surveillance", "priority_label": "Formation", "title": f"Qualifier {_studio_i(demandes.get('a_instruire'))} besoin(s) formation", "subtitle": f"{_studio_i(demandes.get('urgentes'))} demande(s) urgente(s) remontée(s) depuis Insights"})
    for r in risk_items[:6]:
        if r.get("priority") not in ("danger", "surveillance"):
            continue
        if _studio_i(r.get("risques_sans_action")) > 0 or _studio_f(r.get("risk_pct")) >= DASHBOARD_DANGER_MIN:
            label = r.get("label") or r.get("nom_service") or r.get("intitule_poste") or r.get("nom_ent") or structure_label or "Périmètre"
            action = {"type_action": "transmission", "priority": r.get("priority"), "priority_label": r.get("priority_label"), "title": f"Sécuriser {label}", "subtitle": f"{_studio_i(r.get('risques_sans_action'))} risque(s) sans action ouverte"}
            if r.get("id_ent"):
                action["id_ent"] = r.get("id_ent")
            actions.append(action)
    if _studio_i(entretiens.get("ouverts")) > 0:
        actions.append({"type_action": "entretien", "priority": "surveillance", "priority_label": "Entretiens", "title": f"Relancer {_studio_i(entretiens.get('ouverts'))} entretien(s)", "subtitle": "Préparations, réalisations ou signatures encore ouvertes"})
    ref_issues = _studio_i(ref.get("postes_sans_competence")) + _studio_i(ref.get("collaborateurs_sans_poste"))
    if ref_issues > 0:
        actions.append({"type_action": "referentiel", "priority": "surveillance", "priority_label": "Référentiel", "title": "Nettoyer les données bloquantes", "subtitle": f"{ref_issues} anomalie(s) structurelles détectée(s)"})
    if not actions:
        actions.append({"type_action": "referentiel", "priority": "stable", "priority_label": "Pilotage", "title": "Maintenir la fiabilité des données", "subtitle": "Aucune urgence majeure détectée sur le périmètre"})
    rank = {"danger": 0, "surveillance": 1, "stable": 2}
    return sorted(actions, key=lambda x: (rank.get(x.get("priority"), 9), x.get("title") or ""))[:10]


def _studio_apply_priority_filter(items: List[Dict[str, Any]], priorite: str) -> List[Dict[str, Any]]:
    prio = _studio_norm_priorite(priorite)
    if prio == "tous":
        return items
    return [x for x in items if x.get("priority") == prio]


def _studio_scope_options(current: Dict[str, Any], services: List[Dict[str, Any]], has_linked: bool) -> List[Dict[str, str]]:
    opts = [{"value": "", "label": "Tous les services"}]
    for s in services:
        sid = _studio_s(s.get("id_service"))
        if not sid:
            continue
        indent = "— " * min(_studio_i(s.get("depth")), 4)
        opts.append({"value": sid, "label": f"{indent}{s.get('nom_service') or 'Service'}"})
    return opts


def _studio_build_main(cur, id_owner: str, current: Dict[str, Any], perimetre: str, priorite: str, criticite: int) -> Dict[str, Any]:
    id_ent = _studio_s(current.get("id_ent")) or id_owner
    if not bool(current.get("is_real_entity", True)):
        return _studio_empty_main_for_missing_structure(current)

    services = _studio_fetch_services(cur, id_ent)
    service_id = None
    if _studio_s(perimetre).lower().startswith("service:"):
        service_id = _studio_s(perimetre).split(":", 1)[1]
        if not any(_studio_s(s.get("id_service")) == service_id for s in services):
            service_id = None

    try:
        overview = _studio_fetch_insights_overview(cur, id_ent, service_id, criticite)
    except HTTPException:
        raise
    except Exception:
        overview = {}

    try:
        records = _fetch_postes_fragility_records(cur, id_ent, service_id, criticite)
        _enrich_records_poste_criticite(cur, records)
    except Exception:
        records = []

    health = overview.get("health") or {}
    watch = overview.get("postes_watch") or {}
    risks_without_action = overview.get("risks_without_action") or {}
    tr = overview.get("transmission") or {}
    reliability = overview.get("reliability") or {}

    health_pct = round(_studio_f(health.get("pct")), 1)
    risk_pct = round(max(0.0, 100.0 - health_pct), 1) if health_pct else 0.0
    health_label = "Sous contrôle"
    if health_pct <= 0 and _studio_i(watch.get("total_postes")) == 0:
        health_label = "Aucune donnée"
    elif health_pct < 40:
        health_label = "Critique"
    elif health_pct < 70:
        health_label = "Sous surveillance"

    portfolio = {
        "postes_total": _studio_i(watch.get("total_postes")),
        "postes_danger": _studio_i(watch.get("postes_danger")),
        "postes_surveillance": _studio_i(watch.get("postes_surveillance")),
        "postes_stables": _studio_i(watch.get("postes_stables")),
        "postes_critiques_danger": _studio_i(watch.get("postes_critiques_danger")),
        "risk_pct": risk_pct,
        "health_pct": health_pct,
        "health_label": health_label,
        "risques_sans_action": _studio_i(risks_without_action.get("total")),
        "items_danger": 0,
        "items_surveillance": 0,
        "items_stables": 0,
        "transmission": tr,
    }

    if service_id:
        risk_items = _studio_risk_items_by_poste(records)
        service_label = next((s.get("nom_service") for s in services if _studio_s(s.get("id_service")) == service_id), "Service")
        risk_title = "Postes à surveiller"
        risk_subtitle = f"Postes du service {service_label}"
        scope_label = f"Service analysé : {service_label}"
        risk_kind = "poste"
    elif services:
        risk_items = _studio_risk_items_by_service(cur, id_ent, services, criticite)
        risk_title = "Services à surveiller"
        risk_subtitle = "Priorisation interne par service"
        scope_label = "Structure courante, avec lecture par services"
        risk_kind = "service"
    else:
        risk_items = _studio_risk_items_by_poste(records)
        risk_title = "Postes à surveiller"
        risk_subtitle = "Aucun service interne structuré : lecture directe par poste"
        scope_label = "Structure courante, sans découpage service exploitable"
        risk_kind = "poste"

    risk_items = _studio_apply_priority_filter(risk_items, priorite)
    portfolio["items_danger"] = sum(1 for x in risk_items if x.get("priority") == "danger")
    portfolio["items_surveillance"] = sum(1 for x in risk_items if x.get("priority") == "surveillance")
    portfolio["items_stables"] = sum(1 for x in risk_items if x.get("priority") == "stable")

    demandes = _studio_fetch_formation_demandes(cur, id_owner, [id_ent], service_id)
    entretiens = _studio_fetch_entretiens(cur, [id_ent], service_id)
    ref = _studio_fetch_referentiel_quality(cur, id_owner, [id_ent], service_id)

    return {
        "scope_label": scope_label,
        "risk_title": risk_title,
        "risk_subtitle": risk_subtitle,
        "risk_kind": risk_kind,
        "portfolio": portfolio,
        "risk_items": risk_items[:12],
        "demandes_formation": demandes,
        "entretiens": entretiens,
        "referentiel": ref,
        "transmission": tr,
        "reliability": reliability,
        "actions_prioritaires": _studio_build_actions(risk_items, demandes, entretiens, ref, current.get("nom_ent") or ""),
    }

def _studio_build_linked(cur, id_owner: str, linked_structures: List[Dict[str, Any]], priorite: str, criticite: int) -> Dict[str, Any]:
    if not linked_structures:
        return {"visible": False, "portfolio": {"structures_total": 0}, "structures_prioritaires": [], "actions_prioritaires": []}
    risk = _studio_fetch_risk_by_structure(cur, linked_structures, criticite)
    risk_items = _studio_apply_priority_filter(risk.get("items") or [], priorite)
    ids = [_studio_s(x.get("id_ent")) for x in risk_items if _studio_s(x.get("id_ent"))]
    demandes = _studio_fetch_formation_demandes(cur, id_owner, ids)
    entretiens = _studio_fetch_entretiens(cur, ids)
    ref = _studio_fetch_referentiel_quality(cur, id_owner, ids)
    actions = _studio_build_actions(risk_items, demandes, entretiens, ref, "organisations liées")
    portfolio = dict(risk.get("portfolio") or {})
    if _studio_norm_priorite(priorite) != "tous":
        portfolio["structures_total"] = len(risk_items)
        portfolio["structures_danger"] = sum(1 for x in risk_items if x.get("priority") == "danger")
        portfolio["structures_surveillance"] = sum(1 for x in risk_items if x.get("priority") == "surveillance")
        portfolio["structures_stables"] = sum(1 for x in risk_items if x.get("priority") == "stable")
    return {
        "visible": True,
        "portfolio": portfolio,
        "structures_prioritaires": risk_items[:12],
        "demandes_formation": demandes,
        "entretiens": entretiens,
        "referentiel": ref,
        "transmission": risk.get("transmission") or {},
        "actions_prioritaires": actions,
    }


@router.get("/studio/dashboard/overview/{id_owner}")
def get_studio_dashboard_overview(
    id_owner: str,
    request: Request,
    perimetre: str = Query(default="ma_structure"),
    priorite: str = Query(default="tous"),
    criticite_min: int = Query(default=70, ge=0, le=100),
    id_service: Optional[str] = Query(default=None),
):
    """
    Dashboard Studio adaptatif.
    Règle produit : ma structure d'abord. Les organisations liées ne sont affichées
    qu'en supervision secondaire lorsque le périmètre Studio en possède.
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        prio = _studio_norm_priorite(priorite)
        criticite = _studio_norm_criticite(criticite_min)
        requested_perim = _studio_s(perimetre).lower() or "ma_structure"
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                ow = studio_fetch_owner(cur, oid)
                current = _studio_fetch_owner_structure(cur, oid, ow.get("nom_owner") or "")
                current_id = _studio_s(current.get("id_ent")) or oid
                services = _studio_fetch_services(cur, current_id)
                linked_structures = _studio_fetch_linked_structures(cur, oid, current_id)
                has_linked = len(linked_structures) > 0

                service_requested = _studio_s(id_service)
                if not service_requested and requested_perim.startswith("service:"):
                    service_requested = requested_perim.split(":", 1)[1].strip()

                main_perim = f"service:{service_requested}" if service_requested else "ma_structure"
                main = _studio_build_main(cur, oid, current, main_perim, "tous", criticite)
                linked = _studio_build_linked(cur, oid, linked_structures, "tous", criticite) if has_linked else {"visible": False, "portfolio": {"structures_total": 0}, "structures_prioritaires": [], "actions_prioritaires": []}

                mode = "network" if has_linked else "single_structure"
                return {
                    "context": {"id_owner": ow.get("id_owner"), "nom_owner": ow.get("nom_owner")},
                    "mode": mode,
                    "own": {"id_ent": current_id, "nom_ent": current.get("nom_ent") or ow.get("nom_owner"), "type_entreprise": current.get("type_entreprise"), "is_real_entity": bool(current.get("is_real_entity", True)), "has_linked": has_linked, "linked_count": len(linked_structures)},
                    "scope_options": _studio_scope_options(current, services, has_linked),
                    "filters": {"id_service": service_requested, "criticite_min": criticite},
                    "main": main,
                    "linked": linked,
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/dashboard/overview error: {e}")

