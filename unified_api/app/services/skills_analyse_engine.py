from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple
from collections import defaultdict
import re
import json

from fastapi import HTTPException
from pydantic import BaseModel


NON_LIE_ID = "__NON_LIE__"

CRITICITE_MIN_DEFAULT = 70

CRITICITE_MIN_MIN = 0

CRITICITE_MIN_MAX = 100

class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str

def _analyse_add_months(base: date, months: int) -> date:
    m = base.month - 1 + int(months or 0)
    y = base.year + m // 12
    m = m % 12 + 1
    days = [31, 29 if y % 4 == 0 and (y % 100 != 0 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    d = min(base.day, days[m - 1])
    return date(y, m, d)

def _analyse_month_bounds_from_today(month_offset: int) -> Tuple[date, date]:
    today = date.today()
    m = max(0, int(month_offset or 0))
    if m <= 0:
        return today, today

    if "_analyse_add_months" in globals():
        d = _analyse_add_months(today, m)
        start = date(d.year, d.month, 1)
        end = _analyse_add_months(start, 1) - timedelta(days=1)
        return start, end

    raw_m = today.month - 1 + m
    y = today.year + raw_m // 12
    mo = raw_m % 12 + 1
    start = date(y, mo, 1)
    raw_next = mo
    y2 = y + raw_next // 12
    mo2 = raw_next % 12 + 1
    end = date(y2, mo2, 1) - timedelta(days=1)
    return start, end

def _analyse_date_fr_value(v: Any) -> str:
    if not v:
        return ""
    try:
        if hasattr(v, "strftime"):
            return v.strftime("%d/%m/%Y")
        s = str(v)
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
        return s
    except Exception:
        return str(v or "")

def _analyse_projection_period(months: int) -> Tuple[date, date]:
    today = date.today()
    m = max(0, int(months or 0))
    return today, _analyse_add_months(today, m)

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

def _matching_state_for_score(score: Optional[float], niveau_requis: Optional[str]) -> Tuple[str, float, Optional[str]]:
    seuil = _score_seuil_for_niveau(niveau_requis)
    if score is None:
        return "missing", 0.0, None

    try:
        score_f = float(score)
    except Exception:
        return "missing", 0.0, None

    ratio = 0.0
    if seuil > 0:
        ratio = min(max(score_f / float(seuil), 0.0), 1.0)

    niveau_atteint = _niveau_from_score(score_f)
    req_rank = _niveau_rank(niveau_requis)
    att_rank = _niveau_rank(niveau_atteint)

    if req_rank > 0 and att_rank < req_rank:
        return "under", ratio, niveau_atteint

    if seuil > 0 and score_f < seuil:
        return "improvable", ratio, niveau_atteint

    return "ok", ratio, niveau_atteint

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

def _score_structure_coverage(nb_titulaires: Any, nb_cible: Any) -> int:
    cible = max(_safe_int(nb_cible, 1), 1)
    dispo = max(_safe_int(nb_titulaires, 0), 0)
    gap = max(cible - dispo, 0)
    if gap <= 0:
        return 0
    if dispo <= 0:
        return 100
    ratio = gap / float(cible)
    return max(15, min(45, int(round(45 * ratio))))

def _score_sorties_approchantes(nb_sorties: Any, nb_cible: Any) -> int:
    nb = max(_safe_int(nb_sorties, 0), 0)
    if nb <= 0:
        return 0
    cible = max(_safe_int(nb_cible, 1), 1)
    ratio = min(1.0, nb / float(cible))
    return max(6, min(15, int(round(15 * ratio))))

def _score_renfort_potential(nb_immediats: Any, nb_a_preparer: Any, meilleur_matching: Any) -> int:
    imm = max(_safe_int(nb_immediats, 0), 0)
    prep = max(_safe_int(nb_a_preparer, 0), 0)
    best = max(_safe_int(meilleur_matching, 0), 0)
    if imm > 0:
        return 0
    if prep > 0:
        return 6
    if best >= 1:
        return 10
    return 15

def _recompute_poste_score_from_components(row: Dict[str, Any]) -> None:
    rupture = bool(row.get("rupture") or False)
    if rupture:
        row["indice_fragilite"] = 100
        row["is_fragile"] = True
        row["score_competences"] = 100
        row["score_total"] = 100
        return

    structure = max(_safe_int(row.get("score_structurel"), 0), 0)
    efficacite = max(_safe_int(row.get("score_efficacite"), 0), 0)
    dependance = max(_safe_int(row.get("score_dependance"), 0), 0)
    sorties = max(_safe_int(row.get("score_sorties_approchantes"), 0), 0)
    renfort = max(_safe_int(row.get("score_renfort_potentiel"), 0), 0)

    base = structure + efficacite + dependance
    # Les sorties proches et le manque de renfort sont des facteurs aggravants :
    # ils pèsent quand le poste présente déjà une fragilité ou une dépendance structurelle.
    aggravants = (sorties + renfort) if base > 0 else 0
    score = min(95, base + aggravants)

    row["score_competences"] = base
    row["score_total"] = score
    row["indice_fragilite"] = int(score)
    row["is_fragile"] = bool(score > 0)

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

    nb_dispo = max(_safe_int(row.get("nb_titulaires"), 0), 0)
    nb_rattaches = max(_safe_int(row.get("nb_titulaires_rattaches"), nb_dispo), 0)
    nb_indispo = max(_safe_int(row.get("nb_indisponibles"), max(nb_rattaches - nb_dispo, 0)), 0)
    nb_sorties = max(_safe_int(row.get("nb_sorties_approchantes"), 0), 0)
    nb_cible = max(_safe_int(row.get("nb_titulaires_cible"), 1), 1)
    gap = max(nb_cible - nb_dispo, 0)
    rupture = (nb_dispo <= 0 and nb_cible >= 1)

    # Pour les écarts de maîtrise, on ne transforme pas une absence de titulaire en écart compétence.
    # L'efficacité se lit sur les titulaires réellement disponibles.
    besoin_local = max(min(nb_dispo, nb_cible), 0)
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

    nb_niveau_non_atteint = 0
    nb_dependances = 0
    efficiency_missing_units = 0
    efficiency_points = 0
    dependance_points = 0
    nb_couvertures_non_confirmees = 0

    for c in comp_rows or []:
        nb_tit_any = max(_safe_int(c.get("nb_tit_any"), 0), 0)
        nb_tit_ok = max(_safe_int(c.get("nb_tit_ok"), 0), 0)

        if besoin_local <= 0:
            continue

        missing_validated = max(besoin_local - nb_tit_ok, 0)
        if missing_validated > 0:
            nb_niveau_non_atteint += 1
            efficiency_missing_units += missing_validated
            efficiency_points += missing_validated * _score_efficacite_unit(c.get("poids_criticite"))

        declared_but_not_validated = max(min(nb_tit_any, besoin_local) - nb_tit_ok, 0)
        if declared_but_not_validated > 0:
            nb_couvertures_non_confirmees += declared_but_not_validated

        # Dépendance = lecture interne au poste : une couverture suffisante repose sur une seule personne.
        # Le renfort externe est traité à part par matching de poste.
        if besoin_local == 1 and nb_tit_ok == 1:
            nb_dependances += 1
            dependance_points += _score_dependance_unit(c.get("poids_criticite"), relais_faible=True)

    structure_score = _score_structure_coverage(nb_dispo, nb_cible)
    efficacite_score = min(45, efficiency_points)
    dependance_score = min(25, dependance_points)
    sortie_score = _score_sorties_approchantes(nb_sorties, nb_cible)

    row.update({
        "nb_titulaires": nb_dispo,
        "nb_titulaires_rattaches": nb_rattaches,
        "nb_titulaires_disponibles": nb_dispo,
        "nb_indisponibles": nb_indispo,
        "nb_sorties_approchantes": nb_sorties,
        "nb_titulaires_cible": nb_cible,
        "gap_titulaires": gap,
        "pool_total": pool_total,
        "pool_eligible": pool_eligible,
        "nb_competences_analysees": nb_competences_analysees,
        "is_non_analyse": bool(nb_competences_analysees <= 0 and not rupture),
        "motif_fragilite": "Couverture du poste insuffisante" if rupture else ("Référentiel poste incomplet" if nb_competences_analysees <= 0 else ""),
        "nb_couvertures_non_confirmees": nb_couvertures_non_confirmees,
        "nb_critiques_sans_porteur": nb_niveau_non_atteint,
        "nb_critiques_porteur_unique": nb_dependances,
        "nb_critiques_fragiles": nb_niveau_non_atteint + nb_dependances + (1 if gap > 0 else 0) + (1 if nb_sorties > 0 else 0),
        "nb_critiques_sans_releve": 0,
        "nb_critiques_releve_faible": 0,
        "score_structurel": structure_score,
        "score_efficacite": efficacite_score,
        "score_dependance": dependance_score,
        "score_sorties_approchantes": sortie_score,
        "score_renfort_potentiel": 0,
        "score_transmission": 0,
        "score_competences": 0,
        "base_score": 0,
        "indice_fragilite": 0,
        "is_fragile": False,
        "rupture": rupture,
        "besoin_local": besoin_local,
    })
    _recompute_poste_score_from_components(row)
    row["base_score"] = row.get("score_competences", 0)
    return row

def _analyse_matching_potential_by_poste(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    period_start: date,
    period_end: date,
    seuil_immediat: int = 75,
    seuil_a_preparer: int = 60,
    excluded_effectif_ids: Optional[List[str]] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Renfort potentiel par poste.
    Même base de calcul que le tableau Correspondance profils / postes :
    - mêmes compétences retenues selon la criticité minimale ;
    - même score pondéré par niveau requis A/B/C/D ;
    - seuls les non-titulaires disponibles sur la période sont comptés comme renforts.
    """
    if period_start > period_end:
        period_start, period_end = period_end, period_start
    scope_id = (id_service or "").strip() or None
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)

    excluded_ids = sorted({str(x or "").strip() for x in (excluded_effectif_ids or []) if str(x or "").strip()})
    excluded_filter_sql = ""
    excluded_filter_params: List[Any] = []
    if excluded_ids:
        excluded_filter_sql = "AND NOT (e.id_effectif::text = ANY(%s::text[]))"
        excluded_filter_params.append(excluded_ids)

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT fp.id_poste, fp.codif_poste, COALESCE(fp.codif_client,'') AS codif_client, COALESCE(fp.intitule_poste,'') AS intitule_poste
        FROM public.tbl_fiche_poste fp
        JOIN postes_scope ps ON ps.id_poste = fp.id_poste
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
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
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
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
            "poids": max(1, _safe_int(row.get("poids_criticite"))),
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
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (
            SELECT 1 FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= %s
              AND b.date_fin >= %s
          )
          {excluded_filter_sql}
        """,
        tuple(cte_params + [id_ent, period_end, period_end, period_start] + excluded_filter_params),
    )
    effectifs = [dict(r) for r in (cur.fetchall() or [])]
    effectif_poste = {str(r.get("id_effectif") or "").strip(): str(r.get("id_poste_actuel") or "").strip() for r in effectifs if str(r.get("id_effectif") or "").strip()}
    if not comp_ids or not effectif_poste:
        return {pid: {**meta, "nb_renforts_immediats": 0, "nb_renforts_a_preparer": 0, "meilleur_matching": 0} for pid, meta in poste_map.items()}

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
            out[pid] = {**poste, "nb_renforts_immediats": 0, "nb_renforts_a_preparer": 0, "meilleur_matching": 0}
            continue
        poids_total = sum(max(1, _safe_int(r.get("poids"))) for r in reqs) or 1
        nb_imm = 0
        nb_prep_total = 0
        best = 0
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
                ratio = 0.0 if score is None or seuil <= 0 else min(max(float(score) / float(seuil), 0.0), 1.0)
                sum_ratio += max(1, _safe_int(req.get("poids"))) * ratio
            score_pct = int(round((sum_ratio / float(poids_total)) * 100.0))
            score_pct = max(0, min(100, score_pct))
            best = max(best, score_pct)
            if score_pct >= int(seuil_a_preparer):
                nb_prep_total += 1
            if score_pct >= int(seuil_immediat):
                nb_imm += 1
        out[pid] = {
            **poste,
            "nb_renforts_immediats": nb_imm,
            "nb_renforts_a_preparer": max(nb_prep_total - nb_imm, 0),
            "meilleur_matching": best,
        }
    return out

def _augment_poste_records_with_matching_potential(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    records: List[Dict[str, Any]],
    period_start: date,
    period_end: date,
    excluded_effectif_ids: Optional[List[str]] = None,
) -> None:
    if not records:
        return
    try:
        match = _analyse_matching_potential_by_poste(
            cur,
            id_ent,
            id_service,
            criticite_min,
            period_start,
            period_end,
            excluded_effectif_ids=excluded_effectif_ids,
        )
    except Exception:
        match = {}
    for row in records:
        pid = str(row.get("id_poste") or "").strip()
        m = match.get(pid) or {}
        imm = max(_safe_int(m.get("nb_renforts_immediats"), 0), 0)
        prep = max(_safe_int(m.get("nb_renforts_a_preparer"), 0), 0)
        best = max(_safe_int(m.get("meilleur_matching"), 0), 0)
        row["nb_renforts_immediats"] = imm
        row["nb_renforts_a_preparer"] = prep
        row["meilleur_matching"] = best
        row["score_renfort_potentiel"] = _score_renfort_potential(imm, prep, best)
        row["score_transmission"] = row["score_renfort_potentiel"]
        row["nb_critiques_sans_releve"] = 1 if imm <= 0 else 0
        row["nb_critiques_releve_faible"] = 1 if (imm <= 0 and prep > 0) else 0
        _recompute_poste_score_from_components(row)
        row["base_score"] = row.get("score_competences", 0)

def _fetch_postes_fragility_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
) -> List[Dict[str, Any]]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    today = date.today()
    horizon_3m = _analyse_add_months(today, 3)

    sql_postes = f"""
    WITH
    {cte_sql},
    titulaires_rattaches AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires_rattaches
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
        GROUP BY e.id_poste_actuel
    ),
    titulaires_dispo AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
          AND NOT EXISTS (
            SELECT 1 FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= CURRENT_DATE
              AND b.date_fin >= CURRENT_DATE
          )
        GROUP BY e.id_poste_actuel
    ),
    titulaires_indispo AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_indisponibles
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
          AND EXISTS (
            SELECT 1 FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= CURRENT_DATE
              AND b.date_fin >= CURRENT_DATE
          )
        GROUP BY e.id_poste_actuel
    ),
    titulaires_sorties AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_sorties_approchantes
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
          AND e.date_sortie_prevue IS NOT NULL
          AND e.date_sortie_prevue >= CURRENT_DATE
          AND e.date_sortie_prevue <= %s
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
        CASE WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$' THEN trim(fp.niveau_education_minimum)::int ELSE 0 END AS edu_min_rank,
        (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
        COALESCE(nd.titre, '')::text AS nsf_domaine_titre,
        COALESCE(td.nb_titulaires, 0)::int AS nb_titulaires,
        COALESCE(tr.nb_titulaires_rattaches, 0)::int AS nb_titulaires_rattaches,
        COALESCE(ti.nb_indisponibles, 0)::int AS nb_indisponibles,
        COALESCE(ts.nb_sorties_approchantes, 0)::int AS nb_sorties_approchantes
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
    LEFT JOIN public.tbl_entreprise_organigramme o ON o.id_ent = %s AND o.id_service = fp.id_service AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    LEFT JOIN titulaires_dispo td ON td.id_poste = fp.id_poste
    LEFT JOIN titulaires_rattaches tr ON tr.id_poste = fp.id_poste
    LEFT JOIN titulaires_indispo ti ON ti.id_poste = fp.id_poste
    LEFT JOIN titulaires_sorties ts ON ts.id_poste = fp.id_poste
    """
    cur.execute(sql_postes, tuple(cte_params + [id_ent, id_ent, id_ent, id_ent, horizon_3m, id_ent]))
    poste_rows = cur.fetchall() or []
    if not poste_rows:
        return []
    postes_map = {str(r.get("id_poste") or ""): dict(r) for r in poste_rows}

    sql_emps = f"""
    WITH {cte_sql}
    SELECT e.id_effectif, e.id_poste_actuel, COALESCE(e.niveau_education, '') AS niveau_education, COALESCE(e.domaine_education, '') AS domaine_education
    FROM public.tbl_effectif_client e
    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
    WHERE e.id_ent = %s
      AND COALESCE(e.archive, FALSE) = FALSE
      AND COALESCE(e.statut_actif, TRUE) = TRUE
      AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM public.tbl_effectif_client_break b
        WHERE b.id_effectif = e.id_effectif
          AND COALESCE(b.archive, FALSE) = FALSE
          AND b.date_debut <= CURRENT_DATE
          AND b.date_fin >= CURRENT_DATE
      )
    """
    cur.execute(sql_emps, tuple(cte_params + [id_ent]))
    employees = [dict(r) for r in (cur.fetchall() or [])]

    sql_comp = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
        SELECT es.id_effectif
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
          AND NOT EXISTS (
            SELECT 1 FROM public.tbl_effectif_client_break b
            WHERE b.id_effectif = e.id_effectif
              AND COALESCE(b.archive, FALSE) = FALSE
              AND b.date_debut <= CURRENT_DATE
              AND b.date_fin >= CURRENT_DATE
          )
    ),
    poste_info AS (
        SELECT fp.id_poste,
               CASE WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$' THEN trim(fp.niveau_education_minimum)::int ELSE 0 END AS edu_min_rank,
               (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
               COALESCE(nd.titre, '')::text AS nsf_domaine_titre
        FROM postes_scope ps
        JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
        LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    ),
    req AS (
        SELECT DISTINCT pi.id_poste, c.id_comp, c.code, c.intitule, COALESCE(fpc.niveau_requis, '')::text AS niveau_requis,
               COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite, pi.edu_min_rank, pi.nsf_domain_required, pi.nsf_domaine_titre
        FROM poste_info pi
        JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = pi.id_poste
        JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE c.etat = 'active'
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    pool_all_effectifs AS (
        SELECT e.id_effectif, e.id_poste_actuel, COALESCE(e.niveau_education, '') AS niveau_education, COALESCE(e.domaine_education, '') AS domaine_education
        FROM public.tbl_effectif_client e
        JOIN effectifs_dispo ed ON ed.id_effectif = e.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
    ),
    ec_raw AS (
        SELECT r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis, pe.id_effectif, pe.id_poste_actuel,
               CASE upper(trim(COALESCE(r.niveau_requis, ''))) WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 0 END AS req_rank,
               CASE lower(trim(COALESCE(ec.niveau_actuel, ''))) WHEN 'a' THEN 1 WHEN 'initial' THEN 1 WHEN 'b' THEN 2 WHEN 'intermediaire' THEN 2 WHEN 'intermédiaire' THEN 2 WHEN 'c' THEN 3 WHEN 'avance' THEN 3 WHEN 'avancé' THEN 3 WHEN 'avancee' THEN 3 WHEN 'avancée' THEN 3 WHEN 'd' THEN 4 WHEN 'expert' THEN 4 ELSE 0 END AS act_rank,
               CASE WHEN a.resultat_eval IS NOT NULL AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL) THEN TRUE ELSE FALSE END AS is_evaluee,
               CASE WHEN (r.edu_min_rank = 0 OR (CASE WHEN trim(COALESCE(pe.niveau_education, '')) ~ '^[0-9]+$' THEN trim(pe.niveau_education)::int ELSE 0 END) >= r.edu_min_rank)
                    AND (r.nsf_domain_required = FALSE OR (lower(trim(COALESCE(pe.domaine_education, ''))) = lower(trim(COALESCE(r.nsf_domaine_titre, ''))) AND COALESCE(r.nsf_domaine_titre, '') <> '')) THEN TRUE ELSE FALSE END AS is_eligible
        FROM req r
        JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = r.id_comp
        LEFT JOIN public.tbl_effectif_client_audit_competence a ON a.id_audit_competence = ec.id_dernier_audit AND a.id_effectif_competence = ec.id_effectif_competence
        JOIN pool_all_effectifs pe ON pe.id_effectif = ec.id_effectif_client
        WHERE COALESCE(ec.actif, TRUE) = TRUE AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    ec_ok AS (
        SELECT *, CASE WHEN req_rank > 0 THEN (is_evaluee AND act_rank >= req_rank) ELSE (is_evaluee AND act_rank > 0) END AS is_ok
        FROM ec_raw
    )
    SELECT r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis,
           COUNT(DISTINCT CASE WHEN eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_any,
           COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible AND eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_ok,
           COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible THEN eok.id_effectif END)::int AS nb_ok_all
    FROM req r
    LEFT JOIN ec_ok eok ON eok.id_poste = r.id_poste AND eok.id_comp = r.id_comp
    GROUP BY r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis
    """
    cur.execute(sql_comp, tuple(cte_params + [id_ent, int(criticite_min)]))
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

    _augment_poste_records_with_matching_potential(cur, id_ent, id_service, int(criticite_min), records, today, today)

    records.sort(key=lambda r: (-int(r.get("indice_fragilite") or 0), int(r.get("nb_titulaires") or 0), -int(r.get("gap_titulaires") or 0), str(r.get("codif_poste") or ""), str(r.get("intitule_poste") or "")))
    return records

def _fetch_postes_fragility_records_projected(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    period_start: date,
    period_end: date,
    excluded_effectif_ids: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Projection période : même moteur que l'analyse actuelle, avec disponibilité projetée.
    Un collaborateur est retiré s'il a une indisponibilité qui chevauche la période
    ou une date de sortie prévue avant la fin de période.
    """
    if period_start > period_end:
        period_start, period_end = period_end, period_start
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    excluded_ids = sorted({str(x or "").strip() for x in (excluded_effectif_ids or []) if str(x or "").strip()})
    excluded_filter_sql = ""
    excluded_filter_params: List[Any] = []
    if excluded_ids:
        excluded_filter_sql = "AND NOT (e.id_effectif::text = ANY(%s::text[]))"
        excluded_filter_params.append(excluded_ids)

    sql_postes = f"""
    WITH
    {cte_sql},
    titulaires_rattaches AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires_rattaches
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE AND COALESCE(e.id_poste_actuel, '') <> ''
          {excluded_filter_sql}
        GROUP BY e.id_poste_actuel
    ),
    titulaires_dispo AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE AND COALESCE(e.id_poste_actuel, '') <> ''
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (SELECT 1 FROM public.tbl_effectif_client_break b WHERE b.id_effectif = e.id_effectif AND COALESCE(b.archive, FALSE) = FALSE AND b.date_debut <= %s AND b.date_fin >= %s)
          {excluded_filter_sql}
        GROUP BY e.id_poste_actuel
    ),
    titulaires_indispo AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_indisponibles
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE AND COALESCE(e.id_poste_actuel, '') <> ''
          AND EXISTS (SELECT 1 FROM public.tbl_effectif_client_break b WHERE b.id_effectif = e.id_effectif AND COALESCE(b.archive, FALSE) = FALSE AND b.date_debut <= %s AND b.date_fin >= %s)
          {excluded_filter_sql}
        GROUP BY e.id_poste_actuel
    ),
    titulaires_sorties AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_sorties_approchantes
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE AND COALESCE(e.id_poste_actuel, '') <> ''
          AND e.date_sortie_prevue IS NOT NULL AND e.date_sortie_prevue >= %s AND e.date_sortie_prevue <= %s
          {excluded_filter_sql}
        GROUP BY e.id_poste_actuel
    )
    SELECT fp.id_poste, fp.codif_poste, fp.codif_client, fp.intitule_poste, fp.id_service, COALESCE(o.nom_service, '') AS nom_service,
           COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible, COALESCE(prh.statut_poste, 'actif')::text AS statut_poste,
           CASE WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$' THEN trim(fp.niveau_education_minimum)::int ELSE 0 END AS edu_min_rank,
           (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required,
           COALESCE(nd.titre, '')::text AS nsf_domaine_titre,
           COALESCE(td.nb_titulaires, 0)::int AS nb_titulaires,
           COALESCE(tr.nb_titulaires_rattaches, 0)::int AS nb_titulaires_rattaches,
           COALESCE(ti.nb_indisponibles, 0)::int AS nb_indisponibles,
           COALESCE(ts.nb_sorties_approchantes, 0)::int AS nb_sorties_approchantes
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
    LEFT JOIN public.tbl_entreprise_organigramme o ON o.id_ent = %s AND o.id_service = fp.id_service AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    LEFT JOIN titulaires_dispo td ON td.id_poste = fp.id_poste
    LEFT JOIN titulaires_rattaches tr ON tr.id_poste = fp.id_poste
    LEFT JOIN titulaires_indispo ti ON ti.id_poste = fp.id_poste
    LEFT JOIN titulaires_sorties ts ON ts.id_poste = fp.id_poste
    """
    sql_postes_params = (
        list(cte_params)
        + [id_ent]
        + excluded_filter_params
        + [id_ent, period_end, period_end, period_start]
        + excluded_filter_params
        + [id_ent, period_end, period_start]
        + excluded_filter_params
        + [id_ent, period_start, period_end]
        + excluded_filter_params
        + [id_ent]
    )
    if sql_postes.count("%s") != len(sql_postes_params):
        raise RuntimeError(
            f"Paramètres SQL incohérents pour la projection postes : "
            f"{sql_postes.count('%s')} placeholders / {len(sql_postes_params)} paramètres"
        )
    cur.execute(sql_postes, tuple(sql_postes_params))
    poste_rows = cur.fetchall() or []
    if not poste_rows:
        return []
    postes_map = {str(r.get("id_poste") or ""): dict(r) for r in poste_rows}

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT e.id_effectif, e.id_poste_actuel, COALESCE(e.niveau_education, '') AS niveau_education, COALESCE(e.domaine_education, '') AS domaine_education
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (SELECT 1 FROM public.tbl_effectif_client_break b WHERE b.id_effectif = e.id_effectif AND COALESCE(b.archive, FALSE) = FALSE AND b.date_debut <= %s AND b.date_fin >= %s)
          {excluded_filter_sql}
        """,
        tuple(cte_params + [id_ent, period_end, period_end, period_start] + excluded_filter_params),
    )
    employees = [dict(r) for r in (cur.fetchall() or [])]

    sql_comp = f"""
    WITH
    {cte_sql},
    effectifs_dispo AS (
        SELECT es.id_effectif
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE e.id_ent = %s AND COALESCE(e.archive, FALSE) = FALSE AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > %s)
          AND NOT EXISTS (SELECT 1 FROM public.tbl_effectif_client_break b WHERE b.id_effectif = e.id_effectif AND COALESCE(b.archive, FALSE) = FALSE AND b.date_debut <= %s AND b.date_fin >= %s)
          {excluded_filter_sql}
    ),
    poste_info AS (
        SELECT fp.id_poste, CASE WHEN trim(COALESCE(fp.niveau_education_minimum, '')) ~ '^[0-9]+$' THEN trim(fp.niveau_education_minimum)::int ELSE 0 END AS edu_min_rank,
               (COALESCE(fp.nsf_domaine_obligatoire, FALSE) OR COALESCE(fp.nsf_groupe_obligatoire, FALSE)) AS nsf_domain_required, COALESCE(nd.titre, '')::text AS nsf_domaine_titre
        FROM postes_scope ps JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste LEFT JOIN public.tbl_nsf_domaine nd ON nd.code = fp.nsf_domaine_code
    ),
    req AS (
        SELECT DISTINCT pi.id_poste, c.id_comp, c.code, c.intitule, COALESCE(fpc.niveau_requis, '')::text AS niveau_requis, COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite,
               pi.edu_min_rank, pi.nsf_domain_required, pi.nsf_domaine_titre
        FROM poste_info pi JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = pi.id_poste JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE c.etat = 'active' AND COALESCE(c.masque, FALSE) = FALSE AND COALESCE(fpc.masque, FALSE) = FALSE AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    pool_all_effectifs AS (
        SELECT e.id_effectif, e.id_poste_actuel, COALESCE(e.niveau_education, '') AS niveau_education, COALESCE(e.domaine_education, '') AS domaine_education
        FROM public.tbl_effectif_client e JOIN effectifs_dispo ed ON ed.id_effectif = e.id_effectif WHERE COALESCE(e.archive, FALSE) = FALSE
    ),
    ec_raw AS (
        SELECT r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis, pe.id_effectif, pe.id_poste_actuel,
               CASE upper(trim(COALESCE(r.niveau_requis, ''))) WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 0 END AS req_rank,
               CASE lower(trim(COALESCE(ec.niveau_actuel, ''))) WHEN 'a' THEN 1 WHEN 'initial' THEN 1 WHEN 'b' THEN 2 WHEN 'intermediaire' THEN 2 WHEN 'intermédiaire' THEN 2 WHEN 'c' THEN 3 WHEN 'avance' THEN 3 WHEN 'avancé' THEN 3 WHEN 'avancee' THEN 3 WHEN 'avancée' THEN 3 WHEN 'd' THEN 4 WHEN 'expert' THEN 4 ELSE 0 END AS act_rank,
               CASE WHEN a.resultat_eval IS NOT NULL AND (a.date_audit IS NOT NULL OR ec.date_derniere_eval IS NOT NULL OR a.id_audit_competence IS NOT NULL) THEN TRUE ELSE FALSE END AS is_evaluee,
               CASE WHEN (r.edu_min_rank = 0 OR (CASE WHEN trim(COALESCE(pe.niveau_education, '')) ~ '^[0-9]+$' THEN trim(pe.niveau_education)::int ELSE 0 END) >= r.edu_min_rank)
                    AND (r.nsf_domain_required = FALSE OR (lower(trim(COALESCE(pe.domaine_education, ''))) = lower(trim(COALESCE(r.nsf_domaine_titre, ''))) AND COALESCE(r.nsf_domaine_titre, '') <> '')) THEN TRUE ELSE FALSE END AS is_eligible
        FROM req r JOIN public.tbl_effectif_client_competence ec ON ec.id_comp = r.id_comp
        LEFT JOIN public.tbl_effectif_client_audit_competence a ON a.id_audit_competence = ec.id_dernier_audit AND a.id_effectif_competence = ec.id_effectif_competence
        JOIN pool_all_effectifs pe ON pe.id_effectif = ec.id_effectif_client
        WHERE COALESCE(ec.actif, TRUE) = TRUE AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    ec_ok AS (SELECT *, CASE WHEN req_rank > 0 THEN (is_evaluee AND act_rank >= req_rank) ELSE (is_evaluee AND act_rank > 0) END AS is_ok FROM ec_raw)
    SELECT r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis,
           COUNT(DISTINCT CASE WHEN eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_any,
           COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible AND eok.id_poste_actuel = r.id_poste THEN eok.id_effectif END)::int AS nb_tit_ok,
           COUNT(DISTINCT CASE WHEN eok.is_ok AND eok.is_eligible THEN eok.id_effectif END)::int AS nb_ok_all
    FROM req r LEFT JOIN ec_ok eok ON eok.id_poste = r.id_poste AND eok.id_comp = r.id_comp
    GROUP BY r.id_poste, r.id_comp, r.code, r.intitule, r.poids_criticite, r.niveau_requis
    """
    sql_comp_params = list(cte_params) + [id_ent, period_end, period_end, period_start] + excluded_filter_params + [int(criticite_min)]
    if sql_comp.count("%s") != len(sql_comp_params):
        raise RuntimeError(
            f"Paramètres SQL incohérents pour les compétences projetées par poste : "
            f"{sql_comp.count('%s')} placeholders / {len(sql_comp_params)} paramètres"
        )
    cur.execute(sql_comp, tuple(sql_comp_params))
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

    _augment_poste_records_with_matching_potential(
        cur,
        id_ent,
        id_service,
        int(criticite_min),
        records,
        period_start,
        period_end,
        excluded_effectif_ids=excluded_effectif_ids,
    )
    records.sort(key=lambda r: (-int(r.get("indice_fragilite") or 0), int(r.get("nb_titulaires") or 0), -int(r.get("gap_titulaires") or 0), str(r.get("codif_poste") or ""), str(r.get("intitule_poste") or "")))
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
            "code": "MAITRISE_INSUFFISANTE",
            "titre": "Maîtrise insuffisante de la compétence",
            "niveau": "Cause principale",
            "severity": "main",
            "count": int(counts.get("NIVEAU_INSUFFISANT", 0) or counts.get("COUVERTURE_ABSENTE", 0) or counts.get("AUCUN_TITULAIRE", 0) or 0),
            "lecture": "La compétence n’est pas maîtrisée au niveau attendu sur une partie du périmètre.",
            "action": "Identifier les écarts et cibler les montées en compétence.",
            "items": [],
        },
        {
            "code": "CONCENTRATION",
            "titre": "Concentration sur trop peu de personnes",
            "niveau": "Cause principale",
            "severity": "main",
            "count": int(counts.get("DEPENDANCE", 0) or 0),
            "lecture": "La compétence repose sur un nombre trop limité de porteurs confirmés.",
            "action": "Élargir le nombre de porteurs ou préparer des relais.",
            "items": [],
        },
        {
            "code": "TRANSMISSION_INSUFFISANTE",
            "titre": "Capacité de transmission insuffisante",
            "niveau": "Facteur aggravant",
            "severity": "secondary",
            "count": 0,
            "lecture": "Le nombre de porteurs experts capables de transmettre la compétence doit être vérifié.",
            "action": "Identifier les transmetteurs possibles.",
            "items": [],
        },
        {
            "code": "DONNEES_A_VERIFIER",
            "titre": "Données à vérifier",
            "niveau": "Donnée à vérifier",
            "severity": "data",
            "count": int(counts.get("COUVERTURE_NON_CONFIRMEE", 0) or 0),
            "lecture": "Certaines données doivent être confirmées pour fiabiliser l’analyse.",
            "action": "Compléter ou confirmer les évaluations.",
            "items": [],
        },
    ]

def _competence_state_label_from_score(score: Any) -> str:
    s = _clamp_int(int(score or 0), 0, 100)
    if s >= 75:
        return "Critique"
    if s >= 50:
        return "Élevé"
    if s >= 25:
        return "Modéré"
    return "Faible"

def _competence_event_label(row: Dict[str, Any]) -> str:
    if row.get("date_sortie_prevue"):
        return "Sortie prévue"
    if row.get("date_fin_indispo") or row.get("date_debut_indispo"):
        return "Indisponibilité"
    return "Événement"

def _competence_person_label(row: Dict[str, Any]) -> str:
    full = f"{str(row.get('prenom_effectif') or '').strip()} {str(row.get('nom_effectif') or '').strip()}".strip()
    return full or "Collaborateur"

def _fetch_competence_fragility_records_centered(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    period_start: date,
    period_end: date,
    comp_id: Optional[str] = None,
    limit: int = 200,
    excluded_effectif_ids: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Moteur centré compétence.

    La compétence est analysée comme un capital interne :
    - est-elle suffisamment maîtrisée ?
    - repose-t-elle sur trop peu de personnes ?
    - peut-elle être transmise ?
    - des porteurs vont-ils sortir ou devenir indisponibles ?
    - les données sont-elles assez fiables ?
    """
    if period_start > period_end:
        period_start, period_end = period_end, period_start

    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    comp_filter_sql = ""
    comp_filter_params: List[Any] = []
    if comp_id:
        comp_filter_sql = "AND c.id_comp = %s"
        comp_filter_params.append(comp_id)

    excluded_ids = sorted({str(x or "").strip() for x in (excluded_effectif_ids or []) if str(x or "").strip()})
    excluded_filter_sql = ""
    excluded_filter_params: List[Any] = []
    if excluded_ids:
        excluded_filter_sql = "AND NOT (e.id_effectif::text = ANY(%s::text[]))"
        excluded_filter_params.append(excluded_ids)

    req_sql = f"""
    WITH
    {cte_sql},
    titulaires_count AS (
        SELECT e.id_poste_actuel AS id_poste, COUNT(DISTINCT e.id_effectif)::int AS nb_titulaires
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(e.id_poste_actuel, '') <> ''
        GROUP BY e.id_poste_actuel
    )
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
        CASE
            WHEN prh.nb_titulaires_cible IS NOT NULL AND prh.nb_titulaires_cible::int > 0 THEN prh.nb_titulaires_cible::int
            WHEN COALESCE(tc.nb_titulaires, 0)::int > 0 THEN COALESCE(tc.nb_titulaires, 0)::int
            ELSE 1
        END AS besoin_poste
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
    JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = fp.id_poste
    JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
    LEFT JOIN public.tbl_entreprise_organigramme o
      ON o.id_ent = fp.id_ent AND o.id_service = fp.id_service AND COALESCE(o.archive, FALSE) = FALSE
    LEFT JOIN public.tbl_domaine_competence d
      ON d.id_domaine_competence = c.domaine AND COALESCE(d.masque, FALSE) = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    LEFT JOIN titulaires_count tc ON tc.id_poste = fp.id_poste
    WHERE fp.id_ent = %s
      AND COALESCE(fp.actif, TRUE) = TRUE
      AND c.etat = 'active'
      AND COALESCE(c.masque, FALSE) = FALSE
      AND COALESCE(fpc.masque, FALSE) = FALSE
      AND COALESCE(fpc.poids_criticite, 0)::int >= %s
      {comp_filter_sql}
    ORDER BY c.code, COALESCE(fpc.poids_criticite,0)::int DESC, fp.codif_poste
    """
    cur.execute(req_sql, tuple(cte_params + [id_ent, id_ent, int(criticite_min)] + comp_filter_params))
    req_rows = [dict(r) for r in (cur.fetchall() or [])]
    if not req_rows:
        return []

    comp_ids = sorted({str(r.get("id_comp") or "").strip() for r in req_rows if str(r.get("id_comp") or "").strip()})
    if not comp_ids:
        return []

    cur.execute(
        f"""
        WITH {cte_sql}
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_service,
            COALESCE(o.nom_service, '') AS nom_service,
            e.id_poste_actuel,
            COALESCE(p.codif_poste, '') AS codif_poste,
            COALESCE(p.codif_client, '') AS codif_client,
            COALESCE(p.intitule_poste, '') AS intitule_poste,
            e.date_sortie_prevue,
            ec.id_comp,
            ec.id_effectif_competence,
            ec.niveau_actuel,
            ec.date_derniere_eval,
            a.id_audit_competence,
            a.date_audit,
            a.resultat_eval,
            br.date_debut_indispo,
            br.date_fin_indispo
        FROM effectifs_scope es
        JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
        JOIN public.tbl_effectif_client_competence ec ON ec.id_effectif_client = e.id_effectif
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
        LEFT JOIN public.tbl_entreprise_organigramme o
          ON o.id_ent = e.id_ent AND o.id_service = e.id_service AND COALESCE(o.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste p ON p.id_poste = e.id_poste_actuel
        LEFT JOIN (
            SELECT id_effectif, MIN(date_debut) AS date_debut_indispo, MAX(date_fin) AS date_fin_indispo
            FROM public.tbl_effectif_client_break
            WHERE COALESCE(archive, FALSE) = FALSE
              AND date_debut <= %s
              AND date_fin >= %s
            GROUP BY id_effectif
        ) br ON br.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          {excluded_filter_sql}
          AND COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND ec.id_comp = ANY(%s)
        ORDER BY e.nom_effectif, e.prenom_effectif
        """,
        tuple(cte_params + [period_end, period_start, id_ent] + excluded_filter_params + [comp_ids]),
    )
    carrier_rows = [dict(r) for r in (cur.fetchall() or [])]

    def is_evaluated(row: Dict[str, Any]) -> bool:
        return bool(row.get("resultat_eval") is not None or row.get("date_audit") or row.get("date_derniere_eval") or row.get("id_audit_competence"))

    def carrier_rank(row: Dict[str, Any]) -> int:
        rank = _niveau_rank(row.get("niveau_actuel"))
        if rank > 0:
            return rank
        return _niveau_rank(_niveau_from_score(_safe_float(row.get("resultat_eval"))))

    def has_event(row: Dict[str, Any]) -> bool:
        if row.get("date_debut_indispo") or row.get("date_fin_indispo"):
            return True
        ds = row.get("date_sortie_prevue")
        return bool(ds and ds >= period_start and ds <= period_end)

    def is_available(row: Dict[str, Any]) -> bool:
        ds = row.get("date_sortie_prevue")
        if ds and ds <= period_end:
            return False
        if row.get("date_debut_indispo") or row.get("date_fin_indispo"):
            return False
        return True

    by_comp_req: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in req_rows:
        by_comp_req[str(r.get("id_comp") or "").strip()].append(r)

    by_comp_carriers: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in carrier_rows:
        cid = str(row.get("id_comp") or "").strip()
        if cid:
            row["full"] = _competence_person_label(row)
            row["niveau_rank"] = carrier_rank(row)
            row["is_evaluee"] = is_evaluated(row)
            row["is_available"] = is_available(row)
            row["has_event"] = has_event(row)
            row["event_label"] = _competence_event_label(row)
            by_comp_carriers[cid].append(row)

    records: List[Dict[str, Any]] = []
    for cid, reqs in by_comp_req.items():
        first = reqs[0]
        carriers = by_comp_carriers.get(cid) or []
        need_total = sum(max(_safe_int(r.get("besoin_poste"), 1), 1) for r in reqs)
        weighted_need = sum(max(_safe_int(r.get("besoin_poste"), 1), 1) * max(_safe_int(r.get("poids_criticite"), 1), 1) for r in reqs) or 1
        criticite_max = max([_safe_int(r.get("poids_criticite"), 0) for r in reqs] or [0])
        nb_postes_crit_80 = sum(1 for r in reqs if _safe_int(r.get("poids_criticite"), 0) >= 80)

        available_eval = [c for c in carriers if c.get("is_available") and c.get("is_evaluee") and _safe_int(c.get("niveau_rank"), 0) > 0]
        available_declared = [c for c in carriers if c.get("is_available")]
        non_eval_available = [c for c in available_declared if not c.get("is_evaluee")]
        events = [c for c in carriers if c.get("has_event")]
        experts = [c for c in available_eval if _safe_int(c.get("niveau_rank"), 0) >= 4]
        advanced_or_more = [c for c in available_eval if _safe_int(c.get("niveau_rank"), 0) >= 3]

        mastery_rows: List[Dict[str, Any]] = []
        weighted_gap = 0
        gap_units_total = 0
        for r in reqs:
            req_rank = _niveau_rank(r.get("niveau_requis"))
            need = max(_safe_int(r.get("besoin_poste"), 1), 1)
            poids = max(_safe_int(r.get("poids_criticite"), 1), 1)
            ok = sum(1 for c in available_eval if _safe_int(c.get("niveau_rank"), 0) >= req_rank) if req_rank > 0 else 0
            gap = max(need - ok, 0)
            if gap > 0:
                weighted_gap += gap * poids
                gap_units_total += gap
                code_poste = (str(r.get("codif_client") or "").strip() or str(r.get("codif_poste") or "").strip() or "—")
                mastery_rows.append({
                    "poste": code_poste,
                    "intitule_poste": r.get("intitule_poste") or "Poste",
                    "niveau_requis": r.get("niveau_requis") or "—",
                    "besoin": need,
                    "porteurs_niveau_requis": ok,
                    "ecart": gap,
                    "criticite": poids,
                })

        score_maitrise = min(45, int(round(45.0 * (weighted_gap / float(weighted_need))))) if weighted_gap > 0 else 0

        valid_count = len({str(c.get("id_effectif") or "") for c in available_eval})
        declared_count = len({str(c.get("id_effectif") or "") for c in carriers})
        available_declared_count = len({str(c.get("id_effectif") or "") for c in available_declared})
        if declared_count <= 0:
            score_concentration = 25
        elif valid_count <= 0:
            score_concentration = 22
        elif valid_count == 1:
            score_concentration = 18
        elif valid_count < max(3, int(round(need_total / 2.0))):
            score_concentration = 10
        else:
            score_concentration = 0

        if len(experts) <= 0:
            score_transmission = 20
        elif len(experts) == 1:
            score_transmission = 10
        else:
            score_transmission = 0

        if events:
            denom = max(1, declared_count)
            score_events = max(6, min(15, int(round(15.0 * (len({str(e.get('id_effectif') or '') for e in events}) / float(denom))))))
        else:
            score_events = 0

        data_points = 0
        data_items: List[Dict[str, Any]] = []
        if non_eval_available:
            data_points += 1
            data_items.append({"label": "Porteurs à confirmer", "value": len(non_eval_available)})
        if any(_niveau_rank(r.get("niveau_requis")) <= 0 for r in reqs):
            data_points += 1
            data_items.append({"label": "Niveaux requis incomplets", "value": sum(1 for r in reqs if _niveau_rank(r.get("niveau_requis")) <= 0)})
        score_data = 8 if data_points > 0 else 0

        if need_total > 0 and declared_count <= 0:
            indice = 100
        else:
            indice = min(100, score_maitrise + score_concentration + score_transmission + score_events + score_data)

        causes: List[Dict[str, Any]] = []
        if score_maitrise > 0:
            causes.append({
                "code": "MAITRISE_INSUFFISANTE",
                "titre": "Maîtrise insuffisante de la compétence",
                "niveau": "Cause principale",
                "severity": "main",
                "count": len(mastery_rows),
                "lecture": "La compétence existe peut-être dans l’entreprise, mais elle n’est pas maîtrisée au niveau attendu sur tous les usages retenus.",
                "action": "Identifier les écarts de niveau et cibler les montées en compétence prioritaires.",
                "items": mastery_rows[:12],
            })
        if score_concentration > 0:
            causes.append({
                "code": "CONCENTRATION",
                "titre": "Concentration sur trop peu de personnes",
                "niveau": "Cause principale" if valid_count <= 1 else "Facteur aggravant",
                "severity": "main" if valid_count <= 1 else "secondary",
                "count": valid_count,
                "lecture": "La compétence repose sur un nombre limité de porteurs confirmés. Une absence ou un départ peut donc dégrader rapidement la couverture.",
                "action": "Élargir le nombre de porteurs confirmés ou préparer des relais internes.",
                "items": [{
                    "label": "Porteurs confirmés disponibles",
                    "value": valid_count,
                    "besoin": need_total,
                    "porteurs_declares": declared_count,
                }],
            })
        if score_transmission > 0:
            causes.append({
                "code": "TRANSMISSION_INSUFFISANTE",
                "titre": "Capacité de transmission insuffisante",
                "niveau": "Cause principale" if len(experts) == 0 else "Facteur aggravant",
                "severity": "main" if len(experts) == 0 else "secondary",
                "count": len(experts),
                "lecture": "La compétence manque de porteurs au niveau expert capables de transmettre le savoir-faire dans de bonnes conditions.",
                "action": "Identifier un transmetteur, confirmer les experts ou organiser la montée d’un porteur avancé.",
                "items": [{
                    "label": "Experts disponibles",
                    "value": len(experts),
                    "avances_ou_experts": len(advanced_or_more),
                }],
            })
        if score_events > 0:
            causes.append({
                "code": "EXPOSITION_SORTIES_INDISPOS",
                "titre": "Exposition à des sorties ou indisponibilités",
                "niveau": "Facteur aggravant",
                "severity": "secondary",
                "count": len(events),
                "lecture": "Des porteurs de cette compétence ont un événement connu sur la période analysée. La couverture peut donc baisser temporairement ou durablement.",
                "action": "Vérifier l’impact de ces événements et préparer un relais si nécessaire.",
                "items": [{
                    "collaborateur": _competence_person_label(e),
                    "poste": e.get("intitule_poste") or "—",
                    "evenement": e.get("event_label") or "Événement",
                    "debut": _analyse_date_fr_value(e.get("date_debut_indispo")),
                    "fin": _analyse_date_fr_value(e.get("date_fin_indispo") or e.get("date_sortie_prevue")),
                } for e in events[:12]],
            })
        if score_data > 0:
            causes.append({
                "code": "DONNEES_A_VERIFIER",
                "titre": "Données à vérifier",
                "niveau": "Donnée à vérifier",
                "severity": "data",
                "count": data_points,
                "lecture": "Certaines données limitent la fiabilité de l’analyse. Le score doit être lu avec prudence tant que ces éléments ne sont pas confirmés.",
                "action": "Compléter ou confirmer les informations manquantes avant de décider une action.",
                "items": data_items,
            })
        if not causes:
            causes.append({
                "code": "SECURISEE",
                "titre": "Compétence sécurisée sur le périmètre",
                "niveau": "Information",
                "severity": "ok",
                "count": 0,
                "lecture": "Aucune cause majeure de fragilité n’est détectée sur cette compétence avec le périmètre et le seuil retenus.",
                "action": "Surveiller l’évolution dans le temps.",
                "items": [],
            })

        rec = {
            "id_comp": first.get("id_comp"),
            "code": first.get("code"),
            "intitule": first.get("intitule"),
            "description": first.get("description"),
            "id_domaine_competence": first.get("id_domaine_competence"),
            "domaine_titre": first.get("domaine_titre"),
            "domaine_titre_court": first.get("domaine_titre_court"),
            "domaine_couleur": first.get("domaine_couleur"),
            "nb_postes_impactes": len(reqs),
            "besoin_total": need_total,
            "nb_porteurs": valid_count,
            "nb_porteurs_dispo": valid_count,
            "nb_porteurs_declares": declared_count,
            "nb_porteurs_evalues": len({str(c.get("id_effectif") or "") for c in carriers if c.get("is_evaluee")}),
            "nb_porteurs_valides": valid_count,
            "nb_experts": len(experts),
            "nb_experts_dispo": len(experts),
            "nb_porteurs_avances_ou_experts": len(advanced_or_more),
            "nb_evenements": len(events),
            "criticite_max": criticite_max,
            "max_criticite": criticite_max,
            "nb_postes_crit_80": nb_postes_crit_80,
            "indice_fragilite": int(indice),
            "priorite": _competence_priorite_from_score(int(indice)),
            "priorite_score": int(indice),
            "etat": _competence_state_label_from_score(int(indice)),
            "score_maitrise": score_maitrise,
            "score_concentration": score_concentration,
            "score_transmission": score_transmission,
            "score_evenements": score_events,
            "score_donnees": score_data,
            "nb_postes_couverture_absente": gap_units_total,
            "nb_postes_non_confirmee": data_points,
            "nb_postes_niveau_insuffisant": len(mastery_rows),
            "nb_postes_dependance": 1 if score_concentration > 0 else 0,
            "nb_postes_valides": max(0, len(reqs) - len(mastery_rows)),
            "causes": causes,
            "postes": [{
                "id_poste": r.get("id_poste"),
                "codif_poste": r.get("codif_poste"),
                "codif_client": r.get("codif_client"),
                "intitule_poste": r.get("intitule_poste"),
                "nom_service": r.get("nom_service"),
                "niveau_requis": r.get("niveau_requis"),
                "poids_criticite": r.get("poids_criticite"),
                "besoin_poste": r.get("besoin_poste"),
            } for r in reqs],
        }
        records.append(rec)

    records.sort(key=lambda r: (-(r.get("indice_fragilite") or 0), -(r.get("criticite_max") or 0), str(r.get("code") or "")))
    return records[:max(1, int(limit or 200))]

def _fetch_competence_fragility_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    comp_id: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    today = date.today()
    return _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        id_service,
        criticite_min,
        today,
        today,
        comp_id=comp_id,
        limit=limit,
    )

def _fetch_competence_fragility_records_projected(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    period_start: date,
    period_end: date,
    comp_id: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    return _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        id_service,
        criticite_min,
        period_start,
        period_end,
        comp_id=comp_id,
        limit=limit,
    )

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

def _analyse_fragility_records_analyzed(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Retourne uniquement les lignes réellement analysées.

    Un élément à 0 % reste analysé et doit entrer dans la moyenne.
    Un élément marqué is_non_analyse représente une absence de donnée exploitable
    et ne doit pas abaisser artificiellement l'indice moyen.
    """
    out: List[Dict[str, Any]] = []
    for r in records or []:
        if bool(r.get("is_non_analyse") or False):
            continue
        out.append(r)
    return out

def _analyse_fragility_average(records: List[Dict[str, Any]]) -> int:
    analysed = _analyse_fragility_records_analyzed(records)
    if not analysed:
        return 0
    return int(round(sum(_safe_int(r.get("indice_fragilite")) for r in analysed) / float(len(analysed))))

def _analyse_fragility_average_float(records: List[Dict[str, Any]]) -> float:
    analysed = _analyse_fragility_records_analyzed(records)
    if not analysed:
        return 0.0
    return sum(_safe_int(r.get("indice_fragilite"), 0) for r in analysed) / float(len(analysed))

def _analyse_prevision_delta_between_record_sets(
    current_records: List[Dict[str, Any]],
    future_records: List[Dict[str, Any]],
    key_field: Optional[str] = None,
) -> int:
    """
    Évolution globale du périmètre.

    Lecture KPI : somme des hausses positives constatées, ramenée au nombre total
    d'éléments analysés du périmètre. Les baisses éventuelles ne masquent pas les
    hausses causées par les sortants N+X.
    """
    current_analysed = _analyse_fragility_records_analyzed(current_records)
    if not current_analysed:
        return 0

    total = float(len(current_analysed))

    if key_field:
        future_by_key = {
            str(r.get(key_field) or "").strip(): r
            for r in _analyse_fragility_records_analyzed(future_records)
            if str(r.get(key_field) or "").strip()
        }
        total_delta = 0
        for cur_rec in current_analysed:
            key = str(cur_rec.get(key_field) or "").strip()
            fut_rec = future_by_key.get(key)
            if not fut_rec:
                continue
            now_score = _safe_int(cur_rec.get("indice_fragilite"), 0)
            future_score = _safe_int(fut_rec.get("indice_fragilite"), 0)
            total_delta += max(0, future_score - now_score)
        return max(0, _clamp_int(round(total_delta / total), 0, 100))

    now_avg = _analyse_fragility_average_float(current_records)
    future_avg = _analyse_fragility_average_float(future_records)
    return max(0, _clamp_int(round(future_avg - now_avg), 0, 100))

def _analyse_prevision_leaving_effectif_ids(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
) -> List[str]:
    rows = _fetch_prevision_poste_leaving_rows(cur, id_ent, id_service, horizon_years)
    return sorted({str(r.get("id_effectif") or "").strip() for r in rows if str(r.get("id_effectif") or "").strip()})

def _analyse_prevision_competence_global_delta(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
) -> int:
    """
    KPI Prévisions compétences : évolution moyenne ramenée à toutes les compétences analysées.
    Le détail reste porté par _fetch_prevision_competence_impacts().
    """
    scope_id = (id_service or "").strip() or None
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    leaving_ids = _analyse_prevision_leaving_effectif_ids(cur, id_ent, scope_id, horizon_years)
    if not leaving_ids:
        return 0

    today = date.today()
    current_records = _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        comp_id=None,
        limit=10000,
    )
    future_records = _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        comp_id=None,
        limit=10000,
        excluded_effectif_ids=leaving_ids,
    )
    return _analyse_prevision_delta_between_record_sets(current_records, future_records, "id_comp")

def _analyse_prevision_poste_global_delta(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
) -> int:
    """
    Indice de dégradation postes à horizon N+X.

    Ce n'est pas une moyenne projetée : on additionne uniquement les hausses
    positives poste par poste, puis on les ramène au nombre de postes analysés.
    Les baisses ne compensent pas les hausses, afin de ne pas masquer les
    postes qui se dégradent réellement.
    """
    summary = _analyse_prevision_poste_projection_summary(
        cur,
        id_ent,
        id_service,
        horizon_years,
        criticite_min,
    )
    return int(summary.get("postes_degradation_index") or 0)


def _analyse_prevision_poste_projection_summary(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
) -> Dict[str, Any]:
    """
    Synthèse lisible de la projection postes.

    - fragilité actuelle moyenne : moyenne réelle des postes analysés ;
    - fragilité projetée moyenne : même moteur rejoué en retirant les sortants N+X ;
    - delta moyen : différence future - actuelle, en points ;
    - indice de dégradation : ancien KPI conservé pour la priorisation, basé
      uniquement sur les hausses positives poste par poste.
    """
    scope_id = (id_service or "").strip() or None
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    h = max(1, min(5, int(horizon_years or 1)))

    current_records = _fetch_postes_fragility_records(cur, id_ent, scope_id, cmin)
    current_analysed = _analyse_fragility_records_analyzed(current_records)
    current_avg = _analyse_fragility_average(current_records)
    current_count = len(current_analysed)

    leaving_ids = _analyse_prevision_leaving_effectif_ids(cur, id_ent, scope_id, h)
    if leaving_ids:
        today = date.today()
        period_end = date(today.year + h, 12, 31)
        future_records = _fetch_postes_fragility_records_projected(
            cur,
            id_ent,
            scope_id,
            cmin,
            today,
            period_end,
            excluded_effectif_ids=leaving_ids,
        )
    else:
        future_records = list(current_records or [])

    future_analysed = _analyse_fragility_records_analyzed(future_records)
    future_avg = _analyse_fragility_average(future_records)
    future_count = len(future_analysed)

    degradation_index = _analyse_prevision_delta_between_record_sets(current_records, future_records, "id_poste")

    future_by_poste = {
        str(r.get("id_poste") or "").strip(): r
        for r in future_analysed
        if str(r.get("id_poste") or "").strip()
    }
    postes_aggraves = 0
    postes_stables = 0
    postes_ameliores = 0
    for rec in current_analysed:
        pid = str(rec.get("id_poste") or "").strip()
        fut = future_by_poste.get(pid)
        if not fut:
            continue
        now_score = _safe_int(rec.get("indice_fragilite"), 0)
        future_score = _safe_int(fut.get("indice_fragilite"), 0)
        if future_score > now_score:
            postes_aggraves += 1
        elif future_score < now_score:
            postes_ameliores += 1
        else:
            postes_stables += 1

    return {
        "postes_fragilite_now": int(current_avg),
        "postes_fragilite_horizon": int(future_avg),
        "postes_fragilite_delta": int(round(float(future_avg) - float(current_avg))),
        "postes_degradation_index": int(degradation_index),
        "postes_analyses_projection": int(current_count),
        "postes_analyses_horizon": int(future_count),
        "postes_aggraves": int(postes_aggraves),
        "postes_stables": int(postes_stables),
        "postes_ameliores": int(postes_ameliores),
    }


def _analyse_prevision_comp_fragility_index(B: int, P: int, Pd: int, Pe: int, Ped: int, N: int, Cmax: int, N80: int) -> int:
    """
    Indice de fragilité compétence, aligné avec la lecture des risques actuels.
    Utilisé ici uniquement pour mesurer la hausse générée par les sortants N+X.
    """
    def _clamp(v: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, v))

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

def _fetch_prevision_competence_impacts(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """
    Prévisions compétences = même moteur que Risques actuels, rejoué sans les sortants N+X.

    Principe:
    - fragilité actuelle : _fetch_competence_fragility_records()
    - fragilité future : même moteur, même périmètre, mêmes filtres, mais porteurs sortants exclus
    - hausse : fragilité future - fragilité actuelle

    On retient uniquement les compétences portées par au moins un sortant de la période
    et dont la fragilité augmente réellement.
    """
    scope_id = (id_service or "").strip() or None
    horizon = max(1, min(5, int(horizon_years or 1)))
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    lim = max(1, min(2000, int(limit or 200)))

    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)

    # 1) Sortants N+X dans le périmètre courant.
    leaving_sql = f"""
    WITH
    {cte_sql},
    effectifs_valid AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_poste_actuel,
            COALESCE(p.codif_client, p.codif_poste, '') AS codif_poste,
            COALESCE(p.intitule_poste, '') AS intitule_poste,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
            e.retraite_estimee::int AS retraite_annee,
            COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,
            COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        LEFT JOIN public.tbl_fiche_poste p ON p.id_poste = e.id_poste_actuel
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
    )
    SELECT *
    FROM effectifs_exit ee
    WHERE ee.exit_date IS NOT NULL
      AND ee.exit_date >= CURRENT_DATE
      AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
    ORDER BY ee.exit_date, ee.nom_effectif, ee.prenom_effectif
    """
    cur.execute(leaving_sql, tuple(cte_params + [id_ent, horizon]))
    leaving_rows = [dict(r) for r in (cur.fetchall() or [])]
    leaving_ids = sorted({str(r.get("id_effectif") or "").strip() for r in leaving_rows if str(r.get("id_effectif") or "").strip()})
    if not leaving_ids:
        return []

    # 2) Compétences du périmètre réellement portées par ces sortants.
    impacted_sql = f"""
    WITH
    {cte_sql},
    req_crit AS (
        SELECT DISTINCT
            c.id_comp
        FROM public.tbl_fiche_poste_competence fpc
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE c.etat = 'active'
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    leaving AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
            e.retraite_estimee::int AS retraite_annee,
            COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,
            COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND e.id_effectif::text = ANY(%s::text[])
    ),
    leaving_exit AS (
        SELECT
            l.*,
            CASE
                WHEN l.date_sortie_prevue IS NOT NULL THEN l.date_sortie_prevue
                WHEN l.retraite_annee IS NOT NULL THEN
                    (
                        make_date(l.retraite_annee, l.m_entree, 1)
                        + (
                            (
                                LEAST(
                                    l.d_entree,
                                    EXTRACT(
                                        DAY
                                        FROM (date_trunc('month', make_date(l.retraite_annee, l.m_entree, 1)) + interval '1 month - 1 day')
                                    )::int
                                ) - 1
                            )::text || ' days'
                        )::interval
                    )::date
                ELSE NULL
            END AS exit_date
        FROM leaving l
    ),
    leave_comp AS (
        SELECT
            ec.id_comp,
            COUNT(DISTINCT ec.id_effectif_client)::int AS nb_sortants_porteurs,
            MAX(le.exit_date) AS last_exit_date,
            STRING_AGG(DISTINCT TRIM(CONCAT(COALESCE(le.prenom_effectif, ''), ' ', COALESCE(le.nom_effectif, ''))), ', ') AS sortants_label
        FROM leaving_exit le
        JOIN public.tbl_effectif_client_competence ec ON ec.id_effectif_client = le.id_effectif
        JOIN req_crit rc ON rc.id_comp = ec.id_comp
        WHERE COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
        GROUP BY ec.id_comp
    )
    SELECT * FROM leave_comp
    """
    impacted_params = list(cte_params) + [cmin, id_ent, leaving_ids]
    missing_impacted_params = impacted_sql.count("%s") - len(impacted_params)
    if missing_impacted_params == 1:
        impacted_params.append(horizon)
    elif missing_impacted_params != 0:
        raise RuntimeError(
            f"Paramètres SQL incohérents pour les prévisions compétences : "
            f"{impacted_sql.count('%s')} placeholders / {len(impacted_params)} paramètres"
        )
    cur.execute(impacted_sql, tuple(impacted_params))
    impacted_rows = [dict(r) for r in (cur.fetchall() or [])]
    impacted_comp_ids = sorted({str(r.get("id_comp") or "").strip() for r in impacted_rows if str(r.get("id_comp") or "").strip()})
    if not impacted_comp_ids:
        return []

    impacted_meta = {str(r.get("id_comp") or "").strip(): r for r in impacted_rows}

    today = date.today()
    current_records = _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        comp_id=None,
        limit=10000,
    )
    future_records = _fetch_competence_fragility_records_centered(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        comp_id=None,
        limit=10000,
        excluded_effectif_ids=leaving_ids,
    )

    current_by_comp = {str(r.get("id_comp") or "").strip(): r for r in current_records if str(r.get("id_comp") or "").strip()}
    future_by_comp = {str(r.get("id_comp") or "").strip(): r for r in future_records if str(r.get("id_comp") or "").strip()}

    impacts: List[Dict[str, Any]] = []
    for cid in impacted_comp_ids:
        cur_rec = current_by_comp.get(cid)
        fut_rec = future_by_comp.get(cid)
        if not cur_rec or not fut_rec:
            continue

        indice_now = _clamp_int(int(cur_rec.get("indice_fragilite") or 0), 0, 100)
        indice_h = _clamp_int(int(fut_rec.get("indice_fragilite") or 0), 0, 100)
        delta = max(0, indice_h - indice_now)
        if delta <= 0:
            continue

        meta = impacted_meta.get(cid) or {}
        last_exit_date = meta.get("last_exit_date")
        if hasattr(last_exit_date, "isoformat"):
            last_exit_date = last_exit_date.isoformat()

        nb_now_declares = int(cur_rec.get("nb_porteurs_declares") or cur_rec.get("nb_porteurs_now") or cur_rec.get("nb_porteurs") or 0)
        nb_future_declares = int(fut_rec.get("nb_porteurs_declares") or fut_rec.get("nb_porteurs_now") or fut_rec.get("nb_porteurs") or 0)
        nb_lost = max(nb_now_declares - nb_future_declares, 0)
        if nb_lost <= 0:
            nb_lost = int(meta.get("nb_sortants_porteurs") or 0)

        impacts.append({
            "id_comp": cid,
            "code": cur_rec.get("code"),
            "intitule": cur_rec.get("intitule"),
            "id_domaine_competence": cur_rec.get("id_domaine_competence"),
            "domaine_titre_court": cur_rec.get("domaine_titre_court") or cur_rec.get("domaine_titre"),
            "domaine_couleur": cur_rec.get("domaine_couleur"),
            "nb_postes_impactes": int(cur_rec.get("nb_postes_impactes") or 0),
            "max_criticite": int(cur_rec.get("criticite_max") or cur_rec.get("max_criticite") or 0),
            "nb_porteurs_now": nb_now_declares,
            "nb_porteurs_sortants": nb_lost,
            "nb_porteurs_restants": max(nb_future_declares, 0),
            "last_exit_date": last_exit_date,
            "sortants_label": meta.get("sortants_label") or "",
            "indice_fragilite_now": indice_now,
            "indice_fragilite_horizon": indice_h,
            "delta_fragilite": int(delta),
            "priorite": "P1" if delta >= 25 else ("P2" if delta >= 10 else "P3"),
            "priorite_score": int(delta),
        })

    impacts.sort(key=lambda x: (-(int(x.get("delta_fragilite") or 0)), -(int(x.get("indice_fragilite_horizon") or 0)), -(int(x.get("nb_porteurs_sortants") or 0)), (x.get("code") or "")))
    return impacts[:lim]

def _analyse_prevision_competence_average_delta(items: List[Dict[str, Any]]) -> int:
    deltas = [int(x.get("delta_fragilite") or 0) for x in (items or []) if int(x.get("delta_fragilite") or 0) > 0]
    if not deltas:
        return 0
    return int(round(sum(deltas) / float(len(deltas))))

def _fetch_prevision_poste_leaving_rows(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
) -> List[Dict[str, Any]]:
    """Sortants N+X du périmètre, avec date de sortie réelle ou retraite estimée."""
    scope_id = (id_service or "").strip() or None
    horizon = max(1, min(5, int(horizon_years or 1)))
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)
    sql = f"""
    WITH
    {cte_sql},
    effectifs_valid AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_poste_actuel,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
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
                WHEN ev.retraite_annee IS NOT NULL THEN
                    (
                        make_date(ev.retraite_annee, ev.m_entree, 1)
                        + (((LEAST(
                                ev.d_entree,
                                EXTRACT(DAY FROM (date_trunc('month', make_date(ev.retraite_annee, ev.m_entree, 1)) + interval '1 month - 1 day'))::int
                            ) - 1)::text || ' days')::interval)
                    )::date
                ELSE NULL
            END AS exit_date
        FROM effectifs_valid ev
    )
    SELECT *
    FROM effectifs_exit ee
    WHERE ee.exit_date IS NOT NULL
      AND ee.exit_date >= CURRENT_DATE
      AND ee.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
    ORDER BY ee.exit_date, ee.nom_effectif, ee.prenom_effectif
    """
    cur.execute(sql, tuple(cte_params + [id_ent, horizon]))
    return [dict(r) for r in (cur.fetchall() or [])]

def _fetch_prevision_poste_impact_causes(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    leaving_ids: List[str],
) -> Dict[str, Dict[str, Any]]:
    """Trace les sortants qui peuvent impacter un poste : titulaire du poste ou porteur d'une compétence requise."""
    ids = sorted({str(x or "").strip() for x in (leaving_ids or []) if str(x or "").strip()})
    if not ids:
        return {}

    scope_id = (id_service or "").strip() or None
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)
    sql = f"""
    WITH
    {cte_sql},
    leaving AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.id_poste_actuel,
            e.date_sortie_prevue,
            COALESCE(e.havedatefin, FALSE) AS havedatefin,
            e.retraite_estimee::int AS retraite_annee,
            COALESCE(EXTRACT(MONTH FROM e.date_entree_entreprise_effectif)::int, 6) AS m_entree,
            COALESCE(EXTRACT(DAY FROM e.date_entree_entreprise_effectif)::int, 15) AS d_entree
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND e.id_effectif::text = ANY(%s::text[])
    ),
    leaving_exit AS (
        SELECT
            l.*,
            CASE
                WHEN l.date_sortie_prevue IS NOT NULL THEN l.date_sortie_prevue
                WHEN l.retraite_annee IS NOT NULL THEN
                    (
                        make_date(l.retraite_annee, l.m_entree, 1)
                        + (((LEAST(
                                l.d_entree,
                                EXTRACT(DAY FROM (date_trunc('month', make_date(l.retraite_annee, l.m_entree, 1)) + interval '1 month - 1 day'))::int
                            ) - 1)::text || ' days')::interval)
                    )::date
                ELSE NULL
            END AS exit_date,
            TRIM(CONCAT(COALESCE(l.prenom_effectif, ''), ' ', COALESCE(l.nom_effectif, ''))) AS full_name
        FROM leaving l
    ),
    req AS (
        SELECT DISTINCT
            fpc.id_poste,
            c.id_comp
        FROM public.tbl_fiche_poste_competence fpc
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE c.etat = 'active'
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    direct_poste AS (
        SELECT
            le.id_poste_actuel AS id_poste,
            le.id_effectif,
            le.full_name,
            le.exit_date,
            'titulaire'::text AS cause_type
        FROM leaving_exit le
        WHERE COALESCE(le.id_poste_actuel, '') <> ''
    ),
    competence_poste AS (
        SELECT DISTINCT
            r.id_poste,
            le.id_effectif,
            le.full_name,
            le.exit_date,
            'competence'::text AS cause_type
        FROM leaving_exit le
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = le.id_effectif
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
        JOIN req r ON r.id_comp = ec.id_comp
    ),
    all_causes AS (
        SELECT * FROM direct_poste
        UNION
        SELECT * FROM competence_poste
    )
    SELECT
        id_poste,
        COUNT(DISTINCT id_effectif)::int AS nb_sortants_lies,
        COUNT(DISTINCT CASE WHEN cause_type = 'titulaire' THEN id_effectif END)::int AS nb_sortants_titulaires,
        COUNT(DISTINCT CASE WHEN cause_type = 'competence' THEN id_effectif END)::int AS nb_sortants_competences,
        MIN(exit_date) AS first_exit_date,
        MAX(exit_date) AS last_exit_date,
        STRING_AGG(DISTINCT NULLIF(full_name, ''), ', ') AS sortants_label
    FROM all_causes
    WHERE COALESCE(id_poste, '') <> ''
    GROUP BY id_poste
    """
    params = list(cte_params) + [id_ent, ids, int(criticite_min)]
    if sql.count("%s") != len(params):
        raise RuntimeError(
            f"Paramètres SQL incohérents pour les causes postes prévisionnelles : "
            f"{sql.count('%s')} placeholders / {len(params)} paramètres"
        )
    cur.execute(sql, tuple(params))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    return {str(r.get("id_poste") or "").strip(): r for r in rows if str(r.get("id_poste") or "").strip()}

def _analyse_prevision_poste_causes_from_record(row: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Synthèse courte des causes issues du moteur Risques actuels poste."""
    r = row or {}
    causes: List[Dict[str, Any]] = []

    def add(code: str, titre: str, detail: str, count: int = 0, score: int = 0) -> None:
        causes.append({
            "code": code,
            "titre": titre,
            "detail": detail,
            "count": max(0, _safe_int(count, 0)),
            "score": max(0, _safe_int(score, 0)),
        })

    nb_titulaires = max(_safe_int(r.get("nb_titulaires"), 0), 0)
    nb_cible = max(_safe_int(r.get("nb_titulaires_cible"), 1), 1)
    gap = max(_safe_int(r.get("gap_titulaires"), 0), 0)
    nb_indispo = max(_safe_int(r.get("nb_indisponibles"), 0), 0)

    if bool(r.get("rupture") or False) or gap > 0 or nb_indispo > 0:
        parts = [f"titulaires disponibles {nb_titulaires}/{nb_cible}"]
        if gap > 0:
            parts.append(f"écart de couverture {gap}")
        if nb_indispo > 0:
            parts.append(f"{nb_indispo} indisponibilité(s) en cours")
        add(
            "STRUCTURE_POSTE",
            "Structure du poste",
            " · ".join(parts),
            count=gap or nb_indispo,
            score=_safe_int(r.get("score_structurel"), 0),
        )

    score_efficacite = _safe_int(r.get("score_efficacite"), 0)
    nb_ecarts = max(_safe_int(r.get("nb_critiques_sans_porteur"), 0), 0)
    nb_non_confirmees = max(_safe_int(r.get("nb_couvertures_non_confirmees"), 0), 0)
    if score_efficacite > 0 or nb_ecarts > 0 or nb_non_confirmees > 0:
        detail = f"{nb_ecarts} compétence(s) avec niveau attendu non atteint"
        if nb_non_confirmees > 0:
            detail += f" · {nb_non_confirmees} couverture(s) à confirmer"
        add(
            "EFFICACITE_COUVERTURE",
            "Niveaux attendus non atteints",
            detail,
            count=nb_ecarts + nb_non_confirmees,
            score=score_efficacite,
        )

    score_dependance = _safe_int(r.get("score_dependance"), 0)
    nb_dependances = max(_safe_int(r.get("nb_critiques_porteur_unique"), 0), 0)
    if score_dependance > 0 or nb_dependances > 0:
        add(
            "DEPENDANCE_INTERNE",
            "Dépendance interne",
            f"{nb_dependances} compétence(s) reposent sur une couverture titulaire unique",
            count=nb_dependances,
            score=score_dependance,
        )

    score_renfort = _safe_int(r.get("score_renfort_potentiel") or r.get("score_transmission"), 0)
    imm = max(_safe_int(r.get("nb_renforts_immediats"), 0), 0)
    prep = max(_safe_int(r.get("nb_renforts_a_preparer"), 0), 0)
    best = max(_safe_int(r.get("meilleur_matching"), 0), 0)
    if score_renfort > 0:
        add(
            "RENFORT_POTENTIEL",
            "Renfort potentiel insuffisant",
            f"renforts immédiats {imm} · à préparer {prep} · meilleur matching {best}%",
            count=max(0, 1 if imm <= 0 else 0),
            score=score_renfort,
        )

    score_sorties = _safe_int(r.get("score_sorties_approchantes"), 0)
    nb_sorties = max(_safe_int(r.get("nb_sorties_approchantes"), 0), 0)
    if score_sorties > 0 or nb_sorties > 0:
        add(
            "SORTIES_APPROCHANTES",
            "Sorties approchantes",
            f"{nb_sorties} sortie(s) proche(s) déjà prises en compte dans les risques actuels",
            count=nb_sorties,
            score=score_sorties,
        )

    causes.sort(key=lambda x: (-_safe_int(x.get("score"), 0), -_safe_int(x.get("count"), 0), str(x.get("titre") or "")))
    return causes

def _fetch_prevision_poste_impacts(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """Prévisions postes = moteur Risques actuels rejoué sans les sortants N+X."""
    scope_id = (id_service or "").strip() or None
    horizon = max(1, min(5, int(horizon_years or 1)))
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    lim = max(1, min(2000, int(limit or 200)))

    leaving_rows = _fetch_prevision_poste_leaving_rows(cur, id_ent, scope_id, horizon)
    leaving_ids = sorted({str(r.get("id_effectif") or "").strip() for r in leaving_rows if str(r.get("id_effectif") or "").strip()})
    if not leaving_ids:
        return []

    today = date.today()

    current_records = _fetch_postes_fragility_records(cur, id_ent, scope_id, cmin)
    future_records = _fetch_postes_fragility_records_projected(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        excluded_effectif_ids=leaving_ids,
    )

    current_by_poste = {str(r.get("id_poste") or "").strip(): r for r in current_records if str(r.get("id_poste") or "").strip()}
    future_by_poste = {str(r.get("id_poste") or "").strip(): r for r in future_records if str(r.get("id_poste") or "").strip()}
    causes_by_poste = _fetch_prevision_poste_impact_causes(cur, id_ent, scope_id, cmin, leaving_ids)

    items: List[Dict[str, Any]] = []
    for pid, cur_rec in current_by_poste.items():
        fut_rec = future_by_poste.get(pid)
        if not fut_rec:
            continue
        meta = causes_by_poste.get(pid)
        if not meta:
            continue

        indice_now = _clamp_int(int(cur_rec.get("indice_fragilite") or 0), 0, 100)
        indice_h = _clamp_int(int(fut_rec.get("indice_fragilite") or 0), 0, 100)
        delta = max(0, indice_h - indice_now)
        if delta <= 0:
            continue

        last_exit_date = meta.get("last_exit_date") or meta.get("first_exit_date")
        if hasattr(last_exit_date, "isoformat"):
            last_exit_date = last_exit_date.isoformat()

        items.append({
            "id_poste": pid,
            "codif_poste": cur_rec.get("codif_poste"),
            "codif_client": cur_rec.get("codif_client"),
            "intitule_poste": cur_rec.get("intitule_poste"),
            "nom_service": cur_rec.get("nom_service"),
            "nb_titulaires_cible": int(cur_rec.get("nb_titulaires_cible") or 1),
            "nb_titulaires_now": int(cur_rec.get("nb_titulaires") or 0),
            "nb_titulaires_horizon": int(fut_rec.get("nb_titulaires") or 0),
            "nb_titulaires": int(fut_rec.get("nb_titulaires") or 0),
            "indice_fragilite_now": indice_now,
            "indice_fragilite_horizon": indice_h,
            "delta_fragilite": int(delta),
            "nb_sortants_lies": int(meta.get("nb_sortants_lies") or 0),
            "nb_sortants_titulaires": int(meta.get("nb_sortants_titulaires") or 0),
            "nb_sortants_competences": int(meta.get("nb_sortants_competences") or 0),
            "sortants_label": meta.get("sortants_label") or "",
            "last_exit_date": last_exit_date,
            "priorite_label": "Critique" if indice_h >= 75 else ("Élevée" if indice_h >= 50 else ("Modérée" if indice_h >= 25 else "Faible")),
            "causes_risques_actuels": _analyse_prevision_poste_causes_from_record(cur_rec),
            "causes_detail_source": "risques_actuels_poste",
        })

    items.sort(key=lambda x: (-(int(x.get("delta_fragilite") or 0)), -(int(x.get("indice_fragilite_horizon") or 0)), str(x.get("intitule_poste") or "")))
    return items[:lim]

def _analyse_prevision_poste_average_delta(items: List[Dict[str, Any]]) -> int:
    deltas = [int(x.get("delta_fragilite") or 0) for x in (items or []) if int(x.get("delta_fragilite") or 0) > 0]
    if not deltas:
        return 0
    return int(round(sum(deltas) / float(len(deltas))))

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



# ======================================================
# Dashboard Insights — calculs centralisés
# ======================================================

def _dashboard_normalize_criticite_min(value: Optional[int]) -> int:
    try:
        n = int(value if value is not None else CRITICITE_MIN_DEFAULT)
    except Exception:
        n = CRITICITE_MIN_DEFAULT
    return max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, n))


def _dashboard_enrich_records_poste_criticite(cur, records: List[Dict[str, Any]]) -> None:
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
    mp = {str(r.get("id_poste") or ""): _safe_int(r.get("criticite_poste"), 2) for r in (cur.fetchall() or [])}
    for r in records:
        pid = str(r.get("id_poste") or "")
        r["criticite_poste"] = _safe_int(mp.get(pid, r.get("criticite_poste") or 2), 2)


def _dashboard_fetch_current_poste_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
) -> List[Dict[str, Any]]:
    records = _fetch_postes_fragility_records(
        cur,
        id_ent,
        id_service,
        _dashboard_normalize_criticite_min(criticite_min),
    )
    _dashboard_enrich_records_poste_criticite(cur, records)
    return records


def _dashboard_month_bounds(base: date, month_offset: int) -> Tuple[date, date]:
    d = _analyse_add_months(base, int(month_offset or 0))
    start = date(d.year, d.month, 1)
    end = _analyse_add_months(start, 1) - timedelta(days=1)
    return start, end


def _dashboard_fetch_current_competence_records(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    limit: int = 100000,
) -> List[Dict[str, Any]]:
    records = _fetch_competence_fragility_records(
        cur,
        id_ent,
        id_service,
        _dashboard_normalize_criticite_min(criticite_min),
        comp_id=None,
        limit=int(limit),
    )
    return _analyse_fragility_records_analyzed(records)


def _dashboard_component(value: Any, weight: int, key: str, label: str, source: str) -> Dict[str, Any]:
    pct = round(max(0.0, min(100.0, float(value or 0.0))), 1)
    w = max(0, min(100, _safe_int(weight, 0)))
    return {
        "key": key,
        "label": label,
        "pct": pct,
        "weight": w,
        "weighted_score": round(pct * (w / 100.0), 1),
        "source": source,
    }


def _dashboard_health_component_value(payload: Optional[Dict[str, Any]], key: str = "pct") -> float:
    if not payload:
        return 0.0
    try:
        return max(0.0, min(100.0, float(payload.get(key) or 0.0)))
    except Exception:
        return 0.0


def _dashboard_compute_health_from_records(
    records: List[Dict[str, Any]],
    scope_label: str,
    competence_records: Optional[List[Dict[str, Any]]] = None,
    transmission: Optional[Dict[str, Any]] = None,
    reliability: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Santé globale dashboard.
    Source : composants centralisés du moteur analyse.
    Pondération validée :
    - robustesse postes 40 % ;
    - robustesse compétences 25 % ;
    - fiabilité des données 15 % ;
    - capacité de transmission 20 %.
    """
    poste_records = _analyse_fragility_records_analyzed(records)
    comp_records_all = _analyse_fragility_records_analyzed(competence_records or [])
    comp_records_fragiles = [r for r in comp_records_all if _safe_int(r.get("indice_fragilite"), 0) > 0]

    postes_fragility = _analyse_fragility_average(poste_records)
    competences_fragility = _analyse_fragility_average(comp_records_fragiles) if comp_records_all else 100

    postes_health = 100.0 - float(postes_fragility) if poste_records else 0.0
    competences_health = 100.0 - float(competences_fragility) if comp_records_all else 0.0
    reliability_health = _dashboard_health_component_value(reliability)
    transmission_health = _dashboard_health_component_value(transmission)

    components = [
        _dashboard_component(
            postes_health,
            40,
            "postes",
            "Robustesse des postes",
            "Inverse de la fragilité moyenne des postes issue du moteur analyse.",
        ),
        _dashboard_component(
            competences_health,
            25,
            "competences",
            "Robustesse des compétences",
            "Inverse de la fragilité moyenne des compétences fragiles du périmètre.",
        ),
        _dashboard_component(
            reliability_health,
            15,
            "fiabilite",
            "Fiabilité des données",
            "Part des évaluations récentes sur les éléments analysés.",
        ),
        _dashboard_component(
            transmission_health,
            20,
            "transmission",
            "Capacité de transmission",
            "Part des compétences disposant d'une transmission validée ou à confirmer.",
        ),
    ]

    pct = round(sum(float(c.get("weighted_score") or 0.0) for c in components), 1)
    max_score = 100.0
    score = pct
    nb_items = len(poste_records)

    return {
        "pct": pct,
        "score": score,
        "max_score": max_score,
        "nb_items": nb_items,
        "scope_label": scope_label or "Tous les services",
        "components": components,
        "postes_fragilite_moyenne": int(round(float(postes_fragility))) if poste_records else 0,
        "competences_fragilite_moyenne": int(round(float(competences_fragility))) if comp_records_all else 0,
    }


def _dashboard_compute_risk_timeline(
    cur,
    id_ent: str,
    id_service: Optional[str],
    current_records: List[Dict[str, Any]],
    criticite_min: int,
    months: int = 12,
) -> List[Dict[str, Any]]:
    today = date.today()
    horizon = max(0, min(36, _safe_int(months, 12)))
    out: List[Dict[str, Any]] = []

    for i in range(horizon + 1):
        d = _analyse_add_months(today, i)
        if i == 0:
            records = current_records or []
        else:
            period_start, period_end = _dashboard_month_bounds(today, i)
            records = _fetch_postes_fragility_records_projected(
                cur,
                id_ent,
                id_service,
                _dashboard_normalize_criticite_min(criticite_min),
                period_start,
                period_end,
            )
            _dashboard_enrich_records_poste_criticite(cur, records)

        analysed = _analyse_fragility_records_analyzed(records)
        fragile = [r for r in analysed if bool(r.get("is_fragile"))]
        out.append({
            "date_ref": d.isoformat(),
            "label": d.strftime("%m/%y"),
            "indice_fragilite": _analyse_fragility_average(records),
            "nb_postes_fragiles": len(fragile),
            "nb_postes_total": len(analysed),
        })
    return out


def _dashboard_compute_postes_watch_from_records(
    records: List[Dict[str, Any]],
    danger_min: int = 60,
    watch_min: int = 1,
    critical_poste_min: int = 3,
) -> Dict[str, Any]:
    analysed = _analyse_fragility_records_analyzed(records)
    total = len(analysed)
    danger = [r for r in analysed if _safe_int(r.get("indice_fragilite"), 0) >= int(danger_min)]
    watch = [
        r for r in analysed
        if int(watch_min) <= _safe_int(r.get("indice_fragilite"), 0) < int(danger_min)
    ]
    stable = max(total - len(danger) - len(watch), 0)
    critical_danger = [r for r in danger if _safe_int(r.get("criticite_poste"), 2) >= int(critical_poste_min)]
    return {
        "total_postes": total,
        "postes_danger": len(danger),
        "postes_surveillance": len(watch),
        "postes_stables": stable,
        "postes_critiques_danger": len(critical_danger),
    }


def _dashboard_compute_transmission_capacity(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    seuil_mois: int = 6,
) -> Dict[str, Any]:
    """
    Capacité de transmission dashboard.

    Lecture métier : une compétence du périmètre est transmissible si elle
    dispose d'au moins un transmetteur identifié avec une donnée exploitable :
    - niveau Expert ;
    - ou niveau Avancé haut, matérialisé par un score normalisé >= 63 %.

    Le taux dashboard retient les compétences en transmission validée ou à
    confirmer. Les compétences avec transmetteur potentiel mais donnée trop
    ancienne / absente restent visibles en "entretien recommandé", sans entrer
    dans le taux sécurisé.
    """
    cmin = _dashboard_normalize_criticite_min(criticite_min)
    months = max(1, min(60, _safe_int(seuil_mois, 6)))
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    sql = f"""
    WITH
    {cte_sql},
    competences_scope AS (
        SELECT DISTINCT
            c.id_comp,
            COALESCE(c.code, '') AS code,
            COALESCE(c.intitule, '') AS intitule
        FROM postes_scope ps
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_poste = ps.id_poste
        JOIN public.tbl_competence c
          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') = 'active'
    ),
    porteurs_base AS (
        SELECT
            cs.id_comp,
            e.id_effectif,
            COALESCE(a.date_audit, ec.date_derniere_eval)::date AS date_derniere_eval,
            CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
                WHEN 'a' THEN 1
                WHEN 'initial' THEN 1
                WHEN 'débutant' THEN 1
                WHEN 'debutant' THEN 1
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
            END AS niveau_rank,
            CASE
                WHEN a.resultat_eval IS NULL THEN NULL
                WHEN a.resultat_eval <= 24 THEN (a.resultat_eval / 24.0) * 100.0
                ELSE a.resultat_eval
            END AS score_pct
        FROM competences_scope cs
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_comp = cs.id_comp
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
        JOIN public.tbl_effectif_client e
          ON e.id_effectif = ec.id_effectif_client
        JOIN effectifs_scope es
          ON es.id_effectif = e.id_effectif
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND (e.date_sortie_prevue IS NULL OR e.date_sortie_prevue > CURRENT_DATE)
          AND NOT EXISTS (
              SELECT 1
              FROM public.tbl_effectif_client_break b
              WHERE b.id_effectif = e.id_effectif
                AND COALESCE(b.archive, FALSE) = FALSE
                AND b.date_debut <= CURRENT_DATE
                AND b.date_fin >= CURRENT_DATE
          )
    ),
    transmetteurs AS (
        SELECT
            pb.*,
            CASE
                WHEN pb.niveau_rank >= 4 THEN TRUE
                WHEN COALESCE(pb.score_pct, -1) >= 63 THEN TRUE
                ELSE FALSE
            END AS is_transmetteur,
            CASE
                WHEN pb.date_derniere_eval IS NOT NULL
                 AND pb.date_derniere_eval >= (CURRENT_DATE - (%s::int * INTERVAL '1 month'))::date
                THEN TRUE ELSE FALSE
            END AS is_recent,
            CASE
                WHEN pb.niveau_rank >= 4 THEN TRUE
                WHEN COALESCE(pb.score_pct, 0) > 75 THEN TRUE
                ELSE FALSE
            END AS is_valide_fort
        FROM porteurs_base pb
    ),
    agg AS (
        SELECT
            cs.id_comp,
            COUNT(DISTINCT CASE WHEN t.is_transmetteur THEN t.id_effectif END)::int AS transmetteurs_total,
            COUNT(DISTINCT CASE WHEN t.is_transmetteur AND t.is_recent AND t.is_valide_fort THEN t.id_effectif END)::int AS valid_count,
            COUNT(DISTINCT CASE WHEN t.is_transmetteur AND t.is_recent AND NOT t.is_valide_fort THEN t.id_effectif END)::int AS confirm_count,
            COUNT(DISTINCT CASE WHEN t.is_transmetteur AND NOT t.is_recent THEN t.id_effectif END)::int AS review_count
        FROM competences_scope cs
        LEFT JOIN transmetteurs t ON t.id_comp = cs.id_comp
        GROUP BY cs.id_comp
    )
    SELECT
        COUNT(*)::int AS competences_total,
        COALESCE(SUM(CASE WHEN valid_count > 0 THEN 1 ELSE 0 END), 0)::int AS transmission_valides_count,
        COALESCE(SUM(CASE WHEN valid_count <= 0 AND confirm_count > 0 THEN 1 ELSE 0 END), 0)::int AS transmission_confirm_count,
        COALESCE(SUM(CASE WHEN valid_count <= 0 AND confirm_count <= 0 AND review_count > 0 THEN 1 ELSE 0 END), 0)::int AS transmission_review_count,
        COALESCE(SUM(CASE WHEN transmetteurs_total <= 0 THEN 1 ELSE 0 END), 0)::int AS sans_transmetteur_count,
        COALESCE(SUM(transmetteurs_total), 0)::int AS transmetteurs_identifies_count
    FROM agg
    """
    params = list(cte_params) + [cmin, id_ent, months]
    if sql.count("%s") != len(params):
        raise RuntimeError(
            f"Paramètres SQL incohérents pour la capacité de transmission dashboard : "
            f"{sql.count('%s')} placeholders / {len(params)} paramètres"
        )

    cur.execute(sql, tuple(params))
    row = cur.fetchone() or {}
    total = _safe_int(row.get("competences_total"), 0)
    valid = _safe_int(row.get("transmission_valides_count"), 0)
    confirm = _safe_int(row.get("transmission_confirm_count"), 0)
    review = _safe_int(row.get("transmission_review_count"), 0)
    none = _safe_int(row.get("sans_transmetteur_count"), 0)
    transmitters = _safe_int(row.get("transmetteurs_identifies_count"), 0)

    ok = valid + confirm
    risk = review + none
    pct = round((ok / float(total)) * 100.0, 1) if total else 0.0

    return {
        "pct": pct,
        # Compatibilité avec l'ancien payload dashboard : les noms sont conservés,
        # mais les volumes représentent désormais des compétences.
        "postes_total": total,
        "postes_transmissibles": ok,
        "postes_risque": risk,
        "competences_total": total,
        "competences_transmissibles": ok,
        "competences_risque": risk,
        "transmission_valides_count": valid,
        "transmission_confirm_count": confirm,
        "transmission_review_count": review,
        "sans_transmetteur_count": none,
        "transmetteurs_identifies_count": transmitters,
        "threshold_score": 63,
        "threshold_label": "Avancé haut ou Expert",
        "seuil_mois": months,
    }


def _dashboard_compute_reliability(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    seuil_mois: int = 6,
) -> Dict[str, Any]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    months = max(1, min(60, _safe_int(seuil_mois, 6)))
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
            SUM(CASE WHEN last_eval >= (CURRENT_DATE - (%s::int * INTERVAL '1 month')) THEN 1 ELSE 0 END)::int AS fresh_items
        FROM items
        """,
        tuple(cte_params + [_dashboard_normalize_criticite_min(criticite_min), months]),
    )
    row = cur.fetchone() or {}
    total = _safe_int(row.get("total_items"), 0)
    fresh = _safe_int(row.get("fresh_items"), 0)
    stale = max(total - fresh, 0)
    pct = round((fresh / total * 100.0), 1) if total else 0.0
    return {
        "pct": pct,
        "fresh_items": fresh,
        "stale_items": stale,
        "total_items": total,
        "seuil_mois": months,
    }


def _dashboard_fetch_postes_with_action(cur, id_ent: str, id_service: Optional[str]) -> set:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
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


def _dashboard_compute_risks_without_action(
    cur,
    id_ent: str,
    id_service: Optional[str],
    records: List[Dict[str, Any]],
    danger_min: int = 60,
    limit: int = 100,
) -> Dict[str, Any]:
    action_postes = _dashboard_fetch_postes_with_action(cur, id_ent, id_service)
    rows = []
    for r in _analyse_fragility_records_analyzed(records):
        id_poste = str(r.get("id_poste") or "").strip()
        if not id_poste or id_poste in action_postes:
            continue
        if _safe_int(r.get("indice_fragilite"), 0) < int(danger_min):
            continue
        rows.append(r)

    items = []
    for r in rows[:max(1, min(2000, _safe_int(limit, 100)))]:
        items.append({
            "id_poste": str(r.get("id_poste") or ""),
            "codif_poste": r.get("codif_poste"),
            "codif_client": r.get("codif_client"),
            "intitule_poste": r.get("intitule_poste") or "Poste",
            "nom_service": r.get("nom_service"),
            "indice_fragilite": _safe_int(r.get("indice_fragilite"), 0),
            "criticite_poste": _safe_int(r.get("criticite_poste"), 0),
            "nb_titulaires": _safe_int(r.get("nb_titulaires"), 0),
            "nb_titulaires_cible": _safe_int(r.get("nb_titulaires_cible"), 0),
            "nb_critiques_fragiles": _safe_int(r.get("nb_critiques_fragiles"), 0),
            "nb_critiques_sans_porteur": _safe_int(r.get("nb_critiques_sans_porteur"), 0),
            "nb_critiques_sans_releve": _safe_int(r.get("nb_critiques_sans_releve"), 0),
        })

    return {
        "total": len(rows),
        "items": items,
    }

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




def _fetch_prevision_transition_capacity(
    cur,
    id_ent: str,
    id_service: Optional[str],
    id_effectif: str,
    id_poste: str,
    horizon_years: int = 1,
) -> Dict[str, Any]:
    """
    Capacité de transmission du sortant sur les compétences de son poste actuel.
    Lecture volontairement sans seuil de criticité : toutes les compétences actives du poste sont prises en compte.
    Une compétence est considérée transmissible si le collaborateur est Expert ou si sa dernière note atteint la moitié haute du niveau Avancé (>= 63%).
    Les autres transmetteurs sont comptés uniquement s'ils restent disponibles dans l'horizon étudié.
    """
    eff_id = (id_effectif or "").strip()
    poste_id = (id_poste or "").strip()
    default = {
        "total_competences_poste": 0,
        "transmissibles_count": 0,
        "unique_transmissibles_count": 0,
        "other_transmitter_count": 0,
        "coverage_pct": 0,
        "unique_share_pct": 0,
        "other_transmitter_pct": 0,
        "threshold_score": 63,
        "threshold_label": "Avancé haut ou Expert",
        "competences": [],
        "unique_competences": [],
        "other_transmitter_competences": [],
    }
    if not eff_id or not poste_id:
        return default

    scope_id = (id_service or "").strip() or None
    cte_sql, cte_params = _build_scope_cte(id_ent, scope_id)
    try:
        horizon = max(1, min(5, int(horizon_years or 1)))
    except Exception:
        horizon = 1

    sql = f"""
    WITH
    {cte_sql},
    poste_comp AS (
        SELECT
            c.id_comp,
            COALESCE(c.code, '') AS code,
            COALESCE(c.intitule, '') AS intitule,
            MAX(COALESCE(fpc.poids_criticite, 0)::int)::int AS criticite
        FROM public.tbl_fiche_poste_competence fpc
        JOIN public.tbl_competence c
          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        WHERE fpc.id_poste = %s
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
        GROUP BY c.id_comp, c.code, c.intitule
    ),
    effectifs_base AS (
        SELECT
            e.id_effectif,
            e.prenom_effectif,
            e.nom_effectif,
            e.date_sortie_prevue,
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
    effectifs_valid AS (
        SELECT
            eb.*,
            CASE
                WHEN eb.date_sortie_prevue IS NOT NULL THEN eb.date_sortie_prevue
                WHEN eb.retraite_annee IS NOT NULL THEN
                    (
                        make_date(eb.retraite_annee, eb.m_entree, 1)
                        + (
                            (
                                LEAST(
                                    eb.d_entree,
                                    EXTRACT(
                                        DAY FROM (
                                            date_trunc('month', make_date(eb.retraite_annee, eb.m_entree, 1))
                                            + interval '1 month - 1 day'
                                        )
                                    )::int
                                ) - 1
                            )::text || ' days'
                        )::interval
                    )::date
                ELSE NULL
            END AS exit_date
        FROM effectifs_base eb
    ),
    porteurs AS (
        SELECT
            pc.id_comp,
            ev.id_effectif,
            COALESCE(ev.prenom_effectif, '') AS prenom_effectif,
            COALESCE(ev.nom_effectif, '') AS nom_effectif,
            CASE
                WHEN ev.exit_date IS NOT NULL
                 AND ev.exit_date >= CURRENT_DATE
                 AND ev.exit_date <= make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + %s::int, 12, 31)::date
                THEN TRUE ELSE FALSE
            END AS is_sortant_horizon,
            CASE lower(trim(COALESCE(ec.niveau_actuel, '')))
                WHEN 'a' THEN 1
                WHEN 'initial' THEN 1
                WHEN 'débutant' THEN 1
                WHEN 'debutant' THEN 1
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
            a.resultat_eval,
            CASE
                WHEN a.resultat_eval IS NULL THEN NULL
                WHEN a.resultat_eval <= 24 THEN (a.resultat_eval / 24.0) * 100.0
                ELSE a.resultat_eval
            END AS score_pct,
            CASE
                WHEN lower(trim(COALESCE(ec.niveau_actuel, ''))) IN ('d', 'expert') THEN TRUE
                WHEN a.resultat_eval IS NOT NULL
                 AND (
                    CASE
                        WHEN a.resultat_eval <= 24 THEN (a.resultat_eval / 24.0) * 100.0
                        ELSE a.resultat_eval
                    END
                 ) >= 63 THEN TRUE
                ELSE FALSE
            END AS is_transmissible
        FROM poste_comp pc
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_comp = pc.id_comp
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
        JOIN effectifs_valid ev ON ev.id_effectif = ec.id_effectif_client
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
    ),
    agg AS (
        SELECT
            pc.id_comp,
            pc.code,
            pc.intitule,
            pc.criticite,
            COALESCE(BOOL_OR(p.id_effectif = %s AND p.is_transmissible), FALSE) AS sortant_transmissible,
            MAX(CASE WHEN p.id_effectif = %s THEN p.resultat_eval END) AS score_sortant,
            MAX(CASE WHEN p.id_effectif = %s THEN p.score_pct END) AS score_pct_sortant,
            MAX(CASE WHEN p.id_effectif = %s THEN p.act_rank END) AS rank_sortant,
            COUNT(DISTINCT CASE
                WHEN p.id_effectif <> %s
                 AND p.is_transmissible
                 AND COALESCE(p.is_sortant_horizon, FALSE) = FALSE
                THEN p.id_effectif END
            )::int AS autres_transmissibles,
            COALESCE(
                jsonb_agg(
                    DISTINCT jsonb_build_object(
                        'id_effectif', p.id_effectif,
                        'prenom_effectif', p.prenom_effectif,
                        'nom_effectif', p.nom_effectif,
                        'full', BTRIM(CONCAT(COALESCE(p.prenom_effectif, ''), ' ', COALESCE(p.nom_effectif, ''))),
                        'score_pct', p.score_pct,
                        'rank', p.act_rank
                    )
                ) FILTER (
                    WHERE p.id_effectif <> %s
                      AND p.is_transmissible
                      AND COALESCE(p.is_sortant_horizon, FALSE) = FALSE
                ),
                '[]'::jsonb
            ) AS autres_transmetteurs
        FROM poste_comp pc
        LEFT JOIN porteurs p ON p.id_comp = pc.id_comp
        GROUP BY pc.id_comp, pc.code, pc.intitule, pc.criticite
    )
    SELECT *
    FROM agg
    ORDER BY sortant_transmissible DESC, autres_transmissibles ASC, criticite DESC, code ASC, intitule ASC
    """
    params = list(cte_params) + [poste_id, id_ent, horizon, eff_id, eff_id, eff_id, eff_id, eff_id, eff_id]
    if sql.count("%s") != len(params):
        raise RuntimeError(
            f"Paramètres SQL incohérents pour la capacité de transmission sortant : "
            f"{sql.count('%s')} placeholders / {len(params)} paramètres"
        )

    cur.execute(sql, tuple(params))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    total = len(rows)
    transmissibles = [r for r in rows if bool(r.get("sortant_transmissible"))]
    uniques = [r for r in transmissibles if _safe_int(r.get("autres_transmissibles"), 0) <= 0]
    non_transmissibles = [r for r in rows if not bool(r.get("sortant_transmissible"))]
    non_transmissibles_with_other = [r for r in non_transmissibles if _safe_int(r.get("autres_transmissibles"), 0) > 0]

    def _as_transmitters(value: Any) -> List[Dict[str, Any]]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except Exception:
                value = []
        if not isinstance(value, list):
            return []
        out: List[Dict[str, Any]] = []
        seen = set()
        for item in value:
            if not isinstance(item, dict):
                continue
            eff = str(item.get("id_effectif") or "").strip()
            if not eff or eff in seen:
                continue
            seen.add(eff)
            full = (item.get("full") or "").strip()
            prenom = (item.get("prenom_effectif") or "").strip()
            nom = (item.get("nom_effectif") or "").strip()
            full = full or (prenom + " " + nom).strip() or "—"
            out.append({
                "id_effectif": eff,
                "prenom_effectif": prenom or None,
                "nom_effectif": nom or None,
                "full": full,
                "score_pct": float(item.get("score_pct")) if item.get("score_pct") is not None else None,
                "rank": _safe_int(item.get("rank"), 0),
            })
        return out

    def _comp_payload(r: Dict[str, Any]) -> Dict[str, Any]:
        transmitters = _as_transmitters(r.get("autres_transmetteurs"))
        return {
            "id_comp": r.get("id_comp"),
            "code": r.get("code"),
            "intitule": r.get("intitule"),
            "criticite": _safe_int(r.get("criticite"), 0),
            "transmission_required_label": "Avancé haut ou Expert",
            "threshold_score": 63,
            "sortant_transmissible": bool(r.get("sortant_transmissible")),
            "score_sortant": float(r.get("score_sortant")) if r.get("score_sortant") is not None else None,
            "score_pct_sortant": float(r.get("score_pct_sortant")) if r.get("score_pct_sortant") is not None else None,
            "rank_sortant": _safe_int(r.get("rank_sortant"), 0),
            "autres_transmissibles": _safe_int(r.get("autres_transmissibles"), 0),
            "autres_transmetteurs": transmitters,
        }

    competences = [_comp_payload(r) for r in rows]

    return {
        "total_competences_poste": int(total),
        "transmissibles_count": int(len(transmissibles)),
        "unique_transmissibles_count": int(len(uniques)),
        "other_transmitter_count": int(len(non_transmissibles_with_other)),
        "coverage_pct": int(round((len(transmissibles) / float(total)) * 100)) if total > 0 else 0,
        "unique_share_pct": int(round((len(uniques) / float(len(transmissibles))) * 100)) if len(transmissibles) > 0 else 0,
        "other_transmitter_pct": int(round((len(non_transmissibles_with_other) / float(len(non_transmissibles))) * 100)) if len(non_transmissibles) > 0 else 0,
        "threshold_score": 63,
        "threshold_label": "Avancé haut ou Expert",
        "competences": competences,
        "unique_competences": [_comp_payload(r) for r in uniques],
        "other_transmitter_competences": [_comp_payload(r) for r in non_transmissibles],
    }

def _fetch_prevision_transition_other_poste_impacts(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    id_effectif: str,
    id_poste_actuel: str,
) -> Dict[str, Any]:
    """
    Impact de la sortie sur les autres postes en réutilisant strictement le moteur de fragilité des risques actuels,
    puis en le rejouant avec le collaborateur exclu.
    """
    eff_id = (id_effectif or "").strip()
    current_poste = (id_poste_actuel or "").strip()
    if not eff_id:
        return {"count": 0, "max_delta": 0, "avg_delta": 0, "items": []}

    scope_id = (id_service or "").strip() or None
    cmin = max(CRITICITE_MIN_MIN, min(CRITICITE_MIN_MAX, int(criticite_min or 0)))
    today = date.today()

    current_records = _fetch_postes_fragility_records(cur, id_ent, scope_id, cmin)
    projected_records = _fetch_postes_fragility_records_projected(
        cur,
        id_ent,
        scope_id,
        cmin,
        today,
        today,
        excluded_effectif_ids=[eff_id],
    )

    current_by_poste = {
        str(r.get("id_poste") or "").strip(): r
        for r in current_records
        if str(r.get("id_poste") or "").strip()
    }
    projected_by_poste = {
        str(r.get("id_poste") or "").strip(): r
        for r in projected_records
        if str(r.get("id_poste") or "").strip()
    }

    items: List[Dict[str, Any]] = []
    for pid, cur_rec in current_by_poste.items():
        if current_poste and pid == current_poste:
            continue
        fut_rec = projected_by_poste.get(pid)
        if not fut_rec:
            continue

        indice_now = _clamp_int(_safe_int(cur_rec.get("indice_fragilite"), 0), 0, 100)
        indice_after = _clamp_int(_safe_int(fut_rec.get("indice_fragilite"), 0), 0, 100)
        delta = max(0, indice_after - indice_now)
        if delta <= 0:
            continue

        items.append({
            "id_poste": pid,
            "codif_poste": cur_rec.get("codif_poste"),
            "codif_client": cur_rec.get("codif_client"),
            "intitule_poste": cur_rec.get("intitule_poste"),
            "nom_service": cur_rec.get("nom_service"),
            "indice_fragilite_now": int(indice_now),
            "indice_fragilite_after": int(indice_after),
            "delta_fragilite": int(delta),
            "nb_titulaires_now": _safe_int(cur_rec.get("nb_titulaires"), 0),
            "nb_titulaires_after": _safe_int(fut_rec.get("nb_titulaires"), 0),
        })

    items.sort(key=lambda x: (-(int(x.get("delta_fragilite") or 0)), -(int(x.get("indice_fragilite_after") or 0)), str(x.get("intitule_poste") or "")))
    deltas = [int(x.get("delta_fragilite") or 0) for x in items]
    return {
        "count": int(len(items)),
        "max_delta": int(max(deltas)) if deltas else 0,
        "avg_delta": int(round(sum(deltas) / float(len(deltas)))) if deltas else 0,
        "items": items[:8],
    }


def _fetch_prevision_transition_modal_detail(
    cur,
    id_ent: str,
    id_service: Optional[str],
    horizon_years: int,
    criticite_min: int,
    event_kind: str,
    id_effectif: str,
) -> Optional[Dict[str, Any]]:
    """Détail enrichi pour les modals Sortie confirmée / Sortie potentielle."""
    eff_id = (id_effectif or "").strip()
    if not eff_id:
        return None

    rows = _fetch_prevision_transition_events(
        cur,
        id_ent,
        id_service,
        horizon_years,
        criticite_min,
        event_kind,
        2000,
    )
    item = next((dict(r) for r in rows if str(r.get("id_effectif") or "").strip() == eff_id), None)
    if not item:
        return None

    item["transmission_capacity"] = _fetch_prevision_transition_capacity(
        cur,
        id_ent,
        id_service,
        eff_id,
        str(item.get("id_poste_actuel") or "").strip(),
        horizon_years,
    )
    item["other_poste_impacts"] = _fetch_prevision_transition_other_poste_impacts(
        cur,
        id_ent,
        id_service,
        criticite_min,
        eff_id,
        str(item.get("id_poste_actuel") or "").strip(),
    )
    return item

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
    La sortie est agrégée par compétence : une seule ligne, même si plusieurs collaborateurs concernés existent.
    Les indicateurs d'expertise sont calculés ici pour garder la page front en lecture simple.
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
            ec.niveau_actuel,
            CASE UPPER(COALESCE(ec.niveau_actuel, ''))
                WHEN 'D' THEN 4
                WHEN 'C' THEN 3
                WHEN 'B' THEN 2
                WHEN 'A' THEN 1
                ELSE 0
            END AS niveau_actuel_rank
        FROM leaving l
        JOIN public.tbl_effectif_client_competence ec
          ON ec.id_effectif_client = l.id_effectif
         AND COALESCE(ec.actif, TRUE) = TRUE
         AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    impacted_req AS (
        SELECT
            lc.id_comp,
            COUNT(DISTINCT fpc.id_poste)::int AS nb_postes_impactes,
            MAX(COALESCE(fpc.poids_criticite, 0))::int AS max_criticite,
            MAX(CASE COALESCE(fpc.niveau_requis, '') WHEN 'D' THEN 4 WHEN 'C' THEN 3 WHEN 'B' THEN 2 WHEN 'A' THEN 1 ELSE 0 END)::int AS niveau_requis_rank
        FROM (SELECT DISTINCT id_comp FROM leaving_comp) lc
        JOIN public.tbl_fiche_poste_competence fpc
          ON fpc.id_competence = lc.id_comp
         AND COALESCE(fpc.masque, FALSE) = FALSE
         AND COALESCE(fpc.poids_criticite, 0)::int >= %s
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
        WHERE COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') = 'active'
        GROUP BY lc.id_comp
    ),
    leaving_summary AS (
        SELECT
            lc.id_comp,
            MIN(lc.exit_date) AS first_exit_date,
            COUNT(DISTINCT lc.id_effectif)::int AS sortants_count,
            STRING_AGG(TRIM(CONCAT(COALESCE(lc.prenom_effectif, ''), ' ', COALESCE(lc.nom_effectif, ''))), ', ') AS sortants_label,
            MAX(lc.niveau_actuel_rank)::int AS niveau_actuel_rank
        FROM leaving_comp lc
        GROUP BY lc.id_comp
    ),
    first_exit AS (
        SELECT DISTINCT ON (lc.id_comp)
            lc.id_comp,
            lc.id_effectif,
            lc.prenom_effectif,
            lc.nom_effectif,
            TRIM(CONCAT(COALESCE(lc.prenom_effectif, ''), ' ', COALESCE(lc.nom_effectif, ''))) AS full,
            lc.id_service,
            lc.id_poste_actuel,
            lc.exit_date,
            lc.exit_kind,
            lc.raison_sortie
        FROM leaving_comp lc
        ORDER BY lc.id_comp, lc.exit_date ASC, lc.nom_effectif ASC, lc.prenom_effectif ASC
    ),
    transmetteurs_base AS (
        SELECT
            ec.id_comp,
            e.id_effectif,
            COALESCE(e.prenom_effectif, '') AS prenom_effectif,
            COALESCE(e.nom_effectif, '') AS nom_effectif,
            e.id_poste_actuel,
            COALESCE(fp.codif_poste, '') AS codif_poste,
            COALESCE(fp.codif_client, '') AS codif_client,
            COALESCE(fp.intitule_poste, '') AS intitule_poste,
            COALESCE(ec.niveau_actuel, '')::text AS niveau_actuel,
            COALESCE(a.date_audit, ec.date_derniere_eval)::date AS date_derniere_eval,
            CASE
                WHEN a.resultat_eval IS NULL THEN NULL
                WHEN a.resultat_eval <= 24 THEN (a.resultat_eval / 24.0) * 100.0
                ELSE a.resultat_eval
            END AS score_pct
        FROM public.tbl_effectif_client_competence ec
        JOIN public.tbl_effectif_client e ON e.id_effectif = ec.id_effectif_client
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = e.id_poste_actuel
        LEFT JOIN public.tbl_effectif_client_audit_competence a
          ON a.id_audit_competence = ec.id_dernier_audit
         AND a.id_effectif_competence = ec.id_effectif_competence
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND NOT EXISTS (SELECT 1 FROM leaving l WHERE l.id_effectif = e.id_effectif)
          AND (
                UPPER(COALESCE(ec.niveau_actuel, '')) IN ('D', 'EXPERT', '4')
                OR (
                    a.resultat_eval IS NOT NULL
                    AND (
                        CASE
                            WHEN a.resultat_eval <= 24 THEN (a.resultat_eval / 24.0) * 100.0
                            ELSE a.resultat_eval
                        END
                    ) >= 63
                )
          )
    ),
    transmetteurs_qualifies AS (
        SELECT
            tb.*,
            CASE
                WHEN tb.date_derniere_eval IS NULL OR tb.date_derniere_eval < (CURRENT_DATE - interval '6 months')::date THEN 'review'
                WHEN UPPER(COALESCE(tb.niveau_actuel, '')) IN ('D', 'EXPERT', '4') OR COALESCE(tb.score_pct, 0) > 75 THEN 'validated'
                ELSE 'confirm'
            END AS transmission_status,
            CASE
                WHEN tb.date_derniere_eval IS NULL OR tb.date_derniere_eval < (CURRENT_DATE - interval '6 months')::date THEN 'Entretien recommandé'
                WHEN UPPER(COALESCE(tb.niveau_actuel, '')) IN ('D', 'EXPERT', '4') OR COALESCE(tb.score_pct, 0) > 75 THEN 'Validé'
                ELSE 'À confirmer'
            END AS transmission_status_label
        FROM transmetteurs_base tb
    ),
    receveurs AS (
        SELECT
            tq.id_comp,
            COUNT(DISTINCT tq.id_effectif)::int AS receveurs_potentiels_count,
            COUNT(DISTINCT CASE WHEN tq.transmission_status = 'validated' THEN tq.id_effectif END)::int AS transmission_valides_count,
            COUNT(DISTINCT CASE WHEN tq.transmission_status = 'confirm' THEN tq.id_effectif END)::int AS transmission_confirm_count,
            COUNT(DISTINCT CASE WHEN tq.transmission_status = 'review' THEN tq.id_effectif END)::int AS transmission_review_count,
            STRING_AGG(DISTINCT TRIM(CONCAT(tq.prenom_effectif, ' ', tq.nom_effectif)), ', ') AS receveurs_potentiels_label,
            COALESCE(
                jsonb_agg(
                    DISTINCT jsonb_build_object(
                        'id_effectif', tq.id_effectif,
                        'prenom_effectif', tq.prenom_effectif,
                        'nom_effectif', tq.nom_effectif,
                        'full', BTRIM(CONCAT(tq.prenom_effectif, ' ', tq.nom_effectif)),
                        'id_poste_actuel', tq.id_poste_actuel,
                        'codif_poste', tq.codif_poste,
                        'codif_client', tq.codif_client,
                        'intitule_poste', tq.intitule_poste,
                        'niveau_actuel', tq.niveau_actuel,
                        'score_pct', tq.score_pct,
                        'date_derniere_eval', tq.date_derniere_eval,
                        'transmission_status', tq.transmission_status,
                        'transmission_status_label', tq.transmission_status_label
                    )
                ),
                '[]'::jsonb
            ) AS receveurs_potentiels_json
        FROM transmetteurs_qualifies tq
        GROUP BY tq.id_comp
    ),
    expertise AS (
        SELECT
            ec.id_comp,
            COUNT(DISTINCT CASE WHEN UPPER(COALESCE(ec.niveau_actuel, '')) IN ('D', 'EXPERT', '4') THEN e.id_effectif END)::int AS experts_total,
            COUNT(DISTINCT CASE WHEN UPPER(COALESCE(ec.niveau_actuel, '')) IN ('D', 'EXPERT', '4') AND l.id_effectif IS NULL THEN e.id_effectif END)::int AS experts_restants,
            COUNT(DISTINCT CASE WHEN UPPER(COALESCE(ec.niveau_actuel, '')) IN ('D', 'EXPERT', '4') AND l.id_effectif IS NOT NULL THEN e.id_effectif END)::int AS experts_sortants
        FROM public.tbl_effectif_client_competence ec
        JOIN public.tbl_effectif_client e ON e.id_effectif = ec.id_effectif_client
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        LEFT JOIN leaving l ON l.id_effectif = e.id_effectif
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.is_temp, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
        GROUP BY ec.id_comp
    )
    SELECT
        fe.id_effectif,
        fe.prenom_effectif,
        fe.nom_effectif,
        COALESCE(NULLIF(BTRIM(ls.sortants_label), ''), fe.full) AS full,
        COALESCE(NULLIF(BTRIM(ls.sortants_label), ''), fe.full) AS sortants_label,
        COALESCE(ls.sortants_count, 0)::int AS sortants_count,
        fe.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        fe.id_poste_actuel,
        COALESCE(fp.intitule_poste, '') AS intitule_poste,
        COALESCE(fp.codif_poste, '') AS codif_poste,
        COALESCE(fp.codif_client, '') AS codif_client,
        ls.first_exit_date AS exit_date,
        fe.exit_kind,
        fe.raison_sortie,
        ir.id_comp,
        COALESCE(c.code, '') AS code,
        COALESCE(c.intitule, '') AS intitule,
        COALESCE(c.domaine, '') AS domaine,
        CASE COALESCE(ls.niveau_actuel_rank, 0) WHEN 4 THEN 'D' WHEN 3 THEN 'C' WHEN 2 THEN 'B' WHEN 1 THEN 'A' ELSE '' END AS niveau_actuel,
        CASE COALESCE(ir.niveau_requis_rank, 0) WHEN 4 THEN 'D' WHEN 3 THEN 'C' WHEN 2 THEN 'B' WHEN 1 THEN 'A' ELSE '' END AS niveau_a_transmettre,
        COALESCE(ir.nb_postes_impactes, 0)::int AS nb_postes_impactes,
        COALESCE(ir.max_criticite, 0)::int AS max_criticite,
        COALESCE(r.receveurs_potentiels_count, 0)::int AS receveurs_potentiels_count,
        COALESCE(r.transmission_valides_count, 0)::int AS transmission_valides_count,
        COALESCE(r.transmission_confirm_count, 0)::int AS transmission_confirm_count,
        COALESCE(r.transmission_review_count, 0)::int AS transmission_review_count,
        COALESCE(r.receveurs_potentiels_label, '') AS receveurs_potentiels_label,
        COALESCE(r.receveurs_potentiels_json, '[]'::jsonb) AS receveurs_potentiels_json,
        COALESCE(x.experts_total, 0)::int AS experts_total,
        COALESCE(x.experts_restants, 0)::int AS experts_restants,
        COALESCE(x.experts_sortants, 0)::int AS experts_sortants,
        CASE
            WHEN COALESCE(r.transmission_valides_count, 0)::int > 0 THEN 'green'
            WHEN COALESCE(r.transmission_confirm_count, 0)::int > 0 THEN 'blue'
            WHEN COALESCE(r.transmission_review_count, 0)::int > 0 THEN 'pink'
            ELSE 'red'
        END AS expertise_status,
        CASE
            WHEN COALESCE(r.transmission_valides_count, 0)::int > 0 THEN 3
            WHEN COALESCE(r.transmission_confirm_count, 0)::int > 0 THEN 2
            WHEN COALESCE(r.transmission_review_count, 0)::int > 0 THEN 1
            ELSE 0
        END AS expertise_order,
        CASE
            WHEN COALESCE(r.transmission_valides_count, 0)::int > 0 THEN 'Transmission validée'
            WHEN COALESCE(r.transmission_confirm_count, 0)::int > 0 THEN 'Transmission à confirmer'
            WHEN COALESCE(r.transmission_review_count, 0)::int > 0 THEN 'Entretien recommandé'
            ELSE 'Aucune personne identifiée'
        END AS expertise_label,
        CASE
            WHEN COALESCE(r.transmission_valides_count, 0)::int > 0 THEN 'Au moins une personne au niveau Expert dispose d’une évaluation récente.'
            WHEN COALESCE(r.transmission_confirm_count, 0)::int > 0 THEN 'Au moins une personne en Avancé haut dispose d’une évaluation récente.'
            WHEN COALESCE(r.transmission_review_count, 0)::int > 0 THEN 'Une personne semble en capacité de transmettre, mais l’évaluation doit être reprise.'
            ELSE 'Aucune personne en capacité de transmettre n’est identifiée sur cette compétence.'
        END AS expertise_tooltip
    FROM impacted_req ir
    JOIN leaving_summary ls ON ls.id_comp = ir.id_comp
    JOIN first_exit fe ON fe.id_comp = ir.id_comp
    JOIN public.tbl_competence c ON c.id_comp = ir.id_comp
    LEFT JOIN public.tbl_entreprise_organigramme o ON o.id_ent = %s AND o.id_service = fe.id_service AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = fe.id_poste_actuel
    LEFT JOIN receveurs r ON r.id_comp = ir.id_comp
    LEFT JOIN expertise x ON x.id_comp = ir.id_comp
    ORDER BY
        CASE
            WHEN COALESCE(r.transmission_valides_count, 0)::int > 0 THEN 3
            WHEN COALESCE(r.transmission_confirm_count, 0)::int > 0 THEN 2
            WHEN COALESCE(r.transmission_review_count, 0)::int > 0 THEN 1
            ELSE 0
        END ASC,
        COALESCE(ir.max_criticite, 0)::int DESC,
        COALESCE(ir.nb_postes_impactes, 0)::int DESC,
        ls.first_exit_date ASC,
        c.code ASC
    LIMIT %s
    """
    params = list(cte_params) + [id_ent, horizon, cmin, id_ent, id_ent, id_ent, lim]
    cur.execute(sql, tuple(params))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    out: List[Dict[str, Any]] = []
    for r in rows:
        exit_date = r.get("exit_date")
        if hasattr(exit_date, "isoformat"):
            exit_date = exit_date.isoformat()
        item = dict(r)
        item["exit_date"] = exit_date
        item["first_exit_date"] = exit_date
        current_rank = _niveau_rank(item.get("niveau_actuel"))
        target_rank = _niveau_rank(item.get("niveau_a_transmettre"))
        item["titulaire_transmet_label"] = "Oui" if current_rank >= target_rank and target_rank > 0 else "À confirmer"
        item["impact_label"] = f"{_safe_int(item.get('nb_postes_impactes'), 0)} poste(s)"
        item["event_kind_label"] = _prevision_exit_kind_label(item.get("exit_kind") or "")
        item["expertise_color"] = item.get("expertise_status") or "red"
        item["expertise_order"] = _safe_int(item.get("expertise_order"), 0)
        item["transmetteurs_potentiels_count"] = _safe_int(item.get("receveurs_potentiels_count"), 0)
        item["transmission_valides_count"] = _safe_int(item.get("transmission_valides_count"), 0)
        item["transmission_confirm_count"] = _safe_int(item.get("transmission_confirm_count"), 0)
        item["transmission_review_count"] = _safe_int(item.get("transmission_review_count"), 0)
        item["transmetteurs_potentiels_label"] = item.get("receveurs_potentiels_label") or ""
        item["transmetteurs_potentiels_json"] = item.get("receveurs_potentiels_json") or []
        out.append(item)
    return out


# ======================================================
# Synthèse des risques — source commune Analyse / PDF / Ishikawa
# ======================================================

def _analyse_risk_effect_definitions() -> Dict[str, Dict[str, Any]]:
    """Définitions communes des effets terrain.

    Cette structure est volontairement indépendante du rendu UI/PDF :
    le front, le rapport et les Ishikawa consomment les mêmes clés.
    """
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


def _analyse_risk_effect_level(score: Any, count: Any) -> str:
    """Niveau lisible du risque.

    Le niveau dépend du score de fragilité afin de rester cohérent avec
    la jauge PDF. Le volume de causes sert à prioriser les détails, mais
    ne modifie pas seul le niveau affiché.
    """
    s = _safe_int(score, 0)
    if s >= 80:
        return "Risque critique"
    if s >= 65:
        return "Risque élevé"
    if s >= 35:
        return "Risque modéré"
    return "Risque faible"


def _analyse_risk_count_label(value: Any, singular: str, plural: str) -> str:
    n = _safe_int(value, 0)
    return f"{n} {singular if n == 1 else plural}"


def _analyse_risk_avg(records: List[Dict[str, Any]], fragile_only: bool = False) -> int:
    rows = [r for r in (records or []) if not fragile_only or _safe_int(r.get("indice_fragilite"), 0) > 0]
    return _analyse_fragility_average(rows)


def _analyse_risk_renfort_count(poste_record: Dict[str, Any], renfort_by_poste: Optional[Dict[str, Dict[str, Any]]] = None) -> int:
    if poste_record and poste_record.get("nb_renforts_immediats") is not None:
        return _safe_int(poste_record.get("nb_renforts_immediats"), 0)
    pid = str((poste_record or {}).get("id_poste") or "").strip()
    meta = (renfort_by_poste or {}).get(pid) or {}
    if meta.get("nb_renforts_immediats") is not None:
        return _safe_int(meta.get("nb_renforts_immediats"), 0)
    return _safe_int(meta.get("nb_renforts"), 0)


def _build_risk_synthesis_effects(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    horizon_years: int = 1,
    prevision_item: Optional[Dict[str, Any]] = None,
    renfort_by_poste: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Construit la synthèse des risques actuels depuis les records moteur.

    Cette synthèse est volontairement décorrélée des prévisions N+X :
    - les prévisions restent dans la tuile Prévisions ;
    - la synthèse des risques sert à expliquer la situation actuelle ;
    - le rapport CODIR et les Ishikawa doivent raconter la même histoire.

    Les paramètres horizon_years et prevision_item sont conservés uniquement
    pour compatibilité avec les appels existants. Ils ne sont pas utilisés.
    """
    defs = _analyse_risk_effect_definitions()
    comps = list(comp_records or [])
    postes = list(poste_records or [])

    total_couv_abs = sum(1 for r in comps if _safe_int(r.get("nb_postes_couverture_absente"), 0) > 0)
    total_couv_ins = sum(1 for r in comps if _safe_int(r.get("nb_postes_niveau_insuffisant"), 0) > 0)
    total_couverture = sum(
        1
        for r in comps
        if _safe_int(r.get("nb_postes_couverture_absente"), 0) > 0
        or _safe_int(r.get("nb_postes_niveau_insuffisant"), 0) > 0
    )
    total_non_conf = sum(1 for r in comps if _safe_int(r.get("nb_postes_non_confirmee"), 0) > 0)
    total_dep = sum(1 for r in comps if _safe_int(r.get("nb_postes_dependance"), 0) > 0)
    total_expertise_abs = sum(1 for r in comps if _safe_int(r.get("nb_experts"), 0) <= 0)
    total_expertise_faible = sum(1 for r in comps if _safe_int(r.get("nb_experts_dispo", r.get("nb_experts")), 0) <= 1)

    postes_a_surveiller = sum(1 for r in postes if _safe_int(r.get("indice_fragilite"), 0) >= 35)
    postes_risque_fort = sum(1 for r in postes if _safe_int(r.get("indice_fragilite"), 0) >= 65 or bool(r.get("rupture")))
    postes_en_rupture = sum(1 for r in postes if bool(r.get("rupture")) or _safe_int(r.get("nb_titulaires"), 0) <= 0)
    total_renfort = sum(
        1
        for p in postes
        if _analyse_risk_renfort_count(p, renfort_by_poste) <= 0
        and _safe_int(p.get("indice_fragilite"), 0) >= 35
    )

    comp_frag_score = _analyse_risk_avg(comps, fragile_only=True)
    poste_frag_score = _analyse_risk_avg(postes, fragile_only=False)

    rupture_metric = f"{round(poste_frag_score)}% de fragilité moyenne des postes"
    if postes_risque_fort > 0:
        rupture_metric = _analyse_risk_count_label(postes_risque_fort, "poste à risque fort", "postes à risque fort")
    elif postes_a_surveiller > 0:
        rupture_metric = _analyse_risk_count_label(postes_a_surveiller, "poste à surveiller", "postes à surveiller")

    raw = [
        {
            "key": "rupture_activite",
            "count": total_couverture + total_renfort + postes_risque_fort + postes_en_rupture,
            "score": poste_frag_score,
            "metric": rupture_metric,
            "causes": [
                _analyse_risk_count_label(total_couverture, "compétence critique avec couverture insuffisante", "compétences critiques avec couverture insuffisante") if total_couverture else "couverture critique à vérifier",
                _analyse_risk_count_label(postes_risque_fort, "poste à risque fort", "postes à risque fort") if postes_risque_fort else _analyse_risk_count_label(postes_a_surveiller, "poste à surveiller", "postes à surveiller"),
                _analyse_risk_count_label(total_renfort, "poste sans renfort immédiat", "postes sans renfort immédiat") if total_renfort else "renfort immédiat à vérifier sur les postes sensibles",
                _analyse_risk_count_label(postes_en_rupture, "poste sans titulaire disponible", "postes sans titulaire disponible") if postes_en_rupture else "continuité opérationnelle à vérifier sur les postes les plus exposés",
            ],
        },
        {
            "key": "qualite_execution",
            "count": total_couv_ins + total_non_conf + total_couv_abs,
            "score": comp_frag_score,
            "metric": f"{round(comp_frag_score)}% de fragilité moyenne des compétences",
            "causes": [
                _analyse_risk_count_label(total_couv_ins, "écart de maîtrise à vérifier", "écarts de maîtrise à vérifier") if total_couv_ins else "écarts de maîtrise à vérifier",
                _analyse_risk_count_label(total_non_conf, "évaluation ou confirmation à reprendre", "évaluations ou confirmations à reprendre") if total_non_conf else "évaluations ou confirmations à reprendre",
                _analyse_risk_count_label(total_couv_abs, "niveau attendu non couvert", "niveaux attendus non couverts") if total_couv_abs else "niveaux attendus à confirmer",
                "qualité d’exécution à sécuriser sur les compétences les plus critiques",
            ],
        },
        {
            "key": "dependance_individuelle",
            "count": total_dep + total_expertise_faible + total_renfort,
            "score": max(comp_frag_score if total_dep or total_expertise_faible else 0, poste_frag_score if total_renfort else 0),
            "metric": _analyse_risk_count_label(total_dep, "compétence avec couverture concentrée", "compétences avec couverture concentrée"),
            "causes": [
                _analyse_risk_count_label(total_dep, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne") if total_dep else "dépendances individuelles à vérifier",
                _analyse_risk_count_label(total_expertise_faible, "compétence avec vivier interne limité", "compétences avec vivier interne limité") if total_expertise_faible else "vivier interne à surveiller",
                _analyse_risk_count_label(total_renfort, "poste sans renfort immédiat", "postes sans renfort immédiat") if total_renfort else "renfort immédiat à confirmer",
                "transmission à structurer sur les compétences clés",
            ],
        },
        {
            "key": "perte_savoir_faire",
            "count": total_expertise_abs + total_expertise_faible + total_dep,
            "score": comp_frag_score,
            "metric": _analyse_risk_count_label(total_expertise_faible, "compétence avec savoir-faire peu diffusé", "compétences avec savoir-faire peu diffusé"),
            "causes": [
                _analyse_risk_count_label(total_expertise_abs, "compétence sans expertise confirmée", "compétences sans expertise confirmée") if total_expertise_abs else "expertise confirmée à surveiller",
                _analyse_risk_count_label(total_expertise_faible, "compétence avec relève interne limitée", "compétences avec relève interne limitée") if total_expertise_faible else "relève interne à confirmer",
                _analyse_risk_count_label(total_dep, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne") if total_dep else "transmission à organiser sur les savoir-faire sensibles",
                "savoir-faire à sécuriser avant perte de maîtrise opérationnelle",
            ],
        },
    ]

    out: List[Dict[str, Any]] = []
    for item in raw:
        score = max(0, min(100, _safe_int(item.get("score"), 0)))
        count = max(0, _safe_int(item.get("count"), 0))
        if count <= 0 and score < 35:
            continue
        d = defs[item["key"]]
        level = _analyse_risk_effect_level(score, count)
        merged = {**item, **d, "score": score, "count": count, "riskScore": score, "riskCount": count, "level": level}
        out.append(merged)
    return out

def _build_risk_synthesis_rows_for_effect(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    last_eval_map: Optional[Dict[str, Optional[str]]],
    renfort_by_poste: Optional[Dict[str, Dict[str, Any]]],
    effet: str,
) -> List[Dict[str, Any]]:
    """Construit les lignes Ishikawa depuis les mêmes records moteur que les tableaux."""
    rows: List[Dict[str, Any]] = []
    eval_map = last_eval_map or {}
    effect_key = str(effet or "").strip()

    for r in comp_records or []:
        code = str(r.get("code") or "").strip() or "COMP"
        title = str(r.get("intitule") or "Compétence").strip()
        frag = _safe_int(r.get("indice_fragilite"), 0)
        n_abs = _safe_int(r.get("nb_postes_couverture_absente"), 0)
        n_ins = _safe_int(r.get("nb_postes_niveau_insuffisant"), 0)
        n_couverture = n_abs + n_ins
        n_dep = _safe_int(r.get("nb_postes_dependance"), 0)
        n_nc = _safe_int(r.get("nb_postes_non_confirmee"), 0)
        n_exp = _safe_int(r.get("nb_experts"), 0)
        n_exp_dispo = _safe_int(r.get("nb_experts_dispo"), 0)
        nb_impactes = max(1, _safe_int(r.get("nb_postes_impactes"), 0))
        nb_valides = _safe_int(r.get("nb_postes_valides"), 0)
        pct_cover = int(round((float(nb_valides) / float(nb_impactes)) * 100.0)) if nb_impactes > 0 else 0
        last_eval = eval_map.get(str(r.get("id_comp") or "").strip())
        last_eval_label = last_eval or "Jamais évaluée"

        if effect_key == "rupture_activite":
            if n_couverture > 0:
                rows.append({"family": "Niveau attendu non atteint", "type": "comp", "code": code, "title": title, "value": f"{pct_cover}%", "value_label": "Couverture", "sort": frag})
            if n_dep > 0:
                rows.append({"family": "Couverture trop dépendante d’une personne", "type": "comp", "code": code, "title": title, "value": "1 personne", "value_label": "Couverture confirmée", "sort": frag})
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
                rows.append({"family": "Porteur unique", "type": "comp", "code": code, "title": title, "value": "1 personne", "value_label": "Couverture confirmée", "sort": frag})
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
                rows.append({"family": "Relève interne à confirmer", "type": "comp", "code": code, "title": title, "value": "1 personne", "value_label": "Relève visible", "sort": frag})
            if n_exp <= 0 or n_dep > 0:
                rows.append({"family": "Transmission à organiser", "type": "comp", "code": code, "title": title, "value": "à organiser", "value_label": "Transmission", "sort": frag})
            if n_couverture > 0:
                rows.append({"family": "Compétences sensibles à anticiper", "type": "comp", "code": code, "title": title, "value": f"{pct_cover}%", "value_label": "Couverture", "sort": frag})
            if n_nc > 0:
                rows.append({"family": "Données à fiabiliser", "type": "comp", "code": code, "title": title, "value": last_eval_label, "value_label": "Dernière évaluation", "sort": frag})

    if effect_key in ("rupture_activite", "dependance_individuelle"):
        for p in poste_records or []:
            nb_renforts = _analyse_risk_renfort_count(p, renfort_by_poste)
            frag_p = _safe_int(p.get("indice_fragilite"), 0)
            if nb_renforts <= 0 and frag_p > 0:
                rows.append({
                    "family": "Renfort potentiel insuffisant",
                    "type": "poste",
                    "code": (p.get("codif_poste") or p.get("codif_client") or "POSTE").strip() or "POSTE",
                    "title": str(p.get("intitule_poste") or "Poste").strip(),
                    "value": str(nb_renforts),
                    "value_label": "Renforts immédiats",
                    "sort": frag_p,
                })

    if effect_key == "rupture_activite":
        for p in poste_records or []:
            frag_p = _safe_int(p.get("indice_fragilite"), 0)
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

    rows.sort(key=lambda x: (str(x.get("family") or ""), -_safe_int(x.get("sort"), 0), str(x.get("title") or "")))
    return rows

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

