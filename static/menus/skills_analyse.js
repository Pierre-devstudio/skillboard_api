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

  function renderDetail(mode) {
    const scope = getScopeLabel();

    const title = byId("analyseDetailTitle");
    const sub = byId("analyseDetailSub");
    const meta = byId("analyseDetailMeta");
    const body = byId("analyseDetailBody");

    if (meta) meta.textContent = `Service : ${scope}`;

    if (!body) return;

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

    // défaut: risques
    if (title) title.textContent = "Risques";
    if (sub) sub.textContent = "Priorisation des fragilités par criticité et couverture. Le détail arrivera avec l’API dédiée.";
    body.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Ce que vous allez obtenir</div>
        <div class="card-sub" style="margin:0;">
          - Top risques (poste / compétence / criticité / couverture)<br/>
          - Compétences critiques sans porteur et bus factor<br/>
          - Décision: sécuriser, transférer, former, recruter
        </div>
      </div>
      <div class="card" style="padding:12px; margin-top:12px;">
        <div class="card-title" style="margin-bottom:6px;">Résultats (à venir)</div>
        <div class="card-sub" style="margin:0;">Aucune donnée chargée.</div>
      </div>
    `;
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

        await refreshSummary(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur analyse : " + (e.message || "inconnue"));
        console.error(e);
      }
    }
  };
})();
