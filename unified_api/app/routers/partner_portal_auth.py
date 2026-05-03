from fastapi import APIRouter, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.partner_portal_common import (
    partner_require_user,
    partner_get_default_consultant,
)

router = APIRouter()


@router.api_route("/partner/auth/context", methods=["GET", "HEAD"])
def partner_auth_context(request: Request):
    """
    Contexte Partner depuis l'identité Supabase :
    - email
    - id_consultant
    - rôle unique user
    """
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            id_consultant = partner_get_default_consultant(cur, u)

    return {
        "email": u.get("email"),
        "is_super_admin": False,
        "id_consultant": id_consultant or None,
    }