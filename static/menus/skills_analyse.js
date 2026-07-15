/* NOVOSKILL_PREVISION_KPI_VALIDATOR_GLOBAL_START */
(function () {
  const validPrevKpis = ["sorties-confirmees", "sorties-potentielles", "transmissions"];
  window.analysePrevisionValidKpi = function (key) {
    const k = (key || "").toString().trim().toLowerCase();
    return validPrevKpis.includes(k) ? k : "sorties-confirmees";
  };
})();
/* NOVOSKILL_PREVISION_KPI_VALIDATOR_GLOBAL_END */

/* ======================================================
   static/menus/skills_analyse.js
   - Menu "Analyse des compÃ©tences"
   - 3 tuiles cliquables (Risques / Matching / PrÃ©visions)
   - Filtres: Service (V1)
   - KPI: alimentÃ©s si API summary dispo, sinon "â€”"
   ====================================================== */

(function () {
  let _bound = false;
  let _servicesLoaded = false;
  let _portalref = null;
  let _prevData = null;
  let apiBase = "";
  let _analyseLastSummary = null;
  let _analyseLastSummaryEffects = [];

  const STORE_SERVICE = "sb_analyse_service";
  const STORE_MODE = "sb_analyse_mode";
  const STORE_RISK_FILTER = "sb_analyse_risk_filter";
  const STORE_MATCH_VIEW = "sb_analyse_match_view"; // "titulaire" | "candidats"
  const STORE_PREV_HORIZON = "sb_analyse_prev_horizon";
  const STORE_PREV_DETAIL_EXPANDED = "sb_analyse_prev_detail_expanded";
  const STORE_MATCH_POSTE_MODE = "sb_analyse_match_poste_mode"; // "fragiles" | "tous"
  const STORE_CRITICITE_MIN = "sb_analyse_criticite_min";
  const STORE_POSTES_SCOPE_EXPANDED = "sb_analyse_postes_scope_expanded";
  const STORE_RISK_DETAIL_EXPANDED = "sb_analyse_risk_detail_expanded";
  const STORE_FILTERS_OPEN = "sb_analyse_filters_open";
  const STORE_SIM_ORG_CONTEXT = "sb_simulations_rh_context_v1";
  const STORE_BF_FOCUS = "sb_bf_focus_v1";
  const CRITICITE_MIN_DEFAULT = 70;
  const POSTES_SCOPE_PREVIEW_LIMIT = 10;
  const PREV_TABLE_PREVIEW_LIMIT = 10;


  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function nsLevelCode(value) {
    if (window.NovoskillLevels) return window.NovoskillLevels.normalize(value);
    const raw = (value ?? "").toString().trim();
    if (!raw || raw === "â€”") return "";
    const m = raw.toUpperCase().match(/\b([ABCD])\b/);
    if (m && m[1]) return m[1];
    const plain = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (plain === "1" || plain.includes("initial") || plain.includes("debut")) return "A";
    if (plain === "2" || plain.includes("intermediaire")) return "B";
    if (plain === "3" || plain.includes("avance")) return "C";
    if (plain === "4" || plain.includes("expert")) return "D";
    return "";
  }

  function nsLevelLabel(value) {
    if (window.NovoskillLevels) return window.NovoskillLevels.label(value);
    const k = nsLevelCode(value);
    return ({ A: "DÃ©butant", B: "IntermÃ©diaire", C: "AvancÃ©", D: "Expert" }[k]) || ((value ?? "").toString().trim() || "â€”");
  }

  function nsLevelRank(value) {
    if (window.NovoskillLevels) return window.NovoskillLevels.rank(value);
    return ({ A: 1, B: 2, C: 3, D: 4 }[nsLevelCode(value)]) || 0;
  }

  function nsLevelBadgeHtml(value, title) {
    if (window.NovoskillLevels) return window.NovoskillLevels.badgeHtml(value, title || "Niveau de maÃ®trise");
    const k = nsLevelCode(value);
    const cls = ({ A: "sb-badge-niv-a", B: "sb-badge-niv-b", C: "sb-badge-niv-c", D: "sb-badge-niv-d" }[k]) || "";
    return `<span class="sb-badge sb-badge-niv ${cls}" title="${escapeHtml(title || "Niveau de maÃ®trise")}">${escapeHtml(nsLevelLabel(value))}</span>`;
  }


  function analyseRequiredLevelBadgeHtml(value, title) {
    const raw = (value ?? "").toString().trim();
    const code = nsLevelCode(raw);
    const labelByCode = { A: "DÃ©butant", B: "IntermÃ©diaire", C: "AvancÃ©", D: "Expert" };
    let label = labelByCode[code] || nsLevelLabel(raw);
    label = (label || "").toString().trim().replace(/^[A-D]\s*[-â€“â€”: ]\s*/i, "");
    if (!label) label = "â€”";
    const cls = ({ A: "sb-badge-niv-a", B: "sb-badge-niv-b", C: "sb-badge-niv-c", D: "sb-badge-niv-d" }[code]) || "";
    return `<span class="sb-badge sb-badge-niv ${cls}" title="${escapeHtml(title || "Niveau attendu")}">${escapeHtml(label)}</span>`;
  }


  function formatDateFr(iso) {
  const s = (iso || "").toString().trim();
  // attend du "YYYY-MM-DD" (ce que ton API renvoie)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || "â€”";
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

    // int ARGB signÃ© WinForms (ex: -256)
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
  // Matching/Risques - Badges "Ã©carts"
  // - Rouge = non acquises (abs)
  // - Orange = Ã  renforcer (sous)
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
                     font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold); color:#fff;
                     background:${bg}; border:1px solid rgba(0,0,0,.12);">
          ${n}
        </span>
      `;
    }

    return `
      <span style="display:inline-flex; gap:6px; align-items:center; justify-content:center;">
        ${badge(a, "#ef4444", "Non acquises")}
        ${badge(b, "#f59e0b", "Ã€ renforcer")}
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
          Ã€ renforcer
        </span>
      </div>
    `;
  }


  function setText(id, v, fallback = "â€”") {
    const el = byId(id);
    if (!el) return;
    el.textContent = (v === null || v === undefined || v === "") ? fallback : String(v);
  }

  function setStatus(text) {
    setText("analyseStatus", text || "â€”", "â€”");
  }


  // ======================================================
  // Aides utilisateur + hypothÃ¨ses de simulation prÃ©parÃ©es
  // ======================================================


  function styleAnalyseHelpModalCloseButton() {
    const btn = byId("btnAnalyseHelpModalClose");
    if (!btn) return;
    btn.classList.remove("sb-btn--soft", "btn-secondary");
    btn.classList.add("sb-btn", "sb-btn--accent");
  }



  function forceAnalyseHelpModalCloseAccent() {
    const btn = byId("btnAnalyseHelpModalClose");
    if (!btn) return;
    btn.classList.remove("sb-btn--soft", "btn-secondary", "btn-light", "btn-outline-secondary");
    btn.classList.add("sb-btn", "sb-btn--accent");
    btn.style.background = "var(--accent, #c1272d)";
    btn.style.borderColor = "var(--accent, #c1272d)";
    btn.style.color = "#fff";
  }

  function ensureAnalyseHelpModal() {
    let modal = byId("modalAnalyseHelp");
    if (modal) {
      styleAnalyseHelpModalCloseButton();
      forceAnalyseHelpModalCloseAccent();
      forceAnalyseHelpModalCloseAccent();
      return modal;
    }

    const html = `
      <div class="modal" id="modalAnalyseHelp" aria-hidden="true">
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-title" id="analyseHelpModalTitle">Comprendre lâ€™analyse</div>
            <button type="button" class="modal-x" id="btnCloseAnalyseHelpModal" aria-label="Fermer">Ã—</button>
          </div>
          <div class="modal-body">
            <div class="analyse-help-modal-body" id="analyseHelpModalBody"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--accent" id="btnAnalyseHelpModalClose">Fermer</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalAnalyseHelp");
    styleAnalyseHelpModalCloseButton();
    forceAnalyseHelpModalCloseAccent();
      forceAnalyseHelpModalCloseAccent();

    const close = () => closeAnalyseHelpModal();
    byId("btnCloseAnalyseHelpModal")?.addEventListener("click", close);
    byId("btnAnalyseHelpModalClose")?.addEventListener("click", close);
    modal?.addEventListener("click", (ev) => { if (ev.target === modal) close(); });
    return modal;
  }

  function showAnalyseHelp(title, html) {
    const modal = ensureAnalyseHelpModal();
    const t = byId("analyseHelpModalTitle");
    const b = byId("analyseHelpModalBody");
    if (t) t.textContent = title || "Comprendre lâ€™analyse";
    if (b) b.innerHTML = html || "";
    if (modal) {
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeAnalyseHelpModal() {
    const modal = byId("modalAnalyseHelp");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }


  function fmtAnalyseCount(v, singular, plural) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "â€”";
    const nn = Math.max(0, Math.round(n));
    return `${nn} ${nn > 1 ? plural : singular}`;
  }

  function analyseHorizonLabel(years) {
    const h = Math.max(1, Math.round(Number(years || getPrevHorizon() || 1)));
    return `N+${h}`;
  }
  function analyseRiskLevelLabel(value, count) {
    const v = Number(value || 0);
    if (v >= 80) return "Risque critique";
    if (v >= 65) return "Risque Ã©levÃ©";
    if (v >= 35) return "Risque modÃ©rÃ©";
    return "Risque faible";
  }
  function analyseRiskLevelClass(level) {
    const s = (level || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (s.includes("critique") || s.includes("eleve")) return "analyse-risk-effect-level--high";
    if (s.includes("modere") || s.includes("moyen")) return "analyse-risk-effect-level--medium";
    return "analyse-risk-effect-level--low";
  }


  function compactCauseList(items) {
    return (items || [])
      .map(x => (x || "").toString().trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  function normalizeAnalyseRiskEffectFromEngine(effect) {
    const e = effect || {};
    const score = Number(e.riskScore ?? e.risk_score ?? e.score ?? 0);
    const count = Number(e.riskCount ?? e.risk_count ?? e.count ?? 0);
    return {
      ...e,
      key: (e.key || "").toString(),
      title: e.title || "Effet terrain",
      level: e.level || "Risque faible",
      riskScore: Number.isFinite(score) ? score : 0,
      riskCount: Number.isFinite(count) ? count : 0,
      metric: e.metric || "Point dÃ©tectÃ©",
      causesTitle: e.causesTitle || e.causes_title || "Causes probables identifiÃ©es",
      causes: Array.isArray(e.causes) ? e.causes : []
    };
  }

  function pickAnalyseRiskSynthesisEffects(data) {
    const synth = data?.risk_synthesis || data?.synthese_risques || null;
    if (!synth) return [];

    // La synthÃ¨se des risques est une lecture actuelle.
    // Elle ne suit plus le slider N+X, rÃ©servÃ© Ã  la tuile PrÃ©visions.
    const effects = Array.isArray(synth.effects) ? synth.effects : [];
    return effects.map(normalizeAnalyseRiskEffectFromEngine).filter(e => e.key);
  }

  function buildAnalyseRiskEffects(data) {
    const engineEffects = pickAnalyseRiskSynthesisEffects(data);
    if (engineEffects.length) return engineEffects;

    const t = data?.tiles || {};
    const r = t.risques || {};
    const count = (value, singular, plural) => fmtAnalyseCount(Number(value || 0), singular, plural);

    const posteFrag = Number(r.postes_fragilite_globale || 0);
    const compFrag = Number(r.comp_fragilite_moyenne || 0);
    const postesAnalyses = Number(r.postes_analyses || 0);
    const postesFort = posteFrag >= 65 ? postesAnalyses : 0;
    const sansCouverture = Number(r.comp_critiques_sans_porteur || 0);
    const couvertureConcentree = Number(r.comp_bus_factor_1 || 0);
    const sansRenfort = Number(r.comp_critiques_tombent_zero_auj || 0);
    const compFragiles = Number(r.comp_critiques_fragiles || 0);

    const effects = [];

    if (posteFrag >= 35 || sansCouverture > 0 || sansRenfort > 0) {
      const riskScore = posteFrag;
      const riskCount = sansCouverture + sansRenfort + postesFort;
      effects.push({
        key: "rupture_activite",
        title: "Risque de rupture ou ralentissement dâ€™activitÃ©",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: `${Math.round(posteFrag)}% de fragilitÃ© moyenne des postes`,
        causesTitle: "Causes probables identifiÃ©es",
        causes: compactCauseList([
          sansCouverture > 0 ? count(sansCouverture, "compÃ©tence critique avec couverture insuffisante", "compÃ©tences critiques avec couverture insuffisante") : "couverture critique Ã  vÃ©rifier",
          sansRenfort > 0 ? count(sansRenfort, "poste sans renfort immÃ©diat", "postes sans renfort immÃ©diat") : "renfort immÃ©diat Ã  vÃ©rifier sur les postes sensibles",
          posteFrag >= 65 ? "postes Ã  risque fort Ã  relire dans le dÃ©tail" : "postes Ã  surveiller selon le dÃ©tail",
          "continuitÃ© opÃ©rationnelle Ã  vÃ©rifier sur les postes les plus exposÃ©s"
        ])
      });
    }

    if (compFrag >= 35 || compFragiles > 0 || sansCouverture > 0) {
      const riskScore = compFrag;
      const riskCount = compFragiles + sansCouverture;
      effects.push({
        key: "qualite_execution",
        title: "Risque de baisse de qualitÃ© dâ€™exÃ©cution",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: `${Math.round(compFrag)}% de fragilitÃ© moyenne des compÃ©tences`,
        causesTitle: "Causes probables identifiÃ©es",
        causes: compactCauseList([
          compFragiles > 0 ? count(compFragiles, "compÃ©tence critique avec maÃ®trise fragile", "compÃ©tences critiques avec maÃ®trise fragile") : "Ã©carts de maÃ®trise Ã  vÃ©rifier",
          "niveaux attendus Ã  confirmer",
          "Ã©valuations ou confirmations Ã  reprendre",
          "qualitÃ© dâ€™exÃ©cution Ã  sÃ©curiser sur les compÃ©tences les plus critiques"
        ])
      });
    }

    if (couvertureConcentree > 0 || sansRenfort > 0) {
      const riskScore = Math.max(compFrag, sansRenfort > 0 ? posteFrag : 0);
      const riskCount = couvertureConcentree + sansRenfort;
      effects.push({
        key: "dependance_individuelle",
        title: "Risque de dÃ©pendance individuelle",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: count(couvertureConcentree, "compÃ©tence avec couverture concentrÃ©e", "compÃ©tences avec couverture concentrÃ©e"),
        causesTitle: "Causes probables identifiÃ©es",
        causes: compactCauseList([
          couvertureConcentree > 0 ? count(couvertureConcentree, "compÃ©tence dÃ©pend dâ€™une seule personne", "compÃ©tences dÃ©pendent dâ€™une seule personne") : "dÃ©pendances individuelles Ã  vÃ©rifier",
          "vivier interne Ã  surveiller",
          sansRenfort > 0 ? count(sansRenfort, "poste sans renfort immÃ©diat", "postes sans renfort immÃ©diat") : "renfort immÃ©diat Ã  confirmer",
          "transmission Ã  structurer sur les compÃ©tences clÃ©s"
        ])
      });
    }

    if (compFrag >= 35 || couvertureConcentree > 0 || sansCouverture > 0) {
      const riskScore = compFrag;
      const riskCount = couvertureConcentree + sansCouverture;
      effects.push({
        key: "perte_savoir_faire",
        title: "Risque de perte de savoir-faire",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: count(couvertureConcentree, "compÃ©tence avec savoir-faire peu diffusÃ©", "compÃ©tences avec savoir-faire peu diffusÃ©"),
        causesTitle: "Causes probables identifiÃ©es",
        causes: compactCauseList([
          sansCouverture > 0 ? count(sansCouverture, "compÃ©tence sans expertise confirmÃ©e", "compÃ©tences sans expertise confirmÃ©e") : "expertise confirmÃ©e Ã  surveiller",
          couvertureConcentree > 0 ? count(couvertureConcentree, "compÃ©tence avec relÃ¨ve interne limitÃ©e", "compÃ©tences avec relÃ¨ve interne limitÃ©e") : "relÃ¨ve interne Ã  confirmer",
          "transmission Ã  organiser sur les savoir-faire sensibles",
          "savoir-faire Ã  sÃ©curiser avant perte de maÃ®trise opÃ©rationnelle"
        ])
      });
    }

    return effects;
  }


  function formatAnalyseSignedPoints(value) {
    const n = Math.round(Number(value || 0));
    if (!Number.isFinite(n) || n === 0) return "0 pt";
    return `${n > 0 ? "+" : ""}${n} ${Math.abs(n) > 1 ? "pts" : "pt"}`;
  }

  function updateAnalyseProjectionSummary(_previsions) {
    const label = byId("analyseSynthProjectionLabel");
    if (label) label.textContent = "Niveau de risque actuel";

    const r = _analyseLastSummary?.tiles?.risques || {};
    const posteFrag = Number(r.postes_fragilite_globale ?? NaN);
    const compFrag = Number(r.comp_fragilite_moyenne ?? NaN);
    const values = [posteFrag, compFrag].filter(Number.isFinite);
    if (!values.length) {
      setText("analyseSynthProjection", "â€”");
      return;
    }

    const score = Math.max(...values);
    const level = analyseRiskLevelLabel(score, 0).replace(/^Risque\s+/i, "");
    setText("analyseSynthProjection", `${level} Â· ${Math.round(score)}%`);
  }


  function updateAnalyseHeaderSynthesis(data) {
    _analyseLastSummary = data || null;
    const r = data?.tiles?.risques || {};
    const postesAnalyses = Number(r.postes_analyses ?? r.nb_postes_analyses ?? NaN);
    const competencesAnalysees = Number(r.competences_analysees ?? r.nb_competences_analysees ?? NaN);
    const effects = buildAnalyseRiskEffects(data || {});
    _analyseLastSummaryEffects = effects;

    setText("analyseSynthPostesAnalyses", Number.isFinite(postesAnalyses) ? fmtAnalyseCount(postesAnalyses, "poste", "postes") : "â€”");
    setText("analyseSynthCompetencesAnalysees", Number.isFinite(competencesAnalysees) ? fmtAnalyseCount(competencesAnalysees, "compÃ©tence", "compÃ©tences") : "â€”");
    setText("analyseSynthEffetsTerrain", fmtAnalyseCount(effects.length, "effet", "effets"));
    updateAnalyseProjectionSummary(data?.tiles?.previsions || _prevData || {});
  }

  function analyseRiskSummaryHtml() {
    const data = _analyseLastSummary || {};
    const r = data?.tiles?.risques || {};
    const scope = data?.scope?.nom_service || getScopeLabel();
    const effects = Array.isArray(_analyseLastSummaryEffects) ? _analyseLastSummaryEffects : buildAnalyseRiskEffects(data);
    const postes = Number(r.postes_analyses ?? r.nb_postes_analyses ?? NaN);
    const comps = Number(r.competences_analysees ?? r.nb_competences_analysees ?? NaN);

    const cards = effects.length ? effects.map(e => `
      <div class="analyse-risk-effect-card">
        <div class="analyse-risk-effect-head">
          <div>
            <div class="analyse-risk-effect-title">${escapeHtml(e.title)}</div>
            <div class="card-sub" style="margin:2px 0 0 0;">${escapeHtml(e.metric || "Point dÃ©tectÃ©")}</div>
          </div>
          <span class="analyse-risk-effect-level ${analyseRiskLevelClass(e.level)}">${escapeHtml(e.level || "Risque Ã  qualifier")}</span>
        </div>
        <div class="analyse-risk-effect-causes-title">${escapeHtml(e.causesTitle || "SynthÃ¨se des causes identifiÃ©es")}</div>
        <ul class="analyse-risk-effect-causes">
          ${(e.causes || []).slice(0, 5).map(c => `<li>${escapeHtml(c)}</li>`).join("")}
        </ul>
        <div class="analyse-risk-effect-actions">
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-analyse-ishikawa="${escapeHtml(e.key)}">GÃ©nÃ©rer lâ€™Ishikawa</button>
        </div>
      </div>
    `).join("") : `
      <div class="analyse-risk-effect-card">
        <div class="analyse-risk-effect-title">Aucun effet terrain significatif dÃ©tectÃ©</div>
        <div class="analyse-risk-effect-body" style="margin-top:6px;">Les donnÃ©es du pÃ©rimÃ¨tre ne font pas ressortir de fragilitÃ© notable sur les indicateurs suivis.</div>
      </div>
    `;

    return `
      <div class="analyse-help-intro">
        <p>La synthÃ¨se regroupe les effets terrain dÃ©tectÃ©s et leurs causes principales sur le pÃ©rimÃ¨tre <b>${escapeHtml(scope)}</b>.</p>
        <p class="card-sub" style="margin:6px 0 12px 0;">PÃ©rimÃ¨tre lu : ${Number.isFinite(postes) ? fmtAnalyseCount(postes, "poste", "postes") : "postes Ã  vÃ©rifier"} â€¢ ${Number.isFinite(comps) ? fmtAnalyseCount(comps, "compÃ©tence", "compÃ©tences") : "compÃ©tences Ã  vÃ©rifier"}</p>
        <div class="analyse-risk-summary-actions">
          <button type="button" class="sb-btn sb-btn--init sb-btn--sm" data-analyse-risk-report="1">GÃ©nÃ©rer le rapport</button>
        </div>
      </div>
      <div class="analyse-risk-summary-list">${cards}</div>
    `;
  }

  async function analyseApiBlob(url) {
    const headers = new Headers();
    headers.set("Accept", "application/pdf");

    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {
      /* lâ€™API retournera lâ€™erreur utile */
    }

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      let detail = "";
      if (ct.includes("application/json")) {
        try {
          const js = await res.json();
          detail = js?.detail || js?.message || JSON.stringify(js);
        } catch (_) { detail = ""; }
      } else {
        try { detail = await res.text(); } catch (_) { detail = ""; }
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return await res.blob();
  }

  async function openAnalysePdfBlob(url, blockedTitle) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      showAnalyseHelp(blockedTitle || "Ouverture bloquÃ©e", "<p>Le navigateur a bloquÃ© lâ€™ouverture du document. Autorise les fenÃªtres pour Novoskill ou rÃ©essaie.</p>");
      return;
    }
    try {
      win.document.write("<p style='font-family: var(--ns-font-ui);padding:20px;'>GÃ©nÃ©ration du documentâ€¦</p>");
      const blob = await analyseApiBlob(url);
      const blobUrl = URL.createObjectURL(blob);
      win.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      try {
        win.document.body.innerHTML = `<pre style="font-family: var(--ns-font-ui);white-space:pre-wrap;padding:20px;color:#991b1b;">Erreur gÃ©nÃ©ration document : ${escapeHtml(errMsg(e))}</pre>`;
      } catch (_) {}
      showAnalyseHelp("Document indisponible", `<p>${escapeHtml(errMsg(e))}</p>`);
    }
  }
  function buildAnalyseRiskDocumentUrl(kind, effectKey) {
    const ctx = getPortalContext(_portalref);
    if (!ctx.id_contact || !ctx.apiBase) return "";
    const qs = new URLSearchParams();
    if (effectKey) qs.set("effet", effectKey || "synthese");
    const f = getFilters();
    if (f.id_service) qs.set("id_service", f.id_service);
    qs.set("criticite_min", String(getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)));
    qs.set("_", String(Date.now()));
    const route = kind === "rapport" ? "rapport" : "ishikawa";
    return `${ctx.apiBase}/skills/analyse/${route}/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }




  function openAnalyseIshikawaPdf(effectKey) {
    const url = buildAnalyseRiskDocumentUrl("ishikawa", effectKey || "rupture_activite");
    if (!url) {
      showAnalyseHelp("Ishikawa indisponible", "<p>Impossible de retrouver le contexte utilisateur pour gÃ©nÃ©rer le document.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Ishikawa bloquÃ©");
  }

  function openAnalyseRiskReportPdf() {
    const url = buildAnalyseRiskDocumentUrl("rapport", "");
    if (!url) {
      showAnalyseHelp("Rapport indisponible", "<p>Impossible de retrouver le contexte utilisateur pour gÃ©nÃ©rer le document.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Rapport bloquÃ©");
  }

  function analyseEyeIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }

  function analysePdfIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>`;
  }

  function analysePrintIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/><path d="M8 18h8"/></svg>`;
  }

  function analyseDetailIconSvg(kind) {
    const icons = {
      risques: `<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>`,
      matching: `<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>`,
      previsions: `<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16V5"/></svg>`,
      postes: `<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>`,
      competences: `<svg viewBox="0 0 24 24"><path d="m22 10-10-5-10 5 10 5 10-5Z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>`,
      evol3m: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>`,
      matchingPostes: `<svg viewBox="0 0 24 24"><path d="M19 13.5V19H5v-5.5"/><path d="M9 10.5V5h6v5.5"/><path d="M8 13h8"/><path d="M12 9v8"/><path d="M4 13h4v4H4z"/><path d="M16 13h4v4h-4z"/></svg>`,
      candidats: `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="5"/><path d="M8.5 12.5 7 22l5-3 5 3-1.5-9.5"/></svg>`,
      sortiesConfirmees: `<svg viewBox="0 0 24 24"><path d="M14 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>`,
      sortiesPotentielles: `<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="3"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/><path d="M4 8a8 8 0 0 0-1 4"/><path d="M20 8a8 8 0 0 1 1 4"/></svg>`,
      transmissions: `<svg viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`
    };
    return icons[kind] || icons.risques;
  }

  function analyseDetailTitleHtml(text, iconKind) {
    return `<span class="analyse-detail-titleline"><span class="analyse-detail-title-icon" aria-hidden="true">${analyseDetailIconSvg(iconKind)}</span><span>${escapeHtml(text || "â€”")}</span></span>`;
  }

  function setAnalyseDetailTitle(text, iconKind) {
    const el = byId("analyseDetailTitle");
    if (!el) return;
    el.innerHTML = analyseDetailTitleHtml(text, iconKind);
    el.style.marginBottom = "0";
  }

  function buildAnalysePosteAnalysisPdfUrl(idPoste) {
    const ctx = getPortalContext(_portalref);
    const posteId = String(idPoste || "").trim();
    if (!ctx.id_contact || !ctx.apiBase || !posteId) return "";

    const f = getFilters();
    const qs = new URLSearchParams();
    qs.set("id_poste", posteId);
    if (f.id_service) qs.set("id_service", f.id_service);
    qs.set("criticite_min", String(getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)));
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/risques/poste/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function openAnalysePosteAnalysisPdf(idPoste) {
    const url = buildAnalysePosteAnalysisPdfUrl(idPoste);
    if (!url) {
      showAnalyseHelp("PDF indisponible", "<p>Impossible de retrouver le poste Ã  exporter.</p>");
      return;
    }
    openAnalysePdfBlob(url, "PDF poste bloquÃ©");
  }

  function buildAnalyseCompetenceAnalysisPdfUrl(compKey) {
    const ctx = getPortalContext(_portalref);
    const key = String(compKey || "").trim();
    if (!ctx.id_contact || !ctx.apiBase || !key) return "";

    const f = getFilters();
    const qs = new URLSearchParams();
    qs.set("id_comp", key);
    if (f.id_service) qs.set("id_service", f.id_service);
    qs.set("criticite_min", String(getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)));
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/risques/competence/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function openAnalyseCompetenceAnalysisPdf(compKey) {
    const url = buildAnalyseCompetenceAnalysisPdfUrl(compKey);
    if (!url) {
      showAnalyseHelp("PDF indisponible", "<p>Impossible de retrouver la compÃ©tence Ã  exporter.</p>");
      return;
    }
    openAnalysePdfBlob(url, "PDF compÃ©tence bloquÃ©");
  }


  function buildAnalyseCompetenceFichePdfUrl(compKey) {
    const ctx = getPortalContext(_portalref);
    const key = String(compKey || "").trim();
    if (!ctx.id_contact || !ctx.apiBase || !key) return "";

    const qs = new URLSearchParams();
    qs.set("_", String(Date.now()));
    return `${ctx.apiBase}/skills/analyse/competences/fiche_pdf/${encodeURIComponent(ctx.id_contact)}/${encodeURIComponent(key)}?${qs.toString()}`;
  }

  function openAnalyseCompetenceFichePdf(compKey) {
    const url = buildAnalyseCompetenceFichePdfUrl(compKey);
    if (!url) {
      showAnalyseHelp("PDF indisponible", "<p>Impossible de retrouver la fiche compÃ©tence Ã  exporter.</p>");
      return;
    }
    openAnalysePdfBlob(url, "PDF fiche compÃ©tence bloquÃ©");
  }




  /* NOVOSKILL_POSTE_DEP_COMP_PDF_HANDLER_START */
  document.addEventListener("click", function (ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-poste-dep-comp-pdf]") : null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const compKey = (btn.getAttribute("data-poste-dep-comp-pdf") || "").trim();
    if (compKey) openAnalyseCompetenceFichePdf(compKey);
  }, true);
  /* NOVOSKILL_POSTE_DEP_COMP_PDF_HANDLER_END */



  function buildAnalyseRiskDetailPdfUrl(kpiKey) {
    const ctx = getPortalContext(_portalref);
    if (!ctx.id_contact || !ctx.apiBase) return "";

    const k = (kpiKey || "").toString().trim();
    if (!isExpandableRiskDetail(k)) return "";

    const f = getFilters();
    const qs = new URLSearchParams();
    qs.set("kpi", k);
    if (f.id_service) qs.set("id_service", f.id_service);
    qs.set("criticite_min", String(getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)));
    qs.set("limit", String(getRiskDetailLimit(k)));
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/risques/detail/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function openAnalyseRiskDetailPdf(kpiKey) {
    const url = buildAnalyseRiskDetailPdfUrl(kpiKey);
    if (!url) {
      showAnalyseHelp("Impression indisponible", "<p>Impossible de retrouver la table Ã  imprimer.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Impression bloquÃ©e");
  }


  function isPrintablePrevisionDetail(kpiKey) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    return [
      "sorties-confirmees",
      "sorties-potentielles",
      "transmissions",
      "sorties",
      "critiques",
      "postes-rouges"
    ].includes(k);
  }

  function getPrevisionDetailExpanded(kpiKey) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    if (!isPrintablePrevisionDetail(k)) return false;
    return (localStorage.getItem(`${STORE_PREV_DETAIL_EXPANDED}_${k}`) || "0") === "1";
  }

  function setPrevisionDetailExpanded(kpiKey, value) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    if (!isPrintablePrevisionDetail(k)) return;
    const storageKey = `${STORE_PREV_DETAIL_EXPANDED}_${k}`;
    if (value) localStorage.setItem(storageKey, "1");
    else localStorage.removeItem(storageKey);
  }

  function getPrevisionDetailLimit(kpiKey) {
    return getPrevisionDetailExpanded(kpiKey) ? 2000 : PREV_TABLE_PREVIEW_LIMIT;
  }

  function buildAnalysePrevisionsDetailPdfUrl(kpiKey) {
    const ctx = getPortalContext(_portalref);
    const k = (kpiKey || "").toString().trim().toLowerCase();
    if (!ctx.id_contact || !ctx.apiBase || !isPrintablePrevisionDetail(k)) return "";

    const f = getFilters();
    const qs = new URLSearchParams();
    qs.set("kpi", k);
    qs.set("horizon_years", String(getPrevHorizon()));
    if (f.id_service) qs.set("id_service", f.id_service);
    qs.set("criticite_min", String(getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)));
    qs.set("limit", String(getPrevisionDetailLimit(k)));
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/previsions/detail/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function openAnalysePrevisionsDetailPdf(kpiKey) {
    const url = buildAnalysePrevisionsDetailPdfUrl(kpiKey);
    if (!url) {
      showAnalyseHelp("Impression indisponible", "<p>Impossible de retrouver la table prÃ©visionnelle Ã  imprimer.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Impression bloquÃ©e");
  }

  function renderPrevisionsHeaderActions(kpiKey, rowsCount = 0) {
    const actions = byId("analyseDetailActions");
    if (!actions) return;

    const k = (kpiKey || "").toString().trim().toLowerCase();
    if (!isPrintablePrevisionDetail(k)) {
      actions.innerHTML = "";
      return;
    }

    const total = Number(rowsCount || 0);
    const showToggle = total > PREV_TABLE_PREVIEW_LIMIT;
    const expanded = getPrevisionDetailExpanded(k);

    actions.innerHTML = `
      ${showToggle ? `
        <button type="button" class="sb-btn sb-btn--init sb-btn--xs" id="btnPrevisionDetailToggle">
          ${expanded ? "Afficher les 10 premiers" : "Afficher tout"}
        </button>
      ` : ""}
      <button type="button" class="sb-icon-btn analyse-detail-print-btn" id="btnPrevisionDetailPrint" title="Imprimer" aria-label="Imprimer">
        ${analysePrintIconSvg()}
      </button>
    `;

    const btnToggle = byId("btnPrevisionDetailToggle");
    if (btnToggle) {
      btnToggle.addEventListener("click", () => {
        setPrevisionDetailExpanded(k, !getPrevisionDetailExpanded(k));
        renderDetail("previsions");
      });
    }

    const btnPrint = byId("btnPrevisionDetailPrint");
    if (btnPrint) {
      btnPrint.addEventListener("click", () => openAnalysePrevisionsDetailPdf(k));
    }
  }
  function analyseHelpKpi(title, text) {
    return `
      <section class="analyse-help-kpi-block">
        <h4>${escapeHtml(title)}</h4>
        <p>${text}</p>
      </section>
    `;
  }

  function analyseHelpIntro(text) {
    return `<p class="analyse-help-readable-intro">${text}</p>`;
  }

  function analyseHelpNote(text) {
    return `<p class="analyse-help-readable-note">${text}</p>`;
  }

  function buildRisquesHelpHtml() {
    return `
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte. Les pourcentages indiquent un niveau dâ€™exposition du pÃ©rimÃ¨tre, pas une dÃ©cision automatique.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi("FragilitÃ© moyenne des postes", "Ce pourcentage mesure le niveau moyen dâ€™exposition des postes affichÃ©s dans le pÃ©rimÃ¨tre sÃ©lectionnÃ©. Il prend en compte la couverture des compÃ©tences attendues sur les postes, les niveaux rÃ©ellement disponibles, les Ã©carts avec les niveaux attendus, les compÃ©tences qui reposent sur trop peu de personnes et les Ã©valuations manquantes ou Ã  confirmer. Plus le pourcentage est Ã©levÃ©, plus la continuitÃ© des postes doit Ãªtre sÃ©curisÃ©e.")}
        ${analyseHelpKpi("FragilitÃ© moyenne des compÃ©tences", "Ce pourcentage mesure le niveau moyen dâ€™exposition des compÃ©tences critiques du pÃ©rimÃ¨tre. Le calcul tient compte du nombre de collaborateurs capables de porter chaque compÃ©tence, de leur niveau de maÃ®trise, de la prÃ©sence de relais internes, de la confirmation des Ã©valuations et de la dÃ©pendance Ã©ventuelle Ã  une seule personne.")}
        ${analyseHelpKpi("PrÃ©vision Ã  3 mois", "Cet indicateur affiche la plus forte dÃ©gradation de fragilitÃ© dÃ©tectÃ©e dans les trois prochains mois, et pas seulement la situation exacte au dernier jour. Le calcul tient compte des indisponibilitÃ©s temporaires, des fins de contrat, des dÃ©parts ou retraites prÃ©vus lorsquâ€™une date de sortie est renseignÃ©e. Si un risque apparaÃ®t pendant quelques semaines puis disparaÃ®t avant la fin des trois mois, il est quand mÃªme pris en compte.")}
      </div>
      ${analyseHelpNote("Ã€ lire comme une aide Ã  la priorisation : lâ€™indicateur signale oÃ¹ regarder en premier, puis lâ€™analyse dÃ©taillÃ©e permet de confirmer les actions Ã  mener.")}
    `;
  }

  function buildMatchingHelpHtml() {
    return `
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte Correspondance profils / postes. Le calcul sert Ã  repÃ©rer des pistes internes, pas Ã  valider automatiquement une mobilitÃ© ou un remplacement.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi("AdÃ©quation au poste", "Cet indicateur mesure le niveau de correspondance entre les compÃ©tences connues dâ€™un collaborateur titulaire et les compÃ©tences attendues sur son poste. Le calcul compare les compÃ©tences dÃ©tenues, leur niveau de maÃ®trise, les Ã©carts avec le niveau attendu et les Ã©lÃ©ments qui restent Ã  confirmer. Une adÃ©quation Ã©levÃ©e indique que le poste est bien couvert ; une adÃ©quation faible signale des Ã©carts, une couverture insuffisante ou des donnÃ©es encore trop fragiles.")}
        ${analyseHelpKpi("Top candidat", "Cet indicateur met en avant le profil interne le plus proche dâ€™un poste, en dehors du titulaire quand câ€™est nÃ©cessaire. Le systÃ¨me recherche la meilleure correspondance disponible Ã  partir des compÃ©tences et niveaux dÃ©jÃ  connus. Il sâ€™agit dâ€™une piste de renfort, de mobilitÃ©, de remplacement ou de montÃ©e en compÃ©tence ; la disponibilitÃ©, lâ€™envie et la validation managÃ©riale restent Ã  confirmer.")}
      </div>
      ${analyseHelpNote("Une bonne correspondance nâ€™est pas forcÃ©ment une personne immÃ©diatement opÃ©rationnelle Ã  100 %. Elle indique surtout le profil le plus proche Ã  Ã©tudier.")}
    `;
  }

  function buildPrevisionsHelpHtml() {
    const horizon = analyseHorizonLabel(getPrevHorizon());
    return `
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte PrÃ©visions. Ils servent Ã  anticiper les fragilitÃ©s qui peuvent apparaÃ®tre si le pÃ©rimÃ¨tre Ã©volue.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi(`Sorties ${horizon}`, "Ce chiffre indique le nombre de collaborateurs susceptibles de sortir du pÃ©rimÃ¨tre sur la pÃ©riode N+X choisie. Le calcul sâ€™appuie sur les informations connues dans Novoskill : dÃ©part prÃ©vu, retraite, mobilitÃ©, fin de prÃ©sence, indisponibilitÃ© ou autre donnÃ©e prÃ©visionnelle renseignÃ©e.")}
        ${analyseHelpKpi("Ã‰volution fragilitÃ© compÃ©tences", "Cet indicateur affiche lâ€™Ã©volution moyenne de fragilitÃ© ramenÃ©e Ã  toutes les compÃ©tences analysÃ©es du pÃ©rimÃ¨tre. Le calcul repart de la fragilitÃ© actuelle puis rejoue le mÃªme moteur en retirant les sortants identifiÃ©s sur la pÃ©riode N+X.")}
        ${analyseHelpKpi("Ã‰volution fragilitÃ© postes", "Cet indicateur affiche lâ€™Ã©volution moyenne de fragilitÃ© ramenÃ©e Ã  tous les postes analysÃ©s du pÃ©rimÃ¨tre. Le calcul repart de la fragilitÃ© actuelle puis rejoue le mÃªme moteur en retirant les sortants identifiÃ©s sur la pÃ©riode N+X.")}
        ${analyseHelpKpi("Horizon de projection", "Le curseur permet de changer la pÃ©riode observÃ©e. Plus la pÃ©riode est longue, plus lâ€™analyse peut faire apparaÃ®tre des fragilitÃ©s futures. La lecture reste une anticipation : elle doit aider Ã  prÃ©parer les actions avant que le risque devienne opÃ©rationnel.")}
      </div>
      ${analyseHelpNote("Cette carte sert Ã  prendre de lâ€™avance : transmission, relÃ¨ve interne, formation, recrutement ou rÃ©organisation ciblÃ©e.")}
    `;
  }

  const ANALYSE_HELP = {
    summary: {
      title: "SynthÃ¨se des risques",
      html: ""
    },
    risques: {
      title: "Comprendre la carte Risques actuels",
      html: buildRisquesHelpHtml
    },
    risques_evol3m_table: {
      title: "Ã‰volution des indices de fragilitÃ© Ã  3 mois",
      html: `
        <div class="analyse-help-kpi-list">
          <div class="analyse-help-kpi-block">
            <h4>Mois de projection</h4>
            <p>Chaque ligne prÃ©sente la situation actuelle ou un mois de projection dans les trois prochains mois. La ligne marquÃ©e <b>pic retenu</b> correspond au mois oÃ¹ lâ€™indice de fragilitÃ© atteint son niveau le plus haut sur la pÃ©riode.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Indice de fragilitÃ©</h4>
            <p>Câ€™est le niveau de fragilitÃ© moyen projetÃ© sur le pÃ©rimÃ¨tre affichÃ©. Il tient compte des postes, des compÃ©tences attendues, des titulaires disponibles et des Ã©vÃ©nements prÃ©vus sur la pÃ©riode.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Ã‰volution</h4>
            <p>Cette valeur compare le mois affichÃ© avec la situation dâ€™aujourdâ€™hui. Une hausse signale une dÃ©gradation du risque. Une baisse indique une amÃ©lioration. Un tiret sur la ligne dâ€™aujourdâ€™hui signifie quâ€™il nâ€™y a pas encore dâ€™Ã©volution Ã  mesurer.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>IndisponibilitÃ©s temporaires</h4>
            <p>Nombre de collaborateurs ayant une indisponibilitÃ© qui chevauche le mois concernÃ©. MÃªme une absence courte peut faire monter la fragilitÃ© si elle touche une personne seule sur un poste ou une compÃ©tence sensible.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Fins de contrat / sorties prÃ©vues</h4>
            <p>Nombre de collaborateurs avec une date de fin de contrat, de dÃ©part, de retraite ou de sortie prÃ©vue pendant le mois concernÃ©. Ces personnes ne sont plus considÃ©rÃ©es comme disponibles pour couvrir le pÃ©rimÃ¨tre projetÃ©.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>DÃ©tail</h4>
            <p>Le bouton Å“il ouvre la liste des collaborateurs concernÃ©s par les indisponibilitÃ©s ou sorties prÃ©vues sur le mois sÃ©lectionnÃ©.</p>
          </div>
        </div>`
    },
    matching: {
      title: "Comprendre la carte Correspondance profils / postes",
      html: buildMatchingHelpHtml
    },
    previsions: {
      title: "Comprendre la carte PrÃ©visions",
      html: buildPrevisionsHelpHtml
    }
  };

  const CAUSE_EFFECTS = {
    structure: {
      title: "Effet possible du risque structurel",
      text: "Le poste peut Ãªtre insuffisamment tenu ou trop peu couvert. Lâ€™activitÃ© repose alors sur une base trop fragile, mÃªme si certaines compÃ©tences existent dans lâ€™entreprise."
    },
    dependance: {
      title: "Effet possible de la dÃ©pendance",
      text: "La continuitÃ© repose sur trop peu de collaborateurs confirmÃ©s. Une absence, un dÃ©part ou une surcharge peut rapidement mettre le poste ou la compÃ©tence sous tension."
    },
    transmission: {
      title: "Effet possible dâ€™un renfort potentiel insuffisant",
      text: "Le poste dispose de peu de profils internes capables dâ€™aider rapidement. Les seuils utilisÃ©s distinguent les renforts immÃ©diats et les renforts Ã  prÃ©parer."
    },
    sorties: {
      title: "Effet possible dâ€™une sortie approchante",
      text: "Un titulaire a une fin de contrat, une retraite ou une sortie prÃ©vue Ã  court terme. Cela nâ€™explique pas forcÃ©ment la fragilitÃ© actuelle, mais peut lâ€™aggraver rapidement."
    },
    efficacite: {
      title: "Effet possible dâ€™un niveau attendu non atteint",
      text: "Le poste peut sembler couvert, mais la compÃ©tence nâ€™est pas maÃ®trisÃ©e au niveau requis. Cela peut produire des erreurs, des dÃ©lais ou une dÃ©pendance Ã  un profil plus expÃ©rimentÃ©."
    },
    comp_maitrise: {
      title: "MaÃ®trise insuffisante de la compÃ©tence",
      text: "Cette cause apparaÃ®t quand la compÃ©tence existe dans lâ€™entreprise, mais pas suffisamment au niveau attendu sur les usages analysÃ©s. Elle aide Ã  repÃ©rer les Ã©carts entre le besoin rÃ©el et la maÃ®trise disponible."
    },
    comp_concentration: {
      title: "Concentration sur trop peu de personnes",
      text: "Cette cause indique que la compÃ©tence est dÃ©tenue par un nombre trop limitÃ© de collaborateurs. Plus la compÃ©tence est concentrÃ©e, plus une absence ou un changement de poste peut fragiliser lâ€™organisation."
    },
    comp_transmission: {
      title: "CapacitÃ© de transmission insuffisante",
      text: "Cette cause vÃ©rifie si la compÃ©tence peut Ãªtre transmise. La lecture tient compte des collaborateurs au niveau Expert et des collaborateurs AvancÃ©s pouvant servir de base Ã  une transmission organisÃ©e."
    },
    comp_evenements: {
      title: "Exposition Ã  des sorties ou indisponibilitÃ©s",
      text: "Cette cause signale les Ã©vÃ©nements connus qui peuvent retirer temporairement ou durablement des collaborateurs associÃ©s Ã  cette compÃ©tence : indisponibilitÃ©, fin de contrat, retraite ou sortie prÃ©vue."
    },
    comp_donnees: {
      title: "DonnÃ©es Ã  vÃ©rifier",
      text: "Cette cause ne signale pas forcÃ©ment un risque mÃ©tier direct. Elle indique que certaines donnÃ©es doivent Ãªtre confirmÃ©es pour fiabiliser la lecture de la compÃ©tence."
    },
    non_confirmee: {
      title: "Effet possible dâ€™une compÃ©tence non confirmÃ©e",
      text: "La couverture repose sur une dÃ©claration ou une donnÃ©e incomplÃ¨te. Lâ€™analyse reste prudente tant que le niveau rÃ©el nâ€™est pas confirmÃ© par une Ã©valuation exploitable."
    },
    indisponibilite: {
      title: "Effet possible dâ€™une indisponibilitÃ©",
      text: "La couverture peut devenir insuffisante temporairement. Le risque porte surtout sur la continuitÃ© dâ€™activitÃ© Ã  court terme."
    },
    prevision: {
      title: "Effet possible Ã  moyen terme",
      text: "La compÃ©tence ou le poste peut devenir fragile si la relÃ¨ve nâ€™est pas prÃ©parÃ©e. Le risque est progressif, mais peut devenir bloquant si rien nâ€™est consolidÃ©."
    }
  };

  function causeHelpButton(key) {
    return `<span class="analyse-cause-help" data-cause-help="${escapeHtml(key || "structure")}" role="button" tabindex="0" aria-label="Comprendre lâ€™effet de cette cause">?</span>`;
  }

  function bindAnalyseHelpDelegation() {
    document.addEventListener("click", (ev) => {
      const btnHelp = ev.target?.closest?.("[data-analyse-help]");
      if (btnHelp) {
        ev.preventDefault();
        ev.stopPropagation();
        const key = (btnHelp.getAttribute("data-analyse-help") || "").trim();
        if (key === "summary") {
          showAnalyseHelp("SynthÃ¨se des risques", analyseRiskSummaryHtml());
          return;
        }
        const item = ANALYSE_HELP[key] || ANALYSE_HELP.risques;
        const html = (typeof item.html === "function") ? item.html() : item.html;
        showAnalyseHelp(item.title, html);
        return;
      }

      const btnIshikawa = ev.target?.closest?.("[data-analyse-ishikawa]");
      if (btnIshikawa) {
        ev.preventDefault();
        ev.stopPropagation();
        openAnalyseIshikawaPdf((btnIshikawa.getAttribute("data-analyse-ishikawa") || "").trim());
        return;
      }

      const btnReport = ev.target?.closest?.("[data-analyse-risk-report]");
      if (btnReport) {
        ev.preventDefault();
        ev.stopPropagation();
        openAnalyseRiskReportPdf();
        return;
      }

      const btnCause = ev.target?.closest?.("[data-cause-help]");
      if (btnCause) {
        ev.preventDefault();
        ev.stopPropagation();
        const key = (btnCause.getAttribute("data-cause-help") || "").trim();
        const item = CAUSE_EFFECTS[key] || CAUSE_EFFECTS.structure;
        showAnalyseHelp(item.title, `<p>${escapeHtml(item.text)}</p>`);
      }
    }, true);
  }

  // Les modals Analyse restent volontairement au constat.
  // La construction de scÃ©narios RH se fait dÃ©sormais dans Simulation RH.

  function openSimulationsRhContext(payload = {}) {
    const filters = getFilters();
    const ctx = {
      id: `analyse_ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      source: "analyse_competences",
      source_label: "Analyse des compÃ©tences",
      scope_label: getScopeLabel(),
      id_service: filters.id_service || null,
      service_raw: getAnalyseServiceRawValue(),
      criticite_min: getCriticiteMinSafe(CRITICITE_MIN_DEFAULT),
      ...payload,
    };
    try { localStorage.setItem(STORE_SIM_ORG_CONTEXT, JSON.stringify(ctx)); } catch (_) {}
    try {
      if (_portalref && typeof _portalref.switchView === "function") {
        _portalref.switchView("simulations-rh");
        return;
      }
    } catch (_) {}
    window.location.hash = "#simulations-rh";
  }

  function openBesoinsFormations(focusPayload) {
    const focus = focusPayload && typeof focusPayload === "object" ? {
      id: `analyse_bf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      source: "analyse_competences",
      source_label: "Analyse des compÃ©tences",
      scope_label: getScopeLabel(),
      criticite_min: getCriticiteMinSafe(CRITICITE_MIN_DEFAULT),
      ...focusPayload,
    } : null;
    try {
      if (focus) localStorage.setItem(STORE_BF_FOCUS, JSON.stringify(focus));
    } catch (_) {}
    try {
      if (_portalref && typeof _portalref.switchView === "function") {
        _portalref.switchView("besoins-formations");
        return;
      }
    } catch (_) {}
    window.location.hash = "#besoins-formations";
  }

  function configureActionButton(id, payload, onClick) {
    const btn = byId(id);
    if (!btn) return;
    btn.style.display = payload ? "" : "none";
    btn.disabled = !payload;
    btn.onclick = null;
    if (!payload) return;
    btn.onclick = function () {
      if (typeof onClick === "function") onClick(payload);
    };
  }

  function getAnalyseServiceRawValue() {
    const sel = byId("analyseServiceSelect");
    return sel ? String(sel.value || "").trim() : "";
  }

  function setAnalyseServiceRawValue(rawValue = "") {
    const sel = byId("analyseServiceSelect");
    if (!sel) return;

    const wanted = String(rawValue || "").trim();
    const opts = Array.from(sel.options || []);

    if (wanted && opts.some(o => String(o.value || "").trim() === wanted)) {
      sel.value = wanted;
      return;
    }

    const allId = String(window.portal?.serviceFilter?.ALL_ID || "").trim();
    if (allId && opts.some(o => String(o.value || "").trim() === allId)) {
      sel.value = allId;
      return;
    }

    if (opts.some(o => String(o.value || "").trim() === "")) {
      sel.value = "";
      return;
    }

    sel.selectedIndex = opts.length ? 0 : -1;
  }

  function getFilters() {
    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
    return { id_service };
  }


  function getScopeLabel() {
    const sel = byId("analyseServiceSelect");
    return sel ? (sel.options[sel.selectedIndex]?.textContent || "Tous les services") : "Tous les services";
  }

  // ==============================
  // PrÃ©visions - slider horizon (1..5 ans)
  // - Les KPI restent dans la tuile PrÃ©visions, sans toucher au panneau dÃ©tail (V1)
  // - Les donnÃ©es viennent de tiles.previsions.horizons (backend)
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
    const label = analyseHorizonLabel(n);
    const el = byId("prevHorizonLabel");
    if (el) el.textContent = label;
    const title = byId("prevTileTitle");
    if (title) title.textContent = `PrÃ©visions Ã  ${label}`;
  }

  function pickPrevHorizonItem(previsions, horizonYears) {
    const list = Array.isArray(previsions?.horizons) ? previsions.horizons : [];
    const h = Number(horizonYears || 0);
    return list.find(x => Number(x?.horizon_years || 0) === h) || null;
  }

  function formatPrevisionImpactPercent(value) {
    const n = Math.round(Number(value || 0));
    if (!Number.isFinite(n) || n <= 0) return "0%";
    return `+${n}%`;
  }

  function applyPrevisionsKpis(previsions) {
    const p = previsions || {};
    _prevData = p;

    const horizon = getPrevHorizon();
    setPrevHorizonLabel(horizon);

    const item = pickPrevHorizonItem(p, horizon);

    if (item) {
      setText("kpiPrevSortiesConfirmees", item.sorties_confirmees ?? item.sorties ?? 0);
      setText("kpiPrevSortiesPotentielles", item.sorties_potentielles ?? 0);
      setText("kpiPrevTransmissions", item.transmissions_a_preparer ?? 0);
      updateAnalyseProjectionSummary(p);
      if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
      return;
    }

    setText("kpiPrevSortiesConfirmees", p.sorties_confirmees_12m ?? p.sorties_12m ?? 0);
    setText("kpiPrevSortiesPotentielles", p.sorties_potentielles_12m ?? 0);
    setText("kpiPrevTransmissions", p.transmissions_a_preparer_12m ?? 0);
    updateAnalyseProjectionSummary(p);
    if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
  }

  async function loadServices(portal) {
    await portal.serviceFilter.populateSelect({
      portal,
      selectId: "analyseServiceSelect",
      storageKey: STORE_SERVICE,
      labelAll: "Tous les services",
      labelNonLie: "Non liÃ©",
      includeAll: true,
      includeNonLie: true,
      allowIndent: true
    });
    _servicesLoaded = true;
  }

  function getAnalyseServiceRawValue() {
    const sel = byId("analyseServiceSelect");
    return sel ? String(sel.value || "").trim() : "";
  }

  function setAnalyseServiceRawValue(rawValue = "") {
    const sel = byId("analyseServiceSelect");
    if (!sel) return;

    const wanted = String(rawValue || "").trim();
    const opts = Array.from(sel.options || []);

    if (wanted && opts.some(o => String(o.value || "").trim() === wanted)) {
      sel.value = wanted;
      return;
    }

    const allId = String(window.portal?.serviceFilter?.ALL_ID || "").trim();
    if (allId && opts.some(o => String(o.value || "").trim() === allId)) {
      sel.value = allId;
      return;
    }

    if (opts.some(o => String(o.value || "").trim() === "")) {
      sel.value = "";
      return;
    }

    sel.selectedIndex = opts.length ? 0 : -1;
  }

  function clearKpis() {
    setText("kpiRiskPostes", "â€”");
    setText("kpiRiskCritFragiles", "â€”");
    setText("kpiRiskEvol3m", "â€”");

    const a = byId("kpiRiskCritAlert");
    if (a) {
      a.textContent = "";
      a.style.display = "none";
    }

    setText("kpiMatchNoCandidate", "â€”");
    setText("kpiMatchReadyNow", "â€”");
    setText("kpiMatchReady6", "â€”");

    setText("kpiPrevSorties12", "â€”");
    setText("kpiPrevCompImpact", "â€”");
    setText("kpiPrevPostesRed", "â€”");
    setText("analyseSynthPostesAnalyses", "â€”");
    setText("analyseSynthCompetencesAnalysees", "â€”");
    setText("analyseSynthEffetsTerrain", "â€”");
    setText("analyseSynthProjection", "â€”");
  }


  function setActiveTile(mode) {
    const tiles = [
      byId("tileRisques"),
      byId("tileMatching"),
      byId("tilePrevisions")
    ].filter(Boolean);

    // reset Ã©tat active des tuiles
    tiles.forEach(t => t.classList.remove("active"));

    // reset visuel de tous les mini-KPI
    tiles.forEach(t => {
      const kpis = t.querySelectorAll(".mini-kpi");
      kpis.forEach(kpi => {
        kpi.classList.remove("is-active");
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

    // RÃ©-appliquer les KPI actifs uniquement pour la tuile active
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
      setActivePrevKpi(window.analysePrevisionValidKpi(localStorage.getItem("sb_analyse_prev_kpi") || "sorties-confirmees"));
    } else {
      setActiveRiskKpi("");
      setActiveMatchKpi("");
      setActivePrevKpi("");
    }
  }



  function getRiskFilter() {
    const v = (localStorage.getItem(STORE_RISK_FILTER) || "").trim();

    // Migrations legacy
    if (v === "critiques-sans-porteur" || v === "porteur-unique") {
      localStorage.setItem(STORE_RISK_FILTER, "critiques-fragiles");
      return "critiques-fragiles";
    }
    if (v === "postes-fragiles") {
      localStorage.setItem(STORE_RISK_FILTER, "postes-scope");
      return "postes-scope";
    }
    return v;
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
      el.classList.toggle("is-active", isActive);
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

  function getMatchPosteMode() {
    return "tous";
  }

  function setMatchPosteMode(_mode) {
    try { localStorage.removeItem(STORE_MATCH_POSTE_MODE); } catch (_) {}
  }


  function setActiveMatchKpi(view) {
    const tile = byId("tileMatching");
    if (!tile) return;

    // si la tuile n'est pas active => aucun KPI ne doit paraÃ®tre actif
    const tileIsActive = tile.classList.contains("active");

    const items = tile.querySelectorAll(".mini-kpi[data-match-view]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-match-view") || "").trim().toLowerCase();
      const isActive = tileIsActive && !!view && k === view;
      el.classList.toggle("is-active", isActive);
    });
  }

  function setActivePrevKpi(key) {
    const tile = byId("tilePrevisions");
    if (!tile) return;

    // si la tuile n'est pas active => aucun KPI ne doit paraÃ®tre actif
    const tileIsActive = tile.classList.contains("active");

    const items = tile.querySelectorAll(".mini-kpi[data-prev-kpi]");
    items.forEach((el) => {
      const k = (el.getAttribute("data-prev-kpi") || "").trim().toLowerCase();
      const isActive = tileIsActive && !!key && k === String(key).trim().toLowerCase();
      el.classList.toggle("is-active", isActive);
    });
  }



  let _CRITICITE_MIN = null;

  function syncCriticiteMinFromResponse(data, opts = {}) {
    const {
      commit = true,      // met Ã  jour _CRITICITE_MIN
      persist = true,     // Ã©crit dans localStorage
      refreshUi = true    // remet Ã  jour slider + valeur affichÃ©e
    } = opts || {};

    const v = Number(data?.criticite_min);
    if (!Number.isFinite(v)) return;

    const safe = Math.max(0, Math.min(100, v));

    if (commit) {
      _CRITICITE_MIN = safe;
    }

    if (persist) {
      localStorage.setItem(STORE_CRITICITE_MIN, String(safe));
    }

    if (refreshUi && typeof updateCriticiteMinUi === "function") {
      updateCriticiteMinUi();
    }
  }

  function getCriticiteMin() {
    return Number.isFinite(_CRITICITE_MIN) ? _CRITICITE_MIN : null;
  }

  function getCriticiteMinSafe(defv = null) {
    const v = _CRITICITE_MIN;
    return Number.isFinite(v) ? v : defv;
  }

  function critMinLabel() {
    const n = getCriticiteMinSafe(null);
    return Number.isFinite(n) ? String(n) : "â€”";
  }

  function priorityLabel(score100) {
    const sc = Math.max(0, Math.min(100, Number(score100 || 0)));

    if (sc >= 100) return "Rupture";
    if (sc >= 80) return "TrÃ¨s critique";
    if (sc >= 60) return "Critique";
    if (sc >= 40) return "Ã‰levÃ©e";
    if (sc >= 20) return "ModÃ©rÃ©e";
    return "Faible";
  }

  function updateCriticiteMinUi() {
    const slider = byId("analyseCriticiteMinRange");
    const value = byId("analyseCriticiteMinValue");
    const safe = Number.isFinite(_CRITICITE_MIN) ? _CRITICITE_MIN : CRITICITE_MIN_DEFAULT;
    if (slider) slider.value = String(safe);
    if (value) value.textContent = String(safe);
  }

  function initCriticiteMinFromStorage() {
    const raw = Number(localStorage.getItem(STORE_CRITICITE_MIN));
    _CRITICITE_MIN = Number.isFinite(raw)
      ? Math.max(0, Math.min(100, raw))
      : CRITICITE_MIN_DEFAULT;
    updateCriticiteMinUi();
  }

  function setCriticiteMinValue(v, persist = true) {
    const n = Math.max(0, Math.min(100, Number(v)));
    _CRITICITE_MIN = Number.isFinite(n) ? n : CRITICITE_MIN_DEFAULT;
    if (persist) localStorage.setItem(STORE_CRITICITE_MIN, String(_CRITICITE_MIN));
    updateCriticiteMinUi();
    return _CRITICITE_MIN;
  }

  function invalidateAnalyseCaches() {
    _riskDetailCache.clear();
    _posteDetailCache.clear();
    _posteDiagCache.clear();
    _matchPostesCache.clear();
    _matchEffDetailCache.clear();
    _compDetailCache.clear();
    _riskEvol3mCache.clear();
  }

  function getPostesScopeExpanded() {
    return (localStorage.getItem(STORE_POSTES_SCOPE_EXPANDED) || "0") === "1";
  }

  function setPostesScopeExpanded(v) {
    if (v) localStorage.setItem(STORE_POSTES_SCOPE_EXPANDED, "1");
    else localStorage.removeItem(STORE_POSTES_SCOPE_EXPANDED);
  }


  function isExpandableRiskDetail(kpiKey) {
    const k = (kpiKey || "").toString().trim();
    return k === "postes-scope" || k === "critiques-fragiles";
  }

  function getRiskDetailExpanded(kpiKey) {
    const k = (kpiKey || "").toString().trim();
    if (!isExpandableRiskDetail(k)) return false;
    return (localStorage.getItem(`${STORE_RISK_DETAIL_EXPANDED}_${k}`) || "0") === "1";
  }

  function setRiskDetailExpanded(kpiKey, value) {
    const k = (kpiKey || "").toString().trim();
    if (!isExpandableRiskDetail(k)) return;
    const storageKey = `${STORE_RISK_DETAIL_EXPANDED}_${k}`;
    if (value) localStorage.setItem(storageKey, "1");
    else localStorage.removeItem(storageKey);
  }

  function getRiskDetailLimit(kpiKey) {
    return getRiskDetailExpanded(kpiKey) ? 2000 : 10;
  }

  const _riskDetailCache = new Map();
  let _riskDetailReqSeq = 0;



  function sbNormLevel(v) {
    return (v ?? "").toString().trim().toLowerCase().normalize("NFD").replace(/[Ì€-Í¯]/g, "");
  }

  function sbLevelKey(v) {
    const raw = (v ?? "").toString().trim();
    if (!raw) return "";
    const up = raw.toUpperCase();
    if (["A", "B", "C", "D"].includes(up)) return up;
    const m = up.match(/([ABCD])/);
    if (m) return m[1];
    const sx = sbNormLevel(raw);
    if (sx === "1" || sx === "initial" || sx === "debutant" || sx.startsWith("deb")) return "A";
    if (sx === "2" || sx === "intermediaire" || sx.startsWith("inter")) return "B";
    if (sx === "3" || sx === "avance" || sx === "avancee" || sx.startsWith("avan") || sx.startsWith("adv")) return "C";
    if (sx === "4" || sx === "expert" || sx.startsWith("exp")) return "D";
    return "";
  }

  function sbLevelRank(v) {
    const k = sbLevelKey(v);
    return k === "A" ? 1 : k === "B" ? 2 : k === "C" ? 3 : k === "D" ? 4 : 0;
  }

  function sbLevelLabel(v) {
    const k = sbLevelKey(v);
    return k === "A" ? "DÃ©butant" : k === "B" ? "IntermÃ©diaire" : k === "C" ? "AvancÃ©" : k === "D" ? "Expert" : ((v ?? "â€”").toString().trim() || "â€”");
  }

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

  async function fetchRisquesDetail(portal, kpiKey, id_service, limit = 50, ref_mois = 0) {
    const svc = (id_service || "").trim();
    const crit = getCriticiteMinSafe(CRITICITE_MIN_DEFAULT);
    const critVal = Number.isFinite(crit) ? String(crit) : "";
    const ref = Math.max(0, Math.min(36, Number(ref_mois || 0)));

    const key = `${svc}|${kpiKey}|${limit}|${critVal}|${ref}`;

    if (_riskDetailCache.has(key)) return _riskDetailCache.get(key);

    const qs = buildQueryString({
      kpi: kpiKey,
      id_service: svc || null,
      criticite_min: critVal || null,
      ref_mois: ref,
      limit: limit
    });

    const url = `${portal.apiBase}/skills/analyse/risques/detail/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    _riskDetailCache.set(key, data);
    return data;
  }

  const _posteDetailCache = new Map();
  let _posteDetailReqSeq = 0;

  // Diagnostic dÃ©cisionnel (poste fragile) - endpoint dÃ©diÃ©
  const _posteDiagCache = new Map();      // key: id_poste|id_service|critMin|limit
  let _posteDiagReqSeq = 0;

  // Contexte du dernier poste ouvert (pour lazy-load dÃ©tail/couverture)
  let _analysePosteLastParams = { id_poste: "", id_service: "" };
  let _analysePosteDetailLoaded = false;  // dÃ©tail (endpoint /poste) chargÃ© ou non
  let _analysePosteDetailLoading = false; // anti double-call


  // Modal dÃ©tail poste (risques) â€” mode dÃ©cisionnel
  // _analysePosteShowAllCompetences est rÃ©utilisÃ© comme switch UI :
  // false = nâ€™afficher que les compÃ©tences Ã€ RISQUE (0/1 porteur au niveau requis)
  // true  = afficher toutes les compÃ©tences CRITIQUES (criticitÃ© >= criticite_min)
  let _analysePosteShowAllCompetences = false;
  let _analysePosteLastData = null;
  let _analysePosteFocusKey = "";



  async function fetchAnalysePosteDetail(portal, id_poste, id_service) {
    const svc = (id_service || "").trim();
    const key = `${id_poste}|${svc}`;
    if (_posteDetailCache.has(key)) return _posteDetailCache.get(key);

    const qs = buildQueryString({
      id_poste: id_poste,
      id_service: svc || null
    });

    const url = `${portal.apiBase}/skills/analyse/risques/poste/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    _posteDetailCache.set(key, data);
    return data;
  }

  async function fetchAnalysePosteDiagnostic(portal, id_poste, id_service, criticite_min, limit = 8) {
    const svc = (id_service || "").trim();

    const crit = (criticite_min === null || criticite_min === undefined || criticite_min === "")
      ? (getCriticiteMin() ?? null)
      : Number(criticite_min);

    const critVal = Number.isFinite(crit) ? String(crit) : "";
    const lim = Math.max(1, Math.min(8, Number(limit || 8)));

    const key = `${id_poste}|${svc}|${critVal}|${lim}`;
    if (_posteDiagCache.has(key)) return _posteDiagCache.get(key);

    const qs = buildQueryString({
      id_poste: id_poste,
      id_service: svc || null,
      criticite_min: critVal || null,
      limit: lim
    });

    const url = `${portal.apiBase}/skills/analyse/risques/poste/diagnostic/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    _posteDiagCache.set(key, data);
    return data;
  }

    // Dernier diagnostic chargÃ© (pour re-render quand on rebascule en "risques uniquement")
  let _analysePosteLastDiag = null;

function renderAnalysePosteDiagnosticOnly(diag, focusKey) {
  _analysePosteLastDiag = diag || null;

  const host = byId("analysePosteTabCompetences");
  if (!host) return;

  const comp = diag?.composantes || {};
  const critMin = Number(diag?.criticite_min ?? comp.criticite_min ?? getCriticiteMin() ?? 70);

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const score = Number(diag?.indice_fragilite ?? 0);
  const s = clamp(Math.round(score || 0), 0, 100);

  const nbF = Number(comp.nb_total_fragiles || 0);
  const fragLine = (nbF > 0) ? `${nbF} fragilitÃ©s dÃ©tectÃ©es` : `Aucune fragilitÃ© dÃ©tectÃ©e`;
  const nb0 = Number(comp.nb0 || 0);
  const nbTit = Number(diag?.poste?.nb_titulaires ?? comp.nb_titulaires ?? 0);

  function priorityLabel(score100) {
    const sc = clamp(Number(score100 || 0), 0, 100);
    if (sc >= 75) return "Critique";
    if (sc >= 50) return "Ã‰levÃ©";
    if (sc >= 25) return "ModÃ©rÃ©";
    return "Faible";
  }

  const prioLabel = priorityLabel(s);

  function posteDiagLecture(score100) {
    const sc = clamp(Number(score100 || 0), 0, 100);
    if (sc >= 75) return "Ce poste est fortement exposÃ© sur le pÃ©rimÃ¨tre analysÃ©.";
    if (sc >= 50) return "Ce poste prÃ©sente plusieurs fragilitÃ©s Ã  surveiller ou sÃ©curiser.";
    if (sc >= 25) return "Ce poste prÃ©sente une fragilitÃ© modÃ©rÃ©e.";
    return "Ce poste apparaÃ®t globalement sÃ©curisÃ© sur le pÃ©rimÃ¨tre analysÃ©.";
  }

  function scoreHue(score100) {
    const x = clamp(Number(score100 || 0), 0, 100) / 100;
    return Math.round(120 * (1 - x)); // 120=vert -> 0=rouge
  }

  function ring(score100) {
    const s = clamp(Math.round(Number(score100 || 0)), 0, 100);
    const size = 104;
    const stroke = 10;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - s / 100);
    const hue = scoreHue(s);
    const fill = `hsl(${hue} 70% 45%)`;

    return `
      <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
        <div style="position:relative; width:${size}px; height:${size}px;">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="position:absolute; inset:0;">
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${fill}" stroke-width="${stroke}"
                    stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                    transform="rotate(-90 ${size / 2} ${size / 2})" />
          </svg>
          <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">
            <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-kpi); line-height: var(--ns-leading-tight);">
              ${s}<span style="font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold);">%</span>
            </div>
          </div>
        </div>
        <div class="card-sub" style="margin:0;">FragilitÃ©</div>
      </div>
    `;
  }

  function priorityPill(label, score100) {
    const hue = scoreHue(score100);
    const border = `hsl(${hue} 70% 45% / 0.55)`;
    const bg = `hsl(${hue} 70% 45% / 0.12)`;
    const fg = `hsl(${hue} 70% 25%)`;

    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid ${border};
        background:${bg}; color:${fg}; font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">
        ${escapeHtml(label || "â€”")}
      </span>
    `;
  }


  function badge(txt, accent) {
    const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
    return `<span class="${cls}">${escapeHtml(txt || "â€”")}</span>`;
  }

  function pill(txt) {
    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid #d1d5db;
        background:#fff; color:#374151; font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">
        ${escapeHtml(txt || "â€”")}
      </span>
    `;
  }

  // (recoLabel / recoPill / typeLabel supprimÃ©s : plus de recommandations dans le bloc "Causes racines")


  // Conditions (robuste: si lâ€™API ne renvoie pas encore, on affiche â€œâ€”â€)
  const p = diag?.poste || {};
  const eduMinRaw = (p.niveau_education_minimum ?? p.education_minimum ?? p.edu_min ?? "");
  const eduMin = String(eduMinRaw ?? "").trim();
  const eduTxt = (eduMin && eduMin !== "0") ? eduMin : "Aucun";

  const domLabel = String(p.nsf_domaine_titre ?? p.nsf_domaine ?? p.nsf_domaine_code ?? "").trim();
  const domObl = (p.nsf_domaine_obligatoire === true);
  const domTxt = domLabel ? `${domLabel} ${domObl ? "(bloquant)" : "(indicatif)"}` : "â€”";

  const nbNecessaires = Number(p.nb_titulaires_necessaires ?? p.nb_titulaires_cible ?? comp.nb_titulaires_cible ?? 1);
  const releveTxt = "Renfort potentiel : immÃ©diat Ã  partir de 75% de matching, Ã  prÃ©parer entre 60% et 74%.";

  // Causes racines (accordÃ©ons) : analyse factuelle (pas de recommandations ici)
  const causes = diag?.causes || {};
  const cStruct = causes?.structure || null;
  const cDep = Array.isArray(causes?.dependance) ? causes.dependance : [];
  const cTrans = causes?.transmission || null;
  const cEff = Array.isArray(causes?.efficacite) ? causes.efficacite : [];
  const cSorties = causes?.sorties_approchantes || null;

  const hasStruct = !!cStruct && ((cStruct.poste_non_tenu === true) || Number(cStruct.gap_titulaires || 0) > 0 || Number(cStruct.nb_indisponibles || 0) > 0);
  const hasDep = cDep.length > 0;
  const hasTrans = !!cTrans && (
    Number(cTrans.nb_renforts_immediats || 0) <= 0 &&
    (Number(cTrans.nb_renforts_a_preparer || 0) > 0 || Number(cTrans.meilleur_matching || 0) >= 0)
  );
  const hasEff = cEff.length > 0;
  const hasSorties = !!cSorties && Number(cSorties.count || 0) > 0;

  const critLevelClass = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "sb-crit-l1";
    if (n >= 80) return "sb-crit-l5";
    if (n >= 60) return "sb-crit-l4";
    if (n >= 40) return "sb-crit-l3";
    if (n >= 20) return "sb-crit-l2";
    return "sb-crit-l1";
  };

  const critBadgeHtml = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return "â€”";
    return `<span class="sb-crit-badge ${critLevelClass(n)}">${escapeHtml(String(Math.round(n)))}</span>`;
  };

  const compCodeBadge = (code) =>
    `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code || "â€”")}</span>`;

  const nivBadgeHtml = (niv) => nsLevelBadgeHtml(niv, "Niveau de maÃ®trise");

  const critScoreBand = (v) => {
    const n = Number(v || 0);
    if (n >= 90) return 4;
    if (n >= 80) return 3;
    if (n >= 70) return 2;
    if (n >= 50) return 1;
    return 0;
  };

  const scoreEfficaciteUnit = (v) => {
    const b = critScoreBand(v);
    if (b >= 4) return 15;
    if (b === 3) return 12;
    if (b === 2) return 10;
    if (b === 1) return 8;
    return 6;
  };

  const scoreDependanceUnit = (v, relaisFaible) => {
    const b = critScoreBand(v);
    if (relaisFaible) {
      if (b >= 4) return 10;
      if (b === 3) return 8;
      if (b === 2) return 6;
      if (b === 1) return 4;
      return 3;
    }
    if (b >= 4) return 18;
    if (b === 3) return 14;
    if (b === 2) return 10;
    if (b === 1) return 8;
    return 6;
  };

  const depSans = cDep.filter(x => String(x?.type_risque || "").toUpperCase() === "SANS_RELAIS");
  const depLim = cDep.filter(x => String(x?.type_risque || "").toUpperCase() !== "SANS_RELAIS");

  const dependancePoints = Math.min(25,
    depSans.reduce((acc, x) => acc + scoreDependanceUnit(x?.poids_criticite, false), 0) +
    depLim.reduce((acc, x) => acc + scoreDependanceUnit(x?.poids_criticite, true), 0)
  );

  const depRiskLabel = (r) => "Porteur unique";

  const depRiskBadgeClass = (r) => "sb-badge--dep-limited";

  const renderDepTable = (list) => {
    if (!list.length) return "";
    return `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th style="width:110px;">Code</th>
              <th>CompÃ©tence</th>
              <th class="col-center" style="width:90px;">CriticitÃ©</th>
              <th class="col-center" style="width:150px;">Niveau attendu</th>
              <th class="col-center" style="width:64px;"></th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = String(r?.code_comp || r?.code || "â€”");
              const compId = String(r?.id_comp || r?.id_competence || "").trim();
              const intit = escapeHtml(r?.intitule || "â€”");
              const crit = critBadgeHtml(r?.poids_criticite);
              const niveau = analyseRequiredLevelBadgeHtml(r?.niveau_requis || r?.niveau_attendu || r?.niveau || "", "Niveau attendu");
              const btnCompetencePdf = compId ? `
                <button type="button"
                        class="sb-icon-btn sb-icon-btn--doc"
                        data-poste-dep-comp-pdf="${escapeHtml(compId)}"
                        title="Voir la fiche compÃ©tence PDF"
                        aria-label="Voir la fiche compÃ©tence PDF">
                  ${analysePdfIconSvg()}
                </button>
              ` : ``;

              return `
                <tr>
                  <td style="white-space:nowrap;">${compCodeBadge(code)}</td>
                  <td style="min-width:280px;">
                    <div style="font-size: var(--ns-text-md); font-weight: var(--ns-weight-bold); color:#111827;">${intit}</div>
                  </td>
                  <td class="col-center" style="white-space:nowrap;">${crit}</td>
                  <td class="col-center" style="white-space:nowrap;">${niveau}</td>
                  <td class="col-center" style="white-space:nowrap;">${btnCompetencePdf}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  };

  const renderEffTable = (list) => {
    if (!list.length) return "";
    const first = list[0] || {};
    if (String(first.kind || "") === "salarie" || first.id_effectif) {
      return `
        <div class="sb-help" style="margin-top:0;">
          Cette lecture part des titulaires du poste. La maÃ®trise actuelle indique la part des compÃ©tences pour lesquelles le niveau A/B/C/D requis est atteint, sans moyenne de notes.
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Collaborateur</th>
                <th class="col-center" style="width:160px;">MaÃ®trise actuelle</th>
                <th class="col-center" style="width:110px;">Ã‰cart</th>
                <th class="col-center" style="width:74px;">Voir</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(r => `
                <tr>
                  <td>
                    <div style="font-size: var(--ns-text-md); font-weight: var(--ns-weight-bold);">${escapeHtml(r?.full || "Collaborateur")}</div>
                    <div class="card-sub" style="margin:2px 0 0; font-size: var(--ns-text-xs);">${escapeHtml(String(r?.competences_ok ?? 0))}/${escapeHtml(String(r?.competences_total ?? 0))} compÃ©tences au niveau requis</div>
                  </td>
                  <td class="col-center"><span class="sb-badge">${escapeHtml(String(r?.maitrise_actuelle_pct ?? 0))}%</span></td>
                  <td class="col-center"><span class="sb-badge sb-badge--dep-none">-${escapeHtml(String(r?.ecart_pct ?? 0))}%</span></td>
                  <td class="col-center">
                    <button type="button"
                            class="sb-icon-btn poste-cause-match-person"
                            title="Voir"
                            aria-label="Voir lâ€™adÃ©quation au poste"
                            data-poste-cause-match-effectif="${escapeHtml(String(r?.id_effectif || ""))}"
                            data-poste-cause-match-poste="${escapeHtml(String(diag?.poste?.id_poste || ""))}"
                            data-poste-cause-match-service="${escapeHtml(String(diag?.poste?.id_service || ""))}">
                      ${analyseEyeIconSvg()}
                    </button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
    }
    return `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th style="width:110px;">Code</th>
              <th>CompÃ©tence</th>
              <th class="col-center" style="width:110px;">Requis</th>
              <th class="col-center" style="width:160px;">Ã‰cart au requis</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = String(r?.code_comp || r?.code || "â€”");
              const intit = escapeHtml(r?.intitule || "â€”");
              const req = nivBadgeHtml(r?.niveau_requis);
              const nDef = Number(r?.nb_en_defaut || 0);
              const nTit = Number(r?.nb_titulaires || 0);
              return `
                <tr>
                  <td style="white-space:nowrap;">${compCodeBadge(code)}</td>
                  <td style="min-width:280px;"><div style="font-size: var(--ns-text-md); font-weight: var(--ns-weight-bold);">${intit}</div></td>
                  <td class="col-center" style="white-space:nowrap;">${req}</td>
                  <td class="col-center" style="white-space:nowrap;"><span class="sb-badge">${escapeHtml(String(nDef))}</span><span style="color:#6b7280; font-size: var(--ns-text-xs); margin-left:6px;">/ ${escapeHtml(String(nTit))}</span></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  };

  const structureScoreFallback = (() => {
    if (!hasStruct) return 0;

    const nbT = Number(cStruct?.nb_titulaires || 0);
    const gapT = Number(cStruct?.gap_titulaires || 0);
    const nonTenu = (cStruct?.poste_non_tenu === true) || (nbT <= 0);

    if (nonTenu) return 100;
    return Math.min(45, Math.max(gapT, 0) * 15);
  })();

  const isStructureRupture = structureScoreFallback >= 100;
  const showSecondaryRiskShare = !isStructureRupture;

  const transmissionScoreFallback = (() => {
    const total = Number(cTrans?.pool_total || 0);
    const elig = Number(cTrans?.pool_eligible || 0);
    if (total <= 0) return 0;
    if (elig <= 0) return 5;
    if (elig < total) return 3;
    return 0;
  })();

  const efficaciteScoreFallback = (() => {
    if (!hasEff) return 0;
    const raw = cEff.reduce((acc, r) => {
      const nDef = Number(r?.nb_en_defaut || 0);
      return acc + (Math.max(nDef, 0) * scoreEfficaciteUnit(r?.poids_criticite));
    }, 0);
    return Math.min(45, raw);
  })();

  const getBackendScore = (key, fallback) => {
    const raw = Number(comp?.[key]);
    return Number.isFinite(raw) ? Math.max(0, raw) : Math.max(0, Number(fallback || 0));
  };

  const componentScores = {
    structure: getBackendScore("score_structurel", structureScoreFallback),
    sorties: getBackendScore("score_sorties_approchantes", 0),
    dependance: getBackendScore("score_dependance", dependancePoints),
    transmission: getBackendScore("score_renfort_potentiel", getBackendScore("score_transmission", transmissionScoreFallback)),
    efficacite: getBackendScore("score_efficacite", efficaciteScoreFallback)
  };

  const visibleComponentTotal =
    (hasStruct ? componentScores.structure : 0) +
    (hasSorties ? componentScores.sorties : 0) +
    (hasDep ? componentScores.dependance : 0) +
    (hasTrans ? componentScores.transmission : 0) +
    (hasEff ? componentScores.efficacite : 0);

  const shareOfVisibleCauses = (value) => {
    if (visibleComponentTotal <= 0) return 0;
    return Math.max(0, Math.round((Number(value || 0) / visibleComponentTotal) * 100));
  };

  const structureSharePct = shareOfVisibleCauses(componentScores.structure);
  const sortiesSharePct = shareOfVisibleCauses(componentScores.sorties);
  const dependanceSharePct = shareOfVisibleCauses(componentScores.dependance);
  const transmissionSharePct = shareOfVisibleCauses(componentScores.transmission);
  const efficaciteSharePct = shareOfVisibleCauses(componentScores.efficacite);

  const structureBody = (() => {
    if (!hasStruct) return "";
    const nbR = Number(cStruct?.nb_titulaires_rattaches ?? cStruct?.nb_titulaires ?? 0);
    const nbD = Number(cStruct?.nb_titulaires_disponibles ?? cStruct?.nb_titulaires ?? 0);
    const nbC = Number(cStruct?.nb_titulaires_cible || 1);
    const nbI = Number(cStruct?.nb_indisponibles || 0);
    const gapT = Number(cStruct?.gap_titulaires || 0);
    return `
      <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:0;">
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires nÃ©cessaires</div><div class="value">${escapeHtml(String(nbC))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires rattachÃ©s</div><div class="value">${escapeHtml(String(nbR))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires disponibles</div><div class="value">${escapeHtml(String(nbD))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">IndisponibilitÃ©s</div><div class="value">${escapeHtml(String(nbI))}</div></div>
      </div>
      ${gapT > 0 ? `<div class="sb-help" style="margin-top:10px;"><b>Couverture insuffisante</b> : il manque ${escapeHtml(String(gapT))} titulaire(s) disponible(s) par rapport au besoin du poste.</div>` : ``}
    `;
  })();

  const dependanceBody = (() => {
    if (!hasDep) return "";
    return `
      <div class="sb-help" style="margin-top:0;">
        Ce risque mesure les compÃ©tences pour lesquelles trop peu de personnes peuvent remplacer immÃ©diatement le titulaire au niveau requis.
      </div>
      ${renderDepTable(cDep)}
    `;
  })();

  const transmissionBody = (() => {
    if (!hasTrans) return "";
    const imm = Number(cTrans?.nb_renforts_immediats || 0);
    const prep = Number(cTrans?.nb_renforts_a_preparer || 0);
    const best = Number(cTrans?.meilleur_matching || 0);
    return `
      <div class="sb-help" style="margin-top:0;">
        Cette cause regarde les profils internes qui ne sont pas titulaires du poste, mais qui pourraient aider si le poste se fragilise.
      </div>
      <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:10px;">
        <div class="card" style="padding:10px; margin:0; min-width:190px; flex:1;"><div class="label">Renforts immÃ©diats â‰¥ 75%</div><div class="value">${escapeHtml(String(imm))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:190px; flex:1;"><div class="label">Renforts Ã  prÃ©parer 60-74%</div><div class="value">${escapeHtml(String(prep))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:190px; flex:1;"><div class="label">Meilleur matching disponible</div><div class="value">${escapeHtml(String(best))}%</div></div>
      </div>
    `;
  })();

  const efficaciteBody = (() => {
    if (!hasEff) return "";
    return renderEffTable(cEff);
  })();

  const sortiesBody = (() => {
    if (!hasSorties) return "";
    const items = Array.isArray(cSorties?.items) ? cSorties.items : [];
    return `
      <div class="sb-help" style="margin-top:0;">
        Ces sorties ne sont pas la cause principale actuelle, mais elles peuvent aggraver la fragilitÃ© dans les 3 prochains mois.
      </div>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead><tr><th>Collaborateur</th><th class="col-center" style="width:140px;">Date prÃ©vue</th><th style="width:220px;">Motif</th></tr></thead>
          <tbody>
            ${items.map(r => `<tr><td><b>${escapeHtml(r?.full || "Collaborateur")}</b></td><td class="col-center">${escapeHtml(r?.date_sortie || "â€”")}</td><td>${escapeHtml(r?.motif || "Sortie prÃ©vue")}</td></tr>`).join("") || `<tr><td colspan="3" class="col-center">${escapeHtml(String(cSorties?.count || 0))} sortie(s) approchante(s).</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  })();


  const causeDot = (kind) => {
    const color = kind === "main" ? "#ef4444" : (kind === "aggravant" ? "#f59e0b" : "#64748b");
    return `<span style="width:9px;height:9px;border-radius:999px;background:${color};display:inline-block;flex:0 0 auto;"></span>`;
  };

  const causesCard = `
    <div class="card" style="padding:12px; margin-top:12px;">
      <div class="card-title" style="margin:0 0 6px 0;">Pourquoi ce poste est fragile ?</div>
      <div class="card-sub" style="margin:0;">Ouvrez une cause pour voir ce qui est observÃ© et pourquoi cela pÃ¨se sur lâ€™indice.</div>

      ${(!hasStruct && !hasDep && !hasTrans && !hasEff && !hasSorties) ? `
        <div class="card-sub" style="margin-top:10px;">Aucune cause Ã  afficher.</div>
      ` : `
        ${hasStruct ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft is-open">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("main")}<span>Couverture du poste insuffisante</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                <span class="sb-badge sb-badge--risk-share">${escapeHtml(String(structureSharePct))}%</span>
                ${causeHelpButton("structure")}
                <span class="sb-acc-chevron">â–¾</span>
              </span>
            </button>
            <div class="sb-acc-body">${structureBody}</div>
          </div>
        ` : ``}

        ${hasEff ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("main")}<span>Niveau attendu non atteint</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(efficaciteSharePct))}%</span>` : ``}
                ${causeHelpButton("efficacite")}
                <span class="sb-acc-chevron">â–¾</span>
              </span>
            </button>
            <div class="sb-acc-body">${efficaciteBody}</div>
          </div>
        ` : ``}

        ${hasDep ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("main")}<span>CompÃ©tence trop dÃ©pendante d'une personne</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(dependanceSharePct))}%</span>` : ``}
                ${causeHelpButton("dependance")}
                <span class="sb-acc-chevron">â–¾</span>
              </span>
            </button>
            <div class="sb-acc-body">${dependanceBody}</div>
          </div>
        ` : ``}

        ${hasSorties ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("aggravant")}<span>Sortie approchante dâ€™un titulaire</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(sortiesSharePct))}%</span>` : ``}
                ${causeHelpButton("sorties")}
                <span class="sb-acc-chevron">â–¾</span>
              </span>
            </button>
            <div class="sb-acc-body">${sortiesBody}</div>
          </div>
        ` : ``}

        ${hasTrans ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("aggravant")}<span>Renfort potentiel insuffisant</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(transmissionSharePct))}%</span>` : ``}
                ${causeHelpButton("transmission")}
                <span class="sb-acc-chevron">â–¾</span>
              </span>
            </button>
            <div class="sb-acc-body">${transmissionBody}</div>
          </div>
        ` : ``}
      `}
    </div>
  `;


  function diagLine(label, value) {
    const v = (value === null || value === undefined || value === "") ? "â€”" : String(value);
    return `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #eef2f7;">
        <span style="font-size: var(--ns-text-sm); color:#64748b; line-height: var(--ns-leading-ui);">${escapeHtml(label)}</span>
        <span style="font-size: var(--ns-text-sm); color:#0f172a; font-weight: var(--ns-weight-bold); text-align:right; line-height: var(--ns-leading-ui);">${escapeHtml(v)}</span>
      </div>
    `;
  }

  // Le modal poste sâ€™arrÃªte au constat.
  // L'utilisateur peut ensuite utiliser ce poste comme point de dÃ©part d'une simulation RH.
  const idPosteContext = String(p?.id_poste || p?.id || diag?.id_poste || "").trim();
  const codePosteContext = String(p?.codif_client || p?.codif_poste || "").trim();
  const posteLabelContext = [codePosteContext, p?.intitule_poste || "Poste"].filter(Boolean).join(" Â· ");

  // Rendu
  host.innerHTML = `
    <div class="card" style="padding:12px; margin:0;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap;">
        <div style="flex:1; min-width:320px;">
          <div class="card-title" style="margin:0;">Diagnostic</div>

          <div class="card-sub" style="margin:8px 0 8px 0;font-size: var(--ns-text-md);line-height: var(--ns-leading-body);">
            ${posteDiagLecture(s)}
          </div>
          <div class="card-sub" style="margin:0 0 8px 0;font-size: var(--ns-text-sm);line-height: var(--ns-leading-body);font-weight: var(--ns-weight-bold);color:#475569;">
            Ã‰lÃ©ments pris en compte :
          </div>
          <div style="max-width:660px;">
            ${diagLine("DiplÃ´me minimum", eduTxt)}
            ${diagLine("Domaine de formation", domTxt)}
            ${diagLine("Nombre de titulaires nÃ©cessaires", String(nbNecessaires || 1))}
            ${diagLine("CriticitÃ© des compÃ©tences", `â‰¥ ${critMin}%`)}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
          ${ring(s)}
          ${priorityPill(prioLabel, s)}
        </div>
      </div>
    </div>

    ${causesCard}
  `;

    // AccordÃ©ons (Causes racines)
  host.querySelectorAll(".sb-acc-head").forEach(btnAcc => {
    const body = btnAcc.nextElementSibling;
    if (body) body.style.display = btnAcc.classList.contains("is-open") ? "" : "none";

    if (btnAcc.dataset.bound) return;
    btnAcc.dataset.bound = "1";

    btnAcc.addEventListener("click", () => {
      btnAcc.classList.toggle("is-open");
      const b = btnAcc.nextElementSibling;
      if (b) b.style.display = btnAcc.classList.contains("is-open") ? "" : "none";
    });
  });

  configureActionButton("btnAnalysePosteOpenSimulationContext", idPosteContext ? {
    type: "poste",
    title: `Poste Ã  travailler Â· ${posteLabelContext}`,
    poste_id: idPosteContext,
    poste_label: posteLabelContext,
    reason: "Analyse poste : construire un scÃ©nario d'organisation, remplacement, transfert de personne, transfert de charge ou recrutement.",
  } : null, (payload) => {
    openSimulationsRhContext(payload);
    closeAnalysePosteModal();
  });

}

    // ==============================
  // MATCHING (MVP)
  // - basÃ© sur /risques/poste (compÃ©tences requises + porteurs)
  // - liste postes = "postes fragiles" (source risques)
  // ==============================
  const _matchPostesCache = new Map(); // key: id_service -> items[]
  let _matchReqSeq = 0;
  let _matchSelectedPoste = "";
  const MATCH_TABLE_PREVIEW_LIMIT = 10;
  let _matchRowsExpanded = false;
  let _matchCurrentPosteId = "";
  let _matchCurrentPoste = null;
  let _matchCurrentItems = [];
  let _matchCurrentRowsCount = 0;

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
    if (s === "avancÃ©" || s === "avance" || s === "avancee" || s === "avancÃ©e") return 2;
    if (s === "expert") return 3;
    return 0;
  }

  function scoreComp(lvlAct, lvlReq) {
    if (!lvlAct) return 0;                 // absent
    if (lvlAct >= lvlReq) return 1;        // OK
    if (lvlAct === (lvlReq - 1)) return 0.6; // juste en dessous
    return 0.2;                            // trop bas
  }

  async function fetchMatchingPostes(portal, id_service, _modePostes) {
    const svc = (id_service || "").trim();
    const key = `tous|${svc || "__ALL__"}`;
    if (_matchPostesCache.has(key)) return _matchPostesCache.get(key);

    const data = await fetchRisquesDetail(portal, "postes-scope", svc, 2000);
    const items = Array.isArray(data?.items) ? data.items : [];

    _matchPostesCache.set(key, items);
    return items;
  }

  // DÃ©tail effectif (drilldown)
  const _matchEffDetailCache = new Map(); // key: id_poste|id_effectif|id_service|crit

  async function fetchMatchingEffectifDetail(portal, id_poste, id_effectif, id_service) {
    const svc = (id_service || "").trim();
    const key = `${id_poste}|${id_effectif}|${svc}`;
    if (_matchEffDetailCache.has(key)) return _matchEffDetailCache.get(key);

    const qs = buildQueryString({
      id_poste: id_poste,
      id_effectif: id_effectif,
      id_service: svc || null
    });

    const url = `${portal.apiBase}/skills/analyse/matching/effectif/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _matchEffDetailCache.set(key, data);
    return data;
  }

  async function fetchPrevisionsSortiesDetail(portal, horizonYears, id_service, limit = 2000) {
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
    qs.set("limit", String(limit || 2000));

    const url = `${apiBase}/skills/analyse/previsions/sorties/detail/${encodeURIComponent(id_contact)}?${qs.toString()}`;

    return await analyseApiJson(portal, url);
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

  async function analyseApiJson(portal, url, options) {
    const p = portal || _portalref || window.portal || window.PortalCommon || null;

    if (p && typeof p.apiJson === "function") {
      return await p.apiJson(url, options);
    }

    const opts = options ? Object.assign({}, options) : {};
    const headers = new Headers(opts.headers || {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {
      /* fallback sans session : l'API renverra l'erreur utile */
    }

    opts.headers = headers;

    const res = await fetch(url, opts);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const body = ct.includes("application/json") ? await res.json() : await res.text();

    if (!res.ok) {
      const detail = typeof body === "string"
        ? body
        : (body && (body.detail || body.message)) || JSON.stringify(body);
      throw new Error(detail || `HTTP ${res.status}`);
    }

    return body;
  }

  function buildAnalysePdfUrl(portal, docKey, id_poste) {
    const ctx = getPortalContext(portal);
    const posteId = String(id_poste || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");
    if (!posteId) throw new Error("id_poste manquant.");

    if (String(docKey || "") !== "fiche_poste_simple") {
      throw new Error("Document PDF non gÃ©rÃ©.");
    }

    const qs = new URLSearchParams();
    qs.set("id_poste", posteId);
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/pdf/fiche-poste-simple/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function openAnalysePdfInBrowser(portal, docKey, id_poste) {
    const url = buildAnalysePdfUrl(portal, docKey, id_poste);
    const win = window.open(url, "_blank", "noopener");

    if (!win) {
      throw new Error("Le navigateur a bloquÃ© lâ€™ouverture du PDF.");
    }

    return url;
  }

  function buildAnalyseMatchingPdfUrl(portal, id_poste, id_service) {
    const ctx = getPortalContext(portal);
    const posteId = String(id_poste || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");
    if (!posteId) throw new Error("SÃ©lectionne un poste avant dâ€™imprimer.");

    const qs = new URLSearchParams();
    qs.set("id_poste", posteId);
    const svc = String(id_service || "").trim();
    if (svc) qs.set("id_service", svc);
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/matching/poste/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  function buildAnalyseMatchingEffectifPdfUrl(portal, id_poste, id_effectif, id_service) {
    const ctx = getPortalContext(portal);
    const posteId = String(id_poste || "").trim();
    const effectifId = String(id_effectif || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");
    if (!posteId) throw new Error("SÃ©lectionne un poste avant dâ€™imprimer.");
    if (!effectifId) throw new Error("Collaborateur introuvable pour lâ€™impression.");

    const qs = new URLSearchParams();
    qs.set("id_poste", posteId);
    qs.set("id_effectif", effectifId);
    const svc = String(id_service || "").trim();
    if (svc) qs.set("id_service", svc);
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/analyse/matching/effectif/pdf/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }

  async function openAnalyseMatchingPdfInBrowser(portal, id_poste, id_service) {
    const url = buildAnalyseMatchingPdfUrl(portal, id_poste, id_service);
    await openAnalysePdfBlob(url, "Impression bloquÃ©e");
    return url;
  }

  async function openAnalyseMatchingEffectifPdfInBrowser(portal, id_poste, id_effectif, id_service) {
    const url = buildAnalyseMatchingEffectifPdfUrl(portal, id_poste, id_effectif, id_service);
    await openAnalysePdfBlob(url, "Impression bloquÃ©e");
    return url;
  }

  function buildAnalyseCollaborateurCompetencePdfUrl(portal, id_effectif, id_comp, id_poste) {
    const ctx = getPortalContext(portal);
    const effectifId = String(id_effectif || "").trim();
    const compId = String(id_comp || "").trim();
    const posteId = String(id_poste || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");
    if (!effectifId) throw new Error("Collaborateur introuvable pour lâ€™impression.");
    if (!compId) throw new Error("CompÃ©tence introuvable pour lâ€™impression.");

    const qs = new URLSearchParams();
    if (posteId) qs.set("id_poste", posteId);
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/collaborateurs/competences/fiche_pdf/${encodeURIComponent(ctx.id_contact)}/${encodeURIComponent(effectifId)}/${encodeURIComponent(compId)}?${qs.toString()}`;
  }

  async function openAnalyseCollaborateurCompetencePdfInBrowser(portal, id_effectif, id_comp, id_poste) {
    const url = buildAnalyseCollaborateurCompetencePdfUrl(portal, id_effectif, id_comp, id_poste);
    await openAnalysePdfBlob(url, "PDF compÃ©tence bloquÃ©");
    return url;
  }




  function getMatchingCurrentServiceId() {
    try {
      return window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
    } catch (_) {
      return "";
    }
  }

  function refreshMatchingPrintButtonState() {
    const btn = byId("btnAnalyseMatchingPrint");
    if (!btn) return;
    const hasPoste = !!String(_matchSelectedPoste || "").trim();
    btn.disabled = !hasPoste;
    btn.setAttribute("aria-disabled", hasPoste ? "false" : "true");
    btn.title = hasPoste ? "Imprimer les correspondances du poste sÃ©lectionnÃ©" : "SÃ©lectionne un poste avant dâ€™imprimer";
  }

  function rerenderCurrentMatchingCandidates() {
    if (!_matchCurrentPosteId) {
      renderMatchingHeaderActions(getMatchingCurrentServiceId());
      return;
    }
    renderMatchingCandidates(_matchCurrentPosteId, _matchCurrentPoste || {}, _matchCurrentItems || [], getMatchView());
  }

  function bindMatchingToggleButton() {
    const btn = byId("btnAnalyseMatchingToggle");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      _matchRowsExpanded = !_matchRowsExpanded;
      rerenderCurrentMatchingCandidates();
    });
  }

  function bindMatchingPrintButton(id_service) {
    const btn = byId("btnAnalyseMatchingPrint");
    if (!btn || btn.dataset.bound === "1") {
      refreshMatchingPrintButtonState();
      return;
    }
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      if (!String(_matchSelectedPoste || "").trim()) return;
      try {
        btn.disabled = true;
        await openAnalyseMatchingPdfInBrowser(_portalref || window.portal || null, _matchSelectedPoste, id_service || "");
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Impossible dâ€™ouvrir le PDF.", "error");
        else alert(e.message || "Impossible dâ€™ouvrir le PDF.");
      } finally {
        refreshMatchingPrintButtonState();
      }
    });
    refreshMatchingPrintButtonState();
  }

  function renderMatchingHeaderActions(id_service) {
    const actions = byId("analyseDetailActions");
    if (!actions) return;

    const rowsCount = Number(_matchCurrentRowsCount || 0);
    const showToggle = rowsCount > MATCH_TABLE_PREVIEW_LIMIT;
    const expanded = !!_matchRowsExpanded;

    actions.innerHTML = `
      ${showToggle ? `
        <button type="button" class="sb-btn sb-btn--init sb-btn--xs" id="btnAnalyseMatchingToggle">
          ${expanded ? "Afficher les 10 premiers" : "Afficher tout"}
        </button>
      ` : ""}
      <button type="button"
              id="btnAnalyseMatchingPrint"
              class="sb-icon-btn analyse-detail-print-btn"
              title="Imprimer"
              aria-label="Imprimer"
              ${String(_matchSelectedPoste || "").trim() ? "" : "disabled"}>
        ${analysePrintIconSvg()}
      </button>
    `;

    bindMatchingToggleButton();
    bindMatchingPrintButton(id_service);
  }





  function ensureMatchPersonModal() {
    let modal = byId("modalMatchPerson");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalMatchPerson" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
              <div class="modal-title" style="display:flex; gap:8px; align-items:center; min-width:0;">
                <span id="matchPersonModalTitle" style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">DÃ©tail</span>
                <span id="matchPersonModalTitleBadge" class="sb-badge" style="display:none;"></span>
              </div>
              <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <span id="matchPersonModalTitlePosteCode" class="sb-badge sb-badge-ref-poste-code" style="display:none;"></span>
                <span id="matchPersonModalTitlePosteText" class="card-sub" style="margin:0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
              </div>
            </div>
            <button type="button" class="modal-x" id="btnCloseMatchPersonModal" aria-label="Fermer">Ã—</button>
          </div>


          <div class="modal-body" id="matchPersonModalBody">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Chargementâ€¦</div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--soft" id="btnMatchPersonOpenBesoins" style="display:none;">Voir les besoins de formation</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnMatchPersonUseInSimulation" style="display:none;">Tester cette mobilitÃ© en Simulation RH</button>
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
    const badgeEl = byId("matchPersonModalTitleBadge");
    const posteCodeEl = byId("matchPersonModalTitlePosteCode");
    const posteTextEl = byId("matchPersonModalTitlePosteText");
    const b = byId("matchPersonModalBody");

    if (t) t.textContent = title || "DÃ©tail";

    // Reset header (sera rempli aprÃ¨s fetch)
    if (badgeEl) {
      badgeEl.textContent = "";
      badgeEl.className = "sb-badge";
      badgeEl.style.display = "none";
    }
    if (posteCodeEl) {
      posteCodeEl.textContent = "";
      posteCodeEl.style.display = "none";
    }
    if (posteTextEl) posteTextEl.textContent = "";

    if (b) b.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargementâ€¦</div></div>`;

    configureActionButton("btnMatchPersonUseInSimulation", null);
    configureActionButton("btnMatchPersonOpenBesoins", null);

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeMatchPersonModal() {
    const modal = byId("modalMatchPerson");
    if (!modal) return;

    // Nettoyage Ã©ventuel radar (ResizeObserver)
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

    const codifClient = (poste.codif_client || "").trim();
    const codifPoste = (poste.codif_poste || "").trim();
    const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

    const posteIntitule = (poste.intitule_poste || "").trim();
    const posteLabel = `${codeAffiche ? codeAffiche + " â€” " : ""}${(posteIntitule || "Poste")}`;

    const personLabel = person.full || "â€”";
    const svc = person.nom_service || "â€”";
    const lastCompetenceEval = person.derniere_evaluation_competences || person.last_competence_eval_date || "";
    const lastEntretienIndividuel = person.dernier_entretien_individuel || person.last_entretien_individuel_date || "";
    const isTit = !!person.is_titulaire;

    const pa = person.poste_actuel || {};
    const paCodifClient = (pa.codif_client || "").trim();
    const paCodifPoste = (pa.codif_poste || "").trim();
    const paCodeAffiche = (paCodifClient !== "") ? paCodifClient : paCodifPoste;
    const paIntitule = (pa.intitule_poste || "").trim();

    let posteActuelLabel = "Aucun poste";
    const paId = (person.id_poste_actuel || "").toString().trim();
    if (paId) {
      if (person.poste_actuel_hors_scope) {
        posteActuelLabel = "Hors pÃ©rimÃ¨tre";
      } else if (paCodeAffiche || paIntitule) {
        posteActuelLabel = `${paCodeAffiche ? paCodeAffiche + " â€” " : ""}${paIntitule || "Poste"}`;
      } else {
        posteActuelLabel = "RenseignÃ©";
      }
    }

    function matchingRing(score100) {
      const clampLocal = (n, min, max) => Math.max(min, Math.min(max, n));
      const s = clampLocal(Math.round(Number(score100 || 0)), 0, 100);

      const size = 104;
      const stroke = 10;
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - s / 100);

      const hue = Math.round(120 * (s / 100));
      const fill = `hsl(${hue} 70% 45%)`;

      return `
        <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
          <div style="position:relative; width:${size}px; height:${size}px;">
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="position:absolute; inset:0;">
              <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
              <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${fill}" stroke-width="${stroke}"
                      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                      transform="rotate(-90 ${size / 2} ${size / 2})" />
            </svg>
            <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">
              <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-kpi); line-height: var(--ns-leading-tight);">
                ${s}<span style="font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold);">%</span>
              </div>
            </div>
          </div>
          <div class="card-sub" style="margin:0;">Matching</div>
        </div>
      `;
    }

    function statusBadge(etat) {
      const s = String(etat || "").toLowerCase();
      if (s === "ok") return `<span class="sb-badge sb-badge--success">OK</span>`;
      if (s === "improvable" || s === "ameliorable" || s === "amÃ©liorable") return `<span class="sb-badge sb-badge--success">AmÃ©liorable</span>`;
      if (s === "under") return `<span class="sb-badge sb-badge--warning">Ã€ renforcer</span>`;
      return `<span class="sb-badge sb-badge--danger">Manquante</span>`;
    }

    function fmtScore(v) {
      if (v === null || v === undefined || v === "") return "â€”";
      const n = Number(v);
      if (Number.isNaN(n)) return "â€”";
      return (Math.round(n * 10) / 10).toString();
    }

    function critLevel(p) {
      const n = Number(p);
      if (!Number.isFinite(n)) return 1;
      if (n >= 90) return 5;
      if (n >= 70) return 4;
      if (n >= 50) return 3;
      if (n >= 30) return 2;
      return 1;
    }

    function critBadgeHtml(p) {
      const n = Number(p);
      const txt = Number.isFinite(n) ? String(Math.round(n)) : "â€”";
      const lvl = critLevel(n);
      return `<span class="sb-crit-badge sb-crit-l${lvl}" title="CriticitÃ© (poids)">${escapeHtml(txt)}</span>`;
    }

    function nivBadgeHtml(v) {
      return nsLevelBadgeHtml(v, "Niveau de maÃ®trise");
    }

    function domainPill(it) {
      const txt = ((it?.domaine_titre_court || it?.domaine || "") ?? "").toString().trim();
      if (!txt) return "";
      const rawCol = it?.domaine_couleur ?? it?.domaine_color ?? it?.domaine_couleur_hex ?? it?.couleur_domaine;
      const col = normalizeColor(rawCol);
      const style = col ? ` style="--dom-color:${escapeHtml(col)};"` : "";
      return `<span class="sb-badge-domaine sb-badge-domaine--soft"${style}>${escapeHtml(txt)}</span>`;
    }

    function renderCritDetailsRow(uid, arr) {
      const a = Array.isArray(arr) ? arr : [];
      if (!a.length) return "";

      const rows = a.map((x, i) => {
        const nom = (x?.nom || "").toString().trim();
        const code = (x?.code_critere || "").toString().trim();
        const title = (nom || code || "CritÃ¨re").trim();

        const n = (x?.niveau === null || x?.niveau === undefined) ? null : Number(x.niveau);
        const pts = (n !== null && Number.isFinite(n)) ? `${Math.round(n)}/4` : "â€”";

        const lib = (x?.libelle || "").toString().trim() || "â€”";
        const border = (i < a.length - 1) ? "border-bottom:1px solid #eef2f7;" : "";

        return `
          <tr>
            <td style="padding:7px 8px; ${border} font-weight: var(--ns-weight-medium); color:#111827; vertical-align:top;">${escapeHtml(title)}</td>
            <td style="padding:7px 8px; ${border} width:70px; text-align:center; font-weight: var(--ns-weight-bold); color:#111827; vertical-align:top;">${escapeHtml(pts)}</td>
            <td style="padding:7px 8px; ${border} color:#6b7280; vertical-align:top;">${escapeHtml(lib)}</td>
          </tr>
        `;
      }).join("");

      return `
        <tr data-crit-row="${escapeHtml(uid)}" style="display:none;">
          <td colspan="8" style="padding:0;">
            <div style="padding:10px 12px; border-top:1px dashed #e5e7eb; background:#fbfbfb;">
              <table style="width:100%; border-collapse:collapse; font-size: var(--ns-text-xs); line-height: var(--ns-leading-ui);">
                <tbody>${rows}</tbody>
              </table>
            </div>
          </td>
        </tr>
      `;
    }

    const rowsHtml = items.map((it, idx) => {
      const uid = `crit_${idx}`;
      const code = it?.code || it?.id_comp || "â€”";
      const compId = String(it?.id_comp || "").trim();
      const intitule = it?.intitule || "";
      const poids = Number(it?.poids_criticite || 0);
      const nivReq = it?.niveau_requis;
      const noteMax = fmtScore(it?.seuil);
      const atteint = fmtScore(it?.score);
      const nivAt = it?.niveau_atteint;

      const badgesTop = `
        <div class="sb-badges" style="flex-wrap:wrap;">
          <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>
          ${domainPill(it)}
        </div>
      `;

      const hasCrit = Array.isArray(it?.criteres) && it.criteres.length > 0;
      const btnCrit = hasCrit ? `
        <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-crit-toggle="${escapeHtml(uid)}" aria-expanded="false" style="margin-top:6px;">
          <span data-crit-caret style="margin-right:6px;">â–¸</span>Voir les Ã©valuations
        </button>
      ` : ``;

      const btnCompetencePdf = compId ? `
        <button type="button"
                class="sb-icon-btn sb-icon-btn--doc"
                data-match-competence-pdf="${escapeHtml(compId)}"
                title="Voir la fiche compÃ©tence PDF"
                aria-label="Voir la fiche compÃ©tence PDF">
          ${analysePdfIconSvg()}
        </button>
      ` : ``;

      const mainRow = `
        <tr>
          <td style="vertical-align:top;">
            ${badgesTop}
            <div style="font-weight: var(--ns-weight-medium); font-size: var(--ns-text-sm); line-height: var(--ns-leading-title); color:#111827; margin-top:4px;">${escapeHtml(intitule)}</div>
            ${btnCrit}
          </td>
          <td class="col-center">${critBadgeHtml(poids)}</td>
          <td class="col-center">${nivBadgeHtml(nivReq)}</td>
          <td class="col-center"><span class="sb-badge" title="Note maximale du niveau requis">${escapeHtml(String(noteMax))}</span></td>
          <td class="col-center" style="border-left:1px solid #d1d5db;"><span class="sb-badge" title="Note atteinte">${escapeHtml(String(atteint))}</span></td>
          <td class="col-center">${nivBadgeHtml(nivAt)}</td>
          <td class="col-center">${statusBadge(it?.etat)}</td>
          <td class="col-center">${btnCompetencePdf}</td>
        </tr>
      `;

      const critRow = renderCritDetailsRow(uid, it?.criteres);
      return mainRow + critRow;
    }).join("");

    const RADAR_MAX_AXES = 12;
    const radarAxesAll = items.map((it) => {
      const w = Number(it.poids || it.poids_criticite || 1);
      const scoreN = Number(it.score_24 ?? it.score ?? it.resultat_eval ?? 0);
      const seuilN = Number(it.seuil_24 ?? it.seuil ?? 0);
      const et = String(it.etat || "").toLowerCase();
      const statusRank = (et === "missing") ? 3 : (et === "under" ? 2 : (et === "improvable" ? 1 : 0));
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
    const radarCompEmpty = radarTop.length < 3;

    function normDomainKey(s) {
      const v = (s ?? "").toString().trim();
      return v ? v.toLowerCase() : "__non_classe__";
    }

    function shortRadarLabel(s, maxLen) {
      const v = (s ?? "").toString().trim();
      if (!v) return "â€”";
      if (v.length <= maxLen) return v;
      return v.slice(0, Math.max(4, maxLen - 1)) + "â€¦";
    }

    const domMap = new Map();
    items.forEach((it) => {
      const raw = ((it?.domaine_titre_court || it?.domaine || "") ?? "").toString().trim();
      const label = raw || "Non classÃ©";
      const key = normDomainKey(label);

      const poidsN = Number(it?.poids_criticite || 1);
      const w = (Number.isFinite(poidsN) && poidsN > 0) ? poidsN : 1;
      const scoreN = Number(it?.score_24 ?? it?.score ?? it?.resultat_eval ?? 0);
      const seuilN = Number(it?.seuil_24 ?? it?.seuil ?? 0);
      const ratio = (seuilN > 0 && Number.isFinite(scoreN))
        ? Math.max(0, Math.min(scoreN / seuilN, 1))
        : 0;

      let g = domMap.get(key);
      if (!g) {
        g = { key, label, poids: 0, weightedRatio: 0, attendu: 0, atteint: 0, nb: 0 };
        domMap.set(key, g);
      }

      g.poids += w;
      g.weightedRatio += (w * ratio);
      g.attendu += (Number.isFinite(seuilN) ? seuilN : 0);
      g.atteint += (Number.isFinite(scoreN) ? scoreN : 0);
      g.nb += 1;
    });

    const domainAxesAll = Array.from(domMap.values()).map((g) => {
      const ratio = g.poids > 0 ? Math.max(0, Math.min(g.weightedRatio / g.poids, 1)) : 0;
      return {
        key: g.key,
        label: g.label,
        code: shortRadarLabel(g.label, 15),
        nb: g.nb || 0,
        poids: Math.round(Number(g.poids || 0)),
        attendu: Number(g.attendu || 0),
        atteint: Number(g.atteint || 0),
        ratio: ratio,
      };
    }).sort((a, b) => {
      const d1 = (b.poids - a.poids);
      if (d1) return d1;
      return String(a.label || "").localeCompare(String(b.label || ""));
    });

    const domainAxesRadar = domainAxesAll.slice(0, RADAR_MAX_AXES);
    const radarDomainEmpty = domainAxesRadar.length < 3;

    const radarHtmlComp = radarCompEmpty
      ? `<div class="card-sub" style="color:#6b7280;">Radar indisponible (moins de 3 compÃ©tences).</div>`
      : `
        <div style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#ffffff;">
          <canvas id="matchPersonRadarCanvas" style="width:100%; height:520px; display:block;"></canvas>
        </div>
      `;

    const radarHtmlDomain = radarDomainEmpty
      ? `<div class="card-sub" style="color:#6b7280;">Radar indisponible (moins de 3 domaines).</div>`
      : `
        <div style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; background:#ffffff;">
          <canvas id="matchDomainRadarCanvas" style="width:100%; height:520px; display:block;"></canvas>
        </div>
      `;

    let _matchRadarView = "comp";

    host.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">

        <div class="card" style="padding:12px; margin:0;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
            <div style="min-width:0;">
              <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-text-lg); line-height: var(--ns-leading-tight); min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${escapeHtml(personLabel)}
              </div>

              ${(!isTit ? `
                <div class="card-sub" style="margin:6px 0 0 0;">
                  Poste actuel : ${escapeHtml(posteActuelLabel)}
                </div>
              ` : ``)}

              <div class="card-sub" style="margin:4px 0 0 0;">
                Service : ${escapeHtml(svc)}
              </div>
              <div class="card-sub" style="margin:4px 0 0 0;">
                DerniÃ¨re Ã©valuation de compÃ©tences : ${escapeHtml(lastCompetenceEval ? formatDateFr(lastCompetenceEval) : "â€”")}
              </div>
              <div class="card-sub" style="margin:4px 0 0 0;">
                Dernier entretien individuel : ${escapeHtml(lastEntretienIndividuel ? formatDateFr(lastEntretienIndividuel) : "â€”")}
              </div>
            </div>

            <div style="flex:0 0 auto;">
              ${matchingRing(stats.score_pct)}
            </div>
          </div>
        </div>

        <div class="card" style="padding:0; margin:0; overflow:hidden;">
          <button type="button" data-match-accordion-toggle="radar" aria-expanded="true"
                  style="width:100%; border:0; background:transparent; padding:12px; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer; text-align:left;">
            <span class="card-title" style="margin:0;">Radar</span>
            <span data-match-accordion-caret="radar" style="font-weight: var(--ns-weight-bold); color:#6b7280;">â–¾</span>
          </button>
          <div id="matchPersonRadarPanel" data-match-accordion-panel="radar" style="padding:0 12px 12px 12px;">
            <div class="sb-actions" style="justify-content:flex-start; margin:0 0 10px 0; gap:6px;">
              <button type="button" id="btnMatchRadarViewComp" class="sb-btn sb-btn--accent sb-btn--xs">Vue compÃ©tence</button>
              <button type="button" id="btnMatchRadarViewDomain" class="sb-btn sb-btn--soft sb-btn--xs">Vue domaine compÃ©tence</button>
            </div>
            <div id="matchRadarPanelComp">${radarHtmlComp}</div>
            <div id="matchRadarPanelDomain" style="display:none;">${radarHtmlDomain}</div>
          </div>
        </div>

        <div class="card" style="padding:0; margin:0; overflow:hidden;">
          <button type="button" data-match-accordion-toggle="table" aria-expanded="false"
                  style="width:100%; border:0; background:transparent; padding:12px; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer; text-align:left;">
            <span class="card-title" style="margin:0;">DÃ©tail des compÃ©tences</span>
            <span data-match-accordion-caret="table" style="font-weight: var(--ns-weight-bold); color:#6b7280;">â–¸</span>
          </button>
          <div id="matchPersonTablePanel" data-match-accordion-panel="table" style="display:none; padding:0 12px 12px 12px;">
            <div class="table-wrap" style="margin-top:0;">
              <table class="sb-table">
                <thead>
                  <tr>
                    <th rowspan="2" style="min-width:320px;">CompÃ©tence</th>
                    <th colspan="3" class="col-center" style="background:#f9fafb;">BESOIN DU POSTE</th>
                    <th colspan="3" class="col-center" style="background:#f9fafb; border-left:1px solid #d1d5db;">PROFIL Ã‰VALUÃ‰</th>
                    <th rowspan="2" class="col-center" style="width:54px;"></th>
                  </tr>
                  <tr>
                    <th class="col-center" style="width:90px;">CriticitÃ©</th>
                    <th class="col-center" style="width:130px;">Niveau<br>requis</th>
                    <th class="col-center" style="width:90px;">Note max.</th>
                    <th class="col-center" style="width:90px; border-left:1px solid #d1d5db;">Atteint</th>
                    <th class="col-center" style="width:140px;">Niveau<br>atteint</th>
                    <th class="col-center" style="width:120px;">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml || `<tr><td colspan="8" class="col-center" style="color:#6b7280;">Aucune compÃ©tence requise.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    const effectifIdForAction = String(person.id_effectif || person.id_collaborateur || person.id || "").trim();
    const posteIdForAction = String(poste.id_poste || poste.id || "").trim();
    const needsCount = items.filter((it) => {
      const etat = String(it?.etat || "").trim().toLowerCase();
      if (!etat) return false;
      return !["ok", "valid", "valide", "validÃ©"].includes(etat);
    }).length;

    const matchSimulationPayload = !isTit ? {
      type: "matching_candidat",
      title: `MobilitÃ© Ã  tester Â· ${String(personLabel || "Profil")} vers ${String(posteLabel || "Poste")}`,
      poste_id: posteIdForAction,
      poste_label: posteLabel,
      effectif_id: effectifIdForAction,
      effectif_label: personLabel,
      reason: "Matching candidat : tester une mobilitÃ© interne, l'effet sur le poste cible et l'effet domino sur le poste d'origine.",
      suggested_brick: "mobilite_effectif",
    } : null;

    const titularTrainingPayload = (isTit && effectifIdForAction && needsCount > 0) ? {
      type: "matching_titulaire",
      focus: "effectif",
      id_effectif: effectifIdForAction,
      effectif_id: effectifIdForAction,
      effectif_label: personLabel,
      id_poste: posteIdForAction,
      poste_id: posteIdForAction,
      poste_label: posteLabel,
      message: `${needsCount} compÃ©tence${needsCount > 1 ? "s" : ""} Ã  renforcer sur le poste actuel.`,
    } : null;

    configureActionButton("btnMatchPersonUseInSimulation", matchSimulationPayload, (payload) => {
      openSimulationsRhContext(payload);
      closeMatchPersonModal();
    });

    configureActionButton("btnMatchPersonOpenBesoins", titularTrainingPayload, (payload) => {
      openBesoinsFormations(payload);
      closeMatchPersonModal();
    });

    host.querySelectorAll("[data-crit-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const uid = btn.getAttribute("data-crit-toggle");
        if (!uid) return;
        const row = host.querySelector(`tr[data-crit-row="${uid}"]`);
        if (!row) return;

        const open = (row.style.display === "none");
        row.style.display = open ? "" : "none";
        btn.setAttribute("aria-expanded", open ? "true" : "false");

        const caret = btn.querySelector("[data-crit-caret]");
        if (caret) caret.textContent = open ? "â–¾" : "â–¸";
      });
    });

    host.querySelectorAll("[data-match-competence-pdf]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const compId = (btn.getAttribute("data-match-competence-pdf") || "").trim();
        const effectifId = String(person.id_effectif || person.id_collaborateur || person.id || "").trim();
        const posteId = String(poste.id_poste || poste.id || "").trim();
        if (!compId || !effectifId) return;

        try {
          btn.disabled = true;
          await openAnalyseCollaborateurCompetencePdfInBrowser(_portalref || window.portal || null, effectifId, compId, posteId);
        } catch (e) {
          showAnalyseHelp("PDF compÃ©tence indisponible", `<p>${escapeHtml(errMsg(e))}</p>`);
        } finally {
          btn.disabled = false;
        }
      });
    });

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

    function renderRadarNow() {
      const panel = byId("matchPersonRadarPanel");
      if (!panel || panel.style.display === "none") return;

      if (_matchRadarView === "domain") {
        if (radarDomainEmpty) return;
        const canvasDomain = byId("matchDomainRadarCanvas");
        if (!canvasDomain) return;
        drawRadarChart(canvasDomain, domainAxesRadar);
        return;
      }

      if (radarCompEmpty) return;
      const canvas = byId("matchPersonRadarCanvas");
      if (!canvas) return;
      drawRadarChart(canvas, radarTop);
    }

    const btnRadarComp = byId("btnMatchRadarViewComp");
    const btnRadarDomain = byId("btnMatchRadarViewDomain");
    const radarPanelComp = byId("matchRadarPanelComp");
    const radarPanelDomain = byId("matchRadarPanelDomain");

    function setRadarView(which) {
      const isDomain = which === "domain";
      _matchRadarView = isDomain ? "domain" : "comp";

      if (radarPanelComp) radarPanelComp.style.display = isDomain ? "none" : "";
      if (radarPanelDomain) radarPanelDomain.style.display = isDomain ? "" : "none";

      if (btnRadarComp) {
        btnRadarComp.classList.toggle("sb-btn--accent", !isDomain);
        btnRadarComp.classList.toggle("sb-btn--soft", isDomain);
      }
      if (btnRadarDomain) {
        btnRadarDomain.classList.toggle("sb-btn--accent", isDomain);
        btnRadarDomain.classList.toggle("sb-btn--soft", !isDomain);
      }

      setTimeout(renderRadarNow, 0);
    }

    if (btnRadarComp && !btnRadarComp.dataset.bound) {
      btnRadarComp.dataset.bound = "1";
      btnRadarComp.addEventListener("click", () => setRadarView("comp"));
    }
    if (btnRadarDomain && !btnRadarDomain.dataset.bound) {
      btnRadarDomain.dataset.bound = "1";
      btnRadarDomain.addEventListener("click", () => setRadarView("domain"));
    }

    host.querySelectorAll("[data-match-accordion-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = (btn.getAttribute("data-match-accordion-toggle") || "").trim();
        if (!key) return;
        const panel = host.querySelector(`[data-match-accordion-panel="${key}"]`);
        const caret = host.querySelector(`[data-match-accordion-caret="${key}"]`);
        if (!panel) return;

        const open = panel.style.display === "none";
        panel.style.display = open ? "" : "none";
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (caret) caret.textContent = open ? "â–¾" : "â–¸";
        if (open && key === "radar") setTimeout(renderRadarNow, 0);
      });
    });

    setTimeout(renderRadarNow, 0);

    const modal = byId("modalMatchPerson");
    if (modal) {
      if (modal.__matchRadarObs) {
        try { modal.__matchRadarObs.disconnect(); } catch (e) { }
        modal.__matchRadarObs = null;
      }

      const radarPanel = byId("matchPersonRadarPanel");
      if (radarPanel && typeof ResizeObserver !== "undefined") {
        const obs = new ResizeObserver(() => renderRadarNow());
        obs.observe(radarPanel);
        modal.__matchRadarObs = obs;
      }
    }
  }

  async function showMatchPersonDetailModal(portal, id_poste, id_effectif, id_service) {
    openMatchPersonModal("DÃ©tail matching");

    try {
      const data = await fetchMatchingEffectifDetail(portal, id_poste, id_effectif, id_service);

      const poste = data?.poste || {};
      const person = data?.person || {};

      // Header: Nom + badge Titulaire/Candidat + code poste + intitulÃ©
      const personFull = (person.full || "Personne").toString().trim() || "Personne";
      const isTit = !!person.is_titulaire;

      const codifClient = (poste.codif_client || "").trim();
      const codifPoste = (poste.codif_poste || "").trim();
      const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

      const posteIntitule = (poste.intitule_poste || "").trim() || "Poste";

      const t = byId("matchPersonModalTitle");
      const badgeEl = byId("matchPersonModalTitleBadge");
      const posteCodeEl = byId("matchPersonModalTitlePosteCode");
      const posteTextEl = byId("matchPersonModalTitlePosteText");

      if (t) t.textContent = personFull;

      if (badgeEl) {
        badgeEl.textContent = isTit ? "Titulaire" : "Candidat";
        badgeEl.className = isTit ? "sb-badge sb-badge--titulaire" : "sb-badge sb-badge--candidat";
        badgeEl.style.display = "inline-flex";
      }

      if (posteCodeEl) {
        posteCodeEl.textContent = codeAffiche || "";
        posteCodeEl.style.display = codeAffiche ? "inline-flex" : "none";
      }

      if (posteTextEl) posteTextEl.textContent = posteIntitule;


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
            <div class="card-title" style="margin-bottom:0;">${analyseDetailTitleHtml("Postes", "matchingPostes")}</div>
            <div id="matchPosteList" style="margin-top:10px; display:flex; flex-direction:column; gap:6px;"></div>
          </div>

          <div class="card" style="padding:12px; margin:0; flex:1;">
            <div class="card-title" style="margin-bottom:6px;">${analyseDetailTitleHtml("Candidats", "candidats")}</div>
            <div id="matchResult" style="margin-top:10px;">
              <div class="card-sub" style="margin:0; color:#6b7280;">SÃ©lectionne un poste.</div>
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
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun poste trouvÃ©.</div>`;
      return;
    }

    host.innerHTML = list.map(r => {
      const idp = (r.id_poste || "").toString().trim();
      const intitule = (r.intitule_poste || "").trim() || "â€”";
      const codifClient = (r.codif_client || "").trim();
      const codifPoste = (r.codif_poste || "").trim();
      const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

      const svc = (r.nom_service || "").trim() || "â€”";
      const bottom = `${(codeAffiche || "â€”")}${svc ? " â€¢ " : ""}${svc}`.trim();

      const nbRattaches = Number(r.nb_titulaires_rattaches);
      const sansTitulaire = Number.isFinite(nbRattaches) && nbRattaches <= 0;
      const liseretStyle = sansTitulaire ? `box-shadow:inset 4px 0 0 #ef4444;` : ``;
      const titleAttr = sansTitulaire ? ` title="Aucun titulaire affectÃ© sur ce poste"` : ``;

      const isActive = selectedId && idp === selectedId;
      const style = isActive
        ? `border-color:var(--reading-accent); background:color-mix(in srgb, var(--reading-accent) 8%, #fff); ${liseretStyle}`
        : `border-color:#e5e7eb; background:#fff; ${liseretStyle}`;

      return `
        <button type="button"
                class="btn-secondary"
                data-match-id_poste="${escapeHtml(idp)}"
                ${titleAttr}
                style="text-align:left; margin:0; ${style}">
          <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-text-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(intitule)}
          </div>
          <div style="font-size: var(--ns-text-xs); color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(bottom)}
          </div>
        </button>
      `;
    }).join("");
  }

  function computeCandidatesFromPosteDetail(data) {
    const comps = Array.isArray(data?.competences) ? data.competences : [];
    if (!comps.length) return [];

    // Liste des compÃ©tences requises + poids
    const critMin = Number(data?.criticite_min);
    const critMinVal = Number.isFinite(critMin) ? critMin : (getCriticiteMin() ?? 0);
    const compReq = comps.map(c => {
      const code = (c.code || c.id_competence || "").toString().trim(); // on privilÃ©gie code
      const lvlReq = nivReqToNum(c.niveau_requis);
      const w = Number(c.poids_criticite || 1);
      const isCrit = w >= critMinVal;
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
            full: `${prenom} ${nom}`.trim() || "â€”",
            nom_service: (p.nom_service || "").trim() || "â€”",
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

  function renderMatchingCandidates(id_poste_selected, poste, candidates, view) {
    const host = byId("matchResult");
    if (!host) return;

    const list = Array.isArray(candidates) ? candidates : [];
    const posteCible = (id_poste_selected || "").toString().trim();
    const v = (view || getMatchView() || "candidats").toString().trim().toLowerCase();

    _matchCurrentPosteId = posteCible;
    _matchCurrentPoste = poste || {};
    _matchCurrentItems = list;

    if (!list.length) {
      _matchCurrentRowsCount = 0;
      _matchRowsExpanded = false;
      renderMatchingHeaderActions(getMatchingCurrentServiceId());
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun candidat dÃ©tectÃ© (aucun candidat ne possÃ¨de les compÃ©tences du poste).</div>`;
      return;
    }

    // --- Titulaires vs Candidats : on sâ€™appuie sur un flag si lâ€™API le donne, sinon sur id_poste_actuel
    function isTitulaire(c) {
      if (!c) return false;

      if (c.is_titulaire === true || c.est_titulaire === true || c.titulaire === true || c.is_on_poste === true) return true;
      if (String(c.is_titulaire || "").toLowerCase() === "true") return true;

      const posteActuel = String(c.id_poste_actuel || "").trim();
      return !!posteCible && !!posteActuel && posteActuel === posteCible;
    }

    const titulairesAll = list.filter(isTitulaire);
    const candidatsAll = list.filter(c => !isTitulaire(c));

    const rows = (v === "titulaire") ? titulairesAll : candidatsAll;
    _matchCurrentRowsCount = rows.length;
    if (_matchCurrentRowsCount <= MATCH_TABLE_PREVIEW_LIMIT) _matchRowsExpanded = false;
    const top = _matchRowsExpanded ? rows : rows.slice(0, MATCH_TABLE_PREVIEW_LIMIT);
    renderMatchingHeaderActions(getMatchingCurrentServiceId());

    function scoreBadge(scoreValue) {
      const raw = Number(scoreValue || 0);
      const s = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
      const hue = Math.round(12 + (s * 1.08)); // 12=rouge doux, 120=vert doux
      const bg = `hsl(${hue} 72% 94%)`;
      const border = `hsl(${hue} 58% 76%)`;
      const color = `hsl(${hue} 58% 28%)`;

      return `
        <span title="Score dâ€™adÃ©quation au poste"
              style="display:inline-flex; align-items:center; justify-content:center;
                     min-width:56px; padding:5px 10px; border-radius:999px;
                     border:1px solid ${border}; background:${bg}; color:${color};
                     font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold); line-height: var(--ns-leading-tight); white-space:nowrap;">
          ${s}<span style="font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold); margin-left:1px;">%</span>
        </span>
      `;
    }

    const headerTitle = (v === "titulaire") ? "AdÃ©quation au poste (titulaire" + (titulairesAll.length > 1 ? "s" : "") + ")" : "Top candidats (hors titulaires)";
    const emptyText = (v === "titulaire") ? "Aucun titulaire dÃ©tectÃ© sur ce poste" : "Aucun candidat (hors titulaires)";

    function renderRow(c) {
      const score = Number(c.score_pct || 0);
      const ide = String(c.id_effectif || "").trim();

      return `
        <tr class="match-person-row" data-match-id_effectif="${escapeHtml(ide)}">
          <td style="font-weight: var(--ns-weight-bold);">${escapeHtml(c.full || "â€”")}</td>
          <td>${escapeHtml(c.nom_service || "â€”")}</td>
          <td class="col-center">${scoreBadge(score)}</td>
          <td class="col-center">
            <div class="sb-icon-actions" style="justify-content:center;">
              <button type="button"
                      class="sb-icon-btn match-person-open"
                      data-match-person-open="${escapeHtml(ide)}"
                      title="Voir"
                      aria-label="Voir le dÃ©tail de la correspondance">
                ${analyseEyeIconSvg()}
              </button>
              <button type="button"
                      class="sb-icon-btn sb-icon-btn--doc"
                      data-match-person-pdf="${escapeHtml(ide)}"
                      title="PDF"
                      aria-label="Exporter le dÃ©tail de la correspondance en PDF">
                ${analysePdfIconSvg()}
              </button>
            </div>
          </td>
        </tr>
      `;
    }

    function renderHeaderRow(title) {
      return `
        <tr class="sb-match-section">
          <td colspan="4" class="sb-match-section-cell">
            ${escapeHtml(title)}
          </td>
        </tr>
      `;
    }

    host.innerHTML = `
      <div class="card-sub" style="margin:0 0 8px 0;">
        <span>Poste :</span>
        <span class="sb-badge sb-badge-ref-poste-code">
          ${escapeHtml(((poste?.codif_client || "").trim() || (poste?.codif_poste || "").trim() || "â€”"))}
        </span>
        <b style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(((poste?.intitule_poste || "").trim() || "â€”"))}
        </b>
      </div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Effectif</th>
              <th style="width:180px;">Service</th>
              <th class="col-center" style="width:110px;"
                  title="AdÃ©quation globale au poste (synthÃ¨se des compÃ©tences requises).">Score</th>
              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${renderHeaderRow(headerTitle)}
            ${top.length ? top.map(renderRow).join("") : `<tr><td colspan="4" class="col-center" style="color:#6b7280;">${escapeHtml(emptyText)}</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }


  async function fetchAnalyseMatchingPoste(portal, id_poste, id_service) {
    const svc = (id_service || "").trim();

    const qs = buildQueryString({
      id_poste: (id_poste || "").trim(),
      id_service: svc || null,
      limit: 300
    });

    const url = `${portal.apiBase}/skills/analyse/matching/poste/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    return data;
  }

  async function showMatchingForPoste(portal, id_poste, id_service, seqGuard) {
    const host = byId("matchResult");
    if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargementâ€¦</div>`;

    const data = await fetchAnalyseMatchingPoste(portal, id_poste, id_service);
    if (seqGuard && seqGuard !== _matchReqSeq) return;

    const poste = data?.poste || {};
    const items = Array.isArray(data?.items) ? data.items : [];

    renderMatchingCandidates(id_poste, poste, items, getMatchView());
    refreshMatchingPrintButtonState();
  }

    // ==============================
  // DÃ©tail COMPETENCE (Risques)
  // ==============================
  const _compDetailCache = new Map();
  let _compDetailReqSeq = 0;

  async function fetchAnalyseCompetenceDetail(portal, codeOrId, id_service) {
    const svc = (id_service || "").trim();
    const key = `${codeOrId}|${svc}`;
    if (_compDetailCache.has(key)) return _compDetailCache.get(key);

    const raw = (codeOrId || "").trim();

    // Heuristique simple: un code ressemble Ã  CO00020 / ABC123 etc.
    const isCode = /^[A-Z]{1,6}\d{2,}$/i.test(raw);

    const qs = buildQueryString({
      code: isCode ? raw : null,
      id_comp: !isCode ? raw : null,          // nom courant cÃ´tÃ© backend
      id_competence: !isCode ? raw : null,    // alias au cas oÃ¹
      id_service: svc || null,
      limit_postes: 500,
      limit_porteurs: 500
    });


    const url = `${portal.apiBase}/skills/analyse/risques/competence/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    _compDetailCache.set(key, data);
    return data;
  }

  function openAnalysePosteModal(title, subHtml) {
    const modal = byId("modalAnalysePoste");
    if (!modal) return;

    const tWrap = byId("analysePosteModalTitle");
    const tCode = byId("analysePosteModalTitleCode");
    const tText = byId("analysePosteModalTitleText");
    const s = byId("analysePosteModalSub");

    const titleText = title || "DÃ©tail poste";

    // Si la structure "Code + Texte" existe (HTML modifiÃ©), on lâ€™utilise.
    // Sinon, fallback sur lâ€™ancien fonctionnement.
    if (tText) tText.textContent = titleText;
    else if (tWrap) tWrap.textContent = titleText;

    // Ã€ chaque ouverture, on reset le badge code (il sera rempli aprÃ¨s chargement data)
    if (tCode) {
      tCode.textContent = "";
      tCode.style.display = "none";
    }

    if (s) s.innerHTML = subHtml || "";

    configureActionButton("btnAnalysePosteOpenSimulationContext", null);

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

    if (typeof updateCriticiteMinUi === "function") {
      updateCriticiteMinUi();
    }
  }

  // ==============================
  // Modal COMPETENCE (Risques)
  // ==============================
  function ensureAnalyseCompetenceModal() {
    let modal = byId("modalAnalyseCompetence");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalAnalyseCompetence" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div id="analyseCompModalTitle" class="sb-modal-titleline">
              <span class="sb-badge sb-badge-ref-comp-code" id="analyseCompModalTitleCode" style="display:none;"></span>
              <span id="analyseCompModalTitleText" class="sb-title-text">DÃ©tail compÃ©tence</span>
            </div>
            <button type="button" class="modal-x" id="analyseCompModalCloseBtn" aria-label="Fermer">Ã—</button>
          </div>

          <div class="modal-body">
            <div class="card-sub" id="analyseCompModalSub" style="margin-top:0;"></div>
            <div id="analyseCompModalBody" style="margin-top:12px;"></div>
          </div>

          <div class="modal-footer">
            <button type="button" class="sb-btn" id="analyseCompModalCloseBtn2">Fermer</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalAnalyseCompetence");

    if (modal && modal.getAttribute("data-bound") !== "1") {
      modal.setAttribute("data-bound", "1");

      const btn1 = byId("analyseCompModalCloseBtn");
      const btn2 = byId("analyseCompModalCloseBtn2");

      if (btn1) btn1.addEventListener("click", closeAnalyseCompetenceModal);
      if (btn2) btn2.addEventListener("click", closeAnalyseCompetenceModal);

      // clic fond
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeAnalyseCompetenceModal();
      });

      // ESC
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const m = byId("modalAnalyseCompetence");
        if (m && m.classList.contains("show")) closeAnalyseCompetenceModal();
      });
    }

    return modal;
  }




  function openAnalyseCompetenceModal(title, subHtml) {
    const modal = ensureAnalyseCompetenceModal();
    if (!modal) return;

    const tWrap = byId("analyseCompModalTitle");
    const tCode = byId("analyseCompModalTitleCode");
    const tText = byId("analyseCompModalTitleText");
    const s = byId("analyseCompModalSub");
    const b = byId("analyseCompModalBody");

    let compCode = "";
    let compText = "DÃ©tail compÃ©tence";

    if (title && typeof title === "object") {
      compCode = String(title.code || "").trim();
      compText = String(title.text || "").trim() || compText;
    } else {
      compText = String(title || "").trim() || compText;
    }

    // Texte (fallback si jamais tText nâ€™existe pas)
    if (tText) tText.textContent = compText;
    else if (tWrap) tWrap.textContent = compText;

    // Badge code
    if (tCode) {
      if (compCode) {
        tCode.textContent = compCode;
        tCode.style.display = "inline-flex";
      } else {
        tCode.textContent = "";
        tCode.style.display = "none";
      }
    }

    if (s) s.innerHTML = subHtml || "";

    if (b) {
      b.innerHTML = `<div class="card" style="padding:12px; margin:0;">
        <div class="card-sub" style="margin:0;">Chargementâ€¦</div>
      </div>`;
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    const mb = modal.querySelector(".sb-modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeAnalyseCompetenceModal() {
    const modal = byId("modalAnalyseCompetence");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (typeof updateCriticiteMinUi === "function") {
    updateCriticiteMinUi();
  }
  }

  function mapNiveauActuelForDisplay(raw) {
    return nsLevelLabel(raw);
  }

  (function ensureAnalyseRiskShareRightStyle() {
    if (document.getElementById("analyse-risk-share-right-v32")) return;
    const style = document.createElement("style");
    style.id = "analyse-risk-share-right-v32";
    style.textContent = `
      .sb-accordion .sb-acc-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .sb-accordion .sb-acc-head > span:first-child { flex:1 1 auto; min-width:0; }
      .sb-accordion .sb-acc-head > span:first-child .sb-badge--risk-share { margin-left:auto; }
      .sb-accordion .sb-acc-head > span:last-child { flex:0 0 auto; }
    `;
    document.head.appendChild(style);
  })();
  /* analyse-risk-share-right-v32 */

  function renderAnalyseCompetenceDetail(data) {
    const host = byId("analyseCompModalBody");
    if (!host) return;

    const esc = (v) => escapeHtml(v ?? "");
    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    const stats = data?.stats || {};
    const comp = data?.competence || {};
    const causes = Array.isArray(data?.causes) ? data.causes : [];
    const collaborateurs = Array.isArray(data?.porteurs) ? data.porteurs : [];
    const postes = Array.isArray(data?.postes) ? data.postes : [];
    const scoreSafe = clamp(Math.round(Number(stats?.indice_fragilite || 0)), 0, 100);

    const scopeObj = data?.scope || {};
    const scopeLabel = (typeof scopeObj === "object") ? (scopeObj.nom_service || "Tous les services") : (scopeObj || "Tous les services");

    const normalizeText = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const levelText = (r) => String(r?.niveau_actuel || r?.niveau || r?.niveau_maitrise || r?.niveau_libelle || "").trim();
    const levelNorm = (r) => normalizeText(levelText(r));
    const isExpert = (r) => levelNorm(r).includes("expert") || normalizeText(r?.niveau_code).includes("d");
    const isAdvancedOrExpert = (r) => {
      const n = levelNorm(r);
      const c = normalizeText(r?.niveau_code);
      return n.includes("avance") || n.includes("expert") || c.includes("c") || c.includes("d");
    };
    const isUnavailable = (r) => !!(r?.is_indispo || r?.date_fin_indispo || r?.date_debut_indispo);
    const hasKnownLevel = (r) => !!(levelText(r) || r?.is_evaluee || r?.date_derniere_eval || r?.date_audit);
    const evaluatedCount = collaborateurs.filter(hasKnownLevel).length;
    const expertsDisponibles = collaborateurs.filter(r => isExpert(r) && !isUnavailable(r)).length;
    const avancesOuExperts = collaborateurs.filter(isAdvancedOrExpert).length;

    function scoreHue(score100) {
      const x = clamp(Number(score100 || 0), 0, 100) / 100;
      return Math.round(120 * (1 - x));
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Ã‰levÃ©";
      if (s >= 25) return "ModÃ©rÃ©";
      return "Faible";
    }

    function statePill(score) {
      const s = clamp(Math.round(Number(score || 0)), 0, 100);
      const h = scoreHue(s);
      const label = stateLabel(s);
      const bg = `hsl(${h} 70% 95%)`;
      const br = `hsl(${h} 70% 80%)`;
      const tx = `hsl(${h} 70% 28%)`;
      return `
        <span style="
          display:inline-flex; align-items:center; justify-content:center;
          padding:4px 10px; border-radius:999px;
          border:1px solid ${br}; background:${bg}; color:${tx};
          font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;
        ">
          ${esc(label)}
        </span>
      `;
    }

    function ring(score100) {
      const s = clamp(Math.round(Number(score100 || 0)), 0, 100);
      const size = 104;
      const stroke = 10;
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - s / 100);
      const fill = `hsl(${scoreHue(s)} 70% 45%)`;
      return `
        <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
          <div style="position:relative; width:${size}px; height:${size}px;">
            <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="position:absolute; inset:0;">
              <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
              <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${fill}" stroke-width="${stroke}"
                      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                      transform="rotate(-90 ${size / 2} ${size / 2})" />
            </svg>
            <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">
              <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-kpi); line-height: var(--ns-leading-tight);">${s}<span style="font-size: var(--ns-text-xs); font-weight: var(--ns-weight-bold);">%</span></div>
            </div>
          </div>
          <div class="card-sub" style="margin:0;">FragilitÃ©</div>
        </div>
      `;
    }

    function causeDot(kind) {
      const color = kind === "main" ? "#ef4444" : (kind === "data" ? "#64748b" : (kind === "ok" ? "#10b981" : "#f59e0b"));
      return `<span style="width:9px;height:9px;border-radius:999px;background:${color};display:inline-block;flex:0 0 auto;"></span>`;
    }

    function scoreForCause(code) {
      const key = String(code || "");
      if (key === "MAITRISE_INSUFFISANTE") return Number(stats?.score_maitrise || 0);
      if (key === "CONCENTRATION") return Number(stats?.score_concentration || 0);
      if (key === "TRANSMISSION_INSUFFISANTE") return Number(stats?.score_transmission || 0);
      if (key === "EXPOSITION_SORTIES_INDISPOS") return Number(stats?.score_evenements || stats?.score_events || 0);
      if (key === "DONNEES_A_VERIFIER") return Number(stats?.score_donnees || stats?.score_data || 0);
      return 0;
    }

    function causeScore(cause) {
      const direct = Number(cause?.score ?? cause?.points ?? cause?.score_points ?? cause?.valeur_score ?? NaN);
      if (Number.isFinite(direct) && direct > 0) return direct;
      return Number(scoreForCause(cause?.code) || 0);
    }

    const visibleScoreTotal = causes.reduce((acc, c) => acc + Math.max(0, causeScore(c)), 0);
    function shareBadge(cause) {
      const explicit = Number(cause?.part_note ?? cause?.part_pct ?? cause?.pourcentage_note ?? NaN);
      let pct = Number.isFinite(explicit) ? Math.round(explicit) : 0;
      if (!Number.isFinite(explicit)) {
        const value = Math.max(0, causeScore(cause));
        pct = visibleScoreTotal > 0 ? Math.round((value / visibleScoreTotal) * 100) : 0;
      }
      pct = clamp(pct, 0, 100);
      return `<span class="sb-badge sb-badge--risk-share">${esc(String(pct))}%</span>`;
    }

    function causeHelpKey(code) {
      const key = String(code || "");
      if (key === "MAITRISE_INSUFFISANTE") return "comp_maitrise";
      if (key === "CONCENTRATION") return "comp_concentration";
      if (key === "TRANSMISSION_INSUFFISANTE") return "comp_transmission";
      if (key === "EXPOSITION_SORTIES_INDISPOS") return "comp_evenements";
      if (key === "DONNEES_A_VERIFIER") return "comp_donnees";
      return "comp_maitrise";
    }

    function valueOrDash(v) {
      if (v === null || v === undefined || v === "") return "â€”";
      return String(v);
    }

    function diagLine(label, value) {
      return `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #eef2f7;">
          <span style="font-size: var(--ns-text-sm); color:#64748b; line-height: var(--ns-leading-ui);">${esc(label)}</span>
          <span style="font-size: var(--ns-text-sm); color:#0f172a; font-weight: var(--ns-weight-bold); text-align:right; line-height: var(--ns-leading-ui);">${esc(valueOrDash(value))}</span>
        </div>
      `;
    }

    function smallMetric(label, value, help) {
      return `
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;">
          <div class="label" style="font-size: var(--ns-text-xs); line-height: var(--ns-leading-title);">${esc(label)}</div>
          <div class="value" style="font-size: var(--ns-title-md); line-height: var(--ns-leading-tight);">${esc(valueOrDash(value))}</div>
          ${help ? `<div class="card-sub" style="margin:3px 0 0 0; font-size: var(--ns-text-xs); line-height: var(--ns-leading-ui);">${esc(help)}</div>` : ``}
        </div>
      `;
    }

    function critLevelClass(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "sb-crit-l1";
      if (n >= 80) return "sb-crit-l5";
      if (n >= 60) return "sb-crit-l4";
      if (n >= 40) return "sb-crit-l3";
      if (n >= 20) return "sb-crit-l2";
      return "sb-crit-l1";
    }

    function critBadgeHtml(v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return "â€”";
      return `<span class="sb-crit-badge ${critLevelClass(n)}">${esc(String(Math.round(n)))}</span>`;
    }

    function causeItemsHtml(cause) {
      const code = String(cause?.code || "");
      const items = Array.isArray(cause?.items) ? cause.items : [];

      if (code === "MAITRISE_INSUFFISANTE") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Ã‰carts observÃ©s sur les postes oÃ¹ cette compÃ©tence est attendue.</div>
          <div class="table-wrap" style="margin-top:8px;">
            <table class="sb-table">
              <thead><tr>
                <th>Poste</th>
                <th class="col-center" style="width:96px;">Niveau requis</th>
                <th class="col-center" style="width:62px;">Besoin</th>
                <th class="col-center" style="width:108px;">Collaborateurs<br>au niveau</th>
                <th class="col-center" style="width:64px;">Ã‰cart</th>
                <th class="col-center" style="width:82px;">CriticitÃ©</th>
              </tr></thead>
              <tbody>${items.length ? items.map(it => `
                <tr>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;min-width:320px;">
                      <span class="sb-badge sb-badge-ref-poste-code">${esc(it.poste || "â€”")}</span>
                      <span style="font-size: var(--ns-text-md);font-weight: var(--ns-weight-bold);color:#0f172a;white-space:normal;line-height: var(--ns-leading-title);">${esc(it.intitule_poste || "â€”")}</span>
                    </div>
                  </td>
                  <td class="col-center">${nsLevelBadgeHtml(it.niveau_requis || "â€”", "Niveau requis")}</td>
                  <td class="col-center">${esc(String(it.besoin ?? 0))}</td>
                  <td class="col-center">${esc(String(it.porteurs_niveau_requis ?? it.collaborateurs_niveau_requis ?? 0))}</td>
                  <td class="col-center"><span class="sb-badge sb-badge--warning">${esc(String(it.ecart ?? 0))}</span></td>
                  <td class="col-center">${critBadgeHtml(it.criticite)}</td>
                </tr>`).join("") : `<tr><td colspan="6" class="col-center sb-muted">Aucun Ã©cart de maÃ®trise dÃ©taillÃ©.</td></tr>`}</tbody>
            </table>
          </div>`;
      }

      if (code === "CONCENTRATION") {
        const confirmes = Number(stats?.nb_porteurs || stats?.nb_porteurs_valides || 0);
        const declares = Number(stats?.nb_porteurs_declares || 0);
        const besoin = Number(stats?.besoin_total || 0);
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Nombre de collaborateurs identifiÃ©s sur cette compÃ©tence.</div>
          <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:8px;">
            ${smallMetric("Collaborateurs confirmÃ©s", confirmes, "Niveau connu et exploitable.")}
            ${smallMetric("Collaborateurs dÃ©clarÃ©s", declares, "Collaborateurs associÃ©s Ã  cette compÃ©tence.")}
            ${smallMetric("Besoin total", besoin, "Volume attendu sur les postes concernÃ©s.")}
          </div>`;
      }

      if (code === "TRANSMISSION_INSUFFISANTE") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Niveaux disponibles pour organiser une transmission.</div>
          <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:8px;">
            ${smallMetric("Experts disponibles", expertsDisponibles, "Niveau Expert disponible.")}
            ${smallMetric("AvancÃ©s ou experts", avancesOuExperts, "Niveau AvancÃ© ou Expert.")}
            ${smallMetric("Collaborateurs Ã©valuÃ©s", evaluatedCount, "Niveau connu dans Novoskill.")}
          </div>`;
      }

      if (code === "EXPOSITION_SORTIES_INDISPOS") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Ã‰vÃ©nements connus pouvant modifier la disponibilitÃ©.</div>
          <div class="table-wrap" style="margin-top:8px;">
            <table class="sb-table">
              <thead><tr><th>Collaborateur</th><th>Poste</th><th>Ã‰vÃ©nement</th><th class="col-center" style="width:120px;">DÃ©but</th><th class="col-center" style="width:120px;">Fin / date</th></tr></thead>
              <tbody>${items.length ? items.map(it => `
                <tr>
                  <td><b>${esc(it.collaborateur || "â€”")}</b></td>
                  <td>${esc(it.poste || "â€”")}</td>
                  <td><span class="sb-badge sb-badge--warning">${esc(it.evenement || "Ã‰vÃ©nement")}</span></td>
                  <td class="col-center">${esc(it.debut || "â€”")}</td>
                  <td class="col-center">${esc(it.fin || "â€”")}</td>
                </tr>`).join("") : `<tr><td colspan="5" class="col-center sb-muted">Aucun Ã©vÃ©nement dÃ©taillÃ©.</td></tr>`}</tbody>
            </table>
          </div>`;
      }

      if (code === "DONNEES_A_VERIFIER") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Informations Ã  confirmer pour fiabiliser lâ€™analyse.</div>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${items.length ? items.map(it => `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 10px; border:1px solid #e5e7eb; border-radius:10px; background:#fff;">
                <span style="font-size: var(--ns-text-sm); color:#334155; font-weight: var(--ns-weight-bold);">${esc(it.label || "Point Ã  vÃ©rifier")}</span>
                <span class="sb-badge">${esc(String(it.value ?? "â€”"))}</span>
              </div>`).join("") : `<div class="card-sub" style="margin:0;">Aucune donnÃ©e Ã  vÃ©rifier.</div>`}
          </div>`;
      }

      return `<div class="card-sub" style="margin:0;">Ã‰lÃ©ments observÃ©s sur cette cause.</div>`;
    }

    const causesHtml = causes.map((c, idx) => `
      <div class="sb-accordion">
        <button type="button" class="sb-acc-head sb-btn sb-btn--soft ${idx === 0 ? "is-open" : ""}">
          <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
            ${causeDot(c?.severity)}<span style="font-weight: var(--ns-weight-semibold);color:#1f2937;">${esc(c?.titre || "Cause")}</span>
          </span>
          <span style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
            ${shareBadge(c)}
            ${causeHelpButton(causeHelpKey(c?.code))}
            <span class="sb-acc-chevron">â–¾</span>
          </span>
        </button>
        <div class="sb-acc-body">
          ${causeItemsHtml(c)}
        </div>
      </div>
    `).join("") || `<div class="card-sub" style="margin:0;">Aucune cause de fragilitÃ© dÃ©tectÃ©e sur le pÃ©rimÃ¨tre analysÃ©.</div>`;

    const collaborateursRows = collaborateurs.slice(0, 12).map((r) => {
      const full = `${(r?.prenom_effectif || "").toString().trim()} ${(r?.nom_effectif || "").toString().trim()}`.trim() || "â€”";
      const evalDate = (r?.date_derniere_eval || r?.date_audit || "").toString().slice(0, 10);
      const isIndispo = isUnavailable(r);
      const cls = isIndispo ? "sb-badge--warning" : r?.is_evaluee ? "sb-badge--success" : "sb-badge--info";
      const label = isIndispo ? "Indisponible" : r?.is_evaluee ? "Ã‰valuÃ©" : "Ã€ confirmer";
      return `
        <tr>
          <td class="sb-fs-13 sb-fw-700">${esc(full)}</td>
          <td class="sb-fs-13">${esc(r?.intitule_poste || "â€”")}</td>
          <td class="col-center">${nsLevelBadgeHtml(r?.niveau_actuel || "â€”", "Niveau actuel")}</td>
          <td class="col-center">${esc(evalDate ? formatDateFr(evalDate) : "â€”")}</td>
          <td><span class="sb-badge ${cls}">${esc(label)}</span></td>
        </tr>`;
    }).join("");

    const lecture = (() => {
      if (scoreSafe >= 75) return "Cette compÃ©tence est fortement exposÃ©e sur le pÃ©rimÃ¨tre analysÃ©.";
      if (scoreSafe >= 50) return "Cette compÃ©tence prÃ©sente plusieurs fragilitÃ©s Ã  surveiller ou sÃ©curiser.";
      if (scoreSafe >= 25) return "Cette compÃ©tence prÃ©sente une fragilitÃ© modÃ©rÃ©e.";
      return "Cette compÃ©tence apparaÃ®t globalement sÃ©curisÃ©e sur le pÃ©rimÃ¨tre analysÃ©.";
    })();

    host.innerHTML = `
      <div class="card" style="padding:14px;margin:0;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:320px;">
            <div class="card-title" style="margin-bottom:8px;">Diagnostic</div>
            <div class="card-sub" style="margin:0 0 8px 0;font-size: var(--ns-text-md);line-height: var(--ns-leading-body);">${esc(lecture)}</div>
            <div class="card-sub" style="margin:0 0 8px 0;font-size: var(--ns-text-sm);line-height: var(--ns-leading-body);font-weight: var(--ns-weight-bold);color:#475569;">
              Ã‰lÃ©ments pris en compte :
            </div>
            <div style="max-width:660px;">
              ${diagLine("PÃ©rimÃ¨tre analysÃ©", scopeLabel)}
              ${diagLine("CriticitÃ© des compÃ©tences", `â‰¥ ${data?.criticite_min ?? "â€”"}%`)}
              ${diagLine("Besoin total de couverture", stats?.besoin_total ?? "â€”")}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
            ${ring(scoreSafe)}
            ${statePill(scoreSafe)}
          </div>
        </div>
      </div>

      <div class="card" style="padding:14px;margin-top:12px;">
        <div class="card-title" style="margin-bottom:6px;">Pourquoi cette compÃ©tence est fragile ?</div>
        <div class="card-sub" style="margin:0 0 10px 0;">Ouvrez une cause pour voir les Ã©lÃ©ments observÃ©s sur cette compÃ©tence.</div>
        ${causesHtml}
      </div>

      <div class="card" style="padding:14px;margin-top:12px;">
        <div class="card-title" style="margin-bottom:8px;">Collaborateurs identifiÃ©s</div>
        <div style="overflow:auto;">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover" style="margin:0;min-width:760px;">
            <thead><tr><th>Collaborateur</th><th>Poste actuel</th><th class="col-center">Niveau</th><th class="col-center">DerniÃ¨re Ã©valuation</th><th>Statut</th></tr></thead>
            <tbody>${collaborateursRows || `<tr><td colspan="5" class="sb-muted">Aucun collaborateur identifiÃ©.</td></tr>`}</tbody>
          </table>
        </div>
      </div>


      <div class="card analyse-competence-reading-card" style="padding:14px;margin-top:12px;">
        <div class="card-title" style="margin-bottom:6px;">Lecture transversale</div>
        <div class="card-sub" style="margin:0;line-height: var(--ns-leading-body);">
          Cette vue sert Ã  comprendre oÃ¹ la compÃ©tence est fragile : postes concernÃ©s, porteurs identifiÃ©s,
          couverture disponible et donnÃ©es Ã  confirmer. Les besoins individuels de montÃ©e en compÃ©tences
          se traitent depuis lâ€™adÃ©quation titulaire ou le menu Besoins & formations, quand une personne et son poste actuel sont clairement identifiÃ©s.
        </div>
      </div>
    `;
  }

  async function showAnalyseCompetenceDetailModal(portal, id_comp_or_code, id_service) {
    const mySeq = ++_compDetailReqSeq;

    openAnalyseCompetenceModal("DÃ©tail compÃ©tence");

    try {
      const data = await fetchAnalyseCompetenceDetail(portal, id_comp_or_code, id_service);
      if (mySeq !== _compDetailReqSeq) return;

      const comp = data?.competence || {};
      const titleCode = String(comp.code || "").trim();
      const titleText = String(comp.intitule || "CompÃ©tence").trim();

      const scopeObj = data?.scope;
      const scopeName = (scopeObj && typeof scopeObj === "object")
        ? String(scopeObj.nom_service || scopeObj.label || scopeObj.titre || "").trim()
        : String(scopeObj || "").trim();

      const scopeLabel = scopeName || "Tous les services";

      const sub = "";

      openAnalyseCompetenceModal({ code: titleCode, text: titleText }, sub);



      renderAnalyseCompetenceDetail(data);
    } catch (e) {
      if (mySeq !== _compDetailReqSeq) return;

      openAnalyseCompetenceModal("DÃ©tail compÃ©tence");

      const host = byId("analyseCompModalBody");
      if (host) {
        host.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0 0 8px 0;">Erreur : ${escapeHtml(errMsg(e))}</div>
            <div class="card-sub" style="margin:0;">Impossible de charger le dÃ©tail.</div>
          </div>
        `;
      }
    }
  }

  function renderPostePorteurs(porteurs, idPosteAnalyse) {
    const list = Array.isArray(porteurs) ? porteurs : [];
    if (!list.length) {
      return `<div class="card-sub" style="margin-top:6px; color:#6b7280;">Aucune personne</div>`;
    }

    function mapNiveauActuel(raw) {
      return nsLevelLabel(raw);
    }

    const max = 8;
    const shown = list.slice(0, max);

    const rows = shown.map(p => {
      const prenom = (p.prenom_effectif || "").trim();
      const nom = (p.nom_effectif || "").trim();
      const full = `${prenom} ${nom}`.trim() || "â€”";

      const niv = mapNiveauActuel(p.niveau_actuel);

      // On n'affiche plus le poste, uniquement le service (si tu veux rien du tout, mets right = "")
      const svc = (p.nom_service || "").trim();
      const right = svc || "â€”";

      const posteActuel = (p.id_poste_actuel || "").trim();
      const posteRef = (idPosteAnalyse || "").trim();

      const isSamePoste = !!posteRef && !!posteActuel && posteActuel === posteRef;
      const sqColor = isSamePoste ? "#16a34a" : "#f59e0b"; // vert / orange
      const sqTitle = isSamePoste ? "Poste identique" : "Poste diffÃ©rent / non renseignÃ©";

      return `
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="display:flex; align-items:center; gap:8px; padding-left:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <span title="${escapeHtml(sqTitle)}"
                  style="width:10px; height:10px; border-radius:2px; background:${sqColor}; border:1px solid rgba(0,0,0,.12); flex:0 0 auto;">
            </span>

            <span style="font-weight: var(--ns-weight-semibold); color:#111827; font-size: var(--ns-text-xs); overflow:hidden; text-overflow:ellipsis;">
              ${escapeHtml(full)}
            </span>

            <span style="font-weight: var(--ns-weight-semibold); color:#6b7280; font-size: var(--ns-text-xs); flex:0 0 auto;">
              (${escapeHtml(niv)})
            </span>
          </span>

          <span style="color:#6b7280; font-size: var(--ns-text-xs); white-space:nowrap;">
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
  // Cache pour re-render sans refetch
  _analysePosteLastData = data || null;

  // IMPORTANT : si le slot existe, on remplit le slot.
  // On ne doit JAMAIS rÃ©Ã©crire tout le tab, sinon tu Ã©crases le diagnostic (et tu retombes Ã  0%).
  const slot = byId("analysePosteDiagCartoSlot");

  // Le bloc "Cartographie dÃ©taillÃ©e" est supprimÃ© : on ne rend rien.
  // IMPORTANT : on ne doit JAMAIS Ã©crire dans #analysePosteTabCompetences ici,
  // sinon on Ã©crase le diagnostic (anneau %).
  if (!slot) return;

  const host = slot;


  const listAll = Array.isArray(data?.competences) ? data.competences : [];

  const critMinRaw = Number(data?.criticite_min);
  const critMinVal = Number.isFinite(critMinRaw)
    ? critMinRaw
    : Number(getCriticiteMin() ?? 70);

  function _normStr(v) {
    return (v ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function nivReqToNum(v) {
    return nsLevelRank(v);
  }

  function nivActToNum(v) {
    return nsLevelRank(v);
  }

  function getNbTotal(c) {
    const porteurs = Array.isArray(c?.porteurs) ? c.porteurs : [];
    const nb = (c?.nb_porteurs === null || c?.nb_porteurs === undefined)
      ? porteurs.length
      : Number(c.nb_porteurs || 0);

    return Number.isFinite(nb) ? nb : porteurs.length;
  }

  function getNbOk(c) {
    const req = nivReqToNum(c?.niveau_requis);
    const porteurs = Array.isArray(c?.porteurs) ? c.porteurs : [];
    const nbTotal = getNbTotal(c);

    // Si lâ€™API ne renvoie pas les porteurs => on ne sait pas qualifier, on approx sur total
    if (!porteurs.length) return nbTotal;

    let ok = 0;
    for (const p of porteurs) {
      const act = nivActToNum(p?.niveau_actuel);
      if (req <= 0) { ok += 1; continue; }
      if (act >= req) ok += 1;
    }
    return ok;
  }

  function recommandation(nbOk, nbTotal) {
    const tot = Number(nbTotal || 0);
    const ok = Number(nbOk || 0);

    if (ok <= 0) return "recruter";
    if (ok === 1) return "mutualiser";
    return "former";
  }

  function pill(txt) {
    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid #d1d5db;
        background:#fff; color:#374151; font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">
        ${escapeHtml(txt || "â€”")}
      </span>
    `;
  }

  function pillReco(rec) {
    const r = (rec || "").toString().toLowerCase();
    let label = "â€”";
    if (r === "former") label = "Former";
    else if (r === "mutualiser") label = "Mutualiser";
    else if (r === "recruter") label = "Recruter";

    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid #d1d5db;
        background:var(--chip-bg, #f3f4f6); color:#111827; font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">
        ${escapeHtml(label)}
      </span>
    `;
  }

  // 1) Liste compÃ©tences critiques enrichie
  const critEnriched = listAll
    .filter(c => Number(c?.poids_criticite) >= critMinVal)
    .map(c => {
      const nbTotal = getNbTotal(c);
      const nbOk = getNbOk(c);
      return {
        ...c,
        _nb_total: nbTotal,
        _nb_ok: nbOk,
        _reco: recommandation(nbOk, nbTotal),
      };
    });

  // 2) Par dÃ©faut: on affiche les RISQUES (bus factor <= 1) sauf si toggle â€œtoutesâ€
  const showAllCrit = !!_analysePosteShowAllCompetences;
  const focus = (_analysePosteFocusKey || "").trim();

  function matchFocus(x) {
    const tot = Number(x?._nb_total || 0);
    const ok = Number(x?._nb_ok || 0);
    if (focus === "critiques-sans-porteur") return ok <= 0;
    if (focus === "porteur-unique") return ok === 1;
    if (focus === "total-fragiles") return ok <= 1;
    return true;
  }

  const riskList = critEnriched.filter(x => Number(x._nb_ok || 0) <= 1);
  let detailList = showAllCrit ? [...critEnriched] : [...riskList];
  detailList = detailList.filter(matchFocus);

  detailList.sort((a, b) =>
    (Number(a._nb_total || 0) - Number(b._nb_total || 0)) ||
    (Number(b.poids_criticite || 0) - Number(a.poids_criticite || 0)) ||
    (String(a.code || "").localeCompare(String(b.code || "")))
  );

  if (!detailList.length) {
    host.innerHTML = `<div class="card-sub" style="margin-top:10px;">Aucune compÃ©tence Ã  afficher.</div>`;
    return;
  }

  // 3) Rendu: uniquement la cartographie (dans le slot si prÃ©sent)
  host.innerHTML = `
    <div class="table-wrap" style="margin-top:10px;">
      <table class="sb-table">
        <thead>
          <tr>
            <th style="width:90px;">Code</th>
            <th>CompÃ©tence</th>
            <th class="col-center" style="width:110px;">Niv. requis</th>
            <th class="col-center" style="width:90px;">CriticitÃ©</th>
            <th class="col-center" style="width:120px;">Porteurs</th>
            <th class="col-center" style="width:140px;">Au niv. requis</th>
            <th class="col-center" style="width:140px;">Point Ã  sÃ©curiser</th>
          </tr>
        </thead>
        <tbody>
          ${detailList.map(c => {
            const code = escapeHtml(c.code || "â€”");
            const intit = escapeHtml(c.intitule || "â€”");
            const nr = nsLevelBadgeHtml(c.niveau_requis || "â€”", "Niveau requis");
            const crit = (c.poids_criticite === null || c.poids_criticite === undefined) ? "â€”" : escapeHtml(String(c.poids_criticite));
            const tot = Number(c._nb_total || 0);
            const ok = Number(c._nb_ok || 0);

            return `
              <tr>
                <td style="font-weight: var(--ns-weight-bold); white-space:nowrap;">${code}</td>
                <td style="min-width:280px;">
                  <div style="font-size: var(--ns-text-md); font-weight: var(--ns-weight-bold);">${intit}</div>
                </td>
                <td class="col-center">${pill(nr)}</td>
                <td class="col-center" style="white-space:nowrap;">${crit}</td>
                <td class="col-center">${pill(String(tot))}</td>
                <td class="col-center">${pill(`${ok}/${tot}`)}</td>
                <td class="col-center">${pillReco(c._reco || "")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}


async function showAnalysePosteDetailModal(portal, id_poste, id_service, focusKey) {
  const focus = (focusKey || "").trim(); // "critiques-sans-porteur" | "porteur-unique" | "total-fragiles" | ""
  const modal = byId("modalAnalysePoste");
  if (modal) modal.setAttribute("data-focus", focus);

  function focusLabel(k) {
    if (k === "critiques-sans-porteur") return "CompÃ©tences critiques non couvertes";
    if (k === "porteur-unique") return "CompÃ©tences critiques Ã  couverture unique";
    if (k === "total-fragiles") return "FragilitÃ©s (bus factor â‰¤ 1)";
    return "";
  }

  // Reset Ã©tat modal
  _analysePosteFocusKey = focus;
  _analysePosteShowAllCompetences = false;
  _analysePosteLastData = null;

  // Lazy-load dÃ©tail (endpoint lourd) : pas chargÃ© Ã  lâ€™ouverture
  _analysePosteLastParams = { id_poste: id_poste, id_service: id_service || "" };
  _analysePosteDetailLoaded = false;
  _analysePosteDetailLoading = false;

  openAnalysePosteModal(
    "DÃ©tail poste",
    `<div class="card-sub" style="margin:0;">Chargement du diagnosticâ€¦</div>`
  );

  // Init contenu (CompÃ©tences)
  const tabA = byId("analysePosteTabCompetences");
  if (tabA) tabA.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargementâ€¦</div></div>`;

  const mySeq = ++_posteDiagReqSeq;

  try {
    const diag = await fetchAnalysePosteDiagnostic(portal, id_poste, id_service, getCriticiteMin(), 8);
    if (mySeq !== _posteDiagReqSeq) return;

    const poste = diag?.poste || {};
    const codifClient = (poste.codif_client || "").trim();
    const codifPoste  = (poste.codif_poste || "").trim();
    const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

    const posteIntitule = (poste.intitule_poste || "").trim() || "Poste";
    const scope = (diag?.scope?.nom_service || "").trim() || "Tous les services";

    const focusLab = focusLabel(focus);
    const focusHtml = focusLab
      ? `<span class="sb-badge">Focus : ${escapeHtml(focusLab)}</span>`
    : ``;

    const sub = focusHtml
      ? `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">${focusHtml}</div>`
      : "";


    openAnalysePosteModal(posteIntitule, sub);

    // Badge code poste dans le titre
    const tCode = byId("analysePosteModalTitleCode");
    if (tCode) {
      if ((codeAffiche || "").trim() !== "") {
        tCode.textContent = codeAffiche;
        tCode.style.display = "inline-flex";
      } else {
        tCode.textContent = "";
        tCode.style.display = "none";
      }
    }

    // Rendu diagnostic immÃ©diat (affichage rapide)
    renderAnalysePosteDiagnosticOnly(diag, focus);

    // Chargement AUTO du dÃ©tail (endpoint lourd) pour afficher la cartographie + causes racines dÃ¨s lâ€™ouverture
    if (!_analysePosteDetailLoaded && !_analysePosteDetailLoading) {
      _analysePosteDetailLoading = true;

      try {
        const data = await fetchAnalysePosteDetail(portal, id_poste, id_service);

        // Si une autre requÃªte a pris la main entre temps, on nâ€™Ã©crase rien
        if (mySeq !== _posteDiagReqSeq) return;

        _analysePosteLastData = data;
        _analysePosteDetailLoaded = true;
        _analysePosteDetailLoading = false;

        // Affiche la vue â€œCompÃ©tencesâ€ (inclut Causes racines)
        renderAnalysePosteCompetencesTab(data);

      } catch (err) {
        _analysePosteDetailLoading = false;
        if (typeof showToast === "function") showToast("Erreur chargement cartographie poste.", "error");
        else console.error(err);
        // On reste sur le diagnostic-only dÃ©jÃ  affichÃ©
      }
    }


  } catch (e) {
    if (mySeq !== _posteDiagReqSeq) return;

    openAnalysePosteModal(
      "DÃ©tail poste",
      `<div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>`
    );

    if (tabA) {
      tabA.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Impossible de charger le diagnostic.</div></div>`;
    }
  }
}

const _riskEvol3mCache = new Map(); // key: svc|crit
let _riskEvol3mSeq = 0;

function fmtPctSigned(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "â€”";
  const s = Math.round(v);
  return (s > 0 ? `+${s}%` : `${s}%`);
}

function sumField(list, field) {
  return (Array.isArray(list) ? list : []).reduce((acc, r) => acc + (Number(r?.[field] || 0) || 0), 0);
}

function evolPct(sumNow, sumFut) {
  const a = Number(sumNow) || 0;
  const b = Number(sumFut) || 0;
  if (a <= 0) return 0;
  return ((b - a) / a) * 100;
}

async function computeRiskEvolution3m(portal, id_service) {
  const svc = (id_service || "").trim();
  const crit = getCriticiteMinSafe(CRITICITE_MIN_DEFAULT);
  const critVal = Number.isFinite(crit) ? String(Math.round(crit)) : "";
  const key = `dashboard-risk-timeline-peak|${svc}|${critVal}`;

  if (_riskEvol3mCache.has(key)) return _riskEvol3mCache.get(key);

  if (!portal?.apiBase || !portal?.contactId) {
    throw new Error("Contexte portail indisponible pour la projection Ã  3 mois.");
  }

  let url = "";
  if (typeof portal.dashboardRiskOverviewUrl === "function") {
    url = portal.dashboardRiskOverviewUrl({
      id_service: svc || "",
      criticite_min: critVal || undefined,
    });
  } else {
    const qs = new URLSearchParams();
    if (svc) qs.set("id_service", svc);
    if (critVal) qs.set("criticite_min", critVal);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    url = `${portal.apiBase}/skills/dashboard/risk-overview/${encodeURIComponent(portal.contactId)}${suffix}`;
  }

  const data = await portal.apiJson(url);
  const timeline = Array.isArray(data?.risk_timeline) ? data.risk_timeline : [];
  const nowPoint = timeline[0] || null;
  const windowPoints = timeline.slice(1, 4);
  const peakPoint = windowPoints.reduce((best, p) => {
    const b = Number(best?.indice_fragilite ?? -1);
    const v = Number(p?.indice_fragilite ?? -1);
    return v > b ? p : best;
  }, windowPoints[0] || nowPoint || null);

  const now = Number(nowPoint?.indice_fragilite);
  const peak = Number(peakPoint?.indice_fragilite);
  const safeNow = Number.isFinite(now) ? Math.round(now) : 0;
  const safePeak = Number.isFinite(peak) ? Math.round(peak) : safeNow;
  const delta = safePeak - safeNow;

  const out = {
    source: "dashboard-risk-overview",
    timeline,
    total: {
      pct: delta,
      now: safeNow,
      peak: safePeak,
      future: safePeak,
      label_now: nowPoint?.label || "Auj.",
      label_peak: peakPoint?.label || "Pic 3 mois",
      label_future: peakPoint?.label || "Pic 3 mois",
    },
    postes: {
      pct: delta,
      now: safeNow,
      peak: safePeak,
      future: safePeak,
      nNow: Number(nowPoint?.nb_postes_total || 0) || 0,
      n3m: Number(peakPoint?.nb_postes_total || 0) || 0,
    },
    competences: {
      pct: null,
      now: null,
      future: null,
    },
  };

  _riskEvol3mCache.set(key, out);
  return out;
}




function renderDetail(mode) {
  const scope = getScopeLabel();

  const title = byId("analyseDetailTitle");
  const sub = byId("analyseDetailSub");
  const meta = byId("analyseDetailMeta");
  const body = byId("analyseDetailBody");
  const actions = byId("analyseDetailActions");

  if (actions) actions.innerHTML = "";

  if (sub) sub.style.display = "";
  if (meta) {
    meta.style.display = "";
    meta.textContent = `Service : ${scope}`;
  }
  if (!body) return;

  // -----------------------
  // MATCHING (MVP)
  // -----------------------
  if (mode === "matching") {
    setAnalyseDetailTitle("Correspondances profils/postes", "matching");
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
    if (meta) {
      meta.textContent = "";
      meta.innerHTML = "";
      meta.style.display = "none";
    }

    if (typeof setActiveMatchKpi === "function") setActiveMatchKpi(getMatchView());

    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
    _matchCurrentRowsCount = 0;
    renderMatchingHeaderActions(id_service);
    body.innerHTML = renderMatchingShell();

    if (!_portalref) {
      const host = byId("matchResult");
      if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Contexte portail indisponible.</div>`;
      return;
    }

    const mySeq = ++_matchReqSeq;

    (async () => {
      try {
        const postes = await fetchMatchingPostes(_portalref, id_service, getMatchPosteMode());
        if (mySeq !== _matchReqSeq) return;

        if (_matchSelectedPoste && !postes.some(p => (p.id_poste || "").toString().trim() === _matchSelectedPoste)) {
          _matchSelectedPoste = "";
        }

        if (!_matchSelectedPoste && postes.length) {
          _matchSelectedPoste = (postes[0].id_poste || "").toString().trim();
        }

        renderMatchingPosteList(postes, _matchSelectedPoste);

        refreshMatchingPrintButtonState();

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
    const horizon = getPrevHorizon();
    const horizonLabel = analyseHorizonLabel(horizon);
    setAnalyseDetailTitle(`PrÃ©visions Ã  ${horizonLabel}`, "previsions");
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
    if (meta) {
      meta.textContent = "";
      meta.innerHTML = "";
      meta.style.display = "none";
    }

    let selectedKpi = window.analysePrevisionValidKpi(localStorage.getItem("sb_analyse_prev_kpi") || "sorties-confirmees");
    localStorage.setItem("sb_analyse_prev_kpi", selectedKpi);
    if (typeof setActivePrevKpi === "function") setActivePrevKpi(selectedKpi);
    renderPrevisionsHeaderActions(selectedKpi, 0);

    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
    const detailTitle = selectedKpi === "sorties-potentielles"
      ? "Sorties potentielles"
      : (selectedKpi === "transmissions" ? "Transmissions Ã  prÃ©parer" : "Sorties confirmÃ©es");
    const detailIcon = selectedKpi === "sorties-potentielles"
      ? "sortiesPotentielles"
      : (selectedKpi === "transmissions" ? "transmissions" : "sortiesConfirmees");

    body.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:10px;">${analyseDetailTitleHtml(`${detailTitle} Ã  ${horizonLabel}`, detailIcon)}</div>
        <div id="prevTransitionDetailBox" style="margin-top:0;">Chargementâ€¦</div>
      </div>
    `;

    window.__sbPrevTransitionReqId = (window.__sbPrevTransitionReqId || 0) + 1;
    const reqId = window.__sbPrevTransitionReqId;

    setTimeout(async () => {
      const box = byId("prevTransitionDetailBox");
      if (!box) return;
      try {
        if (!_portalref) {
          box.textContent = "Contexte portail indisponible (_portalref manquant).";
          return;
        }

        let data = null;
        if (selectedKpi === "transmissions") {
          data = await fetchPrevisionsTransmissionsDetail(_portalref, horizon, id_service, 2000);
        } else {
          data = await fetchPrevisionsTransitionDetail(_portalref, selectedKpi === "sorties-potentielles" ? "potential" : "confirmed", horizon, id_service, 2000);
        }
        if ((window.__sbPrevTransitionReqId || 0) !== reqId) return;

        const items = Array.isArray(data?.items) ? data.items : [];
        renderPrevisionsHeaderActions(selectedKpi, items.length);
        if (!items.length) {
          box.textContent = selectedKpi === "transmissions"
            ? "Aucune transmission critique Ã  prÃ©parer dans lâ€™horizon sÃ©lectionnÃ©."
            : "Aucune sortie dÃ©tectÃ©e dans lâ€™horizon sÃ©lectionnÃ©.";
          return;
        }

        const expanded = getPrevisionDetailExpanded(selectedKpi);
        const itemsToRender = expanded ? items : items.slice(0, PREV_TABLE_PREVIEW_LIMIT);
        if (selectedKpi === "transmissions") {
          box.innerHTML = renderPrevisionTableTransmissionItems(itemsToRender);
          box.querySelectorAll(".prev-transmission-row, .prev-transmission-open").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const tr = el.closest("tr");
              const idx = Number(tr?.getAttribute("data-index") || -1);
              const row = (window.__sbPrevTransmissionRows || [])[idx];
              if (row) openAnalysePrevisionTransmissionModal(row);
            });
          });
        } else {
          const potential = selectedKpi === "sorties-potentielles";
          box.innerHTML = renderPrevisionTableTransitionEvents(itemsToRender, potential ? "potential" : "confirmed");
          box.querySelectorAll(".prev-transition-row, .prev-transition-open").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const tr = el.closest("tr");
              const idx = Number(tr?.getAttribute("data-index") || -1);
              const row = (window.__sbPrevTransitionRows || [])[idx];
              if (row) openAnalysePrevisionTransitionModal(row, potential ? "potential" : "confirmed");
            });
          });
        }
      } catch (e) {
        if ((window.__sbPrevTransitionReqId || 0) !== reqId) return;
        box.textContent = `Erreur chargement prÃ©visions: ${e?.message || e}`;
      }
    }, 0);

    return;
  }

  const rf = getRiskFilter(); // "", "postes-scope", "critiques-fragiles", "evol-3m"
  if (typeof setActiveRiskKpi === "function") setActiveRiskKpi(rf);

  setAnalyseDetailTitle("Risques actuels", "risques");
  if (sub) {
    sub.textContent = "";
    sub.style.display = "none";
  }
  if (meta) {
    meta.textContent = "";
    meta.style.display = "none";
  }

  let filterLabel = "Risques actuels";
  let filterSub = "";

  if (rf === "postes-scope") {
    filterLabel = "FragilitÃ© des postes";
  } else if (rf === "critiques-fragiles") {
    filterLabel = "FragilitÃ©s par compÃ©tence";
  } else if (rf === "evol-3m") {
    filterLabel = "Ã‰volution des indices de fragilitÃ©s Ã  3 mois";
  }


  const selSvc = byId("analyseServiceSelect") || byId("anaServiceSelect") || byId("mapServiceSelect");
  const id_service = window.portal.serviceFilter.toQueryId(selSvc?.value || "");


  function badge(txt, accent) {
    const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
    return `<span class="${cls}">${escapeHtml(txt || "â€”")}</span>`;
  }

  function renderDomainPill(item) {
    const lab = (item?.domaine_titre_court || item?.domaine_titre || item?.id_domaine_competence || "â€”").toString();
    const col = normalizeColor(item?.domaine_couleur) || "#9ca3af";
    return `
      <span class="sb-badge-domaine sb-badge-domaine--soft"
            style="--dom-color:${escapeHtml(col)};"
            title="${escapeHtml(lab)}">
        ${escapeHtml(lab)}
      </span>
    `;
  }


  function renderTablePostes(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun rÃ©sultat.</div>`;

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    function scoreHue(score) {
      const s = clamp(Number(score || 0), 0, 100) / 100;
      return Math.round(120 * (1 - s));
    }

    function scoreChip(score) {
      const s = clamp(Math.round(Number(score || 0)), 0, 100);
      const h = scoreHue(s);
      const fill = `hsl(${h} 70% 45%)`;

      return `
        <div style="display:flex; align-items:center; justify-content:center; gap:10px;">
          <div style="width:84px; height:10px; background:#e5e7eb; border-radius:999px; overflow:hidden;">
            <div style="height:100%; width:${s}%; background:${fill};"></div>
          </div>
          <div style="min-width:44px; text-align:right; font-weight: var(--ns-weight-bold);">
            ${s}<span style="font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs);">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Ã‰levÃ©";
      if (s >= 25) return "ModÃ©rÃ©";
      return "Faible";
    }

    function statePill(label, score) {
      const s = clamp(Math.round(Number(score || 0)), 0, 100);
      const h = scoreHue(s);
      const bg = `hsl(${h} 70% 95%)`;
      const br = `hsl(${h} 70% 80%)`;
      const tx = `hsl(${h} 70% 28%)`;

      return `
        <span style="
          display:inline-flex; align-items:center; justify-content:center;
          padding:4px 10px; border-radius:999px;
          border:1px solid ${br}; background:${bg}; color:${tx};
          font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;
        ">
          ${escapeHtml(label)}
        </span>
      `;
    }

    return `
      <div class="table-wrap sb-tip-host" style="margin-top:10px;">
        <table class="sb-table" id="tblRiskPostesFragiles">
          <thead>
            <tr>
              <th>Poste</th>
              <th style="width:180px;">Service</th>

              <th class="col-center" style="width:220px;">
                <span class="sb-th-with-tip">
                  <span>Indice<br>de fragilitÃ©</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilitÃ©">i</span>
                </span>
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height: var(--ns-leading-tight);">
                Ã‰tat
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const intitule = (r.intitule_poste || "").trim() || "â€”";
              const codifClient = (r.codif_client || "").trim();
              const codifPoste  = (r.codif_poste || "").trim();
              const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;
              const svc = (r.nom_service || "").trim() || "â€”";

              const isNonAnalyse = !!r.is_non_analyse;
              const isSansTitulaire = !isNonAnalyse && Number(r.nb_titulaires || 0) <= 0 && Number(r.nb_titulaires_cible || 1) >= 1;
              const scoreTitle = isNonAnalyse
                ? "Aucune compÃ©tence attendue exploitable nâ€™est rattachÃ©e au poste"
                : (isSansTitulaire ? "Poste actif sans titulaire : fragilitÃ© 100%" : "Indice de fragilitÃ© du poste");
              const score = clamp(Number(r.indice_fragilite || 0), 0, 100);
              const etat = isNonAnalyse ? "Non analysÃ©" : stateLabel(score);
              const idPoste = (r.id_poste || "").toString().trim();

              return `
                <tr class="risk-poste-row" data-id_poste="${escapeHtml(idPoste)}">
                  <td class="risk-poste-open" style="cursor:pointer;">
                    <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                      <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(codeAffiche || "â€”")}</span>
                      <span style="font-weight: var(--ns-weight-bold); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intitule)}
                      </span>
                    </div>
                  </td>
                  <td>${escapeHtml(svc)}</td>

                  <td class="col-center" title="${escapeHtml(scoreTitle)}">
                    ${isNonAnalyse ? '<span class="sb-badge">Non analysÃ©</span>' : scoreChip(score)}
                  </td>

                  <td class="col-center">${isNonAnalyse ? '<span class="sb-badge">Non analysÃ©</span>' : statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn risk-poste-open"
                              title="Voir"
                              aria-label="Voir lâ€™analyse du poste">
                        ${analyseEyeIconSvg()}
                      </button>
                      <button type="button"
                              class="sb-icon-btn sb-icon-btn--doc"
                              data-risk-poste-pdf="${escapeHtml(idPoste)}"
                              title="PDF"
                              aria-label="Exporter lâ€™analyse du poste en PDF">
                        ${analysePdfIconSvg()}
                      </button>
                    </div>
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
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun rÃ©sultat.</div>`;

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    function scoreHue(score) {
      const s = clamp(Number(score || 0), 0, 100) / 100;
      return Math.round(120 * (1 - s));
    }

    function scoreChip(score) {
      const s = clamp(Math.round(Number(score || 0)), 0, 100);
      const h = scoreHue(s);
      const fill = `hsl(${h} 70% 45%)`;

      return `
        <div style="display:flex; align-items:center; justify-content:center; gap:10px;">
          <div style="width:84px; height:10px; background:#e5e7eb; border-radius:999px; overflow:hidden;">
            <div style="height:100%; width:${s}%; background:${fill};"></div>
          </div>
          <div style="min-width:44px; text-align:right; font-weight: var(--ns-weight-bold);">
            ${s}<span style="font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs);">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Ã‰levÃ©";
      if (s >= 25) return "ModÃ©rÃ©";
      return "Faible";
    }

    function statePill(label, score) {
      const s = clamp(Math.round(Number(score || 0)), 0, 100);
      const h = scoreHue(s);
      const bg = `hsl(${h} 70% 95%)`;
      const br = `hsl(${h} 70% 80%)`;
      const tx = `hsl(${h} 70% 28%)`;

      return `
        <span style="
          display:inline-flex; align-items:center; justify-content:center;
          padding:4px 10px; border-radius:999px;
          border:1px solid ${br}; background:${bg}; color:${tx};
          font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;
        ">
          ${escapeHtml(label)}
        </span>
      `;
    }

    return `
      <div class="table-wrap sb-tip-host" style="margin-top:10px;">
        <table class="sb-table" id="tblRiskCompetences">
          <thead>
            <tr>
              <th>Code â€“ CompÃ©tence</th>
              <th class="col-center" style="width:220px;">Domaine</th>

              <th class="col-center" style="width:220px;">
                <span class="sb-th-with-tip">
                  <span>Indice<br>de fragilitÃ©</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index-competence"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilitÃ© compÃ©tence">i</span>
                </span>
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height: var(--ns-leading-tight);">
                Ã‰tat
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = (r.code || "â€”").toString().trim();
              const intit = (r.intitule || "â€”").toString();
              const idComp = (r.id_competence || r.id_comp || r.id_competence_skillboard || r.id_competence_pk || "").toString().trim();
              const compKey = (idComp || code || "").trim();
              const score = clamp(Number(r.indice_fragilite || 0), 0, 100);
              const etat = stateLabel(score);

              return `
                <tr class="risk-comp-row"
                    data-comp-key="${escapeHtml(compKey)}"
                    data-code="${escapeHtml(code)}"
                    data-id_comp="${escapeHtml(idComp)}">

                  <td class="risk-comp-open" style="cursor:pointer;">
                    <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                      <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code || "â€”")}</span>
                      <span style="font-weight: var(--ns-weight-bold); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intit)}
                      </span>
                    </div>
                  </td>

                  <td style="text-align:left;">${renderDomainPill(r)}</td>

                  <td class="col-center" title="Indice de fragilitÃ© de la compÃ©tence">${scoreChip(score)}</td>

                  <td class="col-center">${statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn risk-comp-open"
                              title="Voir"
                              aria-label="Voir lâ€™analyse de la compÃ©tence">
                        ${analyseEyeIconSvg()}
                      </button>
                      <button type="button"
                              class="sb-icon-btn sb-icon-btn--doc"
                              data-risk-comp-pdf="${escapeHtml(compKey)}"
                              title="PDF"
                              aria-label="Exporter lâ€™analyse de la compÃ©tence en PDF">
                        ${analysePdfIconSvg()}
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }





  function previsionDeltaBadge(delta) {
    const d = Math.round(Number(delta || 0));
    if (d === 0) {
      return `<span class="sb-badge" title="Aucune Ã©volution dÃ©tectÃ©e">0%</span>`;
    }
    const mod = d > 0 ? "sb-badge--danger" : "sb-badge--success";
    const txt = `${d > 0 ? "+" : ""}${d}%`;
    return `<span class="sb-badge ${mod}" title="Ã‰volution depuis la situation actuelle">${escapeHtml(txt)}</span>`;
  }



  // ======================================================
  // PrÃ©visions RH - transition console helpers
  // ======================================================
  function analysePrevisionValidKpi(key) {
    const k = (key || "").toString().trim().toLowerCase();
    return ["sorties-confirmees", "sorties-potentielles", "transmissions"].includes(k) ? k : "sorties-confirmees";
  }

  function analysePriorityBadge(label) {
    const txt = (label || "â€”").toString();
    const k = txt.toLowerCase();
    const tone = k.includes("crit") ? "#991b1b" : (k.includes("Ã©lev") || k.includes("elev") ? "#9a3412" : (k.includes("mod") ? "#854d0e" : "#166534"));
    const bg = k.includes("crit") ? "#fee2e2" : (k.includes("Ã©lev") || k.includes("elev") ? "#ffedd5" : (k.includes("mod") ? "#fef3c7" : "#dcfce7"));
    const br = k.includes("crit") ? "#fecaca" : (k.includes("Ã©lev") || k.includes("elev") ? "#fed7aa" : (k.includes("mod") ? "#fde68a" : "#bbf7d0"));
    return `<span style="display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:999px; border:1px solid ${br}; background:${bg}; color:${tone}; font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">${escapeHtml(txt)}</span>`;
  }

  function analysePrevisionDate(v) {
    const s = (v || "").toString().trim();
    if (!s) return "â€”";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(s);
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  async function fetchPrevisionsTransitionDetail(portal, kind, horizonYears, id_service, limit = 2000) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");

    const k = kind === "potential" ? "sorties-potentielles" : "sorties-confirmees";
    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${ctx.apiBase}/skills/analyse/previsions/${k}/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  async function fetchPrevisionsTransitionModalDetail(portal, row, kind, horizonYears, id_service) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");

    const idEffectif = String(row?.id_effectif || "").trim();
    if (!idEffectif) throw new Error("Collaborateur introuvable pour cette sortie.");

    const qs = new URLSearchParams();
    qs.set("kind", kind === "potential" ? "potential" : "confirmed");
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("_", String(Date.now()));

    const url = `${ctx.apiBase}/skills/analyse/previsions/transition-modal/${encodeURIComponent(ctx.id_contact)}/${encodeURIComponent(idEffectif)}?${qs.toString()}`;
    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  async function fetchPrevisionsTransmissionsDetail(portal, horizonYears, id_service, limit = 2000) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable cÃ´tÃ© UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable cÃ´tÃ© UI.");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${ctx.apiBase}/skills/analyse/previsions/transmissions/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  function analysePrevisionYear(value) {
    const raw = (value || "").toString().trim();
    if (!raw) return "â€”";
    const m = raw.match(/(19|20)\d{2}/);
    return m ? m[0] : raw;
  }

  function analysePrevisionPct(value) {
    const n = Math.round(Number(value || 0));
    return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
  }

  function analysePrevisionRingHtml(pct, title, valueText, bodyText, opts = {}) {
    const s = analysePrevisionPct(pct);
    const size = Math.max(96, Math.min(140, Number(opts.size || 118) || 118));
    const stroke = 11;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - s / 100);
    const mode = (opts.mode || "good").toString().trim().toLowerCase();
    const hue = mode === "risk" ? Math.round(120 * (1 - s / 100)) : Math.round(120 * (s / 100));
    const fill = `hsl(${hue} 70% 42%)`;
    const detailKey = (opts.detailKey || "").toString().trim();
    const detailBtn = detailKey ? `
      <button type="button" class="sb-prev-ring-detail-btn" data-prev-capacity-detail="${escapeHtml(detailKey)}" title="Voir le dÃ©tail" aria-label="Voir le dÃ©tail ${escapeHtml(title || "")}">
        ${analyseEyeIconSvg()}
      </button>
    ` : "";
    return `
      <div class="card sb-prev-ring-card">
        ${detailBtn}
        <div class="sb-prev-ring-title">${escapeHtml(title || "â€”")}</div>
        <div class="sb-prev-ring-visual" style="width:${size}px; height:${size}px; flex-basis:${size}px;">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" class="sb-prev-ring-svg">
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${fill}" stroke-width="${stroke}"
                    stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
                    transform="rotate(-90 ${size / 2} ${size / 2})" />
          </svg>
          <div class="sb-prev-ring-percent">
            <div>${s}<span>%</span></div>
          </div>
        </div>
        <div class="sb-prev-ring-value">${escapeHtml(valueText || "â€”")}</div>
        <div class="sb-prev-ring-text">${escapeHtml(bodyText || "")}</div>
      </div>
    `;
  }

  function analysePrevisionFirstName(full) {
    const s = (full || "").toString().trim();
    if (!s) return "ce collaborateur";
    return s.split(/\s+/)[0] || "ce collaborateur";
  }

  function analysePrevisionUniqueSentence(firstName, uniqueCount) {
    const who = (firstName || "ce collaborateur").toString().trim() || "ce collaborateur";
    const n = Math.max(0, Math.round(Number(uniqueCount || 0)));
    if (n <= 0) return `Dans les compÃ©tences que ${who} peut transmettre, aucune ne repose uniquement sur ${who}.`;
    if (n === 1) return `Dans les compÃ©tences que ${who} peut transmettre, 1 compÃ©tence nâ€™a aucune autre personne capable dâ€™assurer la transmission.`;
    return `Dans les compÃ©tences que ${who} peut transmettre, ${n} compÃ©tences nâ€™ont aucune autre personne capable dâ€™assurer la transmission.`;
  }

  function analysePrevisionOtherTransmitterSentence(firstName, otherCount, nonTransmissibleCount) {
    const who = (firstName || "ce collaborateur").toString().trim() || "ce collaborateur";
    const n = Math.max(0, Math.round(Number(otherCount || 0)));
    const total = Math.max(0, Math.round(Number(nonTransmissibleCount || 0)));
    if (total <= 0) return `${who} peut transmettre toutes les compÃ©tences connues de son poste.`;
    if (n <= 0) return `Sur les compÃ©tences que ${who} ne peut pas transmettre, aucun autre transmetteur disponible nâ€™est identifiÃ©.`;
    if (n === 1) return `Sur les compÃ©tences que ${who} ne peut pas transmettre, 1 compÃ©tence dispose dâ€™un autre transmetteur disponible.`;
    return `Sur les compÃ©tences que ${who} ne peut pas transmettre, ${n} compÃ©tences disposent dâ€™un autre transmetteur disponible.`;
  }

  function analysePrevisionCapacityStatusBadge(ok) {
    return ok
      ? `<span class="sb-badge sb-badge--success">Atteint</span>`
      : `<span class="sb-badge sb-badge--danger">Non atteint</span>`;
  }

  function analysePrevisionCriticityBadge(value) {
    const n = Math.max(0, Math.min(100, Math.round(Number(value || 0))));
    const lvl = n >= 90 ? 5 : (n >= 80 ? 4 : (n >= 70 ? 3 : (n >= 50 ? 2 : 1)));
    return `<span class="sb-crit-badge sb-crit-l${lvl}" title="CriticitÃ©">${escapeHtml(String(n))}</span>`;
  }

  function analysePrevisionCapacityCompLabel(c) {
    const code = (c?.code || "").toString().trim();
    const intitule = (c?.intitule || "â€”").toString().trim();
    return `${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ""}<span class="sb-prev-capacity-comp-title">${escapeHtml(intitule)}</span>`;
  }

  function analysePrevisionCapacityRowsEmpty(colspan, text) {
    return `<tr><td colspan="${Number(colspan || 1)}" class="sb-muted" style="text-align:center; padding:18px;">${escapeHtml(text || "Aucune donnÃ©e Ã  afficher.")}</td></tr>`;
  }

  function analysePrevisionCompetencePdfButton(c) {
    const key = (c?.id_comp || c?.code || "").toString().trim();
    if (!key) return "";
    return `
      <button type="button" class="sb-icon-btn sb-icon-btn--doc sb-prev-capacity-pdf-btn" data-poste-dep-comp-pdf="${escapeHtml(key)}" title="Voir la fiche compÃ©tence" aria-label="Voir la fiche compÃ©tence">
        ${analysePdfIconSvg()}
      </button>
    `;
  }

  function analysePrevisionTransmitterNameHtml(p) {
    const full = (p?.full || `${p?.prenom_effectif || ""} ${p?.nom_effectif || ""}`.trim() || "â€”").toString().trim() || "â€”";
    return `<span class="sb-prev-transmitter-label">${escapeHtml(full)}</span>`;
  }

  function analysePrevisionCapacityTransmittersHtml(list) {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) return `<span class="sb-muted">Aucun transmetteur disponible</span>`;
    return `
      <div class="sb-prev-transmitter-list">
        ${items.map(p => analysePrevisionTransmitterNameHtml(p)).join("")}
      </div>
    `;
  }

  function analysePrevisionOtherAccordionRows(list) {
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) return analysePrevisionCapacityRowsEmpty(4, "Aucune compÃ©tence non transmissible par le sortant nâ€™est rattachÃ©e Ã  son poste.");
    return rows.map((c, idx) => {
      const rowId = `prev_other_${idx}`;
      const nb = Math.max(0, Math.round(Number(c.autres_transmissibles || 0)));
      return `
        <tr class="sb-prev-capacity-acc-row" data-prev-other-row="${escapeHtml(rowId)}">
          <td>
            <button type="button" class="sb-prev-capacity-acc-btn" data-prev-other-toggle="${escapeHtml(rowId)}" aria-expanded="false" title="Afficher les personnes">
              <span class="sb-acc-chevron">âŒ„</span>
              <span class="sb-prev-capacity-acc-label">${analysePrevisionCapacityCompLabel(c)}</span>
            </button>
          </td>
          <td class="col-center"><span class="sb-badge ${nb > 0 ? "sb-badge--success" : ""}">${escapeHtml(String(nb))}</span></td>
          <td class="col-center">${analysePrevisionCriticityBadge(c.criticite)}</td>
          <td class="col-center">${analysePrevisionCompetencePdfButton(c)}</td>
        </tr>
        <tr class="sb-prev-capacity-acc-detail" data-prev-other-detail="${escapeHtml(rowId)}" style="display:none;">
          <td colspan="4">${analysePrevisionCapacityTransmittersHtml(c.autres_transmetteurs)}</td>
        </tr>
      `;
    }).join("");
  }

  function ensureAnalysePrevisionCapacityDetailModal() {
    let modal = byId("modalAnalysePrevisionCapacityDetail");
    if (modal) return modal;
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal sb-prev-capacity-detail-modal" id="modalAnalysePrevisionCapacityDetail" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div class="modal-title" id="analysePrevisionCapacityDetailTitle">DÃ©tail</div>
            <button type="button" class="modal-x" id="btnCloseAnalysePrevisionCapacityDetail" aria-label="Fermer">Ã—</button>
          </div>
          <div class="modal-body" id="analysePrevisionCapacityDetailBody"></div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--accent" id="btnAnalysePrevisionCapacityDetailClose">Fermer</button>
          </div>
        </div>
      </div>
    `);
    modal = byId("modalAnalysePrevisionCapacityDetail");
    const close = () => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    };
    byId("btnCloseAnalysePrevisionCapacityDetail")?.addEventListener("click", close);
    byId("btnAnalysePrevisionCapacityDetailClose")?.addEventListener("click", close);
    modal.addEventListener("click", (ev) => {
      const toggle = ev.target?.closest?.("[data-prev-other-toggle]");
      if (toggle) {
        ev.preventDefault();
        ev.stopPropagation();
        const key = (toggle.getAttribute("data-prev-other-toggle") || "").trim();
        const detail = key ? modal.querySelector(`[data-prev-other-detail="${key}"]`) : null;
        const open = detail && detail.style.display === "none";
        if (detail) detail.style.display = open ? "table-row" : "none";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.classList.toggle("is-open", !!open);
        return;
      }
      if (ev.target === modal) close();
    });
    return modal;
  }

  function openAnalysePrevisionCapacityDetail(kind) {
    const state = window.__sbPrevisionTransitionModalState || {};
    const item = state.item || state.row || {};
    const cap = item.transmission_capacity || {};
    const key = (kind || "").toString().trim().toLowerCase();
    const modal = ensureAnalysePrevisionCapacityDetailModal();
    const title = byId("analysePrevisionCapacityDetailTitle");
    const body = byId("analysePrevisionCapacityDetailBody");

    const all = Array.isArray(cap.competences) ? cap.competences : [];
    const unique = Array.isArray(cap.unique_competences) ? cap.unique_competences : [];
    const other = Array.isArray(cap.other_transmitter_competences) ? cap.other_transmitter_competences : [];
    const requiredLabel = cap.threshold_label || "AvancÃ© haut ou Expert";

    if (key === "unique") {
      const firstName = analysePrevisionFirstName(item.full || `${item.prenom_effectif || ""} ${item.nom_effectif || ""}`.trim());
      if (title) title.textContent = `CompÃ©tences possÃ©dÃ©es uniquement par ${firstName}`;
      if (body) body.innerHTML = `
        <div class="table-wrap sb-prev-capacity-detail-table">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
            <thead><tr><th>CompÃ©tence</th><th class="col-center">CriticitÃ©</th><th class="col-center"></th></tr></thead>
            <tbody>
              ${unique.length ? unique.map(c => `<tr><td>${analysePrevisionCapacityCompLabel(c)}</td><td class="col-center">${analysePrevisionCriticityBadge(c.criticite)}</td><td class="col-center">${analysePrevisionCompetencePdfButton(c)}</td></tr>`).join("") : analysePrevisionCapacityRowsEmpty(3, "Aucune compÃ©tence transmissible nâ€™est dÃ©tenue uniquement par le sortant.")}
            </tbody>
          </table>
        </div>
      `;
    } else if (key === "other") {
      if (title) title.textContent = "Autres transmetteurs disponibles";
      if (body) body.innerHTML = `
        <div class="table-wrap sb-prev-capacity-detail-table">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-prev-capacity-acc-table">
            <thead><tr><th>CompÃ©tence</th><th class="col-center">Potentiel de transmission</th><th class="col-center">CriticitÃ©</th><th class="col-center"></th></tr></thead>
            <tbody>
              ${analysePrevisionOtherAccordionRows(other)}
            </tbody>
          </table>
        </div>
      `;
    } else {
      if (title) title.textContent = "CompÃ©tences transmissibles";
      if (body) body.innerHTML = `
        <div class="table-wrap sb-prev-capacity-detail-table">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
            <thead><tr><th>CompÃ©tence</th><th class="col-center">Niveau requis de transmission</th><th class="col-center">CriticitÃ©</th><th class="col-center"></th></tr></thead>
            <tbody>
              ${all.length ? all.map(c => `
                <tr>
                  <td>${analysePrevisionCapacityCompLabel(c)}</td>
                  <td class="col-center"><span title="${escapeHtml(c.transmission_required_label || requiredLabel)}">${analysePrevisionCapacityStatusBadge(!!c.sortant_transmissible)}</span></td>
                  <td class="col-center">${analysePrevisionCriticityBadge(c.criticite)}</td>
                  <td class="col-center">${analysePrevisionCompetencePdfButton(c)}</td>
                </tr>
              `).join("") : analysePrevisionCapacityRowsEmpty(4, "Aucune compÃ©tence active nâ€™est rattachÃ©e au poste du sortant.")}
            </tbody>
          </table>
        </div>
      `;
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function analysePrevisionFragilityBadge(value) {
    const s = analysePrevisionPct(value);
    const hue = Math.round(120 * (1 - s / 100));
    return `<span style="display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:999px; border:1px solid hsl(${hue} 70% 80%); background:hsl(${hue} 70% 95%); color:hsl(${hue} 70% 28%); font-weight: var(--ns-weight-bold); font-size: var(--ns-text-xs); white-space:nowrap;">${escapeHtml(String(s))}%</span>`;
  }

  function ensureAnalysePrevisionActionModal() {
    let modal = byId("modalAnalysePrevisionAction");
    if (modal) return modal;
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal" id="modalAnalysePrevisionAction" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
              <div class="modal-title" id="analysePrevisionActionTitle">DÃ©tail prÃ©visionnel</div>
              <div class="card-sub" id="analysePrevisionActionSub" style="margin:0; display:none;"></div>
            </div>
            <button type="button" class="modal-x" id="btnCloseAnalysePrevisionActionModal" aria-label="Fermer">Ã—</button>
          </div>
          <div class="modal-body" id="analysePrevisionActionBody"></div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--accent" id="btnAnalysePrevisionOpenSimulation">PrÃ©parer le scÃ©nario RH</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnAnalysePrevisionActionClose">Fermer</button>
          </div>
        </div>
      </div>
    `);
    modal = byId("modalAnalysePrevisionAction");
    const close = () => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    };
    byId("btnCloseAnalysePrevisionActionModal")?.addEventListener("click", close);
    byId("btnAnalysePrevisionActionClose")?.addEventListener("click", close);
    byId("btnAnalysePrevisionOpenSimulation")?.addEventListener("click", () => {
      const state = window.__sbPrevisionTransitionModalState || {};
      const r = state.item || state.row || {};
      const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "Collaborateur";
      if (state.mode === "transmission") {
        const code = String(r.code || "").trim();
        const comp = String(r.intitule || "CompÃ©tence").trim() || "CompÃ©tence";
        openSimulationsRhContext({
          type: "prevision_transmission",
          title: `Transmission Ã  prÃ©parer Â· ${code ? code + " Â· " : ""}${comp}`,
          competence_id: String(r.id_comp || "").trim(),
          competence_code: code,
          competence_label: comp,
          poste_id: String(r.id_poste_actuel || "").trim(),
          poste_label: r.intitule_poste || "Poste non renseignÃ©",
          reason: "PrÃ©vision : intÃ©grer l'Ã©chÃ©ance dans un scÃ©nario RH de remplacement, transfert de charge, recrutement ou compensation organisationnelle.",
        });
      } else {
        openSimulationsRhContext({
          type: "prevision_sortie",
          title: `Sortie Ã  intÃ©grer Â· ${full}`,
          effectif_id: String(r.id_effectif || "").trim(),
          effectif_label: full,
          poste_id: String(r.id_poste_actuel || "").trim(),
          poste_label: r.intitule_poste || "Poste non renseignÃ©",
          reason: "PrÃ©vision : construire un scÃ©nario avec dÃ©part, remplacement, transfert de personne, transfert de charge ou recrutement.",
        });
      }
      close();
    });
    modal.addEventListener("click", (ev) => {
      const detailBtn = ev.target?.closest?.("[data-prev-capacity-detail]");
      if (detailBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        openAnalysePrevisionCapacityDetail(detailBtn.getAttribute("data-prev-capacity-detail") || "transmissible");
        return;
      }
      if (ev.target === modal) close();
    });
    return modal;
  }

  function renderAnalysePrevisionTransitionModal(row, kind) {
    const r = row || {};
    const isPotential = kind === "potential";
    const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "Collaborateur";
    const firstName = analysePrevisionFirstName(full);
    const code = (r.codif_client || r.codif_poste || "").toString().trim();
    const poste = (r.intitule_poste || "Poste non renseignÃ©").toString();
    const reason = (r.raison_sortie || r.event_kind_label || (isPotential ? "Retraite estimÃ©e" : "Sortie prÃ©vue")).toString();
    const dateLabel = isPotential
      ? `Horizon de dÃ©part : ${analysePrevisionYear(r.exit_date || r.retraite_annee || r.horizon_year)}`
      : `Date de dÃ©part : ${analysePrevisionDate(r.exit_date)}`;

    const cap = r.transmission_capacity || {};
    const total = Number(cap.total_competences_poste || 0) || 0;
    const transmissibles = Number(cap.transmissibles_count || 0) || 0;
    const uniques = Number(cap.unique_transmissibles_count || 0) || 0;
    const otherTransmitters = Number(cap.other_transmitter_count || 0) || 0;
    const nonTransmissibles = Math.max(total - transmissibles, 0);
    const capPct = analysePrevisionPct(cap.coverage_pct);
    const uniquePct = analysePrevisionPct(cap.unique_share_pct);
    const otherPct = analysePrevisionPct(cap.other_transmitter_pct);
    const impacts = r.other_poste_impacts || {};
    const impactItems = Array.isArray(impacts.items) ? impacts.items : [];

    const transmissionText = `Le niveau de maÃ®trise requis pour la transmission est prÃ©sent sur ${transmissibles}/${total} compÃ©tence${total > 1 ? "s" : ""}.`;
    const uniqueText = analysePrevisionUniqueSentence(firstName, uniques);
    const otherText = analysePrevisionOtherTransmitterSentence(firstName, otherTransmitters, nonTransmissibles);

    const impactHtml = impactItems.length ? `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Poste impactÃ©</th>
              <th>Service</th>
              <th class="col-center">FragilitÃ© actuelle</th>
              <th class="col-center">Avec sortie</th>
              <th class="col-center">Ã‰volution</th>
            </tr>
          </thead>
          <tbody>${impactItems.map(p => {
            const pCode = (p.codif_client || p.codif_poste || "").toString().trim();
            const pLabel = (p.intitule_poste || "â€”").toString();
            const now = analysePrevisionPct(p.indice_fragilite_now);
            const after = analysePrevisionPct(p.indice_fragilite_after);
            const delta = Math.max(0, Math.round(Number(p.delta_fragilite || 0)));
            return `<tr>
              <td>${pCode ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(pCode)}</span> ` : ""}<strong>${escapeHtml(pLabel)}</strong></td>
              <td>${escapeHtml(p.nom_service || "â€”")}</td>
              <td class="col-center">${analysePrevisionFragilityBadge(now)}</td>
              <td class="col-center">${analysePrevisionFragilityBadge(after)}</td>
              <td class="col-center"><span class="sb-badge sb-badge--warning">+${escapeHtml(String(delta))}%</span></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    ` : `<div class="card-sub" style="margin:8px 0 0 0;">Aucun autre poste ne voit sa fragilitÃ© augmenter avec cette personne en moins sur le pÃ©rimÃ¨tre filtrÃ©.</div>`;


    return `
      <div class="sb-prev-modal-grid" style="display:flex; flex-direction:column; gap:12px;">
        <div class="sb-prev-actions-card card" style="padding:14px; margin:0;">
          <div class="sb-prev-modal-title" style="margin-bottom:10px;">Identification du sortant</div>
          <div style="display:flex; flex-direction:column; gap:7px; min-width:0;">
            <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-title-sm); line-height: var(--ns-leading-tight); color:#111827;">${escapeHtml(full)}</div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
              ${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span>` : ""}
              <span style="font-size: var(--ns-text-sm); font-weight: var(--ns-weight-bold); color:#111827; min-width:0;">${escapeHtml(poste)}</span>
            </div>
            <div class="card-sub" style="margin:0; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
              <span>${escapeHtml(dateLabel)}</span>
              ${reason ? `<span>Â·</span><span>${escapeHtml(reason)}</span>` : ""}
            </div>
          </div>
        </div>

        <div class="sb-prev-actions-card card" style="padding:14px; margin:0;">
          <div class="sb-prev-modal-title">CapacitÃ© de transmission Ã  son poste</div>
          <div class="sb-prev-ring-grid">
            ${analysePrevisionRingHtml(capPct, "CompÃ©tences transmissibles", `${transmissibles} / ${total}`, transmissionText, { mode: "good", detailKey: "transmissible" })}
            ${analysePrevisionRingHtml(uniquePct, "Sans relais identifiÃ©", `${uniques} / ${transmissibles}`, uniqueText, { mode: "risk", detailKey: "unique" })}
            ${analysePrevisionRingHtml(otherPct, "Autre transmetteur", `${otherTransmitters} / ${nonTransmissibles}`, otherText, { mode: "good", detailKey: "other" })}
          </div>
        </div>

        <div class="sb-prev-actions-card card" style="padding:14px; margin:0;">
          <div class="sb-prev-modal-title" style="margin-bottom:10px;">Impact sur les autres postes</div>
          ${impactHtml}
        </div>
      </div>
    `;
  }

  async function openAnalysePrevisionTransitionModal(row, kind) {
    const mode = kind === "potential" ? "potential" : "confirmed";
    const modal = ensureAnalysePrevisionActionModal();
    const title = byId("analysePrevisionActionTitle");
    const sub = byId("analysePrevisionActionSub");
    const body = byId("analysePrevisionActionBody");
    const titleText = mode === "potential" ? "Sortie potentielle" : "Sortie confirmÃ©e";
    const horizon = getPrevHorizon();
    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");

    window.__sbPrevisionTransitionModalState = { mode: "transition", kind: mode, row: row || {}, item: row || {} };
    if (title) title.textContent = titleText;
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
    if (body) body.innerHTML = `<div class="card-sub" style="margin:0;">Chargementâ€¦</div>`;

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    try {
      const data = await fetchPrevisionsTransitionModalDetail(_portalref, row, mode, horizon, id_service);
      const item = data?.item || row || {};
      window.__sbPrevisionTransitionModalState = { mode: "transition", kind: mode, row: row || {}, item };
      if (body) body.innerHTML = renderAnalysePrevisionTransitionModal(item, mode);
    } catch (e) {
      if (body) body.innerHTML = `<div class="sb-prev-empty">Impossible de charger le dÃ©tail de la sortie : ${escapeHtml(e?.message || e)}</div>`;
    }
  }

  function openAnalysePrevisionTransmissionModal(row) {
    const r = row || {};
    const modal = ensureAnalysePrevisionActionModal();
    const title = byId("analysePrevisionActionTitle");
    const sub = byId("analysePrevisionActionSub");
    const body = byId("analysePrevisionActionBody");

    const code = String(r.code || "").trim();
    const comp = String(r.intitule || "CompÃ©tence").trim() || "CompÃ©tence";
    const full = r.sortants_label || r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "collaborateur concernÃ©";
    const dateTxt = analysePrevisionDate(r.exit_date || r.first_exit_date);
    const impactCount = Math.max(0, Math.round(Number(r.nb_postes_impactes || 0)));

    function parseTransmitters(value, fallbackLabel) {
      let raw = value;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch (_) { raw = null; }
      }
      const out = [];
      const seen = new Set();

      const pushItem = (item) => {
        if (!item || typeof item !== "object") return;
        const name = String(item.full || `${item.prenom_effectif || ""} ${item.nom_effectif || ""}`.trim()).trim();
        if (!name || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        out.push({
          full: name,
          niveau: item.niveau_actuel || item.niveau || "",
          poste_code: item.codif_client || item.codif_poste || "",
          poste_label: item.intitule_poste || "",
          date_derniere_eval: item.date_derniere_eval || item.date_eval || item.last_eval_date || "",
          transmission_status: item.transmission_status || "review",
          transmission_status_label: item.transmission_status_label || "Entretien recommandÃ©"
        });
      };

      if (Array.isArray(raw)) raw.forEach(pushItem);

      if (!out.length) {
        String(fallbackLabel || "")
          .split(",")
          .map(x => x.trim())
          .filter(Boolean)
          .forEach((name) => pushItem({ full: name, transmission_status: "review", transmission_status_label: "Entretien recommandÃ©" }));
      }
      return out;
    }

    function transmissionStatusBadgeHtml(status, label) {
      const s = String(status || "review").toLowerCase();
      if (s === "validated") return `<span class="sb-badge sb-badge--success">ValidÃ©</span>`;
      if (s === "confirm") return `<span class="sb-badge sb-badge--info">Ã€ confirmer</span>`;
      return `<span class="sb-badge sb-badge--formateur">${escapeHtml(label || "Entretien recommandÃ©")}</span>`;
    }

    const transmitters = parseTransmitters(
      r.transmetteurs_potentiels_json || r.receveurs_potentiels_json || r.transmetteurs_potentiels || r.receveurs_potentiels,
      r.transmetteurs_potentiels_label || r.receveurs_potentiels_label
    );

    const transmittersHtml = transmitters.length ? `
      <div class="table-wrap sb-prev-transmission-table-wrap">
        <table class="sb-table sb-table--airy sb-prev-transmission-table">
          <thead>
            <tr>
              <th>Personne</th>
              <th>Poste</th>
              <th class="col-center">Niveau</th>
              <th class="col-center">DerniÃ¨re Ã©val.</th>
              <th class="col-center">Transmission</th>
            </tr>
          </thead>
          <tbody>
            ${transmitters.map((p) => `
              <tr>
                <td><strong>${escapeHtml(p.full || "â€”")}</strong></td>
                <td>${p.poste_code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(p.poste_code)}</span> ` : ""}${escapeHtml(p.poste_label || "â€”")}</td>
                <td class="col-center">${p.niveau ? nsLevelBadgeHtml(p.niveau, "Niveau de maÃ®trise") : `<span class="sb-muted">â€”</span>`}</td>
                <td class="col-center">${analysePrevisionDate(p.date_derniere_eval)}</td>
                <td class="col-center">${transmissionStatusBadgeHtml(p.transmission_status, p.transmission_status_label)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : `
      <div class="sb-prev-empty" style="margin:0;">Aucune personne en capacitÃ© de transmettre nâ€™est identifiÃ©e sur le pÃ©rimÃ¨tre.</div>
    `;


    window.__sbPrevisionTransitionModalState = { mode: "transmission", row: r };
    if (title) title.textContent = "Transmission Ã  prÃ©parer";
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
    if (body) {
      body.innerHTML = `
        <div class="sb-prev-modal-grid sb-prev-transmission-modal sb-prev-transmission-modal--simple">
          <div class="sb-prev-actions-card card sb-prev-transmission-hero">
            <div class="sb-prev-modal-title">CompÃ©tence concernÃ©e</div>
            <div class="sb-prev-transmission-hero-line">
              <div class="sb-prev-transmission-comp">
                ${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ""}
                <strong>${escapeHtml(comp)}</strong>
              </div>
              <div class="sb-icon-actions">${analysePrevisionCompetencePdfButton(r)}</div>
            </div>
            <div class="sb-prev-transmission-meta">
              <span>CriticitÃ© ${analysePrevisionCriticityBadge(r.max_criticite)}</span>
              <span>${impactCount} poste${impactCount > 1 ? "s" : ""} concernÃ©${impactCount > 1 ? "s" : ""}</span>
              <span>Ã€ transmettre avant ${dateTxt && dateTxt !== "â€”" ? escapeHtml(dateTxt) : "lâ€™Ã©chÃ©ance identifiÃ©e"}</span>
            </div>
          </div>

          <div class="sb-prev-actions-card card">
            <div class="sb-prev-modal-title">Personnes en capacitÃ© de transmettre</div>
            ${transmittersHtml}
          </div>
        </div>
      `;
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function renderPrevisionTableTransitionEvents(rows, kind) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun rÃ©sultat.</div>`;
    const isPotential = kind === "potential";

    const yearOnly = (value) => {
      const raw = (value || "").toString().trim();
      if (!raw) return "â€”";
      for (let i = 0; i <= raw.length - 4; i += 1) {
        const part = raw.slice(i, i + 4);
        if (/^(19|20)\d{2}$/.test(part)) return part;
      }
      return raw;
    };

    const potentialYear = (r) => yearOnly(
      r.horizon_year || r.annee || r.exit_date || r.retraite_estimee || r.date_sortie_prevue || r.horizon_label
    );

    window.__sbPrevTransitionRows = list;
    return `
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevTransitions">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th>Poste</th>
              <th style="width:120px;">${isPotential ? "Horizon" : "Date"}</th>
              ${isPotential
                ? `<th style="width:190px;">Motif</th>`
                : `<th style="width:190px;">Motif de dÃ©part</th>`}
              <th class="col-center" style="width:82px;">Actions</th>
            </tr>
          </thead>
          <tbody>${list.map((r, idx) => {
            const full = r.full || `${r.prenom_effectif || ""} ${r.nom_effectif || ""}`.trim() || "â€”";
            const code = (r.codif_client || r.codif_poste || "").toString().trim();
            const poste = (r.intitule_poste || "â€”").toString();
            const motif = isPotential ? "Retraite estimÃ©e" : (r.raison_sortie || r.event_kind_label || "Sortie prÃ©vue").toString();
            return `<tr class="prev-transition-row" data-index="${idx}">
              <td><strong>${escapeHtml(full)}</strong></td>
              <td>${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span> ` : ""}${escapeHtml(poste)}</td>
              <td>${isPotential ? escapeHtml(potentialYear(r)) : analysePrevisionDate(r.exit_date)}</td>
              <td>${escapeHtml(motif)}</td>
              <td class="col-center"><button type="button" class="sb-icon-btn prev-transition-open" title="Voir" aria-label="Voir le dÃ©tail">${analyseEyeIconSvg()}</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }
  function renderPrevisionTableTransmissionItems(rows) {
    const transmissionOrderFallback = (r) => {
      const status = String(r.expertise_status || r.expertise_color || "red").toLowerCase();
      if (status === "green") return 3;
      if (status === "blue") return 2;
      if (status === "pink" || status === "orange") return 1;
      return 0;
    };
    const list = (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
      const ao = Number(a.expertise_order ?? transmissionOrderFallback(a));
      const bo = Number(b.expertise_order ?? transmissionOrderFallback(b));
      if (ao !== bo) return ao - bo;
      const bc = Number(b.max_criticite || 0) - Number(a.max_criticite || 0);
      if (bc !== 0) return bc;
      const bp = Number(b.nb_postes_impactes || 0) - Number(a.nb_postes_impactes || 0);
      if (bp !== 0) return bp;
      return String(a.exit_date || "").localeCompare(String(b.exit_date || ""));
    });
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun rÃ©sultat.</div>`;
    window.__sbPrevTransmissionRows = list;

    const expertiseDot = (r) => {
      const status = String(r.expertise_status || r.expertise_color || "red").toLowerCase();
      const cfg = status === "green"
        ? { color: "#16a34a", label: "Transmission validÃ©e", title: "Au moins une personne au niveau Expert dispose dâ€™une Ã©valuation rÃ©cente." }
        : status === "blue"
          ? { color: "#2563eb", label: "Ã€ confirmer", title: "Au moins une personne en AvancÃ© haut dispose dâ€™une Ã©valuation rÃ©cente." }
          : status === "pink"
            ? { color: "#db2777", label: "Entretien recommandÃ©", title: "Une personne semble en capacitÃ© de transmettre, mais lâ€™Ã©valuation doit Ãªtre reprise." }
            : { color: "#dc2626", label: "Aucune personne identifiÃ©e", title: "Aucune personne en capacitÃ© de transmettre nâ€™est identifiÃ©e sur cette compÃ©tence." };
      const count = Number(r.transmetteurs_potentiels_count ?? r.receveurs_potentiels_count ?? 0);
      const title = r.expertise_tooltip || cfg.title;
      return `<span title="${escapeHtml(title)}" aria-label="${escapeHtml(cfg.label)}" class="sb-prev-transmission-status-dot-wrap">
        <span class="sb-prev-transmission-status-dot" style="background:${cfg.color};"></span>
        ${Number.isFinite(count) && count > 0 ? `<span class="sb-prev-transmission-status-count">${escapeHtml(String(count))}</span>` : ""}
      </span>`;
    };

    return `
      <div class="table-wrap sb-tip-host" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevTransmissions">
          <thead>
            <tr>
              <th>CompÃ©tence</th>
              <th style="width:120px;">Ã‰chÃ©ance</th>
              <th style="width:140px;">Impact</th>
              <th class="col-center" style="width:120px;">
                <span class="sb-th-with-tip">
                  <span>Transmission</span>
                  <span class="sb-iinfo"
                        data-sbtip="prevision-transmission-expertise"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur la transmission">i</span>
                </span>
              </th>
              <th class="col-center" style="width:82px;">Actions</th>
            </tr>
          </thead>
          <tbody>${list.map((r, idx) => {
            const code = (r.code || "").toString().trim();
            const comp = (r.intitule || "â€”").toString();
            return `<tr class="prev-transmission-row" data-index="${idx}">
              <td>${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span> ` : ""}<strong>${escapeHtml(comp)}</strong></td>
              <td>${analysePrevisionDate(r.exit_date || r.first_exit_date)}</td>
              <td>${escapeHtml(r.impact_label || "â€”")}</td>
              <td class="col-center">${expertiseDot(r)}</td>
              <td class="col-center"><button type="button" class="sb-icon-btn prev-transmission-open" title="Voir" aria-label="Voir le dÃ©tail">${analyseEyeIconSvg()}</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }
  const currentRiskDetailKey = isExpandableRiskDetail(rf) ? rf : "";

  const buildResetHtml = () => "";

  function bindRiskResetBtn() {
    if (!actions) return;

    if (!currentRiskDetailKey) {
      actions.innerHTML = "";
      return;
    }

    const expanded = getRiskDetailExpanded(currentRiskDetailKey);
    actions.innerHTML = `
      <button type="button" class="sb-btn sb-btn--init sb-btn--xs" id="btnRiskDetailToggle">
        ${expanded ? "Afficher les 10 premiers" : "Afficher tout"}
      </button>
      <button type="button" class="sb-icon-btn analyse-detail-print-btn" id="btnRiskDetailPrint" title="Imprimer" aria-label="Imprimer">
        ${analysePrintIconSvg()}
      </button>
    `;

    const btnToggle = byId("btnRiskDetailToggle");
    if (btnToggle) {
      btnToggle.addEventListener("click", () => {
        setRiskDetailExpanded(currentRiskDetailKey, !getRiskDetailExpanded(currentRiskDetailKey));
        renderDetail("risques");
      });
    }

    const btnPrint = byId("btnRiskDetailPrint");
    if (btnPrint) {
      btnPrint.addEventListener("click", () => openAnalyseRiskDetailPdf(currentRiskDetailKey));
    }
  }

  body.innerHTML = `
    ${buildResetHtml()}
    <div class="card" style="padding:12px; margin:0;">
      <div class="card-sub" style="margin:0;">Chargementâ€¦</div>
    </div>
  `;
  bindRiskResetBtn();

  if (!_portalref) {
    body.innerHTML = `
      ${buildResetHtml()}
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-sub" style="margin:0;">Contexte portail indisponible.</div>
      </div>
    `;
    bindRiskResetBtn();
    return;
  }

  const mySeq = ++_riskDetailReqSeq;

  (async () => {
    try {
      if (rf === "evol-3m") {
        const svc = (id_service || "").trim();
        const crit = getCriticiteMinSafe(CRITICITE_MIN_DEFAULT);
        const [evolData, eventsData] = await Promise.all([
          computeRiskEvolution3m(_portalref, svc),
          fetchRiskProjectionEvents3m(_portalref, svc, crit),
        ]);
        if (mySeq !== _riskDetailReqSeq) return;

        const timeline = Array.isArray(evolData?.timeline) ? evolData.timeline.slice(0, 4) : [];
        const months = Array.isArray(eventsData?.months) ? eventsData.months : [];
        const monthMap = new Map(months.map(m => [Number(m.index || 0), m]));
        const nowPoint = timeline[0] || { label: "Aujourdâ€™hui", indice_fragilite: 0 };
        const nowScore = Math.round(Number(nowPoint?.indice_fragilite || 0));

        const fmtIndex = (v) => `${Math.round(Number(v) || 0)}%`;
        const eyeIcon = `
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
        const evolBadge = (delta, isToday) => {
          if (isToday) return `<span style="font-weight: var(--ns-weight-bold); color:var(--sb-gray-500);">â€”</span>`;
          const d = Math.round(Number(delta) || 0);
          const cls = d > 0 ? "sb-badge--danger" : (d < 0 ? "sb-badge--success" : "");
          const txt = d === 0 ? "Stable" : `${d > 0 ? "+" : ""}${d}%`;
          return `<span class="sb-badge ${cls}">${escapeHtml(txt)}</span>`;
        };

        const rows = [0, 1, 2, 3].map((idx) => {
          const p = timeline[idx] || null;
          const m = monthMap.get(idx) || { index: idx, label: idx === 0 ? "Aujourdâ€™hui" : `${idx} mois`, indisponibilites_count: 0, sorties_count: 0, indisponibilites: [], sorties: [] };
          const label = idx === 0 ? "Aujourdâ€™hui" : (p?.label || m.label || `${idx} mois`);
          const score = Math.round(Number(p?.indice_fragilite ?? nowScore));
          const delta = score - nowScore;
          return { ...m, index: idx, label, score, delta };
        });

        const futureRows = rows.filter(r => Number(r.index || 0) > 0);
        const peakScore = futureRows.reduce((max, r) => Math.max(max, Number(r.score || 0)), Number.NEGATIVE_INFINITY);
        const peakRow = futureRows.find(r => Number(r.score || 0) === peakScore && peakScore > nowScore) || null;
        const peakIndex = peakRow ? Number(peakRow.index || 0) : -1;

        const bodyRows = rows.map((r) => {
          const isToday = Number(r.index || 0) === 0;
          const isPeak = !isToday && Number(r.index || 0) === peakIndex;
          return `
            <tr>
              <td>
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <span>${escapeHtml(r.label)}</span>
                  ${isPeak ? `<span class="sb-badge sb-badge--warning">pic retenu</span>` : ``}
                </div>
              </td>
              <td class="col-center"><strong>${escapeHtml(fmtIndex(r.score))}</strong></td>
              <td class="col-center">${evolBadge(r.delta, isToday)}</td>
              <td class="col-center"><span class="sb-badge">${escapeHtml(String(Number(r.indisponibilites_count || 0)))}</span></td>
              <td class="col-center"><span class="sb-badge">${escapeHtml(String(Number(r.sorties_count || 0)))}</span></td>
              <td class="col-center">
                <button type="button"
                        class="sb-icon-btn"
                        title="Voir"
                        aria-label="Voir"
                        data-risk-proj-month="${escapeHtml(String(r.index))}">
                  ${eyeIcon}
                </button>
              </td>
            </tr>
          `;
        }).join("");

        const content = `
          <div class="card" style="padding:12px; margin:0;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
              <div class="card-title" style="margin:0;">${analyseDetailTitleHtml(filterLabel, "evol3m")}</div>
              <button type="button"
                      class="analyse-help-dot"
                      data-analyse-help="risques_evol3m_table"
                      aria-label="Comprendre lâ€™Ã©volution des indices de fragilitÃ©">?</button>
            </div>
            <div class="table-wrap" style="margin-top:0;">
              <table class="sb-table" id="tblRiskEvol3m">
                <thead>
                  <tr>
                    <th>Mois de projection</th>
                    <th class="col-center">Indice de fragilitÃ©</th>
                    <th class="col-center">Ã‰volution</th>
                    <th class="col-center">IndisponibilitÃ©s temporaires</th>
                    <th class="col-center">Fins de contrat / sorties prÃ©vues</th>
                    <th class="col-center">DÃ©tail</th>
                  </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
              </table>
            </div>
          </div>
        `;

        body.innerHTML = `${buildResetHtml()}${content}`;
        bindRiskResetBtn();

        body.querySelectorAll("[data-risk-proj-month]").forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const idx = Number(btn.getAttribute("data-risk-proj-month") || 0);
            const row = rows.find(x => Number(x.index || 0) === idx) || rows[0];
            openRiskProjectionMonthModal(row);
          });
        });
        return;
      }

      if (rf) {
        const detailLimit = isExpandableRiskDetail(rf) ? getRiskDetailLimit(rf) : 120;
        const data = await fetchRisquesDetail(_portalref, rf, id_service, detailLimit);
        if (mySeq !== _riskDetailReqSeq) return;

        const items = Array.isArray(data?.items) ? data.items : [];

        const content = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">${analyseDetailTitleHtml(filterLabel, (rf === "postes-scope" || rf === "postes-fragiles") ? "postes" : (rf === "evol-3m" ? "evol3m" : "competences"))}</div>
            ${(rf === "postes-scope" || rf === "postes-fragiles") ? renderTablePostes(items) : renderTableCompetences(items)}
          </div>
        `;

        body.innerHTML = `${buildResetHtml()}${content}`;
        bindRiskResetBtn();
        return;
      }


      const postesScopeLimit = POSTES_SCOPE_PREVIEW_LIMIT;
      const [a, b] = await Promise.all([
        fetchRisquesDetail(_portalref, "postes-scope", id_service, postesScopeLimit),
        fetchRisquesDetail(_portalref, "critiques-fragiles", id_service, 40),
      ]);

      if (mySeq !== _riskDetailReqSeq) return;

      const itemsA = Array.isArray(a?.items) ? a.items : [];
      const itemsB = Array.isArray(b?.items) ? b.items : [];

      body.innerHTML = `
        ${buildResetHtml()}

        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">${analyseDetailTitleHtml("FragilitÃ© des postes", "postes")}</div>
          ${renderTablePostes(itemsA)}
        </div>

        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">${analyseDetailTitleHtml("FragilitÃ©s par compÃ©tence", "competences")}</div>
          ${renderTableCompetences(itemsB)}
        </div>
      `;
      bindRiskResetBtn();


    } catch (e) {
      if (mySeq !== _riskDetailReqSeq) return;

      body.innerHTML = `
        ${buildResetHtml()}
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>
        </div>
      `;
      bindRiskResetBtn();
    }
  })();

}


  async function refreshSummary(portal) {
    clearKpis();

    const f = getFilters();
    localStorage.setItem(STORE_SERVICE, getAnalyseServiceRawValue());

    const usp = new URLSearchParams();
    if (f.id_service) usp.set("id_service", f.id_service);
    const crit = getCriticiteMinSafe(CRITICITE_MIN_DEFAULT);
    if (Number.isFinite(crit)) usp.set("criticite_min", String(crit));

    const url = `${portal.apiBase}/skills/analyse/summary/${encodeURIComponent(portal.contactId)}${usp.toString() ? "?" + usp.toString() : ""}`;

    try {
      const data = await portal.apiJson(url);
      syncCriticiteMinFromResponse(data, { commit: true, persist: true, refreshUi: true });

      const t = data?.tiles || {};

      const r = t.risques || {};
      const globalFrag = Number(r.postes_fragilite_globale);
      const compFrag = Number(r.comp_fragilite_moyenne);
      const compFragTxt = Number.isFinite(compFrag) ? `${Math.round(compFrag)}%` : (Number.isFinite(Number(r.comp_critiques_fragiles)) ? `${Number(r.comp_critiques_fragiles)} point(s)` : "â€”");
      const globalFragTxt = Number.isFinite(globalFrag) ? `${Math.round(globalFrag)}%` : "â€”";
      setText("kpiRiskPostes", globalFragTxt);
      setText("kpiRiskCritFragiles", compFragTxt);
      updateAnalyseHeaderSynthesis(data);

      setText("kpiRiskEvol3m", "â€¦");
      (async () => {
        try {
          const evo = await computeRiskEvolution3m(portal, f.id_service);
          const evoTxt = fmtPctSigned(evo?.total?.pct);
          setText("kpiRiskEvol3m", evoTxt);
        } catch (e) {
          setText("kpiRiskEvol3m", "â€”");
        }
      })();

      const p = t.previsions || {};
      applyPrevisionsKpis(p);

      setStatus("");
    } catch (e) {
      setStatus("RÃ©sumÃ© non disponible.");
    }
  }

  function setMode(mode) {
    const m = (mode || "").trim().toLowerCase();
    const finalMode = (m === "matching" || m === "previsions" || m === "risques") ? m : "risques";

    localStorage.setItem(STORE_MODE, finalMode);

    setActiveTile(finalMode);
    setText("analyseModeLabel", finalMode === "matching" ? "Correspondance profils / postes" : (finalMode === "previsions" ? "PrÃ©visions" : "Risques actuels"));
    renderDetail(finalMode);
  }

function bindOnce(portal) {
  if (_bound) return;
  _bound = true;

  // garde une ref globale (ton code sâ€™appuie dessus partout)
  _portalref = portal || _portalref;
  bindAnalyseHelpDelegation();

  try {
    const ctx0 = getPortalContext(_portalref);
    apiBase = (ctx0?.apiBase || "").toString().replace(/\/$/, "");
  } catch (e) {
    apiBase = "";
  }

  const selService = byId("analyseServiceSelect");
  const btnReset = byId("btnAnalyseReset");
  const btnApply = byId("btnAnalyseApply");
  const btnFiltersToggle = byId("btnAnalyseFiltersToggle");

  function setAnalyseFiltersOpen(open) {
    const card = byId("analyseFilterCard");
    const body = byId("analyseFilterBody");
    const isOpen = !!open;
    if (card) card.classList.toggle("is-collapsed", !isOpen);
    if (body) body.style.display = isOpen ? "" : "none";
    if (btnFiltersToggle) {
      btnFiltersToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      btnFiltersToggle.title = isOpen ? "Replier les filtres" : "DÃ©plier les filtres";
      btnFiltersToggle.setAttribute("aria-label", isOpen ? "Replier les filtres" : "DÃ©plier les filtres");
    }
    try { localStorage.setItem(STORE_FILTERS_OPEN, isOpen ? "1" : "0"); } catch (_) {}
  }

  const filtersStoredOpen = (() => {
    try { return localStorage.getItem(STORE_FILTERS_OPEN); } catch (_) { return null; }
  })();
  setAnalyseFiltersOpen(filtersStoredOpen === "0" ? false : true);

  if (btnFiltersToggle) {
    btnFiltersToggle.addEventListener("click", () => {
      const card = byId("analyseFilterCard");
      setAnalyseFiltersOpen(card ? card.classList.contains("is-collapsed") : true);
    });
  }

  // Slider PrÃ©visions (1..5 ans) - met Ã  jour les KPI de la tuile en direct
  const prevSlider = byId("prevHorizonSlider");
  function updatePrevSliderProgress() {
    if (!prevSlider) return;
    const min = Number(prevSlider.min || 1);
    const max = Number(prevSlider.max || 5);
    const val = Number(prevSlider.value || min);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    prevSlider.style.setProperty("--analyse-prev-progress", `${Math.max(0, Math.min(100, pct))}%`);
  }

  if (prevSlider) {
    const initH = getPrevHorizon();
    prevSlider.value = String(initH);
    setPrevHorizonLabel(initH);
    updatePrevSliderProgress();

    // EmpÃªche de dÃ©clencher le click sur la tuile quand on manipule le slider
    const stop = (ev) => { ev.stopPropagation(); };
    ["pointerdown", "mousedown", "click", "keydown"].forEach(evt => prevSlider.addEventListener(evt, stop));

    prevSlider.addEventListener("input", (ev) => {
      ev.stopPropagation();
      const n = setPrevHorizon(prevSlider.value);
      prevSlider.value = String(n);
      setPrevHorizonLabel(n);
      updatePrevSliderProgress();

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

  // KPI Risques cliquables => filtre du panneau dÃ©tail (sans changer de page)
  const tileRisques = byId("tileRisques");
  if (tileRisques) {
    const riskKpis = tileRisques.querySelectorAll(".mini-kpi[data-risk-kpi]");

    function openRiskKpi(el) {
      const key = (el?.getAttribute("data-risk-kpi") || "").trim();
      if (!key) return;
      if (key === "postes-scope") setPostesScopeExpanded(false);
      if (isExpandableRiskDetail(key)) setRiskDetailExpanded(key, false);
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

      // empÃªche click sur tuile
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }

      setMatchView(v);
      _matchRowsExpanded = false;

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

  // KPI PrÃ©visions cliquables => sÃ©lection + bascule mode PrÃ©visions
  // DÃ©lÃ©gation en capture : le clic sur un mini-KPI ne retombe jamais sur le clic gÃ©nÃ©rique de la tuile.
  const tilePrevisions = byId("tilePrevisions");
  if (tilePrevisions) {
    function openPrevKpiFromEvent(ev) {
      const target = ev?.target;
      const el = target?.closest?.(".mini-kpi[data-prev-kpi]");
      if (!el || !tilePrevisions.contains(el)) return false;

      const rawKey = (el.getAttribute("data-prev-kpi") || "").trim();
      const key = window.analysePrevisionValidKpi(rawKey);
      if (!key) return false;

      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      }

      localStorage.setItem("sb_analyse_prev_kpi", key);
      setActivePrevKpi(key);
      setMode("previsions");
      return true;
    }

    tilePrevisions.addEventListener("click", (ev) => {
      openPrevKpiFromEvent(ev);
    }, true);

    tilePrevisions.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      openPrevKpiFromEvent(ev);
    }, true);
  }

  // Filtres service / criticitÃ© / reset
  const critSlider = byId("analyseCriticiteMinRange");
  const critValue = byId("analyseCriticiteMinValue");

  if (critSlider) {
    critSlider.addEventListener("input", () => {
      const n = Math.max(0, Math.min(100, Number(critSlider.value || CRITICITE_MIN_DEFAULT)));
      if (critValue) critValue.textContent = String(n);
    });

    critSlider.addEventListener("change", async () => {
      setCriticiteMinValue(critSlider.value, true);
      setPostesScopeExpanded(false);
      invalidateAnalyseCaches();
      await refreshSummary(portal);
      renderDetail(localStorage.getItem(STORE_MODE) || "risques");
    });
  }

  if (selService) {
    selService.addEventListener("change", async () => {
      setPostesScopeExpanded(false);
      await refreshSummary(portal);
      renderDetail(localStorage.getItem(STORE_MODE) || "risques");
    });
  }

  async function applyAnalyseFilters() {
    setPostesScopeExpanded(false);
    invalidateAnalyseCaches();
    await refreshSummary(portal);
    renderDetail(localStorage.getItem(STORE_MODE) || "risques");
  }

  if (btnReset) {
    btnReset.addEventListener("click", async () => {
      setAnalyseServiceRawValue(window.portal.serviceFilter.ALL_ID || "");
      setCriticiteMinValue(CRITICITE_MIN_DEFAULT, true);
      setRiskFilter("");
      await applyAnalyseFilters();
    });
  }

  if (btnApply) {
    btnApply.addEventListener("click", async () => {
      await applyAnalyseFilters();
    });
  }

  // ==============================
  // Modal Poste (Risques) - wiring
  // ==============================
  const modalPoste = byId("modalAnalysePoste");
  const btnXPoste = byId("btnCloseAnalysePosteModal");
  const btnClosePoste = byId("btnAnalysePosteModalClose");


  if (btnXPoste) btnXPoste.addEventListener("click", closeAnalysePosteModal);
  if (btnClosePoste) btnClosePoste.addEventListener("click", closeAnalysePosteModal);

  if (modalPoste) {
    modalPoste.addEventListener("click", async (e) => {
      const matchBtn = e.target.closest("button[data-poste-cause-match-effectif]");
      if (matchBtn) {
        e.preventDefault();
        e.stopPropagation();
        const p = _portalref;
        const idEffectif = (matchBtn.getAttribute("data-poste-cause-match-effectif") || "").trim();
        const idPoste = (matchBtn.getAttribute("data-poste-cause-match-poste") || "").trim();
        const idServiceAttr = (matchBtn.getAttribute("data-poste-cause-match-service") || "").trim();
        const idService = idServiceAttr || window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
        if (p && idPoste && idEffectif) {
          showMatchPersonDetailModal(p, idPoste, idEffectif, idService);
        }
        return;
      }
      if (e.target === modalPoste) closeAnalysePosteModal();
    });
  }

  // ==============================
  // Tooltip "i" (Analyse) : portail hors table (#sbTipPortal)
  // ==============================
  let _sbTipAnchor = null;

  function ensureSbTipPortal() {
    let el = document.getElementById("sbTipPortal");
    if (el) return el;
    el = document.createElement("div");
    el.id = "sbTipPortal";
    document.body.appendChild(el);
    return el;
  }
  function sbTipHtml(key) {
    if (key === "fragility-index") {
      return `
        <div class="sb-tip-title">Indice de fragilitÃ©</div>
        <div class="sb-tip-text">
          Cet indice mesure le niveau dâ€™exposition dâ€™un poste. Plus il se rapproche de 100 %, plus le poste nÃ©cessite une attention rapide.
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Ce qui est pris en compte</div>
          <ul class="sb-tip-list">
            <li>le nombre de personnes rattachÃ©es au poste par rapport au besoin attendu ;</li>
            <li>la couverture des compÃ©tences nÃ©cessaires au poste ;</li>
            <li>le niveau rÃ©ellement maÃ®trisÃ© par les personnes disponibles ;</li>
            <li>la dÃ©pendance Ã  une seule personne ou lâ€™absence de relais interne ;</li>
            <li>les compÃ©tences attendues mais non confirmÃ©es ou insuffisamment couvertes.</li>
          </ul>
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Lecture de lâ€™Ã©tat</div>
          <div class="sb-tip-scale"><b>0 Ã  24 %</b> : faible</div>
          <div class="sb-tip-scale"><b>25 Ã  49 %</b> : modÃ©rÃ©</div>
          <div class="sb-tip-scale"><b>50 Ã  74 %</b> : Ã©levÃ©</div>
          <div class="sb-tip-scale"><b>75 Ã  100 %</b> : critique</div>
        </div>

        <div class="sb-tip-note">
          Un poste actif sans titulaire est considÃ©rÃ© comme fragile Ã  100 %, car aucune personne ne le couvre dans lâ€™organisation actuelle.
        </div>
      `;
    }

    if (key === "fragility-index-competence") {
      return `
        <div class="sb-tip-title">Indice de fragilitÃ©</div>
        <div class="sb-tip-text">
          Cet indice indique dans quelle mesure une compÃ©tence est sÃ©curisÃ©e dans lâ€™entreprise. Il ne mesure pas seulement si la compÃ©tence existe quelque part : il regarde si elle est assez maÃ®trisÃ©e, assez diffusÃ©e et transmissible.
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Ce qui est pris en compte</div>
          <ul class="sb-tip-list">
            <li>la maÃ®trise rÃ©elle de la compÃ©tence par les collaborateurs disponibles ;</li>
            <li>le nombre de personnes capables de porter cette compÃ©tence au niveau attendu ;</li>
            <li>la concentration de la compÃ©tence sur une ou quelques personnes ;</li>
            <li>la prÃ©sence ou non de collaborateurs experts capables de transmettre le savoir-faire ;</li>
            <li>les indisponibilitÃ©s, fins de contrat ou sorties prÃ©vues qui peuvent retirer des porteurs ;</li>
            <li>la fiabilitÃ© des donnÃ©es disponibles : niveaux confirmÃ©s, Ã©valuations, informations manquantes.</li>
          </ul>
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Lecture de lâ€™Ã©tat</div>
          <div class="sb-tip-scale"><b>0 Ã  24 %</b> : faible</div>
          <div class="sb-tip-scale"><b>25 Ã  49 %</b> : modÃ©rÃ©</div>
          <div class="sb-tip-scale"><b>50 Ã  74 %</b> : Ã©levÃ©</div>
          <div class="sb-tip-scale"><b>75 Ã  100 %</b> : critique</div>
        </div>

        <div class="sb-tip-note">
          Une compÃ©tence peut Ãªtre fragile mÃªme si elle est prÃ©sente dans lâ€™entreprise, par exemple si elle repose sur une seule personne ou si personne nâ€™est capable de la transmettre.
        </div>
      `;
    }
    if (key === "prevision-transmission-expertise") {
      return `
        <div class="sb-tip-title">Transmission</div>
        <div class="sb-tip-text">
          Cet indicateur signale si une personne est en capacitÃ© de transmettre la compÃ©tence : niveau Expert ou AvancÃ© haut, avec prise en compte de la fraÃ®cheur de la derniÃ¨re Ã©valuation.
        </div>
        <div class="sb-tip-block">
          <div class="sb-tip-scale"><b style="color:#16a34a;">Point vert</b> : niveau Expert avec Ã©valuation rÃ©cente.</div>
          <div class="sb-tip-scale"><b style="color:#2563eb;">Point bleu</b> : niveau AvancÃ© haut avec Ã©valuation rÃ©cente.</div>
          <div class="sb-tip-scale"><b style="color:#db2777;">Point rose</b> : entretien recommandÃ©, Ã©valuation absente ou trop ancienne.</div>
          <div class="sb-tip-scale"><b style="color:#dc2626;">Point rouge</b> : aucune personne identifiÃ©e.</div>
        </div>
      `;
    }

    return `<div class="sb-tip-title">Info</div><div class="sb-tip-text">Aucune aide dÃ©finie.</div>`;
  }




  function hideSbTipPortal() {
    const el = document.getElementById("sbTipPortal");
    if (!el) return;
    el.style.display = "none";
    _sbTipAnchor = null;
  }

  function positionSbTipPortal(el, anchorEl) {
    const pad = 12;
    const gap = 8;
    const r = anchorEl.getBoundingClientRect();

    // mesurer sans flash
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.visibility = "hidden";
    el.style.display = "block";

    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 160;

    // position par dÃ©faut: sous le bouton
    let left = r.left;
    let top = r.bottom + gap;

    // clamp horizontal
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));

    // si Ã§a dÃ©borde en bas, on ouvre au-dessus
    if (top + h > window.innerHeight - pad) {
      top = r.top - h - gap;
    }
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "visible";
  }

  function toggleSbTip(anchorEl) {
    const el = ensureSbTipPortal();

    // toggle si on reclique le mÃªme "i"
    if (_sbTipAnchor === anchorEl && el.style.display === "block") {
      hideSbTipPortal();
      return;
    }

    const key = (anchorEl.getAttribute("data-sbtip") || "").trim();
    el.innerHTML = sbTipHtml(key);

    _sbTipAnchor = anchorEl;
    positionSbTipPortal(el, anchorEl);
  }

  // fermeture: clic dehors / scroll / resize / ESC
  document.addEventListener("pointerdown", (ev) => {
    const el = document.getElementById("sbTipPortal");
    if (!el || el.style.display !== "block") return;

    const t = ev.target;
    if (t === el || el.contains(t)) return;
    if (_sbTipAnchor && (t === _sbTipAnchor || _sbTipAnchor.contains(t))) return;

    hideSbTipPortal();
  }, true);

  window.addEventListener("scroll", hideSbTipPortal, true);
  window.addEventListener("resize", hideSbTipPortal);

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideSbTipPortal();
  });

  // ==============================
  // Click dÃ©lÃ©guÃ© global (survit aux rerender)
  // ==============================
  const analyseBody = byId("analyseDetailBody");
  if (!analyseBody) {
    // si la vue nâ€™est pas encore montÃ©e, on ne fige pas le bind
    _bound = false;
    return;
  }

  analyseBody.addEventListener("click", async (ev) => {
    // ------------------------------
    // Tooltip "i" (Indice de fragilitÃ©) : portail hors table
    // ------------------------------
    const infoBtn = ev.target.closest(".sb-iinfo");
    if (infoBtn) {
      ev.preventDefault();
      ev.stopPropagation();

      // sÃ©curitÃ©: si l'attribut n'existe pas encore, on le force
      if (!infoBtn.getAttribute("data-sbtip")) {
        infoBtn.setAttribute("data-sbtip", "fragility-index");
      }

      toggleSbTip(infoBtn);
      return;
    }

    // 0) pas de portail => pas de drilldown
    const p = portal || _portalref;
    if (!p) return;

    const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");


    // ------------------------------
    // PDF poste fragile
    // ------------------------------
    const btnPostePdf = ev.target.closest("[data-risk-poste-pdf]");
    if (btnPostePdf) {
      ev.preventDefault();
      ev.stopPropagation();
      const idPoste = (btnPostePdf.getAttribute("data-risk-poste-pdf") || "").trim();
      if (idPoste) openAnalysePosteAnalysisPdf(idPoste);
      return;
    }

    // ------------------------------
    // 1) Click sur POSTE FRAGILE (table risques)
    // -> ouverture uniquement si clic sur libellÃ© poste OU bouton Voir
    // ------------------------------
    const trPoste = ev.target.closest("tr.risk-poste-row[data-id_poste]");
    if (trPoste) {
      // On Ã©vite dâ€™ouvrir le modal sur nâ€™importe quel clic dans la ligne
      const hit = ev.target.closest(".risk-poste-open");
      if (!hit) return;

      const id_poste = (trPoste.getAttribute("data-id_poste") || "").trim();
      if (!id_poste) return;

      try {
        await showAnalysePosteDetailModal(p, id_poste, id_service, "");
      } catch (e) {
        // on laisse tes modals gÃ©rer leurs erreurs
      }
      return;
    }


    // ------------------------------
    // PDF fiche compÃ©tence depuis le dÃ©tail poste
    // ------------------------------
    const btnPosteDepCompPdf = ev.target.closest("[data-poste-dep-comp-pdf]");
    if (btnPosteDepCompPdf) {
      ev.preventDefault();
      ev.stopPropagation();
      const compKey = (btnPosteDepCompPdf.getAttribute("data-poste-dep-comp-pdf") || "").trim();
      if (compKey) openAnalyseCompetenceFichePdf(compKey);
      return;
    }

    // ------------------------------
    // PDF analyse compÃ©tence fragile
    // ------------------------------
    const btnCompPdf = ev.target.closest("[data-risk-comp-pdf]");
    if (btnCompPdf) {
      ev.preventDefault();
      ev.stopPropagation();
      const compKey = (btnCompPdf.getAttribute("data-risk-comp-pdf") || "").trim();
      if (compKey) openAnalyseCompetenceAnalysisPdf(compKey);
      return;
    }

    // ------------------------------
    // 2) Click sur COMPETENCE (table risques)
    // ------------------------------
    const trComp = ev.target.closest("tr.risk-comp-row[data-comp-key]");
    if (trComp) {
      // Comme postes fragiles: on nâ€™ouvre pas sur nâ€™importe quel clic dans la ligne
      const hit = ev.target.closest(".risk-comp-open");
      if (!hit) return;

      const compKey = (trComp.getAttribute("data-comp-key") || "").trim();
      if (!compKey) return;

      try {
        await showAnalyseCompetenceDetailModal(p, compKey, id_service);
      } catch (e) {
        if (typeof showToast === "function") showToast("Erreur ouverture dÃ©tail compÃ©tence.", "error");
        else console.error(e);
      }
      return;
    }


    // ------------------------------
    // 3) Toggle "Postes fragiles" / "Tous les postes"
    // ------------------------------
    const btnMatchMode = ev.target.closest("button[data-match-poste-mode]");
    if (btnMatchMode) {
      const mode = (btnMatchMode.getAttribute("data-match-poste-mode") || "").trim().toLowerCase();
      if (!mode) return;

      // Si lâ€™utilisateur reclique sur lâ€™actif, on ne refait pas du bruit.
      if (mode === getMatchPosteMode()) return;

      setMatchPosteMode(mode);
      _matchRowsExpanded = false;

      // on reset la sÃ©lection poste pour repartir propre
      _matchSelectedPoste = "";
      _matchCurrentPosteId = "";
      _matchCurrentPoste = null;
      _matchCurrentItems = [];
      _matchCurrentRowsCount = 0;

      // rerender + reload via le pipeline standard
      renderDetail("matching");
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
      _matchRowsExpanded = false;
      refreshMatchingPrintButtonState();

      // met Ã  jour le style actif sans rerender complet
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
    // 4) Actions sur PERSONNE (table matching droite)
    // ------------------------------
    const btnMatchPersonPdf = ev.target.closest("[data-match-person-pdf]");
    if (btnMatchPersonPdf) {
      ev.preventDefault();
      ev.stopPropagation();
      const id_effectif = (btnMatchPersonPdf.getAttribute("data-match-person-pdf") || "").trim();
      if (!id_effectif || !_matchSelectedPoste) return;
      try {
        await openAnalyseMatchingEffectifPdfInBrowser(p, _matchSelectedPoste, id_effectif, id_service);
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Impossible dâ€™ouvrir le PDF.", "error");
        else alert(e.message || "Impossible dâ€™ouvrir le PDF.");
      }
      return;
    }

    const btnMatchPersonOpen = ev.target.closest("[data-match-person-open], .match-person-open");
    if (btnMatchPersonOpen) {
      ev.preventDefault();
      ev.stopPropagation();
      const id_effectif = (btnMatchPersonOpen.getAttribute("data-match-person-open") || btnMatchPersonOpen.closest("tr.match-person-row[data-match-id_effectif]")?.getAttribute("data-match-id_effectif") || "").trim();
      if (!id_effectif || !_matchSelectedPoste) return;
      showMatchPersonDetailModal(p, _matchSelectedPoste, id_effectif, id_service);
      return;
    }

    const trPerson = ev.target.closest("tr.match-person-row[data-match-id_effectif]");
    if (trPerson) {
      return;
    }
  });
}

  function ensureRiskEvol3mModal() {
    let modal = byId("modalRiskEvol3m");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalRiskEvol3m" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div style="font-weight: var(--ns-weight-semibold);" id="riskEvol3mModalTitle">Ã‰volution</div>
            <button type="button" class="modal-x" id="btnCloseRiskEvol3mModal" aria-label="Fermer">Ã—</button>
          </div>

          <div class="modal-body" id="riskEvol3mModalBody">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Chargementâ€¦</div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--soft" id="btnRiskEvol3mModalClose">Fermer</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalRiskEvol3m");

    if (modal && modal.getAttribute("data-bound") !== "1") {
      modal.setAttribute("data-bound", "1");

      const btnX = byId("btnCloseRiskEvol3mModal");
      const btnClose = byId("btnRiskEvol3mModalClose");

      if (btnX) btnX.addEventListener("click", () => closeRiskEvol3mModal());
      if (btnClose) btnClose.addEventListener("click", () => closeRiskEvol3mModal());

      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) closeRiskEvol3mModal();
      });

      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeRiskEvol3mModal();
      });
    }

    return modal;
  }
  async function fetchRiskProjectionEvents3m(portal, id_service, criticite_min) {
    const svc = (id_service || "").trim();
    const crit = Number.isFinite(Number(criticite_min))
      ? Math.max(0, Math.min(100, Number(criticite_min)))
      : getCriticiteMinSafe(CRITICITE_MIN_DEFAULT);
    const key = `projection-events-3m|${svc}|${crit}`;
    if (_riskEvol3mCache.has(key)) return _riskEvol3mCache.get(key);
    if (!portal?.apiBase || !portal?.contactId) throw new Error("Contexte portail indisponible.");

    const qs = buildQueryString({ id_service: svc || null, criticite_min: crit });
    const url = `${portal.apiBase}/skills/analyse/risques/projection-events/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);
    _riskEvol3mCache.set(key, data);
    return data;
  }


  function openRiskEvol3mModal(kind, items, meta) {
    const modal = ensureRiskEvol3mModal();
    const titleEl = byId("riskEvol3mModalTitle");
    const bodyEl = byId("riskEvol3mModalBody");
    if (!modal || !bodyEl) return;

    const scope = (meta?.scopeLabel || "").trim();
    const scopeHtml = scope ? ` <span class="sb-badge">${escapeHtml(scope)}</span>` : "";

    const isPostes = (kind === "postes");
    const titleTxt = isPostes
      ? `Postes en Ã©volution (3 mois)${scopeHtml}`
      : `CompÃ©tences en Ã©volution (3 mois)${scopeHtml}`;

    if (titleEl) titleEl.innerHTML = titleTxt;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      bodyEl.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-sub" style="margin:0;">Aucune Ã©volution dÃ©tectÃ©e.</div>
        </div>
      `;
    } else {
      const deltaBadge = (d) => {
        const n = Number(d) || 0;
        const cls = n > 0 ? "sb-badge sb-badge--danger"
                  : n < 0 ? "sb-badge sb-badge--success"
                  : "sb-badge sb-badge--warning";
        const s = Math.round(n);
        const txt = `${s > 0 ? "+" : ""}${s}%`;
        return `<span class="${cls}">${escapeHtml(txt)}</span>`;
      };

        if (isPostes) {
          const causeTxt = (delta) => {
            const d = Number(delta) || 0;
            if (d > 0) return "Cause: indisponibilitÃ© prÃ©vue dâ€™ici 3 mois";
            if (d < 0) return "Cause: fin dâ€™indisponibilitÃ© dâ€™ici 3 mois";
            return "Cause: stabilitÃ©";
          };

          bodyEl.innerHTML = `
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">DÃ©tail</div>

              <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                ${list.map(r => `
                  <div class="sb-evol-card"
                      data-evol-id="${escapeHtml(String(r.id || ""))}"
                      style="display:flex; align-items:center; justify-content:space-between; gap:12px;
                              padding:10px 12px; border:1px solid var(--sb-gray-200); border-radius:12px;
                              cursor:pointer;">
                    <div style="min-width:0;">
                      <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                        <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(r.code || "â€”")}</span>
                        <span style="font-weight: var(--ns-weight-semibold); font-size: var(--ns-text-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(r.label || "â€”")}
                        </span>
                      </div>

                      <div class="sb-fs-13"
                          style="opacity:.85; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(r.service || "â€”")} â€¢ ${escapeHtml(causeTxt(r.delta))}
                      </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s0 || 0))))}%</span>
                      <span style="opacity:.6;">â†’</span>
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s3 || 0))))}%</span>
                      ${deltaBadge(r.delta)}
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          `;

          // Clic => ouvrir le modal "poste fragile" (Ã©tat actuel)
          bodyEl.querySelectorAll(".sb-evol-card[data-evol-id]").forEach((el) => {
            el.addEventListener("click", () => {
              const id = (el.getAttribute("data-evol-id") || "").trim();
              if (!id || !_portalref) return;

              const id_service = getFilters()?.id_service || "";
              closeRiskEvol3mModal();
              showAnalysePosteDetailModal(_portalref, id, id_service, "");
            });
          });

        } else {
          const causeTxt = (delta) => {
            const d = Number(delta) || 0;
            if (d > 0) return "Cause: indisponibilitÃ© prÃ©vue dâ€™ici 3 mois";
            if (d < 0) return "Cause: fin dâ€™indisponibilitÃ© dâ€™ici 3 mois";
            return "Cause: stabilitÃ©";
          };

          bodyEl.innerHTML = `
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">DÃ©tail</div>

              <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                ${list.map(r => `
                  <div class="sb-evol-comp-card"
                      data-evol-id="${escapeHtml(String(r.id || ""))}"
                      data-evol-code="${escapeHtml(String(r.code || ""))}"
                      data-evol-text="${escapeHtml(String(r.label || ""))}"
                      style="display:flex; align-items:center; justify-content:space-between; gap:12px;
                              padding:10px 12px; border:1px solid var(--sb-gray-200); border-radius:12px;
                              cursor:pointer;">
                    <div style="min-width:0;">
                      <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                        <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(r.code || "â€”")}</span>
                        <span style="font-weight: var(--ns-weight-semibold); font-size: var(--ns-text-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(r.label || "â€”")}
                        </span>
                      </div>

                      <div class="sb-fs-13"
                          style="opacity:.85; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(causeTxt(r.delta))}
                      </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s0 || 0))))}%</span>
                      <span style="opacity:.6;">â†’</span>
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s3 || 0))))}%</span>
                      ${deltaBadge(r.delta)}
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          `;

          // Clic => ouvrir le modal "compÃ©tence critique" (Ã©tat actuel)
          bodyEl.querySelectorAll(".sb-evol-comp-card[data-evol-id]").forEach((el) => {
            el.addEventListener("click", () => {
              const id = (el.getAttribute("data-evol-id") || "").trim();
              const code = (el.getAttribute("data-evol-code") || "").trim();
              const text = (el.getAttribute("data-evol-text") || "").trim();
              if (!id || !_portalref) return;

              const id_service = getFilters()?.id_service || "";
              closeRiskEvol3mModal();

              // ouvre le dÃ©tail compÃ©tence (actuel)
              showAnalyseCompetenceDetailModal(_portalref, id, id_service, { code, text });
            });
          });
        }
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function openRiskProjectionMonthModal(month) {
    const modal = ensureRiskEvol3mModal();
    const titleEl = byId("riskEvol3mModalTitle");
    const bodyEl = byId("riskEvol3mModalBody");
    if (!modal || !bodyEl) return;

    const label = (month?.label || "Projection").toString();
    if (titleEl) titleEl.innerHTML = `DÃ©tail projection <span class="sb-badge">${escapeHtml(label)}</span>`;

    const indispos = Array.isArray(month?.indisponibilites) ? month.indisponibilites : [];
    const sorties = Array.isArray(month?.sorties) ? month.sorties : [];

    const fmtList = (items, type) => {
      if (!items.length) return `<div class="card-sub" style="margin:0;">Aucun Ã©vÃ©nement identifiÃ©.</div>`;
      return `
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${items.map(r => {
            const person = r.personne || "Collaborateur";
            const poste = r.poste || "Poste non renseignÃ©";
            const dates = type === "indispo"
              ? `${r.date_debut || "â€”"} â†’ ${r.date_fin || "â€”"}`
              : `${r.date_sortie || "â€”"}`;
            const motif = type === "sortie" ? `<div class="card-sub" style="margin-top:2px;">${escapeHtml(r.motif || "Sortie prÃ©vue")}</div>` : "";
            return `
              <div style="border:1px solid var(--sb-gray-200); border-radius:12px; padding:10px 12px; background:#fff;">
                <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                  <div style="min-width:0;">
                    <div style="font-weight: var(--ns-weight-bold); font-size: var(--ns-text-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(person)}</div>
                    <div class="card-sub" style="margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(poste)}</div>
                    ${motif}
                  </div>
                  <span class="sb-badge" style="flex:0 0 auto;">${escapeHtml(dates)}</span>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `;
    };

    bodyEl.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:start;">
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:8px;">IndisponibilitÃ©s temporaires</div>
          ${fmtList(indispos, "indispo")}
        </div>
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:8px;">Fins de contrat / sorties prÃ©vues</div>
          ${fmtList(sorties, "sortie")}
        </div>
      </div>
    `;

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeRiskEvol3mModal() {
    const modal = byId("modalRiskEvol3m");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  window.SkillsAnalyse = {
    onShow: async (portal) => {
      try {
        _portalref = portal;

        bindOnce(portal);

        if (!_servicesLoaded) {
          await loadServices(portal);
        }

        const storedService = (localStorage.getItem(STORE_SERVICE) || "").trim();
        setAnalyseServiceRawValue(storedService);
        initCriticiteMinFromStorage();

        await refreshSummary(portal);

        const storedMode = (localStorage.getItem(STORE_MODE) || "risques").trim();
        setMode(storedMode);

        if (storedMode === "risques") {
          const rf = getRiskFilter();
          setActiveRiskKpi(rf);
        }


      } catch (e) {
        portal.showAlert("error", "Erreur analyse : " + (e.message || "inconnue"));
        console.error(e);
      }
    }
  };
})();

