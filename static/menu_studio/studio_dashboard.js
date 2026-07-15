(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const DEFAULT_CRITICITE = 70;
  let _bound = false;
  let _serviceOptionsReady = false;
  let _contextLoaded = false;

  const HELP = {
    demandes: {
      title: "Demandes RH par statut",
      body: "Lecture consolidée des demandes remontées au Studio. Les volumes affichés viennent des données Studio / Insights, sans recalcul local des risques."
    },
    alertes: {
      title: "Alertes principales",
      body: "Points d’attention à traiter côté RH : postes critiques, compétences à sécuriser, demandes à arbitrer ou données incomplètes."
    },
    consoles: {
      title: "État des consoles",
      body: "Vue de supervision des consoles Novoskill. Cette carte indique l’état opérationnel visible depuis les données disponibles dans Studio."
    },
    activite: {
      title: "Activité récente",
      body: "Synthèse courte des dernières priorités et demandes détectées sur le périmètre courant."
    },
    raccourcis: {
      title: "Accès rapides",
      body: "Raccourcis vers les espaces de pilotage et d’action. Les pages non encore finalisées restent branchées sur l’espace en construction."
    }
  };

  function byId(id){ return document.getElementById(id); }
  function esc(v){ return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
  function n(v){ const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }
  function clamp(v, min, max){ const x = Number(v); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min; }
  function setText(id, value){ const el = byId(id); if (el) el.textContent = value == null || value === "" ? "—" : String(value); }
  function getOwnerId(){ return new URL(window.location.href).searchParams.get("id") || window.portal?.contactId || ""; }

  async function getToken(){
    const session = await window.PortalAuthCommon?.getSession?.();
    return session?.access_token || "";
  }

  function setStatus(message, isError){
    const el = byId("studioDashStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", !!isError);
    el.style.display = message ? "block" : "none";
  }

  function getFilters(){
    const criticite = clamp(byId("studioDashCriticite")?.value || DEFAULT_CRITICITE, 0, 100);
    return {
      id_service: (byId("studioDashService")?.value || "").trim(),
      criticite_min: criticite
    };
  }

  async function loadContext(ownerId, token){
    if (_contextLoaded) return;
    _contextLoaded = true;
    try{
      const r = await fetch(`${API_BASE}/studio/context/${encodeURIComponent(ownerId)}`, {
        headers: { "Authorization": `Bearer ${token}` },
        credentials: "same-origin"
      });
      const ctx = await r.json().catch(() => null);
      const prenom = (ctx?.prenom || "").toString().trim();
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

  function renderSpark(id, tone){
    const el = byId(id);
    if (!el) return;
    el.className = `studio-dash-spark studio-dash-spark--${tone || "neutral"}`;
    el.innerHTML = `<svg viewBox="0 0 110 42" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-b49923bd1346"></use></svg>`;
  }

  function renderDonut(rows){
    const donut = byId("studioDashDemandesDonut");
    const total = rows.reduce((s, r) => s + n(r.value), 0);
    if (!donut) return;
    if (!total){
      donut.style.background = "conic-gradient(#e5e7eb 0deg 360deg)";
      donut.innerHTML = `<span>0</span><small>total</small>`;
      return;
    }
    let start = 0;
    const segments = rows.filter(r => n(r.value) > 0).map(r => {
      const deg = n(r.value) / total * 360;
      const part = `${r.color} ${start.toFixed(1)}deg ${(start + deg).toFixed(1)}deg`;
      start += deg;
      return part;
    });
    donut.style.background = `conic-gradient(${segments.join(", ")})`;
    donut.innerHTML = `<span>${total}</span><small>total</small>`;
  }

  function renderDemandes(demandes){
    const ouvertes = n(demandes?.ouvertes);
    const aInstruire = n(demandes?.a_instruire);
    const prises = n(demandes?.prises_en_charge);
    const autres = Math.max(0, ouvertes - aInstruire - prises);
    const urgentes = n(demandes?.urgentes);
    const rows = [
      { label:"Nouvelles", value:aInstruire, color:"#e6e421" },
      { label:"En cours", value:prises, color:"#f59e0b" },
      { label:"Autres ouvertes", value:autres, color:"#3b82f6" },
      { label:"Signalées urgentes", value:urgentes, color:"#ef4444", note:"peut recouper les autres statuts" }
    ];
    const list = byId("studioDashDemandesStatusList");
    if (list){
      const totalBase = Math.max(ouvertes, 1);
      list.innerHTML = rows.map(r => {
        const percent = r.label === "Signalées urgentes" ? Math.round(n(r.value) / totalBase * 100) : (ouvertes ? Math.round(n(r.value) / ouvertes * 100) : 0);
        return `<div class="studio-dash-status-row" title="${esc(r.note || "")}">
          <span class="studio-dash-dot" style="background:${esc(r.color)}"></span>
          <span>${esc(r.label)}</span>
          <strong>${n(r.value)}</strong>
          <em>${percent}%</em>
        </div>`;
      }).join("");
    }
    renderDonut(rows.slice(0, 3));
  }

  function alertIcon(type){
    if (type === "danger") return "!";
    if (type === "watch") return "△";
    if (type === "time") return "◷";
    return "i";
  }

  function renderAlerts(main){
    const p = main?.portfolio || {};
    const ref = main?.referentiel || {};
    const demandes = main?.demandes_formation || {};
    const tr = main?.transmission || {};
    const alerts = [];

    if (n(p.postes_critiques_danger) > 0) {
      alerts.push({ type:"danger", title:`${n(p.postes_critiques_danger)} poste(s) critique(s) en danger`, sub:"Analyse issue du moteur Insights" });
    }
    if (n(tr.competences_risque) > 0) {
      alerts.push({ type:"watch", title:`${n(tr.competences_risque)} compétence(s) à sécuriser`, sub:"Capacité de transmission insuffisante" });
    }
    if (n(demandes.a_instruire) > 0) {
      alerts.push({ type:"time", title:`${n(demandes.a_instruire)} demande(s) RH en attente d’arbitrage`, sub:"À qualifier côté Studio" });
    }
    if (n(ref.collaborateurs_sans_poste) > 0) {
      alerts.push({ type:"info", title:`${n(ref.collaborateurs_sans_poste)} collaborateur(s) sans poste`, sub:"Donnée structurante à compléter" });
    }
    const refIssues = n(ref.postes_sans_competence) + n(ref.competences_sans_domaine);
    if (refIssues > 0) {
      alerts.push({ type:"info", title:"Mise à jour des référentiels recommandée", sub:`${refIssues} élément(s) à compléter` });
    }
    if (!alerts.length) {
      alerts.push({ type:"ok", title:"Aucune alerte majeure détectée", sub:"Le socle disponible est exploitable sur ce périmètre" });
    }

    const el = byId("studioDashAlertList");
    if (!el) return;
    el.innerHTML = alerts.slice(0, 4).map(a => `<button type="button" class="studio-dash-alert-row studio-dash-alert-row--${esc(a.type)}" data-dash-view="analyse_rh">
      <span class="studio-dash-alert-icon" aria-hidden="true">${esc(alertIcon(a.type))}</span>
      <span><strong>${esc(a.title)}</strong><small>${esc(a.sub)}</small></span>
      <em aria-hidden="true">›</em>
    </button>`).join("");
  }

  function consoleState(label, state, tone){
    return `<div class="studio-dash-console-row">
      <span class="studio-dash-console-icon" aria-hidden="true"></span>
      <span>${esc(label)}</span>
      <strong class="studio-dash-console-state studio-dash-console-state--${esc(tone || "muted")}">${esc(state)}</strong>
    </div>`;
  }

  function renderConsoles(main){
    const p = main?.portfolio || {};
    const ref = main?.referentiel || {};
    const demandes = main?.demandes_formation || {};
    const insightsOk = n(p.postes_total) > 0 || n(p.health_pct) > 0;
    const peopleOk = n(ref.collaborateurs_sans_poste) === 0;
    const learnHasFlow = n(demandes.ouvertes) > 0;
    const el = byId("studioDashConsoleList");
    if (!el) return;
    el.innerHTML = [
      consoleState("Insights", insightsOk ? "Actif" : "À compléter", insightsOk ? "ok" : "watch"),
      consoleState("People", peopleOk ? "Actif" : "À compléter", peopleOk ? "ok" : "watch"),
      consoleState("Learn", learnHasFlow ? "Flux ouvert" : "Disponible", learnHasFlow ? "watch" : "ok"),
      consoleState("Partner", "Non activé", "muted")
    ].join("");
  }

  function whenLabel(value){
    const raw = value ? new Date(value) : null;
    if (!raw || Number.isNaN(raw.getTime())) return "";
    const diff = Math.max(0, Date.now() - raw.getTime());
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "À l’instant";
    if (minutes < 60) return `Il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    return `Il y a ${days} j`;
  }

  function renderActivity(main){
    const actions = Array.isArray(main?.actions_prioritaires) ? main.actions_prioritaires : [];
    const demandes = Array.isArray(main?.demandes_formation?.items) ? main.demandes_formation.items : [];
    const items = [];

    demandes.slice(0, 2).forEach(d => {
      const comp = d.intitule_competence || d.intitule_poste || "demande RH";
      items.push({ icon:"doc", title:"Nouvelle demande RH créée", sub:comp, when:whenLabel(d.created_at) });
    });
    actions.slice(0, 4).forEach(a => {
      items.push({ icon:a.type_action || "act", title:a.title || "Action RH", sub:a.subtitle || "Priorité Studio", when:"" });
    });
    if (!items.length) {
      items.push({ icon:"ok", title:"Aucune activité prioritaire", sub:"Le dashboard est à jour sur ce périmètre", when:"" });
    }

    const el = byId("studioDashActivityList");
    if (!el) return;
    el.innerHTML = items.slice(0, 4).map(it => `<div class="studio-dash-activity-row">
      <span class="studio-dash-activity-icon studio-dash-activity-icon--${esc(it.icon)}" aria-hidden="true"></span>
      <span><strong>${esc(it.title)}</strong><small>${esc(it.sub)}</small></span>
      ${it.when ? `<em>${esc(it.when)}</em>` : ""}
    </div>`).join("");
  }

  function badgeClass(priority){
    const p = String(priority || "").toLowerCase();
    if (p === "danger") return "studio-dash-badge--danger";
    if (p === "surveillance") return "studio-dash-badge--watch";
    return "studio-dash-badge--stable";
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
      return `<div class="studio-dash-mini-row studio-dash-mini-row--click" data-client="${esc(r.id_ent)}"><div><strong>${label}</strong><span>${esc(sub)}</span></div><span class="ns-badge studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(row => row.addEventListener("click", () => {
      if (window.portal?.switchView) window.portal.switchView("clients");
    }));
  }

  function render(data){
    applyServiceOptions(data);

    const main = data.main || {};
    const p = main.portfolio || {};
    const demandes = main.demandes_formation || {};
    const tr = main.transmission || {};
    const health = p.health_pct || 0;
    const healthObj = main.health || {};
    const actions = Array.isArray(main.actions_prioritaires) ? main.actions_prioritaires : [];
    const linked = data.linked || {};
    const filters = getFilters();

    setStatus("");
    setText("studioDashPostesWatch", n(p.postes_danger) + n(p.postes_surveillance));
    const compRisk = n(tr.competences_risque);
    setText("studioDashCompetencesRisk", compRisk || n(healthObj.competences_fragilite_moyenne) || 0);
    setText("studioDashDemandesPending", n(demandes.a_instruire));
    setText("studioDashActionsCount", actions.length);
    setText("studioDashCriticiteLabel", `≥ ${filters.criticite_min}`);

    renderSpark("studioDashPostesSpark", "postes");
    renderSpark("studioDashSkillsSpark", "skills");
    renderSpark("studioDashDemandesSpark", "demandes");
    renderSpark("studioDashActionsSpark", "actions");

    renderDemandes(demandes);
    renderAlerts(main);
    renderConsoles(main);
    renderActivity(main);

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
    document.addEventListener("click", async (ev) => {
      const helpBtn = ev.target.closest?.(".studio-dash-help[data-help]");
      if (helpBtn){
        openHelp(helpBtn.dataset.help || "");
        return;
      }
      const viewBtn = ev.target.closest?.("[data-dash-view]");
      if (viewBtn){
        const view = viewBtn.dataset.dashView || "";
        if (view && window.portal?.switchView) await window.portal.switchView(view);
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
