from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner

router = APIRouter()


class StudioContext(BaseModel):
    id_owner: str
    nom_owner: str
    email: str
    prenom: Optional[str] = None


def _require_owner_access(cur, u: dict, id_owner: str):
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    # Super-admin: accès à tous les owners
    if u.get("is_super_admin"):
        return oid

    # Standard: vérif accès via user_metadata OU mapping DB
    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner and meta_owner == oid:
        return oid

    email = (u.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email, oid),
    )
    ok = cur.fetchone()
    if not ok:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _resolve_prenom(cur, email: str, id_owner: str) -> Optional[str]:
    e = (email or "").strip()
    oid = (id_owner or "").strip()
    if not e or not oid:
        return None

    cur.execute(
        """
        SELECT user_ref_type, id_user_ref
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (e, oid),
    )
    m = cur.fetchone() or {}
    ref_type = (m.get("user_ref_type") or "").strip().lower()
    ref_id = (m.get("id_user_ref") or "").strip()

    if ref_type == "utilisateur" and ref_id:
        try:
            cur.execute(
                """
                SELECT ut_prenom
                FROM public.tbl_utilisateur
                WHERE id_utilisateur = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (ref_id,),
            )
        except Exception as e:
            # Fallback si la colonne archive n'existe pas / variante schéma
            msg = str(e).lower()
            if "archive" in msg and ("does not exist" in msg or "n'existe pas" in msg):
                cur.execute(
                    """
                    SELECT ut_prenom
                    FROM public.tbl_utilisateur
                    WHERE id_utilisateur = %s
                    LIMIT 1
                    """,
                    (ref_id,),
                )
            else:
                raise
        r = cur.fetchone() or {}
        v = (r.get("ut_prenom") or "").strip()
        return v or None

    if ref_type == "effectif_client" and ref_id:
        try:
            cur.execute(
                """
                SELECT prenom_effectif
                FROM public.tbl_effectif_client
                WHERE id_effectif = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (ref_id,),
            )
        except Exception as e:
            msg = str(e).lower()
            if "archive" in msg and ("does not exist" in msg or "n'existe pas" in msg):
                cur.execute(
                    """
                    SELECT prenom_effectif
                    FROM public.tbl_effectif_client
                    WHERE id_effectif = %s
                    LIMIT 1
                    """,
                    (ref_id,),
                )
            else:
                raise
        r = cur.fetchone() or {}
        v = (r.get("prenom_effectif") or "").strip()
        return v or None

    return None


@router.get("/studio/context/{id_owner}", response_model=StudioContext)
def get_studio_context(id_owner: str, request: Request):
    """
    Contexte minimal pour dashboard/topbar Studio:
    - owner (id_owner, nom_owner)
    - user (email, prenom)
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                ow = studio_fetch_owner(cur, oid)
                prenom = _resolve_prenom(cur, u.get("email") or "", oid)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/context error: {e}")

    return StudioContext(
        id_owner=ow.get("id_owner"),
        nom_owner=ow.get("nom_owner"),
        email=(u.get("email") or "").strip(),
        prenom=prenom,
    )