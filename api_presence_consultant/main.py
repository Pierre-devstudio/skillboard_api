from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional
import os
import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
import uuid
import smtplib
from email.mime.text import MIMEText

# ==========================================================
# Chargement .env
# ==========================================================
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

EMAIL_HOST = os.getenv("EMAIL_HOST")
EMAIL_PORT = os.getenv("EMAIL_PORT")
EMAIL_USER = os.getenv("EMAIL_USER")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")

# ==========================================================
# APP
# ==========================================================
app = FastAPI(title="Skillboard - API Présence Consultant")

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

# ==========================================================
# DB Helper
# ==========================================================
def _missing_env():
    return [k for k, v in {
        "DB_HOST": DB_HOST,
        "DB_NAME": DB_NAME,
        "DB_USER": DB_USER,
        "DB_PASSWORD": DB_PASSWORD
    }.items() if not v]

def get_conn():
    missing = _missing_env()
    if missing:
        raise HTTPException(500, detail=f"Variables manquantes: {missing}")

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
        raise HTTPException(500, detail=str(e))

# ==========================================================
# MODELES
# ==========================================================
class ValidationConsultantInput(BaseModel):
    id_action_formation: str = Field(min_length=5)
    id_consultant: str = Field(min_length=5)
    absents: list[str] = []
    commentaire: Optional[str] = None


# ==========================================================
# HEALTHCHECK
# ==========================================================
@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# ==========================================================
# HELPERS MAIL
# ==========================================================
def envoyer_mail_absents(id_action_formation: str, liste_absents: list[str]):
    if not EMAIL_HOST:
        return  # SMTP non configuré

    corps = "Liste des absents :\n\n" + "\n".join(liste_absents)

    msg = MIMEText(corps)
    msg["Subject"] = f"Absences formation ACF : {id_action_formation}"
    msg["From"] = EMAIL_USER
    msg["To"] = "formation@jmbconsultant.fr"

    try:
        with smtplib.SMTP_SSL(EMAIL_HOST, EMAIL_PORT) as smtp:
            smtp.login(EMAIL_USER, EMAIL_PASSWORD)
            smtp.send_message(msg)
    except Exception:
        pass  # on ne bloque jamais la validation consultant pour un mail


# ==========================================================
# ENDPOINT : init → liste stagiaires + statut
# ==========================================================
@app.get("/presence_consultant/init")
def init_consultant(id_action_formation: str):
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # Infos ACF
            cur.execute("""
                SELECT 
                    af.code_action_formation,
                    ff.titre,
                    c.prenom AS prenom_consultant,
                    c.nom AS nom_consultant
                FROM tbl_action_formation af
                JOIN tbl_fiche_formation ff ON ff.id_form = af.id_form
                LEFT JOIN tbl_consultant c ON c.id_consultant = af.id_consultant
                WHERE af.id_action_formation = %s
            """, (id_action_formation,))
            info = cur.fetchone()

            if not info:
                raise HTTPException(404, "Action de formation introuvable")

            # Stagiaires
            cur.execute("""
                SELECT 
                    afe.id_action_formation_effectif,
                    eff.nom_effectif,
                    eff.prenom_effectif,
                    ent.nom_ent
                FROM tbl_action_formation_effectif afe
                JOIN tbl_effectif_client eff ON eff.id_effectif = afe.id_effectif
                JOIN tbl_entreprise ent ON ent.id_ent = eff.id_ent
                WHERE afe.id_action_formation = %s
                  AND afe.archive = FALSE
            """, (id_action_formation,))
            stagiaires = cur.fetchall()

            # Présences des stagiaires (uniquement stagiaires)
            cur.execute("""
                SELECT id_action_formation_effectif
                FROM tbl_action_formation_presence
                WHERE id_action_formation = %s
                  AND source_validation = 'stagiaire'
                  AND archive = FALSE
            """, (id_action_formation,))
            presences = {row["id_action_formation_effectif"] for row in cur.fetchall()}

            # Formatage
            liste = []
            for s in stagiaires:
                liste.append({
                    "id_afe": s["id_action_formation_effectif"],
                    "nom": s["nom_effectif"],
                    "prenom": s["prenom_effectif"],
                    "entreprise": s["nom_ent"],
                    "present": s["id_action_formation_effectif"] in presences
                })

            return {
                "ok": True,
                "formation": info,
                "stagiaires": liste
            }


# ==========================================================
# ENDPOINT : validation consultant
# ==========================================================
@app.post("/presence_consultant/validate")
def validate_consultant(payload: ValidationConsultantInput, request: Request):

    ip_client = request.client.host
    user_agent = request.headers.get("User-Agent", "")

    periode = "matin" if datetime.now().hour < 13 else "apres_midi"
    id_presence = str(uuid.uuid4())

    with get_conn() as conn:
        with conn.cursor() as cur:

            # Enregistrement de la présence consultant
            cur.execute("""
                INSERT INTO tbl_action_formation_presence
                (id_action_formation_presence,
                 id_action_formation,
                 id_consultant,
                 date_presence,
                 periode,
                 heure_presence,
                 datetime_utc,
                 ip_client,
                 user_agent,
                 source_validation)
                VALUES (%s, %s, %s, CURRENT_DATE, %s, CURRENT_TIME, NOW(),
                        %s, %s, 'consultant')
            """, (
                id_presence,
                payload.id_action_formation,
                payload.id_consultant,
                periode,
                ip_client,
                user_agent
            ))

            conn.commit()

    # Mail absents si besoin
    if payload.absents:
        envoyer_mail_absents(payload.id_action_formation, payload.absents)

    return {"ok": True, "id_presence": id_presence}
