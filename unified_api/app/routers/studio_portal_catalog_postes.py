from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
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
        SELECT 1
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email, oid),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _safe_show(v: str) -> str:
    s = (v or "active").strip().lower()
    if s not in ("active", "archived", "all"):
        s = "active"
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
    max_n = int(r.get("max_n") or -1)
    nxt = max_n + 1
    if nxt > 9999:
        raise HTTPException(status_code=400, detail="Limite de numérotation atteinte (PT9999) pour cette entreprise.")
    return f"PT{nxt:04d}"

# ------------------------------------------------------
# Models
# ------------------------------------------------------
class CreatePostePayload(BaseModel):
    # Code interne auto (PT000..PT999) => non saisi
    codif_client: Optional[str] = None
    intitule_poste: str

class UpdatePostePayload(BaseModel):
    codif_poste: Optional[str] = None
    codif_client: Optional[str] = None
    intitule_poste: Optional[str] = None


# ------------------------------------------------------
# Endpoints
# ------------------------------------------------------
@router.get("/studio/catalog/postes/{id_owner}")
def studio_catalog_list_postes(
    id_owner: str,
    request: Request,
    q: str = "",
    show: str = "active",
    mine: int = 1,
    clients: int = 0,
):
    """
    Liste catalogue fiches de poste (Studio):
    - sécurité: filtre id_owner
    - filtres: mine/clients => basé sur id_ent == id_owner (mon entreprise) vs != (clients)
    - show: active | archived | all (actif)
    """
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()
        sh = _safe_show(show)
        mine_ok = int(mine or 0) == 1
        clients_ok = int(clients or 0) == 1

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                # editor+ (le menu est editor, on aligne l'API)
                studio_require_min_role(cur, u, oid, "editor")

                where = ["p.id_owner = %s"]
                params = [oid]

                if sh == "active":
                    where.append("COALESCE(p.actif, TRUE) = TRUE")
                elif sh == "archived":
                    where.append("COALESCE(p.actif, TRUE) = FALSE")

                # périmètre (mine/clients)
                # - mine only  => id_ent = oid
                # - clients only => id_ent <> oid
                # - both => pas de filtre
                if mine_ok and not clients_ok:
                    where.append("p.id_ent = %s")
                    params.append(oid)
                elif clients_ok and not mine_ok:
                    where.append("p.id_ent IS NOT NULL AND p.id_ent <> %s")
                    params.append(oid)

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
                      p.id_ent,
                      p.id_service,
                      COALESCE(p.actif, TRUE) AS actif,
                      p.codif_poste,
                      p.codif_client,
                      p.intitule_poste
                    FROM public.tbl_fiche_poste p
                    WHERE {" AND ".join(where)}
                    ORDER BY COALESCE(p.codif_client, p.codif_poste), p.intitule_poste
                    LIMIT 400
                    """,
                    tuple(params),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            code = (r.get("codif_client") or "").strip() or (r.get("codif_poste") or "").strip()
            ent = (r.get("id_ent") or "").strip()
            items.append(
                {
                    "id_poste": r.get("id_poste"),
                    "code": code,
                    "codif_poste": r.get("codif_poste"),
                    "codif_client": r.get("codif_client"),
                    "intitule": r.get("intitule_poste"),
                    "id_ent": r.get("id_ent"),
                    "is_mine": ent == (id_owner or "").strip(),
                    "id_service": r.get("id_service"),
                    "actif": bool(r.get("actif")),
                }
            )

        return {"items": items}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/postes list error: {e}")


@router.get("/studio/catalog/postes/{id_owner}/next_code")
def studio_catalog_next_code(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                # V1: création “Mon entreprise” uniquement => id_ent = oid
                code = _next_pt_code(cur, oid, oid)
        return {"codif_poste": code}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/postes next_code error: {e}")
    
@router.post("/studio/catalog/postes/{id_owner}")
def studio_catalog_create_poste(id_owner: str, payload: CreatePostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:        
        title = (payload.intitule_poste or "").strip()
        cod_cli = (payload.codif_client or "").strip() or None

        
        if not title:
            raise HTTPException(status_code=400, detail="Intitulé obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                pid = str(uuid.uuid4())

                # V1: code interne auto PT000..PT999 (par entreprise = id_ent)
                cod = _next_pt_code(cur, oid, oid)

                # V1: création dans "Mon entreprise" (id_ent = id_owner), non lié (id_service NULL)
                cur.execute(
                    """
                    INSERT INTO public.tbl_fiche_poste
                      (id_poste, id_owner, id_ent, id_service, codif_poste, codif_client, intitule_poste, actif)
                    VALUES
                      (%s, %s, %s, NULL, %s, %s, %s, TRUE)
                    """,
                    (pid, oid, oid, cod, cod_cli, title),
                )
                conn.commit()

        return {"id_poste": pid, "codif_poste": cod}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/postes create error: {e}")


@router.post("/studio/catalog/postes/{id_owner}/{id_poste}")
def studio_catalog_update_poste(id_owner: str, id_poste: str, payload: UpdatePostePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        oid_poste = (id_poste or "").strip()
        if not oid_poste:
            raise HTTPException(status_code=400, detail="id_poste manquant.")

        patch_fields = payload.__fields_set__ or set()
        if not patch_fields:
            return {"ok": True}

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                # check existence + owner perimeter
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_fiche_poste
                    WHERE id_poste = %s
                      AND id_owner = %s
                    LIMIT 1
                    """,
                    (oid_poste, oid),
                )
                if cur.fetchone() is None:
                    raise HTTPException(status_code=404, detail="Fiche de poste introuvable (owner).")

                cols = []
                vals = []

                if "codif_poste" in patch_fields:
                    raise HTTPException(status_code=400, detail="Le code interne est automatique et non modifiable.")

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

                if cols:
                    cols.append("date_maj = NOW()")
                    vals.extend([oid_poste, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_fiche_poste
                        SET {", ".join(cols)}
                        WHERE id_poste = %s
                          AND id_owner = %s
                        """,
                        tuple(vals),
                    )
                    conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/postes update error: {e}")


@router.post("/studio/catalog/postes/{id_owner}/{id_poste}/archive")
def studio_catalog_archive_poste(id_owner: str, id_poste: str, request: Request):
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
                studio_require_min_role(cur, u, oid, "editor")

                cur.execute(
                    """
                    UPDATE public.tbl_fiche_poste
                    SET actif = FALSE, date_maj = NOW()
                    WHERE id_poste = %s
                      AND id_owner = %s
                      AND COALESCE(actif, TRUE) = TRUE
                    """,
                    (pid, oid),
                )
                conn.commit()

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/catalog/postes archive error: {e}")