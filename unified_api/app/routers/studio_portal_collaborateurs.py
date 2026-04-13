from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List
from psycopg.rows import dict_row
import os
import secrets
import uuid
import requests
import json
from datetime import date as py_date

from app.routers.MailManager import send_novoskill_access_mail
from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    STUDIO_SUPABASE_URL,
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

router = APIRouter()

CONSOLE_DEFS = [
    {"console_code": "studio", "label": "Studio", "icon_file": "console_studio.svg"},
    {"console_code": "insights", "label": "Insights", "icon_file": "console_insights.svg"},
    {"console_code": "people", "label": "People", "icon_file": "console_people.svg"},
    {"console_code": "learn", "label": "Learn", "icon_file": "console_learn.svg"},
]

ROLE_LABELS = {
    "none": "Aucun accès",
    "user": "Utilisateur",
    "editor": "Éditeur",
    "admin": "Administrateur",
}

SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
NOVOSKILL_PUBLIC_BASE_URL = (os.getenv("NOVOSKILL_PUBLIC_BASE_URL") or "https://novoskill.jmbconsultant.fr").rstrip("/")

CONSOLE_LOGIN_FILES = {
    "studio": "studio_login.html",
    "insights": "skills_login.html",
    "people": "people_login.html",
    "learn": "learn_login.html",
}

CONSOLE_RESET_FILES = {
    "studio": "studio_reset_password.html",
    "insights": "skills_reset_password.html",
    "people": "people_reset_password.html",
    "learn": "learn_reset_password.html",
}

EMAIL_CONSOLE_ICON_FILES = {
    "studio": "favicon-studio-32x32.png",
    "insights": "favicon-32x32.png",
    "people": "favicon-people-32x32.png",
    "learn": "favicon-learn-32x32.png",
}

# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def _require_owner_access(cur, u: dict, id_owner: str):
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = (u.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (email, oid),
    )
    ok = cur.fetchone()
    if not ok:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _resolve_owner_source(cur, oid: str) -> dict:
    cur.execute(
        """
        SELECT id_mon_ent, nom_ent
        FROM public.tbl_mon_entreprise
        WHERE id_mon_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_mon_ent"):
        return {
            "source_kind": "mon_entreprise",
            "source_label": "Mon entreprise",
            "source_name": (r.get("nom_ent") or "").strip(),
        }

    cur.execute(
        """
        SELECT id_ent, nom_ent
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_ent"):
        return {
            "source_kind": "entreprise",
            "source_label": "Client",
            "source_name": (r.get("nom_ent") or "").strip(),
        }

    raise HTTPException(status_code=404, detail="Owner non rattaché à une entreprise exploitable.")

def _role_label(role_code: Optional[str]) -> str:
    return ROLE_LABELS.get((role_code or "none").strip().lower(), "Aucun accès")


def _normalize_access_role_code(value: Optional[str]) -> str:
    s = (value or "").strip().lower()
    mapping = {
        "": "none",
        "none": "none",
        "aucun": "none",
        "aucun_acces": "none",
        "aucun accès": "none",
        "user": "user",
        "utilisateur": "user",
        "editor": "editor",
        "editeur": "editor",
        "éditeur": "editor",
        "admin": "admin",
        "administrateur": "admin",
    }
    out = mapping.get(s)
    if out is None:
        raise HTTPException(status_code=400, detail=f"Profil console invalide : {value}")
    return out


def _is_unlimited_access_quota(value) -> bool:
    if value is None:
        return True
    try:
        return int(value) >= 999999
    except Exception:
        return False


def _load_owner_console_contracts(cur, oid: str) -> dict:
    cur.execute(
        """
        SELECT
          COALESCE(offer_code, '') AS offer_code,
          COALESCE(studio_actif, FALSE) AS studio_actif,
          COALESCE(insights_actif, FALSE) AS insights_actif,
          COALESCE(people_actif, FALSE) AS people_actif,
          COALESCE(partner_actif, FALSE) AS partner_actif,
          COALESCE(learn_actif, FALSE) AS learn_actif,
          COALESCE(nb_acces_studio_max, 0) AS nb_acces_studio_max,
          COALESCE(nb_acces_insights_max, 0) AS nb_acces_insights_max,
          COALESCE(nb_acces_people_max, 0) AS nb_acces_people_max,
          COALESCE(nb_acces_partner_max, 0) AS nb_acces_partner_max,
          COALESCE(nb_acces_learn_max, 0) AS nb_acces_learn_max
        FROM public.tbl_novoskill_owner_commercial
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY
          COALESCE(date_fin, DATE '2999-12-31') DESC,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id_owner_commercial DESC
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}

    quotas = {
        "studio": int(r.get("nb_acces_studio_max") or 0),
        "insights": int(r.get("nb_acces_insights_max") or 0),
        "people": int(r.get("nb_acces_people_max") or 0),
        "partner": int(r.get("nb_acces_partner_max") or 0),
        "learn": int(r.get("nb_acces_learn_max") or 0),
    }

    unlimited = {
        code: _is_unlimited_access_quota(val)
        for code, val in quotas.items()
    }

    return {
        "offer_code": (r.get("offer_code") or "").strip(),
        "studio": bool(r.get("studio_actif")),
        "insights": bool(r.get("insights_actif")),
        "people": bool(r.get("people_actif")),
        "partner": bool(r.get("partner_actif")),
        "learn": bool(r.get("learn_actif")),
        "quotas": quotas,
        "unlimited": unlimited,
    }


def _count_owner_access_usage(cur, oid: str) -> dict:
    out = {
        "studio": 0,
        "insights": 0,
        "people": 0,
        "partner": 0,
        "learn": 0,
    }

    cur.execute(
        """
        SELECT
          lower(COALESCE(console_code, '')) AS console_code,
          COUNT(DISTINCT id_user_ref) AS used_access
        FROM public.tbl_novoskill_user_access
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
          AND COALESCE(role_code, 'none') <> 'none'
        GROUP BY lower(COALESCE(console_code, ''))
        """,
        (oid,),
    )

    for r in (cur.fetchall() or []):
        code = (r.get("console_code") or "").strip().lower()
        if code in out:
            out[code] = int(r.get("used_access") or 0)

    return out


def _build_console_items(cur, oid: str) -> list:
    contracts = _load_owner_console_contracts(cur, oid)
    usage_map = _count_owner_access_usage(cur, oid)

    items = []
    for d in CONSOLE_DEFS:
        code = d["console_code"]
        max_access = int((contracts.get("quotas") or {}).get(code) or 0)
        is_unlimited = bool((contracts.get("unlimited") or {}).get(code))
        used_access = int((usage_map or {}).get(code) or 0)
        available_access = 999999 if is_unlimited else max(max_access - used_access, 0)

        items.append(
            {
                "console_code": code,
                "label": d["label"],
                "icon_file": d["icon_file"],
                "contract_active": bool(contracts.get(code, False)),
                "max_access": max_access,
                "used_access": used_access,
                "available_access": available_access,
                "is_unlimited": is_unlimited,
                "offer_code": contracts.get("offer_code") or "",
            }
        )
    return items


def _default_access_ref_type(console_code: str, source_kind: str, source_row_kind: str) -> str:
    code = (console_code or "").strip().lower()

    # Cas mon entreprise :
    # les comptes internes / owner utilisent tbl_utilisateur.
    # On aligne désormais aussi Insights sur cette logique.
    if source_kind == "mon_entreprise" and source_row_kind == "utilisateur":
        if code in ("studio", "insights", "people", "partner", "learn"):
            return "utilisateur"

    return "effectif_client"


def _fetch_collaborateur_identity_for_access(cur, oid: str, source_kind: str, cid: str) -> dict:
    if source_kind == "entreprise":
        cur.execute(
            """
            SELECT
              e.id_effectif AS id_collaborateur,
              e.prenom_effectif AS prenom,
              e.nom_effectif AS nom,
              e.email_effectif AS email,
              'effectif_client' AS source_row_kind
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND e.id_effectif = %s
            LIMIT 1
            """,
            (oid, cid),
        )
        r = cur.fetchone() or {}
        if not r:
            raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
        return {
            "id_collaborateur": r.get("id_collaborateur"),
            "prenom": r.get("prenom"),
            "nom": r.get("nom"),
            "email": (r.get("email") or "").strip(),
            "source_row_kind": r.get("source_row_kind"),
        }

    cur.execute(
        """
        SELECT
          u.id_utilisateur AS id_collaborateur,
          u.ut_prenom AS prenom,
          u.ut_nom AS nom,
          COALESCE(NULLIF(BTRIM(COALESCE(u.ut_mail, '')), ''), NULLIF(BTRIM(COALESCE(ec.email_effectif, '')), '')) AS email,
          'utilisateur' AS source_row_kind
        FROM public.tbl_utilisateur u
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_ent = %s
         AND ec.id_effectif = u.id_utilisateur
        WHERE u.id_utilisateur = %s
        LIMIT 1
        """,
        (oid, cid),
    )
    r = cur.fetchone() or {}
    if not r:
        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
    return {
        "id_collaborateur": r.get("id_collaborateur"),
        "prenom": r.get("prenom"),
        "nom": r.get("nom"),
        "email": (r.get("email") or "").strip(),
        "source_row_kind": r.get("source_row_kind"),
    }


def _fetch_access_summary_map(cur, oid: str, collaborator_ids: list) -> dict:
    ids = [str(x).strip() for x in (collaborator_ids or []) if str(x).strip()]
    out = {x: [] for x in ids}
    if not ids:
        return out

    meta_map = {d["console_code"]: d for d in CONSOLE_DEFS}
    cur.execute(
        """
        SELECT
          id_user_ref,
          console_code,
          role_code
        FROM public.tbl_novoskill_user_access
        WHERE id_owner = %s
          AND id_user_ref = ANY(%s)
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        ORDER BY
          id_user_ref,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id_access DESC
        """,
        (oid, ids),
    )

    seen = set()
    for r in (cur.fetchall() or []):
        cid = (r.get("id_user_ref") or "").strip()
        cc = (r.get("console_code") or "").strip().lower()
        if not cid or not cc:
            continue
        key = (cid, cc)
        if key in seen:
            continue
        seen.add(key)
        meta = meta_map.get(cc)
        if not meta:
            continue

        out.setdefault(cid, []).append(
            {
                "console_code": cc,
                "role_code": (r.get("role_code") or "").strip().lower(),
                "role_label": _role_label(r.get("role_code")),
                "label": meta.get("label") or cc,
                "icon_file": meta.get("icon_file"),
            }
        )

    order = {d["console_code"]: idx for idx, d in enumerate(CONSOLE_DEFS)}
    for cid in out:
        out[cid].sort(key=lambda x: order.get(x.get("console_code"), 999))
    return out


def _build_access_state_for_collaborator(cur, oid: str, source_kind: str, cid: str) -> dict:
    ident = _fetch_collaborateur_identity_for_access(cur, oid, source_kind, cid)
    console_items = _build_console_items(cur, oid)

    cur.execute(
        """
        SELECT
          console_code,
          role_code,
          email,
          user_ref_type
        FROM public.tbl_novoskill_user_access
        WHERE id_owner = %s
          AND id_user_ref = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        ORDER BY
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id_access DESC
        """,
        (oid, cid),
    )
    rows = cur.fetchall() or []

    access_by_console = {}
    summary = []
    for r in rows:
        cc = (r.get("console_code") or "").strip().lower()
        if not cc or cc in access_by_console:
            continue
        access_by_console[cc] = r

    for idx, item in enumerate(console_items):
        cc = item["console_code"]
        row = access_by_console.get(cc)
        role_code = (row.get("role_code") or "").strip().lower() if row else "none"
        role_code = role_code or "none"
        role_label = _role_label(role_code)
        console_items[idx] = {
            **item,
            "role_code": role_code,
            "role_label": role_label,
            "has_access": row is not None and role_code != "none",
            "email": (row.get("email") or "").strip() if row else ident["email"],
            "user_ref_type": (row.get("user_ref_type") or "").strip() if row else _default_access_ref_type(cc, source_kind, ident["source_row_kind"]),
        }
        if console_items[idx]["has_access"]:
            summary.append(
                {
                    "console_code": cc,
                    "role_code": role_code,
                    "role_label": role_label,
                    "label": item["label"],
                    "icon_file": item["icon_file"],
                }
            )

    return {
        "id_collaborateur": cid,
        "prenom": ident.get("prenom"),
        "nom": ident.get("nom"),
        "email": ident.get("email"),
        "source_row_kind": ident.get("source_row_kind"),
        "consoles": console_items,
        "summary": summary,
    }

def _supabase_admin_is_configured() -> bool:
    return bool(STUDIO_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _supabase_admin_headers() -> dict:
    if not _supabase_admin_is_configured():
        raise HTTPException(status_code=500, detail="Config Supabase Admin manquante côté serveur.")
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _supabase_admin_request(
    method: str,
    path: str,
    payload: Optional[dict] = None,
    params: Optional[dict] = None,
) -> dict:
    url = f"{STUDIO_SUPABASE_URL.rstrip('/')}{path}"

    try:
        r = requests.request(
            method=method.upper(),
            url=url,
            headers=_supabase_admin_headers(),
            params=params,
            json=payload,
            timeout=20,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur Supabase Admin: {e}")

    if r.status_code >= 400:
        detail = ""
        try:
            js = r.json() if r.content else {}
            detail = (
                js.get("msg")
                or js.get("message")
                or js.get("error_description")
                or js.get("error")
                or ""
            )
        except Exception:
            detail = r.text or ""

        status = 400 if 400 <= r.status_code < 500 else 500
        raise HTTPException(
            status_code=status,
            detail=f"Erreur Supabase Admin: {detail or r.text or r.status_code}",
        )

    try:
        return r.json() if r.content else {}
    except Exception:
        return {}


def _supabase_find_user_by_email(email: Optional[str]) -> Optional[dict]:
    target = (email or "").strip().lower()
    if not target or not _supabase_admin_is_configured():
        return None

    page = 1
    per_page = 1000

    while page <= 20:
        js = _supabase_admin_request(
            "GET",
            "/auth/v1/admin/users",
            params={"page": page, "per_page": per_page},
        )
        users = js.get("users") if isinstance(js, dict) else []
        if not isinstance(users, list):
            users = []

        for user in users:
            if (user.get("email") or "").strip().lower() == target:
                return user

        if len(users) < per_page:
            break

        page += 1

    return None


def _supabase_create_user(email: str, password: str, user_metadata: dict) -> dict:
    js = _supabase_admin_request(
        "POST",
        "/auth/v1/admin/users",
        payload={
            "email": email,
            "password": password,
            "email_confirm": True,
            "user_metadata": user_metadata,
        },
    )
    return js.get("user") if isinstance(js, dict) and isinstance(js.get("user"), dict) else js


def _supabase_update_user(user_id: str, payload: dict) -> dict:
    js = _supabase_admin_request(
        "PUT",
        f"/auth/v1/admin/users/{user_id}",
        payload=payload,
    )
    return js.get("user") if isinstance(js, dict) and isinstance(js.get("user"), dict) else js


def _supabase_generate_recovery_link(email: str, redirect_to: str) -> str:
    js = _supabase_admin_request(
        "POST",
        "/auth/v1/admin/generate_link",
        payload={
            "type": "recovery",
            "email": email,
            "redirect_to": redirect_to,
        },
    )

    props = js.get("properties") if isinstance(js, dict) and isinstance(js.get("properties"), dict) else {}
    link = (
        props.get("action_link")
        or props.get("actionLink")
        or js.get("action_link")
        or js.get("actionLink")
        or ""
    )
    return (link or "").strip()


def _generate_random_password() -> str:
    return secrets.token_urlsafe(24) + "Aa1!"


def _console_login_url(console_code: str) -> str:
    file = CONSOLE_LOGIN_FILES.get((console_code or "").strip().lower(), "")
    if not file:
        return ""
    return f"{NOVOSKILL_PUBLIC_BASE_URL}/{file}"


def _console_reset_url(console_code: str) -> str:
    file = CONSOLE_RESET_FILES.get((console_code or "").strip().lower(), "")
    if not file:
        return ""
    return f"{NOVOSKILL_PUBLIC_BASE_URL}/{file}"


def _console_icon_url(console_code: str) -> str:
    file = EMAIL_CONSOLE_ICON_FILES.get((console_code or "").strip().lower(), "")
    if not file:
        return ""
    return f"{NOVOSKILL_PUBLIC_BASE_URL}/{file}"


def _build_active_access_map(access_state: dict) -> dict:
    out = {}
    for item in (access_state.get("consoles") or []):
        code = (item.get("console_code") or "").strip().lower()
        role = (item.get("role_code") or "none").strip().lower()
        if code and role != "none":
            out[code] = role
    return out


def _build_console_mail_items(access_state: dict) -> list:
    items = []
    for item in (access_state.get("consoles") or []):
        code = (item.get("console_code") or "").strip().lower()
        role = (item.get("role_code") or "none").strip().lower()
        if not code or role == "none":
            continue

        items.append(
            {
                "console_code": code,
                "label": (item.get("label") or code.title()).strip(),
                "role_code": role,
                "role_label": (item.get("role_label") or _role_label(role)).strip(),
                "icon_url": _console_icon_url(code),
                "login_url": _console_login_url(code),
            }
        )

    order = {"studio": 0, "insights": 1, "people": 2, "learn": 3}
    items.sort(key=lambda x: order.get((x.get("console_code") or "").strip().lower(), 99))
    return items


def _select_preferred_console_code(access_state: dict) -> str:
    active_map = _build_active_access_map(access_state)
    for code in ("studio", "insights", "people", "learn"):
        if code in active_map:
            return code
    return "studio"


def _merge_auth_user_metadata(
    existing_metadata: Optional[dict],
    id_owner: str,
    id_effectif: str,
    active_codes: set,
) -> dict:
    meta = dict(existing_metadata or {})

    if "studio" in active_codes:
        meta["id_owner"] = id_owner
    else:
        meta.pop("id_owner", None)

    if active_codes.intersection({"insights", "people", "learn"}):
        meta["id_effectif"] = id_effectif
        meta["id_contact"] = id_effectif
    else:
        meta.pop("id_effectif", None)
        meta.pop("id_contact", None)

    meta["novoskill_console_codes"] = sorted(active_codes)
    meta["novoskill_has_access"] = bool(active_codes)
    return meta


def _sync_supabase_auth_user_from_access_state(
    id_owner: str,
    id_effectif: str,
    email: Optional[str],
    after_access_state: dict,
) -> dict:
    active_codes = set(_build_active_access_map(after_access_state).keys())
    target_email = (email or "").strip()

    if not active_codes:
        if not target_email or not _supabase_admin_is_configured():
            return {"auth_user": None, "created_now": False, "setup_link": None}

        user = _supabase_find_user_by_email(target_email)
        if user and user.get("id"):
            merged = _merge_auth_user_metadata(
                user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {},
                id_owner,
                id_effectif,
                active_codes,
            )
            user = _supabase_update_user(
                str(user.get("id")),
                {
                    "user_metadata": merged,
                    "email_confirm": True,
                },
            )

        return {"auth_user": user, "created_now": False, "setup_link": None}

    if not target_email:
        raise HTTPException(status_code=400, detail="Email collaborateur manquant pour ouvrir un accès console.")

    if not _supabase_admin_is_configured():
        raise HTTPException(status_code=500, detail="Config Supabase Admin manquante côté serveur.")

    user = _supabase_find_user_by_email(target_email)
    created_now = False

    if user and user.get("id"):
        merged = _merge_auth_user_metadata(
            user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {},
            id_owner,
            id_effectif,
            active_codes,
        )
        user = _supabase_update_user(
            str(user.get("id")),
            {
                "email": target_email,
                "email_confirm": True,
                "user_metadata": merged,
            },
        )
    else:
        created_now = True
        merged = _merge_auth_user_metadata({}, id_owner, id_effectif, active_codes)
        user = _supabase_create_user(
            target_email,
            _generate_random_password(),
            merged,
        )

    setup_link = None
    if created_now:
        setup_link = _supabase_generate_recovery_link(
            target_email,
            _console_reset_url(_select_preferred_console_code(after_access_state)),
        )
        if not setup_link:
            raise HTTPException(status_code=500, detail="Lien de définition du mot de passe introuvable.")

    return {
        "auth_user": user,
        "created_now": created_now,
        "setup_link": setup_link,
    }


def _resolve_actor_display_name(cur, u: dict, id_owner: str) -> str:
    email = (u.get("email") or "").strip()
    if not email:
        return "Administrateur Novoskill"

    cur.execute(
        """
        SELECT
          COALESCE(NULLIF(BTRIM(COALESCE(ut_prenom, '')), ''), '') AS prenom,
          COALESCE(NULLIF(BTRIM(COALESCE(ut_nom, '')), ''), '') AS nom
        FROM public.tbl_utilisateur
        WHERE lower(COALESCE(ut_mail, '')) = lower(%s)
        ORDER BY COALESCE(archive, FALSE) ASC
        LIMIT 1
        """,
        (email,),
    )
    r = cur.fetchone() or {}
    full = f"{(r.get('prenom') or '').strip()} {(r.get('nom') or '').strip()}".strip()
    if full:
        return full

    cur.execute(
        """
        SELECT
          COALESCE(NULLIF(BTRIM(COALESCE(prenom_effectif, '')), ''), '') AS prenom,
          COALESCE(NULLIF(BTRIM(COALESCE(nom_effectif, '')), ''), '') AS nom
        FROM public.tbl_effectif_client
        WHERE id_ent = %s
          AND lower(COALESCE(email_effectif, '')) = lower(%s)
        ORDER BY COALESCE(archive, FALSE) ASC
        LIMIT 1
        """,
        (id_owner, email),
    )
    r = cur.fetchone() or {}
    full = f"{(r.get('prenom') or '').strip()} {(r.get('nom') or '').strip()}".strip()
    if full:
        return full

    return email

def _send_access_mail_for_collaborateur(cur, u: dict, id_owner: str, source_kind: str, id_collaborateur: str) -> dict:
    cid = (id_collaborateur or "").strip()
    if not cid:
        return {
            "ok": False,
            "reason": "missing_id",
            "detail": "Collaborateur manquant.",
            "id_collaborateur": cid,
        }

    ident = _fetch_collaborateur_identity_for_access(cur, id_owner, source_kind, cid)
    email = (ident.get("email") or "").strip()
    collaborateur_nom = f"{(ident.get('prenom') or '').strip()} {(ident.get('nom') or '').strip()}".strip()

    if not email:
        return {
            "ok": False,
            "reason": "missing_email",
            "detail": "Email collaborateur manquant.",
            "id_collaborateur": cid,
            "email": "",
            "collaborateur_nom": collaborateur_nom,
        }

    access_state = _build_access_state_for_collaborator(cur, id_owner, source_kind, cid)
    active_map = _build_active_access_map(access_state)

    if not active_map:
        return {
            "ok": False,
            "reason": "no_access",
            "detail": "Aucun accès actif à notifier.",
            "id_collaborateur": cid,
            "email": email,
            "collaborateur_nom": collaborateur_nom,
        }

    provisioning = _sync_supabase_auth_user_from_access_state(
        id_owner=id_owner,
        id_effectif=cid,
        email=email,
        after_access_state=access_state,
    )

    actor_name = _resolve_actor_display_name(cur, u, id_owner)
    notification_mode = "first_access" if provisioning.get("created_now") else "update"

    try:
        notification_sent = send_novoskill_access_mail(
            to_email=email,
            collaborateur_nom=collaborateur_nom,
            admin_name=actor_name,
            mode=notification_mode,
            consoles=_build_console_mail_items(access_state),
            setup_link=provisioning.get("setup_link"),
        )
    except Exception as mail_err:
        return {
            "ok": False,
            "reason": "send_failed",
            "detail": str(mail_err),
            "id_collaborateur": cid,
            "email": email,
            "collaborateur_nom": collaborateur_nom,
        }

    if not notification_sent:
        return {
            "ok": False,
            "reason": "send_failed",
            "detail": "Le mail d'accès n'a pas pu être envoyé.",
            "id_collaborateur": cid,
            "email": email,
            "collaborateur_nom": collaborateur_nom,
        }

    access_state["ok"] = True
    access_state["id_collaborateur"] = cid
    access_state["email"] = email
    access_state["collaborateur_nom"] = collaborateur_nom
    access_state["notification_mode"] = notification_mode
    access_state["notification_sent"] = True
    access_state["auth_user_created"] = bool(provisioning.get("created_now"))
    return access_state

def _norm_text(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip()
    return s or None


def _norm_bool(v, default: bool = False) -> bool:
    if v is None:
        return bool(default)
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "vrai", "yes", "oui", "on"):
        return True
    if s in ("0", "false", "faux", "no", "non", "off"):
        return False
    return bool(default)


def _norm_iso_date(v: Optional[str]) -> Optional[py_date]:
    s = (v or "").strip()
    if not s:
        return None
    try:
        return py_date.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Date invalide (format attendu YYYY-MM-DD).")


def _service_exists_active(cur, id_ent: str, id_service: Optional[str]) -> bool:
    sid = (id_service or "").strip()
    if not sid:
        return False
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, sid),
    )
    return cur.fetchone() is not None


def _fetch_poste_service(cur, oid: str, id_poste: Optional[str]) -> Optional[str]:
    pid = (id_poste or "").strip()
    if not pid:
        return None

    cur.execute(
        """
        SELECT id_service
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
          AND id_ent = %s
          AND COALESCE(actif, TRUE) = TRUE
        LIMIT 1
        """,
        (pid, oid, oid),
    )
    r = cur.fetchone() or {}
    if not r:
        raise HTTPException(status_code=400, detail="Poste actuel invalide pour cet owner.")
    return (r.get("id_service") or "").strip() or None


def _norm_service_from_payload(cur, oid: str, id_service: Optional[str], id_poste: Optional[str]) -> Optional[str]:
    pid = (id_poste or "").strip()
    if pid:
        return _fetch_poste_service(cur, oid, pid)

    sid = (id_service or "").strip()
    if not sid:
        return None

    if not _service_exists_active(cur, oid, sid):
        raise HTTPException(status_code=400, detail="Service invalide pour cet owner.")
    return sid


def _build_service_options(cur, oid: str, source_kind: str) -> list:
    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT
            s.id_service,
            s.nom_service,
            NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') AS id_service_parent,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND (
              NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM public.tbl_entreprise_organigramme p
                WHERE p.id_ent = s.id_ent
                  AND p.id_service = NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '')
                  AND COALESCE(p.archive, FALSE) = FALSE
              )
            )

          UNION ALL

          SELECT
            c.id_service,
            c.nom_service,
            NULLIF(BTRIM(COALESCE(c.id_service_parent, '')), '') AS id_service_parent,
            p.depth + 1 AS depth,
            (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p
            ON p.id_service = NULLIF(BTRIM(COALESCE(c.id_service_parent, '')), '')
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        ),
        svc_all AS (
          SELECT
            svc.id_service,
            svc.nom_service,
            svc.id_service_parent,
            svc.depth,
            svc.path
          FROM svc

          UNION

          SELECT
            s.id_service,
            s.nom_service,
            NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') AS id_service_parent,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1
              FROM svc x
              WHERE x.id_service = s.id_service
            )
        )
        SELECT
          svc_all.id_service,
          svc_all.nom_service,
          svc_all.id_service_parent,
          svc_all.depth,
          (
            SELECT COUNT(1)
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND svc_all.id_service = e.id_service
          ) AS nb_collabs
        FROM svc_all
        ORDER BY svc_all.path
        """,
        (oid, oid, oid, oid),
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        depth = int(r.get("depth") or 0)
        nom = (r.get("nom_service") or "").strip()
        items.append(
            {
                "id_service": r.get("id_service"),
                "nom_service": nom,
                "depth": depth,
                "label": f"{'— ' * depth}{nom}",
                "nb_collabs": int(r.get("nb_collabs") or 0),
            }
        )
    return items


def _build_poste_options(cur, oid: str, source_kind: str) -> list:
    cur.execute(
        """
        SELECT
          p.id_poste,
          p.id_service,
          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
          p.intitule_poste,
          COALESCE(s.nom_service, '') AS nom_service,
          (
            SELECT COUNT(1)
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND e.id_poste_actuel = p.id_poste
          ) AS nb_collabs
        FROM public.tbl_fiche_poste p
        LEFT JOIN public.tbl_entreprise_organigramme s
          ON s.id_service = p.id_service
         AND s.id_ent = %s
         AND COALESCE(s.archive, FALSE) = FALSE
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND COALESCE(p.actif, TRUE) = TRUE
        ORDER BY COALESCE(p.codif_client, p.codif_poste, ''), p.intitule_poste
        """,
        (oid, oid, oid, oid),
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        code = (r.get("code_poste") or "").strip()
        intitule = (r.get("intitule_poste") or "").strip()
        label = (f"{code} · {intitule}" if code else intitule).strip()
        items.append(
            {
                "id_poste": r.get("id_poste"),
                "id_service": r.get("id_service"),
                "code_poste": code,
                "intitule_poste": intitule,
                "nom_service": (r.get("nom_service") or "").strip(),
                "label": label,
                "nb_collabs": int(r.get("nb_collabs") or 0),
            }
        )
    return items

def _load_domaine_competence_map(cur, ids: list) -> dict:
    ids = [str(x).strip() for x in (ids or []) if str(x).strip()]
    if not ids:
        return {}

    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tbl_domaine_competence'
        """
    )
    cols = {r["column_name"] for r in (cur.fetchall() or [])}
    if not cols:
        return {}

    id_col = "id_domaine_competence" if "id_domaine_competence" in cols else ("id_domaine" if "id_domaine" in cols else None)
    titre_col = "titre" if "titre" in cols else ("nom" if "nom" in cols else ("intitule" if "intitule" in cols else None))
    couleur_col = "couleur" if "couleur" in cols else ("color" if "color" in cols else None)
    if not id_col or not titre_col:
        return {}

    select_color = f"{couleur_col}::text AS couleur" if couleur_col else "NULL::text AS couleur"

    cur.execute(
        f"""
        SELECT
          {id_col}::text AS id,
          {titre_col}::text AS titre,
          {select_color}
        FROM public.tbl_domaine_competence
        WHERE {id_col} = ANY(%s)
        """,
        (ids,),
    )

    out = {}
    for r in (cur.fetchall() or []):
        did = (r.get("id") or "").strip()
        if did:
            out[did] = {
                "titre": (r.get("titre") or "").strip() or None,
                "couleur": (r.get("couleur") or "").strip() or None,
            }
    return out


def _get_collab_scope(cur, oid: str, source_kind: str, cid: str) -> dict:
    if source_kind == "entreprise":
        cur.execute(
            """
            SELECT
              e.id_effectif AS id_effectif_data,
              e.id_poste_actuel,
              COALESCE(p.intitule_poste, '') AS intitule_poste,
              'effectif_client' AS source_row_kind
            FROM public.tbl_effectif_client e
            LEFT JOIN public.tbl_fiche_poste p
              ON p.id_poste = e.id_poste_actuel
             AND p.id_owner = e.id_ent
             AND p.id_ent = e.id_ent
             AND COALESCE(p.actif, TRUE) = TRUE
            WHERE e.id_ent = %s
              AND e.id_effectif = %s
            LIMIT 1
            """,
            (oid, cid),
        )
        r = cur.fetchone() or {}
        if not r:
            raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
        return {
            "id_effectif_data": r.get("id_effectif_data"),
            "id_poste_actuel": r.get("id_poste_actuel"),
            "intitule_poste": r.get("intitule_poste"),
            "source_row_kind": r.get("source_row_kind"),
        }

    cur.execute(
        """
        SELECT
          u.id_utilisateur AS id_effectif_data,
          COALESCE(ec.id_poste_actuel, u.ut_fonction) AS id_poste_actuel,
          COALESCE(p.intitule_poste, '') AS intitule_poste,
          'utilisateur' AS source_row_kind
        FROM public.tbl_utilisateur u
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_ent = %s
         AND ec.id_effectif = u.id_utilisateur
        LEFT JOIN public.tbl_fiche_poste p
          ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
         AND p.id_owner = %s
         AND p.id_ent = %s
         AND COALESCE(p.actif, TRUE) = TRUE
        WHERE u.id_utilisateur = %s
        LIMIT 1
        """,
        (oid, oid, oid, cid),
    )
    r = cur.fetchone() or {}
    if not r:
        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
    return {
        "id_effectif_data": r.get("id_effectif_data"),
        "id_poste_actuel": r.get("id_poste_actuel"),
        "intitule_poste": r.get("intitule_poste"),
        "source_row_kind": r.get("source_row_kind"),
    }


def _upsert_effectif_mirror_for_utilisateur(cur, oid: str, cid: str, payload) -> None:
    id_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

    date_naissance = _norm_iso_date(payload.date_naissance)
    date_entree = _norm_iso_date(payload.date_entree_entreprise)
    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
    date_sortie = _norm_iso_date(payload.date_sortie_prevue)

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_effectif_client
        WHERE id_ent = %s
          AND id_effectif = %s
        LIMIT 1
        """,
        (oid, cid),
    )
    exists = cur.fetchone() is not None

    values = (
        _norm_text(payload.nom),
        _norm_text(payload.prenom),
        _norm_text(payload.civilite),
        _norm_text(payload.email),
        _norm_text(payload.telephone),
        _norm_text(payload.telephone2),
        _norm_text(payload.adresse),
        _norm_text(payload.code_postal),
        _norm_text(payload.ville),
        _norm_text(payload.pays),
        date_naissance,
        _norm_text(payload.niveau_education),
        _norm_text(payload.domaine_education),
        id_poste,
        _norm_text(payload.type_contrat),
        _norm_text(payload.matricule_interne),
        id_service,
        _norm_text(payload.business_travel),
        date_entree,
        date_sortie,
        _norm_bool(payload.actif, True),
        _norm_text(payload.motif_sortie),
        _norm_text(payload.note_commentaire),
        _norm_bool(payload.havedatefin, bool(date_sortie)),
        _norm_bool(payload.ismanager, False),
        date_debut_poste,
        _norm_bool(payload.isformateur, False),
        _norm_bool(payload.is_temp, False),
        _norm_text(payload.role_temp),
        _norm_text(payload.code_effectif),
    )

    if exists:
        cur.execute(
            """
            UPDATE public.tbl_effectif_client
            SET
              nom_effectif = %s,
              prenom_effectif = %s,
              civilite_effectif = %s,
              email_effectif = %s,
              telephone_effectif = %s,
              telephone2_effectif = %s,
              adresse_effectif = %s,
              code_postal_effectif = %s,
              ville_effectif = %s,
              pays_effectif = %s,
              date_naissance_effectif = %s,
              niveau_education = %s,
              domaine_education = %s,
              id_poste_actuel = %s,
              type_contrat = %s,
              matricule_interne = %s,
              id_service = %s,
              business_travel = %s,
              date_entree_entreprise_effectif = %s,
              date_sortie_prevue = %s,
              statut_actif = %s,
              motif_sortie = %s,
              note_commentaire = %s,
              havedatefin = %s,
              ismanager = %s,
              date_debut_poste_actuel = %s,
              isformateur = %s,
              is_temp = %s,
              role_temp = %s,
              code_effectif = %s,
              archive = FALSE,
              dernier_update = NOW()
            WHERE id_ent = %s
              AND id_effectif = %s
            """,
            values + (oid, cid),
        )
        return

    cur.execute(
        """
        INSERT INTO public.tbl_effectif_client (
          id_effectif,
          id_ent,
          nom_effectif,
          prenom_effectif,
          civilite_effectif,
          email_effectif,
          telephone_effectif,
          telephone2_effectif,
          adresse_effectif,
          code_postal_effectif,
          ville_effectif,
          pays_effectif,
          date_naissance_effectif,
          niveau_education,
          domaine_education,
          id_poste_actuel,
          type_contrat,
          matricule_interne,
          id_service,
          business_travel,
          date_entree_entreprise_effectif,
          date_sortie_prevue,
          statut_actif,
          motif_sortie,
          note_commentaire,
          archive,
          date_creation,
          dernier_update,
          havedatefin,
          ismanager,
          date_debut_poste_actuel,
          isformateur,
          is_temp,
          role_temp,
          code_effectif
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, FALSE, CURRENT_DATE, NOW(), %s, %s,
          %s, %s, %s, %s, %s
        )
        """,
        (cid, oid) + values,
    )

class CollaborateurPayload(BaseModel):
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: Optional[str] = None
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone2: Optional[str] = None
    adresse: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None
    pays: Optional[str] = None
    actif: Optional[bool] = None
    fonction: Optional[str] = None
    observations: Optional[str] = None

    id_service: Optional[str] = None
    id_poste_actuel: Optional[str] = None
    type_contrat: Optional[str] = None
    matricule_interne: Optional[str] = None
    business_travel: Optional[str] = None
    date_naissance: Optional[str] = None
    date_entree_entreprise: Optional[str] = None
    date_debut_poste_actuel: Optional[str] = None
    date_sortie_prevue: Optional[str] = None
    niveau_education: Optional[str] = None
    domaine_education: Optional[str] = None
    motif_sortie: Optional[str] = None
    note_commentaire: Optional[str] = None
    havedatefin: Optional[bool] = None
    ismanager: Optional[bool] = None
    isformateur: Optional[bool] = None
    is_temp: Optional[bool] = None
    role_temp: Optional[str] = None
    code_effectif: Optional[str] = None

class SyncPosteCompetencesPayload(BaseModel):
    id_poste_actuel: Optional[str] = None

class CollaborateurCompetenceRemovePayload(BaseModel):
    id_comp: Optional[str] = None

class CollaborateurCompetenceAddPayload(BaseModel):
    id_comp: Optional[str] = None

class CollaborateurCompetenceEvalCriterePayload(BaseModel):
    code_critere: str
    niveau: int
    commentaire: Optional[str] = None


class CollaborateurCompetenceEvalSavePayload(BaseModel):
    id_effectif_competence: str
    id_comp: Optional[str] = None
    resultat_eval: float
    niveau_actuel: str
    observation: Optional[str] = None
    criteres: List[CollaborateurCompetenceEvalCriterePayload]
    methode_eval: Optional[str] = "Évaluation Studio"

class CollaborateurAccessPayload(BaseModel):
    studio: Optional[str] = None
    insights: Optional[str] = None
    people: Optional[str] = None
    partner: Optional[str] = None
    learn: Optional[str] = None


class CollaborateurAccessBulkSendPayload(BaseModel):
    ids_collaborateurs: List[str] = []

def _normalize_skill_level_from_poste(value: Optional[str]) -> str:
    s = (_norm_text(value) or "").lower()
    s = (
        s.replace("é", "e")
         .replace("è", "e")
         .replace("ê", "e")
         .replace("ë", "e")
         .replace("à", "a")
         .replace("â", "a")
         .replace("î", "i")
         .replace("ï", "i")
         .replace("ô", "o")
         .replace("ö", "o")
         .replace("û", "u")
         .replace("ü", "u")
    )

    if s.startswith("exp"):
        return "Expert"
    if s.startswith("ava") or s.startswith("adv"):
        return "Avancé"
    return "Initial"


def _score_for_skill_level(niveau: str) -> float:
    if niveau == "Expert":
        return 19.0
    if niveau == "Avancé":
        return 10.0
    return 6.0


def _get_effectif_competence_columns(cur) -> set:
    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tbl_effectif_client_competence'
        """
    )
    return {
        (r.get("column_name") or "").strip()
        for r in (cur.fetchall() or [])
        if (r.get("column_name") or "").strip()
    }


def _insert_effectif_competence_row(cur, id_effectif_client: str, id_comp: str, niveau_actuel: str) -> str:
    cols = _get_effectif_competence_columns(cur)

    required = ("id_effectif_competence", "id_effectif_client", "id_comp", "niveau_actuel", "id_dernier_audit")
    missing = [c for c in required if c not in cols]
    if missing:
        raise HTTPException(
            status_code=500,
            detail="tbl_effectif_client_competence incomplète : " + ", ".join(missing),
        )

    row_id = str(uuid.uuid4())
    insert_cols = []
    placeholders = []
    params = []

    def add_value(col: str, value):
        if col in cols:
            insert_cols.append(col)
            placeholders.append("%s")
            params.append(value)

    def add_sql(col: str, expr: str):
        if col in cols:
            insert_cols.append(col)
            placeholders.append(expr)

    add_value("id_effectif_competence", row_id)
    add_value("id_effectif_client", id_effectif_client)
    add_value("id_comp", id_comp)
    add_value("niveau_actuel", niveau_actuel)
    add_value("id_dernier_audit", None)
    add_value("actif", True)
    add_value("archive", False)

    add_sql("date_derniere_eval", "CURRENT_DATE")
    add_sql("date_creation", "CURRENT_DATE")
    add_sql("dernier_update", "NOW()")

    cur.execute(
        f"""
        INSERT INTO public.tbl_effectif_client_competence (
          {", ".join(insert_cols)}
        ) VALUES (
          {", ".join(placeholders)}
        )
        """,
        tuple(params),
    )
    return row_id

def _insert_effectif_competence_row_empty(cur, id_effectif_client: str, id_comp: str) -> str:
    cols = _get_effectif_competence_columns(cur)

    required = ("id_effectif_competence", "id_effectif_client", "id_comp", "id_dernier_audit")
    missing = [c for c in required if c not in cols]
    if missing:
        raise HTTPException(
            status_code=500,
            detail="tbl_effectif_client_competence incomplète : " + ", ".join(missing),
        )

    row_id = str(uuid.uuid4())
    insert_cols = []
    placeholders = []
    params = []

    def add_value(col: str, value):
        if col in cols:
            insert_cols.append(col)
            placeholders.append("%s")
            params.append(value)

    def add_sql(col: str, expr: str):
        if col in cols:
            insert_cols.append(col)
            placeholders.append(expr)

    add_value("id_effectif_competence", row_id)
    add_value("id_effectif_client", id_effectif_client)
    add_value("id_comp", id_comp)
    add_value("id_dernier_audit", None)

    if "niveau_actuel" in cols:
        add_value("niveau_actuel", None)

    add_value("actif", True)
    add_value("archive", False)

    if "date_derniere_eval" in cols:
        add_value("date_derniere_eval", None)

    add_sql("date_creation", "CURRENT_DATE")
    add_sql("dernier_update", "NOW()")

    cur.execute(
        f"""
        INSERT INTO public.tbl_effectif_client_competence (
          {", ".join(insert_cols)}
        ) VALUES (
          {", ".join(placeholders)}
        )
        """,
        tuple(params),
    )
    return row_id

def _set_effectif_competence_last_audit(cur, id_effectif_competence: str, id_audit_competence: str, niveau_actuel: str) -> None:
    cols = _get_effectif_competence_columns(cur)

    if "id_dernier_audit" not in cols:
        raise HTTPException(status_code=500, detail="Colonne id_dernier_audit absente de tbl_effectif_client_competence.")

    set_parts = [
        "id_dernier_audit = %s",
        "niveau_actuel = %s",
    ]
    params = [id_audit_competence, niveau_actuel]

    if "date_derniere_eval" in cols:
        set_parts.append("date_derniere_eval = CURRENT_DATE")
    if "dernier_update" in cols:
        set_parts.append("dernier_update = NOW()")

    params.append(id_effectif_competence)

    cur.execute(
        f"""
        UPDATE public.tbl_effectif_client_competence
        SET {", ".join(set_parts)}
        WHERE id_effectif_competence = %s
        """,
        tuple(params),
    )

def _json_like_to_obj(value):
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return {}
        try:
            return json.loads(s)
        except Exception:
            return {}
    return {}

# ------------------------------------------------------
# Context
# ------------------------------------------------------
@router.get("/studio/collaborateurs/context/{id_owner}")
def studio_collab_context(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                owner = studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                src = _resolve_owner_source(cur, oid)
                services = _build_service_options(cur, oid, src["source_kind"])
                postes = _build_poste_options(cur, oid, src["source_kind"])
                consoles = _build_console_items(cur, oid)

                quota_summary = []
                for item in consoles:
                    if not item.get("contract_active"):
                        continue
                    quota_summary.append(
                        {
                            "console_code": item.get("console_code"),
                            "label": item.get("label"),
                            "contract_active": bool(item.get("contract_active")),
                            "max_access": int(item.get("max_access") or 0),
                            "used_access": int(item.get("used_access") or 0),
                            "available_access": int(item.get("available_access") or 0),
                            "is_unlimited": bool(item.get("is_unlimited")),
                            "offer_code": item.get("offer_code") or "",
                        }
                    )

        return {
            "id_owner": oid,
            "nom_owner": owner.get("nom_owner"),
            "source_kind": src["source_kind"],
            "source_label": src["source_label"],
            "source_name": src["source_name"],
            "services": services,
            "postes": postes,
            "consoles": consoles,
            "quota_summary": quota_summary,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/context error: {e}")


# ------------------------------------------------------
# Liste
# ------------------------------------------------------
@router.get("/studio/collaborateurs/list/{id_owner}")
def studio_collab_list(
    id_owner: str,
    request: Request,
    q: str = "",
    service: str = "__all__",
    poste: str = "__all__",
    active: str = "all",
    include_archived: int = 0,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()
        svc = (service or "__all__").strip()
        pst = (poste or "__all__").strip()
        act = (active or "all").strip().lower()
        inc_arch = int(include_archived or 0) == 1

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT
                        COUNT(1) AS total,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(statut_actif, TRUE) = TRUE
                        ) AS actifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(statut_actif, TRUE) = FALSE
                        ) AS inactifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = TRUE
                        ) AS archives
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                        """,
                        (oid,),
                    )
                    s = cur.fetchone() or {}
                else:
                    cur.execute(
                        """
                        SELECT
                        COUNT(1) AS total,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(actif, TRUE) = TRUE
                        ) AS actifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(actif, TRUE) = FALSE
                        ) AS inactifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = TRUE
                        ) AS archives
                        FROM public.tbl_utilisateur
                        """
                    )
                    s = cur.fetchone() or {}

                stats_global = {
                    "total": int(s.get("total") or 0),
                    "actifs": int(s.get("actifs") or 0),
                    "inactifs": int(s.get("inactifs") or 0),
                    "archives": int(s.get("archives") or 0),
                }

                items = []

                if src["source_kind"] == "entreprise":
                    where = ["e.id_ent = %s"]
                    params = [oid]

                    if not inc_arch:
                        where.append("COALESCE(e.archive, FALSE) = FALSE")

                    if svc not in ("", "__all__"):
                        if svc == "__none__":
                            where.append("e.id_service IS NULL")
                        else:
                            where.append("e.id_service = %s")
                            params.append(svc)

                    if pst not in ("", "__all__"):
                        if pst == "__none__":
                            where.append("e.id_poste_actuel IS NULL")
                        else:
                            where.append("e.id_poste_actuel = %s")
                            params.append(pst)

                    if act == "active":
                        where.append("COALESCE(e.statut_actif, TRUE) = TRUE")
                    elif act == "inactive":
                        where.append("COALESCE(e.statut_actif, TRUE) = FALSE")
                    elif act == "manager":
                        where.append("COALESCE(e.ismanager, FALSE) = TRUE")
                    elif act == "formateur":
                        where.append("COALESCE(e.isformateur, FALSE) = TRUE")

                    if qq:
                        like = f"%{qq}%"
                        where.append(
                            """
                            (
                              e.nom_effectif ILIKE %s
                              OR e.prenom_effectif ILIKE %s
                              OR COALESCE(e.email_effectif,'') ILIKE %s
                              OR COALESCE(e.code_effectif,'') ILIKE %s
                              OR COALESCE(e.matricule_interne,'') ILIKE %s
                            )
                            """
                        )
                        params.extend([like, like, like, like, like])

                    cur.execute(
                        f"""
                        SELECT
                          e.id_effectif AS id_collaborateur,
                          e.prenom_effectif AS prenom,
                          e.nom_effectif AS nom,
                          e.civilite_effectif AS civilite,
                          e.email_effectif AS email,
                          e.telephone_effectif AS telephone,
                          e.telephone2_effectif AS telephone2,
                          e.id_service,
                          COALESCE(s.nom_service, '') AS nom_service,
                          e.id_poste_actuel,
                          COALESCE(p.intitule_poste, '') AS intitule_poste,
                          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                          COALESCE(e.statut_actif, TRUE) AS actif,
                          COALESCE(e.archive, FALSE) AS archive,
                          COALESCE(e.ismanager, FALSE) AS ismanager,
                          COALESCE(e.isformateur, FALSE) AS isformateur,
                          COALESCE(e.is_temp, FALSE) AS is_temp,
                          e.role_temp,
                          e.type_contrat,
                          e.matricule_interne,
                          e.code_effectif,
                          e.date_entree_entreprise_effectif AS date_entree,
                          e.date_sortie_prevue,
                          e.note_commentaire,
                          'effectif_client' AS source_row_kind
                        FROM public.tbl_effectif_client e
                        LEFT JOIN public.tbl_entreprise_organigramme s
                          ON s.id_ent = e.id_ent
                         AND s.id_service = e.id_service
                         AND COALESCE(s.archive, FALSE) = FALSE
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_owner = e.id_ent
                         AND p.id_ent = e.id_ent
                         AND p.id_poste = e.id_poste_actuel
                        WHERE {" AND ".join(where)}
                        ORDER BY lower(e.nom_effectif), lower(e.prenom_effectif)
                        """,
                        tuple(params),
                    )
                    rows = cur.fetchall() or []

                    for r in rows:
                        code_poste = (r.get("code_poste") or "").strip()
                        intitule_poste = (r.get("intitule_poste") or "").strip()
                        poste_label = (f"{code_poste} · {intitule_poste}" if code_poste else intitule_poste).strip()
                        items.append(
                            {
                                "id_collaborateur": r.get("id_collaborateur"),
                                "source_kind": src["source_kind"],
                                "source_row_kind": r.get("source_row_kind"),
                                "civilite": r.get("civilite"),
                                "prenom": r.get("prenom"),
                                "nom": r.get("nom"),
                                "email": r.get("email"),
                                "telephone": r.get("telephone"),
                                "telephone2": r.get("telephone2"),
                                "id_service": r.get("id_service"),
                                "nom_service": r.get("nom_service"),
                                "id_poste_actuel": r.get("id_poste_actuel"),
                                "poste_label": poste_label,
                                "type_contrat": r.get("type_contrat"),
                                "matricule_interne": r.get("matricule_interne"),
                                "code_effectif": r.get("code_effectif"),
                                "date_entree": r.get("date_entree").isoformat() if r.get("date_entree") else None,
                                "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                                "actif": bool(r.get("actif")),
                                "archive": bool(r.get("archive")),
                                "ismanager": bool(r.get("ismanager")),
                                "isformateur": bool(r.get("isformateur")),
                                "is_temp": bool(r.get("is_temp")),
                                "role_temp": r.get("role_temp"),
                                "note_commentaire": r.get("note_commentaire"),
                            }
                        )
                else:
                    where = ["1=1"]
                    params = []

                    if not inc_arch:
                        where.append("COALESCE(u.archive, FALSE) = FALSE")

                    if svc not in ("", "__all__"):
                        if svc == "__none__":
                            where.append("COALESCE(ec.id_service, p.id_service) IS NULL")
                        else:
                            where.append("COALESCE(ec.id_service, p.id_service) = %s")
                            params.append(svc)

                    if pst not in ("", "__all__"):
                        if pst == "__none__":
                            where.append("COALESCE(ec.id_poste_actuel, p.id_poste) IS NULL")
                        else:
                            where.append("COALESCE(ec.id_poste_actuel, p.id_poste) = %s")
                            params.append(pst)

                    if act == "active":
                        where.append("COALESCE(u.actif, TRUE) = TRUE")
                    elif act == "inactive":
                        where.append("COALESCE(u.actif, TRUE) = FALSE")
                    elif act == "manager":
                        where.append("COALESCE(ec.ismanager, FALSE) = TRUE")
                    elif act == "formateur":
                        where.append("COALESCE(ec.isformateur, FALSE) = TRUE")

                    if qq:
                        like = f"%{qq}%"
                        where.append(
                            """
                            (
                              u.ut_nom ILIKE %s
                              OR u.ut_prenom ILIKE %s
                              OR COALESCE(u.ut_mail,'') ILIKE %s
                              OR COALESCE(p.intitule_poste,'') ILIKE %s
                              OR COALESCE(p.codif_client, p.codif_poste, '') ILIKE %s
                              OR COALESCE(ec.code_effectif, '') ILIKE %s
                              OR COALESCE(ec.matricule_interne, '') ILIKE %s
                            )
                            """
                        )
                        params.extend([like, like, like, like, like, like, like])

                    cur.execute(
                        f"""
                        SELECT
                          u.id_utilisateur AS id_collaborateur,
                          u.ut_prenom AS prenom,
                          u.ut_nom AS nom,
                          u.ut_civilite AS civilite,
                          u.ut_mail AS email,
                          u.ut_tel AS telephone,
                          u.ut_tel2 AS telephone2,
                          u.ut_fonction AS fonction,
                          u.ut_adresse AS adresse,
                          u.ut_cp AS code_postal,
                          u.ut_ville AS ville,
                          u.ut_pays AS pays,
                          COALESCE(u.actif, TRUE) AS actif,
                          COALESCE(u.archive, FALSE) AS archive,
                          u.ut_obs AS observations,
                          COALESCE(ec.id_poste_actuel, p.id_poste) AS id_poste_actuel,
                          COALESCE(ec.id_service, p.id_service) AS id_service,
                          COALESCE(p.intitule_poste, '') AS intitule_poste,
                          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                          COALESCE(s.nom_service, '') AS nom_service,
                          COALESCE(ec.ismanager, FALSE) AS ismanager,
                          COALESCE(ec.isformateur, FALSE) AS isformateur,
                          COALESCE(ec.is_temp, FALSE) AS is_temp,
                          ec.role_temp,
                          ec.type_contrat,
                          ec.matricule_interne,
                          ec.code_effectif,
                          ec.date_entree_entreprise_effectif AS date_entree,
                          ec.date_sortie_prevue,
                          ec.note_commentaire,
                          'utilisateur' AS source_row_kind
                        FROM public.tbl_utilisateur u
                        LEFT JOIN public.tbl_effectif_client ec
                          ON ec.id_ent = %s
                         AND ec.id_effectif = u.id_utilisateur
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
                         AND p.id_owner = %s
                         AND p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                        LEFT JOIN public.tbl_entreprise_organigramme s
                          ON s.id_service = COALESCE(ec.id_service, p.id_service)
                         AND s.id_ent = %s
                         AND COALESCE(s.archive, FALSE) = FALSE
                        WHERE {" AND ".join(where)}
                        ORDER BY lower(u.ut_nom), lower(u.ut_prenom)
                        """,
                        tuple([oid, oid, oid, oid] + params),
                    )
                    rows = cur.fetchall() or []

                    for r in rows:
                        code_poste = (r.get("code_poste") or "").strip()
                        intitule_poste = (r.get("intitule_poste") or "").strip()
                        poste_label = (f"{code_poste} · {intitule_poste}" if code_poste else intitule_poste).strip()

                        items.append(
                            {
                                "id_collaborateur": r.get("id_collaborateur"),
                                "source_kind": src["source_kind"],
                                "source_row_kind": r.get("source_row_kind"),
                                "civilite": r.get("civilite"),
                                "prenom": r.get("prenom"),
                                "nom": r.get("nom"),
                                "email": r.get("email"),
                                "telephone": r.get("telephone"),
                                "telephone2": r.get("telephone2"),
                                "fonction": r.get("fonction"),
                                "id_poste_actuel": r.get("id_poste_actuel"),
                                "id_service": r.get("id_service"),
                                "nom_service": r.get("nom_service"),
                                "poste_label": poste_label,
                                "adresse": r.get("adresse"),
                                "code_postal": r.get("code_postal"),
                                "ville": r.get("ville"),
                                "pays": r.get("pays"),
                                "actif": bool(r.get("actif")),
                                "archive": bool(r.get("archive")),
                                "ismanager": bool(r.get("ismanager")),
                                "isformateur": bool(r.get("isformateur")),
                                "is_temp": bool(r.get("is_temp")),
                                "role_temp": r.get("role_temp"),
                                "type_contrat": r.get("type_contrat"),
                                "matricule_interne": r.get("matricule_interne"),
                                "code_effectif": r.get("code_effectif"),
                                "date_entree": r.get("date_entree").isoformat() if r.get("date_entree") else None,
                                "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                                "note_commentaire": r.get("note_commentaire"),
                                "observations": r.get("observations"),
                            }
                        )
                access_summary_map = _fetch_access_summary_map(
                    cur,
                    oid,
                    [x.get("id_collaborateur") for x in items]
                )
                for it in items:
                    it["access_summary"] = access_summary_map.get(
                        (it.get("id_collaborateur") or "").strip(),
                        []
                    )                        

        return {"items": items, "stats": stats_global}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/list error: {e}")


# ------------------------------------------------------
# Détail
# ------------------------------------------------------
@router.get("/studio/collaborateurs/detail/{id_owner}/{id_collaborateur}")
def studio_collab_detail(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT
                          e.id_effectif AS id_collaborateur,
                          e.civilite_effectif AS civilite,
                          e.prenom_effectif AS prenom,
                          e.nom_effectif AS nom,
                          e.email_effectif AS email,
                          e.telephone_effectif AS telephone,
                          e.telephone2_effectif AS telephone2,
                          e.adresse_effectif AS adresse,
                          e.code_postal_effectif AS code_postal,
                          e.ville_effectif AS ville,
                          e.pays_effectif AS pays,
                          e.date_naissance_effectif AS date_naissance,
                          e.niveau_education,
                          e.domaine_education,
                          e.id_poste_actuel,
                          e.type_contrat,
                          e.matricule_interne,
                          e.id_service,
                          e.business_travel,
                          e.date_entree_entreprise_effectif AS date_entree_entreprise,
                          e.date_sortie_prevue,
                          COALESCE(e.statut_actif, TRUE) AS actif,
                          e.motif_sortie,
                          e.note_commentaire,
                          COALESCE(e.archive, FALSE) AS archive,
                          COALESCE(e.havedatefin, FALSE) AS havedatefin,
                          COALESCE(e.ismanager, FALSE) AS ismanager,
                          e.date_debut_poste_actuel,
                          e.type_obtention,
                          COALESCE(e.isformateur, FALSE) AS isformateur,
                          COALESCE(e.is_temp, FALSE) AS is_temp,
                          e.role_temp,
                          e.code_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.id_effectif = %s
                        LIMIT 1
                        """,
                        (oid, cid),
                    )
                    r = cur.fetchone() or {}
                    if not r:
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                    return {
                        "id_collaborateur": r.get("id_collaborateur"),
                        "source_kind": src["source_kind"],
                        "source_row_kind": "effectif_client",
                        "civilite": r.get("civilite"),
                        "prenom": r.get("prenom"),
                        "nom": r.get("nom"),
                        "email": r.get("email"),
                        "telephone": r.get("telephone"),
                        "telephone2": r.get("telephone2"),
                        "adresse": r.get("adresse"),
                        "code_postal": r.get("code_postal"),
                        "ville": r.get("ville"),
                        "pays": r.get("pays"),
                        "date_naissance": r.get("date_naissance").isoformat() if r.get("date_naissance") else None,
                        "niveau_education": r.get("niveau_education"),
                        "domaine_education": r.get("domaine_education"),
                        "id_service": r.get("id_service"),
                        "id_poste_actuel": r.get("id_poste_actuel"),
                        "type_contrat": r.get("type_contrat"),
                        "matricule_interne": r.get("matricule_interne"),
                        "business_travel": r.get("business_travel"),
                        "date_entree_entreprise": r.get("date_entree_entreprise").isoformat() if r.get("date_entree_entreprise") else None,
                        "date_debut_poste_actuel": r.get("date_debut_poste_actuel").isoformat() if r.get("date_debut_poste_actuel") else None,
                        "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                        "actif": bool(r.get("actif")),
                        "motif_sortie": r.get("motif_sortie"),
                        "note_commentaire": r.get("note_commentaire"),
                        "archive": bool(r.get("archive")),
                        "havedatefin": bool(r.get("havedatefin")),
                        "ismanager": bool(r.get("ismanager")),
                        "isformateur": bool(r.get("isformateur")),
                        "is_temp": bool(r.get("is_temp")),
                        "role_temp": r.get("role_temp"),
                        "code_effectif": r.get("code_effectif"),
                    }

                cur.execute(
                    """
                    SELECT
                      u.id_utilisateur AS id_collaborateur,
                      u.ut_civilite AS civilite,
                      u.ut_prenom AS prenom,
                      u.ut_nom AS nom,
                      u.ut_mail AS email,
                      u.ut_tel AS telephone,
                      u.ut_tel2 AS telephone2,
                      u.ut_fonction AS fonction,
                      u.ut_adresse AS adresse,
                      u.ut_cp AS code_postal,
                      u.ut_ville AS ville,
                      u.ut_pays AS pays,
                      COALESCE(u.actif, TRUE) AS actif,
                      COALESCE(u.archive, FALSE) AS archive,
                      u.ut_obs AS observations,
                      ec.date_naissance_effectif AS date_naissance,
                      ec.niveau_education,
                      ec.domaine_education,
                      COALESCE(ec.id_poste_actuel, p.id_poste) AS id_poste_actuel,
                      ec.type_contrat,
                      ec.matricule_interne,
                      COALESCE(ec.id_service, p.id_service) AS id_service,
                      ec.business_travel,
                      ec.date_entree_entreprise_effectif AS date_entree_entreprise,
                      ec.date_sortie_prevue,
                      ec.motif_sortie,
                      ec.note_commentaire,
                      COALESCE(ec.havedatefin, FALSE) AS havedatefin,
                      COALESCE(ec.ismanager, FALSE) AS ismanager,
                      ec.date_debut_poste_actuel,
                      COALESCE(ec.isformateur, FALSE) AS isformateur,
                      COALESCE(ec.is_temp, FALSE) AS is_temp,
                      ec.role_temp,
                      ec.code_effectif,
                      COALESCE(p.intitule_poste, '') AS intitule_poste,
                      COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                      COALESCE(s.nom_service, '') AS nom_service
                    FROM public.tbl_utilisateur u
                    LEFT JOIN public.tbl_effectif_client ec
                      ON ec.id_ent = %s
                     AND ec.id_effectif = u.id_utilisateur
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                     AND COALESCE(p.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme s
                      ON s.id_service = COALESCE(ec.id_service, p.id_service)
                     AND s.id_ent = %s
                     AND COALESCE(s.archive, FALSE) = FALSE
                    WHERE u.id_utilisateur = %s
                    LIMIT 1
                    """,
                    (oid, oid, oid, oid, cid),
                )
                r = cur.fetchone() or {}
                if not r:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                code_poste = (r.get("code_poste") or "").strip()
                intitule_poste = (r.get("intitule_poste") or "").strip()
                poste_label = (f"{code_poste} · {intitule_poste}" if code_poste else intitule_poste).strip()

                return {
                    "id_collaborateur": r.get("id_collaborateur"),
                    "source_kind": src["source_kind"],
                    "source_row_kind": "utilisateur",
                    "civilite": r.get("civilite"),
                    "prenom": r.get("prenom"),
                    "nom": r.get("nom"),
                    "email": r.get("email"),
                    "telephone": r.get("telephone"),
                    "telephone2": r.get("telephone2"),
                    "fonction": r.get("fonction"),
                    "id_poste_actuel": r.get("id_poste_actuel"),
                    "id_service": r.get("id_service"),
                    "nom_service": r.get("nom_service"),
                    "poste_label": poste_label,
                    "adresse": r.get("adresse"),
                    "code_postal": r.get("code_postal"),
                    "ville": r.get("ville"),
                    "pays": r.get("pays"),
                    "date_naissance": r.get("date_naissance").isoformat() if r.get("date_naissance") else None,
                    "niveau_education": r.get("niveau_education"),
                    "domaine_education": r.get("domaine_education"),
                    "type_contrat": r.get("type_contrat"),
                    "matricule_interne": r.get("matricule_interne"),
                    "business_travel": r.get("business_travel"),
                    "date_entree_entreprise": r.get("date_entree_entreprise").isoformat() if r.get("date_entree_entreprise") else None,
                    "date_debut_poste_actuel": r.get("date_debut_poste_actuel").isoformat() if r.get("date_debut_poste_actuel") else None,
                    "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                    "motif_sortie": r.get("motif_sortie"),
                    "note_commentaire": r.get("note_commentaire"),
                    "actif": bool(r.get("actif")),
                    "archive": bool(r.get("archive")),
                    "havedatefin": bool(r.get("havedatefin")),
                    "ismanager": bool(r.get("ismanager")),
                    "isformateur": bool(r.get("isformateur")),
                    "is_temp": bool(r.get("is_temp")),
                    "role_temp": r.get("role_temp"),
                    "code_effectif": r.get("code_effectif"),
                    "observations": r.get("observations"),
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/detail error: {e}")

@router.get("/studio/collaborateurs/competences/{id_owner}/{id_collaborateur}")
def studio_collab_competences(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                cur.execute(
                    """
                    WITH req AS (
                        SELECT
                            fpc.id_competence AS id_comp,
                            fpc.niveau_requis,
                            fpc.poids_criticite,
                            fpc.freq_usage,
                            fpc.impact_resultat,
                            fpc.dependance
                        FROM public.tbl_fiche_poste_competence fpc
                        WHERE fpc.id_poste = %s
                    ),
                    curc AS (
                        SELECT
                            ecc.id_effectif_competence,
                            ecc.id_comp,
                            ecc.niveau_actuel,
                            ecc.date_derniere_eval,
                            ecc.id_dernier_audit
                        FROM public.tbl_effectif_client_competence ecc
                        WHERE ecc.id_effectif_client = %s
                          AND ecc.actif = TRUE
                          AND ecc.archive = FALSE
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine,
                        (req.id_comp IS NOT NULL) AS is_required,
                        req.niveau_requis,
                        curc.id_effectif_competence,
                        curc.niveau_actuel,
                        curc.date_derniere_eval,
                        curc.id_dernier_audit,
                        req.poids_criticite,
                        req.freq_usage,
                        req.impact_resultat,
                        req.dependance
                    FROM public.tbl_competence c
                    LEFT JOIN req
                      ON req.id_comp = c.id_comp
                    LEFT JOIN curc
                      ON curc.id_comp = c.id_comp
                    WHERE (req.id_comp IS NOT NULL OR curc.id_comp IS NOT NULL)
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    ORDER BY
                      (req.id_comp IS NULL) ASC,
                      COALESCE(req.poids_criticite, 0) DESC,
                      c.intitule
                    """,
                    (scope["id_poste_actuel"], scope["id_effectif_data"]),
                )
                rows = cur.fetchall() or []

                domaine_ids = []
                seen = set()
                for rr in rows:
                    did = (rr.get("domaine") or "").strip()
                    if did and did not in seen:
                        seen.add(did)
                        domaine_ids.append(did)
                domaine_map = _load_domaine_competence_map(cur, domaine_ids)

        items = []
        for r in rows:
            dmeta = domaine_map.get((r.get("domaine") or "").strip(), {})
            items.append(
                {
                    "id_effectif_competence": r.get("id_effectif_competence"),
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "domaine": r.get("domaine"),
                    "domaine_titre": dmeta.get("titre"),
                    "domaine_couleur": dmeta.get("couleur"),
                    "is_required": bool(r.get("is_required")),
                    "niveau_requis": r.get("niveau_requis"),
                    "niveau_actuel": r.get("niveau_actuel"),
                    "date_derniere_eval": r.get("date_derniere_eval").isoformat() if r.get("date_derniere_eval") else None,
                    "id_dernier_audit": r.get("id_dernier_audit"),
                    "poids_criticite": r.get("poids_criticite"),
                    "freq_usage": r.get("freq_usage"),
                    "impact_resultat": r.get("impact_resultat"),
                    "dependance": r.get("dependance"),
                }
            )

        return {
            "id_collaborateur": cid,
            "id_poste_actuel": scope.get("id_poste_actuel"),
            "intitule_poste": scope.get("intitule_poste"),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences error: {e}")

@router.post("/studio/collaborateurs/competences/sync-poste/{id_owner}/{id_collaborateur}")
def studio_collab_sync_competences_from_poste(
    id_owner: str,
    id_collaborateur: str,
    payload: SyncPosteCompetencesPayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                id_poste = _norm_text(payload.id_poste_actuel) or _norm_text(scope.get("id_poste_actuel"))
                if not id_poste:
                    raise HTTPException(status_code=400, detail="Aucun poste actuel sélectionné.")

                _fetch_poste_service(cur, oid, id_poste)

                cur.execute(
                    """
                    SELECT COALESCE(intitule_poste, '') AS intitule_poste
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (id_poste, oid, oid),
                )
                poste_row = cur.fetchone() or {}
                intitule_poste = (poste_row.get("intitule_poste") or "").strip() or None

                cur.execute(
                    """
                    SELECT
                      fpc.id_competence AS id_comp,
                      fpc.niveau_requis
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN public.tbl_competence c
                      ON c.id_comp = fpc.id_competence
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'active') = 'active'
                    WHERE fpc.id_poste = %s
                    ORDER BY COALESCE(fpc.poids_criticite, 0) DESC, c.intitule
                    """,
                    (id_poste,),
                )
                req_rows = cur.fetchall() or []

                ecc_cols = _get_effectif_competence_columns(cur)
                active_where = " AND COALESCE(ecc.actif, TRUE) = TRUE" if "actif" in ecc_cols else ""

                cur.execute(
                    f"""
                    SELECT ecc.id_comp
                    FROM public.tbl_effectif_client_competence ecc
                    WHERE ecc.id_effectif_client = %s
                      AND COALESCE(ecc.archive, FALSE) = FALSE
                      {active_where}
                    """,
                    (id_effectif_data,),
                )
                existing_ids = {
                    (r.get("id_comp") or "").strip()
                    for r in (cur.fetchall() or [])
                    if (r.get("id_comp") or "").strip()
                }

                inserted = 0
                skipped_existing = 0

                for r in req_rows:
                    id_comp = (r.get("id_comp") or "").strip()
                    if not id_comp:
                        continue

                    if id_comp in existing_ids:
                        skipped_existing += 1
                        continue

                    niveau = _normalize_skill_level_from_poste(r.get("niveau_requis"))
                    note = _score_for_skill_level(niveau)

                    id_effectif_competence = _insert_effectif_competence_row(
                        cur,
                        id_effectif_data,
                        id_comp,
                        niveau,
                    )

                    id_audit = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_effectif_client_audit_competence (
                          id_audit_competence,
                          id_effectif_competence,
                          date_audit,
                          methode_eval,
                          resultat_eval
                        ) VALUES (
                          %s, %s, CURRENT_DATE, %s, %s
                        )
                        """,
                        (
                            id_audit,
                            id_effectif_competence,
                            "synchro_premier",
                            note,
                        ),
                    )

                    _set_effectif_competence_last_audit(
                        cur,
                        id_effectif_competence,
                        id_audit,
                        niveau,
                    )

                    existing_ids.add(id_comp)
                    inserted += 1

                conn.commit()

        return {
            "ok": True,
            "id_collaborateur": cid,
            "id_effectif_data": id_effectif_data,
            "id_poste_actuel": id_poste,
            "intitule_poste": intitule_poste,
            "inserted": inserted,
            "skipped_existing": skipped_existing,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/sync-poste error: {e}")

@router.post("/studio/collaborateurs/competences/{id_owner}/{id_collaborateur}/add")
def studio_collab_add_competence(
    id_owner: str,
    id_collaborateur: str,
    payload: CollaborateurCompetenceAddPayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        id_comp = _norm_text(payload.id_comp)
        if not id_comp:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      COALESCE(c.etat, 'active') AS etat
                    FROM public.tbl_competence c
                    WHERE c.id_owner = %s
                      AND c.id_comp = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    LIMIT 1
                    """,
                    (oid, id_comp),
                )
                comp = cur.fetchone() or {}
                if not comp:
                    raise HTTPException(status_code=404, detail="Compétence introuvable dans le catalogue owner.")

                ecc_cols = _get_effectif_competence_columns(cur)

                archive_expr = "COALESCE(archive, FALSE)" if "archive" in ecc_cols else "FALSE"
                actif_expr = "COALESCE(actif, TRUE)" if "actif" in ecc_cols else "TRUE"
                order_expr = "COALESCE(dernier_update, NOW()) DESC" if "dernier_update" in ecc_cols else "id_effectif_competence DESC"

                cur.execute(
                    f"""
                    SELECT
                      id_effectif_competence,
                      {archive_expr} AS archive_row,
                      {actif_expr} AS actif_row
                    FROM public.tbl_effectif_client_competence
                    WHERE id_effectif_client = %s
                      AND id_comp = %s
                    ORDER BY
                      {archive_expr} ASC,
                      {actif_expr} DESC,
                      {order_expr}
                    LIMIT 1
                    """,
                    (id_effectif_data, id_comp),
                )
                existing = cur.fetchone() or {}

                if existing.get("id_effectif_competence") and not bool(existing.get("archive_row")) and bool(existing.get("actif_row")):
                    return {
                        "ok": True,
                        "id_collaborateur": cid,
                        "id_effectif_data": id_effectif_data,
                        "id_comp": id_comp,
                        "code": (comp.get("code") or "").strip(),
                        "intitule": (comp.get("intitule") or "").strip(),
                        "inserted": False,
                        "already_exists": True,
                        "niveau_actuel": None,
                    }

                if existing.get("id_effectif_competence"):
                    id_effectif_competence = (existing.get("id_effectif_competence") or "").strip()

                    set_parts = []
                    params = []

                    if "niveau_actuel" in ecc_cols:
                        set_parts.append("niveau_actuel = %s")
                        params.append(None)

                    if "id_dernier_audit" in ecc_cols:
                        set_parts.append("id_dernier_audit = %s")
                        params.append(None)

                    if "actif" in ecc_cols:
                        set_parts.append("actif = TRUE")

                    if "archive" in ecc_cols:
                        set_parts.append("archive = FALSE")

                    if "date_derniere_eval" in ecc_cols:
                        set_parts.append("date_derniere_eval = %s")
                        params.append(None)

                    if "dernier_update" in ecc_cols:
                        set_parts.append("dernier_update = NOW()")

                    params.append(id_effectif_competence)

                    cur.execute(
                        f"""
                        UPDATE public.tbl_effectif_client_competence
                        SET {", ".join(set_parts)}
                        WHERE id_effectif_competence = %s
                        """,
                        tuple(params),
                    )
                    action = "reactivated"
                else:
                    _insert_effectif_competence_row_empty(
                        cur,
                        id_effectif_data,
                        id_comp,
                    )
                    action = "inserted"

                conn.commit()

        return {
            "ok": True,
            "id_collaborateur": cid,
            "id_effectif_data": id_effectif_data,
            "id_comp": id_comp,
            "code": (comp.get("code") or "").strip(),
            "intitule": (comp.get("intitule") or "").strip(),
            "inserted": True,
            "already_exists": False,
            "action": action,
            "niveau_actuel": None,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/add error: {e}")

@router.post("/studio/collaborateurs/competences/{id_owner}/{id_collaborateur}/remove")
def studio_collab_remove_competence(
    id_owner: str,
    id_collaborateur: str,
    payload: CollaborateurCompetenceRemovePayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        id_comp = _norm_text(payload.id_comp)
        if not id_comp:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                ecc_cols = _get_effectif_competence_columns(cur)
                if "id_effectif_competence" not in ecc_cols:
                    raise HTTPException(status_code=500, detail="Colonne id_effectif_competence absente de tbl_effectif_client_competence.")

                archive_expr = "COALESCE(archive, FALSE)" if "archive" in ecc_cols else "FALSE"
                actif_expr = "COALESCE(actif, TRUE)" if "actif" in ecc_cols else "TRUE"
                order_expr = "COALESCE(dernier_update, NOW()) DESC" if "dernier_update" in ecc_cols else "id_effectif_competence DESC"

                cur.execute(
                    f"""
                    SELECT
                      id_effectif_competence,
                      {archive_expr} AS archive_row,
                      {actif_expr} AS actif_row
                    FROM public.tbl_effectif_client_competence
                    WHERE id_effectif_client = %s
                      AND id_comp = %s
                    ORDER BY
                      {archive_expr} ASC,
                      {actif_expr} DESC,
                      {order_expr}
                    LIMIT 1
                    """,
                    (id_effectif_data, id_comp),
                )
                row = cur.fetchone() or {}
                id_effectif_competence = (row.get("id_effectif_competence") or "").strip()
                if not id_effectif_competence:
                    raise HTTPException(status_code=404, detail="Compétence non trouvée sur ce collaborateur.")

                set_parts = []
                params = []

                if "actif" in ecc_cols:
                    set_parts.append("actif = %s")
                    params.append(False)

                if "archive" in ecc_cols:
                    set_parts.append("archive = %s")
                    params.append(False)

                if "dernier_update" in ecc_cols:
                    set_parts.append("dernier_update = NOW()")

                if not set_parts:
                    raise HTTPException(status_code=500, detail="Aucun champ modifiable disponible sur tbl_effectif_client_competence.")

                params.append(id_effectif_competence)

                cur.execute(
                    f"""
                    UPDATE public.tbl_effectif_client_competence
                    SET {", ".join(set_parts)}
                    WHERE id_effectif_competence = %s
                    """,
                    tuple(params),
                )

                conn.commit()

        return {
            "ok": True,
            "id_collaborateur": cid,
            "id_effectif_data": id_effectif_data,
            "id_comp": id_comp,
            "removed": True,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/remove error: {e}")

@router.get("/studio/collaborateurs/competences/evaluation/{id_owner}/{id_collaborateur}/{id_effectif_competence}")
def studio_collab_competence_evaluation_detail(
    id_owner: str,
    id_collaborateur: str,
    id_effectif_competence: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        idec = (id_effectif_competence or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not idec:
            raise HTTPException(status_code=400, detail="id_effectif_competence manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                cur.execute(
                    """
                    SELECT
                      ecc.id_effectif_competence,
                      ecc.id_effectif_client,
                      ecc.id_comp,
                      ecc.niveau_actuel,
                      ecc.date_derniere_eval,
                      ecc.id_dernier_audit,
                      c.code,
                      c.intitule,
                      c.domaine,
                      c.grille_evaluation,
                      a.id_audit_competence,
                      a.date_audit,
                      a.nom_evaluateur,
                      a.methode_eval,
                      a.resultat_eval,
                      a.observation,
                      a.detail_eval
                    FROM public.tbl_effectif_client_competence ecc
                    JOIN public.tbl_competence c
                      ON c.id_comp = ecc.id_comp
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    LEFT JOIN LATERAL (
                      SELECT
                        aa.id_audit_competence,
                        aa.date_audit,
                        aa.nom_evaluateur,
                        aa.methode_eval,
                        aa.resultat_eval,
                        aa.observation,
                        aa.detail_eval
                      FROM public.tbl_effectif_client_audit_competence aa
                      WHERE aa.id_effectif_competence = ecc.id_effectif_competence
                      ORDER BY aa.date_audit DESC, aa.id_audit_competence DESC
                      LIMIT 1
                    ) a ON TRUE
                    WHERE ecc.id_effectif_competence = %s
                      AND ecc.id_effectif_client = %s
                      AND COALESCE(ecc.archive, FALSE) = FALSE
                      AND COALESCE(ecc.actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (idec, id_effectif_data),
                )
                row = cur.fetchone() or {}
                if not row:
                    raise HTTPException(status_code=404, detail="Compétence collaborateur introuvable.")

                did = (row.get("domaine") or "").strip()
                dmeta = _load_domaine_competence_map(cur, [did]).get(did, {}) if did else {}

                grille = _json_like_to_obj(row.get("grille_evaluation"))
                if not isinstance(grille, dict):
                    grille = {}

                detail_eval = _json_like_to_obj(row.get("detail_eval"))
                if not isinstance(detail_eval, dict):
                    detail_eval = {}

        return {
            "id_collaborateur": cid,
            "id_effectif_competence": row.get("id_effectif_competence"),
            "id_comp": row.get("id_comp"),
            "code": row.get("code"),
            "intitule": row.get("intitule"),
            "domaine": row.get("domaine"),
            "domaine_titre": dmeta.get("titre"),
            "domaine_couleur": dmeta.get("couleur"),
            "niveau_actuel": row.get("niveau_actuel"),
            "date_derniere_eval": row.get("date_derniere_eval").isoformat() if row.get("date_derniere_eval") else None,
            "grille_evaluation": grille,
            "last_audit": {
                "id_audit_competence": row.get("id_audit_competence"),
                "date_audit": row.get("date_audit").isoformat() if row.get("date_audit") else None,
                "nom_evaluateur": row.get("nom_evaluateur"),
                "methode_eval": row.get("methode_eval"),
                "resultat_eval": float(row.get("resultat_eval")) if row.get("resultat_eval") is not None else None,
                "observation": row.get("observation"),
                "detail_eval": detail_eval,
            } if row.get("id_audit_competence") else None,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/evaluation/detail error: {e}")

@router.post("/studio/collaborateurs/competences/evaluation/{id_owner}/{id_collaborateur}/save")
def studio_collab_competence_evaluation_save(
    id_owner: str,
    id_collaborateur: str,
    payload: CollaborateurCompetenceEvalSavePayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        if payload.niveau_actuel not in ["Initial", "Avancé", "Expert"]:
            raise HTTPException(status_code=400, detail="niveau_actuel invalide (Initial/Avancé/Expert attendu).")

        if not payload.criteres or len(payload.criteres) > 4:
            raise HTTPException(status_code=400, detail="Liste de critères invalide.")

        for c in payload.criteres:
            if c.niveau < 1 or c.niveau > 4:
                raise HTTPException(status_code=400, detail="Note critère invalide (1..4).")
            if c.code_critere not in ["Critere1", "Critere2", "Critere3", "Critere4"]:
                raise HTTPException(status_code=400, detail="code_critere invalide (Critere1..4).")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                cur.execute(
                    """
                    SELECT
                      ecc.id_effectif_competence,
                      ecc.id_effectif_client,
                      ecc.id_comp
                    FROM public.tbl_effectif_client_competence ecc
                    WHERE ecc.id_effectif_competence = %s
                      AND ecc.id_effectif_client = %s
                      AND COALESCE(ecc.archive, FALSE) = FALSE
                      AND COALESCE(ecc.actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (payload.id_effectif_competence, id_effectif_data),
                )
                row = cur.fetchone() or {}
                if not row:
                    raise HTTPException(status_code=404, detail="Ligne compétence salarié introuvable.")

                if payload.id_comp and payload.id_comp != row.get("id_comp"):
                    raise HTTPException(status_code=400, detail="id_comp ne correspond pas à la ligne effectif_competence.")

                id_audit = str(uuid.uuid4())
                today = py_date.today()

                actor_id = (u.get("sub") or u.get("id") or "").strip() or None
                nom_eval = _resolve_actor_display_name(cur, u, oid)
                methode_eval = (payload.methode_eval or "Évaluation Studio").strip() or "Évaluation Studio"

                detail_eval = {
                    "criteres": [
                        {
                            "niveau": int(c.niveau),
                            "code_critere": c.code_critere,
                            **({"commentaire": (c.commentaire or "").strip()} if (c.commentaire or "").strip() else {}),
                        }
                        for c in payload.criteres
                    ]
                }

                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_audit_competence
                    (
                        id_audit_competence,
                        id_effectif_competence,
                        date_audit,
                        id_evaluateur,
                        methode_eval,
                        resultat_eval,
                        detail_eval,
                        observation,
                        nametable_evaluateur,
                        nom_evaluateur
                    )
                    VALUES
                    (
                        %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s,
                        %s, %s
                    )
                    """,
                    (
                        id_audit,
                        payload.id_effectif_competence,
                        today,
                        actor_id,
                        methode_eval,
                        round(float(payload.resultat_eval), 1),
                        json.dumps(detail_eval, ensure_ascii=False),
                        (payload.observation or None),
                        "tbl_utilisateur",
                        nom_eval,
                    ),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_competence
                    SET
                        niveau_actuel = %s,
                        date_derniere_eval = %s,
                        id_dernier_audit = %s
                    WHERE id_effectif_competence = %s
                    """,
                    (
                        payload.niveau_actuel,
                        today,
                        id_audit,
                        payload.id_effectif_competence,
                    ),
                )

                conn.commit()

        return {
            "ok": True,
            "id_audit_competence": id_audit,
            "date_audit": str(today),
            "niveau_actuel": payload.niveau_actuel,
            "resultat_eval": round(float(payload.resultat_eval), 1),
            "observation": payload.observation or None,
            "methode_eval": methode_eval,
            "nom_evaluateur": nom_eval,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/evaluation/save error: {e}")

@router.get("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}")
def studio_collab_certifications(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                cur.execute(
                    """
                    WITH req AS (
                        SELECT
                            fpc.id_certification,
                            fpc.validite_override,
                            fpc.niveau_exigence,
                            fpc.commentaire
                        FROM public.tbl_fiche_poste_certification fpc
                        WHERE fpc.id_poste = %s
                    ),
                    curc_raw AS (
                        SELECT
                            ecc.*,
                            ROW_NUMBER() OVER (
                                PARTITION BY ecc.id_certification
                                ORDER BY
                                    ecc.date_obtention DESC NULLS LAST,
                                    ecc.date_creation DESC,
                                    ecc.id_effectif_certification DESC
                            ) AS rn
                        FROM public.tbl_effectif_client_certification ecc
                        WHERE ecc.id_effectif = %s
                          AND ecc.archive = FALSE
                    ),
                    curc AS (
                        SELECT
                            id_effectif_certification,
                            id_certification,
                            date_obtention,
                            date_expiration,
                            organisme,
                            reference,
                            commentaire,
                            id_preuve_doc
                        FROM curc_raw
                        WHERE rn = 1
                    ),
                    base AS (
                        SELECT
                            c.id_certification,
                            c.nom_certification,
                            c.description,
                            c.categorie,
                            c.delai_renouvellement,
                            (req.id_certification IS NOT NULL) AS is_required,
                            COALESCE(req.niveau_exigence, 'requis') AS niveau_exigence,
                            c.duree_validite AS validite_reference,
                            req.validite_override,
                            COALESCE(req.validite_override, c.duree_validite) AS validite_attendue,
                            req.commentaire AS commentaire_poste,
                            (curc.id_certification IS NOT NULL) AS is_acquired,
                            curc.id_effectif_certification,
                            curc.date_obtention,
                            curc.date_expiration,
                            curc.organisme,
                            curc.reference,
                            curc.commentaire,
                            curc.id_preuve_doc,
                            CASE
                                WHEN curc.date_expiration IS NULL
                                 AND curc.date_obtention IS NOT NULL
                                 AND COALESCE(req.validite_override, c.duree_validite) IS NOT NULL
                                THEN (curc.date_obtention + make_interval(months => COALESCE(req.validite_override, c.duree_validite)))::date
                                ELSE NULL
                            END AS date_expiration_calculee
                        FROM public.tbl_certification c
                        LEFT JOIN req
                          ON req.id_certification = c.id_certification
                        LEFT JOIN curc
                          ON curc.id_certification = c.id_certification
                        WHERE (req.id_certification IS NOT NULL OR curc.id_certification IS NOT NULL)
                          AND COALESCE(c.masque, FALSE) = FALSE
                    ),
                    calc AS (
                        SELECT
                            b.*,
                            COALESCE(b.date_expiration, b.date_expiration_calculee) AS date_expiration_effective
                        FROM base b
                    )
                    SELECT
                        c.*,
                        CASE
                            WHEN c.date_expiration_effective IS NULL THEN NULL
                            WHEN c.date_expiration_effective < CURRENT_DATE THEN 'expiree'
                            WHEN c.date_expiration_effective < (CURRENT_DATE + COALESCE(c.delai_renouvellement, 60)) THEN 'a_renouveler'
                            ELSE 'valide'
                        END AS statut_validite,
                        CASE
                            WHEN c.date_expiration_effective IS NULL THEN NULL
                            ELSE (c.date_expiration_effective - CURRENT_DATE)
                        END AS jours_restants
                    FROM calc c
                    ORDER BY
                        (c.is_required = FALSE) ASC,
                        CASE lower(COALESCE(c.niveau_exigence, 'requis'))
                            WHEN 'requis' THEN 0
                            WHEN 'souhaite' THEN 1
                            WHEN 'souhaité' THEN 1
                            ELSE 2
                        END ASC,
                        COALESCE(c.categorie, '') ASC,
                        c.nom_certification
                    """,
                    (scope["id_poste_actuel"], scope["id_effectif_data"]),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            jr = r.get("jours_restants")
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "categorie": r.get("categorie"),
                    "description": r.get("description"),
                    "is_required": bool(r.get("is_required")),
                    "niveau_exigence": r.get("niveau_exigence"),
                    "validite_reference": r.get("validite_reference"),
                    "validite_override": r.get("validite_override"),
                    "validite_attendue": r.get("validite_attendue"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                    "commentaire_poste": r.get("commentaire_poste"),
                    "is_acquired": bool(r.get("is_acquired")),
                    "id_effectif_certification": r.get("id_effectif_certification"),
                    "date_obtention": r.get("date_obtention").isoformat() if r.get("date_obtention") else None,
                    "date_expiration": r.get("date_expiration").isoformat() if r.get("date_expiration") else None,
                    "date_expiration_calculee": r.get("date_expiration_calculee").isoformat() if r.get("date_expiration_calculee") else None,
                    "statut_validite": r.get("statut_validite"),
                    "jours_restants": int(jr) if jr is not None else None,
                    "organisme": r.get("organisme"),
                    "reference": r.get("reference"),
                    "commentaire": r.get("commentaire"),
                    "id_preuve_doc": r.get("id_preuve_doc"),
                }
            )

        return {
            "id_collaborateur": cid,
            "id_poste_actuel": scope.get("id_poste_actuel"),
            "intitule_poste": scope.get("intitule_poste"),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications error: {e}")


@router.get("/studio/collaborateurs/historique/formations-jmb/{id_owner}/{id_collaborateur}")
def studio_collab_historique_formations_jmb(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                _get_collab_scope(cur, oid, src["source_kind"], cid)

                cur.execute(
                    """
                    SELECT
                      acfe.id_action_formation_effectif,
                      acfe.id_action_formation,
                      COALESCE(acfe.archive, FALSE) AS archive_inscription,
                      af.code_action_formation,
                      af.etat_action,
                      af.date_debut_formation,
                      af.date_fin_formation,
                      COALESCE(af.archive, FALSE) AS archive_action,
                      af.id_form,
                      ff.code AS code_formation,
                      ff.titre AS titre_formation
                    FROM public.tbl_action_formation_effectif acfe
                    LEFT JOIN public.tbl_action_formation af
                      ON af.id_action_formation = acfe.id_action_formation
                    LEFT JOIN public.tbl_fiche_formation ff
                      ON ff.id_form = af.id_form
                    WHERE acfe.id_effectif = %s
                      AND acfe.id_action_formation IS NOT NULL
                      AND COALESCE(acfe.archive, FALSE) = FALSE
                      AND COALESCE(af.archive, FALSE) = FALSE
                      AND (ff.id_form IS NULL OR COALESCE(ff.masque, FALSE) = FALSE)
                    ORDER BY
                      af.date_fin_formation DESC NULLS LAST,
                      af.date_debut_formation DESC NULLS LAST,
                      af.date_creation DESC NULLS LAST,
                      acfe.id_action_formation_effectif DESC
                    """,
                    (cid,),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_action_formation_effectif": r.get("id_action_formation_effectif"),
                    "id_action_formation": r.get("id_action_formation"),
                    "code_action_formation": r.get("code_action_formation"),
                    "etat_action": r.get("etat_action"),
                    "date_debut_formation": r.get("date_debut_formation").isoformat() if r.get("date_debut_formation") else None,
                    "date_fin_formation": r.get("date_fin_formation").isoformat() if r.get("date_fin_formation") else None,
                    "id_form": r.get("id_form"),
                    "code_formation": r.get("code_formation"),
                    "titre_formation": r.get("titre_formation"),
                    "archive_inscription": bool(r.get("archive_inscription")) if r.get("archive_inscription") is not None else None,
                    "archive_action": bool(r.get("archive_action")) if r.get("archive_action") is not None else None,
                }
            )

        return {"id_collaborateur": cid, "items": items}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/historique/formations-jmb error: {e}")

@router.get("/studio/collaborateurs/acces/{id_owner}/{id_collaborateur}")
def studio_collab_acces(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                data = _build_access_state_for_collaborator(cur, oid, src["source_kind"], cid)

        return data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/acces detail error: {e}")
    
@router.post("/studio/collaborateurs/acces/{id_owner}/{id_collaborateur}")
def studio_collab_save_acces(id_owner: str, id_collaborateur: str, payload: CollaborateurAccessPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        role_map = {
            "studio": _normalize_access_role_code(getattr(payload, "studio", None)),
            "insights": _normalize_access_role_code(getattr(payload, "insights", None)),
            "people": _normalize_access_role_code(getattr(payload, "people", None)),
            "partner": _normalize_access_role_code(getattr(payload, "partner", None)),
            "learn": _normalize_access_role_code(getattr(payload, "learn", None)),
        }

        oid = ""
        ident = {}
        before_state = {}
        after_state = {}
        before_map = {}
        after_map = {}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                before_state = _build_access_state_for_collaborator(cur, oid, src["source_kind"], cid)
                before_map = _build_active_access_map(before_state)

                ident = _fetch_collaborateur_identity_for_access(cur, oid, src["source_kind"], cid)
                contracts = _load_owner_console_contracts(cur, oid)
                usage_map = _count_owner_access_usage(cur, oid)
                email = (ident.get("email") or "").strip()

                for console in ["studio", "insights", "people", "partner", "learn"]:
                    desired_role = role_map[console]
                    already_has_access = console in before_map

                    if desired_role != "none" and not contracts.get(console, False):
                        raise HTTPException(status_code=400, detail=f"La console {console} n'est pas active pour cet owner.")

                    if desired_role != "none" and not email:
                        raise HTTPException(status_code=400, detail="Email collaborateur manquant pour ouvrir un accès console.")

                    quota_max = int(((contracts.get("quotas") or {}).get(console) or 0))
                    quota_unlimited = bool((contracts.get("unlimited") or {}).get(console))
                    used_count = int((usage_map or {}).get(console) or 0)

                    if desired_role != "none" and not already_has_access and not quota_unlimited:
                        if quota_max <= 0 or used_count >= quota_max:
                            raise HTTPException(
                                status_code=400,
                                detail=f"Quota atteint pour {console}. Aucune licence supplémentaire disponible."
                            )

                    user_ref_type = _default_access_ref_type(console, src["source_kind"], ident["source_row_kind"])

                    cur.execute(
                        """
                        SELECT id_access
                        FROM public.tbl_novoskill_user_access
                        WHERE id_owner = %s
                          AND id_user_ref = %s
                          AND console_code = %s
                        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id_access DESC
                        LIMIT 1
                        """,
                        (oid, cid, console),
                    )
                    row = cur.fetchone() or {}
                    id_access = (row.get("id_access") or "").strip()

                    if desired_role == "none":
                        if id_access:
                            cur.execute(
                                """
                                UPDATE public.tbl_novoskill_user_access
                                SET archive = TRUE,
                                    statut_access = 'suspendu',
                                    updated_at = NOW()
                                WHERE id_access = %s
                                """,
                                (id_access,),
                            )
                        continue

                    if id_access:
                        cur.execute(
                            """
                            UPDATE public.tbl_novoskill_user_access
                            SET email = %s,
                                role_code = %s,
                                archive = FALSE,
                                user_ref_type = %s,
                                id_user_ref = %s,
                                console_code = %s,
                                statut_access = 'actif',
                                updated_at = NOW()
                            WHERE id_access = %s
                            """,
                            (email, desired_role, user_ref_type, cid, console, id_access),
                        )
                    else:
                        cur.execute(
                            """
                            INSERT INTO public.tbl_novoskill_user_access (
                              id_access,
                              email,
                              id_owner,
                              role_code,
                              archive,
                              created_at,
                              user_ref_type,
                              id_user_ref,
                              console_code,
                              updated_at,
                              statut_access
                            ) VALUES (
                              %s, %s, %s, %s, FALSE, NOW(), %s, %s, %s, NOW(), 'actif'
                            )
                            """,
                            (str(uuid.uuid4()), email, oid, desired_role, user_ref_type, cid, console),
                        )

                after_state = _build_access_state_for_collaborator(cur, oid, src["source_kind"], cid)
                after_map = _build_active_access_map(after_state)

                conn.commit()

        provisioning = {"auth_user": None, "created_now": False, "setup_link": None}
        if before_map or after_map:
            provisioning = _sync_supabase_auth_user_from_access_state(
                id_owner=oid,
                id_effectif=cid,
                email=ident.get("email"),
                after_access_state=after_state,
            )

        after_state["notification_mode"] = None
        after_state["notification_sent"] = False
        after_state["auth_user_created"] = bool(provisioning.get("created_now"))
        return after_state

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/acces save error: {e}")
    
@router.post("/studio/collaborateurs/acces/send/{id_owner}/{id_collaborateur}")
def studio_collab_send_access_mail(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                result = _send_access_mail_for_collaborateur(cur, u, oid, src["source_kind"], cid)

        if result.get("ok"):
            return result

        reason = (result.get("reason") or "").strip().lower()
        detail = result.get("detail") or "Échec de l'envoi."

        if reason in ("missing_email", "no_access", "missing_id"):
            raise HTTPException(status_code=400, detail=detail)

        raise HTTPException(status_code=500, detail=detail)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/acces/send error: {e}")


@router.post("/studio/collaborateurs/acces-bulk/send/{id_owner}")
def studio_collab_send_access_mail_bulk(id_owner: str, payload: CollaborateurAccessBulkSendPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        ids = []
        for raw in (payload.ids_collaborateurs or []):
            cid = str(raw or "").strip()
            if cid and cid not in ids:
                ids.append(cid)

        if not ids:
            raise HTTPException(status_code=400, detail="Aucun collaborateur sélectionné.")

        results = []
        sent_count = 0
        skipped_count = 0
        error_count = 0

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                for cid in ids:
                    try:
                        result = _send_access_mail_for_collaborateur(cur, u, oid, src["source_kind"], cid)
                        if result.get("ok"):
                            sent_count += 1
                        else:
                            reason = (result.get("reason") or "").strip().lower()
                            if reason in ("missing_email", "no_access", "missing_id"):
                                skipped_count += 1
                            else:
                                error_count += 1
                        results.append(result)
                    except Exception as e:
                        error_count += 1
                        results.append(
                            {
                                "ok": False,
                                "reason": "send_failed",
                                "detail": str(e),
                                "id_collaborateur": cid,
                            }
                        )

        return {
            "ok": True,
            "sent_count": sent_count,
            "skipped_count": skipped_count,
            "error_count": error_count,
            "results": results,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/acces/send-bulk error: {e}")

@router.get("/studio/collaborateurs/referentiels/codes-postaux/{id_owner}")
def studio_collab_postal_codes(id_owner: str, request: Request, code_postal: Optional[str] = None, ville: Optional[str] = None, limit: int = 20):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                cp = "".join(ch for ch in str(code_postal or "").strip() if ch.isdigit())[:5]
                city = _norm_text(ville)
                city = city.upper() if city else None

                try:
                    limit_val = int(limit or 20)
                except Exception:
                    limit_val = 20

                limit_val = max(1, min(limit_val, 50))

                if not cp and not city:
                    return {"items": []}

                if city and not cp and len(city) < 2:
                    return {"items": []}

                sql = """
                    SELECT DISTINCT
                        TRIM(code_postal) AS code_postal,
                        UPPER(TRIM(ville)) AS ville,
                        TRIM(code_insee) AS code_insee
                    FROM public.tbl_code_postal
                    WHERE COALESCE(TRIM(code_postal), '') <> ''
                      AND COALESCE(TRIM(ville), '') <> ''
                """
                params = []

                if cp and city:
                    sql += """
                      AND TRIM(code_postal) = %s
                      AND UPPER(TRIM(ville)) = %s
                    """
                    params.extend([cp, city])
                elif cp:
                    sql += " AND TRIM(code_postal) LIKE %s"
                    params.append(f"{cp}%")
                else:
                    sql += " AND UPPER(TRIM(ville)) LIKE %s"
                    params.append(f"{city}%")

                sql += """
                    ORDER BY code_postal, ville
                    LIMIT %s
                """
                params.append(limit_val)

                cur.execute(sql, tuple(params))
                rows = cur.fetchall() or []

                items = []
                for r in rows:
                    items.append(
                        {
                            "code_postal": (r.get("code_postal") or "").strip(),
                            "ville": (r.get("ville") or "").strip().upper(),
                            "code_insee": (r.get("code_insee") or "").strip(),
                        }
                    )

                return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/referentiels/codes-postaux error: {e}")

# ------------------------------------------------------
# Create
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}")
def studio_collab_create(id_owner: str, payload: CollaborateurPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        prenom = _norm_text(payload.prenom)
        nom = _norm_text(payload.nom)
        if not prenom or not nom:
            raise HTTPException(status_code=400, detail="Prénom et nom obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cid = str(uuid.uuid4())
                    date_naissance = _norm_iso_date(payload.date_naissance)
                    date_entree = _norm_iso_date(payload.date_entree_entreprise)
                    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                    date_sortie = _norm_iso_date(payload.date_sortie_prevue)
                    id_poste = _norm_text(payload.id_poste_actuel)
                    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

                    cur.execute(
                        """
                        INSERT INTO public.tbl_effectif_client (
                          id_effectif,
                          id_ent,
                          nom_effectif,
                          prenom_effectif,
                          civilite_effectif,
                          email_effectif,
                          telephone_effectif,
                          telephone2_effectif,
                          adresse_effectif,
                          code_postal_effectif,
                          ville_effectif,
                          pays_effectif,
                          date_naissance_effectif,
                          niveau_education,
                          domaine_education,
                          id_poste_actuel,
                          type_contrat,
                          matricule_interne,
                          id_service,
                          business_travel,
                          date_entree_entreprise_effectif,
                          date_sortie_prevue,
                          statut_actif,
                          motif_sortie,
                          note_commentaire,
                          archive,
                          date_creation,
                          dernier_update,
                          havedatefin,
                          ismanager,
                          date_debut_poste_actuel,
                          isformateur,
                          is_temp,
                          role_temp,
                          code_effectif
                        ) VALUES (
                          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s, %s, %s, FALSE, CURRENT_DATE, NOW(), %s, %s,
                          %s, %s, %s, %s, %s
                        )
                        """,
                        (
                          cid,
                          oid,
                          nom,
                          prenom,
                          _norm_text(payload.civilite),
                          _norm_text(payload.email),
                          _norm_text(payload.telephone),
                          _norm_text(payload.telephone2),
                          _norm_text(payload.adresse),
                          _norm_text(payload.code_postal),
                          _norm_text(payload.ville),
                          _norm_text(payload.pays),
                          date_naissance,
                          _norm_text(payload.niveau_education),
                          _norm_text(payload.domaine_education),
                          id_poste,
                          _norm_text(payload.type_contrat),
                          _norm_text(payload.matricule_interne),
                          id_service,
                          _norm_text(payload.business_travel),
                          date_entree,
                          date_sortie,
                          _norm_bool(payload.actif, True),
                          _norm_text(payload.motif_sortie),
                          _norm_text(payload.note_commentaire),
                          _norm_bool(payload.havedatefin, bool(date_sortie)),
                          _norm_bool(payload.ismanager, False),
                          date_debut_poste,
                          _norm_bool(payload.isformateur, False),
                          _norm_bool(payload.is_temp, False),
                          _norm_text(payload.role_temp),
                          _norm_text(payload.code_effectif),
                        ),
                    )
                    conn.commit()
                    return {"ok": True, "id_collaborateur": cid}

                cid = str(uuid.uuid4())
                user_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
                if user_poste:
                    _fetch_poste_service(cur, oid, user_poste)

                cur.execute(
                    """
                    INSERT INTO public.tbl_utilisateur (
                      id_utilisateur,
                      ut_prenom,
                      ut_nom,
                      ut_mail,
                      ut_tel,
                      ut_tel2,
                      actif,
                      archive,
                      ut_civilite,
                      ut_fonction,
                      ut_adresse,
                      ut_cp,
                      ut_ville,
                      ut_pays,
                      date_creation,
                      dernier_update,
                      ut_obs
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s, FALSE, %s, %s, %s, %s, %s, %s, CURRENT_DATE, NOW(), %s
                    )
                    """,
                    (
                      cid,
                      prenom,
                      nom,
                      _norm_text(payload.email),
                      _norm_text(payload.telephone),
                      _norm_text(payload.telephone2),
                      _norm_bool(payload.actif, True),
                      _norm_text(payload.civilite),
                      user_poste,
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                    ),
                )
                _upsert_effectif_mirror_for_utilisateur(cur, oid, cid, payload)
                conn.commit()
                return {"ok": True, "id_collaborateur": cid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/create error: {e}")


# ------------------------------------------------------
# Update
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}/{id_collaborateur}")
def studio_collab_update(id_owner: str, id_collaborateur: str, payload: CollaborateurPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        prenom = _norm_text(payload.prenom)
        nom = _norm_text(payload.nom)
        if not prenom or not nom:
            raise HTTPException(status_code=400, detail="Prénom et nom obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        LIMIT 1
                        """,
                        (oid, cid),
                    )
                    if not cur.fetchone():
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                    date_naissance = _norm_iso_date(payload.date_naissance)
                    date_entree = _norm_iso_date(payload.date_entree_entreprise)
                    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                    date_sortie = _norm_iso_date(payload.date_sortie_prevue)
                    id_poste = _norm_text(payload.id_poste_actuel)
                    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client
                        SET
                          nom_effectif = %s,
                          prenom_effectif = %s,
                          civilite_effectif = %s,
                          email_effectif = %s,
                          telephone_effectif = %s,
                          telephone2_effectif = %s,
                          adresse_effectif = %s,
                          code_postal_effectif = %s,
                          ville_effectif = %s,
                          pays_effectif = %s,
                          date_naissance_effectif = %s,
                          niveau_education = %s,
                          domaine_education = %s,
                          id_poste_actuel = %s,
                          type_contrat = %s,
                          matricule_interne = %s,
                          id_service = %s,
                          business_travel = %s,
                          date_entree_entreprise_effectif = %s,
                          date_sortie_prevue = %s,
                          statut_actif = %s,
                          motif_sortie = %s,
                          note_commentaire = %s,
                          havedatefin = %s,
                          ismanager = %s,
                          date_debut_poste_actuel = %s,
                          isformateur = %s,
                          is_temp = %s,
                          role_temp = %s,
                          code_effectif = %s,
                          dernier_update = NOW()
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        """,
                        (
                          nom,
                          prenom,
                          _norm_text(payload.civilite),
                          _norm_text(payload.email),
                          _norm_text(payload.telephone),
                          _norm_text(payload.telephone2),
                          _norm_text(payload.adresse),
                          _norm_text(payload.code_postal),
                          _norm_text(payload.ville),
                          _norm_text(payload.pays),
                          date_naissance,
                          _norm_text(payload.niveau_education),
                          _norm_text(payload.domaine_education),
                          id_poste,
                          _norm_text(payload.type_contrat),
                          _norm_text(payload.matricule_interne),
                          id_service,
                          _norm_text(payload.business_travel),
                          date_entree,
                          date_sortie,
                          _norm_bool(payload.actif, True),
                          _norm_text(payload.motif_sortie),
                          _norm_text(payload.note_commentaire),
                          _norm_bool(payload.havedatefin, bool(date_sortie)),
                          _norm_bool(payload.ismanager, False),
                          date_debut_poste,
                          _norm_bool(payload.isformateur, False),
                          _norm_bool(payload.is_temp, False),
                          _norm_text(payload.role_temp),
                          _norm_text(payload.code_effectif),
                          oid,
                          cid,
                        ),
                    )
                    conn.commit()
                    return {"ok": True, "id_collaborateur": cid}

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_utilisateur
                    WHERE id_utilisateur = %s
                    LIMIT 1
                    """,
                    (cid,),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                user_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
                if user_poste:
                    _fetch_poste_service(cur, oid, user_poste)

                cur.execute(
                    """
                    UPDATE public.tbl_utilisateur
                    SET
                      ut_prenom = %s,
                      ut_nom = %s,
                      ut_mail = %s,
                      ut_tel = %s,
                      ut_tel2 = %s,
                      actif = %s,
                      ut_civilite = %s,
                      ut_fonction = %s,
                      ut_adresse = %s,
                      ut_cp = %s,
                      ut_ville = %s,
                      ut_pays = %s,
                      ut_obs = %s,
                      dernier_update = NOW()
                    WHERE id_utilisateur = %s
                    """,
                    (
                      prenom,
                      nom,
                      _norm_text(payload.email),
                      _norm_text(payload.telephone),
                      _norm_text(payload.telephone2),
                      _norm_bool(payload.actif, True),
                      _norm_text(payload.civilite),
                      user_poste,
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                      cid,
                    ),
                )
                _upsert_effectif_mirror_for_utilisateur(cur, oid, cid, payload)
                conn.commit()
                return {"ok": True, "id_collaborateur": cid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/update error: {e}")


# ------------------------------------------------------
# Archive
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}/{id_collaborateur}/archive")
def studio_collab_archive(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client
                        SET archive = TRUE,
                            dernier_update = NOW()
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        """,
                        (oid, cid),
                    )
                    if cur.rowcount <= 0:
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
                    conn.commit()
                    return {"ok": True}

                cur.execute(
                    """
                    UPDATE public.tbl_utilisateur
                    SET archive = TRUE,
                        dernier_update = NOW()
                    WHERE id_utilisateur = %s
                    """,
                    (cid,),
                )
                if cur.rowcount <= 0:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client
                    SET archive = TRUE,
                        dernier_update = NOW()
                    WHERE id_ent = %s
                      AND id_effectif = %s
                    """,
                    (oid, cid),
                )
                conn.commit()
                return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/archive error: {e}")