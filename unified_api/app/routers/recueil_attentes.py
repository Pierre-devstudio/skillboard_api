from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from typing import List, Optional, Annotated
from pydantic import BaseModel, Field
import os
import json
import uuid
from pathlib import Path

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
app_local = FastAPI(title="Skillboard - Recueil Attentes API")

# CORS local (au cas où), le global dans main.py s’applique aussi
app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://forms.jmbconsultant.fr",
        "https://skillboard-services.onrender.com",
        "https://skillboard-attentes-formation.onrender.com",
        "http://localhost",
        "http://127.0.0.1:5500",
        "null",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ======================================================
# Modèles d'entrée
# ======================================================
IdPrerequisStr = Annotated[str, Field(min_length=5)]
ReponseStr = Annotated[str, Field(min_length=1)]
IdEffectifStr = Annotated[str, Field(min_length=10)]


class AutoEvalInput(BaseModel):
    id_prerequis: IdPrerequisStr
    reponse: ReponseStr


class RecueilInput(BaseModel):
    id_action_formation_effectif: IdEffectifStr
    attentes: Optional[str] = None
    json_reponses: List[AutoEvalInput] = Field(default_factory=list)


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
# Helpers SQL
# ======================================================
def insert_recueil_attentes(cur, payload: RecueilInput) -> str:
    """
    Enregistre un recueil d'attentes + autoévaluation.
    Retourne l'id_recueil_attentes (UUID TEXT).
    """
    id_recueil = str(uuid.uuid4())

    # Vérifier si le participant a déjà répondu
    cur.execute(
        """
        SELECT COUNT(*) AS count
        FROM public.tbl_action_formation_recueil_attentes
        WHERE id_action_formation_effectif = %s
        """,
        (payload.id_action_formation_effectif,),
    )
    result = cur.fetchone()
    if result and result["count"] > 0:
        # Conflit fonctionnel => 409
        raise HTTPException(
            status_code=409,
            detail="Un recueil d'attentes a déjà été enregistré pour ce participant.",
        )

    # Conversion pour Pydantic v2
    json_reponses = json.dumps(
        [r if isinstance(r, dict) else r.model_dump() for r in payload.json_reponses],
        ensure_ascii=False,
    )

    cur.execute(
        """
        INSERT INTO public.tbl_action_formation_recueil_attentes
        (id_recueil_attentes,
         id_action_formation_effectif,
         attentes,
         json_reponses,
         date_creation,
         date_modif)
        VALUES (%s, %s, %s, %s, NOW(), NOW())
        """,
        (
            id_recueil,
            payload.id_action_formation_effectif,
            payload.attentes,
            json_reponses,
        ),
    )

    # Mise à jour de la tbl_action_formation_effectif
    cur.execute(
        """
        UPDATE public.tbl_action_formation_effectif
        SET date_retour_attentes = NOW(),
            etat_attentes = 'Reçu'
        WHERE id_action_formation_effectif = %s
          AND archive = FALSE;
        """,
        (payload.id_action_formation_effectif,),
    )

    return id_recueil


# ======================================================
# Cache local (debug / audit)
# ======================================================
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def save_cache(payload: RecueilInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"recueil_attentes_{payload.id_action_formation_effectif}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.model_dump(), f, ensure_ascii=False, indent=2)


# ======================================================
# Endpoints
# ======================================================
@app_local.api_route("/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.post("/recueil_attentes")
def submit_recueil(payload: RecueilInput):
    """
    Reçoit le JSON du formulaire Recueil Attentes
    et enregistre dans tbl_action_formation_recueil_attentes.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_recueil = insert_recueil_attentes(cur, payload)
                conn.commit()
                save_cache(payload)

        return {"ok": True, "id_recueil_attentes": id_recueil}

    except HTTPException:
        # On laisse passer les 4xx explicites (ex : doublon)
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
