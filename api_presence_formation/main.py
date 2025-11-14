from fastapi import FastAPI, HTTPException, Request
from datetime import datetime
from typing import Optional, Annotated
from pydantic import BaseModel, Field
import os
import json
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

# -----------------------------
# Chargement variables .env
# -----------------------------
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

app = FastAPI(title="Skillboard - Présence Formation API")

# -----------------------------
# CORS autorisé
# -----------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://forms.jmbconsultant.fr",
        "http://localhost",
        "http://127.0.0.1:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Modèles d'entrée
# -----------------------------
NomStr = Annotated[str, Field(min_length=1)]
PrenomStr = Annotated[str, Field(min_length=1)]
IdActionFormationEffectifStr = Annotated[str, Field(min_length=10)]

class IdentificationInput(BaseModel):
    nom: NomStr
    prenom: PrenomStr
    id_action_formation: Optional[str] = None  # fourni via QR code si besoin

class PresenceInput(BaseModel):
    id_action_formation_effectif: IdActionFormationEffectifStr
    periode: str            # "matin" ou "apres_midi"
    nom_saisi: str
    prenom_saisi: str

# -----------------------------
# Connexion DB
# -----------------------------
def _missing_env():
    return [k for k, v in {
        "DB_HOST": DB_HOST,
        "DB_PORT": DB_PORT,
        "DB_NAME": DB_NAME,
        "DB_USER": DB_USER,
        "DB_PASSWORD": DB_PASSWORD,
    }.items() if not v]

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
            sslmode="require"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur connexion DB: {e}")

# -----------------------------
# Cache debug
# -----------------------------
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

def save_cache(name: str, payload: dict):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"{name}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

# -----------------------------
# SQL HELPERS (VIDES ORIENTÉS)
# -----------------------------

def find_participant(cur, nom: str, prenom: str, id_action_formation: Optional[str]):
    """
    Recherche dans tbl_action_formation_effectif
    si le stagiaire existe (nom + prenom + id_action_formation)
    """
    sql = """
    SELECT id_action_formation_effectif
    FROM public.tbl_action_formation_effectif efe
    JOIN public.tbl_effectif eff ON eff.id_effectif = efe.id_effectif
    WHERE eff.nom ILIKE %s
      AND eff.prenom ILIKE %s
      AND efe.archive = FALSE
    """
    params = [nom, prenom]

    if id_action_formation:
        sql += " AND efe.id_action_formation = %s"
        params.append(id_action_formation)

    cur.execute(sql, params)
    return cur.fetchone()


def insert_presence(cur, p: PresenceInput, ip_client: str, user_agent: str):
    """
    Enregistre dans tbl_action_formation_presence
    """
    id_presence = str(uuid.uuid4())

    cur.execute("""
        INSERT INTO public.tbl_action_formation_presence
        (id_action_formation_presence, id_action_formation_effectif,
         date_presence, periode, heure_presence, datetime_utc,
         ip_client, user_agent, source_validation,
         nom_saisi, prenom_saisi)
        VALUES (%s, %s, CURRENT_DATE, %s, CURRENT_TIME,
                NOW(), %s, %s, 'stagiaire', %s, %s)
    """,
    (
        id_presence,
        p.id_action_formation_effectif,
        p.periode,
        ip_client,
        user_agent,
        p.nom_saisi,
        p.prenom_saisi
    ))

    return id_presence

# -----------------------------
# Endpoints
# -----------------------------

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.post("/presence/check")
def check_participant(payload: IdentificationInput):
    save_cache("check_in", payload.model_dump())

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                result = find_participant(
                    cur,
                    payload.nom,
                    payload.prenom,
                    payload.id_action_formation
                )

                if not result:
                    raise HTTPException(status_code=404, detail="Participant introuvable.")

                return {"ok": True, "id_action_formation_effectif": result["id_action_formation_effectif"]}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presence/validate")
def validate_presence(payload: PresenceInput, request: Request):
    payload_dict = payload.model_dump()
    save_cache("validate_in", payload_dict)

    ip_client = request.client.host
    user_agent = request.headers.get("User-Agent", "")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_presence = insert_presence(cur, payload, ip_client, user_agent)
                conn.commit()
                return {"ok": True, "id_presence": id_presence}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
