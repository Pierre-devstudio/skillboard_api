from fastapi import FastAPI

# Import corrects
from unified_api.app.routers.recueil_attentes import router as recueil_attentes_router
from unified_api.app.routers.preparation_formation import router as preparation_formation_router
from unified_api.app.routers.presence_formation import router as presence_formation_router
from unified_api.app.routers.presence_consultant import router as presence_consultant_router

app = FastAPI()

# Inclusion des routes
app.include_router(recueil_attentes_router, prefix="/recueil_attentes")
app.include_router(preparation_formation_router, prefix="/preparation_formation")
app.include_router(presence_formation_router, prefix="/presence")
app.include_router(presence_consultant_router, prefix="/presence_consultant")

@app.get("/")
def root():
    return {"status": "ok", "service": "skillboard unified backend"}
