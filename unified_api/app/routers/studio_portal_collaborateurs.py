from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from psycopg.rows import dict_row
import uuid
from datetime import date as py_date

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


def _resolve_owner_source(cur, oid: str) -> dict:
    cur.execute(
        """
        SELECT id_mon_ent, nom_ent
        FROM public.tbl_mon_entreprise
        WHERE id_mon_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_mon_ent"):
        return {
            "source_kind": "mon_entreprise",
            "source_label": "Mon entreprise",
            "source_name": (r.get("nom_ent") or "").strip(),
        }

    cur.execute(
        """
        SELECT id_ent, nom_ent
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    r = cur.fetchone() or {}
    if r.get("id_ent"):
        return {
            "source_kind": "entreprise",
            "source_label": "Client",
            "source_name": (r.get("nom_ent") or "").strip(),
        }

    raise HTTPException(status_code=404, detail="Owner non rattaché à une entreprise exploitable.")


def _norm_text(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip()
    return s or None


def _norm_bool(v, default: bool = False) -> bool:
    if v is None:
        return bool(default)
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "vrai", "yes", "oui", "on"):
        return True
    if s in ("0", "false", "faux", "no", "non", "off"):
        return False
    return bool(default)


def _norm_iso_date(v: Optional[str]) -> Optional[py_date]:
    s = (v or "").strip()
    if not s:
        return None
    try:
        return py_date.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Date invalide (format attendu YYYY-MM-DD).")


def _service_exists_active(cur, id_ent: str, id_service: Optional[str]) -> bool:
    sid = (id_service or "").strip()
    if not sid:
        return False
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise_organigramme
        WHERE id_ent = %s
          AND id_service = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_ent, sid),
    )
    return cur.fetchone() is not None


def _fetch_poste_service(cur, oid: str, id_poste: Optional[str]) -> Optional[str]:
    pid = (id_poste or "").strip()
    if not pid:
        return None

    cur.execute(
        """
        SELECT id_service
        FROM public.tbl_fiche_poste
        WHERE id_poste = %s
          AND id_owner = %s
          AND id_ent = %s
          AND COALESCE(actif, TRUE) = TRUE
        LIMIT 1
        """,
        (pid, oid, oid),
    )
    r = cur.fetchone() or {}
    if not r:
        raise HTTPException(status_code=400, detail="Poste actuel invalide pour cet owner.")
    return (r.get("id_service") or "").strip() or None


def _norm_service_from_payload(cur, oid: str, id_service: Optional[str], id_poste: Optional[str]) -> Optional[str]:
    pid = (id_poste or "").strip()
    if pid:
        return _fetch_poste_service(cur, oid, pid)

    sid = (id_service or "").strip()
    if not sid:
        return None

    if not _service_exists_active(cur, oid, sid):
        raise HTTPException(status_code=400, detail="Service invalide pour cet owner.")
    return sid


def _build_service_options(cur, oid: str, source_kind: str) -> list:
    if source_kind != "entreprise":
        return []

    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT
            s.id_service,
            s.nom_service,
            s.id_service_parent,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND s.id_service_parent IS NULL

          UNION ALL

          SELECT
            c.id_service,
            c.nom_service,
            c.id_service_parent,
            p.depth + 1 AS depth,
            (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p ON p.id_service = c.id_service_parent
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        )
        SELECT
          svc.id_service,
          svc.nom_service,
          svc.id_service_parent,
          svc.depth,
          (
            SELECT COUNT(1)
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND svc.id_service = e.id_service
          ) AS nb_collabs
        FROM svc
        ORDER BY svc.path
        """,
        (oid, oid, oid),
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        depth = int(r.get("depth") or 0)
        nom = (r.get("nom_service") or "").strip()
        items.append(
            {
                "id_service": r.get("id_service"),
                "nom_service": nom,
                "depth": depth,
                "label": f"{'— ' * depth}{nom}",
                "nb_collabs": int(r.get("nb_collabs") or 0),
            }
        )
    return items


def _build_poste_options(cur, oid: str, source_kind: str) -> list:
    if source_kind != "entreprise":
        return []

    cur.execute(
        """
        SELECT
          p.id_poste,
          p.id_service,
          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
          p.intitule_poste,
          COALESCE(s.nom_service, '') AS nom_service,
          (
            SELECT COUNT(1)
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND e.id_poste_actuel = p.id_poste
          ) AS nb_collabs
        FROM public.tbl_fiche_poste p
        LEFT JOIN public.tbl_entreprise_organigramme s
          ON s.id_service = p.id_service
         AND s.id_ent = %s
         AND COALESCE(s.archive, FALSE) = FALSE
        WHERE p.id_owner = %s
          AND p.id_ent = %s
          AND COALESCE(p.actif, TRUE) = TRUE
        ORDER BY COALESCE(p.codif_client, p.codif_poste, ''), p.intitule_poste
        """,
        (oid, oid, oid, oid),
    )
    rows = cur.fetchall() or []
    items = []
    for r in rows:
        code = (r.get("code_poste") or "").strip()
        intitule = (r.get("intitule_poste") or "").strip()
        label = (f"{code} · {intitule}" if code else intitule).strip()
        items.append(
            {
                "id_poste": r.get("id_poste"),
                "id_service": r.get("id_service"),
                "code_poste": code,
                "intitule_poste": intitule,
                "nom_service": (r.get("nom_service") or "").strip(),
                "label": label,
                "nb_collabs": int(r.get("nb_collabs") or 0),
            }
        )
    return items


class CollaborateurPayload(BaseModel):
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: Optional[str] = None
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone2: Optional[str] = None
    adresse: Optional[str] = None
    code_postal: Optional[str] = None
    ville: Optional[str] = None
    pays: Optional[str] = None
    actif: Optional[bool] = None
    fonction: Optional[str] = None
    observations: Optional[str] = None

    id_service: Optional[str] = None
    id_poste_actuel: Optional[str] = None
    type_contrat: Optional[str] = None
    matricule_interne: Optional[str] = None
    business_travel: Optional[str] = None
    date_naissance: Optional[str] = None
    date_entree_entreprise: Optional[str] = None
    date_debut_poste_actuel: Optional[str] = None
    date_sortie_prevue: Optional[str] = None
    niveau_education: Optional[str] = None
    domaine_education: Optional[str] = None
    motif_sortie: Optional[str] = None
    note_commentaire: Optional[str] = None
    havedatefin: Optional[bool] = None
    ismanager: Optional[bool] = None
    isformateur: Optional[bool] = None
    is_temp: Optional[bool] = None
    role_temp: Optional[str] = None
    code_effectif: Optional[str] = None


# ------------------------------------------------------
# Context
# ------------------------------------------------------
@router.get("/studio/collaborateurs/context/{id_owner}")
def studio_collab_context(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                owner = studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                src = _resolve_owner_source(cur, oid)
                services = _build_service_options(cur, oid, src["source_kind"])
                postes = _build_poste_options(cur, oid, src["source_kind"])

        return {
            "id_owner": oid,
            "nom_owner": owner.get("nom_owner"),
            "source_kind": src["source_kind"],
            "source_label": src["source_label"],
            "source_name": src["source_name"],
            "services": services,
            "postes": postes,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/context error: {e}")


# ------------------------------------------------------
# Liste
# ------------------------------------------------------
@router.get("/studio/collaborateurs/list/{id_owner}")
def studio_collab_list(
    id_owner: str,
    request: Request,
    q: str = "",
    service: str = "__all__",
    poste: str = "__all__",
    active: str = "all",
    include_archived: int = 0,
):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        qq = (q or "").strip()
        svc = (service or "__all__").strip()
        pst = (poste or "__all__").strip()
        act = (active or "all").strip().lower()
        inc_arch = int(include_archived or 0) == 1

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                items = []

                if src["source_kind"] == "entreprise":
                    where = ["e.id_ent = %s"]
                    params = [oid]

                    if not inc_arch:
                        where.append("COALESCE(e.archive, FALSE) = FALSE")

                    if svc not in ("", "__all__"):
                        if svc == "__none__":
                            where.append("e.id_service IS NULL")
                        else:
                            where.append("e.id_service = %s")
                            params.append(svc)

                    if pst not in ("", "__all__"):
                        if pst == "__none__":
                            where.append("e.id_poste_actuel IS NULL")
                        else:
                            where.append("e.id_poste_actuel = %s")
                            params.append(pst)

                    if act == "active":
                        where.append("COALESCE(e.statut_actif, TRUE) = TRUE")
                    elif act == "inactive":
                        where.append("COALESCE(e.statut_actif, TRUE) = FALSE")

                    if qq:
                        like = f"%{qq}%"
                        where.append(
                            """
                            (
                              e.nom_effectif ILIKE %s
                              OR e.prenom_effectif ILIKE %s
                              OR COALESCE(e.email_effectif,'') ILIKE %s
                              OR COALESCE(e.code_effectif,'') ILIKE %s
                              OR COALESCE(e.matricule_interne,'') ILIKE %s
                            )
                            """
                        )
                        params.extend([like, like, like, like, like])

                    cur.execute(
                        f"""
                        SELECT
                          e.id_effectif AS id_collaborateur,
                          e.prenom_effectif AS prenom,
                          e.nom_effectif AS nom,
                          e.civilite_effectif AS civilite,
                          e.email_effectif AS email,
                          e.telephone_effectif AS telephone,
                          e.telephone2_effectif AS telephone2,
                          e.id_service,
                          COALESCE(s.nom_service, '') AS nom_service,
                          e.id_poste_actuel,
                          COALESCE(p.intitule_poste, '') AS intitule_poste,
                          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                          COALESCE(e.statut_actif, TRUE) AS actif,
                          COALESCE(e.archive, FALSE) AS archive,
                          COALESCE(e.ismanager, FALSE) AS ismanager,
                          COALESCE(e.isformateur, FALSE) AS isformateur,
                          COALESCE(e.is_temp, FALSE) AS is_temp,
                          e.role_temp,
                          e.type_contrat,
                          e.matricule_interne,
                          e.code_effectif,
                          e.date_entree_entreprise_effectif AS date_entree,
                          e.date_sortie_prevue,
                          e.note_commentaire,
                          'effectif_client' AS source_row_kind
                        FROM public.tbl_effectif_client e
                        LEFT JOIN public.tbl_entreprise_organigramme s
                          ON s.id_ent = e.id_ent
                         AND s.id_service = e.id_service
                         AND COALESCE(s.archive, FALSE) = FALSE
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_owner = e.id_ent
                         AND p.id_ent = e.id_ent
                         AND p.id_poste = e.id_poste_actuel
                        WHERE {" AND ".join(where)}
                        ORDER BY lower(e.nom_effectif), lower(e.prenom_effectif)
                        """,
                        tuple(params),
                    )
                    rows = cur.fetchall() or []

                    for r in rows:
                        code_poste = (r.get("code_poste") or "").strip()
                        intitule_poste = (r.get("intitule_poste") or "").strip()
                        poste_label = (f"{code_poste} · {intitule_poste}" if code_poste else intitule_poste).strip()
                        items.append(
                            {
                                "id_collaborateur": r.get("id_collaborateur"),
                                "source_kind": src["source_kind"],
                                "source_row_kind": r.get("source_row_kind"),
                                "civilite": r.get("civilite"),
                                "prenom": r.get("prenom"),
                                "nom": r.get("nom"),
                                "email": r.get("email"),
                                "telephone": r.get("telephone"),
                                "telephone2": r.get("telephone2"),
                                "id_service": r.get("id_service"),
                                "nom_service": r.get("nom_service"),
                                "id_poste_actuel": r.get("id_poste_actuel"),
                                "poste_label": poste_label,
                                "type_contrat": r.get("type_contrat"),
                                "matricule_interne": r.get("matricule_interne"),
                                "code_effectif": r.get("code_effectif"),
                                "date_entree": r.get("date_entree").isoformat() if r.get("date_entree") else None,
                                "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                                "actif": bool(r.get("actif")),
                                "archive": bool(r.get("archive")),
                                "ismanager": bool(r.get("ismanager")),
                                "isformateur": bool(r.get("isformateur")),
                                "is_temp": bool(r.get("is_temp")),
                                "role_temp": r.get("role_temp"),
                                "note_commentaire": r.get("note_commentaire"),
                            }
                        )
                else:
                    where = ["1=1"]
                    params = []

                    if not inc_arch:
                        where.append("COALESCE(u.archive, FALSE) = FALSE")

                    if act == "active":
                        where.append("COALESCE(u.actif, TRUE) = TRUE")
                    elif act == "inactive":
                        where.append("COALESCE(u.actif, TRUE) = FALSE")

                    if qq:
                        like = f"%{qq}%"
                        where.append(
                            """
                            (
                              u.ut_nom ILIKE %s
                              OR u.ut_prenom ILIKE %s
                              OR COALESCE(u.ut_mail,'') ILIKE %s
                              OR COALESCE(u.ut_fonction,'') ILIKE %s
                            )
                            """
                        )
                        params.extend([like, like, like, like])

                    cur.execute(
                        f"""
                        SELECT
                          u.id_utilisateur AS id_collaborateur,
                          u.ut_prenom AS prenom,
                          u.ut_nom AS nom,
                          u.ut_civilite AS civilite,
                          u.ut_mail AS email,
                          u.ut_tel AS telephone,
                          u.ut_tel2 AS telephone2,
                          u.ut_fonction AS fonction,
                          u.ut_adresse AS adresse,
                          u.ut_cp AS code_postal,
                          u.ut_ville AS ville,
                          u.ut_pays AS pays,
                          COALESCE(u.actif, TRUE) AS actif,
                          COALESCE(u.archive, FALSE) AS archive,
                          u.ut_obs AS observations,
                          'utilisateur' AS source_row_kind
                        FROM public.tbl_utilisateur u
                        WHERE {" AND ".join(where)}
                        ORDER BY lower(u.ut_nom), lower(u.ut_prenom)
                        """,
                        tuple(params),
                    )
                    rows = cur.fetchall() or []

                    for r in rows:
                        items.append(
                            {
                                "id_collaborateur": r.get("id_collaborateur"),
                                "source_kind": src["source_kind"],
                                "source_row_kind": r.get("source_row_kind"),
                                "civilite": r.get("civilite"),
                                "prenom": r.get("prenom"),
                                "nom": r.get("nom"),
                                "email": r.get("email"),
                                "telephone": r.get("telephone"),
                                "telephone2": r.get("telephone2"),
                                "fonction": r.get("fonction"),
                                "adresse": r.get("adresse"),
                                "code_postal": r.get("code_postal"),
                                "ville": r.get("ville"),
                                "pays": r.get("pays"),
                                "actif": bool(r.get("actif")),
                                "archive": bool(r.get("archive")),
                                "observations": r.get("observations"),
                            }
                        )

        stats = {
            "total": len(items),
            "actifs": sum(1 for x in items if x.get("actif") and not x.get("archive")),
            "inactifs": sum(1 for x in items if (not x.get("actif")) and not x.get("archive")),
            "archives": sum(1 for x in items if x.get("archive")),
        }
        return {"items": items, "stats": stats}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/list error: {e}")


# ------------------------------------------------------
# Détail
# ------------------------------------------------------
@router.get("/studio/collaborateurs/detail/{id_owner}/{id_collaborateur}")
def studio_collab_detail(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT
                          e.id_effectif AS id_collaborateur,
                          e.civilite_effectif AS civilite,
                          e.prenom_effectif AS prenom,
                          e.nom_effectif AS nom,
                          e.email_effectif AS email,
                          e.telephone_effectif AS telephone,
                          e.telephone2_effectif AS telephone2,
                          e.adresse_effectif AS adresse,
                          e.code_postal_effectif AS code_postal,
                          e.ville_effectif AS ville,
                          e.pays_effectif AS pays,
                          e.date_naissance_effectif AS date_naissance,
                          e.niveau_education,
                          e.domaine_education,
                          e.id_poste_actuel,
                          e.type_contrat,
                          e.matricule_interne,
                          e.id_service,
                          e.business_travel,
                          e.date_entree_entreprise_effectif AS date_entree_entreprise,
                          e.date_sortie_prevue,
                          COALESCE(e.statut_actif, TRUE) AS actif,
                          e.motif_sortie,
                          e.note_commentaire,
                          COALESCE(e.archive, FALSE) AS archive,
                          COALESCE(e.havedatefin, FALSE) AS havedatefin,
                          COALESCE(e.ismanager, FALSE) AS ismanager,
                          e.date_debut_poste_actuel,
                          e.type_obtention,
                          COALESCE(e.isformateur, FALSE) AS isformateur,
                          COALESCE(e.is_temp, FALSE) AS is_temp,
                          e.role_temp,
                          e.code_effectif
                        FROM public.tbl_effectif_client e
                        WHERE e.id_ent = %s
                          AND e.id_effectif = %s
                        LIMIT 1
                        """,
                        (oid, cid),
                    )
                    r = cur.fetchone() or {}
                    if not r:
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                    return {
                        "id_collaborateur": r.get("id_collaborateur"),
                        "source_kind": src["source_kind"],
                        "source_row_kind": "effectif_client",
                        "civilite": r.get("civilite"),
                        "prenom": r.get("prenom"),
                        "nom": r.get("nom"),
                        "email": r.get("email"),
                        "telephone": r.get("telephone"),
                        "telephone2": r.get("telephone2"),
                        "adresse": r.get("adresse"),
                        "code_postal": r.get("code_postal"),
                        "ville": r.get("ville"),
                        "pays": r.get("pays"),
                        "date_naissance": r.get("date_naissance").isoformat() if r.get("date_naissance") else None,
                        "niveau_education": r.get("niveau_education"),
                        "domaine_education": r.get("domaine_education"),
                        "id_service": r.get("id_service"),
                        "id_poste_actuel": r.get("id_poste_actuel"),
                        "type_contrat": r.get("type_contrat"),
                        "matricule_interne": r.get("matricule_interne"),
                        "business_travel": r.get("business_travel"),
                        "date_entree_entreprise": r.get("date_entree_entreprise").isoformat() if r.get("date_entree_entreprise") else None,
                        "date_debut_poste_actuel": r.get("date_debut_poste_actuel").isoformat() if r.get("date_debut_poste_actuel") else None,
                        "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                        "actif": bool(r.get("actif")),
                        "motif_sortie": r.get("motif_sortie"),
                        "note_commentaire": r.get("note_commentaire"),
                        "archive": bool(r.get("archive")),
                        "havedatefin": bool(r.get("havedatefin")),
                        "ismanager": bool(r.get("ismanager")),
                        "isformateur": bool(r.get("isformateur")),
                        "is_temp": bool(r.get("is_temp")),
                        "role_temp": r.get("role_temp"),
                        "code_effectif": r.get("code_effectif"),
                    }

                cur.execute(
                    """
                    SELECT
                      u.id_utilisateur AS id_collaborateur,
                      u.ut_civilite AS civilite,
                      u.ut_prenom AS prenom,
                      u.ut_nom AS nom,
                      u.ut_mail AS email,
                      u.ut_tel AS telephone,
                      u.ut_tel2 AS telephone2,
                      u.ut_fonction AS fonction,
                      u.ut_adresse AS adresse,
                      u.ut_cp AS code_postal,
                      u.ut_ville AS ville,
                      u.ut_pays AS pays,
                      COALESCE(u.actif, TRUE) AS actif,
                      COALESCE(u.archive, FALSE) AS archive,
                      u.ut_obs AS observations
                    FROM public.tbl_utilisateur u
                    WHERE u.id_utilisateur = %s
                    LIMIT 1
                    """,
                    (cid,),
                )
                r = cur.fetchone() or {}
                if not r:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                return {
                    "id_collaborateur": r.get("id_collaborateur"),
                    "source_kind": src["source_kind"],
                    "source_row_kind": "utilisateur",
                    "civilite": r.get("civilite"),
                    "prenom": r.get("prenom"),
                    "nom": r.get("nom"),
                    "email": r.get("email"),
                    "telephone": r.get("telephone"),
                    "telephone2": r.get("telephone2"),
                    "fonction": r.get("fonction"),
                    "adresse": r.get("adresse"),
                    "code_postal": r.get("code_postal"),
                    "ville": r.get("ville"),
                    "pays": r.get("pays"),
                    "actif": bool(r.get("actif")),
                    "archive": bool(r.get("archive")),
                    "observations": r.get("observations"),
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/detail error: {e}")


# ------------------------------------------------------
# Create
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}")
def studio_collab_create(id_owner: str, payload: CollaborateurPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        prenom = _norm_text(payload.prenom)
        nom = _norm_text(payload.nom)
        if not prenom or not nom:
            raise HTTPException(status_code=400, detail="Prénom et nom obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cid = str(uuid.uuid4())
                    date_naissance = _norm_iso_date(payload.date_naissance)
                    date_entree = _norm_iso_date(payload.date_entree_entreprise)
                    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                    date_sortie = _norm_iso_date(payload.date_sortie_prevue)
                    id_poste = _norm_text(payload.id_poste_actuel)
                    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

                    cur.execute(
                        """
                        INSERT INTO public.tbl_effectif_client (
                          id_effectif,
                          id_ent,
                          nom_effectif,
                          prenom_effectif,
                          civilite_effectif,
                          email_effectif,
                          telephone_effectif,
                          telephone2_effectif,
                          adresse_effectif,
                          code_postal_effectif,
                          ville_effectif,
                          pays_effectif,
                          date_naissance_effectif,
                          niveau_education,
                          domaine_education,
                          id_poste_actuel,
                          type_contrat,
                          matricule_interne,
                          id_service,
                          business_travel,
                          date_entree_entreprise_effectif,
                          date_sortie_prevue,
                          statut_actif,
                          motif_sortie,
                          note_commentaire,
                          archive,
                          date_creation,
                          dernier_update,
                          havedatefin,
                          ismanager,
                          date_debut_poste_actuel,
                          isformateur,
                          is_temp,
                          role_temp,
                          code_effectif
                        ) VALUES (
                          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s, %s, %s, FALSE, CURRENT_DATE, NOW(), %s, %s,
                          %s, %s, %s, %s, %s
                        )
                        """,
                        (
                          cid,
                          oid,
                          nom,
                          prenom,
                          _norm_text(payload.civilite),
                          _norm_text(payload.email),
                          _norm_text(payload.telephone),
                          _norm_text(payload.telephone2),
                          _norm_text(payload.adresse),
                          _norm_text(payload.code_postal),
                          _norm_text(payload.ville),
                          _norm_text(payload.pays),
                          date_naissance,
                          _norm_text(payload.niveau_education),
                          _norm_text(payload.domaine_education),
                          id_poste,
                          _norm_text(payload.type_contrat),
                          _norm_text(payload.matricule_interne),
                          id_service,
                          _norm_text(payload.business_travel),
                          date_entree,
                          date_sortie,
                          _norm_bool(payload.actif, True),
                          _norm_text(payload.motif_sortie),
                          _norm_text(payload.note_commentaire),
                          _norm_bool(payload.havedatefin, bool(date_sortie)),
                          _norm_bool(payload.ismanager, False),
                          date_debut_poste,
                          _norm_bool(payload.isformateur, False),
                          _norm_bool(payload.is_temp, False),
                          _norm_text(payload.role_temp),
                          _norm_text(payload.code_effectif),
                        ),
                    )
                    conn.commit()
                    return {"ok": True, "id_collaborateur": cid}

                cid = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO public.tbl_utilisateur (
                      id_utilisateur,
                      ut_prenom,
                      ut_nom,
                      ut_mail,
                      ut_tel,
                      ut_tel2,
                      actif,
                      archive,
                      ut_civilite,
                      ut_fonction,
                      ut_adresse,
                      ut_cp,
                      ut_ville,
                      ut_pays,
                      date_creation,
                      dernier_update,
                      ut_obs
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s, FALSE, %s, %s, %s, %s, %s, %s, CURRENT_DATE, NOW(), %s
                    )
                    """,
                    (
                      cid,
                      prenom,
                      nom,
                      _norm_text(payload.email),
                      _norm_text(payload.telephone),
                      _norm_text(payload.telephone2),
                      _norm_bool(payload.actif, True),
                      _norm_text(payload.civilite),
                      _norm_text(payload.fonction),
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                    ),
                )
                conn.commit()
                return {"ok": True, "id_collaborateur": cid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/create error: {e}")


# ------------------------------------------------------
# Update
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}/{id_collaborateur}")
def studio_collab_update(id_owner: str, id_collaborateur: str, payload: CollaborateurPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        prenom = _norm_text(payload.prenom)
        nom = _norm_text(payload.nom)
        if not prenom or not nom:
            raise HTTPException(status_code=400, detail="Prénom et nom obligatoires.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        LIMIT 1
                        """,
                        (oid, cid),
                    )
                    if not cur.fetchone():
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                    date_naissance = _norm_iso_date(payload.date_naissance)
                    date_entree = _norm_iso_date(payload.date_entree_entreprise)
                    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
                    date_sortie = _norm_iso_date(payload.date_sortie_prevue)
                    id_poste = _norm_text(payload.id_poste_actuel)
                    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client
                        SET
                          nom_effectif = %s,
                          prenom_effectif = %s,
                          civilite_effectif = %s,
                          email_effectif = %s,
                          telephone_effectif = %s,
                          telephone2_effectif = %s,
                          adresse_effectif = %s,
                          code_postal_effectif = %s,
                          ville_effectif = %s,
                          pays_effectif = %s,
                          date_naissance_effectif = %s,
                          niveau_education = %s,
                          domaine_education = %s,
                          id_poste_actuel = %s,
                          type_contrat = %s,
                          matricule_interne = %s,
                          id_service = %s,
                          business_travel = %s,
                          date_entree_entreprise_effectif = %s,
                          date_sortie_prevue = %s,
                          statut_actif = %s,
                          motif_sortie = %s,
                          note_commentaire = %s,
                          havedatefin = %s,
                          ismanager = %s,
                          date_debut_poste_actuel = %s,
                          isformateur = %s,
                          is_temp = %s,
                          role_temp = %s,
                          code_effectif = %s,
                          dernier_update = NOW()
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        """,
                        (
                          nom,
                          prenom,
                          _norm_text(payload.civilite),
                          _norm_text(payload.email),
                          _norm_text(payload.telephone),
                          _norm_text(payload.telephone2),
                          _norm_text(payload.adresse),
                          _norm_text(payload.code_postal),
                          _norm_text(payload.ville),
                          _norm_text(payload.pays),
                          date_naissance,
                          _norm_text(payload.niveau_education),
                          _norm_text(payload.domaine_education),
                          id_poste,
                          _norm_text(payload.type_contrat),
                          _norm_text(payload.matricule_interne),
                          id_service,
                          _norm_text(payload.business_travel),
                          date_entree,
                          date_sortie,
                          _norm_bool(payload.actif, True),
                          _norm_text(payload.motif_sortie),
                          _norm_text(payload.note_commentaire),
                          _norm_bool(payload.havedatefin, bool(date_sortie)),
                          _norm_bool(payload.ismanager, False),
                          date_debut_poste,
                          _norm_bool(payload.isformateur, False),
                          _norm_bool(payload.is_temp, False),
                          _norm_text(payload.role_temp),
                          _norm_text(payload.code_effectif),
                          oid,
                          cid,
                        ),
                    )
                    conn.commit()
                    return {"ok": True, "id_collaborateur": cid}

                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_utilisateur
                    WHERE id_utilisateur = %s
                    LIMIT 1
                    """,
                    (cid,),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                cur.execute(
                    """
                    UPDATE public.tbl_utilisateur
                    SET
                      ut_prenom = %s,
                      ut_nom = %s,
                      ut_mail = %s,
                      ut_tel = %s,
                      ut_tel2 = %s,
                      actif = %s,
                      ut_civilite = %s,
                      ut_fonction = %s,
                      ut_adresse = %s,
                      ut_cp = %s,
                      ut_ville = %s,
                      ut_pays = %s,
                      ut_obs = %s,
                      dernier_update = NOW()
                    WHERE id_utilisateur = %s
                    """,
                    (
                      prenom,
                      nom,
                      _norm_text(payload.email),
                      _norm_text(payload.telephone),
                      _norm_text(payload.telephone2),
                      _norm_bool(payload.actif, True),
                      _norm_text(payload.civilite),
                      _norm_text(payload.fonction),
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                      cid,
                    ),
                )
                conn.commit()
                return {"ok": True, "id_collaborateur": cid}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/update error: {e}")


# ------------------------------------------------------
# Archive
# ------------------------------------------------------
@router.post("/studio/collaborateurs/{id_owner}/{id_collaborateur}/archive")
def studio_collab_archive(id_owner: str, id_collaborateur: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        cid = (id_collaborateur or "").strip()
        if not cid:
            raise HTTPException(status_code=400, detail="id_collaborateur manquant.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")
                src = _resolve_owner_source(cur, oid)

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client
                        SET archive = TRUE,
                            dernier_update = NOW()
                        WHERE id_ent = %s
                          AND id_effectif = %s
                        """,
                        (oid, cid),
                    )
                    if cur.rowcount <= 0:
                        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
                    conn.commit()
                    return {"ok": True}

                cur.execute(
                    """
                    UPDATE public.tbl_utilisateur
                    SET archive = TRUE,
                        dernier_update = NOW()
                    WHERE id_utilisateur = %s
                    """,
                    (cid,),
                )
                if cur.rowcount <= 0:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
                conn.commit()
                return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/archive error: {e}")