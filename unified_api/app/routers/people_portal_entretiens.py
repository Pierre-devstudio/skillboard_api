from datetime import date
from typing import List, Optional
from uuid import uuid4
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from psycopg.types.json import Json
from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import (
    people_clean,
    people_fetch_profile_context,
)
router = APIRouter()

class PeopleAutoEvalItem(BaseModel):
    id_comp: str
    niveau_auto: Optional[str] = None
    commentaire: Optional[str] = None
    besoin_accompagnement: Optional[bool] = False

class PeopleAutoEvalPayload(BaseModel):
    items: List[PeopleAutoEvalItem] = []
    commentaire_general: Optional[str] = None

@router.get("/people/entretiens/auto-evaluation/{id_effectif}")
def people_entretiens_auto_eval(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_poste = profile.get("id_poste_actuel") or ""

                cur.execute(
                    """
                    SELECT id_entretien, statut, date_prevue, preparation
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY
                      CASE
                        WHEN statut IN ('à réaliser', 'en cours', 'à signer 1/2') THEN 0
                        ELSE 1
                      END,
                      updated_at DESC,
                      created_at DESC
                    LIMIT 1
                    """,
                    (profile.get("id_owner") or "", id_effectif),
                )
                entretien = cur.fetchone() or {}

                items = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                          pc.niveau_requis,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                          COALESCE(c.description, '') AS description
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_domaine_competence dc
                          ON dc.id_domaine_competence = c.domaine
                         AND COALESCE(dc.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        """,
                        (id_effectif, id_poste),
                    )
                    items = cur.fetchall() or []

        prep = entretien.get("preparation") or {}
        if not isinstance(prep, dict):
            prep = {}
        return {
            "profile": profile,
            "entretien": {
                "id_entretien": entretien.get("id_entretien") or "",
                "statut": entretien.get("statut") or "",
                "date_prevue": people_clean(entretien.get("date_prevue")),
                "auto_evaluation_people": prep.get("auto_evaluation_people") or {},
            },
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/auto-evaluation error: {e}")


@router.post("/people/entretiens/auto-evaluation/{id_effectif}/save")
def people_entretiens_save_auto_eval(id_effectif: str, payload: PeopleAutoEvalPayload, request: Request):
    clean_items = []
    for item in payload.items or []:
        cid = people_clean(item.id_comp)
        if not cid:
            continue
        niv = people_clean(item.niveau_auto).upper()
        if niv not in ("A", "B", "C", ""):
            niv = ""
        clean_items.append({
            "id_comp": cid,
            "niveau_auto": niv,
            "commentaire": people_clean(item.commentaire),
            "besoin_accompagnement": bool(item.besoin_accompagnement),
        })

    auto_payload = {
        "date_saisie": date.today().isoformat(),
        "commentaire_general": people_clean(payload.commentaire_general),
        "items": clean_items,
    }

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT id_entretien
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND statut IN ('à réaliser', 'en cours', 'à signer 1/2')
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 1
                    """,
                    (id_ent, id_effectif),
                )
                ent = cur.fetchone() or {}
                if ent.get("id_entretien"):
                    id_entretien = ent.get("id_entretien")
                    cur.execute(
                        """
                        UPDATE public.tbl_entretien_individuel
                        SET preparation = COALESCE(preparation, '{}'::jsonb) || %s::jsonb,
                            updated_at = NOW()
                        WHERE id_entretien = %s
                        RETURNING id_entretien
                        """,
                        (Json({"auto_evaluation_people": auto_payload}), id_entretien),
                    )
                else:
                    id_entretien = str(uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_entretien_individuel
                          (id_entretien, id_ent, id_effectif_client, type_entretien, statut, date_prevue,
                           bilan, objectifs, developpement, plan_actions, documents, synthese,
                           preparation, realisation, competences_entretien, archive, created_at, updated_at)
                        VALUES
                          (%s, %s, %s, 'Entretien individuel', 'à réaliser', CURRENT_DATE,
                           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                           %s::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE, NOW(), NOW())
                        RETURNING id_entretien
                        """,
                        (id_entretien, id_ent, id_effectif, Json({"auto_evaluation_people": auto_payload})),
                    )
                row = cur.fetchone() or {}
            conn.commit()
        return {"saved": True, "id_entretien": row.get("id_entretien") or id_entretien}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/auto-evaluation/save error: {e}")
