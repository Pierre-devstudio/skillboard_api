/* ======================================================
   static/menus/skills_simulations_rh.js
   - Menu "Simulations RH & arbitrages"
   - Construction ludique de scénarios
   - Simulation backend déterministe
   - Comparatif temporaire localStorage
   ====================================================== */

(function () {
  let _bound = false;
  let _portal = null;
  let _optionsLoaded = false;
  let _options = { postes: [], effectifs: [], competences: [] };
  let _hypotheses = [];
  let _lastResult = null;

  const STORE_COMPARE = "sb_simulations_rh_compare_v1";
  const STORE_SERVICE = "sb_simulations_rh_service";
  const STORE_CRIT = "sb_simulations_rh_criticite";

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function errMsg(e) {
    if (!e) return "Erreur inconnue";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    if (e.detail) return typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  function setStatus(message, type) {
    const el = byId("simStatus");
    if (!el) return;
    if (!message) {
      el.style.display = "none";
      el.textContent = "";
      el.className = "sb-hint";
      return;
    }
    el.style.display = "block";
    el.className = "sb-hint" + (type === "error" ? " error" : "");
    el.textContent = message;
  }

  function getCriticiteMin() {
    const raw = parseInt(byId("simCriticiteRange")?.value || localStorage.getItem(STORE_CRIT) || "70", 10);
    if (Number.isNaN(raw)) return 70;
    return Math.max(0, Math.min(100, raw));
  }

  function setCriticiteMin(v) {
    const n = Math.max(0, Math.min(100, parseInt(v || 70, 10) || 70));
    const input = byId("simCriticiteRange");
    const label = byId("simCriticiteValue");
    if (input) input.value = String(n);
    if (label) label.textContent = String(n);
    localStorage.setItem(STORE_CRIT, String(n));
    return n;
  }

  function getServiceId() {
    return window.portal?.serviceFilter?.toQueryId?.(byId("simServiceSelect")?.value || "") || null;
  }

  function apiUrl(path, params) {
    const url = new URL(`${_portal.apiBase}${path}`);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
    });
    return url.toString();
  }

  function readCompare() {
    try {
      const raw = localStorage.getItem(STORE_COMPARE);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function writeCompare(list) {
    localStorage.setItem(STORE_COMPARE, JSON.stringify(Array.isArray(list) ? list : []));
    renderCompare();
    updateCompareCount();
  }

  function updateCompareCount() {
    const el = byId("simCompareCount");
    if (el) el.textContent = String(readCompare().length);
  }

  function optionLabelPoste(p) {
    const code = (p.codif_poste || "").trim();
    const svc = (p.nom_service || "").trim();
    return `${code ? code + " · " : ""}${p.intitule_poste || "Poste"}${svc ? " — " + svc : ""}`;
  }

  function optionLabelEffectif(e) {
    const poste = (e.intitule_poste || "").trim();
    const svc = (e.nom_service || "").trim();
    return `${e.nom_complet || "Collaborateur"}${poste ? " — " + poste : ""}${svc ? " · " + svc : ""}`;
  }

  function optionLabelCompetence(c) {
    const code = (c.code || "").trim();
    const dom = (c.domaine || "").trim();
    return `${code ? code + " · " : ""}${c.intitule || "Compétence"}${dom ? " — " + dom : ""}`;
  }

  function fillSelect(el, list, valueKey, labelFn, placeholder) {
    if (!el) return;
    const previous = el.value;
    el.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder || "Sélectionner…";
    el.appendChild(opt0);

    (Array.isArray(list) ? list : []).forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item[valueKey] || "";
      opt.textContent = labelFn(item);
      el.appendChild(opt);
    });

    if (previous && Array.from(el.options).some(o => o.value === previous)) el.value = previous;
  }

  async function populateServices() {
    if (!window.portal?.serviceFilter?.populateSelect) return;
    await window.portal.serviceFilter.populateSelect({
      portal: _portal,
      contactId: _portal.contactId,
      selectId: "simServiceSelect",
      storageKey: STORE_SERVICE,
      includeAll: true,
      includeNonLie: true,
      labelAll: "Tous les services",
      labelNonLie: "Non liés"
    });
  }

  async function loadOptions(force) {
    if (_optionsLoaded && !force) return _options;
    if (!_portal || !_portal.contactId) return _options;

    setStatus("Chargement des données de simulation…");
    const data = await _portal.apiJson(apiUrl(`/skills/simulations/options/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin()
    }));

    _options = {
      postes: Array.isArray(data?.postes) ? data.postes : [],
      effectifs: Array.isArray(data?.effectifs) ? data.effectifs : [],
      competences: Array.isArray(data?.competences) ? data.competences : [],
      scope: data?.scope || null
    };
    _optionsLoaded = true;
    renderHypFields();
    setStatus("");
    return _options;
  }

  function switchTab(tab) {
    const wanted = tab || "build";
    document.querySelectorAll(".sim-tab-btn").forEach(btn => {
      btn.classList.toggle("is-active", btn.getAttribute("data-sim-tab") === wanted);
    });
    document.querySelectorAll(".sim-panel").forEach(panel => {
      panel.style.display = panel.getAttribute("data-sim-panel") === wanted ? "block" : "none";
    });
    if (wanted === "compare") renderCompare();
  }

  function hypLabel(h) {
    const eff = _options.effectifs.find(x => x.id_effectif === h.id_effectif);
    const poste = _options.postes.find(x => x.id_poste === (h.id_poste_cible || h.id_poste));
    const comp = _options.competences.find(x => x.id_comp === h.id_comp);
    const name = eff?.nom_complet || "Collaborateur";
    const posteName = poste?.intitule_poste || "Poste";
    const compName = comp?.intitule || "Compétence";

    if (h.type === "depart_effectif") return `Départ simulé de ${name}`;
    if (h.type === "absence_effectif") return `Absence temporaire de ${name}`;
    if (h.type === "mobilite_effectif") return `Mobilité de ${name} vers ${posteName}`;
    if (h.type === "montee_competence") return `${name} monte sur ${compName} au niveau ${h.niveau_simule || "—"}`;
    if (h.type === "recrutement_virtuel") return `Recrutement / renfort sur ${posteName}`;
    return "Hypothèse";
  }

  function renderHypFields() {
    const box = byId("simHypFields");
    const type = byId("simHypType")?.value || "depart_effectif";
    if (!box) return;

    const effectifSelect = `
      <div class="info-item">
        <div class="label">Collaborateur</div>
        <select id="simHypEffectif" class="sb-select"></select>
      </div>`;

    const posteSelect = `
      <div class="info-item">
        <div class="label">Poste cible</div>
        <select id="simHypPoste" class="sb-select"></select>
      </div>`;

    const compSelect = `
      <div class="info-item">
        <div class="label">Compétence</div>
        <select id="simHypComp" class="sb-select"></select>
      </div>`;

    const levelSelect = `
      <div class="info-item">
        <div class="label">Niveau simulé</div>
        <select id="simHypNiveau" class="sb-select">
          <option value="A">A - Initial</option>
          <option value="B">B - Avancé</option>
          <option value="C">C - Expert</option>
        </select>
      </div>`;

    if (type === "mobilite_effectif") box.innerHTML = effectifSelect + posteSelect;
    else if (type === "montee_competence") box.innerHTML = effectifSelect + compSelect + levelSelect;
    else if (type === "recrutement_virtuel") box.innerHTML = posteSelect;
    else box.innerHTML = effectifSelect;

    fillSelect(byId("simHypEffectif"), _options.effectifs, "id_effectif", optionLabelEffectif, "Choisir un collaborateur…");
    fillSelect(byId("simHypPoste"), _options.postes, "id_poste", optionLabelPoste, "Choisir un poste…");
    fillSelect(byId("simHypComp"), _options.competences, "id_comp", optionLabelCompetence, "Choisir une compétence…");
  }

  function renderHypList() {
    const box = byId("simHypList");
    if (!box) return;
    if (!_hypotheses.length) {
      box.innerHTML = `<div class="sim-empty-state">Aucune hypothèse ajoutée.</div>`;
      return;
    }
    box.innerHTML = _hypotheses.map((h, idx) => `
      <div class="sim-hyp-card">
        <div>
          <div class="sim-hyp-title">${escapeHtml(hypLabel(h))}</div>
          <div class="card-sub" style="margin:3px 0 0 0;">Hypothèse ${idx + 1}</div>
        </div>
        <button type="button" class="sb-btn sb-btn--soft" data-remove-hyp="${idx}">Retirer</button>
      </div>
    `).join("");

    box.querySelectorAll("[data-remove-hyp]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-remove-hyp"), 10);
        _hypotheses.splice(idx, 1);
        renderHypList();
      });
    });
  }

  function addHypothesis() {
    const type = byId("simHypType")?.value || "";
    const id_effectif = byId("simHypEffectif")?.value || "";
    const id_poste_cible = byId("simHypPoste")?.value || "";
    const id_comp = byId("simHypComp")?.value || "";
    const niveau_simule = byId("simHypNiveau")?.value || "";

    const h = { type };
    if (["depart_effectif", "absence_effectif", "mobilite_effectif", "montee_competence"].includes(type)) {
      if (!id_effectif) return setStatus("Sélectionnez un collaborateur pour ajouter cette hypothèse.", "error");
      h.id_effectif = id_effectif;
    }
    if (["mobilite_effectif", "recrutement_virtuel"].includes(type)) {
      if (!id_poste_cible) return setStatus("Sélectionnez un poste cible pour ajouter cette hypothèse.", "error");
      h.id_poste_cible = id_poste_cible;
    }
    if (type === "montee_competence") {
      if (!id_comp) return setStatus("Sélectionnez une compétence pour ajouter cette hypothèse.", "error");
      h.id_comp = id_comp;
      h.niveau_simule = niveau_simule || "B";
    }

    setStatus("");
    _hypotheses.push(h);
    renderHypList();
  }

  function meterHtml(value, label) {
    const v = Math.max(0, Math.min(100, parseInt(value || 0, 10) || 0));
    return `
      <div class="sim-meter-wrap">
        <div class="sim-meter-head"><span>${escapeHtml(label || "Score")}</span><strong>${v}%</strong></div>
        <div class="sim-meter"><span style="width:${v}%"></span></div>
      </div>
    `;
  }

  function impactBadge(delta) {
    const d = parseInt(delta || 0, 10) || 0;
    if (d <= -8) return `<span class="sb-badge sb-badge--success">Amélioration ${d}</span>`;
    if (d >= 8) return `<span class="sb-badge sb-badge--danger">Dégradation +${d}</span>`;
    return `<span class="sb-badge sb-badge--info">Stable ${d >= 0 ? "+" : ""}${d}</span>`;
  }

  function renderQuickPreview(result) {
    const box = byId("simQuickPreview");
    if (!box) return;
    if (!result) {
      box.innerHTML = `<div class="sim-empty-state">Aucun scénario simulé pour l’instant.</div>`;
      return;
    }
    box.innerHTML = `
      <div class="sim-mini-result">
        <div class="sim-result-title">${escapeHtml(result.titre || "Scénario RH")}</div>
        <div class="sim-before-after">
          ${meterHtml(result.actuel?.fragilite_moyenne || 0, "Avant")}
          ${meterHtml(result.simule?.fragilite_moyenne || 0, "Après")}
        </div>
        <div style="margin-top:10px;">${impactBadge(result.ecart?.fragilite_moyenne || 0)}</div>
        <div class="card-sub" style="margin-top:10px;">${escapeHtml(result.conseil?.lecture || "Résultat disponible.")}</div>
        <div class="sb-actions" style="margin-top:12px;">
          <button type="button" class="sb-btn sb-btn--accent" id="btnSimQuickOpenResult">Voir le résultat</button>
        </div>
      </div>
    `;
    byId("btnSimQuickOpenResult")?.addEventListener("click", () => switchTab("result"));
  }

  function renderResult(result) {
    const root = byId("simResultContainer");
    if (!root) return;
    if (!result) {
      root.innerHTML = `
        <div class="card">
          <div class="card-title">Résultat</div>
          <div class="card-sub" style="margin:6px 0 0 0;">Lancez une simulation depuis l’onglet Construire.</div>
        </div>`;
      return;
    }

    const impacted = result.impact?.postes_impactes || [];
    const missingCot = result.cotation?.postes_non_cotes || [];
    const alternatives = result.conseil?.alternatives || [];
    const missingData = result.conseil?.donnees_manquantes || [];
    const cotLines = result.cotation?.lignes || [];

    root.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div class="card-title">${escapeHtml(result.titre || "Scénario RH")}</div>
            <div class="card-sub" style="margin:6px 0 0 0;">Périmètre : ${escapeHtml(result.scope?.nom_service || "Tous les services")}</div>
          </div>
          <div class="sb-actions sb-actions--end">
            <button type="button" class="sb-btn sb-btn--accent" id="btnSimAddCompare">Ajouter au comparatif</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimBackBuild">Modifier le scénario</button>
          </div>
        </div>
      </div>

      <div class="sim-kpi-grid" style="margin-top:12px;">
        <div class="card sim-kpi-card">
          <div class="label">Fragilité moyenne</div>
          <div class="sim-kpi-value">${escapeHtml(result.actuel?.fragilite_moyenne ?? "—")} → ${escapeHtml(result.simule?.fragilite_moyenne ?? "—")}</div>
          <div style="margin-top:8px;">${impactBadge(result.ecart?.fragilite_moyenne || 0)}</div>
        </div>
        <div class="card sim-kpi-card">
          <div class="label">Postes sécurisés</div>
          <div class="sim-kpi-value">${escapeHtml(result.impact?.postes_securises ?? 0)}</div>
          <div class="card-sub" style="margin-top:8px;">Amélioration ≥ 10 points</div>
        </div>
        <div class="card sim-kpi-card">
          <div class="label">Postes dégradés</div>
          <div class="sim-kpi-value">${escapeHtml(result.impact?.postes_degrades ?? 0)}</div>
          <div class="card-sub" style="margin-top:8px;">Effet domino à contrôler</div>
        </div>
        <div class="card sim-kpi-card">
          <div class="label">Cotation</div>
          <div class="sim-kpi-value">${escapeHtml(result.cotation?.niveau || "non estimé")}</div>
          <div class="card-sub" style="margin-top:8px;">Fiabilité : ${escapeHtml(result.cotation?.fiabilite || "partielle")}</div>
        </div>
      </div>

      <div class="card sim-ai-card" style="margin-top:12px;">
        <div class="card-title">Lecture RH augmentée</div>
        <div class="sim-ai-text">${escapeHtml(result.conseil?.lecture || "—")}</div>
        <div class="sim-ai-decision">${escapeHtml(result.conseil?.decision_prioritaire || "—")}</div>
        ${alternatives.length ? `
          <details class="sim-details">
            <summary>Voir les scénarios alternatifs</summary>
            <div class="sim-detail-body">
              ${alternatives.map(x => `<div class="sim-line">${escapeHtml(x)}</div>`).join("")}
            </div>
          </details>` : ""}
        ${missingData.length ? `
          <details class="sim-details">
            <summary>Données à compléter</summary>
            <div class="sim-detail-body">
              ${missingData.map(x => `<div class="sim-line sim-line-warning">${escapeHtml(x)}</div>`).join("")}
            </div>
          </details>` : ""}
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="card-title">Détails activables</div>
        <div class="card-sub" style="margin:6px 0 0 0;">Les détails restent repliés par défaut. L’écran respire, concept révolutionnaire.</div>

        <details class="sim-details">
          <summary>Postes impactés (${impacted.length})</summary>
          <div class="sim-detail-body">
            ${impacted.length ? impacted.map(p => `
              <div class="sim-impact-row">
                <div>
                  <div class="sim-impact-title">${escapeHtml(p.intitule_poste || "Poste")}</div>
                  <div class="card-sub" style="margin:3px 0 0 0;">${escapeHtml(p.nom_service || "")}</div>
                </div>
                <div class="sim-impact-score">${escapeHtml(p.fragilite_avant)} → ${escapeHtml(p.fragilite_apres)}</div>
                <div>${impactBadge(p.delta || 0)}</div>
              </div>
            `).join("") : `<div class="sim-empty-state">Aucun poste avec variation significative.</div>`}
          </div>
        </details>

        <details class="sim-details">
          <summary>Cotation et impact financier (${cotLines.length})</summary>
          <div class="sim-detail-body">
            ${cotLines.length ? cotLines.map(c => `
              <div class="sim-impact-row">
                <div>
                  <div class="sim-impact-title">${escapeHtml(c.poste_source)} → ${escapeHtml(c.poste_cible)}</div>
                  <div class="card-sub" style="margin:3px 0 0 0;">${escapeHtml(c.cotation_source)} → ${escapeHtml(c.cotation_cible)}</div>
                </div>
                <div class="sim-impact-score">${c.delta === null || c.delta === undefined ? "—" : escapeHtml(c.delta)}</div>
                <div><span class="sb-badge ${c.fiable ? "sb-badge--success" : "sb-badge--warning"}">${escapeHtml(c.fiable ? "fiable" : "partiel")}</span></div>
              </div>
            `).join("") : `<div class="sim-empty-state">Aucun impact cotation estimé.</div>`}
            ${missingCot.length ? `
              <div style="margin-top:10px;">
                <div class="label">Postes à coter pour affiner</div>
                ${missingCot.map(p => `<div class="sim-line sim-line-warning">${escapeHtml(p.codif_poste ? p.codif_poste + " · " : "")}${escapeHtml(p.intitule_poste)}</div>`).join("")}
              </div>` : ""}
          </div>
        </details>

        <details class="sim-details">
          <summary>Hypothèses utilisées (${(result.hypotheses || []).length})</summary>
          <div class="sim-detail-body">
            ${(result.hypotheses || []).map((h, idx) => `<div class="sim-line">${idx + 1}. ${escapeHtml(hypLabel(h))}</div>`).join("") || `<div class="sim-empty-state">Aucune hypothèse.</div>`}
          </div>
        </details>
      </div>
    `;

    byId("btnSimBackBuild")?.addEventListener("click", () => switchTab("build"));
    byId("btnSimAddCompare")?.addEventListener("click", () => addLastResultToCompare());
  }

  async function evaluateScenario() {
    if (!_hypotheses.length) return setStatus("Ajoutez au moins une hypothèse avant de lancer la simulation.", "error");
    await loadOptions(false);

    const title = (byId("simScenarioTitle")?.value || "").trim() || "Scénario RH";
    const objectif = byId("simObjectiveSelect")?.value || "";
    setStatus("Simulation en cours…");

    const result = await _portal.apiJson(apiUrl(`/skills/simulations/evaluer/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin()
    }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titre: title, objectif, hypotheses: _hypotheses })
    });

    _lastResult = result;
    setStatus("");
    renderQuickPreview(result);
    renderResult(result);
    switchTab("result");
  }

  function addLastResultToCompare() {
    if (!_lastResult) return;
    const list = readCompare();
    const item = {
      id: `sim_${Date.now()}`,
      saved_at: new Date().toISOString(),
      result: _lastResult
    };
    list.unshift(item);
    writeCompare(list.slice(0, 8));
    setStatus("Scénario ajouté au comparatif temporaire.");
    switchTab("compare");
  }

  function compareReco(list) {
    if (!list.length) return "Aucun scénario à comparer.";
    const scored = list.map(x => {
      const r = x.result || {};
      const riskDelta = parseInt(r.ecart?.fragilite_moyenne || 0, 10) || 0;
      const degraded = parseInt(r.impact?.postes_degrades || 0, 10) || 0;
      const cotPenalty = r.cotation?.fiabilite === "complète" ? 0 : 6;
      const score = (-riskDelta * 2) - (degraded * 8) - cotPenalty;
      return { item: x, score, riskDelta, degraded };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0]?.item?.result;
    if (!best) return "Comparatif insuffisant.";
    return `Le scénario le plus équilibré selon les données disponibles est « ${best.titre || "Scénario RH"} ». Vérifiez surtout les postes dégradés et les cotations manquantes avant arbitrage.`;
  }

  function renderCompare() {
    const root = byId("simCompareContainer");
    if (!root) return;
    const list = readCompare();
    updateCompareCount();

    if (!list.length) {
      root.innerHTML = `<div class="card"><div class="sim-empty-state">Aucun scénario dans le comparatif.</div></div>`;
      return;
    }

    root.innerHTML = `
      <div class="card sim-ai-card">
        <div class="card-title">Lecture comparative</div>
        <div class="sim-ai-text">${escapeHtml(compareReco(list))}</div>
      </div>

      <div class="card" style="margin-top:12px; overflow:auto;">
        <table class="sb-table sim-compare-table">
          <thead>
            <tr>
              <th>Scénario</th>
              <th>Fragilité</th>
              <th>Postes sécurisés</th>
              <th>Postes dégradés</th>
              <th>Cotation</th>
              <th>Fiabilité</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map((x, idx) => {
              const r = x.result || {};
              const delta = parseInt(r.ecart?.fragilite_moyenne || 0, 10) || 0;
              return `
                <tr>
                  <td>
                    <div class="sim-impact-title">${escapeHtml(r.titre || "Scénario RH")}</div>
                    <div class="card-sub" style="margin:3px 0 0 0;">${escapeHtml(r.scope?.nom_service || "Tous les services")}</div>
                  </td>
                  <td>${impactBadge(delta)}</td>
                  <td>${escapeHtml(r.impact?.postes_securises ?? 0)}</td>
                  <td>${escapeHtml(r.impact?.postes_degrades ?? 0)}</td>
                  <td>${escapeHtml(r.cotation?.niveau || "non estimé")}</td>
                  <td><span class="sb-badge ${r.cotation?.fiabilite === "complète" ? "sb-badge--success" : "sb-badge--warning"}">${escapeHtml(r.cotation?.fiabilite || "partielle")}</span></td>
                  <td><button type="button" class="sb-btn sb-btn--soft" data-remove-compare="${idx}">Retirer</button></td>
                </tr>
                <tr class="sim-compare-detail-row">
                  <td colspan="7">
                    <details class="sim-details">
                      <summary>Lecture RH</summary>
                      <div class="sim-detail-body">
                        <div class="sim-line">${escapeHtml(r.conseil?.lecture || "—")}</div>
                        <div class="sim-line">${escapeHtml(r.conseil?.decision_prioritaire || "—")}</div>
                      </div>
                    </details>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    root.querySelectorAll("[data-remove-compare]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-remove-compare"), 10);
        const next = readCompare();
        next.splice(idx, 1);
        writeCompare(next);
      });
    });
  }

  function resetScenario() {
    _hypotheses = [];
    _lastResult = null;
    if (byId("simScenarioTitle")) byId("simScenarioTitle").value = "";
    renderHypList();
    renderQuickPreview(null);
    renderResult(null);
    setStatus("");
    switchTab("build");
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    document.querySelectorAll(".sim-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.getAttribute("data-sim-tab") || "build"));
    });

    byId("simHypType")?.addEventListener("change", renderHypFields);
    byId("btnSimAddHyp")?.addEventListener("click", addHypothesis);
    byId("btnSimEvaluate")?.addEventListener("click", () => evaluateScenario().catch(e => setStatus(errMsg(e), "error")));
    byId("btnSimResetScenario")?.addEventListener("click", resetScenario);
    byId("btnSimReloadOptions")?.addEventListener("click", () => loadOptions(true).catch(e => setStatus(errMsg(e), "error")));
    byId("btnSimClearCompare")?.addEventListener("click", () => writeCompare([]));

    byId("simCriticiteRange")?.addEventListener("input", (e) => setCriticiteMin(e.target.value));
    byId("simCriticiteRange")?.addEventListener("change", () => {
      _optionsLoaded = false;
      loadOptions(true).catch(e => setStatus(errMsg(e), "error"));
    });

    byId("simServiceSelect")?.addEventListener("change", () => {
      _optionsLoaded = false;
      loadOptions(true).catch(e => setStatus(errMsg(e), "error"));
    });
  }

  async function onShow(portal) {
    _portal = portal;
    bindOnce();
    setCriticiteMin(localStorage.getItem(STORE_CRIT) || 70);
    renderHypList();
    updateCompareCount();
    renderCompare();

    try {
      await populateServices();
      await loadOptions(false);
    } catch (e) {
      setStatus(errMsg(e), "error");
    }
  }

  window.SkillsSimulationsRH = { onShow };
})();
