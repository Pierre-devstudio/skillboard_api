from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from pydantic import BaseModel, Field
import psycopg
from psycopg.rows import dict_row
import os
import uuid
from pathlib import Path
from dotenv import load_dotenv

# ---------------------------------------------------
# Chargement .env
# ---------------------------------------------------
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

# ---------------------------------------------------
# Init FastAPI
# ---------------------------------------------------
app = FastAPI(title="Skillboard - Présence Consultant API")

# ---------------------------------------------------
# CORS
# ---------------------------------------------------
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

# ---------------------------------------------------
# Connexion DB
# ---------------------------------------------------
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

# ---------------------------------------------------
# MODELES
# ---------------------------------------------------
class ConsultantValidationInput(BaseModel):
    id_action_formation: str = Field(min_length=5)
    nom_saisi: str
    prenom_saisi: str


# ---------------------------------------------------
# HEALTHCHECK
# ---------------------------------------------------
@app.get("/healthz")
def health():
    return {"status": "ok"}


# ---------------------------------------------------
# INIT : charger infos formation + stagiaires + présence
# ---------------------------------------------------
@app.get("/presence_consultant/init")
def presence_consultant_init(id_action_formation: str):

    periode = "matin" if datetime.now().hour < 13 else "apres_midi"

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # ------- 1. Infos action -------
                cur.execute("""
                    SELECT 
                        af.code_action_formation,
                        ff.titre,
                        af.modalite_valide,
                        c.prenom AS prenom_consultant,
                        c.nom AS nom_consultant,
                        af.id_consultant
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff ON ff.id_form = af.id_form
                    LEFT JOIN public.tbl_consultant c ON c.id_consultant = af.id_consultant
                    WHERE af.id_action_formation = %s
                """, (id_action_formation,))
                info = cur.fetchone()

                if not info:
                    raise HTTPException(status_code=404, detail="Action introuvable.")

                # ------- 2. Liste stagiaires -------
                cur.execute("""
                    SELECT 
                        afe.id_action_formation_effectif,
                        eff.nom_effectif AS nom,
                        eff.prenom_effectif AS prenom,
                        ent.nom_ent AS entreprise,
                        (
                            SELECT COUNT(*)
                            FROM public.tbl_action_formation_presence p
                            WHERE p.id_action_formation_effectif = afe.id_action_formation_effectif
                            AND p.date_presence = CURRENT_DATE
                            AND p.periode = %s
                            AND p.archive = FALSE
                        ) > 0 AS present
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_effectif_client eff ON eff.id_effectif = afe.id_effectif
                    JOIN public.tbl_entreprise ent ON ent.id_ent = eff.id_ent
                    WHERE afe.id_action_formation = %s
                    AND afe.archive = FALSE
                    ORDER BY eff.nom_effectif, eff.prenom_effectif
                """, (periode, id_action_formation))
                stagiaires = cur.fetchall()

                # ------- 3. Consultant déjà signé ? -------
                cur.execute("""
                    SELECT COUNT(*) AS deja_signe
                    FROM public.tbl_action_formation_presence
                    WHERE id_action_formation = %s
                    AND id_action_formation_effectif IS NULL
                    AND source_validation = 'consultant'
                    AND date_presence = CURRENT_DATE
                    AND periode = %s
                    AND archive = FALSE
                """, (id_action_formation, periode))
                deja_signe = cur.fetchone()["deja_signe"] > 0

                return {
                    "ok": True,
                    "periode": periode,
                    "formation": info,
                    "stagiaires": stagiaires,
                    "consultant_deja_signe": deja_signe
                }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------
# VALIDATION CONSULTANT
# ---------------------------------------------------
@app.post("/presence_consultant/validate")
def validate_consultant(payload: ConsultantValidationInput, request: Request):

    periode = "matin" if datetime.now().hour < 13 else "apres_midi"

    ip_client = request.client.host
    user_agent = request.headers.get("User-Agent", "")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # Déjà signé ?
                cur.execute("""
                    SELECT COUNT(*) AS deja_signe
                    FROM public.tbl_action_formation_presence
                    WHERE id_action_formation = %s
                    AND id_action_formation_effectif IS NULL
                    AND source_validation = 'consultant'
                    AND date_presence = CURRENT_DATE
                    AND periode = %s
                    AND archive = FALSE
                """, (payload.id_action_formation, periode))

                if cur.fetchone()["deja_signe"] > 0:
                    raise HTTPException(status_code=409, detail="Signature déjà enregistrée.")

                # Insertion
                id_presence = str(uuid.uuid4())

                cur.execute("""
                    INSERT INTO public.tbl_action_formation_presence
                    (id_action_formation_presence,
                     id_action_formation,
                     id_action_formation_effectif,
                     date_presence,
                     periode,
                     heure_presence,
                     datetime_utc,
                     ip_client,
                     user_agent,
                     source_validation,
                     nom_saisi,
                     prenom_saisi)
                    VALUES (%s, %s, NULL,
                            CURRENT_DATE, %s, CURRENT_TIME, NOW(),
                            %s, %s, 'consultant',
                            %s, %s)
                """, (
                    id_presence,
                    payload.id_action_formation,
                    periode,
                    ip_client,
                    user_agent,
                    payload.nom_saisi,
                    payload.prenom_saisi
                ))

                conn.commit()

                return {"ok": True, "id_presence": id_presence}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
