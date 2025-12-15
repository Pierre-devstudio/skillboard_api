# app/routers/consultant_portal.py

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import os

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

# ======================================================
# ENV
# ======================================================
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

# ======================================================
# APP LOCALE (router)
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
# Modèle de sortie
# ======================================================
class ConsultantContext(BaseModel):
    id_consultant: str
    civilite: Optional[str] = None
    prenom: str
    nom: str


# ======================================================
# Connexion DB
# ======================================================
def _missing_env():
    return [
        k
        for k, v in {
            "DB_HOST": DB_HOST,
            "DB_PORT": DB_PORT,
            "DB_NAME": DB_NAME,
            "DB_USER": DB_USER,
            "DB_PASSWORD": DB_PASSWORD,
        }.items()
        if not v
    ]


def get_conn():
    missing = _missing_env()
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Variables manquantes: {', '.join(missing)}",
        )
    try:
        return psycopg.connect(
            host=DB_HOST,
            port=DB_PORT,
            dbname=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD,
            sslmode="require",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur connexion DB: {e}")


# ======================================================
# Endpoints
# ======================================================
@app_local.api_route("/consultant/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/consultant/context/{id_consultant}",
    response_model=ConsultantContext,
)
def get_consultant_context(id_consultant: str):
    """
    Retourne le contexte de base du consultant :
    id, civilité, prénom, nom.
    (On étoffera plus tard si besoin.)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        c.id_consultant,
                        c.civilite AS civilite_consultant,
                        c.prenom AS prenom_consultant,
                        c.nom AS nom_consultant
                    FROM public.tbl_consultant c
                    WHERE c.id_consultant = %s
                      AND c.archive = FALSE
                    """,
                    (id_consultant,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Consultant introuvable ou archivé.",
                    )

                return ConsultantContext(
                    id_consultant=row["id_consultant"],
                    civilite=row.get("civilite_consultant"),
                    prenom=row["prenom_consultant"],
                    nom=row["nom_consultant"],
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
