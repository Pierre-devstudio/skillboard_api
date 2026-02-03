from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware


from app.routers import skills_portal_auth, skills_portal_dashboard, skills_portal_informations, skills_portal_organisation, skills_portal_collaborateurs, skills_portal_referentiel_competence, skills_portal_cartographie_competences, skills_portal_analyse, skills_portal_entretien_performance
from psycopg.rows import dict_row
from app.routers.skills_portal_common import (
    get_conn,
    fetch_effectif_with_entreprise,
    skills_require_user,
    skills_list_enterprises,
)

# ======================================================
# APP LOCALE (hub)
# ======================================================
app_local = FastAPI(title="Skillboard - Portail Skills API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # À ajuster quand tu auras le domaine final du portail skills
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

# ======================================================
# Endpoints "hub"
# ======================================================
@app_local.api_route("/skills/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}
# ======================================================
# Auth endpoints (Skills)
# ======================================================
@app_local.get("/skills/me")
def skills_me(request: Request):
    auth = request.headers.get("Authorization", "")
    u = skills_require_user(auth)

    return {
        "id": u.get("id"),
        "email": u.get("email"),
        "is_super_admin": bool(u.get("is_super_admin")),
        "user_metadata": u.get("user_metadata") or {},
    }


@app_local.get("/skills/me/scope")
def skills_me_scope(request: Request):
    """
    Retourne la liste des entreprises accessibles:
    - super admin: toutes les entreprises éligibles Skills
    - user normal: uniquement son entreprise (via id_effectif dans user_metadata)
    """
    auth = request.headers.get("Authorization", "")
    u = skills_require_user(auth)

    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if u.get("is_super_admin"):
                return {"mode": "super_admin", "entreprises": skills_list_enterprises(cur)}

            meta = u.get("user_metadata") or {}
            id_effectif = (meta.get("id_effectif") or "").strip()
            if not id_effectif:
                raise HTTPException(
                    status_code=403,
                    detail="Compte non rattaché à un effectif Skills (id_effectif manquant dans user_metadata).",
                )

            _row_eff, row_ent = fetch_effectif_with_entreprise(cur, id_effectif)

            return {
                "mode": "standard",
                "entreprises": [
                    {
                        "id_ent": row_ent.get("id_ent"),
                        "nom_ent": row_ent.get("nom_ent"),
                        "num_entreprise": row_ent.get("num_entreprise"),
                    }
                ],
            }


# ======================================================
# Injection manuelle des routes des menus
# (ajouté au fur et à mesure, même principe que consultant_portal.py)
# ======================================================
for route in skills_portal_auth.router.routes:
     app_local.router.routes.append(route)
     
for route in skills_portal_dashboard.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_informations.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_organisation.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_collaborateurs.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_referentiel_competence.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_cartographie_competences.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_analyse.router.routes:
     app_local.router.routes.append(route)

for route in skills_portal_entretien_performance.router.routes:
     app_local.router.routes.append(route)

# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
