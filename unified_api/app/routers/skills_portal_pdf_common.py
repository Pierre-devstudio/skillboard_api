import logging
import os
from io import BytesIO
from typing import Dict, List, Optional

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

    page_w, page_h = PDF_PAGE_SIZE
    left = PDF_MARGIN_LEFT
    right = page_w - PDF_MARGIN_RIGHT

    canvas.saveState()

    # Header commun : logo seul à gauche + trait fin
    # La marge haute pilote le début du corps.
    # Le header, lui, est positionné par ses propres constantes.
    header_line_y = page_h - PDF_HEADER_LINE_OFFSET
    logo_max_width = PDF_LOGO_MAX_WIDTH
    logo_max_height = PDF_LOGO_MAX_HEIGHT

    logo_path = _resolve_logo_path()
    if logo_path:
        try:
            img = ImageReader(logo_path)
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
            _log.exception("Erreur chargement logo PDF (%s): %s", logo_path, e)

    canvas.setStrokeColor(PDF_LINE)
    canvas.setLineWidth(0.6)
    canvas.line(left, header_line_y, right, header_line_y)

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


def build_pdf_document(story: List, meta: Optional[Dict[str, str]] = None) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=PDF_PAGE_SIZE,
        leftMargin=PDF_MARGIN_LEFT,
        rightMargin=PDF_MARGIN_RIGHT,
        topMargin=PDF_MARGIN_TOP,
        bottomMargin=PDF_MARGIN_BOTTOM,
        title=str((meta or {}).get("title") or "Novoskill PDF"),
        author="Novoskill",
    )
    doc._ns_meta = meta or {}
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