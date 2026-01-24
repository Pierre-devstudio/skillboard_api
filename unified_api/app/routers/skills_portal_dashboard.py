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
                          AND COALESCE(c.etat, 'valide') = 'valide'
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
