/* ======================================================
   static/menus/skills_entretien_performance.js
   - Menu "Entretien de performance"
   - Squelette + chargement périmètre (services) + collaborateurs
   - Réutilisé aussi en mode embarqué dans Studio > Espace de gestion.
   - Toute évolution de cette page doit préserver :
     1) l'accès Insights classique /skills/entretien-performance/... ;
     2) l'accès Studio embarqué avec contexte id_owner + id_ent ;
     3) la traçabilité évaluateur : tbl_effectif_client côté Insights, tbl_utilisateur côté Studio.
   ====================================================== */
(function () {
  "use strict";

  const VIEW = "entretien-performance";
  const LS_KEY_SERVICE = "sb_ep_service";
  const LS_KEY_FILTERS_OPEN = "sb_ep_filters_open";

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
    pendingPreselectCollaborateurId: "",
    pendingPreselectServiceId: "",
    pendingPreselectEntretienId: "",
    pendingPreselectFallbackAll: false,
    _collabLoadSeq: 0,
    _collabLoadingKey: "",
    collabExpanded: false,
    _collaborateursAll: [],
    _punctualShowAllCompetences: false,
    _punctualHistoryShowAllCompetences: false,
    _annualHistoryShowAll: false,
    selectedCompetenceId: null,
    selectedEffectifCompetenceId: null,
    scoring: null,
    selectedEntretienId: null,
    _entretiensList: [],
    _entretienDraft: null,
    _entretienAuditContext: null,
    _entretienModalMode: "preparation",
    _entretienDocFile: null,
    _entretienCatalogueRole: "",
    _entretienCatalogueAll: null,
    _entretienCatalogueSelected: new Set(),
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

  function normalizeEmbeddedOrganisationOptions(portal) {
    const rows = Array.isArray(portal?.evaluationOrganisations) ? portal.evaluationOrganisations : [];
    return rows
      .map(r => ({
        id_ent: (r?.id_ent || r?.id || "").toString().trim(),
        label: (r?.label || r?.nom_ent || "Organisation").toString().trim(),
        depth: Number(r?.depth || 0) || 0,
        type_entreprise: (r?.type_entreprise || "").toString().trim(),
      }))
      .filter(r => r.id_ent);
  }

  function applyEmbeddedOrganisationOptions(portal) {
    const wrap = $("ep_orgWrap");
    const select = $("ep_selOrganisation");
    if (!wrap || !select) return;

    const rows = normalizeEmbeddedOrganisationOptions(portal);
    if (rows.length <= 1) {
      wrap.style.display = "none";
      select.innerHTML = "";
      if (rows.length === 1) {
        const opt = document.createElement("option");
        opt.value = rows[0].id_ent;
        opt.textContent = rows[0].label;
        select.appendChild(opt);
        select.value = rows[0].id_ent;
      }
      return;
    }

    const requested = (portal?.evaluationOrganisationValue || rows[0]?.id_ent || "").toString().trim();
    select.innerHTML = "";
    rows.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id_ent;
      const indent = r.depth > 0 ? `${"— ".repeat(Math.min(r.depth, 4))}` : "";
      const type = r.type_entreprise ? ` · ${r.type_entreprise}` : "";
      opt.textContent = `${indent}${r.label}${type}`;
      select.appendChild(opt);
    });

    select.value = rows.some(r => r.id_ent === requested) ? requested : rows[0].id_ent;
    wrap.style.display = "";
  }

  function currentEmbeddedOrganisationValue(portal) {
    const select = $("ep_selOrganisation");
    const fallback = (portal?.evaluationOrganisationValue || portal?.evaluationEntId || "").toString().trim();
    return (select?.value || fallback || "").toString().trim();
  }

  function bindEmbeddedOrganisationFilterOnce(portal) {
    const select = $("ep_selOrganisation");
    if (!select || state._embeddedOrgBound) return;

    state._embeddedOrgBound = true;
    select.addEventListener("change", async () => {
      try {
        const idEnt = currentEmbeddedOrganisationValue(portal);
        if (typeof portal?.onEvaluationOrganisationChange === "function") {
          await portal.onEvaluationOrganisationChange(idEnt);
        }

        localStorage.removeItem(LS_KEY_SERVICE);
        state.serviceId = "";
        state.population = "team";
        state.selectedCollaborateurId = null;
        state.selectedCollaborateurServiceId = "";
        state.selectedCompetenceId = null;
        state.selectedEntretienId = null;

        clearCollaborateurs();
        clearCompetences();
        resetContextPanel();
        resetEvaluationPanel();
        applyUiLockedState();

        await loadServices();
        const selService = $("ep_selService");
        state.serviceId = (selService?.value || "").trim();
        if (state.serviceId) {
          await loadCollaborateurs();
        }
      } catch (e) {
        portal?.showAlert?.("error", "Erreur changement organisation : " + String(e?.message || e));
      }
    });
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


  function epEvaluationNoteLabel(value) {
    const n = Number(value);
    if (n === 1) return "Débutant";
    if (n === 2) return "Intermédiaire";
    if (n === 3) return "Avancé";
    if (n === 4) return "Expert";
    return "—";
  }

  function epApplyEvaluationNoteLabels() {
    for (let i = 1; i <= 4; i++) {
      const sel = $(`ep_critNote${i}`);
      if (!sel) continue;

      Array.from(sel.options || []).forEach(opt => {
        const value = (opt.value || "").toString().trim();
        if (!value) {
          opt.textContent = "—";
          return;
        }

        opt.textContent = epEvaluationNoteLabel(value);
      });
    }
  }

  function epUpdateMasteryGauge(value) {
    const gauge = $("ep_masteryGauge");
    if (!gauge) return;

    const raw = (value ?? $("ep_scorePct")?.textContent ?? "").toString();
    const match = raw.match(/-?\d+(?:[,.]\d+)?/);
    const pct = match ? Number(match[0].replace(",", ".")) : NaN;

    if (!Number.isFinite(pct)) {
      gauge.classList.add("is-empty");
      gauge.style.removeProperty("--ep-mastery-pct");
      gauge.setAttribute("aria-hidden", "true");
      return;
    }

    const safePct = Math.max(0, Math.min(100, pct));
    gauge.classList.remove("is-empty");
    gauge.style.setProperty("--ep-mastery-pct", `${safePct}%`);
    gauge.setAttribute("aria-hidden", "false");
    gauge.setAttribute("aria-label", `Maîtrise ${Math.round(safePct)} %`);
  }

  function epSetScorePct(value) {
    setText("ep_scorePct", value);
    epUpdateMasteryGauge(value);
  }

  // ------------------------------------------------------
  // Couverture poste: modal détail (réutilise state._covData)
  // ------------------------------------------------------
  function _epGetCovWeightedFlag() {
    return true;
  }

  function _nsLevelKey4(v) {
    const raw = String(v ?? "").trim();
    const norm = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (!norm || norm === "-" || norm === "—") return "";
    if (norm === "a" || norm.includes("initial") || norm.includes("debutant")) return "A";
    if (norm === "b" || norm.includes("intermediaire") || norm.includes("interm")) return "B";
    if (norm === "c" || norm.includes("avance") || norm.includes("advanced")) return "C";
    if (norm === "d" || norm.includes("expert")) return "D";
    return "";
  }

  function _nsLevelLabel4(v) {
    const k = _nsLevelKey4(v);
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" })[k] || (String(v ?? "").trim() || "—");
  }

  function _nsLevelCodeFromScore24(score) {
    const s = Number(score);
    if (!Number.isFinite(s) || s <= 0) return "";
    if (s <= 6) return "A";
    if (s <= 12) return "B";
    if (s <= 18) return "C";
    return "D";
  }

  function _nsLevelKey4(value) {
    const raw = (value === null || value === undefined) ? "" : String(value).trim();
    const norm = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!norm || norm === "-" || norm === "—") return "";
    if (norm === "a" || norm.includes("initial") || norm.includes("debutant")) return "A";
    if (norm === "b" || norm.includes("intermediaire") || norm.includes("interm")) return "B";
    if (norm === "c" || norm.includes("avance")) return "C";
    if (norm === "d" || norm.includes("expert")) return "D";
    return "";
  }

  function _nsLevelLabel4(value) {
    const k = _nsLevelKey4(value);
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" })[k] || ((value === null || value === undefined || String(value).trim() === "") ? "—" : String(value).trim());
  }

  function _nsLevelCodeFromPct(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return "";
    if (p <= 25) return "A";
    if (p <= 50) return "B";
    if (p <= 75) return "C";
    return "D";
  }

  function _nsLevelLabelFromPct(pct) {
    return _nsLevelLabel4(_nsLevelCodeFromPct(pct));
  }

  function _epScoreInfoFromAudit(row) {
    let detail = row?.detail_eval;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch (_) { detail = {}; }
    }
    if (!detail || typeof detail !== "object") detail = {};

    const criteres = Array.isArray(detail.criteres) ? detail.criteres : [];
    let sum = 0;
    let count = 0;

    criteres.forEach(c => {
      const raw = c?.niveau ?? c?.note;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 1 && n <= 4) {
        sum += n;
        count += 1;
      }
    });

    if (count > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((sum / (count * 4)) * 100)));
      const score24 = Math.round(((sum / (count * 4)) * 24) * 10) / 10;
      return {
        sum,
        count,
        pct,
        score24,
        levelCode: _nsLevelCodeFromPct(pct),
        levelLabel: _nsLevelLabelFromPct(pct),
      };
    }

    const score = Number(row?.resultat_eval);
    if (Number.isFinite(score)) {
      const pct = Math.max(0, Math.min(100, Math.round((score / 24) * 100)));
      return {
        sum: null,
        count: 0,
        pct,
        score24: score,
        levelCode: _nsLevelCodeFromPct(pct),
        levelLabel: _nsLevelLabelFromPct(pct),
      };
    }

    return { sum: null, count: 0, pct: null, score24: null, levelCode: "", levelLabel: "—" };
  }

  function _epLevelFromScore24(score) {
    const s = Number(score);
    if (!Number.isFinite(s) || s <= 0) return "—";
    const pct = Math.max(0, Math.min(100, Math.round((s / 24) * 100)));
    return _nsLevelLabelFromPct(pct);
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
          <div><span class="ns-badge sb-badge sb-badge-accent">${code || "—"}</span></div>
          <div style="margin-top:4px; font-size:var(--ns-text-sm, 0.8125rem);">${intitule || "—"}</div>
        </div>
      `;

      const tdPoids = document.createElement("td");
      tdPoids.className = "col-center";
      tdPoids.textContent = poids || "—";

      const tdReq = document.createElement("td");
      tdReq.className = "col-center";
      tdReq.innerHTML = niveauRequis ? `<span class="ns-badge sb-badge">${niveauRequis}</span>` : "—";

      const tdSal = document.createElement("td");
      tdSal.className = "col-center";
      tdSal.innerHTML = (niveauSalarie && niveauSalarie !== "—") ? `<span class="ns-badge sb-badge">${niveauSalarie}</span>` : "—";

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
        <div style="font-weight:var(--ns-weight-semibold, 600);">Guide de notation</div>
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
            badge.textContent = epEvaluationNoteLabel(i);
            badge.style.minWidth = "104px";
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
    setText("ep_ctxInitials", "—");
    setText("ep_ctxMatricule", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
    setText("ep_ctxServiceBadge", "Service non renseigné");
    setText("ep_ctxDate", "—");
    state._annualHistoryShowAll = false;
    epRenderAnnualCompetenceSummary([]);
    epRenderEntretienOverview([]);
  }


  function clearCompetences() {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (tbody) tbody.innerHTML = "";
    setText("ep_compCount", "0");
    state.selectedCompetenceId = null;
    state.selectedEffectifCompetenceId = null;
    state._punctualShowAllCompetences = false;
    state._punctualHistoryShowAllCompetences = false;
    state._annualHistoryShowAll = false;
    state._checklistAll = [];
    state._historyAll = [];
    epRenderPunctualHistorySummary([]);
  }

  function readPendingCollaborateurPreselect() {
    let idEff = "";
    let idService = "";
    let idEntretien = "";

    try {
      idEff = (
        window.sessionStorage.getItem("skills_ep_preselect_id_effectif") ||
        window.sessionStorage.getItem("ep_preselect_id_effectif") ||
        window.sessionStorage.getItem("novoskill_ep_preselect_id_effectif") ||
        ""
      ).toString().trim();

      idService = (
        window.sessionStorage.getItem("skills_ep_preselect_id_service") ||
        window.sessionStorage.getItem("ep_preselect_id_service") ||
        ""
      ).toString().trim();

      idEntretien = (
        window.sessionStorage.getItem("skills_ep_preselect_id_entretien") ||
        window.sessionStorage.getItem("ep_preselect_id_entretien") ||
        ""
      ).toString().trim();
    } catch (_) {}

    if (!idEff) return false;

    state.pendingPreselectCollaborateurId = idEff;
    state.pendingPreselectServiceId = idService;
    state.pendingPreselectEntretienId = idEntretien;
    state.pendingPreselectFallbackAll = false;

    const search = $("ep_txtSearchCollab");
    if (search) search.value = "";

    return true;
  }

  function clearPendingCollaborateurPreselect() {
    state.pendingPreselectCollaborateurId = "";
    state.pendingPreselectServiceId = "";
    state.pendingPreselectFallbackAll = false;

    try {
      window.sessionStorage.removeItem("skills_ep_preselect_id_effectif");
      window.sessionStorage.removeItem("skills_ep_preselect_nom");
      window.sessionStorage.removeItem("skills_ep_preselect_id_service");
      window.sessionStorage.removeItem("skills_ep_preselect_id_entretien");
      window.sessionStorage.removeItem("ep_preselect_id_effectif");
      window.sessionStorage.removeItem("ep_preselect_id_service");
      window.sessionStorage.removeItem("ep_preselect_id_entretien");
      window.sessionStorage.removeItem("novoskill_ep_preselect_id_effectif");
    } catch (_) {}
  }

  function escapeCssValue(value) {
    const s = String(value || "");
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function setServiceForCollaborateurPreselect(idService) {
    const selService = $("ep_selService");
    if (!selService || !window.portal?.serviceFilter) return false;

    const wanted = String(idService || "").trim() || window.portal.serviceFilter.ALL_ID;
    const exists = Array.from(selService.options || []).some(opt => String(opt.value || "") === wanted);
    const target = exists ? wanted : window.portal.serviceFilter.ALL_ID;

    if (String(selService.value || "") !== target) {
      selService.value = target;
    }

    state.serviceId = window.portal.serviceFilter.normalizeId(target || "");
    return !!state.serviceId;
  }

  function applyPendingCollaborateurPreselect() {
    const idEff = String(state.pendingPreselectCollaborateurId || "").trim();
    if (!idEff) return false;

    const wrap = $("ep_listCollaborateurs");
    if (!wrap) return false;

    const safeId = escapeCssValue(idEff);
    const btn = wrap.querySelector(`.ep-collab-card[data-id-effectif="${safeId}"]`);

    if (btn) {
      btn.click();
      clearPendingCollaborateurPreselect();
      return true;
    }

    if (!state.pendingPreselectFallbackAll && window.portal?.serviceFilter?.ALL_ID) {
      state.pendingPreselectFallbackAll = true;
      const selService = $("ep_selService");
      const allId = window.portal.serviceFilter.ALL_ID;

      if (selService && String(selService.value || "") !== allId) {
        selService.value = allId;
        state.serviceId = window.portal.serviceFilter.normalizeId(allId);
        loadCollaborateurs();
      }
    }

    return false;
  }

  function preselectCollaborateurFromExternal(detail) {
    const idEff = String(detail?.id_effectif || detail?.idEffectif || detail?.id_collaborateur || "").trim();
    if (!idEff) return;

    const idService = String(detail?.id_service || detail?.serviceId || "").trim();
    const idEntretien = String(detail?.id_entretien || detail?.idEntretien || "").trim();
    const samePending =
      String(state.pendingPreselectCollaborateurId || "") === idEff &&
      String(state.pendingPreselectServiceId || "") === idService &&
      String(state.pendingPreselectEntretienId || "") === idEntretien;

    state.pendingPreselectCollaborateurId = idEff;
    state.pendingPreselectServiceId = idService;
    state.pendingPreselectEntretienId = idEntretien;
    state.pendingPreselectFallbackAll = false;

    const search = $("ep_txtSearchCollab");
    if (search && search.value) search.value = "";

    if ($("view-entretien-performance")?.style.display !== "none") {
      if (state.pendingPreselectServiceId) {
        setServiceForCollaborateurPreselect(state.pendingPreselectServiceId);
      }
      if (state.serviceId && !samePending) {
        loadCollaborateurs();
      }
    }
  }

  function resetContextPanel() {
    setText("ep_ctxStatus", "Brouillon");
    setText("ep_ctxCollaborateur", "—");
    setText("ep_ctxInitials", "—");
    setText("ep_ctxMatricule", "—");
    setText("ep_ctxPoste", "—");
    setText("ep_ctxService", "—");
    setText("ep_ctxServiceBadge", "Service non renseigné");
    setText("ep_ctxDate", "—");

    epRenderAnnualCompetenceSummary([]);
    epRenderEntretienOverview([]);

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
    epSetScorePct("—");
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

  function epHistoryEvaluatorName(row) {
    return (row?.nom_evaluateur || row?.id_evaluateur || "Non affecté").toString().trim() || "Non affecté";
  }

  function epHistoryMethodName(row) {
    return (row?.methode_eval || row?.source_eval || "Entretien de performance").toString().trim() || "Entretien de performance";
  }

  function epExtractHistoryCriteres(row) {
    let detail = row?.detail_eval;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch (_) { detail = {}; }
    }
    if (!detail || typeof detail !== "object") detail = {};

    const criteres = Array.isArray(detail.criteres) ? detail.criteres : [];
    return criteres
      .map(c => ({
        code_critere: (c?.code_critere || "").toString().trim(),
        niveau: c?.niveau ?? c?.note,
        commentaire: (c?.commentaire || "").toString()
      }))
      .filter(c => c.code_critere && c.niveau !== null && c.niveau !== undefined);
  }

  async function epLoadEvaluationReferentielData(idComp) {
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
  }

  function epSetSelectValueOrAdd(selectId, value) {
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
  }

  async function epOpenHistoryEvaluationDetail(row, context) {
    if (!row) return;

    const code = (row.code || "").toString().trim();
    const intitule = (row.intitule || "").toString().trim();
    const scoreInfo = _epScoreInfoFromAudit(row);
    const niveau = scoreInfo.levelLabel;
    const lastDate = epFormatDateFR(row.date_audit) || "—";
    const method = epHistoryMethodName(row);
    const obs = (row.observation || "").toString();
    const evaluatorName = (context?.evaluatorName || epHistoryEvaluatorName(row)).toString().trim() || "Non affecté";

    resetEvaluationPanel();

    const canEditHistoryAudit = row.modifiable === true;

    state._historyAuditEditing = {
      id_audit_competence: (row.id_audit_competence || "").toString().trim(),
      id_effectif_competence: (row.id_effectif_competence || "").toString().trim(),
      id_comp: (row.id_comp || "").toString().trim(),
      canEdit: !!canEditHistoryAudit,
      row,
    };

    state.selectedEffectifCompetenceId = state._historyAuditEditing.id_effectif_competence;
    state.selectedCompetenceId = state._historyAuditEditing.id_comp;

    const evalModal = $("modalEpEvaluation");
    if (evalModal) {
      evalModal.classList.add("is-history-readonly");
      evalModal.classList.toggle("is-history-editable", !!canEditHistoryAudit);
    }

    setText("ep_evalHint", `Historique du ${lastDate} · évaluateur : ${evaluatorName}${canEditHistoryAudit ? "" : " · consultation seule"}`);

    const refData = await epLoadEvaluationReferentielData(row.id_comp);

    renderEvalCompetenceTitle(code, intitule);
    renderEvalDomainBadge(refData?.domaine?.label || "", refData?.domaine?.couleur || "");

    setText("ep_compCurrent", niveau);
    setText("ep_compLastEval", lastDate ? `Dernière éval : ${lastDate}` : "");
    setText("ep_levelABC", niveau);
    setText("ep_scoreRaw", scoreInfo.sum === null ? "—" : String(scoreInfo.sum));
    epSetScorePct(scoreInfo.pct === null ? "—" : `${scoreInfo.pct}%`);

    epSetSelectValueOrAdd("ep_selEvalMethod", method);
    setDisabled("ep_selEvalMethod", !canEditHistoryAudit);

    const obsEl = $("ep_txtObservation");
    if (obsEl) obsEl.value = obs || "";
    setDisabled("ep_txtObservation", !canEditHistoryAudit);

    const criteres = epExtractHistoryCriteres(row);

    for (let i = 1; i <= 4; i++) {
      const labelEl = $(`ep_critLabel${i}`);
      const tr = labelEl ? labelEl.closest("tr") : null;
      const note = $(`ep_critNote${i}`);
      const com = $(`ep_critCom${i}`);

      const codeCrit = `Critere${i}`;
      const crit = criteres.find(c => c.code_critere === codeCrit);

      if (!crit) {
        if (tr) tr.style.display = "none";
        if (labelEl) labelEl.textContent = "";
        if (note) note.value = "";
        if (com) com.value = "";
        setDisabled(`ep_critNote${i}`, true);
        setDisabled(`ep_critCom${i}`, true);
        continue;
      }

      if (tr) tr.style.display = "";
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

    tr.dataset.neverAudited = "0";

    const levelTxt = (document.getElementById("ep_levelABC")?.textContent || "").toString().trim();
    const levelBadge = tr.querySelector(".ep-comp-level-badge");

    if (levelBadge && levelTxt && levelTxt !== "—") {
      levelBadge.textContent = _nsLevelLabel4(levelTxt);
      levelBadge.className = `sb-badge ep-comp-level-badge ${getEpLevelBadgeClass(levelTxt)}`;
    }
  }

  function _recalcKpiToDoFallbackFromDOM() {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll("tr"));
    const total = rows.length;

    const never = rows.filter(r => (r.dataset.neverAudited || "0") === "1").length;

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


  function epNormText(value) {
    return (value || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function epStatusSlug(value) {
    return epNormText(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "neutre";
  }

  function epDateObj(value) {
    const raw = (value || "").toString().trim();
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function epMonthsSince(value) {
    const d = epDateObj(value);
    if (!d) return null;
    const now = new Date();
    return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  }

  function epCompetenceStatusKey(x) {
    if (!x || x._neverAudited || !x.date_derniere_eval) return "never";
    const months = epMonthsSince(x.date_derniere_eval);
    if (Number.isFinite(months) && months >= 24) return "review";
    return "ok";
  }

  function epCompetenceStatusLabel(key) {
    if (key === "never") return "Jamais évaluée";
    if (key === "review") return "À revoir";
    return "À jour";
  }

  function epCompetenceStatusBadgeClass(key) {
    if (key === "never") return "ep-status-badge ep-status-badge--danger";
    if (key === "review") return "ep-status-badge ep-status-badge--warning";
    return "ep-status-badge ep-status-badge--success";
  }

  function epBadgeLevelHtml(niveau) {
    const txt = _nsLevelLabel4(niveau || "—");
    return `<span class="ns-badge sb-badge ep-comp-level-badge ${getEpLevelBadgeClass(niveau)}">${epEsc(txt)}</span>`;
  }

  async function epFetchCompetencePdfBlobFromPunctual(item) {
    const idEffectif = (state.selectedCollaborateurId || "").toString().trim();
    const idComp = (item?.id_comp || "").toString().trim();

    if (!_portal?.apiBase || !_portal?.contactId || !idEffectif || !idComp) {
      throw new Error("Collaborateur ou compétence introuvable pour la fiche PDF.");
    }

    const url = `${_portal.apiBase}/skills/collaborateurs/competences/fiche_pdf/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEffectif)}/${encodeURIComponent(idComp)}?_=${Date.now()}`;
    const headers = new Headers();

    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      let msg = `Erreur PDF (${resp.status})`;
      try {
        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const body = await resp.json();
          msg = body?.detail || body?.message || JSON.stringify(body);
        } else {
          msg = await resp.text() || msg;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    return await resp.blob();
  }

  function epRenderPdfBlobInWindow(popupWin, blob, title) {
    const win = popupWin && !popupWin.closed ? popupWin : window.open("about:blank", "_blank");
    if (!win) throw new Error("Ouverture du PDF bloquée par le navigateur.");

    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = epEsc(title || "Fiche compétence");

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    html,body{height:100%;margin:0;background:#f3f4f6;}
    iframe{width:100%;height:100%;border:0;background:#fff;}
  </style>
</head>
<body>
  <iframe src="${blobUrl}" title="${safeTitle}"></iframe>
</body>
</html>`);
    win.document.close();

    const revoke = () => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    };
    try { win.addEventListener("beforeunload", revoke, { once:true }); } catch (_) {}
    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function epOpenCompetencePdfFromPunctual(item) {
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      try { popup.document.write("<p style='font-family:var(--ns-font-ui);padding:16px;'>Ouverture du PDF…</p>"); } catch (_) {}
    }

    try {
      const blob = await epFetchCompetencePdfBlobFromPunctual(item);
      const code = (item?.code || "").toString().trim();
      const title = `Fiche compétence - ${code ? `${code} - ` : ""}${(item?.intitule || "Compétence").toString().trim()}`;
      epRenderPdfBlobInWindow(popup, blob, title);
    } catch (e) {
      try { if (popup && !popup.closed) popup.close(); } catch (_) {}
      _portal?.showAlert?.("warning", String(e?.message || e || "Impossible d’ouvrir le PDF."));
    }
  }

  function epSetBadgeText(id, textValue) {
    const el = $(id);
    if (!el) return;
    const txt = (textValue || "—").toString().trim() || "—";
    el.textContent = txt;
    el.className = `sb-badge ep-entretien-status ep-entretien-status--${epStatusSlug(txt)}`;
  }

  function epPreparationRaw(entretien) {
    const prep = entretien && typeof entretien.preparation === "object" && entretien.preparation !== null
      ? entretien.preparation
      : {};
    return prep;
  }

  function epPreparationHasContent(preparation) {
    const prep = preparation && typeof preparation === "object" ? preparation : {};
    return [prep.notes, prep.points, prep.commentaire, prep.synthese]
      .some(v => (v || "").toString().trim());
  }

  function epPreparationState(entretien) {
    const prep = epPreparationRaw(entretien);
    const raw = epNormText(prep.statut || prep.status || prep.etat || "");
    const validationAuto = prep.validation_auto === true || epNormText(prep.validation_auto || "") === "true";
    const validated = raw === "validee"
      || raw === "prepare"
      || raw === "prepared"
      || !!prep.date_validation
      || !!prep.date_validation_auto;

    if (validated) {
      return {
        key: validationAuto ? "validee_auto" : "validee",
        label: "Préparé",
        done: true,
        inProgress: false,
        validationAuto,
        dateValidation: prep.date_validation_auto || prep.date_validation || "",
      };
    }

    const opened = raw === "en-cours"
      || raw === "en_cours"
      || raw === "en cours"
      || !!prep.date_ouverture
      || epPreparationHasContent(prep);

    if (opened) {
      return {
        key: "en_cours",
        label: "En cours",
        done: false,
        inProgress: true,
        validationAuto: false,
        dateOuverture: prep.date_ouverture || "",
      };
    }

    return {
      key: "a_preparer",
      label: "À préparer",
      done: false,
      inProgress: false,
      validationAuto: false,
    };
  }

  function epStepBadgeSvg(kind) {
    if (kind === "progress") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-3b373ae03afc"></use></svg>`;
    }
    return `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-98205e667665"></use></svg>`;
  }

  function epSetAnnualStepState(el, stepState) {
    if (!el) return;

    const key = stepState || "pending";
    el.classList.toggle("is-done", key === "done");
    el.classList.toggle("is-in-progress", key === "progress");
    el.classList.toggle("is-pending", key === "pending");

    const badge = el.querySelector(".ep-step-done-badge");
    if (badge) badge.innerHTML = epStepBadgeSvg(key === "progress" ? "progress" : "done");
  }

  function epCurrentActorId() {
    return (_portal?.contactId || "").toString().trim();
  }

  function epBuildPreparationPayload(basePreparation, statusMode) {
    const previous = basePreparation && typeof basePreparation === "object" ? basePreparation : {};
    const prep = { ...previous };
    const now = new Date().toISOString();
    const actorId = epCurrentActorId();

    prep.notes = epGetValue("ep_entretienPrepNotes");
    prep.points = epGetValue("ep_entretienPrepPoints");

    const currentState = epPreparationState({ preparation: previous });

    if (statusMode === "en_cours") {
      if (!currentState.done) {
        prep.statut = "en_cours";
        if (!prep.date_ouverture) prep.date_ouverture = now;
        if (!prep.id_ouvreur && actorId) prep.id_ouvreur = actorId;
      }
    } else if (statusMode === "validee") {
      prep.statut = "validee";
      prep.validation_auto = false;
      prep.date_validation = now;
      if (actorId) prep.id_validateur = actorId;
      if (!prep.date_ouverture) prep.date_ouverture = now;
      if (!prep.id_ouvreur && actorId) prep.id_ouvreur = actorId;
    } else if (statusMode === "auto_validee") {
      if (!currentState.done) {
        prep.statut = "validee";
        prep.validation_auto = true;
        prep.validation_auto_source = "realisation_entretien";
        prep.date_validation_auto = now;
        prep.date_validation = prep.date_validation || now;
        if (actorId) {
          prep.id_validateur_auto = actorId;
          prep.id_validateur = prep.id_validateur || actorId;
        }
        if (!prep.date_ouverture) prep.date_ouverture = now;
        if (!prep.id_ouvreur && actorId) prep.id_ouvreur = actorId;
      }
    }

    return prep;
  }

  function epBuildPreparationPayloadFromEntretien(entretien, statusMode) {
    const previous = epPreparationRaw(entretien);
    const prep = { ...previous };
    const now = new Date().toISOString();
    const actorId = epCurrentActorId();
    const currentState = epPreparationState(entretien);

    if (statusMode === "en_cours" && !currentState.done) {
      prep.statut = "en_cours";
      if (!prep.date_ouverture) prep.date_ouverture = now;
      if (!prep.id_ouvreur && actorId) prep.id_ouvreur = actorId;
    }

    return prep;
  }

  function epBuildEntretienPayloadFromItem(entretien, statusMode) {
    return {
      type_entretien: entretien?.type_entretien || "Entretien annuel",
      statut: entretien?.statut || "à réaliser",
      date_prevue: entretien?.date_prevue || null,
      date_realisee: entretien?.date_realisee || null,
      periode_debut: entretien?.periode_debut || null,
      periode_fin: entretien?.periode_fin || null,
      preparation: epBuildPreparationPayloadFromEntretien(entretien, statusMode),
      realisation: entretien?.realisation || {},
      competences_entretien: Array.isArray(entretien?.competences_entretien) ? entretien.competences_entretien : [],
      documents: entretien?.documents || {},
      synthese: entretien?.synthese || {},
    };
  }

  function epIsAnnualEntretien(entretien) {
    return epNormText(entretien?.type_entretien || "").includes("annuel");
  }

  function epEntretienDateValue(entretien) {
    return (entretien?.date_realisee || entretien?.date_prevue || entretien?.created_at || "").toString().trim();
  }

  function epSortEntretienDesc(a, b) {
    const da = epDateObj(epEntretienDateValue(a));
    const db = epDateObj(epEntretienDateValue(b));
    const ta = da ? da.getTime() : 0;
    const tb = db ? db.getTime() : 0;
    return tb - ta;
  }

  function epIsEntretienClosed(entretien) {
    const s = epNormText(entretien?.statut || "");
    return s.includes("termine") || s.includes("signe");
  }

  function epCurrentAnnualEntretien(list) {
    const annuals = (Array.isArray(list) ? list : []).filter(epIsAnnualEntretien).sort(epSortEntretienDesc);
    return annuals.find(e => !epIsEntretienClosed(e)) || null;
  }

  function epRenderAnnualCompetenceSummary(list) {
    const arr = Array.isArray(list) ? list : [];
    const never = arr.filter(x => epCompetenceStatusKey(x) === "never").length;
    const review = arr.filter(x => epCompetenceStatusKey(x) === "review").length;
    const critical = arr.filter(x => getEpCritPctValue(x?.poids_criticite_pct) > 0).length;

    setText("ep_annualMetricNever", String(never));
    setText("ep_annualMetricReview", String(review));
    setText("ep_annualMetricCritical", String(critical));
  }

  function epRenderPunctualCompetenceRows(list) {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    state._punctualShowAllCompetences = false;

    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="ep-empty-cell">Aucune compétence disponible pour ce collaborateur.</td></tr>`;
      epUpdatePunctualMoreButton(0, 0);
      return;
    }

    arr.forEach(x => {
      const tr = document.createElement("tr");
      const statusKey = epCompetenceStatusKey(x);
      const critPct = getEpCritPctValue(x?.poids_criticite_pct);

      tr.dataset.idEffectifCompetence = x.id_effectif_competence || "";
      tr.dataset.idComp = x.id_comp || "";
      tr.dataset.critPct = String(critPct);
      tr.dataset.neverAudited = x._neverAudited ? "1" : "0";
      tr.dataset.status = statusKey;
      tr.dataset.searchText = `${x.code || ""} ${x.intitule || ""}`;

      tr.innerHTML = `
        <td class="ep-punctual-code-cell"><span class="ns-badge sb-badge sb-badge-ref-comp-code ep-comp-code">${epEsc(x.code || "—")}</span></td>
        <td><div class="ep-punctual-comp-title" title="${epEsc(x.intitule || "")}">${epEsc(x.intitule || "—")}</div></td>
        <td class="ep-punctual-date-cell">${epEsc(epFormatDateFR(x.date_derniere_eval) || "—")}</td>
        <td class="ep-punctual-level-cell">${epBadgeLevelHtml(x.niveau_actuel || "—")}</td>
        <td class="ep-punctual-status-cell"><span class="${epCompetenceStatusBadgeClass(statusKey)}">${epEsc(epCompetenceStatusLabel(statusKey))}</span></td>
        <td class="ep-punctual-actions-cell">
          <div class="ep-punctual-actions">
            <button type="button" class="sb-icon-btn ep-punctual-action-btn ep-punctual-action-btn--eval" data-eval="1" title="Évaluer" aria-label="Évaluer">
              <svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
            </button>
            <button type="button" class="sb-icon-btn ep-punctual-action-btn ep-punctual-action-btn--pdf" data-pdf="1" title="Fiche compétence PDF" aria-label="Fiche compétence PDF">
              <svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
            </button>
          </div>
        </td>
      `;

      tr.addEventListener("click", async () => {
        const tb = $("ep_tblCompetences")?.querySelector("tbody");
        if (tb) tb.querySelectorAll("tr.active").forEach(r => r.classList.remove("active"));
        tr.classList.add("active");
        await epOpenEvaluationStandalone(x);
      });

      tr.querySelector('[data-eval="1"]')?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        tr.click();
      });

      tr.querySelector('[data-pdf="1"]')?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        epOpenCompetencePdfFromPunctual(x);
      });

      tbody.appendChild(tr);
    });

    epApplyPunctualFilters();
  }

  function epUpdatePunctualMoreButton(visibleTotal, hiddenCount) {
    const btn = $("ep_btnMoreCompetences");
    const label = $("ep_moreCompetencesLabel");
    const wrap = document.querySelector("#view-entretien-performance .ep-comp-table-wrap");
    if (!btn || !label) return;

    const total = Number(visibleTotal || 0);
    const hidden = Math.max(0, Number(hiddenCount || 0));
    const expanded = !!state._punctualShowAllCompetences;
    const hasMore = hidden > 0;

    if (wrap) wrap.classList.toggle("is-expanded", expanded && total > 5);

    btn.style.display = hasMore || expanded ? "" : "none";
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");

    if (expanded) {
      label.textContent = "Voir moins de compétences";
    } else {
      label.textContent = `Voir plus de compétences (${hidden})`;
    }
  }

  function epApplyPunctualFilters() {
    const tbody = $("ep_tblCompetences")?.querySelector("tbody");
    if (!tbody) return;

    const q = epNormText($("ep_txtSearchCompetence")?.value || "");
    const statusBtn = document.querySelector(".ep-status-filter-btn.is-active");
    const status = statusBtn?.dataset?.epStatus || "all";
    const seuil = getEpCriticiteSeuil();

    const matchingRows = [];
    Array.from(tbody.querySelectorAll("tr")).forEach(tr => {
      if (tr.querySelector(".ep-empty-cell")) {
        tr.style.display = "";
        return;
      }

      const hay = epNormText(tr.dataset.searchText || tr.textContent || "");
      const rowStatus = (tr.dataset.status || "").toString().trim();
      const crit = getEpCritPctValue(tr.dataset.critPct || 0);

      const okSearch = !q || hay.includes(q);
      const okStatus = status === "all" || rowStatus === status;
      const okCrit = crit + 0.0001 >= seuil;

      const ok = okSearch && okStatus && okCrit;
      tr.dataset.punctualMatch = ok ? "1" : "0";
      if (ok) matchingRows.push(tr);
      tr.style.display = "none";
    });

    const limit = state._punctualShowAllCompetences ? matchingRows.length : 5;
    matchingRows.forEach((tr, index) => {
      tr.style.display = index < limit ? "" : "none";
    });

    setText("ep_compCount", String(matchingRows.length));
    epUpdatePunctualMoreButton(matchingRows.length, Math.max(0, matchingRows.length - 5));
  }

  function epSetPunctualInnerTab(tab) {
    const target = tab === "historique" ? "historique" : "competences";

    document.querySelectorAll("#view-entretien-performance .ep-punctual-inner-tab").forEach(btn => {
      const active = btn.dataset.epPunctualTab === target;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll("#view-entretien-performance .ep-punctual-inner-panel").forEach(panel => {
      panel.classList.toggle("is-active", panel.dataset.epPunctualPanel === target);
    });

    if (target === "historique") epLoadPunctualHistorySummary();
  }

  function bindPunctualInnerTabsOnce() {
    if (state._punctualInnerTabsBound) return;
    state._punctualInnerTabsBound = true;

    document.querySelectorAll("#view-entretien-performance .ep-punctual-inner-tab").forEach(btn => {
      btn.addEventListener("click", () => epSetPunctualInnerTab(btn.dataset.epPunctualTab || "competences"));
    });
  }

  function epSetPageTab(tab) {
    const target = ["annuel", "ponctuel", "formation"].includes(tab) ? tab : "annuel";

    document.querySelectorAll("#view-entretien-performance .ep-page-tab").forEach(btn => {
      const active = btn.dataset.epTab === target;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll("#view-entretien-performance .ep-tab-panel").forEach(panel => {
      panel.classList.toggle("is-active", panel.dataset.epPanel === target);
    });
  }

  function bindPageTabsOnce() {
    if (state._pageTabsBound) return;
    state._pageTabsBound = true;

    document.querySelectorAll("#view-entretien-performance .ep-page-tab").forEach(btn => {
      btn.addEventListener("click", () => epSetPageTab(btn.dataset.epTab || "annuel"));
    });

    bindPunctualInnerTabsOnce();

    $("ep_btnAnnualSeeCompetences")?.addEventListener("click", () => {
      epSetPageTab("ponctuel");
      epSetPunctualInnerTab("competences");
    });
    $("ep_btnAnnualPrepare")?.addEventListener("click", () => epOpenAnnualEntretien("preparation"));
    $("ep_btnAnnualRealize")?.addEventListener("click", () => epOpenAnnualEntretien("realisation"));
    $("ep_btnAnnualReport")?.addEventListener("click", () => {
      const e = state._annualCurrentEntretien || null;
      if (e?.id_entretien) openEntretienPdf(e.id_entretien);
    });

    $("ep_btnMoreAnnualHistory")?.addEventListener("click", () => {
      state._annualHistoryShowAll = !state._annualHistoryShowAll;
      epRenderAnnualHistory(state._annualHistoryAll || []);
    });

    $("ep_annualLastDate")?.addEventListener("click", () => {
      const e = state._annualLastEntretien || null;
      if (e?.id_entretien) openEntretienModal(e, "realisation");
    });

    $("ep_annualNextDate")?.addEventListener("click", () => epOpenCalendarForAnnualContext());

    $("ep_btnNewPonctuel")?.addEventListener("click", () => epOpenNewPunctualEvaluation());
    $("ep_txtSearchCompetence")?.addEventListener("input", () => {
      state._punctualShowAllCompetences = false;
      epApplyPunctualFilters();
    });

    $("ep_btnMoreCompetences")?.addEventListener("click", () => {
      state._punctualShowAllCompetences = !state._punctualShowAllCompetences;
      epApplyPunctualFilters();
    });

    $("ep_btnMoreHistoryCompetences")?.addEventListener("click", () => {
      state._punctualHistoryShowAllCompetences = !state._punctualHistoryShowAllCompetences;
      epRenderPunctualHistorySummary(state._historyAll || []);
    });

    document.querySelectorAll("#view-entretien-performance .ep-status-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#view-entretien-performance .ep-status-filter-btn").forEach(x => x.classList.remove("is-active"));
        btn.classList.add("is-active");
        state._punctualShowAllCompetences = false;
        epApplyPunctualFilters();
      });
    });
  }

  async function epOpenAnnualEntretien(mode) {
    let entretien = state._annualCurrentEntretien || null;
    const wantedMode = mode || (entretien ? "realisation" : "preparation");

    if (wantedMode === "preparation" && entretien?.id_entretien && epPreparationState(entretien).key === "a_preparer" && _portal) {
      try {
        const payload = epBuildEntretienPayloadFromItem(entretien, "en_cours");
        entretien = await _portal.apiJson(
          `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(entretien.id_entretien)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );
        state._annualCurrentEntretien = entretien;
        state._entretiensList = (Array.isArray(state._entretiensList) ? state._entretiensList : []).map(item =>
          String(item?.id_entretien || "") === String(entretien.id_entretien || "") ? entretien : item
        );
        epRenderEntretienOverview(state._entretiensList);
      } catch (e) {
        _portal?.showAlert?.("warning", String(e?.message || e || "Impossible de marquer la préparation en cours."));
      }
    }

    openEntretienModal(entretien, wantedMode);

    if (!entretien) {
      epSetValue("ep_entretienType", "Entretien annuel");
      if (state._entretienDraft) state._entretienDraft.type_entretien = "Entretien annuel";
      setText("ep_entretienModalTitle", wantedMode === "realisation" ? "Réaliser l’entretien annuel" : "Préparer l’entretien annuel");
    }
  }

  function epOpenNewPunctualEvaluation() {
    const arr = Array.isArray(state._checklistAll) ? state._checklistAll : [];
    if (!arr.length) {
      _portal?.showAlert?.("warning", "Aucune compétence disponible pour ce collaborateur.");
      return;
    }

    const target = arr.find(x => epCompetenceStatusKey(x) === "never") || arr.find(x => epCompetenceStatusKey(x) === "review") || arr[0];
    epOpenEvaluationStandalone(target);
  }

  function epRenderEntretienOverview(list) {
    const arr = Array.isArray(list) ? list : [];
    const annuals = arr.filter(epIsAnnualEntretien).sort(epSortEntretienDesc);
    const current = epCurrentAnnualEntretien(arr);
    const last = annuals.find(e => e.date_realisee || epIsEntretienClosed(e)) || null;

    state._annualCurrentEntretien = current || null;
    state._annualLastEntretien = last || null;

    if (last) {
      epSetSummaryLink("ep_annualLastDate", epFormatDateFR(epEntretienDateValue(last)) || "—", false, "Ouvrir le dernier entretien annuel");
      setText("ep_annualLastSub", epIsEntretienClosed(last) ? "Entretien signé ou terminé" : (last.statut || "—"));
    } else {
      epSetSummaryLink("ep_annualLastDate", "—", true, "Aucun entretien annuel enregistré");
      setText("ep_annualLastSub", "Aucun historique annuel");
    }

    if (current?.date_prevue) {
      epSetSummaryLink("ep_annualNextDate", epFormatDateFR(current.date_prevue), false, "Ouvrir le calendrier");
      setText("ep_annualNextSub", current.date_realisee ? "Réalisé" : "Voir au calendrier");
    } else {
      epSetSummaryLink("ep_annualNextDate", "À planifier", false, "Planifier dans le calendrier");
      setText("ep_annualNextSub", "Ouvrir le calendrier");
    }

    const currentItem = $("ep_annualCurrentItem");
    if (currentItem) currentItem.style.display = current ? "" : "none";

    const currentStatus = epSignatureStatusFromEntretien(current);
    epSetBadgeText("ep_annualCurrentStatus", currentStatus || "À préparer");
    setText("ep_annualCurrentSub", current?.date_prevue ? `Prévu le ${epFormatDateFR(current.date_prevue)}` : "");

    const st = epNormText(current?.statut || "");
    let signTxt = "Non engagé";
    if (st.includes("signer")) signTxt = currentStatus;
    if (st.includes("termine") || st.includes("signe")) signTxt = "Signé";

    const prepState = epPreparationState(current);
    const realizationDone = !!(current?.date_realisee || st.includes("signer") || st.includes("termine") || st.includes("signe"));
    const signaturesDone = !!(st.includes("termine") || st.includes("signe"));
    const reportDone = signaturesDone && !!current?.id_entretien;

    const prepSub = prepState.key === "validee_auto"
      ? "Validée automatiquement à la réalisation"
      : prepState.done
        ? (prepState.dateValidation ? `Validée le ${epFormatDateFR(prepState.dateValidation)}` : "Préparation validée")
        : prepState.inProgress
          ? (prepState.dateOuverture ? `Ouverte le ${epFormatDateFR(prepState.dateOuverture)}` : "Préparation en cours")
          : (current?.date_prevue ? `Prévu le ${epFormatDateFR(current.date_prevue)}` : "Aucune préparation ouverte");

    setText("ep_stepPreparationBadge", prepState.label);
    setText("ep_stepPreparationSub", prepSub);
    setText("ep_stepRealisationBadge", realizationDone ? "Réalisé" : "À réaliser");
    setText("ep_stepRealisationSub", realizationDone ? `Réalisé le ${epFormatDateFR(current.date_realisee)}` : "Planifier et conduire l’entretien");
    setText("ep_stepSignaturesBadge", signTxt);
    setText("ep_stepSignaturesSub", st.includes("signer") ? "Validation électronique en attente" : (signaturesDone ? "Signatures finalisées" : "Validation électronique"));
    setText("ep_stepRapportBadge", current?.id_entretien ? "Disponible" : "À générer");
    setText("ep_stepRapportSub", current?.id_entretien ? "Rapport PDF accessible" : "Enregistre l’entretien avant le rapport");

    const prepareBtnLabel = $("ep_btnAnnualPrepare")?.querySelector("span:last-child");
    if (prepareBtnLabel) {
      prepareBtnLabel.textContent = prepState.done
        ? "Modifier la préparation"
        : (prepState.inProgress ? "Reprendre la préparation" : "Préparer l’entretien");
    }

    const reportBtn = $("ep_btnAnnualReport");
    if (reportBtn) reportBtn.disabled = !current?.id_entretien;

    const stepPreparation = $("ep_stepPreparation");
    const stepRealisation = $("ep_stepRealisation");
    const stepSignatures = $("ep_stepSignatures");
    const stepRapport = $("ep_stepRapport");

    epSetAnnualStepState(stepPreparation, prepState.done ? "done" : (prepState.inProgress ? "progress" : "pending"));
    epSetAnnualStepState(stepRealisation, realizationDone ? "done" : "pending");
    epSetAnnualStepState(stepSignatures, signaturesDone ? "done" : "pending");
    epSetAnnualStepState(stepRapport, reportDone ? "done" : "pending");

    epRenderAnnualHistory(annuals);
  }

  function epUpdateAnnualHistoryMoreButton(totalCount, hiddenCount) {
    const btn = $("ep_btnMoreAnnualHistory");
    const label = $("ep_moreAnnualHistoryLabel");
    if (!btn || !label) return;

    const hidden = Math.max(0, Number(hiddenCount || 0));
    const expanded = !!state._annualHistoryShowAll;

    btn.style.display = (hidden > 0 || expanded) ? "" : "none";
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    label.textContent = expanded ? "Voir moins d’historique" : `Plus d’historique (${hidden})`;
  }

  function epIconEyeSvg() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-eye"></use></svg>
    `;
  }

  function epIconPdfSvg() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>
    `;
  }

  function epRenderAnnualHistory(annuals) {
    const tbody = $("ep_annualHistoryBody");
    if (!tbody) return;

    const allRows = Array.isArray(annuals) ? annuals : [];
    state._annualHistoryAll = allRows;

    const expanded = !!state._annualHistoryShowAll;
    const rows = expanded ? allRows : allRows.slice(0, 5);
    const hidden = Math.max(0, allRows.length - 5);

    epUpdateAnnualHistoryMoreButton(allRows.length, hidden);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="ep-empty-cell">Aucun entretien annuel enregistré.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    rows.forEach(e => {
      const d = epDateObj(epEntretienDateValue(e));
      const year = d ? String(d.getFullYear()) : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${epEsc(year)}</td>
        <td>${epEsc(epFormatDateFR(epEntretienDateValue(e)) || "—")}</td>
        <td class="ep-annual-history-status-cell"><span class="ns-badge sb-badge ep-entretien-status ep-entretien-status--${epStatusSlug(e.statut)}">${epEsc(e.statut || "—")}</span></td>
        <td class="ep-annual-history-actions">
          <button type="button" class="sb-icon-btn ep-square-action-btn" data-act="open" title="Voir l’entretien" aria-label="Voir l’entretien">${epIconEyeSvg()}</button>
          <button type="button" class="sb-icon-btn ep-square-action-btn" data-act="pdf" title="Rapport PDF" aria-label="Rapport PDF">${epIconPdfSvg()}</button>
        </td>
      `;
      tr.querySelector('[data-act="open"]')?.addEventListener("click", () => openEntretienModal(e, "realisation"));
      tr.querySelector('[data-act="pdf"]')?.addEventListener("click", () => openEntretienPdf(e.id_entretien));
      tbody.appendChild(tr);
    });
  }

  async function epLoadPunctualHistorySummary() {
    const list = $("ep_punctualHistoryList");
    if (!list) return;

    if (!state.selectedCollaborateurId || !_portal) {
      state._historyAll = [];
      list.innerHTML = `<div class="ep-empty-cell">Sélectionne un collaborateur.</div>`;
      epUpdatePunctualHistoryMoreButton(0, 0);
      return;
    }

    list.innerHTML = `<div class="ep-empty-cell">Chargement…</div>`;
    epUpdatePunctualHistoryMoreButton(0, 0);

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/historique/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;
      const data = await _portal.apiJson(url);
      const rows = Array.isArray(data) ? data : [];
      state._historyAll = rows;
      epRenderPunctualHistorySummary(rows);
    } catch (e) {
      state._historyAll = [];
      list.innerHTML = `<div class="ep-empty-cell">Impossible de charger l’historique.</div>`;
      epUpdatePunctualHistoryMoreButton(0, 0);
    }
  }

  function epHistoryDateTime(value) {
    const d = epDateObj(value);
    return d ? d.getTime() : 0;
  }

  function epHistorySourceLabel(row) {
    const apiSource = (row?.source_eval || "").toString().trim();
    if (apiSource) return apiSource;

    const method = (row?.methode_eval || "").toString().trim();
    const methodKey = epNormText(method);
    const type = (row?.type_entretien || "").toString().trim();

    if ((row?.id_action_formation_acquisition || "").toString().trim()) return "Suivi post-formation";
    if ((row?.id_entretien_individuel || "").toString().trim()) return type || "Entretien individuel";
    if (methodKey.includes("formation")) return "Suivi post-formation";
    if (methodKey.includes("audit") || methodKey.includes("certification") || methodKey.includes("examen")) return "Audit compétence";
    if (!method || methodKey.includes("entretien de performance")) return "Entretien ponctuel";
    return method;
  }

  function epBuildPunctualHistoryCompetenceGroups(rows) {
    const map = new Map();

    function makeKey(row, fallbackIndex) {
      const idEc = (row?.id_effectif_competence || "").toString().trim();
      if (idEc) return `ec:${idEc}`;
      const idComp = (row?.id_comp || "").toString().trim();
      if (idComp) return `comp:${idComp}`;
      return `row:${fallbackIndex}`;
    }

    function ensureGroup(row, fallbackIndex) {
      const key = makeKey(row, fallbackIndex);
      if (!map.has(key)) {
        map.set(key, {
          key,
          id_effectif_competence: (row?.id_effectif_competence || "").toString().trim(),
          id_comp: (row?.id_comp || "").toString().trim(),
          code: (row?.code || "").toString().trim(),
          intitule: (row?.intitule || "").toString().trim(),
          dernier_niveau: _nsLevelLabel4(row?.niveau_actuel || ""),
          derniere_eval: row?.date_derniere_eval || "",
          audits: [],
        });
      }
      return map.get(key);
    }

    (Array.isArray(state._checklistAll) ? state._checklistAll : []).forEach((x, index) => {
      ensureGroup(x, index);
    });

    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const group = ensureGroup(row, index);
      const auditDate = row?.date_audit || "";
      const scoreInfo = _epScoreInfoFromAudit(row);
      const auditLevel = scoreInfo?.levelLabel && scoreInfo.levelLabel !== "—"
        ? scoreInfo.levelLabel
        : _epLevelFromScore24(row?.resultat_eval);

      if (row?.id_audit_competence || auditDate) {
        group.audits.push({
          ...row,
          _sourceLabel: epHistorySourceLabel(row),
          _levelLabel: auditLevel || "—",
          _dateTime: epHistoryDateTime(auditDate),
        });
      }

      if (auditDate && epHistoryDateTime(auditDate) >= epHistoryDateTime(group.derniere_eval)) {
        group.derniere_eval = auditDate;
        if (auditLevel && auditLevel !== "—") group.dernier_niveau = auditLevel;
      }

      if (!group.code && row?.code) group.code = row.code;
      if (!group.intitule && row?.intitule) group.intitule = row.intitule;
    });

    return Array.from(map.values())
      .map(group => ({
        ...group,
        audits: group.audits.sort((a, b) => (b._dateTime || 0) - (a._dateTime || 0)),
      }))
      .sort((a, b) => {
        const da = epHistoryDateTime(a.derniere_eval);
        const db = epHistoryDateTime(b.derniere_eval);
        if (da !== db) return db - da;
        return String(a.code || a.intitule || "").localeCompare(String(b.code || b.intitule || ""), "fr", { sensitivity: "base" });
      });
  }

  function epUpdatePunctualHistoryMoreButton(totalCount, hiddenCount) {
    const btn = $("ep_btnMoreHistoryCompetences");
    const label = $("ep_moreHistoryCompetencesLabel");
    if (!btn || !label) return;

    const total = Number(totalCount || 0);
    const hidden = Math.max(0, Number(hiddenCount || 0));
    const expanded = !!state._punctualHistoryShowAllCompetences;

    btn.style.display = (hidden > 0 || expanded) ? "" : "none";
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    label.textContent = expanded ? "Voir moins de compétences" : `Voir plus de compétences (${hidden})`;
  }

  function epRenderPunctualHistorySummary(rows) {
    const list = $("ep_punctualHistoryList");
    if (!list) return;

    if (!state.selectedCollaborateurId) {
      list.innerHTML = `<div class="ep-empty-cell">Sélectionne un collaborateur.</div>`;
      epUpdatePunctualHistoryMoreButton(0, 0);
      return;
    }

    const groups = epBuildPunctualHistoryCompetenceGroups(rows);
    if (!groups.length) {
      list.innerHTML = `<div class="ep-empty-cell">Aucune compétence rattachée à ce collaborateur.</div>`;
      epUpdatePunctualHistoryMoreButton(0, 0);
      return;
    }

    const expandedList = !!state._punctualHistoryShowAllCompetences;
    const visible = expandedList ? groups : groups.slice(0, 5);
    const hidden = Math.max(0, groups.length - 5);

    list.innerHTML = "";
    visible.forEach((group, index) => {
      const acc = document.createElement("div");
      acc.className = "ep-punctual-history-acc";

      const hasAudits = group.audits.length > 0;
      const open = index === 0 && hasAudits;
      const level = group.dernier_niveau && group.dernier_niveau !== "—" ? group.dernier_niveau : "—";
      const countLabel = `${group.audits.length} évaluation${group.audits.length > 1 ? "s" : ""}`;

      acc.innerHTML = `
        <button type="button" class="ep-punctual-history-acc-head${open ? " is-open" : ""}" aria-expanded="${open ? "true" : "false"}">
          <span class="ep-punctual-history-acc-main">
            <span class="ns-badge sb-badge sb-badge-ref-comp-code ep-punctual-history-code">${epEsc(group.code || "—")}</span>
            <span class="ep-punctual-history-acc-title">
              <span class="ep-punctual-history-acc-name" title="${epEsc(group.intitule || "")}">${epEsc(group.intitule || "Compétence sans intitulé")}</span>
              <span class="ep-punctual-history-acc-meta">
                <span>Dernier niveau : <strong>${epEsc(level)}</strong></span>
                <span>Dernière évaluation : <strong>${epEsc(epFormatDateFR(group.derniere_eval) || "—")}</strong></span>
              </span>
            </span>
          </span>
          <span class="ep-punctual-history-count">${epEsc(countLabel)}</span>
          <span class="ep-punctual-history-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="ep-punctual-history-acc-body${open ? " is-open" : ""}">
          ${hasAudits ? `
            <div class="ep-punctual-history-eval-head" aria-hidden="true">
              <span>Date</span>
              <span>Type d’évaluation</span>
              <span>Niveau atteint</span>
              <span>Évaluateur</span>
              <span></span>
            </div>
            ${group.audits.map((audit, auditIndex) => `
              <div class="ep-punctual-history-eval-row${auditIndex >= 4 ? " ep-punctual-history-eval-extra" : ""}">
                <span class="ep-punctual-history-date">${epEsc(epFormatDateFR(audit.date_audit) || "—")}</span>
                <span class="ep-punctual-history-source" title="${epEsc(audit._sourceLabel || "")}">${epEsc(audit._sourceLabel || "—")}</span>
                <span class="ns-badge sb-badge ${getEpLevelBadgeClass(audit._levelLabel)}">${epEsc(audit._levelLabel || "—")}</span>
                <span class="ep-punctual-history-evaluator" title="${epEsc(audit.nom_evaluateur || "Non affecté")}">${epEsc(audit.nom_evaluateur || "Non affecté")}</span>
                <button type="button" class="sb-icon-btn ep-square-action-btn ep-punctual-history-view" data-ep-history-view="${auditIndex}" title="Voir l’évaluation" aria-label="Voir l’évaluation">${epIconEyeSvg()}</button>
              </div>
            `).join("")}
            ${group.audits.length > 4 ? `
              <button type="button" class="ep-punctual-history-more-audits" data-ep-more-audits="1" aria-expanded="false">
                <span>Voir toutes les évaluations (${group.audits.length - 4})</span>
                <span class="ep-more-competences__chevron" aria-hidden="true">⌄</span>
              </button>
            ` : ""}
          ` : `<div class="ep-punctual-history-empty-row">Aucune évaluation enregistrée pour cette compétence.</div>`}
        </div>
      `;

      const head = acc.querySelector(".ep-punctual-history-acc-head");
      const body = acc.querySelector(".ep-punctual-history-acc-body");
      head?.addEventListener("click", () => {
        const isOpen = head.classList.toggle("is-open");
        head.setAttribute("aria-expanded", isOpen ? "true" : "false");
        body?.classList.toggle("is-open", isOpen);
      });

      acc.querySelectorAll('[data-ep-history-view]').forEach(btn => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const idx = Number(btn.getAttribute("data-ep-history-view"));
          const audit = Number.isFinite(idx) ? group.audits[idx] : null;
          await epOpenHistoryEvaluationDetail(audit, { evaluatorName: audit?.nom_evaluateur || "Non affecté" });
        });
      });

      const moreAuditsBtn = acc.querySelector('[data-ep-more-audits="1"]');
      moreAuditsBtn?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const isExpanded = body?.classList.toggle("is-audits-expanded");
        moreAuditsBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
        const label = moreAuditsBtn.querySelector("span");
        if (label) {
          label.textContent = isExpanded ? "Voir moins d’évaluations" : `Voir toutes les évaluations (${Math.max(0, group.audits.length - 4)})`;
        }
      });

      list.appendChild(acc);
    });

    epUpdatePunctualHistoryMoreButton(groups.length, hidden);
  }

  async function afterAuditSavedRefresh(savedApiResp) {
    // 1) Mettre à jour l’en-tête de la compétence (niveau + date dernière éval)
    const levelTxt = (document.getElementById("ep_levelABC")?.textContent || "").toString().trim();
    if (levelTxt && levelTxt !== "—") {
      setText("ep_compCurrent", _nsLevelLabel4(levelTxt));
    }

    const apiDate = _formatDateFR(savedApiResp?.date_audit);
    const dateTxt = apiDate || new Date().toLocaleDateString("fr-FR");
    const lastEl = $("ep_compLastEval");
    if (lastEl) lastEl.textContent = `Dernière éval : ${dateTxt}`;

    // 2) Mettre à jour la checklist (state + synthèses de page)
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
    epRenderAnnualCompetenceSummary(state._checklistAll || []);
    epApplyPunctualFilters();
    await epLoadPunctualHistorySummary();

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

    updateCriticiteSliderVisual();

    for (let i = 1; i <= 4; i++) {
      setDisabled(`ep_critNote${i}`, true);
      setDisabled(`ep_critCom${i}`, true);
    }
    setDisabled("ep_selEvalMethod", true);
    setDisabled("ep_txtObservation", true);

    setDisabled("ep_btnSave", true);

    if (!scopeOk) setText("ep_ctxService", "—");

    if (!collabOk) {
      resetCouverturePosteUI();
      return;
    }

    showCouverturePosteWrap("");
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
      hint.textContent = "Sélectionne un collaborateur pour préparer un entretien ou lancer une évaluation.";
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
    const k = _nsLevelKey4(label);
    if (k === "A") return "sb-badge-niv sb-badge-niv-a";
    if (k === "B") return "sb-badge-niv sb-badge-niv-b";
    if (k === "C") return "sb-badge-niv sb-badge-niv-c";
    if (k === "D") return "sb-badge-niv sb-badge-niv-d";
    return "sb-badge-niv";
  }

function getCollaborateurInitials(c) {
    const prenom = (c?.prenom_effectif || "").toString().trim();
    const nom = (c?.nom_effectif || "").toString().trim();
    const p = prenom ? prenom.charAt(0) : "";
    const n = nom ? nom.charAt(0) : "";
    return `${p}${n}`.toUpperCase() || "—";
  }

  function getInitialsFromNameParts(prenom, nom) {
    const p = (prenom || "").toString().trim();
    const n = (nom || "").toString().trim();
    return `${p ? p.charAt(0) : ""}${n ? n.charAt(0) : ""}`.toUpperCase() || "—";
  }

  function epSetSummaryLink(id, label, disabled, title) {
    const btn = $(id);
    if (!btn) return;
    btn.textContent = (label || "—").toString().trim() || "—";
    btn.disabled = !!disabled;
    btn.classList.toggle("is-disabled", !!disabled);
    if (title) btn.title = title;
    else btn.removeAttribute("title");
  }

  function epSignatureStatusFromEntretien(entretien) {
    const raw = (entretien?.statut || "").toString().trim();
    const norm = epNormText(raw);
    if (!norm.includes("signer")) return raw || "À réaliser";

    const match = raw.match(/(\d+)\s*\/\s*2/);
    if (match) return `À signer ${match[1]}/2`;
    return "À signer 2/2";
  }

  function epOpenCalendarForAnnualContext() {
    if (!_portal?.switchView) return;
    try {
      window.sessionStorage.setItem("skills_cal_source", "entretien-performance");
      window.sessionStorage.setItem("skills_cal_preselect_id_effectif", state.selectedCollaborateurId || "");
      window.sessionStorage.setItem("skills_cal_preselect_id_service", state.selectedCollaborateurServiceId || state.serviceId || "");
      window.sessionStorage.setItem("skills_cal_preselect_nom", ($("ep_ctxCollaborateur")?.textContent || "").toString().trim());
    } catch (_) {}
    _portal.switchView("calendrier");
  }

  function getCollaborateurEntretienStatus(c) {
    const raw = (c?.statut_entretien_suivi || "").toString().trim().toLowerCase();
    const label = (c?.libelle_entretien_suivi || "").toString().trim();

    if (["a_jour", "ok", "jour", "signed", "signe", "signé"].includes(raw)) {
      return { key: "ok", label: label || "Entretien à jour" };
    }
    if (["planifie", "planifié", "planned", "prepare", "préparé"].includes(raw)) {
      return { key: "planned", label: label || "Entretien planifié" };
    }
    if (["retard", "late", "overdue", "en_retard"].includes(raw)) {
      return { key: "late", label: label || "Entretien en retard" };
    }
    if (["a_planifier", "à_planifier", "todo", "none"].includes(raw)) {
      return { key: "todo", label: label || "Entretien à planifier" };
    }

    const priority = getCollaborateurPriority(c);
    if (priority === "ok") return { key: "ok", label: "Entretien à jour" };
    if (priority === "plan") return { key: "todo", label: "Entretien à planifier" };
    if (priority === "high") return { key: "late", label: "Entretien en retard" };
    return { key: "neutral", label: "Statut entretien non renseigné" };
  }

  function renderCollaborateurs(list) {
    const wrap = $("ep_listCollaborateurs");
    if (!wrap) return;

    wrap.innerHTML = "";

    const arr = (Array.isArray(list) ? list : []).slice().sort((a, b) => {
      const na = `${(a?.nom_effectif || "").toString()} ${(a?.prenom_effectif || "").toString()}`.trim();
      const nb = `${(b?.nom_effectif || "").toString()} ${(b?.prenom_effectif || "").toString()}`.trim();
      return na.localeCompare(nb, "fr", { sensitivity: "base" });
    });

    state._collaborateursAll = arr;
    setText("ep_collabCount", String(arr.length));

    const currentId = String(state.selectedCollaborateurId || "").trim();
    const pendingId = String(state.pendingPreselectCollaborateurId || "").trim();
    const mustRevealId = pendingId || currentId;
    if (mustRevealId) {
      const idx = arr.findIndex(c => String(c?.id_effectif || "") === mustRevealId);
      if (idx >= 6) state.collabExpanded = true;
    }

    wrap.classList.remove("sb-tree");
    wrap.classList.add("ep-collab-stack");

    const isExpanded = !!state.collabExpanded;
    const visibleLimit = isExpanded ? arr.length : 6;
    const visible = arr.slice(0, visibleLimit);

    visible.forEach(c => {
      const prenom = (c.prenom_effectif || "").toString().trim();
      const nomRaw = (c.nom_effectif || "").toString().trim();
      const nom = nomRaw.toUpperCase();
      const name = `${nom} ${prenom}`.trim() || "Collaborateur";
      const poste = (c.intitule_poste || "Poste non renseigné").toString().trim();
      const status = getCollaborateurEntretienStatus(c);

      const item = document.createElement("button");
      item.type = "button";
      item.className = "ep-collab-card";
      item.dataset.idEffectif = String(c.id_effectif || "");
      item.dataset.idService = String(c.id_service || "");
      item.dataset.entretienStatus = status.key;
      item.title = `${name}${poste ? ` - ${poste}` : ""} · ${status.label}`;

      const avatar = document.createElement("span");
      avatar.className = "ep-collab-card-avatar";
      avatar.textContent = getCollaborateurInitials(c);
      avatar.setAttribute("aria-hidden", "true");

      const left = document.createElement("div");
      left.className = "ep-collab-card-main";

      const nameEl = document.createElement("div");
      nameEl.className = "ep-collab-card-name";
      nameEl.textContent = name;

      const roleEl = document.createElement("div");
      roleEl.className = "ep-collab-card-role";
      roleEl.textContent = poste;

      const dot = document.createElement("span");
      dot.className = `ep-collab-status-dot ep-collab-status-dot--${status.key}`;
      dot.title = status.label;
      dot.setAttribute("aria-label", status.label);

      left.appendChild(nameEl);
      left.appendChild(roleEl);
      item.appendChild(avatar);
      item.appendChild(left);
      item.appendChild(dot);

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
        state._punctualHistoryShowAllCompetences = false;
        state._annualHistoryShowAll = false;
        resetEvaluationPanel();

        if (!state.selectedCollaborateurId || !_portal) return;

        showCouverturePosteWrap("");

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
            setText("ep_ctxInitials", getInitialsFromNameParts(prenom, nom));

            setText("ep_ctxMatricule", (eff.matricule_interne || "").toString().trim() || "—");
            setText("ep_ctxPoste", (eff.intitule_poste || "").toString().trim() || "—");

            const svc = (eff.nom_service || eff.id_service || "").toString().trim();
            setText("ep_ctxService", svc || "—");
            setText("ep_ctxServiceBadge", svc || "Service non renseigné");
          } else {
            state.selectedCollaborateurServiceId = "";

            // fallback si jamais l’API ne renvoie pas le contexte
            setText("ep_ctxCollaborateur", name || "—");
            setText("ep_ctxInitials", getCollaborateurInitials(c));
            setText("ep_ctxMatricule", "—");
            setText("ep_ctxPoste", "—");
            setText("ep_ctxService", "—");
            setText("ep_ctxServiceBadge", "Service non renseigné");
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

          epRenderAnnualCompetenceSummary(list);
          epRenderPunctualCompetenceRows(list);

          try {
            await loadEntretiensIndividuels();
          } catch (e) {
            console.error("Entretiens individuels:", e);
            epRenderEntretienOverview([]);
          }

          epLoadPunctualHistorySummary();

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

          updateCriticiteSliderVisual();
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

    if (arr.length > 6) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ep-collab-more";
      more.innerHTML = isExpanded
        ? `<span>Réduire la liste</span><span aria-hidden="true">↑</span>`
        : `<span>Plus de collaborateurs</span><strong>${arr.length - 6}</strong><span aria-hidden="true">→</span>`;
      more.addEventListener("click", () => {
        state.collabExpanded = !state.collabExpanded;
        renderCollaborateurs(state._collaborateursAll || []);
      });
      wrap.appendChild(more);
    }

    const pendingApplied = applyPendingCollaborateurPreselect();

    if (!pendingApplied) {
      const currentId = String(state.selectedCollaborateurId || "").trim();
      const currentBtn = currentId
        ? wrap.querySelector(`.ep-collab-card[data-id-effectif="${escapeCssValue(currentId)}"]`)
        : null;
      const btnToSelect = currentBtn || wrap.querySelector(".ep-collab-card");

      if (btnToSelect) {
        window.setTimeout(() => {
          if (!document.body.contains(btnToSelect)) return;

          // Si une présélection externe arrive entre-temps, elle reste prioritaire.
          if (String(state.pendingPreselectCollaborateurId || "").trim()) return;

          // Évite de relancer un chargement si une sélection a déjà été faite.
          if (wrap.querySelector(".ep-collab-card.active")) return;

          btnToSelect.click();
        }, 0);
      }
    }
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
      epRenderAnnualCompetenceSummary(state._checklistAll || []);
      epApplyPunctualFilters();
    }, 120);
  }

  function bindCriticiteSliderOnce() {
    const rng = $("ep_rngCriticite");
    if (!rng) return;

    if (state._critBound) return;
    state._critBound = true;

    rng.addEventListener("input", () => {
      updateCriticiteSliderVisual();
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
    if (!rng) return;

    const seuil = Math.max(0, Math.min(100, Number(rng.value || 0)));
    state._critSeuil = seuil;
    if (valEl) valEl.textContent = String(seuil);
    updateCriticiteSliderVisual();

    const EPS = 0.0001;
    const all = Array.isArray(state._checklistAll) ? state._checklistAll : [];
    const filtered = all.filter(x => getEpCritPctValue(x?.poids_criticite_pct) + EPS >= seuil);
    const todo = filtered.filter(x => x._neverAudited).length;

    setText("ep_kpiToDo", `${todo} / ${filtered.length}`);
    epRenderAnnualCompetenceSummary(filtered);
    epApplyPunctualFilters();

    const active = $("ep_tblCompetences")?.querySelector("tbody tr.active");
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

    state.collabExpanded = false;

    const q = ($("ep_txtSearchCollab")?.value || "").trim();
    const pendingId = String(state.pendingPreselectCollaborateurId || "").trim();
    const loadKey = [state.serviceId || "", q || "", pendingId || ""].join("|");

    if (state._collabLoadingKey === loadKey) return;

    const loadSeq = Number(state._collabLoadSeq || 0) + 1;
    state._collabLoadSeq = loadSeq;
    state._collabLoadingKey = loadKey;

    try {
      _portal.showAlert("", "");

      setText("ep_collabCount", "…");

      const params = new URLSearchParams();
      if (q) params.set("q", q);

      const url = `${_portal.apiBase}/skills/entretien-performance/collaborateurs/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.serviceId)}?${params.toString()}`;
      const data = await _portal.apiJson(url);

      if (state._collabLoadSeq !== loadSeq) return;

      renderCollaborateurs(data || []);
      setText("ep_ctxService", getSelectedServiceName() || "—");
      setText("ep_ctxServiceBadge", getSelectedServiceName() || "Service non renseigné");

    } catch (e) {
      if (state._collabLoadSeq !== loadSeq) return;

      _portal.showAlert("error", "Impossible de charger les collaborateurs : " + String(e?.message || e));
      console.error(e);
      renderCollaborateurs([]);
      setText("ep_ctxService", getSelectedServiceName() || "—");
      setText("ep_ctxServiceBadge", getSelectedServiceName() || "Service non renseigné");
    } finally {
      if (state._collabLoadSeq === loadSeq) {
        state._collabLoadingKey = "";
      }
    }
  }

  async function onScopeChanged() {
    localStorage.setItem("sb_ep_service", state.serviceId || "");
    state._collabLoadingKey = "";
    clearCollaborateurs();
    clearCompetences();
    resetEvaluationPanel();
    applyUiLockedState();

    if (state.serviceId) {
      await loadCollaborateurs();
    }
  }


  function bindFiltersToggleOnce() {
    const card = $("ep_cardPerimetre");
    const btn = $("ep_btnFiltersToggle");
    const body = $("epFilterBody");

    if (!card || !btn || !body || state._filtersToggleBound) return;

    state._filtersToggleBound = true;

    const stored = (() => {
      try { return localStorage.getItem(LS_KEY_FILTERS_OPEN); } catch (_) { return null; }
    })();

    const apply = (opened) => {
      card.classList.toggle("is-collapsed", !opened);
      btn.setAttribute("aria-expanded", opened ? "true" : "false");
      btn.setAttribute("title", opened ? "Replier les filtres" : "Déplier les filtres");
      btn.setAttribute("aria-label", opened ? "Replier les filtres" : "Déplier les filtres");
      try { localStorage.setItem(LS_KEY_FILTERS_OPEN, opened ? "1" : "0"); } catch (_) {}
    };

    apply(stored === "0" ? false : true);

    btn.addEventListener("click", () => {
      const opened = btn.getAttribute("aria-expanded") !== "true";
      apply(opened);
    });
  }

  function updateCriticiteSliderVisual() {
    const rng = $("ep_rngCriticite");
    if (!rng) return;

    const min = Number(rng.min || 0);
    const max = Number(rng.max || 100);
    const raw = Number(rng.value || 0);
    const pct = max > min ? ((raw - min) / (max - min)) * 100 : 0;

    rng.style.setProperty("--ep-crit-pos", `${Math.max(0, Math.min(100, pct))}%`);
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

  function epNormalizeEntretienStatut(value) {
    const v = (value || "").toString().trim().toLowerCase();

    if (["en cours", "encours"].includes(v)) return "en cours";
    if (["à signer 2/2", "a signer 2/2", "à signer", "a signer"].includes(v)) return "à signer 2/2";
    if (["à signer 1/2", "a signer 1/2"].includes(v)) return "à signer 1/2";
    if (["terminé", "termine"].includes(v)) return "terminé";
    if (["archivé", "archive"].includes(v)) return "archivé";

    return "à réaliser";
  }

  function epSetEntretienStatutValue(value) {
    const statut = epNormalizeEntretienStatut(value);
    const sel = $("ep_entretienStatut");

    if (sel) sel.value = statut;

    const toggle = $("ep_entretienStatutToggle");
    if (toggle) {
      const checked = statut === "en cours";
      toggle.classList.toggle("is-on", checked);
      toggle.setAttribute("aria-checked", checked ? "true" : "false");
    }

    // Libellés fixes dans l'UI : "À réaliser" à gauche, "En cours" à droite.
    // Le switch seul porte l'état.
  }

  function epGetEntretienMode() {
    return state._entretienModalMode === "realisation" ? "realisation" : "preparation";
  }

  function epApplyEntretienMode() {
    const mode = epGetEntretienMode();
    const isPreparation = mode === "preparation";

    const modal = $("modalEpEntretien");
    if (modal) {
      modal.classList.toggle("is-preparation-mode", isPreparation);
      modal.classList.toggle("is-realisation-mode", !isPreparation);
    }

    const statutModebar = document.querySelector("#modalEpEntretien .ep-entretien-modebar");
    const statutField = document.querySelector("#modalEpEntretien .ep-entretien-field-statut");
    const dateRealiseeField = document.querySelector("#modalEpEntretien .ep-entretien-field-date-realisee");
    const entretienCritFilter = document.querySelector("#modalEpEntretien .ep-entretien-crit-filter");
    const savePrepDraftBtn = $("ep_btnSavePrepDraft");
    const saveEntretienBtn = $("ep_btnSaveEntretien");

    if (statutModebar) statutModebar.style.display = isPreparation ? "none" : "flex";
    if (statutField) statutField.style.display = isPreparation ? "none" : "";
    if (dateRealiseeField) dateRealiseeField.style.display = isPreparation ? "none" : "";
    if (entretienCritFilter) entretienCritFilter.style.display = isPreparation ? "" : "none";
    if (savePrepDraftBtn) savePrepDraftBtn.style.display = isPreparation ? "" : "none";
    if (saveEntretienBtn) saveEntretienBtn.textContent = isPreparation ? "Valider la préparation" : "Enregistrer";

    document.querySelectorAll("#modalEpEntretien .ep-entretien-tab").forEach(btn => {
      const panel = btn.dataset.panel || "";
      const hide = isPreparation && (panel === "realisation" || panel === "documents");
      btn.style.display = hide ? "none" : "";
    });

    const currentPanel = document.querySelector("#modalEpEntretien .ep-entretien-tab.is-active")?.dataset?.panel || "";
    if (isPreparation && (currentPanel === "realisation" || currentPanel === "documents")) {
      epSetEntretienTab("preparation");
    }

    if (isPreparation) {
      epSetEntretienStatutValue("à réaliser");
    } else {
      const current = epNormalizeEntretienStatut(epGetValue("ep_entretienStatut"));
      epSetEntretienStatutValue(current === "à réaliser" ? "en cours" : current);
    }
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

  function fillEntretienModal(entretien, modeOverride) {
    const d = epPrepareEntretienDraft(entretien || null);
    const mode = modeOverride || state._entretienModalMode || (d.id_entretien ? "realisation" : "preparation");

    state._entretienModalMode = mode === "realisation" ? "realisation" : "preparation";
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
    epSetEntretienDocFile(null);

    setText("ep_entretienModalTitle", d.id_entretien ? (d.type_entretien || "Entretien individuel") : "Préparer un entretien individuel");
    setText("ep_entretienModalSub", epCurrentCollabName());

    epSetInlineMsg("ep_entretienMsg", "info", "");
    epApplyEntretienMode();
    epSetEntretienTab(state._entretienModalMode === "realisation" ? "competences" : "preparation");
    epRenderEntretienCompetences();
    epLoadEntretienDocuments();
  }

  function buildEntretienPayload(statutOverride, options) {
    const d = state._entretienDraft || epDefaultEntretienDraft();
    const statut = statutOverride || epGetValue("ep_entretienStatut") || "à réaliser";
    let preparationStatus = options?.preparationStatus || "";

    if (!preparationStatus && epGetEntretienMode() === "realisation" && epNormalizeEntretienStatut(statut) !== "à réaliser") {
      preparationStatus = "auto_validee";
    }

    return {
      type_entretien: epGetValue("ep_entretienType") || "Entretien individuel",
      statut,
      date_prevue: epGetValue("ep_entretienDatePrevue") || null,
      date_realisee: epGetValue("ep_entretienDateRealisee") || null,
      periode_debut: epGetValue("ep_entretienPeriodeDebut") || null,
      periode_fin: epGetValue("ep_entretienPeriodeFin") || null,

      preparation: epBuildPreparationPayload(d.preparation || {}, preparationStatus),

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

    const isPreparation = epGetEntretienMode() === "preparation";
    const EPS = 0.0001;

    if (isPreparation && Array.isArray(d.competences_entretien)) {
      d.competences_entretien.forEach(item => {
        if (!item || item.role !== "poste") return;

        const crit = getEpCritPctValue(item.poids_criticite_pct);
        if (crit + EPS < seuil) {
          item.selectionnee = false;
        }
      });
    }

    const renderList = (id, role) => {
      const wrap = $(id);
      if (!wrap) return;

      const list = (d.competences_entretien || [])
        .filter(x => x.role === role)
        .filter(x => role !== "poste" || !isPreparation || getEpCritPctValue(x.poids_criticite_pct) + EPS >= seuil);

      if (!list.length) {
        wrap.innerHTML = `<div class="ep-entretien-empty">Aucune compétence</div>`;
        return;
      }

      wrap.innerHTML = "";

      list.forEach(item => {
        const row = document.createElement("div");
        row.className = "ep-entretien-comp-row";

        const checked = item.selectionnee !== false;
        row.classList.toggle("is-unchecked", !checked);

        const canEvaluate = epGetEntretienMode() === "realisation" && checked;
        const niveau = (item.niveau_actuel || "").toString().trim();

        row.innerHTML = `
          <label class="ep-entretien-comp-main">
            <input type="checkbox" data-check="1" ${checked ? "checked" : ""} />
            <span class="ns-badge sb-badge sb-badge-ref-comp-code">${epEsc(item.code || "—")}</span>
            <span class="ep-entretien-comp-title" title="${epEsc(item.intitule || "")}">${epEsc(item.intitule || "—")}</span>
          </label>

          <div class="ep-entretien-comp-meta">
            ${role === "poste" ? `<span class="ns-badge sb-badge">${Math.round(Number(item.poids_criticite_pct || 0))}%</span>` : ""}
            ${niveau ? `<span class="ns-badge sb-badge ${getEpLevelBadgeClass(niveau)}">${epEsc(_nsLevelLabel4(niveau))}</span>` : ""}
            ${checked ? `
            ${item.source === "catalogue" ? `
              <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-remove="1" title="Retirer" aria-label="Retirer">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-7b78c227a9c4"></use></svg>
              </button>
            ` : ""}
            ${canEvaluate ? `
              <button type="button" class="sb-icon-btn ep-entretien-eval-btn" data-eval="1" title="Évaluer" aria-label="Évaluer">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-48dd56632f54"></use></svg>
              </button>
            ` : ""}
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

  function openEntretienModal(entretien, modeOverride) {
    if (!state.selectedCollaborateurId) {
      _portal && _portal.showAlert("warning", "Sélectionne un collaborateur.");
      return;
    }

    const mode = modeOverride || (entretien ? "realisation" : "preparation");

    fillEntretienModal(entretien || null, mode);
    openModal("modalEpEntretien");
  }

  async function saveEntretienOnly(statutOverride, options) {
    if (!state.selectedCollaborateurId || !_portal) {
      throw new Error("Sélectionne un collaborateur.");
    }

    const idEntretien = epGetValue("ep_entretienId");
    const payload = buildEntretienPayload(statutOverride, options || {});
    const isUpdate = !!idEntretien;

    const url = isUpdate
      ? `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}`
      : `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(state.selectedCollaborateurId)}`;

    const saved = await _portal.apiJson(url, {
      method: isUpdate ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    fillEntretienModal(saved, state._entretienModalMode);
    await loadEntretiensIndividuels();
    return saved;
  }

  async function epRefreshEntretienAfterValidation(message) {
    const idEntretien = epGetValue("ep_entretienId");

    if (idEntretien && _portal) {
      const refreshed = await _portal.apiJson(
        `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(idEntretien)}`
      );
      fillEntretienModal(refreshed, state._entretienModalMode);
    }

    epSetInlineMsg("ep_entretienMsg", "success", message || "Entretien enregistré");
    await loadEntretiensIndividuels();
  }

  async function epSavePreparationDraft() {
    if (state._entretienModalMode !== "preparation") return;

    try {
      epSetInlineMsg("ep_entretienMsg", "info", "Enregistrement de la préparation…");
      await saveEntretienOnly("à réaliser", { preparationStatus: "en_cours" });
      epSetInlineMsg("ep_entretienMsg", "success", "Préparation enregistrée sans validation.");
    } catch (e) {
      const raw = String(e?.message || e || "").replace(/^Erreur serveur\s*:\s*/i, "").trim();
      epSetInlineMsg("ep_entretienMsg", "danger", raw || "Erreur lors de l'enregistrement.");
    }
  }

  async function openEntretienValidationFlow() {
    if (!state.selectedCollaborateurId || !_portal) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Sélectionne un collaborateur.");
      return;
    }

    if (state._entretienModalMode === "preparation") {
      try {
        epSetInlineMsg("ep_entretienMsg", "info", "Validation de la préparation…");
        await saveEntretienOnly("à réaliser", { preparationStatus: "validee" });
        epSetInlineMsg("ep_entretienMsg", "success", "Préparation validée. Entretien à réaliser.");
      } catch (e) {
        const raw = String(e?.message || e || "").replace(/^Erreur serveur\s*:\s*/i, "").trim();
        epSetInlineMsg("ep_entretienMsg", "danger", raw || "Erreur lors de l'enregistrement.");
      }
      return;
    }

    const statut = epNormalizeEntretienStatut(epGetValue("ep_entretienStatut"));

    if (["à signer 1/2", "à signer 2/2", "terminé"].includes(statut)) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Entretien déjà engagé dans le circuit de signature : modification bloquée.");
      return;
    }

    if (statut === "à réaliser") {
      try {
        epSetInlineMsg("ep_entretienMsg", "info", "Enregistrement de l'entretien…");
        await saveEntretienOnly("à réaliser");
        epSetInlineMsg("ep_entretienMsg", "success", "Entretien enregistré en statut à réaliser.");
      } catch (e) {
        const raw = String(e?.message || e || "").replace(/^Erreur serveur\s*:\s*/i, "").trim();
        epSetInlineMsg("ep_entretienMsg", "danger", raw || "Erreur lors de l'enregistrement.");
      }
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

  async function epFetchApiPdfBlob(url) {
    const headers = new Headers();
    headers.set("Accept", "application/pdf");

    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      let msg = `Erreur PDF (${resp.status})`;
      try {
        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const body = await resp.json();
          msg = body?.detail || body?.message || JSON.stringify(body);
        } else {
          msg = await resp.text() || msg;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    return await resp.blob();
  }

  async function openEntretienPdf(idEntretien) {
    const id = (idEntretien || epGetValue("ep_entretienId") || "").toString().trim();

    if (!id || !_portal) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Enregistre l'entretien avant de générer le rapport.");
      return;
    }

    const popup = window.open("about:blank", "_blank");
    if (popup) {
      try { popup.document.write("<p style='font-family:var(--ns-font-ui);padding:16px;'>Ouverture du PDF…</p>"); } catch (_) {}
    }

    try {
      const url = `${_portal.apiBase}/skills/entretien-performance/entretien/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}/rapport-pdf?_=${Date.now()}`;
      const blob = await epFetchApiPdfBlob(url);
      epRenderPdfBlobInWindow(popup, blob, "Rapport entretien annuel");
    } catch (e) {
      try { if (popup && !popup.closed) popup.close(); } catch (_) {}
      const msg = String(e?.message || e || "Impossible d'ouvrir le PDF.");
      if ($("modalEpEntretien")?.classList.contains("show")) {
        epSetInlineMsg("ep_entretienMsg", "danger", msg);
      } else {
        _portal?.showAlert?.("warning", msg);
      }
    }
  }

  function epOpenPendingEntretienFromCalendar() {
    const wanted = String(state.pendingPreselectEntretienId || "").trim();
    if (!wanted) return;

    const entretien = (Array.isArray(state._entretiensList) ? state._entretiensList : [])
      .find(e => String(e?.id_entretien || "") === wanted);

    if (!entretien) return;

    state.pendingPreselectEntretienId = "";
    const st = epNormText(entretien.statut || "");
    const mode = entretien.date_realisee || st.includes("signer") || st.includes("termine")
      ? "realisation"
      : "preparation";

    epSetPageTab("annuel");
    openEntretienModal(entretien, mode);
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
    epRenderEntretienOverview(state._entretiensList);
    renderEntretiensIndividuels(state._entretiensList);
    epOpenPendingEntretienFromCalendar();

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
          <span class="ns-badge sb-badge ep-entretien-status ep-entretien-status--${epEsc(statusClass)}">${epEsc(statut)}</span>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="open">Ouvrir</button>
          <button type="button" class="sb-icon-btn sb-icon-btn--doc" data-act="pdf" title="Rapport PDF" aria-label="Rapport PDF">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>
          </button>
        </div>
      `;

      card.querySelector('[data-act="open"]')?.addEventListener("click", () => {
        openEntretienModal(entretien, "realisation");
      });

      card.querySelector('[data-act="pdf"]')?.addEventListener("click", () => {
        openEntretienPdf(entretien.id_entretien);
      });

      wrap.appendChild(card);
    });
  }

  function epCatalogueRoleLabel(role) {
    return role === "detenue_hors_poste"
      ? "Compétences détenues hors poste"
      : "Compétences à développer ou explorer";
  }

  function epCatalogueRoleSubLabel(role) {
    return role === "detenue_hors_poste"
      ? "Ajoute une ou plusieurs compétences détenues par le collaborateur, hors référentiel du poste."
      : "Ajoute une ou plusieurs compétences à développer, explorer ou sécuriser pendant l'entretien.";
  }

  function epCatalogueNormalizeText(value) {
    return (value || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function epCatalogueExistingIdsForRole(role) {
    const d = state._entretienDraft || null;
    const list = Array.isArray(d?.competences_entretien) ? d.competences_entretien : [];

    return new Set(
      list
        .filter(x => x && x.role === role)
        .map(x => (x.id_comp || "").toString().trim())
        .filter(Boolean)
    );
  }

  function epCatalogueSetMsg(type, text) {
    epSetInlineMsg("ep_catalogueMsg", type || "info", text || "");
  }

  async function epLoadCatalogueCompetences() {
    if (Array.isArray(state._entretienCatalogueAll)) {
      return state._entretienCatalogueAll;
    }

    if (!_portal) return [];

    const url = `${_portal.apiBase}/skills/entretien-performance/catalogue-competences/${encodeURIComponent(_portal.contactId)}?limit=500`;
    const data = await _portal.apiJson(url);
    const list = Array.isArray(data) ? data : [];

    state._entretienCatalogueAll = list
      .map(c => ({
        id_comp: (c.id_comp || "").toString().trim(),
        code: (c.code || "").toString().trim(),
        intitule: (c.intitule || "").toString().trim(),
        domaine: (c.domaine || "Sans domaine").toString().trim() || "Sans domaine",
        domaine_couleur: (c.domaine_couleur || "").toString().trim(),
      }))
      .filter(c => c.id_comp);

    return state._entretienCatalogueAll;
  }

  function epFillCatalogueDomainFilter(list) {
    const sel = $("ep_catalogueDomaine");
    if (!sel) return;

    const current = sel.value || "";
    const domaines = Array.from(new Set(
      (Array.isArray(list) ? list : [])
        .map(c => (c.domaine || "Sans domaine").toString().trim() || "Sans domaine")
    )).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));

    sel.innerHTML = `<option value="">Tous les domaines</option>`;

    domaines.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });

    if (current && domaines.includes(current)) {
      sel.value = current;
    }
  }

  function epRenderCatalogueCompetenceModal() {
    const wrap = $("ep_catalogueList");
    const info = $("ep_catalogueInfo");
    const addBtn = $("ep_btnCatalogueAddSelection");

    if (!wrap) return;

    const role = state._entretienCatalogueRole || "a_developper";
    const existingIds = epCatalogueExistingIdsForRole(role);
    const selected = state._entretienCatalogueSelected instanceof Set
      ? state._entretienCatalogueSelected
      : new Set();

    const q = epCatalogueNormalizeText(epGetValue("ep_catalogueSearch"));
    const domaine = (epGetValue("ep_catalogueDomaine") || "").toString().trim();

    const all = Array.isArray(state._entretienCatalogueAll) ? state._entretienCatalogueAll : [];
    const filtered = all.filter(c => {
      if (domaine && (c.domaine || "Sans domaine") !== domaine) return false;
      if (!q) return true;

      const hay = epCatalogueNormalizeText(`${c.code} ${c.intitule} ${c.domaine}`);
      return hay.includes(q);
    });

    if (info) {
      info.textContent = filtered.length
        ? `${filtered.length} compétence(s) affichée(s). Les compétences déjà ajoutées dans cette section sont verrouillées.`
        : "Aucune compétence ne correspond aux filtres.";
    }

    if (addBtn) {
      addBtn.disabled = selected.size === 0;
      addBtn.textContent = selected.size > 0
        ? `Ajouter la sélection (${selected.size})`
        : "Ajouter la sélection";
    }

    if (!filtered.length) {
      wrap.innerHTML = `<div class="ep-catalogue-empty">Aucune compétence trouvée.</div>`;
      return;
    }

    wrap.innerHTML = "";

    filtered.forEach(c => {
      const already = existingIds.has(c.id_comp);
      const isChecked = selected.has(c.id_comp);

      const row = document.createElement("label");
      row.className = "ep-catalogue-row";
      row.classList.toggle("is-disabled", already);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = c.id_comp;
      checkbox.checked = isChecked && !already;
      checkbox.disabled = already;

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(c.id_comp);
        else selected.delete(c.id_comp);
        state._entretienCatalogueSelected = selected;
        epRenderCatalogueCompetenceModal();
      });

      const main = document.createElement("div");
      main.className = "ep-catalogue-row-main";

      const title = document.createElement("div");
      title.className = "ep-catalogue-row-title";
      title.innerHTML = `
        <span class="ns-badge sb-badge sb-badge-ref-comp-code">${epEsc(c.code || "—")}</span>
        <span>${epEsc(c.intitule || "—")}</span>
      `;

      const sub = document.createElement("div");
      sub.className = "ep-catalogue-row-sub";
      sub.textContent = c.domaine || "Sans domaine";

      main.appendChild(title);
      main.appendChild(sub);

      const stateTxt = document.createElement("div");
      stateTxt.className = "ep-catalogue-row-state";
      stateTxt.textContent = already ? "Déjà ajoutée" : "";

      row.appendChild(checkbox);
      row.appendChild(main);
      row.appendChild(stateTxt);

      wrap.appendChild(row);
    });
  }

  async function epOpenCatalogueCompetenceModal(role) {
    const d = state._entretienDraft || epDefaultEntretienDraft();
    state._entretienDraft = d;
    d.competences_entretien = Array.isArray(d.competences_entretien) ? d.competences_entretien : [];

    state._entretienCatalogueRole = role === "detenue_hors_poste" ? "detenue_hors_poste" : "a_developper";
    state._entretienCatalogueSelected = new Set();

    setText("ep_catalogueModalTitle", "Ajouter des compétences");
    setText("ep_catalogueModalSub", epCatalogueRoleSubLabel(state._entretienCatalogueRole));
    epCatalogueSetMsg("info", "");

    const search = $("ep_catalogueSearch");
    if (search) search.value = "";

    const domaine = $("ep_catalogueDomaine");
    if (domaine) domaine.value = "";

    const wrap = $("ep_catalogueList");
    if (wrap) wrap.innerHTML = `<div class="ep-catalogue-empty">Chargement du catalogue...</div>`;

    const addBtn = $("ep_btnCatalogueAddSelection");
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = "Ajouter la sélection";
    }

    openModal("modalEpCatalogueCompetences");

    try {
      const list = await epLoadCatalogueCompetences();
      epFillCatalogueDomainFilter(list);
      epRenderCatalogueCompetenceModal();
      if (search) search.focus();
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="ep-catalogue-empty">Impossible de charger le catalogue.</div>`;
      epCatalogueSetMsg("danger", String(e?.message || e));
    }
  }

  function epCloseCatalogueCompetenceModal() {
    closeModal("modalEpCatalogueCompetences");
    state._entretienCatalogueRole = "";
    state._entretienCatalogueSelected = new Set();
    epCatalogueSetMsg("info", "");
  }

  function epAddCatalogueSelectionToEntretien() {
    const role = state._entretienCatalogueRole || "a_developper";
    const selected = state._entretienCatalogueSelected instanceof Set
      ? Array.from(state._entretienCatalogueSelected)
      : [];

    if (!selected.length) {
      epCatalogueSetMsg("info", "Sélectionne au moins une compétence.");
      return;
    }

    const d = state._entretienDraft || epDefaultEntretienDraft();
    state._entretienDraft = d;
    d.competences_entretien = Array.isArray(d.competences_entretien) ? d.competences_entretien : [];

    const existingIds = epCatalogueExistingIdsForRole(role);
    const all = Array.isArray(state._entretienCatalogueAll) ? state._entretienCatalogueAll : [];
    const byId = new Map(all.map(c => [c.id_comp, c]));

    let added = 0;

    selected.forEach(idComp => {
      if (!idComp || existingIds.has(idComp)) return;

      const c = byId.get(idComp);
      if (!c) return;

      d.competences_entretien.push({
        id_comp: c.id_comp,
        id_effectif_competence: "",
        code: c.code || "",
        intitule: c.intitule || "",
        domaine: c.domaine || "",
        domaine_couleur: c.domaine_couleur || "",
        role,
        source: "catalogue",
        selectionnee: true,
        motif: "",
      });

      added += 1;
    });

    if (!added) {
      epCatalogueSetMsg("info", "Aucune nouvelle compétence à ajouter.");
      epRenderCatalogueCompetenceModal();
      return;
    }

    epRenderEntretienCompetences();
    epCloseCatalogueCompetenceModal();
    epSetEntretienTab("competences");
    epSetInlineMsg("ep_entretienMsg", "success", `${added} compétence(s) ajoutée(s) dans ${epCatalogueRoleLabel(role).toLowerCase()}.`);
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

    if (item.selectionnee === false) {
      epSetInlineMsg("ep_entretienMsg", "info", "Coche la compétence avant de l'évaluer.");
      return;
    }

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
    state.selectedCompetenceId = (x?.id_comp || "").toString().trim();
    state.selectedEffectifCompetenceId = (x?.id_effectif_competence || "").toString().trim();
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

  function epSetEntretienDocFile(file) {
    state._entretienDocFile = file || null;

    const nameEl = $("ep_entretienDocDropName");
    if (nameEl) {
      nameEl.textContent = file ? file.name : "Cliquez ou déposez un fichier ici";
    }

    const drop = $("ep_entretienDocDrop");
    if (drop) drop.classList.toggle("has-file", !!file);
  }

  function epBindEntretienDropzoneOnce() {
    if (state._entretienDropzoneBound) return;
    state._entretienDropzoneBound = true;

    const drop = $("ep_entretienDocDrop");
    const input = $("ep_entretienDocFile");
    if (!drop || !input) return;

    const openPicker = () => input.click();

    drop.addEventListener("click", openPicker);
    drop.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openPicker();
      }
    });

    input.addEventListener("change", () => {
      epSetEntretienDocFile(input.files?.[0] || null);
    });

    ["dragenter", "dragover"].forEach(evtName => {
      drop.addEventListener(evtName, (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        drop.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach(evtName => {
      drop.addEventListener(evtName, (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        drop.classList.remove("is-dragover");
      });
    });

    drop.addEventListener("drop", (ev) => {
      const file = ev.dataTransfer?.files?.[0] || null;
      if (!file) return;

      epSetEntretienDocFile(file);

      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      } catch (_) {
        // Certains navigateurs verrouillent input.files. Le state prend le relais.
      }
    });
  }

  async function epUploadEntretienDocument() {
    const idEntretien = epGetValue("ep_entretienId");
    const fileInput = $("ep_entretienDocFile");

    if (!idEntretien) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Enregistre l'entretien avant d'importer un document.");
      return;
    }

    const file = state._entretienDocFile || fileInput?.files?.[0] || null;
    if (!file) {
      epSetInlineMsg("ep_entretienMsg", "danger", "Sélectionne ou dépose un fichier.");
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
      epSetEntretienDocFile(null);
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

        bindFiltersToggleOnce();
        bindPageTabsOnce();
        epApplyEvaluationNoteLabels();
        epUpdateMasteryGauge();
        updateCriticiteSliderVisual();

        if (!state._preselectListenersBound) {
          state._preselectListenersBound = true;

          const onPreselect = (ev) => {
            preselectCollaborateurFromExternal(ev?.detail || {});
          };

          window.addEventListener("novoskill:entretien-preselect", onPreselect);
          window.addEventListener("skills:entretien-preselect", onPreselect);
          window.addEventListener("ep:preselect-collaborateur", onPreselect);
        }


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
        const btnEntretien = $("ep_btnEntretienIndividuel");
        if (btnEntretien) {
          btnEntretien.addEventListener("click", () => {
            openEntretienModal(null, "preparation");
          });
        }

        const btnNewEntretienHistory = $("ep_btnNewEntretienFromHistory");
        if (btnNewEntretienHistory) {
          btnNewEntretienHistory.addEventListener("click", () => {
            openEntretienModal(null, "preparation");
          });
        }

        const btnSavePrepDraft = $("ep_btnSavePrepDraft");
        if (btnSavePrepDraft) {
          btnSavePrepDraft.addEventListener("click", epSavePreparationDraft);
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
            epOpenCatalogueCompetenceModal("detenue_hors_poste");
          });
        }

        const btnAddDevelop = $("ep_btnAddCompDevelop");
        if (btnAddDevelop) {
          btnAddDevelop.addEventListener("click", () => {
            epOpenCatalogueCompetenceModal("a_developper");
          });
        }

        const catalogueSearch = $("ep_catalogueSearch");
        if (catalogueSearch) {
          catalogueSearch.addEventListener("input", epRenderCatalogueCompetenceModal);
        }

        const catalogueDomaine = $("ep_catalogueDomaine");
        if (catalogueDomaine) {
          catalogueDomaine.addEventListener("change", epRenderCatalogueCompetenceModal);
        }

        const btnCatalogueAddSelection = $("ep_btnCatalogueAddSelection");
        if (btnCatalogueAddSelection) {
          btnCatalogueAddSelection.addEventListener("click", epAddCatalogueSelectionToEntretien);
        }

        const btnCloseCatalogueX = $("btnCloseEpCatalogueModalX");
        const btnCloseCatalogue = $("btnEpCatalogueModalClose");
        const modalCatalogue = $("modalEpCatalogueCompetences");

        if (btnCloseCatalogueX) btnCloseCatalogueX.addEventListener("click", epCloseCatalogueCompetenceModal);
        if (btnCloseCatalogue) btnCloseCatalogue.addEventListener("click", epCloseCatalogueCompetenceModal);
        if (modalCatalogue) {
          modalCatalogue.addEventListener("click", (e) => {
            if (e.target === modalCatalogue) epCloseCatalogueCompetenceModal();
          });
        }

        const btnUploadDoc = $("ep_btnUploadEntretienDoc");
        if (btnUploadDoc) {
          btnUploadDoc.addEventListener("click", epUploadEntretienDocument);
        }

        epBindEntretienDropzoneOnce();

        const statutToggle = $("ep_entretienStatutToggle");
        if (statutToggle) {
          statutToggle.addEventListener("click", () => {
            const next = statutToggle.classList.contains("is-on") ? "à réaliser" : "en cours";
            epSetEntretienStatutValue(next);
          });
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

            if (typeof _portal.openApiPdf === "function") {
              _portal.openApiPdf(url).catch(e => {
                _portal.showAlert("warning", String(e?.message || e || "Impossible d'ouvrir le PDF."));
              });
              return;
            }

            const finalUrl = typeof _portal.decorateApiUrl === "function" ? _portal.decorateApiUrl(url) : url;
            const win = window.open(finalUrl, "_blank", "noopener");
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

            const niveauFromScore = (score) => _epLevelFromScore24(score);

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
              const scoreInfo = _epScoreInfoFromAudit(x);
              const niveau = scoreInfo.levelLabel;
              const lastDate = formatDateFR(x.date_audit);
              const method = getMethKey(x);
              const obs = (x.observation || "").toString();

              resetEvaluationPanel();

              const canEditHistoryAudit = x.modifiable === true;

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

              setText("ep_scoreRaw", scoreInfo.sum === null ? "—" : String(scoreInfo.sum));
              epSetScorePct(scoreInfo.pct === null ? "—" : `${scoreInfo.pct}%`);

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
                  const scoreInfo = _epScoreInfoFromAudit(x);
              const niveau = scoreInfo.levelLabel;

                  const iconEye = `
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-2fb5e9684f26"></use></svg>
                  `;

                  const row = document.createElement("div");
                  row.className = "ep-history-comp-row";
                  row.innerHTML = `
                    <div class="ep-history-comp-main">
                      ${code ? `<span class="ns-badge sb-badge sb-badge-ref-comp-code">${esc(code)}</span>` : ""}
                      <span class="ep-history-comp-title" title="${esc(intitule)}">${esc(intitule || "—")}</span>
                    </div>

                    <div class="ep-history-comp-result">
                      <span class="ns-badge sb-badge ${esc(getEpLevelBadgeClass(niveau))}">${esc(niveau)}</span>
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
        selService.addEventListener("change", () => {
            state.serviceId = window.portal.serviceFilter.normalizeId(selService.value || "");
        });
        }

        const selPop = $("ep_selPopulation");
        if (selPop) {
        selPop.addEventListener("change", () => {
            state.population = selPop.value || "team";
        });
        }

        const btnApply = $("ep_btnScopeApply");
        if (btnApply) {
        btnApply.addEventListener("click", async () => {
            const sel = $("ep_selService");
            if (sel) state.serviceId = window.portal.serviceFilter.normalizeId(sel.value || "");
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
        if (score24 <= 6) return "Débutant";
        if (score24 <= 12) return "Intermédiaire";
        if (score24 <= 18) return "Avancé";
        if (score24 <= 24) return "Expert";
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
            epSetScorePct("—");
            setText("ep_levelABC", "—");
            return;
        }

        setText("ep_scoreRaw", String(sum));

        const coef = computeCoef(enabledCount);
        const score24 = coef ? Math.round(sum * coef * 10) / 10 : null;
        const pct = computePct(score24);

        if (enabledCount > 0 && filledCount === enabledCount && score24 !== null && pct !== null) {
            epSetScorePct(`${pct}%`);
            setText("ep_levelABC", computeLevel(score24));
        } else {
            epSetScorePct("—");
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

    applyEmbeddedOrganisationOptions(portal);
    bindEmbeddedOrganisationFilterOnce(portal);

    await loadBootstrap();

    const hasPreselect = readPendingCollaborateurPreselect();

    // Chargement services dès affichage
    await loadServices();

    // Si un collaborateur vient de la page Collaborateurs, on se place directement
    // sur son service, sans passer par une recherche texte fragile aux accents.
    const selService = $("ep_selService");
    if (hasPreselect) {
      setServiceForCollaborateurPreselect(state.pendingPreselectServiceId);
    } else {
      state.serviceId = (selService?.value || "").trim();
    }

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
    const n = Number(score24);
    if (!Number.isFinite(n)) return "A";
    if (n <= 6) return "A";
    if (n <= 12) return "B";
    if (n <= 18) return "C";
    if (n <= 24) return "D";
    return "D";
  }

  function _levelLabelFromCode(value) {
    if (window.NovoskillLevels && typeof window.NovoskillLevels.label === "function") {
      return window.NovoskillLevels.label(value);
    }
    const k = String(value || "").trim().toUpperCase();
    if (k === "A") return "Débutant";
    if (k === "B") return "Intermédiaire";
    if (k === "C") return "Avancé";
    if (k === "D") return "Expert";
    return String(value || "—");
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
    epSetScorePct(`${pct}%`);
    if (document.getElementById("ep_levelABC")) document.getElementById("ep_levelABC").textContent = _levelLabelFromCode(niveau_actuel);

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

  window.SkillsEntretienPerformance = {
    onShow,
    preselectCollaborateur: preselectCollaborateurFromExternal
  };
})();
