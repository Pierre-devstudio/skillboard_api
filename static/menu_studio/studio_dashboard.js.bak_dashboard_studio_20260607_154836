(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const DEFAULT_CRITICITE = 70;
  let _bound = false;
  let _lastData = null;
  let _scopeOptionsReady = false;

  function byId(id){ return document.getElementById(id); }
  function esc(v){ return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
  function n(v){ const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }
  function pct(v){ const x = Math.max(0, Math.min(100, n(v))); return `${Math.round(x)}%`; }
  function setText(id, value){ const el = byId(id); if (el) el.textContent = value == null || value === "" ? "—" : String(value); }

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
      perimetre: byId("studioDashPerimetre")?.value || "ma_structure",
      priorite: byId("studioDashPriorite")?.value || "tous",
      type_action: byId("studioDashActionType")?.value || "tous",
      criticite_min: criticite,
    };
  }

  function openClientSpace(idEnt){
    const ownerId = getOwnerId();
    if (!ownerId || !idEnt) return;
    window.open(`/studio_client_space.html?id=${encodeURIComponent(ownerId)}&client=${encodeURIComponent(idEnt)}`, "_blank", "noopener");
  }

  function setScopeFilter(value){
    const select = byId("studioDashPerimetre");
    if (!select || !value) return;
    select.value = value;
    load();
  }

  function setStatus(message, isError){
    const el = byId("studioDashStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", !!isError);
    el.style.display = message ? "block" : "none";
  }

  function setGauge(value){
    const v = Math.max(0, Math.min(100, n(value)));
    const needle = byId("studioDashHealthNeedle");
    if (needle) needle.style.transform = `translateX(-50%) rotate(${Math.round(-90 + (v * 1.8))}deg)`;
  }

  function setRing(id, value){
    const el = byId(id);
    if (!el) return;
    const v = Math.max(0, Math.min(100, n(value)));
    el.style.setProperty("--studio-ring", `${Math.round(v * 3.6)}deg`);
  }

  function badgeClass(priority){
    const p = (priority || "").toString().toLowerCase();
    if (p === "danger") return "studio-dash-badge--danger";
    if (p === "surveillance") return "studio-dash-badge--watch";
    if (p === "stable") return "studio-dash-badge--stable";
    return "";
  }

  function applyScopeOptions(data){
    const select = byId("studioDashPerimetre");
    if (!select) return;
    const current = select.value || "ma_structure";
    const opts = Array.isArray(data?.scope_options) ? data.scope_options : [{value:"ma_structure", label:"Ma structure"}];
    const html = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    if (!_scopeOptionsReady || select.dataset.lastOptions !== html){
      select.innerHTML = html;
      select.dataset.lastOptions = html;
      _scopeOptionsReady = true;
    }
    const valid = opts.some(o => String(o.value) === current);
    select.value = valid ? current : "ma_structure";
  }

  function renderRiskBars(items, riskKind){
    const el = byId("studioDashRiskBars");
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 12) : [];
    if (!rows.length){ el.innerHTML = `<div class="studio-dash-empty">Aucun risque prioritaire sur ce périmètre.</div>`; return; }
    el.innerHTML = rows.map(r => {
      const val = Math.max(0, Math.min(100, n(r.risk_pct)));
      const cls = r.priority === "danger" ? "is-danger" : (r.priority === "surveillance" ? "is-watch" : "is-stable");
      const label = esc(r.label || r.nom_service || r.intitule_poste || r.nom_ent || "Périmètre");
      const serviceValue = r.id_service ? `service:${esc(r.id_service)}` : "";
      const client = r.id_ent && r.kind === "structure" ? esc(r.id_ent) : "";
      const attrs = serviceValue ? `data-scope="${serviceValue}"` : (client ? `data-client="${client}"` : "");
      return `<button type="button" class="studio-dash-risk-bar ${cls}" ${attrs} title="${label} : ${Math.round(val)}%"><span class="studio-dash-risk-bar-fill" style="height:${Math.max(8, Math.round(val))}%"></span><span class="studio-dash-risk-bar-value">${Math.round(val)}%</span><span class="studio-dash-risk-bar-label">${label}</span></button>`;
    }).join("");
    el.querySelectorAll("[data-scope]").forEach(btn => btn.addEventListener("click", () => setScopeFilter(btn.dataset.scope)));
    el.querySelectorAll("[data-client]").forEach(btn => btn.addEventListener("click", () => openClientSpace(btn.dataset.client)));
  }

  function renderActions(items, targetId){
    const el = byId(targetId || "studioDashActions");
    if (!el) return;
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length){ el.innerHTML = `<div class="studio-dash-empty">Aucune action prioritaire détectée sur le périmètre.</div>`; return; }
    el.innerHTML = rows.map(a => {
      const client = a.id_ent ? `<button type="button" class="studio-dash-link" data-client="${esc(a.id_ent)}">Ouvrir</button>` : "";
      return `<div class="studio-dash-action-row"><div class="studio-dash-action-main"><span class="studio-dash-badge ${badgeClass(a.priority)}">${esc(a.priority_label || "Priorité")}</span><strong>${esc(a.title || "Action")}</strong><span>${esc(a.subtitle || "")}</span></div>${client}</div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(btn => btn.addEventListener("click", () => openClientSpace(btn.dataset.client)));
  }

  function renderMiniList(id, items, emptyText, mode){
    const el = byId(id);
    if (!el) return;
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length){ el.innerHTML = `<div class="studio-dash-empty">${esc(emptyText)}</div>`; return; }
    el.innerHTML = rows.map(r => {
      if (mode === "formation"){
        return `<div class="studio-dash-mini-row"><div><strong>${esc(r.intitule_competence || "Besoin formation")}</strong><span>${esc(r.nom_ent || r.nom_service || "Structure")} · ${esc(r.intitule_poste || "Poste non précisé")}</span></div><span class="studio-dash-badge ${n(r.criticite) >= 70 ? "studio-dash-badge--danger" : "studio-dash-badge--watch"}">${esc(r.statut || "ouvert")}</span></div>`;
      }
      if (mode === "main"){
        const label = esc(r.label || r.nom_service || r.intitule_poste || "Périmètre");
        const sub = r.kind === "service" ? `${n(r.postes_danger)} poste(s) en danger · ${Math.round(n(r.risk_pct))}% risque` : `${Math.round(n(r.risk_pct))}% risque · ${n(r.risques_sans_action)} risque(s) sans action`;
        const scope = r.id_service ? `service:${esc(r.id_service)}` : "";
        const attrs = scope ? ` data-scope="${scope}"` : "";
        return `<div class="studio-dash-mini-row studio-dash-mini-row--click"${attrs}><div><strong>${label}</strong><span>${esc(sub)}</span></div><span class="studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
      }
      return `<div class="studio-dash-mini-row studio-dash-mini-row--click" data-client="${esc(r.id_ent)}"><div><strong>${esc(r.nom_ent || "Structure")}</strong><span>${esc(r.type_entreprise || "Organisation")} · ${Math.round(n(r.risk_pct))}% risque · ${n(r.postes_danger)} poste(s) en danger</span></div><span class="studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(row => row.addEventListener("click", () => openClientSpace(row.dataset.client)));
    el.querySelectorAll("[data-scope]").forEach(row => row.addEventListener("click", () => setScopeFilter(row.dataset.scope)));
  }

  function renderSignal(value){
    const el = byId("studioDashReliabilitySignal");
    if (!el) return;
    const v = Math.max(0, Math.min(100, n(value)));
    const active = Math.ceil(v / 20);
    el.innerHTML = [1,2,3,4,5].map(i => `<span class="${i <= active ? "is-active" : ""}" style="height:${18 + i * 8}px"></span>`).join("");
  }

  function applyTypeActionFilter(items){
    const type = getFilters().type_action;
    const rows = Array.isArray(items) ? items : [];
    if (!type || type === "tous") return rows;
    return rows.filter(x => (x.type_action || "").toString().toLowerCase() === type);
  }

  function render(data){
    _lastData = data || {};
    applyScopeOptions(data);

    const main = data.main || {};
    const p = main.portfolio || {};
    const demandes = main.demandes_formation || {};
    const entretiens = main.entretiens || {};
    const ref = main.referentiel || {};
    const tr = main.transmission || {};
    const reliability = main.reliability || {};
    const linked = data.linked || {};
    const mode = data.mode || "single_structure";
    const own = data.own || {};

    if (own.is_real_entity === false) {
      setStatus("Aucune structure interne n’est rattachée à ce Studio owner : le bloc Ma structure reste volontairement vide, sans utiliser un client à la place.");
    } else {
      setStatus("");
    }
    setText("studioDashTitle", mode === "network" ? "Pilotage de ma structure" : "Pilotage Studio");
    setText("studioDashSub", mode === "network" ? "Votre structure d’abord, puis les organisations liées à superviser." : "Vue synthétique des risques, demandes terrain et actions RH à mener.");
    setText("studioDashMainSectionTitle", own.nom_ent || "Ma structure");
    setText("studioDashMainSectionSub", main.scope_label || "Indicateurs internes : services, postes, entretiens, besoins formation et référentiel.");
    setText("studioDashHealthTitle", "Santé de ma structure");
    setText("studioDashHealthScope", `${n(p.postes_total)} poste(s) analysé(s) · ${n(p.risques_sans_action)} risque(s) sans action`);
    setText("studioDashHealthPct", pct(p.health_pct));
    setText("studioDashHealthLabel", p.health_label || "Analyse interne");
    setGauge(p.health_pct);

    setText("studioDashRiskTitle", main.risk_title || "Services à surveiller");
    setText("studioDashRiskSub", main.risk_subtitle || "Lecture par service ou poste selon le périmètre");
    setText("studioDashNbDanger", n(p.items_danger));
    setText("studioDashNbWatch", n(p.items_surveillance));
    setText("studioDashNbStable", n(p.items_stables));
    renderRiskBars(main.risk_items || [], main.risk_kind || "service");

    setText("studioDashDemandesOpen", n(demandes.ouvertes));
    setText("studioDashDemandesUrgentes", n(demandes.urgentes));
    setText("studioDashDemandesInProgress", n(demandes.prises_en_charge));
    setText("studioDashActionsSub", "À traiter en premier sur le périmètre affiché.");
    renderActions(applyTypeActionFilter(main.actions_prioritaires || []), "studioDashActions");

    setText("studioDashFormationTotal", n(demandes.a_instruire));
    setText("studioDashFormationLabel", `${n(demandes.a_instruire)} besoin(s) à qualifier · ${n(demandes.urgentes)} urgent(s)`);
    setRing("studioDashFormationDonut", demandes.a_instruire ? Math.min(100, 30 + demandes.urgentes * 12) : 0);
    setText("studioDashEntretiensTodo", n(entretiens.a_realiser));
    setText("studioDashEntretiensProgress", n(entretiens.en_cours));
    setText("studioDashEntretiensSign", n(entretiens.a_signer));
    setText("studioDashTransmissionPct", pct(tr.pct));
    setText("studioDashTransmissionLabel", `${n(tr.postes_risque)} poste(s) à sécuriser`);
    setRing("studioDashTransmissionRing", tr.pct);
    setText("studioDashPostesSansComp", n(ref.postes_sans_competence));
    setText("studioDashCompSansDomaine", n(ref.competences_sans_domaine));
    setText("studioDashCollabSansPoste", n(ref.collaborateurs_sans_poste));
    setText("studioDashReliabilityPct", pct(reliability.pct));
    renderSignal(reliability.pct);
    renderMiniList("studioDashFormationItems", demandes.items || [], "Aucune demande formation récente.", "formation");
    setText("studioDashMainPriorityTitle", main.risk_title || "Priorités internes");
    setText("studioDashMainPrioritySub", "Classement interne par niveau de risque");
    renderMiniList("studioDashMainPriorityItems", main.risk_items || [], "Aucune priorité interne détectée.", "main");

    const linkedSection = byId("studioDashLinkedSection");
    const showLinked = !!linked.visible;
    if (linkedSection) linkedSection.style.display = showLinked ? "block" : "none";
    if (showLinked){
      const lp = linked.portfolio || {};
      setText("studioDashLinkedSub", `${n(lp.structures_total)} organisation(s) liée(s) · ${n(lp.structures_danger)} en danger · ${n(lp.structures_surveillance)} à surveiller`);
      renderMiniList("studioDashLinkedStructureItems", linked.structures_prioritaires || [], "Aucune organisation liée prioritaire.", "structures");
      renderActions(applyTypeActionFilter(linked.actions_prioritaires || []), "studioDashLinkedActions");
    }
  }

  async function load(){
    const ownerId = getOwnerId();
    if (!ownerId){ setStatus("Owner Studio introuvable dans l’URL.", true); return; }
    const token = await getToken();
    if (!token){ setStatus("Session Studio introuvable ou expirée.", true); return; }
    const f = getFilters();
    setText("studioDashCriticiteLabel", `≥ ${f.criticite_min}`);
    setStatus("Chargement des indicateurs…");
    const url = new URL(`${API_BASE}/studio/dashboard/overview/${encodeURIComponent(ownerId)}`);
    url.searchParams.set("perimetre", f.perimetre);
    url.searchParams.set("priorite", f.priorite);
    url.searchParams.set("criticite_min", String(f.criticite_min));
    const r = await fetch(url.toString(), { headers: { "Authorization": `Bearer ${token}` }, credentials: "same-origin" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.detail || `Erreur HTTP ${r.status}`);
    render(data || {});
  }

  const HELP = {
    health: ["Santé de ma structure", "Indicateur principal issu du moteur du dashboard Insights sur la structure affichée. Les données Studio complètent ensuite avec les demandes, entretiens et référentiel."],
    risques: ["Services ou postes à surveiller", "La carte s’adapte au périmètre : services pour une structure complète, postes pour un service sélectionné, organisations dans le bloc de supervision."],
    demandes: ["Demandes terrain", "Besoins transmis depuis Insights, notamment les besoins formation envoyés par les managers ou issus des analyses."],
    actions: ["Actions prioritaires", "Liste ordonnée des actions à traiter : formation, transmission, entretiens ou référentiel."],
    formation: ["Besoins formation", "Demandes à qualifier ou à transformer en action de formation dans Studio."],
    entretiens: ["Entretiens à relancer", "Entretiens préparés, en cours ou en attente de signature."],
    transmission: ["Transmission à organiser", "Mesure la capacité à sécuriser les savoir-faire critiques et les postes dépendants."],
    referentiel: ["Qualité du référentiel", "Détecte les données qui limitent l’analyse : postes sans compétences, collaborateurs sans poste, compétences sans domaine."],
    fiabilite: ["Fiabilité des données", "Score de confiance opérationnelle. Données incomplètes = décisions moins fiables, ce qui reste une surprise pour absolument personne."]
  };

  function bind(){
    if (_bound) return;
    _bound = true;
    ["studioDashPerimetre", "studioDashPriorite", "studioDashActionType"].forEach(id => byId(id)?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true))));
    byId("studioDashCriticite")?.addEventListener("input", () => setText("studioDashCriticiteLabel", `≥ ${getFilters().criticite_min}`));
    byId("studioDashCriticite")?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashRefresh")?.addEventListener("click", () => load().catch(e => setStatus(e.message || String(e), true)));
    document.addEventListener("click", (ev) => {
      const btn = ev.target.closest?.(".studio-dash-help");
      if (!btn) return;
      const h = HELP[btn.dataset.help] || ["Aide", "Indicateur Studio."];
      setText("studioDashHelpTitle", h[0]);
      setText("studioDashHelpBody", h[1]);
      byId("studioDashHelpModal")?.classList.add("show");
    });
    byId("studioDashHelpClose")?.addEventListener("click", () => byId("studioDashHelpModal")?.classList.remove("show"));
  }

  bind();
  load().catch(e => setStatus(e.message || String(e), true));
})();
