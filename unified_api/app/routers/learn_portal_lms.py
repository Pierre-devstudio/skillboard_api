from fastapi import APIRouter, HTTPException, Request
from typing import Optional, Any
from psycopg.rows import dict_row
from pydantic import BaseModel
import hashlib
import json
import re
from html import unescape

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import learn_require_user
from app.routers.learn_portal_informations import learn_lms_fetch_active_config
from app.routers.learn_portal_formations import (
    _build_formation_lms_html,
    _fetch_form_detail,
    _learn_require_min_role,
    _learn_require_profile,
    _role_rank,
)
from app.learn_connectors_lms import lara as lara_connector


router = APIRouter()

class LmsRemoteLinkPayload(BaseModel):
    external_id: str
    external_url: Optional[str] = None
    remote_title: Optional[str] = None
    remote_code: Optional[str] = None
    custom_fields: Optional[dict] = None

def _lms_html_hash(html_payload: str) -> str:
    return hashlib.sha256(str(html_payload or "").encode("utf-8")).hexdigest()


def _lms_publication_row(cur, oid: str, id_form: str, id_lms_config: str) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          id_publication,
          id_owner,
          id_form,
          id_lms_config,
          provider_code,
          external_id,
          external_url,
          last_sync_at,
          sync_status,
          sync_error,
          html_hash,
          archive,
          created_at AS date_creation,
          updated_at AS date_modification
        FROM public.tbl_learn_lms_publication
        WHERE id_owner = %s
          AND id_form = %s
          AND id_lms_config = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid, id_form, id_lms_config),
    )

    return cur.fetchone()

def _lms_norm_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _lms_local_rows_for_compare(cur, oid: str, id_lms_config: str) -> list:
    cur.execute(
        """
        SELECT
          ff.id_form,
          ff.code,
          ff.titre,
          COALESCE(ff.masque, FALSE) AS masque,
          COALESCE(ff.archive, FALSE) AS archive,
          p.external_id,
          p.external_url,
          p.sync_status,
          p.last_sync_at,
          p.html_hash
        FROM public.tbl_fiche_formation ff
        LEFT JOIN public.tbl_learn_lms_publication p
          ON p.id_owner = ff.id_owner
         AND p.id_form = ff.id_form
         AND p.id_lms_config = %s
         AND COALESCE(p.archive, FALSE) = FALSE
        WHERE ff.id_owner = %s
        """,
        (id_lms_config, oid),
    )

    return cur.fetchall() or []


def _lms_compare_remote_with_local(remote_items: list, local_rows: list) -> tuple[list, list]:
    by_code = {}
    by_external = {}

    for row in local_rows or []:
        code_key = _lms_norm_key(row.get("code"))
        ext_key = _lms_norm_key(row.get("external_id"))

        if code_key:
            by_code[code_key] = row

        if ext_key:
            by_external[ext_key] = row

    remote_only = []
    linked = []

    for remote in remote_items or []:
        code_key = _lms_norm_key(remote.get("code_form") or remote.get("code"))
        ext_key = _lms_norm_key(remote.get("external_id"))

        local = None

        if code_key and code_key in by_code:
            local = by_code[code_key]
        elif ext_key and ext_key in by_external:
            local = by_external[ext_key]

        if local:
            item = dict(remote)
            item["match_status"] = "linked_archived" if (local.get("archive") or local.get("masque")) else "linked"
            item["local_id_form"] = local.get("id_form")
            item["local_code"] = local.get("code")
            item["local_titre"] = local.get("titre")
            item["local_sync_status"] = local.get("sync_status")
            linked.append(item)
            continue

        remote_only.append({
            "source_kind": "lms_only",
            "provider_code": "lara",
            "id_form": None,
            "code": remote.get("code_form") or remote.get("code") or "LMS",
            "titre": remote.get("titre") or "Formation LMS",
            "domaine_titre_court": "LMS",
            "domaine_titre": "Lära",
            "fournisseur_nom": "Lära",
            "etat": "LMS uniquement",
            "masque": False,
            "archive": False,
            "nb_plans": 0,
            "external_id": remote.get("external_id"),
            "external_url": remote.get("external_url"),
            "visibility_label": remote.get("visibility_label"),
            "custom_fields": remote.get("custom_fields") or {},
            "match_status": "remote_only",
        })

    return remote_only, linked

def _lms_write_publication_success(
    cur,
    oid: str,
    id_form: str,
    id_lms_config: str,
    provider_code: str,
    external_id: str,
    external_url: str,
    html_hash: str,
) -> dict:
    row = _lms_publication_row(cur, oid, id_form, id_lms_config)

    if row:
        cur.execute(
            """
            UPDATE public.tbl_learn_lms_publication
            SET provider_code = %s,
                external_id = %s,
                external_url = %s,
                last_sync_at = NOW(),
                sync_status = 'synced',
                sync_error = NULL,
                html_hash = %s,
                archive = FALSE,
                updated_at = NOW()
            WHERE id_publication = %s
              AND id_owner = %s
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                provider_code,
                external_id,
                external_url or row.get("external_url"),
                html_hash,
                row.get("id_publication"),
                oid,
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO public.tbl_learn_lms_publication
              (
                id_publication,
                id_owner,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                last_sync_at,
                sync_status,
                sync_error,
                html_hash,
                archive,
                created_at,
                updated_at
              )
            VALUES
              (
                gen_random_uuid()::text,
                %s, %s, %s, %s,
                %s, %s,
                NOW(),
                'synced',
                NULL,
                %s,
                FALSE,
                NOW(),
                NOW()
              )
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                oid,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                html_hash,
            ),
        )

    return cur.fetchone() or {}

def _lms_publication_row_by_external(
    cur,
    oid: str,
    id_lms_config: str,
    external_id: str,
) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          id_publication,
          id_owner,
          id_form,
          id_lms_config,
          provider_code,
          external_id,
          external_url,
          last_sync_at,
          sync_status,
          sync_error,
          html_hash,
          archive,
          created_at AS date_creation,
          updated_at AS date_modification
        FROM public.tbl_learn_lms_publication
        WHERE id_owner = %s
          AND id_lms_config = %s
          AND external_id = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid, id_lms_config, external_id),
    )

    return cur.fetchone()


def _lms_write_publication_linked(
    cur,
    oid: str,
    id_form: str,
    id_lms_config: str,
    provider_code: str,
    external_id: str,
    external_url: Optional[str],
    html_hash: str,
) -> dict:
    row = _lms_publication_row(cur, oid, id_form, id_lms_config)

    if row:
        cur.execute(
            """
            UPDATE public.tbl_learn_lms_publication
            SET provider_code = %s,
                external_id = %s,
                external_url = COALESCE(%s, external_url),
                last_sync_at = NOW(),
                sync_status = 'linked',
                sync_error = NULL,
                html_hash = %s,
                archive = FALSE,
                updated_at = NOW()
            WHERE id_publication = %s
              AND id_owner = %s
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                provider_code,
                external_id,
                external_url,
                html_hash,
                row.get("id_publication"),
                oid,
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO public.tbl_learn_lms_publication
              (
                id_publication,
                id_owner,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                last_sync_at,
                sync_status,
                sync_error,
                html_hash,
                archive,
                created_at,
                updated_at
              )
            VALUES
              (
                gen_random_uuid()::text,
                %s, %s, %s, %s,
                %s, %s,
                NOW(),
                'linked',
                NULL,
                %s,
                FALSE,
                NOW(),
                NOW()
              )
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                oid,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                html_hash,
            ),
        )

    return cur.fetchone() or {}

def _lms_write_publication_error(
    cur,
    oid: str,
    id_form: str,
    id_lms_config: str,
    provider_code: str,
    external_id: Optional[str],
    html_hash: str,
    error_value: Any,
) -> dict:
    try:
        err_txt = json.dumps(error_value, ensure_ascii=False)[:4000]
    except Exception:
        err_txt = str(error_value or "")[:4000]

    row = _lms_publication_row(cur, oid, id_form, id_lms_config)

    if row:
        cur.execute(
            """
            UPDATE public.tbl_learn_lms_publication
            SET provider_code = %s,
                external_id = COALESCE(%s, external_id),
                last_sync_at = NOW(),
                sync_status = 'error',
                sync_error = %s,
                html_hash = %s,
                archive = FALSE,
                updated_at = NOW()
            WHERE id_publication = %s
              AND id_owner = %s
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                provider_code,
                external_id,
                err_txt,
                html_hash,
                row.get("id_publication"),
                oid,
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO public.tbl_learn_lms_publication
              (
                id_publication,
                id_owner,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                last_sync_at,
                sync_status,
                sync_error,
                html_hash,
                archive,
                created_at,
                updated_at
              )
            VALUES
              (
                gen_random_uuid()::text,
                %s, %s, %s, %s,
                %s, NULL,
                NOW(),
                'error',
                %s,
                %s,
                FALSE,
                NOW(),
                NOW()
              )
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              html_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                oid,
                id_form,
                id_lms_config,
                provider_code,
                external_id,
                err_txt,
                html_hash,
            ),
        )

    return cur.fetchone() or {}

@router.get("/learn/formations/{id_effectif}/lms/remote")
def learn_formations_lms_remote(
    id_effectif: str,
    request: Request,
    q: str = "",
    limit: int = 500,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)

                if not cfg or cfg.get("provider_code") != "lara":
                    return {
                        "configured": False,
                        "provider_code": "manual",
                        "items": [],
                        "linked_items": [],
                        "remote_count": 0,
                        "remote_only_count": 0,
                        "linked_count": 0,
                        "can_sync": _role_rank(profile.get("role_code")) >= 2,
                        "message": "Aucun connecteur LMS actif.",
                    }

                id_lms_config = str(cfg.get("id_lms_config") or "").strip()
                if not id_lms_config:
                    raise HTTPException(status_code=400, detail="Configuration LMS invalide.")

                remote_result = lara_connector.list_remote_formations(
                    cfg=cfg,
                    q=q,
                    limit=max(1, min(int(limit or 500), 1000)),
                )

                if not remote_result.get("ok"):
                    raise HTTPException(status_code=400, detail={
                        "message": "Récupération des formations Lära impossible.",
                        "response": remote_result.get("response") or remote_result,
                    })

                local_rows = _lms_local_rows_for_compare(cur, oid, id_lms_config)

        remote_items = remote_result.get("items") or []
        remote_only, linked = _lms_compare_remote_with_local(remote_items, local_rows)

        return {
            "configured": True,
            "provider_code": "lara",
            "provider_label": "Lära",
            "code_field": remote_result.get("code_field"),
            "workspace_type_id": remote_result.get("workspace_type_id"),
            "items": remote_only,
            "linked_items": linked,
            "remote_count": len(remote_items),
            "remote_only_count": len(remote_only),
            "linked_count": len(linked),
            "can_sync": _role_rank(profile.get("role_code")) >= 2,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms remote error: {e}")

def _lms_strip_html(value: Any) -> str:
    txt = str(value or "")

    if not txt:
        return ""

    txt = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", txt)
    txt = re.sub(r"(?i)<br\s*/?>", "\n", txt)
    txt = re.sub(r"(?i)</(p|div|li|h1|h2|h3|h4|h5|h6|section|article)>", "\n", txt)
    txt = re.sub(r"(?s)<[^>]+>", " ", txt)
    txt = unescape(txt)
    txt = txt.replace("\xa0", " ")

    lines = []
    for line in txt.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if clean:
            lines.append(clean)

    return "\n".join(lines).strip()


def _lms_clip(value: Any, max_len: int) -> str:
    txt = str(value or "").strip()

    if not txt:
        return ""

    txt = re.sub(r"\s+", " ", txt).strip()

    if len(txt) <= max_len:
        return txt

    return txt[:max_len].rstrip()


def _lms_remote_to_preview(remote: dict) -> dict:
    description_html = remote.get("description") or ""
    description_text = _lms_strip_html(description_html)
    short_description = str(remote.get("short_description") or "").strip()

    presentation_src = short_description or description_text

    code_form = str(remote.get("code_form") or remote.get("code") or "").strip()
    titre = str(remote.get("titre") or "Formation LMS").strip()

    warnings = []

    if not code_form:
        warnings.append("Aucun Code_form détecté dans les champs personnalisés Lära.")

    if not description_html:
        warnings.append("Aucune description détaillée exploitable n’a été récupérée depuis Lära.")

    draft = {
        "titre": _lms_clip(titre, 90),
        "etat": "à valider",
        "type_formation": "Non Certifiante",
        "presentation": _lms_clip(presentation_src, 625),
        "objectifs": "",
        "public_cible": "",
        "duree": None,
        "tarif_mini": None,
        "code_lms_detecte": code_form,
        "description_text": _lms_clip(description_text, 2500),
    }

    return {
        "remote": {
            "provider_code": "lara",
            "provider_label": "Lära",
            "external_id": remote.get("external_id"),
            "external_url": remote.get("external_url"),
            "code": code_form,
            "code_field": remote.get("code_field"),
            "titre": titre,
            "visibility_label": remote.get("visibility_label"),
            "updated_at": remote.get("updated_at"),
            "created_at": remote.get("created_at"),
            "custom_fields": remote.get("custom_fields") or {},
            "description_html": description_html,
            "description_text": description_text,
        },
        "draft": draft,
        "warnings": warnings,
    }

@router.get("/learn/formations/{id_effectif}/lms/remote/{external_id}/preview")
def learn_formations_lms_remote_preview(
    id_effectif: str,
    external_id: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        ext = str(external_id or "").strip()
        if not ext:
            raise HTTPException(status_code=400, detail="Identifiant Lära manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)

                if not cfg or cfg.get("provider_code") != "lara":
                    raise HTTPException(status_code=400, detail="Aucun connecteur Lära actif.")

                remote_result = lara_connector.get_remote_formation(
                    cfg=cfg,
                    external_id=ext,
                )

                if not remote_result.get("ok"):
                    raise HTTPException(status_code=400, detail={
                        "message": "Lecture de la formation Lära impossible.",
                        "response": remote_result.get("response") or remote_result,
                    })

                remote = remote_result.get("item") or {}

        preview = _lms_remote_to_preview(remote)

        return {
            "ok": True,
            "provider_code": "lara",
            "provider_label": "Lära",
            "external_id": ext,
            "preview": preview,
            "can_import": _role_rank(profile.get("role_code")) >= 2,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms remote preview error: {e}")

@router.post("/learn/formations/{id_effectif}/{id_form}/lms/link_remote")
def learn_formation_lms_link_remote(
    id_effectif: str,
    id_form: str,
    payload: LmsRemoteLinkPayload,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        external_id = str(payload.external_id or "").strip()

        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        if not external_id:
            raise HTTPException(status_code=400, detail="Identifiant LMS manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)

                if not cfg or cfg.get("provider_code") != "lara":
                    raise HTTPException(status_code=400, detail="Aucun connecteur Lära actif.")

                id_lms_config = str(cfg.get("id_lms_config") or "").strip()
                if not id_lms_config:
                    raise HTTPException(status_code=400, detail="Configuration LMS invalide.")

                existing_external = _lms_publication_row_by_external(
                    cur,
                    oid,
                    id_lms_config,
                    external_id,
                )

                if existing_external and str(existing_external.get("id_form") or "") != fid:
                    raise HTTPException(
                        status_code=409,
                        detail="Cette formation Lära est déjà rattachée à une autre fiche Novoskill.",
                    )

                form = _fetch_form_detail(cur, oid, fid)
                html_payload = _build_formation_lms_html(form)
                html_hash = _lms_html_hash(html_payload)

                saved = _lms_write_publication_linked(
                    cur,
                    oid,
                    fid,
                    id_lms_config,
                    "lara",
                    external_id,
                    payload.external_url,
                    html_hash,
                )

                conn.commit()

        return {
            "ok": True,
            "provider_code": "lara",
            "external_id": external_id,
            "external_url": payload.external_url,
            "publication": saved,
            "message": "Formation Novoskill rattachée à la formation Lära.",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms link remote error: {e}")

@router.get("/learn/formations/{id_effectif}/{id_form}/lms/status")
def learn_formation_lms_status(id_effectif: str, id_form: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=False)
                if not cfg or cfg.get("provider_code") != "lara":
                    return {
                        "configured": False,
                        "provider_code": "manual",
                        "published": False,
                        "sync_status": "not_configured",
                        "message": "Aucun connecteur LMS actif.",
                    }

                form = _fetch_form_detail(cur, oid, fid)
                html_payload = _build_formation_lms_html(form)
                current_hash = _lms_html_hash(html_payload)

                row = _lms_publication_row(cur, oid, fid, cfg.get("id_lms_config"))

        published = bool(row and row.get("external_id"))
        sync_status = (row or {}).get("sync_status") or "jamais_sync"
        outdated = bool(row and row.get("html_hash") and row.get("html_hash") != current_hash)

        if outdated and sync_status == "synced":
            sync_status = "outdated"

        return {
            "configured": True,
            "provider_code": "lara",
            "provider_label": "Lära",
            "published": published,
            "external_id": (row or {}).get("external_id"),
            "external_url": (row or {}).get("external_url"),
            "last_sync_at": (row or {}).get("last_sync_at"),
            "sync_status": sync_status,
            "sync_error": (row or {}).get("sync_error"),
            "outdated": outdated,
            "can_publish": _role_rank(profile.get("role_code")) >= 2,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms status error: {e}")


@router.post("/learn/formations/{id_effectif}/{id_form}/lms/publish")
def learn_formation_lms_publish(id_effectif: str, id_form: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                _learn_require_min_role(profile, "supervisor")
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)
                if not cfg or cfg.get("provider_code") != "lara":
                    raise HTTPException(status_code=400, detail="Aucun connecteur Lära actif.")

                id_lms_config = str(cfg.get("id_lms_config") or "").strip()
                if not id_lms_config:
                    raise HTTPException(status_code=400, detail="Configuration LMS invalide.")

                form = _fetch_form_detail(cur, oid, fid)
                html_payload = _build_formation_lms_html(form)
                html_hash = _lms_html_hash(html_payload)
                existing = _lms_publication_row(cur, oid, fid, id_lms_config)

                publish_result = lara_connector.publish_formation(
                    form=form,
                    html_payload=html_payload,
                    cfg=cfg,
                    existing_publication=existing,
                )

                if not publish_result.get("ok"):
                    saved = _lms_write_publication_error(
                        cur,
                        oid,
                        fid,
                        id_lms_config,
                        "lara",
                        publish_result.get("external_id"),
                        html_hash,
                        publish_result.get("response") or publish_result,
                    )
                    conn.commit()

                    raise HTTPException(status_code=400, detail={
                        "message": "Publication Lära impossible.",
                        "publication": saved,
                        "response": publish_result.get("response") or publish_result,
                    })

                external_id = publish_result.get("external_id")
                external_url = publish_result.get("external_url")

                saved = _lms_write_publication_success(
                    cur,
                    oid,
                    fid,
                    id_lms_config,
                    "lara",
                    external_id,
                    external_url,
                    html_hash,
                )

                conn.commit()

        return {
            "ok": True,
            "provider_code": "lara",
            "action": publish_result.get("action"),
            "action_label": publish_result.get("action_label"),
            "external_id": external_id,
            "external_url": external_url,
            "publication": saved,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms publish error: {e}")
