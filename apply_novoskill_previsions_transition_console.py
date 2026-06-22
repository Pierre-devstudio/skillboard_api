from pathlib import Path
import re

ROOT = Path.cwd()
if not (ROOT / "unified_api").exists() and (ROOT / "skillboard_api" / "unified_api").exists():
    ROOT = ROOT / "skillboard_api"

ENGINE = ROOT / "unified_api/app/services/skills_analyse_engine.py"
ROUTER = ROOT / "unified_api/app/routers/skills_portal_analyse.py"
HTML = ROOT / "static/menus/skills_analyse.html"
JS = ROOT / "static/menus/skills_analyse.js"

for p in (ENGINE, ROUTER, HTML, JS):
    if not p.exists():
        raise FileNotFoundError(f"Fichier introuvable : {p}")


def read(p):
    return p.read_text(encoding="utf-8")


def write(p, s):
    p.write_text(s, encoding="utf-8", newline="\n")


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f"Bloc introuvable pour remplacement : {label}")
    return text.replace(old, new, 1)


def replace_between(text, start_marker, end_marker, new_block, label):
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Marqueur début introuvable : {label}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"Marqueur fin introuvable : {label}")
    return text[:start] + new_block + text[end:]


ENGINE_BLOCK = r'''

# ======================================================
# Prévisions RH - console transitions / transmissions
# ======================================================
def _prevision_exit_kind_label(kind: str) -> str:
    k = (kind or "").strip().lower()
    if k == "confirmed":
        return "Sortie confirmée"
    if k == "potential":
        return "Sortie potentielle"
    return "Sortie prévue"


def _prevision_transition_priority_label(row: Dict[str, Any]) -> str:
    ecart = _safe_int(row.get("ecart_titulaires"), 0)
    indirect = _safe_int(row.get("nb_postes_indirects"), 0)
    comps = _safe_int(row.get("nb_competences_critiques"), 0)
    if ecart > 0 or comps >= 10 or indirect >= 3:
        return "Critique"
    if comps >= 5 or indirect >= 1:
        return "Élevée"
    if comps > 0:
        return "Modérée"
    return "Faible"


def _prevision_transition_impact_label(row: Dict[str, Any]) -> str:
    ecart = _safe_int(row.get("ecart_titulaires"), 0)
    indirect = _safe_int(row.get("nb_postes_indirects"), 0)
    comps = _safe_int(row.get("nb_competences_critiques"), 0)
    if ecart > 0:
        return "Poste sous cible"
    if indirect > 0:
        return f"{indirect} poste(s) indirectement impacté(s)"
    if comps > 0:
        return f"{comps} compétence(s) à sécuriser"
    return "Impact limité"


def _fetch_prevision_transition_events(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
    event_kind: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """
    Lecture prévisionnelle orientée événement RH.
    - confirmed = date_sortie_prevue renseignée.
    - potential = retraite_estimee sans date_sortie_prevue.
    Le calcul reste centralisé ici : périmètre, filtres actifs/archive/masque, impact direct et impact indirect.
    """
    scope_id = (id_service or "").strip() or None
    horizon = max(1, min(5, int(horizon_years or 1)))
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    lim = max(1, min(2000, int(limit or 200)))
    kind = (event_kind or "").strip().lower()
    if kind not in ("confirmed", "potential"):
        kind = ""

    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)
    kind_filter = "AND ee.exit_kind = %s" if kind else ""

    sql = f"""
    WITH
    {cte_sql},
    effectifs_valid AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_service,
            e.id_poste_actuel,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
            e.motif_sortie,
            e.retraite_estimee::int AS retraite_annee,
            COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,
            COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
    ),
    effectifs_exit AS (
        SELECT
            ev.*,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN
                    (
                        make_date(ev.retraite_annee, ev.m_entree, 1)
                        + ((LEAST(ev.d_entree, EXTRACT(DAY FROM (date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1)) + interval '1 month - 1 day'))::int) - 1)::text || ' days')::interval
                    )::date
                ELSE NULL
            END AS exit_date,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN 'confirmed'
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN 'potential'
                ELSE NULL
            END AS exit_kind,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                    NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                    CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                )
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                ELSE NULL
            END AS raison_sortie
        FROM effectifs_valid ev
    ),
    filtered_exit AS (
        SELECT *
        FROM effectifs_exit ee
        WHERE ee.exit_date IS NOT NULL
          AND ee.exit_date >= CURRENT_DATE
          AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
          {kind_filter}
    ),
    titulaires_poste AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires_now
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
        GROUP BY e.id_poste_actuel
    ),
    comp_portees AS (
        SELECT DISTINCT fe.id_effectif, ec.id_comp
        FROM filtered_exit fe
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = fe.id_effectif
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    comp_impact AS (
        SELECT
            cp.id_effectif,
            COUNT(DISTINCT fpc.id_competence)::int AS nb_competences_critiques,
            COUNT(DISTINCT CASE WHEN fpc.id_poste <> fe.id_poste_actuel THEN fpc.id_poste END)::int AS nb_postes_indirects,
            MAX(COALESCE(fpc.poids_criticite, 0))::int AS max_criticite
        FROM comp_portees cp
        JOIN filtered_exit fe ON fe.id_effectif = cp.id_effectif
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_competence = cp.id_comp
         AND COALESCE(fpc.masque, FALSE) = FALSE
         AND COALESCE(fpc.poids_criticite, 0)::int >= %s
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
        WHERE COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') = 'active'
        GROUP BY cp.id_effectif
    )
    SELECT
        fe.id_effectif,
        fe.prenom_effectif,
        fe.nom_effectif,
        TRIM(CONCAT(COALESCE(fe.prenom_effectif, ''), ' ', COALESCE(fe.nom_effectif, ''))) AS full,
        fe.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        fe.id_poste_actuel,
        COALESCE(fp.intitule_poste, '') AS intitule_poste,
        COALESCE(fp.codif_poste, '') AS codif_poste,
        COALESCE(fp.codif_client, '') AS codif_client,
        fe.exit_date,
        fe.exit_kind,
        fe.havedatefin,
        fe.motif_sortie,
        fe.raison_sortie,
        (fe.exit_date - CURRENT_DATE)::int AS days_left,
        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
        COALESCE(tp.nb_titulaires_now, 0)::int AS nb_titulaires_now,
        GREATEST(COALESCE(tp.nb_titulaires_now, 0)::int - CASE WHEN COALESCE(fe.id_poste_actuel, '') <> '' THEN 1 ELSE 0 END, 0)::int AS nb_titulaires_after,
        GREATEST(COALESCE(prh.nb_titulaires_cible, 1)::int - GREATEST(COALESCE(tp.nb_titulaires_now, 0)::int - CASE WHEN COALESCE(fe.id_poste_actuel, '') <> '' THEN 1 ELSE 0 END, 0), 0)::int AS ecart_titulaires,
        COALESCE(ci.nb_competences_critiques, 0)::int AS nb_competences_critiques,
        COALESCE(ci.nb_postes_indirects, 0)::int AS nb_postes_indirects,
        COALESCE(ci.max_criticite, 0)::int AS max_criticite
    FROM filtered_exit fe
    LEFT JOIN public.tbl_entreprise_organigramme o ON o.id_ent = %s AND o.id_service = fe.id_service AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = fe.id_poste_actuel
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fe.id_poste_actuel
    LEFT JOIN titulaires_poste tp ON tp.id_poste = fe.id_poste_actuel
    LEFT JOIN comp_impact ci ON ci.id_effectif = fe.id_effectif
    ORDER BY
        CASE WHEN GREATEST(COALESCE(prh.nb_titulaires_cible, 1)::int - GREATEST(COALESCE(tp.nb_titulaires_now, 0)::int - CASE WHEN COALESCE(fe.id_poste_actuel, '') <> '' THEN 1 ELSE 0 END, 0), 0)::int > 0 THEN 0 ELSE 1 END,
        COALESCE(ci.max_criticite, 0)::int DESC,
        COALESCE(ci.nb_postes_indirects, 0)::int DESC,
        fe.exit_date ASC,
        fe.nom_effectif ASC,
        fe.prenom_effectif ASC
    LIMIT %s
    """
    params: List[Any] = list(cte_params) + [id_ent, horizon]
    if kind:
        params.append(kind)
    params += [id_ent, cmin, id_ent, lim]

    cur.execute(sql, tuple(params))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    out: List[Dict[str, Any]] = []
    for r in rows:
        exit_date = r.get("exit_date")
        if hasattr(exit_date, "isoformat"):
            exit_date = exit_date.isoformat()
        item = dict(r)
        item["exit_date"] = exit_date
        item["event_kind"] = item.get("exit_kind") or ""
        item["event_kind_label"] = _prevision_exit_kind_label(item.get("exit_kind") or "")
        item["impact_label"] = _prevision_transition_impact_label(item)
        item["priorite_label"] = _prevision_transition_priority_label(item)
        out.append(item)
    return out


def _fetch_prevision_transmission_items(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """
    Compétences à transmettre ou couvrir avant une sortie confirmée/potentielle.
    Les lignes sont volontairement orientées action : compétence + porteur + échéance + relais possibles.
    """
    scope_id = (id_service or "").strip() or None
    horizon = max(1, min(5, int(horizon_years or 1)))
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    lim = max(1, min(2000, int(limit or 200)))
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)

    sql = f"""
    WITH
    {cte_sql},
    effectifs_valid AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_service,
            e.id_poste_actuel,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
            e.motif_sortie,
            e.retraite_estimee::int AS retraite_annee,
            COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,
            COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
    ),
    effectifs_exit AS (
        SELECT
            ev.*,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN
                    (
                        make_date(ev.retraite_annee, ev.m_entree, 1)
                        + ((LEAST(ev.d_entree, EXTRACT(DAY FROM (date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1)) + interval '1 month - 1 day'))::int) - 1)::text || ' days')::interval
                    )::date
                ELSE NULL
            END AS exit_date,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN 'confirmed'
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN 'potential'
                ELSE NULL
            END AS exit_kind,
            CASE
                WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                    NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                    CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                )
                WHEN ev.date_sortie_prevue IS NULL AND ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                ELSE NULL
            END AS raison_sortie
        FROM effectifs_valid ev
    ),
    leaving AS (
        SELECT *
        FROM effectifs_exit ee
        WHERE ee.exit_date IS NOT NULL
          AND ee.exit_date >= CURRENT_DATE
          AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
    ),
    leaving_comp AS (
        SELECT
            l.*,
            ec.id_comp,
            ec.niveau_actuel
        FROM leaving l
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = l.id_effectif
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    impacted_req AS (
        SELECT
            lc.id_effectif,
            lc.id_comp,
            COUNT(DISTINCT fpc.id_poste)::int AS nb_postes_impactes,
            MAX(COALESCE(fpc.poids_criticite, 0))::int AS max_criticite,
            MAX(CASE COALESCE(fpc.niveau_requis, '') WHEN 'D' THEN 4 WHEN 'C' THEN 3 WHEN 'B' THEN 2 WHEN 'A' THEN 1 ELSE 0 END)::int AS niveau_requis_rank
        FROM leaving_comp lc
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_competence = lc.id_comp
         AND COALESCE(fpc.masque, FALSE) = FALSE
         AND COALESCE(fpc.poids_criticite, 0)::int >= %s
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
        WHERE COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') = 'active'
        GROUP BY lc.id_effectif, lc.id_comp
    ),
    receveurs AS (
        SELECT
            ec.id_comp,
            COUNT(DISTINCT e.id_effectif)::int AS receveurs_potentiels_count,
            STRING_AGG(DISTINCT TRIM(CONCAT(COALESCE(e.prenom_effectif, ''), ' ', COALESCE(e.nom_effectif, ''))), ', ') AS receveurs_potentiels_label
        FROM public.tbl_effectif_client_competence ec
        JOIN public.tbl_effectif_client e ON e.id_effectif = ec.id_effectif_client
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND NOT EXISTS (SELECT 1 FROM leaving l WHERE l.id_effectif = e.id_effectif)
        GROUP BY ec.id_comp
    )
    SELECT
        lc.id_effectif,
        lc.prenom_effectif,
        lc.nom_effectif,
        TRIM(CONCAT(COALESCE(lc.prenom_effectif, ''), ' ', COALESCE(lc.nom_effectif, ''))) AS full,
        lc.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        lc.id_poste_actuel,
        COALESCE(fp.intitule_poste, '') AS intitule_poste,
        COALESCE(fp.codif_poste, '') AS codif_poste,
        COALESCE(fp.codif_client, '') AS codif_client,
        lc.exit_date,
        lc.exit_kind,
        lc.raison_sortie,
        lc.id_comp,
        COALESCE(c.code, '') AS code,
        COALESCE(c.intitule, '') AS intitule,
        COALESCE(c.domaine, '') AS domaine,
        COALESCE(lc.niveau_actuel, '') AS niveau_actuel,
        CASE COALESCE(ir.niveau_requis_rank, 0) WHEN 4 THEN 'D' WHEN 3 THEN 'C' WHEN 2 THEN 'B' WHEN 1 THEN 'A' ELSE '' END AS niveau_a_transmettre,
        COALESCE(ir.nb_postes_impactes, 0)::int AS nb_postes_impactes,
        COALESCE(ir.max_criticite, 0)::int AS max_criticite,
        COALESCE(r.receveurs_potentiels_count, 0)::int AS receveurs_potentiels_count,
        COALESCE(r.receveurs_potentiels_label, '') AS receveurs_potentiels_label
    FROM leaving_comp lc
    JOIN impacted_req ir ON ir.id_effectif = lc.id_effectif AND ir.id_comp = lc.id_comp
    JOIN public.tbl_competence c ON c.id_comp = lc.id_comp
    LEFT JOIN public.tbl_entreprise_organigramme o ON o.id_ent = %s AND o.id_service = lc.id_service AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = lc.id_poste_actuel
    LEFT JOIN receveurs r ON r.id_comp = lc.id_comp
    ORDER BY ir.max_criticite DESC, ir.nb_postes_impactes DESC, lc.exit_date ASC, c.code ASC
    LIMIT %s
    """
    params = list(cte_params) + [id_ent, horizon, cmin, id_ent, id_ent, lim]
    cur.execute(sql, tuple(params))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    out: List[Dict[str, Any]] = []
    for r in rows:
        exit_date = r.get("exit_date")
        if hasattr(exit_date, "isoformat"):
            exit_date = exit_date.isoformat()
        item = dict(r)
        item["exit_date"] = exit_date
        current_rank = _niveau_rank(item.get("niveau_actuel"))
        target_rank = _niveau_rank(item.get("niveau_a_transmettre"))
        item["titulaire_transmet_label"] = "Oui" if current_rank >= target_rank and target_rank > 0 else "À confirmer"
        if _safe_int(item.get("max_criticite"), 0) >= 75 or _safe_int(item.get("receveurs_potentiels_count"), 0) <= 0:
            item["priorite_label"] = "Critique"
        elif _safe_int(item.get("max_criticite"), 0) >= 50:
            item["priorite_label"] = "Élevée"
        else:
            item["priorite_label"] = "Modérée"
        item["impact_label"] = f"{_safe_int(item.get('nb_postes_impactes'), 0)} poste(s)"
        item["event_kind_label"] = _prevision_exit_kind_label(item.get("exit_kind") or "")
        out.append(item)
    return out


def _fetch_prevision_transition_counts(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    horizon_max: int = 5,
) -> Dict[int, Dict[str, int]]:
    """Compteurs de la tuile Prévisions, calculés depuis le moteur transition central."""
    out: Dict[int, Dict[str, int]] = {}
    max_h = max(1, min(5, int(horizon_max or 5)))
    for h in range(1, max_h + 1):
        confirmed = _fetch_prevision_transition_events(cur, id_ent, id_service, h, criticite_min, "confirmed", 2000)
        potential = _fetch_prevision_transition_events(cur, id_ent, id_service, h, criticite_min, "potential", 2000)
        transmissions = _fetch_prevision_transmission_items(cur, id_ent, id_service, h, criticite_min, 2000)
        out[h] = {
            "sorties_confirmees": len(confirmed),
            "sorties_potentielles": len(potential),
            "transmissions_a_preparer": len(transmissions),
        }
    return out
'''

ROUTER_ENDPOINTS_BLOCK = r'''

# ======================================================
# Endpoints Prévisions RH - transitions / transmissions
# ======================================================
@router.get("/skills/analyse/previsions/sorties-confirmees/detail/{id_contact}")
def get_analyse_previsions_sorties_confirmees_detail(
    id_contact: str,
    request: Request,
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=200, ge=1, le=2000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                items = _fetch_prevision_transition_events(
                    cur, id_ent, scope.id_service, int(horizon_years), int(criticite_min), "confirmed", int(limit)
                )
                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "criticite_min": int(criticite_min),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "items": items,
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get("/skills/analyse/previsions/sorties-potentielles/detail/{id_contact}")
def get_analyse_previsions_sorties_potentielles_detail(
    id_contact: str,
    request: Request,
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=200, ge=1, le=2000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                items = _fetch_prevision_transition_events(
                    cur, id_ent, scope.id_service, int(horizon_years), int(criticite_min), "potential", int(limit)
                )
                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "criticite_min": int(criticite_min),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "items": items,
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get("/skills/analyse/previsions/transmissions/detail/{id_contact}")
def get_analyse_previsions_transmissions_detail(
    id_contact: str,
    request: Request,
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=200, ge=1, le=2000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                items = _fetch_prevision_transmission_items(
                    cur, id_ent, scope.id_service, int(horizon_years), int(criticite_min), int(limit)
                )
                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "criticite_min": int(criticite_min),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "items": items,
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
'''

NEW_TILE_HTML = r'''      <!-- Tuile Prévisions -->
      <div class="card analyse-tile sb-tile" id="tilePrevisions" data-mode="previsions" role="button" tabindex="0" aria-label="Ouvrir Prévisions">
        <div class="analyse-card-head">
          <div class="card-title" id="prevTileTitle" style="margin-bottom:2px;">Prévisions à N+1</div>
          <button type="button" class="analyse-help-dot" data-analyse-help="previsions" aria-label="Comprendre la carte Prévisions">?</button>
        </div>
        <div class="tile-sub sb-tile-sub">Anticiper les départs, mesurer leurs impacts et préparer les transmissions.</div>

        <div class="sb-prev-horizon-control" style="margin:10px 0 12px 0;" data-prev-slider-host>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12px; color:#6b7280;">
            <span>Horizon de prévision</span>
            <strong id="prevHorizonLabel">N+1</strong>
          </div>
          <input type="range" id="prevHorizonSlider" min="1" max="5" step="1" value="1"
                 aria-label="Période de prévision N plus X" style="width:100%; margin-top:6px;">
        </div>

        <div class="mini-kpis sb-mini-kpis">
          <div class="mini-kpi sb-mini-kpi" data-prev-kpi="sorties-confirmees" role="button" tabindex="0" aria-label="Afficher les sorties confirmées">
            <div class="label">Sorties confirmées</div>
            <div class="value" id="kpiPrevSortiesConfirmees">—</div>
          </div>

          <div class="mini-kpi sb-mini-kpi" data-prev-kpi="sorties-potentielles" role="button" tabindex="0" aria-label="Afficher les sorties potentielles">
            <div class="label">Sorties potentielles</div>
            <div class="value" id="kpiPrevSortiesPotentielles">—</div>
          </div>

          <div class="mini-kpi sb-mini-kpi" data-prev-kpi="transmissions" role="button" tabindex="0" aria-label="Afficher les transmissions à préparer">
            <div class="label">Transmissions à préparer</div>
            <div class="value" id="kpiPrevTransmissions">—</div>
          </div>
        </div>

        <div class="tile-hint sb-tile-hint">Prévisions : identifier les transitions à préparer, puis tester les scénarios RH.</div>
      </div>

'''

JS_PREVISION_FUNCTIONS = r'''

  // ======================================================
  // Prévisions RH - transition console helpers
  // ======================================================
  function analysePrevisionValidKpi(key) {
    const k = (key || "").toString().trim().toLowerCase();
    return ["sorties-confirmees", "sorties-potentielles", "transmissions"].includes(k) ? k : "sorties-confirmees";
  }

  function analysePriorityBadge(label) {
    const txt = (label || "—").toString();
    const k = txt.toLowerCase();
    const tone = k.includes("crit") ? "#991b1b" : (k.includes("élev") || k.includes("elev") ? "#9a3412" : (k.includes("mod") ? "#854d0e" : "#166534"));
    const bg = k.includes("crit") ? "#fee2e2" : (k.includes("élev") || k.includes("elev") ? "#ffedd5" : (k.includes("mod") ? "#fef3c7" : "#dcfce7"));
    const br = k.includes("crit") ? "#fecaca" : (k.includes("élev") || k.includes("elev") ? "#fed7aa" : (k.includes("mod") ? "#fde68a" : "#bbf7d0"));
    return `<span style="display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:999px; border:1px solid ${br}; background:${bg}; color:${tone}; font-weight:800; font-size:12px; white-space:nowrap;">${escapeHtml(txt)}</span>`;
  }

  function analysePrevisionDate(v) {
    const s = (v || "").toString().trim();
    if (!s) return "—";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(s);
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  async function fetchPrevisionsTransitionDetail(portal, kind, horizonYears, id_service, limit = 2000) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const k = kind === "potential" ? "sorties-potentielles" : "sorties-confirmees";
    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${ctx.apiBase}/skills/analyse/previsions/${k}/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  async function fetchPrevisionsTransmissionsDetail(portal, horizonYears, id_service, limit = 2000) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${ctx.apiBase}/skills/analyse/previsions/transmissions/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  function ensureAnalysePrevisionActionModal() {
    let modal = byId("modalAnalysePrevisionAction");
    if (modal) return modal;
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal" id="modalAnalysePrevisionAction" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
              <div style="font-weight:700;" id="analysePrevisionActionTitle">Détail prévisionnel</div>
              <div class="card-sub" id="analysePrevisionActionSub" style="margin:0;"></div>
            </div>
            <button type="button" class="modal-x" id="btnCloseAnalysePrevisionActionModal" aria-label="Fermer">×</button>
          </div>
          <div class="modal-body" id="analysePrevisionActionBody"></div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--accent" id="btnAnalysePrevisionActionHypothesis">Tester un scénario RH</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnAnalysePrevisionActionClose">Fermer</button>
          </div>
        </div>
      </div>
    `);
    modal = byId("modalAnalysePrevisionAction");
    const close = () => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    };
    byId("btnCloseAnalysePrevisionActionModal")?.addEventListener("click", close);
    byId("btnAnalysePrevisionActionClose")?.addEventListener("click", close);
    byId("btnAnalysePrevisionActionHypothesis")?.addEventListener("click", () => {
      close();
      setStatus("Scénario RH à créer depuis Simulation RH avec les éléments prévisionnels sélectionnés.");
    });
    modal.addEventListener("click", (ev) => { if (ev.target === modal) close(); });
    return modal;
  }

  function openAnalysePrevisionTransitionModal(row, modeLabel) {
    const r = row || {};
    const modal = ensureAnalysePrevisionActionModal();
    const title = byId("analysePrevisionActionTitle");
    const sub = byId("analysePrevisionActionSub");
    const body = byId("analysePrevisionActionBody");
    const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "Collaborateur";
    const poste = r.intitule_poste || "Poste non renseigné";
    const dateTxt = analysePrevisionDate(r.exit_date);
    const cible = Number(r.nb_titulaires_cible || 0) || 0;
    const now = Number(r.nb_titulaires_now || 0) || 0;
    const after = Number(r.nb_titulaires_after || 0) || 0;
    const ecart = Number(r.ecart_titulaires || 0) || 0;
    const indirect = Number(r.nb_postes_indirects || 0) || 0;
    const comps = Number(r.nb_competences_critiques || 0) || 0;

    if (title) title.textContent = `${modeLabel || "Transition à préparer"} — ${full}`;
    if (sub) sub.textContent = `${poste} · ${dateTxt}`;
    if (body) {
      body.innerHTML = `
        <div class="sb-prev-modal-grid">
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Événement RH</div>
            <div class="sb-prev-action-list">
              <div><strong>${escapeHtml(full)}</strong> · ${escapeHtml(r.raison_sortie || r.event_kind_label || "Sortie prévue")}</div>
              <div>Date / horizon : <strong>${dateTxt}</strong></div>
              <div>Poste actuel : <strong>${escapeHtml(poste)}</strong></div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Impact direct sur le poste</div>
            <div class="sb-prev-kpi-grid sb-prev-kpi-grid--4">
              <div class="sb-prev-kpi"><span>Cible RH</span><strong>${escapeHtml(String(cible || "—"))}</strong></div>
              <div class="sb-prev-kpi"><span>Avant sortie</span><strong>${escapeHtml(String(now || 0))}</strong></div>
              <div class="sb-prev-kpi"><span>Après sortie</span><strong>${escapeHtml(String(after || 0))}</strong></div>
              <div class="sb-prev-kpi"><span>Écart à couvrir</span><strong>${escapeHtml(String(ecart || 0))}</strong></div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Impact indirect</div>
            <div class="sb-prev-action-list">
              <div>${escapeHtml(String(indirect))} poste(s) indirectement impacté(s)</div>
              <div>${escapeHtml(String(comps))} compétence(s) critique(s) à sécuriser</div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">À préparer</div>
            <div class="sb-prev-action-list">
              ${ecart > 0 ? `<div>Préparer un relais, une mobilité ou un recrutement pour couvrir l’écart titulaire.</div>` : `<div>Confirmer que la capacité poste reste suffisante après la sortie.</div>`}
              ${comps > 0 ? `<div>Organiser la transmission des compétences critiques portées par le collaborateur.</div>` : `<div>Vérifier les compétences réellement portées avant arbitrage.</div>`}
              ${indirect > 0 ? `<div>Contrôler les postes indirectement dépendants de ces compétences.</div>` : ``}
              <div>Tester un scénario RH : transmission, mobilité, recrutement ou scénario mixte.</div>
            </div>
          </div>
        </div>
      `;
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function openAnalysePrevisionTransmissionModal(row) {
    const r = row || {};
    const modal = ensureAnalysePrevisionActionModal();
    const title = byId("analysePrevisionActionTitle");
    const sub = byId("analysePrevisionActionSub");
    const body = byId("analysePrevisionActionBody");
    const comp = `${r.code ? r.code + " — " : ""}${r.intitule || "Compétence"}`;
    const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "Porteur";
    const dateTxt = analysePrevisionDate(r.exit_date);
    if (title) title.textContent = `Transmission à préparer — ${comp}`;
    if (sub) sub.textContent = `${full} · ${dateTxt}`;
    if (body) {
      body.innerHTML = `
        <div class="sb-prev-modal-grid">
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Ce qui doit être transmis</div>
            <div class="sb-prev-kpi-grid sb-prev-kpi-grid--4">
              <div class="sb-prev-kpi"><span>Niveau porteur</span><strong>${escapeHtml(r.niveau_actuel || "—")}</strong></div>
              <div class="sb-prev-kpi"><span>Niveau cible</span><strong>${escapeHtml(r.niveau_a_transmettre || "—")}</strong></div>
              <div class="sb-prev-kpi"><span>Postes concernés</span><strong>${escapeHtml(String(r.nb_postes_impactes || 0))}</strong></div>
              <div class="sb-prev-kpi"><span>Capacité à transmettre</span><strong>${escapeHtml(r.titulaire_transmet_label || "À confirmer")}</strong></div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Porteur sortant</div>
            <div class="sb-prev-action-list">
              <div><strong>${escapeHtml(full)}</strong> · ${escapeHtml(r.raison_sortie || r.event_kind_label || "Sortie prévue")}</div>
              <div>Échéance : <strong>${dateTxt}</strong></div>
              <div>Poste actuel : <strong>${escapeHtml(r.intitule_poste || "—")}</strong></div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Relais possibles</div>
            <div class="sb-prev-action-list">
              <div>${escapeHtml(String(r.receveurs_potentiels_count || 0))} collaborateur(s) disposent déjà d’une base sur cette compétence.</div>
              <div>${escapeHtml(r.receveurs_potentiels_label || "Aucun relais identifié dans le périmètre.")}</div>
            </div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Scénarios à tester</div>
            <div class="sb-prev-action-list">
              <div>Transmission accélérée vers un relais interne.</div>
              <div>Binôme temporaire avant la sortie.</div>
              <div>Formation ciblée sur le niveau à transmettre.</div>
              <div>Recrutement avec niveau cible ${escapeHtml(r.niveau_a_transmettre || "attendu")} si aucun relais n’est disponible.</div>
            </div>
          </div>
        </div>
      `;
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function renderPrevisionTableTransitionEvents(rows, kind) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;
    const isPotential = kind === "potential";
    window.__sbPrevTransitionRows = list;
    return `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevTransitions">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th>Poste</th>
              <th style="width:120px;">${isPotential ? "Horizon" : "Date"}</th>
              <th style="width:190px;">Impact</th>
              <th class="col-center" style="width:110px;">Priorité</th>
              <th class="col-center" style="width:82px;">Actions</th>
            </tr>
          </thead>
          <tbody>${list.map((r, idx) => {
            const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "—";
            const code = (r.codif_client || r.codif_poste || "").toString().trim();
            const poste = (r.intitule_poste || "—").toString();
            return `<tr class="prev-transition-row" data-index="${idx}">
              <td><strong>${escapeHtml(full)}</strong></td>
              <td>${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span> ` : ""}${escapeHtml(poste)}</td>
              <td>${analysePrevisionDate(r.exit_date)}</td>
              <td>${escapeHtml(r.impact_label || "—")}</td>
              <td class="col-center">${analysePriorityBadge(r.priorite_label || "—")}</td>
              <td class="col-center"><button type="button" class="sb-icon-btn prev-transition-open" title="Voir" aria-label="Voir le détail">${analyseEyeIconSvg()}</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }

  function renderPrevisionTableTransmissionItems(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;
    window.__sbPrevTransmissionRows = list;
    return `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevTransmissions">
          <thead>
            <tr>
              <th>Compétence</th>
              <th>Porteur</th>
              <th style="width:120px;">Échéance</th>
              <th style="width:140px;">Impact</th>
              <th class="col-center" style="width:110px;">Priorité</th>
              <th class="col-center" style="width:82px;">Actions</th>
            </tr>
          </thead>
          <tbody>${list.map((r, idx) => {
            const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "—";
            const code = (r.code || "").toString().trim();
            const comp = (r.intitule || "—").toString();
            return `<tr class="prev-transmission-row" data-index="${idx}">
              <td>${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span> ` : ""}<strong>${escapeHtml(comp)}</strong></td>
              <td>${escapeHtml(full)}</td>
              <td>${analysePrevisionDate(r.exit_date)}</td>
              <td>${escapeHtml(r.impact_label || "—")}</td>
              <td class="col-center">${analysePriorityBadge(r.priorite_label || "—")}</td>
              <td class="col-center"><button type="button" class="sb-icon-btn prev-transmission-open" title="Voir" aria-label="Voir le détail">${analyseEyeIconSvg()}</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }
'''

NEW_PREVISIONS_RENDER_BLOCK = r'''  // -----------------------
  // PREVISIONS
  // -----------------------
  if (mode === "previsions") {
    const horizon = getPrevHorizon();
    const horizonLabel = analyseHorizonLabel(horizon);
    if (title) {
      title.textContent = `Prévisions à ${horizonLabel}`;
      title.style.marginBottom = "0";
    }
    if (sub) {
      sub.textContent = "Départs à absorber et transmissions à préparer.";
      sub.style.display = "";
    }
    if (meta) {
      meta.textContent = `Service : ${scope}`;
      meta.style.display = "";
    }

    let selectedKpi = analysePrevisionValidKpi(localStorage.getItem("sb_analyse_prev_kpi") || "sorties-confirmees");
    localStorage.setItem("sb_analyse_prev_kpi", selectedKpi);
    if (typeof setActivePrevKpi === "function") setActivePrevKpi(selectedKpi);
    renderPrevisionsHeaderActions(selectedKpi, 0);

    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
    const detailTitle = selectedKpi === "sorties-potentielles"
      ? "Sorties potentielles"
      : (selectedKpi === "transmissions" ? "Transmissions à préparer" : "Sorties confirmées");

    body.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div class="card-title" style="margin-bottom:2px;">${escapeHtml(detailTitle)} à ${escapeHtml(horizonLabel)}</div>
            <div class="card-sub" style="margin:0;">Première lecture rapide. Ouvrez une ligne pour voir l’impact et les éléments à préparer.</div>
          </div>
        </div>
        <div id="prevTransitionDetailBox" class="card-sub" style="margin-top:12px;">Chargement…</div>
      </div>
    `;

    window.__sbPrevTransitionReqId = (window.__sbPrevTransitionReqId || 0) + 1;
    const reqId = window.__sbPrevTransitionReqId;

    setTimeout(async () => {
      const box = byId("prevTransitionDetailBox");
      if (!box) return;
      try {
        if (!_portalref) {
          box.textContent = "Contexte portail indisponible (_portalref manquant).";
          return;
        }

        let data = null;
        if (selectedKpi === "transmissions") {
          data = await fetchPrevisionsTransmissionsDetail(_portalref, horizon, id_service, 2000);
        } else {
          data = await fetchPrevisionsTransitionDetail(_portalref, selectedKpi === "sorties-potentielles" ? "potential" : "confirmed", horizon, id_service, 2000);
        }
        if ((window.__sbPrevTransitionReqId || 0) !== reqId) return;

        const items = Array.isArray(data?.items) ? data.items : [];
        renderPrevisionsHeaderActions(selectedKpi, items.length);
        if (!items.length) {
          box.textContent = selectedKpi === "transmissions"
            ? "Aucune transmission critique à préparer dans l’horizon sélectionné."
            : "Aucune sortie détectée dans l’horizon sélectionné.";
          return;
        }

        const itemsToRender = items.slice(0, PREV_TABLE_PREVIEW_LIMIT);
        if (selectedKpi === "transmissions") {
          box.innerHTML = renderPrevisionTableTransmissionItems(itemsToRender);
          box.querySelectorAll(".prev-transmission-row, .prev-transmission-open").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const tr = el.closest("tr");
              const idx = Number(tr?.getAttribute("data-index") || -1);
              const row = (window.__sbPrevTransmissionRows || [])[idx];
              if (row) openAnalysePrevisionTransmissionModal(row);
            });
          });
        } else {
          const potential = selectedKpi === "sorties-potentielles";
          box.innerHTML = renderPrevisionTableTransitionEvents(itemsToRender, potential ? "potential" : "confirmed");
          box.querySelectorAll(".prev-transition-row, .prev-transition-open").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const tr = el.closest("tr");
              const idx = Number(tr?.getAttribute("data-index") || -1);
              const row = (window.__sbPrevTransitionRows || [])[idx];
              if (row) openAnalysePrevisionTransitionModal(row, potential ? "Alerte potentielle" : "Transition confirmée");
            });
          });
        }
      } catch (e) {
        if ((window.__sbPrevTransitionReqId || 0) !== reqId) return;
        box.textContent = `Erreur chargement prévisions: ${e?.message || e}`;
      }
    }, 0);

    return;
  }

'''

# 1) Engine
engine = read(ENGINE)
if "def _fetch_prevision_transition_events(" not in engine:
    engine = engine.rstrip() + ENGINE_BLOCK + "\n"
    write(ENGINE, engine)

# 2) Router imports + models + summary + endpoints
router = read(ROUTER)
if "_fetch_prevision_transition_events" not in router.split("router = APIRouter()", 1)[0]:
    router = replace_once(
        router,
        "    _analyse_prevision_poste_average_delta,\n)",
        "    _analyse_prevision_poste_average_delta,\n    _fetch_prevision_transition_events,\n    _fetch_prevision_transmission_items,\n    _fetch_prevision_transition_counts,\n)",
        "imports moteur prévisions transition",
    )

if "sorties_confirmees" not in router[router.find("class AnalysePrevisionsHorizonItem"):router.find("class AnalysePrevisionsTile")]:
    router = replace_once(
        router,
        "class AnalysePrevisionsHorizonItem(BaseModel):\n    horizon_years: int\n    sorties: int = 0\n    comp_critiques_impactees: int = 0\n    postes_rouges: int = 0\n",
        "class AnalysePrevisionsHorizonItem(BaseModel):\n    horizon_years: int\n    sorties: int = 0\n    comp_critiques_impactees: int = 0\n    postes_rouges: int = 0\n\n    # Console de prévision RH orientée transition\n    sorties_confirmees: int = 0\n    sorties_potentielles: int = 0\n    transmissions_a_preparer: int = 0\n",
        "modèle horizon prévisions transition",
    )

if "sorties_confirmees_12m" not in router[router.find("class AnalysePrevisionsTile"):router.find("class AnalyseSummaryTiles")]:
    router = replace_once(
        router,
        "class AnalysePrevisionsTile(BaseModel):\n    sorties_12m: int = 0\n    comp_critiques_impactees: int = 0\n    postes_rouges_12m: int = 0\n\n    # Détail par horizon (1 à 5 ans) pour un slider côté UI.\n    horizons: Optional[List[AnalysePrevisionsHorizonItem]] = None\n",
        "class AnalysePrevisionsTile(BaseModel):\n    sorties_12m: int = 0\n    comp_critiques_impactees: int = 0\n    postes_rouges_12m: int = 0\n\n    # Nouveaux KPI prévisions orientés sécurisation\n    sorties_confirmees_12m: int = 0\n    sorties_potentielles_12m: int = 0\n    transmissions_a_preparer_12m: int = 0\n\n    # Détail par horizon (1 à 5 ans) pour un slider côté UI.\n    horizons: Optional[List[AnalysePrevisionsHorizonItem]] = None\n",
        "modèle tile prévisions transition",
    )

if "transition_counts_by_horizon" not in router:
    router = replace_once(
        router,
        "                comp_delta_by_horizon: Dict[int, int] = {}\n                poste_delta_by_horizon: Dict[int, int] = {}\n                for _h in range(1, HORIZON_MAX + 1):",
        "                comp_delta_by_horizon: Dict[int, int] = {}\n                poste_delta_by_horizon: Dict[int, int] = {}\n                transition_counts_by_horizon = _fetch_prevision_transition_counts(\n                    cur,\n                    id_ent,\n                    scope.id_service,\n                    CRITICITE_MIN,\n                    HORIZON_MAX,\n                )\n                for _h in range(1, HORIZON_MAX + 1):",
        "summary compteurs transition",
    )

if "sorties_confirmees=int(_transition_counts" not in router:
    router = replace_once(
        router,
        "                for row in prev_rows:\n                    _h_years = int(row.get(\"horizon_years\") or 0)\n\n                    horizons.append(\n\n                        AnalysePrevisionsHorizonItem(\n\n                            horizon_years=_h_years,\n\n                            sorties=int(row.get(\"sorties\") or 0),\n\n                            comp_critiques_impactees=int(comp_delta_by_horizon.get(_h_years, 0)),\n\n                            postes_rouges=int(poste_delta_by_horizon.get(_h_years, 0)),\n\n                        )\n\n                    )\n",
        "                for row in prev_rows:\n                    _h_years = int(row.get(\"horizon_years\") or 0)\n                    _transition_counts = transition_counts_by_horizon.get(_h_years, {})\n\n                    horizons.append(\n\n                        AnalysePrevisionsHorizonItem(\n\n                            horizon_years=_h_years,\n\n                            sorties=int(row.get(\"sorties\") or 0),\n\n                            comp_critiques_impactees=int(comp_delta_by_horizon.get(_h_years, 0)),\n\n                            postes_rouges=int(poste_delta_by_horizon.get(_h_years, 0)),\n\n                            sorties_confirmees=int(_transition_counts.get(\"sorties_confirmees\", 0)),\n\n                            sorties_potentielles=int(_transition_counts.get(\"sorties_potentielles\", 0)),\n\n                            transmissions_a_preparer=int(_transition_counts.get(\"transmissions_a_preparer\", 0)),\n\n                        )\n\n                    )\n",
        "horizon items transition",
    )

if "sorties_confirmees_12m=(h1.sorties_confirmees" not in router:
    router = replace_once(
        router,
        "                    postes_rouges_12m=(h1.postes_rouges if h1 else 0),\n\n                    horizons=horizons,",
        "                    postes_rouges_12m=(h1.postes_rouges if h1 else 0),\n\n                    sorties_confirmees_12m=(h1.sorties_confirmees if h1 else 0),\n\n                    sorties_potentielles_12m=(h1.sorties_potentielles if h1 else 0),\n\n                    transmissions_a_preparer_12m=(h1.transmissions_a_preparer if h1 else 0),\n\n                    horizons=horizons,",
        "tile prévisions transition",
    )

if "def get_analyse_previsions_sorties_confirmees_detail" not in router:
    insert_before = "def _analyse_previsions_detail_pdf_table"
    idx = router.find(insert_before)
    if idx < 0:
        raise RuntimeError("Point d'insertion endpoints transition introuvable")
    router = router[:idx] + ROUTER_ENDPOINTS_BLOCK + "\n" + router[idx:]

write(ROUTER, router)

# 3) HTML tile
html = read(HTML)
if "data-prev-kpi=\"sorties-confirmees\"" not in html:
    start_marker = "      <!-- Tuile Prévisions -->\n"
    end_marker = "    </div>\n  </div>\n</div>\n\n<!-- Détail (pleine largeur) -->"
    start = html.find(start_marker)
    if start < 0:
        raise RuntimeError("Tuile Prévisions introuvable")
    end = html.find(end_marker, start)
    if end < 0:
        raise RuntimeError("Fin de la zone des tuiles introuvable")
    html = html[:start] + NEW_TILE_HTML + html[end:]
    write(HTML, html)

# 4) JS functions and render block
js = read(JS)

if "function analysePrevisionValidKpi" not in js:
    marker = "  function renderPrevisionTablePostes(rows) {"
    idx = js.find(marker)
    if idx < 0:
        raise RuntimeError("Point d'insertion helpers JS prévisions introuvable")
    js = js[:idx] + JS_PREVISION_FUNCTIONS + "\n" + js[idx:]

# setPrevHorizonLabel update
old = '''  function setPrevHorizonLabel(n) {
    const el = byId("prevHorizonLabel");
    if (!el) return;
    el.textContent = analyseHorizonLabel(n);
  }
'''
new = '''  function setPrevHorizonLabel(n) {
    const label = analyseHorizonLabel(n);
    const el = byId("prevHorizonLabel");
    if (el) el.textContent = label;
    const title = byId("prevTileTitle");
    if (title) title.textContent = `Prévisions à ${label}`;
  }
'''
if old in js:
    js = js.replace(old, new, 1)

# KPI application
old = '''  function applyPrevisionsKpis(previsions) {
    const p = previsions || {};
    _prevData = p;

    const horizon = getPrevHorizon();
    setPrevHorizonLabel(horizon);

    const item = pickPrevHorizonItem(p, horizon);

    if (item) {
      setText("kpiPrevSorties12", item.sorties);
      setText("kpiPrevCompImpact", formatPrevisionImpactPercent(item.comp_critiques_impactees));
      setText("kpiPrevPostesRed", formatPrevisionImpactPercent(item.postes_rouges));
      updateAnalyseProjectionSummary(p);
      if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
      return;
    }

    // Fallback: comportement historique (12 mois)
    setText("kpiPrevSorties12", p.sorties_12m);
    setText("kpiPrevCompImpact", formatPrevisionImpactPercent(p.comp_critiques_impactees));
    setText("kpiPrevPostesRed", formatPrevisionImpactPercent(p.postes_rouges_12m));
    updateAnalyseProjectionSummary(p);
    if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
  }
'''
new = '''  function applyPrevisionsKpis(previsions) {
    const p = previsions || {};
    _prevData = p;

    const horizon = getPrevHorizon();
    setPrevHorizonLabel(horizon);

    const item = pickPrevHorizonItem(p, horizon);

    if (item) {
      setText("kpiPrevSortiesConfirmees", item.sorties_confirmees ?? item.sorties ?? 0);
      setText("kpiPrevSortiesPotentielles", item.sorties_potentielles ?? 0);
      setText("kpiPrevTransmissions", item.transmissions_a_preparer ?? 0);
      updateAnalyseProjectionSummary(p);
      if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
      return;
    }

    setText("kpiPrevSortiesConfirmees", p.sorties_confirmees_12m ?? p.sorties_12m ?? 0);
    setText("kpiPrevSortiesPotentielles", p.sorties_potentielles_12m ?? 0);
    setText("kpiPrevTransmissions", p.transmissions_a_preparer_12m ?? 0);
    updateAnalyseProjectionSummary(p);
    if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
  }
'''
if old in js:
    js = js.replace(old, new, 1)

# Disable print dependency for new keys, keep no print rather than broken PDF.
old = '''  function isPrintablePrevisionDetail(kpiKey) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    return k === "sorties" || k === "critiques" || k === "postes-rouges";
  }
'''
new = '''  function isPrintablePrevisionDetail(kpiKey) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    return k === "sorties" || k === "critiques" || k === "postes-rouges";
  }
'''
# unchanged intentionally: new prévisions tables are not printed until the PDF endpoint is adapted.

# Render block replacement
if "Départs à absorber et transmissions à préparer." not in js:
    start_marker = "  // -----------------------\n  // PREVISIONS\n  // -----------------------\n  if (mode === \"previsions\") {"
    end_marker = "  const rf = getRiskFilter(); // \"\", \"postes-scope\", \"critiques-fragiles\", \"evol-3m\""
    js = replace_between(js, start_marker, end_marker, NEW_PREVISIONS_RENDER_BLOCK, "renderDetail prévisions transition")

# Make click default valid key if old localStorage is present.
if "const key = analysePrevisionValidKpi((el?.getAttribute(\"data-prev-kpi\")" not in js:
    js = js.replace(
        "      const key = (el?.getAttribute(\"data-prev-kpi\") || \"\").trim();\n      if (!key) return;",
        "      const key = analysePrevisionValidKpi((el?.getAttribute(\"data-prev-kpi\") || \"\").trim());\n      if (!key) return;",
        1,
    )

write(JS, js)

print("Patch applicateur terminé.")
print("Fichiers modifiés :")
print(f"- {ENGINE.relative_to(ROOT)}")
print(f"- {ROUTER.relative_to(ROOT)}")
print(f"- {HTML.relative_to(ROOT)}")
print(f"- {JS.relative_to(ROOT)}")
print("Contrôles conseillés :")
print("python -m py_compile unified_api/app/services/skills_analyse_engine.py")
print("python -m py_compile unified_api/app/routers/skills_portal_analyse.py")
