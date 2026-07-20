(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  function byId(id){ return document.getElementById(id); }

  function renderPostes(rows, profile) {
    const el = byId("ppPosteTimeline");
    if (!el) return;
    if (!rows.length) {
      const title = profile?.intitule_poste || "Poste actuel";
      el.innerHTML = `<div class="pp-timeline-item"><div class="pp-dot"></div><div><div class="pp-row-title">${P.escapeHtml(title)}</div><div class="pp-row-sub">Poste actuel</div></div></div>`;
      return;
    }
    el.innerHTML = rows.map(r => `<div class="pp-timeline-item">
      <div class="pp-dot"></div>
      <div><div class="pp-row-title">${P.escapeHtml(r.intitule_poste)}</div><div class="pp-row-sub">${P.fmtDate(r.date_debut)} → ${r.date_fin ? P.fmtDate(r.date_fin) : "Aujourd’hui"}</div><div class="pp-row-sub">${P.escapeHtml(r.commentaire || "")}</div></div>
    </div>`).join("");
  }

  function renderFormations(rows) {
    const el = byId("ppFormationHistory");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = P.itemEmpty("Aucune formation réalisée dans l’historique.");
      return;
    }
    el.innerHTML = rows.map(r => `<div class="pp-list-row"><div><div class="pp-row-title">${P.escapeHtml(r.intitule)}</div><div class="pp-row-sub">${P.fmtDate(r.date_formation)} · ${P.escapeHtml(r.organisme || "Organisme non renseigné")}</div></div>${P.badge(r.source || "formation", "soft")}</div>`).join("");
  }

  function renderChart(rows) {
    const el = byId("ppSkillChart");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = P.itemEmpty("Aucune évaluation historisée pour générer une courbe.");
      return;
    }

    const byComp = new Map();
    rows.forEach(r => {
      const k = r.id_comp || r.intitule;
      if (!byComp.has(k)) byComp.set(k, { label: r.intitule, points: [] });
      byComp.get(k).points.push({ date: String(r.date_audit || "").slice(0,10), value: Number(r.resultat_eval || 0) });
    });
    const series = Array.from(byComp.values()).filter(s => s.points.length).slice(0, 6);
    const allDates = Array.from(new Set(series.flatMap(s => s.points.map(p => p.date)))).sort();
    const maxVal = Math.max(1, ...series.flatMap(s => s.points.map(p => p.value)));
    const w = 860, h = 260, pad = 32;
    const x = d => pad + (allDates.indexOf(d) / Math.max(1, allDates.length - 1)) * (w - pad * 2);
    const y = v => h - pad - (v / maxVal) * (h - pad * 2);
    const colors = ["#284C8D", "#0d9488", "#7c3aed", "#f59e0b", "#dc2626", "#16a34a"];

    const paths = series.map((s, idx) => {
      const pts = s.points.sort((a,b) => a.date.localeCompare(b.date)).map(p => `${x(p.date)},${y(p.value)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${colors[idx % colors.length]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>` +
        s.points.map(p => `<circle cx="${x(p.date)}" cy="${y(p.value)}" r="4" fill="${colors[idx % colors.length]}"></circle>`).join("");
    }).join("");

    const labels = series.map((s, idx) => `<span class="pp-legend"><i style="background:${colors[idx % colors.length]}"></i>${P.escapeHtml(s.label)}</span>`).join("");
    el.innerHTML = `<div class="pp-chart-scroll"><svg viewBox="0 0 ${w} ${h}" class="pp-svg-chart ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-users"></use></svg></div><div class="pp-chart-legend">${labels}</div>`;
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const data = await P.api(`/people/parcours/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (data.error) {
      const el = byId("ppPosteTimeline");
      if (el) el.innerHTML = P.itemEmpty(data.error);
      return;
    }
    renderPostes(data.postes || [], data.profile || {});
    renderFormations(data.formations || []);
    renderChart(data.audits || []);
  }

  load();
})();
