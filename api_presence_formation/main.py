from fastapi import FastAPI, HTTPException, Request
from datetime import datetime
from typing import Optional, Annotated, List
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
        "null"
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
IdEntStr = Optional[str]
IdActionFormationStr = Optional[str]
IdAFEstr = Annotated[str, Field(min_length=10)]

class IdentificationInput(BaseModel):
    nom: NomStr
    prenom: PrenomStr
    id_action_formation: IdActionFormationStr = None
    id_ent: IdEntStr = None   # utilisé en cas d’ambiguïté

class PresenceInput(BaseModel):
    id_action_formation_effectif: IdAFEstr
    nom_saisi: NomStr
    prenom_saisi: PrenomStr


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
# SQL HELPERS
# -----------------------------

def find_participant(cur, nom: str, prenom: str, id_action_formation: Optional[str]):
    """
    Recherche initiale: nom + prenom + (option action)
    """
    sql = """
    SELECT efe.id_action_formation_effectif,
           eff.id_ent,
           ent.nom_ent
    FROM public.tbl_action_formation_effectif efe
    JOIN public.tbl_effectif eff ON eff.id_effectif = efe.id_effectif
    JOIN public.tbl_entreprise ent ON ent.id_ent = eff.id_ent
    WHERE eff.nom ILIKE %s
      AND eff.prenom ILIKE %s
      AND efe.archive = FALSE
    """
    params = [nom, prenom]

    if id_action_formation:
        sql += " AND efe.id_action_formation = %s"
        params.append(id_action_formation)

    cur.execute(sql, params)
    return cur.fetchall()


def find_participant_with_company(cur, nom: str, prenom: str, id_ent: str, id_af: Optional[str]):
    """
    Recherche finale quand plusieurs homonymes → filtre entreprise.
    """
    sql = """
    SELECT efe.id_action_formation_effectif
    FROM public.tbl_action_formation_effectif efe
    JOIN public.tbl_effectif eff ON eff.id_effectif = efe.id_effectif
    WHERE eff.nom ILIKE %s
      AND eff.prenom ILIKE %s
      AND eff.id_ent = %s
      AND efe.archive = FALSE
    """
    params = [nom, prenom, id_ent]

    if id_af:
        sql += " AND efe.id_action_formation = %s"
        params.append(id_af)

    cur.execute(sql, params)
    return cur.fetchone()


def check_duplicate(cur, id_afe: str, periode: str):
    """
    1 seule présence par période / par jour.
    """
    sql = """
    SELECT COUNT(*) AS count
    FROM public.tbl_action_formation_presence
    WHERE id_action_formation_effectif = %s
      AND date_presence = CURRENT_DATE
      AND periode = %s
      AND archive = FALSE
    """
    cur.execute(sql, (id_afe, periode))
    r = cur.fetchone()
    return r["count"] > 0


def insert_presence(cur, p: PresenceInput, ip_client: str, user_agent: str, periode: str):
    """
    Insertion propre.
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
        periode,
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

                # Étape 1 : recherche initiale
                results = find_participant(
                    cur,
                    payload.nom,
                    payload.prenom,
                    payload.id_action_formation
                )

                if not results:
                    raise HTTPException(status_code=404, detail="Participant introuvable.")

                # Un seul résultat → OK
                if len(results) == 1:
                    return {
                        "ok": True,
                        "id_action_formation_effectif": results[0]["id_action_formation_effectif"]
                    }

                # Plusieurs résultats → demander entreprise
                if not payload.id_ent:
                    entreprises = [
                        {
                            "id_ent": r["id_ent"],
                            "nom_ent": r["nom_ent"]
                        }
                        for r in results
                    ]
                    return {
                        "ok": False,
                        "ambiguous": True,
                        "entreprises": entreprises
                    }

                # Étape 2 : résolution via id_ent
                res = find_participant_with_company(
                    cur,
                    payload.nom,
                    payload.prenom,
                    payload.id_ent,
                    payload.id_action_formation
                )

                if not res:
                    raise HTTPException(status_code=404, detail="Aucun participant ne correspond à cette entreprise.")

                return {"ok": True, "id_action_formation_effectif": res["id_action_formation_effectif"]}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presence/validate")
def validate_presence(payload: PresenceInput, request: Request):
    save_cache("validate_in", payload.model_dump())

    ip_client = request.client.host
    user_agent = request.headers.get("User-Agent", "")

    # Détermination automatique de la période
    heure = datetime.now().hour
    periode = "matin" if heure < 13 else "apres_midi"

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # Anti-doublon
                if check_duplicate(cur, payload.id_action_formation_effectif, periode):
                    raise HTTPException(status_code=409, detail="Présence déjà enregistrée pour cette période.")

                # Insertion
                id_presence = insert_presence(
                    cur,
                    payload,
                    ip_client,
                    user_agent,
                    periode
                )

                conn.commit()
                return {"ok": True, "id_presence": id_presence}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
