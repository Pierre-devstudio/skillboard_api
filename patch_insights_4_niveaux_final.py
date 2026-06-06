# -*- coding: utf-8 -*-
"""
Patch ciblé Insights - passage stabilisé 4 niveaux Novoskill.
Console ciblée : Insights uniquement + module PDF commun utilisé par Insights.
A exécuter à la racine du projet skillboard_api.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP_DIR = ROOT / ".patch_backups" / f"insights_4_niveaux_final_{STAMP}"

FILES = [
    "static/menus/skills_referentiel_competence.js",
    "static/menus/skills_analyse.js",
    "static/menus/skills_collaborateurs.js",
    "static/menus/skills_besoins_formations.js",
    "static/menus/skills_cartographie_competences.js",
    "static/menus/skills_simulations_rh.js",
    "unified_api/app/routers/skills_portal_referentiel_competence.py",
    "unified_api/app/routers/skills_portal_analyse.py",
    "unified_api/app/routers/skills_portal_collaborateurs.py",
    "unified_api/app/routers/skills_portal_pdf_common.py",
    "unified_api/app/routers/skills_portal_simulations.py",
]

changed: list[str] = []


def read_rel(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        raise FileNotFoundError(f"Fichier introuvable: {rel}")
    return p.read_text(encoding="utf-8")


def write_rel(rel: str, text: str, old: str) -> None:
    if text == old:
        return
    src = ROOT / rel
    dst = BACKUP_DIR / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        shutil.copy2(src, dst)
    src.write_text(text, encoding="utf-8", newline="")
    changed.append(rel)


def replace_once(text: str, old: str, new: str, label: str, mandatory: bool = False) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if mandatory:
        raise RuntimeError(f"Bloc non trouvé: {label}")
    return text


def replace_all(text: str, old: str, new: str) -> str:
    return text.replace(old, new)


def regex_replace(text: str, pattern: str, repl: str, label: str, mandatory: bool = False, flags: int = re.S) -> str:
    new, n = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
    if mandatory and n == 0:
        raise RuntimeError(f"Regex non trouvée: {label}")
    return new


def replace_between(text: str, start: str, end: str, new_block: str, label: str, mandatory: bool = True) -> str:
    i = text.find(start)
    if i < 0:
        if mandatory:
            raise RuntimeError(f"Début de bloc non trouvé: {label}")
        return text
    j = text.find(end, i + len(start))
    if j < 0:
        if mandatory:
            raise RuntimeError(f"Fin de bloc non trouvée: {label}")
        return text
    return text[:i] + new_block + text[j:]


# ---------------------------------------------------------------------------
# 1) Insights > Référentiel compétences - backend
# ---------------------------------------------------------------------------
def patch_ref_backend() -> None:
    rel = "unified_api/app/routers/skills_portal_referentiel_competence.py"
    old = read_rel(rel)
    s = old

    # Qualité compétence : les 4 descriptions doivent exister.
    s = replace_between(
        s,
        "def _compute_comp_qual_flags(row: Dict[str, Any]) -> Dict[str, Any]:",
        "def _count_postes_in_scope",
        '''def _compute_comp_qual_flags(row: Dict[str, Any]) -> Dict[str, Any]:\n    a = (row.get("niveaua") or "").strip()\n    b = (row.get("niveaub") or "").strip()\n    c = (row.get("niveauc") or "").strip()\n    d = (row.get("niveaud") or "").strip()\n    return {\n        "niveaux_complets": bool(a and b and c and d),\n        "grille_presente": row.get("grille_evaluation") is not None,\n    }\n\n\n''',
        "_compute_comp_qual_flags",
    )

    # SELECT liste et détail : ajouter c.niveaud juste après c.niveauc, sans doublon.
    s = s.replace("c.niveauc,\n                        c.grille_evaluation", "c.niveauc,\n                        c.niveaud,\n                        c.grille_evaluation")
    s = s.replace("c.niveauc,\n                        c.niveaud,\n                        c.niveaud,", "c.niveauc,\n                        c.niveaud,")

    # Réponse détail : exposer niveaud.
    s = s.replace(
        "niveauc=row.get(\"niveauc\"),\n                    grille_evaluation=row.get(\"grille_evaluation\"),",
        "niveauc=row.get(\"niveauc\"),\n                    niveaud=row.get(\"niveaud\"),\n                    grille_evaluation=row.get(\"grille_evaluation\"),",
    )
    s = s.replace("niveaud=row.get(\"niveaud\"),\n                    niveaud=row.get(\"niveaud\"),", "niveaud=row.get(\"niveaud\"),")

    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 2) Insights > Référentiel compétences - front
# ---------------------------------------------------------------------------
def patch_ref_front() -> None:
    rel = "static/menus/skills_referentiel_competence.js"
    old = read_rel(rel)
    s = old

    helper = '''\n  function levelBadgeHtml(value, title) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.badgeHtml(value, title || "Niveau de maîtrise");\n    const raw = (value ?? "").toString().trim();\n    const k = raw.toUpperCase();\n    const map = { A: ["Débutant", "sb-badge-niv-a"], B: ["Intermédiaire", "sb-badge-niv-b"], C: ["Avancé", "sb-badge-niv-c"], D: ["Expert", "sb-badge-niv-d"] };\n    const item = map[k];\n    if (!item) return `<span class="sb-badge sb-badge-niv">${escapeHtml(raw || "—")}</span>`;\n    return `<span class="sb-badge sb-badge-niv ${item[1]}" title="${escapeHtml(title || "Niveau de maîtrise")}">${escapeHtml(item[0])}</span>`;\n  }\n\n'''
    if "function levelBadgeHtml(value, title)" not in s:
        s = s.replace("  function renderPostesTable(postes, isCertif, baseValidite) {", helper + "  function renderPostesTable(postes, isCertif, baseValidite) {")

    # Niveau requis dans la table : badge libellé seul.
    s = s.replace(
        'const niv = escapeHtml(p.niveau_requis || "—");\n          const crit = renderCritBadge(p.poids_criticite);',
        'const niv = levelBadgeHtml(p.niveau_requis || "—", "Niveau requis");\n          const crit = renderCritBadge(p.poids_criticite);'
    )
    s = s.replace('<td class="col-center" style="white-space:nowrap;">${niv}</td>', '<td class="col-center" style="white-space:nowrap;">${niv}</td>')

    # Bloc niveaux détail compétence.
    s = regex_replace(
        s,
        r"    const levels = `\n      <div class=\"card\" style=\"padding:12px; margin:0;\">.*?      </div>\n    `;",
        '''    const levels = `\n      <div class="card" style="padding:12px; margin:0;">\n        <div class="card-title" style="margin-bottom:6px;">Niveaux</div>\n\n        <div class="ref-levels-table">\n          <div class="ref-level-row">\n            ${levelBadgeHtml("A", "Débutant")}\n            <div class="ref-level-text">${escapeHtml(c.niveaua || "—")}</div>\n          </div>\n\n          <div class="ref-level-row">\n            ${levelBadgeHtml("B", "Intermédiaire")}\n            <div class="ref-level-text">${escapeHtml(c.niveaub || "—")}</div>\n          </div>\n\n          <div class="ref-level-row">\n            ${levelBadgeHtml("C", "Avancé")}\n            <div class="ref-level-text">${escapeHtml(c.niveauc || "—")}</div>\n          </div>\n\n          <div class="ref-level-row">\n            ${levelBadgeHtml("D", "Expert")}\n            <div class="ref-level-text">${escapeHtml(c.niveaud || "—")}</div>\n          </div>\n        </div>\n      </div>\n    `;''',
        "bloc niveaux ref compétence",
        mandatory=True,
    )

    # Résumé min/max dans la liste : libellés propres, sans lettre.
    if "function levelLabelOnly(value)" not in s:
        s = s.replace(
            "  function niveauRequisCell(item) {",
            '''  function levelLabelOnly(value) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.label(value);\n    const k = (value ?? "").toString().trim().toUpperCase();\n    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[k]) || (value || "—");\n  }\n\n  function niveauRequisCell(item) {'''
        )
    s = s.replace('if (a && b && a !== b) return `${escapeHtml(a)} → ${escapeHtml(b)}`;\n    return escapeHtml(a || b);',
                  'if (a && b && a !== b) return `${escapeHtml(levelLabelOnly(a))} → ${escapeHtml(levelLabelOnly(b))}`;\n    return escapeHtml(levelLabelOnly(a || b));')

    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 3) PDF fiche compétence utilisé par Insights
# ---------------------------------------------------------------------------
def patch_pdf_common() -> None:
    rel = "unified_api/app/routers/skills_portal_pdf_common.py"
    old = read_rel(rel)
    s = old
    s = regex_replace(
        s,
        r"    level_rows = \[\n.*?\n    \]\n\n    crit_table = Table\(",
        '''    level_rows = [\n        [\n            Paragraph("Débutant", level_head_style),\n            Paragraph("Intermédiaire", level_head_style),\n            Paragraph("Avancé", level_head_style),\n            Paragraph("Expert", level_head_style),\n        ],\n        [\n            Paragraph(_pdf_comp_level_note_range("A"), level_note_style),\n            Paragraph(_pdf_comp_level_note_range("B"), level_note_style),\n            Paragraph(_pdf_comp_level_note_range("C"), level_note_style),\n            Paragraph(_pdf_comp_level_note_range("D"), level_note_style),\n        ],\n        [\n            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveaua"), 260) or "—"), level_body_style),\n            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveaub"), 260) or "—"), level_body_style),\n            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveauc"), 260) or "—"), level_body_style),\n            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveaud"), 260) or "—"), level_body_style),\n        ],\n    ]\n\n    crit_table = Table(''',
        "level_rows PDF",
        mandatory=True,
    )
    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 4) Analyse des compétences - backend : niveaux et modal risque
# ---------------------------------------------------------------------------
def patch_analyse_backend() -> None:
    rel = "unified_api/app/routers/skills_portal_analyse.py"
    old = read_rel(rel)
    s = old

    s = regex_replace(
        s,
        r"def _niveau_from_score\(score: Optional\[float\]\) -> Optional\[str\]:\n.*?\n\ndef _clamp_int",
        '''def _niveau_from_score(score: Optional[float]) -> Optional[str]:\n    if score is None:\n        return None\n    try:\n        x = float(score)\n    except Exception:\n        return None\n\n    # Score normalisé /24 -> 4 niveaux\n    if x <= 6.0:\n        return "A"\n    if x <= 12.0:\n        return "B"\n    if x <= 18.0:\n        return "C"\n    if x <= 24.0:\n        return "D"\n    return "D"\n\n\ndef _clamp_int''',
        "_niveau_from_score",
        mandatory=True,
    )

    s = regex_replace(
        s,
        r"def _niveau_rank\(v: Any\) -> int:\n.*?\n\ndef _score_structure_gap",
        '''def _niveau_rank(v: Any) -> int:\n    s = str(v or "").strip().lower()\n    s = (s.replace("é", "e").replace("è", "e").replace("ê", "e")\n           .replace("à", "a").replace("ç", "c"))\n    if s in ("a", "1", "initial", "debutant") or s.startswith("deb") or s.startswith("init"):\n        return 1\n    if s in ("b", "2", "intermediaire") or s.startswith("inter"):\n        return 2\n    if s in ("c", "3", "avance", "avancee") or s.startswith("avan"):\n        return 3\n    if s in ("d", "4", "expert") or s.startswith("exp"):\n        return 4\n    return 0\n\n\ndef _score_structure_gap''',
        "_niveau_rank",
        mandatory=True,
    )

    # Local helpers dans le détail compétence / risques.
    s = regex_replace(
        s,
        r"                def _niv_key\(v: Any\) -> str:\n.*?\n\s+def _niv_rank_local\(v: Any\) -> int:",
        '''                def _niv_key(v: Any) -> str:\n                    s = str(v or "").strip().upper()\n                    s = (\n                        s.replace("É", "E").replace("È", "E").replace("Ê", "E").replace("Ë", "E")\n                         .replace("À", "A").replace("Â", "A").replace("Ä", "A")\n                         .replace("Î", "I").replace("Ï", "I")\n                         .replace("Ô", "O").replace("Ö", "O")\n                         .replace("Û", "U").replace("Ü", "U")\n                         .replace("Ç", "C")\n                    )\n                    if not s:\n                        return ""\n                    if "-" in s:\n                        last = s.split("-")[-1].strip()\n                        if last in ("A", "B", "C", "D"):\n                            return last\n                    if s in ("A", "B", "C", "D"):\n                        return s\n                    if "EXPERT" in s:\n                        return "D"\n                    if "AVANCE" in s:\n                        return "C"\n                    if "INTER" in s:\n                        return "B"\n                    if "DEBUT" in s or "INITIAL" in s or "INIT" in s:\n                        return "A"\n                    return ""\n\n                def _niv_rank_local(v: Any) -> int:''',
        "_niv_key local",
        mandatory=False,
    )
    s = regex_replace(
        s,
        r"                def _niv_rank_local\(v: Any\) -> int:\n                    k = _niv_key\(v\)\n.*?\n\s+def _truthy",
        '''                def _niv_rank_local(v: Any) -> int:\n                    k = _niv_key(v)\n                    if k == "A":\n                        return 1\n                    if k == "B":\n                        return 2\n                    if k == "C":\n                        return 3\n                    if k == "D":\n                        return 4\n                    return 0\n\n                def _truthy''',
        "_niv_rank_local",
        mandatory=False,
    )

    s = s.replace('besoin = {"A": 0, "B": 0, "C": 0}', 'besoin = {"A": 0, "B": 0, "C": 0, "D": 0}')
    s = s.replace('porteurs_niv = {"A": 0, "B": 0, "C": 0}', 'porteurs_niv = {"A": 0, "B": 0, "C": 0, "D": 0}')
    s = regex_replace(
        s,
        r"                porteurs_ge = \{\n                    \"A\": porteurs_niv\[\"A\"\] \+ porteurs_niv\[\"B\"\] \+ porteurs_niv\[\"C\"\],\n                    \"B\": porteurs_niv\[\"B\"\] \+ porteurs_niv\[\"C\"\],\n                    \"C\": porteurs_niv\[\"C\"\],\n                \}",
        '''                porteurs_ge = {\n                    "A": porteurs_niv["A"] + porteurs_niv["B"] + porteurs_niv["C"] + porteurs_niv["D"],\n                    "B": porteurs_niv["B"] + porteurs_niv["C"] + porteurs_niv["D"],\n                    "C": porteurs_niv["C"] + porteurs_niv["D"],\n                    "D": porteurs_niv["D"],\n                }''',
        "porteurs_ge 4 niveaux",
        mandatory=False,
    )

    # Recalibrage générique des CASE SQL niveau_actuel / niveau_requis.
    s = s.replace("WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 3", "WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4")
    s = s.replace("WHEN ec.niveau_actuel ILIKE '%%avan%%' THEN 2", "WHEN ec.niveau_actuel ILIKE '%%avan%%' THEN 3")
    s = s.replace("WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 3", "WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2")
    s = s.replace("WHEN ec.niveau_actuel ILIKE '%%init%%' THEN 1", "WHEN ec.niveau_actuel ILIKE '%%init%%' THEN 1\n                            WHEN ec.niveau_actuel ILIKE '%%debut%%' THEN 1\n                            WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2")
    # Nettoyage doublons possibles
    s = s.replace("WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2\n                            WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2", "WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2")
    s = re.sub(r"(WHEN ec\.niveau_actuel ILIKE '%%debut%%' THEN 1\n\s*WHEN ec\.niveau_actuel ILIKE '%%inter%%' THEN 2\n\s*){2,}", "WHEN ec.niveau_actuel ILIKE '%%debut%%' THEN 1\n                            WHEN ec.niveau_actuel ILIKE '%%inter%%' THEN 2\n                            ", s)

    # Ajouter D dans les CASE existants si absent.
    s = s.replace("WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3", "WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4\n                              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' THEN 3")
    s = s.replace("WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'C' THEN 3", "WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'D' THEN 4\n                            WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'C' THEN 3")
    s = s.replace("WHEN UPPER(TRIM(r.niveau_requis)) = 'C' THEN 3", "WHEN UPPER(TRIM(r.niveau_requis)) = 'D' THEN 4\n                              WHEN UPPER(TRIM(r.niveau_requis)) = 'C' THEN 3")
    s = s.replace("WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'C' THEN 3", "WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'D' THEN 4\n                            WHEN UPPER(TRIM(COALESCE(cp.niveau_requis,''))) = 'C' THEN 3")
    # Nettoyage des doublons créés si le fichier contenait déjà D.
    s = re.sub(r"\n(\s*)WHEN UPPER\(TRIM\(ec\.niveau_actuel\)\) = 'D' THEN 4\n\s*WHEN ec\.niveau_actuel ILIKE '%%expert%%' THEN 4\n\s*WHEN UPPER\(TRIM\(ec\.niveau_actuel\)\) = 'D' THEN 4", r"\n\1WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' THEN 4\n\1WHEN ec.niveau_actuel ILIKE '%%expert%%' THEN 4", s)
    s = re.sub(r"\n(\s*)WHEN UPPER\(TRIM\(COALESCE\(ec\.niveau_actuel,''\)\)\) = 'D' THEN 4\n\s*WHEN UPPER\(TRIM\(COALESCE\(ec\.niveau_actuel,''\)\)\) = 'D' THEN 4", r"\n\1WHEN UPPER(TRIM(COALESCE(ec.niveau_actuel,''))) = 'D' THEN 4", s)
    # Les compteurs nb_experts doivent compter D uniquement dans le nouveau référentiel.
    s = s.replace(") >= 3", ") >= 4")

    # Supprime doublons D si patch relancé.
    s = re.sub(r"(WHEN UPPER\(TRIM\((?:COALESCE\()?ec\.niveau_actuel[^\n]*\)\) = 'D' THEN 4\n\s*){2,}", r"\1", s)
    s = re.sub(r"(WHEN UPPER\(TRIM\((?:COALESCE\()?r\.niveau_requis[^\n]*\)\) = 'D' THEN 4\n\s*){2,}", r"\1", s)
    s = re.sub(r"(WHEN UPPER\(TRIM\(COALESCE\(cp\.niveau_requis,''\)\)\) = 'D' THEN 4\n\s*){2,}", r"\1", s)

    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 5) Analyse des compétences - front
# ---------------------------------------------------------------------------
def patch_analyse_front() -> None:
    rel = "static/menus/skills_analyse.js"
    old = read_rel(rel)
    s = old

    helper = '''\n\n  function nsLevelCode(value) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.normalize(value);\n    const raw = (value ?? "").toString().trim();\n    if (!raw || raw === "—") return "";\n    const m = raw.toUpperCase().match(/\\b([ABCD])\\b/);\n    if (m && m[1]) return m[1];\n    const plain = raw.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();\n    if (plain === "1" || plain.includes("initial") || plain.includes("debut")) return "A";\n    if (plain === "2" || plain.includes("intermediaire")) return "B";\n    if (plain === "3" || plain.includes("avance")) return "C";\n    if (plain === "4" || plain.includes("expert")) return "D";\n    return "";\n  }\n\n  function nsLevelLabel(value) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.label(value);\n    const k = nsLevelCode(value);\n    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[k]) || ((value ?? "").toString().trim() || "—");\n  }\n\n  function nsLevelRank(value) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.rank(value);\n    return ({ A: 1, B: 2, C: 3, D: 4 }[nsLevelCode(value)]) || 0;\n  }\n\n  function nsLevelBadgeHtml(value, title) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.badgeHtml(value, title || "Niveau de maîtrise");\n    const k = nsLevelCode(value);\n    const cls = ({ A: "sb-badge-niv-a", B: "sb-badge-niv-b", C: "sb-badge-niv-c", D: "sb-badge-niv-d" }[k]) || "";\n    return `<span class="sb-badge sb-badge-niv ${cls}" title="${escapeHtml(title || "Niveau de maîtrise")}">${escapeHtml(nsLevelLabel(value))}</span>`;\n  }\n'''
    if "function nsLevelCode(value)" not in s:
        s = s.replace("  function escapeHtml(s) {\n    return (s ?? \"\").toString()\n      .replaceAll(\"&\", \"&amp;\")\n      .replaceAll(\"<\", \"&lt;\")\n      .replaceAll(\">\", \"&gt;\")\n      .replaceAll('\"', \"&quot;\");\n  }", "  function escapeHtml(s) {\n    return (s ?? \"\").toString()\n      .replaceAll(\"&\", \"&amp;\")\n      .replaceAll(\"<\", \"&lt;\")\n      .replaceAll(\">\", \"&gt;\")\n      .replaceAll('\"', \"&quot;\");\n  }" + helper)

    # Badges niveau initiaux
    s = regex_replace(
        s,
        r"  const nivBadgeHtml = \(niv\) => \{\n.*?\n  \};",
        '''  const nivBadgeHtml = (niv) => nsLevelBadgeHtml(niv, "Niveau de maîtrise");''',
        "nivBadgeHtml global",
        mandatory=False,
    )

    # Bloc local matching (ancienne lecture A/B/C).
    s = regex_replace(
        s,
        r"    // Niveaux A/B/C/D -> Initial / Avancé / Expert\n    function nivKey\(v\) \{.*?\n\s+function domainPill",
        '''    function nivKey(v) {\n      return nsLevelCode(v);\n    }\n\n    function nivLabel(v) {\n      return nsLevelLabel(v);\n    }\n\n    function nivBadgeHtml(v) {\n      return nsLevelBadgeHtml(v, "Niveau de maîtrise");\n    }\n\n    function domainPill''',
        "bloc local niv matching",
        mandatory=False,
    )

    # Bloc local dans renderAnalyseCompetenceDetail.
    s = regex_replace(
        s,
        r"    const nivKey = \(raw\) => \{\n.*?\n\s+const critBadgeHtml = \(v\) => \{",
        '''    const nivKey = (raw) => nsLevelCode(raw);\n    const nivRank = (k) => nsLevelRank(k);\n    const nivBadgeHtml = (raw) => nsLevelBadgeHtml(raw, "Niveau requis");\n\n    const critBadgeHtml = (v) => {''',
        "bloc niveaux renderAnalyseCompetenceDetail",
        mandatory=False,
    )

    s = regex_replace(
        s,
        r"  function mapNiveauActuelForDisplay\(raw\) \{\n.*?\n  \}",
        '''  function mapNiveauActuelForDisplay(raw) {\n    return nsLevelLabel(raw);\n  }''',
        "mapNiveauActuelForDisplay",
        mandatory=False,
    )

    s = regex_replace(
        s,
        r"    function mapNiveauActuel\(raw\) \{\n.*?\n    \}\n\n    const max = 8;",
        '''    function mapNiveauActuel(raw) {\n      return nsLevelLabel(raw);\n    }\n\n    const max = 8;''',
        "mapNiveauActuel renderPostePorteurs",
        mandatory=False,
    )

    # Fonctions rank dans le modal poste.
    s = regex_replace(
        s,
        r"  function nivReqToNum\(v\) \{\n.*?\n  \}\n\n  function nivActToNum",
        '''  function nivReqToNum(v) {\n    return nsLevelRank(v);\n  }\n\n  function nivActToNum''',
        "nivReqToNum",
        mandatory=False,
    )
    s = regex_replace(
        s,
        r"  function nivActToNum\(v\) \{\n.*?\n  \}\n\n  function getNbTotal",
        '''  function nivActToNum(v) {\n    return nsLevelRank(v);\n  }\n\n  function getNbTotal''',
        "nivActToNum",
        mandatory=False,
    )

    # Besoins/couverture 4 niveaux.
    s = s.replace("Math.max(0, (need.A - haveGe.A)) +\n      Math.max(0, (need.B - haveGe.B)) +\n      Math.max(0, (need.C - haveGe.C));",
                  "Math.max(0, (Number(need.A || 0) - Number(haveGe.A || 0))) +\n      Math.max(0, (Number(need.B || 0) - Number(haveGe.B || 0))) +\n      Math.max(0, (Number(need.C || 0) - Number(haveGe.C || 0))) +\n      Math.max(0, (Number(need.D || 0) - Number(haveGe.D || 0)));")
    s = regex_replace(
        s,
        r"    const depLabel = \(k\) => \(k === \"A\" \? \"Initial\" : k === \"B\" \? \"Avancé\" : k === \"C\" \? \"Expert\" : \"\"\);",
        '''    const depLabel = (k) => ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[k] || "");''',
        "depLabel",
        mandatory=False,
        flags=0,
    )
    s = s.replace('const depCandidates = ["C", "B", "A"]', 'const depCandidates = ["D", "C", "B", "A"]')
    s = s.replace('${coverRow("Initial", need.A, haveGe.A)}\n                ${coverRow("Avancé", need.B, haveGe.B)}\n                ${coverRow("Expert", need.C, haveGe.C)}',
                  '${coverRow("Débutant", Number(need.A || 0), Number(haveGe.A || 0))}\n                ${coverRow("Intermédiaire", Number(need.B || 0), Number(haveGe.B || 0))}\n                ${coverRow("Avancé", Number(need.C || 0), Number(haveGe.C || 0))}\n                ${coverRow("Expert", Number(need.D || 0), Number(haveGe.D || 0))}')

    # Anciennes lectures directes affichées.
    s = s.replace('const label = k === "A" ? "Initial" : k === "B" ? "Avancé" : "Expert";', 'const label = nsLevelLabel(k);')
    s = s.replace('const nr = escapeHtml((c.niveau_requis || "—").toString().trim() || "—");', 'const nr = nsLevelBadgeHtml(c.niveau_requis || "—", "Niveau requis");')
    s = s.replace('${escapeHtml(nr)}', '${nr}')

    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 6) Collaborateurs Insights : affichage niveaux + PDF compétence
# ---------------------------------------------------------------------------
def patch_collaborateurs() -> None:
    rel = "static/menus/skills_collaborateurs.js"
    old = read_rel(rel)
    s = old
    s = regex_replace(
        s,
        r"                const levelLabel = \(v\) => \{\n.*?\n                \};\n\n                const levelClass = \(v\) => \{\n.*?\n                \};",
        '''                const levelLabel = (v) => window.NovoskillLevels ? window.NovoskillLevels.label(v) : ((v || "–").toString());\n\n                const levelClass = (v) => window.NovoskillLevels ? window.NovoskillLevels.cssClass(v) : "";''',
        "levelLabel skills_collaborateurs",
        mandatory=False,
    )
    write_rel(rel, s, old)

    rel = "unified_api/app/routers/skills_portal_collaborateurs.py"
    old = read_rel(rel)
    s = old
    s = s.replace("c.niveauc,\n                        c.grille_evaluation", "c.niveauc,\n                        c.niveaud,\n                        c.grille_evaluation")
    s = s.replace("c.niveauc,\n                        c.niveaud,\n                        c.niveaud,", "c.niveauc,\n                        c.niveaud,")
    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# 7) Besoins, cartographie, simulations Insights : affichage/mapping niveaux
# ---------------------------------------------------------------------------
def patch_other_fronts_and_simu() -> None:
    rel = "static/menus/skills_besoins_formations.js"
    old = read_rel(rel)
    s = old
    s = regex_replace(
        s,
        r"  function levelLabel\(v\) \{\n.*?\n  \}",
        '''  function levelLabel(v) {\n    if (window.NovoskillLevels) return window.NovoskillLevels.label(v);\n    return v || "Non évalué";\n  }''',
        "levelLabel besoins formations",
        mandatory=False,
    )
    s = s.replace('${escapeHtml(item.niveau_requis || item.niveau_attendu || "—")}', '${escapeHtml(levelLabel(item.niveau_requis || item.niveau_attendu || "—"))}')
    write_rel(rel, s, old)

    rel = "static/menus/skills_cartographie_competences.js"
    old = read_rel(rel)
    s = old
    s = regex_replace(
        s,
        r"          function toNivRank\(v\) \{\n.*?\n          \}",
        '''          function toNivRank(v) {\n            if (window.NovoskillLevels) return window.NovoskillLevels.rank(v);\n            const s = (v ?? "").toString().trim().toUpperCase();\n            if (!s) return -1;\n            const c = s[0];\n            if (c === "A") return 1;\n            if (c === "B") return 2;\n            if (c === "C") return 3;\n            if (c === "D") return 4;\n            const m = s.match(/^\\d+/);\n            return m ? Number(m[0]) : -1;\n          }''',
        "toNivRank cartographie",
        mandatory=False,
    )
    s = s.replace('const niv = escapeHtml(c.niveau_requis || "—");', 'const niv = window.NovoskillLevels ? window.NovoskillLevels.badgeHtml(c.niveau_requis || "—", "Niveau requis") : escapeHtml(c.niveau_requis || "—");')
    write_rel(rel, s, old)

    rel = "static/menus/skills_simulations_rh.js"
    old = read_rel(rel)
    s = old
    s = s.replace('<option value="A">A - Initial</option><option value="B" selected>B - Avancé</option><option value="C">C - Expert</option>', '<option value="A">Débutant</option><option value="B" selected>Intermédiaire</option><option value="C">Avancé</option><option value="D">Expert</option>')
    write_rel(rel, s, old)

    rel = "unified_api/app/routers/skills_portal_simulations.py"
    old = read_rel(rel)
    s = old
    s = regex_replace(
        s,
        r"def _level_rank\(v: Any\) -> int:\n.*?\n\ndef _level_label",
        '''def _level_rank(v: Any) -> int:\n    s = str(v or "").strip().lower()\n    s = (s.replace("é", "e").replace("è", "e").replace("ê", "e")\n           .replace("à", "a").replace("ç", "c"))\n    if s in ("a", "1", "initial", "debutant") or s.startswith("deb") or s.startswith("init"):\n        return 1\n    if s in ("b", "2", "intermediaire") or s.startswith("inter"):\n        return 2\n    if s in ("c", "3", "avance", "avancee") or s.startswith("avan"):\n        return 3\n    if s in ("d", "4", "expert") or s.startswith("exp"):\n        return 4\n    return 0\n\n\ndef _level_label''',
        "_level_rank simulations",
        mandatory=False,
    )
    s = regex_replace(
        s,
        r"def _level_label\(v: Any\) -> str:\n.*?\n\ndef _safe_int",
        '''def _level_label(v: Any) -> str:\n    r = _level_rank(v)\n    return {1: "A", 2: "B", 3: "C", 4: "D"}.get(r, "—")\n\n\ndef _safe_int''',
        "_level_label simulations",
        mandatory=False,
    )
    write_rel(rel, s, old)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def run_checks() -> None:
    py_files = [
        "unified_api/app/routers/skills_portal_referentiel_competence.py",
        "unified_api/app/routers/skills_portal_analyse.py",
        "unified_api/app/routers/skills_portal_collaborateurs.py",
        "unified_api/app/routers/skills_portal_pdf_common.py",
        "unified_api/app/routers/skills_portal_simulations.py",
    ]
    js_files = [
        "static/menus/skills_referentiel_competence.js",
        "static/menus/skills_analyse.js",
        "static/menus/skills_collaborateurs.js",
        "static/menus/skills_besoins_formations.js",
        "static/menus/skills_cartographie_competences.js",
        "static/menus/skills_simulations_rh.js",
    ]

    for f in py_files:
        subprocess.run([sys.executable, "-m", "py_compile", str(ROOT / f)], check=True)

    node = shutil.which("node")
    if node:
        for f in js_files:
            subprocess.run([node, "--check", str(ROOT / f)], check=True)


def main() -> None:
    missing = [f for f in FILES if not (ROOT / f).exists()]
    if missing:
        raise SystemExit("Fichiers introuvables:\n" + "\n".join(missing))

    patch_ref_backend()
    patch_ref_front()
    patch_pdf_common()
    patch_analyse_backend()
    patch_analyse_front()
    patch_collaborateurs()
    patch_other_fronts_and_simu()
    run_checks()

    print("Patch Insights 4 niveaux appliqué.")
    if changed:
        print("Fichiers modifiés:")
        for f in changed:
            print(" -", f)
        print("Sauvegarde:", BACKUP_DIR)
    else:
        print("Aucune modification nécessaire.")


if __name__ == "__main__":
    main()
