(function () {
  const P = window.PeoplePortal;
  if (!P) return;

  const TYPE_DEFS = [
    { id: "entretien_annuel", label: "Entretien annuel" },
    { id: "entretien_competences", label: "Entretien de compétences" },
    { id: "suivi_post_formation", label: "Entretien post-formation" },
    { id: "formation", label: "Formation" },
    { id: "demande_entretien_manager", label: "Demande d’entretien manager" },
    { id: "demande_entretien_rh", label: "Demande d’entretien RH" },
    { id: "preparation_entretien", label: "Préparation d’entretien" },
    { id: "evenement_personnel", label: "Autre événement professionnel" },
    { id: "indisponibilite", label: "Indisponibilité" }
  ];

  let cache = null;
  let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let editingBreakId = "";
  let editingEventId = "";

  function byId(id) { return document.getElementById(id); }
  function clean(value) { return String(value == null ? "" : value).trim(); }
  function esc(value) { return P.escapeHtml(clean(value)); }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseDay(value) {
    const raw = clean(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const [y, m, d] = raw.split("-").map(Number);
    const out = new Date(y, m - 1, d);
    return Number.isNaN(out.getTime()) ? null : out;
  }
  function dateTimeLocal(value) {
    const raw = clean(value);
    if (!raw) return "";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function selectedTypes() {
    return new Set(Array.from(document.querySelectorAll('#ppCalendarTypeFilters input[type="checkbox"]:checked')).map(x => x.value));
  }
  function typeLabel(type) {
    return TYPE_DEFS.find(x => x.id === type)?.label || type || "Événement";
  }
  function normalizeInterviewType(value) {
    const raw = clean(value).toLowerCase();
    if (raw.includes("compét") || raw.includes("compet")) return "entretien_competences";
    if (raw.includes("post") && raw.includes("formation")) return "suivi_post_formation";
    if (raw.includes("annuel")) return "entretien_annuel";
    return "entretien_annuel";
  }
  function normalizeCalendarType(value) {
    const raw = clean(value).toLowerCase();
    if (raw === "evaluation_competence" || raw.includes("compét") || raw.includes("compet")) return "entretien_competences";
    if (raw === "entretien_annuel" || raw.includes("annuel")) return "entretien_annuel";
    if (raw === "suivi_post_formation" || (raw.includes("post") && raw.includes("formation"))) return "suivi_post_formation";
    if (TYPE_DEFS.some(x => x.id === raw)) return raw;
    return "evenement_personnel";
  }
  function payloadObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) {
      try { return JSON.parse(value); } catch (_) { return {}; }
    }
    return {};
  }

  function buildEvents(data) {
    const rows = [];
    (data.indisponibilites || []).forEach(r => rows.push({
      id: r.id_break,
      source: "break",
      type: "indisponibilite",
      title: "Indisponibilité",
      start: r.date_debut,
      end: r.date_fin,
      editable: true,
      raw: r
    }));
    (data.formations || []).forEach(r => rows.push({
      id: r.id_action_formation_effectif,
      source: "formation",
      type: "formation",
      title: r.titre || "Formation programmée",
      start: r.date_debut_formation,
      end: r.date_fin_formation || r.date_debut_formation,
      editable: false,
      raw: r
    }));
    (data.entretiens || []).forEach(r => rows.push({
      id: r.id_entretien,
      source: "entretien",
      type: normalizeInterviewType(r.type_entretien),
      title: r.type_entretien || "Entretien",
      start: r.date_prevue || r.date_realisee,
      end: r.date_prevue || r.date_realisee,
      editable: false,
      raw: r
    }));
    (data.evenements || []).forEach(r => {
      const type = normalizeCalendarType(r.type_evenement);
      rows.push({
        id: r.id_evenement,
        source: r.source === "people" ? "people" : "calendar",
        type,
        title: r.titre || typeLabel(type),
        start: r.date_debut,
        end: r.date_fin || r.date_debut,
        editable: r.source === "people",
        raw: Object.assign({}, r, { payload_json: payloadObject(r.payload_json) })
      });
    });
    return rows.filter(r => parseDay(r.start));
  }

  function renderFilters() {
    const host = byId("ppCalendarTypeFilters");
    if (!host) return;
    host.innerHTML = TYPE_DEFS.map(x => `
      <label class="pp-calendar-check-item">
        <input type="checkbox" value="${esc(x.id)}" checked>
        <span>${esc(x.label)}</span>
      </label>`).join("");
    host.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", renderCalendar));
  }

  function eventOccursOn(event, day) {
    const start = parseDay(event.start);
    const end = parseDay(event.end) || start;
    return !!start && day >= start && day <= end;
  }

  function renderCalendar() {
    const grid = byId("ppCalendarGrid");
    if (!grid) return;
    const selected = selectedTypes();
    const events = buildEvents(cache || {}).filter(x => selected.has(x.type));
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const today = ymd(new Date());

    byId("ppCalendarMonth").textContent = month.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    byId("ppCalendarSub").textContent = `${events.length} événement${events.length > 1 ? "s" : ""} visible${events.length > 1 ? "s" : ""}`;

    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const dayKey = ymd(day);
      const dayEvents = events.filter(e => eventOccursOn(e, day));
      cells.push(`
        <div class="pp-calendar-day${day.getMonth() !== month.getMonth() ? " is-outside" : ""}${dayKey === today ? " is-today" : ""}">
          <div class="pp-calendar-day-number">${day.getDate()}</div>
          <div class="pp-calendar-day-events">
            ${dayEvents.map(e => `<button type="button" class="pp-calendar-event pp-calendar-event--${esc(e.type)}" data-event-source="${esc(e.source)}" data-event-id="${esc(e.id)}" title="${esc(e.title)}">${esc(e.title)}</button>`).join("")}
          </div>
        </div>`);
    }
    grid.innerHTML = cells.join("");
    grid.querySelectorAll("[data-event-id]").forEach(btn => btn.addEventListener("click", () => openItem(btn.dataset.eventSource, btn.dataset.eventId)));
  }

  function openItem(source, id) {
    const item = buildEvents(cache || {}).find(x => x.source === source && x.id === id);
    if (!item || !item.editable) return;
    if (source === "break") openBreakModal(item.raw);
    if (source === "people") openEventModal(item.raw);
  }

  function openBreakModal(row) {
    editingBreakId = clean(row && row.id_break);
    byId("ppBreakModalTitle").textContent = editingBreakId ? "Modifier l’indisponibilité" : "Ajouter une indisponibilité";
    byId("ppBreakStart").value = clean(row && row.date_debut) || ymd(new Date());
    byId("ppBreakEnd").value = clean(row && row.date_fin) || ymd(new Date());
    byId("ppBreakDelete").style.display = editingBreakId ? "inline-flex" : "none";
    byId("ppBreakMsg").textContent = "";
    byId("ppBreakModal").style.display = "flex";
  }
  function closeBreakModal() {
    byId("ppBreakModal").style.display = "none";
    editingBreakId = "";
  }
  async function saveBreak() {
    const id = P.getEffectifId();
    const payload = { date_debut: byId("ppBreakStart").value, date_fin: byId("ppBreakEnd").value };
    byId("ppBreakMsg").textContent = "Enregistrement…";
    const path = editingBreakId
      ? `/people/calendrier/${encodeURIComponent(id)}/breaks/${encodeURIComponent(editingBreakId)}`
      : `/people/calendrier/${encodeURIComponent(id)}/breaks`;
    const res = await P.api(path, {
      method: editingBreakId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(err => ({ error: err.message }));
    if (res.error) { byId("ppBreakMsg").textContent = res.error; return; }
    closeBreakModal();
    await load();
  }
  async function deleteBreak() {
    if (!editingBreakId) return;
    const id = P.getEffectifId();
    const res = await P.api(`/people/calendrier/${encodeURIComponent(id)}/breaks/${encodeURIComponent(editingBreakId)}/archive`, { method: "POST" }).catch(err => ({ error: err.message }));
    if (res.error) { byId("ppBreakMsg").textContent = res.error; return; }
    closeBreakModal();
    await load();
  }

  function defaultEventTitle(type) {
    return TYPE_DEFS.find(x => x.id === type)?.label || "Événement professionnel";
  }
  function openEventModal(row) {
    editingEventId = clean(row && row.id_evenement);
    const type = normalizeCalendarType(row && row.type_evenement) || "demande_entretien_manager";
    const payload = payloadObject(row && row.payload_json);
    const start = row && row.date_debut ? dateTimeLocal(row.date_debut) : dateTimeLocal(new Date().toISOString());
    const endDate = row && row.date_fin ? row.date_fin : new Date(Date.now() + 3600000).toISOString();
    byId("ppEventModalTitle").textContent = editingEventId ? "Modifier l’événement" : "Ajouter un événement";
    byId("ppEventType").value = type;
    byId("ppEventTitle").value = clean(row && row.titre) || defaultEventTitle(type);
    byId("ppEventStart").value = start;
    byId("ppEventEnd").value = dateTimeLocal(endDate);
    byId("ppEventDescription").value = clean(payload.description);
    byId("ppEventDelete").style.display = editingEventId ? "inline-flex" : "none";
    byId("ppEventMsg").textContent = "";
    byId("ppEventModal").style.display = "flex";
  }
  function closeEventModal() {
    byId("ppEventModal").style.display = "none";
    editingEventId = "";
  }
  async function saveEvent() {
    const id = P.getEffectifId();
    const payload = {
      type_evenement: byId("ppEventType").value,
      titre: byId("ppEventTitle").value,
      date_debut: byId("ppEventStart").value,
      date_fin: byId("ppEventEnd").value,
      description: byId("ppEventDescription").value
    };
    byId("ppEventMsg").textContent = "Enregistrement…";
    const path = editingEventId
      ? `/people/calendrier/${encodeURIComponent(id)}/events/${encodeURIComponent(editingEventId)}`
      : `/people/calendrier/${encodeURIComponent(id)}/events`;
    const res = await P.api(path, {
      method: editingEventId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(err => ({ error: err.message }));
    if (res.error) { byId("ppEventMsg").textContent = res.error; return; }
    closeEventModal();
    await load();
  }
  async function deleteEvent() {
    if (!editingEventId) return;
    const id = P.getEffectifId();
    const res = await P.api(`/people/calendrier/${encodeURIComponent(id)}/events/${encodeURIComponent(editingEventId)}/archive`, { method: "POST" }).catch(err => ({ error: err.message }));
    if (res.error) { byId("ppEventMsg").textContent = res.error; return; }
    closeEventModal();
    await load();
  }

  function setExpanded(expanded) {
    const card = byId("ppCalendarCard");
    const backdrop = byId("ppCalendarBackdrop");
    const btn = byId("ppCalendarExpand");
    card.classList.toggle("is-expanded", expanded);
    backdrop.hidden = !expanded;
    btn.setAttribute("aria-pressed", expanded ? "true" : "false");
    btn.setAttribute("aria-label", expanded ? "Réduire le calendrier" : "Agrandir le calendrier");
    btn.title = expanded ? "Réduire le calendrier" : "Agrandir le calendrier";
    document.body.classList.toggle("pp-calendar-open", expanded);
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    byId("ppCalendarMsg").textContent = "Chargement…";
    cache = await P.api(`/people/calendrier/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (cache.error) {
      byId("ppCalendarMsg").textContent = cache.error;
      return;
    }
    byId("ppCalendarMsg").textContent = "";
    renderCalendar();
  }

  renderFilters();
  byId("ppCalendarResetFilters")?.addEventListener("click", () => {
    document.querySelectorAll('#ppCalendarTypeFilters input[type="checkbox"]').forEach(x => { x.checked = true; });
    renderCalendar();
  });
  document.querySelectorAll("[data-pp-filter-toggle]").forEach(btn => btn.addEventListener("click", () => {
    const section = btn.closest(".pp-calendar-filter-card");
    const open = !section.classList.contains("is-open");
    section.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }));
  byId("ppCalendarPrev")?.addEventListener("click", () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderCalendar(); });
  byId("ppCalendarNext")?.addEventListener("click", () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderCalendar(); });
  byId("ppCalendarToday")?.addEventListener("click", () => { const now = new Date(); month = new Date(now.getFullYear(), now.getMonth(), 1); renderCalendar(); });
  byId("ppCalendarExpand")?.addEventListener("click", () => setExpanded(!byId("ppCalendarCard").classList.contains("is-expanded")));
  byId("ppCalendarBackdrop")?.addEventListener("click", () => setExpanded(false));

  byId("ppBtnOpenBreak")?.addEventListener("click", () => openBreakModal(null));
  byId("ppBreakClose")?.addEventListener("click", closeBreakModal);
  byId("ppBreakCancel")?.addEventListener("click", closeBreakModal);
  byId("ppBreakSave")?.addEventListener("click", saveBreak);
  byId("ppBreakDelete")?.addEventListener("click", deleteBreak);

  byId("ppBtnOpenEvent")?.addEventListener("click", () => openEventModal(null));
  byId("ppEventClose")?.addEventListener("click", closeEventModal);
  byId("ppEventCancel")?.addEventListener("click", closeEventModal);
  byId("ppEventSave")?.addEventListener("click", saveEvent);
  byId("ppEventDelete")?.addEventListener("click", deleteEvent);
  byId("ppEventType")?.addEventListener("change", () => {
    if (!editingEventId) byId("ppEventTitle").value = defaultEventTitle(byId("ppEventType").value);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      setExpanded(false);
      closeBreakModal();
      closeEventModal();
    }
  });

  load();
})();
