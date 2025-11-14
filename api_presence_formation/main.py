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
        "null"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Modèles
# -----------------------------
NomStr = Annotated[str, Field(min_length=1)]
PrenomStr = Annotated[str, Field(min_length=1)]
IdEntStr = Optional[str]
IdAFStr = Annotated[str, Field(min_length=5)]
IdAFEstr = Annotated[str, Field(min_length=10)]

class IdentificationInput(BaseModel):
    nom: NomStr
    prenom: PrenomStr
    id_ent: IdEntStr = None

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
# Helpers SQL
# -----------------------------

def get_action_formation_info(cur, id_af: str):
    """
    Récupère toutes les infos formation:
    - code_action_formation
    - titre
    - modalite
    - dates (début/fin via blocs)
    - consultant
    """
    sql = """
    SELECT
        af.code_action_formation,
        ff.titre,
        af.modalite_valide,
        c.prenom,
        c.nom
    FROM public.tbl_action_formation af
    JOIN public.tbl_fiche_formation ff ON ff.id_form = af.id_form
    LEFT JOIN public.tbl_consultant c ON c.id_consultant = af.id_consultant
    WHERE af.id_action_formation = %s
    """
    cur.execute(sql, (id_af,))
    base = cur.fetchone()
    if not base:
        raise HTTPException(status_code=404, detail="Action de formation introuvable.")

    # Dates via blocs
    cur.execute("""
        SELECT 
            MIN(date_debut) AS date_debut,
            MAX(date_fin) AS date_fin
        FROM public.tbl_action_formation_blocs_peda
        WHERE id_action_formation = %s
    """, (id_af,))
    d = cur.fetchone()

    return {
        "code_action": base["code_action_formation"],
        "titre": base["titre"],
        "modalite": base["modalite_valide"],
        "consultant": f"{base['prenom']} {base['nom']}".strip(),
        "date_debut": d["date_debut"],
        "date_fin": d["date_fin"]
    }


def find_participants(cur, id_af, nom, prenom):
    sql = """
    SELECT 
        afe.id_action_formation_effectif,
        ent.id_ent,
        ent.nom_ent
    FROM public.tbl_action_formation_effectif afe
    JOIN public.tbl_effectif_client eff ON eff.id_effectif = afe.id_effectif
    JOIN public.tbl_entreprise ent ON ent.id_ent = eff.id_ent
    WHERE afe.id_action_formation = %s
      AND eff.nom_effectif ILIKE %s
      AND eff.prenom_effectif ILIKE %s
      AND afe.archive = FALSE
    """
    cur.execute(sql, (id_af, nom, prenom))
    return cur.fetchall()


def resolve_homonyme(cur, id_af, nom, prenom, id_ent):
    sql = """
    SELECT 
        afe.id_action_formation_effectif
    FROM public.tbl_action_formation_effectif afe
    JOIN public.tbl_effectif_client eff ON eff.id_effectif = afe.id_effectif
    WHERE afe.id_action_formation = %s
      AND eff.nom_effectif ILIKE %s
      AND eff.prenom_effectif ILIKE %s
      AND eff.id_ent = %s
      AND afe.archive = FALSE
    """
    cur.execute(sql, (id_af, nom, prenom, id_ent))
    return cur.fetchone()


def check_duplicate(cur, id_afe, periode):
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


def insert_presence(cur, payload, ip, ua, periode):
    id_presence = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO public.tbl_action_formation_presence
        (id_action_formation_presence, id_action_formation_effectif,
         date_presence, periode, heure_presence, datetime_utc,
         ip_client, user_agent, source_validation,
         nom_saisi, prenom_saisi)
        VALUES (%s, %s, CURRENT_DATE, %s, CURRENT_TIME,
                NOW(), %s, %s, 'stagiaire',
                %s, %s)
    """, (
        id_presence,
        payload.id_action_formation_effectif,
        periode,
        ip,
        ua,
        payload.nom_saisi,
        payload.prenom_saisi
    ))
    return id_presence


# -----------------------------
# Endpoints
# -----------------------------
@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/presence/init")
def init_presence(id_action_formation: IdAFStr):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                info = get_action_formation_info(cur, id_action_formation)
                return {"ok": True, "formation": info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presence/check")
def check_participant(
    id_action_formation: IdAFStr,
    payload: IdentificationInput
):
    save_cache("check_in", payload.model_dump())

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                results = find_participants(
                    cur,
                    id_action_formation,
                    payload.nom,
                    payload.prenom
                )

                if not results:
                    raise HTTPException(status_code=404, detail="Participant introuvable.")

                # Un seul résultat -> OK
                if len(results) == 1:
                    return {
                        "ok": True,
                        "id_action_formation_effectif": results[0]["id_action_formation_effectif"],
                        "entreprise": results[0]["nom_ent"]
                    }

                # Plusieurs résultats -> besoin de l'entreprise
                if not payload.id_ent:
                    entreprises = [
                        {"id_ent": r["id_ent"], "nom_ent": r["nom_ent"]}
                        for r in results
                    ]
                    return {
                        "ok": False,
                        "ambiguous": True,
                        "entreprises": entreprises
                    }

                # Résolution finale via entreprise
                resolved = resolve_homonyme(
                    cur,
                    id_action_formation,
                    payload.nom,
                    payload.prenom,
                    payload.id_ent
                )

                if not resolved:
                    raise HTTPException(status_code=404, detail="Aucun participant ne correspond à cette entreprise.")

                return {
                    "ok": True,
                    "id_action_formation_effectif": resolved["id_action_formation_effectif"]
                }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/presence/validate")
def validate_presence(payload: PresenceInput, request: Request):
    save_cache("validate_in", payload.model_dump())

    ip_client = request.client.host
    user_agent = request.headers.get("User-Agent", "")

    # Période
    periode = "matin" if datetime.now().hour < 13 else "apres_midi"

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                if check_duplicate(cur, payload.id_action_formation_effectif, periode):
                    raise HTTPException(status_code=409, detail="Présence déjà validée pour cette période.")

                id_p = insert_presence(
                    cur,
                    payload,
                    ip_client,
                    user_agent,
                    periode
                )
                conn.commit()

                return {"ok": True, "id_presence": id_p}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
