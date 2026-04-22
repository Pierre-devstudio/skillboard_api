from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Response
from pydantic import BaseModel
from typing import Optional, List, Any
from psycopg.rows import dict_row
import os
import secrets
import uuid
import requests
import json
import re
from datetime import date as py_date, timedelta
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle

from app.routers.MailManager import send_novoskill_access_mail
from app.routers.skills_portal_common import get_conn
from app.routers.skills_portal_pdf_common import (
    PDF_BRAND_RED,
    PDF_LINE,
    PDF_MARGIN_LEFT,
    PDF_MARGIN_RIGHT,
    PDF_MUTED,
    PDF_TEXT,
    build_pdf_document,
    build_pdf_styles,
)
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

CERTIFICATION_STATE_LABELS = {
    "a_obtenir": "À obtenir",
    "en_cours": "En cours",
    "acquise": "Acquise",
    "a_renouveler": "À renouveler",
    "expiree": "Expirée",
}

CERTIFICATION_ALLOWED_PROOF_MIME = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
}

CERTIFICATION_PROOF_MAX_BYTES = 5 * 1024 * 1024


def _normalize_collab_certification_state(value: Optional[str], default: str = "a_obtenir") -> str:
    raw = (value or "").strip().lower()
    raw = (
        raw.replace("é", "e")
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

    mapping = {
        "a_obtenir": "a_obtenir",
        "a obtenir": "a_obtenir",
        "non acquis": "a_obtenir",
        "non_acquis": "a_obtenir",
        "en_cours": "en_cours",
        "en cours": "en_cours",
        "acquise": "acquise",
        "acquis": "acquise",
        "valide": "acquise",
        "validee": "acquise",
        "a_renouveler": "a_renouveler",
        "a renouveler": "a_renouveler",
        "expiree": "expiree",
        "expire": "expiree",
    }

    out = mapping.get(raw)
    if out:
        return out

    if default:
        return default

    raise HTTPException(status_code=400, detail="État certification invalide.")


def _collab_certification_state_label(code: Optional[str]) -> str:
    return CERTIFICATION_STATE_LABELS.get(
        _normalize_collab_certification_state(code, default="a_obtenir"),
        "À obtenir",
    )


def _default_collab_certification_state(date_obtention: Optional[py_date]) -> str:
    return "acquise" if date_obtention else "a_obtenir"


def _collab_certification_expiration_effective(
    date_obtention: Optional[py_date],
    date_expiration: Optional[py_date],
    validite_attendue,
) -> Optional[py_date]:
    if date_expiration:
        return date_expiration

    if not date_obtention:
        return None

    if validite_attendue is None:
        return None

    try:
        months = int(validite_attendue)
    except Exception:
        return None

    if months <= 0:
        return None

    return _add_years_months(date_obtention, months=months)


def _effective_collab_certification_state(
    raw_etat: Optional[str],
    date_obtention: Optional[py_date],
    date_expiration_effective: Optional[py_date],
    delai_renouvellement,
) -> str:
    raw = (raw_etat or "").strip()
    if raw:
        return _normalize_collab_certification_state(raw, default="a_obtenir")

    if not date_obtention:
        return "a_obtenir"

    if date_expiration_effective:
        if date_expiration_effective < py_date.today():
            return "expiree"

        try:
            delay_days = int(delai_renouvellement or 60)
        except Exception:
            delay_days = 60

        if date_expiration_effective <= (py_date.today() + timedelta(days=delay_days)):
            return "a_renouveler"

    return "acquise"


def _normalize_certification_proof_content_type(filename: str, content_type: Optional[str]) -> str:
    ct = (content_type or "").strip().lower()
    if ct in CERTIFICATION_ALLOWED_PROOF_MIME:
        return ct

    ext = os.path.splitext(filename or "")[1].strip().lower()
    mapping = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }
    return mapping.get(ext, "")


def _get_collab_certification_row(cur, id_effectif: str, id_effectif_certification: str) -> dict:
    cur.execute(
        """
        SELECT
          ecc.id_effectif_certification,
          ecc.id_effectif,
          ecc.id_certification,
          ecc.id_preuve_doc,
          COALESCE(NULLIF(BTRIM(COALESCE(ecc.etat, '')), ''), '') AS etat,
          c.nom_certification
        FROM public.tbl_effectif_client_certification ecc
        JOIN public.tbl_certification c
          ON c.id_certification = ecc.id_certification
         AND COALESCE(c.masque, FALSE) = FALSE
        WHERE ecc.id_effectif = %s
          AND ecc.id_effectif_certification = %s
          AND COALESCE(ecc.archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_effectif, id_effectif_certification),
    )
    row = cur.fetchone() or {}
    if not row:
        raise HTTPException(status_code=404, detail="Certification collaborateur introuvable.")
    return row


def _archive_collab_certification_proof(cur, id_preuve_doc: Optional[str]) -> None:
    pid = (id_preuve_doc or "").strip()
    if not pid:
        return

    cur.execute(
        """
        UPDATE public.tbl_effectif_client_certification_doc
        SET archive = TRUE,
            date_maj = NOW()
        WHERE id_preuve_doc = %s
        """,
        (pid,),
    )

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


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        is_leap = (year % 4 == 0) and ((year % 100 != 0) or (year % 400 == 0))
        return 29 if is_leap else 28
    if month in (1, 3, 5, 7, 8, 10, 12):
        return 31
    return 30


def _add_years_months(base_date, years: int = 0, months: int = 0):
    total_month = (base_date.month - 1) + int(months)
    year = base_date.year + int(years) + (total_month // 12)
    month = (total_month % 12) + 1
    day = min(base_date.day, _days_in_month(year, month))
    return base_date.__class__(year, month, day)


def _retirement_rule_from_birth_date(date_naissance) -> dict:
    """
    Règle de calcul 2026 - approximation volontaire pour Novoskill.

    Base métier retenue :
    - âge légal progressif selon la génération,
    - durée d’assurance requise (en trimestres) selon la génération,
    - borne max à 67 ans pour le taux plein automatique.

    Cette table devra être revue si la réglementation évolue à nouveau.
    Source métier utilisée au moment du développement :
    règles officielles France 2026 (Info Retraite / Service-Public).
    """
    ymd = (date_naissance.year, date_naissance.month, date_naissance.day)

    if ymd < (1958, 1, 1):
        return {"age_years": 62, "age_months": 0, "required_trimesters": 166}

    if ymd <= (1960, 12, 31):
        return {"age_years": 62, "age_months": 0, "required_trimesters": 167}

    if ymd <= (1961, 8, 31):
        return {"age_years": 62, "age_months": 0, "required_trimesters": 168}

    if ymd <= (1961, 12, 31):
        return {"age_years": 62, "age_months": 3, "required_trimesters": 169}

    if ymd <= (1962, 12, 31):
        return {"age_years": 62, "age_months": 6, "required_trimesters": 169}

    if ymd <= (1965, 3, 31):
        return {"age_years": 62, "age_months": 9, "required_trimesters": 170}

    if ymd <= (1965, 12, 31):
        return {"age_years": 63, "age_months": 0, "required_trimesters": 171}

    if ymd <= (1966, 12, 31):
        return {"age_years": 63, "age_months": 3, "required_trimesters": 172}

    if ymd <= (1967, 12, 31):
        return {"age_years": 63, "age_months": 6, "required_trimesters": 172}

    if ymd <= (1968, 12, 31):
        return {"age_years": 63, "age_months": 9, "required_trimesters": 172}

    return {"age_years": 64, "age_months": 0, "required_trimesters": 172}


def _estimated_work_start_age_from_education(niveau_education: Optional[str]) -> int:
    """
    Approximation Novoskill :
    on déduit un âge probable d’entrée dans la vie active à partir
    du niveau d’études déclaré.

    Cette règle n’est PAS une simulation retraite officielle.
    Elle sert uniquement à alimenter le champ "retraite_estimee"
    de façon cohérente pour les analyses Insights.

    Mapping retenu :
    - niveaux 0 / 3 / 4 : 18 ans
    - niveau 5 : 20 ans
    - niveau 6 : 21 ans
    - niveau 7 : 23 ans
    - niveau 8 : 26 ans
    - défaut : 18 ans
    """
    raw = _norm_text(niveau_education) or ""
    m = re.search(r"(\d+)", raw)
    if not m:
        return 18

    level = int(m.group(1))
    if level >= 8:
        return 26
    if level == 7:
        return 23
    if level == 6:
        return 21
    if level == 5:
        return 20
    return 18


def _compute_retraite_estimee(date_naissance, niveau_education: Optional[str]) -> Optional[int]:
    """
    Calcule une année estimée de départ en retraite.

    Logique retenue :
    1. on calcule la date d’atteinte de l’âge légal,
    2. on calcule une date théorique d’atteinte de la durée d’assurance requise,
       à partir d’un âge d’entrée dans la vie active approximé par le niveau d’études,
    3. on retient la date la plus tardive des deux,
    4. on borne à 67 ans maximum (taux plein automatique).

    Le champ stocké étant un INT4 "année", on ne conserve que l’année.
    """
    if not date_naissance:
        return None

    rule = _retirement_rule_from_birth_date(date_naissance)

    legal_date = _add_years_months(
        date_naissance,
        years=rule["age_years"],
        months=rule["age_months"],
    )

    auto_full_rate_date = _add_years_months(date_naissance, years=67, months=0)

    work_start_age = _estimated_work_start_age_from_education(niveau_education)
    work_start_date = _add_years_months(date_naissance, years=work_start_age, months=0)

    quarters_date = _add_years_months(
        work_start_date,
        years=0,
        months=rule["required_trimesters"] * 3,
    )

    estimated_date = quarters_date if quarters_date > legal_date else legal_date
    if estimated_date > auto_full_rate_date:
        estimated_date = auto_full_rate_date

    return int(estimated_date.year)

def _upsert_effectif_mirror_for_utilisateur(cur, oid: str, cid: str, payload) -> None:
    id_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

    date_naissance = _norm_iso_date(payload.date_naissance)
    date_entree = _norm_iso_date(payload.date_entree_entreprise)
    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
    date_sortie = _norm_iso_date(payload.date_sortie_prevue)

    # Calcul approximatif de l’année de retraite estimée.
    # Voir les helpers ci-dessus pour la règle détaillée et les hypothèses retenues.
    retraite_estimee = _compute_retraite_estimee(
        date_naissance,
        _norm_text(payload.niveau_education),
    )

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
        retraite_estimee,
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
              retraite_estimee = %s,
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
          retraite_estimee,
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
          %s, %s, %s, %s, %s, %s, FALSE, CURRENT_DATE, NOW(), %s, %s,
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
    niveau_actuel: Optional[str] = None

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

class CollaborateurCertificationPayload(BaseModel):
    id_certification: Optional[str] = None
    etat: Optional[str] = None
    date_obtention: Optional[str] = None
    date_expiration: Optional[str] = None
    organisme: Optional[str] = None
    reference: Optional[str] = None
    commentaire: Optional[str] = None

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

    if s in ("c", "expert") or s.startswith("exp"):
        return "Expert"

    if s in ("b", "avance", "advanced") or s.startswith("ava") or s.startswith("adv"):
        return "Avancé"

    if s in ("a", "initial") or s.startswith("ini"):
        return "Initial"

    return "Initial"


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

def _insert_effectif_competence_row_without_eval(
    cur,
    id_effectif_client: str,
    id_comp: str,
    niveau_actuel: Optional[str] = None,
) -> str:
    cols = _get_effectif_competence_columns(cur)

    required = ("id_effectif_competence", "id_effectif_client", "id_comp", "id_dernier_audit")
    missing = [c for c in required if c not in cols]
    if missing:
        raise HTTPException(
            status_code=500,
            detail="tbl_effectif_client_competence incomplète : " + ", ".join(missing),
        )

    niveau_norm = _normalize_skill_level_from_poste(niveau_actuel) if _norm_text(niveau_actuel) else None

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
        add_value("niveau_actuel", niveau_norm)

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

def _upsert_effectif_competence_without_audit(
    cur,
    id_effectif_client: str,
    id_comp: str,
    niveau_actuel: Optional[str] = None,
) -> dict:
    cols = _get_effectif_competence_columns(cur)
    niveau_norm = _normalize_skill_level_from_poste(niveau_actuel) if _norm_text(niveau_actuel) else None

    archive_expr = "COALESCE(ecc.archive, FALSE)" if "archive" in cols else "FALSE"
    actif_expr = "COALESCE(ecc.actif, TRUE)" if "actif" in cols else "TRUE"
    order_expr = "COALESCE(ecc.dernier_update, NOW()) DESC" if "dernier_update" in cols else "ecc.id_effectif_competence DESC"

    cur.execute(
        f"""
        SELECT
          ecc.id_effectif_competence,
          {archive_expr} AS archive_row,
          {actif_expr} AS actif_row,
          COALESCE(ecc.niveau_actuel, '') AS niveau_actuel_row
        FROM public.tbl_effectif_client_competence ecc
        WHERE ecc.id_effectif_client = %s
          AND ecc.id_comp = %s
        ORDER BY
          {archive_expr} ASC,
          {actif_expr} DESC,
          {order_expr}
        LIMIT 1
        """,
        (id_effectif_client, id_comp),
    )
    existing = cur.fetchone() or {}

    existing_id = (existing.get("id_effectif_competence") or "").strip()
    if existing_id and not bool(existing.get("archive_row")) and bool(existing.get("actif_row")):
        return {
            "id_effectif_competence": existing_id,
            "action": "existing",
            "already_exists": True,
            "niveau_actuel": (existing.get("niveau_actuel_row") or "").strip() or niveau_norm,
        }

    if existing_id:
        set_parts = []
        params = []

        if "niveau_actuel" in cols:
            set_parts.append("niveau_actuel = %s")
            params.append(niveau_norm)

        if "id_dernier_audit" in cols:
            set_parts.append("id_dernier_audit = %s")
            params.append(None)

        if "actif" in cols:
            set_parts.append("actif = TRUE")

        if "archive" in cols:
            set_parts.append("archive = FALSE")

        if "date_derniere_eval" in cols:
            set_parts.append("date_derniere_eval = %s")
            params.append(None)

        if "dernier_update" in cols:
            set_parts.append("dernier_update = NOW()")

        params.append(existing_id)

        cur.execute(
            f"""
            UPDATE public.tbl_effectif_client_competence
            SET {", ".join(set_parts)}
            WHERE id_effectif_competence = %s
            """,
            tuple(params),
        )

        return {
            "id_effectif_competence": existing_id,
            "action": "reactivated",
            "already_exists": False,
            "niveau_actuel": niveau_norm,
        }

    row_id = _insert_effectif_competence_row_without_eval(
        cur,
        id_effectif_client,
        id_comp,
        niveau_norm,
    )
    return {
        "id_effectif_competence": row_id,
        "action": "inserted",
        "already_exists": False,
        "niveau_actuel": niveau_norm,
    }

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

def _pdf_esc(v: Any) -> str:
    return str(v or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _pdf_clean_text(v: Any) -> str:
    s = str(v or "").replace("\\x00", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _pdf_truncate(v: Any, max_len: int) -> str:
    s = _pdf_clean_text(v)
    if len(s) <= max_len:
        return s
    cut = s[:max_len].rsplit(" ", 1)[0].strip(" ,;:.-")
    return (cut or s[:max_len]).strip() + "…"


def _pdf_latin1_safe(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return ""

    replacements = {
        "–": "-",
        "—": "-",
        "•": "-",
        "\u00a0": " ",
        "‘": "'",
        "’": "'",
        "“": '"',
        "”": '"',
    }
    for src, dst in replacements.items():
        s = s.replace(src, dst)

    try:
        s.encode("latin-1")
        return s
    except Exception:
        return s.encode("latin-1", errors="ignore").decode("latin-1").strip()


def _pdf_safe_filename_part(v: Any, max_len: int = 120) -> str:
    s = str(v or "").strip()
    s = re.sub(r'[\\/:*?"<>|]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ._-")
    if not s:
        return "Competence"
    if len(s) > max_len:
        s = s[:max_len].rsplit(" ", 1)[0].strip()
    return s or "Competence"


def _fetch_owner_logo_bytes(cur, oid: str) -> Optional[bytes]:
    owner_id = (oid or "").strip()
    if not owner_id:
        return None

    cur.execute(
        """
        SELECT logo_bytes
        FROM public.tbl_studio_owner_logo
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY date_maj DESC, date_creation DESC
        LIMIT 1
        """,
        (owner_id,),
    )
    row = cur.fetchone() or {}
    raw = row.get("logo_bytes")
    if raw is None:
        return None
    try:
        return bytes(raw)
    except Exception:
        return raw


def _pdf_eval_coef_text(nb_criteres: int) -> str:
    try:
        nb = int(nb_criteres or 0)
    except Exception:
        nb = 0

    if nb <= 1:
        return "6"
    if nb == 2:
        return "3"
    if nb == 3:
        return "2"
    return "1,5"


def _pdf_level_note_range(level_code: str) -> str:
    code = str(level_code or "").strip().upper()
    if code == "A":
        return "Maîtrise < 41 %"
    if code == "B":
        return "Maîtrise entre 41 % et 75 %"
    if code == "C":
        return "Maîtrise > 75 %"
    return "Maîtrise -"


def _build_competence_pdf_story(comp: dict) -> List:
    styles = build_pdf_styles()
    content_width = 210 * mm - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT

    title_style = ParagraphStyle(
        "NsPdfCompTitle",
        parent=styles["title"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=16,
        leading=18,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    code_style = ParagraphStyle(
        "NsPdfCompCode",
        parent=styles["body"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=10.5,
        leading=12,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    skill_title_style = ParagraphStyle(
        "NsPdfCompSkillTitle",
        parent=styles["section"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=12.2,
        leading=14.4,
        textColor=PDF_BRAND_RED,
        spaceAfter=0,
    )
    desc_style = ParagraphStyle(
        "NsPdfCompDesc",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=9,
        leading=11.5,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    domain_style = ParagraphStyle(
        "NsPdfCompDomain",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=9,
        leading=11.5,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    section_style = ParagraphStyle(
        "NsPdfCompSection",
        parent=styles["section"],
        fontName="Helvetica-Bold",
        fontSize=11.2,
        leading=13,
        textColor=PDF_BRAND_RED,
        spaceAfter=0,
    )
    table_head_style = ParagraphStyle(
        "NsPdfCompTableHead",
        parent=styles["small"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=7.8,
        leading=9,
        textColor=colors.white,
        spaceAfter=0,
    )
    crit_name_style = ParagraphStyle(
        "NsPdfCompCritName",
        parent=styles["body"],
        fontName="Helvetica-Bold",
        fontSize=7.8,
        leading=9.1,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    crit_cell_style = ParagraphStyle(
        "NsPdfCompCritCell",
        parent=styles["body"],
        fontName="Helvetica",
        fontSize=7.2,
        leading=8.2,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    level_head_style = ParagraphStyle(
        "NsPdfCompLevelHead",
        parent=styles["body"],
        alignment=1,
        fontName="Helvetica-Bold",
        fontSize=8.8,
        leading=10.2,
        textColor=colors.white,
        spaceAfter=0,
    )
    level_note_style = ParagraphStyle(
        "NsPdfCompLevelNote",
        parent=styles["small"],
        alignment=1,
        fontName="Helvetica",
        fontSize=8,
        leading=9.2,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )
    level_body_style = ParagraphStyle(
        "NsPdfCompLevelBody",
        parent=styles["body"],
        alignment=1,
        fontName="Helvetica",
        fontSize=8.2,
        leading=9.8,
        textColor=PDF_TEXT,
        spaceAfter=0,
    )

    code = _pdf_clean_text(comp.get("code")) or "—"
    intitule = _pdf_clean_text(comp.get("intitule")) or "Compétence"
    description = _pdf_truncate(comp.get("description"), 420) or "—"
    domaine_titre = _pdf_clean_text(comp.get("domaine_titre") or comp.get("domaine")) or "—"

    grille = _json_like_to_obj(comp.get("grille_evaluation"))
    crit_rows = []

    for idx in range(1, 5):
        node = grille.get(f"Critere{idx}") if isinstance(grille, dict) else {}
        node = node if isinstance(node, dict) else {}

        nom = _pdf_truncate(node.get("Nom"), 90)
        evals = node.get("Eval") if isinstance(node.get("Eval"), list) else []
        evals = [
            Paragraph(
                _pdf_esc(_pdf_truncate(evals[i] if i < len(evals) else "", 130)),
                crit_cell_style,
            )
            for i in range(4)
        ]

        crit_rows.append([
            Paragraph(_pdf_esc(nom or ""), crit_name_style),
            *evals,
        ])

    level_rows = [
        [
            Paragraph("Initial", level_head_style),
            Paragraph("Avancé", level_head_style),
            Paragraph("Expert", level_head_style),
        ],
        [
            Paragraph(_pdf_level_note_range("A"), level_note_style),
            Paragraph(_pdf_level_note_range("B"), level_note_style),
            Paragraph(_pdf_level_note_range("C"), level_note_style),
        ],
        [
            Paragraph(_pdf_esc(_pdf_truncate(comp.get("niveaua"), 260) or "—"), level_body_style),
            Paragraph(_pdf_esc(_pdf_truncate(comp.get("niveaub"), 260) or "—"), level_body_style),
            Paragraph(_pdf_esc(_pdf_truncate(comp.get("niveauc"), 260) or "—"), level_body_style),
        ],
    ]

    crit_table = Table(
        [[
            Paragraph("", table_head_style),
            Paragraph("1", table_head_style),
            Paragraph("2", table_head_style),
            Paragraph("3", table_head_style),
            Paragraph("4", table_head_style),
        ]] + crit_rows,
        colWidths=[44 * mm, 36.5 * mm, 36.5 * mm, 36.5 * mm, 36.5 * mm],
        hAlign="LEFT",
    )
    crit_table.setStyle(TableStyle([
        ("BACKGROUND", (1, 0), (-1, 0), PDF_BRAND_RED),
        ("BACKGROUND", (0, 0), (0, 0), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, 0), 4),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, 1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 6),
    ]))

    level_table = Table(
        level_rows,
        colWidths=[content_width / 3.0, content_width / 3.0, content_width / 3.0],
        hAlign="LEFT",
    )
    level_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PDF_BRAND_RED),
        ("BOX", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.75, PDF_LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING", (0, 1), (-1, 1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 4),
        ("TOPPADDING", (0, 2), (-1, 2), 8),
        ("BOTTOMPADDING", (0, 2), (-1, 2), 8),
    ]))

    story: List = []
    story.append(Paragraph("Définition de la compétence", title_style))
    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph(_pdf_esc(code), code_style))
    story.append(Spacer(1, 1.5 * mm))
    story.append(Paragraph(_pdf_esc(intitule), skill_title_style))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(_pdf_esc(description), desc_style))
    story.append(Spacer(1, 6 * mm))
    story.append(
        Paragraph(
            f"Cette compétence est classée dans le domaine <b>{_pdf_esc(domaine_titre)}</b> de votre référentiel.",
            domain_style,
        )
    )
    story.append(Spacer(1, 7 * mm))

    story.append(KeepTogether([
        Paragraph("Critères d'évaluation", section_style),
        Spacer(1, 4 * mm),
        crit_table,
    ]))

    story.append(Spacer(1, 6 * mm))

    story.append(KeepTogether([
        Paragraph("Niveaux de maîtrise", section_style),
        Spacer(1, 4 * mm),
        level_table,
    ]))

    return story

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
                          e.retraite_estimee,
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
                        "retraite_estimee": r.get("retraite_estimee"),
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
                        "observations": r.get("observations"),
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
                      u.ut_adresse AS adresse,
                      u.ut_cp AS code_postal,
                      u.ut_ville AS ville,
                      u.ut_pays AS pays,
                      ec.date_naissance_effectif AS date_naissance,
                      ec.retraite_estimee,
                      ec.niveau_education,
                      ec.domaine_education,
                      COALESCE(ec.id_poste_actuel, u.ut_fonction) AS id_poste_actuel,
                      ec.type_contrat,
                      ec.matricule_interne,
                      ec.id_service,
                      ec.business_travel,
                      ec.date_entree_entreprise_effectif AS date_entree_entreprise,
                      ec.date_sortie_prevue,
                      COALESCE(u.actif, TRUE) AS actif,
                      ec.motif_sortie,
                      ec.note_commentaire,
                      COALESCE(u.archive, FALSE) AS archive,
                      COALESCE(ec.havedatefin, FALSE) AS havedatefin,
                      COALESCE(ec.ismanager, FALSE) AS ismanager,
                      ec.date_debut_poste_actuel,
                      ec.type_obtention,
                      COALESCE(ec.isformateur, FALSE) AS isformateur,
                      COALESCE(ec.is_temp, FALSE) AS is_temp,
                      ec.role_temp,
                      ec.code_effectif,
                      u.ut_obs AS observations,
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
                    "fonction": r.get("id_poste_actuel"),
                    "id_poste_actuel": r.get("id_poste_actuel"),
                    "id_service": r.get("id_service"),
                    "nom_service": r.get("nom_service"),
                    "poste_label": poste_label,
                    "adresse": r.get("adresse"),
                    "code_postal": r.get("code_postal"),
                    "ville": r.get("ville"),
                    "pays": r.get("pays"),
                    "date_naissance": r.get("date_naissance").isoformat() if r.get("date_naissance") else None,
                    "retraite_estimee": r.get("retraite_estimee"),
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

                id_poste = _norm_text(scope.get("id_poste_actuel"))
                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                ecc_cols = _get_effectif_competence_columns(cur)
                active_filter = "COALESCE(ecc.actif, TRUE) = TRUE" if "actif" in ecc_cols else "TRUE"
                archive_filter = "COALESCE(ecc.archive, FALSE) = FALSE" if "archive" in ecc_cols else "FALSE"

                owned_rows = []
                missing_rows = []

                if id_poste:
                    cur.execute(
                        f"""
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
                              AND COALESCE(fpc.masque, FALSE) = FALSE
                        )
                        SELECT
                            ecc.id_effectif_competence,
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.domaine,
                            (req.id_comp IS NOT NULL) AS is_required,
                            req.niveau_requis,
                            ecc.niveau_actuel,
                            ecc.date_derniere_eval,
                            ecc.id_dernier_audit,
                            req.poids_criticite,
                            req.freq_usage,
                            req.impact_resultat,
                            req.dependance
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN public.tbl_competence c
                          ON c.id_comp = ecc.id_comp
                        LEFT JOIN req
                          ON req.id_comp = c.id_comp
                        WHERE ecc.id_effectif_client = %s
                          AND {active_filter}
                          AND {archive_filter}
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                        ORDER BY
                          COALESCE(req.poids_criticite, 0) DESC,
                          lower(COALESCE(c.intitule, ''))
                        """,
                        (id_poste, id_effectif_data),
                    )
                    owned_rows = cur.fetchall() or []

                    cur.execute(
                        f"""
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
                              AND COALESCE(fpc.masque, FALSE) = FALSE
                        )
                        SELECT
                            NULL AS id_effectif_competence,
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.domaine,
                            TRUE AS is_required,
                            req.niveau_requis,
                            NULL AS niveau_actuel,
                            NULL AS date_derniere_eval,
                            NULL AS id_dernier_audit,
                            req.poids_criticite,
                            req.freq_usage,
                            req.impact_resultat,
                            req.dependance
                        FROM req
                        JOIN public.tbl_competence c
                          ON c.id_comp = req.id_comp
                         AND COALESCE(c.masque, FALSE) = FALSE
                         AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                        LEFT JOIN public.tbl_effectif_client_competence ecc
                          ON ecc.id_effectif_client = %s
                         AND ecc.id_comp = req.id_comp
                         AND {active_filter}
                         AND {archive_filter}
                        WHERE ecc.id_effectif_competence IS NULL
                        ORDER BY
                          COALESCE(req.poids_criticite, 0) DESC,
                          lower(COALESCE(c.intitule, ''))
                        """,
                        (id_poste, id_effectif_data),
                    )
                    missing_rows = cur.fetchall() or []
                else:
                    cur.execute(
                        f"""
                        SELECT
                            ecc.id_effectif_competence,
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.domaine,
                            FALSE AS is_required,
                            NULL AS niveau_requis,
                            ecc.niveau_actuel,
                            ecc.date_derniere_eval,
                            ecc.id_dernier_audit,
                            NULL AS poids_criticite,
                            NULL AS freq_usage,
                            NULL AS impact_resultat,
                            NULL AS dependance
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN public.tbl_competence c
                          ON c.id_comp = ecc.id_comp
                        WHERE ecc.id_effectif_client = %s
                          AND {active_filter}
                          AND {archive_filter}
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                        ORDER BY lower(COALESCE(c.intitule, ''))
                        """,
                        (id_effectif_data,),
                    )
                    owned_rows = cur.fetchall() or []

                domaine_ids = []
                seen = set()
                for rr in (owned_rows + missing_rows):
                    did = (rr.get("domaine") or "").strip()
                    if did and did not in seen:
                        seen.add(did)
                        domaine_ids.append(did)
                domaine_map = _load_domaine_competence_map(cur, domaine_ids)

        owned_items = []
        for r in owned_rows:
            dmeta = domaine_map.get((r.get("domaine") or "").strip(), {})
            owned_items.append(
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

        missing_required_items = []
        for r in missing_rows:
            dmeta = domaine_map.get((r.get("domaine") or "").strip(), {})
            missing_required_items.append(
                {
                    "id_effectif_competence": None,
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "domaine": r.get("domaine"),
                    "domaine_titre": dmeta.get("titre"),
                    "domaine_couleur": dmeta.get("couleur"),
                    "is_required": True,
                    "niveau_requis": r.get("niveau_requis"),
                    "niveau_actuel": None,
                    "date_derniere_eval": None,
                    "id_dernier_audit": None,
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
            "items": owned_items,
            "owned_items": owned_items,
            "missing_required_items": missing_required_items,
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
                     AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    WHERE fpc.id_poste = %s
                      AND COALESCE(fpc.masque, FALSE) = FALSE
                    ORDER BY COALESCE(fpc.poids_criticite, 0) DESC, c.intitule
                    """,
                    (id_poste,),
                )
                req_rows = cur.fetchall() or []

                inserted = 0
                skipped_existing = 0

                for r in req_rows:
                    id_comp = (r.get("id_comp") or "").strip()
                    if not id_comp:
                        continue

                    niveau = _normalize_skill_level_from_poste(r.get("niveau_requis"))
                    upsert_res = _upsert_effectif_competence_without_audit(
                        cur,
                        id_effectif_data,
                        id_comp,
                        niveau,
                    )

                    if upsert_res.get("already_exists"):
                        skipped_existing += 1
                    else:
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

                # Réutilisation stricte de la logique métier existante :
                # - si la compétence existe déjà active : on ne la recrée pas
                # - si elle existait archivée/inactive : on la réactive
                # - si un niveau est fourni (cas import depuis poste), il est appliqué
                # - aucune date de dernière évaluation n'est renseignée
                upsert_res = _upsert_effectif_competence_without_audit(
                    cur,
                    id_effectif_data,
                    id_comp,
                    payload.niveau_actuel,
                )

                conn.commit()

        return {
            "ok": True,
            "id_collaborateur": cid,
            "id_effectif_data": id_effectif_data,
            "id_comp": id_comp,
            "code": (comp.get("code") or "").strip(),
            "intitule": (comp.get("intitule") or "").strip(),
            "inserted": not bool(upsert_res.get("already_exists")),
            "already_exists": bool(upsert_res.get("already_exists")),
            "action": upsert_res.get("action"),
            "niveau_actuel": upsert_res.get("niveau_actuel"),
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

@router.get("/studio/collaborateurs/competences/fiche_pdf/{id_owner}/{id_collaborateur}/{id_comp}")
def studio_collab_competence_fiche_pdf(
    id_owner: str,
    id_collaborateur: str,
    id_comp: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        comp_id = (id_comp or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not comp_id:
            raise HTTPException(status_code=400, detail="id_comp manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                owner = studio_fetch_owner(cur, oid) or {}
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                id_effectif_data = (scope.get("id_effectif_data") or "").strip()
                if not id_effectif_data:
                    raise HTTPException(status_code=400, detail="Identifiant salarié exploitable introuvable.")

                ecc_cols = _get_effectif_competence_columns(cur)
                active_filter = "COALESCE(ecc.actif, TRUE) = TRUE" if "actif" in ecc_cols else "TRUE"
                archive_filter = "COALESCE(ecc.archive, FALSE) = FALSE" if "archive" in ecc_cols else "FALSE"
                order_expr = "COALESCE(ecc.dernier_update, NOW()) DESC" if "dernier_update" in ecc_cols else "ecc.id_effectif_competence DESC"

                cur.execute(
                    f"""
                    SELECT
                      ecc.id_effectif_competence,
                      ecc.niveau_actuel,
                      ecc.date_derniere_eval,
                      c.id_comp,
                      c.code,
                      c.intitule,
                      c.description,
                      c.domaine,
                      c.niveaua,
                      c.niveaub,
                      c.niveauc,
                      c.grille_evaluation
                    FROM public.tbl_effectif_client_competence ecc
                    JOIN public.tbl_competence c
                      ON c.id_comp = ecc.id_comp
                     AND c.id_owner = %s
                     AND COALESCE(c.masque, FALSE) = FALSE
                     AND COALESCE(c.etat, 'active') IN ('active', 'valide', 'à valider')
                    WHERE ecc.id_effectif_client = %s
                      AND c.id_comp = %s
                      AND {active_filter}
                      AND {archive_filter}
                    ORDER BY {order_expr}
                    LIMIT 1
                    """,
                    (oid, id_effectif_data, comp_id),
                )
                row = cur.fetchone() or {}
                if not row:
                    raise HTTPException(status_code=404, detail="Compétence collaborateur introuvable.")

                did = (row.get("domaine") or "").strip()
                dmeta = _load_domaine_competence_map(cur, [did]).get(did, {}) if did else {}
                logo_bytes = _fetch_owner_logo_bytes(cur, oid)

        skill = {
            "id_comp": row.get("id_comp"),
            "code": (row.get("code") or "").strip(),
            "intitule": (row.get("intitule") or "").strip(),
            "description": row.get("description") or "",
            "niveaua": row.get("niveaua") or "",
            "niveaub": row.get("niveaub") or "",
            "niveauc": row.get("niveauc") or "",
            "grille_evaluation": _json_like_to_obj(row.get("grille_evaluation")),
            "domaine": did,
            "domaine_titre": dmeta.get("titre") or "",
            "niveau_actuel": row.get("niveau_actuel") or "",
        }

        header_right = (
            (src.get("source_name") or "").strip()
            or (owner.get("nom_owner") or "").strip()
            or (owner.get("nom_ent") or "").strip()
            or "Novoskill Studio"
        )

        code_label = skill.get("code") or "Compétence"
        intitule_label = skill.get("intitule") or "Compétence"
        filename = _pdf_latin1_safe(
            f"Fiche compétence {_pdf_safe_filename_part(code_label, 32)} - {_pdf_safe_filename_part(intitule_label, 80)}.pdf"
        )

        pdf_bytes = build_pdf_document(
            _build_competence_pdf_story(skill),
            meta={
                "title": _pdf_latin1_safe(f"Fiche compétence - {code_label} - {intitule_label}"),
                "doc_label": _pdf_latin1_safe("Fiche compétence"),
                "footer_left": _pdf_latin1_safe("Novoskill Studio • Fiche compétence"),
                "header_right": _pdf_latin1_safe(header_right),
                "header_right_font_name": "Helvetica-Bold",
                "header_right_font_size": 10.5,
                "logo_bytes": logo_bytes,
            },
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences/fiche_pdf error: {e}")

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
                            lower(COALESCE(fpc.niveau_exigence, 'requis')) AS niveau_exigence
                        FROM public.tbl_fiche_poste_certification fpc
                        WHERE fpc.id_poste = %s
                    ),
                    curc_raw AS (
                        SELECT
                            ecc.*,
                            ROW_NUMBER() OVER (
                                PARTITION BY ecc.id_certification
                                ORDER BY
                                    ecc.date_maj DESC NULLS LAST,
                                    ecc.date_creation DESC NULLS LAST,
                                    ecc.id_effectif_certification DESC
                            ) AS rn
                        FROM public.tbl_effectif_client_certification ecc
                        WHERE ecc.id_effectif = %s
                          AND COALESCE(ecc.archive, FALSE) = FALSE
                    )
                    SELECT
                        ecc.id_effectif_certification,
                        ecc.id_certification,
                        c.nom_certification,
                        c.description,
                        c.categorie,
                        c.duree_validite,
                        c.delai_renouvellement,
                        COALESCE(req.validite_override, c.duree_validite) AS validite_attendue,
                        COALESCE(req.niveau_exigence, '') AS niveau_exigence,
                        CASE
                            WHEN req.id_certification IS NOT NULL
                             AND COALESCE(req.niveau_exigence, 'requis') IN ('souhaite', 'souhaité')
                            THEN TRUE ELSE FALSE
                        END AS is_wanted_poste,
                        CASE
                            WHEN req.id_certification IS NOT NULL
                             AND COALESCE(req.niveau_exigence, 'requis') NOT IN ('souhaite', 'souhaité')
                            THEN TRUE ELSE FALSE
                        END AS is_required_poste,
                        ecc.date_obtention,
                        ecc.date_expiration,
                        ecc.organisme,
                        ecc.reference,
                        ecc.commentaire,
                        ecc.id_preuve_doc,
                        COALESCE(NULLIF(BTRIM(COALESCE(ecc.etat, '')), ''), '') AS etat,
                        doc.nom_fichier AS preuve_nom_fichier,
                        doc.type_mime AS preuve_content_type
                    FROM curc_raw ecc
                    JOIN public.tbl_certification c
                      ON c.id_certification = ecc.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN req
                      ON req.id_certification = ecc.id_certification
                    LEFT JOIN public.tbl_effectif_client_certification_doc doc
                      ON doc.id_preuve_doc = ecc.id_preuve_doc
                     AND COALESCE(doc.archive, FALSE) = FALSE
                    WHERE ecc.rn = 1
                    ORDER BY
                        CASE
                            WHEN req.id_certification IS NOT NULL
                             AND COALESCE(req.niveau_exigence, 'requis') NOT IN ('souhaite', 'souhaité') THEN 0
                            WHEN req.id_certification IS NOT NULL
                             AND COALESCE(req.niveau_exigence, 'requis') IN ('souhaite', 'souhaité') THEN 1
                            ELSE 2
                        END,
                        lower(COALESCE(c.nom_certification, ''))
                    """,
                    (scope["id_poste_actuel"], scope["id_effectif_data"]),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            date_obtention = r.get("date_obtention")
            date_expiration = r.get("date_expiration")
            validite_attendue = r.get("validite_attendue")
            date_expiration_calculee = _collab_certification_expiration_effective(
                date_obtention,
                date_expiration,
                validite_attendue,
            )
            date_expiration_effective = date_expiration or date_expiration_calculee

            etat_code = _effective_collab_certification_state(
                r.get("etat"),
                date_obtention,
                date_expiration_effective,
                r.get("delai_renouvellement"),
            )

            items.append(
                {
                    "id_effectif_certification": r.get("id_effectif_certification"),
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "description": r.get("description"),
                    "categorie": r.get("categorie"),
                    "validite_attendue": validite_attendue,
                    "delai_renouvellement": r.get("delai_renouvellement"),
                    "niveau_exigence": r.get("niveau_exigence"),
                    "is_required_poste": bool(r.get("is_required_poste")),
                    "is_wanted_poste": bool(r.get("is_wanted_poste")),
                    "date_obtention": date_obtention.isoformat() if date_obtention else None,
                    "date_expiration": date_expiration.isoformat() if date_expiration else None,
                    "date_expiration_calculee": date_expiration_calculee.isoformat() if date_expiration_calculee else None,
                    "date_expiration_effective": date_expiration_effective.isoformat() if date_expiration_effective else None,
                    "etat": etat_code,
                    "etat_label": _collab_certification_state_label(etat_code),
                    "organisme": r.get("organisme"),
                    "reference": r.get("reference"),
                    "commentaire": r.get("commentaire"),
                    "id_preuve_doc": r.get("id_preuve_doc"),
                    "preuve_nom_fichier": r.get("preuve_nom_fichier"),
                    "preuve_content_type": r.get("preuve_content_type"),
                    "preuve_available": bool((r.get("id_preuve_doc") or "").strip() and (r.get("preuve_nom_fichier") or "").strip()),
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


@router.post("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}/add")
def studio_collab_certification_add(
    id_owner: str,
    id_collaborateur: str,
    payload: CollaborateurCertificationPayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        cert_id = (payload.id_certification or "").strip()

        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not cert_id:
            raise HTTPException(status_code=400, detail="id_certification manquant.")

        date_obtention = _norm_iso_date(payload.date_obtention)
        date_expiration = _norm_iso_date(payload.date_expiration)

        if date_obtention and date_expiration and date_expiration < date_obtention:
            raise HTTPException(status_code=400, detail="date_expiration incohérente avec date_obtention.")

        etat = _normalize_collab_certification_state(
            payload.etat,
            default=_default_collab_certification_state(date_obtention),
        )

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_certification
                    WHERE id_certification = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (cert_id,),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Certification introuvable dans le catalogue.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_effectif_client_certification
                    WHERE id_effectif = %s
                      AND id_certification = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (scope["id_effectif_data"], cert_id),
                )
                if cur.fetchone():
                    raise HTTPException(status_code=400, detail="Cette certification est déjà présente pour ce collaborateur.")

                id_effectif_certification = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_certification (
                      id_effectif_certification,
                      id_effectif,
                      id_certification,
                      date_obtention,
                      date_expiration,
                      organisme,
                      reference,
                      commentaire,
                      id_preuve_doc,
                      etat,
                      archive,
                      date_creation,
                      date_maj
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, FALSE, CURRENT_DATE, NOW()
                    )
                    """,
                    (
                        id_effectif_certification,
                        scope["id_effectif_data"],
                        cert_id,
                        date_obtention,
                        date_expiration,
                        _norm_text(payload.organisme),
                        _norm_text(payload.reference),
                        _norm_text(payload.commentaire),
                        etat,
                    ),
                )

        return {
            "ok": True,
            "id_effectif_certification": id_effectif_certification,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications/add error: {e}")


@router.post("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}/{id_effectif_certification}")
def studio_collab_certification_update(
    id_owner: str,
    id_collaborateur: str,
    id_effectif_certification: str,
    payload: CollaborateurCertificationPayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        ecid = (id_effectif_certification or "").strip()

        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not ecid:
            raise HTTPException(status_code=400, detail="id_effectif_certification manquant.")

        date_obtention = _norm_iso_date(payload.date_obtention)
        date_expiration = _norm_iso_date(payload.date_expiration)

        if date_obtention and date_expiration and date_expiration < date_obtention:
            raise HTTPException(status_code=400, detail="date_expiration incohérente avec date_obtention.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                existing = _get_collab_certification_row(cur, scope["id_effectif_data"], ecid)

                etat = _normalize_collab_certification_state(
                    payload.etat,
                    default=(existing.get("etat") or _default_collab_certification_state(date_obtention)),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_certification
                    SET
                      etat = %s,
                      date_obtention = %s,
                      date_expiration = %s,
                      organisme = %s,
                      reference = %s,
                      commentaire = %s,
                      date_maj = NOW()
                    WHERE id_effectif_certification = %s
                    """,
                    (
                        etat,
                        date_obtention,
                        date_expiration,
                        _norm_text(payload.organisme),
                        _norm_text(payload.reference),
                        _norm_text(payload.commentaire),
                        ecid,
                    ),
                )

        return {"ok": True, "id_effectif_certification": ecid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications/update error: {e}")


@router.post("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}/{id_effectif_certification}/archive")
def studio_collab_certification_archive(
    id_owner: str,
    id_collaborateur: str,
    id_effectif_certification: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        ecid = (id_effectif_certification or "").strip()

        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not ecid:
            raise HTTPException(status_code=400, detail="id_effectif_certification manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                existing = _get_collab_certification_row(cur, scope["id_effectif_data"], ecid)

                _archive_collab_certification_proof(cur, existing.get("id_preuve_doc"))

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_certification
                    SET archive = TRUE,
                        id_preuve_doc = NULL,
                        date_maj = NOW()
                    WHERE id_effectif_certification = %s
                    """,
                    (ecid,),
                )

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications/archive error: {e}")


@router.post("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}/{id_effectif_certification}/preuve")
def studio_collab_certification_upload_proof(
    id_owner: str,
    id_collaborateur: str,
    id_effectif_certification: str,
    request: Request,
    file: UploadFile = File(...),
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        ecid = (id_effectif_certification or "").strip()

        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not ecid:
            raise HTTPException(status_code=400, detail="id_effectif_certification manquant.")

        filename = (getattr(file, "filename", "") or "preuve").strip() or "preuve"
        raw = file.file.read() if file and file.file else b""
        if not raw:
            raise HTTPException(status_code=400, detail="Fichier preuve vide.")
        if len(raw) > CERTIFICATION_PROOF_MAX_BYTES:
            raise HTTPException(status_code=400, detail="Fichier preuve trop volumineux (max 5 Mo).")

        content_type = _normalize_certification_proof_content_type(filename, getattr(file, "content_type", ""))
        if content_type not in CERTIFICATION_ALLOWED_PROOF_MIME:
            raise HTTPException(status_code=400, detail="Format preuve non supporté (PDF, PNG, JPEG, WEBP).")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                existing = _get_collab_certification_row(cur, scope["id_effectif_data"], ecid)

                old_proof_id = (existing.get("id_preuve_doc") or "").strip()
                if old_proof_id:
                    _archive_collab_certification_proof(cur, old_proof_id)

                new_proof_id = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_certification_doc (
                      id_preuve_doc,
                      id_effectif_certification,
                      nom_fichier,
                      type_mime,
                      document_bytes,
                      taille_octets,
                      archive,
                      date_creation,
                      date_maj
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, FALSE, NOW(), NOW()
                    )
                    """,
                    (
                        new_proof_id,
                        ecid,
                        filename,
                        content_type,
                        raw,
                        len(raw),
                    ),
                )

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_certification
                    SET id_preuve_doc = %s,
                        date_maj = NOW()
                    WHERE id_effectif_certification = %s
                    """,
                    (new_proof_id, ecid),
                )

        return {
            "ok": True,
            "id_preuve_doc": new_proof_id,
            "nom_fichier": filename,
            "type_mime": content_type,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications/proof upload error: {e}")


@router.get("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}/{id_effectif_certification}/preuve")
def studio_collab_certification_open_proof(
    id_owner: str,
    id_collaborateur: str,
    id_effectif_certification: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        ecid = (id_effectif_certification or "").strip()

        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")
        if not ecid:
            raise HTTPException(status_code=400, detail="id_effectif_certification manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

                existing = _get_collab_certification_row(cur, scope["id_effectif_data"], ecid)
                proof_id = (existing.get("id_preuve_doc") or "").strip()
                if not proof_id:
                    raise HTTPException(status_code=404, detail="Aucune preuve disponible pour cette certification.")

                cur.execute(
                    """
                    SELECT
                      nom_fichier,
                      type_mime,
                      document_bytes
                    FROM public.tbl_effectif_client_certification_doc
                    WHERE id_preuve_doc = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (proof_id,),
                )
                doc = cur.fetchone() or {}
                if not doc:
                    raise HTTPException(status_code=404, detail="Document preuve introuvable.")

        raw = doc.get("document_bytes")
        data = bytes(raw) if raw is not None else b""
        if not data:
            raise HTTPException(status_code=404, detail="Document preuve vide.")

        filename = (doc.get("nom_fichier") or "preuve").replace('"', "'")
        media_type = (doc.get("type_mime") or "application/octet-stream").strip() or "application/octet-stream"

        return Response(
            content=data,
            media_type=media_type,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications/proof open error: {e}")


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

                date_naissance = _norm_iso_date(payload.date_naissance)
                date_entree = _norm_iso_date(payload.date_entree_entreprise)
                date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                date_sortie = _norm_iso_date(payload.date_sortie_prevue)

                # Calcul approximatif de l’année de retraite estimée.
                # Voir les helpers ci-dessus pour la règle détaillée et les hypothèses retenues.
                retraite_estimee = _compute_retraite_estimee(
                    date_naissance,
                    _norm_text(payload.niveau_education),
                )

                if src["source_kind"] == "entreprise":
                    cid = str(uuid.uuid4())
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
                          retraite_estimee,
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
                          %s, %s, %s, %s, %s, %s, FALSE, CURRENT_DATE, NOW(), %s, %s,
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
                          retraite_estimee,
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
                    return {
                        "ok": True,
                        "id_collaborateur": cid,
                        "retraite_estimee": retraite_estimee,
                    }

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

                return {
                    "ok": True,
                    "id_collaborateur": cid,
                    "retraite_estimee": retraite_estimee,
                }

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

                date_naissance = _norm_iso_date(payload.date_naissance)
                date_entree = _norm_iso_date(payload.date_entree_entreprise)
                date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                date_sortie = _norm_iso_date(payload.date_sortie_prevue)

                # Calcul approximatif de l’année de retraite estimée.
                # Voir les helpers ci-dessus pour la règle détaillée et les hypothèses retenues.
                retraite_estimee = _compute_retraite_estimee(
                    date_naissance,
                    _norm_text(payload.niveau_education),
                )

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
                          retraite_estimee = %s,
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
                          retraite_estimee,
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
                    return {
                        "ok": True,
                        "id_collaborateur": cid,
                        "retraite_estimee": retraite_estimee,
                    }

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

                return {
                    "ok": True,
                    "id_collaborateur": cid,
                    "retraite_estimee": retraite_estimee,
                }

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