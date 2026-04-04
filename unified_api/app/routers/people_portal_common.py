from fastapi import HTTPException
import os
import requests

# People réutilise pour l’instant la même auth Supabase que Skills
PEOPLE_SUPABASE_URL = os.getenv("SKILLS_SUPABASE_URL") or ""
PEOPLE_SUPABASE_ANON_KEY = os.getenv("SKILLS_SUPABASE_ANON_KEY") or ""
PEOPLE_SUPER_ADMIN_EMAILS = os.getenv("SKILLS_SUPER_ADMIN_EMAILS", "") or ""


def _people_is_super_admin(email: str) -> bool:
    # People = portail salarié
    # On neutralise le bypass super admin par email.
    # Un utilisateur ne doit voir que les profils explicitement rattachés à son email.
    return False


def _people_extract_bearer_token(authorization: str) -> str:
    a = (authorization or "").strip()
    if not a:
        return ""
    if not a.lower().startswith("bearer "):
        return ""
    return a[7:].strip()


def people_get_supabase_user(access_token: str) -> dict:
    if not PEOPLE_SUPABASE_URL or not PEOPLE_SUPABASE_ANON_KEY:
        raise HTTPException(status_code=500, detail="Config Supabase People manquante côté serveur.")

    tok = (access_token or "").strip()
    if not tok:
        raise HTTPException(status_code=401, detail="Token manquant.")

    url = f"{PEOPLE_SUPABASE_URL.rstrip('/')}/auth/v1/user"
    headers = {
        "apikey": PEOPLE_SUPABASE_ANON_KEY,
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


def people_require_user(authorization_header: str) -> dict:
    user = people_get_supabase_user(_people_extract_bearer_token(authorization_header))

    uid = user.get("id") or ""
    email = (user.get("email") or "").strip()
    meta = user.get("user_metadata") or {}

    return {
        "id": uid,
        "email": email,
        "user_metadata": meta,
        "is_super_admin": _people_is_super_admin(email),
    }


def _role_label(role_code: str) -> str:
    c = (role_code or "").strip().lower()
    if c == "admin":
        return "Administrateur"
    if c == "editor":
        return "Éditeur"
    return "Utilisateur"


def people_list_profiles(cur, email: str = "", is_super_admin: bool = False) -> list:
    e = (email or "").strip()

    where = [
        "a.console_code = 'people'",
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

    # --------------------------------------------------
    # 1) Profils People rattachés à une entreprise cliente
    #    => source métier = tbl_effectif_client
    # --------------------------------------------------
    cur.execute(
        f"""
        SELECT DISTINCT ON (a.id_owner, a.id_user_ref)
          a.id_owner,
          a.id_user_ref AS id_effectif,
          a.role_code,
          COALESCE(NULLIF(BTRIM(COALESCE(ec.email_effectif, '')), ''), a.email) AS email_effectif,
          ec.prenom_effectif AS prenom,
          ec.nom_effectif AS nom,
          COALESCE(ent.nom_ent, '') AS nom_owner,
          COALESCE(org.nom_service, '') AS nom_service,
          COALESCE(fp.intitule_poste, '') AS intitule_poste,
          'effectif_client' AS source_row_kind
        FROM public.tbl_novoskill_user_access a
        JOIN public.tbl_entreprise ent
          ON ent.id_ent = a.id_owner
         AND COALESCE(ent.masque, FALSE) = FALSE
        JOIN public.tbl_effectif_client ec
          ON ec.id_ent = a.id_owner
         AND ec.id_effectif = a.id_user_ref
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_ent = ec.id_ent
         AND org.id_service = ec.id_service
         AND COALESCE(org.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste fp
          ON fp.id_owner = ec.id_ent
         AND fp.id_ent = ec.id_ent
         AND fp.id_poste = ec.id_poste_actuel
         AND COALESCE(fp.actif, TRUE) = TRUE
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
    rows_ent = cur.fetchall() or []

    # --------------------------------------------------
    # 2) Profils People rattachés à mon entreprise
    #    => source métier = tbl_utilisateur
    # --------------------------------------------------
    cur.execute(
        f"""
        SELECT DISTINCT ON (a.id_owner, a.id_user_ref)
          a.id_owner,
          a.id_user_ref AS id_effectif,
          a.role_code,
          COALESCE(NULLIF(BTRIM(COALESCE(u.ut_mail, '')), ''), a.email) AS email_effectif,
          u.ut_prenom AS prenom,
          u.ut_nom AS nom,
          COALESCE(me.nom_ent, '') AS nom_owner,
          COALESCE(org.nom_service, '') AS nom_service,
          COALESCE(fp.intitule_poste, '') AS intitule_poste,
          'utilisateur' AS source_row_kind
        FROM public.tbl_novoskill_user_access a
        JOIN public.tbl_mon_entreprise me
          ON me.id_mon_ent = a.id_owner
         AND COALESCE(me.archive, FALSE) = FALSE
        JOIN public.tbl_utilisateur u
          ON u.id_utilisateur = a.id_user_ref
         AND COALESCE(u.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_ent = a.id_owner
         AND ec.id_effectif = u.id_utilisateur
         AND COALESCE(ec.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_ent = a.id_owner
         AND org.id_service = ec.id_service
         AND COALESCE(org.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste fp
          ON fp.id_owner = a.id_owner
         AND fp.id_ent = a.id_owner
         AND fp.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
         AND COALESCE(fp.actif, TRUE) = TRUE
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
    rows_mon = cur.fetchall() or []

    rows = list(rows_ent) + list(rows_mon)

    out = []
    seen = set()

    for r in rows:
        oid = (r.get("id_owner") or "").strip()
        eid = (r.get("id_effectif") or "").strip()
        if not oid or not eid:
            continue

        key = (oid, eid)
        if key in seen:
            continue
        seen.add(key)

        role_code = (r.get("role_code") or "user").strip().lower()
        if role_code not in ("admin", "editor", "user"):
            role_code = "user"

        out.append(
            {
                "id_owner": oid,
                "nom_owner": (r.get("nom_owner") or "").strip(),
                "id_effectif": eid,
                "prenom": (r.get("prenom") or "").strip(),
                "nom": (r.get("nom") or "").strip(),
                "email": (r.get("email_effectif") or "").strip(),
                "nom_service": (r.get("nom_service") or "").strip(),
                "intitule_poste": (r.get("intitule_poste") or "").strip(),
                "role_code": role_code,
                "role_label": _role_label(role_code),
                "source_row_kind": (r.get("source_row_kind") or "").strip(),
            }
        )

    return out


def people_fetch_profile(cur, id_effectif: str, email: str = "", is_super_admin: bool = False) -> dict:
    eid = (id_effectif or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="id_effectif manquant.")

    profiles = people_list_profiles(cur, email=email, is_super_admin=is_super_admin)
    for p in profiles:
        if (p.get("id_effectif") or "").strip() == eid:
            return p

    # Fallback super admin : accès direct entreprise cliente
    if is_super_admin:
        cur.execute(
            """
            SELECT
              ec.id_ent AS id_owner,
              COALESCE(ent.nom_ent, '') AS nom_owner,
              ec.id_effectif,
              ec.prenom_effectif AS prenom,
              ec.nom_effectif AS nom,
              COALESCE(NULLIF(BTRIM(COALESCE(ec.email_effectif, '')), ''), '') AS email_effectif,
              COALESCE(org.nom_service, '') AS nom_service,
              COALESCE(fp.intitule_poste, '') AS intitule_poste,
              'effectif_client' AS source_row_kind
            FROM public.tbl_effectif_client ec
            LEFT JOIN public.tbl_entreprise ent
              ON ent.id_ent = ec.id_ent
            LEFT JOIN public.tbl_entreprise_organigramme org
              ON org.id_ent = ec.id_ent
             AND org.id_service = ec.id_service
             AND COALESCE(org.archive, FALSE) = FALSE
            LEFT JOIN public.tbl_fiche_poste fp
              ON fp.id_owner = ec.id_ent
             AND fp.id_ent = ec.id_ent
             AND fp.id_poste = ec.id_poste_actuel
             AND COALESCE(fp.actif, TRUE) = TRUE
            WHERE ec.id_effectif = %s
              AND COALESCE(ec.archive, FALSE) = FALSE
            LIMIT 1
            """,
            (eid,),
        )
        r = cur.fetchone() or {}
        if r:
            return {
                "id_owner": (r.get("id_owner") or "").strip(),
                "nom_owner": (r.get("nom_owner") or "").strip(),
                "id_effectif": (r.get("id_effectif") or "").strip(),
                "prenom": (r.get("prenom") or "").strip(),
                "nom": (r.get("nom") or "").strip(),
                "email": (r.get("email_effectif") or "").strip(),
                "nom_service": (r.get("nom_service") or "").strip(),
                "intitule_poste": (r.get("intitule_poste") or "").strip(),
                "role_code": "admin",
                "role_label": "Administrateur",
                "source_row_kind": "effectif_client",
            }

        # Fallback super admin : accès direct mon entreprise / utilisateur
        cur.execute(
            """
            SELECT
              me.id_mon_ent AS id_owner,
              COALESCE(me.nom_ent, '') AS nom_owner,
              u.id_utilisateur AS id_effectif,
              u.ut_prenom AS prenom,
              u.ut_nom AS nom,
              COALESCE(NULLIF(BTRIM(COALESCE(u.ut_mail, '')), ''), '') AS email_effectif,
              COALESCE(org.nom_service, '') AS nom_service,
              COALESCE(fp.intitule_poste, '') AS intitule_poste,
              'utilisateur' AS source_row_kind
            FROM public.tbl_utilisateur u
            JOIN public.tbl_mon_entreprise me
              ON COALESCE(me.archive, FALSE) = FALSE
            LEFT JOIN public.tbl_effectif_client ec
              ON ec.id_ent = me.id_mon_ent
             AND ec.id_effectif = u.id_utilisateur
             AND COALESCE(ec.archive, FALSE) = FALSE
            LEFT JOIN public.tbl_entreprise_organigramme org
              ON org.id_ent = me.id_mon_ent
             AND org.id_service = ec.id_service
             AND COALESCE(org.archive, FALSE) = FALSE
            LEFT JOIN public.tbl_fiche_poste fp
              ON fp.id_owner = me.id_mon_ent
             AND fp.id_ent = me.id_mon_ent
             AND fp.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
             AND COALESCE(fp.actif, TRUE) = TRUE
            WHERE u.id_utilisateur = %s
              AND COALESCE(u.archive, FALSE) = FALSE
            LIMIT 1
            """,
            (eid,),
        )
        r = cur.fetchone() or {}
        if r:
            return {
                "id_owner": (r.get("id_owner") or "").strip(),
                "nom_owner": (r.get("nom_owner") or "").strip(),
                "id_effectif": (r.get("id_effectif") or "").strip(),
                "prenom": (r.get("prenom") or "").strip(),
                "nom": (r.get("nom") or "").strip(),
                "email": (r.get("email_effectif") or "").strip(),
                "nom_service": (r.get("nom_service") or "").strip(),
                "intitule_poste": (r.get("intitule_poste") or "").strip(),
                "role_code": "admin",
                "role_label": "Administrateur",
                "source_row_kind": "utilisateur",
            }

    raise HTTPException(status_code=403, detail="Accès refusé à ce profil People.")


def people_get_default_effectif(cur, u: dict) -> str:
    meta = u.get("user_metadata") or {}
    meta_id = (meta.get("id_effectif") or meta.get("id_contact") or "").strip()

    if meta_id:
        try:
            p = people_fetch_profile(
                cur,
                meta_id,
                email=(u.get("email") or ""),
                is_super_admin=bool(u.get("is_super_admin")),
            )
            if p and p.get("id_effectif"):
                return (p.get("id_effectif") or "").strip()
        except Exception:
            pass

    profiles = people_list_profiles(
        cur,
        email=(u.get("email") or ""),
        is_super_admin=bool(u.get("is_super_admin")),
    )
    if profiles:
        return (profiles[0].get("id_effectif") or "").strip()

    return ""