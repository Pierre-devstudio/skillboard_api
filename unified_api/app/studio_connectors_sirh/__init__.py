from typing import Any

from . import ebp_paie

PROVIDERS = {
    "manual": {
        "code": "manual",
        "label": "Aucun connecteur",
    },
    ebp_paie.PROVIDER_CODE: {
        "code": ebp_paie.PROVIDER_CODE,
        "label": ebp_paie.PROVIDER_LABEL,
    },
}


def normalize_provider_code(value: Any) -> str:
    v = str(value or "").strip().lower()

    if v in ("ebp", "ebp_paie", "ebp-paie", "ebp paie", "ebp_payroll"):
        return ebp_paie.PROVIDER_CODE

    return "manual"


def provider_label(provider_code: Any) -> str:
    code = normalize_provider_code(provider_code)
    return PROVIDERS.get(code, PROVIDERS["manual"]).get("label") or PROVIDERS["manual"]["label"]
