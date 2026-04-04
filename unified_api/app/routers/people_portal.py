from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from app.routers import people_portal_auth, people_portal_dashboard
from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_require_user,
    people_list_profiles,
    people_get_default_effectif,
    people_fetch_profile,
)

app_local = FastAPI(title="Novoskill - Portail People API")

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


@app_local.api_route("/people/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get("/people/me")
def people_me(request: Request):
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)

    prenom = None

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_effectif = people_get_default_effectif(cur, u)
                if id_effectif:
                    profile = people_fetch_profile(
                        cur,
                        id_effectif=id_effectif,
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
        "is_super_admin": bool(u.get("is_super_admin")),
        "user_metadata": u.get("user_metadata") or {},
    }


@app_local.get("/people/me/scope")
def people_me_scope(request: Request):
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            profiles = people_list_profiles(
                cur,
                email=(u.get("email") or ""),
                is_super_admin=bool(u.get("is_super_admin")),
            )

            if not profiles and not u.get("is_super_admin"):
                raise HTTPException(
                    status_code=403,
                    detail="Compte non rattaché à un profil People.",
                )

            mode = "super_admin" if u.get("is_super_admin") else "standard"
            return {
                "mode": mode,
                "profiles": profiles,
            }


for route in people_portal_auth.router.routes:
    app_local.router.routes.append(route)

for route in people_portal_dashboard.router.routes:
    app_local.router.routes.append(route)

router = app_local