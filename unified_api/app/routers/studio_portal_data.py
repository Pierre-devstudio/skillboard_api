from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import Response
from psycopg.rows import dict_row
from pydantic import BaseModel
from typing import Optional, Dict, Any
import os
import re
import uuid

from app.routers.skills_portal_common import get_conn
from app.routers.studio_portal_common import studio_require_user, studio_fetch_owner, studio_require_min_role

router = APIRouter()

RE_APE = re.compile(r"^\d{2}\.\d{2}$")

LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_ALLOWED_EXTS = {".png", ".jpg", ".jpeg"}


def _clean_text(v: Any) -> str:
    return str(v or "").strip()


def _logo_ext(filename: Optional[str]) -> str:
    return os.path.splitext(_clean_text(filename).lower())[1]


def _sniff_logo_mime(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return ""


def _validate_logo_upload(filename: Optional[str], content_type: Optional[str], raw: bytes) -> str:
    ext = _logo_ext(filename)

    if ext not in LOGO_ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="Format logo non supporté. Utilise un fichier PNG ou JPG.")

    if not raw:
        raise HTTPException(status_code=400, detail="Fichier logo vide.")

    if len(raw) > LOGO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Logo trop volumineux. Limite : 2 Mo.")

    sniff = _sniff_logo_mime(raw)
    if not sniff:
        raise HTTPException(status_code=400, detail="Image logo invalide. Utilise un PNG ou un JPG.")

    if ext == ".png" and sniff != "image/png":
        raise HTTPException(status_code=400, detail="Extension .png incohérente avec le fichier envoyé.")

    if ext in {".jpg", ".jpeg"} and sniff != "image/jpeg":
        raise HTTPException(status_code=400, detail="Extension .jpg/.jpeg incohérente avec le fichier envoyé.")

    declared = _clean_text(content_type).lower()
    if declared == "image/jpg":
        declared = "image/jpeg"

    if declared and declared not in {"image/png", "image/jpeg", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Type MIME logo non supporté. Utilise un PNG ou un JPG.")

    return sniff


def _fetch_owner_logo_row(cur, oid: str) -> dict | None:
    cur.execute(
        """
        SELECT
            id_logo,
            filename_original,
            mime_type,
            logo_bytes,
            taille_bytes,
            date_maj
        FROM public.tbl_studio_owner_logo
        WHERE id_owner = %s
          AND COALESCE(archive, FALSE) = FALSE
        ORDER BY date_maj DESC, date_creation DESC
        LIMIT 1
        """,
        (oid,),
    )
    return cur.fetchone() or None


def _fetch_owner_logo_meta(cur, oid: str) -> dict:
    row = _fetch_owner_logo_row(cur, oid)
    if not row:
        return {
            "has_logo": False,
            "filename": None,
            "mime_type": None,
            "size_bytes": 0,
            "date_maj": None,
        }

    dt = row.get("date_maj")
    return {
        "has_logo": True,
        "filename": row.get("filename_original"),
        "mime_type": row.get("mime_type"),
        "size_bytes": int(row.get("taille_bytes") or 0),
        "date_maj": dt.isoformat() if dt else None,
    }


def _fetch_owner_logo_bytes(cur, oid: str) -> bytes | None:
    row = _fetch_owner_logo_row(cur, oid)
    if not row:
        return None

    raw = row.get("logo_bytes")
    if raw is None:
        return None

    try:
        return bytes(raw)
    except Exception:
        return raw

class UpdateEntreprisePayload(BaseModel):
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
    idcc: Optional[str] = None
    id_opco: Optional[str] = None


class UpdateContactPayload(BaseModel):
    civilite: Optional[str] = None
    prenom: Optional[str] = None
    nom: Optional[str] = None
    email: Optional[str] = None
    telephone: Optional[str] = None
    telephone2: Optional[str] = None
    observations: Optional[str] = None
    # role: lecture seule (tbl_studio_user_access.role_code) => NON modifiable ici


def _build_patch_set(payload) -> Dict[str, Any]:
    fields = payload.__fields_set__ or set()
    data = payload.dict()
    return {k: data.get(k) for k in fields}


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

def _role_code_to_label(code: str | None) -> str | None:
    c = (code or "").strip().lower()
    if c == "admin":
        return "Administrateur"
    if c == "editor":
        return "Éditeur"
    if c == "user":
        return "Utilisateur"
    return None

def _normalize_civilite(value: str | None) -> str | None:
    s = (value or "").strip()
    if not s:
        return None

    sl = s.lower()
    if sl in {"m", "m."}:
        return "M."
    if sl in {"f", "mme", "mme.", "madame"}:
        return "Mme"

    return s

def _lookup_idcc(cur, idcc: str | None) -> str | None:
    if not idcc:
        return None
    cur.execute(
        """
        SELECT libelle
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        """,
        (idcc,),
    )
    r = cur.fetchone()
    return r.get("libelle") if r else None


def _lookup_ape(cur, code_ape: str | None) -> str | None:
    if not code_ape:
        return None
    cur.execute(
        """
        SELECT intitule_ape
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        """,
        (code_ape,),
    )
    r = cur.fetchone()
    return r.get("intitule_ape") if r else None


def _lookup_opco(cur, id_opco: str | None) -> str | None:
    if not id_opco:
        return None
    cur.execute(
        """
        SELECT nom_opco
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (id_opco,),
    )
    r = cur.fetchone()
    return r.get("nom_opco") if r else None

def _require_owner_access(cur, u: dict, id_owner: str):
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
    ok = cur.fetchone()
    if not ok:
        raise HTTPException(status_code=403, detail="Accès refusé (owner non autorisé).")

    return oid


def _require_client_structure_access(cur, u: dict, id_owner: str, id_ent: str) -> tuple[str, str]:
    oid = _require_owner_access(cur, u, id_owner)
    studio_fetch_owner(cur, oid)

    ent = (id_ent or "").strip()
    if not ent:
        raise HTTPException(status_code=400, detail="id_ent manquant.")

    cur.execute(
        """
        SELECT 1
        FROM public.tbl_entreprise
        WHERE id_ent = %s
          AND id_owner_gestionnaire = %s
          AND COALESCE(masque, FALSE) = FALSE
        LIMIT 1
        """,
        (ent, oid),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Structure cliente introuvable ou masquée.")

    return oid, ent


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
          idcc, id_opco, nom_groupe, type_groupe, tete_groupe, group_ok, contrat_skills
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
            "id_opco": mon.get("id_opco"),
            "nom_groupe": mon.get("nom_groupe"),
            "type_groupe": mon.get("type_groupe"),
            "tete_groupe": mon.get("tete_groupe"),
            "group_ok": mon.get("group_ok"),
            "contrat_skills": mon.get("contrat_skills"),
            "idcc_libelle": _lookup_idcc(cur, mon.get("idcc")),
            "code_ape_intitule": _lookup_ape(cur, mon.get("code_ape_ent")),
            "opco_nom": _lookup_opco(cur, mon.get("id_opco")),
        }

    cur.execute(
        """
        SELECT
          nom_ent,
          adresse_ent, adresse_cplt_ent, cp_ent, ville_ent, pays_ent,
          email_ent, telephone_ent, site_web,
          siret_ent, code_ape_ent, num_tva_ent,
          effectif_ent, date_creation, num_entreprise, type_entreprise,
          idcc, id_opco, nom_groupe, type_groupe, tete_groupe, group_ok, contrat_skills
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
        "id_opco": ent.get("id_opco"),
        "idcc_libelle": _lookup_idcc(cur, ent.get("idcc")),
        "code_ape_intitule": _lookup_ape(cur, ent.get("code_ape_ent")),
        "opco_nom": _lookup_opco(cur, ent.get("id_opco")),
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
        SELECT user_ref_type, id_user_ref, role_code
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
    m = cur.fetchone() or {}
    ref_type = (m.get("user_ref_type") or "").strip().lower()
    ref_id = (m.get("id_user_ref") or "").strip()
    role_label = _role_code_to_label(m.get("role_code"))

    # Fallback minimal si mapping absent
    if not ref_type or not ref_id:
        return {
            "civilite": None,
            "prenom": None,
            "nom": None,
            "email": email or None,
            "telephone": None,
            "telephone2": None,
            "observations": None,
            "role": role_label,            
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
                ut_prenom, ut_nom, ut_mail, ut_tel, ut_tel2,
                ut_obs,
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
            "civilite": _normalize_civilite(r.get("ut_civilite")),
            "prenom": r.get("ut_prenom"),
            "nom": r.get("ut_nom"),
            "email": (r.get("ut_mail") or email) if (r.get("ut_mail") or "").strip() else (email or None),
            "telephone": r.get("ut_tel"),
            "telephone2": r.get("ut_tel2"),
            "observations": r.get("ut_obs"),
            "role": role_label,
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
              email_effectif, telephone_effectif, telephone2_effectif,
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
            "civilite": _normalize_civilite(r.get("civilite_effectif")),
            "prenom": r.get("prenom_effectif"),
            "nom": r.get("nom_effectif"),
            "email": r.get("email_effectif") or (email or None),
            "telephone": r.get("telephone_effectif"),
            "telephone2": r.get("telephone2_effectif"),
            "observations": r.get("note_commentaire"),
            "role": role_label,
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
        "telephone2": None,
        "observations": None,
        "role": role_label,
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
                org["logo"] = _fetch_owner_logo_meta(cur, oid)
                contact = _fetch_contact(cur, oid, (u.get("email") or "").strip())

        return {"organisation": org, "contact": contact}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data error: {e}")
    
@router.post("/studio/data/entreprise/{id_owner}")
def update_studio_entreprise(id_owner: str, payload: UpdateEntreprisePayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)

        if "civilite" in patch:
            patch["civilite"] = _normalize_civilite(patch.get("civilite"))
            
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)

                # périmètre Studio (owner doit exister)
                studio_fetch_owner(cur, oid)

                # Entreprise = admin only
                studio_require_min_role(cur, u, oid, "admin")

                # validations référentiels (uniquement si champs présents)
                if "idcc" in patch:
                    _validate_idcc_exists(cur, patch.get("idcc"))
                if "code_ape_ent" in patch:
                    _validate_ape_exists(cur, patch.get("code_ape_ent"))
                if "id_opco" in patch:
                    _validate_opco_exists(cur, patch.get("id_opco"))

                # cible: mon entreprise si existe, sinon entreprise client
                cur.execute(
                    """
                    SELECT 1
                    FROM public.tbl_mon_entreprise
                    WHERE id_mon_ent = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    LIMIT 1
                    """,
                    (oid,),
                )
                is_mon = cur.fetchone() is not None

                if not is_mon:
                    cur.execute(
                        """
                        SELECT 1
                        FROM public.tbl_entreprise
                        WHERE id_ent = %s
                          AND COALESCE(masque, FALSE) = FALSE
                        LIMIT 1
                        """,
                        (oid,),
                    )
                    if cur.fetchone() is None:
                        raise HTTPException(status_code=404, detail="Entreprise introuvable ou masquée.")

                # UPDATE patch
                if patch:
                    allowed = {
                        "adresse_ent","adresse_cplt_ent","cp_ent","ville_ent","pays_ent",
                        "email_ent","telephone_ent","site_web",
                        "siret_ent","code_ape_ent","num_tva_ent","idcc","id_opco",
                    }
                    cols = []
                    vals = []
                    for k, v in patch.items():
                        if k not in allowed:
                            continue
                        cols.append(f"{k} = %s")
                        vals.append(v)

                    if cols:
                        vals.append(oid)
                        if is_mon:
                            cur.execute(
                                f"""
                                UPDATE public.tbl_mon_entreprise
                                SET {", ".join(cols)},
                                    dernier_update = NOW()
                                WHERE id_mon_ent = %s
                                  AND COALESCE(archive, FALSE) = FALSE
                                """,
                                tuple(vals),
                            )
                        else:
                            cur.execute(
                                f"""
                                UPDATE public.tbl_entreprise
                                SET {", ".join(cols)}
                                WHERE id_ent = %s
                                  AND COALESCE(masque, FALSE) = FALSE
                                """,
                                tuple(vals),
                            )

                        conn.commit()

                org = _fetch_org(cur, oid)
                org["logo"] = _fetch_owner_logo_meta(cur, oid)
                ct = _fetch_contact(cur, oid, (u.get("email") or "").strip())

        return {"organisation": org, "contact": ct}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/entreprise error: {e}")
    
@router.post("/studio/data/contact/{id_owner}")
def update_studio_contact(id_owner: str, payload: UpdateContactPayload, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        patch = _build_patch_set(payload)

        # règles minimales (vendable + cohérent)
        if "nom" in patch:
            if patch.get("nom") is None or str(patch.get("nom") or "").strip() == "":
                raise HTTPException(status_code=400, detail="Le nom du contact est obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                email = (u.get("email") or "").strip()
                cur.execute(
                    """
                    SELECT user_ref_type, id_user_ref
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
                m = cur.fetchone() or {}
                ref_type = (m.get("user_ref_type") or "").strip().lower()
                ref_id = (m.get("id_user_ref") or "").strip()
                if not ref_type or not ref_id:
                    raise HTTPException(status_code=404, detail="Contact non rattaché (mapping Studio absent).")

                if patch:
                    # rôle = lecture seule => ignoré même si un front l'envoie (sécurité)
                    patch.pop("role", None)

                    if ref_type == "effectif_client":
                        # tbl_effectif_client: nom/prenom NOT NULL => si présents dans patch, pas de null/vides
                        if "prenom" in patch and (patch.get("prenom") is None or str(patch.get("prenom") or "").strip() == ""):
                            raise HTTPException(status_code=400, detail="Le prénom du contact est obligatoire.")

                        mapping = {
                            "civilite": "civilite_effectif",
                            "prenom": "prenom_effectif",
                            "nom": "nom_effectif",
                            "email": "email_effectif",
                            "telephone": "telephone_effectif",
                            "telephone2": "telephone2_effectif",
                            "observations": "note_commentaire",
                        }

                        cols, vals = [], []
                        for k, v in patch.items():
                            col = mapping.get(k)
                            if not col:
                                continue
                            cols.append(f"{col} = %s")
                            vals.append(v)

                        if cols:
                            vals.extend([ref_id, oid])
                            cur.execute(
                                f"""
                                UPDATE public.tbl_effectif_client
                                SET {", ".join(cols)},
                                    dernier_update = NOW()
                                WHERE id_effectif = %s
                                  AND id_ent = %s
                                  AND COALESCE(archive, FALSE) = FALSE
                                """,
                                tuple(vals),
                            )
                            conn.commit()

                    elif ref_type == "utilisateur":
                        mapping = {
                            "civilite": "ut_civilite",
                            "prenom": "ut_prenom",
                            "nom": "ut_nom",
                            "email": "ut_mail",
                            "telephone": "ut_tel",
                            "telephone2": "ut_tel2",
                            "observations": "ut_obs",
                        }

                        cols, vals = [], []
                        for k, v in patch.items():
                            col = mapping.get(k)
                            if not col:
                                continue
                            cols.append(f"{col} = %s")
                            vals.append(v)

                        if cols:
                            vals.append(ref_id)
                            cur.execute(
                                f"""
                                UPDATE public.tbl_utilisateur
                                SET {", ".join(cols)},
                                    dernier_update = NOW()
                                WHERE id_utilisateur = %s
                                  AND COALESCE(archive, FALSE) = FALSE
                                """,
                                tuple(vals),
                            )
                            conn.commit()

                    else:
                        raise HTTPException(status_code=400, detail="Type de rattachement contact inconnu.")

                org = _fetch_org(cur, oid)
                org["logo"] = _fetch_owner_logo_meta(cur, oid)
                ct = _fetch_contact(cur, oid, email)

        return {"organisation": org, "contact": ct}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/contact error: {e}")


@router.get("/studio/data/logo/{id_owner}")
def get_studio_owner_logo(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)

                row = _fetch_owner_logo_row(cur, oid)
                if not row:
                    raise HTTPException(status_code=404, detail="Aucun logo enregistré.")

                raw = _fetch_owner_logo_bytes(cur, oid)
                if not raw:
                    raise HTTPException(status_code=404, detail="Aucun logo enregistré.")

                filename = _clean_text(row.get("filename_original")) or "logo.png"
                mime_type = _clean_text(row.get("mime_type")) or "application/octet-stream"

        return Response(
            content=raw,
            media_type=mime_type,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/logo GET error: {e}")


@router.post("/studio/data/logo/{id_owner}")
def upload_studio_owner_logo(id_owner: str, request: Request, file: UploadFile = File(...)):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        oid = (id_owner or "").strip()
        filename = _clean_text(getattr(file, "filename", "") or "logo")
        content_type = _clean_text(getattr(file, "content_type", ""))
        raw = file.file.read() if file and file.file else b""

        mime_type = _validate_logo_upload(filename, content_type, raw)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, oid)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_studio_owner_logo
                    SET archive = TRUE,
                        date_maj = NOW()
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid,),
                )

                id_logo = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_studio_owner_logo
                        (id_logo, id_owner, filename_original, mime_type, logo_bytes, taille_bytes, date_creation, date_maj, archive)
                    VALUES
                        (%s, %s, %s, %s, %s, %s, NOW(), NOW(), FALSE)
                    """,
                    (
                        id_logo,
                        oid,
                        filename or None,
                        mime_type,
                        raw,
                        len(raw),
                    ),
                )

                conn.commit()
                logo = _fetch_owner_logo_meta(cur, oid)

        return {"ok": True, "logo": logo}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/logo POST error: {e}")


@router.post("/studio/data/logo/{id_owner}/archive")
def archive_studio_owner_logo(id_owner: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid = _require_owner_access(cur, u, id_owner)
                studio_fetch_owner(cur, oid)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_studio_owner_logo
                    SET archive = TRUE,
                        date_maj = NOW()
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (oid,),
                )
                conn.commit()

                logo = _fetch_owner_logo_meta(cur, oid)

        return {"ok": True, "logo": logo}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/logo archive error: {e}")
       
@router.get("/studio/data/client-logo-meta/{id_owner}/{id_ent}")
def get_studio_client_logo_meta(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, ent = _require_client_structure_access(cur, u, id_owner, id_ent)
                logo = _fetch_owner_logo_meta(cur, ent)

        return logo

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/client-logo-meta GET error: {e}")


@router.get("/studio/data/client-logo/{id_owner}/{id_ent}")
def get_studio_client_logo(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _, ent = _require_client_structure_access(cur, u, id_owner, id_ent)

                row = _fetch_owner_logo_row(cur, ent)
                if not row:
                    raise HTTPException(status_code=404, detail="Aucun logo enregistré.")

                raw = _fetch_owner_logo_bytes(cur, ent)
                if not raw:
                    raise HTTPException(status_code=404, detail="Aucun logo enregistré.")

                filename = _clean_text(row.get("filename_original")) or "logo.png"
                mime_type = _clean_text(row.get("mime_type")) or "application/octet-stream"

        return Response(
            content=raw,
            media_type=mime_type,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/client-logo GET error: {e}")


@router.post("/studio/data/client-logo/{id_owner}/{id_ent}")
def upload_studio_client_logo(id_owner: str, id_ent: str, request: Request, file: UploadFile = File(...)):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        filename = _clean_text(getattr(file, "filename", "") or "logo")
        content_type = _clean_text(getattr(file, "content_type", ""))
        raw = file.file.read() if file and file.file else b""

        mime_type = _validate_logo_upload(filename, content_type, raw)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid, ent = _require_client_structure_access(cur, u, id_owner, id_ent)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_studio_owner_logo
                    SET archive = TRUE,
                        date_maj = NOW()
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (ent,),
                )

                id_logo = str(uuid.uuid4())

                cur.execute(
                    """
                    INSERT INTO public.tbl_studio_owner_logo
                        (id_logo, id_owner, filename_original, mime_type, logo_bytes, taille_bytes, date_creation, date_maj, archive)
                    VALUES
                        (%s, %s, %s, %s, %s, %s, NOW(), NOW(), FALSE)
                    """,
                    (
                        id_logo,
                        ent,
                        filename or None,
                        mime_type,
                        raw,
                        len(raw),
                    ),
                )

                conn.commit()
                logo = _fetch_owner_logo_meta(cur, ent)

        return {"ok": True, "logo": logo}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/client-logo POST error: {e}")


@router.post("/studio/data/client-logo/{id_owner}/{id_ent}/archive")
def archive_studio_client_logo(id_owner: str, id_ent: str, request: Request):
    auth = request.headers.get("Authorization", "")
    u = studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                oid, ent = _require_client_structure_access(cur, u, id_owner, id_ent)
                studio_require_min_role(cur, u, oid, "admin")

                cur.execute(
                    """
                    UPDATE public.tbl_studio_owner_logo
                    SET archive = TRUE,
                        date_maj = NOW()
                    WHERE id_owner = %s
                      AND COALESCE(archive, FALSE) = FALSE
                    """,
                    (ent,),
                )
                conn.commit()

                logo = _fetch_owner_logo_meta(cur, ent)

        return {"ok": True, "logo": logo}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/data/client-logo archive error: {e}")


# ======================================================
# Référentiels Studio (nécessaires pour la page "Vos données")
# ======================================================

@router.get("/studio/referentiels/opco")
def studio_ref_opco(request: Request):
    # Token Studio obligatoire (mais pas besoin d'id_owner : référentiel global)
    auth = request.headers.get("Authorization", "")
    studio_require_user(auth)

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT id_opco, nom_opco
                    FROM public.tbl_opco
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY nom_opco
                    """
                )
                rows = cur.fetchall() or []
                return [{"id_opco": r.get("id_opco"), "nom_opco": r.get("nom_opco")} for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/opco error: {e}")


@router.get("/studio/referentiels/idcc/{idcc}")
def studio_ref_idcc(idcc: str, request: Request):
    auth = request.headers.get("Authorization", "")
    studio_require_user(auth)

    v = (idcc or "").strip()
    if not v:
        raise HTTPException(status_code=400, detail="IDCC manquant.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT libelle
                    FROM public.tbl_convention_collective
                    WHERE idcc = %s
                    LIMIT 1
                    """,
                    (v,),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="IDCC introuvable.")
                return {"idcc": v, "libelle": r.get("libelle")}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/idcc error: {e}")


@router.get("/studio/referentiels/ape/{code_ape}")
def studio_ref_ape(code_ape: str, request: Request):
    auth = request.headers.get("Authorization", "")
    studio_require_user(auth)

    v = (code_ape or "").strip()
    if not v:
        raise HTTPException(status_code=400, detail="Code APE manquant.")

    # Même règle que Skills: NN.NN
    try:
        if "RE_APE" in globals():
            if not RE_APE.match(v):
                raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")
        else:
            # fallback minimal si RE_APE n'existe pas (ne devrait pas arriver)
            if len(v) != 5 or v[2] != ".":
                raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")
    except HTTPException:
        raise

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT intitule_ape
                    FROM public.tbl_code_ape
                    WHERE code_ape = %s
                    LIMIT 1
                    """,
                    (v,),
                )
                r = cur.fetchone()
                if not r:
                    raise HTTPException(status_code=404, detail="Code APE introuvable.")
                return {"code_ape": v, "intitule_ape": r.get("intitule_ape")}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"studio/referentiels/ape error: {e}")