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
app_local = FastAPI(title="Skillboard - Adaptation en cours de formation API")

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

class StagiaireLight(BaseModel):
    id_action_formation_effectif: str
    nom_complet: str
    entreprise: Optional[str] = None


class AdaptationItem(BaseModel):
    id_adaptation: str
    date_adaptation: datetime
    portee_adaptation: str
    id_action_formation_effectif: Optional[str] = None
    type_adaptation: str
    motif_court: Optional[str] = None
    description_apres: str


class AdaptationContextResponse(BaseModel):
    id_action_formation: str
    id_form: str
    id_consultant: str

    code_formation: Optional[str] = None
    titre_formation: str
    code_action_formation: Optional[str] = None

    civilite: Optional[str] = None
    prenom_consultant: str
    nom_consultant: str

    stagiaires: List[StagiaireLight] = Field(default_factory=list)
    adaptations: List[AdaptationItem] = Field(default_factory=list)


class AdaptationInput(BaseModel):
    id_adaptation: Optional[str] = None
    id_action_formation: str

    portee_adaptation: str                 # 'GROUPE' ou 'INDIVIDUEL'
    id_action_formation_effectif: Optional[str] = None

    date_adaptation: Optional[datetime] = None

    type_adaptation: str                  # contenu / durée / supports / objectifs / organisation / public / autre
    motif_court: Optional[str] = None

    description_avant: Optional[str] = None
    description_apres: str

    impact_objectifs: Optional[str] = None
    impact_evaluation: Optional[bool] = None
    impact_evaluation_commentaire: Optional[str] = None

    commentaire_libre: Optional[str] = None


class AdaptationSaveResponse(BaseModel):
    id_adaptation: str
    mode: str    # 'insert' ou 'update'


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


def save_cache(payload: AdaptationInput):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"adaptation_formation_{payload.id_action_formation}_{ts}.json"

    # IMPORTANT : convertir les datetime au format JSON
    data = payload.model_dump(mode="json")  # Pydantic v2 => datetime → str ISO

    with open(fname, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ======================================================
# Endpoints
# ======================================================

@app_local.api_route("/adaptation/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/adaptation/context/{id_action_formation}",
    response_model=AdaptationContextResponse,
)
def get_adaptation_context(id_action_formation: str):
    """
    Retourne :
    - infos action + formation + consultant
    - liste des stagiaires de l'ACF (pour adaptations individuelles)
    - liste des adaptations déjà saisies (non archivées)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # ---------- Contexte action + consultant ----------
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

                # ---------- Liste des stagiaires de l'ACF ----------
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation_effectif,
                        ec.civilite_effectif AS civilite_affichee,
                        ec.prenom_effectif AS prenom,
                        ec.nom_effectif AS nom,
                        e.nom_ent AS entreprise
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_effectif_client ec
                        ON ec.id_effectif = afe.id_effectif
                    LEFT JOIN public.tbl_entreprise e
                        ON e.id_ent = ec.id_ent
                    WHERE afe.id_action_formation = %s
                      AND afe.archive = FALSE
                      AND ec.archive = FALSE
                    """,
                    (id_action_formation,),
                )
                stagiaires_rows = cur.fetchall() or []

                stagiaires: List[StagiaireLight] = []
                for s in stagiaires_rows:
                    civ = (s.get("civilite_affichee") or "").strip()
                    if civ == "M":
                        civ_label = "M"
                    elif civ == "F":
                        civ_label = "Mme"
                    else:
                        civ_label = civ or ""
                    nom_complet = f"{civ_label + ' ' if civ_label else ''}{s['prenom']} {s['nom']}"
                    stagiaires.append(
                        StagiaireLight(
                            id_action_formation_effectif=s["id_action_formation_effectif"],
                            nom_complet=nom_complet,
                            entreprise=s.get("entreprise"),
                        )
                    )

                # ---------- Adaptations déjà saisies ----------
                cur.execute(
                    """
                    SELECT
                        id_adaptation,
                        date_adaptation,
                        portee_adaptation,
                        id_action_formation_effectif,
                        type_adaptation,
                        motif_court,
                        description_apres
                    FROM public.tbl_action_formation_adaptation
                    WHERE id_action_formation = %s
                      AND archive = FALSE
                    ORDER BY date_adaptation ASC, date_creation ASC
                    """,
                    (id_action_formation,),
                )
                ad_rows = cur.fetchall() or []
                adaptations: List[AdaptationItem] = []
                for a in ad_rows:
                    adaptations.append(
                        AdaptationItem(
                            id_adaptation=a["id_adaptation"],
                            date_adaptation=a["date_adaptation"],
                            portee_adaptation=a["portee_adaptation"],
                            id_action_formation_effectif=a.get("id_action_formation_effectif"),
                            type_adaptation=a["type_adaptation"],
                            motif_court=a.get("motif_court"),
                            description_apres=a["description_apres"],
                        )
                    )

                return AdaptationContextResponse(
                    id_action_formation=id_action_formation,
                    id_form=id_form,
                    id_consultant=id_consultant,
                    code_formation=code_formation,
                    titre_formation=titre_formation,
                    code_action_formation=code_action_formation,
                    civilite=civilite,
                    prenom_consultant=prenom,
                    nom_consultant=nom,
                    stagiaires=stagiaires,
                    adaptations=adaptations,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post(
    "/adaptation/save",
    response_model=AdaptationSaveResponse,
)
def save_adaptation(payload: AdaptationInput):
    """
    Crée ou met à jour une adaptation en cours de formation.
    Plusieurs adaptations possibles par action.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # ---------- Vérifier l'action de formation ----------
                cur.execute(
                    """
                    SELECT
                        af.id_action_formation,
                        af.id_form,
                        af.id_consultant
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
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

                # ---------- Normalisation des valeurs ----------
                portee_raw = (payload.portee_adaptation or "").strip().upper()
                if portee_raw not in ("GROUPE", "INDIVIDUEL"):
                    raise HTTPException(
                        status_code=400,
                        detail="Portée d'adaptation invalide (attendu : GROUPE ou INDIVIDUEL).",
                    )

                id_effectif = payload.id_action_formation_effectif
                if portee_raw == "INDIVIDUEL":
                    if not id_effectif:
                        raise HTTPException(
                            status_code=400,
                            detail="Merci de sélectionner le stagiaire concerné pour une adaptation individuelle.",
                        )
                    # Vérifier que le stagiaire appartient bien à l'ACF
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_action_formation_effectif
                        WHERE id_action_formation_effectif = %s
                          AND id_action_formation = %s
                          AND archive = FALSE
                        """,
                        (id_effectif, id_action_formation),
                    )
                    if cur.fetchone() is None:
                        raise HTTPException(
                            status_code=400,
                            detail="Le stagiaire sélectionné n'appartient pas à cette action de formation.",
                        )
                else:
                    id_effectif = None

                type_adapt = (payload.type_adaptation or "").strip()
                if not type_adapt:
                    raise HTTPException(
                        status_code=400,
                        detail="Le type d'adaptation est obligatoire.",
                    )

                desc_apres = (payload.description_apres or "").strip()
                if not desc_apres:
                    raise HTTPException(
                        status_code=400,
                        detail="Merci de décrire l'adaptation réalisée.",
                    )

                motif_court = (payload.motif_court or "").strip() or None
                desc_avant = (payload.description_avant or "").strip() or None
                impact_obj = (payload.impact_objectifs or "").strip() or None
                impact_eval_comment = (payload.impact_evaluation_commentaire or "").strip() or None
                commentaire_libre = (payload.commentaire_libre or "").strip() or None

                date_adapt = payload.date_adaptation  # None => géré dans la requête

                # ---------- Insert ou update ----------
                if payload.id_adaptation:
                    # Vérifier que l'adaptation existe et appartient à l'ACF
                    cur.execute(
                        """
                        SELECT id_adaptation
                        FROM public.tbl_action_formation_adaptation
                        WHERE id_adaptation = %s
                          AND id_action_formation = %s
                          AND archive = FALSE
                        """,
                        (payload.id_adaptation, id_action_formation),
                    )
                    row_adapt = cur.fetchone()
                    if row_adapt is None:
                        raise HTTPException(
                            status_code=404,
                            detail="Adaptation introuvable pour cette action de formation.",
                        )

                    id_adaptation = payload.id_adaptation

                    cur.execute(
                        """
                        UPDATE public.tbl_action_formation_adaptation
                        SET
                            portee_adaptation = %s,
                            id_action_formation_effectif = %s,
                            date_adaptation = COALESCE(%s, date_adaptation),
                            type_adaptation = %s,
                            motif_court = %s,
                            description_avant = %s,
                            description_apres = %s,
                            impact_objectifs = %s,
                            impact_evaluation = %s,
                            impact_evaluation_commentaire = %s,
                            commentaire_libre = %s,
                            date_modif = NOW()
                        WHERE id_adaptation = %s
                        """,
                        (
                            portee_raw,
                            id_effectif,
                            date_adapt,
                            type_adapt,
                            motif_court,
                            desc_avant,
                            desc_apres,
                            impact_obj,
                            payload.impact_evaluation,
                            impact_eval_comment,
                            commentaire_libre,
                            id_adaptation,
                        ),
                    )
                    mode = "update"
                else:
                    id_adaptation = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_action_formation_adaptation (
                            id_adaptation,
                            id_action_formation,
                            portee_adaptation,
                            id_action_formation_effectif,
                            date_adaptation,
                            type_adaptation,
                            motif_court,
                            description_avant,
                            description_apres,
                            impact_objectifs,
                            impact_evaluation,
                            impact_evaluation_commentaire,
                            commentaire_libre,
                            date_creation,
                            date_modif,
                            archive
                        ) VALUES (
                            %s, %s, %s, %s,
                            COALESCE(%s, NOW()),
                            %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            NOW(), NOW(),
                            FALSE
                        )
                        """,
                        (
                            id_adaptation,
                            id_action_formation,
                            portee_raw,
                            id_effectif,
                            date_adapt,
                            type_adapt,
                            motif_court,
                            desc_avant,
                            desc_apres,
                            impact_obj,
                            payload.impact_evaluation,
                            impact_eval_comment,
                            commentaire_libre,
                        ),
                    )
                    mode = "insert"

                conn.commit()
                save_cache(payload)

        return AdaptationSaveResponse(
            id_adaptation=id_adaptation,
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
