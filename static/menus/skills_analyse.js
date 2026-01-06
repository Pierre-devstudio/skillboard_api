/* ======================================================
   static/menus/skills_analyse.js
   - Menu "Analyse des compétences"
   - 3 tuiles cliquables (Risques / Matching / Prévisions)
   - Filtres: Service (V1)
   - KPI: alimentés si API summary dispo, sinon "—"
   ====================================================== */

(function () {
  let _bound = false;
  let _servicesLoaded = false;

  const NON_LIE_ID = "__NON_LIE__";
  const STORE_SERVICE = "sb_analyse_service";
  const STORE_MODE = "sb_analyse_mode";
  const STORE_RISK_FILTER = "sb_analyse_risk_filter";


  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setText(id, v, fallback = "—") {
    const el = byId(id);
    if (!el) return;
    el.textContent = (v === null || v === undefined || v === "") ? fallback : String(v);
  }

  function setStatus(text) {
    setText("analyseStatus", text || "—", "—");
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

  function fillServiceSelect(flat) {
    const sel = byId("analyseServiceSelect");
    if (!sel) return;

    const stored = (localStorage.getItem(STORE_SERVICE) || "").trim();
    const current = (sel.value || stored || "").trim();

    sel.innerHTML = "";
    sel.insertAdjacentHTML("beforeend", `<option value="">Tous les services</option>`);
    sel.insertAdjacentHTML("beforeend", `<option value="${NON_LIE_ID}">Non liés (sans service)</option>`);

    (flat || []).forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.id_service;
      const prefix = s.depth ? "— ".repeat(Math.min(6, s.depth)) : "";
      opt.textContent = prefix + (s.nom_service || s.id_service);
      sel.appendChild(opt);
    });

    if (current && Array.from(sel.options).some(o => o.value === current)) sel.value = current;
    else sel.value = "";
  }

  function getFilters() {
    const id_service = (byId("analyseServiceSelect")?.value || "").trim();
    return { id_service };
  }

  function getScopeLabel() {
    const sel = byId("analyseServiceSelect");
    return sel ? (sel.options[sel.selectedIndex]?.textContent || "Tous les services") : "Tous les services";
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

  async function loadServices(portal) {
    const nodes = await portal.apiJson(`${portal.apiBase}/skills/organisation/services/${encodeURIComponent(portal.contactId)}`);
    const flat = flattenServices(Array.isArray(nodes) ? nodes : []);
    fillServiceSelect(flat);
    _servicesLoaded = true;
  }

  function clearKpis() {
    setText("kpiRiskPostes", "—");
    setText("kpiRiskNoOwner", "—");
    setText("kpiRiskBus1", "—");

    setText("kpiMatchNoCandidate", "—");
    setText("kpiMatchReadyNow", "—");
    setText("kpiMatchReady6", "—");

    setText("kpiPrevSorties12", "—");
    setText("kpiPrevCompImpact", "—");
    setText("kpiPrevPostesRed", "—");
  }

  function setActiveTile(mode) {
    const tiles = [
      byId("tileRisques"),
      byId("tileMatching"),
      byId("tilePrevisions")
    ].filter(Boolean);

    tiles.forEach(t => t.classList.remove("active"));

    const map = {
      risques: byId("tileRisques"),
      matching: byId("tileMatching"),
      previsions: byId("tilePrevisions")
    };

    const tile = map[mode] || map.risques;
    if (tile) tile.classList.add("active");
  }

  function getRiskFilter() {
    return (localStorage.getItem(STORE_RISK_FILTER) || "").trim();
  }

  function setRiskFilter(filter) {
    const f = (filter || "").trim();
    if (f) localStorage.setItem(STORE_RISK_FILTER, f);
    else localStorage.removeItem(STORE_RISK_FILTER);
    setActiveRiskKpi(f);
  }

  function setActiveRiskKpi(filter) {
    const tile = byId("tileRisques");
    if (!tile) return;

    const items = tile.querySelectorAll(".mini-kpi[data-risk-kpi]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-risk-kpi") || "").trim();
      const isActive = !!filter && k === filter;

      el.style.borderColor = isActive
        ? "color-mix(in srgb, var(--accent) 55%, #d1d5db)"
        : "#e5e7eb";

      el.style.background = isActive
        ? "color-mix(in srgb, var(--accent) 6%, #ffffff)"
        : "#ffffff";
    });
  }


  function renderDetail(mode) {
    const scope = getScopeLabel();

    const title = byId("analyseDetailTitle");
    const sub = byId("analyseDetailSub");
    const meta = byId("analyseDetailMeta");
    const body = byId("analyseDetailBody");

    if (meta) meta.textContent = `Service : ${scope}`;

    if (!body) return;

    // -----------------------
    // MATCHING
    // -----------------------
    if (mode === "matching") {
      if (title) title.textContent = "Matching poste-porteur";
      if (sub) sub.textContent = "Lecture rapide des options internes. Le détail arrivera avec l’API dédiée.";
      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Ce que vous allez obtenir</div>
          <div class="card-sub" style="margin:0;">
            - Shortlists par poste (prêt maintenant / prêt à horizon court)<br/>
            - Écarts ciblés sur les compétences critiques<br/>
            - Décision: mobilité, staffing, succession, plan de montée en compétences
          </div>
        </div>
        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Résultats (à venir)</div>
          <div class="card-sub" style="margin:0;">Aucune donnée chargée.</div>
        </div>
      `;
      return;
    }

    // -----------------------
    // PREVISIONS
    // -----------------------
    if (mode === "previsions") {
      if (title) title.textContent = "Prévisions";
      if (sub) sub.textContent = "Projection à horizon: impacts départs, tensions, scénarios. V1 en cours de pose.";
      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Ce que vous allez obtenir</div>
          <div class="card-sub" style="margin:0;">
            - Liste “à échéance” (postes/compétences qui basculent)<br/>
            - Comparaison de scénarios (former / recruter / mobilité)<br/>
            - Décision: plan d’action et pilotage par horizon
          </div>
        </div>
        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Résultats (à venir)</div>
          <div class="card-sub" style="margin:0;">Aucune donnée chargée.</div>
        </div>
      `;
      return;
    }

    // -----------------------
    // RISQUES (avec filtre KPI)
    // -----------------------
    const rf = getRiskFilter(); // "", "postes-fragiles", "critiques-sans-porteur", "porteur-unique"
    setActiveRiskKpi(rf);

    if (title) title.textContent = "Risques";

    let filterLabel = "Vue globale";
    let filterSub = "Priorisation des fragilités par criticité et couverture.";

    if (rf === "postes-fragiles") {
      filterLabel = "Postes fragiles";
      filterSub = "Liste des postes à sécuriser en priorité (fragilité élevée).";
    } else if (rf === "critiques-sans-porteur") {
      filterLabel = "Critiques sans porteur";
      filterSub = "Compétences critiques requises mais non portées (dans le périmètre).";
    } else if (rf === "porteur-unique") {
      filterLabel = "Porteur unique";
      filterSub = "Compétences critiques portées par une seule personne (risque de dépendance).";
    }

    if (sub) sub.textContent = filterSub;

    // bouton reset filtre (uniquement si un filtre est actif)
    const resetHtml = rf
      ? `
        <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
          <button type="button" class="btn-secondary" id="btnRiskFilterReset" style="margin-left:0;">
            Tout afficher
          </button>
        </div>
      `
      : "";

    body.innerHTML = `
      ${resetHtml}
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">${escapeHtml(filterLabel)}</div>
        <div class="card-sub" style="margin:0;">
          Résultats (à venir). Le clic KPI applique un filtre sur cette zone.
        </div>
      </div>
    `;

    // bind reset (sur contenu injecté)
    const btnReset = byId("btnRiskFilterReset");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        setRiskFilter("");
        renderDetail("risques");
      });
    }
  }


  async function refreshSummary(portal) {
    clearKpis();

    const f = getFilters();
    localStorage.setItem(STORE_SERVICE, f.id_service || "");

    // On tente un endpoint summary si présent (sinon on reste en "—" sans casser l’UI)
    const usp = new URLSearchParams();
    if (f.id_service) usp.set("id_service", f.id_service);

    const url = `${portal.apiBase}/skills/analyse/summary/${encodeURIComponent(portal.contactId)}${usp.toString() ? "?" + usp.toString() : ""}`;

    try {
      const data = await portal.apiJson(url);

      const t = data?.tiles || {};

      const r = t.risques || {};
      setText("kpiRiskPostes", r.postes_fragiles);
      setText("kpiRiskNoOwner", r.comp_critiques_sans_porteur);
      setText("kpiRiskBus1", r.comp_bus_factor_1);

      const m = t.matching || {};
      setText("kpiMatchNoCandidate", m.postes_sans_candidat);
      setText("kpiMatchReadyNow", m.candidats_prets);
      setText("kpiMatchReady6", m.candidats_prets_6m);

      const p = t.previsions || {};
      setText("kpiPrevSorties12", p.sorties_12m);
      setText("kpiPrevCompImpact", p.comp_critiques_impactees);
      setText("kpiPrevPostesRed", p.postes_rouges_12m);

      setStatus("");
    } catch (e) {
      // Pas d’API branchée = pas d’erreur bloquante
      setStatus("Résumé non disponible.");
    }
  }

  function setMode(mode) {
    const m = (mode || "").trim().toLowerCase();
    const finalMode = (m === "matching" || m === "previsions" || m === "risques") ? m : "risques";

    localStorage.setItem(STORE_MODE, finalMode);

    setActiveTile(finalMode);
    setText("analyseModeLabel", finalMode === "matching" ? "Matching" : (finalMode === "previsions" ? "Prévisions" : "Risques"));
    renderDetail(finalMode);
  }

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    const selService = byId("analyseServiceSelect");
    const btnReset = byId("btnAnalyseReset");

    const tiles = [
      byId("tileRisques"),
      byId("tileMatching"),
      byId("tilePrevisions"),
    ].filter(Boolean);

    function onTile(mode) {
      setMode(mode);
      refreshSummary(portal);
    }

    tiles.forEach(t => {
      t.addEventListener("click", () => onTile((t.getAttribute("data-mode") || "risques").trim()));
      t.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onTile((t.getAttribute("data-mode") || "risques").trim());
        }
      });
    });

    // KPI Risques cliquables => filtre du panneau détail (sans changer de page)
    const tileRisques = byId("tileRisques");
    if (tileRisques) {
      const riskKpis = tileRisques.querySelectorAll(".mini-kpi[data-risk-kpi]");

      function openRiskKpi(el) {
        const key = (el?.getAttribute("data-risk-kpi") || "").trim();
        if (!key) return;

        // On force le mode risques (si l’utilisateur était ailleurs)
        setMode("risques");

        // Filtre + rendu
        setRiskFilter(key);
        renderDetail("risques");
      }

      riskKpis.forEach((el) => {
        el.addEventListener("click", () => openRiskKpi(el));
        el.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            openRiskKpi(el);
          }
        });
      });
    }


    if (selService) {
      selService.addEventListener("change", () => {
        refreshSummary(portal);
        renderDetail(localStorage.getItem(STORE_MODE) || "risques");
      });
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (selService) selService.value = "";
        localStorage.setItem(STORE_SERVICE, "");
        refreshSummary(portal);
        renderDetail(localStorage.getItem(STORE_MODE) || "risques");
      });
    }
  }

  window.SkillsAnalyse = {
    onShow: async (portal) => {
      try {
        bindOnce(portal);
        await ensureContext(portal);

        if (!_servicesLoaded) {
          await loadServices(portal);

          const selService = byId("analyseServiceSelect");
          const storedService = (localStorage.getItem(STORE_SERVICE) || "").trim();
          if (selService && storedService && Array.from(selService.options).some(o => o.value === storedService)) {
            selService.value = storedService;
          } else if (selService) {
            selService.value = "";
          }
        }

        const storedMode = (localStorage.getItem(STORE_MODE) || "risques").trim();
        setMode(storedMode);

        // Restaurer le filtre risques si on arrive (ou revient) sur Risques
        if (storedMode === "risques") {
          const rf = getRiskFilter();
          setActiveRiskKpi(rf);
          renderDetail("risques");
        }

        await refreshSummary(portal);


      } catch (e) {
        portal.showAlert("error", "Erreur analyse : " + (e.message || "inconnue"));
        console.error(e);
      }
    }
  };
})();
