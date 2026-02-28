from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from app.routers import studio_portal_auth
from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_list_owners,
    studio_fetch_owner,
)

app_local = FastAPI(title="Skillboard - Portail Studio API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://skillboard.jmbconsultant.fr",
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

@app_local.api_route("/studio/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}

@app_local.get("/studio/me")
def studio_me(request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    return {
        "id": u.get("id"),
        "email": u.get("email"),
        "is_super_admin": bool(u.get("is_super_admin")),
        "user_metadata": u.get("user_metadata") or {},
    }

@app_local.get("/studio/me/scope")
def studio_me_scope(request: Request):
    """
    Scope Studio:
    - super admin: liste de tous les owners
    - user normal: uniquement son owner (id_owner dans user_metadata)
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if u.get("is_super_admin"):
                return {"mode": "super_admin", "owners": studio_list_owners(cur)}

            meta = u.get("user_metadata") or {}
            id_owner = (meta.get("id_owner") or "").strip()

            # Fallback DB (même logique que /studio/auth/context) :
            # si le user n'a pas id_owner dans user_metadata, on mappe via tbl_studio_user_access
            if not id_owner:
                email = (u.get("email") or "").strip()
                if email:
                    cur.execute(
                        """
                        SELECT id_owner
                        FROM public.tbl_studio_user_access
                        WHERE lower(email) = lower(%s)
                          AND COALESCE(archive, FALSE) = FALSE
                        LIMIT 1
                        """,
                        (email,),
                    )
                    row_map = cur.fetchone()
                    if row_map and row_map.get("id_owner"):
                        id_owner = row_map.get("id_owner")

            if not id_owner:
                raise HTTPException(
                    status_code=403,
                    detail="Compte non rattaché à un owner Studio (id_owner introuvable).",
                )

            ow = studio_fetch_owner(cur, id_owner)
            return {"mode": "standard", "owners": [ow]}

# Injection routes auth
for route in studio_portal_auth.router.routes:
    app_local.router.routes.append(route)

router = app_local
