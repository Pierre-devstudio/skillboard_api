# skillboard_api/api_recueil_attentes/main.py
from fastapi import FastAPI, HTTPException
from datetime import datetime
from pydantic import BaseModel, constr, Field
from typing import List, Optional
import os
import json
import uuid
import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

# -----------------------------
# Chargement variables .env
# -----------------------------
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

app = FastAPI(title="Skillboard - Recueil Attentes API")

# -----------------------------
# CORS autorisé
# -----------------------------
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
# Modèles d'entrée
# -----------------------------
class AutoEvalInput(BaseModel):
    id_prerequis: constr(min_length=5)
    reponse: constr(min_length=1)

class RecueilInput(BaseModel):
    id_action_formation_effectif: constr(min_length=10)
    attentes: Optional[str] = None
    reponses: List[AutoEvalInput] = []

# -----------------------------
# Connexion DB
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
            sslmode="require"  # "disable" en local
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur connexion DB: {e}")

# -----------------------------
# Helpers SQL
# -----------------------------
def insert_recueil_attentes(cur, payload: RecueilInput) -> str:
    """
    Enregistre un recueil d'attentes + autoévaluation.
    Retourne l'id_recueil_attentes (UUID TEXT).
    """
    id_recueil = str(uuid.uuid4())
    json_reponses = json.dumps([r.dict() for r in payload.reponses], ensure_ascii=False)

    cur.execute("""
        INSERT INTO public.tbl_action_formation_recueil_attentes
        (id_recueil_attentes, id_action_formation_effectif, attentes, json_reponses, date_creation, date_modif)
        VALUES (%s, %s, %s, %s, NOW(), NOW())
    """, (
        id_recueil,
        payload.id_action_formation_effectif,
        payload.attentes,
        json_reponses
    ))
    return id_recueil

# -----------------------------
# Cache local (debug / audit)
# -----------------------------
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

def save_cache(payload: RecueilInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"recueil_attentes_{payload.id_action_formation_effectif}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.dict(), f, ensure_ascii=False, indent=2)

# -----------------------------
# Endpoints
# -----------------------------
@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.post("/recueil_attentes")
def submit_recueil(payload: RecueilInput):
    """
    Reçoit le JSON du formulaire Recueil Attentes
    et enregistre dans tbl_action_formation_recueil_attentes.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_recueil = insert_recueil_attentes(cur, payload)

            # commit automatique avec psycopg3 (context manager)
        save_cache(payload)
        return {"ok": True, "id_recueil_attentes": id_recueil}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur: {e}")

# -----------------------------
# Swagger: http://localhost:8000/docs
# ---------
