/* ======================================================
   static/menus/skills_entretien_performance.js
   - Menu "Entretien de performance"
   - Squelette uniquement (pas de contenu métier)
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "entretien-performance";

  let _bound = false;
  let _portal = null;

  const state = {
    serviceId: "",
    population: "team",
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

  function clearSelect(id, keepFirstOption = true) {
    const sel = $(id);
    if (!sel) return;
    const first = keepFirstOption ? sel.options[0] : null;
    sel.innerHTML = "";
    if (first) sel.appendChild(first);
  }

  function openModal(modalId) {
    const m = $(modalId);
    if (!m) return;
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }

  function closeModal(modalId) {
    const m = $(modalId);
    if (!m) return;
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  }

  function closeModalFromEvent(e) {
    const btn = e.target.closest("[data-close]");
    if (!btn) return;
    const id = btn.getAttribute("data-close");
    if (id) closeModal(id);
  }

  function bindModalBehaviorsOnce() {
    // Close buttons
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-close]");
      if (btn) closeModalFromEvent(e);
    });

    // Click outside modal-card closes
    document.addEventListener("mousedown", (e) => {
      const modal = e.target.closest(".modal");
      if (!modal) return;
      const card = e.target.closest(".modal-card");
      if (!card && modal.classList.contains("open")) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }
    });

    // ESC closes any open modal
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = document.querySelectorAll(".modal.open");
      open.forEach((m) => {
        m.classList.remove("open");
        m.setAttribute("aria-hidden", "true");
      });
    });
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    bindModalBehaviorsOnce();

    // Header actions
    const btnHelp = $("ep_btnHelpScoring");
    if (btnHelp) {
      btnHelp.addEventListener("click", () => openModal("modalEpScoring"));
    }

    const btnHist = $("ep_btnHistoryGlobal");
    if (btnHist) {
      btnHist.addEventListener("click", () => openModal("modalEpHistory"));
    }

    // Scope
    const selService = $("ep_selService");
    if (selService) {
      selService.addEventListener("change", () => {
        state.serviceId = selService.value || "";
        // Placeholder: dans la future version, on chargera la population / collaborateurs.
        clearCollaborateurs();
        clearCompetences();
        applyUiLockedState();
      });
    }

    const selPop = $("ep_selPopulation");
    if (selPop) {
      selPop.addEventListener("change", () => {
        state.population = selPop.value || "team";
        // Placeholder: futur rechargement collaborateurs
        clearCollaborateurs();
        clearCompetences();
        applyUiLockedState();
      });
    }

    const btnReset = $("ep_btnResetScope");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        resetScope();
      });
    }

    // Search fields (placeholders)
    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) {
      txtSearchCollab.addEventListener("input", () => {
        // Placeholder: filtrage local de la liste collaborateur
      });
    }

    const txtSearchComp = $("ep_txtSearchComp");
    if (txtSearchComp) {
      txtSearchComp.addEventListener("input", () => {
        // Placeholder: filtrage local du tableau compétences
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
    if (btnSave) {
      btnSave.addEventListener("click", () => {
        if (_portal) _portal.showAlert("info", "Squelette", "Enregistrement (à implémenter).");
      });
    }

    const btnSaveNext = $("ep_btnSaveNext");
    if (btnSaveNext) {
      btnSaveNext.addEventListener("click", () => {
        if (_portal) _portal.showAlert("info", "Squelette", "Enregistrer + suivant (à implémenter).");
      });
    }

    const btnReview = $("ep_btnMarkReview");
    if (btnReview) {
      btnReview.addEventListener("click", () => {
        if (_portal) _portal.showAlert("info", "Squelette", "Marquer à revoir (à implémenter).");
      });
    }

    const btnFinalize = $("ep_btnFinalize");
    if (btnFinalize) {
      btnFinalize.addEventListener("click", () => {
        if (_portal) _portal.showAlert("info", "Squelette", "Finalisation (à implémenter).");
      });
    }

    const btnGen = $("ep_btnGenerateSummary");
    if (btnGen) {
      btnGen.addEventListener("click", () => {
        if (_portal) _portal.showAlert("info", "Squelette", "Génération synthèse (à implémenter).");
      });
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
    // Objectif: masquer la colonne de droite (synthèse/plan d’action).
    // Sans ajouter de CSS spécifique: on masque directement le dernier .sb-col du split.
    const section = $("view-entretien-performance");
    if (!section) return;

    const split = section.querySelector(".sb-split");
    if (!split) return;

    const cols = split.querySelectorAll(":scope > .sb-col");
    if (!cols || cols.length < 3) return;

    const rightCol = cols[2];

    if (state.focusMode) {
      rightCol.style.display = "none";
    } else {
      rightCol.style.display = "";
    }
  }

  function applyUiLockedState() {
    // Tant que service non choisi: on bloque l’interaction (logique)
    const scopeOk = !!state.serviceId;

    // Collabs / compétences: on bloque tant que pas de scope (et plus tard: tant que pas de collab)
    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) txtSearchCollab.disabled = !scopeOk;

    const txtSearchComp = $("ep_txtSearchComp");
    if (txtSearchComp) txtSearchComp.disabled = true; // compétence dépend d’un collaborateur sélectionné (plus tard)

    // Evaluation bloquée par défaut
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

    // Contexte service
    if (!scopeOk) {
      setText("ep_ctxService", "—");
    }
  }

  async function loadBootstrap() {
    // Appel minimal au router "entretien-performance" (bootstrap scoring + info contact)
    // Le reste viendra plus tard (services, collaborateurs, compétences, audits).
    if (!_portal) return;

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/bootstrap/${encodeURIComponent(_portal.contactId)}`;
      const data = await _portal.apiJson(url);
      state.scoring = data?.scoring || null;

      // Topbar
      const contact = data?.contact || null;
      if (contact) {
        const nom = [contact.civ_ca, contact.prenom_ca, contact.nom_ca].filter(Boolean).join(" ").trim();
        _portal.setTopbar("Entretien de performance", nom ? nom : " ");
      } else {
        _portal.setTopbar("Entretien de performance", " ");
      }

      // La carte "Contexte" restera neutre tant qu’on ne choisit pas un collaborateur.
      // A terme, on affichera aussi l’évaluateur et la date entretien.
    } catch (e) {
      _portal.showAlert("error", "Erreur", String(e?.message || e));
    }
  }

  async function onShow(portal) {
    _portal = portal;

    // Sécurité: si la section n’est pas injectée, on ne fait rien
    const section = $("view-entretien-performance");
    if (!section) return;

    bindOnce();

    resetContextPanel();
    resetEvaluationPanel();
    applyUiLockedState();
    applyFocusMode();

    await loadBootstrap();

    // Placeholder: on remplira les services ici (API existante skills_portal_common / organisation, etc.)
    // Pour l’instant: on laisse le select vide (option "— Sélectionner —").
  }

  window.SkillsEntretienPerformance = {
    onShow,
  };
})();
