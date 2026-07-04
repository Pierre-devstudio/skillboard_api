from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import json
import uuid

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn, resolve_insights_id_ent_for_request
from app.services.skills_analyse_engine import (
    _fetch_service_label,
    _build_scope_cte,
    CRITICITE_MIN_DEFAULT,
)

router = APIRouter()

STATUT_ENVOYE = "envoye_studio"
STATUT_PRIS_EN_CHARGE = "pris_en_charge"
STATUT_TRAITE = "traite"
STATUTS = {STATUT_ENVOYE, STATUT_PRIS_EN_CHARGE, STATUT_TRAITE}

DEMANDE_STATUT_A_QUALIFIER = "a_qualifier"
DEMANDE_STATUT_A_VALIDER = "a_valider"
DEMANDE_STATUT_VALIDEE = "validee"
DEMANDE_STATUT_REPORTEE = "reportee"
DEMANDE_STATUT_TRANSMISE = "transmise_studio"
DEMANDE_STATUT_PRISE_EN_CHARGE = "prise_en_charge"
DEMANDE_STATUT_ACTION_CREEE = "action_creee"
DEMANDE_STATUT_REFUSEE = "refusee"
DEMANDE_STATUT_CLASSEE = "classee"
DEMANDE_STATUTS = {
    DEMANDE_STATUT_A_QUALIFIER,
    DEMANDE_STATUT_A_VALIDER,
    DEMANDE_STATUT_VALIDEE,
    DEMANDE_STATUT_REPORTEE,
    DEMANDE_STATUT_TRANSMISE,
    DEMANDE_STATUT_PRISE_EN_CHARGE,
    DEMANDE_STATUT_ACTION_CREEE,
    DEMANDE_STATUT_REFUSEE,
    DEMANDE_STATUT_CLASSEE,
}

DEMANDE_ORIGINES = {"analyse", "simulation", "manager", "salarie", "entretien"}
DEMANDE_TYPES = {
    "formation",
    "transmission",
    "renfort",
    "recrutement",
    "mobilite",
    "tutorat",
    "entretien",
    "documentation",
    "organisation",
    "autre",
}
DEMANDE_PRIORITES = {"basse", "normale", "haute", "critique"}


def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    return resolve_insights_id_ent_for_request(cur, id_contact, request)


class BesoinFormationSendItem(BaseModel):
    id_comp: str
    id_poste: Optional[str] = None
    id_effectif_concerne: Optional[str] = None


class BesoinFormationSendPayload(BaseModel):
    items: List[BesoinFormationSendItem]
    delai_souhaite: Optional[str] = None
    periode_souhaitee: Optional[str] = None
    precision_periode: Optional[str] = None
    modalites_souhaitees: List[str] = []
    commentaire_manager: Optional[str] = None


class DemandeRhPayload(BaseModel):
    id_effectif_concerne: Optional[str] = None
    id_poste: Optional[str] = None
    id_comp: Optional[str] = None
    origine: Optional[str] = "manager"
    source_type: Optional[str] = "manager"
    source_ref: Optional[str] = None
    type_demande: Optional[str] = "autre"
    finalite_terrain: Optional[str] = None
    objet: Optional[str] = None
    description: Optional[str] = None
    statut: Optional[str] = None
    priorite: Optional[str] = "normale"
    delai_souhaite: Optional[str] = None
    echeance_souhaitee: Optional[str] = None
    modalites_souhaitees: List[str] = []
    commentaire_manager: Optional[str] = None
    commentaire_salarie: Optional[str] = None
    niveau_attendu: Optional[str] = None
    niveau_actuel: Optional[str] = None
    ecart_niveau: Optional[int] = None
    criticite: Optional[int] = None
    score_anticipation: Optional[int] = None
    payload_signal: Dict[str, Any] = {}


class DemandeRhStatutPayload(BaseModel):
    statut: str
    commentaire_manager: Optional[str] = None


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


def _label_demande_statut(statut: str) -> str:
    s = _s(statut)
    return {
        DEMANDE_STATUT_A_QUALIFIER: "À qualifier",
        DEMANDE_STATUT_A_VALIDER: "À qualifier",
        DEMANDE_STATUT_VALIDEE: "Prête à transmettre",
        DEMANDE_STATUT_REPORTEE: "Reportée",
        DEMANDE_STATUT_TRANSMISE: "Transmise au Studio",
        DEMANDE_STATUT_PRISE_EN_CHARGE: "Prise en charge",
        DEMANDE_STATUT_ACTION_CREEE: "Action créée",
        DEMANDE_STATUT_REFUSEE: "Refusée",
        DEMANDE_STATUT_CLASSEE: "Classée",
    }.get(s, s or "—")


def _filter_demande_statut(statut: str) -> str:
    s = _s(statut).lower()
    if s in ("", "tous", "all"):
        return "tous"
    if s == "a_traiter":
        return "a_traiter"
    if s in ("reportees", "reportées", "reportee", "reportée", "reporter"):
        return DEMANDE_STATUT_REPORTEE
    if s in ("transmises", "transmise", "envoye_studio"):
        return DEMANDE_STATUT_TRANSMISE
    if s in ("pris_en_charge", "prise_en_charge"):
        return DEMANDE_STATUT_PRISE_EN_CHARGE
    if s in ("traite", "action_creee"):
        return DEMANDE_STATUT_ACTION_CREEE
    return s if s in DEMANDE_STATUTS else "tous"


def _normalise_demande_origine(value: str) -> str:
    s = _s(value).lower()
    if s in ("analyse_competences", "fragilite", "fragilité", "moteur"):
        return "analyse"
    if s in ("simulation_rh", "simulateur", "scenario", "scénario"):
        return "simulation"
    if s in ("people", "collaborateur", "salarie", "salarié"):
        return "salarie"
    if s in ("entretien_performance", "evaluation", "évaluation"):
        return "entretien"
    return s if s in DEMANDE_ORIGINES else "manager"


def _normalise_demande_type(value: str) -> str:
    s = _s(value).lower()
    aliases = {
        "renfort_temporaire": "renfort",
        "recruter": "recrutement",
        "mobilité": "mobilite",
        "tutorat_interne": "tutorat",
        "capitalisation": "documentation",
        "action_rh": "autre",
    }
    s = aliases.get(s, s)
    return s if s in DEMANDE_TYPES else "autre"


def _normalise_demande_finalite(value: str, has_competence: bool = False) -> str:
    s = _s(value).lower()
    aliases = {
        "competence": "monter_competence",
        "compétence": "monter_competence",
        "montee_competence": "monter_competence",
        "montée_compétence": "monter_competence",
        "securisation_poste": "securiser_poste",
        "sécuriser_poste": "securiser_poste",
        "evolution": "preparer_evolution",
        "évolution": "preparer_evolution",
        "savoir_faire": "capitaliser_savoir",
        "demande_salarie": "traiter_demande_salarie",
        "demande_salarié": "traiter_demande_salarie",
        "autre": "besoin_rh",
    }
    s = aliases.get(s, s)
    allowed = {
        "monter_competence",
        "securiser_poste",
        "preparer_evolution",
        "renforcer_equipe",
        "anticiper_depart",
        "capitaliser_savoir",
        "traiter_demande_salarie",
        "besoin_rh",
    }
    if s in allowed:
        return s
    return "monter_competence" if has_competence else "besoin_rh"


def _normalise_demande_priorite(value: str) -> str:
    s = _s(value).lower()
    if s in ("urgent", "critique"):
        return "critique"
    if s in ("haute", "haut", "élevée", "elevee", "a_securiser", "à sécuriser"):
        return "haute"
    if s in ("basse", "faible"):
        return "basse"
    return s if s in DEMANDE_PRIORITES else "normale"


def _priority_from_demande_score(score: int, criticite: int = 0) -> str:
    s = max(_i(score), _i(criticite))
    if s >= 80:
        return "critique"
    if s >= 65:
        return "haute"
    if s <= 30:
        return "basse"
    return "normale"


def _niveau_label(value: Any) -> str:
    s = _s(value)
    if not s:
        return "—"
    up = s.upper()
    if up == "A" or "DÉBUT" in up or "DEBUT" in up or "INITIAL" in up:
        return "Débutant"
    if up == "B" or "INTERM" in up:
        return "Intermédiaire"
    if up == "C" or "AVANC" in up:
        return "Avancé"
    if up == "D" or "EXPERT" in up:
        return "Expert"
    if s.isdigit():
        n = _i(s)
        if n >= 4:
            return "Expert"
        if n == 3:
            return "Avancé"
        if n == 2:
            return "Intermédiaire"
        if n == 1:
            return "Débutant"
    return s


def _analyse_gap_explanation(row: Dict[str, Any]) -> str:
    comp = _s(row.get("intitule_competence")) or "cette compétence"
    poste = _s(row.get("intitule_poste")) or "le poste occupé"
    actuel = _niveau_label(row.get("niveau_actuel"))
    attendu = _niveau_label(row.get("niveau_requis") or row.get("niveau_attendu"))
    return (
        f"Novoskill propose cette demande car le niveau actuel du collaborateur sur « {comp} » "
        f"({actuel}) est inférieur au niveau attendu ({attendu}) pour {poste}. "
        "La demande sert à confirmer le besoin terrain avant transmission au Studio."
    )


def _json_list(values: Any) -> List[str]:
    if values is None:
        return []
    if isinstance(values, list):
        return [_s(x) for x in values if _s(x)]
    if isinstance(values, str):
        try:
            parsed = json.loads(values)
            if isinstance(parsed, list):
                return [_s(x) for x in parsed if _s(x)]
        except Exception:
            return [_s(values)] if _s(values) else []
    return []


def _date_or_none(value: Any):
    s = _s(value)
    if not s:
        return None
    try:
        return datetime.fromisoformat(s[:10]).date().isoformat()
    except Exception:
        return None


def _demande_table_exists(cur) -> bool:
    cur.execute("SELECT to_regclass('public.tbl_insights_demande_rh') AS tbl")
    return bool((cur.fetchone() or {}).get("tbl"))


def _scope_dict(scope) -> Dict[str, Any]:
    return scope.model_dump() if hasattr(scope, "model_dump") else scope.dict()


def _delai_from_score(score: int) -> str:
    if score >= 80:
        return "Dès que possible"
    if score >= 65:
        return "Sous 3 mois"
    if score >= 45:
        return "Sous 6 mois"
    return "Sous 12 mois"


def _priority_from_score(score: int) -> str:
    if score >= 80:
        return "Urgent"
    if score >= 65:
        return "À sécuriser"
    if score >= 45:
        return "À anticiper"
    return "À surveiller"


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

    def read_owner(owner_id: str):
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
                  AND (c.date_fin IS NULL OR c.date_fin >= CURRENT_DATE)
                ORDER BY c.date_debut DESC NULLS LAST, c.created_at DESC NULLS LAST
                LIMIT 1
            ) oc ON TRUE
            WHERE o.id_owner = %s
              AND COALESCE(o.archive, FALSE) = FALSE
              AND COALESCE(o.statut_owner, 'actif') <> 'suspendu'
            LIMIT 1
            """,
            (owner_id,),
        )
        return cur.fetchone()

    owner = read_owner(wanted_owner)
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
        owner = read_owner(id_ent)
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


def _fetch_current(
    cur,
    id_ent: str,
    id_service: Optional[str],
    criticite_min: int,
    id_owner_dest: str,
    limit: int,
) -> List[Dict[str, Any]]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    sql = f"""
    WITH
    {cte_sql},
    req AS (
        SELECT DISTINCT
            fp.id_poste,
            COALESCE(NULLIF(fp.codif_client, ''), fp.codif_poste) AS code_poste,
            fp.intitule_poste,
            fp.id_service,
            org.nom_service,
            c.id_comp,
            c.code AS code_competence,
            c.intitule AS intitule_competence,
            UPPER(TRIM(COALESCE(fpc.niveau_requis, ''))) AS niveau_requis,
            COALESCE(fpc.poids_criticite, 0)::int AS criticite,
            CASE UPPER(TRIM(COALESCE(fpc.niveau_requis, '')))
                WHEN 'D' THEN 4
                WHEN 'C' THEN 3
                WHEN 'B' THEN 2
                WHEN 'A' THEN 1
                ELSE 0
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
          AND LOWER(COALESCE(c.etat, 'valide')) NOT IN ('archive', 'archivé', 'inactif', 'masque', 'masqué')
          AND COALESCE(fpc.poids_criticite, 0)::int >= %s
          AND UPPER(TRIM(COALESCE(fpc.niveau_requis, ''))) IN ('A', 'B', 'C', 'D')
    ),
    effectifs_poste AS (
        SELECT
            e.id_effectif,
            e.id_poste_actuel,
            e.id_service,
            e.nom_effectif,
            e.prenom_effectif,
            e.date_sortie_prevue,
            e.retraite_estimee
        FROM public.tbl_effectif_client e
        JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
        WHERE COALESCE(e.archive, FALSE) = FALSE
          AND COALESCE(e.statut_actif, TRUE) = TRUE
          AND e.id_poste_actuel IS NOT NULL
    ),
    eval_comp AS (
        SELECT
            ec.id_effectif_client,
            ec.id_comp,
            ec.niveau_actuel,
            CASE
              WHEN trim(COALESCE(ec.niveau_actuel, '')) ~ '^[0-9]+$' THEN
                CASE WHEN trim(ec.niveau_actuel)::int > 18 THEN 4
                     WHEN trim(ec.niveau_actuel)::int > 12 THEN 3
                     WHEN trim(ec.niveau_actuel)::int > 6 THEN 2
                     WHEN trim(ec.niveau_actuel)::int >= 0 THEN 1
                     ELSE 0 END
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'D' OR ec.niveau_actuel ILIKE '%%expert%%' THEN 4
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'C' OR ec.niveau_actuel ILIKE '%%avanc%%' THEN 3
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'B' OR ec.niveau_actuel ILIKE '%%interm%%' THEN 2
              WHEN UPPER(TRIM(ec.niveau_actuel)) = 'A' OR ec.niveau_actuel ILIKE '%%initial%%' OR ec.niveau_actuel ILIKE '%%début%%' OR ec.niveau_actuel ILIKE '%%debut%%' THEN 1
              ELSE 0
            END AS niveau_actuel_score
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
          AND COALESCE(e.statut_actif, TRUE) = TRUE
        GROUP BY ec.id_comp
    ),
    formation_counts AS (
        SELECT
            r.id_comp,
            COUNT(DISTINCT ff.id_form)::int AS nb_formations_existantes
        FROM req r
        LEFT JOIN public.tbl_fiche_formation ff
               ON ff.id_owner = %s
              AND COALESCE(ff.archive, FALSE) = FALSE
              AND COALESCE(ff.masque, FALSE) = FALSE
              AND LOWER(COALESCE(ff.etat, 'valide')) NOT IN ('archive', 'archivé', 'inactif', 'masque', 'masqué')
              AND (
                    COALESCE(ff.competences_stagiaires, '[]'::jsonb) @> jsonb_build_array(r.id_comp)
                 OR COALESCE(ff.competences_formateurs, '[]'::jsonb) @> jsonb_build_array(r.id_comp)
              )
        GROUP BY r.id_comp
    ),
    base AS (
        SELECT
            'individuel'::text AS besoin_type,
            r.id_poste,
            r.code_poste,
            r.intitule_poste,
            r.id_service,
            r.nom_service,
            ep.id_effectif AS id_effectif_concerne,
            ep.nom_effectif,
            ep.prenom_effectif,
            r.id_comp,
            r.code_competence,
            r.intitule_competence,
            r.niveau_requis,
            r.niveau_requis_score,
            COALESCE(ev.niveau_actuel, 'Non évalué') AS niveau_actuel,
            COALESCE(ev.niveau_actuel_score, 0) AS niveau_actuel_score,
            GREATEST(r.niveau_requis_score - COALESCE(ev.niveau_actuel_score, 0), 0)::int AS ecart_niveau,
            r.criticite,
            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs,
            COALESCE(p.nb_porteurs_dispo, 0)::int AS nb_porteurs_dispo,
            COALESCE(p.nb_sorties_prevues, 0)::int AS nb_sorties_prevues,
            COALESCE(p.nb_retraites_estimees, 0)::int AS nb_retraites_estimees,
            COALESCE(p.nb_indispos_actuelles, 0)::int AS nb_indispos_actuelles,
            CASE WHEN bn.id_effectif IS NOT NULL THEN 1 ELSE 0 END AS collaborateur_indisponible,
            COALESCE(fc.nb_formations_existantes, 0)::int AS nb_formations_existantes
        FROM req r
        JOIN effectifs_poste ep ON ep.id_poste_actuel = r.id_poste
        LEFT JOIN eval_comp ev ON ev.id_effectif_client = ep.id_effectif AND ev.id_comp = r.id_comp
        LEFT JOIN breaks_now bn ON bn.id_effectif = ep.id_effectif
        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
        LEFT JOIN formation_counts fc ON fc.id_comp = r.id_comp
        WHERE COALESCE(ev.niveau_actuel_score, 0) < r.niveau_requis_score
    ),
    scored AS (
        SELECT
            b.*,
            LEAST(100, GREATEST(0, ROUND(
                0.35 * CASE
                    WHEN b.niveau_requis_score <= 0 THEN 0
                    ELSE (100.0 * b.ecart_niveau / NULLIF(b.niveau_requis_score, 0))
                END
              + 0.25 * b.criticite
              + 0.20 * CASE
                    WHEN b.nb_porteurs <= 0 THEN 100
                    WHEN b.nb_porteurs = 1 THEN 85
                    WHEN (b.nb_sorties_prevues + b.nb_retraites_estimees) >= b.nb_porteurs THEN 95
                    ELSE 100.0 * (b.nb_sorties_prevues + b.nb_retraites_estimees) / NULLIF(b.nb_porteurs, 0)
                END
              + 0.10 * CASE
                    WHEN b.nb_porteurs <= 0 THEN 100
                    WHEN b.nb_porteurs_dispo <= 0 THEN 95
                    WHEN b.nb_indispos_actuelles > 0 OR b.collaborateur_indisponible = 1 THEN 70
                    ELSE 0
                END
              + 0.10 * CASE
                    WHEN b.nb_porteurs <= 0 THEN 100
                    WHEN b.nb_porteurs = 1 THEN 80
                    WHEN b.nb_porteurs = 2 THEN 50
                    ELSE 15
                END
            )))::int AS score_anticipation
        FROM base b
    )
    SELECT
        s.*,
        s.score_anticipation AS indice_fragilite,
        CASE WHEN s.score_anticipation >= 80 THEN 'Urgent'
             WHEN s.score_anticipation >= 65 THEN 'À sécuriser'
             WHEN s.score_anticipation >= 45 THEN 'À anticiper'
             ELSE 'À surveiller' END AS priorite,
        CASE WHEN s.score_anticipation >= 80 THEN 'Dès que possible'
             WHEN s.score_anticipation >= 65 THEN 'Sous 3 mois'
             WHEN s.score_anticipation >= 45 THEN 'Sous 6 mois'
             ELSE 'Sous 12 mois' END AS delai_recommande,
        CASE WHEN s.collaborateur_indisponible = 1 THEN 'Collaborateur indisponible actuellement'
             WHEN s.nb_porteurs_dispo <= 0 THEN 'Porteurs indisponibles actuellement'
             WHEN (s.nb_sorties_prevues + s.nb_retraites_estimees) > 0 THEN 'Risque de sortie à horizon 5 ans'
             WHEN s.ecart_niveau > 0 THEN 'Écart entre niveau actuel et niveau attendu'
             WHEN s.criticite >= 80 THEN 'Criticité élevée'
             ELSE 'À surveiller' END AS motif_priorite,
        (s.nb_formations_existantes > 0) AS formation_existante
    FROM scored s
    ORDER BY s.score_anticipation DESC, s.criticite DESC, s.nom_effectif, s.prenom_effectif, s.code_competence
    LIMIT %s
    """
    cur.execute(sql, tuple(cte_params + [id_ent, criticite_min, id_owner_dest or "", limit]))
    rows = [dict(r) for r in (cur.fetchall() or [])]
    for r in rows:
        r["source_type"] = "analyse_competences"
        r["is_signal_actuel"] = True
        r["collaborateur_nom_complet"] = " ".join([_s(r.get("prenom_effectif")), _s(r.get("nom_effectif"))]).strip()
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
          AND COALESCE(besoin_type, 'individuel') = 'individuel'
          AND id_effectif_concerne IS NOT NULL
        ORDER BY created_at DESC
        """,
        (id_ent, id_owner_dest),
    )
    return [dict(r) for r in (cur.fetchall() or [])]


def _key(row: Dict[str, Any]):
    return (_s(row.get("id_comp")), _s(row.get("id_poste")), _s(row.get("id_effectif_concerne")))


def _merge(current: List[Dict[str, Any]], demandes: List[Dict[str, Any]], statut_filter: str, fragilite_min: int):
    d_by_key = {}
    for d in demandes:
        key = _key(d)
        if key[0] and key not in d_by_key:
            d_by_key[key] = d

    rows, seen = [], set()

    for c in current:
        if _i(c.get("score_anticipation")) < fragilite_min:
            continue

        key = _key(c)
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
            "delai_souhaite": d.get("delai_souhaite") if d else None,
            "periode_souhaitee": d.get("periode_souhaitee") if d else None,
            "precision_periode": d.get("precision_periode") if d else None,
            "modalites_souhaitees": d.get("modalites_souhaitees") if d else [],
            "commentaire_manager": d.get("commentaire_manager") if d else "",
            "commentaire_client": d.get("commentaire_client") if d else "",
            "created_at": d.get("created_at") if d else None,
            "updated_at": d.get("updated_at") if d else None,
        })
        rows.append(item)

    for d in demandes:
        key = _key(d)
        if key in seen:
            continue

        statut = _s(d.get("statut")) or STATUT_ENVOYE
        if statut_filter not in ("tous", statut):
            continue

        rows.append({
            "id_besoin_formation": d.get("id_besoin_formation"),
            "besoin_type": "individuel",
            "id_comp": d.get("id_comp"),
            "code_competence": d.get("code_competence"),
            "intitule_competence": d.get("intitule_competence"),
            "id_poste": d.get("id_poste"),
            "code_poste": d.get("code_poste"),
            "intitule_poste": d.get("intitule_poste"),
            "id_service": d.get("id_service"),
            "nom_service": d.get("nom_service"),
            "id_effectif_concerne": d.get("id_effectif_concerne"),
            "nom_effectif": d.get("nom_effectif"),
            "prenom_effectif": d.get("prenom_effectif"),
            "collaborateur_nom_complet": (" ".join([_s(d.get("prenom_effectif")), _s(d.get("nom_effectif"))]).strip()),
            "niveau_requis": d.get("niveau_attendu"),
            "niveau_actuel": d.get("niveau_actuel"),
            "ecart_niveau": _i(d.get("ecart_niveau")),
            "criticite": _i(d.get("criticite")),
            "indice_fragilite": _i(d.get("indice_fragilite")),
            "score_anticipation": _i(d.get("score_anticipation")),
            "priorite": d.get("priorite") or _priority_from_score(_i(d.get("score_anticipation"))),
            "delai_recommande": d.get("delai_recommande") or _delai_from_score(_i(d.get("score_anticipation"))),
            "delai_souhaite": d.get("delai_souhaite"),
            "periode_souhaitee": d.get("periode_souhaitee"),
            "precision_periode": d.get("precision_periode"),
            "modalites_souhaitees": d.get("modalites_souhaitees") or [],
            "motif_priorite": d.get("motif_priorite") or "Demande déjà émise",
            "nb_formations_existantes": _i(d.get("nb_formations_existantes")),
            "formation_existante": bool(d.get("formation_existante")),
            "source_type": d.get("source_type") or "analyse_competences",
            "is_signal_actuel": False,
            "statut": statut,
            "statut_label": _label_statut(statut),
            "commentaire_manager": d.get("commentaire_manager") or d.get("commentaire_client") or "",
            "commentaire_client": d.get("commentaire_client") or "",
            "created_at": d.get("created_at"),
            "updated_at": d.get("updated_at"),
        })

    rows.sort(key=lambda x: (
        str(x.get("collaborateur_nom_complet") or ""),
        0 if x.get("statut") == "a_envoyer" else 1,
        -_i(x.get("score_anticipation")),
        str(x.get("intitule_competence") or ""),
    ))

    collabs = {_s(x.get("id_effectif_concerne")) for x in rows if _s(x.get("id_effectif_concerne"))}
    kpis = {
        "total": len(rows),
        "collaborateurs": len(collabs),
        "a_envoyer": sum(1 for x in rows if x.get("statut") == "a_envoyer"),
        "envoye_studio": sum(1 for x in rows if x.get("statut") == STATUT_ENVOYE),
        "pris_en_charge": sum(1 for x in rows if x.get("statut") == STATUT_PRIS_EN_CHARGE),
        "traite": sum(1 for x in rows if x.get("statut") == STATUT_TRAITE),
        "formation_existante": sum(1 for x in rows if x.get("formation_existante")),
        "risque_5_ans": sum(1 for x in rows if (_i(x.get("nb_sorties_prevues")) + _i(x.get("nb_retraites_estimees"))) > 0),
        "indisponibilite": sum(1 for x in rows if _i(x.get("nb_indispos_actuelles")) > 0 or _i(x.get("collaborateur_indisponible")) > 0),
    }
    return rows, kpis


def _demande_signal_key(row: Dict[str, Any]) -> str:
    return "|".join([
        _s(row.get("source_type")) or "analyse_competences",
        _s(row.get("id_effectif_concerne")),
        _s(row.get("id_poste")),
        _s(row.get("id_comp")),
    ])


def _demande_apply_filters(rows: List[Dict[str, Any]], statut_filter: str, origine: str, type_demande: str, finalite_terrain: str, priorite: str, q: str, fragilite_min: int, criticite_min: int) -> List[Dict[str, Any]]:
    needle = _s(q).lower()
    orig = _s(origine).lower()
    typ = _s(type_demande).lower()
    finalite = _s(finalite_terrain).lower()
    prio = _s(priorite).lower()
    out = []
    for r in rows:
        statut = _s(r.get("statut"))
        if statut_filter == "a_traiter" and statut not in (DEMANDE_STATUT_A_QUALIFIER, DEMANDE_STATUT_A_VALIDER):
            continue
        if statut_filter not in ("", "tous", "a_traiter") and statut != statut_filter:
            continue
        if orig not in ("", "tous", "all") and _normalise_demande_origine(r.get("origine")) != orig:
            continue
        if typ not in ("", "tous", "all") and _normalise_demande_type(r.get("type_demande")) != typ:
            continue
        if finalite not in ("", "tous", "all") and _normalise_demande_finalite(r.get("finalite_terrain") or (r.get("payload_signal") or {}).get("finalite_terrain"), bool(_s(r.get("id_comp")))) != finalite:
            continue
        if prio not in ("", "toutes", "tous", "all") and _normalise_demande_priorite(r.get("priorite")) != prio:
            continue
        if _i(r.get("score_anticipation")) < fragilite_min:
            continue
        if _i(r.get("criticite")) < criticite_min and _normalise_demande_origine(r.get("origine")) == "analyse":
            continue
        if needle:
            hay = " ".join([
                _s(r.get("objet")), _s(r.get("description")), _s(r.get("collaborateur_nom_complet")),
                _s(r.get("intitule_poste")), _s(r.get("nom_service")), _s(r.get("intitule_competence")),
                _s(r.get("code_competence")), _s(r.get("commentaire_manager")), _s(r.get("commentaire_salarie")),
            ]).lower()
            if needle not in hay:
                continue
        out.append(r)
    return out


def _demande_kpis(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    return {
        "total": len(rows),
        "a_qualifier": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_A_QUALIFIER),
        "a_valider": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_A_VALIDER),
        "validee": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_VALIDEE),
        "reportee": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_REPORTEE),
        "transmise_studio": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_TRANSMISE),
        "prise_en_charge": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_PRISE_EN_CHARGE),
        "action_creee": sum(1 for x in rows if x.get("statut") == DEMANDE_STATUT_ACTION_CREEE),
        "a_traiter": sum(1 for x in rows if x.get("statut") in (DEMANDE_STATUT_A_QUALIFIER, DEMANDE_STATUT_A_VALIDER)),
        "collaborateurs": len({_s(x.get("id_effectif_concerne")) for x in rows if _s(x.get("id_effectif_concerne"))}),
    }


def _demande_base_item(row: Dict[str, Any]) -> Dict[str, Any]:
    statut = _filter_demande_statut(row.get("statut") or DEMANDE_STATUT_A_QUALIFIER)
    if statut in ("", "tous", "a_traiter"):
        statut = DEMANDE_STATUT_A_QUALIFIER
    origine = _normalise_demande_origine(row.get("origine") or row.get("source_type"))
    type_demande = _normalise_demande_type(row.get("type_demande"))
    priorite = _normalise_demande_priorite(row.get("priorite"))
    payload_signal = row.get("payload_signal") or {}
    if isinstance(payload_signal, str):
        try:
            parsed = json.loads(payload_signal)
            payload_signal = parsed if isinstance(parsed, dict) else {}
        except Exception:
            payload_signal = {}
    if not isinstance(payload_signal, dict):
        payload_signal = {}
    finalite_terrain = _normalise_demande_finalite(
        row.get("finalite_terrain") or payload_signal.get("finalite_terrain"),
        bool(_s(row.get("id_comp")))
    )
    finalite_label = {
        "monter_competence": "Monter en compétence",
        "securiser_poste": "Sécuriser un poste",
        "preparer_evolution": "Préparer une évolution",
        "renforcer_equipe": "Renforcer une équipe",
        "anticiper_depart": "Anticiper un départ",
        "capitaliser_savoir": "Capitaliser un savoir-faire",
        "traiter_demande_salarie": "Traiter une demande salarié",
        "besoin_rh": "Besoin RH",
    }.get(finalite_terrain, "Besoin RH")
    nom = " ".join([_s(row.get("prenom_effectif")), _s(row.get("nom_effectif"))]).strip()
    nom = _s(row.get("collaborateur_nom_complet")) or nom or "Demande collective"
    objet = _s(row.get("objet"))
    if not objet:
        if _s(row.get("intitule_competence")):
            objet = "Renforcer l’autonomie sur une compétence clé"
        else:
            objet = "Demande RH à qualifier"
    score = _i(row.get("score_anticipation") or row.get("indice_fragilite"))
    criticite = _i(row.get("criticite"))
    return {
        "id_demande_rh": row.get("id_demande_rh"),
        "id_besoin_formation": row.get("id_besoin_formation"),
        "source_ref": row.get("source_ref"),
        "source_type": row.get("source_type") or origine,
        "origine": origine,
        "type_demande": type_demande,
        "finalite_terrain": finalite_terrain,
        "finalite_label": finalite_label,
        "objet": objet,
        "description": row.get("description") or row.get("motif_priorite") or "",
        "statut": statut,
        "statut_label": _label_demande_statut(statut),
        "priorite": priorite,
        "id_effectif_concerne": row.get("id_effectif_concerne"),
        "collaborateur_nom_complet": nom,
        "id_poste": row.get("id_poste"),
        "code_poste": row.get("code_poste"),
        "intitule_poste": row.get("intitule_poste") or "Poste non précisé",
        "id_service": row.get("id_service"),
        "nom_service": row.get("nom_service") or "",
        "id_comp": row.get("id_comp"),
        "code_competence": row.get("code_competence"),
        "intitule_competence": row.get("intitule_competence"),
        "niveau_attendu": row.get("niveau_attendu") or row.get("niveau_requis"),
        "niveau_attendu_label": _niveau_label(row.get("niveau_attendu") or row.get("niveau_requis")),
        "niveau_actuel": row.get("niveau_actuel"),
        "niveau_actuel_label": _niveau_label(row.get("niveau_actuel")),
        "ecart_niveau": _i(row.get("ecart_niveau")),
        "criticite": criticite,
        "indice_fragilite": score,
        "score_anticipation": score,
        "delai_recommande": row.get("delai_recommande") or _delai_from_score(score),
        "delai_souhaite": row.get("delai_souhaite"),
        "echeance_souhaitee": row.get("echeance_souhaitee"),
        "periode_souhaitee": row.get("periode_souhaitee"),
        "precision_periode": row.get("precision_periode"),
        "modalites_souhaitees": _json_list(row.get("modalites_souhaitees")),
        "commentaire_manager": row.get("commentaire_manager") or "",
        "commentaire_salarie": row.get("commentaire_salarie") or "",
        "commentaire_client": row.get("commentaire_client") or "",
        "payload_signal": payload_signal,
        "pourquoi_proposition": row.get("pourquoi_proposition") or payload_signal.get("pourquoi_proposition") or (
            _analyse_gap_explanation(row) if _normalise_demande_origine(row.get("origine") or row.get("source_type")) == "analyse" and _s(row.get("id_comp")) else ""
        ),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "is_signal_actuel": bool(row.get("is_signal_actuel")),
        "signal_key": _demande_signal_key(row),
    }


def _demande_from_current_signal(row: Dict[str, Any]) -> Dict[str, Any]:
    score = _i(row.get("score_anticipation"))
    item = dict(row)
    item.update({
        "id_demande_rh": None,
        "origine": "analyse",
        "source_type": "analyse_competences",
        "type_demande": "autre",
        "statut": DEMANDE_STATUT_A_QUALIFIER,
        "priorite": _priority_from_demande_score(score, _i(row.get("criticite"))),
        "objet": "Renforcer l’autonomie sur une compétence clé",
        "description": "Proposition issue de l’analyse des écarts de niveau.",
        "pourquoi_proposition": _analyse_gap_explanation(row),
        "payload_signal": {**row, "finalite_terrain": "monter_competence", "pourquoi_proposition": _analyse_gap_explanation(row)},
        "is_signal_actuel": True,
    })
    return _demande_base_item(item)


def _demande_from_legacy_besoin(row: Dict[str, Any]) -> Dict[str, Any]:
    legacy_status = _s(row.get("statut"))
    mapped = {
        STATUT_ENVOYE: DEMANDE_STATUT_TRANSMISE,
        STATUT_PRIS_EN_CHARGE: DEMANDE_STATUT_PRISE_EN_CHARGE,
        STATUT_TRAITE: DEMANDE_STATUT_ACTION_CREEE,
        "a_envoyer": DEMANDE_STATUT_A_QUALIFIER,
    }.get(legacy_status, DEMANDE_STATUT_TRANSMISE)
    item = dict(row)
    item.update({
        "id_demande_rh": None,
        "origine": "analyse",
        "source_type": row.get("source_type") or "analyse_competences",
        "type_demande": "formation",
        "statut": mapped,
        "priorite": _priority_from_demande_score(_i(row.get("score_anticipation")), _i(row.get("criticite"))),
        "objet": "Renforcer l’autonomie sur une compétence clé",
        "finalite_terrain": "monter_competence",
        "description": row.get("motif_priorite") or "Besoin transmis depuis l’ancienne page Besoins & formations.",
        "source_ref": row.get("id_besoin_formation"),
        "is_signal_actuel": False,
    })
    return _demande_base_item(item)


def _fetch_demandes_rh(cur, id_ent: str, id_service: Optional[str]) -> List[Dict[str, Any]]:
    if not _demande_table_exists(cur):
        return []
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)
    sql = f"""
    WITH
    {cte_sql}
    SELECT d.*
    FROM public.tbl_insights_demande_rh d
    WHERE d.id_ent = %s
      AND COALESCE(d.archive, FALSE) = FALSE
      AND (
            d.id_effectif_concerne IS NULL
            OR d.id_effectif_concerne IN (SELECT id_effectif FROM effectifs_scope)
          )
      AND (
            d.id_poste IS NULL
            OR d.id_poste IN (SELECT id_poste FROM postes_scope)
          )
    ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC NULLS LAST
    """
    cur.execute(sql, tuple(cte_params + [id_ent]))
    return [_demande_base_item(dict(r)) for r in (cur.fetchall() or [])]


def _lookup_demande_refs(cur, id_ent: str, payload: DemandeRhPayload) -> Dict[str, Any]:
    ref: Dict[str, Any] = {}
    id_eff = _s(payload.id_effectif_concerne)
    id_poste = _s(payload.id_poste)
    id_comp = _s(payload.id_comp)

    if id_eff:
        cur.execute(
            """
            SELECT
                e.id_effectif AS id_effectif_concerne,
                e.nom_effectif,
                e.prenom_effectif,
                e.id_poste_actuel,
                e.id_service,
                fp.id_poste,
                COALESCE(NULLIF(fp.codif_client, ''), fp.codif_poste) AS code_poste,
                fp.intitule_poste,
                org.nom_service
            FROM public.tbl_effectif_client e
            LEFT JOIN public.tbl_fiche_poste fp
                   ON fp.id_poste = e.id_poste_actuel
                  AND fp.id_ent = e.id_ent
                  AND COALESCE(fp.actif, TRUE) = TRUE
            LEFT JOIN public.tbl_entreprise_organigramme org
                   ON org.id_service = e.id_service
                  AND org.id_ent = e.id_ent
                  AND COALESCE(org.archive, FALSE) = FALSE
            WHERE e.id_ent = %s
              AND e.id_effectif = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND COALESCE(e.statut_actif, TRUE) = TRUE
            LIMIT 1
            """,
            (id_ent, id_eff),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Collaborateur introuvable ou archivé.")
        ref.update(dict(r))
        if not id_poste:
            id_poste = _s(r.get("id_poste") or r.get("id_poste_actuel"))

    if id_poste:
        cur.execute(
            """
            SELECT
                fp.id_poste,
                COALESCE(NULLIF(fp.codif_client, ''), fp.codif_poste) AS code_poste,
                fp.intitule_poste,
                fp.id_service,
                org.nom_service
            FROM public.tbl_fiche_poste fp
            LEFT JOIN public.tbl_entreprise_organigramme org
                   ON org.id_service = fp.id_service
                  AND org.id_ent = fp.id_ent
                  AND COALESCE(org.archive, FALSE) = FALSE
            WHERE fp.id_ent = %s
              AND fp.id_poste = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
            LIMIT 1
            """,
            (id_ent, id_poste),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Poste introuvable ou inactif.")
        ref.update({k: v for k, v in dict(r).items() if v is not None})

    if id_comp:
        cur.execute(
            """
            SELECT c.id_comp, c.code AS code_competence, c.intitule AS intitule_competence
            FROM public.tbl_competence c
            WHERE c.id_comp = %s
              AND COALESCE(c.masque, FALSE) = FALSE
              AND LOWER(COALESCE(c.etat, 'valide')) NOT IN ('archive', 'archivé', 'inactif', 'masque', 'masqué')
            LIMIT 1
            """,
            (id_comp,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Compétence introuvable ou masquée.")
        ref.update(dict(r))

    return ref


def _insert_demande_rh(cur, id_ent: str, id_contact: str, payload: DemandeRhPayload) -> Dict[str, Any]:
    if not _demande_table_exists(cur):
        raise HTTPException(status_code=400, detail="Table tbl_insights_demande_rh absente. Appliquez la migration SQL du patch.")

    ref = _lookup_demande_refs(cur, id_ent, payload)
    origine = _normalise_demande_origine(payload.origine)
    type_demande = _normalise_demande_type(payload.type_demande)
    priorite = _normalise_demande_priorite(payload.priorite)
    statut_default = DEMANDE_STATUT_VALIDEE if origine == "manager" else DEMANDE_STATUT_A_QUALIFIER
    statut = _filter_demande_statut(payload.statut or statut_default)
    if statut in ("", "tous", "a_traiter"):
        statut = statut_default

    objet = _s(payload.objet)
    if not objet:
        if _s(ref.get("intitule_competence")):
            objet = "Renforcer l’autonomie sur une compétence clé"
        else:
            objet = "Demande RH à qualifier"

    payload_signal = payload.payload_signal or {}
    if not isinstance(payload_signal, dict):
        payload_signal = {}
    payload_signal.update({
        "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "origine": origine,
        "type_demande": type_demande,
        "finalite_terrain": _normalise_demande_finalite(
            payload.finalite_terrain or payload_signal.get("finalite_terrain"),
            bool(ref.get("id_comp"))
        ),
    })

    modalites_json = json.dumps(_json_list(payload.modalites_souhaitees), ensure_ascii=False)
    payload_json = json.dumps(payload_signal, ensure_ascii=False)
    dest = _resolve_destination(cur, id_ent)
    id_owner_dest = _s(dest.get("id_owner")) or None
    demande_id = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO public.tbl_insights_demande_rh (
            id_demande_rh, id_ent, id_owner_destinataire, id_demandeur,
            id_effectif_concerne, nom_effectif, prenom_effectif,
            id_poste, code_poste, intitule_poste, id_service, nom_service,
            id_comp, code_competence, intitule_competence,
            origine, source_type, source_ref, type_demande,
            objet, description, statut, priorite,
            niveau_attendu, niveau_actuel, ecart_niveau,
            criticite, indice_fragilite, score_anticipation,
            delai_souhaite, echeance_souhaitee, modalites_souhaitees,
            commentaire_manager, commentaire_salarie, payload_signal,
            archive, created_at, updated_at
        ) VALUES (
            %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s::jsonb,
            %s, %s, %s::jsonb,
            FALSE, NOW(), NOW()
        )
        RETURNING *
        """,
        (
            demande_id, id_ent, id_owner_dest, id_contact,
            ref.get("id_effectif_concerne") or _s(payload.id_effectif_concerne) or None, ref.get("nom_effectif"), ref.get("prenom_effectif"),
            ref.get("id_poste") or _s(payload.id_poste) or None, ref.get("code_poste"), ref.get("intitule_poste"), ref.get("id_service"), ref.get("nom_service"),
            ref.get("id_comp") or _s(payload.id_comp) or None, ref.get("code_competence"), ref.get("intitule_competence"),
            origine, _s(payload.source_type) or origine, _s(payload.source_ref) or None, type_demande,
            objet, _s(payload.description), statut, priorite,
            _s(payload.niveau_attendu) or None, _s(payload.niveau_actuel) or None, _i(payload.ecart_niveau),
            _i(payload.criticite), _i(payload.score_anticipation), _i(payload.score_anticipation),
            _s(payload.delai_souhaite) or None, _date_or_none(payload.echeance_souhaitee), modalites_json,
            _s(payload.commentaire_manager), _s(payload.commentaire_salarie), payload_json,
        ),
    )
    return _demande_base_item(dict(cur.fetchone() or {}))


def _fetch_demande_by_id(cur, id_ent: str, id_demande: str) -> Dict[str, Any]:
    if not _demande_table_exists(cur):
        raise HTTPException(status_code=400, detail="Table tbl_insights_demande_rh absente. Appliquez la migration SQL du patch.")
    cur.execute(
        """
        SELECT *
        FROM public.tbl_insights_demande_rh
        WHERE id_ent = %s
          AND id_demande_rh = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_demande),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Demande RH introuvable.")
    return dict(row)


@router.get("/skills/demandes-rh/{id_contact}")
def get_demandes_rh(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    statut: str = Query(default="tous"),
    origine: str = Query(default="tous"),
    type_demande: str = Query(default="tous"),
    finalite_terrain: str = Query(default="tous"),
    priorite: str = Query(default="toutes"),
    q: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=0, ge=0, le=100),
    fragilite_min: int = Query(default=0, ge=0, le=100),
    limit: int = Query(default=400, ge=1, le=1000),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, _s(id_service) or None)
                dest = _resolve_destination(cur, id_ent)
                id_owner_dest = _s(dest.get("id_owner"))

                current = _fetch_current(cur, id_ent, scope.id_service, max(0, criticite_min), id_owner_dest, min(limit, 800))
                demandes_rh = _fetch_demandes_rh(cur, id_ent, scope.id_service)
                legacy = _fetch_demandes(cur, id_ent, id_owner_dest)

                rows: List[Dict[str, Any]] = []
                seen = set()

                for d in demandes_rh:
                    rows.append(d)
                    seen.add(_demande_signal_key(d))

                for l in legacy:
                    item = _demande_from_legacy_besoin(l)
                    key = _demande_signal_key(item)
                    if key not in seen:
                        rows.append(item)
                        seen.add(key)

                for c in current:
                    item = _demande_from_current_signal(c)
                    key = _demande_signal_key(item)
                    if key not in seen:
                        rows.append(item)
                        seen.add(key)

                rows_for_kpis = _demande_apply_filters(
                    rows,
                    "tous",
                    origine,
                    type_demande,
                    finalite_terrain,
                    priorite,
                    q or "",
                    fragilite_min,
                    criticite_min,
                )

                rows = _demande_apply_filters(
                    rows,
                    _filter_demande_statut(statut),
                    origine,
                    type_demande,
                    finalite_terrain,
                    priorite,
                    q or "",
                    fragilite_min,
                    criticite_min,
                )
                rows.sort(key=lambda x: (
                    0 if x.get("statut") in (DEMANDE_STATUT_A_QUALIFIER, DEMANDE_STATUT_A_VALIDER) else 1,
                    -_i(x.get("score_anticipation")),
                    str(x.get("collaborateur_nom_complet") or ""),
                    str(x.get("objet") or ""),
                ))

                return {
                    "scope": _scope_dict(scope),
                    "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "destination": dest,
                    "kpis": _demande_kpis(rows_for_kpis),
                    "items": rows[:limit],
                    "table_ready": _demande_table_exists(cur),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur demandes RH : {e}")


@router.get("/skills/demandes-rh/{id_contact}/refs")
def get_demandes_rh_refs(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                scope = _fetch_service_label(cur, id_ent, _s(id_service) or None)
                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)
                cur.execute(
                    f"""
                    WITH
                    {cte_sql}
                    SELECT
                        e.id_effectif,
                        e.nom_effectif,
                        e.prenom_effectif,
                        e.id_poste_actuel AS id_poste,
                        fp.intitule_poste,
                        e.id_service,
                        org.nom_service
                    FROM public.tbl_effectif_client e
                    JOIN effectifs_scope es ON es.id_effectif = e.id_effectif
                    LEFT JOIN public.tbl_fiche_poste fp
                           ON fp.id_poste = e.id_poste_actuel
                          AND fp.id_ent = e.id_ent
                          AND COALESCE(fp.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme org
                           ON org.id_service = e.id_service
                          AND org.id_ent = e.id_ent
                          AND COALESCE(org.archive, FALSE) = FALSE
                    WHERE e.id_ent = %s
                      AND COALESCE(e.archive, FALSE) = FALSE
                      AND COALESCE(e.statut_actif, TRUE) = TRUE
                    ORDER BY e.nom_effectif, e.prenom_effectif
                    LIMIT 800
                    """,
                    tuple(cte_params + [id_ent]),
                )
                effectifs = [dict(r) for r in (cur.fetchall() or [])]

                cur.execute(
                    f"""
                    WITH
                    {cte_sql}
                    SELECT DISTINCT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE COALESCE(fpc.masque, FALSE) = FALSE
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND LOWER(COALESCE(c.etat, 'valide')) NOT IN ('archive', 'archivé', 'inactif', 'masque', 'masqué')
                    ORDER BY c.code, c.intitule
                    LIMIT 800
                    """,
                    tuple(cte_params),
                )
                competences = [dict(r) for r in (cur.fetchall() or [])]

                return {
                    "scope": _scope_dict(scope),
                    "effectifs": effectifs,
                    "competences": competences,
                    "table_ready": _demande_table_exists(cur),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur référentiels demandes RH : {e}")


@router.post("/skills/demandes-rh/{id_contact}")
def creer_demande_rh(id_contact: str, payload: DemandeRhPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                item = _insert_demande_rh(cur, id_ent, id_contact, payload)
                conn.commit()
                return {"ok": True, "item": item, "message": "Demande RH créée."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur création demande RH : {e}")


@router.post("/skills/demandes-rh/{id_contact}/{id_demande}/qualifier")
def qualifier_demande_rh(id_contact: str, id_demande: str, payload: DemandeRhPayload, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                existing = _fetch_demande_by_id(cur, id_ent, id_demande)
                ref = _lookup_demande_refs(cur, id_ent, payload)
                statut = _filter_demande_statut(payload.statut or DEMANDE_STATUT_VALIDEE)
                if statut in ("", "tous", "a_traiter"):
                    statut = DEMANDE_STATUT_VALIDEE
                modalites_json = json.dumps(_json_list(payload.modalites_souhaitees), ensure_ascii=False)
                payload_signal = existing.get("payload_signal") or {}
                if isinstance(payload_signal, str):
                    try:
                        payload_signal = json.loads(payload_signal)
                    except Exception:
                        payload_signal = {}
                if not isinstance(payload_signal, dict):
                    payload_signal = {}
                if isinstance(payload.payload_signal, dict):
                    payload_signal.update(payload.payload_signal)
                payload_signal.update({
                    "finalite_terrain": _normalise_demande_finalite(
                        payload.finalite_terrain or payload_signal.get("finalite_terrain"),
                        bool(ref.get("id_comp") or _s(payload.id_comp))
                    ),
                    "qualified_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
                payload_json = json.dumps(payload_signal, ensure_ascii=False)
                cur.execute(
                    """
                    UPDATE public.tbl_insights_demande_rh
                    SET id_effectif_concerne = COALESCE(%s, id_effectif_concerne),
                        nom_effectif = COALESCE(%s, nom_effectif),
                        prenom_effectif = COALESCE(%s, prenom_effectif),
                        id_poste = COALESCE(%s, id_poste),
                        code_poste = COALESCE(%s, code_poste),
                        intitule_poste = COALESCE(%s, intitule_poste),
                        id_service = COALESCE(%s, id_service),
                        nom_service = COALESCE(%s, nom_service),
                        id_comp = %s,
                        code_competence = %s,
                        intitule_competence = %s,
                        type_demande = %s,
                        objet = %s,
                        description = %s,
                        statut = %s,
                        priorite = %s,
                        delai_souhaite = %s,
                        echeance_souhaitee = %s,
                        modalites_souhaitees = %s::jsonb,
                        commentaire_manager = %s,
                        payload_signal = %s::jsonb,
                        updated_at = NOW()
                    WHERE id_ent = %s
                      AND id_demande_rh = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING *
                    """,
                    (
                        ref.get("id_effectif_concerne") or _s(payload.id_effectif_concerne) or None,
                        ref.get("nom_effectif"), ref.get("prenom_effectif"),
                        ref.get("id_poste") or _s(payload.id_poste) or None, ref.get("code_poste"), ref.get("intitule_poste"),
                        ref.get("id_service"), ref.get("nom_service"),
                        ref.get("id_comp") or _s(payload.id_comp) or None, ref.get("code_competence"), ref.get("intitule_competence"),
                        _normalise_demande_type(payload.type_demande),
                        _s(payload.objet) or "Demande RH à qualifier",
                        _s(payload.description),
                        statut,
                        _normalise_demande_priorite(payload.priorite),
                        _s(payload.delai_souhaite) or None,
                        _date_or_none(payload.echeance_souhaitee),
                        modalites_json,
                        _s(payload.commentaire_manager),
                        payload_json,
                        id_ent, id_demande,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return {"ok": True, "item": _demande_base_item(dict(row or {})), "message": "Demande RH mise à jour."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur qualification demande RH : {e}")


@router.post("/skills/demandes-rh/{id_contact}/{id_demande}/statut")
def changer_statut_demande_rh(id_contact: str, id_demande: str, payload: DemandeRhStatutPayload, request: Request):
    try:
        statut = _filter_demande_statut(payload.statut)
        if statut not in DEMANDE_STATUTS:
            raise HTTPException(status_code=400, detail="Statut de demande RH invalide.")
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                _fetch_demande_by_id(cur, id_ent, id_demande)
                cur.execute(
                    """
                    UPDATE public.tbl_insights_demande_rh
                    SET statut = %s,
                        commentaire_manager = CASE WHEN %s <> '' THEN %s ELSE commentaire_manager END,
                        updated_at = NOW()
                    WHERE id_ent = %s
                      AND id_demande_rh = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING *
                    """,
                    (statut, _s(payload.commentaire_manager), _s(payload.commentaire_manager), id_ent, id_demande),
                )
                row = cur.fetchone()
                conn.commit()
                return {"ok": True, "item": _demande_base_item(dict(row or {})), "message": "Statut mis à jour."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur changement statut demande RH : {e}")


@router.post("/skills/demandes-rh/{id_contact}/{id_demande}/transmettre-studio")
def transmettre_demande_rh_studio(id_contact: str, id_demande: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                dest = _resolve_destination(cur, id_ent)
                if not dest.get("can_send"):
                    raise HTTPException(status_code=400, detail=dest.get("reason") or "Studio destinataire indisponible.")
                id_owner_dest = _s(dest.get("id_owner"))
                d = _fetch_demande_by_id(cur, id_ent, id_demande)
                if not _s(d.get("id_comp")) or not _s(d.get("id_effectif_concerne")):
                    raise HTTPException(status_code=400, detail="Transmission impossible : compétence ou collaborateur manquant.")

                payload_signal = dict(d.get("payload_signal") or {})
                payload_signal.update({
                    "source": "demande_rh",
                    "source_ref": id_demande,
                    "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "type_demande": d.get("type_demande"),
                    "origine": d.get("origine"),
                    "objet": d.get("objet"),
                })
                payload_json = json.dumps(payload_signal, ensure_ascii=False)
                modalites_json = json.dumps(_json_list(d.get("modalites_souhaitees")), ensure_ascii=False)

                cur.execute(
                    """
                    SELECT id_besoin_formation
                    FROM public.tbl_insights_besoin_formation
                    WHERE id_ent_source = %s
                      AND id_owner_destinataire = %s
                      AND id_comp = %s
                      AND COALESCE(id_poste, '') = COALESCE(%s, '')
                      AND COALESCE(id_effectif_concerne, '') = COALESCE(%s, '')
                      AND COALESCE(archive, FALSE) = FALSE
                      AND statut IN ('envoye_studio', 'pris_en_charge')
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (id_ent, id_owner_dest, d.get("id_comp"), d.get("id_poste"), d.get("id_effectif_concerne")),
                )
                existing = cur.fetchone()
                if existing:
                    besoin_id = existing.get("id_besoin_formation")
                    cur.execute(
                        """
                        UPDATE public.tbl_insights_besoin_formation
                        SET payload_signal = %s::jsonb,
                            besoin_type = 'individuel',
                            code_poste = %s,
                            nom_effectif = %s,
                            prenom_effectif = %s,
                            niveau_actuel = %s,
                            ecart_niveau = %s,
                            indice_fragilite = %s,
                            score_anticipation = %s,
                            criticite = %s,
                            priorite = %s,
                            delai_recommande = %s,
                            delai_souhaite = %s,
                            modalites_souhaitees = %s::jsonb,
                            motif_priorite = %s,
                            commentaire_client = %s,
                            commentaire_manager = %s,
                            updated_at = NOW()
                        WHERE id_besoin_formation = %s
                        """,
                        (
                            payload_json, d.get("code_poste"), d.get("nom_effectif"), d.get("prenom_effectif"), d.get("niveau_actuel"),
                            _i(d.get("ecart_niveau")), _i(d.get("indice_fragilite")), _i(d.get("score_anticipation")), _i(d.get("criticite")),
                            d.get("priorite"), d.get("delai_souhaite"), d.get("delai_souhaite"), modalites_json,
                            d.get("description"), d.get("commentaire_manager"), d.get("commentaire_manager"), besoin_id,
                        ),
                    )
                else:
                    besoin_id = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO public.tbl_insights_besoin_formation (
                            id_besoin_formation, id_owner_destinataire, id_ent_source, id_effectif_demandeur,
                            source_console, source_type, besoin_type,
                            id_comp, code_competence, intitule_competence,
                            id_poste, code_poste, intitule_poste, id_service, nom_service,
                            id_effectif_concerne, nom_effectif, prenom_effectif,
                            niveau_attendu, niveau_actuel, ecart_niveau,
                            criticite, indice_fragilite, score_anticipation, priorite,
                            delai_recommande, delai_souhaite, periode_souhaitee, precision_periode, modalites_souhaitees,
                            motif_priorite, commentaire_client, commentaire_manager,
                            formation_existante, nb_formations_existantes,
                            statut, payload_signal, archive, created_at, updated_at
                        ) VALUES (
                            %s, %s, %s, %s,
                            'insights', 'demande_rh', 'individuel',
                            %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, NULL, NULL, %s::jsonb,
                            %s, %s, %s,
                            FALSE, 0,
                            'envoye_studio', %s::jsonb, FALSE, NOW(), NOW()
                        )
                        """,
                        (
                            besoin_id, id_owner_dest, id_ent, id_contact,
                            d.get("id_comp"), d.get("code_competence"), d.get("intitule_competence"),
                            d.get("id_poste"), d.get("code_poste"), d.get("intitule_poste"), d.get("id_service"), d.get("nom_service"),
                            d.get("id_effectif_concerne"), d.get("nom_effectif"), d.get("prenom_effectif"),
                            d.get("niveau_attendu"), d.get("niveau_actuel"), _i(d.get("ecart_niveau")),
                            _i(d.get("criticite")), _i(d.get("indice_fragilite")), _i(d.get("score_anticipation")), d.get("priorite"),
                            d.get("delai_souhaite"), d.get("delai_souhaite"), modalites_json,
                            d.get("description"), d.get("commentaire_manager"), d.get("commentaire_manager"), payload_json,
                        ),
                    )

                cur.execute(
                    """
                    UPDATE public.tbl_insights_demande_rh
                    SET statut = 'transmise_studio',
                        id_besoin_formation = %s,
                        updated_at = NOW()
                    WHERE id_ent = %s
                      AND id_demande_rh = %s
                    RETURNING *
                    """,
                    (besoin_id, id_ent, id_demande),
                )
                row = cur.fetchone()
                conn.commit()
                return {"ok": True, "item": _demande_base_item(dict(row or {})), "message": "Demande transmise au Studio."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur transmission demande RH : {e}")


@router.get("/skills/besoins-formations/{id_contact}")
def get_besoins_formations(
    id_contact: str,
    request: Request,
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=CRITICITE_MIN_DEFAULT, ge=0, le=100),
    fragilite_min: int = Query(default=0, ge=0, le=100),
    statut: str = Query(default="tous"),
    limit: int = Query(default=300, ge=1, le=800),
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
                current = _fetch_current(cur, id_ent, None, 0, id_owner_dest, 800)
                by_key = {_key(x): x for x in current}

                delai_souhaite = _s(payload.delai_souhaite)
                periode_souhaitee = _s(payload.periode_souhaitee)
                precision_periode = _s(payload.precision_periode)
                commentaire_manager = _s(payload.commentaire_manager)
                modalites = [m.strip() for m in (payload.modalites_souhaitees or []) if _s(m)]
                modalites_json = json.dumps(modalites, ensure_ascii=False)

                created, updated, skipped = 0, 0, 0
                saved_items = []

                for p in payload.items:
                    id_comp = _s(p.id_comp)
                    id_poste = _s(p.id_poste)
                    id_effectif_concerne = _s(p.id_effectif_concerne)

                    signal = by_key.get((id_comp, id_poste, id_effectif_concerne))
                    if not id_comp or not id_effectif_concerne or not signal:
                        skipped += 1
                        continue

                    final_delai = delai_souhaite or signal.get("delai_recommande") or _delai_from_score(_i(signal.get("score_anticipation")))

                    payload_signal = json.dumps({
                        "source": "analyse_competences",
                        "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        "id_ent": id_ent,
                        "besoin_type": "individuel",
                        "id_comp": id_comp,
                        "id_poste": id_poste or None,
                        "id_effectif_concerne": id_effectif_concerne,
                        "code_competence": signal.get("code_competence"),
                        "intitule_competence": signal.get("intitule_competence"),
                        "intitule_poste": signal.get("intitule_poste"),
                        "collaborateur": signal.get("collaborateur_nom_complet"),
                        "niveau_requis": signal.get("niveau_requis"),
                        "niveau_actuel": signal.get("niveau_actuel"),
                        "ecart_niveau": _i(signal.get("ecart_niveau")),
                        "criticite": _i(signal.get("criticite")),
                        "score_anticipation": _i(signal.get("score_anticipation")),
                        "delai_souhaite": final_delai,
                        "periode_souhaitee": periode_souhaitee,
                        "precision_periode": precision_periode,
                        "modalites_souhaitees": modalites,
                        "commentaire_manager": commentaire_manager,
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
                          AND COALESCE(id_effectif_concerne, '') = COALESCE(%s, '')
                          AND COALESCE(archive, FALSE) = FALSE
                          AND statut IN ('envoye_studio', 'pris_en_charge')
                        ORDER BY created_at DESC
                        LIMIT 1
                        """,
                        (id_ent, id_owner_dest, id_comp, id_poste or None, id_effectif_concerne),
                    )
                    existing = cur.fetchone()

                    if existing:
                        cur.execute(
                            """
                            UPDATE public.tbl_insights_besoin_formation
                            SET payload_signal = %s::jsonb,
                                besoin_type = 'individuel',
                                code_poste = %s,
                                nom_effectif = %s,
                                prenom_effectif = %s,
                                niveau_actuel = %s,
                                ecart_niveau = %s,
                                indice_fragilite = %s,
                                score_anticipation = %s,
                                criticite = %s,
                                priorite = %s,
                                delai_recommande = %s,
                                delai_souhaite = %s,
                                periode_souhaitee = %s,
                                precision_periode = %s,
                                modalites_souhaitees = %s::jsonb,
                                motif_priorite = %s,
                                commentaire_client = %s,
                                commentaire_manager = %s,
                                formation_existante = %s,
                                nb_formations_existantes = %s,
                                updated_at = NOW()
                            WHERE id_besoin_formation = %s
                            RETURNING id_besoin_formation, statut
                            """,
                            (
                                payload_signal,
                                signal.get("code_poste"),
                                signal.get("nom_effectif"),
                                signal.get("prenom_effectif"),
                                signal.get("niveau_actuel"),
                                _i(signal.get("ecart_niveau")),
                                _i(signal.get("indice_fragilite")),
                                _i(signal.get("score_anticipation")),
                                _i(signal.get("criticite")),
                                signal.get("priorite"),
                                signal.get("delai_recommande"),
                                final_delai,
                                periode_souhaitee,
                                precision_periode,
                                modalites_json,
                                signal.get("motif_priorite"),
                                commentaire_manager,
                                commentaire_manager,
                                bool(signal.get("formation_existante")),
                                _i(signal.get("nb_formations_existantes")),
                                existing.get("id_besoin_formation"),
                            ),
                        )
                        updated += 1
                    else:
                        cur.execute(
                            """
                            INSERT INTO public.tbl_insights_besoin_formation (
                                id_besoin_formation, id_owner_destinataire, id_ent_source, id_effectif_demandeur,
                                source_console, source_type, besoin_type,
                                id_comp, code_competence, intitule_competence,
                                id_poste, code_poste, intitule_poste, id_service, nom_service,
                                id_effectif_concerne, nom_effectif, prenom_effectif,
                                niveau_attendu, niveau_actuel, ecart_niveau,
                                criticite, indice_fragilite, score_anticipation, priorite,
                                delai_recommande, delai_souhaite, periode_souhaitee, precision_periode, modalites_souhaitees,
                                motif_priorite, commentaire_client, commentaire_manager,
                                formation_existante, nb_formations_existantes,
                                statut, payload_signal, archive, created_at, updated_at
                            ) VALUES (
                                %s, %s, %s, %s,
                                'insights', 'analyse_competences', 'individuel',
                                %s, %s, %s,
                                %s, %s, %s, %s, %s,
                                %s, %s, %s,
                                %s, %s, %s,
                                %s, %s, %s, %s,
                                %s, %s, %s, %s, %s::jsonb,
                                %s, %s, %s,
                                %s, %s,
                                'envoye_studio', %s::jsonb, FALSE, NOW(), NOW()
                            )
                            RETURNING id_besoin_formation, statut
                            """,
                            (
                                str(uuid.uuid4()), id_owner_dest, id_ent, id_contact,
                                id_comp, signal.get("code_competence"), signal.get("intitule_competence"),
                                signal.get("id_poste"), signal.get("code_poste"), signal.get("intitule_poste"), signal.get("id_service"), signal.get("nom_service"),
                                signal.get("id_effectif_concerne"), signal.get("nom_effectif"), signal.get("prenom_effectif"),
                                signal.get("niveau_requis"), signal.get("niveau_actuel"), _i(signal.get("ecart_niveau")),
                                _i(signal.get("criticite")), _i(signal.get("indice_fragilite")), _i(signal.get("score_anticipation")), signal.get("priorite"),
                                signal.get("delai_recommande"), final_delai, periode_souhaitee, precision_periode, modalites_json,
                                signal.get("motif_priorite"), commentaire_manager, commentaire_manager,
                                bool(signal.get("formation_existante")), _i(signal.get("nb_formations_existantes")),
                                payload_signal,
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