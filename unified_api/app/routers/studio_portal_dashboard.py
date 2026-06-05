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
    _compute_risks_without_action,
    _compute_transmission,
    _enrich_records_poste_criticite,
)
from app.routers.skills_portal_analyse import _fetch_postes_fragility_records

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
# Dashboard Studio global : portefeuille risques / actions
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


def _studio_norm_perimetre(v: str) -> str:
    s = _studio_s(v).lower()
    return s if s in ("tous", "clients", "sites", "entreprises") else "tous"


def _studio_norm_priorite(v: str) -> str:
    s = _studio_s(v).lower()
    return s if s in ("tous", "danger", "surveillance", "stable") else "tous"


def _studio_norm_criticite(v) -> int:
    n = _studio_i(v, 70)
    return max(0, min(100, n))


def _studio_fetch_structures_dashboard(cur, id_owner: str, perimetre: str) -> List[Dict[str, Any]]:
    where = ["e.id_owner_gestionnaire = %s", "COALESCE(e.masque, FALSE) = FALSE"]
    params: List[Any] = [id_owner]

    p = _studio_norm_perimetre(perimetre)
    if p == "clients":
        where.append("lower(COALESCE(e.type_entreprise, '')) = 'client'")
    elif p == "sites":
        where.append("lower(COALESCE(e.type_entreprise, '')) = 'site'")
    elif p == "entreprises":
        where.append("lower(COALESCE(e.type_entreprise, '')) IN ('client', 'entreprise')")

    cur.execute(
        f"""
        SELECT
            e.id_ent,
            e.nom_ent,
            e.type_entreprise,
            e.ville_ent,
            e.pays_ent,
            e.effectif_ent
        FROM public.tbl_entreprise e
        WHERE {" AND ".join(where)}
        ORDER BY
            CASE lower(COALESCE(e.type_entreprise, ''))
                WHEN 'client' THEN 0
                WHEN 'entreprise' THEN 1
                WHEN 'site' THEN 2
                ELSE 3
            END,
            lower(e.nom_ent),
            e.id_ent
        LIMIT 160
        """,
        tuple(params),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _studio_priority_from_risk(risk_pct: float, postes_danger: int, critical_danger: int) -> tuple[str, str]:
    if critical_danger > 0 or risk_pct >= 60:
        return "danger", "En danger"
    if postes_danger > 0 or risk_pct >= 1:
        return "surveillance", "À surveiller"
    return "stable", "Stable"


def _studio_fetch_risk_by_structure(cur, structures: List[Dict[str, Any]], criticite_min: int) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    total_postes = 0
    total_danger = 0
    total_watch = 0
    total_stable = 0
    total_risk_weighted = 0.0
    total_transmission_ok = 0
    total_transmission_postes = 0
    total_no_action = 0

    for st in structures:
        id_ent = _studio_s(st.get("id_ent"))
        if not id_ent:
            continue

        try:
            records = _fetch_postes_fragility_records(cur, id_ent, None, criticite_min)
            _enrich_records_poste_criticite(cur, records)
        except Exception:
            records = []

        nb_postes = len(records)
        danger_records = [r for r in records if _studio_i(r.get("indice_fragilite")) >= DASHBOARD_DANGER_MIN]
        watch_records = [r for r in records if DASHBOARD_WATCH_MIN <= _studio_i(r.get("indice_fragilite")) < DASHBOARD_DANGER_MIN]
        stable_records = max(nb_postes - len(danger_records) - len(watch_records), 0)
        critical_danger = [r for r in danger_records if _studio_i(r.get("criticite_poste"), 2) >= DASHBOARD_CRITICAL_POSTE_MIN]

        risk_pct = round(sum(_studio_f(r.get("indice_fragilite")) for r in records) / nb_postes, 1) if nb_postes else 0.0
        priority, priority_label = _studio_priority_from_risk(risk_pct, len(danger_records), len(critical_danger))

        try:
            tr = _compute_transmission(records)
            total_transmission_ok += _studio_i(getattr(tr, "postes_transmissibles", 0))
            total_transmission_postes += _studio_i(getattr(tr, "postes_total", 0))
        except Exception:
            pass

        no_action_total = 0
        try:
            no_action = _compute_risks_without_action(cur, id_ent, DashboardScope(id_service=None, nom_service="Tout"), records)
            no_action_total = _studio_i(getattr(no_action, "total", 0))
        except Exception:
            no_action_total = len(danger_records)

        total_no_action += no_action_total
        total_postes += nb_postes
        total_danger += len(danger_records)
        total_watch += len(watch_records)
        total_stable += stable_records
        total_risk_weighted += risk_pct * nb_postes

        items.append({
            "id_ent": id_ent,
            "nom_ent": st.get("nom_ent") or "Structure",
            "type_entreprise": st.get("type_entreprise") or "Organisation",
            "ville_ent": st.get("ville_ent"),
            "postes_total": nb_postes,
            "postes_danger": len(danger_records),
            "postes_surveillance": len(watch_records),
            "postes_stables": stable_records,
            "postes_critiques_danger": len(critical_danger),
            "risques_sans_action": no_action_total,
            "risk_pct": risk_pct,
            "health_pct": max(0.0, round(100.0 - risk_pct, 1)),
            "priority": priority,
            "priority_label": priority_label,
        })

    risk_avg = round(total_risk_weighted / total_postes, 1) if total_postes else 0.0
    health_pct = max(0.0, round(100.0 - risk_avg, 1))
    health_label = "Sous contrôle"
    if health_pct < 40:
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


def _studio_fetch_formation_demandes(cur, id_owner: str, id_ents: List[str]) -> Dict[str, Any]:
    if not id_ents or not _studio_has_table(cur, "tbl_insights_besoin_formation"):
        return {"ouvertes": 0, "urgentes": 0, "prises_en_charge": 0, "a_instruire": 0, "items": []}

    open_status = ["envoye_studio", "pris_en_charge"]
    cur.execute(
        """
        SELECT
            COUNT(*)::int AS ouvertes,
            COUNT(*) FILTER (
                WHERE COALESCE(criticite, 0)::int >= 70
                   OR COALESCE(score_anticipation, 0)::int >= 70
                   OR lower(COALESCE(priorite, '')) IN ('haute', 'urgent', 'urgente', 'critique', 'elevee', 'élevée')
            )::int AS urgentes,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) = 'pris_en_charge')::int AS prises_en_charge,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) = 'envoye_studio')::int AS a_instruire
        FROM public.tbl_insights_besoin_formation
        WHERE id_owner_destinataire = %s
          AND id_ent_source = ANY(%s)
          AND COALESCE(archive, FALSE) = FALSE
          AND lower(COALESCE(statut, '')) = ANY(%s)
        """,
        (id_owner, id_ents, open_status),
    )
    r = cur.fetchone() or {}

    cur.execute(
        """
        SELECT
            bf.id_besoin_formation,
            bf.id_ent_source AS id_ent,
            e.nom_ent,
            bf.intitule_competence,
            bf.intitule_poste,
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
        ORDER BY
          CASE WHEN COALESCE(bf.criticite, 0)::int >= 70 OR COALESCE(bf.score_anticipation, 0)::int >= 70 THEN 0 ELSE 1 END,
          bf.created_at DESC NULLS LAST
        LIMIT 8
        """,
        (id_owner, id_ents, open_status),
    )
    rows = cur.fetchall() or []

    return {"ouvertes": _studio_i(r.get("ouvertes")), "urgentes": _studio_i(r.get("urgentes")), "prises_en_charge": _studio_i(r.get("prises_en_charge")), "a_instruire": _studio_i(r.get("a_instruire")), "items": [dict(x) for x in rows]}


def _studio_fetch_entretiens(cur, id_ents: List[str]) -> Dict[str, Any]:
    if not id_ents or not _studio_has_table(cur, "tbl_entretien_individuel"):
        return {"a_realiser": 0, "en_cours": 0, "a_signer": 0, "ouverts": 0}
    cur.execute(
        """
        SELECT
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) IN ('à réaliser', 'a réaliser', 'à realiser'))::int AS a_realiser,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) IN ('en cours', 'en-cours'))::int AS en_cours,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) IN ('à signer 1/2', 'a signer 1/2'))::int AS a_signer,
            COUNT(*) FILTER (WHERE lower(COALESCE(statut, '')) NOT IN ('terminé', 'termine', 'annulé', 'annule'))::int AS ouverts
        FROM public.tbl_entretien_individuel
        WHERE id_ent = ANY(%s)
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (id_ents,),
    )
    r = cur.fetchone() or {}
    return {"a_realiser": _studio_i(r.get("a_realiser")), "en_cours": _studio_i(r.get("en_cours")), "a_signer": _studio_i(r.get("a_signer")), "ouverts": _studio_i(r.get("ouverts"))}


def _studio_fetch_referentiel_quality(cur, id_owner: str, id_ents: List[str]) -> Dict[str, Any]:
    out = {"postes_total": 0, "postes_sans_competence": 0, "competences_sans_domaine": 0, "collaborateurs_sans_poste": 0, "quality_pct": 0.0}
    if not id_ents:
        return out
    if _studio_has_table(cur, "tbl_fiche_poste"):
        cur.execute(
            """
            SELECT
                COUNT(*)::int AS postes_total,
                COUNT(*) FILTER (
                    WHERE NOT EXISTS (
                        SELECT 1 FROM public.tbl_fiche_poste_competence fpc
                        WHERE fpc.id_poste = p.id_poste AND COALESCE(fpc.masque, FALSE) = FALSE
                    )
                )::int AS postes_sans_competence
            FROM public.tbl_fiche_poste p
            WHERE p.id_owner = %s
              AND p.id_ent = ANY(%s)
              AND COALESCE(p.actif, TRUE) = TRUE
            """,
            (id_owner, id_ents),
        )
        r = cur.fetchone() or {}
        out["postes_total"] = _studio_i(r.get("postes_total"))
        out["postes_sans_competence"] = _studio_i(r.get("postes_sans_competence"))
    if _studio_has_table(cur, "tbl_competence"):
        cur.execute(
            """
            SELECT COUNT(*)::int AS n
            FROM public.tbl_competence c
            WHERE c.id_owner = %s
              AND COALESCE(c.masque, FALSE) = FALSE
              AND COALESCE(c.etat, 'active') = 'active'
              AND COALESCE(c.domaine, '') = ''
            """,
            (id_owner,),
        )
        out["competences_sans_domaine"] = _studio_i((cur.fetchone() or {}).get("n"))
    if _studio_has_table(cur, "tbl_effectif_client"):
        cur.execute(
            """
            SELECT COUNT(*)::int AS n
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = ANY(%s)
              AND COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND COALESCE(e.id_poste_actuel, '') = ''
            """,
            (id_ents,),
        )
        out["collaborateurs_sans_poste"] = _studio_i((cur.fetchone() or {}).get("n"))
    issues = out["postes_sans_competence"] + out["collaborateurs_sans_poste"]
    base = max(out["postes_total"] + out["collaborateurs_sans_poste"], 1)
    out["quality_pct"] = round(max(0.0, 100.0 - (issues / base * 100.0)), 1)
    return out


def _studio_build_actions(risk_items: List[Dict[str, Any]], demandes: Dict[str, Any], entretiens: Dict[str, Any], ref: Dict[str, Any]) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    if _studio_i(demandes.get("a_instruire")) > 0:
        actions.append({"type_action": "formation", "priority": "danger" if _studio_i(demandes.get("urgentes")) > 0 else "surveillance", "priority_label": "Formation", "title": f"Qualifier {_studio_i(demandes.get('a_instruire'))} besoin(s) formation", "subtitle": f"{_studio_i(demandes.get('urgentes'))} demande(s) urgente(s) remontée(s) depuis Insights"})
    for r in risk_items[:6]:
        if r.get("priority") not in ("danger", "surveillance"):
            continue
        if _studio_i(r.get("risques_sans_action")) > 0:
            actions.append({"type_action": "transmission", "priority": r.get("priority"), "priority_label": r.get("priority_label"), "title": f"Sécuriser {r.get('nom_ent')}", "subtitle": f"{_studio_i(r.get('risques_sans_action'))} poste(s) en risque sans action ouverte", "id_ent": r.get("id_ent")})
    if _studio_i(entretiens.get("ouverts")) > 0:
        actions.append({"type_action": "entretien", "priority": "surveillance", "priority_label": "Entretiens", "title": f"Relancer {_studio_i(entretiens.get('ouverts'))} entretien(s)", "subtitle": "Préparations, réalisations ou signatures encore ouvertes"})
    ref_issues = _studio_i(ref.get("postes_sans_competence")) + _studio_i(ref.get("collaborateurs_sans_poste"))
    if ref_issues > 0:
        actions.append({"type_action": "referentiel", "priority": "surveillance", "priority_label": "Référentiel", "title": "Nettoyer les données bloquantes", "subtitle": f"{ref_issues} anomalie(s) structurelles détectée(s)"})
    if not actions and risk_items:
        actions.append({"type_action": "referentiel", "priority": "stable", "priority_label": "Pilotage", "title": "Maintenir la fiabilité du portefeuille", "subtitle": "Aucune urgence majeure détectée sur le périmètre filtré"})
    rank = {"danger": 0, "surveillance": 1, "stable": 2}
    return sorted(actions, key=lambda x: (rank.get(x.get("priority"), 9), x.get("title") or ""))[:10]


@router.get("/studio/dashboard/overview/{id_owner}")
def get_studio_dashboard_overview(
    id_owner: str,
    request: Request,
    perimetre: str = Query(default="tous"),
    priorite: str = Query(default="tous"),
    criticite_min: int = Query(default=70, ge=0, le=100),
):
    """
    Dashboard Studio global.
    Vocation : pilotage consolidé du portefeuille client/site.
    Ne pas dupliquer Insights ici : on utilise ses calculs de risque quand ils existent,
    puis Studio agrège les structures, demandes terrain, entretiens et qualité référentiel.
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        perim = _studio_norm_perimetre(perimetre)
        prio = _studio_norm_priorite(priorite)
        criticite = _studio_norm_criticite(criticite_min)
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                ow = studio_fetch_owner(cur, oid)
                structures = _studio_fetch_structures_dashboard(cur, oid, perim)
                risk = _studio_fetch_risk_by_structure(cur, structures, criticite)
                risk_items = risk["items"]
                if prio != "tous":
                    risk_items = [x for x in risk_items if x.get("priority") == prio]
                ids = [_studio_s(x.get("id_ent")) for x in risk_items if _studio_s(x.get("id_ent"))]
                demandes = _studio_fetch_formation_demandes(cur, oid, ids)
                entretiens = _studio_fetch_entretiens(cur, ids)
                ref = _studio_fetch_referentiel_quality(cur, oid, ids)
                tr = risk.get("transmission") or {}
                portfolio = dict(risk.get("portfolio") or {})
                if prio != "tous":
                    portfolio["structures_total"] = len(risk_items)
                    portfolio["structures_danger"] = sum(1 for x in risk_items if x.get("priority") == "danger")
                    portfolio["structures_surveillance"] = sum(1 for x in risk_items if x.get("priority") == "surveillance")
                    portfolio["structures_stables"] = sum(1 for x in risk_items if x.get("priority") == "stable")
                reliability_base = max(_studio_i(ref.get("postes_total")) + _studio_i(entretiens.get("ouverts")) + _studio_i(demandes.get("ouvertes")), 1)
                reliability_penalty = _studio_i(ref.get("postes_sans_competence")) + _studio_i(ref.get("collaborateurs_sans_poste")) + min(_studio_i(entretiens.get("ouverts")), 20)
                reliability_pct = round(max(0.0, 100.0 - (reliability_penalty / reliability_base * 100.0)), 1)
                actions = _studio_build_actions(risk_items, demandes, entretiens, ref)
                return {"context": {"id_owner": ow.get("id_owner"), "nom_owner": ow.get("nom_owner")}, "filters": {"perimetre": perim, "priorite": prio, "criticite_min": criticite}, "portfolio": portfolio, "structures_prioritaires": risk_items[:12], "demandes_formation": demandes, "entretiens": entretiens, "referentiel": ref, "transmission": tr, "reliability": {"pct": reliability_pct}, "actions_prioritaires": actions}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/dashboard/overview error: {e}")

