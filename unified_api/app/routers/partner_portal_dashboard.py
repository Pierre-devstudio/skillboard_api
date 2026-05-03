from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.partner_portal_common import (
    partner_require_user,
    partner_fetch_profile,
)

router = APIRouter()


@router.get("/partner/context/{id_consultant}")
def partner_context(id_consultant: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = partner_fetch_profile(
                    cur,
                    id_consultant=id_consultant,
                    email=(u.get("email") or ""),
                    is_super_admin=bool(u.get("is_super_admin")),
                )

        return profile
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"partner/context error: {e}")


@router.get("/partner/profile/{id_consultant}")
def partner_profile(id_consultant: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = partner_fetch_profile(
                    cur,
                    id_consultant=id_consultant,
                    email=(u.get("email") or ""),
                    is_super_admin=bool(u.get("is_super_admin")),
                )

        return profile
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"partner/profile error: {e}")