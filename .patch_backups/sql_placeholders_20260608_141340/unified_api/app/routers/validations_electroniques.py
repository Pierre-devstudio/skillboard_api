# unified_api/app/routers/validations_electroniques.py

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from uuid import uuid4
from datetime import datetime
from zoneinfo import ZoneInfo
import base64
import hashlib
import json

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_id_ent_for_request,
)

router = APIRouter()


# ======================================================
# Models
# ======================================================
class ValidationElectroniquePayload(BaseModel):
    type_document: str
    id_document_ref: str
    type_signataire: str
    mode_validation: str
    signature_image: str
    payload_validation: Optional[Dict[str, Any]] = None


class ValidationElectroniqueItem(BaseModel):
    id_validation: str
    id_owner: Optional[str] = None
    id_ent: Optional[str] = None
    type_document: str
    id_document_ref: str
    type_signataire: str
    id_signataire: Optional[str] = None
    nom_signataire: Optional[str] = None
    prenom_signataire: Optional[str] = None
    email_signataire: Optional[str] = None
    mode_validation: str
    signature_hash: Optional[str] = None
    document_hash: Optional[str] = None
    date_validation: Optional[str] = None


# ======================================================
# Helpers génériques
# ======================================================
def _clean(value) -> str:
    return str(value or "").strip()


def _now_paris_iso() -> str:
    return datetime.now(ZoneInfo("Europe/Paris")).isoformat(timespec="seconds")


def _client_ip(request: Request) -> str:
    forwarded = _clean(request.headers.get("x-forwarded-for"))
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = _clean(request.headers.get("x-real-ip"))
    if real_ip:
        return real_ip
    return _clean(getattr(request.client, "host", ""))


def _normalize_signature_image(value: str) -> str:
    raw = _clean(value)
    if not raw:
        raise HTTPException(status_code=400, detail="Signature image manquante.")

    if raw.startswith("data:image/png;base64,"):
        b64 = raw.split(",", 1)[1].strip()
    else:
        b64 = raw

    if len(b64) > 1_500_000:
        raise HTTPException(status_code=413, detail="Signature trop volumineuse.")

    try:
        decoded = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Format de signature invalide.")

    if len(decoded) < 100:
        raise HTTPException(status_code=400, detail="Signature vide ou invalide.")

    return "data:image/png;base64," + b64


def _sha256_text(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _sha256_json(value: Dict[str, Any]) -> str:
    stable = json.dumps(value or {}, ensure_ascii=False, sort_keys=True, default=str)
    return _sha256_text(stable)


def _resolve_owner_for_ent(cur, id_ent: str) -> str:
    cur.execute(
        """
        SELECT COALESCE(NULLIF(id_owner_gestionnaire, ''), id_ent) AS id_owner
        FROM public.tbl_entreprise
        WHERE id_ent = %s
        LIMIT 1
        """,
        (id_ent,),
    )
    row = cur.fetchone() or {}
    return _clean(row.get("id_owner")) or id_ent


def _fetch_signataire_insights(cur, id_ent: str, id_contact: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
            id_effectif,
            nom_effectif,
            prenom_effectif,
            email_effectif
        FROM public.tbl_effectif_client
        WHERE id_effectif = %s
          AND id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_contact, id_ent),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Signataire introuvable dans le périmètre Insights.")
    return row


def _fetch_entretien_for_validation(cur, id_ent: str, id_entretien: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
            id_entretien,
            id_ent,
            id_effectif_client,
            id_manager,
            type_entretien,
            statut,
            date_prevue,
            date_realisee,
            periode_debut,
            periode_fin,
            preparation,
            realisation,
            competences_entretien,
            documents,
            synthese,
            bilan,
            objectifs,
            developpement,
            plan_actions,
            updated_at
        FROM public.tbl_entretien_individuel
        WHERE id_entretien = %s
          AND id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_entretien, id_ent),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Entretien individuel introuvable.")
    return row


def _build_document_hash(type_document: str, document_row: Dict[str, Any]) -> str:
    if type_document == "entretien_individuel":
        data = {
            "type_document": type_document,
            "id_document_ref": document_row.get("id_entretien"),
            "id_ent": document_row.get("id_ent"),
            "id_effectif_client": document_row.get("id_effectif_client"),
            "id_manager": document_row.get("id_manager"),
            "type_entretien": document_row.get("type_entretien"),
            "date_prevue": document_row.get("date_prevue"),
            "date_realisee": document_row.get("date_realisee"),
            "periode_debut": document_row.get("periode_debut"),
            "periode_fin": document_row.get("periode_fin"),
            "preparation": document_row.get("preparation") or {},
            "realisation": document_row.get("realisation") or {},
            "competences_entretien": document_row.get("competences_entretien") or [],
            "documents": document_row.get("documents") or {},
            "synthese": document_row.get("synthese") or {},
            "bilan": document_row.get("bilan") or {},
            "objectifs": document_row.get("objectifs") or {},
            "developpement": document_row.get("developpement") or {},
            "plan_actions": document_row.get("plan_actions") or {},
        }
        return _sha256_json(data)

    return _sha256_json({"type_document": type_document, "document": document_row})


def _recalculer_statut_entretien_signature(cur, id_ent: str, id_entretien: str) -> str:
    cur.execute(
        """
        SELECT COUNT(DISTINCT lower(type_signataire))::int AS nb_signatures
        FROM public.tbl_validations_electroniques
        WHERE type_document = 'entretien_individuel'
          AND id_document_ref = %s
          AND id_ent = %s
          AND lower(type_signataire) IN ('evaluateur', 'collaborateur')
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (id_entretien, id_ent),
    )
    row = cur.fetchone() or {}
    nb = int(row.get("nb_signatures") or 0)

    if nb <= 0:
        statut = "à signer 2/2"
    elif nb == 1:
        statut = "à signer 1/2"
    else:
        statut = "terminé"

    cur.execute(
        """
        UPDATE public.tbl_entretien_individuel
        SET statut = %s,
            updated_at = NOW()
        WHERE id_entretien = %s
          AND id_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        """,
        (statut, id_entretien, id_ent),
    )
    return statut


def _validation_item_from_row(row) -> ValidationElectroniqueItem:
    return ValidationElectroniqueItem(
        id_validation=row["id_validation"],
        id_owner=row.get("id_owner"),
        id_ent=row.get("id_ent"),
        type_document=row.get("type_document") or "",
        id_document_ref=row.get("id_document_ref") or "",
        type_signataire=row.get("type_signataire") or "",
        id_signataire=row.get("id_signataire"),
        nom_signataire=row.get("nom_signataire"),
        prenom_signataire=row.get("prenom_signataire"),
        email_signataire=row.get("email_signataire"),
        mode_validation=row.get("mode_validation") or "",
        signature_hash=row.get("signature_hash"),
        document_hash=row.get("document_hash"),
        date_validation=str(row.get("date_validation")) if row.get("date_validation") else None,
    )


# ======================================================
# Routes Insights
# ======================================================
@router.get(
    "/skills/validations-electroniques/{id_contact}/{type_document}/{id_document_ref}",
    response_model=List[ValidationElectroniqueItem],
)
def list_validations_electroniques_insights(
    id_contact: str,
    type_document: str,
    id_document_ref: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = resolve_insights_id_ent_for_request(cur, id_contact, request)
                doc_type = _clean(type_document).lower()
                doc_id = _clean(id_document_ref)

                if doc_type == "entretien_individuel":
                    _fetch_entretien_for_validation(cur, id_ent, doc_id)
                else:
                    raise HTTPException(status_code=400, detail="Type de document non supporté pour Insights.")

                cur.execute(
                    """
                    SELECT
                        id_validation,
                        id_owner,
                        id_ent,
                        type_document,
                        id_document_ref,
                        type_signataire,
                        id_signataire,
                        nom_signataire,
                        prenom_signataire,
                        email_signataire,
                        mode_validation,
                        signature_hash,
                        document_hash,
                        date_validation
                    FROM public.tbl_validations_electroniques
                    WHERE type_document = %s
                      AND id_document_ref = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_validation ASC, created_at ASC
                    """,
                    (doc_type, doc_id, id_ent),
                )
                return [_validation_item_from_row(r) for r in (cur.fetchall() or [])]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/validations-electroniques/{id_contact}",
    response_model=ValidationElectroniqueItem,
)
def create_validation_electronique_insights(
    id_contact: str,
    payload: ValidationElectroniquePayload,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = resolve_insights_id_ent_for_request(cur, id_contact, request)
                id_owner = _resolve_owner_for_ent(cur, id_ent)

                doc_type = _clean(payload.type_document).lower()
                doc_id = _clean(payload.id_document_ref)
                sign_type = _clean(payload.type_signataire).lower()
                mode = _clean(payload.mode_validation).lower()

                if not doc_id:
                    raise HTTPException(status_code=400, detail="Document à valider manquant.")
                if doc_type != "entretien_individuel":
                    raise HTTPException(status_code=400, detail="Type de document non supporté pour Insights.")
                if sign_type not in ["evaluateur", "collaborateur"]:
                    raise HTTPException(status_code=400, detail="Type de signataire invalide.")
                if sign_type != "evaluateur":
                    raise HTTPException(status_code=403, detail="La validation collaborateur sera traitée depuis People.")
                if mode not in ["signature_tracee", "signature_generee"]:
                    raise HTTPException(status_code=400, detail="Mode de validation invalide.")

                document_row = _fetch_entretien_for_validation(cur, id_ent, doc_id)
                signataire = _fetch_signataire_insights(cur, id_ent, id_contact)

                cur.execute(
                    """
                    SELECT id_validation
                    FROM public.tbl_validations_electroniques
                    WHERE type_document = %s
                      AND id_document_ref = %s
                      AND type_signataire = %s
                      AND id_signataire = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (doc_type, doc_id, sign_type, id_contact),
                )
                if cur.fetchone() is not None:
                    raise HTTPException(status_code=409, detail="Validation électronique déjà enregistrée pour ce signataire.")

                signature_image = _normalize_signature_image(payload.signature_image)
                signature_hash = _sha256_text(signature_image)
                document_hash = _build_document_hash(doc_type, document_row)
                id_validation = str(uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_validations_electroniques
                    (
                        id_validation,
                        id_owner,
                        id_ent,
                        type_document,
                        id_document_ref,
                        type_signataire,
                        id_signataire,
                        nom_signataire,
                        prenom_signataire,
                        email_signataire,
                        mode_validation,
                        signature_image,
                        signature_hash,
                        document_hash,
                        payload_validation,
                        ip_client,
                        user_agent,
                        date_validation,
                        archive,
                        created_at,
                        updated_at
                    )
                    VALUES
                    (
                        %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s::jsonb,
                        %s, %s,
                        NOW(),
                        FALSE,
                        NOW(),
                        NOW()
                    )
                    RETURNING
                        id_validation,
                        id_owner,
                        id_ent,
                        type_document,
                        id_document_ref,
                        type_signataire,
                        id_signataire,
                        nom_signataire,
                        prenom_signataire,
                        email_signataire,
                        mode_validation,
                        signature_hash,
                        document_hash,
                        date_validation
                    """,
                    (
                        id_validation,
                        id_owner,
                        id_ent,
                        doc_type,
                        doc_id,
                        sign_type,
                        id_contact,
                        _clean(signataire.get("nom_effectif")),
                        _clean(signataire.get("prenom_effectif")),
                        _clean(signataire.get("email_effectif")) or None,
                        mode,
                        signature_image,
                        signature_hash,
                        document_hash,
                        json.dumps(payload.payload_validation or {}, ensure_ascii=False),
                        _client_ip(request),
                        _clean(request.headers.get("User-Agent")),
                    ),
                )
                row = cur.fetchone()

                if doc_type == "entretien_individuel":
                    _recalculer_statut_entretien_signature(cur, id_ent, doc_id)

                conn.commit()
                return _validation_item_from_row(row)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
