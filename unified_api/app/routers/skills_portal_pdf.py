from fastapi import APIRouter, HTTPException, Query, Request, Response
from psycopg.rows import dict_row

from app.routers.skills_portal_common import (
    get_conn,
    resolve_insights_context,
    skills_require_user,
    skills_validate_enterprise,
)
from app.routers.skills_portal_pdf_common import (
    build_fiche_poste_simple_story,
    build_pdf_document,
)

router = APIRouter()


def _resolve_id_ent_for_request(cur, id_contact: str, request: Request) -> str:
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

    ctx = resolve_insights_context(cur, id_contact)
    return ctx["id_ent"]


@router.get("/skills/pdf/fiche-poste-simple/{id_contact}")
def get_fiche_poste_simple_pdf(
    id_contact: str,
    request: Request,
    id_poste: str = Query(...),
):
    poste_id = (id_poste or "").strip()
    if not poste_id:
        raise HTTPException(status_code=400, detail="id_poste manquant.")

    try:
        with get_conn() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                id_ent = _resolve_id_ent_for_request(cur, id_contact, request)
                ent = skills_validate_enterprise(cur, id_ent)

        enterprise_name = (ent.get("nom_ent") or "Entreprise").strip()
        filename = f"fiche_poste_simple_{poste_id}.pdf"

        pdf_bytes = build_pdf_document(
            build_fiche_poste_simple_story(
                enterprise_name=enterprise_name,
                poste_ref=poste_id,
            ),
            meta={
                "title": "Fiche de poste simple",
                "doc_label": "Fiche de poste simple",
                "footer_left": "Novoskill Insights • Template commun PDF",
            },
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur génération PDF : {e}")