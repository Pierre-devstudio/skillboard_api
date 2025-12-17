from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"


# ======================================================
# Models
# ======================================================
class ServiceNode(BaseModel):
    id_service: str
    nom_service: str
    id_service_parent: Optional[str] = None
    nb_postes: int = 0
    nb_effectifs: int = 0
    children: List["ServiceNode"] = []


class ServiceInfo(BaseModel):
    id_service: str
    nom_service: str


class PosteItem(BaseModel):
    id_poste: str
    codif_poste: str
    intitule_poste: str
    id_service: Optional[str] = None
    isresponsable: Optional[bool] = None

    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None
    mobilite: Optional[str] = None
    niveau_contrainte: Optional[str] = None
    detail_contrainte: Optional[str] = None
    perspectives_evolution: Optional[str] = None
    niveau_education_minimum: Optional[str] = None
    risque_physique: Optional[str] = None

    nb_effectifs: int = 0


class PostesResponse(BaseModel):
    service: ServiceInfo
    postes: List[PosteItem]


ServiceNode.model_rebuild()


# ======================================================
# Helpers
# ======================================================
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict:
    cur.execute(
        """
        SELECT
            c.id_contact,
            c.code_ent,
            c.civ_ca,
            c.prenom_ca,
            c.nom_ca
        FROM public.tbl_contact c
        WHERE c.id_contact = %s
          AND COALESCE(c.masque, FALSE) = FALSE
        """,
        (id_contact,),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Contact introuvable ou masqué.")
    if not row.get("code_ent"):
        raise HTTPException(status_code=400, detail="Contact sans code_ent (id_ent) associé.")
    return row


def _build_tree(flat_services: List[Dict], counts_by_service: Dict[str, Dict[str, int]]) -> List[ServiceNode]:
    nodes: Dict[str, ServiceNode] = {}
    roots: List[ServiceNode] = []

    # Create nodes
    for s in flat_services:
        sid = s["id_service"]
        c = counts_by_service.get(sid, {"nb_postes": 0, "nb_effectifs": 0})
        nodes[sid] = ServiceNode(
            id_service=sid,
            nom_service=s["nom_service"],
            id_service_parent=s.get("id_service_parent"),
            nb_postes=int(c.get("nb_postes") or 0),
            nb_effectifs=int(c.get("nb_effectifs") or 0),
            children=[],
        )

    # Link parent -> child (missing/invalid parent => root)
    for sid, node in nodes.items():
        pid = node.id_service_parent
        if pid and pid in nodes and pid != sid:
            nodes[pid].children.append(node)
        else:
            roots.append(node)

    # Optional: sort children by name for stable display
    def sort_rec(lst: List[ServiceNode]):
        lst.sort(key=lambda x: (x.nom_service or "").lower())
        for n in lst:
            if n.children:
                sort_rec(n.children)

    sort_rec(roots)
    return roots


# ======================================================
# Routes
# ======================================================
@router.get(
    "/skills/organisation/services/{id_contact}",
    response_model=List[ServiceNode],
)
def get_services_tree(id_contact: str):
    """
    Renvoie l'arbre des services (multi-niveaux) + un noeud spécial "Non lié"
    pour les postes sans service (ou service inexistant/archivé).

    Règles:
    - services: tbl_entreprise_organigramme (archive=FALSE)
    - postes: tbl_fiche_poste (actif=TRUE, id_ent)
    - effectifs: tbl_effectif_client (archive=FALSE, statut_actif=TRUE, is_temp=FALSE)
    - pas d'inclusion des sous-services (les compteurs sont strictement sur le service)
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                # Services actifs
                cur.execute(
                    """
                    SELECT
                        o.id_service,
                        o.nom_service,
                        o.id_service_parent
                    FROM public.tbl_entreprise_organigramme o
                    WHERE o.id_ent = %s
                      AND o.archive = FALSE
                    """,
                    (id_ent,),
                )
                services = cur.fetchall() or []
                service_ids = {s["id_service"] for s in services}

                # Postes actifs (pour compteurs)
                cur.execute(
                    """
                    SELECT
                        p.id_poste,
                        p.id_service
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                    """,
                    (id_ent,),
                )
                postes = cur.fetchall() or []

                # Effectifs par poste
                cur.execute(
                    """
                    SELECT
                        e.id_poste_actuel,
                        COUNT(*)::int AS nb
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND e.archive = FALSE
                      AND e.statut_actif = TRUE
                      AND e.is_temp = FALSE
                      AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                    """,
                    (id_ent,),
                )
                eff_rows = cur.fetchall() or []
                eff_by_poste = {r["id_poste_actuel"]: int(r["nb"] or 0) for r in eff_rows}

                # Compteurs par service + non lié
                counts_by_service: Dict[str, Dict[str, int]] = {}
                non_lie_postes = 0
                non_lie_effectifs = 0

                for p in postes:
                    sid = p.get("id_service")
                    pid = p.get("id_poste")
                    nb_eff = eff_by_poste.get(pid, 0)

                    # "Non lié" = NULL ou service absent (archivé/inexistant/diff ent)
                    if not sid or sid not in service_ids:
                        non_lie_postes += 1
                        non_lie_effectifs += nb_eff
                        continue

                    if sid not in counts_by_service:
                        counts_by_service[sid] = {"nb_postes": 0, "nb_effectifs": 0}
                    counts_by_service[sid]["nb_postes"] += 1
                    counts_by_service[sid]["nb_effectifs"] += nb_eff

                # Arbre
                roots = _build_tree(services, counts_by_service)

                # Noeud spécial "Non lié" au niveau root
                non_lie_node = ServiceNode(
                    id_service=NON_LIE_ID,
                    nom_service="Non lié",
                    id_service_parent=None,
                    nb_postes=non_lie_postes,
                    nb_effectifs=non_lie_effectifs,
                    children=[],
                )

                # On le met en premier pour qu'il soit visible tout de suite
                return [non_lie_node] + roots

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/organisation/postes/{id_contact}/{id_service}",
    response_model=PostesResponse,
)
def get_postes_for_service(id_contact: str, id_service: str):
    """
    Renvoie les postes (fiches de poste) rattachés au service sélectionné.
    - Si id_service = "__NON_LIE__", renvoie les postes sans service ou service inexistant/archivé.
    - Pas d'inclusion des sous-services.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                # Effectifs par poste (sous-requête)
                # (on la réutilise via LEFT JOIN)
                eff_subquery = """
                    SELECT
                        e.id_poste_actuel,
                        COUNT(*)::int AS nb
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                      AND e.archive = FALSE
                      AND e.statut_actif = TRUE
                      AND e.is_temp = FALSE
                      AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                """

                if id_service == NON_LIE_ID:
                    service_info = ServiceInfo(id_service=NON_LIE_ID, nom_service="Non lié")

                    cur.execute(
                        f"""
                        SELECT
                            p.id_poste,
                            p.codif_poste,
                            p.intitule_poste,
                            p.id_service,
                            p.isresponsable,
                            p.mission_principale,
                            p.responsabilites,
                            p.mobilite,
                            p.niveau_contrainte,
                            p.detail_contrainte,
                            p.perspectives_evolution,
                            p.niveau_education_minimum,
                            p.risque_physique,
                            COALESCE(ec.nb, 0)::int AS nb_effectifs
                        FROM public.tbl_fiche_poste p
                        LEFT JOIN ({eff_subquery}) ec
                               ON ec.id_poste_actuel = p.id_poste
                        LEFT JOIN public.tbl_entreprise_organigramme o
                               ON o.id_service = p.id_service
                              AND o.id_ent = %s
                              AND o.archive = FALSE
                        WHERE p.id_ent = %s
                          AND COALESCE(p.actif, TRUE) = TRUE
                          AND (p.id_service IS NULL OR o.id_service IS NULL)
                        ORDER BY p.intitule_poste
                        """,
                        (id_ent, id_ent, id_ent),
                    )
                    rows = cur.fetchall() or []

                    postes = [
                        PosteItem(
                            id_poste=r["id_poste"],
                            codif_poste=r["codif_poste"],
                            intitule_poste=r["intitule_poste"],
                            id_service=r.get("id_service"),
                            isresponsable=r.get("isresponsable"),
                            mission_principale=r.get("mission_principale"),
                            responsabilites=r.get("responsabilites"),
                            mobilite=r.get("mobilite"),
                            niveau_contrainte=r.get("niveau_contrainte"),
                            detail_contrainte=r.get("detail_contrainte"),
                            perspectives_evolution=r.get("perspectives_evolution"),
                            niveau_education_minimum=r.get("niveau_education_minimum"),
                            risque_physique=r.get("risque_physique"),
                            nb_effectifs=int(r.get("nb_effectifs") or 0),
                        )
                        for r in rows
                    ]

                    return PostesResponse(service=service_info, postes=postes)

                # Service "normal" (doit exister et être actif)
                cur.execute(
                    """
                    SELECT
                        o.id_service,
                        o.nom_service
                    FROM public.tbl_entreprise_organigramme o
                    WHERE o.id_ent = %s
                      AND o.id_service = %s
                      AND o.archive = FALSE
                    """,
                    (id_ent, id_service),
                )
                srow = cur.fetchone()
                if srow is None:
                    raise HTTPException(status_code=404, detail="Service introuvable (ou archivé).")

                service_info = ServiceInfo(id_service=srow["id_service"], nom_service=srow["nom_service"])

                cur.execute(
                    f"""
                    SELECT
                        p.id_poste,
                        p.codif_poste,
                        p.intitule_poste,
                        p.id_service,
                        p.isresponsable,
                        p.mission_principale,
                        p.responsabilites,
                        p.mobilite,
                        p.niveau_contrainte,
                        p.detail_contrainte,
                        p.perspectives_evolution,
                        p.niveau_education_minimum,
                        p.risque_physique,
                        COALESCE(ec.nb, 0)::int AS nb_effectifs
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN ({eff_subquery}) ec
                           ON ec.id_poste_actuel = p.id_poste
                    WHERE p.id_ent = %s
                      AND COALESCE(p.actif, TRUE) = TRUE
                      AND p.id_service = %s
                    ORDER BY p.intitule_poste
                    """,
                    (id_ent, id_ent, id_service),
                )
                rows = cur.fetchall() or []

                postes = [
                    PosteItem(
                        id_poste=r["id_poste"],
                        codif_poste=r["codif_poste"],
                        intitule_poste=r["intitule_poste"],
                        id_service=r.get("id_service"),
                        isresponsable=r.get("isresponsable"),
                        mission_principale=r.get("mission_principale"),
                        responsabilites=r.get("responsabilites"),
                        mobilite=r.get("mobilite"),
                        niveau_contrainte=r.get("niveau_contrainte"),
                        detail_contrainte=r.get("detail_contrainte"),
                        perspectives_evolution=r.get("perspectives_evolution"),
                        niveau_education_minimum=r.get("niveau_education_minimum"),
                        risque_physique=r.get("risque_physique"),
                        nb_effectifs=int(r.get("nb_effectifs") or 0),
                    )
                    for r in rows
                ]

                return PostesResponse(service=service_info, postes=postes)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
