from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    fetch_contact_with_entreprise,
    resolve_insights_effectif_for_request,
)
from app.routers.skills_portal_analyse import (
    CRITICITE_MIN_DEFAULT,
    NON_LIE_ID,
    _build_scope_cte,
    _compute_poste_fragility_record,
    _fetch_postes_fragility_records,
    _fetch_postes_fragility_records_projected,
    _fetch_service_label,
)

router = APIRouter()

DASHBOARD_DANGER_MIN = 60
DASHBOARD_WATCH_MIN = 1
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
    postes_total: int = 0
    postes_transmissibles: int = 0
    postes_risque: int = 0


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


def _month_add(base: date, months: int) -> date:
    month = base.month - 1 + months
    year = base.year + month // 12
    month = month % 12 + 1
    day = min(base.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)




def _month_bounds(base: date, months: int) -> Tuple[date, date]:
    d = _month_add(base, int(months or 0))
    start = date(d.year, d.month, 1)
    end = _month_add(start, 1) - timedelta(days=1)
    return start, end
def _avg_fragility(records: List[Dict[str, Any]]) -> int:
    if not records:
        return 0
    return int(round(sum(int(r.get("indice_fragilite") or 0) for r in records) / float(len(records))))


def _is_danger_record(r: Dict[str, Any]) -> bool:
    return int(r.get("indice_fragilite") or 0) >= DASHBOARD_DANGER_MIN


def _is_watch_record(r: Dict[str, Any]) -> bool:
    s = int(r.get("indice_fragilite") or 0)
    return DASHBOARD_WATCH_MIN <= s < DASHBOARD_DANGER_MIN


def _normalize_criticite_min(v: Optional[int]) -> int:
    try:
        n = int(v if v is not None else CRITICITE_MIN_DEFAULT)
    except Exception:
        n = CRITICITE_MIN_DEFAULT
    return max(0, min(100, n))


# ======================================================
# Calculs
# ======================================================


def _enrich_records_poste_criticite(cur, records: List[Dict[str, Any]]) -> None:
    ids = [str(r.get("id_poste") or "").strip() for r in (records or []) if str(r.get("id_poste") or "").strip()]
    if not ids:
        return

    cur.execute(
        """
        SELECT id_poste, COALESCE(criticite_poste, 2)::int AS criticite_poste
        FROM public.tbl_fiche_poste_param_rh
        WHERE id_poste = ANY(%s)
        """,
        (ids,),
    )
    mp = {str(r.get("id_poste") or ""): int(r.get("criticite_poste") or 2) for r in (cur.fetchall() or [])}
    for r in records:
        pid = str(r.get("id_poste") or "")
        r["criticite_poste"] = int(mp.get(pid, r.get("criticite_poste") or 2))

def _compute_health(cur, id_ent: str, scope: DashboardScope, criticite_min: int) -> DashboardHealth:
    cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)
    cur.execute(
        f"""
        WITH
        {cte_sql},
        eff AS (
            SELECT e.id_effectif, e.id_poste_actuel
            FROM effectifs_scope es
            JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
            WHERE COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND COALESCE(e.id_poste_actuel, '') <> ''
        )
        SELECT
            COALESCE(SUM(
                CASE upper(trim(COALESCE(fpc.niveau_requis, '')))
                    WHEN 'A' THEN 6
                    WHEN 'B' THEN 12
                    WHEN 'C' THEN 18
                    WHEN 'D' THEN 24
                    ELSE 0
                END
            ), 0)::numeric AS max_score,
            COALESCE(SUM(LEAST(
                COALESCE(a.resultat_eval, 0),
                CASE upper(trim(COALESCE(fpc.niveau_requis, '')))
                    WHEN 'A' THEN 6
                    WHEN 'B' THEN 12
                    WHEN 'C' THEN 18
                    WHEN 'D' THEN 24
                    ELSE 0
                END
            )), 0)::numeric AS score,
            COUNT(*)::int AS nb_items
        FROM eff
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_poste = eff.id_poste_actuel
         AND COALESCE(fpc.masque, FALSE) = FALSE
         AND COALESCE(fpc.poids_criticite, 0)::int >= %s
        LEFT JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = eff.id_effectif
         AND ec.id_comp = fpc.id_competence
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
        """,
        tuple(cte_params + [int(criticite_min)]),
    )
    row = cur.fetchone() or {}
    score = float(row.get("score") or 0.0)
    max_score = float(row.get("max_score") or 0.0)
    pct = round((score / max_score * 100.0), 1) if max_score > 0 else 0.0
    return DashboardHealth(
        pct=pct,
        score=score,
        max_score=max_score,
        nb_items=int(row.get("nb_items") or 0),
        scope_label=scope.nom_service,
    )


def _fetch_postes_fragility_records_at(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    as_of: date,
) -> List[Dict[str, Any]]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    sql_postes = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
        SELECT es.id_effectif
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= %s
              AND b.date_fin >= %s
          )
    ),
    titulaires AS (
        SELECT
            e.id_poste_actuel AS id_poste,
            COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
        FROM public.tbl_effectif_client e
        JOIN effectifs_dispo ed ON ed.id_effectif = e.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.id_poste_actuel, '') <> ''
        GROUP BY e.id_poste_actuel
    )
    SELECT
        fp.id_poste,
        fp.codif_poste,
        fp.codif_client,
        fp.intitule_poste,
        fp.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
        COALESCE(prh.statut_poste, 'actif')::text AS statut_poste,
        COALESCE(prh.criticite_poste, 2)::int AS criticite_poste,
        CASE
            WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$'
                THEN trim(fp.niveau_education_minimum)::int
            ELSE 0
        END AS edu_min_rank,
        (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
        COALESCE(nd.titre, '')::text AS nsf_domaine_titre,
        COALESCE(t.nb_titulaires, 0)::int AS nb_titulaires
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
    LEFT JOIN public.tbl_entreprise_organigramme o
      ON o.id_ent = %s
     AND o.id_service = fp.id_service
     AND COALESCE(o.archive, FALSE) = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    LEFT JOIN titulaires t ON t.id_poste = fp.id_poste
    """
    cur.execute(sql_postes, tuple(cte_params + [as_of, as_of, as_of, id_ent]))
    poste_rows = cur.fetchall() or []
    if not poste_rows:
        return []

    postes_map: Dict[str, Dict[str, Any]] = {str(r.get("id_poste") or ""): dict(r) for r in poste_rows}

    sql_emps = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
        SELECT es.id_effectif
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= %s
              AND b.date_fin >= %s
          )
    )
    SELECT
        e.id_effectif,
        e.id_poste_actuel,
        COALESCE(e.niveau_education, '') AS niveau_education,
        COALESCE(e.domaine_education, '') AS domaine_education
    FROM public.tbl_effectif_client e
    JOIN effectifs_dispo ed ON ed.id_effectif = e.id_effectif
    WHERE COALESCE(e.archive, FALSE) = FALSE
    """
    cur.execute(sql_emps, tuple(cte_params + [as_of, as_of, as_of]))
    employees = [dict(r) for r in (cur.fetchall() or [])]

    sql_comp = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
        SELECT es.id_effectif
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= %s
              AND b.date_fin >= %s
          )
    ),
    poste_info AS (
        SELECT
            fp.id_poste,
            CASE
                WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$'
                    THEN trim(fp.niveau_education_minimum)::int
                ELSE 0
            END AS edu_min_rank,
            (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
            COALESCE(nd.titre, '')::text AS nsf_domaine_titre
        FROM postes_scope ps
        JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
        LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    ),
    req AS (
        SELECT DISTINCT
            pi.id_poste,
            c.id_comp,
            c.code,
            c.intitule,
            COALESCE(fpc.niveau_requis, '')::text AS niveau_requis,
            COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
            pi.edu_min_rank,
            pi.nsf_domain_required,
            pi.nsf_domaine_titre
        FROM poste_info pi
        JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = pi.id_poste
        JOIN public.tbl_competence c
          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE c.etat = 'active'
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    pool_all_effectifs AS (
        SELECT
            e.id_effectif,
            e.id_poste_actuel,
            COALESCE(e.niveau_education, '') AS niveau_education,
            COALESCE(e.domaine_education, '') AS domaine_education
        FROM public.tbl_effectif_client e
        JOIN effectifs_dispo ed ON ed.id_effectif = e.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
    ),
    ec_raw AS (
        SELECT
            r.id_poste,
            r.id_comp,
            r.code,
            r.intitule,
            r.poids_criticite,
            r.niveau_requis,
            pe.id_effectif,
            pe.id_poste_actuel,
            CASE upper(trim(COALESCE(r.niveau_requis, '')))
                WHEN 'A' THEN 1
                WHEN 'B' THEN 2
                WHEN 'C' THEN 3
                WHEN 'D' THEN 4
                ELSE 0
            END AS req_rank,
            CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
                WHEN 'a' THEN 1
                WHEN 'initial' THEN 1
                WHEN 'b' THEN 2
                WHEN 'avance' THEN 2
                WHEN 'avancé' THEN 2
                WHEN 'avancee' THEN 2
                WHEN 'avancée' THEN 2
                WHEN 'c' THEN 3
                WHEN 'expert' THEN 3
                ELSE 0
            END AS act_rank,
            CASE
                WHEN a.id_audit_competence IS NOT NULL AND a.resultat_eval IS NOT NULL THEN TRUE
                WHEN ec.date_derniere_eval IS NOT NULL THEN TRUE
                ELSE FALSE
            END AS is_evaluee,
            CASE
              WHEN (
                r.edu_min_rank = 0
                OR (
                  CASE
                    WHEN trim(COALESCE(pe.niveau_education, '')) ~ '^[0-9]+$' THEN trim(pe.niveau_education)::int
                    ELSE 0
                  END
                ) >= r.edu_min_rank
              )
              AND (
                r.nsf_domain_required = FALSE
                OR (
                  lower(trim(COALESCE(pe.domaine_education, ''))) = lower(trim(COALESCE(r.nsf_domaine_titre, '')))
                  AND COALESCE(r.nsf_domaine_titre, '') <> ''
                )
              )
              THEN TRUE ELSE FALSE
            END AS is_eligible
        FROM req r
        JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = r.id_comp
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
        JOIN pool_all_effectifs pe ON pe.id_effectif = ec.id_effectif_client
        WHERE COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    ec_ok AS (
        SELECT
            *,
            CASE
                WHEN req_rank > 0 THEN (is_evaluee AND act_rank >= req_rank)
                ELSE (is_evaluee AND act_rank > 0)
            END AS is_ok
        FROM ec_raw
    )
    SELECT
        r.id_poste,
        r.id_comp,
        r.code,
        r.intitule,
        r.poids_criticite,
        r.niveau_requis,
        COUNT(DISTINCT CASE WHEN eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_any,
        COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible AND eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_ok,
        COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible THEN eok.id_effectif END)::int AS nb_ok_all
    FROM req r
    LEFT JOIN ec_ok eok ON eok.id_poste = r.id_poste AND eok.id_comp = r.id_comp
    GROUP BY r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis
    """
    cur.execute(sql_comp, tuple(cte_params + [as_of, as_of, as_of, int(criticite_min)]))
    comp_rows = cur.fetchall() or []

    comp_by_poste: Dict[str, List[Dict[str, Any]]] = {}
    for r in comp_rows:
        comp_by_poste.setdefault(str(r.get("id_poste") or ""), []).append(dict(r))

    records: List[Dict[str, Any]] = []
    for poste_id, poste in postes_map.items():
        rec = _compute_poste_fragility_record(poste, comp_by_poste.get(poste_id, []), employees)
        if rec.get("is_excluded"):
            continue
        records.append(rec)

    records.sort(
        key=lambda r: (
            -int(r.get("indice_fragilite") or 0),
            int(r.get("nb_titulaires") or 0),
            -int(r.get("nb_critiques_sans_porteur") or 0),
            -int(r.get("gap_titulaires") or 0),
            -int(r.get("nb_critiques_porteur_unique") or 0),
            -int(r.get("nb_critiques_sans_releve") or 0),
            str(r.get("codif_poste") or ""),
            str(r.get("intitule_poste") or ""),
        )
    )
    return records


def _compute_timeline(cur, id_ent: str, scope: DashboardScope, current_records: List[Dict[str, Any]], criticite_min: int) -> List[DashboardRiskTimelinePoint]:
    today = date.today()
    out: List[DashboardRiskTimelinePoint] = []
    for i in range(13):
        d = _month_add(today, i)
        if i == 0:
            records = current_records
        else:
            period_start, period_end = _month_bounds(today, i)
            records = _fetch_postes_fragility_records_projected(
                cur,
                id_ent,
                scope.id_service,
                int(criticite_min),
                period_start,
                period_end,
            )
        fragile = [r for r in records if bool(r.get("is_fragile"))]
        out.append(
            DashboardRiskTimelinePoint(
                date_ref=d.isoformat(),
                label=d.strftime("%m/%y"),
                indice_fragilite=_avg_fragility(records),
                nb_postes_fragiles=len(fragile),
                nb_postes_total=len(records),
            )
        )
    return out

def _compute_postes_watch(records: List[Dict[str, Any]]) -> DashboardPostesWatch:
    total = len(records)
    danger = [r for r in records if _is_danger_record(r)]
    watch = [r for r in records if _is_watch_record(r)]
    stable = max(total - len(danger) - len(watch), 0)
    critical_danger = [r for r in danger if int(r.get("criticite_poste") or 2) >= DASHBOARD_CRITICAL_POSTE_MIN]
    return DashboardPostesWatch(
        total_postes=total,
        postes_danger=len(danger),
        postes_surveillance=len(watch),
        postes_stables=stable,
        postes_critiques_danger=len(critical_danger),
    )


def _compute_transmission(records: List[Dict[str, Any]]) -> DashboardTransmission:
    total = len(records)
    ok = 0
    risk = 0
    for r in records:
        rupture = bool(r.get("rupture"))
        sans_releve = int(r.get("nb_critiques_sans_releve") or 0)
        releve_faible = int(r.get("nb_critiques_releve_faible") or 0)
        pool_eligible = int(r.get("pool_eligible") or 0)
        besoin_local = int(r.get("besoin_local") or 0)
        transmissible = (not rupture) and besoin_local > 0 and pool_eligible > 0 and sans_releve == 0 and releve_faible == 0
        if transmissible:
            ok += 1
        else:
            risk += 1
    pct = round((ok / total * 100.0), 1) if total else 0.0
    return DashboardTransmission(
        pct=pct,
        postes_total=total,
        postes_transmissibles=ok,
        postes_risque=risk,
    )


def _compute_reliability(cur, id_ent: str, scope: DashboardScope, criticite_min: int) -> DashboardReliability:
    cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)
    cur.execute(
        f"""
        WITH
        {cte_sql},
        eff AS (
            SELECT e.id_effectif, e.id_poste_actuel
            FROM effectifs_scope es
            JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
            WHERE COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND COALESCE(e.id_poste_actuel, '') <> ''
        ),
        items AS (
            SELECT
                eff.id_effectif,
                fpc.id_competence,
                GREATEST(
                    COALESCE(ec.date_derniere_eval, DATE '1900-01-01'),
                    COALESCE(a.date_audit, DATE '1900-01-01')
                ) AS last_eval
            FROM eff
            JOIN public.tbl_fiche_poste_competence fpc
              ON fpc.id_poste = eff.id_poste_actuel
             AND COALESCE(fpc.masque, FALSE) = FALSE
             AND COALESCE(fpc.poids_criticite, 0)::int >= %s
            LEFT JOIN public.tbl_effectif_client_competence ec
              ON ec.id_effectif_client = eff.id_effectif
             AND ec.id_comp = fpc.id_competence
             AND COALESCE(ec.actif, TRUE) = TRUE
             AND COALESCE(ec.archive, FALSE) = FALSE
            LEFT JOIN public.tbl_effectif_client_audit_competence a
              ON a.id_audit_competence = ec.id_dernier_audit
             AND a.id_effectif_competence = ec.id_effectif_competence
        )
        SELECT
            COUNT(*)::int AS total_items,
            SUM(CASE WHEN last_eval >= (CURRENT_DATE - INTERVAL '6 months') THEN 1 ELSE 0 END)::int AS fresh_items
        FROM items
        """,
        tuple(cte_params + [int(criticite_min)]),
    )
    row = cur.fetchone() or {}
    total = int(row.get("total_items") or 0)
    fresh = int(row.get("fresh_items") or 0)
    stale = max(total - fresh, 0)
    pct = round((fresh / total * 100.0), 1) if total else 0.0
    return DashboardReliability(
        pct=pct,
        fresh_items=fresh,
        stale_items=stale,
        total_items=total,
        seuil_mois=DASHBOARD_RELIABILITY_MONTHS,
    )


def _fetch_postes_with_action(cur, id_ent: str, scope: DashboardScope) -> set:
    cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)
    cur.execute(
        f"""
        WITH
        {cte_sql},
        eff AS (
            SELECT e.id_effectif, e.id_poste_actuel
            FROM effectifs_scope es
            JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
            WHERE COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND COALESCE(e.id_poste_actuel, '') <> ''
        ),
        formation_action AS (
            SELECT DISTINCT e.id_poste_actuel AS id_poste
            FROM eff e
            JOIN public.tbl_action_formation_effectif afe
              ON afe.id_effectif = e.id_effectif
             AND COALESCE(afe.archive, FALSE) = FALSE
            JOIN public.tbl_action_formation af
              ON af.id_action_formation = afe.id_action_formation
             AND COALESCE(af.archive, FALSE) = FALSE
            WHERE COALESCE(af.etat_action, '') NOT IN ('annulée', 'annulee', 'annulé', 'annule')
              AND (af.date_fin_formation IS NULL OR af.date_fin_formation >= CURRENT_DATE)
        ),
        entretien_action AS (
            SELECT DISTINCT e.id_poste_actuel AS id_poste
            FROM eff e
            JOIN public.tbl_entretien_individuel ei
              ON ei.id_effectif_client = e.id_effectif
             AND COALESCE(ei.archive, FALSE) = FALSE
            WHERE lower(COALESCE(ei.statut, '')) IN ('à réaliser', 'a réaliser', 'en cours', 'en-cours', 'à signer 1/2', 'a signer 1/2')
        )
        SELECT id_poste FROM formation_action
        UNION
        SELECT id_poste FROM entretien_action
        """,
        tuple(cte_params),
    )
    rows = cur.fetchall() or []
    return {str(r.get("id_poste") or "") for r in rows if r.get("id_poste")}


def _compute_risks_without_action(cur, id_ent: str, scope: DashboardScope, records: List[Dict[str, Any]]) -> DashboardRisksWithoutAction:
    action_postes = _fetch_postes_with_action(cur, id_ent, scope)
    rows = []
    for r in records:
        id_poste = str(r.get("id_poste") or "").strip()
        if not id_poste or id_poste in action_postes:
            continue
        if not _is_danger_record(r):
            continue
        rows.append(r)

    items = [
        DashboardRiskWithoutActionRow(
            id_poste=str(r.get("id_poste") or ""),
            codif_poste=r.get("codif_poste"),
            codif_client=r.get("codif_client"),
            intitule_poste=r.get("intitule_poste") or "Poste",
            nom_service=r.get("nom_service"),
            indice_fragilite=int(r.get("indice_fragilite") or 0),
            criticite_poste=int(r.get("criticite_poste") or 0),
            nb_titulaires=int(r.get("nb_titulaires") or 0),
            nb_titulaires_cible=int(r.get("nb_titulaires_cible") or 0),
            nb_critiques_fragiles=int(r.get("nb_critiques_fragiles") or 0),
            nb_critiques_sans_porteur=int(r.get("nb_critiques_sans_porteur") or 0),
            nb_critiques_sans_releve=int(r.get("nb_critiques_sans_releve") or 0),
        )
        for r in rows[:DASHBOARD_NO_ACTION_LIMIT]
    ]
    return DashboardRisksWithoutAction(total=len(rows), items=items)


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
    criticite = _normalize_criticite_min(criticite_min)

    current_records = _fetch_postes_fragility_records(
        cur,
        id_ent,
        scope.id_service,
        criticite,
    )
    _enrich_records_poste_criticite(cur, current_records)

    health = _compute_health(cur, id_ent, scope, criticite)
    risk_timeline = _compute_timeline(cur, id_ent, scope, current_records, criticite)
    postes_watch = _compute_postes_watch(current_records)
    transmission = _compute_transmission(current_records)
    reliability = _compute_reliability(cur, id_ent, scope, criticite)
    risks_without_action = _compute_risks_without_action(cur, id_ent, scope, current_records)

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
