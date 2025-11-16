from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from pydantic import BaseModel
import psycopg
from psycopg.rows import dict_row
import os
import uuid
import json
from dotenv import load_dotenv
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ---------------------------------------------------
# ENV
# ---------------------------------------------------
load_dotenv()
DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
MAIL_ALERT_DEST = os.getenv("MAIL_ALERT_DEST")

def send_absent_mail(absents: list[str], code_form: str, titre_form: str):
    if not MAIL_ALERT_DEST:
        print("MAIL_ALERT_DEST non défini")
        return

    sujet = f"Gestion des absences - Formation {code_form}"

    texte = (
        f"{code_form} - {titre_form}\n\n"
        "Les stagiaires ci-dessous ont été déclarés absents par le consultant :\n"
        + "\n".join(absents) +
        "\n\nMerci de prendre contact avec les stagiaires et de démarrer la procédure de gestion des absences.\n"
    )

    msg = MIMEText(texte, "plain", "utf-8")
    msg["From"] = SMTP_USER
    msg["To"] = MAIL_ALERT_DEST
    msg["Subject"] = sujet

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(msg)
        print("Mail envoyé OK")

    except Exception as e:
        print("Erreur envoi mail :", str(e))




# ---------------------------------------------------
# FASTAPI
# ---------------------------------------------------
app = FastAPI(title="Skillboard - Présence Consultant API")

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
# DB
# ---------------------------------------------------
def get_conn():
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
        raise HTTPException(status_code=500, detail=str(e))

# ---------------------------------------------------
# MODELES
# ---------------------------------------------------
class ConsultantValidationInput(BaseModel):
    id_action_formation: str
    id_consultant: str
    nom_saisi: str
    prenom_saisi: str
    absents: list[str] = []

# ---------------------------------------------------
# HEALTH
# ---------------------------------------------------
@app.get("/healthz")
def health():
    return {"status": "ok"}

# ---------------------------------------------------
# INIT
# ---------------------------------------------------
@app.get("/presence_consultant/init")
def presence_consultant_init(id_action_formation: str):

    periode = "matin" if datetime.now().hour < 13 else "apres_midi"

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                # 1. Infos action
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

                # 2. Stagiaires
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

                # 3. Consultant déjà signé
                cur.execute("""
                    SELECT COUNT(*) AS deja_signe
                    FROM public.tbl_action_formation_presence
                    WHERE id_action_formation = %s
                    AND id_consultant = %s
                    AND source_validation = 'consultant'
                    AND date_presence = CURRENT_DATE
                    AND periode = %s
                    AND archive = FALSE
                """, (id_action_formation, info["id_consultant"], periode))
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
# VALIDATION
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
                    AND id_consultant = %s
                    AND source_validation = 'consultant'
                    AND date_presence = CURRENT_DATE
                    AND periode = %s
                    AND archive = FALSE
                """, (
                    payload.id_action_formation,
                    payload.id_consultant,
                    periode
                ))

                if cur.fetchone()["deja_signe"] > 0:
                    raise HTTPException(status_code=409, detail="Signature déjà enregistrée.")

                # Récupérer infos formation (code + titre)
                cur.execute("""
                    SELECT 
                        af.code_action_formation,
                        ff.titre
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff ON ff.id_form = af.id_form
                    WHERE af.id_action_formation = %s
                """, (payload.id_action_formation,))
                formation_info = cur.fetchone()

                code_form = formation_info["code_action_formation"]
                titre_form = formation_info["titre"]

                # Insertion
                id_presence = str(uuid.uuid4())

                cur.execute("""
                    INSERT INTO public.tbl_action_formation_presence
                    (id_action_formation_presence,
                     id_action_formation,
                     id_consultant,
                     id_action_formation_effectif,
                     date_presence,
                     periode,
                     heure_presence,
                     datetime_utc,
                     ip_client,
                     user_agent,
                     source_validation,
                     nom_saisi,
                     prenom_saisi,
                     absents_json)
                    VALUES (%s, %s, %s, NULL,
                            CURRENT_DATE, %s, CURRENT_TIME, NOW(),
                            %s, %s, 'consultant',
                            %s, %s, %s)
                """, (
                    id_presence,
                    payload.id_action_formation,
                    payload.id_consultant,
                    periode,
                    ip_client,
                    user_agent,
                    payload.nom_saisi,
                    payload.prenom_saisi,
                    json.dumps(payload.absents)
                ))

    # ----------------------------------------------------
    # Envoi du mail si absents
    # ----------------------------------------------------
        
            if payload.absents and len(payload.absents) > 0:
                try:
                    send_absent_mail(
                        absents=payload.absents,
                        code_form=code_form,
                        titre_form=titre_form
                    )
                except Exception as e:
                    print("Erreur envoi mail absents:", str(e))


            conn.commit()
            return {"ok": True, "id_presence": id_presence}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
