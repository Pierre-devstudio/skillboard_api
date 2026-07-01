/* ======================================================
   static/menus/skills_calendrier.js
   Calendrier RH Insights : événements planifiés + briques intelligentes
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "calendrier";
  const STORE_SERVICE = "sb_cal_service";
  const STORE_TYPE = "sb_cal_type";
  const STORE_STATUT = "sb_cal_statut";
  const STORE_FILTERS_OPEN = "sb_cal_filters_open";

  let _bound = false;
  let _portal = null;

  const state = {
    current: new Date(),
    bootstrap: null,
    events: [],
    suggestions: [],
    selectedKind: "",
    selectedId: "",
    modalMode: "create",
    modalSuggestion: null,
    modalEvent: null,
    modalDropDate: "",
    loading: false
  };

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function toYmd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function toDatetimeLocal(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    return `${toYmd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function parseDateLike(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const d = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw);
    return isNaN(d.getTime()) ? null : d;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  function mondayIndex(jsDay) { return (jsDay + 6) % 7; }

  function buildMonthGridRange(d) {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const gridStart = addDays(first, -mondayIndex(first.getDay()));
    const gridEnd = addDays(last, 6 - mondayIndex(last.getDay()));
    return { gridStart, gridEnd };
  }

  function monthLabelFR(d) {
    try {
      const s = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) {
      return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
  }

  function formatDateFr(value) {
    const d = parseDateLike(value);
    if (!d) return "—";
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function formatDateTimeFr(value) {
    const d = parseDateLike(value);
    if (!d) return "—";
    return `${formatDateFr(value)} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === null || v === undefined) return;
      const s = String(v).trim();
      if (!s) return;
      usp.set(k, s);
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }

  function serviceRaw() {
    return (byId("calServiceSelect")?.value || "").trim();
  }

  function serviceQuery() {
    return window.portal?.serviceFilter?.toQueryId(serviceRaw()) || "";
  }

  function typeFilter() { return (byId("calTypeSelect")?.value || "").trim(); }
  function statutFilter() { return (byId("calStatutSelect")?.value || "").trim(); }

  function showMsg(text, type) {
    const el = byId("calActionMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "sb-inline-msg cal-action-msg";
    if (type) el.classList.add(`sb-inline-msg--${type === "error" ? "danger" : type}`);
    if (text) el.classList.add("is-visible");
    if (text && type === "success") {
      window.setTimeout(() => {
        if (el.textContent === text) {
          el.textContent = "";
          el.className = "sb-inline-msg cal-action-msg";
        }
      }, 4500);
    }
  }

  function setModalMsg(text, type) {
    const el = byId("calEventModalMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "sb-inline-msg";
    if (type) el.classList.add(`sb-inline-msg--${type === "error" ? "danger" : type}`);
    if (text) el.classList.add("is-visible");
  }

  function normalizePriority(p) {
    const v = String(p || "").toLowerCase();
    if (v.includes("urgent")) return { label: "Urgente", cls: "is-urgent" };
    if (v.includes("haut") || v.includes("élev") || v.includes("elev")) return { label: "Haute", cls: "is-high" };
    if (v.includes("basse")) return { label: "Basse", cls: "is-low" };
    return { label: "Normale", cls: "is-normal" };
  }

  function eventTypeIcon(type) {
    const t = String(type || "").trim();
    if (t === "signature") return "✓";
    if (t === "evaluation_competence") return "%";
    if (t === "preparation_entretien") return "…";
    if (t === "entretien_annuel") return "1:1";
    if (t === "campagne_rh") return "RH";
    return "•";
  }

  function typeLabel(x) {
    return x?.type_label || x?.type || x?.type_evenement || x?.type_suggestion || "Événement RH";
  }

  function eventById(id) {
    return (state.events || []).find(e => String(e.id_evenement || "") === String(id || "")) || null;
  }

  function suggestionById(id) {
    return (state.suggestions || []).find(s => String(s.id_suggestion || "") === String(id || "")) || null;
  }

  function getSelectedServiceLabel() {
    const sel = byId("calServiceSelect");
    const opt = sel ? sel.options[sel.selectedIndex] : null;
    return opt ? (opt.textContent || "").trim() : "Tous les services";
  }

  async function loadBootstrap() {
    const qs = buildQuery({ id_service: serviceQuery() || null });
    state.bootstrap = await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/bootstrap/${encodeURIComponent(_portal.contactId)}${qs}`);

    const select = byId("calServiceSelect");
    if (select) {
      const services = Array.isArray(state.bootstrap?.services) ? state.bootstrap.services : [];
      if (services.length) {
        select.innerHTML = services.map(s => `<option value="${escapeHtml(s.id_service || "__ALL__")}">${escapeHtml(s.nom_service || "Service")}</option>`).join("");
      } else if (window.portal?.serviceFilter?.populateSelect) {
        await window.portal.serviceFilter.populateSelect({
          portal: _portal,
          selectId: "calServiceSelect",
          storageKey: STORE_SERVICE,
          labelAll: "Tous les services",
          labelNonLie: "Non lié",
          includeAll: true,
          includeNonLie: true,
          allowIndent: true
        });
      }
      const stored = localStorage.getItem(STORE_SERVICE) || "";
      if (stored && Array.from(select.options || []).some(o => o.value === stored)) select.value = stored;
      if (state.bootstrap?.access?.locked_service) select.disabled = true;
    }

    const scope = state.bootstrap?.access?.scope_label || getSelectedServiceLabel() || "Tous les services";
    const scopeEl = byId("calScopeLabel");
    if (scopeEl) scopeEl.textContent = `Périmètre : ${scope}`;

    if (state.bootstrap && state.bootstrap.sql_ready === false) {
      showMsg("Calendrier lisible, mais tables RH absentes : exécute le script SQL fourni pour activer création, planification et ignore.", "info");
    }
  }

  async function loadEvents() {
    const { gridStart, gridEnd } = buildMonthGridRange(state.current);
    const qs = buildQuery({
      start: toYmd(gridStart),
      end: toYmd(gridEnd),
      id_service: serviceQuery() || null,
      type: typeFilter() || null,
      statut: statutFilter() || null
    });
    state.events = await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/events/${encodeURIComponent(_portal.contactId)}${qs}`);
    if (!Array.isArray(state.events)) state.events = [];
  }

  async function loadSuggestions() {
    const qs = buildQuery({
      id_service: serviceQuery() || null,
      type: typeFilter() || null
    });
    state.suggestions = await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/suggestions/${encodeURIComponent(_portal.contactId)}${qs}`);
    if (!Array.isArray(state.suggestions)) state.suggestions = [];
  }

  async function reloadAll() {
    if (!_portal || !_portal.contactId || state.loading) return;
    state.loading = true;
    showMsg("Chargement du calendrier…", "info");
    try {
      await loadBootstrap();
      await Promise.all([loadEvents(), loadSuggestions()]);
      renderAll();
      showMsg("", "");
    } catch (e) {
      showMsg(e?.message || "Erreur de chargement du calendrier.", "error");
      renderAll();
    } finally {
      state.loading = false;
    }
  }

  function isThisWeek(value) {
    const d = parseDateLike(value);
    if (!d) return false;
    const today = new Date();
    const start = addDays(today, -mondayIndex(today.getDay()));
    const end = addDays(start, 6);
    const ymd = toYmd(d);
    return ymd >= toYmd(start) && ymd <= toYmd(end);
  }

  function renderKpis() {
    const suggestions = state.suggestions || [];
    const events = state.events || [];
    const week = events.filter(e => isThisWeek(e.date_debut)).length;
    const late = events.filter(e => e.is_overdue).length;
    const signatures = suggestions.filter(s => String(s.type_suggestion || "") === "signature").length;

    const set = (id, value) => { const el = byId(id); if (el) el.textContent = String(value); };
    set("calKpiSuggestions", suggestions.length);
    set("calKpiWeek", week);
    set("calKpiLate", late);
    set("calKpiSignatures", signatures);
  }

  function renderSuggestions() {
    const host = byId("calSuggestionsList");
    const sub = byId("calSuggestionsSub");
    if (!host) return;
    const list = state.suggestions || [];
    if (sub) sub.textContent = `${list.length} action(s) RH détectée(s) mais non planifiée(s).`;

    if (!list.length) {
      host.innerHTML = `<div class="cal-empty-state">Aucune brique proposée pour ces filtres.</div>`;
      return;
    }

    host.innerHTML = list.map(s => {
      const pr = normalizePriority(s.priorite);
      const active = state.selectedKind === "suggestion" && state.selectedId === String(s.id_suggestion || "");
      const comp = s.payload_json?.intitule_competence ? `<div class="cal-suggestion-extra">${escapeHtml(s.payload_json.intitule_competence)}</div>` : "";
      return `
        <div class="cal-suggestion-card ${active ? "is-active" : ""}"
             draggable="true"
             data-suggestion-id="${escapeHtml(s.id_suggestion || "")}">
          <div class="cal-suggestion-top">
            <span class="cal-type-pill">${escapeHtml(typeLabel(s))}</span>
            <span class="cal-priority ${pr.cls}">${escapeHtml(pr.label)}</span>
          </div>
          <div class="cal-suggestion-title">${escapeHtml(s.titre || "Action à planifier")}</div>
          ${comp}
          <div class="cal-suggestion-meta">
            <span>${escapeHtml(s.collaborateur || "Périmètre")}</span>
            <span>Échéance : ${escapeHtml(formatDateFr(s.date_echeance))}</span>
            <span>Source : ${escapeHtml(s.source || "moteur")}</span>
          </div>
          <div class="cal-suggestion-actions">
            <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-cal-plan="${escapeHtml(s.id_suggestion || "")}">Planifier</button>
            <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-cal-detail-suggestion="${escapeHtml(s.id_suggestion || "")}">Voir détail</button>
            <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-cal-ignore="${escapeHtml(s.id_suggestion || "")}">Ignorer</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function eventsByDay() {
    const out = {};
    (state.events || []).forEach(e => {
      const d = parseDateLike(e.date_debut);
      if (!d) return;
      const key = toYmd(d);
      if (!out[key]) out[key] = [];
      out[key].push(e);
    });
    return out;
  }

  function renderCalendar() {
    const label = byId("calMonthLabel");
    if (label) label.textContent = monthLabelFR(state.current);

    const host = byId("calCalendar");
    if (!host) return;

    const weekdays = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map(d => `<div>${d}</div>`).join("");
    const { gridStart } = buildMonthGridRange(state.current);
    const currentMonth = state.current.getMonth();
    const todayYmd = toYmd(new Date());
    const byDay = eventsByDay();
    let cells = "";
    let d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate());

    for (let i = 0; i < 42; i++) {
      const ymd = toYmd(d);
      const isOut = d.getMonth() !== currentMonth;
      const isToday = ymd === todayYmd;
      const list = byDay[ymd] || [];
      const chips = list.slice(0, 4).map(e => `
        <button type="button"
                class="cal-event-chip ${e.is_overdue ? "is-overdue" : ""}"
                data-event-id="${escapeHtml(e.id_evenement || "")}" title="${escapeHtml(e.titre || "Événement")}">
          <span>${escapeHtml(eventTypeIcon(e.type_evenement))}</span>
          <strong>${escapeHtml(e.titre || "Événement")}</strong>
        </button>
      `).join("");
      const more = list.length > 4 ? `<div class="cal-more">+${list.length - 4}</div>` : "";
      cells += `
        <div class="cal-day ${isOut ? "is-out" : ""} ${isToday ? "is-today" : ""}" data-cal-day="${escapeHtml(ymd)}">
          <div class="cal-daynum">${d.getDate()}</div>
          <div class="cal-day-events">${chips}${more}</div>
        </div>
      `;
      d = addDays(d, 1);
    }

    host.innerHTML = `
      <div class="cal-weekdays">${weekdays}</div>
      <div class="cal-grid">${cells}</div>
    `;
  }

  function renderDetailEmpty() {
    const host = byId("calDetailContent");
    const sub = byId("calDetailSub");
    if (sub) sub.textContent = "Sélectionnez un événement ou une brique.";
    if (host) host.innerHTML = `<div class="cal-empty-state">Aucun élément sélectionné.</div>`;
  }

  function renderEventDetail(event) {
    const host = byId("calDetailContent");
    const sub = byId("calDetailSub");
    if (!host || !event) return;
    if (sub) sub.textContent = "Événement planifié.";
    host.innerHTML = `
      <div class="cal-detail-title">${escapeHtml(event.titre || "Événement RH")}</div>
      <div class="cal-detail-badges">
        <span class="cal-type-pill">${escapeHtml(typeLabel(event))}</span>
        <span class="cal-status-pill">${escapeHtml(event.statut || "planifie")}</span>
      </div>
      <div class="cal-detail-list">
        <div><span>Date</span><strong>${escapeHtml(formatDateTimeFr(event.date_debut))}</strong></div>
        <div><span>Fin</span><strong>${escapeHtml(formatDateTimeFr(event.date_fin))}</strong></div>
        <div><span>Collaborateur</span><strong>${escapeHtml(event.collaborateur || "—")}</strong></div>
        <div><span>Service</span><strong>${escapeHtml(event.nom_service || "—")}</strong></div>
        <div><span>Source</span><strong>${escapeHtml(event.source || "—")}</strong></div>
      </div>
      <div class="cal-detail-actions">
        <button type="button" class="sb-btn sb-btn--soft" data-cal-open-event="${escapeHtml(event.id_evenement || "")}">Ouvrir</button>
        <button type="button" class="sb-btn sb-btn--soft" data-cal-edit-event="${escapeHtml(event.id_evenement || "")}">Modifier</button>
        <button type="button" class="sb-btn sb-btn--accent" data-cal-done-event="${escapeHtml(event.id_evenement || "")}">Marquer réalisé</button>
        <button type="button" class="sb-btn sb-btn--soft" data-cal-report-event="${escapeHtml(event.id_evenement || "")}">Reporter</button>
        <button type="button" class="sb-btn sb-btn--soft" data-cal-cancel-event="${escapeHtml(event.id_evenement || "")}">Annuler</button>
      </div>
    `;
  }

  function renderSuggestionDetail(s) {
    const host = byId("calDetailContent");
    const sub = byId("calDetailSub");
    if (!host || !s) return;
    const pr = normalizePriority(s.priorite);
    if (sub) sub.textContent = "Brique proposée par Novoskill.";
    host.innerHTML = `
      <div class="cal-detail-title">${escapeHtml(s.titre || "Action RH à planifier")}</div>
      <div class="cal-detail-badges">
        <span class="cal-type-pill">${escapeHtml(typeLabel(s))}</span>
        <span class="cal-priority ${pr.cls}">${escapeHtml(pr.label)}</span>
      </div>
      <div class="cal-detail-list">
        <div><span>Échéance</span><strong>${escapeHtml(formatDateFr(s.date_echeance))}</strong></div>
        <div><span>Collaborateur</span><strong>${escapeHtml(s.collaborateur || "—")}</strong></div>
        <div><span>Service</span><strong>${escapeHtml(s.nom_service || "—")}</strong></div>
        <div><span>Source</span><strong>${escapeHtml(s.source || "moteur")}</strong></div>
      </div>
      ${renderSuggestionPayload(s)}
      <div class="cal-detail-actions">
        <button type="button" class="sb-btn sb-btn--accent" data-cal-plan="${escapeHtml(s.id_suggestion || "")}">Planifier</button>
        <button type="button" class="sb-btn sb-btn--soft" data-cal-ignore="${escapeHtml(s.id_suggestion || "")}">Ignorer</button>
      </div>
    `;
  }

  function renderSuggestionPayload(s) {
    const p = s?.payload_json || {};
    const rows = [];
    if (p.intitule_competence) rows.push(["Compétence", p.intitule_competence]);
    if (p.intitule_poste) rows.push(["Poste", p.intitule_poste]);
    if (p.criticite !== undefined && p.criticite !== null) rows.push(["Criticité", `${p.criticite}%`]);
    if (p.last_entretien_date) rows.push(["Dernier entretien", formatDateFr(p.last_entretien_date)]);
    if (!rows.length) return "";
    return `<div class="cal-detail-list cal-detail-list--payload">${rows.map(r => `<div><span>${escapeHtml(r[0])}</span><strong>${escapeHtml(r[1])}</strong></div>`).join("")}</div>`;
  }

  function renderSelectedDetail() {
    if (state.selectedKind === "event") return renderEventDetail(eventById(state.selectedId));
    if (state.selectedKind === "suggestion") return renderSuggestionDetail(suggestionById(state.selectedId));
    renderDetailEmpty();
  }

  function renderAll() {
    renderKpis();
    renderSuggestions();
    renderCalendar();
    renderSelectedDetail();
  }

  function setSelected(kind, id) {
    state.selectedKind = kind || "";
    state.selectedId = String(id || "");
    renderAll();
  }

  function defaultStartForDate(ymd) {
    const d = parseDateLike(ymd || "");
    if (!d) {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      now.setHours(Math.max(9, now.getHours() + 1));
      return now;
    }
    d.setHours(9, 0, 0, 0);
    return d;
  }

  function openEventModalCreate(ymd) {
    state.modalMode = "create";
    state.modalSuggestion = null;
    state.modalEvent = null;
    state.modalDropDate = ymd || "";
    const start = defaultStartForDate(ymd);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    byId("calEventModalTitle").textContent = "Nouvel événement";
    byId("calModalIntro").textContent = "Créez un événement RH planifié dans le calendrier.";
    byId("calEventTitle").value = "";
    byId("calEventType").value = "evenement_rh";
    byId("calEventStatus").value = "planifie";
    byId("calEventStart").value = toDatetimeLocal(start);
    byId("calEventEnd").value = toDatetimeLocal(end);
    setModalMsg("", "");
    showModal();
  }

  function openEventModalFromSuggestion(suggestion, ymd) {
    if (!suggestion) return;
    state.modalMode = "suggestion";
    state.modalSuggestion = suggestion;
    state.modalEvent = null;
    state.modalDropDate = ymd || "";
    const start = defaultStartForDate(ymd || suggestion.date_echeance);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    byId("calEventModalTitle").textContent = "Planifier une brique";
    byId("calModalIntro").textContent = suggestion.titre || "Planifiez cette action dans le calendrier.";
    byId("calEventTitle").value = suggestion.titre || "";
    byId("calEventType").value = suggestion.type_suggestion || "evenement_rh";
    byId("calEventStatus").value = "planifie";
    byId("calEventStart").value = toDatetimeLocal(start);
    byId("calEventEnd").value = toDatetimeLocal(end);
    setModalMsg("", "");
    showModal();
  }

  function openEventModalEdit(event, forceReport) {
    if (!event) return;
    state.modalMode = "edit";
    state.modalSuggestion = null;
    state.modalEvent = event;
    byId("calEventModalTitle").textContent = forceReport ? "Reporter l’événement" : "Modifier l’événement";
    byId("calModalIntro").textContent = forceReport ? "Choisissez une nouvelle date pour cet événement." : "Modifiez les informations de l’événement.";
    byId("calEventTitle").value = event.titre || "";
    byId("calEventType").value = event.type_evenement || "evenement_rh";
    byId("calEventStatus").value = forceReport ? "reporté" : (event.statut || "planifie");
    byId("calEventStart").value = toDatetimeLocal(parseDateLike(event.date_debut));
    byId("calEventEnd").value = toDatetimeLocal(parseDateLike(event.date_fin));
    setModalMsg("", "");
    showModal();
  }

  function showModal() {
    const modal = byId("modalCalEvent");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const modal = byId("modalCalEvent");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  async function saveEventModal() {
    const title = (byId("calEventTitle")?.value || "").trim();
    const typ = (byId("calEventType")?.value || "evenement_rh").trim();
    const statut = (byId("calEventStatus")?.value || "planifie").trim();
    const start = (byId("calEventStart")?.value || "").trim();
    const end = (byId("calEventEnd")?.value || "").trim();

    if (!start) {
      setModalMsg("Date de début obligatoire.", "error");
      return;
    }

    setModalMsg("Enregistrement…", "info");

    try {
      if (state.modalMode === "suggestion" && state.modalSuggestion) {
        await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/events/from-suggestion/${encodeURIComponent(_portal.contactId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id_suggestion: state.modalSuggestion.id_suggestion,
            titre: title,
            date_debut: start,
            date_fin: end || null,
            statut
          })
        });
      } else if (state.modalMode === "edit" && state.modalEvent) {
        await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/events/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.modalEvent.id_evenement)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            titre: title,
            type_evenement: typ,
            date_debut: start,
            date_fin: end || null,
            statut
          })
        });
      } else {
        await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/events/${encodeURIComponent(_portal.contactId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            titre: title,
            type_evenement: typ,
            date_debut: start,
            date_fin: end || null,
            statut,
            source: "manuel"
          })
        });
      }

      closeModal();
      showMsg("Calendrier mis à jour.", "success");
      await reloadAll();
    } catch (e) {
      setModalMsg(e?.message || "Erreur d’enregistrement.", "error");
    }
  }

  async function ignoreSuggestion(id) {
    const s = suggestionById(id);
    if (!s) return;
    try {
      await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/suggestions/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}/ignore`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      showMsg("Brique ignorée.", "success");
      state.selectedKind = "";
      state.selectedId = "";
      await reloadAll();
    } catch (e) {
      showMsg(e?.message || "Impossible d’ignorer cette brique.", "error");
    }
  }

  async function patchEventStatus(id, statut) {
    try {
      await _portal.apiJson(`${_portal.apiBase}/skills/calendrier/events/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statut })
      });
      showMsg("Événement mis à jour.", "success");
      await reloadAll();
      setSelected("event", id);
    } catch (e) {
      showMsg(e?.message || "Impossible de modifier l’événement.", "error");
    }
  }

  function openLinkedEvent(event) {
    if (!event) return;
    if (event.id_effectif && String(event.type_evenement || "").includes("entretien")) {
      try {
        window.sessionStorage.setItem("skills_ep_preselect_id_effectif", event.id_effectif || "");
        window.sessionStorage.setItem("skills_ep_preselect_id_service", event.id_service || "");
        window.sessionStorage.setItem("skills_ep_preselect_nom", event.collaborateur || "");
      } catch (_) {}
      window.portal.switchView("entretien-performance");
      window.dispatchEvent(new CustomEvent("skills:entretien-preselect", { detail: { id_effectif: event.id_effectif, id_service: event.id_service || "" } }));
      return;
    }
    showMsg("Aucun écran métier direct n’est encore relié à cet événement.", "info");
  }

  function toggleFilters(open) {
    const card = document.querySelector("#view-calendrier .cal-filter-card");
    const btn = byId("btnCalFiltersToggle");
    const isOpen = !!open;
    if (card) card.classList.toggle("is-collapsed", !isOpen);
    if (btn) {
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      btn.setAttribute("title", isOpen ? "Replier les filtres" : "Déplier les filtres");
      btn.setAttribute("aria-label", isOpen ? "Replier les filtres" : "Déplier les filtres");
    }
    try { localStorage.setItem(STORE_FILTERS_OPEN, isOpen ? "1" : "0"); } catch (_) {}
  }

  function saveFilters() {
    try {
      localStorage.setItem(STORE_SERVICE, serviceRaw());
      localStorage.setItem(STORE_TYPE, typeFilter());
      localStorage.setItem(STORE_STATUT, statutFilter());
    } catch (_) {}
  }

  function restoreFilters() {
    const type = localStorage.getItem(STORE_TYPE) || "";
    const statut = localStorage.getItem(STORE_STATUT) || "";
    if (byId("calTypeSelect")) byId("calTypeSelect").value = type;
    if (byId("calStatutSelect")) byId("calStatutSelect").value = statut;
    toggleFilters((localStorage.getItem(STORE_FILTERS_OPEN) || "0") === "1");
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    byId("btnCalFiltersToggle")?.addEventListener("click", () => {
      const card = document.querySelector("#view-calendrier .cal-filter-card");
      toggleFilters(card?.classList.contains("is-collapsed"));
    });

    byId("btnCalApplyFilters")?.addEventListener("click", async () => {
      saveFilters();
      await reloadAll();
    });

    byId("btnCalResetFilters")?.addEventListener("click", async () => {
      const allId = window.portal?.serviceFilter?.ALL_ID || "__ALL__";
      if (byId("calServiceSelect") && !byId("calServiceSelect").disabled) byId("calServiceSelect").value = allId;
      if (byId("calTypeSelect")) byId("calTypeSelect").value = "";
      if (byId("calStatutSelect")) byId("calStatutSelect").value = "";
      saveFilters();
      await reloadAll();
    });

    byId("btnCalRefresh")?.addEventListener("click", reloadAll);
    byId("btnCalNewEvent")?.addEventListener("click", () => openEventModalCreate());
    byId("btnCalPrev")?.addEventListener("click", async () => { state.current = addMonths(state.current, -1); await reloadAll(); });
    byId("btnCalToday")?.addEventListener("click", async () => { state.current = new Date(); await reloadAll(); });
    byId("btnCalNext")?.addEventListener("click", async () => { state.current = addMonths(state.current, 1); await reloadAll(); });

    byId("btnCloseCalEvent")?.addEventListener("click", closeModal);
    byId("btnCalEventCancel")?.addEventListener("click", closeModal);
    byId("btnCalEventSave")?.addEventListener("click", saveEventModal);
    byId("modalCalEvent")?.addEventListener("click", e => { if (e.target === byId("modalCalEvent")) closeModal(); });

    document.addEventListener("click", async (e) => {
      const target = e.target.closest("[data-event-id], [data-cal-day], [data-cal-plan], [data-cal-detail-suggestion], [data-cal-ignore], [data-cal-open-event], [data-cal-edit-event], [data-cal-done-event], [data-cal-report-event], [data-cal-cancel-event]");
      if (!target || !document.getElementById("view-calendrier")?.contains(target)) return;

      const eventId = target.getAttribute("data-event-id");
      if (eventId) {
        setSelected("event", eventId);
        return;
      }

      const detailSuggestion = target.getAttribute("data-cal-detail-suggestion");
      if (detailSuggestion) {
        setSelected("suggestion", detailSuggestion);
        return;
      }

      const planId = target.getAttribute("data-cal-plan");
      if (planId) {
        openEventModalFromSuggestion(suggestionById(planId));
        return;
      }

      const ignoreId = target.getAttribute("data-cal-ignore");
      if (ignoreId) {
        await ignoreSuggestion(ignoreId);
        return;
      }

      const openId = target.getAttribute("data-cal-open-event");
      if (openId) {
        openLinkedEvent(eventById(openId));
        return;
      }

      const editId = target.getAttribute("data-cal-edit-event");
      if (editId) {
        openEventModalEdit(eventById(editId), false);
        return;
      }

      const doneId = target.getAttribute("data-cal-done-event");
      if (doneId) {
        await patchEventStatus(doneId, "réalisé");
        return;
      }

      const reportId = target.getAttribute("data-cal-report-event");
      if (reportId) {
        openEventModalEdit(eventById(reportId), true);
        return;
      }

      const cancelId = target.getAttribute("data-cal-cancel-event");
      if (cancelId) {
        await patchEventStatus(cancelId, "annulé");
        return;
      }

      const day = target.getAttribute("data-cal-day");
      if (day && target.classList.contains("cal-day")) {
        openEventModalCreate(day);
      }
    });

    document.addEventListener("dragstart", e => {
      const card = e.target.closest(".cal-suggestion-card[data-suggestion-id]");
      if (!card) return;
      e.dataTransfer.setData("text/plain", card.getAttribute("data-suggestion-id") || "");
      e.dataTransfer.effectAllowed = "copy";
    });

    document.addEventListener("dragover", e => {
      const day = e.target.closest("#view-calendrier .cal-day[data-cal-day]");
      if (!day) return;
      e.preventDefault();
      day.classList.add("is-drop-target");
      e.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("dragleave", e => {
      const day = e.target.closest("#view-calendrier .cal-day[data-cal-day]");
      if (day) day.classList.remove("is-drop-target");
    });

    document.addEventListener("drop", e => {
      const day = e.target.closest("#view-calendrier .cal-day[data-cal-day]");
      if (!day) return;
      e.preventDefault();
      day.classList.remove("is-drop-target");
      const id = e.dataTransfer.getData("text/plain");
      const s = suggestionById(id);
      if (s) openEventModalFromSuggestion(s, day.getAttribute("data-cal-day") || "");
    });
  }

  async function onShow(portal) {
    _portal = portal || window.portal;
    restoreFilters();
    bindOnce();
    await reloadAll();
  }

  window.SkillsCalendrier = { onShow };
})();
