from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from collections import defaultdict
from datetime import datetime, date, timedelta
import json
import re

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
)

from app.services.skills_analyse_engine import (
    CRITICITE_MIN_DEFAULT,
    CRITICITE_MIN_MAX,
    CRITICITE_MIN_MIN,
    NON_LIE_ID,
    ServiceScope,
    _analyse_add_months,
    _analyse_month_bounds_from_today,
    _analyse_date_fr_value,
    _analyse_projection_period,
    _build_scope_cte,
    _safe_float,
    _clamp_int,
    _safe_int,
    _calc_fragility_score,
    _score_seuil_for_niveau,
    _niveau_from_score,
    _score_structure_gap,
    _score_transmission,
    _score_efficacite_unit,
    _score_dependance_unit,
    _build_competence_causes_from_counts,
    _normalize_poste_statut,
    _is_poste_statut_excluded,
    _niveau_rank,
    _matching_state_for_score,
    _fetch_service_label,
    _compute_poste_fragility_record,
    _fetch_postes_fragility_records,
    _fetch_postes_fragility_records_projected,
    _fetch_competence_fragility_records,
    _fetch_competence_fragility_records_projected,
    _competence_state_label,
    _competence_action_label,
    _competence_state_risk,
    _competence_priorite_from_score,
    _competence_state_label_from_score,
    _competence_event_label,
    _competence_person_label,
    _bucket_porteurs,
    _type_risque_from_bucket,
    _reco_from_type,
    _analyse_fragility_records_analyzed,
    _analyse_fragility_average,
    _analyse_fragility_average_float,
    _analyse_prevision_delta_between_record_sets,
    _analyse_prevision_competence_global_delta,
    _analyse_prevision_poste_global_delta,
    _analyse_prevision_comp_fragility_index,
    _fetch_prevision_competence_impacts,
    _analyse_prevision_competence_average_delta,
    _fetch_prevision_poste_leaving_rows,
    _fetch_prevision_poste_impact_causes,
    _analyse_prevision_poste_causes_from_record,
    _fetch_prevision_poste_impacts,
    _analyse_prevision_poste_average_delta,
    _fetch_prevision_transition_events,
    _fetch_prevision_transmission_items,
    _fetch_prevision_transition_counts,
)


router = APIRouter()










# ======================================================
# Criticité (score 0–100)
# ======================================================


# ======================================================
# Models
# ======================================================


class AnalyseRisquesTile(BaseModel):
    postes_fragiles: int = 0
    postes_fragilite_globale: int = 0
    postes_analyses: int = 0
    competences_analysees: int = 0

    # Legacy (toujours renvoyé pour compat)
    comp_critiques_sans_porteur: int = 0
    comp_bus_factor_1: int = 0

    # KPI 2 (nouveau): compétences critiques "fragiles" (bus factor ≤ 1) en nominal (sans breaks)
    comp_critiques_fragiles: int = 0

    # KPI utilisateur: moyenne de fragilité des compétences critiques du périmètre
    comp_fragilite_moyenne: int = 0

    # Alerte "aujourd'hui": nb de compétences qui tombent à 0 porteur dispo à cause d'indispos en cours
    comp_critiques_tombent_zero_auj: int = 0



class AnalyseMatchingTile(BaseModel):
    postes_sans_candidat: int = 0
    candidats_prets: int = 0
    candidats_prets_6m: int = 0


class AnalysePrevisionsHorizonItem(BaseModel):
    horizon_years: int
    sorties: int = 0
    comp_critiques_impactees: int = 0
    postes_rouges: int = 0

    # Console de prévision RH orientée transition
    sorties_confirmees: int = 0
    sorties_potentielles: int = 0
    transmissions_a_preparer: int = 0


class AnalysePrevisionsTile(BaseModel):
    sorties_12m: int = 0
    comp_critiques_impactees: int = 0
    postes_rouges_12m: int = 0

    # Nouveaux KPI prévisions orientés sécurisation
    sorties_confirmees_12m: int = 0
    sorties_potentielles_12m: int = 0
    transmissions_a_preparer_12m: int = 0

    # Détail par horizon (1 à 5 ans) pour un slider côté UI.
    horizons: Optional[List[AnalysePrevisionsHorizonItem]] = None




class AnalyseSummaryTiles(BaseModel):
    risques: AnalyseRisquesTile
    matching: AnalyseMatchingTile
    previsions: AnalysePrevisionsTile


class AnalyseSummaryResponse(BaseModel):
    scope: ServiceScope
    updated_at: str
    tiles: AnalyseSummaryTiles


# ======================================================
# Helpers
# ======================================================
def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)



# ======================================================
# Matching helpers (/24 -> A/B/C/D + scoring)
# ======================================================




















































































# ======================================================
# Endpoint: Summary (tuiles)
# ======================================================
@router.get(
    "/skills/analyse/summary/{id_contact}",
    response_model=AnalyseSummaryResponse,
)
def get_analyse_summary(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    """
    V1: summary des tuiles (Risques / Matching / Prévisions).
    - Sert à afficher des KPI "macro" dans l’écran Analyse des compétences.
    - On garde le contrat stable; les calculs viendront ensuite.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                CRITICITE_MIN = int(criticite_min)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                postes_fragiles_records = _fetch_postes_fragility_records(
                    cur,
                    id_ent,
                    scope.id_service,
                    CRITICITE_MIN,
                )
                postes_analyses_records = _analyse_fragility_records_analyzed(postes_fragiles_records)
                postes_fragiles = len([r for r in postes_analyses_records if r.get("is_fragile")])
                postes_fragilite_globale = _analyse_fragility_average(postes_fragiles_records)

                sql_risques = f"""
                WITH
                {cte_sql},
                req AS (
                    SELECT DISTINCT
                        fpc.id_poste,
                        c.id_comp,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE
                        c.etat = 'active'
                        AND COALESCE(c.masque, FALSE) = FALSE
                        AND COALESCE(fpc.masque, FALSE) = FALSE
                ),
                effectifs_dispo AS (
                    -- "Aujourd'hui": on enlève les effectifs en indisponibilité en cours
                    SELECT es.id_effectif
                    FROM effectifs_scope es
                    JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_break b
                        WHERE b.id_effectif = e.id_effectif
                          AND b.archive = FALSE
                          AND b.date_debut <= CURRENT_DATE
                          AND b.date_fin >= CURRENT_DATE
                      )
                ),
                porteurs AS (
                    -- Nominal (structurel) : uniquement les porteurs évalués.
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = ec.id_dernier_audit
                     AND a.id_effectif_competence = ec.id_effectif_competence
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.id_comp, '') <> ''
                      AND a.resultat_eval IS NOT NULL
                      AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL)
                    GROUP BY ec.id_comp
                ),
                porteurs_dispo AS (
                    -- Aujourd'hui: porteurs dispo (exclusion des breaks en cours)
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_dispo ed ON ed.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.id_comp, '') <> ''
                    GROUP BY ec.id_comp
                ),
                titulaires AS (
                    SELECT
                        e.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.id_poste_actuel, '') <> ''
                    GROUP BY e.id_poste_actuel
                ),
                poste_agg AS (
                    SELECT
                        ps.id_poste,
                        SUM(CASE
                              WHEN r.id_comp IS NOT NULL
                               AND r.poids_criticite >= %s
                               AND COALESCE(p.nb_porteurs, 0) <= 1
                              THEN 1 ELSE 0
                            END)::int AS nb_critiques_fragiles,
                        COALESCE(t.nb_titulaires, 0)::int AS nb_titulaires
                    FROM postes_scope ps
                    LEFT JOIN req r ON r.id_poste = ps.id_poste
                    LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                    LEFT JOIN titulaires t ON t.id_poste = ps.id_poste
                    GROUP BY ps.id_poste, COALESCE(t.nb_titulaires, 0)
                )
                SELECT
                    (SELECT COUNT(DISTINCT CASE
                        WHEN (pa.nb_critiques_fragiles > 0 OR pa.nb_titulaires = 0) THEN pa.id_poste
                        ELSE NULL
                    END)
                    FROM poste_agg pa)::int AS postes_fragiles,

                    -- Legacy (on garde)
                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 0 THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_critiques_sans_porteur,

                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 1 THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_porteur_unique,

                    -- KPI 2 (nouveau): <= 1 porteur en nominal
                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) <= 1 THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_critiques_fragiles,

                    -- Alerte: tombent à 0 aujourd'hui (breaks en cours)
                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s
                         AND COALESCE(p.nb_porteurs, 0) > 0
                         AND COALESCE(pd.nb_porteurs, 0) = 0
                        THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_critiques_tombent_zero_auj

                FROM req r
                LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                LEFT JOIN porteurs_dispo pd ON pd.id_comp = r.id_comp
                """



                cur.execute(sql_risques, tuple(cte_params + [CRITICITE_MIN, CRITICITE_MIN, CRITICITE_MIN, CRITICITE_MIN, CRITICITE_MIN]))
                rk = cur.fetchone() or {}

                # Les KPI compétences doivent raconter la même chose que la table "Compétences critiques".
                # Source unique: _fetch_competence_fragility_records().
                comp_records_raw = _fetch_competence_fragility_records(
                    cur,
                    id_ent,
                    scope.id_service,
                    CRITICITE_MIN,
                    comp_id=None,
                    limit=100000,
                )
                comp_records = _analyse_fragility_records_analyzed(comp_records_raw)
                comp_records_fragiles = [r for r in comp_records if int(r.get("indice_fragilite") or 0) > 0]
                comp_critiques_sans_porteur = len([r for r in comp_records if int(r.get("nb_postes_couverture_absente") or 0) > 0])
                comp_porteur_unique = len([r for r in comp_records if int(r.get("nb_postes_dependance") or 0) > 0])
                comp_critiques_fragiles = len(comp_records_fragiles)
                # La carte "Fragilité moyenne des compétences" doit raconter la même chose
                # que le tableau "Fragilités par compétence" affiché à l'utilisateur :
                # on moyenne donc les compétences réellement fragiles visibles dans ce détail,
                # et non les compétences analysées à 0 % qui ne sont pas affichées dans cette table.
                comp_fragilite_moyenne = _analyse_fragility_average(comp_records_fragiles)
                comp_critiques_tombent_zero_auj = int(rk.get("comp_critiques_tombent_zero_auj") or 0)

                # ---------------------------

                # Prévisions (horizons 1..5 ans)

                # Règles:

                # - Référence sortie = date_sortie_prevue si renseignée, sinon retraite_estimee

                #   (année) + jour/mois de date_entree_entreprise_effectif.

                # - Exclusions: sortis, temporaires, archivés.

                # - Critique = poids_criticite >= CRITICITE_MIN

                # - Poste rouge = couverture pondérée < 45% (on compte uniquement ceux qui passent en rouge).

                # ---------------------------

                COVERAGE_RED = 45

                HORIZON_MAX = 5


                sql_prev = f"""

                WITH

                {cte_sql},

                horizons AS (

                    SELECT generate_series(1, %s)::int AS y

                ),

                effectifs_valid AS (

                    SELECT

                        e.id_effectif,

                        e.date_sortie_prevue,

                        COALESCE(e.havedatefin, FALSE) AS havedatefin,

                        e.retraite_estimee::int AS retraite_annee,

                        COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,

                        COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree

                    FROM public.tbl_effectif_client e

                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif

                    WHERE COALESCE(e.archive, FALSE) = FALSE

                      AND COALESCE(e.is_temp, FALSE) = FALSE

                      AND COALESCE(e.statut_actif, TRUE) = TRUE

                ),

                effectifs_exit AS (

                    SELECT

                        ev.id_effectif,

                        CASE

                            WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue

                            WHEN ev.retraite_annee IS NOT NULL THEN

                                (

                                    make_date(ev.retraite_annee, ev.m_entree, 1)

                                    + (

                                        (

                                            LEAST(

                                                ev.d_entree,

                                                EXTRACT(

                                                    DAY

                                                    FROM (date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1)) + interval '1 month - 1 day')

                                                )::int

                                            ) - 1

                                        )::text || ' days'

                                    )::interval

                                )::date

                            ELSE NULL

                        END AS exit_date

                    FROM effectifs_valid ev

                ),

                leaving AS (

                    SELECT h.y, ee.id_effectif

                    FROM horizons h

                    JOIN effectifs_exit ee ON ee.exit_date IS NOT NULL

                    WHERE ee.exit_date >= CURRENT_DATE

                      AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + h.y::int, 12, 31)::date

                ),

                sorties AS (

                    SELECT y, COUNT(DISTINCT id_effectif)::int AS sorties

                    FROM leaving

                    GROUP BY y

                ),

                req_all AS (

                    SELECT DISTINCT

                        fpc.id_poste,

                        c.id_comp,

                        COALESCE(fpc.poids_criticite, 0)::int AS poids_crit,

                        GREATEST(COALESCE(fpc.poids_criticite, 0)::int, 1) AS poids_calc

                    FROM public.tbl_fiche_poste_competence fpc

                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste

                    JOIN public.tbl_competence c

                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)

                    WHERE c.etat = 'active'

                      AND COALESCE(c.masque, FALSE) = FALSE

                      AND COALESCE(fpc.masque, FALSE) = FALSE

                ),

                req_crit AS (

                    SELECT DISTINCT id_poste, id_comp, poids_crit, poids_calc

                    FROM req_all

                    WHERE poids_crit >= %s

                ),

                comps_all AS (

                    -- Même périmètre que le slider de criticité : les postes impactés
                    -- sont calculés sur les compétences prises en compte.
                    SELECT DISTINCT id_comp FROM req_crit

                ),

                comps_crit AS (

                    SELECT DISTINCT id_comp FROM req_crit

                ),

                porteurs_now AS (

                    SELECT ec.id_comp, COUNT(DISTINCT ec.id_effectif_client)::int AS nb_now

                    FROM public.tbl_effectif_client_competence ec

                    JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client

                    WHERE COALESCE(ec.actif, TRUE) = TRUE

                      AND COALESCE(ec.archive, FALSE) = FALSE

                    GROUP BY ec.id_comp

                ),

                leave_comp AS (

                    SELECT l.y, ec.id_comp, COUNT(DISTINCT ec.id_effectif_client)::int AS nb_leave

                    FROM leaving l

                    JOIN public.tbl_effectif_client_competence ec

                      ON ec.id_effectif_client = l.id_effectif

                    WHERE COALESCE(ec.actif, TRUE) = TRUE

                      AND COALESCE(ec.archive, FALSE) = FALSE

                    GROUP BY l.y, ec.id_comp

                ),

                comp_future_all AS (

                    SELECT h.y, ca.id_comp,

                           COALESCE(pn.nb_now, 0) AS nb_now,

                           GREATEST(COALESCE(pn.nb_now, 0) - COALESCE(lc.nb_leave, 0), 0) AS nb_future

                    FROM horizons h

                    CROSS JOIN comps_all ca

                    LEFT JOIN porteurs_now pn ON pn.id_comp = ca.id_comp

                    LEFT JOIN leave_comp lc ON lc.y = h.y AND lc.id_comp = ca.id_comp

                ),

                comp_future_crit AS (

                    SELECT h.y, cc.id_comp,

                           COALESCE(pn.nb_now, 0) AS nb_now,

                           GREATEST(COALESCE(pn.nb_now, 0) - COALESCE(lc.nb_leave, 0), 0) AS nb_future

                    FROM horizons h

                    CROSS JOIN comps_crit cc

                    LEFT JOIN porteurs_now pn ON pn.id_comp = cc.id_comp

                    LEFT JOIN leave_comp lc ON lc.y = h.y AND lc.id_comp = cc.id_comp

                ),

                comp_impact AS (

                    SELECT y, COUNT(*)::int AS comp_impact

                    FROM (

                        SELECT y, id_comp

                        FROM comp_future_crit

                        WHERE nb_now > 0 AND nb_future = 0

                        GROUP BY y, id_comp

                    ) t

                    GROUP BY y

                ),

                poste_cov AS (

                    SELECT h.y, r.id_poste,

                           SUM(r.poids_calc)::numeric AS poids_total,

                           SUM(CASE WHEN cf.nb_now > 0 THEN r.poids_calc ELSE 0 END)::numeric AS poids_couverts_now,

                           SUM(CASE WHEN cf.nb_future > 0 THEN r.poids_calc ELSE 0 END)::numeric AS poids_couverts_future

                    FROM horizons h

                    JOIN req_crit r ON TRUE

                    JOIN comp_future_all cf ON cf.y = h.y AND cf.id_comp = r.id_comp

                    GROUP BY h.y, r.id_poste

                ),

                poste_red AS (

                    SELECT y, COUNT(*)::int AS postes_rouges

                    FROM (

                        SELECT

                            y,

                            id_poste,

                            CASE WHEN poids_total > 0 THEN (100.0 * poids_couverts_now / poids_total) ELSE 0 END AS cov_now,

                            CASE WHEN poids_total > 0 THEN (100.0 * poids_couverts_future / poids_total) ELSE 0 END AS cov_future

                        FROM poste_cov

                    ) x

                    WHERE x.cov_future < x.cov_now

                    GROUP BY y

                )

                SELECT

                    h.y AS horizon_years,

                    COALESCE(s.sorties, 0) AS sorties,

                    COALESCE(ci.comp_impact, 0) AS comp_critiques_impactees,

                    COALESCE(pr.postes_rouges, 0) AS postes_rouges

                FROM horizons h

                LEFT JOIN sorties s ON s.y = h.y

                LEFT JOIN comp_impact ci ON ci.y = h.y

                LEFT JOIN poste_red pr ON pr.y = h.y

                ORDER BY h.y

                """


                cur.execute(sql_prev, tuple(cte_params + [HORIZON_MAX, CRITICITE_MIN]))

                prev_rows = cur.fetchall() or []


                comp_delta_by_horizon: Dict[int, int] = {}
                poste_delta_by_horizon: Dict[int, int] = {}
                transition_counts_by_horizon = _fetch_prevision_transition_counts(
                    cur,
                    id_ent,
                    scope.id_service,
                    CRITICITE_MIN,
                    HORIZON_MAX,
                )
                for _h in range(1, HORIZON_MAX + 1):
                    comp_delta_by_horizon[_h] = _analyse_prevision_competence_global_delta(
                        cur,
                        id_ent,
                        scope.id_service,
                        _h,
                        CRITICITE_MIN,
                    )

                    poste_delta_by_horizon[_h] = _analyse_prevision_poste_global_delta(
                        cur,
                        id_ent,
                        scope.id_service,
                        _h,
                        CRITICITE_MIN,
                    )

                horizons = []

                for row in prev_rows:
                    _h_years = int(row.get("horizon_years") or 0)
                    _transition_counts = transition_counts_by_horizon.get(_h_years, {})

                    horizons.append(

                        AnalysePrevisionsHorizonItem(

                            horizon_years=_h_years,

                            sorties=int(row.get("sorties") or 0),

                            comp_critiques_impactees=int(comp_delta_by_horizon.get(_h_years, 0)),

                            postes_rouges=int(poste_delta_by_horizon.get(_h_years, 0)),

                            sorties_confirmees=int(_transition_counts.get("sorties_confirmees", 0)),

                            sorties_potentielles=int(_transition_counts.get("sorties_potentielles", 0)),

                            transmissions_a_preparer=int(_transition_counts.get("transmissions_a_preparer", 0)),

                        )

                    )


                h1 = next((h for h in horizons if h.horizon_years == 1), None)


                previsions_tile = AnalysePrevisionsTile(

                    sorties_12m=(h1.sorties if h1 else 0),

                    comp_critiques_impactees=(h1.comp_critiques_impactees if h1 else 0),

                    postes_rouges_12m=(h1.postes_rouges if h1 else 0),

                    sorties_confirmees_12m=(h1.sorties_confirmees if h1 else 0),

                    sorties_potentielles_12m=(h1.sorties_potentielles if h1 else 0),

                    transmissions_a_preparer_12m=(h1.transmissions_a_preparer if h1 else 0),

                    horizons=horizons,

                )


                tiles = AnalyseSummaryTiles(
                    risques=AnalyseRisquesTile(
                        postes_fragiles=postes_fragiles,
                        postes_fragilite_globale=postes_fragilite_globale,
                        postes_analyses=len(postes_analyses_records),
                        competences_analysees=len(comp_records),
                        comp_critiques_sans_porteur=comp_critiques_sans_porteur,
                        comp_bus_factor_1=comp_porteur_unique,  # UI = "Porteur unique"
                        comp_critiques_fragiles=comp_critiques_fragiles,
                        comp_fragilite_moyenne=comp_fragilite_moyenne,
                        comp_critiques_tombent_zero_auj=comp_critiques_tombent_zero_auj,
                    ),
                    matching=AnalyseMatchingTile(
                        postes_sans_candidat=0,
                        candidats_prets=0,
                        candidats_prets_6m=0,
                    ),
                    previsions=previsions_tile,
                )


                return AnalyseSummaryResponse(
                    scope=scope,
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    tiles=tiles,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Models: Détail Prévisions - Sorties
# ======================================================
class AnalysePrevisionSortieItem(BaseModel):
    id_effectif: str
    prenom_effectif: Optional[str] = None
    nom_effectif: Optional[str] = None
    full: Optional[str] = None

    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None

    exit_date: Optional[str] = None  # YYYY-MM-DD
    exit_source: Optional[str] = None  # "date_sortie_prevue" | "retraite_estimee"
    days_left: Optional[int] = None

    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None

    havedatefin: Optional[bool] = None
    motif_sortie: Optional[str] = None
    raison_sortie: Optional[str] = None


class AnalysePrevisionsSortiesDetailResponse(BaseModel):
    scope: ServiceScope
    horizon_years: int
    updated_at: str
    items: List[AnalysePrevisionSortieItem]


# ======================================================
# Endpoint: Détail Prévisions - Sorties (liste nominative)
# ======================================================

@router.get(
    "/skills/analyse/previsions/sorties/detail/{id_contact}",
    response_model=AnalysePrevisionsSortiesDetailResponse,
)
def get_analyse_previsions_sorties_detail(
    id_contact: str,
    request: Request,
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

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
                        WHERE COALESCE(e.archive, FALSE) = FALSE
                        AND COALESCE(e.is_temp, FALSE) = FALSE
                        AND COALESCE(e.statut_actif, TRUE) = TRUE
                    ),
                    effectifs_exit AS (
                        SELECT
                            ev.*,
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN
                                    (
                                        make_date(ev.retraite_annee, ev.m_entree, 1)
                                        + (
                                            (
                                                LEAST(
                                                    ev.d_entree,
                                                    EXTRACT(
                                                        DAY
                                                        FROM (
                                                            date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1))
                                                            + interval '1 month - 1 day'
                                                        )
                                                    )::int
                                                ) - 1
                                            )::text || ' days'
                                        )::interval
                                    )::date
                                ELSE NULL
                            END AS exit_date,

                            -- "Raison de la sortie" (UI)
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                                    NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                                    CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                                )
                                WHEN ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                                ELSE NULL
                            END AS raison_sortie
                        FROM effectifs_valid ev
                    )
                    SELECT
                        ee.id_effectif,
                        ee.prenom_effectif,
                        ee.nom_effectif,
                        ee.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        ee.id_poste_actuel,
                        COALESCE(p.intitule_poste, '') AS intitule_poste,
                        COALESCE(p.codif_poste, '') AS codif_poste,
                        COALESCE(p.codif_client, '') AS codif_client,
                        ee.exit_date,
                        ee.havedatefin,
                        ee.motif_sortie,
                        ee.raison_sortie,
                        (ee.exit_date - CURRENT_DATE)::int AS days_left
                    FROM effectifs_exit ee
                    LEFT JOIN public.tbl_entreprise_organigramme o
                    ON o.id_ent = %s
                    AND o.id_service = ee.id_service
                    AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                    ON p.id_poste = ee.id_poste_actuel
                    WHERE ee.exit_date IS NOT NULL
                    AND ee.exit_date >= CURRENT_DATE
                    AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
                    ORDER BY ee.exit_date ASC, ee.nom_effectif ASC, ee.prenom_effectif ASC
                    LIMIT %s
                    """

                cur.execute(sql, tuple(cte_params + [id_ent, horizon_years, limit]))
                rows = cur.fetchall() or []

                items: List[AnalysePrevisionSortieItem] = []
                for r in rows:
                    prenom = (r.get("prenom_effectif") or "").strip()
                    nom = (r.get("nom_effectif") or "").strip()
                    full = (prenom + " " + nom).strip() or "—"

                    exit_date = r.get("exit_date")
                    if hasattr(exit_date, "isoformat"):
                        exit_date = exit_date.isoformat()

                    items.append(
                        AnalysePrevisionSortieItem(
                            id_effectif=r.get("id_effectif"),
                            prenom_effectif=prenom or None,
                            nom_effectif=nom or None,
                            full=full,
                            id_service=r.get("id_service"),
                            nom_service=(r.get("nom_service") or "").strip() or "—",
                            id_poste_actuel=r.get("id_poste_actuel"),
                            intitule_poste=(r.get("intitule_poste") or "").strip() or None,
                            exit_date=exit_date,                            
                            days_left=int(r.get("days_left") or 0) if r.get("days_left") is not None else None,
                            codif_poste=(r.get("codif_poste") or "").strip() or None,
                            codif_client=(r.get("codif_client") or "").strip() or None,
                            havedatefin=bool(r.get("havedatefin")),
                            motif_sortie=(r.get("motif_sortie") or "").strip() or None,
                            raison_sortie=(r.get("raison_sortie") or "").strip() or None,
                        )
                    )

                return AnalysePrevisionsSortiesDetailResponse(
                    scope=scope,
                    horizon_years=int(horizon_years),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    items=items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Models: Prevision- critiques impactees
# ======================================================
class AnalysePrevisionCritiqueImpacteeItem(BaseModel):
    id_comp: str
    code: Optional[str] = None
    intitule: Optional[str] = None

    id_domaine_competence: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None

    nb_postes_impactes: int = 0
    max_criticite: int = 0

    # conservés (utile debug / futur)
    nb_porteurs_now: int = 0
    nb_porteurs_sortants: int = 0
    nb_porteurs_restants: int = 0
    last_exit_date: Optional[str] = None

    # NOUVEAU: projection
    indice_fragilite_horizon: int = 0          # 0..100 à horizon X ans
    delta_fragilite: int = 0                    # indice_horizon - indice_now
    priorite: Optional[str] = None              # "P1" | "P2" | "P3"
    priorite_score: int = 0                     # tri = indice_horizon


class AnalysePrevisionsCritiquesImpacteesDetailResponse(BaseModel):
    scope: ServiceScope
    horizon_years: int
    criticite_min: int
    updated_at: str
    items: List[AnalysePrevisionCritiqueImpacteeItem]






# ======================================================
# Endpoint : Prevision- critiques impactees
# ======================================================
@router.get(
    "/skills/analyse/previsions/critiques/detail/{id_contact}",
    response_model=AnalysePrevisionsCritiquesImpacteesDetailResponse,
)
def get_analyse_previsions_critiques_impactees_detail(
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
                impacts = _fetch_prevision_competence_impacts(
                    cur,
                    id_ent,
                    scope.id_service,
                    int(horizon_years),
                    int(criticite_min),
                    int(limit),
                )

                items: List[AnalysePrevisionCritiqueImpacteeItem] = []
                for r in impacts:
                    items.append(
                        AnalysePrevisionCritiqueImpacteeItem(
                            id_comp=r.get("id_comp"),
                            code=(r.get("code") or None),
                            intitule=(r.get("intitule") or None),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre_court=(r.get("domaine_titre_court") or None),
                            domaine_couleur=(r.get("domaine_couleur") or None),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                            nb_porteurs_now=int(r.get("nb_porteurs_now") or 0),
                            nb_porteurs_sortants=int(r.get("nb_porteurs_sortants") or 0),
                            nb_porteurs_restants=int(r.get("nb_porteurs_restants") or 0),
                            last_exit_date=r.get("last_exit_date"),
                            indice_fragilite_horizon=int(r.get("indice_fragilite_horizon") or 0),
                            delta_fragilite=int(r.get("delta_fragilite") or 0),
                            priorite=(r.get("priorite") or None),
                            priorite_score=int(r.get("priorite_score") or 0),
                        )
                    )

                return AnalysePrevisionsCritiquesImpacteesDetailResponse(
                    scope=scope,
                    horizon_years=int(horizon_years),
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    items=items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get("/skills/analyse/previsions/critiques/modal/{id_contact}")
def get_analyse_previsions_critiques_modal(
    id_contact: str,
    request: Request,
    comp_key: str = Query(..., min_length=1),
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=500, ge=50, le=2000),
):
    """
    Modal: 3 listes + synthèse:
    - Porteurs restants
    - Porteurs sortants (dans l'horizon)
    - Postes impactés (niveau attendu + criticité)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # Resolve comp_key => id_competence
                cur.execute(
                    """
                    SELECT id_comp, code, intitule, domaine
                    FROM public.tbl_competence
                    WHERE id_comp = %s OR code = %s
                    LIMIT 1
                    """,
                    (comp_key, comp_key),
                )
                comp = cur.fetchone()
                if not comp:
                    return {
                        "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                        "horizon_years": int(horizon_years),
                        "comp_key": comp_key,
                        "error": "Compétence introuvable (comp_key).",
                    }

                id_comp = comp["id_comp"]

                # Domaine
                domaine = None
                id_dom = (comp.get("domaine") or "").strip()

                if id_dom:
                    cur.execute(
                        """
                        SELECT titre, titre_court, couleur
                        FROM public.tbl_domaine_competence
                        WHERE id_domaine_competence = %s
                        LIMIT 1
                        """,
                        (id_dom,),
                    )
                    domaine = cur.fetchone()

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
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.is_temp, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                ),
                effectifs_exit AS (
                    SELECT
                        ev.*,
                        CASE
                            WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                            WHEN ev.retraite_annee IS NOT NULL THEN
                                (
                                    make_date(ev.retraite_annee, ev.m_entree, 1)
                                    + (
                                        (
                                            LEAST(
                                                ev.d_entree,
                                                EXTRACT(
                                                    DAY FROM (
                                                        date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1))
                                                        + interval '1 month - 1 day'
                                                    )
                                                )::int
                                            ) - 1
                                        )::text || ' days'
                                    )::interval
                                )::date
                            ELSE NULL
                        END AS exit_date,
                        CASE
                            WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                                NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                                CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                            )
                            WHEN ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                            ELSE NULL
                        END AS raison_sortie
                    FROM effectifs_valid ev
                ),
                porteurs AS (
                    SELECT
                        ec.id_comp,
                        ee.id_effectif,
                        ee.prenom_effectif,
                        ee.nom_effectif,
                        ee.id_service,
                        COALESCE(o.nom_service,'') AS nom_service,
                        ee.id_poste_actuel,
                        COALESCE(p.intitule_poste,'') AS intitule_poste,
                        ee.exit_date,
                        ee.raison_sortie,
                        COALESCE(ec.niveau_actuel,'')::text AS niveau
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_exit ee ON ee.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = ee.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = ee.id_poste_actuel
                    WHERE ec.id_comp = %s
                ),
                split AS (
                    SELECT
                        pr.*,
                        CASE
                          WHEN pr.exit_date IS NOT NULL
                           AND pr.exit_date >= CURRENT_DATE
                           AND pr.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
                          THEN TRUE ELSE FALSE
                        END AS is_sortant
                    FROM porteurs pr
                ),
                postes AS (
                    SELECT
                        fp.id_poste,
                        fp.intitule_poste,
                        COALESCE(o.nom_service,'') AS nom_service,
                        cp.poids_criticite::int AS criticite,
                        cp.niveau_requis::text AS niveau_attendu
                    FROM public.tbl_fiche_poste_competence cp
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = cp.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    WHERE fp.id_ent = %s
                      AND COALESCE(fp.actif, TRUE) = TRUE
                      AND (%s::text IS NULL OR fp.id_service = %s)
                      AND cp.id_competence = %s
                      AND COALESCE(cp.poids_criticite,0) >= %s
                )
                SELECT
                  (SELECT COUNT(DISTINCT id_effectif) FROM split) AS nb_now,
                  (SELECT COUNT(DISTINCT id_effectif) FROM split WHERE is_sortant = TRUE) AS nb_out,
                  (SELECT COUNT(DISTINCT id_effectif) FROM split WHERE is_sortant = FALSE) AS nb_remain,
                  (SELECT COUNT(*) FROM postes) AS nb_postes,
                  (SELECT MIN(exit_date) FROM split WHERE is_sortant = TRUE) AS next_exit,
                  (SELECT COUNT(*) FROM split WHERE is_sortant = FALSE AND niveau = 'A') AS remain_a,
                  (SELECT COUNT(*) FROM split WHERE is_sortant = FALSE AND niveau = 'B') AS remain_b,
                  (SELECT COUNT(*) FROM split WHERE is_sortant = FALSE AND niveau = 'C') AS remain_c
                """

                params = tuple(
                    cte_params
                    + [id_ent, id_comp, horizon_years, id_ent, id_ent, scope.id_service, scope.id_service, id_comp, criticite_min]
                )
                cur.execute(sql, params)
                k = cur.fetchone() or {}

                # Porteurs (restants + sortants) + postes impactés
                cur.execute(
                    f"""
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
                        WHERE COALESCE(e.archive, FALSE) = FALSE
                          AND COALESCE(e.is_temp, FALSE) = FALSE
                          AND COALESCE(e.statut_actif, TRUE) = TRUE
                    ),
                    effectifs_exit AS (
                        SELECT
                            ev.*,
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN
                                    (
                                        make_date(ev.retraite_annee, ev.m_entree, 1)
                                        + (
                                            (
                                                LEAST(
                                                    ev.d_entree,
                                                    EXTRACT(
                                                        DAY FROM (
                                                            date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1))
                                                            + interval '1 month - 1 day'
                                                        )
                                                    )::int
                                                ) - 1
                                            )::text || ' days'
                                        )::interval
                                    )::date
                                ELSE NULL
                            END AS exit_date,
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                                    NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                                    CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                                )
                                WHEN ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                                ELSE NULL
                            END AS raison_sortie
                        FROM effectifs_valid ev
                    ),
                    porteurs AS (
                        SELECT
                            ec.id_effectif_client,
                            ee.prenom_effectif,
                            ee.nom_effectif,
                            ee.id_service,
                            COALESCE(o.nom_service,'') AS nom_service,
                            ee.id_poste_actuel,
                            COALESCE(p.intitule_poste,'') AS intitule_poste,
                            ee.exit_date,
                            ee.raison_sortie,
                            COALESCE(ec.niveau_actuel, '')::text AS niveau
                        FROM public.tbl_effectif_client_competence ec
                        JOIN effectifs_exit ee ON ee.id_effectif = ec.id_effectif_client
                        LEFT JOIN public.tbl_entreprise_organigramme o
                          ON o.id_ent = %s
                         AND o.id_service = ee.id_service
                         AND o.archive = FALSE
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = ee.id_poste_actuel
                        WHERE ec.id_comp = %s
                    )
                    SELECT *
                    FROM porteurs
                    ORDER BY exit_date NULLS LAST, nom_effectif ASC, prenom_effectif ASC
                    LIMIT %s
                    """,
                    tuple(cte_params + [id_ent, id_comp, limit]),
                )
                porteurs_rows = cur.fetchall() or []

                def _fmt_date(d):
                    if hasattr(d, "isoformat"):
                        return d.isoformat()
                    return d

                restants = []
                sortants = []
                for r in porteurs_rows:
                    prenom = (r.get("prenom_effectif") or "").strip()
                    nom = (r.get("nom_effectif") or "").strip()
                    full = (prenom + " " + nom).strip() or "—"
                    exit_date = _fmt_date(r.get("exit_date"))
                    is_sortant = False
                    if exit_date:
                        # ISO string or date => compare in SQL already too, but keep simple
                        # We'll classify client-side in JS if needed; here: classify with SQL rule again is overkill.
                        pass

                    item = {
                        "full": full,
                        "niveau": (r.get("niveau") or "").strip() or None,
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "exit_date": exit_date,
                        "raison_sortie": (r.get("raison_sortie") or "").strip() or None,
                    }

                    # classement sortant / restant (même règle que SQL)
                    if r.get("exit_date") is not None:
                        # on a la date en objet date -> compare en python
                        from datetime import date, timedelta
                        try:
                            d0 = r.get("exit_date")
                            if isinstance(d0, date):
                                horizon_end = date(date.today().year + int(horizon_years), 12, 31)
                                if d0 >= date.today() and d0 <= horizon_end:
                                    sortants.append(item)
                                else:
                                    restants.append(item)
                            else:
                                # fallback: si pas comparable, on laisse en restants
                                restants.append(item)
                        except Exception:
                            restants.append(item)
                    else:
                        restants.append(item)

                # Postes impactés
                cur.execute(
                    """
                    SELECT
                        fp.id_poste,
                        fp.intitule_poste,
                        COALESCE(o.nom_service,'') AS nom_service,
                        cp.poids_criticite::int AS criticite,
                        cp.niveau_requis::text AS niveau_attendu
                    FROM public.tbl_fiche_poste_competence cp
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = cp.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    WHERE fp.id_ent = %s
                      AND COALESCE(fp.actif, TRUE) = TRUE
                      AND (%s::text IS NULL OR fp.id_service = %s)
                      AND cp.id_competence = %s
                      AND COALESCE(cp.poids_criticite,0) >= %s
                    ORDER BY cp.poids_criticite DESC, fp.intitule_poste ASC
                    """,
                    (id_ent, id_ent, scope.id_service, scope.id_service, id_comp, criticite_min),
                )
                postes_rows = cur.fetchall() or []

                next_exit = k.get("next_exit")
                if hasattr(next_exit, "isoformat"):
                    next_exit = next_exit.isoformat()

                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "competence": {
                        "id_competence": id_comp,
                        "code": (comp.get("code") or "").strip() or "—",
                        "intitule": (comp.get("intitule") or "").strip() or "—",
                        "domaine_titre": (domaine.get("titre") if domaine else "") or "—",
                        "domaine_titre_court": (domaine.get("titre_court") if domaine else "") or "—",
                        "domaine_couleur": (domaine.get("couleur") if domaine else None),
                    },
                    "kpis": {
                        "nb_now": int(k.get("nb_now") or 0),
                        "nb_out": int(k.get("nb_out") or 0),
                        "nb_remain": int(k.get("nb_remain") or 0),
                        "nb_postes": int(k.get("nb_postes") or 0),
                        "next_exit_date": next_exit,
                        "remain_a": int(k.get("remain_a") or 0),
                        "remain_b": int(k.get("remain_b") or 0),
                        "remain_c": int(k.get("remain_c") or 0),
                    },
                    "restants": restants,
                    "sortants": sortants,
                    "postes": postes_rows,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
    










@router.get("/skills/analyse/previsions/postes-rouges/detail/{id_contact}")
def get_analyse_previsions_postes_rouges_detail(
    id_contact: str,
    request: Request,
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=200, ge=10, le=2000),
):
    """
    Détail KPI "Évolution fragilité postes" (prévisions).
    Même moteur que Risques actuels, rejoué en excluant les sortants N+X.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                items = _fetch_prevision_poste_impacts(
                    cur,
                    id_ent,
                    scope.id_service,
                    int(horizon_years),
                    int(criticite_min),
                    limit=int(limit),
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

def _analyse_previsions_detail_pdf_table(kpi: str, items: List[Any], styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body_style = styles.get("small") or styles.get("body")
    head_style = styles.get("meta_label") or styles.get("small") or body_style

    def as_dict(item: Any) -> Dict[str, Any]:
        if hasattr(item, "model_dump"):
            return item.model_dump()
        if hasattr(item, "dict"):
            return item.dict()
        return dict(item or {})

    def p(value: Any, style=None):
        return Paragraph(_analyse_pdf_esc(value), style or body_style)

    k = (kpi or "").strip().lower()
    rows: List[List[Any]] = []
    widths: List[Any] = []

    if k == "sorties-confirmees":
        rows.append([p("Collaborateur", head_style), p("Poste", head_style), p("Date", head_style), p("Motif de départ", head_style)])
        widths = [64 * mm, 86 * mm, 30 * mm, 64 * mm]
        for item in (items or []):
            r = as_dict(item)
            poste_code = (r.get("codif_client") or r.get("codif_poste") or "").strip()
            poste = (r.get("intitule_poste") or "—").strip()
            poste_label = f"{poste_code} - {poste}" if poste_code else poste
            rows.append([
                p(r.get("full") or "—"),
                p(poste_label),
                p(_analyse_date_fr_value(r.get("exit_date"))),
                p(r.get("raison_sortie") or r.get("event_kind_label") or "Sortie prévue"),
            ])
    elif k == "sorties-potentielles":
        def _prev_year_only(value):
            raw = str(value or "").strip()
            if not raw:
                return "—"
            for i in range(0, max(0, len(raw) - 3)):
                part = raw[i:i + 4]
                if part.isdigit() and part[:2] in ("19", "20"):
                    return part
            return raw

        rows.append([p("Collaborateur", head_style), p("Poste", head_style), p("Horizon", head_style), p("Motif", head_style)])
        widths = [64 * mm, 86 * mm, 30 * mm, 64 * mm]
        for item in (items or []):
            r = as_dict(item)
            poste_code = (r.get("codif_client") or r.get("codif_poste") or "").strip()
            poste = (r.get("intitule_poste") or "—").strip()
            poste_label = f"{poste_code} - {poste}" if poste_code else poste
            rows.append([
                p(r.get("full") or "—"),
                p(poste_label),
                p(_prev_year_only(r.get("horizon_year") or r.get("annee") or r.get("exit_date") or r.get("retraite_estimee") or r.get("date_sortie_prevue") or r.get("horizon_label"))),
                p("Retraite estimée"),
            ])
    elif k == "transmissions":
        rows.append([p("Compétence", head_style), p("Échéance", head_style), p("Impact", head_style), p("Expertise", head_style)])
        widths = [106 * mm, 34 * mm, 50 * mm, 54 * mm]
        for item in (items or []):
            r = as_dict(item)
            code = (r.get("code") or "").strip()
            comp = (r.get("intitule") or "—").strip()
            comp_label = f"{code} - {comp}" if code else comp
            rows.append([
                p(comp_label),
                p(_analyse_date_fr_value(r.get("exit_date") or r.get("first_exit_date"))),
                p(r.get("impact_label") or "—"),
                p(r.get("expertise_label") or "—"),
            ])
    elif k == "sorties":
        rows.append([p("Collaborateur", head_style), p("Date", head_style), p("Poste", head_style), p("Service", head_style), p("Raison", head_style)])
        widths = [54 * mm, 24 * mm, 72 * mm, 42 * mm, 52 * mm]
        for item in (items or []):
            r = as_dict(item)
            poste_code = (r.get("codif_client") or r.get("codif_poste") or "").strip()
            poste = (r.get("intitule_poste") or "—").strip()
            poste_label = f"{poste_code} - {poste}" if poste_code else poste
            rows.append([
                p(r.get("full") or "—"),
                p(_analyse_date_fr_value(r.get("exit_date"))),
                p(poste_label),
                p(r.get("nom_service") or "—"),
                p(r.get("raison_sortie") or r.get("motif_sortie") or "—"),
            ])
    elif k == "critiques":
        rows.append([p("Code", head_style), p("Compétence", head_style), p("Domaine", head_style), p("Hausse", head_style), p("Porteurs perdus", head_style), p("Restants", head_style), p("Postes", head_style), p("Prochaine sortie", head_style)])
        widths = [20 * mm, 70 * mm, 34 * mm, 22 * mm, 28 * mm, 24 * mm, 20 * mm, 28 * mm]
        for item in (items or []):
            r = as_dict(item)
            delta = _analyse_pdf_safe_int(r.get("delta_fragilite"))
            rows.append([
                p(r.get("code") or "—"),
                p(r.get("intitule") or "—"),
                p(r.get("domaine_titre_court") or r.get("domaine_titre") or "—"),
                p(f"+{delta}%" if delta > 0 else f"{delta}%"),
                p(r.get("nb_porteurs_sortants") or 0),
                p(r.get("nb_porteurs_restants") or 0),
                p(r.get("nb_postes_impactes") or 0),
                p(_analyse_date_fr_value(r.get("last_exit_date"))),
            ])
    else:
        rows.append([p("Code", head_style), p("Poste", head_style), p("Service", head_style), p("Hausse", head_style), p("Titulaires N+X", head_style), p("Sortants", head_style), p("Causes", head_style)])
        widths = [22 * mm, 62 * mm, 36 * mm, 22 * mm, 26 * mm, 48 * mm, 58 * mm]
        for item in (items or []):
            r = as_dict(item)
            delta = _analyse_pdf_safe_int(r.get("delta_fragilite"))
            code = (r.get("codif_client") or r.get("codif_poste") or "—")
            remain = _analyse_pdf_safe_int(r.get("nb_titulaires_horizon") or r.get("nb_titulaires"))
            cible = _analyse_pdf_safe_int(r.get("nb_titulaires_cible") or 1)
            causes = r.get("causes_risques_actuels") or []
            cause_txt = "\n".join([(c.get("titre") or "Cause") for c in causes[:3] if isinstance(c, dict)]) or "—"
            rows.append([
                p(code),
                p(r.get("intitule_poste") or "—"),
                p(r.get("nom_service") or "—"),
                p(f"+{delta}%" if delta > 0 else f"{delta}%"),
                p(f"{remain}/{cible}"),
                p(r.get("sortants_label") or "—"),
                p(cause_txt),
            ])

    if len(rows) == 1:
        rows.append([p("Aucun résultat.")] + [p("") for _ in range(max(0, len(rows[0]) - 1))])

    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


@router.get("/skills/analyse/previsions/detail/pdf/{id_contact}")
def get_analyse_previsions_detail_pdf(
    id_contact: str,
    request: Request,
    kpi: str = Query(...),
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=10, ge=1, le=2000),
):
    try:
        from fastapi import Response
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.platypus import Paragraph
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        k = (kpi or "").strip().lower()
        if k not in ("sorties-confirmees", "sorties-potentielles", "transmissions", "sorties", "critiques", "postes-rouges"):
            raise HTTPException(status_code=400, detail="Table prévisionnelle non imprimable.")

        if k == "sorties-confirmees":
            detail = get_analyse_previsions_sorties_confirmees_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                criticite_min=criticite_min,
                limit=limit,
            )
            items = detail.get("items") or [] if isinstance(detail, dict) else []
            table_title = "Sorties confirmées"
            filename = "previsions_sorties_confirmees.pdf"
        elif k == "sorties-potentielles":
            detail = get_analyse_previsions_sorties_potentielles_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                criticite_min=criticite_min,
                limit=limit,
            )
            items = detail.get("items") or [] if isinstance(detail, dict) else []
            table_title = "Sorties potentielles"
            filename = "previsions_sorties_potentielles.pdf"
        elif k == "transmissions":
            detail = get_analyse_previsions_transmissions_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                criticite_min=criticite_min,
                limit=limit,
            )
            items = detail.get("items") or [] if isinstance(detail, dict) else []
            table_title = "Transmissions à préparer"
            filename = "previsions_transmissions.pdf"
        elif k == "sorties":
            detail = get_analyse_previsions_sorties_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                limit=limit,
            )
            items = detail.items or []
            table_title = "Effectifs sortants"
            filename = "previsions_sorties.pdf"
        elif k == "critiques":
            detail = get_analyse_previsions_critiques_impactees_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                criticite_min=criticite_min,
                limit=limit,
            )
            items = detail.items or []
            table_title = "Évolution fragilité compétences"
            filename = "previsions_competences.pdf"
        else:
            detail = get_analyse_previsions_postes_rouges_detail(
                id_contact=id_contact,
                request=request,
                horizon_years=horizon_years,
                id_service=id_service,
                criticite_min=criticite_min,
                limit=limit,
            )
            items = detail.get("items") or [] if isinstance(detail, dict) else []
            table_title = "Évolution fragilité postes"
            filename = "previsions_postes.pdf"

        scope_obj = detail.get("scope") if isinstance(detail, dict) else getattr(detail, "scope", None)
        if isinstance(scope_obj, dict):
            scope_name = scope_obj.get("nom_service") or "Tous les services"
        else:
            scope_name = getattr(scope_obj, "nom_service", None) or "Tous les services"

        company_name = ""
        logo_bytes = None
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        styles = build_pdf_styles()
        today = datetime.now().strftime("%d/%m/%Y")
        horizon_label = f"N+{int(horizon_years)}"

        story = []
        story.append(Paragraph(f"Impact prévisionnel sur {horizon_label} • {table_title}", styles["title"]))
        story.append(Paragraph(f"Périmètre analysé : {scope_name} • Date : {today} • Lignes : {len(items or [])}", styles["subtitle"]))
        story.append(make_spacer(3))
        story.append(_analyse_previsions_detail_pdf_table(k, items or [], styles))

        pdf = build_pdf_document(story, {
            "title": f"Prévisions - {table_title}",
            "footer_left": "Novoskill Insights • Prévisions",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))

        return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{filename}"'})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF prévisions : {e}")

@router.get("/skills/analyse/previsions/postes-rouges/modal/{id_contact}")
def get_analyse_previsions_postes_rouges_modal(
    id_contact: str,
    request: Request,
    id_poste: str = Query(..., min_length=1),
    horizon_years: int = Query(default=1, ge=1, le=5),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit_sortants: int = Query(default=500, ge=50, le=2000),
    limit_couverture: int = Query(default=800, ge=50, le=5000),
    limit_voisins: int = Query(default=20, ge=5, le=200),
):
    """
    Détail RH d'un poste impacté par les prévisions.
    La route renvoie une lecture poste -> compétences -> porteurs sortants/restants,
    sans exposer de SQL technique côté utilisateur.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                id_poste = (id_poste or "").strip()
                if not id_poste:
                    raise HTTPException(status_code=400, detail="id_poste manquant.")

                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                cur.execute(
                    """
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service,'') AS nom_service,
                        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
                        COALESCE(prh.statut_poste, 'actif')::text AS statut_poste
                    FROM public.tbl_fiche_poste fp
                    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = fp.id_ent
                     AND o.id_service = fp.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    WHERE fp.id_ent = %s
                      AND fp.id_poste = %s
                      AND COALESCE(fp.actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (id_ent, id_poste),
                )
                poste_row = cur.fetchone()
                if not poste_row:
                    return {
                        "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                        "horizon_years": int(horizon_years),
                        "criticite_min": int(criticite_min),
                        "poste": {"id_poste": id_poste, "intitule_poste": "—", "nom_service": "—"},
                        "kpis": {},
                        "causes": [],
                        "sortants": [],
                        "couverture": [],
                        "voisins": [],
                    }

                base_cte = f"""
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
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.is_temp, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                ),
                effectifs_h AS (
                    SELECT
                        ev.*,
                        CASE
                            WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                            WHEN ev.retraite_annee IS NOT NULL THEN
                                (
                                    make_date(ev.retraite_annee, ev.m_entree, 1)
                                    + (
                                        (
                                            LEAST(
                                                ev.d_entree,
                                                EXTRACT(
                                                    DAY FROM (
                                                        date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1))
                                                        + interval '1 month - 1 day'
                                                    )
                                                )::int
                                            ) - 1
                                        )::text || ' days'
                                    )::interval
                                )::date
                            ELSE NULL
                        END AS exit_date,
                        CASE
                            WHEN ev.date_sortie_prevue IS NOT NULL THEN COALESCE(
                                NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''),
                                CASE WHEN COALESCE(ev.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END
                            )
                            WHEN ev.retraite_annee IS NOT NULL THEN 'Retraite estimée'
                            ELSE NULL
                        END AS raison_sortie,
                        CASE
                          WHEN (
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) IS NOT NULL
                          AND (
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) >= CURRENT_DATE
                          AND (
                            CASE
                                WHEN ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
                          THEN TRUE ELSE FALSE
                        END AS is_sortant
                    FROM effectifs_valid ev
                ),
                req AS (
                    SELECT
                        cp.id_competence AS id_comp,
                        COALESCE(cp.poids_criticite, 0)::int AS criticite,
                        COALESCE(cp.niveau_requis, '')::text AS niveau_requis,
                        CASE
                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'A' THEN 1
                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'B' THEN 2
                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'D' THEN 4
                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'C' THEN 3
                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'D' THEN 4
                            ELSE 0
                        END AS req_rank
                    FROM public.tbl_fiche_poste_competence cp
                    WHERE cp.id_poste = %s
                      AND COALESCE(cp.masque, FALSE) = FALSE
                      AND COALESCE(cp.poids_criticite, 0)::int >= %s
                ),
                carriers AS (
                    SELECT
                        r.id_comp,
                        r.criticite,
                        r.niveau_requis,
                        r.req_rank,
                        eh.id_effectif,
                        eh.prenom_effectif,
                        eh.nom_effectif,
                        eh.id_service,
                        eh.id_poste_actuel,
                        eh.exit_date,
                        eh.raison_sortie,
                        eh.is_sortant,
                        COALESCE(ec.niveau_actuel, '')::text AS niveau_actuel,
                        CASE
                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'A' THEN 1
                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'B' THEN 2
                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'D' THEN 4
                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'C' THEN 3
                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'D' THEN 4
                            WHEN ec.niveau_actuel ILIKE '%%init%%' OR ec.niveau_actuel ILIKE '%%début%%' OR ec.niveau_actuel ILIKE '%%debut%%' THEN 1
                            WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2
                            WHEN ec.niveau_actuel ILIKE '%%avan%%' THEN 3
                            WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                            WHEN TRIM(COALESCE(ec.niveau_actuel,'')) ~ '^[0-9]+$' THEN TRIM(ec.niveau_actuel)::int
                            ELSE 0
                        END AS niveau_rank
                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                     AND COALESCE(ec.actif, TRUE) = TRUE
                     AND COALESCE(ec.archive, FALSE) = FALSE
                    LEFT JOIN effectifs_h eh ON eh.id_effectif = ec.id_effectif_client
                    WHERE ec.id_effectif_client IS NOT NULL
                ),
                carriers_ok AS (
                    SELECT *
                    FROM carriers
                    WHERE id_effectif IS NOT NULL
                      AND niveau_rank > 0
                      AND (req_rank = 0 OR niveau_rank >= req_rank)
                ),
                cov AS (
                    SELECT
                        r.id_comp,
                        r.criticite,
                        r.niveau_requis,
                        COUNT(DISTINCT c.id_effectif)::int AS nb_now,
                        COUNT(DISTINCT c.id_effectif) FILTER (WHERE COALESCE(c.is_sortant, FALSE) = FALSE)::int AS nb_remain,
                        COUNT(DISTINCT c.id_effectif) FILTER (WHERE c.id_poste_actuel = %s)::int AS nb_now_titulaires,
                        COUNT(DISTINCT c.id_effectif) FILTER (WHERE COALESCE(c.is_sortant, FALSE) = FALSE AND c.id_poste_actuel = %s)::int AS nb_remain_titulaires,
                        COUNT(DISTINCT c.id_effectif) FILTER (WHERE COALESCE(c.is_sortant, FALSE) = TRUE)::int AS nb_sortants,
                        MIN(c.exit_date) FILTER (WHERE COALESCE(c.is_sortant, FALSE) = TRUE) AS next_exit_comp
                    FROM req r
                    LEFT JOIN carriers_ok c ON c.id_comp = r.id_comp
                    GROUP BY r.id_comp, r.criticite, r.niveau_requis
                )
                """

                summary_sql = f"""
                {base_cte}
                SELECT
                    COUNT(DISTINCT eh.id_effectif) FILTER (WHERE eh.id_poste_actuel = %s)::int AS nb_titulaires_now,
                    COUNT(DISTINCT eh.id_effectif) FILTER (WHERE eh.id_poste_actuel = %s AND COALESCE(eh.is_sortant, FALSE)=FALSE)::int AS nb_titulaires_horizon,
                    COALESCE(SUM(c.criticite), 0)::numeric AS poids_total,
                    COALESCE(SUM(CASE WHEN c.nb_now > 0 THEN c.criticite ELSE 0 END), 0)::numeric AS poids_now,
                    COALESCE(SUM(CASE WHEN c.nb_remain > 0 THEN c.criticite ELSE 0 END), 0)::numeric AS poids_future,
                    SUM(CASE WHEN c.nb_now = 0 THEN 1 ELSE 0 END)::int AS now_sans_porteur,
                    SUM(CASE WHEN c.nb_now = 1 THEN 1 ELSE 0 END)::int AS now_porteur_unique,
                    SUM(CASE WHEN c.nb_now >= 2 AND GREATEST(c.nb_now - c.nb_now_titulaires, 0) = 0 THEN 1 ELSE 0 END)::int AS now_sans_releve,
                    SUM(CASE WHEN c.nb_remain = 0 THEN 1 ELSE 0 END)::int AS future_sans_porteur,
                    SUM(CASE WHEN c.nb_remain = 1 THEN 1 ELSE 0 END)::int AS future_porteur_unique,
                    SUM(CASE WHEN c.nb_remain >= 2 AND GREATEST(c.nb_remain - c.nb_remain_titulaires, 0) = 0 THEN 1 ELSE 0 END)::int AS future_sans_releve,
                    COUNT(*) FILTER (WHERE c.nb_remain <= 1 OR c.nb_remain < c.nb_now)::int AS future_fragiles,
                    MIN(c.next_exit_comp) AS next_exit_date
                FROM cov c
                CROSS JOIN effectifs_h eh
                """
                cur.execute(summary_sql, tuple(cte_params + [horizon_years, id_poste, criticite_min, id_poste, id_poste, id_poste, id_poste]))
                k = cur.fetchone() or {}
                poids_total = float(k.get("poids_total") or 0)
                poids_now = float(k.get("poids_now") or 0)
                poids_future = float(k.get("poids_future") or 0)
                couverture_now = round((poids_now / poids_total * 100.0), 1) if poids_total > 0 else 0.0
                couverture_future = round((poids_future / poids_total * 100.0), 1) if poids_total > 0 else 0.0

                causes_sql = f"""
                {base_cte}
                SELECT
                    cov.id_comp,
                    cov.criticite,
                    cov.niveau_requis,
                    cov.nb_now,
                    cov.nb_remain,
                    cov.nb_now_titulaires,
                    cov.nb_remain_titulaires,
                    cov.nb_sortants,
                    cov.next_exit_comp,
                    comp.code,
                    comp.intitule,
                    comp.domaine AS id_domaine_competence,
                    COALESCE(d.titre,'') AS domaine_titre,
                    COALESCE(d.titre_court,'') AS domaine_titre_court,
                    d.couleur AS domaine_couleur
                FROM cov
                JOIN public.tbl_competence comp ON comp.id_comp = cov.id_comp
                LEFT JOIN public.tbl_domaine_competence d ON d.id_domaine_competence = comp.domaine
                WHERE cov.nb_remain <= 1 OR cov.nb_remain < cov.nb_now
                ORDER BY cov.nb_remain ASC, cov.criticite DESC, cov.next_exit_comp NULLS LAST, comp.code ASC
                """
                cur.execute(causes_sql, tuple(cte_params + [horizon_years, id_poste, criticite_min, id_poste, id_poste]))
                cause_rows = cur.fetchall() or []

                affected_ids = [r.get("id_comp") for r in cause_rows if r.get("id_comp")]

                sortants = []
                couverture = []
                voisins = []

                if affected_ids:
                    sortants_sql = f"""
                    {base_cte}
                    SELECT
                        eh.id_effectif,
                        eh.prenom_effectif,
                        eh.nom_effectif,
                        eh.exit_date,
                        eh.raison_sortie,
                        COALESCE(o.nom_service,'') AS nom_service,
                        COALESCE(p.intitule_poste,'') AS intitule_poste,
                        comp.id_comp AS id_competence,
                        comp.code,
                        comp.intitule,
                        COALESCE(ec.niveau_actuel,'')::text AS niveau_actuel,
                        r.criticite,
                        r.niveau_requis
                    FROM req r
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                     AND COALESCE(ec.actif, TRUE) = TRUE
                     AND COALESCE(ec.archive, FALSE) = FALSE
                    JOIN effectifs_h eh ON eh.id_effectif = ec.id_effectif_client
                    JOIN public.tbl_competence comp ON comp.id_comp = r.id_comp
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = eh.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_poste p ON p.id_poste = eh.id_poste_actuel
                    WHERE r.id_comp = ANY(%s)
                      AND COALESCE(eh.is_sortant, FALSE) = TRUE
                    ORDER BY eh.exit_date ASC NULLS LAST, eh.nom_effectif ASC, comp.code ASC
                    LIMIT %s
                    """
                    cur.execute(
                        sortants_sql,
                        tuple(cte_params + [
                            horizon_years,
                            id_poste,
                            criticite_min,
                            id_poste,
                            id_poste,
                            id_ent,
                            affected_ids,
                            limit_sortants,
                        ])
                    )
                    for r in cur.fetchall() or []:
                        sortants.append({
                            "id_effectif": r.get("id_effectif"),
                            "full": (f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}").strip() or "—",
                            "exit_date": r.get("exit_date").isoformat() if hasattr(r.get("exit_date"), "isoformat") else r.get("exit_date"),
                            "raison_sortie": (r.get("raison_sortie") or "").strip() or None,
                            "nom_service": (r.get("nom_service") or "").strip() or "—",
                            "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                            "id_competence": r.get("id_competence"),
                            "code": (r.get("code") or "").strip() or "—",
                            "intitule": (r.get("intitule") or "").strip() or "—",
                            "niveau_actuel": (r.get("niveau_actuel") or "").strip() or None,
                            "criticite": int(r.get("criticite") or 0),
                            "niveau_requis": (r.get("niveau_requis") or "").strip(),
                        })

                    couverture_sql = f"""
                    {base_cte}
                    SELECT
                        eh.id_effectif,
                        eh.prenom_effectif,
                        eh.nom_effectif,
                        COALESCE(o.nom_service,'') AS nom_service,
                        COALESCE(p.intitule_poste,'') AS intitule_poste,
                        comp.id_comp AS id_competence,
                        comp.code,
                        comp.intitule,
                        COALESCE(ec.niveau_actuel,'')::text AS niveau_actuel,
                        r.criticite,
                        r.niveau_requis
                    FROM req r
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                     AND COALESCE(ec.actif, TRUE) = TRUE
                     AND COALESCE(ec.archive, FALSE) = FALSE
                    JOIN effectifs_h eh ON eh.id_effectif = ec.id_effectif_client
                    JOIN public.tbl_competence comp ON comp.id_comp = r.id_comp
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = eh.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_poste p ON p.id_poste = eh.id_poste_actuel
                    WHERE r.id_comp = ANY(%s)
                      AND COALESCE(eh.is_sortant, FALSE) = FALSE
                    ORDER BY comp.code ASC, eh.nom_effectif ASC, eh.prenom_effectif ASC
                    LIMIT %s
                    """
                    cur.execute(
                        couverture_sql,
                        tuple(cte_params + [
                            horizon_years,
                            id_poste,
                            criticite_min,
                            id_poste,
                            id_poste,
                            id_ent,
                            affected_ids,
                            limit_couverture,
                        ])
                    )
                    for r in cur.fetchall() or []:
                        couverture.append({
                            "id_effectif": r.get("id_effectif"),
                            "full": (f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}").strip() or "—",
                            "nom_service": (r.get("nom_service") or "").strip() or "—",
                            "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                            "id_competence": r.get("id_competence"),
                            "code": (r.get("code") or "").strip() or "—",
                            "comp_code": (r.get("code") or "").strip() or "—",
                            "intitule": (r.get("intitule") or "").strip() or "—",
                            "niveau_actuel": (r.get("niveau_actuel") or "").strip() or None,
                            "niveau": (r.get("niveau_actuel") or "").strip() or None,
                            "criticite": int(r.get("criticite") or 0),
                            "niveau_requis": (r.get("niveau_requis") or "").strip(),
                        })

                    voisins_sql = """
                    SELECT
                        fp.id_poste,
                        fp.intitule_poste,
                        COALESCE(o.nom_service,'') AS nom_service,
                        COUNT(DISTINCT fpc.id_competence)::int AS nb_competences_communes
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = fpc.id_poste
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    WHERE fpc.id_competence = ANY(%s)
                      AND fpc.id_poste <> %s
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                    GROUP BY fp.id_poste, fp.intitule_poste, o.nom_service
                    ORDER BY nb_competences_communes DESC, fp.intitule_poste ASC
                    LIMIT %s
                    """
                    cur.execute(voisins_sql, (id_ent, id_ent, affected_ids, id_poste, limit_voisins))
                    voisins = [dict(r) for r in (cur.fetchall() or [])]

                causes = []
                for r in cause_rows:
                    causes.append({
                        "id_comp": r.get("id_comp"),
                        "id_competence": r.get("id_comp"),
                        "code": (r.get("code") or "").strip() or "—",
                        "intitule": (r.get("intitule") or "").strip() or "—",
                        "id_domaine_competence": r.get("id_domaine_competence"),
                        "domaine_titre": r.get("domaine_titre"),
                        "domaine_titre_court": r.get("domaine_titre_court"),
                        "domaine_couleur": r.get("domaine_couleur"),
                        "criticite": int(r.get("criticite") or 0),
                        "niveau_requis": (r.get("niveau_requis") or "").strip(),
                        "nb_now": int(r.get("nb_now") or 0),
                        "nb_remain": int(r.get("nb_remain") or 0),
                        "nb_now_titulaires": int(r.get("nb_now_titulaires") or 0),
                        "nb_remain_titulaires": int(r.get("nb_remain_titulaires") or 0),
                        "nb_sortants": int(r.get("nb_sortants") or 0),
                        "next_exit_comp": r.get("next_exit_comp").isoformat() if hasattr(r.get("next_exit_comp"), "isoformat") else r.get("next_exit_comp"),
                    })

                next_exit = k.get("next_exit_date")
                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "criticite_min": int(criticite_min),
                    "poste": {
                        "id_poste": poste_row.get("id_poste"),
                        "codif_poste": poste_row.get("codif_poste"),
                        "codif_client": poste_row.get("codif_client"),
                        "intitule_poste": poste_row.get("intitule_poste"),
                        "id_service": poste_row.get("id_service"),
                        "nom_service": poste_row.get("nom_service"),
                        "nb_titulaires_cible": int(poste_row.get("nb_titulaires_cible") or 1),
                        "statut_poste": poste_row.get("statut_poste"),
                    },
                    "kpis": {
                        "nb_titulaires_now": int(k.get("nb_titulaires_now") or 0),
                        "nb_titulaires_horizon": int(k.get("nb_titulaires_horizon") or 0),
                        "nb_titulaires_cible": int(poste_row.get("nb_titulaires_cible") or 1),
                        "couverture_now": couverture_now,
                        "couverture_future": couverture_future,
                        "future_fragiles": int(k.get("future_fragiles") or 0),
                        "future_sans_porteur": int(k.get("future_sans_porteur") or 0),
                        "future_porteur_unique": int(k.get("future_porteur_unique") or 0),
                        "future_sans_releve": int(k.get("future_sans_releve") or 0),
                        "now_sans_porteur": int(k.get("now_sans_porteur") or 0),
                        "now_porteur_unique": int(k.get("now_porteur_unique") or 0),
                        "now_sans_releve": int(k.get("now_sans_releve") or 0),
                        "next_exit_date": next_exit.isoformat() if hasattr(next_exit, "isoformat") else next_exit,
                    },
                    "causes": causes,
                    "sortants": sortants,
                    "couverture": couverture,
                    "voisins": voisins,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

class AnalyseRisqueItem(BaseModel):
    # Poste
    id_poste: Optional[str] = None
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None
    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    nb_critiques_fragiles: Optional[int] = None
    nb_critiques_sans_porteur: Optional[int] = None
    nb_critiques_porteur_unique: Optional[int] = None
    nb_titulaires: Optional[int] = None
    nb_titulaires_rattaches: Optional[int] = None

    nb_critiques_sans_releve: Optional[int] = None
    nb_critiques_releve_faible: Optional[int] = None
    nb_titulaires_cible: Optional[int] = None
    gap_titulaires: Optional[int] = None
    indice_fragilite: Optional[int] = None
    nb_competences_analysees: Optional[int] = None
    is_non_analyse: Optional[bool] = None
    nb_couvertures_non_confirmees: Optional[int] = None

    # Compétence (pour les KPI compétences)
    id_comp: Optional[str] = None
    code: Optional[str] = None
    intitule: Optional[str] = None

    id_domaine_competence: Optional[str] = None
    domaine_titre: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None

    nb_postes_impactes: Optional[int] = None
    nb_porteurs: Optional[int] = None
    nb_porteurs_dispo: Optional[int] = None
    max_criticite: Optional[int] = None

    # Enrichissement critiques fragiles
    besoin_total: Optional[int] = None
    nb_experts: Optional[int] = None
    nb_experts_dispo: Optional[int] = None
    criticite_max: Optional[int] = None
    nb_postes_crit_80: Optional[int] = None

    priorite: Optional[str] = None
    priorite_score: Optional[int] = None


class AnalyseRisquesDetailResponse(BaseModel):
    scope: ServiceScope
    kpi: str
    criticite_min: int
    updated_at: str
    items: list[AnalyseRisqueItem]


@router.get("/skills/analyse/risques/projection-events/{id_contact}")
def get_analyse_risques_projection_events(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    """
    Détail des événements RH pris en compte dans la lecture prévisionnelle à 3 mois.

    Cohérence métier : les événements affichés doivent porter sur le même périmètre que
    l'indice de fragilité projeté. On filtre donc sur les postes réellement analysés
    après application du service et du seuil de criticité.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                crit = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min)))

                poste_records = _fetch_postes_fragility_records(cur, id_ent, scope.id_service, crit)
                analysed_poste_ids = [
                    str(r.get("id_poste") or "").strip()
                    for r in (poste_records or [])
                    if str(r.get("id_poste") or "").strip() and not bool(r.get("is_non_analyse") or False)
                ]

                def empty_month(idx: int) -> Dict[str, Any]:
                    period_start, period_end = _analyse_month_bounds_from_today(idx)
                    return {
                        "index": idx,
                        "label": "Aujourd’hui" if idx == 0 else period_start.strftime("%m/%y"),
                        "period_start": period_start.isoformat(),
                        "period_end": period_end.isoformat(),
                        "indisponibilites_count": 0,
                        "sorties_count": 0,
                        "indisponibilites": [],
                        "sorties": [],
                    }

                if not analysed_poste_ids:
                    months = [empty_month(idx) for idx in range(0, 4)]
                    return {
                        "scope": scope.model_dump() if hasattr(scope, "model_dump") else dict(scope),
                        "criticite_min": crit,
                        "updated_at": datetime.now().isoformat(timespec="seconds"),
                        "months": months,
                    }

                months = []
                for idx in range(0, 4):
                    period_start, period_end = _analyse_month_bounds_from_today(idx)
                    label = "Aujourd’hui" if idx == 0 else period_start.strftime("%m/%y")

                    sql = """
                    WITH base_effectifs AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.code_effectif,
                            e.id_poste_actuel,
                            e.type_contrat,
                            e.motif_sortie,
                            e.date_sortie_prevue,
                            fp.codif_poste,
                            fp.codif_client,
                            fp.intitule_poste
                        FROM public.tbl_effectif_client e
                        LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = e.id_poste_actuel
                        WHERE e.id_ent = %s
                          AND COALESCE(e.archive, FALSE) = FALSE
                          AND COALESCE(e.statut_actif, TRUE) = TRUE
                          AND COALESCE(e.id_poste_actuel, '') <> ''
                          AND e.id_poste_actuel = ANY(%s)
                    ),
                    indispos_raw AS (
                        SELECT
                            b.id_break,
                            b.id_effectif,
                            b.date_debut,
                            b.date_fin,
                            be.nom_effectif,
                            be.prenom_effectif,
                            be.code_effectif,
                            be.codif_poste,
                            be.codif_client,
                            be.intitule_poste
                        FROM public.tbl_effectif_client_break b
                        JOIN base_effectifs be ON be.id_effectif = b.id_effectif
                        WHERE b.id_ent = %s
                          AND COALESCE(b.archive, FALSE) = FALSE
                          AND b.date_debut <= %s::date
                          AND b.date_fin >= %s::date
                    ),
                    indispos AS (
                        SELECT
                            ir.id_effectif,
                            MIN(ir.date_debut)::date AS date_debut,
                            MAX(ir.date_fin)::date AS date_fin,
                            MAX(ir.nom_effectif)::text AS nom_effectif,
                            MAX(ir.prenom_effectif)::text AS prenom_effectif,
                            MAX(ir.code_effectif)::text AS code_effectif,
                            MAX(ir.codif_poste)::text AS codif_poste,
                            MAX(ir.codif_client)::text AS codif_client,
                            MAX(ir.intitule_poste)::text AS intitule_poste
                        FROM indispos_raw ir
                        GROUP BY ir.id_effectif
                    ),
                    sorties AS (
                        SELECT
                            be.id_effectif,
                            be.nom_effectif,
                            be.prenom_effectif,
                            be.code_effectif,
                            be.type_contrat,
                            be.motif_sortie,
                            be.date_sortie_prevue,
                            be.codif_poste,
                            be.codif_client,
                            be.intitule_poste
                        FROM base_effectifs be
                        WHERE be.date_sortie_prevue IS NOT NULL
                          AND be.date_sortie_prevue >= %s::date
                          AND be.date_sortie_prevue <= %s::date
                    )
                    SELECT
                        (SELECT COALESCE(json_agg(row_to_json(i) ORDER BY i.date_debut, i.nom_effectif, i.prenom_effectif), '[]'::json) FROM indispos i) AS indisponibilites,
                        (SELECT COALESCE(json_agg(row_to_json(s) ORDER BY s.date_sortie_prevue, s.nom_effectif, s.prenom_effectif), '[]'::json) FROM sorties s) AS sorties
                    """
                    params = [id_ent, analysed_poste_ids, id_ent, period_end, period_start, period_start, period_end]
                    cur.execute(sql, params)
                    row = cur.fetchone() or {}
                    indispos = row.get("indisponibilites") or []
                    sorties = row.get("sorties") or []

                    def person_label(r: Dict[str, Any]) -> str:
                        full = f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}".strip()
                        return full or (r.get("code_effectif") or "Collaborateur")

                    def poste_label(r: Dict[str, Any]) -> str:
                        code = (r.get("codif_client") or r.get("codif_poste") or "").strip()
                        title = (r.get("intitule_poste") or "").strip()
                        return f"{code} - {title}".strip(" -") or "Poste non renseigné"

                    indispo_items = [
                        {
                            "id_effectif": r.get("id_effectif"),
                            "personne": person_label(r),
                            "poste": poste_label(r),
                            "date_debut": _analyse_date_fr_value(r.get("date_debut")),
                            "date_fin": _analyse_date_fr_value(r.get("date_fin")),
                        }
                        for r in (indispos or [])
                    ]
                    sortie_items = [
                        {
                            "id_effectif": r.get("id_effectif"),
                            "personne": person_label(r),
                            "poste": poste_label(r),
                            "date_sortie": _analyse_date_fr_value(r.get("date_sortie_prevue")),
                            "motif": (r.get("motif_sortie") or r.get("type_contrat") or "Sortie prévue"),
                        }
                        for r in (sorties or [])
                    ]

                    months.append({
                        "index": idx,
                        "label": label,
                        "period_start": period_start.isoformat(),
                        "period_end": period_end.isoformat(),
                        "indisponibilites_count": len(indispo_items),
                        "sorties_count": len(sortie_items),
                        "indisponibilites": indispo_items,
                        "sorties": sortie_items,
                    })

        return {
            "scope": scope.model_dump() if hasattr(scope, "model_dump") else dict(scope),
            "criticite_min": crit,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "months": months,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur projection événements: {e}")

@router.get(
    "/skills/analyse/risques/detail/{id_contact}",
    response_model=AnalyseRisquesDetailResponse,
)
def get_analyse_risques_detail(
    id_contact: str,
    request: Request,
    kpi: str = Query(...),  # "postes-fragiles" | "postes-scope" | "critiques-sans-porteur" | "porteur-unique"
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=50),
    ref_mois: int = Query(default=0, ge=0, le=36),
):
    """
    Détail Risques derrière les KPI:
    - postes-fragiles: liste de postes triés par fragilité
    - critiques-sans-porteur: compétences critiques requises mais sans porteur
    - porteur-unique: compétences critiques portées par une seule personne
    """
    try:
        k = (kpi or "").strip().lower()
        if k not in ("postes-fragiles", "postes-scope", "critiques-fragiles", "critiques-sans-porteur", "porteur-unique"):
            raise HTTPException(status_code=400, detail="Paramètre kpi invalide.")

        if limit < 1:
            limit = 1
        limit_max = 2000 if k in ("postes-fragiles", "postes-scope") else 200
        if limit > limit_max:
            limit = limit_max

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # Base: compétences requises + porteurs (dans le scope)
                base_cte = f"""
                WITH
                {cte_sql},
                ref_date AS (
                    SELECT (CURRENT_DATE + (%s::int * interval '1 month'))::date AS d_ref
                ),
                req AS (
                    SELECT DISTINCT
                        fpc.id_poste,
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.grille_evaluation,
                        c.domaine AS id_domaine_competence,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
                        fpc.niveau_requis
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE
                        c.etat = 'active'
                        AND COALESCE(c.masque, FALSE) = FALSE
                        AND COALESCE(fpc.masque, FALSE) = FALSE
                ),
                effectifs_dispo AS (
                    -- "Aujourd'hui": on enlève les effectifs en indisponibilité en cours
                    SELECT es.id_effectif
                    FROM effectifs_scope es
                    JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_break b
                        WHERE b.id_effectif = e.id_effectif
                          AND b.archive = FALSE
                          AND b.date_debut <= (SELECT d_ref FROM ref_date)
                          AND b.date_fin >= (SELECT d_ref FROM ref_date)
                      )
                ),
                porteurs AS (
                    -- Nominal (structurel): sans prendre en compte les indisponibilités
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.id_comp, '') <> ''
                    GROUP BY ec.id_comp
                ),
                porteurs_dispo AS (
                    -- Aujourd'hui : porteurs évalués disponibles (exclusion des breaks en cours).
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_dispo ed ON ed.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = ec.id_dernier_audit
                     AND a.id_effectif_competence = ec.id_effectif_competence
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.id_comp, '') <> ''
                      AND a.resultat_eval IS NOT NULL
                      AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL)
                    GROUP BY ec.id_comp
                )

                """

                items: list[AnalyseRisqueItem] = []

                # ---------------------------
                # KPI: Postes (scope) / Postes fragiles
                # ---------------------------
                if k in ("postes-fragiles", "postes-scope"):
                    if int(ref_mois or 0) > 0:
                        period_start, period_end = _analyse_projection_period(int(ref_mois or 0))
                        records = _fetch_postes_fragility_records_projected(
                            cur,
                            id_ent,
                            scope.id_service,
                            criticite_min,
                            period_start,
                            period_end,
                        )
                    else:
                        records = _fetch_postes_fragility_records(
                            cur,
                            id_ent,
                            scope.id_service,
                            criticite_min,
                        )
                    if k == "postes-fragiles":
                        records = [r for r in records if r.get("is_fragile")]

                    for r in records[:limit]:
                        items.append(AnalyseRisqueItem(
                            id_poste=r.get("id_poste"),
                            codif_poste=r.get("codif_poste"),
                            codif_client=r.get("codif_client"),
                            intitule_poste=r.get("intitule_poste"),
                            id_service=r.get("id_service"),
                            nom_service=r.get("nom_service"),
                            nb_critiques_fragiles=int(r.get("nb_critiques_fragiles") or 0),
                            nb_critiques_sans_porteur=int(r.get("nb_critiques_sans_porteur") or 0),
                            nb_critiques_porteur_unique=int(r.get("nb_critiques_porteur_unique") or 0),
                            nb_titulaires=int(r.get("nb_titulaires") or 0),
                            nb_titulaires_rattaches=int(r.get("nb_titulaires_rattaches") or 0),
                            nb_critiques_sans_releve=int(r.get("nb_critiques_sans_releve") or 0),
                            nb_critiques_releve_faible=int(r.get("nb_critiques_releve_faible") or 0),
                            nb_titulaires_cible=int(r.get("nb_titulaires_cible") or 1),
                            gap_titulaires=int(r.get("gap_titulaires") or 0),
                            indice_fragilite=int(r.get("indice_fragilite") or 0),
                            nb_competences_analysees=int(r.get("nb_competences_analysees") or 0),
                            is_non_analyse=bool(r.get("is_non_analyse") or False),
                            nb_couvertures_non_confirmees=int(r.get("nb_couvertures_non_confirmees") or 0),
                        ))
                # ---------------------------
                # KPI: Compétences critiques fragiles
                # ---------------------------
                elif k in ("critiques-fragiles", "critiques-sans-porteur", "porteur-unique"):
                    # Source unique: même calcul pour la table, les KPI et le modal compétence.
                    if int(ref_mois or 0) > 0:
                        period_start, period_end = _analyse_projection_period(int(ref_mois or 0))
                        records = _fetch_competence_fragility_records_projected(
                            cur,
                            id_ent,
                            scope.id_service,
                            criticite_min,
                            period_start,
                            period_end,
                            comp_id=None,
                            limit=limit,
                        )
                    else:
                        records = _fetch_competence_fragility_records(
                            cur,
                            id_ent,
                            scope.id_service,
                            criticite_min,
                            comp_id=None,
                            limit=limit,
                        )

                    if k == "critiques-sans-porteur":
                        records = [r for r in records if int(r.get("nb_postes_couverture_absente") or 0) > 0]
                    elif k == "porteur-unique":
                        records = [r for r in records if int(r.get("nb_postes_dependance") or 0) > 0]
                    else:
                        records = [r for r in records if int(r.get("indice_fragilite") or 0) > 0]

                    for r in records[:limit]:
                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("domaine_titre"),
                            domaine_titre_court=r.get("domaine_titre_court"),
                            domaine_couleur=r.get("domaine_couleur"),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            nb_porteurs=int(r.get("nb_porteurs") or 0),
                            nb_porteurs_dispo=int(r.get("nb_porteurs_dispo") or 0),
                            besoin_total=int(r.get("besoin_total") or 0),
                            nb_experts=int(r.get("nb_experts") or 0),
                            nb_experts_dispo=int(r.get("nb_experts_dispo") or 0),
                            criticite_max=int(r.get("criticite_max") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                            nb_postes_crit_80=int(r.get("nb_postes_crit_80") or 0),
                            indice_fragilite=int(r.get("indice_fragilite") or 0),
                            priorite=r.get("priorite"),
                            priorite_score=int(r.get("priorite_score") or 0),
                        ))

                    return AnalyseRisquesDetailResponse(
                        scope=scope,
                        kpi=k,
                        criticite_min=int(criticite_min),
                        updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        items=items,
                    )

                return AnalyseRisquesDetailResponse(
                    scope=scope,
                    kpi=k,
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    items=items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")



def _analyse_risk_detail_pdf_priority_label(score: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    if s >= 75:
        return "Critique"
    if s >= 50:
        return "Élevé"
    if s >= 25:
        return "Modéré"
    return "Faible"


def _analyse_risk_detail_pdf_table(kpi: str, items: List[Any], styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body_style = styles.get("small") or styles.get("body")
    head_style = styles.get("meta_label") or styles.get("small") or body_style

    def p(value: Any, style=None):
        return Paragraph(_analyse_pdf_esc(value), style or body_style)

    k = (kpi or "").strip().lower()
    rows: List[List[Any]] = []
    widths: List[Any] = []

    if k == "postes-scope":
        rows.append([p("Code", head_style), p("Poste", head_style), p("Service", head_style), p("Indice", head_style), p("État", head_style)])
        widths = [26 * mm, 88 * mm, 54 * mm, 26 * mm, 32 * mm]
        for item in (items or []):
            r = item.dict() if hasattr(item, "dict") else dict(item or {})
            code = (r.get("codif_client") or r.get("codif_poste") or "—")
            score = _analyse_pdf_safe_int(r.get("indice_fragilite"))
            rows.append([
                p(code),
                p(r.get("intitule_poste") or "—"),
                p(r.get("nom_service") or "—"),
                p(f"{score}%"),
                p(_analyse_comp_pdf_state_label(score)),
            ])
    else:
        rows.append([p("Code", head_style), p("Compétence", head_style), p("Domaine", head_style), p("Présence", head_style), p("Indice", head_style), p("État", head_style)])
        widths = [24 * mm, 86 * mm, 46 * mm, 24 * mm, 22 * mm, 28 * mm]
        for item in (items or []):
            r = item.dict() if hasattr(item, "dict") else dict(item or {})
            score = _analyse_pdf_safe_int(r.get("indice_fragilite") or r.get("priorite_score"))
            besoin = _analyse_pdf_safe_int(r.get("besoin_total")) or 1
            porteurs = _analyse_pdf_safe_int(r.get("nb_porteurs"))
            rows.append([
                p(r.get("code") or "—"),
                p(r.get("intitule") or "—"),
                p(r.get("domaine_titre_court") or r.get("domaine_titre") or "—"),
                p(f"{porteurs}/{besoin}"),
                p(f"{score}%"),
                p(_analyse_comp_pdf_state_label(score)),
            ])

    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


@router.get("/skills/analyse/risques/detail/pdf/{id_contact}")
def get_analyse_risques_detail_pdf(
    id_contact: str,
    request: Request,
    kpi: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=10, ge=1, le=2000),
):
    try:
        from fastapi import Response
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.platypus import Paragraph
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        k = (kpi or "").strip().lower()
        if k not in ("postes-scope", "critiques-fragiles"):
            raise HTTPException(status_code=400, detail="Table non imprimable.")

        detail = get_analyse_risques_detail(
            id_contact=id_contact,
            request=request,
            kpi=k,
            id_service=id_service,
            criticite_min=criticite_min,
            limit=limit,
            ref_mois=0,
        )

        styles = build_pdf_styles()
        title = "Fragilité des postes" if k == "postes-scope" else "Fragilités par compétence"
        today = datetime.now().strftime("%d/%m/%Y")
        scope_name = getattr(detail.scope, "nom_service", None) or "Tous les services"

        company_name = ""
        logo_bytes = None
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        story = []
        story.append(Paragraph(f"Risques actuels • {title}", styles["title"]))
        story.append(Paragraph(f"Périmètre analysé : {scope_name} • Date : {today} • Criticité minimale : {criticite_min} • Lignes : {len(detail.items or [])}", styles["subtitle"]))
        story.append(make_spacer(3))
        story.append(_analyse_risk_detail_pdf_table(k, detail.items or [], styles))

        pdf = build_pdf_document(story, {
            "title": f"Risques actuels - {title}",
            "footer_left": "Novoskill Insights • Risques actuels",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))

        filename = "risques_actuels_postes.pdf" if k == "postes-scope" else "risques_actuels_competences.pdf"
        return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{filename}"'})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF table risques: {e}")
# ======================================================
# Models: Drilldown Poste (Risques)
# ======================================================
class AnalysePorteurItem(BaseModel):
    id_effectif: str
    prenom_effectif: Optional[str] = None
    nom_effectif: Optional[str] = None
    nom_service: Optional[str] = None
    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None
    niveau_actuel: Optional[str] = None  # Initial / Avancé / Expert


class AnalysePosteCompetenceItem(BaseModel):
    id_comp: str
    code: Optional[str] = None
    intitule: Optional[str] = None
    description: Optional[str] = None

    id_domaine_competence: Optional[str] = None
    domaine_titre: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None

    niveau_requis: Optional[str] = None
    poids_criticite: Optional[int] = None

    nb_porteurs: int = 0
    porteurs: List[AnalysePorteurItem] = []


class AnalysePosteCoverage(BaseModel):
    total_competences: int = 0
    couvert_1plus: int = 0
    couvert_2plus: int = 0
    non_couvert: int = 0
    porteur_unique: int = 0

    total_critiques: int = 0
    critiques_couvert_1plus: int = 0
    critiques_couvert_2plus: int = 0
    critiques_non_couvert: int = 0
    critiques_porteur_unique: int = 0


class AnalysePosteDetailResponse(BaseModel):
    scope: ServiceScope
    criticite_min: int
    updated_at: str
    poste: Dict[str, Any]
    coverage: AnalysePosteCoverage
    competences: List[AnalysePosteCompetenceItem]


class AnalysePosteTopRisqueItem(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    intitule: Optional[str] = None
    poids_criticite: Optional[int] = None

    type_risque: str  # NON_COUVERTE / COUV_UNIQUE / FRAGILE
    nb_porteurs: int = 0      # 0 / 1 / 2 (2 = 2+)
    nb_ok: int = 0            # 0 / 1 / 2 (2 = 2+), au niveau requis
    recommandation: Optional[str] = None  # legacy (UI n’affiche plus de “reco” ici)


class AnalysePosteCauseStructurelle(BaseModel):
    nb_titulaires: int = 0
    nb_titulaires_cible: int = 1
    gap_titulaires: int = 0
    poste_non_tenu: bool = False
    nb_titulaires_rattaches: int = 0
    nb_titulaires_disponibles: int = 0
    nb_indisponibles: int = 0

class AnalysePosteDependanceItem(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    intitule: Optional[str] = None
    poids_criticite: Optional[int] = None
    niveau_requis: Optional[str] = None

    nb_porteurs_ok: int = 0
    seuil_couverture: int = 2
    type_risque: str = "COUVERTURE_LIMITEE"  # SANS_PORTEUR / COUVERTURE_LIMITEE


class AnalysePosteTransmissionCause(BaseModel):
    raisons: List[str] = []
    nb_ressources_potentielles: int = 0

    pool_total: int = 0
    pool_eligible: int = 0
    pool_diplome_ok: int = 0
    pool_domaine_ok: int = 0

    nb_renforts_immediats: int = 0
    nb_renforts_a_preparer: int = 0
    meilleur_matching: int = 0

class AnalysePosteEfficaciteItem(BaseModel):
    id_comp: Optional[str] = None
    code_comp: Optional[str] = None
    intitule: Optional[str] = None
    poids_criticite: Optional[int] = None
    niveau_requis: Optional[str] = None

    nb_en_defaut: int = 0
    nb_titulaires: int = 0

    # Variante salarié : lecture RH du niveau attendu non atteint.
    # Le pourcentage ne s'appuie pas sur une moyenne de notes, mais sur les niveaux A/B/C/D réellement atteints.
    kind: str = "competence"
    id_effectif: Optional[str] = None
    full: Optional[str] = None
    poste_actuel: Optional[str] = None
    maitrise_attendue_pct: int = 100
    maitrise_actuelle_pct: int = 0
    ecart_pct: int = 0
    competences_ok: int = 0
    competences_total: int = 0
    poids_ok: int = 0
    poids_total: int = 0
    matching_score_pct: int = 0

class AnalysePosteSortieApprochanteItem(BaseModel):
    id_effectif: Optional[str] = None
    full: Optional[str] = None
    date_sortie: Optional[str] = None
    motif: Optional[str] = None


class AnalysePosteSortieApprochanteCause(BaseModel):
    count: int = 0
    horizon: str = "3 mois"
    items: List[AnalysePosteSortieApprochanteItem] = []


class AnalysePosteCausesRacines(BaseModel):
    structure: Optional[AnalysePosteCauseStructurelle] = None
    dependance: List[AnalysePosteDependanceItem] = []
    transmission: Optional[AnalysePosteTransmissionCause] = None
    efficacite: List[AnalysePosteEfficaciteItem] = []
    sorties_approchantes: Optional[AnalysePosteSortieApprochanteCause] = None

class AnalysePosteFragiliteComposantes(BaseModel):
    # Compat legacy (gardé pour éviter de casser)
    nb0: int = 0
    nb1: int = 0
    nb_total_fragiles: int = 0
    criticite_min: int = 0

    # Nouveau (pour affichage + cohérence)
    nb_sans_releve: int = 0
    nb_releve_faible: int = 0
    gap_titulaires: int = 0
    nb_evenements: int = 0

    nb_titulaires: int = 0
    nb_titulaires_cible: int = 1
    nb_titulaires_rattaches: int = 0
    nb_indisponibles: int = 0
    nb_sorties_approchantes: int = 0

    # Scores composantes renvoyés par le backend.
    # Le front les utilise pour afficher des parts de causes cohérentes avec l’indice.
    score_structurel: int = 0
    score_efficacite: int = 0
    score_dependance: int = 0
    score_transmission: int = 0
    score_sorties_approchantes: int = 0
    score_renfort_potentiel: int = 0
    score_total: int = 0

class AnalysePosteDiagnosticConditions(BaseModel):
    # “lisible dirigeant”, pas du jargon technique
    releve_phrase: str = "Relève prise en compte : collaborateurs mobilisables immédiatement."
    diplome_min: Optional[str] = None
    domaine_formation: Optional[str] = None
    domaine_bloquant: bool = False


class AnalysePosteDiagnosticResponse(BaseModel):
    scope: ServiceScope
    updated_at: str
    poste: Dict[str, Any]

    indice_fragilite: int
    composantes: AnalysePosteFragiliteComposantes

    top_risques: List[AnalysePosteTopRisqueItem]
    causes: Optional[AnalysePosteCausesRacines] = None
    conditions: Optional[AnalysePosteDiagnosticConditions] = None



def _analyse_poste_titulaires_mastery_items(
    cur,
    id_ent: str,
    id_service: Optional[str],
    id_poste: str,
    criticite_min: int,
) -> List[AnalysePosteEfficaciteItem]:
    """
    Lecture salarié du niveau attendu non atteint.
    La maîtrise actuelle est calculée par niveau A/B/C/D atteint, pas par moyenne de notes.
    100% = toutes les compétences retenues atteignent au moins le niveau requis.
    """
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    cur.execute(
        f"""
        WITH
        {cte_sql},
        req AS (
            SELECT DISTINCT c.id_comp, c.code, c.intitule, COALESCE(fpc.niveau_requis, '') AS niveau_requis, COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
            FROM public.tbl_fiche_poste_competence fpc
            JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
            JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
            WHERE fpc.id_poste = %s
              AND c.etat = 'active'
              AND COALESCE(c.masque, FALSE) = FALSE
              AND COALESCE(fpc.masque, FALSE) = FALSE
              AND COALESCE(fpc.poids_criticite, 0)::int >= %s
        ),
        titulaires AS (
            SELECT e.id_effectif, e.prenom_effectif, e.nom_effectif, COALESCE(p.intitule_poste, '') AS poste_actuel
            FROM public.tbl_effectif_client e
            JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
            LEFT JOIN public.tbl_fiche_poste p ON p.id_poste = e.id_poste_actuel
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
              AND e.id_poste_actuel = %s
              AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
              AND NOT EXISTS (
                SELECT 1 FROM public.tbl_effectif_client_break b
                WHERE b.id_effectif = e.id_effectif
                  AND COALESCE(b.archive, FALSE) = FALSE
                  AND b.date_debut <= CURRENT_DATE
                  AND b.date_fin >= CURRENT_DATE
              )
        )
        SELECT t.id_effectif, t.prenom_effectif, t.nom_effectif, t.poste_actuel,
               r.id_comp, r.niveau_requis, r.poids_criticite, ac.resultat_eval
        FROM titulaires t
        CROSS JOIN req r
        LEFT JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = t.id_effectif
         AND ec.id_comp = r.id_comp
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_effectif_client_audit_competence ac
          ON ac.id_audit_competence = ec.id_dernier_audit
        ORDER BY t.nom_effectif, t.prenom_effectif
        """,
        tuple(cte_params + [id_poste, int(criticite_min), id_ent, id_poste]),
    )
    rows = cur.fetchall() or []
    by_emp: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        ide = str(r.get("id_effectif") or "").strip()
        if not ide:
            continue
        item = by_emp.setdefault(ide, {
            "id_effectif": ide,
            "full": f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}".strip() or "Collaborateur",
            "poste_actuel": r.get("poste_actuel") or "",
            "poids_total": 0,
            "poids_ok": 0,
            "competences_total": 0,
            "competences_ok": 0,
        })
        poids = max(1, _analyse_pdf_safe_int(r.get("poids_criticite")))
        req_rank = _niveau_rank(r.get("niveau_requis") or "")
        cur_level = _niveau_from_score(_safe_float(r.get("resultat_eval")))
        cur_rank = _niveau_rank(cur_level)
        ok = bool(req_rank > 0 and cur_rank >= req_rank)
        item["poids_total"] += poids
        item["competences_total"] += 1
        if ok:
            item["poids_ok"] += poids
            item["competences_ok"] += 1

    out: List[AnalysePosteEfficaciteItem] = []
    for item in by_emp.values():
        total = max(1, int(item.get("poids_total") or 0))
        pct = int(round((float(item.get("poids_ok") or 0) / float(total)) * 100.0))
        pct = max(0, min(100, pct))
        if pct >= 100:
            continue
        out.append(AnalysePosteEfficaciteItem(
            kind="salarie",
            id_effectif=item.get("id_effectif"),
            full=item.get("full"),
            poste_actuel=item.get("poste_actuel"),
            maitrise_attendue_pct=100,
            maitrise_actuelle_pct=pct,
            ecart_pct=max(0, 100 - pct),
            competences_ok=int(item.get("competences_ok") or 0),
            competences_total=int(item.get("competences_total") or 0),
            poids_ok=int(item.get("poids_ok") or 0),
            poids_total=int(item.get("poids_total") or 0),
            matching_score_pct=pct,
        ))
    out.sort(key=lambda x: (-int(x.ecart_pct or 0), str(x.full or "")))
    return out

def _analyse_poste_sorties_approchantes_cause(
    cur,
    id_ent: str,
    id_service: Optional[str],
    id_poste: str,
) -> Optional[AnalysePosteSortieApprochanteCause]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    horizon = _analyse_add_months(date.today(), 3)
    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT e.id_effectif,
               COALESCE(e.prenom_effectif, '') AS prenom_effectif,
               COALESCE(e.nom_effectif, '') AS nom_effectif,
               e.date_sortie_prevue,
               CASE WHEN COALESCE(e.havedatefin, FALSE) THEN 'Fin de contrat / sortie prévue' ELSE 'Sortie prévue' END AS motif
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND e.id_poste_actuel = %s
          AND e.date_sortie_prevue IS NOT NULL
          AND e.date_sortie_prevue >= CURRENT_DATE
          AND e.date_sortie_prevue <= %s
        ORDER BY e.date_sortie_prevue, e.nom_effectif, e.prenom_effectif
        """,
        tuple(cte_params + [id_ent, id_poste, horizon]),
    )
    rows = cur.fetchall() or []
    if not rows:
        return None
    items = []
    for r in rows:
        full = f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}".strip() or "Collaborateur"
        items.append(AnalysePosteSortieApprochanteItem(
            id_effectif=r.get("id_effectif"),
            full=full,
            date_sortie=_analyse_date_fr_value(r.get("date_sortie_prevue")),
            motif=r.get("motif") or "Sortie prévue",
        ))
    return AnalysePosteSortieApprochanteCause(count=len(items), items=items)

class AnalyseMatchingItem(BaseModel):
    id_effectif: str
    full: str
    nom_service: str
    id_poste_actuel: Optional[str] = None
    score_pct: int = 0
    crit_missing: int = 0
    crit_under: int = 0
    nb_missing: int = 0
    nb_under: int = 0
    is_titulaire: bool = False


class AnalyseMatchingPosteResponse(BaseModel):
    poste: Dict[str, Any]
    scope: ServiceScope
    criticite_min: int
    updated_at: str
    items: List[AnalyseMatchingItem]


class AnalyseMatchingCritere(BaseModel):
    code_critere: Optional[str] = None
    niveau: Optional[int] = None
    nom: Optional[str] = None
    libelle: Optional[str] = None


class AnalyseMatchingCompetenceDetail(BaseModel):
    id_comp: str
    code: Optional[str] = None
    intitule: Optional[str] = None
    id_domaine_competence: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None

    poids_criticite: int = 1
    niveau_requis: Optional[str] = None
    seuil: float = 0.0

    score: Optional[float] = None
    niveau_atteint: Optional[str] = None

    etat: str = "missing"  # ok / improvable / under / missing
    is_critique: bool = False

    criteres: List[AnalyseMatchingCritere] = []


class AnalyseMatchingPerson(BaseModel):
    id_effectif: str
    full: str
    nom_service: str
    derniere_evaluation_competences: Optional[str] = None
    dernier_entretien_individuel: Optional[str] = None

    id_poste_actuel: Optional[str] = None
    poste_actuel: Optional[Dict[str, Any]] = None
    poste_actuel_hors_scope: bool = False

    is_titulaire: bool = False


class AnalyseMatchingStats(BaseModel):
    score_pct: int = 0
    crit_missing: int = 0
    crit_under: int = 0
    nb_missing: int = 0
    nb_under: int = 0


class AnalyseMatchingEffectifResponse(BaseModel):
    poste: Dict[str, Any]
    person: AnalyseMatchingPerson
    scope: ServiceScope
    criticite_min: int
    updated_at: str
    stats: AnalyseMatchingStats
    items: List[AnalyseMatchingCompetenceDetail]



# ======================================================
# Endpoint: Drilldown Poste (Risques)
# ======================================================
@router.get(
    "/skills/analyse/risques/poste/{id_contact}",
    response_model=AnalysePosteDetailResponse,
)
def get_analyse_risques_poste_detail(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    """
    Drilldown "poste fragile":
    - toutes les compétences requises du poste (niveau_requis, criticité)
    - porteurs par compétence avec niveau_actuel (Débutant/Intermédiaire/Avancé/Expert)
    - stats de couverture (global + critiques)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # 1) Vérifier que le poste est dans le scope
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    WHERE fp.id_poste = %s
                    LIMIT 1
                    """,
                    tuple(cte_params + [id_ent, id_poste]),
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste introuvable (ou hors périmètre service).")
                
                # 1bis) Nb titulaires (poste non tenu = fragilité max)
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    WHERE COALESCE(e.archive, FALSE) = FALSE
                      AND e.id_poste_actuel = %s
                    """,
                    tuple(cte_params + [id_poste]),
                )
                nb_titulaires = int((cur.fetchone() or {}).get("nb_titulaires") or 0)


                # 2) Compétences requises du poste
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.description,
                        c.domaine AS id_domaine_competence,
                        COALESCE(fpc.niveau_requis, '') AS niveau_requis,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
                        d.titre,
                        d.titre_court,
                        d.couleur
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    WHERE
                        fpc.id_poste = %s
                        AND c.etat = 'active'
                        AND COALESCE(c.masque, FALSE) = FALSE
                    ORDER BY
                        COALESCE(d.ordre_affichage, 999999),
                        COALESCE(d.titre_court, d.titre, ''),
                        c.code
                    """,
                    tuple(cte_params + [id_poste]),
                )
                comp_rows = cur.fetchall() or []

                competences: List[AnalysePosteCompetenceItem] = []
                comp_map: Dict[str, AnalysePosteCompetenceItem] = {}

                for r in comp_rows:
                    cid = r.get("id_comp")
                    if not cid:
                        continue
                    item = AnalysePosteCompetenceItem(
                        id_comp=cid,
                        code=r.get("code"),
                        intitule=r.get("intitule"),
                        description=r.get("description"),
                        id_domaine_competence=r.get("id_domaine_competence"),
                        domaine_titre=r.get("titre"),
                        domaine_titre_court=r.get("titre_court"),
                        domaine_couleur=r.get("couleur"),
                        niveau_requis=(r.get("niveau_requis") or None),
                        poids_criticite=int(r.get("poids_criticite") or 0),
                        nb_porteurs=0,
                        porteurs=[],
                    )
                    competences.append(item)
                    comp_map[cid] = item

                # 3) Porteurs + niveau actuel (dans le scope)
                ids_comp = [c.id_comp for c in competences if c.id_comp]
                if ids_comp:
                    cur.execute(
                        f"""
                        WITH
                        {cte_sql},
                        comp_scope AS (
                            SELECT UNNEST(%s::text[]) AS id_comp
                        )
                        SELECT
                            cs.id_comp,
                            e.id_effectif,
                            e.prenom_effectif,
                            e.nom_effectif,
                            COALESCE(o.nom_service, '') AS nom_service,
                            e.id_poste_actuel,
                            COALESCE(p.intitule_poste, '') AS intitule_poste,
                            ec.niveau_actuel
                        FROM comp_scope cs
                        JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_comp = cs.id_comp
                        JOIN effectifs_scope es
                          ON es.id_effectif = ec.id_effectif_client
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = es.id_effectif
                        LEFT JOIN public.tbl_entreprise_organigramme o
                          ON o.id_ent = e.id_ent
                         AND o.id_service = e.id_service
                         AND o.archive = FALSE
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = e.id_poste_actuel
                        WHERE
                            e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                        ORDER BY
                            cs.id_comp,
                            e.nom_effectif,
                            e.prenom_effectif
                        """,
                        tuple(cte_params + [ids_comp, id_ent]),
                    )
                    port_rows = cur.fetchall() or []

                    for r in port_rows:
                        cid = r.get("id_comp")
                        if not cid or cid not in comp_map:
                            continue
                        comp_map[cid].porteurs.append(
                            AnalysePorteurItem(
                                id_effectif=r.get("id_effectif"),
                                prenom_effectif=r.get("prenom_effectif"),
                                nom_effectif=r.get("nom_effectif"),
                                nom_service=r.get("nom_service"),
                                id_poste_actuel=r.get("id_poste_actuel"),
                                intitule_poste=r.get("intitule_poste"),
                                niveau_actuel=r.get("niveau_actuel"),
                            )
                        )

                    for c in competences:
                        c.nb_porteurs = len(c.porteurs or [])

                # 4) Stats couverture
                cov = AnalysePosteCoverage()
                cov.total_competences = len(competences)

                for c in competences:
                    nb = int(c.nb_porteurs or 0)

                    if nb >= 1:
                        cov.couvert_1plus += 1
                    else:
                        cov.non_couvert += 1

                    if nb >= 2:
                        cov.couvert_2plus += 1
                    if nb == 1:
                        cov.porteur_unique += 1

                    crit = int(c.poids_criticite or 0)
                    if crit >= int(criticite_min):
                        cov.total_critiques += 1
                        if nb >= 1:
                            cov.critiques_couvert_1plus += 1
                        else:
                            cov.critiques_non_couvert += 1
                        if nb >= 2:
                            cov.critiques_couvert_2plus += 1
                        if nb == 1:
                            cov.critiques_porteur_unique += 1

                return AnalysePosteDetailResponse(
                    scope=scope,
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    poste={
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                        "id_service": poste.get("id_service"),
                        "nom_service": poste.get("nom_service"),
                        "nb_titulaires": nb_titulaires,

                    },
                    coverage=cov,
                    competences=competences,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Endpoint: Diagnostic décisionnel (poste fragile)
# ======================================================
@router.get(
    "/skills/analyse/risques/poste/diagnostic/{id_contact}",
    response_model=AnalysePosteDiagnosticResponse,
)
def get_analyse_risques_poste_diagnostic(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=8, ge=1, le=8),
):
    """
    Diagnostic “poste fragile” (cohérent avec la table) :
    - couverture au niveau requis
    - relève (porteurs hors titulaires)
    - gap titulaires vs cible
    - exclusions : indisponibilités (break en cours)
    - contraintes : diplôme min / domaine formation si bloquant
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # 1) Poste + paramètres RH + contraintes formation
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,

                        COALESCE(fp.niveau_education_minimum, '') AS niveau_education_minimum,
                        COALESCE(fp.nsf_domaine_obligatoire, FALSE) AS nsf_domaine_obligatoire,
                        COALESCE(nd.titre, '') AS nsf_domaine_titre,

                        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste_param_rh prh
                      ON prh.id_poste = fp.id_poste
                    LEFT JOIN public.tbl_nsf_domaine nd
                      ON nd.code = fp.nsf_domaine_code
                    WHERE fp.id_poste = %s
                    LIMIT 1
                    """,
                    tuple(cte_params + [id_ent, id_poste]),
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste introuvable (ou hors périmètre service).")
                if _is_poste_statut_excluded(poste.get("statut_poste")):
                    raise HTTPException(status_code=404, detail="Poste exclu de l'analyse (gelé ou archivé).")

                edu_raw = (poste.get("niveau_education_minimum") or "").strip()
                edu_min = edu_raw if edu_raw else ""
                edu_min_rank = int(edu_raw) if edu_raw.isdigit() else 0

                dom_bloq = bool(poste.get("nsf_domaine_obligatoire") or False)
                dom_title = (poste.get("nsf_domaine_titre") or "").strip()
                nb_cible = int(poste.get("nb_titulaires_cible") or 1)

                # 1bis) Nb titulaires actuels (hors breaks en cours)
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND e.id_poste_actuel = %s
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_break b
                        WHERE b.id_effectif = e.id_effectif
                          AND b.archive = FALSE
                          AND b.date_debut <= CURRENT_DATE
                          AND b.date_fin >= CURRENT_DATE
                      )
                    """,
                    tuple(cte_params + [id_ent, id_poste]),
                )
                nb_titulaires = int((cur.fetchone() or {}).get("nb_titulaires") or 0)

                gap = max(nb_cible - nb_titulaires, 0)

                                # 1ter) Pool ressources (scope) + contraintes formation (pour “Risque de transmission”)
                cur.execute(
                    f"""
                    WITH
                    {cte_sql},
                    pool_scope AS (
                        SELECT
                          e.id_effectif,

                          CASE
                            WHEN (
                              %s <= 0
                              OR (
                                CASE
                                  WHEN COALESCE(e.niveau_education, '') ~ '^[0-9]+$' THEN e.niveau_education::int
                                  ELSE 0
                                END
                              ) >= %s
                            ) THEN TRUE ELSE FALSE
                          END AS dipl_ok,

                          CASE
                            WHEN (
                              %s = FALSE
                              OR COALESCE(e.domaine_education, '') = COALESCE(%s, '')
                            ) THEN TRUE ELSE FALSE
                          END AS dom_ok

                        FROM public.tbl_effectif_client e
                        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                        WHERE e.id_ent = %s
                          AND COALESCE(e.archive, FALSE) = FALSE
                          AND COALESCE(e.id_poste_actuel, '') <> %s
                          AND NOT EXISTS (
                            SELECT 1
                            FROM public.tbl_effectif_client_break b
                            WHERE b.id_effectif = e.id_effectif
                              AND b.archive = FALSE
                              AND b.date_debut <= CURRENT_DATE
                              AND b.date_fin >= CURRENT_DATE
                          )
                    )
                    SELECT
                      COUNT(DISTINCT id_effectif)::int AS pool_total,

                      COUNT(DISTINCT CASE
                        WHEN dipl_ok THEN id_effectif
                      END)::int AS pool_diplome_ok,

                      COUNT(DISTINCT CASE
                        WHEN dom_ok THEN id_effectif
                      END)::int AS pool_domaine_ok,

                      COUNT(DISTINCT CASE
                        WHEN dipl_ok AND dom_ok THEN id_effectif
                      END)::int AS pool_eligible,

                      COUNT(DISTINCT CASE
                        WHEN dipl_ok AND NOT dom_ok THEN id_effectif
                      END)::int AS pool_diplome_only,

                      COUNT(DISTINCT CASE
                        WHEN NOT dipl_ok AND dom_ok THEN id_effectif
                      END)::int AS pool_domaine_only,

                      COUNT(DISTINCT CASE
                        WHEN NOT dipl_ok AND NOT dom_ok THEN id_effectif
                      END)::int AS pool_neither

                    FROM pool_scope
                    """,
                    tuple(cte_params + [
                        edu_min_rank, edu_min_rank,
                        dom_bloq, dom_title,
                        id_ent,
                        id_poste,
                    ]),
                )
                pool = cur.fetchone() or {}
                pool_total = int(pool.get("pool_total") or 0)
                pool_diplome_ok = int(pool.get("pool_diplome_ok") or 0)
                pool_domaine_ok = int(pool.get("pool_domaine_ok") or 0)
                pool_eligible = int(pool.get("pool_eligible") or 0)

                pool_diplome_only = int(pool.get("pool_diplome_only") or 0)
                pool_domaine_only = int(pool.get("pool_domaine_only") or 0)
                pool_neither = int(pool.get("pool_neither") or 0)


                # 2) Agrégats par compétence (au niveau requis), avec contraintes + breaks
                # IMPORTANT psycopg : tout % littéral doit être doublé (%%) sinon “%x placeholder”
                cur.execute(
                    f"""
                    WITH
                    {cte_sql},
                    req AS (
                        SELECT DISTINCT
                            c.id_comp,
                            c.code,
                            c.intitule,
                            COALESCE(fpc.niveau_requis, '') AS niveau_requis,
                            COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
                        FROM public.tbl_fiche_poste_competence fpc
                        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                        JOIN public.tbl_competence c
                          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                        WHERE fpc.id_poste = %s
                          AND c.etat = 'active'
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
                        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                        WHERE e.id_ent = %s
                          AND COALESCE(e.archive, FALSE) = FALSE
                          AND NOT EXISTS (
                            SELECT 1
                            FROM public.tbl_effectif_client_break b
                            WHERE b.id_effectif = e.id_effectif
                              AND b.archive = FALSE
                              AND b.date_debut <= CURRENT_DATE
                              AND b.date_fin >= CURRENT_DATE
                          )
                    ),
                    ec_raw AS (
                        SELECT
                            r.id_comp,
                            r.code,
                            r.intitule,
                            r.poids_criticite,
                            r.niveau_requis,
                            ef.id_effectif,
                            ef.id_poste_actuel,

                            CASE
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'A' THEN 1
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'B' THEN 2
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN ec.niveau_actuel ILIKE '%%init%%' OR ec.niveau_actuel ILIKE '%%début%%' OR ec.niveau_actuel ILIKE '%%debut%%' THEN 1
                              WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2
                              WHEN ec.niveau_actuel ILIKE '%%avan%%' THEN 3
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                              WHEN TRIM(ec.niveau_actuel) ~ '^[0-9]+$' THEN ec.niveau_actuel::int
                              ELSE 0
                            END AS act_rank,

                            CASE
                              WHEN a.resultat_eval IS NOT NULL
                               AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL)
                              THEN TRUE
                              ELSE FALSE
                            END AS is_evaluee,

                            CASE
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'A' THEN 1
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'B' THEN 2
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'D' THEN 4
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'C' THEN 3
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'D' THEN 4
                              ELSE 0
                            END AS req_rank,

                            CASE
                              WHEN (
                                (
                                  %s <= 0
                                  OR (
                                    CASE
                                      WHEN COALESCE(ef.niveau_education, '') ~ '^[0-9]+$' THEN ef.niveau_education::int
                                      ELSE 0
                                    END
                                  ) >= %s
                                )
                                AND (
                                  %s = FALSE
                                  OR COALESCE(ef.domaine_education, '') = COALESCE(%s, '')
                                )
                              ) THEN TRUE
                              ELSE FALSE
                            END AS is_eligible
                        FROM req r
                        JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_comp = r.id_comp
                        LEFT JOIN public.tbl_effectif_client_audit_competence a
                          ON a.id_audit_competence = ec.id_dernier_audit
                         AND a.id_effectif_competence = ec.id_effectif_competence
                        JOIN pool_all_effectifs ef
                          ON ef.id_effectif = ec.id_effectif_client
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
                    ),
                    comp_agg AS (
                        SELECT
                            r.id_comp,
                            r.code,
                            r.intitule,
                            r.poids_criticite,
                            r.niveau_requis,

                            COUNT(DISTINCT CASE WHEN eok.id_poste_actuel = %s THEN eok.id_effectif END)::int AS nb_tit_any,
                            COUNT(DISTINCT CASE WHEN eok.is_ok THEN eok.id_effectif END)::int AS nb_ok_all,
                            COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible THEN eok.id_effectif END)::int AS nb_ok,

                            COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.id_poste_actuel = %s THEN eok.id_effectif END)::int AS nb_ok_titulaires_all,
                            COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible AND eok.id_poste_actuel = %s THEN eok.id_effectif END)::int AS nb_ok_titulaires
                        FROM req r
                        LEFT JOIN ec_ok eok ON eok.id_comp = r.id_comp
                        GROUP BY r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis
                    )
                    SELECT * FROM comp_agg
                    """,
                    tuple(cte_params + [
                        id_poste,
                        int(criticite_min),
                        id_ent,
                        edu_min_rank, edu_min_rank,
                        dom_bloq, dom_title,
                        id_poste,
                        id_poste,
                        id_poste,
                    ]),
                )

                rows = cur.fetchall() or []

                nb0 = 0
                nb1 = 0
                nb_r0 = 0
                nb_r1 = 0
                efficiency_missing_units = 0
                efficiency_points = 0
                dependance_points = 0

                candidates: list[AnalysePosteTopRisqueItem] = []
                dep_items: list[AnalysePosteDependanceItem] = []
                eff_items: list[AnalysePosteEfficaciteItem] = []

                besoin_local = max(min(int(nb_titulaires or 0), int(nb_cible or 1)), 0)

                for r in rows:
                    n_tit_any = int(r.get("nb_tit_any") or 0)
                    n_ok = int(r.get("nb_ok") or 0)
                    n_ok_tit = int(r.get("nb_ok_titulaires") or 0)
                    n_relais = max(n_ok - n_ok_tit, 0)

                    missing_validated = 0
                    declared_but_not_validated = 0
                    total_missing = 0
                    if besoin_local > 0:
                        total_missing = max(besoin_local - n_ok_tit, 0)
                        missing_validated = total_missing
                        declared_but_not_validated = max(min(n_tit_any, besoin_local) - n_ok_tit, 0)

                    if total_missing > 0:
                        nb0 += 1
                        candidates.append(
                            AnalysePosteTopRisqueItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                type_risque="NON_COUVERTE",
                                nb_porteurs=n_ok_tit,
                                nb_ok=n_ok_tit,
                                recommandation="former",
                            )
                        )

                    if missing_validated > 0:
                        # Un écart de compétence relève du risque d’efficacité, pas du risque structurel.
                        efficiency_missing_units += missing_validated
                        efficiency_points += missing_validated * _score_efficacite_unit(r.get("poids_criticite"))

                    if total_missing > 0:
                        eff_items.append(
                            AnalysePosteEfficaciteItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                niveau_requis=r.get("niveau_requis"),
                                nb_en_defaut=total_missing,
                                nb_titulaires=int(besoin_local),
                            )
                        )
                    if besoin_local == 1 and n_ok_tit == 1:
                        nb1 += 1
                        nb_r0 += 1
                        dependance_points += _score_dependance_unit(r.get("poids_criticite"), relais_faible=True)
                        dep_items.append(
                            AnalysePosteDependanceItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                niveau_requis=r.get("niveau_requis"),
                                nb_porteurs_ok=1,
                                seuil_couverture=2,
                                type_risque="PORTEUR_UNIQUE",
                            )
                        )
                        candidates.append(
                            AnalysePosteTopRisqueItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                type_risque="PORTEUR_UNIQUE",
                                nb_porteurs=1,
                                nb_ok=1,
                                recommandation="mutualiser",
                            )
                        )

                nb_total_fragiles = nb0 + nb1 + nb_r0 + nb_r1
                nb_evenements = nb_total_fragiles + (1 if gap > 0 else 0)

                structure_score = _score_structure_gap(gap)
                efficacite_score = min(45, efficiency_points)
                dependance_score = min(25, dependance_points)
                transmission_score = _score_transmission(pool_total, pool_eligible)

                if nb_titulaires <= 0 and int(nb_cible or 1) >= 1:
                    structure_score = 100
                    efficacite_score = 0
                    dependance_score = 0
                    transmission_score = 0
                    base_score = 100
                    score = 100
                else:
                    base_score = structure_score + efficacite_score + dependance_score
                    score = min(95, base_score + (transmission_score if base_score > 0 else 0))

                order = {"NON_COUVERTE": 0, "SANS_RELEVE": 1, "RELEVE_FAIBLE": 2}
                candidates.sort(
                    key=lambda c: (
                        order.get(c.type_risque or "OK", 9),
                        -(int(c.poids_criticite or 0)),
                        str(c.code_comp or ""),
                    )
                )
                top_risques = candidates[: int(limit or 8)]

                dep_items.sort(key=lambda x: (int(x.nb_porteurs_ok or 0), -(int(x.poids_criticite or 0)), str(x.code_comp or "")))
                dep_items = dep_items[:12]

                eff_items.sort(key=lambda x: (-(int(x.nb_en_defaut or 0)), -(int(x.poids_criticite or 0)), str(x.code_comp or "")))
                eff_items = eff_items[:12]

                structure = None
                if nb_titulaires <= 0 or gap > 0:
                    structure = AnalysePosteCauseStructurelle(
                        nb_titulaires=int(nb_titulaires),
                        nb_titulaires_cible=int(nb_cible or 1),
                        gap_titulaires=int(gap),
                        poste_non_tenu=(nb_titulaires <= 0),
                    )

                raisons = []
                nb_pot = max(pool_total - pool_eligible, 0)

                if nb_pot > 0:
                    if edu_min_rank > 0 and dom_bloq:
                        if pool_eligible <= 0:
                            if pool_diplome_ok <= 0:
                                raisons.append("Aucune ressource ne possède le niveau de diplôme requis.")
                            if pool_domaine_ok <= 0:
                                raisons.append("Aucune ressource n'a suivi la formation initiale requise.")
                            if pool_diplome_ok > 0 and pool_domaine_ok > 0:
                                raisons.append("Aucune ressource ne cumule le niveau de diplôme et la formation initiale requis.")

                        if pool_diplome_only > 0:
                            raisons.append(f"{pool_diplome_only} ressource(s) possèdent le niveau de diplôme requis mais pas la formation initiale attendue.")
                        if pool_domaine_only > 0:
                            raisons.append(f"{pool_domaine_only} ressource(s) possèdent la formation initiale attendue mais pas le niveau de diplôme requis.")
                        if pool_neither > 0:
                            raisons.append(f"{pool_neither} ressource(s) ne respectent ni le niveau de diplôme ni la formation initiale attendus.")

                    elif edu_min_rank > 0:
                        if pool_diplome_ok <= 0:
                            raisons.append("Aucune ressource ne possède le niveau de diplôme requis.")
                        elif pool_diplome_ok < pool_total:
                            raisons.append(f"{pool_total - pool_diplome_ok} ressource(s) potentielles n'atteignent pas le niveau de diplôme requis.")

                    elif dom_bloq:
                        if pool_domaine_ok <= 0:
                            raisons.append("Aucune ressource n'a suivi la formation initiale requise.")
                        elif pool_domaine_ok < pool_total:
                            raisons.append(f"{pool_total - pool_domaine_ok} ressource(s) potentielles ne disposent pas de la formation initiale requise.")

                transmission = None
                if raisons or nb_pot > 0:
                    transmission = AnalysePosteTransmissionCause(
                        raisons=raisons,
                        nb_ressources_potentielles=int(nb_pot),
                        pool_total=int(pool_total),
                        pool_eligible=int(pool_eligible),
                        pool_diplome_ok=int(pool_diplome_ok),
                        pool_domaine_ok=int(pool_domaine_ok),
                    )
                # Alignement avec le moteur unique de fragilité poste utilisé par le tableau, le dashboard et les projections.
                poste_frag_record = None
                try:
                    _poste_records = _fetch_postes_fragility_records(cur, id_ent, scope.id_service, int(criticite_min))
                    for _r in _poste_records:
                        if str(_r.get("id_poste") or "") == str(id_poste):
                            poste_frag_record = _r
                            break
                except Exception:
                    poste_frag_record = None

                sorties_cause = None
                try:
                    sorties_cause = _analyse_poste_sorties_approchantes_cause(cur, id_ent, scope.id_service, id_poste)
                except Exception:
                    sorties_cause = None

                eff_items_salaries = []
                try:
                    eff_items_salaries = _analyse_poste_titulaires_mastery_items(cur, id_ent, scope.id_service, id_poste, int(criticite_min))
                except Exception:
                    eff_items_salaries = []
                if eff_items_salaries:
                    eff_items = eff_items_salaries[:12]

                if poste_frag_record:
                    nb_titulaires = int(poste_frag_record.get("nb_titulaires") or 0)
                    nb_cible = int(poste_frag_record.get("nb_titulaires_cible") or 1)
                    gap = int(poste_frag_record.get("gap_titulaires") or 0)
                    structure_score = int(poste_frag_record.get("score_structurel") or 0)
                    efficacite_score = int(poste_frag_record.get("score_efficacite") or 0)
                    dependance_score = int(poste_frag_record.get("score_dependance") or 0)
                    transmission_score = int(poste_frag_record.get("score_renfort_potentiel") or poste_frag_record.get("score_transmission") or 0)
                    score_sorties_approchantes = int(poste_frag_record.get("score_sorties_approchantes") or 0)
                    score = int(poste_frag_record.get("indice_fragilite") or 0)

                    structure = None
                    if nb_titulaires <= 0 or gap > 0 or int(poste_frag_record.get("nb_indisponibles") or 0) > 0:
                        structure = AnalysePosteCauseStructurelle(
                            nb_titulaires=nb_titulaires,
                            nb_titulaires_cible=nb_cible,
                            gap_titulaires=gap,
                            poste_non_tenu=(nb_titulaires <= 0),
                            nb_titulaires_rattaches=int(poste_frag_record.get("nb_titulaires_rattaches") or nb_titulaires),
                            nb_titulaires_disponibles=nb_titulaires,
                            nb_indisponibles=int(poste_frag_record.get("nb_indisponibles") or 0),
                        )

                    transmission = AnalysePosteTransmissionCause(
                        raisons=[],
                        nb_ressources_potentielles=int(poste_frag_record.get("nb_renforts_immediats") or 0) + int(poste_frag_record.get("nb_renforts_a_preparer") or 0),
                        pool_total=int(poste_frag_record.get("pool_total") or 0),
                        pool_eligible=int(poste_frag_record.get("pool_eligible") or 0),
                        nb_renforts_immediats=int(poste_frag_record.get("nb_renforts_immediats") or 0),
                        nb_renforts_a_preparer=int(poste_frag_record.get("nb_renforts_a_preparer") or 0),
                        meilleur_matching=int(poste_frag_record.get("meilleur_matching") or 0),
                    )
                    if int(transmission.nb_renforts_immediats or 0) > 0:
                        transmission = None

                causes = AnalysePosteCausesRacines(
                    structure=structure,
                    dependance=dep_items,
                    transmission=transmission,
                    efficacite=eff_items,
                    sorties_approchantes=sorties_cause,
                )

                cond = AnalysePosteDiagnosticConditions(
                    diplome_min=(f"Niveau {edu_min}" if edu_min_rank > 0 else None),
                    domaine_formation=(dom_title or None),
                    domaine_bloquant=dom_bloq,
                    releve_phrase="Relève prise en compte : collaborateurs mobilisables immédiatement.",
                )

                comp = AnalysePosteFragiliteComposantes(
                    nb0=nb0,
                    nb1=nb1,
                    nb_total_fragiles=nb_total_fragiles,
                    criticite_min=int(criticite_min),

                    nb_sans_releve=nb_r0,
                    nb_releve_faible=nb_r1,
                    gap_titulaires=gap,
                    nb_evenements=nb_evenements,

                    nb_titulaires=nb_titulaires,
                    nb_titulaires_cible=nb_cible,
                    nb_titulaires_rattaches=int((poste_frag_record or {}).get('nb_titulaires_rattaches') or nb_titulaires),
                    nb_indisponibles=int((poste_frag_record or {}).get('nb_indisponibles') or 0),
                    nb_sorties_approchantes=int((poste_frag_record or {}).get('nb_sorties_approchantes') or 0),

                    score_structurel=int(structure_score),
                    score_efficacite=int(efficacite_score),
                    score_dependance=int(dependance_score),
                    score_transmission=int(transmission_score),
                    score_sorties_approchantes=int(locals().get('score_sorties_approchantes', 0)),
                    score_renfort_potentiel=int(transmission_score),
                    score_total=int(score),
                )

                return AnalysePosteDiagnosticResponse(
                    scope=scope,
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    poste={
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                        "id_service": poste.get("id_service"),
                        "nom_service": poste.get("nom_service"),
                        "nb_titulaires": nb_titulaires,
                        "nb_titulaires_cible": nb_cible,
                        "nb_titulaires_necessaires": nb_cible,
                    },
                    indice_fragilite=score,
                    composantes=comp,
                    top_risques=top_risques,
                    causes=causes,
                    conditions=cond,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


def _analyse_poste_pdf_state_label(score: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    if s >= 75:
        return "Critique"
    if s >= 50:
        return "Élevé"
    if s >= 25:
        return "Modéré"
    return "Faible"


def _analyse_poste_pdf_card(title: str, value: str, subtitle: str = "", width_mm: float = 58.0, height_mm: float = 24.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=5, ry=5, strokeColor=colors.HexColor("#dbe4ef"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(4 * mm, height_mm * mm - 6 * mm, str(title or ""), fontName="Helvetica-Bold", fontSize=7.2, fillColor=colors.HexColor("#64748b")))
    d.add(String(4 * mm, height_mm * mm - 14 * mm, str(value or "—"), fontName="Helvetica-Bold", fontSize=13, fillColor=colors.HexColor("#0f172a")))
    if subtitle:
        d.add(String(4 * mm, 4 * mm, _analyse_pdf_short(subtitle, 36), fontName="Helvetica", fontSize=6.6, fillColor=colors.HexColor("#94a3b8")))
    return d


def _analyse_poste_pdf_components_table(diag: Any, styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body = styles.get("small") or styles.get("body")
    head = styles.get("meta_label") or body

    def p(v: Any, st=None):
        return Paragraph(_analyse_pdf_esc(v), st or body)

    comp = getattr(diag, "composantes", None)
    rows = [[p("Lecture", head), p("Score", head), p("Ce que cela signifie", head)]]
    data = [
        ("Structure", getattr(comp, "score_structurel", 0), "Titulaire(s) présents par rapport au besoin attendu."),
        ("Efficacité", getattr(comp, "score_efficacite", 0), "Compétences attendues insuffisamment couvertes ou non confirmées."),
        ("Dépendance", getattr(comp, "score_dependance", 0), "Relais interne limité ou compétence portée par trop peu de personnes."),
        ("Transmission", getattr(comp, "score_transmission", 0), "Capacité de remplacement ou de montée en compétence disponible."),
    ]
    for label, score, desc in data:
        rows.append([p(label), p(f"{_analyse_pdf_safe_int(score)}"), p(desc)])

    table = Table(rows, colWidths=[42 * mm, 24 * mm, 156 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _analyse_poste_pdf_risks_table(diag: Any, styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body = styles.get("small") or styles.get("body")
    head = styles.get("meta_label") or body

    def p(v: Any, st=None):
        return Paragraph(_analyse_pdf_esc(v), st or body)

    rows = [[p("Code", head), p("Compétence", head), p("Criticité", head), p("Porteurs", head), p("Au niveau", head), p("Point à sécuriser", head)]]
    items = list(getattr(diag, "top_risques", None) or [])[:12]
    if not items:
        rows.append([p("—"), p("Aucun point de fragilité prioritaire détecté."), p("—"), p("—"), p("—"), p("—")])
    for it in items:
        kind = str(getattr(it, "type_risque", "") or "")
        if kind == "NON_COUVERTE":
            reco = "Compétence non couverte"
        elif kind == "COUV_UNIQUE":
            reco = "Couverture dépendante"
        elif kind == "FRAGILE":
            reco = "Niveau ou couverture à renforcer"
        else:
            reco = getattr(it, "recommandation", None) or "À vérifier"
        rows.append([
            p(getattr(it, "code_comp", None) or "—"),
            p(getattr(it, "intitule", None) or "—"),
            p(getattr(it, "poids_criticite", None) if getattr(it, "poids_criticite", None) is not None else "—"),
            p(str(getattr(it, "nb_porteurs", 0))),
            p(str(getattr(it, "nb_ok", 0))),
            p(reco),
        ])

    table = Table(rows, colWidths=[24 * mm, 82 * mm, 24 * mm, 24 * mm, 26 * mm, 42 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


@router.get("/skills/analyse/risques/poste/pdf/{id_contact}")
def get_analyse_risques_poste_pdf(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        import re
        from fastapi import Response
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        poste_id = (id_poste or "").strip()
        if not poste_id:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        diag = get_analyse_risques_poste_diagnostic(
            id_contact=id_contact,
            request=request,
            id_poste=poste_id,
            id_service=id_service,
            criticite_min=criticite_min,
            limit=8,
        )

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        styles = build_pdf_styles()
        poste = getattr(diag, "poste", {}) or {}
        scope = getattr(diag, "scope", None)
        comp = getattr(diag, "composantes", None)
        score = _analyse_pdf_safe_int(getattr(diag, "indice_fragilite", 0))
        etat = _analyse_poste_pdf_state_label(score)
        code = (poste.get("codif_client") or poste.get("codif_poste") or "").strip()
        title = (poste.get("intitule_poste") or "Poste").strip()
        service = (getattr(scope, "nom_service", None) or poste.get("nom_service") or "Tous les services")
        today = datetime.now().strftime("%d/%m/%Y")
        nb_tit = _analyse_pdf_safe_int(getattr(comp, "nb_titulaires", poste.get("nb_titulaires", 0)))
        nb_cible = _analyse_pdf_safe_int(getattr(comp, "nb_titulaires_cible", poste.get("nb_titulaires_cible", 1))) or 1

        story = []
        story.append(Paragraph("Analyse de fragilité du poste", styles["title"]))
        story.append(Paragraph(f"{_analyse_pdf_esc(code)} • {_analyse_pdf_esc(title)}", styles["section"]))
        story.append(Paragraph(f"Périmètre analysé : {_analyse_pdf_esc(service)} • Date : {today} • Criticité minimale : {int(criticite_min)}", styles["subtitle"]))
        story.append(make_spacer(3))

        cards = Table([[
            _analyse_poste_pdf_card("Indice de fragilité", f"{score}%", "Score actuel"),
            _analyse_poste_pdf_card("État", etat, "Lecture du risque"),
            _analyse_poste_pdf_card("Titulaires", str(nb_tit), "Personnes rattachées"),
            _analyse_poste_pdf_card("Cible RH", str(nb_cible), "Besoin attendu"),
        ]], colWidths=[58 * mm, 58 * mm, 58 * mm, 58 * mm])
        cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(cards)
        story.append(make_spacer(6))

        story.append(Paragraph("Lecture des composantes", styles["section"]))
        story.append(_analyse_poste_pdf_components_table(diag, styles))
        story.append(make_spacer(6))

        story.append(Paragraph("Points à sécuriser", styles["section"]))
        story.append(_analyse_poste_pdf_risks_table(diag, styles))

        pdf = build_pdf_document(story, {
            "title": f"Analyse de fragilité - {title}",
            "footer_left": "Novoskill Insights • Analyse de fragilité du poste",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))

        safe_code = re.sub(r"[^A-Za-z0-9_-]+", "_", code or poste_id).strip("_") or "poste"
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="analyse_fragilite_{safe_code}.pdf"', "Cache-Control": "no-store"},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF analyse poste : {e}")

def _analyse_comp_pdf_state_label(score: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    if s >= 75:
        return "Critique"
    if s >= 50:
        return "Élevé"
    if s >= 25:
        return "Modéré"
    return "Faible"


def _analyse_comp_pdf_causes_table(detail: Dict[str, Any], styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body = styles.get("small") or styles.get("body")
    head = styles.get("meta_label") or body

    def p(v: Any, st=None):
        return Paragraph(_analyse_pdf_esc(v), st or body)

    rows = [[p("Cause", head), p("Volume", head), p("Lecture utilisateur", head), p("Action à envisager", head)]]
    causes = list((detail or {}).get("causes") or [])
    useful = [c for c in causes if _analyse_pdf_safe_int(c.get("count")) > 0]
    if not useful:
        rows.append([p("—"), p("—"), p("Aucun point de fragilité prioritaire détecté."), p("Surveiller selon l’évolution du périmètre.")])
    for c in useful[:10]:
        rows.append([
            p(c.get("titre") or "Point à sécuriser"),
            p(str(_analyse_pdf_safe_int(c.get("count")))),
            p(c.get("lecture") or "À vérifier dans le détail."),
            p(c.get("action") or "Analyser avec le manager."),
        ])

    table = Table(rows, colWidths=[42 * mm, 22 * mm, 96 * mm, 70 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _analyse_comp_pdf_postes_table(detail: Dict[str, Any], styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body = styles.get("small") or styles.get("body")
    head = styles.get("meta_label") or body

    def p(v: Any, st=None):
        return Paragraph(_analyse_pdf_esc(v), st or body)

    rows = [[p("Code", head), p("Poste concerné", head), p("Service", head), p("Criticité", head), p("État de couverture", head), p("Action RH", head)]]
    postes = list((detail or {}).get("postes") or [])
    if not postes:
        rows.append([p("—"), p("Aucun poste concerné dans le périmètre."), p("—"), p("—"), p("—"), p("—")])
    for r in postes[:14]:
        rows.append([
            p(r.get("codif_client") or r.get("codif_poste") or "—"),
            p(r.get("intitule_poste") or "—"),
            p(r.get("nom_service") or "—"),
            p(r.get("poids_criticite") if r.get("poids_criticite") is not None else "—"),
            p(r.get("etat_couverture_label") or "À vérifier"),
            p(r.get("action_rh") or "Analyser"),
        ])

    table = Table(rows, colWidths=[22 * mm, 62 * mm, 42 * mm, 22 * mm, 46 * mm, 38 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _analyse_comp_pdf_porteurs_table(detail: Dict[str, Any], styles: Dict[str, Any]):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle

    body = styles.get("small") or styles.get("body")
    head = styles.get("meta_label") or body

    def p(v: Any, st=None):
        return Paragraph(_analyse_pdf_esc(v), st or body)

    rows = [[p("Collaborateur", head), p("Poste actuel", head), p("Service", head), p("Niveau", head), p("Statut", head)]]
    porteurs = list((detail or {}).get("porteurs") or [])
    if not porteurs:
        rows.append([p("—"), p("Aucun porteur déclaré dans le périmètre."), p("—"), p("—"), p("—")])
    for r in porteurs[:14]:
        full = f"{str(r.get('prenom_effectif') or '').strip()} {str(r.get('nom_effectif') or '').strip()}".strip() or "—"
        poste = f"{str(r.get('codif_poste') or '').strip()} {str(r.get('intitule_poste') or '').strip()}".strip() or "—"
        rows.append([
            p(full),
            p(poste),
            p(r.get("nom_service") or "—"),
            p(r.get("niveau_actuel") or "—"),
            p(r.get("statut_rh_label") or ("Indisponible" if r.get("is_indispo") else "À vérifier")),
        ])

    table = Table(rows, colWidths=[54 * mm, 70 * mm, 50 * mm, 28 * mm, 30 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


@router.get("/skills/analyse/competences/fiche_pdf/{id_contact}/{id_comp}")
def get_analyse_competence_fiche_pdf(
    id_contact: str,
    id_comp: str,
    request: Request,
):
    """
    PDF fiche compétence depuis Insights / Analyse.
    Le rendu est strictement celui du builder commun, pas un PDF d'analyse de fragilité.
    """
    try:
        from fastapi import Response
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_competence_pdf_story

        comp_id = (id_comp or "").strip()
        if not comp_id:
            raise HTTPException(status_code=400, detail="Compétence introuvable.")

        def _safe_pdf_part(value: Any, max_len: int = 80) -> str:
            raw = str(value or "").strip() or "competence"
            raw = re.sub(r"[^A-Za-z0-9À-ÖØ-öø-ÿ _.-]+", "_", raw)
            raw = re.sub(r"\s+", " ", raw).strip(" ._-")
            return (raw[:max_len].strip(" ._-") or "competence")

        def _latin1_safe(value: Any) -> str:
            return str(value or "").encode("latin-1", "replace").decode("latin-1")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                header_right = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

                cur.execute(
                    """
                    WITH visible AS (
                        SELECT fpc.id_competence AS id_comp
                        FROM public.tbl_fiche_poste_competence fpc
                        JOIN public.tbl_fiche_poste fp
                          ON fp.id_poste = fpc.id_poste
                        WHERE fp.id_ent = %s
                          AND COALESCE(fp.actif, TRUE) = TRUE
                          AND COALESCE(fpc.masque, FALSE) = FALSE

                        UNION

                        SELECT ecc.id_comp AS id_comp
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN public.tbl_effectif_client ec
                          ON ec.id_effectif = ecc.id_effectif_client
                        WHERE ec.id_ent = %s
                          AND COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.statut_actif, TRUE) = TRUE
                          AND COALESCE(ecc.actif, TRUE) = TRUE
                          AND COALESCE(ecc.archive, FALSE) = FALSE

                        UNION

                        SELECT c_owner.id_comp AS id_comp
                        FROM public.tbl_competence c_owner
                        WHERE c_owner.id_owner = %s
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.description,
                        c.domaine,
                        c.niveaua,
                        c.niveaub,
                        c.niveauc,
                        c.niveaud,
                        c.grille_evaluation,
                        dc.titre_court AS domaine_titre_court,
                        dc.titre AS domaine_titre
                    FROM public.tbl_competence c
                    JOIN visible v ON v.id_comp = c.id_comp
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE c.id_comp = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    LIMIT 1
                    """,
                    (id_ent, id_ent, id_ent, comp_id),
                )
                row = cur.fetchone() or {}
                if not row:
                    raise HTTPException(status_code=404, detail="Compétence introuvable dans le référentiel accessible.")

        skill = {
            "id_comp": row.get("id_comp"),
            "code": (row.get("code") or "").strip(),
            "intitule": (row.get("intitule") or "").strip(),
            "description": row.get("description") or "",
            "niveaua": row.get("niveaua") or "",
            "niveaub": row.get("niveaub") or "",
            "niveauc": row.get("niveauc") or "",
            "niveaud": row.get("niveaud") or "",
            "grille_evaluation": row.get("grille_evaluation"),
            "domaine": row.get("domaine") or "",
            "domaine_titre": (
                (row.get("domaine_titre_court") or "").strip()
                or (row.get("domaine_titre") or "").strip()
            ),
        }

        code_label = skill.get("code") or "Compétence"
        intitule_label = skill.get("intitule") or "Compétence"
        filename = _latin1_safe(f"Fiche compétence {_safe_pdf_part(code_label, 32)} - {_safe_pdf_part(intitule_label, 80)}.pdf")

        pdf_bytes = build_pdf_document(
            build_competence_pdf_story(skill),
            meta={
                "title": _latin1_safe(f"Fiche compétence - {code_label} - {intitule_label}"),
                "doc_label": _latin1_safe("Fiche compétence"),
                "footer_left": _latin1_safe("Novoskill Insights • Fiche compétence"),
                "header_right": _latin1_safe(header_right),
                "logo_bytes": logo_bytes,
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 10.5,
            },
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération fiche compétence : {e}")

@router.get("/skills/analyse/risques/competence/pdf/{id_contact}")
def get_analyse_risques_competence_pdf(
    id_contact: str,
    request: Request,
    id_comp: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        import re
        from fastapi import Response
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        comp_key = (id_comp or "").strip()
        if not comp_key:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        detail = get_risque_competence_detail(
            id_contact=id_contact,
            request=request,
            id_comp=comp_key,
            id_service=id_service,
            criticite_min=criticite_min,
            limit_postes=200,
            limit_porteurs=300,
        )

        if not isinstance(detail, dict):
            raise HTTPException(status_code=500, detail="Réponse détail compétence inexploitable.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        styles = build_pdf_styles()
        comp = detail.get("competence") or {}
        stats = detail.get("stats") or {}
        domaine = comp.get("domaine") or {}
        scope = detail.get("scope") or {}

        score = _analyse_pdf_safe_int(stats.get("indice_fragilite"))
        etat = _analyse_comp_pdf_state_label(score)
        code = str(comp.get("code") or comp_key or "").strip()
        title = str(comp.get("intitule") or "Compétence").strip()
        service = str(scope.get("nom_service") or "Tous les services").strip()
        domaine_label = str(domaine.get("titre_court") or domaine.get("titre") or "—").strip()
        today = datetime.now().strftime("%d/%m/%Y")

        besoin = _analyse_pdf_safe_int(stats.get("besoin_total")) or 1
        porteurs = _analyse_pdf_safe_int(stats.get("nb_porteurs"))
        porteurs_dispo = _analyse_pdf_safe_int(stats.get("nb_porteurs_dispo"))
        nb_postes = _analyse_pdf_safe_int(stats.get("nb_postes_impactes"))

        story = []
        story.append(Paragraph("Analyse de fragilité de la compétence", styles["title"]))
        story.append(Paragraph(f"{_analyse_pdf_esc(code)} • {_analyse_pdf_esc(title)}", styles["section"]))
        story.append(Paragraph(f"Périmètre analysé : {_analyse_pdf_esc(service)} • Date : {today} • Criticité minimale : {int(criticite_min)} • Domaine : {_analyse_pdf_esc(domaine_label)}", styles["subtitle"]))
        story.append(make_spacer(3))

        cards = Table([[
            _analyse_poste_pdf_card("Indice de fragilité", f"{score}%", "Score actuel", 44, 24),
            _analyse_poste_pdf_card("État", etat, "Lecture du risque", 44, 24),
            _analyse_poste_pdf_card("Présence", f"{porteurs}/{besoin}", "Porteurs / besoin", 44, 24),
            _analyse_poste_pdf_card("Disponibles", str(porteurs_dispo), "Porteurs confirmés", 44, 24),
            _analyse_poste_pdf_card("Postes", str(nb_postes), "Postes concernés", 44, 24),
        ]], colWidths=[46 * mm, 46 * mm, 46 * mm, 46 * mm, 46 * mm])
        cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(cards)
        story.append(make_spacer(6))

        story.append(Paragraph("Points de fragilité", styles["section"]))
        story.append(_analyse_comp_pdf_causes_table(detail, styles))
        story.append(make_spacer(6))

        story.append(Paragraph("Postes concernés", styles["section"]))
        story.append(_analyse_comp_pdf_postes_table(detail, styles))
        story.append(make_spacer(6))

        story.append(Paragraph("Porteurs identifiés", styles["section"]))
        story.append(_analyse_comp_pdf_porteurs_table(detail, styles))

        pdf = build_pdf_document(story, {
            "title": f"Analyse de fragilité - {title}",
            "footer_left": "Novoskill Insights • Analyse de fragilité de la compétence",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))

        safe_code = re.sub(r"[^A-Za-z0-9_-]+", "_", code or comp_key).strip("_") or "competence"
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="analyse_fragilite_competence_{safe_code}.pdf"', "Cache-Control": "no-store"},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF analyse compétence : {e}")

# ======================================================
# Endpoint: Matching poste-porteur
# - Renvoie titulaire(s) + top candidats internes (un seul payload)
# ======================================================

@router.get(
    "/skills/analyse/matching/poste/{id_contact}",
    response_model=AnalyseMatchingPosteResponse,
)
def get_analyse_matching_poste(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit: int = Query(default=300, ge=1, le=2000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # --- id_ent depuis contact
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, id_service)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # 1) Poste (sécurisation: doit être dans postes_scope)
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        fp.id_poste, fp.codif_poste, fp.codif_client, fp.intitule_poste, fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM public.tbl_fiche_poste fp
                    JOIN postes_scope ps ON ps.id_poste = fp.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    WHERE fp.id_poste = %s
                    LIMIT 1
                    """,
                    tuple(cte_params + [id_ent, id_poste]),
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste introuvable (ou hors périmètre service).")

                # 2) Compétences requises + poids
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        fpc.id_competence AS id_comp,
                        fpc.niveau_requis,
                        COALESCE(fpc.poids_criticite, 1)::int AS poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    WHERE fpc.id_poste = %s
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                    """,
                    tuple(cte_params + [id_poste]),
                )
                req_rows = cur.fetchall() or []
                reqs: List[Dict[str, Any]] = []
                for r in req_rows:
                    cid = (r.get("id_comp") or "").strip()
                    if not cid:
                        continue
                    lvl = (r.get("niveau_requis") or "").strip().upper()
                    w = int(r.get("poids_criticite") or 1)
                    if w <= 0:
                        w = 1
                    reqs.append({"id_comp": cid, "niveau_requis": lvl, "poids": w})

                # Poste sans compétences => matching vide, mais on répond proprement
                if not reqs:
                    return AnalyseMatchingPosteResponse(
                        poste={
                            "id_poste": poste.get("id_poste"),
                            "codif_poste": poste.get("codif_poste"),
                            "codif_client": poste.get("codif_client"),
                            "intitule_poste": poste.get("intitule_poste"),
                        },
                        scope=scope,
                        criticite_min=int(criticite_min),
                        updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        items=[],
                    )

                comp_ids = [x["id_comp"] for x in reqs]

                # 3) Effectifs scope + identité
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        e.id_effectif,
                        e.prenom_effectif,
                        e.nom_effectif,
                        e.id_poste_actuel,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = e.id_service
                     AND o.archive = FALSE
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                    ORDER BY e.nom_effectif, e.prenom_effectif
                    """,
                    tuple(cte_params + [id_ent, id_ent]),
                )
                eff_rows = cur.fetchall() or []

                # 4) Derniers scores (/24) sur les compétences requises
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        ec.id_effectif_client AS id_effectif,
                        ec.id_comp,
                        ac.resultat_eval
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_effectif_client_audit_competence ac
                      ON ac.id_audit_competence = ec.id_dernier_audit
                    WHERE ec.actif = TRUE
                      AND ec.archive = FALSE
                      AND ec.id_comp = ANY(%s)
                    """,
                    tuple(cte_params + [comp_ids]),
                )
                score_rows = cur.fetchall() or []

                # scores_map[id_effectif][id_comp] = Optional[float]
                scores_map: Dict[str, Dict[str, Optional[float]]] = {}
                for r in score_rows:
                    ide = (r.get("id_effectif") or "").strip()
                    cid = (r.get("id_comp") or "").strip()
                    if not ide or not cid:
                        continue
                    scores_map.setdefault(ide, {})[cid] = _safe_float(r.get("resultat_eval"))

                # Pré-calcul poids total
                poids_total = sum(int(x.get("poids") or 1) for x in reqs) or 1
                # Le matching se calcule sur toutes les compétences du poste.
                # La criticité reste une information métier, mais le filtre global ne pilote pas ce résultat.
                crit_min = CRITICITE_MIN_DEFAULT

                items: List[AnalyseMatchingItem] = []
                for e in eff_rows:
                    ide = (e.get("id_effectif") or "").strip()
                    if not ide:
                        continue

                    prenom = (e.get("prenom_effectif") or "").strip()
                    nom = (e.get("nom_effectif") or "").strip()
                    full = (prenom + " " + nom).strip() or "—"

                    poste_actuel = (e.get("id_poste_actuel") or "").strip() or None
                    is_tit = bool(poste_actuel and poste_actuel == id_poste)

                    eff_scores = scores_map.get(ide, {})

                    # Filtre anti-bruit: on garde toujours le(s) titulaire(s),
                    # et sinon uniquement les profils ayant au moins une trace sur les compétences du poste
                    if not is_tit and not eff_scores:
                        continue

                    sum_ratio = 0.0
                    nb_missing = 0
                    nb_under = 0
                    crit_missing = 0
                    crit_under = 0

                    for req in reqs:
                        cid = req["id_comp"]
                        lvl_req = req.get("niveau_requis") or ""
                        w = int(req.get("poids") or 1)
                        if w <= 0:
                            w = 1

                        seuil = _score_seuil_for_niveau(lvl_req)
                        score = eff_scores.get(cid) if eff_scores is not None else None

                        etat, ratio, _niveau_atteint = _matching_state_for_score(score, lvl_req)
                        if etat == "missing":
                            nb_missing += 1
                            if w >= crit_min:
                                crit_missing += 1
                        elif etat == "under":
                            nb_under += 1
                            if w >= crit_min:
                                crit_under += 1

                        sum_ratio += (w * ratio)

                    score_pct = int(round((sum_ratio / float(poids_total)) * 100.0))
                    if score_pct < 0:
                        score_pct = 0
                    if score_pct > 100:
                        score_pct = 100

                    items.append(
                        AnalyseMatchingItem(
                            id_effectif=ide,
                            full=full,
                            nom_service=(e.get("nom_service") or "").strip() or "—",
                            id_poste_actuel=poste_actuel,
                            score_pct=score_pct,
                            crit_missing=crit_missing,
                            crit_under=crit_under,
                            nb_missing=nb_missing,
                            nb_under=nb_under,
                            is_titulaire=is_tit,
                        )
                    )

                # Tri: score desc puis moins d'écarts critiques, puis moins d'écarts global
                items.sort(
                    key=lambda x: (
                        -int(x.score_pct or 0),
                        int(x.crit_missing or 0),
                        int(x.crit_under or 0),
                        int(x.nb_missing or 0),
                        int(x.nb_under or 0),
                        (x.full or "").lower(),
                    )
                )

                if limit and len(items) > int(limit):
                    items = items[: int(limit)]

                return AnalyseMatchingPosteResponse(
                    poste={
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                    },
                    scope=scope,
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    items=items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")



@router.get("/skills/analyse/matching/poste/pdf/{id_contact}")
def get_analyse_matching_poste_pdf(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        from fastapi import Response
        from xml.sax.saxutils import escape as xml_escape
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        data = get_analyse_matching_poste(
            id_contact=id_contact,
            request=request,
            id_poste=id_poste,
            id_service=id_service,
            criticite_min=criticite_min,
            limit=2000,
        )

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        styles = build_pdf_styles()
        poste = data.poste or {}
        items = list(data.items or [])
        titulaires = [x for x in items if bool(getattr(x, "is_titulaire", False))]
        candidats = [x for x in items if not bool(getattr(x, "is_titulaire", False))]

        def safe(v: Any) -> str:
            return xml_escape(str(v if v is not None else "—"))

        code = str(poste.get("codif_client") or poste.get("codif_poste") or "—").strip() or "—"
        intitule = str(poste.get("intitule_poste") or "Poste").strip() or "Poste"
        perimetre = getattr(data.scope, "nom_service", None) or "Tous les services"

        story = []
        story.append(Paragraph("Correspondances profils/postes", styles["title"]))
        story.append(Paragraph(f"{safe(code)} — {safe(intitule)}", styles["subtitle"]))
        story.append(make_spacer(3))

        meta = Table([
            [Paragraph("Périmètre", styles["meta_label"]), Paragraph(safe(perimetre), styles["meta_value"]), Paragraph("Compétences", styles["meta_label"]), Paragraph("Toutes", styles["meta_value"])],
            [Paragraph("Titulaires", styles["meta_label"]), Paragraph(str(len(titulaires)), styles["meta_value"]), Paragraph("Candidats", styles["meta_label"]), Paragraph(str(len(candidats)), styles["meta_value"])],
        ], colWidths=[28 * mm, 70 * mm, 28 * mm, 70 * mm])
        meta.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dbe3ef")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5edf7")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(meta)
        story.append(make_spacer(5))

        def add_people_table(title: str, rows: List[Any]):
            story.append(Paragraph(title, styles["section"]))
            head = [
                Paragraph("Collaborateur", styles["meta_label"]),
                Paragraph("Service", styles["meta_label"]),
                Paragraph("Score", styles["meta_label"]),
                Paragraph("Critiques", styles["meta_label"]),
                Paragraph("Écarts", styles["meta_label"]),
            ]
            body = [head]
            for r in rows[:30]:
                crit = f"{int(getattr(r, 'crit_missing', 0) or 0)} / {int(getattr(r, 'crit_under', 0) or 0)}"
                ecarts = f"{int(getattr(r, 'nb_missing', 0) or 0)} / {int(getattr(r, 'nb_under', 0) or 0)}"
                body.append([
                    Paragraph(safe(getattr(r, "full", "—")), styles["body"]),
                    Paragraph(safe(getattr(r, "nom_service", "—")), styles["body"]),
                    Paragraph(f"{int(getattr(r, 'score_pct', 0) or 0)} %", styles["body"]),
                    Paragraph(crit, styles["body"]),
                    Paragraph(ecarts, styles["body"]),
                ])
            if len(body) == 1:
                body.append([Paragraph("Aucune ligne à afficher", styles["body"]), "", "", "", ""])
            table = Table(body, colWidths=[70 * mm, 46 * mm, 22 * mm, 28 * mm, 28 * mm], repeatRows=1)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dbe3ef")),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e5edf7")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(table)
            story.append(make_spacer(5))

        add_people_table("Titulaires du poste", titulaires)
        add_people_table("Candidats potentiels", candidats)

        pdf_bytes = build_pdf_document(
            story,
            meta={
                "title": "Correspondances profils/postes",
                "doc_label": "Analyse matching",
                "footer_left": "Novoskill Insights • Correspondances profils/postes",
                "header_right": company_name,
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 11,
                "logo_bytes": logo_bytes,
            },
            page_size=landscape(A4),
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="correspondances_profils_postes_{id_poste}.pdf"',
                "Cache-Control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF correspondances : {e}")


@router.get("/skills/analyse/matching/effectif/pdf/{id_contact}")
def get_analyse_matching_effectif_pdf(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_effectif: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        from fastapi import Response
        from xml.sax.saxutils import escape as xml_escape
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        data = get_analyse_matching_effectif_detail(
            id_contact=id_contact,
            request=request,
            id_poste=id_poste,
            id_effectif=id_effectif,
            id_service=id_service,
            criticite_min=criticite_min,
        )

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)

        styles = build_pdf_styles()
        poste = data.poste or {}
        person = data.person
        stats = data.stats
        items = list(data.items or [])

        def safe(v: Any) -> str:
            if v is None or v == "":
                return "—"
            return xml_escape(str(v))

        def pct(v: Any) -> str:
            try:
                return f"{int(round(float(v or 0)))} %"
            except Exception:
                return "0 %"

        def score(v: Any) -> str:
            if v is None or v == "":
                return "—"
            try:
                return str(round(float(v), 1)).replace(".0", "")
            except Exception:
                return "—"

        def etat_label(value: Any) -> str:
            s = str(value or "").strip().lower()
            if s == "ok":
                return "OK"
            if s == "improvable":
                return "Améliorable"
            if s == "under":
                return "À renforcer"
            return "Manquante"

        def niveau_label(value: Any) -> str:
            s = str(value or "").strip()
            return s or "—"

        code = str(poste.get("codif_client") or poste.get("codif_poste") or "—").strip() or "—"
        intitule = str(poste.get("intitule_poste") or "Poste").strip() or "Poste"
        perimetre = getattr(data.scope, "nom_service", None) or "Tous les services"
        full = getattr(person, "full", None) or "Collaborateur"
        service = getattr(person, "nom_service", None) or "—"
        role = "Titulaire" if bool(getattr(person, "is_titulaire", False)) else "Candidat"
        score_pct = int(getattr(stats, "score_pct", 0) or 0)
        crit_missing = int(getattr(stats, "crit_missing", 0) or 0)
        crit_under = int(getattr(stats, "crit_under", 0) or 0)
        nb_missing = int(getattr(stats, "nb_missing", 0) or 0)
        nb_under = int(getattr(stats, "nb_under", 0) or 0)

        story = []
        story.append(Paragraph("Détail correspondance profil/poste", styles["title"]))
        story.append(Paragraph(f"{safe(full)} — {safe(code)} — {safe(intitule)}", styles["subtitle"]))
        story.append(make_spacer(3))

        meta = Table([
            [Paragraph("Collaborateur", styles["meta_label"]), Paragraph(safe(full), styles["meta_value"]), Paragraph("Rôle", styles["meta_label"]), Paragraph(safe(role), styles["meta_value"])],
            [Paragraph("Poste", styles["meta_label"]), Paragraph(f"{safe(code)} — {safe(intitule)}", styles["meta_value"]), Paragraph("Score", styles["meta_label"]), Paragraph(pct(score_pct), styles["meta_value"])],
            [Paragraph("Service", styles["meta_label"]), Paragraph(safe(service), styles["meta_value"]), Paragraph("Périmètre", styles["meta_label"]), Paragraph(safe(perimetre), styles["meta_value"])],
        ], colWidths=[30 * mm, 92 * mm, 28 * mm, 82 * mm])
        meta.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dbe3ef")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5edf7")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(meta)
        story.append(make_spacer(5))

        synth = Table([
            [Paragraph("Compétences manquantes", styles["meta_label"]), Paragraph(str(nb_missing), styles["meta_value"]), Paragraph("À renforcer", styles["meta_label"]), Paragraph(str(nb_under), styles["meta_value"])],
            [Paragraph("Critiques manquantes", styles["meta_label"]), Paragraph(str(crit_missing), styles["meta_value"]), Paragraph("Critiques à renforcer", styles["meta_label"]), Paragraph(str(crit_under), styles["meta_value"])],
        ], colWidths=[46 * mm, 24 * mm, 46 * mm, 24 * mm])
        synth.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dbe3ef")),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5edf7")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(Paragraph("Synthèse", styles["section"]))
        story.append(synth)
        story.append(make_spacer(6))

        story.append(Paragraph("Détail par compétence", styles["section"]))
        head = [
            Paragraph("Compétence", styles["meta_label"]),
            Paragraph("Domaine", styles["meta_label"]),
            Paragraph("Crit.", styles["meta_label"]),
            Paragraph("Niveau requis", styles["meta_label"]),
            Paragraph("Note max.", styles["meta_label"]),
            Paragraph("Score", styles["meta_label"]),
            Paragraph("Niveau atteint", styles["meta_label"]),
            Paragraph("État", styles["meta_label"]),
        ]
        rows = [head]
        for item in items:
            code_comp = getattr(item, "code", None) or getattr(item, "id_comp", None) or "—"
            intit_comp = getattr(item, "intitule", None) or ""
            comp_label = f"{code_comp} — {intit_comp}" if intit_comp else str(code_comp)
            rows.append([
                Paragraph(safe(comp_label), styles["body"]),
                Paragraph(safe(getattr(item, "domaine_titre_court", None)), styles["body"]),
                Paragraph(str(int(getattr(item, "poids_criticite", 0) or 0)), styles["body"]),
                Paragraph(safe(niveau_label(getattr(item, "niveau_requis", None))), styles["body"]),
                Paragraph(score(getattr(item, "seuil", None)), styles["body"]),
                Paragraph(score(getattr(item, "score", None)), styles["body"]),
                Paragraph(safe(niveau_label(getattr(item, "niveau_atteint", None))), styles["body"]),
                Paragraph(safe(etat_label(getattr(item, "etat", None))), styles["body"]),
            ])
        if len(rows) == 1:
            rows.append([Paragraph("Aucune compétence à afficher", styles["body"]), "", "", "", "", "", "", ""])

        table = Table(rows, colWidths=[64 * mm, 30 * mm, 14 * mm, 24 * mm, 20 * mm, 20 * mm, 28 * mm, 26 * mm], repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#334155")),
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dbe3ef")),
            ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#e5edf7")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(table)

        pdf = build_pdf_document(
            story,
            meta={
                "title": "Détail correspondance profil/poste",
                "doc_label": "Analyse matching",
                "footer_left": "Novoskill Insights • Détail correspondance profil/poste",
                "header_right": company_name,
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 11,
                "logo_bytes": logo_bytes,
            },
            page_size=landscape(A4),
        )

        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", f"{full}_{code}").strip("_") or "correspondance"
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="detail_correspondance_{safe_name}.pdf"',
                "Cache-Control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF détail correspondance : {e}")


# ======================================================
# Endpoint: Détail Matching (poste x effectif)
# - Drilldown depuis le tableau "Titulaires" / "Top candidats"
# - Renvoie le détail par compétence (score /24 + critères du dernier audit)
# ======================================================
@router.get(
    "/skills/analyse/matching/effectif/{id_contact}",
    response_model=AnalyseMatchingEffectifResponse,
)
def get_analyse_matching_effectif_detail(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_effectif: str = Query(...),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # --- id_ent depuis contact
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # --- Poste (doit être dans le scope)
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT fp.id_poste, fp.codif_poste, fp.codif_client, fp.intitule_poste
                    FROM public.tbl_fiche_poste fp
                    JOIN postes_scope ps ON ps.id_poste = fp.id_poste
                    WHERE fp.id_poste = %s
                    LIMIT 1
                    """,
                    tuple(cte_params + [id_poste]),
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste introuvable (ou hors périmètre service).")

                # --- Effectif (doit être dans le scope)
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        e.id_effectif,
                        e.prenom_effectif,
                        e.nom_effectif,
                        e.id_poste_actuel,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = e.id_service
                     AND o.archive = FALSE
                    WHERE e.id_ent = %s
                      AND e.id_effectif = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    tuple(cte_params + [id_ent, id_ent, id_effectif]),
                )
                e = cur.fetchone()
                if not e:
                    raise HTTPException(status_code=404, detail="Effectif introuvable (ou hors périmètre service).")

                prenom = (e.get("prenom_effectif") or "").strip()
                nom = (e.get("nom_effectif") or "").strip()
                full = (prenom + " " + nom).strip() or "—"
                poste_actuel = (e.get("id_poste_actuel") or "").strip() or None
                is_tit = bool(poste_actuel and poste_actuel == id_poste)

                # --- Dernières dates utiles pour le bloc Informations du candidat
                cur.execute(
                    """
                    SELECT MAX(COALESCE(ec.date_derniere_eval, ac.date_audit))::date AS derniere_evaluation_competences
                    FROM public.tbl_effectif_client_competence ec
                    LEFT JOIN public.tbl_effectif_client_audit_competence ac
                      ON ac.id_audit_competence = ec.id_dernier_audit
                     AND ac.id_effectif_competence = ec.id_effectif_competence
                    WHERE ec.id_effectif_client = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                    """,
                    (id_effectif,),
                )
                last_eval_row = cur.fetchone() or {}
                derniere_evaluation_competences = last_eval_row.get("derniere_evaluation_competences")
                derniere_evaluation_competences = str(derniere_evaluation_competences) if derniere_evaluation_competences else None

                cur.execute(
                    """
                    SELECT MAX(date_realisee)::date AS dernier_entretien_individuel
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND date_realisee IS NOT NULL
                    """,
                    (id_ent, id_effectif),
                )
                last_entretien_row = cur.fetchone() or {}
                dernier_entretien_individuel = last_entretien_row.get("dernier_entretien_individuel")
                dernier_entretien_individuel = str(dernier_entretien_individuel) if dernier_entretien_individuel else None

                # --- Poste actuel (affichage dans le modal si candidat)
                poste_actuel_obj = None
                poste_actuel_hors_scope = False
                if poste_actuel:
                    cur.execute(
                        f"""
                        WITH {cte_sql}
                        SELECT
                            fp.id_poste,
                            fp.codif_poste,
                            fp.codif_client,
                            fp.intitule_poste
                        FROM public.tbl_fiche_poste fp
                        JOIN postes_scope ps ON ps.id_poste = fp.id_poste
                        WHERE fp.id_poste = %s
                        LIMIT 1
                        """,
                        tuple(cte_params + [poste_actuel]),
                    )
                    pa = cur.fetchone()
                    if pa:
                        poste_actuel_obj = {
                            "id_poste": pa.get("id_poste"),
                            "codif_poste": pa.get("codif_poste"),
                            "codif_client": pa.get("codif_client"),
                            "intitule_poste": pa.get("intitule_poste"),
                        }
                    else:
                        # On sait qu'il y a un poste actuel, mais il est hors périmètre service (anti-fuite)
                        poste_actuel_hors_scope = True


                # --- Compétences requises + méta compétence
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        fpc.id_competence AS id_comp,
                        fpc.niveau_requis,
                        COALESCE(fpc.poids_criticite, 1)::int AS poids_criticite,
                        c.code,
                        c.intitule,
                        c.grille_evaluation,
                        c.domaine AS id_domaine_competence,
                        COALESCE(d.titre_court, d.titre, '') AS domaine_titre_court,
                        COALESCE(d.couleur, '') AS domaine_couleur
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                     AND COALESCE(d.masque, FALSE) = FALSE
                    WHERE fpc.id_poste = %s
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                    """,
                    tuple(cte_params + [id_poste]),
                )
                req_rows = cur.fetchall() or []
                if not req_rows:
                    return AnalyseMatchingEffectifResponse(
                        poste={
                            "id_poste": poste.get("id_poste"),
                            "codif_poste": poste.get("codif_poste"),
                            "codif_client": poste.get("codif_client"),
                            "intitule_poste": poste.get("intitule_poste"),
                        },
                        person=AnalyseMatchingPerson(
                            id_effectif=id_effectif,
                            full=full,
                            nom_service=(e.get("nom_service") or "").strip() or "—",
                            derniere_evaluation_competences=derniere_evaluation_competences,
                            dernier_entretien_individuel=dernier_entretien_individuel,
                            id_poste_actuel=poste_actuel,
                            poste_actuel=poste_actuel_obj,
                            poste_actuel_hors_scope=poste_actuel_hors_scope,
                            is_titulaire=is_tit,
                        ),
                        scope=scope,
                        criticite_min=int(criticite_min),
                        updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        stats=AnalyseMatchingStats(),
                        items=[],
                    )

                comp_ids = [str(r.get("id_comp") or "").strip() for r in req_rows if (r.get("id_comp") or "").strip()]
                comp_ids = [x for x in comp_ids if x]

                # --- Dernier audit (score + détails) pour ces compétences
                cur.execute(
                    f"""
                    WITH {cte_sql}
                    SELECT
                        ec.id_comp,
                        ac.resultat_eval,
                        ac.detail_eval
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_effectif_client_audit_competence ac
                      ON ac.id_audit_competence = ec.id_dernier_audit
                    WHERE ec.id_effectif_client = %s
                      AND ec.actif = TRUE
                      AND ec.archive = FALSE
                      AND ec.id_comp = ANY(%s)
                    """,
                    tuple(cte_params + [id_effectif, comp_ids]),
                )
                score_rows = cur.fetchall() or []

                scores: Dict[str, Dict[str, Any]] = {}
                for r in score_rows:
                    cid = (r.get("id_comp") or "").strip()
                    if not cid:
                        continue
                    scores[cid] = {
                        "score": _safe_float(r.get("resultat_eval")),
                        "detail": r.get("detail_eval"),
                    }

                # --- Stats + items
                poids_total = 0
                # Le détail matching reprend le même périmètre que le tableau principal : toutes les compétences du poste.
                crit_min = CRITICITE_MIN_DEFAULT

                sum_ratio = 0.0
                nb_missing = 0
                nb_under = 0
                crit_missing = 0
                crit_under = 0

                out_items: List[AnalyseMatchingCompetenceDetail] = []

                for r in req_rows:
                    cid = (r.get("id_comp") or "").strip()
                    if not cid:
                        continue

                    lvl_req = (r.get("niveau_requis") or "").strip().upper()
                    w = int(r.get("poids_criticite") or 1)
                    if w <= 0:
                        w = 1
                    poids_total += w

                    seuil = _score_seuil_for_niveau(lvl_req)
                    srow = scores.get(cid) or {}
                    score = srow.get("score", None)

                    is_crit = bool(w >= crit_min)
                    etat, ratio, niveau_atteint = _matching_state_for_score(score, lvl_req)
                    if etat == "missing":
                        nb_missing += 1
                        if is_crit:
                            crit_missing += 1
                    elif etat == "under":
                        nb_under += 1
                        if is_crit:
                            crit_under += 1

                    sum_ratio += (w * ratio)

                    # grille d'évaluation (jsonb) -> mapping CritereX => {nom, eval[]}
                    grid_map: Dict[str, Dict[str, Any]] = {}
                    grid = r.get("grille_evaluation")
                    try:
                        if isinstance(grid, str):
                            grid = json.loads(grid)
                        if isinstance(grid, dict):
                            for k, v in grid.items():
                                if not isinstance(v, dict):
                                    continue
                                nm = (v.get("Nom") or "").strip()
                                ev = v.get("Eval")
                                ev_list = ev if isinstance(ev, list) else []
                                grid_map[str(k)] = {"nom": nm, "eval": ev_list}
                    except Exception:
                        grid_map = {}

                    # critères (audit detail_eval) -> liste enrichie (nom + libellé du niveau)
                    crit_list: List[AnalyseMatchingCritere] = []
                    det = srow.get("detail")
                    try:
                        if isinstance(det, str):
                            det = json.loads(det)
                        if isinstance(det, dict):
                            arr = det.get("criteres", [])
                            if isinstance(arr, list):
                                for it in arr:
                                    if not isinstance(it, dict):
                                        continue

                                    ccode = (it.get("code_critere") or None)
                                    niv = int(it.get("niveau")) if it.get("niveau") is not None else None

                                    c_nom = None
                                    c_lib = None
                                    if ccode and ccode in grid_map:
                                        c_nom = (grid_map[ccode].get("nom") or "").strip() or None
                                        evl = grid_map[ccode].get("eval") or []
                                        if niv is not None and isinstance(evl, list) and 1 <= int(niv) <= len(evl):
                                            try:
                                                c_lib = (evl[int(niv) - 1] or "").strip() or None
                                            except Exception:
                                                c_lib = None

                                    crit_list.append(
                                        AnalyseMatchingCritere(
                                            code_critere=ccode,
                                            niveau=niv,
                                            nom=c_nom,
                                            libelle=c_lib,
                                        )
                                    )
                    except Exception:
                        crit_list = []

                    out_items.append(
                        AnalyseMatchingCompetenceDetail(
                            id_comp=cid,
                            code=(r.get("code") or "").strip() or None,
                            intitule=(r.get("intitule") or "").strip() or None,
                            id_domaine_competence=(r.get("id_domaine_competence") or "").strip() or None,
                            domaine_titre_court=(r.get("domaine_titre_court") or "").strip() or None,
                            domaine_couleur=(r.get("domaine_couleur") or "").strip() or None,
                            poids_criticite=w,
                            niveau_requis=lvl_req or None,
                            seuil=float(seuil or 0.0),
                            score=score,
                            niveau_atteint=niveau_atteint,
                            etat=etat,
                            is_critique=is_crit,
                            criteres=crit_list,
                        )
                    )

                if poids_total <= 0:
                    poids_total = 1
                score_pct = int(round((sum_ratio / float(poids_total)) * 100.0))
                if score_pct < 0:
                    score_pct = 0
                if score_pct > 100:
                    score_pct = 100

                # Tri par criticité desc puis code
                out_items.sort(
                    key=lambda x: (
                        -int(x.poids_criticite or 0),
                        (x.code or x.id_comp or "").lower(),
                    )
                )

                return AnalyseMatchingEffectifResponse(
                    poste={
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                    },
                    person=AnalyseMatchingPerson(
                        id_effectif=id_effectif,
                        full=full,
                        nom_service=(e.get("nom_service") or "").strip() or "—",
                        derniere_evaluation_competences=derniere_evaluation_competences,
                        dernier_entretien_individuel=dernier_entretien_individuel,
                        id_poste_actuel=poste_actuel,
                        poste_actuel=poste_actuel_obj,
                        poste_actuel_hors_scope=poste_actuel_hors_scope,
                        is_titulaire=is_tit,
                    ),
                    scope=scope,
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    stats=AnalyseMatchingStats(
                        score_pct=score_pct,
                        crit_missing=crit_missing,
                        crit_under=crit_under,
                        nb_missing=nb_missing,
                        nb_under=nb_under,
                    ),
                    items=out_items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Endpoint: Détail compétence (Risques)
# - Drilldown depuis "Critiques sans porteur" / "Porteur unique"
# - Renvoie: infos compétence + postes impactés + porteurs (niveau_actuel)
# ======================================================
@router.get("/skills/analyse/risques/competence/{id_contact}")
def get_risque_competence_detail(
    id_contact: str,
    request: Request,
    id_comp: str = Query(..., description="id_comp OU code compétence"),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    limit_postes: int = Query(default=200, ge=1, le=2000),
    limit_porteurs: int = Query(default=300, ge=1, le=2000),
):
    try:
        NON_LIE_ID_LOCAL = "__NON_LIE__"

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # --- scope label
                scope = {"id_service": None, "nom_service": "Tous les services"}
                svc = (id_service or "").strip()
                if svc:
                    if svc == NON_LIE_ID_LOCAL:
                        scope = {"id_service": NON_LIE_ID_LOCAL, "nom_service": "Non liés (sans service)"}
                    else:
                        cur.execute(
                            """
                            SELECT id_service, COALESCE(nom_service, 'Service') AS nom_service
                            FROM public.tbl_entreprise_organigramme
                            WHERE id_ent = %s
                              AND id_service = %s
                              AND archive = FALSE
                            LIMIT 1
                            """,
                            (id_ent, svc)
                        )
                        srow = cur.fetchone()
                        if not srow:
                            raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")
                        scope = {"id_service": srow["id_service"], "nom_service": srow["nom_service"]}

                # --- compétence (on accepte id_comp OU code)
                cur.execute(
                    """
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.description,
                        c.domaine AS id_domaine_competence,
                        c.etat,
                        c.masque,
                        d.titre,
                        d.titre_court,
                        d.couleur
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    WHERE (c.id_comp = %s OR c.code = %s)
                    LIMIT 1
                    """,
                    (id_comp, id_comp)
                )
                comp = cur.fetchone()
                if not comp:
                    raise HTTPException(status_code=404, detail="Compétence introuvable.")

                comp_id = comp["id_comp"]

                # --- CTE service (descendants) si service ciblé
                services_cte_sql = ""
                services_cte_params: List[Any] = []
                svc_filter_poste = "TRUE"
                svc_filter_eff = "TRUE"
                extra_poste_params: List[Any] = []
                extra_eff_params: List[Any] = []

                if scope["id_service"]:
                    if scope["id_service"] == NON_LIE_ID_LOCAL:
                        # Non liés = NULL/'' ou service hors organigramme actif
                        svc_filter_poste = """
                            (
                                p.id_service IS NULL OR p.id_service = ''
                                OR p.id_service NOT IN (
                                    SELECT o.id_service
                                    FROM public.tbl_entreprise_organigramme o
                                    WHERE o.id_ent = %s
                                      AND o.archive = FALSE
                                )
                            )
                        """
                        svc_filter_eff = """
                            (
                                e.id_service IS NULL OR e.id_service = ''
                                OR e.id_service NOT IN (
                                    SELECT o.id_service
                                    FROM public.tbl_entreprise_organigramme o
                                    WHERE o.id_ent = %s
                                      AND o.archive = FALSE
                                )
                            )
                        """
                        extra_poste_params.append(id_ent)
                        extra_eff_params.append(id_ent)
                    else:
                        services_cte_sql = """
                        services_scope AS (
                            WITH RECURSIVE s AS (
                                SELECT o.id_service
                                FROM public.tbl_entreprise_organigramme o
                                WHERE o.id_ent = %s
                                  AND o.archive = FALSE
                                  AND o.id_service = %s
                                UNION ALL
                                SELECT o2.id_service
                                FROM public.tbl_entreprise_organigramme o2
                                JOIN s ON s.id_service = o2.id_service_parent
                                WHERE o2.id_ent = %s
                                  AND o2.archive = FALSE
                            )
                            SELECT id_service FROM s
                        )
                        """
                        services_cte_params = [id_ent, scope["id_service"], id_ent]
                        svc_filter_poste = "p.id_service IN (SELECT id_service FROM services_scope)"
                        svc_filter_eff = "e.id_service IN (SELECT id_service FROM services_scope)"

                with_clause = f"WITH {services_cte_sql}" if services_cte_sql else ""

                # --- Postes impactés (requièrent la compétence) + nb porteurs (sur poste actuel)
                sql_postes = f"""
                {with_clause}
                SELECT
                    p.id_poste,
                    p.codif_poste,
                    COALESCE(p.codif_client,'') AS codif_client,
                    p.intitule_poste,
                    p.id_service,
                    COALESCE(o.nom_service,'') AS nom_service,

                    fpc.niveau_requis,
                    fpc.poids_criticite,

                    COALESCE(pc.nb_porteurs,0)::int AS nb_porteurs,

                    1::int AS besoin_poste

                FROM public.tbl_fiche_poste_competence fpc
                JOIN public.tbl_fiche_poste p
                  ON p.id_poste = fpc.id_poste

                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = p.id_ent
                 AND o.id_service = p.id_service
                 AND o.archive = FALSE

                JOIN public.tbl_competence c
                  ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)

                LEFT JOIN (
                    SELECT
                        e.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT e.id_effectif)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE e.id_ent = %s
                        AND COALESCE(e.archive,FALSE) = FALSE
                        AND ec.id_comp = %s
                        AND COALESCE(ec.actif, TRUE) = TRUE
                        AND COALESCE(ec.archive, FALSE) = FALSE
                        AND {svc_filter_eff}
                    GROUP BY e.id_poste_actuel
                ) pc
                  ON pc.id_poste = p.id_poste

                WHERE
                    p.id_ent = %s
                    AND COALESCE(p.actif, TRUE) = TRUE
                    AND {svc_filter_poste}
                    AND c.id_comp = %s
                    AND COALESCE(fpc.masque, FALSE) = FALSE
                    AND COALESCE(fpc.poids_criticite, 0) >= %s
                ORDER BY
                    COALESCE(pc.nb_porteurs,0) ASC,
                    COALESCE(fpc.poids_criticite,0) DESC,
                    p.codif_poste,
                    p.intitule_poste
                LIMIT %s
                """
                params_postes: List[Any] = []
                params_postes.extend(services_cte_params)
                params_postes.extend([id_ent, comp_id])
                params_postes.extend(extra_eff_params)
                params_postes.extend([id_ent])
                params_postes.extend(extra_poste_params)
                params_postes.extend([comp_id, criticite_min, limit_postes])

                cur.execute(sql_postes, tuple(params_postes))
                postes = [dict(r) for r in (cur.fetchall() or [])]

                # --- Porteurs (tous porteurs dans le périmètre)
                sql_porteurs = f"""
                {with_clause}
                SELECT
                    e.id_effectif,
                    e.prenom_effectif,
                    e.nom_effectif,
                    ec.id_effectif_competence,
                    ec.niveau_actuel,
                    ec.date_derniere_eval,
                    ec.id_dernier_audit,
                    ac.id_audit_competence,
                    ac.date_audit,
                    ac.resultat_eval,
                    CASE
                        WHEN ec.date_derniere_eval IS NOT NULL THEN TRUE
                        WHEN ac.id_audit_competence IS NOT NULL THEN TRUE
                        ELSE FALSE
                    END AS is_evaluee,

                    CASE WHEN br.date_fin_indispo IS NULL THEN FALSE ELSE TRUE END AS is_indispo,
                    br.date_fin_indispo,

                    e.id_service,
                    COALESCE(o.nom_service,'') AS nom_service,

                    e.id_poste_actuel,
                    COALESCE(p.codif_poste,'') AS codif_poste,
                    COALESCE(p.intitule_poste,'') AS intitule_poste
                FROM public.tbl_effectif_client_competence ec
                JOIN public.tbl_effectif_client e
                  ON e.id_effectif = ec.id_effectif_client
                LEFT JOIN public.tbl_effectif_client_audit_competence ac
                  ON ac.id_audit_competence = ec.id_dernier_audit
                 AND ac.id_effectif_competence = ec.id_effectif_competence
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = e.id_ent
                 AND o.id_service = e.id_service
                 AND o.archive = FALSE
                LEFT JOIN public.tbl_fiche_poste p
                  ON p.id_poste = e.id_poste_actuel
                LEFT JOIN (
                    SELECT
                        id_effectif,
                        MAX(date_fin) AS date_fin_indispo
                    FROM public.tbl_effectif_client_break
                    WHERE archive = FALSE
                      AND date_debut <= CURRENT_DATE
                      AND date_fin >= CURRENT_DATE
                    GROUP BY id_effectif
                ) br
                  ON br.id_effectif = e.id_effectif
                WHERE
                    e.id_ent = %s
                    AND COALESCE(e.archive,FALSE) = FALSE
                    AND ec.id_comp = %s
                    AND COALESCE(ec.actif, TRUE) = TRUE
                    AND COALESCE(ec.archive, FALSE) = FALSE
                    AND {svc_filter_eff}
                ORDER BY e.nom_effectif, e.prenom_effectif
                LIMIT %s
                """

                params_porteurs: List[Any] = []
                params_porteurs.extend(services_cte_params)
                params_porteurs.extend([id_ent, comp_id])
                params_porteurs.extend(extra_eff_params)
                params_porteurs.append(limit_porteurs)

                cur.execute(sql_porteurs, tuple(params_porteurs))
                porteurs = [dict(r) for r in (cur.fetchall() or [])]

                # --- Niveaux et états RH (calculés côté backend, le front affiche seulement)
                def _niv_key(v: Any) -> str:
                    s = str(v or "").strip().upper()
                    s = (
                        s.replace("É", "E").replace("È", "E").replace("Ê", "E").replace("Ë", "E")
                         .replace("À", "A").replace("Â", "A").replace("Ä", "A")
                         .replace("Î", "I").replace("Ï", "I")
                         .replace("Ô", "O").replace("Ö", "O")
                         .replace("Û", "U").replace("Ü", "U")
                         .replace("Ç", "C")
                    )
                    if not s:
                        return ""
                    if "-" in s:
                        last = s.split("-")[-1].strip()
                        if last in ("A", "B", "C", "D"):
                            return last
                    if s in ("A", "B", "C", "D"):
                        return s
                    if "EXPERT" in s:
                        return "D"
                    if "AVANCE" in s:
                        return "C"
                    if "INTER" in s:
                        return "B"
                    if "DEBUT" in s or "INITIAL" in s or "INIT" in s:
                        return "A"
                    return ""

                def _niv_rank_local(v: Any) -> int:
                    k = _niv_key(v)
                    if k == "A":
                        return 1
                    if k == "B":
                        return 2
                    if k == "C":
                        return 3
                    if k == "D":
                        return 4
                    return 0

                def _truthy(v: Any) -> bool:
                    return v is True or v == 1 or str(v or "").strip().lower() in ("t", "true", "1", "oui", "yes")

                def _is_evaluee_row(r: Dict[str, Any]) -> bool:
                    return bool(r.get("date_derniere_eval") or r.get("id_audit_competence") or r.get("date_audit") or _truthy(r.get("is_evaluee")))

                def _is_indispo_row(r: Dict[str, Any]) -> bool:
                    return bool(r.get("date_fin_indispo") or _truthy(r.get("is_indispo")))

                def _coverage_state_label(etat: str) -> str:
                    return {
                        "COUVERTURE_ABSENTE": "Aucun porteur déclaré",
                        "COUVERTURE_NON_CONFIRMEE": "À évaluer",
                        "NIVEAU_INSUFFISANT": "Niveau insuffisant",
                        "DEPENDANCE": "Dépendance",
                        "COUVERTURE_VALIDEE": "Couverture validée",
                    }.get(etat or "", "À qualifier")

                def _coverage_action_label(etat: str) -> str:
                    return {
                        "COUVERTURE_ABSENTE": "Identifier un porteur ou recruter",
                        "COUVERTURE_NON_CONFIRMEE": "Évaluer en priorité",
                        "NIVEAU_INSUFFISANT": "Former / accompagner",
                        "DEPENDANCE": "Organiser une doublure",
                        "COUVERTURE_VALIDEE": "Surveiller",
                    }.get(etat or "", "Analyser")

                porteurs_by_poste: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
                for r in porteurs:
                    pid = str(r.get("id_poste_actuel") or "").strip()
                    if pid:
                        porteurs_by_poste[pid].append(r)

                    rang = _niv_rank_local(r.get("niveau_actuel"))
                    is_eval = _is_evaluee_row(r)
                    is_indispo = _is_indispo_row(r)
                    if is_indispo:
                        statut_rh = "INDISPONIBLE"
                        statut_rh_label = "Indisponible"
                    elif not is_eval:
                        statut_rh = "A_EVALUER"
                        statut_rh_label = "À évaluer"
                    elif rang <= 0:
                        statut_rh = "EVALUATION_INEXPLOITABLE"
                        statut_rh_label = "Évaluation inexploitable"
                    else:
                        statut_rh = "EVALUE"
                        statut_rh_label = "Évalué"

                    r["niveau_code"] = _niv_key(r.get("niveau_actuel"))
                    r["niveau_rank"] = rang
                    r["is_evaluee"] = is_eval
                    r["is_indispo"] = is_indispo
                    r["statut_rh"] = statut_rh
                    r["statut_rh_label"] = statut_rh_label

                besoin = {"A": 0, "B": 0, "C": 0, "D": 0}
                porteurs_niv = {"A": 0, "B": 0, "C": 0, "D": 0}

                nb_postes_absent = 0
                nb_postes_non_confirme = 0
                nb_postes_insuffisant = 0
                nb_postes_dependance = 0
                nb_postes_valides = 0
                nb_valides_total = 0

                for p in postes:
                    pid = str(p.get("id_poste") or "").strip()
                    req_rank = _niv_rank_local(p.get("niveau_requis"))
                    req_key = _niv_key(p.get("niveau_requis"))
                    besoin_poste = max(_safe_int(p.get("besoin_poste"), 1), 1)
                    if req_key:
                        besoin[req_key] += besoin_poste

                    related = porteurs_by_poste.get(pid, [])
                    nb_declares = len(related)
                    nb_evalues = sum(1 for r in related if r.get("is_evaluee") and not r.get("is_indispo"))
                    nb_valides = sum(
                        1 for r in related
                        if r.get("is_evaluee") and not r.get("is_indispo") and req_rank > 0 and _safe_int(r.get("niveau_rank"), 0) >= req_rank
                    )
                    nb_non_evalues = sum(1 for r in related if not r.get("is_evaluee"))
                    nb_insuffisants = sum(
                        1 for r in related
                        if r.get("is_evaluee") and not r.get("is_indispo") and req_rank > 0 and 0 < _safe_int(r.get("niveau_rank"), 0) < req_rank
                    )

                    if nb_declares <= 0:
                        etat = "COUVERTURE_ABSENTE"
                        nb_postes_absent += 1
                    elif nb_valides >= besoin_poste:
                        if nb_valides == 1:
                            etat = "DEPENDANCE"
                            nb_postes_dependance += 1
                        else:
                            etat = "COUVERTURE_VALIDEE"
                            nb_postes_valides += 1
                    elif nb_non_evalues > 0:
                        etat = "COUVERTURE_NON_CONFIRMEE"
                        nb_postes_non_confirme += 1
                    elif nb_insuffisants > 0:
                        etat = "NIVEAU_INSUFFISANT"
                        nb_postes_insuffisant += 1
                    else:
                        etat = "COUVERTURE_ABSENTE"
                        nb_postes_absent += 1

                    p["besoin_poste"] = besoin_poste
                    p["nb_porteurs_declares"] = nb_declares
                    p["nb_porteurs_evalues"] = nb_evalues
                    p["nb_porteurs_valides"] = nb_valides
                    p["nb_porteurs_non_evalues"] = nb_non_evalues
                    p["nb_porteurs_insuffisants"] = nb_insuffisants
                    p["etat_couverture"] = etat
                    p["etat_couverture_label"] = _coverage_state_label(etat)
                    p["action_rh"] = _coverage_action_label(etat)

                    nb_valides_total += nb_valides

                for r in porteurs:
                    if not r.get("is_evaluee") or r.get("is_indispo"):
                        continue
                    k = r.get("niveau_code") or ""
                    if k in porteurs_niv:
                        porteurs_niv[k] += 1

                porteurs_ge = {
                    "A": porteurs_niv["A"] + porteurs_niv["B"] + porteurs_niv["C"] + porteurs_niv["D"],
                    "B": porteurs_niv["B"] + porteurs_niv["C"] + porteurs_niv["D"],
                    "C": porteurs_niv["C"] + porteurs_niv["D"],
                    "D": porteurs_niv["D"],
                }

                niveaux = {"besoin": besoin, "porteurs": porteurs_niv, "porteurs_ge": porteurs_ge}

                causes = [
                    {
                        "code": "COUVERTURE_ABSENTE",
                        "titre": "Couverture absente",
                        "count": nb_postes_absent,
                        "lecture": "Aucun porteur déclaré ne couvre cette compétence sur les postes concernés.",
                        "action": "Identifier un porteur interne ou préparer un recrutement ciblé.",
                    },
                    {
                        "code": "COUVERTURE_NON_CONFIRMEE",
                        "titre": "Couverture non confirmée",
                        "count": nb_postes_non_confirme,
                        "lecture": "La compétence est déclarée, mais aucune évaluation exploitable ne confirme le niveau attendu.",
                        "action": "Planifier une évaluation avant de considérer le poste sécurisé.",
                    },
                    {
                        "code": "NIVEAU_INSUFFISANT",
                        "titre": "Écart de maîtrise",
                        "count": nb_postes_insuffisant,
                        "lecture": "La compétence est évaluée, mais le niveau constaté ne couvre pas le niveau requis.",
                        "action": "Prévoir formation, accompagnement ou montée en compétence ciblée.",
                    },
                    {
                        "code": "DEPENDANCE",
                        "titre": "Dépendance / transmission",
                        "count": nb_postes_dependance,
                        "lecture": "La compétence est validée, mais repose sur un seul porteur confirmé.",
                        "action": "Organiser une doublure ou un transfert de savoir-faire.",
                    },
                ]

                nb_postes_total_detail = len(postes)
                nb_postes_fragiles_detail = nb_postes_absent + nb_postes_non_confirme + nb_postes_insuffisant + nb_postes_dependance
                indice_detail = _calc_fragility_score(nb_postes_absent, nb_postes_dependance, nb_postes_fragiles_detail)
                if nb_postes_non_confirme > 0:
                    indice_detail = max(indice_detail, min(90, 30 + (10 * nb_postes_non_confirme)))
                if nb_postes_insuffisant > 0:
                    indice_detail = max(indice_detail, min(92, 45 + (10 * nb_postes_insuffisant)))
                indice_detail = _clamp_int(indice_detail, 0, 100)

                priorite_detail = "P1" if indice_detail >= 75 else "P2" if indice_detail >= 50 else "P3"

                competence_detail_stats = {
                    "nb_postes_impactes": nb_postes_total_detail,
                    "nb_postes_couverture_absente": nb_postes_absent,
                    "nb_postes_non_confirmee": nb_postes_non_confirme,
                    "nb_postes_niveau_insuffisant": nb_postes_insuffisant,
                    "nb_postes_dependance": nb_postes_dependance,
                    "nb_postes_valides": nb_postes_valides,
                    "nb_porteurs_declares": len(porteurs),
                    "nb_porteurs_evalues": sum(1 for r in porteurs if r.get("is_evaluee")),
                    "nb_porteurs_non_evalues": sum(1 for r in porteurs if not r.get("is_evaluee")),
                    "nb_porteurs_valides": nb_valides_total,
                    "besoin_total": sum(max(_safe_int(p.get("besoin_poste"), 1), 1) for p in postes),
                    "criticite_max": max([_safe_int(p.get("poids_criticite"), 0) for p in postes] or [0]),
                    "indice_fragilite": indice_detail,
                    "priorite": priorite_detail,
                }

                # --- Diagnostic DRH fiable (indépendant des LIMIT) + Indice/Priorité
                other_ctes = f"""
                postes_impactes AS (
                    SELECT DISTINCT
                        p.id_poste,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN public.tbl_fiche_poste p
                      ON p.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND {svc_filter_poste}
                      AND c.id_comp = %s
                      AND COALESCE(fpc.poids_criticite, 0) >= %s
                ),
                titulaires AS (
                    SELECT
                        e.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.id_poste_actuel, '') <> ''
                      AND {svc_filter_eff}
                    GROUP BY e.id_poste_actuel
                ),
                poste_need AS (
                    SELECT
                        pi.id_poste,
                        CASE
                            WHEN prh.nb_titulaires_cible IS NOT NULL AND prh.nb_titulaires_cible::int > 0
                                THEN prh.nb_titulaires_cible::int
                            WHEN COALESCE(t.nb_titulaires, 0)::int > 0
                                THEN COALESCE(t.nb_titulaires, 0)::int
                            ELSE 1
                        END AS besoin_poste
                    FROM postes_impactes pi
                    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = pi.id_poste
                    LEFT JOIN titulaires t ON t.id_poste = pi.id_poste
                ),
                porteurs_poste AS (
                    SELECT
                        e.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT e.id_effectif)::int AS nb_porteurs_poste
                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND ec.id_comp = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND {svc_filter_eff}
                    GROUP BY e.id_poste_actuel
                ),
                postes_enrichis AS (
                    SELECT
                        pi.id_poste,
                        pi.poids_criticite,
                        pn.besoin_poste,
                        COALESCE(pp.nb_porteurs_poste, 0)::int AS nb_porteurs_poste
                    FROM postes_impactes pi
                    JOIN poste_need pn ON pn.id_poste = pi.id_poste
                    LEFT JOIN porteurs_poste pp ON pp.id_poste = pi.id_poste
                ),
                need_agg AS (
                    SELECT
                        COUNT(DISTINCT id_poste)::int AS nb_postes_impactes,
                        COALESCE(MAX(poids_criticite), 0)::int AS criticite_max,
                        COALESCE(SUM(CASE WHEN poids_criticite >= 80 THEN 1 ELSE 0 END), 0)::int AS nb_postes_crit_80,
                        COALESCE(SUM(besoin_poste), 0)::int AS besoin_total,
                        COALESCE(SUM(CASE WHEN nb_porteurs_poste = 0 THEN 1 ELSE 0 END), 0)::int AS nb_postes_sans_porteur,
                        COALESCE(SUM(CASE WHEN nb_porteurs_poste = 1 THEN 1 ELSE 0 END), 0)::int AS nb_postes_porteur_unique
                    FROM postes_enrichis
                ),
                effectifs_scope AS (
                    SELECT e.id_effectif
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND {svc_filter_eff}
                ),
                effectifs_dispo AS (
                    SELECT es.id_effectif
                    FROM effectifs_scope es
                    JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_break b
                        WHERE b.id_effectif = e.id_effectif
                          AND b.archive = FALSE
                          AND b.date_debut <= CURRENT_DATE
                          AND b.date_fin >= CURRENT_DATE
                    )
                ),
                porteurs_nominal AS (
                    SELECT COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    WHERE ec.id_comp = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                ),
                porteurs_dispo AS (
                    SELECT COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_dispo es ON es.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = ec.id_dernier_audit
                     AND a.id_effectif_competence = ec.id_effectif_competence
                    WHERE ec.id_comp = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND a.resultat_eval IS NOT NULL
                      AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL)
                ),
                experts_nominal AS (
                    SELECT COUNT(DISTINCT ec.id_effectif_client)::int AS nb_experts
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    WHERE ec.id_comp = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND (
                        CASE
                          WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                            THEN trim(ec.niveau_actuel)::int
                          WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                          WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                          ELSE 0
                        END
                      ) >= 4
                ),
                experts_dispo AS (
                    SELECT COUNT(DISTINCT ec.id_effectif_client)::int AS nb_experts
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_dispo es ON es.id_effectif = ec.id_effectif_client
                    WHERE ec.id_comp = %s
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND (
                        CASE
                          WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                            THEN trim(ec.niveau_actuel)::int
                          WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                          WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                          ELSE 0
                        END
                      ) >= 4
                )
                """

                if services_cte_sql:
                    sql_diag = "WITH " + services_cte_sql + ",\n" + other_ctes + """
                    SELECT
                        na.nb_postes_impactes,
                        na.criticite_max,
                        na.nb_postes_crit_80,
                        na.besoin_total,
                        na.nb_postes_sans_porteur,
                        na.nb_postes_porteur_unique,
                        pn.nb_porteurs AS nb_porteurs,
                        pd.nb_porteurs AS nb_porteurs_dispo,
                        en.nb_experts AS nb_experts,
                        ed.nb_experts AS nb_experts_dispo
                    FROM need_agg na
                    CROSS JOIN porteurs_nominal pn
                    CROSS JOIN porteurs_dispo pd
                    CROSS JOIN experts_nominal en
                    CROSS JOIN experts_dispo ed
                    """
                else:
                    sql_diag = "WITH " + other_ctes + """
                    SELECT
                        na.nb_postes_impactes,
                        na.criticite_max,
                        na.nb_postes_crit_80,
                        na.besoin_total,
                        na.nb_postes_sans_porteur,
                        na.nb_postes_porteur_unique,
                        pn.nb_porteurs AS nb_porteurs,
                        pd.nb_porteurs AS nb_porteurs_dispo,
                        en.nb_experts AS nb_experts,
                        ed.nb_experts AS nb_experts_dispo
                    FROM need_agg na
                    CROSS JOIN porteurs_nominal pn
                    CROSS JOIN porteurs_dispo pd
                    CROSS JOIN experts_nominal en
                    CROSS JOIN experts_dispo ed
                    """

                params_diag: List[Any] = []
                params_diag.extend(services_cte_params)

                # postes_impactes
                params_diag.extend([id_ent])
                params_diag.extend(extra_poste_params)
                params_diag.extend([comp_id, criticite_min])

                # titulaires
                params_diag.append(id_ent)
                params_diag.extend(extra_eff_params)

                # porteurs_poste
                params_diag.append(id_ent)
                params_diag.append(comp_id)
                params_diag.extend(extra_eff_params)

                # effectifs_scope
                params_diag.append(id_ent)
                params_diag.extend(extra_eff_params)

                # porteurs/experts (4x comp_id)
                params_diag.extend([comp_id, comp_id, comp_id, comp_id])

                cur.execute(sql_diag, tuple(params_diag))
                diag = cur.fetchone() or {}

                def _clamp(v: float, lo: float, hi: float) -> float:
                    return max(lo, min(hi, v))

                B = int(diag.get("bessOIN_TOTAL".lower()) or diag.get("besoin_total") or 0)
                B = B if B > 0 else 1

                P = int(diag.get("nb_porteurs") or 0)
                Pd = int(diag.get("nb_porteurs_dispo") or 0)

                Pe = int(diag.get("nb_experts") or 0)
                Ped = int(diag.get("nb_experts_dispo") or 0)

                N = int(diag.get("nb_postes_impactes") or 0)
                Cmax = int(diag.get("criticite_max") or 0)
                N80 = int(diag.get("nb_postes_crit_80") or 0)

                nb_postes = N
                nb_porteurs = P
                nb_postes_sans_porteur = int(diag.get("nb_postes_sans_porteur") or 0)
                nb_postes_porteur_unique = int(diag.get("nb_postes_porteur_unique") or 0)

                # Sous-scores (0..1)
                S_cov = _clamp(1.0 - (P / float(B)), 0.0, 1.0)

                if P == 0:
                    S_dep = 1.00
                elif P == 1:
                    S_dep = 0.80
                elif P == 2:
                    S_dep = 0.50
                elif P == 3:
                    S_dep = 0.25
                else:
                    S_dep = 0.00

                if Pe == 0:
                    S_exp = 1.00
                elif Pe == 1:
                    S_exp = 0.70
                else:
                    S_exp = 0.00

                S_expo = min(1.0, N / 5.0)
                S_sev = 0.7 * (Cmax / 100.0) + 0.3 * min(1.0, N80 / 3.0)

                base = 100.0 * (
                    0.35 * S_cov
                    + 0.15 * S_dep
                    + 0.15 * S_exp
                    + 0.10 * S_expo
                    + 0.25 * S_sev
                )

                bonus = 0.0
                if P > 0 and Pd == 0:
                    bonus += 20.0
                if Pe > 0 and Ped == 0:
                    bonus += 10.0

                indice = int(round(_clamp(base + bonus, 0.0, 100.0)))

                if indice >= 75:
                    priorite = "P1"
                elif indice >= 50:
                    priorite = "P2"
                else:
                    priorite = "P3"

                # Alignement final modal <-> table : même source que /risques/detail?kpi=critiques-fragiles.
                comp_records_modal = _fetch_competence_fragility_records(
                    cur,
                    id_ent,
                    scope.get("id_service") if isinstance(scope, dict) else None,
                    criticite_min,
                    comp_id=comp_id,
                    limit=1,
                )
                if comp_records_modal:
                    cr = comp_records_modal[0]
                    indice = int(cr.get("indice_fragilite") or 0)
                    priorite = cr.get("priorite") or _competence_priorite_from_score(indice)
                    causes = cr.get("causes") or _build_competence_causes_from_counts({})
                    nb_postes = int(cr.get("nb_postes_impactes") or 0)
                    nb_porteurs = int(cr.get("nb_porteurs") or 0)
                    B = int(cr.get("besoin_total") or 0) or 1
                    Pd = int(cr.get("nb_porteurs_dispo") or 0)
                    Pe = int(cr.get("nb_experts") or 0)
                    Ped = int(cr.get("nb_experts_dispo") or 0)
                    Cmax = int(cr.get("criticite_max") or 0)
                    N80 = int(cr.get("nb_postes_crit_80") or 0)
                    nb_postes_sans_porteur = int(cr.get("nb_postes_couverture_absente") or 0)
                    nb_postes_porteur_unique = int(cr.get("nb_postes_dependance") or 0)

                    competence_detail_stats.update({
                        "nb_postes_impactes": int(cr.get("nb_postes_impactes") or 0),
                        "nb_postes_couverture_absente": int(cr.get("nb_postes_couverture_absente") or 0),
                        "nb_postes_non_confirmee": int(cr.get("nb_postes_non_confirmee") or 0),
                        "nb_postes_niveau_insuffisant": int(cr.get("nb_postes_niveau_insuffisant") or 0),
                        "nb_postes_dependance": int(cr.get("nb_postes_dependance") or 0),
                        "nb_postes_valides": int(cr.get("nb_postes_valides") or 0),
                        "nb_porteurs_declares": int(cr.get("nb_porteurs_declares") or 0),
                        "nb_porteurs_evalues": int(cr.get("nb_porteurs_evalues") or 0),
                        "nb_porteurs_non_evalues": max(int(cr.get("nb_porteurs_declares") or 0) - int(cr.get("nb_porteurs_evalues") or 0), 0),
                        "nb_porteurs_valides": int(cr.get("nb_porteurs_valides") or 0),
                        "besoin_total": int(cr.get("besoin_total") or 0),
                        "criticite_max": int(cr.get("criticite_max") or 0),
                        "indice_fragilite": indice,
                        "priorite": priorite,
                        "score_maitrise": int(cr.get("score_maitrise") or 0),
                        "score_concentration": int(cr.get("score_concentration") or 0),
                        "score_transmission": int(cr.get("score_transmission") or 0),
                        "score_evenements": int(cr.get("score_evenements") or 0),
                        "score_donnees": int(cr.get("score_donnees") or 0),
                    })

                    postes_state = {str(p.get("id_poste") or ""): p for p in (cr.get("postes") or [])}
                    for p in postes:
                        st = postes_state.get(str(p.get("id_poste") or ""))
                        if st:
                            p.update({
                                "besoin_poste": st.get("besoin_poste"),
                                "nb_porteurs_declares": st.get("nb_porteurs_declares"),
                                "nb_porteurs_evalues": st.get("nb_porteurs_evalues"),
                                "nb_porteurs_valides": st.get("nb_porteurs_valides"),
                                "nb_porteurs_non_evalues": st.get("nb_porteurs_non_evalues"),
                                "nb_porteurs_insuffisants": st.get("nb_porteurs_insuffisants"),
                                "etat_couverture": st.get("etat_couverture"),
                                "etat_couverture_label": st.get("etat_couverture_label"),
                                "action_rh": st.get("action_rh"),
                            })

                # IMPORTANT : l'indice affiché dans la table "Compétences critiques"
                # est calculé par la requête de détail risques (formule DRH historique :
                # besoin total, porteurs nominaux, disponibilité, exposition, sévérité).
                # Le bloc competence_detail_stats sert uniquement à enrichir le modal
                # avec la lecture RH par poste (absente / non confirmée / insuffisante / dépendance).
                # Il ne doit jamais écraser indice/priorité, sinon la table et le modal
                # racontent deux vérités différentes. Oui, on a déjà donné, c'était pénible.

                return {
                    "scope": scope,
                    "criticite_min": criticite_min,
                    "competence": {
                        "id_comp": comp.get("id_comp"),
                        "code": comp.get("code"),
                        "intitule": comp.get("intitule"),
                        "description": comp.get("description"),
                        "id_domaine_competence": comp.get("id_domaine_competence"),
                        "etat": comp.get("etat"),
                        "masque": comp.get("masque"),
                        "domaine": {
                            "id_domaine_competence": comp.get("id_domaine_competence"),
                            "titre": comp.get("titre"),
                            "titre_court": comp.get("titre_court"),
                            "couleur": comp.get("couleur"),
                        }
                    },
                    "niveaux": niveaux,
                    "stats": {
                        "nb_postes_impactes": nb_postes,
                        "nb_porteurs": nb_porteurs,
                        "nb_postes_sans_porteur": nb_postes_sans_porteur,
                        "nb_postes_porteur_unique": nb_postes_porteur_unique,

                        "besoin_total": B,
                        "nb_porteurs_dispo": Pd,

                        "nb_experts": Pe,
                        "nb_experts_dispo": Ped,

                        "criticite_max": Cmax,
                        "nb_postes_crit_80": N80,

                        "indice_fragilite": indice,
                        "priorite": priorite,
                        "score_maitrise": competence_detail_stats.get("score_maitrise", 0),
                        "score_concentration": competence_detail_stats.get("score_concentration", 0),
                        "score_transmission": competence_detail_stats.get("score_transmission", 0),
                        "score_evenements": competence_detail_stats.get("score_evenements", 0),
                        "score_donnees": competence_detail_stats.get("score_donnees", 0),
                        "nb_postes_couverture_absente": competence_detail_stats.get("nb_postes_couverture_absente", 0),
                        "nb_postes_non_confirmee": competence_detail_stats.get("nb_postes_non_confirmee", 0),
                        "nb_postes_niveau_insuffisant": competence_detail_stats.get("nb_postes_niveau_insuffisant", 0),
                        "nb_postes_dependance": competence_detail_stats.get("nb_postes_dependance", 0),
                        "nb_postes_valides": competence_detail_stats.get("nb_postes_valides", 0),
                        "nb_porteurs_declares": competence_detail_stats.get("nb_porteurs_declares", 0),
                        "nb_porteurs_evalues": competence_detail_stats.get("nb_porteurs_evalues", 0),
                        "nb_porteurs_non_evalues": competence_detail_stats.get("nb_porteurs_non_evalues", 0),
                        "nb_porteurs_valides": competence_detail_stats.get("nb_porteurs_valides", 0),

                        # Score informatif calculé depuis les états RH du modal.
                        # Ne pilote pas l'indice affiché, qui reste aligné avec la table.
                        "indice_fragilite_detail_rh": competence_detail_stats.get("indice_fragilite", 0),
                        "priorite_detail_rh": competence_detail_stats.get("priorite", None),
                    },

                    "causes": causes,
                    "postes": postes,
                    "porteurs": porteurs,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur détail compétence (risques): {str(e)}")

# ======================================================
# PDF Analyse — synthèse risques, Ishikawa, rapport
# ======================================================
def _analyse_pdf_esc(v: Any) -> str:
    from html import escape as _html_escape
    return _html_escape(str(v or "—"), quote=False)


def _analyse_pdf_safe_int(v: Any) -> int:
    try:
        return int(v or 0)
    except Exception:
        return 0




def _analyse_pdf_date_fr(value: Any) -> str:
    from datetime import date, datetime

    if value is None:
        return "—"
    if isinstance(value, datetime):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")

    raw = str(value or "").strip()
    if not raw or raw == "—":
        return "—"
    if "/" in raw and len(raw) >= 8:
        return raw
    if raw.lower().startswith("jamais"):
        return raw

    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw[:len(fmt)], fmt).strftime("%d/%m/%Y")
        except Exception:
            pass

    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).strftime("%d/%m/%Y")
    except Exception:
        return raw
def _analyse_effect_definitions() -> Dict[str, Dict[str, Any]]:
    return {
        "rupture_activite": {
            "title": "Risque de rupture ou ralentissement d’activité",
            "central_effect": "L’activité peut ralentir ou se bloquer si les compétences indispensables ne sont pas suffisamment couvertes.",
            "families": [
                "Niveau attendu non atteint",
                "Renfort potentiel insuffisant",
                "Couverture du poste insuffisante",
                "Couverture trop dépendante d’une personne",
                "Données à confirmer",
            ],
        },
        "qualite_execution": {
            "title": "Risque de baisse de qualité d’exécution",
            "central_effect": "La qualité, l’autonomie ou les délais peuvent se dégrader si la maîtrise réelle reste insuffisante.",
            "families": [
                "Écart de maîtrise",
                "Évaluations à reprendre",
                "Niveau attendu non atteint",
                "Expertise réelle à confirmer",
                "Référentiel à consolider",
            ],
        },
        "dependance_individuelle": {
            "title": "Risque de dépendance individuelle",
            "central_effect": "L’organisation dépend trop fortement de quelques personnes pour maintenir certaines compétences.",
            "families": [
                "Porteur unique",
                "Vivier interne limité",
                "Renfort potentiel insuffisant",
                "Transmission à structurer",
                "Données à confirmer",
            ],
        },
        "perte_savoir_faire": {
            "title": "Risque de perte de savoir-faire",
            "central_effect": "Un savoir-faire important peut se fragiliser ou se perdre s’il n’est pas transmis à temps.",
            "families": [
                "Expertise peu diffusée",
                "Relève interne à confirmer",
                "Transmission à organiser",
                "Compétences sensibles à anticiper",
                "Données à fiabiliser",
            ],
        },
    }

def _analyse_effect_level(score: int, count: int) -> str:
    s = _analyse_pdf_safe_int(score)
    c = _analyse_pdf_safe_int(count)
    if s >= 80 or c >= 8:
        return "Risque critique"
    if s >= 65 or c >= 5:
        return "Risque élevé"
    if s >= 35 or c > 0:
        return "Risque modéré"
    return "Risque faible"



def _analyse_report_effect_level(score: Any, count: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    c = _analyse_pdf_safe_int(count)
    if s >= 85:
        return "Risque critique"
    if s >= 65 or c >= 8:
        return "Risque élevé"
    if s >= 45 or c >= 3:
        return "Risque modéré"
    return "Risque faible"


def _analyse_report_score_color_hex(score: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    # Palette de risque : plus vive, mais toujours sémantique.
    if s >= 80:
        return "#E11D48"  # critique
    if s >= 65:
        return "#EF4444"  # élevé
    if s >= 35:
        return "#F59E0B"  # modéré
    return "#10B981"      # faible / acceptable

def _analyse_effect_color(level: str):
    from reportlab.lib import colors
    s = (level or "").lower()
    if "critique" in s:
        return colors.HexColor("#fee2e2"), colors.HexColor("#7f1d1d")
    if "élev" in s or "elev" in s:
        return colors.HexColor("#fff1f2"), colors.HexColor("#be123c")
    if "mod" in s:
        return colors.HexColor("#fff7ed"), colors.HexColor("#c2410c")
    return colors.HexColor("#ecfdf5"), colors.HexColor("#166534")



def _analyse_risk_state_label(score: Any) -> str:
    s = _analyse_pdf_safe_int(score)
    if s >= 80:
        return "Critique"
    if s >= 65:
        return "Élevé"
    if s >= 35:
        return "Modéré"
    return "Faible"


def _analyse_ishikawa_family_display_label(family: Any) -> str:
    raw = str(family or "").strip()
    labels = {
        "Niveau attendu non atteint": "Couverture insuffisante",
        "Renfort potentiel insuffisant": "Renfort insuffisant",
        "Couverture du poste insuffisante": "Postes fragiles",
        "Couverture trop dépendante d’une personne": "Porteur unique",
        "Données à confirmer": "Données à confirmer",
        "Écart de maîtrise": "Écart maîtrise",
        "Évaluations à reprendre": "Évaluations",
        "Niveau attendu non atteint": "Niveaux attendus",
        "Expertise réelle à confirmer": "Expertise à confirmer",
        "Référentiel à consolider": "Référentiel",
        "Porteur unique": "Porteur unique",
        "Vivier interne limité": "Vivier limité",
        "Transmission à structurer": "Transmission",
        "Expertise peu diffusée": "Expertise diffusée",
        "Relève interne à confirmer": "Relève interne",
        "Transmission à organiser": "Transmission",
        "Compétences sensibles à anticiper": "À anticiper",
        "Données à fiabiliser": "Données fiables",
    }
    return labels.get(raw, raw)
def _analyse_build_effect_metrics(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    horizon_years: int,
    renfort_by_poste: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    defs = _analyse_effect_definitions()

    total_couv_abs = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente")) > 0)
    total_couv_ins = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant")) > 0)
    total_couverture = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente")) > 0 or _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant")) > 0)
    total_non_conf = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee")) > 0)
    total_dep = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_dependance")) > 0)
    total_expertise_abs = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts")) <= 0)
    total_expertise_faible = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts")) <= 1)
    postes_fragiles = sum(1 for r in poste_records if _analyse_pdf_safe_int(r.get("indice_fragilite")) > 0)
    renfort_map = renfort_by_poste or {}
    total_renfort = sum(1 for _, p in renfort_map.items() if _analyse_pdf_safe_int(p.get("nb_renforts")) <= 0)

    comp_frag_score = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in comp_records) / max(1, len(comp_records)))) if comp_records else 0
    poste_frag_score = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in poste_records) / max(1, len(poste_records)))) if poste_records else 0

    raw = [
        {
            "key": "rupture_activite",
            "count": total_couverture + total_renfort + postes_fragiles + total_dep,
            "score": max(poste_frag_score, comp_frag_score),
            "metric": _analyse_pdf_count(postes_fragiles, "poste fragile", "postes fragiles"),
            "causes": [
                _analyse_pdf_count(total_couverture, "compétence critique sans couverture suffisante", "compétences critiques sans couverture suffisante") if total_couverture else "couverture critique à vérifier",
                _analyse_pdf_count(total_renfort, "poste sans renfort immédiat", "postes sans renfort immédiat") if total_renfort else "renfort immédiat à vérifier sur les postes sensibles",
                _analyse_pdf_count(postes_fragiles, "poste déjà fragilisé", "postes déjà fragilisés") if postes_fragiles else "postes sensibles à relire dans le détail",
                _analyse_pdf_count(total_dep, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne") if total_dep else "dépendance individuelle à surveiller",
            ],
        },
        {
            "key": "qualite_execution",
            "count": total_couv_ins + total_non_conf + total_couv_abs + total_expertise_abs,
            "score": comp_frag_score,
            "metric": f"{comp_frag_score}% de fragilité moyenne des compétences",
            "causes": [
                _analyse_pdf_count(total_couv_ins, "écart de maîtrise à vérifier", "écarts de maîtrise à vérifier") if total_couv_ins else "écarts de maîtrise à vérifier",
                _analyse_pdf_count(total_non_conf, "évaluation ou confirmation à reprendre", "évaluations ou confirmations à reprendre") if total_non_conf else "évaluations ou confirmations à reprendre",
                _analyse_pdf_count(total_couv_abs, "niveau attendu non couvert", "niveaux attendus non couverts") if total_couv_abs else "niveaux attendus insuffisamment couverts",
                _analyse_pdf_count(total_expertise_abs, "expertise non visible", "expertises non visibles") if total_expertise_abs else "expertise réelle à confirmer sur les situations sensibles",
            ],
        },
        {
            "key": "dependance_individuelle",
            "count": total_dep + total_renfort + total_expertise_faible,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": _analyse_pdf_count(total_dep, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne"),
            "causes": [
                _analyse_pdf_count(total_dep, "compétence portée par une seule personne", "compétences portées par une seule personne") if total_dep else "porteurs uniques à vérifier",
                _analyse_pdf_count(total_expertise_faible, "compétence avec un vivier interne limité", "compétences avec un vivier interne limité") if total_expertise_faible else "vivier interne à surveiller",
                _analyse_pdf_count(total_renfort, "poste sans renfort immédiat", "postes sans renfort immédiat") if total_renfort else "renfort immédiat à confirmer",
                _analyse_pdf_count(total_expertise_abs, "compétence sans niveau expert", "compétences sans niveau expert") if total_expertise_abs else "transmission à structurer sur les compétences clés",
            ],
        },
        {
            "key": "perte_savoir_faire",
            "count": total_expertise_abs + total_dep + total_non_conf + total_couverture,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": f"Projection à {horizon_years} an(s)",
            "causes": [
                _analyse_pdf_count(total_expertise_abs, "compétence sans niveau expert", "compétences sans niveau expert") if total_expertise_abs else "expertise à surveiller dans la durée",
                _analyse_pdf_count(total_dep, "compétence portée par une seule personne", "compétences portées par une seule personne") if total_dep else "relève interne à confirmer",
                _analyse_pdf_count(total_couverture, "compétence sensible à anticiper", "compétences sensibles à anticiper") if total_couverture else "compétences sensibles à anticiper",
                _analyse_pdf_count(total_non_conf, "donnée à fiabiliser", "données à fiabiliser") if total_non_conf else "données utiles à fiabiliser",
            ],
        },
    ]

    out = []
    for item in raw:
        d = defs[item["key"]]
        level = _analyse_effect_level(item["score"], item["count"])
        out.append({**item, **d, "level": level})
    return out

def _analyse_ishikawa_rows_for_effect(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    last_eval_map: Optional[Dict[str, Optional[str]]],
    renfort_by_poste: Optional[Dict[str, Dict[str, Any]]],
    effet: str,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    eval_map = last_eval_map or {}
    renfort_map = renfort_by_poste or {}
    effect_key = str(effet or "").strip()

    for r in comp_records:
        code = str(r.get("code") or "").strip() or "COMP"
        title = str(r.get("intitule") or "Compétence").strip()
        frag = _analyse_pdf_safe_int(r.get("indice_fragilite"))
        n_abs = _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente"))
        n_ins = _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant"))
        n_couverture = n_abs + n_ins
        n_dep = _analyse_pdf_safe_int(r.get("nb_postes_dependance"))
        n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
        n_exp = _analyse_pdf_safe_int(r.get("nb_experts"))
        n_exp_dispo = _analyse_pdf_safe_int(r.get("nb_experts_dispo"))
        nb_impactes = max(1, _analyse_pdf_safe_int(r.get("nb_postes_impactes")))
        nb_valides = _analyse_pdf_safe_int(r.get("nb_postes_valides"))
        pct_cover = int(round((float(nb_valides) / float(nb_impactes)) * 100.0)) if nb_impactes > 0 else 0
        last_eval = eval_map.get(str(r.get("id_comp") or "").strip())
        last_eval_label = last_eval or "Jamais évaluée"

        if effect_key == "rupture_activite":
            if n_couverture > 0:
                rows.append({"family": "Niveau attendu non atteint", "type": "comp", "code": code, "title": title, "value": f"{pct_cover}%", "value_label": "Couverture", "sort": frag})
            if n_dep > 0:
                rows.append({"family": "Couverture trop dépendante d’une personne", "type": "comp", "code": code, "title": title, "value": "1 porteur", "value_label": "Porteurs confirmés", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Données à confirmer", "type": "comp", "code": code, "title": title, "value": last_eval_label, "value_label": "Dernière évaluation", "sort": frag})
        elif effect_key == "qualite_execution":
            if n_ins > 0:
                rows.append({"family": "Écart de maîtrise", "type": "comp", "code": code, "title": title, "value": str(n_ins), "value_label": "Écarts", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Évaluations à reprendre", "type": "comp", "code": code, "title": title, "value": last_eval_label, "value_label": "Dernière évaluation", "sort": frag})
            if n_abs > 0:
                rows.append({"family": "Niveau attendu non atteint", "type": "comp", "code": code, "title": title, "value": f"{pct_cover}%", "value_label": "Couverture", "sort": frag})
            if n_exp <= 0:
                rows.append({"family": "Expertise réelle à confirmer", "type": "comp", "code": code, "title": title, "value": "0 expert", "value_label": "Experts", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Référentiel à consolider", "type": "comp", "code": code, "title": title, "value": "à vérifier", "value_label": "Statut", "sort": frag})
        elif effect_key == "dependance_individuelle":
            if n_dep > 0:
                rows.append({"family": "Porteur unique", "type": "comp", "code": code, "title": title, "value": "1 porteur", "value_label": "Porteurs confirmés", "sort": frag})
            if n_exp_dispo <= 1:
                rows.append({"family": "Vivier interne limité", "type": "comp", "code": code, "title": title, "value": str(n_exp_dispo), "value_label": "Experts disponibles", "sort": frag})
            if n_exp <= 0:
                rows.append({"family": "Transmission à structurer", "type": "comp", "code": code, "title": title, "value": "0 expert", "value_label": "Experts", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Données à confirmer", "type": "comp", "code": code, "title": title, "value": last_eval_label, "value_label": "Dernière évaluation", "sort": frag})
        elif effect_key == "perte_savoir_faire":
            if n_exp <= 0:
                rows.append({"family": "Expertise peu diffusée", "type": "comp", "code": code, "title": title, "value": "0 expert", "value_label": "Experts", "sort": frag})
            if n_dep > 0:
                rows.append({"family": "Relève interne à confirmer", "type": "comp", "code": code, "title": title, "value": "1 porteur", "value_label": "Relève visible", "sort": frag})
            if n_exp <= 0 or n_dep > 0:
                rows.append({"family": "Transmission à organiser", "type": "comp", "code": code, "title": title, "value": "à organiser", "value_label": "Transmission", "sort": frag})
            if n_couverture > 0:
                rows.append({"family": "Compétences sensibles à anticiper", "type": "comp", "code": code, "title": title, "value": f"{pct_cover}%", "value_label": "Couverture", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Données à fiabiliser", "type": "comp", "code": code, "title": title, "value": last_eval_label, "value_label": "Dernière évaluation", "sort": frag})

    if effect_key in ("rupture_activite", "dependance_individuelle"):
        renfort_family = "Renfort potentiel insuffisant"
        for p in poste_records or []:
            pid = str(p.get("id_poste") or "").strip()
            meta = renfort_map.get(pid) or {}
            nb_renforts = _analyse_pdf_safe_int(meta.get("nb_renforts"))
            if nb_renforts <= 0:
                rows.append({
                    "family": renfort_family,
                    "type": "poste",
                    "code": (p.get("codif_poste") or p.get("codif_client") or "POSTE").strip() or "POSTE",
                    "title": str(p.get("intitule_poste") or "Poste").strip(),
                    "value": str(nb_renforts),
                    "value_label": "Renforts > 65%",
                    "sort": _analyse_pdf_safe_int(p.get("indice_fragilite")),
                })

    if effect_key == "rupture_activite":
        for p in poste_records or []:
            frag_p = _analyse_pdf_safe_int(p.get("indice_fragilite"))
            if frag_p > 0:
                rows.append({
                    "family": "Couverture du poste insuffisante",
                    "type": "poste",
                    "code": (p.get("codif_poste") or p.get("codif_client") or "POSTE").strip() or "POSTE",
                    "title": str(p.get("intitule_poste") or "Poste").strip(),
                    "value": f"{frag_p}%",
                    "value_label": "Fragilité",
                    "sort": frag_p,
                })

    rows.sort(key=lambda x: (str(x.get("family") or ""), -_analyse_pdf_safe_int(x.get("sort")), str(x.get("title") or "")))
    return rows

def _analyse_pdf_bar(percent: int, width_mm: float = 58.0):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Table, TableStyle
    p = max(0, min(100, _analyse_pdf_safe_int(percent)))
    left = max(1, width_mm * p / 100.0) if p > 0 else 1
    right = max(1, width_mm - left)
    color = "#c1272d" if p >= 70 else ("#f59e0b" if p >= 35 else "#d1d5db")
    tbl = Table([["", ""]], colWidths=[left * mm, right * mm], rowHeights=[4 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor(color)),
        ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#f3f4f6")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return tbl




def _analyse_pdf_short(v: Any, max_len: int = 70) -> str:
    s = str(v or "—").replace("\n", " ").strip()
    if len(s) <= max_len:
        return s
    return s[: max(1, max_len - 1)].rstrip() + "…"


def _analyse_pdf_wrap_lines(v: Any, max_len: int = 26, max_lines: int = 3) -> List[str]:
    text = str(v or "").replace("\n", " ").strip()
    if not text:
        return ["—"]
    words = text.split()
    lines: List[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if len(candidate) <= max_len:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
            if len(lines) >= max_lines - 1:
                break
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    remaining = " ".join(words)
    rebuilt = " ".join(lines)
    if len(rebuilt) < len(text):
        lines[-1] = _analyse_pdf_short(lines[-1], max_len)
    return lines


def _analyse_pdf_company_name(cur, id_ent: str) -> str:
    try:
        cur.execute(
            """
            SELECT COALESCE(nom_ent, 'Entreprise') AS nom_ent
            FROM public.tbl_entreprise
            WHERE id_ent = %s
              AND COALESCE(masque, FALSE) = FALSE
            LIMIT 1
            """,
            (id_ent,),
        )
        row = cur.fetchone() or {}
        return (row.get("nom_ent") or "Entreprise").strip() or "Entreprise"
    except Exception:
        return "Entreprise"


def _analyse_pdf_logo_bytes_for_ent(cur, id_ent: str) -> Optional[bytes]:
    ent = (id_ent or "").strip()
    if not ent:
        return None
    try:
        cur.execute(
            """
            SELECT logo_bytes
            FROM public.tbl_studio_owner_logo
            WHERE id_owner = %s
              AND COALESCE(archive, FALSE) = FALSE
            ORDER BY date_maj DESC, date_creation DESC
            LIMIT 1
            """,
            (ent,),
        )
        row = cur.fetchone() or {}
        raw = row.get("logo_bytes")
        if raw is None:
            return None
        try:
            return bytes(raw)
        except Exception:
            return raw
    except Exception:
        return None


def _analyse_pdf_count(value: Any, singular: str, plural: str) -> str:
    n = _analyse_pdf_safe_int(value)
    return f"{n} {singular if n == 1 else plural}"


def _analyse_ishikawa_group_rows(rows: List[Dict[str, Any]], families: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {str(f): [] for f in (families or [])[:5]}
    for row in rows or []:
        fam = str(row.get("family") or "Données à confirmer")
        if fam not in grouped:
            if len(grouped) < 5:
                grouped[fam] = []
            else:
                fam = "Données à confirmer" if "Données à confirmer" in grouped else next(iter(grouped.keys()))
        grouped[fam].append(row)
    return grouped


def _analyse_ishikawa_family_summary(family: str, rows: List[Dict[str, Any]]) -> str:
    count = len(rows or [])
    if count <= 0:
        return "Aucun point"
    if "Renfort" in str(family or ""):
        return _analyse_pdf_count(count, "poste sans renfort", "postes sans renfort")
    if str(family or "") == "Couverture du poste insuffisante":
        return _analyse_pdf_count(count, "poste à suivre", "postes à suivre")
    if "Dépendance" in str(family or "") or "Porteur unique" in str(family or ""):
        return _analyse_pdf_count(count, "compétence concernée", "compétences concernées")
    if "Données" in str(family or "") or "Évaluation" in str(family or ""):
        return _analyse_pdf_count(count, "donnée à vérifier", "données à vérifier")
    if "Couverture" in str(family or "") or "Niveaux attendus" in str(family or ""):
        return _analyse_pdf_count(count, "couverture à revoir", "couvertures à revoir")
    if "Transmission" in str(family or "") or "Relève" in str(family or ""):
        return _analyse_pdf_count(count, "relais à préparer", "relais à préparer")
    return _analyse_pdf_count(count, "point détecté", "points détectés")

def _analyse_ishikawa_visual(effect: Dict[str, Any], rows: List[Dict[str, Any]], metric: Dict[str, Any], width_mm: float = 270.0, height_mm: float = 96.0):
    from reportlab.graphics.shapes import Drawing, Line, Rect, String, Polygon
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    width = width_mm * mm
    height = height_mm * mm
    d = Drawing(width, height)
    red = colors.HexColor("#c1272d")
    text_color = colors.HexColor("#14213d")
    muted = colors.HexColor("#64748b")
    line = colors.HexColor("#cbd5e1")
    soft_red = colors.HexColor("#fff5f5")
    soft_gray = colors.HexColor("#f8fafc")

    center_y = height * 0.49
    spine_x1 = 28 * mm
    spine_x2 = width - 66 * mm
    effect_x = width - 61 * mm
    effect_y = center_y - 16 * mm
    effect_w = 54 * mm
    effect_h = 32 * mm

    d.add(Line(spine_x1, center_y, spine_x2, center_y, strokeColor=red, strokeWidth=1.6))
    d.add(Polygon([spine_x2, center_y, spine_x2 - 5 * mm, center_y + 3 * mm, spine_x2 - 5 * mm, center_y - 3 * mm], fillColor=red, strokeColor=red))
    d.add(Rect(effect_x, effect_y, effect_w, effect_h, rx=6, ry=6, strokeColor=red, fillColor=soft_red, strokeWidth=1))
    d.add(String(effect_x + 4 * mm, effect_y + 24.5 * mm, "Effet identifié", fontName="Helvetica-Bold", fontSize=7.4, fillColor=muted))
    for idx, line_txt in enumerate(_analyse_pdf_wrap_lines(effect.get("title"), 22, 3)):
        d.add(String(effect_x + 4 * mm, effect_y + 17.5 * mm - (idx * 4.0 * mm), line_txt, fontName="Helvetica-Bold", fontSize=8.0, fillColor=text_color))
    d.add(String(effect_x + 4 * mm, effect_y + 4 * mm, _analyse_pdf_short(metric.get("level") or "Risque à qualifier", 22), fontName="Helvetica", fontSize=7.0, fillColor=red))

    grouped = _analyse_ishikawa_group_rows(rows, effect.get("families") or [])
    families = [f for f in (effect.get("families") or [])[:5]]
    coords = [
        (52 * mm, center_y + 25 * mm, True),
        (98 * mm, center_y + 25 * mm, True),
        (144 * mm, center_y + 25 * mm, True),
        (78 * mm, center_y - 36 * mm, False),
        (126 * mm, center_y - 36 * mm, False),
    ]

    for idx, fam in enumerate(families):
        if idx >= len(coords):
            break
        x_anchor, y_box, is_top = coords[idx]
        box_w = 43 * mm
        box_h = 17 * mm
        if is_top:
            d.add(Line(x_anchor, center_y, x_anchor - 10 * mm, y_box, strokeColor=line, strokeWidth=1.1))
        else:
            d.add(Line(x_anchor, center_y, x_anchor - 10 * mm, y_box + box_h, strokeColor=line, strokeWidth=1.1))

        d.add(Rect(x_anchor - 19 * mm, y_box, box_w, box_h, rx=4, ry=4, strokeColor=colors.HexColor("#e5e7eb"), fillColor=soft_gray, strokeWidth=0.8))

        title_lines = _analyse_pdf_wrap_lines(_analyse_ishikawa_family_display_label(fam), 19, 2)
        for li, title_txt in enumerate(title_lines):
            d.add(String(x_anchor - 16 * mm, y_box + 11.6 * mm - (li * 3.2 * mm), title_txt, fontName="Helvetica-Bold", fontSize=6.8, fillColor=text_color))

        summary = _analyse_ishikawa_family_summary(fam, grouped.get(fam) or [])
        summary_lines = _analyse_pdf_wrap_lines(summary, 24, 2)
        for li, line_txt in enumerate(summary_lines):
            d.add(String(x_anchor - 16 * mm, y_box + 4.3 * mm - (li * 3.0 * mm), line_txt, fontName="Helvetica", fontSize=5.8, fillColor=muted))

    return d

def _analyse_report_ring_like(title: str, value: int, color_hex: str = "#ef4444", width_mm: float = 68.0, height_mm: float = 44.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    score = max(0, min(100, _analyse_pdf_safe_int(value)))
    color = colors.HexColor(_analyse_report_score_color_hex(score))
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#e2e8f0"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.4, fillColor=colors.HexColor("#0f172a")))
    d.add(String(5 * mm, 22 * mm, f"{score}%", fontName="Helvetica-Bold", fontSize=18, fillColor=colors.HexColor("#0f172a")))
    d.add(String(5 * mm, 12 * mm, _analyse_risk_state_label(score), fontName="Helvetica", fontSize=7.4, fillColor=colors.HexColor("#64748b")))
    bar_x = 5 * mm
    bar_y = 7 * mm
    bar_w = (width_mm - 10) * mm
    d.add(Rect(bar_x, bar_y, bar_w, 4.8 * mm, rx=2.4, ry=2.4, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.HexColor("#f8fafc"), strokeWidth=0.5))
    fill_w = max(0, min(bar_w, bar_w * (score / 100.0)))
    if fill_w > 0:
        d.add(Rect(bar_x, bar_y, fill_w, 4.8 * mm, rx=2.4, ry=2.4, strokeColor=color, fillColor=color, strokeWidth=0.5))
    return d



def _analyse_report_scope_label_panel(scope: Any, nb_postes: int, nb_comps: int, horizon_years: int, criticite_min: int, width_mm: float = 270.0, height_mm: float = 6.0):
    from datetime import date
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    d = Drawing(width_mm * mm, height_mm * mm)
    perimeter = str(getattr(scope, "nom_service", None) or "Tous les services").strip() or "Tous les services"
    today = date.today().strftime("%d/%m/%Y")
    label = f"Périmètre analysé : {perimeter}   •   Date : {today}"
    d.add(String(0, 2.0 * mm, _analyse_pdf_short(label, 128), fontName="Helvetica", fontSize=8.0, fillColor=colors.HexColor("#475569")))
    return d

def _analyse_report_pie_panel(title: str, labels: List[str], data: List[int], colors_hex: List[str], width_mm: float = 132.0, height_mm: float = 62.0):
    from reportlab.graphics.shapes import Circle, Drawing, Rect, String
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    category_palette = [
        "#2563EB",  # bleu vif
        "#7C3AED",  # violet
        "#06B6D4",  # cyan
        "#10B981",  # vert moderne
        "#F97316",  # orange vif
        "#EC4899",  # rose
        "#4F46E5",  # indigo
        "#22C55E",  # vert clair
    ]

    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#E2E8F0"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.5, fillColor=colors.HexColor("#0F172A")))

    safe_data = [max(0, _analyse_pdf_safe_int(v)) for v in (data or [])]
    if sum(safe_data) <= 0:
        safe_data = [1]
        labels = ["Aucun effet"]
        palette = ["#CBD5E1"]
    else:
        palette = colors_hex or category_palette

    chart = Pie()
    chart.x = 6 * mm
    chart.y = 8 * mm
    chart.width = 42 * mm
    chart.height = 42 * mm
    chart.data = safe_data
    chart.labels = [""] * len(safe_data)
    chart.slices.strokeWidth = 0
    try:
        chart.slices.strokeColor = None
    except Exception:
        pass

    # ReportLab garde parfois un contour noir si seul strokeWidth est défini.
    # On force donc le trait de chaque part à être invisible ou identique à la part.
    for i, _v in enumerate(safe_data):
        col = colors.HexColor(palette[i % len(palette)])
        chart.slices[i].fillColor = col
        chart.slices[i].strokeWidth = 0
        chart.slices[i].strokeColor = col

    d.add(chart)

    # Faux donut compatible ReportLab : disque central blanc, sans contour.
    d.add(Circle(27 * mm, 29 * mm, 10.4 * mm, fillColor=colors.white, strokeColor=colors.white, strokeWidth=0))
    total_txt = str(sum(safe_data))
    d.add(String(27 * mm, 28 * mm, total_txt, fontName="Helvetica-Bold", fontSize=11, fillColor=colors.HexColor("#0F172A"), textAnchor="middle"))

    legend_y = height_mm * mm - 15 * mm
    for i, (lbl, val) in enumerate(list(zip(labels, safe_data))[:4]):
        y = legend_y - i * 9 * mm
        col = colors.HexColor(palette[i % len(palette)])
        d.add(Rect(58 * mm, y - 2.2 * mm, 4 * mm, 4 * mm, fillColor=col, strokeColor=col, strokeWidth=0))
        d.add(String(64 * mm, y, _analyse_pdf_short(f"{lbl}", 30), fontName="Helvetica", fontSize=7.1, fillColor=colors.HexColor("#334155")))
        d.add(String((width_mm - 8) * mm, y, str(val), fontName="Helvetica-Bold", fontSize=7.1, fillColor=colors.HexColor("#0F172A"), textAnchor="end"))

    return d

def _analyse_report_family_bars_panel(title: str, items: List[Dict[str, Any]], width_mm: float = 198.0, height_mm: float = 44.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    palette = ["#2563EB", "#7C3AED", "#06B6D4", "#10B981", "#F97316", "#EC4899", "#4F46E5", "#22C55E"]
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#E2E8F0"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.5, fillColor=colors.HexColor("#0F172A")))

    rows = (items or [])[:5]
    if not rows:
        d.add(String(5 * mm, 18 * mm, "Aucune famille de cause à afficher", fontName="Helvetica", fontSize=7.8, fillColor=colors.HexColor("#64748B")))
        return d

    max_val = max([max(1, _analyse_pdf_safe_int(r.get("count"))) for r in rows] or [1])
    y = height_mm * mm - 13.2 * mm
    step = 6.2 * mm
    bar_h = 3.1 * mm
    label_x = 5 * mm
    bar_x = 66 * mm
    bar_w = max(20 * mm, (width_mm - 88) * mm)
    value_x = (width_mm - 8) * mm

    for idx, row in enumerate(rows):
        label = _analyse_pdf_short(str(row.get("family") or "Cause"), 31)
        val = max(0, _analyse_pdf_safe_int(row.get("count")))
        color = colors.HexColor(palette[idx % len(palette)])
        d.add(String(label_x, y, label, fontName="Helvetica", fontSize=6.9, fillColor=colors.HexColor("#334155")))
        d.add(Rect(bar_x, y - 2 * mm, bar_w, bar_h, rx=1.5, ry=1.5, strokeColor=colors.HexColor("#E5E7EB"), fillColor=colors.HexColor("#F8FAFC"), strokeWidth=0.4))
        fill_w = bar_w * (val / float(max_val)) if max_val > 0 else 0
        if fill_w > 0:
            d.add(Rect(bar_x, y - 2 * mm, fill_w, bar_h, rx=1.5, ry=1.5, strokeColor=color, fillColor=color, strokeWidth=0.4))
        d.add(String(value_x, y, str(val), fontName="Helvetica-Bold", fontSize=6.9, fillColor=colors.HexColor("#0F172A"), textAnchor="end"))
        y -= step
    return d

def _analyse_report_hbars_panel(title: str, items: List[Dict[str, Any]], label_key: str, value_key: str, width_mm: float = 270.0, height_mm: float = 76.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    def _two_lines(value: Any, max_len: int = 84) -> List[str]:
        s = str(value or "—").replace("\n", " ").strip()
        if len(s) <= max_len:
            return [s]
        words = s.split()
        first = ""
        rest_words: List[str] = []
        for idx, word in enumerate(words):
            candidate = word if not first else f"{first} {word}"
            if len(candidate) <= max_len:
                first = candidate
            else:
                rest_words = words[idx:]
                break
        second = " ".join(rest_words).strip()
        if len(second) > max_len:
            second = second[: max(1, max_len - 1)].rstrip() + "…"
        return [first or s[:max_len], second] if second else [first or s[:max_len]]

    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#e2e8f0"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.8, fillColor=colors.HexColor("#0f172a")))

    shown = (items or [])[:5]
    if not shown:
        d.add(String(5 * mm, 22 * mm, "Aucune donnée à afficher", fontName="Helvetica", fontSize=8, fillColor=colors.HexColor("#64748b")))
        return d

    bar_x = 5 * mm
    bar_w = (width_mm - 18) * mm
    value_x = (width_mm - 5) * mm
    y = height_mm * mm - 16 * mm

    for row in shown:
        label_lines = _two_lines(row.get(label_key), 78)
        value = max(0, min(100, _analyse_pdf_safe_int(row.get(value_key))))
        color = colors.HexColor(_analyse_report_score_color_hex(value))

        d.add(String(5 * mm, y, label_lines[0], fontName="Helvetica", fontSize=7.4, fillColor=colors.HexColor("#334155")))
        if len(label_lines) > 1:
            d.add(String(5 * mm, y - 3.7 * mm, label_lines[1], fontName="Helvetica", fontSize=7.1, fillColor=colors.HexColor("#475569")))

        bar_y = y - (7.3 * mm if len(label_lines) > 1 else 5.2 * mm)
        d.add(Rect(bar_x, bar_y, bar_w, 3.8 * mm, rx=1.9, ry=1.9, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.HexColor("#f8fafc"), strokeWidth=0.4))
        fill_w = bar_w * (value / 100.0)
        if fill_w > 0:
            d.add(Rect(bar_x, bar_y, fill_w, 3.8 * mm, rx=1.9, ry=1.9, strokeColor=color, fillColor=color, strokeWidth=0.4))
        d.add(String(value_x, bar_y + 0.7 * mm, f"{value}%", fontName="Helvetica-Bold", fontSize=7.2, fillColor=colors.HexColor("#0f172a"), textAnchor="end"))

        y -= 12.2 * mm

    return d

def _analyse_pdf_level_card(level: str, styles: Dict[str, Any], width_mm: float = 31.0):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle
    bg, fg = _analyse_effect_color(level)
    cell_style = styles["small"].clone("RiskLevelSmall")
    cell_style.fontName = "Helvetica-Bold"
    cell_style.textColor = fg
    cell_style.alignment = 1
    tbl = Table([[Paragraph(_analyse_pdf_esc(level), cell_style)]], colWidths=[width_mm * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.6, fg),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return tbl


def _analyse_pdf_kpi_card(label: str, value: str, detail: str, width_mm: float = 67.0, height_mm: float = 24.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=5, ry=5, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(4 * mm, height_mm * mm - 6 * mm, label, fontName="Helvetica-Bold", fontSize=7.4, fillColor=colors.HexColor("#64748b")))
    for idx, line_txt in enumerate(_analyse_pdf_wrap_lines(value, 22, 2)):
        d.add(String(4 * mm, height_mm * mm - 13 * mm - (idx * 4 * mm), line_txt, fontName="Helvetica-Bold", fontSize=9.4, fillColor=colors.HexColor("#14213d")))
    d.add(String(4 * mm, 3.5 * mm, _analyse_pdf_short(detail, 28), fontName="Helvetica", fontSize=6.6, fillColor=colors.HexColor("#94a3b8")))
    return d


def _analyse_pdf_risk_gauge_card(score: int, level: str, width_mm: float = 67.0, height_mm: float = 24.0, title: str = "Niveau de risque"):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    s = max(0, min(100, _analyse_pdf_safe_int(score)))
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=5, ry=5, strokeColor=colors.HexColor("#e2e8f0"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(4 * mm, height_mm * mm - 6 * mm, str(title or "Niveau de risque"), fontName="Helvetica-Bold", fontSize=7.4, fillColor=colors.HexColor("#64748b")))

    bar_x = 4 * mm
    bar_y = 10 * mm
    bar_w = (width_mm - 8) * mm
    seg_w = bar_w / 3.0
    seg_h = 4.8 * mm
    d.add(Rect(bar_x, bar_y, seg_w, seg_h, rx=2.2, ry=2.2, fillColor=colors.HexColor("#d1fae5"), strokeColor=colors.HexColor("#a7f3d0"), strokeWidth=0.4))
    d.add(Rect(bar_x + seg_w, bar_y, seg_w, seg_h, fillColor=colors.HexColor("#fef3c7"), strokeColor=colors.HexColor("#fde68a"), strokeWidth=0.4))
    d.add(Rect(bar_x + (2 * seg_w), bar_y, seg_w, seg_h, rx=2.2, ry=2.2, fillColor=colors.HexColor("#fee2e2"), strokeColor=colors.HexColor("#fecaca"), strokeWidth=0.4))

    marker_x = bar_x + (bar_w * (s / 100.0))
    d.add(Rect(max(bar_x, marker_x - 0.7 * mm), bar_y - 1.0 * mm, 1.4 * mm, seg_h + 2.0 * mm, fillColor=colors.HexColor("#0f172a"), strokeColor=colors.HexColor("#0f172a"), strokeWidth=0.2))

    for txt, pos in (("Faible", 4 * mm), ("Modéré", 24 * mm), ("Élevé", 47 * mm)):
        d.add(String(pos, 4 * mm, txt, fontName="Helvetica", fontSize=6.3, fillColor=colors.HexColor("#64748b")))

    bg, fg = _analyse_effect_color(level)
    d.add(Rect(width_mm * mm - 25 * mm, height_mm * mm - 12 * mm, 21 * mm, 5.6 * mm, rx=2.8, ry=2.8, fillColor=bg, strokeColor=fg, strokeWidth=0.5))
    d.add(String(width_mm * mm - 23.2 * mm, height_mm * mm - 8.2 * mm, _analyse_pdf_short(level, 18), fontName="Helvetica-Bold", fontSize=6.1, fillColor=fg))
    return d

def _analyse_pdf_stat_card(label: str, value: str, detail: str, styles: Dict[str, Any], width_mm: float = 63.0):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle
    value_style = styles["body"].clone("StatValue")
    value_style.fontName = "Helvetica-Bold"
    value_style.fontSize = 13
    value_style.leading = 15
    label_style = styles["small"].clone("StatLabel")
    label_style.fontName = "Helvetica-Bold"
    tbl = Table([
        [Paragraph(_analyse_pdf_esc(label), label_style)],
        [Paragraph(_analyse_pdf_esc(value), value_style)],
        [Paragraph(_analyse_pdf_esc(detail), styles["small"])],
    ], colWidths=[width_mm * mm])
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return tbl

def _analyse_family_counts(comp_records: List[Dict[str, Any]], effects: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    counts: Dict[str, int] = {}
    for e in effects or []:
        rows = _analyse_ishikawa_rows_for_effect(comp_records, [], {}, {}, str(e.get("key") or ""))
        for row in rows:
            fam = str(row.get("family") or "Données")
            counts[fam] = counts.get(fam, 0) + 1
    return [{"family": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

def _analyse_build_context_data(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
):
    scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
    comp_records = _fetch_competence_fragility_records(cur, id_ent, scope.id_service, int(criticite_min), comp_id=None, limit=500)
    poste_records = _fetch_postes_fragility_records(cur, id_ent, scope.id_service, int(criticite_min))
    return scope, comp_records, poste_records


def _analyse_last_eval_map(cur, id_ent: str, id_service: Optional[str], comp_ids: List[str]) -> Dict[str, Optional[str]]:
    ids = [str(v or "").strip() for v in (comp_ids or []) if str(v or "").strip()]
    if not ids:
        return {}
    cte_sql, cte_params = _build_scope_cte(id_ent, (id_service or "").strip() or None)
    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT
            ec.id_comp,
            MAX(COALESCE(ec.date_derniere_eval, ac.date_audit))::date AS last_eval
        FROM public.tbl_effectif_client_competence ec
        JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
        LEFT JOIN public.tbl_effectif_client_audit_competence ac
          ON ac.id_audit_competence = ec.id_dernier_audit
         AND ac.id_effectif_competence = ec.id_effectif_competence
        WHERE ec.id_comp = ANY(%s)
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(ec.actif, TRUE) = TRUE
        GROUP BY ec.id_comp
        """,
        tuple(cte_params + [ids]),
    )
    out: Dict[str, Optional[str]] = {}
    for row in (cur.fetchall() or []):
        cid = str(row.get("id_comp") or "").strip()
        dt = row.get("last_eval")
        if cid:
            out[cid] = dt.isoformat() if hasattr(dt, "isoformat") and dt else None
    return out


def _analyse_matching_summary_by_poste(cur, id_ent: str, id_service: Optional[str], criticite_min: int, min_score: int = 65) -> Dict[str, Dict[str, Any]]:
    scope_id = (id_service or "").strip() or None
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT fp.id_poste, fp.codif_poste, COALESCE(fp.codif_client,'') AS codif_client, COALESCE(fp.intitule_poste,'') AS intitule_poste
        FROM public.tbl_fiche_poste fp
        JOIN postes_scope ps ON ps.id_poste = fp.id_poste
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
        ORDER BY fp.codif_poste, fp.intitule_poste
        """,
        tuple(cte_params + [id_ent]),
    )
    postes = [dict(r) for r in (cur.fetchall() or [])]
    poste_map = {str(r.get("id_poste") or "").strip(): r for r in postes if str(r.get("id_poste") or "").strip()}
    if not poste_map:
        return {}

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT fpc.id_poste, fpc.id_competence AS id_comp, fpc.niveau_requis, COALESCE(fpc.poids_criticite,1)::int AS poids_criticite
        FROM public.tbl_fiche_poste_competence fpc
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        WHERE COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0) >= %s
        ORDER BY fpc.id_poste
        """,
        tuple(cte_params + [int(criticite_min)]),
    )
    req_map: Dict[str, List[Dict[str, Any]]] = {}
    comp_ids: List[str] = []
    for row in (cur.fetchall() or []):
        pid = str(row.get("id_poste") or "").strip()
        cid = str(row.get("id_comp") or "").strip()
        if not pid or not cid:
            continue
        req_map.setdefault(pid, []).append({
            "id_comp": cid,
            "niveau_requis": (row.get("niveau_requis") or "").strip().upper(),
            "poids": max(1, _analyse_pdf_safe_int(row.get("poids_criticite"))),
        })
        comp_ids.append(cid)
    comp_ids = sorted(set(comp_ids))

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT e.id_effectif, COALESCE(e.id_poste_actuel,'') AS id_poste_actuel
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
        """,
        tuple(cte_params + [id_ent]),
    )
    effectifs = [dict(r) for r in (cur.fetchall() or [])]
    effectif_poste = {str(r.get("id_effectif") or "").strip(): str(r.get("id_poste_actuel") or "").strip() for r in effectifs if str(r.get("id_effectif") or "").strip()}
    if not comp_ids or not effectif_poste:
        return {pid: {"nb_renforts": 0, **meta} for pid, meta in poste_map.items()}

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT ec.id_effectif_client AS id_effectif, ec.id_comp, ac.resultat_eval
        FROM public.tbl_effectif_client_competence ec
        JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
        LEFT JOIN public.tbl_effectif_client_audit_competence ac
          ON ac.id_audit_competence = ec.id_dernier_audit
        WHERE COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND ec.id_comp = ANY(%s)
        """,
        tuple(cte_params + [comp_ids]),
    )
    scores_map: Dict[str, Dict[str, Optional[float]]] = {}
    for row in (cur.fetchall() or []):
        ide = str(row.get("id_effectif") or "").strip()
        cid = str(row.get("id_comp") or "").strip()
        if not ide or not cid:
            continue
        scores_map.setdefault(ide, {})[cid] = _safe_float(row.get("resultat_eval"))

    out: Dict[str, Dict[str, Any]] = {}
    for pid, poste in poste_map.items():
        reqs = req_map.get(pid) or []
        if not reqs:
            out[pid] = {**poste, "nb_renforts": 0}
            continue
        poids_total = sum(max(1, _analyse_pdf_safe_int(r.get("poids"))) for r in reqs) or 1
        nb = 0
        for ide, current_poste in effectif_poste.items():
            if current_poste == pid:
                continue
            eff_scores = scores_map.get(ide, {})
            if not eff_scores:
                continue
            sum_ratio = 0.0
            for req in reqs:
                score = eff_scores.get(req["id_comp"])
                seuil = _score_seuil_for_niveau(req.get("niveau_requis") or "")
                ratio = 0.0 if score is None or seuil <= 0 else min(max(score / seuil, 0.0), 1.0)
                sum_ratio += max(1, _analyse_pdf_safe_int(req.get("poids"))) * ratio
            score_pct = int(round((sum_ratio / float(poids_total)) * 100.0))
            if score_pct >= int(min_score):
                nb += 1
        out[pid] = {**poste, "nb_renforts": nb}
    return out


def _analyse_ishikawa_family_explanation(family: str) -> str:
    explanations = {
        "Niveau attendu non atteint": "Compétences critiques dont la couverture ne suffit pas à sécuriser les postes concernés.",
        "Renfort potentiel insuffisant": "Postes qui ne disposent pas d’un profil interne immédiatement proche du besoin (matching supérieur à 65%).",
        "Couverture du poste insuffisante": "Postes dont l’indice de fragilité ressort déjà dans l’analyse actuelle.",
        "Couverture trop dépendante d’une personne": "Compétences qui reposent sur une seule personne confirmée dans le périmètre analysé.",
        "Données à confirmer": "Compétences dont l’évaluation ou la confirmation doit être reprise avant décision.",
        "Écart de maîtrise": "Compétences pour lesquelles le niveau constaté reste sous le niveau attendu.",
        "Évaluations à reprendre": "Compétences déclarées mais insuffisamment confirmées par une évaluation exploitable.",
        "Niveau attendu non atteint": "Niveaux requis qui ne disposent pas d’une couverture suffisante sur les postes concernés.",
        "Expertise réelle à confirmer": "Compétences où l’expertise visible reste absente ou trop faible.",
        "Référentiel à consolider": "Points où les données de référentiel ou d’évaluation doivent être fiabilisées.",
        "Porteur unique": "Compétences portées par une seule personne confirmée.",
        "Vivier interne limité": "Compétences pour lesquelles peu de relais internes sont visibles.",
        "Transmission à structurer": "Compétences clés qui nécessitent une transmission organisée.",
        "Expertise peu diffusée": "Compétences dont le niveau expert est absent ou trop concentré.",
        "Relève interne à confirmer": "Compétences pour lesquelles la relève n’est pas suffisamment visible.",
        "Transmission à organiser": "Savoir-faire à transmettre avant perte de couverture ou départ de porteur.",
        "Compétences sensibles à anticiper": "Compétences qui peuvent fragiliser l’activité si elles ne sont pas sécurisées à temps.",
        "Données à fiabiliser": "Données RH ou évaluations à consolider avant d’en faire un support de décision.",
    }
    return explanations.get(str(family or ""), "Causes détaillées sur le périmètre analysé.")


def _analyse_ishikawa_family_columns(family: str) -> List[str]:
    s = str(family or "")
    if s == "Couverture du poste insuffisante":
        return ["Code poste", "Poste", "Fragilité", "État"]
    if "Renfort" in s:
        return ["Code poste", "Poste"]
    if "Couverture trop dépendante d’une personne" in s or s == "Porteur unique":
        return ["Code compétence", "Compétence"]
    if "Données" in s or "Évaluation" in s:
        return ["Code compétence", "Compétence", "Dernière évaluation"]
    if "Couverture" in s or "Niveaux attendus" in s:
        return ["Code compétence", "Compétence", "Couverture"]
    if "Écart" in s:
        return ["Code compétence", "Compétence", "Écarts"]
    if "Expertise" in s or "Transmission" in s or "Relève" in s or "Vivier" in s or "Dépendance" in s:
        return ["Code compétence", "Compétence", "Indication"]
    return ["Code", "Libellé", "Indication"]



def _analyse_ishikawa_row_values(family: str, row: Dict[str, Any]) -> List[str]:
    s = str(family or "")
    if s == "Couverture du poste insuffisante":
        frag = str(row.get("value") or "0%")
        return [frag, _analyse_risk_state_label(str(frag).replace("%", ""))]
    if "Renfort" in s:
        return []
    if "Couverture trop dépendante d’une personne" in s or s == "Porteur unique":
        return []
    if "Données" in s or "Évaluation" in s:
        return [_analyse_pdf_date_fr(row.get("value"))]
    return [str(row.get("value") or "—")]

def _analyse_ishikawa_col_widths(headers: List[str]) -> List[float]:
    n = len(headers or [])
    if n <= 2:
        return [31.0, 227.0]
    if n == 4:
        return [31.0, 151.0, 38.0, 38.0]
    return [31.0, 166.0, 61.0]
@router.get("/skills/analyse/ishikawa/{id_contact}")
def get_analyse_ishikawa_pdf(
    id_contact: str,
    request: Request,
    effet: str = Query(default="rupture_activite"),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    horizon_years: int = Query(default=1, ge=1, le=5),
    risk_level: Optional[str] = Query(default=None),
    risk_score: Optional[int] = Query(default=None),
    risk_count: Optional[int] = Query(default=None),
):
    try:
        from fastapi import Response
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle, PageBreak
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        effect_defs = _analyse_effect_definitions()
        effect_key = str(effet or "").strip() or "rupture_activite"
        effect = effect_defs.get(effect_key, effect_defs["rupture_activite"])

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))
                comp_ids = [str(r.get("id_comp") or "").strip() for r in comp_records if str(r.get("id_comp") or "").strip()]
                last_eval_map = _analyse_last_eval_map(cur, id_ent, scope.id_service, comp_ids)
                renfort_by_poste = _analyse_matching_summary_by_poste(cur, id_ent, scope.id_service, int(criticite_min), 65)

        rows = _analyse_ishikawa_rows_for_effect(comp_records, poste_records, last_eval_map, renfort_by_poste, effect_key)
        metrics = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years), renfort_by_poste)
        metric = next((m for m in metrics if m.get("key") == effect_key), None) or {"level": "Risque faible", "score": 0}

        clean_level = str(risk_level or "").strip()
        if clean_level in ("Risque faible", "Risque modéré", "Risque moyen", "Risque élevé", "Risque critique"):
            metric["level"] = "Risque modéré" if clean_level == "Risque moyen" else clean_level
        if risk_score is not None:
            metric["score"] = max(0, min(100, _analyse_pdf_safe_int(risk_score)))
        if risk_count is not None:
            metric["count"] = max(0, _analyse_pdf_safe_int(risk_count))

        styles = build_pdf_styles()
        title_style = styles["title"]
        body_style = styles["body"]
        section_style = styles["section"]
        small_style = styles["small"]

        def badge(code: str, kind: str = "comp"):
            fg = "#1d4ed8" if kind == "comp" else "#c2410c"
            return Paragraph(f'<font color="{fg}"><b>{_analyse_pdf_esc(code or "—")}</b></font>', small_style)

        story = []
        story.append(Paragraph("Ishikawa", title_style))
        story.append(make_spacer(2))
        meta_cards = Table([[
            _analyse_pdf_kpi_card("Effet identifié", effect["title"], "Lecture cause / effet", 66, 24),
            _analyse_pdf_kpi_card("Périmètre", scope.nom_service, "Périmètre analysé", 66, 24),
            _analyse_pdf_kpi_card("Horizon", f"{horizon_years} an(s)", "Projection retenue", 66, 24),
            _analyse_pdf_risk_gauge_card(_analyse_pdf_safe_int(metric.get("score")), str(metric.get("level") or "Risque faible"), 66, 24),
        ]], colWidths=[68 * mm, 68 * mm, 68 * mm, 68 * mm])
        meta_cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(meta_cards)
        story.append(make_spacer(3))
        story.append(Paragraph("Diagramme cause / effet", section_style))
        story.append(_analyse_ishikawa_visual(effect, rows, metric, 270.0, 96.0))

        grouped = _analyse_ishikawa_group_rows(rows, effect.get("families") or [])
        story.append(PageBreak())
        story.append(Paragraph("Détail des causes identifiées", title_style))
        story.append(make_spacer(3))

        for family in (effect.get("families") or []):
            fam_rows = grouped.get(family) or []
            story.append(Paragraph(_analyse_pdf_esc(family), section_style))
            story.append(Paragraph(_analyse_pdf_esc(_analyse_ishikawa_family_explanation(family)), small_style))
            story.append(make_spacer(2))
            if not fam_rows:
                story.append(Paragraph("Aucun point détaillé sur ce périmètre.", body_style))
                story.append(make_spacer(3))
                continue

            headers = _analyse_ishikawa_family_columns(family)
            data = [[Paragraph(_analyse_pdf_esc(h), small_style) for h in headers]]
            for row in fam_rows:
                kind = "poste" if str(row.get("type") or "") == "poste" else "comp"
                values = _analyse_ishikawa_row_values(family, row)
                data.append([
                    badge(str(row.get("code") or ""), kind),
                    Paragraph(_analyse_pdf_esc(row.get("title")), body_style),
                    *[Paragraph(_analyse_pdf_esc(v), body_style) for v in values],
                ])

            table = Table(data, colWidths=[w * mm for w in _analyse_ishikawa_col_widths(headers)], repeatRows=1)
            table.setStyle(TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#e5e7eb")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(table)
            story.append(make_spacer(4))

        pdf = build_pdf_document(story, {
            "title": f"Ishikawa - {effect['title']}",
            "footer_left": "Novoskill Insights • Ishikawa Analyse des compétences",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))
        return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="ishikawa_analyse_competences.pdf"'})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération Ishikawa analyse: {e}")

@router.get("/skills/analyse/rapport/{id_contact}")
def get_analyse_risques_report_pdf(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    horizon_years: int = Query(default=1, ge=1, le=5),
):
    try:
        from fastapi import Response
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import PageBreak, Paragraph, Table, TableStyle
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                logo_bytes = _analyse_pdf_logo_bytes_for_ent(cur, id_ent)
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))
                comp_ids = [str(r.get("id_comp") or "").strip() for r in comp_records if str(r.get("id_comp") or "").strip()]
                last_eval_map = _analyse_last_eval_map(cur, id_ent, scope.id_service, comp_ids)
                renfort_by_poste = _analyse_matching_summary_by_poste(cur, id_ent, scope.id_service, int(criticite_min), 65)

        raw_effects = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years), renfort_by_poste)
        effects = []
        family_counts: Dict[str, int] = {}
        query_params = request.query_params
        valid_levels = {"Risque faible", "Risque modéré", "Risque moyen", "Risque élevé", "Risque critique"}

        for effect in (raw_effects or []):
            key = str(effect.get("key") or "").strip()
            level = str(effect.get("level") or _analyse_effect_level(effect.get("score"), effect.get("count"))).strip()
            modal_level = str(query_params.get(f"risk_level_{key}") or "").strip()
            if modal_level in valid_levels:
                level = "Risque modéré" if modal_level == "Risque moyen" else modal_level

            effect_item = {**effect, "level": level}

            modal_score = query_params.get(f"risk_score_{key}")
            if modal_score is not None:
                effect_item["score"] = max(0, min(100, _analyse_pdf_safe_int(modal_score)))

            modal_count = query_params.get(f"risk_count_{key}")
            if modal_count is not None:
                effect_item["count"] = max(0, _analyse_pdf_safe_int(modal_count))

            effects.append(effect_item)
            rows = _analyse_ishikawa_rows_for_effect(comp_records, poste_records, last_eval_map, renfort_by_poste, key)
            grouped = _analyse_ishikawa_group_rows(rows, _analyse_effect_definitions().get(key, {}).get("families") or [])
            for family, fam_rows in grouped.items():
                if not fam_rows:
                    continue
                family_label = _analyse_ishikawa_family_display_label(family)
                family_counts[family_label] = family_counts.get(family_label, 0) + len(fam_rows)

        styles = build_pdf_styles()
        title_style = styles["title"]

        nb_postes = len(poste_records or [])
        nb_comps = len(comp_records or [])
        frag_postes = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in poste_records) / max(1, nb_postes))) if nb_postes else 0
        frag_comps = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in comp_records) / max(1, nb_comps))) if nb_comps else 0
        effects_detected = sum(1 for e in effects if _analyse_pdf_safe_int(e.get("count")) > 0)
        risk_global_score = max(frag_postes, frag_comps)
        risk_global_level = _analyse_report_effect_level(risk_global_score, effects_detected)

        effect_palette = ["#2563EB", "#7C3AED", "#06B6D4", "#10B981", "#F97316", "#EC4899", "#4F46E5", "#22C55E"]
        family_items = [{"family": k, "count": v} for k, v in sorted(family_counts.items(), key=lambda kv: (-kv[1], kv[0]))]
        top_postes = [
            {
                "label": f"{(p.get('codif_poste') or p.get('codif_client') or '').strip()} - {(p.get('intitule_poste') or 'Poste').strip()}",
                "value": _analyse_pdf_safe_int(p.get('indice_fragilite')),
            }
            for p in sorted(poste_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:5]
        ]
        top_competences = [
            {
                "label": f"{(c.get('code') or '').strip()} - {(c.get('intitule') or 'Compétence').strip()}",
                "value": _analyse_pdf_safe_int(c.get('indice_fragilite')),
            }
            for c in sorted(comp_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:5]
        ]

        story = []
        story.append(Paragraph("Rapport d’analyse des risques compétences", title_style))
        story.append(make_spacer(3))

        story.append(_analyse_report_scope_label_panel(scope, nb_postes, nb_comps, horizon_years, criticite_min, 270, 6))
        story.append(make_spacer(4))
        top_cards = Table([[
            _analyse_pdf_kpi_card("Postes analysés", str(nb_postes), "Périmètre lu", 62, 22),
            _analyse_pdf_kpi_card("Compétences analysées", str(nb_comps), "Compétences critiques retenues", 62, 22),
            _analyse_pdf_kpi_card("Effets détectés", str(effects_detected), "Effets terrain suivis", 62, 22),
            _analyse_pdf_kpi_card("Horizon", f"{horizon_years} an(s)", "Projection du rapport", 62, 22),
        ]], colWidths=[65 * mm, 65 * mm, 65 * mm, 65 * mm])
        top_cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(top_cards)
        story.append(make_spacer(5))

        row_2 = Table([[
            _analyse_report_ring_like("Fragilité moyenne des postes", frag_postes, width_mm=64, height_mm=42),
            _analyse_report_ring_like("Fragilité moyenne des compétences", frag_comps, width_mm=64, height_mm=42),
            _analyse_report_pie_panel(
                "Effets terrain détectés",
                [str(e.get("title") or "Effet") for e in effects],
                [_analyse_pdf_safe_int(e.get("count")) for e in effects],
                effect_palette,
                width_mm=132,
                height_mm=62,
            ),
        ]], colWidths=[67 * mm, 67 * mm, 138 * mm])
        row_2.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(row_2)
        story.append(make_spacer(5))

        row_3 = Table([[
            _analyse_pdf_risk_gauge_card(risk_global_score, risk_global_level, 74, 22, "Niveau de risque global"),
            _analyse_report_family_bars_panel("Familles de causes les plus présentes", family_items, 194, 44),
        ]], colWidths=[77 * mm, 195 * mm])
        row_3.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(row_3)
        story.append(make_spacer(5))

        story.append(_analyse_report_hbars_panel("Postes les plus fragiles", top_postes, "label", "value", 270, 74))
        story.append(make_spacer(4))
        story.append(_analyse_report_hbars_panel("Compétences les plus fragiles", top_competences, "label", "value", 270, 74))

        for effect in effects:
            if _analyse_pdf_safe_int(effect.get("count")) <= 0:
                continue
            story.append(PageBreak())
            story.append(Paragraph(f"Ishikawa • {effect.get('title')}", title_style))
            story.append(make_spacer(2))
            rows = _analyse_ishikawa_rows_for_effect(comp_records, poste_records, last_eval_map, renfort_by_poste, effect.get("key"))
            story.append(_analyse_ishikawa_visual(_analyse_effect_definitions().get(effect.get("key")), rows, effect, 270.0, 96.0))
            story.append(make_spacer(2))

        pdf = build_pdf_document(story, {
            "title": "Rapport d’analyse des risques compétences",
            "footer_left": "Novoskill Insights • Rapport d’analyse des risques compétences",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
            "logo_bytes": logo_bytes,
        }, page_size=landscape(A4))
        return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="rapport_analyse_risques_competences.pdf"'})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération rapport analyse: {e}")

