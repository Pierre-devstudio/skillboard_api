from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import (
    learn_require_user,
    learn_fetch_profile,
)

router = APIRouter()


@router.get("/learn/context/{id_effectif}")
def learn_context(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = learn_fetch_profile(
                    cur,
                    id_effectif=id_effectif,
                    email=(u.get("email") or ""),
                    is_super_admin=bool(u.get("is_super_admin")),
                )

        return profile
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/context error: {e}")