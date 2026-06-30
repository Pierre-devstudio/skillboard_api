from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from datetime import date, datetime
import unicodedata

from psycopg.rows import dict_row
from reportlab.lib.pagesizes import A4, landscape

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
    skills_validate_enterprise,
)

from app.routers.skills_portal_pdf_common import (
    PDF_BRAND_RED,
    PDF_LINE,
    PDF_MUTED,
    PDF_TEXT,
    build_pdf_document,
    build_pdf_styles,
)


router = APIRouter()

NON_LIE_ID = "__NON_LIE__"
ETAT_ACTIVE = "active"


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class DomaineItem(BaseModel):
    id_domaine_competence: str
    titre: Optional[str] = None
    titre_court: Optional[str] = None
    ordre_affichage: Optional[int] = None
    couleur: Optional[str] = None


class PosteItem(BaseModel):
    id_poste: str
    codif_poste: str
    codif_client: Optional[str] = None
    intitule_poste: str
    id_service: Optional[str] = None
    nom_service: Optional[str] = None
    total_competences: int = 0


class MatrixCell(BaseModel):
    id_poste: str
    id_domaine_competence: str
    nb_competences: int


class DomaineTotal(BaseModel):
    id_domaine_competence: str
    total_competences: int


class CartographieMatriceResponse(BaseModel):
    service: ServiceScope
    domaines: List[DomaineItem]
    postes: List[PosteItem]
    matrix: List[MatrixCell]
    totaux_domaines: List[DomaineTotal]
    total_postes: int
    total_competences: int


# ======================================================
# Helpers
# ======================================================
def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)

def _normalize_etat(etat: Optional[str]) -> Optional[str]:
    if etat is None:
        return None
    s = etat.strip().lower()
    if s == "":
        return None

    # Tolérances front / libellés humains
    if s in ("valide", "validée", "validee", "valider", "valid"):
        return "active"
    if s in ("a valider", "à valider", "a_valider", "a-valider"):
        return "a_valider"
    if s in ("active", "inactive", "a_valider"):
        return s

    # valeur inconnue => on ne filtre pas (évite de casser en prod)
    return None


_SQL_ACCENT_FROM = "àâäáãåçéèêëíìîïñóòôöõúùûüýÿ"
_SQL_ACCENT_TO = "aaaaaaceeeeiiiinooooouuuuyy"


def _normalize_search_text(value: Optional[str]) -> str:
    raw = (value or "").strip().lower()
    if not raw:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFD", raw)
        if unicodedata.category(c) != "Mn"
    )


def _sql_norm(expr: str) -> str:
    return f"translate(lower(COALESCE({expr}, '')), '{_SQL_ACCENT_FROM}', '{_SQL_ACCENT_TO}')"


def _serialize_advanced_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for r in rows or []:
        item = dict(r)
        if item.get("date_derniere_eval") is not None:
            item["date_derniere_eval"] = str(item.get("date_derniere_eval"))
        comps = item.get("competences")
        if isinstance(comps, list):
            for comp in comps:
                if isinstance(comp, dict) and comp.get("date_derniere_eval") is not None:
                    comp["date_derniere_eval"] = str(comp.get("date_derniere_eval"))
        items.append(item)
    return items


def _advanced_text(value: Any, fallback: str = "—") -> str:
    raw = "" if value is None else str(value).strip()
    return raw or fallback


def _advanced_pdf_escape(value: Any) -> str:
    return (
        _advanced_text(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


def _advanced_person_label(item: Dict[str, Any]) -> str:
    full = f"{_advanced_text(item.get('prenom_effectif'), '')} {_advanced_text(item.get('nom_effectif'), '')}".strip()
    return full or "—"


def _advanced_poste_label(item: Dict[str, Any]) -> str:
    code = _advanced_text(item.get("codif_client"), "") or _advanced_text(item.get("codif_poste"), "")
    label = _advanced_text(item.get("intitule_poste"), "Poste non renseigné")
    service = _advanced_text(item.get("nom_service"), "Service non renseigné")
    main = f"<b>{_advanced_pdf_escape(code)}</b> — {_advanced_pdf_escape(label)}" if code else _advanced_pdf_escape(label)
    return f"{main}<br/><font color='#667085'>{_advanced_pdf_escape(service)}</font>"


def _advanced_comp_label(item: Dict[str, Any]) -> str:
    code = _advanced_text(item.get("code"), "")
    label = _advanced_text(item.get("intitule"), "Compétence")
    return f"<b>{_advanced_pdf_escape(code)}</b> — {_advanced_pdf_escape(label)}" if code else _advanced_pdf_escape(label)


def _advanced_level_label(value: Any) -> str:
    raw = _advanced_text(value, "")
    norm = _normalize_search_text(raw)
    if not norm:
        return "—"
    if norm == "a" or "debutant" in norm or "initial" in norm:
        return "Débutant"
    if norm == "b" or "intermediaire" in norm or "interm" in norm:
        return "Intermédiaire"
    if norm == "c" or "avance" in norm:
        return "Avancé"
    if norm == "d" or "expert" in norm:
        return "Expert"
    return raw


def _build_advanced_pdf_story(
    enterprise_name: str,
    data: Dict[str, Any],
    mode_norm: str,
    query: str,
    op_norm: str,
) -> List[Any]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, Spacer, Table, TableStyle

    styles = build_pdf_styles()
    story: List[Any] = []

    title_style = ParagraphStyle(
        "MapAdvancedTitle",
        parent=styles["title"],
        fontSize=16,
        leading=19,
        spaceAfter=2,
    )
    subtitle_style = ParagraphStyle(
        "MapAdvancedSubtitle",
        parent=styles["subtitle"],
        fontSize=8.8,
        leading=11,
    )
    meta_label_style = ParagraphStyle(
        "MapAdvancedMetaLabel",
        parent=styles["meta_label"],
        fontSize=7.2,
        leading=8.5,
    )
    meta_value_style = ParagraphStyle(
        "MapAdvancedMetaValue",
        parent=styles["meta_value"],
        fontSize=8.2,
        leading=10,
    )
    cell_style = ParagraphStyle(
        "MapAdvancedCell",
        parent=styles["body"],
        fontSize=7.8,
        leading=9.4,
    )
    center_style = ParagraphStyle(
        "MapAdvancedCenter",
        parent=cell_style,
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
    )
    head_style = ParagraphStyle(
        "MapAdvancedHead",
        parent=styles["small"],
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=7.8,
        leading=9,
        textColor=colors.white,
    )

    def p(value: Any, style=cell_style) -> Any:
        return Paragraph(_advanced_pdf_escape(value), style)

    def p_html(value: Any, style=cell_style) -> Any:
        return Paragraph(str(value or "—"), style)

    items = data.get("items") if isinstance(data, dict) else []
    if not isinstance(items, list):
        items = []

    mode_label = "Par collaborateur" if mode_norm == "collaborateur" else "Par compétences"
    generated = datetime.now().strftime("%d/%m/%Y %H:%M")
    operator_label = "OU - au moins une compétence" if op_norm == "or" else "ET - toutes les compétences"
    query_label = (query or "").strip() or "Sélection assistée"

    story.append(Paragraph("Recherche avancée - Cartographie des compétences", title_style))
    story.append(Paragraph("Extraction du tableau courant de la cartographie Novoskill Insights.", subtitle_style))
    story.append(Spacer(1, 4))

    meta_rows = [[
        Paragraph("Entreprise", meta_label_style), Paragraph(_advanced_pdf_escape(enterprise_name), meta_value_style),
        Paragraph("Mode", meta_label_style), Paragraph(_advanced_pdf_escape(mode_label), meta_value_style),
        Paragraph("Logique", meta_label_style), Paragraph(_advanced_pdf_escape(operator_label if mode_norm == "competence" else "Recherche unique"), meta_value_style),
        Paragraph("Résultats", meta_label_style), Paragraph(_advanced_pdf_escape(str(len(items))), meta_value_style),
    ], [
        Paragraph("Recherche", meta_label_style), Paragraph(_advanced_pdf_escape(query_label), meta_value_style),
        Paragraph("Généré le", meta_label_style), Paragraph(_advanced_pdf_escape(generated), meta_value_style),
        Paragraph("Périmètre", meta_label_style), Paragraph(_advanced_pdf_escape("Cartographie active"), meta_value_style),
        Paragraph("Source", meta_label_style), Paragraph(_advanced_pdf_escape("Novoskill Insights"), meta_value_style),
    ]]
    meta_table = Table(meta_rows, colWidths=[20 * mm, 42 * mm, 18 * mm, 42 * mm, 18 * mm, 48 * mm, 18 * mm, 42 * mm])
    meta_table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, PDF_LINE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 7))

    if mode_norm == "collaborateur":
        table_rows: List[List[Any]] = [[
            Paragraph("Compétence", head_style),
            Paragraph("Domaine", head_style),
            Paragraph("Niveau atteint", head_style),
        ]]
        for it in items:
            table_rows.append([
                p_html(_advanced_comp_label(it)),
                p(_advanced_text(it.get("domaine_label"), "Domaine non renseigné")),
                Paragraph(_advanced_pdf_escape(_advanced_level_label(it.get("niveau_actuel"))), center_style),
            ])
        col_widths = [155 * mm, 70 * mm, 36 * mm]
    else:
        table_rows = [[
            Paragraph("Collaborateur", head_style),
            Paragraph("Poste actuel", head_style),
            Paragraph("Compétence", head_style),
            Paragraph("Niveau atteint", head_style),
        ]]
        for it in items:
            comps = it.get("competences")
            if isinstance(comps, list) and comps:
                for comp in comps:
                    table_rows.append([
                        p(_advanced_person_label(it)),
                        p_html(_advanced_poste_label(it)),
                        p_html(_advanced_comp_label(comp)),
                        Paragraph(_advanced_pdf_escape(_advanced_level_label(comp.get("niveau_actuel"))), center_style),
                    ])
            else:
                table_rows.append([
                    p(_advanced_person_label(it)),
                    p_html(_advanced_poste_label(it)),
                    p_html(_advanced_comp_label(it)),
                    Paragraph(_advanced_pdf_escape(_advanced_level_label(it.get("niveau_actuel"))), center_style),
                ])
        col_widths = [44 * mm, 76 * mm, 108 * mm, 33 * mm]

    if len(table_rows) == 1:
        table_rows.append([Paragraph("Aucun résultat", cell_style)] + [""] * (len(table_rows[0]) - 1))

    result_table = Table(table_rows, colWidths=col_widths, repeatRows=1, hAlign="LEFT")
    result_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PDF_BRAND_RED),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.7, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.45, PDF_LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fbfcfe")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(result_table)

    return story


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


def _build_postes_scope_cte(id_service: Optional[str]) -> Tuple[str, Tuple[Any, ...]]:
    """
    Retourne (cte_sql, params)
    - id_service None/"" => tous les postes de l'entreprise
    - id_service == NON_LIE_ID => postes non liés à un service valide
    - sinon => service + sous-services (récursif)
    """
    if not id_service:
        cte = """
        postes_scope AS (
            SELECT fp.id_poste, fp.id_service
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
        )
        """
        params = ()
        return cte, params

    if id_service == NON_LIE_ID:
        cte = """
        postes_scope AS (
            SELECT fp.id_poste, fp.id_service
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
              AND (
                    fp.id_service IS NULL
                    OR fp.id_service NOT IN (
                        SELECT o.id_service
                        FROM public.tbl_entreprise_organigramme o
                        WHERE o.id_ent = %s
                          AND o.archive = FALSE
                    )
              )
        )
        """
        # params: id_ent, id_ent
        params = ()
        return cte, params

    # service + descendants
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
        SELECT fp.id_poste, fp.id_service
        FROM public.tbl_fiche_poste fp
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND fp.id_service IN (SELECT id_service FROM services_scope)
    )
    """
    params = ()
    return cte, params


# ======================================================
# Endpoint: Matrice postes x domaines
# ======================================================
@router.get(
    "/skills/cartographie/matrice/{id_contact}",
    response_model=CartographieMatriceResponse,
)
def get_cartographie_matrice(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    etat: Optional[str] = Query(default=ETAT_ACTIVE),
    include_masque: bool = Query(default=False),
):
    """
    Matrice "Postes x Domaines" :
    - lignes = postes (périmètre service / tous)
    - colonnes = domaines de compétences
    - cellule = nb de compétences requises (distinct) pour le poste dans le domaine
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # scope label
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                # CTE scope postes
                cte_sql, _ = _build_postes_scope_cte(scope.id_service)

                # WHERE compétences
                where_parts: List[str] = []
                params_where: List[Any] = []

                etat_norm = _normalize_etat(etat)
                if etat_norm:
                    where_parts.append("c.etat = %s")
                    params_where.append(etat_norm)

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

                # 1) Postes du scope
                # (on garde le nom_service pour affichage; left join organigramme)
                sql_postes = f"""
                    WITH
                    {cte_sql}
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.codif_client,
                        fp.intitule_poste,
                        fp.id_service,
                        o.nom_service
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    ORDER BY fp.codif_poste, fp.intitule_poste
                """

                # params CTE (suivant cas)
                params_postes: List[Any] = []
                if not scope.id_service:
                    # postes_scope(id_ent)
                    params_postes.extend([id_ent, id_ent])
                elif scope.id_service == NON_LIE_ID:
                    # postes_scope(id_ent, id_ent) + join organigramme(id_ent)
                    params_postes.extend([id_ent, id_ent, id_ent])
                else:
                    # services_scope(id_ent, id_service, id_ent) + postes_scope(id_ent) + join organigramme(id_ent)
                    params_postes.extend([id_ent, scope.id_service, id_ent, id_ent, id_ent])

                cur.execute(sql_postes, tuple(params_postes))
                postes_rows = cur.fetchall() or []

                postes: List[PosteItem] = [
                    PosteItem(
                        id_poste=r["id_poste"],
                        codif_poste=r.get("codif_poste") or "",
                        codif_client=r.get("codif_client"),
                        intitule_poste=r.get("intitule_poste") or "",
                        id_service=r.get("id_service"),
                        nom_service=r.get("nom_service"),
                        total_competences=0,
                    )
                    for r in postes_rows
                ]

                if not postes:
                    return CartographieMatriceResponse(
                        service=scope,
                        domaines=[],
                        postes=[],
                        matrix=[],
                        totaux_domaines=[],
                        total_postes=0,
                        total_competences=0,
                    )

                # 2) Cellules matrice + domaines (distinct)
                sql_matrix = f"""
                    WITH
                    {cte_sql}
                    SELECT
                        fp.id_poste,
                        c.domaine AS id_domaine_competence,
                        COUNT(DISTINCT c.id_comp)::int AS nb_competences,
                        d.titre,
                        d.titre_court,
                        d.ordre_affichage,
                        d.couleur
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = fp.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    {where_sql}
                    GROUP BY
                        fp.id_poste,
                        c.domaine,
                        d.titre,
                        d.titre_court,
                        d.ordre_affichage,
                        d.couleur
                """

                # params CTE + where
                params_matrix: List[Any] = []
                if not scope.id_service:
                    params_matrix.extend([id_ent])
                elif scope.id_service == NON_LIE_ID:
                    params_matrix.extend([id_ent, id_ent])
                else:
                    params_matrix.extend([id_ent, scope.id_service, id_ent, id_ent])

                params_matrix.extend(params_where)

                cur.execute(sql_matrix, tuple(params_matrix))
                rows = cur.fetchall() or []

                domaines_map: Dict[str, DomaineItem] = {}
                matrix: List[MatrixCell] = []
                tot_poste: Dict[str, int] = {}
                tot_dom: Dict[str, int] = {}

                for r in rows:
                    did = r.get("id_domaine_competence")
                    if not did:
                        # compétence sans domaine => on ignore dans la matrice V1 (sinon ça fait une colonne "vide")
                        continue

                    if did not in domaines_map:
                        domaines_map[did] = DomaineItem(
                            id_domaine_competence=did,
                            titre=r.get("titre"),
                            titre_court=r.get("titre_court"),
                            ordre_affichage=r.get("ordre_affichage"),
                            couleur=r.get("couleur"),
                        )

                    nb = int(r.get("nb_competences") or 0)
                    pid = r["id_poste"]

                    matrix.append(
                        MatrixCell(
                            id_poste=pid,
                            id_domaine_competence=did,
                            nb_competences=nb,
                        )
                    )

                    tot_poste[pid] = tot_poste.get(pid, 0) + nb
                    tot_dom[did] = tot_dom.get(did, 0) + nb

                # compléter total par poste
                for p in postes:
                    p.total_competences = int(tot_poste.get(p.id_poste, 0))

                # tri domaines
                domaines = sorted(
                    domaines_map.values(),
                    key=lambda d: (
                        d.ordre_affichage if d.ordre_affichage is not None else 999999,
                        (d.titre_court or d.titre or d.id_domaine_competence).lower(),
                    ),
                )

                totaux_domaines = [
                    DomaineTotal(id_domaine_competence=did, total_competences=int(total))
                    for did, total in tot_dom.items()
                    if did in domaines_map
                ]
                totaux_domaines.sort(key=lambda x: x.total_competences, reverse=True)

                total_competences = sum(tot_poste.values()) if tot_poste else 0

                return CartographieMatriceResponse(
                    service=scope,
                    domaines=domaines,
                    postes=postes,
                    matrix=matrix,
                    totaux_domaines=totaux_domaines,
                    total_postes=len(postes),
                    total_competences=int(total_competences),
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get("/skills/cartographie/recherche_avancee/{id_contact}")
def get_cartographie_recherche_avancee(
    id_contact: str,
    request: Request,
    mode: str = Query(default="competence"),
    q: str = Query(default=""),
    id_service: Optional[str] = Query(default=None),
    limit: int = Query(default=80),
    id_comps: Optional[str] = Query(default=None),
    op: str = Query(default="and"),
    id_effectif: Optional[str] = Query(default=None),
):
    """
    Recherche avancée de la cartographie :
    - mode=suggest_competence : suggestions de compétences requises dans le périmètre
    - mode=suggest_collaborateur : suggestions de collaborateurs dans le périmètre
    - mode=competence : porteurs d'une ou plusieurs compétences sélectionnées
    - mode=collaborateur : compétences détenues par un collaborateur sélectionné
    """
    try:
        query = (q or "").strip()
        query_norm = _normalize_search_text(query)
        safe_limit = max(1, min(int(limit or 80), 200))
        raw_mode = (mode or "competence").strip().lower()
        op_norm = "or" if (op or "").strip().lower() == "or" else "and"
        selected_comp_ids = [
            x.strip() for x in (id_comps or "").split(",")
            if x and x.strip()
        ]
        selected_effectif = (id_effectif or "").strip() or None

        allowed_modes = {"competence", "collaborateur", "suggest_competence", "suggest_collaborateur"}
        mode_norm = raw_mode if raw_mode in allowed_modes else "competence"

        if mode_norm in ("suggest_competence", "suggest_collaborateur") and len(query_norm) < 2:
            return {"mode": mode_norm, "q": query, "total": 0, "items": []}

        if mode_norm == "competence" and not selected_comp_ids and len(query_norm) < 2:
            return {"mode": mode_norm, "q": query, "total": 0, "items": []}

        if mode_norm == "collaborateur" and not selected_effectif and len(query_norm) < 2:
            return {"mode": mode_norm, "q": query, "total": 0, "items": []}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                cte_sql, _ = _build_postes_scope_cte(scope.id_service)

                if not scope.id_service:
                    scope_params: List[Any] = [id_ent]
                    effectif_scope_sql = ""
                    effectif_scope_params: List[Any] = []
                elif scope.id_service == NON_LIE_ID:
                    scope_params = [id_ent, id_ent]
                    effectif_scope_sql = """
                      AND (
                            e.id_service IS NULL
                            OR e.id_service = ''
                            OR e.id_service NOT IN (
                                SELECT o2.id_service
                                FROM public.tbl_entreprise_organigramme o2
                                WHERE o2.id_ent = %s
                                  AND COALESCE(o2.archive, FALSE) = FALSE
                            )
                          )
                    """
                    effectif_scope_params = [id_ent]
                else:
                    scope_params = [id_ent, scope.id_service, id_ent, id_ent]
                    effectif_scope_sql = " AND e.id_service IN (SELECT id_service FROM services_scope) "
                    effectif_scope_params = []

                like = f"%{query}%"
                norm_like = f"%{query_norm}%"

                if mode_norm == "suggest_competence":
                    sql = f"""
                    WITH
                    {cte_sql}
                    SELECT DISTINCT
                        c.id_comp,
                        COALESCE(c.code, '') AS code,
                        COALESCE(c.intitule, '') AS intitule,
                        COALESCE(c.description, '') AS description,
                        c.domaine AS id_domaine_competence,
                        COALESCE(d.titre_court, d.titre, '') AS domaine_label
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste_competence fpc
                      ON fpc.id_poste = ps.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    WHERE c.etat = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                      AND (
                            {_sql_norm("c.code")} LIKE %s
                            OR {_sql_norm("c.intitule")} LIKE %s
                            OR {_sql_norm("c.description")} LIKE %s
                            OR c.code ILIKE %s
                            OR c.intitule ILIKE %s
                          )
                    ORDER BY COALESCE(c.code, ''), COALESCE(c.intitule, '')
                    LIMIT %s
                    """
                    params = scope_params + [ETAT_ACTIVE, norm_like, norm_like, norm_like, like, like, safe_limit]

                elif mode_norm == "suggest_collaborateur":
                    sql = f"""
                    WITH
                    {cte_sql}
                    SELECT
                        e.id_effectif,
                        COALESCE(e.nom_effectif, '') AS nom_effectif,
                        COALESCE(e.prenom_effectif, '') AS prenom_effectif,
                        e.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        e.id_poste_actuel,
                        COALESCE(fp.codif_poste, '') AS codif_poste,
                        COALESCE(fp.codif_client, '') AS codif_client,
                        COALESCE(fp.intitule_poste, '') AS intitule_poste
                    FROM public.tbl_effectif_client e
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = e.id_poste_actuel
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = e.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                      AND (
                            {_sql_norm("e.nom_effectif")} LIKE %s
                            OR {_sql_norm("e.prenom_effectif")} LIKE %s
                            OR {_sql_norm("CONCAT(COALESCE(e.prenom_effectif, ''), ' ', COALESCE(e.nom_effectif, ''))")} LIKE %s
                            OR {_sql_norm("CONCAT(COALESCE(e.nom_effectif, ''), ' ', COALESCE(e.prenom_effectif, ''))")} LIKE %s
                            OR e.nom_effectif ILIKE %s
                            OR e.prenom_effectif ILIKE %s
                          )
                      {effectif_scope_sql}
                    ORDER BY lower(COALESCE(e.nom_effectif, '')), lower(COALESCE(e.prenom_effectif, ''))
                    LIMIT %s
                    """
                    params = (
                        scope_params
                        + [id_ent, id_ent, id_ent, norm_like, norm_like, norm_like, norm_like, like, like]
                        + effectif_scope_params
                        + [safe_limit]
                    )

                elif mode_norm == "collaborateur":
                    if selected_effectif:
                        person_where = "e.id_effectif = %s"
                        person_params: List[Any] = [selected_effectif]
                    else:
                        person_where = f"""
                        (
                            {_sql_norm("e.nom_effectif")} LIKE %s
                            OR {_sql_norm("e.prenom_effectif")} LIKE %s
                            OR {_sql_norm("CONCAT(COALESCE(e.prenom_effectif, ''), ' ', COALESCE(e.nom_effectif, ''))")} LIKE %s
                            OR {_sql_norm("CONCAT(COALESCE(e.nom_effectif, ''), ' ', COALESCE(e.prenom_effectif, ''))")} LIKE %s
                            OR e.nom_effectif ILIKE %s
                            OR e.prenom_effectif ILIKE %s
                        )
                        """
                        person_params = [norm_like, norm_like, norm_like, norm_like, like, like]

                    sql = f"""
                    WITH
                    {cte_sql},
                    comp_required AS (
                        SELECT DISTINCT c.id_comp
                        FROM postes_scope ps
                        JOIN public.tbl_fiche_poste_competence fpc
                          ON fpc.id_poste = ps.id_poste
                        JOIN public.tbl_competence c
                          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                        WHERE c.etat = %s
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(fpc.masque, FALSE) = FALSE
                    ),
                    persons AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND COALESCE(e.archive, FALSE) = FALSE
                          AND COALESCE(e.statut_actif, TRUE) = TRUE
                          AND {person_where}
                          {effectif_scope_sql}
                    )
                    SELECT
                        p.id_effectif,
                        p.nom_effectif,
                        p.prenom_effectif,
                        p.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        p.id_poste_actuel,
                        COALESCE(fp.codif_poste, '') AS codif_poste,
                        COALESCE(fp.codif_client, '') AS codif_client,
                        COALESCE(fp.intitule_poste, '') AS intitule_poste,
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine AS id_domaine_competence,
                        COALESCE(d.titre_court, d.titre, '') AS domaine_label,
                        d.couleur AS domaine_couleur,
                        ec.niveau_actuel,
                        ec.date_derniere_eval
                    FROM persons p
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_client = p.id_effectif
                     AND COALESCE(ec.actif, TRUE) = TRUE
                     AND COALESCE(ec.archive, FALSE) = FALSE
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                     AND c.id_comp IN (SELECT id_comp FROM comp_required)
                     AND c.etat = %s
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = p.id_poste_actuel
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = p.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    ORDER BY lower(COALESCE(p.nom_effectif, '')), lower(COALESCE(p.prenom_effectif, '')), c.code, c.intitule
                    LIMIT %s
                    """
                    params = (
                        scope_params
                        + [ETAT_ACTIVE, id_ent]
                        + person_params
                        + effectif_scope_params
                        + [ETAT_ACTIVE, id_ent, id_ent, safe_limit]
                    )

                elif selected_comp_ids:
                    sql = f"""
                    WITH
                    {cte_sql},
                    selected_ids AS (
                        SELECT DISTINCT unnest(%s::text[]) AS id_comp
                    ),
                    comp_required AS (
                        SELECT DISTINCT c.id_comp
                        FROM postes_scope ps
                        JOIN public.tbl_fiche_poste_competence fpc
                          ON fpc.id_poste = ps.id_poste
                        JOIN public.tbl_competence c
                          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                        WHERE c.etat = %s
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(fpc.masque, FALSE) = FALSE
                    ),
                    selected_comp AS (
                        SELECT DISTINCT
                            c.id_comp,
                            c.code,
                            c.intitule
                        FROM selected_ids si
                        JOIN comp_required cr
                          ON cr.id_comp = si.id_comp
                        JOIN public.tbl_competence c
                          ON c.id_comp = cr.id_comp
                        WHERE c.etat = %s
                          AND COALESCE(c.masque, FALSE) = FALSE
                    ),
                    selected_count AS (
                        SELECT COUNT(*)::int AS nb FROM selected_comp
                    ),
                    holders_scope AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND COALESCE(e.archive, FALSE) = FALSE
                          AND COALESCE(e.statut_actif, TRUE) = TRUE
                          {effectif_scope_sql}
                    ),
                    matches AS (
                        SELECT
                            e.id_effectif,
                            sc.id_comp,
                            sc.code,
                            sc.intitule,
                            ec.niveau_actuel,
                            ec.date_derniere_eval
                        FROM holders_scope e
                        JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = e.id_effectif
                         AND COALESCE(ec.actif, TRUE) = TRUE
                         AND COALESCE(ec.archive, FALSE) = FALSE
                        JOIN selected_comp sc
                          ON sc.id_comp = ec.id_comp
                    )
                    SELECT
                        e.id_effectif,
                        e.nom_effectif,
                        e.prenom_effectif,
                        e.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        e.id_poste_actuel,
                        COALESCE(fp.codif_poste, '') AS codif_poste,
                        COALESCE(fp.codif_client, '') AS codif_client,
                        COALESCE(fp.intitule_poste, '') AS intitule_poste,
                        COUNT(DISTINCT m.id_comp)::int AS matched_count,
                        scount.nb::int AS selected_count,
                        jsonb_agg(
                            jsonb_build_object(
                                'id_comp', m.id_comp,
                                'code', m.code,
                                'intitule', m.intitule,
                                'niveau_actuel', m.niveau_actuel,
                                'date_derniere_eval', m.date_derniere_eval
                            )
                            ORDER BY m.code, m.intitule
                        ) AS competences
                    FROM holders_scope e
                    JOIN matches m
                      ON m.id_effectif = e.id_effectif
                    CROSS JOIN selected_count scount
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = e.id_poste_actuel
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = e.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    GROUP BY
                        e.id_effectif, e.nom_effectif, e.prenom_effectif, e.id_service, e.id_poste_actuel,
                        o.nom_service, fp.codif_poste, fp.codif_client, fp.intitule_poste, scount.nb
                    HAVING (
                        CASE
                            WHEN %s = 'and' THEN COUNT(DISTINCT m.id_comp) = scount.nb
                            ELSE COUNT(DISTINCT m.id_comp) >= 1
                        END
                    )
                    ORDER BY COUNT(DISTINCT m.id_comp) DESC, lower(COALESCE(e.nom_effectif, '')), lower(COALESCE(e.prenom_effectif, ''))
                    LIMIT %s
                    """
                    params = (
                        scope_params
                        + [selected_comp_ids, ETAT_ACTIVE, ETAT_ACTIVE, id_ent]
                        + effectif_scope_params
                        + [id_ent, id_ent, op_norm, safe_limit]
                    )

                else:
                    sql = f"""
                    WITH
                    {cte_sql},
                    comp_scope AS (
                        SELECT DISTINCT
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.description
                        FROM postes_scope ps
                        JOIN public.tbl_fiche_poste_competence fpc
                          ON fpc.id_poste = ps.id_poste
                        JOIN public.tbl_competence c
                          ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                        WHERE c.etat = %s
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(fpc.masque, FALSE) = FALSE
                          AND (
                                {_sql_norm("c.code")} LIKE %s
                                OR {_sql_norm("c.intitule")} LIKE %s
                                OR {_sql_norm("c.description")} LIKE %s
                                OR c.code ILIKE %s
                                OR c.intitule ILIKE %s
                              )
                    ),
                    holders AS (
                        SELECT
                            ec.id_comp,
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel,
                            ec.niveau_actuel,
                            ec.date_derniere_eval
                        FROM public.tbl_effectif_client_competence ec
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = ec.id_effectif_client
                         AND e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         {effectif_scope_sql}
                        WHERE COALESCE(ec.actif, TRUE) = TRUE
                          AND COALESCE(ec.archive, FALSE) = FALSE
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        h.id_effectif,
                        h.nom_effectif,
                        h.prenom_effectif,
                        h.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        h.id_poste_actuel,
                        COALESCE(fp.codif_poste, '') AS codif_poste,
                        COALESCE(fp.codif_client, '') AS codif_client,
                        COALESCE(fp.intitule_poste, '') AS intitule_poste,
                        h.niveau_actuel,
                        h.date_derniere_eval
                    FROM comp_scope c
                    LEFT JOIN holders h
                      ON h.id_comp = c.id_comp
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = h.id_poste_actuel
                     AND fp.id_ent = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = h.id_service
                     AND COALESCE(o.archive, FALSE) = FALSE
                    ORDER BY c.code, c.intitule, lower(COALESCE(h.nom_effectif, '')), lower(COALESCE(h.prenom_effectif, ''))
                    LIMIT %s
                    """
                    params = (
                        scope_params
                        + [ETAT_ACTIVE, norm_like, norm_like, norm_like, like, like, id_ent]
                        + effectif_scope_params
                        + [id_ent, id_ent, safe_limit]
                    )

                cur.execute(sql, tuple(params))
                rows = cur.fetchall() or []
                items = _serialize_advanced_rows(rows)

                return {
                    "mode": mode_norm,
                    "q": query,
                    "operator": op_norm,
                    "selected_count": len(selected_comp_ids),
                    "total": len(items),
                    "items": items,
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur recherche avancée cartographie: {str(e)}")


@router.get("/skills/cartographie/recherche_avancee_pdf/{id_contact}")
def get_cartographie_recherche_avancee_pdf(
    id_contact: str,
    request: Request,
    mode: str = Query(default="competence"),
    q: str = Query(default=""),
    id_service: Optional[str] = Query(default=None),
    limit: int = Query(default=200),
    id_comps: Optional[str] = Query(default=None),
    op: str = Query(default="and"),
    id_effectif: Optional[str] = Query(default=None),
):
    mode_norm = "collaborateur" if (mode or "").strip().lower() == "collaborateur" else "competence"
    op_norm = "or" if (op or "").strip().lower() == "or" else "and"

    try:
        data = get_cartographie_recherche_avancee(
            id_contact=id_contact,
            request=request,
            mode=mode_norm,
            q=q,
            id_service=id_service,
            limit=max(1, min(int(limit or 200), 200)),
            id_comps=id_comps,
            op=op_norm,
            id_effectif=id_effectif,
        )

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                ent = skills_validate_enterprise(cur, id_ent)

        enterprise_name = (ent.get("nom_ent") or "Entreprise").strip()
        story = _build_advanced_pdf_story(
            enterprise_name=enterprise_name,
            data=data,
            mode_norm=mode_norm,
            query=(q or "").strip(),
            op_norm=op_norm,
        )
        pdf_bytes = build_pdf_document(
            story,
            meta={
                "title": "Recherche avancée - Cartographie des compétences",
                "doc_label": "Recherche avancée",
                "header_right": enterprise_name,
                "footer_left": "Novoskill Insights • Cartographie des compétences",
            },
            page_size=landscape(A4),
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": 'inline; filename="cartographie_recherche_avancee.pdf"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF recherche avancée cartographie: {e}")


@router.get("/skills/cartographie/cell/{id_contact}")
def get_cartographie_cell_detail(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_domaine: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),  # pour rester cohérent avec le filtre en cours
    etat: Optional[str] = Query(default="active"),
    include_masque: bool = Query(default=False),
    include_porteurs: bool = Query(default=True),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # --- scope postes (cohérent avec ton filtre service)
                svc_where = "TRUE"
                svc_params: List[Any] = []

                if id_service:
                    if id_service == "__NON_LIE__":
                        svc_where = "(p.id_service IS NULL OR p.id_service = '')"
                    else:
                        svc_where = "p.id_service = %s"
                        svc_params.append(id_service)

                postes_cte = f"""
                postes_scope AS (
                    SELECT
                        p.id_poste,
                        p.codif_poste,
                        p.codif_client,
                        p.intitule_poste,
                        p.id_service,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_ent = p.id_ent
                       AND o.id_service = p.id_service
                    WHERE
                        p.id_ent = %s
                        AND COALESCE(p.actif, TRUE) = TRUE
                        AND {svc_where}
                )
                """

                # --- check poste dans le scope
                cur.execute(
                    f"""
                    WITH {postes_cte}
                    SELECT *
                    FROM postes_scope
                    WHERE id_poste = %s
                    LIMIT 1
                    """,
                    tuple([id_ent] + svc_params + [id_poste])
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste hors périmètre (service) ou introuvable")
                
                # --- Paramétrage RH (titulaires cible + pause)
                cur.execute(
                    """
                    SELECT statut_poste, date_debut_validite, date_fin_validite, nb_titulaires_cible
                    FROM public.tbl_fiche_poste_param_rh
                    WHERE id_poste = %s
                    LIMIT 1
                    """,
                    (id_poste,)
                )
                prh = cur.fetchone() or {}
                statut_poste = (prh.get("statut_poste") or "actif").strip().lower()
                date_debut_validite = prh.get("date_debut_validite")
                date_fin_validite = prh.get("date_fin_validite")
                nb_titulaires_cible = prh.get("nb_titulaires_cible") or 1

                pause_active = False
                if statut_poste in ("gele", "temporaire"):
                    today = date.today()
                    if (date_debut_validite is None or today >= date_debut_validite) and (
                        date_fin_validite is None or today <= date_fin_validite
                    ):
                        pause_active = True


                # --- filtres compétence
                where_parts: List[str] = ["fpc.id_poste = %s"]
                params: List[Any] = [id_poste]

                if id_domaine:
                    where_parts.append("c.domaine = %s")
                    params.append(id_domaine)

                etat_norm = (etat or "").strip().lower()
                if etat_norm:
                    where_parts.append("c.etat = %s")
                    params.append(etat_norm)

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = " AND ".join(where_parts)

                # --- liste des compétences (drilldown)
                sql = f"""
                WITH {postes_cte}
                SELECT
                    c.id_comp,
                    c.code,
                    c.intitule,
                    c.description,
                    c.domaine AS id_domaine_competence,
                    c.etat,
                    c.masque,

                    fpc.niveau_requis,
                    fpc.poids_criticite,
                    fpc.freq_usage,
                    fpc.impact_resultat,
                    fpc.dependance,
                    fpc.date_valorisation,

                    d.titre,
                    d.titre_court,
                    d.couleur
                FROM public.tbl_fiche_poste_competence fpc
                JOIN postes_scope ps
                  ON ps.id_poste = fpc.id_poste
                JOIN public.tbl_competence c
                  ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                LEFT JOIN public.tbl_domaine_competence d
                  ON d.id_domaine_competence = c.domaine
                WHERE {where_sql}
                ORDER BY
                    COALESCE(d.titre_court, d.titre, ''),
                    c.code
                """

                cur.execute(
                    sql,
                    tuple([id_ent] + svc_params + params)
                )
                rows = cur.fetchall() or []

                # Domaine (si demandé)
                domaine_obj = None
                if id_domaine:
                    for r in rows:
                        if r.get("id_domaine_competence") == id_domaine:
                            domaine_obj = {
                                "id_domaine_competence": r.get("id_domaine_competence"),
                                "titre": r.get("titre"),
                                "titre_court": r.get("titre_court"),
                                "couleur": r.get("couleur"),
                            }
                            break
                    if domaine_obj is None:
                        domaine_obj = {"id_domaine_competence": id_domaine}

                # --- nombre de postes concernés par le domaine sélectionné (pour les cartes du modal)
                nb_postes_concernes = 1
                if id_domaine:
                    sql_postes_concernes = f"""
                    WITH {postes_cte}
                    SELECT COUNT(DISTINCT ps.id_poste)::int AS nb_postes
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste_competence fpc
                      ON fpc.id_poste = ps.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE c.domaine = %s
                      AND c.etat = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                    """
                    cur.execute(
                        sql_postes_concernes,
                        tuple([id_ent] + svc_params + [id_domaine, (etat_norm or "active")])
                    )
                    row_nb = cur.fetchone() or {}
                    nb_postes_concernes = int(row_nb.get("nb_postes") or 0)

                # --- construction competences (modifiable / enrichissable)
                competences = []
                for r in rows:
                    competences.append({
                        "id_comp": r.get("id_comp"),
                        "code": r.get("code"),
                        "intitule": r.get("intitule"),
                        "description": r.get("description"),
                        "id_domaine_competence": r.get("id_domaine_competence"),
                        "etat": r.get("etat"),
                        "masque": r.get("masque"),
                        "niveau_requis": r.get("niveau_requis"),
                        "poids_criticite": r.get("poids_criticite"),
                        "freq_usage": r.get("freq_usage"),
                        "impact_resultat": r.get("impact_resultat"),
                        "dependance": r.get("dependance"),
                        "date_valorisation": r.get("date_valorisation"),
                        "domaine": {
                            "id_domaine_competence": r.get("id_domaine_competence"),
                            "titre": r.get("titre"),
                            "titre_court": r.get("titre_court"),
                            "couleur": r.get("couleur"),
                        },
                        # Couverture (brute / dispo / qualifiée)
                        "nb_porteurs": 0,  # compat (brut)
                        "nb_porteurs_disponibles": 0,
                        "nb_porteurs_qualifies": 0,
                        "gap_qualifie": 0,
                        # Détail porteurs (optionnel via include_porteurs)
                        "porteurs": []
                    })

                # ============================
                # Couverture collaborateurs (brute / dispo / qualifiée) pour ces compétences
                # ============================
                ids_comp = [c.get("id_comp") for c in competences if c.get("id_comp")]
                if ids_comp:

                    sql_cov = f"""
                    WITH comp_scope AS (
                        SELECT UNNEST(%s::text[]) AS id_comp
                    ),
                    base AS (
                        SELECT
                            cs.id_comp,
                            e.id_effectif,
                            (b.id_break IS NULL) AS is_disponible,
                            CASE
                                WHEN UPPER(BTRIM(COALESCE(fpc.niveau_requis, ''))) = 'A' THEN 1
                                WHEN UPPER(BTRIM(COALESCE(fpc.niveau_requis, ''))) = 'B' THEN 2
                                WHEN UPPER(BTRIM(COALESCE(fpc.niveau_requis, ''))) = 'C' THEN 3
                                WHEN UPPER(BTRIM(COALESCE(fpc.niveau_requis, ''))) = 'D' THEN 4
                                ELSE 0
                            END AS req_rank,
                            CASE
                                WHEN niv_norm LIKE 'init%%' OR niv_norm LIKE '%%initial%%' OR niv_norm LIKE 'debut%%' OR niv_norm LIKE '%%debutant%%' THEN 1
                                WHEN niv_norm LIKE 'inter%%' OR niv_norm LIKE '%%intermediaire%%' THEN 2
                                WHEN niv_norm LIKE 'avan%%' OR niv_norm LIKE '%%avance%%' THEN 3
                                WHEN niv_norm LIKE 'exp%%'  OR niv_norm LIKE '%%expert%%' THEN 4
                                WHEN niv_norm ~ '^[abcd]($|[^a-z])' THEN
                                    CASE SUBSTRING(niv_norm FROM 1 FOR 1)
                                        WHEN 'a' THEN 1
                                        WHEN 'b' THEN 2
                                        WHEN 'c' THEN 3
                                        WHEN 'd' THEN 4
                                        ELSE 0
                                    END
                                ELSE 0
                            END AS act_rank
                        FROM comp_scope cs
                        JOIN public.tbl_competence c
                          ON c.id_comp = cs.id_comp
                        JOIN public.tbl_fiche_poste_competence fpc
                          ON fpc.id_poste = %s
                         AND (fpc.id_competence = cs.id_comp OR fpc.id_competence = c.code)
                        JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_comp = cs.id_comp
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = ec.id_effectif_client
                        LEFT JOIN public.tbl_effectif_client_break b
                          ON b.id_effectif = e.id_effectif
                         AND COALESCE(b.archive, FALSE) = FALSE
                         AND CURRENT_DATE BETWEEN b.date_debut AND b.date_fin
                        CROSS JOIN LATERAL (
                          SELECT translate(
                                lower(COALESCE(ec.niveau_actuel, '')),
                                'éèêëàâäîïôöùûüç',
                                'eeeeaaaiioouuuc'
                            ) AS niv_norm
                        ) t
                        WHERE
                            e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                            AND COALESCE(ec.actif, TRUE) = TRUE
                            AND COALESCE(ec.archive, FALSE) = FALSE
                            AND e.id_poste_actuel = %s
                    )
                    SELECT
                        id_comp,
                        COUNT(DISTINCT id_effectif) AS nb_porteurs_brut,
                        COUNT(DISTINCT id_effectif) FILTER (WHERE is_disponible) AS nb_porteurs_disponibles,
                        COUNT(DISTINCT id_effectif) FILTER (
                            WHERE is_disponible AND req_rank > 0 AND act_rank >= req_rank
                        ) AS nb_porteurs_qualifies
                    FROM base
                    GROUP BY id_comp
                    """

                    cur.execute(
                        sql_cov,
                        tuple([ids_comp, id_poste, id_ent, id_poste])
                    )

                    cov_rows = cur.fetchall() or []
                    cov_by_comp = {r.get("id_comp"): r for r in cov_rows if r.get("id_comp")}

                    for comp in competences:
                        cid = comp.get("id_comp")
                        cvr = cov_by_comp.get(cid) or {}
                        nb_brut = int(cvr.get("nb_porteurs_brut") or 0)
                        nb_dispo = int(cvr.get("nb_porteurs_disponibles") or 0)
                        nb_qual = int(cvr.get("nb_porteurs_qualifies") or 0)

                        # compat: nb_porteurs = brut
                        comp["nb_porteurs"] = nb_brut
                        comp["nb_porteurs_disponibles"] = nb_dispo
                        comp["nb_porteurs_qualifies"] = nb_qual
                        comp["gap_qualifie"] = max(0, int(nb_titulaires_cible) - nb_qual)

                    # Détail porteurs uniquement si demandé (évite payload inutile)
                    if include_porteurs:
                        sql_porteurs = f"""
                        WITH comp_scope AS (
                            SELECT UNNEST(%s::text[]) AS id_comp
                        )
                        SELECT
                            cs.id_comp,
                            e.id_effectif,
                            e.prenom_effectif,
                            e.nom_effectif,
                            e.id_service,
                            COALESCE(o.nom_service, '') AS nom_service,
                            e.id_poste_actuel,
                            COALESCE(p.intitule_poste, '') AS intitule_poste,
                            ec.niveau_actuel,
                            (b.id_break IS NULL) AS is_disponible,
                            b.date_debut AS break_debut,
                            b.date_fin AS break_fin
                        FROM comp_scope cs
                        JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_comp = cs.id_comp
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = ec.id_effectif_client
                        LEFT JOIN public.tbl_effectif_client_break b
                          ON b.id_effectif = e.id_effectif
                         AND COALESCE(b.archive, FALSE) = FALSE
                         AND CURRENT_DATE BETWEEN b.date_debut AND b.date_fin
                        LEFT JOIN public.tbl_entreprise_organigramme o
                          ON o.id_ent = e.id_ent
                         AND o.id_service = e.id_service
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = e.id_poste_actuel
                        WHERE
                            e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                            AND COALESCE(ec.actif, TRUE) = TRUE
                            AND COALESCE(ec.archive, FALSE) = FALSE
                            AND e.id_poste_actuel = %s
                        ORDER BY cs.id_comp, e.nom_effectif, e.prenom_effectif
                        """

                        cur.execute(
                            sql_porteurs,
                            tuple([ids_comp, id_ent, id_poste])
                        )

                        rows_p = cur.fetchall() or []

                        porteurs_by_comp = {}
                        for rp in rows_p:
                            cid = rp.get("id_comp")
                            if not cid:
                                continue
                            porteurs_by_comp.setdefault(cid, []).append({
                                "id_effectif": rp.get("id_effectif"),
                                "prenom_effectif": rp.get("prenom_effectif"),
                                "nom_effectif": rp.get("nom_effectif"),
                                "id_service": rp.get("id_service"),
                                "nom_service": rp.get("nom_service"),
                                "id_poste_actuel": rp.get("id_poste_actuel"),
                                "intitule_poste": rp.get("intitule_poste"),
                                "niveau_actuel": rp.get("niveau_actuel"),
                                "is_disponible": rp.get("is_disponible"),
                                "break_debut": rp.get("break_debut"),
                                "break_fin": rp.get("break_fin"),
                            })

                        for comp in competences:
                            cid = comp.get("id_comp")
                            comp["porteurs"] = porteurs_by_comp.get(cid, [])


                nb_competences_non_couvertes = len([
                    comp for comp in competences
                    if int(comp.get("nb_porteurs_qualifies") or 0) < int(nb_titulaires_cible or 1)
                ])

                # réponse clean
                return {
                    "poste": {
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                        "id_service": poste.get("id_service"),
                        "nom_service": poste.get("nom_service"),
                        "param_rh": {
                            "statut_poste": statut_poste,
                            "date_debut_validite": date_debut_validite,
                            "date_fin_validite": date_fin_validite,
                            "nb_titulaires_cible": nb_titulaires_cible,
                            "pause_active": pause_active,
                        },
                    },
                    "domaine": domaine_obj,
                    "nb_competences": len(rows),
                    "nb_postes_concernes": nb_postes_concernes,
                    "nb_competences_non_couvertes": nb_competences_non_couvertes,
                    "competences": competences
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur détail cellule cartographie: {str(e)}")
