from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: str
    nom_service: str


class DomaineCompetence(BaseModel):
    id_domaine_competence: str
    titre: Optional[str] = None
    titre_court: Optional[str] = None
    description: Optional[str] = None
    ordre_affichage: Optional[int] = None
    couleur: Optional[str] = None


class ReferentielKpis(BaseModel):
    nb_postes: int = 0
    nb_items: int = 0  # compétences ou certifs selon endpoint
    pct_niveaux_complets: Optional[int] = None  # seulement compétences
    pct_grille_eval: Optional[int] = None       # seulement compétences


class CompetenceListItem(BaseModel):
    id_comp: str
    code: str
    intitule: str
    id_domaine_competence: Optional[str] = None
    domaine_titre_court: Optional[str] = None
    domaine_couleur: Optional[str] = None
    nb_postes_concernes: int = 0
    niveau_requis_max: Optional[str] = None
    niveau_requis_min: Optional[str] = None
    niveaux_complets: bool = False
    grille_presente: bool = False
    etat: Optional[str] = None


class ReferentielCompetencesResponse(BaseModel):
    service: ServiceScope
    kpis: ReferentielKpis
    domaines: List[DomaineCompetence]
    competences: List[CompetenceListItem]


class CompetenceDetail(BaseModel):
    id_comp: str
    code: str
    intitule: str
    description: Optional[str] = None
    id_domaine_competence: Optional[str] = None
    domaine: Optional[DomaineCompetence] = None
    niveaua: Optional[str] = None
    niveaub: Optional[str] = None
    niveauc: Optional[str] = None
    grille_evaluation: Optional[Dict[str, Any]] = None
    date_creation: Optional[str] = None
    date_modification: Optional[str] = None
    etat: Optional[str] = None
    masque: Optional[bool] = None
    chemin_sharepoint: Optional[str] = None


class PosteRequirement(BaseModel):
    id_poste: str
    codif_poste: str
    intitule_poste: str
    id_service: Optional[str] = None
    nom_service: Optional[str] = None
    isresponsable: Optional[bool] = None

    niveau_requis: Optional[str] = None
    poids_criticite: Optional[int] = None
    freq_usage: Optional[int] = None
    impact_resultat: Optional[int] = None
    dependance: Optional[int] = None
    date_valorisation: Optional[str] = None


class CompetenceDetailResponse(BaseModel):
    service: ServiceScope
    competence: CompetenceDetail
    postes_concernes: List[PosteRequirement]


class CertificationListItem(BaseModel):
    id_certification: str
    nom_certification: str
    categorie: Optional[str] = None
    duree_validite: Optional[int] = None
    masque: Optional[bool] = None
    nb_postes_concernes: int = 0
    niveau_exigence_max: Optional[str] = None


class ReferentielCertificationsResponse(BaseModel):
    service: ServiceScope
    kpis: ReferentielKpis
    certifications: List[CertificationListItem]


class CertificationDetail(BaseModel):
    id_certification: str
    nom_certification: str
    description: Optional[str] = None
    categorie: Optional[str] = None
    duree_validite: Optional[int] = None
    date_creation: Optional[str] = None
    masque: Optional[bool] = None


class PosteCertificationRequirement(BaseModel):
    id_poste: str
    codif_poste: str
    intitule_poste: str
    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    niveau_exigence: Optional[str] = None
    validite_override: Optional[int] = None
    commentaire: Optional[str] = None


class CertificationDetailResponse(BaseModel):
    service: ServiceScope
    certification: CertificationDetail
    postes_concernes: List[PosteCertificationRequirement]


# ======================================================
# Helpers (internes)
# ======================================================
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT c.id_contact, c.code_ent, c.nom_ca AS nom, c.prenom_ca AS prenom, c.civ_ca AS civilite
        FROM public.tbl_contact c
        WHERE c.id_contact = %s
        """,
        (id_contact,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    if not row.get("code_ent"):
        raise HTTPException(status_code=400, detail="Contact sans code_ent (id_ent) associé.")
    return row


def _fetch_service_label(cur, id_ent: str, id_service: str) -> ServiceScope:
    if id_service == NON_LIE_ID:
        return ServiceScope(id_service=NON_LIE_ID, nom_service="Non lié (sans service)")

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
    return ServiceScope(id_service=row["id_service"], nom_service=row.get("nom_service") or "Service")


def _build_postes_scope_cte(id_service: str) -> str:
    if id_service == NON_LIE_ID:
        return """
            postes_scope AS (
                SELECT fp.id_poste, fp.id_service
                FROM public.tbl_fiche_poste fp
                WHERE fp.id_ent = %s
                  AND COALESCE(fp.actif, TRUE) = TRUE
                  AND (
                        fp.id_service IS NULL
                        OR fp.id_service NOT IN (
                            SELECT o.id_service
                            FROM public.tbl_entreprise_organigramme o
                            WHERE o.id_ent = %s
                              AND o.archive = FALSE
                        )
                      )
            )
        """
    return """
        postes_scope AS (
            SELECT fp.id_poste, fp.id_service
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
              AND fp.id_service = %s
        )
    """


def _compute_comp_qual_flags(row: Dict[str, Any]) -> Dict[str, Any]:
    a = (row.get("niveaua") or "").strip()
    b = (row.get("niveaub") or "").strip()
    c = (row.get("niveauc") or "").strip()
    return {
        "niveaux_complets": bool(a and b and c),
        "grille_presente": row.get("grille_evaluation") is not None,
    }


# ======================================================
# Endpoints - Compétences
# ======================================================
@router.get(
    "/skills/referentiel/certifications/{id_contact}/{id_service}",
    response_model=ReferentielCertificationsResponse,
)
def get_referentiel_certifications_service(
    id_contact: str,
    id_service: str,
    q: Optional[str] = Query(default=None),
    include_masque: bool = Query(default=False),
):
    """
    Référentiel des certifications REQUISES pour un service (via postes -> tbl_fiche_poste_certification).
    NB: on renvoie aussi nb_postes du périmètre même si aucune certification n'est liée (ou filtrée).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                service_scope = _fetch_service_label(cur, id_ent, id_service)
                postes_cte = _build_postes_scope_cte(id_service)

                if id_service == NON_LIE_ID:
                    params_cte = [id_ent, id_ent]
                else:
                    params_cte = [id_ent, id_service]

                # KPI nb_postes (toujours)
                cur.execute(
                    f"""
                    WITH
                    {postes_cte}
                    SELECT COUNT(*)::int AS nb_postes
                    FROM postes_scope
                    """,
                    tuple(params_cte),
                )
                row_count = cur.fetchone() or {}
                nb_postes_scope = int(row_count.get("nb_postes") or 0)

                like = f"%{q.strip()}%" if (q and q.strip()) else None

                where_parts: List[str] = []
                params_where: List[Any] = []

                if like:
                    where_parts.append("(c.nom_certification ILIKE %s OR COALESCE(c.description,'') ILIKE %s)")
                    params_where.extend([like, like])

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

                sql = f"""
                    WITH
                    {postes_cte},
                    agg_cert AS (
                        SELECT
                            fpc.id_certification,
                            COUNT(DISTINCT fpc.id_poste) AS nb_postes_concernes,
                            MAX(fpc.niveau_exigence) AS niveau_exigence_max
                        FROM public.tbl_fiche_poste_certification fpc
                        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                        GROUP BY fpc.id_certification
                    )
                    SELECT
                        c.id_certification,
                        c.nom_certification,
                        c.categorie,
                        c.duree_validite,
                        c.masque,
                        a.nb_postes_concernes,
                        a.niveau_exigence_max
                    FROM agg_cert a
                    JOIN public.tbl_certification c ON c.id_certification = a.id_certification
                    {where_sql}
                    ORDER BY COALESCE(c.categorie, ''), c.nom_certification
                """

                cur.execute(sql, tuple(params_cte + params_where))
                rows = cur.fetchall() or []

                certifs = [
                    CertificationListItem(
                        id_certification=r["id_certification"],
                        nom_certification=r.get("nom_certification") or "",
                        categorie=r.get("categorie"),
                        duree_validite=r.get("duree_validite"),
                        masque=r.get("masque"),
                        nb_postes_concernes=int(r.get("nb_postes_concernes") or 0),
                        niveau_exigence_max=r.get("niveau_exigence_max"),
                    )
                    for r in rows
                ]

                kpis = ReferentielKpis(nb_postes=nb_postes_scope, nb_items=len(certifs))

                return ReferentielCertificationsResponse(
                    service=service_scope,
                    kpis=kpis,
                    certifications=certifs,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/referentiel/certification/{id_contact}/{id_service}/{id_certification}",
    response_model=CertificationDetailResponse,
)
def get_referentiel_certification_detail(
    id_contact: str,
    id_service: str,
    id_certification: str,
    include_masque: bool = Query(default=False),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                service_scope = _fetch_service_label(cur, id_ent, id_service)
                postes_cte = _build_postes_scope_cte(id_service)

                if id_service == NON_LIE_ID:
                    params_cte = [id_ent, id_ent]
                else:
                    params_cte = [id_ent, id_service]

                cert_where = ["c.id_certification = %s"]
                cert_params: List[Any] = [id_certification]
                if not include_masque:
                    cert_where.append("COALESCE(c.masque, FALSE) = FALSE")

                cur.execute(
                    f"""
                    SELECT
                        c.id_certification,
                        c.nom_certification,
                        c.description,
                        c.categorie,
                        c.duree_validite,
                        c.date_creation,
                        c.masque
                    FROM public.tbl_certification c
                    WHERE {" AND ".join(cert_where)}
                    """,
                    tuple(cert_params),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Certification introuvable.")

                cert = CertificationDetail(
                    id_certification=row["id_certification"],
                    nom_certification=row.get("nom_certification") or "",
                    description=row.get("description"),
                    categorie=row.get("categorie"),
                    duree_validite=row.get("duree_validite"),
                    date_creation=str(row.get("date_creation")) if row.get("date_creation") else None,
                    masque=row.get("masque"),
                )

                sql_postes = f"""
                    WITH
                    {postes_cte}
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        o.nom_service,
                        fpc.niveau_exigence,
                        fpc.validite_override,
                        fpc.commentaire
                    FROM public.tbl_fiche_poste_certification fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = fpc.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_service = fp.id_service
                       AND o.id_ent = %s
                    WHERE fpc.id_certification = %s
                    ORDER BY fp.intitule_poste, fp.codif_poste
                """

                params_postes = list(params_cte) + [id_ent, id_certification]
                cur.execute(sql_postes, tuple(params_postes))
                postes_rows = cur.fetchall() or []

                postes = [
                    PosteCertificationRequirement(
                        id_poste=p["id_poste"],
                        codif_poste=p.get("codif_poste") or "",
                        intitule_poste=p.get("intitule_poste") or "",
                        id_service=p.get("id_service"),
                        nom_service=p.get("nom_service"),
                        niveau_exigence=p.get("niveau_exigence"),
                        validite_override=p.get("validite_override"),
                        commentaire=p.get("commentaire"),
                    )
                    for p in postes_rows
                ]

                return CertificationDetailResponse(
                    service=service_scope,
                    certification=cert,
                    postes_concernes=postes,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
