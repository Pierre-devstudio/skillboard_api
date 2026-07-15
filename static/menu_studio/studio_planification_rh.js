(function () {
  let _bound = false;
  let _loaded = false;
  let _bootstrap = null;
  let _items = [];
  let _currentType = "indisponibilite";
  let _page = 1;
  let _pageSize = 25;
  let _indispoLineSeq = 0;
  const _campaignIncluded = new Set();
  const _campaignExcluded = new Set();
  const _competencesSelected = new Set();

  function root(){ return document.querySelector('#view-planification_rh[data-view="planification_rh"]'); }
  function byId(id){ return document.getElementById(id); }
  function esc(v){
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function clean(v){ return String(v ?? "").trim(); }
  function asArray(v){ return Array.isArray(v) ? v : []; }
  function lower(v){ return clean(v).toLowerCase(); }

  function getOwnerId(){
    const portalId = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (portalId) return portalId;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function scopedUrl(path, params){
    const url = new URL(`${window.portal.apiBase}${path}`, window.location.origin);
    const current = new URL(window.location.href);
    const idEnt = clean(current.searchParams.get("id_ent"));
    const ownerId = getOwnerId();
    if (idEnt && ownerId && idEnt !== ownerId) url.searchParams.set("id_ent", idEnt);
    Object.entries(params || {}).forEach(([k, v]) => {
      const val = clean(v);
      if (val) url.searchParams.set(k, val);
    });
    return url.toString();
  }

  function setMsg(id, msg, type){
    const el = byId(id);
    if (!el) return;
    const txt = clean(msg);
    el.textContent = txt;
    el.className = `studio-rh-inline-msg${type ? ` studio-rh-inline-msg--${type}` : ""}`;
    el.style.display = txt ? "" : "none";
  }

  function getErrorMessage(e){
    return e && (e.message || e.detail) ? (e.message || e.detail) : String(e || "Erreur inconnue");
  }

  function option(label, value, selected){
    return `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  }

  function collabs(){ return asArray((_bootstrap || {}).collaborateurs); }
  function services(){ return asArray((_bootstrap || {}).services); }
  function managers(){ return asArray((_bootstrap || {}).managers); }
  function competences(){ return asArray((_bootstrap || {}).competences); }
  function collabLabel(c){ return clean(c.label) || `${clean(c.prenom_effectif)} ${clean(c.nom_effectif)}`.trim() || clean(c.id_effectif); }
  function serviceLabel(s){ return clean(s.nom_service) || clean(s.id_service); }
  function competenceLabel(c){ return clean(c.intitule) || clean(c.id_comp); }

  function fillSelect(id, rows, valueKey, labelFn, placeholder, keepValue){
    const el = byId(id);
    if (!el) return;
    const current = keepValue ? clean(el.value) : "";
    const first = placeholder !== null ? option(placeholder || "Sélectionner", "", !current) : "";
    const opts = asArray(rows).map(r => option(labelFn(r), r[valueKey], current && clean(r[valueKey]) === current)).join("");
    el.innerHTML = first + opts;
    if (current && Array.from(el.options || []).some(o => o.value === current)) el.value = current;
  }

  function statutLabel(value){
    const map = {
      a_planifier: "À planifier", proposee: "À planifier", "proposée": "À planifier",
      planifie: "Planifié", planifiee: "Planifié", "planifiée": "Planifié", prevue: "Prévue", "prévue": "Prévue",
      en_cours: "En cours", realise: "Réalisé", realisee: "Réalisé", "réalisé": "Réalisé",
      terminee: "Terminée", "terminée": "Terminée", annule: "Annulé", "annulé": "Annulé",
      brouillon: "Brouillon", cloturee: "Clôturée", "clôturée": "Clôturée", archive: "Archivé", "archivé": "Archivé"
    };
    return map[clean(value).toLowerCase()] || clean(value) || "—";
  }

  function typeLabel(value){
    const map = {
      indisponibilite: "Indisponibilité",
      entretien_annuel: "Entretien annuel",
      entretien_competence: "Entretien compétence",
      evaluation_competence: "Évaluation compétence"
    };
    return map[clean(value)] || clean(value) || "Événement RH";
  }

  function dateLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dateOnlyLabel(raw);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  function dateOnlyLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    const d = new Date(`${raw.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric" });
  }

  function collabMatches(c, searchId, serviceId, posteSearchId){
    const q = lower(byId(searchId)?.value);
    const service = clean(byId(serviceId)?.value);
    const poste = lower(byId(posteSearchId)?.value);
    const hay = [collabLabel(c), c.email_effectif, c.nom_service].map(lower).join(" ");
    const posteHay = lower(c.intitule_poste);
    if (q && !hay.includes(q)) return false;
    if (service && clean(c.id_service) !== service) return false;
    if (poste && !posteHay.includes(poste)) return false;
    return true;
  }

  function filteredCollabs(searchId, serviceId, posteSearchId){
    return collabs().filter(c => collabMatches(c, searchId, serviceId, posteSearchId));
  }

  function getIndispoPosteMatches(){
    const q = lower(byId("planIndispoPosteSearch")?.value);
    const service = clean(byId("planIndispoService")?.value);
    const seen = new Map();
    collabs().forEach(c => {
      const poste = clean(c.intitule_poste);
      if (!poste) return;
      if (service && clean(c.id_service) !== service) return;
      if (q && !lower(poste).includes(q)) return;
      const key = lower(poste);
      if (!seen.has(key)) seen.set(key, { label: poste, count: 0 });
      seen.get(key).count += 1;
    });
    return Array.from(seen.values())
      .sort((a, b) => a.label.localeCompare(b.label, "fr", { sensitivity:"base" }))
      .slice(0, 30);
  }

  function closeIndispoPosteSuggestions(){
    const panel = byId("planIndispoPosteSuggestions");
    const input = byId("planIndispoPosteSearch");
    if (panel) panel.style.display = "none";
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function updateIndispoPosteSuggestions(){
    const list = byId("planIndispoPosteList");
    const panel = byId("planIndispoPosteSuggestions");
    const input = byId("planIndispoPosteSearch");
    const rows = getIndispoPosteMatches();
    if (list) list.innerHTML = rows.map(p => `<option value="${esc(p.label)}"></option>`).join("");
    if (!panel || !input) return;
    if (!rows.length) {
      panel.innerHTML = `<div class="studio-rh-suggest-empty">Aucun poste trouvé</div>`;
      panel.style.display = document.activeElement === input ? "" : "none";
      input.setAttribute("aria-expanded", panel.style.display === "none" ? "false" : "true");
      return;
    }
    panel.innerHTML = rows.slice(0, 8).map(p => `
      <button type="button" class="studio-rh-suggest-item" data-indispo-poste-suggestion="${esc(p.label)}">
        <span>${esc(p.label)}</span>
        <small>${p.count} collaborateur${p.count > 1 ? "s" : ""}</small>
      </button>`).join("");
    panel.style.display = document.activeElement === input ? "" : "none";
    input.setAttribute("aria-expanded", panel.style.display === "none" ? "false" : "true");
  }


  function getCompetencePosteMatches(){
    const q = lower(byId("planCompPosteSearch")?.value);
    const service = clean(byId("planCompService")?.value);
    const seen = new Map();
    collabs().forEach(c => {
      const poste = clean(c.intitule_poste);
      if (!poste) return;
      if (service && clean(c.id_service) !== service) return;
      if (q && !lower(poste).includes(q)) return;
      const key = lower(poste);
      if (!seen.has(key)) seen.set(key, { label: poste, count: 0 });
      seen.get(key).count += 1;
    });
    return Array.from(seen.values())
      .sort((a, b) => a.label.localeCompare(b.label, "fr", { sensitivity:"base" }))
      .slice(0, 30);
  }

  function closeCompetencePosteSuggestions(){
    const panel = byId("planCompPosteSuggestions");
    const input = byId("planCompPosteSearch");
    if (panel) panel.style.display = "none";
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function updateCompetencePosteSuggestions(){
    const list = byId("planCompPosteList");
    const panel = byId("planCompPosteSuggestions");
    const input = byId("planCompPosteSearch");
    const rows = getCompetencePosteMatches();
    if (list) list.innerHTML = rows.map(p => `<option value="${esc(p.label)}"></option>`).join("");
    if (!panel || !input) return;
    if (!rows.length) {
      panel.innerHTML = `<div class="studio-rh-suggest-empty">Aucun poste trouvé</div>`;
      panel.style.display = document.activeElement === input ? "" : "none";
      input.setAttribute("aria-expanded", panel.style.display === "none" ? "false" : "true");
      return;
    }
    panel.innerHTML = rows.slice(0, 8).map(p => `
      <button type="button" class="studio-rh-suggest-item" data-comp-poste-suggestion="${esc(p.label)}">
        <span>${esc(p.label)}</span>
        <small>${p.count} collaborateur${p.count > 1 ? "s" : ""}</small>
      </button>`).join("");
    panel.style.display = document.activeElement === input ? "" : "none";
    input.setAttribute("aria-expanded", panel.style.display === "none" ? "false" : "true");
  }

  function applyBootstrap(){
    const data = _bootstrap || {};
    const refsServices = services();
    const refsCollabs = collabs();
    const refsManagers = managers();

    fillSelect("planRhFilterType", asArray(data.types_evenements || []), "id", x => x.label, "Tous les types");
    fillSelect("planRhFilterService", refsServices, "id_service", serviceLabel, "Tous les services");
    fillSelect("planRhFilterCollab", refsCollabs, "id_effectif", collabLabel, "Tous les collaborateurs");
    fillSelect("planRhFilterStatut", [
      { id:"a_planifier", label:"À planifier" },
      { id:"planifie", label:"Planifié" },
      { id:"realise", label:"Réalisé" },
      { id:"annule", label:"Annulé" },
      { id:"archive", label:"Archivé" }
    ], "id", x => x.label, "Tous les statuts");

    fillSelect("planIndispoService", refsServices, "id_service", serviceLabel, "Tous les services", true);
    fillSelect("planCampagneService", refsServices, "id_service", serviceLabel, "Choisir un service", true);
    fillSelect("planCompService", refsServices, "id_service", serviceLabel, "Tous les services", true);
    fillSelect("planCompManager", refsManagers.length ? refsManagers : refsCollabs, "id_effectif", collabLabel, "Non renseigné", true);

    updateIndispoCollabOptions();
    updateCampagneScope();
    updateCompetenceCollabOptions();
    renderCompetenceChoices();
    updateCompetenceManagerOptions();

    const k = data.kpis || {};
    const set = (id, value) => { const el = byId(id); if (el) el.textContent = Number(value || 0).toString(); };
    set("planRhKpiTodo", k.a_planifier);
    set("planRhKpiPlanned", k.planifies);
    set("planRhKpiDone", k.realises);
    set("planRhKpiClosed", k.annules_archives);

    if (data.sql_ready === false) {
      setMsg("planRhMsg", "Tables calendrier RH absentes. Exécute le script SQL déjà présent dans docs/sql/20260701_insights_calendrier_rh.sql.", "warn");
    }
  }

  function serviceAncestors(idService){
    const ids = new Set();
    const byIdService = new Map(services().map(s => [clean(s.id_service), s]));
    let current = clean(idService);
    let guard = 0;
    while (current && !ids.has(current) && guard < 25) {
      ids.add(current);
      current = clean((byIdService.get(current) || {}).id_service_parent);
      guard += 1;
    }
    return ids;
  }

  function updateIndispoCollabOptions(){
    updateIndispoPosteSuggestions();
    fillSelect("planIndispoCollab", filteredCollabs("planIndispoSearch", "planIndispoService", "planIndispoPosteSearch"), "id_effectif", collabLabel, "Choisir un collaborateur", true);
  }

  function getCampaignPerimeterCollabs(){
    const p = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    if (p === "service") {
      const sid = clean(byId("planCampagneService")?.value);
      return sid ? collabs().filter(c => clean(c.id_service) === sid) : [];
    }
    if (p === "selection") {
      const ids = new Set(Array.from(_campaignIncluded));
      return collabs().filter(c => ids.has(clean(c.id_effectif)));
    }
    return collabs();
  }

  function campaignManagerRows(){
    const refsManagers = managers();
    if (!refsManagers.length) return [];
    const p = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    if (p === "entreprise") return refsManagers;

    const serviceIds = new Set();
    if (p === "service") {
      serviceAncestors(byId("planCampagneService")?.value).forEach(x => serviceIds.add(x));
    } else {
      getCampaignPerimeterCollabs().forEach(c => serviceAncestors(c.id_service).forEach(x => serviceIds.add(x)));
    }
    const rows = refsManagers.filter(m => serviceIds.has(clean(m.id_service)));
    return rows.length ? rows : refsManagers;
  }

  function updateCampaignManagerOptions(){
    fillSelect("planCampagneManager", campaignManagerRows(), "id_effectif", collabLabel, "Non renseigné", true);
  }

  function checkboxItemHtml(kind, id, label, meta, checked){
    return `
      <label class="studio-rh-check-item">
        <input type="checkbox" data-plan-check="${esc(kind)}" data-id="${esc(id)}"${checked ? " checked" : ""}>
        <span>
          <strong>${esc(label)}</strong>
          <small>${esc(meta || "")}</small>
        </span>
      </label>`;
  }

  function renderCollabCheckboxList(targetId, kind, rows, selectedSet, emptyText){
    const box = byId(targetId);
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `<div class="studio-rh-check-empty">${esc(emptyText || "Aucun collaborateur trouvé.")}</div>`;
      return;
    }
    box.innerHTML = rows.map(c => checkboxItemHtml(
      kind,
      clean(c.id_effectif),
      collabLabel(c),
      [clean(c.nom_service), clean(c.intitule_poste)].filter(Boolean).join(" · "),
      selectedSet.has(clean(c.id_effectif))
    )).join("");
  }

  function updateCampaignLists(){
    const p = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    const scopeRows = getCampaignPerimeterCollabs();
    const validScopeIds = new Set(scopeRows.map(c => clean(c.id_effectif)));
    Array.from(_campaignExcluded).forEach(id => { if (!validScopeIds.has(id)) _campaignExcluded.delete(id); });

    const includedSearch = lower(byId("planCampagneIncludedSearch")?.value);
    const excludedSearch = lower(byId("planCampagneExcludedSearch")?.value);
    const includedRows = collabs().filter(c => !includedSearch || [collabLabel(c), c.email_effectif, c.nom_service, c.intitule_poste].map(lower).join(" ").includes(includedSearch));
    const excludedRows = scopeRows.filter(c => !excludedSearch || [collabLabel(c), c.email_effectif, c.nom_service, c.intitule_poste].map(lower).join(" ").includes(excludedSearch));

    renderCollabCheckboxList("planCampagneIncludedList", "campagne-included", includedRows, _campaignIncluded, "Aucun collaborateur disponible.");
    renderCollabCheckboxList("planCampagneExcludedList", "campagne-excluded", excludedRows, _campaignExcluded, "Aucun collaborateur dans ce périmètre.");

    const incCount = byId("planCampagneIncludedCount");
    const excCount = byId("planCampagneExcludedCount");
    if (incCount) incCount.textContent = `${_campaignIncluded.size} sélectionné${_campaignIncluded.size > 1 ? "s" : ""}`;
    if (excCount) excCount.textContent = `${_campaignExcluded.size} exclu${_campaignExcluded.size > 1 ? "s" : ""}`;

    const excludedDetails = byId("planCampagneExcludedDetails");
    if (excludedDetails) excludedDetails.style.display = p === "selection" ? "none" : "";
    updateCampaignManagerOptions();
  }

  function updateCampagneScope(){
    const p = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    document.querySelectorAll("[data-campagne-scope]").forEach(el => {
      el.style.display = el.dataset.campagneScope === p ? "" : "none";
    });
    if (p !== "selection") _campaignIncluded.clear();
    if (p === "selection") _campaignExcluded.clear();
    updateCampaignLists();
  }

  function updateCompetenceCollabOptions(){
    updateCompetencePosteSuggestions();
    fillSelect("planCompCollab", filteredCollabs("planCompSearch", "planCompService", "planCompPosteSearch"), "id_effectif", collabLabel, "Choisir un collaborateur", true);
    updateCompetenceManagerOptions();
  }

  function updateCompetenceManagerOptions(){
    const selected = clean(byId("planCompCollab")?.value);
    const eff = collabs().find(c => clean(c.id_effectif) === selected);
    const refsManagers = managers();
    if (!eff || !refsManagers.length) {
      fillSelect("planCompManager", refsManagers, "id_effectif", collabLabel, "Non renseigné", true);
      return;
    }
    const ids = serviceAncestors(eff.id_service);
    const rows = refsManagers.filter(m => ids.has(clean(m.id_service)));
    fillSelect("planCompManager", rows.length ? rows : refsManagers, "id_effectif", collabLabel, "Non renseigné", true);
  }

  function isUuidLike(value){
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean(value));
  }

  function competenceMeta(c){
    const domaine = clean(c.domaine);
    if (!domaine || isUuidLike(domaine)) return "";
    return domaine;
  }

  function competenceHay(c){
    return [c.intitule, c.domaine, c.description, c.description_competence].map(lower).join(" ");
  }

  function competenceRank(c, q){
    const title = lower(competenceLabel(c));
    if (_competencesSelected.has(clean(c.id_comp))) return 0;
    if (q && title === q) return 1;
    if (q && title.startsWith(q)) return 2;
    return 3;
  }

  function competenceChoiceHtml(c){
    const id = clean(c.id_comp);
    const meta = competenceMeta(c);
    const checked = _competencesSelected.has(id);
    return `
      <label class="studio-rh-check-item studio-rh-check-item--competence${checked ? " is-selected" : ""}">
        <input type="checkbox" data-plan-check="competence" data-id="${esc(id)}"${checked ? " checked" : ""}>
        <span>
          <strong>${esc(competenceLabel(c))}</strong>
          ${meta ? `<small>${esc(meta)}</small>` : ""}
        </span>
      </label>`;
  }

  function renderSelectedCompetences(){
    const wrap = byId("planCompSelectedWrap");
    const list = byId("planCompSelectedList");
    if (!wrap || !list) return;
    const selectedRows = competences().filter(c => _competencesSelected.has(clean(c.id_comp)));
    wrap.style.display = selectedRows.length ? "" : "none";
    list.innerHTML = selectedRows.map(c => `
      <button type="button" class="studio-rh-selected-chip" data-competence-remove="${esc(clean(c.id_comp))}" title="Retirer cette compétence">
        <span>${esc(competenceLabel(c))}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`).join("");
  }

  function renderCompetenceChoices(){
    const box = byId("planCompCompetenceList");
    if (!box) return;
    const q = lower(byId("planCompCompetenceSearch")?.value);
    const rows = competences()
      .filter(c => !q || competenceHay(c).includes(q) || _competencesSelected.has(clean(c.id_comp)))
      .sort((a, b) => {
        const rank = competenceRank(a, q) - competenceRank(b, q);
        if (rank) return rank;
        return competenceLabel(a).localeCompare(competenceLabel(b), "fr", { sensitivity:"base" });
      })
      .slice(0, 90);
    if (!rows.length) {
      box.innerHTML = '<div class="studio-rh-check-empty">Aucune compétence trouvée.</div>';
    } else {
      box.innerHTML = rows.map(competenceChoiceHtml).join("");
    }
    renderSelectedCompetences();
    const count = byId("planCompCompetenceCount");
    if (count) count.textContent = `${_competencesSelected.size} sélectionnée${_competencesSelected.size > 1 ? "s" : ""}`;
  }

  async function loadBootstrap(){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner Studio introuvable.");
    _bootstrap = await window.portal.apiJson(scopedUrl(`/studio/planification/bootstrap/${encodeURIComponent(ownerId)}`));
    applyBootstrap();
  }

  function filters(){
    return {
      type: byId("planRhFilterType")?.value || "",
      id_service: byId("planRhFilterService")?.value || "",
      id_effectif: byId("planRhFilterCollab")?.value || "",
      statut: byId("planRhFilterStatut")?.value || ""
    };
  }

  async function loadItems(){
    const ownerId = getOwnerId();
    const data = await window.portal.apiJson(scopedUrl(`/studio/planification/items/${encodeURIComponent(ownerId)}`, filters()));
    _items = asArray(data.items);
    renderItems();
  }

  function getPlanRhPageData(items){
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const size = Math.max(1, Number(_pageSize) || 25);
    const totalPages = Math.max(1, Math.ceil(total / size));
    if (_page > totalPages) _page = totalPages;
    if (_page < 1) _page = 1;

    const start = total ? ((_page - 1) * size) : 0;
    const end = Math.min(start + size, total);
    return { total, totalPages, page:_page, pageSize:size, start, end, items:list.slice(start, end) };
  }

  function buildPlanRhPaginationTokens(totalPages, page){
    if (totalPages <= 5) {
      const all = [];
      for (let i = 1; i <= totalPages; i += 1) all.push(i);
      return all;
    }

    const tokens = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    if (start > 2) tokens.push("ellipsis-left");
    for (let i = start; i <= end; i += 1) tokens.push(i);
    if (end < totalPages - 1) tokens.push("ellipsis-right");
    tokens.push(totalPages);
    return tokens;
  }

  function renderPlanRhPagination(pageData){
    const total = pageData.total || 0;
    const totalPages = pageData.totalPages || 1;
    const page = pageData.page || 1;
    const prevDisabled = page <= 1 ? " disabled" : "";
    const nextDisabled = page >= totalPages ? " disabled" : "";
    const tokens = buildPlanRhPaginationTokens(totalPages, page);
    const range = total ? `${pageData.start + 1} – ${pageData.end} sur ${total}` : "0 sur 0";

    return `
      <div class="studio-rh-page-size-wrap">
        <select class="sb-select studio-rh-page-size-select" data-plan-page-size aria-label="Nombre d'événements par page">
          <option value="25"${_pageSize === 25 ? " selected" : ""}>25 par page</option>
          <option value="50"${_pageSize === 50 ? " selected" : ""}>50 par page</option>
          <option value="100"${_pageSize === 100 ? " selected" : ""}>100 par page</option>
        </select>
      </div>
      <div class="studio-rh-pagination" aria-label="Pagination événements RH">
        <button type="button" class="sb-icon-btn studio-rh-page-nav" data-plan-page-nav="prev" title="Page précédente" aria-label="Page précédente"${prevDisabled}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        ${tokens.map(t => {
          if (typeof t === "string") return '<span class="studio-rh-page-ellipsis" aria-hidden="true">…</span>';
          return `<button type="button" class="studio-rh-page-btn${t === page ? " is-active" : ""}" data-plan-page="${t}" aria-label="Page ${t}" aria-current="${t === page ? "page" : "false"}">${t}</button>`;
        }).join("")}
        <button type="button" class="sb-icon-btn studio-rh-page-nav" data-plan-page-nav="next" title="Page suivante" aria-label="Page suivante"${nextDisabled}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="studio-rh-range-label">${esc(range)}</div>
    `;
  }

  function renderItems(){
    const list = byId("planRhList");
    const empty = byId("planRhEmpty");
    const sub = byId("planRhListSubtitle");
    if (!list) return;
    if (sub) sub.textContent = `${_items.length} événement${_items.length > 1 ? "s" : ""} dans la liste de travail.`;

    if (!_items.length) {
      list.innerHTML = "";
      if (empty) empty.style.display = "block";
      return;
    }

    if (empty) empty.style.display = "none";
    const pageData = getPlanRhPageData(_items);
    const rows = pageData.items.map(item => {
      const isSuggestion = item.kind === "suggestion";
      const type = clean(item.type_evenement || item.type_suggestion);
      const metaDate = isSuggestion ? `Échéance : ${dateOnlyLabel(item.date_echeance)}` : `${dateLabel(item.date_debut)}${item.date_fin ? ` → ${dateLabel(item.date_fin)}` : ""}`;
      const action = isSuggestion ? `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-plan-open-calendar="${esc(item.id)}">Planifier</button>` : `<span class="studio-rh-table-muted">—</span>`;
      return `
        <div class="studio-rh-table-row studio-rh-row--${esc(type)}">
          <div class="studio-rh-table-cell studio-rh-table-cell--event">
            <span class="studio-rh-table-title">${esc(item.titre || typeLabel(type))}</span>
            <span class="studio-rh-table-sub">${esc(item.collaborateur || "Périmètre RH")}</span>
          </div>
          <div class="studio-rh-table-cell"><span class="studio-rh-badge studio-rh-badge--${esc(type)}">${esc(item.type_label || typeLabel(type))}</span></div>
          <div class="studio-rh-table-cell">${esc(item.nom_service || "Service non lié")}</div>
          <div class="studio-rh-table-cell">${esc(metaDate)}</div>
          <div class="studio-rh-table-cell"><span class="studio-rh-status">${esc(item.statut_label || statutLabel(item.statut))}</span></div>
          <div class="studio-rh-table-cell studio-rh-table-cell--actions">${action}</div>
        </div>`;
    }).join("");

    list.innerHTML = `
      <div class="studio-rh-table">
        <div class="studio-rh-table-row studio-rh-table-head">
          <div class="studio-rh-table-cell">Événement</div>
          <div class="studio-rh-table-cell">Type</div>
          <div class="studio-rh-table-cell">Service</div>
          <div class="studio-rh-table-cell">Date / période</div>
          <div class="studio-rh-table-cell">Statut</div>
          <div class="studio-rh-table-cell studio-rh-table-cell--actions">Action</div>
        </div>
        ${rows}
      </div>
      <div class="studio-rh-table-foot">
        ${renderPlanRhPagination(pageData)}
      </div>`;
  }

  function setFiltersCollapsed(collapsed){
    const card = byId("planRhListCard");
    const body = byId("planRhFilterBody");
    const btn = byId("planRhFiltersToggle");
    const isCollapsed = !!collapsed;
    if (card) card.classList.toggle("is-filters-collapsed", isCollapsed);
    if (body) body.style.display = isCollapsed ? "none" : "";
    if (btn) {
      btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      btn.title = isCollapsed ? "Déplier les filtres" : "Replier les filtres";
      btn.setAttribute("aria-label", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
    }
  }

  async function resetFilters(){
    ["planRhFilterType", "planRhFilterService", "planRhFilterCollab", "planRhFilterStatut"].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });
    _page = 1;
    await loadBootstrap();
    await loadItems();
  }

  function modalIconSvg(type){
    if (type === "campagne") return '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    if (type === "competence") return '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M8 7h8"/><path d="M8 11h6"/></svg>';
    return '<svg viewBox="0 0 24 24"><path d="M12 8v5l3 2"/><circle cx="12" cy="12" r="9"/></svg>';
  }

  function setCurrentType(type){
    _currentType = type || "indisponibilite";
    const modal = byId("modalPlanRhEvent");
    if (modal) {
      modal.classList.remove("studio-rh-modal--indisponibilite", "studio-rh-modal--campagne", "studio-rh-modal--competence");
      modal.classList.add(`studio-rh-modal--${_currentType}`);
    }
    document.querySelectorAll("[data-plan-form]").forEach(pane => {
      const active = pane.dataset.planForm === _currentType;
      pane.style.display = active ? "" : "none";
      pane.querySelectorAll("input, select, textarea, button").forEach(ctrl => { ctrl.disabled = !active; });
    });
    const title = byId("planRhModalTitle");
    const sub = byId("planRhModalSub");
    const icon = byId("planRhModalIcon");
    if (title) title.textContent = _currentType === "campagne" ? "Créer une campagne d’entretiens" : _currentType === "competence" ? "Créer une évaluation compétence" : "Créer une indisponibilité";
    if (sub) sub.textContent = _currentType === "campagne" ? "Préparez une campagne annuelle et générez les entretiens à planifier." : _currentType === "competence" ? "Préparez une ou plusieurs évaluations compétence pour un collaborateur." : "Ajoutez une ou plusieurs périodes d’indisponibilité pour un collaborateur.";
    if (icon) {
      icon.className = `studio-rh-modal-title-icon studio-rh-modal-title-icon--${_currentType}`;
      icon.innerHTML = modalIconSvg(_currentType);
    }
    updateCampagneScope();
    updateIndispoLinesCount();
  }

  function addIndispoLine(startValue, endValue){
    const box = byId("planIndispoLines");
    if (!box) return;
    _indispoLineSeq += 1;
    const id = _indispoLineSeq;
    const row = document.createElement("div");
    row.className = "studio-rh-lines-row studio-rh-indispo-line";
    row.dataset.line = String(id);
    row.innerHTML = `
      <label>
        <span class="label studio-rh-line-label">Date début</span>
        <input type="date" class="sb-date" data-indispo-start required value="${esc(startValue || "")}">
      </label>
      <label>
        <span class="label studio-rh-line-label">Date fin</span>
        <input type="date" class="sb-date" data-indispo-end required value="${esc(endValue || "")}">
      </label>
      <button type="button" class="sb-icon-btn studio-rh-line-delete" data-indispo-remove="${esc(id)}" title="Supprimer la ligne" aria-label="Supprimer la ligne">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>`;
    box.appendChild(row);
    updateIndispoLinesCount();
  }

  function ensureIndispoLine(){
    if (!byId("planIndispoLines")?.querySelector(".studio-rh-indispo-line")) addIndispoLine();
  }

  function updateIndispoLinesCount(){
    const count = byId("planIndispoLines")?.querySelectorAll(".studio-rh-indispo-line").length || 0;
    const el = byId("planIndispoLinesCount");
    if (el) el.textContent = `${count} ligne${count > 1 ? "s" : ""} saisie${count > 1 ? "s" : ""}`;
  }

  function removeIndispoLine(lineId){
    const rows = byId("planIndispoLines")?.querySelectorAll(".studio-rh-indispo-line") || [];
    if (rows.length <= 1) {
      setMsg("planRhModalMsg", "Conserve au moins une période d’indisponibilité.", "warn");
      return;
    }
    byId("planIndispoLines")?.querySelector(`[data-line="${String(lineId).replace(/"/g, "")}"]`)?.remove();
    updateIndispoLinesCount();
  }

  function resetModalState(){
    const form = byId("planRhForm");
    if (form) form.reset();
    _campaignIncluded.clear();
    _campaignExcluded.clear();
    _competencesSelected.clear();
    const lines = byId("planIndispoLines");
    closeIndispoPosteSuggestions();
    closeCompetencePosteSuggestions();
    if (lines) lines.innerHTML = "";
    _indispoLineSeq = 0;
    addIndispoLine();
    applyBootstrap();
  }

  function openModal(type){
    const modal = byId("modalPlanRhEvent");
    if (!modal) return;
    setMsg("planRhModalMsg", "");
    resetModalState();
    setCurrentType(type || _currentType);
    modal.style.display = "flex";
  }

  function closeModal(){
    const modal = byId("modalPlanRhEvent");
    if (modal) modal.style.display = "none";
  }

  function getIndispoPayloads(){
    const idEffectif = clean(byId("planIndispoCollab")?.value);
    const rows = Array.from(byId("planIndispoLines")?.querySelectorAll(".studio-rh-indispo-line") || []);
    if (!idEffectif) throw new Error("Sélectionne un collaborateur.");
    if (!rows.length) throw new Error("Ajoute au moins une période d’indisponibilité.");
    return rows.map(row => {
      const dateDebut = clean(row.querySelector("[data-indispo-start]")?.value);
      const dateFin = clean(row.querySelector("[data-indispo-end]")?.value);
      if (!dateDebut || !dateFin) throw new Error("Chaque ligne d’indisponibilité doit avoir une date début et une date fin.");
      return {
        id_effectif: idEffectif,
        date_debut: dateDebut,
        date_fin: dateFin
      };
    });
  }

  function payloadCampagne(){
    const perimetre = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    return {
      nom_campagne: clean(byId("planCampagneNom")?.value),
      periode_debut: clean(byId("planCampagneStart")?.value),
      periode_fin: clean(byId("planCampagneEnd")?.value),
      perimetre: perimetre,
      id_service: clean(byId("planCampagneService")?.value),
      collaborateurs_inclus: perimetre === "selection" ? Array.from(_campaignIncluded) : [],
      collaborateurs_exclus: perimetre === "selection" ? [] : Array.from(_campaignExcluded),
      id_manager: clean(byId("planCampagneManager")?.value),
      statut: "a_planifier",
      commentaire: clean(byId("planCampagneComment")?.value)
    };
  }

  function getCompetencePayloads(){
    const idEffectif = clean(byId("planCompCollab")?.value);
    const idsCompetences = Array.from(_competencesSelected);
    if (!idEffectif) throw new Error("Sélectionne un collaborateur.");
    if (!idsCompetences.length) throw new Error("Sélectionne au moins une compétence à évaluer.");
    return idsCompetences.map(idCompetence => ({
      id_effectif: idEffectif,
      type_entretien: "evaluation_competence",
      id_competence: idCompetence,
      date_cible: clean(byId("planCompDate")?.value),
      id_manager: clean(byId("planCompManager")?.value),
      statut: clean(byId("planCompStatut")?.value) || "a_planifier",
      commentaire: clean(byId("planCompComment")?.value)
    }));
  }

  async function postPayloads(url, payloads){
    for (const payload of payloads) {
      await window.portal.apiJson(scopedUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
  }

  async function submitForm(ev){
    ev.preventDefault();
    const ownerId = getOwnerId();
    if (!ownerId) return;
    const baseOwner = encodeURIComponent(ownerId);
    try {
      byId("planRhModalSave")?.setAttribute("disabled", "disabled");
      if (_currentType === "indisponibilite") {
        await postPayloads(`/studio/planification/indisponibilites/${baseOwner}`, getIndispoPayloads());
      } else if (_currentType === "campagne") {
        await postPayloads(`/studio/planification/campagnes/${baseOwner}`, [payloadCampagne()]);
      } else {
        await postPayloads(`/studio/planification/competence/${baseOwner}`, getCompetencePayloads());
      }
      closeModal();
      setMsg("planRhMsg", "Événement RH créé.", "ok");
      await loadBootstrap();
      await loadItems();
    } catch (e) {
      setMsg("planRhModalMsg", getErrorMessage(e), "error");
    } finally {
      byId("planRhModalSave")?.removeAttribute("disabled");
    }
  }

  function bind(){
    if (_bound) return;
    _bound = true;

    byId("planRhOpenCalendarBtn")?.addEventListener("click", () => window.portal.switchView("calendrier_rh"));
    byId("planRhCreateBtn")?.addEventListener("click", () => openModal("indisponibilite"));
    byId("planRhResetFiltersBtn")?.addEventListener("click", () => resetFilters().catch(e => setMsg("planRhMsg", getErrorMessage(e), "error")));
    byId("planRhFiltersToggle")?.addEventListener("click", () => {
      const collapsed = byId("planRhFiltersToggle")?.getAttribute("aria-expanded") === "true";
      setFiltersCollapsed(collapsed);
    });
    byId("planRhModalClose")?.addEventListener("click", closeModal);
    byId("planRhModalCancel")?.addEventListener("click", closeModal);
    byId("planRhForm")?.addEventListener("submit", submitForm);
    byId("planCampagnePerimetre")?.addEventListener("change", updateCampagneScope);
    byId("planCampagneService")?.addEventListener("change", updateCampaignLists);
    byId("planCompCollab")?.addEventListener("change", updateCompetenceManagerOptions);
    byId("planIndispoAddLine")?.addEventListener("click", () => addIndispoLine());

    ["planIndispoSearch", "planIndispoService", "planIndispoPosteSearch"].forEach(id => {
      const el = byId(id);
      if (!el) return;
      const eventName = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, updateIndispoCollabOptions);
    });
    byId("planIndispoPosteSearch")?.addEventListener("focus", updateIndispoPosteSuggestions);
    byId("planCompPosteSearch")?.addEventListener("focus", updateCompetencePosteSuggestions);
    ["planCompSearch", "planCompService", "planCompPosteSearch"].forEach(id => {
      const el = byId(id);
      if (!el) return;
      const eventName = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, updateCompetenceCollabOptions);
    });
    ["planCampagneIncludedSearch", "planCampagneExcludedSearch"].forEach(id => byId(id)?.addEventListener("input", updateCampaignLists));
    byId("planCompCompetenceSearch")?.addEventListener("input", renderCompetenceChoices);

    document.querySelectorAll("[data-plan-type]").forEach(btn => btn.addEventListener("click", () => openModal(btn.dataset.planType)));
    ["planRhFilterType", "planRhFilterService", "planRhFilterCollab", "planRhFilterStatut"].forEach(id => byId(id)?.addEventListener("change", async () => {
      _page = 1;
      await loadItems();
    }));
    document.addEventListener("change", (ev) => {
      const pageSizeSelect = ev.target.closest?.("[data-plan-page-size]");
      if (pageSizeSelect) {
        const nextSize = parseInt(pageSizeSelect.value, 10);
        _pageSize = Number.isFinite(nextSize) && nextSize > 0 ? nextSize : 25;
        _page = 1;
        renderItems();
        return;
      }

      const check = ev.target.closest?.("[data-plan-check]");
      if (!check) return;
      const id = clean(check.dataset.id);
      if (!id) return;
      if (check.dataset.planCheck === "campagne-included") {
        if (check.checked) _campaignIncluded.add(id);
        else _campaignIncluded.delete(id);
        updateCampaignLists();
      } else if (check.dataset.planCheck === "campagne-excluded") {
        if (check.checked) _campaignExcluded.add(id);
        else _campaignExcluded.delete(id);
        updateCampaignLists();
      } else if (check.dataset.planCheck === "competence") {
        if (check.checked) _competencesSelected.add(id);
        else _competencesSelected.delete(id);
        renderCompetenceChoices();
      }
    });
    document.addEventListener("click", (ev) => {
      const posteSuggestion = ev.target.closest?.("[data-indispo-poste-suggestion]");
      if (posteSuggestion) {
        const input = byId("planIndispoPosteSearch");
        if (input) input.value = posteSuggestion.getAttribute("data-indispo-poste-suggestion") || "";
        closeIndispoPosteSuggestions();
        updateIndispoCollabOptions();
        return;
      }
      const compPosteSuggestion = ev.target.closest?.("[data-comp-poste-suggestion]");
      if (compPosteSuggestion) {
        const input = byId("planCompPosteSearch");
        if (input) input.value = compPosteSuggestion.getAttribute("data-comp-poste-suggestion") || "";
        closeCompetencePosteSuggestions();
        updateCompetenceCollabOptions();
        return;
      }
      const competenceRemove = ev.target.closest?.("[data-competence-remove]");
      if (competenceRemove) {
        _competencesSelected.delete(clean(competenceRemove.getAttribute("data-competence-remove")));
        renderCompetenceChoices();
        return;
      }
      const posteField = ev.target.closest?.("#planIndispoPosteSearch, #planIndispoPosteSuggestions");
      if (!posteField) closeIndispoPosteSuggestions();
      const compPosteField = ev.target.closest?.("#planCompPosteSearch, #planCompPosteSuggestions");
      if (!compPosteField) closeCompetencePosteSuggestions();

      const removeLine = ev.target.closest?.("[data-indispo-remove]");
      if (removeLine) {
        removeIndispoLine(removeLine.getAttribute("data-indispo-remove"));
        return;
      }

      const planBtn = ev.target.closest?.("[data-plan-open-calendar]");
      if (planBtn) {
        window.portal.switchView("calendrier_rh");
        return;
      }

      const pageBtn = ev.target.closest?.("[data-plan-page], [data-plan-page-nav]");
      if (pageBtn) {
        const pageData = getPlanRhPageData(_items);
        const nav = pageBtn.getAttribute("data-plan-page-nav") || "";
        const rawPage = pageBtn.getAttribute("data-plan-page") || "";
        if (nav === "prev") _page = Math.max(1, pageData.page - 1);
        else if (nav === "next") _page = Math.min(pageData.totalPages, pageData.page + 1);
        else {
          const nextPage = parseInt(rawPage, 10);
          if (Number.isFinite(nextPage)) _page = Math.min(Math.max(1, nextPage), pageData.totalPages);
        }
        renderItems();
      }
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });
  }

  async function initStudioPlanificationRh(){
    if (!root()) return;
    bind();
    ensureIndispoLine();
    setCurrentType(_currentType);
    if (_loaded) return;
    _loaded = true;
    try {
      setMsg("planRhMsg", "");
      await loadBootstrap();
      await loadItems();
      setCurrentType(_currentType);
    } catch (e) {
      setMsg("planRhMsg", getErrorMessage(e), "error");
    }
  }

  window.initStudioPlanificationRh = initStudioPlanificationRh;
  document.addEventListener("DOMContentLoaded", initStudioPlanificationRh);
  setTimeout(initStudioPlanificationRh, 0);
})();
