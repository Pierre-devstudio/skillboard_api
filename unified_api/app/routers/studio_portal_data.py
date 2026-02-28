from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner

router = APIRouter()


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


def _fetch_org(cur, oid: str) -> dict:
    """
    Règle:
    - si tbl_mon_entreprise contient une fiche active avec id_mon_ent = oid => on l'utilise (cas "mon entreprise")
    - sinon => tbl_entreprise (id_ent = oid) + filtre COALESCE(masque,FALSE)=FALSE
    """
    cur.execute(
        """
        SELECT
          nom_ent,
          adresse_ent, adresse_cplt_ent, cp_ent, ville_ent, pays_ent,
          email_ent, telephone_ent, site_web,
          siret_ent, code_ape_ent, num_tva_ent,
          effectif_ent, date_creation, num_entreprise, type_entreprise,
          idcc, nom_groupe, type_groupe, tete_groupe, group_ok, contrat_skills
        FROM public.tbl_mon_entreprise
        WHERE id_mon_ent = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    mon = cur.fetchone()
    if mon:
        return {
            "nom_ent": mon.get("nom_ent"),
            "adresse_ent": mon.get("adresse_ent"),
            "adresse_cplt_ent": mon.get("adresse_cplt_ent"),
            "cp_ent": mon.get("cp_ent"),
            "ville_ent": mon.get("ville_ent"),
            "pays_ent": mon.get("pays_ent"),
            "email_ent": mon.get("email_ent"),
            "telephone_ent": mon.get("telephone_ent"),
            "site_web": mon.get("site_web"),
            "siret_ent": mon.get("siret_ent"),
            "code_ape_ent": mon.get("code_ape_ent"),
            "num_tva_ent": mon.get("num_tva_ent"),
            "effectif_ent": mon.get("effectif_ent"),
            "date_creation": mon.get("date_creation"),
            "num_entreprise": mon.get("num_entreprise"),
            "type_entreprise": mon.get("type_entreprise"),
            "idcc": mon.get("idcc"),
            "nom_groupe": mon.get("nom_groupe"),
            "type_groupe": mon.get("type_groupe"),
            "tete_groupe": mon.get("tete_groupe"),
            "group_ok": mon.get("group_ok"),
            "contrat_skills": mon.get("contrat_skills"),
        }

    cur.execute(
        """
        SELECT
          nom_ent,
          adresse_ent, adresse_cplt_ent, cp_ent, ville_ent, pays_ent,
          email_ent, telephone_ent, site_web,
          siret_ent, code_ape_ent, num_tva_ent,
          effectif_ent, date_creation, num_entreprise, type_entreprise,
          idcc, nom_groupe, type_groupe, tete_groupe, group_ok, contrat_skills
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (oid,),
    )
    ent = cur.fetchone()
    if not ent:
        raise HTTPException(status_code=404, detail="Entreprise introuvable ou masquée.")

    return {
        "nom_ent": ent.get("nom_ent"),
        "adresse_ent": ent.get("adresse_ent"),
        "adresse_cplt_ent": ent.get("adresse_cplt_ent"),
        "cp_ent": ent.get("cp_ent"),
        "ville_ent": ent.get("ville_ent"),
        "pays_ent": ent.get("pays_ent"),
        "email_ent": ent.get("email_ent"),
        "telephone_ent": ent.get("telephone_ent"),
        "site_web": ent.get("site_web"),
        "siret_ent": ent.get("siret_ent"),
        "code_ape_ent": ent.get("code_ape_ent"),
        "num_tva_ent": ent.get("num_tva_ent"),
        "effectif_ent": ent.get("effectif_ent"),
        "date_creation": ent.get("date_creation"),
        "num_entreprise": ent.get("num_entreprise"),
        "type_entreprise": ent.get("type_entreprise"),
        "idcc": ent.get("idcc"),
        "nom_groupe": ent.get("nom_groupe"),
        "type_groupe": ent.get("type_groupe"),
        "tete_groupe": ent.get("tete_groupe"),
        "group_ok": ent.get("group_ok"),
        "contrat_skills": ent.get("contrat_skills"),
    }


def _fetch_contact(cur, oid: str, email_session: str) -> dict:
    """
    Contact connecté: résolu via tbl_studio_user_access (email + owner).
    On retourne une fiche "vendable" (pas d'IDs internes).
    """
    email = (email_session or "").strip()

    cur.execute(
        """
        SELECT user_ref_type, id_user_ref
        FROM public.tbl_studio_user_access
        WHERE lower(email) = lower(%s)
          AND id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        LIMIT 1
        """,
        (email, oid),
    )
    m = cur.fetchone() or {}
    ref_type = (m.get("user_ref_type") or "").strip().lower()
    ref_id = (m.get("id_user_ref") or "").strip()

    # Fallback minimal si mapping absent
    if not ref_type or not ref_id:
        return {
            "civilite": None,
            "prenom": None,
            "nom": None,
            "email": email or None,
            "telephone": None,
            "fonction": None,
            "adresse": None,
            "cp": None,
            "ville": None,
            "pays": None,
        }

    if ref_type == "utilisateur":
        cur.execute(
            """
            SELECT
              ut_civilite,
              ut_prenom, ut_nom, ut_mail, ut_tel,
              ut_fonction,
              ut_adresse, ut_cp, ut_ville, ut_pays,
              actif
            FROM public.tbl_utilisateur
            WHERE id_utilisateur = %s
              AND COALESCE(archive, FALSE) = FALSE
            LIMIT 1
            """,
            (ref_id,),
        )
        r = cur.fetchone() or {}
        return {
            "civilite": r.get("ut_civilite"),
            "prenom": r.get("ut_prenom"),
            "nom": r.get("ut_nom"),
            "email": (r.get("ut_mail") or email) if (r.get("ut_mail") or "").strip() else (email or None),
            "telephone": r.get("ut_tel"),
            "fonction": r.get("ut_fonction"),
            "adresse": r.get("ut_adresse"),
            "cp": r.get("ut_cp"),
            "ville": r.get("ut_ville"),
            "pays": r.get("ut_pays"),
            "actif": r.get("actif"),
        }

    if ref_type == "effectif_client":
        cur.execute(
            """
            SELECT
              civilite_effectif,
              prenom_effectif, nom_effectif,
              email_effectif, telephone_effectif,
              adresse_effectif, code_postal_effectif, ville_effectif, pays_effectif,
              date_naissance_effectif,
              niveau_education, domaine_education,
              type_contrat, matricule_interne,
              business_travel,
              date_entree_entreprise_effectif, date_sortie_prevue,
              statut_actif, motif_sortie,
              ismanager, isformateur, is_temp, role_temp,
              code_effectif,
              note_commentaire
            FROM public.tbl_effectif_client
            WHERE id_effectif = %s
              AND COALESCE(archive, FALSE) = FALSE
            LIMIT 1
            """,
            (ref_id,),
        )
        r = cur.fetchone() or {}
        return {
            "civilite": r.get("civilite_effectif"),
            "prenom": r.get("prenom_effectif"),
            "nom": r.get("nom_effectif"),
            "email": r.get("email_effectif") or (email or None),
            "telephone": r.get("telephone_effectif"),
            "adresse": r.get("adresse_effectif"),
            "cp": r.get("code_postal_effectif"),
            "ville": r.get("ville_effectif"),
            "pays": r.get("pays_effectif"),
            "date_naissance": r.get("date_naissance_effectif"),
            "niveau_education": r.get("niveau_education"),
            "domaine_education": r.get("domaine_education"),
            "type_contrat": r.get("type_contrat"),
            "matricule_interne": r.get("matricule_interne"),
            "business_travel": r.get("business_travel"),
            "date_entree": r.get("date_entree_entreprise_effectif"),
            "date_sortie_prevue": r.get("date_sortie_prevue"),
            "statut_actif": r.get("statut_actif"),
            "motif_sortie": r.get("motif_sortie"),
            "ismanager": r.get("ismanager"),
            "isformateur": r.get("isformateur"),
            "is_temp": r.get("is_temp"),
            "role_temp": r.get("role_temp"),
            "code_effectif": r.get("code_effectif"),
            "note_commentaire": r.get("note_commentaire"),
        }

    # Type inconnu => fallback minimal
    return {
        "civilite": None,
        "prenom": None,
        "nom": None,
        "email": email or None,
        "telephone": None,
        "fonction": None,
        "adresse": None,
        "cp": None,
        "ville": None,
        "pays": None,
    }


@router.get("/studio/data/{id_owner}")
def get_studio_vos_donnees(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)

                # Vérifie que l'owner Studio existe (tbl_studio_owner, archive=FALSE)
                studio_fetch_owner(cur, oid)

                org = _fetch_org(cur, oid)
                contact = _fetch_contact(cur, oid, (u.get("email") or "").strip())

        return {"organisation": org, "contact": contact}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data error: {e}")