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
    cur.execute(
        """
        WITH RECURSIVE svc AS (
          SELECT
            s.id_service,
            s.nom_service,
            NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') AS id_service_parent,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND (
              NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM public.tbl_entreprise_organigramme p
                WHERE p.id_ent = s.id_ent
                  AND p.id_service = NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '')
                  AND COALESCE(p.archive, FALSE) = FALSE
              )
            )

          UNION ALL

          SELECT
            c.id_service,
            c.nom_service,
            NULLIF(BTRIM(COALESCE(c.id_service_parent, '')), '') AS id_service_parent,
            p.depth + 1 AS depth,
            (p.path || ' > ' || c.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme c
          JOIN svc p
            ON p.id_service = NULLIF(BTRIM(COALESCE(c.id_service_parent, '')), '')
          WHERE c.id_ent = %s
            AND COALESCE(c.archive, FALSE) = FALSE
        ),
        svc_all AS (
          SELECT
            svc.id_service,
            svc.nom_service,
            svc.id_service_parent,
            svc.depth,
            svc.path
          FROM svc

          UNION

          SELECT
            s.id_service,
            s.nom_service,
            NULLIF(BTRIM(COALESCE(s.id_service_parent, '')), '') AS id_service_parent,
            0 AS depth,
            (s.nom_service)::text AS path
          FROM public.tbl_entreprise_organigramme s
          WHERE s.id_ent = %s
            AND COALESCE(s.archive, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1
              FROM svc x
              WHERE x.id_service = s.id_service
            )
        )
        SELECT
          svc_all.id_service,
          svc_all.nom_service,
          svc_all.id_service_parent,
          svc_all.depth,
          (
            SELECT COUNT(1)
            FROM public.tbl_effectif_client e
            WHERE e.id_ent = %s
              AND COALESCE(e.archive, FALSE) = FALSE
              AND svc_all.id_service = e.id_service
          ) AS nb_collabs
        FROM svc_all
        ORDER BY svc_all.path
        """,
        (oid, oid, oid, oid),
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

def _load_domaine_competence_map(cur, ids: list) -> dict:
    ids = [str(x).strip() for x in (ids or []) if str(x).strip()]
    if not ids:
        return {}

    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tbl_domaine_competence'
        """
    )
    cols = {r["column_name"] for r in (cur.fetchall() or [])}
    if not cols:
        return {}

    id_col = "id_domaine_competence" if "id_domaine_competence" in cols else ("id_domaine" if "id_domaine" in cols else None)
    titre_col = "titre" if "titre" in cols else ("nom" if "nom" in cols else ("intitule" if "intitule" in cols else None))
    couleur_col = "couleur" if "couleur" in cols else ("color" if "color" in cols else None)
    if not id_col or not titre_col:
        return {}

    select_color = f"{couleur_col}::text AS couleur" if couleur_col else "NULL::text AS couleur"

    cur.execute(
        f"""
        SELECT
          {id_col}::text AS id,
          {titre_col}::text AS titre,
          {select_color}
        FROM public.tbl_domaine_competence
        WHERE {id_col} = ANY(%s)
        """,
        (ids,),
    )

    out = {}
    for r in (cur.fetchall() or []):
        did = (r.get("id") or "").strip()
        if did:
            out[did] = {
                "titre": (r.get("titre") or "").strip() or None,
                "couleur": (r.get("couleur") or "").strip() or None,
            }
    return out


def _get_collab_scope(cur, oid: str, source_kind: str, cid: str) -> dict:
    if source_kind == "entreprise":
        cur.execute(
            """
            SELECT
              e.id_effectif AS id_effectif_data,
              e.id_poste_actuel,
              COALESCE(p.intitule_poste, '') AS intitule_poste,
              'effectif_client' AS source_row_kind
            FROM public.tbl_effectif_client e
            LEFT JOIN public.tbl_fiche_poste p
              ON p.id_poste = e.id_poste_actuel
             AND p.id_owner = e.id_ent
             AND p.id_ent = e.id_ent
             AND COALESCE(p.actif, TRUE) = TRUE
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
            "id_effectif_data": r.get("id_effectif_data"),
            "id_poste_actuel": r.get("id_poste_actuel"),
            "intitule_poste": r.get("intitule_poste"),
            "source_row_kind": r.get("source_row_kind"),
        }

    cur.execute(
        """
        SELECT
          u.id_utilisateur AS id_effectif_data,
          COALESCE(ec.id_poste_actuel, u.ut_fonction) AS id_poste_actuel,
          COALESCE(p.intitule_poste, '') AS intitule_poste,
          'utilisateur' AS source_row_kind
        FROM public.tbl_utilisateur u
        LEFT JOIN public.tbl_effectif_client ec
          ON ec.id_ent = %s
         AND ec.id_effectif = u.id_utilisateur
        LEFT JOIN public.tbl_fiche_poste p
          ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
         AND p.id_owner = %s
         AND p.id_ent = %s
         AND COALESCE(p.actif, TRUE) = TRUE
        WHERE u.id_utilisateur = %s
        LIMIT 1
        """,
        (oid, oid, oid, cid),
    )
    r = cur.fetchone() or {}
    if not r:
        raise HTTPException(status_code=404, detail="Collaborateur introuvable.")
    return {
        "id_effectif_data": r.get("id_effectif_data"),
        "id_poste_actuel": r.get("id_poste_actuel"),
        "intitule_poste": r.get("intitule_poste"),
        "source_row_kind": r.get("source_row_kind"),
    }


def _upsert_effectif_mirror_for_utilisateur(cur, oid: str, cid: str, payload) -> None:
    id_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
    id_service = _norm_service_from_payload(cur, oid, payload.id_service, id_poste)

    date_naissance = _norm_iso_date(payload.date_naissance)
    date_entree = _norm_iso_date(payload.date_entree_entreprise)
    date_debut_poste = _norm_iso_date(payload.date_debut_poste_actuel)
    date_sortie = _norm_iso_date(payload.date_sortie_prevue)

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
    exists = cur.fetchone() is not None

    values = (
        _norm_text(payload.nom),
        _norm_text(payload.prenom),
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
    )

    if exists:
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
              archive = FALSE,
              dernier_update = NOW()
            WHERE id_ent = %s
              AND id_effectif = %s
            """,
            values + (oid, cid),
        )
        return

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
        (cid, oid) + values,
    )

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

                if src["source_kind"] == "entreprise":
                    cur.execute(
                        """
                        SELECT
                        COUNT(1) AS total,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(statut_actif, TRUE) = TRUE
                        ) AS actifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(statut_actif, TRUE) = FALSE
                        ) AS inactifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = TRUE
                        ) AS archives
                        FROM public.tbl_effectif_client
                        WHERE id_ent = %s
                        """,
                        (oid,),
                    )
                    s = cur.fetchone() or {}
                else:
                    cur.execute(
                        """
                        SELECT
                        COUNT(1) AS total,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(actif, TRUE) = TRUE
                        ) AS actifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = FALSE
                            AND COALESCE(actif, TRUE) = FALSE
                        ) AS inactifs,
                        COUNT(1) FILTER (
                            WHERE COALESCE(archive, FALSE) = TRUE
                        ) AS archives
                        FROM public.tbl_utilisateur
                        """
                    )
                    s = cur.fetchone() or {}

                stats_global = {
                    "total": int(s.get("total") or 0),
                    "actifs": int(s.get("actifs") or 0),
                    "inactifs": int(s.get("inactifs") or 0),
                    "archives": int(s.get("archives") or 0),
                }

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
                    elif act == "manager":
                        where.append("COALESCE(e.ismanager, FALSE) = TRUE")
                    elif act == "formateur":
                        where.append("COALESCE(e.isformateur, FALSE) = TRUE")

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

                    if svc not in ("", "__all__"):
                        if svc == "__none__":
                            where.append("COALESCE(ec.id_service, p.id_service) IS NULL")
                        else:
                            where.append("COALESCE(ec.id_service, p.id_service) = %s")
                            params.append(svc)

                    if pst not in ("", "__all__"):
                        if pst == "__none__":
                            where.append("COALESCE(ec.id_poste_actuel, p.id_poste) IS NULL")
                        else:
                            where.append("COALESCE(ec.id_poste_actuel, p.id_poste) = %s")
                            params.append(pst)

                    if act == "active":
                        where.append("COALESCE(u.actif, TRUE) = TRUE")
                    elif act == "inactive":
                        where.append("COALESCE(u.actif, TRUE) = FALSE")
                    elif act == "manager":
                        where.append("COALESCE(ec.ismanager, FALSE) = TRUE")
                    elif act == "formateur":
                        where.append("COALESCE(ec.isformateur, FALSE) = TRUE")

                    if qq:
                        like = f"%{qq}%"
                        where.append(
                            """
                            (
                              u.ut_nom ILIKE %s
                              OR u.ut_prenom ILIKE %s
                              OR COALESCE(u.ut_mail,'') ILIKE %s
                              OR COALESCE(p.intitule_poste,'') ILIKE %s
                              OR COALESCE(p.codif_client, p.codif_poste, '') ILIKE %s
                              OR COALESCE(ec.code_effectif, '') ILIKE %s
                              OR COALESCE(ec.matricule_interne, '') ILIKE %s
                            )
                            """
                        )
                        params.extend([like, like, like, like, like, like, like])

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
                          COALESCE(ec.id_poste_actuel, p.id_poste) AS id_poste_actuel,
                          COALESCE(ec.id_service, p.id_service) AS id_service,
                          COALESCE(p.intitule_poste, '') AS intitule_poste,
                          COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                          COALESCE(s.nom_service, '') AS nom_service,
                          COALESCE(ec.ismanager, FALSE) AS ismanager,
                          COALESCE(ec.isformateur, FALSE) AS isformateur,
                          COALESCE(ec.is_temp, FALSE) AS is_temp,
                          ec.role_temp,
                          ec.type_contrat,
                          ec.matricule_interne,
                          ec.code_effectif,
                          ec.date_entree_entreprise_effectif AS date_entree,
                          ec.date_sortie_prevue,
                          ec.note_commentaire,
                          'utilisateur' AS source_row_kind
                        FROM public.tbl_utilisateur u
                        LEFT JOIN public.tbl_effectif_client ec
                          ON ec.id_ent = %s
                         AND ec.id_effectif = u.id_utilisateur
                        LEFT JOIN public.tbl_fiche_poste p
                          ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
                         AND p.id_owner = %s
                         AND p.id_ent = %s
                         AND COALESCE(p.actif, TRUE) = TRUE
                        LEFT JOIN public.tbl_entreprise_organigramme s
                          ON s.id_service = COALESCE(ec.id_service, p.id_service)
                         AND s.id_ent = %s
                         AND COALESCE(s.archive, FALSE) = FALSE
                        WHERE {" AND ".join(where)}
                        ORDER BY lower(u.ut_nom), lower(u.ut_prenom)
                        """,
                        tuple([oid, oid, oid, oid] + params),
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
                                "fonction": r.get("fonction"),
                                "id_poste_actuel": r.get("id_poste_actuel"),
                                "id_service": r.get("id_service"),
                                "nom_service": r.get("nom_service"),
                                "poste_label": poste_label,
                                "adresse": r.get("adresse"),
                                "code_postal": r.get("code_postal"),
                                "ville": r.get("ville"),
                                "pays": r.get("pays"),
                                "actif": bool(r.get("actif")),
                                "archive": bool(r.get("archive")),
                                "ismanager": bool(r.get("ismanager")),
                                "isformateur": bool(r.get("isformateur")),
                                "is_temp": bool(r.get("is_temp")),
                                "role_temp": r.get("role_temp"),
                                "type_contrat": r.get("type_contrat"),
                                "matricule_interne": r.get("matricule_interne"),
                                "code_effectif": r.get("code_effectif"),
                                "date_entree": r.get("date_entree").isoformat() if r.get("date_entree") else None,
                                "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                                "note_commentaire": r.get("note_commentaire"),
                                "observations": r.get("observations"),
                            }
                        )

        return {"items": items, "stats": stats_global}
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
                      u.ut_obs AS observations,
                      ec.date_naissance_effectif AS date_naissance,
                      ec.niveau_education,
                      ec.domaine_education,
                      COALESCE(ec.id_poste_actuel, p.id_poste) AS id_poste_actuel,
                      ec.type_contrat,
                      ec.matricule_interne,
                      COALESCE(ec.id_service, p.id_service) AS id_service,
                      ec.business_travel,
                      ec.date_entree_entreprise_effectif AS date_entree_entreprise,
                      ec.date_sortie_prevue,
                      ec.motif_sortie,
                      ec.note_commentaire,
                      COALESCE(ec.havedatefin, FALSE) AS havedatefin,
                      COALESCE(ec.ismanager, FALSE) AS ismanager,
                      ec.date_debut_poste_actuel,
                      COALESCE(ec.isformateur, FALSE) AS isformateur,
                      COALESCE(ec.is_temp, FALSE) AS is_temp,
                      ec.role_temp,
                      ec.code_effectif,
                      COALESCE(p.intitule_poste, '') AS intitule_poste,
                      COALESCE(p.codif_client, p.codif_poste, '') AS code_poste,
                      COALESCE(s.nom_service, '') AS nom_service
                    FROM public.tbl_utilisateur u
                    LEFT JOIN public.tbl_effectif_client ec
                      ON ec.id_ent = %s
                     AND ec.id_effectif = u.id_utilisateur
                    LEFT JOIN public.tbl_fiche_poste p
                      ON p.id_poste = COALESCE(ec.id_poste_actuel, u.ut_fonction)
                     AND p.id_owner = %s
                     AND p.id_ent = %s
                     AND COALESCE(p.actif, TRUE) = TRUE
                    LEFT JOIN public.tbl_entreprise_organigramme s
                      ON s.id_service = COALESCE(ec.id_service, p.id_service)
                     AND s.id_ent = %s
                     AND COALESCE(s.archive, FALSE) = FALSE
                    WHERE u.id_utilisateur = %s
                    LIMIT 1
                    """,
                    (oid, oid, oid, oid, cid),
                )
                r = cur.fetchone() or {}
                if not r:
                    raise HTTPException(status_code=404, detail="Collaborateur introuvable.")

                code_poste = (r.get("code_poste") or "").strip()
                intitule_poste = (r.get("intitule_poste") or "").strip()
                poste_label = (f"{code_poste} · {intitule_poste}" if code_poste else intitule_poste).strip()

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
                    "id_poste_actuel": r.get("id_poste_actuel"),
                    "id_service": r.get("id_service"),
                    "nom_service": r.get("nom_service"),
                    "poste_label": poste_label,
                    "adresse": r.get("adresse"),
                    "code_postal": r.get("code_postal"),
                    "ville": r.get("ville"),
                    "pays": r.get("pays"),
                    "date_naissance": r.get("date_naissance").isoformat() if r.get("date_naissance") else None,
                    "niveau_education": r.get("niveau_education"),
                    "domaine_education": r.get("domaine_education"),
                    "type_contrat": r.get("type_contrat"),
                    "matricule_interne": r.get("matricule_interne"),
                    "business_travel": r.get("business_travel"),
                    "date_entree_entreprise": r.get("date_entree_entreprise").isoformat() if r.get("date_entree_entreprise") else None,
                    "date_debut_poste_actuel": r.get("date_debut_poste_actuel").isoformat() if r.get("date_debut_poste_actuel") else None,
                    "date_sortie_prevue": r.get("date_sortie_prevue").isoformat() if r.get("date_sortie_prevue") else None,
                    "motif_sortie": r.get("motif_sortie"),
                    "note_commentaire": r.get("note_commentaire"),
                    "actif": bool(r.get("actif")),
                    "archive": bool(r.get("archive")),
                    "havedatefin": bool(r.get("havedatefin")),
                    "ismanager": bool(r.get("ismanager")),
                    "isformateur": bool(r.get("isformateur")),
                    "is_temp": bool(r.get("is_temp")),
                    "role_temp": r.get("role_temp"),
                    "code_effectif": r.get("code_effectif"),
                    "observations": r.get("observations"),
                }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/detail error: {e}")

@router.get("/studio/collaborateurs/competences/{id_owner}/{id_collaborateur}")
def studio_collab_competences(id_owner: str, id_collaborateur: str, request: Request):
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
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

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
                        req.poids_criticite,
                        req.freq_usage,
                        req.impact_resultat,
                        req.dependance
                    FROM public.tbl_competence c
                    LEFT JOIN req
                      ON req.id_comp = c.id_comp
                    LEFT JOIN curc
                      ON curc.id_comp = c.id_comp
                    WHERE (req.id_comp IS NOT NULL OR curc.id_comp IS NOT NULL)
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') = 'active'
                    ORDER BY
                      (req.id_comp IS NULL) ASC,
                      COALESCE(req.poids_criticite, 0) DESC,
                      c.intitule
                    """,
                    (scope["id_poste_actuel"], scope["id_effectif_data"]),
                )
                rows = cur.fetchall() or []

                domaine_ids = []
                seen = set()
                for rr in rows:
                    did = (rr.get("domaine") or "").strip()
                    if did and did not in seen:
                        seen.add(did)
                        domaine_ids.append(did)
                domaine_map = _load_domaine_competence_map(cur, domaine_ids)

        items = []
        for r in rows:
            dmeta = domaine_map.get((r.get("domaine") or "").strip(), {})
            items.append(
                {
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "domaine": r.get("domaine"),
                    "domaine_titre": dmeta.get("titre"),
                    "domaine_couleur": dmeta.get("couleur"),
                    "is_required": bool(r.get("is_required")),
                    "niveau_requis": r.get("niveau_requis"),
                    "niveau_actuel": r.get("niveau_actuel"),
                    "date_derniere_eval": r.get("date_derniere_eval").isoformat() if r.get("date_derniere_eval") else None,
                    "poids_criticite": r.get("poids_criticite"),
                    "freq_usage": r.get("freq_usage"),
                    "impact_resultat": r.get("impact_resultat"),
                    "dependance": r.get("dependance"),
                }
            )

        return {
            "id_collaborateur": cid,
            "id_poste_actuel": scope.get("id_poste_actuel"),
            "intitule_poste": scope.get("intitule_poste"),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/competences error: {e}")


@router.get("/studio/collaborateurs/certifications/{id_owner}/{id_collaborateur}")
def studio_collab_certifications(id_owner: str, id_collaborateur: str, request: Request):
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
                scope = _get_collab_scope(cur, oid, src["source_kind"], cid)

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
                        c.nom_certification
                    """,
                    (scope["id_poste_actuel"], scope["id_effectif_data"]),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            jr = r.get("jours_restants")
            items.append(
                {
                    "id_certification": r.get("id_certification"),
                    "nom_certification": r.get("nom_certification"),
                    "categorie": r.get("categorie"),
                    "description": r.get("description"),
                    "is_required": bool(r.get("is_required")),
                    "niveau_exigence": r.get("niveau_exigence"),
                    "validite_reference": r.get("validite_reference"),
                    "validite_override": r.get("validite_override"),
                    "validite_attendue": r.get("validite_attendue"),
                    "delai_renouvellement": r.get("delai_renouvellement"),
                    "commentaire_poste": r.get("commentaire_poste"),
                    "is_acquired": bool(r.get("is_acquired")),
                    "id_effectif_certification": r.get("id_effectif_certification"),
                    "date_obtention": r.get("date_obtention").isoformat() if r.get("date_obtention") else None,
                    "date_expiration": r.get("date_expiration").isoformat() if r.get("date_expiration") else None,
                    "date_expiration_calculee": r.get("date_expiration_calculee").isoformat() if r.get("date_expiration_calculee") else None,
                    "statut_validite": r.get("statut_validite"),
                    "jours_restants": int(jr) if jr is not None else None,
                    "organisme": r.get("organisme"),
                    "reference": r.get("reference"),
                    "commentaire": r.get("commentaire"),
                    "id_preuve_doc": r.get("id_preuve_doc"),
                }
            )

        return {
            "id_collaborateur": cid,
            "id_poste_actuel": scope.get("id_poste_actuel"),
            "intitule_poste": scope.get("intitule_poste"),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/certifications error: {e}")


@router.get("/studio/collaborateurs/historique/formations-jmb/{id_owner}/{id_collaborateur}")
def studio_collab_historique_formations_jmb(id_owner: str, id_collaborateur: str, request: Request):
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
                _get_collab_scope(cur, oid, src["source_kind"], cid)

                cur.execute(
                    """
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
                    LEFT JOIN public.tbl_action_formation af
                      ON af.id_action_formation = acfe.id_action_formation
                    LEFT JOIN public.tbl_fiche_formation ff
                      ON ff.id_form = af.id_form
                    WHERE acfe.id_effectif = %s
                      AND acfe.id_action_formation IS NOT NULL
                      AND COALESCE(acfe.archive, FALSE) = FALSE
                      AND COALESCE(af.archive, FALSE) = FALSE
                      AND (ff.id_form IS NULL OR COALESCE(ff.masque, FALSE) = FALSE)
                    ORDER BY
                      af.date_fin_formation DESC NULLS LAST,
                      af.date_debut_formation DESC NULLS LAST,
                      af.date_creation DESC NULLS LAST,
                      acfe.id_action_formation_effectif DESC
                    """,
                    (cid,),
                )
                rows = cur.fetchall() or []

        items = []
        for r in rows:
            items.append(
                {
                    "id_action_formation_effectif": r.get("id_action_formation_effectif"),
                    "id_action_formation": r.get("id_action_formation"),
                    "code_action_formation": r.get("code_action_formation"),
                    "etat_action": r.get("etat_action"),
                    "date_debut_formation": r.get("date_debut_formation").isoformat() if r.get("date_debut_formation") else None,
                    "date_fin_formation": r.get("date_fin_formation").isoformat() if r.get("date_fin_formation") else None,
                    "id_form": r.get("id_form"),
                    "code_formation": r.get("code_formation"),
                    "titre_formation": r.get("titre_formation"),
                    "archive_inscription": bool(r.get("archive_inscription")) if r.get("archive_inscription") is not None else None,
                    "archive_action": bool(r.get("archive_action")) if r.get("archive_action") is not None else None,
                }
            )

        return {"id_collaborateur": cid, "items": items}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/historique/formations-jmb error: {e}")

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
                user_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
                if user_poste:
                    _fetch_poste_service(cur, oid, user_poste)

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
                      user_poste,
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                    ),
                )
                _upsert_effectif_mirror_for_utilisateur(cur, oid, cid, payload)
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

                user_poste = _norm_text(payload.id_poste_actuel) or _norm_text(payload.fonction)
                if user_poste:
                    _fetch_poste_service(cur, oid, user_poste)

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
                      user_poste,
                      _norm_text(payload.adresse),
                      _norm_text(payload.code_postal),
                      _norm_text(payload.ville),
                      _norm_text(payload.pays),
                      _norm_text(payload.observations),
                      cid,
                    ),
                )
                _upsert_effectif_mirror_for_utilisateur(cur, oid, cid, payload)
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
                conn.commit()
                return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/collaborateurs/archive error: {e}")