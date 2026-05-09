from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional, Any
from psycopg.rows import dict_row
from io import BytesIO
import uuid
import json
import re
import unicodedata
import html

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.styles import ParagraphStyle

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import learn_require_user, learn_fetch_profile
from app.routers.skills_portal_pdf_common import build_pdf_document, build_pdf_styles


router = APIRouter()


# ======================================================
# Helpers Learn
# ======================================================

def _learn_require_profile(cur, u: dict, id_effectif: str) -> dict:
    eid = (id_effectif or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="id_effectif manquant.")

    profile = learn_fetch_profile(
        cur,
        id_effectif=eid,
        email=(u.get("email") or ""),
        is_super_admin=bool(u.get("is_super_admin")),
    )

    oid = (profile.get("id_owner") or "").strip()
    if not oid:
        raise HTTPException(status_code=403, detail="Profil Learn sans owner.")

    role = (profile.get("role_code") or "user").strip().lower()
    if role not in ("admin", "supervisor", "user"):
        role = "user"

    profile["role_code"] = role
    return profile


def _role_rank(role_code: str) -> int:
    c = (role_code or "").strip().lower()
    if c == "admin":
        return 3
    if c == "supervisor":
        return 2
    return 1


def _learn_require_min_role(profile: dict, min_role: str) -> None:
    if _role_rank(profile.get("role_code")) < _role_rank(min_role):
        raise HTTPException(status_code=403, detail="Accès refusé : droits insuffisants.")


def _json_list(value: Any) -> list:
    if value is None:
        return []

    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x or "").strip()]

    if isinstance(value, tuple):
        return [str(x).strip() for x in value if str(x or "").strip()]

    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []

        try:
            js = json.loads(s)
            if isinstance(js, list):
                return [str(x).strip() for x in js if str(x or "").strip()]
        except Exception:
            return []

    return []


def _jsonb_param(value: Any) -> str:
    arr = _json_list(value)
    return json.dumps(arr, ensure_ascii=False)


def _clean_text(value: Any, max_len: int = 20000) -> str:
    txt = str(value or "").replace("\x00", " ").strip()
    txt = re.sub(r"\r\n?", "\n", txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    if len(txt) > max_len:
        txt = txt[:max_len].rsplit(" ", 1)[0].strip()
    return txt


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None

    s = str(value).replace(",", ".").strip()
    if not s:
        return None

    try:
        return float(s)
    except Exception:
        return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None

    s = str(value).strip()
    if not s:
        return None

    try:
        return int(float(s.replace(",", ".")))
    except Exception:
        return None


def _next_form_code(cur, oid: str) -> str:
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"learn_form_code:{oid}:FC",))

    cur.execute(
        """
        SELECT COALESCE(
          MAX((regexp_match(code, '^FC([0-9]{5})$'))[1]::int),
          0
        ) AS max_n
        FROM public.tbl_fiche_formation
        WHERE id_owner = %s
          AND code ~ '^FC[0-9]{5}$'
        """,
        (oid,),
    )

    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1

    if nxt > 99999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (FC99999).")

    return f"FC{nxt:05d}"


def _formation_exists_owner(cur, oid: str, id_form: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_fiche_formation
        WHERE id_owner = %s
          AND id_form = %s
        LIMIT 1
        """,
        (oid, id_form),
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


def _pdf_safe_filename_part(v: Any, max_len: int = 120) -> str:
    s = str(v or "").strip()
    if not s:
        return "document"

    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", s)
    s = re.sub(r"\s+", " ", s).strip(" ._-")

    if not s:
        s = "document"

    if len(s) > max_len:
        s = s[:max_len].strip(" ._-")

    return s or "document"


def _pdf_latin1_safe(v: Any) -> str:
    return str(v or "").encode("latin-1", "replace").decode("latin-1")


def _resolve_labels(cur, table: str, id_col: str, ids: list) -> list:
    clean_ids = [str(x).strip() for x in ids if str(x or "").strip()]
    if not clean_ids:
        return []

    if table not in ("tbl_mod_form", "tbl_met_peda", "tbl_met_eval"):
        return []

    cur.execute(
        f"""
        SELECT
          {id_col} AS id,
          titre,
          titre_court,
          description,
          ordre_affichage
        FROM public.{table}
        WHERE {id_col} = ANY(%s)
          AND COALESCE(masque, FALSE) = FALSE
        ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre, titre_court, {id_col}))
        """,
        (clean_ids,),
    )

    rows = cur.fetchall() or []
    by_id = {str(r.get("id") or "").strip(): r for r in rows}

    return [
        by_id[x]
        for x in clean_ids
        if x in by_id
    ]


def _resolve_competences(cur, oid: str, ids: list) -> list:
    clean_ids = [str(x).strip() for x in ids if str(x or "").strip()]
    if not clean_ids:
        return []

    cur.execute(
        """
        SELECT
          c.id_comp,
          c.code,
          c.intitule,
          c.domaine,
          dc.titre_court AS domaine_titre_court,
          dc.titre AS domaine_titre,
          dc.couleur AS domaine_couleur,
          c.etat
        FROM public.tbl_competence c
        LEFT JOIN public.tbl_domaine_competence dc
          ON dc.id_domaine_competence = c.domaine
         AND COALESCE(dc.masque, FALSE) = FALSE
        WHERE c.id_owner = %s
          AND c.id_comp = ANY(%s)
          AND COALESCE(c.masque, FALSE) = FALSE
        ORDER BY lower(COALESCE(c.code, '')), lower(COALESCE(c.intitule, ''))
        """,
        (oid, clean_ids),
    )

    rows = cur.fetchall() or []
    by_id = {str(r.get("id_comp") or "").strip(): r for r in rows}

    return [
        by_id[x]
        for x in clean_ids
        if x in by_id
    ]

def _sync_formation_prerequis(cur, oid: str, id_form: str, prerequis: Optional[list]) -> None:
    """
    Synchronise les prérequis évaluables d'une fiche formation.

    Principe Novoskill :
    - pas de suppression physique ;
    - archivage logique des anciennes lignes ;
    - réactivation/update si id_prerequis fourni ;
    - création si nouveau prérequis.
    """
    items = prerequis or []

    cur.execute(
        """
        UPDATE public.tbl_fiche_formation_prerequis
        SET archive = TRUE,
            date_modification = NOW()
        WHERE id_owner = %s
          AND id_form = %s
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (oid, id_form),
    )

    ordre = 1

    for raw in items:
        if raw is None:
            continue

        if isinstance(raw, dict):
            item = raw
        else:
            item = raw.dict()

        titre = _clean_text(item.get("titre"), 800)
        if not titre:
            continue

        r1 = _clean_text(item.get("r1") or "Je ne maîtrise pas", 300)
        r2 = _clean_text(item.get("r2") or "J’ai besoin d’assistance", 300)
        r3 = _clean_text(item.get("r3") or "Je maîtrise", 300)

        try:
            item_ordre = int(item.get("ordre_affichage") or ordre)
        except Exception:
            item_ordre = ordre

        pid = (item.get("id_prerequis") or "").strip()

        if pid:
            cur.execute(
                """
                UPDATE public.tbl_fiche_formation_prerequis
                SET titre = %s,
                    r1 = %s,
                    r2 = %s,
                    r3 = %s,
                    ordre_affichage = %s,
                    archive = FALSE,
                    date_modification = NOW()
                WHERE id_owner = %s
                  AND id_form = %s
                  AND id_prerequis = %s
                """,
                (titre, r1, r2, r3, item_ordre, oid, id_form, pid),
            )

            if cur.rowcount > 0:
                ordre += 1
                continue

        cur.execute(
            """
            INSERT INTO public.tbl_fiche_formation_prerequis
              (
                id_prerequis,
                id_owner,
                id_form,
                titre,
                r1,
                r2,
                r3,
                ordre_affichage,
                archive,
                date_creation,
                date_modification
              )
            VALUES
              (
                %s, %s, %s,
                %s, %s, %s, %s,
                %s,
                FALSE,
                NOW(),
                NOW()
              )
            """,
            (
                str(uuid.uuid4()),
                oid,
                id_form,
                titre,
                r1,
                r2,
                r3,
                item_ordre,
            ),
        )

        ordre += 1

def _fetch_form_detail(cur, oid: str, id_form: str) -> dict:
    cur.execute(
        """
        SELECT
          ff.id_form,
          ff.code,
          ff.titre,
          ff.fournisseur_formation,
          fo.nom AS fournisseur_nom,
          ff.type_formation,
          ff.obs_type_form,
          ff.duree,
          ff.objectifs,
          ff.public_cible,
          ff.presentation,
          ff.modalites,
          ff.methode_peda,
          ff.methode_eval,
          ff.competences_stagiaires,
          ff.competences_formateurs,
          ff.attestation_specifique,
          ff.domaine,
          df.titre_court AS domaine_titre_court,
          df.titre AS domaine_titre,
          ff.tarif_mini,
          ff.etat,
          COALESCE(ff.masque, FALSE) AS masque,
          COALESCE(ff.archive, FALSE) AS archive,
          ff.chemin_sharepoint,
          ff.date_creation,
          ff.date_modification
        FROM public.tbl_fiche_formation ff
        LEFT JOIN public.tbl_fournisseur fo
          ON fo.id_owner = ff.id_owner
         AND fo.id_fourn = ff.fournisseur_formation
         AND COALESCE(fo.archive, FALSE) = FALSE
         AND COALESCE(fo.masque, FALSE) = FALSE
        LEFT JOIN public.tbl_domaine_formation df
          ON df.id_domaine_formation = ff.domaine
         AND COALESCE(df.masque, FALSE) = FALSE
        WHERE ff.id_owner = %s
          AND ff.id_form = %s
        LIMIT 1
        """,
        (oid, id_form),
    )

    form = cur.fetchone()
    if not form:
        raise HTTPException(status_code=404, detail="Formation introuvable.")

    modalites_ids = _json_list(form.get("modalites"))
    methode_peda_ids = _json_list(form.get("methode_peda"))
    methode_eval_ids = _json_list(form.get("methode_eval"))
    comp_stag_ids = _json_list(form.get("competences_stagiaires"))
    comp_form_ids = _json_list(form.get("competences_formateurs"))

    form["modalites_ids"] = modalites_ids
    form["methode_peda_ids"] = methode_peda_ids
    form["methode_eval_ids"] = methode_eval_ids
    form["competences_stagiaires_ids"] = comp_stag_ids
    form["competences_formateurs_ids"] = comp_form_ids

    form["modalites_items"] = _resolve_labels(cur, "tbl_mod_form", "id_mod_form", modalites_ids)
    form["methode_peda_items"] = _resolve_labels(cur, "tbl_met_peda", "id_met_peda", methode_peda_ids)
    form["methode_eval_items"] = _resolve_labels(cur, "tbl_met_eval", "id_met_eval", methode_eval_ids)
    form["competences_stagiaires_items"] = _resolve_competences(cur, oid, comp_stag_ids)
    form["competences_formateurs_items"] = _resolve_competences(cur, oid, comp_form_ids)

    cur.execute(
        """
        SELECT
          id_prerequis,
          titre,
          r1,
          r2,
          r3,
          ordre_affichage
        FROM public.tbl_fiche_formation_prerequis
        WHERE id_owner = %s
          AND id_form = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY COALESCE(ordre_affichage, 999999), titre
        """,
        (oid, id_form),
    )
    form["prerequis"] = cur.fetchall() or []

    cur.execute(
        """
        SELECT
          l.id_ligne_contenu,
          l.titre_sequence,
          l.objectif,
          l.contenu,
          l.id_competence,
          c.code AS competence_code,
          c.intitule AS competence_intitule,
          l.position
        FROM public.tbl_contenu_ligne l
        LEFT JOIN public.tbl_competence c
          ON c.id_owner = l.id_owner
         AND c.id_comp = l.id_competence
         AND COALESCE(c.masque, FALSE) = FALSE
        WHERE l.id_owner = %s
          AND l.id_form = %s
          AND COALESCE(l.archive, FALSE) = FALSE
        ORDER BY COALESCE(l.position, 999999), l.titre_sequence
        """,
        (oid, id_form),
    )
    form["contenus"] = cur.fetchall() or []

    cur.execute(
        """
        SELECT
          p.id_plan_peda,
          p.codification,
          p.titre,
          p.commentaire,
          p.modalite_generale,
          p.chemin_sharepoint,
          p.date_creation,
          COALESCE(
            SUM(
              CASE
                WHEN trim(COALESCE(b.duree::text, '')) ~ '^[0-9]+([\\.,][0-9]+)?$'
                THEN replace(trim(b.duree::text), ',', '.')::numeric
                ELSE 0
              END
            ),
            0
          ) AS duree_totale,
          COUNT(DISTINCT b.id_bloc_peda) AS nb_blocs
        FROM public.tbl_plan_pedagogique p
        LEFT JOIN public.tbl_bloc_pedagogique b
          ON b.id_owner = p.id_owner
         AND b.id_plan_peda = p.id_plan_peda
         AND COALESCE(b.archive, FALSE) = FALSE
        WHERE p.id_owner = %s
          AND p.id_form = %s
          AND COALESCE(p.archive, FALSE) = FALSE
        GROUP BY
          p.id_plan_peda,
          p.codification,
          p.titre,
          p.commentaire,
          p.modalite_generale,
          p.chemin_sharepoint,
          p.date_creation
        ORDER BY lower(COALESCE(p.codification, '')), lower(COALESCE(p.titre, ''))
        """,
        (oid, id_form),
    )
    plans = cur.fetchall() or []

    for p in plans:
        cur.execute(
            """
            SELECT
              b.id_bloc_peda,
              b.titre,
              b.objectif,
              b.duree,
              b.modalite_intervention,
              b.observations,
              b.position,
              COUNT(s.id_sequence_bloc) AS nb_sequences
            FROM public.tbl_bloc_pedagogique b
            LEFT JOIN public.tbl_sequence_bloc_pedagogique s
              ON s.id_owner = b.id_owner
             AND s.id_bloc_peda = b.id_bloc_peda
             AND COALESCE(s.archive, FALSE) = FALSE
            WHERE b.id_owner = %s
              AND b.id_plan_peda = %s
              AND COALESCE(b.archive, FALSE) = FALSE
            GROUP BY
              b.id_bloc_peda,
              b.titre,
              b.objectif,
              b.duree,
              b.modalite_intervention,
              b.observations,
              b.position
            ORDER BY COALESCE(b.position, 999999), lower(COALESCE(b.titre, ''))
            """,
            (oid, p.get("id_plan_peda")),
        )
        p["blocs"] = cur.fetchall() or []

    form["plans"] = plans
    return form


# ======================================================
# Models
# ======================================================

class FormationPrerequisPayload(BaseModel):
    id_prerequis: Optional[str] = None
    titre: Optional[str] = None
    r1: Optional[str] = None
    r2: Optional[str] = None
    r3: Optional[str] = None
    ordre_affichage: Optional[int] = None


class FormationPayload(BaseModel):
    titre: str
    fournisseur_formation: Optional[str] = None
    type_formation: Optional[str] = None
    obs_type_form: Optional[str] = None
    duree: Optional[Any] = None
    objectifs: Optional[str] = None
    public_cible: Optional[str] = None
    presentation: Optional[str] = None
    modalites: Optional[list] = None
    methode_peda: Optional[list] = None
    methode_eval: Optional[list] = None
    competences_stagiaires: Optional[list] = None
    competences_formateurs: Optional[list] = None
    prerequis: Optional[list[FormationPrerequisPayload]] = None
    attestation_specifique: Optional[str] = None
    domaine: Optional[str] = None
    tarif_mini: Optional[Any] = None
    etat: Optional[str] = None


class FormationUpdatePayload(BaseModel):
    titre: Optional[str] = None
    fournisseur_formation: Optional[str] = None
    type_formation: Optional[str] = None
    obs_type_form: Optional[str] = None
    duree: Optional[Any] = None
    objectifs: Optional[str] = None
    public_cible: Optional[str] = None
    presentation: Optional[str] = None
    modalites: Optional[list] = None
    methode_peda: Optional[list] = None
    methode_eval: Optional[list] = None
    competences_stagiaires: Optional[list] = None
    competences_formateurs: Optional[list] = None
    prerequis: Optional[list[FormationPrerequisPayload]] = None
    attestation_specifique: Optional[str] = None
    domaine: Optional[str] = None
    tarif_mini: Optional[Any] = None
    etat: Optional[str] = None


# ======================================================
# Référentiels
# ======================================================

@router.get("/learn/formations/{id_effectif}/context")
def learn_formations_context(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            profile = _learn_require_profile(cur, u, id_effectif)

    return {
        "id_owner": profile.get("id_owner"),
        "id_effectif": profile.get("id_effectif"),
        "role_code": profile.get("role_code"),
        "role_label": profile.get("role_label"),
        "can_edit": _role_rank(profile.get("role_code")) >= 2,
    }


@router.get("/learn/formations/{id_effectif}/referentiels")
def learn_formations_referentiels(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                cur.execute(
                    """
                    SELECT
                      id_domaine_formation,
                      titre,
                      titre_court,
                      description,
                      ordre_affichage
                    FROM public.tbl_domaine_formation
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre, titre_court, id_domaine_formation))
                    """
                )
                domaines = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_fourn,
                      code,
                      nom
                    FROM public.tbl_fournisseur
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(masque, FALSE) = FALSE
                      AND COALESCE(formation, FALSE) = TRUE
                    ORDER BY lower(COALESCE(nom, code, id_fourn))
                    """,
                    (oid,),
                )
                fournisseurs = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_mod_form,
                      titre,
                      titre_court,
                      description,
                      ordre_affichage
                    FROM public.tbl_mod_form
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre, titre_court, id_mod_form))
                    """
                )
                modalites = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_met_peda,
                      titre,
                      titre_court,
                      description,
                      ordre_affichage
                    FROM public.tbl_met_peda
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre, titre_court, id_met_peda))
                    """
                )
                methodes_peda = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      id_met_eval,
                      titre,
                      titre_court,
                      description,
                      ordre_affichage
                    FROM public.tbl_met_eval
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre, titre_court, id_met_eval))
                    """
                )
                methodes_eval = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      c.domaine,
                      dc.titre_court AS domaine_titre_court,
                      dc.titre AS domaine_titre,
                      dc.couleur AS domaine_couleur,
                      c.etat
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE c.id_owner = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    ORDER BY lower(COALESCE(c.code, '')), lower(COALESCE(c.intitule, ''))
                    """,
                    (oid,),
                )
                competences = cur.fetchall() or []

        return {
            "domaines": domaines,
            "fournisseurs": fournisseurs,
            "modalites": modalites,
            "methodes_peda": methodes_peda,
            "methodes_eval": methodes_eval,
            "competences": competences,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations/referentiels error: {e}")


# ======================================================
# Catalogue formations
# ======================================================

@router.get("/learn/formations/{id_effectif}")
def learn_formations_list(
    id_effectif: str,
    request: Request,
    q: str = "",
    show: str = "active",
    domaine: str = "",
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        qq = (q or "").strip()
        sh = (show or "active").strip().lower()
        dom = (domaine or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                where = ["ff.id_owner = %s"]
                params = [oid]

                if sh == "active":
                    where.append("COALESCE(ff.archive, FALSE) = FALSE")
                    where.append("COALESCE(ff.masque, FALSE) = FALSE")
                    where.append("COALESCE(ff.etat, 'active') = 'active'")
                elif sh == "validation":
                    where.append("COALESCE(ff.archive, FALSE) = FALSE")
                    where.append("COALESCE(ff.masque, FALSE) = FALSE")
                    where.append("COALESCE(ff.etat, '') = 'à valider'")
                elif sh == "archived":
                    where.append("(COALESCE(ff.archive, FALSE) = TRUE OR COALESCE(ff.masque, FALSE) = TRUE)")
                else:
                    where.append("COALESCE(ff.archive, FALSE) = FALSE")
                    where.append("COALESCE(ff.masque, FALSE) = FALSE")

                if dom:
                    where.append("ff.domaine = %s")
                    params.append(dom)

                if qq:
                    like = f"%{qq}%"
                    where.append(
                        """
                        (
                          ff.code ILIKE %s
                          OR ff.titre ILIKE %s
                          OR COALESCE(ff.presentation, '') ILIKE %s
                          OR COALESCE(ff.objectifs, '') ILIKE %s
                          OR COALESCE(df.titre, '') ILIKE %s
                          OR COALESCE(df.titre_court, '') ILIKE %s
                          OR COALESCE(fo.nom, '') ILIKE %s
                        )
                        """
                    )
                    params.extend([like, like, like, like, like, like, like])

                cur.execute(
                    f"""
                    SELECT
                      ff.id_form,
                      ff.code,
                      ff.titre,
                      ff.type_formation,
                      ff.duree,
                      ff.domaine,
                      df.titre_court AS domaine_titre_court,
                      df.titre AS domaine_titre,
                      ff.fournisseur_formation,
                      fo.nom AS fournisseur_nom,
                      ff.tarif_mini,
                      ff.etat,
                      COALESCE(ff.masque, FALSE) AS masque,
                      COALESCE(ff.archive, FALSE) AS archive,
                      COUNT(DISTINCT p.id_plan_peda) AS nb_plans
                    FROM public.tbl_fiche_formation ff
                    LEFT JOIN public.tbl_domaine_formation df
                      ON df.id_domaine_formation = ff.domaine
                     AND COALESCE(df.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_fournisseur fo
                      ON fo.id_owner = ff.id_owner
                     AND fo.id_fourn = ff.fournisseur_formation
                     AND COALESCE(fo.archive, FALSE) = FALSE
                     AND COALESCE(fo.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_plan_pedagogique p
                      ON p.id_owner = ff.id_owner
                     AND p.id_form = ff.id_form
                     AND COALESCE(p.archive, FALSE) = FALSE
                    WHERE {" AND ".join(where)}
                    GROUP BY
                      ff.id_form,
                      ff.code,
                      ff.titre,
                      ff.type_formation,
                      ff.duree,
                      ff.domaine,
                      df.titre_court,
                      df.titre,
                      ff.fournisseur_formation,
                      fo.nom,
                      ff.tarif_mini,
                      ff.etat,
                      ff.masque,
                      ff.archive
                    ORDER BY
                      lower(COALESCE(ff.code, '')),
                      lower(COALESCE(ff.titre, ''))
                    """,
                    tuple(params),
                )

                rows = cur.fetchall() or []

        return {"items": rows}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations list error: {e}")


@router.get("/learn/formations/{id_effectif}/{id_form}")
def learn_formation_detail(id_effectif: str, id_form: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()
                return _fetch_form_detail(cur, oid, fid)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations detail error: {e}")


@router.post("/learn/formations/{id_effectif}")
def learn_formation_create(id_effectif: str, payload: FormationPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        titre = (payload.titre or "").strip()
        if not titre:
            raise HTTPException(status_code=400, detail="Titre obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                fid = str(uuid.uuid4())
                code = _next_form_code(cur, oid)

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_formation
                      (
                        id_form,
                        id_owner,
                        code,
                        titre,
                        fournisseur_formation,
                        type_formation,
                        obs_type_form,
                        duree,
                        objectifs,
                        public_cible,
                        presentation,
                        modalites,
                        methode_peda,
                        methode_eval,
                        competences_stagiaires,
                        competences_formateurs,
                        attestation_specifique,
                        domaine,
                        tarif_mini,
                        etat,
                        masque,
                        archive,
                        date_creation,
                        date_modification
                      )
                    VALUES
                      (
                        %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s::jsonb, %s::jsonb,
                        %s::jsonb, %s::jsonb,
                        %s, %s, %s, %s,
                        FALSE, FALSE, NOW(), NOW()
                      )
                    """,
                    (
                        fid,
                        oid,
                        code,
                        titre,
                        (payload.fournisseur_formation or None),
                        (payload.type_formation or None),
                        _clean_text(payload.obs_type_form),
                        _safe_int(payload.duree),
                        _clean_text(payload.objectifs),
                        _clean_text(payload.public_cible),
                        _clean_text(payload.presentation),
                        _jsonb_param(payload.modalites),
                        _jsonb_param(payload.methode_peda),
                        _jsonb_param(payload.methode_eval),
                        _jsonb_param(payload.competences_stagiaires),
                        _jsonb_param(payload.competences_formateurs),
                        _clean_text(payload.attestation_specifique),
                        (payload.domaine or None),
                        _safe_float(payload.tarif_mini),
                        (payload.etat or "à valider"),
                    ),
                )

                _sync_formation_prerequis(cur, oid, fid, payload.prerequis)

                conn.commit()

        return {"id_form": fid, "code": code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations create error: {e}")


@router.post("/learn/formations/{id_effectif}/{id_form}")
def learn_formation_update(id_effectif: str, id_form: str, payload: FormationUpdatePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                if not _formation_exists_owner(cur, oid, fid):
                    raise HTTPException(status_code=404, detail="Formation introuvable.")

                cols = []
                vals = []

                if "titre" in patch_fields:
                    titre = (payload.titre or "").strip()
                    if not titre:
                        raise HTTPException(status_code=400, detail="Titre obligatoire.")
                    cols.append("titre = %s")
                    vals.append(titre)

                if "fournisseur_formation" in patch_fields:
                    cols.append("fournisseur_formation = %s")
                    vals.append(payload.fournisseur_formation or None)

                if "type_formation" in patch_fields:
                    cols.append("type_formation = %s")
                    vals.append(payload.type_formation or None)

                if "obs_type_form" in patch_fields:
                    cols.append("obs_type_form = %s")
                    vals.append(_clean_text(payload.obs_type_form))

                if "duree" in patch_fields:
                    cols.append("duree = %s")
                    vals.append(_safe_int(payload.duree))

                if "objectifs" in patch_fields:
                    cols.append("objectifs = %s")
                    vals.append(_clean_text(payload.objectifs))

                if "public_cible" in patch_fields:
                    cols.append("public_cible = %s")
                    vals.append(_clean_text(payload.public_cible))

                if "presentation" in patch_fields:
                    cols.append("presentation = %s")
                    vals.append(_clean_text(payload.presentation))

                if "modalites" in patch_fields:
                    cols.append("modalites = %s::jsonb")
                    vals.append(_jsonb_param(payload.modalites))

                if "methode_peda" in patch_fields:
                    cols.append("methode_peda = %s::jsonb")
                    vals.append(_jsonb_param(payload.methode_peda))

                if "methode_eval" in patch_fields:
                    cols.append("methode_eval = %s::jsonb")
                    vals.append(_jsonb_param(payload.methode_eval))

                if "competences_stagiaires" in patch_fields:
                    cols.append("competences_stagiaires = %s::jsonb")
                    vals.append(_jsonb_param(payload.competences_stagiaires))

                if "competences_formateurs" in patch_fields:
                    cols.append("competences_formateurs = %s::jsonb")
                    vals.append(_jsonb_param(payload.competences_formateurs))

                if "attestation_specifique" in patch_fields:
                    cols.append("attestation_specifique = %s")
                    vals.append(_clean_text(payload.attestation_specifique))

                if "domaine" in patch_fields:
                    cols.append("domaine = %s")
                    vals.append(payload.domaine or None)

                if "tarif_mini" in patch_fields:
                    cols.append("tarif_mini = %s")
                    vals.append(_safe_float(payload.tarif_mini))

                if "etat" in patch_fields:
                    cols.append("etat = %s")
                    vals.append((payload.etat or "à valider").strip())

                if "prerequis" in patch_fields:
                    _sync_formation_prerequis(cur, oid, fid, payload.prerequis)

                if cols:
                    cols.append("date_modification = NOW()")
                    vals.extend([fid, oid])

                    cur.execute(
                        f"""
                        UPDATE public.tbl_fiche_formation
                        SET {", ".join(cols)}
                        WHERE id_form = %s
                          AND id_owner = %s
                        """,
                        tuple(vals),
                    )

                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations update error: {e}")


@router.post("/learn/formations/{id_effectif}/{id_form}/archive")
def learn_formation_archive(id_effectif: str, id_form: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_formation
                    SET archive = TRUE,
                        masque = TRUE,
                        date_modification = NOW()
                    WHERE id_owner = %s
                      AND id_form = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid, fid),
                )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations archive error: {e}")


# ======================================================
# PDF socle fiche formation
# ======================================================

def _p(txt: Any, style):
    return Paragraph(html.escape(str(txt or "").replace("\n", "<br/>")), style)


def _bullet_list(items: list, style) -> list:
    out = []
    for it in items:
        if isinstance(it, dict):
            label = it.get("titre") or it.get("intitule") or it.get("nom") or it.get("code") or ""
        else:
            label = str(it or "")
        label = str(label or "").strip()
        if label:
            out.append(_p(f"• {label}", style))
    if not out:
        out.append(_p("—", style))
    return out


def _build_formation_pdf_story(form: dict) -> list:
    styles = build_pdf_styles()

    title_style = ParagraphStyle(
        "LearnFormTitle",
        parent=styles["title"],
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=19,
        textColor=colors.HexColor("#1f2937"),
        spaceAfter=4,
    )

    section_style = ParagraphStyle(
        "LearnFormSection",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11.2,
        leading=13,
        textColor=colors.HexColor("#c2410c"),
        spaceAfter=5,
        spaceBefore=8,
    )

    body_style = ParagraphStyle(
        "LearnFormBody",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=8.8,
        leading=11.2,
        textColor=colors.HexColor("#1f2937"),
        spaceAfter=2,
    )

    small_style = ParagraphStyle(
        "LearnFormSmall",
        parent=styles["small"],
        fontName="Helvetica",
        fontSize=7.8,
        leading=9.4,
        textColor=colors.HexColor("#6b7280"),
    )

    story = []

    code = form.get("code") or "—"
    titre = form.get("titre") or "Formation"
    domaine = form.get("domaine_titre_court") or form.get("domaine_titre") or "—"
    fournisseur = form.get("fournisseur_nom") or "—"

    story.append(_p("Fiche descriptive de formation", title_style))
    story.append(_p(f"{code} • {titre}", styles["subtitle"]))
    story.append(Spacer(1, 4 * mm))

    meta = [
        [_p("Domaine", small_style), _p(domaine, body_style), _p("Durée", small_style), _p(f"{form.get('duree') or '—'} h", body_style)],
        [_p("Fournisseur", small_style), _p(fournisseur, body_style), _p("Tarif mini", small_style), _p(f"{form.get('tarif_mini') or '—'} € HT", body_style)],
        [_p("Type", small_style), _p(form.get("type_formation") or "—", body_style), _p("État", small_style), _p(form.get("etat") or "—", body_style)],
        [_p("Précision type", small_style), _p(form.get("obs_type_form") or "—", body_style), _p("", small_style), _p("", body_style)],
    ]

    tbl = Table(meta, colWidths=[28 * mm, 62 * mm, 28 * mm, 62 * mm])
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#e5e7eb")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)

    story.append(_p("Présentation", section_style))
    story.append(_p(form.get("presentation") or "—", body_style))

    story.append(_p("Public cible", section_style))
    story.extend(_bullet_list([x for x in str(form.get("public_cible") or "").split("\n") if x.strip()], body_style))

    story.append(_p("Objectifs de la formation", section_style))
    story.append(_p(form.get("objectifs") or "—", body_style))

    story.append(PageBreak())

    story.append(_p("Modalités de formation", title_style))
    story.append(Spacer(1, 4 * mm))

    story.append(_p("Prérequis d’entrée en formation", section_style))
    prereq = form.get("prerequis") or []
    story.extend(_bullet_list([p.get("titre") for p in prereq], body_style))

    story.append(_p("Objectifs pédagogiques / compétences visées", section_style))
    story.extend(_bullet_list(form.get("competences_stagiaires_items") or [], body_style))

    story.append(_p("Modalités possibles", section_style))
    story.extend(_bullet_list(form.get("modalites_items") or [], body_style))

    story.append(_p("Méthodes pédagogiques", section_style))
    story.extend(_bullet_list(form.get("methode_peda_items") or [], body_style))

    story.append(_p("Méthodes d’évaluation des acquis", section_style))
    story.extend(_bullet_list(form.get("methode_eval_items") or [], body_style))

    story.append(_p("Compétences techniques du formateur", section_style))
    comp_form = form.get("competences_formateurs_items") or []
    rows = [[_p("Code", small_style), _p("Désignation", small_style)]]
    for c in comp_form:
        rows.append([_p(c.get("code") or "—", body_style), _p(c.get("intitule") or "—", body_style)])

    table = Table(rows, colWidths=[30 * mm, 145 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#fff7ed")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(table)

    story.append(PageBreak())

    story.append(_p("Contenu de la formation", title_style))
    story.append(Spacer(1, 4 * mm))

    contenus = form.get("contenus") or []
    if not contenus:
        story.append(_p("Aucun contenu détaillé n’est encore rattaché à cette formation.", body_style))
    else:
        for l in contenus:
            story.append(_p(l.get("titre_sequence") or "Séquence", section_style))
            if l.get("objectif"):
                story.append(_p(f"Objectif : {l.get('objectif')}", body_style))
            story.append(_p(l.get("contenu") or "—", body_style))

    story.append(PageBreak())

    story.append(_p("Plans pédagogiques", title_style))
    story.append(Spacer(1, 4 * mm))

    plans = form.get("plans") or []
    if not plans:
        story.append(_p("Aucun plan pédagogique n’est encore rattaché à cette formation.", body_style))
    else:
        for p in plans:
            story.append(_p(f"{p.get('codification') or '—'} • {p.get('titre') or 'Plan pédagogique'}", section_style))
            story.append(_p(f"Modalité générale : {p.get('modalite_generale') or '—'}", body_style))
            story.append(_p(f"Durée cumulée : {p.get('duree_totale') or 0} h • {p.get('nb_blocs') or 0} bloc(s)", body_style))

            for b in p.get("blocs") or []:
                story.append(_p(f"• {b.get('titre') or 'Bloc'} — {b.get('duree') or '—'} h", body_style))

    return story


@router.get("/learn/formations/{id_effectif}/{id_form}/fiche_pdf")
def learn_formation_fiche_pdf(id_effectif: str, id_form: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                form = _fetch_form_detail(cur, oid, fid)
                logo_bytes = _fetch_owner_logo_bytes(cur, oid)

        code_label = form.get("code") or "Formation"
        titre_label = form.get("titre") or "Formation"
        owner_label = (profile.get("nom_owner") or "Novoskill Learn").strip() or "Novoskill Learn"

        filename = _pdf_latin1_safe(
            f"Fiche formation {_pdf_safe_filename_part(code_label, 32)} - {_pdf_safe_filename_part(titre_label, 80)}.pdf"
        )

        pdf_bytes = build_pdf_document(
            _build_formation_pdf_story(form),
            meta={
                "title": _pdf_latin1_safe(f"Fiche formation - {code_label} - {titre_label}"),
                "doc_label": _pdf_latin1_safe("Fiche formation"),
                "footer_left": _pdf_latin1_safe("Novoskill Learn • Fiche formation"),
                "header_right": _pdf_latin1_safe(owner_label),
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
        raise HTTPException(status_code=500, detail=f"learn/formations fiche_pdf error: {e}")