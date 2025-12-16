from fastapi import HTTPException
from typing import Optional
import os
import pathlib
import requests

import psycopg
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


def build_consultant_root_path(
    nom: str,
    prenom: str,
    code_consultant: Optional[str],
    id_consultant: str,
) -> str:
    """
    Construit le chemin racine SharePoint pour un consultant :

    Documents_SKILLBOARD/Dossiers Qualité/04-Documents Consultants/Nom_Prenom_CodeConsultant

    Si code_consultant est vide, fallback sur id_consultant.
    """
    safe_nom = (nom or "").strip().replace("/", "-").replace("\\", "-").replace(" ", "_")
    safe_prenom = (prenom or "").strip().replace("/", "-").replace("\\", "-").replace(" ", "_")
    safe_code = (code_consultant or "").strip().replace("/", "-").replace("\\", "-").replace(" ", "_")

    parts = []
    if safe_nom:
        parts.append(safe_nom)
    if safe_prenom:
        parts.append(safe_prenom)

    if safe_code:
        parts.append(safe_code)
    else:
        parts.append(id_consultant)

    folder_name = "_".join(parts) if parts else id_consultant

    return (
        "Documents_SKILLBOARD/Dossiers Qualité/04-Documents Consultants/"
        f"{folder_name}"
    )


def upload_consultant_document_to_sharepoint(
    *,
    id_consultant: str,
    nom: str,
    prenom: str,
    code_consultant: Optional[str],
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

    root = build_consultant_root_path(nom, prenom, code_consultant, id_consultant)

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
        return js.get("@microsoft.graph.downloadUrl") or js.get("webUrl") or remote_path
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
            c.id_fourn,
            c.code_consultant
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
