/* ======================================================
   static/menus/skills_entretien_performance.js
   - Menu "Entretien de performance"
   - Squelette + chargement périmètre (services) + collaborateurs
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "entretien-performance";
  const ALL_SERVICES_ID = "__ALL__";
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
    pop.style.zIndex = "9999";
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
            line.style.cursor = "pointer";

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
            if (noteSelect && !noteSelect.disabled) {
                noteSelect.value = String(i);
                // déclenche les listeners éventuels (recalcul / score, etc.)
                noteSelect.dispatchEvent(new Event("input", { bubbles: true }));
                noteSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
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

    const saved = localStorage.getItem(LS_KEY_SERVICE) || "";
    const current = (sel.value || saved || "").trim();

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
    } else if (allowAll && Array.from(sel.options).some(o => o.value === ALL_SERVICES_ID)) {
      // par défaut: Tous les services
      sel.value = ALL_SERVICES_ID;
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
    const collabOk = scopeOk && !!state.selectedCollaborateurId;

    const txtSearchCollab = $("ep_txtSearchCollab");
    if (txtSearchCollab) txtSearchCollab.disabled = !scopeOk;

    const txtSearchComp = $("ep_txtSearchComp");
    if (txtSearchComp) txtSearchComp.disabled = !collabOk;

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

    const chk = $("ep_chkPondere");
    if (chk) {
      chk.addEventListener("change", () => {
        renderCouverturePoste();
      });
    }
  }

  function resetCouverturePosteUI() {
    const hint = $("ep_covHint");
    const wrap = $("ep_covWrap");
    const svg = $("ep_svgGauge");
    const pctPoste = $("ep_covPctPoste");
    const pctMax = $("ep_covPctMax");

    if (hint) {
      hint.style.display = "";
      hint.textContent = "Sélectionne un collaborateur pour afficher la couverture du poste.";
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
    const chk = $("ep_chkPondere");
    return (chk && chk.checked) ? "weighted" : "plain";
  }

  async function refreshCouverturePosteActuel(force) {
    if (!_portal) return;
    if (!state.selectedCollaborateurId) return;

    if (state._covLoading) return;
    if (!force && state._covData) return;

    state._covLoading = true;

    try {
      // Endpoint à ajouter côté API (on le fera ensuite) :
      // GET /skills/entretien-performance/couverture-poste-actuel/{id_contact}/{id_effectif}
      const url = `${_portal.apiBase}/skills/entretien-performance/couverture-poste-actuel/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
      const data = await _portal.apiJson(url);

      state._covData = data || null;

      // OK => on masque le texte et on rend
      showCouverturePosteWrap("");
      renderCouverturePoste();

    } catch (e) {
      // On garde le bloc visible (toggle inclus), mais on affiche l’erreur.
      showCouverturePosteWrap("Impossible de calculer la couverture du poste actuel.");
      console.error(e);

      // petite jauge vide pour éviter un “grand trou”
      const svg = $("ep_svgGauge");
      if (svg) {
        renderGauge(svg, 0, 1, 0, 0, 0);
      }
    } finally {
      state._covLoading = false;
    }
  }

  function renderCouverturePoste() {
    const data = state._covData;
    if (!data) return;

    const mode = getCouvertureMode();
    const pack = (mode === "weighted") ? (data.weighted || null) : (data.plain || null);
    if (!pack) return;

    const svg = $("ep_svgGauge");
    if (!svg) return;

    // jauge bornée comme demandé (min/max théoriques)
    const gMin = Number(pack.gauge_min ?? 0);
    const gMax = Number(pack.gauge_max ?? 1);

    const expMin = Number(pack.expected_min ?? 0);
    const expMax = Number(pack.expected_max ?? 0);
    const score = Number(pack.score ?? 0);

    // Needle: clamp pour rester dans les limites de jauge
    const needle = Math.max(gMin, Math.min(gMax, score));

    renderGauge(svg, gMin, gMax, expMin, expMax, needle);

    // % sous jauge (avec le score réel, pas le needle clampé)
    const pct1 = (expMax > 0) ? ((score / expMax) * 100) : null;
    const pct2 = (gMax > 0) ? ((score / gMax) * 100) : null;

    const pctPoste = $("ep_covPctPoste");
    const pctMax = $("ep_covPctMax");

    if (pctPoste) pctPoste.textContent = (pct1 === null || !isFinite(pct1)) ? "—" : `${Math.round(pct1)}%`;
    if (pctMax) pctMax.textContent = (pct2 === null || !isFinite(pct2)) ? "—" : `${Math.round(pct2)}%`;
  }

  function renderGauge(svg, gaugeMin, gaugeMax, expectedMin, expectedMax, value) {
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const range = Math.max(1e-9, (gaugeMax - gaugeMin));

    const tFromValue = (v) => (clamp(v, gaugeMin, gaugeMax) - gaugeMin) / range;
    const angleFromT = (t) => 180 - (180 * t); // 180 (gauche) -> 0 (droite), arc du haut

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
      const p1 = polar(a1, r);
      const p2 = polar(a2, r);
      const large = (Math.abs(a2 - a1) <= 180) ? "0" : "1";
      const sweep = "0"; // sens anti-horaire => arc du haut pour 180->0
      return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    };

    // Background arc (haut)
    const bgD = arcPath(180, 0);

    const tExpMin = tFromValue(expectedMin);
    const tExpMax = tFromValue(expectedMax);
    const aExpMin = angleFromT(tExpMin);
    const aExpMax = angleFromT(tExpMax);

    // Zone attendue (si expMin/expMax cohérents)
    const zoneOk = isFinite(aExpMin) && isFinite(aExpMax) && (Math.abs(aExpMin - aExpMax) > 0.0001);
    const zoneD = zoneOk ? arcPath(aExpMin, aExpMax) : "";

    const aNeedle = angleFromT(tFromValue(value));
    const pNeedle = polar(aNeedle, rNeedle);

    svg.innerHTML = `
      <path d="${bgD}"
            stroke="rgba(0,0,0,.15)"
            stroke-width="14"
            fill="none"
            stroke-linecap="round"></path>

      ${zoneOk ? `<path d="${zoneD}"
            stroke="var(--accent)"
            stroke-width="14"
            fill="none"
            stroke-linecap="round"></path>` : ""}

      <line x1="${cx}" y1="${cy}" x2="${pNeedle.x.toFixed(2)}" y2="${pNeedle.y.toFixed(2)}"
            stroke="rgba(0,0,0,.65)"
            stroke-width="3"
            stroke-linecap="round"></line>

      <circle cx="${cx}" cy="${cy}" r="6" fill="rgba(0,0,0,.65)"></circle>
    `;
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
      _portal.showAlert("error", "Erreur bootstrap : " + String(e?.message || e));
      console.error(e);
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

      fillServiceSelect(flat, true);

    } catch (e) {
      _portal.showAlert("error", "Impossible de charger la liste des services : " + String(e?.message || e));
      console.error(e);
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
      const prenom = (c.prenom_effectif || "").toString().trim();
      const nom = (c.nom_effectif || "").toString().trim().toUpperCase();
      const name = `${nom} ${prenom}`.trim() || "Collaborateur";

      const left = document.createElement("div");
      left.className = "sb-tree-name";
      left.textContent = name;

      const right = document.createElement("div");
      right.className = "sb-tree-meta";
      right.textContent = ""; // plus de matricule, plus de poste


      const item = document.createElement("div");
      item.className = "sb-tree-item";
      item.appendChild(left);
    
      item.addEventListener("click", async () => {
        // sélection visuelle
        wrap.querySelectorAll(".sb-tree-item.active").forEach(x => x.classList.remove("active"));
        item.classList.add("active");

        state.selectedCollaborateurId = c.id_effectif || null;
        state.selectedCompetenceId = null;

        clearCompetences();
        resetEvaluationPanel();

        if (!state.selectedCollaborateurId || !_portal) return;

        // ---- Couverture poste actuel (jauge) ----
        // On affiche tout de suite le bloc + le toggle, et on passe en "Calcul en cours…"
        if (typeof bindCouverturePosteOnce === "function") bindCouverturePosteOnce();
        if (typeof showCouverturePosteWrap === "function") showCouverturePosteWrap("Calcul en cours…");

        // On force un recalcul (quand on codera l'endpoint, ça se rafraîchira proprement)
        state._covLastKey = null;
        state._covData = null;

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

          const total = list.length;
          const neverCount = list.filter(x => x._neverAudited).length;

          setText("ep_compCount", String(total));
          // KPI: à faire = compétences jamais auditées
          setText("ep_kpiToDo", `${neverCount} / ${total}`);

          // (les autres KPI restent à 0 pour l’instant, on les fera quand on sauvegardera des audits)
          setText("ep_kpiDone", "0");
          setText("ep_kpiChanged", "0");
          setText("ep_kpiReview", "0");

          list.forEach(x => {
            const tr = document.createElement("tr");
            tr.dataset.idEffectifCompetence = x.id_effectif_competence || "";
            tr.dataset.idComp = x.id_comp || "";

            // Col: code + intitulé ellipsis
            const tdComp = document.createElement("td");

            const rowWrap = document.createElement("div");
            rowWrap.style.display = "flex";
            rowWrap.style.alignItems = "center";
            rowWrap.style.gap = "8px";
            rowWrap.style.minWidth = "0";

            const badge = document.createElement("span");
            badge.className = x._neverAudited ? "sb-badge" : "sb-badge sb-badge-accent";
            badge.textContent = (x.code || "").toString().trim();

            // Badge rouge si jamais auditée
            if (x._neverAudited) {
              badge.style.background = "#d11a2a";
              badge.style.borderColor = "#d11a2a";
              badge.style.color = "#fff";
              badge.title = "Jamais auditée";
            }

            const title = document.createElement("span");
            title.textContent = (x.intitule || "").toString().trim();
            title.title = title.textContent; // tooltip = texte complet
            title.style.display = "block";
            title.style.minWidth = "0";
            title.style.flex = "1";
            title.style.fontSize = "13px";
            title.style.whiteSpace = "nowrap";
            title.style.overflow = "hidden";
            title.style.textOverflow = "ellipsis";

            rowWrap.appendChild(badge);
            rowWrap.appendChild(title);
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

              // En-tête évaluation (avec niveau + dernière éval)
              setText("ep_evalHint", "Évaluation en cours.");
              setText("ep_compTitle", `${(x.code || "").toString().trim()} — ${(x.intitule || "").toString().trim()}`.trim() || "—");
              const domEl = $("ep_compDomain");
              if (domEl) {
                const dom = (x.domaine || "").toString().trim();
                domEl.textContent = dom || "";

                // Couleur domaine: on réutilise le helper portail s'il existe (même logique que les autres pages)
                if (window.SB && typeof window.SB.getDomainColor === "function") {
                  const col = window.SB.getDomainColor(dom);
                  if (col) {
                    domEl.style.background = col;
                    domEl.style.borderColor = col;
                    domEl.style.color = "#fff";
                  }
                }
              }


              setText("ep_compCurrent", (x.niveau_actuel || "—").toString().trim() || "—");

              const last = (x.date_derniere_eval || "").toString().trim();
              const lastEl = $("ep_compLastEval");
              if (lastEl) lastEl.textContent = last ? `Dernière éval : ${last}` : "Jamais évaluée";

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

                // Domaine (si le référentiel renvoie un objet domaine)
                const dom = comp?.domaine || null;

                // même logique que skills_referentiel_competence.js : int ARGB signé (WinForms) -> #RRGGBB
                const normalizeColor = (raw) => {
                if (raw === null || raw === undefined) return "";
                const s = raw.toString().trim();
                if (!s) return "";

                // déjà du CSS
                if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl")) return s;

                // WinForms: int ARGB signé (ex: -256)
                if (/^-?\d+$/.test(s)) {
                    const n = parseInt(s, 10);
                    const u = (n >>> 0);
                    const r = (u >> 16) & 255;
                    const g = (u >> 8) & 255;
                    const b = u & 255;
                    return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
                }

                // sinon on laisse passer ("red", "var(--x)", etc.)
                return s;
                };

                if (domEl) {
                const label = dom ? (dom.titre_court || dom.titre || dom.id_domaine_competence || "") : (x.domaine || "");
                domEl.textContent = (label || "").toString().trim();

                // reset style (évite de garder la couleur précédente)
                domEl.style.background = "";
                domEl.style.border = "";
                domEl.style.color = "";
                domEl.style.display = "";
                domEl.style.padding = "";
                domEl.style.borderRadius = "";
                domEl.style.fontSize = "";
                domEl.style.lineHeight = "";

                const col = normalizeColor(dom?.couleur);
                if (col) {
                    // rendu “badge” même si ton élément est un <div class="card-sub">
                    domEl.style.display = "inline-block";
                    domEl.style.padding = "3px 8px";
                    domEl.style.borderRadius = "999px";
                    domEl.style.border = `1px solid ${col}`;
                    domEl.style.background = col;
                        // Texte auto (noir/blanc) selon la luminosité du fond
                    const pickTextColor = (bg) => {
                    const s = (bg || "").toString().trim();
                    let r = 0, g = 0, b = 0;

                    if (s.startsWith("#")) {
                        const hex = s.slice(1);
                        if (hex.length === 6) {
                        r = parseInt(hex.slice(0, 2), 16);
                        g = parseInt(hex.slice(2, 4), 16);
                        b = parseInt(hex.slice(4, 6), 16);
                        }
                    } else if (s.startsWith("rgb")) {
                        const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
                        if (m) {
                        r = parseInt(m[1], 10);
                        g = parseInt(m[2], 10);
                        b = parseInt(m[3], 10);
                        }
                    } else {
                        // couleur non parsable (nom CSS, var(), etc.) -> on évite le blanc par défaut
                        return "#111";
                    }

                    // luminance (0..255)
                    const lum = (r * 299 + g * 587 + b * 114) / 1000;
                    return lum >= 160 ? "#111" : "#fff";
                    };

                    domEl.style.color = pickTextColor(col);

                    domEl.style.fontSize = "12px";
                    domEl.style.lineHeight = "18px";
                }
                }


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



                // Coef + affichage score (placeholder, calcul plus tard sur saisie)
                const coef = (nbEnabled === 1) ? 6 : (nbEnabled === 2) ? 3 : (nbEnabled === 3) ? 2 : (nbEnabled === 4) ? 1.5 : "—";
                setText("ep_scoreCoef", String(coef));
                setText("ep_scoreRaw", "—");
                setText("ep_score24", "—");
                setText("ep_levelABC", "—");

                // Déverrouillage global
                setDisabled("ep_txtObservation", false);

                setDisabled("ep_btnSave", false);
                setDisabled("ep_btnSaveNext", false);
                setDisabled("ep_btnMarkReview", false);

              } catch (e) {
                _portal && _portal.showAlert("error", "Détail compétence", String(e?.message || e));
              }
            });

            if (tbody) tbody.appendChild(tr);
          });



          // Filtre compétences activé
          const txtSearchComp = $("ep_txtSearchComp");
          if (txtSearchComp) txtSearchComp.disabled = false;

          // Bonus: filtre appliqué si l’utilisateur avait déjà tapé quelque chose
          filterChecklistRows();



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

    function filterChecklistRows() {
    const q = ($("ep_txtSearchComp")?.value || "").trim().toLowerCase();
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return;

    Array.from(tbody.querySelectorAll("tr")).forEach(tr => {
      const txt = (tr.textContent || "").toLowerCase();
      tr.style.display = (!q || txt.includes(q)) ? "" : "none";
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
        if (btnHist) {
          btnHist.addEventListener("click", async () => {
            openModal("modalEpHistory");

            const tbody = $("ep_tblHistory")?.querySelector("tbody");
            const txtSearch = $("ep_histSearch");
            const selEval = $("ep_histSelEvaluateur");
            const selMeth = $("ep_histSelMethode");

            if (!tbody) return;

            const esc = (s) => String(s ?? "")
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;");

            const setRowMessage = (msg) => {
              tbody.innerHTML = `<tr><td colspan="5" style="padding:10px; color:#6b7280;">${esc(msg)}</td></tr>`;
            };

            const formatDateFR = (v) => {
              if (!v) return "—";
              try {
                const d = new Date(v);
                if (isNaN(d.getTime())) return String(v);
                return d.toLocaleDateString("fr-FR");
              } catch {
                return String(v);
              }
            };

            const niveauFromScore = (score) => {
              const s = Number(score);
              if (!isFinite(s)) return "—";

              // Si tu as le scoring bootstrap, on l’utilise
              const niveaux = state.scoring?.niveaux;
              if (Array.isArray(niveaux) && niveaux.length) {
                const hit = niveaux.find(n => s >= Number(n.min) && s <= Number(n.max));
                if (hit) return (hit.libelle || hit.code || "—");
              }

              // fallback règles Skillboard
              if (s >= 19) return "Expert";
              if (s >= 10) return "Avancé";
              if (s >= 6) return "Initial";
              return "—";
            };

            const getEvalKey = (x) => (x?.nom_evaluateur || x?.id_evaluateur || "Non affecté").toString().trim() || "Non affecté";
            const getMethKey = (x) => (x?.methode_eval || "Non renseignée").toString().trim() || "Non renseignée";

            // Bind modal observation (une fois)
            if (!state._histObsBound) {
              state._histObsBound = true;

              const closeObs = () => closeModal("modalEpHistoryObs");
              const btnX = $("btnCloseEpHistoryObsModalX");
              const btnClose = $("btnEpHistoryObsModalClose");
              const modalObs = $("modalEpHistoryObs");

              if (btnX) btnX.addEventListener("click", closeObs);
              if (btnClose) btnClose.addEventListener("click", closeObs);
              if (modalObs) {
                modalObs.addEventListener("click", (e) => {
                  if (e.target === modalObs) closeObs();
                });
              }
            }

            const openObs = (title, meta, text) => {
              const t = $("ep_histObsTitle");
              const m = $("ep_histObsMeta");
              const b = $("ep_histObsText");
              if (t) t.textContent = title || "Observation";
              if (m) m.textContent = meta || "";
              if (b) b.textContent = text || "";
              openModal("modalEpHistoryObs");
            };

            if (!state.selectedCollaborateurId) {
              setRowMessage("Sélectionne un collaborateur pour afficher l’historique.");
              return;
            }

            setRowMessage("Chargement…");

            // 1) Charger data
            let rows = [];
            try {
              const url = `${_portal.apiBase}/skills/entretien-performance/historique/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
              const data = await _portal.apiJson(url);
              rows = Array.isArray(data) ? data : [];
              state._historyAll = rows;
            } catch (e) {
              setRowMessage("Impossible de charger l’historique : " + String(e?.message || e));
              return;
            }

            // 2) Remplir selects Evaluateur / Méthode
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
              // restore si possible
              if (current && values.includes(current)) sel.value = current;
              else sel.value = "";
            };

            const evals = Array.from(new Set(rows.map(getEvalKey))).sort((a,b)=>a.localeCompare(b, "fr"));
            const meths = Array.from(new Set(rows.map(getMethKey))).sort((a,b)=>a.localeCompare(b, "fr"));

            fillSelect(selEval, "Tous", evals);
            fillSelect(selMeth, "Toutes", meths);

            // 3) Render + filtres
            const render = (list) => {
              if (!list.length) {
                setRowMessage("Aucun audit trouvé.");
                return;
              }

              tbody.innerHTML = "";

              list.forEach(x => {
                const dateTxt = formatDateFR(x.date_audit);
                const evalTxt = getEvalKey(x);

                const code = (x.code || "").toString().trim();
                const intitule = (x.intitule || "").toString().trim();
                const compTitle = [code, intitule].filter(Boolean).join(" — ") || "—";

                const score = (x.resultat_eval ?? "");
                const scoreTxt = (score === null || score === undefined || score === "") ? "—" : String(score);

                const niveau = niveauFromScore(score);

                const obs = (x.observation || "").toString().trim();
                const hasObs = !!obs;

                const tdComp = `
                  <div style="min-width:0;">
                    <div style="line-height:1; margin-bottom:6px;">
                      ${code ? `<span class="sb-badge">${esc(code)}</span>` : ""}
                    </div>

                    <div title="${esc(intitule || compTitle)}"
                        style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                      ${esc(intitule || "—")}
                    </div>
                  </div>
                `;

                const tdNiveau = `
                  <span class="sb-badge">${esc(niveau)}</span>
                `;

                const tdObs = hasObs
                  ? `<button type="button" class="btn-secondary" style="padding:4px 10px; font-size:12px;" data-obs="1">Voir</button>`
                  : "";

                const tr = document.createElement("tr");
                const tdResult = `
                  <div style="line-height:1.1; text-align:center;">
                    <div style="font-weight:700;">${esc(scoreTxt)}</div>
                    <div style="margin-top:6px; display:flex; justify-content:center;">${tdNiveau}</div>
                  </div>
                `;

                tr.innerHTML = `
                  <td>${esc(dateTxt)}</td>
                  <td>${esc(evalTxt)}</td>
                  <td>${tdComp}</td>
                  <td>${tdResult}</td>
                  <td>${tdObs}</td>
                `;

                // Clic "Voir" observation
                const btn = tr.querySelector('button[data-obs="1"]');
                if (btn) {
                  btn.addEventListener("click", () => {
                    const meta = `${dateTxt} • ${evalTxt} • score ${scoreTxt} • ${niveau}`;
                    openObs(compTitle, meta, obs);
                  });
                }

                tbody.appendChild(tr);
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
                    (x.code || ""),
                    (x.intitule || ""),
                    (x.observation || ""),
                    evalKey,
                    methKey
                  ].join(" ").toLowerCase();
                  if (!hay.includes(q)) return false;
                }

                return true;
              });

              render(filtered);
            };

            // Events filtres (on remplace, pas d’empilement)
            if (txtSearch) txtSearch.oninput = () => applyFilters();
            if (selEval) selEval.onchange = () => applyFilters();
            if (selMeth) selMeth.onchange = () => applyFilters();

            // Initial render
            applyFilters();
          });
        }



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

        // ======================================================
        // Scoring live (Somme brute / Coef / Score /24 / Niveau)
        // ======================================================
        const computeCoef = (n) => {
        if (n === 4) return 1.5;
        if (n === 3) return 2;
        if (n === 2) return 3;
        if (n === 1) return 6;
        return null;
        };

        const computeLevel = (score24) => {
        if (score24 >= 6 && score24 <= 9) return "A (Initial)";
        if (score24 >= 10 && score24 <= 18) return "B (Avancé)";
        if (score24 >= 19 && score24 <= 24) return "C (Expert)";
        return "—";
        };

        const recalcScore = () => {
        // Pas de compétence sélectionnée -> on ne calcule rien
        if (!state.selectedCompetenceId) return;

        let enabledCount = 0;
        let sum = 0;
        let filledCount = 0;

        for (let i = 1; i <= 4; i++) {
            const labelEl = $(`ep_critLabel${i}`);
            const tr = labelEl ? labelEl.closest("tr") : null;
            const sel = $(`ep_critNote${i}`);

            // Critère actif = ligne visible + select non désactivé
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

        const coef = computeCoef(enabledCount);
        setText("ep_scoreCoef", coef ? String(coef) : "—");

        // Si aucune note encore saisie: on garde propre
        if (filledCount === 0) {
            setText("ep_scoreRaw", "—");
            setText("ep_score24", "—");
            setText("ep_levelABC", "—");
            return;
        }

        setText("ep_scoreRaw", String(sum));

        const score24 = coef ? Math.round(sum * coef * 10) / 10 : null;
        setText("ep_score24", (score24 !== null) ? String(score24) : "—");

        // Niveau: seulement quand toutes les notes des critères actifs sont renseignées
        if (enabledCount > 0 && filledCount === enabledCount && score24 !== null) {
            setText("ep_levelABC", computeLevel(score24));
        } else {
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
              msg.style.display = "inline-block";
              msg.textContent = text || "";
              msg.style.fontWeight = "600";
              msg.style.whiteSpace = "nowrap";
              msg.style.padding = "6px 10px";
              msg.style.borderRadius = "10px";
              msg.style.border = "1px solid " + (isOk ? "#0a7a2f" : "#b42318");
              msg.style.background = isOk ? "rgba(10,122,47,.08)" : "rgba(180,35,24,.08)";
              msg.style.color = isOk ? "#0a7a2f" : "#b42318";
            };

            const clearMsg = () => {
              if (!msg) return;
              msg.style.display = "none";
              msg.textContent = "";
            };

            try {
              clearMsg();
              btnSave.disabled = true;

              await saveCurrentAudit();

              setMsg(true, "Audit enregistré avec succès");
            } catch (e) {
              const reason = String(e?.message || e || "").trim();
              setMsg(false, `Échec de l'enregistrement - ${reason || "raison inconnue"}`);
            } finally {
              btnSave.disabled = false;
            }
          });
        }

        
        const btnFinalize = $("ep_btnFinalize");
        if (btnFinalize) btnFinalize.addEventListener("click", () => _portal && _portal.showAlert("", "Squelette", "Finalisation (à implémenter)."));

        const btnGen = $("ep_btnGenerateSummary");
        if (btnGen) btnGen.addEventListener("click", () => _portal && _portal.showAlert("", "Squelette", "Génération synthèse (à implémenter)."));

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

    // Alignement UI (si tes champs existent)
    if (document.getElementById("ep_scoreRaw")) document.getElementById("ep_scoreRaw").textContent = String(sum);
    if (document.getElementById("ep_scoreCoef")) document.getElementById("ep_scoreCoef").textContent = String(coef);
    if (document.getElementById("ep_score24")) document.getElementById("ep_score24").textContent = String(score24);
    if (document.getElementById("ep_levelABC")) document.getElementById("ep_levelABC").textContent = niveau_actuel;

    const observation = (document.getElementById("ep_txtObservation")?.value || "").trim();

    const payload = {
      id_effectif_competence,
      id_comp,
      resultat_eval: score24,
      niveau_actuel,
      observation: observation || null,
      criteres: criteres.map(x => ({
        code_critere: x.code_critere,
        niveau: x.niveau,
        commentaire: x.commentaire
      })),
      methode_eval: "Entretien de performance",
    };

    const url = `${_portal.apiBase}/skills/entretien-performance/audit/${encodeURIComponent(_portal.contactId)}`;
    return await _portal.apiJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  window.SkillsEntretienPerformance = { onShow };
})();
