(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const DEFAULT_CRITICITE = 70;
  let _bound = false;
  let _serviceOptionsReady = false;
  let _contextLoaded = false;

  const HELP = {
    health: {
      title: "Santé de la structure",
      body: "Synthèse globale du périmètre affiché : fragilité des postes, criticité, couverture des compétences et capacité de transmission. La jauge reprend la lecture Insights : rouge, orange, vert."
    },
    demandes: {
      title: "Demandes terrain",
      body: "Demandes remontées depuis le terrain : ouvertes, urgentes ou déjà prises en charge."
    },
    entretiens: {
      title: "Entretiens à relancer",
      body: "Entretiens à réaliser, en cours ou en attente de signature."
    },
    referentiel: {
      title: "Qualité des référentiels",
      body: "Contrôle les éléments qui fragilisent l’analyse : postes sans compétence, compétences sans domaine et collaborateurs sans poste."
    },
    transmission: {
      title: "Capacité de transmission",
      body: "Mesure la capacité de la structure à transmettre les savoir-faire critiques grâce aux relais disponibles et aux niveaux de maîtrise observés."
    },
    fiabilite: {
      title: "Fiabilité des données",
      body: "Score de confiance des données utilisées par le dashboard. Plus le score est bas, plus les indicateurs doivent être lus avec prudence."
    },
    fragilite: {
      title: "Indice de fragilité des services/postes",
      body: "Histogramme classé du plus fragile au moins fragile. La hauteur indique l’indice et l’opacité renforce visuellement le niveau de fragilité."
    },
    linked: {
      title: "Sites / clients à surveiller",
      body: "Sur les comptes multisites ou multiclients, cette carte isole les structures liées qui demandent une attention particulière."
    }
  };

  function byId(id){ return document.getElementById(id); }
  function esc(v){ return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
  function n(v){ const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }
  function clamp(v, min, max){ const x = Number(v); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min; }
  function pct(v){ return `${Math.round(clamp(v, 0, 100))}%`; }
  function setText(id, value){ const el = byId(id); if (el) el.textContent = value == null || value === "" ? "—" : String(value); }

  function riskColor(score, inverse){
    const s = clamp(score, 0, 100) / 100;
    const x = inverse ? (1 - s) : s;
    const hue = Math.round(120 * (1 - x));
    return `hsl(${hue} 70% 44%)`;
  }


  function dashboardLevelClass(value){
    const v = clamp(value, 0, 100);
    if (v <= 33) return "is-danger";
    if (v <= 66) return "is-watch";
    return "is-stable";
  }

  function dashboardLevelColor(value){
    const cls = dashboardLevelClass(value);
    if (cls === "is-danger") return "var(--studio-risk-danger)";
    if (cls === "is-watch") return "var(--studio-risk-watch)";
    return "var(--studio-risk-stable)";
  }

  function healthStatus(value){
    const p = clamp(value, 0, 100);
    if (p >= 92) return { label:"Robuste", cls:"sb-health-status--robust" };
    if (p >= 80) return { label:"Solide", cls:"sb-health-status--solid" };
    if (p >= 65) return { label:"Correct", cls:"sb-health-status--ok" };
    if (p >= 50) return { label:"Sous vigilance", cls:"sb-health-status--watch" };
    return { label:"Fragile", cls:"sb-health-status--danger" };
  }

  function polarToCartesian(cx, cy, r, angleDeg){
    const a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + (r * Math.cos(a)), y: cy + (r * Math.sin(a)) };
  }

  function describeArc(cx, cy, r, startAngle, endAngle){
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
    return ["M", start.x, start.y, "A", r, r, 0, largeArcFlag, 0, end.x, end.y].join(" ");
  }

  function renderHealthGauge(value){
    const svg = byId("studioDashHealthGauge");
    const pctEl = byId("studioDashHealthPct");
    const statusEl = byId("studioDashHealthLabel");
    if (!svg) return;

    const p = clamp(value, 0, 100);
    const color = riskColor(p, true);
    const angle = -90 + (180 * p / 100);
    const needle = polarToCartesian(130, 130, 82, angle);

    svg.innerHTML = `
      <path d="${describeArc(130, 130, 92, -90, -30)}" class="sb-health-arc sb-health-arc--bad"></path>
      <path d="${describeArc(130, 130, 92, -30, 35)}" class="sb-health-arc sb-health-arc--mid"></path>
      <path d="${describeArc(130, 130, 92, 35, 90)}" class="sb-health-arc sb-health-arc--good"></path>
      <line x1="130" y1="130" x2="${needle.x.toFixed(1)}" y2="${needle.y.toFixed(1)}" class="sb-health-needle" style="stroke:${color}"></line>
      <circle cx="130" cy="130" r="8" class="sb-health-dot"></circle>
    `;

    if (pctEl) pctEl.textContent = pct(p);
    if (statusEl) {
      const st = healthStatus(p);
      statusEl.className = `sb-health-status ${st.cls}`;
      statusEl.textContent = st.label;
    }
  }

  function getOwnerId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  async function getToken(){
    await (window.__studioAuthReady || Promise.resolve(null));
    const session = await (window.PortalAuthCommon?.getSession?.() || Promise.resolve(null)).catch(() => null);
    return session?.access_token || "";
  }

  function getFilters(){
    const criticite = Math.max(0, Math.min(100, Math.round(n(byId("studioDashCriticite")?.value || DEFAULT_CRITICITE))));
    return {
      id_service: (byId("studioDashService")?.value || "").toString().trim(),
      criticite_min: criticite,
    };
  }

  function setStatus(message, isError){
    const el = byId("studioDashStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", !!isError);
    el.style.display = message ? "block" : "none";
  }

  function openClientSpace(idEnt){
    const ownerId = getOwnerId();
    if (!ownerId || !idEnt) return;
    window.open(`/studio_client_space.html?id=${encodeURIComponent(ownerId)}&client=${encodeURIComponent(idEnt)}`, "_blank", "noopener");
  }

  function setServiceFilter(idService){
    const select = byId("studioDashService");
    if (!select) return;
    select.value = idService || "";
    load().catch(e => setStatus(e.message || String(e), true));
  }

  function setRing(id, value){
    const el = byId(id);
    if (!el) return;
    const v = clamp(n(value), 0, 100);
    const cls = dashboardLevelClass(v);
    const deg = v <= 0 ? 360 : Math.max(4, Math.round(v * 3.6));
    el.classList.remove("is-danger", "is-watch", "is-stable");
    el.classList.add(cls);
    el.style.setProperty("--studio-ring", `${deg}deg`);
    el.style.setProperty("--studio-ring-color", dashboardLevelColor(v));
  }

  function badgeClass(priority){
    const p = (priority || "").toString().toLowerCase();
    if (p === "danger") return "studio-dash-badge--danger";
    if (p === "surveillance") return "studio-dash-badge--watch";
    if (p === "stable") return "studio-dash-badge--stable";
    return "";
  }

  async function loadContext(ownerId, token){
    if (_contextLoaded || !ownerId || !token) return;
    _contextLoaded = true;
    try{
      const r = await fetch(`${API_BASE}/studio/context/${encodeURIComponent(ownerId)}`, {
        headers: { "Authorization": `Bearer ${token}` },
        credentials: "same-origin"
      });
      const ctx = await r.json().catch(() => null);
      if (!r.ok || !ctx) return;
      const prenom = (ctx.prenom || "").toString().trim();
      setText("studioDashWelcome", prenom ? `Bienvenue ${prenom}` : "Bienvenue");
    }catch(_){
      setText("studioDashWelcome", "Bienvenue");
    }
  }

  function applyServiceOptions(data){
    const select = byId("studioDashService");
    if (!select) return;
    const current = select.value || "";
    const opts = Array.isArray(data?.scope_options) && data.scope_options.length
      ? data.scope_options
      : [{ value:"", label:"Tous les services" }];
    const html = opts.map(o => `<option value="${esc(o.value || "")}">${esc(o.label || "Service")}</option>`).join("");
    if (!_serviceOptionsReady || select.dataset.lastOptions !== html){
      select.innerHTML = html;
      select.dataset.lastOptions = html;
      _serviceOptionsReady = true;
    }
    const valid = opts.some(o => String(o.value || "") === current);
    select.value = valid ? current : "";
  }

  function renderRiskBars(items){
    const el = byId("studioDashRiskBars");
    if (!el) return;
    const rows = Array.isArray(items)
      ? items.slice().sort((a, b) => n(b.risk_pct) - n(a.risk_pct)).slice(0, 120)
      : [];
    if (!rows.length){
      el.innerHTML = `<div class="studio-dash-empty">Aucun indice de fragilité.</div>`;
      return;
    }
    el.innerHTML = rows.map(r => {
      const val = Math.max(0, Math.min(100, n(r.risk_pct)));
      const label = esc(r.label || r.nom_service || r.intitule_poste || "Élément");
      const idService = r.id_service ? esc(r.id_service) : "";
      const attrs = idService ? `data-service="${idService}"` : "";
      const opacity = (val / 100).toFixed(2);
      return `<button type="button" class="studio-dash-risk-bar" ${attrs} title="${label} : ${Math.round(val)}%"><span class="studio-dash-risk-bar-value">${Math.round(val)}%</span><span class="studio-dash-risk-bar-track"><span class="studio-dash-risk-bar-fill" style="height:${Math.max(4, Math.round(val))}%;opacity:${opacity}"></span></span><span class="studio-dash-risk-bar-label">${label}</span></button>`;
    }).join("");
    el.querySelectorAll("[data-service]").forEach(btn => btn.addEventListener("click", () => setServiceFilter(btn.dataset.service || "")));
  }

  function renderLinkedStructures(items){
    const el = byId("studioDashLinkedStructureItems");
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 12) : [];
    if (!rows.length){
      el.innerHTML = `<div class="studio-dash-empty">Aucun site ou client prioritaire.</div>`;
      return;
    }
    el.innerHTML = rows.map(r => {
      const label = esc(r.nom_ent || "Structure");
      const sub = `${Math.round(n(r.risk_pct))}% risque · ${n(r.postes_danger)} poste(s) en danger`;
      return `<div class="studio-dash-mini-row studio-dash-mini-row--click" data-client="${esc(r.id_ent)}"><div><strong>${label}</strong><span>${esc(sub)}</span></div><span class="studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(row => row.addEventListener("click", () => openClientSpace(row.dataset.client)));
  }

  function renderSignal(value){
    const el = byId("studioDashReliabilitySignal");
    if (!el) return;
    const v = clamp(n(value), 0, 100);
    const active = v >= 100 ? 5 : Math.max(0, Math.floor(v / 20));
    const cls = dashboardLevelClass(v);
    el.classList.remove("is-danger", "is-watch", "is-stable");
    el.classList.add(cls);
    el.innerHTML = [1,2,3,4,5].map(i => `<span class="${i <= active ? "is-active" : ""}" style="height:${16 + i * 7}px"></span>`).join("");
  }

  function render(data){
    applyServiceOptions(data);

    const main = data.main || {};
    const p = main.portfolio || {};
    const demandes = main.demandes_formation || {};
    const entretiens = main.entretiens || {};
    const ref = main.referentiel || {};
    const tr = main.transmission || {};
    const reliability = main.reliability || {};
    const linked = data.linked || {};
    const filters = getFilters();

    setStatus("");
    renderHealthGauge(p.health_pct);

    setText("studioDashDemandesOpen", n(demandes.ouvertes));
    setText("studioDashDemandesUrgentes", n(demandes.urgentes));
    setText("studioDashDemandesInProgress", n(demandes.prises_en_charge));

    setText("studioDashEntretiensTodo", n(entretiens.a_realiser));
    setText("studioDashEntretiensProgress", n(entretiens.en_cours));
    setText("studioDashEntretiensSign", n(entretiens.a_signer));

    setText("studioDashPostesSansComp", n(ref.postes_sans_competence));
    setText("studioDashCompSansDomaine", n(ref.competences_sans_domaine));
    setText("studioDashCollabSansPoste", n(ref.collaborateurs_sans_poste));

    setText("studioDashTransmissionPct", pct(tr.pct));
    setRing("studioDashTransmissionRing", tr.pct);

    setText("studioDashReliabilityPct", pct(reliability.pct));
    renderSignal(reliability.pct);

    setText("studioDashRiskTitle", filters.id_service ? "Indice de fragilité des postes" : "Indice de fragilité des services");
    renderRiskBars(main.risk_items || []);

    const linkedSection = byId("studioDashLinkedSection");
    const showLinked = !!linked.visible;
    if (linkedSection) linkedSection.style.display = showLinked ? "block" : "none";
    if (showLinked){
      const lp = linked.portfolio || {};
      const count = `${n(lp.structures_danger)} / ${n(lp.structures_total)}`;
      setText("studioDashLinkedCount", count);
      renderLinkedStructures(linked.structures_prioritaires || []);
    }
  }

  async function load(){
    const ownerId = getOwnerId();
    if (!ownerId){ setStatus("Accès Studio introuvable.", true); return; }
    const token = await getToken();
    if (!token){ setStatus("Session expirée.", true); return; }

    await loadContext(ownerId, token);

    const f = getFilters();
    setText("studioDashCriticiteLabel", `≥ ${f.criticite_min}`);
    setStatus("Chargement…");

    const url = new URL(`${API_BASE}/studio/dashboard/overview/${encodeURIComponent(ownerId)}`);
    if (f.id_service) url.searchParams.set("id_service", f.id_service);
    url.searchParams.set("criticite_min", String(f.criticite_min));

    const r = await fetch(url.toString(), { headers: { "Authorization": `Bearer ${token}` }, credentials: "same-origin" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.detail || `Erreur HTTP ${r.status}`);
    render(data || {});
  }

  function openHelp(key){
    const modal = byId("studioDashHelpModal");
    const h = HELP[key] || { title:"Indicateur", body:"Indicateur du dashboard Studio." };
    setText("studioDashHelpTitle", h.title);
    setText("studioDashHelpBody", h.body);
    if (!modal) return;
    modal.style.display = "flex";
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeHelp(){
    const modal = byId("studioDashHelpModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    modal.style.display = "none";
  }

  function bind(){
    if (_bound) return;
    _bound = true;
    byId("studioDashService")?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashCriticite")?.addEventListener("input", () => setText("studioDashCriticiteLabel", `≥ ${getFilters().criticite_min}`));
    byId("studioDashCriticite")?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashRefresh")?.addEventListener("click", () => load().catch(e => setStatus(e.message || String(e), true)));
    document.addEventListener("click", (ev) => {
      const helpBtn = ev.target.closest?.(".studio-dash-help[data-help]");
      if (helpBtn){
        openHelp(helpBtn.dataset.help || "");
        return;
      }
      if (ev.target === byId("studioDashHelpModal")) closeHelp();
    });
    byId("studioDashHelpClose")?.addEventListener("click", closeHelp);
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeHelp(); });
  }

  bind();
  load().catch(e => setStatus(e.message || String(e), true));
})();
