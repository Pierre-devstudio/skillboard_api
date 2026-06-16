#!/usr/bin/env python3
# -*- coding: utf-8 -*-
'''
Patch ciblé - Analyse des compétences : vocabulaire utilisateur + Ishikawa graphique + rapport CODIR.
À exécuter depuis la racine du projet skillboard_api.
'''
from pathlib import Path
from datetime import datetime
import re
import shutil
import subprocess
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime('%Y%m%d_%H%M%S')
BACKUP_DIR = ROOT / '.patch_backups' / f'analyse_ishikawa_graphique_{STAMP}'

FILES = [
    ROOT / 'static' / 'menus' / 'skills_analyse.js',
    ROOT / 'unified_api' / 'app' / 'routers' / 'skills_portal_analyse.py',
]


def fail(msg: str):
    print(f'[ERREUR] {msg}')
    sys.exit(1)


def read(p: Path) -> str:
    if not p.exists():
        fail(f'Fichier introuvable : {p}')
    return p.read_text(encoding='utf-8')


def write(p: Path, s: str):
    p.write_text(s, encoding='utf-8', newline='\n')


def backup(p: Path):
    rel = p.relative_to(ROOT)
    dst = BACKUP_DIR / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dst)


def replace_between(src: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    a = src.find(start_marker)
    if a < 0:
        fail(f'Marqueur de début introuvable pour {label}')
    b = src.find(end_marker, a)
    if b < 0:
        fail(f'Marqueur de fin introuvable pour {label}')
    return src[:a] + replacement.rstrip() + '\n\n' + src[b:]


def patch_js():
    p = ROOT / 'static' / 'menus' / 'skills_analyse.js'
    s = read(p)
    backup(p)

    new_build = r'''  function buildAnalyseRiskEffects(data) {
    const t = data?.tiles || {};
    const r = t.risques || {};
    const p = t.previsions || {};
    const horizon = getPrevHorizon();
    const item = pickPrevHorizonItem(p, horizon) || null;
    const count = (value, singular, plural) => fmtAnalyseCount(Number(value || 0), singular, plural);

    const posteFrag = Number(r.postes_fragilite_globale || 0);
    const compFrag = Number(r.comp_fragilite_moyenne || 0);
    const postesFragiles = Number(r.postes_fragiles || 0);
    const sansPorteur = Number(r.comp_critiques_sans_porteur || 0);
    const porteurUnique = Number(r.comp_bus_factor_1 || 0);
    const sansRenfort = Number(r.comp_critiques_tombent_zero_auj || 0);
    const compFragiles = Number(r.comp_critiques_fragiles || 0);
    const sorties = Number(item?.sorties || 0);
    const compImpactees = Number(item?.comp_critiques_impactees || 0);
    const postesRouges = Number(item?.postes_rouges || 0);

    const effects = [];

    if (postesFragiles > 0 || sansPorteur > 0 || sansRenfort > 0) {
      effects.push({
        key: "rupture_activite",
        title: "Risque de rupture ou ralentissement d’activité",
        level: analyseRiskLevelLabel(Math.max(posteFrag, compFrag), postesFragiles + sansPorteur + sansRenfort),
        metric: count(postesFragiles, "poste fragile", "postes fragiles"),
        causesTitle: "Synthèse des causes identifiées",
        causes: compactCauseList([
          sansPorteur > 0 ? `${count(sansPorteur, "compétence critique sans personne confirmée", "compétences critiques sans personne confirmée")}` : "certaines compétences critiques restent sans couverture confirmée",
          sansRenfort > 0 ? `${count(sansRenfort, "compétence sans renfort immédiat", "compétences sans renfort immédiat")}` : "le renfort immédiat reste à vérifier sur certaines compétences",
          postesFragiles > 0 ? `${count(postesFragiles, "poste déjà fragilisé", "postes déjà fragilisés")}` : "les postes sensibles sont à vérifier dans le détail",
          porteurUnique > 0 ? `${count(porteurUnique, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne")}` : "certaines couvertures peuvent dépendre de trop peu de personnes"
        ])
      });
    }

    if (compFrag > 0 || compFragiles > 0) {
      effects.push({
        key: "qualite_execution",
        title: "Risque de baisse de qualité d’exécution",
        level: analyseRiskLevelLabel(compFrag, compFragiles),
        metric: `${Math.round(compFrag)}% de fragilité moyenne des compétences`,
        causesTitle: "Synthèse des causes identifiées",
        causes: compactCauseList([
          compFragiles > 0 ? `${count(compFragiles, "compétence critique avec maîtrise fragile", "compétences critiques avec maîtrise fragile")}` : "des écarts de maîtrise restent à vérifier",
          "certains niveaux attendus ne sont pas suffisamment couverts",
          "certaines compétences doivent encore être confirmées",
          sansPorteur > 0 ? `${count(sansPorteur, "compétence critique sans personne confirmée", "compétences critiques sans personne confirmée")}` : "la maîtrise réelle doit être vérifiée sur les situations complexes"
        ])
      });
    }

    if (porteurUnique > 0) {
      effects.push({
        key: "dependance_individuelle",
        title: "Risque de dépendance individuelle",
        level: analyseRiskLevelLabel(Math.max(posteFrag, compFrag), porteurUnique),
        metric: count(porteurUnique, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne"),
        causesTitle: "Synthèse des causes identifiées",
        causes: compactCauseList([
          `${count(porteurUnique, "compétence critique avec une seule personne confirmée", "compétences critiques avec une seule personne confirmée")}`,
          "la couverture repose sur trop peu de collaborateurs",
          "les doublures ne sont pas assez visibles",
          "la transmission doit être vérifiée sur les compétences clés"
        ])
      });
    }

    if (sorties > 0 || compImpactees > 0 || postesRouges > 0) {
      effects.push({
        key: "perte_savoir_faire",
        title: "Risque de perte de savoir-faire",
        level: analyseRiskLevelLabel(postesRouges * 20 + compImpactees * 10, sorties + compImpactees + postesRouges),
        metric: `${count(postesRouges, "poste fragilisé", "postes fragilisés")} à ${analyseHorizonLabel(horizon)}`,
        causesTitle: "Synthèse des causes identifiées",
        causes: compactCauseList([
          sorties > 0 ? `${count(sorties, "sortie possible", "sorties possibles")} à ${analyseHorizonLabel(horizon)}` : "les sorties restent à surveiller selon l’horizon choisi",
          compImpactees > 0 ? `${count(compImpactees, "compétence critique à anticiper", "compétences critiques à anticiper")}` : "les compétences critiques doivent être surveillées dans la durée",
          postesRouges > 0 ? `${count(postesRouges, "poste peut devenir très fragile", "postes peuvent devenir très fragiles")}` : "les postes à risque sont à vérifier dans la prévision",
          "la relève ou la transmission doit être préparée avant la perte effective de couverture"
        ])
      });
    }

    return effects;
  }'''
    s = replace_between(s, '  function buildAnalyseRiskEffects(data) {', '  function updateAnalyseProjectionSummary(previsions) {', new_build, 'buildAnalyseRiskEffects')
    s = s.replace('La synthèse regroupe les effets terrain et les causes probables détectées sur le périmètre', 'La synthèse regroupe les effets terrain détectés et leurs causes principales sur le périmètre')
    write(p, s)


NEW_EFFECT_DEFS = r'''def _analyse_effect_definitions() -> Dict[str, Dict[str, Any]]:
    # Familles adaptées à l'analyse des compétences : principe Ishikawa, sans reprendre le 5M industriel brut.
    return {
        "rupture_activite": {
            "title": "Risque de rupture ou ralentissement d’activité",
            "central_effect": "Une activité peut ralentir ou être bloquée si les compétences indispensables ne sont pas assez couvertes.",
            "families": [
                "Couverture actuelle",
                "Renfort disponible",
                "Dépendance individuelle",
                "Postes sensibles",
                "Données à confirmer",
            ],
        },
        "qualite_execution": {
            "title": "Risque de baisse de qualité d’exécution",
            "central_effect": "Le travail peut être réalisé avec trop peu d’autonomie, plus d’erreurs, plus de reprises ou des délais plus longs.",
            "families": [
                "Niveau de maîtrise",
                "Compétences à confirmer",
                "Exigence du poste",
                "Situations complexes",
                "Données à confirmer",
            ],
        },
        "dependance_individuelle": {
            "title": "Risque de dépendance individuelle",
            "central_effect": "L’entreprise dépend trop fortement d’une ou quelques personnes pour maintenir une compétence ou un poste.",
            "families": [
                "Savoir-faire concentré",
                "Absence de doublure",
                "Transmission insuffisante",
                "Organisation du poste",
                "Données à confirmer",
            ],
        },
        "perte_savoir_faire": {
            "title": "Risque de perte de savoir-faire",
            "central_effect": "Un savoir-faire utile peut disparaître progressivement faute de relève, de transmission ou de couverture complémentaire.",
            "families": [
                "Relève identifiée",
                "Transmission",
                "Renouvellement des compétences",
                "Horizon de sortie",
                "Données à confirmer",
            ],
        },
    }'''

NEW_EFFECT_METRICS = r'''def _analyse_build_effect_metrics(
    comp_records: List[Dict[str, Any]],
    poste_records: List[Dict[str, Any]],
    horizon_years: int,
) -> List[Dict[str, Any]]:
    defs = _analyse_effect_definitions()

    total_absente = sum(_analyse_pdf_safe_int(r.get("nb_postes_couverture_absente")) for r in comp_records)
    total_non_conf = sum(_analyse_pdf_safe_int(r.get("nb_postes_non_confirmee")) for r in comp_records)
    total_insuff = sum(_analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant")) for r in comp_records)
    total_dep = sum(_analyse_pdf_safe_int(r.get("nb_postes_dependance")) for r in comp_records)
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
            "count": total_absente + postes_fragiles,
            "score": max(poste_frag_score, comp_frag_score),
            "metric": f"{_analyse_pdf_count(postes_fragiles, 'poste fragile', 'postes fragiles')} • {_analyse_pdf_count(total_absente, 'compétence sans personne confirmée', 'compétences sans personne confirmée')}",
            "causes": [
                _analyse_pdf_count(total_absente, "compétence critique sans personne confirmée", "compétences critiques sans personne confirmée") if total_absente else "certaines couvertures critiques restent à vérifier",
                _analyse_pdf_count(postes_fragiles, "poste déjà fragilisé", "postes déjà fragilisés") if postes_fragiles else "les postes sensibles sont à vérifier dans le détail",
                _analyse_pdf_count(total_dep, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne") if total_dep else "pas de dépendance individuelle forte détectée",
            ],
        },
        {
            "key": "qualite_execution",
            "count": total_non_conf + total_insuff,
            "score": comp_frag_score,
            "metric": f"{_analyse_pdf_count(total_insuff, 'écart de maîtrise', 'écarts de maîtrise')} • {_analyse_pdf_count(total_non_conf, 'compétence à confirmer', 'compétences à confirmer')}",
            "causes": [
                _analyse_pdf_count(total_insuff, "compétence sous le niveau attendu", "compétences sous le niveau attendu") if total_insuff else "écarts de maîtrise limités ou non détectés",
                _analyse_pdf_count(total_non_conf, "compétence déclarée mais non confirmée", "compétences déclarées mais non confirmées") if total_non_conf else "compétences majoritairement confirmées",
                "certaines situations complexes peuvent demander un niveau supérieur",
            ],
        },
        {
            "key": "dependance_individuelle",
            "count": total_dep,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": _analyse_pdf_count(total_dep, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne"),
            "causes": [
                _analyse_pdf_count(total_dep, "compétence critique avec une seule personne confirmée", "compétences critiques avec une seule personne confirmée") if total_dep else "peu de dépendance individuelle détectée",
                "doublures ou relais internes à vérifier",
                "transmission à contrôler sur les compétences les plus critiques",
            ],
        },
        {
            "key": "perte_savoir_faire",
            "count": total_dep + total_absente,
            "score": max(comp_frag_score, poste_frag_score),
            "metric": f"Horizon {horizon_years} an(s) • {total_dep + total_absente} point(s) de relève ou transmission à surveiller",
            "causes": [
                _analyse_pdf_count(total_dep, "compétence avec une seule personne confirmée", "compétences avec une seule personne confirmée") if total_dep else "relève non critique dans les données actuelles",
                _analyse_pdf_count(total_absente, "compétence sans personne confirmée", "compétences sans personne confirmée") if total_absente else "compétences sans couverture confirmée limitées ou non détectées",
                "horizon à croiser avec les sorties et indisponibilités connues",
            ],
        },
    ]

    out = []
    for item in raw:
        d = defs[item["key"]]
        level = _analyse_effect_level(item["score"], item["count"])
        out.append({**item, **d, "level": level})
    return out'''

NEW_ROWS = r'''def _analyse_ishikawa_rows_for_effect(comp_records: List[Dict[str, Any]], effet: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for r in comp_records:
        comp_label = f"{r.get('code') or ''} - {r.get('intitule') or 'Compétence'}".strip(" -")
        frag = _analyse_pdf_safe_int(r.get("indice_fragilite"))
        if effet == "rupture_activite":
            n_abs = _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente"))
            n_dep = _analyse_pdf_safe_int(r.get("nb_postes_dependance"))
            n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
            if n_abs > 0:
                rows.append({"family": "Couverture actuelle", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_abs, 'poste sans personne confirmée', 'postes sans personne confirmée')}", "frag": frag})
                rows.append({"family": "Renfort disponible", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_abs, 'compétence sans renfort immédiat identifié', 'compétences sans renfort immédiat identifié')}", "frag": frag})
            if n_dep > 0:
                rows.append({"family": "Dépendance individuelle", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_dep, 'poste repose sur une seule personne', 'postes reposent sur une seule personne')}", "frag": frag})
            if frag > 0:
                rows.append({"family": "Postes sensibles", "comp": comp_label, "cause": f"Fragilité actuelle évaluée à {frag}%", "frag": frag})
            if n_nc > 0:
                rows.append({"family": "Données à confirmer", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_nc, 'couverture reste à confirmer', 'couvertures restent à confirmer')}", "frag": frag})
        elif effet == "qualite_execution":
            n_ins = _analyse_pdf_safe_int(r.get("nb_postes_niveau_insuffisant"))
            n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
            if n_ins > 0:
                rows.append({"family": "Niveau de maîtrise", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_ins, 'écart entre le niveau attendu et le niveau confirmé', 'écarts entre le niveau attendu et le niveau confirmé')}", "frag": frag})
                rows.append({"family": "Exigence du poste", "comp": comp_label, "cause": f"Le niveau requis reste insuffisant sur {_analyse_pdf_count(n_ins, 'rattachement', 'rattachements')}", "frag": frag})
            if n_nc > 0:
                rows.append({"family": "Compétences à confirmer", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_nc, 'compétence déclarée sans confirmation exploitable', 'compétences déclarées sans confirmation exploitable')}", "frag": frag})
                rows.append({"family": "Données à confirmer", "comp": comp_label, "cause": f"Évaluation ou confirmation à compléter sur {_analyse_pdf_count(n_nc, 'rattachement', 'rattachements')}", "frag": frag})
            if frag >= 50:
                rows.append({"family": "Situations complexes", "comp": comp_label, "cause": "La fragilité peut ressortir sur les cas difficiles ou urgents", "frag": frag})
        elif effet == "dependance_individuelle":
            n_dep = _analyse_pdf_safe_int(r.get("nb_postes_dependance"))
            n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
            if n_dep > 0:
                rows.append({"family": "Savoir-faire concentré", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_dep, 'poste avec une seule personne confirmée', 'postes avec une seule personne confirmée')}", "frag": frag})
                rows.append({"family": "Absence de doublure", "comp": comp_label, "cause": f"Aucune couverture complémentaire confirmée sur {_analyse_pdf_count(n_dep, 'rattachement', 'rattachements')}", "frag": frag})
                rows.append({"family": "Transmission insuffisante", "comp": comp_label, "cause": "La compétence doit être transmise ou doublée", "frag": frag})
            if frag > 0:
                rows.append({"family": "Organisation du poste", "comp": comp_label, "cause": f"Le poste reste sensible si la personne clé est absente", "frag": frag})
            if n_nc > 0:
                rows.append({"family": "Données à confirmer", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_nc, 'couverture potentielle à confirmer', 'couvertures potentielles à confirmer')}", "frag": frag})
        elif effet == "perte_savoir_faire":
            n_dep = _analyse_pdf_safe_int(r.get("nb_postes_dependance"))
            n_abs = _analyse_pdf_safe_int(r.get("nb_postes_couverture_absente"))
            n_nc = _analyse_pdf_safe_int(r.get("nb_postes_non_confirmee"))
            if n_dep > 0:
                rows.append({"family": "Relève identifiée", "comp": comp_label, "cause": f"Relève insuffisante sur {_analyse_pdf_count(n_dep, 'rattachement', 'rattachements')}", "frag": frag})
                rows.append({"family": "Transmission", "comp": comp_label, "cause": "Savoir-faire à transmettre avant perte de couverture", "frag": frag})
            if n_abs > 0:
                rows.append({"family": "Renouvellement des compétences", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_abs, 'compétence à reconstruire ou renforcer', 'compétences à reconstruire ou renforcer')}", "frag": frag})
            if frag > 0:
                rows.append({"family": "Horizon de sortie", "comp": comp_label, "cause": "Fragilité à croiser avec les sorties ou indisponibilités prévues", "frag": frag})
            if n_nc > 0:
                rows.append({"family": "Données à confirmer", "comp": comp_label, "cause": f"{_analyse_pdf_count(n_nc, 'couverture non confirmée peut masquer une relève', 'couvertures non confirmées peuvent masquer une relève')}", "frag": frag})
    rows.sort(key=lambda x: (-_analyse_pdf_safe_int(x.get("frag")), str(x.get("family") or ""), str(x.get("comp") or "")))
    return rows[:25]'''

NEW_HELPERS = r'''

def _analyse_pdf_short(v: Any, max_len: int = 70) -> str:
    s = str(v or "—").replace("\n", " ").strip()
    if len(s) <= max_len:
        return s
    return s[: max(1, max_len - 1)].rstrip() + "…"


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


def _analyse_ishikawa_visual(effect: Dict[str, Any], rows: List[Dict[str, Any]], metric: Dict[str, Any], width_mm: float = 270.0, height_mm: float = 122.0):
    from reportlab.graphics.shapes import Drawing, Line, Rect, String, Polygon
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    width = width_mm * mm
    height = height_mm * mm
    d = Drawing(width, height)
    red = colors.HexColor("#c1272d")
    text = colors.HexColor("#1f2937")
    muted = colors.HexColor("#6b7280")
    line = colors.HexColor("#cbd5e1")
    soft_red = colors.HexColor("#fff5f5")
    soft_gray = colors.HexColor("#f8fafc")

    center_y = height * 0.50
    spine_x1 = 24 * mm
    spine_x2 = width - 64 * mm
    effect_x = width - 60 * mm
    effect_y = center_y - 17 * mm
    effect_w = 56 * mm
    effect_h = 34 * mm

    d.add(Line(spine_x1, center_y, spine_x2, center_y, strokeColor=red, strokeWidth=1.8))
    d.add(Polygon([spine_x2, center_y, spine_x2 - 5 * mm, center_y + 3 * mm, spine_x2 - 5 * mm, center_y - 3 * mm], fillColor=red, strokeColor=red))
    d.add(Rect(effect_x, effect_y, effect_w, effect_h, rx=6, ry=6, strokeColor=red, fillColor=soft_red, strokeWidth=1))
    d.add(String(effect_x + 4 * mm, effect_y + 22 * mm, "Effet terrain", fontName="Helvetica-Bold", fontSize=8.5, fillColor=muted))
    d.add(String(effect_x + 4 * mm, effect_y + 14 * mm, _analyse_pdf_short(effect.get("title"), 42), fontName="Helvetica-Bold", fontSize=9.5, fillColor=text))
    d.add(String(effect_x + 4 * mm, effect_y + 6 * mm, _analyse_pdf_short(metric.get("level") or "Risque à qualifier", 42), fontName="Helvetica", fontSize=8, fillColor=red))

    grouped = _analyse_ishikawa_group_rows(rows, effect.get("families") or [])
    families = list(grouped.keys())[:5]
    xs = [45, 82, 119, 156, 193]
    for i, fam in enumerate(families):
        x = xs[i] * mm
        is_top = i % 2 == 0
        end_x = x - 20 * mm
        end_y = center_y + (38 * mm if is_top else -38 * mm)
        box_y = end_y + (2 * mm if is_top else -18 * mm)
        d.add(Line(x, center_y, end_x, end_y, strokeColor=line, strokeWidth=1.2))
        d.add(Rect(end_x - 20 * mm, box_y, 58 * mm, 17 * mm, rx=5, ry=5, strokeColor=colors.HexColor("#e5e7eb"), fillColor=soft_gray, strokeWidth=0.8))
        d.add(String(end_x - 17 * mm, box_y + 10 * mm, _analyse_pdf_short(fam, 34), fontName="Helvetica-Bold", fontSize=7.8, fillColor=text))
        cause_count = len(grouped.get(fam) or [])
        sample = grouped.get(fam, [{}])[0].get("cause") if cause_count else "Aucune cause isolée"
        d.add(String(end_x - 17 * mm, box_y + 4 * mm, f"{cause_count} cause(s) • {_analyse_pdf_short(sample, 36)}", fontName="Helvetica", fontSize=6.5, fillColor=muted))

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
'''

NEW_ISHIKAWA_ENDPOINT = r'''@router.get("/skills/analyse/ishikawa/{id_contact}")
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
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))

        rows = _analyse_ishikawa_rows_for_effect(comp_records, effect_key)
        metrics = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years))
        metric = next((m for m in metrics if m.get("key") == effect_key), None) or {}

        styles = build_pdf_styles()
        title_style = styles["title"]
        subtitle_style = styles["subtitle"]
        section_style = styles["section"]
        body_style = styles["body"]
        small_style = styles["small"]

        story = []
        story.append(Paragraph("Ishikawa - Analyse des compétences", title_style))
        story.append(Paragraph(_analyse_pdf_esc(f"{effect['title']} • {scope.nom_service} • Horizon {horizon_years} an(s)"), subtitle_style))
        story.append(make_spacer(3))

        top = Table([[ 
            Paragraph(_analyse_pdf_esc(effect["central_effect"]), body_style),
            _analyse_pdf_level_card(str(metric.get("level") or "Risque à qualifier"), styles, 34),
            _analyse_pdf_bar(_analyse_pdf_safe_int(metric.get("score")), 42),
        ]], colWidths=[178 * mm, 38 * mm, 46 * mm])
        top.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(top)
        story.append(make_spacer(4))

        story.append(Paragraph("Diagramme cause / effet", section_style))
        story.append(_analyse_ishikawa_visual(effect, rows, metric))

        story.append(PageBreak())
        story.append(Paragraph("Causes détaillées", title_style))
        story.append(Paragraph(_analyse_pdf_esc(f"{effect['title']} • {scope.nom_service}"), subtitle_style))
        story.append(make_spacer(4))
        if rows:
            cause_rows = [[Paragraph("Famille", small_style), Paragraph("Compétence", small_style), Paragraph("Cause détectée", small_style), Paragraph("Fragilité", small_style)]]
            for row in rows:
                cause_rows.append([
                    Paragraph(_analyse_pdf_esc(row.get("family")), body_style),
                    Paragraph(_analyse_pdf_esc(row.get("comp")), body_style),
                    Paragraph(_analyse_pdf_esc(row.get("cause")), body_style),
                    Paragraph(_analyse_pdf_esc(str(row.get("frag") or 0) + "%"), body_style),
                ])
            t2 = Table(cause_rows, colWidths=[48 * mm, 78 * mm, 110 * mm, 25 * mm], repeatRows=1)
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
            "header_right": scope.nom_service,
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
'''

NEW_REPORT_ENDPOINT = r'''@router.get("/skills/analyse/rapport/{id_contact}")
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
                scope, comp_records, poste_records = _analyse_build_context_data(cur, id_ent, id_service, int(criticite_min))

        effects = _analyse_build_effect_metrics(comp_records, poste_records, int(horizon_years))
        styles = build_pdf_styles()
        title_style = styles["title"]
        subtitle_style = styles["subtitle"]
        section_style = styles["section"]
        body_style = styles["body"]
        small_style = styles["small"]

        nb_postes = len(poste_records or [])
        nb_comps = len(comp_records or [])
        frag_postes = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in poste_records) / max(1, nb_postes))) if nb_postes else 0
        frag_comps = int(round(sum(_analyse_pdf_safe_int(r.get("indice_fragilite")) for r in comp_records) / max(1, nb_comps))) if nb_comps else 0
        effects_detected = sum(1 for e in effects if _analyse_pdf_safe_int(e.get("count")) > 0)

        story = []
        story.append(Paragraph("Rapport CODIR - Analyse des compétences", title_style))
        story.append(Paragraph(_analyse_pdf_esc(f"{scope.nom_service} • Criticité minimale {criticite_min} • Projection {horizon_years} an(s)"), subtitle_style))
        story.append(make_spacer(4))

        kpis = Table([[
            _analyse_pdf_stat_card("Postes analysés", str(nb_postes), "Périmètre lu", styles),
            _analyse_pdf_stat_card("Compétences analysées", str(nb_comps), "Criticité filtrée", styles),
            _analyse_pdf_stat_card("Effets terrain", str(effects_detected), "Risques détectés", styles),
            _analyse_pdf_stat_card("Fragilité postes", f"{frag_postes}%", "Moyenne du périmètre", styles),
        ]], colWidths=[66 * mm, 66 * mm, 66 * mm, 66 * mm])
        kpis.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(kpis)
        story.append(make_spacer(7))

        story.append(Paragraph("Lecture des effets terrain", section_style))
        effect_rows = [[Paragraph("Effet terrain", small_style), Paragraph("Niveau", small_style), Paragraph("Lecture", small_style), Paragraph("Indice", small_style)]]
        for e in effects:
            effect_rows.append([
                Paragraph(_analyse_pdf_esc(e.get("title")), body_style),
                _analyse_pdf_level_card(str(e.get("level") or "Risque à qualifier"), styles, 32),
                Paragraph(_analyse_pdf_esc(e.get("metric")), body_style),
                _analyse_pdf_bar(_analyse_pdf_safe_int(e.get("score")), 45),
            ])
        et = Table(effect_rows, colWidths=[74 * mm, 36 * mm, 108 * mm, 47 * mm], repeatRows=1)
        et.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(et)
        story.append(make_spacer(7))

        top_postes = sorted(poste_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:8]
        top_comps = sorted(comp_records or [], key=lambda r: -_analyse_pdf_safe_int(r.get("indice_fragilite")))[:8]
        split_rows = [[Paragraph("Postes les plus fragiles", section_style), Paragraph("Compétences les plus fragiles", section_style)]]
        left_rows = []
        for p in top_postes:
            label = f"{p.get('codif_poste') or p.get('codif_client') or ''} - {p.get('intitule_poste') or 'Poste'}".strip(" -")
            left_rows.append([Paragraph(_analyse_pdf_esc(_analyse_pdf_short(label, 42)), body_style), _analyse_pdf_bar(_analyse_pdf_safe_int(p.get("indice_fragilite")), 36)])
        if not left_rows:
            left_rows.append([Paragraph("Aucun poste fragile identifié.", body_style), Paragraph("—", body_style)])
        right_rows = []
        for c in top_comps:
            label = f"{c.get('code') or ''} - {c.get('intitule') or 'Compétence'}".strip(" -")
            right_rows.append([Paragraph(_analyse_pdf_esc(_analyse_pdf_short(label, 42)), body_style), _analyse_pdf_bar(_analyse_pdf_safe_int(c.get("indice_fragilite")), 36)])
        if not right_rows:
            right_rows.append([Paragraph("Aucune compétence fragile identifiée.", body_style), Paragraph("—", body_style)])
        lt = Table(left_rows, colWidths=[88 * mm, 38 * mm])
        rt = Table(right_rows, colWidths=[88 * mm, 38 * mm])
        for tbl in (lt, rt):
            tbl.setStyle(TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
        split_rows.append([lt, rt])
        split = Table(split_rows, colWidths=[132 * mm, 132 * mm])
        split.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(split)

        family_counts = _analyse_family_counts(comp_records, effects)[:10]
        story.append(PageBreak())
        story.append(Paragraph("Répartition des causes", title_style))
        story.append(Paragraph("Lecture regroupée par familles de causes détectées", subtitle_style))
        story.append(make_spacer(5))
        if family_counts:
            max_count = max(1, max(int(x.get("count") or 0) for x in family_counts))
            fam_rows = [[Paragraph("Famille de causes", small_style), Paragraph("Volume", small_style), Paragraph("Lecture visuelle", small_style)]]
            for row in family_counts:
                pct = int(round((int(row.get("count") or 0) / max_count) * 100))
                fam_rows.append([
                    Paragraph(_analyse_pdf_esc(row.get("family")), body_style),
                    Paragraph(str(row.get("count") or 0), body_style),
                    _analyse_pdf_bar(pct, 90),
                ])
            ft = Table(fam_rows, colWidths=[80 * mm, 24 * mm, 158 * mm], repeatRows=1)
            ft.setStyle(TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(ft)
        else:
            story.append(Paragraph("Aucune cause structurante détectée dans le périmètre.", body_style))

        for e in effects:
            rows = _analyse_ishikawa_rows_for_effect(comp_records, str(e.get("key") or ""))
            story.append(PageBreak())
            story.append(Paragraph(_analyse_pdf_esc(e.get("title")), title_style))
            story.append(Paragraph(_analyse_pdf_esc(f"{scope.nom_service} • {e.get('level') or 'Risque à qualifier'}"), subtitle_style))
            story.append(make_spacer(3))
            story.append(_analyse_ishikawa_visual(e, rows, e))
            story.append(make_spacer(4))
            detail_rows = [[Paragraph("Famille", small_style), Paragraph("Cause principale", small_style), Paragraph("Compétence", small_style), Paragraph("Fragilité", small_style)]]
            for row in rows[:10]:
                detail_rows.append([
                    Paragraph(_analyse_pdf_esc(row.get("family")), body_style),
                    Paragraph(_analyse_pdf_esc(row.get("cause")), body_style),
                    Paragraph(_analyse_pdf_esc(_analyse_pdf_short(row.get("comp"), 55)), body_style),
                    Paragraph(_analyse_pdf_esc(str(row.get("frag") or 0) + "%"), body_style),
                ])
            if len(detail_rows) == 1:
                detail_rows.append([Paragraph("—", body_style), Paragraph("Aucune cause détaillée isolée.", body_style), Paragraph("—", body_style), Paragraph("—", body_style)])
            dt = Table(detail_rows, colWidths=[54 * mm, 98 * mm, 88 * mm, 24 * mm], repeatRows=1)
            dt.setStyle(TableStyle([
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(dt)

        pdf = build_pdf_document(story, {
            "title": "Rapport Analyse des compétences",
            "footer_left": "Novoskill Insights • Rapport CODIR Analyse des compétences",
            "header_right": scope.nom_service,
        }, page_size=landscape(A4))
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": 'inline; filename="rapport_analyse_competences.pdf"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération rapport analyse: {e}")
'''


def replace_function(src: str, name: str, replacement: str) -> str:
    m = re.search(rf'^def {re.escape(name)}\(', src, flags=re.M)
    if not m:
        fail(f'Fonction introuvable : {name}')
    start = m.start()
    m2 = re.search(r'^def |^@router\.', src[m.end():], flags=re.M)
    if not m2:
        fail(f'Fin de fonction introuvable : {name}')
    end = m.end() + m2.start()
    return src[:start] + replacement.rstrip() + '\n\n' + src[end:]


def replace_router_block(src: str, route: str, replacement: str, next_route: str = None) -> str:
    start = src.find(route)
    if start < 0:
        fail(f'Route introuvable : {route}')
    if next_route:
        end = src.find(next_route, start + len(route))
        if end < 0:
            fail(f'Route suivante introuvable : {next_route}')
    else:
        m = re.search(r'^@router\.', src[start + len(route):], flags=re.M)
        if not m:
            # dernier bloc du fichier
            end = len(src)
        else:
            end = start + len(route) + m.start()
    return src[:start] + replacement.rstrip() + '\n\n' + src[end:]


def patch_py():
    p = ROOT / 'unified_api' / 'app' / 'routers' / 'skills_portal_analyse.py'
    s = read(p)
    backup(p)

    s = replace_function(s, '_analyse_effect_definitions', NEW_EFFECT_DEFS)
    s = replace_function(s, '_analyse_build_effect_metrics', NEW_EFFECT_METRICS)
    s = replace_function(s, '_analyse_ishikawa_rows_for_effect', NEW_ROWS)

    if '_analyse_ishikawa_visual' not in s:
        marker = 'def _analyse_build_context_data('
        idx = s.find(marker)
        if idx < 0:
            fail('Point d’insertion helpers PDF introuvable')
        s = s[:idx] + NEW_HELPERS.rstrip() + '\n\n' + s[idx:]
    else:
        # Remplace la zone helpers ajoutée par une version propre si le patch est relancé.
        start = s.find('def _analyse_pdf_short(')
        end = s.find('def _analyse_build_context_data(', start)
        if start >= 0 and end > start:
            s = s[:start] + NEW_HELPERS.rstrip() + '\n\n' + s[end:]

    s = replace_router_block(s, '@router.get("/skills/analyse/ishikawa/{id_contact}")', NEW_ISHIKAWA_ENDPOINT, '@router.get("/skills/analyse/rapport/{id_contact}")')
    s = replace_router_block(s, '@router.get("/skills/analyse/rapport/{id_contact}")', NEW_REPORT_ENDPOINT, None)
    write(p, s)


def run_check(cmd):
    try:
        res = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    except FileNotFoundError:
        print(f'[INFO] Commande non disponible, test ignoré : {cmd[0]}')
        return True
    if res.returncode != 0:
        print(f'[ERREUR] Test échoué : {" ".join(cmd)}')
        print(res.stdout)
        print(res.stderr)
        return False
    print(f'[OK] {" ".join(cmd)}')
    return True


def main():
    for f in FILES:
        if not f.exists():
            fail(f'Fichier requis introuvable : {f}')
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    patch_js()
    patch_py()
    ok = True
    ok = run_check([sys.executable, '-m', 'py_compile', 'unified_api/app/routers/skills_portal_analyse.py']) and ok
    ok = run_check(['node', '--check', 'static/menus/skills_analyse.js']) and ok
    if not ok:
        print(f'[ATTENTION] Patch appliqué mais un test a échoué. Sauvegardes : {BACKUP_DIR}')
        sys.exit(2)
    print('[OK] Patch Analyse risques / Ishikawa graphique appliqué.')
    print(f'[OK] Sauvegardes : {BACKUP_DIR}')


if __name__ == '__main__':
    main()
