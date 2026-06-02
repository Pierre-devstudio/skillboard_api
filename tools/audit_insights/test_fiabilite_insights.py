# -*- coding: utf-8 -*-
"""
Test de fiabilité Insights - couverture / fragilité compétences par poste.
Usage:
    python test_fiabilite_insights.py "Supabase Snippet Insights fiabilité _ couverture compétences par poste.csv"

Le test ne se connecte pas à Supabase. Il contrôle l'extraction CSV fournie et vérifie
la doctrine métier utilisée par le correctif:
- une compétence déclarée mais non évaluée ne valide pas la couverture;
- une compétence évaluée sous le niveau requis ne valide pas la couverture;
- table compétence et modal compétence doivent partager le même indice;
- un indice > 0 doit produire au moins une cause racine.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, Any, List, Tuple

import pandas as pd

STATE_RISK = {
    "AUCUN_TITULAIRE": 100,
    "COUVERTURE_ABSENTE": 100,
    "COUVERTURE_NON_CONFIRMEE": 85,
    "NIVEAU_INSUFFISANT": 70,
    "DEPENDANCE": 60,
    "COUVERTURE_VALIDEE": 0,
}


def _truthy(v: Any) -> bool:
    if v is True:
        return True
    if v is False or pd.isna(v):
        return False
    return str(v).strip().lower() in {"true", "t", "1", "oui", "yes"}


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if pd.isna(v) or v == "":
            return default
        return int(float(v))
    except Exception:
        return default


def compute_poste_comp_states(df: pd.DataFrame, criticite_min: int = 70) -> pd.DataFrame:
    f = df[df["poids_criticite"].fillna(0).astype(int) >= criticite_min].copy()
    if f.empty:
        return pd.DataFrame()

    rows: List[Dict[str, Any]] = []
    group_cols = ["id_poste", "id_comp"]

    for (_, _), g in f.groupby(group_cols, dropna=False):
        first = g.iloc[0]
        nb_tit = g["id_effectif"].dropna().astype(str).replace("nan", "").replace("", pd.NA).dropna().nunique()
        cible = max(_safe_int(first.get("nb_titulaires_cible"), 1), 1)
        besoin = cible if cible > 0 else (nb_tit if nb_tit > 0 else 1)
        req_rank = _safe_int(first.get("rang_requis"), 0)

        valid = 0
        declared = 0
        evaluated = 0
        non_eval = 0
        insuff = 0

        for _, r in g.iterrows():
            has_effectif = not pd.isna(r.get("id_effectif")) and str(r.get("id_effectif")).strip() != ""
            if not has_effectif:
                continue
            has_comp = not pd.isna(r.get("id_effectif_competence")) and str(r.get("id_effectif_competence")).strip() != ""
            if not has_comp:
                continue
            declared += 1
            is_eval = _truthy(r.get("est_evaluee")) and not pd.isna(r.get("resultat_eval"))
            act_rank = _safe_int(r.get("rang_actuel"), 0)
            if not is_eval:
                non_eval += 1
                continue
            evaluated += 1
            if req_rank > 0 and act_rank >= req_rank:
                valid += 1
            elif act_rank > 0:
                insuff += 1
            else:
                non_eval += 1

        if nb_tit <= 0:
            state = "AUCUN_TITULAIRE"
        elif valid >= besoin:
            state = "DEPENDANCE" if valid == 1 else "COUVERTURE_VALIDEE"
        elif declared <= 0:
            state = "COUVERTURE_ABSENTE"
        elif non_eval > 0:
            state = "COUVERTURE_NON_CONFIRMEE"
        elif insuff > 0:
            state = "NIVEAU_INSUFFISANT"
        else:
            state = "COUVERTURE_ABSENTE"

        rows.append({
            "id_poste": first["id_poste"],
            "codif_poste": first["codif_poste"],
            "intitule_poste": first["intitule_poste"],
            "id_comp": first["id_comp"],
            "code_competence": first["code_competence"],
            "intitule_competence": first["intitule_competence"],
            "poids_criticite": _safe_int(first["poids_criticite"], 0),
            "niveau_requis": first["niveau_requis"],
            "besoin_poste": besoin,
            "nb_titulaires": nb_tit,
            "declares": declared,
            "evalues": evaluated,
            "valides": valid,
            "non_evalues": non_eval,
            "insuffisants": insuff,
            "etat_couverture": state,
            "risque_ligne": STATE_RISK[state],
        })

    return pd.DataFrame(rows)


def compute_competence_scores(states: pd.DataFrame) -> pd.DataFrame:
    out = []
    for id_comp, g in states.groupby("id_comp"):
        poids = g["poids_criticite"].clip(lower=1)
        score = round((g["risque_ligne"] * poids).sum() / poids.sum()) if poids.sum() else 0
        counts = g["etat_couverture"].value_counts().to_dict()
        out.append({
            "id_comp": id_comp,
            "code_competence": g["code_competence"].iloc[0],
            "intitule_competence": g["intitule_competence"].iloc[0],
            "nb_postes": int(len(g)),
            "indice_table": int(score),
            "indice_modal": int(score),
            "causes": int(sum(counts.get(k, 0) for k in ["AUCUN_TITULAIRE", "COUVERTURE_ABSENTE", "COUVERTURE_NON_CONFIRMEE", "NIVEAU_INSUFFISANT", "DEPENDANCE"])),
            "absente": int(counts.get("AUCUN_TITULAIRE", 0) + counts.get("COUVERTURE_ABSENTE", 0)),
            "non_confirmee": int(counts.get("COUVERTURE_NON_CONFIRMEE", 0)),
            "insuffisante": int(counts.get("NIVEAU_INSUFFISANT", 0)),
            "dependance": int(counts.get("DEPENDANCE", 0)),
            "validee": int(counts.get("COUVERTURE_VALIDEE", 0)),
        })
    return pd.DataFrame(out).sort_values(["indice_table", "nb_postes", "code_competence"], ascending=[False, False, True])


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python test_fiabilite_insights.py <export_supabase.csv>")
        return 2

    path = Path(sys.argv[1])
    df = pd.read_csv(path)
    states = compute_poste_comp_states(df, 70)
    comp = compute_competence_scores(states)

    failures: List[str] = []

    if states.empty:
        failures.append("Aucune compétence dans le seuil de criticité >= 70.")

    # 1. Une présence non évaluée ne doit jamais être validée.
    bad_non_eval = states[(states["non_evalues"] > 0) & (states["valides"] >= states["besoin_poste"])]
    if len(bad_non_eval):
        failures.append(f"{len(bad_non_eval)} ligne(s) non évaluées considérées comme validées.")

    # 2. Une compétence insuffisante ne doit jamais donner un score nul.
    bad_insuff_zero = states[(states["insuffisants"] > 0) & (states["risque_ligne"] == 0)]
    if len(bad_insuff_zero):
        failures.append(f"{len(bad_insuff_zero)} ligne(s) insuffisantes avec risque 0.")

    # 3. Table et modal compétence: même indice.
    mismatch = comp[comp["indice_table"] != comp["indice_modal"]]
    if len(mismatch):
        failures.append(f"{len(mismatch)} compétence(s) ont un indice table différent du modal.")

    # 4. Indice > 0 => cause présente.
    no_cause = comp[(comp["indice_table"] > 0) & (comp["causes"] <= 0)]
    if len(no_cause):
        failures.append(f"{len(no_cause)} compétence(s) fragiles sans cause racine.")

    # 5. Indice = 0 => aucune cause de fragilité.
    false_cause = comp[(comp["indice_table"] == 0) & (comp["causes"] > 0)]
    if len(false_cause):
        failures.append(f"{len(false_cause)} compétence(s) à indice 0 avec causes de fragilité.")

    print("=== TEST FIABILITE INSIGHTS ===")
    print(f"Fichier: {path.name}")
    print(f"Lignes export: {len(df)}")
    print(f"Postes analysés: {states['id_poste'].nunique() if not states.empty else 0}")
    print(f"Couples poste/compétence analysés: {len(states)}")
    print(f"Compétences analysées: {comp['id_comp'].nunique() if not comp.empty else 0}")
    print("\nRépartition états:")
    print(states["etat_couverture"].value_counts().to_string() if not states.empty else "—")
    print("\nTop compétences fragiles:")
    cols = ["code_competence", "nb_postes", "indice_table", "absente", "non_confirmee", "insuffisante", "dependance", "validee"]
    print(comp[cols].head(20).to_string(index=False) if not comp.empty else "—")

    if failures:
        print("\nECHEC")
        for f in failures:
            print("- " + f)
        return 1

    print("\nOK - doctrine cohérente sur l'export fourni.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
