from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
import os
import requests

from app.routers.skills_portal_common import get_conn

router = APIRouter()

STUDIO_SUPABASE_URL = os.getenv("STUDIO_SUPABASE_URL") or ""
STUDIO_SUPABASE_ANON_KEY = os.getenv("STUDIO_SUPABASE_ANON_KEY") or ""
STUDIO_SUPER_ADMIN_EMAILS = os.getenv("STUDIO_SUPER_ADMIN_EMAILS") or ""


def _super_admin_list():
    lst = []
    for s in (STUDIO_SUPER_ADMIN_EMAILS or "").split(","):
        v = (s or "").strip().lower()
        if v:
            lst.append(v)
    return lst


def _require_env():
    if not STUDIO_SUPABASE_URL or not STUDIO_SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="Supabase Studio non configuré (env manquantes).")


def _get_bearer_token(request: Request) -> str:
    auth = (request.headers.get("Authorization") or "").strip()
    if not auth.lower().startswith("bearer "):
        return ""
    return auth.split(" ", 1)[1].strip()


def _supabase_get_user_email(access_token: str) -> str:
    _require_env()
    if not access_token:
        raise HTTPException(status_code=401, detail="Token manquant.")

    url = f"{STUDIO_SUPABASE_URL.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": STUDIO_SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {access_token}",
    }

    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code >= 400:
            raise HTTPException(status_code=401, detail="Token invalide.")
        js = r.json()
        email = (js.get("email") or "").strip().lower()
        if not email:
            raise HTTPException(status_code=401, detail="Email introuvable.")
        return email
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur auth Supabase: {e}")


def _fetch_mapping(cur, email: str):
    cur.execute(
        """
        SELECT id_access, email, id_owner
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email,),
    )
    return cur.fetchone()


@router.api_route("/studio/auth/context", methods=["GET", "HEAD"])
def studio_auth_context(request: Request):
    """
    Contexte Studio depuis l'identité Supabase:
    - email
    - is_super_admin
    - id_owner (si rattaché via tbl_studio_user_access)
    """
    token = _get_bearer_token(request)
    email = _supabase_get_user_email(token)
    is_super = email in _super_admin_list()

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            row = _fetch_mapping(cur, email)

    id_owner = None
    if row and row.get("id_owner"):
        id_owner = row.get("id_owner")

    return {
        "email": email,
        "is_super_admin": is_super,
        "id_owner": id_owner,
    }