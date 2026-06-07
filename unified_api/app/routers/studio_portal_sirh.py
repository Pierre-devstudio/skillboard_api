from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from typing import Optional, Any
import json
import os

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)
from app.studio_connectors_sirh import normalize_provider_code, provider_label
from app.studio_connectors_sirh import ebp_paie

router = APIRouter()


class StudioSirhConfigPayload(BaseModel):
    provider_code: Optional[str] = "manual"
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    client_id: Optional[str] = None
    dossier_code: Optional[str] = None


def _clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip()
    return v or None


def _sirh_secret_key() -> str:
    key = (
        os.getenv("NOVOSKILL_SIRH_SECRET_KEY")
        or os.getenv("STUDIO_SIRH_SECRET_KEY")
        or os.getenv("NOVOSKILL_LMS_SECRET_KEY")
        or ""
    ).strip()
    if not key:
        raise HTTPException(status_code=500, detail="NOVOSKILL_SIRH_SECRET_KEY non configurée.")
    return key


def _sirh_table_exists(cur) -> bool:
    cur.execute("SELECT to_regclass('public.tbl_studio_sirh_config') AS table_name")
    row = cur.fetchone() or {}
    return bool(row.get("table_name"))


def _require_owner_access(cur, u: dict, id_owner: str) -> str:
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
    if cur.fetchone() is None:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
    return oid


def _default_public_config(schema_ready: bool = True) -> dict:
    return {
        "schema_ready": bool(schema_ready),
        "configured": False,
        "id_sirh_config": None,
        "provider_code": "manual",
        "provider_label": provider_label("manual"),
        "nom_configuration": provider_label("manual"),
        "base_url": "",
        "client_id": "",
        "tenant_id": "",
        "dossier_code": "",
        "has_secret": False,
        "actif": False,
    }


def _decode_config_json(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _public_config(row: Optional[dict], schema_ready: bool = True) -> dict:
    if not row:
        return _default_public_config(schema_ready=schema_ready)

    cfg = _decode_config_json(row.get("config_json"))
    provider_code = normalize_provider_code(row.get("provider_code"))
    has_secret = bool(row.get("has_secret"))

    return {
        "schema_ready": bool(schema_ready),
        "configured": provider_code != "manual" and has_secret,
        "id_sirh_config": row.get("id_sirh_config"),
        "provider_code": provider_code,
        "provider_label": provider_label(provider_code),
        "nom_configuration": row.get("nom_configuration") or provider_label(provider_code),
        "base_url": row.get("base_url") or "",
        "client_id": cfg.get("client_id") or cfg.get("tenant_id") or "",
        "tenant_id": cfg.get("tenant_id") or cfg.get("client_id") or "",
        "dossier_code": cfg.get("dossier_code") or "",
        "has_secret": has_secret,
        "actif": bool(row.get("actif")),
    }


def _fetch_active_config(cur, oid: str, with_secret: bool = False) -> Optional[dict]:
    if not _sirh_table_exists(cur):
        return None

    if with_secret:
        cur.execute(
            """
            SELECT
              id_sirh_config,
              id_owner,
              provider_code,
              nom_configuration,
              base_url,
              config_json,
              (secret_json_encrypted IS NOT NULL) AS has_secret,
              pgp_sym_decrypt(secret_json_encrypted, %s)::text AS secret_json_txt,
              actif
            FROM public.tbl_studio_sirh_config
            WHERE id_owner = %s
              AND COALESCE(archive, FALSE) = FALSE
              AND COALESCE(actif, TRUE) = TRUE
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (_sirh_secret_key(), oid),
        )
    else:
        cur.execute(
            """
            SELECT
              id_sirh_config,
              id_owner,
              provider_code,
              nom_configuration,
              base_url,
              config_json,
              (secret_json_encrypted IS NOT NULL) AS has_secret,
              actif
            FROM public.tbl_studio_sirh_config
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

    if with_secret and row.get("secret_json_txt"):
        try:
            row["secret_json"] = json.loads(row.get("secret_json_txt") or "{}")
        except Exception:
            row["secret_json"] = {}

    return row


def _build_provider_config(provider_code: str, payload: StudioSirhConfigPayload) -> dict:
    if provider_code == "ebp_paie":
        return ebp_paie.build_config_json(
            client_id=payload.client_id,
            dossier_code=payload.dossier_code,
        )
    return {}


def _build_provider_secret(provider_code: str, payload: StudioSirhConfigPayload) -> dict:
    if provider_code == "ebp_paie":
        return ebp_paie.build_secret_json(api_key=payload.api_key)
    return {}


def _validate_payload(provider_code: str, payload: StudioSirhConfigPayload, existing: Optional[dict]) -> None:
    if provider_code == "manual":
        return

    if provider_code == "ebp_paie":
        api_key = _clean_text(payload.api_key)
        has_existing_secret = bool(existing and existing.get("has_secret"))
        if not api_key and not has_existing_secret:
            raise HTTPException(status_code=400, detail="Clé API obligatoire pour préparer le connecteur EBP Paie.")
        return

    raise HTTPException(status_code=400, detail="Connecteur SIRH non géré.")


@router.get("/studio/sirh/owner/{id_owner}/config")
def get_owner_sirh_config(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "user")

                if not _sirh_table_exists(cur):
                    return _default_public_config(schema_ready=False)

                row = _fetch_active_config(cur, oid, with_secret=False)
                return _public_config(row, schema_ready=True)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/sirh config get error: {e}")


@router.post("/studio/sirh/owner/{id_owner}/config")
def save_owner_sirh_config(id_owner: str, payload: StudioSirhConfigPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        provider_code = normalize_provider_code(payload.provider_code)
        base_url = _clean_text(payload.base_url)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _sirh_table_exists(cur):
                    raise HTTPException(status_code=400, detail="Table SIRH absente. Exécute PATCH_SQL_STUDIO_SIRH_CONNECTORS.sql dans Supabase avant d’enregistrer.")

                existing = _fetch_active_config(cur, oid, with_secret=False)
                existing_id = (existing or {}).get("id_sirh_config")
                _validate_payload(provider_code, payload, existing)

                cfg_json = _build_provider_config(provider_code, payload)
                secret_json = _build_provider_secret(provider_code, payload)
                secret_value = json.dumps(secret_json, ensure_ascii=False) if secret_json else None

                if existing_id:
                    if secret_value:
                        cur.execute(
                            """
                            UPDATE public.tbl_studio_sirh_config
                            SET provider_code = %s,
                                nom_configuration = %s,
                                base_url = %s,
                                config_json = %s::jsonb,
                                secret_json_encrypted = pgp_sym_encrypt(%s, %s),
                                actif = TRUE,
                                archive = FALSE,
                                updated_at = NOW()
                            WHERE id_sirh_config = %s
                              AND id_owner = %s
                            """,
                            (
                                provider_code,
                                provider_label(provider_code),
                                base_url,
                                json.dumps(cfg_json, ensure_ascii=False),
                                secret_value,
                                _sirh_secret_key(),
                                existing_id,
                                oid,
                            ),
                        )
                    else:
                        cur.execute(
                            """
                            UPDATE public.tbl_studio_sirh_config
                            SET provider_code = %s,
                                nom_configuration = %s,
                                base_url = %s,
                                config_json = %s::jsonb,
                                actif = TRUE,
                                archive = FALSE,
                                updated_at = NOW()
                            WHERE id_sirh_config = %s
                              AND id_owner = %s
                            """,
                            (
                                provider_code,
                                provider_label(provider_code),
                                base_url,
                                json.dumps(cfg_json, ensure_ascii=False),
                                existing_id,
                                oid,
                            ),
                        )

                        if provider_code == "manual":
                            cur.execute(
                                """
                                UPDATE public.tbl_studio_sirh_config
                                SET secret_json_encrypted = NULL
                                WHERE id_sirh_config = %s
                                  AND id_owner = %s
                                """,
                                (existing_id, oid),
                            )
                else:
                    cur.execute(
                        """
                        INSERT INTO public.tbl_studio_sirh_config
                          (
                            id_sirh_config,
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
                            provider_label(provider_code),
                            base_url,
                            json.dumps(cfg_json, ensure_ascii=False),
                            secret_value,
                            secret_value,
                            _sirh_secret_key() if secret_value else "",
                        ),
                    )

                conn.commit()

                row = _fetch_active_config(cur, oid, with_secret=False)
                return {"ok": True, "config": _public_config(row, schema_ready=True)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/sirh config save error: {e}")
