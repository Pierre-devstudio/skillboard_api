from datetime import date
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from psycopg.rows import dict_row
from psycopg.types.json import Json

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import people_clean, people_fetch_profile_context

router = APIRouter()

OPEN_STATUSES = ("à réaliser", "en cours", "à signer 1/2", "à signer 2/2", "planifié", "planifie")


class PeopleAutoEvalItem(BaseModel):
    id_comp: str
    niveau_auto: Optional[str] = None
    commentaire: Optional[str] = None
    besoin_accompagnement: bool = False


class PeoplePreparationPayload(BaseModel):
    bilan_periode: Optional[str] = None
    reussites: Optional[str] = None
    difficultes: Optional[str] = None
    changements_poste: Optional[str] = None
    sujets_a_aborder: Optional[str] = None
    souhaits_evolution: Optional[str] = None
    souhaits_mobilite: Optional[str] = None
    besoins_formation: Optional[str] = None
    accompagnement_souhaite: Optional[str] = None
    elements_partageables: Optional[str] = None
    notes_privees: Optional[str] = None
    items: List[PeopleAutoEvalItem] = Field(default_factory=list)


class PeopleRequestPayload(BaseModel):
    destinataire: str
    motif: str
    objet: Optional[str] = None
    description: Optional[str] = None


def _clean_level(value: Optional[str]) -> str:
    level = people_clean(value).upper()
    return level if level in ("A", "B", "C", "D") else ""


def _fetch_interview(cur, id_entretien: str, id_ent: str, id_effectif: str):
    cur.execute(
        """
        SELECT
          e.*,
          COALESCE(m.prenom_effectif, '') AS manager_prenom,
          COALESCE(m.nom_effectif, '') AS manager_nom
        FROM public.tbl_entretien_individuel e
        LEFT JOIN public.tbl_effectif_client m
          ON m.id_effectif = e.id_manager
         AND COALESCE(m.archive, FALSE) = FALSE
        WHERE e.id_entretien = %s
          AND e.id_ent = %s
          AND e.id_effectif_client = %s
          AND COALESCE(e.archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_entretien, id_ent, id_effectif),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Entretien introuvable pour ce profil People.")
    return row


def _serialize_interview(row):
    return {
        "id_entretien": row.get("id_entretien") or "",
        "type_entretien": row.get("type_entretien") or "Entretien",
        "statut": row.get("statut") or "",
        "date_prevue": people_clean(row.get("date_prevue")),
        "date_realisee": people_clean(row.get("date_realisee")),
        "periode_debut": people_clean(row.get("periode_debut")),
        "periode_fin": people_clean(row.get("periode_fin")),
        "manager": " ".join(filter(None, [row.get("manager_prenom"), row.get("manager_nom")])).strip(),
        "preparation_officielle": row.get("preparation") if isinstance(row.get("preparation"), dict) else {},
        "realisation": row.get("realisation") if isinstance(row.get("realisation"), dict) else {},
        "bilan": row.get("bilan") if isinstance(row.get("bilan"), dict) else {},
        "objectifs": row.get("objectifs") if isinstance(row.get("objectifs"), dict) else {},
        "developpement": row.get("developpement") if isinstance(row.get("developpement"), dict) else {},
        "plan_actions": row.get("plan_actions") if isinstance(row.get("plan_actions"), (dict, list)) else {},
        "synthese": row.get("synthese") if isinstance(row.get("synthese"), dict) else {},
        "competences_entretien": row.get("competences_entretien") if isinstance(row.get("competences_entretien"), list) else [],
    }


def _fetch_preparation(cur, id_entretien: str, id_effectif: str):
    cur.execute(
        """
        SELECT *
        FROM public.tbl_people_entretien_preparation
        WHERE id_entretien = %s
          AND id_effectif_client = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (id_entretien, id_effectif),
    )
    return cur.fetchone() or {}


def _fetch_competencies(cur, id_entretien: str, id_effectif: str, id_poste: str):
    if not id_poste:
        return []
    cur.execute(
        """
        SELECT
          c.id_comp,
          c.code,
          c.intitule,
          COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
          pc.niveau_requis,
          COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
          COALESCE(ae.niveau_auto_evalue, '') AS niveau_auto_evalue,
          COALESCE(ae.commentaire_partageable, '') AS commentaire_partageable,
          COALESCE(ae.besoin_accompagnement, FALSE) AS besoin_accompagnement
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
        LEFT JOIN public.tbl_people_entretien_auto_evaluation ae
          ON ae.id_entretien = %s
         AND ae.id_effectif_client = %s
         AND ae.id_comp = c.id_comp
         AND COALESCE(ae.archive, FALSE) = FALSE
        WHERE pc.id_poste = %s
          AND COALESCE(pc.masque, FALSE) = FALSE
        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
        """,
        (id_effectif, id_entretien, id_effectif, id_poste),
    )
    return cur.fetchall() or []


@router.get("/people/entretiens/{id_effectif}")
def people_entretiens_overview(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                cur.execute(
                    """
                    SELECT
                      e.*,
                      COALESCE(m.prenom_effectif, '') AS manager_prenom,
                      COALESCE(m.nom_effectif, '') AS manager_nom,
                      EXISTS (
                        SELECT 1 FROM public.tbl_entretien_individuel_document d
                        WHERE d.id_entretien = e.id_entretien
                          AND COALESCE(d.archive, FALSE) = FALSE
                      ) AS has_document,
                      EXISTS (
                        SELECT 1 FROM public.tbl_validations_electroniques v
                        WHERE v.id_document_ref = e.id_entretien
                          AND v.id_signataire = %s
                          AND COALESCE(v.archive, FALSE) = FALSE
                      ) AS employee_validated
                    FROM public.tbl_entretien_individuel e
                    LEFT JOIN public.tbl_effectif_client m
                      ON m.id_effectif = e.id_manager
                     AND COALESCE(m.archive, FALSE) = FALSE
                    WHERE e.id_ent = %s
                      AND e.id_effectif_client = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                    ORDER BY COALESCE(e.date_prevue, e.date_realisee, e.created_at::date) DESC, e.updated_at DESC
                    """,
                    (id_effectif, id_ent, id_effectif),
                )
                rows = cur.fetchall() or []
                current = None
                history = []
                for row in rows:
                    item = _serialize_interview(row)
                    item["has_document"] = bool(row.get("has_document"))
                    item["employee_validated"] = bool(row.get("employee_validated"))
                    if current is None and people_clean(row.get("statut")).lower() in OPEN_STATUSES:
                        current = item
                    else:
                        history.append(item)
                if current:
                    prep = _fetch_preparation(cur, current["id_entretien"], id_effectif)
                    current["preparation_people"] = {
                        "id_preparation": prep.get("id_preparation") or "",
                        "statut": prep.get("statut_preparation") or "non_commencee",
                        "date_transmission": people_clean(prep.get("date_transmission")),
                    }
                cur.execute(
                    """
                    SELECT id_demande_rh, type_demande, objet, statut, created_at
                    FROM public.tbl_insights_demande_rh
                    WHERE id_ent = %s
                      AND id_effectif_concerne = %s
                      AND origine = 'people'
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY created_at DESC
                    LIMIT 10
                    """,
                    (id_ent, id_effectif),
                )
                requests = cur.fetchall() or []
        return {"profile": profile, "current": current, "history": history, "requests": requests}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens error: {exc}")


@router.get("/people/entretiens/{id_effectif}/{id_entretien}")
def people_entretien_detail(id_effectif: str, id_entretien: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                row = _fetch_interview(cur, id_entretien, id_ent, id_effectif)
                interview = _serialize_interview(row)
                prep = _fetch_preparation(cur, id_entretien, id_effectif)
                competencies = _fetch_competencies(cur, id_entretien, id_effectif, profile.get("id_poste_actuel") or "")
                cur.execute(
                    """
                    SELECT id_document, type_document, nom_fichier, mime_type, taille_octets, created_at
                    FROM public.tbl_entretien_individuel_document
                    WHERE id_entretien = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY created_at DESC
                    """,
                    (id_entretien, id_ent),
                )
                documents = cur.fetchall() or []
                cur.execute(
                    """
                    SELECT type_signataire, mode_validation, date_validation, payload_validation
                    FROM public.tbl_validations_electroniques
                    WHERE id_document_ref = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_validation ASC
                    """,
                    (id_entretien,),
                )
                validations = cur.fetchall() or []
        return {
            "profile": profile,
            "entretien": interview,
            "preparation": prep,
            "competences": competencies,
            "documents": documents,
            "validations": validations,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens/detail error: {exc}")


@router.put("/people/entretiens/{id_effectif}/{id_entretien}/preparation")
def people_entretien_save_preparation(id_effectif: str, id_entretien: str, payload: PeoplePreparationPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                _fetch_interview(cur, id_entretien, id_ent, id_effectif)
                prep = _fetch_preparation(cur, id_entretien, id_effectif)
                id_preparation = prep.get("id_preparation") or str(uuid4())
                values = tuple(people_clean(getattr(payload, field)) for field in (
                    "bilan_periode", "reussites", "difficultes", "changements_poste", "sujets_a_aborder",
                    "souhaits_evolution", "souhaits_mobilite", "besoins_formation", "accompagnement_souhaite",
                    "elements_partageables", "notes_privees",
                ))
                cur.execute(
                    """
                    INSERT INTO public.tbl_people_entretien_preparation (
                      id_preparation, id_entretien, id_effectif_client, statut_preparation,
                      bilan_periode, reussites, difficultes, changements_poste, sujets_a_aborder,
                      souhaits_evolution, souhaits_mobilite, besoins_formation, accompagnement_souhaite,
                      elements_partageables, notes_privees, archive, created_at, updated_at
                    ) VALUES (
                      %s, %s, %s, 'brouillon', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, NOW(), NOW()
                    )
                    ON CONFLICT (id_entretien, id_effectif_client)
                    DO UPDATE SET
                      bilan_periode = EXCLUDED.bilan_periode,
                      reussites = EXCLUDED.reussites,
                      difficultes = EXCLUDED.difficultes,
                      changements_poste = EXCLUDED.changements_poste,
                      sujets_a_aborder = EXCLUDED.sujets_a_aborder,
                      souhaits_evolution = EXCLUDED.souhaits_evolution,
                      souhaits_mobilite = EXCLUDED.souhaits_mobilite,
                      besoins_formation = EXCLUDED.besoins_formation,
                      accompagnement_souhaite = EXCLUDED.accompagnement_souhaite,
                      elements_partageables = EXCLUDED.elements_partageables,
                      notes_privees = EXCLUDED.notes_privees,
                      statut_preparation = CASE WHEN tbl_people_entretien_preparation.statut_preparation = 'transmise' THEN 'transmise' ELSE 'brouillon' END,
                      updated_at = NOW()
                    RETURNING id_preparation, statut_preparation
                    """,
                    (id_preparation, id_entretien, id_effectif, *values),
                )
                saved = cur.fetchone() or {}
                for item in payload.items:
                    id_comp = people_clean(item.id_comp)
                    if not id_comp:
                        continue
                    cur.execute(
                        """
                        INSERT INTO public.tbl_people_entretien_auto_evaluation (
                          id_auto_evaluation, id_preparation, id_entretien, id_effectif_client, id_comp,
                          niveau_auto_evalue, commentaire_partageable, besoin_accompagnement,
                          statut, archive, created_at, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'brouillon', FALSE, NOW(), NOW())
                        ON CONFLICT (id_entretien, id_effectif_client, id_comp)
                        DO UPDATE SET
                          id_preparation = EXCLUDED.id_preparation,
                          niveau_auto_evalue = EXCLUDED.niveau_auto_evalue,
                          commentaire_partageable = EXCLUDED.commentaire_partageable,
                          besoin_accompagnement = EXCLUDED.besoin_accompagnement,
                          statut = CASE WHEN tbl_people_entretien_auto_evaluation.statut = 'transmise' THEN 'transmise' ELSE 'brouillon' END,
                          updated_at = NOW(),
                          archive = FALSE
                        """,
                        (
                            str(uuid4()), saved.get("id_preparation") or id_preparation, id_entretien, id_effectif, id_comp,
                            _clean_level(item.niveau_auto), people_clean(item.commentaire), bool(item.besoin_accompagnement),
                        ),
                    )
            conn.commit()
        return {"saved": True, "id_preparation": saved.get("id_preparation") or id_preparation, "statut": saved.get("statut_preparation") or "brouillon"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens/preparation/save error: {exc}")


@router.post("/people/entretiens/{id_effectif}/{id_entretien}/preparation/transmit")
def people_entretien_transmit_preparation(id_effectif: str, id_entretien: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                _fetch_interview(cur, id_entretien, id_ent, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_people_entretien_preparation
                    SET statut_preparation = 'transmise', date_transmission = NOW(), updated_at = NOW()
                    WHERE id_entretien = %s AND id_effectif_client = %s AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_preparation, date_transmission
                    """,
                    (id_entretien, id_effectif),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=400, detail="Enregistrez la préparation avant de la transmettre.")
                cur.execute(
                    """
                    UPDATE public.tbl_people_entretien_auto_evaluation
                    SET statut = 'transmise', date_transmission = NOW(), updated_at = NOW()
                    WHERE id_entretien = %s AND id_effectif_client = %s AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (id_entretien, id_effectif),
                )
            conn.commit()
        return {"transmitted": True, "date_transmission": people_clean(row.get("date_transmission"))}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens/preparation/transmit error: {exc}")


@router.post("/people/entretiens/{id_effectif}/request")
def people_entretien_request(id_effectif: str, payload: PeopleRequestPayload, request: Request):
    destinataire = people_clean(payload.destinataire).lower()
    if destinataire not in ("manager", "rh"):
        raise HTTPException(status_code=400, detail="Destinataire invalide.")
    motif = people_clean(payload.motif).lower()
    allowed = {"competences", "evolution", "formation", "organisation", "accompagnement", "autre"}
    if motif not in allowed:
        raise HTTPException(status_code=400, detail="Motif invalide.")
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                request_id = str(uuid4())
                object_text = people_clean(payload.objet) or f"Demande d'entretien {destinataire.upper()}"
                cur.execute(
                    """
                    INSERT INTO public.tbl_insights_demande_rh (
                      id_demande_rh, id_ent, id_demandeur, id_effectif_concerne,
                      nom_effectif, prenom_effectif, id_poste, id_service,
                      origine, source_type, source_ref, type_demande, objet, description,
                      statut, priorite, commentaire_salarie, payload_signal, archive, created_at, updated_at
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s, %s,
                      'people', 'demande_entretien', %s, 'entretien', %s, %s,
                      'a_qualifier', 'normale', %s, %s::jsonb, FALSE, NOW(), NOW()
                    )
                    RETURNING id_demande_rh
                    """,
                    (
                        request_id, id_ent, id_effectif, id_effectif,
                        profile.get("nom") or profile.get("nom_effectif") or "",
                        profile.get("prenom") or profile.get("prenom_effectif") or "",
                        profile.get("id_poste_actuel") or None, profile.get("id_service") or None,
                        request_id, object_text, people_clean(payload.description), people_clean(payload.description),
                        Json({"destinataire": destinataire, "motif": motif}),
                    ),
                )
            conn.commit()
        return {"created": True, "id_demande_rh": request_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens/request error: {exc}")


@router.get("/people/entretiens/{id_effectif}/{id_entretien}/documents/{id_document}")
def people_entretien_document(id_effectif: str, id_entretien: str, id_document: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = people_fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or profile.get("id_ent") or ""
                _fetch_interview(cur, id_entretien, id_ent, id_effectif)
                cur.execute(
                    """
                    SELECT nom_fichier, COALESCE(mime_type, 'application/octet-stream') AS mime_type, fichier
                    FROM public.tbl_entretien_individuel_document
                    WHERE id_document = %s AND id_entretien = %s AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_document, id_entretien, id_ent),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Document introuvable.")
        filename = str(row.get("nom_fichier") or "document-entretien").replace('"', "")
        return Response(
            content=bytes(row.get("fichier") or b""),
            media_type=row.get("mime_type") or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"people/entretiens/document error: {exc}")
