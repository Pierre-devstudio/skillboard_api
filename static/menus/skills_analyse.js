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
  let _portalref = null;
  let _prevData = null;

  const NON_LIE_ID = "__NON_LIE__";
  const STORE_SERVICE = "sb_analyse_service";
  const STORE_MODE = "sb_analyse_mode";
  const STORE_RISK_FILTER = "sb_analyse_risk_filter";
  const STORE_MATCH_VIEW = "sb_analyse_match_view"; // "titulaire" | "candidats"
  const STORE_PREV_HORIZON = "sb_analyse_prev_horizon";


  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatDateFr(iso) {
  const s = (iso || "").toString().trim();
  // attend du "YYYY-MM-DD" (ce que ton API renvoie)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || "—";
  return `${m[3]}-${m[2]}-${m[1]}`;
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

  // ==============================
  // Prévisions - slider horizon (1..5 ans)
  // - Les KPI restent dans la tuile Prévisions, sans toucher au panneau détail (V1)
  // - Les données viennent de tiles.previsions.horizons (backend)
  // ==============================
  function clampInt(v, min, max, defv) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return defv;
    return Math.max(min, Math.min(max, n));
  }

  function getPrevHorizon() {
    return clampInt(localStorage.getItem(STORE_PREV_HORIZON), 1, 5, 1);
  }

  function setPrevHorizon(v) {
    const n = clampInt(v, 1, 5, 1);
    localStorage.setItem(STORE_PREV_HORIZON, String(n));
    return n;
  }

  function setPrevHorizonLabel(n) {
    const el = byId("prevHorizonLabel");
    if (!el) return;
    el.textContent = (n === 1) ? "1 an" : (String(n) + " ans");
  }

  function pickPrevHorizonItem(previsions, horizonYears) {
    const list = Array.isArray(previsions?.horizons) ? previsions.horizons : [];
    const h = Number(horizonYears || 0);
    return list.find(x => Number(x?.horizon_years || 0) === h) || null;
  }

  function applyPrevisionsKpis(previsions) {
    const p = previsions || {};
    _prevData = p;

    const horizon = getPrevHorizon();
    setPrevHorizonLabel(horizon);

    const item = pickPrevHorizonItem(p, horizon);

    if (item) {
      setText("kpiPrevSorties12", item.sorties);
      setText("kpiPrevCompImpact", item.comp_critiques_impactees);
      setText("kpiPrevPostesRed", item.postes_rouges);
      return;
    }

    // Fallback: comportement historique (12 mois)
    setText("kpiPrevSorties12", p.sorties_12m);
    setText("kpiPrevCompImpact", p.comp_critiques_impactees);
    setText("kpiPrevPostesRed", p.postes_rouges_12m);
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

    // reset état active des tuiles
    tiles.forEach(t => t.classList.remove("active"));

    // reset visuel de tous les mini-KPI
    tiles.forEach(t => {
      const kpis = t.querySelectorAll(".mini-kpi");
      kpis.forEach(kpi => {
        kpi.style.borderColor = "#e5e7eb";
        kpi.style.background = "#ffffff";
      });
    });

    const map = {
      risques: byId("tileRisques"),
      matching: byId("tileMatching"),
      previsions: byId("tilePrevisions")
    };

    const finalMode = (mode || "risques").toString().trim().toLowerCase();
    const tile = map[finalMode] || map.risques;
    if (tile) tile.classList.add("active");

    // Ré-appliquer les KPI actifs uniquement pour la tuile active
    if (finalMode === "risques") {
      setActiveRiskKpi(getRiskFilter());
      setActiveMatchKpi(""); // reset
      setActivePrevKpi("");  // reset
    } else if (finalMode === "matching") {
      setActiveRiskKpi(""); // reset
      setActiveMatchKpi(getMatchView());
      setActivePrevKpi(""); // reset
    } else if (finalMode === "previsions") {
      setActiveRiskKpi(""); // reset
      setActiveMatchKpi(""); // reset
      setActivePrevKpi((localStorage.getItem("sb_analyse_prev_kpi") || "").trim());
    } else {
      setActiveRiskKpi("");
      setActiveMatchKpi("");
      setActivePrevKpi("");
    }
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
        ? "color-mix(in srgb, var(--reading-accent) 55%, #d1d5db)"
        : "#e5e7eb";

      el.style.background = isActive
        ? "color-mix(in srgb, var(--reading-accent) 6%, #ffffff)"
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

    // si la tuile n'est pas active => aucun KPI ne doit paraître actif
    const tileIsActive = tile.classList.contains("active");

    const items = tile.querySelectorAll(".mini-kpi[data-match-view]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-match-view") || "").trim().toLowerCase();
      const isActive = tileIsActive && !!view && k === view;

      el.style.borderColor = isActive
        ? "color-mix(in srgb, var(--reading-accent) 55%, #d1d5db)"
        : "#e5e7eb";

      el.style.background = isActive
        ? "color-mix(in srgb, var(--reading-accent) 6%, #ffffff)"
        : "#ffffff";
    });
  }

  function setActivePrevKpi(key) {
    const tile = byId("tilePrevisions");
    if (!tile) return;

    // si la tuile n'est pas active => aucun KPI ne doit paraître actif
    const tileIsActive = tile.classList.contains("active");

    const items = tile.querySelectorAll(".mini-kpi[data-prev-kpi]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-prev-kpi") || "").trim().toLowerCase();
      const isActive = tileIsActive && !!key && k === String(key).trim().toLowerCase();

      el.style.borderColor = isActive
        ? "color-mix(in srgb, var(--reading-accent) 55%, #d1d5db)"
        : "#e5e7eb";

      el.style.background = isActive
        ? "color-mix(in srgb, var(--reading-accent) 6%, #ffffff)"
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

  // Détail effectif (drilldown)
  const _matchEffDetailCache = new Map(); // key: id_poste|id_effectif|id_service|crit
  async function fetchMatchingEffectifDetail(portal, id_poste, id_effectif, id_service) {
    const svc = (id_service || "").trim();
    const key = `${id_poste}|${id_effectif}|${svc}|${CRITICITE_MIN}`;
    if (_matchEffDetailCache.has(key)) return _matchEffDetailCache.get(key);

    const qs = buildQueryString({
      id_poste: id_poste,
      id_effectif: id_effectif,
      id_service: svc || null,
      criticite_min: CRITICITE_MIN
    });

    const url = `${portal.apiBase}/skills/analyse/matching/effectif/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _matchEffDetailCache.set(key, data);
    return data;
  }

  async function fetchPrevisionsSortiesDetail(portal, horizonYears, id_service) {
    const id_contact = String(
      portal?.id_contact ||
      portal?.idContact ||
      portal?.contact_id ||
      portal?.contactId ||
      portal?.contact?.id_contact ||
      portal?.contact?.idContact ||
      ""
    ).trim();

    const apiBaseRaw = String(
      portal?.api_base ||
      portal?.apiBase ||
      portal?.api ||
      portal?.base_url ||
      portal?.baseUrl ||
      window.API_BASE ||
      window.SKILLS_API_BASE ||
      ""
    ).trim();

    const apiBase = apiBaseRaw.replace(/\/$/, "");

    if (!id_contact) throw new Error("id_contact introuvable (portalRef).");
    if (!apiBase) throw new Error("base API introuvable (portalRef).");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears));
    if (id_service) qs.set("id_service", id_service);

    const url = `${apiBase}/skills/analyse/previsions/sorties/detail/${encodeURIComponent(id_contact)}?${qs.toString()}`;

    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${txt ? " - " + txt : ""}`);
    }

    return await res.json();
  }

  // ======================================================
  // Helpers contexte portail (id_contact + apiBase)
  // ======================================================
  function _sbReadAttr(el, name) {
    if (!el) return "";
    if (typeof el.getAttribute === "function") return (el.getAttribute(name) || "").trim();
    return "";
  }

  function getPortalContext(portal) {
    const el =
      document.querySelector("[data-id_contact],[data-id-contact],[data-contact-id],[data-api-base]") ||
      byId("skillsPortalAnalyse") ||
      byId("skillsPortal") ||
      null;

    const id_contact = String(
      portal?.id_contact ||
      portal?.idContact ||
      portal?.contact_id ||
      portal?.contactId ||
      _sbReadAttr(el, "data-id_contact") ||
      _sbReadAttr(el, "data-id-contact") ||
      _sbReadAttr(el, "data-contact-id") ||
      el?.dataset?.id_contact ||
      el?.dataset?.idContact ||
      el?.dataset?.contactId ||
      el?.dataset?.contact_id ||
      ""
    ).trim();

    const apiBaseRaw = String(
      portal?.api_base ||
      portal?.apiBase ||
      portal?.api ||
      portal?.base_url ||
      portal?.baseUrl ||
      _sbReadAttr(el, "data-api-base") ||
      el?.dataset?.apiBase ||
      window.API_BASE ||
      window.SKILLS_API_BASE ||
      ""
    ).trim();

    return {
      id_contact,
      apiBase: apiBaseRaw.replace(/\/$/, ""),
    };
  }


  // ======================================================
  // API: détail "Critiques impactées" (prévisions)
  // ======================================================
  async function fetchPrevisionsCritiquesDetail(portal, horizonYears, id_service) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());

    // IMPORTANT: endpoint à créer côté API (FastAPI) si pas encore fait
    const url = `${ctx.apiBase}/skills/analyse/previsions/critiques/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;

    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${txt ? " - " + txt : ""}`);
    }
    return await res.json();
  }



  function ensureMatchPersonModal() {
    let modal = byId("modalMatchPerson");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalMatchPerson" aria-hidden="true">
        <div class="modal-card" style="max-width:1120px; width:min(1120px, 96vw); max-height:92vh; display:flex; flex-direction:column;">
          <div class="modal-header">
            <div style="font-weight:600;" id="matchPersonModalTitle">Détail</div>
            <button type="button" class="modal-x" id="btnCloseMatchPersonModal" aria-label="Fermer">×</button>
          </div>

          <div class="modal-body" id="matchPersonModalBody" style="overflow:auto; flex:1; padding:14px 16px;">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Chargement…</div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-secondary" id="btnMatchPersonModalClose">Fermer</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalMatchPerson");

    if (modal && modal.getAttribute("data-bound") !== "1") {
      modal.setAttribute("data-bound", "1");

      const btnX = byId("btnCloseMatchPersonModal");
      const btnClose = byId("btnMatchPersonModalClose");

      if (btnX) btnX.addEventListener("click", () => closeMatchPersonModal());
      if (btnClose) btnClose.addEventListener("click", () => closeMatchPersonModal());

      // fermeture clic fond
      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) closeMatchPersonModal();
      });

      // ESC
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeMatchPersonModal();
      });
    }

    return modal;
  }

  function openMatchPersonModal(title) {
    const modal = ensureMatchPersonModal();
    const t = byId("matchPersonModalTitle");
    const b = byId("matchPersonModalBody");
    if (t) t.textContent = title || "Détail";
    if (b) b.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargement…</div></div>`;

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeMatchPersonModal() {
    const modal = byId("modalMatchPerson");
    if (!modal) return;

    // Nettoyage éventuel radar (ResizeObserver)
    if (modal.__matchRadarObs) {
      try { modal.__matchRadarObs.disconnect(); } catch (e) { }
      modal.__matchRadarObs = null;
    }

    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function renderMatchPersonDetail(data) {
    const host = byId("matchPersonModalBody");
    if (!host) return;

    const poste = data?.poste || {};
    const person = data?.person || {};
    const stats = data?.stats || {};
    const items = Array.isArray(data?.items) ? data.items : [];

    const posteLabel = `${poste.codif_poste ? poste.codif_poste + " — " : ""}${poste.intitule_poste || "Poste"}`.trim();
    const personLabel = person.full || "—";
    const svc = person.nom_service || "—";
    const isTit = !!person.is_titulaire;

    function box(n, bg, title) {
      const nn = Number(n || 0);
      const isZero = !nn;
      const style = isZero
        ? "background:#e5e7eb; color:#6b7280; border:1px solid #d1d5db;"
        : `background:${bg}; color:#ffffff; border:1px solid rgba(0,0,0,.12);`;
      return `
        <span title="${escapeHtml(title)}"
              style="display:inline-flex; align-items:center; justify-content:center;
                    width:26px; height:20px; border-radius:5px;
                    font-size:12px; font-weight:900; line-height:1;
                    ${style}">
          ${nn || 0}
        </span>
      `;
    }

    function statusBadge(etat) {
      const s = String(etat || "").toLowerCase();
      if (s === "ok") return `<span style="font-weight:800; color:#065f46;">OK</span>`;
      if (s === "under") return `<span style="font-weight:800; color:#92400e;">À renforcer</span>`;
      return `<span style="font-weight:800; color:#991b1b;">Manquante</span>`;
    }

    function critMark(isCrit) {
      if (!isCrit) return "";
      return `<span class="sb-badge" title="Compétence critique" style="margin-left:6px; border-color:#ef4444; color:#991b1b;">CRIT</span>`;
    }

    function fmtScore(v) {
      if (v === null || v === undefined || v === "") return "—";
      const n = Number(v);
      if (Number.isNaN(n)) return "—";
      return (Math.round(n * 10) / 10).toString();
    }

    function renderCritDetails(arr) {
      const a = Array.isArray(arr) ? arr : [];
      if (!a.length) return "";
      const lis = a.map(x => {
        const nom = (x.nom || "").toString().trim();
        const code = (x.code_critere || "").toString().trim();
        const title = (nom || code || "Critère").trim();

        const n = (x.niveau === null || x.niveau === undefined) ? null : Number(x.niveau);
        const pts = (n && !Number.isNaN(n)) ? `${n}/4` : "—";

        const lib = (x.libelle || "").toString().trim();
        const extra = lib ? ` <span style="color:#6b7280;">${escapeHtml(lib)}</span>` : "";

        return `<li><b>${escapeHtml(title)}</b> : <span style="font-weight:800;">${escapeHtml(pts)}</span>${extra}</li>`;
      }).join("");
      return `
        <details style="margin-top:6px;">
          <summary style="cursor:pointer; color:#6b7280; font-size:12px;">Voir critères</summary>
          <ul style="margin:8px 0 0 18px; color:#374151; font-size:12px;">
            ${lis}
          </ul>
        </details>
      `;
    }

    const rows = items.map(it => {
      const code = it.code || it.id_comp || "—";
      const intitule = it.intitule || "";
      const poids = Number(it.poids_criticite || 1);
      const niv = it.niveau_requis || "—";
      const seuil = fmtScore(it.seuil);
      const score = fmtScore(it.score);
      const nivAt = it.niveau_atteint || "—";
      const domain = (it.domaine_titre_court || "").trim();
      const domainBadge = domain ? `<span class="sb-badge">${escapeHtml(domain)}</span>` : "";

      return `
        <tr>
          <td style="font-weight:800;">
            ${escapeHtml(code)} ${critMark(it.is_critique)}
            <div style="font-weight:600; color:#111827; margin-top:2px;">${escapeHtml(intitule)}</div>
            <div style="margin-top:4px;">${domainBadge}</div>
            ${renderCritDetails(it.criteres)}
          </td>
          <td class="col-center">${escapeHtml(String(poids))}</td>
          <td class="col-center">${escapeHtml(String(niv))}</td>
          <td class="col-center">${escapeHtml(String(seuil))}</td>
          <td class="col-center">${escapeHtml(String(score))}</td>
          <td class="col-center">${escapeHtml(String(nivAt))}</td>
          <td class="col-center">${statusBadge(it.etat)}</td>
        </tr>
      `;
    }).join("");


    // ------------------------------------------------------
    // Radar (vue synthèse)
    // - Axes = top compétences par poids_criticite
    // - Valeur = min(score / seuil, 1)
    // ------------------------------------------------------
    const RADAR_MAX_AXES = 12;

    const radarAxesAll = items.map((it) => {
      const w = Number(it.poids || it.poids_criticite || 1);
      const scoreN = Number(it.score_24 ?? it.score ?? it.resultat_eval ?? 0);
      const seuilN = Number(it.seuil_24 ?? it.seuil ?? 0);

      const et = String(it.etat || "").toLowerCase();
      const statusRank = (et === "missing") ? 2 : (et === "under" ? 1 : 0);

      const ratio = (seuilN > 0 && isFinite(scoreN))
        ? Math.max(0, Math.min(scoreN / seuilN, 1))
        : 0;

      return {
        code: (it.code || it.id_comp || ""),
        intitule: (it.intitule || it.titre || ""),
        poids: (isFinite(w) && w > 0) ? w : 1,
        seuil: (isFinite(seuilN) && seuilN > 0) ? seuilN : 0,
        score: isFinite(scoreN) ? scoreN : 0,
        ratio: ratio,
        etat: et,
        statusRank: statusRank,
      };
    }).filter(a => (a.code || a.intitule));

    radarAxesAll.sort((a, b) => {
      const dw = (b.poids - a.poids);
      if (dw) return dw;
      const ds = (b.statusRank - a.statusRank);
      if (ds) return ds;
      return String(a.code || a.intitule).localeCompare(String(b.code || b.intitule));
    });

    const radarTop = radarAxesAll.slice(0, RADAR_MAX_AXES);
    const radarEmpty = radarTop.length < 3;

    const radarRows = radarTop.map((a) => {
      const label = (a.code || a.intitule || "—").trim();
      const pct = Math.round((a.ratio || 0) * 100);
      const scoreTxt = a.score ? String(a.score) : "—";
      const seuilTxt = a.seuil ? String(a.seuil) : "—";
      const st = (a.etat === "ok") ? "OK" : (a.etat === "under" ? "À renforcer" : "Manquante");
      const stColor = (a.etat === "ok") ? "#065f46" : (a.etat === "under" ? "#92400e" : "#991b1b");

      return `
        <tr>
          <td>
            <div style="font-weight:900; color:#111827;">${escapeHtml(label)}</div>
            ${a.intitule ? `<div class="card-sub" style="margin:2px 0 0 0;">${escapeHtml(a.intitule)}</div>` : ""}
          </td>
          <td class="col-center">${escapeHtml(String(a.poids))}</td>
          <td class="col-center">${escapeHtml(scoreTxt)} / ${escapeHtml(seuilTxt)}</td>
          <td class="col-center">${escapeHtml(String(pct))}%</td>
          <td class="col-center" style="font-weight:900; color:${stColor};">${escapeHtml(st)}</td>
        </tr>
      `;
    }).join("");

    
  // ------------------------
  // Vue Radar - 2 sous-vues
  // ------------------------

  // Vue par compétence (graphique actuel + tableau)
  const radarHtmlComp = radarEmpty
  ? `<div class="card-sub" style="color:#6b7280;">Radar indisponible (moins de 3 compétences).</div>`
  : `
    <div style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#ffffff;">
      <canvas id="matchPersonRadarCanvas" style="width:100%; height:520px; display:block;"></canvas>
    </div>

    <div class="table-wrap" style="margin-top:10px;">
      <table class="sb-table">
        <thead>
          <tr>
            <th>Compétence</th>
            <th class="col-center" style="width:70px;">Poids</th>
            <th class="col-center" style="width:120px;">Score</th>
            <th class="col-center" style="width:90px;">Couverture</th>
            <th class="col-center" style="width:110px;">Statut</th>
          </tr>
        </thead>
        <tbody>
          ${radarRows || `<tr><td colspan="5" class="col-center" style="color:#6b7280;">Aucune donnée.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  // Vue par domaine (agrégation)
  function normDomain(s) {
  const v = (s ?? "").toString().trim();
  return v ? v.toLowerCase() : "";
  }

  function shortLabel(s, maxLen) {
  const v = (s ?? "").toString().trim();
  if (!v) return "—";
  if (v.length <= maxLen) return v;
  return v.slice(0, Math.max(4, maxLen - 1)) + "…";
  }

  const domMap = new Map();
  items.forEach((it) => {
  const raw = ((it.domaine_titre_court || it.domaine || "") ?? "").toString().trim();
  const key = normDomain(raw) || "__non_classe__";
  const label = raw || "Non classé";

  const seuilN = Number(it.seuil);
  const scoreN = Number(it.score);
  const poidsN = Number(it.poids_criticite || 1);

  let g = domMap.get(key);
  if (!g) {
    g = { key: key, label: label, attendu: 0, atteint: 0, poids: 0, nb: 0 };
    domMap.set(key, g);
  }

  g.attendu += (Number.isFinite(seuilN) ? seuilN : 0);
  g.atteint += (Number.isFinite(scoreN) ? scoreN : 0);
  g.poids += (Number.isFinite(poidsN) ? poidsN : 0);
  g.nb += 1;
  });

  const domainAxesAll = Array.from(domMap.values())
  .map((g) => {
    const attendu = Number(g.attendu || 0);
    const atteint = Number(g.atteint || 0);
    const pct = attendu > 0 ? (atteint / attendu) * 100 : 0;

    const etat = (pct >= 100)
      ? "ok"
      : (atteint > 0 ? "under" : "missing");

    return {
      key: g.key,
      label: g.label,
      code: shortLabel(g.label, 14),
      nb: g.nb || 0,
      poids: Math.round(Number(g.poids || 0)),
      attendu: attendu,
      atteint: atteint,
      pct: pct,
      ratio: Math.max(0, Math.min(pct / 100, 1)), // visuel cappé à 100%
      etat: etat
    };
  })
  .sort((a, b) => {
    const d1 = (b.attendu - a.attendu);
    if (d1) return d1;
    const d2 = (b.poids - a.poids);
    if (d2) return d2;
    return (a.label || "").localeCompare(b.label || "");
  });

  const domainAxesRadar = domainAxesAll.slice(0, RADAR_MAX_AXES); // même plafond que la vue compétence
  const domainEmpty = domainAxesRadar.length < 3;

  const domainRows = domainAxesAll.map((d) => {
  const pctInt = Math.round(Number(d.pct || 0));
  const pts = `${fmtScore(d.atteint)} / ${fmtScore(d.attendu)} pts`;
  return `
    <tr>
      <td>
        <div style="font-weight:900; color:#111827;">${escapeHtml(d.label)}</div>
        <div class="card-sub" style="margin:2px 0 0 0;">${escapeHtml(String(d.nb || 0))} compétence(s)</div>
      </td>
      <td class="col-center">${escapeHtml(String(d.nb || 0))}</td>
      <td class="col-center">
        <div style="font-weight:900;">${escapeHtml(String(pctInt))}%</div>
        <div class="card-sub" style="margin:2px 0 0 0; color:#6b7280;">${escapeHtml(pts)}</div>
      </td>
      <td class="col-center">${statusBadge(d.etat)}</td>
    </tr>
  `;
  }).join("");

  const radarHtmlDomain = domainEmpty
  ? `<div class="card-sub" style="color:#6b7280;">Radar indisponible (moins de 3 domaines).</div>`
  : `
    <div style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#ffffff;">
      <canvas id="matchDomainRadarCanvas" style="width:100%; height:520px; display:block;"></canvas>
    </div>

    <div class="table-wrap" style="margin-top:10px;">
      <table class="sb-table">
        <thead>
          <tr>
            <th>Domaine</th>
            <th class="col-center" style="width:90px;">Nb comp.</th>
            <th class="col-center" style="width:140px;">Atteinte</th>
            <th class="col-center" style="width:110px;">Statut</th>
          </tr>
        </thead>
        <tbody>
          ${domainRows || `<tr><td colspan="4" class="col-center" style="color:#6b7280;">Aucune donnée.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  host.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-sub" style="margin:0;">
          Poste : <b>${escapeHtml(posteLabel)}</b>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px; margin-top:10px;">
          <div>
            <div style="font-weight:900; font-size:16px;">${escapeHtml(personLabel)} ${isTit ? '<span class="sb-badge sb-badge-accent">Titulaire</span>' : '<span class="sb-badge">Candidat</span>'}</div>
            <div class="card-sub" style="margin:4px 0 0 0;">Service : ${escapeHtml(svc)}</div>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <span class="sb-badge sb-badge-accent" style="font-weight:900;">${escapeHtml(String(stats.score_pct || 0))}%</span>
            <span style="display:inline-flex; gap:6px; align-items:center;">
              ${box(stats.crit_missing, "#ef4444", "Critiques manquantes")}
              ${box(stats.crit_under, "#f59e0b", "Critiques à renforcer")}
              ${box(stats.nb_missing, "#ef4444", "Manquantes")}
              ${box(stats.nb_under, "#f59e0b", "À renforcer")}
            </span>
          </div>
        </div>


        <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
          <button type="button" id="btnMatchTabTable" class="sb-seg sb-seg--dark is-active">Détail</button>
          <button type="button" id="btnMatchTabRadar" class="sb-seg sb-seg--dark">Radar</button>
        </div>

        <div id="matchPersonTabTable" style="margin-top:12px;">
        <div class="table-wrap" style="margin-top:12px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Compétence</th>
                <th class="col-center" style="width:70px;">Poids</th>
                <th class="col-center" style="width:70px;">Requis</th>
                <th class="col-center" style="width:80px;">Seuil</th>
                <th class="col-center" style="width:80px;">Score</th>
                <th class="col-center" style="width:70px;">Niv.</th>
                <th class="col-center" style="width:110px;">Statut</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="7" class="col-center" style="color:#6b7280;">Aucune compétence requise.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="card-sub" style="margin-top:10px; color:#6b7280;">
          Critiques = poids_criticite ≥ ${CRITICITE_MIN}. Seuil (A/B/C) = 6 / 10 / 19. Niveau = déduit du score /24.
        </div>
        </div>

        <div id="matchPersonTabRadar" style="display:none; margin-top:12px;">
          <div style="margin:0 0 10px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button type="button" id="btnMatchRadarViewComp" class="sb-seg sb-seg--dark is-active">Vue par compétence</button>
            <button type="button" id="btnMatchRadarViewDomain" class="sb-seg sb-seg--dark">Vue par domaine</button>
          </div>

          <div id="matchRadarViewComp">
            <div class="card-sub" style="margin:0 0 10px 0; color:#6b7280;">
              Axes = top ${radarTop.length} compétences (triées par poids). Valeur = min(score / seuil, 1).
            </div>
            ${radarHtmlComp}
          </div>

          <div id="matchRadarViewDomain" style="display:none;">
            <div class="card-sub" style="margin:0 0 10px 0; color:#6b7280;">
              Axes = domaines. Valeur = % d’atteinte (somme scores / somme seuils). Le radar est cappé à 100% (le tableau peut dépasser).
            </div>
            ${radarHtmlDomain}
          </div>
        </div>
      </div>
    `;
 
    

    // ------------------------------------------------------
    // Radar - rendu canvas (JS pur)
    // ------------------------------------------------------
    function _parsePx(v) {
      const m = /(-?\d+(\.\d+)?)px/.exec(String(v || "").trim());
      return m ? Number(m[1]) : 0;
    }

    function _getCssVar(name, fallback) {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name);
        const s = (v || "").trim();
        return s || fallback;
      } catch (e) {
        return fallback;
      }
    }

    function _hexToRgba(hex, a) {
      const h = String(hex || "").trim();
      if (!h.startsWith("#")) return null;
      let r = 0, g = 0, b = 0;
      if (h.length === 4) {
        r = parseInt(h[1] + h[1], 16);
        g = parseInt(h[2] + h[2], 16);
        b = parseInt(h[3] + h[3], 16);
      } else if (h.length === 7) {
        r = parseInt(h.slice(1, 3), 16);
        g = parseInt(h.slice(3, 5), 16);
        b = parseInt(h.slice(5, 7), 16);
      } else {
        return null;
      }
      const aa = (a === null || a === undefined) ? 1 : Number(a);
      return `rgba(${r},${g},${b},${isFinite(aa) ? aa : 1})`;
    }

    function prepareCanvas2d(canvas) {
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const cs = getComputedStyle(canvas);
      const w = Math.floor(canvas.clientWidth || _parsePx(cs.width) || 0);
      const h = Math.floor(canvas.clientHeight || _parsePx(cs.height) || 0);
      if (!w || !h) return null;

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.floor(w * dpr);
      const ph = Math.floor(h * dpr);

      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return { ctx, w, h };
    }

    function drawRadarChart(canvas, axes) {
      if (!canvas || !axes || !axes.length) return;

      const prepared = prepareCanvas2d(canvas);
      if (!prepared) return;
      const { ctx, w, h } = prepared;

      const cx = w / 2;
      const cy = h / 2;
      const pad = 64;
      const r = Math.max(80, Math.min(w, h) / 2 - pad);

      const n = axes.length;
      const step = (Math.PI * 2) / n;
      const start = -Math.PI / 2;

      const grid = _getCssVar("--radar-grid", "#e5e7eb");
      const axis = _getCssVar("--radar-axis", "#d1d5db");
      const stroke = _getCssVar("--radar-stroke", _getCssVar("--ui-accent", "#2563eb"));
      const fill = _getCssVar("--radar-fill", _hexToRgba(stroke, 0.16) || "rgba(37,99,235,0.16)");
      const point = _getCssVar("--radar-point", stroke);
      const label = _getCssVar("--radar-label", "#111827");

      // Grille (5 niveaux)
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let k = 1; k <= 5; k++) {
        const rr = (r * k) / 5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const ang = start + i * step;
          const x = cx + rr * Math.cos(ang);
          const y = cy + rr * Math.sin(ang);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      // Axes
      ctx.strokeStyle = axis;
      for (let i = 0; i < n; i++) {
        const ang = start + i * step;
        const x = cx + r * Math.cos(ang);
        const y = cy + r * Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      // Courbe données
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const ang = start + i * step;
        const v = Math.max(0, Math.min(Number(axes[i].ratio || 0), 1));
        const rr = r * v;
        const x = cx + rr * Math.cos(ang);
        const y = cy + rr * Math.sin(ang);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Points
      ctx.fillStyle = point;
      for (let i = 0; i < n; i++) {
        const ang = start + i * step;
        const v = Math.max(0, Math.min(Number(axes[i].ratio || 0), 1));
        const rr = r * v;
        const x = cx + rr * Math.cos(ang);
        const y = cy + rr * Math.sin(ang);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Labels (codes)
      ctx.fillStyle = label;
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      for (let i = 0; i < n; i++) {
        const ang = start + i * step;
        const x = cx + (r + 14) * Math.cos(ang);
        const y = cy + (r + 14) * Math.sin(ang);

        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        ctx.textAlign = (cos >= 0.2) ? "left" : (cos <= -0.2 ? "right" : "center");
        ctx.textBaseline = (sin >= 0.2) ? "top" : (sin <= -0.2 ? "bottom" : "middle");

        const lbl = String(axes[i].code || "").trim() || String(i + 1);
        ctx.fillText(lbl, x, y);
      }
    }

    let _matchRadarView = "comp"; // "comp" | "domain"

    function renderRadarNow() {
      // Tab radar doit être visible
      if (tabRadar && tabRadar.style.display === "none") return;

      if (_matchRadarView === "domain") {
        if (domainEmpty) return;
        const canvas = byId("matchDomainRadarCanvas");
        if (!canvas) return;
        drawRadarChart(canvas, domainAxesRadar);
        return;
      }

      if (radarEmpty) return;
      const canvas = byId("matchPersonRadarCanvas");
      if (!canvas) return;
      drawRadarChart(canvas, radarTop);
    }

  // ------------------------------------------------------
    // Onglets (Détail / Radar) + rendu radar
    // ------------------------------------------------------
    const btnTabTable = byId("btnMatchTabTable");
    const btnTabRadar = byId("btnMatchTabRadar");
    const tabTable = byId("matchPersonTabTable");
    const tabRadar = byId("matchPersonTabRadar");


  // Sous-onglets Radar (Compétence / Domaine)
  const btnRadarComp = byId("btnMatchRadarViewComp");
  const btnRadarDomain = byId("btnMatchRadarViewDomain");
  const radarViewComp = byId("matchRadarViewComp");
  const radarViewDomain = byId("matchRadarViewDomain");

  function setRadarView(which) {
  const isDom = (which === "domain");
  _matchRadarView = isDom ? "domain" : "comp";

  if (radarViewComp) radarViewComp.style.display = isDom ? "none" : "";
  if (radarViewDomain) radarViewDomain.style.display = isDom ? "" : "none";

  if (btnRadarComp) {
    btnRadarComp.classList.add("sb-seg", "sb-seg--dark");
    btnRadarComp.classList.toggle("is-active", !isDom);
  }
  if (btnRadarDomain) {
    btnRadarDomain.classList.add("sb-seg", "sb-seg--dark");
    btnRadarDomain.classList.toggle("is-active", isDom);
  }
  }

  function setActiveTab(which) {
  const isRadar = (which === "radar");
  if (tabTable) tabTable.style.display = isRadar ? "none" : "";
  if (tabRadar) tabRadar.style.display = isRadar ? "" : "none";

  if (btnTabTable) {
    btnTabTable.classList.add("sb-seg", "sb-seg--dark");
    btnTabTable.classList.toggle("is-active", !isRadar);
  }
  if (btnTabRadar) {
    btnTabRadar.classList.add("sb-seg", "sb-seg--dark");
    btnTabRadar.classList.toggle("is-active", isRadar);
  }
  }

    
  // Init radar view (compétence)
  setRadarView("comp");
  if (btnRadarComp) btnRadarComp.addEventListener("click", () => { setRadarView("comp"); setTimeout(renderRadarNow, 0); });
  if (btnRadarDomain) btnRadarDomain.addEventListener("click", () => { setRadarView("domain"); setTimeout(renderRadarNow, 0); });

  // Bind tabs
    if (btnTabTable) btnTabTable.addEventListener("click", () => setActiveTab("table"));
    if (btnTabRadar) btnTabRadar.addEventListener("click", () => {
      setActiveTab("radar");
      // rendu après affichage
      setTimeout(renderRadarNow, 0);
    });

    // Défaut: onglet tableau
    setActiveTab("table");

    // ResizeObserver (redraw radar si visible)
    const modal = byId("modalMatchPerson");
    if (modal) {
      if (modal.__matchRadarObs) {
        try { modal.__matchRadarObs.disconnect(); } catch (e) { }
        modal.__matchRadarObs = null;
      }

      if ((!radarEmpty || !domainEmpty) && typeof ResizeObserver !== "undefined") {
  const obs = new ResizeObserver(() => {
    if (tabRadar && tabRadar.style.display !== "none") renderRadarNow();
  });
  if (tabRadar) obs.observe(tabRadar);
  modal.__matchRadarObs = obs;
  }
    }
   }

  async function showMatchPersonDetailModal(portal, id_poste, id_effectif, id_service) {
    openMatchPersonModal("Détail matching");

    try {
      const data = await fetchMatchingEffectifDetail(portal, id_poste, id_effectif, id_service);

      const poste = data?.poste || {};
      const person = data?.person || {};
      const title = `${person.full || "Personne"} — ${poste.codif_poste ? poste.codif_poste + " — " : ""}${poste.intitule_poste || "Poste"}`.trim();

      const t = byId("matchPersonModalTitle");
      if (t) t.textContent = title;

      renderMatchPersonDetail(data);
    } catch (e) {
      const host = byId("matchPersonModalBody");
      if (host) host.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0; color:#991b1b;">Erreur : ${escapeHtml(e.message || "inconnue")}</div></div>`;
    }
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
        ? `border-color:var(--reading-accent); background:color-mix(in srgb, var(--reading-accent) 8%, #fff);`
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

  const ide = String(c.id_effectif || "").trim();

  return `
    <tr class="match-person-row" data-match-id_effectif="${escapeHtml(ide)}" style="cursor:pointer;">
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
    <div class="modal" id="modalAnalyseCompetence" aria-hidden="true" style="align-items:flex-start;">
      <div class="modal-card" style="max-width:1120px; width:min(1120px, 96vw); margin-top:24px; max-height:calc(100vh - 48px); display:flex; flex-direction:column;">
        <div class="modal-header">
          <div style="min-width:0;">
            <div style="font-weight:600;" id="analyseCompModalTitle">Détail compétence</div>
            <div class="card-sub" id="analyseCompModalSub" style="margin:2px 0 0 0;"></div>
          </div>
          <button type="button" class="modal-x" id="btnCloseAnalyseCompModal" aria-label="Fermer">×</button>
        </div>

        <div class="modal-body" id="analyseCompModalBody" style="overflow:auto; flex:1; padding:14px 16px;">
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn-secondary" id="btnAnalyseCompModalClose" style="margin-left:0;">Fermer</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", html);
  modal = byId("modalAnalyseCompetence");

  if (modal && modal.getAttribute("data-bound") !== "1") {
    modal.setAttribute("data-bound", "1");

    const btnX = byId("btnCloseAnalyseCompModal");
    const btnClose = byId("btnAnalyseCompModalClose");

    if (btnX) btnX.addEventListener("click", () => closeAnalyseCompetenceModal());
    if (btnClose) btnClose.addEventListener("click", () => closeAnalyseCompetenceModal());

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeAnalyseCompetenceModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAnalyseCompetenceModal();
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

    if (typeof setActiveMatchKpi === "function") setActiveMatchKpi(getMatchView());

    const id_service = (byId("analyseServiceSelect")?.value || "").trim();
    body.innerHTML = renderMatchingShell();

    if (!_portalref) {
      const host = byId("matchResult");
      if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Contexte portail indisponible.</div>`;
      return;
    }

    const mySeq = ++_matchReqSeq;

    (async () => {
      try {
        const postes = await fetchMatchingPostes(_portalref, id_service);
        if (mySeq !== _matchReqSeq) return;

        if (_matchSelectedPoste && !postes.some(p => (p.id_poste || "").toString().trim() === _matchSelectedPoste)) {
          _matchSelectedPoste = "";
        }

        if (!_matchSelectedPoste && postes.length) {
          _matchSelectedPoste = (postes[0].id_poste || "").toString().trim();
        }

        renderMatchingPosteList(postes, _matchSelectedPoste);

        if (_matchSelectedPoste) {
          await showMatchingForPoste(_portalref, _matchSelectedPoste, id_service, mySeq);
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

    const horizon = getPrevHorizon();
    const item = _prevData ? pickPrevHorizonItem(_prevData, horizon) : null;

    const sorties = item ? item.sorties : (_prevData ? _prevData.sorties_12m : "—");
    const selectedKpi = (localStorage.getItem("sb_analyse_prev_kpi") || "").trim();

    if (typeof setActivePrevKpi === "function") setActivePrevKpi(selectedKpi || "");

    if (selectedKpi === "sorties") {
      const horizonLabel = (horizon === 1 ? "1 an" : (horizon + " ans"));
      if (sub) sub.textContent = `Sorties prévues à moins de ${horizonLabel} (périmètre filtré).`;

      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">
            Sorties &lt; ${escapeHtml(horizonLabel)}
          </div>

          <div class="row" style="gap:12px; margin-top:10px; flex-wrap:wrap;">
            <div class="card" style="padding:12px; margin:0; flex:1; min-width:200px;">
              <div class="label">Nombre de sorties</div>
              <div class="value">${escapeHtml(String(sorties ?? "—"))}</div>
            </div>
          </div>

          <div class="card" style="padding:12px; margin-top:12px;">
            <div class="card-title" style="margin-bottom:6px;">Détail</div>
            <div id="prevSortiesDetailBox" class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>
      `;

      window.__sbPrevSortiesReqId = (window.__sbPrevSortiesReqId || 0) + 1;
      const reqId = window.__sbPrevSortiesReqId;

      setTimeout(async () => {
        const box = byId("prevSortiesDetailBox");
        if (!box) return;

        try {
          const id_service = (byId("analyseServiceSelect")?.value || "").trim();

          if (!_portalref) {
            box.textContent = "Contexte portail indisponible (_portalref manquant).";
            return;
          }

          box.textContent = "Chargement…";
          const data = await fetchPrevisionsSortiesDetail(_portalref, horizon, id_service);

          if ((window.__sbPrevSortiesReqId || 0) !== reqId) return;

          const items =
            (data && Array.isArray(data.items) ? data.items : null) ||
            (data && Array.isArray(data.effectifs) ? data.effectifs : null) ||
            [];

          if (!items.length) {
            box.textContent = "Aucune sortie détectée dans l’horizon sélectionné.";
            return;
          }

          const rowsHtml = items.map((it) => {
            const prenom = (it.prenom_effectif || it.prenom || "").trim();
            const nom = (it.nom_effectif || it.nom || "").trim();
            const full = (it.full || `${prenom} ${nom}`.trim() || "—");
            const fullHtml = `<span style="font-weight:700; font-size:13px;">${escapeHtml(full)}</span>`;

            function fmtDateFR(v) {
              const s = (v || "").toString().trim();
              if (!s) return "—";
              // attend "YYYY-MM-DD" ou "YYYY-MM-DDTHH:MM:SS"
              const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
              if (!m) return escapeHtml(s); // fallback si format inattendu
              return `${m[3]}-${m[2]}-${m[1]}`;
            }

            const exitDate = (it.exit_date || it.date_sortie || it.date_sortie_prevue || it.sortie_prevue || "").toString();
            const exitTxt = fmtDateFR(exitDate);

            const service = (it.nom_service || it.service || "").toString().trim() || "—";
            const poste = (it.intitule_poste || it.poste || "").toString().trim() || "—";

            const hdf = (it.havedatefin === true || it.havedatefin === "true" || it.havedatefin === 1);
            const motif = (it.motif_sortie || "").toString().trim();

            // Raison de la sortie (tes règles)
            const reason = hdf ? motif : "Retraite estimée";
            const reasonTxt = reason ? escapeHtml(reason) : "—";

            const idEff = (it.id_effectif || "").toString().trim();
            const idPoste = (it.id_poste_actuel || "").toString().trim();

            return `
              <tr class="prev-sortie-row"
                  data-id_effectif="${escapeHtml(idEff)}"
                  data-id_poste_actuel="${escapeHtml(idPoste)}"
                  data-exit_date="${escapeHtml(exitDate)}"
                  data-reason="${escapeHtml(reason)}"
                  style="cursor:pointer;">
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${fullHtml}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${exitTxt}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(poste)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(service)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${reasonTxt}</td>
              </tr>
            `;
          }).join("");

          box.innerHTML = `
            <div style="overflow:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Personne</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Date sortie</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Poste</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Service</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Raison de la sortie</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          `;
        } catch (e) {
          if ((window.__sbPrevSortiesReqId || 0) !== reqId) return;
          box.textContent = `Erreur chargement détail sorties: ${e?.message || e}`;
        }
      }, 0);

      return;
    }

    if (selectedKpi === "critiques") {
      const horizonLabel = (horizon === 1 ? "1 an" : (horizon + " ans"));
      if (sub) sub.textContent = `Compétences critiques impactées à moins de ${horizonLabel} (périmètre filtré).`;

      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">
            Critiques impactées &lt; ${escapeHtml(horizonLabel)}
          </div>

          <div class="card" style="padding:12px; margin-top:12px;">
            <div class="card-title" style="margin-bottom:6px;">Détail</div>
            <div id="prevCritDetailBox" class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>
      `;

      window.__sbPrevCritReqId = (window.__sbPrevCritReqId || 0) + 1;
      const reqId = window.__sbPrevCritReqId;

      setTimeout(async () => {
        const box = byId("prevCritDetailBox");
        if (!box) return;

        try {
          const id_service = (byId("analyseServiceSelect")?.value || "").trim();

          if (!_portalref) {
            box.textContent = "Contexte portail indisponible (_portalref manquant).";
            return;
          }

          if (typeof fetchPrevisionsCritiquesDetail !== "function") {
            box.textContent = "Détail critiques non branché (fetchPrevisionsCritiquesDetail manquante).";
            return;
          }

          function fmtDateFR(v) {
            const s = (v || "").toString().trim();
            if (!s) return "—";
            const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (!m) return escapeHtml(s);
            return `${m[3]}-${m[2]}-${m[1]}`;
          }

          function renderDomainPill(it) {
            const lab = (it?.domaine_titre_court || it?.domaine_titre || it?.id_domaine_competence || "—").toString();
            const col = (typeof normalizeColor === "function" ? normalizeColor(it?.domaine_couleur) : null) || "#e5e7eb";
            return `
              <span style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid #d1d5db; border-radius:999px; font-size:12px; color:#374151; background:#fff;">
                <span style="display:inline-block; width:10px; height:10px; border-radius:999px; border:1px solid #d1d5db; background:${escapeHtml(col)};"></span>
                <span title="${escapeHtml(lab)}">${escapeHtml(lab)}</span>
              </span>
            `;
          }

          box.textContent = "Chargement…";
          const data = await fetchPrevisionsCritiquesDetail(_portalref, horizon, id_service);

          if ((window.__sbPrevCritReqId || 0) !== reqId) return;

          const items = Array.isArray(data?.items) ? data.items : [];
          if (!items.length) {
            box.textContent = "Aucune compétence critique impactée dans l’horizon sélectionné.";
            return;
          }

          const rowsHtml = items.map((it) => {
            const code = (it.code || "—").toString().trim();
            const intit = (it.intitule || it.intitule_competence || "—").toString();

            const compKey = (it.id_competence || it.id_comp || it.id_competence_skillboard || it.id_competence_pk || code || "").toString().trim();

            const nbPostes = Number(it.nb_postes_impactes ?? it.nb_postes ?? 0);
            const crit = Number(it.max_criticite ?? it.criticite ?? 0);
            const now = Number(it.nb_porteurs_now ?? it.nb_porteurs ?? 0);
            const sortants = Number(it.nb_porteurs_sortants ?? it.nb_sortants ?? 0);

            const lastExit = (it.last_exit_date || it.derniere_sortie || it.exit_date || "").toString();
            const lastExitTxt = fmtDateFR(lastExit);

            return `
              <tr class="prev-crit-row" data-comp-key="${escapeHtml(compKey)}" style="cursor:pointer;">
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${renderDomainPill(it)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; font-weight:700; white-space:nowrap;">${escapeHtml(code)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(intit)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center;">${escapeHtml(String(nbPostes))}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center;">${crit ? escapeHtml(String(crit)) : "—"}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center;">${escapeHtml(String(now))}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center;">${escapeHtml(String(sortants))}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${lastExitTxt}</td>
              </tr>
            `;
          }).join("");

          box.innerHTML = `
            <div style="overflow:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:220px;">Domaine</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:90px;">Code</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Compétence</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:110px;">Postes</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:90px;">Crit.</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:120px;">Porteurs</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:120px;">Sortants</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:130px;">Dernière sortie</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          `;
        } catch (e) {
          if ((window.__sbPrevCritReqId || 0) !== reqId) return;
          box.textContent = `Erreur chargement détail critiques: ${e?.message || e}`;
        }
      }, 0);

      return;
    }



    if (sub) sub.textContent = "Cliquez sur un KPI dans la tuile Prévisions pour afficher le détail.";
    body.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Résultats</div>
        <div class="card-sub" style="margin:0;">Aucune vue sélectionnée.</div>
      </div>
    `;
    return;
  }

  // -----------------------
  // RISQUES (API + filtre KPI)
  // -----------------------
  const rf = getRiskFilter(); // "", "postes-fragiles", "critiques-sans-porteur", "porteur-unique"
  if (typeof setActiveRiskKpi === "function") setActiveRiskKpi(rf);

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
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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

              const idComp = (r.id_competence || r.id_comp || r.id_competence_skillboard || r.id_competence_pk || "").toString().trim();
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

  const resetHtml = rf
    ? `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${badge(filterLabel, true)}
          ${badge("Criticité min: " + CRITICITE_MIN, false)}
        </div>
        <button type="button" class="btn-secondary" id="btnRiskFilterReset" style="margin-left:0;">
          Tout afficher
        </button>
      </div>
    `
    : `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
        ${badge("Vue globale", true)}
        ${badge("Criticité min: " + CRITICITE_MIN, false)}
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

  if (!_portalref) {
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
        const data = await fetchRisquesDetail(_portalref, rf, id_service, 120);
        if (mySeq !== _riskDetailReqSeq) return;

        const items = Array.isArray(data?.items) ? data.items : [];

        const content = `
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

      const [a, b, c] = await Promise.all([
        fetchRisquesDetail(_portalref, "postes-fragiles", id_service, 20),
        fetchRisquesDetail(_portalref, "critiques-sans-porteur", id_service, 20),
        fetchRisquesDetail(_portalref, "porteur-unique", id_service, 20),
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
      applyPrevisionsKpis(p);

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

  // =====================================================
  // MODAL - Prévisions / Critiques impactées (détail)
  // HTML IDs attendus : modalAnalysePrevCrit, btnCloseAnalysePrevCritModal, btnAnalysePrevCritModalClose, etc.
  // =====================================================

  function openAnalysePrevCritModal() {
    const m = byId("modalAnalysePrevCrit");
    if (!m) return;
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");
  }

  function closeAnalysePrevCritModal() {
    const m = byId("modalAnalysePrevCrit");
    if (!m) return;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  function setAnalysePrevCritTab(tabKey) {
    const btnSynth = byId("tabPrevCritSynthese");
    const btnRest = byId("tabPrevCritRestants");
    const btnOut = byId("tabPrevCritSortants");
    const btnPostes = byId("tabPrevCritPostes");

    const paneSynth = byId("analysePrevCritTabSynthese");
    const paneRest = byId("analysePrevCritTabRestants");
    const paneOut = byId("analysePrevCritTabSortants");
    const panePostes = byId("analysePrevCritTabPostes");

    const map = {
      synthese: { btn: btnSynth, pane: paneSynth },
      restants: { btn: btnRest, pane: paneRest },
      sortants: { btn: btnOut, pane: paneOut },
      postes: { btn: btnPostes, pane: panePostes },
    };

    // reset
    Object.values(map).forEach(x => {
      if (x.btn) x.btn.classList.remove("is-active");
      if (x.pane) x.pane.style.display = "none";
    });

    const cur = map[tabKey] || map.synthese;
    if (cur.btn) cur.btn.classList.add("is-active");
    if (cur.pane) cur.pane.style.display = "";
  }

  function fmtDateFR(v) {
    const s = (v || "").toString().trim();
    if (!s) return "—";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(s);
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function renderLevelBar(a, b, c) {
    const A = Number(a || 0);
    const B = Number(b || 0);
    const C = Number(c || 0);
    const tot = Math.max(0, A + B + C);

    const pct = (x) => (tot ? Math.round((x / tot) * 100) : 0);

    const elA = byId("prevCritLevelBarA");
    const elB = byId("prevCritLevelBarB");
    const elC = byId("prevCritLevelBarC");
    const legend = byId("prevCritLevelBarLegend");

    if (elA) elA.style.width = pct(A) + "%";
    if (elB) elB.style.width = pct(B) + "%";
    if (elC) elC.style.width = pct(C) + "%";
    if (legend) legend.textContent = `A: ${A} • B: ${B} • C: ${C}`;
  }

  function safeDomainPill(it) {
    const lab = (it?.domaine_titre_court || it?.domaine_titre || it?.id_domaine_competence || "—").toString();
    const col = normalizeColor(it?.domaine_couleur) || "#e5e7eb";
    return `
      <span style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid #d1d5db; border-radius:999px; font-size:12px; color:#374151; background:#fff;">
        <span style="display:inline-block; width:10px; height:10px; border-radius:999px; border:1px solid #d1d5db; background:${escapeHtml(col)};"></span>
        <span title="${escapeHtml(lab)}">${escapeHtml(lab)}</span>
      </span>
    `;
  }

  // Endpoint attendu (tu le coderas côté API ensuite) :
  // GET /skills/analyse/previsions/critiques/modal/{id_contact}?comp_key=...&horizon_years=...&id_service=...
  async function fetchPrevisionsCritiquesModal(portal, compKey, horizonYears, id_service) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable (UI)");
    if (!ctx.apiBase) throw new Error("apiBase introuvable (UI)");

    const qs = new URLSearchParams();
    qs.set("comp_key", String(compKey || ""));
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service));
    qs.set("limit", "500");

    const url = `${ctx.apiBase}/skills/analyse/previsions/critiques/modal/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;

    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${txt ? " - " + txt : ""}`);
    }
    return await res.json();
  }


  async function showAnalysePrevCritModal(portal, compKey, id_service) {
    // ouverture + placeholders
    openAnalysePrevCritModal();
    setAnalysePrevCritTab("synthese");

    const horizon = getPrevHorizon();
    const scope = getScopeLabel();

    const title = byId("analysePrevCritModalTitle");
    const sub = byId("analysePrevCritModalSub");

    const bSvc = byId("analysePrevCritBadgeService");
    const bHor = byId("analysePrevCritBadgeHorizon");
    const bCrit = byId("analysePrevCritBadgeCriticite");

    if (title) title.textContent = "Détail compétence";
    if (sub) sub.textContent = "Chargement…";

    if (bSvc) bSvc.textContent = `Service : ${scope || "—"}`;
    if (bHor) bHor.textContent = `Horizon : ${horizon} an${horizon > 1 ? "s" : ""}`;
    if (bCrit) bCrit.textContent = `Criticité : —`;

    const kNow = byId("prevCritKpiNow");
    const kOut = byId("prevCritKpiOut");
    const kRemain = byId("prevCritKpiRemain");
    const kPostes = byId("prevCritKpiPostes");
    const kNext = byId("prevCritKpiNextExit");

    if (kNow) kNow.textContent = "—";
    if (kOut) kOut.textContent = "—";
    if (kRemain) kRemain.textContent = "—";
    if (kPostes) kPostes.textContent = "—";
    if (kNext) kNext.textContent = "—";
    renderLevelBar(0, 0, 0);

    const paneSynth = byId("analysePrevCritTabSynthese");
    const paneRest = byId("analysePrevCritTabRestants");
    const paneOut = byId("analysePrevCritTabSortants");
    const panePostes = byId("analysePrevCritTabPostes");

    if (paneSynth) paneSynth.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    if (paneRest) paneRest.innerHTML = "";
    if (paneOut) paneOut.innerHTML = "";
    if (panePostes) panePostes.innerHTML = "";

    // anti “réponses qui se croisent”
    window.__sbPrevCritModalReqId = (window.__sbPrevCritModalReqId || 0) + 1;
    const reqId = window.__sbPrevCritModalReqId;

    try {
      const data = await fetchPrevisionsCritiquesModal(portal, compKey, horizon, id_service);
      if ((window.__sbPrevCritModalReqId || 0) !== reqId) return;

      const comp = data?.competence || data?.comp || data || {};
      const code = (comp.code || comp.code_competence || "").toString().trim();
      const intit = (comp.intitule || comp.intitule_competence || comp.libelle || "").toString().trim();
      const domPill = safeDomainPill(comp);

      const criticite = Number(data?.criticite_max ?? data?.max_criticite ?? comp?.max_criticite ?? 0) || 0;
      if (bCrit) bCrit.textContent = `Criticité : ${criticite || "—"}`;

      if (title) title.textContent = `${code ? code + " — " : ""}${intit || "Compétence"}`;
      if (sub) sub.textContent = `Impact prévisionnel (horizon ${horizon} an${horizon > 1 ? "s" : ""})`;

      // KPIs (tolérants sur les noms)
      const now = Number(data?.kpi?.porteurs_now ?? data?.nb_porteurs_now ?? data?.porteurs_now ?? 0);
      const out = Number(data?.kpi?.porteurs_sortants ?? data?.nb_porteurs_sortants ?? data?.sortants ?? 0);
      const remain = Number(data?.kpi?.porteurs_restants ?? data?.nb_porteurs_restants ?? (now - out));
      const postesImpact = Number(data?.kpi?.nb_postes_impactes ?? data?.nb_postes_impactes ?? 0);

      const nextExit = data?.kpi?.next_exit_date || data?.next_exit_date || "";

      if (kNow) kNow.textContent = String(now || 0);
      if (kOut) kOut.textContent = String(out || 0);
      if (kRemain) kRemain.textContent = String(remain || 0);
      if (kPostes) kPostes.textContent = String(postesImpact || 0);
      if (kNext) kNext.textContent = nextExit ? fmtDateFR(nextExit) : "—";

      // niveaux A/B/C (restants)
      const lev = data?.levels || data?.niveaux || {};
      renderLevelBar(lev.A ?? lev.a, lev.B ?? lev.b, lev.C ?? lev.c);

      // tableaux
      const restants = Array.isArray(data?.restants) ? data.restants : (Array.isArray(data?.porteurs_restants) ? data.porteurs_restants : []);
      const sortants = Array.isArray(data?.sortants) ? data.sortants : (Array.isArray(data?.porteurs_sortants) ? data.porteurs_sortants : []);
      const postes = Array.isArray(data?.postes) ? data.postes : (Array.isArray(data?.postes_impactes) ? data.postes_impactes : []);

      // Synthèse
      if (paneSynth) {
        paneSynth.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Contexte</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              ${domPill}
              <span class="sb-badge">Criticité : ${escapeHtml(String(criticite || "—"))}</span>
              <span class="sb-badge">Postes impactés : ${escapeHtml(String(postesImpact || 0))}</span>
            </div>

            <div class="card-sub" style="margin-top:10px;">
              <b>Lecture RH:</b> pertes prévues de porteurs sur une compétence critique, à horizon ${escapeHtml(String(horizon))} an${horizon > 1 ? "s" : ""}.
              L’objectif est de décider: transfert de savoir, formation ciblée, mobilité, recrutement.
            </div>
          </div>
        `;
      }

      // Restants
      if (paneRest) {
        if (!restants.length) {
          paneRest.innerHTML = `<div class="card-sub" style="margin:0;">Aucun porteur restant.</div>`;
        } else {
          const rows = restants.map(r => {
            const full = (r.full || `${(r.prenom || r.prenom_effectif || "").trim()} ${(r.nom || r.nom_effectif || "").trim()}`.trim() || "—");
            const niv = (r.niveau || r.level || r.niv || "—").toString().trim();
            const poste = (r.intitule_poste || r.poste || "—").toString().trim();
            const svc = (r.nom_service || r.service || "—").toString().trim();
            return `
              <tr>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;"><span style="font-weight:700;">${escapeHtml(full)}</span></td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center; font-weight:800;">${escapeHtml(niv)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(poste)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(svc)}</td>
              </tr>
            `;
          }).join("");

          paneRest.innerHTML = `
            <div style="overflow:auto;">
              <table class="sb-table" style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Personne</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:80px;">Niveau</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Poste</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:200px;">Service</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
        }
      }

      // Sortants
      if (paneOut) {
        if (!sortants.length) {
          paneOut.innerHTML = `<div class="card-sub" style="margin:0;">Aucun sortant dans l’horizon.</div>`;
        } else {
          const rows = sortants.map(r => {
            const full = (r.full || `${(r.prenom || r.prenom_effectif || "").trim()} ${(r.nom || r.nom_effectif || "").trim()}`.trim() || "—");
            const exitDate = r.exit_date || r.date_sortie || r.date_sortie_prevue || "";
            const reason = (r.reason || r.raison || r.exit_source || r.motif_sortie || "").toString().trim() || "—";
            const poste = (r.intitule_poste || r.poste || "—").toString().trim();
            const svc = (r.nom_service || r.service || "—").toString().trim();

            return `
              <tr>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;"><span style="font-weight:700;">${escapeHtml(full)}</span></td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${fmtDateFR(exitDate)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(poste)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(svc)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(reason)}</td>
              </tr>
            `;
          }).join("");

          paneOut.innerHTML = `
            <div style="overflow:auto;">
              <table class="sb-table" style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Personne</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:120px;">Date sortie</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Poste</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:200px;">Service</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:220px;">Raison</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
        }
      }

      // Postes impactés
      if (panePostes) {
        if (!postes.length) {
          panePostes.innerHTML = `<div class="card-sub" style="margin:0;">Aucun poste impacté (données indisponibles).</div>`;
        } else {
          const rows = postes.map(r => {
            const poste = (r.intitule_poste || r.poste || "—").toString().trim();
            const svc = (r.nom_service || r.service || "—").toString().trim();
            const niv = (r.niveau_attendu || r.level_expected || r.niveau || "—").toString().trim();
            const crit = Number(r.criticite || r.max_criticite || 0) || "—";
            return `
              <tr>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;"><span style="font-weight:700;">${escapeHtml(poste)}</span></td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb;">${escapeHtml(svc)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center; font-weight:800;">${escapeHtml(niv)}</td>
                <td style="padding:6px 8px; border-top:1px solid #e5e7eb; text-align:center;">${escapeHtml(String(crit))}</td>
              </tr>
            `;
          }).join("");

          panePostes.innerHTML = `
            <div style="overflow:auto;">
              <table class="sb-table" style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                  <tr>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb;">Poste</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:220px;">Service</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:120px;">Niv. attendu</th>
                    <th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e5e7eb; width:90px;">Crit.</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
        }
      }

    } catch (e) {
      if ((window.__sbPrevCritModalReqId || 0) !== reqId) return;
      if (sub) sub.textContent = `Erreur: ${e?.message || e}`;
      if (paneSynth) paneSynth.innerHTML = `<div class="card-sub" style="margin:0;">Impossible de charger le détail.</div>`;
    }
  }


function bindOnce(portal) {
  if (_bound) return;
  _bound = true;

  // garde une ref globale (ton code s’appuie dessus partout)
  _portalref = portal || _portalref;

  const selService = byId("analyseServiceSelect");
  const btnReset = byId("btnAnalyseReset");

  // Slider Prévisions (1..5 ans) - met à jour les KPI de la tuile en direct
  const prevSlider = byId("prevHorizonSlider");
  if (prevSlider) {
    const initH = getPrevHorizon();
    prevSlider.value = String(initH);
    setPrevHorizonLabel(initH);

    // Empêche de déclencher le click sur la tuile quand on manipule le slider
    const stop = (ev) => { ev.stopPropagation(); };
    ["pointerdown", "mousedown", "click", "keydown"].forEach(evt => prevSlider.addEventListener(evt, stop));

    prevSlider.addEventListener("input", (ev) => {
      ev.stopPropagation();
      const n = setPrevHorizon(prevSlider.value);
      prevSlider.value = String(n);
      setPrevHorizonLabel(n);

      if (_prevData) applyPrevisionsKpis(_prevData);

      const curMode = (localStorage.getItem(STORE_MODE) || "").trim();
      if (curMode === "previsions") renderDetail("previsions");
    });
  }

  // --- tuiles
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
      setMode("risques");
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

      // empêche click sur tuile
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }

      setMatchView(v);

      const curMode = (localStorage.getItem(STORE_MODE) || "").trim();
      if (curMode !== "matching") {
        setMode("matching");
        return;
      }
      renderDetail("matching");
    }

    matchKpis.forEach((el) => {
      el.addEventListener("click", (ev) => openMatchView(el, ev));
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") openMatchView(el, ev);
      });
    });
  }

  // KPI Prévisions cliquables => sélection + bascule mode Prévisions
  const tilePrevisions = byId("tilePrevisions");
  if (tilePrevisions) {
    const prevKpis = tilePrevisions.querySelectorAll(".mini-kpi[data-prev-kpi]");

    function openPrevKpi(el, ev) {
      const key = (el?.getAttribute("data-prev-kpi") || "").trim();
      if (!key) return;

      if (ev) { ev.preventDefault(); ev.stopPropagation(); }

      localStorage.setItem("sb_analyse_prev_kpi", key);
      setActivePrevKpi(key);
      setMode("previsions");
    }

    prevKpis.forEach((el) => {
      el.addEventListener("click", (ev) => openPrevKpi(el, ev));
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") openPrevKpi(el, ev);
      });
    });
  }

  // Filtres service / reset
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

  if (btnXPoste) btnXPoste.addEventListener("click", closeAnalysePosteModal);
  if (btnClosePoste) btnClosePoste.addEventListener("click", closeAnalysePosteModal);

  if (modalPoste) {
    modalPoste.addEventListener("click", (e) => {
      if (e.target === modalPoste) closeAnalysePosteModal();
    });
  }

  if (tabA) tabA.addEventListener("click", () => setAnalysePosteTab("competences"));
  if (tabB) tabB.addEventListener("click", () => setAnalysePosteTab("couverture"));

  // ==============================
  // Modal Prévisions Critiques - wiring
  // ==============================
  const modalPrevCrit = byId("modalAnalysePrevCrit");
  const btnXPrevCrit = byId("btnCloseAnalysePrevCritModal");
  const btnClosePrevCrit = byId("btnAnalysePrevCritModalClose");

  if (btnXPrevCrit) btnXPrevCrit.addEventListener("click", closeAnalysePrevCritModal);
  if (btnClosePrevCrit) btnClosePrevCrit.addEventListener("click", closeAnalysePrevCritModal);

  if (modalPrevCrit) {
    modalPrevCrit.addEventListener("click", (e) => {
      if (e.target === modalPrevCrit) closeAnalysePrevCritModal();
    });
  }

  // Onglets modal PrevCrit
  const btnSynth = byId("tabPrevCritSynthese");
  const btnRest = byId("tabPrevCritRestants");
  const btnOut = byId("tabPrevCritSortants");
  const btnPostes = byId("tabPrevCritPostes");

  if (btnSynth) btnSynth.addEventListener("click", () => setAnalysePrevCritTab("synthese"));
  if (btnRest) btnRest.addEventListener("click", () => setAnalysePrevCritTab("restants"));
  if (btnOut) btnOut.addEventListener("click", () => setAnalysePrevCritTab("sortants"));
  if (btnPostes) btnPostes.addEventListener("click", () => setAnalysePrevCritTab("postes"));

  // ESC ferme le PrevCrit modal (sans flinguer le reste)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = byId("modalAnalysePrevCrit");
    if (m && m.classList.contains("show")) closeAnalysePrevCritModal();
  });

  // ==============================
  // Click délégué global (survit aux rerender)
  // ==============================
  const analyseBody = byId("analyseDetailBody");
  if (!analyseBody) return;

  analyseBody.addEventListener("click", async (ev) => {
    // 0) pas de portail => pas de drilldown
    const p = portal || _portalref;
    if (!p) return;

    const id_service = (byId("analyseServiceSelect")?.value || "").trim();

    // ------------------------------
    // 1) Click sur POSTE FRAGILE (table risques)
    // ------------------------------
    const trPoste = ev.target.closest("tr.risk-poste-row[data-id_poste]");
    if (trPoste) {
      const id_poste = (trPoste.getAttribute("data-id_poste") || "").trim();
      if (!id_poste) return;

      // focus selon la cellule cliquée
      const td = ev.target.closest("td[data-focus]");
      let focusKey = (td?.getAttribute("data-focus") || "").trim();
      if (focusKey === "poste") focusKey = ""; // clic sur libellé poste/service => focus normal

      try {
        await showAnalysePosteDetailModal(p, id_poste, id_service, focusKey);
      } catch (e) {
        // on laisse tes modals gérer leurs erreurs, pas de drama ici
      }
      return;
    }

    // ------------------------------
    // 2) Click sur COMPETENCE (table risques)
    // ------------------------------
    const trComp = ev.target.closest("tr.risk-comp-row[data-comp-key]");
    if (trComp) {
      const compKey = (trComp.getAttribute("data-comp-key") || "").trim();
      if (!compKey) return;
      showAnalyseCompetenceDetailModal(p, compKey, id_service);
      return;
    }

    // ------------------------------
    // 3) Click sur POSTE (liste matching gauche)
    // ------------------------------
    const btnPosteMatch = ev.target.closest("button[data-match-id_poste]");
    if (btnPosteMatch) {
      const id_poste = (btnPosteMatch.getAttribute("data-match-id_poste") || "").trim();
      if (!id_poste) return;

      _matchSelectedPoste = id_poste;

      // met à jour le style actif sans rerender complet
      document.querySelectorAll("#matchPosteList button[data-match-id_poste]").forEach(b => {
        const bid = (b.getAttribute("data-match-id_poste") || "").trim();
        const isActive = bid === _matchSelectedPoste;
        b.style.borderColor = isActive ? "var(--reading-accent)" : "#e5e7eb";
        b.style.background = isActive
          ? "color-mix(in srgb, var(--reading-accent) 8%, #fff)"
          : "#fff";
      });

      const mySeq = ++_matchReqSeq;
      try {
        await showMatchingForPoste(p, _matchSelectedPoste, id_service, mySeq);
      } catch (e) {
        const host = byId("matchResult");
        if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e?.message || "inconnue")}</div>`;
      }
      return;
    }

    // ------------------------------
    // 4) Click sur PERSONNE (table matching droite)
    // ------------------------------
    const trPerson = ev.target.closest("tr.match-person-row[data-match-id_effectif]");
    if (trPerson) {
      const id_effectif = (trPerson.getAttribute("data-match-id_effectif") || "").trim();
      if (!id_effectif) return;
      if (!_matchSelectedPoste) return; // pas de poste sélectionné => pas de drilldown cohérent
      showMatchPersonDetailModal(p, _matchSelectedPoste, id_effectif, id_service);
      return;
    }

    // ------------------------------
    // 5) Click sur SORTIE (prévisions sorties)
    // ------------------------------
    const trSortie = ev.target.closest("tr.prev-sortie-row[data-id_effectif]");
    if (trSortie) {
      const id_effectif = (trSortie.getAttribute("data-id_effectif") || "").trim();
      const id_poste_actuel = (trSortie.getAttribute("data-id_poste_actuel") || "").trim();
      if (!id_effectif || !id_poste_actuel) return;
      showMatchPersonDetailModal(p, id_poste_actuel, id_effectif, id_service);
      return;
    }

    // ------------------------------
    // 6) Click sur CRITIQUE IMPACTEE (prévisions critiques)
    // ------------------------------
    const trPrevCrit = ev.target.closest("tr.prev-crit-row[data-comp-key]");
    if (trPrevCrit) {
      const compKey = (trPrevCrit.getAttribute("data-comp-key") || "").trim();
      if (!compKey) return;
      showAnalysePrevCritModal(p, compKey, id_service);
      return;
    }
  });
}


  let _prevSortieModalEl = null;

  function showPrevSortieModal(portal, d) {
    // Nettoyage si déjà ouvert
    if (_prevSortieModalEl && _prevSortieModalEl.parentNode) {
      _prevSortieModalEl.parentNode.removeChild(_prevSortieModalEl);
    }

    const wrap = document.createElement("div");
    _prevSortieModalEl = wrap;

    wrap.innerHTML = `
      <div class="sb-modal-backdrop" style="
        position:fixed; inset:0; background:rgba(0,0,0,.35);
        display:flex; align-items:center; justify-content:center;
        z-index:9999; padding:18px;">
        <div class="card" style="
          width:min(900px, 96vw);
          max-height:88vh; overflow:auto;
          padding:14px; margin:0;">
          <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
            <div>
              <div class="card-title" style="margin:0;">Sortie prévue</div>
              <div class="card-sub" style="margin:2px 0 0 0;">Détail de la personne et actions rapides.</div>
            </div>
            <button type="button" class="btn-secondary" id="btnPrevCloseTop" style="margin-left:0;">Fermer</button>
          </div>

          <div class="card" style="padding:12px; margin-top:12px;">
            <div style="font-weight:800; font-size:14px; margin-bottom:6px;">${escapeHtml(d.full || "—")}</div>

            <div style="display:grid; grid-template-columns: 180px 1fr; gap:8px 12px; font-size:12px;">
              <div style="color:#6b7280;">Date de sortie</div><div>${escapeHtml(d.date_sortie || "—")}</div>
              <div style="color:#6b7280;">Poste</div><div>${escapeHtml(d.poste || "—")}</div>
              <div style="color:#6b7280;">Service</div><div>${escapeHtml(d.service || "—")}</div>
              <div style="color:#6b7280;">Raison</div><div>${escapeHtml(d.raison || "—")}</div>              
            </div>
          </div>

          <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; margin-top:12px;">
            <button type="button" class="btn-secondary" id="btnPrevGoRisques" ${d.id_poste_actuel ? "" : "disabled"}>
              Voir risques du poste
            </button>
            <button type="button" class="btn-secondary" id="btnPrevGoMatching" ${d.id_poste_actuel ? "" : "disabled"}>
              Voir matching du poste
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    const backdrop = wrap.querySelector(".sb-modal-backdrop");
    const btnCloseTop = wrap.querySelector("#btnPrevCloseTop");    
    const btnGoRisques = wrap.querySelector("#btnPrevGoRisques");
    const btnGoMatching = wrap.querySelector("#btnPrevGoMatching");

    function close() {
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (_prevSortieModalEl === wrap) _prevSortieModalEl = null;
      document.removeEventListener("keydown", onKey);
    }

    function onKey(e) {
      if (e.key === "Escape") close();
    }

    // clic backdrop (mais pas sur la carte)
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    btnCloseTop?.addEventListener("click", close);
    

    btnGoRisques?.addEventListener("click", async () => {
      const id_poste = (d.id_poste_actuel || "").trim();
      if (!id_poste) return;

      const id_service = (byId("analyseServiceSelect")?.value || "").trim();

      close();
      // Ouvre ton modal existant "poste detail"
      if (typeof showAnalysePosteDetailModal === "function") {
        await showAnalysePosteDetailModal(portal, id_poste, id_service, "");
      }
    });

    btnGoMatching?.addEventListener("click", () => {
      const id_poste = (d.id_poste_actuel || "").trim();
      if (!id_poste) return;

      close();

      _matchSelectedPoste = id_poste;

      // bascule mode matching (si setMode existe c'est le plus propre)
      if (typeof setMode === "function") setMode("matching");
      else localStorage.setItem(STORE_MODE, "matching");

      renderDetail("matching");
    });

    document.addEventListener("keydown", onKey);
  }

  // ======================================================
  // Modal Prévisions — "Critiques impactées" (détail)
  // ======================================================
  let _prevCritBound = false;
  let _prevCritReqId = 0;

  function _firstEl(...ids) {
    for (const id of ids) {
      const el = byId(id);
      if (el) return el;
    }
    return null;
  }

  function _openModal(modal) {
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function _closeModal(modal) {
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function _fmtDateFR(v) {
    const s = (v || "").toString().trim();
    if (!s) return "—";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(s);
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function _bindPrevCritModalOnce() {
    if (_prevCritBound) return;
    _prevCritBound = true;

    const modal = _firstEl("modalPrevCrit", "modalPrevCritDetail", "modalPrevisionsCritiques");
    if (!modal) return;

    const btnX = _firstEl("btnClosePrevCritModal", "btnClosePrevCritDetailModal");
    const btnClose = _firstEl("btnPrevCritModalClose", "btnPrevCritDetailModalClose");

    if (btnX) btnX.addEventListener("click", () => _closeModal(modal));
    if (btnClose) btnClose.addEventListener("click", () => _closeModal(modal));

    modal.addEventListener("click", (e) => {
      if (e.target === modal) _closeModal(modal);
    });

    const tabs = [
      { key: "synthese", btn: _firstEl("tabPrevCritSynthese"), pane: _firstEl("prevCritTabSynthese") },
      { key: "porteurs", btn: _firstEl("tabPrevCritPorteurs"), pane: _firstEl("prevCritTabPorteurs") },
      { key: "postes", btn: _firstEl("tabPrevCritPostes"), pane: _firstEl("prevCritTabPostes") },
      { key: "actions", btn: _firstEl("tabPrevCritActions"), pane: _firstEl("prevCritTabActions") },
    ].filter(x => x.btn && x.pane);

    function setTab(k) {
      tabs.forEach(t => {
        t.btn.classList.toggle("is-active", t.key === k);
        t.pane.style.display = (t.key === k) ? "" : "none";
      });
      localStorage.setItem("sb_prev_crit_tab", k);
    }

    tabs.forEach(t => {
      t.btn.addEventListener("click", () => setTab(t.key));
    });

    // tab par défaut
    const last = (localStorage.getItem("sb_prev_crit_tab") || "synthese").trim();
    setTab(tabs.some(t => t.key === last) ? last : "synthese");
  }

  async function _fetchPrevCritDetail(portal, compKey, horizon, id_service) {
    // contexte API (même logique tolérante que le reste)
    const portalCtx = portal || _portalref || null;

    const id_contact = String(
      portalCtx?.id_contact ||
      portalCtx?.idContact ||
      portalCtx?.getAttribute?.("data-id_contact") ||
      portalCtx?.getAttribute?.("data-id-contact") ||
      portalCtx?.dataset?.id_contact ||
      portalCtx?.dataset?.idContact ||
      ""
    ).trim();

    const apiBaseRaw = String(
      portalCtx?.api_base ||
      portalCtx?.apiBase ||
      portalCtx?.getAttribute?.("data-api-base") ||
      portalCtx?.dataset?.apiBase ||
      window.API_BASE ||
      window.SKILLS_API_BASE ||
      ""
    ).trim();

    const apiBase = apiBaseRaw.replace(/\/$/, "");

    if (!id_contact) throw new Error("id_contact introuvable");
    if (!apiBase) throw new Error("apiBase introuvable");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizon));
    if (id_service) qs.set("id_service", id_service);

    // Endpoint à brancher côté API (prochaine étape backend)
    const url = `${apiBase}/skills/analyse/previsions/critiques/detail/${encodeURIComponent(id_contact)}/${encodeURIComponent(compKey)}?${qs.toString()}`;

    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${txt ? " - " + txt : ""}`);
    }
    return await res.json();
  }

  async function showPrevCritDetailModal(portal, tr, compKey, horizon, id_service) {
    _bindPrevCritModalOnce();

    const modal = _firstEl("modalPrevCrit", "modalPrevCritDetail", "modalPrevisionsCritiques");
    const titleEl = _firstEl("prevCritModalTitle", "prevCritDetailModalTitle");
    const subEl = _firstEl("prevCritModalSub", "prevCritDetailModalSub");

    const paneSynth = _firstEl("prevCritTabSynthese");
    const panePorteurs = _firstEl("prevCritTabPorteurs");
    const panePostes = _firstEl("prevCritTabPostes");
    const paneActions = _firstEl("prevCritTabActions");

    if (!modal || !paneSynth || !panePorteurs || !panePostes || !paneActions) {
      portal?.showAlert?.("error", "Modal Critiques: IDs HTML non trouvés (vérifie les id=...)");
      return;
    }

    // Infos depuis la ligne (pas besoin d’attendre l’API pour afficher un truc propre)
    const tds = Array.from(tr.querySelectorAll("td"));
    const code = (tds[1]?.textContent || "").trim() || "—";
    const lib = (tds[2]?.textContent || "").trim() || "—";
    const nbPostes = _num((tds[3]?.textContent || "").trim());
    const criticite = _num((tds[4]?.textContent || "").trim());
    const porteursNow = _num((tds[5]?.textContent || "").trim());
    const sortants = _num((tds[6]?.textContent || "").trim());
    const lastExit = (tds[7]?.textContent || "").trim() || "—";

    const horizonLabel = (horizon === 1 ? "1 an" : `${horizon} ans`);
    if (titleEl) titleEl.textContent = `Critiques impactées — ${code}`;
    if (subEl) subEl.textContent = `${lib} • Horizon < ${horizonLabel}${id_service ? " • périmètre filtré" : ""}`;

    // Synthèse (immédiat)
    const restants = Math.max(0, porteursNow - sortants);

    paneSynth.innerHTML = `
      <div class="sb-modal-kpis">
        <div class="sb-metric"><div class="label">Postes impactés</div><div class="value">${escapeHtml(String(nbPostes))}</div></div>
        <div class="sb-metric"><div class="label">Criticité (max)</div><div class="value">${escapeHtml(String(criticite || "—"))}</div></div>
        <div class="sb-metric"><div class="label">Porteurs actuels</div><div class="value">${escapeHtml(String(porteursNow))}</div></div>
        <div class="sb-metric"><div class="label">Porteurs sortants</div><div class="value">${escapeHtml(String(sortants))}</div></div>
        <div class="sb-metric"><div class="label">Porteurs restants</div><div class="value">${escapeHtml(String(restants))}</div></div>
      </div>

      <div class="card" style="padding:12px; margin-top:12px;">
        <div class="card-title" style="margin-bottom:6px;">Signal</div>
        <div class="card-sub" style="margin:0;">
          Dernière sortie détectée: <b>${escapeHtml(lastExit)}</b><br/>
          Lecture: si <b>restants = 0</b> → rupture, si <b>restants = 1</b> → dépendance, sinon → tension à prioriser.
        </div>
      </div>
    `;

    // Les 3 autres tabs = chargement (API)
    panePorteurs.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    panePostes.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    paneActions.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

    _openModal(modal);

    // Requête unique (et annulable si reclique vite)
    _prevCritReqId = (_prevCritReqId || 0) + 1;
    const reqId = _prevCritReqId;

    try {
      const data = await _fetchPrevCritDetail(portal, compKey, horizon, id_service);
      if (_prevCritReqId !== reqId) return;

      // Attendu côté API (prochaine étape):
      // data.porteurs[], data.postes[], data.actions[]
      const porteurs = Array.isArray(data?.porteurs) ? data.porteurs : [];
      const postes = Array.isArray(data?.postes) ? data.postes : [];
      const actions = Array.isArray(data?.actions) ? data.actions : [];

      // Porteurs
      if (!porteurs.length) {
        panePorteurs.innerHTML = `<div class="card-sub" style="margin:0;">Aucun porteur retourné.</div>`;
      } else {
        const rows = porteurs.map(p => {
          const nom = (p.full || `${p.prenom || ""} ${p.nom || ""}`).trim() || "—";
          const lvl = (p.niveau || p.level || "—").toString();
          const posteP = (p.intitule_poste || p.poste || "—").toString();
          const svc = (p.nom_service || p.service || "—").toString();
          const exit = _fmtDateFR(p.exit_date || p.date_sortie || "");
          const reason = (p.reason || p.motif_sortie || p.exit_source || "—").toString();
          return `
            <tr>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;"><b>${escapeHtml(nom)}</b></td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${escapeHtml(lvl)}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${escapeHtml(posteP)}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${escapeHtml(svc)}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${exit}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${escapeHtml(reason)}</td>
            </tr>
          `;
        }).join("");

        panePorteurs.innerHTML = `
          <div style="overflow:auto;">
            <table class="sb-table">
              <thead>
                <tr>
                  <th>Personne</th><th class="col-center">Niveau</th><th>Poste</th><th>Service</th><th>Date sortie</th><th>Raison</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      // Postes impactés
      if (!postes.length) {
        panePostes.innerHTML = `<div class="card-sub" style="margin:0;">Aucun poste impacté retourné.</div>`;
      } else {
        const rows = postes.map(p => {
          const poste = (p.intitule_poste || p.poste || "—").toString();
          const svc = (p.nom_service || p.service || "—").toString();
          const attendu = (p.niveau_attendu || p.level_expected || "—").toString();
          const crit = (p.criticite || p.max_criticite || "—").toString();
          return `
            <tr>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;"><b>${escapeHtml(poste)}</b></td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;">${escapeHtml(svc)}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;" class="col-center">${escapeHtml(attendu)}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f3f4f6;" class="col-center">${escapeHtml(crit)}</td>
            </tr>
          `;
        }).join("");

        panePostes.innerHTML = `
          <div style="overflow:auto;">
            <table class="sb-table">
              <thead>
                <tr><th>Poste</th><th>Service</th><th class="col-center">Niveau attendu</th><th class="col-center">Criticité</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      // Plan d’action
      if (!actions.length) {
        paneActions.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Plan d’action</div>
            <div class="card-sub" style="margin:0;">
              Aucun plan renvoyé par l’API (à brancher).<br/>
              Conseil: transfert (shadowing), formation ciblée, mobilité/succession, recrutement si restants insuffisants.
            </div>
          </div>
        `;
      } else {
        paneActions.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Plan d’action</div>
            <div class="card-sub" style="margin:0;">
              ${actions.map(a => `• ${escapeHtml(String(a))}`).join("<br/>")}
            </div>
          </div>
        `;
      }

    } catch (e) {
      if (_prevCritReqId !== reqId) return;
      const msg = `Erreur chargement détail critique: ${e?.message || e}`;
      panePorteurs.innerHTML = `<div class="card-sub" style="margin:0;">${escapeHtml(msg)}</div>`;
      panePostes.innerHTML = `<div class="card-sub" style="margin:0;">${escapeHtml(msg)}</div>`;
      paneActions.innerHTML = `<div class="card-sub" style="margin:0;">${escapeHtml(msg)}</div>`;
    }
  }



  window.SkillsAnalyse = {
    onShow: async (portal) => {
      try {
        _portalref = portal;

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

