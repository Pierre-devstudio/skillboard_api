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

from app.routers.MailManager import send_satisfaction_stagiaire_mail
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
app_local = FastAPI(title="Skillboard - Satisfaction Stagiaire API")

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

class ObjectifContextItem(BaseModel):
    id_comp: str
    intitule: str


class SatisfactionContextResponse(BaseModel):
    id_action_formation_effectif: str
    id_action_formation: str
    id_form: str

    civilite: Optional[str] = None
    nom: str
    prenom: str
    entreprise: Optional[str] = None

    code_formation: Optional[str] = None
    titre_formation: str

    objectifs: List[ObjectifContextItem] = Field(default_factory=list)
    deja_repondu: bool


class BlocPreparation(BaseModel):
    q1: int = Field(ge=1, le=10)
    q2: int = Field(ge=1, le=10)
    q3: int = Field(ge=1, le=10)
    commentaire: Optional[str] = None


class BlocOrganisation(BaseModel):
    q1: int = Field(ge=1, le=10)
    q2: int = Field(ge=1, le=10)
    q3: int = Field(ge=1, le=10)
    q4: int = Field(ge=1, le=10)
    q5: int = Field(ge=1, le=10)
    commentaire: Optional[str] = None


class BlocContenu(BaseModel):
    q1: int = Field(ge=1, le=10)
    q2: int = Field(ge=1, le=10)
    q3: int = Field(ge=1, le=10)
    q4: int = Field(ge=1, le=10)
    commentaire: Optional[str] = None


class ObjectifItemIn(BaseModel):
    id_comp: str
    intitule: Optional[str] = None
    note: int = Field(ge=1, le=10)


class BlocObjectifs(BaseModel):
    objectifs: List[ObjectifItemIn] = Field(default_factory=list)


class BlocCommentaires(BaseModel):
    suggestion: Optional[str] = None
    recommande: Optional[str] = None      # "oui" / "non"
    reclamation: Optional[str] = None     # "oui" / "non"
    reclamation_objet: Optional[str] = None
    reclamation_texte: Optional[str] = None


class SatisfactionInput(BaseModel):
    id_action_formation_effectif: str
    preparation: BlocPreparation
    organisation: BlocOrganisation
    contenu: BlocContenu
    objectifs: BlocObjectifs
    commentaires: BlocCommentaires


class SatisfactionSaveResponse(BaseModel):
    id_satisfaction_stagiaire: str
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


def save_cache(payload: SatisfactionInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"satisfaction_stagiaire_{payload.id_action_formation_effectif}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.model_dump(), f, ensure_ascii=False, indent=2)


# ======================================================
# Helpers
# ======================================================

def _ensure_list_from_json(val):
    """
    Compat : liste d'id_comp en JSONB ou texte JSON.
    """
    if val is None:
        return None
    if isinstance(val, list):
        return val
    try:
        return json.loads(val)
    except Exception:
        return None


def _calcul_note_objectifs_moyenne(objectifs: List[ObjectifItemIn]) -> Optional[float]:
    notes = [o.note for o in objectifs if o.note is not None]
    if not notes:
        return None
    return sum(notes) / len(notes)


def _calcul_note_globale(payload: SatisfactionInput, note_objectifs_moyenne: Optional[float]) -> Optional[float]:
    valeurs = [
        payload.preparation.q1,
        payload.preparation.q2,
        payload.preparation.q3,
        payload.organisation.q1,
        payload.organisation.q2,
        payload.organisation.q3,
        payload.organisation.q4,
        payload.organisation.q5,
        payload.contenu.q1,
        payload.contenu.q2,
        payload.contenu.q3,
        payload.contenu.q4,
    ]
    if note_objectifs_moyenne is not None:
        valeurs.append(note_objectifs_moyenne)

    valeurs = [v for v in valeurs if v is not None]
    if not valeurs:
        return None
    return sum(valeurs) / len(valeurs)


# ======================================================
# Endpoints
# ======================================================

@app_local.api_route("/satisfaction_stagiaire/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/satisfaction_stagiaire/context/{id_action_formation_effectif}",
    response_model=SatisfactionContextResponse,
)
def get_satisfaction_context(id_action_formation_effectif: str):
    """
    Retourne le contexte pour afficher la page d'accueil et construire
    la page 'objectifs' (compétences stagiaires).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Infos stagiaire + action + fiche formation
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation_effectif,
                        afe.id_action_formation,
                        af.id_form,
                        af.code_action_formation,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.civilite_effectif,
                        ec.id_ent,
                        ff.titre AS titre_formation,
                        ff.code AS code_formation
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = afe.id_action_formation
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_effectif_client ec
                        ON ec.id_effectif = afe.id_effectif
                    WHERE afe.id_action_formation_effectif = %s
                      AND afe.archive = FALSE
                      AND af.archive = FALSE
                      AND ff.masque = FALSE
                    """,
                    (id_action_formation_effectif,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Stagiaire ou action de formation introuvable",
                    )

                id_afe = row["id_action_formation_effectif"]
                id_acf = row["id_action_formation"]
                id_form = row["id_form"]
                nom = row["nom_effectif"]
                prenom = row["prenom_effectif"]
                civilite = row["civilite_effectif"]
                titre_formation = row["titre_formation"]
                code_formation = row.get("code_formation") if isinstance(row, dict) else None
                code_action_formation = row["code_action_formation"]

                # TODO : récupérer éventuellement le nom de l'entreprise via id_ent
                entreprise = None

                # 2) Compétences stagiaires -> objectifs
                cur.execute(
                    """
                    SELECT ff.competences_stagiaires
                    FROM public.tbl_fiche_formation ff
                    WHERE ff.id_form = %s
                      AND ff.masque = FALSE
                    """,
                    (id_form,),
                )
                row_comp = cur.fetchone()
                objectifs: List[ObjectifContextItem] = []

                if row_comp and row_comp["competences_stagiaires"]:
                    comp_ids = _ensure_list_from_json(row_comp["competences_stagiaires"])
                    if comp_ids:
                        cur.execute(
                            """
                            SELECT id_comp, intitule
                            FROM public.tbl_competence
                            WHERE id_comp = ANY(%s)
                              AND masque = FALSE
                            """,
                            (comp_ids,),
                        )
                        comp_rows = cur.fetchall()
                        comp_map = {c["id_comp"]: c["intitule"] for c in comp_rows}

                        for cid in comp_ids:
                            if cid in comp_map:
                                objectifs.append(
                                    ObjectifContextItem(
                                        id_comp=cid,
                                        intitule=comp_map[cid],
                                    )
                                )

                # 3) Vérifier si satisfaction déjà saisie
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_action_formation_satisfaction_stagiaire s
                    WHERE s.id_action_formation_effectif = %s
                      AND s.archive = FALSE
                    """,
                    (id_action_formation_effectif,),
                )
                deja_repondu = cur.fetchone() is not None

                return SatisfactionContextResponse(
                    id_action_formation_effectif=id_afe,
                    id_action_formation=id_acf,
                    id_form=id_form,
                    code_action_formation=code_action_formation,
                    civilite=civilite,
                    nom=nom,
                    prenom=prenom,
                    entreprise=entreprise,
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    objectifs=objectifs,
                    deja_repondu=deja_repondu,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post(
    "/satisfaction_stagiaire/save",
    response_model=SatisfactionSaveResponse,
)
def save_satisfaction(payload: SatisfactionInput):
    """
    Enregistre ou met à jour l'enquête de satisfaction stagiaire
    dans tbl_action_formation_satisfaction_stagiaire.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Récupérer id_action_formation + id_form à partir de l'effectif
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation,
                        af.id_form,
                        af.code_action_formation,
                        ff.code AS code_formation,
                        ff.titre AS titre_formation,
                        ec.nom_effectif,
                        ec.prenom_effectif
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = afe.id_action_formation
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_effectif_client ec
                        ON ec.id_effectif = afe.id_effectif
                    WHERE afe.id_action_formation_effectif = %s
                      AND afe.archive = FALSE
                      AND af.archive = FALSE
                      AND ff.masque = FALSE
                    """,
                    (payload.id_action_formation_effectif,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Action de formation introuvable pour cet effectif",
                    )

                id_action_formation = row["id_action_formation"]
                id_form = row["id_form"]
                code_action_formation = row.get("code_action_formation")
                code_formation = row["code_formation"]          # <--- AJOUTER ÇA
                titre_formation = row["titre_formation"]        # si tu l’utilises dans le mail
                nom_effectif = row["nom_effectif"]              # si tu l’utilises dans le mail
                prenom_effectif = row["prenom_effectif"] 

                # 2) Calcul des notes
                note_objectifs_moy = _calcul_note_objectifs_moyenne(payload.objectifs.objectifs)
                note_globale = _calcul_note_globale(payload, note_objectifs_moy)

                # 3) Construction du JSON de réponses
                reponses = {
                    "preparation": {
                        "q1": payload.preparation.q1,
                        "q2": payload.preparation.q2,
                        "q3": payload.preparation.q3,
                        "commentaire": payload.preparation.commentaire,
                    },
                    "organisation": {
                        "q1": payload.organisation.q1,
                        "q2": payload.organisation.q2,
                        "q3": payload.organisation.q3,
                        "q4": payload.organisation.q4,
                        "q5": payload.organisation.q5,
                        "commentaire": payload.organisation.commentaire,
                    },
                    "contenu": {
                        "q1": payload.contenu.q1,
                        "q2": payload.contenu.q2,
                        "q3": payload.contenu.q3,
                        "q4": payload.contenu.q4,
                        "commentaire": payload.contenu.commentaire,
                    },
                    "objectifs": [
                        o.model_dump() for o in payload.objectifs.objectifs
                    ],
                    "commentaires": payload.commentaires.model_dump(),
                }

                reponses_json_str = json.dumps(reponses, ensure_ascii=False)

                # 4) Vérifier si une réponse existe déjà (archive = FALSE)
                cur.execute(
                    """
                    SELECT id_satisfaction_stagiaire
                    FROM public.tbl_action_formation_satisfaction_stagiaire
                    WHERE id_action_formation_effectif = %s
                      AND archive = FALSE
                    """,
                    (payload.id_action_formation_effectif,),
                )
                row_satis = cur.fetchone()

                if row_satis:
                    # UPDATE
                    id_satis = row_satis["id_satisfaction_stagiaire"]
                    cur.execute(
                        """
                        UPDATE public.tbl_action_formation_satisfaction_stagiaire
                        SET
                            id_action_formation = %s,
                            id_form = %s,
                            date_modif = NOW(),
                            note_preparation_q1 = %s,
                            note_preparation_q2 = %s,
                            note_preparation_q3 = %s,
                            note_organisation_q1 = %s,
                            note_organisation_q2 = %s,
                            note_organisation_q3 = %s,
                            note_organisation_q4 = %s,
                            note_organisation_q5 = %s,
                            note_contenu_q1 = %s,
                            note_contenu_q2 = %s,
                            note_contenu_q3 = %s,
                            note_contenu_q4 = %s,
                            note_objectifs_moyenne = %s,
                            note_globale = %s,
                            reponses_json = %s
                        WHERE id_satisfaction_stagiaire = %s
                        """,
                        (
                            id_action_formation,
                            id_form,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            payload.organisation.q1,
                            payload.organisation.q2,
                            payload.organisation.q3,
                            payload.organisation.q4,
                            payload.organisation.q5,
                            payload.contenu.q1,
                            payload.contenu.q2,
                            payload.contenu.q3,
                            payload.contenu.q4,
                            note_objectifs_moy,
                            note_globale,
                            reponses_json_str,
                            id_satis,
                        ),
                    )
                    mode = "update"
                else:
                    # INSERT
                    id_satis = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_action_formation_satisfaction_stagiaire (
                            id_satisfaction_stagiaire,
                            id_action_formation_effectif,
                            id_action_formation,
                            id_form,
                            date_reponse,
                            date_modif,
                            note_preparation_q1,
                            note_preparation_q2,
                            note_preparation_q3,
                            note_organisation_q1,
                            note_organisation_q2,
                            note_organisation_q3,
                            note_organisation_q4,
                            note_organisation_q5,
                            note_contenu_q1,
                            note_contenu_q2,
                            note_contenu_q3,
                            note_contenu_q4,
                            note_objectifs_moyenne,
                            note_globale,
                            reponses_json,
                            archive
                        ) VALUES (
                            %s, %s, %s, %s,
                            NOW(), NOW(),
                            %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s,
                            %s,
                            FALSE
                        )
                        """,
                        (
                            id_satis,
                            payload.id_action_formation_effectif,
                            id_action_formation,
                            id_form,
                            payload.preparation.q1,
                            payload.preparation.q2,
                            payload.preparation.q3,
                            payload.organisation.q1,
                            payload.organisation.q2,
                            payload.organisation.q3,
                            payload.organisation.q4,
                            payload.organisation.q5,
                            payload.contenu.q1,
                            payload.contenu.q2,
                            payload.contenu.q3,
                            payload.contenu.q4,
                            note_objectifs_moy,
                            note_globale,
                            reponses_json_str,
                        ),
                    )
                    mode = "insert"

                conn.commit()
                save_cache(payload)

                 # Envoi mail hors transaction
                send_satisfaction_stagiaire_mail(
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    prenom=prenom_effectif,
                    nom=nom_effectif,
                    id_action_formation_effectif=payload.id_action_formation_effectif,
                    mode=mode,
                    code_action_formation=code_action_formation,
                )


                return SatisfactionSaveResponse(
                    id_satisfaction_stagiaire=id_satis,
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
