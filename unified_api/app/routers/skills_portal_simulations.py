from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from typing import Optional, Dict, Any, List
import json
import uuid

from psycopg.rows import dict_row
from pydantic import BaseModel

from app.routers.skills_portal_common import get_conn, resolve_insights_id_ent_for_request
from app.services.skills_analyse_engine import (
    CRITICITE_MIN_DEFAULT,
    CRITICITE_MIN_MIN,
    CRITICITE_MIN_MAX,
    _fetch_service_label,
)
from app.services.skills_simulation_engine import (
    SimulationEvalRequest,
    analyser_cv_recrutement_payload,
    build_simulation_options_payload,
    evaluate_simulation_payload,
)

router = APIRouter()


class SimulationScenarioSaveRequest(BaseModel):
    titre: str
    objectif: Optional[str] = None
    id_poste_focus: Optional[str] = None
    hypotheses: List[Dict[str, Any]] = []
    resultat: Dict[str, Any] = {}


def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)


@router.get("/skills/simulations/options/{id_contact}")
def get_simulation_options(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                return build_simulation_options_payload(cur, id_ent, scope, int(criticite_min))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/options error: {e}")


@router.post("/skills/simulations/analyse-cv/{id_contact}")
def analyser_cv_simulation(
    id_contact: str,
    request: Request,
    id_poste: str = Form(...),
    projet_professionnel: Optional[str] = Form(default=None),
    cv_file: UploadFile = File(...),
    motivation_file: Optional[UploadFile] = File(default=None),
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        raw = cv_file.file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="CV vide ou illisible.")
        if len(raw) > 8 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="CV trop volumineux : limite 8 Mo.")

        motivation_raw = b""
        motivation_filename = ""
        motivation_content_type = ""
        if motivation_file and motivation_file.filename:
            motivation_raw = motivation_file.file.read() or b""
            motivation_filename = motivation_file.filename or ""
            motivation_content_type = motivation_file.content_type or ""
            if len(motivation_raw) > 4 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Lettre de motivation trop volumineuse : limite 4 Mo.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                result = analyser_cv_recrutement_payload(
                    cur,
                    id_ent,
                    id_contact,
                    scope,
                    id_poste,
                    cv_file.filename or "cv",
                    cv_file.content_type or "",
                    raw,
                    projet_professionnel or "",
                    motivation_filename,
                    motivation_content_type,
                    motivation_raw,
                    int(criticite_min),
                )
                conn.commit()
                return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/analyse-cv error: {e}")


@router.post("/skills/simulations/scenarios/{id_contact}")
def conserver_simulation_scenario(
    id_contact: str,
    payload: SimulationScenarioSaveRequest,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        titre = (payload.titre or "").strip()
        if not titre:
            raise HTTPException(status_code=400, detail="Le nom du scénario est obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                id_scenario = str(uuid.uuid4())
                scenario_json = {
                    "titre": titre,
                    "objectif": payload.objectif or "",
                    "id_poste_focus": payload.id_poste_focus or None,
                    "criticite_min": int(criticite_min),
                    "scope": scope.dict() if hasattr(scope, "dict") else dict(scope or {}),
                }
                cur.execute(
                    """
                    INSERT INTO public.tbl_insights_simulation_scenario (
                        id_scenario,
                        id_ent,
                        id_contact,
                        id_service,
                        titre,
                        objectif,
                        id_poste_focus,
                        criticite_min,
                        scenario_json,
                        hypotheses_json,
                        resultat_json,
                        archive,
                        masque,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s::jsonb, %s::jsonb, %s::jsonb,
                        FALSE, FALSE, NOW(), NOW()
                    )
                    """,
                    (
                        id_scenario,
                        id_ent,
                        id_contact,
                        scope.id_service,
                        titre,
                        payload.objectif or "",
                        payload.id_poste_focus or None,
                        int(criticite_min),
                        json.dumps(scenario_json, ensure_ascii=False),
                        json.dumps(payload.hypotheses or [], ensure_ascii=False),
                        json.dumps(payload.resultat or {}, ensure_ascii=False),
                    ),
                )
                conn.commit()
                return {
                    "id_scenario": id_scenario,
                    "titre": titre,
                    "saved_at": "now",
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/scenarios error: {e}")


@router.post("/skills/simulations/evaluer/{id_contact}")
def evaluer_simulation(
    id_contact: str,
    payload: SimulationEvalRequest,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=CRITICITE_MIN_MIN, le=CRITICITE_MIN_MAX),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                return evaluate_simulation_payload(cur, id_ent, scope, payload, int(criticite_min))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/evaluer error: {e}")
