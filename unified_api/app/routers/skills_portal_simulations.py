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
    comparer_simulation_scenarios_payload,
)

router = APIRouter()


class SimulationScenarioSaveRequest(BaseModel):
    titre: str
    objectif: Optional[str] = None
    id_poste_focus: Optional[str] = None
    hypotheses: List[Dict[str, Any]] = []
    resultat: Dict[str, Any] = {}


class SimulationScenarioCompareRequest(BaseModel):
    ids: List[str] = []


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




@router.get("/skills/simulations/scenarios/{id_contact}")
def lister_simulation_scenarios(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    limit: int = Query(default=80, ge=1, le=200),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)
                params: List[Any] = [id_ent]
                service_sql = ""
                if scope.id_service:
                    service_sql = " AND id_service = %s"
                    params.append(scope.id_service)
                params.append(int(limit))

                cur.execute(
                    f"""
                    SELECT
                        id_scenario,
                        id_contact,
                        id_service,
                        titre,
                        objectif,
                        id_poste_focus,
                        criticite_min,
                        scenario_json,
                        hypotheses_json,
                        resultat_json,
                        created_at,
                        updated_at
                    FROM public.tbl_insights_simulation_scenario
                    WHERE id_ent = %s
                      {service_sql}
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(masque, FALSE) = FALSE
                    ORDER BY created_at DESC
                    LIMIT %s
                    """,
                    tuple(params),
                )
                rows = [dict(r) for r in (cur.fetchall() or [])]
                items = []
                for row in rows:
                    result = row.get("resultat_json") or {}
                    scenario = row.get("scenario_json") or {}
                    focus = result.get("poste_focus") or {}
                    developpement = result.get("developpement") or {}
                    besoins = developpement.get("besoins_formation") or []
                    resultats = result.get("resultats") or {}
                    final_summary = (resultats.get("projete") or {}).get("summary") or (resultats.get("immediat") or {}).get("summary") or result.get("simule") or {}
                    current_summary = result.get("actuel") or {}
                    impact = (resultats.get("projete") or {}).get("impact") or result.get("impact") or {}
                    try:
                        impact_poste_pct = int(round(float(focus.get("fragilite_projete") or 0) - float(focus.get("fragilite_avant") or 0)))
                    except Exception:
                        impact_poste_pct = 0
                    try:
                        impact_global_pct = int(round(float(final_summary.get("fragilite_moyenne") or 0) - float(current_summary.get("fragilite_moyenne") or 0)))
                    except Exception:
                        impact_global_pct = 0
                    items.append({
                        "id_scenario": row.get("id_scenario"),
                        "titre": row.get("titre"),
                        "objectif": row.get("objectif") or "",
                        "id_poste_focus": row.get("id_poste_focus"),
                        "criticite_min": row.get("criticite_min"),
                        "id_service": row.get("id_service"),
                        "created_at": row.get("created_at"),
                        "updated_at": row.get("updated_at"),
                        "scope": result.get("scope") or scenario.get("scope") or {},
                        "poste_focus": {
                            "codif_client": focus.get("codif_client") or "",
                            "codif_poste": focus.get("codif_poste") or "",
                            "intitule_poste": focus.get("intitule_poste") or "",
                            "fragilite_avant": focus.get("fragilite_avant"),
                            "fragilite_projete": focus.get("fragilite_projete"),
                        },
                        "resume": {
                            "impact_poste_pct": impact_poste_pct,
                            "impact_global_pct": impact_global_pct,
                            "besoins_count": len(besoins),
                            "postes_degrades": impact.get("postes_degrades", 0),
                            "postes_securises": impact.get("postes_securises", 0),
                        },
                    })
                return {"items": items, "scope": scope.dict() if hasattr(scope, "dict") else dict(scope or {})}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/scenarios list error: {e}")


@router.get("/skills/simulations/scenarios/{id_contact}/{id_scenario}")
def lire_simulation_scenario(
    id_contact: str,
    id_scenario: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                cur.execute(
                    """
                    SELECT
                        id_scenario,
                        id_contact,
                        id_service,
                        titre,
                        objectif,
                        id_poste_focus,
                        criticite_min,
                        scenario_json,
                        hypotheses_json,
                        resultat_json,
                        created_at,
                        updated_at
                    FROM public.tbl_insights_simulation_scenario
                    WHERE id_ent = %s
                      AND id_scenario = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_ent, id_scenario),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Scénario introuvable ou archivé.")
                data = dict(row)
                result = data.get("resultat_json") or {}
                if isinstance(result, dict):
                    result["id_scenario"] = data.get("id_scenario")
                    result["titre"] = data.get("titre") or result.get("titre")
                    result["titre_nom"] = data.get("titre") or result.get("titre_nom")
                    result["hypotheses"] = data.get("hypotheses_json") or result.get("hypotheses") or []
                    result["criticite_min"] = data.get("criticite_min")
                return {
                    "id_scenario": data.get("id_scenario"),
                    "titre": data.get("titre"),
                    "objectif": data.get("objectif") or "",
                    "id_poste_focus": data.get("id_poste_focus"),
                    "criticite_min": data.get("criticite_min"),
                    "id_service": data.get("id_service"),
                    "scenario_json": data.get("scenario_json") or {},
                    "hypotheses_json": data.get("hypotheses_json") or [],
                    "resultat_json": result,
                    "created_at": data.get("created_at"),
                    "updated_at": data.get("updated_at"),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/scenarios detail error: {e}")


@router.post("/skills/simulations/scenarios/{id_contact}/comparer")
def comparer_simulation_scenarios(
    id_contact: str,
    payload: SimulationScenarioCompareRequest,
    request: Request,
):
    try:
        ids = []
        for raw in payload.ids or []:
            sid = str(raw or "").strip()
            if sid and sid not in ids:
                ids.append(sid)
        ids = ids[:4]
        if len(ids) < 2:
            raise HTTPException(status_code=400, detail="Sélectionnez au moins deux scénarios à comparer.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                cur.execute(
                    """
                    SELECT
                        id_scenario,
                        titre,
                        objectif,
                        id_poste_focus,
                        criticite_min,
                        scenario_json,
                        hypotheses_json,
                        resultat_json,
                        created_at
                    FROM public.tbl_insights_simulation_scenario
                    WHERE id_ent = %s
                      AND id_scenario = ANY(%s::text[])
                      AND COALESCE(archive, FALSE) = FALSE
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (id_ent, ids),
                )
                rows = [dict(r) for r in (cur.fetchall() or [])]
                by_id = {str(r.get("id_scenario") or ""): r for r in rows}
                ordered = [by_id[sid] for sid in ids if sid in by_id]
                if len(ordered) < 2:
                    raise HTTPException(status_code=404, detail="Scénarios introuvables ou archivés.")

                compact_items: List[Dict[str, Any]] = []
                for row in ordered:
                    result = row.get("resultat_json") or {}
                    focus = result.get("poste_focus") or {}
                    resultats = result.get("resultats") or {}
                    final_summary = (resultats.get("projete") or {}).get("summary") or (resultats.get("immediat") or {}).get("summary") or result.get("simule") or {}
                    current_summary = result.get("actuel") or {}
                    impact = (resultats.get("projete") or {}).get("impact") or result.get("impact") or {}
                    besoins = (result.get("developpement") or {}).get("besoins_formation") or []
                    hypotheses = row.get("hypotheses_json") or result.get("hypotheses") or []
                    try:
                        impact_poste_pct = int(round(float(focus.get("fragilite_projete") or 0) - float(focus.get("fragilite_avant") or 0)))
                    except Exception:
                        impact_poste_pct = 0
                    try:
                        impact_global_pct = int(round(float(final_summary.get("fragilite_moyenne") or 0) - float(current_summary.get("fragilite_moyenne") or 0)))
                    except Exception:
                        impact_global_pct = 0
                    compact_items.append({
                        "id_scenario": row.get("id_scenario"),
                        "titre": row.get("titre") or "Scénario RH",
                        "poste": {
                            "code": focus.get("codif_client") or focus.get("codif_poste") or "",
                            "intitule": focus.get("intitule_poste") or "Poste étudié",
                        },
                        "perimetre": (result.get("scope") or (row.get("scenario_json") or {}).get("scope") or {}).get("nom_service") or "Tous les services",
                        "hypotheses": [
                            {
                                "type": h.get("type") if isinstance(h, dict) else "",
                                "libelle": h.get("libelle") if isinstance(h, dict) else "",
                            }
                            for h in hypotheses[:8]
                        ],
                        "resultats": {
                            "impact_poste_pct": impact_poste_pct,
                            "impact_global_pct": impact_global_pct,
                            "besoins": len(besoins),
                            "postes_ameliore": impact.get("postes_securises", 0),
                            "postes_degrade": impact.get("postes_degrades", 0),
                        },
                    })

                return {
                    "items": compact_items,
                    "analyse": comparer_simulation_scenarios_payload(compact_items),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/scenarios comparer error: {e}")


@router.delete("/skills/simulations/scenarios/{id_contact}/{id_scenario}")
def supprimer_simulation_scenario(
    id_contact: str,
    id_scenario: str,
    request: Request,
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                cur.execute(
                    """
                    UPDATE public.tbl_insights_simulation_scenario
                    SET archive = TRUE, updated_at = NOW()
                    WHERE id_ent = %s
                      AND id_scenario = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_scenario
                    """,
                    (id_ent, id_scenario),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Scénario introuvable ou déjà supprimé.")
                conn.commit()
                return {"id_scenario": row.get("id_scenario"), "archive": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"skills/simulations/scenarios delete error: {e}")


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
