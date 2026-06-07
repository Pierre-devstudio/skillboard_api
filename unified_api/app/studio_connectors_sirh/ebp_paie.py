from typing import Any, Optional
from urllib.parse import urlparse

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



def _is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except Exception:
        return False


def test_connection_payload(
    base_url: Optional[str] = None,
    client_id: Optional[str] = None,
    dossier_code: Optional[str] = None,
    api_key: Optional[str] = None,
    has_existing_secret: bool = False,
) -> dict:
    errors = []
    base = _clean_text(base_url)
    cid = _clean_text(client_id)
    dossier = _clean_text(dossier_code)
    key = _clean_text(api_key)

    if not base:
        errors.append("URL API / environnement manquante")
    elif not _is_http_url(base):
        errors.append("URL API / environnement invalide")

    if not cid:
        errors.append("identifiant client / tenant manquant")

    if not dossier:
        errors.append("identifiant dossier / entreprise manquant")

    if not key and not has_existing_secret:
        errors.append("clé API manquante")

    if errors:
        return {
            "ok": False,
            "provider_code": PROVIDER_CODE,
            "provider_label": PROVIDER_LABEL,
            "test_message": "Paramètres EBP Paie incomplets : " + "; ".join(errors) + ".",
        }

    return {
        "ok": True,
        "provider_code": PROVIDER_CODE,
        "provider_label": PROVIDER_LABEL,
        "test_message": "Contrôle EBP Paie validé : URL, identifiants et clé API sont renseignés. Le test d’appel API réel sera activé avec la passerelle EBP.",
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
