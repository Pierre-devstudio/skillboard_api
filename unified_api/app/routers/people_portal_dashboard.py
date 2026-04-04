from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_require_user,
    people_fetch_profile,
)

router = APIRouter()


@router.get("/people/context/{id_effectif}")
def people_context(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = people_fetch_profile(
                    cur,
                    id_effectif=id_effectif,
                    email=(u.get("email") or ""),
                    is_super_admin=bool(u.get("is_super_admin")),
                )

        return profile
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/context error: {e}")