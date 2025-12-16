from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import os
import requests
import pathlib

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

SP_TENANT_ID = os.getenv("SP_TENANT_ID")
SP_CLIENT_ID = os.getenv("SP_CLIENT_ID")
SP_CLIENT_SECRET = os.getenv("SP_CLIENT_SECRET")
SP_SITE_ID = os.getenv("SP_SITE_ID")


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
    # photo_url exclue : gérée par l'endpoint d'upload


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
# SharePoint / Graph (générique, réutilisable)
# ======================================================
def _ensure_sharepoint_env():
    missing = [
        k
        for k, v in {
            "SP_TENANT_ID": SP_TENANT_ID,
            "SP_CLIENT_ID": SP_CLIENT_ID,
            "SP_CLIENT_SECRET": SP_CLIENT_SECRET,
            "SP_SITE_ID": SP_SITE_ID,            
        }.items()
        if not v
    ]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Paramètres SharePoint manquants: {', '.join(missing)}",
        )


def get_sp_token() -> str:
    """
    Récupère un token d'accès Graph pour SharePoint.
    """
    _ensure_sharepoint_env()
    url = f"https://login.microsoftonline.com/{SP_TENANT_ID}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": SP_CLIENT_ID,
        "client_secret": SP_CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default",
    }
    try:
        r = requests.post(url, data=data, timeout=20)
        r.raise_for_status()
        js = r.json()
        token = js.get("access_token")
        if not token:
            raise HTTPException(status_code=500, detail="Token SharePoint manquant")
        return token
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur token SharePoint : {e}")


def build_consultant_root_path(prenom: str, nom: str, id_consultant: str) -> str:
    """
    Construit le chemin racine SharePoint pour un consultant :
    Documents_SKILLBOARD/Dossiers Qualité/04-Documents Consultants/{Prenom Nom}
    """
    safe_name = f"{prenom.strip()} {nom.strip()}".strip() or id_consultant
    safe_name = safe_name.replace("/", "-").replace("\\", "-")
    return (
        "Documents_SKILLBOARD/Dossiers Qualité/04-Documents Consultants/"
        f"{safe_name}"
    )


def upload_consultant_document_to_sharepoint(
    *,
    id_consultant: str,
    nom: str,
    prenom: str,
    logical_name: str,
    filename: Optional[str],
    content_type: Optional[str],
    data: bytes,
) -> str:
    """
    Upload générique d'un fichier consultant dans son dossier dédié.

    logical_name = préfixe logique du fichier (ex: 'photo_{id_consultant}', 'cv', ...)

    Retourne une URL de téléchargement (downloadUrl ou webUrl), sinon le chemin brut.
    """
    _ensure_sharepoint_env()

    # Racine du consultant
    root = build_consultant_root_path(prenom, nom, id_consultant)

    # Extension du fichier (ou défaut)
    ext = pathlib.Path(filename or "").suffix
    if not ext:
        ext = ".bin"

    remote_path = f"{root}/{logical_name}{ext}"

    token = get_sp_token()
    base = "https://graph.microsoft.com/v1.0"
    upload_url = f"{base}/sites/{SP_SITE_ID}/drive/root:/{remote_path}:/content"
    

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type or "application/octet-stream",
    }

    try:
        r = requests.put(upload_url, headers=headers, data=data, timeout=60)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=500,
                detail=f"Erreur upload SharePoint : {r.status_code} {r.text}",
            )
        js = r.json()
        return (
            js.get("@microsoft.graph.downloadUrl")
            or js.get("webUrl")
            or remote_path
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur upload SharePoint : {e}")


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
# Upload photo consultant (SharePoint)
# ======================================================
@app_local.post("/consultant/photo/{id_consultant}")
async def upload_consultant_photo(
    id_consultant: str,
    file: UploadFile = File(...),
):
    """
    Réceptionne la photo du consultant, l'envoie sur SharePoint
    dans son dossier dédié, et met à jour tbl_consultant.photo_url.
    """
    if not file:
        raise HTTPException(status_code=400, detail="Fichier manquant")

    # On vérifie le consultant et on récupère nom / prénom
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            row, _ = fetch_consultant_with_entreprise(cur, id_consultant)

    nom = row["nom"] or ""
    prenom = row["prenom"] or ""

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Fichier vide")

    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fichier trop volumineux (max 5 Mo)")

    # Upload générique consultant (préfixe logique "photo_{id_consultant}")
    logical_name = f"photo_{id_consultant}"
    photo_url = upload_consultant_document_to_sharepoint(
        id_consultant=id_consultant,
        nom=nom,
        prenom=prenom,
        logical_name=logical_name,
        filename=file.filename,
        content_type=file.content_type,
        data=data,
    )

    # Mise à jour BD
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.tbl_consultant
                SET photo_url = %s,
                    date_modification = CURRENT_DATE
                WHERE id_consultant = %s
                  AND actif = TRUE
                """,
                (photo_url, id_consultant),
            )
            if cur.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail="Consultant introuvable ou inactif.",
                )
            conn.commit()

    return {"ok": True, "photo_url": photo_url}


# ======================================================
# Export pour l'app unifiée
# ======================================================
router = app_local
