from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner

router = APIRouter()


class StudioData(BaseModel):
    id_owner: str
    nom_owner: str
    email: str
    prenom: Optional[str] = None
    user_ref_type: Optional[str] = None
    id_user_ref: Optional[str] = None


def _require_owner_access(cur, u: dict, id_owner: str) -> str:
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

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


def _has_column(cur, table_name: str, column_name: str, schema: str = "public") -> bool:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
          AND column_name = %s
        LIMIT 1
        """,
        (schema, table_name, column_name),
    )
    return cur.fetchone() is not None


def _fetch_user_access(cur, email: str, id_owner: str) -> dict:
    e = (email or "").strip()
    oid = (id_owner or "").strip()
    if not e or not oid:
        return {}

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
    return cur.fetchone() or {}


def _resolve_prenom_from_mapping(cur, ref_type: str, ref_id: str) -> Optional[str]:
    t = (ref_type or "").strip().lower()
    rid = (ref_id or "").strip()
    if not t or not rid:
        return None

    if t == "utilisateur":
        has_arch = _has_column(cur, "tbl_utilisateur", "archive")
        if has_arch:
            cur.execute(
                """
                SELECT ut_prenom
                FROM public.tbl_utilisateur
                WHERE id_utilisateur = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (rid,),
            )
        else:
            cur.execute(
                """
                SELECT ut_prenom
                FROM public.tbl_utilisateur
                WHERE id_utilisateur = %s
                LIMIT 1
                """,
                (rid,),
            )
        r = cur.fetchone() or {}
        v = (r.get("ut_prenom") or "").strip()
        return v or None

    if t == "effectif_client":
        has_arch = _has_column(cur, "tbl_effectif_client", "archive")
        if has_arch:
            cur.execute(
                """
                SELECT prenom_effectif
                FROM public.tbl_effectif_client
                WHERE id_effectif = %s
                  AND COALESCE(archive, FALSE) = FALSE
                LIMIT 1
                """,
                (rid,),
            )
        else:
            cur.execute(
                """
                SELECT prenom_effectif
                FROM public.tbl_effectif_client
                WHERE id_effectif = %s
                LIMIT 1
                """,
                (rid,),
            )
        r = cur.fetchone() or {}
        v = (r.get("prenom_effectif") or "").strip()
        return v or None

    return None


@router.get("/studio/data/{id_owner}", response_model=StudioData)
def get_studio_data(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                ow = studio_fetch_owner(cur, oid)

                email = (u.get("email") or "").strip()
                m = _fetch_user_access(cur, email, oid)

                ref_type = (m.get("user_ref_type") or "").strip() or None
                ref_id = (m.get("id_user_ref") or "").strip() or None
                prenom = _resolve_prenom_from_mapping(cur, ref_type or "", ref_id or "")

        return StudioData(
            id_owner=ow.get("id_owner"),
            nom_owner=ow.get("nom_owner"),
            email=email,
            prenom=prenom,
            user_ref_type=ref_type,
            id_user_ref=ref_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data error: {e}")