from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List
from psycopg.rows import dict_row
import uuid

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import (
    studio_require_user,
    studio_fetch_owner,
    studio_require_min_role,
)

router = APIRouter()


# ------------------------------------------------------
# Helpers
# ------------------------------------------------------
def _require_owner_access(cur, u: dict, id_owner: str) -> str:
    oid = (id_owner or "").strip()
    if not oid:
        raise HTTPException(status_code=400, detail="id_owner manquant.")

    if u.get("is_super_admin"):
        return oid

    meta = u.get("user_metadata") or {}
    meta_owner = (meta.get("id_owner") or "").strip()
    if meta_owner:
        if meta_owner != oid:
            raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")
        return oid

    email = (u.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=403, detail="Accès refusé (email manquant).")

    cur.execute(
        """
        SELECT id_owner
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email,),
    )
    r = cur.fetchone() or {}
    db_owner = (r.get("id_owner") or "").strip()
    if not db_owner or db_owner != oid:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _service_exists_active(cur, id_ent: str, id_service: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_service),
    )
    return cur.fetchone() is not None

def _norm_service_id(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip()
    if not s or s in ("__all__", "__none__"):
        return None
    return s


def _next_pt_code(cur, oid: str, id_ent: str) -> str:
    # Sérialise les créations pour une entreprise (évite doublons)
    lock_key = f"poste_code:{oid}:{id_ent}"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))

    cur.execute(
        """
        SELECT COALESCE(
          MAX( (regexp_match(p.codif_poste, '^PT([0-9]{4})$'))[1]::int ),
          0
        ) AS max_n
        FROM public.tbl_fiche_poste p
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND p.codif_poste ~ '^PT[0-9]{4}$'
        """,
        (oid, id_ent),
    )
    r = cur.fetchone() or {}
    max_n_raw = r.get("max_n")
    max_n = int(max_n_raw) if max_n_raw is not None else 0
    nxt = max_n + 1
    if nxt > 9999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (PT9999) pour cette entreprise.")
    return f"PT{nxt:04d}"


def _poste_exists(cur, oid: str, id_ent: str, id_poste: str) -> bool:
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
          AND id_ent = %s
        LIMIT 1
        """,
        (id_poste, oid, id_ent),
    )
    return cur.fetchone() is not None


def _poste_code_exists(cur, oid: str, id_ent: str, codif_poste: str, exclude_poste: Optional[str] = None) -> bool:
    code = (codif_poste or "").strip()
    if not code:
        return False

    if exclude_poste:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
              AND id_poste <> %s
            LIMIT 1
            """,
            (oid, id_ent, code, exclude_poste),
        )
    else:
        cur.execute(
            """
            SELECT 1
            FROM public.tbl_fiche_poste
            WHERE id_owner = %s
              AND id_ent = %s
              AND lower(codif_poste) = lower(%s)
            LIMIT 1
            """,
            (oid, id_ent, code),
        )
    return cur.fetchone() is not None

# ------------------------------------------------------
# Models
# ------------------------------------------------------
class CreateServicePayload(BaseModel):
    nom_service: str
    id_service_parent: Optional[str] = None


class UpdateServicePayload(BaseModel):
    nom_service: Optional[str] = None
    id_service_parent: Optional[str] = None


class AssignPostePayload(BaseModel):
    id_poste: str
    id_service: str


class DetachPostePayload(BaseModel):
    id_poste: str

class CreatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: str
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None


class UpdatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None
    mission_principale: Optional[str] = None
    responsabilites: Optional[str] = None


class ArchivePosteOrgPayload(BaseModel):
    # archive=True => actif FALSE ; archive=False => actif TRUE (restauration)
    archive: bool = True


class DuplicatePosteOrgPayload(BaseModel):
    id_service: Optional[str] = None

# ------------------------------------------------------
# Endpoints: Services
# ------------------------------------------------------
@router.get("/studio/org/services/{id_owner}")
def studio_org_list_services(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)

                # owner Studio doit exister (périmètre)
                studio_fetch_owner(cur, oid)

                # Services (arbre)
                cur.execute(
                    """
                    WITH RECURSIVE svc AS (
                      SELECT
                        s.id_service, s.id_ent, s.nom_service, s.id_service_parent, COALESCE(s.archive,FALSE) AS archive,
                        0 AS depth,
                        (s.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme s
                      WHERE s.id_ent = %s
                        AND COALESCE(s.archive,FALSE) = FALSE
                        AND s.id_service_parent IS NULL

                      UNION ALL

                      SELECT
                        c.id_service, c.id_ent, c.nom_service, c.id_service_parent, COALESCE(c.archive,FALSE) AS archive,
                        p.depth + 1 AS depth,
                        (p.path || ' > ' || c.nom_service)::text AS path
                      FROM public.tbl_entreprise_organigramme c
                      JOIN svc p ON p.id_service = c.id_service_parent
                      WHERE c.id_ent = %s
                        AND COALESCE(c.archive,FALSE) = FALSE
                    )
                    SELECT
                      svc.id_service,
                      svc.nom_service,
                      svc.id_service_parent,
                      svc.depth,

                      -- nb postes actifs dans le service
                      (SELECT COUNT(1)
                       FROM public.tbl_fiche_poste p
                       WHERE p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                         AND p.id_service = svc.id_service
                      ) AS nb_postes,

                      -- nb collaborateurs actifs dans le service
                      (SELECT COUNT(1)
                       FROM public.tbl_effectif_client e
                       WHERE e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         AND e.id_service = svc.id_service
                      ) AS nb_collabs

                    FROM svc
                    ORDER BY svc.path
                    """,
                    (oid, oid, oid, oid),
                )
                rows = cur.fetchall() or []

                services = []
                for r in rows:
                    services.append(
                        {
                            "id_service": r.get("id_service"),
                            "nom_service": r.get("nom_service"),
                            "id_service_parent": r.get("id_service_parent"),
                            "depth": int(r.get("depth") or 0),
                            "nb_postes": int(r.get("nb_postes") or 0),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                        }
                    )

                # Totaux (Tous les services)
                cur.execute(
                    """
                    SELECT
                        (SELECT COUNT(1)
                        FROM public.tbl_fiche_poste p
                        WHERE p.id_ent = %s
                            AND COALESCE(p.actif, TRUE) = TRUE
                            AND p.id_service IS NOT NULL
                        ) AS nb_postes,
                        (SELECT COUNT(1)
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                            AND COALESCE(e.archive, FALSE) = FALSE
                            AND COALESCE(e.statut_actif, TRUE) = TRUE
                            AND e.id_service IS NOT NULL
                        ) AS nb_collabs
                    """,
                    (oid, oid),
                )
                tot = cur.fetchone() or {}

                # Totaux (Non lié)
                cur.execute(
                    """
                    SELECT
                      (SELECT COUNT(1)
                       FROM public.tbl_fiche_poste p
                       WHERE p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                         AND p.id_service IS NULL
                      ) AS nb_postes,
                      (SELECT COUNT(1)
                       FROM public.tbl_effectif_client e
                       WHERE e.id_ent = %s
                         AND COALESCE(e.archive, FALSE) = FALSE
                         AND COALESCE(e.statut_actif, TRUE) = TRUE
                         AND e.id_service IS NULL
                      ) AS nb_collabs
                    """,
                    (oid, oid),
                )
                none = cur.fetchone() or {}

        return {
            "totaux": {"nb_postes": int(tot.get("nb_postes") or 0), "nb_collabs": int(tot.get("nb_collabs") or 0)},
            "non_lie": {"nb_postes": int(none.get("nb_postes") or 0), "nb_collabs": int(none.get("nb_collabs") or 0)},
            "services": services,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services error: {e}")


@router.post("/studio/org/services/{id_owner}")
def studio_org_create_service(id_owner: str, payload: CreateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        nom = (payload.nom_service or "").strip()
        if not nom:
            raise HTTPException(status_code=400, detail="Nom de service obligatoire.")

        parent = (payload.id_service_parent or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if parent and not _service_exists_active(cur, oid, parent):
                    raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                sid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise_organigramme
                      (id_service, id_ent, nom_service, id_service_parent, archive, date_creation)
                    VALUES
                      (%s, %s, %s, %s, FALSE, CURRENT_DATE)
                    """,
                    (sid, oid, nom, parent),
                )
                conn.commit()

        return {"id_service": sid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services create error: {e}")


@router.post("/studio/org/services/{id_owner}/{id_service}")
def studio_org_update_service(id_owner: str, id_service: str, payload: UpdateServicePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou archivé.")

                cols = []
                vals = []

                if "nom_service" in patch_fields:
                    nom = (payload.nom_service or "").strip()
                    if not nom:
                        raise HTTPException(status_code=400, detail="Nom de service obligatoire.")
                    cols.append("nom_service = %s")
                    vals.append(nom)

                if "id_service_parent" in patch_fields:
                    parent = (payload.id_service_parent or "").strip() or None
                    if parent == sid:
                        raise HTTPException(status_code=400, detail="Un service ne peut pas être son propre parent.")
                    if parent and not _service_exists_active(cur, oid, parent):
                        raise HTTPException(status_code=400, detail="Service parent introuvable ou archivé.")

                    # anti-cycle simple : si le parent est un descendant du service
                    if parent:
                        cur.execute(
                            """
                            WITH RECURSIVE up AS (
                              SELECT id_service, id_service_parent
                              FROM public.tbl_entreprise_organigramme
                              WHERE id_ent = %s AND id_service = %s

                              UNION ALL
                              SELECT e.id_service, e.id_service_parent
                              FROM public.tbl_entreprise_organigramme e
                              JOIN up u ON u.id_service_parent = e.id_service
                              WHERE e.id_ent = %s
                            )
                            SELECT 1
                            FROM up
                            WHERE id_service = %s
                            LIMIT 1
                            """,
                            (oid, parent, oid, sid),
                        )
                        if cur.fetchone():
                            raise HTTPException(status_code=400, detail="Cycle détecté dans l’organigramme.")

                    cols.append("id_service_parent = %s")
                    vals.append(parent)

                if cols:
                    vals.extend([oid, sid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise_organigramme
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                          AND id_service = %s
                          AND COALESCE(archive, FALSE) = FALSE
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services update error: {e}")


@router.post("/studio/org/services/{id_owner}/{id_service}/archive")
def studio_org_archive_service(id_owner: str, id_service: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        sid = (id_service or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="id_service manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=404, detail="Service introuvable ou déjà archivé.")

                # Archiver service
                cur.execute(
                    """
                    UPDATE public.tbl_entreprise_organigramme
                    SET archive = TRUE
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid, sid),
                )

                # Détacher les postes rattachés (=> "Non lié")
                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (oid, sid),
                )

                # Détacher les collaborateurs rattachés (=> "Non lié")
                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client
                    SET id_service = NULL, dernier_update = NOW()
                    WHERE id_ent = %s
                      AND id_service = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid, sid),
                )

                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/services archive error: {e}")


# ------------------------------------------------------
# Endpoints: Postes (liste + catalogue + affectation)
# ------------------------------------------------------
@router.get("/studio/org/postes/{id_owner}")
def studio_org_list_postes(
    id_owner: str,
    request: Request,
    service: str = "__all__",
    q: str = "",
    include_archived: int = 0,
):
    """
    service:
      - "__all__" : tous les postes
      - "__none__": postes non liés (id_service IS NULL)
      - "<uuid>"  : postes rattachés au service
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        svc = (service or "__all__").strip()
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                inc_arch = int(include_archived or 0) == 1

                where = ["p.id_owner = %s", "p.id_ent = %s"]
                params = [oid, oid]

                if not inc_arch:
                    where.append("COALESCE(p.actif, TRUE) = TRUE")

                if svc == "__none__":
                    where.append("p.id_service IS NULL")
                elif svc == "__all__":
                    # "Tous les services" = uniquement les postes rattachés à un service
                    where.append("p.id_service IS NOT NULL")
                else:
                    where.append("p.id_service = %s")
                    params.append(svc)

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT
                    p.id_poste,
                    p.codif_poste,
                    p.codif_client,
                    p.intitule_poste,
                    p.id_service,
                    COALESCE(p.actif, TRUE) AS actif,
                    COALESCE(cnt.nb_collabs, 0) AS nb_collabs
                    FROM public.tbl_fiche_poste p
                    LEFT JOIN (
                    SELECT e.id_poste_actuel AS id_poste, COUNT(1) AS nb_collabs
                    FROM public.tbl_effectif_client e
                    WHERE e.id_ent = %s
                        AND COALESCE(e.archive, FALSE) = FALSE
                        AND COALESCE(e.statut_actif, TRUE) = TRUE
                        AND e.id_poste_actuel IS NOT NULL
                    GROUP BY e.id_poste_actuel
                    ) cnt ON cnt.id_poste = p.id_poste
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    """,
                    tuple([oid] + params),
                )
                rows = cur.fetchall() or []

                postes = []
                for r in rows:
                    code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
                    postes.append(
                        {
                            "id_poste": r.get("id_poste"),
                            "code": code,
                            "intitule": r.get("intitule_poste"),
                            "id_service": r.get("id_service"),
                            "nb_collabs": int(r.get("nb_collabs") or 0),
                            "actif": bool(r.get("actif")),
                        }
                    )

        return {"postes": postes}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes error: {e}")

@router.get("/studio/org/poste_detail/{id_owner}/{id_poste}")
def studio_org_poste_detail(id_owner: str, id_poste: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      p.id_poste,
                      p.id_service,
                      COALESCE(p.actif, TRUE) AS actif,
                      p.codif_poste,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites,
                      p.date_maj
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_owner = %s
                      AND p.id_ent = %s
                      AND p.id_poste = %s
                    LIMIT 1
                    """,
                    (oid, oid, pid),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

        return {
            "id_poste": r.get("id_poste"),
            "id_service": r.get("id_service"),
            "actif": bool(r.get("actif")),
            "codif_poste": r.get("codif_poste"),
            "codif_client": r.get("codif_client"),
            "intitule_poste": r.get("intitule_poste"),
            "mission_principale": r.get("mission_principale"),
            "responsabilites": r.get("responsabilites"),
            "date_maj": r.get("date_maj"),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/poste_detail error: {e}")


@router.post("/studio/org/postes/{id_owner}")
def studio_org_create_poste(id_owner: str, payload: CreatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        title = (payload.intitule_poste or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        sid = _norm_service_id(payload.id_service)
        if not sid:
            raise HTTPException(status_code=400, detail="Service obligatoire.")

        codif = (payload.codif_poste or "").strip() or None
        cod_cli = (payload.codif_client or "").strip() or None
        mission = (payload.mission_principale or "").strip() or None
        resp = (payload.responsabilites or "").strip() or None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                # Code interne: si non fourni => auto PTxxxx
                if not codif:
                    codif = _next_pt_code(cur, oid, oid)
                else:
                    if _poste_code_exists(cur, oid, oid, codif):
                        raise HTTPException(status_code=400, detail="Code interne déjà utilisé.")

                pid = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service, codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites, actif, date_maj)
                    VALUES
                      (%s, %s, %s, %s, %s, %s, %s,
                       %s, %s, TRUE, NOW())
                    """,
                    (pid, oid, oid, sid, codif, cod_cli, title, mission, resp),
                )
                conn.commit()

        return {"id_poste": pid, "codif_poste": codif}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes create error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}")
def studio_org_update_poste(id_owner: str, id_poste: str, payload: UpdatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _poste_exists(cur, oid, oid, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cols = []
                vals = []

                if "id_service" in patch_fields:
                    sid = _norm_service_id(payload.id_service)
                    if not sid:
                        raise HTTPException(status_code=400, detail="Service obligatoire.")
                    if not _service_exists_active(cur, oid, sid):
                        raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")
                    cols.append("id_service = %s")
                    vals.append(sid)

                if "codif_poste" in patch_fields:
                    cod = (payload.codif_poste or "").strip()
                    if not cod:
                        raise HTTPException(status_code=400, detail="Code interne obligatoire.")
                    if _poste_code_exists(cur, oid, oid, cod, exclude_poste=pid):
                        raise HTTPException(status_code=400, detail="Code interne déjà utilisé.")
                    cols.append("codif_poste = %s")
                    vals.append(cod)

                if "codif_client" in patch_fields:
                    codc = (payload.codif_client or "").strip() or None
                    cols.append("codif_client = %s")
                    vals.append(codc)

                if "intitule_poste" in patch_fields:
                    title = (payload.intitule_poste or "").strip()
                    if not title:
                        raise HTTPException(status_code=400, detail="Intitulé obligatoire.")
                    cols.append("intitule_poste = %s")
                    vals.append(title)

                if "mission_principale" in patch_fields:
                    mission = (payload.mission_principale or "").strip() or None
                    cols.append("mission_principale = %s")
                    vals.append(mission)

                if "responsabilites" in patch_fields:
                    resp = (payload.responsabilites or "").strip() or None
                    cols.append("responsabilites = %s")
                    vals.append(resp)

                if cols:
                    cols.append("date_maj = NOW()")
                    vals.extend([pid, oid, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_fiche_poste
                        SET {", ".join(cols)}
                        WHERE id_poste = %s
                          AND id_owner = %s
                          AND id_ent = %s
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes update error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/archive")
def studio_org_archive_poste(id_owner: str, id_poste: str, payload: ArchivePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        set_actif = not bool(payload.archive)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                if not _poste_exists(cur, oid, oid, pid):
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET actif = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND id_ent = %s
                    """,
                    (set_actif, pid, oid, oid),
                )
                conn.commit()

        return {"ok": True, "actif": bool(set_actif)}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes archive error: {e}")


@router.post("/studio/org/postes/{id_owner}/{id_poste}/duplicate")
def studio_org_duplicate_poste(id_owner: str, id_poste: str, payload: DuplicatePosteOrgPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        target_sid = _norm_service_id(payload.id_service) if payload else None

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    SELECT
                      p.id_service,
                      p.codif_client,
                      p.intitule_poste,
                      p.mission_principale,
                      p.responsabilites
                    FROM public.tbl_fiche_poste p
                    WHERE p.id_poste = %s
                      AND p.id_owner = %s
                      AND p.id_ent = %s
                    LIMIT 1
                    """,
                    (pid, oid, oid),
                )
                src = cur.fetchone()
                if not src:
                    raise HTTPException(status_code=404, detail="Poste introuvable.")

                sid = target_sid or (src.get("id_service") or "").strip()
                if not sid:
                    raise HTTPException(status_code=400, detail="Service obligatoire.")
                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                new_id = str(uuid.uuid4())
                new_code = _next_pt_code(cur, oid, oid)

                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service, codif_poste, codif_client, intitule_poste,
                       mission_principale, responsabilites, actif, date_maj)
                    VALUES
                      (%s, %s, %s, %s, %s, %s, %s,
                       %s, %s, TRUE, NOW())
                    """,
                    (
                        new_id,
                        oid,
                        oid,
                        sid,
                        new_code,
                        src.get("codif_client"),
                        src.get("intitule_poste"),
                        src.get("mission_principale"),
                        src.get("responsabilites"),
                    ),
                )
                conn.commit()

        return {"id_poste": new_id, "codif_poste": new_code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes duplicate error: {e}")

@router.get("/studio/org/postes_catalogue/{id_owner}")
def studio_org_list_postes_catalogue(id_owner: str, request: Request, q: str = ""):
    """
    Catalogue V1 = postes existants non liés (id_service IS NULL).
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                where = ["p.id_ent = %s", "COALESCE(p.actif, TRUE) = TRUE", "p.id_service IS NULL"]
                params = [oid]

                if qq:
                    where.append(
                        "(p.codif_poste ILIKE %s OR COALESCE(p.codif_client,'') ILIKE %s OR p.intitule_poste ILIKE %s)"
                    )
                    like = f"%{qq}%"
                    params.extend([like, like, like])

                cur.execute(
                    f"""
                    SELECT p.id_poste, p.codif_poste, p.codif_client, p.intitule_poste
                    FROM public.tbl_fiche_poste p
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    LIMIT 200
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
            items.append({"id_poste": r.get("id_poste"), "code": code, "intitule": r.get("intitule_poste")})
        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes_catalogue error: {e}")


@router.post("/studio/org/postes/assign/{id_owner}")
def studio_org_assign_poste(id_owner: str, payload: AssignPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        sid = (payload.id_service or "").strip()
        if not pid or not sid:
            raise HTTPException(status_code=400, detail="id_poste et id_service obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only (page organisation admin-only)
                studio_require_min_role(cur, u, oid, "admin")

                if not _service_exists_active(cur, oid, sid):
                    raise HTTPException(status_code=400, detail="Service introuvable ou archivé.")

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    LIMIT 1
                    """,
                    (pid, oid),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Poste introuvable ou inactif.")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = %s, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (sid, pid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/assign error: {e}")


@router.post("/studio/org/postes/detach/{id_owner}")
def studio_org_detach_poste(id_owner: str, payload: DetachPostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        pid = (payload.id_poste or "").strip()
        if not pid:
            raise HTTPException(status_code=400, detail="id_poste obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # admin only
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET id_service = NULL, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_ent = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (pid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/org/postes/detach error: {e}"
)