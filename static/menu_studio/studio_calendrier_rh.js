(function () {
  let _bound = false;
  let _loaded = false;
  let _bootstrap = null;
  let _events = [];
  let _suggestions = [];
  let _month = new Date();
  const _calendarTypeGroups = {
    indisponibilite: ["indisponibilite"],
    entretien_annuel: ["entretien_annuel"],
    evaluation_competence: ["evaluation_competence", "entretien_competence"]
  };
  const _hiddenCalendarGroups = new Set();
  const _calendarFilterTypes = [
    { id:"indisponibilite", label:"Indisponibilités", groups:["indisponibilite"] },
    { id:"entretien_annuel", label:"Entretiens annuels", groups:["entretien_annuel"] },
    { id:"evaluation_competence", label:"Évaluations compétence", groups:["evaluation_competence"] }
  ];
  const _calendarFilterStatus = [
    { id:"a_planifier", label:"À planifier" },
    { id:"planifie", label:"Planifié" },
    { id:"realise", label:"Réalisé" },
    { id:"annule", label:"Annulé" },
    { id:"archive", label:"Archivé" }
  ];
  let _todoFilterType = "";
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

  function calendarGroupForType(value){
    const type = clean(value);
    return Object.entries(_calendarTypeGroups).find(([, types]) => types.includes(type))?.[0] || type || "autre";
  }

  function isCalendarGroupVisible(value){
    return !_hiddenCalendarGroups.has(calendarGroupForType(value));
  }

  function checkedValues(containerId){
    return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(input => clean(input.value)).filter(Boolean);
  }

  function eventStatusKey(ev){
    const statut = clean(ev && ev.statut).toLowerCase();
    if ((ev && ev.archive) || ["archive", "archivé", "archivée"].includes(statut)) return "archive";
    if (["annule", "annulé"].includes(statut)) return "annule";
    if (["realise", "realisee", "réalisé", "réalisée"].includes(statut)) return "realise";
    if (["a_planifier", "proposee", "proposée"].includes(statut)) return "a_planifier";
    return "planifie";
  }

  function selectedCalendarGroups(){
    const checked = checkedValues("calRhTypeChecks");
    return new Set(checked);
  }

  function activeFilterState(){
    return {
      groups: selectedCalendarGroups(),
      services: new Set(checkedValues("calRhServiceChecks")),
      collaborateurs: new Set(checkedValues("calRhCollabChecks")),
      statuts: new Set(checkedValues("calRhStatusChecks"))
    };
  }

  function eventPassesUiFilters(ev, state){
    const filters = state || activeFilterState();
    const group = calendarGroupForType(ev && ev.type_evenement);
    if (!filters.groups.has(group)) return false;
    const serviceId = clean(ev && ev.id_service);
    if (filters.services.size && (!serviceId || !filters.services.has(serviceId))) return false;
    const collabId = clean(ev && ev.id_effectif);
    if (filters.collaborateurs.size && (!collabId || !filters.collaborateurs.has(collabId))) return false;
    const statut = eventStatusKey(ev);
    if (filters.statuts.size && !filters.statuts.has(statut)) return false;
    return true;
  }

  function visibleCalendarEvents(){
    const state = activeFilterState();
    return _events.filter(ev => eventPassesUiFilters(ev, state));
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


  function parseDay(value){
    const raw = clean(value);
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
    const [y, m, d] = raw.slice(0, 10).split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function eventRange(ev){
    const start = parseDay(ev && ev.date_debut);
    if (!start) return null;
    const end = parseDay(ev && (ev.date_fin || ev.date_debut)) || new Date(start);
    if (end < start) return { start, end: new Date(start) };
    return { start, end };
  }

  function sameDay(a, b){
    return !!(a && b) && ymd(a) === ymd(b);
  }

  function isEventMultiDay(ev){
    const range = eventRange(ev);
    return !!(range && !sameDay(range.start, range.end));
  }

  function dayInEventRange(ev, day){
    const range = eventRange(ev);
    if (!range) return false;
    const current = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    return current >= range.start && current <= range.end;
  }

  function eventSegment(ev, day){
    const range = eventRange(ev);
    if (!range) return { classes: "", label: "" };
    const isStart = sameDay(day, range.start);
    const isEnd = sameDay(day, range.end);
    if (isStart && isEnd) return { classes: "is-range-single", label: "" };
    if (isStart) return { classes: "is-range is-range-start", label: "Début" };
    if (isEnd) return { classes: "is-range is-range-end", label: "Fin" };
    return { classes: "is-range is-range-middle", label: "En cours" };
  }

  function dateTimeLocal(value){
    const raw = clean(value);
    if (!raw) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00`;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function dateOnlyFr(value, withYear){
    const raw = clean(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return clean(value) || "Non daté";
    const [y, m, d] = raw.split("-");
    return withYear ? `${d}/${m}/${y}` : `${d}/${m}`;
  }

  function dateLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dateOnlyFr(raw, true);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
  }

  function fullDateLabel(value){
    const raw = clean(value);
    if (!raw) return "Non daté";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dateOnlyFr(raw, true);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleString("fr-FR", { weekday:"long", day:"2-digit", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit" });
  }

  function timeLabel(value){
    const raw = clean(value);
    if (!raw) return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "Journée";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(11, 16) || raw;
    return d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
  }

  function breakRangeLabel(ev){
    if (!ev || ev.source !== "effectif_break") return "";
    const start = dateOnlyFr(ev.date_debut, false);
    const end = dateOnlyFr(ev.date_fin, false);
    return start === end ? "Journée" : `${start} → ${end}`;
  }

  function eventChipMeta(ev){
    if (ev && ev.source === "effectif_break") {
      const range = breakRangeLabel(ev);
      return `${range}${ev.collaborateur ? ` · ${ev.collaborateur}` : ""}`;
    }
    return `${timeLabel(ev && ev.date_debut)}${ev && ev.collaborateur ? ` · ${ev.collaborateur}` : ""}`;
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

  function checkItemHtml(value, label, checked, meta){
    return `
      <label class="studio-rh-check-item">
        <input type="checkbox" value="${esc(value)}"${checked ? " checked" : ""}>
        <span>${esc(label)}</span>
        ${meta ? `<small>${esc(meta)}</small>` : ""}
      </label>`;
  }

  function renderCheckList(id, rows, valueFn, labelFn, checkedFn, metaFn){
    const box = byId(id);
    if (!box) return;
    const items = asArray(rows);
    if (!items.length) {
      box.innerHTML = `<div class="studio-rh-filter-empty">Aucune donnée.</div>`;
      return;
    }
    box.innerHTML = items.map(row => checkItemHtml(valueFn(row), labelFn(row), checkedFn ? checkedFn(row) : false, metaFn ? metaFn(row) : "")).join("");
    box.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", handleFilterChange));
  }

  function selectedServiceIds(){ return new Set(checkedValues("calRhServiceChecks")); }

  function renderDynamicCollaborators(){
    const services = selectedServiceIds();
    const query = clean(byId("calRhCollabSearch")?.value).toLowerCase();
    const selected = new Set(checkedValues("calRhCollabChecks"));
    let rows = asArray(_bootstrap && _bootstrap.collaborateurs);
    if (services.size) rows = rows.filter(c => services.has(clean(c.id_service)));
    if (query) {
      rows = rows.filter(c => collabLabel(c).toLowerCase().includes(query)
        || clean(c.email_effectif).toLowerCase().includes(query)
        || clean(c.matricule_effectif).toLowerCase().includes(query));
    }
    rows = rows.slice().sort((a, b) => collabLabel(a).localeCompare(collabLabel(b), "fr"));
    renderCheckList("calRhCollabChecks", rows, c => clean(c.id_effectif), collabLabel, c => selected.has(clean(c.id_effectif)), c => serviceLabel(c));
  }

  function renderFilterPanel(){
    renderCheckList("calRhTypeChecks", _calendarFilterTypes, x => x.id, x => x.label, () => true);
    renderCheckList("calRhServiceChecks", asArray(_bootstrap && _bootstrap.services).slice().sort((a, b) => serviceLabel(a).localeCompare(serviceLabel(b), "fr")), s => clean(s.id_service), serviceLabel, () => false);
    renderCheckList("calRhStatusChecks", _calendarFilterStatus, x => x.id, x => x.label, () => true);
    renderDynamicCollaborators();
    byId("calRhCollabSearch")?.addEventListener("input", renderDynamicCollaborators);
    document.querySelectorAll('#calRhDisplayMode input[type="radio"]').forEach(input => input.addEventListener("change", renderAll));
    refreshFilterSummary();
  }

  function refreshFilterSummary(){
    const el = byId("calRhFilterSummary");
    if (!el) return;
    const state = activeFilterState();
    const details = [];
    if (state.groups.size < _calendarFilterTypes.length) details.push(`${state.groups.size} catégorie${state.groups.size > 1 ? "s" : ""}`);
    if (state.services.size) details.push(`${state.services.size} service${state.services.size > 1 ? "s" : ""}`);
    if (state.collaborateurs.size) details.push(`${state.collaborateurs.size} collaborateur${state.collaborateurs.size > 1 ? "s" : ""}`);
    if (state.statuts.size < _calendarFilterStatus.length) details.push(`${state.statuts.size} statut${state.statuts.size > 1 ? "s" : ""}`);
    el.textContent = details.length ? `Filtré : ${details.join(" · ")}.` : "Affichage synthétique par défaut.";
  }

  function handleFilterChange(){
    renderDynamicCollaborators();
    refreshFilterSummary();
    renderAll();
  }

  async function loadBootstrap(){
    const ownerId = getOwnerId();
    _bootstrap = await window.portal.apiJson(scopedUrl(`/studio/planification/bootstrap/${encodeURIComponent(ownerId)}`));
    renderFilterPanel();
    if (_bootstrap.sql_ready === false) setMsg("calRhMsg", "Tables calendrier RH absentes. Exécute le script SQL déjà présent dans docs/sql/20260701_insights_calendrier_rh.sql.", "warn");
  }

  async function loadCalendar(){
    const ownerId = getOwnerId();
    const range = monthRange();
    const events = await window.portal.apiJson(scopedUrl(`/studio/calendrier/events/${encodeURIComponent(ownerId)}`, { start: ymd(range.start), end: ymd(range.end) }));
    const suggestions = await window.portal.apiJson(scopedUrl(`/studio/calendrier/suggestions/${encodeURIComponent(ownerId)}`));
    _events = asArray(events);
    _suggestions = asArray(suggestions);
    renderAll();
  }

  function singleDayEventsByDay(day){
    return visibleCalendarEvents()
      .filter(ev => !isEventMultiDay(ev) && dayInEventRange(ev, day))
      .sort((a, b) => String(a.date_debut || "").localeCompare(String(b.date_debut || ""))
        || eventTitle(a).localeCompare(eventTitle(b), "fr"));
  }

  function rangeEventsForWeek(weekDays){
    const weekStart = weekDays[0];
    const weekEnd = weekDays[6];
    const segments = visibleCalendarEvents()
      .filter(isEventMultiDay)
      .map(ev => {
        const range = eventRange(ev);
        if (!range || range.end < weekStart || range.start > weekEnd) return null;
        const visibleStart = range.start < weekStart ? weekStart : range.start;
        const visibleEnd = range.end > weekEnd ? weekEnd : range.end;
        const startCol = weekDays.findIndex(d => sameDay(d, visibleStart)) + 1;
        const endCol = weekDays.findIndex(d => sameDay(d, visibleEnd)) + 1;
        if (startCol < 1 || endCol < 1) return null;
        return {
          ev,
          startCol,
          endCol,
          startsHere: sameDay(visibleStart, range.start),
          endsHere: sameDay(visibleEnd, range.end),
          lane: 0
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.startCol - b.startCol) || (b.endCol - a.endCol) || eventTitle(a.ev).localeCompare(eventTitle(b.ev), "fr"));

    const lanes = [];
    segments.forEach(segment => {
      let lane = lanes.findIndex(lastEndCol => segment.startCol > lastEndCol);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(segment.endCol);
      } else {
        lanes[lane] = segment.endCol;
      }
      segment.lane = lane;
    });
    return { segments, laneCount: lanes.length };
  }

  function rangeBarLabel(ev){
    const collaborator = clean(ev && ev.collaborateur);
    if (collaborator) return collaborator;
    const title = eventTitle(ev);
    return title === typeLabel(ev && ev.type_evenement) ? title : title;
  }

  function renderSingleDayEvent(ev, dayKey){
    const id = clean(ev.id_evenement || ev.id);
    return `
      <button type="button" class="studio-rh-event-chip studio-rh-row--${esc(ev.type_evenement)}" draggable="true" data-event-id="${esc(id)}" data-event-day="${esc(dayKey)}">
        <span class="studio-rh-event-chip-main">
          <span class="studio-rh-event-dot" aria-hidden="true"></span>
          <span class="studio-rh-event-title">${esc(eventTitle(ev))}</span>
        </span>
        <span class="studio-rh-event-meta">${esc(eventChipMeta(ev))}</span>
      </button>`;
  }

  function renderRangeBar(segment){
    const ev = segment.ev;
    const id = clean(ev.id_evenement || ev.id);
    const classes = [
      "studio-rh-range-bar",
      `studio-rh-row--${clean(ev.type_evenement)}`,
      segment.startsHere ? "is-range-start" : "is-range-continue-left",
      segment.endsHere ? "is-range-end" : "is-range-continue-right"
    ].join(" ");
    return `
      <button type="button" class="${esc(classes)}" draggable="true" data-event-id="${esc(id)}" style="grid-column:${segment.startCol} / ${segment.endCol + 1}; --rh-lane:${segment.lane};">
        <span class="studio-rh-range-title">${esc(rangeBarLabel(ev))}</span>
      </button>`;
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
      const range = eventRange(ev);
      return !!(range && range.start < end && range.end >= start);
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

  function suggestionPassesTodoFilter(s){
    if (!_todoFilterType) return true;
    const group = calendarGroupForType(s && (s.type_suggestion || s.type_evenement));
    return group === _todoFilterType;
  }

  function renderTodo(){
    const box = byId("calRhTodoList");
    const sub = byId("calRhTodoSub");
    const rows = _suggestions.filter(suggestionPassesTodoFilter);
    const countBtn = byId("calRhTodoBtnCount");
    if (countBtn) countBtn.textContent = String(_suggestions.length);
    if (sub) sub.textContent = `${_suggestions.length} brique${_suggestions.length > 1 ? "s" : ""} à dater.`;
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `
        <div class="studio-rh-empty studio-rh-calendar-empty">
          <strong>Aucun événement à planifier</strong>
          <span>${_todoFilterType ? "Aucune brique dans cette catégorie." : "Les événements non datés apparaîtront ici."}</span>
        </div>`;
      return;
    }
    box.innerHTML = rows.map(s => `
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

  function calendarDays(){
    const range = monthRange();
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(range.start);
      d.setDate(range.start.getDate() + i);
      days.push(d);
    }
    return days;
  }

  function dayEvents(day){
    return visibleCalendarEvents()
      .filter(ev => dayInEventRange(ev, day))
      .sort((a, b) => Number(isEventMultiDay(b)) - Number(isEventMultiDay(a))
        || String(a.date_debut || "").localeCompare(String(b.date_debut || ""))
        || eventTitle(a).localeCompare(eventTitle(b), "fr"));
  }

  function dayCounts(events){
    const counts = { indisponibilite:0, entretien_annuel:0, evaluation_competence:0 };
    events.forEach(ev => {
      const group = calendarGroupForType(ev && ev.type_evenement);
      if (Object.prototype.hasOwnProperty.call(counts, group)) counts[group] += 1;
    });
    return counts;
  }

  function summaryLineHtml(group, count){
    if (!count) return "";
    const labels = {
      indisponibilite: count > 1 ? "indisponibilités" : "indisponibilité",
      entretien_annuel: count > 1 ? "entretiens" : "entretien",
      evaluation_competence: count > 1 ? "évaluations" : "évaluation"
    };
    return `<span class="studio-rh-day-summary-line studio-rh-day-summary-line--${esc(group)}"><strong>${count}</strong> ${esc(labels[group] || "événement")}</span>`;
  }

  function getDisplayMode(){
    return clean(document.querySelector('#calRhDisplayMode input[name="calRhDisplayMode"]:checked')?.value) || "auto";
  }

  function isReducedScope(){
    const state = activeFilterState();
    return state.services.size > 0 || state.collaborateurs.size > 0 || state.groups.size <= 1;
  }

  function useDetailMode(visibleEvents){
    const mode = getDisplayMode();
    if (mode === "summary") return false;
    if (mode === "detail") return true;
    return isReducedScope() && visibleEvents.length <= 40;
  }

  function renderDaySummary(day, inMonth, todayKey){
    const dayKey = ymd(day);
    const events = dayEvents(day);
    const counts = dayCounts(events);
    const total = events.length;
    return `
      <div class="studio-rh-day studio-rh-day--summary${inMonth ? "" : " is-muted"}${dayKey === todayKey ? " is-today" : ""}" data-day="${dayKey}">
        <div class="studio-rh-day-topline">
          <div class="studio-rh-day-number">${day.getDate()}</div>
          ${total ? `<button type="button" class="studio-rh-day-total" data-day-total="${dayKey}">${total}</button>` : ""}
        </div>
        <div class="studio-rh-day-summary">
          ${summaryLineHtml("indisponibilite", counts.indisponibilite)}
          ${summaryLineHtml("entretien_annuel", counts.entretien_annuel)}
          ${summaryLineHtml("evaluation_competence", counts.evaluation_competence)}
          ${!total ? `<span class="studio-rh-day-empty-dot">—</span>` : ""}
        </div>
      </div>`;
  }

  function renderDayDetail(day, inMonth, todayKey){
    const dayKey = ymd(day);
    const events = dayEvents(day);
    const maxVisible = 4;
    const visible = events.slice(0, maxVisible);
    const more = Math.max(0, events.length - visible.length);
    return `
      <div class="studio-rh-day studio-rh-day--detail${inMonth ? "" : " is-muted"}${dayKey === todayKey ? " is-today" : ""}" data-day="${dayKey}">
        <div class="studio-rh-day-topline">
          <div class="studio-rh-day-number">${day.getDate()}</div>
          ${events.length ? `<button type="button" class="studio-rh-day-total" data-day-total="${dayKey}">${events.length}</button>` : ""}
        </div>
        <div class="studio-rh-day-events">
          ${visible.map(ev => renderSingleDayEvent(ev, dayKey)).join("")}
          ${more ? `<button type="button" class="studio-rh-day-more" data-day-total="${dayKey}">+ ${more} événement${more > 1 ? "s" : ""}</button>` : ""}
        </div>
      </div>`;
  }

  function renderCalendar(){
    const grid = byId("calRhGrid");
    if (!grid) return;
    const title = byId("calRhMonthTitle");
    const sub = byId("calRhMonthSub");
    const hint = byId("calRhModeHint");
    if (title) title.textContent = _month.toLocaleDateString("fr-FR", { month:"long", year:"numeric" });
    const visibleEvents = visibleCalendarEvents();
    const hiddenCount = Math.max(0, _events.length - visibleEvents.length);
    const detail = useDetailMode(visibleEvents);
    if (sub) sub.textContent = `${visibleEvents.length} événement${visibleEvents.length > 1 ? "s" : ""} affiché${visibleEvents.length > 1 ? "s" : ""}${hiddenCount ? ` · ${hiddenCount} masqué${hiddenCount > 1 ? "s" : ""}` : ""} · ${_suggestions.length} à planifier`;
    if (hint) hint.textContent = detail ? "Vue détaillée : les événements sont listés dans chaque journée." : "Vue synthèse : les volumes par journée restent lisibles sur un grand périmètre.";
    root()?.classList.toggle("is-calendar-detail-mode", detail);
    root()?.classList.toggle("is-calendar-summary-mode", !detail);

    const days = calendarDays();
    const todayKey = ymd(new Date());
    const weeks = [];
    for (let i = 0; i < 6; i++) weeks.push(days.slice(i * 7, i * 7 + 7));

    grid.innerHTML = weeks.map((weekDays, weekIndex) => {
      const dayCells = weekDays.map(day => {
        const inMonth = day.getMonth() === _month.getMonth();
        return detail ? renderDayDetail(day, inMonth, todayKey) : renderDaySummary(day, inMonth, todayKey);
      }).join("");
      return `<div class="studio-rh-week-row ${detail ? "is-detail" : "is-summary"}" data-week-index="${weekIndex}"><div class="studio-rh-week-days">${dayCells}</div></div>`;
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

    grid.querySelectorAll("[data-day-total]").forEach(btn => btn.addEventListener("click", () => openDayDetails(btn.dataset.dayTotal)));

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

  function openDayDetails(dayKey){
    const day = parseDay(dayKey);
    if (!day) return;
    const events = dayEvents(day);
    const card = byId("calRhHoverCard");
    if (!card) return;
    card.innerHTML = `
      <div class="studio-rh-popover-head">
        <span class="studio-rh-popover-type">${esc(fullDateLabel(dayKey))}</span>
        <span class="studio-rh-popover-status">${events.length} événement${events.length > 1 ? "s" : ""}</span>
      </div>
      <div class="studio-rh-day-detail-list">
        ${events.length ? events.map(ev => `
          <button type="button" class="studio-rh-day-detail-item studio-rh-row--${esc(ev.type_evenement)}" data-event-id="${esc(clean(ev.id_evenement || ev.id))}">
            <strong>${esc(eventTitle(ev))}</strong>
            <span>${esc(eventChipMeta(ev))}</span>
          </button>`).join("") : `<span class="studio-rh-empty-line">Aucun événement visible.</span>`}
      </div>`;
    card.hidden = false;
    card.style.left = `${Math.max(16, window.innerWidth - 380)}px`;
    card.style.top = `120px`;
    card.querySelectorAll('[data-event-id]').forEach(btn => btn.addEventListener('click', () => openEventModal(btn.dataset.eventId)));
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
      if (ev.source === "effectif_break") {
        const startRaw = clean(ev.date_debut).slice(0, 10);
        const endRaw = clean(ev.date_fin || ev.date_debut).slice(0, 10);
        const start = new Date(`${startRaw}T00:00:00`);
        const end = new Date(`${endRaw}T00:00:00`);
        const durationDays = (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()))
          ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000))
          : 0;
        const newEndDate = new Date(`${day}T00:00:00`);
        newEndDate.setDate(newEndDate.getDate() + durationDays);
        await patchEvent(data.id, { date_debut: day, date_fin: ymd(newEndDate) });
        setMsg("calRhMsg", "Indisponibilité déplacée.", "ok");
        await loadCalendar();
        return;
      }

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
    const isBreak = ev.source === "effectif_break";
    ["calRhEventTitle", "calRhEventType"].forEach(fieldId => {
      const field = byId(fieldId);
      if (field) field.disabled = isBreak;
    });
    const meta = byId("calRhEventMeta");
    if (meta) {
      meta.innerHTML = `
        <div><strong>Collaborateur</strong><span>${esc(ev.collaborateur || "Périmètre RH")}</span></div>
        <div><strong>Service</strong><span>${esc(ev.nom_service || "Service non lié")}</span></div>
        <div><strong>Type</strong><span>${esc(typeLabel(ev.type_evenement))}</span></div>
        ${ev.source === "effectif_break" ? `<div><strong>Source</strong><span>Planning d’indisponibilités</span></div>` : ""}
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
      const sourceEvent = eventById(id);
      const payload = sourceEvent && sourceEvent.source === "effectif_break"
        ? {
            statut,
            date_debut: clean(byId("calRhEventStart")?.value).slice(0, 10),
            date_fin: clean(byId("calRhEventEnd")?.value).slice(0, 10),
            archive: statut === "archive" || statut === "annule"
          }
        : {
            titre: clean(byId("calRhEventTitle")?.value),
            type_evenement: clean(byId("calRhEventType")?.value),
            statut,
            date_debut: clean(byId("calRhEventStart")?.value),
            date_fin: clean(byId("calRhEventEnd")?.value),
            archive: statut === "archive"
          };
      await patchEvent(id, payload);
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
    document.querySelectorAll('#view-calendrier_rh .studio-rh-cal-filter-panel input[type="checkbox"]').forEach(input => {
      if (input.closest('#calRhTypeChecks') || input.closest('#calRhStatusChecks')) input.checked = true;
      else input.checked = false;
    });
    const search = byId("calRhCollabSearch");
    if (search) search.value = "";
    const auto = document.querySelector('#calRhDisplayMode input[value="auto"]');
    if (auto) auto.checked = true;
    renderDynamicCollaborators();
    refreshFilterSummary();
    renderAll();
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

  function setCalendarExpanded(expanded){
    const view = root();
    const btn = byId("calRhExpandBtn");
    const backdrop = byId("calRhExpandBackdrop");
    if (!view || !btn) return;
    view.classList.toggle("is-calendar-expanded", !!expanded);
    btn.setAttribute("aria-pressed", expanded ? "true" : "false");
    btn.setAttribute("aria-label", expanded ? "Réduire le calendrier" : "Agrandir le calendrier");
    btn.setAttribute("title", expanded ? "Réduire le calendrier" : "Agrandir le calendrier");
    if (backdrop) backdrop.hidden = !expanded;
    document.body.classList.toggle("studio-rh-calendar-expanded", !!expanded);
    hideEventHover();
  }

  function toggleCalendarExpanded(){
    const view = root();
    setCalendarExpanded(!(view && view.classList.contains("is-calendar-expanded")));
  }

  function setTodoDrawer(open){
    const drawer = byId("calRhTodoDrawer");
    const backdrop = byId("calRhTodoBackdrop");
    const btn = byId("calRhTodoOpenBtn");
    if (!drawer || !backdrop) return;
    drawer.classList.toggle("is-open", !!open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    backdrop.hidden = !open;
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    hideEventHover();
  }

  function toggleTodoDrawer(){
    const drawer = byId("calRhTodoDrawer");
    setTodoDrawer(!(drawer && drawer.classList.contains("is-open")));
  }

  function bind(){
    if (_bound) return;
    _bound = true;
    byId("calRhBackPlanBtn")?.addEventListener("click", () => {
      setCalendarExpanded(false);
      setTodoDrawer(false);
      window.portal.switchView("planification_rh");
    });
    byId("calRhTodoOpenBtn")?.addEventListener("click", toggleTodoDrawer);
    byId("calRhTodoCloseBtn")?.addEventListener("click", () => setTodoDrawer(false));
    byId("calRhTodoBackdrop")?.addEventListener("click", () => setTodoDrawer(false));
    document.querySelectorAll('#view-calendrier_rh [data-cal-rh-todo-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _todoFilterType = clean(btn.dataset.calRhTodoType);
        document.querySelectorAll('#view-calendrier_rh [data-cal-rh-todo-type]').forEach(x => x.classList.toggle('is-active', x === btn));
        renderTodo();
      });
    });
    byId("calRhRefreshBtn")?.addEventListener("click", loadCalendar);
    byId("calRhResetFiltersBtn")?.addEventListener("click", resetFilters);
    byId("calRhFiltersToggle")?.addEventListener("click", toggleFilters);
    byId("calRhPrevMonth")?.addEventListener("click", async () => { _month = new Date(_month.getFullYear(), _month.getMonth() - 1, 1); await loadCalendar(); });
    byId("calRhNextMonth")?.addEventListener("click", async () => { _month = new Date(_month.getFullYear(), _month.getMonth() + 1, 1); await loadCalendar(); });
    byId("calRhTodayBtn")?.addEventListener("click", async () => { const now = new Date(); _month = new Date(now.getFullYear(), now.getMonth(), 1); await loadCalendar(); });
    byId("calRhExpandBtn")?.addEventListener("click", toggleCalendarExpanded);
    byId("calRhExpandBackdrop")?.addEventListener("click", () => setCalendarExpanded(false));
    byId("calRhModalClose")?.addEventListener("click", closeModal);
    byId("calRhModalCancel")?.addEventListener("click", closeModal);
    byId("calRhForm")?.addEventListener("submit", submitForm);
    byId("calRhCancelEventBtn")?.addEventListener("click", () => cancelOrArchive("annule"));
    byId("calRhArchiveEventBtn")?.addEventListener("click", () => cancelOrArchive("archive"));
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeModal(); setCalendarExpanded(false); setTodoDrawer(false); hideEventHover(); } });
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
