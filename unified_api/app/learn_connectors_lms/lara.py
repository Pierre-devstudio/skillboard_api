from typing import Any, Optional
import json

from app.routers.learn_portal_informations import (
    learn_lms_api_post,
    learn_lms_extract_url,
    learn_lms_extract_workspace_id,
    learn_lms_keywords,
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
