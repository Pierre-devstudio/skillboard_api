from fastapi import APIRouter, HTTPException, Request, Response, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List, Any
from psycopg.rows import dict_row
import uuid
import os
import json
import re
import unicodedata
import subprocess
import tempfile
from difflib import SequenceMatcher
from datetime import date as py_date, datetime
from io import BytesIO
from html.parser import HTMLParser

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, A3, A2, A1, A0, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle, PageBreak, KeepTogether, Image

from app.routers.skills_portal_common import get_conn
from app.routers.skills_portal_pdf_common import (
    PDF_HEADER_LINE_OFFSET,
    PDF_LOGO_MAX_HEIGHT,
    PDF_LOGO_MAX_WIDTH,
    PDF_LOGO_TOP_OFFSET,
    PDF_LINE,
    PDF_MARGIN_BOTTOM,
    PDF_MARGIN_LEFT,
    PDF_MARGIN_RIGHT,
    PDF_MARGIN_TOP,
    PDF_MUTED,
    PDF_TEXT,
    _resolve_logo_path,
    make_spacer,
    build_pdf_styles,
    make_title_block,
    make_meta_table,
    make_section_card,
    build_pdf_document,
)
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

try:
    from docx import Document as DocxDocument
except Exception:
    DocxDocument = None

try:
    from pypdf import PdfReader
except Exception:
    PdfReader = None

router = APIRouter()


# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def _require_owner_access(cur, u: dict, id_owner: str):
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = (u.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (email, oid),
    )
    ok = cur.fetchone()
    if not ok:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid




def _resolve_org_scope_ent(cur, oid: str, request: Request) -> str:
    scope_ent = (request.query_params.get("id_ent") or "").strip()
    if not scope_ent:
        return oid

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (scope_ent, oid),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="Structure de scope introuvable.")
    return scope_ent


def _resolve_poste_ent(cur, oid: str, id_poste: str) -> str:
    pid = (id_poste or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="id_poste manquant.")

    cur.execute(
        """
        SELECT id_ent
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
        LIMIT 1
        """,
        (pid, oid),
    )
    row = cur.fetchone() or {}
    ent = (row.get("id_ent") or "").strip()
    if not ent:
        raise HTTPException(status_code=404, detail="Poste introuvable.")
    return ent

def _service_exists_active(cur, id_ent: str, id_service: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_service),
    )
    return cur.fetchone() is not None

def _fetch_owner_logo_bytes(cur, oid: str) -> Optional[bytes]:
    cur.execute(
        """
        SELECT logo_bytes
        FROM public.tbl_studio_owner_logo
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY date_maj DESC, date_creation DESC
        LIMIT 1
        """,
        (oid,),
    )
    row = cur.fetchone() or {}
    raw = row.get("logo_bytes")
    if raw is None:
        return None
    try:
        return bytes(raw)
    except Exception:
        return raw

def _pdf_esc(v: Any) -> str:
    return str(v or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _fetch_org_chart_data(cur, oid: str) -> dict:
    owner = studio_fetch_owner(cur, oid) or {}

    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT
            s.id_service,
            s.id_ent,
            s.nom_service,
            s.id_service_parent,
            COALESCE(s.archive, FALSE) AS archive,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND s.id_service_parent IS NULL

          UNION ALL

          SELECT
            c.id_service,
            c.id_ent,
            c.nom_service,
            c.id_service_parent,
            COALESCE(c.archive, FALSE) AS archive,
            p.depth + 1 AS depth,
            (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p ON p.id_service = c.id_service_parent
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        )
        SELECT
          svc.id_service,
          svc.nom_service,
          svc.id_service_parent,
          svc.depth,

          (SELECT COUNT(1)
           FROM public.tbl_fiche_poste p
           WHERE p.id_ent = %s
             AND COALESCE(p.actif, TRUE) = TRUE
             AND p.id_service = svc.id_service
          ) AS nb_postes,

          (SELECT COUNT(1)
           FROM public.tbl_effectif_client e
           WHERE e.id_ent = %s
             AND COALESCE(e.archive, FALSE) = FALSE
             AND COALESCE(e.statut_actif, TRUE) = TRUE
             AND e.id_service = svc.id_service
          ) AS nb_collabs

        FROM svc
        ORDER BY svc.path
        """,
        (oid, oid, oid, oid),
    )
    service_rows = cur.fetchall() or []

    cur.execute(
        """
        SELECT
          p.id_poste,
          p.id_service,
          p.codif_poste,
          p.codif_client,
          p.intitule_poste,
          COALESCE(cnt.nb_collabs, 0)::int AS nb_collabs
        FROM public.tbl_fiche_poste p
        LEFT JOIN (
          SELECT
            e.id_poste_actuel AS id_poste,
            COUNT(1)::int AS nb_collabs
          FROM public.tbl_effectif_client e
          WHERE e.id_ent = %s
            AND COALESCE(e.archive, FALSE) = FALSE
            AND COALESCE(e.statut_actif, TRUE) = TRUE
            AND COALESCE(e.id_poste_actuel, '') <> ''
          GROUP BY e.id_poste_actuel
        ) cnt ON cnt.id_poste = p.id_poste
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND COALESCE(p.actif, TRUE) = TRUE
        ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
        """,
        (oid, oid, oid),
    )
    poste_rows = cur.fetchall() or []

    nodes = {}
    roots = []
    total_collabs = 0

    for r in service_rows:
        sid = (r.get("id_service") or "").strip()
        if not sid:
            continue

        node = {
            "id_service": sid,
            "nom_service": (r.get("nom_service") or "").strip() or "Service",
            "id_service_parent": (r.get("id_service_parent") or "").strip() or None,
            "depth": int(r.get("depth") or 0),
            "nb_postes": int(r.get("nb_postes") or 0),
            "nb_collabs": int(r.get("nb_collabs") or 0),
            "enfants": [],
            "postes": [],
        }
        nodes[sid] = node
        total_collabs += node["nb_collabs"]

    for sid, node in nodes.items():
        parent_id = (node.get("id_service_parent") or "").strip()
        if parent_id and parent_id in nodes:
            nodes[parent_id]["enfants"].append(node)
        else:
            roots.append(node)

    postes_non_lies = []
    total_postes = 0
    total_postes_non_lies = 0

    for r in poste_rows:
        code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip() or "—"
        poste = {
            "id_poste": r.get("id_poste"),
            "id_service": (r.get("id_service") or "").strip() or None,
            "code": code,
            "intitule": (r.get("intitule_poste") or "").strip(),
            "nb_collabs": int(r.get("nb_collabs") or 0),
        }
        total_postes += 1

        sid = (r.get("id_service") or "").strip()
        if sid and sid in nodes:
            nodes[sid]["postes"].append(poste)
        else:
            postes_non_lies.append(poste)
            total_postes_non_lies += 1

    owner_name = (
        (owner.get("nom_owner") or "").strip()
        or (owner.get("nom_ent") or "").strip()
        or (owner.get("email") or "").strip()
        or "Organisation"
    )

    return {
        "owner_name": owner_name,
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "stats": {
            "nb_services": len(nodes),
            "nb_postes": total_postes,
            "nb_postes_non_lies": total_postes_non_lies,
            "nb_collabs": total_collabs,
        },
        "services": roots,
        "postes_non_lies": postes_non_lies,
    }


def _org_chart_node_count(services: List[dict], postes_non_lies: Optional[List[dict]] = None) -> int:
    total = len(postes_non_lies or [])
    for svc in services or []:
        total += 1
        total += len(svc.get("postes") or [])
        total += _org_chart_node_count(svc.get("enfants") or [], [])
    return total


def _org_chart_max_depth(services: List[dict], depth: int = 0) -> int:
    max_depth = depth
    for svc in services or []:
        max_depth = max(max_depth, depth)
        max_depth = max(max_depth, _org_chart_max_depth(svc.get("enfants") or [], depth + 1))
    return max_depth


def _pick_org_chart_page(data: dict):
    node_count = _org_chart_node_count(data.get("services") or [], data.get("postes_non_lies") or [])
    max_depth = _org_chart_max_depth(data.get("services") or [], 0)

    if node_count <= 18 and max_depth <= 2:
        return landscape(A4), "A4 paysage"
    if node_count <= 40 and max_depth <= 3:
        return landscape(A3), "A3 paysage"
    if node_count <= 90 and max_depth <= 4:
        return landscape(A2), "A2 paysage"
    if node_count <= 160 and max_depth <= 5:
        return landscape(A1), "A1 paysage"
    return landscape(A0), "A0 paysage"


def _build_org_service_pdf_table(node: dict, styles: dict, content_width: float, depth: int):
    indent = min(max(depth, 0), 8) * (10 * mm)
    title = Paragraph(_pdf_esc(node.get("nom_service") or "Service"), styles["section"])
    meta = Paragraph(
        f"{int(node.get('nb_postes') or 0)} poste(s) · {int(node.get('nb_collabs') or 0)} collaborateur(s)",
        styles["small"],
    )

    table = Table([[[title, meta]]], colWidths=[content_width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#d1d5db")),
        ("LEFTPADDING", (0, 0), (-1, -1), 10 + indent),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def _build_org_poste_pdf_table(poste: dict, styles: dict, content_width: float, depth: int):
    indent = min(max(depth, 0), 9) * (10 * mm)
    code = _pdf_esc(poste.get("code") or "—")
    intitule = _pdf_esc(poste.get("intitule") or "")
    body = Paragraph(f"<b>{code}</b>&nbsp;&nbsp;&nbsp;{intitule}", styles["body"])
    meta = Paragraph(f"{int(poste.get('nb_collabs') or 0)} collaborateur(s)", styles["small"])

    table = Table([[[body, meta]]], colWidths=[content_width])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#e5e7eb")),
        ("LEFTPADDING", (0, 0), (-1, -1), 16 + indent),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def _append_org_chart_story(story: List, services: List[dict], styles: dict, content_width: float, depth: int = 0) -> None:
    for svc in services or []:
        story.append(_build_org_service_pdf_table(svc, styles, content_width, depth))
        story.append(make_spacer(1.5))

        for poste in (svc.get("postes") or []):
            story.append(_build_org_poste_pdf_table(poste, styles, content_width, depth + 1))
            story.append(make_spacer(1))

        _append_org_chart_story(story, svc.get("enfants") or [], styles, content_width, depth + 1)


def _build_org_chart_pdf_story(data: dict, page_label: str, page_size) -> List:
    styles = build_pdf_styles()
    stats = data.get("stats") or {}
    page_w, _page_h = page_size
    content_width = page_w - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT

    story: List = []
    story.extend(make_title_block(
        "Organigramme de l'organisation",
        f"{_pdf_esc(data.get('owner_name') or 'Organisation')} · Vue services / postes / effectifs par poste",
        styles,
    ))
    story.append(make_meta_table([
        {"label": "Services", "value": str(int(stats.get("nb_services") or 0))},
        {"label": "Postes", "value": str(int(stats.get("nb_postes") or 0))},
        {"label": "Collab.", "value": str(int(stats.get("nb_collabs") or 0))},
        {"label": "Format", "value": page_label},
    ], styles))
    story.append(make_spacer(3))

    _append_org_chart_story(story, data.get("services") or [], styles, content_width, 0)

    postes_non_lies = data.get("postes_non_lies") or []
    if postes_non_lies:
        story.append(make_spacer(2))
        bloc = {
            "nom_service": "Postes non liés",
            "nb_postes": len(postes_non_lies),
            "nb_collabs": sum(int(x.get("nb_collabs") or 0) for x in postes_non_lies),
        }
        story.append(_build_org_service_pdf_table(bloc, styles, content_width, 0))
        story.append(make_spacer(1.5))
        for poste in postes_non_lies:
            story.append(_build_org_poste_pdf_table(poste, styles, content_width, 1))
            story.append(make_spacer(1))

    return story

def _nsf_groupe_exists_active(cur, code: str) -> bool:
    c = (code or "").strip()
    if not c:
        return False
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_nsf_groupe
        WHERE code = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (c,),
    )
    return cur.fetchone() is not None

def _norm_service_id(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip()
    if not s or s in ("__all__", "__none__"):
        return None
    return s

def _norm_rh_statut(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    if not s:
        return "actif"
    allowed = {"actif", "a_pourvoir", "gele", "temporaire", "archive"}
    if s not in allowed:
        raise HTTPException(status_code=400, detail="statut_poste invalide.")
    return s


def _norm_rh_strategie(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    if not s:
        return "mixte"
    allowed = {"interne", "externe", "mixte"}
    if s not in allowed:
        raise HTTPException(status_code=400, detail="strategie_pourvoi invalide.")
    return s


def _norm_rh_nb_titulaires(v: Optional[int]) -> int:
    if v is None:
        return 1
    try:
        n = int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="nb_titulaires_cible invalide.")
    if n < 1:
        raise HTTPException(status_code=400, detail="nb_titulaires_cible doit être >= 1.")
    return n


def _norm_rh_criticite(v: Optional[int]) -> int:
    if v is None:
        return 2
    try:
        n = int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="criticite_poste invalide.")
    if n < 1 or n > 3:
        raise HTTPException(status_code=400, detail="criticite_poste doit être compris entre 1 et 3.")
    return n


def _norm_iso_date(v: Optional[str]) -> Optional[py_date]:
    s = (v or "").strip()
    if not s:
        return None
    try:
        return py_date.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Date invalide (format attendu YYYY-MM-DD).")


def _validate_rh_dates(date_debut_validite: Optional[py_date], date_fin_validite: Optional[py_date]) -> None:
    if date_debut_validite and date_fin_validite and date_fin_validite < date_debut_validite:
        raise HTTPException(status_code=400, detail="date_fin_validite doit être >= date_debut_validite.")

ORG_BOX_WIDTH = 58 * mm
ORG_COL_GAP = 14 * mm
ORG_NODE_GAP = 8 * mm
ORG_ROOT_GAP = 12 * mm
ORG_BOX_PAD_X = 4 * mm
ORG_BOX_PAD_Y = 4 * mm
ORG_BOX_ROW_GAP = 1.5 * mm
ORG_BOX_RADIUS = 3 * mm
ORG_TITLE_SPACE = 24 * mm


def _pdf_esc(v: Any) -> str:
    return str(v or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _org_sort_key(v: Any) -> str:
    return str(v or "").strip().lower()


def _draw_org_pdf_header_footer(c: canvas.Canvas, page_size, footer_left: str, logo_bytes: Optional[bytes] = None) -> None:
    page_w, page_h = page_size
    left = PDF_MARGIN_LEFT
    right = page_w - PDF_MARGIN_RIGHT

    header_line_y = page_h - PDF_HEADER_LINE_OFFSET

    img = None
    if logo_bytes:
        try:
            img = ImageReader(BytesIO(logo_bytes))
        except Exception:
            img = None

    if img is None:
        logo_path = _resolve_logo_path()
        if logo_path:
            try:
                img = ImageReader(logo_path)
            except Exception:
                img = None

    if img is not None:
        try:
            img_w, img_h = img.getSize()

            if img_w and img_h:
                ratio = float(img_h) / float(img_w)
                logo_w = PDF_LOGO_MAX_WIDTH
                logo_h = logo_w * ratio

                if logo_h > PDF_LOGO_MAX_HEIGHT:
                    logo_h = PDF_LOGO_MAX_HEIGHT
                    logo_w = logo_h / ratio

                logo_x = left
                logo_y = page_h - PDF_LOGO_TOP_OFFSET - logo_h

                c.drawImage(
                    img,
                    logo_x,
                    logo_y,
                    width=logo_w,
                    height=logo_h,
                    preserveAspectRatio=True,
                    mask="auto",
                )
        except Exception:
            pass

    c.setStrokeColor(PDF_LINE)
    c.setLineWidth(0.6)
    c.line(left, header_line_y, right, header_line_y)

    footer_line_y = PDF_MARGIN_BOTTOM
    footer_text_y = 4 * mm

    c.setStrokeColor(PDF_LINE)
    c.setLineWidth(0.6)
    c.line(left, footer_line_y, right, footer_line_y)

    c.setFillColor(PDF_MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(left, footer_text_y, footer_left or "Novoskill Studio")
    c.drawRightString(right, footer_text_y, "Page 1")


def _build_org_pdf_styles() -> dict:
    base = getSampleStyleSheet()

    return {
        "page_title": ParagraphStyle(
            "OrgPdfPageTitle",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=16,
            leading=18,
            textColor=PDF_TEXT,
            spaceAfter=0,
        ),
        "page_subtitle": ParagraphStyle(
            "OrgPdfPageSubtitle",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=11,
            textColor=PDF_MUTED,
            spaceAfter=0,
        ),
        "box_title": ParagraphStyle(
            "OrgPdfBoxTitle",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.2,
            leading=9.2,
            textColor=PDF_TEXT,
            spaceAfter=0,
        ),
        "box_meta": ParagraphStyle(
            "OrgPdfBoxMeta",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=6.7,
            leading=7.6,
            textColor=PDF_MUTED,
            spaceAfter=0,
        ),
        "box_poste": ParagraphStyle(
            "OrgPdfBoxPoste",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=6.4,
            leading=7.2,
            textColor=PDF_TEXT,
            spaceAfter=0,
        ),
        "empty": ParagraphStyle(
            "OrgPdfEmpty",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=13,
            textColor=PDF_MUTED,
            spaceAfter=0,
        ),
    }


def _fetch_organigramme_data(cur, oid: str, id_ent: str) -> dict:
    owner = studio_fetch_owner(cur, oid) or {}

    cur.execute(
        """
        SELECT nom_ent
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
        LIMIT 1
        """,
        (id_ent, oid),
    )
    ent_row = cur.fetchone() or {}

    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT
            s.id_service,
            s.id_ent,
            s.nom_service,
            s.id_service_parent,
            COALESCE(s.archive, FALSE) AS archive,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND s.id_service_parent IS NULL

          UNION ALL

          SELECT
            c.id_service,
            c.id_ent,
            c.nom_service,
            c.id_service_parent,
            COALESCE(c.archive, FALSE) AS archive,
            p.depth + 1 AS depth,
            (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p ON p.id_service = c.id_service_parent
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        )
        SELECT
          svc.id_service,
          svc.nom_service,
          svc.id_service_parent,
          svc.depth,
          (SELECT COUNT(1)
           FROM public.tbl_fiche_poste p
           WHERE p.id_ent = %s
             AND COALESCE(p.actif, TRUE) = TRUE
             AND p.id_service = svc.id_service
          ) AS nb_postes,
          (SELECT COUNT(1)
           FROM public.tbl_effectif_client e
           WHERE e.id_ent = %s
             AND COALESCE(e.archive, FALSE) = FALSE
             AND COALESCE(e.statut_actif, TRUE) = TRUE
             AND e.id_service = svc.id_service
          ) AS nb_collabs
        FROM svc
        ORDER BY svc.path
        """,
        (id_ent, id_ent, id_ent, id_ent),
    )
    service_rows = cur.fetchall() or []

    cur.execute(
        """
        SELECT COUNT(1)::int AS nb_collabs
        FROM public.tbl_effectif_client e
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
        """,
        (id_ent,),
    )
    rr_tot = cur.fetchone() or {}
    total_collabs = int(rr_tot.get("nb_collabs") or 0)

    cur.execute(
        """
        SELECT
          p.id_poste,
          p.id_service,
          COALESCE(NULLIF(BTRIM(p.codif_client), ''), NULLIF(BTRIM(p.codif_poste), ''), '—') AS code,
          COALESCE(p.intitule_poste, '') AS intitule_poste,
          COALESCE(cnt.nb_collabs, 0)::int AS nb_collabs
        FROM public.tbl_fiche_poste p
        LEFT JOIN (
          SELECT
            e.id_poste_actuel AS id_poste,
            COUNT(1)::int AS nb_collabs
          FROM public.tbl_effectif_client e
          WHERE e.id_ent = %s
            AND COALESCE(e.archive, FALSE) = FALSE
            AND COALESCE(e.statut_actif, TRUE) = TRUE
            AND COALESCE(e.id_poste_actuel, '') <> ''
          GROUP BY e.id_poste_actuel
        ) cnt ON cnt.id_poste = p.id_poste
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND COALESCE(p.actif, TRUE) = TRUE
        ORDER BY lower(COALESCE(NULLIF(BTRIM(p.codif_client), ''), NULLIF(BTRIM(p.codif_poste), ''), 'zzzz')), lower(COALESCE(p.intitule_poste, ''))
        """,
        (id_ent, oid, id_ent),
    )
    poste_rows = cur.fetchall() or []

    nodes = {}
    roots = []
    postes_non_lies = []

    for r in service_rows:
        sid = (r.get("id_service") or "").strip()
        if not sid:
            continue

        nodes[sid] = {
            "id_service": sid,
            "nom_service": (r.get("nom_service") or "").strip() or "Service",
            "id_service_parent": (r.get("id_service_parent") or "").strip() or None,
            "depth": int(r.get("depth") or 0),
            "nb_postes": int(r.get("nb_postes") or 0),
            "nb_collabs": int(r.get("nb_collabs") or 0),
            "enfants": [],
            "postes": [],
        }

    for sid, node in nodes.items():
        parent_id = (node.get("id_service_parent") or "").strip()
        if parent_id and parent_id in nodes:
            nodes[parent_id]["enfants"].append(node)
        else:
            roots.append(node)

    for r in poste_rows:
        poste = {
            "id_poste": r.get("id_poste"),
            "id_service": (r.get("id_service") or "").strip() or None,
            "code": (r.get("code") or "").strip() or "—",
            "intitule": (r.get("intitule_poste") or "").strip(),
            "nb_collabs": int(r.get("nb_collabs") or 0),
        }

        sid = (r.get("id_service") or "").strip()
        if sid and sid in nodes:
            nodes[sid]["postes"].append(poste)
        else:
            postes_non_lies.append(poste)

    def _sort_tree(items: List[dict]) -> None:
        items.sort(key=lambda x: _org_sort_key(x.get("nom_service")))
        for item in items:
            item["postes"] = sorted(
                item.get("postes") or [],
                key=lambda p: (_org_sort_key(p.get("code")), _org_sort_key(p.get("intitule"))),
            )
            _sort_tree(item.get("enfants") or [])

    _sort_tree(roots)
    postes_non_lies.sort(key=lambda p: (_org_sort_key(p.get("code")), _org_sort_key(p.get("intitule"))))

    owner_name = (
        (ent_row.get("nom_ent") or "").strip()
        or (owner.get("nom_owner") or "").strip()
        or (owner.get("nom_ent") or "").strip()
        or (owner.get("email") or "").strip()
        or "Organisation"
    )

    return {
        "owner_name": owner_name,
        "stats": {
            "nb_services": len(nodes),
            "nb_postes": len(poste_rows),
            "nb_postes_non_lies": len(postes_non_lies),
            "nb_collabs": total_collabs,
        },
        "services": roots,
        "postes_non_lies": postes_non_lies,
    }


def _build_chart_roots(data: dict) -> List[dict]:
    roots = list(data.get("services") or [])
    postes_non_lies = list(data.get("postes_non_lies") or [])

    if postes_non_lies:
        roots.append({
            "id_service": "__non_lie__",
            "nom_service": "Postes non liés",
            "id_service_parent": None,
            "depth": 0,
            "nb_postes": len(postes_non_lies),
            "nb_collabs": sum(int(x.get("nb_collabs") or 0) for x in postes_non_lies),
            "enfants": [],
            "postes": postes_non_lies,
        })

    return roots


def _prepare_org_nodes(nodes: List[dict], styles: dict, box_width: float) -> None:
    inner_w = max(box_width - (2 * ORG_BOX_PAD_X), 20 * mm)

    for node in nodes:
        rows = []

        p_title = Paragraph(_pdf_esc(node.get("nom_service") or "Service"), styles["box_title"])
        _w, h = p_title.wrap(inner_w, 10000)
        rows.append((p_title, h))

        p_meta = Paragraph(
            f"{int(node.get('nb_postes') or 0)} poste(s) · {int(node.get('nb_collabs') or 0)} collab.",
            styles["box_meta"],
        )
        _w, h = p_meta.wrap(inner_w, 10000)
        rows.append((p_meta, h))

        for poste in (node.get("postes") or []):
            txt = (
                f"<b>{_pdf_esc(poste.get('code') or '—')}</b> "
                f"{_pdf_esc(poste.get('intitule') or '')} "
                f"<font color='#6b7280'>({int(poste.get('nb_collabs') or 0)})</font>"
            )
            p_poste = Paragraph(txt, styles["box_poste"])
            _w, h = p_poste.wrap(inner_w, 10000)
            rows.append((p_poste, h))

        node["_box_rows"] = rows
        node["_box_height"] = max(
            16 * mm,
            (2 * ORG_BOX_PAD_Y)
            + sum(h for _p, h in rows)
            + (ORG_BOX_ROW_GAP * max(len(rows) - 1, 0))
        )

        _prepare_org_nodes(node.get("enfants") or [], styles, box_width)


def _compute_org_subtree_height(node: dict) -> float:
    children = node.get("enfants") or []
    child_total = 0.0

    if children:
        child_total = sum(_compute_org_subtree_height(child) for child in children)
        child_total += ORG_NODE_GAP * max(len(children) - 1, 0)

    node["_subtree_height"] = max(float(node.get("_box_height") or 0), child_total)
    return node["_subtree_height"]


def _layout_org_node(node: dict, depth: int, y_top: float) -> None:
    node["_depth"] = depth
    node["_x"] = depth * (ORG_BOX_WIDTH + ORG_COL_GAP)

    children = node.get("enfants") or []
    subtree_h = float(node.get("_subtree_height") or 0)

    if children:
        child_total = sum(float(ch.get("_subtree_height") or 0) for ch in children)
        child_total += ORG_NODE_GAP * max(len(children) - 1, 0)

        child_y_top = y_top + max((subtree_h - child_total) / 2.0, 0.0)
        for child in children:
            _layout_org_node(child, depth + 1, child_y_top)
            child_y_top += float(child.get("_subtree_height") or 0) + ORG_NODE_GAP

        child_centers = [float(ch.get("_y_center") or 0) for ch in children]
        y_center = (min(child_centers) + max(child_centers)) / 2.0

        half = float(node.get("_box_height") or 0) / 2.0
        y_center = max(y_top + half, min(y_top + subtree_h - half, y_center))
        node["_y_center"] = y_center
    else:
        node["_y_center"] = y_top + (subtree_h / 2.0)


def _layout_org_roots(roots: List[dict]) -> float:
    y_top = 0.0

    for root in roots:
        _compute_org_subtree_height(root)

    for idx, root in enumerate(roots):
        _layout_org_node(root, 0, y_top)
        y_top += float(root.get("_subtree_height") or 0)
        if idx < len(roots) - 1:
            y_top += ORG_ROOT_GAP

    return y_top

def _format_pdf_publication_date_fr(dt: Optional[datetime] = None) -> str:
    months = [
        "janvier", "février", "mars", "avril", "mai", "juin",
        "juillet", "août", "septembre", "octobre", "novembre", "décembre"
    ]
    d = dt or datetime.now()
    return f"{d.day:02d} {months[d.month - 1]} {d.year:04d}"

def _org_max_depth(nodes: List[dict], depth: int = 0) -> int:
    max_depth = depth
    for node in nodes:
        max_depth = max(max_depth, depth)
        max_depth = max(max_depth, _org_max_depth(node.get("enfants") or [], depth + 1))
    return max_depth


def _pick_org_page_size(chart_width: float, chart_height: float):
    candidates = [
        ("A4 paysage", landscape(A4)),
        ("A3 paysage", landscape(A3)),
        ("A2 paysage", landscape(A2)),
        ("A1 paysage", landscape(A1)),
        ("A0 paysage", landscape(A0)),
    ]

    for label, size in candidates:
        avail_w = size[0] - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT
        avail_h = size[1] - PDF_MARGIN_TOP - PDF_MARGIN_BOTTOM - ORG_TITLE_SPACE
        if chart_width <= avail_w and chart_height <= avail_h:
            return size, label

    return landscape(A0), "A0 paysage"


def _draw_org_node_recursive(c: canvas.Canvas, node: dict, chart_height: float) -> None:
    x = float(node.get("_x") or 0.0)
    box_h = float(node.get("_box_height") or 0.0)
    y_center = float(node.get("_y_center") or 0.0)
    y_bottom = chart_height - (y_center + (box_h / 2.0))

    for child in (node.get("enfants") or []):
        px = x + ORG_BOX_WIDTH
        py = chart_height - y_center

        cx = float(child.get("_x") or 0.0)
        cy = chart_height - float(child.get("_y_center") or 0.0)

        mid_x = px + (ORG_COL_GAP / 2.0)

        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.setLineWidth(0.8)
        c.line(px, py, mid_x, py)
        c.line(mid_x, py, mid_x, cy)
        c.line(mid_x, cy, cx, cy)

    c.setFillColor(colors.white)
    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    c.roundRect(x, y_bottom, ORG_BOX_WIDTH, box_h, ORG_BOX_RADIUS, stroke=1, fill=1)

    inner_x = x + ORG_BOX_PAD_X
    inner_w = ORG_BOX_WIDTH - (2 * ORG_BOX_PAD_X)
    cursor_y = y_bottom + box_h - ORG_BOX_PAD_Y

    rows = node.get("_box_rows") or []
    for idx, (para, _h_prepared) in enumerate(rows):
        _w, h = para.wrap(inner_w, 10000)
        para.drawOn(c, inner_x, cursor_y - h)
        cursor_y -= h
        if idx < len(rows) - 1:
            cursor_y -= ORG_BOX_ROW_GAP

    for child in (node.get("enfants") or []):
        _draw_org_node_recursive(c, child, chart_height)


def _build_organigramme_pdf(oid: str, data: dict, logo_bytes: Optional[bytes] = None) -> bytes:
    roots = _build_chart_roots(data)
    styles = _build_org_pdf_styles()

    if not roots:
        roots = []

    _prepare_org_nodes(roots, styles, ORG_BOX_WIDTH)
    chart_height = _layout_org_roots(roots) if roots else (20 * mm)
    max_depth = _org_max_depth(roots, 0) if roots else 0
    chart_width = ((max_depth + 1) * ORG_BOX_WIDTH) + (max_depth * ORG_COL_GAP)

    page_size, page_label = _pick_org_page_size(chart_width, chart_height)
    page_w, page_h = page_size

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=page_size)

    pdf_title = f"Organigramme - {data.get('owner_name') or 'Organisation'}"
    c.setTitle(pdf_title)
    c.setAuthor("Novoskill")
    c.setSubject("Organigramme")

    _draw_org_pdf_header_footer(c, page_size, "Novoskill Studio • Organigramme", logo_bytes)

    left = PDF_MARGIN_LEFT
    usable_w = page_w - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT

    subtitle_txt = (
        f"{_pdf_esc(data.get('owner_name') or 'Organisation')} · "
        f"Date de publication : {_format_pdf_publication_date_fr()}"
    )

    p_title = Paragraph("Organigramme de l'organisation", styles["page_title"])
    p_sub = Paragraph(subtitle_txt, styles["page_subtitle"])

    cursor_y = page_h - PDF_MARGIN_TOP
    _w, h_title = p_title.wrap(usable_w, 10000)
    p_title.drawOn(c, left, cursor_y - h_title)
    cursor_y -= h_title + (2 * mm)

    _w, h_sub = p_sub.wrap(usable_w, 10000)
    p_sub.drawOn(c, left, cursor_y - h_sub)
    cursor_y -= h_sub + (5 * mm)

    chart_top = cursor_y
    available_chart_h = chart_top - (PDF_MARGIN_BOTTOM + 6 * mm)
    available_chart_w = usable_w

    if roots:
        scale = min(
            available_chart_w / chart_width if chart_width > 0 else 1.0,
            available_chart_h / chart_height if chart_height > 0 else 1.0,
            1.0,
        )

        chart_draw_w = chart_width * scale
        chart_draw_h = chart_height * scale

        chart_left = left + max((available_chart_w - chart_draw_w) / 2.0, 0.0)
        chart_bottom = chart_top - chart_draw_h

        c.saveState()
        c.translate(chart_left, chart_bottom)
        c.scale(scale, scale)

        for root in roots:
            _draw_org_node_recursive(c, root, chart_height)

        c.restoreState()
    else:
        p_empty = Paragraph("Aucune donnée organisationnelle active à afficher.", styles["empty"])
        _w, h_empty = p_empty.wrap(usable_w, 10000)
        p_empty.drawOn(c, left, cursor_y - h_empty)

    c.showPage()
    c.save()
    return buffer.getvalue()

def _next_pt_code(cur, oid: str, id_ent: str) -> str:
    # Sérialise les créations pour une entreprise (évite doublons)
    lock_key = f"poste_code:{oid}:{id_ent}"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))

    cur.execute(
        """
        SELECT COALESCE(
          MAX( (regexp_match(p.codif_poste, '^PT([0-9]{4})$'))[1]::int ),
          0
        ) AS max_n
        FROM public.tbl_fiche_poste p
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND p.codif_poste ~ '^PT[0-9]{4}$'
        """,
        (oid, id_ent),
    )
    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1
    if nxt > 9999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (PT9999) pour cette entreprise.")
    return f"PT{nxt:04d}"


def _poste_exists(cur, oid: str, id_ent: str, id_poste: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
          AND id_ent = %s
        LIMIT 1
        """,
        (id_poste, oid, id_ent),
    )
    return cur.fetchone() is not None


def _poste_code_exists(cur, oid: str, id_ent: str, codif_poste: str, exclude_poste: Optional[str] = None) -> bool:
    code = (codif_poste or "").strip()
    if not code:
        return False

    if exclude_poste:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
              AND id_poste <> %s
            LIMIT 1
            """,
            (oid, id_ent, code, exclude_poste),
        )
    else:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
            LIMIT 1
            """,
            (oid, id_ent, code),
        )
    return cur.fetchone() is not None

def _clamp_0_10(v) -> int:
    try:
        n = int(v)
    except Exception:
        n = 0
    if n < 0:
        return 0
    if n > 10:
        return 10
    return n


def _calc_poids_criticite_100(freq_usage_0_10: int, impact_0_10: int, dependance_0_10: int) -> int:
    fu = _clamp_0_10(freq_usage_0_10)   # pondération /20 => *2
    im = _clamp_0_10(impact_0_10)       # pondération /50 => *5
    de = _clamp_0_10(dependance_0_10)   # pondération /30 => *3
    total = (fu * 2) + (im * 5) + (de * 3)
    if total < 0:
        total = 0
    if total > 100:
        total = 100
    return int(total)

def _clean_text(v: Optional[str]) -> str:
    if v is None:
        return ""
    return str(v).replace("\x00", "").strip()

def _clean_ai_comp_text(v: Optional[str], max_len: int = 280) -> str:
    s = _clean_text(v)
    if not s:
        return ""

    s = re.sub(r"https?://\S+", "", s, flags=re.I)
    s = re.sub(r"www\.\S+", "", s, flags=re.I)
    s = re.sub(r"\[[^\]]*\]", "", s)
    s = re.sub(r"\(([^)]*(?:utm_source|wikipedia|atlassian|source|sources?|réf\.?|reference|references)[^)]*)\)", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip(" -–•")
    s = re.sub(r"\s+([,.;:])", r"\1", s)

    if len(s) > max_len:
        s = s[:max_len].rsplit(" ", 1)[0].rstrip(" ,;:.") + "…"
    return s

def _next_comp_code(cur, oid: str) -> str:
    lock_key = f"comp_code:{oid}:CO"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))

    cur.execute(
        """
        SELECT COALESCE(
          MAX( (regexp_match(code, '^CO([0-9]{5})$'))[1]::int ),
          0
        ) AS max_n
        FROM public.tbl_competence
        WHERE id_owner = %s
          AND code ~ '^CO[0-9]{5}$'
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1
    if nxt > 99999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (CO99999).")
    return f"CO{nxt:05d}"

_ACTION_VERB_HINTS = {
    "animer", "administrer", "piloter", "conduire", "concevoir", "mettre",
    "gérer", "gerer", "utiliser", "réaliser", "realiser", "structurer",
    "déployer", "deployer", "définir", "definir", "coordonner", "produire",
    "élaborer", "elaborer", "organiser", "préparer", "preparer", "présenter",
    "presenter", "négocier", "negocier", "assurer", "contrôler", "controler",
    "auditer", "former", "accompagner", "développer", "developper", "optimiser",
    "exploiter", "installer", "maintenir", "paramétrer", "parametrer",
    "configurer", "superviser", "planifier", "mesurer", "évaluer", "evaluer",
    "vendre", "conseiller", "élaborer", "elaborer"
}


def _starts_with_action_verb(v: Optional[str]) -> bool:
    n = _norm_text_search(v)
    if not n:
        return False
    first = n.split(" ")[0]
    if first in _ACTION_VERB_HINTS:
        return True
    return len(first) >= 3 and first.endswith(("er", "ir", "re", "oir"))


def _extract_action_phrase(v: Optional[str], max_len: int = 140) -> str:
    s = _clean_ai_comp_text(v, max_len * 2)
    if not s:
        return ""
    s = re.sub(r"^(savoir|être capable de|etre capable de|capacité à|capacite a)\s+", "", s, flags=re.I)
    s = re.split(r"[.;:]", s)[0]
    s = re.split(r"\s+-\s+|,", s)[0]
    s = s.strip(" -–•")
    if len(s) > max_len:
        s = s[:max_len].rsplit(" ", 1)[0].rstrip(" ,;:.")
    return s.strip()


def _normalize_ai_comp_title(title: Optional[str], description: Optional[str]) -> str:
    t = _extract_action_phrase(title, 140)
    if _starts_with_action_verb(t):
        return t

    d = _extract_action_phrase(description, 140)
    if _starts_with_action_verb(d):
        return d

    return t or d


def _skill_focus_phrase(skill_title: Optional[str], fallback: str = "la pratique attendue") -> str:
    raw = _clean_ai_comp_text(skill_title, 160)
    if not raw:
        return fallback

    parts = [p for p in re.split(r"\s+", raw) if p]
    if parts and _starts_with_action_verb(parts[0]):
        parts = parts[1:]

    focus = " ".join(parts).strip(" -–•")
    return focus or fallback


def _build_ai_comp_description(title: Optional[str], description: Optional[str], why_needed: Optional[str], max_len: int = 320) -> str:
    desc = _clean_ai_comp_text(description, max_len * 2)
    why = _clean_ai_comp_text(why_needed, max_len * 2)
    action = _normalize_ai_comp_title(title, description) or _extract_action_phrase(title, 120) or "Mettre en œuvre la compétence"

    if desc:
        desc = re.sub(r"\s*;\s*", ". ", desc)
        desc = re.sub(r"\s{2,}", " ", desc).strip(" -–•")
        if desc and desc[-1] not in ".!?":
            desc += "."

    if not desc or len(desc.split()) < 9 or len(desc) < 65:
        desc = ""

    if desc and why and _similarity_score(desc, why) < 0.72 and len(desc) <= (max_len - 90):
        why_low = why[0].lower() + why[1:] if why else ""
        if why_low.endswith("."):
            why_low = why_low[:-1]
        if why_low:
            desc = f"{desc} Cette compétence vise à {why_low}."

    if not desc:
        if why:
            why_low = why[0].lower() + why[1:] if why else ""
            if why_low.endswith("."):
                why_low = why_low[:-1]
            desc = f"{action}. Cette compétence vise à {why_low}."
        else:
            desc = (
                f"{action}. Cette compétence permet de sécuriser la réalisation attendue, "
                "de fiabiliser les livrables et de traiter les écarts sur le périmètre du poste."
            )

    return _clean_ai_comp_text(desc, max_len)


def _level_fallback_text(skill_title: Optional[str], level_idx: int, max_len: int = 280) -> str:
    focus = _skill_focus_phrase(skill_title)

    templates = {
        1: f"Réalise {focus} sur un périmètre simple, avec trame, repères de contrôle et validation des points sensibles.",
        2: f"Réalise {focus} en autonomie sur les situations courantes, tient à jour les éléments attendus et signale les écarts utiles.",
        3: f"Pilote {focus} sur son périmètre, structure la démarche, sécurise les livrables et améliore les pratiques dans la durée.",
    }
    return _clean_ai_comp_text(templates.get(level_idx, templates[3]), max_len)


def _normalize_ai_level_text(v: Optional[str], skill_title: Optional[str], level_idx: int, max_len: int = 280) -> str:
    s = _clean_ai_comp_text(v, max_len * 2)
    if s:
        s = re.sub(r"\s*;\s*", ". ", s)
        s = re.sub(r"\s{2,}", " ", s).strip(" -–•")
        if s and s[-1] not in ".!?":
            s += "."

    words = [w for w in re.split(r"\s+", s) if w] if s else []
    if not s or len(words) < 9 or len(s) < 70:
        s = _level_fallback_text(skill_title, level_idx, max_len)

    return _clean_ai_comp_text(s, max_len)


def _default_ai_criteria_names(skill_title: Optional[str], description: Optional[str], target_count: int = 3) -> List[str]:
    t = _norm_text_search(f"{skill_title or ''} {description or ''}")

    if any(x in t for x in ("qualit", "audit", "conformit", "rnq", "preuve", "procedure")):
        names = [
            "Structuration du système et des preuves",
            "Pilotage des audits et traitement des écarts",
            "Fiabilisation et amélioration continue",
        ]
    elif any(x in t for x in ("formation", "pedagog", "session", "animation", "face a face", "apprenant")):
        names = [
            "Préparation de l'action de formation",
            "Animation adaptée au public et aux objectifs",
            "Évaluation, ajustement et amélioration du dispositif",
        ]
    elif any(x in t for x in ("maintenance", "infrastructure", "reseau", "systeme", "incident", "intervention", "support technique")):
        names = [
            "Préparation et sécurisation des interventions",
            "Réalisation technique et continuité de service",
            "Contrôle, fiabilisation et amélioration",
        ]
    elif any(x in t for x in ("pilot", "manager", "indicateur", "tableau de bord", "reporting", "plan d action", "coordination")):
        names = [
            "Structuration et pilotage du dispositif",
            "Coordination et maîtrise opérationnelle",
            "Contrôle, arbitrage et amélioration",
        ]
    else:
        names = [
            "Préparation et structuration de l'activité",
            "Réalisation et maîtrise opérationnelle",
            "Contrôle, fiabilisation et amélioration",
        ]

    return names[:max(1, min(target_count, len(names)))]


def _eval_fallback_text(crit_name: Optional[str], level_idx: int, skill_title: Optional[str] = None, max_len: int = 160) -> str:
    base = _clean_ai_comp_text(crit_name, 100) or _skill_focus_phrase(skill_title)
    base = base[0].lower() + base[1:] if base else "la pratique attendue"

    templates = {
        1: f"Réalise {base} sur des cas simples, avec trame, repères de contrôle et validation des points sensibles.",
        2: f"Réalise {base} en autonomie sur les situations courantes, tient à jour les éléments attendus et signale les écarts utiles.",
        3: f"Pilote {base} de façon autonome, structure la démarche, sécurise le résultat et traite les écarts avec méthode.",
        4: f"Optimise {base} sur son périmètre, arbitre les situations complexes et diffuse les bonnes pratiques.",
    }
    return _clean_ai_comp_text(templates.get(level_idx, templates[4]), max_len)


def _normalize_eval_text(
    v: Optional[str],
    max_len: int = 160,
    crit_name: Optional[str] = None,
    level_idx: int = 1,
    skill_title: Optional[str] = None,
) -> str:
    s = _clean_ai_comp_text(v, max_len * 2)
    if s:
        s = re.sub(r"^(la personne évaluée|la personne evaluee|la personne|l['’]évalué|l['’]evalue)\s+", "", s, flags=re.I)
        s = re.sub(r"^(est capable de|sait|peut)\s+", "", s, flags=re.I)
        s = re.sub(r"\s*;\s*", ". ", s)
        s = re.sub(r"\s{2,}", " ", s).strip(" -–•")
        if s and s[-1] not in ".!?":
            s += "."

    words = [w for w in re.split(r"\s+", s) if w] if s else []
    if not s or len(words) < 8 or len(s) < 55:
        s = _eval_fallback_text(crit_name, level_idx, skill_title, max_len)

    s = s[0].upper() + s[1:] if s else _eval_fallback_text(crit_name, level_idx, skill_title, max_len)
    if s[-1] not in ".!?":
        s += "."
    return _clean_ai_comp_text(s, max_len)


def _compact_ai_grille(
    ge: dict,
    freq_usage: int = 0,
    impact_resultat: int = 0,
    dependance: int = 0,
) -> dict:
    items = []
    seen = set()

    for i in range(1, 5):
        k = f"Critere{i}"
        node = ge.get(k) or {"Nom": "", "Eval": ["", "", "", ""]}
        nom = _clean_ai_comp_text(node.get("Nom"), 140)
        raw_evals = (node.get("Eval") or ["", "", "", ""])[:4]

        if not nom and not any(_clean_text(x) for x in raw_evals):
            continue

        if not nom:
            nom = "Mise en œuvre de la compétence"

        key = _norm_text_search(nom)
        if key in seen:
            continue
        seen.add(key)

        evals = [
            _normalize_eval_text(raw_evals[0] if len(raw_evals) > 0 else "", 120, nom, 1),
            _normalize_eval_text(raw_evals[1] if len(raw_evals) > 1 else "", 120, nom, 2),
            _normalize_eval_text(raw_evals[2] if len(raw_evals) > 2 else "", 120, nom, 3),
            _normalize_eval_text(raw_evals[3] if len(raw_evals) > 3 else "", 120, nom, 4),
        ]
        items.append({"Nom": nom, "Eval": evals})

    if not items:
        nom = "Mise en œuvre de la compétence"
        items.append({
            "Nom": nom,
            "Eval": [
                _eval_fallback_text(nom, 1),
                _eval_fallback_text(nom, 2),
                _eval_fallback_text(nom, 3),
                _eval_fallback_text(nom, 4),
            ]
        })

    # On conserve un maximum technique de 4 critères,
    # mais on compacte par défaut à 1-3 selon la portée réelle de la compétence.
    fu = _clamp_0_10(freq_usage)
    im = _clamp_0_10(impact_resultat)
    de = _clamp_0_10(dependance)
    score_total = fu + im + de
    score_max = max(fu, im, de)

    if len(items) > 1:
        if score_total <= 8 and score_max <= 4:
            target_count = 1
        elif score_total <= 18 and score_max <= 7:
            target_count = 2
        elif score_total <= 24:
            target_count = 3
        else:
            target_count = min(4, len(items))

        items = items[:max(1, min(target_count, len(items)))]

    out = {}
    for i in range(1, 5):
        if i <= len(items):
            out[f"Critere{i}"] = items[i - 1]
        else:
            out[f"Critere{i}"] = {"Nom": "", "Eval": ["", "", "", ""]}

    return out


def _normalize_ai_comp_item(item: dict) -> None:
    item["intitule"] = _normalize_ai_comp_title(item.get("intitule"), item.get("description"))
    item["description"] = _clean_ai_comp_text(item.get("description"), 240)
    item["why_needed"] = _clean_ai_comp_text(item.get("why_needed"), 240)
    item["niveaua"] = _clean_ai_comp_text(item.get("niveaua"), 230)
    item["niveaub"] = _clean_ai_comp_text(item.get("niveaub"), 230)
    item["niveauc"] = _clean_ai_comp_text(item.get("niveauc"), 230)

    _fix_abc_levels(item)

    ge = _sanitize_grille(item.get("grille_evaluation"))
    item["grille_evaluation"] = _compact_ai_grille(
        ge,
        item.get("freq_usage"),
        item.get("impact_resultat"),
        item.get("dependance"),
    )

def _level_score(txt: Optional[str]) -> int:
    t = _norm_text_search(txt)
    score = 0
    for w in ("optimis", "anticipe", "transmet", "forme", "expert", "référent", "referent", "complexe", "ameliore", "adapte", "concoit", "pilote"):
        if w in t:
            score += 3
    for w in ("autonome", "structure", "fiable", "standard", "applique", "met en oeuvre", "gere", "gère", "analyse", "coordonne", "maitrise", "maîtrise"):
        if w in t:
            score += 1
    for w in ("guid", "supervis", "avec aide", "assist", "simple", "consigne", "début", "debut"):
        if w in t:
            score -= 2
    return score


def _fix_abc_levels(data: dict) -> None:
    a = data.get("niveaua") or ""
    b = data.get("niveaub") or ""
    c = data.get("niveauc") or ""
    sa = _level_score(a)
    sb = _level_score(b)
    sc = _level_score(c)

    if sa > sc:
        levels = [("niveaua", a, sa), ("niveaub", b, sb), ("niveauc", c, sc)]
        levels.sort(key=lambda x: x[2])
        data["niveaua"] = levels[0][1]
        data["niveaub"] = levels[1][1]
        data["niveauc"] = levels[2][1]

def _norm_text_search(v: Optional[str]) -> str:
    s = _clean_text(v).lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _token_set(v: Optional[str]) -> set:
    toks = [t for t in _norm_text_search(v).split(" ") if len(t) >= 3]
    stop = {"des", "les", "une", "pour", "avec", "dans", "sur", "aux", "par", "and", "the"}
    return {t for t in toks if t not in stop}


def _similarity_score(a: Optional[str], b: Optional[str]) -> float:
    na = _norm_text_search(a)
    nb = _norm_text_search(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    ta = _token_set(na)
    tb = _token_set(nb)
    overlap = (len(ta & tb) / max(1, len(ta | tb))) if (ta or tb) else 0.0
    contains = 1.0 if (na in nb or nb in na) and min(len(ta), len(tb)) >= 2 else 0.0
    return max(ratio, overlap, contains * 0.9)


def _token_set_folded(v: Optional[str]) -> set:
    toks = [t for t in _norm_text_search(v).split(" ") if len(t) >= 3]
    stop = {
        "des", "les", "une", "pour", "avec", "dans", "sur", "aux", "par", "and", "the",
        "de", "du", "la", "le", "un", "en", "au", "a"
    }

    out = set()
    for tok in toks:
        if tok in stop:
            continue

        base = tok
        if len(base) >= 5:
            if base.endswith("aux"):
                base = base[:-3] + "al"
            elif base.endswith("eaux"):
                base = base[:-1]
            elif base.endswith("s") and not base.endswith(("ss", "us", "is")):
                base = base[:-1]
            elif base.endswith("x") and not base.endswith("ux"):
                base = base[:-1]

        out.add(base)

    return out


def _canonical_comp_key(v: Optional[str]) -> str:
    toks = sorted(_token_set_folded(v))
    return " ".join(toks).strip()


def _contains_any_expr(text: Optional[str], expressions: set[str]) -> bool:
    t = _norm_text_search(text)
    if not t:
        return False
    return any(expr in t for expr in expressions)


def _is_support_or_admin_poste(title: Optional[str]) -> bool:
    hints = {
        "assistant", "assistante", "secretaire", "secretariat", "administratif",
        "gestionnaire administratif", "office manager", "charge d accueil",
        "hote d accueil", "hotesse d accueil", "standardiste", "back office", "adv"
    }
    return _contains_any_expr(title, hints)


def _is_strategic_poste(title: Optional[str]) -> bool:
    hints = {
        "directeur", "directrice", "responsable", "manager", "chef de projet",
        "ingenieur", "consultant", "expert", "architecte", "lead", "referent",
        "gerant", "gérant"
    }
    return _contains_any_expr(title, hints)


def _should_keep_ai_comp_for_poste(poste_title: Optional[str], item: dict) -> bool:
    comp_title = _clean_text(item.get("intitule") or item.get("description"))
    if not comp_title:
        return False

    fu = _clamp_0_10(item.get("freq_usage"))
    im = _clamp_0_10(item.get("impact_resultat"))
    de = _clamp_0_10(item.get("dependance"))

    if max(fu, im, de) <= 2:
        return False

    if (fu + im + de) <= 8 and max(im, de) <= 3:
        return False

    core_key = _canonical_comp_key(comp_title)
    if not core_key:
        return False

    peripheral_exprs = {
        "standard telephonique",
        "accueil telephonique",
        "accueil physique",
        "prise de message",
        "prise de rendez vous",
        "orienter les appel",
        "reception des appel",
        "gestion du courrier",
        "tri du courrier",
        "classement de document",
        "archivage de document",
        "photocopie",
        "scanner des document",
        "numerisation de document",
        "gestion des fourniture",
        "reservation de salle",
        "accueil des visiteur",
        "secretariat courant",
    }

    is_peripheral = _contains_any_expr(comp_title, peripheral_exprs)
    is_support_role = _is_support_or_admin_poste(poste_title)
    is_strategic_role = _is_strategic_poste(poste_title)

    if is_peripheral and is_strategic_role:
        return False

    if is_peripheral and not is_support_role and max(im, de) <= 6:
        return False

    return True

def _html_to_text(v: Optional[str]) -> str:
    s = _clean_text(v)
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>|</li>|</ol>|</ul>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\u00a0", " ", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _response_output_text(resp) -> str:
    txt = (getattr(resp, "output_text", None) or "").strip()
    if txt:
        return txt

    parts = []
    for item in (getattr(resp, "output", None) or []):
        if getattr(item, "type", None) != "message":
            continue
        for c in (getattr(item, "content", None) or []):
            t = getattr(c, "text", None)
            if t:
                parts.append(t)
            elif isinstance(c, dict) and c.get("text"):
                parts.append(c.get("text"))
    return "\n".join([p for p in parts if p]).strip()


def _openai_responses_json(model: str, schema_name: str, schema: dict, system_prompt: str, user_prompt: str, use_web: bool = False) -> dict:
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="Lib OpenAI manquante (pip install openai).")

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY non configurée.")

    try:
        timeout_seconds = int((os.getenv("OPENAI_TIMEOUT_SECONDS") or "120").strip() or "120")
    except Exception:
        timeout_seconds = 120

    if timeout_seconds < 30:
        timeout_seconds = 30

    client = OpenAI(
        api_key=api_key,
        timeout=timeout_seconds,
    )

    kwargs = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "schema": schema,
                "strict": True,
            }
        },
    }
    if use_web:
        kwargs["tools"] = [{"type": "web_search"}]
        kwargs["tool_choice"] = "auto"

    try:
        resp = client.responses.create(**kwargs)
    except Exception as e:
        msg = str(e or "").strip()
        low = msg.lower()

        if "timeout" in low or "timed out" in low or "deadline" in low:
            raise HTTPException(
                status_code=504,
                detail=f"Le traitement IA a dépassé {timeout_seconds} secondes. Relance la recherche."
            )

        raise HTTPException(status_code=502, detail=f"Erreur appel IA : {msg or e}")

    content = _response_output_text(resp)
    if not content:
        raise HTTPException(status_code=500, detail="Réponse IA vide.")
    try:
        return json.loads(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Réponse IA invalide (JSON): {e}")


def _resolve_domain_id(cur, hint: Optional[str]) -> Optional[str]:
    h = (hint or "").strip()
    if not h:
        return None
    cur.execute(
        """
        SELECT id_domaine_competence, titre, titre_court
        FROM public.tbl_domaine_competence
        WHERE COALESCE(masque, FALSE) = FALSE
        ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre_court, titre, id_domaine_competence))
        """
    )
    rows = cur.fetchall() or []
    best = None
    best_score = 0.0
    for r in rows:
        for label in [r.get("titre_court"), r.get("titre"), r.get("id_domaine_competence")]:
            score = _similarity_score(h, label)
            if score > best_score:
                best_score = score
                best = r.get("id_domaine_competence")
    return best if best_score >= 0.72 else None


def _load_owner_comp_catalog_rows(cur, oid: str) -> List[dict]:
    cur.execute(
        """
        SELECT
          c.id_comp,
          c.code,
          c.intitule,
          c.description,
          c.domaine,
          c.etat,
          c.niveaua,
          c.niveaub,
          c.niveauc,
          dc.titre AS domaine_titre,
          dc.titre_court AS domaine_titre_court,
          dc.couleur AS domaine_couleur
        FROM public.tbl_competence c
        LEFT JOIN public.tbl_domaine_competence dc
          ON dc.id_domaine_competence = c.domaine
         AND COALESCE(dc.masque, FALSE) = FALSE
        WHERE c.id_owner = %s
          AND COALESCE(c.masque, FALSE) = FALSE
        ORDER BY lower(c.intitule)
        """,
        (oid,),
    )
    return cur.fetchall() or []


def _find_best_existing_competence_in_rows(rows: List[dict], title: str, search_terms: List[str]) -> Optional[dict]:
    t = _clean_text(title)
    if not t:
        return None

    def _core_phrase(v: Optional[str]) -> str:
        s = _norm_text_search(v)
        if not s:
            return ""
        parts = [p for p in s.split(" ") if p]
        if parts and _starts_with_action_verb(parts[0]):
            parts = parts[1:]
        stop = {"de", "des", "du", "d", "la", "le", "les", "un", "une", "et", "en", "pour", "sur", "au", "aux"}
        parts = [p for p in parts if p not in stop]
        return " ".join(parts).strip()

    def _token_overlap(a: Optional[str], b: Optional[str]) -> float:
        ta = _token_set_folded(a)
        tb = _token_set_folded(b)
        if not ta or not tb:
            return 0.0
        inter = len(ta & tb)
        union = len(ta | tb)
        subset = inter / max(1, min(len(ta), len(tb)))
        jacc = inter / max(1, union)
        return max(jacc, subset * 0.96)

    def _subset_boost(a: Optional[str], b: Optional[str]) -> float:
        ta = _token_set_folded(a)
        tb = _token_set_folded(b)
        if not ta or not tb:
            return 0.0
        inter = len(ta & tb)
        smallest = max(1, min(len(ta), len(tb)))
        ratio = inter / smallest

        if inter >= 2 and ratio >= 1.0:
            return 1.0
        if inter >= 2 and ratio >= 0.80:
            return 0.92
        return 0.0

    terms = []
    for raw in [t] + list(search_terms or []):
        s = _clean_text(raw)
        if len(s) < 3:
            continue
        if s.lower() not in [x.lower() for x in terms]:
            terms.append(s)
        if len(terms) >= 8:
            break

    core_t = _core_phrase(t)
    title_key = _canonical_comp_key(core_t or t)

    best = None
    best_score = 0.0

    for r in rows or []:
        cand_title = _clean_text(r.get("intitule"))
        cand_desc = _clean_text(r.get("description"))
        cand_domain = _clean_text(r.get("domaine_titre_court") or r.get("domaine_titre"))
        cand_levels = " ".join([
            _clean_text(r.get("niveaua")),
            _clean_text(r.get("niveaub")),
            _clean_text(r.get("niveauc")),
        ]).strip()
        combined = " ".join([cand_title, cand_desc, cand_domain, cand_levels]).strip()

        cand_core = _core_phrase(cand_title)
        cand_key = _canonical_comp_key(cand_core or cand_title)

        score = max(
            _similarity_score(t, cand_title),
            _similarity_score(core_t, cand_core),
            _similarity_score(t, combined),
            _token_overlap(t, cand_title),
            _token_overlap(core_t, cand_title),
            _token_overlap(t, combined),
            _subset_boost(t, cand_title),
            _subset_boost(core_t, cand_core),
            1.0 if title_key and cand_key and title_key == cand_key else 0.0,
        )

        for term in terms:
            score = max(
                score,
                _similarity_score(term, cand_title),
                _similarity_score(term, combined),
                _token_overlap(term, cand_title),
                _token_overlap(term, combined),
                _subset_boost(term, cand_title),
                _subset_boost(term, combined),
            )

        if core_t and cand_core and (core_t in cand_core or cand_core in core_t):
            score = max(score, 0.91)

        if title_key and cand_key and (title_key in cand_key or cand_key in title_key):
            score = max(score, 0.94)

        if score > best_score:
            best_score = score
            best = r

    return best if best_score >= 0.66 else None


def _find_best_existing_competence(cur, oid: str, title: str, search_terms: List[str]) -> Optional[dict]:
    rows = _load_owner_comp_catalog_rows(cur, oid)
    return _find_best_existing_competence_in_rows(rows, title, search_terms)


def _resolve_domain_id_from_rows(domain_rows: List[dict], hint: Optional[str]) -> Optional[str]:
    h = _clean_text(hint)
    if not h:
        return None

    best_id = None
    best_score = 0.0

    for r in domain_rows or []:
        for label in [r.get("titre_court"), r.get("titre"), r.get("id_domaine_competence")]:
            score = _similarity_score(h, label)
            if score > best_score:
                best_score = score
                best_id = r.get("id_domaine_competence")

    return best_id if best_score >= 0.72 else None


def _should_use_web_for_ai_comp_search(payload: Any, title: str) -> bool:
    # La recherche IA des compétences doit rester rapide, déterministe
    # et centrée sur le contenu réel du poste + le référentiel interne.
    # On désactive donc volontairement la recherche web sur cette étape.
    return False


def _build_ai_comp_search_prompts(payload: Any, title: str, domain_txt: str, fallback_mode: bool = False) -> tuple[str, str]:
    if not fallback_mode:
        system_prompt = (
            "Tu identifies les compétences techniques et métier STRUCTURANTES nécessaires à la tenue réelle d'un poste. "
            "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
            "Tu réalises ici une RECHERCHE INITIALE RAPIDE de compétences. "
            "Tu proposes uniquement des compétences coeur de poste ou de support réellement structurantes. "
            "Tu n'inclus pas les tâches périphériques, locales, administratives occasionnelles, de convenance ou de faible portée métier. "
            "Pas de soft skills génériques sauf si elles sont vraiment indispensables à l'exécution. "
            "Tu évites les doublons. "
            "IMPORTANT: l'intitulé d'une compétence doit commencer par un verbe d'action à l'infinitif et être réutilisable dans un référentiel RH. "
            "Le domaine de compétence doit être choisi STRICTEMENT dans la liste fournie par l'utilisateur. Si aucun domaine ne convient clairement, renvoie une chaîne vide. "
            "La description doit rester courte et utile à la décision, en une phrase simple. "
            "Ne produis PAS la fiche compétence complète à ce stade: pas de niveaux A/B/C détaillés, pas de grille d'évaluation détaillée. "
            "Tu peux proposer autant de compétences que nécessaire tant qu'elles sont réellement structurantes et non redondantes."
        )

        user_prompt = (
            f"intitulé du poste: {title}\n"
            f"mission principale: {(payload.mission_principale or '').strip()}\n"
            f"responsabilités: {_html_to_text(payload.responsabilites_html)}\n"
            f"contexte: {(payload.ai_contexte or '').strip()}\n"
            f"tâches complémentaires: {(payload.ai_taches or '').strip()}\n"
            f"outils: {(payload.ai_outils or '').strip()}\n"
            f"environnement: {(payload.ai_environnement or '').strip()}\n"
            f"interactions: {(payload.ai_interactions or '').strip()}\n"
            f"contraintes complémentaires: {(payload.ai_contraintes or '').strip()}\n"
            f"contraintes fiche: niveau étude={payload.niveau_education_minimum or ''}, nsf={payload.nsf_groupe_code or ''}, mobilité={payload.mobilite or ''}, risques={payload.risque_physique or ''}, perspectives={payload.perspectives_evolution or ''}, niveau_contrainte={payload.niveau_contrainte or ''}, détail={payload.detail_contrainte or ''}\n"
            f"Domaines de compétences autorisés (choisir exactement dans cette liste ou vide si aucun ne convient):\n{domain_txt}\n"
            "Retiens seulement les compétences qui conditionnent réellement la tenue du poste, l'autonomie, la qualité du résultat, le management, la coordination ou la continuité d'activité.\n"
            "Exclus les tâches périphériques, ponctuelles, contextuelles, administratives ou d'intendance locale.\n"
            "Ne crée pas de doublons ni de variantes inutiles d'une même compétence.\n"
            "Regroupe intelligemment quand plusieurs tâches relèvent d'une même compétence transférable.\n"
            "Fais une recherche initiale rapide et exploitable: description courte, search_terms utiles, scores réalistes, niveau recommandé pertinent.\n"
        )
        return system_prompt, user_prompt

    system_prompt = (
        "Tu identifies les compétences réellement requises pour EXECUTER le poste au quotidien. "
        "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
        "La première passe a été jugée trop pauvre ou non exploitable: tu repars donc de façon plus concrète et plus directe. "
        "Tu proposes d'abord les compétences coeur de poste, puis les compétences de coordination ou de sécurisation si elles conditionnent le résultat. "
        "Tu exclus les micro-tâches de convenance, l'intendance locale, l'accueil standard, le courrier, le classement, les formulations vagues et les soft skills génériques. "
        "Chaque compétence doit être actionnable, transférable et exprimée avec un verbe d'action à l'infinitif. "
        "Le domaine de compétence doit être choisi STRICTEMENT dans la liste fournie par l'utilisateur. Si aucun domaine ne convient clairement, renvoie une chaîne vide. "
        "La description doit rester courte, concrète et utile à la décision. "
        "Tu peux proposer autant de compétences que nécessaire tant qu'elles sont réellement structurantes et non redondantes."
    )

    user_prompt = (
        f"intitulé du poste: {title}\n"
        f"mission principale: {(payload.mission_principale or '').strip()}\n"
        f"responsabilités: {_html_to_text(payload.responsabilites_html)}\n"
        f"contexte: {(payload.ai_contexte or '').strip()}\n"
        f"tâches complémentaires: {(payload.ai_taches or '').strip()}\n"
        f"outils: {(payload.ai_outils or '').strip()}\n"
        f"environnement: {(payload.ai_environnement or '').strip()}\n"
        f"interactions: {(payload.ai_interactions or '').strip()}\n"
        f"contraintes complémentaires: {(payload.ai_contraintes or '').strip()}\n"
        f"contraintes fiche: niveau étude={payload.niveau_education_minimum or ''}, nsf={payload.nsf_groupe_code or ''}, mobilité={payload.mobilite or ''}, risques={payload.risque_physique or ''}, perspectives={payload.perspectives_evolution or ''}, niveau_contrainte={payload.niveau_contrainte or ''}, détail={payload.detail_contrainte or ''}\n"
        f"Domaines de compétences autorisés (choisir exactement dans cette liste ou vide si aucun ne convient):\n{domain_txt}\n"
        "Consigne renforcée: sors une liste exploitable de compétences nécessaires à l'exécution réelle du poste, même si les informations fournies sont incomplètes.\n"
        "Priorise les compétences coeur de poste, les compétences de pilotage opérationnel, de maîtrise technique, de coordination et de continuité d'activité.\n"
        "Évite les variantes proches, les doublons et les intitulés flous.\n"
        "En cas d'incertitude, préfère une compétence métier large et transférable plutôt qu'une micro-tâche locale.\n"
    )
    return system_prompt, user_prompt


def _build_search_terms_from_item(title: str, description: Optional[str], provided: Any) -> List[str]:
    terms = []

    for raw in (provided or []):
        s = _clean_text(raw)
        if len(s) >= 3 and s.lower() not in [x.lower() for x in terms]:
            terms.append(s)

    for raw in [title, description]:
        s = _clean_text(raw)
        if len(s) >= 3 and s.lower() not in [x.lower() for x in terms]:
            terms.append(s)

    if not terms and title:
        terms = [title]

    return terms[:4]


def _normalize_ai_comp_search_item(item: dict) -> None:
    item["intitule"] = _normalize_ai_comp_title(item.get("intitule"), item.get("description"))
    item["description"] = _build_ai_comp_description(
        item.get("intitule"),
        item.get("description"),
        item.get("why_needed"),
        240,
    )
    item["why_needed"] = _clean_ai_comp_text(item.get("why_needed"), 240)

    fu = _clamp_0_10(item.get("freq_usage"))
    im = _clamp_0_10(item.get("impact_resultat"))
    de = _clamp_0_10(item.get("dependance"))
    item["freq_usage"] = fu
    item["impact_resultat"] = im
    item["dependance"] = de

    lvl = (item.get("recommended_level") or "").strip().upper()[:1]
    if lvl not in {"A", "B", "C"}:
        total = fu + im + de
        if total >= 21 or max(fu, im, de) >= 8:
            lvl = "C"
        elif total >= 12 or max(fu, im, de) >= 5:
            lvl = "B"
        else:
            lvl = "A"
    item["recommended_level"] = lvl

    item["domaine_hint"] = _clean_ai_comp_text(item.get("domaine_hint"), 120)
    item["search_terms"] = _build_search_terms_from_item(
        item.get("intitule") or "",
        item.get("description") or "",
        item.get("search_terms") or [],
    )

    item["niveaua"] = _normalize_ai_level_text(item.get("niveaua"), item.get("intitule"), 1, 280)
    item["niveaub"] = _normalize_ai_level_text(item.get("niveaub"), item.get("intitule"), 2, 280)
    item["niveauc"] = _normalize_ai_level_text(item.get("niveauc"), item.get("intitule"), 3, 280)
    _fix_abc_levels(item)

    ge = _sanitize_grille(item.get("grille_evaluation"))
    item["grille_evaluation"] = _compact_ai_grille(
        ge,
        fu,
        im,
        de,
    )


def _draft_needs_ai_enrichment(draft: dict) -> bool:
    desc = _clean_text(draft.get("description"))
    if len(desc.split()) < 9:
        return True

    if not _clean_text(draft.get("niveaua")):
        return True
    if not _clean_text(draft.get("niveaub")):
        return True
    if not _clean_text(draft.get("niveauc")):
        return True

    ge = _sanitize_grille(draft.get("grille_evaluation"))
    filled_crit = 0
    for i in range(1, 5):
        node = ge.get(f"Critere{i}") or {}
        nom = _clean_text(node.get("Nom"))
        evals = [x for x in (node.get("Eval") or []) if _clean_text(x)]
        if nom or evals:
            filled_crit += 1

    return filled_crit == 0


def _merge_ai_comp_draft(base: dict, enriched: dict) -> dict:
    out = dict(base or {})
    src = dict(enriched or {})

    cur_desc = _clean_text(out.get("description"))
    if len(cur_desc.split()) < 9 and _clean_text(src.get("description")):
        out["description"] = src.get("description")

    for key in ("niveaua", "niveaub", "niveauc"):
        cur_txt = _clean_text(out.get(key))
        if len(cur_txt.split()) < 8 and _clean_text(src.get(key)):
            out[key] = src.get(key)

    cur_ge = _sanitize_grille(out.get("grille_evaluation"))
    src_ge = _sanitize_grille(src.get("grille_evaluation"))

    cur_filled = 0
    src_filled = 0

    for i in range(1, 5):
        cur_node = cur_ge.get(f"Critere{i}") or {}
        src_node = src_ge.get(f"Critere{i}") or {}

        if _clean_text(cur_node.get("Nom")) or any(_clean_text(x) for x in (cur_node.get("Eval") or [])):
            cur_filled += 1
        if _clean_text(src_node.get("Nom")) or any(_clean_text(x) for x in (src_node.get("Eval") or [])):
            src_filled += 1

    if src_filled > cur_filled:
        out["grille_evaluation"] = src_ge

    return out


def _enrich_ai_comp_draft(model: str, draft: dict, domain_rows: List[dict]) -> dict:
    title = _clean_text(draft.get("intitule"))
    if not title:
        return dict(draft or {})

    domain_txt = "\n".join([
        f"- {(r.get('titre_court') or r.get('titre') or '').strip()}"
        for r in (domain_rows or [])
        if (r.get("titre_court") or r.get("titre") or "").strip()
    ]) or "- aucun domaine"

    current_domain_label = ""
    current_domain_id = _clean_text(draft.get("domaine_id"))
    if current_domain_id:
        for r in (domain_rows or []):
            if _clean_text(r.get("id_domaine_competence")) == current_domain_id:
                current_domain_label = _clean_text(r.get("titre_court") or r.get("titre"))
                break

    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["description", "niveaua", "niveaub", "niveauc", "grille_evaluation"],
        "properties": {
            "description": {"type": "string", "maxLength": 600},
            "niveaua": {"type": "string", "maxLength": 280},
            "niveaub": {"type": "string", "maxLength": 280},
            "niveauc": {"type": "string", "maxLength": 280},
            "grille_evaluation": {
                "type": "object",
                "additionalProperties": False,
                "required": ["Critere1", "Critere2", "Critere3", "Critere4"],
                "properties": {
                    **{f"Critere{i}": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["Nom", "Eval"],
                        "properties": {
                            "Nom": {"type": "string", "maxLength": 160},
                            "Eval": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "string", "maxLength": 160}}
                        }
                    } for i in range(1, 5)}
                }
            }
        }
    }

    system_prompt = (
        "Tu enrichis UNE compétence déjà retenue pour un référentiel RH. "
        "Tu ne modifies pas le périmètre métier de la compétence. "
        "Tu rédiges une description professionnelle, concrète et réutilisable. "
        "Tu produis des niveaux A/B/C vraiment observables et différenciants. "
        "Tu produis une grille d'évaluation exploitable en entretien, avec 2 ou 3 critères dans la majorité des cas, 4 seulement si indispensable. "
        "Tu restes sobre, précis, métier, sans jargon inutile, sans web search et sans élargir artificiellement la compétence."
    )

    user_prompt = (
        f"compétence retenue: {title}\n"
        f"description actuelle: {_clean_text(draft.get('description'))}\n"
        f"domaine actuel: {current_domain_label}\n"
        f"domaine autorisés:\n{domain_txt}\n"
        f"niveau recommandé: {_clean_text(draft.get('recommended_level'))}\n"
        f"criticité: freq_usage={_clamp_0_10(draft.get('freq_usage'))}, impact_resultat={_clamp_0_10(draft.get('impact_resultat'))}, dependance={_clamp_0_10(draft.get('dependance'))}\n"
        "Rédige uniquement la fiche détaillée de cette compétence déjà validée dans son périmètre.\n"
        "Ne crée pas une nouvelle compétence, ne change pas son intitulé, ne l'élargis pas artificiellement.\n"
    )

    enriched = _openai_responses_json(
        model,
        "poste_comp_create_enrich",
        schema,
        system_prompt,
        user_prompt,
        use_web=False,
    )

    return _merge_ai_comp_draft(draft, enriched or {})


def _sanitize_grille(v: Any) -> dict:
    ge = v if isinstance(v, dict) else {}
    out = {}
    for idx in range(1, 5):
        k = f"Critere{idx}"
        item = ge.get(k) or {}
        nom = (item.get("Nom") or "").strip() if isinstance(item, dict) else ""
        evals = item.get("Eval") if isinstance(item, dict) else None
        evals = evals if isinstance(evals, list) else []
        evals = [str(x or "").strip()[:160] for x in evals[:4]]
        while len(evals) < 4:
            evals.append("")
        out[k] = {"Nom": nom[:160], "Eval": evals}
    return out


def _upsert_poste_comp_assoc(cur, id_poste: str, id_competence: str, niveau_requis: str, freq_usage: int, impact_resultat: int, dependance: int) -> None:
    cur.execute(
        """
        INSERT INTO public.tbl_fiche_poste_competence
          (id_poste, id_competence, niveau_requis, freq_usage, impact_resultat, dependance, poids_criticite, masque)
        VALUES
          (%s, %s, %s, %s, %s, %s, %s, FALSE)
        ON CONFLICT (id_poste, id_competence)
        DO UPDATE SET
          niveau_requis = EXCLUDED.niveau_requis,
          freq_usage = EXCLUDED.freq_usage,
          impact_resultat = EXCLUDED.impact_resultat,
          dependance = EXCLUDED.dependance,
          poids_criticite = EXCLUDED.poids_criticite,
          masque = FALSE
        """,
        (
            id_poste,
            id_competence,
            (niveau_requis or "A").strip()[:1].upper() or "A",
            _clamp_0_10(freq_usage),
            _clamp_0_10(impact_resultat),
            _clamp_0_10(dependance),
            _calc_poids_criticite_100(freq_usage, impact_resultat, dependance),
        ),
    )

_POSTE_IMPORT_MAX_BYTES = 15 * 1024 * 1024
_POSTE_IMPORT_ALLOWED_EXTS = {".doc", ".docx", ".pdf"}


def _best_effort_decode(raw: bytes) -> str:
    txt_utf = (raw or b"").decode("utf-8", errors="ignore").strip()
    txt_cp = (raw or b"").decode("cp1252", errors="ignore").strip()
    return txt_cp if len(txt_cp) > len(txt_utf) else txt_utf


def _get_poste_import_ext(filename: Optional[str]) -> str:
    name = _clean_text(filename).lower()
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[1]


def _extract_docx_text(raw: bytes) -> str:
    if DocxDocument is None:
        raise HTTPException(status_code=500, detail="Lecture DOCX indisponible (python-docx manquant).")

    try:
        doc = DocxDocument(BytesIO(raw))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Document DOCX illisible: {e}")

    parts: List[str] = []

    for p in getattr(doc, "paragraphs", []) or []:
        txt = _clean_text(getattr(p, "text", ""))
        if txt:
            parts.append(txt)

    for table in getattr(doc, "tables", []) or []:
        for row in getattr(table, "rows", []) or []:
            vals = []
            for cell in getattr(row, "cells", []) or []:
                txt = _clean_text(getattr(cell, "text", ""))
                if txt:
                    vals.append(txt)
            if vals:
                parts.append(" | ".join(vals))

    return "\n".join(parts).strip()


def _extract_pdf_text(raw: bytes) -> str:
    if PdfReader is None:
        raise HTTPException(status_code=500, detail="Lecture PDF indisponible (pypdf manquant).")

    try:
        reader = PdfReader(BytesIO(raw))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF illisible: {e}")

    parts: List[str] = []
    for page in getattr(reader, "pages", []) or []:
        try:
            txt = _clean_text(page.extract_text() or "")
        except Exception:
            txt = ""
        if txt:
            parts.append(txt)

    return "\n".join(parts).strip()


def _extract_doc_text(raw: bytes) -> str:
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".doc") as tmp:
            tmp.write(raw)
            tmp_path = tmp.name

        try:
            proc = subprocess.run(
                ["antiword", tmp_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=45,
                check=False,
            )
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="Lecture .doc indisponible (antiword manquant).")

        txt = _best_effort_decode(proc.stdout or b"")
        if txt:
            return txt

        err = _best_effort_decode(proc.stderr or b"")
        if err:
            raise HTTPException(status_code=400, detail=f"Document .doc illisible: {err}")

        raise HTTPException(status_code=400, detail="Document .doc illisible.")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def _extract_poste_import_text(filename: Optional[str], raw: bytes) -> tuple[str, str]:
    ext = _get_poste_import_ext(filename)

    if ext not in _POSTE_IMPORT_ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="Format non supporté. Utilise un fichier .doc, .docx ou .pdf.")

    if not raw:
        raise HTTPException(status_code=400, detail="Document vide.")

    if len(raw) > _POSTE_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Document trop volumineux. Limite : 15 Mo.")

    if ext == ".docx":
        text = _extract_docx_text(raw)
    elif ext == ".pdf":
        text = _extract_pdf_text(raw)
    else:
        text = _extract_doc_text(raw)

    text = re.sub(r"\n{3,}", "\n\n", _clean_text(text)).strip()

    if len(text) < 80:
        if ext == ".pdf":
            raise HTTPException(status_code=400, detail="PDF sans texte exploitable. V1 : utilise un PDF texte, un .doc ou un .docx.")
        raise HTTPException(status_code=400, detail="Document trop pauvre ou illisible pour lancer l’analyse.")

    return ext, text[:50000]

def _ensure_json_dict(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return {}
        try:
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}
    return {}


def _fetch_owner_idcc(cur, oid: str) -> dict:
    owner_id = (oid or "").strip()
    if not owner_id:
        return {
            "id_ent": "",
            "idcc": "",
            "owner_source": "",
        }

    # 1) Cas standard : entreprise cliente
    cur.execute(
        """
        SELECT
          id_ent,
          idcc
        FROM public.tbl_entreprise
        WHERE id_ent = %s
        LIMIT 1
        """,
        (owner_id,),
    )
    row = cur.fetchone() or None
    if row:
        return {
            "id_ent": (row.get("id_ent") or "").strip(),
            "idcc": (row.get("idcc") or "").strip(),
            "owner_source": "tbl_entreprise",
        }

    # 2) Fallback : mon entreprise
    cur.execute(
        """
        SELECT
          id_mon_ent,
          idcc
        FROM public.tbl_mon_entreprise
        WHERE id_mon_ent = %s
        LIMIT 1
        """,
        (owner_id,),
    )
    row = cur.fetchone() or None
    if row:
        return {
            "id_ent": (row.get("id_mon_ent") or "").strip(),
            "idcc": (row.get("idcc") or "").strip(),
            "owner_source": "tbl_mon_entreprise",
        }

    return {
        "id_ent": "",
        "idcc": "",
        "owner_source": "",
    }


def _fetch_ccn_referential(cur, idcc: str) -> Optional[dict]:
    if not (idcc or "").strip():
        return None

    cur.execute(
        """
        SELECT
          id_referentiel_ccn,
          idcc,
          convention_label,
          version_label,
          date_effet,
          source_url,
          referentiel_json
        FROM public.tbl_studio_ccn_referentiel
        WHERE idcc = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY COALESCE(date_effet, DATE '1900-01-01') DESC, date_maj DESC
        LIMIT 1
        """,
        ((idcc or "").strip(),),
    )
    row = cur.fetchone() or None
    if not row:
        return None

    row["referentiel_json"] = _ensure_json_dict(row.get("referentiel_json"))
    return row


def _fetch_poste_for_ccn(cur, oid: str, pid: str) -> dict:
    cur.execute(
        """
        SELECT
          p.id_poste,
          p.id_owner,
          p.id_ent,
          p.id_service,
          p.codif_poste,
          p.codif_client,
          COALESCE(NULLIF(BTRIM(p.codif_client), ''), NULLIF(BTRIM(p.codif_poste), ''), '—') AS code_poste,
          COALESCE(p.intitule_poste, '') AS intitule_poste,
          COALESCE(p.mission_principale, '') AS mission_principale,
          COALESCE(p.responsabilites, '') AS responsabilites,
          COALESCE(p.isresponsable, FALSE) AS isresponsable,
          p.date_maj AS poste_date_maj,
          COALESCE(p.niveau_contrainte, '') AS niveau_contrainte,
          COALESCE(p.mobilite, '') AS mobilite,
          COALESCE(p.perspectives_evolution, '') AS perspectives_evolution,
          COALESCE(p.risque_physique, '') AS risque_physique,
          COALESCE(p.detail_contrainte, '') AS detail_contrainte,
          COALESCE(p.niveau_education_minimum, '') AS niveau_education_minimum,
          COALESCE(p.nsf_groupe_code, '') AS nsf_groupe_code,
          COALESCE(p.nsf_groupe_obligatoire, FALSE) AS nsf_groupe_obligatoire,
          COALESCE(ng.titre, '') AS nsf_groupe_titre,
          COALESCE(s.nom_service, '') AS nom_service
        FROM public.tbl_fiche_poste p
        LEFT JOIN public.tbl_entreprise_organigramme s
          ON s.id_service = p.id_service
         AND s.id_ent = p.id_ent
         AND COALESCE(s.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_nsf_groupe ng
          ON ng.code = p.nsf_groupe_code
         AND COALESCE(ng.masque, FALSE) = FALSE
        WHERE p.id_owner = %s
          AND p.id_poste = %s
        LIMIT 1
        """,
        (oid, pid),
    )
    poste = cur.fetchone() or None
    if not poste:
        raise HTTPException(status_code=404, detail="Poste introuvable.")

    cur.execute(
        """
        SELECT
          c.id_comp AS id_competence,
          c.code,
          c.intitule,
          COALESCE(pc.niveau_requis, '') AS niveau_requis,
          COALESCE(pc.poids_criticite, 0) AS poids_criticite,
          COALESCE(pc.freq_usage, 0) AS freq_usage,
          COALESCE(pc.impact_resultat, 0) AS impact_resultat,
          COALESCE(pc.dependance, 0) AS dependance
        FROM public.tbl_fiche_poste_competence pc
        JOIN public.tbl_competence c
          ON c.id_comp = pc.id_competence
        WHERE pc.id_poste = %s
          AND COALESCE(pc.masque, FALSE) = FALSE
          AND COALESCE(c.masque, FALSE) = FALSE
        ORDER BY lower(COALESCE(c.intitule, ''))
        """,
        (pid,),
    )
    comps = cur.fetchall() or []

    cur.execute(
        """
        SELECT
          cert.id_certification,
          COALESCE(cert.nom_certification, '') AS nom_certification,
          COALESCE(cert.description, '') AS description,
          COALESCE(cert.categorie, '') AS categorie,
          cert.duree_validite,
          cert.delai_renouvellement,
          COALESCE(pc.niveau_exigence, '') AS niveau_exigence,
          pc.validite_override,
          COALESCE(pc.commentaire, '') AS commentaire
        FROM public.tbl_fiche_poste_certification pc
        JOIN public.tbl_certification cert
          ON cert.id_certification = pc.id_certification
        WHERE pc.id_poste = %s
        ORDER BY lower(COALESCE(cert.nom_certification, ''))
        """,
        (pid,),
    )
    certs = cur.fetchall() or []

    resp_text = _html_to_text(poste.get("responsabilites"))
    return {
        "id_poste": poste.get("id_poste"),
        "id_owner": poste.get("id_owner"),
        "id_ent": poste.get("id_ent"),
        "id_service": poste.get("id_service"),
        "nom_service": poste.get("nom_service"),
        "codif_poste": poste.get("codif_poste"),
        "codif_client": poste.get("codif_client"),
        "code_poste": poste.get("code_poste"),
        "intitule_poste": poste.get("intitule_poste"),
        "mission_principale": poste.get("mission_principale"),
        "responsabilites": poste.get("responsabilites"),
        "responsabilites_text": resp_text,
        "isresponsable": bool(poste.get("isresponsable")),
        "poste_date_maj": poste.get("poste_date_maj"),
        "niveau_contrainte": poste.get("niveau_contrainte"),
        "mobilite": poste.get("mobilite"),
        "perspectives_evolution": poste.get("perspectives_evolution"),
        "risque_physique": poste.get("risque_physique"),
        "detail_contrainte": poste.get("detail_contrainte"),
        "niveau_education_minimum": poste.get("niveau_education_minimum"),
        "nsf_groupe_code": poste.get("nsf_groupe_code"),
        "nsf_groupe_titre": poste.get("nsf_groupe_titre"),
        "nsf_groupe_obligatoire": bool(poste.get("nsf_groupe_obligatoire")),
        "competences": [
            {
                "id_competence": c.get("id_competence"),
                "code": c.get("code"),
                "intitule": c.get("intitule"),
                "niveau_requis": c.get("niveau_requis"),
                "poids_criticite": int(c.get("poids_criticite") or 0),
                "freq_usage": int(c.get("freq_usage") or 0),
                "impact_resultat": int(c.get("impact_resultat") or 0),
                "dependance": int(c.get("dependance") or 0),
            }
            for c in comps
        ],
        "certifications": [
            {
                "id_certification": c.get("id_certification"),
                "nom_certification": c.get("nom_certification"),
                "description": c.get("description"),
                "categorie": c.get("categorie"),
                "duree_validite": c.get("duree_validite"),
                "delai_renouvellement": c.get("delai_renouvellement"),
                "niveau_exigence": c.get("niveau_exigence"),
                "validite_override": c.get("validite_override"),
                "commentaire": c.get("commentaire"),
            }
            for c in certs
        ],
        "competences_count": len(comps),
        "certifications_count": len(certs),
    }

def _fetch_poste_ccn_dossier(cur, pid: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          id_cotation_ccn,
          id_poste,
          id_owner,
          id_ent,
          idcc,
          id_referentiel_ccn,
          statut_cotation,
          proposition_json,
          validation_json,
          snapshot_poste_json,
          date_creation,
          date_maj
        FROM public.tbl_studio_poste_cotation_ccn
        WHERE id_poste = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (pid,),
    )
    row = cur.fetchone() or None
    if not row:
        return None

    row["proposition_json"] = _ensure_json_dict(row.get("proposition_json"))
    row["validation_json"] = _ensure_json_dict(row.get("validation_json"))
    row["snapshot_poste_json"] = _ensure_json_dict(row.get("snapshot_poste_json"))
    return row


def _upsert_poste_ccn_dossier(
    cur,
    oid: str,
    pid: str,
    idcc: str,
    id_referentiel_ccn: str,
    snapshot_poste_json: dict,
    statut_cotation: str,
    proposition_json: Optional[dict],
    validation_json: Optional[dict],
    user_email: Optional[str],
) -> None:
    proposition_payload = json.dumps(_json_safe_value(proposition_json or {}), ensure_ascii=False)
    validation_payload = json.dumps(_json_safe_value(validation_json or {}), ensure_ascii=False)
    snapshot_payload = json.dumps(_json_safe_value(snapshot_poste_json or {}), ensure_ascii=False)

    cur.execute(
        """
        INSERT INTO public.tbl_studio_poste_cotation_ccn
          (
            id_cotation_ccn,
            id_poste,
            id_owner,
            id_ent,
            idcc,
            id_referentiel_ccn,
            statut_cotation,
            proposition_json,
            validation_json,
            snapshot_poste_json,
            created_by,
            updated_by,
            archive,
            date_creation,
            date_maj
          )
        VALUES
          (
            %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, FALSE, NOW(), NOW()
          )
        ON CONFLICT (id_poste)
        DO UPDATE SET
          id_owner = EXCLUDED.id_owner,
          id_ent = EXCLUDED.id_ent,
          idcc = EXCLUDED.idcc,
          id_referentiel_ccn = EXCLUDED.id_referentiel_ccn,
          statut_cotation = EXCLUDED.statut_cotation,
          proposition_json = EXCLUDED.proposition_json,
          validation_json = EXCLUDED.validation_json,
          snapshot_poste_json = EXCLUDED.snapshot_poste_json,
          updated_by = EXCLUDED.updated_by,
          archive = FALSE,
          date_maj = NOW()
        """,
        (
            str(uuid.uuid4()),
            pid,
            oid,
            oid,
            idcc,
            id_referentiel_ccn,
            statut_cotation,
            proposition_payload,
            validation_payload,
            snapshot_payload,
            (user_email or "").strip() or None,
            (user_email or "").strip() or None,
        ),
    )

def _pdf_first_non_empty(*values) -> str:
    for value in values:
        s = str(value or "").strip()
        if s:
            return s
    return ""


def _pdf_bool_oui_non(v: Any) -> str:
    return "OUI" if bool(v) else "NON"


def _pdf_split_lines(v: Optional[str]) -> List[str]:
    txt = _html_to_text(v)
    if not txt:
        return []

    out = []
    for raw in txt.replace("\r", "\n").split("\n"):
        line = re.sub(r"\s+", " ", str(raw or "")).strip(" \t")
        if line:
            out.append(line)
    return out


def _pdf_niveau_education_label(v: Optional[str]) -> str:
    s = str(v or "").strip()
    mapping = {
        "0": "Aucun diplôme",
        "1": "Niveau 1",
        "2": "Niveau 2",
        "3": "Niveau 3 : CAP, BEP",
        "4": "Niveau 4 : Bac",
        "5": "Niveau 5 : Bac+2 (BTS, DUT)",
        "6": "Niveau 6 : Bac+3 (Licence, BUT)",
        "7": "Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)",
        "8": "Niveau 8 : Bac+8 (Doctorat)",
    }
    return mapping.get(s, s or "—")


def _pdf_niveau_label(v: Optional[str]) -> str:
    code = (v or "").strip().upper()
    if code == "A":
        return "A - Initial"
    if code == "B":
        return "B - Avancé"
    if code == "C":
        return "C - Expert"
    return code or "—"


def _pdf_exigence_label(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    if s == "requis":
        return "Requis"
    if s in ("souhaite", "souhaité"):
        return "Souhaité"
    return (v or "").strip() or "—"


def _pdf_months_label(v: Any) -> str:
    try:
        n = int(v)
    except Exception:
        return "—"
    return f"{n} mois" if n > 0 else "—"

def _pdf_latin1_safe(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return ""

    repl = {
        "\u2013": "-",   # en dash
        "\u2014": "-",   # em dash
        "\u2022": "-",   # bullet
        "\u00a0": " ",   # nbsp
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
    }
    for src, dst in repl.items():
        s = s.replace(src, dst)

    try:
        s.encode("latin-1")
        return s
    except Exception:
        return s.encode("latin-1", errors="ignore").decode("latin-1").strip()

def _pdf_format_footer_date(v: Any) -> str:
    if v is None:
        return ""

    if isinstance(v, datetime):
        return v.strftime("%d/%m/%Y")

    s = str(v).strip()
    if not s:
        return ""

    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"

    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d.strftime("%d/%m/%Y")
    except Exception:
        return s


def _pdf_safe_filename_part(v: Any, max_len: int = 120) -> str:
    s = str(v or "").strip()
    s = re.sub(r'[\\/:*?"<>|]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ._-")
    if not s:
        return "Poste"
    if len(s) > max_len:
        s = s[:max_len].rsplit(" ", 1)[0].strip()
    return s or "Poste"

def _json_safe_value(v: Any):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, py_date):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json_safe_value(val) for k, val in v.items()}
    if isinstance(v, list):
        return [_json_safe_value(x) for x in v]
    return v

def _resolve_owner_logo_path(owner: Optional[dict]) -> str:
    if not isinstance(owner, dict):
        return ""

    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_keys = [
        "logo_pdf_path",
        "logo_path",
        "logo_local_path",
        "logo_file_path",
    ]

    for key in candidate_keys:
        raw = str(owner.get(key) or "").strip()
        if not raw:
            continue

        candidates = [raw]
        if not os.path.isabs(raw):
            candidates.append(os.path.abspath(os.path.join(base_dir, "..", raw.lstrip("/"))))
            candidates.append(os.path.abspath(os.path.join(base_dir, raw.lstrip("/"))))

        for path in candidates:
            if os.path.isfile(path):
                return path

    return ""


def _build_owner_logo_flowable(owner: Optional[dict], styles: dict):
    logo_path = _resolve_owner_logo_path(owner)
    if logo_path:
        try:
            img = Image(logo_path)
            img._restrictSize(62 * mm, 22 * mm)
            img.hAlign = "CENTER"
            return img
        except Exception:
            pass

    placeholder_style = ParagraphStyle(
        "NsPdfOwnerLogoPlaceholder",
        parent=styles["small"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=PDF_MUTED,
    )
    slot = Table(
        [[Paragraph("Emplacement logo entreprise", placeholder_style)]],
        colWidths=[62 * mm],
        rowHeights=[18 * mm],
    )
    slot.hAlign = "CENTER"
    slot.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return slot


def _build_pdf_centered_titles(main_title: str, secondary_title: str, styles: dict) -> List:
    title_style = ParagraphStyle(
        "NsPdfCenteredMainTitle",
        parent=styles["title"],
        alignment=1,
        fontSize=16,
        leading=18,
        spaceAfter=0,
    )
    secondary_style = ParagraphStyle(
        "NsPdfCenteredSecondaryTitle",
        parent=styles["section"],
        alignment=1,
        fontSize=13,
        leading=15,
        spaceAfter=0,
        spaceBefore=0,
    )

    out = [Paragraph(_pdf_esc(main_title or "Fiche de poste"), title_style)]
    if str(secondary_title or "").strip():
        out.append(make_spacer(1))
        out.append(Paragraph(_pdf_esc(secondary_title), secondary_style))
    return out


def _build_pdf_field_cell(label: str, value: str, styles: dict):
    label_style = ParagraphStyle(
        "NsPdfFieldLabel",
        parent=styles["small"],
        fontName="Helvetica-Bold",
        fontSize=7.5,
        leading=9,
        textColor=PDF_MUTED,
        spaceAfter=1,
    )
    value_style = ParagraphStyle(
        "NsPdfFieldValue",
        parent=styles["body"],
        fontName="Helvetica-Bold",
        fontSize=9.2,
        leading=11,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    return [
        Paragraph(_pdf_esc(label), label_style),
        Paragraph(_pdf_esc(value or "—"), value_style),
    ]


def _build_pdf_reference_block(poste: dict, styles: dict, content_width: float):
    ref_code = _pdf_first_non_empty(poste.get("code_poste"), poste.get("codif_client"), poste.get("codif_poste")) or "—"
    service_label = _pdf_first_non_empty(poste.get("nom_service"), "Non lié") or "Non lié"
    manager_label = _pdf_bool_oui_non(poste.get("isresponsable"))

    rows = [
        [
            _build_pdf_field_cell("Référence du poste", ref_code, styles),
            _build_pdf_field_cell("Service de rattachement", service_label, styles),
        ],
        [
            _build_pdf_field_cell("Poste de management", manager_label, styles),
            "",
        ],
    ]

    table = Table(rows, colWidths=[content_width / 2.0, content_width / 2.0])
    table.hAlign = "LEFT"
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


class _PdfResponsabilitesParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.list_stack = []
        self.current_block = None
        self.current_item_parts = None
        self.outside = []
        self.blocks = []

    def _clean_text(self, value: str) -> str:
        txt = str(value or "")
        txt = txt.replace("\r", "\n")
        txt = re.sub(r"\s+", " ", txt.replace("\n", " "))
        return txt.strip(" \t-•")

    def _append_text(self, text: str) -> None:
        if self.current_item_parts is not None:
            self.current_item_parts.append(text)
        elif self.current_block is not None:
            self.current_block["title_parts"].append(text)
        else:
            self.outside.append(text)

    def handle_data(self, data):
        self._append_text(data)

    def handle_starttag(self, tag, attrs):
        t = (tag or "").lower()

        if t == "br":
            self._append_text("\n")
            return

        if t in ("ol", "ul"):
            self.list_stack.append(t)
            return

        if t == "li":
            # Bloc principal : <ol><li>...</li></ol>
            if self.list_stack and self.list_stack[-1] == "ol" and len(self.list_stack) == 1:
                self.current_block = {
                    "title_parts": [],
                    "items": [],
                }
                return

            # Détail : <ul><li>...</li></ul> à l'intérieur d'un bloc principal
            if self.list_stack and self.list_stack[-1] == "ul" and len(self.list_stack) >= 2:
                self.current_item_parts = []
                return

    def handle_endtag(self, tag):
        t = (tag or "").lower()

        if t in ("p", "div"):
            self._append_text("\n")
            return

        if t == "li":
            # Fermeture d'une puce de détail
            if self.current_item_parts is not None:
                txt = self._clean_text("".join(self.current_item_parts))
                if txt and self.current_block is not None:
                    self.current_block["items"].append({
                        "marker": "•",
                        "text": txt,
                    })
                self.current_item_parts = None
                return

            # Fermeture d'un bloc principal
            if self.current_block is not None and self.list_stack and self.list_stack[-1] == "ol" and len(self.list_stack) == 1:
                title = self._clean_text("".join(self.current_block.get("title_parts") or []))
                items = self.current_block.get("items") or []
                if title or items:
                    self.blocks.append({
                        "title": title,
                        "items": items,
                    })
                self.current_block = None
                return

        if t in ("ol", "ul"):
            if self.list_stack:
                self.list_stack.pop()

    def _fallback_blocks_from_text(self, lines: List[str]) -> List[dict]:
        blocks = []
        current = None

        for raw in lines:
            line = re.sub(r"\s+", " ", str(raw or "")).strip()
            if not line:
                continue

            m = re.match(r"^(\d+)[\.\)]\s+(.*)$", line)
            if m:
                if current and (current.get("title") or current.get("items")):
                    blocks.append(current)
                current = {
                    "title": m.group(2).strip(),
                    "items": [],
                }
                continue

            if re.match(r"^[•\-]\s+", line):
                text = re.sub(r"^[•\-]\s+", "", line).strip()
                if not current:
                    current = {"title": "", "items": []}
                current["items"].append({"marker": "•", "text": text})
                continue

            if current is None:
                current = {"title": line, "items": []}
            else:
                current["items"].append({"marker": "•", "text": line})

        if current and (current.get("title") or current.get("items")):
            blocks.append(current)

        return blocks

    def get_blocks(self) -> List[dict]:
        cleaned = []
        for block in self.blocks:
            title = self._clean_text(block.get("title") or "")
            items = []
            for it in block.get("items") or []:
                txt = self._clean_text(it.get("text") or "")
                if txt:
                    items.append({"marker": "•", "text": txt})
            if title or items:
                cleaned.append({
                    "title": title,
                    "items": items,
                })

        if cleaned:
            return cleaned

        lines = _pdf_split_lines("".join(self.outside))
        return self._fallback_blocks_from_text(lines)


def _build_pdf_plain_block(title: str, lines: List[str], styles: dict) -> List:
    section_style = ParagraphStyle(
        "NsPdfPlainSectionTitle",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=13,
        spaceAfter=3,
        spaceBefore=0,
        textColor=PDF_TEXT,
    )
    body_style = ParagraphStyle(
        "NsPdfPlainBody",
        parent=styles["body"],
        fontSize=9.2,
        leading=12,
        spaceAfter=1.4,
        textColor=PDF_TEXT,
    )

    out = [Paragraph(_pdf_esc(title), section_style)]
    if not lines:
        out.append(Paragraph("—", body_style))
        return out

    for line in lines:
        out.append(Paragraph(_pdf_esc(line), body_style))
    return out


def _build_pdf_responsabilites_flowables(html: Optional[str], styles: dict) -> List:
    section_style = ParagraphStyle(
        "NsPdfRespSectionTitle",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=13,
        spaceAfter=5,
        spaceBefore=0,
        textColor=PDF_TEXT,
    )
    block_title_style = ParagraphStyle(
        "NsPdfRespBlockTitle",
        parent=styles["body"],
        fontName="Helvetica-Bold",
        fontSize=9.3,
        leading=10.9,
        spaceAfter=0,
        textColor=PDF_TEXT,
    )
    bullet_style = ParagraphStyle(
        "NsPdfRespBullet",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=8.8,
        leading=9.4,
        leftIndent=14,
        firstLineIndent=-9,
        spaceAfter=0,
        textColor=PDF_TEXT,
    )

    parser = _PdfResponsabilitesParser()
    try:
        parser.feed(str(html or ""))
        parser.close()
    except Exception:
        pass

    blocks = parser.get_blocks()

    out: List = [Paragraph("Responsabilités", section_style)]

    if not blocks:
        plain = _pdf_split_lines(html)
        if not plain:
            out.append(Paragraph("—", bullet_style))
            return out

        for idx, line in enumerate(plain, start=1):
            out.append(Paragraph(_pdf_esc(f"{idx}. {line}"), block_title_style))
            if idx < len(plain):
                out.append(make_spacer(2.2))
        return out

    for idx, block in enumerate(blocks, start=1):
        flowables = []

        title_txt = str(block.get("title") or "").strip()
        items = block.get("items") or []

        if title_txt:
            flowables.append(
                Paragraph(_pdf_esc(f"{idx}. {title_txt}"), block_title_style)
            )

        if items:
            flowables.append(make_spacer(0.6))
            for item in items:
                txt = str(item.get("text") or "").strip()
                if txt:
                    flowables.append(
                        Paragraph(_pdf_esc(f"• {txt}"), bullet_style)
                    )

        if flowables:
            out.append(KeepTogether(flowables))

        if idx < len(blocks):
            out.append(make_spacer(2.4))

    return out


def _build_pdf_property_grid(entries: List[tuple], styles: dict, content_width: float, last_full: Optional[tuple] = None):
    cell_style = ParagraphStyle(
        "NsPdfPropCell",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=8.8,
        leading=10.8,
        spaceAfter=0,
        textColor=PDF_TEXT,
    )

    def _cell(entry: tuple):
        label = _pdf_esc(entry[0] or "")
        value = _pdf_esc(entry[1] or "—")
        return Paragraph(f"<b>{label} :</b> {value}", cell_style)

    rows = []
    for i in range(0, len(entries), 2):
        left = entries[i]
        right = entries[i + 1] if (i + 1) < len(entries) else None
        rows.append([
            _cell(left),
            _cell(right) if right else "",
        ])

    if last_full:
        rows.append([
            _cell(last_full),
            "",
        ])

    table = Table(rows, colWidths=[content_width / 2.0, content_width / 2.0])
    table.hAlign = "LEFT"

    ts = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    if last_full:
        last_idx = len(rows) - 1
        ts.append(("SPAN", (0, last_idx), (1, last_idx)))

    table.setStyle(TableStyle(ts))
    return table


def _build_pdf_rich_table(headers: List[str], rows: List[List[str]], col_widths: List[float], styles: dict) -> Table:
    header_style = ParagraphStyle(
        "NsPdfTableHead",
        parent=styles["small"],
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=PDF_TEXT,
    )
    cell_style = ParagraphStyle(
        "NsPdfTableCell",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=10.4,
        textColor=PDF_TEXT,
    )

    data = [[Paragraph(_pdf_esc(h), header_style) for h in headers]]
    for row in rows:
        data.append([Paragraph(_pdf_esc(c or "—"), cell_style) for c in row])

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.hAlign = "LEFT"
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, -1), PDF_TEXT),
        ("BOX", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def _build_poste_pdf_story(owner: dict, poste: dict, dossier: Optional[dict], referential: Optional[dict]) -> List:
    styles = build_pdf_styles()
    story: List = []

    content_width = A4[0] - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT

    story.extend(_build_pdf_centered_titles(
        "Fiche de poste",
        poste.get("intitule_poste") or "",
        styles,
    ))
    story.append(make_spacer(2))
    story.append(_build_owner_logo_flowable(owner, styles))
    story.append(make_spacer(3))
    story.append(_build_pdf_reference_block(poste, styles, content_width))
    story.append(make_spacer(1.8))

    mission_lines = _pdf_split_lines(poste.get("mission_principale")) or ["—"]
    story.extend(_build_pdf_plain_block("Mission principale", mission_lines, styles))
    story.append(make_spacer(3.4))

    story.extend(_build_pdf_responsabilites_flowables(poste.get("responsabilites"), styles))
    story.append(make_spacer(4))

    nsf_label = _pdf_first_non_empty(poste.get("nsf_groupe_titre"), poste.get("nsf_groupe_code"))
    if nsf_label and poste.get("nsf_groupe_obligatoire"):
        nsf_label = f"{nsf_label} (obligatoire)"

    contraintes_entries = []
    contraintes_entries.append(("Niveau d’étude minimum", _pdf_niveau_education_label(poste.get("niveau_education_minimum"))))
    if nsf_label:
        contraintes_entries.append(("Domaine du diplôme (NSF)", nsf_label))
    if poste.get("mobilite"):
        contraintes_entries.append(("Mobilité", str(poste.get("mobilite"))))
    if poste.get("risque_physique"):
        contraintes_entries.append(("Risques physiques", str(poste.get("risque_physique"))))
    if poste.get("perspectives_evolution"):
        contraintes_entries.append(("Perspectives d’évolution", str(poste.get("perspectives_evolution"))))
    if poste.get("niveau_contrainte"):
        contraintes_entries.append(("Niveau de contraintes", str(poste.get("niveau_contrainte"))))

    detail_contrainte = _html_to_text(poste.get("detail_contrainte"))
    detail_tuple = ("Détail des contraintes", detail_contrainte) if detail_contrainte else None

    contraintes_title = ParagraphStyle(
        "NsPdfContraintesTitle",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=13,
        spaceAfter=5,
        spaceBefore=0,
        textColor=PDF_TEXT,
    )
    story.append(Paragraph("Contraintes et spécificités", contraintes_title))
    story.append(_build_pdf_property_grid(contraintes_entries, styles, content_width, detail_tuple))

    story.append(PageBreak())
    story.extend(_build_pdf_centered_titles(
        "Compétences et certifications requises",
        "",
        styles,
    ))
    story.append(make_spacer(2))

    comp_section_title = ParagraphStyle(
        "NsPdfCompSectionTitle",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=13,
        spaceAfter=4,
        spaceBefore=0,
        textColor=PDF_TEXT,
    )

    story.append(Paragraph("Compétences", comp_section_title))

    comp_rows = []
    for it in poste.get("competences") or []:
        comp_rows.append([
            _pdf_first_non_empty(it.get("code"), "—") or "—",
            _pdf_first_non_empty(it.get("intitule"), "—") or "—",
            _pdf_niveau_label(it.get("niveau_requis")),
            f"{int(it.get('poids_criticite') or 0)}/100",
        ])
    if not comp_rows:
        comp_rows.append(["—", "Aucune compétence rattachée.", "—", "—"])

    story.append(_build_pdf_rich_table(
        ["Code", "Compétence", "Niveau requis", "Criticité"],
        comp_rows,
        [24 * mm, 94 * mm, 30 * mm, 30 * mm],
        styles,
    ))

    story.append(make_spacer(5))
    story.append(Paragraph("Certifications/Habilitations", comp_section_title))

    cert_rows = []
    for it in poste.get("certifications") or []:
        cert_rows.append([
            _pdf_first_non_empty(it.get("categorie"), "—") or "—",
            _pdf_first_non_empty(it.get("nom_certification"), "—") or "—",
            _pdf_months_label(it.get("validite_override") or it.get("duree_validite")),
            _pdf_exigence_label(it.get("niveau_exigence")),
        ])
    if not cert_rows:
        cert_rows.append(["—", "Aucune certification rattachée.", "—", "—"])

    story.append(_build_pdf_rich_table(
        ["Catégorie", "Certification", "Validité", "Exigence"],
        cert_rows,
        [40 * mm, 92 * mm, 22 * mm, 24 * mm],
        styles,
    ))

    proposition = (dossier or {}).get("proposition_json") or {}
    validation = (dossier or {}).get("validation_json") or {}
    has_ccn = bool(proposition or validation)

    if has_ccn:
        story.append(PageBreak())
        story.extend(_build_pdf_centered_titles(
            "Cotation conventionnelle",
            "",
            styles,
        ))
        story.append(make_spacer(2))

        proposal_meta = proposition.get("proposal") if isinstance(proposition.get("proposal"), dict) else {}
        ia_lines = [
            f"Coefficient proposé : {proposal_meta.get('coefficient') or '—'}",
            f"Palier proposé : {proposal_meta.get('palier') or '—'}",
            f"Catégorie proposée : {proposal_meta.get('categorie_professionnelle') or '—'}",
            f"Points calculés : {proposition.get('total_points') or '—'}",
        ]
        if proposal_meta.get("resume_cotation"):
            ia_lines.append(f"Synthèse de cotation : {proposal_meta.get('resume_cotation')}")
        if proposition.get("justification_globale"):
            ia_lines.append(f"Justification IA : {proposition.get('justification_globale')}")
        if not proposition:
            ia_lines = ["Aucune proposition IA enregistrée."]

        story.extend(_build_pdf_plain_block("Recommandation IA", ia_lines, styles))
        story.append(make_spacer(2))

        rh_lines = [
            f"Coefficient retenu : {validation.get('coefficient') or '—'}",
            f"Palier retenu : {validation.get('palier') or '—'}",
            f"Catégorie retenue : {validation.get('categorie_professionnelle') or '—'}",
        ]
        if validation.get("justification"):
            rh_lines.append(f"Justification RH : {validation.get('justification')}")
        if validation.get("validated_by") or validation.get("validated_at"):
            rh_lines.append(
                f"Validation : {_pdf_first_non_empty(validation.get('validated_by'), '—')} · {_pdf_first_non_empty(validation.get('validated_at'), '—')}"
            )
        if not validation:
            rh_lines = ["Aucune décision RH enregistrée."]

        story.extend(_build_pdf_plain_block("Décision RH", rh_lines, styles))

        crit_rows = []
        for it in proposition.get("criteres") or []:
            crit_rows.append([
                _pdf_first_non_empty(it.get("libelle"), it.get("code"), "Critère") or "Critère",
                f"M{int(it.get('marche') or 0)}",
                str(int(it.get("points") or 0)),
                _pdf_first_non_empty(it.get("justification"), "—") or "—",
            ])
        for it in proposition.get("bonifications") or []:
            crit_rows.append([
                _pdf_first_non_empty(it.get("libelle"), it.get("code"), "Bonification") or "Bonification",
                _pdf_first_non_empty(it.get("niveau_label"), f"M{int(it.get('marche') or 0)}") or "—",
                str(int(it.get("points") or 0)),
                _pdf_first_non_empty(it.get("justification"), "—") or "—",
            ])

        if crit_rows:
            story.append(make_spacer(3))
            story.append(_build_pdf_rich_table(
                ["Critère / bonification", "Niveau", "Points", "Justification"],
                crit_rows,
                [54 * mm, 18 * mm, 18 * mm, 88 * mm],
                styles,
            ))

    return story

def _ref_1516_points_by_code(ref_json: dict, code: str, marche: int) -> tuple[int, str]:
    rows = (ref_json.get("criteres") or []) + (ref_json.get("bonifications") or [])
    row = next((x for x in rows if (x.get("code") or "").strip() == code), None)
    if not row:
        return 0, ""

    for lvl in (row.get("marches") or []):
        if int(lvl.get("marche") or 0) == int(marche or 0):
            return int(lvl.get("points") or 0), str(lvl.get("label") or "").strip()
    return 0, ""


def _find_1516_palier(ref_json: dict, coefficient: int) -> Optional[dict]:
    n = int(coefficient or 0)
    for row in (ref_json.get("paliers") or []):
        coef_min = int(row.get("coef_min") or 0)
        coef_max_raw = row.get("coef_max")
        coef_max = 999999 if coef_max_raw in (None, "") else int(coef_max_raw or 0)
        if n >= coef_min and n <= coef_max:
            return row
    return None


def _compute_1516_category(coefficient: int, criteres: List[dict]) -> str:
    n = int(coefficient or 0)
    if n >= 350:
        return "Cadre"
    if 310 <= n <= 349:
        cond = 0
        for row in criteres or []:
            code = (row.get("code") or "").strip()
            marche = int(row.get("marche") or 0)
            if code == "management" and marche >= 3:
                cond += 1
            elif code == "ampleur_connaissances" and marche >= 4:
                cond += 1
            elif code == "autonomie" and marche >= 6:
                cond += 1
        return "Cadre" if cond >= 2 else "Agent de maîtrise / technicien"
    if n >= 171:
        return "Agent de maîtrise / technicien"
    if n >= 100:
        return "Employé"
    return ""


def _build_1516_analysis(ref_json: dict, ai_data: dict) -> dict:
    criteres = []
    total_points = 0

    for meta in (ref_json.get("criteres") or []):
        code = (meta.get("code") or "").strip()
        row = _ensure_json_dict(ai_data.get(code))
        marche = int(row.get("marche") or 1)
        max_step = max([int(x.get("marche") or 0) for x in (meta.get("marches") or [])] or [1])
        marche = max(1, min(marche, max_step))
        points, _label = _ref_1516_points_by_code(ref_json, code, marche)

        criteres.append(
            {
                "code": code,
                "libelle": meta.get("label"),
                "marche": marche,
                "points": points,
                "justification": _clean_text(row.get("justification")),
            }
        )
        total_points += points

    bonifications = []
    for meta in (ref_json.get("bonifications") or []):
        code = (meta.get("code") or "").strip()
        row = _ensure_json_dict(ai_data.get(code))
        marche = int(row.get("marche") or 0)
        max_step = max([int(x.get("marche") or 0) for x in (meta.get("marches") or [])] or [0])
        marche = max(0, min(marche, max_step))
        points, marche_label = _ref_1516_points_by_code(ref_json, code, marche)

        bonifications.append(
            {
                "code": code,
                "libelle": meta.get("label"),
                "marche": marche,
                "niveau_label": marche_label,
                "points": points,
                "justification": _clean_text(row.get("justification")),
            }
        )
        total_points += points

    palier_row = _find_1516_palier(ref_json, total_points) or {}
    palier = int(palier_row.get("palier") or 0)
    categorie = _compute_1516_category(total_points, criteres)

    return {
        "proposal": {
            "coefficient": total_points,
            "palier": palier,
            "categorie_professionnelle": categorie,
            "resume_cotation": _clean_text(ai_data.get("resume_cotation")),
        },
        "total_points": total_points,
        "criteres": criteres,
        "bonifications": bonifications,
        "justification_globale": _clean_text(ai_data.get("justification_globale")),
        "zones_de_vigilance": [
            _clean_text(x) for x in (ai_data.get("zones_de_vigilance") or []) if _clean_text(x)
        ][:6],
    }


def _make_1516_ai_schema() -> dict:
    def crit_schema(max_marche: int, min_marche: int = 1):
        return {
            "type": "object",
            "additionalProperties": False,
            "required": ["marche", "justification"],
            "properties": {
                "marche": {"type": "integer", "minimum": min_marche, "maximum": max_marche},
                "justification": {"type": "string", "maxLength": 900},
            },
        }

    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "autonomie",
            "management",
            "relationnel",
            "impact",
            "ampleur_connaissances",
            "complexite_savoir_faire",
            "responsabilite_juridique",
            "poste_interfilieres",
            "resume_cotation",
            "justification_globale",
            "zones_de_vigilance",
        ],
        "properties": {
            "autonomie": crit_schema(7),
            "management": crit_schema(8),
            "relationnel": crit_schema(7),
            "impact": crit_schema(4),
            "ampleur_connaissances": crit_schema(6),
            "complexite_savoir_faire": crit_schema(4),
            "responsabilite_juridique": crit_schema(2, 0),
            "poste_interfilieres": crit_schema(2, 0),
            "resume_cotation": {"type": "string", "maxLength": 600},
            "justification_globale": {"type": "string", "maxLength": 2500},
            "zones_de_vigilance": {
                "type": "array",
                "items": {"type": "string", "maxLength": 300},
                "maxItems": 6,
            },
        },
    }


def _make_1516_system_prompt(ref_json: dict) -> str:
    return (
        "Tu es un assistant RH spécialisé dans la cotation conventionnelle des postes. "
        "Tu analyses uniquement la convention fournie par le référentiel JSON transmis. "
        "Tu dois choisir un niveau de marche pour chaque critère classant et chaque bonification. "
        "Tu ne dois jamais inventer une convention, ni citer d'autres textes. "
        "Tu rends uniquement un JSON strict conforme au schéma demandé. "
        "Tu raisonnes de façon prudente et justifiée, en t'appuyant sur le contenu réel du poste. "
        "Quand l'information est insuffisante, tu choisis le niveau le plus plausible mais tu le signales dans la justification globale et dans les zones_de_vigilance. "
        "Référentiel conventionnel à appliquer : "
        + json.dumps(ref_json, ensure_ascii=False)
    )


def _make_1516_user_prompt(poste: dict) -> str:
    payload = {
        "code_poste": poste.get("code_poste"),
        "intitule_poste": poste.get("intitule_poste"),
        "service": poste.get("nom_service"),
        "mission_principale": poste.get("mission_principale"),
        "responsabilites_text": poste.get("responsabilites_text"),
        "niveau_contrainte": poste.get("niveau_contrainte"),
        "mobilite": poste.get("mobilite"),
        "perspectives_evolution": poste.get("perspectives_evolution"),
        "risque_physique": poste.get("risque_physique"),
        "detail_contrainte": poste.get("detail_contrainte"),
        "niveau_education_minimum": poste.get("niveau_education_minimum"),
        "nsf_groupe_code": poste.get("nsf_groupe_code"),
        "nsf_groupe_obligatoire": poste.get("nsf_groupe_obligatoire"),
        "competences": poste.get("competences"),
        "certifications": poste.get("certifications"),
    }
    return (
        "Analyse ce poste et propose une cotation conventionnelle justifiée. "
        "Base-toi uniquement sur les informations ci-dessous.\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )

def _find_3248_class_group(ref_json: dict, cotation: int) -> Optional[dict]:
    n = int(cotation or 0)
    for row in (ref_json.get("classification_map") or []):
        pts_min = int(row.get("points_min") or 0)
        pts_max = int(row.get("points_max") or 0)
        if n >= pts_min and n <= pts_max:
            return row
    return None


def _compute_3248_category(group_letter: str, ref_json: dict) -> str:
    grp = (group_letter or "").strip().upper()
    if not grp:
        return ""
    cadre_groups = {str(x).strip().upper() for x in (ref_json.get("cadre_groups") or ["F", "G", "H", "I"])}
    statut = "Cadre" if grp in cadre_groups else "Non-cadre"
    return f"Groupe {grp} · {statut}"


def _build_3248_analysis(ref_json: dict, ai_data: dict) -> dict:
    criteres = []
    total_points = 0

    for meta in (ref_json.get("criteres") or []):
        code = (meta.get("code") or "").strip()
        row = _ensure_json_dict(ai_data.get(code))
        degre = int(row.get("degre") or row.get("marche") or 1)
        degre = max(1, min(degre, 10))

        criteres.append(
            {
                "code": code,
                "libelle": meta.get("label"),
                "marche": degre,
                "points": degre,
                "justification": _clean_text(row.get("justification")),
            }
        )
        total_points += degre

    band = _find_3248_class_group(ref_json, total_points) or {}
    classe = int(band.get("classe") or 0)
    groupe = (band.get("groupe") or "").strip().upper()
    categorie = _compute_3248_category(groupe, ref_json)

    return {
        "proposal": {
            "coefficient": total_points,
            "palier": classe,
            "categorie_professionnelle": categorie,
            "resume_cotation": _clean_text(ai_data.get("resume_cotation")),
            "groupe_emploi": groupe,
            "classe_emploi": classe,
        },
        "total_points": total_points,
        "criteres": criteres,
        "bonifications": [],
        "justification_globale": _clean_text(ai_data.get("justification_globale")),
        "zones_de_vigilance": [
            _clean_text(x) for x in (ai_data.get("zones_de_vigilance") or []) if _clean_text(x)
        ][:6],
    }


def _make_3248_ai_schema() -> dict:
    def crit_schema():
        return {
            "type": "object",
            "additionalProperties": False,
            "required": ["degre", "justification"],
            "properties": {
                "degre": {"type": "integer", "minimum": 1, "maximum": 10},
                "justification": {"type": "string", "maxLength": 900},
            },
        }

    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "complexite_activite",
            "connaissances",
            "autonomie",
            "contribution",
            "encadrement_cooperation",
            "communication",
            "resume_cotation",
            "justification_globale",
            "zones_de_vigilance",
        ],
        "properties": {
            "complexite_activite": crit_schema(),
            "connaissances": crit_schema(),
            "autonomie": crit_schema(),
            "contribution": crit_schema(),
            "encadrement_cooperation": crit_schema(),
            "communication": crit_schema(),
            "resume_cotation": {"type": "string", "maxLength": 600},
            "justification_globale": {"type": "string", "maxLength": 2500},
            "zones_de_vigilance": {
                "type": "array",
                "items": {"type": "string", "maxLength": 300},
                "maxItems": 6,
            },
        },
    }


def _make_3248_system_prompt(ref_json: dict) -> str:
    return (
        "Tu es un assistant RH spécialisé dans la cotation conventionnelle des postes. "
        "Tu analyses uniquement la convention fournie par le référentiel JSON transmis. "
        "Pour l'IDCC 3248 métallurgie, tu dois choisir un degré de 1 à 10 pour chacun des six critères classants. "
        "Le nombre de points attribué à chaque critère est égal au degré retenu. "
        "La somme des six degrés donne la cotation finale. "
        "Cette cotation détermine ensuite une classe d'emploi et un groupe d'emploi. "
        "Pour le critère 'connaissances', le niveau de diplôme éventuel n'est qu'un indice et ne crée aucun droit automatique ; tu raisonnes d'abord sur les connaissances réellement nécessaires à l'emploi. "
        "Tu ne dois jamais inventer une convention, ni citer d'autres textes. "
        "Tu rends uniquement un JSON strict conforme au schéma demandé. "
        "Quand l'information est insuffisante, tu choisis le degré le plus plausible mais tu le signales dans la justification globale et dans les zones_de_vigilance. "
        "Référentiel conventionnel à appliquer : "
        + json.dumps(ref_json, ensure_ascii=False)
    )


def _make_3248_user_prompt(poste: dict) -> str:
    payload = {
        "code_poste": poste.get("code_poste"),
        "intitule_poste": poste.get("intitule_poste"),
        "service": poste.get("nom_service"),
        "mission_principale": poste.get("mission_principale"),
        "responsabilites_text": poste.get("responsabilites_text"),
        "niveau_contrainte": poste.get("niveau_contrainte"),
        "mobilite": poste.get("mobilite"),
        "perspectives_evolution": poste.get("perspectives_evolution"),
        "risque_physique": poste.get("risque_physique"),
        "detail_contrainte": poste.get("detail_contrainte"),
        "niveau_education_minimum": poste.get("niveau_education_minimum"),
        "nsf_groupe_code": poste.get("nsf_groupe_code"),
        "nsf_groupe_obligatoire": poste.get("nsf_groupe_obligatoire"),
        "competences": poste.get("competences"),
        "certifications": poste.get("certifications"),
    }
    return (
        "Analyse ce poste selon la convention métallurgie IDCC 3248. "
        "Attribue un degré de 1 à 10 à chacun des six critères classants. "
        "Base-toi uniquement sur les informations ci-dessous.\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )
# ------------------------------------------------------
# Models
# ------------------------------------------------------
class CreateServicePayload(BaseModel):
    nom_service: str
    id_service_parent: Optional[str] = None


class UpdateServicePayload(BaseModel):
    nom_service: Optional[str] = None
    id_service_parent: Optional[str] = None


class AssignPostePayload(BaseModel):
    id_poste: str
    id_service: str


class DetachPostePayload(BaseModel):
    id_poste: str

class CreatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None  # ignoré (auto)
    codif_client: Optional[str] = None
    intitule_poste: str
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None

    # Exigences > Contraintes
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    # Paramétrage RH
    statut_poste: Optional[str] = None
    date_debut_validite: Optional[str] = None
    date_fin_validite: Optional[str] = None
    nb_titulaires_cible: Optional[int] = None
    criticite_poste: Optional[int] = None
    strategie_pourvoi: Optional[str] = None
    param_rh_verrouille: Optional[bool] = None
    param_rh_commentaire: Optional[str] = None


class UpdatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None  # interdit (lock serveur)
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None

    # Exigences > Contraintes
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    # Paramétrage RH
    statut_poste: Optional[str] = None
    date_debut_validite: Optional[str] = None
    date_fin_validite: Optional[str] = None
    nb_titulaires_cible: Optional[int] = None
    criticite_poste: Optional[int] = None
    strategie_pourvoi: Optional[str] = None
    param_rh_verrouille: Optional[bool] = None
    param_rh_commentaire: Optional[str] = None


class ArchivePosteOrgPayload(BaseModel):
    # archive=True => actif FALSE ; archive=False => actif TRUE (restauration)
    archive: bool = True


class DuplicatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None

class UpsertPosteCompetencePayload(BaseModel):
    id_competence: str
    niveau_requis: str  # A/B/C
    freq_usage: Optional[int] = 0        # 0..10
    impact_resultat: Optional[int] = 0   # 0..10
    dependance: Optional[int] = 0        # 0..10

class UpsertPosteCertificationPayload(BaseModel):
    id_certification: str
    validite_override: Optional[int] = None
    niveau_exigence: Optional[str] = "requis"
    commentaire: Optional[str] = None

class CreateCertificationPayload(BaseModel):
    nom_certification: str
    description: Optional[str] = None
    categorie: Optional[str] = None
    duree_validite: Optional[int] = None
    delai_renouvellement: Optional[int] = None

class AiPosteDraftPayload(BaseModel):
    mode: Optional[str] = "create"
    id_poste: Optional[str] = None
    current_intitule_poste: Optional[str] = None
    current_mission_principale: Optional[str] = None
    current_responsabilites_html: Optional[str] = None
    intitule: str
    contexte: Optional[str] = None
    taches: Optional[str] = None
    outils: Optional[str] = None
    environnement: Optional[str] = None
    interactions: Optional[str] = None
    contraintes: Optional[str] = None


class AiPosteCompetenceSearchPayload(BaseModel):
    id_poste: Optional[str] = None
    intitule_poste: Optional[str] = None
    mission_principale: Optional[str] = None
    responsabilites_html: Optional[str] = None
    ai_contexte: Optional[str] = None
    ai_taches: Optional[str] = None
    ai_outils: Optional[str] = None
    ai_environnement: Optional[str] = None
    ai_interactions: Optional[str] = None
    ai_contraintes: Optional[str] = None
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None
    existing_competence_ids: Optional[List[str]] = None


class AiPosteCompetenceCreatePayload(BaseModel):
    id_poste: Optional[str] = None
    draft: dict
    add_to_poste: Optional[bool] = True

class SavePosteCcnDecisionPayload(BaseModel):
    coefficient_retenu: int
    justification_retenue: str
    proposition_json: Optional[dict] = None

@router.post("/studio/org/postes/{id_owner}/import_document")
def studio_org_import_poste_document(id_owner: str, request: Request, file: UploadFile = File(...)):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        oid = (id_owner or "").strip()
        filename = _clean_text(getattr(file, "filename", "") or "document")
        raw = file.file.read() if file and file.file else b""

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, oid)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

        ext, extracted_text = _extract_poste_import_text(filename, raw)

        model = (
            (os.getenv("OPENAI_MODEL_POSTE_IMPORT") or "").strip()
            or (os.getenv("OPENAI_MODEL_POSTE_DRAFT") or "").strip()
            or "gpt-5"
        )

        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "intitule_poste", "mission_principale", "responsabilites_html",
                "niveau_education_minimum", "nsf_groupe_code", "nsf_groupe_obligatoire",
                "mobilite", "risque_physique", "perspectives_evolution",
                "niveau_contrainte", "detail_contrainte"
            ],
            "properties": {
                "intitule_poste": {"type": "string", "minLength": 1, "maxLength": 180},
                "mission_principale": {"type": "string", "maxLength": 2400},
                "responsabilites_html": {"type": "string", "maxLength": 16000},
                "niveau_education_minimum": {"type": "string", "maxLength": 4},
                "nsf_groupe_code": {"type": "string", "maxLength": 12},
                "nsf_groupe_obligatoire": {"type": "boolean"},
                "mobilite": {"type": "string", "maxLength": 30},
                "risque_physique": {"type": "string", "maxLength": 20},
                "perspectives_evolution": {"type": "string", "maxLength": 20},
                "niveau_contrainte": {"type": "string", "maxLength": 20},
                "detail_contrainte": {"type": "string", "maxLength": 2400},
            },
        }

        system_prompt = (
            "Tu extrais et restructures une fiche de poste existante en français. "
            "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
            "Tu ne dois pas inventer d'information absente du document. "
            "Si une donnée n'est pas clairement identifiable, renvoie une chaîne vide ou false. "
            "intitule_poste doit reprendre l’intitulé le plus probable du poste décrit. "
            "mission_principale doit être une synthèse propre et exploitable du document. "
            "responsabilites_html doit être du HTML simple, propre, directement exploitable: "
            "un <ol> contenant plusieurs <li>, chaque <li> commençant par un titre de responsabilité en gras, "
            "puis un <ul> d'activités si le document le permet. "
            "Valeurs autorisées: niveau_education_minimum parmi '',0,3,4,5,6,7,8 ; "
            "mobilite parmi '',Aucune,Rare,Occasionnelle,Fréquente ; "
            "risque_physique parmi '',Aucun,Faible,Modéré,Élevé,Critique ; "
            "perspectives_evolution parmi '',Aucune,Faible,Modérée,Forte,Rapide ; "
            "niveau_contrainte parmi '',Aucune,Modérée,Élevée,Critique. "
            "nsf_groupe_code doit rester vide sauf si le document mentionne explicitement un code ou un élément très certain. "
            "detail_contrainte doit reprendre les contraintes concrètes, sans blabla."
        )

        user_prompt = (
            f"Nom du fichier : {filename}\n"
            f"Extension : {ext}\n\n"
            f"Contenu extrait du document :\n{extracted_text}"
        )

        data = _openai_responses_json(
            model,
            "poste_import_document",
            schema,
            system_prompt,
            user_prompt,
            use_web=False
        )

        data["niveau_education_minimum"] = (data.get("niveau_education_minimum") or "").strip()
        data["nsf_groupe_code"] = (data.get("nsf_groupe_code") or "").strip()

        allowed_edu = {"", "0", "3", "4", "5", "6", "7", "8"}
        allowed_mob = {"", "Aucune", "Rare", "Occasionnelle", "Fréquente"}
        allowed_risk = {"", "Aucun", "Faible", "Modéré", "Élevé", "Critique"}
        allowed_persp = {"", "Aucune", "Faible", "Modérée", "Forte", "Rapide"}
        allowed_ctr = {"", "Aucune", "Modérée", "Élevée", "Critique"}

        if data["niveau_education_minimum"] not in allowed_edu:
            data["niveau_education_minimum"] = ""
        if (data.get("mobilite") or "") not in allowed_mob:
            data["mobilite"] = ""
        if (data.get("risque_physique") or "") not in allowed_risk:
            data["risque_physique"] = ""
        if (data.get("perspectives_evolution") or "") not in allowed_persp:
            data["perspectives_evolution"] = ""
        if (data.get("niveau_contrainte") or "") not in allowed_ctr:
            data["niveau_contrainte"] = ""
        if len(data["nsf_groupe_code"]) > 12:
            data["nsf_groupe_code"] = ""

        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes import_document error: {e}")

@router.post("/studio/org/postes/{id_owner}/ai_draft")
def studio_org_ai_draft_poste(id_owner: str, payload: AiPosteDraftPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        oid = (id_owner or "").strip()
        title = (payload.intitule or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        model = (os.getenv("OPENAI_MODEL_POSTE_DRAFT") or "gpt-5").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, oid)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT code, titre
                    FROM public.tbl_nsf_groupe
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY code
                    """
                )
                nsf_rows = cur.fetchall() or []

        nsf_txt = "\n".join([f"- {r.get('code')} : {r.get('titre')}" for r in nsf_rows]) or "- aucune donnée"
        mode = (payload.mode or "create").strip().lower()
        current_resp = _html_to_text(payload.current_responsabilites_html)

        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "intitule_poste", "mission_principale", "responsabilites_html",
                "niveau_education_minimum", "nsf_groupe_code", "nsf_groupe_obligatoire",
                "mobilite", "risque_physique", "perspectives_evolution",
                "niveau_contrainte", "detail_contrainte"
            ],
            "properties": {
                "intitule_poste": {"type": "string", "minLength": 1, "maxLength": 180},
                "mission_principale": {"type": "string", "maxLength": 2400},
                "responsabilites_html": {"type": "string", "maxLength": 16000},
                "niveau_education_minimum": {"type": "string", "maxLength": 4},
                "nsf_groupe_code": {"type": "string", "maxLength": 12},
                "nsf_groupe_obligatoire": {"type": "boolean"},
                "mobilite": {"type": "string", "maxLength": 30},
                "risque_physique": {"type": "string", "maxLength": 20},
                "perspectives_evolution": {"type": "string", "maxLength": 20},
                "niveau_contrainte": {"type": "string", "maxLength": 20},
                "detail_contrainte": {"type": "string", "maxLength": 2400},
            },
        }

        system_prompt = (
            "Tu rédiges des fiches de poste RH opérationnelles en français. "
            "Tu dois produire un JSON STRICTEMENT conforme au schéma fourni. "
            "Tu t'appuies sur les éléments utilisateur ET sur une recherche web. "
            "Si mode=edit, tu proposes des textes de remplacement plus propres et plus solides sans changer le métier cible. "
            "La mission principale doit être rédigée en 1 paragraphe clair. "
            "responsabilites_html doit être du HTML simple, propre et directement exploitable: "
            "un <ol> contenant plusieurs <li>, chaque <li> commençant par un titre de tâche en gras, puis un <ul> d'activités rattachées. "
            "Les contraintes doivent rester prudentes: n'invente pas un diplôme ou un domaine NSF si ce n'est pas assez clair. "
            "Valeurs autorisées: niveau_education_minimum parmi '',0,3,4,5,6,7,8 ; mobilite parmi '',Aucune,Rare,Occasionnelle,Fréquente ; "
            "risque_physique parmi '',Aucun,Faible,Modéré,Élevé,Critique ; perspectives_evolution parmi '',Aucune,Faible,Modérée,Forte,Rapide ; "
            "niveau_contrainte parmi '',Aucune,Modérée,Élevée,Critique. "
            "nsf_groupe_code doit être vide ou reprendre exactement un code fourni dans la liste NSF. "
            "detail_contrainte doit synthétiser les contraintes concrètes du poste, sans blabla marketing."
        )

        user_prompt = (
            f"mode={mode}\n"
            f"intitule visé: {title}\n\n"
            f"fiche actuelle - intitulé: {(payload.current_intitule_poste or '').strip()}\n"
            f"fiche actuelle - mission: {(payload.current_mission_principale or '').strip()}\n"
            f"fiche actuelle - responsabilités (texte): {current_resp}\n\n"
            f"contexte: {(payload.contexte or '').strip()}\n"
            f"tâches: {(payload.taches or '').strip()}\n"
            f"outils: {(payload.outils or '').strip()}\n"
            f"environnement: {(payload.environnement or '').strip()}\n"
            f"interactions: {(payload.interactions or '').strip()}\n"
            f"contraintes / vigilance: {(payload.contraintes or '').strip()}\n\n"
            f"Liste NSF disponible (code : titre):\n{nsf_txt}\n"
        )

        data = _openai_responses_json(model, "poste_draft", schema, system_prompt, user_prompt, use_web=True)
        data["niveau_education_minimum"] = (data.get("niveau_education_minimum") or "").strip()
        data["nsf_groupe_code"] = (data.get("nsf_groupe_code") or "").strip()
        allowed_edu = {"", "0", "3", "4", "5", "6", "7", "8"}
        allowed_mob = {"", "Aucune", "Rare", "Occasionnelle", "Fréquente"}
        allowed_risk = {"", "Aucun", "Faible", "Modéré", "Élevé", "Critique"}
        allowed_persp = {"", "Aucune", "Faible", "Modérée", "Forte", "Rapide"}
        allowed_ctr = {"", "Aucune", "Modérée", "Élevée", "Critique"}
        if data["niveau_education_minimum"] not in allowed_edu:
            data["niveau_education_minimum"] = ""
        if (data.get("mobilite") or "") not in allowed_mob:
            data["mobilite"] = ""
        if (data.get("risque_physique") or "") not in allowed_risk:
            data["risque_physique"] = ""
        if (data.get("perspectives_evolution") or "") not in allowed_persp:
            data["perspectives_evolution"] = ""
        if (data.get("niveau_contrainte") or "") not in allowed_ctr:
            data["niveau_contrainte"] = ""
        nsf_codes = {str(r.get("code") or "").strip() for r in nsf_rows}
        if data["nsf_groupe_code"] not in nsf_codes:
            data["nsf_groupe_code"] = ""
        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_draft error: {e}")


@router.post("/studio/org/postes/{id_owner}/ai_comp_search")
def studio_org_ai_comp_search(id_owner: str, payload: AiPosteCompetenceSearchPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        model = (os.getenv("OPENAI_MODEL_POSTE_COMP_SEARCH") or "gpt-5").strip()
        existing_ids = {str(x).strip() for x in (payload.existing_competence_ids or []) if str(x).strip()}
        title = _clean_text(payload.intitule_poste)

        if not title and payload.id_poste:
            with get_conn() as conn:
                with conn.cursor(row_factory=dict_row) as cur:
                    oid = _require_owner_access(cur, u, id_owner)
                    studio_fetch_owner(cur, oid)
                    studio_require_min_role(cur, u, oid, "admin")

                    scope_ent = _resolve_org_scope_ent(cur, oid, request)
                    poste_ent = _resolve_poste_ent(cur, oid, payload.id_poste)

                    if poste_ent != scope_ent:
                        raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                    cur.execute(
                        """
                        SELECT intitule_poste, mission_principale, responsabilites
                        FROM public.tbl_fiche_poste
                        WHERE id_poste = %s
                          AND id_owner = %s
                          AND id_ent = %s
                        LIMIT 1
                        """,
                        (payload.id_poste, oid, poste_ent),
                    )
                    row = cur.fetchone() or {}
                    title = _clean_text(row.get("intitule_poste"))
                    if not payload.mission_principale:
                        payload.mission_principale = row.get("mission_principale")
                    if not payload.responsabilites_html:
                        payload.responsabilites_html = row.get("responsabilites")

        if not title:
            raise HTTPException(status_code=400, detail="Intitulé du poste obligatoire pour la recherche IA.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT id_domaine_competence, titre, titre_court, couleur
                    FROM public.tbl_domaine_competence
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre_court, titre, id_domaine_competence))
                    """
                )
                domain_rows = cur.fetchall() or []

        domain_txt = "\n".join([
            f"- {(r.get('titre_court') or r.get('titre') or '').strip()}"
            for r in domain_rows
            if (r.get("titre_court") or r.get("titre") or "").strip()
        ]) or "- aucun domaine"

        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["competences"],
            "properties": {
                "competences": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 40,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": [
                            "intitule",
                            "description",
                            "search_terms",
                            "recommended_level",
                            "freq_usage",
                            "impact_resultat",
                            "dependance",
                            "domaine_hint"
                        ],
                        "properties": {
                            "intitule": {"type": "string", "minLength": 1, "maxLength": 140},
                            "description": {"type": "string", "maxLength": 260},
                            "search_terms": {"type": "array", "minItems": 1, "maxItems": 4, "items": {"type": "string", "maxLength": 80}},
                            "recommended_level": {"type": "string", "enum": ["A", "B", "C"]},
                            "freq_usage": {"type": "integer", "minimum": 0, "maximum": 10},
                            "impact_resultat": {"type": "integer", "minimum": 0, "maximum": 10},
                            "dependance": {"type": "integer", "minimum": 0, "maximum": 10},
                            "domaine_hint": {"type": "string", "maxLength": 120}
                        }
                    }
                }
            }
        }

        domain_by_id = {
            _clean_text(r.get("id_domaine_competence")): r
            for r in (domain_rows or [])
            if _clean_text(r.get("id_domaine_competence"))
        }

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                catalog_rows = _load_owner_comp_catalog_rows(cur, oid)

        def _collect_results(candidate_items: List[dict], allow_relaxed_filter: bool = False) -> tuple[list, list]:
            existing = []
            missing = []
            seen_ids = set()
            seen_titles = set()

            for raw_item in candidate_items or []:
                item = dict(raw_item or {})
                _normalize_ai_comp_search_item(item)

                intitule = _clean_text(item.get("intitule"))
                if not intitule:
                    continue

                fu = _clamp_0_10(item.get("freq_usage"))
                im = _clamp_0_10(item.get("impact_resultat"))
                de = _clamp_0_10(item.get("dependance"))

                keep = _should_keep_ai_comp_for_poste(title, item)
                if not keep and allow_relaxed_filter:
                    # Fallback : on reste sélectif, mais on évite qu'une passe IA
                    # un peu prudente vide totalement le résultat.
                    keep = (max(fu, im, de) >= 4) or ((fu + im + de) >= 10)

                if not keep:
                    continue

                canon_title = _canonical_comp_key(intitule) or _norm_text_search(intitule)
                if canon_title in seen_titles:
                    continue
                seen_titles.add(canon_title)

                search_terms = [str(x or "").strip() for x in (item.get("search_terms") or []) if str(x or "").strip()]
                match = _find_best_existing_competence_in_rows(catalog_rows, intitule, search_terms)

                lvl = (item.get("recommended_level") or "A").strip().upper()[:1] or "A"
                poids = _calc_poids_criticite_100(fu, im, de)

                match_id = str(match.get("id_comp") or "") if match else ""
                if match_id and match_id in existing_ids:
                    continue

                if match and match_id not in seen_ids:
                    seen_ids.add(match_id)
                    existing.append({
                        "id_comp": match.get("id_comp"),
                        "code": match.get("code"),
                        "intitule": match.get("intitule"),
                        "etat": match.get("etat"),
                        "domaine_titre_court": match.get("domaine_titre_court"),
                        "domaine_couleur": match.get("domaine_couleur"),
                        "recommended_level": lvl,
                        "recommended_level_label": {"A": "Initial", "B": "Avancé", "C": "Expert"}.get(lvl, lvl),
                        "freq_usage": fu,
                        "impact_resultat": im,
                        "dependance": de,
                        "poids_criticite": poids,
                    })
                else:
                    domaine_id = _resolve_domain_id_from_rows(domain_rows, item.get("domaine_hint"))
                    dom_meta = domain_by_id.get(_clean_text(domaine_id)) if domaine_id else None
                    domaine_label = _clean_text((dom_meta or {}).get("titre_court") or (dom_meta or {}).get("titre") or "")
                    domaine_couleur = (dom_meta or {}).get("couleur")

                    missing.append({
                        "intitule": intitule,
                        "description": _clean_ai_comp_text(item.get("description"), 320),
                        "why_needed": _clean_ai_comp_text(item.get("why_needed"), 320),
                        "domaine_id": domaine_id,
                        "domaine_label": _clean_ai_comp_text(domaine_label or "", 80),
                        "domaine_couleur": domaine_couleur,
                        "recommended_level": lvl,
                        "recommended_level_label": {"A": "Initial", "B": "Avancé", "C": "Expert"}.get(lvl, lvl),
                        "freq_usage": fu,
                        "impact_resultat": im,
                        "dependance": de,
                        "poids_criticite": poids,
                        "search_terms": search_terms,
                        "niveaua": _clean_ai_comp_text(item.get("niveaua"), 280),
                        "niveaub": _clean_ai_comp_text(item.get("niveaub"), 280),
                        "niveauc": _clean_ai_comp_text(item.get("niveauc"), 280),
                        "grille_evaluation": _sanitize_grille(item.get("grille_evaluation")),
                    })

            return existing, missing

        for pass_idx in range(2):
            system_prompt, user_prompt = _build_ai_comp_search_prompts(
                payload,
                title,
                domain_txt,
                fallback_mode=(pass_idx == 1),
            )

            drafted = _openai_responses_json(
                model,
                "poste_comp_search",
                schema,
                system_prompt,
                user_prompt,
                use_web=False,
            )
            drafted_items = drafted.get("competences") or []

            existing, missing = _collect_results(
                drafted_items,
                allow_relaxed_filter=(pass_idx == 1),
            )
            if existing or missing:
                return {"existing": existing, "missing": missing}

        return {"existing": [], "missing": []}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_comp_search error: {e}")


@router.post("/studio/org/postes/{id_owner}/ai_comp_create")
def studio_org_ai_comp_create(id_owner: str, payload: AiPosteCompetenceCreatePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        add_to_poste = bool(payload.add_to_poste if payload.add_to_poste is not None else True)
        pid = (payload.id_poste or "").strip()
        draft = dict(payload.draft or {})
        title = (draft.get("intitule") or "").strip()

        if add_to_poste and not pid:
            raise HTTPException(status_code=400, detail="id_poste obligatoire.")
        if not title:
            raise HTTPException(status_code=400, detail="Brouillon de compétence invalide (intitulé manquant).")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if add_to_poste:
                    scope_ent = _resolve_org_scope_ent(cur, oid, request)
                    poste_ent = _resolve_poste_ent(cur, oid, pid)

                    if poste_ent != scope_ent:
                        raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                    if not _poste_exists(cur, oid, poste_ent, pid):
                        raise HTTPException(status_code=404, detail="Poste introuvable.")

                search_terms = [
                    str(x or "").strip()
                    for x in (draft.get("search_terms") or [])
                    if str(x or "").strip()
                ]
                match = _find_best_existing_competence(cur, oid, title, search_terms)

                if match:
                    cid = match.get("id_comp")
                    code = match.get("code")
                    created = False
                else:
                    if _draft_needs_ai_enrichment(draft):
                        cur.execute(
                            """
                            SELECT id_domaine_competence, titre, titre_court, couleur
                            FROM public.tbl_domaine_competence
                            WHERE COALESCE(masque, FALSE) = FALSE
                            ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre_court, titre, id_domaine_competence))
                            """
                        )
                        domain_rows = cur.fetchall() or []
                        enrich_model = (
                            (os.getenv("OPENAI_MODEL_POSTE_COMP_CREATE") or "").strip()
                            or (os.getenv("OPENAI_MODEL_POSTE_COMP_SEARCH") or "").strip()
                            or "gpt-5"
                        )
                        draft = _enrich_ai_comp_draft(enrich_model, draft, domain_rows)

                    _normalize_ai_comp_item(draft)
                    title = (draft.get("intitule") or title).strip()

                    search_terms = [
                        str(x or "").strip()
                        for x in (draft.get("search_terms") or [])
                        if str(x or "").strip()
                    ]
                    match_after = _find_best_existing_competence(cur, oid, title, search_terms)

                    if match_after:
                        cid = match_after.get("id_comp")
                        code = match_after.get("code")
                        created = False
                    else:
                        cur.execute(
                            """
                            SELECT id_comp, code
                            FROM public.tbl_competence
                            WHERE id_owner = %s
                              AND lower(intitule) = lower(%s)
                            LIMIT 1
                            """,
                            (oid, title),
                        )
                        existing = cur.fetchone() or None

                        if existing:
                            cid = existing.get("id_comp")
                            code = existing.get("code")
                            created = False
                        else:
                            cid = str(uuid.uuid4())
                            code = _next_comp_code(cur, oid)

                            grille_obj = _compact_ai_grille(
                                _sanitize_grille(draft.get("grille_evaluation")),
                                draft.get("freq_usage"),
                                draft.get("impact_resultat"),
                                draft.get("dependance"),
                            )
                            grille_json = json.dumps(grille_obj, ensure_ascii=False)

                            cur.execute(
                                """
                                INSERT INTO public.tbl_competence
                                  (id_comp, id_owner, code, intitule, description, domaine, niveaua, niveaub, niveauc, grille_evaluation, etat, masque, date_creation, date_modification)
                                VALUES
                                  (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW(), NOW())
                                """,
                                (
                                    cid,
                                    oid,
                                    code,
                                    title,
                                    (draft.get("description") or None),
                                    (draft.get("domaine_id") or None),
                                    (draft.get("niveaua") or None),
                                    (draft.get("niveaub") or None),
                                    (draft.get("niveauc") or None),
                                    grille_json,
                                    (draft.get("etat") or "à valider"),
                                ),
                            )
                            created = True

                if add_to_poste:
                    _upsert_poste_comp_assoc(
                        cur,
                        pid,
                        cid,
                        (draft.get("recommended_level") or "A"),
                        draft.get("freq_usage") or 0,
                        draft.get("impact_resultat") or 0,
                        draft.get("dependance") or 0,
                    )

                conn.commit()

        return {
            "ok": True,
            "created": created,
            "added_to_poste": add_to_poste,
            "id_comp": cid,
            "code": code,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes ai_comp_create error: {e}")


@router.get("/studio/org/organigramme_pdf/{id_owner}")
def studio_org_get_organigramme_pdf(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                data = _fetch_organigramme_data(cur, oid, scope_ent)
                logo_bytes = _fetch_owner_logo_bytes(cur, oid)

        pdf_bytes = _build_organigramme_pdf(scope_ent, data, logo_bytes)
        filename = f'organigramme_{(scope_ent or "organisation").strip()}.pdf'

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
        raise HTTPException(status_code=500, detail=f"studio/org/organigramme_pdf error: {e}")

@router.get("/studio/org/postes/{id_owner}/{id_poste}/fiche_pdf")
def studio_org_get_poste_fiche_pdf(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                owner = studio_fetch_owner(cur, oid) or {}

                pid = (id_poste or "").strip()
                if not pid:
                    raise HTTPException(status_code=400, detail="id_poste manquant.")

                poste = _fetch_poste_for_ccn(cur, oid, pid)
                dossier = _fetch_poste_ccn_dossier(cur, pid)
                logo_bytes = _fetch_owner_logo_bytes(cur, oid)

                owner_ctx = _fetch_owner_idcc(cur, oid)
                idcc = (owner_ctx.get("idcc") or "").strip()
                referential = _fetch_ccn_referential(cur, idcc) if idcc else None

        ref_poste = _pdf_first_non_empty(
            poste.get("code_poste"),
            poste.get("codif_client"),
            poste.get("codif_poste"),
            pid,
        ) or "Poste"

        intitule_poste = _pdf_first_non_empty(
            poste.get("intitule_poste"),
            "Poste"
        ) or "Poste"

        maj_label = _pdf_format_footer_date(poste.get("poste_date_maj")) if "poste_date_maj" in poste else ""
        footer_parts = []
        if maj_label:
            footer_parts.append(f"Dernière mise à jour du poste : {maj_label}")
        footer_parts.append("Novoskill Studio")
        footer_parts.append("Fiche de poste complète")

        filename = f"Fiche de poste {ref_poste} - {intitule_poste}.pdf"
        filename = _pdf_latin1_safe(filename)

        pdf_bytes = build_pdf_document(
            _build_poste_pdf_story(owner, poste, dossier, referential),
            meta={
                "title": _pdf_latin1_safe(f"Fiche de poste - {intitule_poste}"),
                "doc_label": _pdf_latin1_safe("Fiche de poste complète"),
                "footer_left": _pdf_latin1_safe(" • ".join(footer_parts) if footer_parts else "Novoskill Studio"),
                "logo_bytes": logo_bytes,
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
        raise HTTPException(status_code=500, detail=f"studio/org/postes fiche_pdf error: {e}")

@router.get("/studio/org/postes/{id_owner}/{id_poste}/ccn_context")
def studio_org_poste_ccn_context(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                pid = (id_poste or "").strip()
                if not pid:
                    raise HTTPException(status_code=400, detail="id_poste manquant.")

                owner_ctx = _fetch_owner_idcc(cur, oid)
                poste = _fetch_poste_for_ccn(cur, oid, pid)
                dossier = _fetch_poste_ccn_dossier(cur, pid)

                idcc = (owner_ctx.get("idcc") or "").strip()
                referential = _fetch_ccn_referential(cur, idcc) if idcc else None
                ref_json = referential.get("referentiel_json") if referential else {}

                supported = bool(referential and idcc in ("1516", "3248"))
                support_message = ""
                if not idcc:
                    support_message = "Aucune convention collective détectée sur l’entreprise."
                elif not supported:
                    support_message = f"Convention détectée (IDCC {idcc}) non encore supportée par l’assistant."

        return {
            "supported": supported,
            "support_message": support_message,
            "idcc": idcc,
            "convention_label": referential.get("convention_label") if referential else "",
            "version_label": referential.get("version_label") if referential else "",
            "id_referentiel_ccn": referential.get("id_referentiel_ccn") if referential else "",
            "referential": ref_json if supported else {},
            "poste": poste,
            "dossier": dossier or None,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste ccn context error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/ccn_assistant/propose")
def studio_org_poste_ccn_propose(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                pid = (id_poste or "").strip()
                if not pid:
                    raise HTTPException(status_code=400, detail="id_poste manquant.")

                owner_ctx = _fetch_owner_idcc(cur, oid)
                idcc = (owner_ctx.get("idcc") or "").strip()
                if idcc not in ("1516", "3248"):
                    raise HTTPException(status_code=400, detail=f"Convention non supportée pour l’assistant (IDCC détecté : {idcc or 'aucun'}).")

                referential = _fetch_ccn_referential(cur, idcc)
                if not referential:
                    raise HTTPException(status_code=404, detail="Référentiel conventionnel introuvable.")

                ref_json = referential.get("referentiel_json") or {}
                poste = _fetch_poste_for_ccn(cur, oid, pid)

                model = (os.getenv("OPENAI_MODEL_POSTE_CCN") or "").strip() or "gpt-5"

                if idcc == "1516":
                    ai_data = _openai_responses_json(
                        model=model,
                        schema_name="poste_ccn_1516",
                        schema=_make_1516_ai_schema(),
                        system_prompt=_make_1516_system_prompt(ref_json),
                        user_prompt=_make_1516_user_prompt(poste),
                        use_web=False,
                    )
                    analysis = _build_1516_analysis(ref_json, ai_data)

                elif idcc == "3248":
                    ai_data = _openai_responses_json(
                        model=model,
                        schema_name="poste_ccn_3248",
                        schema=_make_3248_ai_schema(),
                        system_prompt=_make_3248_system_prompt(ref_json),
                        user_prompt=_make_3248_user_prompt(poste),
                        use_web=False,
                    )
                    analysis = _build_3248_analysis(ref_json, ai_data)

                else:
                    raise HTTPException(status_code=400, detail=f"Convention non supportée pour l’assistant (IDCC détecté : {idcc or 'aucun'}).")

        return {"ok": True, "proposition": analysis}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste ccn propose error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/ccn_assistant/save")
def studio_org_poste_ccn_save(id_owner: str, id_poste: str, payload: SavePosteCcnDecisionPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        coefficient = int(payload.coefficient_retenu or 0)
        justification = _clean_text(payload.justification_retenue)
        if not justification:
            raise HTTPException(status_code=400, detail="La justification retenue est obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                pid = (id_poste or "").strip()
                if not pid:
                    raise HTTPException(status_code=400, detail="id_poste manquant.")

                owner_ctx = _fetch_owner_idcc(cur, oid)
                idcc = (owner_ctx.get("idcc") or "").strip()
                if idcc not in ("1516", "3248"):
                    raise HTTPException(status_code=400, detail=f"Convention non supportée pour l’assistant (IDCC détecté : {idcc or 'aucun'}).")

                referential = _fetch_ccn_referential(cur, idcc)
                if not referential:
                    raise HTTPException(status_code=404, detail="Référentiel conventionnel introuvable.")

                dossier = _fetch_poste_ccn_dossier(cur, pid)
                poste = _fetch_poste_for_ccn(cur, oid, pid)
                ref_json = referential.get("referentiel_json") or {}

                proposition = payload.proposition_json if isinstance(payload.proposition_json, dict) else {}
                if not proposition and dossier:
                    proposition = dossier.get("proposition_json") or {}

                criteres = proposition.get("criteres") or []

                if idcc == "1516":
                    if coefficient < 100:
                        raise HTTPException(status_code=400, detail="Le coefficient retenu doit être >= 100.")

                    palier_row = _find_1516_palier(ref_json, coefficient) or {}
                    palier = int(palier_row.get("palier") or 0)
                    categorie = _compute_1516_category(coefficient, criteres)

                    validation_json = {
                        "coefficient": coefficient,
                        "palier": palier,
                        "categorie_professionnelle": categorie,
                        "justification": justification,
                        "validated_by": (u.get("email") or "").strip(),
                        "validated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    }

                elif idcc == "3248":
                    if coefficient < 6:
                        raise HTTPException(status_code=400, detail="La cotation retenue doit être >= 6.")

                    band = _find_3248_class_group(ref_json, coefficient) or {}
                    classe = int(band.get("classe") or 0)
                    groupe = (band.get("groupe") or "").strip().upper()
                    categorie = _compute_3248_category(groupe, ref_json)

                    validation_json = {
                        "coefficient": coefficient,
                        "palier": classe,
                        "categorie_professionnelle": categorie,
                        "groupe_emploi": groupe,
                        "classe_emploi": classe,
                        "justification": justification,
                        "validated_by": (u.get("email") or "").strip(),
                        "validated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    }

                else:
                    raise HTTPException(status_code=400, detail=f"Convention non supportée pour l’assistant (IDCC détecté : {idcc or 'aucun'}).")

                _upsert_poste_ccn_dossier(
                    cur=cur,
                    oid=oid,
                    pid=pid,
                    idcc=idcc,
                    id_referentiel_ccn=(referential.get("id_referentiel_ccn") or "").strip(),
                    snapshot_poste_json=poste,
                    statut_cotation="valide",
                    proposition_json=proposition or {},
                    validation_json=validation_json,
                    user_email=(u.get("email") or "").strip(),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste ccn save error: {e}")

# ------------------------------------------------------
# Endpoints: Services
# ------------------------------------------------------
@router.get("/studio/org/services/{id_owner}")
def studio_org_list_services(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)

                # owner Studio doit exister (périmètre)
                studio_fetch_owner(cur, oid)

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                # Services (arbre)
                cur.execute(
                    """
                    WITH RECURSIVE svc AS (
                      SELECT
                        s.id_service, s.id_ent, s.nom_service, s.id_service_parent, COALESCE(s.archive,FALSE) AS archive,
                        0 AS depth,
                        (s.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme s
                      WHERE s.id_ent = %s
                        AND COALESCE(s.archive,FALSE) = FALSE
                        AND s.id_service_parent IS NULL

                      UNION ALL

                      SELECT
                        c.id_service, c.id_ent, c.nom_service, c.id_service_parent, COALESCE(c.archive,FALSE) AS archive,
                        p.depth + 1 AS depth,
                        (p.path || ' > ' || c.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme c
                      JOIN svc p ON p.id_service = c.id_service_parent
                      WHERE c.id_ent = %s
                        AND COALESCE(c.archive,FALSE) = FALSE
                    )
                    SELECT
                      svc.id_service,
                      svc.nom_service,
                      svc.id_service_parent,
                      svc.depth,

                      (SELECT COUNT(1)
                       FROM public.tbl_fiche_poste p
                       WHERE p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                         AND p.id_service = svc.id_service
                      ) AS nb_postes,

                      (SELECT COUNT(1)
                       FROM public.tbl_effectif_client e
                       WHERE e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         AND e.id_service = svc.id_service
                      ) AS nb_collabs

                    FROM svc
                    ORDER BY svc.path
                    """,
                    (scope_ent, scope_ent, scope_ent, scope_ent),
                )
                rows = cur.fetchall() or []

                services = []
                for r in rows:
                    services.append(
                        {
                            "id_service": r.get("id_service"),
                            "nom_service": r.get("nom_service"),
                            "id_service_parent": r.get("id_service_parent"),
                            "depth": int(r.get("depth") or 0),
                            "nb_postes": int(r.get("nb_postes") or 0),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                        }
                    )

                cur.execute(
                    """
                    SELECT
                      COUNT(1) FILTER (WHERE COALESCE(p.actif, TRUE) = TRUE) AS nb_postes,
                      COUNT(1) FILTER (
                        WHERE EXISTS (
                          SELECT 1
                          FROM public.tbl_effectif_client e
                          WHERE e.id_poste_actuel = p.id_poste
                            AND e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                        )
                      ) AS nb_collabs
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_owner = %s
                      AND p.id_ent = %s
                    """,
                    (scope_ent, oid, scope_ent),
                )
                tot = cur.fetchone() or {}

                cur.execute(
                    """
                    SELECT
                      COUNT(1) FILTER (WHERE COALESCE(p.actif, TRUE) = TRUE) AS nb_postes,
                      COUNT(1) FILTER (
                        WHERE EXISTS (
                          SELECT 1
                          FROM public.tbl_effectif_client e
                          WHERE e.id_poste_actuel = p.id_poste
                            AND e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                        )
                      ) AS nb_collabs
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_owner = %s
                      AND p.id_ent = %s
                      AND p.id_service IS NULL
                    """,
                    (scope_ent, oid, scope_ent),
                )
                none = cur.fetchone() or {}

        return {
            "totaux": {"nb_postes": int(tot.get("nb_postes") or 0), "nb_collabs": int(tot.get("nb_collabs") or 0)},
            "non_lie": {"nb_postes": int(none.get("nb_postes") or 0), "nb_collabs": int(none.get("nb_collabs") or 0)},
            "services": services,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services error: {e}")

@router.post("/studio/org/services/{id_owner}")
def studio_org_create_service(id_owner: str, payload: CreateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        nom = (payload.nom_service or "").strip()
        if not nom:
            raise HTTPException(status_code=400, detail="Nom de service obligatoire.")

        parent = (payload.id_service_parent or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                if parent and not _service_exists_active(cur, scope_ent, parent):
                    raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                sid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise_organigramme
                      (id_service, id_ent, nom_service, id_service_parent, archive, date_creation)
                    VALUES
                      (%s, %s, %s, %s, FALSE, CURRENT_DATE)
                    """,
                    (sid, scope_ent, nom, parent),
                )
                conn.commit()

        return {"id_service": sid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services create error: {e}")

@router.post("/studio/org/services/{id_owner}/{id_service}")
def studio_org_update_service(id_owner: str, id_service: str, payload: UpdateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                if not _service_exists_active(cur, scope_ent, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou archivé.")

                cols = []
                vals = []

                if "nom_service" in patch_fields:
                    nom = (payload.nom_service or "").strip()
                    if not nom:
                        raise HTTPException(status_code=400, detail="Nom de service obligatoire.")
                    cols.append("nom_service = %s")
                    vals.append(nom)

                if "id_service_parent" in patch_fields:
                    parent = (payload.id_service_parent or "").strip() or None
                    if parent == sid:
                        raise HTTPException(status_code=400, detail="Un service ne peut pas être son propre parent.")
                    if parent and not _service_exists_active(cur, scope_ent, parent):
                        raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                    if parent:
                        cur.execute(
                            """
                            WITH RECURSIVE up AS (
                              SELECT id_service, id_service_parent
                              FROM public.tbl_entreprise_organigramme
                              WHERE id_ent = %s
                                AND id_service = %s

                              UNION ALL

                              SELECT e.id_service, e.id_service_parent
                              FROM public.tbl_entreprise_organigramme e
                              JOIN up u ON u.id_service_parent = e.id_service
                              WHERE e.id_ent = %s
                            )
                            SELECT 1
                            FROM up
                            WHERE id_service = %s
                            LIMIT 1
                            """,
                            (scope_ent, parent, scope_ent, sid),
                        )
                        if cur.fetchone():
                            raise HTTPException(status_code=400, detail="Cycle détecté dans l’organigramme.")

                    cols.append("id_service_parent = %s")
                    vals.append(parent)

                if cols:
                    vals.extend([scope_ent, sid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise_organigramme
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                          AND id_service = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services update error: {e}")
    

@router.post("/studio/org/services/{id_owner}/{id_service}/archive")
def studio_org_archive_service(id_owner: str, id_service: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                if not _service_exists_active(cur, scope_ent, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou déjà archivé.")

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_organigramme
                    SET archive = TRUE
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (scope_ent, sid),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (scope_ent, sid),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client
                    SET id_service = NULL, dernier_update = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (scope_ent, sid),
                )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services archive error: {e}")


# ------------------------------------------------------
# Endpoints: Postes (liste + catalogue + affectation)
# ------------------------------------------------------
@router.get("/studio/org/postes/{id_owner}")
def studio_org_list_postes(
    id_owner: str,
    request: Request,
    service: str = "__all__",
    q: str = "",
    include_archived: int = 0,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        svc = (service or "__all__").strip()
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                inc_arch = int(include_archived or 0) == 1

                where = ["p.id_owner = %s", "p.id_ent = %s"]
                params = [oid, scope_ent]

                if not inc_arch:
                    where.append("COALESCE(p.actif, TRUE) = TRUE")

                if svc == "__none__":
                    where.append("p.id_service IS NULL")
                elif svc != "__all__":
                    where.append("p.id_service = %s")
                    params.append(svc)

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT
                      p.id_poste,
                      p.codif_poste,
                      p.codif_client,
                      p.intitule_poste,
                      p.id_service,
                      COALESCE(p.actif, TRUE) AS actif,
                      COALESCE(cnt.nb_collabs, 0) AS nb_collabs
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN (
                      SELECT e.id_poste_actuel AS id_poste, COUNT(1) AS nb_collabs
                      FROM public.tbl_effectif_client e
                      WHERE e.id_ent = %s
                        AND COALESCE(e.archive, FALSE) = FALSE
                        AND COALESCE(e.statut_actif, TRUE) = TRUE
                        AND e.id_poste_actuel IS NOT NULL
                      GROUP BY e.id_poste_actuel
                    ) cnt ON cnt.id_poste = p.id_poste
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    """,
                    tuple([scope_ent] + params),
                )
                rows = cur.fetchall() or []

                postes = []
                for r in rows:
                    code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
                    postes.append(
                        {
                            "id_poste": r.get("id_poste"),
                            "code": code,
                            "intitule": r.get("intitule_poste"),
                            "id_service": r.get("id_service"),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                            "actif": bool(r.get("actif")),
                        }
                    )

        return {"postes": postes}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes error: {e}")

@router.get("/studio/org/poste_detail/{id_owner}/{id_poste}")
def studio_org_poste_detail(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)

                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                cur.execute(
                    """
                    SELECT
                      p.id_poste,
                      p.id_service,
                      COALESCE(p.actif, TRUE) AS actif,
                      p.codif_poste,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites,
                      p.date_maj,

                      p.niveau_education_minimum,
                      p.nsf_groupe_code,
                      COALESCE(p.nsf_groupe_obligatoire, FALSE) AS nsf_groupe_obligatoire,
                      ng.titre AS nsf_groupe_titre,
                      p.mobilite,
                      p.risque_physique,
                      p.perspectives_evolution,
                      p.niveau_contrainte,
                      p.detail_contrainte,

                      COALESCE(pr.statut_poste, 'actif') AS statut_poste,
                      pr.date_debut_validite,
                      pr.date_fin_validite,
                      COALESCE(pr.nb_titulaires_cible, 1) AS nb_titulaires_cible,
                      COALESCE(pr.criticite_poste, 2) AS criticite_poste,
                      COALESCE(pr.strategie_pourvoi, 'mixte') AS strategie_pourvoi,
                      pr.param_rh_source,
                      pr.param_rh_date_maj,
                      COALESCE(pr.param_rh_verrouille, FALSE) AS param_rh_verrouille,
                      pr.param_rh_commentaire
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_nsf_groupe ng
                      ON ng.code = p.nsf_groupe_code
                     AND COALESCE(ng.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_poste_param_rh pr
                      ON pr.id_poste = p.id_poste
                    WHERE p.id_owner = %s
                      AND p.id_ent = %s
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (oid, poste_ent, pid),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

        return {
            "id_poste": r.get("id_poste"),
            "id_service": r.get("id_service"),
            "actif": bool(r.get("actif")),
            "codif_poste": r.get("codif_poste"),
            "codif_client": r.get("codif_client"),
            "intitule_poste": r.get("intitule_poste"),
            "mission_principale": r.get("mission_principale"),
            "responsabilites": r.get("responsabilites"),
            "date_maj": r.get("date_maj"),
            "niveau_education_minimum": r.get("niveau_education_minimum"),
            "nsf_groupe_code": r.get("nsf_groupe_code"),
            "nsf_groupe_obligatoire": bool(r.get("nsf_groupe_obligatoire")),
            "nsf_groupe_titre": r.get("nsf_groupe_titre"),
            "mobilite": r.get("mobilite"),
            "risque_physique": r.get("risque_physique"),
            "perspectives_evolution": r.get("perspectives_evolution"),
            "niveau_contrainte": r.get("niveau_contrainte"),
            "detail_contrainte": r.get("detail_contrainte"),
            "statut_poste": r.get("statut_poste"),
            "date_debut_validite": r.get("date_debut_validite"),
            "date_fin_validite": r.get("date_fin_validite"),
            "nb_titulaires_cible": int(r.get("nb_titulaires_cible") or 1),
            "criticite_poste": int(r.get("criticite_poste") or 2),
            "strategie_pourvoi": r.get("strategie_pourvoi"),
            "param_rh_source": r.get("param_rh_source"),
            "param_rh_date_maj": r.get("param_rh_date_maj"),
            "param_rh_verrouille": bool(r.get("param_rh_verrouille")),
            "param_rh_commentaire": r.get("param_rh_commentaire"),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_detail error: {e}")


@router.post("/studio/org/postes/{id_owner}")
def studio_org_create_poste(id_owner: str, payload: CreatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        title = (payload.intitule_poste or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        sid = _norm_service_id(payload.id_service)
        if not sid:
            raise HTTPException(status_code=400, detail="Service obligatoire.")

        codif = None
        cod_cli = (payload.codif_client or "").strip() or None
        mission = (payload.mission_principale or "").strip() or None
        resp = (payload.responsabilites or "").strip() or None
        edu_min = (payload.niveau_education_minimum or "").strip() or None
        nsf_code = (payload.nsf_groupe_code or "").strip() or None
        nsf_oblig = bool(payload.nsf_groupe_obligatoire) if payload.nsf_groupe_obligatoire is not None else False
        mobilite = (payload.mobilite or "").strip() or None
        risque = (payload.risque_physique or "").strip() or None
        persp = (payload.perspectives_evolution or "").strip() or None
        niv_ctr = (payload.niveau_contrainte or "").strip() or None
        det_ctr = (payload.detail_contrainte or "").strip() or None
        statut_poste = _norm_rh_statut(payload.statut_poste)
        date_debut_validite = _norm_iso_date(payload.date_debut_validite)
        date_fin_validite = _norm_iso_date(payload.date_fin_validite)
        _validate_rh_dates(date_debut_validite, date_fin_validite)
        nb_titulaires_cible = _norm_rh_nb_titulaires(payload.nb_titulaires_cible)
        criticite_poste = _norm_rh_criticite(payload.criticite_poste)
        strategie_pourvoi = _norm_rh_strategie(payload.strategie_pourvoi)
        param_rh_verrouille = bool(payload.param_rh_verrouille) if payload.param_rh_verrouille is not None else False
        param_rh_commentaire = (payload.param_rh_commentaire or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                if not _service_exists_active(cur, scope_ent, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                codif = _next_pt_code(cur, oid, scope_ent)

                if nsf_code and not _nsf_groupe_exists_active(cur, nsf_code):
                    raise HTTPException(status_code=400, detail="Domaine NSF introuvable ou masqué.")

                pid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service,
                       codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites,
                       actif, date_maj,
                       niveau_education_minimum,
                       nsf_groupe_code,
                       nsf_groupe_obligatoire,
                       mobilite,
                       risque_physique,
                       perspectives_evolution,
                       niveau_contrainte,
                       detail_contrainte)
                    VALUES
                      (%s, %s, %s, %s,
                       %s, %s, %s,
                       %s, %s,
                       TRUE, NOW(),
                       %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        pid, oid, scope_ent, sid,
                        codif, cod_cli, title,
                        mission, resp,
                        edu_min,
                        nsf_code,
                        nsf_oblig,
                        mobilite,
                        risque,
                        persp,
                        niv_ctr,
                        det_ctr,
                    ),
                )
                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_param_rh
                      (
                        id_poste,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_source,
                        param_rh_date_maj,
                        param_rh_verrouille,
                        param_rh_commentaire
                      )
                    VALUES
                      (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        'studio',
                        NOW(),
                        %s,
                        %s
                      )
                    """,
                    (
                        pid,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_verrouille,
                        param_rh_commentaire,
                    ),
                )

                conn.commit()

        return {"id_poste": pid, "codif_poste": codif}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes create error: {e}")

@router.post("/studio/org/postes/{id_owner}/{id_poste}")
def studio_org_update_poste(id_owner: str, id_poste: str, payload: UpdatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        if "codif_poste" in patch_fields:
            raise HTTPException(status_code=400, detail="Le code interne est généré automatiquement et ne peut pas être modifié.")

        rh_patch_fields = {
            "statut_poste",
            "date_debut_validite",
            "date_fin_validite",
            "nb_titulaires_cible",
            "criticite_poste",
            "strategie_pourvoi",
            "param_rh_verrouille",
            "param_rh_commentaire",
        }

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)

                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                if not _poste_exists(cur, oid, poste_ent, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cols = []
                vals = []
                need_commit = False

                if "id_service" in patch_fields:
                    sid = _norm_service_id(payload.id_service)
                    if not sid:
                        raise HTTPException(status_code=400, detail="Service obligatoire.")
                    if not _service_exists_active(cur, poste_ent, sid):
                        raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")
                    cols.append("id_service = %s")
                    vals.append(sid)

                if "codif_client" in patch_fields:
                    codc = (payload.codif_client or "").strip() or None
                    cols.append("codif_client = %s")
                    vals.append(codc)

                if "intitule_poste" in patch_fields:
                    title = (payload.intitule_poste or "").strip()
                    if not title:
                        raise HTTPException(status_code=400, detail="Intitulé obligatoire.")
                    cols.append("intitule_poste = %s")
                    vals.append(title)

                if "mission_principale" in patch_fields:
                    mission = (payload.mission_principale or "").strip() or None
                    cols.append("mission_principale = %s")
                    vals.append(mission)

                if "responsabilites" in patch_fields:
                    resp = (payload.responsabilites or "").strip() or None
                    cols.append("responsabilites = %s")
                    vals.append(resp)

                if "niveau_education_minimum" in patch_fields:
                    edu_min = (payload.niveau_education_minimum or "").strip() or None
                    cols.append("niveau_education_minimum = %s")
                    vals.append(edu_min)

                if "nsf_groupe_code" in patch_fields:
                    nsf_code = (payload.nsf_groupe_code or "").strip() or None
                    if nsf_code and not _nsf_groupe_exists_active(cur, nsf_code):
                        raise HTTPException(status_code=400, detail="Domaine NSF introuvable ou masqué.")
                    cols.append("nsf_groupe_code = %s")
                    vals.append(nsf_code)

                if "nsf_groupe_obligatoire" in patch_fields:
                    nsf_oblig = bool(payload.nsf_groupe_obligatoire) if payload.nsf_groupe_obligatoire is not None else False
                    cols.append("nsf_groupe_obligatoire = %s")
                    vals.append(nsf_oblig)

                if "mobilite" in patch_fields:
                    mobilite = (payload.mobilite or "").strip() or None
                    cols.append("mobilite = %s")
                    vals.append(mobilite)

                if "risque_physique" in patch_fields:
                    risque = (payload.risque_physique or "").strip() or None
                    cols.append("risque_physique = %s")
                    vals.append(risque)

                if "perspectives_evolution" in patch_fields:
                    persp = (payload.perspectives_evolution or "").strip() or None
                    cols.append("perspectives_evolution = %s")
                    vals.append(persp)

                if "niveau_contrainte" in patch_fields:
                    niv_ctr = (payload.niveau_contrainte or "").strip() or None
                    cols.append("niveau_contrainte = %s")
                    vals.append(niv_ctr)

                if "detail_contrainte" in patch_fields:
                    det_ctr = (payload.detail_contrainte or "").strip() or None
                    cols.append("detail_contrainte = %s")
                    vals.append(det_ctr)

                if cols:
                    cols.append("date_maj = NOW()")
                    vals.extend([pid, oid, poste_ent])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_fiche_poste
                        SET {", ".join(cols)}
                        WHERE id_poste = %s
                          AND id_owner = %s
                          AND id_ent = %s
                        """,
                        tuple(vals),
                    )
                    need_commit = True

                if patch_fields.intersection(rh_patch_fields):
                    statut_poste = _norm_rh_statut(payload.statut_poste)
                    date_debut_validite = _norm_iso_date(payload.date_debut_validite)
                    date_fin_validite = _norm_iso_date(payload.date_fin_validite)
                    _validate_rh_dates(date_debut_validite, date_fin_validite)
                    nb_titulaires_cible = _norm_rh_nb_titulaires(payload.nb_titulaires_cible)
                    criticite_poste = _norm_rh_criticite(payload.criticite_poste)
                    strategie_pourvoi = _norm_rh_strategie(payload.strategie_pourvoi)
                    param_rh_verrouille = bool(payload.param_rh_verrouille) if payload.param_rh_verrouille is not None else False
                    param_rh_commentaire = (payload.param_rh_commentaire or "").strip() or None

                    cur.execute(
                        """
                        INSERT INTO public.tbl_fiche_poste_param_rh
                          (
                            id_poste,
                            statut_poste,
                            date_debut_validite,
                            date_fin_validite,
                            nb_titulaires_cible,
                            criticite_poste,
                            strategie_pourvoi,
                            param_rh_source,
                            param_rh_date_maj,
                            param_rh_verrouille,
                            param_rh_commentaire
                          )
                        VALUES
                          (
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s,
                            'studio',
                            NOW(),
                            %s,
                            %s
                          )
                        ON CONFLICT (id_poste)
                        DO UPDATE SET
                          statut_poste = EXCLUDED.statut_poste,
                          date_debut_validite = EXCLUDED.date_debut_validite,
                          date_fin_validite = EXCLUDED.date_fin_validite,
                          nb_titulaires_cible = EXCLUDED.nb_titulaires_cible,
                          criticite_poste = EXCLUDED.criticite_poste,
                          strategie_pourvoi = EXCLUDED.strategie_pourvoi,
                          param_rh_source = 'studio',
                          param_rh_date_maj = NOW(),
                          param_rh_verrouille = EXCLUDED.param_rh_verrouille,
                          param_rh_commentaire = EXCLUDED.param_rh_commentaire
                        """,
                        (
                            pid,
                            statut_poste,
                            date_debut_validite,
                            date_fin_validite,
                            nb_titulaires_cible,
                            criticite_poste,
                            strategie_pourvoi,
                            param_rh_verrouille,
                            param_rh_commentaire,
                        ),
                    )
                    need_commit = True

                if need_commit:
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes update error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/archive")
def studio_org_archive_poste(id_owner: str, id_poste: str, payload: ArchivePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        set_actif = not bool(payload.archive)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)

                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                if not _poste_exists(cur, oid, poste_ent, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET actif = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    """,
                    (set_actif, pid, oid, poste_ent),
                )
                conn.commit()

        return {"ok": True, "actif": bool(set_actif)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes archive error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/duplicate")
def studio_org_duplicate_poste(id_owner: str, id_poste: str, payload: DuplicatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        target_sid = _norm_service_id(payload.id_service) if payload else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)

                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable pour cette structure.")

                cur.execute(
                    """
                    SELECT
                      p.id_service,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites,

                      p.niveau_education_minimum,
                      p.nsf_groupe_code,
                      COALESCE(p.nsf_groupe_obligatoire, FALSE) AS nsf_groupe_obligatoire,
                      p.mobilite,
                      p.risque_physique,
                      p.perspectives_evolution,
                      p.niveau_contrainte,
                      p.detail_contrainte,

                      COALESCE(pr.statut_poste, 'actif') AS statut_poste,
                      pr.date_debut_validite,
                      pr.date_fin_validite,
                      COALESCE(pr.nb_titulaires_cible, 1) AS nb_titulaires_cible,
                      COALESCE(pr.criticite_poste, 2) AS criticite_poste,
                      COALESCE(pr.strategie_pourvoi, 'mixte') AS strategie_pourvoi,
                      COALESCE(pr.param_rh_verrouille, FALSE) AS param_rh_verrouille,
                      pr.param_rh_commentaire
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_fiche_poste_param_rh pr
                      ON pr.id_poste = p.id_poste
                    WHERE p.id_poste = %s
                      AND p.id_owner = %s
                      AND p.id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, poste_ent),
                )
                src = cur.fetchone()
                if not src:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                sid = target_sid or (src.get("id_service") or "").strip()
                if not sid:
                    raise HTTPException(status_code=400, detail="Service obligatoire.")
                if not _service_exists_active(cur, poste_ent, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                new_id = str(uuid.uuid4())
                new_code = _next_pt_code(cur, oid, poste_ent)

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service,
                       codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites,
                       actif, date_maj,
                       niveau_education_minimum,
                       nsf_groupe_code,
                       nsf_groupe_obligatoire,
                       mobilite,
                       risque_physique,
                       perspectives_evolution,
                       niveau_contrainte,
                       detail_contrainte)
                    VALUES
                      (%s, %s, %s, %s,
                       %s, %s, %s,
                       %s, %s,
                       TRUE, NOW(),
                       %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        new_id,
                        oid,
                        poste_ent,
                        sid,
                        new_code,
                        src.get("codif_client"),
                        src.get("intitule_poste"),
                        src.get("mission_principale"),
                        src.get("responsabilites"),
                        src.get("niveau_education_minimum"),
                        src.get("nsf_groupe_code"),
                        bool(src.get("nsf_groupe_obligatoire")),
                        src.get("mobilite"),
                        src.get("risque_physique"),
                        src.get("perspectives_evolution"),
                        src.get("niveau_contrainte"),
                        src.get("detail_contrainte"),
                    ),
                )

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_param_rh
                      (
                        id_poste,
                        statut_poste,
                        date_debut_validite,
                        date_fin_validite,
                        nb_titulaires_cible,
                        criticite_poste,
                        strategie_pourvoi,
                        param_rh_source,
                        param_rh_date_maj,
                        param_rh_verrouille,
                        param_rh_commentaire
                      )
                    VALUES
                      (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        'studio',
                        NOW(),
                        %s,
                        %s
                      )
                    """,
                    (
                        new_id,
                        src.get("statut_poste") or "actif",
                        src.get("date_debut_validite"),
                        src.get("date_fin_validite"),
                        int(src.get("nb_titulaires_cible") or 1),
                        int(src.get("criticite_poste") or 2),
                        src.get("strategie_pourvoi") or "mixte",
                        bool(src.get("param_rh_verrouille")),
                        src.get("param_rh_commentaire"),
                    ),
                )

                conn.commit()

        return {"id_poste": new_id, "codif_poste": new_code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes duplicate error: {e}")
    

@router.get("/studio/org/postes_catalogue/{id_owner}")
def studio_org_list_postes_catalogue(id_owner: str, request: Request, q: str = ""):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                where = ["p.id_ent = %s", "COALESCE(p.actif, TRUE) = TRUE", "p.id_service IS NULL"]
                params = [scope_ent]

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT p.id_poste, p.codif_poste, p.codif_client, p.intitule_poste
                    FROM public.tbl_fiche_poste p
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    LIMIT 200
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
            items.append({"id_poste": r.get("id_poste"), "code": code, "intitule": r.get("intitule_poste")})
        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes_catalogue error: {e}")


@router.post("/studio/org/postes/assign/{id_owner}")
def studio_org_assign_poste(id_owner: str, payload: AssignPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        sid = (payload.id_service or "").strip()
        if not pid or not sid:
            raise HTTPException(status_code=400, detail="id_poste et id_service obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                if not _service_exists_active(cur, scope_ent, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (pid, scope_ent),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Poste introuvable ou inactif.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (sid, pid, scope_ent),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/assign error: {e}")


@router.post("/studio/org/postes/detach/{id_owner}")
def studio_org_detach_poste(id_owner: str, payload: DetachPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (pid, scope_ent),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/detach error: {e}")
    
@router.get("/studio/org/nsf_groupes/{id_owner}")
def studio_org_list_nsf_groupes(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT code, titre
                    FROM public.tbl_nsf_groupe
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY titre, code
                    """
                )
                rows = cur.fetchall() or []

        return {"items": [{"code": r.get("code"), "titre": r.get("titre")} for r in rows]}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/nsf_groupes error: {e}")
    
@router.get("/studio/org/poste_competences/{id_owner}/{id_poste}")
def studio_org_list_poste_competences(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    SELECT
                      pc.id_competence,
                      c.code,
                      c.intitule,
                      c.etat,
                      c.domaine,
                      dc.titre_court AS domaine_titre_court,
                      dc.couleur AS domaine_couleur,

                      c.niveaua,
                      c.niveaub,
                      c.niveauc,

                      pc.niveau_requis,
                      pc.poids_criticite,
                      pc.freq_usage,
                      pc.impact_resultat,
                      pc.dependance,
                      pc.date_valorisation

                    FROM public.tbl_fiche_poste_competence pc
                    JOIN public.tbl_fiche_poste p
                      ON p.id_poste = pc.id_poste
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                    JOIN public.tbl_competence c
                      ON c.id_comp = pc.id_competence
                     AND c.id_owner = %s
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE pc.id_poste = %s
                      AND COALESCE(pc.masque, FALSE) = FALSE
                    ORDER BY lower(c.code), lower(c.intitule)
                    """,
                    (oid, scope_ent, oid, pid),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_competence": r.get("id_competence"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "etat": r.get("etat"),
                    "domaine": r.get("domaine"),
                    "domaine_titre_court": r.get("domaine_titre_court"),
                    "domaine_couleur": r.get("domaine_couleur"),
                    "niveaua": r.get("niveaua"),
                    "niveaub": r.get("niveaub"),
                    "niveauc": r.get("niveauc"),
                    "niveau_requis": r.get("niveau_requis"),
                    "poids_criticite": r.get("poids_criticite"),
                    "freq_usage": r.get("freq_usage"),
                    "impact_resultat": r.get("impact_resultat"),
                    "dependance": r.get("dependance"),
                    "date_valorisation": r.get("date_valorisation"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences list error: {e}")
    
@router.post("/studio/org/poste_competences/{id_owner}/{id_poste}")
def studio_org_upsert_poste_competence(id_owner: str, id_poste: str, payload: UpsertPosteCompetencePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (payload.id_competence or "").strip()
        niv = (payload.niveau_requis or "").strip().upper()

        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")
        if not cid:
            raise HTTPException(status_code=400, detail="id_competence manquant.")
        if niv not in ("A", "B", "C"):
            raise HTTPException(status_code=400, detail="niveau_requis invalide (A/B/C).")

        fu = _clamp_0_10(payload.freq_usage or 0)
        im = _clamp_0_10(payload.impact_resultat or 0)
        de = _clamp_0_10(payload.dependance or 0)
        poids = _calc_poids_criticite_100(fu, im, de)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, scope_ent),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_competence
                    WHERE id_comp = %s
                      AND id_owner = %s
                      AND COALESCE(masque, FALSE) = FALSE
                      AND COALESCE(etat,'') IN ('active','valide','à valider')
                    LIMIT 1
                    """,
                    (cid, oid),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=400, detail="Compétence non autorisée (owner/etat/masque).")

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_competence
                      (id_poste, id_competence, niveau_requis,
                       poids_criticite, freq_usage, impact_resultat, dependance,
                       date_valorisation, masque, date_modification)
                    VALUES
                      (%s, %s, %s,
                       %s, %s, %s, %s,
                       NOW(), FALSE, NOW())
                    ON CONFLICT (id_poste, id_competence)
                    DO UPDATE SET
                      niveau_requis = EXCLUDED.niveau_requis,
                      poids_criticite = EXCLUDED.poids_criticite,
                      freq_usage = EXCLUDED.freq_usage,
                      impact_resultat = EXCLUDED.impact_resultat,
                      dependance = EXCLUDED.dependance,
                      date_valorisation = NOW(),
                      masque = FALSE,
                      date_modification = NOW()
                    """,
                    (pid, cid, niv, poids, fu, im, de),
                )
                conn.commit()

        return {"ok": True, "poids_criticite": poids}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences upsert error: {e}")
    
@router.post("/studio/org/poste_competences/{id_owner}/{id_poste}/{id_competence}/remove")
def studio_org_remove_poste_competence(id_owner: str, id_poste: str, id_competence: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (id_competence or "").strip()
        if not pid or not cid:
            raise HTTPException(status_code=400, detail="Paramètres manquants.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, scope_ent),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste_competence
                    SET masque = TRUE, date_modification = NOW()
                    WHERE id_poste = %s
                      AND id_competence = %s
                    """,
                    (pid, cid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_competences remove error: {e}")


@router.get("/studio/org/certifications_catalogue/{id_owner}")
def studio_org_list_certifications_catalogue(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        q = (request.query_params.get("q") or "").strip()
        categorie = (request.query_params.get("categorie") or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      c.id_certification,
                      c.nom_certification,
                      c.description,
                      c.categorie,
                      c.duree_validite,
                      c.delai_renouvellement
                    FROM public.tbl_certification c
                    WHERE COALESCE(c.masque, FALSE) = FALSE
                      AND (
                            %s = ''
                         OR lower(c.nom_certification) LIKE '%%' || lower(%s) || '%%'
                         OR lower(COALESCE(c.description,'')) LIKE '%%' || lower(%s) || '%%'
                         OR lower(COALESCE(c.categorie,'')) LIKE '%%' || lower(%s) || '%%'
                      )
                      AND (
                            %s = ''
                         OR (%s = '__none__' AND COALESCE(c.categorie,'') = '')
                         OR lower(COALESCE(c.categorie,'')) = lower(%s)
                      )
                    ORDER BY lower(COALESCE(c.categorie,'')), lower(c.nom_certification)
                    """,
                    (q, q, q, q, categorie, categorie, categorie),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "description": r.get("description"),
                    "categorie": r.get("categorie"),
                    "duree_validite": r.get("duree_validite"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/certifications_catalogue error: {e}")

@router.post("/studio/org/certifications_catalogue/{id_owner}")
def studio_org_create_certification_catalogue(id_owner: str, payload: CreateCertificationPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        nom = (payload.nom_certification or "").strip()
        if not nom:
            raise HTTPException(status_code=400, detail="nom_certification obligatoire.")

        categorie = (payload.categorie or "").strip() or None
        description = (payload.description or "").strip() or None

        duree_validite = payload.duree_validite
        if duree_validite is not None:
            try:
                duree_validite = int(duree_validite)
            except Exception:
                raise HTTPException(status_code=400, detail="duree_validite invalide.")
            if duree_validite <= 0:
                raise HTTPException(status_code=400, detail="duree_validite doit être > 0.")

        delai_renouvellement = payload.delai_renouvellement
        if delai_renouvellement is not None:
            try:
                delai_renouvellement = int(delai_renouvellement)
            except Exception:
                raise HTTPException(status_code=400, detail="delai_renouvellement invalide.")
            if delai_renouvellement <= 0:
                raise HTTPException(status_code=400, detail="delai_renouvellement doit être > 0.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_certification
                    WHERE lower(nom_certification) = lower(%s)
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (nom,),
                )
                if cur.fetchone():
                    raise HTTPException(status_code=400, detail="Une certification active porte déjà ce nom.")

                cid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_certification
                      (
                        id_certification,
                        nom_certification,
                        description,
                        categorie,
                        duree_validite,
                        date_creation,
                        masque,
                        delai_renouvellement
                      )
                    VALUES
                      (%s, %s, %s, %s, %s, CURRENT_DATE, FALSE, %s)
                    """,
                    (cid, nom, description, categorie, duree_validite, delai_renouvellement),
                )
                conn.commit()

        return {
            "ok": True,
            "item": {
                "id_certification": cid,
                "nom_certification": nom,
                "description": description,
                "categorie": categorie,
                "duree_validite": duree_validite,
                "delai_renouvellement": delai_renouvellement,
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/certifications_catalogue create error: {e}")

@router.get("/studio/org/poste_certifications/{id_owner}/{id_poste}")
def studio_org_list_poste_certifications(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    SELECT
                      pc.id_certification,
                      pc.validite_override,
                      pc.niveau_exigence,
                      pc.commentaire,

                      c.nom_certification,
                      c.description,
                      c.categorie,
                      c.duree_validite,
                      c.delai_renouvellement

                    FROM public.tbl_fiche_poste_certification pc
                    JOIN public.tbl_fiche_poste p
                      ON p.id_poste = pc.id_poste
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                    JOIN public.tbl_certification c
                      ON c.id_certification = pc.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    WHERE pc.id_poste = %s
                    ORDER BY lower(COALESCE(c.categorie,'')), lower(c.nom_certification)
                    """,
                    (oid, scope_ent, pid),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "description": r.get("description"),
                    "categorie": r.get("categorie"),
                    "duree_validite": r.get("duree_validite"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                    "validite_override": r.get("validite_override"),
                    "niveau_exigence": r.get("niveau_exigence"),
                    "commentaire": r.get("commentaire"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications list error: {e}")


@router.post("/studio/org/poste_certifications/{id_owner}/{id_poste}")
def studio_org_upsert_poste_certification(id_owner: str, id_poste: str, payload: UpsertPosteCertificationPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (payload.id_certification or "").strip()
        lvl_raw = (payload.niveau_exigence or "requis").strip().lower()

        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")
        if not cid:
            raise HTTPException(status_code=400, detail="id_certification manquant.")

        if lvl_raw == "requis":
            niveau = "requis"
        elif lvl_raw in ("souhaite", "souhaité"):
            niveau = "souhaité"
        else:
            raise HTTPException(status_code=400, detail="niveau_exigence invalide (requis/souhaité).")

        validite_override = payload.validite_override
        if validite_override is not None:
            try:
                validite_override = int(validite_override)
            except Exception:
                raise HTTPException(status_code=400, detail="validite_override invalide.")
            if validite_override <= 0:
                raise HTTPException(status_code=400, detail="validite_override doit être > 0.")

        commentaire = (payload.commentaire or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, scope_ent),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_certification
                    WHERE id_certification = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (cid,),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=400, detail="Certification non autorisée (masque/introuvable).")

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_certification
                      (id_poste, id_certification, validite_override, niveau_exigence, commentaire)
                    VALUES
                      (%s, %s, %s, %s, %s)
                    ON CONFLICT (id_poste, id_certification)
                    DO UPDATE SET
                      validite_override = EXCLUDED.validite_override,
                      niveau_exigence = EXCLUDED.niveau_exigence,
                      commentaire = EXCLUDED.commentaire
                    """,
                    (pid, cid, validite_override, niveau, commentaire),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications upsert error: {e}")


@router.post("/studio/org/poste_certifications/{id_owner}/{id_poste}/{id_certification}/remove")
def studio_org_remove_poste_certification(id_owner: str, id_poste: str, id_certification: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        cid = (id_certification or "").strip()
        if not pid or not cid:
            raise HTTPException(status_code=400, detail="Paramètres manquants.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                scope_ent = _resolve_org_scope_ent(cur, oid, request)
                poste_ent = _resolve_poste_ent(cur, oid, pid)
                if poste_ent != scope_ent:
                    raise HTTPException(status_code=404, detail="Poste introuvable dans le périmètre courant.")

                cur.execute(
                    """
                    DELETE FROM public.tbl_fiche_poste_certification pc
                    USING public.tbl_fiche_poste p
                    WHERE pc.id_poste = p.id_poste
                      AND p.id_owner = %s
                      AND p.id_ent = %s
                      AND pc.id_poste = %s
                      AND pc.id_certification = %s
                    """,
                    (oid, scope_ent, pid, cid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_certifications remove error: {e}")