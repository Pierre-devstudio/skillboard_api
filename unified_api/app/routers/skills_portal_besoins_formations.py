from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import json
import uuid

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.skills_portal_analyse import (
    _resolve_id_ent_for_request,
    _fetch_service_label,
    _build_scope_cte,
    CRITICITE_MIN_DEFAULT,
)

router = APIRouter()

STATUT_ENVOYE = "envoye_studio"
STATUT_PRIS_EN_CHARGE = "pris_en_charge"
STATUT_TRAITE = "traite"
STATUTS = {STATUT_ENVOYE, STATUT_PRIS_EN_CHARGE, STATUT_TRAITE}


class BesoinFormationSendItem(BaseModel):
    id_comp: str
    id_poste: Optional[str] = None
    commentaire_client: Optional[str] = None


class BesoinFormationSendPayload(BaseModel):
    items: List[BesoinFormationSendItem]


def _s(v: Any) -> str:
    return ("" if v is None else str(v)).strip()


def _i(v: Any, default: int = 0) -> int:
    try:
        return int(v) if v is not None and str(v).strip() != "" else default
    except Exception:
        return default


def _label_statut(statut: str) -> str:
    s = _s(statut)
    return {
        "a_envoyer": "À envoyer",
        STATUT_ENVOYE: "Envoyé au Studio",
        STATUT_PRIS_EN_CHARGE: "Pris en charge",
        STATUT_TRAITE: "Traité",
    }.get(s, s or "—")


def _filter_statut(statut: str) -> str:
    s = _s(statut).lower()
    if s in ("", "tous", "all"):
        return "tous"
    if s in ("a_envoyer", "envoyer"):
        return "a_envoyer"
    return s if s in STATUTS else "tous"


def _scope_dict(scope) -> Dict[str, Any]:
    return scope.model_dump() if hasattr(scope, "model_dump") else scope.dict()


def _resolve_destination(cur, id_ent: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT COALESCE(NULLIF(e.id_owner_gestionnaire, ''), e.id_ent) AS id_owner
        FROM public.tbl_entreprise e
        WHERE e.id_ent = %s
        LIMIT 1
        """,
        (id_ent,),
    )
    r = cur.fetchone() or {}
    wanted_owner = _s(r.get("id_owner")) or id_ent

    cur.execute(
        """
        SELECT
            o.id_owner,
            o.nom_owner,
            o.type_owner,
            COALESCE(oc.studio_actif, FALSE) AS studio_actif,
            COALESCE(oc.learn_actif, FALSE) AS learn_actif
        FROM public.tbl_novoskill_owner o
        LEFT JOIN LATERAL (
            SELECT c.studio_actif, c.learn_actif
            FROM public.tbl_novoskill_owner_commercial c
            WHERE c.id_owner = o.id_owner
              AND COALESCE(c.archive, FALSE) = FALSE
              AND COALESCE(c.statut_commercial, 'actif') <> 'suspendu'
            ORDER BY c.date_debut DESC NULLS LAST, c.created_at DESC NULLS LAST
            LIMIT 1
        ) oc ON TRUE
        WHERE o.id_owner = %s
          AND COALESCE(o.archive, FALSE) = FALSE
          AND COALESCE(o.statut_owner, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (wanted_owner,),
    )
    owner = cur.fetchone()
    if owner and bool(owner.get("studio_actif")):
        return {
            "can_send": True,
            "id_owner": owner.get("id_owner"),
            "nom_owner": owner.get("nom_owner"),
            "type_owner": owner.get("type_owner"),
            "studio_actif": True,
            "learn_actif": bool(owner.get("learn_actif")),
            "reason": None,
        }

    if wanted_owner != id_ent:
        cur.execute(
            """
            SELECT
                o.id_owner,
                o.nom_owner,
                o.type_owner,
                COALESCE(oc.studio_actif, FALSE) AS studio_actif,
                COALESCE(oc.learn_actif, FALSE) AS learn_actif
            FROM public.tbl_novoskill_owner o
            LEFT JOIN LATERAL (
                SELECT c.studio_actif, c.learn_actif
                FROM public.tbl_novoskill_owner_commercial c
                WHERE c.id_owner = o.id_owner
                  AND COALESCE(c.archive, FALSE) = FALSE
                  AND COALESCE(c.statut_commercial, 'actif') <> 'suspendu'
                ORDER BY c.date_debut DESC NULLS LAST, c.created_at DESC NULLS LAST
                LIMIT 1
            ) oc ON TRUE
            WHERE o.id_owner = %s
              AND COALESCE(o.archive, FALSE) = FALSE
              AND COALESCE(o.statut_owner, 'actif') <> 'suspendu'
            LIMIT 1
            """,
            (id_ent,),
        )
        owner = cur.fetchone()
        if owner and bool(owner.get("studio_actif")):
            return {
                "can_send": True,
                "id_owner": owner.get("id_owner"),
                "nom_owner": owner.get("nom_owner"),
                "type_owner": owner.get("type_owner"),
                "studio_actif": True,
                "learn_actif": bool(owner.get("learn_actif")),
                "reason": None,
            }

    return {
        "can_send": False,
        "id_owner": wanted_owner,
        "studio_actif": False,
        "learn_actif": False,
        "reason": "Aucun Studio destinataire actif n’est configuré pour cette entreprise.",
    }


def _fetch_current(cur, id_ent: str, id_service: Optional[str], criticite_min: int, id_owner_dest: str, limit: int) -> List[Dict[str, Any]]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    sql = f"""
    WITH
    {cte_sql},
    req AS (
        SELECT DISTINCT
            fp.id_poste,
            fp.codif_poste,
            fp.codif_client,
            fp.intitule_poste,
            fp.id_service,
            org.nom_service,
            c.id_comp,
            c.code,
            c.intitule,
            UPPER(TRIM(COALESCE(fpc.niveau_requis, ''))) AS niveau_requis,
            COALESCE(fpc.poids_criticite, 0)::int AS criticite,
            CASE UPPER(TRIM(COALESCE(fpc.niveau_requis, '')))
                WHEN 'C' THEN 3 WHEN 'B' THEN 2 WHEN 'A' THEN 1 ELSE 0
            END AS niveau_requis_score
        FROM public.tbl_fiche_poste_competence fpc
        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
        JOIN public.tbl_fiche_poste fp ON fp.id_poste = fpc.id_poste
        JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
        LEFT JOIN public.tbl_entreprise_organigramme org
               ON org.id_service = fp.id_service
              AND org.id_ent = fp.id_ent
              AND COALESCE(org.archive, FALSE) = FALSE
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND COALESCE(fpc.masque, FALSE) = FALSE
          AND COALESCE(c.masque, FALSE) = FALSE
          AND COALESCE(c.etat, 'active') = 'active'
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ),
    effectifs_poste AS (
        SELECT e.id_effectif, e.id_poste_actuel, e.date_sortie_prevue, e.retraite_estimee
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
    ),
    eval_comp AS (
        SELECT
            ec.id_effectif_client,
            ec.id_comp,
            CASE
              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$' THEN
                CASE WHEN trim(ec.niveau_actuel)::int >= 19 THEN 3
                     WHEN trim(ec.niveau_actuel)::int >= 10 THEN 2
                     WHEN trim(ec.niveau_actuel)::int >= 6 THEN 1
                     ELSE 0 END
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' OR ec.niveau_actuel ILIKE '%%expert%%' THEN 3
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'B' OR ec.niveau_actuel ILIKE '%%avanc%%' THEN 2
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'A' OR ec.niveau_actuel ILIKE '%%initial%%' THEN 1
              ELSE 0
            END AS niveau_score
        FROM public.tbl_effectif_client_competence ec
        WHERE COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
    ),
    breaks_now AS (
        SELECT DISTINCT b.id_effectif
        FROM public.tbl_effectif_client_break b
        WHERE COALESCE(b.archive, FALSE) = FALSE
          AND b.date_debut <= CURRENT_DATE
          AND b.date_fin >= CURRENT_DATE
    ),
    porteurs AS (
        SELECT
            ec.id_comp,
            COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs,
            COUNT(DISTINCT ec.id_effectif_client) FILTER (WHERE bn.id_effectif IS NULL)::int AS nb_porteurs_dispo,
            COUNT(DISTINCT ec.id_effectif_client) FILTER (
                WHERE e.date_sortie_prevue IS NOT NULL
                  AND e.date_sortie_prevue <= (CURRENT_DATE + interval '5 years')::date
            )::int AS nb_sorties_prevues,
            COUNT(DISTINCT ec.id_effectif_client) FILTER (
                WHERE e.retraite_estimee IS NOT NULL
                  AND e.retraite_estimee <= (EXTRACT(YEAR FROM CURRENT_DATE)::int + 5)
            )::int AS nb_retraites_estimees,
            COUNT(DISTINCT ec.id_effectif_client) FILTER (WHERE bn.id_effectif IS NOT NULL)::int AS nb_indispos_actuelles
        FROM public.tbl_effectif_client_competence ec
        JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
        JOIN public.tbl_effectif_client e ON e.id_effectif = ec.id_effectif_client
        LEFT JOIN breaks_now bn ON bn.id_effectif = ec.id_effectif_client
        WHERE COALESCE(ec.actif, TRUE) = TRUE
          AND COALESCE(ec.archive, FALSE) = FALSE
          AND COALESCE(e.archive, FALSE) = FALSE
        GROUP BY ec.id_comp
    ),
    agg AS (
        SELECT
            r.*,
            COUNT(DISTINCT ep.id_effectif)::int AS nb_titulaires_poste,
            COUNT(DISTINCT ep.id_effectif) FILTER (WHERE COALESCE(ev.niveau_score, 0) < r.niveau_requis_score)::int AS nb_personnes_a_former,
            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs,
            COALESCE(p.nb_porteurs_dispo, 0)::int AS nb_porteurs_dispo,
            COALESCE(p.nb_sorties_prevues, 0)::int AS nb_sorties_prevues,
            COALESCE(p.nb_retraites_estimees, 0)::int AS nb_retraites_estimees,
            COALESCE(p.nb_indispos_actuelles, 0)::int AS nb_indispos_actuelles,
            (
                SELECT COUNT(*)::int
                FROM public.tbl_fiche_formation ff
                WHERE ff.id_owner = %s
                  AND COALESCE(ff.archive, FALSE) = FALSE
                  AND COALESCE(ff.masque, FALSE) = FALSE
                  AND COALESCE(ff.etat, 'active') = 'active'
                  AND (
                        COALESCE(ff.competences_stagiaires, '[]'::jsonb) @> jsonb_build_array(r.id_comp)
                     OR COALESCE(ff.competences_formateurs, '[]'::jsonb) @> jsonb_build_array(r.id_comp)
                  )
            ) AS nb_formations_existantes
        FROM req r
        LEFT JOIN effectifs_poste ep ON ep.id_poste_actuel = r.id_poste
        LEFT JOIN eval_comp ev ON ev.id_effectif_client = ep.id_effectif AND ev.id_comp = r.id_comp
        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
        GROUP BY r.id_poste, r.codif_poste, r.codif_client, r.intitule_poste, r.id_service, r.nom_service,
                 r.id_comp, r.code, r.intitule, r.niveau_requis, r.criticite, r.niveau_requis_score,
                 p.nb_porteurs, p.nb_porteurs_dispo, p.nb_sorties_prevues, p.nb_retraites_estimees, p.nb_indispos_actuelles
    ),
    scored AS (
        SELECT
            a.*,
            LEAST(100, GREATEST(0, ROUND(
                0.30 * CASE WHEN a.nb_titulaires_poste <= 0 THEN 80 ELSE 100.0 * a.nb_personnes_a_former / NULLIF(a.nb_titulaires_poste, 0) END
              + 0.25 * a.criticite
              + 0.20 * CASE WHEN a.nb_porteurs <= 0 THEN 100
                            WHEN a.nb_porteurs = 1 THEN 85
                            WHEN (a.nb_sorties_prevues + a.nb_retraites_estimees) >= a.nb_porteurs THEN 95
                            ELSE 100.0 * (a.nb_sorties_prevues + a.nb_retraites_estimees) / NULLIF(a.nb_porteurs, 0) END
              + 0.15 * CASE WHEN a.nb_porteurs <= 0 THEN 100
                            WHEN a.nb_porteurs_dispo <= 0 THEN 95
                            WHEN a.nb_indispos_actuelles > 0 THEN 70
                            ELSE 0 END
              + 0.10 * CASE WHEN a.nb_porteurs <= 0 THEN 100
                            WHEN a.nb_porteurs = 1 THEN 80
                            WHEN a.nb_porteurs = 2 THEN 50
                            ELSE 15 END
            )))::int AS score_anticipation
        FROM agg a
    )
    SELECT
        s.*,
        CASE WHEN s.score_anticipation >= 80 THEN 'Urgent'
             WHEN s.score_anticipation >= 65 THEN 'À sécuriser'
             WHEN s.score_anticipation >= 45 THEN 'À anticiper'
             ELSE 'À surveiller' END AS priorite,
        CASE WHEN s.nb_porteurs <= 0 THEN 'Aucun porteur identifié'
             WHEN s.nb_porteurs_dispo <= 0 THEN 'Porteurs indisponibles actuellement'
             WHEN s.nb_porteurs = 1 THEN 'Compétence portée par une seule personne'
             WHEN (s.nb_sorties_prevues + s.nb_retraites_estimees) > 0 THEN 'Risque de sortie à horizon 5 ans'
             WHEN s.nb_personnes_a_former > 0 THEN 'Écart de niveau sur les titulaires du poste'
             WHEN s.criticite >= 80 THEN 'Criticité élevée'
             ELSE 'À surveiller' END AS motif_priorite
    FROM scored s
    ORDER BY s.score_anticipation DESC, s.criticite DESC, s.nb_personnes_a_former DESC, s.code
    LIMIT %s
    """
    cur.execute(sql, tuple(cte_params + [id_ent, criticite_min, id_owner_dest or "", limit]))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    for r in rows:
        r["indice_fragilite"] = _i(r.get("score_anticipation"))
        r["formation_existante"] = _i(r.get("nb_formations_existantes")) > 0
        r["source_type"] = "analyse_competences"
        r["is_signal_actuel"] = True
    return rows


def _fetch_demandes(cur, id_ent: str, id_owner_dest: str) -> List[Dict[str, Any]]:
    if not id_owner_dest:
        return []
    cur.execute(
        """
        SELECT *
        FROM public.tbl_insights_besoin_formation
        WHERE id_ent_source = %s
          AND id_owner_destinataire = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY created_at DESC
        """,
        (id_ent, id_owner_dest),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _merge(current: List[Dict[str, Any]], demandes: List[Dict[str, Any]], statut_filter: str, fragilite_min: int):
    d_by_key = {}
    for d in demandes:
        key = (_s(d.get("id_comp")), _s(d.get("id_poste")))
        if key[0] and key not in d_by_key:
            d_by_key[key] = d

    rows, seen = [], set()
    for c in current:
        if _i(c.get("score_anticipation")) < fragilite_min:
            continue
        key = (_s(c.get("id_comp")), _s(c.get("id_poste")))
        seen.add(key)
        d = d_by_key.get(key)
        statut = _s(d.get("statut")) if d else "a_envoyer"
        if statut_filter != "tous" and statut != statut_filter:
            continue
        item = dict(c)
        item.update({
            "id_besoin_formation": d.get("id_besoin_formation") if d else None,
            "statut": statut,
            "statut_label": _label_statut(statut),
            "commentaire_client": d.get("commentaire_client") if d else "",
            "created_at": d.get("created_at") if d else None,
            "updated_at": d.get("updated_at") if d else None,
        })
        rows.append(item)

    for d in demandes:
        key = (_s(d.get("id_comp")), _s(d.get("id_poste")))
        if key in seen:
            continue
        statut = _s(d.get("statut")) or STATUT_ENVOYE
        if statut_filter not in ("tous", statut):
            continue
        rows.append({
            "id_besoin_formation": d.get("id_besoin_formation"),
            "id_comp": d.get("id_comp"),
            "code": d.get("code_competence"),
            "intitule": d.get("intitule_competence"),
            "id_poste": d.get("id_poste"),
            "intitule_poste": d.get("intitule_poste"),
            "id_service": d.get("id_service"),
            "nom_service": d.get("nom_service"),
            "niveau_requis": d.get("niveau_attendu"),
            "criticite": _i(d.get("criticite")),
            "indice_fragilite": _i(d.get("indice_fragilite")),
            "score_anticipation": _i(d.get("score_anticipation")),
            "priorite": d.get("priorite") or "À suivre",
            "motif_priorite": d.get("motif_priorite") or "Demande déjà émise",
            "nb_formations_existantes": _i(d.get("nb_formations_existantes")),
            "formation_existante": bool(d.get("formation_existante")),
            "source_type": d.get("source_type") or "analyse_competences",
            "is_signal_actuel": False,
            "statut": statut,
            "statut_label": _label_statut(statut),
            "commentaire_client": d.get("commentaire_client") or "",
            "created_at": d.get("created_at"),
            "updated_at": d.get("updated_at"),
        })

    rows.sort(key=lambda x: (0 if x.get("statut") == "a_envoyer" else 1, -_i(x.get("score_anticipation")), -_i(x.get("criticite"))))
    kpis = {
        "total": len(rows),
        "a_envoyer": sum(1 for x in rows if x.get("statut") == "a_envoyer"),
        "envoye_studio": sum(1 for x in rows if x.get("statut") == STATUT_ENVOYE),
        "pris_en_charge": sum(1 for x in rows if x.get("statut") == STATUT_PRIS_EN_CHARGE),
        "traite": sum(1 for x in rows if x.get("statut") == STATUT_TRAITE),
        "formation_existante": sum(1 for x in rows if x.get("formation_existante")),
        "risque_5_ans": sum(1 for x in rows if (_i(x.get("nb_sorties_prevues")) + _i(x.get("nb_retraites_estimees"))) > 0),
        "indisponibilite": sum(1 for x in rows if _i(x.get("nb_indispos_actuelles")) > 0),
    }
    return rows, kpis


@router.get("/skills/besoins-formations/{id_contact}")
def get_besoins_formations(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=0, le=100),
    fragilite_min: int = Query(default=0, ge=0, le=100),
    statut: str = Query(default="tous"),
    limit: int = Query(default=200, ge=1, le=500),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, _s(id_service) or None)
                dest = _resolve_destination(cur, id_ent)
                id_owner_dest = _s(dest.get("id_owner"))
                current = _fetch_current(cur, id_ent, scope.id_service, criticite_min, id_owner_dest, limit)
                demandes = _fetch_demandes(cur, id_ent, id_owner_dest)
                items, kpis = _merge(current, demandes, _filter_statut(statut), fragilite_min)
                return {
                    "scope": _scope_dict(scope),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "filters": {
                        "criticite_min": criticite_min,
                        "fragilite_min": fragilite_min,
                        "statut": _filter_statut(statut),
                        "horizon_years": 5,
                    },
                    "destination": dest,
                    "kpis": kpis,
                    "items": items,
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur besoins & formations : {e}")


@router.post("/skills/besoins-formations/{id_contact}/envoyer")
def envoyer_besoins_formations(id_contact: str, payload: BesoinFormationSendPayload, request: Request):
    try:
        if not payload.items:
            raise HTTPException(status_code=400, detail="Aucun besoin à envoyer.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                dest = _resolve_destination(cur, id_ent)
                if not dest.get("can_send"):
                    raise HTTPException(status_code=400, detail=dest.get("reason") or "Studio destinataire indisponible.")

                id_owner_dest = _s(dest.get("id_owner"))
                current = _fetch_current(cur, id_ent, None, 0, id_owner_dest, 500)
                by_key = {(_s(x.get("id_comp")), _s(x.get("id_poste"))): x for x in current}

                created, updated, skipped = 0, 0, 0
                saved_items = []

                for p in payload.items:
                    id_comp = _s(p.id_comp)
                    id_poste = _s(p.id_poste)
                    signal = by_key.get((id_comp, id_poste))
                    if not id_comp or not signal:
                        skipped += 1
                        continue

                    commentaire = _s(p.commentaire_client)
                    payload_signal = json.dumps({
                        "source": "analyse_competences",
                        "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        "id_ent": id_ent,
                        "id_comp": id_comp,
                        "id_poste": id_poste or None,
                        "code": signal.get("code"),
                        "intitule": signal.get("intitule"),
                        "intitule_poste": signal.get("intitule_poste"),
                        "niveau_requis": signal.get("niveau_requis"),
                        "criticite": _i(signal.get("criticite")),
                        "score_anticipation": _i(signal.get("score_anticipation")),
                        "nb_personnes_a_former": _i(signal.get("nb_personnes_a_former")),
                        "nb_porteurs": _i(signal.get("nb_porteurs")),
                        "nb_porteurs_dispo": _i(signal.get("nb_porteurs_dispo")),
                        "nb_sorties_prevues": _i(signal.get("nb_sorties_prevues")),
                        "nb_retraites_estimees": _i(signal.get("nb_retraites_estimees")),
                        "nb_indispos_actuelles": _i(signal.get("nb_indispos_actuelles")),
                    }, ensure_ascii=False)

                    cur.execute(
                        """
                        SELECT id_besoin_formation
                        FROM public.tbl_insights_besoin_formation
                        WHERE id_ent_source = %s
                          AND id_owner_destinataire = %s
                          AND id_comp = %s
                          AND COALESCE(id_poste, '') = COALESCE(%s, '')
                          AND COALESCE(archive, FALSE) = FALSE
                          AND statut IN ('envoye_studio', 'pris_en_charge')
                        ORDER BY created_at DESC
                        LIMIT 1
                        """,
                        (id_ent, id_owner_dest, id_comp, id_poste or None),
                    )
                    existing = cur.fetchone()

                    values = (
                        payload_signal,
                        _i(signal.get("indice_fragilite")),
                        _i(signal.get("score_anticipation")),
                        _i(signal.get("criticite")),
                        signal.get("priorite"),
                        signal.get("motif_priorite"),
                        bool(signal.get("formation_existante")),
                        _i(signal.get("nb_formations_existantes")),
                    )

                    if existing:
                        cur.execute(
                            """
                            UPDATE public.tbl_insights_besoin_formation
                            SET commentaire_client = CASE WHEN %s <> '' THEN %s ELSE commentaire_client END,
                                payload_signal = %s::jsonb,
                                indice_fragilite = %s,
                                score_anticipation = %s,
                                criticite = %s,
                                priorite = %s,
                                motif_priorite = %s,
                                formation_existante = %s,
                                nb_formations_existantes = %s,
                                updated_at = NOW()
                            WHERE id_besoin_formation = %s
                            RETURNING id_besoin_formation, statut
                            """,
                            (commentaire, commentaire, *values, existing.get("id_besoin_formation")),
                        )
                        updated += 1
                    else:
                        cur.execute(
                            """
                            INSERT INTO public.tbl_insights_besoin_formation (
                                id_besoin_formation, id_owner_destinataire, id_ent_source, id_effectif_demandeur,
                                source_console, source_type,
                                id_comp, code_competence, intitule_competence,
                                id_poste, intitule_poste, id_service, nom_service, niveau_attendu,
                                criticite, indice_fragilite, score_anticipation, priorite, motif_priorite,
                                commentaire_client, formation_existante, nb_formations_existantes,
                                statut, payload_signal, archive, created_at, updated_at
                            ) VALUES (
                                %s, %s, %s, %s,
                                'insights', 'analyse_competences',
                                %s, %s, %s,
                                %s, %s, %s, %s, %s,
                                %s, %s, %s, %s, %s,
                                %s, %s, %s,
                                'envoye_studio', %s::jsonb, FALSE, NOW(), NOW()
                            )
                            RETURNING id_besoin_formation, statut
                            """,
                            (
                                str(uuid.uuid4()), id_owner_dest, id_ent, id_contact,
                                id_comp, signal.get("code"), signal.get("intitule"),
                                signal.get("id_poste"), signal.get("intitule_poste"), signal.get("id_service"), signal.get("nom_service"), signal.get("niveau_requis"),
                                _i(signal.get("criticite")), _i(signal.get("indice_fragilite")), _i(signal.get("score_anticipation")), signal.get("priorite"), signal.get("motif_priorite"),
                                commentaire, bool(signal.get("formation_existante")), _i(signal.get("nb_formations_existantes")), payload_signal,
                            ),
                        )
                        created += 1
                    saved_items.append(cur.fetchone() or {})

                conn.commit()
                return {
                    "ok": True,
                    "created": created,
                    "updated": updated,
                    "skipped": skipped,
                    "items": saved_items,
                    "message": f"{created + updated} besoin(s) envoyé(s) au Studio.",
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur envoi besoin formation : {e}")