from fastapi import HTTPException
import os
import requests

# Partner utilise le même principe que les autres consoles :
# - auth Supabase
# - accès applicatif via tbl_novoskill_user_access
# - identité métier dans tbl_consultant
PARTNER_SUPABASE_URL = os.getenv("PARTNER_SUPABASE_URL") or os.getenv("SKILLS_SUPABASE_URL") or ""
PARTNER_SUPABASE_ANON_KEY = os.getenv("PARTNER_SUPABASE_ANON_KEY") or os.getenv("SKILLS_SUPABASE_ANON_KEY") or ""


def _partner_is_super_admin(email: str) -> bool:
    # Partner : pas de super admin dans le parcours standard.
    return False


def _partner_extract_bearer_token(authorization: str) -> str:
    a = (authorization or "").strip()
    if not a:
        return ""
    if not a.lower().startswith("bearer "):
        return ""
    return a[7:].strip()


def partner_get_supabase_user(access_token: str) -> dict:
    if not PARTNER_SUPABASE_URL or not PARTNER_SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="Config Supabase Partner manquante côté serveur.")

    tok = (access_token or "").strip()
    if not tok:
        raise HTTPException(status_code=401, detail="Token manquant.")

    url = f"{PARTNER_SUPABASE_URL.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": PARTNER_SUPABASE_ANON_KEY,
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


def partner_require_user(authorization_header: str) -> dict:
    user = partner_get_supabase_user(_partner_extract_bearer_token(authorization_header))

    uid = user.get("id") or ""
    email = (user.get("email") or "").strip()
    meta = user.get("user_metadata") or {}

    return {
        "id": uid,
        "email": email,
        "user_metadata": meta,
        "is_super_admin": _partner_is_super_admin(email),
    }


def _role_label(role_code: str) -> str:
    # Partner : rôle unique utilisateur.
    return "Utilisateur"


def partner_list_profiles(cur, email: str = "", is_super_admin: bool = False) -> list:
    e = (email or "").strip()

    where = [
        "a.console_code = 'partner'",
        "a.user_ref_type = 'consultant'",
        "a.role_code = 'user'",
        "COALESCE(a.archive, FALSE) = FALSE",
        "COALESCE(a.statut_access, 'actif') <> 'suspendu'",
    ]
    params = []

    if not is_super_admin:
        if not e:
            return []
        where.append("lower(a.email) = lower(%s)")
        params.append(e)

    where_sql = " AND ".join(where)

    cur.execute(
        f"""
        SELECT DISTINCT ON (a.id_owner, a.id_user_ref)
          a.id_owner,
          COALESCE(o.nom_owner, '') AS nom_owner,
          a.id_user_ref AS id_consultant,
          a.role_code,
          COALESCE(NULLIF(BTRIM(COALESCE(c.email, '')), ''), a.email) AS email_consultant,
          COALESCE(c.civilite, '') AS civilite,
          COALESCE(c.prenom, '') AS prenom,
          COALESCE(c.nom, '') AS nom,
          COALESCE(c.telephone, '') AS telephone,
          COALESCE(c.telephone_mobile, '') AS telephone_mobile,
          COALESCE(c.type_consultant, '') AS type_consultant,
          COALESCE(c.position_geographique, '') AS position_geographique,
          COALESCE(c.code_postal, '') AS code_postal,
          COALESCE(c.ville, '') AS ville,
          COALESCE(c.photo_url, '') AS photo_url,
          COALESCE(c.code_consultant, '') AS code_consultant
        FROM public.tbl_novoskill_user_access a
        JOIN public.tbl_consultant c
          ON c.id_consultant = a.id_user_ref
         AND c.id_owner = a.id_owner
         AND COALESCE(c.actif, TRUE) = TRUE
        LEFT JOIN public.tbl_novoskill_owner o
          ON o.id_owner = a.id_owner
         AND COALESCE(o.archive, FALSE) = FALSE
        WHERE {where_sql}
        ORDER BY
          a.id_owner,
          a.id_user_ref,
          a.updated_at DESC NULLS LAST,
          a.created_at DESC NULLS LAST,
          a.id_access DESC
        """,
        tuple(params),
    )

    rows = cur.fetchall() or []
    out = []
    seen = set()

    for r in rows:
        oid = (r.get("id_owner") or "").strip()
        cid = (r.get("id_consultant") or "").strip()

        if not oid or not cid:
            continue

        key = (oid, cid)
        if key in seen:
            continue
        seen.add(key)

        role_code = "user"

        out.append(
            {
                "id_owner": oid,
                "nom_owner": (r.get("nom_owner") or "").strip(),
                "id_consultant": cid,
                "civilite": (r.get("civilite") or "").strip(),
                "prenom": (r.get("prenom") or "").strip(),
                "nom": (r.get("nom") or "").strip(),
                "email": (r.get("email_consultant") or "").strip(),
                "telephone": (r.get("telephone") or "").strip(),
                "telephone_mobile": (r.get("telephone_mobile") or "").strip(),
                "type_consultant": (r.get("type_consultant") or "").strip(),
                "position_geographique": (r.get("position_geographique") or "").strip(),
                "code_postal": (r.get("code_postal") or "").strip(),
                "ville": (r.get("ville") or "").strip(),
                "photo_url": (r.get("photo_url") or "").strip(),
                "code_consultant": (r.get("code_consultant") or "").strip(),
                "role_code": role_code,
                "role_label": _role_label(role_code),
                "source_row_kind": "consultant",
            }
        )

    return out


def partner_fetch_profile(cur, id_consultant: str, email: str = "", is_super_admin: bool = False) -> dict:
    cid = (id_consultant or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="id_consultant manquant.")

    profiles = partner_list_profiles(cur, email=email, is_super_admin=is_super_admin)

    for p in profiles:
        if (p.get("id_consultant") or "").strip() == cid:
            return p

    raise HTTPException(status_code=403, detail="Accès refusé à ce profil Partner.")


def partner_get_default_consultant(cur, u: dict) -> str:
    meta = u.get("user_metadata") or {}
    meta_id = (
        meta.get("id_consultant")
        or meta.get("id_contact")
        or ""
    ).strip()

    if meta_id:
        try:
            p = partner_fetch_profile(
                cur,
                meta_id,
                email=(u.get("email") or ""),
                is_super_admin=bool(u.get("is_super_admin")),
            )
            if p and p.get("id_consultant"):
                return (p.get("id_consultant") or "").strip()
        except Exception:
            pass

    profiles = partner_list_profiles(
        cur,
        email=(u.get("email") or ""),
        is_super_admin=bool(u.get("is_super_admin")),
    )

    if profiles:
        return (profiles[0].get("id_consultant") or "").strip()

    return ""