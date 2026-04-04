from fastapi import APIRouter, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import (
    learn_require_user,
    learn_get_default_effectif,
)

router = APIRouter()


@router.api_route("/learn/auth/context", methods=["GET", "HEAD"])
def learn_auth_context(request: Request):
    """
    Contexte Learn depuis l'identité Supabase :
    - email
    - is_super_admin
    - id_effectif
    """
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            id_effectif = learn_get_default_effectif(cur, u)

    return {
        "email": u.get("email"),
        "is_super_admin": bool(u.get("is_super_admin")),
        "id_effectif": id_effectif or None,
    }