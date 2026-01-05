from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn

router = APIRouter()

NON_LIE_ID = "__NON_LIE__"
ETAT_ACTIVE = "active"


# ======================================================
# Models
# ======================================================
class ServiceScope(BaseModel):
    id_service: Optional[str] = None
    nom_service: str


class DomaineItem(BaseModel):
    id_domaine_competence: str
    titre: Optional[str] = None
    titre_court: Optional[str] = None
    ordre_affichage: Optional[int] = None
    couleur: Optional[str] = None


class PosteItem(BaseModel):
    id_poste: str
    codif_poste: str
    intitule_poste: str
    id_service: Optional[str] = None
    nom_service: Optional[str] = None
    total_competences: int = 0


class MatrixCell(BaseModel):
    id_poste: str
    id_domaine_competence: str
    nb_competences: int


class DomaineTotal(BaseModel):
    id_domaine_competence: str
    total_competences: int


class CartographieMatriceResponse(BaseModel):
    service: ServiceScope
    domaines: List[DomaineItem]
    postes: List[PosteItem]
    matrix: List[MatrixCell]
    totaux_domaines: List[DomaineTotal]
    total_postes: int
    total_competences: int


# ======================================================
# Helpers
# ======================================================
def _fetch_contact_and_ent(cur, id_contact: str) -> Dict[str, Any]:
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
    if not row:
        raise HTTPException(status_code=404, detail="Contact introuvable.")
    return row


def _normalize_etat(etat: Optional[str]) -> Optional[str]:
    if etat is None:
        return None
    s = etat.strip().lower()
    if s == "":
        return None

    # Tolérances front / libellés humains
    if s in ("valide", "validée", "validee", "valider", "valid"):
        return "active"
    if s in ("a valider", "à valider", "a_valider", "a-valider"):
        return "a_valider"
    if s in ("active", "inactive", "a_valider"):
        return s

    # valeur inconnue => on ne filtre pas (évite de casser en prod)
    return None


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


def _build_postes_scope_cte(id_service: Optional[str]) -> Tuple[str, Tuple[Any, ...]]:
    """
    Retourne (cte_sql, params)
    - id_service None/"" => tous les postes de l'entreprise
    - id_service == NON_LIE_ID => postes non liés à un service valide
    - sinon => service + sous-services (récursif)
    """
    if not id_service:
        cte = """
        postes_scope AS (
            SELECT fp.id_poste, fp.id_service
            FROM public.tbl_fiche_poste fp
            WHERE fp.id_ent = %s
              AND COALESCE(fp.actif, TRUE) = TRUE
        )
        """
        params = ()
        return cte, params

    if id_service == NON_LIE_ID:
        cte = """
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
        # params: id_ent, id_ent
        params = ()
        return cte, params

    # service + descendants
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
        SELECT fp.id_poste, fp.id_service
        FROM public.tbl_fiche_poste fp
        WHERE fp.id_ent = %s
          AND COALESCE(fp.actif, TRUE) = TRUE
          AND fp.id_service IN (SELECT id_service FROM services_scope)
    )
    """
    params = ()
    return cte, params


# ======================================================
# Endpoint: Matrice postes x domaines
# ======================================================
@router.get(
    "/skills/cartographie/matrice/{id_contact}",
    response_model=CartographieMatriceResponse,
)
def get_cartographie_matrice(
    id_contact: str,
    id_service: Optional[str] = Query(default=None),
    etat: Optional[str] = Query(default=ETAT_ACTIVE),
    include_masque: bool = Query(default=False),
):
    """
    Matrice "Postes x Domaines" :
    - lignes = postes (périmètre service / tous)
    - colonnes = domaines de compétences
    - cellule = nb de compétences requises (distinct) pour le poste dans le domaine
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                contact = _fetch_contact_and_ent(cur, id_contact)
                id_ent = contact["code_ent"]

                # scope label
                scope = _fetch_service_label(cur, id_ent, (id_service or "").strip() or None)

                # CTE scope postes
                cte_sql, _ = _build_postes_scope_cte(scope.id_service)

                # WHERE compétences
                where_parts: List[str] = []
                params_where: List[Any] = []

                etat_norm = _normalize_etat(etat)
                if etat_norm:
                    where_parts.append("c.etat = %s")
                    params_where.append(etat_norm)

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

                # 1) Postes du scope
                # (on garde le nom_service pour affichage; left join organigramme)
                sql_postes = f"""
                    WITH
                    {cte_sql}
                    SELECT
                        fp.id_poste,
                        fp.codif_poste,
                        fp.intitule_poste,
                        fp.id_service,
                        o.nom_service
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = %s
                     AND o.id_service = fp.id_service
                     AND o.archive = FALSE
                    ORDER BY fp.codif_poste, fp.intitule_poste
                """

                # params CTE (suivant cas)
                params_postes: List[Any] = []
                if not scope.id_service:
                    # postes_scope(id_ent)
                    params_postes.extend([id_ent, id_ent])
                elif scope.id_service == NON_LIE_ID:
                    # postes_scope(id_ent, id_ent) + join organigramme(id_ent)
                    params_postes.extend([id_ent, id_ent, id_ent])
                else:
                    # services_scope(id_ent, id_service, id_ent) + postes_scope(id_ent) + join organigramme(id_ent)
                    params_postes.extend([id_ent, scope.id_service, id_ent, id_ent, id_ent])

                cur.execute(sql_postes, tuple(params_postes))
                postes_rows = cur.fetchall() or []

                postes: List[PosteItem] = [
                    PosteItem(
                        id_poste=r["id_poste"],
                        codif_poste=r.get("codif_poste") or "",
                        intitule_poste=r.get("intitule_poste") or "",
                        id_service=r.get("id_service"),
                        nom_service=r.get("nom_service"),
                        total_competences=0,
                    )
                    for r in postes_rows
                ]

                if not postes:
                    return CartographieMatriceResponse(
                        service=scope,
                        domaines=[],
                        postes=[],
                        matrix=[],
                        totaux_domaines=[],
                        total_postes=0,
                        total_competences=0,
                    )

                # 2) Cellules matrice + domaines (distinct)
                sql_matrix = f"""
                    WITH
                    {cte_sql}
                    SELECT
                        fp.id_poste,
                        c.domaine AS id_domaine_competence,
                        COUNT(DISTINCT c.id_comp)::int AS nb_competences,
                        d.titre,
                        d.titre_court,
                        d.ordre_affichage,
                        d.couleur
                    FROM postes_scope ps
                    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
                    JOIN public.tbl_fiche_poste_competence fpc ON fpc.id_poste = fp.id_poste
                    JOIN public.tbl_competence c
                      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                    LEFT JOIN public.tbl_domaine_competence d
                      ON d.id_domaine_competence = c.domaine
                    {where_sql}
                    GROUP BY
                        fp.id_poste,
                        c.domaine,
                        d.titre,
                        d.titre_court,
                        d.ordre_affichage,
                        d.couleur
                """

                # params CTE + where
                params_matrix: List[Any] = []
                if not scope.id_service:
                    params_matrix.extend([id_ent])
                elif scope.id_service == NON_LIE_ID:
                    params_matrix.extend([id_ent, id_ent])
                else:
                    params_matrix.extend([id_ent, scope.id_service, id_ent, id_ent])

                params_matrix.extend(params_where)

                cur.execute(sql_matrix, tuple(params_matrix))
                rows = cur.fetchall() or []

                domaines_map: Dict[str, DomaineItem] = {}
                matrix: List[MatrixCell] = []
                tot_poste: Dict[str, int] = {}
                tot_dom: Dict[str, int] = {}

                for r in rows:
                    did = r.get("id_domaine_competence")
                    if not did:
                        # compétence sans domaine => on ignore dans la matrice V1 (sinon ça fait une colonne "vide")
                        continue

                    if did not in domaines_map:
                        domaines_map[did] = DomaineItem(
                            id_domaine_competence=did,
                            titre=r.get("titre"),
                            titre_court=r.get("titre_court"),
                            ordre_affichage=r.get("ordre_affichage"),
                            couleur=r.get("couleur"),
                        )

                    nb = int(r.get("nb_competences") or 0)
                    pid = r["id_poste"]

                    matrix.append(
                        MatrixCell(
                            id_poste=pid,
                            id_domaine_competence=did,
                            nb_competences=nb,
                        )
                    )

                    tot_poste[pid] = tot_poste.get(pid, 0) + nb
                    tot_dom[did] = tot_dom.get(did, 0) + nb

                # compléter total par poste
                for p in postes:
                    p.total_competences = int(tot_poste.get(p.id_poste, 0))

                # tri domaines
                domaines = sorted(
                    domaines_map.values(),
                    key=lambda d: (
                        d.ordre_affichage if d.ordre_affichage is not None else 999999,
                        (d.titre_court or d.titre or d.id_domaine_competence).lower(),
                    ),
                )

                totaux_domaines = [
                    DomaineTotal(id_domaine_competence=did, total_competences=int(total))
                    for did, total in tot_dom.items()
                    if did in domaines_map
                ]
                totaux_domaines.sort(key=lambda x: x.total_competences, reverse=True)

                total_competences = sum(tot_poste.values()) if tot_poste else 0

                return CartographieMatriceResponse(
                    service=scope,
                    domaines=domaines,
                    postes=postes,
                    matrix=matrix,
                    totaux_domaines=totaux_domaines,
                    total_postes=len(postes),
                    total_competences=int(total_competences),
                )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
