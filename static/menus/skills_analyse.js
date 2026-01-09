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
  const STORE_MATCH_VIEW = "sb_analyse_match_view"; // "titulaire" | "candidats"


  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

    function errMsg(e) {
    if (!e) return "inconnue";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    if (e.detail) {
      if (typeof e.detail === "string") return e.detail;
      try { return JSON.stringify(e.detail); } catch { }
    }
    try { return JSON.stringify(e); } catch { }
    return String(e);
  }

  function normalizeColor(raw) {
    if (raw === null || raw === undefined) return "";
    const s = raw.toString().trim();
    if (!s) return "";
    if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl")) return s;

    // int ARGB signé WinForms (ex: -256)
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

    // ==============================
  // Matching/Risques - Badges "écarts"
  // - Rouge = non acquises (abs)
  // - Orange = à renforcer (sous)
  // ==============================
  function parseAbsSous(raw) {
    // Supporte:
    // - objet { abs: x, sous: y }
    // - string "x abs / y sous"
    if (raw && typeof raw === "object") {
      return { abs: Number(raw.abs || 0), sous: Number(raw.sous || 0) };
    }

    const s = (raw ?? "").toString();
    const m = /(\d+)\s*abs.*?(\d+)\s*sous/i.exec(s);
    return { abs: m ? Number(m[1]) : 0, sous: m ? Number(m[2]) : 0 };
  }

  function gapBadges(abs, sous) {
    const a = Number(abs || 0);
    const b = Number(sous || 0);

    function badge(n, bg, title) {
      return `
        <span title="${escapeHtml(title)}"
              style="display:inline-flex; align-items:center; justify-content:center;
                     width:22px; height:22px; border-radius:6px;
                     font-size:12px; font-weight:800; color:#fff;
                     background:${bg}; border:1px solid rgba(0,0,0,.12);">
          ${n}
        </span>
      `;
    }

    return `
      <span style="display:inline-flex; gap:6px; align-items:center; justify-content:center;">
        ${badge(a, "#ef4444", "Non acquises")}
        ${badge(b, "#f59e0b", "À renforcer")}
      </span>
    `;
  }

  function gapsLegendHtml() {
    return `
      <div class="card-sub"
           style="margin-top:10px; color:#6b7280; display:flex; gap:14px; align-items:center; flex-wrap:wrap;">
        <span style="display:inline-flex; gap:6px; align-items:center;">
          <span style="width:12px; height:12px; border-radius:3px; background:#ef4444; display:inline-block;"></span>
          Non acquises
        </span>
        <span style="display:inline-flex; gap:6px; align-items:center;">
          <span style="width:12px; height:12px; border-radius:3px; background:#f59e0b; display:inline-block;"></span>
          À renforcer
        </span>
      </div>
    `;
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

  function getMatchView() {
    const v = (localStorage.getItem(STORE_MATCH_VIEW) || "").trim().toLowerCase();
    return (v === "titulaire" || v === "candidats") ? v : "candidats";
  }

  function setMatchView(view) {
    const v = (view || "").trim().toLowerCase();
    if (v === "titulaire" || v === "candidats") localStorage.setItem(STORE_MATCH_VIEW, v);
    else localStorage.removeItem(STORE_MATCH_VIEW);
    setActiveMatchKpi(getMatchView());
  }

  function setActiveMatchKpi(view) {
    const tile = byId("tileMatching");
    if (!tile) return;

    const items = tile.querySelectorAll(".mini-kpi[data-match-view]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-match-view") || "").trim().toLowerCase();
      const isActive = !!view && k === view;

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

  const _posteDetailCache = new Map();
  let _posteDetailReqSeq = 0;

  async function fetchAnalysePosteDetail(portal, id_poste, id_service) {
    const svc = (id_service || "").trim();
    const key = `${id_poste}|${svc}|${CRITICITE_MIN}`;
    if (_posteDetailCache.has(key)) return _posteDetailCache.get(key);

    const qs = buildQueryString({
      id_poste: id_poste,
      id_service: svc || null,
      criticite_min: CRITICITE_MIN
    });

    const url = `${portal.apiBase}/skills/analyse/risques/poste/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _posteDetailCache.set(key, data);
    return data;
  }

    // ==============================
  // MATCHING (MVP)
  // - basé sur /risques/poste (compétences requises + porteurs)
  // - liste postes = "postes fragiles" (source risques)
  // ==============================
  const _matchPostesCache = new Map(); // key: id_service -> items[]
  let _matchReqSeq = 0;
  let _matchSelectedPoste = "";

  function nivReqToNum(raw) {
    const s = (raw ?? "").toString().trim().toUpperCase();
    if (s === "A") return 1;
    if (s === "B") return 2;
    if (s === "C") return 3;
    return 0;
  }

  function nivActToNum(raw) {
    const s = (raw ?? "").toString().trim().toLowerCase();
    if (s === "initial") return 1;
    if (s === "avancé" || s === "avance" || s === "avancee" || s === "avancée") return 2;
    if (s === "expert") return 3;
    return 0;
  }

  function scoreComp(lvlAct, lvlReq) {
    if (!lvlAct) return 0;                 // absent
    if (lvlAct >= lvlReq) return 1;        // OK
    if (lvlAct === (lvlReq - 1)) return 0.6; // juste en dessous
    return 0.2;                            // trop bas
  }

  async function fetchMatchingPostes(portal, id_service) {
    const svc = (id_service || "").trim();
    const key = svc || "__ALL__";
    if (_matchPostesCache.has(key)) return _matchPostesCache.get(key);

    // On réutilise l’API "postes-fragiles" comme liste de postes prioritaire
    const data = await fetchRisquesDetail(portal, "postes-fragiles", svc, 500);
    const items = Array.isArray(data?.items) ? data.items : [];

    _matchPostesCache.set(key, items);
    return items;
  }

  function renderMatchingShell() {
    return `
      <div style="display:flex; gap:12px; align-items:stretch; min-height:360px;">
        <div class="card" style="padding:12px; margin:0; width:360px; flex:0 0 auto;">
          <div class="card-title" style="margin-bottom:6px;">Postes (priorité: fragiles)</div>
          <div class="card-sub" style="margin:0;">Clique un poste pour obtenir les candidats internes.</div>
          <div id="matchPosteList" style="margin-top:10px; display:flex; flex-direction:column; gap:6px;"></div>
        </div>

        <div class="card" style="padding:12px; margin:0; flex:1;">
          <div class="card-title" style="margin-bottom:6px;">Candidats</div>
          <div class="card-sub" style="margin:0;">Score pondéré (niveau + criticité). Écarts critiques visibles.</div>
          <div id="matchResult" style="margin-top:10px;">
            <div class="card-sub" style="margin:0; color:#6b7280;">Sélectionne un poste.</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderMatchingPosteList(items, selectedId) {
    const host = byId("matchPosteList");
    if (!host) return;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun poste trouvé.</div>`;
      return;
    }

    host.innerHTML = list.map(r => {
      const idp = (r.id_poste || "").toString().trim();
      const poste = `${(r.codif_poste || "").trim()}${r.codif_poste ? " — " : ""}${(r.intitule_poste || "").trim()}`.trim() || "—";
      const svc = (r.nom_service || "").trim() || "—";

      const isActive = selectedId && idp === selectedId;
      const style = isActive
        ? `border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, #fff);`
        : `border-color:#e5e7eb; background:#fff;`;

      return `
        <button type="button"
                class="btn-secondary"
                data-match-id_poste="${escapeHtml(idp)}"
                style="text-align:left; margin:0; ${style}">
          <div style="font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(poste)}
          </div>
          <div style="font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(svc)}
          </div>
        </button>
      `;
    }).join("");
  }

  function computeCandidatesFromPosteDetail(data) {
    const comps = Array.isArray(data?.competences) ? data.competences : [];
    if (!comps.length) return [];

    // Liste des compétences requises + poids
    const compReq = comps.map(c => {
      const code = (c.code || c.id_competence || "").toString().trim(); // on privilégie code
      const lvlReq = nivReqToNum(c.niveau_requis);
      const w = Number(c.poids_criticite || 1);
      const isCrit = w >= CRITICITE_MIN;
      return { code, lvlReq, w, isCrit, raw: c };
    }).filter(x => x.code);

    const totalWeight = compReq.reduce((s, x) => s + (x.w || 0), 0) || 1;

    // candLevels[candId][compCode] = lvlAct
    const cand = new Map();        // id -> identity
    const candLevels = new Map();  // id -> Map(compCode -> lvlAct)

    compReq.forEach(cr => {
      const porteurs = Array.isArray(cr.raw?.porteurs) ? cr.raw.porteurs : [];
      porteurs.forEach(p => {
        const idEff = (p.id_effectif || p.id_effectif_client || p.id_eff || p.id || "").toString().trim();
        if (!idEff) return;

        if (!cand.has(idEff)) {
          const prenom = (p.prenom_effectif || "").trim();
          const nom = (p.nom_effectif || "").trim();
          cand.set(idEff, {
            id_effectif: idEff,
            prenom,
            nom,
            full: `${prenom} ${nom}`.trim() || "—",
            nom_service: (p.nom_service || "").trim() || "—",
            id_poste_actuel: (p.id_poste_actuel || "").toString().trim()
          });
        }

        if (!candLevels.has(idEff)) candLevels.set(idEff, new Map());
        candLevels.get(idEff).set(cr.code, nivActToNum(p.niveau_actuel));
      });
    });

    // Calcul score par candidat
    const out = [];
    cand.forEach((info, idEff) => {
      const levels = candLevels.get(idEff) || new Map();

      let sum = 0;
      let nbMissing = 0;
      let nbUnder = 0;
      let critMissing = 0;
      let critUnder = 0;

      compReq.forEach(cr => {
        const lvlAct = levels.get(cr.code) || 0;

        if (!lvlAct) nbMissing++;
        else if (lvlAct < cr.lvlReq) nbUnder++;

        if (cr.isCrit) {
          if (!lvlAct) critMissing++;
          else if (lvlAct < cr.lvlReq) critUnder++;
        }

        sum += scoreComp(lvlAct, cr.lvlReq) * cr.w;
      });

      const pct = Math.round((sum / totalWeight) * 100);

      out.push({
        ...info,
        score_pct: pct,
        nb_missing: nbMissing,
        nb_under: nbUnder,
        crit_missing: critMissing,
        crit_under: critUnder,
        nb_comp: compReq.length
      });
    });

    // Tri: score desc, puis moins de critiques manquantes, puis moins de critiques sous niveau
    out.sort((a, b) =>
      (b.score_pct - a.score_pct) ||
      (a.crit_missing - b.crit_missing) ||
      (a.crit_under - b.crit_under) ||
      (a.nb_missing - b.nb_missing)
    );

    return out;
  }

  function renderMatchingCandidates(id_poste_selected, posteLabel, candidates, view) {
    const host = byId("matchResult");
    if (!host) return;

    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun candidat détecté (aucun porteur sur les compétences du poste).</div>`;
      return;
    }

    const posteCible = (id_poste_selected || "").toString().trim();
    const v = (view || getMatchView() || "candidats").toString().trim().toLowerCase();

    // --- Titulaires vs Candidats : on s’appuie sur un flag si l’API le donne, sinon sur id_poste_actuel
    function isTitulaire(c) {
      if (!c) return false;

      // cas idéal: backend fournit un flag
      if (c.is_titulaire === true || c.est_titulaire === true || c.titulaire === true || c.is_on_poste === true) return true;
      if (String(c.is_titulaire || "").toLowerCase() === "true") return true;

      // fallback: comparaison poste actuel / poste sélectionné
      const posteActuel = String(c.id_poste_actuel || "").trim();
      return !!posteCible && !!posteActuel && posteActuel === posteCible;
    }

    const titulairesAll = list.filter(isTitulaire);
    const candidatsAll = list.filter(c => !isTitulaire(c));

    const rows = (v === "titulaire") ? titulairesAll : candidatsAll;
    const top = rows.slice(0, 30);

    function badge(txt, accent) {
      const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
      return `<span class="${cls}">${escapeHtml(txt)}</span>`;
    }

    function gapBadges(absCount, underCount) {
      const a = Number(absCount || 0);
      const u = Number(underCount || 0);

      function box(n, bg, title) {
        const isZero = !n;
        const style = isZero
          ? "background:#e5e7eb; color:#6b7280; border:1px solid #d1d5db;"
          : `background:${bg}; color:#ffffff; border:1px solid rgba(0,0,0,.12);`;

        return `
          <span title="${escapeHtml(title)}"
                style="display:inline-flex; align-items:center; justify-content:center;
                      width:22px; height:18px; border-radius:4px;
                      font-size:12px; font-weight:800; line-height:1;
                      ${style}">
            ${n || 0}
          </span>
        `;
      }

      return `
        <span style="display:inline-flex; gap:6px; align-items:center; justify-content:center;">
          ${box(a, "#ef4444", "Manquantes")}
          ${box(u, "#f59e0b", "À renforcer")}
        </span>
      `;
    }

    const MATCH_LEGEND_HTML = `
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center; margin-top:10px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="width:12px; height:12px; border-radius:3px; background:#ef4444; border:1px solid rgba(0,0,0,.12);"></span>
          <span style="font-size:12px; color:#6b7280;">Manquantes</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="width:12px; height:12px; border-radius:3px; background:#f59e0b; border:1px solid rgba(0,0,0,.12);"></span>
          <span style="font-size:12px; color:#6b7280;">À renforcer</span>
        </div>
      </div>
    `;

    const headerTitle = (v === "titulaire") ? "Adéquation au poste (titulaire" + (titulairesAll.length > 1 ? "s" : "") + ")" : "Top candidats (hors titulaires)";
    const emptyText = (v === "titulaire") ? "Aucun titulaire détecté sur ce poste" : "Aucun candidat (hors titulaires)";

    function renderRow(c) {
      const critHtml = gapBadges(c.crit_missing, c.crit_under);
      const missHtml = gapBadges(c.nb_missing, c.nb_under);

      const score = Number(c.score_pct || 0);
      const scoreBadge = score >= 80 ? badge(score + "%", true) : badge(score + "%", false);

      return `
        <tr>
          <td style="font-weight:700;">${escapeHtml(c.full || "—")}</td>
          <td>${escapeHtml(c.nom_service || "—")}</td>
          <td class="col-center">${scoreBadge}</td>
          <td class="col-center">${critHtml}</td>
          <td class="col-center">${missHtml}</td>
        </tr>
      `;
    }

    function renderHeaderRow(title) {
      return `
        <tr>
          <td colspan="5" style="padding:10px 8px; font-weight:800; color:#111827; border-top:1px solid #e5e7eb;">
            ${escapeHtml(title)}
          </td>
        </tr>
      `;
    }

    host.innerHTML = `
      <div class="card-sub" style="margin:0 0 8px 0;">
        Poste : <b>${escapeHtml(posteLabel || "—")}</b>
      </div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Personne</th>
              <th style="width:180px;">Service</th>
              <th class="col-center" style="width:110px;">Score</th>
              <th class="col-center" style="width:140px;">Critiques</th>
              <th class="col-center" style="width:140px;">Écarts</th>
            </tr>
          </thead>
          <tbody>
            ${renderHeaderRow(headerTitle)}
            ${top.length ? top.map(renderRow).join("") : `<tr><td colspan="5" class="col-center" style="color:#6b7280;">${escapeHtml(emptyText)}</td></tr>`}
          </tbody>
        </table>
      </div>

      ${MATCH_LEGEND_HTML}

      <div class="card-sub" style="margin-top:10px; color:#6b7280;">
        Critiques = poids_criticite ≥ ${CRITICITE_MIN}. Score = moyenne pondérée des compétences requises.
      </div>
    `;


  }

  async function showMatchingForPoste(portal, id_poste, id_service, seqGuard) {
    const host = byId("matchResult");
    if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

    const data = await fetchAnalysePosteDetail(portal, id_poste, id_service);
    if (seqGuard && seqGuard !== _matchReqSeq) return;

    const poste = data?.poste || {};
    const posteLabel = `${poste.codif_poste ? poste.codif_poste + " — " : ""}${poste.intitule_poste || "Poste"}`.trim();

    const cands = computeCandidatesFromPosteDetail(data);
    renderMatchingCandidates(id_poste, posteLabel, cands, getMatchView());
  }

    // ==============================
  // Détail COMPETENCE (Risques)
  // ==============================
  const _compDetailCache = new Map();
  let _compDetailReqSeq = 0;

  async function fetchAnalyseCompetenceDetail(portal, codeOrId, id_service) {
    const svc = (id_service || "").trim();
    const key = `${codeOrId}|${svc}|${CRITICITE_MIN}`;
    if (_compDetailCache.has(key)) return _compDetailCache.get(key);

    const raw = (codeOrId || "").trim();

    // Heuristique simple: un code ressemble à CO00020 / ABC123 etc.
    const isCode = /^[A-Z]{1,6}\d{2,}$/i.test(raw);

    const qs = buildQueryString({
      code: isCode ? raw : null,
      id_comp: !isCode ? raw : null,          // nom courant côté backend
      id_competence: !isCode ? raw : null,    // alias au cas où
      id_service: svc || null,
      criticite_min: CRITICITE_MIN,
      limit_postes: 500,
      limit_porteurs: 500
    });


    const url = `${portal.apiBase}/skills/analyse/risques/competence/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _compDetailCache.set(key, data);
    return data;
  }
 
  function openAnalysePosteModal(title, subHtml) {
    const modal = byId("modalAnalysePoste");
    if (!modal) return;

    const t = byId("analysePosteModalTitle");
    const s = byId("analysePosteModalSub");

    if (t) t.textContent = title || "Détail poste";
    if (s) s.innerHTML = subHtml || "";

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeAnalysePosteModal() {
    const modal = byId("modalAnalysePoste");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  // ==============================
  // Modal COMPETENCE (Risques)
  // ==============================
  function ensureAnalyseCompetenceModal() {
    let modal = byId("modalAnalyseCompetence");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalAnalyseCompetence" aria-hidden="true">
        <div class="modal-content" style="max-width:980px;">
          <div class="modal-header">
            <div style="min-width:0;">
              <div class="modal-title" id="analyseCompModalTitle">Détail compétence</div>
              <div class="modal-sub" id="analyseCompModalSub"></div>
            </div>
            <button type="button" class="modal-close" id="btnCloseAnalyseCompModal" aria-label="Fermer">×</button>
          </div>

          <div class="modal-body" id="analyseCompModalBody">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Chargement…</div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="btnAnalyseCompModalClose">Fermer</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalAnalyseCompetence");

    // Wiring 1 seule fois
    if (modal && modal.getAttribute("data-bound") !== "1") {
      modal.setAttribute("data-bound", "1");

      const btnX = byId("btnCloseAnalyseCompModal");
      const btnClose = byId("btnAnalyseCompModalClose");

      if (btnX) btnX.addEventListener("click", () => closeAnalyseCompetenceModal());
      if (btnClose) btnClose.addEventListener("click", () => closeAnalyseCompetenceModal());

      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeAnalyseCompetenceModal();
      });
    }

    return modal;
  }

  function openAnalyseCompetenceModal(title, subHtml) {
    const modal = ensureAnalyseCompetenceModal();
    if (!modal) return;

    const t = byId("analyseCompModalTitle");
    const s = byId("analyseCompModalSub");
    const b = byId("analyseCompModalBody");

    if (t) t.textContent = title || "Détail compétence";
    if (s) s.innerHTML = subHtml || "";
    if (b) b.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargement…</div></div>`;

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeAnalyseCompetenceModal() {
    const modal = byId("modalAnalyseCompetence");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function mapNiveauActuelForDisplay(raw) {
    const s = (raw ?? "").toString().trim().toLowerCase();
    if (!s) return "—";
    if (s === "initial") return "Initial - A";
    if (s === "avancé" || s === "avance" || s === "avancee" || s === "avancée") return "Avancé - B";
    if (s === "expert") return "Expert - C";
    return (raw ?? "").toString().trim() || "—";
  }

  function renderAnalyseCompetenceDetail(data) {
    const host = byId("analyseCompModalBody");
    if (!host) return;

    const comp = data?.competence || {};
    const postes = Array.isArray(data?.postes) ? data.postes : [];
    const porteurs = Array.isArray(data?.porteurs) ? data.porteurs : [];

    const scope = (data?.scope?.nom_service || "").trim() || "Tous les services";
    const critMin = String(data?.criticite_min ?? CRITICITE_MIN);

    const postesHtml = postes.length ? `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Poste</th>
              <th style="width:220px;">Service</th>
              <th class="col-center" style="width:120px;">Niveau requis</th>
              <th class="col-center" style="width:90px;">Criticité</th>
              <th class="col-center" style="width:110px;">Porteurs</th>
            </tr>
          </thead>
          <tbody>
            ${postes.map(p => {
              const poste = `${(p.codif_poste || "").trim()}${p.codif_poste ? " — " : ""}${(p.intitule_poste || "").trim()}`.trim() || "—";
              const svc = (p.nom_service || "").trim() || "—";
              const niv = (p.niveau_requis || "").toString().trim() || "—";
              const crit = (p.poids_criticite === null || p.poids_criticite === undefined) ? "—" : String(p.poids_criticite);
              const nb = Number(p.nb_porteurs || 0);
              const badge = nb > 0 ? `<span class="sb-badge sb-badge-accent">${nb}</span>` : `<span class="sb-badge">0</span>`;

              return `
                <tr>
                  <td style="font-weight:700;">${escapeHtml(poste)}</td>
                  <td>${escapeHtml(svc)}</td>
                  <td class="col-center" style="white-space:nowrap;">${escapeHtml(niv)}</td>
                  <td class="col-center" style="white-space:nowrap;">${escapeHtml(crit)}</td>
                  <td class="col-center">${badge}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    ` : `<div class="card-sub" style="margin:0;">Aucun poste impacté.</div>`;

    const porteursHtml = porteurs.length ? `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Porteur</th>
              <th style="width:220px;">Service</th>
              <th class="col-center" style="width:160px;">Niveau actuel</th>
            </tr>
          </thead>
          <tbody>
            ${porteurs.map(p => {
              const prenom = (p.prenom_effectif || "").trim();
              const nom = (p.nom_effectif || "").trim();
              const full = `${prenom} ${nom}`.trim() || "—";
              const svc = (p.nom_service || "").trim() || "—";
              const niv = mapNiveauActuelForDisplay(p.niveau_actuel);

              return `
                <tr>
                  <td style="font-weight:700;">${escapeHtml(full)}</td>
                  <td>${escapeHtml(svc)}</td>
                  <td class="col-center" style="white-space:nowrap;">${escapeHtml(niv)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    ` : `<div class="card-sub" style="margin:0;">Aucun porteur.</div>`;

    host.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span class="sb-badge">Service : ${escapeHtml(scope)}</span>
          <span class="sb-badge sb-badge-accent">Criticité min: ${escapeHtml(critMin)}</span>
        </div>

        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Postes impactés</div>
          ${postesHtml}
        </div>

        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Porteurs</div>
          ${porteursHtml}
        </div>
      </div>
    `;
  }

  async function showAnalyseCompetenceDetailModal(portal, id_comp_or_code, id_service) {
    const mySeq = ++_compDetailReqSeq;

    openAnalyseCompetenceModal(
      "Détail compétence",
      `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
         <span class="sb-badge sb-badge-accent">Chargement</span>
       </div>`
    );

    try {
      const data = await fetchAnalyseCompetenceDetail(portal, id_comp_or_code, id_service);
      if (mySeq !== _compDetailReqSeq) return;

      const comp = data?.competence || {};
      const title = `${(comp.code ? comp.code + " — " : "")}${comp.intitule || "Compétence"}`.trim();

      const scope = (data?.scope?.nom_service || "").trim() || "Tous les services";
      const sub = `
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <span class="sb-badge">Service : ${escapeHtml(scope)}</span>
          <span class="sb-badge sb-badge-accent">Criticité min: ${escapeHtml(String(data?.criticite_min ?? CRITICITE_MIN))}</span>
        </div>
      `;

      openAnalyseCompetenceModal(title || "Détail compétence", sub);
      renderAnalyseCompetenceDetail(data);

    } catch (e) {
      if (mySeq !== _compDetailReqSeq) return;

      openAnalyseCompetenceModal(
        "Détail compétence",
        `<div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(errMsg(e))}</div>`
      );
      const host = byId("analyseCompModalBody");
      if (host) {
        host.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Impossible de charger le détail.</div></div>`;
      }
    }
  }


  function setAnalysePosteTab(tabName) {
    const btnA = byId("tabAnalysePosteCompetences");
    const btnB = byId("tabAnalysePosteCouverture");
    const a = byId("analysePosteTabCompetences");
    const b = byId("analysePosteTabCouverture");

    const isA = tabName === "competences";

    if (a) a.style.display = isA ? "" : "none";
    if (b) b.style.display = isA ? "none" : "";

    // Visuel simple sans ajouter de CSS
    if (btnA) {
      btnA.style.borderColor = isA ? "var(--accent)" : "#d1d5db";
      btnA.style.background = isA ? "color-mix(in srgb, var(--accent) 10%, #ffffff)" : "#ffffff";
      btnA.style.fontWeight = isA ? "700" : "600";
    }
    if (btnB) {
      btnB.style.borderColor = !isA ? "var(--accent)" : "#d1d5db";
      btnB.style.background = !isA ? "color-mix(in srgb, var(--accent) 10%, #ffffff)" : "#ffffff";
      btnB.style.fontWeight = !isA ? "700" : "600";
    }
  }

  function renderPostePorteurs(porteurs, idPosteAnalyse) {
    const list = Array.isArray(porteurs) ? porteurs : [];
    if (!list.length) {
      return `<div class="card-sub" style="margin-top:6px; color:#6b7280;">Aucun porteur</div>`;
    }

    function mapNiveauActuel(raw) {
      const s = (raw ?? "").toString().trim().toLowerCase();
      if (!s) return "—";

      if (s === "initial") return "Initial - A";
      if (s === "avancé" || s === "avance" || s === "avancee" || s === "avancée" || s === "avancee ") return "Avancé - B";
      if (s === "expert") return "Expert - C";

      // fallback si jamais tu as d'autres valeurs
      return (raw ?? "").toString().trim() || "—";
    }

    const max = 8;
    const shown = list.slice(0, max);

    const rows = shown.map(p => {
      const prenom = (p.prenom_effectif || "").trim();
      const nom = (p.nom_effectif || "").trim();
      const full = `${prenom} ${nom}`.trim() || "—";

      const niv = mapNiveauActuel(p.niveau_actuel);

      // On n'affiche plus le poste, uniquement le service (si tu veux rien du tout, mets right = "")
      const svc = (p.nom_service || "").trim();
      const right = svc || "—";

      const posteActuel = (p.id_poste_actuel || "").trim();
      const posteRef = (idPosteAnalyse || "").trim();

      const isSamePoste = !!posteRef && !!posteActuel && posteActuel === posteRef;
      const sqColor = isSamePoste ? "#16a34a" : "#f59e0b"; // vert / orange
      const sqTitle = isSamePoste ? "Poste identique" : "Poste différent / non renseigné";

      return `
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="display:flex; align-items:center; gap:8px; padding-left:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <span title="${escapeHtml(sqTitle)}"
                  style="width:10px; height:10px; border-radius:2px; background:${sqColor}; border:1px solid rgba(0,0,0,.12); flex:0 0 auto;">
            </span>

            <span style="font-weight:600; color:#111827; font-size:12px; overflow:hidden; text-overflow:ellipsis;">
              ${escapeHtml(full)}
            </span>

            <span style="font-weight:600; color:#6b7280; font-size:11px; flex:0 0 auto;">
              (${escapeHtml(niv)})
            </span>
          </span>

          <span style="color:#6b7280; font-size:11px; white-space:nowrap;">
            ${escapeHtml(right)}
          </span>
        </div>
      `;
    }).join("");

    const more = list.length > max
      ? `<div class="card-sub" style="margin-top:4px; color:#6b7280;">+ ${list.length - max} autre(s)</div>`
      : "";

    return `<div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">${rows}${more}</div>`;
  }


  function renderAnalysePosteCompetencesTab(data) {
    const host = byId("analysePosteTabCompetences");
    if (!host) return;

    const list = Array.isArray(data?.competences) ? data.competences : [];

    if (!list.length) {
      host.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-sub" style="margin:0;">Aucune compétence trouvée pour ce poste.</div>
        </div>
      `;
      return;
    }

    host.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Compétences requises</div>

        <div class="table-wrap" style="margin-top:10px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th style="width:90px;">Code</th>
                <th>Compétence</th>
                <th class="col-center" style="width:120px;">Niveau requis</th>
                <th class="col-center" style="width:90px;">Criticité</th>
                <th class="col-center" style="width:120px;">Couverture</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(c => {
                const code = escapeHtml(c.code || "—");
                const intit = escapeHtml(c.intitule || "—");
                const nivReq = escapeHtml(c.niveau_requis || "—");
                const crit = (c.poids_criticite === null || c.poids_criticite === undefined) ? "—" : escapeHtml(String(c.poids_criticite));

                const porteurs = Array.isArray(c.porteurs) ? c.porteurs : [];
                const nb = (c.nb_porteurs === null || c.nb_porteurs === undefined) ? porteurs.length : Number(c.nb_porteurs || 0);

                const badge = nb > 0
                  ? `<span class="sb-badge sb-badge-accent">${nb}</span>`
                  : `<span class="sb-badge">0</span>`;

                const porteursHtml = renderPostePorteurs(porteurs, data?.poste?.id_poste);

                return `
                  <tr>
                    <td style="font-weight:700; white-space:nowrap;">${code}</td>
                    <td>
                      ${intit}
                      ${porteursHtml}
                    </td>
                    <td class="col-center" style="white-space:nowrap;">${nivReq}</td>
                    <td class="col-center" style="white-space:nowrap;">${crit}</td>
                    <td class="col-center" style="white-space:nowrap;">${badge}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>

        <div class="card-sub" style="margin-top:10px; color:#6b7280;">
          Couverture = nombre de collaborateurs porteurs de la compétence (dans le périmètre filtré).
          Le niveau affiché entre parenthèses correspond à <b>niveau_actuel</b>.
        </div>
      </div>
    `;
  }

  function renderAnalysePosteCouvertureTab(data) {
    const host = byId("analysePosteTabCouverture");
    if (!host) return;

    const cov = data?.coverage || {};
    const total = Number(cov.total_competences || 0);

    function pct(part) {
      const p = Number(part || 0);
      if (!total) return 0;
      return Math.round((p / total) * 100);
    }

    function bar(label, part, sub) {
      const p = pct(part);
      return `
        <div class="card" style="padding:12px; margin:0 0 10px 0;">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;">
            <div style="font-weight:700;">${escapeHtml(label)}</div>
            <div class="sb-badge sb-badge-accent">${p}%</div>
          </div>
          <div style="margin-top:8px; height:10px; background:#e5e7eb; border-radius:999px; overflow:hidden;">
            <div style="height:10px; width:${p}%; background:var(--accent); border-radius:999px;"></div>
          </div>
          ${sub ? `<div class="card-sub" style="margin-top:6px;">${sub}</div>` : ``}
        </div>
      `;
    }

    const c1 = Number(cov.couvert_1plus || 0);
    const c2 = Number(cov.couvert_2plus || 0);
    const nc = Number(cov.non_couvert || 0);
    const u1 = Number(cov.porteur_unique || 0);

    const critTot = Number(cov.total_critiques || 0);
    const critNc = Number(cov.critiques_non_couvert || 0);
    const critU1 = Number(cov.critiques_porteur_unique || 0);

    host.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Couverture du poste</div>
        <div class="card-sub" style="margin:0;">
          Mesure simple basée sur le nombre de porteurs par compétence. Criticité min: <b>${escapeHtml(String(data?.criticite_min ?? CRITICITE_MIN))}</b>
        </div>

        <div style="margin-top:12px;">
          ${bar("Compétences couvertes (≥ 1 porteur)", c1, `${c1}/${total} compétences`)}
          ${bar("Compétences sécurisées (≥ 2 porteurs)", c2, `${c2}/${total} compétences`)}
          ${bar("Compétences non couvertes (0 porteur)", nc, `${nc}/${total} compétences`)}
          ${bar("Compétences à dépendance (1 porteur)", u1, `${u1}/${total} compétences`)}
        </div>

        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Focus compétences critiques</div>
          <div class="card-sub" style="margin:0;">Critiques = criticité ≥ ${escapeHtml(String(data?.criticite_min ?? CRITICITE_MIN))}</div>

          <div class="row" style="gap:12px; margin-top:12px; flex-wrap:wrap;">
            <div class="card" style="padding:12px; margin:0; flex:1; min-width:160px;">
              <div class="label">Critiques (total)</div>
              <div class="value">${critTot}</div>
            </div>
            <div class="card" style="padding:12px; margin:0; flex:1; min-width:160px;">
              <div class="label">Critiques non couvertes</div>
              <div class="value">${critNc}</div>
            </div>
            <div class="card" style="padding:12px; margin:0; flex:1; min-width:160px;">
              <div class="label">Critiques porteur unique</div>
              <div class="value">${critU1}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

async function showAnalysePosteDetailModal(portal, id_poste, id_service, focusKey) {
  const mySeq = ++_posteDetailReqSeq;

  const focus = (focusKey || "").trim(); // "critiques-sans-porteur" | "porteur-unique" | "total-fragiles" | ""
  const modal = byId("modalAnalysePoste");
  if (modal) modal.setAttribute("data-focus", focus);

  function focusLabel(k) {
    if (k === "critiques-sans-porteur") return "Critiques sans porteur";
    if (k === "porteur-unique") return "Porteur unique";
    if (k === "total-fragiles") return "Fragilités (0 ou 1 porteur)";
    return "";
  }

  openAnalysePosteModal(
    "Détail poste",
    `<div class="card-sub" style="margin:0;">Chargement…</div>`
  );

  // Par défaut, si clic sur "Total fragiles" => on ouvre l’onglet Couverture
  setAnalysePosteTab(focus === "total-fragiles" ? "couverture" : "competences");

  const tabA = byId("analysePosteTabCompetences");
  const tabB = byId("analysePosteTabCouverture");
  if (tabA) tabA.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargement…</div></div>`;
  if (tabB) tabB.innerHTML = "";

  try {
    const data = await fetchAnalysePosteDetail(portal, id_poste, id_service);
    if (mySeq !== _posteDetailReqSeq) return;

    const poste = data?.poste || {};
    const posteLabel = `${poste.codif_poste ? poste.codif_poste + " — " : ""}${poste.intitule_poste || "Poste"}`.trim();

    const scope = (data?.scope?.nom_service || "").trim() || "Tous les services";

    const focusLab = focusLabel(focus);
    const focusHtml = focusLab
      ? `<span class="sb-badge">Focus : ${escapeHtml(focusLab)}</span>`
      : ``;

    const sub = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <span class="sb-badge">Service : ${escapeHtml(scope)}</span>
        <span class="sb-badge sb-badge-accent">Criticité min: ${escapeHtml(String(data?.criticite_min ?? CRITICITE_MIN))}</span>
        ${focusHtml}
      </div>
    `;

    openAnalysePosteModal(posteLabel || "Détail poste", sub);

    // ----- Filtrage côté UI selon le focus (sinon tu verras toujours la même table)
    const comps = Array.isArray(data?.competences) ? data.competences : [];

    function getNbPorteurs(c) {
      const p = Array.isArray(c?.porteurs) ? c.porteurs : [];
      const nb = (c?.nb_porteurs === null || c?.nb_porteurs === undefined) ? p.length : Number(c.nb_porteurs || 0);
      return nb;
    }

    let compsFiltered = comps;

    if (focus === "critiques-sans-porteur") {
      compsFiltered = comps.filter(c => getNbPorteurs(c) === 0);
    } else if (focus === "porteur-unique") {
      compsFiltered = comps.filter(c => getNbPorteurs(c) === 1);
    } else if (focus === "total-fragiles") {
      compsFiltered = comps.filter(c => getNbPorteurs(c) <= 1);
    }

    const dataForCompetences = { ...data, competences: compsFiltered };

    renderAnalysePosteCompetencesTab(dataForCompetences);

    // Couverture = calculée sur le dataset complet (pas filtré)
    renderAnalysePosteCouvertureTab(data);

  } catch (e) {
    if (mySeq !== _posteDetailReqSeq) return;

    openAnalysePosteModal(
      "Détail poste",
      `<div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>`
    );

    const tabA = byId("analysePosteTabCompetences");
    if (tabA) {
      tabA.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Impossible de charger le détail.</div></div>`;
    }
  }
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
        // MATCHING (MVP)
        // -----------------------
        if (mode === "matching") {
          if (title) title.textContent = "Matching poste-porteur";
          if (sub) sub.textContent = "Top candidats internes par poste (score pondéré niveau + criticité).";

          // Vue Matching : "titulaire" ou "candidats" (pilotée par la tuile)
          setActiveMatchKpi(getMatchView());

          const id_service = (byId("analyseServiceSelect")?.value || "").trim();

          body.innerHTML = renderMatchingShell();

          if (!_portalRef) {
            const host = byId("matchResult");
            if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Contexte portail indisponible.</div>`;
            return;
          }

          const mySeq = ++_matchReqSeq;

          (async () => {
            try {
              const postes = await fetchMatchingPostes(_portalRef, id_service);
              if (mySeq !== _matchReqSeq) return;

              // si le poste sélectionné n’existe plus dans la liste, on reset
              if (_matchSelectedPoste && !postes.some(p => (p.id_poste || "").toString().trim() === _matchSelectedPoste)) {
                _matchSelectedPoste = "";
              }

              if (!_matchSelectedPoste && postes.length) {
                _matchSelectedPoste = (postes[0].id_poste || "").toString().trim();
              }

              renderMatchingPosteList(postes, _matchSelectedPoste);

              if (_matchSelectedPoste) {
                await showMatchingForPoste(_portalRef, _matchSelectedPoste, id_service, mySeq);
              }

            } catch (e) {
              const host = byId("matchResult");
              if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>`;
            }
          })();

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
          <table class="sb-table" id="tblRiskPostesFragiles">
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
                  <tr class="risk-poste-row" data-id_poste="${escapeHtml(r.id_poste || "")}" style="cursor:pointer;">
                    <td data-focus="poste" style="font-weight:700;">${escapeHtml(poste)}</td>
                    <td data-focus="poste">${escapeHtml(svc)}</td>
                    <td class="col-center" data-focus="critiques-sans-porteur" title="Voir les compétences critiques sans porteur">
                      ${a ? badge(String(a), true) : badge("0", false)}
                    </td>
                    <td class="col-center" data-focus="porteur-unique" title="Voir les compétences critiques à porteur unique">
                      ${b ? badge(String(b), true) : badge("0", false)}
                    </td>
                    <td class="col-center" data-focus="total-fragiles" title="Voir la synthèse de couverture du poste">
                      ${c ? badge(String(c), true) : badge("0", false)}
                    </td>
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
          <table class="sb-table" id="tblRiskCompetences">
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
                const code = (r.code || "—").toString().trim();
                const intit = (r.intitule || "—").toString();

                const idComp =
                  (r.id_competence || r.id_comp || r.id_competence_skillboard || r.id_competence_pk || "").toString().trim();

                const compKey = (idComp || code || "").trim();

                const nbPostes = Number(r.nb_postes_impactes || 0);
                const nbPorteurs = Number(r.nb_porteurs || 0);
                const crit = Number(r.max_criticite || 0);

                return `
                  <tr class="risk-comp-row"
                      data-comp-key="${escapeHtml(compKey)}"
                      data-code="${escapeHtml(code)}"
                      data-id_comp="${escapeHtml(idComp)}"
                      style="cursor:pointer;"
                      title="Ouvrir le détail de la compétence">
                    <td>${renderDomainPill(r)}</td>
                    <td style="font-weight:700; white-space:nowrap;">${escapeHtml(code || "—")}</td>
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

      // Matching : on laisse volontairement les KPI en "—".
      // Les KPI de tuile servent ici de boutons de vue (titulaire vs candidats), pas de compteur.

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

    // KPI Matching cliquables => bascule de vue (titulaire / candidats)
    const tileMatching = byId("tileMatching");
    if (tileMatching) {
      const matchKpis = tileMatching.querySelectorAll(".mini-kpi[data-match-view]");

      function openMatchView(el, ev) {
        const v = (el?.getAttribute("data-match-view") || "").trim();
        if (v !== "titulaire" && v !== "candidats") return;

        // Empêche le click de remonter sur la tuile (sinon il faut recliquer...)
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }

        // 1) on fixe la vue
        setMatchView(v);

        // 2) si on n'est pas déjà en matching, on bascule (ce qui rend automatiquement)
        const curMode = (localStorage.getItem(STORE_MODE) || "").trim();
        if (curMode !== "matching") {
          setMode("matching");
          return;
        }

        // 3) sinon on re-rend uniquement la vue matching
        renderDetail("matching");
      }

      matchKpis.forEach((el) => {
        el.addEventListener("click", (ev) => openMatchView(el, ev));
        el.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            openMatchView(el, ev);
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

    // ==============================
    // Modal Poste (Risques) - wiring
    // ==============================
    const modalPoste = byId("modalAnalysePoste");
    const btnXPoste = byId("btnCloseAnalysePosteModal");
    const btnClosePoste = byId("btnAnalysePosteModalClose");
    const tabA = byId("tabAnalysePosteCompetences");
    const tabB = byId("tabAnalysePosteCouverture");

    if (btnXPoste) btnXPoste.addEventListener("click", () => closeAnalysePosteModal());
    if (btnClosePoste) btnClosePoste.addEventListener("click", () => closeAnalysePosteModal());

    if (modalPoste) {
      modalPoste.addEventListener("click", (e) => {
        if (e.target === modalPoste) closeAnalysePosteModal();
      });
    }

        if (tabA) tabA.addEventListener("click", () => setAnalysePosteTab("competences"));
        if (tabB) tabB.addEventListener("click", () => setAnalysePosteTab("couverture"));

      // ==============================
      // Click délégué: lignes "Poste fragile" (survit aux rerender)
      // - utilise data-focus posé sur les <td>
      // ==============================
            const analyseBody = byId("analyseDetailBody");
            if (analyseBody) {
              analyseBody.addEventListener("click", async (ev) => {

                // ------------------------------
                // 1) Click sur une ligne POSTE
                // ------------------------------
                const trPoste = ev.target.closest("tr.risk-poste-row[data-id_poste]");
                if (trPoste) {
                  const id_poste = (trPoste.getAttribute("data-id_poste") || "").trim();
                  if (!id_poste) return;

                  const id_service = (byId("analyseServiceSelect")?.value || "").trim();

                  let focusKey = "";
                  const td = ev.target.closest("td[data-focus]");
                  const focus = (td?.getAttribute("data-focus") || "").trim();

                  if (focus === "critiques-sans-porteur") focusKey = "critiques-sans-porteur";
                  else if (focus === "porteur-unique") focusKey = "porteur-unique";
                  else if (focus === "total-fragiles") focusKey = "total-fragiles";
                  else focusKey = "";

                  await showAnalysePosteDetailModal(portal, id_poste, id_service, focusKey);
                  return;
                }

                // ------------------------------
                // 2) Click sur une ligne COMPETENCE
                // ------------------------------
                const trComp = ev.target.closest("tr.risk-comp-row[data-comp-key]");
                if (trComp) {
                  const compKey = (trComp.getAttribute("data-comp-key") || "").trim();
                  if (!compKey || compKey === "—") return;

                  const id_service = (byId("analyseServiceSelect")?.value || "").trim();
                  await showAnalyseCompetenceDetailModal(portal, compKey, id_service);
                  return;
                }

                                // ------------------------------
                // 3) Matching: sélection poste
                // ------------------------------
                const btnMatch = ev.target.closest("[data-match-id_poste]");
                if (btnMatch) {
                  const id_poste = (btnMatch.getAttribute("data-match-id_poste") || "").trim();
                  if (!id_poste) return;

                  _matchSelectedPoste = id_poste;

                  // Re-render matching (met à jour surbrillance + résultats)
                  renderDetail("matching");
                  return;
                }


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

