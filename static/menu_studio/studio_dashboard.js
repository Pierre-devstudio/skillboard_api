(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const DEFAULT_CRITICITE = 70;
  let _bound = false;
  let _lastData = null;

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
      perimetre: byId("studioDashPerimetre")?.value || "tous",
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

  function renderRiskBars(items){
    const el = byId("studioDashRiskBars");
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 12) : [];
    if (!rows.length){ el.innerHTML = `<div class="studio-dash-empty">Aucune structure analysable.</div>`; return; }
    el.innerHTML = rows.map(r => {
      const val = Math.max(0, Math.min(100, n(r.risk_pct)));
      const cls = r.priority === "danger" ? "is-danger" : (r.priority === "surveillance" ? "is-watch" : "is-stable");
      const label = esc(r.nom_ent || "Structure");
      return `<button type="button" class="studio-dash-risk-bar ${cls}" data-client="${esc(r.id_ent)}" title="${label} : ${Math.round(val)}%"><span class="studio-dash-risk-bar-fill" style="height:${Math.max(8, Math.round(val))}%"></span><span class="studio-dash-risk-bar-value">${Math.round(val)}%</span><span class="studio-dash-risk-bar-label">${label}</span></button>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(btn => btn.addEventListener("click", () => openClientSpace(btn.dataset.client)));
  }

  function renderActions(items){
    const el = byId("studioDashActions");
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
        return `<div class="studio-dash-mini-row"><div><strong>${esc(r.intitule_competence || "Besoin formation")}</strong><span>${esc(r.nom_ent || "Structure")} · ${esc(r.intitule_poste || "Poste non précisé")}</span></div><span class="studio-dash-badge ${n(r.criticite) >= 70 ? "studio-dash-badge--danger" : "studio-dash-badge--watch"}">${esc(r.statut || "ouvert")}</span></div>`;
      }
      return `<div class="studio-dash-mini-row studio-dash-mini-row--click" data-client="${esc(r.id_ent)}"><div><strong>${esc(r.nom_ent || "Structure")}</strong><span>${esc(r.type_entreprise || "Organisation")} · ${Math.round(n(r.risk_pct))}% risque · ${n(r.postes_danger)} poste(s) en danger</span></div><span class="studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(row => row.addEventListener("click", () => openClientSpace(row.dataset.client)));
  }

  function renderSignal(value){
    const el = byId("studioDashReliabilitySignal");
    if (!el) return;
    const v = Math.max(0, Math.min(100, n(value)));
    const active = Math.ceil(v / 20);
    el.innerHTML = [1,2,3,4,5].map(i => `<span class="${i <= active ? "is-active" : ""}" style="height:${18 + i * 8}px"></span>`).join("");
  }

  function applyTypeActionFilter(data){
    const type = getFilters().type_action;
    const items = Array.isArray(data?.actions_prioritaires) ? data.actions_prioritaires : [];
    if (!type || type === "tous") return items;
    return items.filter(x => (x.type_action || "").toString().toLowerCase() === type);
  }

  function render(data){
    _lastData = data || {};
    const p = data.portfolio || {}, demandes = data.demandes_formation || {}, entretiens = data.entretiens || {}, ref = data.referentiel || {}, tr = data.transmission || {}, reliability = data.reliability || {};
    setStatus("");
    setText("studioDashHealthScope", `${n(p.structures_total)} structure(s) · ${n(p.postes_total)} poste(s) analysé(s)`);
    setText("studioDashHealthPct", pct(p.health_pct));
    setText("studioDashHealthLabel", p.health_label || "Analyse portefeuille");
    setGauge(p.health_pct);
    setText("studioDashNbDanger", n(p.structures_danger));
    setText("studioDashNbWatch", n(p.structures_surveillance));
    setText("studioDashNbStable", n(p.structures_stables));
    renderRiskBars(data.structures_prioritaires || []);
    setText("studioDashDemandesOpen", n(demandes.ouvertes));
    setText("studioDashDemandesUrgentes", n(demandes.urgentes));
    setText("studioDashDemandesInProgress", n(demandes.prises_en_charge));
    renderActions(applyTypeActionFilter(data));
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
    renderMiniList("studioDashStructureItems", data.structures_prioritaires || [], "Aucune structure prioritaire.", "structures");
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
    render(data);
  }

  const HELP = {
    health: ["Santé globale du portefeuille", "Indicateur consolidé calculé à partir des risques de poste sur les structures du périmètre."],
    structures: ["Structures à surveiller", "Classement des clients et sites selon leur niveau de risque. Un clic ouvre l’espace de gestion."],
    demandes: ["Demandes terrain", "Besoins de formation envoyés depuis Insights par les managers ou responsables de périmètre vers Studio."],
    actions: ["Actions prioritaires", "Liste courte des actions à traiter en premier : formation, transmission, entretiens ou nettoyage du référentiel."],
    formation: ["Besoins formation", "Besoins remontés depuis Insights et encore à qualifier, prioriser ou transformer en action de formation."],
    entretiens: ["Entretiens à relancer", "Entretiens préparés, en cours ou en attente de signature."],
    transmission: ["Transmission à organiser", "Capacité consolidée à sécuriser les savoir-faire critiques."],
    referentiel: ["Qualité du référentiel", "Contrôles bloquants : postes sans compétence, collaborateurs sans poste, compétences sans domaine."],
    fiabilite: ["Fiabilité des données", "Mesure pragmatique de la qualité exploitable."],
  };

  function openHelp(key){
    const h = HELP[key] || ["Aide", "Indicateur du dashboard Studio."];
    setText("studioDashHelpTitle", h[0]);
    setText("studioDashHelpBody", h[1]);
    byId("studioDashHelpModal")?.classList.add("show");
  }
  function closeHelp(){ byId("studioDashHelpModal")?.classList.remove("show"); }

  function bind(){
    if (_bound) return;
    _bound = true;
    ["studioDashPerimetre", "studioDashPriorite", "studioDashActionType", "studioDashCriticite"].forEach(id => {
      const el = byId(id);
      if (!el) return;
      el.addEventListener("change", () => {
        if (id === "studioDashActionType" && _lastData){ render(_lastData); return; }
        load().catch(e => setStatus(e.message || String(e), true));
      });
      if (id === "studioDashCriticite") el.addEventListener("input", () => setText("studioDashCriticiteLabel", `≥ ${Math.round(n(el.value))}`));
    });
    byId("studioDashRefresh")?.addEventListener("click", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashHelpClose")?.addEventListener("click", closeHelp);
    byId("studioDashHelpModal")?.addEventListener("click", e => { if (e.target?.id === "studioDashHelpModal") closeHelp(); });
    document.querySelectorAll("#view-dashboard .studio-dash-help").forEach(btn => btn.addEventListener("click", () => openHelp(btn.dataset.help)));
  }

  bind();
  load().catch(e => setStatus(e.message || String(e), true));
})();
