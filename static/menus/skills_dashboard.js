/* ======================================================
   static/menus/skills_dashboard.js
   - Dashboard Insights : santé, risques, transmission, fiabilité
   - Réutilisé aussi en mode embarqué dans Studio > Espace de gestion.
   - Toute évolution du dashboard doit préserver :
     1) la route Insights classique /skills/dashboard/...
     2) la route Studio embarquée /studio/clients/.../dashboard/...
     3) le sélecteur d'organisation injecté par Studio.
   ====================================================== */

(function () {
  const ALL_SERVICES_VALUE = "__ALL__";
  const DEFAULT_CRITICITE_MIN = 70;

  let _portal = null;
  let _lastData = null;

  const HELP_TEXTS = {
    health: {
      title: "Santé globale",
      body: "Cet indicateur synthétise quatre dimensions du périmètre : robustesse des postes, robustesse des compétences, fiabilité des données et capacité de transmission. Le score est pondéré pour donner plus de poids aux risques opérationnels et à la transmission des savoir-faire."
    },
    timeline: {
      title: "Évolution des risques",
      body: "Ce graphique montre l’évolution mensuelle de l’indice de fragilité des postes. Il s’appuie sur les données connues dans Novoskill, dont les sorties prévues et les indisponibilités enregistrées."
    },
    postes: {
      title: "Postes à surveiller",
      body: "Cette carte répartit les postes du périmètre entre postes en danger, postes à surveiller et postes stabilisés. Elle permet de voir immédiatement la part de l’organisation sous vigilance."
    },
    transmission: {
      title: "Capacité de transmission",
      body: "Cet indicateur mesure la capacité à transmettre les savoir-faire nécessaires pour réaliser l’ensemble des tâches des postes du périmètre. Une capacité faible signale un risque de perte de savoir-faire."
    },
    reliability: {
      title: "Fiabilité des données analysées",
      body: "Cet indicateur mesure la fraîcheur des données utilisées pour établir le diagnostic. Les données sont considérées comme fraîches lorsqu’elles ont été mises à jour depuis moins de 6 mois."
    },
    noaction: {
      title: "Risques sans action",
      body: "Cette carte liste les postes en danger pour lesquels aucune action de sécurisation n’est identifiée dans Novoskill : formation planifiée, entretien préparé ou autre levier de sécurisation modélisé."
    }
  };

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

  function numTxt(v, digits = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("fr-FR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function riskColor(score, inverse) {
    const s = clamp(score, 0, 100) / 100;
    const x = inverse ? (1 - s) : s;
    const hue = Math.round(120 * (1 - x));
    return `hsl(${hue} 70% 44%)`;
  }

  function currentCriticiteMin() {
    const el = byId("dashboardCriticiteFilter");
    return clamp(el?.value ?? DEFAULT_CRITICITE_MIN, 0, 100);
  }

  function updateCriticiteLabel(value) {
    const label = byId("dashboardCriticiteValue");
    if (label) label.textContent = `≥ ${Math.round(clamp(value, 0, 100))}`;
  }

  function healthStatus(pct) {
    const p = clamp(pct, 0, 100);
    if (p >= 92) return { label: "Robuste", cls: "sb-health-status--robust" };
    if (p >= 80) return { label: "Solide", cls: "sb-health-status--solid" };
    if (p >= 65) return { label: "Correct", cls: "sb-health-status--ok" };
    if (p >= 50) return { label: "Sous vigilance", cls: "sb-health-status--watch" };
    return { label: "Fragile", cls: "sb-health-status--danger" };
  }

  function renderWelcome(ctx, portal) {
    const root = byId("view-dashboard");
    const titleEl = byId("welcomeTitle");
    const logoWrap = root?.querySelector(".sb-dashboard-logo-wrap");
    const embeddedTitle = (portal?.dashboardTitle || "").toString().trim();

    if (root) {
      root.classList.toggle("is-embedded-studio", portal?.embeddedMode === "studio_client_space");
    }

    if (logoWrap) {
      logoWrap.style.display = portal?.dashboardHideLogo ? "none" : "";
    }

    if (embeddedTitle && titleEl) {
      titleEl.textContent = embeddedTitle;
      return;
    }

    if (titleEl && !titleEl.querySelector("#welcomePrenom")) {
      titleEl.innerHTML = 'Bienvenue <span id="welcomePrenom"></span>';
    }

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
    const statusEl = byId("dashHealthStatus");
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
    if (scope) scope.textContent = data?.scope_label ? `Périmètre : ${data.scope_label}` : "Périmètre : —";

    if (statusEl) {
      const st = healthStatus(pct);
      statusEl.className = `sb-health-status ${st.cls}`;
      statusEl.textContent = st.label;
    }

    if (note) {
      const nb = Number(data?.nb_items || 0);
      note.textContent = nb > 0 ? "" : "Aucune donnée exploitable sur ce périmètre.";
      note.classList.toggle("is-empty", nb > 0);
    }
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
          <div class="sb-risk-timeline-value">${Math.round(val)}%</div>
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
    const critical = byId("dashCriticalDanger");
    if (!svg) return;

    const total = Math.max(0, Number(data?.total_postes || 0));
    const danger = Math.max(0, Number(data?.postes_danger || 0));
    const watch = Math.max(0, Number(data?.postes_surveillance || 0));
    const stable = Math.max(0, Number(data?.postes_stables || 0));

    if (!total) {
      svg.innerHTML = `<circle cx="80" cy="80" r="62" class="sb-watch-empty"></circle>`;
      if (legend) legend.innerHTML = `<div class="sb-risk-loading">Aucun poste actif.</div>`;
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
    if (pctEl) pctEl.textContent = pctTxt(pct, 0);
  }

  function renderReliability(data) {
    const pct = clamp(data?.pct ?? 0, 0, 100);
    const bars = byId("dashReliabilityBars");
    const pctEl = byId("dashReliabilityPct");

    const filled = pct >= 85 ? 5 : pct >= 70 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : pct > 0 ? 1 : 0;
    if (bars) {
      bars.innerHTML = [1,2,3,4,5].map(i => `
        <span class="sb-reliability-bar ${i <= filled ? "is-on" : ""}" style="height:${18 + i * 10}px; --rel-color:${riskColor(pct, true)}"></span>
      `).join("");
    }
    if (pctEl) pctEl.textContent = pctTxt(pct, 0);
  }

  function posteBadge(r) {
    const code = (r?.codif_client || r?.codif_poste || "").toString().trim();
    return code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : "";
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

    list.innerHTML = rows.slice(0, 6).map(r => {
      const title = (r?.intitule_poste || "Poste").toString().trim();
      const service = (r?.nom_service || "Service non renseigné").toString().trim();
      return `
        <div class="sb-noaction-row">
          <div class="sb-noaction-main">
            <div class="sb-noaction-title">${posteBadge(r)}<span>${esc(title)}</span></div>
            <div class="sb-noaction-meta">${esc(service)} · Aucune action identifiée</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderNoActionModal() {
    const tbody = byId("dashboardNoActionRows");
    if (!tbody) return;
    const rows = Array.isArray(_lastData?.risks_without_action?.items) ? _lastData.risks_without_action.items : [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="sb-muted">Aucun poste en danger sans action identifiée.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const title = (r?.intitule_poste || "Poste").toString().trim();
      const service = (r?.nom_service || "Service non renseigné").toString().trim();
      const criticite = Number(r?.criticite_poste || 0);
      const titulaires = `${Number(r?.nb_titulaires || 0)} / ${Number(r?.nb_titulaires_cible || 0)}`;
      const indice = clamp(r?.indice_fragilite ?? 0, 0, 100);
      const points = [];
      if (Number(r?.nb_critiques_sans_porteur || 0) > 0) points.push(`${Number(r.nb_critiques_sans_porteur)} critique(s) sans porteur`);
      if (Number(r?.nb_critiques_sans_releve || 0) > 0) points.push(`${Number(r.nb_critiques_sans_releve)} critique(s) sans relève`);
      if (Number(r?.nb_critiques_fragiles || 0) > 0) points.push(`${Number(r.nb_critiques_fragiles)} fragilité(s) critique(s)`);
      return `
        <tr>
          <td><div class="sb-dashboard-poste-cell">${posteBadge(r)}<span>${esc(title)}</span></div></td>
          <td>${esc(service)}</td>
          <td class="col-center">${criticite || "—"}</td>
          <td class="col-center">${esc(titulaires)}</td>
          <td class="col-center"><span class="sb-badge sb-badge--danger">${Math.round(indice)}%</span></td>
          <td>${esc(points.length ? points.join(" · ") : "Aucune action de sécurisation identifiée")}</td>
        </tr>
      `;
    }).join("");
  }

  function setLoading() {
    const ids = ["dashRiskTimeline", "dashPostesLegend", "dashNoActionList"];
    ids.forEach(id => {
      const el = byId(id);
      if (!el) return;
      el.innerHTML = `<div class="sb-risk-loading">Chargement…</div>`;
    });

    const healthNote = byId("dashHealthNote");
    if (healthNote) {
      healthNote.textContent = "";
      healthNote.classList.add("is-empty");
    }
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

  function applyCriticiteValue(data, requestedValue) {
    const input = byId("dashboardCriticiteFilter");
    const value = clamp(data?.filters?.criticite_min ?? requestedValue ?? DEFAULT_CRITICITE_MIN, 0, 100);
    if (input) input.value = String(Math.round(value));
    updateCriticiteLabel(value);
  }

  function normalizeOrganisationOptions(portal) {
    const rows = Array.isArray(portal?.dashboardOrganisations) ? portal.dashboardOrganisations : [];
    return rows
      .map(r => ({
        id_ent: (r?.id_ent || r?.id || "").toString().trim(),
        label: (r?.label || r?.nom_ent || "Organisation").toString().trim(),
        depth: Number(r?.depth || 0) || 0,
        type_entreprise: (r?.type_entreprise || "").toString().trim(),
      }))
      .filter(r => r.id_ent);
  }

  function currentOrganisationValue(portal) {
    const select = byId("dashboardOrganisationFilter");
    const fallback = (portal?.dashboardOrganisationValue || portal?.dashboardEntId || "").toString().trim();
    return (select?.value || fallback || "").toString().trim();
  }

  function applyOrganisationOptions(portal) {
    const wrap = byId("dashboardOrganisationWrap");
    const select = byId("dashboardOrganisationFilter");
    if (!wrap || !select) return;

    const rows = normalizeOrganisationOptions(portal);
    if (rows.length <= 1) {
      wrap.style.display = "none";
      select.innerHTML = "";
      if (rows.length === 1) {
        const opt = document.createElement("option");
        opt.value = rows[0].id_ent;
        opt.textContent = rows[0].label;
        select.appendChild(opt);
        select.value = rows[0].id_ent;
      }
      return;
    }

    const requested = (portal?.dashboardOrganisationValue || rows[0]?.id_ent || "").toString().trim();
    select.innerHTML = "";
    rows.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id_ent;
      const indent = r.depth > 0 ? `${"— ".repeat(Math.min(r.depth, 4))}` : "";
      const type = r.type_entreprise ? ` · ${r.type_entreprise}` : "";
      opt.textContent = `${indent}${r.label}${type}`;
      select.appendChild(opt);
    });

    select.value = rows.some(r => r.id_ent === requested) ? requested : rows[0].id_ent;
    wrap.style.display = "flex";
  }

  function renderDashboard(data, requestedValue, requestedCriticite) {
    _lastData = data || {};
    applyServiceOptions(data, requestedValue);
    applyCriticiteValue(data, requestedCriticite);
    renderHealthGauge(data?.health || {});
    renderTimeline(data?.risk_timeline || []);
    renderPostesWatch(data?.postes_watch || {});
    renderTransmission(data?.transmission || {});
    renderReliability(data?.reliability || {});
    renderNoAction(data?.risks_without_action || {});
  }

  async function loadDashboard(portal, serviceValue, criticiteMin) {
    setLoading();
    const selected = (serviceValue || "").toString().trim();
    const criticite = clamp(criticiteMin ?? currentCriticiteMin(), 0, 100);
    const orgValue = currentOrganisationValue(portal);

    let url = "";
    if (typeof portal?.dashboardRiskOverviewUrl === "function") {
      url = portal.dashboardRiskOverviewUrl({
        id_ent: orgValue,
        id_service: selected && selected !== ALL_SERVICES_VALUE ? selected : "",
        criticite_min: Math.round(criticite),
      });
    } else {
      const params = new URLSearchParams();
      if (selected && selected !== ALL_SERVICES_VALUE) params.set("id_service", selected);
      params.set("criticite_min", String(Math.round(criticite)));
      const qs = params.toString() ? `?${params.toString()}` : "";
      url = `${portal.apiBase}/skills/dashboard/risk-overview/${encodeURIComponent(portal.contactId)}${qs}`;
    }

    const data = await portal.apiJson(url);
    renderDashboard(data, selected || ALL_SERVICES_VALUE, criticite);
  }

  function openModal(id) {
    const modal = byId(id);
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(id) {
    const modal = byId(id);
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function openInfo(kind) {
    const cfg = HELP_TEXTS[kind];
    if (!cfg) return;
    const title = byId("dashboardInfoTitle");
    const body = byId("dashboardInfoBody");
    if (title) title.textContent = cfg.title;
    if (body) body.textContent = cfg.body;
    openModal("dashboardInfoModal");
  }

  function healthDetailInterpretation(pct) {
    const p = clamp(pct, 0, 100);
    if (p >= 92) return "La situation globale est robuste : les postes, compétences, données et capacités de transmission sont globalement sécurisés.";
    if (p >= 80) return "La situation globale est solide, avec quelques points de vigilance à confirmer dans les détails.";
    if (p >= 65) return "La situation reste correcte, mais plusieurs composantes peuvent déjà fragiliser la continuité.";
    if (p >= 50) return "Le périmètre est sous vigilance : la transmission, la fiabilité ou la couverture des postes doivent être consolidées.";
    return "Le périmètre est fragile : les risques actuels pèsent fortement sur la continuité ou la transmission des savoir-faire.";
  }

  function healthComponentRowsHtml(components) {
    const rows = Array.isArray(components) ? components : [];
    if (!rows.length) {
      return `<tr><td colspan="4" class="sb-muted">Aucun détail de calcul disponible.</td></tr>`;
    }

    return rows.map(c => {
      const label = (c?.label || "Composante").toString();
      const pct = Number(c?.pct);
      const weight = Number(c?.weight);
      const weighted = Number(c?.weighted_score);
      const source = (c?.source || "Calcul issu du moteur analyse.").toString();
      return `
        <tr>
          <td><strong>${esc(label)}</strong><div class="card-sub" style="margin:3px 0 0 0;">${esc(source)}</div></td>
          <td class="col-center">${Number.isFinite(pct) ? pctTxt(pct, 0) : "—"}</td>
          <td class="col-center">${Number.isFinite(weight) ? `${Math.round(weight)}%` : "—"}</td>
          <td class="col-center"><strong>${Number.isFinite(weighted) ? numTxt(weighted, 1) : "—"}</strong></td>
        </tr>
      `;
    }).join("");
  }

  function renderHealthDetailModal() {
    const body = byId("dashboardHealthDetailBody");
    if (!body) return;

    const health = _lastData?.health || {};
    const filters = _lastData?.filters || {};
    const pct = clamp(health?.pct ?? 0, 0, 100);
    const st = healthStatus(pct);
    const score = Number(health?.score);
    const maxScore = Number(health?.max_score);
    const nbItems = Number(health?.nb_items);
    const scoreLabel = (Number.isFinite(score) && Number.isFinite(maxScore) && maxScore > 0)
      ? `${numTxt(score, 1)} / ${numTxt(maxScore, 0)}`
      : "—";
    const nbLabel = Number.isFinite(nbItems) ? numTxt(nbItems, 0) : "—";
    const scopeLabel = health?.scope_label || _lastData?.scope?.nom_service || "—";
    const criticite = Number(filters?.criticite_min);
    const criticiteLabel = Number.isFinite(criticite) ? `≥ ${Math.round(criticite)}` : "—";

    body.innerHTML = `
      <div class="sb-stack">
        <div class="card" style="padding:12px; margin:0;">
          <div class="sb-block-title" style="margin-bottom:8px;">Lecture immédiate</div>
          <div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap;">
            <div style="font-size:28px; font-weight:800; color:#111827; line-height:1;">${pctTxt(pct, 0)}</div>
            <span class="sb-health-status ${esc(st.cls)}" style="margin:0;">${esc(st.label)}</span>
          </div>
          <div class="card-sub" style="margin:8px 0 0 0;">${esc(healthDetailInterpretation(pct))}</div>
        </div>

        <div class="sb-dashboard-table-wrap">
          <table class="sb-table sb-table--airy sb-table--zebra sb-dashboard-detail-table">
            <tbody>
              <tr>
                <th style="width:38%;">Périmètre</th>
                <td>${esc(scopeLabel)}</td>
              </tr>
              <tr>
                <th>Criticité prise en compte</th>
                <td>${esc(criticiteLabel)}</td>
              </tr>
              <tr>
                <th>Postes analysés</th>
                <td>${esc(nbLabel)}</td>
              </tr>
              <tr>
                <th>Score pondéré</th>
                <td>${esc(scoreLabel)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="sb-dashboard-table-wrap">
          <table class="sb-table sb-table--airy sb-table--zebra sb-dashboard-detail-table">
            <thead>
              <tr>
                <th>Composante</th>
                <th class="col-center">Résultat</th>
                <th class="col-center">Poids</th>
                <th class="col-center">Points</th>
              </tr>
            </thead>
            <tbody>
              ${healthComponentRowsHtml(health?.components)}
            </tbody>
          </table>
        </div>

        <div class="card" style="padding:12px; margin:0;">
          <div class="sb-block-title" style="margin-bottom:8px;">Comment lire la jauge</div>
          <div class="card-sub" style="margin:0; line-height:1.45;">
            La jauge n’est plus le simple inverse de la fragilité des postes. Elle combine quatre résultats :
            robustesse des postes (40%), robustesse des compétences (25%), fiabilité des données (15%)
            et capacité de transmission (20%). Le statut traduit ce score global en lecture RH : fragile, sous vigilance, correct, solide ou robuste.
          </div>
        </div>
      </div>
    `;

    openModal("dashboardHealthDetailModal");
  }

  async function openReport(target) {
    if (target === "noaction") {
      renderNoActionModal();
      openModal("dashboardNoActionModal");
      return;
    }

    if (typeof _portal?.openDashboardReport === "function") {
      await _portal.openDashboardReport(target);
      return;
    }

    if (!_portal?.switchView) return;
    if (target === "entretien") {
      await _portal.switchView("entretien-performance");
      return;
    }
    await _portal.switchView("analyse-competences");
  }

  function bindOrganisationFilter(portal) {
    const select = byId("dashboardOrganisationFilter");
    if (!select || select._sbDashboardBound) return;
    select._sbDashboardBound = true;
    select.addEventListener("change", async () => {
      try {
        if (typeof portal?.onDashboardOrganisationChange === "function") {
          await portal.onDashboardOrganisationChange(select.value || "");
        }
        await loadDashboard(portal, ALL_SERVICES_VALUE, currentCriticiteMin());
      } catch (e) {
        portal.showAlert("error", "Erreur dashboard : " + (e?.message || e));
      }
    });
  }

  function bindServiceFilter(portal) {
    const select = byId("dashboardServiceFilter");
    if (!select || select._sbDashboardBound) return;
    select._sbDashboardBound = true;
    select.addEventListener("change", async () => {
      try {
        await loadDashboard(portal, select.value || ALL_SERVICES_VALUE, currentCriticiteMin());
      } catch (e) {
        portal.showAlert("error", "Erreur dashboard : " + (e?.message || e));
      }
    });
  }

  function bindCriticiteFilter(portal) {
    const input = byId("dashboardCriticiteFilter");
    if (!input || input._sbDashboardBound) return;
    input._sbDashboardBound = true;
    input.addEventListener("input", () => updateCriticiteLabel(input.value));
    input.addEventListener("change", async () => {
      try {
        await loadDashboard(portal, byId("dashboardServiceFilter")?.value || ALL_SERVICES_VALUE, currentCriticiteMin());
      } catch (e) {
        portal.showAlert("error", "Erreur dashboard : " + (e?.message || e));
      }
    });
  }

  function bindDashboardActions() {
    const root = byId("view-dashboard");
    if (!root || root._sbDashboardActionsBound) return;
    root._sbDashboardActionsBound = true;

    root.addEventListener("click", async (e) => {
      const helpBtn = e.target.closest("[data-dash-help]");
      if (helpBtn) {
        openInfo(helpBtn.getAttribute("data-dash-help"));
        return;
      }

      const detailBtn = e.target.closest("[data-dash-detail]");
      if (detailBtn) {
        const kind = (detailBtn.getAttribute("data-dash-detail") || "").trim();
        if (kind === "health") renderHealthDetailModal();
        return;
      }

      const reportBtn = e.target.closest("[data-dash-report]");
      if (reportBtn) {
        try {
          await openReport(reportBtn.getAttribute("data-dash-report"));
        } catch (err) {
          _portal?.showAlert?.("error", "Erreur ouverture du détail : " + (err?.message || err));
        }
      }
    });

    ["dashboardInfoClose", "dashboardInfoClose2"].forEach(id => {
      const btn = byId(id);
      if (btn) btn.addEventListener("click", () => closeModal("dashboardInfoModal"));
    });

    ["dashboardHealthDetailClose", "dashboardHealthDetailClose2"].forEach(id => {
      const btn = byId(id);
      if (btn) btn.addEventListener("click", () => closeModal("dashboardHealthDetailModal"));
    });

    ["dashboardNoActionClose", "dashboardNoActionClose2"].forEach(id => {
      const btn = byId(id);
      if (btn) btn.addEventListener("click", () => closeModal("dashboardNoActionModal"));
    });
  }

  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        _portal = portal;
        await (window.__skillsAuthReady || Promise.resolve(null));
        portal.showAlert("", "");
        const ctx = portal.context || await portal.ensureContext();
        renderWelcome(ctx, portal);
        applyOrganisationOptions(portal);
        bindOrganisationFilter(portal);
        bindServiceFilter(portal);
        bindCriticiteFilter(portal);
        bindDashboardActions();
        updateCriticiteLabel(currentCriticiteMin());
        await loadDashboard(portal, ALL_SERVICES_VALUE, currentCriticiteMin());
      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };
})();
