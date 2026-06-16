from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from collections import defaultdict
from datetime import datetime
import json

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
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
    return resolve_insights_id_ent_for_request(cur, id_contact, request)

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
# Matching helpers (/24 -> A/B/C/D + scoring)
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
        return 12.0
    if s == "C":
        return 18.0
    if s == "D":
        return 24.0
    return 0.0


def _niveau_from_score(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    try:
        x = float(score)
    except Exception:
        return None

    # Score normalisé /24 -> 4 niveaux
    if x <= 6.0:
        return "A"
    if x <= 12.0:
        return "B"
    if x <= 18.0:
        return "C"
    if x <= 24.0:
        return "D"
    return "D"


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

def _normalize_poste_statut(value: Any) -> str:
    s = (value or "").strip().lower()
    if not s:
        return "actif"
    repl = (
        ("é", "e"), ("è", "e"), ("ê", "e"), ("ë", "e"),
        ("à", "a"), ("â", "a"), ("ä", "a"),
        ("î", "i"), ("ï", "i"),
        ("ô", "o"), ("ö", "o"),
        ("ù", "u"), ("û", "u"), ("ü", "u"),
        ("ç", "c"),
    )
    for a, b in repl:
        s = s.replace(a, b)
    return s


def _is_poste_statut_excluded(value: Any) -> bool:
    return _normalize_poste_statut(value) in ("gele", "archive")


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None or v == "":
            return int(default)
        return int(v)
    except Exception:
        return int(default)


def _education_rank(v: Any) -> int:
    s = str(v or "").strip()
    return int(s) if s.isdigit() else 0


def _niveau_rank(v: Any) -> int:
    s = str(v or "").strip().lower()
    s = (s.replace("é", "e").replace("è", "e").replace("ê", "e")
           .replace("à", "a").replace("ç", "c"))
    if s in ("a", "1", "initial", "debutant") or s.startswith("deb") or s.startswith("init"):
        return 1
    if s in ("b", "2", "intermediaire") or s.startswith("inter"):
        return 2
    if s in ("c", "3", "avance", "avancee") or s.startswith("avan"):
        return 3
    if s in ("d", "4", "expert") or s.startswith("exp"):
        return 4
    return 0


def _score_structure_gap(gap: int) -> int:
    g = max(int(gap or 0), 0)
    if g <= 0:
        return 0
    if g == 1:
        return 15
    if g == 2:
        return 30
    return 45


def _score_transmission(pool_total: Any, pool_eligible: Any) -> int:
    total = max(_safe_int(pool_total, 0), 0)
    elig = max(_safe_int(pool_eligible, 0), 0)
    if total <= 0:
        return 0
    if elig <= 0:
        return 5
    if elig < total:
        return 3
    return 0


def _criticite_score_band(value: Any) -> int:
    """
    Convertit la criticité en palier de risque.
    Utilisé uniquement pour pondérer les composantes de fragilité poste,
    afin qu'une compétence à 72 ne pèse pas comme une compétence à 20.
    """
    n = _safe_int(value, 0)
    if n >= 90:
        return 4
    if n >= 80:
        return 3
    if n >= 70:
        return 2
    if n >= 50:
        return 1
    return 0


def _score_efficacite_unit(poids_criticite: Any) -> int:
    """
    Points par unité de couverture métier manquante.
    Cible métier: 4 écarts sur des compétences critiques doivent sortir autour
    de 40-45 points, pas être écrasés dans un petit risque périphérique.
    """
    band = _criticite_score_band(poids_criticite)
    if band >= 4:
        return 15
    if band == 3:
        return 12
    if band == 2:
        return 10
    if band == 1:
        return 8
    return 6


def _score_dependance_unit(poids_criticite: Any, relais_faible: bool = False) -> int:
    """
    Points pour une dépendance sur compétence déjà couverte.
    - aucun renfort immédiat pèse fortement, surtout sur criticité élevée ;
    - un relais faible pèse moins, mais reste visible.
    """
    band = _criticite_score_band(poids_criticite)
    if relais_faible:
        if band >= 4:
            return 10
        if band == 3:
            return 8
        if band == 2:
            return 6
        if band == 1:
            return 4
        return 3

    if band >= 4:
        return 18
    if band == 3:
        return 14
    if band == 2:
        return 10
    if band == 1:
        return 8
    return 6


def _employee_matches_poste_constraints(emp: Dict[str, Any], poste: Dict[str, Any]) -> bool:
    edu_min_rank = max(_safe_int(poste.get("edu_min_rank"), 0), 0)
    if edu_min_rank > 0 and _education_rank(emp.get("niveau_education")) < edu_min_rank:
        return False

    if bool(poste.get("nsf_domain_required") or False):
        dom_poste = str(poste.get("nsf_domaine_titre") or "").strip().lower()
        dom_emp = str(emp.get("domaine_education") or "").strip().lower()
        if not dom_poste or dom_emp != dom_poste:
            return False

    return True


def _compute_poste_fragility_record(
    poste: Dict[str, Any],
    comp_rows: List[Dict[str, Any]],
    employees: List[Dict[str, Any]],
) -> Dict[str, Any]:
    row = dict(poste or {})
    row["statut_poste_norm"] = _normalize_poste_statut(row.get("statut_poste"))
    row["is_excluded"] = _is_poste_statut_excluded(row.get("statut_poste"))

    nb_titulaires = max(_safe_int(row.get("nb_titulaires"), 0), 0)
    nb_cible = max(_safe_int(row.get("nb_titulaires_cible"), 1), 1)
    gap = max(nb_cible - nb_titulaires, 0)
    rupture = (nb_titulaires <= 0 and nb_cible >= 1)
    besoin_local = max(min(nb_titulaires, nb_cible), 0)
    nb_competences_analysees = len(comp_rows or [])

    pool_total = 0
    pool_eligible = 0
    poste_id = str(row.get("id_poste") or "")
    for emp in employees or []:
        if str(emp.get("id_poste_actuel") or "") == poste_id:
            continue
        pool_total += 1
        if _employee_matches_poste_constraints(emp, row):
            pool_eligible += 1

    nb_non_tenues = 0
    nb_dep_zero = 0
    nb_dep_one = 0
    efficiency_missing_units = 0
    efficiency_points = 0
    dependance_points = 0
    nb_couvertures_non_confirmees = 0

    for c in comp_rows or []:
        nb_tit_any = max(_safe_int(c.get("nb_tit_any"), 0), 0)
        nb_tit_ok = max(_safe_int(c.get("nb_tit_ok"), 0), 0)
        nb_ok_all = max(_safe_int(c.get("nb_ok_all"), 0), 0)

        if besoin_local <= 0:
            continue

        if nb_tit_ok < besoin_local:
            nb_non_tenues += 1

        # Doctrine unique : seule une compétence évaluée et suffisante couvre le poste.
        # Les écarts de compétences relèvent du risque d’efficacité, pas du risque structurel.
        # Structure = tenue du poste / cible de titulaires.
        # Efficacité = couverture métier non confirmée ou insuffisante.
        missing_validated = max(besoin_local - nb_tit_ok, 0)
        if missing_validated > 0:
            efficiency_missing_units += missing_validated
            efficiency_points += missing_validated * _score_efficacite_unit(c.get("poids_criticite"))

        declared_but_not_validated = max(min(nb_tit_any, besoin_local) - nb_tit_ok, 0)
        if declared_but_not_validated > 0:
            nb_couvertures_non_confirmees += declared_but_not_validated

        if nb_tit_ok >= besoin_local:
            relais_ok = max(nb_ok_all - nb_tit_ok, 0)
            if relais_ok <= 0:
                nb_dep_zero += 1
                dependance_points += _score_dependance_unit(c.get("poids_criticite"), relais_faible=False)
            elif relais_ok == 1:
                nb_dep_one += 1
                dependance_points += _score_dependance_unit(c.get("poids_criticite"), relais_faible=True)

    structure_score = _score_structure_gap(gap)
    efficacite_score = min(45, efficiency_points)
    dependance_score = min(25, dependance_points)
    transmission_score = _score_transmission(pool_total, pool_eligible)

    nb_fragilites = nb_non_tenues + nb_dep_zero + nb_dep_one

    if rupture:
        # Poste non tenu = rupture structurelle. Les autres composantes ne doivent pas
        # venir brouiller la lecture des causes.
        structure_score = 100
        efficacite_score = 0
        dependance_score = 0
        transmission_score = 0
        base_score = 100
        score = 100
    else:
        base_score = structure_score + efficacite_score + dependance_score
        score = min(95, base_score + (transmission_score if base_score > 0 else 0))

    row.update({
        "nb_titulaires": nb_titulaires,
        "nb_titulaires_cible": nb_cible,
        "gap_titulaires": gap,
        "pool_total": pool_total,
        "pool_eligible": pool_eligible,
        "nb_competences_analysees": nb_competences_analysees,
        "is_non_analyse": bool(nb_competences_analysees <= 0 and not rupture),
        "nb_couvertures_non_confirmees": nb_couvertures_non_confirmees,
        "nb_critiques_sans_porteur": nb_non_tenues,
        "nb_critiques_porteur_unique": nb_dep_zero,
        "nb_critiques_fragiles": nb_fragilites,
        "nb_critiques_sans_releve": nb_dep_zero,
        "nb_critiques_releve_faible": nb_dep_one,
        "score_structurel": structure_score,
        "score_efficacite": efficacite_score,
        "score_dependance": dependance_score,
        "score_transmission": transmission_score,
        "score_competences": base_score,
        "base_score": base_score,
        "indice_fragilite": int(score),
        "is_fragile": bool(rupture or base_score > 0),
        "rupture": rupture,
        "besoin_local": besoin_local,
    })
    return row


def _fetch_postes_fragility_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
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
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND b.archive = FALSE
              AND b.date_debut <= CURRENT_DATE
              AND b.date_fin >= CURRENT_DATE
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
     AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    LEFT JOIN titulaires t ON t.id_poste = fp.id_poste
    """
    cur.execute(sql_postes, tuple(cte_params + [id_ent]))
    poste_rows = cur.fetchall() or []
    if not poste_rows:
        return []

    postes_map: Dict[str, Dict[str, Any]] = {}
    for r in poste_rows:
        postes_map[str(r.get("id_poste") or "")] = dict(r)

    sql_emps = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
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
    cur.execute(sql_emps, tuple(cte_params))
    employees = [dict(r) for r in (cur.fetchall() or [])]

    sql_comp = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
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
                WHEN 'intermediaire' THEN 2
                WHEN 'intermédiaire' THEN 2
                WHEN 'c' THEN 3
                WHEN 'avance' THEN 3
                WHEN 'avancé' THEN 3
                WHEN 'avancee' THEN 3
                WHEN 'avancée' THEN 3
                WHEN 'd' THEN 4
                WHEN 'expert' THEN 4
                ELSE 0
            END AS act_rank,
            CASE
                WHEN a.resultat_eval IS NOT NULL
                 AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL)
                THEN TRUE
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
    cur.execute(sql_comp, tuple(cte_params + [int(criticite_min)]))
    comp_rows = cur.fetchall() or []
    comp_by_poste: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in comp_rows:
        comp_by_poste[str(r.get("id_poste") or "")].append(dict(r))

    records = []
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



def _competence_state_label(etat: str) -> str:
    return {
        "AUCUN_TITULAIRE": "Poste non tenu",
        "COUVERTURE_ABSENTE": "Aucun porteur déclaré",
        "COUVERTURE_NON_CONFIRMEE": "À évaluer",
        "NIVEAU_INSUFFISANT": "Niveau insuffisant",
        "DEPENDANCE": "Dépendance",
        "COUVERTURE_VALIDEE": "Couverture validée",
    }.get(etat or "", "À qualifier")


def _competence_action_label(etat: str) -> str:
    return {
        "AUCUN_TITULAIRE": "Affecter un titulaire ou arbitrer le poste",
        "COUVERTURE_ABSENTE": "Identifier un porteur interne ou recruter",
        "COUVERTURE_NON_CONFIRMEE": "Évaluer en priorité",
        "NIVEAU_INSUFFISANT": "Former / accompagner",
        "DEPENDANCE": "Organiser une doublure ou une transmission",
        "COUVERTURE_VALIDEE": "Surveiller",
    }.get(etat or "", "Analyser")


def _competence_state_risk(etat: str) -> int:
    return {
        "AUCUN_TITULAIRE": 100,
        "COUVERTURE_ABSENTE": 100,
        "COUVERTURE_NON_CONFIRMEE": 85,
        "NIVEAU_INSUFFISANT": 70,
        "DEPENDANCE": 60,
        "COUVERTURE_VALIDEE": 0,
    }.get(etat or "", 0)


def _competence_priorite_from_score(score: int) -> str:
    s = _clamp_int(score, 0, 100)
    if s >= 75:
        return "P1"
    if s >= 50:
        return "P2"
    return "P3"


def _build_competence_causes_from_counts(counts: Dict[str, int]) -> List[Dict[str, Any]]:
    return [
        {
            "code": "COUVERTURE_ABSENTE",
            "titre": "Couverture absente",
            "count": int(counts.get("AUCUN_TITULAIRE", 0) or 0) + int(counts.get("COUVERTURE_ABSENTE", 0) or 0),
            "lecture": "Aucun porteur confirmé ne couvre cette compétence sur une partie des postes concernés.",
            "action": "Identifier un porteur interne, affecter un titulaire ou préparer un recrutement ciblé.",
        },
        {
            "code": "COUVERTURE_NON_CONFIRMEE",
            "titre": "Couverture non confirmée",
            "count": int(counts.get("COUVERTURE_NON_CONFIRMEE", 0) or 0),
            "lecture": "La compétence est déclarée dans le profil, mais aucune évaluation exploitable ne confirme le niveau attendu.",
            "action": "Planifier une évaluation avant de considérer le poste sécurisé.",
        },
        {
            "code": "NIVEAU_INSUFFISANT",
            "titre": "Écart de maîtrise",
            "count": int(counts.get("NIVEAU_INSUFFISANT", 0) or 0),
            "lecture": "La compétence est évaluée, mais le niveau constaté ne couvre pas le niveau requis.",
            "action": "Prévoir une formation, un accompagnement ou une montée en compétence ciblée.",
        },
        {
            "code": "DEPENDANCE",
            "titre": "Dépendance / transmission",
            "count": int(counts.get("DEPENDANCE", 0) or 0),
            "lecture": "La compétence est validée, mais elle repose sur un seul porteur confirmé.",
            "action": "Organiser une doublure ou un transfert de savoir-faire.",
        },
    ]


def _fetch_competence_fragility_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    comp_id: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """
    Source unique pour la table "Compétences critiques" et le modal détail compétence.

    Doctrine:
    - compétence déclarée seule ≠ couverture validée;
    - couverture validée = compétence évaluée et niveau actuel >= niveau requis;
    - l'indice affiché dans la table et dans le modal est calculé depuis les mêmes états par poste.
    """
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    comp_filter_sql = ""
    comp_filter_params: List[Any] = []
    if comp_id:
        comp_filter_sql = "AND c.id_comp = %s"
        comp_filter_params.append(comp_id)

    sql = f"""
    WITH
    {cte_sql},
    req AS (
        SELECT DISTINCT
            fp.id_poste,
            fp.codif_poste,
            COALESCE(fp.codif_client, '') AS codif_client,
            fp.intitule_poste,
            fp.id_service,
            COALESCE(o.nom_service, '') AS nom_service,
            c.id_comp,
            c.code,
            c.intitule,
            c.description,
            c.domaine AS id_domaine_competence,
            d.titre AS domaine_titre,
            d.titre_court AS domaine_titre_court,
            d.couleur AS domaine_couleur,
            COALESCE(fpc.niveau_requis, '')::text AS niveau_requis,
            COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
            COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible
        FROM postes_scope ps
        JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
        JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = fp.id_poste
        JOIN public.tbl_competence c
          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        LEFT JOIN public.tbl_entreprise_organigramme o
          ON o.id_ent = fp.id_ent
         AND o.id_service = fp.id_service
         AND COALESCE(o.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_domaine_competence d
          ON d.id_domaine_competence = c.domaine
         AND COALESCE(d.masque, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND c.etat = 'active'
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
          {comp_filter_sql}
    ),
    effectifs_dispo AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_service,
            e.id_poste_actuel
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND NOT EXISTS (
            SELECT 1
            FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= CURRENT_DATE
              AND b.date_fin >= CURRENT_DATE
          )
    ),
    titulaires_count AS (
        SELECT id_poste_actuel AS id_poste, COUNT(DISTINCT id_effectif)::int AS nb_titulaires
        FROM effectifs_dispo
        WHERE COALESCE(id_poste_actuel, '') <> ''
        GROUP BY id_poste_actuel
    )
    SELECT
        r.*,
        COALESCE(tc.nb_titulaires, 0)::int AS nb_titulaires,
        e.id_effectif,
        e.prenom_effectif,
        e.nom_effectif,
        ec.id_effectif_competence,
        ec.niveau_actuel,
        ec.date_derniere_eval,
        a.id_audit_competence,
        a.date_audit,
        a.resultat_eval
    FROM req r
    LEFT JOIN titulaires_count tc ON tc.id_poste = r.id_poste
    LEFT JOIN effectifs_dispo e ON e.id_poste_actuel = r.id_poste
    LEFT JOIN public.tbl_effectif_client_competence ec
      ON ec.id_effectif_client = e.id_effectif
     AND ec.id_comp = r.id_comp
     AND COALESCE(ec.actif, TRUE) = TRUE
     AND COALESCE(ec.archive, FALSE) = FALSE
    LEFT JOIN public.tbl_effectif_client_audit_competence a
      ON a.id_audit_competence = ec.id_dernier_audit
     AND a.id_effectif_competence = ec.id_effectif_competence
    ORDER BY r.code, r.poids_criticite DESC, r.codif_poste, e.nom_effectif, e.prenom_effectif
    """
    cur.execute(sql, tuple(cte_params + [id_ent, int(criticite_min)] + comp_filter_params))
    raw_rows = [dict(r) for r in (cur.fetchall() or [])]
    if not raw_rows:
        return []

    def _is_evaluee_row(r: Dict[str, Any]) -> bool:
        return bool(r.get("resultat_eval") is not None and (r.get("date_audit") is not None or r.get("date_derniere_eval") is not None or r.get("id_audit_competence") is not None))

    poste_map: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in raw_rows:
        key = (str(r.get("id_comp") or ""), str(r.get("id_poste") or ""))
        p = poste_map.get(key)
        if not p:
            nb_tit = max(_safe_int(r.get("nb_titulaires"), 0), 0)
            nb_cible_raw = _safe_int(r.get("nb_titulaires_cible"), 1)
            nb_cible = nb_cible_raw if nb_cible_raw > 0 else (nb_tit if nb_tit > 0 else 1)
            p = {
                "id_comp": r.get("id_comp"),
                "code": r.get("code"),
                "intitule": r.get("intitule"),
                "description": r.get("description"),
                "id_domaine_competence": r.get("id_domaine_competence"),
                "domaine_titre": r.get("domaine_titre"),
                "domaine_titre_court": r.get("domaine_titre_court"),
                "domaine_couleur": r.get("domaine_couleur"),
                "id_poste": r.get("id_poste"),
                "codif_poste": r.get("codif_poste"),
                "codif_client": r.get("codif_client"),
                "intitule_poste": r.get("intitule_poste"),
                "id_service": r.get("id_service"),
                "nom_service": r.get("nom_service"),
                "niveau_requis": r.get("niveau_requis"),
                "poids_criticite": _safe_int(r.get("poids_criticite"), 0),
                "nb_titulaires": nb_tit,
                "besoin_poste": max(nb_cible, 1),
                "rows": [],
            }
            poste_map[key] = p
        p["rows"].append(r)

    comp_map: Dict[str, Dict[str, Any]] = {}
    for p in poste_map.values():
        req_rank = _niveau_rank(p.get("niveau_requis"))
        nb_tit = max(_safe_int(p.get("nb_titulaires"), 0), 0)
        besoin_poste = max(_safe_int(p.get("besoin_poste"), 1), 1)

        nb_declares = 0
        nb_evalues = 0
        nb_valides = 0
        nb_non_evalues = 0
        nb_insuffisants = 0

        for r in p.get("rows") or []:
            if not r.get("id_effectif"):
                continue
            if not r.get("id_effectif_competence"):
                continue
            nb_declares += 1
            is_eval = _is_evaluee_row(r)
            act_rank = _niveau_rank(r.get("niveau_actuel"))
            if not is_eval:
                nb_non_evalues += 1
                continue
            nb_evalues += 1
            if req_rank > 0 and act_rank >= req_rank:
                nb_valides += 1
            elif act_rank > 0:
                nb_insuffisants += 1
            else:
                nb_non_evalues += 1

        if nb_tit <= 0:
            etat = "AUCUN_TITULAIRE"
        elif nb_valides >= besoin_poste:
            etat = "DEPENDANCE" if nb_valides == 1 else "COUVERTURE_VALIDEE"
        elif nb_declares <= 0:
            etat = "COUVERTURE_ABSENTE"
        elif nb_non_evalues > 0:
            etat = "COUVERTURE_NON_CONFIRMEE"
        elif nb_insuffisants > 0:
            etat = "NIVEAU_INSUFFISANT"
        else:
            etat = "COUVERTURE_ABSENTE"

        p["nb_porteurs_declares"] = nb_declares
        p["nb_porteurs_evalues"] = nb_evalues
        p["nb_porteurs_valides"] = nb_valides
        p["nb_porteurs_non_evalues"] = nb_non_evalues
        p["nb_porteurs_insuffisants"] = nb_insuffisants
        p["etat_couverture"] = etat
        p["etat_couverture_label"] = _competence_state_label(etat)
        p["action_rh"] = _competence_action_label(etat)
        p["risque_ligne"] = _competence_state_risk(etat)

        cid = str(p.get("id_comp") or "")
        c = comp_map.get(cid)
        if not c:
            c = {
                "id_comp": p.get("id_comp"),
                "code": p.get("code"),
                "intitule": p.get("intitule"),
                "description": p.get("description"),
                "id_domaine_competence": p.get("id_domaine_competence"),
                "domaine_titre": p.get("domaine_titre"),
                "domaine_titre_court": p.get("domaine_titre_court"),
                "domaine_couleur": p.get("domaine_couleur"),
                "postes": [],
                "counts": defaultdict(int),
                "poids_total": 0,
                "score_weighted": 0,
                "nb_porteurs_declares_set": set(),
                "nb_porteurs_evalues_set": set(),
                "nb_porteurs_valides_set": set(),
            }
            comp_map[cid] = c

        c["postes"].append({k: v for k, v in p.items() if k != "rows"})
        c["counts"][etat] += 1
        poids = max(_safe_int(p.get("poids_criticite"), 0), 1)
        c["poids_total"] += poids
        c["score_weighted"] += _competence_state_risk(etat) * poids

        for r in p.get("rows") or []:
            eid = str(r.get("id_effectif") or "")
            if not eid or not r.get("id_effectif_competence"):
                continue
            c["nb_porteurs_declares_set"].add(eid)
            is_eval = _is_evaluee_row(r)
            act_rank = _niveau_rank(r.get("niveau_actuel"))
            if is_eval:
                c["nb_porteurs_evalues_set"].add(eid)
            if is_eval and _niveau_rank(p.get("niveau_requis")) > 0 and act_rank >= _niveau_rank(p.get("niveau_requis")):
                c["nb_porteurs_valides_set"].add(eid)

    records: List[Dict[str, Any]] = []
    for c in comp_map.values():
        poids_total = max(_safe_int(c.get("poids_total"), 0), 1)
        indice = _clamp_int(round(float(c.get("score_weighted") or 0) / float(poids_total)), 0, 100)
        counts = dict(c.get("counts") or {})
        nb_postes = len(c.get("postes") or [])
        max_criticite = max([_safe_int(p.get("poids_criticite"), 0) for p in c.get("postes") or []] or [0])
        besoin_total = sum(max(_safe_int(p.get("besoin_poste"), 1), 1) for p in c.get("postes") or [])
        nb_postes_crit_80 = sum(1 for p in c.get("postes") or [] if _safe_int(p.get("poids_criticite"), 0) >= 80)

        rec = {
            "id_comp": c.get("id_comp"),
            "code": c.get("code"),
            "intitule": c.get("intitule"),
            "description": c.get("description"),
            "id_domaine_competence": c.get("id_domaine_competence"),
            "domaine_titre": c.get("domaine_titre"),
            "domaine_titre_court": c.get("domaine_titre_court"),
            "domaine_couleur": c.get("domaine_couleur"),
            "nb_postes_impactes": nb_postes,
            "besoin_total": besoin_total,
            "nb_porteurs": len(c.get("nb_porteurs_valides_set") or set()),
            "nb_porteurs_dispo": len(c.get("nb_porteurs_valides_set") or set()),
            "nb_porteurs_declares": len(c.get("nb_porteurs_declares_set") or set()),
            "nb_porteurs_evalues": len(c.get("nb_porteurs_evalues_set") or set()),
            "nb_porteurs_valides": len(c.get("nb_porteurs_valides_set") or set()),
            "nb_experts": 0,
            "nb_experts_dispo": 0,
            "criticite_max": max_criticite,
            "max_criticite": max_criticite,
            "nb_postes_crit_80": nb_postes_crit_80,
            "indice_fragilite": indice,
            "priorite": _competence_priorite_from_score(indice),
            "priorite_score": indice,
            "nb_postes_couverture_absente": int(counts.get("AUCUN_TITULAIRE", 0) or 0) + int(counts.get("COUVERTURE_ABSENTE", 0) or 0),
            "nb_postes_non_confirmee": int(counts.get("COUVERTURE_NON_CONFIRMEE", 0) or 0),
            "nb_postes_niveau_insuffisant": int(counts.get("NIVEAU_INSUFFISANT", 0) or 0),
            "nb_postes_dependance": int(counts.get("DEPENDANCE", 0) or 0),
            "nb_postes_valides": int(counts.get("COUVERTURE_VALIDEE", 0) or 0),
            "causes": _build_competence_causes_from_counts(counts),
            "postes": c.get("postes") or [],
        }
        records.append(rec)

    records.sort(key=lambda r: (-(r.get("priorite_score") or 0), -(r.get("nb_postes_impactes") or 0), str(r.get("code") or "")))
    return records[:max(1, int(limit or 200))]

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
                postes_fragiles = len([r for r in postes_fragiles_records if r.get("is_fragile")])
                if postes_fragiles_records:
                    postes_fragilite_globale = int(round(
                        sum(int(r.get("indice_fragilite") or 0) for r in postes_fragiles_records)
                        / float(len(postes_fragiles_records))
                    ))
                else:
                    postes_fragilite_globale = 0

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
                comp_records = _fetch_competence_fragility_records(
                    cur,
                    id_ent,
                    scope.id_service,
                    CRITICITE_MIN,
                    comp_id=None,
                    limit=2000,
                )
                comp_records_fragiles = [r for r in comp_records if int(r.get("indice_fragilite") or 0) > 0]
                comp_critiques_sans_porteur = len([r for r in comp_records if int(r.get("nb_postes_couverture_absente") or 0) > 0])
                comp_porteur_unique = len([r for r in comp_records if int(r.get("nb_postes_dependance") or 0) > 0])
                comp_critiques_fragiles = len(comp_records_fragiles)
                if comp_records:
                    comp_fragilite_moyenne = int(round(
                        sum(int(r.get("indice_fragilite") or 0) for r in comp_records)
                        / float(len(comp_records))
                    ))
                else:
                    comp_fragilite_moyenne = 0
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
                        postes_fragilite_globale=postes_fragilite_globale,
                        postes_analyses=len(postes_fragiles_records),
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
        def _clamp(v: float, lo: float, hi: float) -> float:
            return max(lo, min(hi, v))

        def _calc_indice(B: int, P: int, Pd: int, Pe: int, Ped: int, N: int, Cmax: int, N80: int) -> int:
            # Copie conforme de la logique "critiques-fragiles" (Risques), mais appliquée à un état projeté
            B = B if B > 0 else 1

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

            return int(round(_clamp(base + bonus, 0.0, 100.0)))

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
                        e.id_poste_actuel,
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

                effectifs_dispo AS (
                    SELECT ev.id_effectif
                    FROM effectifs_valid ev
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_break b
                        WHERE b.id_effectif = ev.id_effectif
                          AND b.archive = FALSE
                          AND b.date_debut <= CURRENT_DATE
                          AND b.date_fin >= CURRENT_DATE
                    )
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
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                ),

                req_crit AS (
                    SELECT ra.id_poste, ra.id_comp, ra.poids_crit
                    FROM req_all ra
                    WHERE ra.poids_crit >= %s
                ),

                titulaires AS (
                    SELECT
                        ev.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT ev.id_effectif)::int AS nb_titulaires
                    FROM effectifs_valid ev
                    WHERE COALESCE(ev.id_poste_actuel, '') <> ''
                    GROUP BY ev.id_poste_actuel
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
                        MAX(rc.poids_crit)::int AS criticite_max,
                        COUNT(DISTINCT rc.id_poste)::int AS nb_postes_impactes,
                        SUM(pn.besoin_poste)::int AS besoin_total,
                        SUM(CASE WHEN rc.poids_crit >= 80 THEN 1 ELSE 0 END)::int AS nb_postes_crit_80
                    FROM req_crit rc
                    JOIN poste_need pn ON pn.id_poste = rc.id_poste
                    GROUP BY rc.id_comp
                ),

                porteurs AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comp_need)
                    GROUP BY ec.id_comp
                ),

                porteurs_dispo AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_dispo ed ON ed.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comp_need)
                    GROUP BY ec.id_comp
                ),

                experts AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_experts
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comp_need)
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
                      AND ec.id_comp IN (SELECT id_comp FROM comp_need)
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
                    GROUP BY ec.id_comp
                ),

                leave_comp AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_leave,
                        COUNT(DISTINCT CASE WHEN ed.id_effectif IS NOT NULL THEN ec.id_effectif_client END)::int AS nb_leave_dispo,
                        MAX(l.exit_date) AS last_exit_date,

                        COUNT(DISTINCT CASE
                          WHEN (
                            CASE
                              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                                THEN trim(ec.niveau_actuel)::int
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                              ELSE 0
                            END
                          ) >= 4 THEN ec.id_effectif_client END
                        )::int AS nb_experts_leave,

                        COUNT(DISTINCT CASE
                          WHEN ed.id_effectif IS NOT NULL AND (
                            CASE
                              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$'
                                THEN trim(ec.niveau_actuel)::int
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3
                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4
                              WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4
                              ELSE 0
                            END
                          ) >= 4 THEN ec.id_effectif_client END
                        )::int AS nb_experts_leave_dispo

                    FROM leaving l
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_client = l.id_effectif
                    LEFT JOIN effectifs_dispo ed ON ed.id_effectif = l.id_effectif
                    WHERE COALESCE(ec.actif, TRUE) = TRUE
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND ec.id_comp IN (SELECT id_comp FROM comp_need)
                    GROUP BY ec.id_comp
                ),

                impact AS (
                    SELECT
                        cn.id_comp,
                        cn.nb_postes_impactes,
                        cn.criticite_max,
                        cn.besoin_total,
                        cn.nb_postes_crit_80,

                        COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs,
                        COALESCE(pd.nb_porteurs, 0)::int AS nb_porteurs_dispo,
                        COALESCE(ex.nb_experts, 0)::int AS nb_experts,
                        COALESCE(exd.nb_experts, 0)::int AS nb_experts_dispo,

                        COALESCE(lc.nb_leave, 0)::int AS nb_leave,
                        COALESCE(lc.nb_leave_dispo, 0)::int AS nb_leave_dispo,
                        COALESCE(lc.nb_experts_leave, 0)::int AS nb_experts_leave,
                        COALESCE(lc.nb_experts_leave_dispo, 0)::int AS nb_experts_leave_dispo,
                        lc.last_exit_date
                    FROM comp_need cn
                    LEFT JOIN porteurs p ON p.id_comp = cn.id_comp
                    LEFT JOIN porteurs_dispo pd ON pd.id_comp = cn.id_comp
                    LEFT JOIN experts ex ON ex.id_comp = cn.id_comp
                    LEFT JOIN experts_dispo exd ON exd.id_comp = cn.id_comp
                    LEFT JOIN leave_comp lc ON lc.id_comp = cn.id_comp
                    WHERE COALESCE(p.nb_porteurs, 0) > 0
                      AND (COALESCE(p.nb_porteurs, 0) - COALESCE(lc.nb_leave, 0)) <= 0
                )

                SELECT
                    i.id_comp,
                    c.code,
                    c.intitule,
                    c.domaine AS id_domaine_competence,
                    COALESCE(d.titre_court, d.titre, '') AS domaine_titre_court,
                    COALESCE(d.couleur, '') AS domaine_couleur,

                    i.nb_postes_impactes::int AS nb_postes_impactes,
                    i.criticite_max::int AS max_criticite,

                    i.nb_porteurs::int AS nb_porteurs_now,
                    i.nb_leave::int AS nb_porteurs_sortants,
                    i.last_exit_date,

                    i.besoin_total::int AS besoin_total,
                    i.nb_postes_crit_80::int AS nb_postes_crit_80,

                    i.nb_porteurs_dispo::int AS nb_porteurs_dispo,
                    i.nb_experts::int AS nb_experts,
                    i.nb_experts_dispo::int AS nb_experts_dispo,

                    i.nb_leave_dispo::int AS nb_leave_dispo,
                    i.nb_experts_leave::int AS nb_experts_leave,
                    i.nb_experts_leave_dispo::int AS nb_experts_leave_dispo

                FROM impact i
                JOIN public.tbl_competence c ON c.id_comp = i.id_comp
                LEFT JOIN public.tbl_domaine_competence d
                  ON d.id_domaine_competence = c.domaine
                 AND COALESCE(d.masque, FALSE) = FALSE

                ORDER BY
                    i.nb_postes_impactes DESC,
                    i.criticite_max DESC,
                    c.code
                LIMIT %s
                """

                cur.execute(sql, tuple(cte_params + [horizon_years, criticite_min, limit]))
                rows = cur.fetchall() or []

                items: List[AnalysePrevisionCritiqueImpacteeItem] = []

                for r in rows:
                    last_exit_date = r.get("last_exit_date")
                    if hasattr(last_exit_date, "isoformat"):
                        last_exit_date = last_exit_date.isoformat()

                    B = int(r.get("besoin_total") or 0)
                    P = int(r.get("nb_porteurs_now") or 0)
                    Pd = int(r.get("nb_porteurs_dispo") or 0)

                    Pe = int(r.get("nb_experts") or 0)
                    Ped = int(r.get("nb_experts_dispo") or 0)

                    N = int(r.get("nb_postes_impactes") or 0)
                    Cmax = int(r.get("max_criticite") or 0)
                    N80 = int(r.get("nb_postes_crit_80") or 0)

                    leave = int(r.get("nb_porteurs_sortants") or 0)
                    leave_dispo = int(r.get("nb_leave_dispo") or 0)
                    leave_ex = int(r.get("nb_experts_leave") or 0)
                    leave_ex_dispo = int(r.get("nb_experts_leave_dispo") or 0)

                    indice_now = _calc_indice(B, P, Pd, Pe, Ped, N, Cmax, N80)

                    P_h = max(P - leave, 0)
                    Pd_h = max(Pd - leave_dispo, 0)
                    Pe_h = max(Pe - leave_ex, 0)
                    Ped_h = max(Ped - leave_ex_dispo, 0)

                    indice_h = _calc_indice(B, P_h, Pd_h, Pe_h, Ped_h, N, Cmax, N80)
                    delta = int(indice_h - indice_now)

                    if indice_h >= 75:
                        prio = "P1"
                    elif indice_h >= 50:
                        prio = "P2"
                    else:
                        prio = "P3"

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

                            indice_fragilite_horizon=int(indice_h),
                            delta_fragilite=int(delta),
                            priorite=prio,
                            priorite_score=int(indice_h),
                        )
                    )

                # Tri DRH-friendly: d'abord l'horizon le plus critique
                items.sort(key=lambda x: (-(x.priorite_score or 0), -(x.nb_postes_impactes or 0), (x.code or "")))

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
    Détail KPI "Postes impactés" (prévisions).
    Doit rester aligné avec le mini KPI Prévisions : on liste uniquement les postes
    qui passent sous le seuil rouge de couverture dans l'horizon sélectionné.
    """
    COVERAGE_RED = 45

    try:
        def _clamp(v: float, lo: float, hi: float) -> float:
            return max(lo, min(hi, v))

        def _prio_label(score_h: int, titulaires_h: int, cible: int) -> str:
            if int(titulaires_h or 0) <= 0 and int(cible or 1) > 0:
                return "Critique"
            s = int(_clamp(float(score_h or 0), 0.0, 100.0))
            if s >= 75:
                return "Élevée"
            if s >= 45:
                return "Modérée"
            return "Faible"

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

                leaving AS (
                    SELECT ee.id_effectif
                    FROM effectifs_exit ee
                    WHERE ee.exit_date IS NOT NULL
                      AND ee.exit_date >= CURRENT_DATE
                      AND ee.exit_date < (CURRENT_DATE + (%s || ' years')::interval)
                ),

                titulaires_now AS (
                    SELECT
                        ev.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT ev.id_effectif)::int AS nb_titulaires_now
                    FROM effectifs_valid ev
                    WHERE COALESCE(ev.id_poste_actuel, '') <> ''
                    GROUP BY ev.id_poste_actuel
                ),

                titulaires_horizon AS (
                    SELECT
                        ev.id_poste_actuel AS id_poste,
                        COUNT(DISTINCT ev.id_effectif)::int AS nb_titulaires_horizon
                    FROM effectifs_valid ev
                    LEFT JOIN leaving l ON l.id_effectif = ev.id_effectif
                    WHERE COALESCE(ev.id_poste_actuel, '') <> ''
                      AND l.id_effectif IS NULL
                    GROUP BY ev.id_poste_actuel
                ),

                req AS (
                    SELECT DISTINCT
                        fp.id_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        c.id_comp,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_crit,
                        GREATEST(COALESCE(fpc.poids_criticite, 0)::int, 1) AS poids_calc
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = fpc.id_poste
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE c.etat = 'active'
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                      AND COALESCE(fpc.poids_criticite, 0)::int >= %s
                ),

                comp_state AS (
                    SELECT
                        r.id_poste,
                        r.id_comp,
                        COUNT(DISTINCT ev.id_effectif)::int AS nb_now,
                        COUNT(DISTINCT CASE WHEN ev.id_poste_actuel = r.id_poste THEN ev.id_effectif END)::int AS nb_now_titulaires,
                        COUNT(DISTINCT CASE WHEN l.id_effectif IS NULL THEN ev.id_effectif END)::int AS nb_future,
                        COUNT(DISTINCT CASE WHEN l.id_effectif IS NULL AND ev.id_poste_actuel = r.id_poste THEN ev.id_effectif END)::int AS nb_future_titulaires
                    FROM req r
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = r.id_comp
                     AND COALESCE(ec.actif, TRUE) = TRUE
                     AND COALESCE(ec.archive, FALSE) = FALSE
                    LEFT JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client
                    LEFT JOIN leaving l ON l.id_effectif = ev.id_effectif
                    GROUP BY r.id_poste, r.id_comp
                ),

                poste_cov AS (
                    SELECT
                        r.id_poste,
                        r.intitule_poste,
                        r.id_service,
                        SUM(r.poids_calc)::numeric AS poids_total,
                        SUM(CASE WHEN COALESCE(cs.nb_now, 0) > 0 THEN r.poids_calc ELSE 0 END)::numeric AS poids_couverts_now,
                        SUM(CASE WHEN COALESCE(cs.nb_future, 0) > 0 THEN r.poids_calc ELSE 0 END)::numeric AS poids_couverts_future,

                        SUM(CASE WHEN COALESCE(cs.nb_now, 0) = 0 THEN 1 ELSE 0 END)::int AS now_sans_porteur,
                        SUM(CASE WHEN COALESCE(cs.nb_now, 0) = 1 THEN 1 ELSE 0 END)::int AS now_porteur_unique,
                        SUM(CASE WHEN COALESCE(cs.nb_now, 0) >= 2 AND GREATEST(COALESCE(cs.nb_now, 0) - COALESCE(cs.nb_now_titulaires, 0), 0) = 0 THEN 1 ELSE 0 END)::int AS now_sans_releve,
                        SUM(CASE WHEN COALESCE(cs.nb_now, 0) >= 2 AND GREATEST(COALESCE(cs.nb_now, 0) - COALESCE(cs.nb_now_titulaires, 0), 0) = 1 THEN 1 ELSE 0 END)::int AS now_releve_faible,

                        SUM(CASE WHEN COALESCE(cs.nb_future, 0) = 0 THEN 1 ELSE 0 END)::int AS future_sans_porteur,
                        SUM(CASE WHEN COALESCE(cs.nb_future, 0) = 1 THEN 1 ELSE 0 END)::int AS future_porteur_unique,
                        SUM(CASE WHEN COALESCE(cs.nb_future, 0) >= 2 AND GREATEST(COALESCE(cs.nb_future, 0) - COALESCE(cs.nb_future_titulaires, 0), 0) = 0 THEN 1 ELSE 0 END)::int AS future_sans_releve,
                        SUM(CASE WHEN COALESCE(cs.nb_future, 0) >= 2 AND GREATEST(COALESCE(cs.nb_future, 0) - COALESCE(cs.nb_future_titulaires, 0), 0) = 1 THEN 1 ELSE 0 END)::int AS future_releve_faible
                    FROM req r
                    LEFT JOIN comp_state cs
                      ON cs.id_poste = r.id_poste
                     AND cs.id_comp = r.id_comp
                    GROUP BY r.id_poste, r.intitule_poste, r.id_service
                ),

                scored AS (
                    SELECT
                        pc.*,
                        CASE WHEN pc.poids_total > 0 THEN (100.0 * pc.poids_couverts_now / pc.poids_total) ELSE 0 END AS couverture_now,
                        CASE WHEN pc.poids_total > 0 THEN (100.0 * pc.poids_couverts_future / pc.poids_total) ELSE 0 END AS couverture_future
                    FROM poste_cov pc
                )

                SELECT
                    s.id_poste,
                    s.intitule_poste,
                    s.id_service,
                    COALESCE(o.nom_service, '') AS nom_service,
                    COALESCE(fp.codif_poste, '') AS codif_poste,
                    COALESCE(fp.codif_client, '') AS codif_client,
                    COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
                    COALESCE(tn.nb_titulaires_now, 0)::int AS nb_titulaires_now,
                    COALESCE(th.nb_titulaires_horizon, 0)::int AS nb_titulaires_horizon,
                    s.now_sans_porteur,
                    s.now_porteur_unique,
                    s.now_sans_releve,
                    s.now_releve_faible,
                    s.future_sans_porteur,
                    s.future_porteur_unique,
                    s.future_sans_releve,
                    s.future_releve_faible,
                    ROUND(s.couverture_now)::int AS couverture_now,
                    ROUND(s.couverture_future)::int AS couverture_future
                FROM scored s
                LEFT JOIN public.tbl_fiche_poste fp
                  ON fp.id_poste = s.id_poste
                 AND fp.id_ent = %s
                 AND COALESCE(fp.actif, TRUE) = TRUE
                LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = s.id_poste
                LEFT JOIN titulaires_now tn ON tn.id_poste = s.id_poste
                LEFT JOIN titulaires_horizon th ON th.id_poste = s.id_poste
                LEFT JOIN public.tbl_entreprise_organigramme o
                  ON o.id_ent = %s
                 AND o.id_service = s.id_service
                 AND COALESCE(o.archive, FALSE) = FALSE
                WHERE (
                    s.couverture_future < s.couverture_now
                    OR COALESCE(th.nb_titulaires_horizon, 0) < COALESCE(tn.nb_titulaires_now, 0)
                    OR s.future_sans_porteur > s.now_sans_porteur
                    OR s.future_porteur_unique > s.now_porteur_unique
                    OR s.future_sans_releve > s.now_sans_releve
                    OR s.future_releve_faible > s.now_releve_faible
                  )
                ORDER BY s.couverture_future ASC, (s.couverture_now - s.couverture_future) DESC, s.intitule_poste ASC
                LIMIT %s
                """

                params = tuple(
                    cte_params
                    + [
                        horizon_years,
                        id_ent,
                        criticite_min,
                        id_ent,
                        id_ent,
                        limit,
                    ]
                )

                cur.execute(sql, params)
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    t_now = int(r.get("nb_titulaires_now") or 0)
                    t_h = int(r.get("nb_titulaires_horizon") or 0)
                    cible = int(r.get("nb_titulaires_cible") or 1)
                    cov_now = int(r.get("couverture_now") or 0)
                    cov_h = int(r.get("couverture_future") or 0)
                    score_now = int(_clamp(100 - cov_now, 0, 100))
                    score_h = int(_clamp(100 - cov_h, 0, 100))
                    delta = int(score_h - score_now)

                    items.append({
                        "id_poste": (r.get("id_poste") or "").strip(),
                        "codif_poste": (r.get("codif_poste") or "").strip() or None,
                        "codif_client": (r.get("codif_client") or "").strip() or None,
                        "intitule_poste": (r.get("intitule_poste") or "").strip() or "—",
                        "nom_service": (r.get("nom_service") or "").strip() or "—",
                        "nb_titulaires_cible": cible,
                        "nb_titulaires_now": t_now,
                        "nb_titulaires_horizon": t_h,
                        "nb_titulaires": t_h,
                        "now_sans_porteur": int(r.get("now_sans_porteur") or 0),
                        "now_porteur_unique": int(r.get("now_porteur_unique") or 0),
                        "now_sans_releve": int(r.get("now_sans_releve") or 0),
                        "now_releve_faible": int(r.get("now_releve_faible") or 0),
                        "future_sans_porteur": int(r.get("future_sans_porteur") or 0),
                        "future_porteur_unique": int(r.get("future_porteur_unique") or 0),
                        "future_sans_releve": int(r.get("future_sans_releve") or 0),
                        "future_releve_faible": int(r.get("future_releve_faible") or 0),
                        "couverture_now": cov_now,
                        "couverture_future": cov_h,
                        "indice_fragilite_now": score_now,
                        "indice_fragilite_horizon": score_h,
                        "delta_fragilite": delta,
                        "priorite_label": _prio_label(score_h, t_h, cible),
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
                        END AS raison_sortie,
                        CASE
                          WHEN (
                            CASE
                                WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) IS NOT NULL
                          AND (
                            CASE
                                WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) >= CURRENT_DATE
                          AND (
                            CASE
                                WHEN ev.havedatefin = TRUE AND ev.date_sortie_prevue IS NOT NULL THEN ev.date_sortie_prevue
                                WHEN ev.retraite_annee IS NOT NULL THEN make_date(ev.retraite_annee, ev.m_entree, 1)
                                ELSE NULL
                            END
                          ) < (CURRENT_DATE + (%s::int * interval '1 year'))
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

    # Scores composantes renvoyés par le backend.
    # Le front les utilise pour afficher des parts de causes cohérentes avec l’indice.
    score_structurel: int = 0
    score_efficacite: int = 0
    score_dependance: int = 0
    score_transmission: int = 0
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

                    if besoin_local > 0 and n_ok_tit >= besoin_local:
                        if n_relais <= 0:
                            nb1 += 1
                            nb_r0 += 1
                            dependance_points += _score_dependance_unit(r.get("poids_criticite"), relais_faible=False)
                            dep_items.append(
                                AnalysePosteDependanceItem(
                                    id_comp=r.get("id_comp"),
                                    code_comp=r.get("code"),
                                    intitule=r.get("intitule"),
                                    poids_criticite=int(r.get("poids_criticite") or 0),
                                    nb_porteurs_ok=n_relais,
                                    seuil_couverture=2,
                                    type_risque="SANS_RELAIS",
                                )
                            )
                            candidates.append(
                                AnalysePosteTopRisqueItem(
                                    id_comp=r.get("id_comp"),
                                    code_comp=r.get("code"),
                                    intitule=r.get("intitule"),
                                    poids_criticite=int(r.get("poids_criticite") or 0),
                                    type_risque="SANS_RELEVE",
                                    nb_porteurs=n_ok,
                                    nb_ok=n_ok,
                                    recommandation="mutualiser",
                                )
                            )
                        elif n_relais == 1:
                            nb_r1 += 1
                            dependance_points += _score_dependance_unit(r.get("poids_criticite"), relais_faible=True)
                            dep_items.append(
                                AnalysePosteDependanceItem(
                                    id_comp=r.get("id_comp"),
                                    code_comp=r.get("code"),
                                    intitule=r.get("intitule"),
                                    poids_criticite=int(r.get("poids_criticite") or 0),
                                    nb_porteurs_ok=n_relais,
                                    seuil_couverture=2,
                                    type_risque="RELAIS_FAIBLE",
                                )
                            )
                            candidates.append(
                                AnalysePosteTopRisqueItem(
                                    id_comp=r.get("id_comp"),
                                    code_comp=r.get("code"),
                                    intitule=r.get("intitule"),
                                    poids_criticite=int(r.get("poids_criticite") or 0),
                                    type_risque="RELEVE_FAIBLE",
                                    nb_porteurs=n_ok,
                                    nb_ok=n_ok,
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

                    score_structurel=int(structure_score),
                    score_efficacite=int(efficacite_score),
                    score_dependance=int(dependance_score),
                    score_transmission=int(transmission_score),
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
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                    },
                    person=AnalyseMatchingPerson(
                        id_effectif=id_effectif,
                        full=full,
                        nom_service=(e.get("nom_service") or "").strip() or "—",
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


def _analyse_effect_definitions() -> Dict[str, Dict[str, Any]]:
    families = ["Données", "Dépendance", "Couverture", "Renfort", "Transmission"]
    return {
        "rupture_activite": {
            "title": "Risque de rupture ou ralentissement d’activité",
            "central_effect": "L’activité peut ralentir ou se bloquer si les compétences indispensables ne sont pas suffisamment couvertes.",
            "families": families,
        },
        "qualite_execution": {
            "title": "Risque de baisse de qualité d’exécution",
            "central_effect": "La qualité, l’autonomie ou les délais peuvent se dégrader si la maîtrise réelle reste insuffisante.",
            "families": families,
        },
        "dependance_individuelle": {
            "title": "Risque de dépendance individuelle",
            "central_effect": "L’organisation dépend trop fortement de quelques personnes pour maintenir certaines compétences.",
            "families": families,
        },
        "perte_savoir_faire": {
            "title": "Risque de perte de savoir-faire",
            "central_effect": "Un savoir-faire important peut se fragiliser ou se perdre s’il n’est pas transmis à temps.",
            "families": families,
        },
    }

def _analyse_effect_level(score: int, count: int) -> str:
    s = _analyse_pdf_safe_int(score)
    c = _analyse_pdf_safe_int(count)
    if s >= 70 or c >= 5:
        return "Risque élevé"
    if s >= 35 or c > 0:
        return "Risque moyen"
    return "Risque faible"


def _analyse_effect_color(level: str):
    from reportlab.lib import colors
    s = (level or "").lower()
    if "élev" in s or "elev" in s:
        return colors.HexColor("#fee2e2"), colors.HexColor("#991b1b")
    if "moyen" in s:
        return colors.HexColor("#ffedd5"), colors.HexColor("#9a3412")
    return colors.HexColor("#f3f4f6"), colors.HexColor("#374151")


def _analyse_build_effect_metrics(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    horizon_years: int,
) -> List[Dict[str, Any]]:
    defs = _analyse_effect_definitions()

    total_absente = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente")) > 0)
    total_non_conf = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee")) > 0)
    total_insuff = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant")) > 0)
    total_dep = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_dependance")) > 0)
    total_renfort = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts_dispo")) <= 1)
    total_transmission = sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts")) <= 0)
    postes_fragiles = sum(1 for r in poste_records if _analyse_pdf_safe_int(r.get("indice_fragilite")) > 0)

    comp_frag_score = 0
    if comp_records:
        comp_frag_score = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in comp_records) / max(1, len(comp_records))))
    poste_frag_score = 0
    if poste_records:
        poste_frag_score = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in poste_records) / max(1, len(poste_records))))

    raw = [
        {
            "key": "rupture_activite",
            "count": total_absente + postes_fragiles + total_renfort,
            "score": max(poste_frag_score, comp_frag_score),
            "metric": _analyse_pdf_count(postes_fragiles, "poste fragile", "postes fragiles"),
            "causes": [
                _analyse_pdf_count(total_absente, "compétence avec un problème de couverture", "compétences avec un problème de couverture") if total_absente else "la couverture doit être vérifiée sur certaines compétences critiques",
                _analyse_pdf_count(total_renfort, "compétence sans renfort immédiat", "compétences sans renfort immédiat") if total_renfort else "le renfort immédiat reste à vérifier sur certaines compétences",
                _analyse_pdf_count(postes_fragiles, "poste déjà fragilisé", "postes déjà fragilisés") if postes_fragiles else "les postes sensibles sont à relire dans le détail",
                _analyse_pdf_count(total_dep, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne") if total_dep else "certaines compétences peuvent encore trop dépendre d’une seule personne",
            ],
        },
        {
            "key": "qualite_execution",
            "count": total_insuff + total_non_conf + total_absente,
            "score": comp_frag_score,
            "metric": f"{comp_frag_score}% de fragilité moyenne des compétences",
            "causes": [
                _analyse_pdf_count(total_insuff, "écart de maîtrise à vérifier", "écarts de maîtrise à vérifier") if total_insuff else "des écarts de maîtrise restent à vérifier",
                _analyse_pdf_count(total_non_conf, "compétence à confirmer", "compétences à confirmer") if total_non_conf else "certaines compétences doivent encore être confirmées",
                _analyse_pdf_count(total_absente, "compétence sans couverture suffisante", "compétences sans couverture suffisante") if total_absente else "la couverture reste à consolider sur les compétences les plus sensibles",
                _analyse_pdf_count(total_transmission, "compétence sans niveau expert", "compétences sans niveau expert") if total_transmission else "la transmission experte est mieux répartie sur le périmètre",
            ],
        },
        {
            "key": "dependance_individuelle",
            "count": total_dep,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": _analyse_pdf_count(total_dep, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne"),
            "causes": [
                _analyse_pdf_count(total_dep, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne") if total_dep else "la dépendance individuelle reste limitée",
                _analyse_pdf_count(total_renfort, "compétence sans renfort immédiat", "compétences sans renfort immédiat") if total_renfort else "les relais immédiats sont mieux répartis",
                _analyse_pdf_count(total_transmission, "compétence sans niveau expert", "compétences sans niveau expert") if total_transmission else "la transmission experte paraît mieux répartie",
                _analyse_pdf_count(total_non_conf, "compétence à confirmer", "compétences à confirmer") if total_non_conf else "les confirmations de niveau sont relativement à jour",
            ],
        },
        {
            "key": "perte_savoir_faire",
            "count": total_transmission + total_dep + total_non_conf,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": f"Projection à {horizon_years} an(s)",
            "causes": [
                _analyse_pdf_count(total_transmission, "compétence sans niveau expert", "compétences sans niveau expert") if total_transmission else "les compétences expertes restent globalement réparties",
                _analyse_pdf_count(total_dep, "compétence portée par une seule personne", "compétences portées par une seule personne") if total_dep else "la relève semble mieux répartie sur le périmètre",
                _analyse_pdf_count(total_renfort, "compétence sans renfort immédiat", "compétences sans renfort immédiat") if total_renfort else "les renforts immédiats paraissent présents sur le périmètre",
                _analyse_pdf_count(total_non_conf, "compétence à confirmer", "compétences à confirmer") if total_non_conf else "les données utiles à la transmission semblent correctement renseignées",
            ],
        },
    ]

    out = []
    for item in raw:
        d = defs[item["key"]]
        level = _analyse_effect_level(item["score"], item["count"])
        out.append({**item, **d, "level": level})
    return out

def _analyse_ishikawa_rows_for_effect(comp_records: List[Dict[str, Any]], effet: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for r in comp_records:
        comp_label = f"{r.get('code') or ''} - {r.get('intitule') or 'Compétence'}".strip(" -")
        frag = _analyse_pdf_safe_int(r.get("indice_fragilite"))
        n_abs = _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente"))
        n_dep = _analyse_pdf_safe_int(r.get("nb_postes_dependance"))
        n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
        n_ins = _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant"))
        n_exp = _analyse_pdf_safe_int(r.get("nb_experts"))
        n_exp_dispo = _analyse_pdf_safe_int(r.get("nb_experts_dispo"))

        if n_nc > 0:
            rows.append({"family": "Données", "comp": comp_label, "cause": "La compétence doit encore être confirmée ou réévaluée", "frag": frag})
        if n_dep > 0:
            rows.append({"family": "Dépendance", "comp": comp_label, "cause": "La compétence dépend d’une seule personne", "frag": frag})
        if n_abs > 0 or n_ins > 0:
            rows.append({"family": "Couverture", "comp": comp_label, "cause": "La couverture est insuffisante au regard du besoin du poste", "frag": frag})
        if n_exp_dispo <= 1:
            rows.append({"family": "Renfort", "comp": comp_label, "cause": "Le renfort immédiat reste insuffisant", "frag": frag})
        if n_exp <= 0:
            rows.append({"family": "Transmission", "comp": comp_label, "cause": "Aucun niveau expert n’est visible sur cette compétence", "frag": frag})

    # On garde un volume raisonnable pour le PDF tout en montrant les points les plus parlants.
    rows.sort(key=lambda x: (-_analyse_pdf_safe_int(x.get("frag")), str(x.get("family") or ""), str(x.get("comp") or "")))
    return rows[:40]

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
    unique_comps = len({str(r.get("comp") or "") for r in (rows or []) if str(r.get("comp") or "").strip()})
    if unique_comps <= 0:
        return "Aucun point détecté"
    if family == "Données":
        return _analyse_pdf_count(unique_comps, "compétence à confirmer", "compétences à confirmer")
    if family == "Dépendance":
        return _analyse_pdf_count(unique_comps, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne")
    if family == "Couverture":
        return _analyse_pdf_count(unique_comps, "compétence avec un problème de couverture", "compétences avec un problème de couverture")
    if family == "Renfort":
        return _analyse_pdf_count(unique_comps, "compétence sans renfort immédiat", "compétences sans renfort immédiat")
    if family == "Transmission":
        return _analyse_pdf_count(unique_comps, "compétence sans niveau expert", "compétences sans niveau expert")
    return _analyse_pdf_count(unique_comps, "point détecté", "points détectés")


def _analyse_ishikawa_visual(effect: Dict[str, Any], rows: List[Dict[str, Any]], metric: Dict[str, Any], width_mm: float = 270.0, height_mm: float = 118.0):
    from reportlab.graphics.shapes import Drawing, Line, Rect, String, Polygon
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    width = width_mm * mm
    height = height_mm * mm
    d = Drawing(width, height)
    red = colors.HexColor("#c1272d")
    text = colors.HexColor("#14213d")
    muted = colors.HexColor("#64748b")
    line = colors.HexColor("#cbd5e1")
    soft_red = colors.HexColor("#fff5f5")
    soft_gray = colors.HexColor("#f8fafc")

    center_y = height * 0.50
    spine_x1 = 26 * mm
    spine_x2 = width - 72 * mm
    effect_x = width - 67 * mm
    effect_y = center_y - 20 * mm
    effect_w = 60 * mm
    effect_h = 40 * mm

    d.add(Line(spine_x1, center_y, spine_x2, center_y, strokeColor=red, strokeWidth=1.8))
    d.add(Polygon([spine_x2, center_y, spine_x2 - 5 * mm, center_y + 3 * mm, spine_x2 - 5 * mm, center_y - 3 * mm], fillColor=red, strokeColor=red))
    d.add(Rect(effect_x, effect_y, effect_w, effect_h, rx=6, ry=6, strokeColor=red, fillColor=soft_red, strokeWidth=1))
    d.add(String(effect_x + 4 * mm, effect_y + 29 * mm, "Effet identifié", fontName="Helvetica-Bold", fontSize=8.2, fillColor=muted))
    title_lines = _analyse_pdf_wrap_lines(effect.get("title"), 28, 3)
    for idx, line_txt in enumerate(title_lines):
        d.add(String(effect_x + 4 * mm, effect_y + 20 * mm - (idx * 4.5 * mm), line_txt, fontName="Helvetica-Bold", fontSize=8.8, fillColor=text))
    d.add(String(effect_x + 4 * mm, effect_y + 4 * mm, _analyse_pdf_short(metric.get("level") or "Risque à qualifier", 28), fontName="Helvetica", fontSize=8, fillColor=red))

    grouped = _analyse_ishikawa_group_rows(rows, effect.get("families") or [])
    families = [f for f in (effect.get("families") or [])[:5]]
    coords = [
        (48 * mm, center_y + 36 * mm, True),
        (95 * mm, center_y + 36 * mm, True),
        (142 * mm, center_y + 36 * mm, True),
        (72 * mm, center_y - 48 * mm, False),
        (124 * mm, center_y - 48 * mm, False),
    ]
    for idx, fam in enumerate(families):
        if idx >= len(coords):
            break
        x_anchor, y_box, is_top = coords[idx]
        box_w = 42 * mm
        box_h = 18 * mm
        if is_top:
            d.add(Line(x_anchor, center_y, x_anchor - 11 * mm, y_box, strokeColor=line, strokeWidth=1.2))
        else:
            d.add(Line(x_anchor, center_y, x_anchor - 11 * mm, y_box + box_h, strokeColor=line, strokeWidth=1.2))
        d.add(Rect(x_anchor - 19 * mm, y_box, box_w, box_h, rx=4, ry=4, strokeColor=colors.HexColor("#e5e7eb"), fillColor=soft_gray, strokeWidth=0.8))
        d.add(String(x_anchor - 16 * mm, y_box + 11.5 * mm, fam, fontName="Helvetica-Bold", fontSize=7.8, fillColor=text))
        summary = _analyse_ishikawa_family_summary(fam, grouped.get(fam) or [])
        for li, line_txt in enumerate(_analyse_pdf_wrap_lines(summary, 30, 2)):
            d.add(String(x_anchor - 16 * mm, y_box + 5.4 * mm - (li * 3.6 * mm), line_txt, fontName="Helvetica", fontSize=6.6, fillColor=muted))

    return d


def _analyse_report_ring_like(title: str, value: int, color_hex: str, width_mm: float = 86.0, height_mm: float = 54.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    d = Drawing(width_mm * mm, height_mm * mm)
    color = colors.HexColor(color_hex)
    soft = colors.HexColor("#f8fafc")
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.5, fillColor=colors.HexColor("#1f2937")))
    # jauge contemporaine simple
    bar_x = 5 * mm
    bar_y = 20 * mm
    bar_w = (width_mm - 10) * mm
    d.add(Rect(bar_x, bar_y, bar_w, 5 * mm, rx=2.5, ry=2.5, strokeColor=colors.HexColor("#e5e7eb"), fillColor=soft, strokeWidth=0.6))
    fill_w = max(3 * mm, min(bar_w, bar_w * max(0, min(100, _analyse_pdf_safe_int(value))) / 100.0))
    d.add(Rect(bar_x, bar_y, fill_w, 5 * mm, rx=2.5, ry=2.5, strokeColor=color, fillColor=color, strokeWidth=0.6))
    d.add(String(5 * mm, 31 * mm, f"{_analyse_pdf_safe_int(value)}%", fontName="Helvetica-Bold", fontSize=17, fillColor=colors.HexColor("#14213d")))
    d.add(String(5 * mm, 10 * mm, "Lecture du risque actuel", fontName="Helvetica", fontSize=7.2, fillColor=colors.HexColor("#64748b")))
    return d


def _analyse_report_pie_panel(title: str, labels: List[str], data: List[int], colors_hex: List[str], width_mm: float = 86.0, height_mm: float = 66.0):
    from reportlab.graphics.shapes import Drawing, Rect, String, Circle
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.5, fillColor=colors.HexColor("#1f2937")))
    p = Pie()
    p.x = 5 * mm
    p.y = 11 * mm
    p.width = 35 * mm
    p.height = 35 * mm
    safe_data = [max(0, int(v or 0)) for v in data]
    if sum(safe_data) <= 0:
        safe_data = [1]
        labels = ["Aucun point"]
        colors_hex = ["#d1d5db"]
    p.data = safe_data
    p.labels = [""] * len(safe_data)
    p.slices.strokeWidth = 0.3
    for i, hx in enumerate(colors_hex[:len(safe_data)]):
        p.slices[i].fillColor = colors.HexColor(hx)
    d.add(p)
    d.add(Circle(22.5 * mm, 28.5 * mm, 8 * mm, fillColor=colors.white, strokeColor=colors.white))
    total = sum(safe_data)
    d.add(String(18 * mm, 28.7 * mm, str(total), fontName="Helvetica-Bold", fontSize=11, fillColor=colors.HexColor("#14213d")))
    legend_y = height_mm * mm - 16 * mm
    for i, (lbl, val) in enumerate(zip(labels[:4], safe_data[:4])):
        y = legend_y - i * 8 * mm
        d.add(Rect(47 * mm, y - 1.5 * mm, 3.5 * mm, 3.5 * mm, fillColor=colors.HexColor(colors_hex[i]), strokeColor=colors.HexColor(colors_hex[i])))
        d.add(String(52 * mm, y, _analyse_pdf_short(f"{lbl} ({val})", 28), fontName="Helvetica", fontSize=7.2, fillColor=colors.HexColor("#475569")))
    return d


def _analyse_report_hbars_panel(title: str, items: List[Dict[str, Any]], label_key: str, value_key: str, width_mm: float = 176.0, height_mm: float = 68.0):
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    d = Drawing(width_mm * mm, height_mm * mm)
    d.add(Rect(0, 0, width_mm * mm, height_mm * mm, rx=6, ry=6, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.white, strokeWidth=0.8))
    d.add(String(5 * mm, height_mm * mm - 7 * mm, title, fontName="Helvetica-Bold", fontSize=8.5, fillColor=colors.HexColor("#1f2937")))
    y = height_mm * mm - 16 * mm
    shown = items[:5]
    if not shown:
        d.add(String(5 * mm, y, "Aucune donnée à afficher", fontName="Helvetica", fontSize=8, fillColor=colors.HexColor("#64748b")))
        return d
    for row in shown:
        label = _analyse_pdf_short(row.get(label_key), 32)
        value = _analyse_pdf_safe_int(row.get(value_key))
        d.add(String(5 * mm, y, label, fontName="Helvetica", fontSize=7.6, fillColor=colors.HexColor("#334155")))
        d.add(Rect(64 * mm, y - 2 * mm, 92 * mm, 3.5 * mm, rx=1.7, ry=1.7, strokeColor=colors.HexColor("#e5e7eb"), fillColor=colors.HexColor("#f3f4f6"), strokeWidth=0.4))
        fill_w = max(2 * mm, min(92 * mm, 92 * mm * value / 100.0)) if value > 0 else 0
        if fill_w > 0:
            d.add(Rect(64 * mm, y - 2 * mm, fill_w, 3.5 * mm, rx=1.7, ry=1.7, strokeColor=colors.HexColor("#c1272d"), fillColor=colors.HexColor("#c1272d"), strokeWidth=0.4))
        d.add(String(160 * mm, y, f"{value}%", fontName="Helvetica-Bold", fontSize=7.4, fillColor=colors.HexColor("#1f2937")))
        y -= 10 * mm
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


def _analyse_pdf_stat_card(label: str, value: str, detail: str, styles: Dict[str, Any], width_mm: float = 63.0):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Table, TableStyle
    value_style = styles["body"].clone("StatValue")
    value_style.fontName = "Helvetica-Bold"
    value_style.fontSize = 15
    value_style.leading = 18
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
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tbl


def _analyse_family_counts(comp_records: List[Dict[str, Any]], effects: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    counts: Dict[str, int] = {}
    for e in effects or []:
        rows = _analyse_ishikawa_rows_for_effect(comp_records, str(e.get("key") or ""))
        for row in rows:
            fam = str(row.get("family") or "Données à confirmer")
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


@router.get("/skills/analyse/ishikawa/{id_contact}")
def get_analyse_ishikawa_pdf(
    id_contact: str,
    request: Request,
    effet: str = Query(default="rupture_activite"),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
    horizon_years: int = Query(default=1, ge=1, le=5),
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
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))

        rows = _analyse_ishikawa_rows_for_effect(comp_records, effect_key)
        metrics = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years))
        metric = next((m for m in metrics if m.get("key") == effect_key), None) or {}

        styles = build_pdf_styles()
        title_style = styles["title"]
        body_style = styles["body"]
        small_style = styles["small"]

        story = []
        story.append(Paragraph("Ishikawa", title_style))
        story.append(make_spacer(2))

        meta_cards = Table([[
            _analyse_pdf_stat_card("Effet identifié", effect["title"], "Lecture cause / effet", styles, 86),
            _analyse_pdf_stat_card("Périmètre", scope.nom_service, "Périmètre analysé", styles, 86),
            _analyse_pdf_stat_card("Horizon", f"{horizon_years} an(s)", "Projection retenue", styles, 86),
        ]], colWidths=[89 * mm, 89 * mm, 89 * mm])
        meta_cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(meta_cards)
        story.append(make_spacer(4))

        top = Table([[_analyse_pdf_level_card(str(metric.get("level") or "Risque à qualifier"), styles, 36), _analyse_pdf_bar(_analyse_pdf_safe_int(metric.get("score")), 170)]], colWidths=[40 * mm, 182 * mm])
        top.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.append(top)
        story.append(make_spacer(5))

        story.append(Paragraph("Diagramme cause / effet", styles["section"]))
        story.append(_analyse_ishikawa_visual(effect, rows, metric))

        story.append(PageBreak())
        story.append(Paragraph("Détail des causes identifiées", title_style))
        story.append(make_spacer(3))
        if rows:
            cause_rows = [[Paragraph("Famille", small_style), Paragraph("Compétence", small_style), Paragraph("Point identifié", small_style), Paragraph("Fragilité", small_style)]]
            for row in rows:
                cause_rows.append([
                    Paragraph(_analyse_pdf_esc(row.get("family")), body_style),
                    Paragraph(_analyse_pdf_esc(row.get("comp")), body_style),
                    Paragraph(_analyse_pdf_esc(row.get("cause")), body_style),
                    Paragraph(_analyse_pdf_esc(str(row.get("frag") or 0) + "%"), body_style),
                ])
            t2 = Table(cause_rows, colWidths=[36 * mm, 80 * mm, 126 * mm, 22 * mm], repeatRows=1)
            t2.setStyle(TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(t2)
        else:
            story.append(Paragraph("Aucune cause détaillée n’a été isolée pour cet effet dans le périmètre actuel.", body_style))

        pdf = build_pdf_document(story, {
            "title": f"Ishikawa - {effect['title']}",
            "footer_left": "Novoskill Insights • Ishikawa Analyse des compétences",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
        }, page_size=landscape(A4))
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": 'inline; filename="ishikawa_analyse_competences.pdf"'},
        )
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
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, Table, TableStyle, PageBreak
        from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles, make_spacer

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                company_name = _analyse_pdf_company_name(cur, id_ent)
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))

        effects = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years))
        styles = build_pdf_styles()
        title_style = styles["title"]
        body_style = styles["body"]
        section_style = styles["section"]

        nb_postes = len(poste_records or [])
        nb_comps = len(comp_records or [])
        frag_postes = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in poste_records) / max(1, nb_postes))) if nb_postes else 0
        frag_comps = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in comp_records) / max(1, nb_comps))) if nb_comps else 0
        effects_detected = sum(1 for e in effects if _analyse_pdf_safe_int(e.get("count")) > 0)

        family_counts = {
            "Données": sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee")) > 0),
            "Dépendance": sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_dependance")) > 0),
            "Couverture": sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente")) > 0 or _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant")) > 0),
            "Renfort": sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts_dispo")) <= 1),
            "Transmission": sum(1 for r in comp_records if _analyse_pdf_safe_int(r.get("nb_experts")) <= 0),
        }

        story = []
        story.append(Paragraph("Rapport d’analyse des risques compétences", title_style))
        story.append(make_spacer(3))

        kpis = Table([[
            _analyse_pdf_stat_card("Postes analysés", str(nb_postes), "Périmètre lu", styles, 63),
            _analyse_pdf_stat_card("Compétences analysées", str(nb_comps), "Compétences critiques retenues", styles, 63),
            _analyse_pdf_stat_card("Effets détectés", str(effects_detected), "Effets terrain suivis", styles, 63),
            _analyse_pdf_stat_card("Horizon", f"{horizon_years} an(s)", "Projection du rapport", styles, 63),
        ]], colWidths=[66 * mm, 66 * mm, 66 * mm, 66 * mm])
        kpis.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(kpis)
        story.append(make_spacer(6))

        row1 = Table([[
            _analyse_report_ring_like("Fragilité moyenne des postes", frag_postes, "#c1272d", 86, 54),
            _analyse_report_ring_like("Fragilité moyenne des compétences", frag_comps, "#f59e0b", 86, 54),
            _analyse_report_pie_panel("Effets terrain détectés", [e.get("title") for e in effects], [e.get("count") for e in effects], ["#c1272d", "#f59e0b", "#fb7185", "#94a3b8"], 86, 54),
        ]], colWidths=[89 * mm, 89 * mm, 89 * mm])
        row1.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(row1)
        story.append(make_spacer(6))

        row2 = Table([[
            _analyse_report_pie_panel("Familles de causes", list(family_counts.keys()), list(family_counts.values()), ["#475569", "#c1272d", "#f59e0b", "#fb7185", "#0f766e"], 86, 66),
            _analyse_report_hbars_panel("Postes les plus fragiles", [
                {"label": f"{(p.get('codif_poste') or p.get('codif_client') or '').strip()} - {(p.get('intitule_poste') or 'Poste').strip()}", "value": _analyse_pdf_safe_int(p.get('indice_fragilite'))}
                for p in sorted(poste_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:5]
            ], "label", "value", 86, 66),
            _analyse_report_hbars_panel("Compétences les plus fragiles", [
                {"label": f"{(c.get('code') or '').strip()} - {(c.get('intitule') or 'Compétence').strip()}", "value": _analyse_pdf_safe_int(c.get('indice_fragilite'))}
                for c in sorted(comp_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:5]
            ], "label", "value", 86, 66),
        ]], colWidths=[89 * mm, 89 * mm, 89 * mm])
        row2.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(row2)
        story.append(make_spacer(6))

        story.append(Paragraph("Lecture des risques", section_style))
        effect_cards = []
        for e in effects:
            effect_cards.append(_analyse_pdf_stat_card(e.get("title"), e.get("level"), _analyse_pdf_short(e.get("metric"), 42), styles, 86))
        if effect_cards:
            effect_rows = [effect_cards[i:i+3] for i in range(0, len(effect_cards), 3)]
            while effect_rows and len(effect_rows[-1]) < 3:
                effect_rows[-1].append(Paragraph("", body_style))
            t_cards = Table(effect_rows, colWidths=[89 * mm, 89 * mm, 89 * mm])
            t_cards.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
            story.append(t_cards)

        for e in effects:
            if _analyse_pdf_safe_int(e.get("count")) <= 0:
                continue
            story.append(PageBreak())
            story.append(Paragraph(f"Ishikawa • {e.get('title')}", title_style))
            story.append(make_spacer(2))
            story.append(_analyse_ishikawa_visual(_analyse_effect_definitions().get(e.get("key")), _analyse_ishikawa_rows_for_effect(comp_records, e.get("key")), e))
            story.append(make_spacer(4))

        pdf = build_pdf_document(story, {
            "title": "Rapport d’analyse des risques compétences",
            "footer_left": "Novoskill Insights • Rapport d’analyse des risques compétences",
            "header_right": company_name,
            "header_right_font_name": "Helvetica-Bold",
            "header_right_font_size": 11,
        }, page_size=landscape(A4))
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": 'inline; filename="rapport_analyse_risques_competences.pdf"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération rapport analyse: {e}")
