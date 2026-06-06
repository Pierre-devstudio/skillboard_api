import json
import logging
import os
import re
from io import BytesIO
from typing import Any, Dict, List, Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

PDF_PAGE_SIZE = A4
PDF_MARGIN_LEFT = 10 * mm
PDF_MARGIN_RIGHT = 10 * mm
PDF_MARGIN_TOP = 18 * mm
PDF_MARGIN_BOTTOM = 10 * mm

PDF_BRAND_RED = colors.HexColor("#c1272d")
PDF_TEXT = colors.HexColor("#1f2937")
PDF_MUTED = colors.HexColor("#6b7280")
PDF_LINE = colors.HexColor("#e5e7eb")
PDF_TITLE_BG = colors.HexColor("#fff5f5")

_log = logging.getLogger("skills_pdf")

LOGO_FILENAME = "Logo_novoskill_marque.png"

PDF_HEADER_LINE_OFFSET = 14 * mm
PDF_LOGO_TOP_OFFSET = 6 * mm
PDF_LOGO_MAX_WIDTH = 52 * mm
PDF_LOGO_MAX_HEIGHT = 8 * mm

def _resolve_logo_path() -> str:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    logo_path = os.path.abspath(
        os.path.join(base_dir, "..", "assets", "pdf", LOGO_FILENAME)
    )

    if os.path.isfile(logo_path):
        return logo_path

    _log.error(
        "Logo PDF introuvable. Fichier attendu: %s | chemin testé: %s",
        LOGO_FILENAME,
        logo_path,
    )
    return ""

def _resolve_pdf_logo_image(meta: Optional[Dict[str, Any]]):
    raw = (meta or {}).get("logo_bytes")
    if raw:
        try:
            return ImageReader(BytesIO(bytes(raw)))
        except Exception as e:
            _log.exception("Erreur chargement logo owner PDF: %s", e)

    logo_path = _resolve_logo_path()
    if logo_path:
        try:
            return ImageReader(logo_path)
        except Exception as e:
            _log.exception("Erreur chargement logo PDF (%s): %s", logo_path, e)

    return None

def build_pdf_styles() -> Dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()

    styles = {
        "title": ParagraphStyle(
            "NsPdfTitle",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=17,
            leading=20,
            textColor=PDF_TEXT,
            spaceAfter=2,
        ),
        "subtitle": ParagraphStyle(
            "NsPdfSubtitle",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            textColor=PDF_MUTED,
            spaceAfter=6,
        ),
        "section": ParagraphStyle(
            "NsPdfSection",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=PDF_TEXT,
            spaceAfter=6,
            spaceBefore=0,
        ),
        "body": ParagraphStyle(
            "NsPdfBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=13,
            textColor=PDF_TEXT,
            spaceAfter=0,
        ),
        "small": ParagraphStyle(
            "NsPdfSmall",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=10,
            textColor=PDF_MUTED,
            spaceAfter=0,
        ),
        "meta_label": ParagraphStyle(
            "NsPdfMetaLabel",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=7.5,
            leading=9,
            textColor=PDF_MUTED,
            alignment=TA_LEFT,
            uppercase=True,
        ),
        "meta_value": ParagraphStyle(
            "NsPdfMetaValue",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=11,
            textColor=PDF_TEXT,
            alignment=TA_LEFT,
        ),
        "footer_left": ParagraphStyle(
            "NsPdfFooterLeft",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=9,
            textColor=PDF_MUTED,
            alignment=TA_LEFT,
        ),
        "footer_right": ParagraphStyle(
            "NsPdfFooterRight",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=9,
            textColor=PDF_MUTED,
            alignment=TA_RIGHT,
        ),
        "hero_caption": ParagraphStyle(
            "NsPdfHeroCaption",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            textColor=PDF_MUTED,
            alignment=TA_CENTER,
        ),
    }
    return styles


def _header_footer(canvas, doc):
    meta = getattr(doc, "_ns_meta", {}) or {}

    page_w, page_h = getattr(doc, "pagesize", PDF_PAGE_SIZE)
    left = PDF_MARGIN_LEFT
    right = page_w - PDF_MARGIN_RIGHT

    canvas.saveState()

    # Header commun : logo seul à gauche + trait fin
    # La marge haute pilote le début du corps.
    # Le header, lui, est positionné par ses propres constantes.
    header_line_y = page_h - PDF_HEADER_LINE_OFFSET
    logo_max_width = PDF_LOGO_MAX_WIDTH
    logo_max_height = PDF_LOGO_MAX_HEIGHT

    img = _resolve_pdf_logo_image(meta)
    if img is not None:
        try:
            img_w, img_h = img.getSize()

            if img_w and img_h:
                ratio = float(img_h) / float(img_w)
                logo_w = logo_max_width
                logo_h = logo_w * ratio

                if logo_h > logo_max_height:
                    logo_h = logo_max_height
                    logo_w = logo_h / ratio

                logo_x = left
                logo_y = page_h - PDF_LOGO_TOP_OFFSET - logo_h

                canvas.drawImage(
                    img,
                    logo_x,
                    logo_y,
                    width=logo_w,
                    height=logo_h,
                    preserveAspectRatio=True,
                    mask="auto",
                )
        except Exception as e:
            _log.exception("Erreur dessin logo PDF: %s", e)

    canvas.setStrokeColor(PDF_LINE)
    canvas.setLineWidth(0.6)
    canvas.line(left, header_line_y, right, header_line_y)

    header_right = str(meta.get("header_right") or "").strip()
    if header_right:
        header_right_font_name = str(meta.get("header_right_font_name") or "Helvetica").strip() or "Helvetica"
        try:
            header_right_font_size = float(meta.get("header_right_font_size") or 8.5)
        except Exception:
            header_right_font_size = 8.5

        canvas.setFillColor(PDF_MUTED)
        canvas.setFont(header_right_font_name, header_right_font_size)
        canvas.drawRightString(right, header_line_y + (2.2 * mm), header_right)

    # Footer dans la marge basse de 1 cm
    footer_line_y = PDF_MARGIN_BOTTOM
    footer_text_y = 4 * mm

    canvas.setStrokeColor(PDF_LINE)
    canvas.setLineWidth(0.6)
    canvas.line(left, footer_line_y, right, footer_line_y)

    canvas.setFillColor(PDF_MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(left, footer_text_y, str(meta.get("footer_left") or "Template PDF commun"))
    canvas.drawRightString(right, footer_text_y, f"Page {canvas.getPageNumber()}")

    canvas.restoreState()


def build_pdf_document(story: List, meta: Optional[Dict[str, Any]] = None, page_size=None) -> bytes:
    buffer = BytesIO()
    effective_page_size = page_size or PDF_PAGE_SIZE

    doc = SimpleDocTemplate(
        buffer,
        pagesize=effective_page_size,
        leftMargin=PDF_MARGIN_LEFT,
        rightMargin=PDF_MARGIN_RIGHT,
        topMargin=PDF_MARGIN_TOP,
        bottomMargin=PDF_MARGIN_BOTTOM,
        title=str((meta or {}).get("title") or "Novoskill PDF"),
        author="Novoskill",
    )
    doc._ns_meta = meta or {}
    doc.pagesize = effective_page_size
    doc.build(story, onFirstPage=_header_footer, onLaterPages=_header_footer)
    return buffer.getvalue()


def make_spacer(height_mm: float):
    return Spacer(1, height_mm * mm)


def make_title_block(title: str, subtitle: str, styles: Dict[str, ParagraphStyle]):
    return [
        Paragraph(title, styles["title"]),
        Paragraph(subtitle, styles["subtitle"]),
    ]


def make_meta_table(items: List[Dict[str, str]], styles: Dict[str, ParagraphStyle]):
    rows = []
    for item in items:
        rows.append([
            Paragraph(str(item.get("label") or ""), styles["meta_label"]),
            Paragraph(str(item.get("value") or ""), styles["meta_value"]),
        ])

    table = Table(rows, colWidths=[38 * mm, 50 * mm, 38 * mm, 50 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return table


def make_section_card(title: str, body_lines: List[str], styles: Dict[str, ParagraphStyle]):
    content = [Paragraph(title, styles["section"])]
    for line in body_lines:
        content.append(Paragraph(line, styles["body"]))
    content.append(make_spacer(1.5))

    table = Table([[content]], colWidths=[178 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.8, PDF_LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table

def _pdf_comp_json_like_to_obj(value):
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return {}
        try:
            return json.loads(s)
        except Exception:
            return {}
    return {}


def _pdf_comp_esc(v: Any) -> str:
    return str(v or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _pdf_comp_clean_text(v: Any) -> str:
    s = str(v or "").replace("\\x00", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _pdf_comp_truncate(v: Any, max_len: int) -> str:
    s = _pdf_comp_clean_text(v)
    if len(s) <= max_len:
        return s
    cut = s[:max_len].rsplit(" ", 1)[0].strip(" ,;:.-")
    return (cut or s[:max_len]).strip() + "…"


def _pdf_comp_level_note_range(level_code: str) -> str:
    code = str(level_code or "").strip().upper()
    if code == "A":
        return "Maîtrise < 41 %"
    if code == "B":
        return "Maîtrise entre 41 % et 75 %"
    if code == "C":
        return "Maîtrise > 75 %"
    return "Maîtrise -"


def build_competence_pdf_story(comp: dict) -> List:
    styles = build_pdf_styles()
    content_width = 210 * mm - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT

    title_style = ParagraphStyle(
        "NsPdfCompTitle",
        parent=styles["title"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=18,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    code_style = ParagraphStyle(
        "NsPdfCompCode",
        parent=styles["body"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=10.5,
        leading=12,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    skill_title_style = ParagraphStyle(
        "NsPdfCompSkillTitle",
        parent=styles["section"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=12.2,
        leading=14.4,
        textColor=PDF_BRAND_RED,
        spaceAfter=0,
    )
    desc_style = ParagraphStyle(
        "NsPdfCompDesc",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=9,
        leading=11.5,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    domain_style = ParagraphStyle(
        "NsPdfCompDomain",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=9,
        leading=11.5,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    section_style = ParagraphStyle(
        "NsPdfCompSection",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11.2,
        leading=13,
        textColor=PDF_BRAND_RED,
        spaceAfter=0,
    )
    table_head_style = ParagraphStyle(
        "NsPdfCompTableHead",
        parent=styles["small"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=7.8,
        leading=9,
        textColor=colors.white,
        spaceAfter=0,
    )
    crit_name_style = ParagraphStyle(
        "NsPdfCompCritName",
        parent=styles["body"],
        fontName="Helvetica-Bold",
        fontSize=7.8,
        leading=9.1,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    crit_cell_style = ParagraphStyle(
        "NsPdfCompCritCell",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=7.2,
        leading=8.2,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    level_head_style = ParagraphStyle(
        "NsPdfCompLevelHead",
        parent=styles["body"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=8.8,
        leading=10.2,
        textColor=colors.white,
        spaceAfter=0,
    )
    level_note_style = ParagraphStyle(
        "NsPdfCompLevelNote",
        parent=styles["small"],
        alignment=TA_CENTER,
        fontName="Helvetica",
        fontSize=8,
        leading=9.2,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    level_body_style = ParagraphStyle(
        "NsPdfCompLevelBody",
        parent=styles["body"],
        alignment=TA_CENTER,
        fontName="Helvetica",
        fontSize=8.2,
        leading=9.8,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )

    code = _pdf_comp_clean_text(comp.get("code")) or "—"
    intitule = _pdf_comp_clean_text(comp.get("intitule")) or "Compétence"
    description = _pdf_comp_truncate(comp.get("description"), 420) or "—"
    domaine_titre = _pdf_comp_clean_text(comp.get("domaine_titre") or comp.get("domaine")) or "—"

    grille = _pdf_comp_json_like_to_obj(comp.get("grille_evaluation"))
    crit_rows = []

    for idx in range(1, 5):
        node = grille.get(f"Critere{idx}") if isinstance(grille, dict) else {}
        node = node if isinstance(node, dict) else {}

        nom = _pdf_comp_truncate(node.get("Nom"), 90)
        evals = node.get("Eval") if isinstance(node.get("Eval"), list) else []
        evals = [
            Paragraph(
                _pdf_comp_esc(_pdf_comp_truncate(evals[i] if i < len(evals) else "", 130)),
                crit_cell_style,
            )
            for i in range(4)
        ]

        crit_rows.append([
            Paragraph(_pdf_comp_esc(nom or ""), crit_name_style),
            *evals,
        ])

    level_rows = [
        [
            Paragraph("Initial", level_head_style),
            Paragraph("Avancé", level_head_style),
            Paragraph("Expert", level_head_style),
        ],
        [
            Paragraph(_pdf_comp_level_note_range("A"), level_note_style),
            Paragraph(_pdf_comp_level_note_range("B"), level_note_style),
            Paragraph(_pdf_comp_level_note_range("C"), level_note_style),
        ],
        [
            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveaua"), 260) or "—"), level_body_style),
            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveaub"), 260) or "—"), level_body_style),
            Paragraph(_pdf_comp_esc(_pdf_comp_truncate(comp.get("niveauc"), 260) or "—"), level_body_style),
        ],
    ]

    crit_table = Table(
        [[
            Paragraph("", table_head_style),
            Paragraph("1", table_head_style),
            Paragraph("2", table_head_style),
            Paragraph("3", table_head_style),
            Paragraph("4", table_head_style),
        ]] + crit_rows,
        colWidths=[44 * mm, 36.5 * mm, 36.5 * mm, 36.5 * mm, 36.5 * mm],
        hAlign="LEFT",
    )
    crit_table.setStyle(TableStyle([
        ("BACKGROUND", (1, 0), (-1, 0), PDF_BRAND_RED),
        ("BACKGROUND", (0, 0), (0, 0), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, 0), 4),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, 1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 6),
    ]))

    level_table = Table(
        level_rows,
        colWidths=[content_width / 3.0, content_width / 3.0, content_width / 3.0],
        hAlign="LEFT",
    )
    level_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PDF_BRAND_RED),
        ("BOX", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING", (0, 1), (-1, 1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 4),
        ("TOPPADDING", (0, 2), (-1, 2), 8),
        ("BOTTOMPADDING", (0, 2), (-1, 2), 8),
    ]))

    story: List = []
    story.append(Paragraph("Définition de la compétence", title_style))
    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph(_pdf_comp_esc(code), code_style))
    story.append(Spacer(1, 1.5 * mm))
    story.append(Paragraph(_pdf_comp_esc(intitule), skill_title_style))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(_pdf_comp_esc(description), desc_style))
    story.append(Spacer(1, 6 * mm))
    story.append(
        Paragraph(
            f"Cette compétence est classée dans le domaine <b>{_pdf_comp_esc(domaine_titre)}</b> de votre référentiel.",
            domain_style,
        )
    )
    story.append(Spacer(1, 7 * mm))

    story.append(KeepTogether([
        Paragraph("Critères d'évaluation", section_style),
        Spacer(1, 4 * mm),
        crit_table,
    ]))

    story.append(Spacer(1, 6 * mm))

    story.append(KeepTogether([
        Paragraph("Niveaux de maîtrise", section_style),
        Spacer(1, 4 * mm),
        level_table,
    ]))

    return story

def build_fiche_poste_simple_story(enterprise_name: str, poste_ref: str) -> List:
    styles = build_pdf_styles()
    story: List = []

    story.extend(make_title_block(
        "Fiche de poste - template de validation",
        "Document orienté recrutement. Version visuelle sans données métier réelles.",
        styles,
    ))
    story.append(make_meta_table([
        {"label": "Entreprise", "value": enterprise_name or "Entreprise"},
        {"label": "Référence poste", "value": poste_ref or "POSTE_PLACEHOLDER"},
        {"label": "Usage", "value": "Préparation recrutement"},
        {"label": "Statut", "value": "Template sans données métier"},
    ], styles))
    story.append(make_spacer(3))

    hero = Table([[
        Paragraph(
            "Cette première page valide la structure de présentation du poste: définition, positionnement et périmètre.",
            styles["hero_caption"],
        )
    ]], colWidths=[178 * mm])
    hero.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PDF_TITLE_BG),
        ("BOX", (0, 0), (-1, -1), 0.8, PDF_BRAND_RED),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(hero)
    story.append(make_spacer(3))

    story.append(KeepTogether([
        make_section_card("1. Finalité du poste", [
            "[Placeholder] Résumer en quelques lignes la raison d’être du poste.",
            "[Placeholder] Positionner la contribution attendue dans l’organisation.",
        ], styles),
        make_spacer(2),
        make_section_card("2. Positionnement", [
            "[Placeholder] Rattachement hiérarchique, interactions clés, périmètre d’intervention.",
            "[Placeholder] Responsable direct, interlocuteurs internes, interlocuteurs externes.",
        ], styles),
        make_spacer(2),
        make_section_card("3. Missions principales", [
            "[Placeholder] Mission 1.",
            "[Placeholder] Mission 2.",
            "[Placeholder] Mission 3.",
        ], styles),
        make_spacer(2),
        make_section_card("4. Activités clés et livrables", [
            "[Placeholder] Activités structurantes du poste.",
            "[Placeholder] Résultats attendus / livrables.",
            "[Placeholder] Indicateurs ou points de vigilance.",
        ], styles),
    ]))

    story.append(make_spacer(4))
    story.append(make_section_card("5. Environnement de travail", [
        "[Placeholder] Horaires, contexte, outils, contraintes ou spécificités du poste.",
        "[Placeholder] Eléments utiles à un candidat pour comprendre le cadre d’exercice.",
    ], styles))

    story.append(PageBreak())

    story.extend(make_title_block(
        "Exigences du poste",
        "Cette deuxième page valide la structure de lecture des attendus et prérequis.",
        styles,
    ))
    story.append(make_meta_table([
        {"label": "Bloc", "value": "Exigences"},
        {"label": "Format", "value": "2 pages"},
        {"label": "Cible", "value": "Recrutement"},
        {"label": "Mode", "value": "Placeholders statiques"},
    ], styles))
    story.append(make_spacer(4))

    story.append(make_section_card("6. Compétences clés", [
        "[Placeholder] Compétence clé 1 - niveau attendu.",
        "[Placeholder] Compétence clé 2 - niveau attendu.",
        "[Placeholder] Compétence clé 3 - niveau attendu.",
        "[Placeholder] Compétence clé 4 - niveau attendu.",
    ], styles))
    story.append(make_spacer(4))

    story.append(make_section_card("7. Expérience et parcours attendus", [
        "[Placeholder] Années d’expérience, univers métier, contexte souhaité.",
        "[Placeholder] Type de parcours ou d’exposition attendu.",
    ], styles))
    story.append(make_spacer(4))

    story.append(make_section_card("8. Certifications / habilitations", [
        "[Placeholder] Certifications obligatoires.",
        "[Placeholder] Habilitations ou autorisations souhaitées.",
    ], styles))
    story.append(make_spacer(4))

    story.append(make_section_card("9. Conditions particulières", [
        "[Placeholder] Mobilité, horaires, déplacements, contraintes physiques ou organisationnelles.",
        "[Placeholder] Eléments distinctifs à expliciter au recrutement.",
    ], styles))
    story.append(make_spacer(4))

    story.append(make_section_card("10. Critères de réussite à 6-12 mois", [
        "[Placeholder] Résultat observable 1.",
        "[Placeholder] Résultat observable 2.",
        "[Placeholder] Résultat observable 3.",
    ], styles))

    return story