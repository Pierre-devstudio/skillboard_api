from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Les menus seront importés ici au fur et à mesure
# from app.routers import skills_portal_dashboard, skills_portal_donnees, ...

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
# Injection manuelle des routes des menus
# (ajouté au fur et à mesure, même principe que consultant_portal.py)
# ======================================================
# for route in skills_portal_dashboard.router.routes:
#     app_local.router.routes.append(route)

# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
