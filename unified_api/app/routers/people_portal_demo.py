from datetime import date
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from psycopg.rows import dict_row
from psycopg.types.json import Json

from app.routers.skills_portal_common import get_conn
from app.routers.people_portal_common import people_require_user, people_fetch_profile

router = APIRouter()


class PeopleBreakPayload(BaseModel):
    date_debut: str
    date_fin: str


class PeopleAddCompetencePayload(BaseModel):
    id_comp: str
    niveau_actuel: Optional[str] = None


class PeopleAutoEvalItem(BaseModel):
    id_comp: str
    niveau_auto: Optional[str] = None
    commentaire: Optional[str] = None
    besoin_accompagnement: Optional[bool] = False


class PeopleAutoEvalPayload(BaseModel):
    items: List[PeopleAutoEvalItem] = []
    commentaire_general: Optional[str] = None


def _clean(v: Any) -> str:
    return (str(v).strip() if v is not None else "")


def _uuid() -> str:
    return str(uuid4())


def _parse_date(v: str, field_name: str) -> date:
    raw = _clean(v)
    if not raw:
        raise HTTPException(status_code=400, detail=f"{field_name} manquant.")
    try:
        return date.fromisoformat(raw[:10])
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_name} invalide.")


def _require_profile(cur, request: Request, id_effectif: str) -> dict:
    auth = request.headers.get("Authorization", "")
    u = people_require_user(auth)
    return people_fetch_profile(
        cur,
        id_effectif=id_effectif,
        email=(u.get("email") or ""),
        is_super_admin=bool(u.get("is_super_admin")),
    )


def _fetch_effectif_row(cur, profile: dict) -> dict:
    id_effectif = _clean(profile.get("id_effectif"))
    id_owner = _clean(profile.get("id_owner"))

    cur.execute(
        """
        SELECT
          ec.*,
          COALESCE(ent.nom_ent, me.nom_ent, '') AS nom_owner,
          COALESCE(org.nom_service, '') AS nom_service,
          COALESCE(fp.intitule_poste, '') AS intitule_poste,
          COALESCE(fp.codif_poste, '') AS codif_poste,
          COALESCE(fp.mission_principale, '') AS mission_principale,
          COALESCE(fp.perspectives_evolution, '') AS perspectives_evolution
        FROM public.tbl_effectif_client ec
        LEFT JOIN public.tbl_entreprise ent
          ON ent.id_ent = ec.id_ent
         AND COALESCE(ent.masque, FALSE) = FALSE
        LEFT JOIN public.tbl_mon_entreprise me
          ON me.id_mon_ent = ec.id_ent
         AND COALESCE(me.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_entreprise_organigramme org
          ON org.id_ent = ec.id_ent
         AND org.id_service = ec.id_service
         AND COALESCE(org.archive, FALSE) = FALSE
        LEFT JOIN public.tbl_fiche_poste fp
          ON fp.id_owner = ec.id_ent
         AND fp.id_ent = ec.id_ent
         AND fp.id_poste = ec.id_poste_actuel
         AND COALESCE(fp.actif, TRUE) = TRUE
        WHERE ec.id_effectif = %s
          AND ec.id_ent = %s
          AND COALESCE(ec.archive, FALSE) = FALSE
        LIMIT 1
        """,
        (id_effectif, id_owner),
    )
    row = cur.fetchone() or {}
    if row:
        return row

    return {
        "id_effectif": id_effectif,
        "id_ent": id_owner,
        "prenom_effectif": profile.get("prenom") or "",
        "nom_effectif": profile.get("nom") or "",
        "email_effectif": profile.get("email") or "",
        "nom_owner": profile.get("nom_owner") or "",
        "nom_service": profile.get("nom_service") or "",
        "intitule_poste": profile.get("intitule_poste") or "",
        "source_light": True,
    }


def _profile_payload(profile: dict, effectif: dict) -> dict:
    return {
        "id_owner": _clean(profile.get("id_owner")),
        "id_effectif": _clean(profile.get("id_effectif")),
        "source_row_kind": _clean(profile.get("source_row_kind")),
        "prenom": _clean(effectif.get("prenom_effectif") or profile.get("prenom")),
        "nom": _clean(effectif.get("nom_effectif") or profile.get("nom")),
        "civilite": _clean(effectif.get("civilite_effectif")),
        "email": _clean(effectif.get("email_effectif") or profile.get("email")),
        "telephone": _clean(effectif.get("telephone_effectif")),
        "telephone2": _clean(effectif.get("telephone2_effectif")),
        "adresse": _clean(effectif.get("adresse_effectif")),
        "code_postal": _clean(effectif.get("code_postal_effectif")),
        "ville": _clean(effectif.get("ville_effectif")),
        "pays": _clean(effectif.get("pays_effectif")),
        "date_naissance": _clean(effectif.get("date_naissance_effectif")),
        "date_entree": _clean(effectif.get("date_entree_entreprise_effectif")),
        "date_debut_poste": _clean(effectif.get("date_debut_poste_actuel")),
        "niveau_education": _clean(effectif.get("niveau_education")),
        "domaine_education": _clean(effectif.get("domaine_education")),
        "type_contrat": _clean(effectif.get("type_contrat")),
        "matricule": _clean(effectif.get("matricule_interne")),
        "nom_owner": _clean(effectif.get("nom_owner") or profile.get("nom_owner")),
        "nom_service": _clean(effectif.get("nom_service") or profile.get("nom_service")),
        "id_poste_actuel": _clean(effectif.get("id_poste_actuel")),
        "intitule_poste": _clean(effectif.get("intitule_poste") or profile.get("intitule_poste")),
        "codif_poste": _clean(effectif.get("codif_poste")),
        "mission_principale": _clean(effectif.get("mission_principale")),
        "perspectives_evolution": _clean(effectif.get("perspectives_evolution")),
        "statut_actif": bool(effectif.get("statut_actif", True)),
        "ismanager": bool(effectif.get("ismanager", False)),
        "isformateur": bool(effectif.get("isformateur", False)),
        "is_temp": bool(effectif.get("is_temp", False)),
    }


def _fetch_profile_context(cur, request: Request, id_effectif: str) -> tuple[dict, dict, dict]:
    profile = _require_profile(cur, request, id_effectif)
    effectif = _fetch_effectif_row(cur, profile)
    return profile, effectif, _profile_payload(profile, effectif)


def _level_rank(value: str) -> int:
    v = _clean(value).upper()
    if v in ("A", "APP", "APPRENTI", "APPRENTISSAGE"):
        return 1
    if v in ("B", "I", "INTERMEDIAIRE", "INTERMÉDIAIRE"):
        return 2
    if v in ("C", "AV", "AVANCE", "AVANCÉ", "AUTONOME", "EXPERT"):
        return 3
    return 0


def _competence_score(current_level: str, required_level: str) -> int:
    req = max(_level_rank(required_level), 1)
    cur = _level_rank(current_level)
    return int(min(100, round((cur / req) * 100))) if cur else 0


@router.get("/people/demo/profile/{id_effectif}")
def people_demo_profile(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, payload = _fetch_profile_context(cur, request, id_effectif)
        return {"profile": payload}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/profile error: {e}")


@router.get("/people/demo/dashboard/{id_effectif}")
def people_demo_dashboard(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""
                id_poste = profile.get("id_poste_actuel") or ""

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_effectif_client_competence ec
                    WHERE ec.id_effectif_client = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                    """,
                    (id_effectif,),
                )
                nb_comp = int((cur.fetchone() or {}).get("nb") or 0)

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_action_formation_effectif aef
                    JOIN public.tbl_action_formation af
                      ON af.id_action_formation = aef.id_action_formation
                     AND COALESCE(af.archive, FALSE) = FALSE
                    WHERE aef.id_effectif = %s
                      AND COALESCE(aef.archive, FALSE) = FALSE
                      AND COALESCE(af.date_fin_formation, af.date_debut_formation, CURRENT_DATE) >= CURRENT_DATE
                    """,
                    (id_effectif,),
                )
                nb_form = int((cur.fetchone() or {}).get("nb") or 0)

                cur.execute(
                    """
                    SELECT COUNT(*) AS nb
                    FROM public.tbl_effectif_client_break b
                    WHERE b.id_effectif = %s
                      AND COALESCE(b.archive, FALSE) = FALSE
                      AND b.date_fin >= CURRENT_DATE
                    """,
                    (id_effectif,),
                )
                nb_break = int((cur.fetchone() or {}).get("nb") or 0)

                mastery = 0
                current_poste_rows = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          pc.niveau_requis,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        LIMIT 8
                        """,
                        (id_effectif, id_poste),
                    )
                    current_poste_rows = cur.fetchall() or []
                    scores = [_competence_score(r.get("niveau_actuel"), r.get("niveau_requis")) for r in current_poste_rows]
                    mastery = int(round(sum(scores) / len(scores))) if scores else 0

                cur.execute(
                    """
                    SELECT MAX(a.date_audit) AS last_date
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                    WHERE ec.id_effectif_client = %s
                    """,
                    (id_effectif,),
                )
                last_audit = _clean((cur.fetchone() or {}).get("last_date"))

        return {
            "profile": profile,
            "kpis": {
                "nb_competences": nb_comp,
                "nb_formations_programmees": nb_form,
                "nb_indisponibilites": nb_break,
                "maitrise_poste": mastery,
                "derniere_evaluation": last_audit,
            },
            "competences_prioritaires": current_poste_rows,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/dashboard error: {e}")


@router.get("/people/demo/calendar/{id_effectif}")
def people_demo_calendar(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)

                cur.execute(
                    """
                    SELECT id_break, date_debut, date_fin
                    FROM public.tbl_effectif_client_break
                    WHERE id_effectif = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY date_debut DESC, date_fin DESC
                    LIMIT 30
                    """,
                    (id_effectif,),
                )
                breaks = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      aef.id_action_formation_effectif,
                      af.id_action_formation,
                      COALESCE(ff.titre, 'Formation programmée') AS titre,
                      COALESCE(ff.fournisseur_formation, '') AS organisme,
                      af.date_debut_formation,
                      af.date_fin_formation,
                      COALESCE(af.etat_action, '') AS etat_action,
                      COALESCE(aef.etat_invitation, '') AS etat_invitation,
                      COALESCE(aef.etat_attestation, '') AS etat_attestation
                    FROM public.tbl_action_formation_effectif aef
                    JOIN public.tbl_action_formation af
                      ON af.id_action_formation = aef.id_action_formation
                     AND COALESCE(af.archive, FALSE) = FALSE
                    LEFT JOIN public.tbl_fiche_formation ff
                      ON ff.id_form = af.id_form
                     AND ff.id_owner = %s
                     AND COALESCE(ff.archive, FALSE) = FALSE
                    WHERE aef.id_effectif = %s
                      AND COALESCE(aef.archive, FALSE) = FALSE
                    ORDER BY COALESCE(af.date_debut_formation, CURRENT_DATE) ASC
                    LIMIT 40
                    """,
                    (profile.get("id_owner") or "", id_effectif),
                )
                formations = cur.fetchall() or []

        return {"profile": profile, "indisponibilites": breaks, "formations": formations}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar error: {e}")


@router.post("/people/demo/calendar/{id_effectif}/breaks")
def people_demo_add_break(id_effectif: str, payload: PeopleBreakPayload, request: Request):
    date_debut = _parse_date(payload.date_debut, "date_debut")
    date_fin = _parse_date(payload.date_fin, "date_fin")
    if date_fin < date_debut:
        raise HTTPException(status_code=400, detail="La date de fin doit être postérieure ou égale à la date de début.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_break = _uuid()
                cur.execute(
                    """
                    INSERT INTO public.tbl_effectif_client_break
                      (id_break, id_ent, id_effectif, date_debut, date_fin, archive, date_creation, dernier_update)
                    VALUES
                      (%s, %s, %s, %s, %s, FALSE, NOW(), NOW())
                    RETURNING id_break, date_debut, date_fin
                    """,
                    (id_break, profile.get("id_owner") or "", id_effectif, date_debut, date_fin),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"created": row}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar/breaks error: {e}")


@router.post("/people/demo/calendar/{id_effectif}/breaks/{id_break}/archive")
def people_demo_archive_break(id_effectif: str, id_break: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                cur.execute(
                    """
                    UPDATE public.tbl_effectif_client_break
                    SET archive = TRUE,
                        dernier_update = NOW()
                    WHERE id_break = %s
                      AND id_effectif = %s
                      AND id_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    RETURNING id_break
                    """,
                    (id_break, id_effectif, profile.get("id_owner") or ""),
                )
                row = cur.fetchone() or {}
            conn.commit()
        return {"archived": bool(row), "id_break": id_break}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/calendar/archive error: {e}")


@router.get("/people/demo/parcours/{id_effectif}")
def people_demo_parcours(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT
                      hp.id_effectif_historique_poste,
                      hp.id_poste,
                      COALESCE(fp.intitule_poste, 'Poste') AS intitule_poste,
                      hp.date_debut,
                      hp.date_fin,
                      COALESCE(hp.commentaire, '') AS commentaire,
                      COALESCE(hp.source_changement, '') AS source_changement
                    FROM public.tbl_effectif_client_historique_poste hp
                    LEFT JOIN public.tbl_fiche_poste fp
                      ON fp.id_poste = hp.id_poste
                     AND fp.id_owner = %s
                     AND COALESCE(fp.actif, TRUE) = TRUE
                    WHERE hp.id_effectif = %s
                      AND COALESCE(hp.archive, FALSE) = FALSE
                    ORDER BY COALESCE(hp.date_debut, CURRENT_DATE) ASC, hp.date_creation ASC
                    """,
                    (id_owner, id_effectif),
                )
                postes = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      a.date_audit,
                      a.resultat_eval,
                      COALESCE(a.methode_eval, '') AS methode_eval
                    FROM public.tbl_effectif_client_audit_competence a
                    JOIN public.tbl_effectif_client_competence ec
                      ON ec.id_effectif_competence = a.id_effectif_competence
                     AND ec.id_effectif_client = %s
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE a.resultat_eval IS NOT NULL
                    ORDER BY a.date_audit ASC, c.intitule ASC
                    LIMIT 240
                    """,
                    (id_effectif,),
                )
                audits = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      hf.id_historique_formation,
                      hf.date_formation,
                      hf.date_debut_formation,
                      hf.date_fin_formation,
                      hf.intitule,
                      COALESCE(hf.organisme, '') AS organisme,
                      COALESCE(hf.source, '') AS source
                    FROM public.tbl_effectif_client_historique_formation hf
                    WHERE hf.id_effectif = %s
                      AND hf.id_ent = %s
                      AND COALESCE(hf.archive, FALSE) = FALSE
                    ORDER BY hf.date_formation DESC
                    LIMIT 20
                    """,
                    (id_effectif, id_owner),
                )
                formations = cur.fetchall() or []

        return {"profile": profile, "postes": postes, "audits": audits, "formations": formations}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/parcours error: {e}")


@router.get("/people/demo/competences/{id_effectif}")
def people_demo_competences(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_poste = profile.get("id_poste_actuel") or ""

                current = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                          pc.niveau_requis,
                          COALESCE(pc.poids_criticite, 0) AS criticite,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                          ec.date_derniere_eval
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_domaine_competence dc
                          ON dc.id_domaine_competence = c.domaine
                         AND COALESCE(dc.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        """,
                        (id_effectif, id_poste),
                    )
                    current = cur.fetchall() or []

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                      ec.date_derniere_eval
                    FROM public.tbl_effectif_client_competence ec
                    JOIN public.tbl_competence c
                      ON c.id_comp = ec.id_comp
                     AND COALESCE(c.masque, FALSE) = FALSE
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE ec.id_effectif_client = %s
                      AND COALESCE(ec.archive, FALSE) = FALSE
                      AND COALESCE(ec.actif, TRUE) = TRUE
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_fiche_poste_competence pc
                        WHERE pc.id_poste = %s
                          AND pc.id_competence = ec.id_comp
                          AND COALESCE(pc.masque, FALSE) = FALSE
                      )
                    ORDER BY c.intitule
                    """,
                    (id_effectif, id_poste or ""),
                )
                autres = cur.fetchall() or []

        return {"profile": profile, "poste": current, "autres": autres}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences error: {e}")


@router.get("/people/demo/competences/{id_effectif}/catalogue")
def people_demo_catalogue(id_effectif: str, request: Request, q: str = ""):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""
                id_poste = profile.get("id_poste_actuel") or ""
                search = f"%{_clean(q).lower()}%"

                cur.execute(
                    """
                    SELECT
                      c.id_comp,
                      c.code,
                      c.intitule,
                      COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                      COALESCE(c.description, '') AS description
                    FROM public.tbl_competence c
                    LEFT JOIN public.tbl_domaine_competence dc
                      ON dc.id_domaine_competence = c.domaine
                     AND COALESCE(dc.masque, FALSE) = FALSE
                    WHERE c.id_owner = %s
                      AND COALESCE(c.masque, FALSE) = FALSE
                      AND COALESCE(c.etat, 'active') NOT IN ('archivée', 'archive', 'inactive')
                      AND (
                        %s = '%%'
                        OR lower(COALESCE(c.code, '')) LIKE %s
                        OR lower(COALESCE(c.intitule, '')) LIKE %s
                        OR lower(COALESCE(c.description, '')) LIKE %s
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_effectif_client_competence ec
                        WHERE ec.id_effectif_client = %s
                          AND ec.id_comp = c.id_comp
                          AND COALESCE(ec.archive, FALSE) = FALSE
                          AND COALESCE(ec.actif, TRUE) = TRUE
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM public.tbl_fiche_poste_competence pc
                        WHERE pc.id_poste = %s
                          AND pc.id_competence = c.id_comp
                          AND COALESCE(pc.masque, FALSE) = FALSE
                      )
                    ORDER BY c.intitule
                    LIMIT 80
                    """,
                    (id_owner, search, search, search, search, id_effectif, id_poste or ""),
                )
                rows = cur.fetchall() or []
        return {"items": rows}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences/catalogue error: {e}")


@router.post("/people/demo/competences/{id_effectif}/add")
def people_demo_add_competence(id_effectif: str, payload: PeopleAddCompetencePayload, request: Request):
    id_comp = _clean(payload.id_comp)
    if not id_comp:
        raise HTTPException(status_code=400, detail="Compétence manquante.")

    niveau = _clean(payload.niveau_actuel).upper()
    if niveau not in ("", "A", "B", "C"):
        niveau = ""

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_owner = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT id_comp
                    FROM public.tbl_competence
                    WHERE id_comp = %s
                      AND id_owner = %s
                      AND COALESCE(masque, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (id_comp, id_owner),
                )
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="Compétence introuvable dans le catalogue.")

                cur.execute(
                    """
                    SELECT id_effectif_competence
                    FROM public.tbl_effectif_client_competence
                    WHERE id_effectif_client = %s
                      AND id_comp = %s
                    LIMIT 1
                    """,
                    (id_effectif, id_comp),
                )
                existing = cur.fetchone() or {}
                if existing:
                    cur.execute(
                        """
                        UPDATE public.tbl_effectif_client_competence
                        SET actif = TRUE,
                            archive = FALSE,
                            niveau_actuel = COALESCE(NULLIF(%s, ''), niveau_actuel),
                            date_derniere_eval = COALESCE(date_derniere_eval, CURRENT_DATE)
                        WHERE id_effectif_competence = %s
                        RETURNING id_effectif_competence
                        """,
                        (niveau, existing.get("id_effectif_competence")),
                    )
                    row = cur.fetchone() or {}
                else:
                    id_ec = _uuid()
                    cur.execute(
                        """
                        INSERT INTO public.tbl_effectif_client_competence
                          (id_effectif_competence, id_effectif_client, id_comp, niveau_actuel, date_derniere_eval, actif, archive)
                        VALUES
                          (%s, %s, %s, NULLIF(%s, ''), CURRENT_DATE, TRUE, FALSE)
                        RETURNING id_effectif_competence
                        """,
                        (id_ec, id_effectif, id_comp, niveau),
                    )
                    row = cur.fetchone() or {}
            conn.commit()
        return {"added": row}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/competences/add error: {e}")


@router.get("/people/demo/auto-evaluation/{id_effectif}")
def people_demo_auto_eval(id_effectif: str, request: Request):
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_poste = profile.get("id_poste_actuel") or ""

                cur.execute(
                    """
                    SELECT id_entretien, statut, date_prevue, preparation
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    ORDER BY
                      CASE
                        WHEN statut IN ('à réaliser', 'en cours', 'à signer 1/2') THEN 0
                        ELSE 1
                      END,
                      updated_at DESC,
                      created_at DESC
                    LIMIT 1
                    """,
                    (profile.get("id_owner") or "", id_effectif),
                )
                entretien = cur.fetchone() or {}

                items = []
                if id_poste:
                    cur.execute(
                        """
                        SELECT
                          c.id_comp,
                          c.code,
                          c.intitule,
                          COALESCE(dc.titre_court, dc.titre, c.domaine, '') AS domaine,
                          pc.niveau_requis,
                          COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
                          COALESCE(c.description, '') AS description
                        FROM public.tbl_fiche_poste_competence pc
                        JOIN public.tbl_competence c
                          ON c.id_comp = pc.id_competence
                         AND COALESCE(c.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_domaine_competence dc
                          ON dc.id_domaine_competence = c.domaine
                         AND COALESCE(dc.masque, FALSE) = FALSE
                        LEFT JOIN public.tbl_effectif_client_competence ec
                          ON ec.id_effectif_client = %s
                         AND ec.id_comp = c.id_comp
                         AND COALESCE(ec.archive, FALSE) = FALSE
                         AND COALESCE(ec.actif, TRUE) = TRUE
                        WHERE pc.id_poste = %s
                          AND COALESCE(pc.masque, FALSE) = FALSE
                        ORDER BY COALESCE(pc.poids_criticite, 0) DESC, c.intitule
                        """,
                        (id_effectif, id_poste),
                    )
                    items = cur.fetchall() or []

        prep = entretien.get("preparation") or {}
        if not isinstance(prep, dict):
            prep = {}
        return {
            "profile": profile,
            "entretien": {
                "id_entretien": entretien.get("id_entretien") or "",
                "statut": entretien.get("statut") or "",
                "date_prevue": _clean(entretien.get("date_prevue")),
                "auto_evaluation_people": prep.get("auto_evaluation_people") or {},
            },
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/auto-evaluation error: {e}")


@router.post("/people/demo/auto-evaluation/{id_effectif}/save")
def people_demo_save_auto_eval(id_effectif: str, payload: PeopleAutoEvalPayload, request: Request):
    clean_items = []
    for item in payload.items or []:
        cid = _clean(item.id_comp)
        if not cid:
            continue
        niv = _clean(item.niveau_auto).upper()
        if niv not in ("A", "B", "C", ""):
            niv = ""
        clean_items.append({
            "id_comp": cid,
            "niveau_auto": niv,
            "commentaire": _clean(item.commentaire),
            "besoin_accompagnement": bool(item.besoin_accompagnement),
        })

    auto_payload = {
        "date_saisie": date.today().isoformat(),
        "commentaire_general": _clean(payload.commentaire_general),
        "items": clean_items,
    }

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, _, profile = _fetch_profile_context(cur, request, id_effectif)
                id_ent = profile.get("id_owner") or ""

                cur.execute(
                    """
                    SELECT id_entretien
                    FROM public.tbl_entretien_individuel
                    WHERE id_ent = %s
                      AND id_effectif_client = %s
                      AND COALESCE(archive, FALSE) = FALSE
                      AND statut IN ('à réaliser', 'en cours', 'à signer 1/2')
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 1
                    """,
                    (id_ent, id_effectif),
                )
                ent = cur.fetchone() or {}
                if ent.get("id_entretien"):
                    id_entretien = ent.get("id_entretien")
                    cur.execute(
                        """
                        UPDATE public.tbl_entretien_individuel
                        SET preparation = COALESCE(preparation, '{}'::jsonb) || %s::jsonb,
                            updated_at = NOW()
                        WHERE id_entretien = %s
                        RETURNING id_entretien
                        """,
                        (Json({"auto_evaluation_people": auto_payload}), id_entretien),
                    )
                else:
                    id_entretien = _uuid()
                    cur.execute(
                        """
                        INSERT INTO public.tbl_entretien_individuel
                          (id_entretien, id_ent, id_effectif_client, type_entretien, statut, date_prevue,
                           bilan, objectifs, developpement, plan_actions, documents, synthese,
                           preparation, realisation, competences_entretien, archive, created_at, updated_at)
                        VALUES
                          (%s, %s, %s, 'Entretien individuel', 'à réaliser', CURRENT_DATE,
                           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                           %s::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE, NOW(), NOW())
                        RETURNING id_entretien
                        """,
                        (id_entretien, id_ent, id_effectif, Json({"auto_evaluation_people": auto_payload})),
                    )
                row = cur.fetchone() or {}
            conn.commit()
        return {"saved": True, "id_entretien": row.get("id_entretien") or id_entretien}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"people/demo/auto-evaluation/save error: {e}")
