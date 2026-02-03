from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple

from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_context,
    skills_require_user,
    skills_validate_enterprise,
)


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
    codif_client: Optional[str] = None
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
    request: Request,
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
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


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
                        fp.codif_client,
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
                        codif_client=r.get("codif_client"),
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

@router.get("/skills/cartographie/cell/{id_contact}")
def get_cartographie_cell_detail(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
    id_domaine: Optional[str] = Query(default=None),
    id_service: Optional[str] = Query(default=None),  # pour rester cohérent avec le filtre en cours
    etat: Optional[str] = Query(default="active"),
    include_masque: bool = Query(default=False),
):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:

                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)


                # --- scope postes (cohérent avec ton filtre service)
                svc_where = "TRUE"
                svc_params: List[Any] = []

                if id_service:
                    if id_service == "__NON_LIE__":
                        svc_where = "(p.id_service IS NULL OR p.id_service = '')"
                    else:
                        svc_where = "p.id_service = %s"
                        svc_params.append(id_service)

                postes_cte = f"""
                postes_scope AS (
                    SELECT
                        p.id_poste,
                        p.codif_poste,
                        p.codif_client,
                        p.intitule_poste,
                        p.id_service,
                        COALESCE(o.nom_service, '') AS nom_service
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN public.tbl_entreprise_organigramme o
                        ON o.id_ent = p.id_ent
                       AND o.id_service = p.id_service
                    WHERE
                        p.id_ent = %s
                        AND COALESCE(p.actif, TRUE) = TRUE
                        AND {svc_where}
                )
                """

                # --- check poste dans le scope
                cur.execute(
                    f"""
                    WITH {postes_cte}
                    SELECT *
                    FROM postes_scope
                    WHERE id_poste = %s
                    LIMIT 1
                    """,
                    tuple([id_ent] + svc_params + [id_poste])
                )
                poste = cur.fetchone()
                if not poste:
                    raise HTTPException(status_code=404, detail="Poste hors périmètre (service) ou introuvable")

                # --- filtres compétence
                where_parts: List[str] = ["fpc.id_poste = %s"]
                params: List[Any] = [id_poste]

                if id_domaine:
                    where_parts.append("c.domaine = %s")
                    params.append(id_domaine)

                etat_norm = (etat or "").strip().lower()
                if etat_norm:
                    where_parts.append("c.etat = %s")
                    params.append(etat_norm)

                if not include_masque:
                    where_parts.append("COALESCE(c.masque, FALSE) = FALSE")

                where_sql = " AND ".join(where_parts)

                # --- liste des compétences (drilldown)
                sql = f"""
                WITH {postes_cte}
                SELECT
                    c.id_comp,
                    c.code,
                    c.intitule,
                    c.description,
                    c.domaine AS id_domaine_competence,
                    c.etat,
                    c.masque,

                    fpc.niveau_requis,
                    fpc.poids_criticite,
                    fpc.freq_usage,
                    fpc.impact_resultat,
                    fpc.dependance,
                    fpc.date_valorisation,

                    d.titre,
                    d.titre_court,
                    d.couleur
                FROM public.tbl_fiche_poste_competence fpc
                JOIN postes_scope ps
                  ON ps.id_poste = fpc.id_poste
                JOIN public.tbl_competence c
                  ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
                LEFT JOIN public.tbl_domaine_competence d
                  ON d.id_domaine_competence = c.domaine
                WHERE {where_sql}
                ORDER BY
                    COALESCE(d.titre_court, d.titre, ''),
                    c.code
                """

                cur.execute(
                    sql,
                    tuple([id_ent] + svc_params + params)
                )
                rows = cur.fetchall() or []

                # Domaine (si demandé)
                domaine_obj = None
                if id_domaine:
                    for r in rows:
                        if r.get("id_domaine_competence") == id_domaine:
                            domaine_obj = {
                                "id_domaine_competence": r.get("id_domaine_competence"),
                                "titre": r.get("titre"),
                                "titre_court": r.get("titre_court"),
                                "couleur": r.get("couleur"),
                            }
                            break
                    if domaine_obj is None:
                        domaine_obj = {"id_domaine_competence": id_domaine}

                # --- construction competences (modifiable / enrichissable)
                competences = []
                for r in rows:
                    competences.append({
                        "id_comp": r.get("id_comp"),
                        "code": r.get("code"),
                        "intitule": r.get("intitule"),
                        "description": r.get("description"),
                        "id_domaine_competence": r.get("id_domaine_competence"),
                        "etat": r.get("etat"),
                        "masque": r.get("masque"),
                        "niveau_requis": r.get("niveau_requis"),
                        "poids_criticite": r.get("poids_criticite"),
                        "freq_usage": r.get("freq_usage"),
                        "impact_resultat": r.get("impact_resultat"),
                        "dependance": r.get("dependance"),
                        "date_valorisation": r.get("date_valorisation"),
                        "domaine": {
                            "id_domaine_competence": r.get("id_domaine_competence"),
                            "titre": r.get("titre"),
                            "titre_court": r.get("titre_court"),
                            "couleur": r.get("couleur"),
                        },
                        # champs ajoutés (couverture)
                        "nb_porteurs": 0,
                        "porteurs": []
                    })

                # ============================
                # Couverture collaborateurs (porteurs) pour ces compétences
                # ============================
                ids_comp = [c.get("id_comp") for c in competences if c.get("id_comp")]
                if ids_comp:
                    eff_where = "TRUE"
                    eff_params: List[Any] = []

                    if id_service:
                        if id_service == "__NON_LIE__":
                            eff_where = "(e.id_service IS NULL OR e.id_service = '')"
                        else:
                            eff_where = "e.id_service = %s"
                            eff_params.append(id_service)

                    sql_porteurs = f"""
                    WITH comp_scope AS (
                        SELECT UNNEST(%s::text[]) AS id_comp
                    )
                    SELECT
                        cs.id_comp,
                        e.id_effectif,
                        e.prenom_effectif,
                        e.nom_effectif,
                        e.id_service,
                        COALESCE(o.nom_service, '') AS nom_service,
                        e.id_poste_actuel,
                        COALESCE(p.intitule_poste, '') AS intitule_poste,
                        ec.niveau_actuel
                    FROM comp_scope cs
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_comp = cs.id_comp
                    JOIN public.tbl_effectif_client e
                      ON e.id_effectif = ec.id_effectif_client
                    LEFT JOIN public.tbl_entreprise_organigramme o
                      ON o.id_ent = e.id_ent
                     AND o.id_service = e.id_service
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = e.id_poste_actuel
                    WHERE
                        e.id_ent = %s
                        AND COALESCE(e.archive, FALSE) = FALSE
                        AND {eff_where}
                    ORDER BY cs.id_comp, e.nom_effectif, e.prenom_effectif
                    """

                    cur.execute(
                        sql_porteurs,
                        tuple([ids_comp, id_ent] + eff_params)
                    )
                    rows_p = cur.fetchall() or []

                    porteurs_by_comp = {}
                    for rp in rows_p:
                        cid = rp.get("id_comp")
                        if not cid:
                            continue
                        porteurs_by_comp.setdefault(cid, []).append({
                            "id_effectif": rp.get("id_effectif"),
                            "prenom_effectif": rp.get("prenom_effectif"),
                            "nom_effectif": rp.get("nom_effectif"),
                            "id_service": rp.get("id_service"),
                            "nom_service": rp.get("nom_service"),
                            "id_poste_actuel": rp.get("id_poste_actuel"),
                            "intitule_poste": rp.get("intitule_poste"),
                            "niveau_actuel": rp.get("niveau_actuel"),
                        })

                    for comp in competences:
                        cid = comp.get("id_comp")
                        plist = porteurs_by_comp.get(cid, [])
                        comp["porteurs"] = plist
                        comp["nb_porteurs"] = len(plist)

                # réponse clean
                return {
                    "poste": {
                        "id_poste": poste.get("id_poste"),
                        "codif_poste": poste.get("codif_poste"),
                        "codif_client": poste.get("codif_client"),
                        "intitule_poste": poste.get("intitule_poste"),
                        "id_service": poste.get("id_service"),
                        "nom_service": poste.get("nom_service"),
                    },
                    "domaine": domaine_obj,
                    "nb_competences": len(rows),
                    "competences": competences
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur détail cellule cartographie: {str(e)}")
