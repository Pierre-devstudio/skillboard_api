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
    if (txtSearchComp) txtSearchComp.disabled = !(scopeOk && !!state.selectedCollaborateurId);

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
                    domEl.style.color = "#fff";
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
                  const evals = (evalsRaw || []).map(v => (v ?? "").toString().trim()).filter(v => v.length);

                  const enabled = !!key && (evals.length > 0 || nom.length > 0);

                  setText(`ep_critLabel${i}`, enabled ? (nom || key) : "—");
                  setDisabled(`ep_critNote${i}`, !enabled);
                  setDisabled(`ep_critCom${i}`, !enabled);

                  if (enabled) nbEnabled += 1;
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
    if (btnSave) btnSave.addEventListener("click", () => _portal && _portal.showAlert("", "Squelette : Enregistrement (à implémenter)."));

    const btnSaveNext = $("ep_btnSaveNext");
    if (btnSaveNext) btnSaveNext.addEventListener("click", () => _portal && _portal.showAlert("", "Squelette", "Enregistrer + suivant (à implémenter)."));

    const btnReview = $("ep_btnMarkReview");
    if (btnReview) btnReview.addEventListener("click", () => _portal && _portal.showAlert("", "Squelette", "Marquer à revoir (à implémenter)."));

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

  window.SkillsEntretienPerformance = { onShow };
})();
