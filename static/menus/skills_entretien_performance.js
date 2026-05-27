/* ======================================================
   static/menus/skills_entretien_performance.js
   - Menu "Entretien de performance"
   - Squelette + chargement périmètre (services) + collaborateurs
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "entretien-performance";
  const LS_KEY_SERVICE = "sb_ep_service";

  let _bound = false;
  let _portal = null;

  let _servicesLoaded = false;
  let _servicesFlat = []; // [{id_service, nom_service, depth}]

  const state = {
    serviceId: "",
    population: "team", // encore présent dans ton HTML, ignoré côté API pour l’instant
    focusMode: false,
    selectedCollaborateurId: null,
    selectedCollaborateurServiceId: "",
    selectedCompetenceId: null,
    scoring: null,
    selectedEntretienId: null,
    _entretiensList: [],
    _entretienDraft: null,
    _entretienAuditContext: null,
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

  // ------------------------------------------------------
  // Couverture poste: modal détail (réutilise state._covData)
  // ------------------------------------------------------
  function _epGetCovWeightedFlag() {
    return true;
  }

  function _epLevelFromScore24(score) {
    const s = Number(score || 0);
    if (!isFinite(s) || s <= 0) return "—";
    // bornes validées: A [6..10[, B [10..19[, C [19..24]
    if (s >= 19) return "Expert";
    if (s >= 10) return "Avancé";
    if (s >= 6) return "Initial";
    return "—";
  }

  function renderCoverageDetailModal() {
    const info = $("ep_covDetailInfo");
    const tbody = $("ep_tblCoverageDetail")?.querySelector("tbody");
    if (tbody) tbody.innerHTML = "";

    // data calculée par l’API couverture
    const covRoot = state._covData || state.covData || null;
    if (!covRoot) {
      if (info) info.textContent = "Aucun calcul disponible. Sélectionne un collaborateur.";
      return;
    }

    const weighted = _epGetCovWeightedFlag();

    // tolérant aux noms (plain/weighted)
    const cov =
      (weighted ? (covRoot.weighted || covRoot.pondered || covRoot.weight || null)
                : (covRoot.plain || covRoot.simple || covRoot.unweighted || null))
      || null;

    if (!cov) {
      if (info) info.textContent = "Données de couverture indisponibles (mode).";
      return;
    }

    const poste = (covRoot.poste_intitule || covRoot.poste || cov.poste || "").toString().trim();
    const modeTxt = weighted ? "Pondéré par criticité" : "Non pondéré";
    if (info) info.textContent = [poste ? `Poste : ${poste}` : "", modeTxt].filter(Boolean).join(" • ");

    const details = Array.isArray(cov.details) ? cov.details : [];
    if (!details.length) return;

    details.forEach(d => {
      const code = (d.code || "").toString().trim();
      const intitule = (d.intitule || "").toString().trim();

      const poids = (d.poids_criticite ?? d.poids ?? "").toString().trim();
      const niveauRequis = (d.niveau_requis || d.niveau_attendu || "").toString().trim();

      const score24 = Number(d.score ?? d.score_24 ?? d.resultat ?? 0);
      const niveauSalarie = _epLevelFromScore24(score24);

      const tr = document.createElement("tr");

      // Compétence: badge code ligne 1, intitulé ligne 2
      const tdComp = document.createElement("td");
      tdComp.innerHTML = `
        <div>
          <div><span class="sb-badge sb-badge-accent">${code || "—"}</span></div>
          <div style="margin-top:4px; font-size:13px;">${intitule || "—"}</div>
        </div>
      `;

      const tdPoids = document.createElement("td");
      tdPoids.className = "col-center";
      tdPoids.textContent = poids || "—";

      const tdReq = document.createElement("td");
      tdReq.className = "col-center";
      tdReq.innerHTML = niveauRequis ? `<span class="sb-badge">${niveauRequis}</span>` : "—";

      const tdSal = document.createElement("td");
      tdSal.className = "col-center";
      tdSal.innerHTML = (niveauSalarie && niveauSalarie !== "—") ? `<span class="sb-badge">${niveauSalarie}</span>` : "—";

      tr.appendChild(tdComp);
      tr.appendChild(tdPoids);
      tr.appendChild(tdReq);
      tr.appendChild(tdSal);

      if (tbody) tbody.appendChild(tr);
    });
  }


  /* ======================================================
     Guide de notation (popover par critère)
     - Créé en JS (pas besoin de toucher au CSS)
     - Se ferme au clic dehors / scroll / resize
     ====================================================== */

  function ensureGuidePopover() {
    let pop = document.getElementById("ep_popGuide");
    if (pop) return pop;

    pop = document.createElement("div");
    pop.id = "ep_popGuide";
    pop.className = "card";
    pop.style.position = "fixed";
    pop.style.zIndex = "10080";
    pop.style.display = "none";
    pop.style.maxWidth = "460px";
    pop.style.padding = "12px";
    pop.style.boxShadow = "0 12px 28px rgba(0,0,0,.18)";
    pop.style.border = "1px solid #e5e7eb";
    pop.style.borderRadius = "12px";

    pop.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="font-weight:600;">Guide de notation</div>
        <button type="button" class="modal-x" id="ep_popGuideClose" aria-label="Fermer">×</button>
      </div>
      <div class="card-sub" id="ep_popGuideTitle" style="margin-top:6px;"></div>
      <div id="ep_popGuideBody" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;"></div>
    `;

    document.body.appendChild(pop);

    const close = () => closeGuidePopover();

    const btnClose = document.getElementById("ep_popGuideClose");
    if (btnClose) btnClose.addEventListener("click", close);

    // Clic dehors -> ferme (sauf clic sur un bouton d'aide .ep-crit-help)
    document.addEventListener("click", (ev) => {
      const p = document.getElementById("ep_popGuide");
      if (!p || p.style.display === "none") return;

      const t = ev.target;
      if (p.contains(t)) return;
      if (t && t.closest && t.closest(".ep-crit-help")) return;

      close();
    });

    // Scroll/resize -> ferme (sinon ça se balade n'importe où)
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);

    return pop;
  }

  function closeGuidePopover() {
    const pop = document.getElementById("ep_popGuide");
    if (!pop) return;
    pop.style.display = "none";
  }

    function openGuidePopover(anchorEl, critIndex, critLabel, evals, selectedNote) {
        const pop = ensureGuidePopover();
        if (!pop || !anchorEl) return;

        // On retrouve le select de note du critère depuis la ligne du tableau
        const tr = anchorEl.closest("tr");
        const noteSelect = tr ? tr.querySelector('select[id^="ep_critNote"]') : null;

        const title = document.getElementById("ep_popGuideTitle");
        if (title) {
            const lbl = (critLabel || "").toString().trim();
            title.textContent = lbl ? `Critère ${critIndex} : ${lbl}` : `Critère ${critIndex}`;
        }

        const body = document.getElementById("ep_popGuideBody");
        if (body) body.innerHTML = "";

        const arr = Array.isArray(evals) ? evals : [];

        for (let i = 1; i <= 4; i++) {
            const txt = (arr[i - 1] || "").toString().trim();

            const line = document.createElement("div");
            line.style.display = "flex";
            line.style.gap = "10px";
            line.style.alignItems = "flex-start";
            line.style.padding = "8px 10px";
            line.style.border = "1px solid #e5e7eb";
            line.style.borderRadius = "10px";
            line.style.cursor = (noteSelect && !noteSelect.disabled) ? "pointer" : "default";

            // surlignage de la note sélectionnée
            if (String(selectedNote || "") === String(i)) {
            line.style.background = "color-mix(in srgb, var(--reading-accent) 10%, #ffffff)";
            line.style.borderColor = "color-mix(in srgb, var(--reading-accent) 35%, #e5e7eb)";
            } else {
            line.style.background = "#fff";
            }

            const badge = document.createElement("span");
            badge.className = "sb-badge";
            badge.textContent = String(i);
            badge.style.minWidth = "28px";
            badge.style.textAlign = "center";

            const text = document.createElement("div");
            text.style.flex = "1";
            text.style.minWidth = "0";
            text.textContent = txt || "—";

            line.appendChild(badge);
            line.appendChild(text);

            // Clic = on pousse la note dans le select du critère
            line.addEventListener("click", () => {
              if (!noteSelect || noteSelect.disabled) {
                return;
              }

              noteSelect.value = String(i);

              // déclenche les listeners éventuels (recalcul / score, etc.)
              noteSelect.dispatchEvent(new Event("input", { bubbles: true }));
              noteSelect.dispatchEvent(new Event("change", { bubbles: true }));

              closeGuidePopover();
            });

            if (body) body.appendChild(line);
        }

        // Affiche + positionne
        pop.style.display = "block";
        pop.style.left = "0px";
        pop.style.top = "0px";

        const r = anchorEl.getBoundingClientRect();
        const pw = pop.offsetWidth || 360;
        const ph = pop.offsetHeight || 220;

        const pad = 10;
        let left = r.left;
        let top = r.bottom + 8;

        if (left + pw > window.innerWidth - pad) left = window.innerWidth - pw - pad;
        if (left < pad) left = pad;

        // si pas de place en bas -> au-dessus
        if (top + ph > window.innerHeight - pad) {
            top = r.top - ph - 8;
            if (top < pad) top = pad;
        }

        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(top)}px`;
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
    setText("ep_ctxMatricule", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
    setText("ep_ctxDate", "—");
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
    setText("ep_ctxMatricule", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
    setText("ep_ctxDate", "—");


    setText("ep_kpiToDo", "0");
    setText("ep_kpiDone", "0");
    setText("ep_kpiChanged", "0");
    setText("ep_kpiReview", "0");
  }

  function renderEvalCompetenceTitle(code, intitule) {
    const titleEl = $("ep_compTitle");
    if (!titleEl) return;

    const c = (code || "").toString().trim();
    const t = (intitule || "").toString().trim();

    titleEl.innerHTML = "";

    if (c) {
      const badge = document.createElement("span");
      badge.className = "sb-badge sb-badge-ref-comp-code ep-eval-title-code";
      badge.textContent = c;
      titleEl.appendChild(badge);
    }

    const txt = document.createElement("span");
    txt.className = "ep-eval-title-text";
    txt.textContent = t || "—";
    titleEl.appendChild(txt);
  }

  function renderEvalDomainBadge(label, rawColor) {
    const domEl = $("ep_compDomain");
    if (!domEl) return;

    const txt = (label || "").toString().trim();
    const color = epNormalizeColor(rawColor || "") || "#9ca3af";

    domEl.textContent = "";
    domEl.removeAttribute("style");

    if (!txt) {
      domEl.className = "sb-badge-domaine ep-domain-badge";
      domEl.style.display = "none";
      domEl.style.removeProperty("--dom-color");
      return;
    }

    domEl.className = "sb-badge-domaine ep-domain-badge";
    domEl.textContent = txt;
    domEl.style.setProperty("--dom-color", color);
    domEl.style.display = "inline-flex";
  }

  function resetEvaluationPanel() {
    state._historyAuditEditing = null;

    const evalModal = $("modalEpEvaluation");
    if (evalModal) evalModal.classList.remove("is-history-readonly", "is-history-editable");

    const titleEl = $("ep_compTitle");
    if (titleEl) {
      titleEl.innerHTML = "";
      titleEl.textContent = "—";
    }

    renderEvalDomainBadge("", "");
  
    setText("ep_evalHint", "Sélectionne une compétence.");
    setText("ep_compTitle", "—");
    setText("ep_compDomain", "");
    setText("ep_compCurrent", "—");
    setText("ep_compLastEval", "");

    setText("ep_scoreRaw", "—");
    setText("ep_scorePct", "—");
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

    const method = $("ep_selEvalMethod");
    if (method) method.value = "Entretien de performance";
    setDisabled("ep_selEvalMethod", true);

    const obs = $("ep_txtObservation");
    if (obs) obs.value = "";
    setDisabled("ep_txtObservation", true);

    setDisabled("ep_btnSave", true);

    clearSaveInlineMsg();
  }

    // ======================================================
  // Helpers UI post-save
  // ======================================================

  function clearSaveInlineMsg() {
    const msg = $("ep_saveInlineMsg") || $("ep_saveMsg");
    if (!msg) return;

    msg.textContent = "";
    msg.classList.remove(
      "is-visible",
      "sb-inline-msg--success",
      "sb-inline-msg--info",
      "sb-inline-msg--danger"
    );
  }

  function _formatDateFR(v) {
    const s = (v ?? "").toString().trim();
    if (!s) return "";

    // déjà au format FR
    if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(s)) return s.replace(/-/g, "/");

    // ISO / timestamp
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("fr-FR");

    return s;
  }

  function _findChecklistRowById(idEffectifCompetence) {
    const id = (idEffectifCompetence || "").toString().trim();
    if (!id) return null;

    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return null;

    return Array.from(tbody.querySelectorAll("tr"))
      .find(r => (r.dataset.idEffectifCompetence || "").toString() === id) || null;
  }

  function _setRowAuditedVisual(tr) {
    if (!tr) return;

    const card = tr.querySelector(".ep-comp-card");
    if (card) card.classList.remove("ep-comp-card--never");

    const levelTxt = (document.getElementById("ep_levelABC")?.textContent || "").toString().trim();
    const levelBadge = tr.querySelector(".ep-comp-level-badge");

    if (levelBadge && levelTxt && levelTxt !== "—") {
      levelBadge.textContent = levelTxt;
      levelBadge.className = `sb-badge ep-comp-level-badge ${getEpLevelBadgeClass(levelTxt)}`;
    }
  }

  function _recalcKpiToDoFallbackFromDOM() {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll("tr"));
    const total = rows.length;

    const never = rows.filter(r => !!r.querySelector(".ep-comp-card--never")).length;

    setText("ep_compCount", String(total));
    setText("ep_kpiToDo", `${never} / ${total}`);
  }

  function _recalcKpiToDoPreferState() {
    const list = Array.isArray(state._checklistAll) ? state._checklistAll : null;
    if (!list) {
      _recalcKpiToDoFallbackFromDOM();
      return;
    }

    const total = list.length;
    const never = list.filter(x => !!x._neverAudited).length;

    setText("ep_compCount", String(total));
    setText("ep_kpiToDo", `${never} / ${total}`);
  }

  async function afterAuditSavedRefresh(savedApiResp) {
    // 1) Rafraîchir la jauge (couverture poste) sans attendre un changement de collaborateur
    state._covData = null;
    state._covLastKey = null;
    try {
      refreshCouverturePosteActuel(true);
    } catch (_) {
      // pas bloquant
    }

    // 2) Mettre à jour l’en-tête de la compétence (niveau + date dernière éval)
    const levelTxt = (document.getElementById("ep_levelABC")?.textContent || "").toString().trim();
    if (levelTxt && levelTxt !== "—") {
      setText("ep_compCurrent", levelTxt);
    }

    const apiDate = _formatDateFR(savedApiResp?.date_audit);
    const dateTxt = apiDate || new Date().toLocaleDateString("fr-FR");
    const lastEl = $("ep_compLastEval");
    if (lastEl) lastEl.textContent = `Dernière éval : ${dateTxt}`;

    // 3) Mettre à jour la checklist (state + visuel badge rouge)
    const idEc = (state.selectedEffectifCompetenceId || "").toString().trim();
    if (idEc) {
      if (Array.isArray(state._checklistAll)) {
        const it = state._checklistAll.find(x => String(x.id_effectif_competence || "") === idEc);
        if (it) {
          it._neverAudited = false;
          it.date_derniere_eval = dateTxt;
          if (levelTxt && levelTxt !== "—") it.niveau_actuel = levelTxt;
        }
      }

      const tr = _findChecklistRowById(idEc);
      _setRowAuditedVisual(tr);
    }

    if (idEc && state._entretienDraft && Array.isArray(state._entretienDraft.competences_entretien)) {
      const idComp = (state.selectedCompetenceId || "").toString().trim();

      state._entretienDraft.competences_entretien.forEach(item => {
        if (!item) return;

        const itemEc = (item.id_effectif_competence || "").toString().trim();
        const itemComp = (item.id_comp || "").toString().trim();

        const sameEffectifCompetence = itemEc && itemEc === idEc;
        const sameCompetenceWithoutEffectifLink = !itemEc && idComp && itemComp === idComp;

        if (!sameEffectifCompetence && !sameCompetenceWithoutEffectifLink) return;

        item.id_effectif_competence = idEc;
        item.date_derniere_eval = dateTxt;

        if (levelTxt && levelTxt !== "—") {
          item.niveau_actuel = levelTxt;
        }
      });
    }

    // 4) KPI “à faire” (jamais auditées)
    _recalcKpiToDoPreferState();

    // 5) Réappliquer filtres éventuels (recherche / slider selon ta version)
    try {
      if (typeof applyChecklistCriticiteFilter === "function") applyChecklistCriticiteFilter();
      else if (typeof filterChecklistRows === "function") filterChecklistRows();
    } catch (_) {
      // pas bloquant
    }
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
    const collabOk = scopeOk && !!state.selectedCollaborateurId;
    setDisabled("ep_btnReportPdf", !collabOk);

    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) txtSearchCollab.disabled = !scopeOk;

    const rngCrit = $("ep_rngCriticite");
    const rngCritVal = $("ep_rngCriticiteVal");

    if (rngCrit) rngCrit.disabled = !collabOk;

    if (!collabOk) {
      if (rngCrit) rngCrit.value = "0";
      if (rngCritVal) rngCritVal.textContent = "0";
    }


    for (let i = 1; i <= 4; i++) {
      setDisabled(`ep_critNote${i}`, true);
      setDisabled(`ep_critCom${i}`, true);
    }
    setDisabled("ep_selEvalMethod", true);
    setDisabled("ep_txtObservation", true);

    setDisabled("ep_btnSave", true);

    if (!scopeOk) setText("ep_ctxService", "—");

    // -------- Couverture poste actuel (jauge) --------
    bindCouverturePosteOnce();

    if (!collabOk) {
      resetCouverturePosteUI();
      return;
    }

    // Au moins, on affiche le bloc (sinon tu ne verras jamais le toggle)
    showCouverturePosteWrap("Calcul en cours…");

    // Recharge seulement si le collaborateur a changé
    const key = String(state.selectedCollaborateurId || "");
    if (state._covLastKey !== key) {
      state._covLastKey = key;
      state._covData = null;
      refreshCouverturePosteActuel(true);
    } else {
      // si déjà chargé, on re-render (ex: toggle)
      renderCouverturePoste();
    }
  }

  // ======================================================
  // Couverture poste actuel (jauge)
  // ======================================================
  function bindCouverturePosteOnce() {
    if (state._covBound) return;
    state._covBound = true;
  }

  function resetCouverturePosteUI() {
    const hint = $("ep_covHint");
    const wrap = $("ep_covWrap");
    const svg = $("ep_svgGauge");
    const pctPoste = $("ep_covPctPoste");
    const pctMax = $("ep_covPctMax");

    if (hint) {
      hint.style.display = "";
      hint.textContent = "La synthèse apparaîtra après sélection d'un collaborateur";
    }
    if (wrap) wrap.style.display = "none";
    if (svg) svg.innerHTML = "";
    if (pctPoste) pctPoste.textContent = "—";
    if (pctMax) pctMax.textContent = "—";
  }

  function showCouverturePosteWrap(message) {
    const hint = $("ep_covHint");
    const wrap = $("ep_covWrap");

    if (wrap) wrap.style.display = ""; // on affiche pour voir jauge + toggle

    if (hint) {
      if (message) {
        hint.style.display = "";
        hint.textContent = message;
      } else {
        hint.style.display = "none";
        hint.textContent = "";
      }
    }
  }

  function getCouvertureMode() {
    return "weighted";
  }

  function getEpCriticiteSeuil() {
    const rng = $("ep_rngCriticite");
    return Math.max(0, Math.min(100, getEpCritPctValue(rng?.value || 0)));
  }

  async function refreshCouverturePosteActuel(force) {
    if (!_portal) return;
    if (!state.selectedCollaborateurId) return;

    if (state._covLoading) return;
    if (!force && state._covData) return;

    state._covLoading = true;

    try {
      const params = new URLSearchParams();
      params.set("criticite_min", String(getEpCriticiteSeuil()));

      const url = `${_portal.apiBase}/skills/entretien-performance/couverture-poste-actuel/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}?${params.toString()}`;
      const data = await _portal.apiJson(url);

      state._covData = data || null;

      // OK => on masque le texte et on rend
      showCouverturePosteWrap("");
      renderCouverturePoste();

    } catch (e) {
      // On garde le bloc visible (toggle inclus), mais on affiche l’erreur.
      showCouverturePosteWrap("Impossible de calculer la couverture du poste actuel : " + String(e?.message || e));
      console.error("Couverture poste actuel:", e);

      // petite jauge vide pour éviter un “grand trou”
      const svg = $("ep_svgGauge");
      if (svg) {
        renderGauge(svg, 0, 100, 0);
      }
    } finally {
      state._covLoading = false;
    }
  }

  function renderCouverturePoste() {
    const data = state._covData;
    if (!data) return;

    const pack = data.weighted || data.plain || null;
    if (!pack) return;

    const svg = $("ep_svgGauge");
    if (!svg) return;

    const pctMaitrise = Number(pack.pct_attendus ?? NaN);

    if (!Number.isFinite(pctMaitrise)) {
      renderGauge(svg, 0, 100, 0);

      const pctPoste = $("ep_covPctPoste");
      const pctMaxEl = $("ep_covPctMax");

      if (pctPoste) pctPoste.textContent = "—";
      if (pctMaxEl) pctMaxEl.textContent = "—";
      return;
    }

    const pct = Math.max(0, Math.min(100, pctMaitrise));

    // Le chiffre affiché et l'aiguille utilisent strictement le même pourcentage.
    renderGauge(svg, 0, 100, pct);

    const pctPoste = $("ep_covPctPoste");
    const pctMaxEl = $("ep_covPctMax");

    if (pctPoste) pctPoste.textContent = `${Math.round(pct)}%`;
    if (pctMaxEl) pctMaxEl.textContent = "—";
  }

  function renderGauge(svg, gaugeMin, gaugeMax, value) {
    let gMin = Number(gaugeMin ?? 0);
    let gMax = Number(gaugeMax ?? 1);

    if (!Number.isFinite(gMin)) gMin = 0;
    if (!Number.isFinite(gMax)) gMax = 1;

    if (gMax < gMin) {
      const tmp = gMin;
      gMin = gMax;
      gMax = tmp;
    }

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const range = Math.max(1e-9, (gMax - gMin));

    const tFromValue = (v) => {
      const n = Number(v ?? gMin);
      return (clamp(Number.isFinite(n) ? n : gMin, gMin, gMax) - gMin) / range;
    };

    const angleFromT = (t) => 180 + (180 * t);

    const cx = 120;
    const cy = 120;
    const r = 90;
    const rNeedle = 74;

    const polar = (angleDeg, radius) => {
      const rad = (angleDeg * Math.PI) / 180;
      return {
        x: cx + (radius * Math.cos(rad)),
        y: cy + (radius * Math.sin(rad)),
      };
    };

    const arcPath = (a1, a2) => {
      if (a2 < a1) {
        const tmp = a1;
        a1 = a2;
        a2 = tmp;
      }

      const p1 = polar(a1, r);
      const p2 = polar(a2, r);
      const diff = Math.abs(a2 - a1);
      const large = (diff <= 180) ? "0" : "1";

      return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    };

    /*
      Même logique que la jauge dashboard :
      - rouge : zone basse
      - orange : zone intermédiaire
      - vert : zone conforme
      On n'affiche pas une progression partielle.
      On affiche une vraie jauge de lecture.
    */
    const a0 = angleFromT(0.0);
    const a1 = angleFromT(0.2);
    const a2 = angleFromT(0.5);
    const a3 = angleFromT(1.0);

    const aNeedle = angleFromT(tFromValue(value));
    const pNeedle = polar(aNeedle, rNeedle);

    svg.innerHTML = `
      <path d="${arcPath(180, 360)}"
            stroke="rgba(0,0,0,.10)"
            stroke-width="18"
            fill="none"
            stroke-linecap="round"></path>

      <path d="${arcPath(a0, a1)}"
            stroke="var(--accent)"
            stroke-width="16"
            fill="none"
            stroke-linecap="butt"></path>

      <path d="${arcPath(a1, a2)}"
            stroke="#f59e0b"
            stroke-width="16"
            fill="none"
            stroke-linecap="butt"></path>

      <path d="${arcPath(a2, a3)}"
            stroke="#16a34a"
            stroke-width="16"
            fill="none"
            stroke-linecap="butt"></path>

      <line x1="${cx}" y1="${cy}" x2="${pNeedle.x.toFixed(2)}" y2="${pNeedle.y.toFixed(2)}"
            stroke="rgba(0,0,0,.65)"
            stroke-width="3"
            stroke-linecap="round"></line>

      <circle cx="${cx}" cy="${cy}" r="6" fill="rgba(0,0,0,.65)"></circle>
    `;
  }

  async function loadBootstrap() {
    if (!_portal) return;

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/bootstrap/${encodeURIComponent(_portal.contactId)}`;
      const data = await _portal.apiJson(url);
      state.scoring = data?.scoring || null;
    } catch (e) {
      _portal.showAlert("error", "Erreur bootstrap : " + String(e?.message || e));
      console.error(e);
    }
  }

  async function loadServices() {
    if (!_portal) return;

    try {
      await _portal.serviceFilter.populateSelect({
        portal: _portal,
        contactId: _portal.contactId,
        selectId: "ep_selService",
        storageKey: LS_KEY_SERVICE,
        labelAll: "Tous les services",
        labelNonLie: "Non lié",
        includeAll: true,
        includeNonLie: true,
        allowIndent: true
      });

      _servicesLoaded = true;
      _servicesFlat = []; // plus utilisé ici (centralisé)
    } catch (e) {
      _portal.showAlert("error", "Impossible de charger la liste des services : " + String(e?.message || e));
      console.error(e);
      _servicesLoaded = false;
      _servicesFlat = [];
    }
  }


  function getCollaborateurPriority(c) {
    const raw = (c?.priorite_eval || "").toString().trim().toLowerCase();
    if (["high", "haute", "priorite", "priorité", "priorite_haute", "priorité haute"].includes(raw)) return "high";
    if (["plan", "planning", "a_planifier", "à planifier", "planifier"].includes(raw)) return "plan";
    if (["ok", "a_jour", "à jour", "done"].includes(raw)) return "ok";
    if (["none", "aucune", "empty"].includes(raw)) return "none";

    const total = Number(c?.nb_competences_total ?? 0);
    const never = Number(c?.nb_competences_jamais_auditees ?? 0);
    const months = Number(c?.mois_depuis_derniere_eval ?? 0);
    const last = (c?.date_derniere_eval || "").toString().trim();

    if (total <= 0) return "none";
    if (never > 0 || !last) return "high";
    if (Number.isFinite(months) && months >= 12) return "plan";
    return "ok";
  }

  function getCollaborateurPriorityRank(priority) {
    if (priority === "high") return 0;
    if (priority === "plan") return 1;
    if (priority === "ok") return 2;
    return 3;
  }

  function getEpLevelBadgeClass(label) {
    const v = (label || "").toString().trim().toLowerCase();

    if (!v || v === "—") return "sb-badge-niv";
    if (v.includes("initial") || v === "a") return "sb-badge-niv sb-badge-niv-a";
    if (v.includes("avancé") || v.includes("avance") || v === "b") return "sb-badge-niv sb-badge-niv-b";
    if (v.includes("expert") || v === "c") return "sb-badge-niv sb-badge-niv-c";

    return "sb-badge-niv";
  }  

  function renderCollaborateurs(list) {
    const wrap = $("ep_listCollaborateurs");
    if (!wrap) return;

    wrap.innerHTML = "";

    const arr = (Array.isArray(list) ? list : []).slice().sort((a, b) => {
      const pa = getCollaborateurPriority(a);
      const pb = getCollaborateurPriority(b);

      const ra = getCollaborateurPriorityRank(pa);
      const rb = getCollaborateurPriorityRank(pb);

      if (ra !== rb) return ra - rb;

      const na = `${(a?.nom_effectif || "").toString()} ${(a?.prenom_effectif || "").toString()}`.trim();
      const nb = `${(b?.nom_effectif || "").toString()} ${(b?.prenom_effectif || "").toString()}`.trim();

      return na.localeCompare(nb, "fr", { sensitivity: "base" });
    });

    setText("ep_collabCount", String(arr.length));

    wrap.classList.remove("sb-tree");
    wrap.classList.add("ep-collab-stack");

    arr.forEach(c => {
      const prenom = (c.prenom_effectif || "").toString().trim();
      const nom = (c.nom_effectif || "").toString().trim().toUpperCase();
      const name = `${nom} ${prenom}`.trim() || "Collaborateur";
      const poste = (c.intitule_poste || "Poste non renseigné").toString().trim();
      const priority = getCollaborateurPriority(c);

      const item = document.createElement("button");
      item.type = "button";
      item.className = `ep-collab-card ep-collab-card--${priority}`;
      item.dataset.priority = priority;
      item.title = poste ? `${name} - ${poste}` : name;

      const left = document.createElement("div");
      left.className = "ep-collab-card-main";

      const nameEl = document.createElement("div");
      nameEl.className = "ep-collab-card-name";
      nameEl.textContent = name;

      const roleEl = document.createElement("div");
      roleEl.className = "ep-collab-card-role";
      roleEl.textContent = poste;

      left.appendChild(nameEl);
      left.appendChild(roleEl);
      item.appendChild(left);

      item.addEventListener("click", async () => {
        // sélection visuelle
        wrap.querySelectorAll(".ep-collab-card.active").forEach(x => x.classList.remove("active"));
        item.classList.add("active");

        state.selectedCollaborateurId = c.id_effectif || null;
        state.selectedCompetenceId = null;

        // Progression : données dépendantes du collaborateur.
        // Sans reset, le modal garde la courbe du précédent collaborateur.
        state._progressData = null;
        state._progressVisible = {};
        state._progressLoadedKey = "";
        state._progressLoadingKey = "";

        const progWrap = $("ep_progTableWrap");
        const progCanvas = $("ep_progChart");

        if (progWrap) {
          progWrap.innerHTML = `<div class="ep-history-empty">Ouvre l’onglet Progression pour charger les données du collaborateur sélectionné.</div>`;
        }

        if (progCanvas) {
          const ctx = progCanvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, progCanvas.width, progCanvas.height);
        }

        clearCompetences();
        resetEvaluationPanel();

        if (!state.selectedCollaborateurId || !_portal) return;

        // ---- Couverture poste actuel (jauge) ----
        // On affiche tout de suite le bloc + le toggle, et on passe en "Calcul en cours…"
        bindCouverturePosteOnce();
        showCouverturePosteWrap("");

        // On force un recalcul à chaque changement de collaborateur
        state._covLastKey = null;
        state._covData = null;

        // Lance le calcul (asynchrone, ne bloque pas le reste du chargement)
        refreshCouverturePosteActuel(true);

        if ($("modalEpHistory")?.classList.contains("show") && $("ep_histPanelProgression")?.classList.contains("is-active")) {
          loadProgressionData();
        }


        try {
          _portal.showAlert("", "");


          // Date entretien = date du clic (pour l’instant)
          setText("ep_ctxDate", new Date().toLocaleDateString("fr-FR"));

          // Contexte réel + checklist compétences
          const url = `${_portal.apiBase}/skills/entretien-performance/effectif-checklist/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
          const data = await _portal.apiJson(url);

          const eff = data?.effectif || null;

          // ---- Contexte (service réel + matricule) ----
          if (eff) {
            // service réel du collaborateur (sert pour charger le détail référentiel)
            state.selectedCollaborateurServiceId = (eff.id_service || "").toString().trim();

            const prenom = (eff.prenom_effectif || "").toString().trim();
            const nom = (eff.nom_effectif || "").toString().trim();
            setText("ep_ctxCollaborateur", `${prenom} ${nom}`.trim() || "—");

            setText("ep_ctxMatricule", (eff.matricule_interne || "").toString().trim() || "—");
            setText("ep_ctxPoste", (eff.intitule_poste || "").toString().trim() || "—");

            const svc = (eff.nom_service || eff.id_service || "").toString().trim();
            setText("ep_ctxService", svc || "—");
          } else {
            state.selectedCollaborateurServiceId = "";

            // fallback si jamais l’API ne renvoie pas le contexte
            setText("ep_ctxCollaborateur", name || "—");
            setText("ep_ctxMatricule", "—");
            setText("ep_ctxPoste", "—");
            setText("ep_ctxService", "—");
          }


          // ---- Checklist table (compact) ----
          const tbody = $("ep_tblCompetences")?.querySelector("tbody");
          if (tbody) tbody.innerHTML = "";

          let list = Array.isArray(data?.competences) ? data.competences : [];

          // flag "jamais audité" = date_derniere_eval null
          list = list.map(x => ({
            ...x,
            _neverAudited: !x.date_derniere_eval
          }));

          // Bonus: tri => jamais audité en haut, puis code
          list.sort((a, b) => {
            const na = a._neverAudited ? 1 : 0;
            const nb = b._neverAudited ? 1 : 0;
            if (na !== nb) return nb - na; // 1 avant 0
            return String(a.code || "").localeCompare(String(b.code || ""), "fr", { sensitivity: "base" });
          });

          // On garde la liste complète en mémoire pour recalculer les KPI après filtrage
          state._checklistAll = list;

          // Valeurs provisoires, recalculées juste après rendu par applyChecklistCriticiteFilter()
          setText("ep_compCount", String(list.length));
          setText("ep_kpiToDo", `0 / ${list.length}`);

          // (les autres KPI restent à 0 pour l’instant, on les fera quand on sauvegardera des audits)
          setText("ep_kpiDone", "0");
          setText("ep_kpiChanged", "0");
          setText("ep_kpiReview", "0");

          list.forEach(x => {

            const tr = document.createElement("tr");
            tr.dataset.idEffectifCompetence = x.id_effectif_competence || "";
            tr.dataset.idComp = x.id_comp || "";
            const _pct = getEpCritPctValue(x?.poids_criticite_pct);
            tr.dataset.critPct = String(_pct);



            // Col: carte compétence compacte
            // Ligne = badge compétence + titre + niveau + bouton évaluer
            const tdComp = document.createElement("td");

            const rowWrap = document.createElement("div");
            rowWrap.className = "ep-comp-card";
            if (x._neverAudited) rowWrap.classList.add("ep-comp-card--never");

            const top = document.createElement("div");
            top.className = "ep-comp-card-top";

            const badge = document.createElement("span");
            badge.className = "sb-badge sb-badge-ref-comp-code ep-comp-code";
            badge.textContent = (x.code || "").toString().trim();

            const title = document.createElement("span");
            title.className = "ep-comp-title";
            title.textContent = (x.intitule || "").toString().trim();
            title.title = title.textContent;

            const niveau = (x.niveau_actuel || "").toString().trim();
            const levelBadge = document.createElement("span");
            levelBadge.className = `sb-badge ep-comp-level-badge ${getEpLevelBadgeClass(niveau)}`;
            levelBadge.textContent = niveau || "—";
            levelBadge.title = "Niveau actuel";

            const iconEdit = `
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
              </svg>
            `;

            const btnEdit = document.createElement("button");
            btnEdit.type = "button";
            btnEdit.className = "sb-icon-btn ep-comp-edit-btn";
            btnEdit.title = "Évaluer la compétence";
            btnEdit.setAttribute("aria-label", "Évaluer la compétence");
            btnEdit.innerHTML = iconEdit;

            btnEdit.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              tr.click();
            });

            top.appendChild(badge);
            top.appendChild(title);
            top.appendChild(levelBadge);
            top.appendChild(btnEdit);

            rowWrap.appendChild(top);
            tdComp.appendChild(rowWrap);

            tr.appendChild(tdComp);

            // ---- CLIC COMPETENCE ----
            tr.addEventListener("click", async () => {
              // sélection visuelle
              const tb = $("ep_tblCompetences")?.querySelector("tbody");
              if (tb) tb.querySelectorAll("tr.active").forEach(r => r.classList.remove("active"));
              tr.classList.add("active");

              state.selectedCompetenceId = x.id_comp || null;
              state.selectedEffectifCompetenceId = x.id_effectif_competence || null;

              state._entretienAuditContext = null;              
              state._historyAuditEditing = null;

              const evalModal = $("modalEpEvaluation");
              if (evalModal) evalModal.classList.remove("is-history-readonly", "is-history-editable");

              clearSaveInlineMsg();
              openModal("modalEpEvaluation");

              // En-tête évaluation
              setText("ep_evalHint", "Évaluation en cours.");
              renderEvalCompetenceTitle(x.code, x.intitule);
              renderEvalDomainBadge("", "");

              // reset champs saisie
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

              // charge le détail compétence via l’API existante du référentiel (on ne réinvente rien)
              try {
                if (!_portal) return;

                // cache léger
                state._compDetailCache = state._compDetailCache || {};
                let detail = state._compDetailCache[x.id_comp];

                if (!detail) {
                  // service réel du collaborateur si dispo, sinon fallback sur service filtre
                  const id_service = (state.selectedCollaborateurServiceId || state.serviceId || "").toString().trim();
                  if (!id_service) throw new Error("Service introuvable pour charger le détail de compétence.");

                  const url = `${_portal.apiBase}/skills/referentiel/competence/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id_service)}/${encodeURIComponent(x.id_comp)}`;
                  detail = await _portal.apiJson(url);
                  state._compDetailCache[x.id_comp] = detail;
                }

                const comp = detail?.competence || {};
                const grid = comp?.grille_evaluation || null;

                // Domaine : badge standard domaine avec rond couleur + fond soft + bordure couleur
                const dom = comp?.domaine || null;

                const domLabel = dom
                  ? (dom.titre_court || dom.titre || dom.id_domaine_competence || "")
                  : (x.domaine || "");

                renderEvalDomainBadge(domLabel, dom?.couleur || "");


                // Critères: on prend jusqu’à 4 critères renseignés
                const keys = (grid && typeof grid === "object") ? Object.keys(grid) : [];
                const sortKey = (k) => {
                  const m = String(k).match(/(\d+)/);
                  return m ? parseInt(m[1], 10) : 999;
                };
                const ordered = keys.slice().sort((a, b) => sortKey(a) - sortKey(b));

                let nbEnabled = 0;

                for (let i = 1; i <= 4; i++) {
                const key = ordered[i - 1];
                const c = key ? (grid[key] || {}) : null;

                const nom = c ? (c.Nom ?? c.nom ?? "").toString().trim() : "";
                const evalsRaw = c ? (Array.isArray(c.Eval || c.eval) ? (c.Eval || c.eval) : []) : [];

                // On garde les 4 textes pour le popover…
                const evalsAll = (evalsRaw || []).map(v => (v ?? "").toString().trim());
                // …mais pour décider si le critère existe, on ne compte que les textes non vides
                const evalsNonEmpty = evalsAll.filter(v => v.length > 0);

                const enabled = !!key && (nom.length > 0 || evalsNonEmpty.length > 0);

                const labelEl = $(`ep_critLabel${i}`);
                const noteId = `ep_critNote${i}`;
                const comId  = `ep_critCom${i}`;

                // Ligne (tr) pour masquer/afficher
                const tr = labelEl ? labelEl.closest("tr") : null;
                if (tr) tr.style.display = enabled ? "" : "none";

                // Si critère vide -> on bloque tout et on nettoie
                if (!enabled) {
                    if (labelEl) labelEl.textContent = "";
                    const sel = $(noteId);
                    if (sel) sel.value = "";
                    const com = $(comId);
                    if (com) com.value = "";

                    setDisabled(noteId, true);
                    setDisabled(comId, true);
                    continue;
                }

                // Label + bouton aide ⓘ propre
                const labelText = (nom || key || "").toString().trim();

                if (labelEl) {
                    labelEl.innerHTML = "";

                    const spanTxt = document.createElement("span");
                    spanTxt.textContent = labelText;
                    labelEl.appendChild(spanTxt);

                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "ep-crit-help";
                    btn.textContent = "i";
                    btn.title = "Guide de notation";
                    btn.setAttribute("aria-label", "Guide de notation");

                    // Style minimal, propre, lisible (pas la bordure de tracteur)
                    btn.style.marginLeft = "10px";
                    btn.style.width = "22px";
                    btn.style.height = "22px";
                    btn.style.borderRadius = "999px";
                    btn.style.border = "1px solid #d1d5db";
                    btn.style.background = "#fff";
                    btn.style.color = "#111";
                    btn.style.fontWeight = "700";
                    btn.style.fontSize = "13px";
                    btn.style.lineHeight = "20px";
                    btn.style.padding = "0";
                    btn.style.cursor = "pointer";

                    btn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const sel = $(noteId);
                    const selectedNote = sel ? (sel.value || "") : "";
                    openGuidePopover(btn, i, labelText, evalsAll, selectedNote);
                    });

                    labelEl.appendChild(btn);
                }

                setDisabled(noteId, false);
                setDisabled(comId, false);

                nbEnabled += 1;
                }



                // Affichage résultat (le calcul reste interne sur 24, l'utilisateur voit une maîtrise %)
                setText("ep_scoreRaw", "—");
                setText("ep_scorePct", "—");
                setText("ep_levelABC", "—");

                // Déverrouillage global
                setDisabled("ep_selEvalMethod", false);
                setDisabled("ep_txtObservation", false);

                setDisabled("ep_btnSave", false);

              } catch (e) {
                _portal && _portal.showAlert("error", "Détail compétence", String(e?.message || e));
              }
            });

            if (tbody) tbody.appendChild(tr);
          });



          // Slider criticité activé + filtre appliqué
          bindCriticiteSliderOnce();

          const rngCrit = $("ep_rngCriticite");
          const rngCritVal = $("ep_rngCriticiteVal");

          if (rngCrit) {
            rngCrit.disabled = false;

            // Reprend le seuil mémorisé si déjà défini, sinon conserve la valeur courante
            const seuil = (typeof state._critSeuil === "number")
              ? state._critSeuil
              : Number(rngCrit.value || 0);

            rngCrit.value = String(Math.max(0, Math.min(100, seuil)));
          }

          if (rngCritVal) {
            rngCritVal.textContent = String(Number(rngCrit?.value || 0));
          }

          applyChecklistCriticiteFilter();




        } catch (e) {
          _portal.showAlert("error", "Checklist collaborateur : " + String(e?.message || e));
          console.error(e);
          clearCompetences();
          setText("ep_compCount", "0");
        }
      });


      wrap.appendChild(item);
    });
  }

  function getEpCritPctValue(value) {
    const raw = (value ?? "0").toString().trim().replace(",", ".");
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function scheduleCouverturePosteRefresh() {
    if (!state.selectedCollaborateurId) return;

    if (state._covRefreshTimer) clearTimeout(state._covRefreshTimer);

    state._covRefreshTimer = setTimeout(() => {
      state._covData = null;
      state._covLastKey = null;
      refreshCouverturePosteActuel(true);
    }, 220);
  }

  function bindCriticiteSliderOnce() {
    const rng = $("ep_rngCriticite");
    if (!rng) return;

    if (state._critBound) return;
    state._critBound = true;

    rng.addEventListener("input", () => {
      applyChecklistCriticiteFilter();
      scheduleCouverturePosteRefresh();

      if ($("modalEpHistory")?.classList.contains("show")) {
        state._progressData = null;
        if ($("ep_histPanelProgression")?.classList.contains("is-active")) {
          loadProgressionData();
        }
      }
    });
  }

  function applyChecklistCriticiteFilter() {
    const rng = $("ep_rngCriticite");
    const valEl = $("ep_rngCriticiteVal");
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!rng || !tbody) return;

    const seuil = Math.max(0, Math.min(100, Number(rng.value || 0)));
    state._critSeuil = seuil;
    if (valEl) valEl.textContent = String(seuil);

    const EPS = 0.0001;

    // Filtrage DOM : seuil inclusif, donc 75 affiche bien 75.
    Array.from(tbody.querySelectorAll("tr")).forEach(tr => {
      const pct = getEpCritPctValue(tr.dataset.critPct);
      tr.style.display = (pct + EPS >= seuil) ? "" : "none";
    });

    // Compteurs / KPI basés sur la liste complète en mémoire
    const all = Array.isArray(state._checklistAll) ? state._checklistAll : [];
    const filtered = all.filter(x => getEpCritPctValue(x?.poids_criticite_pct) + EPS >= seuil);

    const total = all.length;
    const shown = filtered.length;
    const todo = filtered.filter(x => x._neverAudited).length;

    // Affiche "X / Y" pour que l’utilisateur comprenne le filtre
    setText("ep_compCount", total ? `${shown} / ${total}` : "0");
    setText("ep_kpiToDo", `${todo} / ${shown}`);

    // Si la compétence sélectionnée vient d'être masquée -> on reset
    const active = tbody.querySelector("tr.active");
    if (active && active.style.display === "none") {
      active.classList.remove("active");
      state.selectedCompetenceId = null;
      state.selectedEffectifCompetenceId = null;
      resetEvaluationPanel();
    }
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
      _portal.showAlert("error", "Impossible de charger les collaborateurs : " + String(e?.message || e));
      console.error(e);
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

  function bindPriorityHelpOnce() {
    const btn = $("ep_btnPriorityHelp");
    const pop = $("ep_priorityHelpPop");

    if (!btn || !pop || state._priorityHelpBound) return;

    state._priorityHelpBound = true;

    const close = () => {
      pop.classList.remove("is-open");
      pop.setAttribute("aria-hidden", "true");
    };

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const opened = pop.classList.toggle("is-open");
      pop.setAttribute("aria-hidden", opened ? "false" : "true");
    });

    document.addEventListener("click", (ev) => {
      if (!pop.classList.contains("is-open")) return;
      const target = ev.target;
      if (target === btn || btn.contains(target) || pop.contains(target)) return;
      close();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });

    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
  }

  async function resetScope() {
    state.serviceId = window.portal.serviceFilter.ALL_ID;
    state.population = "team";
    state.selectedCollaborateurId = null;
    state.selectedCompetenceId = null;

    const selService = $("ep_selService");
    if (selService) selService.value = window.portal.serviceFilter.ALL_ID;

    const selPop = $("ep_selPopulation");
    if (selPop) selPop.value = "team";

    const chkFocus = $("ep_chkFocus");
    if (chkFocus) chkFocus.checked = false;
    state.focusMode = false;
    applyFocusMode();

    await onScopeChanged();
  }

  function epSetInlineMsg(id, type, text) {
    const msg = $(id);
    if (!msg) return;

    msg.textContent = text || "";
    msg.classList.remove(
      "is-visible",
      "sb-inline-msg--success",
      "sb-inline-msg--info",
      "sb-inline-msg--danger"
    );

    if (!text) return;

    msg.classList.add("is-visible", `sb-inline-msg--${type || "info"}`);
  }

  function epGetValue(id) {
    return ($(id)?.value || "").toString().trim();
  }

  function epHumanizeJsonKey(key) {
    const k = (key || "").toString().trim();

    const labels = {
      missions: "Missions",
      reussites: "Réussites",
      difficultes: "Difficultés",
      contexte: "Organisation / conditions de travail",

      objectifs: "Objectifs",
      indicateurs: "Indicateurs / attendus",
      moyens: "Moyens nécessaires",
      echeances: "Échéances",

      besoins_formation: "Besoins de formation",
      souhaits: "Souhaits du collaborateur",
      evolution: "Évolution / mobilité",
      accompagnement: "Accompagnement",

      actions: "Actions",
      references: "Documents"
    };

    if (labels[k]) return labels[k];

    return k
      .replaceAll("_", " ")
      .replace(/^\p{L}/u, c => c.toUpperCase());
  }

  function epTextFromValue(value) {
    if (value === null || value === undefined) return "";

    if (typeof value === "string") {
      return value === "[object Object]" ? "" : value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value
        .map(v => epTextFromValue(v))
        .map(v => v.trim())
        .filter(Boolean)
        .join("\n");
    }

    if (typeof value === "object") {
      return Object.entries(value)
        .map(([key, val]) => {
          const txt = epTextFromValue(val).trim();
          if (!txt) return "";
          return `${epHumanizeJsonKey(key)} : ${txt}`;
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  function epSetValue(id, value) {
    const el = $(id);
    if (!el) return;

    el.value = epTextFromValue(value);
  }

  function epTodayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function epCurrentCollabName() {
    const v = ($("ep_ctxCollaborateur")?.textContent || "").toString().trim();
    return v && v !== "—" ? v : "Collaborateur sélectionné";
  }

  function epSetEntretienTab(panel) {
    const p = panel || "preparation";

    document.querySelectorAll("#modalEpEntretien .ep-entretien-tab").forEach(btn => {
      btn.classList.toggle("is-active", (btn.dataset.panel || "") === p);
    });

    const map = {
      preparation: "ep_entretienPanelPreparation",
      competences: "ep_entretienPanelCompetences",
      realisation: "ep_entretienPanelRealisation",
      documents: "ep_entretienPanelDocuments",
    };

    Object.entries(map).forEach(([key, id]) => {
      const el = $(id);
      if (el) el.classList.toggle("is-active", key === p);
    });
  }

  function epDefaultEntretienDraft() {
    return {
      id_entretien: "",
      type_entretien: "Entretien individuel",
      statut: "à réaliser",
      date_prevue: epTodayIso(),
      date_realisee: "",
      periode_debut: "",
      periode_fin: "",
      preparation: {
        notes: "",
        points: "",
      },
      realisation: {
        bilan: "",
        objectifs: "",
        developpement: "",
        plan_actions: "",
      },
      competences_entretien: [],
      documents: {},
      synthese: {
        manager: "",
        collaborateur: "",
      },
      nb_documents: 0,
    };
  }

  function epBuildCompetenceItem(x, role) {
    return {
      id_comp: (x.id_comp || "").toString().trim(),
      id_effectif_competence: (x.id_effectif_competence || "").toString().trim(),
      code: (x.code || "").toString().trim(),
      intitule: (x.intitule || "").toString().trim(),
      domaine: (x.domaine || "").toString().trim(),
      niveau_actuel: (x.niveau_actuel || "").toString().trim(),
      date_derniere_eval: (x.date_derniere_eval || "").toString().trim(),
      poids_criticite_pct: Number(x.poids_criticite_pct || 0),
      role,
      selectionnee: role === "poste",
      motif: "",
    };
  }

  function epMergeEntretienCompetences(base, existing) {
    const map = new Map();

    (Array.isArray(base) ? base : []).forEach(x => {
      if (x.id_comp) map.set(`${x.role}|${x.id_comp}`, x);
    });

    (Array.isArray(existing) ? existing : []).forEach(x => {
      if (!x || !x.id_comp) return;

      const role = x.role || "poste";
      const key = `${role}|${x.id_comp}`;
      const current = map.get(key) || {};

      map.set(key, {
        ...current,
        ...x,
        role,
        selectionnee: x.selectionnee !== false,
      });
    });

    return Array.from(map.values());
  }

  function epPrepareEntretienDraft(entretien) {
    const d = entretien ? JSON.parse(JSON.stringify(entretien)) : epDefaultEntretienDraft();

    d.preparation = d.preparation || {};
    d.realisation = d.realisation || {};
    d.documents = d.documents || {};
    d.synthese = d.synthese || {};

    const all = Array.isArray(state._checklistAll) ? state._checklistAll : [];

    const competencesPoste = all
      .filter(x => Number(x.poids_criticite_pct || 0) > 0)
      .map(x => epBuildCompetenceItem(x, "poste"));

    const competencesHorsPoste = all
      .filter(x => Number(x.poids_criticite_pct || 0) <= 0)
      .map(x => epBuildCompetenceItem(x, "detenue_hors_poste"));

    d.competences_entretien = epMergeEntretienCompetences(
      [...competencesPoste, ...competencesHorsPoste],
      d.competences_entretien || []
    );

    return d;
  }

  function fillEntretienModal(entretien) {
    const d = epPrepareEntretienDraft(entretien || null);

    state._entretienDraft = d;
    state.selectedEntretienId = d.id_entretien || null;

    epSetValue("ep_entretienId", d.id_entretien || "");
    epSetValue("ep_entretienType", d.type_entretien || "Entretien individuel");
    epSetValue("ep_entretienStatut", d.statut || "à réaliser");
    epSetValue("ep_entretienDatePrevue", d.date_prevue || epTodayIso());
    epSetValue("ep_entretienDateRealisee", d.date_realisee || "");
    epSetValue("ep_entretienPeriodeDebut", d.periode_debut || "");
    epSetValue("ep_entretienPeriodeFin", d.periode_fin || "");

    epSetValue("ep_entretienPrepNotes", d.preparation?.notes || "");
    epSetValue("ep_entretienPrepPoints", d.preparation?.points || "");

    epSetValue("ep_entretienBilan", d.realisation?.bilan || "");
    epSetValue("ep_entretienObjectifs", d.realisation?.objectifs || "");
    epSetValue("ep_entretienDeveloppement", d.realisation?.developpement || "");
    epSetValue("ep_entretienPlanActions", d.realisation?.plan_actions || "");

    epSetValue("ep_entretienSyntheseManager", d.synthese?.manager || "");
    epSetValue("ep_entretienSyntheseCollaborateur", d.synthese?.collaborateur || "");

    setText("ep_entretienModalTitle", d.id_entretien ? (d.type_entretien || "Entretien individuel") : "Préparer un entretien individuel");
    setText("ep_entretienModalSub", epCurrentCollabName());

    epSetInlineMsg("ep_entretienMsg", "info", "");
    epSetEntretienTab("preparation");
    epRenderEntretienCompetences();
    epLoadEntretienDocuments();
  }

  function buildEntretienPayload(statutOverride) {
    const d = state._entretienDraft || epDefaultEntretienDraft();

    return {
      type_entretien: epGetValue("ep_entretienType") || "Entretien individuel",
      statut: statutOverride || epGetValue("ep_entretienStatut") || "à réaliser",
      date_prevue: epGetValue("ep_entretienDatePrevue") || null,
      date_realisee: epGetValue("ep_entretienDateRealisee") || null,
      periode_debut: epGetValue("ep_entretienPeriodeDebut") || null,
      periode_fin: epGetValue("ep_entretienPeriodeFin") || null,

      preparation: {
        notes: epGetValue("ep_entretienPrepNotes"),
        points: epGetValue("ep_entretienPrepPoints"),
      },

      realisation: {
        bilan: epGetValue("ep_entretienBilan"),
        objectifs: epGetValue("ep_entretienObjectifs"),
        developpement: epGetValue("ep_entretienDeveloppement"),
        plan_actions: epGetValue("ep_entretienPlanActions"),
      },

      competences_entretien: Array.isArray(d.competences_entretien) ? d.competences_entretien : [],
      documents: d.documents || {},

      synthese: {
        manager: epGetValue("ep_entretienSyntheseManager"),
        collaborateur: epGetValue("ep_entretienSyntheseCollaborateur"),
      },
    };
  }

  function epRenderEntretienCompetences() {
    const d = state._entretienDraft;
    if (!d) return;

    const seuil = Number($("ep_entretienCriticite")?.value || 0);
    const val = $("ep_entretienCriticiteVal");
    if (val) val.textContent = String(seuil);

    const renderList = (id, role) => {
      const wrap = $(id);
      if (!wrap) return;

      const list = (d.competences_entretien || [])
        .filter(x => x.role === role)
        .filter(x => role !== "poste" || Number(x.poids_criticite_pct || 0) >= seuil);

      if (!list.length) {
        wrap.innerHTML = `<div class="ep-entretien-empty">Aucune compétence</div>`;
        return;
      }

      wrap.innerHTML = "";

      list.forEach(item => {
        const row = document.createElement("div");
        row.className = "ep-entretien-comp-row";

        const checked = item.selectionnee !== false;
        const niveau = (item.niveau_actuel || "").toString().trim();

        row.innerHTML = `
          <label class="ep-entretien-comp-main">
            <input type="checkbox" data-check="1" ${checked ? "checked" : ""} />
            <span class="sb-badge sb-badge-ref-comp-code">${epEsc(item.code || "—")}</span>
            <span class="ep-entretien-comp-title" title="${epEsc(item.intitule || "")}">${epEsc(item.intitule || "—")}</span>
          </label>

          <div class="ep-entretien-comp-meta">
            ${role === "poste" ? `<span class="sb-badge">${Math.round(Number(item.poids_criticite_pct || 0))}%</span>` : ""}
            ${niveau ? `<span class="sb-badge ${getEpLevelBadgeClass(niveau)}">${epEsc(niveau)}</span>` : ""}
            ${checked ? `
            ${item.source === "catalogue" ? `
              <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-remove="1" title="Retirer" aria-label="Retirer">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18"></path>
                  <path d="M8 6V4h8v2"></path>
                  <path d="M19 6l-1 14H6L5 6"></path>
                </svg>
              </button>
            ` : ""}
              <button type="button" class="sb-icon-btn ep-entretien-eval-btn" data-eval="1" title="Évaluer" aria-label="Évaluer">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
              </button>
            ` : ""}
          </div>
        `;

        row.querySelector('[data-check="1"]')?.addEventListener("change", (ev) => {
          item.selectionnee = !!ev.target.checked;
          epRenderEntretienCompetences();
        });

        row.querySelector('[data-remove="1"]')?.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          d.competences_entretien = (d.competences_entretien || []).filter(x => x !== item);
          epRenderEntretienCompetences();
        });

        row.querySelector('[data-eval="1"]')?.addEventListener("click", async () => {
          await epOpenEvaluationFromEntretien(item);
        });

        wrap.appendChild(row);
      });
    };

    renderList("ep_entretienCompPoste", "poste");
    renderList("ep_entretienCompHorsPoste", "detenue_hors_poste");
    renderList("ep_entretienCompDevelop", "a_developper");
  }

  function openEntretienModal(entretien) {
    if (!state.selectedCollaborateurId) {
      _portal && _portal.showAlert("warning", "Sélectionne un collaborateur.");
      return;
    }

    fillEntretienModal(entretien || null);
    openModal("modalEpEntretien");
  }

  async function saveEntretienOnly(statutOverride) {
    if (!state.selectedCollaborateurId || !_portal) {
      throw new Error("Sélectionne un collaborateur.");
    }

    const idEntretien = epGetValue("ep_entretienId");
    const payload = buildEntretienPayload(statutOverride);
    const isUpdate = !!idEntretien;

    const url = isUpdate
      ? `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}`
      : `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;

    const saved = await _portal.apiJson(url, {
      method: isUpdate ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    fillEntretienModal(saved);
    await loadEntretiensIndividuels();
    return saved;
  }

  async function epRefreshEntretienAfterValidation(message) {
    const idEntretien = epGetValue("ep_entretienId");

    if (idEntretien && _portal) {
      const refreshed = await _portal.apiJson(
        `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}`
      );
      fillEntretienModal(refreshed);
    }

    epSetInlineMsg("ep_entretienMsg", "success", message || "Entretien enregistré");
    await loadEntretiensIndividuels();
  }

  async function openEntretienValidationFlow() {
    if (!state.selectedCollaborateurId || !_portal) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Sélectionne un collaborateur.");
      return;
    }

    const statut = (epGetValue("ep_entretienStatut") || "").toLowerCase().trim();
    if (["à signer 1/2", "a signer 1/2", "terminé", "termine"].includes(statut)) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Entretien déjà engagé dans le circuit de signature : modification bloquée.");
      return;
    }

    if (!window.NovoskillValidationElectronique || typeof window.NovoskillValidationElectronique.open !== "function") {
      epSetInlineMsg("ep_entretienMsg", "danger", "Composant de validation électronique indisponible.");
      return;
    }

    const evaluatorName = (document.getElementById("topbarName")?.textContent || "").trim() || "Évaluateur";

    try {
      await window.NovoskillValidationElectronique.open({
        apiBase: _portal.apiBase,
        apiJson: _portal.apiJson,
        contactId: _portal.contactId,
        documentId: epGetValue("ep_entretienId"),
        typeDocument: "entretien_individuel",
        typeSignataire: "evaluateur",
        signataireName: evaluatorName,
        title: "Validation électronique de l’entretien",
        subtitle: `Évaluateur : ${evaluatorName}`,
        saveDocument: async (statutSignature) => saveEntretienOnly(statutSignature || "à signer 2/2"),
        payloadValidation: {
          source: "insights",
          workflow: "entretien_individuel",
        },
        onLater: async () => {
          await epRefreshEntretienAfterValidation("Entretien enregistré — signature à finaliser");
        },
        onSigned: async () => {
          await epRefreshEntretienAfterValidation("Entretien enregistré et validation électronique enregistrée");
        },
      });
    } catch (e) {
      const raw = String(e?.message || e || "").replace(/^Erreur serveur\s*:\s*/i, "").trim();
      epSetInlineMsg("ep_entretienMsg", "danger", raw || "Erreur lors de l'ouverture de la validation électronique.");
    }
  }

  function openEntretienPdf(idEntretien) {
    const id = (idEntretien || epGetValue("ep_entretienId") || "").toString().trim();

    if (!id || !_portal) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Enregistre l'entretien avant de générer le rapport.");
      return;
    }

    const url = `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}/rapport-pdf`;
    const win = window.open(url, "_blank", "noopener");

    if (!win) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Le navigateur a bloqué l'ouverture du PDF.");
    }
  }

  async function loadEntretiensIndividuels() {
    const wrap = $("ep_entretienList");
    if (!state.selectedCollaborateurId || !_portal) {
      if (wrap) wrap.innerHTML = `<div class="ep-history-empty">Sélectionne un collaborateur.</div>`;
      return [];
    }

    if (wrap) wrap.innerHTML = `<div class="ep-history-empty">Chargement…</div>`;

    const url = `${_portal.apiBase}/skills/entretien-performance/entretiens/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
    const data = await _portal.apiJson(url);

    state._entretiensList = Array.isArray(data) ? data : [];
    renderEntretiensIndividuels(state._entretiensList);

    return state._entretiensList;
  }

  function renderEntretiensIndividuels(list) {
    const wrap = $("ep_entretienList");
    if (!wrap) return;

    const arr = Array.isArray(list) ? list : [];

    if (!arr.length) {
      wrap.innerHTML = `<div class="ep-history-empty">Aucun entretien individuel.</div>`;
      return;
    }

    wrap.innerHTML = "";

    arr.forEach(entretien => {
      const card = document.createElement("div");
      card.className = "ep-entretien-row";

      const dateTxt = entretien.date_realisee || entretien.date_prevue || entretien.created_at || "—";
      const statut = entretien.statut || "à réaliser";
      const statusClass = statut
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      card.innerHTML = `
        <div class="ep-entretien-row-main">
          <div class="ep-entretien-row-title">${epEsc(entretien.type_entretien || "Entretien individuel")}</div>
          <div class="ep-entretien-row-sub">${epEsc(epFormatDateFR(dateTxt))}</div>
        </div>

        <div class="ep-entretien-row-actions">
          <span class="sb-badge ep-entretien-status ep-entretien-status--${epEsc(statusClass)}">${epEsc(statut)}</span>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="open">Ouvrir</button>
          <button type="button" class="sb-icon-btn sb-icon-btn--doc" data-act="pdf" title="Rapport PDF" aria-label="Rapport PDF">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <path d="M14 2v6h6"></path>
            </svg>
          </button>
        </div>
      `;

      card.querySelector('[data-act="open"]')?.addEventListener("click", () => {
        openEntretienModal(entretien);
      });

      card.querySelector('[data-act="pdf"]')?.addEventListener("click", () => {
        openEntretienPdf(entretien.id_entretien);
      });

      wrap.appendChild(card);
    });
  }

  function epCatalogueUiForRole(role) {
    if (role === "detenue_hors_poste") {
      return {
        boxId: "ep_addCompHorsPosteBox",
        inputId: "ep_entretienCatalogueHorsPosteSearch",
        resultsId: "ep_entretienCatalogueHorsPosteResults",
        role: "detenue_hors_poste"
      };
    }

    return {
      boxId: "ep_addCompDevelopBox",
      inputId: "ep_entretienCatalogueDevelopSearch",
      resultsId: "ep_entretienCatalogueDevelopResults",
      role: "a_developper"
    };
  }

  function epToggleCatalogueBox(role) {
    const ui = epCatalogueUiForRole(role);
    const box = $(ui.boxId);
    const input = $(ui.inputId);
    const results = $(ui.resultsId);

    if (!box) return;

    const isOpen = box.style.display !== "none";
    box.style.display = isOpen ? "none" : "";

    if (results) results.innerHTML = "";
    if (input) {
      input.value = "";
      if (!isOpen) input.focus();
    }
  }

  async function epSearchCatalogueForRole(role) {
    const ui = epCatalogueUiForRole(role);
    const wrap = $(ui.resultsId);
    if (!wrap || !_portal) return;

    const q = epGetValue(ui.inputId);
    if (!q || q.length < 2) {
      wrap.innerHTML = "";
      return;
    }

    const url = `${_portal.apiBase}/skills/entretien-performance/catalogue-competences/${encodeURIComponent(_portal.contactId)}?q=${encodeURIComponent(q)}&limit=20`;
    const data = await _portal.apiJson(url);
    const list = Array.isArray(data) ? data : [];

    if (!list.length) {
      wrap.innerHTML = `<div class="ep-entretien-empty">Aucun résultat</div>`;
      return;
    }

    wrap.innerHTML = "";

    list.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ep-entretien-catalogue-item";
      btn.innerHTML = `
        <span class="sb-badge sb-badge-ref-comp-code">${epEsc(c.code || "—")}</span>
        <span>${epEsc(c.intitule || "—")}</span>
      `;

      btn.addEventListener("click", () => {
        const d = state._entretienDraft || epDefaultEntretienDraft();
        state._entretienDraft = d;

        d.competences_entretien = Array.isArray(d.competences_entretien)
          ? d.competences_entretien
          : [];

        const exists = d.competences_entretien.some(x =>
          x.role === ui.role && x.id_comp === c.id_comp
        );

        if (!exists) {
          d.competences_entretien.push({
            id_comp: c.id_comp,
            id_effectif_competence: "",
            code: c.code || "",
            intitule: c.intitule || "",
            domaine: c.domaine || "",
            role: ui.role,
            source: "catalogue",
            selectionnee: true,
            motif: "",
          });
        }

        epSetValue(ui.inputId, "");
        wrap.innerHTML = "";
        epRenderEntretienCompetences();
      });

      wrap.appendChild(btn);
    });
  }

  async function epEnsureEffectifCompetence(idComp) {
    const url = `${_portal.apiBase}/skills/entretien-performance/effectif-competence/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;

    const data = await _portal.apiJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_comp: idComp }),
    });

    return (data?.id_effectif_competence || "").toString().trim();
  }

  async function epOpenEvaluationFromEntretien(item) {
    if (!item || !item.id_comp) return;

    const idEntretien = epGetValue("ep_entretienId");

    if (!idEntretien) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Enregistre l'entretien avant d'évaluer une compétence.");
      return;
    }

    let idEc = (item.id_effectif_competence || "").toString().trim();

    if (!idEc) {
      idEc = await epEnsureEffectifCompetence(item.id_comp);
      item.id_effectif_competence = idEc;
    }

    state.selectedCompetenceId = item.id_comp;
    state.selectedEffectifCompetenceId = idEc;
    state._entretienAuditContext = {
      id_entretien: idEntretien,
      role: item.role || "poste",
    };

    closeModal("modalEpEntretien");

    const existingRow = document.querySelector(`#ep_tblCompetences tbody tr[data-id-effectif-competence="${CSS.escape(idEc)}"]`);
    if (existingRow) {
      const tb = $("ep_tblCompetences")?.querySelector("tbody");
      if (tb) tb.querySelectorAll("tr.active").forEach(r => r.classList.remove("active"));
      existingRow.classList.add("active");
    }

    await epOpenEvaluationStandalone({
      id_comp: item.id_comp,
      id_effectif_competence: idEc,
      code: item.code,
      intitule: item.intitule,
      domaine: item.domaine,
    });
  }

  async function epOpenEvaluationStandalone(x) {
    state._historyAuditEditing = null;

    const evalModal = $("modalEpEvaluation");
    if (evalModal) evalModal.classList.remove("is-history-readonly", "is-history-editable");

    clearSaveInlineMsg();
    openModal("modalEpEvaluation");

    setText("ep_evalHint", "Évaluation en cours.");
    renderEvalCompetenceTitle(x.code, x.intitule);
    renderEvalDomainBadge("", "");

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

    state._compDetailCache = state._compDetailCache || {};
    let detail = state._compDetailCache[x.id_comp];

    if (!detail) {
      const id_service = (state.selectedCollaborateurServiceId || state.serviceId || "").toString().trim();
      const url = `${_portal.apiBase}/skills/referentiel/competence/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id_service)}/${encodeURIComponent(x.id_comp)}`;
      detail = await _portal.apiJson(url);
      state._compDetailCache[x.id_comp] = detail;
    }

    const comp = detail?.competence || {};
    const grid = comp?.grille_evaluation || null;

    const dom = comp?.domaine || null;
    renderEvalDomainBadge(
      dom ? (dom.titre_court || dom.titre || dom.id_domaine_competence || "") : (x.domaine || ""),
      dom?.couleur || ""
    );

    const keys = (grid && typeof grid === "object") ? Object.keys(grid) : [];
    const ordered = keys.slice().sort((a, b) => {
      const ma = String(a).match(/(\d+)/);
      const mb = String(b).match(/(\d+)/);
      return (ma ? parseInt(ma[1], 10) : 999) - (mb ? parseInt(mb[1], 10) : 999);
    });

    for (let i = 1; i <= 4; i++) {
      const key = ordered[i - 1];
      const c = key ? (grid[key] || {}) : null;
      const nom = c ? (c.Nom ?? c.nom ?? "").toString().trim() : "";
      const evalsRaw = c ? (Array.isArray(c.Eval || c.eval) ? (c.Eval || c.eval) : []) : [];
      const evalsAll = evalsRaw.map(v => (v ?? "").toString().trim());
      const enabled = !!key && (nom || evalsAll.some(v => v));

      const labelEl = $(`ep_critLabel${i}`);
      const noteId = `ep_critNote${i}`;
      const comId = `ep_critCom${i}`;
      const tr = labelEl ? labelEl.closest("tr") : null;

      if (tr) tr.style.display = enabled ? "" : "none";

      if (!enabled) {
        if (labelEl) labelEl.textContent = "";
        setDisabled(noteId, true);
        setDisabled(comId, true);
        continue;
      }

      if (labelEl) {
        labelEl.innerHTML = "";

        const span = document.createElement("span");
        span.textContent = nom || key;
        labelEl.appendChild(span);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ep-crit-help";
        btn.textContent = "i";
        btn.title = "Guide de notation";
        btn.setAttribute("aria-label", "Guide de notation");

        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const sel = $(noteId);
          openGuidePopover(btn, i, nom || key, evalsAll, sel ? (sel.value || "") : "");
        });

        labelEl.appendChild(btn);
      }

      setDisabled(noteId, false);
      setDisabled(comId, false);
    }

    setDisabled("ep_selEvalMethod", false);
    setDisabled("ep_txtObservation", false);
    setDisabled("ep_btnSave", false);
  }

  async function epLoadEntretienDocuments() {
    const wrap = $("ep_entretienDocList");
    const idEntretien = epGetValue("ep_entretienId");

    if (!wrap) return;

    if (!idEntretien || !_portal) {
      wrap.innerHTML = "";
      return;
    }

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}/documents`;
      const data = await _portal.apiJson(url);
      const list = Array.isArray(data) ? data : [];

      if (!list.length) {
        wrap.innerHTML = `<div class="ep-entretien-empty">Aucun document</div>`;
        return;
      }

      wrap.innerHTML = list.map(d => `
        <div class="ep-entretien-doc-row">
          <span>${epEsc(d.nom_fichier || "Document")}</span>
          <span class="card-sub">${epEsc(d.type_document || "")}</span>
        </div>
      `).join("");

    } catch (_) {
      wrap.innerHTML = `<div class="ep-entretien-empty">Documents indisponibles</div>`;
    }
  }

  async function epUploadEntretienDocument() {
    const idEntretien = epGetValue("ep_entretienId");
    const fileInput = $("ep_entretienDocFile");

    if (!idEntretien) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Enregistre l'entretien avant d'importer un document.");
      return;
    }

    const file = fileInput?.files?.[0] || null;
    if (!file) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Sélectionne un fichier.");
      return;
    }

    const fd = new FormData();
    fd.append("type_document", epGetValue("ep_entretienDocType") || "document_entretien");
    fd.append("file", file);

    try {
      epSetInlineMsg("ep_entretienMsg", "info", "Import du document…");

      const url = `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}/document`;
      await _portal.apiJson(url, {
        method: "POST",
        body: fd,
      });

      if (fileInput) fileInput.value = "";
      epSetInlineMsg("ep_entretienMsg", "success", "Document importé");
      await epLoadEntretienDocuments();

    } catch (e) {
      const raw = String(e?.message || e || "").replace(/^Erreur serveur\s*:\s*/i, "").trim();
      epSetInlineMsg("ep_entretienMsg", "danger", raw || "Erreur import document.");
    }
  }

  function epEsc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function epFormatDateFR(v) {
    if (!v) return "—";
    try {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      return d.toLocaleDateString("fr-FR");
    } catch {
      return String(v);
    }
  }

  function epDateTime(v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function epNormalizeColor(raw) {
    if (raw === null || raw === undefined) return "";

    const s = raw.toString().trim();
    if (!s) return "";

    if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl") || s.startsWith("var(")) {
      return s;
    }

    if (/^-?\d+$/.test(s)) {
      const n = parseInt(s, 10);
      const u = (n >>> 0);
      const r = (u >> 16) & 255;
      const g = (u >> 8) & 255;
      const b = u & 255;

      return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
    }

    return s;
  }

  function epColorForKey(key) {
    let h = 0;
    const s = String(key || "x");

    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }

    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 68%, 42%)`;
  }

  function epTrendFromPoints(points) {
    const pts = Array.isArray(points) ? points.filter(p => Number.isFinite(Number(p.value))) : [];
    if (pts.length < 2) return "stable";

    const first = Number(pts[0].value);
    const last = Number(pts[pts.length - 1].value);
    const delta = last - first;

    if (delta > 1) return "up";
    if (delta < -1) return "down";
    return "stable";
  }

  function epTrendIcon(trend) {
    if (trend === "up") return `<span class="ep-trend ep-trend--up" title="Progression">↗</span>`;
    if (trend === "down") return `<span class="ep-trend ep-trend--down" title="Régression">↘</span>`;
    return `<span class="ep-trend ep-trend--stable" title="Stable">→</span>`;
  }

  function bindHistoryTabsOnce() {
    if (state._histTabsBound) return;
    state._histTabsBound = true;

    const tabs = document.querySelectorAll("#modalEpHistory .ep-history-tab");
    tabs.forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab || "historique";
        setHistoryTab(tab);
      });
    });

    const viewBtns = document.querySelectorAll("#modalEpHistory .ep-prog-view");
    viewBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view || "competences";
        state._progView = view;

        viewBtns.forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");

        renderProgression();
      });
    });

    const selMethod = $("ep_progMethod");
    if (selMethod) {
      selMethod.addEventListener("change", () => {
        state._progressData = null;
        state._progressVisible = {};
        loadProgressionData();
      });
    }
  }

  function setHistoryTab(tab) {
    const isProgression = tab === "progression";
    const isEntretiens = tab === "entretiens";

    document.querySelectorAll("#modalEpHistory .ep-history-tab").forEach(b => {
      b.classList.toggle("is-active", (b.dataset.tab || "") === tab);
    });

    const histPanel = $("ep_histPanelHistorique");
    const progPanel = $("ep_histPanelProgression");
    const entretiensPanel = $("ep_histPanelEntretiens");

    if (histPanel) histPanel.classList.toggle("is-active", !isProgression && !isEntretiens);
    if (progPanel) progPanel.classList.toggle("is-active", isProgression);
    if (entretiensPanel) entretiensPanel.classList.toggle("is-active", isEntretiens);

    if (isProgression) {
      const currentKey = [
        state.selectedCollaborateurId || "",
        getEpCriticiteSeuil(),
        ($("ep_progMethod")?.value || "").toString().trim()
      ].join("|");

      if (!state._progressData || state._progressLoadedKey !== currentKey) {
        loadProgressionData();
      } else {
        renderProgression();
      }
    }

    if (isEntretiens) {
      loadEntretiensIndividuels();
    }
  }

  async function loadProgressionData() {
    const wrap = $("ep_progTableWrap");
    const canvas = $("ep_progChart");

    if (!state.selectedCollaborateurId || !_portal) {
      if (wrap) wrap.innerHTML = `<div class="ep-history-empty">Sélectionne un collaborateur pour afficher la progression.</div>`;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    if (wrap) wrap.innerHTML = `<div class="ep-history-empty">Chargement de la progression…</div>`;

    const selectedId = (state.selectedCollaborateurId || "").toString().trim();
    const method = ($("ep_progMethod")?.value || "").toString().trim();
    const seuil = getEpCriticiteSeuil();

    const loadKey = [selectedId, seuil, method].join("|");
    state._progressLoadingKey = loadKey;

    try {
      const params = new URLSearchParams();
      params.set("criticite_min", String(seuil));

      if (method) params.set("methode_eval", method);

      const url = `${_portal.apiBase}/skills/entretien-performance/progression/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(selectedId)}?${params.toString()}`;
      const data = await _portal.apiJson(url);

      // Si l'utilisateur a changé de collaborateur pendant l'appel API,
      // on ignore la réponse obsolète. Sinon, merveille : les courbes voyagent entre salariés.
      if (state._progressLoadingKey !== loadKey || state.selectedCollaborateurId !== selectedId) {
        return;
      }

      state._progressData = data || {};
      state._progressLoadedKey = loadKey;
      state._progView = state._progView || "competences";
      state._progressVisible = {};

      const sel = $("ep_progMethod");
      if (sel && Array.isArray(data?.methodes)) {
        const current = sel.value || "";
        sel.innerHTML = `<option value="">Toutes les méthodes</option>`;

        data.methodes.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          sel.appendChild(opt);
        });

        if (current && data.methodes.includes(current)) sel.value = current;
      }

      renderProgression();
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="ep-history-empty">Impossible de charger la progression : ${epEsc(e?.message || e)}</div>`;
    }
  }

  function getProgressionSeriesForView() {
    const data = state._progressData || {};
    const view = state._progView || "competences";

    if (view === "domaines") {
      return (Array.isArray(data.domaines) ? data.domaines : []).map(s => ({
        ...s,
        _kind: "domaines",
        _color: epNormalizeColor(s.couleur || s.domaine_couleur || s.color) || epColorForKey(`dom-${s.id || s.label}`),
      }));
    }

    if (view === "poste") {
      const poste = data.poste || {};
      return [{
        id: "poste",
        label: poste.label || "Maîtrise du poste",
        points: Array.isArray(poste.points) ? poste.points : [],
        _kind: "poste",
        _color: "var(--accent)",
      }];
    }

    return (Array.isArray(data.competences) ? data.competences : []).map(s => ({
      ...s,
      _kind: "competences",
      _color: epColorForKey(`comp-${s.id || s.code || s.label}`),
    }));
  }

  function renderProgression() {
    const wrap = $("ep_progTableWrap");
    const series = getProgressionSeriesForView();
    const view = state._progView || "competences";

    if (!wrap) return;

    if (!series.length || !series.some(s => Array.isArray(s.points) && s.points.length)) {
      renderProgressionChart([]);
      wrap.innerHTML = `<div class="ep-history-empty">Aucune donnée de progression disponible avec les filtres actuels.</div>`;
      return;
    }

    state._progressVisible = state._progressVisible || {};

    series.forEach(s => {
      const id = String(s.id || s.label || "");
      if (!(id in state._progressVisible)) state._progressVisible[id] = true;
    });

    const visibleSeries = series.filter(s => {
      const id = String(s.id || s.label || "");
      return view === "poste" || state._progressVisible[id] !== false;
    });

    renderProgressionChart(visibleSeries);

    if (view === "poste") {
      renderProgressionPosteTable(series[0]);
    } else {
      renderProgressionLegendTable(series, view);
    }
  }

  function renderProgressionLegendTable(series, view) {
    const wrap = $("ep_progTableWrap");
    if (!wrap) return;

    const labelHeader = view === "domaines" ? "Domaine" : "Compétence";
    const lastHeader = view === "domaines" ? "Dernière évolution" : "Dernière éval.";

    const rows = series.map(s => {
      const id = String(s.id || s.label || "");
      const checked = state._progressVisible?.[id] !== false;
      const color = s._color || epColorForKey(id);
      const trend = epTrendFromPoints(s.points);
      const last = s.last_date || (s.points?.length ? s.points[s.points.length - 1].date : "");

      const title = view === "competences" && s.code
        ? `${s.code} — ${s.label || ""}`
        : (s.label || s.titre || s.id || "—");

      return `
        <tr>
          <td class="col-center">
            <input type="checkbox" class="ep-prog-visible" data-id="${epEsc(id)}" ${checked ? "checked" : ""} />
          </td>
          <td class="col-center">
            <span class="ep-curve-dot" style="background:${epEsc(color)};"></span>
          </td>
          <td>
            <div class="ep-prog-label" title="${epEsc(title)}">${epEsc(title)}</div>
          </td>
          <td class="col-center">${epTrendIcon(trend)}</td>
          <td class="col-center">${epEsc(epFormatDateFR(last))}</td>
        </tr>
      `;
    }).join("");

    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="sb-table ep-prog-table">
          <thead>
            <tr>
              <th class="col-center" style="width:80px;">Afficher</th>
              <th class="col-center" style="width:70px;">Courbe</th>
              <th>${epEsc(labelHeader)}</th>
              <th class="col-center" style="width:90px;">Tendance</th>
              <th class="col-center" style="width:130px;">${epEsc(lastHeader)}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    wrap.querySelectorAll(".ep-prog-visible").forEach(chk => {
      chk.addEventListener("change", () => {
        const id = chk.dataset.id || "";
        state._progressVisible[id] = chk.checked;
        renderProgression();
      });
    });
  }

  function renderProgressionPosteTable(serie) {
    const wrap = $("ep_progTableWrap");
    if (!wrap) return;

    const pts = Array.isArray(serie?.points) ? serie.points : [];

    const rows = pts.map(p => `
      <tr>
        <td>${epEsc(epFormatDateFR(p.date))}</td>
        <td class="col-center"><strong>${epEsc(Math.round(Number(p.value || 0)))}%</strong></td>
      </tr>
    `).join("");

    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="sb-table ep-prog-table ep-prog-table--poste">
          <thead>
            <tr>
              <th>Date</th>
              <th class="col-center" style="width:160px;">Maîtrise du poste</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderProgressionChart(series) {
    const canvas = $("ep_progChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const padL = 46;
    const padR = 18;
    const padT = 18;
    const padB = 38;

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const allPoints = [];
    series.forEach(s => {
      (s.points || []).forEach(p => {
        const t = epDateTime(p.date);
        const v = Number(p.value);

        if (t && Number.isFinite(v)) {
          allPoints.push({ t, v });
        }
      });
    });

    if (!allPoints.length) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Aucune donnée à afficher.", w / 2, h / 2);
      return;
    }

    let minT = Math.min(...allPoints.map(p => p.t));
    let maxT = Math.max(...allPoints.map(p => p.t));

    if (minT === maxT) {
      minT -= 86400000;
      maxT += 86400000;
    }

    const xOf = (date) => {
      const t = epDateTime(date);
      return padL + ((t - minT) / (maxT - minT)) * plotW;
    };

    const yOf = (value) => {
      const v = Math.max(0, Math.min(100, Number(value || 0)));
      return padT + plotH - (v / 100) * plotH;
    };

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";

    [0, 25, 50, 75, 100].forEach(v => {
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(`${v}%`, padL - 8, y + 4);
    });

    ctx.strokeStyle = "#d1d5db";
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, h - padB);
    ctx.lineTo(w - padR, h - padB);
    ctx.stroke();

    const minDate = new Date(minT);
    const maxDate = new Date(maxT);
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "left";
    ctx.fillText(minDate.toLocaleDateString("fr-FR"), padL, h - 12);
    ctx.textAlign = "right";
    ctx.fillText(maxDate.toLocaleDateString("fr-FR"), w - padR, h - 12);

    series.forEach(s => {
      const pts = (s.points || [])
        .filter(p => epDateTime(p.date) && Number.isFinite(Number(p.value)))
        .sort((a, b) => epDateTime(a.date) - epDateTime(b.date));

      if (!pts.length) return;

      const color = s._color || epColorForKey(s.id || s.label);

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2.2;

      ctx.beginPath();

      pts.forEach((p, idx) => {
        const x = xOf(p.date);
        const y = yOf(p.value);

        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });

      ctx.stroke();

      pts.forEach(p => {
        const x = xOf(p.date);
        const y = yOf(p.value);

        ctx.beginPath();
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  function bindOnce() {
        if (_bound) return;
        _bound = true;

        bindPriorityHelpOnce();

        // Modal évaluation (standard)
        const modalEval = $("modalEpEvaluation");
        const btnXEval = $("btnCloseEpEvaluationModalX");
        const btnCloseEval = $("btnEpEvaluationModalClose");
        const closeEval = () => closeModal("modalEpEvaluation");

        if (btnXEval) btnXEval.addEventListener("click", closeEval);
        if (btnCloseEval) btnCloseEval.addEventListener("click", closeEval);
        if (modalEval) {
          modalEval.addEventListener("click", (e) => {
            if (e.target === modalEval) closeEval();
          });
        }

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

        // Modal Coverage Detail (standard)
        const modalCov = $("modalEpCoverageDetail");
        const btnXCov = $("btnCloseEpCoverageDetailModalX");
        const btnCloseCov = $("btnEpCoverageDetailModalClose");
        const closeCov = () => closeModal("modalEpCoverageDetail");

        if (btnXCov) btnXCov.addEventListener("click", closeCov);
        if (btnCloseCov) btnCloseCov.addEventListener("click", closeCov);
        if (modalCov) {
          modalCov.addEventListener("click", (e) => {
            if (e.target === modalCov) closeCov();
          });
        }

        // Clic sur la jauge -> ouvre le détail
        const svgCov = $("ep_svgGauge") || document.querySelector("#ep_covWrap svg");
        if (svgCov) {
          svgCov.style.cursor = "pointer";
          svgCov.style.pointerEvents = "auto";

          svgCov.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openModal("modalEpCoverageDetail");
            if (typeof renderCoverageDetailModal === "function") renderCoverageDetailModal();
          });
        }



        // Header actions
        const btnHelp = $("ep_btnHelpScoring");
        if (btnHelp) btnHelp.addEventListener("click", () => openModal("modalEpScoring"));

        const btnEntretien = $("ep_btnEntretienIndividuel");
        if (btnEntretien) {
          btnEntretien.addEventListener("click", () => {
            openEntretienModal(null);
          });
        }

        const btnNewEntretienHistory = $("ep_btnNewEntretienFromHistory");
        if (btnNewEntretienHistory) {
          btnNewEntretienHistory.addEventListener("click", () => {
            openEntretienModal(null);
          });
        }

        const btnSaveEntretien = $("ep_btnSaveEntretien");
        if (btnSaveEntretien) {
          btnSaveEntretien.addEventListener("click", openEntretienValidationFlow);
        }

        document.querySelectorAll("#modalEpEntretien .ep-entretien-tab").forEach(btn => {
          btn.addEventListener("click", () => epSetEntretienTab(btn.dataset.panel || "preparation"));
        });

        const rngEntCrit = $("ep_entretienCriticite");
        if (rngEntCrit) {
          rngEntCrit.addEventListener("input", epRenderEntretienCompetences);
        }

        const btnAddHorsPoste = $("ep_btnAddCompHorsPoste");
        if (btnAddHorsPoste) {
          btnAddHorsPoste.addEventListener("click", () => {
            epToggleCatalogueBox("detenue_hors_poste");
          });
        }

        const btnAddDevelop = $("ep_btnAddCompDevelop");
        if (btnAddDevelop) {
          btnAddDevelop.addEventListener("click", () => {
            epToggleCatalogueBox("a_developper");
          });
        }

        const searchHorsPoste = $("ep_entretienCatalogueHorsPosteSearch");
        if (searchHorsPoste) {
          let timer = null;
          searchHorsPoste.addEventListener("input", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => epSearchCatalogueForRole("detenue_hors_poste"), 250);
          });
        }

        const searchDevelop = $("ep_entretienCatalogueDevelopSearch");
        if (searchDevelop) {
          let timer = null;
          searchDevelop.addEventListener("input", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => epSearchCatalogueForRole("a_developper"), 250);
          });
        }

        const btnUploadDoc = $("ep_btnUploadEntretienDoc");
        if (btnUploadDoc) {
          btnUploadDoc.addEventListener("click", epUploadEntretienDocument);
        }

        const modalEntretien = $("modalEpEntretien");
        const btnXEntretien = $("btnCloseEpEntretienModalX");
        const btnCloseEntretien = $("btnEpEntretienModalClose");
        const closeEntretien = () => closeModal("modalEpEntretien");

        if (btnXEntretien) btnXEntretien.addEventListener("click", closeEntretien);
        if (btnCloseEntretien) btnCloseEntretien.addEventListener("click", closeEntretien);
        if (modalEntretien) {
          modalEntretien.addEventListener("click", (e) => {
            if (e.target === modalEntretien) closeEntretien();
          });
        }

        const btnReportPdf = $("ep_btnReportPdf");
        if (btnReportPdf) {
          btnReportPdf.addEventListener("click", () => {
            if (!state.selectedCollaborateurId || !_portal) {
              _portal && _portal.showAlert("warning", "Sélectionne un collaborateur avant de générer le rapport PDF.");
              return;
            }

            /*
              Bouton prêt côté front.
              La route backend dédiée sera à créer quand le contenu exact du rapport sera validé.
              Endpoint cible prévu :
              GET /skills/entretien-performance/rapport-pdf/{id_contact}/{id_effectif}?criticite_min=XX
            */
            const params = new URLSearchParams();
            params.set("criticite_min", String(getEpCriticiteSeuil()));

            const url = `${_portal.apiBase}/skills/entretien-performance/rapport-pdf/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}?${params.toString()}`;

            const win = window.open(url, "_blank", "noopener");
            if (!win) {
              _portal.showAlert("warning", "Le navigateur a bloqué l'ouverture du PDF.");
            }
          });
        }

        const btnHist = $("ep_btnHistoryGlobal");
        if (btnHist) {
          btnHist.addEventListener("click", async () => {
            openModal("modalEpHistory");
            bindHistoryTabsOnce();
            setHistoryTab("historique");

            const timeline = $("ep_historyTimeline");
            const txtSearch = $("ep_histSearch");
            const selEval = $("ep_histSelEvaluateur");
            const selMeth = $("ep_histSelMethode");
            const histName = $("ep_histCollaborateurName");

            if (!timeline) return;

            const currentCollabName = ($("ep_ctxCollaborateur")?.textContent || "").toString().trim();
            if (histName) histName.textContent = currentCollabName && currentCollabName !== "—"
              ? currentCollabName
              : "Collaborateur sélectionné";

            const esc = (s) => String(s ?? "")
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;");

            const formatDateFR = (v) => {
              if (!v) return "—";
              try {
                const d = new Date(v);
                if (Number.isNaN(d.getTime())) return String(v);
                return d.toLocaleDateString("fr-FR");
              } catch {
                return String(v);
              }
            };

            const dateSortValue = (v) => {
              if (!v) return 0;
              const d = new Date(v);
              return Number.isNaN(d.getTime()) ? 0 : d.getTime();
            };

            const niveauFromScore = (score) => {
              const s = Number(score);
              if (!Number.isFinite(s)) return "—";

              if (s >= 19) return "Expert";
              if (s >= 10) return "Avancé";
              if (s >= 6) return "Initial";
              return "—";
            };

            const getEvalKey = (x) => (x?.nom_evaluateur || x?.id_evaluateur || "Non affecté").toString().trim() || "Non affecté";
            const getMethKey = (x) => (x?.methode_eval || "Non renseignée").toString().trim() || "Non renseignée";

            const setHistoryMessage = (msg) => {
              timeline.innerHTML = `<div class="ep-history-empty">${esc(msg)}</div>`;
            };

            const fillSelect = (sel, firstLabel, values) => {
              if (!sel) return;

              const current = (sel.value || "").toString();
              sel.innerHTML = `<option value="">${esc(firstLabel)}</option>`;

              values.forEach(v => {
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v;
                sel.appendChild(opt);
              });

              if (current && values.includes(current)) sel.value = current;
              else sel.value = "";
            };

            const extractHistoryCriteres = (x) => {
              const detail = x?.detail_eval && typeof x.detail_eval === "object" ? x.detail_eval : {};
              const criteres = Array.isArray(detail.criteres) ? detail.criteres : [];
              return criteres
                .map(c => ({
                  code_critere: (c.code_critere || "").toString().trim(),
                  niveau: c.niveau,
                  commentaire: (c.commentaire || "").toString()
                }))
                .filter(c => c.code_critere && c.niveau !== null && c.niveau !== undefined);
            };

            const loadEvaluationReferentielData = async (idComp) => {
              const fallback = {
                labels: {
                  Critere1: "Critère 1",
                  Critere2: "Critère 2",
                  Critere3: "Critère 3",
                  Critere4: "Critère 4"
                },
                evals: {
                  Critere1: [],
                  Critere2: [],
                  Critere3: [],
                  Critere4: []
                },
                domaine: {
                  label: "",
                  couleur: ""
                }
              };

              if (!idComp || !_portal) return fallback;

              const idService = (state.selectedCollaborateurServiceId || state.serviceId || "").toString().trim();
              if (!idService || idService === "__ALL__") return fallback;

              try {
                state._compDetailCache = state._compDetailCache || {};
                let detail = state._compDetailCache[idComp];

                if (!detail) {
                  const url = `${_portal.apiBase}/skills/referentiel/competence/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idService)}/${encodeURIComponent(idComp)}`;
                  detail = await _portal.apiJson(url);
                  state._compDetailCache[idComp] = detail;
                }

                const comp = detail?.competence || {};
                const grid = comp?.grille_evaluation || null;

                const dom = comp?.domaine || null;
                const domLabel = dom
                  ? (dom.titre_court || dom.titre || dom.id_domaine_competence || "")
                  : "";

                const domColorRaw = dom?.couleur || "";
                const domColor = (typeof epNormalizeColor === "function")
                  ? epNormalizeColor(domColorRaw)
                  : (domColorRaw || "").toString().trim();

                fallback.domaine = {
                  label: (domLabel || "").toString().trim(),
                  couleur: domColor
                };

                if (!grid || typeof grid !== "object") return fallback;

                const keys = Object.keys(grid).sort((a, b) => {
                  const ma = String(a).match(/(\d+)/);
                  const mb = String(b).match(/(\d+)/);
                  const na = ma ? parseInt(ma[1], 10) : 999;
                  const nb = mb ? parseInt(mb[1], 10) : 999;
                  return na - nb;
                });

                keys.slice(0, 4).forEach((k, idx) => {
                  const crit = grid[k] || {};
                  const codeCrit = `Critere${idx + 1}`;

                  const label = (crit.Nom ?? crit.nom ?? "").toString().trim();
                  if (label) fallback.labels[codeCrit] = label;

                  const evalsRaw = Array.isArray(crit.Eval || crit.eval) ? (crit.Eval || crit.eval) : [];
                  fallback.evals[codeCrit] = evalsRaw.map(v => (v ?? "").toString().trim());
                });

                return fallback;
              } catch (_) {
                return fallback;
              }
            };

            const setSelectValueOrAdd = (selectId, value) => {
              const sel = $(selectId);
              if (!sel) return;

              const v = (value || "").toString().trim();
              if (!v) return;

              const exists = Array.from(sel.options).some(o => o.value === v);
              if (!exists) {
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v;
                sel.appendChild(opt);
              }

              sel.value = v;
            };

            const openHistoryEvaluationDetail = async (x, group) => {
              

              const code = (x.code || "").toString().trim();
              const intitule = (x.intitule || "").toString().trim();
              const niveau = niveauFromScore(x.resultat_eval);
              const lastDate = formatDateFR(x.date_audit);
              const method = getMethKey(x);
              const obs = (x.observation || "").toString();

              resetEvaluationPanel();

              const canEditHistoryAudit =
                !!x.modifiable ||
                String(x.id_evaluateur || "").trim() === String(_portal?.contactId || "").trim();

              state._historyAuditEditing = {
                id_audit_competence: (x.id_audit_competence || "").toString().trim(),
                id_effectif_competence: (x.id_effectif_competence || "").toString().trim(),
                id_comp: (x.id_comp || "").toString().trim(),
                canEdit: !!canEditHistoryAudit,
                row: x,
              };

              state.selectedEffectifCompetenceId = state._historyAuditEditing.id_effectif_competence;
              state.selectedCompetenceId = state._historyAuditEditing.id_comp;

              const evalModal = $("modalEpEvaluation");
              if (evalModal) {
                evalModal.classList.add("is-history-readonly");
                evalModal.classList.toggle("is-history-editable", !!canEditHistoryAudit);
              }

              setText("ep_evalHint", `Historique du ${lastDate} · évalué par : ${group.evalTxt}`);

              const refData = await loadEvaluationReferentielData(x.id_comp);

              const titleEl = $("ep_compTitle");
              if (titleEl) {
                titleEl.innerHTML = "";

                if (code) {
                  const badge = document.createElement("span");
                  badge.className = "sb-badge sb-badge-ref-comp-code ep-eval-title-code";
                  badge.textContent = code;
                  titleEl.appendChild(badge);
                }

              const titleText = document.createElement("span");
                titleText.className = "ep-eval-title-text";
                titleText.textContent = intitule || "—";
                titleEl.appendChild(titleText);
              }

              const domEl = $("ep_compDomain");
              if (domEl) {
                const domLabel = (refData?.domaine?.label || "").toString().trim();
                const domColor = (refData?.domaine?.couleur || "").toString().trim();

                if (domLabel) {
                  domEl.textContent = domLabel;
                  domEl.className = "sb-badge-domaine ep-domain-badge";
                  domEl.style.setProperty("--dom-color", domColor || "#9ca3af");
                  domEl.style.display = "inline-flex";
                } else {
                  domEl.textContent = "";
                  domEl.className = "sb-badge";
                  domEl.removeAttribute("style");
                  domEl.style.display = "none";
                }
              }

              setText("ep_compCurrent", niveau);
              setText("ep_compLastEval", lastDate ? `Dernière éval : ${lastDate}` : "");

              setText("ep_levelABC", niveau);

              const score = Number(x.resultat_eval);
              const pct = Number.isFinite(score)
                ? Math.max(0, Math.min(100, Math.round((score / 24) * 100)))
                : null;

              setText("ep_scorePct", pct === null ? "—" : `${pct}%`);

              setSelectValueOrAdd("ep_selEvalMethod", method);
              setDisabled("ep_selEvalMethod", !canEditHistoryAudit);

              const obsEl = $("ep_txtObservation");
              if (obsEl) obsEl.value = obs || "";
              setDisabled("ep_txtObservation", !canEditHistoryAudit);

              const criteres = extractHistoryCriteres(x);

              for (let i = 1; i <= 4; i++) {
                const labelEl = $(`ep_critLabel${i}`);
                const row = labelEl ? labelEl.closest("tr") : null;
                const note = $(`ep_critNote${i}`);
                const com = $(`ep_critCom${i}`);

                const codeCrit = `Critere${i}`;
                const crit = criteres.find(c => c.code_critere === codeCrit);

                if (!crit) {
                  if (row) row.style.display = "none";
                  if (labelEl) labelEl.textContent = "";
                  if (note) note.value = "";
                  if (com) com.value = "";
                  setDisabled(`ep_critNote${i}`, true);
                  setDisabled(`ep_critCom${i}`, true);
                  continue;
                }

                if (row) row.style.display = "";
                if (labelEl) {
                  labelEl.innerHTML = "";

                  const labelText = refData?.labels?.[codeCrit] || `Critère ${i}`;
                  const evalsAll = Array.isArray(refData?.evals?.[codeCrit]) ? refData.evals[codeCrit] : [];

                  const spanTxt = document.createElement("span");
                  spanTxt.textContent = labelText;
                  labelEl.appendChild(spanTxt);

                  const btn = document.createElement("button");
                  btn.type = "button";
                  btn.className = "ep-crit-help";
                  btn.textContent = "i";
                  btn.title = "Guide de notation";
                  btn.setAttribute("aria-label", "Guide de notation");

                  btn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const selectedNote = crit?.niveau ? String(crit.niveau) : "";
                    openGuidePopover(btn, i, labelText, evalsAll, selectedNote);
                  });

                  labelEl.appendChild(btn);
                }

                if (note) note.value = String(crit.niveau || "");
                if (com) com.value = crit.commentaire || "";

                setDisabled(`ep_critNote${i}`, !canEditHistoryAudit);
                setDisabled(`ep_critCom${i}`, !canEditHistoryAudit);
              }

              setDisabled("ep_btnSave", !canEditHistoryAudit);
              clearSaveInlineMsg();

              openModal("modalEpEvaluation");
            };

            if (!state.selectedCollaborateurId) {
              setHistoryMessage("Sélectionne un collaborateur pour afficher l’historique.");
              return;
            }

            setHistoryMessage("Chargement…");

            let rows = [];
            try {
              const url = `${_portal.apiBase}/skills/entretien-performance/historique/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
              const data = await _portal.apiJson(url);

              rows = Array.isArray(data) ? data : [];
              state._historyAll = rows;
            } catch (e) {
              setHistoryMessage("Impossible de charger l’historique : " + String(e?.message || e));
              return;
            }

            const evals = Array.from(new Set(rows.map(getEvalKey))).sort((a, b) => a.localeCompare(b, "fr"));
            const meths = Array.from(new Set(rows.map(getMethKey))).sort((a, b) => a.localeCompare(b, "fr"));

            fillSelect(selEval, "Tous", evals);
            fillSelect(selMeth, "Toutes", meths);

            const buildGroups = (list) => {
              const map = new Map();

              list.forEach(x => {
                const dateRaw = (x.date_audit || "").toString().trim();
                const evalTxt = getEvalKey(x);
                const methTxt = getMethKey(x);

                const key = `${dateRaw}||${evalTxt}||${methTxt}`;

                if (!map.has(key)) {
                  map.set(key, {
                    key,
                    dateRaw,
                    dateTxt: formatDateFR(dateRaw),
                    evalTxt,
                    methTxt,
                    rows: [],
                  });
                }

                map.get(key).rows.push(x);
              });

              return Array.from(map.values()).sort((a, b) => {
                const da = dateSortValue(a.dateRaw);
                const db = dateSortValue(b.dateRaw);
                if (db !== da) return db - da;

                return `${a.evalTxt} ${a.methTxt}`.localeCompare(`${b.evalTxt} ${b.methTxt}`, "fr", { sensitivity: "base" });
              });
            };

            const render = (list) => {
              if (!list.length) {
                timeline.innerHTML = `<div class="ep-history-empty">Aucun audit trouvé.</div>`;
                return;
              }

              const groups = buildGroups(list);
              timeline.innerHTML = "";

              groups.forEach((g, idx) => {
                const hasObs = g.rows.some(x => (x.observation || "").toString().trim());

                const item = document.createElement("div");
                item.className = "ep-history-group";

                const head = document.createElement("button");
                head.type = "button";
                head.className = "ep-history-group-head";
                head.innerHTML = `
                  <div class="ep-history-group-main">
                    <div class="ep-history-group-title">
                      ${esc(g.dateTxt)} · ${esc(g.methTxt)}
                    </div>
                    <div class="ep-history-group-sub">
                      ${esc(g.evalTxt)} · ${g.rows.length} compétence(s) évaluée(s)
                    </div>
                  </div>

                  <div class="ep-history-group-right">
                    ${hasObs ? `<span class="ep-history-dot" title="Observation présente"></span>` : ""}
                    <span class="ep-history-chevron">⌄</span>
                  </div>
                `;

                const body = document.createElement("div");
                body.className = "ep-history-group-body";

                if (idx === 0) {
                  head.classList.add("is-open");
                  body.classList.add("is-open");
                }

                g.rows.forEach(x => {
                  const code = (x.code || "").toString().trim();
                  const intitule = (x.intitule || "").toString().trim();
                  const niveau = niveauFromScore(x.resultat_eval);

                  const iconEye = `
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>
                      <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                  `;

                  const row = document.createElement("div");
                  row.className = "ep-history-comp-row";
                  row.innerHTML = `
                    <div class="ep-history-comp-main">
                      ${code ? `<span class="sb-badge sb-badge-ref-comp-code">${esc(code)}</span>` : ""}
                      <span class="ep-history-comp-title" title="${esc(intitule)}">${esc(intitule || "—")}</span>
                    </div>

                    <div class="ep-history-comp-result">
                      <span class="sb-badge ${esc(getEpLevelBadgeClass(niveau))}">${esc(niveau)}</span>
                      <button type="button" class="sb-icon-btn ep-history-view-btn" title="Voir la grille d'évaluation" aria-label="Voir la grille d'évaluation" data-view="1">
                        ${iconEye}
                      </button>
                    </div>
                  `;

                  const btnView = row.querySelector('button[data-view="1"]');
                  if (btnView) {
                    btnView.addEventListener("click", async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      await openHistoryEvaluationDetail(x, g);
                    });
                  }

                  body.appendChild(row);
                });

                head.addEventListener("click", () => {
                  const opened = body.classList.toggle("is-open");
                  head.classList.toggle("is-open", opened);
                });

                item.appendChild(head);
                item.appendChild(body);
                timeline.appendChild(item);
              });
            };

            const applyFilters = () => {
              const q = (txtSearch?.value || "").toString().trim().toLowerCase();
              const fe = (selEval?.value || "").toString().trim();
              const fm = (selMeth?.value || "").toString().trim();

              const filtered = (state._historyAll || []).filter(x => {
                const evalKey = getEvalKey(x);
                const methKey = getMethKey(x);

                if (fe && evalKey !== fe) return false;
                if (fm && methKey !== fm) return false;

                if (q) {
                  const hay = [
                    x.code || "",
                    x.intitule || "",
                    x.observation || "",
                    evalKey,
                    methKey,
                    formatDateFR(x.date_audit || ""),
                  ].join(" ").toLowerCase();

                  if (!hay.includes(q)) return false;
                }

                return true;
              });

              render(filtered);
            };

            if (txtSearch) txtSearch.oninput = () => applyFilters();
            if (selEval) selEval.onchange = () => applyFilters();
            if (selMeth) selMeth.onchange = () => applyFilters();

            applyFilters();
          });
        }



        // Scope
        const selService = $("ep_selService");
        if (selService) {
        selService.addEventListener("change", async () => {
            state.serviceId = window.portal.serviceFilter.normalizeId(selService.value || "");
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
        if (btnReset) btnReset.addEventListener("click", async () => { await resetScope(); });


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

        // ======================================================
        // Scoring live (affichage métier : maîtrise %, calcul interne sur 24)
        // ======================================================
        const computeCoef = (n) => {
        if (n === 4) return 1.5;
        if (n === 3) return 2;
        if (n === 2) return 3;
        if (n === 1) return 6;
        return null;
        };

        const computeLevel = (score24) => {
        if (score24 >= 6 && score24 <= 9) return "Initial";
        if (score24 >= 10 && score24 <= 18) return "Avancé";
        if (score24 >= 19 && score24 <= 24) return "Expert";
        return "—";
        };

        const computePct = (score24) => {
        const s = Number(score24);
        if (!Number.isFinite(s)) return null;
        return Math.max(0, Math.min(100, Math.round((s / 24) * 100)));
        };

        const recalcScore = () => {
        if (!state.selectedCompetenceId) return;

        let enabledCount = 0;
        let sum = 0;
        let filledCount = 0;

        for (let i = 1; i <= 4; i++) {
            const labelEl = $(`ep_critLabel${i}`);
            const tr = labelEl ? labelEl.closest("tr") : null;
            const sel = $(`ep_critNote${i}`);

            const isVisible = !tr || tr.style.display !== "none";
            const isEnabled = !!sel && !sel.disabled && isVisible;

            if (!isEnabled) continue;

            enabledCount++;

            const v = (sel.value || "").toString().trim();
            if (v) {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n)) sum += n;
            filledCount++;
            }
        }

        if (filledCount === 0) {
            setText("ep_scoreRaw", "—");
            setText("ep_scorePct", "—");
            setText("ep_levelABC", "—");
            return;
        }

        setText("ep_scoreRaw", String(sum));

        const coef = computeCoef(enabledCount);
        const score24 = coef ? Math.round(sum * coef * 10) / 10 : null;
        const pct = computePct(score24);

        if (enabledCount > 0 && filledCount === enabledCount && score24 !== null && pct !== null) {
            setText("ep_scorePct", `${pct}%`);
            setText("ep_levelABC", computeLevel(score24));
        } else {
            setText("ep_scorePct", "—");
            setText("ep_levelABC", "—");
        }
        };

        // Bind notes (une fois) : toute modification de note déclenche le recalcul
        for (let i = 1; i <= 4; i++) {
        const sel = $(`ep_critNote${i}`);
        if (!sel) continue;
        sel.addEventListener("change", recalcScore);
        sel.addEventListener("input", recalcScore);
        }

        // ======================================================
        // Actions évaluation (placeholders)
        // ======================================================
        const btnSave = $("ep_btnSave");
        if (btnSave) {
          btnSave.addEventListener("click", async () => {
            if (!_portal) return;

            let msg = $("ep_saveInlineMsg") || $("ep_saveMsg");

            if (!msg) {
              // Si le HTML n'est pas à jour, on crée le message juste à côté du bouton
              msg = document.createElement("div");
              msg.id = "ep_saveInlineMsg";
              msg.className = "card-sub";
              msg.style.display = "none";
              msg.style.margin = "0";

              const parent = btnSave.parentElement;
              if (parent) parent.insertBefore(msg, btnSave);
            }

            const setMsg = (isOk, text) => {
              if (!msg) return;

              msg.textContent = text || "";
              msg.classList.remove(
                "sb-inline-msg--success",
                "sb-inline-msg--info",
                "sb-inline-msg--danger"
              );

              msg.classList.add(
                "is-visible",
                isOk ? "sb-inline-msg--success" : "sb-inline-msg--danger"
              );
            };

            const clearMsg = () => {
              clearSaveInlineMsg();
            };

            try {
              clearMsg();
              btnSave.disabled = true;

              const entretienAuditContext = state._entretienAuditContext
                ? { ...state._entretienAuditContext }
                : null;

              const isHistoryUpdate = !!state._historyAuditEditing?.id_audit_competence;

              const saved = await saveCurrentAudit();
              await afterAuditSavedRefresh(saved);

              if (entretienAuditContext?.id_entretien && !isHistoryUpdate) {
                closeModal("modalEpEvaluation");
                openModal("modalEpEntretien");
                epRenderEntretienCompetences();
                epSetEntretienTab("competences");
                epSetInlineMsg("ep_entretienMsg", "success", "Compétence évaluée. Tu peux poursuivre les autres évaluations.");
                state._entretienAuditContext = null;
                return;
              }

              setMsg(true, isHistoryUpdate ? "Évaluation mise à jour" : "Audit enregistré avec succès");
            } catch (e) {
              const rawReason = String(e?.message || e || "").trim();
              const cleanReason = rawReason
                .replace(/^Erreur serveur\s*:\s*/i, "")
                .trim();

              setMsg(false, `Échec de l'enregistrement : ${cleanReason || "raison inconnue"}`);
            } finally {
              btnSave.disabled = false;
            }

          });
        }


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

  function _getEnabledCriteria() {
    const arr = [];
    for (let i = 1; i <= 4; i++) {
      const lbl = (document.getElementById(`ep_critLabel${i}`)?.textContent || "").trim();
      const sel = document.getElementById(`ep_critNote${i}`);
      const com = document.getElementById(`ep_critCom${i}`);
      if (!sel) continue;

      // Critère vide => on considère inactif
      if (!lbl || lbl === "—") continue;

      // Si le select est désactivé, on ne le prend pas
      if (sel.disabled) continue;

      arr.push({
        idx: i,
        code_critere: `Critere${i}`,
        select: sel,
        input: com,
      });
    }
    return arr;
  }

  function _computeScore24(sum, nbCrit) {
    let coef = 1;
    if (nbCrit === 4) coef = 1.5;
    else if (nbCrit === 3) coef = 2;
    else if (nbCrit === 2) coef = 3;
    else if (nbCrit === 1) coef = 6;

    return { coef, score24: Math.round((sum * coef) * 10) / 10 };
  }

  function _levelFromScore24(score24) {
    if (score24 >= 6 && score24 <= 9) return "Initial";
    if (score24 >= 10 && score24 <= 18) return "Avancé";
    if (score24 >= 19 && score24 <= 24) return "Expert";
    return "Initial"; // fallback (cas tordu)
  }

  async function saveCurrentAudit() {
    // On a besoin d’un collaborateur + d’une compétence sélectionnée
    const id_effectif_competence =
      (state.selectedEffectifCompetenceId || "").toString().trim();

    const id_comp = (state.selectedCompetenceId || "").toString().trim();

    if (!id_effectif_competence) {
      throw new Error("id_effectif_competence manquant (sélection compétence).");
    }
    if (!id_comp) {
      throw new Error("Compétence non sélectionnée.");
    }

    const enabled = _getEnabledCriteria();
    if (!enabled.length) {
      throw new Error("Aucun critère actif pour cette compétence.");
    }

    let sum = 0;
    const criteres = [];

    for (const c of enabled) {
      const v = (c.select.value || "").trim();
      if (!v) throw new Error("Notes incomplètes: renseigne tous les critères.");

      const note = parseInt(v, 10);
      if (!note || note < 1 || note > 4) throw new Error("Note invalide (1..4).");

      sum += note;

      const commentaire = (c.input?.value || "").trim();
      criteres.push({
        code_critere: c.code_critere,
        niveau: note,
        commentaire: commentaire || null,
      });
    }

    const { coef, score24 } = _computeScore24(sum, enabled.length);
    const niveau_actuel = _levelFromScore24(score24);

    // Alignement UI : résultat affiché en pourcentage de maîtrise
    const pct = Math.max(0, Math.min(100, Math.round((score24 / 24) * 100)));
    if (document.getElementById("ep_scoreRaw")) document.getElementById("ep_scoreRaw").textContent = String(sum);
    if (document.getElementById("ep_scorePct")) document.getElementById("ep_scorePct").textContent = `${pct}%`;
    if (document.getElementById("ep_levelABC")) document.getElementById("ep_levelABC").textContent = niveau_actuel;

    const observation = (document.getElementById("ep_txtObservation")?.value || "").trim();

    const payload = {
      id_effectif_competence,
      id_comp,
      id_entretien_individuel: state._entretienAuditContext?.id_entretien || null,
      role_competence_entretien: state._entretienAuditContext?.role || null,
      resultat_eval: score24,
      niveau_actuel,
      observation: observation || null,
      criteres: criteres.map(x => ({
        code_critere: x.code_critere,
        niveau: x.niveau,
        commentaire: x.commentaire
      })),
      methode_eval: (document.getElementById("ep_selEvalMethod")?.value || "Entretien de performance").trim(),
    };

    const histEdit = state._historyAuditEditing || null;
    const auditId = (histEdit?.id_audit_competence || "").toString().trim();

    const isHistoryUpdate = !!auditId && histEdit.canEdit === true;

    const url = isHistoryUpdate
      ? `${_portal.apiBase}/skills/entretien-performance/audit/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(auditId)}`
      : `${_portal.apiBase}/skills/entretien-performance/audit/${encodeURIComponent(_portal.contactId)}`;

    const saved = await _portal.apiJson(url, {
      method: isHistoryUpdate ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (isHistoryUpdate && histEdit.row) {
      histEdit.row.resultat_eval = score24;
      histEdit.row.niveau_actuel = niveau_actuel;
      histEdit.row.observation = payload.observation;
      histEdit.row.methode_eval = payload.methode_eval;
      histEdit.row.detail_eval = {
        criteres: payload.criteres,
      };

      state._progressData = null;
      state._progressLoadedKey = "";
    }

    return saved;
  }

  window.SkillsEntretienPerformance = { onShow };
})();
