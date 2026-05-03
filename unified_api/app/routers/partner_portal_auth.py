from fastapi import APIRouter, HTTPException, Request
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
@router.post("/partner/auth/activate")
def partner_auth_activate(request: Request):
    """
    Active les accès Novoskill après création / réinitialisation du mot de passe depuis Partner.
    Le token Supabase fait foi : l'email n'est jamais reçu depuis le front.
    L'activation est globale sur toutes les consoles de cet email.
    """
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    email = (u.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="Email introuvable dans la session.")

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                UPDATE public.tbl_novoskill_user_access
                SET statut_access = 'actif',
                    updated_at = NOW()
                WHERE lower(email) = lower(%s)
                  AND COALESCE(archive, FALSE) = FALSE
                  AND COALESCE(statut_access, '') = 'invitation'
                RETURNING id_access, console_code
                """,
                (email,),
            )
            rows = cur.fetchall() or []
        conn.commit()

    return {
        "email": email,
        "activated": len(rows),
        "console_codes": sorted(list({(r.get("console_code") or "").strip() for r in rows if r.get("console_code")})),
    }
