from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel
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
app_local = FastAPI(title="Skillboard - Validation Acquis API")

# CORS local
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
# Modèles
# ======================================================

class StagiaireItem(BaseModel):
    id_action_formation_effectif: str
    nom: str
    prenom: str
    entreprise: Optional[str] = None
    est_present: bool
    est_evalue: bool


class ConsultantInfo(BaseModel):
    id_consultant: Optional[str]
    nom: Optional[str]
    prenom: Optional[str]


class ContextResponse(BaseModel):
    id_action_formation: str
    titre_formation: str
    consultant: ConsultantInfo
    stagiaires: List[StagiaireItem]
    tous_stagiaires_evalues: bool


class CritereOut(BaseModel):
    code_critere: str
    nom_critere: str
    niveaux: List[str]
    niveau_selectionne: Optional[int] = None  # 1 à 4


class CompetenceOut(BaseModel):
    id_comp: str
    titre_competence: str
    criteres: List[CritereOut]


class StagiaireDetailResponse(BaseModel):
    id_action_formation_effectif: str
    id_action_formation: str
    civilite: Optional[str]
    nom: str
    prenom: str
    entreprise: Optional[str] = None
    titre_formation: str
    consultant: ConsultantInfo
    competences: List[CompetenceOut]
    commentaire_consultant: Optional[str] = None


class CritereEvaluationIn(BaseModel):
    code_critere: str
    niveau: int  # 1 à 4


class CompetenceEvaluationIn(BaseModel):
    id_comp: str
    criteres: List[CritereEvaluationIn]


class SaveEvaluationRequest(BaseModel):
    id_action_formation_effectif: str
    commentaire_consultant: Optional[str] = None
    competences: List[CompetenceEvaluationIn]


class SaveEvaluationResponse(BaseModel):
    id_action_formation_acquisition: str
    message: str


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


def save_cache(payload: SaveEvaluationRequest):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = CACHE_DIR / f"validation_acquis_{payload.id_action_formation_effectif}_{ts}.json"
    with open(fname, "w", encoding="utf-8") as f:
        json.dump(payload.model_dump(), f, ensure_ascii=False, indent=2)


# ======================================================
# Helpers internes
# ======================================================

def _ensure_list_from_json(val):
    """
    compat: si la colonne est déjà un JSON (list/dict) ou une string JSON.
    """
    if val is None:
        return None
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except Exception:
        return None


# ======================================================
# Endpoints
# ======================================================

@app_local.api_route("/validation_acquis/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/validation_acquis/context/{id_action_formation}",
    response_model=ContextResponse,
)
def get_validation_context(id_action_formation: str):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Infos action + formation + consultant
                cur.execute(
                    """
                    SELECT
                        af.id_action_formation,
                        af.id_form,
                        af.id_consultant,
                        ff.titre AS titre_formation,
                        c.nom AS nom_consultant,
                        c.prenom AS prenom_consultant
                    FROM public.tbl_action_formation af
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    LEFT JOIN public.tbl_consultant c
                        ON c.id_consultant = af.id_consultant
                    WHERE af.id_action_formation = %s
                      AND af.archive = FALSE
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
                titre_formation = row["titre_formation"]
                nom_consultant = row["nom_consultant"]
                prenom_consultant = row["prenom_consultant"]

                # 2) Liste des stagiaires + présence + état de validation
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.civilite_effectif,
                        ec.id_ent,
                        EXISTS (
                            SELECT 1
                            FROM public.tbl_action_formation_presence p
                            WHERE p.id_action_formation_effectif = afe.id_action_formation_effectif
                              AND p.archive = FALSE
                        ) AS est_present,
                        EXISTS (
                            SELECT 1
                            FROM public.tbl_action_formation_acquisition acq
                            WHERE acq.id_action_formation_effectif = afe.id_action_formation_effectif
                              AND acq.archive = FALSE
                        ) AS est_evalue
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_effectif_client ec
                        ON ec.id_effectif = afe.id_effectif
                    WHERE afe.id_action_formation = %s
                      AND afe.archive = FALSE
                    ORDER BY ec.nom_effectif, ec.prenom_effectif
                    """,
                    (id_action_formation,),
                )
                rows_stagiaires = cur.fetchall()

                stagiaires: List[StagiaireItem] = []

                for s in rows_stagiaires:
                    # TODO : récupérer nom entreprise via ec.id_ent si nécessaire
                    entreprise = None
                    stagiaires.append(
                        StagiaireItem(
                            id_action_formation_effectif=s["id_action_formation_effectif"],
                            nom=s["nom_effectif"],
                            prenom=s["prenom_effectif"],
                            entreprise=entreprise,
                            est_present=s["est_present"],
                            est_evalue=s["est_evalue"],
                        )
                    )

                # Tous les stagiaires présents sont-ils évalués ?
                tous_evalues = True
                for s in stagiaires:
                    if s.est_present and not s.est_evalue:
                        tous_evalues = False
                        break

                consultant_info = ConsultantInfo(
                    id_consultant=id_consultant,
                    nom=nom_consultant,
                    prenom=prenom_consultant,
                )

                return ContextResponse(
                    id_action_formation=id_action_formation,
                    titre_formation=titre_formation,
                    consultant=consultant_info,
                    stagiaires=stagiaires,
                    tous_stagiaires_evalues=tous_evalues,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.get(
    "/validation_acquis/stagiaire/{id_action_formation_effectif}",
    response_model=StagiaireDetailResponse,
)
def get_stagiaire_detail(id_action_formation_effectif: str):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Infos stagiaire + action + formation + consultant
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation_effectif,
                        afe.id_action_formation,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.civilite_effectif,
                        ec.id_ent,
                        af.id_consultant,
                        c.nom AS nom_consultant,
                        c.prenom AS prenom_consultant,
                        ff.id_form,
                        ff.titre AS titre_formation
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = afe.id_action_formation
                    JOIN public.tbl_fiche_formation ff
                        ON ff.id_form = af.id_form
                    JOIN public.tbl_effectif_client ec
                        ON ec.id_effectif = afe.id_effectif
                    LEFT JOIN public.tbl_consultant c
                        ON c.id_consultant = af.id_consultant
                    WHERE afe.id_action_formation_effectif = %s
                      AND afe.archive = FALSE
                      AND af.archive = FALSE
                    """,
                    (id_action_formation_effectif,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=404,
                        detail="Stagiaire ou action introuvable",
                    )

                id_afe = row["id_action_formation_effectif"]
                id_action_formation = row["id_action_formation"]
                nom_eff = row["nom_effectif"]
                prenom_eff = row["prenom_effectif"]
                civilite_eff = row["civilite_effectif"]
                id_ent = row["id_ent"]
                id_consultant = row["id_consultant"]
                nom_consultant = row["nom_consultant"]
                prenom_consultant = row["prenom_consultant"]
                id_form = row["id_form"]
                titre_formation = row["titre_formation"]

                # TODO : récupérer nom entreprise via id_ent si besoin
                entreprise = None

                consultant_info = ConsultantInfo(
                    id_consultant=id_consultant,
                    nom=nom_consultant,
                    prenom=prenom_consultant,
                )

                # 2) Compétences stagiaires de la fiche formation
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
                if row_comp is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Aucune compétence stagiaire définie pour cette fiche formation",
                    )

                comp_ids_raw = row_comp["competences_stagiaires"]
                comp_ids = _ensure_list_from_json(comp_ids_raw)
                if not comp_ids:
                    raise HTTPException(
                        status_code=400,
                        detail="Liste des compétences stagiaires vide ou invalide",
                    )

                # 3) Charger les compétences
                cur.execute(
                    """
                    SELECT
                        c.id_comp,
                        c.intitule,
                        c.grille_evaluation
                    FROM public.tbl_competence c
                    WHERE c.id_comp = ANY(%s)
                      AND c.masque = FALSE
                    """,
                    (comp_ids,),
                )
                comp_rows = cur.fetchall()
                comp_map = {}
                for crow in comp_rows:
                    comp_map[crow["id_comp"]] = {
                        "intitule": crow["intitule"],
                        "grille_evaluation": crow["grille_evaluation"],
                    }

                # 4) Charger éventuelle évaluation existante
                cur.execute(
                    """
                    SELECT acquis_json, commentaire_consultant
                    FROM public.tbl_action_formation_acquisition
                    WHERE id_action_formation_effectif = %s
                      AND archive = FALSE
                    """,
                    (id_action_formation_effectif,),
                )
                row_acq = cur.fetchone()
                acquis_json_existing = None
                commentaire_consultant = None

                if row_acq:
                    acquis_json_existing = row_acq["acquis_json"]
                    commentaire_consultant = row_acq["commentaire_consultant"]
                    if isinstance(acquis_json_existing, str):
                        try:
                            acquis_json_existing = json.loads(acquis_json_existing)
                        except Exception:
                            acquis_json_existing = None

                # Map (id_comp, code_critere) -> niveau déjà évalué
                eval_map = {}
                if isinstance(acquis_json_existing, dict):
                    for comp in acquis_json_existing.get("competences", []):
                        id_comp_eval = comp.get("id_comp")
                        if not id_comp_eval:
                            continue
                        for crit in comp.get("criteres", []):
                            code = crit.get("code_critere")
                            niveau = crit.get("niveau")
                            if not code or niveau is None:
                                continue
                            eval_map.setdefault(id_comp_eval, {})[code] = niveau

                # 5) Construire la liste des compétences dans l'ordre de comp_ids
                competences_out: List[CompetenceOut] = []

                for cid in comp_ids:
                    comp_data = comp_map.get(cid)
                    if not comp_data:
                        # compétence référencée mais masquée / absente
                        continue

                    intitule = comp_data["intitule"]
                    grille_eval_raw = comp_data["grille_evaluation"]
                    grille = _ensure_list_from_json(grille_eval_raw) if isinstance(grille_eval_raw, str) else None
                    # si grille_eval_raw est déjà dict JSONB:
                    if not grille:
                        try:
                            grille = json.loads(grille_eval_raw) if isinstance(grille_eval_raw, str) else grille_eval_raw or {}
                        except Exception:
                            grille = {}

                    criteres_out: List[CritereOut] = []

                    for i in range(1, 5):
                        code_crit = f"Critere{i}"
                        crit = grille.get(code_crit) if isinstance(grille, dict) else None
                        if not crit:
                            continue
                        nom_crit = crit.get("Nom")
                        if not nom_crit:
                            continue
                        niveaux = crit.get("Eval") or []
                        niveaux = list(niveaux)

                        niveau_sel = None
                        if cid in eval_map and code_crit in eval_map[cid]:
                            niveau_sel = eval_map[cid][code_crit]

                        criteres_out.append(
                            CritereOut(
                                code_critere=code_crit,
                                nom_critere=nom_crit,
                                niveaux=niveaux,
                                niveau_selectionne=niveau_sel,
                            )
                        )

                    if not criteres_out:
                        continue

                    competences_out.append(
                        CompetenceOut(
                            id_comp=cid,
                            titre_competence=intitule,
                            criteres=criteres_out,
                        )
                    )

                return StagiaireDetailResponse(
                    id_action_formation_effectif=id_afe,
                    id_action_formation=id_action_formation,
                    civilite=civilite_eff,
                    nom=nom_eff,
                    prenom=prenom_eff,
                    entreprise=entreprise,
                    titre_formation=titre_formation,
                    consultant=consultant_info,
                    competences=competences_out,
                    commentaire_consultant=commentaire_consultant,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post(
    "/validation_acquis/save",
    response_model=SaveEvaluationResponse,
)
def save_evaluation(payload: SaveEvaluationRequest):
    if not payload.competences:
        raise HTTPException(status_code=400, detail="Aucune compétence fournie")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # 1) Récupérer id_action_formation et id_consultant
                cur.execute(
                    """
                    SELECT
                        afe.id_action_formation,
                        af.id_consultant
                    FROM public.tbl_action_formation_effectif afe
                    JOIN public.tbl_action_formation af
                        ON af.id_action_formation = afe.id_action_formation
                    WHERE afe.id_action_formation_effectif = %s
                      AND afe.archive = FALSE
                      AND af.archive = FALSE
                    """,
                    (payload.id_action_formation_effectif,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Action de formation ou stagiaire introuvable pour cette évaluation",
                    )

                id_action_formation = row["id_action_formation"]
                id_consultant = row["id_consultant"]

                # 2) Charger les compétences mentionnées
                comp_ids = [c.id_comp for c in payload.competences]
                cur.execute(
                    """
                    SELECT
                        c.id_comp,
                        c.intitule,
                        c.grille_evaluation
                    FROM public.tbl_competence c
                    WHERE c.id_comp = ANY(%s)
                      AND c.masque = FALSE
                    """,
                    (comp_ids,),
                )
                comp_rows = cur.fetchall()
                comp_map = {}
                for crow in comp_rows:
                    comp_map[crow["id_comp"]] = {
                        "intitule": crow["intitule"],
                        "grille_evaluation": crow["grille_evaluation"],
                    }

                for cid in comp_ids:
                    if cid not in comp_map:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Compétence {cid} introuvable ou masquée",
                        )

                # 3) Reconstruire acquis_json
                competences_json = []

                for comp_in in payload.competences:
                    cid = comp_in.id_comp
                    comp_data = comp_map[cid]
                    intitule = comp_data["intitule"]
                    grille_eval_raw = comp_data["grille_evaluation"]

                    # grille_evaluation peut être texte JSON ou JSONB natif
                    if isinstance(grille_eval_raw, (dict, list)):
                        grille = grille_eval_raw
                    else:
                        try:
                            grille = json.loads(grille_eval_raw) if grille_eval_raw else {}
                        except Exception:
                            raise HTTPException(
                                status_code=500,
                                detail=f"Grille d'évaluation invalide pour la compétence {cid}",
                            )

                    if not isinstance(grille, dict):
                        grille = {}

                    # Map des critères définis côté compétence
                    criteres_def = {}
                    for i in range(1, 5):
                        code_crit = f"Critere{i}"
                        crit = grille.get(code_crit)
                        if not crit:
                            continue
                        nom_crit = crit.get("Nom")
                        niveaux = crit.get("Eval") or []
                        if not nom_crit:
                            continue
                        criteres_def[code_crit] = {
                            "nom": nom_crit,
                            "niveaux": list(niveaux),
                        }

                    criteres_json = []

                    for crit_in in comp_in.criteres:
                        code = crit_in.code_critere
                        niveau = crit_in.niveau

                        if code not in criteres_def:
                            raise HTTPException(
                                status_code=400,
                                detail=f"Critère {code} non défini pour la compétence {cid}",
                            )
                        if niveau < 1 or niveau > 4:
                            raise HTTPException(
                                status_code=400,
                                detail=f"Niveau {niveau} invalide pour {code} (1 à 4)",
                            )

                        nom_crit = criteres_def[code]["nom"]
                        niveaux = criteres_def[code]["niveaux"]
                        libelle_niveau = None
                        if len(niveaux) >= niveau:
                            libelle_niveau = niveaux[niveau - 1]

                        criteres_json.append(
                            {
                                "code_critere": code,
                                "nom_critere": nom_crit,
                                "niveau": niveau,
                                "libelle_niveau": libelle_niveau,
                            }
                        )

                    if not criteres_json:
                        continue

                    competences_json.append(
                        {
                            "id_comp": cid,
                            "titre_competence": intitule,
                            "criteres": criteres_json,
                        }
                    )

                if not competences_json:
                    raise HTTPException(
                        status_code=400,
                        detail="Aucun critère valide dans la demande",
                    )

                acquis_json = {
                    "id_action_formation": id_action_formation,
                    "id_action_formation_effectif": payload.id_action_formation_effectif,
                    "id_consultant": id_consultant,
                    "competences": competences_json,
                }

                acquis_json_str = json.dumps(acquis_json, ensure_ascii=False)

                # 4) INSERT ou UPDATE
                cur.execute(
                    """
                    SELECT id_action_formation_acquisition
                    FROM public.tbl_action_formation_acquisition
                    WHERE id_action_formation_effectif = %s
                      AND archive = FALSE
                    """,
                    (payload.id_action_formation_effectif,),
                )
                row_acq = cur.fetchone()

                if row_acq:
                    id_acq = row_acq["id_action_formation_acquisition"]
                    cur.execute(
                        """
                        UPDATE public.tbl_action_formation_acquisition
                        SET acquis_json = %s,
                            commentaire_consultant = %s,
                            date_derniere_modif = NOW()
                        WHERE id_action_formation_acquisition = %s
                        """,
                        (acquis_json_str, payload.commentaire_consultant, id_acq),
                    )
                    message = "Évaluation mise à jour"
                else:
                    id_acq = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_action_formation_acquisition (
                            id_action_formation_acquisition,
                            id_action_formation,
                            id_action_formation_effectif,
                            id_consultant,
                            date_evaluation,
                            date_derniere_modif,
                            acquis_json,
                            commentaire_consultant,
                            archive
                        ) VALUES (
                            %s, %s, %s, %s, NOW(), NOW(), %s, %s, FALSE
                        )
                        """,
                        (
                            id_acq,
                            id_action_formation,
                            payload.id_action_formation_effectif,
                            id_consultant,
                            acquis_json_str,
                            payload.commentaire_consultant,
                        ),
                    )
                    message = "Évaluation enregistrée"

                conn.commit()
                save_cache(payload)

                return SaveEvaluationResponse(
                    id_action_formation_acquisition=id_acq,
                    message=message,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
