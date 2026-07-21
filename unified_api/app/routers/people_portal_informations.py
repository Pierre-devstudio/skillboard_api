import os
from datetime import date
from typing import Optional
from urllib.parse import quote

import requests
from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_clean,
    people_fetch_profile_context,
)

router = APIRouter()

PEOPLE_SUPABASE_URL = os.getenv("SKILLS_SUPABASE_URL") or ""
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
PEOPLE_PROFILE_PHOTO_BUCKET = "people-profile-photos"
MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024
ALLOWED_PROFILE_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}

PEOPLE_EDUCATION_LEVELS = [
    {"value": "", "label": "—"},
    {"value": "0", "label": "Aucun diplôme"},
    {"value": "3", "label": "Niveau 3 : CAP, BEP"},
    {"value": "4", "label": "Niveau 4 : Bac"},
    {"value": "5", "label": "Niveau 5 : Bac+2 (BTS, DUT)"},
    {"value": "6", "label": "Niveau 6 : Bac+3 (Licence, BUT)"},
    {"value": "7", "label": "Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)"},
    {"value": "8", "label": "Niveau 8 : Bac+8 (Doctorat)"},
]
PEOPLE_EDUCATION_LEVEL_VALUES = {item["value"] for item in PEOPLE_EDUCATION_LEVELS}


class PeopleIdentityPayload(BaseModel):
    civilite: Optional[str] = None
    prenom: str
    nom: str
    telephone: Optional[str] = None
    adresse: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None
    pays: Optional[str] = None
    date_naissance: Optional[str] = None


class PeopleEducationPayload(BaseModel):
    niveau_education: Optional[str] = None
    domaine_education: Optional[str] = None


def _optional_date(value: Optional[str]) -> Optional[date]:
    raw = people_clean(value)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail="Date de naissance invalide.")


def _storage_headers(content_type: Optional[str] = None) -> dict:
    if not PEOPLE_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(status_code=500, detail="Configuration Supabase Storage manquante côté serveur.")
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _storage_url(path: str) -> str:
    safe_path = quote(path, safe="/")
    return f"{PEOPLE_SUPABASE_URL.rstrip('/')}/storage/v1/object/{PEOPLE_PROFILE_PHOTO_BUCKET}/{safe_path}"


def _photo_path(profile: dict, content_type: str) -> str:
    extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    }[content_type]
    return f"{people_clean(profile.get('id_owner'))}/{people_clean(profile.get('id_effectif'))}/profile.{extension}"


def _read_photo_path(cur, profile: dict) -> str:
    source_kind = people_clean(profile.get("source_row_kind"))
    id_effectif = people_clean(profile.get("id_effectif"))
    id_owner = people_clean(profile.get("id_owner"))
    if source_kind == "utilisateur":
        cur.execute(
            """
            SELECT photo_storage_path
            FROM public.tbl_utilisateur
            WHERE id_utilisateur = %s
              AND COALESCE(archive, FALSE) = FALSE
            LIMIT 1
            """,
            (id_effectif,),
        )
    else:
        cur.execute(
            """
            SELECT photo_storage_path
            FROM public.tbl_effectif_client
            WHERE id_effectif = %s
              AND id_ent = %s
              AND COALESCE(archive, FALSE) = FALSE
            LIMIT 1
            """,
            (id_effectif, id_owner),
        )
    return people_clean((cur.fetchone() or {}).get("photo_storage_path"))


def _write_photo_path(cur, profile: dict, path: str) -> None:
    source_kind = people_clean(profile.get("source_row_kind"))
    id_effectif = people_clean(profile.get("id_effectif"))
    id_owner = people_clean(profile.get("id_owner"))
    if source_kind == "utilisateur":
        cur.execute(
            """
            UPDATE public.tbl_utilisateur
            SET photo_storage_path = %s,
                dernier_update = NOW()
            WHERE id_utilisateur = %s
              AND COALESCE(archive, FALSE) = FALSE
            RETURNING id_utilisateur
            """,
            (path, id_effectif),
        )
    else:
        cur.execute(
            """
            UPDATE public.tbl_effectif_client
            SET photo_storage_path = %s,
                dernier_update = NOW()
            WHERE id_effectif = %s
              AND id_ent = %s
              AND COALESCE(archive, FALSE) = FALSE
            RETURNING id_effectif
            """,
            (path, id_effectif, id_owner),
        )
    if not cur.fetchone():
        raise HTTPException(status_code=404, detail="Profil People introuvable.")


def _education_domains(cur) -> list[dict]:
    cur.execute(
        """
        SELECT code, titre
        FROM public.tbl_nsf_groupe
        WHERE COALESCE(masque, FALSE) = FALSE
        ORDER BY titre, code
        """
    )
    return [
        {
            "value": people_clean(row.get("code")),
            "label": (
                f"{people_clean(row.get('titre'))} ({people_clean(row.get('code'))})"
                if people_clean(row.get("titre")) and people_clean(row.get("code"))
                else people_clean(row.get("titre") or row.get("code"))
            ),
            "titre": people_clean(row.get("titre")),
        }
        for row in (cur.fetchall() or [])
        if people_clean(row.get("code"))
    ]


def _education_label(value: str, items: list[dict]) -> str:
    raw = people_clean(value)
    if not raw:
        return ""
    raw_lower = raw.lower()
    for item in items:
        if raw_lower in {people_clean(item.get("value")).lower(), people_clean(item.get("titre")).lower()}:
            return people_clean(item.get("label"))
    return raw


@router.get("/people/informations/{id_effectif}")
def people_informations(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, payload = people_fetch_profile_context(cur, request, id_effectif)
                domains = _education_domains(cur)

        level_map = {item["value"]: item["label"] for item in PEOPLE_EDUCATION_LEVELS}
        payload["niveau_education_label"] = level_map.get(people_clean(payload.get("niveau_education")), people_clean(payload.get("niveau_education")))
        payload["domaine_education_label"] = _education_label(payload.get("domaine_education"), domains)
        return {
            "profile": payload,
            "education_options": {
                "levels": PEOPLE_EDUCATION_LEVELS,
                "domains": [{"value": "", "label": "—", "titre": ""}, *domains],
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/informations error: {exc}")


@router.patch("/people/informations/{id_effectif}/identity")
def people_update_identity(id_effectif: str, payload: PeopleIdentityPayload, request: Request):
    prenom = people_clean(payload.prenom)
    nom = people_clean(payload.nom)
    if not prenom or not nom:
        raise HTTPException(status_code=400, detail="Le prénom et le nom sont obligatoires.")

    date_naissance = _optional_date(payload.date_naissance)
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile, _, _ = people_fetch_profile_context(cur, request, id_effectif)
                source_kind = people_clean(profile.get("source_row_kind"))
                id_owner = people_clean(profile.get("id_owner"))
                values = (
                    people_clean(payload.civilite) or None,
                    prenom,
                    nom,
                    people_clean(payload.telephone) or None,
                    people_clean(payload.adresse) or None,
                    people_clean(payload.code_postal) or None,
                    people_clean(payload.ville) or None,
                    people_clean(payload.pays) or None,
                )

                if source_kind == "utilisateur":
                    cur.execute(
                        """
                        UPDATE public.tbl_utilisateur
                        SET ut_civilite = %s,
                            ut_prenom = %s,
                            ut_nom = %s,
                            ut_tel = %s,
                            ut_adresse = %s,
                            ut_cp = %s,
                            ut_ville = %s,
                            ut_pays = %s,
                            dernier_update = NOW()
                        WHERE id_utilisateur = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        RETURNING id_utilisateur
                        """,
                        (*values, id_effectif),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client
                        SET civilite_effectif = %s,
                            prenom_effectif = %s,
                            nom_effectif = %s,
                            telephone_effectif = %s,
                            adresse_effectif = %s,
                            code_postal_effectif = %s,
                            ville_effectif = %s,
                            pays_effectif = %s,
                            date_naissance_effectif = %s,
                            dernier_update = NOW()
                        WHERE id_effectif = %s
                          AND id_ent = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        RETURNING id_effectif
                        """,
                        (*values, date_naissance, id_effectif, id_owner),
                    )

                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Profil People introuvable.")
            conn.commit()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, updated = people_fetch_profile_context(cur, request, id_effectif)
        return {"saved": True, "profile": updated}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/informations/identity error: {exc}")


@router.patch("/people/informations/{id_effectif}/education")
def people_update_education(id_effectif: str, payload: PeopleEducationPayload, request: Request):
    niveau = people_clean(payload.niveau_education)
    domaine = people_clean(payload.domaine_education)
    if niveau not in PEOPLE_EDUCATION_LEVEL_VALUES:
        raise HTTPException(status_code=400, detail="Niveau de diplôme invalide.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile, _, _ = people_fetch_profile_context(cur, request, id_effectif)
                id_owner = people_clean(profile.get("id_owner"))

                domains = _education_domains(cur)
                domain_values = {people_clean(item.get("value")) for item in domains}
                if domaine and domaine not in domain_values:
                    raise HTTPException(status_code=400, detail="Domaine d’éducation invalide.")

                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client
                    SET niveau_education = %s,
                        domaine_education = %s,
                        dernier_update = NOW()
                    WHERE id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_effectif
                    """,
                    (niveau or None, domaine or None, id_effectif, id_owner),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Profil collaborateur People introuvable.")
            conn.commit()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, updated = people_fetch_profile_context(cur, request, id_effectif)
                domains = _education_domains(cur)

        level_map = {item["value"]: item["label"] for item in PEOPLE_EDUCATION_LEVELS}
        updated["niveau_education_label"] = level_map.get(people_clean(updated.get("niveau_education")), people_clean(updated.get("niveau_education")))
        updated["domaine_education_label"] = _education_label(updated.get("domaine_education"), domains)
        return {"saved": True, "profile": updated}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/informations/education error: {exc}")


@router.post("/people/informations/{id_effectif}/photo")
async def people_upload_photo(id_effectif: str, request: Request, photo: UploadFile = File(...)):
    content_type = people_clean(photo.content_type).lower()
    if content_type not in ALLOWED_PROFILE_PHOTO_TYPES:
        raise HTTPException(status_code=400, detail="Format accepté : JPEG, PNG ou WebP.")

    content = await photo.read(MAX_PROFILE_PHOTO_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Le fichier est vide.")
    if len(content) > MAX_PROFILE_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="La photo ne doit pas dépasser 5 Mo.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile, _, _ = people_fetch_profile_context(cur, request, id_effectif)
                previous_path = _read_photo_path(cur, profile)
                path = _photo_path(profile, content_type)

                response = requests.post(
                    _storage_url(path),
                    headers={**_storage_headers(content_type), "x-upsert": "true"},
                    data=content,
                    timeout=30,
                )
                if response.status_code >= 400:
                    raise HTTPException(status_code=500, detail="Impossible d’enregistrer la photo de profil.")

                _write_photo_path(cur, profile, path)
            conn.commit()

        if previous_path and previous_path != path:
            requests.delete(_storage_url(previous_path), headers=_storage_headers(), timeout=15)

        return {"saved": True, "has_photo": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/informations/photo error: {exc}")


@router.get("/people/informations/{id_effectif}/photo")
def people_get_photo(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                profile, _, _ = people_fetch_profile_context(cur, request, id_effectif)
                path = _read_photo_path(cur, profile)
        if not path:
            raise HTTPException(status_code=404, detail="Aucune photo de profil.")

        response = requests.get(_storage_url(path), headers=_storage_headers(), timeout=20)
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail="Aucune photo de profil.")
        if response.status_code >= 400:
            raise HTTPException(status_code=500, detail="Impossible de charger la photo de profil.")

        return Response(
            content=response.content,
            media_type=response.headers.get("content-type") or "image/jpeg",
            headers={"Cache-Control": "private, max-age=300"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/informations/photo error: {exc}")
