/* ======================================================
   static/menus/skills_planning_indispo.js
   - Vue planning indisponibilités (agenda simple - vue mois)
   - Filtres: service + recherche + multi-collaborateurs
   - Ajout batch via modal (plusieurs indispos d'un coup)
   ====================================================== */

(function () {
  if (!window.portal) return;

  const API_BASE = window.portal.apiBase || "https://skillboard-services.onrender.com";

  let _bound = false;

  const _state = {
    current: new Date(),          // mois affiché
    id_service: null,             // filtre service (queryId)
    search: "",                   // filtre texte collaborateurs
    collabs: [],                  // liste collaborateurs
    collabMap: {},                // id_effectif => collab
    selectedIds: new Set(),       // multi-sélection; vide => tous
    breaks: [],                   // indispos chargées
    lastRange: { start: null, end: null }, // YYYY-MM-DD
  };

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "")
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function toYmd(d) {
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    return `${yyyy}-${mm}-${dd}`;
  }

  function parseYmd(s) {
    const v = (s || "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.length >= 10 ? v.slice(0, 10) : v);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

  // Lundi début de semaine
  function mondayIndex(jsDay) { return (jsDay + 6) % 7; } // 0=>6,1=>0,...6=>5

  function monthLabelFR(d) {
    try {
      const s = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch {
      return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
  }

  function buildMonthGridRange(d) {
    const first = startOfMonth(d);
    const last = endOfMonth(d);

    const firstIdx = mondayIndex(first.getDay());
    const gridStart = addDays(first, -firstIdx);

    const lastIdx = mondayIndex(last.getDay());
    const gridEnd = addDays(last, (6 - lastIdx));

    return { gridStart, gridEnd };
  }

  function colorForId(id) {
    const palette = [
      "#1d4ed8", "#0f766e", "#7c3aed", "#b91c1c", "#0f172a",
      "#a16207", "#065f46", "#be185d", "#2563eb", "#047857",
      "#6d28d9", "#9f1239"
    ];
    const s = String(id || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
    h = Math.abs(h | 0);
    return palette[h % palette.length];
  }

  function collabLabel(c) {
    const prenom = (c?.prenom_effectif || "").trim();
    const nom = (c?.nom_effectif || "").trim().toUpperCase();
    const full = `${prenom} ${nom}`.trim();
    return full || "Collaborateur";
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

  async function loadCollaborateurs(id_contact) {
    const qs = buildQuery({
      q: _state.search || null,
      id_service: _state.id_service || null,
      limit: 200,
      offset: 0,
      only_actifs: true,
      include_archived: false,
      only_manager: false,
      only_formateur: false,
      only_temp: false,
    });

    const url = `${API_BASE}/skills/collaborateurs/list/${encodeURIComponent(id_contact)}${qs}`;
    const rows = await window.portal.apiJson(url);

    _state.collabs = Array.isArray(rows) ? rows : [];
    _state.collabMap = {};
    _state.collabs.forEach(c => {
      if (c?.id_effectif) _state.collabMap[String(c.id_effectif)] = c;
    });

    renderCollabPick();
    fillEffectifSelect();
  }

  async function loadBreaks(id_contact, startYmd, endYmd) {
    const ids = Array.from(_state.selectedIds || []);
    const qs = buildQuery({
      start: startYmd,
      end: endYmd,
      id_service: _state.id_service || null,
      ids_effectif: ids.length ? ids.join(",") : null,
    });

    const url = `${API_BASE}/skills/collaborateurs/breaks/${encodeURIComponent(id_contact)}${qs}`;
    const rows = await window.portal.apiJson(url);

    _state.breaks = Array.isArray(rows) ? rows : [];
    _state.lastRange = { start: startYmd, end: endYmd };

    renderCalendar();
  }

  function renderCollabPick() {
    const host = byId("planCollabList");
    if (!host) return;

    const list = Array.isArray(_state.collabs) ? _state.collabs : [];
    if (!list.length) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun collaborateur pour ces filtres.</div>`;
      return;
    }

    host.innerHTML = list.map(c => {
      const id = String(c.id_effectif || "");
      const name = collabLabel(c);
      const svc = (c.nom_service || "").trim();
      const checked = _state.selectedIds.has(id) ? "checked" : "";
      const col = colorForId(id);

      return `
        <label class="sb-collab-pick-row" data-id="${escapeHtml(id)}" title="${escapeHtml(name)}">
          <input type="checkbox" class="sb-collab-pick-chk" value="${escapeHtml(id)}" ${checked} />
          <span class="sb-dot" style="background:${escapeHtml(col)};"></span>
          <span class="sb-collab-pick-name">${escapeHtml(name)}</span>
          <span class="sb-collab-pick-svc">${escapeHtml(svc || "—")}</span>
        </label>
      `;
    }).join("");
  }

  function fillEffectifSelect() {
    const sel = byId("breakBatchEffectifSelect");
    if (!sel) return;

    const list = Array.isArray(_state.collabs) ? _state.collabs : [];
    if (!list.length) {
      sel.innerHTML = `<option value="">Aucun collaborateur</option>`;
      return;
    }

    let pre = "";
    if (_state.selectedIds && _state.selectedIds.size === 1) {
      pre = Array.from(_state.selectedIds)[0];
    }

    const opts = list.map(c => {
      const id = String(c.id_effectif || "");
      const name = collabLabel(c);
      const selAttr = (pre && pre === id) ? " selected" : "";
      return `<option value="${escapeHtml(id)}"${selAttr}>${escapeHtml(name)}</option>`;
    }).join("");

    sel.innerHTML = `<option value="">Choisir…</option>${opts}`;
  }

  function renderLegend() {
    const host = byId("planLegend");
    if (!host) return;

    const used = new Map();
    (_state.breaks || []).forEach(b => {
      const id = String(b?.id_effectif || "");
      if (!id) return;
      const c = _state.collabMap[id];
      used.set(id, collabLabel(c || null));
    });

    if (!used.size) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucune indisponibilité sur la période.</div>`;
      return;
    }

    const items = Array.from(used.keys()).sort().map(id => {
      const name = used.get(id) || "Collaborateur";
      const col = colorForId(id);
      return `
        <div class="sb-legend-item" title="${escapeHtml(name)}">
          <span class="sb-dot" style="background:${escapeHtml(col)};"></span>
          <span>${escapeHtml(name)}</span>
        </div>
      `;
    }).join("");

    host.innerHTML = `<div class="sb-legend">${items}</div>`;
  }

  function buildEventsByDay(gridStart, gridEnd) {
    const map = {};
    const start = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate());
    const end = new Date(gridEnd.getFullYear(), gridEnd.getMonth(), gridEnd.getDate());

    const clampStart = (d) => (d < start ? start : d);
    const clampEnd = (d) => (d > end ? end : d);

    (_state.breaks || []).forEach(b => {
      const ds = parseYmd(b?.date_debut);
      const de = parseYmd(b?.date_fin);
      const id_eff = String(b?.id_effectif || "");
      if (!ds || !de || !id_eff) return;

      const s = clampStart(ds);
      const e = clampEnd(de);
      if (s > e) return;

      for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= e; d = addDays(d, 1)) {
        const k = toYmd(d);
        map[k] = map[k] || [];
        map[k].push(b);
      }
    });

    Object.keys(map).forEach(k => {
      map[k].sort((a, b) => {
        const la = collabLabel(_state.collabMap[String(a?.id_effectif || "")]);
        const lb = collabLabel(_state.collabMap[String(b?.id_effectif || "")]);
        return la.localeCompare(lb);
      });
    });

    return map;
  }

  function renderCalendar() {
    const host = byId("planCalendar");
    const title = byId("planMonthLabel");
    if (!host) return;

    if (title) title.textContent = monthLabelFR(_state.current);

    const { gridStart, gridEnd } = buildMonthGridRange(_state.current);
    _state.lastRange = { start: toYmd(gridStart), end: toYmd(gridEnd) };

    const inMonth = (d) => d.getMonth() === _state.current.getMonth() && d.getFullYear() === _state.current.getFullYear();
    const todayYmd = toYmd(new Date());
    const eventsByDay = buildEventsByDay(gridStart, gridEnd);

    const weekdays = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
      .map(w => `<div class="sb-cal-wd">${w}</div>`).join("");

    let cells = "";
    let d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate());

    for (let i = 0; i < 42; i++) {
      const ymd = toYmd(d);
      const isOut = !inMonth(d);
      const isToday = (ymd === todayYmd);

      const list = eventsByDay[ymd] || [];
      const chips = list.slice(0, 3).map(b => {
        const id_eff = String(b?.id_effectif || "");
        const c = _state.collabMap[id_eff];
        const name = collabLabel(c);
        const col = colorForId(id_eff);
        const ds = escapeHtml(b?.date_debut || "");
        const de = escapeHtml(b?.date_fin || "");
        const bid = escapeHtml(String(b?.id_break || ""));
        return `
          <div class="sb-cal-evt"
               data-break-id="${bid}"
               data-eff-id="${escapeHtml(id_eff)}"
               title="${escapeHtml(name)} (${ds} → ${de})"
               style="background:${escapeHtml(col)};">
            ${escapeHtml((c?.prenom_effectif || name).split(" ")[0] || name)}
          </div>
        `;
      }).join("");

      const more = (list.length > 3)
        ? `<div class="sb-cal-more" title="${escapeHtml(list.map(b => collabLabel(_state.collabMap[String(b?.id_effectif || "")])).join(", "))}">+${list.length - 3}</div>`
        : "";

      cells += `
        <div class="sb-cal-day ${isOut ? "is-out" : ""} ${isToday ? "is-today" : ""}" data-ymd="${escapeHtml(ymd)}">
          <div class="sb-cal-daynum">${d.getDate()}</div>
          <div class="sb-cal-evts">
            ${chips}
            ${more}
          </div>
        </div>
      `;

      d = addDays(d, 1);
    }

    host.innerHTML = `
      <div class="sb-cal">
        <div class="sb-cal-head">${weekdays}</div>
        <div class="sb-cal-grid">${cells}</div>
      </div>
    `;

    renderLegend();
  }

  function showBatchError(msg) {
    const box = byId("breakBatchError");
    if (!box) return;
    if (!msg) {
      box.style.display = "none";
      box.textContent = "";
      return;
    }
    box.style.display = "block";
    box.textContent = msg;
  }

  function openModalBreakBatch() {
    const modal = byId("modalBreakBatch");
    if (!modal) return;

    showBatchError(null);

    const rowsHost = byId("breakBatchRows");
    if (rowsHost) rowsHost.innerHTML = "";

    addBatchRow();
    addBatchRow();

    fillEffectifSelect();

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModalBreakBatch() {
    const modal = byId("modalBreakBatch");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function addBatchRow(d1 = "", d2 = "") {
    const host = byId("breakBatchRows"); // tbody
    if (!host) return;

    const tr = document.createElement("tr");
    tr.className = "sb-batch-tr";
    tr.innerHTML = `
      <td><input type="date" class="sb-batch-date" data-k="start" value="${escapeHtml(d1)}"></td>
      <td><input type="date" class="sb-batch-date" data-k="end" value="${escapeHtml(d2)}"></td>
      <td><span class="sb-batch-status">—</span></td>
      <td class="col-center">
        <button type="button" class="btn-secondary sb-batch-del" title="Supprimer">×</button>
      </td>
    `;

    tr.querySelector(".sb-batch-del")?.addEventListener("click", () => tr.remove());
    host.appendChild(tr);
  }

  function _setBatchStatus(tr, text, kind) {
    const cell = tr ? tr.querySelector(".sb-batch-status") : null;
    if (cell) cell.textContent = text || "—";

    if (tr) {
      tr.dataset.batchKind = kind || "";
      tr.classList.toggle("is-ok", kind === "ok");
      tr.classList.toggle("is-err", kind === "err");
    }
  }

  function validateBatchRows() {
    const host = byId("breakBatchRows");
    const rows = host ? Array.from(host.querySelectorAll("tr")) : [];

    const valids = []; // {tr, ds, de, item}
    let hasError = false;

    // 1) validations simples par ligne
    for (const tr of rows) {
      const s = (tr.querySelector('[data-k="start"]')?.value || "").trim();
      const e = (tr.querySelector('[data-k="end"]')?.value || "").trim();

      if (!s && !e) {
        _setBatchStatus(tr, "—", "skip");
        continue;
      }

      if (!s || !e) {
        _setBatchStatus(tr, "Dates manquantes", "err");
        hasError = true;
        continue;
      }

      const ds = parseYmd(s);
      const de = parseYmd(e);

      if (!ds || !de) {
        _setBatchStatus(tr, "Dates invalides", "err");
        hasError = true;
        continue;
      }

      if (de < ds) {
        _setBatchStatus(tr, "Fin < début", "err");
        hasError = true;
        continue;
      }

      // OK provisoire (peut passer en erreur si chevauchement intra-lot)
      _setBatchStatus(tr, "OK", "ok");
      valids.push({ tr, ds, de, item: { date_debut: s, date_fin: e } });
    }

    // 2) anti-chevauchement intra-lot (inclusif)
    const ordered = valids.slice().sort((a, b) => (a.ds - b.ds) || (a.de - b.de));

    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];

      // chevauchement inclusif: cur.start <= prev.end
      if (cur.ds <= prev.de) {
        _setBatchStatus(prev.tr, "Chevauchement", "err");
        _setBatchStatus(cur.tr, "Chevauchement", "err");
        hasError = true;

        // on garde le "prev" le plus englobant pour comparer la suite
        if (cur.de > prev.de) ordered[i].de = cur.de;
      }
    }

    // items à envoyer (uniquement lignes valides)
    const items = valids
      .filter(x => (x.tr?.dataset?.batchKind || "") === "ok")
      .map(x => x.item);

    return { hasError, items };
  }


  async function saveBatch(id_contact) {
    const sel = byId("breakBatchEffectifSelect");
    const id_eff = (sel?.value || "").trim();
    if (!id_eff) throw new Error("Choisis un collaborateur.");

    const chk = validateBatchRows();
    if (chk.hasError) throw new Error("Corrige les lignes en erreur.");
    const items = chk.items;
    if (!items.length) throw new Error("Ajoute au moins une indisponibilité.");


    const url = `${API_BASE}/skills/collaborateurs/breaks/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_eff)}`;

    const data = await window.portal.apiJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });

    if (!data || data.ok !== true) {
      const msg = (data && (data.detail || data.message)) ? (data.detail || data.message) : "Erreur enregistrement indisponibilités.";
      throw new Error(msg);
    }

    if (_state.lastRange.start && _state.lastRange.end) {
      await loadBreaks(id_contact, _state.lastRange.start, _state.lastRange.end);
    }
  }

  function bindHandlersOnce(id_contact) {
    if (_bound) return;
    _bound = true;

    const btnBack = byId("btnPlanBack");
    const btnPrev = byId("btnPlanPrev");
    const btnNext = byId("btnPlanNext");
    const btnToday = byId("btnPlanToday");
    const btnAdd = byId("btnPlanAdd");
    const btnReset = byId("btnPlanReset");

    const inputSearch = byId("planCollabSearch");
    const pickHost = byId("planCollabList");

    const btnCloseModal = byId("btnCloseBreakBatch");
    const btnCancelModal = byId("btnBreakBatchCancel");
    const btnAddRow = byId("btnBreakBatchAddRow");
    const btnSave = byId("btnBreakBatchSave");
    const modal = byId("modalBreakBatch");

    let tSearch = null;

    if (btnBack) btnBack.addEventListener("click", () => {
      const base = window.location.pathname + window.location.search;

      // Nettoie l’URL (supprime le #...) sans ajouter d’historique
      if (window.location.hash) {
        history.replaceState(null, document.title, base);
      }

      // Retour UI sur la vue collaborateurs
      if (window.portal && typeof window.portal.switchView === "function") {
        window.portal.switchView("vos-collaborateurs");
      } else {
        window.location.href = base;
      }
    });


    if (btnPrev) btnPrev.addEventListener("click", async () => {
      _state.current = new Date(_state.current.getFullYear(), _state.current.getMonth() - 1, 1);
      await refreshBreaksForCurrentMonth(id_contact);
    });

    if (btnNext) btnNext.addEventListener("click", async () => {
      _state.current = new Date(_state.current.getFullYear(), _state.current.getMonth() + 1, 1);
      await refreshBreaksForCurrentMonth(id_contact);
    });

    if (btnToday) btnToday.addEventListener("click", async () => {
      _state.current = new Date();
      await refreshBreaksForCurrentMonth(id_contact);
    });

    if (btnAdd) btnAdd.addEventListener("click", () => openModalBreakBatch());

    if (btnReset) btnReset.addEventListener("click", async () => {
      const selS = byId("planServiceSelect");
      if (selS) selS.value = window.portal.serviceFilter.ALL_ID;

      _state.id_service = null;
      _state.search = "";
      _state.selectedIds = new Set();

      if (inputSearch) inputSearch.value = "";

      await loadCollaborateurs(id_contact);
      await refreshBreaksForCurrentMonth(id_contact);
    });

    if (inputSearch) {
      inputSearch.addEventListener("input", () => {
        clearTimeout(tSearch);
        tSearch = setTimeout(async () => {
          _state.search = (inputSearch.value || "").trim();
          await loadCollaborateurs(id_contact);
          await refreshBreaksForCurrentMonth(id_contact);
        }, 250);
      });
    }

    if (pickHost) {
      pickHost.addEventListener("change", async (e) => {
        const chk = e.target;
        if (!chk || chk.classList.contains("sb-collab-pick-chk") === false) return;

        const id = String(chk.value || "");
        if (!id) return;

        if (chk.checked) _state.selectedIds.add(id);
        else _state.selectedIds.delete(id);

        await refreshBreaksForCurrentMonth(id_contact);
      });
    }

    // --- Modal édition indisponibilité ---
    const editModal = byId("modalBreakEdit");
    const btnEditX = byId("btnCloseBreakEdit");
    const btnEditCancel = byId("btnBreakEditCancel");
    const btnEditSave = byId("btnBreakEditSave");
    const radUpdate = byId("radBreakEditUpdate");
    const radArchive = byId("radBreakEditArchive");
    const editStart = byId("breakEditStart");
    const editEnd = byId("breakEditEnd");
    const editId = byId("breakEditId");
    const editErr = byId("breakEditError");

    const showEditError = (msg) => {
      if (!editErr) return;
      if (!msg) {
        editErr.style.display = "none";
        editErr.textContent = "";
        return;
      }
      editErr.style.display = "block";
      editErr.textContent = msg;
    };

    const openEditModal = (b) => {
      if (!editModal) return;
      showEditError(null);

      if (radUpdate) radUpdate.checked = true;
      if (radArchive) radArchive.checked = false;

      if (editId) editId.value = String(b?.id_break || "");
      if (editStart) editStart.value = String(b?.date_debut || "").slice(0, 10);
      if (editEnd) editEnd.value = String(b?.date_fin || "").slice(0, 10);

      // champs actifs par défaut (update)
      if (editStart) editStart.disabled = false;
      if (editEnd) editEnd.disabled = false;

      editModal.classList.add("show");
      editModal.setAttribute("aria-hidden", "false");
    };

    const closeEditModal = () => {
      if (!editModal) return;
      editModal.classList.remove("show");
      editModal.setAttribute("aria-hidden", "true");
    };

    const syncEditMode = () => {
      const isArchive = !!(radArchive && radArchive.checked);
      if (editStart) editStart.disabled = isArchive;
      if (editEnd) editEnd.disabled = isArchive;
    };

    if (radUpdate) radUpdate.addEventListener("change", syncEditMode);
    if (radArchive) radArchive.addEventListener("change", syncEditMode);

    if (btnEditX) btnEditX.addEventListener("click", closeEditModal);
    if (btnEditCancel) btnEditCancel.addEventListener("click", closeEditModal);
    if (editModal) {
      editModal.addEventListener("click", (e) => {
        if (e.target === editModal) closeEditModal();
      });
    }

    if (btnEditSave) {
      btnEditSave.addEventListener("click", async () => {
        showEditError(null);
        try {
          const bid = (editId?.value || "").trim();
          if (!bid) throw new Error("Indisponibilité introuvable.");

          const action = (radArchive && radArchive.checked) ? "archive" : "update";
          const payload = { action };

          if (action === "update") {
            const d1 = (editStart?.value || "").trim();
            const d2 = (editEnd?.value || "").trim();
            if (!d1 || !d2) throw new Error("Dates obligatoires.");
            payload.date_debut = d1;
            payload.date_fin = d2;
          }

          btnEditSave.disabled = true;

          const url = `${API_BASE}/skills/collaborateurs/breaks/edit/${encodeURIComponent(id_contact)}/${encodeURIComponent(bid)}`;
          const data = await window.portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!data || data.ok !== true) {
            throw new Error((data && (data.detail || data.message)) || "Erreur mise à jour.");
          }

          closeEditModal();
          await refreshBreaksForCurrentMonth(id_contact);

        } catch (err) {
          showEditError(err?.message || String(err));
        } finally {
          btnEditSave.disabled = false;
        }
      });
    }

    // Clic sur event => ouvre modal edit
    const calHost = byId("planCalendar");
    if (calHost) {
      calHost.addEventListener("click", (e) => {
        const el = e.target;
        if (!el || !el.classList.contains("sb-cal-evt")) return;

        const bid = String(el.getAttribute("data-break-id") || "").trim();
        if (!bid) return;

        const b = (_state.breaks || []).find(x => String(x?.id_break || "") === bid);
        if (!b) return;

        openEditModal(b);
      });
    }


    if (btnCloseModal) btnCloseModal.addEventListener("click", () => closeModalBreakBatch());
    if (btnCancelModal) btnCancelModal.addEventListener("click", () => closeModalBreakBatch());
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModalBreakBatch();
      });
    }

    if (btnAddRow) btnAddRow.addEventListener("click", () => addBatchRow());

    if (btnSave) btnSave.addEventListener("click", async () => {
      showBatchError(null);
      try {
        btnSave.disabled = true;
        await saveBatch(id_contact);
        closeModalBreakBatch();
      } catch (err) {
        showBatchError(err?.message || String(err));
      } finally {
        btnSave.disabled = false;
      }
    });
  }

  async function refreshBreaksForCurrentMonth(id_contact) {
    const { gridStart, gridEnd } = buildMonthGridRange(_state.current);
    await loadBreaks(id_contact, toYmd(gridStart), toYmd(gridEnd));
  }

  async function initMenu(portalCtx) {
    const id_contact = portalCtx?.contactId || window.portal.contactId;
    if (!id_contact) return;

    // Services
    try {
      await window.portal.serviceFilter.populateSelect({
        portal: window.portal,
        contactId: id_contact,
        selectId: "planServiceSelect",
        storageKey: "sb_plan_service",
        labelAll: "Tous les services",
        labelNonLie: "Non lié",
        includeAll: true,
        includeNonLie: true,
        allowIndent: true
      });
    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement services : " + e.message);
    }

    const selS = byId("planServiceSelect");
    if (selS) {
      selS.addEventListener("change", async () => {
        const raw = (selS.value || "").trim();
        _state.id_service = window.portal.serviceFilter.toQueryId(raw);

        // On reset la sélection collaborateurs quand on change de service
        _state.selectedIds = new Set();
        renderCollabPick();

        await loadCollaborateurs(id_contact);
        await refreshBreaksForCurrentMonth(id_contact);
      });

      const raw0 = (selS.value || "").trim();
      _state.id_service = window.portal.serviceFilter.toQueryId(raw0);
    }

    bindHandlersOnce(id_contact);

    await loadCollaborateurs(id_contact);
    await refreshBreaksForCurrentMonth(id_contact);
  }

  window.SkillsPlanningIndispo = window.SkillsPlanningIndispo || {};
  window.SkillsPlanningIndispo.onShow = initMenu;
})();
