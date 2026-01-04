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
        SELECT c.id_contact, c.code_ent, c.nom_ca  AS nom, c.prenom_ca AS prenom, c.civ_ca AS civilite
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
    "/skills/referentiel/competences/{id_contact}/{id_service}",
    response_model=ReferentielCompetencesResponse,
)
def get_referentiel_competences_service(
    id_contact: str,
    id_service: str,
    id_domaine: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    etat: Optional[str] = Query(default="valide"),
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

                like = f"%{q.strip()}%" if (q and q.strip()) else None

                where_parts: List[str] = []
                params_where: List[Any] = []

                if id_domaine:
                    where_parts.append("c.domaine = %s")
                    params_where.append(id_domaine)

                if like:
                    where_parts.append("(c.code ILIKE %s OR c.intitule ILIKE %s OR COALESCE(c.description,'') ILIKE %s)")
                    params_where.extend([like, like, like])

                if etat:
                    where_parts.append("c.etat = %s")
                    params_where.append(etat)

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

                sql = f"""
                    WITH
                    {postes_cte},
                    agg_comp AS (
                        SELECT
                            fpc.id_competence,
                            COUNT(DISTINCT fpc.id_poste) AS nb_postes_concernes,
                            MAX(fpc.niveau_requis) AS niveau_requis_max,
                            MIN(fpc.niveau_requis) AS niveau_requis_min
                        FROM public.tbl_fiche_poste_competence fpc
                        JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                        GROUP BY fpc.id_competence
                    ),
                    postes_count AS (
                        SELECT COUNT(*)::int AS nb_postes FROM postes_scope
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.description,
                        c.domaine AS id_domaine_competence,
                        c.niveaua,
                        c.niveaub,
                        c.niveauc,
                        c.grille_evaluation,
                        c.etat,
                        c.masque,
                        a.nb_postes_concernes,
                        a.niveau_requis_max,
                        a.niveau_requis_min,
                        d.titre,
                        d.titre_court,
                        d.description AS domaine_description,
                        d.ordre_affichage,
                        d.couleur,
                        pc.nb_postes
                    FROM agg_comp a
                    JOIN public.tbl_competence c ON c.id_comp = a.id_competence
                    LEFT JOIN public.tbl_domaine_competence d ON d.id_domaine_competence = c.domaine
                    CROSS JOIN postes_count pc
                    {where_sql}
                    ORDER BY
                        COALESCE(d.ordre_affichage, 999999),
                        COALESCE(d.titre_court, d.titre, ''),
                        c.code
                """

                cur.execute(sql, tuple(params_cte + params_where))
                rows = cur.fetchall() or []

                competences: List[CompetenceListItem] = []
                domaines_map: Dict[str, DomaineCompetence] = {}

                nb_postes_scope = int(rows[0].get("nb_postes") or 0) if rows else 0

                for r in rows:
                    flags = _compute_comp_qual_flags(r)

                    did = r.get("id_domaine_competence")
                    if did and did not in domaines_map:
                        domaines_map[did] = DomaineCompetence(
                            id_domaine_competence=did,
                            titre=r.get("titre"),
                            titre_court=r.get("titre_court"),
                            description=r.get("domaine_description"),
                            ordre_affichage=r.get("ordre_affichage"),
                            couleur=r.get("couleur"),
                        )

                    competences.append(
                        CompetenceListItem(
                            id_comp=r["id_comp"],
                            code=r.get("code") or "",
                            intitule=r.get("intitule") or "",
                            id_domaine_competence=did,
                            domaine_titre_court=r.get("titre_court"),
                            domaine_couleur=r.get("couleur"),
                            nb_postes_concernes=int(r.get("nb_postes_concernes") or 0),
                            niveau_requis_max=r.get("niveau_requis_max"),
                            niveau_requis_min=r.get("niveau_requis_min"),
                            niveaux_complets=flags["niveaux_complets"],
                            grille_presente=flags["grille_presente"],
                            etat=r.get("etat"),
                        )
                    )

                total = len(competences)
                pct_niveaux = None
                pct_grille = None
                if total > 0:
                    nb_ok_niv = sum(1 for c in competences if c.niveaux_complets)
                    nb_ok_grille = sum(1 for c in competences if c.grille_presente)
                    pct_niveaux = int(round((nb_ok_niv / total) * 100))
                    pct_grille = int(round((nb_ok_grille / total) * 100))

                kpis = ReferentielKpis(
                    nb_postes=nb_postes_scope,
                    nb_items=total,
                    pct_niveaux_complets=pct_niveaux,
                    pct_grille_eval=pct_grille,
                )

                domaines = sorted(
                    domaines_map.values(),
                    key=lambda d: (
                        d.ordre_affichage if d.ordre_affichage is not None else 999999,
                        (d.titre_court or d.titre or "").lower(),
                    ),
                )

                return ReferentielCompetencesResponse(
                    service=service_scope,
                    kpis=kpis,
                    domaines=domaines,
                    competences=competences,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/referentiel/competence/{id_contact}/{id_service}/{id_comp}",
    response_model=CompetenceDetailResponse,
)
def get_referentiel_competence_detail(
    id_contact: str,
    id_service: str,
    id_comp: str,
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

                comp_where = ["c.id_comp = %s"]
                comp_params: List[Any] = [id_comp]
                if not include_masque:
                    comp_where.append("COALESCE(c.masque, FALSE) = FALSE")

                cur.execute(
                    f"""
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.description,
                        c.domaine AS id_domaine_competence,
                        c.niveaua,
                        c.niveaub,
                        c.niveauc,
                        c.grille_evaluation,
                        c.date_creation,
                        c.date_modification,
                        c.etat,
                        c.masque,
                        c.chemin_sharepoint,
                        d.titre,
                        d.titre_court,
                        d.description AS domaine_description,
                        d.ordre_affichage,
                        d.couleur
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence d ON d.id_domaine_competence = c.domaine
                    WHERE {" AND ".join(comp_where)}
                    """,
                    tuple(comp_params),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Compétence introuvable.")

                did = row.get("id_domaine_competence")
                dom = None
                if did:
                    dom = DomaineCompetence(
                        id_domaine_competence=did,
                        titre=row.get("titre"),
                        titre_court=row.get("titre_court"),
                        description=row.get("domaine_description"),
                        ordre_affichage=row.get("ordre_affichage"),
                        couleur=row.get("couleur"),
                    )

                competence = CompetenceDetail(
                    id_comp=row["id_comp"],
                    code=row.get("code") or "",
                    intitule=row.get("intitule") or "",
                    description=row.get("description"),
                    id_domaine_competence=did,
                    domaine=dom,
                    niveaua=row.get("niveaua"),
                    niveaub=row.get("niveaub"),
                    niveauc=row.get("niveauc"),
                    grille_evaluation=row.get("grille_evaluation"),
                    date_creation=str(row.get("date_creation")) if row.get("date_creation") else None,
                    date_modification=str(row.get("date_modification")) if row.get("date_modification") else None,
                    etat=row.get("etat"),
                    masque=row.get("masque"),
                    chemin_sharepoint=row.get("chemin_sharepoint"),
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
                        fp.isresponsable,
                        fpc.niveau_requis,
                        fpc.poids_criticite,
                        fpc.freq_usage,
                        fpc.impact_resultat,
                        fpc.dependance,
                        fpc.date_valorisation
                    FROM public.tbl_fiche_poste_competence fpc
                    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = fpc.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_service = fp.id_service
                       AND o.id_ent = %s
                    WHERE fpc.id_competence = %s
                    ORDER BY fp.intitule_poste, fp.codif_poste
                """

                params_postes = list(params_cte) + [id_ent, id_comp]
                cur.execute(sql_postes, tuple(params_postes))
                postes_rows = cur.fetchall() or []

                postes = [
                    PosteRequirement(
                        id_poste=p["id_poste"],
                        codif_poste=p.get("codif_poste") or "",
                        intitule_poste=p.get("intitule_poste") or "",
                        id_service=p.get("id_service"),
                        nom_service=p.get("nom_service"),
                        isresponsable=p.get("isresponsable"),
                        niveau_requis=p.get("niveau_requis"),
                        poids_criticite=p.get("poids_criticite"),
                        freq_usage=p.get("freq_usage"),
                        impact_resultat=p.get("impact_resultat"),
                        dependance=p.get("dependance"),
                        date_valorisation=str(p.get("date_valorisation")) if p.get("date_valorisation") else None,
                    )
                    for p in postes_rows
                ]

                return CompetenceDetailResponse(
                    service=service_scope,
                    competence=competence,
                    postes_concernes=postes,
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Endpoints - Certifications
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
                    ),
                    postes_count AS (
                        SELECT COUNT(*)::int AS nb_postes FROM postes_scope
                    )
                    SELECT
                        c.id_certification,
                        c.nom_certification,
                        c.categorie,
                        c.duree_validite,
                        c.masque,
                        a.nb_postes_concernes,
                        a.niveau_exigence_max,
                        pc.nb_postes
                    FROM agg_cert a
                    JOIN public.tbl_certification c ON c.id_certification = a.id_certification
                    CROSS JOIN postes_count pc
                    {where_sql}
                    ORDER BY COALESCE(c.categorie, ''), c.nom_certification
                """

                cur.execute(sql, tuple(params_cte + params_where))
                rows = cur.fetchall() or []

                nb_postes_scope = int(rows[0].get("nb_postes") or 0) if rows else 0

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
