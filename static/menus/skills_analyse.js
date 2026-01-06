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
  let _portalRef = null;

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

  const CRITICITE_MIN = 3;
  const _riskDetailCache = new Map();
  let _riskDetailReqSeq = 0;

  function buildQueryString(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === null || v === undefined || v === "") return;
      usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }

  async function fetchRisquesDetail(portal, kpiKey, id_service, limit = 50) {
    const svc = (id_service || "").trim();
    const key = `${svc}|${kpiKey}|${CRITICITE_MIN}|${limit}`;
    if (_riskDetailCache.has(key)) return _riskDetailCache.get(key);

    const qs = buildQueryString({
      kpi: kpiKey,
      id_service: svc || null,
      criticite_min: CRITICITE_MIN,
      limit: limit
    });

    const url = `${portal.apiBase}/skills/analyse/risques/detail/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _riskDetailCache.set(key, data);
    return data;
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
    // RISQUES (API + filtre KPI)
    // -----------------------
    const rf = getRiskFilter(); // "", "postes-fragiles", "critiques-sans-porteur", "porteur-unique"
    setActiveRiskKpi(rf);

    if (title) title.textContent = "Risques";

    let filterLabel = "Vue globale";
    let filterSub = "Priorisation des fragilités par criticité et couverture.";

    if (rf === "postes-fragiles") {
      filterLabel = "Postes fragiles";
      filterSub = "Postes à sécuriser en priorité (critiques avec couverture faible).";
    } else if (rf === "critiques-sans-porteur") {
      filterLabel = "Critiques sans porteur";
      filterSub = "Compétences critiques requises mais non portées (dans le périmètre).";
    } else if (rf === "porteur-unique") {
      filterLabel = "Porteur unique";
      filterSub = "Compétences critiques portées par une seule personne (dépendance).";
    }

    if (sub) sub.textContent = filterSub;

    const selSvc = byId("analyseServiceSelect") || byId("anaServiceSelect") || byId("mapServiceSelect");
    const id_service = (selSvc?.value || "").trim();

    function badge(txt, accent) {
      const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
      return `<span class="${cls}">${escapeHtml(txt || "—")}</span>`;
    }

    function renderDomainPill(item) {
      const lab = (item?.domaine_titre_court || item?.domaine_titre || item?.id_domaine_competence || "—").toString();
      const col = normalizeColor(item?.domaine_couleur) || "#e5e7eb";
      return `
        <span style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid #d1d5db; border-radius:999px; font-size:12px; color:#374151; background:#fff;">
          <span style="display:inline-block; width:10px; height:10px; border-radius:999px; border:1px solid #d1d5db; background:${escapeHtml(col)};"></span>
          <span title="${escapeHtml(lab)}">${escapeHtml(lab)}</span>
        </span>
      `;
    }

    function renderTablePostes(rows) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;
      }

      return `
        <div class="table-wrap" style="margin-top:10px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Poste</th>
                <th style="width:200px;">Service</th>
                <th class="col-center" style="width:160px;">Critiques sans porteur</th>
                <th class="col-center" style="width:140px;">Porteur unique</th>
                <th class="col-center" style="width:140px;">Total fragiles</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(r => {
                const poste = `${(r.codif_poste || "").trim()}${r.codif_poste ? " — " : ""}${(r.intitule_poste || "").trim()}`.trim() || "—";
                const svc = (r.nom_service || "").trim() || "—";

                const a = Number(r.nb_critiques_sans_porteur || 0);
                const b = Number(r.nb_critiques_porteur_unique || 0);
                const c = Number(r.nb_critiques_fragiles || 0);

                return `
                  <tr>
                    <td style="font-weight:700;">${escapeHtml(poste)}</td>
                    <td>${escapeHtml(svc)}</td>
                    <td class="col-center">${a ? badge(String(a), true) : badge("0", false)}</td>
                    <td class="col-center">${b ? badge(String(b), true) : badge("0", false)}</td>
                    <td class="col-center">${c ? badge(String(c), true) : badge("0", false)}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
    }

    function renderTableCompetences(rows) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;
      }

      return `
        <div class="table-wrap" style="margin-top:10px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th style="width:240px;">Domaine</th>
                <th style="width:90px;">Code</th>
                <th>Compétence</th>
                <th class="col-center" style="width:130px;">Postes impactés</th>
                <th class="col-center" style="width:120px;">Criticité</th>
                <th class="col-center" style="width:110px;">Porteurs</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(r => {
                const code = (r.code || "—").toString();
                const intit = (r.intitule || "—").toString();

                const nbPostes = Number(r.nb_postes_impactes || 0);
                const nbPorteurs = Number(r.nb_porteurs || 0);
                const crit = Number(r.max_criticite || 0);

                return `
                  <tr>
                    <td>${renderDomainPill(r)}</td>
                    <td style="font-weight:700; white-space:nowrap;">${escapeHtml(code)}</td>
                    <td>${escapeHtml(intit)}</td>
                    <td class="col-center">${nbPostes ? badge(String(nbPostes), true) : badge("0", false)}</td>
                    <td class="col-center">${crit ? badge(String(crit), true) : badge("—", false)}</td>
                    <td class="col-center">${nbPorteurs ? badge(String(nbPorteurs), true) : badge("0", false)}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
    }

    // UI immédiate (évite l'impression "ça fait rien")
    const resetHtml = rf
      ? `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            ${badge(filterLabel, true)}
            ${badge(`Criticité min: ${CRITICITE_MIN}`, false)}
          </div>
          <button type="button" class="btn-secondary" id="btnRiskFilterReset" style="margin-left:0;">
            Tout afficher
          </button>
        </div>
      `
      : `
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
          ${badge("Vue globale", true)}
          ${badge(`Criticité min: ${CRITICITE_MIN}`, false)}
        </div>
      `;

    body.innerHTML = `
      ${resetHtml}
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-sub" style="margin:0;">Chargement…</div>
      </div>
    `;

    const btnReset = byId("btnRiskFilterReset");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        setRiskFilter("");
        renderDetail("risques");
      });
    }

    if (!_portalRef) {
      body.innerHTML = `
        ${resetHtml}
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-sub" style="margin:0;">Contexte portail indisponible.</div>
        </div>
      `;
      return;
    }

    const mySeq = ++_riskDetailReqSeq;

    (async () => {
      try {
        if (rf) {
          const data = await fetchRisquesDetail(_portalRef, rf, id_service, 120);
          if (mySeq !== _riskDetailReqSeq) return;

          const items = Array.isArray(data?.items) ? data.items : [];

          let content = `
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">${escapeHtml(filterLabel)}</div>
              <div class="card-sub" style="margin:0;">${escapeHtml(filterSub)}</div>
              ${rf === "postes-fragiles" ? renderTablePostes(items) : renderTableCompetences(items)}
            </div>
          `;

          body.innerHTML = `${resetHtml}${content}`;
          const btnReset2 = byId("btnRiskFilterReset");
          if (btnReset2) {
            btnReset2.addEventListener("click", () => {
              setRiskFilter("");
              renderDetail("risques");
            });
          }
          return;
        }

        // Vue globale = 3 listes
        const [a, b, c] = await Promise.all([
          fetchRisquesDetail(_portalRef, "postes-fragiles", id_service, 20),
          fetchRisquesDetail(_portalRef, "critiques-sans-porteur", id_service, 20),
          fetchRisquesDetail(_portalRef, "porteur-unique", id_service, 20),
        ]);

        if (mySeq !== _riskDetailReqSeq) return;

        const itemsA = Array.isArray(a?.items) ? a.items : [];
        const itemsB = Array.isArray(b?.items) ? b.items : [];
        const itemsC = Array.isArray(c?.items) ? c.items : [];

        body.innerHTML = `
          ${resetHtml}

          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Postes fragiles</div>
            <div class="card-sub" style="margin:0;">Top postes à sécuriser (critiques avec couverture faible).</div>
            ${renderTablePostes(itemsA)}
          </div>

          <div class="card" style="padding:12px; margin-top:12px;">
            <div class="card-title" style="margin-bottom:6px;">Critiques sans porteur</div>
            <div class="card-sub" style="margin:0;">Compétences critiques requises mais non portées.</div>
            ${renderTableCompetences(itemsB)}
          </div>

          <div class="card" style="padding:12px; margin-top:12px;">
            <div class="card-title" style="margin-bottom:6px;">Porteur unique</div>
            <div class="card-sub" style="margin:0;">Compétences critiques portées par une seule personne.</div>
            ${renderTableCompetences(itemsC)}
          </div>
        `;
      } catch (e) {
        if (mySeq !== _riskDetailReqSeq) return;

        body.innerHTML = `
          ${resetHtml}
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>
          </div>
        `;
      }
    })();
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
        _portalRef = portal;

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
