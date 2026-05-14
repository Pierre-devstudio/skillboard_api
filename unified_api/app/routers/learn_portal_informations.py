from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Any
from psycopg.rows import dict_row
import json
import os
import re
import time
import urllib.request
import urllib.error

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import learn_require_user, learn_fetch_profile

router = APIRouter()


# ======================================================
# Helpers profil / droits
# ======================================================

def _learn_info_require_profile(cur, u: dict, id_effectif: str) -> dict:
    eid = (id_effectif or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="id_effectif manquant.")

    profile = learn_fetch_profile(
        cur,
        id_effectif=eid,
        email=(u.get("email") or ""),
        is_super_admin=bool(u.get("is_super_admin")),
    )

    oid = (profile.get("id_owner") or "").strip()
    if not oid:
        raise HTTPException(status_code=403, detail="Profil Learn sans owner.")

    role = (profile.get("role_code") or "user").strip().lower()
    if role not in ("admin", "supervisor", "user"):
        role = "user"

    profile["role_code"] = role
    return profile


def _learn_info_role_rank(role_code: str) -> int:
    c = (role_code or "").strip().lower()
    if c == "admin":
        return 3
    if c == "supervisor":
        return 2
    return 1


def _learn_info_require_min_role(profile: dict, min_role: str) -> None:
    if _learn_info_role_rank(profile.get("role_code")) < _learn_info_role_rank(min_role):
        raise HTTPException(status_code=403, detail="Accès refusé : droits insuffisants.")


# ======================================================
# Helpers LMS communs
# ======================================================

def learn_lms_secret_key() -> str:
    key = (os.getenv("NOVOSKILL_LMS_SECRET_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=500, detail="NOVOSKILL_LMS_SECRET_KEY non configurée.")
    return key


def learn_lms_normalize_provider(value: Any) -> str:
    v = str(value or "").strip().lower()
    if v in ("lara", "lärä", "lara_lms"):
        return "lara"
    return "manual"


def learn_lms_normalize_base_url(value: Any) -> str:
    url = str(value or "").strip().rstrip("/")
    if not url:
        return ""

    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url

    low = url.lower()

    for suffix in (
        "/workspace/gettypes",
        "/workspace/create",
        "/workspace/edit",
        "/workspace/geturl",
        "/workspace/get",
        "/provider/getlist",
    ):
        if low.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
            low = url.lower()

    if "/lmsapi" not in low:
        url = url.rstrip("/") + "/lmsapi"

    return url.rstrip("/")


def learn_lms_safe_int(value: Any, default: int = 3) -> int:
    try:
        return int(value)
    except Exception:
        return default


def learn_lms_config_json(provider_code: str, visibility_type: int = 3, language: int = 3) -> dict:
    if provider_code != "lara":
        return {}

    return {
        "visibility_type": learn_lms_safe_int(visibility_type, 3),
        "language": learn_lms_safe_int(language, 3),
    }


def learn_lms_public_config(row: Optional[dict]) -> dict:
    if not row:
        return {
            "configured": False,
            "provider_code": "manual",
            "provider_label": "Aucun / export HTML manuel",
            "base_url": "",
            "has_secret": False,
            "visibility_type": 3,
            "language": 3,
            "actif": False,
        }

    cfg = row.get("config_json") or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}

    provider_code = learn_lms_normalize_provider(row.get("provider_code"))

    return {
        "configured": provider_code != "manual",
        "id_lms_config": row.get("id_lms_config"),
        "provider_code": provider_code,
        "provider_label": "Lära" if provider_code == "lara" else "Aucun / export HTML manuel",
        "base_url": row.get("base_url") or "",
        "has_secret": bool(row.get("has_secret")),
        "visibility_type": learn_lms_safe_int(cfg.get("visibility_type"), 3),
        "language": learn_lms_safe_int(cfg.get("language"), 3),
        "actif": bool(row.get("actif")),
    }


def learn_lms_fetch_public_config(cur, oid: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          id_lms_config,
          id_owner,
          provider_code,
          nom_configuration,
          base_url,
          config_json,
          (secret_json_encrypted IS NOT NULL) AS has_secret,
          actif
        FROM public.tbl_learn_lms_config
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(actif, TRUE) = TRUE
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
        """,
        (oid,),
    )
    return cur.fetchone()


def learn_lms_fetch_active_config(cur, oid: str, with_secret: bool = False) -> Optional[dict]:
    if with_secret:
        cur.execute(
            """
            SELECT
              id_lms_config,
              id_owner,
              provider_code,
              nom_configuration,
              base_url,
              config_json,
              (secret_json_encrypted IS NOT NULL) AS has_secret,
              actif,
              pgp_sym_decrypt(secret_json_encrypted, %s)::text AS secret_json_txt
            FROM public.tbl_learn_lms_config
            WHERE id_owner = %s
              AND COALESCE(archive, FALSE) = FALSE
              AND COALESCE(actif, TRUE) = TRUE
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (learn_lms_secret_key(), oid),
        )
    else:
        cur.execute(
            """
            SELECT
              id_lms_config,
              id_owner,
              provider_code,
              nom_configuration,
              base_url,
              config_json,
              (secret_json_encrypted IS NOT NULL) AS has_secret,
              actif
            FROM public.tbl_learn_lms_config
            WHERE id_owner = %s
              AND COALESCE(archive, FALSE) = FALSE
              AND COALESCE(actif, TRUE) = TRUE
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (oid,),
        )

    row = cur.fetchone()
    if not row:
        return None

    cfg = row.get("config_json") or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}

    row["config_json"] = cfg
    row["provider_code"] = learn_lms_normalize_provider(row.get("provider_code"))

    if with_secret:
        raw_secret = row.get("secret_json_txt") or "{}"
        try:
            row["secret_json"] = json.loads(raw_secret)
        except Exception:
            row["secret_json"] = {}

    return row

def learn_lms_api_post(api_base: str, api_id: str, path: str, payload: Optional[dict] = None, timeout: int = 45) -> dict:
    base_url = learn_lms_normalize_base_url(api_base)
    key = str(api_id or "").strip()

    if not base_url:
        return {"ok": False, "status": None, "json": None, "raw": "", "error": "URL API manquante."}

    if not key:
        return {"ok": False, "status": None, "json": None, "raw": "", "error": "ApiID manquant."}

    url = base_url.rstrip("/") + "/" + str(path or "").strip("/")
    body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url=url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "ApiID": key,
        },
    )

    started = time.time()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = getattr(resp, "status", 200)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        status = e.code
    except Exception as e:
        return {
            "ok": False,
            "url": url,
            "status": None,
            "elapsed_ms": int((time.time() - started) * 1000),
            "raw": "",
            "json": None,
            "error": str(e),
        }

    parsed = None
    try:
        parsed = json.loads(raw) if raw else None
    except Exception:
        parsed = None

    has_error = isinstance(parsed, dict) and bool(parsed.get("errors"))

    return {
        "ok": status is not None and 200 <= int(status) < 300 and not has_error,
        "url": url,
        "status": status,
        "elapsed_ms": int((time.time() - started) * 1000),
        "raw": raw,
        "json": parsed,
        "error": None,
    }


def learn_lms_localized_text(value: Any) -> str:
    if isinstance(value, dict):
        texts = value.get("texts") or []

        if isinstance(texts, list):
            for lang in (3, 1, 2, 4):
                for item in texts:
                    if isinstance(item, dict) and str(item.get("languageId")) == str(lang):
                        txt = str(item.get("text") or "").strip()
                        if txt:
                            return txt

            for item in texts:
                if isinstance(item, dict):
                    txt = str(item.get("text") or "").strip()
                    if txt:
                        return txt

    return str(value or "").strip()


def learn_lms_choose_formation_type(items: Any) -> Optional[dict]:
    rows = [x for x in (items or []) if isinstance(x, dict) and x.get("isActive") is not False]

    for r in rows:
        if learn_lms_localized_text(r.get("name")).strip().lower() == "formation" and str(r.get("type")) == "1":
            return r

    for r in rows:
        if str(r.get("type")) == "1" and r.get("isDefault") is True:
            return r

    for r in rows:
        if str(r.get("type")) == "1":
            return r

    return rows[0] if rows else None


def learn_lms_choose_provider(items: Any) -> Optional[dict]:
    rows = [x for x in (items or []) if isinstance(x, dict) and str(x.get("id") or "").strip()]
    if not rows:
        return None
    return rows[0]


def learn_lms_extract_workspace_id(resp_json: Any) -> str:
    if isinstance(resp_json, dict):
        return str(resp_json.get("id") or "").strip()
    return ""


def learn_lms_extract_url(resp_json: Any) -> str:
    if isinstance(resp_json, list):
        for item in resp_json:
            if isinstance(item, dict) and str(item.get("url") or "").strip():
                return str(item.get("url") or "").strip()

    if isinstance(resp_json, dict):
        for key in ("url", "catalogUrl", "publicUrl"):
            if str(resp_json.get(key) or "").strip():
                return str(resp_json.get(key) or "").strip()

    return ""


def learn_lms_short_description(value: Any, max_len: int = 200) -> str:
    txt = str(value or "").replace("\x00", " ")
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = re.sub(r"\s+", " ", txt).strip()

    if len(txt) > max_len:
        cut = txt[:max_len].rsplit(" ", 1)[0].strip()
        txt = cut if cut else txt[:max_len].strip()

    return txt


def learn_lms_keywords(form: dict) -> str:
    parts = [
        form.get("code"),
        form.get("titre"),
        form.get("domaine_titre_court"),
        form.get("domaine_titre"),
        "Novoskill",
    ]

    vals = []
    seen = set()

    for p in parts:
        s = str(p or "").strip()
        if not s:
            continue

        key = s.lower()
        if key in seen:
            continue

        seen.add(key)
        vals.append(s)

    return ", ".join(vals)[:500]

def learn_lms_api_error_message(step: str, response: dict) -> str:
    status = response.get("status")
    error = response.get("error")
    raw = response.get("raw")
    parsed = response.get("json")

    parts = [f"{step} a échoué"]

    if status is not None:
        parts.append(f"statut HTTP {status}")

    if error:
        parts.append(str(error))

    if isinstance(parsed, dict):
        errors = parsed.get("errors")
        if isinstance(errors, dict):
            msg = errors.get("message") or errors.get("Message")
            if msg:
                parts.append(str(msg))
        elif isinstance(errors, str):
            parts.append(errors)

    if raw and not isinstance(parsed, (dict, list)):
        parts.append(str(raw)[:500])

    return " - ".join(parts)

def learn_lms_resolve_lara_defaults(cfg: dict) -> dict:
    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    r_types = learn_lms_api_post(api_base, api_id, "workspace/gettypes", {})
    if not r_types.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=learn_lms_api_error_message("workspace/gettypes", r_types),
        )

    type_row = learn_lms_choose_formation_type(r_types.get("json") or [])
    if not type_row:
        raise HTTPException(status_code=400, detail="Aucun type Formation exploitable trouvé dans Lära.")

    r_provider = learn_lms_api_post(api_base, api_id, "provider/getlist", {})

    if not r_provider.get("ok"):
        r_provider = learn_lms_api_post(
            api_base,
            api_id,
            "provider/getlist",
            {"filterDate": "1900-01-01T00:00:00Z"},
        )

    if not r_provider.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=learn_lms_api_error_message("provider/getlist", r_provider),
        )

    provider = learn_lms_choose_provider(r_provider.get("json") or [])
    if not provider:
        raise HTTPException(status_code=400, detail="Aucun fournisseur Lära disponible.")

    return {
        "workspace_type_id": str(type_row.get("id") or "").strip(),
        "workspace_type_label": learn_lms_localized_text(type_row.get("name")),
        "provider_id": str(provider.get("id") or "").strip(),
        "provider_label": learn_lms_localized_text(provider.get("name")) or learn_lms_localized_text(provider.get("shortName")),
    }


# ======================================================
# Models
# ======================================================

class LearnLmsConfigPayload(BaseModel):
    provider_code: Optional[str] = "manual"
    base_url: Optional[str] = None
    api_id: Optional[str] = None
    visibility_type: Optional[int] = 3
    language: Optional[int] = 3


# ======================================================
# Routes - Informations / configuration LMS
# ======================================================

@router.get("/learn/informations/{id_effectif}/lms/config")
def learn_informations_lms_config_get(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_info_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                row = learn_lms_fetch_public_config(cur, oid)

        return learn_lms_public_config(row)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/informations lms config get error: {e}")


@router.post("/learn/informations/{id_effectif}/lms/config")
def learn_informations_lms_config_save(id_effectif: str, payload: LearnLmsConfigPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        provider_code = learn_lms_normalize_provider(payload.provider_code)
        base_url = learn_lms_normalize_base_url(payload.base_url)
        api_id = str(payload.api_id or "").strip()
        cfg_json = learn_lms_config_json(
            provider_code,
            visibility_type=learn_lms_safe_int(payload.visibility_type, 3),
            language=learn_lms_safe_int(payload.language, 3),
        )

        if provider_code == "lara" and not base_url:
            raise HTTPException(status_code=400, detail="URL API Lära obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_info_require_profile(cur, u, id_effectif)
                _learn_info_require_min_role(profile, "admin")
                oid = (profile.get("id_owner") or "").strip()

                existing = learn_lms_fetch_active_config(cur, oid, with_secret=False)
                existing_id = (existing or {}).get("id_lms_config")

                if provider_code == "lara" and not api_id and not (existing and existing.get("has_secret")):
                    raise HTTPException(status_code=400, detail="ApiID obligatoire pour configurer Lära.")

                if existing_id:
                    if api_id:
                        cur.execute(
                            """
                            UPDATE public.tbl_learn_lms_config
                            SET provider_code = %s,
                                nom_configuration = %s,
                                base_url = %s,
                                config_json = %s::jsonb,
                                secret_json_encrypted = pgp_sym_encrypt(%s, %s),
                                actif = TRUE,
                                archive = FALSE,
                                updated_at = NOW()
                            WHERE id_lms_config = %s
                              AND id_owner = %s
                            """,
                            (
                                provider_code,
                                "Lära" if provider_code == "lara" else "Export HTML manuel",
                                base_url or None,
                                json.dumps(cfg_json, ensure_ascii=False),
                                json.dumps({"api_id": api_id}, ensure_ascii=False),
                                learn_lms_secret_key(),
                                existing_id,
                                oid,
                            ),
                        )
                    else:
                        cur.execute(
                            """
                            UPDATE public.tbl_learn_lms_config
                            SET provider_code = %s,
                                nom_configuration = %s,
                                base_url = %s,
                                config_json = %s::jsonb,
                                actif = TRUE,
                                archive = FALSE,
                                updated_at = NOW()
                            WHERE id_lms_config = %s
                              AND id_owner = %s
                            """,
                            (
                                provider_code,
                                "Lära" if provider_code == "lara" else "Export HTML manuel",
                                base_url or None,
                                json.dumps(cfg_json, ensure_ascii=False),
                                existing_id,
                                oid,
                            ),
                        )

                        if provider_code == "manual":
                            cur.execute(
                                """
                                UPDATE public.tbl_learn_lms_config
                                SET secret_json_encrypted = NULL
                                WHERE id_lms_config = %s
                                  AND id_owner = %s
                                """,
                                (existing_id, oid),
                            )
                else:
                    secret_value = json.dumps({"api_id": api_id}, ensure_ascii=False) if api_id else None
                    cur.execute(
                        """
                        INSERT INTO public.tbl_learn_lms_config
                          (
                            id_lms_config,
                            id_owner,
                            provider_code,
                            nom_configuration,
                            base_url,
                            config_json,
                            secret_json_encrypted,
                            actif,
                            archive,
                            created_at,
                            updated_at
                          )
                        VALUES
                          (
                            gen_random_uuid()::text,
                            %s,
                            %s,
                            %s,
                            %s,
                            %s::jsonb,
                            CASE WHEN %s::text IS NULL THEN NULL ELSE pgp_sym_encrypt(%s, %s) END,
                            TRUE,
                            FALSE,
                            NOW(),
                            NOW()
                          )
                        """,
                        (
                            oid,
                            provider_code,
                            "Lära" if provider_code == "lara" else "Export HTML manuel",
                            base_url or None,
                            json.dumps(cfg_json, ensure_ascii=False),
                            secret_value,
                            secret_value,
                            learn_lms_secret_key() if secret_value else "",
                        ),
                    )

                conn.commit()

                row = learn_lms_fetch_public_config(cur, oid)

        return {"ok": True, "config": learn_lms_public_config(row)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/informations lms config save error: {e}")


@router.post("/learn/informations/{id_effectif}/lms/test")
def learn_informations_lms_config_test(id_effectif: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_info_require_profile(cur, u, id_effectif)
                _learn_info_require_min_role(profile, "admin")
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)

        if not cfg or cfg.get("provider_code") != "lara":
            raise HTTPException(status_code=400, detail="Aucun connecteur Lära actif.")

        resolved = learn_lms_resolve_lara_defaults(cfg)

        return {
            "ok": True,
            "provider_code": "lara",
            "base_url": cfg.get("base_url") or "",
            "workspace_type_id": resolved.get("workspace_type_id"),
            "workspace_type_label": resolved.get("workspace_type_label"),
            "provider_id": resolved.get("provider_id"),
            "provider_label": resolved.get("provider_label"),
            "message": "Connexion Lära validée.",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/informations lms test error: {e}")
