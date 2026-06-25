from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime, date, timedelta

from app.services.skills_analyse_engine import (
    _analyse_fragility_average,
    _analyse_fragility_records_analyzed,
    _build_scope_cte,
    _compute_poste_fragility_record,
    _fetch_postes_fragility_records,
)


# ======================================================
# Models réutilisables Insights / Studio
# ======================================================
class SimulationHypothese(BaseModel):
    type: str
    id_effectif: Optional[str] = None
    id_poste: Optional[str] = None
    id_poste_cible: Optional[str] = None
    id_poste_source: Optional[str] = None
    id_comp: Optional[str] = None
    niveau_simule: Optional[str] = None
    libelle: Optional[str] = None
    temporalite: Optional[str] = None


class SimulationEvalRequest(BaseModel):
    titre: Optional[str] = None
    objectif: Optional[str] = None
    hypotheses: List[SimulationHypothese] = []


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _norm_text(v: Any) -> str:
    return (v or "").toString().strip() if hasattr((v or ""), "toString") else str(v or "").strip()


def _level_rank(v: Any) -> int:
    s = str(v or "").strip().lower()
    s = (s.replace("é", "e").replace("è", "e").replace("ê", "e")
           .replace("à", "a").replace("ç", "c"))
    if s in ("a", "1", "initial", "debutant") or s.startswith("deb") or s.startswith("init"):
        return 1
    if s in ("b", "2", "intermediaire") or s.startswith("inter"):
        return 2
    if s in ("c", "3", "avance", "avancee") or s.startswith("avan"):
        return 3
    if s in ("d", "4", "expert") or s.startswith("exp"):
        return 4
    return 0


def _level_label(v: Any) -> str:
    r = _level_rank(v)
    return {1: "A", 2: "B", 3: "C", 4: "D"}.get(r, "—")


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None or v == "":
            return default
        return int(float(v))
    except Exception:
        return default


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or v == "":
            return default
        return float(v)
    except Exception:
        return default


def _ratio(part: float, total: float) -> float:
    if total <= 0:
        return 0.0
    return max(0.0, min(1.0, float(part) / float(total)))


def _risk_label(score: int) -> str:
    if score >= 70:
        return "critique"
    if score >= 45:
        return "à surveiller"
    return "maîtrisé"


def _cotation_label(cotation: Optional[Dict[str, Any]]) -> str:
    if not cotation:
        return "Non cotée"
    validation = cotation.get("validation_json") or {}
    idcc = str(cotation.get("idcc") or "").strip()
    coef = validation.get("coefficient")
    palier = validation.get("palier")
    cat = validation.get("categorie_professionnelle")
    groupe = validation.get("groupe_emploi")
    classe = validation.get("classe_emploi")
    niveau = validation.get("niveau_emploi")

    chunks = []
    if idcc:
        chunks.append(f"IDCC {idcc}")
    if coef not in (None, ""):
        chunks.append(f"Coef. {coef}")
    if groupe not in (None, ""):
        chunks.append(f"Groupe {groupe}")
    if classe not in (None, ""):
        chunks.append(f"Classe {classe}")
    if niveau not in (None, ""):
        chunks.append(f"Niveau {niveau}")
    elif palier not in (None, ""):
        chunks.append(f"Palier {palier}")
    if cat:
        chunks.append(str(cat))
    return " · ".join(chunks) if chunks else "Cotation validée"


def _cotation_numeric(cotation: Optional[Dict[str, Any]]) -> Optional[float]:
    if not cotation:
        return None
    validation = cotation.get("validation_json") or {}
    for key in ("coefficient", "groupe_emploi", "classe_emploi", "palier"):
        if validation.get(key) not in (None, ""):
            return _safe_float(validation.get(key), 0.0)
    return None


def _compare_cotations(source: Optional[Dict[str, Any]], target: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    s_num = _cotation_numeric(source)
    t_num = _cotation_numeric(target)
    complete = source is not None and target is not None
    delta = None
    niveau = "non estimé"
    if s_num is not None and t_num is not None:
        delta = round(t_num - s_num, 2)
        if delta > 0:
            niveau = "hausse probable"
        elif delta < 0:
            niveau = "baisse probable"
        else:
            niveau = "stable"
    return {
        "source": _cotation_label(source),
        "cible": _cotation_label(target),
        "delta": delta,
        "niveau": niveau,
        "fiable": bool(complete),
    }


def _json_dict(v: Any) -> Dict[str, Any]:
    if isinstance(v, dict):
        return v
    return {}


def _fetch_simulation_dataset(cur, id_ent: str, id_service: Optional[str], criticite_min: int) -> Dict[str, Any]:
    cte_sql, cte_params = _build_scope_cte(id_ent, id_service)

    sql_postes = f"""
    WITH
    {cte_sql}
    SELECT
        fp.id_poste,
        fp.codif_poste,
        fp.codif_client,
        fp.intitule_poste,
        fp.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        COALESCE(prh.nb_titulaires_cible, 1)::int AS nb_titulaires_cible,
        COALESCE(prh.criticite_poste, 2)::int AS criticite_poste,
        COALESCE(prh.statut_poste, 'actif')::text AS statut_poste
    FROM postes_scope ps
    JOIN public.tbl_fiche_poste fp ON fp.id_poste = ps.id_poste
    LEFT JOIN public.tbl_entreprise_organigramme o
      ON o.id_ent = %s
     AND o.id_service = fp.id_service
     AND o.archive = FALSE
    LEFT JOIN public.tbl_fiche_poste_param_rh prh ON prh.id_poste = fp.id_poste
    WHERE COALESCE(fp.actif, TRUE) = TRUE
    ORDER BY COALESCE(o.nom_service, ''), fp.intitule_poste
    """
    cur.execute(sql_postes, tuple(cte_params + [id_ent]))
    postes = [dict(r) for r in (cur.fetchall() or [])]
    poste_ids = [str(p.get("id_poste") or "") for p in postes if p.get("id_poste")]

    sql_effectifs = f"""
    WITH
    {cte_sql}
    SELECT
        e.id_effectif,
        e.prenom_effectif,
        e.nom_effectif,
        e.id_service,
        COALESCE(o.nom_service, '') AS nom_service,
        e.id_poste_actuel,
        COALESCE(fp.intitule_poste, '') AS intitule_poste,
        COALESCE(fp.codif_poste, '') AS codif_poste,
        COALESCE(e.statut_actif, TRUE) AS statut_actif,
        COALESCE(e.is_temp, FALSE) AS is_temp
    FROM effectifs_scope es
    JOIN public.tbl_effectif_client e ON e.id_effectif = es.id_effectif
    LEFT JOIN public.tbl_fiche_poste fp ON fp.id_poste = e.id_poste_actuel
    LEFT JOIN public.tbl_entreprise_organigramme o
      ON o.id_ent = %s
     AND o.id_service = e.id_service
     AND o.archive = FALSE
    WHERE COALESCE(e.archive, FALSE) = FALSE
      AND COALESCE(e.statut_actif, TRUE) = TRUE
      AND COALESCE(e.is_temp, FALSE) = FALSE
    ORDER BY e.nom_effectif, e.prenom_effectif
    """
    cur.execute(sql_effectifs, tuple(cte_params + [id_ent]))
    effectifs = [dict(r) for r in (cur.fetchall() or [])]

    sql_reqs = f"""
    WITH
    {cte_sql}
    SELECT DISTINCT
        fpc.id_poste,
        c.id_comp,
        c.code,
        c.intitule,
        COALESCE(c.domaine, '') AS domaine,
        COALESCE(fpc.niveau_requis, '')::text AS niveau_requis,
        COALESCE(fpc.poids_criticite, 0)::int AS poids_criticite
    FROM public.tbl_fiche_poste_competence fpc
    JOIN postes_scope ps ON ps.id_poste = fpc.id_poste
    JOIN public.tbl_competence c
      ON (c.id_comp = fpc.id_competence OR c.code = fpc.id_competence)
    WHERE c.etat = 'active'
      AND COALESCE(c.masque, FALSE) = FALSE
      AND COALESCE(fpc.masque, FALSE) = FALSE
      AND COALESCE(fpc.poids_criticite, 0)::int >= %s
    ORDER BY fpc.id_poste, COALESCE(fpc.poids_criticite, 0)::int DESC, c.intitule
    """
    cur.execute(sql_reqs, tuple(cte_params + [int(criticite_min)]))
    requirements = [dict(r) for r in (cur.fetchall() or [])]

    sql_skills = f"""
    WITH
    {cte_sql}
    SELECT
        ec.id_effectif_client AS id_effectif,
        ec.id_comp,
        COALESCE(ec.niveau_actuel, '') AS niveau_actuel,
        ec.date_derniere_eval,
        a.date_audit,
        a.resultat_eval,
        c.code,
        c.intitule,
        COALESCE(c.domaine, '') AS domaine
    FROM public.tbl_effectif_client_competence ec
    JOIN effectifs_scope es ON es.id_effectif = ec.id_effectif_client
    JOIN public.tbl_competence c ON c.id_comp = ec.id_comp
    LEFT JOIN public.tbl_effectif_client_audit_competence a
      ON a.id_audit_competence = ec.id_dernier_audit
     AND a.id_effectif_competence = ec.id_effectif_competence
    WHERE COALESCE(ec.actif, TRUE) = TRUE
      AND COALESCE(ec.archive, FALSE) = FALSE
      AND c.etat = 'active'
      AND COALESCE(c.masque, FALSE) = FALSE
    """
    cur.execute(sql_skills, tuple(cte_params))
    skills = [dict(r) for r in (cur.fetchall() or [])]

    sql_cot = """
    SELECT DISTINCT ON (id_poste)
        id_cotation_ccn,
        id_poste,
        idcc,
        statut_cotation,
        validation_json,
        date_maj
    FROM public.tbl_studio_poste_cotation_ccn
    WHERE id_ent = %s
      AND COALESCE(archive, FALSE) = FALSE
    ORDER BY
        id_poste,
        CASE WHEN statut_cotation = 'valide' THEN 0 ELSE 1 END,
        date_maj DESC
    """
    cur.execute(sql_cot, (id_ent,))
    cotations_raw = [dict(r) for r in (cur.fetchall() or [])]
    cotations = {}
    for c in cotations_raw:
        c["validation_json"] = _json_dict(c.get("validation_json"))
        if str(c.get("statut_cotation") or "").strip().lower() == "valide":
            cotations[str(c.get("id_poste") or "")] = c

    # Catalogue de compétences pour le constructeur de scénario.
    cur.execute(
        """
        SELECT id_comp, code, intitule, COALESCE(domaine, '') AS domaine
        FROM public.tbl_competence
        WHERE etat = 'active'
          AND COALESCE(masque, FALSE) = FALSE
        ORDER BY COALESCE(domaine, ''), intitule
        LIMIT 1000
        """
    )
    competences = [dict(r) for r in (cur.fetchall() or [])]

    return {
        "postes": postes,
        "effectifs": effectifs,
        "requirements": requirements,
        "skills": skills,
        "cotations": cotations,
        "competences": competences,
        "poste_ids": poste_ids,
    }


def _build_state(dataset: Dict[str, Any], hypotheses: List[SimulationHypothese], *, simulated: bool) -> Dict[str, Any]:
    effectifs = {str(e.get("id_effectif") or ""): dict(e) for e in dataset.get("effectifs") or []}
    skills: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in dataset.get("skills") or []:
        eid = str(row.get("id_effectif") or "")
        cid = str(row.get("id_comp") or "")
        if eid and cid:
            skills[(eid, cid)] = dict(row)

    requirements = [dict(r) for r in (dataset.get("requirements") or [])]

    removed = set()
    virtual_index = 0

    def add_or_update_skill(eid: str, cid: str, niveau: Any, comp_meta: Optional[Dict[str, Any]] = None) -> None:
        if not eid or not cid:
            return
        comp = comp_meta or next((c for c in dataset.get("competences") or [] if str(c.get("id_comp") or "") == cid), None) or {}
        skills[(eid, cid)] = {
            **dict(skills.get((eid, cid)) or {}),
            "id_effectif": eid,
            "id_comp": cid,
            "niveau_actuel": _level_label(niveau),
            "code": comp.get("code") or skills.get((eid, cid), {}).get("code") or "",
            "intitule": comp.get("intitule") or skills.get((eid, cid), {}).get("intitule") or "",
            "domaine": comp.get("domaine") or skills.get((eid, cid), {}).get("domaine") or "",
            # En simulation, le niveau visé est une hypothèse validée par l'utilisateur.
            # On le marque évalué pour que le moteur mesure l'effet attendu sans modifier le réel.
            "resultat_eval": 24 if _level_rank(niveau) >= 4 else (18 if _level_rank(niveau) >= 3 else (12 if _level_rank(niveau) >= 2 else 6)),
            "date_audit": date.today(),
            "date_derniere_eval": date.today(),
            "is_simulated": True,
        }

    def add_virtual_profile(target_poste: str, label: str = "Profil virtuel") -> str:
        nonlocal virtual_index
        virtual_index += 1
        veid = f"__VIRTUEL_{virtual_index}__"
        poste = next((p for p in dataset.get("postes") or [] if str(p.get("id_poste") or "") == target_poste), None) or {}
        effectifs[veid] = {
            "id_effectif": veid,
            "prenom_effectif": label,
            "nom_effectif": str(virtual_index),
            "id_poste_actuel": target_poste,
            "intitule_poste": poste.get("intitule_poste") or "Profil recruté / renfort",
            "codif_poste": poste.get("codif_poste") or "",
            "nom_service": poste.get("nom_service") or "",
            "is_virtual": True,
        }
        return veid

    def transfer_requirement(source_poste: str, target_poste: str, comp_id: str) -> None:
        source_poste = str(source_poste or "").strip()
        target_poste = str(target_poste or "").strip()
        comp_id = str(comp_id or "").strip()
        if not source_poste or not target_poste or not comp_id or source_poste == target_poste:
            return

        moved = [
            dict(r) for r in requirements
            if str(r.get("id_poste") or "").strip() == source_poste
            and str(r.get("id_comp") or "").strip() == comp_id
        ]
        if not moved:
            return

        requirements[:] = [
            r for r in requirements
            if not (str(r.get("id_poste") or "").strip() == source_poste and str(r.get("id_comp") or "").strip() == comp_id)
        ]

        if any(str(r.get("id_poste") or "").strip() == target_poste and str(r.get("id_comp") or "").strip() == comp_id for r in requirements):
            return

        for r in moved:
            nr = dict(r)
            nr["id_poste"] = target_poste
            nr["is_transferred_charge"] = True
            nr["source_poste"] = source_poste
            requirements.append(nr)

    if simulated:
        for h in hypotheses or []:
            h_type = str(h.type or "").strip()
            eid = str(h.id_effectif or "").strip()

            if h_type in ("depart_effectif", "absence_effectif") and eid:
                removed.add(eid)

            elif h_type in ("mobilite_effectif", "tester_correspondance_profil_poste") and eid and eid in effectifs:
                target = str(h.id_poste_cible or h.id_poste or "").strip()
                if target:
                    effectifs[eid]["id_poste_actuel"] = target
                    poste = next((p for p in dataset.get("postes") or [] if str(p.get("id_poste") or "") == target), None) or {}
                    effectifs[eid]["intitule_poste"] = poste.get("intitule_poste") or ""
                    effectifs[eid]["codif_poste"] = poste.get("codif_poste") or ""

            elif h_type == "transfert_charge":
                transfer_requirement(h.id_poste, h.id_poste_cible, h.id_comp)

            elif h_type in ("montee_competence", "formation_ciblee", "transmission_interne") and eid:
                cid = str(h.id_comp or "").strip()
                niv = _level_label(h.niveau_simule or "C")
                if cid and niv != "—":
                    add_or_update_skill(eid, cid, niv)

            elif h_type in ("recrutement_virtuel", "securiser_poste"):
                target = str(h.id_poste_cible or h.id_poste or "").strip()
                if target:
                    veid = add_virtual_profile(target)
                    for req in requirements:
                        if str(req.get("id_poste") or "") == target:
                            add_or_update_skill(veid, str(req.get("id_comp") or ""), req.get("niveau_requis"), req)

            elif h_type == "securiser_competence":
                # Hypothèse ouverte depuis Analyse : on matérialise un relais virtuel sur la compétence,
                # pour mesurer l'effet théorique avant que l'utilisateur choisisse une personne réelle.
                cid = str(h.id_comp or "").strip()
                target = str(h.id_poste_cible or h.id_poste or "").strip()
                if cid:
                    veid = add_virtual_profile(target, "Relais virtuel") if target else f"__RELAIS_{virtual_index + 1}__"
                    if veid not in effectifs:
                        virtual_index += 1
                        effectifs[veid] = {
                            "id_effectif": veid,
                            "prenom_effectif": "Relais",
                            "nom_effectif": f"virtuel {virtual_index}",
                            "id_poste_actuel": target,
                            "is_virtual": True,
                        }
                    add_or_update_skill(veid, cid, h.niveau_simule or "C")

    active_effectifs = {eid: e for eid, e in effectifs.items() if eid not in removed}
    return {"effectifs": active_effectifs, "skills": skills, "removed": removed, "requirements": requirements}


def _compute_poste_records(dataset: Dict[str, Any], state: Dict[str, Any]) -> List[Dict[str, Any]]:
    postes = [dict(p) for p in (dataset.get("postes") or [])]
    reqs_by_poste: Dict[str, List[Dict[str, Any]]] = {}
    for r in state.get("requirements") or dataset.get("requirements") or []:
        reqs_by_poste.setdefault(str(r.get("id_poste") or ""), []).append(dict(r))

    effectifs = state.get("effectifs") or {}
    skills = state.get("skills") or {}

    holders_by_poste: Dict[str, List[str]] = {}
    for eid, e in effectifs.items():
        pid = str(e.get("id_poste_actuel") or "")
        if pid:
            holders_by_poste.setdefault(pid, []).append(eid)

    global_qualified_by_comp: Dict[str, int] = {}
    for (eid, cid), skill in skills.items():
        if eid not in effectifs:
            continue
        if _level_rank(skill.get("niveau_actuel")) > 0:
            global_qualified_by_comp[cid] = global_qualified_by_comp.get(cid, 0) + 1

    employees = [dict(e) for e in effectifs.values()]
    out = []
    for poste in postes:
        pid = str(poste.get("id_poste") or "")
        holders = holders_by_poste.get(pid, [])
        cible = max(1, _safe_int(poste.get("nb_titulaires_cible"), 1))
        reqs = reqs_by_poste.get(pid, [])

        comp_rows: List[Dict[str, Any]] = []
        missing = []
        under = []
        unique = []

        for req in reqs:
            cid = str(req.get("id_comp") or "")
            req_rank = _level_rank(req.get("niveau_requis"))
            nb_tit_any = 0
            nb_tit_ok = 0
            for eid in holders:
                s = skills.get((eid, cid))
                rank = _level_rank(s.get("niveau_actuel") if s else None)
                if rank > 0:
                    nb_tit_any += 1
                if req_rank > 0 and rank >= req_rank:
                    nb_tit_ok += 1

            if req_rank > 0 and nb_tit_any <= 0:
                missing.append(req)
            elif req_rank > 0 and nb_tit_ok <= 0:
                under.append(req)

            if int(global_qualified_by_comp.get(cid, 0) or 0) == 1:
                unique.append(req)

            comp_rows.append({
                "id_comp": cid,
                "poids_criticite": _safe_int(req.get("poids_criticite"), 0),
                "niveau_requis": req.get("niveau_requis") or "",
                "nb_tit_any": nb_tit_any,
                "nb_tit_ok": nb_tit_ok,
            })

        base_poste = dict(poste)
        base_poste.update({
            "nb_titulaires": len(holders),
            "nb_titulaires_rattaches": len(holders),
            "nb_indisponibles": 0,
            "nb_sorties_approchantes": 0,
            "nb_titulaires_cible": cible,
            "edu_min_rank": 0,
            "nsf_domain_required": False,
        })
        row = _compute_poste_fragility_record(base_poste, comp_rows, employees)
        score = _safe_int(row.get("indice_fragilite"), 0)
        row.update({
            "niveau_risque": _risk_label(score),
            "competences_non_couvertes": len(missing),
            "competences_sous_niveau": len(under),
            "competences_porteur_unique": len(unique),
            "score_structure": _safe_int(row.get("score_structurel"), 0),
            "score_dependance": _safe_int(row.get("score_dependance"), 0),
            "missing_competences": [
                {
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "criticite": _safe_int(r.get("poids_criticite"), 0),
                    "niveau_requis": _level_label(r.get("niveau_requis")),
                }
                for r in missing[:20]
            ],
            "under_competences": [
                {
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "criticite": _safe_int(r.get("poids_criticite"), 0),
                    "niveau_requis": _level_label(r.get("niveau_requis")),
                }
                for r in under[:20]
            ],
            "unique_competences": [
                {
                    "id_comp": r.get("id_comp"),
                    "code": r.get("code"),
                    "intitule": r.get("intitule"),
                    "criticite": _safe_int(r.get("poids_criticite"), 0),
                    "niveau_requis": _level_label(r.get("niveau_requis")),
                }
                for r in unique[:20]
            ],
        })
        out.append(row)
    return sorted(out, key=lambda x: int(x.get("indice_fragilite") or 0), reverse=True)


def _skill_eval_date(skill: Dict[str, Any]) -> Optional[date]:
    for key in ("date_audit", "date_derniere_eval"):
        v = skill.get(key)
        if not v:
            continue
        if hasattr(v, "date"):
            return v.date()
        if hasattr(v, "isoformat"):
            return v
        try:
            return date.fromisoformat(str(v)[:10])
        except Exception:
            continue
    return None


def _skill_score_pct(skill: Dict[str, Any]) -> float:
    score = _safe_float(skill.get("resultat_eval"), -1.0)
    if score < 0:
        rank = _level_rank(skill.get("niveau_actuel"))
        return {1: 25.0, 2: 50.0, 3: 75.0, 4: 100.0}.get(rank, 0.0)
    if score <= 24:
        return max(0.0, min(100.0, (score / 24.0) * 100.0))
    return max(0.0, min(100.0, score))


def _transmission_status_for_skill(skill: Dict[str, Any]) -> str:
    rank = _level_rank(skill.get("niveau_actuel"))
    score_pct = _skill_score_pct(skill)
    if rank >= 4 or score_pct > 75:
        return "validated"
    if rank >= 3 and score_pct >= 63:
        return "confirm"
    return "none"


def _compute_competence_records(dataset: Dict[str, Any], state: Dict[str, Any]) -> List[Dict[str, Any]]:
    effectifs = state.get("effectifs") or {}
    skills = state.get("skills") or {}

    reqs_by_comp: Dict[str, List[Dict[str, Any]]] = {}
    comp_meta: Dict[str, Dict[str, Any]] = {}
    for req in state.get("requirements") or dataset.get("requirements") or []:
        cid = str(req.get("id_comp") or "").strip()
        if not cid:
            continue
        reqs_by_comp.setdefault(cid, []).append(dict(req))
        comp_meta.setdefault(cid, {
            "id_comp": cid,
            "code": req.get("code") or "",
            "intitule": req.get("intitule") or "Compétence",
            "domaine": req.get("domaine") or "",
        })

    carriers_by_comp: Dict[str, List[Dict[str, Any]]] = {}
    for (eid, cid), skill in skills.items():
        if eid not in effectifs:
            continue
        if not cid or _level_rank(skill.get("niveau_actuel")) <= 0:
            continue
        eff = effectifs.get(eid) or {}
        item = dict(skill)
        item["id_effectif"] = eid
        item["nom_complet"] = " ".join([str(eff.get("prenom_effectif") or "").strip(), str(eff.get("nom_effectif") or "").strip()]).strip() or ("Profil virtuel" if eff.get("is_virtual") else "Collaborateur")
        item["id_poste_actuel"] = eff.get("id_poste_actuel") or ""
        item["intitule_poste"] = eff.get("intitule_poste") or ""
        item["transmission_status"] = _transmission_status_for_skill(item)
        carriers_by_comp.setdefault(cid, []).append(item)

    out: List[Dict[str, Any]] = []
    for cid, reqs in reqs_by_comp.items():
        meta = comp_meta.get(cid) or {"id_comp": cid, "intitule": "Compétence"}
        carriers = carriers_by_comp.get(cid) or []
        validated = [c for c in carriers if c.get("transmission_status") == "validated"]
        confirm = [c for c in carriers if c.get("transmission_status") == "confirm"]
        review = [c for c in carriers if c.get("transmission_status") == "none" and _level_rank(c.get("niveau_actuel")) >= 3]
        if validated:
            status = "validated"
            label = "Transmission validée"
        elif confirm:
            status = "confirm"
            label = "À confirmer"
        elif review:
            status = "review"
            label = "Entretien recommandé"
        else:
            status = "missing"
            label = "Sans relais"
        out.append({
            **meta,
            "nb_postes_concernes": len({str(r.get("id_poste") or "") for r in reqs if str(r.get("id_poste") or "")}),
            "criticite_max": max([_safe_int(r.get("poids_criticite"), 0) for r in reqs] or [0]),
            "transmission_status": status,
            "transmission_status_label": label,
            "transmission_ok": status in ("validated", "confirm"),
            "nb_transmetteurs_valides": len(validated),
            "nb_transmetteurs_confirm": len(confirm),
            "nb_transmetteurs_review": len(review),
            "nb_porteurs": len(carriers),
            "transmetteurs": [
                {
                    "id_effectif": c.get("id_effectif"),
                    "nom_complet": c.get("nom_complet"),
                    "niveau": c.get("niveau_actuel"),
                    "status": c.get("transmission_status"),
                    "poste": c.get("intitule_poste"),
                }
                for c in (validated + confirm + review)[:8]
            ],
        })
    out.sort(key=lambda x: (0 if x.get("transmission_status") == "missing" else 1 if x.get("transmission_status") == "review" else 2, -int(x.get("criticite_max") or 0), str(x.get("intitule") or "")))
    return out


def _compute_transmission_summary(comp_records: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(comp_records or [])
    validated = len([c for c in comp_records if c.get("transmission_status") == "validated"])
    confirm = len([c for c in comp_records if c.get("transmission_status") == "confirm"])
    review = len([c for c in comp_records if c.get("transmission_status") == "review"])
    missing = len([c for c in comp_records if c.get("transmission_status") == "missing"])
    ok = validated + confirm
    return {
        "competences_total": total,
        "capacite_transmission": int(round((ok / total) * 100)) if total else 0,
        "transmission_valides_count": validated,
        "transmission_confirm_count": confirm,
        "transmission_review_count": review,
        "sans_transmetteur_count": missing,
    }

def _compute_summary(records: List[Dict[str, Any]], comp_records: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    analysed = _analyse_fragility_records_analyzed(records or [])
    total = len(analysed)
    avg = _analyse_fragility_average(analysed)
    rouges = len([r for r in analysed if int(r.get("indice_fragilite") or 0) >= 65])
    surveiller = len([r for r in analysed if 25 <= int(r.get("indice_fragilite") or 0) < 65])
    transmission = _compute_transmission_summary(comp_records or [])
    return {
        "postes_total": total,
        "fragilite_moyenne": avg,
        "postes_rouges": rouges,
        "postes_surveillance": surveiller,
        **transmission,
    }


def _compute_impacts(current: List[Dict[str, Any]], simulated: List[Dict[str, Any]], current_comp: Optional[List[Dict[str, Any]]] = None, simulated_comp: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    cur = {str(r.get("id_poste") or ""): r for r in current}
    sim = {str(r.get("id_poste") or ""): r for r in simulated}
    items = []
    secured = 0
    degraded = 0
    for pid, s in sim.items():
        c = cur.get(pid) or {}
        before = int(c.get("indice_fragilite") or 0)
        after = int(s.get("indice_fragilite") or 0)
        delta = after - before
        if delta <= -10:
            secured += 1
        elif delta >= 10:
            degraded += 1
        if abs(delta) >= 5:
            item = dict(s)
            item["fragilite_avant"] = before
            item["fragilite_apres"] = after
            item["delta"] = delta
            item["sens"] = "degrade" if delta > 0 else "ameliore"
            items.append(item)
    items.sort(key=lambda x: abs(int(x.get("delta") or 0)), reverse=True)

    cur_comp = {str(c.get("id_comp") or ""): c for c in (current_comp or [])}
    sim_comp = {str(c.get("id_comp") or ""): c for c in (simulated_comp or [])}
    comp_items = []
    for cid, s in sim_comp.items():
        c = cur_comp.get(cid) or {}
        before_ok = bool(c.get("transmission_ok"))
        after_ok = bool(s.get("transmission_ok"))
        before_status = c.get("transmission_status") or "missing"
        after_status = s.get("transmission_status") or "missing"
        if before_ok != after_ok or before_status != after_status:
            comp_items.append({
                "id_comp": cid,
                "code": s.get("code") or c.get("code") or "",
                "intitule": s.get("intitule") or c.get("intitule") or "Compétence",
                "status_avant": before_status,
                "status_apres": after_status,
                "label_avant": c.get("transmission_status_label") or "Sans relais",
                "label_apres": s.get("transmission_status_label") or "Sans relais",
                "sens": "ameliore" if after_ok and not before_ok else "degrade" if before_ok and not after_ok else "change",
            })
    comp_items.sort(key=lambda x: (0 if x.get("sens") == "ameliore" else 1, str(x.get("intitule") or "")))
    return {
        "postes_securises": secured,
        "postes_degrades": degraded,
        "postes_impactes": items[:30],
        "competences_impactees": comp_items[:40],
        "competences_securisees": len([c for c in comp_items if c.get("sens") == "ameliore"]),
        "competences_degradees": len([c for c in comp_items if c.get("sens") == "degrade"]),
    }


def _impacted_poste_ids(req: SimulationEvalRequest, dataset: Dict[str, Any]) -> List[str]:
    ids = set()
    effectifs = {str(e.get("id_effectif") or ""): e for e in dataset.get("effectifs") or []}
    for h in req.hypotheses or []:
        ht = str(h.type or "").strip()
        if h.id_poste:
            ids.add(str(h.id_poste))
        if h.id_poste_cible:
            ids.add(str(h.id_poste_cible))
        if h.id_effectif and str(h.id_effectif) in effectifs:
            pid = str(effectifs[str(h.id_effectif)].get("id_poste_actuel") or "")
            if pid:
                ids.add(pid)
    return [x for x in ids if x]


def _compute_cotation_context(req: SimulationEvalRequest, dataset: Dict[str, Any]) -> Dict[str, Any]:
    cotations = dataset.get("cotations") or {}
    effectifs = {str(e.get("id_effectif") or ""): e for e in dataset.get("effectifs") or []}
    postes = {str(p.get("id_poste") or ""): p for p in dataset.get("postes") or []}
    rows = []
    missing = set()
    deltas = []

    for h in req.hypotheses or []:
        ht = str(h.type or "").strip()
        src_pid = ""
        tgt_pid = ""
        if h.id_effectif and str(h.id_effectif) in effectifs:
            src_pid = str(effectifs[str(h.id_effectif)].get("id_poste_actuel") or "")
        if ht in ("mobilite_effectif", "recrutement_virtuel"):
            tgt_pid = str(h.id_poste_cible or h.id_poste or "").strip()
        elif ht == "transfert_charge":
            src_pid = str(h.id_poste or "").strip()
            tgt_pid = str(h.id_poste_cible or "").strip()
        elif ht in ("depart_effectif", "absence_effectif"):
            tgt_pid = src_pid

        if src_pid and src_pid not in cotations:
            missing.add(src_pid)
        if tgt_pid and tgt_pid not in cotations:
            missing.add(tgt_pid)

        if src_pid or tgt_pid:
            comp = _compare_cotations(cotations.get(src_pid), cotations.get(tgt_pid))
            if comp.get("delta") is not None:
                deltas.append(float(comp.get("delta")))
            rows.append({
                "hypothese": ht,
                "poste_source": postes.get(src_pid, {}).get("intitule_poste") or "—",
                "poste_cible": postes.get(tgt_pid, {}).get("intitule_poste") or "—",
                "cotation_source": comp.get("source"),
                "cotation_cible": comp.get("cible"),
                "delta": comp.get("delta"),
                "niveau": comp.get("niveau"),
                "fiable": comp.get("fiable"),
            })

    missing_rows = []
    for pid in sorted(missing):
        p = postes.get(pid) or {}
        missing_rows.append({
            "id_poste": pid,
            "intitule_poste": p.get("intitule_poste") or "Poste",
            "codif_poste": p.get("codif_poste") or "",
        })

    niveau = "non estimé"
    if deltas:
        mx = max(deltas, key=lambda x: abs(x))
        if mx > 0:
            niveau = "hausse probable"
        elif mx < 0:
            niveau = "baisse probable"
        else:
            niveau = "stable"

    return {
        "fiabilite": "complète" if not missing_rows else "partielle",
        "niveau": niveau,
        "lignes": rows,
        "postes_non_cotes": missing_rows,
    }


def _build_conseil(req: SimulationEvalRequest, current_summary: Dict[str, Any], simulated_summary: Dict[str, Any], impacts: Dict[str, Any], cotation: Dict[str, Any]) -> Dict[str, Any]:
    before = int(current_summary.get("fragilite_moyenne") or 0)
    after = int(simulated_summary.get("fragilite_moyenne") or 0)
    delta = after - before
    trans_before = int(current_summary.get("capacite_transmission") or 0)
    trans_after = int(simulated_summary.get("capacite_transmission") or 0)
    delta_trans = trans_after - trans_before
    top = (impacts.get("postes_impactes") or [])[:1]
    top_label = top[0].get("intitule_poste") if top else "le périmètre analysé"
    postes_degrades = int(impacts.get("postes_degrades") or 0)
    postes_securises = int(impacts.get("postes_securises") or 0)
    comp_securisees = int(impacts.get("competences_securisees") or 0)
    types = {str(h.type or "").strip() for h in req.hypotheses or []}

    if delta <= -8 or delta_trans >= 10 or comp_securisees > 0:
        verdict = f"Le scénario apporte un effet de sécurisation mesurable : fragilité {delta:+d} point(s), transmission {delta_trans:+d} point(s)."
        option = "Option intéressante à conserver dans le comparatif. Vérifier les moyens réels, le calendrier et les données de cotation avant arbitrage."
        decision = "option_favorable" if postes_degrades == 0 else "option_a_securiser"
    elif delta >= 8 or postes_degrades > postes_securises:
        verdict = f"Le scénario augmente l’exposition du périmètre de {delta} point(s). Le point de vigilance principal concerne {top_label}."
        option = "Scénario à compléter par une action de sécurisation avant décision."
        decision = "risque_eleve"
    else:
        verdict = f"Le scénario produit un impact limité sur la fragilité moyenne ({delta:+d} point(s)) et sur la transmission ({delta_trans:+d} point(s))."
        option = "Option à comparer avec une alternative formation, mobilité, transmission ou renfort avant arbitrage."
        decision = "a_comparer"

    if postes_degrades > 0:
        option += " Contrôler l’effet domino avant validation."

    alternatives = []
    if "mobilite_effectif" in types or "tester_correspondance_profil_poste" in types:
        alternatives.append("Comparer avec un recrutement ou un transfert de charge pour éviter de fragiliser le poste d’origine.")
    if "transfert_charge" in types:
        alternatives.append("Vérifier que le poste cible peut absorber la charge transférée sans créer une nouvelle fragilité.")
    if "recrutement_virtuel" in types or "securiser_poste" in types:
        alternatives.append("Comparer avec une mobilité interne ou un transfert de charge avant recrutement.")
    if "depart_effectif" in types or "absence_effectif" in types:
        alternatives.append("Ajouter une hypothèse de transmission ou de doublure interne avant l’échéance.")
    if "montee_competence" in types or "formation_ciblee" in types or "transmission_interne" in types:
        alternatives.append("Tester un second relais pour éviter de remplacer une dépendance par une autre.")
    if not alternatives:
        alternatives.append("Créer une option alternative pour comparer sécurisation rapide et effort RH réel.")

    manquants = []
    if cotation.get("fiabilite") != "complète":
        manquants.append("Certaines cotations de poste sont absentes : finaliser les cotations dans Studio affinera la lecture financière.")
    if not (req.hypotheses or []):
        manquants.append("Aucune hypothèse n’a été transmise au moteur de simulation.")

    impact_cotation = "Cotation complète : l’impact classification peut être intégré à l’arbitrage." if cotation.get("fiabilite") == "complète" else "Cotation partielle : l’impact financier reste à confirmer après cotation Studio."

    lecture_assistee = (
        f"Lecture RH : {verdict} "
        f"Postes sécurisés : {postes_securises}, postes dégradés : {postes_degrades}, "
        f"compétences sécurisées côté transmission : {comp_securisees}."
    )

    return {
        "verdict": verdict,
        "option_recommandee": option,
        "decision_code": decision,
        "lecture": verdict,
        "lecture_assistee": lecture_assistee,
        "decision_prioritaire": option,
        "impact_cotation": impact_cotation,
        "risque_secondaire": "Effet domino à contrôler." if postes_degrades > 0 else "Pas d’effet domino majeur détecté.",
        "alternatives": alternatives[:3],
        "donnees_manquantes": manquants,
    }




def _effectif_label(e: Dict[str, Any]) -> str:
    return " ".join([
        str(e.get("prenom_effectif") or "").strip(),
        str(e.get("nom_effectif") or "").strip(),
    ]).strip() or "Collaborateur"


def _skill_score_for_matching(skill: Optional[Dict[str, Any]], niveau_requis: Any) -> Tuple[int, int, str]:
    if not skill:
        return 0, _level_rank(niveau_requis), "absent"
    req_rank = _level_rank(niveau_requis)
    current_rank = _level_rank(skill.get("niveau_actuel"))
    score_pct = _skill_score_pct(skill)
    # Le score d'évaluation est le plus fiable quand il existe ; le niveau déclaré reste un fallback.
    if score_pct > 0:
        req_score = {1: 6, 2: 12, 3: 18, 4: 24}.get(req_rank, 0)
        raw = _safe_float(skill.get("resultat_eval"), 0.0)
        if raw > 24:
            raw = (raw / 100.0) * 24.0
        ratio = _ratio(raw, req_score) if req_score else 0.0
        pct = int(round(ratio * 100.0))
    else:
        pct = int(round(_ratio(current_rank, req_rank) * 100.0)) if req_rank else 0
    if current_rank <= 0 and score_pct <= 0:
        status = "absent"
    elif pct >= 100:
        status = "pret"
    elif pct >= 70:
        status = "proche"
    else:
        status = "a_preparer"
    return max(0, min(100, pct)), req_rank, status


def _build_candidate_recommendations(dataset: Dict[str, Any], limit_per_poste: int = 8) -> Dict[str, Any]:
    requirements_by_poste: Dict[str, List[Dict[str, Any]]] = {}
    for r in dataset.get("requirements") or []:
        pid = str(r.get("id_poste") or "").strip()
        if pid:
            requirements_by_poste.setdefault(pid, []).append(r)

    skills_by_effectif: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for row in dataset.get("skills") or []:
        eid = str(row.get("id_effectif") or "").strip()
        cid = str(row.get("id_comp") or "").strip()
        if eid and cid:
            skills_by_effectif.setdefault(eid, {})[cid] = row

    out: Dict[str, List[Dict[str, Any]]] = {}
    for poste in dataset.get("postes") or []:
        pid = str(poste.get("id_poste") or "").strip()
        reqs = requirements_by_poste.get(pid) or []
        if not pid or not reqs:
            continue
        poids_total = sum(max(1, _safe_int(r.get("poids_criticite"), 1)) for r in reqs) or 1
        rows: List[Dict[str, Any]] = []
        for eff in dataset.get("effectifs") or []:
            eid = str(eff.get("id_effectif") or "").strip()
            if not eid or str(eff.get("id_poste_actuel") or "") == pid:
                continue
            score_sum = 0.0
            gaps = []
            for req in reqs:
                cid = str(req.get("id_comp") or "").strip()
                poids = max(1, _safe_int(req.get("poids_criticite"), 1))
                pct, _req_rank, status = _skill_score_for_matching(skills_by_effectif.get(eid, {}).get(cid), req.get("niveau_requis"))
                score_sum += poids * min(1.0, pct / 100.0)
                if pct < 100:
                    gaps.append({
                        "id_comp": cid,
                        "code": req.get("code") or "",
                        "intitule": req.get("intitule") or "Compétence",
                        "niveau_requis": req.get("niveau_requis") or "",
                        "poids_criticite": _safe_int(req.get("poids_criticite"), 0),
                        "couverture_pct": pct,
                        "statut": status,
                    })
            score = int(round((score_sum / float(poids_total)) * 100.0))
            if score <= 0:
                continue
            if score >= 80:
                statut = "mobilité immédiate à étudier"
            elif score >= 60:
                statut = "profil proche à préparer"
            else:
                statut = "profil éloigné"
            gaps.sort(key=lambda x: (-_safe_int(x.get("poids_criticite"), 0), _safe_int(x.get("couverture_pct"), 0), str(x.get("intitule") or "")))
            rows.append({
                "id_effectif": eid,
                "nom_complet": _effectif_label(eff),
                "id_poste_actuel": eff.get("id_poste_actuel") or "",
                "poste_actuel": eff.get("intitule_poste") or "",
                "codif_poste_actuel": eff.get("codif_poste") or "",
                "nom_service": eff.get("nom_service") or "",
                "score_pct": score,
                "statut": statut,
                "competences_a_renforcer": gaps[:5],
            })
        rows.sort(key=lambda x: (-_safe_int(x.get("score_pct"), 0), str(x.get("nom_complet") or "")))
        out[pid] = rows[:limit_per_poste]
    return {"candidats_par_poste": out}


def _hypothese_is_immediate(h: SimulationHypothese) -> bool:
    ht = str(h.type or "").strip()
    return ht in ("depart_effectif", "absence_effectif", "mobilite_effectif", "tester_correspondance_profil_poste", "transfert_charge", "recrutement_virtuel", "securiser_poste")


def _compute_delta(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "fragilite_moyenne": int(after.get("fragilite_moyenne") or 0) - int(before.get("fragilite_moyenne") or 0),
        "postes_rouges": int(after.get("postes_rouges") or 0) - int(before.get("postes_rouges") or 0),
        "capacite_transmission": int(after.get("capacite_transmission") or 0) - int(before.get("capacite_transmission") or 0),
    }


def _service_impacts(current: List[Dict[str, Any]], simulated: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cur_by_service: Dict[str, List[Dict[str, Any]]] = {}
    sim_by_id = {str(r.get("id_poste") or ""): r for r in simulated or []}
    for r in current or []:
        label = str(r.get("nom_service") or "Sans service")
        cur_by_service.setdefault(label, []).append(r)
    out = []
    for label, rows in cur_by_service.items():
        before_vals = [int(r.get("indice_fragilite") or 0) for r in rows]
        after_vals = []
        changed = 0
        for r in rows:
            sim = sim_by_id.get(str(r.get("id_poste") or "")) or r
            before = int(r.get("indice_fragilite") or 0)
            after = int(sim.get("indice_fragilite") or 0)
            after_vals.append(after)
            if abs(after - before) >= 5:
                changed += 1
        if not before_vals:
            continue
        before_avg = int(round(sum(before_vals) / len(before_vals)))
        after_avg = int(round(sum(after_vals) / len(after_vals))) if after_vals else before_avg
        delta = after_avg - before_avg
        if abs(delta) >= 1 or changed > 0:
            out.append({
                "nom_service": label,
                "fragilite_avant": before_avg,
                "fragilite_apres": after_avg,
                "delta": delta,
                "postes_impactes": changed,
            })
    out.sort(key=lambda x: abs(int(x.get("delta") or 0)), reverse=True)
    return out[:20]


def _build_development_needs(req: SimulationEvalRequest, dataset: Dict[str, Any]) -> List[Dict[str, Any]]:
    skills_by_effectif: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for row in dataset.get("skills") or []:
        eid = str(row.get("id_effectif") or "").strip()
        cid = str(row.get("id_comp") or "").strip()
        if eid and cid:
            skills_by_effectif.setdefault(eid, {})[cid] = row
    reqs_by_poste: Dict[str, List[Dict[str, Any]]] = {}
    for r in dataset.get("requirements") or []:
        pid = str(r.get("id_poste") or "").strip()
        if pid:
            reqs_by_poste.setdefault(pid, []).append(r)
    effectifs = {str(e.get("id_effectif") or ""): e for e in dataset.get("effectifs") or []}
    out = []
    for h in req.hypotheses or []:
        ht = str(h.type or "").strip()
        if ht not in ("mobilite_effectif", "tester_correspondance_profil_poste"):
            continue
        eid = str(h.id_effectif or "").strip()
        pid = str(h.id_poste_cible or h.id_poste or "").strip()
        if not eid or not pid:
            continue
        eff = effectifs.get(eid) or {}
        for r in reqs_by_poste.get(pid) or []:
            cid = str(r.get("id_comp") or "").strip()
            pct, _rank, status = _skill_score_for_matching(skills_by_effectif.get(eid, {}).get(cid), r.get("niveau_requis"))
            if pct >= 100:
                continue
            out.append({
                "id_effectif": eid,
                "nom_complet": _effectif_label(eff),
                "id_poste": pid,
                "id_comp": cid,
                "code": r.get("code") or "",
                "intitule": r.get("intitule") or "Compétence",
                "niveau_requis": r.get("niveau_requis") or "",
                "couverture_pct": pct,
                "statut": status,
                "priorite_score": _safe_int(r.get("poids_criticite"), 0) + (100 - pct),
                "lecture": "À former en priorité" if pct < 60 else "À consolider",
            })
    out.sort(key=lambda x: (-_safe_int(x.get("priorite_score"), 0), str(x.get("nom_complet") or ""), str(x.get("intitule") or "")))
    return out[:30]

def _options_payload(dataset: Dict[str, Any]) -> Dict[str, Any]:
    cotations = dataset.get("cotations") or {}
    postes = []
    for p in dataset.get("postes") or []:
        pid = str(p.get("id_poste") or "")
        postes.append({
            "id_poste": pid,
            "codif_poste": p.get("codif_poste") or "",
            "intitule_poste": p.get("intitule_poste") or "Poste",
            "nom_service": p.get("nom_service") or "",
            "nb_titulaires_cible": _safe_int(p.get("nb_titulaires_cible"), 1),
            "cotation_label": _cotation_label(cotations.get(pid)),
            "cotation_validee": bool(cotations.get(pid)),
        })

    effectifs = []
    for e in dataset.get("effectifs") or []:
        effectifs.append({
            "id_effectif": e.get("id_effectif"),
            "nom_complet": " ".join([str(e.get("prenom_effectif") or "").strip(), str(e.get("nom_effectif") or "").strip()]).strip(),
            "id_poste_actuel": e.get("id_poste_actuel") or "",
            "intitule_poste": e.get("intitule_poste") or "",
            "codif_poste": e.get("codif_poste") or "",
            "nom_service": e.get("nom_service") or "",
        })

    competences = []
    for c in dataset.get("competences") or []:
        competences.append({
            "id_comp": c.get("id_comp"),
            "code": c.get("code") or "",
            "intitule": c.get("intitule") or "Compétence",
            "domaine": c.get("domaine") or "",
        })

    requirements = []
    seen_req = set()
    for r in dataset.get("requirements") or []:
        key = (str(r.get("id_poste") or ""), str(r.get("id_comp") or ""))
        if not key[0] or not key[1] or key in seen_req:
            continue
        seen_req.add(key)
        requirements.append({
            "id_poste": r.get("id_poste"),
            "id_comp": r.get("id_comp"),
            "code": r.get("code") or "",
            "intitule": r.get("intitule") or "Compétence",
            "domaine": r.get("domaine") or "",
            "niveau_requis": r.get("niveau_requis") or "",
            "poids_criticite": _safe_int(r.get("poids_criticite"), 0),
        })

    return {"postes": postes, "effectifs": effectifs, "competences": competences, "requirements": requirements}


# ======================================================
# API moteur publique
# ======================================================

def _clamp_score(v: Any) -> int:
    return max(0, min(100, _safe_int(v, 0)))


def _fetch_current_poste_records_from_analyse_engine(cur, id_ent: str, id_service: Optional[str], criticite_min: int) -> List[Dict[str, Any]]:
    """
    L'état réel de référence vient exclusivement du moteur Analyse.
    La simulation ne reconstruit pas le diagnostic actuel avec un moteur parallèle.
    """
    return [dict(r) for r in _fetch_postes_fragility_records(cur, id_ent, id_service, int(criticite_min))]


def _projected_skill_poste_ids(req: SimulationEvalRequest, dataset: Dict[str, Any]) -> set:
    """Garde-fou : une montée en compétence ne doit pas dégrader le poste concerné."""
    ids = set()
    effectifs = {str(e.get("id_effectif") or ""): e for e in dataset.get("effectifs") or []}
    reqs_by_comp: Dict[str, set] = {}
    for r in dataset.get("requirements") or []:
        cid = str(r.get("id_comp") or "").strip()
        pid = str(r.get("id_poste") or "").strip()
        if cid and pid:
            reqs_by_comp.setdefault(cid, set()).add(pid)

    for h in req.hypotheses or []:
        if str(h.type or "").strip() not in ("montee_competence", "formation_ciblee", "transmission_interne"):
            continue
        if h.id_poste:
            ids.add(str(h.id_poste))
        if h.id_poste_cible:
            ids.add(str(h.id_poste_cible))
        if h.id_effectif and str(h.id_effectif) in effectifs:
            pid = str(effectifs[str(h.id_effectif)].get("id_poste_actuel") or "").strip()
            if pid:
                ids.add(pid)
        cid = str(h.id_comp or "").strip()
        if cid:
            ids.update(reqs_by_comp.get(cid, set()))
    return {x for x in ids if x}


def _align_records_on_analyse_baseline(
    analyse_current: List[Dict[str, Any]],
    raw_current: List[Dict[str, Any]],
    raw_after: List[Dict[str, Any]],
    *,
    monotonic_poste_ids: Optional[set] = None,
) -> List[Dict[str, Any]]:
    """
    On conserve le delta produit par les hypothèses, mais on l'applique sur le score réel
    issu du moteur Analyse. Analyse reste donc la source de vérité de l'état initial.
    """
    analyse_by_id = {str(r.get("id_poste") or ""): dict(r) for r in analyse_current or []}
    raw_current_by_id = {str(r.get("id_poste") or ""): dict(r) for r in raw_current or []}
    monotonic_ids = {str(x) for x in (monotonic_poste_ids or set()) if str(x or "").strip()}

    out: List[Dict[str, Any]] = []
    seen = set()
    for after_row in raw_after or []:
        pid = str(after_row.get("id_poste") or "")
        seen.add(pid)
        raw_before = raw_current_by_id.get(pid) or {}
        analyse_before = analyse_by_id.get(pid) or {}
        row = {**analyse_before, **dict(after_row)} if analyse_before else dict(after_row)

        if analyse_before and raw_before:
            base_score = _clamp_score(analyse_before.get("indice_fragilite"))
            raw_delta = _clamp_score(after_row.get("indice_fragilite")) - _clamp_score(raw_before.get("indice_fragilite"))
            aligned_score = _clamp_score(base_score + raw_delta)
            if pid in monotonic_ids and aligned_score > base_score:
                aligned_score = base_score
            row["indice_fragilite"] = aligned_score
            row["score_total"] = aligned_score
            row["niveau_risque"] = _risk_label(aligned_score)
            row["is_fragile"] = bool(aligned_score > 0)
        out.append(row)

    for pid, analyse_row in analyse_by_id.items():
        if pid not in seen:
            out.append(dict(analyse_row))

    return sorted(out, key=lambda x: int(x.get("indice_fragilite") or 0), reverse=True)


def build_simulation_options_payload(cur, id_ent: str, scope: Any, criticite_min: int) -> Dict[str, Any]:
    dataset = _fetch_simulation_dataset(cur, id_ent, getattr(scope, "id_service", None), int(criticite_min))
    payload = _options_payload(dataset)
    payload["recommendations"] = _build_candidate_recommendations(dataset)
    payload["scope"] = scope.dict() if hasattr(scope, "dict") else dict(scope or {})
    payload["updated_at"] = _now_iso()
    return payload


def evaluate_simulation_payload(cur, id_ent: str, scope: Any, payload: SimulationEvalRequest, criticite_min: int) -> Dict[str, Any]:
    id_service = getattr(scope, "id_service", None)
    dataset = _fetch_simulation_dataset(cur, id_ent, id_service, int(criticite_min))

    current_state = _build_state(dataset, [], simulated=False)
    immediate_hypotheses = [h for h in (payload.hypotheses or []) if _hypothese_is_immediate(h)]
    immediate_state = _build_state(dataset, immediate_hypotheses, simulated=True)
    simulated_state = _build_state(dataset, payload.hypotheses or [], simulated=True)

    # Source de vérité de l'état réel : moteur Analyse, sans recopie de formule.
    current_records_analyse = _fetch_current_poste_records_from_analyse_engine(cur, id_ent, id_service, int(criticite_min))
    raw_current_records = _compute_poste_records(dataset, current_state)

    current_records = current_records_analyse
    current_comp_records = _compute_competence_records(dataset, current_state)
    current_summary = _compute_summary(current_records, current_comp_records)

    projected_poste_ids = _projected_skill_poste_ids(payload, dataset)

    raw_immediate_records = _compute_poste_records(dataset, immediate_state)
    immediate_records = _align_records_on_analyse_baseline(
        current_records,
        raw_current_records,
        raw_immediate_records,
        monotonic_poste_ids=set(),
    )
    immediate_comp_records = _compute_competence_records(dataset, immediate_state)
    immediate_summary = _compute_summary(immediate_records, immediate_comp_records)
    immediate_impacts = _compute_impacts(current_records, immediate_records, current_comp_records, immediate_comp_records)
    immediate_impacts["services_impactes"] = _service_impacts(current_records, immediate_records)

    raw_simulated_records = _compute_poste_records(dataset, simulated_state)
    simulated_records = _align_records_on_analyse_baseline(
        current_records,
        raw_current_records,
        raw_simulated_records,
        monotonic_poste_ids=projected_poste_ids,
    )
    simulated_comp_records = _compute_competence_records(dataset, simulated_state)
    simulated_summary = _compute_summary(simulated_records, simulated_comp_records)
    impacts = _compute_impacts(current_records, simulated_records, current_comp_records, simulated_comp_records)
    impacts["services_impactes"] = _service_impacts(current_records, simulated_records)

    cotation = _compute_cotation_context(payload, dataset)
    conseil = _build_conseil(payload, current_summary, simulated_summary, impacts, cotation)
    developpement = {
        "besoins_formation": _build_development_needs(payload, dataset),
        "lecture": "Les besoins listés correspondent aux écarts entre les personnes déplacées et les postes ciblés. Ils servent à préparer l'étape formation/transmission après l'arbitrage immédiat.",
    }

    return {
        "scope": scope.dict() if hasattr(scope, "dict") else dict(scope or {}),
        "updated_at": _now_iso(),
        "titre": (payload.titre or "Scénario RH").strip() or "Scénario RH",
        "objectif": (payload.objectif or "").strip(),
        "hypotheses": [h.dict() for h in (payload.hypotheses or [])],
        "actuel": current_summary,
        "simule": simulated_summary,
        "ecart": _compute_delta(current_summary, simulated_summary),
        "resultats": {
            "immediat": {
                "summary": immediate_summary,
                "ecart": _compute_delta(current_summary, immediate_summary),
                "impact": immediate_impacts,
            },
            "projete": {
                "summary": simulated_summary,
                "ecart": _compute_delta(current_summary, simulated_summary),
                "impact": impacts,
            },
        },
        "impact": impacts,
        "developpement": developpement,
        "competences": {
            "actuel": current_comp_records[:100],
            "simule": simulated_comp_records[:100],
        },
        "cotation": cotation,
        "conseil": conseil,
        "reference_calcul": {
            "etat_reel": "skills_analyse_engine._fetch_postes_fragility_records",
            "criticite_min": int(criticite_min),
            "id_service": id_service,
        },
    }
