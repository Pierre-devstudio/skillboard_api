from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Any
from psycopg.rows import dict_row
import uuid
import os
import json

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

router = APIRouter()


# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def _require_owner_access(cur, u: dict, id_owner: str) -> str:
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
        SELECT id_owner
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email,),
    )
    r = cur.fetchone() or {}
    db_owner = (r.get("id_owner") or "").strip()
    if not db_owner or db_owner != oid:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _competence_exists_owner(cur, oid: str, id_comp: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_competence
        WHERE id_comp = %s
          AND id_owner = %s
        LIMIT 1
        """,
        (id_comp, oid),
    )
    return cur.fetchone() is not None


def _competence_code_exists_owner(cur, oid: str, code: str, exclude_id: Optional[str] = None) -> bool:
    c = (code or "").strip()
    if not c:
        return False

    if exclude_id:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_competence
            WHERE id_owner = %s
              AND lower(code) = lower(%s)
              AND id_comp <> %s
            LIMIT 1
            """,
            (oid, c, exclude_id),
        )
    else:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_competence
            WHERE id_owner = %s
              AND lower(code) = lower(%s)
            LIMIT 1
            """,
            (oid, c),
        )
    return cur.fetchone() is not None


def _next_comp_code(cur, oid: str) -> str:
    # Sérialise les créations pour un owner (évite doublons)
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

def _level_score(txt: Optional[str]) -> int:
    t = (txt or "").lower()
    score = 0
    # indices "expert"
    for w in ("transmet", "forme", "mentor", "optimise", "anticipe", "industrialise", "pilot", "stratég"):
        if w in t:
            score += 3
    # indices "autonome"
    for w in ("autonome", "structure", "fiable", "standard", "applique", "met en oeuvre", "gère"):
        if w in t:
            score += 1
    # indices "débutant"
    for w in ("guid", "supervis", "avec aide", "assist", "simple"):
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

    # Si A semble plus "expert" que C, on réordonne par score croissant
    if sa > sc:
        levels = [("niveaua", a, sa), ("niveaub", b, sb), ("niveauc", c, sc)]
        levels.sort(key=lambda x: x[2])  # score croissant: initial -> expert
        data["niveaua"] = levels[0][1]
        data["niveaub"] = levels[1][1]
        data["niveauc"] = levels[2][1]

# ------------------------------------------------------
# Models
# ------------------------------------------------------
class AiDraftCompetencePayload(BaseModel):
    objectif: str
    contexte: Optional[str] = None
    domaine_id: Optional[str] = None  # si l'user veut imposer un domaine
    nb_criteres: Optional[int] = None  # 2,3,4 (default 3)

class CreateCompetencePayload(BaseModel):
    code: Optional[str] = None
    intitule: str
    description: Optional[str] = None
    domaine: Optional[str] = None
    niveaua: Optional[str] = None
    niveaub: Optional[str] = None
    niveauc: Optional[str] = None
    grille_evaluation: Optional[Any] = None
    etat: Optional[str] = None


class UpdateCompetencePayload(BaseModel):
    code: Optional[str] = None  # interdit (verrou serveur)
    intitule: Optional[str] = None
    description: Optional[str] = None
    domaine: Optional[str] = None
    niveaua: Optional[str] = None
    niveaub: Optional[str] = None
    niveauc: Optional[str] = None
    grille_evaluation: Optional[Any] = None
    etat: Optional[str] = None


# ------------------------------------------------------
# Endpoints
# ------------------------------------------------------
@router.post("/studio/catalog/competences/{id_owner}/ai_draft")
def studio_catalog_ai_draft_competence(id_owner: str, payload: AiDraftCompetencePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        if OpenAI is None:
            raise HTTPException(status_code=500, detail="Lib OpenAI manquante (pip install openai).")

        objectif = (payload.objectif or "").strip()
        if not objectif:
            raise HTTPException(status_code=400, detail="Objectif obligatoire.")

        contexte = (payload.contexte or "").strip() or None
        domaine_force = (payload.domaine_id or "").strip() or None

        # Nombre de critères demandé (2/3/4) - défaut 3
        nb = payload.nb_criteres if payload.nb_criteres is not None else 3
        try:
            nb = int(nb)
        except Exception:
            nb = 3
        if nb not in (2, 3, 4):
            nb = 3

        model = (os.getenv("OPENAI_MODEL_COMP_DRAFT") or "gpt-4o-mini").strip()
        api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        if not api_key:
            raise HTTPException(status_code=500, detail="OPENAI_API_KEY non configurée.")

        # --- scope + domaines
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                cur.execute(
                    """
                    SELECT id_domaine_competence, COALESCE(titre_court, titre, id_domaine_competence) AS label
                    FROM public.tbl_domaine_competence
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY COALESCE(ordre_affichage, 999999), lower(COALESCE(titre_court, titre, id_domaine_competence))
                    """
                )
                dom_rows = cur.fetchall() or []

        dom_map = { (r.get("id_domaine_competence") or "").strip(): (r.get("label") or "").strip() for r in dom_rows }
        dom_list_txt = "\n".join([f"- {k} : {v}" for k, v in dom_map.items()]) if dom_map else "- (aucun domaine)"

        # --- JSON Schema strict
        schema = {
            "type": "object",
            "additionalProperties": False,
            "required": ["intitule", "description", "niveaua", "niveaub", "niveauc", "domaine_id", "grille_evaluation"],
            "properties": {
                "intitule": {"type": "string", "minLength": 1, "maxLength": 140},
                "description": {"type": "string", "maxLength": 1200},
                "niveaua": {"type": "string", "maxLength": 230},
                "niveaub": {"type": "string", "maxLength": 230},
                "niveauc": {"type": "string", "maxLength": 230},
                "domaine_id": {"type": ["string", "null"]},
                "grille_evaluation": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["Critere1", "Critere2", "Critere3", "Critere4"],
                    "properties": {
                        "Critere1": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["Nom", "Eval"],
                            "properties": {
                                "Nom": {"type": "string", "maxLength": 140},
                                "Eval": {
                                    "type": "array",
                                    "minItems": 4,
                                    "maxItems": 4,
                                    "items": {"type": "string", "maxLength": 120}
                                }
                            }
                        },
                        "Critere2": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["Nom", "Eval"],
                            "properties": {
                                "Nom": {"type": "string", "maxLength": 140},
                                "Eval": {
                                    "type": "array",
                                    "minItems": 4,
                                    "maxItems": 4,
                                    "items": {"type": "string", "maxLength": 120}
                                }
                            }
                        },
                        "Critere3": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["Nom", "Eval"],
                            "properties": {
                                "Nom": {"type": "string", "maxLength": 140},
                                "Eval": {
                                    "type": "array",
                                    "minItems": 4,
                                    "maxItems": 4,
                                    "items": {"type": "string", "maxLength": 120}
                                }
                            }
                        },
                        "Critere4": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["Nom", "Eval"],
                            "properties": {
                                "Nom": {"type": "string", "maxLength": 140},
                                "Eval": {
                                    "type": "array",
                                    "minItems": 4,
                                    "maxItems": 4,
                                    "items": {"type": "string", "maxLength": 120}
                                }
                            }
                        }
                    }
                }
            }
        }

        sys = (
            "Tu es concepteur pédagogique et tu aides à concevoir une fiche compétence opérationnelle. "
            "Tu dois respecter STRICTEMENT le schéma JSON fourni. "
            "Règles de niveau A/B/C (IMPORTANT): "
            "A = initial (débutant, guidé, applique des consignes simples), "
            "B = avancé (autonome, structuré, fiable), "
            "C = expert (maîtrise, optimise, anticipe, transmet/forme). "
            "Les évaluations (4 niveaux par critère) doivent être progressives, observables et actionnables. "
            "Chaque évaluation doit être courte (<=120 caractères), 1 phrase, verbe d'action + résultat observable. "
            "Tu dois produire EXACTEMENT le nombre de critères demandé. "
            "Si le nombre demandé est inférieur à 4, laisse les critères restants vides "
            "(Nom vide + 4 Eval vides). "
            "Critères: ils doivent couvrir des axes DISTINCTS (pas de doublons), "
            "ex: méthode/process, exécution/outils, qualité/contrôle, communication/traçabilité."
        )

        user = (
            f"Objectif: {objectif}\n"
            f"Contexte: {contexte or ''}\n"
            f"Domaine imposé (si non vide): {domaine_force or ''}\n"
            f"Nombre de critères à produire: {nb}\n\n"
            f"Domaines disponibles (id -> titre_court):\n{dom_list_txt}\n\n"
            "Contraintes:\n"
            f"- Produis exactement {nb} critères NON VIDES (Critere1..Critere{nb}).\n"
            f"- Critere{nb+1}..Critere4 doivent être VIDES (Nom=\"\" + 4 Eval vides).\n"
            "- Chaque critère = un axe distinct (évite recouvrement).\n"
            "- Les 4 niveaux d’un critère doivent montrer une progression claire: guidé → autonome → optimisation → expertise/transmission.\n"
            "- Niveaux A/B/C: A initial guidé, B autonome fiable, C expert optimise/transmet.\n"
            "- Niveaux A/B/C <=230 caractères chacun.\n"
        )

        client = OpenAI(api_key=api_key)

        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sys},
                {"role": "user", "content": user},
            ],
            temperature=0.3,
            max_tokens=1200,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "competence_draft",
                    "schema": schema,
                    "strict": True,
                },
            },
        )

        content = (resp.choices[0].message.content or "").strip()
        if not content:
            raise HTTPException(status_code=500, detail="Réponse IA vide.")

        data = json.loads(content)
        _fix_abc_levels(data)

        # --- Domaine: priorité au domaine imposé, sinon celui proposé si valide
        dom_out = (domaine_force or (data.get("domaine_id") or "")).strip() or None
        if dom_out and dom_out not in dom_map:
            dom_out = None
        data["domaine_id"] = dom_out

        # --- sanity: au moins 1 critère non vide
        ge = data.get("grille_evaluation") or {}
        used = 0
        for k in ("Critere1", "Critere2", "Critere3", "Critere4"):
            nm = ((ge.get(k) or {}).get("Nom") or "").strip()
            if nm:
                used += 1
        if used < 1:
            raise HTTPException(status_code=400, detail="IA: aucun critère exploitable généré (re-tente avec plus de contexte).")

        return data

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences ai_draft error: {e}")
    
@router.get("/studio/catalog/domaines/{id_owner}")
def studio_catalog_list_domaines(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                cur.execute(
                    """
                    SELECT
                      id_domaine_competence,
                      titre,
                      titre_court,
                      description,
                      ordre_affichage,
                      couleur
                    FROM public.tbl_domaine_competence
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY
                      COALESCE(ordre_affichage, 999999),
                      lower(COALESCE(titre_court, titre, id_domaine_competence))
                    """
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_domaine_competence": r.get("id_domaine_competence"),
                    "titre": r.get("titre"),
                    "titre_court": r.get("titre_court"),
                    "description": r.get("description"),
                    "ordre_affichage": r.get("ordre_affichage"),
                    "couleur": r.get("couleur"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/domaines error: {e}")
    
@router.get("/studio/catalog/competences/{id_owner}")
def studio_catalog_list_competences(
    id_owner: str,
    request: Request,
    q: str = "",
    show: str = "active",  # active | archived | all
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()
        sh = (show or "active").strip().lower()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                where = ["c.id_owner = %s"]
                params = [oid]

                if sh == "active":
                    where.append("COALESCE(c.masque, FALSE) = FALSE")
                elif sh == "archived":
                    where.append("COALESCE(c.masque, FALSE) = TRUE")
                # all => pas de filtre

                if qq:
                    like = f"%{qq}%"
                    where.append("(c.code ILIKE %s OR c.intitule ILIKE %s OR COALESCE(c.domaine,'') ILIKE %s)")
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT
                    c.id_comp,
                    c.code,
                    c.intitule,
                    c.domaine,
                    dc.titre_court AS domaine_titre_court,
                    dc.couleur AS domaine_couleur,
                    c.etat,
                    COALESCE(c.masque, FALSE) AS masque,
                    c.date_modification
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                    ON dc.id_domaine_competence = c.domaine
                    AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE {" AND ".join(where)}
                    ORDER BY lower(c.code), lower(c.intitule)
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "domaine": r.get("domaine"),
                    "etat": r.get("etat"),
                    "masque": bool(r.get("masque")),
                    "date_modification": r.get("date_modification"),
                    "domaine_titre_court": r.get("domaine_titre_court"),
                    "domaine_couleur": r.get("domaine_couleur"),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences list error: {e}")


@router.get("/studio/catalog/competences/{id_owner}/next_code")
def studio_catalog_next_competence_code(id_owner: str, request: Request, prefix: str = "CP"):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pref = (prefix or "CP").strip().upper()
        if len(pref) > 6:
            raise HTTPException(status_code=400, detail="Prefix trop long.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                code = _next_comp_code(cur, oid)

        return {"code": code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences next_code error: {e}")


@router.get("/studio/catalog/competences/{id_owner}/{id_comp}")
def studio_catalog_competence_detail(id_owner: str, id_comp: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_comp or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                cur.execute(
                    """
                    SELECT
                    c.id_comp,
                    c.code,
                    c.intitule,
                    c.description,
                    c.domaine,
                    dc.titre_court AS domaine_titre_court,
                    dc.couleur AS domaine_couleur,
                    c.niveaua,
                    c.niveaub,
                    c.niveauc,
                    c.grille_evaluation,
                    c.etat,
                    COALESCE(c.masque, FALSE) AS masque,
                    c.date_creation,
                    c.date_modification
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                    ON dc.id_domaine_competence = c.domaine
                    AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE c.id_comp = %s
                    AND c.id_owner = %s
                    LIMIT 1
                    """,
                    (cid, oid),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Compétence introuvable.")

        return {
            "id_comp": r.get("id_comp"),
            "code": r.get("code"),
            "intitule": r.get("intitule"),
            "description": r.get("description"),
            "domaine": r.get("domaine"),
            "niveaua": r.get("niveaua"),
            "niveaub": r.get("niveaub"),
            "niveauc": r.get("niveauc"),
            "grille_evaluation": r.get("grille_evaluation"),
            "etat": r.get("etat"),
            "masque": bool(r.get("masque")),
            "date_creation": r.get("date_creation"),
            "date_modification": r.get("date_modification"),
            "domaine_titre_court": r.get("domaine_titre_court"),
            "domaine_couleur": r.get("domaine_couleur"),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences detail error: {e}")


@router.post("/studio/catalog/competences/{id_owner}")
def studio_catalog_create_competence(id_owner: str, payload: CreateCompetencePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        title = (payload.intitule or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                code = _next_comp_code(cur, oid)

                cid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_competence
                      (id_comp, id_owner, code, intitule, description, domaine,
                       niveaua, niveaub, niveauc, grille_evaluation,
                       etat, masque, date_creation, date_modification)
                    VALUES
                      (%s, %s, %s, %s, %s, %s,
                       %s, %s, %s, %s,
                       %s, FALSE, NOW(), NOW())
                    """,
                    (
                        cid,
                        oid,
                        code,
                        title,
                        (payload.description or None),
                        (payload.domaine or None),
                        (payload.niveaua or None),
                        (payload.niveaub or None),
                        (payload.niveauc or None),
                        payload.grille_evaluation,
                        (payload.etat or "valide"),
                    ),
                )
                conn.commit()

        return {"id_comp": cid, "code": code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences create error: {e}")


@router.post("/studio/catalog/competences/{id_owner}/{id_comp}")
def studio_catalog_update_competence(id_owner: str, id_comp: str, payload: UpdateCompetencePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_comp or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        if "code" in patch_fields:
            raise HTTPException(status_code=400, detail="Le code est verrouillé après création.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                if not _competence_exists_owner(cur, oid, cid):
                    raise HTTPException(status_code=404, detail="Compétence introuvable (owner).")

                cols = []
                vals = []

                if "intitule" in patch_fields:
                    title = (payload.intitule or "").strip()
                    if not title:
                        raise HTTPException(status_code=400, detail="Intitulé obligatoire.")
                    cols.append("intitule = %s")
                    vals.append(title)

                if "description" in patch_fields:
                    cols.append("description = %s")
                    vals.append(payload.description)

                if "domaine" in patch_fields:
                    cols.append("domaine = %s")
                    vals.append(payload.domaine)

                if "niveaua" in patch_fields:
                    cols.append("niveaua = %s")
                    vals.append(payload.niveaua)

                if "niveaub" in patch_fields:
                    cols.append("niveaub = %s")
                    vals.append(payload.niveaub)

                if "niveauc" in patch_fields:
                    cols.append("niveauc = %s")
                    vals.append(payload.niveauc)

                if "grille_evaluation" in patch_fields:
                    cols.append("grille_evaluation = %s")
                    vals.append(payload.grille_evaluation)

                if "etat" in patch_fields:
                    cols.append("etat = %s")
                    vals.append(payload.etat)

                if cols:
                    cols.append("date_modification = NOW()")
                    vals.extend([cid, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_competence
                        SET {", ".join(cols)}
                        WHERE id_comp = %s
                          AND id_owner = %s
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences update error: {e}")


@router.post("/studio/catalog/competences/{id_owner}/{id_comp}/archive")
def studio_catalog_archive_competence(id_owner: str, id_comp: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_comp or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                cur.execute(
                    """
                    UPDATE public.tbl_competence
                    SET masque = TRUE, date_modification = NOW()
                    WHERE id_comp = %s
                      AND id_owner = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (cid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/competences archive error: {e}")