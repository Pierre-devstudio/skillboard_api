# app/routers/skills_portal_collaborateurs.py
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Tuple
import re

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_context,
    skills_require_user,
    skills_validate_enterprise,
)

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

    # Civilité (base: M / F / NULL)
    civilite_effectif: Optional[str] = None  # "M" / "F" / None
    civilite_label: Optional[str] = None     # "M" / "Mme" / "Autre"

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

    # Commentaire
    note_commentaire: Optional[str] = None


class CollaborateurCompetenceItem(BaseModel):
    id_comp: str
    code: str
    intitule: str
    domaine: Optional[str] = None
    domaine_titre: Optional[str] = None
    domaine_couleur: Optional[str] = None

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

class CollaborateurCertificationItem(BaseModel):
    id_certification: str
    nom_certification: str
    categorie: Optional[str] = None
    description: Optional[str] = None

    # Comparatif poste
    is_required: bool = False
    niveau_exigence: Optional[str] = None
    validite_reference: Optional[int] = None
    validite_override: Optional[int] = None
    validite_attendue: Optional[int] = None
    delai_renouvellement: Optional[int] = None  
    commentaire_poste: Optional[str] = None

    # État actuel (salarié)
    is_acquired: bool = False
    id_effectif_certification: Optional[str] = None
    date_obtention: Optional[str] = None
    date_expiration: Optional[str] = None
    date_expiration_calculee: Optional[str] = None
    statut_validite: Optional[str] = None
    jours_restants: Optional[int] = None

    organisme: Optional[str] = None
    reference: Optional[str] = None
    commentaire: Optional[str] = None
    id_preuve_doc: Optional[str] = None


class CollaborateurCertificationsResponse(BaseModel):
    id_effectif: str
    id_poste_actuel: Optional[str] = None
    intitule_poste: Optional[str] = None
    items: List[CollaborateurCertificationItem]

class CollaborateurFormationJmbItem(BaseModel):
    id_action_formation_effectif: str

    id_action_formation: Optional[str] = None
    code_action_formation: Optional[str] = None
    etat_action: Optional[str] = None

    date_debut_formation: Optional[str] = None
    date_fin_formation: Optional[str] = None

    id_form: Optional[str] = None
    code_formation: Optional[str] = None
    titre_formation: Optional[str] = None

    archive_inscription: Optional[bool] = None
    archive_action: Optional[bool] = None


class CollaborateurFormationsJmbResponse(BaseModel):
    id_effectif: str
    items: List[CollaborateurFormationJmbItem]


# ======================================================
# Helpers
# ======================================================

def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
    """
    Résolution entreprise:
    - Si header X-Ent-Id présent => mode super-admin (Supabase auth obligatoire)
    - Sinon => legacy via resolve_insights_context (id_contact = id_effectif)
    """
    x_ent = ""
    try:
        x_ent = (request.headers.get("X-Ent-Id") or "").strip()
    except Exception:
        x_ent = ""

    if x_ent:
        auth = ""
        try:
            auth = request.headers.get("Authorization", "")
        except Exception:
            auth = ""

        u = skills_require_user(auth)
        if not u.get("is_super_admin"):
            raise HTTPException(status_code=403, detail="Accès refusé (X-Ent-Id réservé super-admin).")

        ent = skills_validate_enterprise(cur, x_ent)
        return ent.get("id_ent")

    ctx = resolve_insights_context(cur, id_contact)  # legacy
    return ctx["id_ent"]

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

def _normalize_hex_color(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None

    s = str(v).strip()
    if not s:
        return None

    # 1) Accepte "#RRGGBB" ou "RRGGBB"
    if s.startswith("#"):
        s2 = s[1:].strip()
        if re.fullmatch(r"[0-9a-fA-F]{6}", s2):
            return f"#{s2.lower()}"
    if re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return f"#{s.lower()}"

    # 2) Accepte une couleur stockée en entier signé (ARGB .NET / WinForms)
    # Ex: -16744193, -256, etc.
    try:
        n = int(s, 10) & 0xFFFFFFFF  # convertit en unsigned 32 bits
        r = (n >> 16) & 0xFF
        g = (n >> 8) & 0xFF
        b = n & 0xFF
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        return None



def _resolve_domaine_competence_meta(cur) -> Optional[Tuple[str, str, str]]:
    """
    Trouve la table des domaines de compétences + colonnes (id, titre, couleur).
    On évite de supposer un schéma figé, on détecte via information_schema.
    """
    cur.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name ILIKE 'tbl_domaine%comp%'
        ORDER BY
          CASE WHEN table_name = 'tbl_domaine_competence' THEN 0 ELSE 1 END,
          table_name
        LIMIT 1
        """
    )
    t = cur.fetchone()
    if not t or not t.get("table_name"):
        return None

    table_name = t["table_name"]

    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = %s
        """,
        (table_name,),
    )
    cols = {r["column_name"] for r in (cur.fetchall() or [])}

    id_candidates = [
        "id_domaine_competence",
        "id_domaine",
        "id_dom",
        "id",
    ]
    titre_candidates = [
        "titre",
        "nom",
        "intitule",
        "libelle",
        "titre_domaine",
        "nom_domaine",
    ]
    couleur_candidates = [
        "couleur",
        "color",
        "code_couleur",
        "couleur_hex",
        "hex",
    ]

    id_col = next((c for c in id_candidates if c in cols), None)
    titre_col = next((c for c in titre_candidates if c in cols), None)
    couleur_col = next((c for c in couleur_candidates if c in cols), None)

    if not id_col or not titre_col:
        return None

    # couleur_col peut être absent (on gère avec None)
    return (table_name, id_col, titre_col, couleur_col or "")


def _load_domaine_competence_map(cur, ids: List[str]) -> Dict[str, Dict[str, Optional[str]]]:
    """
    Retourne un mapping:
      { id_domaine: { "titre": "...", "couleur": "#rrggbb" } }
    """
    ids = [str(x).strip() for x in (ids or []) if str(x).strip()]
    if not ids:
        return {}

    meta = _resolve_domaine_competence_meta(cur)
    if meta is None:
        return {}

    table_name, id_col, titre_col, couleur_col = meta

    select_color = "NULL::text AS couleur"
    if couleur_col:
        select_color = f"{couleur_col}::text AS couleur"

    cur.execute(
        f"""
        SELECT
            {id_col}::text AS id,
            {titre_col}::text AS titre,
            {select_color}
        FROM public.{table_name}
        WHERE {id_col} = ANY(%s)
        """,
        (ids,),
    )

    out: Dict[str, Dict[str, Optional[str]]] = {}
    for r in (cur.fetchall() or []):
        did = (r.get("id") or "").strip()
        if not did:
            continue
        out[did] = {
            "titre": (r.get("titre") or "").strip() or None,
            "couleur": _normalize_hex_color(r.get("couleur")),
        }

    return out


# ======================================================
# Endpoints
# ======================================================
@router.get(
    "/skills/collaborateurs/services/{id_contact}",
    response_model=List[ServiceItem],
)
def get_services_for_filter(id_contact: str, request: Request):
    """
    Liste des services (organigramme) pour le filtre + entrée virtuelle "Non lié".
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)



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
    request: Request,
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
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)



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
    request: Request,
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
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)



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
def get_collaborateur_identification(id_contact: str, id_effectif: str, request: Request):
    """
    Détail "Identification" d'un collaborateur.
    - Ne renvoie pas: civilité, business_travel, champs techniques (date_creation, dernier_update, etc.)
    - Matricule: matricule_interne, sinon code_effectif
    - Retraite estimée: renvoyée uniquement si havedatefin = FALSE
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                cur.execute(
                    """
                    SELECT
                        ec.id_effectif,
                        ec.nom_effectif,
                        ec.prenom_effectif,
                        ec.civilite_effectif,

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
        
        # Civilité: base M / F / NULL  -> UI M / Mme / Autre
        civ_raw = r.get("civilite_effectif")
        civ = (str(civ_raw).strip().upper() if civ_raw is not None else None)
        if civ not in ("M", "F"):
            civ = None

        if civ == "M":
            civ_label = "M"
        elif civ == "F":
            civ_label = "Mme"
        else:
            civ_label = "Autre"


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

            
            civilite_effectif=civ,
            civilite_label=civ_label,

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
    
# ------------------------
# Collaborateurs - Listes (services / postes / domaines)
# ------------------------

class SimpleItem(BaseModel):
    id: str
    label: str


@router.get("/skills/collaborateurs/listes/services/{id_contact}", response_model=List[SimpleItem])
def get_liste_services_for_contact(id_contact: str, request: Request):
    """
    Liste des services de l'entreprise (organigramme) pour le contexte du contact connecté.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT
                      o.id_service AS id,
                      o.nom_service AS label
                    FROM public.tbl_entreprise_organigramme o
                    WHERE o.id_ent = %s
                      AND COALESCE(o.archive, FALSE) = FALSE
                      AND COALESCE(o.id_service, '') <> ''
                      AND COALESCE(o.nom_service, '') <> ''
                    ORDER BY o.nom_service ASC
                    """,
                    (id_ent,),
                )
                rows = cur.fetchall() or []

        return [SimpleItem(id=r["id"], label=r["label"]) for r in rows]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get("/skills/collaborateurs/listes/postes/{id_contact}", response_model=List[SimpleItem])
def get_liste_postes_for_contact(id_contact: str, request: Request, id_service: Optional[str] = None):
    """
    Liste des postes de l'entreprise, filtrable par service.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                params = [id_ent]
                where_service = ""
                if id_service and str(id_service).strip():
                    where_service = " AND p.id_service = %s "
                    params.append(str(id_service).strip())

                cur.execute(
                    f"""
                    SELECT
                      p.id_poste AS id,
                      p.intitule_poste AS label
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND COALESCE(p.intitule_poste, '') <> ''
                      {where_service}
                    ORDER BY p.intitule_poste ASC
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        return [SimpleItem(id=r["id"], label=r["label"]) for r in rows]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get("/skills/collaborateurs/listes/nsf_domaines/{id_contact}", response_model=List[str])
def get_liste_nsf_domaines_for_contact(id_contact: str, request: Request):
    """
    Liste des domaines éducation (NSF) : titre uniquement.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # Contexte entreprise (même logique que les autres listes)
                _ = _resolve_id_ent_for_request(cur, id_contact, request)

                cur.execute(
                    """
                    SELECT DISTINCT titre
                    FROM public.tbl_nsf_domaine
                    WHERE COALESCE(titre, '') <> ''
                    ORDER BY titre ASC
                    """
                )
                rows = cur.fetchall() or []

        return [r["titre"] for r in rows if r.get("titre")]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/collaborateurs/competences/{id_contact}/{id_effectif}",
    response_model=CollaborateurCompetencesResponse,
)
def get_collaborateur_competences(id_contact: str, id_effectif: str, request: Request):
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
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


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
                    ORDER BY
                        (req.id_comp IS NULL) ASC,
                        COALESCE(req.poids_criticite, 0) DESC,
                        c.intitule
                    """,
                    (id_poste, id_effectif),
                )
                rows = cur.fetchall() or []

                # Domaine compétence: map id -> (titre, couleur)
                domaine_ids = []
                seen = set()
                for rr in rows:
                    did = (rr.get("domaine") or "").strip()
                    if did and did not in seen:
                        seen.add(did)
                        domaine_ids.append(did)

                domaine_map = _load_domaine_competence_map(cur, domaine_ids)


        def _s(v):
            return str(v) if v is not None else None

        items: List[CollaborateurCompetenceItem] = []
        for r in rows:
            res = r.get("resultat_eval")
            did = (r.get("domaine") or "").strip()
            dmeta = domaine_map.get(did, {}) if did else {}
            dom_titre = dmeta.get("titre")
            dom_couleur = dmeta.get("couleur")
            items.append(
                CollaborateurCompetenceItem(
                    id_comp=r["id_comp"],
                    code=r["code"],
                    intitule=r["intitule"],
                    domaine=r.get("domaine"),
                    domaine_titre=dom_titre,
                    domaine_couleur=dom_couleur,

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
    


@router.get(
    "/skills/collaborateurs/certifications/{id_contact}/{id_effectif}",
    response_model=CollaborateurCertificationsResponse,
)
def get_collaborateur_certifications(id_contact: str, id_effectif: str, request: Request):
    """
    Onglet Certifications (fiche salarié)
    - Union: certifications requises par le poste + certifications acquises par le salarié
    - Acquises: tbl_effectif_client_certification (archive=FALSE) avec prise du dernier enregistrement par certification
    - Validité attendue: COALESCE(tbl_fiche_poste_certification.validite_override, tbl_certification.duree_validite)
    - Statut: 'valide' / 'a_renouveler' / 'expiree' (basé sur date_expiration si renseignée, sinon expiration calculée)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


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
                            fpc.id_certification,
                            fpc.validite_override,
                            fpc.niveau_exigence,
                            fpc.commentaire
                        FROM public.tbl_fiche_poste_certification fpc
                        WHERE fpc.id_poste = %s
                    ),
                    curc_raw AS (
                        SELECT
                            ecc.*,
                            ROW_NUMBER() OVER (
                                PARTITION BY ecc.id_certification
                                ORDER BY
                                    ecc.date_obtention DESC NULLS LAST,
                                    ecc.date_creation DESC,
                                    ecc.id_effectif_certification DESC
                            ) AS rn
                        FROM public.tbl_effectif_client_certification ecc
                        WHERE ecc.id_effectif = %s
                        AND ecc.archive = FALSE
                    ),
                    curc AS (
                        SELECT
                            id_effectif_certification,
                            id_certification,
                            date_obtention,
                            date_expiration,
                            organisme,
                            reference,
                            commentaire,
                            id_preuve_doc
                        FROM curc_raw
                        WHERE rn = 1
                    ),
                    base AS (
                        SELECT
                            c.id_certification,
                            c.nom_certification,
                            c.description,
                            c.categorie,
                            c.delai_renouvellement,

                            (req.id_certification IS NOT NULL) AS is_required,
                            COALESCE(req.niveau_exigence, 'requis') AS niveau_exigence,
                            c.duree_validite AS validite_reference,
                            req.validite_override,
                            COALESCE(req.validite_override, c.duree_validite) AS validite_attendue,
                            req.commentaire AS commentaire_poste,

                            (curc.id_certification IS NOT NULL) AS is_acquired,
                            curc.id_effectif_certification,
                            curc.date_obtention,
                            curc.date_expiration,
                            curc.organisme,
                            curc.reference,
                            curc.commentaire,
                            curc.id_preuve_doc,

                            CASE
                                WHEN curc.date_expiration IS NULL
                                AND curc.date_obtention IS NOT NULL
                                AND COALESCE(req.validite_override, c.duree_validite) IS NOT NULL
                                THEN (curc.date_obtention + make_interval(months => COALESCE(req.validite_override, c.duree_validite)))::date
                                ELSE NULL
                            END AS date_expiration_calculee
                        FROM public.tbl_certification c
                        LEFT JOIN req
                        ON req.id_certification = c.id_certification
                        LEFT JOIN curc
                        ON curc.id_certification = c.id_certification
                        WHERE (req.id_certification IS NOT NULL OR curc.id_certification IS NOT NULL)
                        AND COALESCE(c.masque, FALSE) = FALSE
                    ),
                    calc AS (
                        SELECT
                            b.*,
                            COALESCE(b.date_expiration, b.date_expiration_calculee) AS date_expiration_effective
                        FROM base b
                    )
                    SELECT
                        c.*,
                        CASE
                            WHEN c.date_expiration_effective IS NULL THEN NULL
                            WHEN c.date_expiration_effective < CURRENT_DATE THEN 'expiree'
                            WHEN c.date_expiration_effective < (CURRENT_DATE + COALESCE(c.delai_renouvellement, 60)) THEN 'a_renouveler'
                            ELSE 'valide'
                        END AS statut_validite,
                        CASE
                            WHEN c.date_expiration_effective IS NULL THEN NULL
                            ELSE (c.date_expiration_effective - CURRENT_DATE)
                        END AS jours_restants
                    FROM calc c
                    ORDER BY
                        (c.is_required = FALSE) ASC,
                        CASE lower(COALESCE(c.niveau_exigence, 'requis'))
                            WHEN 'requis' THEN 0
                            WHEN 'souhaite' THEN 1
                            WHEN 'souhaité' THEN 1
                            ELSE 2
                        END ASC,
                        COALESCE(c.categorie, '') ASC,
                        c.nom_certification;
                    """,
                    (id_poste, id_effectif),
                )
                rows = cur.fetchall() or []

        def _s(v):
            return str(v) if v is not None else None

        items: List[CollaborateurCertificationItem] = []
        for r in rows:
            jr = r.get("jours_restants")
            items.append(
                CollaborateurCertificationItem(
                    id_certification=r["id_certification"],
                    nom_certification=r["nom_certification"],
                    categorie=r.get("categorie"),
                    description=r.get("description"),

                    is_required=bool(r.get("is_required")),
                    niveau_exigence=r.get("niveau_exigence"),
                    validite_reference=r.get("validite_reference"),
                    validite_override=r.get("validite_override"),
                    validite_attendue=r.get("validite_attendue"),
                    delai_renouvellement=r.get("delai_renouvellement"),
                    commentaire_poste=r.get("commentaire_poste"),

                    is_acquired=bool(r.get("is_acquired")),
                    id_effectif_certification=r.get("id_effectif_certification"),
                    date_obtention=_s(r.get("date_obtention")),
                    date_expiration=_s(r.get("date_expiration")),
                    date_expiration_calculee=_s(r.get("date_expiration_calculee")),
                    statut_validite=r.get("statut_validite"),
                    jours_restants=int(jr) if jr is not None else None,

                    organisme=r.get("organisme"),
                    reference=r.get("reference"),
                    commentaire=r.get("commentaire"),
                    id_preuve_doc=r.get("id_preuve_doc"),
                )
            )

        return CollaborateurCertificationsResponse(
            id_effectif=id_effectif,
            id_poste_actuel=id_poste,
            intitule_poste=intitule_poste,
            items=items,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")

@router.get(
    "/skills/collaborateurs/historique/formations-jmb/{id_contact}/{id_effectif}",
    response_model=CollaborateurFormationsJmbResponse,
)
def get_collaborateur_formations_jmb(
    id_contact: str,
    id_effectif: str,
    request: Request,
    months: Optional[int] = Query(None, ge=1, le=120),
    include_archived: bool = Query(False),
):
    """
    Historique > Formations effectuées avec JMBCONSULTANT (V1 = liste)
    Source:
      - tbl_action_formation_effectif (inscriptions) -> tbl_action_formation -> tbl_fiche_formation

    Règles:
      - Filtre entreprise via id_contact -> id_ent
      - Par défaut: exclut archives (inscription + action formation)
      - Tri: date_fin DESC, date_debut DESC, date_creation DESC
      - Filtre période: months (si renseigné), basé sur date_fin/date_debut/date_creation
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)

                # Sécurise que l'effectif appartient bien à l'entreprise
                cur.execute(
                    """
                    SELECT id_effectif
                    FROM public.tbl_effectif_client
                    WHERE id_ent = %s
                      AND id_effectif = %s
                    """,
                    (id_ent, id_effectif),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                where_arch = ""
                params: List = [id_ent, id_effectif]

                if not include_archived:
                    where_arch = """
                      AND COALESCE(acfe.archive, FALSE) = FALSE
                      AND COALESCE(af.archive, FALSE) = FALSE
                    """

                where_period = ""
                if months is not None:
                    where_period = """
                      AND COALESCE(af.date_fin_formation, af.date_debut_formation, af.date_creation::date)
                          >= (CURRENT_DATE - make_interval(months => %s))::date
                    """
                    params.append(months)

                cur.execute(
                    f"""
                    SELECT
                        acfe.id_action_formation_effectif,
                        acfe.id_action_formation,
                        COALESCE(acfe.archive, FALSE) AS archive_inscription,

                        af.code_action_formation,
                        af.etat_action,
                        af.date_debut_formation,
                        af.date_fin_formation,
                        COALESCE(af.archive, FALSE) AS archive_action,
                        af.id_form,

                        ff.code AS code_formation,
                        ff.titre AS titre_formation

                    FROM public.tbl_action_formation_effectif acfe
                    JOIN public.tbl_effectif_client ec
                      ON ec.id_effectif = acfe.id_effectif
                    LEFT JOIN public.tbl_action_formation af
                      ON af.id_action_formation = acfe.id_action_formation
                    LEFT JOIN public.tbl_fiche_formation ff
                      ON ff.id_form = af.id_form

                    WHERE ec.id_ent = %s
                      AND acfe.id_effectif = %s
                      AND acfe.id_action_formation IS NOT NULL
                      {where_arch}
                      {where_period}
                      AND (ff.id_form IS NULL OR COALESCE(ff.masque, FALSE) = FALSE)

                    ORDER BY
                      af.date_fin_formation DESC NULLS LAST,
                      af.date_debut_formation DESC NULLS LAST,
                      af.date_creation DESC NULLS LAST,
                      acfe.id_action_formation_effectif DESC
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        def _s(v):
            return str(v) if v is not None else None

        items: List[CollaborateurFormationJmbItem] = []
        for r in rows:
            items.append(
                CollaborateurFormationJmbItem(
                    id_action_formation_effectif=r["id_action_formation_effectif"],
                    id_action_formation=r.get("id_action_formation"),
                    code_action_formation=r.get("code_action_formation"),
                    etat_action=r.get("etat_action"),
                    date_debut_formation=_s(r.get("date_debut_formation")),
                    date_fin_formation=_s(r.get("date_fin_formation")),
                    id_form=r.get("id_form"),
                    code_formation=r.get("code_formation"),
                    titre_formation=r.get("titre_formation"),
                    archive_inscription=bool(r.get("archive_inscription")) if r.get("archive_inscription") is not None else None,
                    archive_action=bool(r.get("archive_action")) if r.get("archive_action") is not None else None,
                )
            )

        return CollaborateurFormationsJmbResponse(id_effectif=id_effectif, items=items)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
