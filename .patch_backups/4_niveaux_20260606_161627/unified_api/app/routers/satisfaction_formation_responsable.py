from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field
import os
import json
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

from app.routers.MailManager import send_satisfaction_responsable_mail
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
app_local = FastAPI(title="Skillboard - Satisfaction Responsable Admin API")

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


class SatisfactionRespContextResponse(BaseModel):
    id_action_formation_entreprise: str
    id_action_formation: str
    id_form: str
    id_ent: str
    id_contact_administratif: str

    civilite: Optional[str] = None
    nom: str
    prenom: str

    code_formation: Optional[str] = None
    titre_formation: str
    code_action_formation: Optional[str] = None

    deja_repondu: bool


class BlocPreparationResp(BaseModel):
    q1: int = Field(ge=1, le=10)
    q2: int = Field(ge=1, le=10)
    q3: int = Field(ge=1, le=10)
    q4: int = Field(ge=1, le=10)


class BlocEchangesFormateur(BaseModel):
    a_eu_echange: str  # "oui" / "non"
    q1: Optional[int] = None
    q2: Optional[int] = None
    q3: Optional[int] = None


class BlocEchangesOF(BaseModel):
    a_eu_echange: str  # "oui" / "non"
    q1: Optional[int] = None


class BlocBilan(BaseModel):
    q1: int = Field(ge=1, le=10)
    q2: int = Field(ge=1, le=10)


class BlocRetourInterne(BaseModel):
    a_eu_retour: str  # "oui" / "non"
    q1: Optional[int] = None
    q2: Optional[int] = None
    q3: Optional[int] = None


class BlocCommentairesResp(BaseModel):
    suggestion: Optional[str] = None
    recommande: Optional[str] = None          # "oui"/"non"
    reclamation: Optional[str] = None         # "oui"/"non"
    reclamation_objet: Optional[str] = None
    reclamation_texte: Optional[str] = None
    intention_reappel: Optional[str] = None   # "OUI", "PEUT_ETRE", "NON"


class SatisfactionRespInput(BaseModel):
    id_action_formation_entreprise: str
    preparation: BlocPreparationResp
    echanges_formateur: BlocEchangesFormateur
    echanges_of: BlocEchangesOF
    bilan: BlocBilan
    retour_interne: BlocRetourInterne
    commentaires: BlocCommentairesResp


class SatisfactionRespSaveResponse(BaseModel):
    id_satisfaction_responsable: str
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


def save_cache(payload: SatisfactionRespInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"satisfaction_responsable_{payload.id_action_formation_entreprise}_{ts}.json"
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
    prep: BlocPreparationResp,
    e_form: BlocEchangesFormateur,
    e_of: BlocEchangesOF,
    bilan: BlocBilan,
    r_int: BlocRetourInterne,
) -> List[int]:
    notes: List[int] = []

    # Préparation (toujours obligatoire)
    notes.append(prep.q1)
    notes.append(prep.q2)
    notes.append(prep.q3)
    notes.append(prep.q4)

    # Formateur si échange
    if _bool_from_oui_non(e_form.a_eu_echange):
        for v in (e_form.q1, e_form.q2, e_form.q3):
            if v is not None and 1 <= v <= 10:
                notes.append(v)

    # OF si échange
    if _bool_from_oui_non(e_of.a_eu_echange):
        if e_of.q1 is not None and 1 <= e_of.q1 <= 10:
            notes.append(e_of.q1)

    # Bilan (toujours obligatoire)
    notes.append(bilan.q1)
    notes.append(bilan.q2)

    # Retour interne si échange
    if _bool_from_oui_non(r_int.a_eu_retour):
        for v in (r_int.q1, r_int.q2, r_int.q3):
            if v is not None and 1 <= v <= 10:
                notes.append(v)

    return notes


# ======================================================
# Endpoints
# ======================================================

@app_local.api_route("/satisfaction_responsable/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/satisfaction_responsable/context/{id_action_formation_entreprise}",
    response_model=SatisfactionRespContextResponse,
)
def get_satisfaction_responsable_context(id_action_formation_entreprise: str):
    """
    Contexte pour l'affichage du formulaire Responsable :
    - contact administratif
    - formation
    - info action
    - déjà répondu ou non
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        aent.id_ligne AS id_action_formation_entreprise,
                        aent.id_action_formation,
                        aent.id_ent,
                        aent.id_contact_administratif,
                        af.id_form,
                        af.code_action_formation,
                        ff.code AS code_formation,
                        ff.titre AS titre_formation,
                        c.civ_ca AS civilite_contact,
                        c.prenom_ca AS prenom_contact,
                        c.nom_ca AS nom_contact
                    FROM public.tbl_action_formation_entreprises aent
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = aent.id_action_formation
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_contact c
                        ON c.id_contact = aent.id_contact_administratif
                    WHERE aent.id_ligne = %s
                      AND af.archive = FALSE
                      AND ff.masque = FALSE
                    """,
                    (id_action_formation_entreprise,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Action de formation / entreprise introuvable",
                    )

                id_action_formation = row["id_action_formation"]
                id_form = row["id_form"]
                id_ent = row["id_ent"]
                id_contact_administratif = row["id_contact_administratif"]
                code_action_formation = row.get("code_action_formation")
                code_formation = row.get("code_formation") or row.get("code")
                titre_formation = row["titre_formation"]
                civilite = row.get("civilite_contact")
                prenom = row["prenom_contact"]
                nom = row["nom_contact"]

                # déjà répondu ?
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_action_formation_satisfaction_responsable s
                    WHERE s.id_action_formation_entreprise = %s
                      AND s.archive = FALSE
                    """,
                    (id_action_formation_entreprise,),
                )
                deja_repondu = cur.fetchone() is not None

                return SatisfactionRespContextResponse(
                    id_action_formation_entreprise=row["id_action_formation_entreprise"],
                    id_action_formation=id_action_formation,
                    id_form=id_form,
                    id_ent=id_ent,
                    id_contact_administratif=id_contact_administratif,
                    civilite=civilite,
                    nom=nom,
                    prenom=prenom,
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    code_action_formation=code_action_formation,
                    deja_repondu=deja_repondu,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post(
    "/satisfaction_responsable/save",
    response_model=SatisfactionRespSaveResponse,
)
def save_satisfaction_responsable(payload: SatisfactionRespInput):
    """
    Enregistre ou met à jour une satisfaction Responsable Admin
    pour une ligne d'action de formation entreprise.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Récupérer les infos de contexte (action, form, ent, contact)
                cur.execute(
                    """
                    SELECT
                        aent.id_ligne AS id_action_formation_entreprise,
                        aent.id_action_formation,
                        aent.id_ent,
                        aent.id_contact_administratif,
                        af.id_form,
                        af.code_action_formation,
                        ff.code AS code_formation,
                        ff.titre AS titre_formation,
                        c.prenom_ca AS prenom_contact,
                        c.nom_ca AS nom_contact
                    FROM public.tbl_action_formation_entreprises aent
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = aent.id_action_formation
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_contact c
                        ON c.id_contact = aent.id_contact_administratif
                    WHERE aent.id_ligne = %s
                        AND af.archive = FALSE
                        AND ff.masque = FALSE
                    """,
                    (payload.id_action_formation_entreprise,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Action de formation / entreprise introuvable pour cette ligne",
                    )

                id_action_formation_entreprise = row["id_action_formation_entreprise"]
                id_action_formation = row["id_action_formation"]
                id_form = row["id_form"]
                id_ent = row["id_ent"]
                id_contact_administratif = row["id_contact_administratif"]
                code_action_formation = row.get("code_action_formation")
                code_formation = row.get("code_formation") or row.get("code")
                titre_formation = row["titre_formation"]
                prenom_contact = row["prenom_contact"]
                nom_contact = row["nom_contact"]

                # 2) Conversion des champs oui/non -> bool
                echange_formateur_bool = _bool_from_oui_non(payload.echanges_formateur.a_eu_echange)
                echange_of_bool = _bool_from_oui_non(payload.echanges_of.a_eu_echange)
                retour_interne_bool = _bool_from_oui_non(payload.retour_interne.a_eu_retour)
                recommande_bool = _bool_from_oui_non(payload.commentaires.recommande)
                reclamation_bool = _bool_from_oui_non(payload.commentaires.reclamation)

                # 3) Normalisation des notes conditionnelles
                note_formateur_q1 = None
                note_formateur_q2 = None
                note_formateur_q3 = None
                if echange_formateur_bool:
                    for attr_name in ("q1", "q2", "q3"):
                        val = getattr(payload.echanges_formateur, attr_name)
                        if val is None or val < 1 or val > 10:
                            raise HTTPException(
                                status_code=400,
                                detail="Merci de renseigner toutes les notes liées aux échanges avec le formateur (1 à 10).",
                            )
                    note_formateur_q1 = payload.echanges_formateur.q1
                    note_formateur_q2 = payload.echanges_formateur.q2
                    note_formateur_q3 = payload.echanges_formateur.q3

                note_of_q1 = None
                if echange_of_bool:
                    val = payload.echanges_of.q1
                    if val is None or val < 1 or val > 10:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de renseigner la note liée aux échanges avec l'organisme de formation (1 à 10).",
                        )
                    note_of_q1 = val

                note_retour_q1 = None
                note_retour_q2 = None
                note_retour_q3 = None
                if retour_interne_bool:
                    for attr_name in ("q1", "q2", "q3"):
                        val = getattr(payload.retour_interne, attr_name)
                        if val is None or val < 1 or val > 10:
                            raise HTTPException(
                                status_code=400,
                                detail="Merci de renseigner toutes les notes liées aux retours internes (1 à 10).",
                            )
                    note_retour_q1 = payload.retour_interne.q1
                    note_retour_q2 = payload.retour_interne.q2
                    note_retour_q3 = payload.retour_interne.q3

                # 4) Calcul de la note globale
                notes = _collect_notes_for_global(
                    payload.preparation,
                    payload.echanges_formateur,
                    payload.echanges_of,
                    payload.bilan,
                    payload.retour_interne,
                )
                note_globale = None
                if notes:
                    note_globale = sum(notes) / float(len(notes))

                # 5) JSON complet des réponses
                reponses = {
                    "preparation": payload.preparation.model_dump(),
                    "echanges_formateur": {
                        "a_eu_echange": payload.echanges_formateur.a_eu_echange,
                        "q1": note_formateur_q1,
                        "q2": note_formateur_q2,
                        "q3": note_formateur_q3,
                    },
                    "echanges_of": {
                        "a_eu_echange": payload.echanges_of.a_eu_echange,
                        "q1": note_of_q1,
                    },
                    "bilan": payload.bilan.model_dump(),
                    "retour_interne": {
                        "a_eu_retour": payload.retour_interne.a_eu_retour,
                        "q1": note_retour_q1,
                        "q2": note_retour_q2,
                        "q3": note_retour_q3,
                    },
                    "commentaires": payload.commentaires.model_dump(),
                }
                reponses_json_str = json.dumps(reponses, ensure_ascii=False)

                # 6) Vérifier si une satisfaction existe déjà
                cur.execute(
                    """
                    SELECT id_satisfaction_responsable
                    FROM public.tbl_action_formation_satisfaction_responsable
                    WHERE id_action_formation_entreprise = %s
                      AND archive = FALSE
                    """,
                    (id_action_formation_entreprise,),
                )
                row_satis = cur.fetchone()

                if row_satis:
                    id_satis = row_satis["id_satisfaction_responsable"]
                    cur.execute(
                        """
                        UPDATE public.tbl_action_formation_satisfaction_responsable
                        SET
                            id_action_formation = %s,
                            id_form = %s,
                            id_ent = %s,
                            id_contact_administratif = %s,
                            date_modif = NOW(),
                            note_preparation_q1 = %s,
                            note_preparation_q2 = %s,
                            note_preparation_q3 = %s,
                            note_preparation_q4 = %s,
                            echange_formateur = %s,
                            note_formateur_q1 = %s,
                            note_formateur_q2 = %s,
                            note_formateur_q3 = %s,
                            echange_of = %s,
                            note_of_q1 = %s,
                            note_bilan_q1 = %s,
                            note_bilan_q2 = %s,
                            retour_interne = %s,
                            note_retour_q1 = %s,
                            note_retour_q2 = %s,
                            note_retour_q3 = %s,
                            suggestion = %s,
                            recommande = %s,
                            reclamation = %s,
                            reclamation_objet = %s,
                            reclamation_texte = %s,
                            intention_reappel = %s,
                            note_globale = %s,
                            reponses_json = %s
                        WHERE id_satisfaction_responsable = %s
                        """,
                        (
                            id_action_formation,
                            id_form,
                            id_ent,
                            id_contact_administratif,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            payload.preparation.q4,
                            echange_formateur_bool,
                            note_formateur_q1,
                            note_formateur_q2,
                            note_formateur_q3,
                            echange_of_bool,
                            note_of_q1,
                            payload.bilan.q1,
                            payload.bilan.q2,
                            retour_interne_bool,
                            note_retour_q1,
                            note_retour_q2,
                            note_retour_q3,
                            payload.commentaires.suggestion,
                            recommande_bool,
                            reclamation_bool,
                            payload.commentaires.reclamation_objet,
                            payload.commentaires.reclamation_texte,
                            payload.commentaires.intention_reappel,
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
                        INSERT INTO public.tbl_action_formation_satisfaction_responsable (
                            id_satisfaction_responsable,
                            id_action_formation_entreprise,
                            id_action_formation,
                            id_form,
                            id_ent,
                            id_contact_administratif,
                            date_reponse,
                            date_modif,
                            note_preparation_q1,
                            note_preparation_q2,
                            note_preparation_q3,
                            note_preparation_q4,
                            echange_formateur,
                            note_formateur_q1,
                            note_formateur_q2,
                            note_formateur_q3,
                            echange_of,
                            note_of_q1,
                            note_bilan_q1,
                            note_bilan_q2,
                            retour_interne,
                            note_retour_q1,
                            note_retour_q2,
                            note_retour_q3,
                            suggestion,
                            recommande,
                            reclamation,
                            reclamation_objet,
                            reclamation_texte,
                            intention_reappel,
                            note_globale,
                            reponses_json,
                            archive
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s,
                            NOW(), NOW(),
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s,
                            %s,
                            FALSE
                        )
                        """,
                        (
                            id_satis,
                            id_action_formation_entreprise,
                            id_action_formation,
                            id_form,
                            id_ent,
                            id_contact_administratif,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            payload.preparation.q4,
                            echange_formateur_bool,
                            note_formateur_q1,
                            note_formateur_q2,
                            note_formateur_q3,
                            echange_of_bool,
                            note_of_q1,
                            payload.bilan.q1,
                            payload.bilan.q2,
                            retour_interne_bool,
                            note_retour_q1,
                            note_retour_q2,
                            note_retour_q3,
                            payload.commentaires.suggestion,
                            recommande_bool,
                            reclamation_bool,
                            payload.commentaires.reclamation_objet,
                            payload.commentaires.reclamation_texte,
                            payload.commentaires.intention_reappel,
                            note_globale,
                            reponses_json_str,
                        ),
                    )
                    mode = "insert"

                conn.commit()
                save_cache(payload)

                # Envoi mail hors transaction
                send_satisfaction_responsable_mail(
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    prenom=prenom_contact,
                    nom=nom_contact,
                    id_action_formation_entreprise=payload.id_action_formation_entreprise,
                    mode=mode,
                    code_action_formation=code_action_formation,
                )

                return SatisfactionRespSaveResponse(
                    id_satisfaction_responsable=id_satis,
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
