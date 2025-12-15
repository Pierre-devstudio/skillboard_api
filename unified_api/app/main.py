from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import recueil_attentes, preparation_formation, presence_formation, presence_consultant, validation_acquis,satisfaction_formation_stagiaire, satisfaction_formation_responsable, satisfaction_formation_consultant 

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