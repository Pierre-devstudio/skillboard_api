(function () {
  let _bound = false;
  let _loaded = false;
  let _bootstrap = null;
  let _events = [];
  let _suggestions = [];
  let _month = new Date();
  _month = new Date(_month.getFullYear(), _month.getMonth(), 1);

  function root(){ return document.querySelector('#view-calendrier_rh[data-view="calendrier_rh"]'); }
  function byId(id){ return document.getElementById(id); }
  function clean(v){ return String(v ?? "").trim(); }
  function asArray(v){ return Array.isArray(v) ? v : []; }
  function esc(v){
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

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

  function getErrorMessage(e){ return e && (e.message || e.detail) ? (e.message || e.detail) : String(e || "Erreur inconnue"); }

  function option(label, value){ return `<option value="${esc(value)}">${esc(label)}</option>`; }
  function collabLabel(c){ return clean(c.label) || `${clean(c.prenom_effectif)} ${clean(c.nom_effectif)}`.trim() || clean(c.id_effectif); }
  function serviceLabel(s){ return clean(s.nom_service) || clean(s.id_service); }

  function fillSelect(id, rows, valueKey, labelFn, placeholder){
    const el = byId(id);
    if (!el) return;
    el.innerHTML = option(placeholder || "Tous", "") + asArray(rows).map(r => option(labelFn(r), r[valueKey])).join("");
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

  function statutLabel(value){
    const map = {
      a_planifier: "À planifier", proposee: "À planifier", "proposée": "À planifier",
      planifie: "Planifié", planifiee: "Planifié", "planifiée": "Planifié", prevue: "Prévue", "prévue": "Prévue",
      realise: "Réalisé", realisee: "Réalisé", "réalisé": "Réalisé",
      annule: "Annulé", "annulé": "Annulé", archive: "Archivé", "archivé": "Archivé", "archivée": "Archivé"
    };
    return map[clean(value).toLowerCase()] || clean(value) || "—";
  }

  function ymd(d){
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dateTimeLocal(value){
    const raw = clean(value);
    if (!raw) return "";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function dateLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
  }

  function fullDateLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString("fr-FR", { weekday:"long", day:"2-digit", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  function timeLabel(value){
    const raw = clean(value);
    if (!raw) return "—";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(11, 16) || raw;
    return d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
  }

  function eventTitle(ev){ return clean(ev && ev.titre) || typeLabel(ev && ev.type_evenement); }

  function isClosedEvent(ev){
    const statut = clean(ev && ev.statut).toLowerCase();
    return !!(ev && ev.archive) || ["annule", "annulé", "archive", "archivé", "archivée"].includes(statut);
  }

  function weekBounds(reference){
    const start = new Date(reference);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
  }

  function monthRange(){
    const first = new Date(_month.getFullYear(), _month.getMonth(), 1);
    const start = new Date(first);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 41);
    return { start, end };
  }

  function filters(extra){
    return Object.assign({
      type: byId("calRhFilterType")?.value || "",
      id_service: byId("calRhFilterService")?.value || "",
      id_effectif: byId("calRhFilterCollab")?.value || "",
      statut: byId("calRhFilterStatut")?.value || ""
    }, extra || {});
  }

  async function loadBootstrap(){
    const ownerId = getOwnerId();
    _bootstrap = await window.portal.apiJson(scopedUrl(`/studio/planification/bootstrap/${encodeURIComponent(ownerId)}`));
    fillSelect("calRhFilterType", asArray(_bootstrap.types_evenements || []), "id", x => x.label, "Tous les types");
    fillSelect("calRhFilterService", asArray(_bootstrap.services), "id_service", serviceLabel, "Tous les services");
    fillSelect("calRhFilterCollab", asArray(_bootstrap.collaborateurs), "id_effectif", collabLabel, "Tous les collaborateurs");
    fillSelect("calRhFilterStatut", [
      { id:"a_planifier", label:"À planifier" },
      { id:"planifie", label:"Planifié" },
      { id:"realise", label:"Réalisé" },
      { id:"annule", label:"Annulé" },
      { id:"archive", label:"Archivé" }
    ], "id", x => x.label, "Tous les statuts");
    if (_bootstrap.sql_ready === false) setMsg("calRhMsg", "Tables calendrier RH absentes. Exécute le script SQL déjà présent dans docs/sql/20260701_insights_calendrier_rh.sql.", "warn");
  }

  async function loadCalendar(){
    const ownerId = getOwnerId();
    const range = monthRange();
    const params = filters({ start: ymd(range.start), end: ymd(range.end) });
    const events = await window.portal.apiJson(scopedUrl(`/studio/calendrier/events/${encodeURIComponent(ownerId)}`, params));
    const suggestions = await window.portal.apiJson(scopedUrl(`/studio/calendrier/suggestions/${encodeURIComponent(ownerId)}`, filters()));
    _events = asArray(events);
    _suggestions = asArray(suggestions);
    renderAll();
  }

  function eventsByDay(day){
    const key = ymd(day);
    return _events.filter(ev => clean(ev.date_debut).slice(0, 10) === key);
  }

  function renderAll(){
    hideEventHover();
    renderKpis();
    renderTodo();
    renderCalendar();
  }

  function renderKpis(){
    const dated = _events.filter(ev => clean(ev.date_debut));
    const { start, end } = weekBounds(new Date());
    const week = dated.filter(ev => {
      const d = new Date(ev.date_debut);
      return !Number.isNaN(d.getTime()) && d >= start && d < end;
    });
    const closed = _events.filter(isClosedEvent);
    const values = {
      calRhKpiDated: dated.length,
      calRhKpiTodo: _suggestions.length,
      calRhKpiWeek: week.length,
      calRhKpiClosed: closed.length
    };
    Object.entries(values).forEach(([id, value]) => {
      const el = byId(id);
      if (el) el.textContent = String(value);
    });
  }

  function renderTodo(){
    const box = byId("calRhTodoList");
    const sub = byId("calRhTodoSub");
    if (sub) sub.textContent = `${_suggestions.length} événement${_suggestions.length > 1 ? "s" : ""} à dater.`;
    if (!box) return;
    if (!_suggestions.length) {
      box.innerHTML = `
        <div class="studio-rh-empty studio-rh-calendar-empty">
          <strong>Aucun événement à planifier</strong>
          <span>Les événements non datés apparaîtront ici.</span>
        </div>`;
      return;
    }
    box.innerHTML = _suggestions.map(s => `
      <article class="studio-rh-todo-item studio-rh-row--${esc(s.type_suggestion || s.type_evenement)}" draggable="true" data-suggestion-id="${esc(s.id_suggestion || s.id)}">
        <span class="studio-rh-todo-type">${esc(typeLabel(s.type_suggestion || s.type_evenement))}</span>
        <strong>${esc(s.titre || typeLabel(s.type_suggestion))}</strong>
        <span>${esc(s.collaborateur || "Périmètre RH")}</span>
        <small>${esc(s.nom_service || "Service non lié")} · ${esc(statutLabel(s.statut))}</small>
      </article>
    `).join("");
    box.querySelectorAll("[data-suggestion-id]").forEach(el => {
      el.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind:"suggestion", id: el.dataset.suggestionId }));
      });
    });
  }

  function renderCalendar(){
    const grid = byId("calRhGrid");
    if (!grid) return;
    const title = byId("calRhMonthTitle");
    const sub = byId("calRhMonthSub");
    if (title) title.textContent = _month.toLocaleDateString("fr-FR", { month:"long", year:"numeric" });
    if (sub) sub.textContent = `${_events.length} événement${_events.length > 1 ? "s" : ""} daté${_events.length > 1 ? "s" : ""} · ${_suggestions.length} à planifier`;

    const range = monthRange();
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(range.start);
      d.setDate(range.start.getDate() + i);
      days.push(d);
    }

    const todayKey = ymd(new Date());
    grid.innerHTML = days.map(day => {
      const inMonth = day.getMonth() === _month.getMonth();
      const dayEvents = eventsByDay(day);
      const dayKey = ymd(day);
      return `
        <div class="studio-rh-day${inMonth ? "" : " is-muted"}${dayKey === todayKey ? " is-today" : ""}" data-day="${dayKey}">
          <div class="studio-rh-day-number">${day.getDate()}</div>
          <div class="studio-rh-day-events">
            ${dayEvents.map(ev => {
              const id = clean(ev.id_evenement || ev.id);
              const titleText = eventTitle(ev);
              return `
                <button type="button" class="studio-rh-event-chip studio-rh-row--${esc(ev.type_evenement)}" draggable="true" data-event-id="${esc(id)}">
                  <span class="studio-rh-event-chip-main">
                    <span class="studio-rh-event-dot" aria-hidden="true"></span>
                    <span class="studio-rh-event-title">${esc(titleText)}</span>
                  </span>
                  <span class="studio-rh-event-meta">${esc(timeLabel(ev.date_debut))}${ev.collaborateur ? ` · ${esc(ev.collaborateur)}` : ""}</span>
                </button>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll("[data-day]").forEach(dayEl => {
      dayEl.addEventListener("dragover", ev => { ev.preventDefault(); dayEl.classList.add("is-dragover"); });
      dayEl.addEventListener("dragleave", () => dayEl.classList.remove("is-dragover"));
      dayEl.addEventListener("drop", async ev => {
        ev.preventDefault();
        dayEl.classList.remove("is-dragover");
        const raw = ev.dataTransfer.getData("text/plain");
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          await handleDrop(data, dayEl.dataset.day);
        } catch (e) {
          setMsg("calRhMsg", getErrorMessage(e), "error");
        }
      });
    });

    grid.querySelectorAll("[data-event-id]").forEach(el => {
      el.addEventListener("click", () => openEventModal(el.dataset.eventId));
      el.addEventListener("mouseenter", ev => showEventHover(el.dataset.eventId, ev));
      el.addEventListener("mousemove", ev => positionEventHover(ev));
      el.addEventListener("mouseleave", hideEventHover);
      el.addEventListener("focus", ev => showEventHover(el.dataset.eventId, ev));
      el.addEventListener("blur", hideEventHover);
      el.addEventListener("dragstart", ev => {
        hideEventHover();
        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind:"event", id: el.dataset.eventId }));
      });
    });
  }

  function eventById(id){ return _events.find(ev => clean(ev.id_evenement || ev.id) === clean(id)); }

  function showEventHover(id, ev){
    const item = eventById(id);
    const card = byId("calRhHoverCard");
    if (!item || !card) return;
    const payload = item.payload_json || {};
    const competence = clean(payload.competence || payload.competences_label || payload.intitule_competence);
    card.innerHTML = `
      <div class="studio-rh-popover-head">
        <span class="studio-rh-popover-type studio-rh-popover-type--${esc(item.type_evenement)}">${esc(typeLabel(item.type_evenement))}</span>
        <span class="studio-rh-popover-status">${esc(statutLabel(item.statut))}</span>
      </div>
      <strong class="studio-rh-popover-title">${esc(eventTitle(item))}</strong>
      <div class="studio-rh-popover-grid">
        <span>Date</span><strong>${esc(fullDateLabel(item.date_debut))}</strong>
        <span>Fin</span><strong>${esc(item.date_fin ? fullDateLabel(item.date_fin) : "Non renseignée")}</strong>
        <span>Collaborateur</span><strong>${esc(item.collaborateur || "Périmètre RH")}</strong>
        <span>Service</span><strong>${esc(item.nom_service || "Service non lié")}</strong>
        ${competence ? `<span>Compétence</span><strong>${esc(competence)}</strong>` : ""}
      </div>
      <div class="studio-rh-popover-foot">Cliquez pour ouvrir le détail.</div>
    `;
    card.hidden = false;
    positionEventHover(ev);
  }

  function positionEventHover(ev){
    const card = byId("calRhHoverCard");
    if (!card || card.hidden) return;
    const source = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
    const x = ev && typeof ev.clientX === "number" ? ev.clientX : (source ? source.left + source.width : window.innerWidth / 2);
    const y = ev && typeof ev.clientY === "number" ? ev.clientY : (source ? source.top : window.innerHeight / 2);
    const width = 320;
    const padding = 14;
    let left = x + 16;
    let top = y + 16;
    if (left + width + padding > window.innerWidth) left = Math.max(padding, x - width - 16);
    const height = card.offsetHeight || 230;
    if (top + height + padding > window.innerHeight) top = Math.max(padding, window.innerHeight - height - padding);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function hideEventHover(){
    const card = byId("calRhHoverCard");
    if (card) card.hidden = true;
  }

  async function handleDrop(data, day){
    const ownerId = getOwnerId();
    if (data.kind === "suggestion") {
      await window.portal.apiJson(scopedUrl(`/studio/calendrier/events/from-suggestion/${encodeURIComponent(ownerId)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_suggestion: data.id, date_debut: `${day}T09:00`, date_fin: `${day}T10:00`, statut: "planifie" })
      });
      setMsg("calRhMsg", "Brique planifiée dans le calendrier.", "ok");
      await loadCalendar();
      return;
    }

    if (data.kind === "event") {
      const ev = eventById(data.id);
      if (!ev) return;
      const start = new Date(ev.date_debut);
      const end = ev.date_fin ? new Date(ev.date_fin) : null;
      const hh = Number.isNaN(start.getTime()) ? "09" : String(start.getHours()).padStart(2, "0");
      const mm = Number.isNaN(start.getTime()) ? "00" : String(start.getMinutes()).padStart(2, "0");
      let newEnd = "";
      if (end && !Number.isNaN(end.getTime()) && !Number.isNaN(start.getTime())) {
        const duration = Math.max(30, Math.round((end.getTime() - start.getTime()) / 60000));
        const dt = new Date(`${day}T${hh}:${mm}:00`);
        dt.setMinutes(dt.getMinutes() + duration);
        newEnd = dateTimeLocal(dt.toISOString());
      }
      await patchEvent(data.id, { date_debut: `${day}T${hh}:${mm}`, date_fin: newEnd || undefined });
      setMsg("calRhMsg", "Événement déplacé.", "ok");
      await loadCalendar();
    }
  }

  function openEventModal(id){
    const ev = eventById(id);
    if (!ev) return;
    setMsg("calRhModalMsg", "");
    byId("calRhEventId").value = clean(ev.id_evenement || ev.id);
    byId("calRhEventTitle").value = clean(ev.titre);
    byId("calRhEventType").value = clean(ev.type_evenement) || "evenement_rh";
    byId("calRhEventStatus").value = clean(ev.archive) === "true" ? "archive" : clean(ev.statut) || "planifie";
    byId("calRhEventStart").value = dateTimeLocal(ev.date_debut);
    byId("calRhEventEnd").value = dateTimeLocal(ev.date_fin);
    const meta = byId("calRhEventMeta");
    if (meta) {
      meta.innerHTML = `
        <div><strong>Collaborateur</strong><span>${esc(ev.collaborateur || "Périmètre RH")}</span></div>
        <div><strong>Service</strong><span>${esc(ev.nom_service || "Service non lié")}</span></div>
        <div><strong>Type</strong><span>${esc(typeLabel(ev.type_evenement))}</span></div>
      `;
    }
    const modal = byId("modalCalRhEvent");
    if (modal) modal.style.display = "flex";
  }

  function closeModal(){ const modal = byId("modalCalRhEvent"); if (modal) modal.style.display = "none"; }

  async function patchEvent(id, payload){
    const ownerId = getOwnerId();
    return await window.portal.apiJson(scopedUrl(`/studio/calendrier/events/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  async function submitForm(ev){
    ev.preventDefault();
    const id = clean(byId("calRhEventId")?.value);
    if (!id) return;
    try {
      byId("calRhModalSave")?.setAttribute("disabled", "disabled");
      const statut = clean(byId("calRhEventStatus")?.value) || "planifie";
      await patchEvent(id, {
        titre: clean(byId("calRhEventTitle")?.value),
        type_evenement: clean(byId("calRhEventType")?.value),
        statut,
        date_debut: clean(byId("calRhEventStart")?.value),
        date_fin: clean(byId("calRhEventEnd")?.value),
        archive: statut === "archive"
      });
      closeModal();
      setMsg("calRhMsg", "Événement mis à jour.", "ok");
      await loadCalendar();
    } catch (e) {
      setMsg("calRhModalMsg", getErrorMessage(e), "error");
    } finally {
      byId("calRhModalSave")?.removeAttribute("disabled");
    }
  }

  async function cancelOrArchive(status){
    const id = clean(byId("calRhEventId")?.value);
    if (!id) return;
    try {
      await patchEvent(id, { statut: status, archive: status === "archive" });
      closeModal();
      setMsg("calRhMsg", status === "archive" ? "Événement archivé." : "Événement annulé.", "ok");
      await loadCalendar();
    } catch (e) {
      setMsg("calRhModalMsg", getErrorMessage(e), "error");
    }
  }

  function resetFilters(){
    ["calRhFilterType", "calRhFilterService", "calRhFilterCollab", "calRhFilterStatut"].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });
    loadCalendar();
  }

  function toggleFilters(){
    const card = byId("calRhFilterCard");
    const btn = byId("calRhFiltersToggle");
    if (!card || !btn) return;
    const isCollapsed = !card.classList.contains("is-filters-collapsed");
    card.classList.toggle("is-filters-collapsed", isCollapsed);
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.setAttribute("title", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
    btn.setAttribute("aria-label", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
  }

  function bind(){
    if (_bound) return;
    _bound = true;
    byId("calRhBackPlanBtn")?.addEventListener("click", () => window.portal.switchView("planification_rh"));
    byId("calRhRefreshBtn")?.addEventListener("click", loadCalendar);
    byId("calRhResetFiltersBtn")?.addEventListener("click", resetFilters);
    byId("calRhFiltersToggle")?.addEventListener("click", toggleFilters);
    byId("calRhPrevMonth")?.addEventListener("click", async () => { _month = new Date(_month.getFullYear(), _month.getMonth() - 1, 1); await loadCalendar(); });
    byId("calRhNextMonth")?.addEventListener("click", async () => { _month = new Date(_month.getFullYear(), _month.getMonth() + 1, 1); await loadCalendar(); });
    byId("calRhTodayBtn")?.addEventListener("click", async () => { const now = new Date(); _month = new Date(now.getFullYear(), now.getMonth(), 1); await loadCalendar(); });
    byId("calRhModalClose")?.addEventListener("click", closeModal);
    byId("calRhModalCancel")?.addEventListener("click", closeModal);
    byId("calRhForm")?.addEventListener("submit", submitForm);
    byId("calRhCancelEventBtn")?.addEventListener("click", () => cancelOrArchive("annule"));
    byId("calRhArchiveEventBtn")?.addEventListener("click", () => cancelOrArchive("archive"));
    ["calRhFilterType", "calRhFilterService", "calRhFilterCollab", "calRhFilterStatut"].forEach(id => byId(id)?.addEventListener("change", loadCalendar));
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeModal(); hideEventHover(); } });
    window.addEventListener("scroll", hideEventHover, true);
  }

  async function initStudioCalendrierRh(){
    if (!root()) return;
    bind();
    if (_loaded) return;
    _loaded = true;
    try {
      setMsg("calRhMsg", "");
      await loadBootstrap();
      await loadCalendar();
    } catch (e) {
      setMsg("calRhMsg", getErrorMessage(e), "error");
    }
  }

  window.initStudioCalendrierRh = initStudioCalendrierRh;
  document.addEventListener("DOMContentLoaded", initStudioCalendrierRh);
  setTimeout(initStudioCalendrierRh, 0);
})();
