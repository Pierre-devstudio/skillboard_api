from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import os

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
app_local = FastAPI(title="Skillboard - Portail Consultant API")

app_local.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://consultants.jmbconsultant.fr",
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
class ConsultantContext(BaseModel):
    id_consultant: str
    civilite: Optional[str] = None
    prenom: str
    nom: str


class ConsultantProfile(BaseModel):
    id_consultant: str

    # Modifiables par le consultant
    civilite: Optional[str] = None
    prenom: str
    nom: str
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone_mobile: Optional[str] = None
    adresse_1: Optional[str] = None
    adresse_2: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None

    # Non modifiables
    type_consultant: str
    entreprise_nom: Optional[str] = None
    cout_horaire: Optional[float] = None
    cout_supp_deplacement: Optional[float] = None
    cout_supp: Optional[float] = None

    # Affichage (photo)
    photo_url: Optional[str] = None


class ConsultantProfileUpdate(BaseModel):
    civilite: Optional[str] = None
    prenom: str
    nom: str
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone_mobile: Optional[str] = None
    adresse_1: Optional[str] = None
    adresse_2: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None
    # photo_url exclue pour l’instant (gestion upload plus tard)


class CityOption(BaseModel):
    code_postal: str
    ville: str
    code_insee: Optional[str] = None


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
# Helpers SQL
# ======================================================
def fetch_consultant_with_entreprise(cur, id_consultant: str):
    """
    Récupère la ligne consultant + nom d'entreprise (client ou fournisseur).
    Retourne (row_consultant: dict, entreprise_nom: Optional[str])
    """
    cur.execute(
        """
        SELECT
            c.id_consultant,
            c.civilite,
            c.prenom,
            c.nom,
            c.email,
            c.telephone,
            c.telephone_mobile,
            c.adresse_1,
            c.adresse_2,
            c.code_postal,
            c.ville,
            c.type_consultant,
            c.cout_horaire,
            c.cout_supp_deplacement,
            c.cout_supp,
            c.photo_url,
            c.id_ent,
            c.id_fourn
        FROM public.tbl_consultant c
        WHERE c.id_consultant = %s
          AND c.actif = TRUE
        """,
        (id_consultant,),
    )
    row = cur.fetchone()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Consultant introuvable ou inactif.",
        )

    entreprise_nom = None

    # Priorité à l'entreprise cliente
    if row.get("id_ent"):
        cur.execute(
            """
            SELECT nom_ent
            FROM public.tbl_entreprise
            WHERE id_ent = %s              
            """,
            (row["id_ent"],),
        )
        e = cur.fetchone()
        if e:
            entreprise_nom = e.get("nom_ent")

    # Sinon fournisseur
    if entreprise_nom is None and row.get("id_fourn"):
        cur.execute(
            """
            SELECT nom
            FROM public.tbl_fournisseur
            WHERE id_fourn = %s              
            """,
            (row["id_fourn"],),
        )
        f = cur.fetchone()
        if f:
            entreprise_nom = f.get("nom")

    return row, entreprise_nom


# ======================================================
# Endpoints
# ======================================================
@app_local.api_route("/consultant/healthz", methods=["GET", "HEAD"])
def healthz():
    return {"status": "ok"}


@app_local.get(
    "/consultant/context/{id_consultant}",
    response_model=ConsultantContext,
)
def get_consultant_context(id_consultant: str):
    """
    Contexte minimal pour le dashboard / topbar :
    id, civilité, prénom, nom.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row, _ = fetch_consultant_with_entreprise(cur, id_consultant)

        return ConsultantContext(
            id_consultant=row["id_consultant"],
            civilite=row.get("civilite"),
            prenom=row["prenom"],
            nom=row["nom"],
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.get(
    "/consultant/profile/{id_consultant}",
    response_model=ConsultantProfile,
)
def get_consultant_profile(id_consultant: str):
    """
    Profil complet consultant pour la page 'Vos données'.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row, entreprise_nom = fetch_consultant_with_entreprise(cur, id_consultant)

        return ConsultantProfile(
            id_consultant=row["id_consultant"],
            civilite=row.get("civilite"),
            prenom=row["prenom"],
            nom=row["nom"],
            email=row.get("email"),
            telephone=row.get("telephone"),
            telephone_mobile=row.get("telephone_mobile"),
            adresse_1=row.get("adresse_1"),
            adresse_2=row.get("adresse_2"),
            code_postal=row.get("code_postal"),
            ville=row.get("ville"),
            type_consultant=row["type_consultant"],
            entreprise_nom=entreprise_nom,
            cout_horaire=row.get("cout_horaire"),
            cout_supp_deplacement=row.get("cout_supp_deplacement"),
            cout_supp=row.get("cout_supp"),
            photo_url=row.get("photo_url"),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.post("/consultant/profile/{id_consultant}")
def update_consultant_profile(
    id_consultant: str,
    payload: ConsultantProfileUpdate,
):
    """
    Mise à jour des champs modifiables par le consultant.
    (identité + coordonnées / adresse)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    UPDATE public.tbl_consultant
                    SET civilite          = %s,
                        prenom            = %s,
                        nom               = %s,
                        email             = %s,
                        telephone         = %s,
                        telephone_mobile  = %s,
                        adresse_1         = %s,
                        adresse_2         = %s,
                        code_postal       = %s,
                        ville             = %s,
                        date_modification = CURRENT_DATE
                    WHERE id_consultant = %s
                      AND actif = TRUE
                    """,
                    (
                        payload.civilite,
                        payload.prenom,
                        payload.nom,
                        payload.email,
                        payload.telephone,
                        payload.telephone_mobile,
                        payload.adresse_1,
                        payload.adresse_2,
                        payload.code_postal,
                        payload.ville,
                        id_consultant,
                    ),
                )

                if cur.rowcount == 0:
                    raise HTTPException(
                        status_code=404,
                        detail="Consultant introuvable ou inactif.",
                    )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@app_local.get(
    "/consultant/villes_par_cp/{code_postal}",
    response_model=List[CityOption],
)
def get_villes_par_code_postal(code_postal: str):
    """
    Retourne la liste des villes possibles pour un code postal donné,
    d'après public.tbl_code_postal.
    """
    try:
        code_postal = (code_postal or "").strip()
        if not code_postal:
            return []

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        code_postal,
                        ville,
                        code_insee
                    FROM public.tbl_code_postal
                    WHERE code_postal = %s
                    ORDER BY ville
                    """,
                    (code_postal,),
                )
                rows = cur.fetchall() or []

        return [
            CityOption(
                code_postal=r.get("code_postal") or "",
                ville=r.get("ville") or "",
                code_insee=r.get("code_insee"),
            )
            for r in rows
            if r.get("ville")
        ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
