from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime
import json

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_context,
    skills_require_user,
    skills_validate_enterprise,
)


router = APIRouter()

NON_LIE_ID = "__NON_LIE__"

# ======================================================
# Criticité (score 0–100)
# ======================================================
CRITICITE_MIN_DEFAULT = 70   # seuil "compétence critique"
CRITICITE_MIN_MIN = 0
CRITICITE_MIN_MAX = 100


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class AnalyseRisquesTile(BaseModel):
    postes_fragiles: int = 0

    # Legacy (toujours renvoyé pour compat)
    comp_critiques_sans_porteur: int = 0
    comp_bus_factor_1: int = 0

    # KPI 2 (nouveau): compétences critiques "fragiles" (bus factor ≤ 1) en nominal (sans breaks)
    comp_critiques_fragiles: int = 0

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


class AnalysePrevisionsTile(BaseModel):
    sorties_12m: int = 0
    comp_critiques_impactees: int = 0
    postes_rouges_12m: int = 0

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
    """
    Résolution entreprise:
    - Si header X-Ent-Id présent => mode super-admin (Supabase auth obligatoire)
    - Sinon => legacy via resolve_insights_context (id_contact = id_effectif)
    """
    x_ent = ""
    try:
        x_ent = (request.headers.get("X-Ent-Id") or "").strip()
    except Exception:
        x_ent = ""

    if x_ent:
        auth = ""
        try:
            auth = request.headers.get("Authorization", "")
        except Exception:
            auth = ""

        u = skills_require_user(auth)
        if not u.get("is_super_admin"):
            raise HTTPException(status_code=403, detail="Accès refusé (X-Ent-Id réservé super-admin).")

        ent = skills_validate_enterprise(cur, x_ent)
        return ent.get("id_ent")

    ctx = resolve_insights_context(cur, id_contact)  # legacy
    return ctx["id_ent"]

def _fetch_service_label(cur, id_ent: str, id_service: Optional[str]) -> ServiceScope:
    if not id_service:
        return ServiceScope(id_service=None, nom_service="Tous les services")

    if id_service == NON_LIE_ID:
        return ServiceScope(id_service=NON_LIE_ID, nom_service="Non liés (sans service)")

    cur.execute(
        """
        SELECT o.id_service, o.nom_service
        FROM public.tbl_entreprise_organigramme o
        WHERE o.id_ent = %s
          AND o.id_service = %s
          AND o.archive = FALSE
        """,
        (id_ent, id_service),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")

    return ServiceScope(
        id_service=row["id_service"],
        nom_service=row.get("nom_service") or "Service",
    )

def _build_scope_cte(id_ent: str, id_service: Optional[str]) -> Tuple[str, List[Any]]:
    """
    Construit 2 scopes cohérents:
    - postes_scope: postes actifs dans le périmètre
    - effectifs_scope: effectifs non archivés dans le périmètre
    Périmètre:
    - None/"": toute l’entreprise
    - "__NON_LIE__": id_service NULL ou non présent dans l’organigramme actif
    - sinon: service + descendants (récursif)
    """
    if not id_service:
        cte = """
        postes_scope AS (
            SELECT fp.id_poste
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
        ),
        effectifs_scope AS (
            SELECT e.id_effectif
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
        )
        """
        return cte, [id_ent, id_ent]

    if id_service == NON_LIE_ID:
        cte = """
        valid_services AS (
            SELECT o.id_service
            FROM public.tbl_entreprise_organigramme o
            WHERE o.id_ent = %s
              AND o.archive = FALSE
        ),
        postes_scope AS (
            SELECT fp.id_poste
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
              AND (
                    fp.id_service IS NULL
                    OR fp.id_service NOT IN (SELECT id_service FROM valid_services)
              )
        ),
        effectifs_scope AS (
            SELECT e.id_effectif
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND (
                    e.id_service IS NULL
                    OR e.id_service NOT IN (SELECT id_service FROM valid_services)
              )
        )
        """
        return cte, [id_ent, id_ent, id_ent]

    cte = """
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
    ),
    postes_scope AS (
        SELECT fp.id_poste
        FROM public.tbl_fiche_poste fp
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND fp.id_service IN (SELECT id_service FROM services_scope)
    ),
    effectifs_scope AS (
        SELECT e.id_effectif
        FROM public.tbl_effectif_client e
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND e.id_service IN (SELECT id_service FROM services_scope)
    )
    """
    return cte, [id_ent, id_service, id_ent, id_ent, id_ent]

# ======================================================
# Matching helpers (/24 -> A/B/C + scoring)
# ======================================================
def _safe_float(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _score_seuil_for_niveau(niveau: Optional[str]) -> float:
    s = (niveau or "").strip().upper()
    if s == "A":
        return 6.0
    if s == "B":
        return 10.0
    if s == "C":
        return 19.0
    return 0.0


def _niveau_from_score(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    try:
        x = float(score)
    except Exception:
        return None

    # Mapping Skillboard: /24 => A/B/C
    if 6.0 <= x <= 9.0:
        return "A"
    if 10.0 <= x <= 18.0:
        return "B"
    if 19.0 <= x <= 24.0:
        return "C"
    # en-dessous de A (ou hors plage) => pas de niveau exploitable
    return None


def _clamp_int(v: int, lo: int, hi: int) -> int:
    try:
        x = int(v)
    except Exception:
        x = lo
    return max(lo, min(hi, x))


def _calc_fragility_score(nb0: int, nb1: int, nb_fragiles: int) -> int:
    """
    Copie conforme de la logique front (skills_analyse.js / calcFragilityScore)
    => score 0..100, pondérations non couverte / unique / fragilité latente.
    """
    a = int(nb0 or 0)           # N0 : non couvertes
    b = int(nb1 or 0)           # N1 : couverture unique
    f = int(nb_fragiles or 0)   # total fragiles (incluant 0/1)
    n2 = max(f - a - b, 0)      # N2 : fragiles hors 0/1

    w0, w1, w2 = 0.85, 0.60, 0.25
    risk = 1 - (pow(1 - w0, a) * pow(1 - w1, b) * pow(1 - w2, n2))
    return _clamp_int(round(risk * 100), 0, 100)


def _bucket_porteurs(n: Optional[int]) -> int:
    x = int(n or 0)
    if x <= 0:
        return 0
    if x == 1:
        return 1
    return 2


def _type_risque_from_bucket(nb_porteurs_bucket: int) -> str:
    if nb_porteurs_bucket <= 0:
        return "NON_COUVERTE"
    if nb_porteurs_bucket == 1:
        return "COUV_UNIQUE"
    return "FRAGILE"


def _reco_from_type(type_risque: str) -> str:
    if type_risque == "NON_COUVERTE":
        return "recruter"
    if type_risque == "COUV_UNIQUE":
        return "former"
    return "mutualiser"

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

                # V1: valeurs par défaut (0) => UI propre, pas d’erreur, pas de “—”
                CRITICITE_MIN = CRITICITE_MIN_DEFAULT  # score 0–100 : seuil "compétence critique"

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

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

                postes_fragiles = int(rk.get("postes_fragiles") or 0)
                comp_critiques_sans_porteur = int(rk.get("comp_critiques_sans_porteur") or 0)
                comp_porteur_unique = int(rk.get("comp_porteur_unique") or 0)
                comp_critiques_fragiles = int(rk.get("comp_critiques_fragiles") or 0)
                comp_critiques_tombent_zero_auj = int(rk.get("comp_critiques_tombent_zero_auj") or 0)

                # ---------------------------

                # Prévisions (horizons 1..5 ans)

                # Règles:

                # - Référence sortie = date_sortie_prevue si havedatefin=TRUE et date_sortie_prevue non NULL, sinon retraite_estimee

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

                            WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue

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

                      AND ee.exit_date < (CURRENT_DATE + (h.y || ' years')::interval)

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

                ),

                req_crit AS (

                    SELECT DISTINCT id_poste, id_comp

                    FROM req_all

                    WHERE poids_crit >= %s

                ),

                comps_all AS (

                    SELECT DISTINCT id_comp FROM req_all

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

                    JOIN req_all r ON TRUE

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

                    WHERE x.cov_now >= %s

                      AND x.cov_future < %s

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


                cur.execute(sql_prev, tuple(cte_params + [HORIZON_MAX, CRITICITE_MIN, COVERAGE_RED, COVERAGE_RED]))

                prev_rows = cur.fetchall() or []


                horizons = []

                for row in prev_rows:

                    horizons.append(

                        AnalysePrevisionsHorizonItem(

                            horizon_years=int(row.get("horizon_years") or 0),

                            sorties=int(row.get("sorties") or 0),

                            comp_critiques_impactees=int(row.get("comp_critiques_impactees") or 0),

                            postes_rouges=int(row.get("postes_rouges") or 0),

                        )

                    )


                h1 = next((h for h in horizons if h.horizon_years == 1), None)


                previsions_tile = AnalysePrevisionsTile(

                    sorties_12m=(h1.sorties if h1 else 0),

                    comp_critiques_impactees=(h1.comp_critiques_impactees if h1 else 0),

                    postes_rouges_12m=(h1.postes_rouges if h1 else 0),

                    horizons=horizons,

                )


                tiles = AnalyseSummaryTiles(
                    risques=AnalyseRisquesTile(
                        postes_fragiles=postes_fragiles,
                        comp_critiques_sans_porteur=comp_critiques_sans_porteur,
                        comp_bus_factor_1=comp_porteur_unique,  # UI = "Porteur unique"
                        comp_critiques_fragiles=comp_critiques_fragiles,
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
                                WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                                WHEN COALESCE(ev.havedatefin, FALSE) = FALSE THEN 'Retraite estimée'
                                ELSE COALESCE(NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), ''), '—')
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
                    AND ee.exit_date < (CURRENT_DATE + (%s || ' years')::interval)
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
                            havedatefin=bool(r.get("havedatefin")),
                            motif_sortie=(r.get("motif_sortie") or None),
                            raison_sortie=(r.get("raison_sortie") or None),
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

    nb_porteurs_now: int = 0
    nb_porteurs_sortants: int = 0
    last_exit_date: Optional[str] = None  # date du "dernier porteur" (max exit_date)


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
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                sql = f"""
                WITH
                {cte_sql},

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
                            WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                    SELECT ee.id_effectif, ee.exit_date
                    FROM effectifs_exit ee
                    WHERE ee.exit_date IS NOT NULL
                      AND ee.exit_date >= CURRENT_DATE
                      AND ee.exit_date < (CURRENT_DATE + (%s || ' years')::interval)
                ),

                req_all AS (
                    SELECT DISTINCT
                        fpc.id_poste,
                        c.id_comp,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_crit
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE c.etat = 'active'
                      AND COALESCE(c.masque, FALSE) = FALSE
                ),

                req_crit AS (
                    SELECT DISTINCT id_poste, id_comp
                    FROM req_all
                    WHERE poids_crit >= %s
                ),

                comps_crit AS (
                    SELECT DISTINCT id_comp FROM req_crit
                ),

                postes_par_comp AS (
                    SELECT
                        ra.id_comp,
                        COUNT(DISTINCT ra.id_poste)::int AS nb_postes_impactes,
                        MAX(ra.poids_crit)::int AS max_criticite
                    FROM req_all ra
                    WHERE ra.poids_crit >= %s
                    GROUP BY ra.id_comp
                ),

                porteurs_now AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_now
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comps_crit)
                    GROUP BY ec.id_comp
                ),

                leave_comp AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_leave,
                        MAX(l.exit_date) AS last_exit_date
                    FROM leaving l
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_client = l.id_effectif
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comps_crit)
                    GROUP BY ec.id_comp
                ),

                impacted AS (
                    SELECT
                        cc.id_comp,
                        COALESCE(pn.nb_now, 0)::int AS nb_now,
                        COALESCE(lc.nb_leave, 0)::int AS nb_leave,
                        lc.last_exit_date
                    FROM comps_crit cc
                    LEFT JOIN porteurs_now pn ON pn.id_comp = cc.id_comp
                    LEFT JOIN leave_comp lc ON lc.id_comp = cc.id_comp
                    WHERE COALESCE(pn.nb_now, 0) > 0
                      AND (COALESCE(pn.nb_now, 0) - COALESCE(lc.nb_leave, 0)) <= 0
                )

                SELECT
                    i.id_comp,
                    c.code,
                    c.intitule,
                    c.domaine AS id_domaine_competence,
                    COALESCE(d.titre_court, d.titre, '') AS domaine_titre_court,
                    COALESCE(d.couleur, '') AS domaine_couleur,
                    COALESCE(pp.nb_postes_impactes, 0)::int AS nb_postes_impactes,
                    COALESCE(pp.max_criticite, 0)::int AS max_criticite,
                    i.nb_now::int AS nb_porteurs_now,
                    i.nb_leave::int AS nb_porteurs_sortants,
                    i.last_exit_date
                FROM impacted i
                JOIN public.tbl_competence c ON c.id_comp = i.id_comp
                LEFT JOIN public.tbl_domaine_competence d
                  ON d.id_domaine_competence = c.domaine
                 AND COALESCE(d.masque, FALSE) = FALSE
                LEFT JOIN postes_par_comp pp ON pp.id_comp = i.id_comp
                ORDER BY
                    COALESCE(pp.nb_postes_impactes, 0) DESC,
                    COALESCE(pp.max_criticite, 0) DESC,
                    c.code
                LIMIT %s
                """

                cur.execute(sql, tuple(cte_params + [horizon_years, criticite_min, criticite_min, limit]))
                rows = cur.fetchall() or []

                items: List[AnalysePrevisionCritiqueImpacteeItem] = []
                for r in rows:
                    last_exit_date = r.get("last_exit_date")
                    if hasattr(last_exit_date, "isoformat"):
                        last_exit_date = last_exit_date.isoformat()

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
                            last_exit_date=last_exit_date,
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
                ctx = resolve_insights_context(cur, id_contact)  # id_contact = id_effectif (compat)
                id_ent = ctx["id_ent"]


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
                            WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                            WHEN COALESCE(ev.havedatefin, FALSE) = FALSE THEN 'Retraite estimée'
                            ELSE NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), '')
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
                           AND pr.exit_date < (CURRENT_DATE + (%s || ' years')::interval)
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
                                WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                                WHEN COALESCE(ev.havedatefin, FALSE) = FALSE THEN 'Retraite estimée'
                                ELSE NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), '')
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
                                horizon_end = date.today().replace(year=date.today().year + int(horizon_years))
                                if d0 >= date.today() and d0 < horizon_end:
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
    Détail KPI "Postes rouges" (prévisions):
    - postes qui BASCULENT en rouge à l'horizon (future_fragiles > 0 ET now_fragiles = 0)
    - fragile = compétence critique avec nb_porteurs <= 1
    """
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
                            WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                        END AS exit_date
                    FROM effectifs_valid ev
                ),

                effectifs_h AS (
                    SELECT
                        ee.*,
                        CASE
                          WHEN ee.exit_date IS NOT NULL
                           AND ee.exit_date >= CURRENT_DATE
                           AND ee.exit_date < (CURRENT_DATE + (%s || ' years')::interval)
                          THEN TRUE ELSE FALSE
                        END AS is_sortant
                    FROM effectifs_exit ee
                ),

                req AS (
                    SELECT
                        fp.id_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        cp.id_competence AS id_comp,
                        cp.poids_criticite::int AS criticite,
                        COALESCE(cp.niveau_requis,'')::text AS niveau_requis
                    FROM public.tbl_fiche_poste fp
                    JOIN public.tbl_fiche_poste_competence cp ON cp.id_poste = fp.id_poste
                    WHERE fp.id_ent = %s
                      AND COALESCE(fp.actif, TRUE) = TRUE
                      AND (NULLIF(%s::text,'') IS NULL OR fp.id_service = NULLIF(%s::text,''))
                      AND COALESCE(cp.poids_criticite,0) >= %s
                ),

                cov AS (
                    SELECT
                        r.id_poste,
                        r.intitule_poste,
                        r.id_service,
                        r.id_comp,
                        r.criticite,

                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE
                                ec.id_effectif_client IS NOT NULL
                                AND COALESCE(ec.niveau_actuel,'') <> ''
                                AND (
                                    (r.niveau_requis = '' )
                                    OR (r.niveau_requis = 'A' AND ec.niveau_actuel IN ('A','B','C'))
                                    OR (r.niveau_requis = 'B' AND ec.niveau_actuel IN ('B','C'))
                                    OR (r.niveau_requis = 'C' AND ec.niveau_actuel IN ('C'))
                                )
                        ) AS nb_now,

                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE
                                ec.id_effectif_client IS NOT NULL
                                AND COALESCE(ec.niveau_actuel,'') <> ''
                                AND (
                                    (r.niveau_requis = '' )
                                    OR (r.niveau_requis = 'A' AND ec.niveau_actuel IN ('A','B','C'))
                                    OR (r.niveau_requis = 'B' AND ec.niveau_actuel IN ('B','C'))
                                    OR (r.niveau_requis = 'C' AND ec.niveau_actuel IN ('C'))
                                )
                                AND COALESCE(eh.is_sortant, FALSE) = FALSE
                        ) AS nb_remain,

                        MIN(eh.exit_date) FILTER (WHERE COALESCE(eh.is_sortant, FALSE) = TRUE) AS next_exit_comp

                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                    LEFT JOIN effectifs_h eh
                      ON eh.id_effectif = ec.id_effectif_client
                    GROUP BY r.id_poste, r.intitule_poste, r.id_service, r.id_comp, r.criticite
                ),

                agg AS (
                    SELECT
                        c.id_poste,
                        c.intitule_poste,
                        c.id_service,

                        SUM(CASE WHEN c.nb_now <= 1 THEN 1 ELSE 0 END)::int AS now_fragiles,
                        SUM(CASE WHEN c.nb_now = 0 THEN 1 ELSE 0 END)::int AS now_sans_porteur,
                        SUM(CASE WHEN c.nb_now = 1 THEN 1 ELSE 0 END)::int AS now_porteur_unique,

                        SUM(CASE WHEN c.nb_remain <= 1 THEN 1 ELSE 0 END)::int AS future_fragiles,
                        SUM(CASE WHEN c.nb_remain = 0 THEN 1 ELSE 0 END)::int AS future_sans_porteur,
                        SUM(CASE WHEN c.nb_remain = 1 THEN 1 ELSE 0 END)::int AS future_porteur_unique,

                        MIN(c.next_exit_comp) AS next_exit_date
                    FROM cov c
                    GROUP BY c.id_poste, c.intitule_poste, c.id_service
                )

                SELECT
                    a.id_poste,
                    a.intitule_poste,
                    a.id_service,
                    COALESCE(o.nom_service,'') AS nom_service,

                    a.now_fragiles,
                    a.future_fragiles,
                    a.future_sans_porteur,
                    a.future_porteur_unique,

                    a.next_exit_date
                FROM agg a
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = %s
                 AND o.id_service = a.id_service
                 AND o.archive = FALSE
                WHERE a.future_fragiles > 0
                ORDER BY a.future_fragiles DESC, a.next_exit_date NULLS LAST, a.intitule_poste ASC
                LIMIT %s
                """

                params = tuple(
                    cte_params
                    + [
                        horizon_years,                 # effectifs_h
                        id_ent,                        # req fp.id_ent
                        scope.id_service, scope.id_service,  # service filter
                        criticite_min,                 # criticite min
                        id_ent,                        # join organigramme
                        limit,
                    ]
                )

                cur.execute(sql, params)
                rows = cur.fetchall() or []

                def _fmt(d):
                    return d.isoformat() if hasattr(d, "isoformat") else d

                items = []
                for r in rows:
                    items.append({
                        "id_poste": (r.get("id_poste") or "").strip(),
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "now_fragiles": int(r.get("now_fragiles") or 0),
                        "future_fragiles": int(r.get("future_fragiles") or 0),
                        "future_sans_porteur": int(r.get("future_sans_porteur") or 0),
                        "future_porteur_unique": int(r.get("future_porteur_unique") or 0),
                        "next_exit_date": _fmt(r.get("next_exit_date")),
                    })

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
    Modal Poste rouge: Synthèse + Causes (compétences) + Porteurs à risque + Couverture & alternatives + Postes voisins
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

                # Poste (sécurise appartenance entreprise)
                cur.execute(
                    """
                    SELECT
                      fp.id_poste,
                      fp.intitule_poste,
                      fp.id_service,
                      COALESCE(o.nom_service,'') AS nom_service
                    FROM public.tbl_fiche_poste fp
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = fp.id_ent
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
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
                        "kpis": {
                            "future_fragiles": 0,
                            "future_sans_porteur": 0,
                            "future_porteur_unique": 0,
                            "next_exit_date": None,
                        },
                        "causes": [],
                        "sortants": [],
                        "couverture": [],
                        "voisins": [],
                    }

                # =========
                # CTE commun
                # =========
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
                effectifs_exit AS (
                    SELECT
                        ev.*,
                        CASE
                            WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
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
                            WHEN COALESCE(ev.havedatefin, FALSE) = FALSE THEN 'Retraite estimée'
                            ELSE NULLIF(BTRIM(COALESCE(ev.motif_sortie, '')), '')
                        END AS raison_sortie
                    FROM effectifs_valid ev
                ),
                effectifs_h AS (
                    SELECT
                        ee.*,
                        CASE
                          WHEN ee.exit_date IS NOT NULL
                           AND ee.exit_date >= CURRENT_DATE
                           AND ee.exit_date < (CURRENT_DATE + (%s::int * interval '1 year'))
                          THEN TRUE ELSE FALSE
                        END AS is_sortant
                    FROM effectifs_exit ee
                )
                """

                # ======================================
                # 1) Couverture par compétence du poste
                # ======================================
                cov_sql = f"""
                {base_cte},
                req AS (
                    SELECT
                        fp.id_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        cp.id_competence AS id_comp,
                        cp.poids_criticite::int AS criticite,
                        COALESCE(cp.niveau_requis,'')::text AS niveau_requis
                    FROM public.tbl_fiche_poste fp
                    JOIN public.tbl_fiche_poste_competence cp ON cp.id_poste = fp.id_poste
                    WHERE fp.id_ent = %s
                      AND fp.id_poste = %s
                      AND COALESCE(fp.actif, TRUE) = TRUE
                      AND COALESCE(cp.poids_criticite,0) >= %s
                ),
                cov AS (
                    SELECT
                        r.id_poste,
                        r.intitule_poste,
                        r.id_service,
                        r.id_comp,
                        r.criticite,
                        r.niveau_requis,

                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE
                                ec.id_effectif_client IS NOT NULL
                                AND COALESCE(ec.niveau_actuel,'') <> ''
                                AND (
                                    (r.niveau_requis = '' )
                                    OR (
                                      r.niveau_requis = 'A' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('A','B','C')
                                    )
                                    OR (
                                      r.niveau_requis = 'B' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('B','C')
                                    )
                                    OR (
                                      r.niveau_requis = 'C' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('C')
                                    )
                                )
                        ) AS nb_now,

                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE
                                ec.id_effectif_client IS NOT NULL
                                AND COALESCE(ec.niveau_actuel,'') <> ''
                                AND COALESCE(eh.is_sortant, FALSE) = FALSE
                                AND (
                                    (r.niveau_requis = '' )
                                    OR (
                                      r.niveau_requis = 'A' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('A','B','C')
                                    )
                                    OR (
                                      r.niveau_requis = 'B' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('B','C')
                                    )
                                    OR (
                                      r.niveau_requis = 'C' AND (
                                        CASE
                                          WHEN upper(ec.niveau_actuel) IN ('C','EXPERT','MAITRISE','MAÎTRISE','SENIOR') THEN 'C'
                                          WHEN upper(ec.niveau_actuel) IN ('B','CONFIRME','CONFIRMÉ','INTERMEDIAIRE','INTERMÉDIAIRE') THEN 'B'
                                          WHEN upper(ec.niveau_actuel) IN ('A','DEBUTANT','DÉBUTANT','JUNIOR') THEN 'A'
                                          ELSE upper(ec.niveau_actuel)
                                        END
                                      ) IN ('C')
                                    )
                                )
                        ) AS nb_remain,

                        MIN(eh.exit_date) FILTER (WHERE COALESCE(eh.is_sortant, FALSE) = TRUE) AS next_exit_comp

                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                    LEFT JOIN effectifs_h eh
                      ON eh.id_effectif = ec.id_effectif_client
                    GROUP BY r.id_poste, r.intitule_poste, r.id_service, r.id_comp, r.criticite, r.niveau_requis
                )
                SELECT
                    c.id_comp,
                    c.criticite,
                    c.niveau_requis,
                    c.nb_now,
                    c.nb_remain,
                    c.next_exit_comp,

                    comp.code,
                    comp.intitule,
                    comp.domaine AS id_domaine_competence,
                    COALESCE(d.titre,'') AS domaine_titre,
                    COALESCE(d.titre_court,'') AS domaine_titre_court,
                    d.couleur AS domaine_couleur

                FROM cov c
                JOIN public.tbl_competence comp ON comp.id_comp = c.id_comp
                LEFT JOIN public.tbl_domaine_competence d ON d.id_domaine_competence = comp.domaine
                ORDER BY c.criticite DESC, c.nb_remain ASC, c.next_exit_comp NULLS LAST, comp.code ASC
                """

                cov_params = tuple(
                    cte_params
                    + [
                        horizon_years,   # effectifs_h
                        id_ent,          # req fp.id_ent
                        id_poste,        # req fp.id_poste
                        criticite_min,   # criticite min
                    ]
                )
                cur.execute(cov_sql, cov_params)
                cov_rows = cur.fetchall() or []

                # KPIs poste
                future_fragiles = 0
                future_sans_porteur = 0
                future_porteur_unique = 0
                next_exit_date = None

                causes = []
                for r in cov_rows:
                    nb_remain = int(r.get("nb_remain") or 0)
                    nb_now = int(r.get("nb_now") or 0)
                    nx = r.get("next_exit_comp")
                    if hasattr(nx, "isoformat"):
                        nx = nx.isoformat()

                    is_fragile = (nb_remain <= 1)
                    if is_fragile:
                        future_fragiles += 1
                        if nb_remain == 0:
                            future_sans_porteur += 1
                        elif nb_remain == 1:
                            future_porteur_unique += 1

                        if nx:
                            if (next_exit_date is None) or (str(nx) < str(next_exit_date)):
                                next_exit_date = nx

                        causes.append({
                            "id_competence": (r.get("id_comp") or "").strip(),
                            "code": (r.get("code") or "").strip() or "—",
                            "intitule": (r.get("intitule") or "").strip() or "—",
                            "criticite": int(r.get("criticite") or 0),
                            "niveau_requis": (r.get("niveau_requis") or "").strip() or "",
                            "nb_now": nb_now,
                            "nb_remain": nb_remain,
                            "next_exit_date": nx,
                            "domaine_titre": (r.get("domaine_titre") or "").strip() or "—",
                            "domaine_titre_court": (r.get("domaine_titre_court") or "").strip() or "—",
                            "domaine_couleur": r.get("domaine_couleur"),
                            "impact_type": ("Sans porteur" if nb_remain == 0 else "Porteur unique"),
                        })

                # ======================
                # 2) Porteurs à risque
                # ======================
                sortants_sql = f"""
                {base_cte},
                req AS (
                    SELECT
                        cp.id_competence AS id_comp,
                        cp.poids_criticite::int AS criticite,
                        COALESCE(cp.niveau_requis,'')::text AS niveau_requis
                    FROM public.tbl_fiche_poste_competence cp
                    WHERE cp.id_poste = %s
                      AND COALESCE(cp.poids_criticite,0) >= %s
                ),
                cov AS (
                    SELECT
                        r.id_comp,
                        r.criticite,
                        r.niveau_requis,
                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE ec.id_effectif_client IS NOT NULL
                              AND COALESCE(ec.niveau_actuel,'') <> ''
                              AND COALESCE(eh.is_sortant, FALSE) = FALSE
                        ) AS nb_remain
                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                    LEFT JOIN effectifs_h eh
                      ON eh.id_effectif = ec.id_effectif_client
                    GROUP BY r.id_comp, r.criticite, r.niveau_requis
                ),
                causes AS (
                    SELECT * FROM cov WHERE nb_remain <= 1
                )
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
                    comp.domaine AS id_domaine_competence,

                    COALESCE(ec.niveau_actuel,'')::text AS niveau_actuel,
                    cs.criticite,
                    cs.niveau_requis

                FROM causes cs
                JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = cs.id_comp
                JOIN effectifs_h eh ON eh.id_effectif = ec.id_effectif_client
                JOIN public.tbl_competence comp ON comp.id_comp = cs.id_comp
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = %s
                 AND o.id_service = eh.id_service
                 AND o.archive = FALSE
                LEFT JOIN public.tbl_fiche_poste p
                  ON p.id_poste = eh.id_poste_actuel
                WHERE COALESCE(eh.is_sortant, FALSE) = TRUE
                ORDER BY eh.exit_date ASC NULLS LAST, eh.nom_effectif ASC, eh.prenom_effectif ASC, comp.code ASC
                LIMIT %s
                """

                sort_params = tuple(
                    cte_params
                    + [
                        horizon_years,    # effectifs_h
                        id_poste,         # req
                        criticite_min,    # req criticite
                        id_ent,           # organigramme
                        limit_sortants,
                    ]
                )
                cur.execute(sortants_sql, sort_params)
                sort_rows = cur.fetchall() or []

                def _fmt(d):
                    return d.isoformat() if hasattr(d, "isoformat") else d

                sortants = []
                for r in sort_rows:
                    full = (f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}").strip() or "—"
                    sortants.append({
                        "full": full,
                        "exit_date": _fmt(r.get("exit_date")),
                        "raison_sortie": (r.get("raison_sortie") or "").strip() or None,
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "id_competence": (r.get("id_competence") or "").strip(),
                        "code": (r.get("code") or "").strip() or "—",
                        "intitule": (r.get("intitule") or "").strip() or "—",
                        "niveau_actuel": (r.get("niveau_actuel") or "").strip() or None,
                        "criticite": int(r.get("criticite") or 0),
                        "niveau_requis": (r.get("niveau_requis") or "").strip() or "",
                    })

                # ======================
                # 3) Couverture restants
                # ======================
                couverture_sql = f"""
                {base_cte},
                req AS (
                    SELECT
                        cp.id_competence AS id_comp,
                        cp.poids_criticite::int AS criticite,
                        COALESCE(cp.niveau_requis,'')::text AS niveau_requis
                    FROM public.tbl_fiche_poste_competence cp
                    WHERE cp.id_poste = %s
                      AND COALESCE(cp.poids_criticite,0) >= %s
                ),
                cov AS (
                    SELECT
                        r.id_comp,
                        r.criticite,
                        r.niveau_requis,
                        COUNT(DISTINCT eh.id_effectif) FILTER (
                            WHERE ec.id_effectif_client IS NOT NULL
                              AND COALESCE(ec.niveau_actuel,'') <> ''
                              AND COALESCE(eh.is_sortant, FALSE) = FALSE
                        ) AS nb_remain
                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                    LEFT JOIN effectifs_h eh
                      ON eh.id_effectif = ec.id_effectif_client
                    GROUP BY r.id_comp, r.criticite, r.niveau_requis
                ),
                causes AS (
                    SELECT * FROM cov WHERE nb_remain <= 1
                )
                SELECT
                    cs.id_comp,
                    cs.criticite,
                    cs.niveau_requis,
                    cs.nb_remain,

                    comp.code,
                    comp.intitule,
                    comp.domaine AS id_domaine_competence,

                    eh.id_effectif,
                    eh.prenom_effectif,
                    eh.nom_effectif,
                    COALESCE(o.nom_service,'') AS nom_service,
                    COALESCE(p.intitule_poste,'') AS intitule_poste,
                    COALESCE(ec.niveau_actuel,'')::text AS niveau_actuel

                FROM causes cs
                LEFT JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = cs.id_comp
                LEFT JOIN effectifs_h eh ON eh.id_effectif = ec.id_effectif_client
                LEFT JOIN public.tbl_competence comp ON comp.id_comp = cs.id_comp
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = %s
                 AND o.id_service = eh.id_service
                 AND o.archive = FALSE
                LEFT JOIN public.tbl_fiche_poste p
                  ON p.id_poste = eh.id_poste_actuel
                WHERE COALESCE(eh.is_sortant, FALSE) = FALSE
                ORDER BY comp.code ASC, eh.nom_effectif ASC, eh.prenom_effectif ASC
                LIMIT %s
                """

                cov_params2 = tuple(
                    cte_params
                    + [
                        horizon_years,
                        id_poste,
                        criticite_min,
                        id_ent,
                        limit_couverture,
                    ]
                )
                cur.execute(couverture_sql, cov_params2)
                cov2_rows = cur.fetchall() or []

                couverture = []
                for r in cov2_rows:
                    full = (f"{(r.get('prenom_effectif') or '').strip()} {(r.get('nom_effectif') or '').strip()}").strip() or "—"
                    couverture.append({
                        "id_competence": (r.get("id_comp") or "").strip(),
                        "code": (r.get("code") or "").strip() or "—",
                        "intitule": (r.get("intitule") or "").strip() or "—",
                        "criticite": int(r.get("criticite") or 0),
                        "niveau_requis": (r.get("niveau_requis") or "").strip() or "",
                        "nb_remain": int(r.get("nb_remain") or 0),

                        "full": full,
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "niveau_actuel": (r.get("niveau_actuel") or "").strip() or None,
                    })

                # ======================
                # 4) Postes voisins (similarité exigences)
                # ======================
                voisins_sql = """
                WITH base_set AS (
                  SELECT DISTINCT cp.id_competence AS id_comp
                  FROM public.tbl_fiche_poste_competence cp
                  WHERE cp.id_poste = %s
                    AND COALESCE(cp.poids_criticite,0) >= %s
                ),
                base_cnt AS (
                  SELECT COUNT(*)::int AS n FROM base_set
                ),
                other AS (
                  SELECT fp.id_poste, fp.intitule_poste, fp.id_service
                  FROM public.tbl_fiche_poste fp
                  WHERE fp.id_ent = %s
                    AND COALESCE(fp.actif, TRUE) = TRUE
                    AND fp.id_poste <> %s
                ),
                other_set AS (
                  SELECT o.id_poste, cp.id_competence AS id_comp
                  FROM other o
                  JOIN public.tbl_fiche_poste_competence cp ON cp.id_poste = o.id_poste
                  WHERE COALESCE(cp.poids_criticite,0) >= %s
                ),
                other_cnt AS (
                  SELECT id_poste, COUNT(DISTINCT id_comp)::int AS n
                  FROM other_set
                  GROUP BY id_poste
                ),
                inter AS (
                  SELECT os.id_poste, COUNT(DISTINCT os.id_comp)::int AS inter_n
                  FROM other_set os
                  JOIN base_set bs ON bs.id_comp = os.id_comp
                  GROUP BY os.id_poste
                )
                SELECT
                  o.id_poste,
                  o.intitule_poste,
                  o.id_service,
                  COALESCE(org.nom_service,'') AS nom_service,
                  COALESCE(i.inter_n,0)::int AS overlap,
                  bc.n AS base_n,
                  oc.n AS other_n,
                  CASE
                    WHEN (bc.n + oc.n - COALESCE(i.inter_n,0)) > 0
                    THEN (COALESCE(i.inter_n,0)::numeric / (bc.n + oc.n - COALESCE(i.inter_n,0))::numeric)
                    ELSE 0
                  END AS jaccard
                FROM other o
                CROSS JOIN base_cnt bc
                LEFT JOIN other_cnt oc ON oc.id_poste = o.id_poste
                LEFT JOIN inter i ON i.id_poste = o.id_poste
                LEFT JOIN public.tbl_entreprise_organigramme org
                  ON org.id_ent = %s
                 AND org.id_service = o.id_service
                 AND org.archive = FALSE
                WHERE COALESCE(i.inter_n,0) > 0
                ORDER BY overlap DESC, jaccard DESC, o.intitule_poste ASC
                LIMIT %s
                """
                cur.execute(
                    voisins_sql,
                    (
                        id_poste,
                        criticite_min,
                        id_ent,
                        id_poste,
                        criticite_min,
                        id_ent,
                        limit_voisins,
                    ),
                )
                voisins_rows = cur.fetchall() or []
                voisins = []
                for r in voisins_rows:
                    voisins.append({
                        "id_poste": (r.get("id_poste") or "").strip(),
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "overlap": int(r.get("overlap") or 0),
                        "jaccard": float(r.get("jaccard") or 0),
                    })

                return {
                    "scope": scope.model_dump() if hasattr(scope, "model_dump") else scope,
                    "horizon_years": int(horizon_years),
                    "criticite_min": int(criticite_min),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "poste": {
                        "id_poste": (poste_row.get("id_poste") or "").strip(),
                        "intitule_poste": (poste_row.get("intitule_poste") or "").strip() or "—",
                        "nom_service": (poste_row.get("nom_service") or "").strip() or "—",
                    },
                    "kpis": {
                        "future_fragiles": int(future_fragiles),
                        "future_sans_porteur": int(future_sans_porteur),
                        "future_porteur_unique": int(future_porteur_unique),
                        "next_exit_date": next_exit_date,
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


    
# ======================================================
# Models: Détail Risques
# ======================================================
class AnalyseRisqueItem(BaseModel):
    # Poste (pour "postes-fragiles")
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

    nb_critiques_sans_releve: Optional[int] = None
    nb_critiques_releve_faible: Optional[int] = None
    nb_titulaires_cible: Optional[int] = None
    gap_titulaires: Optional[int] = None
    indice_fragilite: Optional[int] = None


    # Compétence (pour "critiques-sans-porteur" et "porteur-unique")
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

    # Enrichissement "critiques-fragiles" (KPI 2)
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


# ======================================================
# Endpoint: Détail Risques (selon KPI)
# ======================================================
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
        if limit > 200:
            limit = 200

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # Base: compétences requises + porteurs (dans le scope)
                base_cte = f"""
                WITH
                {cte_sql},
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
                )

                """

                items: list[AnalyseRisqueItem] = []

                # ---------------------------
                # KPI: Postes fragiles
                # ---------------------------
                if k == "postes-fragiles":
                    sql = base_cte + """
                    ,
                    poste_info AS (
                        SELECT
                            fp.id_poste,
                            COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
                            COALESCE(prh.statut_poste, 'actif')::text AS statut_poste,
                            prh.date_debut_validite,
                            prh.date_fin_validite,

                            COALESCE(fp.niveau_education_minimum, '')::text AS niveau_education_minimum,

                            -- Rang minimal: stockage numérique (ex: "3", "4", "5"...)
                            CASE
                                WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$'
                                    THEN trim(fp.niveau_education_minimum)::int
                                ELSE 0
                                END AS edu_min_rank,


                            -- Domaine NSF (bloquant si nsf_domaine_obligatoire OU nsf_groupe_obligatoire)
                            (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
                            COALESCE(nd.titre, '')::text AS nsf_domaine_titre

                        FROM public.tbl_fiche_poste fp
                        JOIN postes_scope ps ON ps.id_poste = fp.id_poste
                        LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
                        LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
                    ),

                    req_crit AS (
                        SELECT *
                        FROM req
                        WHERE poids_criticite >= %s
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

                    porteurs_poste AS (
                        SELECT
                            rc.id_poste,
                            rc.id_comp,

                            (COUNT(DISTINCT e.id_effectif) FILTER (
                              WHERE
                                -- Compétence qualifiée (niveau actuel >= requis)
                                (
                                  CASE upper(trim(COALESCE(rc.niveau_requis, '')))
                                    WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 0
                                  END
                                ) <=
                                (
                                  CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
                                    WHEN 'initial' THEN 1
                                    WHEN 'avancé' THEN 2 WHEN 'avance' THEN 2 WHEN 'avancee' THEN 2 WHEN 'avancée' THEN 2
                                    WHEN 'expert' THEN 3
                                    ELSE 0
                                  END
                                )

                                -- NSF domaine bloquant si demandé
                                AND (
                                  NOT pi.nsf_domain_required
                                  OR (
                                    lower(trim(COALESCE(e.domaine_education, ''))) = lower(trim(COALESCE(pi.nsf_domaine_titre, '')))
                                    AND COALESCE(pi.nsf_domaine_titre, '') <> ''
                                  )
                                )

                                -- Niveau d'éducation minimum bloquant (stockage numérique côté effectif)
                                AND (
                                    pi.edu_min_rank = 0
                                    OR (
                                        CASE
                                        WHEN trim(COALESCE(e.niveau_education, '')) ~ '^[0-9]+$'
                                            THEN trim(e.niveau_education)::int
                                        ELSE 0
                                        END
                                    ) >= pi.edu_min_rank
                                )

                            ))::int AS nb_porteurs_total,

                            (COUNT(DISTINCT e.id_effectif) FILTER (
                              WHERE
                                (
                                  CASE upper(trim(COALESCE(rc.niveau_requis, '')))
                                    WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 0
                                  END
                                ) <=
                                (
                                  CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
                                    WHEN 'initial' THEN 1
                                    WHEN 'avancé' THEN 2 WHEN 'avance' THEN 2 WHEN 'avancee' THEN 2 WHEN 'avancée' THEN 2
                                    WHEN 'expert' THEN 3
                                    ELSE 0
                                  END
                                )
                                AND (
                                  NOT pi.nsf_domain_required
                                  OR (
                                    lower(trim(COALESCE(e.domaine_education, ''))) = lower(trim(COALESCE(pi.nsf_domaine_titre, '')))
                                    AND COALESCE(pi.nsf_domaine_titre, '') <> ''
                                  )
                                )
                                AND (
                                    pi.edu_min_rank = 0
                                    OR (
                                        CASE
                                        WHEN trim(COALESCE(e.niveau_education, '')) ~ '^[0-9]+$'
                                            THEN trim(e.niveau_education)::int
                                        ELSE 0
                                        END
                                    ) >= pi.edu_min_rank
                                )

                                AND e.id_poste_actuel = rc.id_poste
                            ))::int AS nb_porteurs_titulaires

                        FROM req_crit rc
                        JOIN poste_info pi ON pi.id_poste = rc.id_poste
                        JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = rc.id_comp
                        JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                        JOIN public.tbl_effectif_client e ON e.id_effectif = ec.id_effectif_client
                        WHERE COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.actif, TRUE) = TRUE
                        GROUP BY rc.id_poste, rc.id_comp
                    ),

                    poste_agg AS (
                        SELECT
                            ps.id_poste,

                            COALESCE(t.nb_titulaires, 0)::int AS nb_titulaires,
                            COALESCE(pi.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
                            GREATEST(0, COALESCE(pi.nb_titulaires_cible, 1) - COALESCE(t.nb_titulaires, 0))::int AS gap_titulaires,

                            SUM(CASE WHEN rc.id_comp IS NOT NULL AND COALESCE(pp.nb_porteurs_total, 0) = 0 THEN 1 ELSE 0 END)::int AS nb_critiques_sans_porteur,
                            SUM(CASE WHEN rc.id_comp IS NOT NULL AND COALESCE(pp.nb_porteurs_total, 0) = 1 THEN 1 ELSE 0 END)::int AS nb_critiques_porteur_unique,
                            SUM(CASE WHEN rc.id_comp IS NOT NULL AND COALESCE(pp.nb_porteurs_total, 0) <= 1 THEN 1 ELSE 0 END)::int AS nb_critiques_fragiles,

                            SUM(CASE
                                  WHEN rc.id_comp IS NOT NULL
                                   AND COALESCE(pp.nb_porteurs_total, 0) >= 2
                                   AND GREATEST(COALESCE(pp.nb_porteurs_total, 0) - COALESCE(pp.nb_porteurs_titulaires, 0), 0) = 0
                                  THEN 1 ELSE 0
                                END)::int AS nb_critiques_sans_releve,

                            SUM(CASE
                                  WHEN rc.id_comp IS NOT NULL
                                   AND COALESCE(pp.nb_porteurs_total, 0) >= 2
                                   AND GREATEST(COALESCE(pp.nb_porteurs_total, 0) - COALESCE(pp.nb_porteurs_titulaires, 0), 0) = 1
                                  THEN 1 ELSE 0
                                END)::int AS nb_critiques_releve_faible,

                            pi.statut_poste,
                            pi.date_debut_validite,
                            pi.date_fin_validite

                        FROM postes_scope ps
                        JOIN poste_info pi ON pi.id_poste = ps.id_poste
                        LEFT JOIN req_crit rc ON rc.id_poste = ps.id_poste
                        LEFT JOIN porteurs_poste pp ON pp.id_poste = rc.id_poste AND pp.id_comp = rc.id_comp
                        LEFT JOIN titulaires t ON t.id_poste = ps.id_poste
                        GROUP BY ps.id_poste, t.nb_titulaires, pi.nb_titulaires_cible, pi.statut_poste, pi.date_debut_validite, pi.date_fin_validite
                    )

                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,

                        pa.nb_critiques_fragiles,
                        pa.nb_critiques_sans_porteur,
                        pa.nb_critiques_porteur_unique,
                        pa.nb_titulaires,

                        pa.nb_critiques_sans_releve,
                        pa.nb_critiques_releve_faible,
                        pa.nb_titulaires_cible,
                        pa.gap_titulaires,

                        CASE
                          WHEN pa.nb_titulaires = 0 THEN 100
                          ELSE LEAST(100, GREATEST(0,
                            ROUND(
                              100 * (
                                1
                                - POWER((1 - 0.90)::numeric, pa.nb_critiques_sans_porteur)
                                * POWER((1 - 0.65)::numeric, pa.nb_critiques_porteur_unique)
                                * POWER((1 - 0.35)::numeric, pa.nb_critiques_sans_releve)
                                * POWER((1 - 0.18)::numeric, pa.nb_critiques_releve_faible)
                                * POWER((1 - 0.30)::numeric, pa.gap_titulaires)
                              )
                            )
                          ))::int
                        END AS indice_fragilite

                    FROM poste_agg pa
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = pa.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE

                    WHERE
                      -- Exclure les postes en pause (gelé/temporaire) si la période couvre aujourd'hui (NULL = indéfini)
                      NOT (
                        lower(COALESCE(pa.statut_poste, 'actif')) IN ('gele','temporaire')
                        AND (pa.date_debut_validite IS NULL OR pa.date_debut_validite <= CURRENT_DATE)
                        AND (pa.date_fin_validite IS NULL OR pa.date_fin_validite >= CURRENT_DATE)
                      )
                      AND (
                        pa.nb_titulaires = 0
                        OR pa.nb_critiques_sans_porteur > 0
                        OR pa.nb_critiques_porteur_unique > 0
                        OR pa.nb_critiques_sans_releve > 0
                        OR pa.nb_critiques_releve_faible > 0
                        OR pa.gap_titulaires > 0
                      )

                    ORDER BY
                      indice_fragilite DESC,
                      pa.nb_titulaires ASC,
                      pa.nb_critiques_sans_porteur DESC,
                      pa.nb_critiques_porteur_unique DESC,
                      pa.nb_critiques_sans_releve DESC,
                      pa.gap_titulaires DESC,
                      fp.codif_poste,
                      fp.intitule_poste
                    LIMIT %s
                    """

                    cur.execute(
                        sql,
                        tuple(cte_params + [criticite_min, id_ent, limit])
                    )
                    rows = cur.fetchall() or []
                    for r in rows:
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
                            nb_critiques_sans_releve=int(r.get("nb_critiques_sans_releve") or 0),
                            nb_critiques_releve_faible=int(r.get("nb_critiques_releve_faible") or 0),
                            nb_titulaires_cible=int(r.get("nb_titulaires_cible") or 1),
                            gap_titulaires=int(r.get("gap_titulaires") or 0),
                            indice_fragilite=int(r.get("indice_fragilite") or 0),

                        ))


                # ---------------------------
                # KPI: Tous les postes (scope)
                # ---------------------------
                elif k == "postes-scope":
                    sql = base_cte + """
                    ,
                    poste_agg AS (
                        SELECT
                            ps.id_poste,
                            SUM(CASE WHEN r.id_comp IS NOT NULL AND r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) <= 1 THEN 1 ELSE 0 END)::int AS nb_critiques_fragiles,
                            SUM(CASE WHEN r.id_comp IS NOT NULL AND r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 0 THEN 1 ELSE 0 END)::int AS nb_critiques_sans_porteur,
                            SUM(CASE WHEN r.id_comp IS NOT NULL AND r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 1 THEN 1 ELSE 0 END)::int AS nb_critiques_porteur_unique
                        FROM postes_scope ps
                        LEFT JOIN req r ON r.id_poste = ps.id_poste
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        GROUP BY ps.id_poste
                    )
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        pa.nb_critiques_fragiles,
                        pa.nb_critiques_sans_porteur,
                        pa.nb_critiques_porteur_unique
                    FROM poste_agg pa
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = pa.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    ORDER BY
                        pa.nb_critiques_sans_porteur DESC,
                        pa.nb_critiques_porteur_unique DESC,
                        pa.nb_critiques_fragiles DESC,
                        fp.codif_poste,
                        fp.intitule_poste
                    LIMIT %s
                    """
                    cur.execute(
                        sql,
                        tuple(cte_params + [criticite_min, criticite_min, criticite_min, id_ent, limit])
                    )
                    rows = cur.fetchall() or []
                    for r in rows:
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
                        ))

                # ---------------------------
                # KPI: Critiques fragiles (≤ 1 porteur en nominal)
                # ---------------------------
                # ---------------------------
                # KPI: Critiques fragiles (≤ 1 porteur en nominal)
                # ---------------------------
                elif k == "critiques-fragiles":
                    sql = base_cte + """
                    ,
                    req_crit AS (
                        SELECT DISTINCT
                            r.id_poste,
                            r.id_comp,
                            r.poids_criticite
                        FROM req r
                        WHERE r.poids_criticite >= %s
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

                    poste_need AS (
                        SELECT
                            ps.id_poste,
                            CASE
                                WHEN prh.nb_titulaires_cible IS NOT NULL AND prh.nb_titulaires_cible::int > 0
                                    THEN prh.nb_titulaires_cible::int
                                WHEN COALESCE(t.nb_titulaires, 0)::int > 0
                                    THEN COALESCE(t.nb_titulaires, 0)::int
                                ELSE 1
                            END AS besoin_poste
                        FROM postes_scope ps
                        LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = ps.id_poste
                        LEFT JOIN titulaires t ON t.id_poste = ps.id_poste
                    ),

                    comp_need AS (
                        SELECT
                            rc.id_comp,
                            MAX(rc.poids_criticite)::int AS criticite_max,
                            COUNT(DISTINCT rc.id_poste)::int AS nb_postes_impactes,
                            SUM(pn.besoin_poste)::int AS besoin_total,
                            SUM(CASE WHEN rc.poids_criticite >= 80 THEN 1 ELSE 0 END)::int AS nb_postes_crit_80
                        FROM req_crit rc
                        JOIN poste_need pn ON pn.id_poste = rc.id_poste
                        GROUP BY rc.id_comp
                    ),

                    experts AS (
                        SELECT
                            ec.id_comp,
                            COUNT(DISTINCT ec.id_effectif_client)::int AS nb_experts
                        FROM public.tbl_effectif_client_competence ec
                        JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                        WHERE COALESCE(ec.actif, TRUE) = TRUE
                          AND COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.id_comp, '') <> ''
                          AND (
                            CASE
                              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                                THEN trim(ec.niveau_actuel)::int
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 3
                              ELSE 0
                            END
                          ) >= 3
                        GROUP BY ec.id_comp
                    ),

                    experts_dispo AS (
                        SELECT
                            ec.id_comp,
                            COUNT(DISTINCT ec.id_effectif_client)::int AS nb_experts
                        FROM public.tbl_effectif_client_competence ec
                        JOIN effectifs_dispo ed ON ed.id_effectif = ec.id_effectif_client
                        WHERE COALESCE(ec.actif, TRUE) = TRUE
                          AND COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.id_comp, '') <> ''
                          AND (
                            CASE
                              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                                THEN trim(ec.niveau_actuel)::int
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 3
                              ELSE 0
                            END
                          ) >= 3
                        GROUP BY ec.id_comp
                    ),

                    comp_agg AS (
                        SELECT
                            cn.id_comp,
                            cn.nb_postes_impactes,
                            cn.besoin_total,
                            cn.criticite_max,
                            cn.nb_postes_crit_80,

                            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs,
                            COALESCE(pd.nb_porteurs, 0)::int AS nb_porteurs_dispo,

                            COALESCE(ex.nb_experts, 0)::int AS nb_experts,
                            COALESCE(exd.nb_experts, 0)::int AS nb_experts_dispo
                        FROM comp_need cn
                        LEFT JOIN porteurs p ON p.id_comp = cn.id_comp
                        LEFT JOIN porteurs_dispo pd ON pd.id_comp = cn.id_comp
                        LEFT JOIN experts ex ON ex.id_comp = cn.id_comp
                        LEFT JOIN experts_dispo exd ON exd.id_comp = cn.id_comp
                        WHERE COALESCE(p.nb_porteurs, 0) <= 1
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.grille_evaluation,
                        c.domaine AS id_domaine_competence,
                        d.titre,
                        d.titre_court,
                        d.couleur,

                        ca.nb_postes_impactes,
                        ca.nb_porteurs,
                        ca.nb_porteurs_dispo,
                        ca.nb_experts,
                        ca.nb_experts_dispo,
                        ca.besoin_total,
                        ca.criticite_max,
                        ca.nb_postes_crit_80
                    FROM comp_agg ca
                    JOIN public.tbl_competence c ON c.id_comp = ca.id_comp
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    ORDER BY
                        ca.nb_porteurs ASC,
                        ca.nb_porteurs_dispo ASC,
                        ca.nb_postes_impactes DESC,
                        ca.criticite_max DESC,
                        c.code
                    LIMIT %s
                    """

                    cur.execute(sql, tuple(cte_params + [criticite_min, limit]))
                    rows = cur.fetchall() or []

                    def _clamp(v: float, lo: float, hi: float) -> float:
                        return max(lo, min(hi, v))

                    for r in rows:
                        B = int(r.get("besoin_total") or 0)
                        B = B if B > 0 else 1

                        P = int(r.get("nb_porteurs") or 0)
                        Pd = int(r.get("nb_porteurs_dispo") or 0)

                        Pe = int(r.get("nb_experts") or 0)
                        Ped = int(r.get("nb_experts_dispo") or 0)

                        N = int(r.get("nb_postes_impactes") or 0)
                        Cmax = int(r.get("criticite_max") or 0)
                        N80 = int(r.get("nb_postes_crit_80") or 0)

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
                            prio = "P1"
                        elif indice >= 50:
                            prio = "P2"
                        else:
                            prio = "P3"

                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("titre"),
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),

                            nb_postes_impactes=N,
                            nb_porteurs=P,
                            nb_porteurs_dispo=Pd,

                            besoin_total=B,
                            nb_experts=Pe,
                            nb_experts_dispo=Ped,
                            criticite_max=Cmax,
                            nb_postes_crit_80=N80,

                            max_criticite=Cmax,          # compat existant
                            indice_fragilite=indice,     # 0..100 (règle métier)
                            priorite=prio,
                            priorite_score=indice,       # tri simple
                        ))

                    # Tri DRH-friendly: d’abord les plus urgentes
                    items.sort(key=lambda x: (-(x.priorite_score or 0), -(x.nb_postes_impactes or 0), (x.code or "")))



                # ---------------------------
                # KPI: Critiques sans porteur
                # ---------------------------
                elif k == "critiques-sans-porteur":
                    sql = base_cte + """
                    ,
                    comp_agg AS (
                        SELECT
                            r.id_comp,
                            MAX(r.poids_criticite)::int AS max_criticite,
                            COUNT(DISTINCT r.id_poste)::int AS nb_postes_impactes,
                            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs
                        FROM req r
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        WHERE r.poids_criticite >= %s
                          AND COALESCE(p.nb_porteurs, 0) = 0
                        GROUP BY r.id_comp, COALESCE(p.nb_porteurs, 0)
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.grille_evaluation,
                        c.domaine AS id_domaine_competence,
                        d.titre,
                        d.titre_court,
                        d.couleur,
                        ca.nb_postes_impactes,
                        ca.nb_porteurs,
                        ca.max_criticite
                    FROM comp_agg ca
                    JOIN public.tbl_competence c ON c.id_comp = ca.id_comp
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    ORDER BY
                        ca.nb_postes_impactes DESC,
                        ca.max_criticite DESC,
                        c.code
                    LIMIT %s
                    """
                    cur.execute(sql, tuple(cte_params + [criticite_min, limit]))
                    rows = cur.fetchall() or []
                    for r in rows:
                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("titre"),
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            nb_porteurs=int(r.get("nb_porteurs") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                        ))

                # ---------------------------
                # KPI: Porteur unique
                # ---------------------------
                else:
                    sql = base_cte + """
                    ,
                    comp_agg AS (
                        SELECT
                            r.id_comp,
                            MAX(r.poids_criticite)::int AS max_criticite,
                            COUNT(DISTINCT r.id_poste)::int AS nb_postes_impactes,
                            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs
                        FROM req r
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        WHERE r.poids_criticite >= %s
                          AND COALESCE(p.nb_porteurs, 0) = 1
                        GROUP BY r.id_comp, COALESCE(p.nb_porteurs, 0)
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.grille_evaluation,
                        c.domaine AS id_domaine_competence,
                        d.titre,
                        d.titre_court,
                        d.couleur,
                        ca.nb_postes_impactes,
                        ca.nb_porteurs,
                        ca.max_criticite
                    FROM comp_agg ca
                    JOIN public.tbl_competence c ON c.id_comp = ca.id_comp
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    ORDER BY
                        ca.nb_postes_impactes DESC,
                        ca.max_criticite DESC,
                        c.code
                    LIMIT %s
                    """
                    cur.execute(sql, tuple(cte_params + [criticite_min, limit]))
                    rows = cur.fetchall() or []
                    for r in rows:
                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("titre"),
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            nb_porteurs=int(r.get("nb_porteurs") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                        ))

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


class AnalysePosteDependanceItem(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    intitule: Optional[str] = None
    poids_criticite: Optional[int] = None

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


class AnalysePosteEfficaciteItem(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    intitule: Optional[str] = None
    poids_criticite: Optional[int] = None
    niveau_requis: Optional[str] = None

    nb_en_defaut: int = 0
    nb_titulaires: int = 0


class AnalysePosteCausesRacines(BaseModel):
    structure: Optional[AnalysePosteCauseStructurelle] = None
    dependance: List[AnalysePosteDependanceItem] = []
    transmission: Optional[AnalysePosteTransmissionCause] = None
    efficacite: List[AnalysePosteEfficaciteItem] = []


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

    etat: str = "missing"  # ok / under / missing
    is_critique: bool = False

    criteres: List[AnalyseMatchingCritere] = []


class AnalyseMatchingPerson(BaseModel):
    id_effectif: str
    full: str
    nom_service: str
    id_poste_actuel: Optional[str] = None
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
    - porteurs par compétence avec niveau_actuel (Initial/Avancé/Expert)
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
                    WITH {cte_sql}
                    SELECT
                      COUNT(DISTINCT e.id_effectif)::int AS pool_total,

                      COUNT(DISTINCT CASE
                        WHEN (
                          %s <= 0
                          OR (
                            CASE
                              WHEN COALESCE(e.niveau_education, '') ~ '^[0-9]+$' THEN e.niveau_education::int
                              ELSE 0
                            END
                          ) >= %s
                        ) THEN e.id_effectif
                      END)::int AS pool_diplome_ok,

                      COUNT(DISTINCT CASE
                        WHEN (
                          %s = FALSE
                          OR COALESCE(e.domaine_education, '') = COALESCE(%s, '')
                        ) THEN e.id_effectif
                      END)::int AS pool_domaine_ok,

                      COUNT(DISTINCT CASE
                        WHEN (
                          (
                            %s <= 0
                            OR (
                              CASE
                                WHEN COALESCE(e.niveau_education, '') ~ '^[0-9]+$' THEN e.niveau_education::int
                                ELSE 0
                              END
                            ) >= %s
                          )
                          AND (
                            %s = FALSE
                            OR COALESCE(e.domaine_education, '') = COALESCE(%s, '')
                          )
                        ) THEN e.id_effectif
                      END)::int AS pool_eligible

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
                    """,
                    tuple(cte_params + [
                        edu_min_rank, edu_min_rank,
                        dom_bloq, dom_title,
                        edu_min_rank, edu_min_rank,
                        dom_bloq, dom_title,
                        id_ent,
                    ]),
                )
                pool = cur.fetchone() or {}
                pool_total = int(pool.get("pool_total") or 0)
                pool_diplome_ok = int(pool.get("pool_diplome_ok") or 0)
                pool_domaine_ok = int(pool.get("pool_domaine_ok") or 0)
                pool_eligible = int(pool.get("pool_eligible") or 0)


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
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN ec.niveau_actuel ILIKE '%%init%%' THEN 1
                              WHEN ec.niveau_actuel ILIKE '%%avan%%' THEN 2
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 3
                              WHEN TRIM(ec.niveau_actuel) ~ '^[0-9]+$' THEN ec.niveau_actuel::int
                              ELSE 0
                            END AS act_rank,

                            CASE
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'A' THEN 1
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'B' THEN 2
                              WHEN UPPER(TRIM(r.niveau_requis)) = 'C' THEN 3
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
                        JOIN pool_all_effectifs ef
                          ON ef.id_effectif = ec.id_effectif_client
                        WHERE COALESCE(ec.actif, TRUE) = TRUE
                          AND COALESCE(ec.archive, FALSE) = FALSE
                    ),
                    ec_ok AS (
                        SELECT
                            *,
                            CASE
                              WHEN req_rank > 0 THEN (act_rank >= req_rank)
                              ELSE (act_rank > 0)
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
                    ]),
                )

                rows = cur.fetchall() or []


                nb0 = 0
                nb1 = 0
                nb_r0 = 0
                nb_r1 = 0

                candidates: list[AnalysePosteTopRisqueItem] = []
                dep_items: list[AnalysePosteDependanceItem] = []
                eff_items: list[AnalysePosteEfficaciteItem] = []

                # Couverture minimale “dirigeant-friendly” :
                # - au moins 2 porteurs (bus factor) même si la cible = 1
                # - sinon, au moins la cible titulaires
                seuil_couv = max(2, int(nb_cible or 1))

                for r in rows:
                    n_ok_all = int(r.get("nb_ok_all") or 0)
                    n_ok = int(r.get("nb_ok") or 0)  # AVEC contraintes (diplôme/domaine), utilisé pour l’indice
                    n_ok_tit_all = int(r.get("nb_ok_titulaires_all") or 0)
                    n_ok_tit = int(r.get("nb_ok_titulaires") or 0)  # AVEC contraintes
                    n_releve = max(n_ok - n_ok_tit, 0)

                    # --- Causes racines : Risque de dépendance (porteurs au niveau requis, dans le scope)
                    if n_ok_all < seuil_couv:
                        dep_items.append(
                            AnalysePosteDependanceItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                nb_porteurs_ok=n_ok_all,
                                seuil_couverture=seuil_couv,
                                type_risque=("SANS_PORTEUR" if n_ok_all <= 0 else "COUVERTURE_LIMITEE"),
                            )
                        )

                    # --- Causes racines : Risque d’efficacité (titulaires en défaut vs niveau requis)
                    if nb_titulaires > 0:
                        nb_defaut = max(int(nb_titulaires) - n_ok_tit_all, 0)
                        if nb_defaut > 0:
                            eff_items.append(
                                AnalysePosteEfficaciteItem(
                                    id_comp=r.get("id_comp"),
                                    code_comp=r.get("code"),
                                    intitule=r.get("intitule"),
                                    poids_criticite=int(r.get("poids_criticite") or 0),
                                    niveau_requis=r.get("niveau_requis"),
                                    nb_en_defaut=nb_defaut,
                                    nb_titulaires=int(nb_titulaires),
                                )
                            )

                    # --- Indice fragilité (historique) : basé sur “nb_ok” (avec contraintes)
                    type_risque = "OK"
                    reco = None

                    if n_ok <= 0:
                        type_risque = "NON_COUVERTE"
                        reco = "recruter"
                        nb0 += 1
                    elif n_ok == 1:
                        type_risque = "COUV_UNIQUE"
                        reco = "mutualiser"
                        nb1 += 1
                    else:
                        if n_releve == 0:
                            type_risque = "SANS_RELEVE"
                            reco = "mutualiser"
                            nb_r0 += 1
                        elif n_releve == 1:
                            type_risque = "RELEVE_FAIBLE"
                            reco = "mutualiser"
                            nb_r1 += 1

                    if type_risque != "OK":
                        candidates.append(
                            AnalysePosteTopRisqueItem(
                                id_comp=r.get("id_comp"),
                                code_comp=r.get("code"),
                                intitule=r.get("intitule"),
                                poids_criticite=int(r.get("poids_criticite") or 0),
                                type_risque=type_risque,
                                nb_porteurs=n_ok,
                                nb_ok=n_ok,
                                recommandation=reco,
                            )
                        )


                nb_total_fragiles = nb0 + nb1 + nb_r0 + nb_r1
                nb_evenements = nb_total_fragiles + (1 if gap > 0 else 0)

                # Indice fragilité (0..100) : cohérent “table”
                if nb_titulaires <= 0:
                    score = 100
                else:
                    w0 = 0.90
                    w1 = 0.65
                    wr0 = 0.35
                    wr1 = 0.18
                    wt = 0.30

                    risk = 1 - (pow(1 - w0, nb0)
                                * pow(1 - w1, nb1)
                                * pow(1 - wr0, nb_r0)
                                * pow(1 - wr1, nb_r1)
                                * pow(1 - wt, gap))
                    score = int(max(0, min(100, round(risk * 100))))

                # Tri top 8 (ordre “gravité”)
                order = {"NON_COUVERTE": 0, "COUV_UNIQUE": 1, "SANS_RELEVE": 2, "RELEVE_FAIBLE": 3}
                candidates.sort(
                    key=lambda c: (
                        order.get(c.type_risque or "OK", 9),
                        -(int(c.poids_criticite or 0)),
                        str(c.code_comp or ""),
                    )
                )
                top_risques = candidates[: int(limit or 8)]

                 # Causes racines (pour l’accordéon du modal)
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
                if edu_min_rank > 0 and pool_diplome_ok <= 0:
                    raisons.append("Aucune ressource ne possède le niveau de diplôme requis.")
                if dom_bloq and pool_domaine_ok <= 0:
                    raisons.append("Aucune ressource n'a suivi la formation initiale requise.")

                nb_pot = max(pool_total - pool_eligible, 0)
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

                causes = AnalysePosteCausesRacines(
                    structure=structure,
                    dependance=dep_items,
                    transmission=transmission,
                    efficacite=eff_items,
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
                        fp.id_poste, fp.codif_poste, fp.intitule_poste, fp.id_service,
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
                crit_min = int(criticite_min)

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

                        if score is None:
                            nb_missing += 1
                            if w >= crit_min:
                                crit_missing += 1
                            ratio = 0.0
                        else:
                            if seuil > 0 and score < seuil:
                                nb_under += 1
                                if w >= crit_min:
                                    crit_under += 1

                            ratio = 0.0
                            if seuil > 0:
                                ratio = min(max(score / seuil, 0.0), 1.0)

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
                    SELECT fp.id_poste, fp.codif_poste, fp.intitule_poste
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
                    """,
                    tuple(cte_params + [id_poste]),
                )
                req_rows = cur.fetchall() or []
                if not req_rows:
                    return AnalyseMatchingEffectifResponse(
                        poste={
                            "id_poste": poste.get("id_poste"),
                            "codif_poste": poste.get("codif_poste"),
                            "intitule_poste": poste.get("intitule_poste"),
                        },
                        person=AnalyseMatchingPerson(
                            id_effectif=id_effectif,
                            full=full,
                            nom_service=(e.get("nom_service") or "").strip() or "—",
                            id_poste_actuel=poste_actuel,
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
                crit_min = int(criticite_min)

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
                    etat = "ok"
                    if score is None:
                        etat = "missing"
                        nb_missing += 1
                        if is_crit:
                            crit_missing += 1
                        ratio = 0.0
                    else:
                        if seuil > 0 and score < seuil:
                            etat = "under"
                            nb_under += 1
                            if is_crit:
                                crit_under += 1
                        ratio = 0.0
                        if seuil > 0:
                            ratio = min(max(float(score) / float(seuil), 0.0), 1.0)

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
                            niveau_atteint=_niveau_from_score(score),
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
                        "intitule_poste": poste.get("intitule_poste"),
                    },
                    person=AnalyseMatchingPerson(
                        id_effectif=id_effectif,
                        full=full,
                        nom_service=(e.get("nom_service") or "").strip() or "—",
                        id_poste_actuel=poste_actuel,
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
                    p.intitule_poste,
                    p.id_service,
                    COALESCE(o.nom_service,'') AS nom_service,

                    fpc.niveau_requis,
                    fpc.poids_criticite,

                    COALESCE(pc.nb_porteurs,0)::int AS nb_porteurs
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
                      AND {svc_filter_eff}
                    GROUP BY e.id_poste_actuel
                ) pc
                  ON pc.id_poste = p.id_poste
                WHERE
                    p.id_ent = %s
                    AND COALESCE(p.actif, TRUE) = TRUE
                    AND {svc_filter_poste}
                    AND c.id_comp = %s
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
                postes = cur.fetchall() or []

                # --- Porteurs (tous porteurs dans le périmètre)
                sql_porteurs = f"""
                {with_clause}
                SELECT
                    e.id_effectif,
                    e.prenom_effectif,
                    e.nom_effectif,
                    ec.niveau_actuel,

                    e.id_service,
                    COALESCE(o.nom_service,'') AS nom_service,

                    e.id_poste_actuel,
                    COALESCE(p.codif_poste,'') AS codif_poste,
                    COALESCE(p.intitule_poste,'') AS intitule_poste
                FROM public.tbl_effectif_client_competence ec
                JOIN public.tbl_effectif_client e
                  ON e.id_effectif = ec.id_effectif_client
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = e.id_ent
                 AND o.id_service = e.id_service
                 AND o.archive = FALSE
                LEFT JOIN public.tbl_fiche_poste p
                  ON p.id_poste = e.id_poste_actuel
                WHERE
                    e.id_ent = %s
                    AND COALESCE(e.archive,FALSE) = FALSE
                    AND ec.id_comp = %s
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
                porteurs = cur.fetchall() or []

                # --- Stats rapides (sur postes)
                nb_postes = len(postes)
                nb_porteurs = len(porteurs)
                nb_postes_sans_porteur = sum(1 for p in postes if int(p.get("nb_porteurs") or 0) == 0)
                nb_postes_porteur_unique = sum(1 for p in postes if int(p.get("nb_porteurs") or 0) == 1)

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
                    "stats": {
                        "nb_postes_impactes": nb_postes,
                        "nb_porteurs": nb_porteurs,
                        "nb_postes_sans_porteur": nb_postes_sans_porteur,
                        "nb_postes_porteur_unique": nb_postes_porteur_unique,
                    },
                    "postes": postes,
                    "porteurs": porteurs,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur détail compétence (risques): {str(e)}")