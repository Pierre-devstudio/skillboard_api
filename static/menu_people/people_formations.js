(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  function byId(id){ return document.getElementById(id); }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const cal = await P.api(`/people/demo/calendar/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    const par = await P.api(`/people/demo/parcours/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));

    const up = byId("ppFormUpcoming");
    if (up) {
      if (cal.error) up.innerHTML = P.itemEmpty(cal.error);
      else {
        const rows = cal.formations || [];
        up.innerHTML = rows.length ? rows.map(r => `<div class="pp-list-row"><div><div class="pp-row-title">${P.escapeHtml(r.titre)}</div><div class="pp-row-sub">${P.fmtDate(r.date_debut_formation)} → ${P.fmtDate(r.date_fin_formation)} · ${P.escapeHtml(r.organisme || "Organisme non renseigné")}</div></div>${P.badge(r.etat_action || "programmé", "soft")}</div>`).join("") : P.itemEmpty("Aucune formation programmée.");
      }
    }

    const hist = byId("ppFormHistory");
    if (hist) {
      if (par.error) hist.innerHTML = P.itemEmpty(par.error);
      else {
        const rows = par.formations || [];
        hist.innerHTML = rows.length ? rows.map(r => `<div class="pp-list-row"><div><div class="pp-row-title">${P.escapeHtml(r.intitule)}</div><div class="pp-row-sub">${P.fmtDate(r.date_formation)} · ${P.escapeHtml(r.organisme || "Organisme non renseigné")}</div></div>${P.badge(r.source || "formation", "soft")}</div>`).join("") : P.itemEmpty("Aucune formation réalisée dans l’historique.");
      }
    }
  }

  load();
})();
