from typing import Any, Optional

PROVIDER_CODE = "ebp_paie"
PROVIDER_LABEL = "EBP Paie"


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def build_config_json(client_id: Optional[str] = None, dossier_code: Optional[str] = None) -> dict:
    """
    Prépare les champs non secrets du connecteur EBP Paie.
    La récupération réelle sera développée dans ce module, sans polluer le router Studio.
    """
    return {
        "client_id": _clean_text(client_id),
        "tenant_id": _clean_text(client_id),
        "dossier_code": _clean_text(dossier_code),
        "sync_enabled": False,
        "sync_scope": [],
    }


def build_secret_json(api_key: Optional[str] = None) -> dict:
    key = _clean_text(api_key)
    if not key:
        return {}
    return {
        "api_key": key,
    }


def public_descriptor() -> dict:
    return {
        "provider_code": PROVIDER_CODE,
        "provider_label": PROVIDER_LABEL,
        "sync_available": False,
        "prepared_operations": [
            "récupération_structure",
            "récupération_collaborateurs",
            "récupération_postes",
        ],
    }


def build_client(secret_json: dict, config_json: dict, base_url: str = ""):
    """
    Point d'entrée réservé pour la future passerelle EBP Paie.
    Le connecteur reste volontairement muet tant que l'API cible n'est pas validée.
    """
    raise NotImplementedError("Connecteur EBP Paie préparé, synchronisation non développée.")
