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
      body: "Cet indicateur synthétise quatre dimensions du périmètre : robustesse des postes, robustesse des compétences, fiabilité des données et capacité de transmission. La transmission est calculée sur les compétences disposant d’un transmetteur Expert ou Avancé haut."
    },
    timeline: {
      title: "Évolution des risques",
      body: "Ce graphique montre l’évolution mensuelle de l’indice de fragilité des postes. Il s’appuie sur les données connues dans Novoskill, dont les sorties prévues et les indisponibilités enregistrées."
    },
    postes: {
      title: "Postes à surveiller",
      body: "Cette carte répartit les postes du périmètre selon leur indice de fragilité : stable en dessous de 25 %, à surveiller de 25 % à 64 %, en danger à partir de 65 %. Elle permet de voir immédiatement la part de l’organisation sous vigilance."
    },
    transmission: {
      title: "Capacité de transmission",
      body: "Cet indicateur mesure la part des compétences du périmètre disposant d’une transmission validée ou à confirmer. Un transmetteur est identifié lorsqu’il est Expert ou en Avancé haut avec un score d’au moins 63 %."
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

  const HEALTH_COMPONENT_HELP = {
    postes: {
      title: "Robustesse des postes",
      body: "Mesure la solidité des postes du périmètre. Plus le score est élevé, moins les postes analysés cumulent de fragilités : titulaires insuffisants, compétences critiques fragiles, absence de relève ou couverture trop faible."
    },
    competences: {
      title: "Robustesse des compétences",
      body: "Mesure la solidité des compétences sensibles du périmètre. Un score élevé signifie que les compétences utiles aux postes restent maîtrisées par suffisamment de collaborateurs, avec moins de zones critiques à traiter."
    },
    fiabilite: {
      title: "Fiabilité des données",
      body: "Mesure la fraîcheur des données utilisées pour calculer le diagnostic. Plus le score est élevé, plus les évaluations et informations exploitées sont récentes, donc plus la lecture du risque est fiable."
    },
    transmission: {
      title: "Capacité de transmission",
      body: "Mesure la part des compétences disposant déjà d’un relais interne validé ou à confirmer. Un bon score indique que les savoir-faire peuvent être transmis sans dépendre d’une seule personne."
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
    return code ? `<span class="ns-badge sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : "";
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
          <td class="col-center"><span class="ns-badge sb-badge sb-badge--danger">${Math.round(indice)}%</span></td>
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

  function openHealthComponentInfo(key) {
    const cfg = HEALTH_COMPONENT_HELP[(key || "").toString().trim()];
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

  function healthTone(pct) {
    const p = clamp(pct, 0, 100);
    if (p >= 92) return "robust";
    if (p >= 80) return "solid";
    if (p >= 65) return "ok";
    if (p >= 50) return "watch";
    return "danger";
  }

  function healthToneIcon(tone) {
    if (tone === "robust" || tone === "solid") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-7465f1b17497"></use></svg>
      `;
    }
    if (tone === "danger") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-7cd893ed60a5"></use></svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
    `;
  }

  function healthComponentIcon(key) {
    const k = (key || "").toString();
    if (k === "competences") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
      `;
    }
    if (k === "fiabilite") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-c4e47578bd15"></use></svg>
      `;
    }
    if (k === "transmission") {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-a708db67a7a0"></use></svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-9bf44221f8c8"></use></svg>
    `;
  }

  function healthMetaIcon(kind) {
    const icons = {
      scope: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-criticality"></use></svg>`,
      criticite: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-job"></use></svg>`,
      postes: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-job"></use></svg>`,
      score: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-job"></use></svg>`
    };
    return icons[kind] || icons.score;
  }

  function healthComponentDefaults() {
    return [
      {
        key: "postes",
        label: "Robustesse des postes",
        weight: 40,
        source: "Inverse de la fragilité moyenne des postes issue du moteur analyse."
      },
      {
        key: "competences",
        label: "Robustesse des compétences",
        weight: 25,
        source: "Inverse de la fragilité moyenne des compétences fragiles du périmètre."
      },
      {
        key: "fiabilite",
        label: "Fiabilité des données",
        weight: 15,
        source: "Part des évaluations récentes sur les éléments analysés."
      },
      {
        key: "transmission",
        label: "Capacité de transmission",
        weight: 20,
        source: "Part des compétences disposant d'une transmission validée ou à confirmer."
      }
    ];
  }

  function normalizeHealthComponents(components) {
    const rows = Array.isArray(components) ? components : [];
    const byKey = new Map();
    rows.forEach(c => {
      const key = (c?.key || "").toString().trim();
      if (key) byKey.set(key, c);
    });

    return healthComponentDefaults().map(def => {
      const row = byKey.get(def.key) || {};
      const pct = Number(row?.pct);
      const weight = Number(row?.weight);
      return {
        ...def,
        ...row,
        key: def.key,
        label: row?.label || def.label,
        source: row?.source || def.source,
        pct: Number.isFinite(pct) ? clamp(pct, 0, 100) : 0,
        weight: Number.isFinite(weight) ? Math.round(clamp(weight, 0, 100)) : def.weight
      };
    });
  }

  function healthComponentCardsHtml(components) {
    const rows = normalizeHealthComponents(components);
    return rows.map(c => {
      const pct = clamp(c?.pct ?? 0, 0, 100);
      const tone = healthTone(pct);
      const weight = Number.isFinite(Number(c?.weight)) ? Math.round(Number(c.weight)) : 0;
      const label = (c?.label || "Composante").toString();
      const key = (c?.key || "").toString();
      return `
        <div class="sb-dashboard-component-card sb-dashboard-tone--${esc(tone)}">
          <div class="sb-dashboard-component-head">
            <span class="sb-dashboard-component-icon">${healthComponentIcon(key)}</span>
            <div class="sb-dashboard-component-title">${esc(label)}</div>
            <button type="button" class="sb-dashboard-help-dot" data-health-component-help="${esc(key)}" aria-label="Comprendre ${esc(label)}">?</button>
          </div>
          <div class="sb-dashboard-component-value">${pctTxt(pct, 0)}</div>
          <div class="sb-dashboard-progress" aria-hidden="true">
            <span style="width:${pct.toFixed(1)}%;"></span>
          </div>
          <div class="sb-dashboard-component-sub">Part dans la jauge : <strong>${weight}%</strong></div>
        </div>
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
    const tone = healthTone(pct);
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
      <div class="sb-stack sb-dashboard-health-detail">
        <div class="sb-dashboard-health-hero sb-dashboard-tone--${esc(tone)}">
          <div class="sb-dashboard-health-hero-icon">${healthToneIcon(tone)}</div>
          <div class="sb-dashboard-health-hero-main">
            <div class="sb-dashboard-health-hero-line">
              <div class="sb-dashboard-health-hero-score">${pctTxt(pct, 0)}</div>
              <span class="ns-badge sb-health-status ${esc(st.cls)}">${esc(st.label)}</span>
            </div>
            <div class="sb-dashboard-health-hero-text">${esc(healthDetailInterpretation(pct))}</div>
          </div>
        </div>

        <div class="sb-dashboard-meta-grid">
          <div class="sb-dashboard-meta-card">
            <span>${healthMetaIcon("scope")}</span>
            <div><div>Périmètre</div><strong>${esc(scopeLabel)}</strong></div>
          </div>
          <div class="sb-dashboard-meta-card">
            <span>${healthMetaIcon("criticite")}</span>
            <div><div>Criticité</div><strong>${esc(criticiteLabel)}</strong></div>
          </div>
          <div class="sb-dashboard-meta-card">
            <span>${healthMetaIcon("postes")}</span>
            <div><div>Postes analysés</div><strong>${esc(nbLabel)}</strong></div>
          </div>
          <div class="sb-dashboard-meta-card">
            <span>${healthMetaIcon("score")}</span>
            <div><div>Score pondéré</div><strong>${esc(scoreLabel)}</strong></div>
          </div>
        </div>

        <div class="sb-dashboard-health-components">
          ${healthComponentCardsHtml(health?.components)}
        </div>

        <div class="sb-dashboard-read-block">
          <div class="sb-dashboard-read-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-b023effc5040"></use></svg>
          </div>
          <div>
            <div class="sb-dashboard-read-title">Comment lire la jauge</div>
            <div class="sb-dashboard-read-text">
              Cette jauge agrège quatre résultats pondérés : <strong>robustesse des postes (40%)</strong>,
              <strong>robustesse des compétences (25%)</strong>, <strong>fiabilité des données (15%)</strong>
              et <strong>capacité de transmission (20%)</strong>. Plus le score est élevé, plus le périmètre est sécurisé.
              Le statut traduit ce score en lecture opérationnelle : fragile, sous vigilance, correct, solide ou robuste.
            </div>
          </div>
        </div>
      </div>
    `;

    openModal("dashboardHealthDetailModal");
  }

  function transmissionStatusClass(key) {
    const k = (key || "").toString();
    if (k === "validated") return "sb-dashboard-status--validated";
    if (k === "confirm") return "sb-dashboard-status--confirm";
    if (k === "review") return "sb-dashboard-status--review";
    return "sb-dashboard-status--none";
  }

  function transmissionStatusBadge(key, label) {
    return `<span class="ns-badge sb-dashboard-status ${transmissionStatusClass(key)}">${esc(label || "À qualifier")}</span>`;
  }

  function transmissionRelayHtml(item) {
    const rows = Array.isArray(item?.transmetteurs) ? item.transmetteurs : [];
    if (!rows.length) return `<span class="sb-muted">—</span>`;

    const t = rows[0] || {};
    const full = (t?.full || "Collaborateur").toString();
    const niveau = (t?.niveau_label || "À qualifier").toString();
    const score = Number(t?.score_pct);
    const scoreTxt = Number.isFinite(score) ? ` · ${numTxt(score, 0)}%` : "";
    const dateTxt = (t?.date_derniere_eval || "Date à confirmer").toString();
    const poste = (t?.codif_poste || t?.intitule_poste || "").toString().trim();
    const meta = poste ? `${niveau}${scoreTxt} · ${dateTxt} · ${poste}` : `${niveau}${scoreTxt} · ${dateTxt}`;
    const more = rows.length > 1 ? `<span class="sb-dashboard-person-more-inline">+ ${rows.length - 1}</span>` : "";

    return `
      <div class="sb-dashboard-person-line sb-dashboard-person-line--inline">
        <strong>${esc(full)}</strong>
        <span>${esc(meta)}</span>
        ${more}
      </div>
    `;
  }

  function transmissionGroupRowsHtml(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      return `<tr><td colspan="3" class="sb-muted">Aucune compétence analysable sur ce périmètre.</td></tr>`;
    }

    const groups = [
      { key: "none", label: "Priorité élevée", cls: "sb-dashboard-priority--high", keys: ["none"] },
      { key: "review", label: "À vérifier", cls: "sb-dashboard-priority--review", keys: ["review"] },
      { key: "confirm", label: "À confirmer", cls: "sb-dashboard-priority--medium", keys: ["confirm"] },
      { key: "validated", label: "Sécurisées", cls: "sb-dashboard-priority--low", keys: ["validated"] }
    ];

    return groups.map(group => {
      const groupRows = rows.filter(item => group.keys.includes((item?.status_key || "none").toString()));
      if (!groupRows.length) return "";
      const header = `
        <tr class="sb-dashboard-priority-row ${group.cls}">
          <td colspan="3"><span></span><strong>${esc(group.label)}</strong><em>${numTxt(groupRows.length, 0)} compétence(s)</em></td>
        </tr>
      `;
      const detail = groupRows.map(item => {
        const code = (item?.code || "").toString().trim();
        const title = (item?.intitule || "Compétence").toString().trim();
        const statusKey = (item?.status_key || "none").toString();
        const statusLabel = (item?.status_label || "Aucun transmetteur").toString();
        return `
          <tr>
            <td>
              <div class="sb-dashboard-comp-cell">
                ${code ? `<span class="ns-badge sb-badge sb-badge-ref-comp-code">${esc(code)}</span>` : ""}
                <span>${esc(title)}</span>
              </div>
            </td>
            <td class="col-center">${transmissionStatusBadge(statusKey, statusLabel)}</td>
            <td>${transmissionRelayHtml(item)}</td>
          </tr>
        `;
      }).join("");
      return header + detail;
    }).join("");
  }

  function dashboardRatio(count, total) {
    const c = Number(count);
    const t = Number(total);
    if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return 0;
    return clamp((c / t) * 100, 0, 100);
  }

  function transmissionSegmentStyle(count, total, fallbackMin) {
    const pct = dashboardRatio(count, total);
    if (pct <= 0) return "width:0; min-width:0; padding:0; overflow:hidden;";
    const min = Number.isFinite(Number(fallbackMin)) ? Number(fallbackMin) : 38;
    return `width:${pct.toFixed(2)}%; min-width:${min}px;`;
  }

  function transmissionAttentionItemsHtml(items, statusKeys, limit) {
    const keys = Array.isArray(statusKeys) ? statusKeys : [statusKeys];
    const rows = (Array.isArray(items) ? items : []).filter(item => keys.includes((item?.status_key || "none").toString()));
    if (!rows.length) return `<div class="sb-muted">Aucun élément prioritaire sur ce statut.</div>`;

    const max = Number.isFinite(Number(limit)) ? Number(limit) : 5;
    const visible = rows.slice(0, max).map(item => {
      const code = (item?.code || "").toString().trim();
      const title = (item?.intitule || "Compétence").toString().trim();
      return `
        <li>
          ${code ? `<span class="ns-badge sb-badge sb-badge-ref-comp-code">${esc(code)}</span>` : ""}
          <span>${esc(title)}</span>
        </li>
      `;
    }).join("");

    const more = rows.length > max
      ? `<li class="sb-dashboard-attention-more">+ ${numTxt(rows.length - max, 0)} autre(s) compétence(s)</li>`
      : "";

    return `<ul class="sb-dashboard-attention-list">${visible}${more}</ul>`;
  }

  function transmissionAttentionPanelHtml(items, cfg) {
    const rows = (Array.isArray(items) ? items : []).filter(item => (cfg.keys || []).includes((item?.status_key || "none").toString()));
    if (!rows.length && cfg.hideWhenEmpty) return "";

    return `
      <div class="sb-dashboard-attention-card ${esc(cfg.cls || "")}">
        <div class="sb-dashboard-attention-card-head">
          <span></span>
          <div>
            <strong>${esc(cfg.title || "Points d’attention")}</strong>
            <small>${numTxt(rows.length, 0)} compétence(s)</small>
          </div>
        </div>
        ${transmissionAttentionItemsHtml(items, cfg.keys || [], cfg.limit || 5)}
      </div>
    `;
  }

  function transmissionAttentionHtml(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      return `<div class="sb-dashboard-attention-empty">Aucune compétence analysable sur ce périmètre.</div>`;
    }

    const panels = [
      {
        title: "Compétences sans relais identifié",
        keys: ["none"],
        cls: "sb-dashboard-attention-card--high",
        limit: 5,
        hideWhenEmpty: true
      },
      {
        title: "Transmissions à vérifier",
        keys: ["review"],
        cls: "sb-dashboard-attention-card--review",
        limit: 5,
        hideWhenEmpty: true
      },
      {
        title: "Transmissions à confirmer",
        keys: ["confirm"],
        cls: "sb-dashboard-attention-card--medium",
        limit: 5,
        hideWhenEmpty: true
      }
    ].map(cfg => transmissionAttentionPanelHtml(rows, cfg)).filter(Boolean).join("");

    return panels || `<div class="sb-dashboard-attention-empty">Aucun point d’attention prioritaire : les compétences analysées disposent d’un relais sécurisé.</div>`;
  }

  async function openTransmissionCartography() {
    closeModal("dashboardTransmissionDetailModal");
    if (typeof _portal?.switchView === "function") {
      await _portal.switchView("cartographie-competences");
    }
  }

  function renderTransmissionDetailModal() {
    const body = byId("dashboardTransmissionDetailBody");
    if (!body) return;

    const transmission = _lastData?.transmission || {};
    const filters = _lastData?.filters || {};
    const pct = clamp(transmission?.pct ?? 0, 0, 100);
    const total = Number(transmission?.competences_total ?? transmission?.postes_total ?? 0);
    const secured = Number(transmission?.competences_transmissibles ?? transmission?.postes_transmissibles ?? 0);
    const valid = Number(transmission?.transmission_valides_count || 0);
    const confirm = Number(transmission?.transmission_confirm_count || 0);
    const review = Number(transmission?.transmission_review_count || 0);
    const none = Number(transmission?.sans_transmetteur_count || 0);
    const threshold = Number(transmission?.threshold_score || 63);
    const months = Number(transmission?.seuil_mois || 6);
    const criticite = Number(filters?.criticite_min);
    const criticiteLabel = Number.isFinite(criticite) ? `≥ ${Math.round(criticite)}` : "—";
    const validPct = dashboardRatio(valid, total);
    const confirmPct = dashboardRatio(confirm, total);
    const reviewPct = dashboardRatio(review, total);
    const nonePct = dashboardRatio(none, total);
    const transmissionTone = healthTone(pct);

    body.innerHTML = `
      <div class="sb-stack sb-dashboard-transmission-detail">
        <div class="sb-dashboard-transmission-hero sb-dashboard-tone--${esc(transmissionTone)}">
          <div>
            <div class="sb-dashboard-transmission-title"><strong>${pctTxt(pct, 0)}</strong> de capacité de transmission</div>
            <div class="sb-dashboard-transmission-sub">
              ${numTxt(secured, 0)} / ${numTxt(total, 0)} compétences disposent d’un relais validé ou à confirmer.
              ${numTxt(none, 0)} compétence(s) restent sans relais identifié.
            </div>
          </div>
          <div class="sb-dashboard-transmission-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
          </div>
        </div>

        <div class="sb-dashboard-segment-wrap" aria-label="Répartition des statuts de transmission">
          <div class="sb-dashboard-segment-bar">
            <span class="sb-dashboard-segment sb-dashboard-segment--validated" style="${transmissionSegmentStyle(valid, total)}">${pctTxt(validPct, 0)}</span>
            <span class="sb-dashboard-segment sb-dashboard-segment--confirm" style="${transmissionSegmentStyle(confirm, total)}">${pctTxt(confirmPct, 0)}</span>
            <span class="sb-dashboard-segment sb-dashboard-segment--review" style="${transmissionSegmentStyle(review, total)}">${pctTxt(reviewPct, 0)}</span>
            <span class="sb-dashboard-segment sb-dashboard-segment--none" style="${transmissionSegmentStyle(none, total)}">${pctTxt(nonePct, 0)}</span>
          </div>
          <div class="sb-dashboard-segment-legend">
            <span><i class="sb-dashboard-dot sb-dashboard-dot--validated"></i>Sécurisées</span>
            <span><i class="sb-dashboard-dot sb-dashboard-dot--confirm"></i>À confirmer</span>
            <span><i class="sb-dashboard-dot sb-dashboard-dot--review"></i>À vérifier</span>
            <span><i class="sb-dashboard-dot sb-dashboard-dot--none"></i>Sans relais</span>
          </div>
        </div>

        <div class="sb-dashboard-kpi-grid sb-dashboard-kpi-grid--transmission">
          <div class="sb-dashboard-kpi-card sb-dashboard-kpi-card--validated">
            <div class="label">Sécurisées</div>
            <div class="value">${numTxt(valid, 0)}</div>
            <div class="card-sub">${pctTxt(validPct, 0)}</div>
          </div>
          <div class="sb-dashboard-kpi-card sb-dashboard-kpi-card--confirm">
            <div class="label">À confirmer</div>
            <div class="value">${numTxt(confirm, 0)}</div>
            <div class="card-sub">${pctTxt(confirmPct, 0)}</div>
          </div>
          <div class="sb-dashboard-kpi-card sb-dashboard-kpi-card--review">
            <div class="label">À vérifier</div>
            <div class="value">${numTxt(review, 0)}</div>
            <div class="card-sub">${pctTxt(reviewPct, 0)}</div>
          </div>
          <div class="sb-dashboard-kpi-card sb-dashboard-kpi-card--none">
            <div class="label">Sans relais</div>
            <div class="value">${numTxt(none, 0)}</div>
            <div class="card-sub">${pctTxt(nonePct, 0)}</div>
          </div>
        </div>

        <div class="sb-dashboard-attention-wrap">
          <div class="sb-dashboard-attention-head">
            <div>
              <div class="sb-dashboard-section-title">Points d’attention</div>
              <div class="sb-dashboard-attention-sub">Liste limitée aux compétences à traiter en priorité. Le détail complet se lit dans la cartographie.</div>
            </div>
            <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-dashboard-open-cartography>Voir le détail dans la cartographie</button>
          </div>
          <div class="sb-dashboard-attention-grid">
            ${transmissionAttentionHtml(transmission?.items)}
          </div>
        </div>

        <div class="sb-dashboard-read-block sb-dashboard-read-block--compact">
          <div class="sb-dashboard-read-icon" aria-hidden="true">i</div>
          <div>
            <div class="sb-dashboard-read-title">Règle utilisée</div>
            <div class="sb-dashboard-read-text">
              Une compétence est transmissible lorsqu’au moins une personne disponible est <strong>Expert</strong>
              ou <strong>Avancé haut</strong> avec un score ≥ <strong>${numTxt(threshold, 0)}%</strong>.
              Les évaluations de plus de <strong>${numTxt(months, 0)} mois</strong> sont isolées.
              <span class="ns-badge sb-dashboard-rule-chip">Criticité prise en compte : ${esc(criticiteLabel)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    openModal("dashboardTransmissionDetailModal");
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
      const cartographyBtn = e.target.closest("[data-dashboard-open-cartography]");
      if (cartographyBtn) {
        try {
          await openTransmissionCartography();
        } catch (err) {
          _portal?.showAlert?.("error", "Erreur ouverture de la cartographie : " + (err?.message || err));
        }
        return;
      }

      const componentHelpBtn = e.target.closest("[data-health-component-help]");
      if (componentHelpBtn) {
        openHealthComponentInfo(componentHelpBtn.getAttribute("data-health-component-help"));
        return;
      }

      const helpBtn = e.target.closest("[data-dash-help]");
      if (helpBtn) {
        openInfo(helpBtn.getAttribute("data-dash-help"));
        return;
      }

      const detailBtn = e.target.closest("[data-dash-detail]");
      if (detailBtn) {
        const kind = (detailBtn.getAttribute("data-dash-detail") || "").trim();
        if (kind === "health") renderHealthDetailModal();
        if (kind === "transmission") renderTransmissionDetailModal();
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

    ["dashboardTransmissionDetailClose", "dashboardTransmissionDetailClose2"].forEach(id => {
      const btn = byId(id);
      if (btn) btn.addEventListener("click", () => closeModal("dashboardTransmissionDetailModal"));
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
