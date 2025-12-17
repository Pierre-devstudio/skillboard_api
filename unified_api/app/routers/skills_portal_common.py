from fastapi import HTTPException
from typing import Optional, List, Dict, Any
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
# Constantes SharePoint
# ======================================================
SKILLS_ROOT_BASE = "Documents_SKILLBOARD/Dossiers Clients/05-Pole_SKILLS"


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


def _sp_safe_name(value: Optional[str]) -> str:
    """
    Nettoyage minimal pour un nom de dossier/fichier SharePoint.
    """
    v = (value or "").strip()
    v = v.replace("/", "-").replace("\\", "-")
    v = v.replace(" ", "_")
    return v


def join_sp_path(*parts: str) -> str:
    """
    Concatène des segments SharePoint en évitant les //.
    """
    cleaned = []
    for p in parts:
        if p is None:
            continue
        s = str(p).strip().strip("/")
        if s:
            cleaned.append(s)
    return "/".join(cleaned)


def build_skills_ent_root_path(
    nom_ent: str,
    num_entreprise: Optional[str],
    id_ent: str,
) -> str:
    """
    Construit le chemin racine SharePoint Skills pour une entreprise :

    Documents_SKILLBOARD/Dossiers Clients/05-Pole_SKILLS/NomEntreprise_NumEntreprise

    Fallback : si num_entreprise est vide => id_ent.
    """
    safe_nom = _sp_safe_name(nom_ent)
    safe_code = _sp_safe_name(num_entreprise) if num_entreprise else ""
    if not safe_code:
        safe_code = _sp_safe_name(id_ent)

    folder_name = f"{safe_nom}_{safe_code}" if safe_nom else safe_code
    return join_sp_path(SKILLS_ROOT_BASE, folder_name)


def sp_list_children(remote_folder_path: str) -> List[Dict[str, Any]]:
    """
    Liste les enfants d'un dossier SharePoint (drive/root:/path:/children).
    Retourne la liste brute des items Graph.
    """
    _ensure_sharepoint_env()
    token = get_sp_token()

    base = "https://graph.microsoft.com/v1.0"
    url = f"{base}/sites/{SP_SITE_ID}/drive/root:/{remote_folder_path}:/children"

    headers = {"Authorization": f"Bearer {token}"}

    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=500,
                detail=f"Erreur liste dossier SharePoint : {r.status_code} {r.text}",
            )
        js = r.json()
        return js.get("value", [])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur liste SharePoint : {e}")


def sp_get_item(remote_path: str) -> Dict[str, Any]:
    """
    Récupère les métadonnées d'un item (fichier/dossier) par chemin.
    """
    _ensure_sharepoint_env()
    token = get_sp_token()

    base = "https://graph.microsoft.com/v1.0"
    url = f"{base}/sites/{SP_SITE_ID}/drive/root:/{remote_path}"

    headers = {"Authorization": f"Bearer {token}"}

    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=500,
                detail=f"Erreur item SharePoint : {r.status_code} {r.text}",
            )
        return r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur item SharePoint : {e}")


def sp_download_file(remote_file_path: str) -> bytes:
    """
    Télécharge un fichier par chemin (drive/root:/path:/content).
    Retourne les bytes.
    """
    _ensure_sharepoint_env()
    token = get_sp_token()

    base = "https://graph.microsoft.com/v1.0"
    url = f"{base}/sites/{SP_SITE_ID}/drive/root:/{remote_file_path}:/content"

    headers = {"Authorization": f"Bearer {token}"}

    try:
        r = requests.get(url, headers=headers, timeout=60)
        if r.status_code >= 400:
            raise HTTPException(
                status_code=500,
                detail=f"Erreur download SharePoint : {r.status_code} {r.text}",
            )
        return r.content
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur download SharePoint : {e}")


def upload_enterprise_document_to_sharepoint(
    *,
    nom_ent: str,
    num_entreprise: Optional[str],
    id_ent: str,
    logical_name: str,
    filename: Optional[str],
    content_type: Optional[str],
    data: bytes,
    base_path: Optional[str] = None,
) -> str:
    """
    Upload générique d'un fichier entreprise.

    - Si base_path est None : upload dans le dossier Skills de l'entreprise.
    - Sinon : upload dans base_path (utile si tu veux viser un autre espace type "Dossiers Compta").

    logical_name = préfixe logique du fichier (ex: 'facture_{id}', 'plan_actions', ...)

    Retourne une URL de téléchargement (downloadUrl ou webUrl), sinon le chemin brut.
    """
    _ensure_sharepoint_env()

    root = base_path if base_path else build_skills_ent_root_path(nom_ent, num_entreprise, id_ent)

    ext = pathlib.Path(filename or "").suffix
    if not ext:
        ext = ".bin"

    remote_path = join_sp_path(root, f"{logical_name}{ext}")

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
def fetch_contact_with_entreprise(cur, id_contact: str):
    """
    Récupère le contact + entreprise associée (code_ent = id_ent).

    Validité:
    - Contact: COALESCE(masque, FALSE) = FALSE
    - Entreprise: COALESCE(masque, FALSE) = FALSE
    - Contrat Skills: COALESCE(contrat_skills, FALSE) = TRUE

    Retourne: (row_contact: dict, row_entreprise: dict)
    """
    cur.execute(
        """
        SELECT
            c.id_contact,
            c.code_ent AS id_ent,
            c.civ_ca,
            c.nom_ca,
            c.prenom_ca,
            c.role_ca,
            c.tel_ca,
            c.tel2_ca,
            c.mail_ca,
            c.obs_ca,
            c.created_at,
            c.masque,
            c.est_principal,

            e.nom_ent,
            e.num_entreprise,
            e.adresse_ent,
            e.adresse_cplt_ent,
            e.cp_ent,
            e.ville_ent,
            e.pays_ent,
            e.email_ent,
            e.telephone_ent,
            e.siret_ent,
            e.code_ape_ent,
            e.num_tva_ent,
            e.effectif_ent,
            e.id_opco,
            e.date_creation,
            e.type_entreprise,
            e.masque AS masque_ent,
            e.site_web,
            e.idcc,
            e.nom_groupe,
            e.type_groupe,
            e.tete_groupe,
            e.group_ok,
            e.contrat_skills
        FROM public.tbl_contact c
        JOIN public.tbl_entreprise e ON e.id_ent = c.code_ent
        WHERE c.id_contact = %s
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(e.masque, FALSE) = FALSE
          AND COALESCE(e.contrat_skills, FALSE) = TRUE
        """,
        (id_contact,),
    )
    row = cur.fetchone()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Contact introuvable, masqué, ou entreprise non éligible Skills.",
        )

    # On sépare en 2 dictionnaires pour éviter les collisions de noms
    row_contact = {
        "id_contact": row.get("id_contact"),
        "id_ent": row.get("id_ent"),
        "civ_ca": row.get("civ_ca"),
        "nom_ca": row.get("nom_ca"),
        "prenom_ca": row.get("prenom_ca"),
        "role_ca": row.get("role_ca"),
        "tel_ca": row.get("tel_ca"),
        "tel2_ca": row.get("tel2_ca"),
        "mail_ca": row.get("mail_ca"),
        "obs_ca": row.get("obs_ca"),
        "created_at": row.get("created_at"),
        "masque": row.get("masque"),
        "est_principal": row.get("est_principal"),
    }

    row_entreprise = {
        "id_ent": row.get("id_ent"),
        "nom_ent": row.get("nom_ent"),
        "num_entreprise": row.get("num_entreprise"),
        "adresse_ent": row.get("adresse_ent"),
        "adresse_cplt_ent": row.get("adresse_cplt_ent"),
        "cp_ent": row.get("cp_ent"),
        "ville_ent": row.get("ville_ent"),
        "pays_ent": row.get("pays_ent"),
        "email_ent": row.get("email_ent"),
        "telephone_ent": row.get("telephone_ent"),
        "siret_ent": row.get("siret_ent"),
        "code_ape_ent": row.get("code_ape_ent"),
        "num_tva_ent": row.get("num_tva_ent"),
        "effectif_ent": row.get("effectif_ent"),
        "id_opco": row.get("id_opco"),
        "date_creation": row.get("date_creation"),
        "type_entreprise": row.get("type_entreprise"),
        "masque": row.get("masque_ent"),
        "site_web": row.get("site_web"),
        "idcc": row.get("idcc"),
        "nom_groupe": row.get("nom_groupe"),
        "type_groupe": row.get("type_groupe"),
        "tete_groupe": row.get("tete_groupe"),
        "group_ok": row.get("group_ok"),
        "contrat_skills": row.get("contrat_skills"),
    }

    return row_contact, row_entreprise
