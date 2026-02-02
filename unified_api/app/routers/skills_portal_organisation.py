from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn, resolve_insights_context
import html as _html
import re


router = APIRouter()

NON_LIE_ID = "__NON_LIE__"
TOUS_SERVICES_ID = "__ALL__"


# ======================================================
# Models
# ======================================================
class ServiceNode(BaseModel):
    id_service: str
    nom_service: str
    id_service_parent: Optional[str] = None
    nb_postes: int = 0
    nb_effectifs: int = 0
    children: List["ServiceNode"] = []


class ServiceInfo(BaseModel):
    id_service: str
    nom_service: str


class PosteItem(BaseModel):
    id_poste: str
    codif_poste: str
    codif_client: Optional[str] = None
    intitule_poste: str
    id_service: Optional[str] = None
    isresponsable: Optional[bool] = None

    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None
    responsabilites_html: Optional[str] = None
    mobilite: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_education_minimum: Optional[str] = None
    risque_physique: Optional[str] = None

    nb_effectifs: int = 0
    date_maj: Optional[str] = None


class PostesResponse(BaseModel):
    service: ServiceInfo
    postes: List[PosteItem]


ServiceNode.model_rebuild()


# ======================================================
# Helpers
# ======================================================

def _build_tree(flat_services: List[Dict], counts_by_service: Dict[str, Dict[str, int]]) -> List[ServiceNode]:
    nodes: Dict[str, ServiceNode] = {}
    roots: List[ServiceNode] = []

    # Create nodes
    for s in flat_services:
        sid = s["id_service"]
        c = counts_by_service.get(sid, {"nb_postes": 0, "nb_effectifs": 0})
        nodes[sid] = ServiceNode(
            id_service=sid,
            nom_service=s["nom_service"],
            id_service_parent=s.get("id_service_parent"),
            nb_postes=int(c.get("nb_postes") or 0),
            nb_effectifs=int(c.get("nb_effectifs") or 0),
            children=[],
        )

    # Link parent -> child (missing/invalid parent => root)
    for sid, node in nodes.items():
        pid = node.id_service_parent
        if pid and pid in nodes and pid != sid:
            nodes[pid].children.append(node)
        else:
            roots.append(node)

    # Optional: sort children by name for stable display
    def sort_rec(lst: List[ServiceNode]):
        lst.sort(key=lambda x: (x.nom_service or "").lower())
        for n in lst:
            if n.children:
                sort_rec(n.children)

    sort_rec(roots)
    return roots
# ======================================================
# RTF -> HTML (minimal, safe)
# - Objectif: conserver le gras (\b) et les listes à puces (RichEdit \pntext)
# - Sortie: HTML sans attributs (safe), uniquement <p>, <strong>, <ul>, <li>, <br>
# ======================================================

_BULLET_CHARS = {"•", "·"}  # selon export RTF (Symbol / cp1252)
def _dt_to_iso(v):
    """Sérialisation stable (datetime/date -> ISO)."""
    if v is None:
        return None
    try:
        return v.isoformat()
    except Exception:
        try:
            return str(v)
        except Exception:
            return None


def _rtf_to_html_basic(rtf: str) -> str:
    r"""
    Convertisseur RTF minimal:
    - \\b / \\b0 -> <strong>
    - \\par -> nouvelle ligne (paragraphes)
    - listes RichEdit via \\pntext -> <ul><li>...</li></ul>
    - \\line -> <br>
    - \\'xx -> décodage cp1252
    - \\uN? -> unicode
    """
    paragraphs = []  # list[(is_list: bool, html_content: str)]
    parts = []
    bold_open = False
    saw_pntext = False
    suppress_bullet = False
    suppress_tab = False
    in_body = False  # on ignore l'en-tête RTF (fonttbl, colortbl, generator...)
    underline_open = False



    def set_bold(on: bool):
        nonlocal bold_open
        if on and not bold_open:
            parts.append("<strong>")
            bold_open = True
        if (not on) and bold_open:
            parts.append("</strong>")
            bold_open = False

    def set_underline(on: bool):
        nonlocal underline_open
        if on and not underline_open:
            parts.append("<u>")
            underline_open = True
        if (not on) and underline_open:
            parts.append("</u>")
            underline_open = False

    def flush_paragraph():
        nonlocal parts, bold_open, underline_open, saw_pntext, suppress_bullet, suppress_tab
        if not in_body:
            parts = []
            bold_open = False
            underline_open = False
            saw_pntext = False
            suppress_bullet = False
            suppress_tab = False
            return
             


        if bold_open:
            parts.append("</strong>")
            bold_open = False

        if underline_open:
            parts.append("</u>")
            underline_open = False

        html_txt = "".join(parts).strip()
        parts = []

        saw_pntext_local = saw_pntext
        saw_pntext = False
        suppress_bullet = False
        suppress_tab = False

        if not html_txt:
            return

        # Si le paragraphe ne contient que des tags (ex: <strong></strong>), on le jette
        plain = re.sub(r"<[^>]+>", "", html_txt)
        if not plain.strip():
            return

        # Détection liste: pntext ou bullet au début (au cas où)
        lt = plain.lstrip()
        is_list = saw_pntext_local or (lt[:1] in _BULLET_CHARS)


        if is_list:
            # Si un bullet "survit", on le retire (cas sans pntext)
            html_txt = re.sub(r"^(<strong>)?\s*[•·]\s*", r"\1", html_txt)
            paragraphs.append((True, html_txt.strip()))
        else:
            paragraphs.append((False, html_txt.strip()))

    i = 0
    n = len(rtf)

    while i < n:
        ch = rtf[i]

        # on ignore les accolades (structure RTF)
        if ch in "{}":
            i += 1
            continue

        # IMPORTANT: les retours ligne "physiques" dans une string RTF ne sont pas du contenu.
        # On les ignore, sinon ça produit des trous énormes en HTML (surtout avec white-space: pre-wrap).
        if ch in "\r\n\t":
            i += 1
            continue

        # texte normal
        if ch != "\\":
            if not in_body:
                i += 1
                continue

            # suppression bullet dans la séquence pntext
            if suppress_bullet and ch in _BULLET_CHARS:
                suppress_bullet = False
                i += 1
                continue

            parts.append(_html.escape(ch))
            i += 1
            continue

        # contrôle RTF
        i += 1
        if i >= n:
            break

        c = rtf[i]

        # échappements littéraux \\, \{, \}
        if c in ["\\", "{", "}"]:
            if in_body:
                parts.append(_html.escape(c))
            i += 1
            continue

        # hex escape \'xx
        if c == "'":
            if i + 2 < n:
                hx = rtf[i + 1 : i + 3]
                try:
                    char = bytes([int(hx, 16)]).decode("cp1252")
                except Exception:
                    char = ""

                if in_body:
                    if suppress_bullet and char in _BULLET_CHARS:
                        suppress_bullet = False
                    else:
                        parts.append(_html.escape(char))

                i += 3
            else:
                break
            continue

        # control word (lettres)
        j = i
        while j < n and rtf[j].isalpha():
            j += 1
        word = rtf[i:j]
        k = j

        # param numérique optionnel
        sign = 1
        if k < n and rtf[k] == "-":
            sign = -1
            k += 1
        num = ""
        while k < n and rtf[k].isdigit():
            num += rtf[k]
            k += 1

        # control symbol (ex: \~, \-)
        if word == "":
            sym = rtf[i]
            if in_body:
                if sym == "~":
                    parts.append(" ")
                elif sym == "-":
                    parts.append("-")
            i += 1
            continue

        # Dès qu'on voit \pard ou \plain, on considère qu'on est dans le "vrai" contenu
        if word in ("pard", "plain"):
            in_body = True
            set_bold(False)
            set_underline(False)

        # si pas encore dans le contenu, on skip tout
        if not in_body:
            if k < n and rtf[k] == " ":
                k += 1
            i = k
            continue

        # gestion des mots utiles
        if word == "par":
            flush_paragraph()
        elif word == "line":
            parts.append("<br>")
        elif word == "tab":
            if suppress_tab:
                suppress_tab = False
            else:
                parts.append(" ")
        elif word == "b":
            if num == "":
                set_bold(True)
            else:
                set_bold(int(num) != 0)
        elif word == "ul":
            if num == "":
                set_underline(True)
            else:
                set_underline(int(num) != 0)
        elif word in ("ulnone",):
            set_underline(False)
        elif word == "pntext":
            # marqueur de liste (RichEdit)
            saw_pntext = True
            suppress_bullet = True
            suppress_tab = True
        elif word == "u" and num:
            val = sign * int(num)
            if val < 0:
                val += 65536
            try:
                parts.append(_html.escape(chr(val)))
            except Exception:
                pass
            # parfois un fallback '?' suit, on l'ignore
            if k < n and rtf[k] == "?":
                k += 1

        # consomme l'espace délimiteur
        if k < n and rtf[k] == " ":
            k += 1
        i = k

    flush_paragraph()

    # Regroupement des items de liste consécutifs
    out = []
    idx = 0
    while idx < len(paragraphs):
        is_list, content = paragraphs[idx]
        if is_list:
            items = []
            while idx < len(paragraphs) and paragraphs[idx][0]:
                items.append(f"<li>{paragraphs[idx][1]}</li>")
                idx += 1
            out.append("<ul>" + "".join(items) + "</ul>")
        else:
            out.append(f"<p>{content}</p>")
            idx += 1

    return "".join(out).strip()


def _responsabilites_to_html(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None

    # RTF ?
    if s.startswith("{\\rtf"):
        return _rtf_to_html_basic(s)

    # texte simple -> HTML safe
    return _html.escape(s).replace("\n", "<br>")



class PosteCompetenceItem(BaseModel):
    id_competence: str
    code: str
    intitule: str
    description: Optional[str] = None
    etat: Optional[str] = None
    niveau_requis: Optional[str] = None
    poids_criticite: Optional[float] = None

class PosteCertificationItem(BaseModel):
    id_certification: str
    nom_certification: str
    description: Optional[str] = None
    categorie: Optional[str] = None
    niveau_exigence: Optional[str] = None


class PosteDetailResponse(BaseModel):
    id_poste: str
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None

    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None            # RTF brut (pour round-trip futur)
    responsabilites_html: Optional[str] = None       # HTML prêt à afficher

    isresponsable: Optional[bool] = None
    date_maj: Optional[str] = None                   # ISO timestamp (JS -> date only)

    # Exigences > Contraintes
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_titre: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    competences: List[PosteCompetenceItem] = []
    certifications: List[PosteCertificationItem] = []


# ======================================================
# Routes
# ======================================================
@router.get(
    "/skills/organisation/services/{id_contact}",
    response_model=List[ServiceNode],
)
def get_services_tree(id_contact: str):
    """
    Renvoie l'arbre des services (multi-niveaux) + un noeud spécial "Non lié"
    pour les postes sans service (ou service inexistant/archivé).

    Règles:
    - services: tbl_entreprise_organigramme (archive=FALSE)
    - postes: tbl_fiche_poste (actif=TRUE, id_ent)
    - effectifs: tbl_effectif_client (archive=FALSE, statut_actif=TRUE, is_temp=FALSE)
    - pas d'inclusion des sous-services (les compteurs sont strictement sur le service)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = resolve_insights_context(cur, id_contact)  # id_contact = id_effectif (compat)
                id_ent = ctx["id_ent"]


                # Services actifs
                cur.execute(
                    """
                    SELECT
                        o.id_service,
                        o.nom_service,
                        o.id_service_parent
                    FROM public.tbl_entreprise_organigramme o
                    WHERE o.id_ent = %s
                      AND o.archive = FALSE
                    """,
                    (id_ent,),
                )
                services = cur.fetchall() or []
                service_ids = {s["id_service"] for s in services}

                # Postes actifs (pour compteurs)
                cur.execute(
                    """
                    SELECT
                        p.id_poste,
                        p.id_service
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                    """,
                    (id_ent,),
                )
                postes = cur.fetchall() or []

                # Effectifs par poste
                cur.execute(
                    """
                    SELECT
                        e.id_poste_actuel,
                        COUNT(*)::int AS nb
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND e.archive = FALSE
                      AND e.statut_actif = TRUE
                      AND e.is_temp = FALSE
                      AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                    """,
                    (id_ent,),
                )
                eff_rows = cur.fetchall() or []
                eff_by_poste = {r["id_poste_actuel"]: int(r["nb"] or 0) for r in eff_rows}

                # Compteurs par service + non lié
                counts_by_service: Dict[str, Dict[str, int]] = {}
                non_lie_postes = 0
                non_lie_effectifs = 0

                for p in postes:
                    sid = p.get("id_service")
                    pid = p.get("id_poste")
                    nb_eff = eff_by_poste.get(pid, 0)

                    # "Non lié" = NULL ou service absent (archivé/inexistant/diff ent)
                    if not sid or sid not in service_ids:
                        non_lie_postes += 1
                        non_lie_effectifs += nb_eff
                        continue

                    if sid not in counts_by_service:
                        counts_by_service[sid] = {"nb_postes": 0, "nb_effectifs": 0}
                    counts_by_service[sid]["nb_postes"] += 1
                    counts_by_service[sid]["nb_effectifs"] += nb_eff

                # Arbre
                roots = _build_tree(services, counts_by_service)

                # Noeud spécial "Non lié" au niveau root
                non_lie_node = ServiceNode(
                    id_service=NON_LIE_ID,
                    nom_service="Non lié",
                    id_service_parent=None,
                    nb_postes=non_lie_postes,
                    nb_effectifs=non_lie_effectifs,
                    children=[],
                )

                # Noeud spécial "Tous les services" au niveau root
                total_postes = len(postes)
                total_effectifs = sum(eff_by_poste.get(p.get("id_poste"), 0) for p in postes)

                tous_node = ServiceNode(
                    id_service=TOUS_SERVICES_ID,
                    nom_service="Tous les services",
                    id_service_parent=None,
                    nb_postes=total_postes,
                    nb_effectifs=total_effectifs,
                    children=[],
                )

                # Ordre d'affichage: Tous -> services -> Non lié
                return [tous_node] + roots + [non_lie_node]


    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/organisation/poste_detail/{id_contact}/{id_poste}",
    response_model=PosteDetailResponse,
)
def get_poste_detail(id_contact: str, id_poste: str):
    """
    Détail d'un poste pour le modal.
    On renvoie uniquement les champs nécessaires à l'onglet "Définition".
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = resolve_insights_context(cur, id_contact)  # id_contact = id_effectif (compat)
                id_ent = ctx["id_ent"]

                cur.execute(
                    """
                    SELECT
                        p.id_poste,
                        p.codif_poste,
                        p.codif_client,
                        p.intitule_poste,
                        p.isresponsable,
                        p.mission_principale,
                        p.responsabilites,
                        p.date_maj,

                        -- Contraintes
                        p.niveau_education_minimum,
                        p.nsf_groupe_code,
                        p.nsf_groupe_obligatoire,
                        p.mobilite,
                        p.risque_physique,
                        p.perspectives_evolution,
                        p.niveau_contrainte,
                        p.detail_contrainte,

                        -- Domaine diplôme (NSF)
                        g.titre AS nsf_groupe_titre

                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_nsf_groupe g
                           ON g.code = p.nsf_groupe_code
                          AND COALESCE(g.masque, FALSE) = FALSE
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (id_ent, id_poste),
                )


                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")
                
                # --- Compétences requises (tbl_fiche_poste_competence + tbl_competence)
                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      c.description,
                      c.etat,
                      fpc.niveau_requis,
                      fpc.poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
                    WHERE fpc.id_poste = %s
                      AND c.etat IN ('active', 'à valider')
                      AND COALESCE(c.masque, FALSE) = FALSE
                    ORDER BY fpc.poids_criticite DESC NULLS LAST, c.intitule ASC
                    """,
                    (id_poste,)
                )

                comps = []
                for rr in cur.fetchall() or []:
                    comps.append({
                        "id_competence": (rr.get("id_comp") or ""),
                        "code": (rr.get("code") or ""),
                        "intitule": (rr.get("intitule") or ""),
                        "description": rr.get("description"),
                        "etat": rr.get("etat"),
                        "niveau_requis": rr.get("niveau_requis"),
                        "poids_criticite": rr.get("poids_criticite"),
                    })

                # --- Certifications requises (tbl_fiche_poste_certification + tbl_certification)
                cur.execute(
                    """
                    SELECT
                      c.id_certification,
                      c.nom_certification,
                      c.description,
                      c.categorie,
                      fpc.niveau_exigence
                    FROM public.tbl_fiche_poste_certification fpc
                    JOIN public.tbl_certification c
                      ON c.id_certification = fpc.id_certification
                    WHERE fpc.id_poste = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                    ORDER BY c.categorie ASC NULLS LAST, c.nom_certification ASC
                    """,
                    (id_poste,)
                )

                certs = []
                for rr in cur.fetchall() or []:
                    certs.append({
                        "id_certification": (rr.get("id_certification") or ""),
                        "nom_certification": (rr.get("nom_certification") or ""),
                        "description": rr.get("description"),
                        "categorie": rr.get("categorie"),
                        "niveau_exigence": rr.get("niveau_exigence"),
                    })


                dm = r.get("date_maj")
                try:
                    dm_iso = dm.isoformat() if dm else None
                except Exception:
                    dm_iso = str(dm) if dm else None

                raw_resp = r.get("responsabilites")

                return PosteDetailResponse(
                    id_poste=r["id_poste"],
                    codif_poste=r.get("codif_poste"),
                    codif_client=r.get("codif_client"),
                    intitule_poste=r.get("intitule_poste"),
                    isresponsable=r.get("isresponsable"),
                    mission_principale=r.get("mission_principale"),
                    responsabilites=raw_resp,
                    responsabilites_html=_responsabilites_to_html(raw_resp),
                    date_maj=dm_iso,
                    niveau_education_minimum=r.get("niveau_education_minimum"),
                    nsf_groupe_code=r.get("nsf_groupe_code"),
                    nsf_groupe_titre=r.get("nsf_groupe_titre"),
                    nsf_groupe_obligatoire=r.get("nsf_groupe_obligatoire"),
                    mobilite=r.get("mobilite"),
                    risque_physique=r.get("risque_physique"),
                    perspectives_evolution=r.get("perspectives_evolution"),
                    niveau_contrainte=r.get("niveau_contrainte"),
                    detail_contrainte=r.get("detail_contrainte"),
                    competences=comps,
                    certifications=certs,

                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/organisation/postes/{id_contact}/{id_service}",
    response_model=PostesResponse,
)
def get_postes_for_service(id_contact: str, id_service: str):
    """
    Renvoie les postes (fiches de poste) rattachés au service sélectionné.
    - Si id_service = "__NON_LIE__", renvoie les postes sans service ou service inexistant/archivé.
    - Pas d'inclusion des sous-services.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                ctx = resolve_insights_context(cur, id_contact)  # id_contact = id_effectif (compat)
                id_ent = ctx["id_ent"]


                # Effectifs par poste (sous-requête)
                # (on la réutilise via LEFT JOIN)
                eff_subquery = """
                    SELECT
                        e.id_poste_actuel,
                        COUNT(*)::int AS nb
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND e.archive = FALSE
                      AND e.statut_actif = TRUE
                      AND e.is_temp = FALSE
                      AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                """

                if id_service == TOUS_SERVICES_ID:
                    service_info = ServiceInfo(id_service=TOUS_SERVICES_ID, nom_service="Tous les services")

                    cur.execute(
                        f"""
                        SELECT
                            p.id_poste,
                            p.codif_poste,
                            p.codif_client,
                            p.intitule_poste,
                            p.id_service,
                            p.isresponsable,
                            p.date_maj,
                            COALESCE(ec.nb, 0)::int AS nb_effectifs
                        FROM public.tbl_fiche_poste p
                        LEFT JOIN ({eff_subquery}) ec
                            ON ec.id_poste_actuel = p.id_poste
                        WHERE p.id_ent = %s
                        AND COALESCE(p.actif, TRUE) = TRUE
                        ORDER BY p.intitule_poste
                        """,
                        (id_ent, id_ent),
                    )

                    rows = cur.fetchall() or []

                    postes = [
                        PosteItem(
                            id_poste=r["id_poste"],
                            codif_poste=r["codif_poste"],
                            codif_client=r.get("codif_client"),
                            intitule_poste=r["intitule_poste"],
                            id_service=r.get("id_service"),
                            isresponsable=r.get("isresponsable"),
                            nb_effectifs=int(r.get("nb_effectifs") or 0),
                            date_maj=_dt_to_iso(r.get("date_maj")),
                        )
                        for r in rows
                    ]


                    return PostesResponse(service=service_info, postes=postes)


                if id_service == NON_LIE_ID:
                    service_info = ServiceInfo(id_service=NON_LIE_ID, nom_service="Non lié")

                    cur.execute(
                        f"""
                        SELECT
                            p.id_poste,
                            p.codif_poste,
                            p.codif_client,
                            p.intitule_poste,
                            p.id_service,
                            p.isresponsable,
                            p.date_maj,
                            COALESCE(ec.nb, 0)::int AS nb_effectifs
                        FROM public.tbl_fiche_poste p
                        LEFT JOIN ({eff_subquery}) ec
                            ON ec.id_poste_actuel = p.id_poste
                        LEFT JOIN public.tbl_entreprise_organigramme o
                            ON o.id_service = p.id_service
                            AND o.id_ent = %s
                            AND o.archive = FALSE
                        WHERE p.id_ent = %s
                        AND COALESCE(p.actif, TRUE) = TRUE
                        AND (p.id_service IS NULL OR o.id_service IS NULL)
                        ORDER BY p.intitule_poste
                        """,
                        (id_ent, id_ent, id_ent),
                    )

                    rows = cur.fetchall() or []

                    postes = [
                        PosteItem(
                            id_poste=r["id_poste"],
                            codif_poste=r["codif_poste"],
                            codif_client=r.get("codif_client"),
                            intitule_poste=r["intitule_poste"],
                            id_service=r.get("id_service"),
                            isresponsable=r.get("isresponsable"),
                            nb_effectifs=int(r.get("nb_effectifs") or 0),
                            date_maj=_dt_to_iso(r.get("date_maj")),
                        )
                        for r in rows
                    ]

                    return PostesResponse(service=service_info, postes=postes)

                # Service "normal" (doit exister et être actif)
                cur.execute(
                    """
                    SELECT
                        o.id_service,
                        o.nom_service
                    FROM public.tbl_entreprise_organigramme o
                    WHERE o.id_ent = %s
                      AND o.id_service = %s
                      AND o.archive = FALSE
                    """,
                    (id_ent, id_service),
                )
                srow = cur.fetchone()
                if srow is None:
                    raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")

                service_info = ServiceInfo(id_service=srow["id_service"], nom_service=srow["nom_service"])

                cur.execute(
                    f"""
                    SELECT
                        p.id_poste,
                        p.codif_poste,
                        p.codif_client,
                        p.intitule_poste,
                        p.id_service,
                        p.isresponsable,
                        p.date_maj,
                        COALESCE(ec.nb, 0)::int AS nb_effectifs
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN ({eff_subquery}) ec
                        ON ec.id_poste_actuel = p.id_poste
                    WHERE p.id_ent = %s
                    AND COALESCE(p.actif, TRUE) = TRUE
                    AND p.id_service = %s
                    ORDER BY p.intitule_poste
                    """,
                    (id_ent, id_ent, id_service),
                )

                rows = cur.fetchall() or []

                postes = [
                    PosteItem(
                        id_poste=r["id_poste"],
                        codif_poste=r["codif_poste"],
                        codif_client=r.get("codif_client"),
                        intitule_poste=r["intitule_poste"],
                        id_service=r.get("id_service"),
                        isresponsable=r.get("isresponsable"),
                        nb_effectifs=int(r.get("nb_effectifs") or 0),
                        date_maj=_dt_to_iso(r.get("date_maj")),
                    )
                    for r in rows
                ]

                return PostesResponse(service=service_info, postes=postes)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
