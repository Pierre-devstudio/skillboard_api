from fastapi import APIRouter, HTTPException, Request
from typing import Optional, Any
from psycopg.rows import dict_row
import hashlib
import json

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
