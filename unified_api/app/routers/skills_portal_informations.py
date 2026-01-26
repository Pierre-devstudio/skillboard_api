from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import re

from psycopg.rows import dict_row

from app.routers.skills_portal_common import get_conn, fetch_contact_with_entreprise

router = APIRouter()

RE_APE = re.compile(r"^\d{2}\.\d{2}$")


# ======================================================
# Models
# ======================================================
class EntrepriseInfo(BaseModel):
    id_ent: str
    nom_ent: str

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

    # Libellés (lookup)
    idcc_libelle: Optional[str] = None
    code_ape_intitule: Optional[str] = None
    opco_nom: Optional[str] = None


class ContactInfo(BaseModel):
    id_contact: str
    id_ent: str

    civ_ca: Optional[str] = None
    nom_ca: str
    prenom_ca: Optional[str] = None
    role_ca: Optional[str] = None
    tel_ca: Optional[str] = None
    tel2_ca: Optional[str] = None
    mail_ca: Optional[str] = None
    obs_ca: Optional[str] = None

    est_principal: Optional[bool] = None


class InformationsResponse(BaseModel):
    entreprise: EntrepriseInfo
    contact: ContactInfo


class UpdateEntreprisePayload(BaseModel):
    # Nom entreprise NON modifiable
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
    civ_ca: Optional[str] = None
    nom_ca: Optional[str] = None
    prenom_ca: Optional[str] = None
    role_ca: Optional[str] = None
    tel_ca: Optional[str] = None
    tel2_ca: Optional[str] = None
    mail_ca: Optional[str] = None
    obs_ca: Optional[str] = None


class RefOpcoItem(BaseModel):
    id_opco: str
    nom_opco: str
    site_web: Optional[str] = None


class RefIdccResponse(BaseModel):
    idcc: str
    libelle: str


class RefApeResponse(BaseModel):
    code_ape: str
    intitule_ape: str


# ======================================================
# Helpers
# ======================================================
def _build_patch_set(payload) -> Dict[str, Any]:
    """
    Patch propre:
    - champ non présent => pas modifié
    - champ présent (même None) => modifié (set NULL possible)
    """
    if hasattr(payload, "__fields_set__"):
        fields = payload.__fields_set__ or set()
    else:
        fields = set(payload.dict().keys())

    data = payload.dict()
    return {k: data.get(k) for k in fields}

def _civilite_db_to_ui(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None

    # DB attend: M / F
    if s.upper() == "M":
        return "M."
    if s.upper() == "F":
        return "Mme"

    # Si déjà au bon format, on laisse
    if s in ("M.", "Mme", "Mme."):
        return "M." if s == "M." else "Mme"

    return s  # fallback (évite de casser si valeur inattendue)


def _civilite_ui_to_db(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None

    # UI attend: M. / Mme
    if s in ("M", "M."):
        return "M"
    if s in ("F", "Mme", "Mme."):
        return "F"

    # fallback (évite de throw si tu as d'autres libellés un jour)
    return s


def _lookup_idcc(cur, idcc: Optional[str]) -> Optional[str]:
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


def _lookup_ape(cur, code_ape: Optional[str]) -> Optional[str]:
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


def _lookup_opco(cur, id_opco: Optional[str]) -> Optional[str]:
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


def _validate_idcc_exists(cur, idcc: Optional[str]):
    if idcc is None or idcc == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_convention_collective
        WHERE idcc = %s
        """,
        (idcc,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="IDCC inconnu (référentiel).")


def _validate_ape_exists(cur, code_ape: Optional[str]):
    if code_ape is None or code_ape == "":
        return
    if not RE_APE.match(code_ape):
        raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_code_ape
        WHERE code_ape = %s
        """,
        (code_ape,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="Code APE inconnu (référentiel).")


def _validate_opco_exists(cur, id_opco: Optional[str]):
    if id_opco is None or id_opco == "":
        return
    cur.execute(
        """
        SELECT 1
        FROM public.tbl_opco
        WHERE id_opco = %s
          AND COALESCE(masque, FALSE) = FALSE
        """,
        (id_opco,),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=400, detail="OPCO inconnu ou masqué (référentiel).")


def _get_informations(cur, id_contact: str) -> InformationsResponse:
    row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)

    idcc_lib = _lookup_idcc(cur, row_ent.get("idcc"))
    ape_lib = _lookup_ape(cur, row_ent.get("code_ape_ent"))
    opco_nom = _lookup_opco(cur, row_ent.get("id_opco"))

    entreprise = EntrepriseInfo(
        id_ent=row_ent["id_ent"],
        nom_ent=row_ent["nom_ent"],
        adresse_ent=row_ent.get("adresse_ent"),
        adresse_cplt_ent=row_ent.get("adresse_cplt_ent"),
        cp_ent=row_ent.get("cp_ent"),
        ville_ent=row_ent.get("ville_ent"),
        pays_ent=row_ent.get("pays_ent"),
        email_ent=row_ent.get("email_ent"),
        telephone_ent=row_ent.get("telephone_ent"),
        site_web=row_ent.get("site_web"),
        siret_ent=row_ent.get("siret_ent"),
        code_ape_ent=row_ent.get("code_ape_ent"),
        num_tva_ent=row_ent.get("num_tva_ent"),
        idcc=row_ent.get("idcc"),
        id_opco=row_ent.get("id_opco"),
        idcc_libelle=idcc_lib,
        code_ape_intitule=ape_lib,
        opco_nom=opco_nom,
    )

    contact = ContactInfo(
        id_contact=row_contact["id_contact"],
        id_ent=row_contact["id_ent"],
        civ_ca=_civilite_db_to_ui(row_contact.get("civ_ca")),
        nom_ca=row_contact["nom_ca"],
        prenom_ca=row_contact.get("prenom_ca"),
        role_ca=row_contact.get("role_ca"),
        tel_ca=row_contact.get("tel_ca"),
        tel2_ca=row_contact.get("tel2_ca"),
        mail_ca=row_contact.get("mail_ca"),
        obs_ca=row_contact.get("obs_ca"),
        est_principal=row_contact.get("est_principal"),
    )

    return InformationsResponse(entreprise=entreprise, contact=contact)


# ======================================================
# Endpoints
# ======================================================
@router.get(
    "/skills/informations/{id_contact}",
    response_model=InformationsResponse,
)
def get_informations(id_contact: str):
    """
    Retourne les informations du contact connecté + entreprise liée,
    avec libellés (IDCC / APE / OPCO).
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                return _get_informations(cur, id_contact)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/informations/entreprise/{id_contact}",
    response_model=InformationsResponse,
)
def update_entreprise_infos(id_contact: str, payload: UpdateEntreprisePayload):
    """
    Mise à jour des infos entreprise (nom_ent non modifiable).
    Patch:
    - champs non présents => inchangés
    - champs présents (même null) => mis à jour
    """
    try:
        patch = _build_patch_set(payload)

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                row_contact, row_ent = fetch_contact_with_entreprise(cur, id_contact)
                id_ent = row_ent["id_ent"]

                # Validations référentiels
                if "idcc" in patch:
                    _validate_idcc_exists(cur, patch.get("idcc"))
                if "code_ape_ent" in patch:
                    _validate_ape_exists(cur, patch.get("code_ape_ent"))
                if "id_opco" in patch:
                    _validate_opco_exists(cur, patch.get("id_opco"))

                if patch:
                    cols = []
                    vals = []
                    for k, v in patch.items():
                        cols.append(f"{k} = %s")
                        vals.append(v)

                    vals.append(id_ent)

                    cur.execute(
                        f"""
                        UPDATE public.tbl_entreprise
                        SET {", ".join(cols)}
                        WHERE id_ent = %s
                        """,
                        tuple(vals),
                    )
                    conn.commit()

                return _get_informations(cur, id_contact)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.post(
    "/skills/informations/contact/{id_contact}",
    response_model=InformationsResponse,
)
def update_contact_infos(id_contact: str, payload: UpdateContactPayload):
    """
    Mise à jour des infos du contact connecté.
    Patch:
    - champs non présents => inchangés
    - champs présents (même null) => mis à jour
    """
    try:
        patch = _build_patch_set(payload)

        # Blocage: nom_ca est NOT NULL en DB si modifié
        if "nom_ca" in patch:
            if patch.get("nom_ca") is None or str(patch.get("nom_ca") or "").strip() == "":
                raise HTTPException(status_code=400, detail="Le nom du contact est obligatoire.")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                # Validation du contact + périmètre skills
                row_contact, _ = fetch_contact_with_entreprise(cur, id_contact)

                if patch:
                    cols = []
                    vals = []
                    for k, v in patch.items():
                        cols.append(f"{k} = %s")
                        vals.append(v)

                    vals.append(row_contact["id_contact"])

                    # IMPORTANT: le "contact" connecté est désormais un effectif (tbl_effectif_client)
                    # Mapping champs API (civ_ca, nom_ca, etc.) -> champs effectif_client
                    mapping = {
                        "civ_ca": "civilite_effectif",
                        "nom_ca": "nom_effectif",
                        "prenom_ca": "prenom_effectif",
                        "role_ca": None,  # pas de champ direct côté effectif_client dans ta table actuelle
                        "tel_ca": "telephone_effectif",
                        "tel2_ca": None,  # pas de champ tel2 côté effectif_client
                        "mail_ca": "email_effectif",
                        "obs_ca": "note_commentaire",
                    }

                    eff_cols = []
                    eff_vals = []

                    for k, v in patch.items():
                        target = mapping.get(k)
                        if target:
                            # Mapping civilité UI -> DB
                            if k == "civ_ca":
                                v = _civilite_ui_to_db(v)

                            eff_cols.append(f"{target} = %s")
                            eff_vals.append(v)

                    # Si tu ne modifies que des champs non mappés (role_ca / tel2_ca), on ne fait rien
                    if eff_cols:
                        eff_vals.append(row_contact["id_contact"])  # id_contact = id_effectif (compat)
                        cur.execute(
                            f"""
                            UPDATE public.tbl_effectif_client
                            SET {", ".join(eff_cols)},
                                dernier_update = NOW()
                            WHERE id_effectif = %s
                            """,
                            tuple(eff_vals),
                        )
                        conn.commit()

                  

                return _get_informations(cur, id_contact)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


# ======================================================
# Référentiels
# ======================================================
@router.get(
    "/skills/referentiels/opco",
    response_model=List[RefOpcoItem],
)
def get_ref_opco():
    """
    Liste OPCO non masqués.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT id_opco, nom_opco, site_web
                    FROM public.tbl_opco
                    WHERE COALESCE(masque, FALSE) = FALSE
                    ORDER BY nom_opco
                    """
                )
                rows = cur.fetchall() or []
                return [RefOpcoItem(**r) for r in rows]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/referentiels/idcc/{idcc}",
    response_model=RefIdccResponse,
)
def get_ref_idcc(idcc: str):
    """
    Lookup convention collective.
    """
    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT idcc, libelle
                    FROM public.tbl_convention_collective
                    WHERE idcc = %s
                    """,
                    (idcc,),
                )
                r = cur.fetchone()
                if r is None:
                    raise HTTPException(status_code=404, detail="IDCC introuvable.")
                return RefIdccResponse(idcc=r["idcc"], libelle=r["libelle"])

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")


@router.get(
    "/skills/referentiels/ape/{code_ape}",
    response_model=RefApeResponse,
)
def get_ref_ape(code_ape: str):
    """
    Lookup code APE. Format attendu: NN.NN
    """
    try:
        if not RE_APE.match(code_ape or ""):
            raise HTTPException(status_code=400, detail="Format code APE invalide. Attendu: NN.NN")

        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT code_ape, intitule_ape
                    FROM public.tbl_code_ape
                    WHERE code_ape = %s
                    """,
                    (code_ape,),
                )
                r = cur.fetchone()
                if r is None:
                    raise HTTPException(status_code=404, detail="Code APE introuvable.")
                return RefApeResponse(code_ape=r["code_ape"], intitule_ape=r["intitule_ape"])

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur serveur : {e}")
