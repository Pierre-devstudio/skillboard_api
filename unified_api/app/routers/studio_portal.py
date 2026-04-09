from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from app.routers import studio_portal_auth, studio_portal_dashboard, studio_portal_data, studio_portal_organisation, studio_portal_collaborateurs, studio_portal_catalog_postes, studio_portal_catalog_competences, studio_portal_clients
from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_list_owners,
    studio_fetch_owner,
)

app_local = FastAPI(title="Novoskill - Portail Studio API")

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

@app_local.api_route("/studio/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}

@app_local.get("/studio/me")
def studio_me(request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    prenom = None

    try:
        email = (u.get("email") or "").strip()
        if email:
            with get_conn() as conn:
                with conn.cursor(row_factory=dict_row) as cur:
                    cur.execute(
                        """
                        SELECT user_ref_type, id_user_ref
                        FROM public.tbl_novoskill_user_access
                        WHERE lower(email) = lower(%s)
                          AND console_code = 'studio'
                          AND COALESCE(archive, FALSE) = FALSE
                          AND COALESCE(statut_access, 'actif') <> 'suspendu'
                        LIMIT 1
                        """,
                        (email,),
                    )
                    m = cur.fetchone() or {}
                    ref_type = (m.get("user_ref_type") or "").strip().lower()
                    ref_id = (m.get("id_user_ref") or "").strip()

                    if ref_type == "utilisateur" and ref_id:
                        cur.execute(
                            """
                            SELECT ut_prenom
                            FROM public.tbl_utilisateur
                            WHERE id_utilisateur = %s
                              AND COALESCE(archive, FALSE) = FALSE
                            LIMIT 1
                            """,
                            (ref_id,),
                        )
                        r = cur.fetchone() or {}
                        prenom = r.get("ut_prenom")

                    elif ref_type == "effectif_client" and ref_id:
                        cur.execute(
                            """
                            SELECT prenom_effectif
                            FROM public.tbl_effectif_client
                            WHERE id_effectif = %s
                              AND COALESCE(archive, FALSE) = FALSE
                            LIMIT 1
                            """,
                            (ref_id,),
                        )
                        r = cur.fetchone() or {}
                        prenom = r.get("prenom_effectif")
    except Exception:
        prenom = None

    return {
        "id": u.get("id"),
        "email": u.get("email"),
        "prenom": (prenom or "").strip() or None,
        "is_super_admin": bool(u.get("is_super_admin")),
        "user_metadata": u.get("user_metadata") or {},
    }

@app_local.get("/studio/me/scope")
def studio_me_scope(request: Request):
    """
    Scope Studio:
    - super admin: liste de tous les owners
    - user normal: uniquement son owner (id_owner dans user_metadata ou via mapping DB)
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if u.get("is_super_admin"):
                owners = studio_list_owners(cur)
                for o in owners:
                    o["role_code"] = "admin"
                    o["role_label"] = "Administrateur"
                return {"mode": "super_admin", "owners": owners}

            meta = u.get("user_metadata") or {}
            id_owner = (meta.get("id_owner") or "").strip()

            if not id_owner:
                email = (u.get("email") or "").strip()
                if email:
                    cur.execute(
                        """
                        SELECT id_owner
                        FROM public.tbl_novoskill_user_access
                        WHERE lower(email) = lower(%s)
                          AND console_code = 'studio'
                          AND COALESCE(archive, FALSE) = FALSE
                          AND COALESCE(statut_access, 'actif') <> 'suspendu'
                        LIMIT 1
                        """,
                        (email,),
                    )
                    row = cur.fetchone() or {}
                    id_owner = (row.get("id_owner") or "").strip()

            if not id_owner:
                raise HTTPException(
                    status_code=403,
                    detail="Compte non rattaché à un owner Studio (id_owner introuvable).",
                )

            role_code = "user"
            email = (u.get("email") or "").strip()
            if email and id_owner:
                cur.execute(
                    """
                    SELECT role_code
                    FROM public.tbl_novoskill_user_access
                    WHERE lower(email) = lower(%s)
                      AND id_owner = %s
                      AND console_code = 'studio'
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(statut_access, 'actif') <> 'suspendu'
                    LIMIT 1
                    """,
                    (email, id_owner),
                )
                rr = cur.fetchone() or {}
                rc = (rr.get("role_code") or "user").strip().lower()
                if rc in ("admin", "editor", "user"):
                    role_code = rc

            role_label = "Utilisateur"
            if role_code == "admin":
                role_label = "Administrateur"
            elif role_code == "editor":
                role_label = "Éditeur"

            ow = studio_fetch_owner(cur, id_owner)
            ow["role_code"] = role_code
            ow["role_label"] = role_label
            return {"mode": "standard", "owners": [ow]}

# Injection routes auth
for route in studio_portal_auth.router.routes:
    app_local.router.routes.append(route)

# Injection routes dashboard
for route in studio_portal_dashboard.router.routes:
    app_local.router.routes.append(route)

# Injection routes "Vos données"
for route in studio_portal_data.router.routes:
    app_local.router.routes.append(route)

# Injection routes organisation
for route in studio_portal_organisation.router.routes:
    app_local.router.routes.append(route)

# Injection routes collaborateurs
for route in studio_portal_collaborateurs.router.routes:
    app_local.router.routes.append(route)

# Injection routes catalogue fiches de poste
for route in studio_portal_catalog_postes.router.routes:
    app_local.router.routes.append(route)

# Injection routes catalogue compétences
for route in studio_portal_catalog_competences.router.routes:
    app_local.router.routes.append(route)

# Injection routes clients
for route in studio_portal_clients.router.routes:
    app_local.router.routes.append(route)

router = app_local
