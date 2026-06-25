/* ======================================================
   static/menus/skills_simulations_rh.js
   Simulation RH - atelier de scénarios d'organisation
   ====================================================== */

(function () {
  let _bound = false;
  let _portal = null;
  let _optionsLoaded = false;
  let _options = { postes: [], effectifs: [], competences: [], requirements: [], recommendations: {} };
  let _selectedPosteId = "";
  let _selectedBrick = "mobilite_effectif";
  let _scenario = [];
  let _lastResult = null;
  let _context = null;

  const STORE_COMPARE = "sb_simulations_rh_compare_v3";
  const STORE_SERVICE = "sb_simulations_rh_service";
  const STORE_CRIT = "sb_simulations_rh_criticite";
  const STORE_CONTEXT = "sb_simulations_rh_context_v1";

  const BRICKS = {
    mobilite_effectif: {
      title: "Déplacer une personne",
      short: "Tester une mobilité, un remplacement ou un renfort humain.",
      icon: "⇄",
      group: "immediate",
      temporalite: "immediate",
    },
    transfert_charge: {
      title: "Transférer une charge",
      short: "Déplacer une activité ou une compétence attendue vers un autre poste.",
      icon: "⇢",
      group: "immediate",
      temporalite: "immediate",
    },
    renfort_poste: {
      title: "Ajouter un renfort",
      short: "Tester un recrutement ou un profil virtuel sur un poste.",
      icon: "+",
      group: "immediate",
      temporalite: "immediate",
    },
    depart_effectif: {
      title: "Retirer une personne",
      short: "Tester une sortie, une absence ou une perte de couverture.",
      icon: "−",
      group: "immediate",
      temporalite: "immediate",
    },
    montee_competence: {
      title: "Projeter une compétence",
      short: "Mesurer l’impact si un niveau cible est atteint.",
      icon: "↗",
      group: "projected",
      temporalite: "development",
    },
  };

  function byId(id) { return document.getElementById(id); }
  function esc(s) { return (s ?? "").toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
  function int(v) { return Math.round(num(v)); }
  function errMsg(e) { if (!e) return "Erreur inconnue"; if (typeof e === "string") return e; if (e.message) return e.message; if (e.detail) return typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail); try { return JSON.stringify(e); } catch (_) { return String(e); } }

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

  function apiUrl(path, params) {
    const url = new URL(`${_portal.apiBase}${path}`);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
    });
    return url.toString();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getCriticiteMin() {
    const raw = parseInt(byId("simCriticiteRange")?.value || localStorage.getItem(STORE_CRIT) || "70", 10);
    return Number.isNaN(raw) ? 70 : Math.max(0, Math.min(100, raw));
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

  function posteById(id) { return (_options.postes || []).find(p => String(p.id_poste || "") === String(id || "")) || null; }
  function effectifById(id) { return (_options.effectifs || []).find(e => String(e.id_effectif || "") === String(id || "")) || null; }
  function compById(id) { return (_options.competences || []).find(c => String(c.id_comp || "") === String(id || "")) || (_options.requirements || []).find(c => String(c.id_comp || "") === String(id || "")) || null; }

  function posteLabel(p) {
    if (!p) return "Poste";
    const code = (p.codif_poste || "").trim();
    return `${code ? code + " · " : ""}${p.intitule_poste || "Poste"}`;
  }

  function effectifLabel(e) {
    if (!e) return "Collaborateur";
    const poste = (e.intitule_poste || "").trim();
    return `${e.nom_complet || "Collaborateur"}${poste ? " — " + poste : ""}`;
  }

  function compLabel(c) {
    if (!c) return "Compétence";
    const code = (c.code || "").trim();
    return `${code ? code + " · " : ""}${c.intitule || "Compétence"}`;
  }

  function deltaText(v) {
    const n = int(v);
    if (n === 0) return "0 pt";
    return `${n > 0 ? "+" : ""}${n} pt${Math.abs(n) > 1 ? "s" : ""}`;
  }

  function deltaBadge(v, inverse) {
    const n = int(v);
    const good = inverse ? n > 0 : n < 0;
    const bad = inverse ? n < 0 : n > 0;
    const cls = good ? "sb-badge--success" : bad ? "sb-badge--warning" : "";
    return `<span class="sb-badge ${cls}">${esc(deltaText(n))}</span>`;
  }

  function trendWord(delta, inverse) {
    const n = int(delta);
    if (n === 0) return "stable";
    const good = inverse ? n > 0 : n < 0;
    return good ? "amélioration" : "dégradation";
  }

  function trendClass(delta, inverse) {
    const n = int(delta);
    if (n === 0) return "is-neutral";
    const good = inverse ? n > 0 : n < 0;
    return good ? "is-good" : "is-bad";
  }

  function fillSelect(el, list, valueKey, labelFn, placeholder) {
    if (!el) return;
    const previous = el.value;
    el.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder || "Sélectionner…";
    el.appendChild(opt0);
    (Array.isArray(list) ? list : []).forEach(item => {
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
      labelNonLie: "Non liés",
    });
  }

  async function loadOptions(force) {
    if (_optionsLoaded && !force) return _options;
    if (!_portal || !_portal.contactId) return _options;
    setStatus("Chargement des données RH…");
    const data = await _portal.apiJson(apiUrl(`/skills/simulations/options/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin(),
    }));
    _options = {
      postes: Array.isArray(data?.postes) ? data.postes : [],
      effectifs: Array.isArray(data?.effectifs) ? data.effectifs : [],
      competences: Array.isArray(data?.competences) ? data.competences : [],
      requirements: Array.isArray(data?.requirements) ? data.requirements : [],
      recommendations: data?.recommendations || {},
      scope: data?.scope || null,
    };
    _optionsLoaded = true;
    setStatus("");
    if (!_selectedPosteId && _options.postes.length) _selectedPosteId = _options.postes[0].id_poste || "";
    renderAll();
    return _options;
  }

  function consumeContext() {
    const ctx = readJson(STORE_CONTEXT, null);
    if (!ctx || typeof ctx !== "object") return null;
    try { localStorage.removeItem(STORE_CONTEXT); } catch (_) {}
    return ctx;
  }

  function applyContext(ctx) {
    if (!ctx) return;
    _context = ctx;
    const posteId = ctx.poste_id || ctx.id_poste || ctx.id_poste_cible || "";
    if (posteId) _selectedPosteId = posteId;
    renderAll();
    setStatus("");
  }

  function recommendationsForPoste(posteId) {
    return ((_options.recommendations || {}).candidats_par_poste || {})[posteId] || [];
  }

  function requirementsForPoste(posteId) {
    const seen = new Set();
    return (_options.requirements || []).filter(r => String(r.id_poste || "") === String(posteId || "")).filter(r => {
      const k = String(r.id_comp || "");
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function renderPostePicker() {
    const title = byId("simFocusPosteTitle");
    if (title) title.textContent = _context ? "Poste de départ - Issu de l’analyse" : "Poste de départ";

    const sel = byId("simFocusPosteSelect");
    fillSelect(sel, _options.postes || [], "id_poste", posteLabel, "Choisir un poste…");
    if (sel && _selectedPosteId && Array.from(sel.options).some(o => o.value === _selectedPosteId)) sel.value = _selectedPosteId;

    const p = posteById(_selectedPosteId);
    const meta = byId("simFocusPosteMeta");
    if (meta) {
      meta.innerHTML = p ? `
        <div class="sim-lego-focus-title">${esc(posteLabel(p))}</div>
        <div class="sim-workshop-meta-row">
          <span>${esc(p.nom_service || "Tous les services")}</span>
          <span>Cible titulaires : ${esc(p.nb_titulaires_cible ?? "—")}</span>
          <span>${esc(p.cotation_label || "Cotation à compléter")}</span>
        </div>
      ` : `<div class="sim-empty-state">Choisissez le poste à travailler.</div>`;
    }
  }

  function renderRecommendations() {
    const root = byId("simRecommendations");
    if (!root) return;
    const rows = recommendationsForPoste(_selectedPosteId).slice(0, 6);
    if (!rows.length) {
      root.innerHTML = `<div class="sim-empty-state">Aucun profil proche identifié pour ce poste. Vous pouvez tout de même tester un renfort ou une mobilité manuelle.</div>`;
      return;
    }
    root.innerHTML = rows.map((r, idx) => `
      <div class="sim-lego-person-card ${idx === 0 ? "is-best" : ""}">
        <div class="sim-lego-person-main">
          <div class="sim-lego-person-title">${esc(r.nom_complet || "Collaborateur")}</div>
          <div class="card-sub" style="margin-top:2px;">${esc(r.poste_actuel || "Poste actuel non renseigné")} · ${esc(r.nom_service || "")}</div>
          <div class="sim-lego-person-gaps">
            ${(r.competences_a_renforcer || []).slice(0, 3).map(c => `<span>${esc(c.code || c.intitule || "Compétence")}</span>`).join("")}
          </div>
        </div>
        <div class="sim-lego-person-score">
          <span class="sb-badge ${idx === 0 ? "sb-badge--success" : ""}">${esc(r.score_pct || 0)}%</span>
          <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-sim-add-move="${esc(r.id_effectif)}">Tester mobilité</button>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-prepare-training="${esc(r.id_effectif)}">Projeter niveau</button>
        </div>
      </div>
    `).join("");

    root.querySelectorAll("[data-sim-add-move]").forEach(btn => btn.addEventListener("click", () => {
      const eid = btn.getAttribute("data-sim-add-move") || "";
      const eff = effectifById(eid);
      addBrick({
        type: "mobilite_effectif",
        id_effectif: eid,
        id_poste: _selectedPosteId,
        id_poste_cible: _selectedPosteId,
        temporalite: "immediate",
        libelle: `Déplacer ${eff?.nom_complet || "un collaborateur"} vers ${posteLabel(posteById(_selectedPosteId))}`,
      });
    }));

    root.querySelectorAll("[data-sim-prepare-training]").forEach(btn => btn.addEventListener("click", () => {
      const eid = btn.getAttribute("data-sim-prepare-training") || "";
      const rec = recommendationsForPoste(_selectedPosteId).find(x => String(x.id_effectif || "") === eid) || {};
      const gap = (rec.competences_a_renforcer || [])[0] || requirementsForPoste(_selectedPosteId)[0];
      if (!gap) return setStatus("Aucune compétence à renforcer identifiée pour cette personne.", "error");
      addBrick({
        type: "montee_competence",
        id_effectif: eid,
        id_poste: _selectedPosteId,
        id_comp: gap.id_comp,
        niveau_simule: gap.niveau_requis || "C",
        temporalite: "development",
        libelle: `Projeter ${effectifById(eid)?.nom_complet || "un collaborateur"} au niveau attendu sur ${gap.code || gap.intitule || "une compétence"}`,
      });
    }));
  }

  function renderPalette() {
    const root = byId("simBrickPalette");
    if (!root) return;
    const main = Object.entries(BRICKS).filter(([, b]) => b.group === "immediate");
    const projected = Object.entries(BRICKS).filter(([, b]) => b.group === "projected");
    function buttonHtml(key, b) {
      return `
        <button type="button" class="sim-lego-brick ${_selectedBrick === key ? "is-active" : ""} ${b.group === "projected" ? "is-secondary" : ""}" data-sim-brick="${esc(key)}">
          <span class="sim-lego-brick-icon">${esc(b.icon || "•")}</span>
          <span><strong>${esc(b.title)}</strong><small>${esc(b.short)}</small></span>
        </button>`;
    }
    root.innerHTML = `
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Organisation immédiate</div>
        <div class="sim-lego-brick-grid">${main.map(([key, b]) => buttonHtml(key, b)).join("")}</div>
      </div>
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Projection après montée en compétence</div>
        <div class="sim-lego-brick-grid">${projected.map(([key, b]) => buttonHtml(key, b)).join("")}</div>
      </div>
    `;
    root.querySelectorAll("[data-sim-brick]").forEach(btn => btn.addEventListener("click", () => {
      _selectedBrick = btn.getAttribute("data-sim-brick") || "mobilite_effectif";
      renderBuilderFields();
      renderPalette();
    }));
  }

  function renderBuilderFields() {
    const root = byId("simBrickEditor");
    if (!root) return;
    const p = posteById(_selectedPosteId);
    const posteOptions = _options.postes || [];
    const effectifs = _options.effectifs || [];
    const reqs = requirementsForPoste(_selectedPosteId);
    const brick = BRICKS[_selectedBrick] || BRICKS.mobilite_effectif;

    const intro = `<div class="sim-brick-editor-title"><span>${esc(brick.icon || "•")}</span><strong>${esc(brick.title)}</strong></div>`;

    if (_selectedBrick === "renfort_poste") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid"><div class="info-item"><div class="label">Poste à renforcer</div><select id="simBrickPoste" class="sb-select"></select></div></div>
        <div class="card-sub sim2-muted-top">Le moteur ajoute un profil virtuel couvrant les compétences attendues du poste. Le résultat sert à voir si un renfort règle le problème ou déplace seulement le risque.</div>
      `;
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un poste…");
      if (byId("simBrickPoste")) byId("simBrickPoste").value = _selectedPosteId || "";
      return;
    }

    if (_selectedBrick === "depart_effectif") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Personne retirée du scénario</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Nature</div><select id="simBrickDepartType" class="sb-select"><option value="depart_effectif">Départ / sortie</option><option value="absence_effectif">Absence longue</option></select></div>
        </div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
      return;
    }

    if (_selectedBrick === "transfert_charge") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Poste source</div><select id="simBrickPosteSource" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Poste cible</div><select id="simBrickPoste" class="sb-select"></select></div>
          <div class="info-item sb-span-2"><div class="label">Charge / compétence transférée</div><select id="simBrickCompetence" class="sb-select"></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique allège le poste source et ajoute cette exigence au poste cible.</div>
      `;
      fillSelect(byId("simBrickPosteSource"), posteOptions, "id_poste", posteLabel, "Choisir le poste source…");
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir le poste cible…");
      if (byId("simBrickPosteSource")) byId("simBrickPosteSource").value = _selectedPosteId || "";
      const sourceSel = byId("simBrickPosteSource");
      const fillSourceReqs = () => {
        const src = sourceSel?.value || _selectedPosteId || "";
        fillSelect(byId("simBrickCompetence"), requirementsForPoste(src), "id_comp", compLabel, "Choisir l’activité / compétence…");
      };
      sourceSel?.addEventListener("change", fillSourceReqs);
      fillSourceReqs();
      return;
    }

    if (_selectedBrick === "montee_competence") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Personne concernée</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Compétence</div><select id="simBrickCompetence" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Niveau visé</div><select id="simBrickNiveau" class="sb-select"><option value="B">Intermédiaire</option><option value="C" selected>Avancé</option><option value="D">Expert</option></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique projette l’état si le niveau cible est atteint. Le besoin réel se traite ensuite dans Besoins & formations / Studio / Learn.</div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
      fillSelect(byId("simBrickCompetence"), reqs.length ? reqs : (_options.competences || []), "id_comp", compLabel, "Choisir une compétence…");
      return;
    }

    root.innerHTML = `
      ${intro}
      <div class="sim-form-grid">
        <div class="info-item"><div class="label">Personne déplacée</div><select id="simBrickEffectif" class="sb-select"></select></div>
        <div class="info-item"><div class="label">Poste cible</div><select id="simBrickPoste" class="sb-select"></select></div>
      </div>
      <div class="card-sub sim2-muted-top">Le poste d’origine est automatiquement surveillé pour détecter l’effet domino.</div>
    `;
    fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
    fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un poste…");
    if (byId("simBrickPoste")) byId("simBrickPoste").value = (p?.id_poste || _selectedPosteId || "");
  }

  function addBrick(payload) {
    const item = { id: `brick_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...payload };
    _scenario.push(item);
    renderScenario();
    renderScenarioPreview();
    setStatus("Brique ajoutée au scénario.");
  }

  function addBrickFromEditor() {
    const posteId = byId("simBrickPoste")?.value || _selectedPosteId || "";
    const sourcePosteId = byId("simBrickPosteSource")?.value || _selectedPosteId || "";
    const effId = byId("simBrickEffectif")?.value || "";
    const compId = byId("simBrickCompetence")?.value || "";
    const niveau = byId("simBrickNiveau")?.value || "C";

    if (_selectedBrick === "renfort_poste") {
      if (!posteId) return setStatus("Choisissez un poste à renforcer.", "error");
      return addBrick({ type: "recrutement_virtuel", id_poste: posteId, id_poste_cible: posteId, temporalite: "immediate", libelle: `Ajouter un renfort sur ${posteLabel(posteById(posteId))}` });
    }

    if (_selectedBrick === "depart_effectif") {
      if (!effId) return setStatus("Choisissez la personne à retirer du scénario.", "error");
      const t = byId("simBrickDepartType")?.value || "depart_effectif";
      return addBrick({ type: t, id_effectif: effId, temporalite: "immediate", libelle: `${t === "absence_effectif" ? "Absence" : "Départ"} de ${effectifById(effId)?.nom_complet || "collaborateur"}` });
    }

    if (_selectedBrick === "transfert_charge") {
      if (!sourcePosteId || !posteId || !compId) return setStatus("Choisissez le poste source, le poste cible et la charge transférée.", "error");
      if (sourcePosteId === posteId) return setStatus("Le poste source et le poste cible doivent être différents.", "error");
      return addBrick({ type: "transfert_charge", id_poste: sourcePosteId, id_poste_cible: posteId, id_comp: compId, temporalite: "immediate", libelle: `Transférer ${compLabel(compById(compId))} de ${posteLabel(posteById(sourcePosteId))} vers ${posteLabel(posteById(posteId))}` });
    }

    if (_selectedBrick === "montee_competence") {
      if (!effId || !compId) return setStatus("Choisissez une personne et une compétence.", "error");
      return addBrick({ type: "montee_competence", id_effectif: effId, id_poste: _selectedPosteId, id_comp: compId, niveau_simule: niveau, temporalite: "development", libelle: `Projeter ${effectifById(effId)?.nom_complet || "collaborateur"} au niveau ${niveau} sur ${compLabel(compById(compId))}` });
    }

    if (!effId || !posteId) return setStatus("Choisissez une personne et un poste cible.", "error");
    return addBrick({ type: "mobilite_effectif", id_effectif: effId, id_poste: posteId, id_poste_cible: posteId, temporalite: "immediate", libelle: `Déplacer ${effectifById(effId)?.nom_complet || "collaborateur"} vers ${posteLabel(posteById(posteId))}` });
  }

  function renderScenario() {
    const root = byId("simScenarioBricks");
    if (!root) return;
    if (!_scenario.length) {
      root.innerHTML = `<div class="sim-empty-state">Votre scénario est vide. Ajoutez une brique à gauche.</div>`;
      return;
    }
    root.innerHTML = _scenario.map((b, idx) => {
      const key = b.type === "recrutement_virtuel" ? "renfort_poste" : (b.type === "absence_effectif" || b.type === "depart_effectif" ? "depart_effectif" : b.type);
      const meta = BRICKS[key] || BRICKS.mobilite_effectif;
      return `
        <div class="sim-lego-scenario-brick ${b.temporalite === "development" ? "is-dev" : ""}">
          <div class="sim-lego-scenario-icon">${esc(meta.icon || "•")}</div>
          <div class="sim-lego-scenario-copy">
            <div class="sim-lego-brick-index">Brique ${idx + 1} · ${esc(meta.title || "Action")}</div>
            <div class="sim-lego-brick-label">${esc(b.libelle || "Action RH")}</div>
          </div>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-remove-brick="${idx}">Retirer</button>
        </div>`;
    }).join("");
    root.querySelectorAll("[data-sim-remove-brick]").forEach(btn => btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-sim-remove-brick") || -1);
      if (idx >= 0) _scenario.splice(idx, 1);
      renderScenario();
      renderScenarioPreview();
    }));
  }

  function renderScenarioPreview() {
    const root = byId("simScenarioPreview");
    if (!root) return;
    const immediate = _scenario.filter(x => x.temporalite !== "development").length;
    const dev = _scenario.filter(x => x.temporalite === "development").length;
    if (!_scenario.length) {
      root.innerHTML = `
        <div class="sim-workshop-scenario-empty">
          <strong>${esc(posteLabel(posteById(_selectedPosteId)))}</strong>
          <span>Ajoutez au moins une brique pour analyser l’impact.</span>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="sim-lego-preview-title">${esc(posteLabel(posteById(_selectedPosteId)))}</div>
      <div class="sim-lego-preview-row"><strong>${esc(String(_scenario.length))}</strong><span>brique(s)</span></div>
      <div class="sim-lego-preview-row"><strong>${esc(String(immediate))}</strong><span>effet immédiat</span></div>
      <div class="sim-lego-preview-row"><strong>${esc(String(dev))}</strong><span>effet projeté</span></div>
    `;
  }

  function buildPayload() {
    return {
      titre: `Scénario organisation · ${posteLabel(posteById(_selectedPosteId))}`,
      objectif: "Tester une organisation RH composée de plusieurs briques.",
      hypotheses: _scenario.map(b => ({
        type: b.type,
        id_effectif: b.id_effectif || null,
        id_poste: b.id_poste || b.id_poste_cible || null,
        id_poste_cible: b.id_poste_cible || b.id_poste || null,
        id_comp: b.id_comp || null,
        niveau_simule: b.niveau_simule || null,
        libelle: b.libelle || null,
        temporalite: b.temporalite || null,
      })),
    };
  }

  async function evaluateScenario() {
    await loadOptions(false);
    if (!_scenario.length) return setStatus("Ajoutez au moins une brique au scénario.", "error");
    setStatus("Calcul des impacts du scénario…");
    const payload = buildPayload();
    const result = await _portal.apiJson(apiUrl(`/skills/simulations/evaluer/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin(),
    }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    _lastResult = result;
    setStatus("");
    renderResult(result);
    switchTab("result");
  }

  function resultKpi(title, before, after, inverse) {
    const b = int(before);
    const a = int(after);
    const delta = a - b;
    return `
      <div class="sim-result-kpi ${trendClass(delta, inverse)}">
        <div class="label">${esc(title)}</div>
        <div class="value">${esc(b)} → ${esc(a)}</div>
        <div class="sim-result-kpi-delta">${deltaBadge(delta, inverse)}</div>
      </div>`;
  }

  function impactRows(postes, limit) {
    const list = Array.isArray(postes) ? postes.slice(0, limit || 8) : [];
    if (!list.length) return `<div class="sim-empty-state">Aucun poste ne varie de façon significative.</div>`;
    return list.map(p => `
      <div class="sim-result-impact-row ${int(p.delta) < 0 ? "is-good" : int(p.delta) > 0 ? "is-bad" : "is-neutral"}">
        <div>
          <div class="sim-impact-title">${esc(p.codif_poste ? p.codif_poste + " · " : "")}${esc(p.intitule_poste || "Poste")}</div>
          <div class="card-sub" style="margin:3px 0 0 0;">${esc(p.nom_service || "")}</div>
        </div>
        <div class="sim-impact-score">${esc(p.fragilite_avant)} → ${esc(p.fragilite_apres)}</div>
        <div>${deltaBadge(p.delta || 0)}</div>
      </div>`).join("");
  }

  function serviceRows(services, limit) {
    const list = Array.isArray(services) ? services.slice(0, limit || 8) : [];
    if (!list.length) return `<div class="sim-empty-state">Aucun service ne varie de façon significative.</div>`;
    return list.map(s => `
      <div class="sim-result-impact-row ${int(s.delta) < 0 ? "is-good" : int(s.delta) > 0 ? "is-bad" : "is-neutral"}">
        <div class="sim-impact-title">${esc(s.nom_service || "Service")}</div>
        <div class="sim-impact-score">${esc(s.fragilite_avant)} → ${esc(s.fragilite_apres)}</div>
        <div>${deltaBadge(s.delta || 0)}</div>
      </div>`).join("");
  }

  function renderDevelopmentNeeds(result) {
    const needs = result?.developpement?.besoins_formation || [];
    if (!needs.length) return `<div class="sim-empty-state">Aucun besoin complémentaire de montée en compétence détecté sur les mobilités du scénario.</div>`;
    return needs.slice(0, 8).map(n => `
      <div class="sim-lego-dev-row">
        <div>
          <div class="sim-impact-title">${esc(n.nom_complet || "Collaborateur")}</div>
          <div class="card-sub" style="margin:3px 0 0 0;">${esc(n.code ? n.code + " · " : "")}${esc(n.intitule || "Compétence")} · niveau attendu ${esc(n.niveau_requis || "—")}</div>
        </div>
        <span class="sb-badge ${Number(n.couverture_pct || 0) < 60 ? "sb-badge--warning" : ""}">${esc(n.lecture || "À renforcer")}</span>
      </div>
    `).join("");
  }

  function resultSentence(result, immediat, projete) {
    const cur = result?.actuel || {};
    const im = immediat?.summary || {};
    const pr = projete?.summary || {};
    const imDelta = int(im.fragilite_moyenne) - int(cur.fragilite_moyenne);
    const prDelta = int(pr.fragilite_moyenne) - int(cur.fragilite_moyenne);
    const degraded = int(projete?.impact?.postes_degrades || result?.impact?.postes_degrades || 0);
    const secured = int(projete?.impact?.postes_securises || result?.impact?.postes_securises || 0);
    if (imDelta < 0 && degraded > 0) return `Le scénario améliore la fragilité moyenne (${deltaText(imDelta)}), mais dégrade ${degraded} poste${degraded > 1 ? "s" : ""}.`;
    if (imDelta < 0 || secured > 0) return `Le scénario sécurise le périmètre : ${secured} poste${secured > 1 ? "s" : ""} amélioré${secured > 1 ? "s" : ""}, fragilité ${deltaText(imDelta)} en immédiat.`;
    if (imDelta > 0 || degraded > 0) return `Le scénario dégrade le périmètre : ${degraded} poste${degraded > 1 ? "s" : ""} à surveiller, fragilité ${deltaText(imDelta)} en immédiat.`;
    if (prDelta !== imDelta) return `L’impact immédiat est limité ; l’effet principal apparaît après montée en compétence (${deltaText(prDelta)} projeté).`;
    return "Le scénario produit un impact limité. Il peut servir de base de comparaison avec une autre option.";
  }

  function resultPill(label, value, cls) {
    return `<div class="sim-result-pill ${cls || ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function renderResult(result) {
    const root = byId("simResultContainer");
    if (!root) return;
    if (!result) {
      root.innerHTML = `<div class="card"><div class="card-title">Résultat du scénario</div><div class="card-sub sim2-muted-top">Construisez un scénario puis lancez le calcul.</div></div>`;
      return;
    }

    const current = result.actuel || {};
    const immediat = result.resultats?.immediat || { summary: result.simule || {}, impact: result.impact || {} };
    const projete = result.resultats?.projete || { summary: result.simule || {}, impact: result.impact || {} };
    const imSummary = immediat.summary || {};
    const prSummary = projete.summary || {};
    const imImpact = immediat.impact || {};
    const prImpact = projete.impact || result.impact || {};
    const needs = result?.developpement?.besoins_formation || [];
    const imDelta = int(imSummary.fragilite_moyenne) - int(current.fragilite_moyenne);
    const prDelta = int(prSummary.fragilite_moyenne) - int(current.fragilite_moyenne);
    const services = prImpact.services_impactes || imImpact.services_impactes || [];

    root.innerHTML = `
      <div class="card sim-result-hero ${trendClass(imDelta)}">
        <div class="sim-result-hero-top">
          <div>
            <div class="sim-result-label">Résultat du scénario</div>
            <div class="sim-result-title">${esc(resultSentence(result, immediat, projete))}</div>
            <div class="sim-result-sub">${esc(result.conseil?.option_recommandee || result.conseil?.lecture || "À comparer avec une autre option avant arbitrage.")}</div>
          </div>
          <div class="sb-actions sb-actions--end">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimBackBuild">Modifier</button>
            <button type="button" class="sb-btn sb-btn--accent" id="btnSimAddCompare">Conserver</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimShowCompare">Comparer</button>
          </div>
        </div>
        <div class="sim-result-pill-row">
          ${resultPill("Impact immédiat", deltaText(imDelta), trendClass(imDelta))}
          ${resultPill("Impact projeté", deltaText(prDelta), trendClass(prDelta))}
          ${resultPill("Postes améliorés", int(prImpact.postes_securises || 0), "is-good")}
          ${resultPill("Postes dégradés", int(prImpact.postes_degrades || 0), int(prImpact.postes_degrades || 0) > 0 ? "is-bad" : "")}
          ${resultPill("Besoins générés", needs.length, needs.length ? "is-watch" : "")}
        </div>
      </div>

      <div class="sim-result-main-grid">
        <div class="card sim-result-readable-card">
          <div class="card-title">1. Impact immédiat</div>
          <div class="card-sub sim2-muted-top">Ce qui change dès que les mouvements, retraits ou renforts sont appliqués.</div>
          <div class="sim-lego-kpi-grid sim-result-kpi-grid">
            ${resultKpi("Fragilité moyenne", current.fragilite_moyenne, imSummary.fragilite_moyenne)}
            ${resultKpi("Postes en danger", current.postes_rouges, imSummary.postes_rouges)}
            ${resultKpi("Transmission", current.capacite_transmission, imSummary.capacite_transmission, true)}
          </div>
        </div>

        <div class="card sim-result-readable-card">
          <div class="card-title">2. Impact projeté</div>
          <div class="card-sub sim2-muted-top">Lecture après les briques de compétence acquise ou les besoins générés par la mobilité.</div>
          <div class="sim-lego-kpi-grid sim-result-kpi-grid">
            ${resultKpi("Fragilité moyenne", current.fragilite_moyenne, prSummary.fragilite_moyenne)}
            ${resultKpi("Postes en danger", current.postes_rouges, prSummary.postes_rouges)}
            ${resultKpi("Transmission", current.capacite_transmission, prSummary.capacite_transmission, true)}
          </div>
        </div>
      </div>

      <div class="sim-result-main-grid" style="margin-top:12px;">
        <div class="card sim-result-readable-card">
          <div class="card-title">3. Postes à regarder</div>
          <div class="card-sub sim2-muted-top">Les postes dont la fragilité bouge le plus.</div>
          <div class="sim-result-impact-list">${impactRows(prImpact.postes_impactes || imImpact.postes_impactes || [], 8)}</div>
        </div>

        <div class="card sim-result-readable-card">
          <div class="card-title">4. Services concernés</div>
          <div class="card-sub sim2-muted-top">Lecture moyenne par service pour repérer l’effet domino.</div>
          <div class="sim-result-impact-list">${serviceRows(services, 8)}</div>
        </div>
      </div>

      <div class="card sim-result-readable-card" style="margin-top:12px;">
        <div class="card-title">5. Besoins générés par le scénario</div>
        <div class="card-sub sim2-muted-top">Ces besoins ne sont pas envoyés automatiquement. Ils servent à préparer l’étape Besoins & formations / Studio.</div>
        <div class="sim-lego-dev-list">${renderDevelopmentNeeds(result)}</div>
      </div>

      <details class="sim2-details sim-result-technical">
        <summary>Détail technique</summary>
        <div class="sim2-detail-body">
          <div class="sim-result-main-grid">
            <div>
              <div class="sim-result-detail-title">Postes impactés en immédiat</div>
              ${impactRows(imImpact.postes_impactes || [], 20)}
            </div>
            <div>
              <div class="sim-result-detail-title">Postes impactés en projeté</div>
              ${impactRows(prImpact.postes_impactes || [], 20)}
            </div>
          </div>
          <details class="sim2-details" style="margin-top:12px;">
            <summary>Cotation et données complémentaires</summary>
            <div class="sim2-detail-body">
              <div class="card-sub" style="margin:0 0 8px 0;">${esc(result.conseil?.impact_cotation || "Cotation à vérifier si le scénario modifie les responsabilités ou la classification.")}</div>
              ${(result.cotation?.postes_non_cotes || []).length ? `<div class="sim-empty-state">Postes sans cotation : ${(result.cotation.postes_non_cotes || []).map(p => esc(p.codif_poste ? p.codif_poste + " · " + p.intitule_poste : p.intitule_poste)).join(", ")}</div>` : `<div class="sim-empty-state">Aucune alerte de cotation remontée.</div>`}
            </div>
          </details>
        </div>
      </details>
    `;

    byId("btnSimBackBuild")?.addEventListener("click", () => switchTab("build"));
    byId("btnSimAddCompare")?.addEventListener("click", addLastResultToCompare);
    byId("btnSimShowCompare")?.addEventListener("click", () => switchTab("compare"));
  }

  function readCompare() {
    const list = readJson(STORE_COMPARE, []);
    return Array.isArray(list) ? list : [];
  }

  function writeCompare(list) {
    writeJson(STORE_COMPARE, Array.isArray(list) ? list : []);
    renderCompare();
    updateCompareCount();
  }

  function updateCompareCount() {
    const el = byId("simCompareCount");
    if (el) el.textContent = String(readCompare().length);
  }

  function addLastResultToCompare() {
    if (!_lastResult) return;
    const list = readCompare();
    list.unshift({ id: `sim_${Date.now()}`, saved_at: new Date().toISOString(), result: _lastResult });
    writeCompare(list.slice(0, 8));
    switchTab("compare");
  }

  function renderCompare() {
    const root = byId("simCompareContainer");
    if (!root) return;
    const list = readCompare();
    updateCompareCount();
    if (!list.length) {
      root.innerHTML = `<div class="card"><div class="sim-empty-state">Aucun scénario conservé.</div><div class="sb-actions" style="margin-top:12px;"><button type="button" class="sb-btn sb-btn--soft" id="btnSimCompareBackBuild">Retour au scénario</button></div></div>`;
      byId("btnSimCompareBackBuild")?.addEventListener("click", () => switchTab("build"));
      return;
    }
    root.innerHTML = `
      <div class="card sim-compare-readable">
        ${list.map((x, idx) => {
          const r = x.result || {};
          const imDelta = r.resultats?.immediat?.ecart?.fragilite_moyenne || 0;
          const prDelta = r.resultats?.projete?.ecart?.fragilite_moyenne || r.ecart?.fragilite_moyenne || 0;
          const impact = r.resultats?.projete?.impact || r.impact || {};
          return `
            <div class="sim-compare-card">
              <div>
                <div class="sim-impact-title">${esc(r.titre || "Scénario")}</div>
                <div class="card-sub" style="margin-top:3px;">${esc(r.scope?.nom_service || "Tous les services")}</div>
              </div>
              <div class="sim-compare-metrics">
                <span>Immédiat ${deltaBadge(imDelta)}</span>
                <span>Projeté ${deltaBadge(prDelta)}</span>
                <span>${esc(impact.postes_degrades || 0)} poste(s) dégradé(s)</span>
              </div>
              <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-remove-compare="${idx}">Retirer</button>
            </div>`;
        }).join("")}
      </div>`;
    root.querySelectorAll("[data-remove-compare]").forEach(btn => btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-remove-compare") || -1);
      const next = readCompare();
      if (idx >= 0) next.splice(idx, 1);
      writeCompare(next);
    }));
  }

  function switchTab(tab) {
    const wanted = tab || "build";
    document.querySelectorAll(".sim-tab-btn").forEach(btn => btn.classList.toggle("is-active", btn.getAttribute("data-sim-tab") === wanted));
    document.querySelectorAll(".sim-panel").forEach(panel => {
      panel.style.display = panel.getAttribute("data-sim-panel") === wanted ? "block" : "none";
    });
    if (wanted === "compare") renderCompare();
  }

  function renderAll() {
    renderPostePicker();
    renderRecommendations();
    renderPalette();
    renderBuilderFields();
    renderScenario();
    renderScenarioPreview();
    renderCompare();
  }

  function resetScenario() {
    _scenario = [];
    _lastResult = null;
    renderAll();
    renderResult(null);
    switchTab("build");
    setStatus("");
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;
    document.querySelectorAll(".sim-tab-btn").forEach(btn => btn.addEventListener("click", () => switchTab(btn.getAttribute("data-sim-tab") || "build")));
    byId("simFocusPosteSelect")?.addEventListener("change", e => { _selectedPosteId = e.target.value || ""; renderAll(); });
    byId("btnSimAddBrick")?.addEventListener("click", addBrickFromEditor);
    byId("btnSimEvaluate")?.addEventListener("click", () => evaluateScenario().catch(e => setStatus(errMsg(e), "error")));
    byId("btnSimResetScenario")?.addEventListener("click", resetScenario);
    byId("btnSimReloadOptions")?.addEventListener("click", () => { _optionsLoaded = false; loadOptions(true).catch(e => setStatus(errMsg(e), "error")); });
    byId("btnSimClearCompare")?.addEventListener("click", () => writeCompare([]));
    byId("simCriticiteRange")?.addEventListener("input", e => setCriticiteMin(e.target.value));
    byId("simCriticiteRange")?.addEventListener("change", () => { _optionsLoaded = false; loadOptions(true).catch(e => setStatus(errMsg(e), "error")); });
    byId("simServiceSelect")?.addEventListener("change", () => { _optionsLoaded = false; loadOptions(true).catch(e => setStatus(errMsg(e), "error")); });
  }

  async function onShow(portal) {
    _portal = portal;
    bindOnce();
    setCriticiteMin(localStorage.getItem(STORE_CRIT) || 70);
    renderAll();
    updateCompareCount();
    try {
      await populateServices();
      const ctx = consumeContext();
      await loadOptions(false);
      if (ctx) applyContext(ctx);
    } catch (e) {
      setStatus(errMsg(e), "error");
    }
  }

  window.SkillsSimulationsRH = { onShow };
})();
