(function () {
  const P = window.PeoplePortal;
  if (!P) return;

  function byId(id){ return document.getElementById(id); }

  function scoreRow(r) {
    const score = (() => {
      const req = String(r.niveau_requis || "").trim();
      const cur = String(r.niveau_actuel || "").trim();
      const map = { A: 1, B: 2, C: 3, I: 2, AV: 3 };
      const s = map[cur] || 0;
      const q = map[req] || 1;
      return s ? Math.min(100, Math.round((s / q) * 100)) : 0;
    })();
    return `<div class="pp-list-row">
      <div><div class="pp-row-title">${P.escapeHtml(r.intitule)}</div><div class="pp-row-sub">${P.escapeHtml(r.code || "")} Â· Niveau requis ${P.levelLabel(r.niveau_requis)} Â· Actuel ${P.levelLabel(r.niveau_actuel)}</div></div>
      <div class="pp-progress"><span style="width:${score}%"></span></div>
    </div>`;
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const data = await P.api(`/people/demo/dashboard/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (data.error) {
      const target = byId("ppDashProfile");
      if (target) target.innerHTML = P.itemEmpty(data.error);
      return;
    }

    const p = data.profile || {};
    const k = data.kpis || {};

    const prenom = (p.prenom || "").trim();
    const prenomEl = byId("ppDashPrenom");
    if (prenomEl) prenomEl.textContent = prenom || "";
    const intro = byId("ppDashIntro");
    if (intro) intro.textContent = `Votre espace personnel pour ${p.nom_owner || "votre entreprise"}.`;

    byId("ppDashMastery").textContent = `${k.maitrise_poste ?? 0}%`;
    byId("ppDashComps").textContent = k.nb_competences ?? 0;
    byId("ppDashForms").textContent = k.nb_formations_programmees ?? 0;
    byId("ppDashBreaks").textContent = k.nb_indisponibilites ?? 0;

    const prof = byId("ppDashProfile");
    if (prof) {
      prof.innerHTML = [
        P.infoRow("Entreprise", p.nom_owner),
        P.infoRow("Service", p.nom_service),
        P.infoRow("Poste", p.intitule_poste),
        P.infoRow("DerniÃ¨re Ã©valuation", k.derniere_evaluation ? P.fmtDate(k.derniere_evaluation) : "Non renseignÃ©e")
      ].join("");
    }

    const list = byId("ppDashCompetences");
    const rows = data.competences_prioritaires || [];
    if (list) list.innerHTML = rows.length ? rows.map(scoreRow).join("") : P.itemEmpty("Aucune compÃ©tence prioritaire trouvÃ©e sur le poste.");
  }

  load();
})();
