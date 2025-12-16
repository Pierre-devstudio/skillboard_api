from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import uuid

from psycopg.rows import dict_row

from app.routers.consultant_portal_common import (
    get_conn,
    fetch_consultant_with_entreprise,
)

router = APIRouter()


# ======================================================
# Modèles
# ======================================================
class ConsultantCompetenceItem(BaseModel):
    id_association_consultant_competence: str
    id_competence: str
    code: str
    intitule: str
    niveau_actuel: Optional[str] = None

    # Pour affichage (tu voulais "date dernier audit")
    # On ne l'a PAS en base directement dans les tables fournies,
    # donc on expose ce qu'on a, et on laisse "date_dernier_audit" à None pour l’instant.
    date_dernier_audit: Optional[str] = None

    # Champs utiles si tu veux les afficher plus tard
    date_acquisition: Optional[str] = None
    date_derniere_utilisation: Optional[str] = None
    id_dernier_audit: Optional[str] = None


class CompetenceCatalogueItem(BaseModel):
    id_competence: str
    code: str
    intitule: str
    domaine: Optional[str] = None
    domaine_titre: Optional[str] = None


class AddConsultantCompetencePayload(BaseModel):
    id_competence: str
    niveau_actuel: str  # "Initial" | "Avancé" | "Expert"


# ======================================================
# Constantes / validation
# ======================================================
_ALLOWED_LEVELS = {"Initial", "Avancé", "Expert"}


def _normalize_level(v: str) -> str:
    v = (v or "").strip()
    if v not in _ALLOWED_LEVELS:
        raise HTTPException(
            status_code=400,
            detail="Niveau invalide. Valeurs autorisées: Initial, Avancé, Expert.",
        )
    return v


# ======================================================
# Endpoints - Compétences
# ======================================================
@router.get(
    "/consultant/expertises/competences/{id_consultant}",
    response_model=List[ConsultantCompetenceItem],
)
def get_consultant_competences(id_consultant: str):
    """
    Liste des compétences du consultant (menu "Vos expertises" > Compétences).

    Source:
    - public.tbl_consultant_competence (filtre actif = TRUE)
    - JOIN public.tbl_competence (filtre masque = FALSE, etat = 'valide')

    Remarque:
    - "date dernier audit" n'existe pas dans les 2 tables fournies.
      On renvoie donc date_dernier_audit = None pour l’instant, et on expose id_dernier_audit.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # Vérif consultant actif (sinon 404)
                fetch_consultant_with_entreprise(cur, id_consultant)

                cur.execute(
                    """
                    SELECT
                        cc.id_association_consultant_competence,
                        cc.id_competence,
                        cc.niveau_actuel,
                        cc.date_acquisition,
                        cc.date_derniere_utilisation,
                        cc.id_dernier_audit,
                        a.date_audit AS date_dernier_audit,
                        c.code,
                        c.intitule
                    FROM public.tbl_consultant_competence cc
                    JOIN public.tbl_competence c
                      ON c.id_comp = cc.id_competence
                    LEFT JOIN public.tbl_consultant_audit_competence a
                      ON a.id_audit_competence = cc.id_dernier_audit
                    WHERE cc.id_consultant = %s
                      AND cc.actif = TRUE                      
                      AND (c.etat IS NULL OR c.etat = 'active' OR c.etat = 'à valider')
                    ORDER BY c.code
                    """,
                    (id_consultant,),
                )

                rows = cur.fetchall() or []

        out = []
        for r in rows:
            out.append(
                ConsultantCompetenceItem(
                    id_association_consultant_competence=r.get("id_association_consultant_competence"),
                    id_competence=r.get("id_competence"),
                    code=r.get("code") or "",
                    intitule=r.get("intitule") or "",
                    niveau_actuel=r.get("niveau_actuel"),
                    date_dernier_audit=(
                        r.get("date_dernier_audit").isoformat()
                        if r.get("date_dernier_audit")
                        else None
                    ),
                    date_acquisition=r.get("date_acquisition").isoformat() if r.get("date_acquisition") else None,
                    date_derniere_utilisation=r.get("date_derniere_utilisation").isoformat() if r.get("date_derniere_utilisation") else None,
                    id_dernier_audit=r.get("id_dernier_audit"),
                )
            )
        return out

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/consultant/expertises/competences_catalogue",
    response_model=List[CompetenceCatalogueItem],
)
def search_competences_catalogue(q: Optional[str] = None, limit: int = 30):
    """
    Recherche dans public.tbl_competence pour le bouton "+ Ajouter".

    - filtre masque = FALSE, etat = 'valide' (ici: active / à valider selon ton existant)
    - recherche sur code / intitulé
    - renvoie aussi domaine_titre (JOIN tbl_domaine_competence)
    """
    try:
        q = (q or "").strip()
        if limit < 1:
            limit = 1
        if limit > 100:
            limit = 100

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                if q:
                    cur.execute(
                        """
                        SELECT
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.domaine,
                            d.titre AS domaine_titre
                        FROM public.tbl_competence c
                        LEFT JOIN public.tbl_domaine_competence d
                          ON d.id_domaine_competence = c.domaine
                        WHERE c.masque = FALSE
                          AND (c.etat IS NULL OR c.etat = 'active' OR c.etat = 'à valider')
                          AND (
                            c.code ILIKE %s
                            OR c.intitule ILIKE %s
                          )
                        ORDER BY COALESCE(d.titre, ''), c.code
                        LIMIT %s
                        """,
                        (f"%{q}%", f"%{q}%", limit),
                    )
                else:
                    cur.execute(
                        """
                        SELECT
                            c.id_comp,
                            c.code,
                            c.intitule,
                            c.domaine,
                            d.titre AS domaine_titre
                        FROM public.tbl_competence c
                        LEFT JOIN public.tbl_domaine_competence d
                          ON d.id_domaine_competence = c.domaine
                        WHERE c.masque = FALSE
                          AND (c.etat IS NULL OR c.etat = 'active' OR c.etat = 'à valider')
                        ORDER BY COALESCE(d.titre, ''), c.code
                        LIMIT %s
                        """,
                        (limit,),
                    )
                rows = cur.fetchall() or []

        return [
            CompetenceCatalogueItem(
                id_competence=r.get("id_comp") or "",
                code=r.get("code") or "",
                intitule=r.get("intitule") or "",
                domaine=r.get("domaine"),
                domaine_titre=r.get("domaine_titre"),
            )
            for r in rows
        ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")



@router.post("/consultant/expertises/competences/{id_consultant}")
def add_or_update_consultant_competence(
    id_consultant: str,
    payload: AddConsultantCompetencePayload,
):
    """
    Ajout / mise à jour d'une compétence pour un consultant.

    - Si l'association existe (même inactive): on la réactive + update niveau.
    - Sinon: INSERT avec actif = TRUE.
    - Pas d’audit ici: id_dernier_audit reste NULL.
    - Pas de date auto imposée: date_acquisition / date_derniere_utilisation restent NULL.
    """
    try:
        id_competence = (payload.id_competence or "").strip()
        if not id_competence:
            raise HTTPException(status_code=400, detail="id_competence manquant.")

        niveau = _normalize_level(payload.niveau_actuel)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # Vérif consultant actif
                fetch_consultant_with_entreprise(cur, id_consultant)

                # Vérif compétence existe + non masquée + valide
                cur.execute(
                    """
                    SELECT id_comp
                    FROM public.tbl_competence
                    WHERE id_comp = %s
                      AND masque = FALSE
                      AND (etat IS NULL OR etat = 'active' OR etat = 'à valider')
                    """,
                    (id_competence,),
                )
                comp = cur.fetchone()
                if not comp:
                    raise HTTPException(status_code=404, detail="Compétence introuvable ou masquée.")

                # Recherche association existante (priorité à actif=TRUE si doublons)
                cur.execute(
                    """
                    SELECT id_association_consultant_competence, actif
                    FROM public.tbl_consultant_competence
                    WHERE id_consultant = %s
                      AND id_competence = %s
                    ORDER BY actif DESC
                    LIMIT 1
                    """,
                    (id_consultant, id_competence),
                )
                existing = cur.fetchone()

                if existing:
                    id_assoc = existing.get("id_association_consultant_competence")
                    cur.execute(
                        """
                        UPDATE public.tbl_consultant_competence
                        SET niveau_actuel = %s,
                            actif = TRUE
                        WHERE id_association_consultant_competence = %s
                        """,
                        (niveau, id_assoc),
                    )
                else:
                    id_assoc = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_consultant_competence
                        (
                            id_association_consultant_competence,
                            id_consultant,
                            id_competence,
                            niveau_actuel,
                            date_acquisition,
                            date_derniere_utilisation,
                            actif,
                            id_dernier_audit
                        )
                        VALUES
                        (
                            %s, %s, %s, %s,
                            NULL, NULL,
                            TRUE,
                            NULL
                        )
                        """,
                        (id_assoc, id_consultant, id_competence, niveau),
                    )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
