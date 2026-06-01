/* ======================================================
   static/menus/skills_dashboard.js
   - Dashboard Insights : santé, risques, transmission, fiabilité
   ====================================================== */

(function () {
  const ALL_SERVICES_VALUE = "__ALL__";

  function byId(id) { return document.getElementById(id); }

  function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pctTxt(v, digits) {
    const n = clamp(v, 0, 100);
    return n.toLocaleString("fr-FR", {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    }) + "%";
  }

  function riskColor(score, inverse) {
    const s = clamp(score, 0, 100) / 100;
    const x = inverse ? (1 - s) : s;
    const hue = Math.round(120 * (1 - x));
    return `hsl(${hue} 70% 44%)`;
  }

  function renderWelcome(ctx) {
    const prenom = (ctx?.prenom || "").toString().trim();
    const elPrenom = byId("welcomePrenom");
    if (!elPrenom) return;
    elPrenom.textContent = prenom || "";
    elPrenom.style.display = prenom ? "inline" : "none";
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + (r * Math.cos(a)), y: cy + (r * Math.sin(a)) };
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
    return ["M", start.x, start.y, "A", r, r, 0, largeArcFlag, 0, end.x, end.y].join(" ");
  }

  function renderHealthGauge(data) {
    const svg = byId("dashHealthGauge");
    const pctEl = byId("dashHealthPct");
    const note = byId("dashHealthNote");
    const scope = byId("dashHealthScope");
    if (!svg) return;

    const pct = clamp(data?.pct ?? 0, 0, 100);
    const color = riskColor(pct, true);
    const angle = -90 + (180 * pct / 100);
    const needle = polarToCartesian(130, 130, 82, angle);

    svg.innerHTML = `
      <path d="${describeArc(130, 130, 92, -90, -30)}" class="sb-health-arc sb-health-arc--bad"></path>
      <path d="${describeArc(130, 130, 92, -30, 35)}" class="sb-health-arc sb-health-arc--mid"></path>
      <path d="${describeArc(130, 130, 92, 35, 90)}" class="sb-health-arc sb-health-arc--good"></path>
      <line x1="130" y1="130" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}" class="sb-health-needle" style="stroke:${color}"></line>
      <circle cx="130" cy="130" r="8" class="sb-health-dot"></circle>
    `;

    if (pctEl) pctEl.textContent = pctTxt(pct, 0);
    if (note) {
      const nb = Number(data?.nb_items || 0);
      note.textContent = nb > 0 ? `${nb.toLocaleString("fr-FR")} point(s) compétences pris en compte` : "Aucune donnée exploitable sur ce périmètre.";
    }
    if (scope) scope.textContent = data?.scope_label ? `Périmètre : ${data.scope_label}` : "Périmètre : —";
  }

  function renderTimeline(points) {
    const host = byId("dashRiskTimeline");
    if (!host) return;
    const list = Array.isArray(points) ? points : [];
    if (!list.length) {
      host.innerHTML = `<div class="sb-risk-loading">Aucune donnée exploitable.</div>`;
      return;
    }

    const maxVal = Math.max(10, ...list.map(p => clamp(p?.indice_fragilite ?? 0, 0, 100)));
    host.innerHTML = list.map((p, idx) => {
      const val = clamp(p?.indice_fragilite ?? 0, 0, 100);
      const h = Math.max(8, Math.round((val / maxVal) * 118));
      const color = riskColor(val, false);
      const label = esc(p?.label || "");
      const nb = Number(p?.nb_postes_fragiles || 0);
      const title = `${label} · indice ${Math.round(val)}% · ${nb} poste(s) fragile(s)`;
      return `
        <div class="sb-risk-timeline-item" title="${esc(title)}">
          <div class="sb-risk-timeline-bar-wrap">
            <div class="sb-risk-timeline-bar" style="height:${h}px; background:${color};"></div>
          </div>
          <div class="sb-risk-timeline-value">${Math.round(val)}</div>
          <div class="sb-risk-timeline-label">${idx === 0 ? "Auj." : label}</div>
        </div>
      `;
    }).join("");
  }

  function pieSlice(cx, cy, r, start, value, total, cls) {
    if (!value || !total) return "";
    const end = start + (360 * value / total);
    const p1 = polarToCartesian(cx, cy, r, start);
    const p2 = polarToCartesian(cx, cy, r, end);
    const large = (end - start) > 180 ? 1 : 0;
    const d = [`M ${cx} ${cy}`, `L ${p1.x} ${p1.y}`, `A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y}`, "Z"].join(" ");
    return { svg: `<path d="${d}" class="${cls}"></path>`, end };
  }

  function renderPostesWatch(data) {
    const svg = byId("dashPostesPie");
    const legend = byId("dashPostesLegend");
    const sub = byId("dashPostesSub");
    const critical = byId("dashCriticalDanger");
    if (!svg) return;

    const total = Math.max(0, Number(data?.total_postes || 0));
    const danger = Math.max(0, Number(data?.postes_danger || 0));
    const watch = Math.max(0, Number(data?.postes_surveillance || 0));
    const stable = Math.max(0, Number(data?.postes_stables || 0));

    if (!total) {
      svg.innerHTML = `<circle cx="80" cy="80" r="62" class="sb-watch-empty"></circle>`;
      if (legend) legend.innerHTML = `<div class="sb-risk-loading">Aucun poste actif.</div>`;
      if (sub) sub.textContent = "Aucun poste actif";
      if (critical) critical.textContent = "0 poste critique détecté";
      return;
    }

    let start = 0;
    const a = pieSlice(80, 80, 68, start, danger, total, "sb-pie-danger");
    start = a ? a.end : start;
    const b = pieSlice(80, 80, 68, start, watch, total, "sb-pie-watch");
    start = b ? b.end : start;
    const c = pieSlice(80, 80, 68, start, stable, total, "sb-pie-stable");

    svg.innerHTML = `${a?.svg || ""}${b?.svg || ""}${c?.svg || ""}<circle cx="80" cy="80" r="38" class="sb-pie-hole"></circle><text x="80" y="77" class="sb-pie-center-main">${total}</text><text x="80" y="96" class="sb-pie-center-sub">postes</text>`;

    if (legend) {
      legend.innerHTML = `
        <div><span class="sb-dot sb-dot--danger"></span>${danger} en danger</div>
        <div><span class="sb-dot sb-dot--watch"></span>${watch} à surveiller</div>
        <div><span class="sb-dot sb-dot--stable"></span>${stable} stabilisés</div>
      `;
    }
    if (sub) sub.textContent = `${danger + watch} poste(s) sous vigilance`;
    if (critical) {
      const n = Number(data?.postes_critiques_danger || 0);
      critical.textContent = `${n} poste(s) critique(s) détecté(s) dans les postes en danger`;
    }
  }

  function renderRiskRing(svg, pct, classPrefix) {
    if (!svg) return;
    const p = clamp(pct, 0, 100);
    const r = 58;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - p / 100);
    const color = riskColor(p, true);
    svg.innerHTML = `
      <circle cx="75" cy="75" r="${r}" class="${classPrefix}-bg"></circle>
      <circle cx="75" cy="75" r="${r}" class="${classPrefix}-fg" style="stroke:${color}; stroke-dasharray:${c.toFixed(2)}; stroke-dashoffset:${offset.toFixed(2)};"></circle>
    `;
  }

  function renderTransmission(data) {
    const pct = clamp(data?.pct ?? 0, 0, 100);
    renderRiskRing(byId("dashTransmissionRing"), pct, "sb-risk-ring");
    const pctEl = byId("dashTransmissionPct");
    const note = byId("dashTransmissionNote");
    if (pctEl) pctEl.textContent = pctTxt(pct, 0);
    if (note) {
      const ok = Number(data?.postes_transmissibles || 0);
      const total = Number(data?.postes_total || 0);
      const risk = Number(data?.postes_risque || 0);
      note.textContent = total > 0 ? `${ok} / ${total} poste(s) transmissibles · ${risk} à risque` : "Aucun poste actif.";
    }
  }

  function renderReliability(data) {
    const pct = clamp(data?.pct ?? 0, 0, 100);
    const bars = byId("dashReliabilityBars");
    const pctEl = byId("dashReliabilityPct");
    const note = byId("dashReliabilityNote");

    const filled = pct >= 85 ? 5 : pct >= 70 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : pct > 0 ? 1 : 0;
    if (bars) {
      bars.innerHTML = [1,2,3,4,5].map(i => `
        <span class="sb-reliability-bar ${i <= filled ? "is-on" : ""}" style="height:${18 + i * 10}px; --rel-color:${riskColor(pct, true)}"></span>
      `).join("");
    }
    if (pctEl) pctEl.textContent = pctTxt(pct, 0);
    if (note) {
      const fresh = Number(data?.fresh_items || 0);
      const total = Number(data?.total_items || 0);
      note.textContent = total > 0 ? `${fresh.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")} donnée(s) fraîches` : "Aucune donnée d’évaluation exploitable.";
    }
  }

  function renderNoAction(data) {
    const count = byId("dashNoActionCount");
    const list = byId("dashNoActionList");
    const rows = Array.isArray(data?.items) ? data.items : [];
    const total = Number(data?.total || 0);

    if (count) count.textContent = Number.isFinite(total) ? String(total) : "0";
    if (!list) return;

    if (!rows.length) {
      list.innerHTML = `<div class="sb-noaction-empty">Aucun poste en danger sans action identifiée.</div>`;
      return;
    }

    list.innerHTML = rows.map(r => {
      const code = (r?.codif_poste || r?.codif_client || "").toString().trim();
      const title = (r?.intitule_poste || "Poste").toString().trim();
      const service = (r?.nom_service || "Service non renseigné").toString().trim();
      const score = clamp(r?.indice_fragilite ?? 0, 0, 100);
      const frag = Number(r?.nb_critiques_fragiles || 0);
      return `
        <div class="sb-noaction-row">
          <div class="sb-noaction-main">
            <div class="sb-noaction-title">${code ? `<span class="sb-badge">${esc(code)}</span>` : ""}<span>${esc(title)}</span></div>
            <div class="sb-noaction-meta">${esc(service)} · ${frag} fragilité(s) critique(s)</div>
          </div>
          <div class="sb-noaction-score" style="--risk-color:${riskColor(score, false)}">${Math.round(score)}%</div>
        </div>
      `;
    }).join("");
  }

  function setLoading() {
    const ids = ["dashHealthNote", "dashRiskTimeline", "dashPostesLegend", "dashTransmissionNote", "dashReliabilityNote", "dashNoActionList"];
    ids.forEach(id => {
      const el = byId(id);
      if (!el) return;
      if (id === "dashRiskTimeline" || id === "dashNoActionList") el.innerHTML = `<div class="sb-risk-loading">Chargement…</div>`;
      else el.textContent = "Chargement…";
    });
  }

  function applyServiceOptions(data, requestedValue) {
    const select = byId("dashboardServiceFilter");
    if (!select) return;

    const access = data?.access || {};
    const locked = !!access.locked_service;
    const services = Array.isArray(data?.services) ? data.services : [];
    const scope = data?.scope || {};

    select.innerHTML = "";
    services.forEach(s => {
      const opt = document.createElement("option");
      const id = (s?.id_service ?? "").toString().trim();
      opt.value = id || ALL_SERVICES_VALUE;
      opt.textContent = (s?.nom_service || (id ? "Service" : "Tout")).toString();
      select.appendChild(opt);
    });

    const effective = (scope?.id_service ?? "").toString().trim() || ALL_SERVICES_VALUE;
    select.value = requestedValue || effective;
    if (![...select.options].some(o => o.value === select.value)) select.value = effective;
    select.disabled = locked;
    select.classList.toggle("is-locked", locked);
  }

  function renderDashboard(data, requestedValue) {
    applyServiceOptions(data, requestedValue);
    renderHealthGauge(data?.health || {});
    renderTimeline(data?.risk_timeline || []);
    renderPostesWatch(data?.postes_watch || {});
    renderTransmission(data?.transmission || {});
    renderReliability(data?.reliability || {});
    renderNoAction(data?.risks_without_action || {});
  }

  async function loadDashboard(portal, serviceValue) {
    setLoading();
    const selected = (serviceValue || "").toString().trim();
    const qs = selected && selected !== ALL_SERVICES_VALUE ? `?id_service=${encodeURIComponent(selected)}` : "";
    const url = `${portal.apiBase}/skills/dashboard/risk-overview/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);
    renderDashboard(data, selected || ALL_SERVICES_VALUE);
  }

  function bindServiceFilter(portal) {
    const select = byId("dashboardServiceFilter");
    if (!select || select._sbDashboardBound) return;
    select._sbDashboardBound = true;
    select.addEventListener("change", async () => {
      try {
        await loadDashboard(portal, select.value || ALL_SERVICES_VALUE);
      } catch (e) {
        portal.showAlert("error", "Erreur dashboard : " + (e?.message || e));
      }
    });
  }

  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        await (window.__skillsAuthReady || Promise.resolve(null));
        portal.showAlert("", "");
        const ctx = portal.context || await portal.ensureContext();
        renderWelcome(ctx);
        bindServiceFilter(portal);
        await loadDashboard(portal, ALL_SERVICES_VALUE);
      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };
})();
