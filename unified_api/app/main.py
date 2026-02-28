import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from app.routers import recueil_attentes, preparation_formation, presence_formation, presence_consultant, validation_acquis,satisfaction_formation_stagiaire, satisfaction_formation_responsable, satisfaction_formation_consultant, adaptation_formation, consultant_portal, skills_portal,  studio_portal 

app = FastAPI()

# CORS autorisés
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "*"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Injection manuelle des endpoints
app.get("/")(lambda: {"status": "ok", "service": "skillboard unified backend"})

# ======================================================
# Config portail (par espace)
# - Retourne Supabase URL + ANON key
# - Ne JAMAIS renvoyer de service_role
# ======================================================
@app.get("/portal/config/{space}")
def get_portal_config(space: str):
    s = (space or "").strip().lower()

    if s == "skills":
        supabase_url = os.getenv("SKILLS_SUPABASE_URL", "") or ""
        supabase_anon = os.getenv("SKILLS_SUPABASE_ANON_KEY", "") or ""

        if not supabase_url or not supabase_anon:
            raise HTTPException(
                status_code=500,
                detail="Config Skills manquante: SKILLS_SUPABASE_URL / SKILLS_SUPABASE_ANON_KEY",
            )

        return {
            "portal_key": "skills",
            "supabase_url": supabase_url,
            "supabase_anon_key": supabase_anon,
        }

    if s == "people":
        supabase_url = os.getenv("PEOPLE_SUPABASE_URL", "") or ""
        supabase_anon = os.getenv("PEOPLE_SUPABASE_ANON_KEY", "") or ""

        if not supabase_url or not supabase_anon:
            raise HTTPException(
                status_code=500,
                detail="Config People manquante: PEOPLE_SUPABASE_URL / PEOPLE_SUPABASE_ANON_KEY",
            )

        return {
            "portal_key": "people",
            "supabase_url": supabase_url,
            "supabase_anon_key": supabase_anon,
        }

    if s == "partner":
        supabase_url = os.getenv("PARTNER_SUPABASE_URL", "") or ""
        supabase_anon = os.getenv("PARTNER_SUPABASE_ANON_KEY", "") or ""

        if not supabase_url or not supabase_anon:
            raise HTTPException(
                status_code=500,
                detail="Config Partner manquante: PARTNER_SUPABASE_URL / PARTNER_SUPABASE_ANON_KEY",
            )

        return {
            "portal_key": "partner",
            "supabase_url": supabase_url,
            "supabase_anon_key": supabase_anon,
        }
    
    if s == "studio":
        supabase_url = os.getenv("STUDIO_SUPABASE_URL", "") or ""
        supabase_anon = os.getenv("STUDIO_SUPABASE_ANON_KEY", "") or ""

        if not supabase_url or not supabase_anon:
            raise HTTPException(
                status_code=500,
                detail="Config Studio manquante: STUDIO_SUPABASE_URL / STUDIO_SUPABASE_ANON_KEY",
            )

        return {
            "portal_key": "studio",
            "supabase_url": supabase_url,
            "supabase_anon_key": supabase_anon,
        }

    raise HTTPException(status_code=404, detail="Espace portail inconnu.")


# Enregistrement manuel des routers (sans include_router)
for route in recueil_attentes.router.routes:
    app.router.routes.append(route)

for route in preparation_formation.router.routes:
    app.router.routes.append(route)

for route in presence_formation.router.routes:
    app.router.routes.append(route)

for route in presence_consultant.router.routes:
    app.router.routes.append(route)

for route in validation_acquis.router.routes:
    app.router.routes.append(route)

for route in satisfaction_formation_stagiaire.router.routes:
    app.router.routes.append(route)

for route in satisfaction_formation_responsable.router.routes:  
    app.router.routes.append(route)

for route in satisfaction_formation_consultant.router.routes:
    app.router.routes.append(route)

for route in adaptation_formation.router.routes:
    app.router.routes.append(route)

for route in consultant_portal.router.routes:
    app.router.routes.append(route)

for route in skills_portal.router.routes:
    app.router.routes.append(route)

for route in studio_portal.router.routes:
    app.router.routes.append(route)