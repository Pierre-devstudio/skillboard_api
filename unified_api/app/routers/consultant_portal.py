from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import consultant_portal_dashboard, consultant_portal_donnees, consultant_portal_expertises

# ======================================================
# APP LOCALE (hub)
# ======================================================
app_local = FastAPI(title="Skillboard - Portail Consultant API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://consultants.jmbconsultant.fr",
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
@app_local.api_route("/consultant/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}

# ======================================================
# Injection manuelle des routes des menus
# (même principe que ton main.py)
# ======================================================
for route in consultant_portal_dashboard.router.routes:
    app_local.router.routes.append(route)

for route in consultant_portal_donnees.router.routes:
    app_local.router.routes.append(route)

for route in consultant_portal_expertises.router.routes:
    app_local.router.routes.append(route)

# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
