from fastapi import FastAPI
from app.routers import (
    recueil_attentes,
    preparation_formation,
    presence_formation,
    presence_consultant,
)

app = FastAPI()

# Inclusion de chaque ancienne API comme module indépendant
app.include_router(recueil_attentes.router, prefix="/recueil_attentes")
app.include_router(preparation_formation.router, prefix="/preparation_formation")
app.include_router(presence_formation.router, prefix="")
app.include_router(presence_consultant.router, prefix="/presence_consultant")

@app.get("/")
def root():
    return {"status": "ok", "service": "skillboard unified backend"}
