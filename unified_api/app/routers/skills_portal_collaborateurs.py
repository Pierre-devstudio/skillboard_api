# app/routers/skills_portal_collaborateurs.py
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

SERVICE_NON_LIE = "__NON_LIE__"


# ======================================================
# Models
# ======================================================
class ServiceItem(BaseModel):
    id_service: str
    nom_service: str
    id_service_parent: Optional[str] = None
    is_virtual: bool = False


class CollaborateurKpis(BaseModel):
    scope_id_service: Optional[str] = None
    total: int
    actifs: int
    sorties_prevues: int
    managers: int
    formateurs: int
    temporaires: int
    non_lies_service: int


class CollaborateurItem(BaseModel):
    id_effectif: str
    nom_effectif: str
    prenom_effectif: str
    email_effectif: Optional[str] = None
    telephone_effectif: Optional[str] = None

    id_service: Optional[str] = None
    nom_service: Optional[str] = None

    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None

    statut_actif: bool
    archive: bool

    ismanager: bool
    isformateur: bool
    is_temp: bool

    date_entree_entreprise_effectif: Optional[str] = None
    date_sortie_prevue: Optional[str] = None
    havedatefin: Optional[bool] = None

class CollaborateurIdentification(BaseModel):
    id_effectif: str
    nom_effectif: str
    prenom_effectif: str

    # Contact (déjà affiché)
    email_effectif: Optional[str] = None
    telephone_effectif: Optional[str] = None

    # Affectation
    id_service: Optional[str] = None
    nom_service: Optional[str] = None
    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None

    # Statuts / rôles (badges côté front)
    statut_actif: bool
    archive: bool
    ismanager: bool
    isformateur: bool
    is_temp: bool

    # RH / contrat
    type_contrat: Optional[str] = None
    matricule: Optional[str] = None
    date_entree_entreprise_effectif: Optional[str] = None
    date_debut_poste_actuel: Optional[str] = None
    date_sortie_prevue: Optional[str] = None
    havedatefin: Optional[bool] = None
    retraite_estimee: Optional[int] = None
    nb_postes_precedents: Optional[int] = None
    motif_sortie: Optional[str] = None

    # Adresse
    adresse_effectif: Optional[str] = None
    code_postal_effectif: Optional[str] = None
    ville_effectif: Optional[str] = None
    pays_effectif: Optional[str] = None
    distance_km_entreprise: Optional[float] = None

    # Profil
    date_naissance_effectif: Optional[str] = None
    niveau_education_code: Optional[str] = None
    niveau_education_label: Optional[str] = None
    domaine_education: Optional[str] = None

    # Notes
    note_commentaire: Optional[str] = None

class CollaborateurCompetenceItem(BaseModel):
    id_comp: str
    code: str
    intitule: str
    domaine: Optional[str] = None

    # Comparatif poste
    is_required: bool = False
    niveau_requis: Optional[str] = None

    # État actuel
    niveau_actuel: Optional[str] = None
    date_derniere_eval: Optional[str] = None
    id_dernier_audit: Optional[str] = None

    # Détails audit (utile plus tard)
    methode_eval: Optional[str] = None
    resultat_eval: Optional[float] = None
    observation: Optional[str] = None

    # Criticité (si valorisée sur le poste)
    poids_criticite: Optional[int] = None
    freq_usage: Optional[int] = None
    impact_resultat: Optional[int] = None
    dependance: Optional[int] = None


class CollaborateurCompetencesResponse(BaseModel):
    id_effectif: str
    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None
    items: List[CollaborateurCompetenceItem]


# ======================================================
# Helpers
# ======================================================
def _get_id_ent_from_contact(cur, id_contact: str) -> str:
    """
    Résout l'entreprise (id_ent) à partir d'un contact.
    Règle : contact valide uniquement si masque = FALSE.
    code_ent contient l'id_ent (oui, on sait, mais on vit avec).
    """
    cur.execute(
        """
        SELECT id_contact, code_ent, masque
        FROM public.tbl_contact
        WHERE id_contact = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (id_contact,),
    )
    c = cur.fetchone()
    if c is None or not c.get("code_ent"):
        raise HTTPException(status_code=404, detail="Contact introuvable ou masqué.")

    id_ent = c["code_ent"]

    cur.execute(
        """
        SELECT id_ent, nom_ent
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (id_ent,),
    )
    e = cur.fetchone()
    if e is None:
        raise HTTPException(status_code=404, detail="Entreprise introuvable ou masquée.")

    return id_ent


def _normalize_id_service(id_service: Optional[str]) -> Optional[str]:
    if id_service is None:
        return None
    v = (id_service or "").strip()
    return v if v else None


def _build_service_where_clause(id_service: Optional[str], params: List):
    """
    Filtrage STRICT sur le service (pas d'inclusion des sous-services).
    - None => pas de filtre service
    - SERVICE_NON_LIE => effectifs sans service (NULL / '')
    - sinon => effectif.id_service = id_service
    """
    sid = _normalize_id_service(id_service)
    if sid is None:
        return "", params

    if sid == SERVICE_NON_LIE:
        return " AND (ec.id_service IS NULL OR ec.id_service = '') ", params

    params.append(sid)
    return " AND ec.id_service = %s ", params


# ======================================================
# Endpoints
# ======================================================
@router.get(
    "/skills/collaborateurs/services/{id_contact}",
    response_model=List[ServiceItem],
)
def get_services_for_filter(id_contact: str):
    """
    Liste des services (organigramme) pour le filtre + entrée virtuelle "Non lié".
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _get_id_ent_from_contact(cur, id_contact)

                cur.execute(
                    """
                    SELECT
                        id_service,
                        nom_service,
                        id_service_parent
                    FROM public.tbl_entreprise_organigramme
                    WHERE id_ent = %s
                      AND archive = FALSE
                    ORDER BY nom_service
                    """,
                    (id_ent,),
                )
                rows = cur.fetchall() or []

        services = [
            ServiceItem(
                id_service=SERVICE_NON_LIE,
                nom_service="Non lié",
                id_service_parent=None,
                is_virtual=True,
            )
        ]

        for r in rows:
            services.append(
                ServiceItem(
                    id_service=r["id_service"],
                    nom_service=r["nom_service"],
                    id_service_parent=r.get("id_service_parent"),
                    is_virtual=False,
                )
            )

        return services

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/collaborateurs/kpis/{id_contact}",
    response_model=CollaborateurKpis,
)
def get_collaborateurs_kpis(
    id_contact: str,
    id_service: Optional[str] = Query(default=None),
):
    """
    KPI collaborateurs, filtrables par service.
    - id_service absent => périmètre entreprise
    - id_service = __NON_LIE__ => collaborateurs sans service
    - sinon => collaborateurs du service (strict)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _get_id_ent_from_contact(cur, id_contact)

                params: List = [id_ent]
                where_service, params = _build_service_where_clause(id_service, params)

                cur.execute(
                    f"""
                    SELECT
                        COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE ec.statut_actif = TRUE)::int AS actifs,
                        COUNT(*) FILTER (
                            WHERE ec.date_sortie_prevue IS NOT NULL
                            AND ec.date_sortie_prevue >= CURRENT_DATE
                            AND ec.date_sortie_prevue < (CURRENT_DATE + INTERVAL '3 years')
                        )::int AS sorties_prevues,
                        COUNT(*) FILTER (WHERE COALESCE(ec.ismanager, FALSE) = TRUE)::int AS managers,
                        COUNT(*) FILTER (WHERE COALESCE(ec.isformateur, FALSE) = TRUE)::int AS formateurs,
                        COUNT(*) FILTER (WHERE COALESCE(ec.is_temp, FALSE) = TRUE)::int AS temporaires,
                        COUNT(*) FILTER (WHERE ec.id_service IS NULL OR ec.id_service = '')::int AS non_lies_service
                    FROM public.tbl_effectif_client ec
                    WHERE ec.id_ent = %s
                      AND ec.archive = FALSE
                    {where_service}
                    """,
                    tuple(params),
                )
                r = cur.fetchone()

        return CollaborateurKpis(
            scope_id_service=_normalize_id_service(id_service),
            total=(r.get("total") or 0),
            actifs=(r.get("actifs") or 0),
            sorties_prevues=(r.get("sorties_prevues") or 0),
            managers=(r.get("managers") or 0),
            formateurs=(r.get("formateurs") or 0),
            temporaires=(r.get("temporaires") or 0),
            non_lies_service=(r.get("non_lies_service") or 0),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/collaborateurs/list/{id_contact}",
    response_model=List[CollaborateurItem],
)
def get_collaborateurs_list(
    id_contact: str,
    q: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    only_actifs: bool = Query(default=True),
    include_archived: bool = Query(default=False),
    only_manager: bool = Query(default=False),
    only_formateur: bool = Query(default=False),
    only_temp: bool = Query(default=False),
):
    """
    Liste collaborateurs filtrable (service strict, recherche texte, toggles).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _get_id_ent_from_contact(cur, id_contact)

                params: List = [id_ent]
                where = " WHERE ec.id_ent = %s "

                # Archivage
                if not include_archived:
                    where += " AND ec.archive = FALSE "

                # Actifs uniquement
                if only_actifs:
                    where += " AND ec.statut_actif = TRUE "

                # Toggles
                if only_manager:
                    where += " AND COALESCE(ec.ismanager, FALSE) = TRUE "
                if only_formateur:
                    where += " AND COALESCE(ec.isformateur, FALSE) = TRUE "
                if only_temp:
                    where += " AND COALESCE(ec.is_temp, FALSE) = TRUE "

                # Filtre service (strict)
                where_service, params = _build_service_where_clause(id_service, params)
                where += where_service

                # Recherche
                qq = (q or "").strip()
                if qq:
                    like = f"%{qq}%"
                    where += """
                        AND (
                             ec.nom_effectif ILIKE %s
                          OR ec.prenom_effectif ILIKE %s
                          OR COALESCE(ec.email_effectif,'') ILIKE %s
                          OR COALESCE(ec.matricule_interne,'') ILIKE %s
                          OR COALESCE(fp.intitule_poste,'') ILIKE %s
                        )
                    """
                    params.extend([like, like, like, like, like])

                # Pagination
                params.extend([limit, offset])

                cur.execute(
                    f"""
                    SELECT
                        ec.id_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.email_effectif,
                        ec.telephone_effectif,

                        ec.id_service,
                        org.nom_service,

                        ec.id_poste_actuel,
                        fp.intitule_poste,

                        COALESCE(ec.statut_actif, FALSE) AS statut_actif,
                        COALESCE(ec.archive, FALSE) AS archive,

                        COALESCE(ec.ismanager, FALSE) AS ismanager,
                        COALESCE(ec.isformateur, FALSE) AS isformateur,
                        COALESCE(ec.is_temp, FALSE) AS is_temp,

                        ec.date_entree_entreprise_effectif,
                        ec.date_sortie_prevue,
                        COALESCE(ec.havedatefin, FALSE) AS havedatefin
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_entreprise_organigramme org
                      ON org.id_service = ec.id_service
                     AND org.id_ent = ec.id_ent
                     AND org.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = ec.id_poste_actuel
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    {where}
                    ORDER BY ec.nom_effectif, ec.prenom_effectif
                    LIMIT %s OFFSET %s
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        out: List[CollaborateurItem] = []
        for r in rows:
            out.append(
                CollaborateurItem(
                    id_effectif=r["id_effectif"],
                    nom_effectif=r["nom_effectif"],
                    prenom_effectif=r["prenom_effectif"],
                    email_effectif=r.get("email_effectif"),
                    telephone_effectif=r.get("telephone_effectif"),
                    id_service=r.get("id_service"),
                    nom_service=r.get("nom_service"),
                    id_poste_actuel=r.get("id_poste_actuel"),
                    intitule_poste=r.get("intitule_poste"),
                    statut_actif=bool(r.get("statut_actif")),
                    archive=bool(r.get("archive")),
                    ismanager=bool(r.get("ismanager")),
                    isformateur=bool(r.get("isformateur")),
                    is_temp=bool(r.get("is_temp")),
                    date_entree_entreprise_effectif=(
                        str(r["date_entree_entreprise_effectif"])
                        if r.get("date_entree_entreprise_effectif") is not None
                        else None
                    ),
                    date_sortie_prevue=(
                        str(r["date_sortie_prevue"])
                        if r.get("date_sortie_prevue") is not None
                        else None
                    ),
                    havedatefin=bool(r.get("havedatefin")) if r.get("havedatefin") is not None else None,
                )
            )

        return out

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/collaborateurs/identification/{id_contact}/{id_effectif}",
    response_model=CollaborateurIdentification,
)
def get_collaborateur_identification(id_contact: str, id_effectif: str):
    """
    Détail "Identification" d'un collaborateur.
    - Ne renvoie pas: civilité, business_travel, champs techniques (date_creation, dernier_update, etc.)
    - Matricule: matricule_interne, sinon code_effectif
    - Retraite estimée: renvoyée uniquement si havedatefin = FALSE
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _get_id_ent_from_contact(cur, id_contact)

                cur.execute(
                    """
                    SELECT
                        ec.id_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,

                        ec.email_effectif,
                        ec.telephone_effectif,

                        ec.adresse_effectif,
                        ec.code_postal_effectif,
                        ec.ville_effectif,
                        ec.pays_effectif,
                        ec.distance_km_entreprise,

                        ec.date_naissance_effectif,
                        ec.niveau_education,
                        ec.domaine_education,

                        ec.id_poste_actuel,
                        fp.intitule_poste,

                        ec.type_contrat,
                        ec.matricule_interne,
                        ec.code_effectif,

                        ec.id_service,
                        org.nom_service,

                        ec.date_entree_entreprise_effectif,
                        ec.date_debut_poste_actuel,
                        ec.date_sortie_prevue,

                        COALESCE(ec.statut_actif, FALSE) AS statut_actif,
                        COALESCE(ec.archive, FALSE) AS archive,

                        COALESCE(ec.ismanager, FALSE) AS ismanager,
                        COALESCE(ec.isformateur, FALSE) AS isformateur,
                        COALESCE(ec.is_temp, FALSE) AS is_temp,

                        COALESCE(ec.havedatefin, FALSE) AS havedatefin,
                        ec.retraite_estimee,

                        COALESCE(ec.nb_postes_precedents, 0) AS nb_postes_precedents,
                        ec.motif_sortie,
                        ec.note_commentaire
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_entreprise_organigramme org
                      ON org.id_service = ec.id_service
                     AND org.id_ent = ec.id_ent
                     AND org.archive = FALSE
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = ec.id_poste_actuel
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE ec.id_ent = %s
                      AND ec.id_effectif = %s
                    """,
                    (id_ent, id_effectif),
                )
                r = cur.fetchone()

        if r is None:
            raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

        # Matricule: matricule_interne sinon code_effectif
        matricule = (r.get("matricule_interne") or "").strip()
        if not matricule:
            matricule = (r.get("code_effectif") or "").strip()
        matricule = matricule if matricule else None

        # Service: si NULL/'' => Non lié
        id_service = _normalize_id_service(r.get("id_service"))
        nom_service = (r.get("nom_service") or "").strip() if id_service else "Non lié"

        # Niveau éducation: transformation soft (à affiner quand tu me donnes la vraie transfo)
        niv_code = (r.get("niveau_education") or "").strip()
        niv_code = niv_code if niv_code else None

        niv_map = {
            "0": "Aucun diplôme",
            "3": "Niveau 3 : CAP, BEP",
            "4": "Niveau 4 : Bac",
            "5": "Niveau 5 : Bac+2 (BTS, DUT)",
            "6": "Niveau 6 : Bac+3 (Licence, BUT)",
            "7": "Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)",
            "8": "Niveau 8 : Bac+8 (Doctorat)",
        }
        if niv_code is None:
            niv_label = None
        else:
            niv_label = niv_map.get(niv_code, "Non renseigné")


        # Retraite estimée seulement si havedatefin = FALSE
        havedatefin = bool(r.get("havedatefin"))
        retraite_estimee = None if havedatefin else r.get("retraite_estimee")

        # Dates => str
        def _s(v):
            return str(v) if v is not None else None

        # Numeric => float
        dist = r.get("distance_km_entreprise")
        dist = float(dist) if dist is not None else None

        return CollaborateurIdentification(
            id_effectif=r["id_effectif"],
            nom_effectif=r["nom_effectif"],
            prenom_effectif=r["prenom_effectif"],

            email_effectif=r.get("email_effectif"),
            telephone_effectif=r.get("telephone_effectif"),

            id_service=id_service,
            nom_service=nom_service,
            id_poste_actuel=r.get("id_poste_actuel"),
            intitule_poste=r.get("intitule_poste"),

            statut_actif=bool(r.get("statut_actif")),
            archive=bool(r.get("archive")),
            ismanager=bool(r.get("ismanager")),
            isformateur=bool(r.get("isformateur")),
            is_temp=bool(r.get("is_temp")),

            type_contrat=r.get("type_contrat"),
            matricule=matricule,

            date_entree_entreprise_effectif=_s(r.get("date_entree_entreprise_effectif")),
            date_debut_poste_actuel=_s(r.get("date_debut_poste_actuel")),
            date_sortie_prevue=_s(r.get("date_sortie_prevue")),
            havedatefin=havedatefin,
            retraite_estimee=retraite_estimee,
            nb_postes_precedents=int(r.get("nb_postes_precedents") or 0),
            motif_sortie=r.get("motif_sortie"),

            adresse_effectif=r.get("adresse_effectif"),
            code_postal_effectif=r.get("code_postal_effectif"),
            ville_effectif=r.get("ville_effectif"),
            pays_effectif=r.get("pays_effectif"),
            distance_km_entreprise=dist,

            date_naissance_effectif=_s(r.get("date_naissance_effectif")),
            niveau_education_code=niv_code,
            niveau_education_label=niv_label,
            domaine_education=r.get("domaine_education"),

            note_commentaire=r.get("note_commentaire"),
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/collaborateurs/competences/{id_contact}/{id_effectif}",
    response_model=CollaborateurCompetencesResponse,
)
def get_collaborateur_competences(id_contact: str, id_effectif: str):
    """
    Onglet Compétences (fiche salarié)
    - Union: compétences requises par le poste + compétences existantes du salarié
    - Niveau actuel: tbl_effectif_client_competence (actif=TRUE, archive=FALSE)
    - Détails dernier audit: via id_dernier_audit -> tbl_effectif_client_audit_competence
    - Catalogue: tbl_competence (etat='active', masque=FALSE)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _get_id_ent_from_contact(cur, id_contact)

                # Poste actuel (et libellé) pour ce salarié
                cur.execute(
                    """
                    SELECT
                        ec.id_effectif,
                        ec.id_poste_actuel,
                        fp.intitule_poste
                    FROM public.tbl_effectif_client ec
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = ec.id_poste_actuel
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE ec.id_ent = %s
                      AND ec.id_effectif = %s
                    """,
                    (id_ent, id_effectif),
                )
                eff = cur.fetchone()
                if eff is None:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                id_poste = eff.get("id_poste_actuel")
                intitule_poste = eff.get("intitule_poste")

                cur.execute(
                    """
                    WITH req AS (
                        SELECT
                            fpc.id_competence AS id_comp,
                            fpc.niveau_requis,
                            fpc.poids_criticite,
                            fpc.freq_usage,
                            fpc.impact_resultat,
                            fpc.dependance
                        FROM public.tbl_fiche_poste_competence fpc
                        WHERE fpc.id_poste = %s
                    ),
                    curc AS (
                        SELECT
                            ecc.id_comp,
                            ecc.niveau_actuel,
                            ecc.date_derniere_eval,
                            ecc.id_dernier_audit
                        FROM public.tbl_effectif_client_competence ecc
                        WHERE ecc.id_effectif_client = %s
                          AND ecc.actif = TRUE
                          AND ecc.archive = FALSE
                    )
                    SELECT
                        c.id_comp,
                        c.code,
                        c.intitule,
                        c.domaine,

                        (req.id_comp IS NOT NULL) AS is_required,
                        req.niveau_requis,

                        curc.niveau_actuel,
                        curc.date_derniere_eval,
                        curc.id_dernier_audit,

                        a.methode_eval,
                        a.resultat_eval,
                        a.observation,

                        req.poids_criticite,
                        req.freq_usage,
                        req.impact_resultat,
                        req.dependance
                    FROM public.tbl_competence c
                    LEFT JOIN req
                      ON req.id_comp = c.id_comp
                    LEFT JOIN curc
                      ON curc.id_comp = c.id_comp
                    LEFT JOIN public.tbl_effectif_client_audit_competence a
                      ON a.id_audit_competence = curc.id_dernier_audit
                    WHERE (req.id_comp IS NOT NULL OR curc.id_comp IS NOT NULL)
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') = 'active'
                    ORDER BY (req.id_comp IS NULL) ASC, c.intitule
                    """,
                    (id_poste, id_effectif),
                )
                rows = cur.fetchall() or []

        def _s(v):
            return str(v) if v is not None else None

        items: List[CollaborateurCompetenceItem] = []
        for r in rows:
            res = r.get("resultat_eval")
            items.append(
                CollaborateurCompetenceItem(
                    id_comp=r["id_comp"],
                    code=r["code"],
                    intitule=r["intitule"],
                    domaine=r.get("domaine"),

                    is_required=bool(r.get("is_required")),
                    niveau_requis=r.get("niveau_requis"),

                    niveau_actuel=r.get("niveau_actuel"),
                    date_derniere_eval=_s(r.get("date_derniere_eval")),
                    id_dernier_audit=r.get("id_dernier_audit"),

                    methode_eval=r.get("methode_eval"),
                    resultat_eval=float(res) if res is not None else None,
                    observation=r.get("observation"),

                    poids_criticite=r.get("poids_criticite"),
                    freq_usage=r.get("freq_usage"),
                    impact_resultat=r.get("impact_resultat"),
                    dependance=r.get("dependance"),
                )
            )

        return CollaborateurCompetencesResponse(
            id_effectif=id_effectif,
            id_poste_actuel=id_poste,
            intitule_poste=intitule_poste,
            items=items,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
