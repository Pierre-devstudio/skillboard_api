from fastapi import APIRouter, HTTPException, Request
from typing import Optional, Any
from psycopg.rows import dict_row
from pydantic import BaseModel
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from html import unescape

from app.routers.skills_portal_common import get_conn
from app.routers.learn_portal_common import learn_require_user
from app.routers.learn_portal_informations import learn_lms_fetch_active_config
from app.routers.learn_portal_formations import (
    _build_formation_lms_html,
    _fetch_form_detail,
    _fetch_plan_detail,
    _next_plan_code,
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

def _lms_norm_compare(value: Any) -> str:
    txt = str(value or "").strip().lower()
    txt = re.sub(r"\s+", " ", txt)
    return txt


def _lms_parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None

    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value or "").strip()
        if not raw:
            return None

        raw = raw.replace("Z", "+00:00")

        try:
            dt = datetime.fromisoformat(raw)
        except Exception:
            return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return dt.astimezone(timezone.utc)


def _lms_remote_diff_reasons(remote: dict, local: dict) -> list:
    reasons = []

    remote_code = _lms_norm_compare(remote.get("code_form") or remote.get("code"))
    local_code = _lms_norm_compare(local.get("code"))

    if remote_code and local_code and remote_code != local_code:
        reasons.append("code")

    remote_title = _lms_norm_compare(remote.get("titre"))
    local_title = _lms_norm_compare(local.get("titre"))

    if remote_title and local_title and remote_title != local_title:
        reasons.append("titre")

    remote_dt = _lms_parse_dt(remote.get("updated_at"))
    local_sync_dt = _lms_parse_dt(local.get("last_sync_at"))

    if remote_dt and local_sync_dt and remote_dt > local_sync_dt:
        reasons.append("date_lms")

    return reasons


def _lms_is_local_sync_active(local: dict) -> bool:
    return bool(
        local
        and local.get("external_id")
        and str(local.get("sync_status") or "").strip().lower() in ("synced", "linked", "outdated")
    )

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

            diff_reasons = _lms_remote_diff_reasons(remote, local)

            if local.get("archive") or local.get("masque"):
                match_status = "linked_archived"
            elif diff_reasons:
                match_status = "remote_changed"
            else:
                match_status = "linked"

            item["match_status"] = match_status
            item["sync_diff_reasons"] = diff_reasons
            item["local_id_form"] = local.get("id_form")
            item["local_code"] = local.get("code")
            item["local_titre"] = local.get("titre")
            item["local_sync_status"] = local.get("sync_status")
            item["local_lms_external_id"] = local.get("external_id")
            item["local_lms_external_url"] = local.get("external_url")
            item["lms_sync_active"] = _lms_is_local_sync_active(local)
            item["type_lms_id"] = remote.get("type_lms_id")
            item["type_lms_label"] = remote.get("type_lms_label")

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
            "type_lms_id": remote.get("type_lms_id"),
            "type_lms_label": remote.get("type_lms_label"),
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
            "recovery_type_ids": remote_result.get("recovery_type_ids") or [],
            "workspace_types": remote_result.get("workspace_types") or [],
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

def _lms_plan_payload_hash(plan: dict) -> str:
    clean = {
        "id_plan_peda": plan.get("id_plan_peda"),
        "codification": plan.get("codification"),
        "titre": plan.get("titre"),
        "modalite_generale": plan.get("modalite_generale"),
        "commentaire": plan.get("commentaire"),
        "blocs": [
            {
                "id_bloc_peda": b.get("id_bloc_peda"),
                "titre": b.get("titre"),
                "objectif": b.get("objectif"),
                "duree": b.get("duree"),
                "modalite_intervention": b.get("modalite_intervention"),
                "observations": b.get("observations"),
                "position": b.get("position"),
            }
            for b in (plan.get("blocs") or [])
        ],
    }

    return hashlib.sha256(
        json.dumps(clean, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _lms_plan_publication_row(
    cur,
    oid: str,
    id_form: str,
    id_plan_peda: str,
    id_lms_config: str,
) -> Optional[dict]:
    cur.execute(
        """
        SELECT
          id_publication,
          id_owner,
          id_form,
          id_plan_peda,
          id_lms_config,
          provider_code,
          external_id,
          external_url,
          last_sync_at,
          sync_status,
          sync_error,
          payload_hash,
          archive,
          created_at AS date_creation,
          updated_at AS date_modification
        FROM public.tbl_learn_lms_plan_publication
        WHERE id_owner = %s
          AND id_form = %s
          AND id_plan_peda = %s
          AND id_lms_config = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid, id_form, id_plan_peda, id_lms_config),
    )

    return cur.fetchone()


def _lms_plan_publication_row_by_external(
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
          id_plan_peda,
          id_lms_config,
          provider_code,
          external_id,
          external_url,
          last_sync_at,
          sync_status,
          sync_error,
          payload_hash,
          archive,
          created_at AS date_creation,
          updated_at AS date_modification
        FROM public.tbl_learn_lms_plan_publication
        WHERE id_owner = %s
          AND id_lms_config = %s
          AND external_id = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid, id_lms_config, external_id),
    )

    return cur.fetchone()


def _lms_plan_publications_for_form(
    cur,
    oid: str,
    id_form: str,
    id_lms_config: str,
) -> list:
    cur.execute(
        """
        SELECT
          id_publication,
          id_owner,
          id_form,
          id_plan_peda,
          id_lms_config,
          provider_code,
          external_id,
          external_url,
          last_sync_at,
          sync_status,
          sync_error,
          payload_hash,
          archive,
          created_at AS date_creation,
          updated_at AS date_modification
        FROM public.tbl_learn_lms_plan_publication
        WHERE id_owner = %s
          AND id_form = %s
          AND id_lms_config = %s
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (oid, id_form, id_lms_config),
    )

    return cur.fetchall() or []


def _lms_write_plan_publication_success(
    cur,
    oid: str,
    id_form: str,
    id_plan_peda: str,
    id_lms_config: str,
    provider_code: str,
    external_id: str,
    external_url: Optional[str],
    payload_hash: str,
) -> dict:
    row = _lms_plan_publication_row(cur, oid, id_form, id_plan_peda, id_lms_config)

    if row:
        cur.execute(
            """
            UPDATE public.tbl_learn_lms_plan_publication
            SET provider_code = %s,
                external_id = %s,
                external_url = COALESCE(%s, external_url),
                last_sync_at = NOW(),
                sync_status = 'synced',
                sync_error = NULL,
                payload_hash = %s,
                archive = FALSE,
                updated_at = NOW()
            WHERE id_publication = %s
              AND id_owner = %s
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_plan_peda,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              payload_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                provider_code,
                external_id,
                external_url,
                payload_hash,
                row.get("id_publication"),
                oid,
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO public.tbl_learn_lms_plan_publication
              (
                id_publication,
                id_owner,
                id_form,
                id_plan_peda,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                last_sync_at,
                sync_status,
                sync_error,
                payload_hash,
                archive,
                created_at,
                updated_at
              )
            VALUES
              (
                gen_random_uuid()::text,
                %s, %s, %s, %s,
                %s, %s, %s,
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
              id_plan_peda,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              payload_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                oid,
                id_form,
                id_plan_peda,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                payload_hash,
            ),
        )

    return cur.fetchone() or {}


def _lms_write_plan_publication_error(
    cur,
    oid: str,
    id_form: str,
    id_plan_peda: str,
    id_lms_config: str,
    provider_code: str,
    external_id: Optional[str],
    payload_hash: str,
    error_value: Any,
) -> dict:
    try:
        err_txt = json.dumps(error_value, ensure_ascii=False)[:4000]
    except Exception:
        err_txt = str(error_value or "")[:4000]

    row = _lms_plan_publication_row(cur, oid, id_form, id_plan_peda, id_lms_config)

    if row:
        cur.execute(
            """
            UPDATE public.tbl_learn_lms_plan_publication
            SET provider_code = %s,
                external_id = COALESCE(%s, external_id),
                last_sync_at = NOW(),
                sync_status = 'error',
                sync_error = %s,
                payload_hash = %s,
                archive = FALSE,
                updated_at = NOW()
            WHERE id_publication = %s
              AND id_owner = %s
            RETURNING
              id_publication,
              id_owner,
              id_form,
              id_plan_peda,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              payload_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                provider_code,
                external_id,
                err_txt,
                payload_hash,
                row.get("id_publication"),
                oid,
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO public.tbl_learn_lms_plan_publication
              (
                id_publication,
                id_owner,
                id_form,
                id_plan_peda,
                id_lms_config,
                provider_code,
                external_id,
                external_url,
                last_sync_at,
                sync_status,
                sync_error,
                payload_hash,
                archive,
                created_at,
                updated_at
              )
            VALUES
              (
                gen_random_uuid()::text,
                %s, %s, %s, %s,
                %s, %s, NULL,
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
              id_plan_peda,
              id_lms_config,
              provider_code,
              external_id,
              external_url,
              last_sync_at,
              sync_status,
              sync_error,
              payload_hash,
              archive,
              created_at AS date_creation,
              updated_at AS date_modification
            """,
            (
                oid,
                id_form,
                id_plan_peda,
                id_lms_config,
                provider_code,
                external_id,
                err_txt,
                payload_hash,
            ),
        )

    return cur.fetchone() or {}


def _lms_plan_rows_for_form(cur, oid: str, id_form: str) -> list:
    cur.execute(
        """
        SELECT
          p.id_plan_peda,
          p.codification,
          p.titre,
          p.commentaire,
          p.modalite_generale,
          COALESCE(p.archive, FALSE) AS archive
        FROM public.tbl_plan_pedagogique p
        WHERE p.id_owner = %s
          AND p.id_form = %s
          AND COALESCE(p.archive, FALSE) = FALSE
        ORDER BY lower(COALESCE(p.codification, '')), lower(COALESCE(p.titre, ''))
        """,
        (oid, id_form),
    )

    return cur.fetchall() or []


@router.get("/learn/formations/{id_effectif}/{id_form}/lms/plans")
def learn_formation_lms_plans(id_effectif: str, id_form: str, request: Request):
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

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=True)

                if not cfg or cfg.get("provider_code") != "lara":
                    return {
                        "configured": False,
                        "provider_code": "manual",
                        "published": False,
                        "sessions": [],
                        "plans_publications": [],
                        "can_sync": _role_rank(profile.get("role_code")) >= 2,
                        "message": "Aucun connecteur LMS actif.",
                    }

                id_lms_config = str(cfg.get("id_lms_config") or "").strip()
                if not id_lms_config:
                    raise HTTPException(status_code=400, detail="Configuration LMS invalide.")

                form_pub = _lms_publication_row(cur, oid, fid, id_lms_config)
                plans = _lms_plan_rows_for_form(cur, oid, fid)
                plan_pubs = _lms_plan_publications_for_form(cur, oid, fid, id_lms_config)

        if not form_pub or not form_pub.get("external_id"):
            return {
                "configured": True,
                "provider_code": "lara",
                "provider_label": "Lära",
                "published": False,
                "sessions": [],
                "plans_publications": [],
                "can_sync": _role_rank(profile.get("role_code")) >= 2,
                "message": "Formation non synchronisée avec Lära.",
            }

        sessions_result = lara_connector.list_plan_sessions(cfg, form_pub.get("external_id"))

        if not sessions_result.get("ok"):
            raise HTTPException(status_code=400, detail={
                "message": "Lecture des sessions Lära impossible.",
                "response": sessions_result.get("response") or sessions_result,
            })

        pubs_by_external = {
            str(p.get("external_id") or "").strip(): p
            for p in plan_pubs
            if str(p.get("external_id") or "").strip()
        }

        plans_by_id = {
            str(p.get("id_plan_peda") or "").strip(): p
            for p in plans
            if str(p.get("id_plan_peda") or "").strip()
        }

        sessions = []

        for s in sessions_result.get("items") or []:
            ext = str(s.get("external_id") or "").strip()
            pub = pubs_by_external.get(ext)
            plan = plans_by_id.get(str((pub or {}).get("id_plan_peda") or "").strip()) if pub else None

            sessions.append({
                "source_kind": "lara_session",
                "provider_code": "lara",
                "external_id": ext,
                "external_url": s.get("external_url"),
                "name": s.get("name") or "Session Lära",
                "start_date": s.get("start_date"),
                "end_date": s.get("end_date"),
                "last_modification_date": s.get("last_modification_date"),
                "linked": bool(pub and plan),
                "id_plan_peda": (pub or {}).get("id_plan_peda"),
                "codification": (plan or {}).get("codification"),
                "plan_titre": (plan or {}).get("titre"),
                "sync_status": (pub or {}).get("sync_status"),
                "last_sync_at": (pub or {}).get("last_sync_at"),
            })

        return {
            "configured": True,
            "provider_code": "lara",
            "provider_label": "Lära",
            "published": True,
            "formation_external_id": form_pub.get("external_id"),
            "formation_external_url": form_pub.get("external_url"),
            "sessions": sessions,
            "plans_publications": plan_pubs,
            "can_sync": _role_rank(profile.get("role_code")) >= 2,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms plans error: {e}")


@router.post("/learn/formations/{id_effectif}/{id_form}/lms/sessions/{external_id}/create_plan")
def learn_formation_lms_session_create_plan(
    id_effectif: str,
    id_form: str,
    external_id: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        ext = (external_id or "").strip()

        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        if not ext:
            raise HTTPException(status_code=400, detail="Identifiant session Lära manquant.")

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

                form_pub = _lms_publication_row(cur, oid, fid, id_lms_config)

                if not form_pub or not form_pub.get("external_id"):
                    raise HTTPException(status_code=400, detail="Formation non synchronisée avec Lära.")

                existing_pub = _lms_plan_publication_row_by_external(cur, oid, id_lms_config, ext)

                if existing_pub:
                    if str(existing_pub.get("id_form") or "").strip() != fid:
                        raise HTTPException(
                            status_code=409,
                            detail="Cette session Lära est déjà rattachée à une autre formation Novoskill.",
                        )

                    plan = _fetch_plan_detail(cur, oid, fid, existing_pub.get("id_plan_peda"))

                    return {
                        "ok": True,
                        "already_linked": True,
                        "id_plan_peda": existing_pub.get("id_plan_peda"),
                        "item": plan,
                    }

                sessions_result = lara_connector.list_plan_sessions(cfg, form_pub.get("external_id"))

                if not sessions_result.get("ok"):
                    raise HTTPException(status_code=400, detail={
                        "message": "Lecture des sessions Lära impossible.",
                        "response": sessions_result.get("response") or sessions_result,
                    })

                remote = None

                for s in sessions_result.get("items") or []:
                    if str(s.get("external_id") or "").strip() == ext:
                        remote = s
                        break

                if not remote:
                    raise HTTPException(status_code=404, detail="Session Lära introuvable pour cette formation.")

                pid = str(uuid.uuid4())
                code = _next_plan_code(cur, oid)
                titre = str(remote.get("name") or "Plan Lära").strip()[:500]

                cur.execute(
                    """
                    INSERT INTO public.tbl_plan_pedagogique
                      (
                        id_plan_peda,
                        id_owner,
                        id_form,
                        codification,
                        titre,
                        commentaire,
                        modalite_generale,
                        archive,
                        date_creation,
                        date_modification
                      )
                    VALUES
                      (
                        %s, %s, %s,
                        %s, %s, %s, NULL,
                        FALSE,
                        NOW(),
                        NOW()
                      )
                    """,
                    (
                        pid,
                        oid,
                        fid,
                        code,
                        titre,
                        "Plan créé depuis une session Lära.",
                    ),
                )

                plan = _fetch_plan_detail(cur, oid, fid, pid)
                plan_hash = _lms_plan_payload_hash(plan)

                saved = _lms_write_plan_publication_success(
                    cur,
                    oid,
                    fid,
                    pid,
                    id_lms_config,
                    "lara",
                    ext,
                    remote.get("external_url"),
                    plan_hash,
                )

                conn.commit()

        return {
            "ok": True,
            "already_linked": False,
            "id_plan_peda": pid,
            "codification": code,
            "publication": saved,
            "item": plan,
            "message": "Session Lära ajoutée comme plan Novoskill.",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations lms session create plan error: {e}")


@router.get("/learn/formations/{id_effectif}/{id_form}/plans/{id_plan_peda}/lms/status")
def learn_formation_plan_lms_status(
    id_effectif: str,
    id_form: str,
    id_plan_peda: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        pid = (id_plan_peda or "").strip()

        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        if not pid:
            raise HTTPException(status_code=400, detail="id_plan_peda manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile = _learn_require_profile(cur, u, id_effectif)
                oid = (profile.get("id_owner") or "").strip()

                cfg = learn_lms_fetch_active_config(cur, oid, with_secret=False)

                if not cfg or cfg.get("provider_code") != "lara":
                    return {
                        "configured": False,
                        "provider_code": "manual",
                        "formation_published": False,
                        "published": False,
                        "message": "Aucun connecteur LMS actif.",
                    }

                id_lms_config = str(cfg.get("id_lms_config") or "").strip()
                if not id_lms_config:
                    raise HTTPException(status_code=400, detail="Configuration LMS invalide.")

                form_pub = _lms_publication_row(cur, oid, fid, id_lms_config)
                plan = _fetch_plan_detail(cur, oid, fid, pid)
                plan_hash = _lms_plan_payload_hash(plan)
                row = _lms_plan_publication_row(cur, oid, fid, pid, id_lms_config)

        if not form_pub or not form_pub.get("external_id"):
            return {
                "configured": True,
                "provider_code": "lara",
                "formation_published": False,
                "published": False,
                "message": "Formation non synchronisée avec Lära.",
            }

        if not row or not row.get("external_id"):
            return {
                "configured": True,
                "provider_code": "lara",
                "formation_published": True,
                "published": False,
                "message": "Plan non synchronisé avec Lära.",
            }

        outdated = bool(row.get("payload_hash") and row.get("payload_hash") != plan_hash)

        return {
            "configured": True,
            "provider_code": "lara",
            "formation_published": True,
            "published": True,
            "external_id": row.get("external_id"),
            "external_url": row.get("external_url"),
            "sync_status": "outdated" if outdated else row.get("sync_status"),
            "sync_error": row.get("sync_error"),
            "last_sync_at": row.get("last_sync_at"),
            "outdated": outdated,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations plan lms status error: {e}")


@router.post("/learn/formations/{id_effectif}/{id_form}/plans/{id_plan_peda}/lms/publish")
def learn_formation_plan_lms_publish(
    id_effectif: str,
    id_form: str,
    id_plan_peda: str,
    request: Request,
):
    auth = request.headers.get("Authorization", "")
    u = learn_require_user(auth)

    try:
        fid = (id_form or "").strip()
        pid = (id_plan_peda or "").strip()

        if not fid:
            raise HTTPException(status_code=400, detail="id_form manquant.")

        if not pid:
            raise HTTPException(status_code=400, detail="id_plan_peda manquant.")

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
                existing_form_pub = _lms_publication_row(cur, oid, fid, id_lms_config)

                form_result = lara_connector.publish_formation(
                    form=form,
                    html_payload=html_payload,
                    cfg=cfg,
                    existing_publication=existing_form_pub,
                )

                if not form_result.get("ok"):
                    saved_form_error = _lms_write_publication_error(
                        cur,
                        oid,
                        fid,
                        id_lms_config,
                        "lara",
                        form_result.get("external_id"),
                        html_hash,
                        form_result.get("response") or form_result,
                    )
                    conn.commit()

                    raise HTTPException(status_code=400, detail={
                        "message": "Synchronisation de la formation Lära impossible.",
                        "publication": saved_form_error,
                        "response": form_result.get("response") or form_result,
                    })

                form_pub = _lms_write_publication_success(
                    cur,
                    oid,
                    fid,
                    id_lms_config,
                    "lara",
                    form_result.get("external_id"),
                    form_result.get("external_url"),
                    html_hash,
                )

                plan = _fetch_plan_detail(cur, oid, fid, pid)
                plan_hash = _lms_plan_payload_hash(plan)
                existing_plan_pub = _lms_plan_publication_row(cur, oid, fid, pid, id_lms_config)

                plan_publisher = getattr(lara_connector, "publish_plan_session", None)
                if plan_publisher is None:
                    plan_publisher = lara_connector.publish_plan_structure

                plan_result = plan_publisher(
                    plan=plan,
                    cfg=cfg,
                    formation_publication=form_pub,
                    existing_plan_publication=existing_plan_pub,
                )

                if not plan_result.get("ok"):
                    saved_plan_error = _lms_write_plan_publication_error(
                        cur,
                        oid,
                        fid,
                        pid,
                        id_lms_config,
                        "lara",
                        plan_result.get("external_id"),
                        plan_hash,
                        plan_result.get("response") or plan_result,
                    )
                    conn.commit()

                    raise HTTPException(status_code=400, detail={
                        "message": "Synchronisation du plan Lära impossible.",
                        "publication": saved_plan_error,
                        "response": plan_result.get("response") or plan_result,
                    })

                plan_pub = _lms_write_plan_publication_success(
                    cur,
                    oid,
                    fid,
                    pid,
                    id_lms_config,
                    "lara",
                    plan_result.get("external_id"),
                    plan_result.get("external_url"),
                    plan_hash,
                )

                conn.commit()

        return {
            "ok": True,
            "provider_code": "lara",
            "formation": {
                "action": form_result.get("action"),
                "external_id": form_result.get("external_id"),
                "external_url": form_result.get("external_url"),
                "publication": form_pub,
            },
            "plan": {
                "action": plan_result.get("action"),
                "external_id": plan_result.get("external_id"),
                "external_url": plan_result.get("external_url"),
                "publication": plan_pub,
            },
            "message": "Formation et plan synchronisés avec Lära.",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"learn/formations plan lms publish error: {e}")
