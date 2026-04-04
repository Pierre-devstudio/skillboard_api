from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_require_user,
    people_get_default_effectif,
)

router = APIRouter()


@router.api_route("/people/auth/context", methods=["GET", "HEAD"])
def people_auth_context(request: Request):
    """
    Contexte People depuis l'identité Supabase :
    - email
    - is_super_admin
    - id_effectif
    """
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            id_effectif = people_get_default_effectif(cur, u)

    return {
        "email": u.get("email"),
        "is_super_admin": bool(u.get("is_super_admin")),
        "id_effectif": id_effectif or None,
    }