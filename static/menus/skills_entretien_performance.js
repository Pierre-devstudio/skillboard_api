/* ======================================================
   static/menus/skills_entretien_performance.js
   - Menu "Entretien de performance"
   - Squelette + chargement périmètre (services) + collaborateurs
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "entretien-performance";
  const ALL_SERVICES_ID = "__ALL__";

  let _bound = false;
  let _portal = null;

  let _servicesLoaded = false;
  let _servicesFlat = []; // [{id_service, nom_service, depth}]

  const state = {
    serviceId: "",
    population: "team", // encore présent dans ton HTML, ignoré côté API pour l’instant
    focusMode: false,
    selectedCollaborateurId: null,
    selectedCompetenceId: null,
    scoring: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = (value === null || value === undefined || value === "") ? "—" : String(value);
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function openModal(modalId) {
    const m = $(modalId);
    if (!m) return;
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");

    const body = m.querySelector(".modal-body");
    if (body) body.scrollTop = 0;
  }

  function closeModal(modalId) {
    const m = $(modalId);
    if (!m) return;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  function flattenServices(nodes) {
    const out = [];
    function rec(list, depth) {
      (list || []).forEach(n => {
        if (!n || !n.id_service) return;
        out.push({
          id_service: n.id_service,
          nom_service: n.nom_service || n.id_service,
          depth: depth || 0
        });
        if (n.children && n.children.length) rec(n.children, (depth || 0) + 1);
      });
    }
    rec(nodes || [], 0);
    return out;
  }

  function canSeeAllServices(ctx) {
    // On essaie d’être intelligent sans inventer ton modèle.
    // Si ton /skills/context renvoie un flag explicite, il sera pris.
    // Sinon: par défaut on n’affiche PAS "Tous les services".
    if (!ctx) return false;

    if (ctx.allow_all_services === true) return true;
    if (ctx.is_admin === true) return true;
    if (ctx.is_rh === true) return true;
    if (ctx.is_direction === true) return true;

    const role = (ctx.role || "").toString().toLowerCase();
    if (role === "rh" || role === "direction" || role === "admin") return true;

    const roles = Array.isArray(ctx.roles) ? ctx.roles.map(x => (x || "").toString().toLowerCase()) : [];
    if (roles.includes("rh") || roles.includes("direction") || roles.includes("admin")) return true;

    return false;
  }

  function fillServiceSelect(flat, allowAll) {
    const sel = $("ep_selService");
    if (!sel) return;

    const saved = localStorage.getItem("sb_ep_service") || "";
    const current = sel.value || saved || "";

    sel.innerHTML = `<option value="" disabled>— Sélectionner —</option>`;

    if (allowAll) {
      const optAll = document.createElement("option");
      optAll.value = ALL_SERVICES_ID;
      optAll.textContent = "Tous les services";
      sel.appendChild(optAll);
    }

    (flat || []).forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.id_service;
      const prefix = s.depth ? "— ".repeat(Math.min(6, s.depth)) : "";
      opt.textContent = prefix + (s.nom_service || s.id_service);
      sel.appendChild(opt);
    });

    // Restore / default
    if (current && Array.from(sel.options).some(o => o.value === current)) {
      sel.value = current;
    } else if (flat && flat.length === 1) {
      // un seul service => on auto-sélectionne, logique
      sel.value = flat[0].id_service;
    } else {
      // plusieurs services => on laisse choisir
      sel.value = "";
    }
  }

  function getSelectedServiceName() {
    const sel = $("ep_selService");
    if (!sel) return "";
    const opt = sel.options[sel.selectedIndex];
    return opt ? (opt.textContent || "").trim() : "";
  }

  function clearCollaborateurs() {
    const list = $("ep_listCollaborateurs");
    if (list) list.innerHTML = "";
    setText("ep_collabCount", "0");
    state.selectedCollaborateurId = null;
    setText("ep_ctxCollaborateur", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
  }

  function clearCompetences() {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (tbody) tbody.innerHTML = "";
    setText("ep_compCount", "0");
    state.selectedCompetenceId = null;
  }

  function resetContextPanel() {
    setText("ep_ctxStatus", "Brouillon");
    setText("ep_ctxCollaborateur", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
    setText("ep_ctxDate", "—");

    setText("ep_kpiToDo", "0");
    setText("ep_kpiDone", "0");
    setText("ep_kpiChanged", "0");
    setText("ep_kpiReview", "0");
  }

  function resetEvaluationPanel() {
    setText("ep_evalHint", "Sélectionne une compétence dans la liste de gauche.");
    setText("ep_compTitle", "—");
    setText("ep_compDomain", "");
    setText("ep_compCurrent", "—");
    setText("ep_compLastEval", "");

    setText("ep_scoreRaw", "—");
    setText("ep_scoreCoef", "—");
    setText("ep_score24", "—");
    setText("ep_levelABC", "—");

    for (let i = 1; i <= 4; i++) {
      setText(`ep_critLabel${i}`, "—");
      const sel = $(`ep_critNote${i}`);
      if (sel) sel.value = "";
      const com = $(`ep_critCom${i}`);
      if (com) com.value = "";
      setDisabled(`ep_critNote${i}`, true);
      setDisabled(`ep_critCom${i}`, true);
    }

    const obs = $("ep_txtObservation");
    if (obs) obs.value = "";
    setDisabled("ep_txtObservation", true);

    setDisabled("ep_btnSave", true);
    setDisabled("ep_btnSaveNext", true);
    setDisabled("ep_btnMarkReview", true);
    setDisabled("ep_btnFinalize", true);
    setDisabled("ep_btnGenerateSummary", true);

    const listSum = $("ep_listSummary");
    if (listSum) listSum.innerHTML = "";

    const txtGlobal = $("ep_txtGlobalNotes");
    if (txtGlobal) txtGlobal.value = "";
    setDisabled("ep_txtGlobalNotes", true);
  }

  function applyFocusMode() {
    const section = $("view-entretien-performance");
    if (!section) return;

    const split = section.querySelector(".sb-split");
    if (!split) return;

    const cols = split.querySelectorAll(":scope > .sb-col");
    if (!cols || cols.length < 3) return;

    const rightCol = cols[2];
    rightCol.style.display = state.focusMode ? "none" : "";
  }

  function applyUiLockedState() {
    const scopeOk = !!state.serviceId;

    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) txtSearchCollab.disabled = !scopeOk;

    const txtSearchComp = $("ep_txtSearchComp");
    if (txtSearchComp) txtSearchComp.disabled = true;

    for (let i = 1; i <= 4; i++) {
      setDisabled(`ep_critNote${i}`, true);
      setDisabled(`ep_critCom${i}`, true);
    }
    setDisabled("ep_txtObservation", true);

    setDisabled("ep_btnSave", true);
    setDisabled("ep_btnSaveNext", true);
    setDisabled("ep_btnMarkReview", true);
    setDisabled("ep_btnFinalize", true);
    setDisabled("ep_btnGenerateSummary", true);
    setDisabled("ep_txtGlobalNotes", true);

    if (!scopeOk) setText("ep_ctxService", "—");
  }

  async function ensureContext(portal) {
    if (portal.context) return portal.context;

    const ctx = await portal.apiJson(`${portal.apiBase}/skills/context/${encodeURIComponent(portal.contactId)}`);
    portal.context = ctx;

    const civ = (ctx.civilite || "").trim();
    const prenom = (ctx.prenom || "").trim();
    const nom = (ctx.nom || "").trim();
    const display = [civ, prenom, nom].filter(Boolean).join(" ").trim();

    portal.setTopbar(display || "Contact", "Portail Skills — JMB CONSULTANT");
    return ctx;
  }

  async function loadBootstrap() {
    if (!_portal) return;

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/bootstrap/${encodeURIComponent(_portal.contactId)}`;
      const data = await _portal.apiJson(url);
      state.scoring = data?.scoring || null;
    } catch (e) {
      _portal.showAlert("error", "Erreur", String(e?.message || e));
    }
  }

  async function loadServices() {
    if (!_portal) return;

    try {
      const ctx = _portal.context || null;

      const nodes = await _portal.apiJson(
        `${_portal.apiBase}/skills/organisation/services/${encodeURIComponent(_portal.contactId)}`
      );
      const flat = flattenServices(Array.isArray(nodes) ? nodes : []);
      _servicesFlat = flat;
      _servicesLoaded = true;

      const allowAll = canSeeAllServices(ctx);
      fillServiceSelect(flat, allowAll);

    } catch (e) {
      _portal.showAlert("error", "Erreur", "Impossible de charger la liste des services : " + String(e?.message || e));
      _servicesFlat = [];
      _servicesLoaded = false;
    }
  }

  function renderCollaborateurs(list) {
    const wrap = $("ep_listCollaborateurs");
    if (!wrap) return;

    wrap.innerHTML = "";

    const arr = Array.isArray(list) ? list : [];
    setText("ep_collabCount", String(arr.length));

    // petit “style gratuit”: on réutilise le pattern sb-tree (déjà dans portal_common.css)
    wrap.classList.add("sb-tree");

    arr.forEach(c => {
      const name = `${(c.nom_effectif || "").toString().trim()} ${(c.prenom_effectif || "").toString().trim()}`.trim() || "Collaborateur";
      const poste = (c.intitule_poste || "").toString().trim();
      const code = (c.code_effectif || "").toString().trim();

      const left = document.createElement("div");
      left.className = "sb-tree-name";
      left.textContent = name;

      const right = document.createElement("div");
      right.className = "sb-tree-meta";
      right.textContent = [code, poste].filter(Boolean).join(" • ");

      const item = document.createElement("div");
      item.className = "sb-tree-item";
      item.appendChild(left);
      item.appendChild(right);

      // sélection collaborateur (on garde juste l’id, contenu métier plus tard)
      item.addEventListener("click", () => {
        state.selectedCollaborateurId = c.id_effectif || null;

        setText("ep_ctxCollaborateur", name);
        setText("ep_ctxPoste", poste || "—");
        setText("ep_ctxService", getSelectedServiceName() || "—");

        // TODO: chargement compétences du collaborateur
        clearCompetences();
        resetEvaluationPanel();
      });

      wrap.appendChild(item);
    });
  }

  async function loadCollaborateurs() {
    if (!_portal) return;
    if (!state.serviceId) return;

    try {
      _portal.showAlert("", "");

      setText("ep_collabCount", "…");
      const q = ($("ep_txtSearchCollab")?.value || "").trim();

      const params = new URLSearchParams();
      if (q) params.set("q", q);

      const url = `${_portal.apiBase}/skills/entretien-performance/collaborateurs/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.serviceId)}?${params.toString()}`;
      const data = await _portal.apiJson(url);

      renderCollaborateurs(data || []);
      setText("ep_ctxService", getSelectedServiceName() || "—");

    } catch (e) {
      _portal.showAlert("error", "Erreur", "Impossible de charger les collaborateurs : " + String(e?.message || e));
      renderCollaborateurs([]);
      setText("ep_ctxService", getSelectedServiceName() || "—");
    }
  }

  async function onScopeChanged() {
    localStorage.setItem("sb_ep_service", state.serviceId || "");
    clearCollaborateurs();
    clearCompetences();
    resetEvaluationPanel();
    applyUiLockedState();

    if (state.serviceId) {
      await loadCollaborateurs();
    }
  }

  function resetScope() {
    state.serviceId = "";
    state.population = "team";
    state.selectedCollaborateurId = null;
    state.selectedCompetenceId = null;

    const selService = $("ep_selService");
    if (selService) selService.value = "";

    const selPop = $("ep_selPopulation");
    if (selPop) selPop.value = "team";

    const chkFocus = $("ep_chkFocus");
    if (chkFocus) chkFocus.checked = false;
    state.focusMode = false;
    applyFocusMode();

    clearCollaborateurs();
    clearCompetences();
    resetEvaluationPanel();
    resetContextPanel();
    applyUiLockedState();
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    // Modal Scoring (standard)
    const modalScoring = $("modalEpScoring");
    const btnXScoring = $("btnCloseEpScoringModalX");
    const btnCloseScoring = $("btnEpScoringModalClose");
    const closeScoring = () => closeModal("modalEpScoring");

    if (btnXScoring) btnXScoring.addEventListener("click", closeScoring);
    if (btnCloseScoring) btnCloseScoring.addEventListener("click", closeScoring);
    if (modalScoring) {
      modalScoring.addEventListener("click", (e) => {
        if (e.target === modalScoring) closeScoring();
      });
    }

    // Modal History (standard)
    const modalHistory = $("modalEpHistory");
    const btnXHistory = $("btnCloseEpHistoryModalX");
    const btnCloseHistory = $("btnEpHistoryModalClose");
    const closeHistory = () => closeModal("modalEpHistory");

    if (btnXHistory) btnXHistory.addEventListener("click", closeHistory);
    if (btnCloseHistory) btnCloseHistory.addEventListener("click", closeHistory);
    if (modalHistory) {
      modalHistory.addEventListener("click", (e) => {
        if (e.target === modalHistory) closeHistory();
      });
    }

    // Header actions
    const btnHelp = $("ep_btnHelpScoring");
    if (btnHelp) btnHelp.addEventListener("click", () => openModal("modalEpScoring"));

    const btnHist = $("ep_btnHistoryGlobal");
    if (btnHist) btnHist.addEventListener("click", () => openModal("modalEpHistory"));

    // Scope
    const selService = $("ep_selService");
    if (selService) {
      selService.addEventListener("change", async () => {
        state.serviceId = selService.value || "";
        await onScopeChanged();
      });
    }

    const selPop = $("ep_selPopulation");
    if (selPop) {
      selPop.addEventListener("change", async () => {
        state.population = selPop.value || "team";
        // Pour l’instant on ne l’utilise pas côté API, mais on déclenche pareil un refresh.
        await onScopeChanged();
      });
    }

    const btnReset = $("ep_btnScopeReset");
    if (btnReset) btnReset.addEventListener("click", () => resetScope());

    // Search collab (reload)
    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) {
      let t = null;
      txtSearchCollab.addEventListener("input", () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          if (state.serviceId) loadCollaborateurs();
        }, 250);
      });
    }

    // Focus mode
    const chkFocus = $("ep_chkFocus");
    if (chkFocus) {
      chkFocus.addEventListener("change", () => {
        state.focusMode = !!chkFocus.checked;
        applyFocusMode();
      });
    }

    // Actions évaluation (placeholders)
    const btnSave = $("ep_btnSave");
    if (btnSave) btnSave.addEventListener("click", () => _portal && _portal.showAlert("info", "Squelette", "Enregistrement (à implémenter)."));

    const btnSaveNext = $("ep_btnSaveNext");
    if (btnSaveNext) btnSaveNext.addEventListener("click", () => _portal && _portal.showAlert("info", "Squelette", "Enregistrer + suivant (à implémenter)."));

    const btnReview = $("ep_btnMarkReview");
    if (btnReview) btnReview.addEventListener("click", () => _portal && _portal.showAlert("info", "Squelette", "Marquer à revoir (à implémenter)."));

    const btnFinalize = $("ep_btnFinalize");
    if (btnFinalize) btnFinalize.addEventListener("click", () => _portal && _portal.showAlert("info", "Squelette", "Finalisation (à implémenter)."));

    const btnGen = $("ep_btnGenerateSummary");
    if (btnGen) btnGen.addEventListener("click", () => _portal && _portal.showAlert("info", "Squelette", "Génération synthèse (à implémenter)."));
  }

  async function onShow(portal) {
    _portal = portal;

    const section = $("view-entretien-performance");
    if (!section) return;

    bindOnce();

    resetContextPanel();
    resetEvaluationPanel();
    applyUiLockedState();
    applyFocusMode();

    await ensureContext(_portal);
    await loadBootstrap();

    // Chargement services dès affichage
    await loadServices();

    // Si un service est déjà sélectionné (auto/restore), on charge les collaborateurs
    const selService = $("ep_selService");
    state.serviceId = (selService?.value || "").trim();

    if (state.serviceId) {
      applyUiLockedState();
      await loadCollaborateurs();
    } else {
      applyUiLockedState();
    }
  }

  window.SkillsEntretienPerformance = { onShow };
})();
