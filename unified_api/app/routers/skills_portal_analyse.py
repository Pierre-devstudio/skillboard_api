from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class AnalyseRisquesTile(BaseModel):
    postes_fragiles: int = 0
    comp_critiques_sans_porteur: int = 0
    comp_bus_factor_1: int = 0


class AnalyseMatchingTile(BaseModel):
    postes_sans_candidat: int = 0
    candidats_prets: int = 0
    candidats_prets_6m: int = 0


class AnalysePrevisionsTile(BaseModel):
    sorties_12m: int = 0
    comp_critiques_impactees: int = 0
    postes_rouges_12m: int = 0


class AnalyseSummaryTiles(BaseModel):
    risques: AnalyseRisquesTile
    matching: AnalyseMatchingTile
    previsions: AnalysePrevisionsTile


class AnalyseSummaryResponse(BaseModel):
    scope: ServiceScope
    updated_at: str
    tiles: AnalyseSummaryTiles


# ======================================================
# Helpers
# ======================================================
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT
            c.id_contact,
            c.code_ent
        FROM public.tbl_contact c
        WHERE c.id_contact = %s
          AND COALESCE(c.masque, FALSE) = FALSE
        """,
        (id_contact,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    if not row.get("code_ent"):
        raise HTTPException(status_code=404, detail="Entreprise introuvable pour ce contact.")
    return row


def _fetch_service_label(cur, id_ent: str, id_service: Optional[str]) -> ServiceScope:
    if not id_service:
        return ServiceScope(id_service=None, nom_service="Tous les services")

    if id_service == NON_LIE_ID:
        return ServiceScope(id_service=NON_LIE_ID, nom_service="Non liés (sans service)")

    cur.execute(
        """
        SELECT o.id_service, o.nom_service
        FROM public.tbl_entreprise_organigramme o
        WHERE o.id_ent = %s
          AND o.id_service = %s
          AND o.archive = FALSE
        """,
        (id_ent, id_service),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")

    return ServiceScope(
        id_service=row["id_service"],
        nom_service=row.get("nom_service") or "Service",
    )

def _build_scope_cte(id_ent: str, id_service: Optional[str]) -> Tuple[str, List[Any]]:
    """
    Construit 2 scopes cohérents:
    - postes_scope: postes actifs dans le périmètre
    - effectifs_scope: effectifs non archivés dans le périmètre
    Périmètre:
    - None/"": toute l’entreprise
    - "__NON_LIE__": id_service NULL ou non présent dans l’organigramme actif
    - sinon: service + descendants (récursif)
    """
    if not id_service:
        cte = """
        postes_scope AS (
            SELECT fp.id_poste
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
        ),
        effectifs_scope AS (
            SELECT e.id_effectif
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
        )
        """
        return cte, [id_ent, id_ent]

    if id_service == NON_LIE_ID:
        cte = """
        valid_services AS (
            SELECT o.id_service
            FROM public.tbl_entreprise_organigramme o
            WHERE o.id_ent = %s
              AND o.archive = FALSE
        ),
        postes_scope AS (
            SELECT fp.id_poste
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
              AND (
                    fp.id_service IS NULL
                    OR fp.id_service NOT IN (SELECT id_service FROM valid_services)
              )
        ),
        effectifs_scope AS (
            SELECT e.id_effectif
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND (
                    e.id_service IS NULL
                    OR e.id_service NOT IN (SELECT id_service FROM valid_services)
              )
        )
        """
        return cte, [id_ent, id_ent, id_ent]

    cte = """
    services_scope AS (
        WITH RECURSIVE s AS (
            SELECT o.id_service
            FROM public.tbl_entreprise_organigramme o
            WHERE o.id_ent = %s
              AND o.archive = FALSE
              AND o.id_service = %s
            UNION ALL
            SELECT o2.id_service
            FROM public.tbl_entreprise_organigramme o2
            JOIN s ON s.id_service = o2.id_service_parent
            WHERE o2.id_ent = %s
              AND o2.archive = FALSE
        )
        SELECT id_service FROM s
    ),
    postes_scope AS (
        SELECT fp.id_poste
        FROM public.tbl_fiche_poste fp
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND fp.id_service IN (SELECT id_service FROM services_scope)
    ),
    effectifs_scope AS (
        SELECT e.id_effectif
        FROM public.tbl_effectif_client e
        WHERE e.id_ent = %s
          AND COALESCE(e.archive, FALSE) = FALSE
          AND e.id_service IN (SELECT id_service FROM services_scope)
    )
    """
    return cte, [id_ent, id_service, id_ent, id_ent, id_ent]


# ======================================================
# Endpoint: Summary (tuiles)
# ======================================================
@router.get(
    "/skills/analyse/summary/{id_contact}",
    response_model=AnalyseSummaryResponse,
)
def get_analyse_summary(
    id_contact: str,
    id_service: Optional[str] = Query(default=None),
):
    """
    V1: summary des tuiles (Risques / Matching / Prévisions).
    - Sert à afficher des KPI "macro" dans l’écran Analyse des compétences.
    - On garde le contrat stable; les calculs viendront ensuite.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                # V1: valeurs par défaut (0) => UI propre, pas d’erreur, pas de “—”
                CRITICITE_MIN = 3  # ajustable: définit ce que tu considères "critique"

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                sql_risques = f"""
                WITH
                {cte_sql},
                req AS (
                    SELECT DISTINCT
                        fpc.id_poste,
                        c.id_comp,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                    ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE
                        c.etat = 'active'
                        AND COALESCE(c.masque, FALSE) = FALSE
                ),
                porteurs AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    GROUP BY ec.id_comp
                )
                SELECT
                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) <= 1 THEN r.id_poste
                        ELSE NULL
                    END)::int AS postes_fragiles,

                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 0 THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_critiques_sans_porteur,

                    COUNT(DISTINCT CASE
                        WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 1 THEN r.id_comp
                        ELSE NULL
                    END)::int AS comp_porteur_unique
                FROM req r
                LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                """

                cur.execute(sql_risques, tuple(cte_params + [CRITICITE_MIN, CRITICITE_MIN, CRITICITE_MIN]))
                rk = cur.fetchone() or {}

                postes_fragiles = int(rk.get("postes_fragiles") or 0)
                comp_critiques_sans_porteur = int(rk.get("comp_critiques_sans_porteur") or 0)
                comp_porteur_unique = int(rk.get("comp_porteur_unique") or 0)

                tiles = AnalyseSummaryTiles(
                    risques=AnalyseRisquesTile(
                        postes_fragiles=postes_fragiles,
                        comp_critiques_sans_porteur=comp_critiques_sans_porteur,
                        comp_bus_factor_1=comp_porteur_unique,  # UI = "Porteur unique"
                    ),
                    matching=AnalyseMatchingTile(
                        postes_sans_candidat=0,
                        candidats_prets=0,
                        candidats_prets_6m=0,
                    ),
                    previsions=AnalysePrevisionsTile(
                        sorties_12m=0,
                        comp_critiques_impactees=0,
                        postes_rouges_12m=0,
                    ),
                )


                return AnalyseSummaryResponse(
                    scope=scope,
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    tiles=tiles,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

# ======================================================
# Models: Détail Risques
# ======================================================
class AnalyseRisqueItem(BaseModel):
    # Poste (pour "postes-fragiles")
    id_poste: Optional[str] = None
    codif_poste: Optional[str] = None
    intitule_poste: Optional[str] = None
    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    nb_critiques_fragiles: Optional[int] = None
    nb_critiques_sans_porteur: Optional[int] = None
    nb_critiques_porteur_unique: Optional[int] = None

    # Compétence (pour "critiques-sans-porteur" et "porteur-unique")
    id_comp: Optional[str] = None
    code: Optional[str] = None
    intitule: Optional[str] = None

    id_domaine_competence: Optional[str] = None
    domaine_titre: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None

    nb_postes_impactes: Optional[int] = None
    nb_porteurs: Optional[int] = None
    max_criticite: Optional[int] = None


class AnalyseRisquesDetailResponse(BaseModel):
    scope: ServiceScope
    kpi: str
    criticite_min: int
    updated_at: str
    items: list[AnalyseRisqueItem]


# ======================================================
# Endpoint: Détail Risques (selon KPI)
# ======================================================
@router.get(
    "/skills/analyse/risques/detail/{id_contact}",
    response_model=AnalyseRisquesDetailResponse,
)
def get_analyse_risques_detail(
    id_contact: str,
    kpi: str = Query(...),  # "postes-fragiles" | "critiques-sans-porteur" | "porteur-unique"
    id_service: Optional[str] = Query(default=None),
    criticite_min: int = Query(default=3),
    limit: int = Query(default=50),
):
    """
    Détail Risques derrière les KPI:
    - postes-fragiles: liste de postes triés par fragilité
    - critiques-sans-porteur: compétences critiques requises mais sans porteur
    - porteur-unique: compétences critiques portées par une seule personne
    """
    try:
        k = (kpi or "").strip().lower()
        if k not in ("postes-fragiles", "critiques-sans-porteur", "porteur-unique"):
            raise HTTPException(status_code=400, detail="Paramètre kpi invalide.")

        if limit < 1:
            limit = 1
        if limit > 200:
            limit = 200

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                cte_sql, cte_params = _build_scope_cte(id_ent, scope.id_service)

                # Base: compétences requises + porteurs (dans le scope)
                base_cte = f"""
                WITH
                {cte_sql},
                req AS (
                    SELECT DISTINCT
                        fpc.id_poste,
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine AS id_domaine_competence,
                        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    WHERE
                        c.etat = 'active'
                        AND COALESCE(c.masque, FALSE) = FALSE
                ),
                porteurs AS (
                    SELECT
                        ec.id_comp,
                        COUNT(DISTINCT ec.id_effectif_client)::int AS nb_porteurs
                    FROM public.tbl_effectif_client_competence ec
                    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
                    GROUP BY ec.id_comp
                )
                """

                items: list[AnalyseRisqueItem] = []

                # ---------------------------
                # KPI: Postes fragiles
                # ---------------------------
                if k == "postes-fragiles":
                    sql = base_cte + """
                    ,
                    poste_agg AS (
                        SELECT
                            r.id_poste,
                            SUM(CASE WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) <= 1 THEN 1 ELSE 0 END)::int AS nb_critiques_fragiles,
                            SUM(CASE WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 0 THEN 1 ELSE 0 END)::int AS nb_critiques_sans_porteur,
                            SUM(CASE WHEN r.poids_criticite >= %s AND COALESCE(p.nb_porteurs, 0) = 1 THEN 1 ELSE 0 END)::int AS nb_critiques_porteur_unique
                        FROM req r
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        GROUP BY r.id_poste
                    )
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        pa.nb_critiques_fragiles,
                        pa.nb_critiques_sans_porteur,
                        pa.nb_critiques_porteur_unique
                    FROM poste_agg pa
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = pa.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    WHERE pa.nb_critiques_fragiles > 0
                    ORDER BY
                        pa.nb_critiques_sans_porteur DESC,
                        pa.nb_critiques_porteur_unique DESC,
                        pa.nb_critiques_fragiles DESC,
                        fp.codif_poste,
                        fp.intitule_poste
                    LIMIT %s
                    """
                    cur.execute(
                        sql,
                        tuple(cte_params + [criticite_min, criticite_min, criticite_min, id_ent, limit])
                    )
                    rows = cur.fetchall() or []
                    for r in rows:
                        items.append(AnalyseRisqueItem(
                            id_poste=r.get("id_poste"),
                            codif_poste=r.get("codif_poste"),
                            intitule_poste=r.get("intitule_poste"),
                            id_service=r.get("id_service"),
                            nom_service=r.get("nom_service"),
                            nb_critiques_fragiles=int(r.get("nb_critiques_fragiles") or 0),
                            nb_critiques_sans_porteur=int(r.get("nb_critiques_sans_porteur") or 0),
                            nb_critiques_porteur_unique=int(r.get("nb_critiques_porteur_unique") or 0),
                        ))

                # ---------------------------
                # KPI: Critiques sans porteur
                # ---------------------------
                elif k == "critiques-sans-porteur":
                    sql = base_cte + """
                    ,
                    comp_agg AS (
                        SELECT
                            r.id_comp,
                            MAX(r.poids_criticite)::int AS max_criticite,
                            COUNT(DISTINCT r.id_poste)::int AS nb_postes_impactes,
                            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs
                        FROM req r
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        WHERE r.poids_criticite >= %s
                          AND COALESCE(p.nb_porteurs, 0) = 0
                        GROUP BY r.id_comp, COALESCE(p.nb_porteurs, 0)
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine AS id_domaine_competence,
                        d.titre,
                        d.titre_court,
                        d.couleur,
                        ca.nb_postes_impactes,
                        ca.nb_porteurs,
                        ca.max_criticite
                    FROM comp_agg ca
                    JOIN public.tbl_competence c ON c.id_comp = ca.id_comp
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    ORDER BY
                        ca.nb_postes_impactes DESC,
                        ca.max_criticite DESC,
                        c.code
                    LIMIT %s
                    """
                    cur.execute(sql, tuple(cte_params + [criticite_min, limit]))
                    rows = cur.fetchall() or []
                    for r in rows:
                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("titre"),
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            nb_porteurs=int(r.get("nb_porteurs") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                        ))

                # ---------------------------
                # KPI: Porteur unique
                # ---------------------------
                else:
                    sql = base_cte + """
                    ,
                    comp_agg AS (
                        SELECT
                            r.id_comp,
                            MAX(r.poids_criticite)::int AS max_criticite,
                            COUNT(DISTINCT r.id_poste)::int AS nb_postes_impactes,
                            COALESCE(p.nb_porteurs, 0)::int AS nb_porteurs
                        FROM req r
                        LEFT JOIN porteurs p ON p.id_comp = r.id_comp
                        WHERE r.poids_criticite >= %s
                          AND COALESCE(p.nb_porteurs, 0) = 1
                        GROUP BY r.id_comp, COALESCE(p.nb_porteurs, 0)
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine AS id_domaine_competence,
                        d.titre,
                        d.titre_court,
                        d.couleur,
                        ca.nb_postes_impactes,
                        ca.nb_porteurs,
                        ca.max_criticite
                    FROM comp_agg ca
                    JOIN public.tbl_competence c ON c.id_comp = ca.id_comp
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    ORDER BY
                        ca.nb_postes_impactes DESC,
                        ca.max_criticite DESC,
                        c.code
                    LIMIT %s
                    """
                    cur.execute(sql, tuple(cte_params + [criticite_min, limit]))
                    rows = cur.fetchall() or []
                    for r in rows:
                        items.append(AnalyseRisqueItem(
                            id_comp=r.get("id_comp"),
                            code=r.get("code"),
                            intitule=r.get("intitule"),
                            id_domaine_competence=r.get("id_domaine_competence"),
                            domaine_titre=r.get("titre"),
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),
                            nb_postes_impactes=int(r.get("nb_postes_impactes") or 0),
                            nb_porteurs=int(r.get("nb_porteurs") or 0),
                            max_criticite=int(r.get("max_criticite") or 0),
                        ))

                return AnalyseRisquesDetailResponse(
                    scope=scope,
                    kpi=k,
                    criticite_min=int(criticite_min),
                    updated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    items=items,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
