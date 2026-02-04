from fastapi import HTTPException
from typing import Optional, List, Dict, Any
import os
import pathlib
import requests

import psycopg
from dotenv import load_dotenv
import threading
import queue
import time

import logging
import contextvars

_log = logging.getLogger("skills_pool")

_current_endpoint = contextvars.ContextVar("current_endpoint", default="?")

_db_in_use = 0
_db_waits = 0
_db_timeouts = 0
_db_discarded = 0


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
# Supabase Auth (Skills)
# ======================================================
SKILLS_SUPABASE_URL = os.getenv("SKILLS_SUPABASE_URL")
SKILLS_SUPABASE_ANON_KEY = os.getenv("SKILLS_SUPABASE_ANON_KEY")

# Emails super admin (séparés par virgule)
# Exemple: "pierre@xxx.fr, admin@xxx.fr"
SKILLS_SUPER_ADMIN_EMAILS = os.getenv("SKILLS_SUPER_ADMIN_EMAILS", "")


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


# ======================================================
# Pool DB (simple, fiable, sans dépendance externe)
# - Evite de saturer Supabase pooler (session mode)
# - Limite strictement le nb de connexions ouvertes
# ======================================================
_DB_POOL_MAX = int(os.getenv("DB_POOL_SIZE", "3") or 3)
_DB_POOL_TIMEOUT = float(os.getenv("DB_POOL_TIMEOUT", "10") or 10)

_db_pool = queue.LifoQueue(maxsize=_DB_POOL_MAX)
_db_pool_lock = threading.Lock()
_db_pool_created = 0

def _pool_stats() -> dict:
    try:
        avail = _db_pool.qsize()
    except Exception:
        avail = -1
    return {
        "max": _DB_POOL_MAX,
        "created": _db_pool_created,
        "in_use": _db_in_use,
        "available": avail,
        "waits": _db_waits,
        "timeouts": _db_timeouts,
        "discarded": _db_discarded,
        "endpoint": _current_endpoint.get(),
    }

def _discard_conn(conn, reason: str):
    global _db_pool_created, _db_discarded
    try:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    finally:
        with _db_pool_lock:
            if _db_pool_created > 0:
                _db_pool_created -= 1
            _db_discarded += 1
        try:
            _log.error(f"[DB_POOL] DISCARD reason={reason} stats={_pool_stats()}")
        except Exception:
            pass

def _is_pooler_saturated(err: Exception) -> bool:
    msg = str(err) if err is not None else ""
    m = msg.lower()
    return ("maxclientsinsessionmode" in msg) or ("max clients reached" in m) or ("pool_size" in m)


def _create_conn():
    # Retry court UNIQUEMENT si pooler saturé (session mode / pool_size)
    delays = [0.0, 0.3, 0.7, 1.2]  # ~2.2s max
    last_err = None

    for d in delays:
        if d > 0:
            time.sleep(d)
        try:
            return psycopg.connect(
                host=DB_HOST,
                port=DB_PORT,
                dbname=DB_NAME,
                user=DB_USER,
                password=DB_PASSWORD,
                sslmode="require",
                connect_timeout=10,
            )
        except Exception as e:
            last_err = e
            if not _is_pooler_saturated(e):
                raise HTTPException(status_code=500, detail=f"Erreur connexion DB: {e}")

    raise HTTPException(status_code=503, detail=f"DB saturée (pooler). Réessaie. {last_err}")



class _ConnCtx:
    def __init__(self):
        self.conn = None

    def __enter__(self):
        global _db_pool_created
        global _db_in_use, _db_waits, _db_timeouts

        t0 = time.time()


        missing = _missing_env()
        if missing:
            raise HTTPException(
                status_code=500,
                detail=f"Variables manquantes: {', '.join(missing)}",
            )

        # 1) Récupérer une connexion disponible (et vérifier qu'elle est vivante)
        try:
            self.conn = _db_pool.get_nowait()
        except Exception:
            self.conn = None

        if self.conn is not None:
            try:
                # Conn déjà fermée ?
                if getattr(self.conn, "closed", False):
                    _discard_conn(self.conn, "already_closed")
                    self.conn = None

                else:
                    # Ping minimal
                    with self.conn.cursor() as cur:
                        cur.execute("select 1;")

                    with _db_pool_lock:
                        _db_in_use += 1

                    waited_ms = int((time.time() - t0) * 1000)
                    if waited_ms >= 200:
                        _log.error(f"[DB_POOL] ACQUIRE waited_ms={waited_ms} stats={_pool_stats()}")                    

                    return self.conn
            except Exception:
                # Conn morte -> on la jette (et on décrémente created)
                _discard_conn(self.conn, "ping_failed")
                self.conn = None


        # 2) Sinon, en créer une si on n’a pas atteint la limite
        with _db_pool_lock:
            if _db_pool_created < _DB_POOL_MAX:
                self.conn = _create_conn()
                _db_pool_created += 1
                _db_in_use += 1

                waited_ms = int((time.time() - t0) * 1000)
                if waited_ms >= 200:
                    _log.error(f"[DB_POOL] ACQUIRE waited_ms={waited_ms} stats={_pool_stats()}")

                return self.conn



        # 3) Sinon, attendre qu’une connexion se libère
        try:
            with _db_pool_lock:
                _db_waits += 1

            self.conn = _db_pool.get(timeout=_DB_POOL_TIMEOUT)

            # Conn récupérée: vérifier qu'elle est vivante (sinon discard + continuer à attendre)
            try:
                if getattr(self.conn, "closed", False):
                    _discard_conn(self.conn, "wait_got_closed")
                    self.conn = None
                    raise Exception("wait_got_closed")

                with self.conn.cursor() as cur:
                    cur.execute("select 1;")
            except Exception:
                _discard_conn(self.conn, "wait_ping_failed")
                self.conn = None
                raise Exception("wait_ping_failed")

            with _db_pool_lock:
                _db_in_use += 1

            waited_ms = int((time.time() - t0) * 1000)
            if waited_ms >= 200:
                _log.error(f"[DB_POOL] ACQUIRE waited_ms={waited_ms} stats={_pool_stats()}")

            return self.conn

        except Exception:
            with _db_pool_lock:
                _db_timeouts += 1
            _log.error(f"[DB_POOL] TIMEOUT wait_s={_DB_POOL_TIMEOUT} stats={_pool_stats()}")

            raise HTTPException(
                status_code=503,
                detail="DB saturée (pool complet). Réessaie dans quelques secondes.",
            )


    def __exit__(self, exc_type, exc, tb):
        # On remet la connexion dans le pool si elle est saine
        try:
            global _db_in_use

            if self.conn is None:
                return False

            # Nettoyage transaction: rollback systématique (évite transaction "idle in transaction")
            try:
                self.conn.rollback()
            except Exception:
                pass


            # Conn cassée / fermée -> on la jette
            try:
                if getattr(self.conn, "closed", False):
                    _discard_conn(self.conn, "closed_on_exit")
                    return False
            except Exception:
                _discard_conn(self.conn, "closed_check_failed")
                return False

            # Remettre dans le pool (non bloquant)
            try:
                _db_pool.put_nowait(self.conn)
            except Exception:
                _discard_conn(self.conn, "put_nowait_failed")


        finally:
            try:
                with _db_pool_lock:
                    if _db_in_use > 0:
                        _db_in_use -= 1
            except Exception:
                pass

            self.conn = None

        return False


def get_conn():
    # Conserve l’API existante: "with get_conn() as conn:"
    return _ConnCtx()



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
def fetch_effectif_with_entreprise(cur, id_effectif: str):
    """
    Récupère l'effectif (tbl_effectif_client) + entreprise associée (id_ent).

    Validité:
    - Effectif: COALESCE(archive, FALSE) = FALSE
    - Entreprise: COALESCE(masque, FALSE) = FALSE
    - Contrat Skills: COALESCE(contrat_skills, FALSE) = TRUE

    Note:
    - On NE filtre PAS sur statut_actif ici : ce champ sert à exclure des analyses,
      pas à bloquer l'accès au portail.

    Retourne: (row_effectif: dict, row_entreprise: dict)
    """
    cur.execute(
        """
        SELECT
            ec.id_effectif,
            ec.id_ent,
            ec.id_service,
            ec.civilite_effectif,
            ec.nom_effectif,
            ec.prenom_effectif,
            ec.email_effectif,
            ec.telephone_effectif,
            ec.note_commentaire,
            ec.date_creation,
            ec.archive,
            ec.ismanager,
            ec.isformateur,
            ec.is_temp,
            ec.role_temp,

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
        FROM public.tbl_effectif_client ec
        JOIN public.tbl_entreprise e ON e.id_ent = ec.id_ent
        WHERE ec.id_effectif = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(e.masque, FALSE) = FALSE
          AND COALESCE(e.contrat_skills, FALSE) = TRUE
        """,
        (id_effectif,),
    )
    row = cur.fetchone()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Effectif introuvable, archivé, ou entreprise non éligible Skills.",
        )

    row_effectif = {
        "id_effectif": row.get("id_effectif"),
        "id_ent": row.get("id_ent"),
        "id_service": row.get("id_service"),
        "civilite_effectif": row.get("civilite_effectif"),
        "nom_effectif": row.get("nom_effectif"),
        "prenom_effectif": row.get("prenom_effectif"),
        "email_effectif": row.get("email_effectif"),
        "telephone_effectif": row.get("telephone_effectif"),
        "note_commentaire": row.get("note_commentaire"),
        "date_creation": row.get("date_creation"),
        "archive": row.get("archive"),
        "ismanager": row.get("ismanager"),
        "isformateur": row.get("isformateur"),
        "is_temp": row.get("is_temp"),
        "role_temp": row.get("role_temp"),
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

    return row_effectif, row_entreprise
# ======================================================
# Supabase Auth helpers
# - Validation "pratique" via /auth/v1/user (pas de JWT local)
# ======================================================
def _skills_is_super_admin(email: str) -> bool:
    e = (email or "").strip().lower()
    if not e:
        return False
    raw = (SKILLS_SUPER_ADMIN_EMAILS or "").strip()
    if not raw:
        return False
    allowed = [x.strip().lower() for x in raw.split(",") if x.strip()]
    return e in allowed


def _skills_extract_bearer_token(authorization: str) -> str:
    a = (authorization or "").strip()
    if not a:
        return ""
    low = a.lower()
    if not low.startswith("bearer "):
        return ""
    return a[7:].strip()


def skills_get_supabase_user(access_token: str) -> dict:
    """
    Récupère l'utilisateur Supabase à partir d'un access token.
    Appel réseau vers Supabase Auth: GET /auth/v1/user
    """
    if not SKILLS_SUPABASE_URL or not SKILLS_SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="Config Supabase Skills manquante côté serveur.")

    tok = (access_token or "").strip()
    if not tok:
        raise HTTPException(status_code=401, detail="Token manquant.")

    url = f"{SKILLS_SUPABASE_URL.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": SKILLS_SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {tok}",
    }

    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code in (401, 403):
            raise HTTPException(status_code=401, detail="Session invalide ou expirée.")
        if r.status_code >= 400:
            raise HTTPException(status_code=500, detail=f"Erreur Supabase Auth: {r.status_code} {r.text}")

        js = r.json() if r.content else {}
        return js or {}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur Supabase Auth: {e}")


def skills_require_user(authorization_header: str) -> dict:
    """
    Retour normalisé:
      {
        "id": "...",
        "email": "...",
        "user_metadata": {...},
        "is_super_admin": bool
      }
    """
    token = _skills_extract_bearer_token(authorization_header)
    user = skills_get_supabase_user(token)

    uid = user.get("id") or ""
    email = (user.get("email") or "").strip()
    meta = user.get("user_metadata") or {}

    return {
        "id": uid,
        "email": email,
        "user_metadata": meta,
        "is_super_admin": _skills_is_super_admin(email),
    }


def skills_list_enterprises(cur) -> list:
    """
    Liste les entreprises éligibles Skills:
    - masque = FALSE
    - contrat_skills = TRUE
    """
    cur.execute(
        """
        SELECT
          id_ent,
          nom_ent,
          num_entreprise
        FROM public.tbl_entreprise
        WHERE COALESCE(masque, FALSE) = FALSE
          AND COALESCE(contrat_skills, FALSE) = TRUE
        ORDER BY nom_ent
        """
    )
    rows = cur.fetchall() or []
    out = []
    for r in rows:
        out.append(
            {
                "id_ent": r.get("id_ent"),
                "nom_ent": r.get("nom_ent"),
                "num_entreprise": r.get("num_entreprise"),
            }
        )
    return out

def skills_validate_enterprise(cur, id_ent: str) -> dict:
    """
    Valide qu'une entreprise est éligible Skills:
    - masque = FALSE
    - contrat_skills = TRUE
    Retourne {id_ent, nom_ent, num_entreprise}
    """
    eid = (id_ent or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="id_ent manquant.")

    cur.execute(
        """
        SELECT
          id_ent,
          nom_ent,
          num_entreprise
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
          AND COALESCE(contrat_skills, FALSE) = TRUE
        LIMIT 1
        """,
        (eid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Entreprise introuvable ou non éligible Skills.")
    return {
        "id_ent": r.get("id_ent"),
        "nom_ent": r.get("nom_ent"),
        "num_entreprise": r.get("num_entreprise"),
    }


def resolve_insights_context(cur, id_effectif: str) -> dict:
    """
    Résout le contexte Insights depuis tbl_effectif_client.
    Retour:
      { "id_effectif": ..., "id_ent": ..., "id_service": ... }

    Règles:
    - effectif non archivé
    - entreprise non masquée
    - contrat_skills = TRUE
    """
    row_eff, _row_ent = fetch_effectif_with_entreprise(cur, id_effectif)

    return {
        "id_effectif": row_eff.get("id_effectif"),
        "id_ent": row_eff.get("id_ent"),
        "id_service": row_eff.get("id_service"),
    }


def fetch_contact_with_entreprise(cur, id_contact: str):
    """
    COMPAT: l'ancien code appelle fetch_contact_with_entreprise(id_contact).
    Désormais, l'ID attendu est un id_effectif (tbl_effectif_client).

    Objectif: ne pas casser tout le projet maintenant.
    On mappe les champs effectif -> anciens noms "contact".

    Retourne: (row_contact_like: dict, row_entreprise: dict)
    """
    row_eff, row_ent = fetch_effectif_with_entreprise(cur, id_contact)

    role_ca = row_eff.get("role_temp")
    if not role_ca and row_eff.get("ismanager"):
        role_ca = "Manager"

    row_contact_like = {
        # anciens champs attendus par certains modules
        "id_contact": row_eff.get("id_effectif"),
        "id_ent": row_eff.get("id_ent"),
        "id_service": row_eff.get("id_service"),
        "civ_ca": row_eff.get("civilite_effectif"),
        "nom_ca": row_eff.get("nom_effectif"),
        "prenom_ca": row_eff.get("prenom_effectif"),
        "role_ca": role_ca,
        "tel_ca": row_eff.get("telephone_effectif"),
        "tel2_ca": None,
        "mail_ca": row_eff.get("email_effectif"),
        "obs_ca": row_eff.get("note_commentaire"),
        "created_at": row_eff.get("date_creation"),
        "masque": row_eff.get("archive"),
        "est_principal": None,

        # bonus: champs “nouveaux”
        "id_effectif": row_eff.get("id_effectif"),
    }

    return row_contact_like, row_ent

