from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field
import os
import json
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

from app.routers.MailManager import send_satisfaction_consultant_mail
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
app_local = FastAPI(title="Skillboard - Satisfaction Consultant API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://forms.jmbconsultant.fr",
        "https://skillboard-services.onrender.com",
        "http://localhost",
        "http://127.0.0.1:5500",
        "null",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ======================================================
# Modèles Pydantic
# ======================================================


class SatisfactionConsultContextResponse(BaseModel):
    id_action_formation: str
    id_form: str
    id_consultant: str

    code_formation: Optional[str] = None
    titre_formation: str
    code_action_formation: Optional[str] = None

    civilite: Optional[str] = None
    nom: str
    prenom: str

    deja_repondu: bool


class BlocPreparation(BaseModel):
    q1: int = Field(ge=1, le=10)  # objectifs correctement définis
    q2: int = Field(ge=1, le=10)  # échanges avec stagiaires avant
    q3: int = Field(ge=1, le=10)  # infos suffisantes pour se préparer
    commentaire: Optional[str] = None


class BlocOrganisation(BaseModel):
    q1: int = Field(ge=1, le=10)  # conditions matérielles
    q2: int = Field(ge=1, le=10)  # stagiaires informés du déroulement
    q3: int = Field(ge=1, le=10)  # organisation répond aux attentes
    commentaire: Optional[str] = None


class BlocDeroulement(BaseModel):
    q1: int = Field(ge=1, le=10)          # vous avez apprécié animer
    commentaire_appreciation: Optional[str] = None
    adaptation_deroule: str               # "oui" / "non"
    fiches_adaptation_renseignees: Optional[str] = None  # "oui" / "non" si adaptation = oui
    commentaire_general: Optional[str] = None


class BlocBilan(BaseModel):
    q1: int = Field(ge=1, le=10)          # formation a atteint les objectifs
    q2: int = Field(ge=1, le=10)          # stagiaires semblaient apprécier
    q3: int = Field(ge=1, le=10)          # docs nécessaires pour conclure
    supports_laisses: str                 # "oui" / "non"
    supports_description: Optional[str] = None


class BlocCommentaires(BaseModel):
    difficulte_rencontree: str            # "oui" / "non"
    difficulte_texte: Optional[str] = None

    points_positifs: Optional[str] = None
    points_negatifs: Optional[str] = None

    appreciation_generale: int = Field(ge=1, le=10)  # 1 = mauvaise expérience

    suggestions: Optional[str] = None

    reclamation: str                       # "oui" / "non"
    reclamation_objet: Optional[str] = None
    reclamation_texte: Optional[str] = None


class SatisfactionConsultInput(BaseModel):
    id_action_formation: str
    preparation: BlocPreparation
    organisation: BlocOrganisation
    deroulement: BlocDeroulement
    bilan: BlocBilan
    commentaires: BlocCommentaires


class SatisfactionConsultSaveResponse(BaseModel):
    id_satisfaction_consultant: str
    mode: str   # "insert" ou "update"


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
# Cache local (debug / audit)
# ======================================================

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def save_cache(payload: SatisfactionConsultInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"satisfaction_consultant_{payload.id_action_formation}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.model_dump(), f, ensure_ascii=False, indent=2)


# ======================================================
# Helpers internes
# ======================================================

def _bool_from_oui_non(val: Optional[str]) -> Optional[bool]:
    if val is None:
        return None
    v = val.strip().lower()
    if v == "oui":
        return True
    if v == "non":
        return False
    return None


def _collect_notes_for_global(
    prepa: BlocPreparation,
    orga: BlocOrganisation,
    deroul: BlocDeroulement,
    bilan: BlocBilan,
    comm: BlocCommentaires,
) -> List[int]:
    notes: List[int] = []

    for v in (prepa.q1, prepa.q2, prepa.q3):
        if v is not None and 1 <= v <= 10:
            notes.append(v)

    for v in (orga.q1, orga.q2, orga.q3):
        if v is not None and 1 <= v <= 10:
            notes.append(v)

    if deroul.q1 is not None and 1 <= deroul.q1 <= 10:
        notes.append(deroul.q1)

    for v in (bilan.q1, bilan.q2, bilan.q3):
        if v is not None and 1 <= v <= 10:
            notes.append(v)

    if comm.appreciation_generale is not None and 1 <= comm.appreciation_generale <= 10:
        notes.append(comm.appreciation_generale)

    return notes


# ======================================================
# Endpoints
# ======================================================

@app_local.api_route("/satisfaction_consultant/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/satisfaction_consultant/context/{id_action_formation}",
    response_model=SatisfactionConsultContextResponse,
)
def get_satisfaction_consultant_context(id_action_formation: str):
    """
    Contexte pour l'affichage du formulaire Consultant :
    - consultant
    - formation
    - code action
    - déjà répondu ou non
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        af.id_action_formation,
                        af.id_form,
                        af.id_consultant,
                        af.code_action_formation,
                        ff.code AS code_formation,
                        ff.titre AS titre_formation,
                        c.civilite AS civilite_consultant,
                        c.prenom AS prenom_consultant,
                        c.nom AS nom_consultant
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_consultant c
                        ON c.id_consultant = af.id_consultant
                    WHERE af.id_action_formation = %s
                      AND af.archive = FALSE
                      AND ff.masque = FALSE
                    """,
                    (id_action_formation,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Action de formation introuvable",
                    )

                id_form = row["id_form"]
                id_consultant = row["id_consultant"]
                code_action_formation = row.get("code_action_formation")
                code_formation = row.get("code_formation") or row.get("code")
                titre_formation = row["titre_formation"]
                civilite = row.get("civilite_consultant")
                prenom = row["prenom_consultant"]
                nom = row["nom_consultant"]

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_action_formation_satisfaction_consultant s
                    WHERE s.id_action_formation = %s
                      AND s.archive = FALSE
                    """,
                    (id_action_formation,),
                )
                deja_repondu = cur.fetchone() is not None

                return SatisfactionConsultContextResponse(
                    id_action_formation=id_action_formation,
                    id_form=id_form,
                    id_consultant=id_consultant,
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    code_action_formation=code_action_formation,
                    civilite=civilite,
                    nom=nom,
                    prenom=prenom,
                    deja_repondu=deja_repondu,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post(
    "/satisfaction_consultant/save",
    response_model=SatisfactionConsultSaveResponse,
)
def save_satisfaction_consultant(payload: SatisfactionConsultInput):
    """
    Enregistre ou met à jour une satisfaction Consultant
    pour une action de formation donnée.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Récupérer infos action + form + consultant
                cur.execute(
                    """
                    SELECT
                        af.id_action_formation,
                        af.id_form,
                        af.id_consultant,
                        af.code_action_formation,
                        ff.code AS code_formation,
                        ff.titre AS titre_formation,
                        c.prenom AS prenom_consultant,
                        c.nom AS nom_consultant
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_consultant c
                        ON c.id_consultant = af.id_consultant
                    WHERE af.id_action_formation = %s
                      AND af.archive = FALSE
                      AND ff.masque = FALSE
                    """,
                    (payload.id_action_formation,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Action de formation introuvable pour cet identifiant",
                    )

                id_action_formation = row["id_action_formation"]
                id_form = row["id_form"]
                id_consultant = row["id_consultant"]
                code_action_formation = row.get("code_action_formation")
                code_formation = row.get("code_formation") or row.get("code")
                titre_formation = row["titre_formation"]
                prenom_consultant = row["prenom_consultant"]
                nom_consultant = row["nom_consultant"]

                # 2) Conversion / validations des champs oui/non
                adaptation_bool = _bool_from_oui_non(payload.deroulement.adaptation_deroule)
                fiches_bool = _bool_from_oui_non(payload.deroulement.fiches_adaptation_renseignees)
                supports_bool = _bool_from_oui_non(payload.bilan.supports_laisses)
                difficulte_bool = _bool_from_oui_non(payload.commentaires.difficulte_rencontree)
                reclamation_bool = _bool_from_oui_non(payload.commentaires.reclamation)

                # Adaptation déroulé => fiches obligatoires si oui
                if adaptation_bool:
                    if fiches_bool is None:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci d'indiquer si les fiches d'adaptation ont été renseignées.",
                        )
                else:
                    fiches_bool = None

                # Supports laissés => description obligatoire si oui
                supports_description = (payload.bilan.supports_description or "").strip()
                if supports_bool:
                    if not supports_description:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de préciser quels supports ont été laissés et sous quelle forme.",
                        )
                if not supports_bool:
                    supports_description = None

                # Difficultés rencontrées => texte obligatoire si oui
                difficulte_texte = (payload.commentaires.difficulte_texte or "").strip()
                if difficulte_bool:
                    if not difficulte_texte:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de préciser les difficultés ou aléas rencontrés.",
                        )
                if not difficulte_bool:
                    difficulte_texte = None

                # Réclamation => objet + texte obligatoires si oui
                reclamation_objet = (payload.commentaires.reclamation_objet or "").strip()
                reclamation_texte = (payload.commentaires.reclamation_texte or "").strip()
                if reclamation_bool:
                    if not reclamation_objet:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de préciser l'objet de votre réclamation.",
                        )
                    if not reclamation_texte:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de détailler votre réclamation.",
                        )
                if not reclamation_bool:
                    reclamation_objet = None
                    reclamation_texte = None

                # 3) Nettoyage des commentaires "facultatifs"
                commentaire_prepa = (payload.preparation.commentaire or "").strip() or None
                commentaire_orga = (payload.organisation.commentaire or "").strip() or None
                commentaire_appreciation = (payload.deroulement.commentaire_appreciation or "").strip() or None
                commentaire_deroul_general = (payload.deroulement.commentaire_general or "").strip() or None
                points_positifs = (payload.commentaires.points_positifs or "").strip() or None
                points_negatifs = (payload.commentaires.points_negatifs or "").strip() or None
                suggestions = (payload.commentaires.suggestions or "").strip() or None

                # 4) Calcul de la note globale
                notes = _collect_notes_for_global(
                    payload.preparation,
                    payload.organisation,
                    payload.deroulement,
                    payload.bilan,
                    payload.commentaires,
                )
                note_globale = None
                if notes:
                    note_globale = sum(notes) / float(len(notes))

                # 5) JSON complet
                reponses = {
                    "preparation": payload.preparation.model_dump(),
                    "organisation": payload.organisation.model_dump(),
                    "deroulement": {
                        "q1": payload.deroulement.q1,
                        "commentaire_appreciation": commentaire_appreciation,
                        "adaptation_deroule": payload.deroulement.adaptation_deroule,
                        "fiches_adaptation_renseignees": (
                            "oui" if fiches_bool else "non" if fiches_bool is not None else None
                        ),
                        "commentaire_general": commentaire_deroul_general,
                    },
                    "bilan": {
                        "q1": payload.bilan.q1,
                        "q2": payload.bilan.q2,
                        "q3": payload.bilan.q3,
                        "supports_laisses": (
                            "oui" if supports_bool else "non" if supports_bool is not None else None
                        ),
                        "supports_description": supports_description,
                    },
                    "commentaires": {
                        "difficulte_rencontree": (
                            "oui" if difficulte_bool else "non" if difficulte_bool is not None else None
                        ),
                        "difficulte_texte": difficulte_texte,
                        "points_positifs": points_positifs,
                        "points_negatifs": points_negatifs,
                        "appreciation_generale": payload.commentaires.appreciation_generale,
                        "suggestions": suggestions,
                        "reclamation": (
                            "oui" if reclamation_bool else "non" if reclamation_bool is not None else None
                        ),
                        "reclamation_objet": reclamation_objet,
                        "reclamation_texte": reclamation_texte,
                    },
                }
                reponses_json_str = json.dumps(reponses, ensure_ascii=False)

                # 6) Vérifier si une satisfaction existe déjà
                cur.execute(
                    """
                    SELECT id_satisfaction_consultant
                    FROM public.tbl_action_formation_satisfaction_consultant
                    WHERE id_action_formation = %s
                      AND archive = FALSE
                    """,
                    (id_action_formation,),
                )
                row_satis = cur.fetchone()

                if row_satis:
                    id_satis = row_satis["id_satisfaction_consultant"]
                    cur.execute(
                        """
                        UPDATE public.tbl_action_formation_satisfaction_consultant
                        SET
                            id_form = %s,
                            id_consultant = %s,
                            date_modif = NOW(),
                            note_prepa_q1 = %s,
                            note_prepa_q2 = %s,
                            note_prepa_q3 = %s,
                            commentaire_prepa = %s,
                            note_orga_q1 = %s,
                            note_orga_q2 = %s,
                            note_orga_q3 = %s,
                            commentaire_orga = %s,
                            note_deroul_q1 = %s,
                            commentaire_deroul_appreciation = %s,
                            adaptation_deroule = %s,
                            fiches_adaptation_renseignees = %s,
                            commentaire_deroul_general = %s,
                            note_bilan_q1 = %s,
                            note_bilan_q2 = %s,
                            note_bilan_q3 = %s,
                            supports_laisses = %s,
                            supports_description = %s,
                            difficulte_rencontree = %s,
                            difficulte_texte = %s,
                            points_positifs = %s,
                            points_negatifs = %s,
                            appreciation_generale = %s,
                            suggestions = %s,
                            reclamation = %s,
                            reclamation_objet = %s,
                            reclamation_texte = %s,
                            note_globale = %s,
                            reponses_json = %s
                        WHERE id_satisfaction_consultant = %s
                        """,
                        (
                            id_form,
                            id_consultant,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            commentaire_prepa,
                            payload.organisation.q1,
                            payload.organisation.q2,
                            payload.organisation.q3,
                            commentaire_orga,
                            payload.deroulement.q1,
                            commentaire_appreciation,
                            adaptation_bool,
                            fiches_bool,
                            commentaire_deroul_general,
                            payload.bilan.q1,
                            payload.bilan.q2,
                            payload.bilan.q3,
                            supports_bool,
                            supports_description,
                            difficulte_bool,
                            difficulte_texte,
                            points_positifs,
                            points_negatifs,
                            payload.commentaires.appreciation_generale,
                            suggestions,
                            reclamation_bool,
                            reclamation_objet,
                            reclamation_texte,
                            note_globale,
                            reponses_json_str,
                            id_satis,
                        ),
                    )
                    mode = "update"
                else:
                    id_satis = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_action_formation_satisfaction_consultant (
                            id_satisfaction_consultant,
                            id_action_formation,
                            id_form,
                            id_consultant,
                            date_reponse,
                            date_modif,
                            note_prepa_q1,
                            note_prepa_q2,
                            note_prepa_q3,
                            commentaire_prepa,
                            note_orga_q1,
                            note_orga_q2,
                            note_orga_q3,
                            commentaire_orga,
                            note_deroul_q1,
                            commentaire_deroul_appreciation,
                            adaptation_deroule,
                            fiches_adaptation_renseignees,
                            commentaire_deroul_general,
                            note_bilan_q1,
                            note_bilan_q2,
                            note_bilan_q3,
                            supports_laisses,
                            supports_description,
                            difficulte_rencontree,
                            difficulte_texte,
                            points_positifs,
                            points_negatifs,
                            appreciation_generale,
                            suggestions,
                            reclamation,
                            reclamation_objet,
                            reclamation_texte,
                            note_globale,
                            reponses_json,
                            archive
                        ) VALUES (
                            %s, %s, %s, %s,
                            NOW(), NOW(),
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            FALSE
                        )
                        """,
                        (
                            id_satis,
                            id_action_formation,
                            id_form,
                            id_consultant,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            commentaire_prepa,
                            payload.organisation.q1,
                            payload.organisation.q2,
                            payload.organisation.q3,
                            commentaire_orga,
                            payload.deroulement.q1,
                            commentaire_appreciation,
                            adaptation_bool,
                            fiches_bool,
                            commentaire_deroul_general,
                            payload.bilan.q1,
                            payload.bilan.q2,
                            payload.bilan.q3,
                            supports_bool,
                            supports_description,
                            difficulte_bool,
                            difficulte_texte,
                            points_positifs,
                            points_negatifs,
                            payload.commentaires.appreciation_generale,
                            suggestions,
                            reclamation_bool,
                            reclamation_objet,
                            reclamation_texte,
                            note_globale,
                            reponses_json_str,
                        ),
                    )
                    mode = "insert"

                conn.commit()
                save_cache(payload)

        # Envoi mail hors transaction
        send_satisfaction_consultant_mail(
            code_formation=code_formation,
            titre_formation=titre_formation,
            prenom=prenom_consultant,
            nom=nom_consultant,
            id_action_formation=id_action_formation,
            mode=mode,
            code_action_formation=code_action_formation,
        )

        return SatisfactionConsultSaveResponse(
            id_satisfaction_consultant=id_satis,
            mode=mode,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
