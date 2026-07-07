(function () {
  let _bound = false;
  let _loaded = false;
  let _bootstrap = null;
  let _items = [];
  let _currentType = "indisponibilite";

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

  function selectedValues(selectId){
    const el = byId(selectId);
    if (!el) return [];
    return Array.from(el.selectedOptions || []).map(o => clean(o.value)).filter(Boolean);
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

  function collabLabel(c){ return clean(c.label) || `${clean(c.prenom_effectif)} ${clean(c.nom_effectif)}`.trim() || clean(c.id_effectif); }
  function serviceLabel(s){ return clean(s.nom_service) || clean(s.id_service); }
  function competenceLabel(c){ return clean(c.intitule) || clean(c.id_comp); }

  function fillSelect(id, rows, valueKey, labelFn, placeholder){
    const el = byId(id);
    if (!el) return;
    const first = placeholder !== null ? option(placeholder || "Sélectionner", "", false) : "";
    el.innerHTML = first + asArray(rows).map(r => option(labelFn(r), r[valueKey], false)).join("");
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

  function applyBootstrap(){
    const data = _bootstrap || {};
    const services = asArray(data.services);
    const collaborateurs = asArray(data.collaborateurs);
    const managers = asArray(data.managers);
    const competences = asArray(data.competences);

    fillSelect("planRhFilterType", asArray(data.types_evenements || []), "id", x => x.label, "Tous les types");
    fillSelect("planRhFilterService", services, "id_service", serviceLabel, "Tous les services");
    fillSelect("planRhFilterCollab", collaborateurs, "id_effectif", collabLabel, "Tous les collaborateurs");
    fillSelect("planRhFilterStatut", [
      { id:"a_planifier", label:"À planifier" },
      { id:"planifie", label:"Planifié" },
      { id:"realise", label:"Réalisé" },
      { id:"annule", label:"Annulé" },
      { id:"archive", label:"Archivé" }
    ], "id", x => x.label, "Tous les statuts");

    fillSelect("planIndispoCollab", collaborateurs, "id_effectif", collabLabel, "Choisir un collaborateur");
    fillSelect("planCampagneService", services, "id_service", serviceLabel, "Choisir un service");
    fillSelect("planCampagneManager", managers.length ? managers : collaborateurs, "id_effectif", collabLabel, "Non renseigné");
    fillSelect("planCampagneIncluded", collaborateurs, "id_effectif", collabLabel, null);
    fillSelect("planCampagneExcluded", collaborateurs, "id_effectif", collabLabel, null);
    fillSelect("planCompCollab", collaborateurs, "id_effectif", collabLabel, "Choisir un collaborateur");
    fillSelect("planCompManager", managers.length ? managers : collaborateurs, "id_effectif", collabLabel, "Non renseigné");
    fillSelect("planCompCompetence", competences, "id_comp", competenceLabel, "Non précisée");

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

  function toggleCampagneScope(){
    const p = clean(byId("planCampagnePerimetre")?.value) || "entreprise";
    document.querySelectorAll("[data-campagne-scope]").forEach(el => {
      el.style.display = el.dataset.campagneScope === p ? "" : "none";
    });
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

  function renderItems(){
    const list = byId("planRhList");
    const sub = byId("planRhListSubtitle");
    if (!list) return;
    if (sub) sub.textContent = `${_items.length} élément${_items.length > 1 ? "s" : ""} dans la liste de travail.`;
    if (!_items.length) {
      list.innerHTML = `<div class="studio-rh-empty">Aucun événement sur ces filtres. Donc, pour une fois, le silence est une information.</div>`;
      return;
    }
    list.innerHTML = _items.map(item => {
      const isSuggestion = item.kind === "suggestion";
      const metaDate = isSuggestion ? `Échéance : ${dateOnlyLabel(item.date_echeance)}` : `${dateLabel(item.date_debut)}${item.date_fin ? ` → ${dateLabel(item.date_fin)}` : ""}`;
      const action = isSuggestion ? `<button type="button" class="sb-btn sb-btn--soft" data-plan-open-calendar="${esc(item.id)}">Planifier</button>` : "";
      return `
        <article class="studio-rh-row studio-rh-row--${esc(item.type_evenement || item.type_suggestion)}">
          <div class="studio-rh-row-main">
            <div class="studio-rh-row-title">${esc(item.titre || typeLabel(item.type_evenement))}</div>
            <div class="studio-rh-row-meta">
              <span>${esc(item.collaborateur || "Périmètre RH")}</span>
              <span>${esc(item.nom_service || "Service non lié")}</span>
              <span>${esc(metaDate)}</span>
            </div>
          </div>
          <div class="studio-rh-row-side">
            <span class="studio-rh-badge studio-rh-badge--${esc(item.type_evenement || item.type_suggestion)}">${esc(item.type_label || typeLabel(item.type_evenement || item.type_suggestion))}</span>
            <span class="studio-rh-status">${esc(item.statut_label || statutLabel(item.statut))}</span>
            ${action}
          </div>
        </article>`;
    }).join("");
  }

  function setCurrentType(type){
    _currentType = type || "indisponibilite";
    document.querySelectorAll("[data-plan-tab]").forEach(btn => btn.classList.toggle("is-active", btn.dataset.planTab === _currentType));
    document.querySelectorAll("[data-plan-form]").forEach(pane => pane.style.display = pane.dataset.planForm === _currentType ? "" : "none");
    const title = byId("planRhModalTitle");
    const sub = byId("planRhModalSub");
    if (title) title.textContent = _currentType === "campagne" ? "Créer une campagne d’entretiens" : _currentType === "competence" ? "Créer un entretien / une évaluation" : "Créer une indisponibilité";
    if (sub) sub.textContent = _currentType === "campagne" ? "Génère des briques d’entretiens annuels à planifier." : _currentType === "competence" ? "Prépare un entretien ou une évaluation compétence, datée ou non." : "Crée une période d’indisponibilité collaborateur.";
    toggleCampagneScope();
  }

  function openModal(type){
    const modal = byId("modalPlanRhEvent");
    if (!modal) return;
    setMsg("planRhModalMsg", "");
    setCurrentType(type || _currentType);
    modal.style.display = "flex";
  }

  function closeModal(){
    const modal = byId("modalPlanRhEvent");
    if (modal) modal.style.display = "none";
  }

  function payloadIndispo(){
    return {
      id_effectif: clean(byId("planIndispoCollab")?.value),
      type_indisponibilite: clean(byId("planIndispoType")?.value),
      date_debut: clean(byId("planIndispoStart")?.value),
      date_fin: clean(byId("planIndispoEnd")?.value),
      statut: clean(byId("planIndispoStatut")?.value) || "prevue",
      commentaire: clean(byId("planIndispoComment")?.value)
    };
  }

  function payloadCampagne(){
    return {
      nom_campagne: clean(byId("planCampagneNom")?.value),
      periode_debut: clean(byId("planCampagneStart")?.value),
      periode_fin: clean(byId("planCampagneEnd")?.value),
      perimetre: clean(byId("planCampagnePerimetre")?.value) || "entreprise",
      id_service: clean(byId("planCampagneService")?.value),
      collaborateurs_inclus: selectedValues("planCampagneIncluded"),
      collaborateurs_exclus: selectedValues("planCampagneExcluded"),
      id_manager: clean(byId("planCampagneManager")?.value),
      statut: clean(byId("planCampagneStatut")?.value) || "a_planifier",
      commentaire: clean(byId("planCampagneComment")?.value)
    };
  }

  function payloadCompetence(){
    return {
      id_effectif: clean(byId("planCompCollab")?.value),
      type_entretien: clean(byId("planCompType")?.value) || "entretien_competence",
      id_competence: clean(byId("planCompCompetence")?.value),
      date_cible: clean(byId("planCompDate")?.value),
      id_manager: clean(byId("planCompManager")?.value),
      statut: clean(byId("planCompStatut")?.value) || "a_planifier",
      commentaire: clean(byId("planCompComment")?.value)
    };
  }

  async function submitForm(ev){
    ev.preventDefault();
    const ownerId = getOwnerId();
    if (!ownerId) return;
    const map = {
      indisponibilite: { url: `/studio/planification/indisponibilites/${encodeURIComponent(ownerId)}`, payload: payloadIndispo() },
      campagne: { url: `/studio/planification/campagnes/${encodeURIComponent(ownerId)}`, payload: payloadCampagne() },
      competence: { url: `/studio/planification/competence/${encodeURIComponent(ownerId)}`, payload: payloadCompetence() }
    };
    const cfg = map[_currentType] || map.indisponibilite;
    try {
      byId("planRhModalSave")?.setAttribute("disabled", "disabled");
      await window.portal.apiJson(scopedUrl(cfg.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg.payload)
      });
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
    byId("planRhRefreshBtn")?.addEventListener("click", async () => { await loadBootstrap(); await loadItems(); });
    byId("planRhModalClose")?.addEventListener("click", closeModal);
    byId("planRhModalCancel")?.addEventListener("click", closeModal);
    byId("planRhForm")?.addEventListener("submit", submitForm);
    byId("planCampagnePerimetre")?.addEventListener("change", toggleCampagneScope);

    document.querySelectorAll("[data-plan-type]").forEach(btn => btn.addEventListener("click", () => openModal(btn.dataset.planType)));
    document.querySelectorAll("[data-plan-tab]").forEach(btn => btn.addEventListener("click", () => setCurrentType(btn.dataset.planTab)));
    ["planRhFilterType", "planRhFilterService", "planRhFilterCollab", "planRhFilterStatut"].forEach(id => byId(id)?.addEventListener("change", loadItems));
    document.addEventListener("click", (ev) => {
      const planBtn = ev.target.closest?.("[data-plan-open-calendar]");
      if (planBtn) window.portal.switchView("calendrier_rh");
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });
  }

  async function initStudioPlanificationRh(){
    if (!root()) return;
    bind();
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
