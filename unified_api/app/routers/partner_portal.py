from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from app.routers import partner_portal_auth, partner_portal_dashboard
from app.routers.skills_portal_common import get_conn
from app.routers.partner_portal_common import (
    partner_require_user,
    partner_list_profiles,
    partner_get_default_consultant,
    partner_fetch_profile,
)

app_local = FastAPI(title="Novoskill - Portail Partner API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://skillboard.jmbconsultant.fr",
        "https://novoskill.jmbconsultant.fr",
        "https://skills.jmbconsultant.fr",
        "https://forms.jmbconsultant.fr",
        "https://skillboard-services.onrender.com",
        "http://localhost",
        "http://127.0.0.1:5500",
        "null",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app_local.api_route("/partner/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get("/partner/me")
def partner_me(request: Request):
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    prenom = None

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_consultant = partner_get_default_consultant(cur, u)
                if id_consultant:
                    profile = partner_fetch_profile(
                        cur,
                        id_consultant=id_consultant,
                        email=(u.get("email") or ""),
                        is_super_admin=bool(u.get("is_super_admin")),
                    )
                    prenom = profile.get("prenom")
    except Exception:
        prenom = None

    return {
        "id": u.get("id"),
        "email": u.get("email"),
        "prenom": (prenom or "").strip() or None,
        "is_super_admin": False,
        "user_metadata": u.get("user_metadata") or {},
    }


@app_local.get("/partner/me/scope")
def partner_me_scope(request: Request):
    auth = request.headers.get("Authorization", "")
    u = partner_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            profiles = partner_list_profiles(
                cur,
                email=(u.get("email") or ""),
                is_super_admin=False,
            )

            if not profiles:
                raise HTTPException(
                    status_code=403,
                    detail="Compte non rattaché à un profil Partner.",
                )

            return {
                "mode": "standard",
                "profiles": profiles,
            }


for route in partner_portal_auth.router.routes:
    app_local.router.routes.append(route)

for route in partner_portal_dashboard.router.routes:
    app_local.router.routes.append(route)

router = app_local