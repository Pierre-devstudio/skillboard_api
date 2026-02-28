from fastapi import HTTPException
import os
import requests

STUDIO_SUPABASE_URL = os.getenv("STUDIO_SUPABASE_URL") or ""
STUDIO_SUPABASE_ANON_KEY = os.getenv("STUDIO_SUPABASE_ANON_KEY") or ""
STUDIO_SUPER_ADMIN_EMAILS = os.getenv("STUDIO_SUPER_ADMIN_EMAILS", "") or ""


def _studio_is_super_admin(email: str) -> bool:
    e = (email or "").strip().lower()
    if not e:
        return False
    raw = (STUDIO_SUPER_ADMIN_EMAILS or "").strip()
    if not raw:
        return False
    allowed = [x.strip().lower() for x in raw.split(",") if x.strip()]
    return e in allowed


def _studio_extract_bearer_token(authorization: str) -> str:
    a = (authorization or "").strip()
    if not a:
        return ""
    if not a.lower().startswith("bearer "):
        return ""
    return a[7:].strip()


def studio_get_supabase_user(access_token: str) -> dict:
    if not STUDIO_SUPABASE_URL or not STUDIO_SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="Config Supabase Studio manquante côté serveur.")

    tok = (access_token or "").strip()
    if not tok:
        raise HTTPException(status_code=401, detail="Token manquant.")

    url = f"{STUDIO_SUPABASE_URL.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": STUDIO_SUPABASE_ANON_KEY,
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


def studio_require_user(authorization_header: str) -> dict:
    user = studio_get_supabase_user(_studio_extract_bearer_token(authorization_header))

    uid = user.get("id") or ""
    email = (user.get("email") or "").strip()
    meta = user.get("user_metadata") or {}

    return {
        "id": uid,
        "email": email,
        "user_metadata": meta,
        "is_super_admin": _studio_is_super_admin(email),
    }


def studio_list_owners(cur) -> list:
    cur.execute(
        """
        SELECT id_owner, nom_owner
        FROM public.tbl_studio_owner
        WHERE COALESCE(archive, FALSE) = FALSE
        ORDER BY nom_owner
        """
    )
    rows = cur.fetchall() or []
    return [{"id_owner": r.get("id_owner"), "nom_owner": r.get("nom_owner")} for r in rows]


def studio_fetch_owner(cur, id_owner: str) -> dict:
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    cur.execute(
        """
        SELECT id_owner, nom_owner
        FROM public.tbl_studio_owner
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Owner introuvable ou archivé.")
    return {"id_owner": r.get("id_owner"), "nom_owner": r.get("nom_owner")}