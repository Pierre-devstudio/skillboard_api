from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
)

import html as _html
import re
from html.parser import HTMLParser

from app.routers.skills_portal_pdf_common import build_pdf_document, build_competence_pdf_story
from app.routers.studio_portal_organisation import (
    _build_poste_pdf_story,
    _fetch_ccn_referential,
    _fetch_logo_bytes_for_ent,
    _fetch_poste_ccn_dossier,
    _pdf_first_non_empty,
    _pdf_format_footer_date,
    _pdf_latin1_safe,
)


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
def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)

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
def _fetch_poste_pdf_payload_for_ent(cur, id_ent: str, pid: str) -> dict:
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
          COALESCE(s.nom_service, '') AS nom_service,
          COALESCE(ent.nom_ent, '') AS nom_ent,
          COALESCE(ent.idcc, '') AS ent_idcc
        FROM public.tbl_fiche_poste p
        LEFT JOIN public.tbl_entreprise_organigramme s
          ON s.id_service = p.id_service
         AND s.id_ent = p.id_ent
         AND COALESCE(s.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise ent
          ON ent.id_ent = p.id_ent
         AND COALESCE(ent.masque, FALSE) = FALSE
        LEFT JOIN public.tbl_nsf_groupe ng
          ON ng.code = p.nsf_groupe_code
         AND COALESCE(ng.masque, FALSE) = FALSE
        WHERE p.id_ent = %s
          AND COALESCE(p.actif, TRUE) = TRUE
          AND p.id_poste = %s
        LIMIT 1
        """,
        (id_ent, pid),
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
        ORDER BY
            COALESCE(pc.poids_criticite, 0) DESC,
            lower(COALESCE(c.intitule, '')),
            lower(COALESCE(c.code, ''))
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
        "nom_ent": poste.get("nom_ent"),
        "ent_idcc": poste.get("ent_idcc"),
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
    }


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
    fu = _clamp_0_10(freq_usage_0_10)
    im = _clamp_0_10(impact_0_10)
    de = _clamp_0_10(dependance_0_10)
    total = (fu * 2) + (im * 5) + (de * 3)
    if total < 0:
        total = 0
    if total > 100:
        total = 100
    return int(total)


def _pdf_safe_filename_part(v: Any, max_len: int = 120) -> str:
    s = str(v or "").strip()
    s = re.sub(r'[\/:*?"<>|]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ._-")
    if not s:
        return "Competence"
    if len(s) > max_len:
        s = s[:max_len].rsplit(" ", 1)[0].strip()
    return s or "Competence"


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


_ALLOWED_RESPONSABILITES_TAGS = {
    "p",
    "br",
    "ol",
    "ul",
    "li",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "span",
}

_RESPONSABILITES_TAG_ALIASES = {
    "b": "strong",
    "i": "em",
}

_RESPONSABILITES_VOID_TAGS = {"br"}

_RESPONSABILITES_DANGEROUS_TAGS = {
    "script",
    "style",
    "iframe",
    "object",
    "embed",
}


class _SafeResponsabilitesHtmlParser(HTMLParser):
    """
    Nettoyage HTML volontairement limité pour les responsabilités de poste.

    Objectif :
    - accepter le HTML structuré généré par Studio : ol/li/ul, gras, italique, souligné ;
    - supprimer les attributs, styles inline, scripts et balises inutiles ;
    - conserver le rendu lisible dans Insights sans exposer du HTML brut à l’écran.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip_depth = 0

    def _safe_tag(self, tag: str) -> str:
        t = (tag or "").lower().strip()
        return _RESPONSABILITES_TAG_ALIASES.get(t, t)

    def handle_starttag(self, tag, attrs):
        raw_tag = (tag or "").lower().strip()

        if raw_tag in _RESPONSABILITES_DANGEROUS_TAGS:
            self.skip_depth += 1
            return

        if self.skip_depth:
            return

        safe_tag = self._safe_tag(raw_tag)
        if safe_tag not in _ALLOWED_RESPONSABILITES_TAGS:
            return

        # Aucun attribut conservé : pas de style inline, pas de onclick, pas de classe héritée du front Studio.
        if safe_tag in _RESPONSABILITES_VOID_TAGS:
            self.out.append(f"<{safe_tag}>")
        else:
            self.out.append(f"<{safe_tag}>")

    def handle_startendtag(self, tag, attrs):
        raw_tag = (tag or "").lower().strip()

        if raw_tag in _RESPONSABILITES_DANGEROUS_TAGS:
            return

        if self.skip_depth:
            return

        safe_tag = self._safe_tag(raw_tag)
        if safe_tag not in _ALLOWED_RESPONSABILITES_TAGS:
            return

        if safe_tag in _RESPONSABILITES_VOID_TAGS:
            self.out.append(f"<{safe_tag}>")
        else:
            self.out.append(f"<{safe_tag}></{safe_tag}>")

    def handle_endtag(self, tag):
        raw_tag = (tag or "").lower().strip()

        if raw_tag in _RESPONSABILITES_DANGEROUS_TAGS:
            if self.skip_depth > 0:
                self.skip_depth -= 1
            return

        if self.skip_depth:
            return

        safe_tag = self._safe_tag(raw_tag)
        if safe_tag not in _ALLOWED_RESPONSABILITES_TAGS:
            return

        if safe_tag not in _RESPONSABILITES_VOID_TAGS:
            self.out.append(f"</{safe_tag}>")

    def handle_data(self, data):
        if self.skip_depth:
            return

        if data:
            self.out.append(_html.escape(data, quote=False))

    def get_html(self) -> str:
        cleaned = "".join(self.out).strip()

        # Nettoyage léger des wrappers vides générés par copier/coller ou édition partielle.
        cleaned = re.sub(r"<(span|strong|em|u)>\s*</\1>", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s+</(p|li)>", lambda m: f"</{m.group(1)}>", cleaned, flags=re.I)

        return cleaned.strip()


def _looks_like_responsabilites_html(s: str | None) -> bool:
    if not s:
        return False

    return bool(re.search(
        r"</?(?:p|br|ol|ul|li|strong|b|em|i|u|span)\b[^>]*>",
        str(s),
        flags=re.I,
    ))


def _sanitize_responsabilites_html(s: str | None) -> str | None:
    if not s:
        return None

    try:
        parser = _SafeResponsabilitesHtmlParser()
        parser.feed(str(s))
        parser.close()

        cleaned = parser.get_html()
        plain = re.sub(r"<[^>]+>", "", cleaned).replace("\xa0", " ").strip()

        return cleaned if plain else None
    except Exception:
        return None


def _responsabilites_to_html(raw: str | None) -> str | None:
    if raw is None:
        return None

    s = str(raw).strip()
    if not s:
        return None

    # Ancien format : RTF desktop / historique.
    if s.startswith("{\\rtf"):
        return _rtf_to_html_basic(s)

    # Nouveau format Studio : HTML structuré ol/li/ul.
    candidate = s
    unescaped = _html.unescape(s)

    # Cas éventuel où du HTML aurait été stocké échappé en base.
    if _looks_like_responsabilites_html(unescaped) and (
        not _looks_like_responsabilites_html(s)
        or re.search(r"&lt;/?(?:p|br|ol|ul|li|strong|b|em|i|u|span)\b", s, flags=re.I)
    ):
        candidate = unescaped

    if _looks_like_responsabilites_html(candidate):
        cleaned = _sanitize_responsabilites_html(candidate)
        if cleaned:
            return cleaned

    # Texte simple historique : affichage sécurisé.
    return _html.escape(s).replace("\n", "<br>")



class PosteCompetenceItem(BaseModel):
    id_competence: str
    code: str
    intitule: str
    description: Optional[str] = None
    etat: Optional[str] = None
    niveau_requis: Optional[str] = None
    poids_criticite: Optional[float] = None
    freq_usage: Optional[int] = None
    impact_resultat: Optional[int] = None
    dependance: Optional[int] = None
    niveaua: Optional[str] = None
    niveaub: Optional[str] = None
    niveauc: Optional[str] = None
    niveaud: Optional[str] = None

class PosteCertificationItem(BaseModel):
    id_certification: str
    nom_certification: str
    description: Optional[str] = None
    categorie: Optional[str] = None
    niveau_exigence: Optional[str] = None
    duree_validite: Optional[int] = None
    delai_renouvellement: Optional[int] = None
    validite_override: Optional[int] = None
    commentaire: Optional[str] = None


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
    nsf_groupes: List[Dict[str, str]] = []
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None

    competences: List[PosteCompetenceItem] = []
    certifications: List[PosteCertificationItem] = []

        # Paramétrage RH (tbl_fiche_poste_param_rh)
    rh_statut_poste: Optional[str] = None
    rh_date_debut_validite: Optional[str] = None
    rh_date_fin_validite: Optional[str] = None
    rh_nb_titulaires_cible: Optional[int] = None
    rh_criticite_poste: Optional[int] = None
    rh_strategie_pourvoi: Optional[str] = None
    rh_param_rh_source: Optional[str] = None
    rh_param_rh_date_maj: Optional[str] = None
    rh_param_rh_verrouille: Optional[bool] = None
    rh_param_rh_commentaire: Optional[str] = None

class PosteContraintesUpdatePayload(BaseModel):
    niveau_education_minimum: Optional[str] = None
    nsf_groupe_code: Optional[str] = None
    nsf_groupe_obligatoire: Optional[bool] = None
    mobilite: Optional[str] = None
    risque_physique: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None


class PosteParamRhUpdatePayload(BaseModel):
    statut_poste: Optional[str] = None
    date_debut_validite: Optional[str] = None      # "YYYY-MM-DD" ou None
    date_fin_validite: Optional[str] = None        # "YYYY-MM-DD" ou None
    nb_titulaires_cible: Optional[int] = None
    criticite_poste: Optional[int] = None
    strategie_pourvoi: Optional[str] = None
    param_rh_commentaire: Optional[str] = None


class PosteCompetenceUpdatePayload(BaseModel):
    id_competence: str
    niveau_requis: Optional[str] = None
    freq_usage: Optional[int] = 0
    impact_resultat: Optional[int] = 0
    dependance: Optional[int] = 0
    valider_eval: Optional[bool] = True


class PosteCertificationUpdatePayload(BaseModel):
    id_certification: str
    validite_override: Optional[int] = None


# ======================================================
# Routes
# ======================================================
@router.get(
    "/skills/organisation/services/{id_contact}",
    response_model=List[ServiceNode],
)
def get_services_tree(id_contact: str, request: Request):
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
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


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
def get_poste_detail(id_contact: str, id_poste: str, request: Request):
    """
    Détail d'un poste pour le modal.
    On renvoie uniquement les champs nécessaires à l'onglet "Définition".
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

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
                      c.niveaua,
                      c.niveaub,
                      c.niveauc,
                      c.niveaud,
                      fpc.niveau_requis,
                      fpc.poids_criticite,
                      fpc.freq_usage,
                      fpc.impact_resultat,
                      fpc.dependance
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN public.tbl_competence c ON c.id_comp = fpc.id_competence
                    WHERE fpc.id_poste = %s
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
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
                        "freq_usage": rr.get("freq_usage"),
                        "impact_resultat": rr.get("impact_resultat"),
                        "dependance": rr.get("dependance"),
                        "niveaua": rr.get("niveaua"),
                        "niveaub": rr.get("niveaub"),
                        "niveauc": rr.get("niveauc"),
                        "niveaud": rr.get("niveaud"),
                    })

                # --- Certifications requises (tbl_fiche_poste_certification + tbl_certification)
                cur.execute(
                    """
                    SELECT
                      c.id_certification,
                      c.nom_certification,
                      c.description,
                      c.categorie,
                      c.duree_validite,
                      c.delai_renouvellement,
                      fpc.niveau_exigence,
                      fpc.validite_override,
                      fpc.commentaire
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
                        "duree_validite": rr.get("duree_validite"),
                        "delai_renouvellement": rr.get("delai_renouvellement"),
                        "validite_override": rr.get("validite_override"),
                        "commentaire": rr.get("commentaire"),
                    })

                # --- Paramétrage RH : lecture + auto-init si absent
                cur.execute(
                    """
                    SELECT
                      pr.id_poste,
                      pr.statut_poste,
                      pr.date_debut_validite,
                      pr.date_fin_validite,
                      pr.nb_titulaires_cible,
                      pr.criticite_poste,
                      pr.strategie_pourvoi,
                      pr.param_rh_source,
                      pr.param_rh_date_maj,
                      pr.param_rh_verrouille,
                      pr.param_rh_commentaire
                    FROM public.tbl_fiche_poste_param_rh pr
                    WHERE pr.id_poste = %s
                    LIMIT 1
                    """,
                    (id_poste,),
                )
                pr = cur.fetchone()

                if not pr:
                    # init auto avec valeurs par défaut
                    cur.execute(
                        """
                        INSERT INTO public.tbl_fiche_poste_param_rh (id_poste)
                        VALUES (%s)
                        """,
                        (id_poste,),
                    )
                    try:
                        conn.commit()
                    except Exception:
                        pass

                    cur.execute(
                        """
                        SELECT
                          pr.id_poste,
                          pr.statut_poste,
                          pr.date_debut_validite,
                          pr.date_fin_validite,
                          pr.nb_titulaires_cible,
                          pr.criticite_poste,
                          pr.strategie_pourvoi,
                          pr.param_rh_source,
                          pr.param_rh_date_maj,
                          pr.param_rh_verrouille,
                          pr.param_rh_commentaire
                        FROM public.tbl_fiche_poste_param_rh pr
                        WHERE pr.id_poste = %s
                        LIMIT 1
                        """,
                        (id_poste,),
                    )
                    pr = cur.fetchone()

                cur.execute(
                    """
                    SELECT
                      code,
                      titre
                    FROM public.tbl_nsf_groupe
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY lower(COALESCE(titre, '')), code
                    """
                )
                nsf_groupes = [
                    {
                        "code": str(row.get("code") or ""),
                        "titre": str(row.get("titre") or ""),
                    }
                    for row in (cur.fetchall() or [])
                    if row.get("code")
                ]

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
                    nsf_groupes=nsf_groupes,
                    mobilite=r.get("mobilite"),
                    risque_physique=r.get("risque_physique"),
                    perspectives_evolution=r.get("perspectives_evolution"),
                    niveau_contrainte=r.get("niveau_contrainte"),
                    detail_contrainte=r.get("detail_contrainte"),
                    competences=comps,
                    certifications=certs,
                    rh_statut_poste=(pr.get("statut_poste") if pr else None),
                    rh_date_debut_validite=(pr.get("date_debut_validite").isoformat() if pr and pr.get("date_debut_validite") else None),
                    rh_date_fin_validite=(pr.get("date_fin_validite").isoformat() if pr and pr.get("date_fin_validite") else None),
                    rh_nb_titulaires_cible=(pr.get("nb_titulaires_cible") if pr else None),
                    rh_criticite_poste=(pr.get("criticite_poste") if pr else None),
                    rh_strategie_pourvoi=(pr.get("strategie_pourvoi") if pr else None),
                    rh_param_rh_source=(pr.get("param_rh_source") if pr else None),
                    rh_param_rh_date_maj=(pr.get("param_rh_date_maj").isoformat() if pr and pr.get("param_rh_date_maj") else None),
                    rh_param_rh_verrouille=(pr.get("param_rh_verrouille") if pr else None),
                    rh_param_rh_commentaire=(pr.get("param_rh_commentaire") if pr else None),


                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get("/skills/organisation/competences/{id_contact}/{id_comp}/fiche_pdf")
def get_competence_fiche_pdf(id_contact: str, id_comp: str, request: Request):
    cid = (id_comp or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="id_comp manquant.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      c.description,
                      c.domaine,
                      c.niveaua,
                      c.niveaub,
                      c.niveauc,
                      c.niveaud,
                      c.grille_evaluation,
                      dc.titre_court AS domaine_titre_court,
                      dc.titre AS domaine_titre,
                      ent.nom_ent AS nom_ent
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_entreprise ent
                      ON ent.id_ent = %s
                     AND COALESCE(ent.masque, FALSE) = FALSE
                    WHERE c.id_comp = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                      AND (
                        c.id_owner = %s
                        OR EXISTS (
                          SELECT 1
                          FROM public.tbl_fiche_poste_competence fpc
                          JOIN public.tbl_fiche_poste p
                            ON p.id_poste = fpc.id_poste
                           AND p.id_ent = %s
                           AND COALESCE(p.actif, TRUE) = TRUE
                          WHERE fpc.id_competence = c.id_comp
                            AND COALESCE(fpc.masque, FALSE) = FALSE
                          LIMIT 1
                        )
                      )
                    LIMIT 1
                    """,
                    (id_ent, cid, id_ent, id_ent),
                )
                row = cur.fetchone() or {}
                if not row:
                    raise HTTPException(status_code=404, detail="Compétence introuvable.")

                logo_bytes = _fetch_logo_bytes_for_ent(cur, id_ent)
                header_right = (row.get("nom_ent") or "Entreprise").strip()

        skill = {
            "id_comp": row.get("id_comp"),
            "code": (row.get("code") or "").strip(),
            "intitule": (row.get("intitule") or "").strip(),
            "description": row.get("description") or "",
            "niveaua": row.get("niveaua") or "",
            "niveaub": row.get("niveaub") or "",
            "niveauc": row.get("niveauc") or "",
            "niveaud": row.get("niveaud") or "",
            "grille_evaluation": row.get("grille_evaluation"),
            "domaine": row.get("domaine") or "",
            "domaine_titre": (
                (row.get("domaine_titre_court") or "").strip()
                or (row.get("domaine_titre") or "").strip()
            ),
        }

        code_label = skill.get("code") or "Compétence"
        intitule_label = skill.get("intitule") or "Compétence"
        filename = _pdf_latin1_safe(
            f"Fiche compétence {_pdf_safe_filename_part(code_label, 32)} - {_pdf_safe_filename_part(intitule_label, 80)}.pdf"
        )

        pdf_bytes = build_pdf_document(
            build_competence_pdf_story(skill),
            meta={
                "title": _pdf_latin1_safe(f"Fiche compétence - {code_label} - {intitule_label}"),
                "doc_label": _pdf_latin1_safe("Fiche compétence"),
                "footer_left": _pdf_latin1_safe("Novoskill Insights • Fiche compétence"),
                "header_right": _pdf_latin1_safe(header_right),
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 10.5,
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
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF compétence : {e}")


@router.get("/skills/organisation/postes/{id_contact}/{id_poste}/fiche_pdf")
def get_poste_fiche_pdf(id_contact: str, id_poste: str, request: Request):
    pid = (id_poste or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="id_poste manquant.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                poste = _fetch_poste_pdf_payload_for_ent(cur, id_ent, pid)
                dossier = _fetch_poste_ccn_dossier(cur, pid)
                logo_bytes = _fetch_logo_bytes_for_ent(cur, id_ent)
                idcc = (poste.get("ent_idcc") or "").strip()
                referential = _fetch_ccn_referential(cur, idcc) if idcc else None
                header_right = (poste.get("nom_ent") or "Entreprise").strip()

        ref_poste = _pdf_first_non_empty(
            poste.get("code_poste"),
            poste.get("codif_client"),
            poste.get("codif_poste"),
            pid,
        ) or "Poste"
        intitule_poste = _pdf_first_non_empty(poste.get("intitule_poste"), "Poste") or "Poste"

        maj_label = _pdf_format_footer_date(poste.get("poste_date_maj")) if poste.get("poste_date_maj") else ""
        footer_parts = []
        if maj_label:
            footer_parts.append(f"Dernière mise à jour du poste : {maj_label}")
        footer_parts.append("Novoskill Insights")
        footer_parts.append("Fiche de poste complète")

        filename = _pdf_latin1_safe(f"Fiche de poste {ref_poste} - {intitule_poste}.pdf")
        pdf_bytes = build_pdf_document(
            _build_poste_pdf_story({}, poste, dossier, referential),
            meta={
                "title": _pdf_latin1_safe(f"Fiche de poste - {intitule_poste}"),
                "doc_label": _pdf_latin1_safe("Fiche de poste complète"),
                "footer_left": _pdf_latin1_safe(" • ".join(footer_parts) if footer_parts else "Novoskill Insights"),
                "header_right": _pdf_latin1_safe(header_right),
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 10.5,
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
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF poste : {e}")


@router.post(
    "/skills/organisation/poste_contraintes_update/{id_contact}/{id_poste}",
    response_model=PosteDetailResponse,
)
def update_poste_contraintes(id_contact: str, id_poste: str, payload: PosteContraintesUpdatePayload, request: Request):
    """
    Update des contraintes poste depuis Insights.
    Règles : vérification entreprise/contact, champs poste uniquement, date_maj rafraîchie.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (id_ent, id_poste),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                nsf_code = (payload.nsf_groupe_code or "").strip() or None
                if nsf_code:
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_nsf_groupe
                        WHERE code = %s
                          AND COALESCE(masque, FALSE) = FALSE
                        LIMIT 1
                        """,
                        (nsf_code,),
                    )
                    if not cur.fetchone():
                        raise HTTPException(status_code=400, detail="Domaine NSF introuvable ou masqué.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET
                        niveau_education_minimum = %s,
                        nsf_groupe_code = %s,
                        nsf_groupe_obligatoire = %s,
                        mobilite = %s,
                        risque_physique = %s,
                        perspectives_evolution = %s,
                        niveau_contrainte = %s,
                        detail_contrainte = %s,
                        date_maj = now()
                    WHERE id_ent = %s
                      AND id_poste = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (
                        (payload.niveau_education_minimum or "").strip() or None,
                        nsf_code,
                        bool(payload.nsf_groupe_obligatoire),
                        (payload.mobilite or "").strip() or None,
                        (payload.risque_physique or "").strip() or None,
                        (payload.perspectives_evolution or "").strip() or None,
                        (payload.niveau_contrainte or "").strip() or None,
                        (payload.detail_contrainte or "").strip() or None,
                        id_ent,
                        id_poste,
                    ),
                )
                conn.commit()

        return get_poste_detail(id_contact, id_poste, request)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/organisation/poste_competence_update/{id_contact}/{id_poste}",
    response_model=PosteDetailResponse,
)
def update_poste_competence(id_contact: str, id_poste: str, payload: PosteCompetenceUpdatePayload, request: Request):
    """Update de l'évaluation de criticité d'une compétence rattachée au poste."""
    try:
        cid = (payload.id_competence or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_competence manquant.")

        niv = (payload.niveau_requis or "C").strip().upper()
        if niv not in ("A", "B", "C", "D"):
            raise HTTPException(status_code=400, detail="niveau_requis invalide (A/B/C/D).")

        fu = _clamp_0_10(payload.freq_usage or 0)
        im = _clamp_0_10(payload.impact_resultat or 0)
        de = _clamp_0_10(payload.dependance or 0)
        poids = _calc_poids_criticite_100(fu, im, de)
        statut_eval = "valide" if bool(payload.valider_eval) else "proposition"

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    JOIN public.tbl_fiche_poste_competence pc
                      ON pc.id_poste = p.id_poste
                     AND pc.id_competence = %s
                     AND COALESCE(pc.masque, FALSE) = FALSE
                    JOIN public.tbl_competence c
                      ON c.id_comp = pc.id_competence
                     AND c.id_owner = p.id_owner
                     AND COALESCE(c.masque, FALSE) = FALSE
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (cid, id_ent, id_poste),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Compétence rattachée au poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste_competence
                    SET
                      niveau_requis = %s,
                      poids_criticite = %s,
                      freq_usage = %s,
                      impact_resultat = %s,
                      dependance = %s,
                      statut_eval = %s,
                      date_valorisation = NOW(),
                      date_modification = NOW(),
                      masque = FALSE
                    WHERE id_poste = %s
                      AND id_competence = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (niv, poids, fu, im, de, statut_eval, id_poste, cid),
                )
                conn.commit()

        return get_poste_detail(id_contact, id_poste, request)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/organisation/poste_certification_update/{id_contact}/{id_poste}",
    response_model=PosteDetailResponse,
)
def update_poste_certification(id_contact: str, id_poste: str, payload: PosteCertificationUpdatePayload, request: Request):
    """Update de la validité spécifique d'une certification rattachée au poste."""
    try:
        cid = (payload.id_certification or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_certification manquant.")

        validite_override = payload.validite_override
        if validite_override is not None:
            try:
                validite_override = int(validite_override)
            except Exception:
                raise HTTPException(status_code=400, detail="validite_override invalide.")
            if validite_override <= 0:
                raise HTTPException(status_code=400, detail="validite_override doit être > 0.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    JOIN public.tbl_fiche_poste_certification pc
                      ON pc.id_poste = p.id_poste
                     AND pc.id_certification = %s
                    JOIN public.tbl_certification c
                      ON c.id_certification = pc.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (cid, id_ent, id_poste),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Certification rattachée au poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste_certification
                    SET validite_override = %s
                    WHERE id_poste = %s
                      AND id_certification = %s
                    """,
                    (validite_override, id_poste, cid),
                )
                conn.commit()

        return get_poste_detail(id_contact, id_poste, request)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/organisation/poste_param_rh_update/{id_contact}/{id_poste}",
    response_model=PosteDetailResponse,
)
def update_poste_param_rh(id_contact: str, id_poste: str, payload: PosteParamRhUpdatePayload, request: Request):
    """
    Update du paramétrage RH d'un poste (tbl_fiche_poste_param_rh).
    Règles:
    - UPSERT sur id_poste (PK)
    - source forcée = 'insights'
    - date_maj forcée = now()
    - verrouille forcé = TRUE (flag interne desktop, pas un verrou fonctionnel)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                # Sécurité minimum: le poste doit appartenir à l'entreprise du contact
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (id_ent, id_poste),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                # Normalisation légère + defaults
                statut = (payload.statut_poste or "actif").strip().lower()
                strategie = (payload.strategie_pourvoi or "mixte").strip().lower()

                nb_titulaires = int(payload.nb_titulaires_cible) if payload.nb_titulaires_cible is not None else 1
                criticite = int(payload.criticite_poste) if payload.criticite_poste is not None else 2

                d_debut = payload.date_debut_validite if payload.date_debut_validite else None
                d_fin = payload.date_fin_validite if payload.date_fin_validite else None

                commentaire = payload.param_rh_commentaire
                if commentaire is not None:
                    commentaire = commentaire.strip()
                    if commentaire == "":
                        commentaire = None

                # UPSERT (source/date/verrouille forcés)
                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste_param_rh (
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
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s,
                        'insights',
                        now(),
                        TRUE,
                        %s
                    )
                    ON CONFLICT (id_poste) DO UPDATE SET
                        statut_poste = EXCLUDED.statut_poste,
                        date_debut_validite = EXCLUDED.date_debut_validite,
                        date_fin_validite = EXCLUDED.date_fin_validite,
                        nb_titulaires_cible = EXCLUDED.nb_titulaires_cible,
                        criticite_poste = EXCLUDED.criticite_poste,
                        strategie_pourvoi = EXCLUDED.strategie_pourvoi,
                        param_rh_source = 'insights',
                        param_rh_date_maj = now(),
                        param_rh_verrouille = TRUE,
                        param_rh_commentaire = EXCLUDED.param_rh_commentaire
                    """,
                    (
                        id_poste,
                        statut,
                        d_debut,
                        d_fin,
                        nb_titulaires,
                        criticite,
                        strategie,
                        commentaire,
                    ),
                )

                conn.commit()

        # On renvoie le détail complet rafraîchi (comme au chargement modal)
        return get_poste_detail(id_contact, id_poste, request)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/organisation/postes/{id_contact}/{id_service}",
    response_model=PostesResponse,
)
def get_postes_for_service(id_contact: str, id_service: str, request: Request):
    """
    Renvoie les postes (fiches de poste) rattachés au service sélectionné.
    - Si id_service = "__NON_LIE__", renvoie les postes sans service ou service inexistant/archivé.
    - Pas d'inclusion des sous-services.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


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
