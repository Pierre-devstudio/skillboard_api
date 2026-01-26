from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn, fetch_contact_with_entreprise

router = APIRouter()


class SkillsContext(BaseModel):
    id_contact: str
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: str

class DashboardBanner(BaseModel):
    titre: Optional[str] = None
    message: str = ""

class AgePyramidBand(BaseModel):
    label: str
    femmes: int = 0
    hommes: int = 0


class AgePyramidResponse(BaseModel):
    bands: List[AgePyramidBand]

    # Meta (on garde, même si on ne l'affiche plus côté UI)
    total_actifs: int = 0
    unknown_birth: int = 0
    unknown_gender: int = 0

    # KPI — seuils
    seuil_senior: int = 58
    seuil_junior: int = 35

    # KPI 1 — Risque de sortie (58+), dénominateur = actifs avec date naissance
    risk_sortie_pct: float = 0.0
    risk_sortie_count: int = 0
    risk_sortie_total: int = 0

    # KPI 2 — Capacité de relève = <35 / 58+ (sur actifs avec date naissance)
    releve_ratio: Optional[float] = None
    releve_junior: int = 0
    releve_senior: int = 0

    # KPI 3 — Transmission en danger (Experts majoritairement 58+)
    transmission_pct: float = 0.0
    transmission_comp_danger: int = 0
    transmission_comp_total: int = 0

class GlobalGaugeResponse(BaseModel):
    # Limites jauge = somme des seuils min/max requis (A/B/C) sur les compétences critiques (poids > 80)
    gauge_min: float = 0.0
    gauge_max: float = 0.0

    # Position aiguille = somme des scores (dernier audit), audit manquant => 0
    score: float = 0.0

    # Volume de calcul (nb de lignes "compétence requise" agrégées)
    nb_items: int = 0

    # Périmètre futur (droits): si renseigné, jauge calculée uniquement sur ce service
    id_service_scope: Optional[str] = None

class NoTraining12mResponse(BaseModel):
    pct_no_training_12m: float = 0.0
    count_no_training_12m: int = 0
    total_effectif: int = 0
    id_service_scope: Optional[str] = None

class NoPerformance12mResponse(BaseModel):
    pct_no_perf_12m: float = 0.0
    count_no_perf_12m: int = 0
    total_effectif: int = 0
    seuil_couverture: float = 0.7
    id_service_scope: Optional[str] = None

class UpcomingTrainingItem(BaseModel):
    id_action_formation: str
    label: str
    date_debut_formation: Optional[str] = None
    date_fin_formation: Optional[str] = None
    nb_participants: int = 0


class UpcomingTrainingsResponse(BaseModel):
    total: int = 0
    items: List[UpcomingTrainingItem] = []
    id_service_scope: Optional[str] = None

class CertExpiringItem(BaseModel):
    date_expiration: str
    certification: str
    nb_personnes: int = 0


class CertExpiringResponse(BaseModel):
    days: int = 60

    # Badge = total "instances" à renouveler (somme des personnes sur toutes lignes)
    total_instances: int = 0

    # Pour le "+N autres" (nb de lignes agrégées date+certif)
    total_groups: int = 0

    items: List[CertExpiringItem] = []
    id_service_scope: Optional[str] = None

class NoPerformance12mDetailRow(BaseModel):
    id_effectif: str
    nom: str
    prenom: str
    service: Optional[str] = None
    poste: Optional[str] = None

    couverture_pct: float = 0.0
    nb_comp_total: int = 0
    nb_comp_auditees_12m: int = 0
    date_dernier_audit: Optional[str] = None


class NoPerformance12mDetailResponse(BaseModel):
    total: int = 0
    limit: int = 50
    offset: int = 0
    seuil_couverture: float = 0.7

    rows: List[NoPerformance12mDetailRow] = []
    id_service_scope: Optional[str] = None

class NoTraining12mDetailRow(BaseModel):
    id_effectif: str
    nom: str
    prenom: str
    service: Optional[str] = None
    poste: Optional[str] = None

    date_derniere_formation: Optional[str] = None
    jours_depuis_derniere_formation: Optional[int] = None


class NoTraining12mDetailResponse(BaseModel):
    total: int = 0                 # nb de salariés concernés (sans formation 12m)
    total_effectif: int = 0        # effectif actif (périmètre)
    limit: int = 50
    offset: int = 0
    periode_mois: int = 12

    rows: List[NoTraining12mDetailRow] = []
    id_service_scope: Optional[str] = None

class CertExpiringDetailRow(BaseModel):
    date_expiration: str
    jours_avant_expiration: int = 0
    certification: str

    id_effectif: str
    nom: str
    prenom: str
    service: Optional[str] = None
    poste: Optional[str] = None


class CertExpiringDetailResponse(BaseModel):
    days: int = 60
    total: int = 0
    limit: int = 50
    offset: int = 0

    rows: List[CertExpiringDetailRow] = []
    id_service_scope: Optional[str] = None

class UpcomingTrainingParticipant(BaseModel):
    id_effectif: str
    nom: str
    prenom: str
    service: Optional[str] = None
    poste: Optional[str] = None


class UpcomingTrainingSessionDetail(BaseModel):
    id_action_formation: str
    label: str
    date_debut_formation: Optional[str] = None
    date_fin_formation: Optional[str] = None
    nb_participants: int = 0
    participants: List[UpcomingTrainingParticipant] = []


class UpcomingTrainingsDetailResponse(BaseModel):
    total_sessions: int = 0
    limit: int = 20
    offset: int = 0
    items: List[UpcomingTrainingSessionDetail] = []
    id_service_scope: Optional[str] = None

class AgePyramidSeniorRow(BaseModel):
    id_effectif: str
    nom: str
    prenom: str
    age: int = 0

    service: Optional[str] = None
    poste: Optional[str] = None

    date_naissance: Optional[str] = None
    retraite_estimee: Optional[int] = None
    nb_comp_expert: int = 0


class AgePyramidSeniorsDetailResponse(BaseModel):
    age_min: int = 58
    total: int = 0
    limit: int = 50
    offset: int = 0
    rows: List[AgePyramidSeniorRow] = []
    id_service_scope: Optional[str] = None


class TransmissionDangerRow(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    competence: str

    id_effectif: str
    nom: str
    prenom: str
    age: int = 0

    service: Optional[str] = None
    poste: Optional[str] = None


class TransmissionDangerDetailResponse(BaseModel):
    age_min: int = 58
    total: int = 0
    limit: int = 50
    offset: int = 0
    rows: List[TransmissionDangerRow] = []
    id_service_scope: Optional[str] = None

class GlobalGaugeNonCoveredRow(BaseModel):
    id_comp: str
    code_comp: Optional[str] = None
    competence: str = ""

    requis_max_niveau: str = ""      # A/B/C
    requis_max_seuil: int = 0        # 9/18/24

    meilleur_reel: int = 0           # max resultat_eval sur la pop, sinon 0
    ecart: int = 0                   # requis_max_seuil - meilleur_reel

    nb_postes_critiques: int = 0     # nb postes (poids_criticite >= 80) concernés


class GlobalGaugeNonCoveredDetailResponse(BaseModel):
    total: int = 0
    limit: int = 50
    offset: int = 0
    rows: List[GlobalGaugeNonCoveredRow] = []
    id_service_scope: Optional[str] = None


@router.get(
    "/skills/context/{id_contact}",
    response_model=SkillsContext,
)
def get_skills_context(id_contact: str):
    """
    Contexte minimal pour le dashboard / topbar :
    id_contact, civilité, prénom, nom.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, _ = fetch_contact_with_entreprise(cur, id_contact)

        return SkillsContext(
            id_contact=row_contact["id_contact"],
            civilite=row_contact.get("civ_ca"),
            prenom=row_contact.get("prenom_ca"),
            nom=row_contact["nom_ca"],
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
    

@router.get(
    "/skills/dashboard/banner/{id_contact}",
    response_model=DashboardBanner,
)
def get_dashboard_banner(id_contact: str):
    """
    Bandeau d'information du dashboard.
    - Si aucun contenu => message vide (le front masque le bandeau)
    - Si tbl_publicite n'existe pas encore => message vide (squelette safe)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                # On tente de récupérer l'entreprise (selon ce que renvoie fetch_contact_with_entreprise)
                id_entreprise = None
                if isinstance(row_ent, dict):
                    id_entreprise = row_ent.get("id_entreprise")
                if not id_entreprise and isinstance(row_contact, dict):
                    id_entreprise = row_contact.get("id_entreprise")

                # Squelette: si pas d'entreprise => rien à afficher
                if not id_entreprise:
                    return DashboardBanner()

                # IMPORTANT: tant que tbl_publicite n'existe pas, on ne casse rien.
                try:
                    cur.execute(
                        """
                        SELECT
                            titre,
                            message
                        FROM tbl_publicite
                        WHERE archive = FALSE
                          AND (id_entreprise IS NULL OR id_entreprise = %s)
                          AND (date_debut IS NULL OR date_debut <= NOW())
                          AND (date_fin   IS NULL OR date_fin   >= NOW())
                        ORDER BY
                            COALESCE(ordre_affichage, 999999) ASC,
                            date_creation DESC NULLS LAST
                        LIMIT 1
                        """,
                        (id_entreprise,),
                    )
                    row = cur.fetchone()
                except Exception:
                    # table/colonnes pas prêtes => bandeau invisible
                    row = None

        if not row:
            return DashboardBanner()

        titre = (row.get("titre") or None)
        message = (row.get("message") or "")
        message = str(message).strip()

        # si vide => le front masque
        if not message:
            return DashboardBanner()

        return DashboardBanner(
            titre=str(titre).strip() if titre else None,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
    

@router.get(
    "/skills/dashboard/age-pyramid/{id_contact}",
    response_model=AgePyramidResponse,
)
def get_dashboard_age_pyramid(id_contact: str):
    """
    Pyramide des âges (actifs uniquement).
    - Femmes (F) à gauche
    - Hommes (M) à droite
    - Tranches affichées du bas (<25) vers le haut (60+)
      => on renvoie dans l'ordre: 60+, 55-59, 45-54, 35-44, 25-34, <25
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                # fetch_contact_with_entreprise fournit id_ent (pas id_entreprise)
                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return AgePyramidResponse(bands=[])

                # Meta qualité de données
                cur.execute(
                    """
                    SELECT
                        COUNT(*)::int AS total_actifs,
                        SUM(CASE WHEN date_naissance_effectif IS NULL THEN 1 ELSE 0 END)::int AS unknown_birth,
                        SUM(
                            CASE
                                WHEN date_naissance_effectif IS NOT NULL
                                 AND (civilite_effectif IS NULL OR civilite_effectif NOT IN ('M','F'))
                                THEN 1 ELSE 0
                            END
                        )::int AS unknown_gender
                    FROM public.tbl_effectif_client
                    WHERE id_ent = %s
                      AND archive = FALSE
                      AND statut_actif = TRUE
                    """,
                    (id_ent,),
                )
                meta = cur.fetchone() or {}

                                # KPI ÂGE (dénominateur robuste = actifs avec date naissance)
                cur.execute(
                    """
                    WITH base AS (
                        SELECT
                            EXTRACT(YEAR FROM age(CURRENT_DATE, date_naissance_effectif))::int AS age
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                          AND archive = FALSE
                          AND statut_actif = TRUE
                          AND date_naissance_effectif IS NOT NULL
                    )
                    SELECT
                        COUNT(*)::int AS total_age_known,
                        SUM(CASE WHEN age >= 58 THEN 1 ELSE 0 END)::int AS seniors_58,
                        SUM(CASE WHEN age < 35 THEN 1 ELSE 0 END)::int AS juniors_under35
                    FROM base
                    WHERE age IS NOT NULL AND age >= 0
                    """,
                    (id_ent,),
                )
                age_kpis = cur.fetchone() or {}

                # KPI TRANSMISSION (Experts "niveau_actuel" = 'Expert')
                cur.execute(
                    """
                    WITH experts AS (
                        SELECT
                            ecc.id_comp,
                            EXTRACT(YEAR FROM age(CURRENT_DATE, e.date_naissance_effectif))::int AS age
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = ecc.id_effectif_client
                        JOIN public.tbl_competence c
                          ON c.id_comp = ecc.id_comp
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.date_naissance_effectif IS NOT NULL
                          AND ecc.actif = TRUE
                          AND ecc.archive = FALSE
                          AND ecc.niveau_actuel = 'Expert'
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(c.etat, 'active') = 'active'
                    ),
                    agg AS (
                        SELECT
                            id_comp,
                            COUNT(*)::int AS total_experts,
                            SUM(CASE WHEN age >= 58 THEN 1 ELSE 0 END)::int AS experts_58
                        FROM experts
                        WHERE age IS NOT NULL AND age >= 0
                        GROUP BY id_comp
                    )
                    SELECT
                        COUNT(*)::int AS total_comp_with_experts,
                        SUM(CASE WHEN experts_58 * 2 > total_experts THEN 1 ELSE 0 END)::int AS comp_in_danger
                    FROM agg
                    """,
                    (id_ent,),
                )
                trans_kpis = cur.fetchone() or {}


                # Comptage par tranches
                cur.execute(
                    """
                    WITH base AS (
                        SELECT
                            civilite_effectif,
                            EXTRACT(YEAR FROM age(CURRENT_DATE, date_naissance_effectif))::int AS age
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                          AND archive = FALSE
                          AND statut_actif = TRUE
                          AND date_naissance_effectif IS NOT NULL
                    ),
                    binned AS (
                        SELECT
                            CASE
                                WHEN age < 25 THEN '<25'
                                WHEN age BETWEEN 25 AND 34 THEN '25-34'
                                WHEN age BETWEEN 35 AND 44 THEN '35-44'
                                WHEN age BETWEEN 45 AND 54 THEN '45-54'
                                WHEN age BETWEEN 55 AND 59 THEN '55-59'
                                ELSE '60+'
                            END AS tranche,
                            civilite_effectif
                        FROM base
                        WHERE age IS NOT NULL AND age >= 0
                    )
                    SELECT
                        tranche,
                        SUM(CASE WHEN civilite_effectif = 'F' THEN 1 ELSE 0 END)::int AS femmes,
                        SUM(CASE WHEN civilite_effectif = 'M' THEN 1 ELSE 0 END)::int AS hommes
                    FROM binned
                    GROUP BY tranche
                    """,
                    (id_ent,),
                )
                rows = cur.fetchall() or []

        # Normalisation + ordre d'affichage (haut -> bas)
        order = ["60+", "55-59", "45-54", "35-44", "25-34", "<25"]
        by_tranche = {k: {"femmes": 0, "hommes": 0} for k in order}

        for r in rows:
            t = r.get("tranche")
            if t in by_tranche:
                by_tranche[t]["femmes"] = int(r.get("femmes") or 0)
                by_tranche[t]["hommes"] = int(r.get("hommes") or 0)

        bands = [
            AgePyramidBand(label=t, femmes=by_tranche[t]["femmes"], hommes=by_tranche[t]["hommes"])
            for t in order
        ]

        total_age_known = int(age_kpis.get("total_age_known") or 0)
        seniors_58 = int(age_kpis.get("seniors_58") or 0)
        juniors_under35 = int(age_kpis.get("juniors_under35") or 0)

        risk_sortie_pct = round((seniors_58 / total_age_known) * 100.0, 1) if total_age_known else 0.0
        releve_ratio = round((juniors_under35 / seniors_58), 2) if seniors_58 else None

        comp_total = int(trans_kpis.get("total_comp_with_experts") or 0)
        comp_danger = int(trans_kpis.get("comp_in_danger") or 0)
        transmission_pct = round((comp_danger / comp_total) * 100.0, 1) if comp_total else 0.0

        return AgePyramidResponse(
            bands=bands,

            total_actifs=int(meta.get("total_actifs") or 0),
            unknown_birth=int(meta.get("unknown_birth") or 0),
            unknown_gender=int(meta.get("unknown_gender") or 0),

            seuil_senior=58,
            seuil_junior=35,

            risk_sortie_pct=risk_sortie_pct,
            risk_sortie_count=seniors_58,
            risk_sortie_total=total_age_known,

            releve_ratio=releve_ratio,
            releve_junior=juniors_under35,
            releve_senior=seniors_58,

            transmission_pct=transmission_pct,
            transmission_comp_danger=comp_danger,
            transmission_comp_total=comp_total,
        )


    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/global-gauge/{id_contact}",
    response_model=GlobalGaugeResponse,
)
def get_dashboard_global_gauge(id_contact: str, id_service: Optional[str] = None):
    """
    Jauge "État global compétences vs attentes"
    - Périmètre actuel: entreprise entière
    - Périmètre futur (droits):
        * si id_service fourni -> filtre sur tbl_effectif_client.id_service
        * sinon -> tout id_ent
    Règles:
    - Effectifs: statut_actif = TRUE, archive = FALSE, poste actuel requis (id_poste_actuel non null)
    - Compétences pointées: tbl_fiche_poste_competence.poids_criticite > 80 sur le poste actuel
    - Limites jauge: somme des seuils min/max selon niveau requis (A=6-9, B=10-18, C=19-24)
    - Aiguille: somme des resultat_eval du dernier audit (via id_dernier_audit), manquant => 0
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                # id_ent = périmètre entreprise
                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return GlobalGaugeResponse()

                service_filter_sql = ""
                params = [id_ent]

                if id_service:
                    service_filter_sql = " AND e.id_service = %s "
                    params.append(id_service)

                cur.execute(
                    f"""
                    WITH eff AS (
                        SELECT e.id_effectif, e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          {service_filter_sql}
                    )
                    SELECT
                        COALESCE(SUM(
                            CASE fpc.niveau_requis
                                WHEN 'A' THEN 6
                                WHEN 'B' THEN 10
                                WHEN 'C' THEN 19
                                ELSE 0
                            END
                        ), 0)::numeric AS gauge_min,

                        COALESCE(SUM(
                            CASE fpc.niveau_requis
                                WHEN 'A' THEN 9
                                WHEN 'B' THEN 18
                                WHEN 'C' THEN 24
                                ELSE 0
                            END
                        ), 0)::numeric AS gauge_max,

                        COALESCE(SUM(COALESCE(a.resultat_eval, 0)), 0)::numeric AS score_sum,

                        COUNT(*)::int AS nb_items
                    FROM eff
                    JOIN public.tbl_fiche_poste_competence fpc
                      ON fpc.id_poste = eff.id_poste_actuel
                     AND fpc.poids_criticite > 80
                    LEFT JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_client = eff.id_effectif
                     AND ec.id_comp = fpc.id_competence
                     AND ec.actif = TRUE
                     AND ec.archive = FALSE
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = ec.id_dernier_audit
                     AND a.id_effectif_competence = ec.id_effectif_competence
                    """,
                    tuple(params),
                )

                row = cur.fetchone() or {}

        gmin = float(row.get("gauge_min") or 0.0)
        gmax = float(row.get("gauge_max") or 0.0)
        score = float(row.get("score_sum") or 0.0)
        nb = int(row.get("nb_items") or 0)

        return GlobalGaugeResponse(
            gauge_min=gmin,
            gauge_max=gmax,
            score=score,
            nb_items=nb,
            id_service_scope=id_service.strip() if isinstance(id_service, str) and id_service.strip() else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/no-training-12m/{id_contact}",
    response_model=NoTraining12mResponse,
)
def get_dashboard_no_training_12m(id_contact: str, id_service: Optional[str] = None):
    """
    KPI: % de l'effectif actif sans formation depuis 12 mois (toutes sources)
    Source vérité: tbl_effectif_client_historique_formation
    (les formations JMB doivent y être synchronisées via id_action_formation_effectif)

    Règles:
    - Population: statut_actif = TRUE, archive = FALSE, id_poste_actuel NON NULL (comme demandé)
    - Périmètre futur droits: si id_service fourni -> filtre e.id_service = id_service
    - Sans formation 12 mois: aucune ligne non archivée avec date_formation >= CURRENT_DATE - interval '12 months'
    """
    try:
        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return NoTraining12mResponse()

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)

                    ),
                    last_train AS (
                        SELECT
                            h.id_effectif,
                            MAX(h.date_formation) AS last_date
                        FROM public.tbl_effectif_client_historique_formation h
                        JOIN eff ON eff.id_effectif = h.id_effectif
                        WHERE h.archive = FALSE
                        GROUP BY h.id_effectif
                    )
                    SELECT
                        (SELECT COUNT(*) FROM eff)::int AS total_effectif,
                        (SELECT COUNT(*)
                         FROM eff e
                         LEFT JOIN last_train lt ON lt.id_effectif = e.id_effectif
                         WHERE lt.last_date IS NULL
                            OR lt.last_date < (CURRENT_DATE - INTERVAL '12 months')
                        )::int AS count_no_training_12m
                    """,
                    (id_ent, id_service_clean, id_service_clean),
                )

                row = cur.fetchone() or {}

        total_eff = int(row.get("total_effectif") or 0)
        count_no = int(row.get("count_no_training_12m") or 0)
        pct = round((count_no / total_eff) * 100.0, 1) if total_eff else 0.0

        return NoTraining12mResponse(
            pct_no_training_12m=pct,
            count_no_training_12m=count_no,
            total_effectif=total_eff,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/no-performance-12m/{id_contact}",
    response_model=NoPerformance12mResponse,
)
def get_dashboard_no_performance_12m(id_contact: str, id_service: Optional[str] = None):
    """
    KPI: % de salariés (actifs) n'ayant pas eu de "point performance" depuis 12 mois.

    Option A (robuste) :
    - "Point performance OK" si couverture >= 70% des compétences actives du salarié
      ont un audit (dernier audit) dans les 12 derniers mois.
    - Audit manquant => non compté (donc couverture baisse)
    - Si salarié a 0 compétence active => considéré "pas de point" (couverture = 0)

    Règles population:
    - statut_actif = TRUE
    - archive = FALSE
    - id_poste_actuel IS NOT NULL
    - périmètre futur droits : si id_service fourni => filtre e.id_service
    """
    try:
        seuil = 0.7
        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return NoPerformance12mResponse(seuil_couverture=seuil)

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    comp AS (
                        SELECT
                            ecc.id_effectif_client AS id_effectif,
                            ecc.id_effectif_competence,
                            ecc.id_dernier_audit
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN eff ON eff.id_effectif = ecc.id_effectif_client
                        WHERE ecc.actif = TRUE
                          AND ecc.archive = FALSE
                    ),
                    last_audit AS (
                        SELECT
                            c.id_effectif,
                            c.id_effectif_competence,
                            a.date_audit
                        FROM comp c
                        LEFT JOIN public.tbl_effectif_client_audit_competence a
                          ON a.id_audit_competence = c.id_dernier_audit
                         AND a.id_effectif_competence = c.id_effectif_competence
                    ),
                    agg AS (
                        SELECT
                            e.id_effectif,
                            COUNT(c.id_effectif_competence)::int AS total_comp,
                            SUM(
                                CASE
                                    WHEN la.date_audit >= (CURRENT_DATE - INTERVAL '12 months') THEN 1
                                    ELSE 0
                                END
                            )::int AS audited_12m
                        FROM eff e
                        LEFT JOIN comp c ON c.id_effectif = e.id_effectif
                        LEFT JOIN last_audit la ON la.id_effectif_competence = c.id_effectif_competence
                        GROUP BY e.id_effectif
                    )
                    SELECT
                        COUNT(*)::int AS total_effectif,
                        SUM(
                            CASE
                                WHEN total_comp <= 0 THEN 1
                                WHEN (audited_12m::numeric / NULLIF(total_comp, 0)) < %s THEN 1
                                ELSE 0
                            END
                        )::int AS count_no_perf_12m
                    FROM agg
                    """,
                    (id_ent, id_service_clean, id_service_clean, seuil),
                )

                row = cur.fetchone() or {}

        total_eff = int(row.get("total_effectif") or 0)
        count_no = int(row.get("count_no_perf_12m") or 0)
        pct = round((count_no / total_eff) * 100.0, 1) if total_eff else 0.0

        return NoPerformance12mResponse(
            pct_no_perf_12m=pct,
            count_no_perf_12m=count_no,
            total_effectif=total_eff,
            seuil_couverture=seuil,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/upcoming-trainings/{id_contact}",
    response_model=UpcomingTrainingsResponse,
)
def get_dashboard_upcoming_trainings(id_contact: str, id_service: Optional[str] = None):
    """
    Dashboard — Formations à venir
    - Programmée si l'entreprise (id_ent) est présente dans tbl_action_formation_entreprises
    - Dates dans tbl_action_formation
    - Participants via tbl_action_formation_effectif (archive=false)
    - Périmètre futur (droits): si id_service fourni -> on ne garde que les formations
      ayant au moins 1 participant de ce service, et le compteur participants est filtré service.
    """
    try:
        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return UpcomingTrainingsResponse()

                cur.execute(
                    """
                    WITH base AS (
                        SELECT DISTINCT
                            a.id_action_formation,
                            a.date_debut_formation,
                            a.date_fin_formation,
                            COALESCE(NULLIF(a.code_action_formation, ''), a.id_action_formation) AS label
                        FROM public.tbl_action_formation a
                        JOIN public.tbl_action_formation_entreprises ae
                          ON ae.id_action_formation = a.id_action_formation
                         AND ae.id_ent = %s
                        WHERE COALESCE(a.archive, FALSE) = FALSE
                          AND COALESCE(a.date_fin_formation, a.date_debut_formation) IS NOT NULL
                          AND COALESCE(a.date_fin_formation, a.date_debut_formation) >= CURRENT_DATE
                    ),
                    scoped AS (
                        SELECT
                            b.id_action_formation,
                            b.date_debut_formation,
                            b.date_fin_formation,
                            b.label,
                            COUNT(e.id_effectif)::int AS nb_participants
                        FROM base b
                        LEFT JOIN public.tbl_action_formation_effectif afe
                          ON afe.id_action_formation = b.id_action_formation
                         AND COALESCE(afe.archive, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client e
                          ON e.id_effectif = afe.id_effectif
                         AND e.archive = FALSE
                         AND e.statut_actif = TRUE
                         AND (%s::text IS NULL OR e.id_service = %s::text)
                        GROUP BY b.id_action_formation, b.date_debut_formation, b.date_fin_formation, b.label
                        HAVING (%s::text IS NULL OR COUNT(e.id_effectif) > 0)
                    )
                    SELECT
                        s.id_action_formation,
                        s.date_debut_formation,
                        s.date_fin_formation,
                        s.label,
                        s.nb_participants,
                        COUNT(*) OVER()::int AS total
                    FROM scoped s
                    ORDER BY COALESCE(s.date_debut_formation, s.date_fin_formation) ASC
                    LIMIT 3
                    """,
                    (id_ent, id_service_clean, id_service_clean, id_service_clean),
                )

                rows = cur.fetchall() or []

        items: List[UpcomingTrainingItem] = []
        total = 0

        for r in rows:
            total = int(r.get("total") or 0)
            items.append(
                UpcomingTrainingItem(
                    id_action_formation=r["id_action_formation"],
                    label=r.get("label") or r["id_action_formation"],
                    date_debut_formation=str(r["date_debut_formation"]) if r.get("date_debut_formation") else None,
                    date_fin_formation=str(r["date_fin_formation"]) if r.get("date_fin_formation") else None,
                    nb_participants=int(r.get("nb_participants") or 0),
                )
            )

        return UpcomingTrainingsResponse(
            total=total,
            items=items,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
@router.get(
    "/skills/dashboard/certifs-expiring/{id_contact}",
    response_model=CertExpiringResponse,
)
def get_dashboard_certifs_expiring(id_contact: str, days: int = 60, id_service: Optional[str] = None):
    """
    Dashboard — Certifications à renouveler
    - Badge: total des certifications à renouveler (instances = nb personnes à traiter)
    - Micro-liste (3): date expiration + certification + X pers.
    - Périmètre futur (droits): si id_service fourni -> filtre effectif sur ce service

    Règles population (cohérence dashboard):
    - effectif actif: statut_actif = TRUE
    - archive = FALSE
    - id_poste_actuel NON NULL
    - certif détenue: tbl_effectif_client_certification.archive = FALSE
    - date_expiration non NULL, entre aujourd'hui et (aujourd'hui + days)
    - certif masquée: ignorée (tbl_certification.masque = FALSE)
    """
    try:
        days = int(days or 60)
        if days <= 0:
            days = 60

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return CertExpiringResponse(days=days)

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    base AS (
                        SELECT
                            ec.id_effectif,
                            ec.id_certification,
                            ec.date_expiration::date AS date_expiration
                        FROM public.tbl_effectif_client_certification ec
                        JOIN eff ON eff.id_effectif = ec.id_effectif
                        WHERE ec.archive = FALSE
                          AND ec.date_expiration IS NOT NULL
                          AND ec.date_expiration >= CURRENT_DATE
                          AND ec.date_expiration < (CURRENT_DATE + (%s * INTERVAL '1 day'))
                    ),
                    agg AS (
                        SELECT
                            b.date_expiration,
                            c.nom_certification,
                            COUNT(DISTINCT b.id_effectif)::int AS nb_personnes
                        FROM base b
                        JOIN public.tbl_certification c
                          ON c.id_certification = b.id_certification
                         AND COALESCE(c.masque, FALSE) = FALSE
                        GROUP BY b.date_expiration, c.nom_certification
                    )
                    SELECT
                        a.date_expiration,
                        a.nom_certification,
                        a.nb_personnes,
                        SUM(a.nb_personnes) OVER()::int AS total_instances,
                        COUNT(*) OVER()::int AS total_groups
                    FROM agg a
                    ORDER BY a.date_expiration ASC, a.nom_certification ASC
                    LIMIT 3
                    """,
                    (id_ent, id_service_clean, id_service_clean, days),
                )

                rows = cur.fetchall() or []

        items: List[CertExpiringItem] = []
        total_instances = 0
        total_groups = 0

        for r in rows:
            total_instances = int(r.get("total_instances") or 0)
            total_groups = int(r.get("total_groups") or 0)
            items.append(
                CertExpiringItem(
                    date_expiration=str(r["date_expiration"]),
                    certification=str(r.get("nom_certification") or "").strip() or "Certification",
                    nb_personnes=int(r.get("nb_personnes") or 0),
                )
            )

        return CertExpiringResponse(
            days=days,
            total_instances=total_instances,
            total_groups=total_groups,
            items=items,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/no-performance-12m/detail/{id_contact}",
    response_model=NoPerformance12mDetailResponse,
)
def get_dashboard_no_performance_12m_detail(
    id_contact: str,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — salariés "sans point performance" depuis 12 mois (Option A)
    Point performance OK si couverture >= 70% des compétences actives auditées < 12 mois.
    """
    try:
        seuil = 0.7

        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50

        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return NoPerformance12mDetailResponse(
                        total=0,
                        limit=limit,
                        offset=offset,
                        seuil_couverture=seuil,
                        rows=[],
                        id_service_scope=id_service_clean,
                    )

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    comp AS (
                        SELECT
                            ecc.id_effectif_client AS id_effectif,
                            ecc.id_effectif_competence,
                            ecc.id_dernier_audit
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN eff ON eff.id_effectif = ecc.id_effectif_client
                        WHERE ecc.actif = TRUE
                          AND ecc.archive = FALSE
                    ),
                    last_audit AS (
                        SELECT
                            c.id_effectif,
                            c.id_effectif_competence,
                            a.date_audit
                        FROM comp c
                        LEFT JOIN public.tbl_effectif_client_audit_competence a
                          ON a.id_audit_competence = c.id_dernier_audit
                         AND a.id_effectif_competence = c.id_effectif_competence
                    ),
                    agg AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel,
                            COUNT(c.id_effectif_competence)::int AS total_comp,
                            SUM(
                                CASE
                                    WHEN la.date_audit >= (CURRENT_DATE - INTERVAL '12 months') THEN 1
                                    ELSE 0
                                END
                            )::int AS audited_12m,
                            MAX(la.date_audit) AS date_dernier_audit
                        FROM eff e
                        LEFT JOIN comp c ON c.id_effectif = e.id_effectif
                        LEFT JOIN last_audit la ON la.id_effectif_competence = c.id_effectif_competence
                        GROUP BY e.id_effectif, e.nom_effectif, e.prenom_effectif, e.id_service, e.id_poste_actuel
                    ),
                    filtered AS (
                        SELECT
                            a.*,
                            CASE
                                WHEN a.total_comp <= 0 THEN 0.0
                                ELSE ROUND((a.audited_12m::numeric / NULLIF(a.total_comp, 0)) * 100.0, 1)
                            END AS couverture_pct
                        FROM agg a
                        WHERE a.total_comp <= 0
                           OR (a.audited_12m::numeric / NULLIF(a.total_comp, 0)) < %s
                    )
                    SELECT
                        f.id_effectif,
                        f.nom_effectif,
                        f.prenom_effectif,
                        o.nom_service,
                        p.intitule_poste,
                        f.total_comp,
                        f.audited_12m,
                        f.date_dernier_audit,
                        f.couverture_pct,
                        COUNT(*) OVER()::int AS total
                    FROM filtered f
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_service = f.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = f.id_poste_actuel
                     AND COALESCE(p.actif, TRUE) = TRUE
                    ORDER BY f.couverture_pct ASC,
                             f.date_dernier_audit ASC NULLS FIRST,
                             f.nom_effectif ASC,
                             f.prenom_effectif ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, seuil, limit, offset),
                )

                rows = cur.fetchall() or []

        total = int(rows[0].get("total") or 0) if rows else 0

        out_rows: List[NoPerformance12mDetailRow] = []
        for r in rows:
            out_rows.append(
                NoPerformance12mDetailRow(
                    id_effectif=str(r["id_effectif"]),
                    nom=str(r.get("nom_effectif") or ""),
                    prenom=str(r.get("prenom_effectif") or ""),
                    service=(str(r.get("nom_service")) if r.get("nom_service") else None),
                    poste=(str(r.get("intitule_poste")) if r.get("intitule_poste") else None),
                    couverture_pct=float(r.get("couverture_pct") or 0.0),
                    nb_comp_total=int(r.get("total_comp") or 0),
                    nb_comp_auditees_12m=int(r.get("audited_12m") or 0),
                    date_dernier_audit=(str(r["date_dernier_audit"]) if r.get("date_dernier_audit") else None),
                )
            )

        return NoPerformance12mDetailResponse(
            total=total,
            limit=limit,
            offset=offset,
            seuil_couverture=seuil,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/no-training-12m/detail/{id_contact}",
    response_model=NoTraining12mDetailResponse,
)
def get_dashboard_no_training_12m_detail(
    id_contact: str,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — salariés sans formation depuis 12 mois.
    Source: tbl_effectif_client_historique_formation (formations internes/externe saisies)
    Règles population:
      - statut_actif = TRUE
      - archive = FALSE
      - id_poste_actuel IS NOT NULL
      - périmètre futur: id_service (si fourni)
    """
    try:
        periode_mois = 12

        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50

        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return NoTraining12mDetailResponse(
                        total=0,
                        total_effectif=0,
                        limit=limit,
                        offset=offset,
                        periode_mois=periode_mois,
                        rows=[],
                        id_service_scope=id_service_clean,
                    )

                # Totaux (même si aucune ligne “concernée”)
                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    last_train AS (
                        SELECT
                            h.id_effectif,
                            MAX(h.date_formation)::date AS date_derniere_formation
                        FROM public.tbl_effectif_client_historique_formation h
                        JOIN eff ON eff.id_effectif = h.id_effectif
                        WHERE h.archive = FALSE
                          AND h.id_ent = %s
                        GROUP BY h.id_effectif
                    ),
                    filt AS (
                        SELECT
                            eff.id_effectif,
                            lt.date_derniere_formation
                        FROM eff
                        LEFT JOIN last_train lt ON lt.id_effectif = eff.id_effectif
                        WHERE lt.date_derniere_formation IS NULL
                           OR lt.date_derniere_formation < (CURRENT_DATE - INTERVAL '12 months')
                    )
                    SELECT
                        (SELECT COUNT(*) FROM eff)::int AS total_effectif,
                        (SELECT COUNT(*) FROM filt)::int AS total_concernes
                    """,
                    (id_ent, id_service_clean, id_service_clean, id_ent),
                )
                tot = cur.fetchone() or {}
                total_effectif = int(tot.get("total_effectif") or 0)
                total_concernes = int(tot.get("total_concernes") or 0)

                # Détail paginé
                cur.execute(
                    """
                    WITH eff AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    last_train AS (
                        SELECT
                            h.id_effectif,
                            MAX(h.date_formation)::date AS date_derniere_formation
                        FROM public.tbl_effectif_client_historique_formation h
                        JOIN eff ON eff.id_effectif = h.id_effectif
                        WHERE h.archive = FALSE
                          AND h.id_ent = %s
                        GROUP BY h.id_effectif
                    ),
                    filt AS (
                        SELECT
                            e.*,
                            lt.date_derniere_formation,
                            CASE
                                WHEN lt.date_derniere_formation IS NULL THEN NULL
                                ELSE (CURRENT_DATE - lt.date_derniere_formation)::int
                            END AS jours_depuis
                        FROM eff e
                        LEFT JOIN last_train lt ON lt.id_effectif = e.id_effectif
                        WHERE lt.date_derniere_formation IS NULL
                           OR lt.date_derniere_formation < (CURRENT_DATE - INTERVAL '12 months')
                    )
                    SELECT
                        f.id_effectif,
                        f.nom_effectif,
                        f.prenom_effectif,
                        o.nom_service,
                        p.intitule_poste,
                        f.date_derniere_formation,
                        f.jours_depuis
                    FROM filt f
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_service = f.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = f.id_poste_actuel
                     AND COALESCE(p.actif, TRUE) = TRUE
                    ORDER BY f.date_derniere_formation ASC NULLS FIRST,
                             f.nom_effectif ASC,
                             f.prenom_effectif ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, id_ent, limit, offset),
                )

                rows = cur.fetchall() or []

        out_rows: List[NoTraining12mDetailRow] = []
        for r in rows:
            out_rows.append(
                NoTraining12mDetailRow(
                    id_effectif=str(r["id_effectif"]),
                    nom=str(r.get("nom_effectif") or ""),
                    prenom=str(r.get("prenom_effectif") or ""),
                    service=(str(r.get("nom_service")) if r.get("nom_service") else None),
                    poste=(str(r.get("intitule_poste")) if r.get("intitule_poste") else None),
                    date_derniere_formation=(str(r["date_derniere_formation"]) if r.get("date_derniere_formation") else None),
                    jours_depuis_derniere_formation=(int(r["jours_depuis"]) if r.get("jours_depuis") is not None else None),
                )
            )

        return NoTraining12mDetailResponse(
            total=total_concernes,
            total_effectif=total_effectif,
            limit=limit,
            offset=offset,
            periode_mois=periode_mois,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/certifs-expiring/detail/{id_contact}",
    response_model=CertExpiringDetailResponse,
)
def get_dashboard_certifs_expiring_detail(
    id_contact: str,
    days: int = 60,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — liste nominative des certifications qui expirent sous X jours.
    """
    try:
        days = int(days or 60)
        if days <= 0:
            days = 60

        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50

        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return CertExpiringDetailResponse(days=days, total=0, limit=limit, offset=offset, rows=[])

                # Total (pour pagination)
                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    base AS (
                        SELECT
                            ec.id_effectif,
                            ec.id_certification,
                            ec.date_expiration::date AS date_expiration
                        FROM public.tbl_effectif_client_certification ec
                        JOIN eff ON eff.id_effectif = ec.id_effectif
                        WHERE ec.archive = FALSE
                          AND ec.date_expiration IS NOT NULL
                          AND ec.date_expiration >= CURRENT_DATE
                          AND ec.date_expiration < (CURRENT_DATE + (%s * INTERVAL '1 day'))
                    )
                    SELECT COUNT(*)::int AS total
                    FROM base b
                    JOIN public.tbl_certification c
                      ON c.id_certification = b.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    """,
                    (id_ent, id_service_clean, id_service_clean, days),
                )
                total = int((cur.fetchone() or {}).get("total") or 0)

                # Détail paginé
                cur.execute(
                    """
                    WITH eff AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    base AS (
                        SELECT
                            ec.id_effectif,
                            ec.id_certification,
                            ec.date_expiration::date AS date_expiration
                        FROM public.tbl_effectif_client_certification ec
                        JOIN eff ON eff.id_effectif = ec.id_effectif
                        WHERE ec.archive = FALSE
                          AND ec.date_expiration IS NOT NULL
                          AND ec.date_expiration >= CURRENT_DATE
                          AND ec.date_expiration < (CURRENT_DATE + (%s * INTERVAL '1 day'))
                    )
                    SELECT
                        b.date_expiration,
                        (b.date_expiration - CURRENT_DATE)::int AS jours_avant_expiration,
                        c.nom_certification,
                        e.id_effectif,
                        e.nom_effectif,
                        e.prenom_effectif,
                        o.nom_service,
                        p.intitule_poste
                    FROM base b
                    JOIN public.tbl_certification c
                      ON c.id_certification = b.id_certification
                     AND COALESCE(c.masque, FALSE) = FALSE
                    JOIN eff e
                      ON e.id_effectif = b.id_effectif
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_service = e.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = e.id_poste_actuel
                     AND COALESCE(p.actif, TRUE) = TRUE
                    ORDER BY b.date_expiration ASC, c.nom_certification ASC, e.nom_effectif ASC, e.prenom_effectif ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, days, limit, offset),
                )

                rows = cur.fetchall() or []

        out_rows: List[CertExpiringDetailRow] = []
        for r in rows:
            out_rows.append(
                CertExpiringDetailRow(
                    date_expiration=str(r["date_expiration"]),
                    jours_avant_expiration=int(r.get("jours_avant_expiration") or 0),
                    certification=str(r.get("nom_certification") or "").strip() or "Certification",
                    id_effectif=str(r["id_effectif"]),
                    nom=str(r.get("nom_effectif") or ""),
                    prenom=str(r.get("prenom_effectif") or ""),
                    service=(str(r.get("nom_service")) if r.get("nom_service") else None),
                    poste=(str(r.get("intitule_poste")) if r.get("intitule_poste") else None),
                )
            )

        return CertExpiringDetailResponse(
            days=days,
            total=total,
            limit=limit,
            offset=offset,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/upcoming-trainings/detail/{id_contact}",
    response_model=UpcomingTrainingsDetailResponse,
)
def get_dashboard_upcoming_trainings_detail(
    id_contact: str,
    limit: int = 20,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — Formations à venir + participants.
    - Même logique de périmètre que le résumé: si id_service fourni -> on garde seulement
      les sessions ayant au moins 1 participant de ce service + participants filtrés service.
    """
    try:
        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        try:
            limit = int(limit or 20)
        except Exception:
            limit = 20

        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 20
        if limit > 100:
            limit = 100
        if offset < 0:
            offset = 0

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return UpcomingTrainingsDetailResponse(limit=limit, offset=offset, items=[], total_sessions=0)

                # 1) Sessions paginées
                cur.execute(
                    """
                    WITH base AS (
                        SELECT DISTINCT
                            a.id_action_formation,
                            a.date_debut_formation,
                            a.date_fin_formation,
                            COALESCE(NULLIF(a.code_action_formation, ''), a.id_action_formation) AS label
                        FROM public.tbl_action_formation a
                        JOIN public.tbl_action_formation_entreprises ae
                          ON ae.id_action_formation = a.id_action_formation
                         AND ae.id_ent = %s
                        WHERE COALESCE(a.archive, FALSE) = FALSE
                          AND COALESCE(a.date_fin_formation, a.date_debut_formation) IS NOT NULL
                          AND COALESCE(a.date_fin_formation, a.date_debut_formation) >= CURRENT_DATE
                    ),
                    scoped AS (
                        SELECT
                            b.id_action_formation,
                            b.date_debut_formation,
                            b.date_fin_formation,
                            b.label,
                            COUNT(e.id_effectif)::int AS nb_participants
                        FROM base b
                        LEFT JOIN public.tbl_action_formation_effectif afe
                          ON afe.id_action_formation = b.id_action_formation
                         AND COALESCE(afe.archive, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client e
                          ON e.id_effectif = afe.id_effectif
                         AND e.archive = FALSE
                         AND e.statut_actif = TRUE
                         AND e.id_poste_actuel IS NOT NULL
                         AND (%s::text IS NULL OR e.id_service = %s::text)
                        GROUP BY b.id_action_formation, b.date_debut_formation, b.date_fin_formation, b.label
                        HAVING (%s::text IS NULL OR COUNT(e.id_effectif) > 0)
                    )
                    SELECT
                        s.id_action_formation,
                        s.date_debut_formation,
                        s.date_fin_formation,
                        s.label,
                        s.nb_participants,
                        COUNT(*) OVER()::int AS total_sessions
                    FROM scoped s
                    ORDER BY COALESCE(s.date_debut_formation, s.date_fin_formation) ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, id_service_clean, limit, offset),
                )

                session_rows = cur.fetchall() or []
                total_sessions = int(session_rows[0].get("total_sessions") or 0) if session_rows else 0

                if not session_rows:
                    return UpcomingTrainingsDetailResponse(
                        total_sessions=0,
                        limit=limit,
                        offset=offset,
                        items=[],
                        id_service_scope=id_service_clean,
                    )

                session_ids = [r["id_action_formation"] for r in session_rows if r.get("id_action_formation")]

                # 2) Participants pour les sessions de la page
                participants_by_session = {}
                if session_ids:
                    cur.execute(
                        """
                        SELECT
                            afe.id_action_formation,
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            o.nom_service,
                            p.intitule_poste
                        FROM public.tbl_action_formation_effectif afe
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = afe.id_effectif
                         AND e.archive = FALSE
                         AND e.statut_actif = TRUE
                         AND e.id_poste_actuel IS NOT NULL
                         AND (%s::text IS NULL OR e.id_service = %s::text)
                        LEFT JOIN public.tbl_entreprise_organigramme o
                          ON o.id_service = e.id_service
                         AND o.archive = FALSE
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = e.id_poste_actuel
                         AND COALESCE(p.actif, TRUE) = TRUE
                        WHERE COALESCE(afe.archive, FALSE) = FALSE
                          AND afe.id_action_formation = ANY(%s)
                        ORDER BY afe.id_action_formation ASC, e.nom_effectif ASC, e.prenom_effectif ASC
                        """,
                        (id_service_clean, id_service_clean, session_ids),
                    )

                    part_rows = cur.fetchall() or []
                    for pr in part_rows:
                        sid = pr.get("id_action_formation")
                        if not sid:
                            continue
                        participants_by_session.setdefault(sid, []).append(
                            UpcomingTrainingParticipant(
                                id_effectif=str(pr["id_effectif"]),
                                nom=str(pr.get("nom_effectif") or ""),
                                prenom=str(pr.get("prenom_effectif") or ""),
                                service=(str(pr.get("nom_service")) if pr.get("nom_service") else None),
                                poste=(str(pr.get("intitule_poste")) if pr.get("intitule_poste") else None),
                            )
                        )

        items: List[UpcomingTrainingSessionDetail] = []
        for r in session_rows:
            sid = str(r["id_action_formation"])
            items.append(
                UpcomingTrainingSessionDetail(
                    id_action_formation=sid,
                    label=str(r.get("label") or "").strip() or sid,
                    date_debut_formation=(str(r["date_debut_formation"]) if r.get("date_debut_formation") else None),
                    date_fin_formation=(str(r["date_fin_formation"]) if r.get("date_fin_formation") else None),
                    nb_participants=int(r.get("nb_participants") or 0),
                    participants=participants_by_session.get(sid, []),
                )
            )

        return UpcomingTrainingsDetailResponse(
            total_sessions=total_sessions,
            limit=limit,
            offset=offset,
            items=items,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/age-pyramid/detail-seniors/{id_contact}",
    response_model=AgePyramidSeniorsDetailResponse,
)
def get_dashboard_age_pyramid_detail_seniors(
    id_contact: str,
    age_min: int = 58,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — liste des seniors (>= age_min) + nb compétences Expert.
    Population:
      - statut_actif=TRUE, archive=FALSE, id_poste_actuel NOT NULL, date_naissance NOT NULL
    """
    try:
        try:
            age_min = int(age_min or 58)
        except Exception:
            age_min = 58
        if age_min < 0:
            age_min = 58

        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50
        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return AgePyramidSeniorsDetailResponse(
                        age_min=age_min, total=0, limit=limit, offset=offset, rows=[], id_service_scope=id_service_clean
                    )

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            e.date_naissance_effectif,
                            e.retraite_estimee,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND e.date_naissance_effectif IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    seniors AS (
                        SELECT
                            ef.*,
                            EXTRACT(YEAR FROM AGE(CURRENT_DATE, ef.date_naissance_effectif))::int AS age
                        FROM eff ef
                        WHERE EXTRACT(YEAR FROM AGE(CURRENT_DATE, ef.date_naissance_effectif))::int >= %s
                    ),
                    expcnt AS (
                        SELECT
                            ecc.id_effectif_client AS id_effectif,
                            COUNT(*)::int AS nb_comp_expert
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN seniors s ON s.id_effectif = ecc.id_effectif_client
                        WHERE ecc.actif = TRUE
                          AND ecc.archive = FALSE
                          AND ecc.niveau_actuel = 'Expert'
                        GROUP BY ecc.id_effectif_client
                    )
                    SELECT
                        s.id_effectif,
                        s.nom_effectif,
                        s.prenom_effectif,
                        s.age,
                        s.date_naissance_effectif,
                        s.retraite_estimee,
                        o.nom_service,
                        p.intitule_poste,
                        COALESCE(ex.nb_comp_expert, 0)::int AS nb_comp_expert,
                        COUNT(*) OVER()::int AS total
                    FROM seniors s
                    LEFT JOIN expcnt ex ON ex.id_effectif = s.id_effectif
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_service = s.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = s.id_poste_actuel
                     AND COALESCE(p.actif, TRUE) = TRUE
                    ORDER BY s.age DESC, s.nom_effectif ASC, s.prenom_effectif ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, age_min, limit, offset),
                )

                rows = cur.fetchall() or []

        total = int(rows[0].get("total") or 0) if rows else 0

        out_rows: List[AgePyramidSeniorRow] = []
        for r in rows:
            out_rows.append(
                AgePyramidSeniorRow(
                    id_effectif=str(r["id_effectif"]),
                    nom=str(r.get("nom_effectif") or ""),
                    prenom=str(r.get("prenom_effectif") or ""),
                    age=int(r.get("age") or 0),
                    service=(str(r.get("nom_service")) if r.get("nom_service") else None),
                    poste=(str(r.get("intitule_poste")) if r.get("intitule_poste") else None),
                    date_naissance=(str(r["date_naissance_effectif"]) if r.get("date_naissance_effectif") else None),
                    retraite_estimee=(int(r["retraite_estimee"]) if r.get("retraite_estimee") is not None else None),
                    nb_comp_expert=int(r.get("nb_comp_expert") or 0),
                )
            )

        return AgePyramidSeniorsDetailResponse(
            age_min=age_min,
            total=total,
            limit=limit,
            offset=offset,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/age-pyramid/detail-transmission-danger/{id_contact}",
    response_model=TransmissionDangerDetailResponse,
)
def get_dashboard_age_pyramid_detail_transmission_danger(
    id_contact: str,
    age_min: int = 58,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — "Transmission en danger"
    Règle :
      - on prend les compétences avec des experts (niveau_actuel='Expert')
      - une compétence est "en danger" si la majorité stricte de ses experts sont seniors (>= age_min)
      - on liste ensuite les experts seniors (>= age_min) sur ces compétences
    Population (cohérence dashboard) :
      - statut_actif=TRUE, archive=FALSE, id_poste_actuel NOT NULL, date_naissance NOT NULL
      - périmètre futur : id_service (si fourni)
    """
    try:
        try:
            age_min = int(age_min or 58)
        except Exception:
            age_min = 58
        if age_min < 0:
            age_min = 58

        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50
        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return TransmissionDangerDetailResponse(
                        age_min=age_min, total=0, limit=limit, offset=offset, rows=[], id_service_scope=id_service_clean
                    )

                cur.execute(
                    """
                    WITH experts AS (
                        SELECT
                            ecc.id_comp,
                            c.code AS code_comp,
                            c.intitule AS competence,
                            e.id_effectif,
                            e.nom_effectif,
                            e.prenom_effectif,
                            EXTRACT(YEAR FROM age(CURRENT_DATE, e.date_naissance_effectif))::int AS age,
                            e.id_service,
                            e.id_poste_actuel
                        FROM public.tbl_effectif_client_competence ecc
                        JOIN public.tbl_effectif_client e
                          ON e.id_effectif = ecc.id_effectif_client
                        JOIN public.tbl_competence c
                          ON c.id_comp = ecc.id_comp
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND e.date_naissance_effectif IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                          AND ecc.actif = TRUE
                          AND ecc.archive = FALSE
                          AND ecc.niveau_actuel = 'Expert'
                          AND COALESCE(c.masque, FALSE) = FALSE
                          AND COALESCE(c.etat, 'active') <> 'inactive'
                    ),
                    agg AS (
                        SELECT
                            id_comp,
                            COUNT(*)::int AS total_experts,
                            SUM(CASE WHEN age >= %s THEN 1 ELSE 0 END)::int AS experts_seniors
                        FROM experts
                        WHERE age IS NOT NULL AND age >= 0
                        GROUP BY id_comp
                    ),
                    danger_comp AS (
                        SELECT id_comp
                        FROM agg
                        WHERE experts_seniors * 2 > total_experts
                    ),
                    danger_rows AS (
                        SELECT *
                        FROM experts
                        WHERE age IS NOT NULL
                          AND age >= %s
                          AND id_comp IN (SELECT id_comp FROM danger_comp)
                    )
                    SELECT
                        dr.id_comp,
                        dr.code_comp,
                        dr.competence,
                        dr.id_effectif,
                        dr.nom_effectif,
                        dr.prenom_effectif,
                        dr.age,
                        o.nom_service,
                        p.intitule_poste,
                        COUNT(*) OVER()::int AS total
                    FROM danger_rows dr
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_service = dr.id_service
                     AND o.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = dr.id_poste_actuel
                     AND COALESCE(p.actif, TRUE) = TRUE
                    ORDER BY dr.competence ASC, dr.nom_effectif ASC, dr.prenom_effectif ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, age_min, age_min, limit, offset),
                )

                rows = cur.fetchall() or []

        total = int(rows[0].get("total") or 0) if rows else 0

        out_rows: List[TransmissionDangerRow] = []
        for r in rows:
            out_rows.append(
                TransmissionDangerRow(
                    id_comp=str(r["id_comp"]),
                    code_comp=(str(r.get("code_comp")) if r.get("code_comp") else None),
                    competence=str(r.get("competence") or "Compétence"),
                    id_effectif=str(r["id_effectif"]),
                    nom=str(r.get("nom_effectif") or ""),
                    prenom=str(r.get("prenom_effectif") or ""),
                    age=int(r.get("age") or 0),
                    service=(str(r.get("nom_service")) if r.get("nom_service") else None),
                    poste=(str(r.get("intitule_poste")) if r.get("intitule_poste") else None),
                )
            )

        return TransmissionDangerDetailResponse(
            age_min=age_min,
            total=total,
            limit=limit,
            offset=offset,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/dashboard/global-gauge/detail-non-covered/{id_contact}",
    response_model=GlobalGaugeNonCoveredDetailResponse,
)
def get_dashboard_global_gauge_detail_non_covered(
    id_contact: str,
    limit: int = 50,
    offset: int = 0,
    id_service: Optional[str] = None,
):
    """
    Détail paginé — "Compétences critiques (poids_criticite >= 80) non couvertes"
    Définition "non couverte" :
      - meilleur niveau réel constaté (max resultat_eval dernier audit sur la population) < niveau requis max (borne haute A=9,B=18,C=24)
    Population :
      - statut_actif = TRUE
      - archive = FALSE
      - id_poste_actuel IS NOT NULL
    Périmètre :
      - entreprise entière (id_ent depuis contact)
      - futur : filtre id_service si fourni
    """
    try:
        try:
            limit = int(limit or 50)
        except Exception:
            limit = 50

        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0

        if limit < 1:
            limit = 50
        if limit > 200:
            limit = 200
        if offset < 0:
            offset = 0

        id_service_clean = id_service.strip() if isinstance(id_service, str) and id_service.strip() else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

                id_ent = None
                if isinstance(row_contact, dict):
                    id_ent = row_contact.get("id_ent")
                if not id_ent and isinstance(row_ent, dict):
                    id_ent = row_ent.get("id_ent")

                if not id_ent:
                    return GlobalGaugeNonCoveredDetailResponse(
                        total=0,
                        limit=limit,
                        offset=offset,
                        rows=[],
                        id_service_scope=id_service_clean,
                    )

                cur.execute(
                    """
                    WITH eff AS (
                        SELECT e.id_effectif, e.id_poste_actuel
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.archive = FALSE
                          AND e.statut_actif = TRUE
                          AND e.id_poste_actuel IS NOT NULL
                          AND (%s::text IS NULL OR e.id_service = %s::text)
                    ),
                    crit AS (
                        SELECT
                            fpc.id_competence,
                            MAX(
                                CASE fpc.niveau_requis
                                    WHEN 'A' THEN 9
                                    WHEN 'B' THEN 18
                                    WHEN 'C' THEN 24
                                    ELSE 0
                                END
                            )::int AS requis_max_seuil,
                            COUNT(DISTINCT eff.id_poste_actuel)::int AS nb_postes_critiques
                        FROM eff
                        JOIN public.tbl_fiche_poste_competence fpc
                          ON fpc.id_poste = eff.id_poste_actuel
                         AND fpc.poids_criticite >= 80
                        GROUP BY fpc.id_competence
                    ),
                    real AS (
                        SELECT
                            crit.id_competence,
                            COALESCE(MAX(COALESCE(a.resultat_eval, 0)), 0)::int AS meilleur_reel
                        FROM crit
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_comp = crit.id_competence
                         AND ec.actif = TRUE
                         AND ec.archive = FALSE
                         AND EXISTS (
                            SELECT 1 FROM eff e2 WHERE e2.id_effectif = ec.id_effectif_client
                         )
                        LEFT JOIN public.tbl_effectif_client_audit_competence a
                          ON a.id_audit_competence = ec.id_dernier_audit
                         AND a.id_effectif_competence = ec.id_effectif_competence
                        GROUP BY crit.id_competence
                    )
                    SELECT
                        crit.id_competence AS id_comp,
                        c.code AS code_comp,
                        c.intitule AS competence,

                        CASE crit.requis_max_seuil
                            WHEN 9 THEN 'A'
                            WHEN 18 THEN 'B'
                            WHEN 24 THEN 'C'
                            ELSE ''
                        END AS requis_max_niveau,
                        crit.requis_max_seuil,

                        COALESCE(real.meilleur_reel, 0)::int AS meilleur_reel,
                        (crit.requis_max_seuil - COALESCE(real.meilleur_reel, 0))::int AS ecart,
                        crit.nb_postes_critiques,

                        COUNT(*) OVER()::int AS total
                    FROM crit
                    LEFT JOIN real ON real.id_competence = crit.id_competence
                    LEFT JOIN public.tbl_competence c
                      ON c.id_comp = crit.id_competence
                    WHERE COALESCE(real.meilleur_reel, 0) < crit.requis_max_seuil
                    ORDER BY
                        (crit.requis_max_seuil - COALESCE(real.meilleur_reel, 0)) DESC,
                        crit.requis_max_seuil DESC,
                        COALESCE(c.intitule, '') ASC
                    LIMIT %s OFFSET %s
                    """,
                    (id_ent, id_service_clean, id_service_clean, limit, offset),
                )

                rows = cur.fetchall() or []

        total = int(rows[0].get("total") or 0) if rows else 0

        out_rows: List[GlobalGaugeNonCoveredRow] = []
        for r in rows:
            out_rows.append(
                GlobalGaugeNonCoveredRow(
                    id_comp=str(r.get("id_comp") or ""),
                    code_comp=(str(r.get("code_comp")) if r.get("code_comp") else None),
                    competence=str(r.get("competence") or ""),

                    requis_max_niveau=str(r.get("requis_max_niveau") or ""),
                    requis_max_seuil=int(r.get("requis_max_seuil") or 0),

                    meilleur_reel=int(r.get("meilleur_reel") or 0),
                    ecart=int(r.get("ecart") or 0),
                    nb_postes_critiques=int(r.get("nb_postes_critiques") or 0),
                )
            )

        return GlobalGaugeNonCoveredDetailResponse(
            total=total,
            limit=limit,
            offset=offset,
            rows=out_rows,
            id_service_scope=id_service_clean,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
