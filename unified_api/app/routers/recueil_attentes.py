from fastapi import APIRouter, HTTPException
from datetime import datetime
from typing import List, Optional, Annotated
from pydantic import BaseModel, Field
import os
import json
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

# -----------------------------
# Chargement variables env
# (déjà chargées dans main via python-dotenv)
# -----------------------------
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

router = APIRouter()

# -----------------------------
# Modèles d'entrée
# -----------------------------
IdPrerequisStr = Annotated[str, Field(min_length=5)]
ReponseStr    = Annotated[str, Field(min_length=1)]
IdEffectifStr = Annotated[str, Field(min_length=10)]

class AutoEvalInput(BaseModel):
    id_prerequis: IdPrerequisStr
    reponse: ReponseStr

class RecueilInput(BaseModel):
    id_action_formation_effectif: IdEffectifStr
    attentes: Optional[str] = None
    json_reponses: List[AutoEvalInput] = Field(default_factory=list)

# -----------------------------
# Helpers DB
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
# Insert logique
# -----------------------------
def insert_recueil_attentes(cur, payload: RecueilInput) -> str:
    id_recueil = str(uuid.uuid4())

    cur.execute("""
    SELECT COUNT(*) AS count
    FROM public.tbl_action_formation_recueil_attentes
    WHERE id_action_formation_effectif = %s
    """, (payload.id_action_formation_effectif,))
    result = cur.fetchone()
    if result and result["count"] > 0:
        raise Exception("Un recueil d'attentes a déjà été enregistré pour ce participant.")

    json_reponses = json.dumps(
        [r.model_dump() for r in payload.json_reponses],
        ensure_ascii=False
    )

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

    # maj fe
    cur.execute("""
    UPDATE public.tbl_action_formation_effectif
    SET date_retour_attentes = NOW(),
        etat_attentes = 'Reçu'
    WHERE id_action_formation_effectif = %s
      AND archive = FALSE;
    """, (payload.id_action_formation_effectif,))

    return id_recueil

# -----------------------------
# Cache local
# -----------------------------
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

def save_cache(payload: RecueilInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"recueil_attentes_{payload.id_action_formation_effectif}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.model_dump(), f, ensure_ascii=False, indent=2)

# -----------------------------
# Endpoints
# -----------------------------
@router.get("/healthz")
def healthz():
    return {"status": "ok"}

@router.post("")
def submit_recueil(payload: RecueilInput):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_recueil = insert_recueil_attentes(cur, payload)
                conn.commit()
                save_cache(payload)
                return {"ok": True, "id_recueil_attentes": id_recueil}

    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="Un recueil existe déjà pour ce participant.")

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {str(e)}")
