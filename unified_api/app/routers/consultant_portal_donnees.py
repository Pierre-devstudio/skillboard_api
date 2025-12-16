from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List

from psycopg.rows import dict_row

from app.routers.consultant_portal_common import (
    get_conn,
    fetch_consultant_with_entreprise,
    upload_consultant_document_to_sharepoint,
)

router = APIRouter()


class ConsultantProfile(BaseModel):
    id_consultant: str

    # Modifiables par le consultant
    civilite: Optional[str] = None
    prenom: str
    nom: str
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone_mobile: Optional[str] = None
    adresse_1: Optional[str] = None
    adresse_2: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None

    # Non modifiables
    type_consultant: str
    entreprise_nom: Optional[str] = None
    cout_horaire: Optional[float] = None
    cout_supp_deplacement: Optional[float] = None
    cout_supp: Optional[float] = None

    # Affichage (photo)
    photo_url: Optional[str] = None


class ConsultantProfileUpdate(BaseModel):
    civilite: Optional[str] = None
    prenom: str
    nom: str
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone_mobile: Optional[str] = None
    adresse_1: Optional[str] = None
    adresse_2: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None
    # photo_url exclue : gérée par l'endpoint d'upload


class CityOption(BaseModel):
    code_postal: str
    ville: str
    code_insee: Optional[str] = None


@router.get(
    "/consultant/profile/{id_consultant}",
    response_model=ConsultantProfile,
)
def get_consultant_profile(id_consultant: str):
    """
    Profil complet consultant pour la page 'Vos données'.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row, entreprise_nom = fetch_consultant_with_entreprise(cur, id_consultant)

        return ConsultantProfile(
            id_consultant=row["id_consultant"],
            civilite=row.get("civilite"),
            prenom=row["prenom"],
            nom=row["nom"],
            email=row.get("email"),
            telephone=row.get("telephone"),
            telephone_mobile=row.get("telephone_mobile"),
            adresse_1=row.get("adresse_1"),
            adresse_2=row.get("adresse_2"),
            code_postal=row.get("code_postal"),
            ville=row.get("ville"),
            type_consultant=row["type_consultant"],
            entreprise_nom=entreprise_nom,
            cout_horaire=row.get("cout_horaire"),
            cout_supp_deplacement=row.get("cout_supp_deplacement"),
            cout_supp=row.get("cout_supp"),
            photo_url=row.get("photo_url"),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post("/consultant/profile/{id_consultant}")
def update_consultant_profile(
    id_consultant: str,
    payload: ConsultantProfileUpdate,
):
    """
    Mise à jour des champs modifiables par le consultant.
    (identité + coordonnées / adresse)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    UPDATE public.tbl_consultant
                    SET civilite          = %s,
                        prenom            = %s,
                        nom               = %s,
                        email             = %s,
                        telephone         = %s,
                        telephone_mobile  = %s,
                        adresse_1         = %s,
                        adresse_2         = %s,
                        code_postal       = %s,
                        ville             = %s,
                        date_modification = CURRENT_DATE
                    WHERE id_consultant = %s
                      AND actif = TRUE
                    """,
                    (
                        payload.civilite,
                        payload.prenom,
                        payload.nom,
                        payload.email,
                        payload.telephone,
                        payload.telephone_mobile,
                        payload.adresse_1,
                        payload.adresse_2,
                        payload.code_postal,
                        payload.ville,
                        id_consultant,
                    ),
                )

                if cur.rowcount == 0:
                    raise HTTPException(
                        status_code=404,
                        detail="Consultant introuvable ou inactif.",
                    )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/consultant/villes_par_cp/{code_postal}",
    response_model=List[CityOption],
)
def get_villes_par_code_postal(code_postal: str):
    """
    Retourne la liste des villes possibles pour un code postal donné,
    d'après public.tbl_code_postal.
    """
    try:
        code_postal = (code_postal or "").strip()
        if not code_postal:
            return []

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        code_postal,
                        ville,
                        code_insee
                    FROM public.tbl_code_postal
                    WHERE code_postal = %s
                    ORDER BY ville
                    """,
                    (code_postal,),
                )
                rows = cur.fetchall() or []

        return [
            CityOption(
                code_postal=r.get("code_postal") or "",
                ville=r.get("ville") or "",
                code_insee=r.get("code_insee"),
            )
            for r in rows
            if r.get("ville")
        ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post("/consultant/photo/{id_consultant}")
async def upload_consultant_photo(
    id_consultant: str,
    file: UploadFile = File(...),
):
    """
    Réceptionne la photo du consultant, l'envoie sur SharePoint
    dans son dossier dédié, et met à jour tbl_consultant.photo_url.
    """
    if not file:
        raise HTTPException(status_code=400, detail="Fichier manquant")

    # On vérifie le consultant et on récupère nom / prénom / code_consultant
    with get_conn() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            row, _ = fetch_consultant_with_entreprise(cur, id_consultant)

    nom = row["nom"] or ""
    prenom = row["prenom"] or ""
    code_consultant = row.get("code_consultant")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Fichier vide")

    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fichier trop volumineux (max 5 Mo)")

    logical_name = f"photo_{id_consultant}"
    photo_url = upload_consultant_document_to_sharepoint(
        id_consultant=id_consultant,
        nom=nom,
        prenom=prenom,
        code_consultant=code_consultant,
        logical_name=logical_name,
        filename=file.filename,
        content_type=file.content_type,
        data=data,
    )

    # Mise à jour BD
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.tbl_consultant
                SET photo_url = %s,
                    date_modification = CURRENT_DATE
                WHERE id_consultant = %s
                  AND actif = TRUE
                """,
                (photo_url, id_consultant),
            )
            if cur.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail="Consultant introuvable ou inactif.",
                )
            conn.commit()

    return {"ok": True, "photo_url": photo_url}
