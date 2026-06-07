from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from typing import Optional, Any
from uuid import uuid4
import re

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

router = APIRouter()


class SsoConfigPayload(BaseModel):
    sso_enabled: Optional[bool] = None
    domaine_autorise: Optional[str] = None
    type_sso: Optional[str] = None
    metadata_url: Optional[str] = None
    metadata_xml: Optional[str] = None
    provider_id_supabase: Optional[str] = None
    attribut_email: Optional[str] = None
    password_allowed: Optional[bool] = None
    sso_obligatoire: Optional[bool] = None


def _clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip()
    return v or None


def _clean_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "vrai", "yes", "oui", "on")


def _normalize_domain(value: Any) -> Optional[str]:
    v = _clean_text(value)
    if not v:
        return None
    v = v.lower().strip()
    if v.startswith("@"):
        v = v[1:]
    if "@" in v:
        v = v.split("@")[-1]
    v = re.sub(r"^https?://", "", v)
    v = v.split("/")[0].strip()
    if not v:
        return None
    if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", v):
        raise HTTPException(status_code=400, detail="Domaine SSO invalide. Exemple attendu : entreprise.fr")
    return v


def _normalize_type_sso(value: Any) -> str:
    v = (_clean_text(value) or "saml_2_0").lower()
    if v in ("saml", "saml2", "saml_2", "saml_2_0", "saml 2.0"):
        return "saml_2_0"
    raise HTTPException(status_code=400, detail="Type SSO invalide. Seul SAML 2.0 est géré dans cette version.")


def _normalize_attr_email(value: Any) -> str:
    v = _clean_text(value) or "email"
    v = re.sub(r"\s+", "", v)
    return (v or "email")[:120]


def _sso_table_exists(cur) -> bool:
    cur.execute("SELECT to_regclass('public.tbl_novoskill_sso_config') AS table_name")
    r = cur.fetchone() or {}
    return bool(r.get("table_name"))


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


def _structure_exists_for_owner(cur, id_owner: str, id_ent: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_owner),
    )
    return cur.fetchone() is not None


def _default_config(scope_type: str, id_scope: str, id_owner_gestionnaire: Optional[str] = None, schema_ready: bool = True) -> dict:
    return {
        "schema_ready": bool(schema_ready),
        "id_sso_config": None,
        "scope_type": scope_type,
        "id_scope": id_scope,
        "id_owner_gestionnaire": id_owner_gestionnaire,
        "sso_enabled": False,
        "sso_statut": "desactive",
        "domaine_autorise": None,
        "type_sso": "saml_2_0",
        "metadata_url": None,
        "metadata_xml": None,
        "provider_id_supabase": None,
        "attribut_email": "email",
        "password_allowed": True,
        "sso_obligatoire": False,
        "test_statut": "non_teste",
        "test_date": None,
        "test_message": None,
        "is_complete": False,
        "missing_fields": [],
    }


def _completion_state(cfg: dict) -> tuple[bool, list[str]]:
    if not bool(cfg.get("sso_enabled")):
        return False, []

    missing = []
    if not _clean_text(cfg.get("domaine_autorise")):
        missing.append("domaine_autorise")
    if not _clean_text(cfg.get("provider_id_supabase")):
        missing.append("provider_id_supabase")
    if not _clean_text(cfg.get("attribut_email")):
        missing.append("attribut_email")
    if not (_clean_text(cfg.get("metadata_url")) or _clean_text(cfg.get("metadata_xml"))):
        missing.append("metadata_url_ou_metadata_xml")
    return len(missing) == 0, missing


def _computed_status(cfg: dict) -> str:
    if not bool(cfg.get("sso_enabled")):
        return "desactive"
    complete, _ = _completion_state(cfg)
    if not complete:
        return "configuration"
    if (cfg.get("test_statut") or "") == "valide":
        return "actif"
    return "a_tester"


def _row_to_config(row: Optional[dict], scope_type: str, id_scope: str, id_owner_gestionnaire: Optional[str], schema_ready: bool = True) -> dict:
    cfg = _default_config(scope_type, id_scope, id_owner_gestionnaire, schema_ready=schema_ready)
    if row:
        for k in cfg.keys():
            if k in row:
                cfg[k] = row.get(k)
        if row.get("test_date"):
            try:
                cfg["test_date"] = row.get("test_date").isoformat()
            except Exception:
                cfg["test_date"] = str(row.get("test_date"))

    complete, missing = _completion_state(cfg)
    cfg["is_complete"] = complete
    cfg["missing_fields"] = missing
    cfg["sso_statut"] = _computed_status(cfg)
    return cfg


def _fetch_config(cur, scope_type: str, id_scope: str, id_owner_gestionnaire: Optional[str] = None) -> dict:
    if not _sso_table_exists(cur):
        return _default_config(scope_type, id_scope, id_owner_gestionnaire, schema_ready=False)

    cur.execute(
        """
        SELECT
            id_sso_config,
            scope_type,
            id_scope,
            id_owner_gestionnaire,
            sso_enabled,
            sso_statut,
            domaine_autorise,
            type_sso,
            metadata_url,
            metadata_xml,
            provider_id_supabase,
            attribut_email,
            password_allowed,
            sso_obligatoire,
            test_statut,
            test_date,
            test_message
        FROM public.tbl_novoskill_sso_config
        WHERE scope_type = %s
          AND id_scope = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
        """,
        (scope_type, id_scope),
    )
    return _row_to_config(cur.fetchone(), scope_type, id_scope, id_owner_gestionnaire, schema_ready=True)


def _payload_to_config(scope_type: str, id_scope: str, id_owner_gestionnaire: Optional[str], payload: SsoConfigPayload) -> dict:
    enabled = _clean_bool(payload.sso_enabled, False)
    password_allowed = _clean_bool(payload.password_allowed, True)
    sso_obligatoire = _clean_bool(payload.sso_obligatoire, False)

    if sso_obligatoire:
        password_allowed = False

    cfg = {
        "scope_type": scope_type,
        "id_scope": id_scope,
        "id_owner_gestionnaire": id_owner_gestionnaire,
        "sso_enabled": enabled,
        "domaine_autorise": _normalize_domain(payload.domaine_autorise),
        "type_sso": _normalize_type_sso(payload.type_sso),
        "metadata_url": _clean_text(payload.metadata_url),
        "metadata_xml": _clean_text(payload.metadata_xml),
        "provider_id_supabase": _clean_text(payload.provider_id_supabase),
        "attribut_email": _normalize_attr_email(payload.attribut_email),
        "password_allowed": password_allowed,
        "sso_obligatoire": sso_obligatoire,
        "test_statut": "non_teste",
        "test_message": None,
    }
    complete, missing = _completion_state(cfg)
    cfg["sso_statut"] = "desactive" if not enabled else ("a_tester" if complete else "configuration")
    cfg["missing_fields"] = missing
    return cfg


def _upsert_config(cur, cfg: dict) -> dict:
    if not _sso_table_exists(cur):
        raise HTTPException(status_code=400, detail="Table SSO absente. Exécute PATCH_SQL_SSO_CONNEXIONS.sql dans Supabase avant d’enregistrer.")

    cur.execute(
        """
        SELECT id_sso_config
        FROM public.tbl_novoskill_sso_config
        WHERE scope_type = %s
          AND id_scope = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (cfg["scope_type"], cfg["id_scope"]),
    )
    row = cur.fetchone() or {}
    existing_id = row.get("id_sso_config")

    if existing_id:
        cur.execute(
            """
            UPDATE public.tbl_novoskill_sso_config
            SET id_owner_gestionnaire = %s,
                sso_enabled = %s,
                sso_statut = %s,
                domaine_autorise = %s,
                type_sso = %s,
                metadata_url = %s,
                metadata_xml = %s,
                provider_id_supabase = %s,
                attribut_email = %s,
                password_allowed = %s,
                sso_obligatoire = %s,
                test_statut = %s,
                test_date = NULL,
                test_message = %s,
                updated_at = NOW()
            WHERE id_sso_config = %s
              AND COALESCE(archive, FALSE) = FALSE
            """,
            (
                cfg.get("id_owner_gestionnaire"), bool(cfg.get("sso_enabled")), cfg.get("sso_statut") or "desactive",
                cfg.get("domaine_autorise"), cfg.get("type_sso") or "saml_2_0", cfg.get("metadata_url"), cfg.get("metadata_xml"),
                cfg.get("provider_id_supabase"), cfg.get("attribut_email") or "email", bool(cfg.get("password_allowed")),
                bool(cfg.get("sso_obligatoire")), cfg.get("test_statut") or "non_teste", cfg.get("test_message"), existing_id,
            ),
        )
    else:
        new_id = str(uuid4())
        cur.execute(
            """
            INSERT INTO public.tbl_novoskill_sso_config (
                id_sso_config, scope_type, id_scope, id_owner_gestionnaire,
                sso_enabled, sso_statut, domaine_autorise, type_sso,
                metadata_url, metadata_xml, provider_id_supabase, attribut_email,
                password_allowed, sso_obligatoire, test_statut, test_message,
                archive, created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW(), NOW())
            """,
            (
                new_id, cfg["scope_type"], cfg["id_scope"], cfg.get("id_owner_gestionnaire"),
                bool(cfg.get("sso_enabled")), cfg.get("sso_statut") or "desactive", cfg.get("domaine_autorise"), cfg.get("type_sso") or "saml_2_0",
                cfg.get("metadata_url"), cfg.get("metadata_xml"), cfg.get("provider_id_supabase"), cfg.get("attribut_email") or "email",
                bool(cfg.get("password_allowed")), bool(cfg.get("sso_obligatoire")), cfg.get("test_statut") or "non_teste", cfg.get("test_message"),
            ),
        )

    return _fetch_config(cur, cfg["scope_type"], cfg["id_scope"], cfg.get("id_owner_gestionnaire"))


def _mark_test(cur, scope_type: str, id_scope: str, id_owner_gestionnaire: Optional[str]) -> dict:
    if not _sso_table_exists(cur):
        raise HTTPException(status_code=400, detail="Table SSO absente. Exécute PATCH_SQL_SSO_CONNEXIONS.sql dans Supabase avant de tester.")

    cfg = _fetch_config(cur, scope_type, id_scope, id_owner_gestionnaire)
    if not cfg.get("sso_enabled"):
        raise HTTPException(status_code=400, detail="Active le SSO avant de tester la configuration.")

    complete, missing = _completion_state(cfg)
    if not complete:
        msg = "Configuration incomplète : " + ", ".join(missing)
        cur.execute(
            """
            UPDATE public.tbl_novoskill_sso_config
            SET test_statut = 'incomplet', sso_statut = 'configuration', test_date = NOW(), test_message = %s, updated_at = NOW()
            WHERE scope_type = %s AND id_scope = %s AND COALESCE(archive, FALSE) = FALSE
            """,
            (msg, scope_type, id_scope),
        )
        cfg = _fetch_config(cur, scope_type, id_scope, id_owner_gestionnaire)
        cfg["test_message"] = msg
        return cfg

    msg = "Configuration SSO complète. Le raccordement Supabase/IdP peut être testé avec un utilisateur pilote."
    cur.execute(
        """
        UPDATE public.tbl_novoskill_sso_config
        SET test_statut = 'valide', sso_statut = 'actif', test_date = NOW(), test_message = %s, updated_at = NOW()
        WHERE scope_type = %s AND id_scope = %s AND COALESCE(archive, FALSE) = FALSE
        """,
        (msg, scope_type, id_scope),
    )
    cfg = _fetch_config(cur, scope_type, id_scope, id_owner_gestionnaire)
    cfg["test_message"] = msg
    return cfg


@router.get("/studio/connexions/owner/{id_owner}")
def get_owner_connexion(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "user")
                return _fetch_config(cur, "owner", oid, None)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/owner error: {e}")


@router.post("/studio/connexions/owner/{id_owner}")
def save_owner_connexion(id_owner: str, payload: SsoConfigPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                out = _upsert_config(cur, _payload_to_config("owner", oid, None, payload))
                conn.commit()
                return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/owner/save error: {e}")


@router.post("/studio/connexions/owner/{id_owner}/test")
def test_owner_connexion(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                out = _mark_test(cur, "owner", oid, None)
                conn.commit()
                return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/owner/test error: {e}")


@router.get("/studio/connexions/client/{id_owner}/{id_ent}")
def get_client_connexion(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")
                return _fetch_config(cur, "entreprise", id_ent, oid)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/client error: {e}")


@router.post("/studio/connexions/client/{id_owner}/{id_ent}")
def save_client_connexion(id_owner: str, id_ent: str, payload: SsoConfigPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")
                out = _upsert_config(cur, _payload_to_config("entreprise", id_ent, oid, payload))
                conn.commit()
                return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/client/save error: {e}")


@router.post("/studio/connexions/client/{id_owner}/{id_ent}/test")
def test_client_connexion(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "supervisor")
                if not _structure_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Structure introuvable.")
                out = _mark_test(cur, "entreprise", id_ent, oid)
                conn.commit()
                return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/connexions/client/test error: {e}")
