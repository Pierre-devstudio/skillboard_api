# skillboard_api/api_preparation_formation/main.py
from fastapi import FastAPI, HTTPException
from datetime import datetime, timezone
from pydantic import BaseModel, constr, Field
from typing import List, Optional, Literal
import os
import socket
import json
import uuid

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

# -----------------------------
# Chargement des variables .env
# -----------------------------
# .env à la racine de skillboard_api:
# DB_HOST=...
# DB_PORT=5432
# DB_NAME=...
# DB_USER=...
# DB_PASSWORD=...
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

app = FastAPI(title="Skillboard - Préparation Formation API")

# Endpoint léger pour UptimeRobot
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
@app.head("/healthz")
async def healthz_head():
    return {"status": "ok"}

# Autoriser les origines locales pour nos tests (on ajustera plus tard pour le domaine prod)
ALLOWED_ORIGINS = [
    "https://forms.jmbconsultant.fr",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# -----------------------------
# Modèles Pydantic (entrée)
# -----------------------------
class StagiaireInput(BaseModel):
    civilite: Optional[str] = Field(default=None)
    nom: constr(min_length=1)
    prenom: constr(min_length=1)
    role: Optional[str] = None
    email: Optional[str] = None  # on n’impose pas pour l’instant

class PreparationInput(BaseModel):
    token: constr(min_length=10)
    opco_oui: bool = False
    nom_opco: Optional[str] = None
    facturation_cible: Optional[Literal["client", "opco"]] = None
    stagiaires: List[StagiaireInput] = []
    # Optionnel : tu peux aussi faire transiter l'id_offre si tu veux le poser tout de suite
    id_offre: Optional[str] = None

# -----------------------------
# Connexion DB (psycopg v3 + SSL)
# -----------------------------
def _missing_env():
    missing = [k for k, v in {
        "DB_HOST": DB_HOST,
        "DB_PORT": DB_PORT,
        "DB_NAME": DB_NAME,
        "DB_USER": DB_USER,
        "DB_PASSWORD": DB_PASSWORD,
    }.items() if not v]
    return missing

def get_conn():
    missing = _missing_env()
    if missing:
        raise HTTPException(status_code=500, detail=f"Variables manquantes: {', '.join(missing)}")

    try:
        return psycopg.connect(
            host=DB_HOST,
            port=DB_PORT,
            dbname=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD,
            sslmode="require"   # en local sur Postgres sans SSL : passer à "disable"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur connexion DB: {e}")

# -----------------------------
# Helpers SQL
# -----------------------------
def insert_preparation(cur, payload: PreparationInput) -> str:
    """
    Insère 1 ligne dans tbl_temp_preparation_formation
    et retourne id_preparation_formation (UUID TEXT).
    """
    id_prep = str(uuid.uuid4())
    json_brut = json.dumps(payload.dict(), ensure_ascii=False)

    cur.execute(
        """
        INSERT INTO public.tbl_temp_preparation_formation
        (id_preparation_formation, id_offre, token, opco_oui, nom_opco, facturation_cible, json_brut, date_creation, date_modif)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        """,
        (
            id_prep,
            payload.id_offre,             # None si non fourni (OK pour notre table)
            payload.token,
            payload.opco_oui,
            payload.nom_opco,
            payload.facturation_cible,
            json_brut
        )
    )
    return id_prep

def insert_stagiaire(cur, id_prep: str, s: StagiaireInput) -> None:
    """
    Insère 1 ligne par stagiaire dans tbl_temp_preparation_formation_stagiaire
    """
    id_stag = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO public.tbl_temp_preparation_formation_stagiaire
        (id_prep_stagiaire, id_preparation_formation, civilite, nom, prenom, role, email, date_creation, date_modif)
        VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
        """,
        (
            id_stag,
            id_prep,
            s.civilite,
            s.nom,
            s.prenom,
            s.role,
            s.email
        )
    )

# -----------------------------
# Endpoints utilitaires
# -----------------------------
@app.get("/ping")
def ping():
    return {"status": "ok", "time": datetime.utcnow().isoformat() + "Z"}

@app.get("/db-ping")
def db_ping():
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("select 1 as ok;")
                row = cur.fetchone()
        return {"db": "ok", "result": int(row["ok"])}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur DB-ping: {e}")


@app.get("/debug-host")
def debug_host():
    try:
        return {
            "DB_HOST": DB_HOST,
            "repr": repr(DB_HOST),
            "ip": socket.gethostbyname(DB_HOST)
        }
    except Exception as e:
        return {"DB_HOST": DB_HOST, "repr": repr(DB_HOST), "error": str(e)}

# -----------------------------
# Endpoint principal /preparation
# -----------------------------
@app.post("/preparation")
def submit_preparation(payload: PreparationInput):
    """
    Reçoit le JSON du formulaire client et écrit :
      - 1 ligne dans tbl_temp_preparation_formation
      - N lignes dans tbl_temp_preparation_formation_stagiaire
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Enregistrer la "mère"
                id_prep = insert_preparation(cur, payload)

                # 2) Enregistrer les stagiaires (si présents)
                for s in payload.stagiaires:
                    insert_stagiaire(cur, id_prep, s)

            # psycopg v3: with-conn commit auto si pas d'exception
        return {"ok": True, "id_preparation_formation": id_prep}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur: {e}")


# -----------------------------
# Swagger: http://localhost:8000/docs
# -----------------------------
