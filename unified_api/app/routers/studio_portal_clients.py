from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from typing import Optional, Dict, Any
from uuid import uuid4
import re

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner, studio_require_min_role

router = APIRouter()

RE_APE = re.compile(r"^\d{2}\.\d{2}$")


class ClientPayload(BaseModel):
    nom_ent: Optional[str] = None
    adresse_ent: Optional[str] = None
    adresse_cplt_ent: Optional[str] = None
    cp_ent: Optional[str] = None
    ville_ent: Optional[str] = None
    pays_ent: Optional[str] = None
    email_ent: Optional[str] = None
    telephone_ent: Optional[str] = None
    site_web: Optional[str] = None
    siret_ent: Optional[str] = None
    code_ape_ent: Optional[str] = None
    num_tva_ent: Optional[str] = None
    effectif_ent: Optional[str] = None
    id_opco: Optional[str] = None
    date_creation: Optional[str] = None
    num_entreprise: Optional[str] = None
    idcc: Optional[str] = None
    nom_groupe: Optional[str] = None
    type_groupe: Optional[str] = None
    tete_groupe: Optional[bool] = None
    group_ok: Optional[bool] = None


def _build_patch_set(payload) -> Dict[str, Any]:
    fields = payload.__fields_set__ or set()
    data = payload.dict()
    return {k: data.get(k) for k in fields}


def _normalize_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    v = str(value).strip()
    return v or None


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    v = str(value).strip().lower()
    return v in ("1", "true", "vrai", "yes", "oui", "on")


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
        FROM public.tbl_novoskill_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND console_code = 'studio'
          AND COALESCE(archive, FALSE) = FALSE
          AND COALESCE(statut_access, 'actif') <> 'suspendu'
        LIMIT 1
        """,
        (email, oid),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _validate_idcc_exists(cur, idcc: Optional[str]):
    if idcc is None or str(idcc).strip() == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        LIMIT 1
        """,
        (idcc,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="IDCC inconnu (référentiel).")


def _validate_ape_exists(cur, code_ape: Optional[str]):
    if code_ape is None or str(code_ape).strip() == "":
        return
    v = str(code_ape).strip()
    if not RE_APE.match(v):
        raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        LIMIT 1
        """,
        (v,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="Code APE inconnu (référentiel).")


def _validate_opco_exists(cur, id_opco: Optional[str]):
    if id_opco is None or str(id_opco).strip() == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_opco,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="OPCO inconnu ou masqué (référentiel).")


def _fetch_owner_feature_flags(cur, id_owner: str) -> dict:
    cur.execute(
        """
        SELECT
            studio_actif,
            gestion_acces_studio_autorisee,
            nb_acces_studio_max
        FROM public.tbl_novoskill_owner_commercial
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_owner,),
    )
    r = cur.fetchone() or {}
    return {
        "studio_actif": bool(r.get("studio_actif")),
        "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
        "nb_acces_studio_max": int(r.get("nb_acces_studio_max") or 0),
    }


def _lookup_idcc(cur, idcc: Optional[str]) -> Optional[str]:
    if not idcc:
        return None
    cur.execute(
        """
        SELECT libelle
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        LIMIT 1
        """,
        (idcc,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("libelle"))


def _lookup_ape(cur, code_ape: Optional[str]) -> Optional[str]:
    if not code_ape:
        return None
    cur.execute(
        """
        SELECT intitule_ape
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        LIMIT 1
        """,
        (code_ape,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("intitule_ape"))


def _lookup_opco(cur, id_opco: Optional[str]) -> Optional[str]:
    if not id_opco:
        return None
    cur.execute(
        """
        SELECT nom_opco
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_opco,),
    )
    r = cur.fetchone() or {}
    return _normalize_text(r.get("nom_opco"))


def _client_exists_for_owner(cur, id_owner: str, id_ent: str, include_masked: bool = False) -> bool:
    sql = """
        SELECT 1
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
          AND type_entreprise = 'Client'
    """
    params = [id_ent, id_owner]
    if not include_masked:
        sql += " AND COALESCE(masque, FALSE) = FALSE"
    sql += " LIMIT 1"
    cur.execute(sql, tuple(params))
    return cur.fetchone() is not None


def _fetch_clients_summary(cur, id_owner: str) -> dict:
    cur.execute(
        """
        SELECT
            COUNT(*) AS total_clients,
            COUNT(*) FILTER (WHERE COALESCE(group_ok, FALSE) = TRUE) AS nb_groupes,
            COUNT(*) FILTER (WHERE COALESCE(tete_groupe, FALSE) = TRUE) AS nb_tetes_groupe,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner o
                    WHERE o.id_owner = e.id_ent
                      AND COALESCE(o.archive, FALSE) = FALSE
                )
            ) AS nb_owner_scope,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner_commercial oc
                    WHERE oc.id_owner = e.id_ent
                      AND COALESCE(oc.archive, FALSE) = FALSE
                      AND COALESCE(oc.studio_actif, FALSE) = TRUE
                )
            ) AS nb_studio_actif,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM public.tbl_novoskill_owner_commercial oc
                    WHERE oc.id_owner = e.id_ent
                      AND COALESCE(oc.archive, FALSE) = FALSE
                      AND COALESCE(oc.gestion_acces_studio_autorisee, FALSE) = TRUE
                )
            ) AS nb_studio_delegue
        FROM public.tbl_entreprise e
        WHERE e.id_owner_gestionnaire = %s
          AND e.type_entreprise = 'Client'
          AND COALESCE(e.masque, FALSE) = FALSE
        """,
        (id_owner,),
    )
    r = cur.fetchone() or {}
    return {
        "total_clients": int(r.get("total_clients") or 0),
        "nb_groupes": int(r.get("nb_groupes") or 0),
        "nb_tetes_groupe": int(r.get("nb_tetes_groupe") or 0),
        "nb_owner_scope": int(r.get("nb_owner_scope") or 0),
        "nb_studio_actif": int(r.get("nb_studio_actif") or 0),
        "nb_studio_delegue": int(r.get("nb_studio_delegue") or 0),
    }


def _fetch_clients_list(cur, id_owner: str) -> list:
    cur.execute(
        """
        SELECT
            e.id_ent,
            e.nom_ent,
            e.ville_ent,
            e.pays_ent,
            e.email_ent,
            e.telephone_ent,
            e.site_web,
            e.nom_groupe,
            e.type_groupe,
            e.group_ok,
            e.tete_groupe,
            EXISTS (
                SELECT 1
                FROM public.tbl_novoskill_owner o
                WHERE o.id_owner = e.id_ent
                  AND COALESCE(o.archive, FALSE) = FALSE
            ) AS has_owner_scope,
            COALESCE((
                SELECT oc.studio_actif
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS studio_actif,
            COALESCE((
                SELECT oc.gestion_acces_studio_autorisee
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS gestion_acces_studio_autorisee
        FROM public.tbl_entreprise e
        WHERE e.id_owner_gestionnaire = %s
          AND e.type_entreprise = 'Client'
          AND COALESCE(e.masque, FALSE) = FALSE
        ORDER BY lower(e.nom_ent), e.id_ent
        """,
        (id_owner,),
    )
    rows = cur.fetchall() or []
    out = []
    for r in rows:
        out.append(
            {
                "id_ent": r.get("id_ent"),
                "nom_ent": r.get("nom_ent"),
                "ville_ent": r.get("ville_ent"),
                "pays_ent": r.get("pays_ent"),
                "email_ent": r.get("email_ent"),
                "telephone_ent": r.get("telephone_ent"),
                "site_web": r.get("site_web"),
                "nom_groupe": r.get("nom_groupe"),
                "type_groupe": r.get("type_groupe"),
                "group_ok": bool(r.get("group_ok")),
                "tete_groupe": bool(r.get("tete_groupe")),
                "has_owner_scope": bool(r.get("has_owner_scope")),
                "studio_actif": bool(r.get("studio_actif")),
                "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
            }
        )
    return out


def _fetch_client_detail(cur, id_owner: str, id_ent: str) -> dict:
    cur.execute(
        """
        SELECT
            e.id_ent,
            e.nom_ent,
            e.adresse_ent,
            e.adresse_cplt_ent,
            e.cp_ent,
            e.ville_ent,
            e.pays_ent,
            e.email_ent,
            e.telephone_ent,
            e.siret_ent,
            e.code_ape_ent,
            e.num_tva_ent,
            e.effectif_ent,
            e.id_opco,
            e.date_creation,
            e.num_entreprise,
            e.type_entreprise,
            e.site_web,
            e.idcc,
            e.nom_groupe,
            e.type_groupe,
            e.tete_groupe,
            e.group_ok,
            e.id_owner_gestionnaire,
            COALESCE((
                SELECT o.type_owner
                FROM public.tbl_novoskill_owner o
                WHERE o.id_owner = e.id_ent
                  AND COALESCE(o.archive, FALSE) = FALSE
                LIMIT 1
            ), 'entreprise') AS owner_type_client,
            EXISTS (
                SELECT 1
                FROM public.tbl_novoskill_owner o
                WHERE o.id_owner = e.id_ent
                  AND COALESCE(o.archive, FALSE) = FALSE
            ) AS has_owner_scope,
            COALESCE((
                SELECT oc.studio_actif
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS studio_actif,
            COALESCE((
                SELECT oc.gestion_acces_studio_autorisee
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), FALSE) AS gestion_acces_studio_autorisee,
            COALESCE((
                SELECT oc.nb_acces_studio_max
                FROM public.tbl_novoskill_owner_commercial oc
                WHERE oc.id_owner = e.id_ent
                  AND COALESCE(oc.archive, FALSE) = FALSE
                LIMIT 1
            ), 0) AS nb_acces_studio_max,
            COALESCE((
                SELECT COUNT(*)
                FROM public.tbl_entreprise_liaison l
                WHERE l.id_ent_parent = e.id_ent
                  AND COALESCE(l.archive, FALSE) = FALSE
            ), 0) AS nb_entites_enfants,
            COALESCE((
                SELECT COUNT(*)
                FROM public.tbl_entreprise_liaison l
                WHERE l.id_ent_enfant = e.id_ent
                  AND COALESCE(l.archive, FALSE) = FALSE
            ), 0) AS nb_entites_parents
        FROM public.tbl_entreprise e
        WHERE e.id_ent = %s
          AND e.id_owner_gestionnaire = %s
          AND e.type_entreprise = 'Client'
          AND COALESCE(e.masque, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, id_owner),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Client introuvable.")

    return {
        "id_ent": r.get("id_ent"),
        "nom_ent": r.get("nom_ent"),
        "adresse_ent": r.get("adresse_ent"),
        "adresse_cplt_ent": r.get("adresse_cplt_ent"),
        "cp_ent": r.get("cp_ent"),
        "ville_ent": r.get("ville_ent"),
        "pays_ent": r.get("pays_ent"),
        "email_ent": r.get("email_ent"),
        "telephone_ent": r.get("telephone_ent"),
        "siret_ent": r.get("siret_ent"),
        "code_ape_ent": r.get("code_ape_ent"),
        "num_tva_ent": r.get("num_tva_ent"),
        "effectif_ent": r.get("effectif_ent"),
        "id_opco": r.get("id_opco"),
        "date_creation": r.get("date_creation").isoformat() if r.get("date_creation") else None,
        "num_entreprise": r.get("num_entreprise"),
        "type_entreprise": r.get("type_entreprise"),
        "site_web": r.get("site_web"),
        "idcc": r.get("idcc"),
        "idcc_libelle": _lookup_idcc(cur, r.get("idcc")),
        "code_ape_intitule": _lookup_ape(cur, r.get("code_ape_ent")),
        "opco_nom": _lookup_opco(cur, r.get("id_opco")),
        "nom_groupe": r.get("nom_groupe"),
        "type_groupe": r.get("type_groupe"),
        "tete_groupe": bool(r.get("tete_groupe")),
        "group_ok": bool(r.get("group_ok")),
        "id_owner_gestionnaire": r.get("id_owner_gestionnaire"),
        "owner_type_client": (r.get("owner_type_client") or "entreprise"),
        "has_owner_scope": bool(r.get("has_owner_scope")),
        "studio_actif": bool(r.get("studio_actif")),
        "gestion_acces_studio_autorisee": bool(r.get("gestion_acces_studio_autorisee")),
        "nb_acces_studio_max": int(r.get("nb_acces_studio_max") or 0),
        "nb_entites_enfants": int(r.get("nb_entites_enfants") or 0),
        "nb_entites_parents": int(r.get("nb_entites_parents") or 0),
    }


@router.get("/studio/clients/{id_owner}")
def get_studio_clients(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                return {
                    "summary": _fetch_clients_summary(cur, oid),
                    "owner_features": _fetch_owner_feature_flags(cur, oid),
                    "items": _fetch_clients_list(cur, oid),
                }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients error: {e}")


@router.get("/studio/clients/{id_owner}/{id_ent}")
def get_studio_client_detail(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")
                return _fetch_client_detail(cur, oid, id_ent)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/detail error: {e}")


@router.post("/studio/clients/{id_owner}")
def create_studio_client(id_owner: str, payload: ClientPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)
        nom_ent = _normalize_text(patch.get("nom_ent"))
        if not nom_ent:
            raise HTTPException(status_code=400, detail="Le nom de l'entreprise est obligatoire.")

        group_ok = _normalize_bool(patch.get("group_ok"))
        tete_groupe = _normalize_bool(patch.get("tete_groupe")) if group_ok else False

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                _validate_idcc_exists(cur, _normalize_text(patch.get("idcc")))
                _validate_ape_exists(cur, _normalize_text(patch.get("code_ape_ent")))
                _validate_opco_exists(cur, _normalize_text(patch.get("id_opco")))

                new_id = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.tbl_entreprise (
                        id_ent,
                        nom_ent,
                        adresse_ent,
                        adresse_cplt_ent,
                        cp_ent,
                        ville_ent,
                        pays_ent,
                        email_ent,
                        telephone_ent,
                        siret_ent,
                        code_ape_ent,
                        num_tva_ent,
                        effectif_ent,
                        id_opco,
                        date_creation,
                        num_entreprise,
                        type_entreprise,
                        masque,
                        site_web,
                        idcc,
                        nom_groupe,
                        type_groupe,
                        tete_groupe,
                        group_ok,
                        id_owner_gestionnaire
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, 'Client', FALSE, %s, %s,
                        %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        new_id,
                        nom_ent,
                        _normalize_text(patch.get("adresse_ent")),
                        _normalize_text(patch.get("adresse_cplt_ent")),
                        _normalize_text(patch.get("cp_ent")),
                        _normalize_text(patch.get("ville_ent")),
                        _normalize_text(patch.get("pays_ent")),
                        _normalize_text(patch.get("email_ent")),
                        _normalize_text(patch.get("telephone_ent")),
                        _normalize_text(patch.get("siret_ent")),
                        _normalize_text(patch.get("code_ape_ent")),
                        _normalize_text(patch.get("num_tva_ent")),
                        _normalize_text(patch.get("effectif_ent")),
                        _normalize_text(patch.get("id_opco")),
                        patch.get("date_creation"),
                        _normalize_text(patch.get("num_entreprise")),
                        _normalize_text(patch.get("site_web")),
                        _normalize_text(patch.get("idcc")),
                        _normalize_text(patch.get("nom_groupe")) if group_ok else None,
                        _normalize_text(patch.get("type_groupe")) if group_ok else None,
                        tete_groupe,
                        group_ok,
                        oid,
                    ),
                )
                conn.commit()
                return _fetch_client_detail(cur, oid, new_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/create error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}")
def update_studio_client(id_owner: str, id_ent: str, payload: ClientPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)
        if "nom_ent" in patch:
            patch["nom_ent"] = _normalize_text(patch.get("nom_ent"))
            if not patch["nom_ent"]:
                raise HTTPException(status_code=400, detail="Le nom de l'entreprise est obligatoire.")

        if "group_ok" in patch:
            patch["group_ok"] = _normalize_bool(patch.get("group_ok"))

        if "tete_groupe" in patch:
            patch["tete_groupe"] = _normalize_bool(patch.get("tete_groupe"))

        if patch.get("group_ok") is False:
            patch["nom_groupe"] = None
            patch["type_groupe"] = None
            patch["tete_groupe"] = False

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                if not _client_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Client introuvable.")

                _validate_idcc_exists(cur, _normalize_text(patch.get("idcc")))
                _validate_ape_exists(cur, _normalize_text(patch.get("code_ape_ent")))
                _validate_opco_exists(cur, _normalize_text(patch.get("id_opco")))

                allowed = {
                    "nom_ent", "adresse_ent", "adresse_cplt_ent", "cp_ent", "ville_ent", "pays_ent",
                    "email_ent", "telephone_ent", "site_web", "siret_ent", "code_ape_ent", "num_tva_ent",
                    "effectif_ent", "id_opco", "date_creation", "num_entreprise", "idcc",
                    "nom_groupe", "type_groupe", "tete_groupe", "group_ok"
                }
                cols = []
                vals = []

                for k, v in patch.items():
                    if k not in allowed:
                        continue

                    if k in ("group_ok", "tete_groupe"):
                        vv = _normalize_bool(v)
                    elif k == "date_creation":
                        vv = v
                    else:
                        vv = _normalize_text(v)

                    cols.append(f"{k} = %s")
                    vals.append(vv)

                if cols:
                    vals.extend([id_ent, oid])
                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                          AND id_owner_gestionnaire = %s
                          AND type_entreprise = 'Client'
                          AND COALESCE(masque, FALSE) = FALSE
                        """,
                        tuple(vals),
                    )
                    conn.commit()

                return _fetch_client_detail(cur, oid, id_ent)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/update error: {e}")


@router.post("/studio/clients/{id_owner}/{id_ent}/archive")
def archive_studio_client(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "editor")

                if not _client_exists_for_owner(cur, oid, id_ent):
                    raise HTTPException(status_code=404, detail="Client introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_entreprise
                    SET masque = TRUE
                    WHERE id_ent = %s
                      AND id_owner_gestionnaire = %s
                      AND type_entreprise = 'Client'
                      AND COALESCE(masque, FALSE) = FALSE
                    """,
                    (id_ent, oid),
                )
                conn.commit()
                return {"ok": True, "id_ent": id_ent}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/clients/archive error: {e}")