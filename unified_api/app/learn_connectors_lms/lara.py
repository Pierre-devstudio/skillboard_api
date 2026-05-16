from typing import Any, Optional
import json

from app.routers.learn_portal_informations import (
    learn_lms_api_post,
    learn_lms_extract_url,
    learn_lms_extract_workspace_id,
    learn_lms_keywords,
    learn_lms_localized_text,
    learn_lms_resolve_lara_defaults,
    learn_lms_safe_int,
    learn_lms_short_description,
)


def _lara_form_name(form: dict) -> str:
    titre = str(form.get("titre") or "").strip() or "Formation"
    return titre[:180].strip()


def _lara_config_json(cfg: dict) -> dict:
    raw = (cfg or {}).get("config_json") or {}

    if isinstance(raw, dict):
        return raw

    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    return {}

def _lara_recovery_type_ids(cfg: dict) -> set:
    cfg_json = _lara_config_json(cfg)

    raw = (
        cfg_json.get("lara_recovery_type_ids")
        or cfg_json.get("recovery_type_ids")
        or cfg_json.get("workspace_recovery_type_ids")
        or []
    )

    if isinstance(raw, str):
        raw = [x.strip() for x in raw.split(",")]

    if not isinstance(raw, list):
        return set()

    return {
        str(x or "").strip()
        for x in raw
        if str(x or "").strip()
    }


def _lara_workspace_type_label(row: dict) -> str:
    return (
        learn_lms_localized_text(row.get("name"))
        or _lara_text(row.get("name"))
        or str(row.get("label") or "").strip()
        or str(row.get("id") or "").strip()
    )


def list_workspace_types(cfg: dict) -> dict:
    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    api_result = learn_lms_api_post(api_base, api_id, "workspace/gettypes", {})

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "items": [],
            "response": api_result,
        }

    rows = api_result.get("json") or []
    if not isinstance(rows, list):
        rows = []

    items = []

    for row in rows:
        if not isinstance(row, dict):
            continue

        tid = str(row.get("id") or "").strip()
        if not tid:
            continue

        if row.get("isActive") is False:
            continue

        items.append({
            "id": tid,
            "label": _lara_workspace_type_label(row),
            "type": str(row.get("type") or "").strip(),
            "is_default": bool(row.get("isDefault")),
        })

    return {
        "ok": True,
        "provider_code": "lara",
        "items": items,
        "response": api_result,
    }


def _lara_workspace_type_map(cfg: dict) -> dict:
    result = list_workspace_types(cfg)

    if not result.get("ok"):
        return {}

    return {
        str(x.get("id") or "").strip(): x
        for x in (result.get("items") or [])
        if str(x.get("id") or "").strip()
    }

def _lara_code_custom_field_name(cfg: dict) -> str:
    cfg_json = _lara_config_json(cfg)

    field_name = (
        cfg_json.get("code_form_field")
        or cfg_json.get("code_formation_field")
        or cfg_json.get("custom_field_code_formation")
        or cfg_json.get("custom_field_code_form")
        or "Code_form"
    )

    return str(field_name or "").strip()


def _lara_form_custom_fields(form: dict, cfg: dict) -> dict:
    code = str(form.get("code") or "").strip()
    field_name = _lara_code_custom_field_name(cfg)

    if not code or not field_name:
        return {}

    return {
        field_name: code
    }

def _lara_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value.strip()

    if isinstance(value, (int, float, bool)):
        return str(value).strip()

    if isinstance(value, dict):
        for key in ("fr", "fr-FR", "fr_CA", "fr-CA", "default", "value", "label", "name", "text", "en", "en-US"):
            if key in value:
                txt = _lara_text(value.get(key))
                if txt:
                    return txt

        for v in value.values():
            txt = _lara_text(v)
            if txt:
                return txt

        return ""

    if isinstance(value, list):
        for v in value:
            txt = _lara_text(v)
            if txt:
                return txt
        return ""

    return str(value or "").strip()


def _lara_first(row: dict, keys: tuple) -> Any:
    if not isinstance(row, dict):
        return None

    for key in keys:
        if key in row:
            return row.get(key)

    return None


def _lara_custom_fields(row: dict) -> dict:
    raw = _lara_first(row, ("customFields", "customfields", "custom_fields", "CustomFields"))

    if not raw:
        return {}

    if isinstance(raw, dict):
        return {
            str(k or "").strip(): _lara_text(v)
            for k, v in raw.items()
            if str(k or "").strip()
        }

    if isinstance(raw, list):
        out = {}

        for item in raw:
            if not isinstance(item, dict):
                continue

            name = _lara_text(
                item.get("name")
                or item.get("key")
                or item.get("code")
                or item.get("field")
                or item.get("fieldName")
                or item.get("label")
            )

            value = (
                item.get("value")
                if "value" in item
                else item.get("text")
                if "text" in item
                else item.get("content")
            )

            if name:
                out[name] = _lara_text(value)

        return out

    return {}


def _lara_workspace_external_id(row: dict) -> str:
    return _lara_text(_lara_first(row, ("id", "Id", "ID", "workspaceId", "workspaceID", "workspace_id")))


def _lara_workspace_name(row: dict) -> str:
    return _lara_text(_lara_first(row, ("name", "title", "titre", "label", "shortName"))) or "Formation LMS"


def _lara_workspace_type_id(row: dict) -> str:
    raw = _lara_first(row, ("type", "typeId", "workspaceTypeId", "workspaceType", "workspace_type_id"))

    if isinstance(raw, dict):
        return _lara_text(raw.get("id") or raw.get("value") or raw.get("type") or raw.get("typeId"))

    return _lara_text(raw)


def _lara_visibility_label(value: Any) -> str:
    v = _lara_text(value)

    if v == "1":
        return "Visible"

    if v == "3":
        return "Masquée"

    return v or "—"


def _lara_list_from_response(value: Any) -> list:
    if isinstance(value, list):
        return value

    if not isinstance(value, dict):
        return []

    for key in ("items", "data", "result", "results", "workspaces", "rows", "list"):
        v = value.get(key)
        if isinstance(v, list):
            return v

    for v in value.values():
        if isinstance(v, dict):
            nested = _lara_list_from_response(v)
            if nested:
                return nested

    return []


def _lara_matches_workspace_type(row: dict, workspace_type_id: str) -> bool:
    expected = _lara_text(workspace_type_id)

    if not expected:
        return True

    current = _lara_workspace_type_id(row)

    if not current:
        return True

    return current == expected


def _lara_normalize_remote_workspace(row: dict, cfg: dict, type_map: Optional[dict] = None) -> dict:
    custom_fields = _lara_custom_fields(row)
    code_field = _lara_code_custom_field_name(cfg)
    code_form = _lara_text(custom_fields.get(code_field))

    external_id = _lara_workspace_external_id(row)
    name = _lara_workspace_name(row)

    type_id = _lara_workspace_type_id(row)
    type_row = (type_map or {}).get(type_id) or {}
    type_label = str(type_row.get("label") or "").strip() or type_id

    visibility_type = _lara_text(
        _lara_first(row, ("visibilityType", "visibility_type", "visibility", "visibilityId"))
    )

    return {
        "source_kind": "lms_remote",
        "provider_code": "lara",
        "external_id": external_id,
        "external_url": _lara_text(_lara_first(row, ("url", "publicUrl", "catalogUrl", "link"))),
        "code": code_form,
        "code_form": code_form,
        "code_field": code_field,
        "titre": name,
        "short_description": _lara_text(_lara_first(row, ("shortDescription", "summary", "descriptionShort"))),
        "visibility_type": visibility_type,
        "visibility_label": _lara_visibility_label(visibility_type),
        "type_lms_id": type_id,
        "type_lms_label": type_label,
        "updated_at": _lara_text(_lara_first(row, ("updatedAt", "updateDate", "modifiedAt", "lastUpdateDate"))),
        "created_at": _lara_text(_lara_first(row, ("createdAt", "creationDate", "dateCreation"))),
        "custom_fields": custom_fields,
    }


def list_remote_formations(cfg: dict, q: str = "", limit: int = 500) -> dict:
    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    selected_type_ids = _lara_recovery_type_ids(cfg)
    type_map = _lara_workspace_type_map(cfg)

    api_result = learn_lms_api_post(
        api_base,
        api_id,
        "workspace/getlist",
        {"filterDate": "1900-01-01T00:00:00Z"},
    )

    if not api_result.get("ok"):
        api_result = learn_lms_api_post(api_base, api_id, "workspace/getlist", {})

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "items": [],
            "response": api_result,
        }

    raw_rows = _lara_list_from_response(api_result.get("json"))
    query = _lara_text(q).lower()

    items = []

    for row in raw_rows:
        if not isinstance(row, dict):
            continue

        type_id = _lara_workspace_type_id(row)

        if selected_type_ids and type_id and type_id not in selected_type_ids:
            continue

        item = _lara_normalize_remote_workspace(row, cfg, type_map)

        if not item.get("external_id"):
            continue

        haystack = " ".join([
            item.get("external_id") or "",
            item.get("code") or "",
            item.get("titre") or "",
            item.get("short_description") or "",
            item.get("type_lms_label") or "",
        ]).lower()

        if query and query not in haystack:
            continue

        items.append(item)

        if limit and len(items) >= limit:
            break

    return {
        "ok": True,
        "provider_code": "lara",
        "code_field": _lara_code_custom_field_name(cfg),
        "recovery_type_ids": sorted(selected_type_ids),
        "workspace_types": list(type_map.values()),
        "items": items,
        "total_raw": len(raw_rows),
        "response": api_result,
    }

def _lara_object_from_response(value: Any) -> dict:
    if isinstance(value, dict):
        for key in ("item", "data", "result", "workspace"):
            v = value.get(key)
            if isinstance(v, dict):
                return v

        if _lara_workspace_external_id(value) or _lara_workspace_name(value):
            return value

        for v in value.values():
            if isinstance(v, dict):
                nested = _lara_object_from_response(v)
                if nested:
                    return nested

        return {}

    if isinstance(value, list):
        for v in value:
            if isinstance(v, dict):
                return v

    return {}


def get_remote_formation(cfg: dict, external_id: str) -> dict:
    ext = str(external_id or "").strip()

    if not ext:
        return {
            "ok": False,
            "provider_code": "lara",
            "item": None,
            "response": {
                "error": "Identifiant Lära manquant."
            },
        }

    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    api_result = learn_lms_api_post(
        api_base,
        api_id,
        "workspace/get",
        {"id": ext},
    )

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "item": None,
            "response": api_result,
        }

    row = _lara_object_from_response(api_result.get("json"))

    if not row:
        return {
            "ok": False,
            "provider_code": "lara",
            "item": None,
            "response": {
                "message": "La formation Lära a répondu OK, mais aucun objet exploitable n’a été retourné.",
                "raw": api_result.get("json"),
            },
        }

    item = _lara_normalize_remote_workspace(row, cfg)

    item["description"] = _lara_text(
        _lara_first(row, ("description", "htmlDescription", "details", "content"))
    )

    item["raw"] = row

    if not item.get("external_url"):
        geturl_result = learn_lms_api_post(api_base, api_id, "workspace/geturl", {"id": ext})
        if geturl_result.get("ok"):
            item["external_url"] = learn_lms_extract_url(geturl_result.get("json")) or ""

    return {
        "ok": True,
        "provider_code": "lara",
        "item": item,
        "response": api_result,
    }

def _lara_drop_custom_fields_if_rejected(api_result: dict) -> bool:
    if not api_result or api_result.get("ok"):
        return False

    chunks = [
        api_result.get("error"),
        api_result.get("raw"),
    ]

    parsed = api_result.get("json")
    if isinstance(parsed, dict):
        chunks.append(parsed.get("message"))

        errors = parsed.get("errors")
        if isinstance(errors, dict):
            chunks.extend([
                errors.get("message"),
                errors.get("Message"),
                errors.get("detail"),
            ])
        elif isinstance(errors, str):
            chunks.append(errors)

    blob = " ".join(str(x or "") for x in chunks).lower()

    return (
        "customfield" in blob
        or "custom field" in blob
        or "customfields" in blob
        or "champ personnalisé" in blob
        or "champ personnalise" in blob
    )


def _lara_post_with_custom_field_fallback(api_base: str, api_id: str, path: str, payload: dict) -> dict:
    api_result = learn_lms_api_post(api_base, api_id, path, payload)

    if (
        api_result.get("ok")
        or "customFields" not in payload
        or not _lara_drop_custom_fields_if_rejected(api_result)
    ):
        return api_result

    retry_payload = dict(payload)
    retry_payload.pop("customFields", None)

    return learn_lms_api_post(api_base, api_id, path, retry_payload)


def _lara_payload_common(form: dict, html_payload: str, cfg: dict, resolved: dict) -> dict:
    cfg_json = _lara_config_json(cfg)
    visibility_type = learn_lms_safe_int(cfg_json.get("visibility_type"), 3)
    language = learn_lms_safe_int(cfg_json.get("language"), 3)

    payload = {
        "name": _lara_form_name(form),
        "categoryId": None,
        "coverId": None,
        "visibilityType": visibility_type,
        "maxParticipants": 0,
        "minParticipants": 0,
        "type": str(resolved.get("workspace_type_id") or "").strip(),
        "providerId": str(resolved.get("provider_id") or "").strip(),
        "language": language,
        "description": html_payload,
        "shortDescription": learn_lms_short_description(
            form.get("presentation") or form.get("objectifs") or form.get("titre") or "",
            200,
        ),
        "subscriptionType": 1,
        "startDate": "0001-01-01T00:00:00",
        "endDate": "0001-01-01T00:00:00",
        "isOverBookingSubscription": False,
        "authorizationType": 0,
        "needAdminApproval": False,
        "enrolmentType": 0,
        "externalLink": "",
        "keywords": learn_lms_keywords(form),
        "showAvailableSubscriptions": False,
        "canDeclareMultipleTimes": False,
        "autodeclarationPresenceActivitiesRequired": False,
    }

    custom_fields = _lara_form_custom_fields(form, cfg)
    if custom_fields:
        payload["customFields"] = custom_fields

    return payload


def publish_formation(
    form: dict,
    html_payload: str,
    cfg: dict,
    existing_publication: Optional[dict] = None,
) -> dict:
    resolved = learn_lms_resolve_lara_defaults(cfg)

    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    external_id = str((existing_publication or {}).get("external_id") or "").strip()
    external_url = str((existing_publication or {}).get("external_url") or "").strip()
    action = "update" if external_id else "create"

    if external_id:
        payload = {
            "id": external_id,
            "name": _lara_form_name(form),
            "description": html_payload,
            "shortDescription": learn_lms_short_description(
                form.get("presentation") or form.get("objectifs") or form.get("titre") or "",
                200,
            ),
            "keywords": learn_lms_keywords(form),
        }

        custom_fields = _lara_form_custom_fields(form, cfg)
        if custom_fields:
            payload["customFields"] = custom_fields

        api_result = _lara_post_with_custom_field_fallback(api_base, api_id, "workspace/edit", payload)
    else:
        payload = _lara_payload_common(form, html_payload, cfg, resolved)
        api_result = _lara_post_with_custom_field_fallback(api_base, api_id, "workspace/create", payload)

        if api_result.get("ok"):
            external_id = learn_lms_extract_workspace_id(api_result.get("json"))

    if not api_result.get("ok") or not external_id:
        return {
            "ok": False,
            "provider_code": "lara",
            "action": action,
            "external_id": external_id or None,
            "external_url": external_url or None,
            "response": api_result,
        }

    geturl_result = learn_lms_api_post(api_base, api_id, "workspace/geturl", {"id": external_id})
    if geturl_result.get("ok"):
        external_url = learn_lms_extract_url(geturl_result.get("json")) or external_url

    return {
        "ok": True,
        "provider_code": "lara",
        "action": action,
        "action_label": "mise à jour" if action == "update" else "créée",
        "external_id": external_id,
        "external_url": external_url,
        "response": api_result,
    }

def _lara_extract_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("id", "Id", "ID", "workspaceInstanceId", "workspace_instance_id"):
            txt = _lara_text(value.get(key))
            if txt:
                return txt

        for v in value.values():
            txt = _lara_extract_id(v)
            if txt:
                return txt

    if isinstance(value, list):
        for v in value:
            txt = _lara_extract_id(v)
            if txt:
                return txt

    return ""


def _lara_plan_name(plan: dict) -> str:
    titre = str(plan.get("titre") or "").strip() or "Plan pédagogique"
    return titre[:180].strip()


def _lara_plan_code_custom_field_name(cfg: dict) -> str:
    cfg_json = _lara_config_json(cfg)

    field_name = (
        cfg_json.get("code_plan_field")
        or cfg_json.get("code_plan_peda_field")
        or cfg_json.get("custom_field_code_plan")
        or "Code_plan"
    )

    return str(field_name or "").strip()


def _lara_plan_custom_fields(plan: dict, cfg: dict) -> dict:
    code = str(plan.get("codification") or "").strip()
    field_name = _lara_plan_code_custom_field_name(cfg)

    if not code or not field_name:
        return {}

    return {
        field_name: code
    }


def _lara_normalize_session(row: dict) -> dict:
    if not isinstance(row, dict):
        row = {}

    return {
        "external_id": _lara_text(_lara_first(row, ("id", "Id", "ID", "workspaceInstanceId"))),
        "workspace_id": _lara_text(_lara_first(row, ("workspaceId", "workspace_id"))),
        "website_id": _lara_text(_lara_first(row, ("websiteId", "website_id"))),
        "name": _lara_text(_lara_first(row, ("name", "title", "label"))) or "Session Lära",
        "start_date": _lara_text(_lara_first(row, ("startDate", "start_date"))),
        "end_date": _lara_text(_lara_first(row, ("endDate", "end_date"))),
        "is_hidden": bool(_lara_first(row, ("isHidden", "is_hidden"))),
        "status": _lara_text(_lara_first(row, ("status", "state"))),
        "last_modification_date": _lara_text(
            _lara_first(row, ("lastModificationDate", "lastModifiedAt", "updatedAt"))
        ),
        "custom_fields": _lara_custom_fields(row),
        "raw": row,
    }


def _lara_sections_from_resources(rows: list) -> list:
    sections = {}

    for r in rows or []:
        if not isinstance(r, dict):
            continue

        section_title = _lara_text(r.get("sectionTitle")) or "Section"
        try:
            section_position = int(r.get("sectionPosition") or 999999)
        except Exception:
            section_position = 999999

        key = f"{section_position}::{section_title}"

        if key not in sections:
            sections[key] = {
                "section_title": section_title,
                "section_position": section_position,
                "resources": [],
            }

        try:
            resource_position = int(r.get("resourcePosition") or 999999)
        except Exception:
            resource_position = 999999

        sections[key]["resources"].append({
            "resource_id": _lara_text(r.get("resourceId")),
            "title": _lara_text(r.get("title")),
            "resource_type": r.get("resourceType"),
            "resource_position": resource_position,
            "raw": r,
        })

    out = list(sections.values())
    out.sort(key=lambda x: (x.get("section_position") or 999999, x.get("section_title") or ""))

    for section in out:
        section["resources"].sort(key=lambda x: (x.get("resource_position") or 999999, x.get("title") or ""))

    return out


def list_plan_sessions(cfg: dict, workspace_id: str) -> dict:
    wid = str(workspace_id or "").strip()

    if not wid:
        return {
            "ok": False,
            "provider_code": "lara",
            "items": [],
            "response": {"error": "workspace_id manquant."},
        }

    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    api_result = learn_lms_api_post(
        api_base,
        api_id,
        "workspaceinstance/getlist",
        {
            "id": wid,
            "filterIncludeDisabled": True,
        },
    )

    if not api_result.get("ok"):
        api_result = learn_lms_api_post(
            api_base,
            api_id,
            "workspaceinstance/getlist",
            {"id": wid},
        )

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "items": [],
            "response": api_result,
        }

    rows = _lara_list_from_response(api_result.get("json"))

    return {
        "ok": True,
        "provider_code": "lara",
        "items": [_lara_normalize_session(r) for r in rows if isinstance(r, dict)],
        "response": api_result,
    }

def get_session_detail(cfg: dict, session_id: str) -> dict:
    sid = str(session_id or "").strip()

    if not sid:
        return {
            "ok": False,
            "provider_code": "lara",
            "item": None,
            "response": {"error": "session_id manquant."},
        }

    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    api_result = learn_lms_api_post(
        api_base,
        api_id,
        "workspaceinstance/get",
        {"id": sid},
    )

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "item": None,
            "response": api_result,
        }

    raw = api_result.get("json")

    item = {}
    if isinstance(raw, dict):
        item = raw
    else:
        item = {"raw": raw}

    return {
        "ok": True,
        "provider_code": "lara",
        "item": item,
        "normalized": _lara_normalize_session(item),
        "response": api_result,
    }

def get_session_resources(cfg: dict, session_id: str) -> dict:
    sid = str(session_id or "").strip()

    if not sid:
        return {
            "ok": False,
            "provider_code": "lara",
            "resources": [],
            "sections": [],
            "response": {"error": "session_id manquant."},
        }

    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    api_result = learn_lms_api_post(
        api_base,
        api_id,
        "workspaceinstance/getresourcelist",
        {"id": sid},
    )

    if not api_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "resources": [],
            "sections": [],
            "response": api_result,
        }

    rows = _lara_list_from_response(api_result.get("json"))

    return {
        "ok": True,
        "provider_code": "lara",
        "resources": rows,
        "sections": _lara_sections_from_resources(rows),
        "response": api_result,
    }


def _lara_plan_session_payload(plan: dict, workspace_id: str, cfg: dict, external_id: str = "") -> dict:
    payload = {
        "name": _lara_plan_name(plan),
        "startDate": "0001-01-01T00:00:00",
        "endDate": "0001-01-01T00:00:00",
        "minParticipants": 0,
        "maxParticipants": 0,
        "isOverBookingSubscription": False,
        "isHidden": False,
    }

    if external_id:
        payload["id"] = external_id
    else:
        payload["workspaceId"] = workspace_id

    return payload


def _lara_plan_block_text(block: dict, idx: int) -> str:
    parts = [
        f"Séquence {idx}",
        "",
        f"Titre : {block.get('titre') or ''}",
    ]

    if block.get("objectif"):
        parts.extend(["", f"Objectif : {block.get('objectif')}"])

    if block.get("duree"):
        parts.append(f"Durée : {block.get('duree')} h")

    if block.get("modalite_intervention"):
        parts.append(f"Modalité : {block.get('modalite_intervention')}")

    seqs = block.get("sequences") or []
    if seqs:
        parts.extend(["", "Contenus associés :"])
        for s in seqs:
            titre = _lara_text(s.get("titre_sequence"))
            if titre:
                parts.append(f"- {titre}")

    if block.get("observations"):
        parts.extend(["", f"Observations : {block.get('observations')}"])

    return "\n".join(str(x or "") for x in parts).strip()


def _lara_norm_section_title(value: Any) -> str:
    return " ".join(_lara_text(value).lower().split())


def _lara_try_create_section_text_block(
    api_base: str,
    api_id: str,
    session_id: str,
    block: dict,
    idx: int,
) -> dict:
    title = _lara_text(block.get("titre")) or f"Séquence {idx}"
    content = _lara_plan_block_text(block, idx)

    base_payload = {
        "workspaceInstanceId": session_id,
        "sessionId": session_id,
        "id": session_id,
        "title": title,
        "name": title,
        "resourceType": 9,
        "type": 9,
        "text": content,
        "content": content,
        "description": content,
        "sectionTitle": title,
        "sectionPosition": idx,
        "resourcePosition": 1,
        "completionPoints": 0,
        "credits": 0,
        "minParticipants": 0,
        "maxParticipants": 0,
        "isHidden": False,
        "adminCode": str(block.get("id_bloc_peda") or ""),
    }

    attempts = []

    candidates = [
        ("workspaceinstanceresource/create", dict(base_payload)),
        ("workspaceinstance/resource/create", dict(base_payload)),
        ("workspaceinstance/addresource", dict(base_payload)),
        ("workspaceresource/create", dict(base_payload)),
        ("resource/create", dict(base_payload)),
    ]

    for path, payload in candidates:
        api_result = learn_lms_api_post(api_base, api_id, path, payload)

        attempts.append({
            "path": path,
            "ok": bool(api_result.get("ok")),
            "payload": payload,
            "response": api_result.get("json") or api_result.get("error") or api_result.get("raw"),
        })

        if api_result.get("ok"):
            return {
                "ok": True,
                "path": path,
                "title": title,
                "response": api_result,
                "attempts": attempts,
            }

    return {
        "ok": False,
        "title": title,
        "attempts": attempts,
    }

def publish_plan_session(
    plan: dict,
    cfg: dict,
    formation_publication: dict,
    existing_plan_publication: Optional[dict] = None,
) -> dict:
    """
    Synchronise un plan pédagogique Novoskill avec une session Lära.

    Règle produit validée :
    - plan pédagogique Novoskill = session Lära ;
    - les blocs / sections ne sont pas écrits dans Lära faute d'endpoint API public fiable ;
    - aucun diagnostic utilisateur ici ;
    - aucun appel resource/section ici.
    """
    api_base = cfg.get("base_url") or ""
    secret = cfg.get("secret_json") or {}
    api_id = secret.get("api_id") or ""

    workspace_id = str((formation_publication or {}).get("external_id") or "").strip()
    if not workspace_id:
        return {
            "ok": False,
            "provider_code": "lara",
            "response": {"error": "Formation Lära non publiée ou external_id manquant."},
        }

    external_id = str((existing_plan_publication or {}).get("external_id") or "").strip()
    external_url = str((existing_plan_publication or {}).get("external_url") or "").strip()
    action = "update" if external_id else "create"

    session_payload = _lara_plan_session_payload(
        plan=plan,
        workspace_id=workspace_id,
        cfg=cfg,
        external_id=external_id,
    )

    if external_id:
        session_result = learn_lms_api_post(
            api_base,
            api_id,
            "workspaceinstance/edit",
            session_payload,
        )
    else:
        session_result = learn_lms_api_post(
            api_base,
            api_id,
            "workspaceinstance/create",
            session_payload,
        )

        if session_result.get("ok"):
            external_id = _lara_extract_id(session_result.get("json"))

    if not session_result.get("ok") or not external_id:
        return {
            "ok": False,
            "provider_code": "lara",
            "action": action,
            "external_id": external_id or None,
            "external_url": external_url or None,
            "response": session_result,
            "payload": session_payload,
        }

    return {
        "ok": True,
        "provider_code": "lara",
        "action": action,
        "action_label": "mise à jour" if action == "update" else "créée",
        "external_id": external_id,
        "external_url": external_url,
        "response": session_result,
        "payload": session_payload,

        # Compatibilité avec le backend actuel.
        # Ici, "sections_write_ok" signifie : rien à écrire côté section Lära.
        "diagnostic_only": False,
        "sections_write_attempted": False,
        "sections_write_ok": True,
        "sections_created": [],
        "sections_skipped": [],
        "sections_failed": [],
    }

def diagnose_workspace_sessions(cfg: dict, workspace_id: str) -> dict:
    """
    Diagnostic Lära d'une formation :
    - récupère toutes les sessions liées à la formation Lära ;
    - pour chaque session, récupère le détail session ;
    - pour chaque session, récupère la liste des éléments/sections exposées par Lära.

    Objectif : comprendre où Lära expose le découpage "sectionTitle / sectionPosition"
    sans demander à l'utilisateur de saisir un ID de session invisible.
    """
    wid = str(workspace_id or "").strip()

    if not wid:
        return {
            "ok": False,
            "provider_code": "lara",
            "workspace_id": "",
            "sessions": [],
            "response": {"error": "workspace_id manquant."},
        }

    sessions_result = list_plan_sessions(cfg, wid)

    if not sessions_result.get("ok"):
        return {
            "ok": False,
            "provider_code": "lara",
            "workspace_id": wid,
            "sessions": [],
            "sessions_response": sessions_result,
        }

    sessions = []

    for s in sessions_result.get("items") or []:
        sid = str(s.get("external_id") or "").strip()

        if not sid:
            continue

        detail = get_session_detail(cfg, sid)
        resources = get_session_resources(cfg, sid)

        sessions.append({
            "session": s,
            "session_id": sid,
            "session_name": s.get("name") or "",
            "detail": detail,
            "resources": resources,
            "sections": resources.get("sections") or [],
            "resources_count": len(resources.get("resources") or []),
            "sections_count": len(resources.get("sections") or []),
        })

    return {
        "ok": True,
        "provider_code": "lara",
        "workspace_id": wid,
        "sessions_count": len(sessions),
        "sessions": sessions,
        "sessions_response": sessions_result,
    }

def publish_plan_structure(
    plan: dict,
    cfg: dict,
    formation_publication: dict,
    existing_plan_publication: Optional[dict] = None,
) -> dict:
    """
    Alias conservé pour ne pas casser les appels existants.

    Ancienne version :
    - créait / mettait à jour une session ;
    - lançait un diagnostic ;
    - retournait sections_write_ok=False.

    Nouvelle version :
    - crée / met à jour uniquement la session Lära ;
    - retourne un état de synchronisation exploitable côté utilisateur.
    """
    return publish_plan_session(
        plan=plan,
        cfg=cfg,
        formation_publication=formation_publication,
        existing_plan_publication=existing_plan_publication,
    )