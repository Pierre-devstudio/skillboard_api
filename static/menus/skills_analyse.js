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
  const STORE_SIM_ANALYSE_HYPOTHESES = "sb_simulations_rh_hypotheses_from_analyse_v1";
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
    if (!raw || raw === "—") return "";
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
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[k]) || ((value ?? "").toString().trim() || "—");
  }

  function nsLevelRank(value) {
    if (window.NovoskillLevels) return window.NovoskillLevels.rank(value);
    return ({ A: 1, B: 2, C: 3, D: 4 }[nsLevelCode(value)]) || 0;
  }

  function nsLevelBadgeHtml(value, title) {
    if (window.NovoskillLevels) return window.NovoskillLevels.badgeHtml(value, title || "Niveau de maîtrise");
    const k = nsLevelCode(value);
    const cls = ({ A: "sb-badge-niv-a", B: "sb-badge-niv-b", C: "sb-badge-niv-c", D: "sb-badge-niv-d" }[k]) || "";
    return `<span class="sb-badge sb-badge-niv ${cls}" title="${escapeHtml(title || "Niveau de maîtrise")}">${escapeHtml(nsLevelLabel(value))}</span>`;
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


  // ======================================================
  // Aides utilisateur + hypothèses de simulation préparées
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
            <div class="modal-title" id="analyseHelpModalTitle">Comprendre l’analyse</div>
            <button type="button" class="modal-x" id="btnCloseAnalyseHelpModal" aria-label="Fermer">×</button>
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
    if (t) t.textContent = title || "Comprendre l’analyse";
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
    if (!Number.isFinite(n)) return "—";
    const nn = Math.max(0, Math.round(n));
    return `${nn} ${nn > 1 ? plural : singular}`;
  }

  function analyseHorizonLabel(years) {
    const h = Math.max(1, Math.round(Number(years || getPrevHorizon() || 1)));
    return `N+${h}`;
  }
  function analyseRiskLevelLabel(value, count) {
    const v = Number(value || 0);
    const c = Number(count || 0);
    if (v >= 80 || c >= 8) return "Risque critique";
    if (v >= 65 || c >= 5) return "Risque élevé";
    if (v >= 35 || c > 0) return "Risque modéré";
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
  function buildAnalyseRiskEffects(data) {
    const t = data?.tiles || {};
    const r = t.risques || {};
    const p = t.previsions || {};
    const horizon = getPrevHorizon();
    const item = pickPrevHorizonItem(p, horizon) || null;
    const count = (value, singular, plural) => fmtAnalyseCount(Number(value || 0), singular, plural);

    const posteFrag = Number(r.postes_fragilite_globale || 0);
    const compFrag = Number(r.comp_fragilite_moyenne || 0);
    const postesFragiles = Number(r.postes_fragiles || 0);
    const sansPorteur = Number(r.comp_critiques_sans_porteur || 0);
    const porteurUnique = Number(r.comp_bus_factor_1 || 0);
    const sansRenfort = Number(r.comp_critiques_tombent_zero_auj || 0);
    const compFragiles = Number(r.comp_critiques_fragiles || 0);
    const sorties = Number(item?.sorties || 0);
    const compImpactHausse = Number(item?.comp_critiques_impactees || 0);
    const postesRouges = Number(item?.postes_rouges || 0);

    const effects = [];

    if (postesFragiles > 0 || sansPorteur > 0 || sansRenfort > 0 || porteurUnique > 0) {
      const riskScore = Math.max(posteFrag, compFrag);
      const riskCount = postesFragiles + sansPorteur + sansRenfort + porteurUnique;
      effects.push({
        key: "rupture_activite",
        title: "Risque de rupture ou ralentissement d’activité",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: count(postesFragiles, "poste fragile", "postes fragiles"),
        causesTitle: "Causes probables identifiées",
        causes: compactCauseList([
          sansPorteur > 0 ? `${count(sansPorteur, "compétence critique sans couverture suffisante", "compétences critiques sans couverture suffisante")}` : "couverture critique à vérifier",
          sansRenfort > 0 ? `${count(sansRenfort, "point sans renfort immédiat", "points sans renfort immédiat")}` : "renfort immédiat à vérifier sur les postes sensibles",
          postesFragiles > 0 ? `${count(postesFragiles, "poste déjà fragilisé", "postes déjà fragilisés")}` : "postes sensibles à relire dans le détail",
          porteurUnique > 0 ? `${count(porteurUnique, "compétence dépend d’une seule personne", "compétences dépendent d’une seule personne")}` : "dépendance individuelle à surveiller"
        ])
      });
    }

    if (compFrag > 0 || compFragiles > 0 || sansPorteur > 0) {
      const riskScore = compFrag;
      const riskCount = compFragiles + sansPorteur;
      effects.push({
        key: "qualite_execution",
        title: "Risque de baisse de qualité d’exécution",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: `${Math.round(compFrag)}% de fragilité moyenne des compétences`,
        causesTitle: "Causes probables identifiées",
        causes: compactCauseList([
          compFragiles > 0 ? `${count(compFragiles, "compétence critique avec maîtrise fragile", "compétences critiques avec maîtrise fragile")}` : "écarts de maîtrise à vérifier",
          "niveaux attendus insuffisamment couverts",
          "évaluations ou confirmations à reprendre",
          sansPorteur > 0 ? `${count(sansPorteur, "compétence sans couverture suffisante", "compétences sans couverture suffisante")}` : "expertise réelle à confirmer sur les situations sensibles"
        ])
      });
    }

    if (porteurUnique > 0) {
      const riskScore = Math.max(posteFrag, compFrag);
      const riskCount = porteurUnique;
      effects.push({
        key: "dependance_individuelle",
        title: "Risque de dépendance individuelle",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: count(porteurUnique, "compétence dépendante d’une seule personne", "compétences dépendantes d’une seule personne"),
        causesTitle: "Causes probables identifiées",
        causes: compactCauseList([
          `${count(porteurUnique, "compétence portée par une seule personne", "compétences portées par une seule personne")}`,
          "vivier interne trop limité",
          "renfort immédiat insuffisant sur les postes concernés",
          "transmission à structurer sur les compétences clés"
        ])
      });
    }

    if (sorties > 0 || compImpactHausse > 0 || postesRouges > 0) {
      const riskScore = postesRouges + compImpactHausse;
      const riskCount = sorties + (postesRouges > 0 ? 1 : 0) + (compImpactHausse > 0 ? 1 : 0);
      effects.push({
        key: "perte_savoir_faire",
        title: "Risque de perte de savoir-faire",
        level: analyseRiskLevelLabel(riskScore, riskCount),
        riskScore,
        riskCount,
        metric: `${postesRouges > 0 ? `postes +${Math.round(postesRouges)}%` : "postes stables"} · ${compImpactHausse > 0 ? `compétences +${Math.round(compImpactHausse)}%` : "compétences stables"} à ${analyseHorizonLabel(horizon)}`,
        causesTitle: "Causes probables identifiées",
        causes: compactCauseList([
          sorties > 0 ? `${count(sorties, "sortie possible", "sorties possibles")} à ${analyseHorizonLabel(horizon)}` : "sorties à surveiller selon l’horizon choisi",
          compImpactHausse > 0 ? `+${Math.round(compImpactHausse)}% d’évolution de fragilité moyenne des compétences` : "expertise à surveiller dans la durée",
          postesRouges > 0 ? `+${Math.round(postesRouges)}% d’évolution de fragilité moyenne des postes` : "relève interne à confirmer",
          "transmission à organiser avant perte de couverture"
        ])
      });
    }

    return effects;
  }


  function updateAnalyseProjectionSummary(previsions) {
    const horizon = getPrevHorizon();
    const item = pickPrevHorizonItem(previsions || _prevData || {}, horizon) || null;
    const label = byId("analyseSynthProjectionLabel");
    if (label) label.textContent = `Projection ${analyseHorizonLabel(horizon)}`;
    const postes = Number(item?.postes_rouges ?? NaN);
    setText("analyseSynthProjection", Number.isFinite(postes) ? fmtAnalyseCount(postes, "poste fragilisé", "postes fragilisés") : "—");
  }

  function updateAnalyseHeaderSynthesis(data) {
    _analyseLastSummary = data || null;
    const r = data?.tiles?.risques || {};
    const postesAnalyses = Number(r.postes_analyses ?? r.nb_postes_analyses ?? NaN);
    const competencesAnalysees = Number(r.competences_analysees ?? r.nb_competences_analysees ?? NaN);
    const effects = buildAnalyseRiskEffects(data || {});
    _analyseLastSummaryEffects = effects;

    setText("analyseSynthPostesAnalyses", Number.isFinite(postesAnalyses) ? fmtAnalyseCount(postesAnalyses, "poste", "postes") : "—");
    setText("analyseSynthCompetencesAnalysees", Number.isFinite(competencesAnalysees) ? fmtAnalyseCount(competencesAnalysees, "compétence", "compétences") : "—");
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
            <div class="card-sub" style="margin:2px 0 0 0;">${escapeHtml(e.metric || "Point détecté")}</div>
          </div>
          <span class="analyse-risk-effect-level ${analyseRiskLevelClass(e.level)}">${escapeHtml(e.level || "Risque à qualifier")}</span>
        </div>
        <div class="analyse-risk-effect-causes-title">${escapeHtml(e.causesTitle || "Synthèse des causes identifiées")}</div>
        <ul class="analyse-risk-effect-causes">
          ${(e.causes || []).slice(0, 5).map(c => `<li>${escapeHtml(c)}</li>`).join("")}
        </ul>
        <div class="analyse-risk-effect-actions">
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-analyse-ishikawa="${escapeHtml(e.key)}">Générer l’Ishikawa</button>
        </div>
      </div>
    `).join("") : `
      <div class="analyse-risk-effect-card">
        <div class="analyse-risk-effect-title">Aucun effet terrain significatif détecté</div>
        <div class="analyse-risk-effect-body" style="margin-top:6px;">Les données du périmètre ne font pas ressortir de fragilité notable sur les indicateurs suivis.</div>
      </div>
    `;

    return `
      <div class="analyse-help-intro">
        <p>La synthèse regroupe les effets terrain détectés et leurs causes principales sur le périmètre <b>${escapeHtml(scope)}</b>.</p>
        <p class="card-sub" style="margin:6px 0 12px 0;">Périmètre lu : ${Number.isFinite(postes) ? fmtAnalyseCount(postes, "poste", "postes") : "postes à vérifier"} • ${Number.isFinite(comps) ? fmtAnalyseCount(comps, "compétence", "compétences") : "compétences à vérifier"}</p>
        <div class="analyse-risk-summary-actions">
          <button type="button" class="sb-btn sb-btn--init sb-btn--sm" data-analyse-risk-report="1">Générer le rapport</button>
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
      /* l’API retournera l’erreur utile */
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
      showAnalyseHelp(blockedTitle || "Ouverture bloquée", "<p>Le navigateur a bloqué l’ouverture du document. Autorise les fenêtres pour Novoskill ou réessaie.</p>");
      return;
    }
    try {
      win.document.write("<p style='font-family:Arial,sans-serif;padding:20px;'>Génération du document…</p>");
      const blob = await analyseApiBlob(url);
      const blobUrl = URL.createObjectURL(blob);
      win.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      try {
        win.document.body.innerHTML = `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;padding:20px;color:#991b1b;">Erreur génération document : ${escapeHtml(errMsg(e))}</pre>`;
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
    qs.set("horizon_years", String(getPrevHorizon()));

    const effects = Array.isArray(_analyseLastSummaryEffects) ? _analyseLastSummaryEffects : buildAnalyseRiskEffects(_analyseLastSummary || {});

    if (kind === "rapport") {
      effects.forEach(e => {
        const key = String(e?.key || "").trim();
        if (!key) return;
        if (e?.level) qs.set(`risk_level_${key}`, String(e.level));
        if (Number.isFinite(Number(e?.riskScore))) qs.set(`risk_score_${key}`, String(Math.round(Number(e.riskScore))));
        if (Number.isFinite(Number(e?.riskCount))) qs.set(`risk_count_${key}`, String(Math.round(Number(e.riskCount))));
      });
    } else if (effectKey) {
      const effect = effects.find(x => String(x?.key || "") === String(effectKey || ""));
      if (effect?.level) qs.set("risk_level", String(effect.level));
      if (Number.isFinite(Number(effect?.riskScore))) qs.set("risk_score", String(Math.round(Number(effect.riskScore))));
      if (Number.isFinite(Number(effect?.riskCount))) qs.set("risk_count", String(Math.round(Number(effect.riskCount))));
    }

    qs.set("_", String(Date.now()));
    const route = kind === "rapport" ? "rapport" : "ishikawa";
    return `${ctx.apiBase}/skills/analyse/${route}/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;
  }



  function openAnalyseIshikawaPdf(effectKey) {
    const url = buildAnalyseRiskDocumentUrl("ishikawa", effectKey || "rupture_activite");
    if (!url) {
      showAnalyseHelp("Ishikawa indisponible", "<p>Impossible de retrouver le contexte utilisateur pour générer le document.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Ishikawa bloqué");
  }

  function openAnalyseRiskReportPdf() {
    const url = buildAnalyseRiskDocumentUrl("rapport", "");
    if (!url) {
      showAnalyseHelp("Rapport indisponible", "<p>Impossible de retrouver le contexte utilisateur pour générer le document.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Rapport bloqué");
  }

  function analyseEyeIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }

  function analysePdfIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>`;
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
      showAnalyseHelp("PDF indisponible", "<p>Impossible de retrouver le poste à exporter.</p>");
      return;
    }
    openAnalysePdfBlob(url, "PDF poste bloqué");
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
      showAnalyseHelp("PDF indisponible", "<p>Impossible de retrouver la compétence à exporter.</p>");
      return;
    }
    openAnalysePdfBlob(url, "PDF compétence bloqué");
  }




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
      showAnalyseHelp("Impression indisponible", "<p>Impossible de retrouver la table à imprimer.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Impression bloquée");
  }


  function isPrintablePrevisionDetail(kpiKey) {
    const k = (kpiKey || "").toString().trim().toLowerCase();
    return k === "sorties" || k === "critiques" || k === "postes-rouges";
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
      showAnalyseHelp("Impression indisponible", "<p>Impossible de retrouver la table prévisionnelle à imprimer.</p>");
      return;
    }
    openAnalysePdfBlob(url, "Impression bloquée");
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
      <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" id="btnPrevisionDetailPrint">
        Imprimer
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
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte. Les pourcentages indiquent un niveau d’exposition du périmètre, pas une décision automatique.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi("Fragilité moyenne des postes", "Ce pourcentage mesure le niveau moyen d’exposition des postes affichés dans le périmètre sélectionné. Il prend en compte la couverture des compétences attendues sur les postes, les niveaux réellement disponibles, les écarts avec les niveaux attendus, les compétences qui reposent sur trop peu de personnes et les évaluations manquantes ou à confirmer. Plus le pourcentage est élevé, plus la continuité des postes doit être sécurisée.")}
        ${analyseHelpKpi("Fragilité moyenne des compétences", "Ce pourcentage mesure le niveau moyen d’exposition des compétences critiques du périmètre. Le calcul tient compte du nombre de collaborateurs capables de porter chaque compétence, de leur niveau de maîtrise, de la présence de relais internes, de la confirmation des évaluations et de la dépendance éventuelle à une seule personne.")}
        ${analyseHelpKpi("Prévision à 3 mois", "Cet indicateur affiche la plus forte dégradation de fragilité détectée dans les trois prochains mois, et pas seulement la situation exacte au dernier jour. Le calcul tient compte des indisponibilités temporaires, des fins de contrat, des départs ou retraites prévus lorsqu’une date de sortie est renseignée. Si un risque apparaît pendant quelques semaines puis disparaît avant la fin des trois mois, il est quand même pris en compte.")}
      </div>
      ${analyseHelpNote("À lire comme une aide à la priorisation : l’indicateur signale où regarder en premier, puis l’analyse détaillée permet de confirmer les actions à mener.")}
    `;
  }

  function buildMatchingHelpHtml() {
    return `
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte Correspondance profils / postes. Le calcul sert à repérer des pistes internes, pas à valider automatiquement une mobilité ou un remplacement.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi("Adéquation au poste", "Cet indicateur mesure le niveau de correspondance entre les compétences connues d’un collaborateur titulaire et les compétences attendues sur son poste. Le calcul compare les compétences détenues, leur niveau de maîtrise, les écarts avec le niveau attendu et les éléments qui restent à confirmer. Une adéquation élevée indique que le poste est bien couvert ; une adéquation faible signale des écarts, une couverture insuffisante ou des données encore trop fragiles.")}
        ${analyseHelpKpi("Top candidat", "Cet indicateur met en avant le profil interne le plus proche d’un poste, en dehors du titulaire quand c’est nécessaire. Le système recherche la meilleure correspondance disponible à partir des compétences et niveaux déjà connus. Il s’agit d’une piste de renfort, de mobilité, de remplacement ou de montée en compétence ; la disponibilité, l’envie et la validation managériale restent à confirmer.")}
      </div>
      ${analyseHelpNote("Une bonne correspondance n’est pas forcément une personne immédiatement opérationnelle à 100 %. Elle indique surtout le profil le plus proche à étudier.")}
    `;
  }

  function buildPrevisionsHelpHtml() {
    const horizon = analyseHorizonLabel(getPrevHorizon());
    return `
      ${analyseHelpIntro("Cette aide explique les indicateurs visibles dans la carte Prévisions. Ils servent à anticiper les fragilités qui peuvent apparaître si le périmètre évolue.")}
      <div class="analyse-help-kpi-list">
        ${analyseHelpKpi(`Sorties ${horizon}`, "Ce chiffre indique le nombre de collaborateurs susceptibles de sortir du périmètre sur la période N+X choisie. Le calcul s’appuie sur les informations connues dans Novoskill : départ prévu, retraite, mobilité, fin de présence, indisponibilité ou autre donnée prévisionnelle renseignée.")}
        ${analyseHelpKpi("Évolution fragilité compétences", "Cet indicateur affiche l’évolution moyenne de fragilité ramenée à toutes les compétences analysées du périmètre. Le calcul repart de la fragilité actuelle puis rejoue le même moteur en retirant les sortants identifiés sur la période N+X.")}
        ${analyseHelpKpi("Évolution fragilité postes", "Cet indicateur affiche l’évolution moyenne de fragilité ramenée à tous les postes analysés du périmètre. Le calcul repart de la fragilité actuelle puis rejoue le même moteur en retirant les sortants identifiés sur la période N+X.")}
        ${analyseHelpKpi("Horizon de projection", "Le curseur permet de changer la période observée. Plus la période est longue, plus l’analyse peut faire apparaître des fragilités futures. La lecture reste une anticipation : elle doit aider à préparer les actions avant que le risque devienne opérationnel.")}
      </div>
      ${analyseHelpNote("Cette carte sert à prendre de l’avance : transmission, relève interne, formation, recrutement ou réorganisation ciblée.")}
    `;
  }

  const ANALYSE_HELP = {
    summary: {
      title: "Synthèse des risques",
      html: ""
    },
    risques: {
      title: "Comprendre la carte Risques actuels",
      html: buildRisquesHelpHtml
    },
    risques_evol3m_table: {
      title: "Évolution des indices de fragilité à 3 mois",
      html: `
        <div class="analyse-help-kpi-list">
          <div class="analyse-help-kpi-block">
            <h4>Mois de projection</h4>
            <p>Chaque ligne présente la situation actuelle ou un mois de projection dans les trois prochains mois. La ligne marquée <b>pic retenu</b> correspond au mois où l’indice de fragilité atteint son niveau le plus haut sur la période.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Indice de fragilité</h4>
            <p>C’est le niveau de fragilité moyen projeté sur le périmètre affiché. Il tient compte des postes, des compétences attendues, des titulaires disponibles et des événements prévus sur la période.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Évolution</h4>
            <p>Cette valeur compare le mois affiché avec la situation d’aujourd’hui. Une hausse signale une dégradation du risque. Une baisse indique une amélioration. Un tiret sur la ligne d’aujourd’hui signifie qu’il n’y a pas encore d’évolution à mesurer.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Indisponibilités temporaires</h4>
            <p>Nombre de collaborateurs ayant une indisponibilité qui chevauche le mois concerné. Même une absence courte peut faire monter la fragilité si elle touche une personne seule sur un poste ou une compétence sensible.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Fins de contrat / sorties prévues</h4>
            <p>Nombre de collaborateurs avec une date de fin de contrat, de départ, de retraite ou de sortie prévue pendant le mois concerné. Ces personnes ne sont plus considérées comme disponibles pour couvrir le périmètre projeté.</p>
          </div>
          <div class="analyse-help-kpi-block">
            <h4>Détail</h4>
            <p>Le bouton œil ouvre la liste des collaborateurs concernés par les indisponibilités ou sorties prévues sur le mois sélectionné.</p>
          </div>
        </div>`
    },
    matching: {
      title: "Comprendre la carte Correspondance profils / postes",
      html: buildMatchingHelpHtml
    },
    previsions: {
      title: "Comprendre la carte Prévisions",
      html: buildPrevisionsHelpHtml
    }
  };

  const CAUSE_EFFECTS = {
    structure: {
      title: "Effet possible du risque structurel",
      text: "Le poste peut être insuffisamment tenu ou trop peu couvert. L’activité repose alors sur une base trop fragile, même si certaines compétences existent dans l’entreprise."
    },
    dependance: {
      title: "Effet possible de la dépendance",
      text: "La continuité repose sur trop peu de collaborateurs confirmés. Une absence, un départ ou une surcharge peut rapidement mettre le poste ou la compétence sous tension."
    },
    transmission: {
      title: "Effet possible d’un renfort potentiel insuffisant",
      text: "Le poste dispose de peu de profils internes capables d’aider rapidement. Les seuils utilisés distinguent les renforts immédiats et les renforts à préparer."
    },
    sorties: {
      title: "Effet possible d’une sortie approchante",
      text: "Un titulaire a une fin de contrat, une retraite ou une sortie prévue à court terme. Cela n’explique pas forcément la fragilité actuelle, mais peut l’aggraver rapidement."
    },
    efficacite: {
      title: "Effet possible d’un niveau attendu non atteint",
      text: "Le poste peut sembler couvert, mais la compétence n’est pas maîtrisée au niveau requis. Cela peut produire des erreurs, des délais ou une dépendance à un profil plus expérimenté."
    },
    comp_maitrise: {
      title: "Maîtrise insuffisante de la compétence",
      text: "Cette cause apparaît quand la compétence existe dans l’entreprise, mais pas suffisamment au niveau attendu sur les usages analysés. Elle aide à repérer les écarts entre le besoin réel et la maîtrise disponible."
    },
    comp_concentration: {
      title: "Concentration sur trop peu de personnes",
      text: "Cette cause indique que la compétence est détenue par un nombre trop limité de collaborateurs. Plus la compétence est concentrée, plus une absence ou un changement de poste peut fragiliser l’organisation."
    },
    comp_transmission: {
      title: "Capacité de transmission insuffisante",
      text: "Cette cause vérifie si la compétence peut être transmise. La lecture tient compte des collaborateurs au niveau Expert et des collaborateurs Avancés pouvant servir de base à une transmission organisée."
    },
    comp_evenements: {
      title: "Exposition à des sorties ou indisponibilités",
      text: "Cette cause signale les événements connus qui peuvent retirer temporairement ou durablement des collaborateurs associés à cette compétence : indisponibilité, fin de contrat, retraite ou sortie prévue."
    },
    comp_donnees: {
      title: "Données à vérifier",
      text: "Cette cause ne signale pas forcément un risque métier direct. Elle indique que certaines données doivent être confirmées pour fiabiliser la lecture de la compétence."
    },
    non_confirmee: {
      title: "Effet possible d’une compétence non confirmée",
      text: "La couverture repose sur une déclaration ou une donnée incomplète. L’analyse reste prudente tant que le niveau réel n’est pas confirmé par une évaluation exploitable."
    },
    indisponibilite: {
      title: "Effet possible d’une indisponibilité",
      text: "La couverture peut devenir insuffisante temporairement. Le risque porte surtout sur la continuité d’activité à court terme."
    },
    prevision: {
      title: "Effet possible à moyen terme",
      text: "La compétence ou le poste peut devenir fragile si la relève n’est pas préparée. Le risque est progressif, mais peut devenir bloquant si rien n’est consolidé."
    }
  };

  function causeHelpButton(key) {
    return `<span class="analyse-cause-help" data-cause-help="${escapeHtml(key || "structure")}" role="button" tabindex="0" aria-label="Comprendre l’effet de cette cause">?</span>`;
  }

  function bindAnalyseHelpDelegation() {
    document.addEventListener("click", (ev) => {
      const btnHelp = ev.target?.closest?.("[data-analyse-help]");
      if (btnHelp) {
        ev.preventDefault();
        ev.stopPropagation();
        const key = (btnHelp.getAttribute("data-analyse-help") || "").trim();
        if (key === "summary") {
          showAnalyseHelp("Synthèse des risques", analyseRiskSummaryHtml());
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

  function readAnalyseHypotheses() {
    try {
      const raw = localStorage.getItem(STORE_SIM_ANALYSE_HYPOTHESES);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  function writeAnalyseHypotheses(list) {
    localStorage.setItem(STORE_SIM_ANALYSE_HYPOTHESES, JSON.stringify(Array.isArray(list) ? list : []));
  }

  function openSimulationsRh() {
    try {
      if (_portalref && typeof _portalref.switchView === "function") {
        _portalref.switchView("simulations-rh");
        return;
      }
    } catch (_) {}
    window.location.hash = "#simulations-rh";
  }

  function addAnalyseHypothesis(payload, opts = {}) {
    const p = payload || {};
    const hyp = {
      id: `analyse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      source: "analyse_competences",
      source_label: p.source_label || "Analyse des compétences",
      type: p.type || "securisation",
      title: p.title || "Hypothèse de sécurisation",
      poste_id: p.poste_id || "",
      poste_label: p.poste_label || "",
      competence_id: p.competence_id || "",
      competence_code: p.competence_code || "",
      competence_label: p.competence_label || "",
      effectif_id: p.effectif_id || "",
      effectif_label: p.effectif_label || "",
      cause: p.cause || "Point de fragilité détecté",
      effet: p.effet || "Point à tester avant arbitrage RH.",
      horizon: p.horizon || "actuel",
      criticite: p.criticite || "",
      niveau_attendu: p.niveau_attendu || "",
      niveau_constate: p.niveau_constate || "",
      scope_label: getScopeLabel(),
      criticite_min: getCriticiteMinSafe(CRITICITE_MIN_DEFAULT)
    };

    const list = readAnalyseHypotheses();
    const dedupeKey = [hyp.type, hyp.poste_id, hyp.competence_id, hyp.effectif_id, hyp.horizon, hyp.cause].join("|");
    const filtered = list.filter(x => [x.type, x.poste_id, x.competence_id, x.effectif_id, x.horizon, x.cause].join("|") !== dedupeKey);
    filtered.unshift(hyp);
    writeAnalyseHypotheses(filtered.slice(0, 20));

    if (_portalref?.showAlert) _portalref.showAlert("success", "Hypothèse ajoutée aux Simulations RH.");
    if (opts.openSimulation !== false) openSimulationsRh();
    return hyp;
  }

  function securityPointsHtml(kind) {
    const mode = (kind || "poste").toString();
    if (mode === "competence") {
      return `
        <div class="analyse-secu-grid">
          <div class="analyse-secu-card"><strong>Confirmer la maîtrise réelle</strong><small>Vérifier les niveaux déclarés ou non évalués avant d’interpréter la couverture.</small></div>
          <div class="analyse-secu-card"><strong>Réduire la dépendance</strong><small>Identifier une couverture complémentaire si la compétence repose sur trop peu de personnes.</small></div>
          <div class="analyse-secu-card"><strong>Tester une relève</strong><small>Préparer une hypothèse dans les Simulations RH, sans décider depuis l’analyse.</small></div>
          <div class="analyse-secu-card"><strong>Maintenir la donnée à jour</strong><small>Après arbitrage externe, actualiser les niveaux, rattachements ou évaluations dans Novoskill.</small></div>
        </div>`;
    }
    return `
      <div class="analyse-secu-grid">
        <div class="analyse-secu-card"><strong>Consolider la couverture</strong><small>Identifier les compétences du poste qui fragilisent la continuité.</small></div>
        <div class="analyse-secu-card"><strong>Vérifier les niveaux attendus</strong><small>Contrôler les écarts entre le niveau requis et les niveaux confirmés.</small></div>
        <div class="analyse-secu-card"><strong>Préparer une hypothèse</strong><small>Envoyer le contexte vers Simulations RH pour tester une sécurisation.</small></div>
        <div class="analyse-secu-card"><strong>Actualiser après arbitrage</strong><small>Mettre à jour Novoskill après décision réelle pour garder l’analyse fiable.</small></div>
      </div>`;
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
    el.textContent = analyseHorizonLabel(n);
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
      setText("kpiPrevSorties12", item.sorties);
      setText("kpiPrevCompImpact", formatPrevisionImpactPercent(item.comp_critiques_impactees));
      setText("kpiPrevPostesRed", formatPrevisionImpactPercent(item.postes_rouges));
      updateAnalyseProjectionSummary(p);
      if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
      return;
    }

    // Fallback: comportement historique (12 mois)
    setText("kpiPrevSorties12", p.sorties_12m);
    setText("kpiPrevCompImpact", formatPrevisionImpactPercent(p.comp_critiques_impactees));
    setText("kpiPrevPostesRed", formatPrevisionImpactPercent(p.postes_rouges_12m));
    updateAnalyseProjectionSummary(p);
    if (_analyseLastSummary) updateAnalyseHeaderSynthesis(_analyseLastSummary);
  }

  async function loadServices(portal) {
    await portal.serviceFilter.populateSelect({
      portal,
      selectId: "analyseServiceSelect",
      storageKey: STORE_SERVICE,
      labelAll: "Tous les services",
      labelNonLie: "Non lié",
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
    setText("kpiRiskPostes", "—");
    setText("kpiRiskCritFragiles", "—");
    setText("kpiRiskEvol3m", "—");

    const a = byId("kpiRiskCritAlert");
    if (a) {
      a.textContent = "";
      a.style.display = "none";
    }

    setText("kpiMatchNoCandidate", "—");
    setText("kpiMatchReadyNow", "—");
    setText("kpiMatchReady6", "—");

    setText("kpiPrevSorties12", "—");
    setText("kpiPrevCompImpact", "—");
    setText("kpiPrevPostesRed", "—");
    setText("analyseSynthPostesAnalyses", "—");
    setText("analyseSynthCompetencesAnalysees", "—");
    setText("analyseSynthEffetsTerrain", "—");
    setText("analyseSynthProjection", "—");
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

  function getMatchPosteMode() {
    return "tous";
  }

  function setMatchPosteMode(_mode) {
    try { localStorage.removeItem(STORE_MATCH_POSTE_MODE); } catch (_) {}
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



  let _CRITICITE_MIN = null;

  function syncCriticiteMinFromResponse(data, opts = {}) {
    const {
      commit = true,      // met à jour _CRITICITE_MIN
      persist = true,     // écrit dans localStorage
      refreshUi = true    // remet à jour slider + valeur affichée
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
    return Number.isFinite(n) ? String(n) : "—";
  }

  function priorityLabel(score100) {
    const sc = Math.max(0, Math.min(100, Number(score100 || 0)));

    if (sc >= 100) return "Rupture";
    if (sc >= 80) return "Très critique";
    if (sc >= 60) return "Critique";
    if (sc >= 40) return "Élevée";
    if (sc >= 20) return "Modérée";
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
    return (v ?? "").toString().trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
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
    return k === "A" ? "Débutant" : k === "B" ? "Intermédiaire" : k === "C" ? "Avancé" : k === "D" ? "Expert" : ((v ?? "—").toString().trim() || "—");
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

  // Diagnostic décisionnel (poste fragile) - endpoint dédié
  const _posteDiagCache = new Map();      // key: id_poste|id_service|critMin|limit
  let _posteDiagReqSeq = 0;

  // Contexte du dernier poste ouvert (pour lazy-load détail/couverture)
  let _analysePosteLastParams = { id_poste: "", id_service: "" };
  let _analysePosteDetailLoaded = false;  // détail (endpoint /poste) chargé ou non
  let _analysePosteDetailLoading = false; // anti double-call


  // Modal détail poste (risques) — mode décisionnel
  // _analysePosteShowAllCompetences est réutilisé comme switch UI :
  // false = n’afficher que les compétences À RISQUE (0/1 porteur au niveau requis)
  // true  = afficher toutes les compétences CRITIQUES (criticité >= criticite_min)
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

    // Dernier diagnostic chargé (pour re-render quand on rebascule en "risques uniquement")
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
  const fragLine = (nbF > 0) ? `${nbF} fragilités détectées` : `Aucune fragilité détectée`;
  const nb0 = Number(comp.nb0 || 0);
  const nbTit = Number(diag?.poste?.nb_titulaires ?? comp.nb_titulaires ?? 0);

  function priorityLabel(score100) {
    const sc = clamp(Number(score100 || 0), 0, 100);
    if (sc >= 75) return "Critique";
    if (sc >= 50) return "Élevé";
    if (sc >= 25) return "Modéré";
    return "Faible";
  }

  const prioLabel = priorityLabel(s);

  function posteDiagLecture(score100) {
    const sc = clamp(Number(score100 || 0), 0, 100);
    if (sc >= 75) return "Ce poste est fortement exposé sur le périmètre analysé.";
    if (sc >= 50) return "Ce poste présente plusieurs fragilités à surveiller ou sécuriser.";
    if (sc >= 25) return "Ce poste présente une fragilité modérée.";
    return "Ce poste apparaît globalement sécurisé sur le périmètre analysé.";
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
            <div style="font-weight:900; font-size:28px; line-height:1;">
              ${s}<span style="font-size:12px; font-weight:800;">%</span>
            </div>
          </div>
        </div>
        <div class="card-sub" style="margin:0;">Fragilité</div>
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
        background:${bg}; color:${fg}; font-weight:900; font-size:12px; white-space:nowrap;">
        ${escapeHtml(label || "—")}
      </span>
    `;
  }


  function badge(txt, accent) {
    const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
    return `<span class="${cls}">${escapeHtml(txt || "—")}</span>`;
  }

  function pill(txt) {
    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid #d1d5db;
        background:#fff; color:#374151; font-weight:900; font-size:12px; white-space:nowrap;">
        ${escapeHtml(txt || "—")}
      </span>
    `;
  }

  // (recoLabel / recoPill / typeLabel supprimés : plus de recommandations dans le bloc "Causes racines")


  // Conditions (robuste: si l’API ne renvoie pas encore, on affiche “—”)
  const p = diag?.poste || {};
  const eduMinRaw = (p.niveau_education_minimum ?? p.education_minimum ?? p.edu_min ?? "");
  const eduMin = String(eduMinRaw ?? "").trim();
  const eduTxt = (eduMin && eduMin !== "0") ? eduMin : "Aucun";

  const domLabel = String(p.nsf_domaine_titre ?? p.nsf_domaine ?? p.nsf_domaine_code ?? "").trim();
  const domObl = (p.nsf_domaine_obligatoire === true);
  const domTxt = domLabel ? `${domLabel} ${domObl ? "(bloquant)" : "(indicatif)"}` : "—";

  const nbNecessaires = Number(p.nb_titulaires_necessaires ?? p.nb_titulaires_cible ?? comp.nb_titulaires_cible ?? 1);
  const releveTxt = "Renfort potentiel : immédiat à partir de 75% de matching, à préparer entre 60% et 74%.";

  // Causes racines (accordéons) : analyse factuelle (pas de recommandations ici)
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
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `<span class="sb-crit-badge ${critLevelClass(n)}">${escapeHtml(String(Math.round(n)))}</span>`;
  };

  const compCodeBadge = (code) =>
    `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code || "—")}</span>`;

  const nivBadgeHtml = (niv) => nsLevelBadgeHtml(niv, "Niveau de maîtrise");

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
              <th>Compétence</th>
              <th class="col-center" style="width:90px;">Criticité</th>
              <th class="col-center" style="width:150px;">Porteurs titulaires</th>
              <th class="col-center" style="width:170px;">Lecture</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = String(r?.code_comp || r?.code || "—");
              const intit = escapeHtml(r?.intitule || "—");
              const crit = critBadgeHtml(r?.poids_criticite);
              const nb = Number(r?.nb_porteurs_ok || 0);
              const depLabel = depRiskLabel(r);
              const depCls = depRiskBadgeClass(r);

              return `
                <tr>
                  <td style="white-space:nowrap;">${compCodeBadge(code)}</td>
                  <td style="min-width:280px;">
                    <div style="font-size:14px; font-weight:700;">${intit}</div>
                  </td>
                  <td class="col-center" style="white-space:nowrap;">${crit}</td>
                  <td class="col-center" style="white-space:nowrap;">
                    <span class="sb-badge">${escapeHtml(String(nb))}</span>
                  </td>
                  <td class="col-center" style="white-space:nowrap;">
                    <span class="sb-badge ${depCls}">${escapeHtml(depLabel)}</span>
                  </td>
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
          Cette lecture part des titulaires du poste. La maîtrise actuelle indique la part des compétences pour lesquelles le niveau A/B/C/D requis est atteint, sans moyenne de notes.
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Collaborateur</th>
                <th class="col-center" style="width:160px;">Maîtrise actuelle</th>
                <th class="col-center" style="width:110px;">Écart</th>
                <th class="col-center" style="width:74px;">Voir</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(r => `
                <tr>
                  <td>
                    <div style="font-size:14px; font-weight:800;">${escapeHtml(r?.full || "Collaborateur")}</div>
                    <div class="card-sub" style="margin:2px 0 0; font-size:12px;">${escapeHtml(String(r?.competences_ok ?? 0))}/${escapeHtml(String(r?.competences_total ?? 0))} compétences au niveau requis</div>
                  </td>
                  <td class="col-center"><span class="sb-badge">${escapeHtml(String(r?.maitrise_actuelle_pct ?? 0))}%</span></td>
                  <td class="col-center"><span class="sb-badge sb-badge--dep-none">-${escapeHtml(String(r?.ecart_pct ?? 0))}%</span></td>
                  <td class="col-center">
                    <button type="button"
                            class="sb-icon-btn poste-cause-match-person"
                            title="Voir"
                            aria-label="Voir l’adéquation au poste"
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
              <th>Compétence</th>
              <th class="col-center" style="width:110px;">Requis</th>
              <th class="col-center" style="width:160px;">Écart au requis</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = String(r?.code_comp || r?.code || "—");
              const intit = escapeHtml(r?.intitule || "—");
              const req = nivBadgeHtml(r?.niveau_requis);
              const nDef = Number(r?.nb_en_defaut || 0);
              const nTit = Number(r?.nb_titulaires || 0);
              return `
                <tr>
                  <td style="white-space:nowrap;">${compCodeBadge(code)}</td>
                  <td style="min-width:280px;"><div style="font-size:14px; font-weight:700;">${intit}</div></td>
                  <td class="col-center" style="white-space:nowrap;">${req}</td>
                  <td class="col-center" style="white-space:nowrap;"><span class="sb-badge">${escapeHtml(String(nDef))}</span><span style="color:#6b7280; font-size:12px; margin-left:6px;">/ ${escapeHtml(String(nTit))}</span></td>
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
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires nécessaires</div><div class="value">${escapeHtml(String(nbC))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires rattachés</div><div class="value">${escapeHtml(String(nbR))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Titulaires disponibles</div><div class="value">${escapeHtml(String(nbD))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;"><div class="label">Indisponibilités</div><div class="value">${escapeHtml(String(nbI))}</div></div>
      </div>
      ${gapT > 0 ? `<div class="sb-help" style="margin-top:10px;"><b>Couverture insuffisante</b> : il manque ${escapeHtml(String(gapT))} titulaire(s) disponible(s) par rapport au besoin du poste.</div>` : ``}
    `;
  })();

  const dependanceBody = (() => {
    if (!hasDep) return "";
    return `
      <div class="sb-help" style="margin-top:0;">
        Ce risque mesure les compétences pour lesquelles trop peu de personnes peuvent remplacer immédiatement le titulaire au niveau requis.
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
        <div class="card" style="padding:10px; margin:0; min-width:190px; flex:1;"><div class="label">Renforts immédiats ≥ 75%</div><div class="value">${escapeHtml(String(imm))}</div></div>
        <div class="card" style="padding:10px; margin:0; min-width:190px; flex:1;"><div class="label">Renforts à préparer 60-74%</div><div class="value">${escapeHtml(String(prep))}</div></div>
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
        Ces sorties ne sont pas la cause principale actuelle, mais elles peuvent aggraver la fragilité dans les 3 prochains mois.
      </div>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead><tr><th>Collaborateur</th><th class="col-center" style="width:140px;">Date prévue</th><th style="width:220px;">Motif</th></tr></thead>
          <tbody>
            ${items.map(r => `<tr><td><b>${escapeHtml(r?.full || "Collaborateur")}</b></td><td class="col-center">${escapeHtml(r?.date_sortie || "—")}</td><td>${escapeHtml(r?.motif || "Sortie prévue")}</td></tr>`).join("") || `<tr><td colspan="3" class="col-center">${escapeHtml(String(cSorties?.count || 0))} sortie(s) approchante(s).</td></tr>`}
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
      <div class="card-sub" style="margin:0;">Ouvrez une cause pour voir ce qui est observé et pourquoi cela pèse sur l’indice.</div>

      ${(!hasStruct && !hasDep && !hasTrans && !hasEff && !hasSorties) ? `
        <div class="card-sub" style="margin-top:10px;">Aucune cause à afficher.</div>
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
                <span class="sb-acc-chevron">▾</span>
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
                <span class="sb-acc-chevron">▾</span>
              </span>
            </button>
            <div class="sb-acc-body">${efficaciteBody}</div>
          </div>
        ` : ``}

        ${hasDep ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("main")}<span>Couverture trop dépendante d’une personne</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(dependanceSharePct))}%</span>` : ``}
                ${causeHelpButton("dependance")}
                <span class="sb-acc-chevron">▾</span>
              </span>
            </button>
            <div class="sb-acc-body">${dependanceBody}</div>
          </div>
        ` : ``}

        ${hasSorties ? `
          <div class="sb-accordion">
            <button type="button" class="sb-acc-head sb-btn sb-btn--soft">
              <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
                ${causeDot("aggravant")}<span>Sortie approchante d’un titulaire</span>
              </span>
              <span style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
                ${showSecondaryRiskShare ? `<span class="sb-badge sb-badge--risk-share">${escapeHtml(String(sortiesSharePct))}%</span>` : ``}
                ${causeHelpButton("sorties")}
                <span class="sb-acc-chevron">▾</span>
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
                <span class="sb-acc-chevron">▾</span>
              </span>
            </button>
            <div class="sb-acc-body">${transmissionBody}</div>
          </div>
        ` : ``}
      `}
    </div>
  `;


  function diagLine(label, value) {
    const v = (value === null || value === undefined || value === "") ? "—" : String(value);
    return `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #eef2f7;">
        <span style="font-size:13px; color:#64748b; line-height:1.35;">${escapeHtml(label)}</span>
        <span style="font-size:13px; color:#0f172a; font-weight:800; text-align:right; line-height:1.35;">${escapeHtml(v)}</span>
      </div>
    `;
  }

  // Plan de sécurisation (possibilités)



  // Plan de sécurisation (possibilités)
  const idPoste = String(p?.id_poste || p?.id || diag?.id_poste || "").trim();

  // NOTE : "causes" existe déjà plus haut (bloc Causes racines). On le réutilise.
  const depList = Array.isArray(causes?.dependance) ? causes.dependance : [];
  const effList = Array.isArray(causes?.efficacite) ? causes.efficacite : [];

  // Levier "Former" : uniquement si on a un sujet compétences actionnable (efficacité ou couverture insuffisante).
  // Fallback : si causes pas rempli, on garde la composante historique nb1_a_former.
  const canTrainFromCauses = (effList.length > 0) || depList.some(x => Number(x?.nb_porteurs_ok || 0) > 0);
  const canTrainFromComp = Number(comp?.nb1_a_former || 0) > 0;
  const canTrain = !!(canTrainFromCauses || canTrainFromComp);

  // Rendu
  host.innerHTML = `
    <div class="card" style="padding:12px; margin:0;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap;">
        <div style="flex:1; min-width:320px;">
          <div class="card-title" style="margin:0;">Diagnostic</div>

          <div class="card-sub" style="margin:8px 0 8px 0;font-size:14px;line-height:1.55;">
            ${posteDiagLecture(s)}
          </div>
          <div class="card-sub" style="margin:0 0 8px 0;font-size:13px;line-height:1.45;font-weight:800;color:#475569;">
            Éléments pris en compte :
          </div>
          <div style="max-width:660px;">
            ${diagLine("Diplôme minimum", eduTxt)}
            ${diagLine("Domaine de formation", domTxt)}
            ${diagLine("Nombre de titulaires nécessaires", String(nbNecessaires || 1))}
            ${diagLine("Criticité des compétences", `≥ ${critMin}%`)}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
          ${ring(s)}
          ${priorityPill(prioLabel, s)}
        </div>
      </div>
    </div>

    ${causesCard}

    <div class="card analyse-hypothesis-card" style="padding:12px; margin-top:12px;">
      <div class="card-title" style="margin:0 0 6px 0;">Points à sécuriser</div>
      <div class="card-sub" style="margin:0;">Ces points servent à préparer une hypothèse dans les Simulations RH. La décision finale reste hors Novoskill.</div>
      ${securityPointsHtml("poste")}
      <div class="sb-actions sb-actions--end" style="margin-top:12px;">
        <button type="button" id="btnAnalysePosteCreateHypothesis" class="sb-btn sb-btn--accent">
          Créer une hypothèse de sécurisation
        </button>
      </div>
    </div>
  `;

    // Accordéons (Causes racines)
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

  // Points à sécuriser - création d'hypothèse vers Simulations RH
  const bHypoPoste = byId("btnAnalysePosteCreateHypothesis");
  if (bHypoPoste && !bHypoPoste.dataset.bound) {
    bHypoPoste.dataset.bound = "1";
    bHypoPoste.addEventListener("click", () => {
      if (!idPoste) {
        if (_portalref) _portalref.showAlert("error", "Impossible de créer l’hypothèse : poste manquant.");
        return;
      }
      const codePoste = String(p?.codif_client || p?.codif_poste || "").trim();
      const posteLabel = [codePoste, p?.intitule_poste || "Poste"].filter(Boolean).join(" · ");
      const cause = hasStruct ? "Couverture du poste insuffisante" : hasDep ? "Couverture trop dépendante" : hasEff ? "Niveau attendu non atteint" : hasTrans ? "Transmission à anticiper" : "Point de fragilité détecté";
      addAnalyseHypothesis({
        type: "securiser_poste",
        title: `Sécuriser le poste ${posteLabel || "sélectionné"}`,
        poste_id: idPoste,
        poste_label: posteLabel,
        cause: cause,
        effet: "Tester une hypothèse de sécurisation sans décider depuis l’analyse.",
        horizon: "actuel",
        criticite: s
      });
      closeAnalysePosteModal();
    });
  }

}

    // ==============================
  // MATCHING (MVP)
  // - basé sur /risques/poste (compétences requises + porteurs)
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

  async function fetchMatchingPostes(portal, id_service, _modePostes) {
    const svc = (id_service || "").trim();
    const key = `tous|${svc || "__ALL__"}`;
    if (_matchPostesCache.has(key)) return _matchPostesCache.get(key);

    const data = await fetchRisquesDetail(portal, "postes-scope", svc, 2000);
    const items = Array.isArray(data?.items) ? data.items : [];

    _matchPostesCache.set(key, items);
    return items;
  }

  // Détail effectif (drilldown)
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

    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");
    if (!posteId) throw new Error("id_poste manquant.");

    if (String(docKey || "") !== "fiche_poste_simple") {
      throw new Error("Document PDF non géré.");
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
      throw new Error("Le navigateur a bloqué l’ouverture du PDF.");
    }

    return url;
  }

  function buildAnalyseMatchingPdfUrl(portal, id_poste, id_service) {
    const ctx = getPortalContext(portal);
    const posteId = String(id_poste || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");
    if (!posteId) throw new Error("Sélectionne un poste avant d’imprimer.");

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

    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");
    if (!posteId) throw new Error("Sélectionne un poste avant d’imprimer.");
    if (!effectifId) throw new Error("Collaborateur introuvable pour l’impression.");

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
    await openAnalysePdfBlob(url, "Impression bloquée");
    return url;
  }

  async function openAnalyseMatchingEffectifPdfInBrowser(portal, id_poste, id_effectif, id_service) {
    const url = buildAnalyseMatchingEffectifPdfUrl(portal, id_poste, id_effectif, id_service);
    await openAnalysePdfBlob(url, "Impression bloquée");
    return url;
  }

  function buildAnalyseCollaborateurCompetencePdfUrl(portal, id_effectif, id_comp, id_poste) {
    const ctx = getPortalContext(portal);
    const effectifId = String(id_effectif || "").trim();
    const compId = String(id_comp || "").trim();
    const posteId = String(id_poste || "").trim();

    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");
    if (!effectifId) throw new Error("Collaborateur introuvable pour l’impression.");
    if (!compId) throw new Error("Compétence introuvable pour l’impression.");

    const qs = new URLSearchParams();
    if (posteId) qs.set("id_poste", posteId);
    qs.set("_", String(Date.now()));

    return `${ctx.apiBase}/skills/collaborateurs/competences/fiche_pdf/${encodeURIComponent(ctx.id_contact)}/${encodeURIComponent(effectifId)}/${encodeURIComponent(compId)}?${qs.toString()}`;
  }

  async function openAnalyseCollaborateurCompetencePdfInBrowser(portal, id_effectif, id_comp, id_poste) {
    const url = buildAnalyseCollaborateurCompetencePdfUrl(portal, id_effectif, id_comp, id_poste);
    await openAnalysePdfBlob(url, "PDF compétence bloqué");
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
    btn.title = hasPoste ? "Imprimer les correspondances du poste sélectionné" : "Sélectionne un poste avant d’imprimer";
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
        if (typeof showToast === "function") showToast(e.message || "Impossible d’ouvrir le PDF.", "error");
        else alert(e.message || "Impossible d’ouvrir le PDF.");
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
              class="sb-btn sb-btn--accent sb-btn--xs"
              ${String(_matchSelectedPoste || "").trim() ? "" : "disabled"}>
        Imprimer
      </button>
    `;

    bindMatchingToggleButton();
    bindMatchingPrintButton(id_service);
  }





  // ======================================================
  // API: détail "Critiques impactées" (prévisions)
  // ======================================================
  async function fetchPrevisionsCritiquesDetail(portal, horizonYears, id_service, limit = 2000) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears || 1));
    if (id_service) qs.set("id_service", String(id_service).trim());

    // IMPORTANT: alignement avec le reste de la page
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${ctx.apiBase}/skills/analyse/previsions/critiques/detail/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;

    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  async function fetchPrevisionsPostesRougesDetail(portal, horizonYears, id_service, limit = 2000) {
    const portalCtx = getPortalContext(portal);
    if (!portalCtx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!portalCtx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const qs = new URLSearchParams();
    qs.set("horizon_years", String(horizonYears));
    if (id_service) qs.set("id_service", String(id_service));

    // Alignement avec le reste de la page
    const cmin = getCriticiteMinSafe(null);
    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));
    qs.set("limit", String(limit || 2000));

    const url = `${portalCtx.apiBase}/skills/analyse/previsions/postes-rouges/detail/${encodeURIComponent(portalCtx.id_contact)}?${qs.toString()}`;

    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
  }

  async function fetchPrevisionsPosteRougeModal(portal, id_poste, horizonYears, id_service, criticite_min) {
    const ctx = getPortalContext(portal);
    if (!ctx.id_contact) throw new Error("id_contact introuvable côté UI.");
    if (!ctx.apiBase) throw new Error("apiBase introuvable côté UI.");

    const poste = (id_poste || "").toString().trim();
    if (!poste) throw new Error("id_poste manquant.");

    const qs = new URLSearchParams();
    qs.set("id_poste", poste);
    qs.set("horizon_years", String(horizonYears || 1));

    const svc = (id_service || "").toString().trim();
    if (svc) qs.set("id_service", svc);

    const cmin = (criticite_min === null || criticite_min === undefined || criticite_min === "")
      ? getCriticiteMinSafe(null)
      : Number(criticite_min);

    if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));

    const url = `${ctx.apiBase}/skills/analyse/previsions/postes-rouges/modal/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;

    const data = await analyseApiJson(portal, url);
    syncCriticiteMinFromResponse(data, { commit: false, persist: false, refreshUi: false });
    return data;
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
                <span id="matchPersonModalTitle" style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Détail</span>
                <span id="matchPersonModalTitleBadge" class="sb-badge" style="display:none;"></span>
              </div>
              <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                <span id="matchPersonModalTitlePosteCode" class="sb-badge sb-badge-ref-poste-code" style="display:none;"></span>
                <span id="matchPersonModalTitlePosteText" class="card-sub" style="margin:0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
              </div>
            </div>
            <button type="button" class="modal-x" id="btnCloseMatchPersonModal" aria-label="Fermer">×</button>
          </div>


          <div class="modal-body" id="matchPersonModalBody">
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
    const badgeEl = byId("matchPersonModalTitleBadge");
    const posteCodeEl = byId("matchPersonModalTitlePosteCode");
    const posteTextEl = byId("matchPersonModalTitlePosteText");
    const b = byId("matchPersonModalBody");

    if (t) t.textContent = title || "Détail";

    // Reset header (sera rempli après fetch)
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

    const codifClient = (poste.codif_client || "").trim();
    const codifPoste = (poste.codif_poste || "").trim();
    const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

    const posteIntitule = (poste.intitule_poste || "").trim();
    const posteLabel = `${codeAffiche ? codeAffiche + " — " : ""}${(posteIntitule || "Poste")}`;

    const personLabel = person.full || "—";
    const svc = person.nom_service || "—";
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
        posteActuelLabel = "Hors périmètre";
      } else if (paCodeAffiche || paIntitule) {
        posteActuelLabel = `${paCodeAffiche ? paCodeAffiche + " — " : ""}${paIntitule || "Poste"}`;
      } else {
        posteActuelLabel = "Renseigné";
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
              <div style="font-weight:900; font-size:28px; line-height:1;">
                ${s}<span style="font-size:12px; font-weight:800;">%</span>
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
      if (s === "improvable" || s === "ameliorable" || s === "améliorable") return `<span class="sb-badge sb-badge--success">Améliorable</span>`;
      if (s === "under") return `<span class="sb-badge sb-badge--warning">À renforcer</span>`;
      return `<span class="sb-badge sb-badge--danger">Manquante</span>`;
    }

    function fmtScore(v) {
      if (v === null || v === undefined || v === "") return "—";
      const n = Number(v);
      if (Number.isNaN(n)) return "—";
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
      const txt = Number.isFinite(n) ? String(Math.round(n)) : "—";
      const lvl = critLevel(n);
      return `<span class="sb-crit-badge sb-crit-l${lvl}" title="Criticité (poids)">${escapeHtml(txt)}</span>`;
    }

    function nivBadgeHtml(v) {
      return nsLevelBadgeHtml(v, "Niveau de maîtrise");
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
        const title = (nom || code || "Critère").trim();

        const n = (x?.niveau === null || x?.niveau === undefined) ? null : Number(x.niveau);
        const pts = (n !== null && Number.isFinite(n)) ? `${Math.round(n)}/4` : "—";

        const lib = (x?.libelle || "").toString().trim() || "—";
        const border = (i < a.length - 1) ? "border-bottom:1px solid #eef2f7;" : "";

        return `
          <tr>
            <td style="padding:7px 8px; ${border} font-weight:500; color:#111827; vertical-align:top;">${escapeHtml(title)}</td>
            <td style="padding:7px 8px; ${border} width:70px; text-align:center; font-weight:700; color:#111827; vertical-align:top;">${escapeHtml(pts)}</td>
            <td style="padding:7px 8px; ${border} color:#6b7280; vertical-align:top;">${escapeHtml(lib)}</td>
          </tr>
        `;
      }).join("");

      return `
        <tr data-crit-row="${escapeHtml(uid)}" style="display:none;">
          <td colspan="8" style="padding:0;">
            <div style="padding:10px 12px; border-top:1px dashed #e5e7eb; background:#fbfbfb;">
              <table style="width:100%; border-collapse:collapse; font-size:12px; line-height:1.35;">
                <tbody>${rows}</tbody>
              </table>
            </div>
          </td>
        </tr>
      `;
    }

    const rowsHtml = items.map((it, idx) => {
      const uid = `crit_${idx}`;
      const code = it?.code || it?.id_comp || "—";
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
          <span data-crit-caret style="margin-right:6px;">▸</span>Voir les évaluations
        </button>
      ` : ``;

      const btnCompetencePdf = compId ? `
        <button type="button"
                class="sb-icon-btn sb-icon-btn--doc"
                data-match-competence-pdf="${escapeHtml(compId)}"
                title="Voir la fiche compétence PDF"
                aria-label="Voir la fiche compétence PDF">
          ${analysePdfIconSvg()}
        </button>
      ` : ``;

      const mainRow = `
        <tr>
          <td style="vertical-align:top;">
            ${badgesTop}
            <div style="font-weight:500; font-size:13px; line-height:1.28; color:#111827; margin-top:4px;">${escapeHtml(intitule)}</div>
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
      if (!v) return "—";
      if (v.length <= maxLen) return v;
      return v.slice(0, Math.max(4, maxLen - 1)) + "…";
    }

    const domMap = new Map();
    items.forEach((it) => {
      const raw = ((it?.domaine_titre_court || it?.domaine || "") ?? "").toString().trim();
      const label = raw || "Non classé";
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
      ? `<div class="card-sub" style="color:#6b7280;">Radar indisponible (moins de 3 compétences).</div>`
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
              <div style="font-weight:700; font-size:16px; line-height:1.2; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
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
                Dernière évaluation de compétences : ${escapeHtml(lastCompetenceEval ? formatDateFr(lastCompetenceEval) : "—")}
              </div>
              <div class="card-sub" style="margin:4px 0 0 0;">
                Dernier entretien individuel : ${escapeHtml(lastEntretienIndividuel ? formatDateFr(lastEntretienIndividuel) : "—")}
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
            <span data-match-accordion-caret="radar" style="font-weight:900; color:#6b7280;">▾</span>
          </button>
          <div id="matchPersonRadarPanel" data-match-accordion-panel="radar" style="padding:0 12px 12px 12px;">
            <div class="sb-actions" style="justify-content:flex-start; margin:0 0 10px 0; gap:6px;">
              <button type="button" id="btnMatchRadarViewComp" class="sb-btn sb-btn--accent sb-btn--xs">Vue compétence</button>
              <button type="button" id="btnMatchRadarViewDomain" class="sb-btn sb-btn--soft sb-btn--xs">Vue domaine compétence</button>
            </div>
            <div id="matchRadarPanelComp">${radarHtmlComp}</div>
            <div id="matchRadarPanelDomain" style="display:none;">${radarHtmlDomain}</div>
          </div>
        </div>

        <div class="card" style="padding:0; margin:0; overflow:hidden;">
          <button type="button" data-match-accordion-toggle="table" aria-expanded="false"
                  style="width:100%; border:0; background:transparent; padding:12px; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer; text-align:left;">
            <span class="card-title" style="margin:0;">Détail des compétences</span>
            <span data-match-accordion-caret="table" style="font-weight:900; color:#6b7280;">▸</span>
          </button>
          <div id="matchPersonTablePanel" data-match-accordion-panel="table" style="display:none; padding:0 12px 12px 12px;">
            <div class="table-wrap" style="margin-top:0;">
              <table class="sb-table">
                <thead>
                  <tr>
                    <th rowspan="2" style="min-width:320px;">Compétence</th>
                    <th colspan="3" class="col-center" style="background:#f9fafb;">BESOIN DU POSTE</th>
                    <th colspan="3" class="col-center" style="background:#f9fafb; border-left:1px solid #d1d5db;">PROFIL ÉVALUÉ</th>
                    <th rowspan="2" class="col-center" style="width:54px;"></th>
                  </tr>
                  <tr>
                    <th class="col-center" style="width:90px;">Criticité</th>
                    <th class="col-center" style="width:130px;">Niveau<br>requis</th>
                    <th class="col-center" style="width:90px;">Note max.</th>
                    <th class="col-center" style="width:90px; border-left:1px solid #d1d5db;">Atteint</th>
                    <th class="col-center" style="width:140px;">Niveau<br>atteint</th>
                    <th class="col-center" style="width:120px;">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml || `<tr><td colspan="8" class="col-center" style="color:#6b7280;">Aucune compétence requise.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card analyse-hypothesis-card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Hypothèse de sécurisation</div>
          <div class="card-sub" style="margin:0;">Tester cette correspondance dans Simulations RH, sans valider une mobilité depuis l’analyse.</div>
          <div class="sb-actions sb-actions--end" style="margin-top:12px;">
            <button type="button" class="sb-btn sb-btn--accent" id="btnMatchCreateHypothesis">Créer une hypothèse de sécurisation</button>
          </div>
        </div>

      </div>
    `;

    const bMatchHypo = byId("btnMatchCreateHypothesis");
    if (bMatchHypo && !bMatchHypo.dataset.bound) {
      bMatchHypo.dataset.bound = "1";
      bMatchHypo.addEventListener("click", () => {
        addAnalyseHypothesis({
          type: "tester_correspondance_profil_poste",
          title: `Tester la correspondance ${String(personLabel || "Profil")} / ${String(posteLabel || "Poste")}`,
          poste_id: String(poste.id_poste || poste.id || "").trim(),
          poste_label: posteLabel,
          effectif_id: String(person.id_effectif || person.id_collaborateur || person.id || "").trim(),
          effectif_label: personLabel,
          scope_label: svc,
          cause: "Correspondance profil / poste à confirmer",
          effet: "Vérifier si le profil peut contribuer à la sécurisation du poste sans décider d’une mobilité dans l’analyse.",
          horizon: "actuel",
          matching_score: Number(stats.score_pct || 0)
        });
        closeMatchPersonModal();
      });
    }

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
        if (caret) caret.textContent = open ? "▾" : "▸";
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
          showAnalyseHelp("PDF compétence indisponible", `<p>${escapeHtml(errMsg(e))}</p>`);
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
        if (caret) caret.textContent = open ? "▾" : "▸";
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
    openMatchPersonModal("Détail matching");

    try {
      const data = await fetchMatchingEffectifDetail(portal, id_poste, id_effectif, id_service);

      const poste = data?.poste || {};
      const person = data?.person || {};

      // Header: Nom + badge Titulaire/Candidat + code poste + intitulé
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
            <div class="card-title" style="margin-bottom:0;">Postes</div>
            <div id="matchPosteList" style="margin-top:10px; display:flex; flex-direction:column; gap:6px;"></div>
          </div>

          <div class="card" style="padding:12px; margin:0; flex:1;">
            <div class="card-title" style="margin-bottom:6px;">Candidats</div>
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
      const intitule = (r.intitule_poste || "").trim() || "—";
      const codifClient = (r.codif_client || "").trim();
      const codifPoste = (r.codif_poste || "").trim();
      const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;

      const svc = (r.nom_service || "").trim() || "—";
      const bottom = `${(codeAffiche || "—")}${svc ? " • " : ""}${svc}`.trim();

      const nbRattaches = Number(r.nb_titulaires_rattaches);
      const sansTitulaire = Number.isFinite(nbRattaches) && nbRattaches <= 0;
      const liseretStyle = sansTitulaire ? `box-shadow:inset 4px 0 0 #ef4444;` : ``;
      const titleAttr = sansTitulaire ? ` title="Aucun titulaire affecté sur ce poste"` : ``;

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
          <div style="font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(intitule)}
          </div>
          <div style="font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(bottom)}
          </div>
        </button>
      `;
    }).join("");
  }

  function computeCandidatesFromPosteDetail(data) {
    const comps = Array.isArray(data?.competences) ? data.competences : [];
    if (!comps.length) return [];

    // Liste des compétences requises + poids
    const critMin = Number(data?.criticite_min);
    const critMinVal = Number.isFinite(critMin) ? critMin : (getCriticiteMin() ?? 0);
    const compReq = comps.map(c => {
      const code = (c.code || c.id_competence || "").toString().trim(); // on privilégie code
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
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun candidat détecté (aucun candidat ne possède les compétences du poste).</div>`;
      return;
    }

    // --- Titulaires vs Candidats : on s’appuie sur un flag si l’API le donne, sinon sur id_poste_actuel
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
        <span title="Score d’adéquation au poste"
              style="display:inline-flex; align-items:center; justify-content:center;
                     min-width:56px; padding:5px 10px; border-radius:999px;
                     border:1px solid ${border}; background:${bg}; color:${color};
                     font-size:12px; font-weight:900; line-height:1; white-space:nowrap;">
          ${s}<span style="font-size:11px; font-weight:800; margin-left:1px;">%</span>
        </span>
      `;
    }

    const headerTitle = (v === "titulaire") ? "Adéquation au poste (titulaire" + (titulairesAll.length > 1 ? "s" : "") + ")" : "Top candidats (hors titulaires)";
    const emptyText = (v === "titulaire") ? "Aucun titulaire détecté sur ce poste" : "Aucun candidat (hors titulaires)";

    function renderRow(c) {
      const score = Number(c.score_pct || 0);
      const ide = String(c.id_effectif || "").trim();

      return `
        <tr class="match-person-row" data-match-id_effectif="${escapeHtml(ide)}">
          <td style="font-weight:700;">${escapeHtml(c.full || "—")}</td>
          <td>${escapeHtml(c.nom_service || "—")}</td>
          <td class="col-center">${scoreBadge(score)}</td>
          <td class="col-center">
            <div class="sb-icon-actions" style="justify-content:center;">
              <button type="button"
                      class="sb-icon-btn match-person-open"
                      data-match-person-open="${escapeHtml(ide)}"
                      title="Voir"
                      aria-label="Voir le détail de la correspondance">
                ${analyseEyeIconSvg()}
              </button>
              <button type="button"
                      class="sb-icon-btn sb-icon-btn--doc"
                      data-match-person-pdf="${escapeHtml(ide)}"
                      title="PDF"
                      aria-label="Exporter le détail de la correspondance en PDF">
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
          ${escapeHtml(((poste?.codif_client || "").trim() || (poste?.codif_poste || "").trim() || "—"))}
        </span>
        <b style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(((poste?.intitule_poste || "").trim() || "—"))}
        </b>
      </div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead>
            <tr>
              <th>Effectif</th>
              <th style="width:180px;">Service</th>
              <th class="col-center" style="width:110px;"
                  title="Adéquation globale au poste (synthèse des compétences requises).">Score</th>
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
    if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

    const data = await fetchAnalyseMatchingPoste(portal, id_poste, id_service);
    if (seqGuard && seqGuard !== _matchReqSeq) return;

    const poste = data?.poste || {};
    const items = Array.isArray(data?.items) ? data.items : [];

    renderMatchingCandidates(id_poste, poste, items, getMatchView());
    refreshMatchingPrintButtonState();
  }

    // ==============================
  // Détail COMPETENCE (Risques)
  // ==============================
  const _compDetailCache = new Map();
  let _compDetailReqSeq = 0;

  async function fetchAnalyseCompetenceDetail(portal, codeOrId, id_service) {
    const svc = (id_service || "").trim();
    const key = `${codeOrId}|${svc}`;
    if (_compDetailCache.has(key)) return _compDetailCache.get(key);

    const raw = (codeOrId || "").trim();

    // Heuristique simple: un code ressemble à CO00020 / ABC123 etc.
    const isCode = /^[A-Z]{1,6}\d{2,}$/i.test(raw);

    const qs = buildQueryString({
      code: isCode ? raw : null,
      id_comp: !isCode ? raw : null,          // nom courant côté backend
      id_competence: !isCode ? raw : null,    // alias au cas où
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

    const titleText = title || "Détail poste";

    // Si la structure "Code + Texte" existe (HTML modifié), on l’utilise.
    // Sinon, fallback sur l’ancien fonctionnement.
    if (tText) tText.textContent = titleText;
    else if (tWrap) tWrap.textContent = titleText;

    // À chaque ouverture, on reset le badge code (il sera rempli après chargement data)
    if (tCode) {
      tCode.textContent = "";
      tCode.style.display = "none";
    }

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
              <span id="analyseCompModalTitleText" class="sb-title-text">Détail compétence</span>
            </div>
            <button type="button" class="modal-x" id="analyseCompModalCloseBtn" aria-label="Fermer">×</button>
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
    let compText = "Détail compétence";

    if (title && typeof title === "object") {
      compCode = String(title.code || "").trim();
      compText = String(title.text || "").trim() || compText;
    } else {
      compText = String(title || "").trim() || compText;
    }

    // Texte (fallback si jamais tText n’existe pas)
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
        <div class="card-sub" style="margin:0;">Chargement…</div>
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
      if (s >= 50) return "Élevé";
      if (s >= 25) return "Modéré";
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
          font-weight:800; font-size:12px; white-space:nowrap;
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
              <div style="font-weight:900; font-size:28px; line-height:1;">${s}<span style="font-size:12px; font-weight:800;">%</span></div>
            </div>
          </div>
          <div class="card-sub" style="margin:0;">Fragilité</div>
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
      if (v === null || v === undefined || v === "") return "—";
      return String(v);
    }

    function diagLine(label, value) {
      return `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #eef2f7;">
          <span style="font-size:13px; color:#64748b; line-height:1.35;">${esc(label)}</span>
          <span style="font-size:13px; color:#0f172a; font-weight:800; text-align:right; line-height:1.35;">${esc(valueOrDash(value))}</span>
        </div>
      `;
    }

    function smallMetric(label, value, help) {
      return `
        <div class="card" style="padding:10px; margin:0; min-width:160px; flex:1;">
          <div class="label" style="font-size:12px; line-height:1.25;">${esc(label)}</div>
          <div class="value" style="font-size:20px; line-height:1.15;">${esc(valueOrDash(value))}</div>
          ${help ? `<div class="card-sub" style="margin:3px 0 0 0; font-size:12px; line-height:1.35;">${esc(help)}</div>` : ``}
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
      if (!Number.isFinite(n) || n <= 0) return "—";
      return `<span class="sb-crit-badge ${critLevelClass(n)}">${esc(String(Math.round(n)))}</span>`;
    }

    function causeItemsHtml(cause) {
      const code = String(cause?.code || "");
      const items = Array.isArray(cause?.items) ? cause.items : [];

      if (code === "MAITRISE_INSUFFISANTE") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Écarts observés sur les postes où cette compétence est attendue.</div>
          <div class="table-wrap" style="margin-top:8px;">
            <table class="sb-table">
              <thead><tr>
                <th>Poste</th>
                <th class="col-center" style="width:96px;">Niveau requis</th>
                <th class="col-center" style="width:62px;">Besoin</th>
                <th class="col-center" style="width:108px;">Collaborateurs<br>au niveau</th>
                <th class="col-center" style="width:64px;">Écart</th>
                <th class="col-center" style="width:82px;">Criticité</th>
              </tr></thead>
              <tbody>${items.length ? items.map(it => `
                <tr>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px;min-width:320px;">
                      <span class="sb-badge sb-badge-ref-poste-code">${esc(it.poste || "—")}</span>
                      <span style="font-size:14px;font-weight:750;color:#0f172a;white-space:normal;line-height:1.25;">${esc(it.intitule_poste || "—")}</span>
                    </div>
                  </td>
                  <td class="col-center">${nsLevelBadgeHtml(it.niveau_requis || "—", "Niveau requis")}</td>
                  <td class="col-center">${esc(String(it.besoin ?? 0))}</td>
                  <td class="col-center">${esc(String(it.porteurs_niveau_requis ?? it.collaborateurs_niveau_requis ?? 0))}</td>
                  <td class="col-center"><span class="sb-badge sb-badge--warning">${esc(String(it.ecart ?? 0))}</span></td>
                  <td class="col-center">${critBadgeHtml(it.criticite)}</td>
                </tr>`).join("") : `<tr><td colspan="6" class="col-center sb-muted">Aucun écart de maîtrise détaillé.</td></tr>`}</tbody>
            </table>
          </div>`;
      }

      if (code === "CONCENTRATION") {
        const confirmes = Number(stats?.nb_porteurs || stats?.nb_porteurs_valides || 0);
        const declares = Number(stats?.nb_porteurs_declares || 0);
        const besoin = Number(stats?.besoin_total || 0);
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Nombre de collaborateurs identifiés sur cette compétence.</div>
          <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:8px;">
            ${smallMetric("Collaborateurs confirmés", confirmes, "Niveau connu et exploitable.")}
            ${smallMetric("Collaborateurs déclarés", declares, "Collaborateurs associés à cette compétence.")}
            ${smallMetric("Besoin total", besoin, "Volume attendu sur les postes concernés.")}
          </div>`;
      }

      if (code === "TRANSMISSION_INSUFFISANTE") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Niveaux disponibles pour organiser une transmission.</div>
          <div class="row" style="gap:12px; flex-wrap:wrap; margin-top:8px;">
            ${smallMetric("Experts disponibles", expertsDisponibles, "Niveau Expert disponible.")}
            ${smallMetric("Avancés ou experts", avancesOuExperts, "Niveau Avancé ou Expert.")}
            ${smallMetric("Collaborateurs évalués", evaluatedCount, "Niveau connu dans Novoskill.")}
          </div>`;
      }

      if (code === "EXPOSITION_SORTIES_INDISPOS") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Événements connus pouvant modifier la disponibilité.</div>
          <div class="table-wrap" style="margin-top:8px;">
            <table class="sb-table">
              <thead><tr><th>Collaborateur</th><th>Poste</th><th>Événement</th><th class="col-center" style="width:120px;">Début</th><th class="col-center" style="width:120px;">Fin / date</th></tr></thead>
              <tbody>${items.length ? items.map(it => `
                <tr>
                  <td><b>${esc(it.collaborateur || "—")}</b></td>
                  <td>${esc(it.poste || "—")}</td>
                  <td><span class="sb-badge sb-badge--warning">${esc(it.evenement || "Événement")}</span></td>
                  <td class="col-center">${esc(it.debut || "—")}</td>
                  <td class="col-center">${esc(it.fin || "—")}</td>
                </tr>`).join("") : `<tr><td colspan="5" class="col-center sb-muted">Aucun événement détaillé.</td></tr>`}</tbody>
            </table>
          </div>`;
      }

      if (code === "DONNEES_A_VERIFIER") {
        return `
          <div class="card-sub" style="margin:0 0 8px 0;">Informations à confirmer pour fiabiliser l’analyse.</div>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${items.length ? items.map(it => `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 10px; border:1px solid #e5e7eb; border-radius:10px; background:#fff;">
                <span style="font-size:13px; color:#334155; font-weight:750;">${esc(it.label || "Point à vérifier")}</span>
                <span class="sb-badge">${esc(String(it.value ?? "—"))}</span>
              </div>`).join("") : `<div class="card-sub" style="margin:0;">Aucune donnée à vérifier.</div>`}
          </div>`;
      }

      return `<div class="card-sub" style="margin:0;">Éléments observés sur cette cause.</div>`;
    }

    const causesHtml = causes.map((c, idx) => `
      <div class="sb-accordion">
        <button type="button" class="sb-acc-head sb-btn sb-btn--soft ${idx === 0 ? "is-open" : ""}">
          <span style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0;">
            ${causeDot(c?.severity)}<span style="font-weight:650;color:#1f2937;">${esc(c?.titre || "Cause")}</span>
          </span>
          <span style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
            ${shareBadge(c)}
            ${causeHelpButton(causeHelpKey(c?.code))}
            <span class="sb-acc-chevron">▾</span>
          </span>
        </button>
        <div class="sb-acc-body">
          ${causeItemsHtml(c)}
        </div>
      </div>
    `).join("") || `<div class="card-sub" style="margin:0;">Aucune cause de fragilité détectée sur le périmètre analysé.</div>`;

    const collaborateursRows = collaborateurs.slice(0, 12).map((r) => {
      const full = `${(r?.prenom_effectif || "").toString().trim()} ${(r?.nom_effectif || "").toString().trim()}`.trim() || "—";
      const evalDate = (r?.date_derniere_eval || r?.date_audit || "").toString().slice(0, 10);
      const isIndispo = isUnavailable(r);
      const cls = isIndispo ? "sb-badge--warning" : r?.is_evaluee ? "sb-badge--success" : "sb-badge--info";
      const label = isIndispo ? "Indisponible" : r?.is_evaluee ? "Évalué" : "À confirmer";
      return `
        <tr>
          <td class="sb-fs-13 sb-fw-700">${esc(full)}</td>
          <td class="sb-fs-13">${esc(r?.intitule_poste || "—")}</td>
          <td class="col-center">${nsLevelBadgeHtml(r?.niveau_actuel || "—", "Niveau actuel")}</td>
          <td class="col-center">${esc(evalDate ? formatDateFr(evalDate) : "—")}</td>
          <td><span class="sb-badge ${cls}">${esc(label)}</span></td>
        </tr>`;
    }).join("");

    const lecture = (() => {
      if (scoreSafe >= 75) return "Cette compétence est fortement exposée sur le périmètre analysé.";
      if (scoreSafe >= 50) return "Cette compétence présente plusieurs fragilités à surveiller ou sécuriser.";
      if (scoreSafe >= 25) return "Cette compétence présente une fragilité modérée.";
      return "Cette compétence apparaît globalement sécurisée sur le périmètre analysé.";
    })();

    host.innerHTML = `
      <div class="card" style="padding:14px;margin:0;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:320px;">
            <div class="card-title" style="margin-bottom:8px;">Diagnostic</div>
            <div class="card-sub" style="margin:0 0 8px 0;font-size:14px;line-height:1.55;">${esc(lecture)}</div>
            <div class="card-sub" style="margin:0 0 8px 0;font-size:13px;line-height:1.45;font-weight:800;color:#475569;">
              Éléments pris en compte :
            </div>
            <div style="max-width:660px;">
              ${diagLine("Périmètre analysé", scopeLabel)}
              ${diagLine("Criticité des compétences", `≥ ${data?.criticite_min ?? "—"}%`)}
              ${diagLine("Besoin total de couverture", stats?.besoin_total ?? "—")}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
            ${ring(scoreSafe)}
            ${statePill(scoreSafe)}
          </div>
        </div>
      </div>

      <div class="card" style="padding:14px;margin-top:12px;">
        <div class="card-title" style="margin-bottom:6px;">Pourquoi cette compétence est fragile ?</div>
        <div class="card-sub" style="margin:0 0 10px 0;">Ouvrez une cause pour voir les éléments observés sur cette compétence.</div>
        ${causesHtml}
      </div>

      <div class="card" style="padding:14px;margin-top:12px;">
        <div class="card-title" style="margin-bottom:8px;">Collaborateurs identifiés</div>
        <div style="overflow:auto;">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover" style="margin:0;min-width:760px;">
            <thead><tr><th>Collaborateur</th><th>Poste actuel</th><th class="col-center">Niveau</th><th class="col-center">Dernière évaluation</th><th>Statut</th></tr></thead>
            <tbody>${collaborateursRows || `<tr><td colspan="5" class="sb-muted">Aucun collaborateur identifié.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function showAnalyseCompetenceDetailModal(portal, id_comp_or_code, id_service) {
    const mySeq = ++_compDetailReqSeq;

    openAnalyseCompetenceModal("Détail compétence");

    try {
      const data = await fetchAnalyseCompetenceDetail(portal, id_comp_or_code, id_service);
      if (mySeq !== _compDetailReqSeq) return;

      const comp = data?.competence || {};
      const titleCode = String(comp.code || "").trim();
      const titleText = String(comp.intitule || "Compétence").trim();

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

      openAnalyseCompetenceModal("Détail compétence");

      const host = byId("analyseCompModalBody");
      if (host) {
        host.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0 0 8px 0;">Erreur : ${escapeHtml(errMsg(e))}</div>
            <div class="card-sub" style="margin:0;">Impossible de charger le détail.</div>
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
  // Cache pour re-render sans refetch
  _analysePosteLastData = data || null;

  // IMPORTANT : si le slot existe, on remplit le slot.
  // On ne doit JAMAIS réécrire tout le tab, sinon tu écrases le diagnostic (et tu retombes à 0%).
  const slot = byId("analysePosteDiagCartoSlot");

  // Le bloc "Cartographie détaillée" est supprimé : on ne rend rien.
  // IMPORTANT : on ne doit JAMAIS écrire dans #analysePosteTabCompetences ici,
  // sinon on écrase le diagnostic (anneau %).
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

    // Si l’API ne renvoie pas les porteurs => on ne sait pas qualifier, on approx sur total
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
        background:#fff; color:#374151; font-weight:900; font-size:12px; white-space:nowrap;">
        ${escapeHtml(txt || "—")}
      </span>
    `;
  }

  function pillReco(rec) {
    const r = (rec || "").toString().toLowerCase();
    let label = "—";
    if (r === "former") label = "Former";
    else if (r === "mutualiser") label = "Mutualiser";
    else if (r === "recruter") label = "Recruter";

    return `
      <span style="
        display:inline-flex; align-items:center; justify-content:center;
        padding:4px 10px; border-radius:999px; border:1px solid #d1d5db;
        background:var(--chip-bg, #f3f4f6); color:#111827; font-weight:900; font-size:12px; white-space:nowrap;">
        ${escapeHtml(label)}
      </span>
    `;
  }

  // 1) Liste compétences critiques enrichie
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

  // 2) Par défaut: on affiche les RISQUES (bus factor <= 1) sauf si toggle “toutes”
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
    host.innerHTML = `<div class="card-sub" style="margin-top:10px;">Aucune compétence à afficher.</div>`;
    return;
  }

  // 3) Rendu: uniquement la cartographie (dans le slot si présent)
  host.innerHTML = `
    <div class="table-wrap" style="margin-top:10px;">
      <table class="sb-table">
        <thead>
          <tr>
            <th style="width:90px;">Code</th>
            <th>Compétence</th>
            <th class="col-center" style="width:110px;">Niv. requis</th>
            <th class="col-center" style="width:90px;">Criticité</th>
            <th class="col-center" style="width:120px;">Porteurs</th>
            <th class="col-center" style="width:140px;">Au niv. requis</th>
            <th class="col-center" style="width:140px;">Point à sécuriser</th>
          </tr>
        </thead>
        <tbody>
          ${detailList.map(c => {
            const code = escapeHtml(c.code || "—");
            const intit = escapeHtml(c.intitule || "—");
            const nr = nsLevelBadgeHtml(c.niveau_requis || "—", "Niveau requis");
            const crit = (c.poids_criticite === null || c.poids_criticite === undefined) ? "—" : escapeHtml(String(c.poids_criticite));
            const tot = Number(c._nb_total || 0);
            const ok = Number(c._nb_ok || 0);

            return `
              <tr>
                <td style="font-weight:800; white-space:nowrap;">${code}</td>
                <td style="min-width:280px;">
                  <div style="font-size:14px; font-weight:700;">${intit}</div>
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
    if (k === "critiques-sans-porteur") return "Compétences critiques non couvertes";
    if (k === "porteur-unique") return "Compétences critiques à couverture unique";
    if (k === "total-fragiles") return "Fragilités (bus factor ≤ 1)";
    return "";
  }

  // Reset état modal
  _analysePosteFocusKey = focus;
  _analysePosteShowAllCompetences = false;
  _analysePosteLastData = null;

  // Lazy-load détail (endpoint lourd) : pas chargé à l’ouverture
  _analysePosteLastParams = { id_poste: id_poste, id_service: id_service || "" };
  _analysePosteDetailLoaded = false;
  _analysePosteDetailLoading = false;

  openAnalysePosteModal(
    "Détail poste",
    `<div class="card-sub" style="margin:0;">Chargement du diagnostic…</div>`
  );

  // Init contenu (Compétences)
  const tabA = byId("analysePosteTabCompetences");
  if (tabA) tabA.innerHTML = `<div class="card" style="padding:12px; margin:0;"><div class="card-sub" style="margin:0;">Chargement…</div></div>`;

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

    // Rendu diagnostic immédiat (affichage rapide)
    renderAnalysePosteDiagnosticOnly(diag, focus);

    // Chargement AUTO du détail (endpoint lourd) pour afficher la cartographie + causes racines dès l’ouverture
    if (!_analysePosteDetailLoaded && !_analysePosteDetailLoading) {
      _analysePosteDetailLoading = true;

      try {
        const data = await fetchAnalysePosteDetail(portal, id_poste, id_service);

        // Si une autre requête a pris la main entre temps, on n’écrase rien
        if (mySeq !== _posteDiagReqSeq) return;

        _analysePosteLastData = data;
        _analysePosteDetailLoaded = true;
        _analysePosteDetailLoading = false;

        // Affiche la vue “Compétences” (inclut Causes racines)
        renderAnalysePosteCompetencesTab(data);

      } catch (err) {
        _analysePosteDetailLoading = false;
        if (typeof showToast === "function") showToast("Erreur chargement cartographie poste.", "error");
        else console.error(err);
        // On reste sur le diagnostic-only déjà affiché
      }
    }


  } catch (e) {
    if (mySeq !== _posteDiagReqSeq) return;

    openAnalysePosteModal(
      "Détail poste",
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
  if (!Number.isFinite(v)) return "—";
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
    throw new Error("Contexte portail indisponible pour la projection à 3 mois.");
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
    if (title) {
      title.textContent = "Correspondances profils/postes";
      title.style.marginBottom = "0";
    }
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
    if (title) {
      title.textContent = `Impact prévisionnel sur ${horizonLabel}`;
      title.style.marginBottom = "0";
    }
    if (sub) {
      sub.textContent = "";
      sub.innerHTML = "";
      sub.style.display = "none";
    }
    if (meta) {
      meta.textContent = "";
      meta.innerHTML = "";
      meta.style.display = "none";
    }

    const item = _prevData ? pickPrevHorizonItem(_prevData, horizon) : null;

    const sorties = item ? item.sorties : (_prevData ? _prevData.sorties_12m : "—");
    const selectedKpi = (localStorage.getItem("sb_analyse_prev_kpi") || "").trim();

    if (typeof setActivePrevKpi === "function") setActivePrevKpi(selectedKpi || "");
    renderPrevisionsHeaderActions(selectedKpi, 0);

    if (selectedKpi === "sorties") {
      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div id="prevSortiesDetailBox">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>
      `;

      window.__sbPrevSortiesReqId = (window.__sbPrevSortiesReqId || 0) + 1;
      const reqId = window.__sbPrevSortiesReqId;

      setTimeout(async () => {
        const box = byId("prevSortiesDetailBox");
        if (!box) return;

        try {
          const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");


          if (!_portalref) {
            box.textContent = "Contexte portail indisponible (_portalref manquant).";
            return;
          }

          box.textContent = "Chargement…";
          const data = await fetchPrevisionsSortiesDetail(_portalref, horizon, id_service, 2000);

          if ((window.__sbPrevSortiesReqId || 0) !== reqId) return;

          const items =
            (data && Array.isArray(data.items) ? data.items : null) ||
            (data && Array.isArray(data.effectifs) ? data.effectifs : null) ||
            [];

          renderPrevisionsHeaderActions(selectedKpi, items.length);
          if (!items.length) {
            box.textContent = "Aucune sortie détectée dans la période sélectionnée.";
            return;
          }

          const itemsToRender = items.slice(0, getPrevisionDetailLimit(selectedKpi));
          const rowsHtml = itemsToRender.map((it) => {
            const prenom = (it.prenom_effectif || it.prenom || "").trim();
            const nom = (it.nom_effectif || it.nom || "").trim();
            const full = (it.full || `${prenom} ${nom}`.trim() || "—");
            const fullHtml = `<span style="font-weight:700;">${escapeHtml(full)}</span>`;

            function fmtDateFR(v) {
              const s = (v || "").toString().trim();
              if (!s) return "—";
              const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
              if (!m) return escapeHtml(s);
              return `${m[3]}-${m[2]}-${m[1]}`;
            }

            const exitDate = (it.exit_date || it.date_sortie || it.date_sortie_prevue || it.sortie_prevue || "").toString();
            const exitTxt = fmtDateFR(exitDate);

            const service = (it.nom_service || it.service || "").toString().trim() || "—";
            const posteTitle = (it.intitule_poste || it.poste || "").toString().trim() || "—";

            // Badge code poste : codif_client si existant sinon codif_poste
            const codifClient = (it.codif_client || "").toString().trim();
            const codifPoste = (it.codif_poste || "").toString().trim();
            const posteCode = codifClient || codifPoste;

            const posteHtml = posteCode
              ? `
                <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                  <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(posteCode)}</span>
                  <span style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(posteTitle)}</span>
                </div>
              `
              : escapeHtml(posteTitle);

            // Raison (priorité: API si dispo)
            const hdf = (it.havedatefin === true || it.havedatefin === "true" || it.havedatefin === 1);
            const motif = (it.motif_sortie || "").toString().trim();
            const reason = (it.raison_sortie || "").toString().trim()
              || (exitDate ? (motif || (hdf ? "Fin de contrat / sortie prévue" : "Sortie prévue")) : "Retraite estimée");
            const reasonTxt = reason ? escapeHtml(reason) : "—";

            const idEff = (it.id_effectif || "").toString().trim();
            const idPoste = (it.id_poste_actuel || "").toString().trim();

            return `
              <tr class="prev-sortie-row sb-row-click"
                  data-id_effectif="${escapeHtml(idEff)}"
                  data-id_poste_actuel="${escapeHtml(idPoste)}"
                  data-exit_date="${escapeHtml(exitDate)}"
                  data-reason="${escapeHtml(reason)}">
                <td>${fullHtml}</td>
                <td>${exitTxt}</td>
                <td>${posteHtml}</td>
                <td>${escapeHtml(service)}</td>
                <td>${reasonTxt}</td>
              </tr>
            `;
          }).join("");

          box.innerHTML = `
            <div style="overflow:auto;">
              <table class="sb-table">
                <thead>
                  <tr>
                    <th>Effectif sortant</th>
                    <th style="line-height:1.05;">Date de sortie<br>prévue</th>
                    <th>Poste</th>
                    <th>Service</th>
                    <th>Raison de la sortie</th>
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
      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div id="prevCritDetailBox" class="card-sub" style="margin:0;">Chargement…</div>
        </div>
      `;

      window.__sbPrevCritReqId = (window.__sbPrevCritReqId || 0) + 1;
      const reqId = window.__sbPrevCritReqId;

      setTimeout(async () => {
        const box = byId("prevCritDetailBox");
        if (!box) return;

        try {
          const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
          if (!_portalref) {
            box.textContent = "Contexte portail indisponible (_portalref manquant).";
            return;
          }

          box.textContent = "Chargement…";
          const data = await fetchPrevisionsCritiquesDetail(_portalref, horizon, id_service, 2000);

          if ((window.__sbPrevCritReqId || 0) !== reqId) return;

          // badge crit min up-to-date
          syncCriticiteMinFromResponse(data);
          const items = Array.isArray(data?.items) ? data.items : [];
          renderPrevisionsHeaderActions(selectedKpi, items.length);
          if (!items.length) {
            box.textContent = "Aucune compétence impactée dans la période sélectionnée.";
            return;
          }

          const itemsToRender = items.slice(0, getPrevisionDetailLimit(selectedKpi));
          box.innerHTML = renderPrevisionTableCompetences(itemsToRender);

        } catch (e) {
          if ((window.__sbPrevCritReqId || 0) !== reqId) return;
          box.textContent = `Erreur chargement hausse fragilité compétences: ${e?.message || e}`;
        }
      }, 0);

      return;
    }

    if (selectedKpi === "postes-rouges") {
      body.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div id="prevPostesRedDetailBox" class="card-sub" style="margin:0;">Chargement…</div>
        </div>
      `;

      window.__sbPrevPostesRedReqId = (window.__sbPrevPostesRedReqId || 0) + 1;
      const reqId = window.__sbPrevPostesRedReqId;

      setTimeout(async () => {
        const box = byId("prevPostesRedDetailBox");
        if (!box) return;

        try {
          const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");

          if (!_portalref) {
            box.textContent = "Contexte portail indisponible (_portalref manquant).";
            return;
          }

          box.textContent = "Chargement…";
          const data = await fetchPrevisionsPostesRougesDetail(_portalref, horizon, id_service, 2000);

          if ((window.__sbPrevPostesRedReqId || 0) !== reqId) return;

          syncCriticiteMinFromResponse(data);

          const items = Array.isArray(data?.items) ? data.items : [];
          renderPrevisionsHeaderActions(selectedKpi, items.length);
          if (!items.length) {
            box.textContent = "Aucun poste impacté dans la période sélectionnée.";
            return;
          }

          const itemsToRender = items.slice(0, getPrevisionDetailLimit(selectedKpi));
          box.innerHTML = renderPrevisionTablePostes(itemsToRender);

        } catch (e) {
          if ((window.__sbPrevPostesRedReqId || 0) !== reqId) return;
          box.textContent = `Erreur chargement hausse fragilité postes: ${e?.message || e}`;
        }
      }, 0);

      return;
    }


    renderPrevisionsHeaderActions("", 0);
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
    body.innerHTML = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Résultats</div>
        <div class="card-sub" style="margin:0;">Aucune vue sélectionnée.</div>
      </div>
    `;
    return;
  }

  const rf = getRiskFilter(); // "", "postes-scope", "critiques-fragiles", "evol-3m"
  if (typeof setActiveRiskKpi === "function") setActiveRiskKpi(rf);

  if (title) title.textContent = "Risques actuels";
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
    filterLabel = "Fragilité des postes";
  } else if (rf === "critiques-fragiles") {
    filterLabel = "Fragilités par compétence";
  } else if (rf === "evol-3m") {
    filterLabel = "Évolution des indices de fragilités à 3 mois";
  }


  const selSvc = byId("analyseServiceSelect") || byId("anaServiceSelect") || byId("mapServiceSelect");
  const id_service = window.portal.serviceFilter.toQueryId(selSvc?.value || "");


  function badge(txt, accent) {
    const cls = accent ? "sb-badge sb-badge-accent" : "sb-badge";
    return `<span class="${cls}">${escapeHtml(txt || "—")}</span>`;
  }

  function renderDomainPill(item) {
    const lab = (item?.domaine_titre_court || item?.domaine_titre || item?.id_domaine_competence || "—").toString();
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
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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
          <div style="min-width:44px; text-align:right; font-weight:800;">
            ${s}<span style="font-weight:700; font-size:12px;">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Élevé";
      if (s >= 25) return "Modéré";
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
          font-weight:800; font-size:12px; white-space:nowrap;
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
                  <span>Indice<br>de fragilité</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilité">i</span>
                </span>
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height:1.1;">
                État
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const intitule = (r.intitule_poste || "").trim() || "—";
              const codifClient = (r.codif_client || "").trim();
              const codifPoste  = (r.codif_poste || "").trim();
              const codeAffiche = (codifClient !== "") ? codifClient : codifPoste;
              const svc = (r.nom_service || "").trim() || "—";

              const isNonAnalyse = !!r.is_non_analyse;
              const isSansTitulaire = !isNonAnalyse && Number(r.nb_titulaires || 0) <= 0 && Number(r.nb_titulaires_cible || 1) >= 1;
              const scoreTitle = isNonAnalyse
                ? "Aucune compétence attendue exploitable n’est rattachée au poste"
                : (isSansTitulaire ? "Poste actif sans titulaire : fragilité 100%" : "Indice de fragilité du poste");
              const score = clamp(Number(r.indice_fragilite || 0), 0, 100);
              const etat = isNonAnalyse ? "Non analysé" : stateLabel(score);
              const idPoste = (r.id_poste || "").toString().trim();

              return `
                <tr class="risk-poste-row" data-id_poste="${escapeHtml(idPoste)}">
                  <td class="risk-poste-open" style="cursor:pointer;">
                    <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                      <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(codeAffiche || "—")}</span>
                      <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intitule)}
                      </span>
                    </div>
                  </td>
                  <td>${escapeHtml(svc)}</td>

                  <td class="col-center" title="${escapeHtml(scoreTitle)}">
                    ${isNonAnalyse ? '<span class="sb-badge">Non analysé</span>' : scoreChip(score)}
                  </td>

                  <td class="col-center">${isNonAnalyse ? '<span class="sb-badge">Non analysé</span>' : statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn risk-poste-open"
                              title="Voir"
                              aria-label="Voir l’analyse du poste">
                        ${analyseEyeIconSvg()}
                      </button>
                      <button type="button"
                              class="sb-icon-btn sb-icon-btn--doc"
                              data-risk-poste-pdf="${escapeHtml(idPoste)}"
                              title="PDF"
                              aria-label="Exporter l’analyse du poste en PDF">
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
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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
          <div style="min-width:44px; text-align:right; font-weight:800;">
            ${s}<span style="font-weight:700; font-size:12px;">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Élevé";
      if (s >= 25) return "Modéré";
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
          font-weight:800; font-size:12px; white-space:nowrap;
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
              <th>Code – Compétence</th>
              <th class="col-center" style="width:220px;">Domaine</th>

              <th class="col-center" style="width:220px;">
                <span class="sb-th-with-tip">
                  <span>Indice<br>de fragilité</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index-competence"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilité compétence">i</span>
                </span>
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height:1.1;">
                État
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = (r.code || "—").toString().trim();
              const intit = (r.intitule || "—").toString();
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
                      <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code || "—")}</span>
                      <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intit)}
                      </span>
                    </div>
                  </td>

                  <td style="text-align:left;">${renderDomainPill(r)}</td>

                  <td class="col-center" title="Indice de fragilité de la compétence">${scoreChip(score)}</td>

                  <td class="col-center">${statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn risk-comp-open"
                              title="Voir"
                              aria-label="Voir l’analyse de la compétence">
                        ${analyseEyeIconSvg()}
                      </button>
                      <button type="button"
                              class="sb-icon-btn sb-icon-btn--doc"
                              data-risk-comp-pdf="${escapeHtml(compKey)}"
                              title="PDF"
                              aria-label="Exporter l’analyse de la compétence en PDF">
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
      return `<span class="sb-badge" title="Aucune évolution détectée">0%</span>`;
    }
    const mod = d > 0 ? "sb-badge--danger" : "sb-badge--success";
    const txt = `${d > 0 ? "+" : ""}${d}%`;
    return `<span class="sb-badge ${mod}" title="Évolution depuis la situation actuelle">${escapeHtml(txt)}</span>`;
  }

  function renderPrevisionTablePostes(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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
          <div style="min-width:44px; text-align:right; font-weight:800;">
            ${s}<span style="font-weight:700; font-size:12px;">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Élevé";
      if (s >= 25) return "Modéré";
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
          font-weight:800; font-size:12px; white-space:nowrap;
        ">
          ${escapeHtml(label)}
        </span>
      `;
    }

    return `
      <div class="table-wrap sb-tip-host" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevPostesImpactes">
          <thead>
            <tr>
              <th>Poste</th>
              <th style="width:180px;">Service</th>

              <th class="col-center" style="width:220px;">
                <span class="sb-th-with-tip">
                  <span>Indice<br>de fragilité</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilité">i</span>
                </span>
              </th>

              <th class="col-center" style="width:120px; white-space:normal; line-height:1.1;">
                Évolution
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height:1.1;">
                État
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const intitule = (r.intitule_poste || "").trim() || "—";
              const codifClient = (r.codif_client || "").trim();
              const codifPoste  = (r.codif_poste || "").trim();
              const codeAffiche = codifClient !== "" ? codifClient : codifPoste;
              const svc = (r.nom_service || "").trim() || "—";
              const score = clamp(Number(r.indice_fragilite_horizon ?? r.indice_fragilite ?? 0), 0, 100);
              const delta = Number(r.delta_fragilite ?? 0);
              const etat = stateLabel(score);
              const idPoste = (r.id_poste || "").toString().trim();

              return `
                <tr class="prev-red-poste-row"
                    data-id_poste="${escapeHtml(idPoste)}"
                    data-intitule_poste="${escapeHtml(intitule)}"
                    data-nom_service="${escapeHtml(svc)}"
                    data-indice_fragilite_horizon="${escapeHtml(String(score))}"
                    data-delta_fragilite="${escapeHtml(String(delta))}"
                    data-next_exit_date="${escapeHtml((r.last_exit_date || r.next_exit_date || "").toString())}">
                  <td class="prev-red-open" style="cursor:pointer;">
                    <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                      <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(codeAffiche || "—")}</span>
                      <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intitule)}
                      </span>
                    </div>
                  </td>
                  <td>${escapeHtml(svc)}</td>

                  <td class="col-center" title="Indice de fragilité projeté du poste">
                    ${scoreChip(score)}
                  </td>

                  <td class="col-center" title="Évolution depuis la situation actuelle">
                    ${previsionDeltaBadge(delta)}
                  </td>

                  <td class="col-center">${statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn prev-red-open"
                              title="Voir"
                              aria-label="Voir l’analyse du poste">
                        ${analyseEyeIconSvg()}
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

  function renderPrevisionTableCompetences(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return `<div class="card-sub" style="margin:0;">Aucun résultat.</div>`;

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
          <div style="min-width:44px; text-align:right; font-weight:800;">
            ${s}<span style="font-weight:700; font-size:12px;">%</span>
          </div>
        </div>
      `;
    }

    function stateLabel(score) {
      const s = clamp(Number(score || 0), 0, 100);
      if (s >= 75) return "Critique";
      if (s >= 50) return "Élevé";
      if (s >= 25) return "Modéré";
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
          font-weight:800; font-size:12px; white-space:nowrap;
        ">
          ${escapeHtml(label)}
        </span>
      `;
    }

    return `
      <div class="table-wrap sb-tip-host" style="margin-top:10px;">
        <table class="sb-table" id="tblPrevCompImpact">
          <thead>
            <tr>
              <th>Code – Compétence</th>
              <th class="col-center" style="width:220px;">Domaine</th>

              <th class="col-center" style="width:220px;">
                <span class="sb-th-with-tip">
                  <span>Indice<br>de fragilité</span>
                  <span class="sb-iinfo"
                        data-sbtip="fragility-index-competence"
                        tabindex="0"
                        role="button"
                        aria-label="Informations sur l'indice de fragilité compétence">i</span>
                </span>
              </th>

              <th class="col-center" style="width:120px; white-space:normal; line-height:1.1;">
                Évolution
              </th>

              <th class="col-center" style="width:110px; white-space:normal; line-height:1.1;">
                État
              </th>

              <th class="col-center" style="width:92px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const code = (r.code || "—").toString().trim();
              const intit = (r.intitule || r.intitule_competence || "—").toString();
              const idComp = (r.id_competence || r.id_comp || r.id_competence_skillboard || r.id_competence_pk || "").toString().trim();
              const compKey = (idComp || code || "").trim();
              const score = clamp(Number(r.indice_fragilite_horizon ?? r.indice_fragilite ?? 0), 0, 100);
              const delta = Number(r.delta_fragilite ?? 0);
              const etat = stateLabel(score);

              return `
                <tr class="prev-crit-row"
                    data-comp-key="${escapeHtml(compKey)}"
                    data-code="${escapeHtml(code)}"
                    data-id_comp="${escapeHtml(idComp)}">

                  <td class="prev-crit-open" style="cursor:pointer;">
                    <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                      <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code || "—")}</span>
                      <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(intit)}
                      </span>
                    </div>
                  </td>

                  <td style="text-align:left;">${renderDomainPill(r)}</td>

                  <td class="col-center" title="Indice de fragilité projeté de la compétence">${scoreChip(score)}</td>

                  <td class="col-center" title="Évolution depuis la situation actuelle">${previsionDeltaBadge(delta)}</td>

                  <td class="col-center">${statePill(etat, score)}</td>

                  <td class="col-center">
                    <div class="sb-icon-actions" style="justify-content:center;">
                      <button type="button"
                              class="sb-icon-btn prev-crit-open"
                              title="Voir"
                              aria-label="Voir l’analyse de la compétence">
                        ${analyseEyeIconSvg()}
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
      <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" id="btnRiskDetailPrint">
        Imprimer
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
      <div class="card-sub" style="margin:0;">Chargement…</div>
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
        const nowPoint = timeline[0] || { label: "Aujourd’hui", indice_fragilite: 0 };
        const nowScore = Math.round(Number(nowPoint?.indice_fragilite || 0));

        const fmtIndex = (v) => `${Math.round(Number(v) || 0)}%`;
        const eyeIcon = `
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
        const evolBadge = (delta, isToday) => {
          if (isToday) return `<span style="font-weight:700; color:var(--sb-gray-500);">—</span>`;
          const d = Math.round(Number(delta) || 0);
          const cls = d > 0 ? "sb-badge--danger" : (d < 0 ? "sb-badge--success" : "");
          const txt = d === 0 ? "Stable" : `${d > 0 ? "+" : ""}${d}%`;
          return `<span class="sb-badge ${cls}">${escapeHtml(txt)}</span>`;
        };

        const rows = [0, 1, 2, 3].map((idx) => {
          const p = timeline[idx] || null;
          const m = monthMap.get(idx) || { index: idx, label: idx === 0 ? "Aujourd’hui" : `${idx} mois`, indisponibilites_count: 0, sorties_count: 0, indisponibilites: [], sorties: [] };
          const label = idx === 0 ? "Aujourd’hui" : (p?.label || m.label || `${idx} mois`);
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
              <div class="card-title" style="margin:0;">${escapeHtml(filterLabel)}</div>
              <button type="button"
                      class="analyse-help-dot"
                      data-analyse-help="risques_evol3m_table"
                      aria-label="Comprendre l’évolution des indices de fragilité">?</button>
            </div>
            <div class="table-wrap" style="margin-top:0;">
              <table class="sb-table" id="tblRiskEvol3m">
                <thead>
                  <tr>
                    <th>Mois de projection</th>
                    <th class="col-center">Indice de fragilité</th>
                    <th class="col-center">Évolution</th>
                    <th class="col-center">Indisponibilités temporaires</th>
                    <th class="col-center">Fins de contrat / sorties prévues</th>
                    <th class="col-center">Détail</th>
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
            <div class="card-title" style="margin-bottom:6px;">${escapeHtml(filterLabel)}</div>
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
          <div class="card-title" style="margin-bottom:6px;">Fragilité des postes</div>
          ${renderTablePostes(itemsA)}
        </div>

        <div class="card" style="padding:12px; margin-top:12px;">
          <div class="card-title" style="margin-bottom:6px;">Fragilités par compétence</div>
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
      const compFragTxt = Number.isFinite(compFrag) ? `${Math.round(compFrag)}%` : (Number.isFinite(Number(r.comp_critiques_fragiles)) ? `${Number(r.comp_critiques_fragiles)} point(s)` : "—");
      const globalFragTxt = Number.isFinite(globalFrag) ? `${Math.round(globalFrag)}%` : "—";
      setText("kpiRiskPostes", globalFragTxt);
      setText("kpiRiskCritFragiles", compFragTxt);
      updateAnalyseHeaderSynthesis(data);

      const alertN = Number(r.comp_critiques_tombent_zero_auj || 0);
      const alertEl = byId("kpiRiskCritAlert");
      if (alertEl) {
        if (Number.isFinite(alertN) && alertN > 0) {
          alertEl.textContent = `+${alertN} tombent à 0 aujourd’hui`;
          alertEl.style.display = "inline-flex";
        } else {
          alertEl.textContent = "";
          alertEl.style.display = "none";
        }
      }

      setText("kpiRiskEvol3m", "…");
      (async () => {
        try {
          const evo = await computeRiskEvolution3m(portal, f.id_service);
          const evoTxt = fmtPctSigned(evo?.total?.pct);
          setText("kpiRiskEvol3m", evoTxt);
        } catch (e) {
          setText("kpiRiskEvol3m", "—");
        }
      })();

      const p = t.previsions || {};
      applyPrevisionsKpis(p);

      setStatus("");
    } catch (e) {
      setStatus("Résumé non disponible.");
    }
  }

  function setMode(mode) {
    const m = (mode || "").trim().toLowerCase();
    const finalMode = (m === "matching" || m === "previsions" || m === "risques") ? m : "risques";

    localStorage.setItem(STORE_MODE, finalMode);

    setActiveTile(finalMode);
    setText("analyseModeLabel", finalMode === "matching" ? "Correspondance profils / postes" : (finalMode === "previsions" ? "Prévisions" : "Risques actuels"));
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
    if (typeof updateCriticiteMinUi === "function") {
    updateCriticiteMinUi();
    }
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

    return await analyseApiJson(portal, url);
  }


  async function showAnalysePrevCritModal(portal, compKey, id_service) {
    openAnalysePrevCritModal();
    setAnalysePrevCritTab("synthese");

    const horizon = getPrevHorizon();
    const horizonTxt = analyseHorizonLabel(horizon);
    const scope = getScopeLabel();

    const title = byId("analysePrevCritModalTitle");
    const sub = byId("analysePrevCritModalSub");
    const bSvc = byId("analysePrevCritBadgeService");
    const bHor = byId("analysePrevCritBadgeHorizon");
    const bCrit = byId("analysePrevCritBadgeCriticite");

    const kNow = byId("prevCritKpiNow");
    const kOut = byId("prevCritKpiOut");
    const kRemain = byId("prevCritKpiRemain");
    const kPostes = byId("prevCritKpiPostes");
    const kNext = byId("prevCritKpiNextExit");

    const paneSynth = byId("analysePrevCritTabSynthese");
    const paneRest = byId("analysePrevCritTabRestants");
    const paneOut = byId("analysePrevCritTabSortants");
    const panePostes = byId("analysePrevCritTabPostes");

    if (title) title.textContent = "Détail compétence";
    if (sub) sub.textContent = "Chargement…";
    if (bSvc) bSvc.textContent = `Service : ${scope || "—"}`;
    if (bHor) bHor.textContent = `Horizon : ${horizonTxt}`;
    if (bCrit) bCrit.textContent = `Criticité : —`;
    [kNow, kOut, kRemain, kPostes, kNext].forEach(el => { if (el) el.textContent = "—"; });
    renderLevelBar(0, 0, 0);
    if (paneSynth) paneSynth.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    if (paneRest) paneRest.innerHTML = "";
    if (paneOut) paneOut.innerHTML = "";
    if (panePostes) panePostes.innerHTML = "";

    window.__sbPrevCritModalReqId = (window.__sbPrevCritModalReqId || 0) + 1;
    const reqId = window.__sbPrevCritModalReqId;

    try {
      const data = await fetchPrevisionsCritiquesModal(portal, compKey, horizon, id_service);
      if ((window.__sbPrevCritModalReqId || 0) !== reqId) return;

      const comp = data?.competence || data?.comp || {};
      const code = (comp.code || comp.code_competence || "").toString().trim();
      const intit = (comp.intitule || comp.intitule_competence || comp.libelle || "Compétence").toString().trim();
      const domPill = safeDomainPill(comp);
      const kpis = data?.kpis || {};

      const now = Number(kpis.nb_now ?? 0);
      const out = Number(kpis.nb_out ?? 0);
      const remain = Number(kpis.nb_remain ?? Math.max(now - out, 0));
      const postesImpact = Number(kpis.nb_postes ?? 0);
      const nextExit = (kpis.next_exit_date || "").toString().trim();
      const criticite = Number(data?.criticite_max ?? data?.max_criticite ?? comp?.max_criticite ?? 0) || 0;

      window.__sbPrevCritHypothesis = {
        type: "securiser_competence_prevision",
        title: `Anticiper la compétence ${code ? code + " · " : ""}${intit}`,
        competence_id: String(comp.id_comp || comp.id_competence || comp.id || compKey || "").trim(),
        competence_code: code,
        competence_label: intit,
        scope_label: scope,
        cause: "Fragilité prévisionnelle à horizon",
        effet: "Tester une hypothèse de couverture ou de transmission avant que la compétence ne devienne insuffisamment couverte.",
        horizon: horizonTxt,
        criticite: criticite
      };

      if (title) title.textContent = `${code ? code + " — " : ""}${intit}`;
      if (sub) sub.textContent = `Impact prévisionnel à horizon ${horizonTxt}`;
      if (bCrit) bCrit.textContent = `Criticité : ${criticite || "—"}`;
      if (kNow) kNow.textContent = String(now);
      if (kOut) kOut.textContent = String(out);
      if (kRemain) kRemain.textContent = String(remain);
      if (kPostes) kPostes.textContent = String(postesImpact);
      if (kNext) kNext.textContent = nextExit ? fmtDateFR(nextExit) : "—";

      const a = Number(kpis.remain_a ?? 0);
      const b = Number(kpis.remain_b ?? 0);
      const c = Number(kpis.remain_c ?? 0);
      renderLevelBar(a, b, c);

      const restants = Array.isArray(data?.restants) ? data.restants : (Array.isArray(data?.porteurs_restants) ? data.porteurs_restants : []);
      const sortants = Array.isArray(data?.sortants) ? data.sortants : (Array.isArray(data?.porteurs_sortants) ? data.porteurs_sortants : []);
      const postes = Array.isArray(data?.postes) ? data.postes : (Array.isArray(data?.postes_impactes) ? data.postes_impactes : []);

      function rhReading() {
        if (out > 0 && remain <= 0) return "Risque de rupture : les porteurs identifiés sortent du périmètre et aucun relais suffisant n’est confirmé à la période sélectionnée.";
        if (out > 0 && remain === 1) return "Dépendance forte : la compétence resterait couverte par une seule personne. Une transmission ou une montée en compétence doit être organisée.";
        if (out > 0) return "La compétence est exposée par une ou plusieurs sorties prévues. Le relais existe, mais la capacité doit être confirmée.";
        return "Aucune sortie directe de porteur n’est identifiée, mais cette compétence reste à surveiller sur les postes concernés.";
      }

      function peopleRows(rows, mode) {
        if (!rows.length) return `<div class="sb-prev-empty">Aucune personne retournée sur ce périmètre.</div>`;
        return `
          <div class="sb-prev-table-wrap">
            <table class="sb-table sb-table--airy sb-prev-table">
              <thead><tr><th>Personne</th><th class="col-center">Niveau</th><th>Poste</th><th>Service</th>${mode === "out" ? "<th>Date sortie</th><th>Motif</th>" : ""}</tr></thead>
              <tbody>${rows.map(r => {
                const full = (r.full || `${(r.prenom || r.prenom_effectif || "").trim()} ${(r.nom || r.nom_effectif || "").trim()}`.trim() || "—");
                const niv = (r.niveau || r.level || r.niv || "—").toString().trim();
                const poste = (r.intitule_poste || r.poste || "—").toString().trim();
                const svc = (r.nom_service || r.service || "—").toString().trim();
                const exit = (r.exit_date || r.date_sortie || r.date_sortie_prevue || "").toString().trim();
                const reason = (r.raison_sortie || r.reason || r.motif_sortie || "—").toString().trim();
                return `<tr><td><strong>${escapeHtml(full)}</strong></td><td class="col-center"><span class="sb-badge">${escapeHtml(niv)}</span></td><td>${escapeHtml(poste)}</td><td>${escapeHtml(svc)}</td>${mode === "out" ? `<td>${escapeHtml(exit ? fmtDateFR(exit) : "—")}</td><td>${escapeHtml(reason)}</td>` : ""}</tr>`;
              }).join("")}</tbody>
            </table>
          </div>`;
      }

      if (paneSynth) {
        paneSynth.innerHTML = `
          <div class="sb-prev-rh-summary">
            <div class="sb-prev-rh-title">Ce qu’il faut comprendre</div>
            <div class="sb-prev-rh-text">${escapeHtml(rhReading())}</div>
          </div>
          <div class="sb-prev-kpi-grid sb-prev-kpi-grid--4">
            <div class="sb-prev-kpi"><span>Porteurs actuels</span><strong>${escapeHtml(String(now))}</strong></div>
            <div class="sb-prev-kpi"><span>Sortants à horizon</span><strong>${escapeHtml(String(out))}</strong></div>
            <div class="sb-prev-kpi"><span>Relais restants</span><strong>${escapeHtml(String(remain))}</strong></div>
            <div class="sb-prev-kpi"><span>Postes concernés</span><strong>${escapeHtml(String(postesImpact))}</strong></div>
          </div>
          <div class="sb-prev-actions-card">
            <div class="sb-prev-modal-title">Points à sécuriser</div>
            <div class="sb-prev-action-list">
              <div>Confirmer les relais capables de couvrir le niveau attendu.</div>
              <div>Organiser une transmission avant la prochaine sortie prévue${nextExit ? ` (${escapeHtml(fmtDateFR(nextExit))})` : ""}.</div>
              <div>Tester une hypothèse de sécurisation si la couverture restante est insuffisante.</div>
            </div>
          </div>
          <div style="margin-top:10px;">${domPill}</div>
        `;
      }

      if (paneRest) paneRest.innerHTML = peopleRows(restants, "remain");
      if (paneOut) paneOut.innerHTML = peopleRows(sortants, "out");

      if (panePostes) {
        if (!postes.length) {
          panePostes.innerHTML = `<div class="sb-prev-empty">Aucun poste impacté retourné.</div>`;
        } else {
          panePostes.innerHTML = `
            <div class="sb-prev-table-wrap">
              <table class="sb-table sb-table--airy sb-table--hover sb-prev-table">
                <thead><tr><th>Poste concerné</th><th>Service</th><th class="col-center">Niveau attendu</th><th class="col-center">Criticité</th><th>Lecture RH</th></tr></thead>
                <tbody>${postes.map(p => {
                  const poste = (p.intitule_poste || p.poste || "—").toString();
                  const svc = (p.nom_service || p.service || "—").toString();
                  const attendu = (p.niveau_attendu || p.level_expected || p.niveau || "—").toString();
                  const crit = (p.criticite || p.max_criticite || "—").toString();
                  return `<tr><td><strong>${escapeHtml(poste)}</strong></td><td>${escapeHtml(svc)}</td><td class="col-center"><span class="sb-badge">${escapeHtml(attendu)}</span></td><td class="col-center">${escapeHtml(crit)}</td><td>Vérifier le relais opérationnel sur ce poste.</td></tr>`;
                }).join("")}</tbody>
              </table>
            </div>`;
        }
      }
    } catch (e) {
      if ((window.__sbPrevCritModalReqId || 0) !== reqId) return;
      const msg = `Impossible de charger le détail compétence : ${e?.message || e}`;
      if (sub) sub.textContent = "Erreur de chargement";
      if (paneSynth) paneSynth.innerHTML = `<div class="sb-prev-empty">${escapeHtml(msg)}</div>`;
    }
  }


// =====================================================
// PREVISIONS - MODAL "POSTE ROUGE" (open/close + tabs)
// IDs HTML existants (NE PAS CHANGER):
// - modalAnalysePrevPosteRed
// - btnCloseAnalysePrevPosteRedModal, btnAnalysePrevPosteRedModalClose
// - tabPrevPosteRedSynthese, tabPrevPosteRedCauses, tabPrevPosteRedSortants, tabPrevPosteRedCouverture, tabPrevPosteRedVoisins
// - analysePrevPosteRedTabSynthese, analysePrevPosteRedTabCauses, analysePrevPosteRedTabSortants, analysePrevPosteRedTabCouverture, analysePrevPosteRedTabVoisins
// =====================================================

function openAnalysePrevPosteRedModal() {
  const m = byId("modalAnalysePrevPosteRed");
  if (!m) return;
  m.classList.add("show");
  m.setAttribute("aria-hidden", "false");
}

function closeAnalysePrevPosteRedModal() {
  const m = byId("modalAnalysePrevPosteRed");
  if (!m) return;
  m.classList.remove("show");
  m.setAttribute("aria-hidden", "true");
  if (typeof updateCriticiteMinUi === "function") {
    updateCriticiteMinUi();
  }
}

function setAnalysePrevPosteRedTab(key) {
  const tabs = [
    ["synthese", "tabPrevPosteRedSynthese", "analysePrevPosteRedTabSynthese"],
    ["causes",   "tabPrevPosteRedCauses",   "analysePrevPosteRedTabCauses"],
    ["sortants", "tabPrevPosteRedSortants", "analysePrevPosteRedTabSortants"],
    ["couverture","tabPrevPosteRedCouverture","analysePrevPosteRedTabCouverture"],
    ["voisins",  "tabPrevPosteRedVoisins",  "analysePrevPosteRedTabVoisins"],
  ];

  tabs.forEach(([k, tabId, paneId]) => {
    const t = byId(tabId);
    const p = byId(paneId);
    const on = (k === key);

    if (t) {
      // style simple (cohérent avec tes autres tabs)
      t.classList.toggle("is-active", on);
      t.style.borderColor = on ? "var(--reading-accent)" : "";
      t.style.background = on ? "color-mix(in srgb, var(--reading-accent) 8%, #ffffff)" : "";
      t.style.fontWeight = on ? "700" : "";
    }
    if (p) p.style.display = on ? "" : "none";
  });
}

// Bind une seule fois
(function bindAnalysePrevPosteRedModalOnce() {
  if (window.__sbBoundPrevPosteRedModal) return;
  window.__sbBoundPrevPosteRedModal = true;

  const btnX = byId("btnCloseAnalysePrevPosteRedModal");
  const btnClose = byId("btnAnalysePrevPosteRedModalClose");
  const btnHypoPosteRed = byId("btnAnalysePrevPosteRedCreateHypothesis");

  if (btnX) btnX.addEventListener("click", closeAnalysePrevPosteRedModal);
  if (btnClose) btnClose.addEventListener("click", closeAnalysePrevPosteRedModal);
  if (btnHypoPosteRed) btnHypoPosteRed.addEventListener("click", () => {
    const h = window.__sbPrevPosteRedHypothesis;
    if (!h) return setStatus("Aucune hypothèse disponible pour cette prévision.");
    addAnalyseHypothesis(h);
    closeAnalysePrevPosteRedModal();
  });

  const m = byId("modalAnalysePrevPosteRed");
  if (m) {
    // clic dehors = fermer
    m.addEventListener("click", (ev) => {
      if (ev.target === m) closeAnalysePrevPosteRedModal();
    });

    // ESC = fermer (si tu as déjà un handler global, ça ne gêne pas)
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && m.classList.contains("show")) {
        closeAnalysePrevPosteRedModal();
      }
    });
  }

  const tSyn = byId("tabPrevPosteRedSynthese");
  const tCau = byId("tabPrevPosteRedCauses");
  const tSor = byId("tabPrevPosteRedSortants");
  const tCov = byId("tabPrevPosteRedCouverture");
  const tVoi = byId("tabPrevPosteRedVoisins");

  if (tSyn) tSyn.addEventListener("click", () => setAnalysePrevPosteRedTab("synthese"));
  if (tCau) tCau.addEventListener("click", () => setAnalysePrevPosteRedTab("causes"));
  if (tSor) tSor.addEventListener("click", () => setAnalysePrevPosteRedTab("sortants"));
  if (tCov) tCov.addEventListener("click", () => setAnalysePrevPosteRedTab("couverture"));
  if (tVoi) tVoi.addEventListener("click", () => setAnalysePrevPosteRedTab("voisins"));
})();


function bindOnce(portal) {
  if (_bound) return;
  _bound = true;

  // garde une ref globale (ton code s’appuie dessus partout)
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

      // empêche click sur tuile
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

  // Filtres service / criticité / reset
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

  if (btnReset) {
    btnReset.addEventListener("click", async () => {
      setAnalyseServiceRawValue(window.portal.serviceFilter.ALL_ID || "");
      setCriticiteMinValue(CRITICITE_MIN_DEFAULT, true);
      setRiskFilter("");
      setPostesScopeExpanded(false);
      invalidateAnalyseCaches();
      await refreshSummary(portal);
      renderDetail(localStorage.getItem(STORE_MODE) || "risques");
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
  // Modal Prévisions Critiques - wiring
  // ==============================
  const modalPrevCrit = byId("modalAnalysePrevCrit");
  const btnXPrevCrit = byId("btnCloseAnalysePrevCritModal");
  const btnClosePrevCrit = byId("btnAnalysePrevCritModalClose");

  if (btnXPrevCrit) btnXPrevCrit.addEventListener("click", closeAnalysePrevCritModal);
  if (btnClosePrevCrit) btnClosePrevCrit.addEventListener("click", closeAnalysePrevCritModal);
  const btnHypoPrevCrit = byId("btnAnalysePrevCritCreateHypothesis");
  if (btnHypoPrevCrit) btnHypoPrevCrit.addEventListener("click", () => {
    const h = window.__sbPrevCritHypothesis;
    if (!h) return setStatus("Aucune hypothèse disponible pour cette prévision.");
    addAnalyseHypothesis(h);
    closeAnalysePrevCritModal();
  });

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
        <div class="sb-tip-title">Indice de fragilité</div>
        <div class="sb-tip-text">
          Cet indice mesure le niveau d’exposition d’un poste. Plus il se rapproche de 100 %, plus le poste nécessite une attention rapide.
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Ce qui est pris en compte</div>
          <ul class="sb-tip-list">
            <li>le nombre de personnes rattachées au poste par rapport au besoin attendu ;</li>
            <li>la couverture des compétences nécessaires au poste ;</li>
            <li>le niveau réellement maîtrisé par les personnes disponibles ;</li>
            <li>la dépendance à une seule personne ou l’absence de relais interne ;</li>
            <li>les compétences attendues mais non confirmées ou insuffisamment couvertes.</li>
          </ul>
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Lecture de l’état</div>
          <div class="sb-tip-scale"><b>0 à 24 %</b> : faible</div>
          <div class="sb-tip-scale"><b>25 à 49 %</b> : modéré</div>
          <div class="sb-tip-scale"><b>50 à 74 %</b> : élevé</div>
          <div class="sb-tip-scale"><b>75 à 100 %</b> : critique</div>
        </div>

        <div class="sb-tip-note">
          Un poste actif sans titulaire est considéré comme fragile à 100 %, car aucune personne ne le couvre dans l’organisation actuelle.
        </div>
      `;
    }

    if (key === "fragility-index-competence") {
      return `
        <div class="sb-tip-title">Indice de fragilité</div>
        <div class="sb-tip-text">
          Cet indice indique dans quelle mesure une compétence est sécurisée dans l’entreprise. Il ne mesure pas seulement si la compétence existe quelque part : il regarde si elle est assez maîtrisée, assez diffusée et transmissible.
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Ce qui est pris en compte</div>
          <ul class="sb-tip-list">
            <li>la maîtrise réelle de la compétence par les collaborateurs disponibles ;</li>
            <li>le nombre de personnes capables de porter cette compétence au niveau attendu ;</li>
            <li>la concentration de la compétence sur une ou quelques personnes ;</li>
            <li>la présence ou non de collaborateurs experts capables de transmettre le savoir-faire ;</li>
            <li>les indisponibilités, fins de contrat ou sorties prévues qui peuvent retirer des porteurs ;</li>
            <li>la fiabilité des données disponibles : niveaux confirmés, évaluations, informations manquantes.</li>
          </ul>
        </div>

        <div class="sb-tip-block">
          <div class="sb-tip-block-title">Lecture de l’état</div>
          <div class="sb-tip-scale"><b>0 à 24 %</b> : faible</div>
          <div class="sb-tip-scale"><b>25 à 49 %</b> : modéré</div>
          <div class="sb-tip-scale"><b>50 à 74 %</b> : élevé</div>
          <div class="sb-tip-scale"><b>75 à 100 %</b> : critique</div>
        </div>

        <div class="sb-tip-note">
          Une compétence peut être fragile même si elle est présente dans l’entreprise, par exemple si elle repose sur une seule personne ou si personne n’est capable de la transmettre.
        </div>
      `;
    }
    return `<div class="sb-tip-title">Info</div><div class="sb-tip-text">Aucune aide définie.</div>`;
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

    // position par défaut: sous le bouton
    let left = r.left;
    let top = r.bottom + gap;

    // clamp horizontal
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));

    // si ça déborde en bas, on ouvre au-dessus
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

    // toggle si on reclique le même "i"
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
  // Click délégué global (survit aux rerender)
  // ==============================
  const analyseBody = byId("analyseDetailBody");
  if (!analyseBody) {
    // si la vue n’est pas encore montée, on ne fige pas le bind
    _bound = false;
    return;
  }

  analyseBody.addEventListener("click", async (ev) => {
    // ------------------------------
    // Tooltip "i" (Indice de fragilité) : portail hors table
    // ------------------------------
    const infoBtn = ev.target.closest(".sb-iinfo");
    if (infoBtn) {
      ev.preventDefault();
      ev.stopPropagation();

      // sécurité: si l'attribut n'existe pas encore, on le force
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
    // -> ouverture uniquement si clic sur libellé poste OU bouton Voir
    // ------------------------------
    const trPoste = ev.target.closest("tr.risk-poste-row[data-id_poste]");
    if (trPoste) {
      // On évite d’ouvrir le modal sur n’importe quel clic dans la ligne
      const hit = ev.target.closest(".risk-poste-open");
      if (!hit) return;

      const id_poste = (trPoste.getAttribute("data-id_poste") || "").trim();
      if (!id_poste) return;

      try {
        await showAnalysePosteDetailModal(p, id_poste, id_service, "");
      } catch (e) {
        // on laisse tes modals gérer leurs erreurs
      }
      return;
    }


    // ------------------------------
    // PREVISIONS: clic sur un poste impacté
    // Source détail = modal prévisionnel poste, pas diagnostic risques actuels
    // ------------------------------
    const trPrevRed = ev.target.closest("tr.prev-red-poste-row[data-id_poste]");
    if (trPrevRed) {
      const hit = ev.target.closest(".prev-red-open");
      if (!hit) return;

      const id_poste = (trPrevRed.getAttribute("data-id_poste") || "").trim();
      if (!id_poste) return;

      const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
      const seed = {
        intitule_poste: (trPrevRed.getAttribute("data-intitule_poste") || "").trim(),
        nom_service: (trPrevRed.getAttribute("data-nom_service") || "").trim(),
        indice_fragilite_horizon: (trPrevRed.getAttribute("data-indice_fragilite_horizon") || "").trim(),
        delta_fragilite: (trPrevRed.getAttribute("data-delta_fragilite") || "").trim(),
        next_exit_date: (trPrevRed.getAttribute("data-next_exit_date") || "").trim(),
      };

      try {
        if (typeof window.showAnalysePrevPosteRedModal === "function") {
          await window.showAnalysePrevPosteRedModal(p, id_poste, id_service, seed);
        } else {
          await showAnalysePosteDetailModal(p, id_poste, id_service, "");
        }
      } catch (e) {
        console.error(e);
      }
      return;
    }


    // ------------------------------
    // PDF compétence fragile
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
      // Comme postes fragiles: on n’ouvre pas sur n’importe quel clic dans la ligne
      const hit = ev.target.closest(".risk-comp-open");
      if (!hit) return;

      const compKey = (trComp.getAttribute("data-comp-key") || "").trim();
      if (!compKey) return;

      try {
        await showAnalyseCompetenceDetailModal(p, compKey, id_service);
      } catch (e) {
        if (typeof showToast === "function") showToast("Erreur ouverture détail compétence.", "error");
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

      // Si l’utilisateur reclique sur l’actif, on ne refait pas du bruit.
      if (mode === getMatchPosteMode()) return;

      setMatchPosteMode(mode);
      _matchRowsExpanded = false;

      // on reset la sélection poste pour repartir propre
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
        if (typeof showToast === "function") showToast(e.message || "Impossible d’ouvrir le PDF.", "error");
        else alert(e.message || "Impossible d’ouvrir le PDF.");
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

    // ------------------------------
    // 5) Click sur SORTIE (prévisions sorties)
    // ------------------------------
    const trSortie = ev.target.closest("tr.prev-sortie-row[data-id_effectif]");
    if (trSortie) {
      const tds = Array.from(trSortie.querySelectorAll("td"));
      const id_effectif = (trSortie.getAttribute("data-id_effectif") || "").trim();
      const id_poste_actuel = (trSortie.getAttribute("data-id_poste_actuel") || "").trim();
      if (!id_effectif) return;
      showPrevSortieModal(p, {
        id_effectif,
        id_poste_actuel,
        full: (tds[0]?.textContent || "").trim(),
        date_sortie: (trSortie.getAttribute("data-exit_date") || tds[1]?.textContent || "").trim(),
        poste: (tds[2]?.textContent || "").trim(),
        service: (tds[3]?.textContent || "").trim(),
        raison: (trSortie.getAttribute("data-reason") || tds[4]?.textContent || "").trim(),
      });
      return;
    }

    // ------------------------------
    // 6) Click sur CRITIQUE IMPACTEE (prévisions critiques)
    // ------------------------------
    const trPrevCrit = ev.target.closest("tr.prev-crit-row[data-comp-key]");
    if (trPrevCrit) {
      const hit = ev.target.closest(".prev-crit-open");
      if (!hit) return;

      const compKey = (trPrevCrit.getAttribute("data-comp-key") || "").trim();
      if (!compKey) return;

      showAnalysePrevCritModal(p, compKey, id_service);
      return;
    }
  });
}


  let _prevSortieModalEl = null;

  function showPrevSortieModal(portal, d) {
    if (_prevSortieModalEl && _prevSortieModalEl.parentNode) {
      _prevSortieModalEl.parentNode.removeChild(_prevSortieModalEl);
    }

    const horizon = getPrevHorizon();
    const horizonTxt = analyseHorizonLabel(horizon);
    const full = (d.full || "—").toString().trim();
    const exitDate = (d.date_sortie || d.exit_date || "").toString().trim();
    const poste = (d.poste || "—").toString().trim();
    const service = (d.service || "—").toString().trim();
    const raison = (d.raison || "—").toString().trim();
    const idPoste = (d.id_poste_actuel || "").toString().trim();

    const wrap = document.createElement("div");
    _prevSortieModalEl = wrap;

    function close() {
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (_prevSortieModalEl === wrap) _prevSortieModalEl = null;
      document.removeEventListener("keydown", onKey);
    }

    function onKey(e) {
      if (e.key === "Escape") close();
    }

    wrap.innerHTML = `
      <div class="modal show sb-prev-decision-modal" aria-hidden="false">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div class="sb-prev-modal-head">
              <div class="sb-prev-modal-titleline">${escapeHtml(full)}</div>
              <div class="card-sub" style="margin:0;">Sortie prévue à horizon ${escapeHtml(horizonTxt)}</div>
            </div>
            <button type="button" class="modal-x" id="btnPrevSortieCloseTop" aria-label="Fermer">×</button>
          </div>

          <div class="modal-body">
            <div class="sb-prev-rh-summary">
              <div class="sb-prev-rh-title">Lecture RH</div>
              <div class="sb-prev-rh-text">
                Cette sortie doit être lue comme un point de vigilance sur le poste occupé. Vérifiez les compétences critiques portées par cette personne, les relais internes disponibles et les actions à engager avant la date de sortie.
              </div>
            </div>

            <div class="sb-prev-kpi-grid sb-prev-kpi-grid--4">
              <div class="sb-prev-kpi"><span>Date de sortie prévue</span><strong>${escapeHtml(exitDate ? fmtDateFR(exitDate) : "—")}</strong></div>
              <div class="sb-prev-kpi"><span>Poste occupé</span><strong>${escapeHtml(poste)}</strong></div>
              <div class="sb-prev-kpi"><span>Service</span><strong>${escapeHtml(service)}</strong></div>
              <div class="sb-prev-kpi"><span>Motif</span><strong>${escapeHtml(raison)}</strong></div>
            </div>

            <div class="sb-prev-actions-card">
              <div class="sb-prev-modal-title">Points à sécuriser</div>
              <div class="sb-prev-action-list">
                <div>Identifier les savoir-faire critiques portés par la personne.</div>
                <div>Confirmer un relais interne ou organiser une transmission.</div>
                <div>Préparer une hypothèse de sécurisation si la couverture du poste devient insuffisante.</div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--accent" id="btnPrevSortieCreateHypothesis" ${idPoste ? "" : "disabled"}>Créer une hypothèse de sécurisation</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnPrevSortieGoRisques" ${idPoste ? "" : "disabled"}>Voir l’analyse du poste</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnPrevSortieGoMatching" ${idPoste ? "" : "disabled"}>Voir les relais possibles</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnPrevSortieCloseBottom">Fermer</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    const modal = wrap.querySelector(".modal");
    modal?.addEventListener("click", (e) => { if (e.target === modal) close(); });
    wrap.querySelector("#btnPrevSortieCloseTop")?.addEventListener("click", close);
    wrap.querySelector("#btnPrevSortieCloseBottom")?.addEventListener("click", close);

    wrap.querySelector("#btnPrevSortieCreateHypothesis")?.addEventListener("click", () => {
      if (!idPoste) return;
      addAnalyseHypothesis({
        type: "securiser_sortie_prevue",
        title: `Anticiper la sortie de ${String(full || "collaborateur")}`,
        poste_id: idPoste,
        poste_label: poste,
        effectif_label: full,
        scope_label: service,
        cause: "Sortie ou indisponibilité prévue",
        effet: "Vérifier si la couverture du poste et des compétences critiques reste suffisante à la date prévue.",
        horizon: horizonTxt,
        criticite: null
      });
      close();
    });

    wrap.querySelector("#btnPrevSortieGoRisques")?.addEventListener("click", async () => {
      if (!idPoste) return;
      const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");
      close();
      if (typeof showAnalysePosteDetailModal === "function") {
        await showAnalysePosteDetailModal(portal, idPoste, id_service, "");
      }
    });

    wrap.querySelector("#btnPrevSortieGoMatching")?.addEventListener("click", () => {
      if (!idPoste) return;
      close();
      _matchSelectedPoste = idPoste;
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

    return await analyseApiJson(portal, url);
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
        panePorteurs.innerHTML = `<div class="card-sub" style="margin:0;">Aucune couverture retournée.</div>`;
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

      // Points à sécuriser
      if (!actions.length) {
        paneActions.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Points à sécuriser</div>
            <div class="card-sub" style="margin:0;">
              Aucun plan renvoyé par l’API (à brancher).<br/>
              Points à instruire : couverture complémentaire, transmission, niveau réel à confirmer et hypothèse à tester.
            </div>
          </div>
        `;
      } else {
        paneActions.innerHTML = `
          <div class="card" style="padding:12px; margin:0;">
            <div class="card-title" style="margin-bottom:6px;">Points à sécuriser</div>
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

    /* ======================================================
    PREVISIONS — MODAL "POSTE ROUGE"
    - ouverture modal + tabs
    - clic sur ligne <tr class="prev-poste-red-row" data-id_poste="...">
    - fetch modal (endpoint à créer côté API)
    ====================================================== */

  if (!window.__sbPrevPosteRedModalWired) {
    window.__sbPrevPosteRedModalWired = true;

    // ---------- helpers modal ----------
    function openAnalysePrevPosteRedModal() {
      const m = byId("modalAnalysePrevPosteRed");
      if (!m) return;
      m.classList.add("show");
      m.setAttribute("aria-hidden", "false");
    }

    function closeAnalysePrevPosteRedModal() {
      const m = byId("modalAnalysePrevPosteRed");
      if (!m) return;
      m.classList.remove("show");
      m.setAttribute("aria-hidden", "true");
    }

    function setAnalysePrevPosteRedTab(tab) {
      const tabs = {
        synthese: { btn: "tabPrevPosteRedSynthese", pane: "analysePrevPosteRedTabSynthese" },
        causes: { btn: "tabPrevPosteRedCauses", pane: "analysePrevPosteRedTabCauses" },
        sortants: { btn: "tabPrevPosteRedSortants", pane: "analysePrevPosteRedTabSortants" },
        couverture: { btn: "tabPrevPosteRedCouverture", pane: "analysePrevPosteRedTabCouverture" },
        voisins: { btn: "tabPrevPosteRedVoisins", pane: "analysePrevPosteRedTabVoisins" },
      };

      Object.keys(tabs).forEach((k) => {
        const b = byId(tabs[k].btn);
        const p = byId(tabs[k].pane);
        if (b) b.classList.toggle("is-active", k === tab);
        if (p) p.style.display = (k === tab ? "" : "none");
      });
    }

    function _badge(el, txt) { if (el) el.textContent = txt; }

    function _num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    function _decisionText(futureFragiles, futureSans, futureUnique) {
      if (futureSans > 0) {
        return "Lecture RH : le poste perd une couverture critique. Préparer une hypothèse de sécurisation à tester.";
      }
      if (futureUnique > 0) {
        return "Lecture RH : le poste reste couvert, mais dépend trop fortement d’une seule personne. Préparer une hypothèse de couverture complémentaire.";
      }
      if (futureFragiles > 0) {
        return "Lecture RH : le poste présente une fragilité à horizon. Les relais internes et niveaux réels doivent être confirmés.";
      }
      return "Lecture RH : aucun point de rupture majeur détecté sur l’horizon, mais la couverture doit être suivie.";
    }

    // ---------- fetch modal ----------
    async function fetchPrevisionsPostesRougesModal(portal, id_poste, horizonYears, id_service) {
      const ctx = getPortalContext(portal);
      if (!ctx?.id_contact) throw new Error("id_contact introuvable côté UI.");
      if (!ctx?.apiBase) throw new Error("apiBase introuvable côté UI.");

      const qs = new URLSearchParams();
      qs.set("horizon_years", String(horizonYears || 1));
      qs.set("id_poste", String(id_poste || "").trim());
      if (id_service) qs.set("id_service", String(id_service).trim());
      const cmin = getCriticiteMinSafe(null);
      if (Number.isFinite(cmin)) qs.set("criticite_min", String(cmin));

      const url = `${ctx.apiBase}/skills/analyse/previsions/postes-rouges/modal/${encodeURIComponent(ctx.id_contact)}?${qs.toString()}`;

      return await analyseApiJson(portal, url);
    }

    // ---------- render modal ----------
    async function showAnalysePrevPosteRedModal(portal, id_poste, id_service, seed) {
      openAnalysePrevPosteRedModal();
      setAnalysePrevPosteRedTab("synthese");

      const horizon = getPrevHorizon();
      const horizonTxt = analyseHorizonLabel(horizon);
      const scopeLab = getScopeLabel();
      const seedData = seed || {};

      const title = byId("analysePrevPosteRedModalTitle");
      const sub = byId("analysePrevPosteRedModalSub");
      const bSvc = byId("analysePrevPosteRedBadgeService");
      const bHor = byId("analysePrevPosteRedBadgeHorizon");
      const bNext = byId("analysePrevPosteRedBadgeNext");
      const kFutureFrag = byId("prevPosteRedKpiFutureFragiles");
      const kFutureSans = byId("prevPosteRedKpiFutureSansPorteur");
      const kFutureUniq = byId("prevPosteRedKpiFuturePorteurUnique");
      const decision = byId("analysePrevPosteRedDecision");
      const paneSyn = byId("analysePrevPosteRedTabSynthese");
      const paneCauses = byId("analysePrevPosteRedTabCauses");
      const paneOut = byId("analysePrevPosteRedTabSortants");
      const paneCov = byId("analysePrevPosteRedTabCouverture");
      const paneVois = byId("analysePrevPosteRedTabVoisins");

      if (title) title.textContent = seedData.intitule_poste || "Détail poste";
      if (sub) sub.textContent = `Projection RH à horizon ${horizonTxt}`;
      _badge(bSvc, `Service : ${seedData.nom_service || scopeLab || "—"}`);
      _badge(bHor, `Horizon : ${horizonTxt}`);
      _badge(bNext, `Prochaine bascule : ${seedData.next_exit_date ? fmtDateFR(seedData.next_exit_date) : "—"}`);
      if (kFutureFrag) kFutureFrag.textContent = "—";
      if (kFutureSans) kFutureSans.textContent = "—";
      if (kFutureUniq) kFutureUniq.textContent = "—";
      if (decision) decision.textContent = "Chargement du diagnostic RH…";
      if (paneSyn) paneSyn.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
      if (paneCauses) paneCauses.innerHTML = "";
      if (paneOut) paneOut.innerHTML = "";
      if (paneCov) paneCov.innerHTML = "";
      if (paneVois) paneVois.innerHTML = "";

      window.__sbPrevPosteRedModalReqId = (window.__sbPrevPosteRedModalReqId || 0) + 1;
      const reqId = window.__sbPrevPosteRedModalReqId;

      try {
        const data = await fetchPrevisionsPostesRougesModal(portal, id_poste, horizon, id_service);
        if ((window.__sbPrevPosteRedModalReqId || 0) !== reqId) return;

        const poste = data?.poste || data?.post || {};
        const kpis = data?.kpis || data?.kpi || {};
        const causes = Array.isArray(data?.causes) ? data.causes : [];
        const sortants = Array.isArray(data?.sortants) ? data.sortants : [];
        const couverture = Array.isArray(data?.couverture) ? data.couverture : [];
        const voisins = Array.isArray(data?.voisins) ? data.voisins : [];

        const intit = (poste.intitule_poste || seedData.intitule_poste || "—").toString().trim();
        const svc = (poste.nom_service || seedData.nom_service || scopeLab || "—").toString().trim();
        const code = (poste.codif_client || poste.codif_poste || "").toString().trim();
        const fFrag = _num(kpis.future_fragiles ?? data?.future_fragiles ?? 0);
        const fSans = _num(kpis.future_sans_porteur ?? data?.future_sans_porteur ?? 0);
        const fUniq = _num(kpis.future_porteur_unique ?? data?.future_porteur_unique ?? 0);
        const next = (kpis.next_exit_date || data?.next_exit_date || "").toString().trim();
        const nowTit = _num(kpis.nb_titulaires_now);
        const hTit = _num(kpis.nb_titulaires_horizon);
        const cible = _num(kpis.nb_titulaires_cible || poste.nb_titulaires_cible || 1);
        const covNow = _num(kpis.couverture_now);
        const covFuture = _num(kpis.couverture_future);

        if (title) title.innerHTML = `${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span> ` : ""}${escapeHtml(intit)}`;
        if (sub) sub.textContent = `Impact prévisionnel du poste à horizon ${horizonTxt}`;
        _badge(bSvc, `Service : ${svc}`);
        _badge(bNext, `Prochaine bascule : ${next ? fmtDateFR(next) : "—"}`);
        if (kFutureFrag) kFutureFrag.textContent = String(fFrag);
        if (kFutureSans) kFutureSans.textContent = String(fSans);
        if (kFutureUniq) kFutureUniq.textContent = String(fUniq);
        if (decision) decision.textContent = _decisionText(fFrag, fSans, fUniq);
        window.__sbPrevPosteRedHypothesis = {
          type: "securiser_poste_prevision",
          title: `Anticiper le poste ${code ? code + " · " : ""}${intit}`,
          poste_id: String(id_poste || poste.id_poste || poste.id || "").trim(),
          poste_label: `${code ? code + " — " : ""}${intit}`,
          scope_label: svc,
          cause: fSans > 0 ? "Compétence critique sans porteur à horizon" : (fUniq > 0 ? "Couverture trop dépendante à horizon" : "Fragilité prévisionnelle du poste"),
          effet: "Tester une hypothèse de couverture future avant que le poste ne devienne fragile.",
          horizon: horizonTxt,
          criticite: null
        };

        function readingText() {
          if (fSans > 0) return "Ce poste présente un risque de rupture : une ou plusieurs compétences critiques ne seraient plus couvertes à la période sélectionnée.";
          if (fUniq > 0) return "Ce poste resterait couvert, mais avec une dépendance forte à une seule personne sur certaines compétences critiques.";
          if (fFrag > 0 || hTit < nowTit || covFuture < covNow) return "Ce poste se fragilise à horizon : la couverture baisse ou la capacité de relève doit être confirmée.";
          return "Aucun point de rupture majeur n’est détecté, mais la projection doit être surveillée.";
        }

        function actionList() {
          const arr = [];
          if (fSans > 0) arr.push("Créer une hypothèse de sécurisation immédiate à tester.");
          if (fUniq > 0) arr.push("Organiser un binôme et une transmission formalisée sur les compétences à porteur unique.");
          if (sortants.length) arr.push("Planifier les actions avant la prochaine sortie prévue.");
          if (!arr.length) arr.push("Contrôler la couverture et confirmer les relais internes disponibles.");
          return arr.map(x => `<div>${escapeHtml(x)}</div>`).join("");
        }

        if (paneSyn) {
          const top = causes.slice(0, 5).map(c => {
            const compKey = (c.id_comp || c.id_competence || c.code || "").toString().trim();
            const codeC = (c.code || "—").toString().trim();
            const label = (c.intitule || c.intitule_competence || "—").toString().trim();
            const now = _num(c.nb_now ?? c.porteurs_now);
            const rem = _num(c.nb_remain ?? c.porteurs_remain);
            const crit = _num(c.criticite ?? c.poids_criticite);
            return `<div class="sb-prev-impact-line prev-poste-red-comp-row" data-comp-key="${escapeHtml(compKey)}"><span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(codeC)}</span><div class="sb-prev-impact-main"><strong>${escapeHtml(label)}</strong><span>Criticité ${escapeHtml(String(crit || "—"))} · couverture ${escapeHtml(String(now))} → ${escapeHtml(String(rem))}</span></div></div>`;
          }).join("");

          paneSyn.innerHTML = `
            <div class="sb-prev-rh-summary"><div class="sb-prev-rh-title">Lecture RH</div><div class="sb-prev-rh-text">${escapeHtml(readingText())}</div></div>
            <div class="sb-prev-kpi-grid sb-prev-kpi-grid--4">
              <div class="sb-prev-kpi"><span>Titulaires poste</span><strong>${escapeHtml(String(nowTit))} → ${escapeHtml(String(hTit))}</strong></div>
              <div class="sb-prev-kpi"><span>Cible RH</span><strong>${escapeHtml(String(cible || "—"))}</strong></div>
              <div class="sb-prev-kpi"><span>Couverture critique</span><strong>${escapeHtml(String(Math.round(covNow)))}% → ${escapeHtml(String(Math.round(covFuture)))}%</strong></div>
              <div class="sb-prev-kpi"><span>Compétences fragilisées</span><strong>${escapeHtml(String(fFrag))}</strong></div>
            </div>
            <div class="sb-prev-actions-card"><div class="sb-prev-modal-title">Points à sécuriser</div><div class="sb-prev-action-list">${actionList()}</div></div>
            <div class="sb-prev-actions-card"><div class="sb-prev-modal-title">Compétences à sécuriser en priorité</div>${top || `<div class="sb-prev-empty">Aucune compétence prioritaire retournée.</div>`}</div>
          `;
        }

        if (paneCauses) {
          if (!causes.length) paneCauses.innerHTML = `<div class="sb-prev-empty">Aucune cause compétence retournée.</div>`;
          else paneCauses.innerHTML = `
            <div class="sb-prev-table-wrap"><table class="sb-table sb-table--airy sb-table--hover sb-prev-table"><thead><tr><th>Compétence critique</th><th class="col-center">Niveau requis</th><th class="col-center">Criticité</th><th class="col-center">Porteurs</th><th>Prochaine sortie</th><th>Point à sécuriser</th></tr></thead><tbody>${causes.map(c => {
              const compKey = (c.id_comp || c.id_competence || c.code || "").toString().trim();
              const codeC = (c.code || "—").toString().trim();
              const label = (c.intitule || c.intitule_competence || "—").toString().trim();
              const niv = (c.niveau_requis || c.niveau_attendu || "—").toString().trim();
              const crit = _num(c.criticite ?? c.poids_criticite);
              const now = _num(c.nb_now ?? c.porteurs_now);
              const rem = _num(c.nb_remain ?? c.porteurs_remain);
              const nxt = (c.next_exit_comp || c.next_exit_date || "").toString().trim();
              const decision = rem <= 0 ? "Couverture à créer" : (rem === 1 ? "Porteur à dédoubler" : "Relais à confirmer");
              return `<tr class="prev-poste-red-comp-row" data-comp-key="${escapeHtml(compKey)}"><td><span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(codeC)}</span> <strong>${escapeHtml(label)}</strong></td><td class="col-center"><span class="sb-badge">${escapeHtml(niv)}</span></td><td class="col-center">${escapeHtml(String(crit || "—"))}</td><td class="col-center"><strong>${escapeHtml(String(now))} → ${escapeHtml(String(rem))}</strong></td><td>${escapeHtml(nxt ? fmtDateFR(nxt) : "—")}</td><td>${escapeHtml(decision)}</td></tr>`;
            }).join("")}</tbody></table></div>`;
        }

        if (paneOut) {
          if (!sortants.length) paneOut.innerHTML = `<div class="sb-prev-empty">Aucun porteur sortant retourné pour ce poste.</div>`;
          else paneOut.innerHTML = `<div class="sb-prev-table-wrap"><table class="sb-table sb-table--airy sb-prev-table"><thead><tr><th>Porteur sortant</th><th>Date sortie</th><th>Compétence portée</th><th class="col-center">Niveau</th><th>Motif</th></tr></thead><tbody>${sortants.map(r => {
            const full = (r.full || `${(r.prenom_effectif || "").trim()} ${(r.nom_effectif || "").trim()}`.trim() || "—");
            const exit = (r.exit_date || "").toString().trim();
            const codeC = (r.code || "—").toString().trim();
            const label = (r.intitule || "—").toString().trim();
            const niv = (r.niveau_actuel || r.niveau || "—").toString().trim();
            const reason = (r.raison_sortie || "—").toString().trim();
            return `<tr><td><strong>${escapeHtml(full)}</strong></td><td>${escapeHtml(exit ? fmtDateFR(exit) : "—")}</td><td><span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(codeC)}</span> ${escapeHtml(label)}</td><td class="col-center"><span class="sb-badge">${escapeHtml(niv)}</span></td><td>${escapeHtml(reason)}</td></tr>`;
          }).join("")}</tbody></table></div>`;
        }

        if (paneCov) {
          if (!couverture.length) paneCov.innerHTML = `<div class="sb-prev-empty">Aucun relais restant retourné.</div>`;
          else paneCov.innerHTML = `<div class="sb-prev-table-wrap"><table class="sb-table sb-table--airy sb-prev-table"><thead><tr><th>Compétence</th><th>Relais restant</th><th class="col-center">Niveau</th><th>Poste actuel</th><th>Service</th></tr></thead><tbody>${couverture.map(r => {
            const codeC = (r.comp_code || r.code || "—").toString().trim();
            const full = (r.full || `${(r.prenom_effectif || r.prenom || "").trim()} ${(r.nom_effectif || r.nom || "").trim()}`.trim() || "—");
            const niv = (r.niveau_actuel || r.niveau || "—").toString().trim();
            const posteR = (r.intitule_poste || r.poste || "—").toString().trim();
            const svcR = (r.nom_service || r.service || "—").toString().trim();
            return `<tr><td><span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(codeC)}</span></td><td><strong>${escapeHtml(full)}</strong></td><td class="col-center"><span class="sb-badge">${escapeHtml(niv)}</span></td><td>${escapeHtml(posteR)}</td><td>${escapeHtml(svcR)}</td></tr>`;
          }).join("")}</tbody></table></div>`;
        }

        if (paneVois) {
          if (!voisins.length) paneVois.innerHTML = `<div class="sb-prev-empty">Aucun poste voisin retourné. À traiter via une hypothèse de sécurisation selon le niveau de couverture.</div>`;
          else paneVois.innerHTML = `<div class="sb-prev-table-wrap"><table class="sb-table sb-table--airy sb-prev-table"><thead><tr><th>Poste voisin</th><th>Service</th><th class="col-center">Compétences communes</th></tr></thead><tbody>${voisins.map(r => `<tr><td><strong>${escapeHtml(r.intitule_poste || r.poste || "—")}</strong></td><td>${escapeHtml(r.nom_service || r.service || "—")}</td><td class="col-center">${escapeHtml(String(r.nb_competences_communes || r.score || "—"))}</td></tr>`).join("")}</tbody></table></div>`;
        }

      } catch (e) {
        if ((window.__sbPrevPosteRedModalReqId || 0) !== reqId) return;
        if (sub) sub.textContent = "Erreur de chargement";
        if (paneSyn) paneSyn.innerHTML = `<div class="sb-prev-empty">Impossible de charger le détail poste : ${escapeHtml(e?.message || e)}</div>`;
      }
    }


    // ---------- wiring (clics) ----------
    document.addEventListener("click", async (ev) => {
      // close
      if (ev.target.closest("#btnCloseAnalysePrevPosteRedModal") || ev.target.closest("#btnAnalysePrevPosteRedModalClose")) {
        closeAnalysePrevPosteRedModal();
        return;
      }
      // backdrop close
      const modal = byId("modalAnalysePrevPosteRed");
      if (modal && ev.target === modal) {
        closeAnalysePrevPosteRedModal();
        return;
      }

      // tabs
      if (ev.target.closest("#tabPrevPosteRedSynthese")) return setAnalysePrevPosteRedTab("synthese");
      if (ev.target.closest("#tabPrevPosteRedCauses")) return setAnalysePrevPosteRedTab("causes");
      if (ev.target.closest("#tabPrevPosteRedSortants")) return setAnalysePrevPosteRedTab("sortants");
      if (ev.target.closest("#tabPrevPosteRedCouverture")) return setAnalysePrevPosteRedTab("couverture");
      if (ev.target.closest("#tabPrevPosteRedVoisins")) return setAnalysePrevPosteRedTab("voisins");

      // clic compétence dans l’onglet Causes => ouvre modal compétence (si déjà en place chez toi)
      const trComp = ev.target.closest("tr.prev-poste-red-comp-row[data-comp-key]");
      if (trComp) {
        const compKey = (trComp.getAttribute("data-comp-key") || "").trim();
        if (!compKey) return;
        const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");

        if (_portalref && typeof showAnalysePrevCritModal === "function") {
          await showAnalysePrevCritModal(_portalref, compKey, id_service);
        }
        return;
      }

      // clic ligne "poste rouge" (dans le détail KPI postes rouges)
      const tr = ev.target.closest("tr.prev-poste-red-row[data-id_poste]");
      if (tr) {
        const id_poste = (tr.getAttribute("data-id_poste") || "").trim();
        if (!id_poste) return;

        const id_service = window.portal.serviceFilter.toQueryId(byId("analyseServiceSelect")?.value || "");


        const seed = {
          intitule_poste: (tr.getAttribute("data-intitule_poste") || "").trim(),
          nom_service: (tr.getAttribute("data-nom_service") || "").trim(),
          future_fragiles: (tr.getAttribute("data-future_fragiles") || "").trim(),
          future_sans_porteur: (tr.getAttribute("data-future_sans_porteur") || "").trim(),
          future_porteur_unique: (tr.getAttribute("data-future_porteur_unique") || "").trim(),
          next_exit_date: (tr.getAttribute("data-next_exit_date") || "").trim(),
        };

        if (!_portalref) throw new Error("Contexte portail indisponible (_portalref manquant).");
        await showAnalysePrevPosteRedModal(_portalref, id_poste, id_service, seed);
        return;
      }
    });

    // expose si besoin (debug / appels directs)
    window.showAnalysePrevPosteRedModal = showAnalysePrevPosteRedModal;
  }


  function ensureRiskEvol3mModal() {
    let modal = byId("modalRiskEvol3m");
    if (modal) return modal;

    const html = `
      <div class="modal" id="modalRiskEvol3m" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div style="font-weight:600;" id="riskEvol3mModalTitle">Évolution</div>
            <button type="button" class="modal-x" id="btnCloseRiskEvol3mModal" aria-label="Fermer">×</button>
          </div>

          <div class="modal-body" id="riskEvol3mModalBody">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Chargement…</div>
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
      ? `Postes en évolution (3 mois)${scopeHtml}`
      : `Compétences en évolution (3 mois)${scopeHtml}`;

    if (titleEl) titleEl.innerHTML = titleTxt;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      bodyEl.innerHTML = `
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-sub" style="margin:0;">Aucune évolution détectée.</div>
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
            if (d > 0) return "Cause: indisponibilité prévue d’ici 3 mois";
            if (d < 0) return "Cause: fin d’indisponibilité d’ici 3 mois";
            return "Cause: stabilité";
          };

          bodyEl.innerHTML = `
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">Détail</div>

              <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                ${list.map(r => `
                  <div class="sb-evol-card"
                      data-evol-id="${escapeHtml(String(r.id || ""))}"
                      style="display:flex; align-items:center; justify-content:space-between; gap:12px;
                              padding:10px 12px; border:1px solid var(--sb-gray-200); border-radius:12px;
                              cursor:pointer;">
                    <div style="min-width:0;">
                      <div style="display:flex; gap:8px; align-items:center; min-width:0;">
                        <span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(r.code || "—")}</span>
                        <span style="font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(r.label || "—")}
                        </span>
                      </div>

                      <div class="sb-fs-13"
                          style="opacity:.85; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(r.service || "—")} • ${escapeHtml(causeTxt(r.delta))}
                      </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s0 || 0))))}%</span>
                      <span style="opacity:.6;">→</span>
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s3 || 0))))}%</span>
                      ${deltaBadge(r.delta)}
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          `;

          // Clic => ouvrir le modal "poste fragile" (état actuel)
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
            if (d > 0) return "Cause: indisponibilité prévue d’ici 3 mois";
            if (d < 0) return "Cause: fin d’indisponibilité d’ici 3 mois";
            return "Cause: stabilité";
          };

          bodyEl.innerHTML = `
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">Détail</div>

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
                        <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(r.code || "—")}</span>
                        <span style="font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                          ${escapeHtml(r.label || "—")}
                        </span>
                      </div>

                      <div class="sb-fs-13"
                          style="opacity:.85; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${escapeHtml(causeTxt(r.delta))}
                      </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s0 || 0))))}%</span>
                      <span style="opacity:.6;">→</span>
                      <span class="sb-badge">${escapeHtml(String(Math.round(Number(r.s3 || 0))))}%</span>
                      ${deltaBadge(r.delta)}
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          `;

          // Clic => ouvrir le modal "compétence critique" (état actuel)
          bodyEl.querySelectorAll(".sb-evol-comp-card[data-evol-id]").forEach((el) => {
            el.addEventListener("click", () => {
              const id = (el.getAttribute("data-evol-id") || "").trim();
              const code = (el.getAttribute("data-evol-code") || "").trim();
              const text = (el.getAttribute("data-evol-text") || "").trim();
              if (!id || !_portalref) return;

              const id_service = getFilters()?.id_service || "";
              closeRiskEvol3mModal();

              // ouvre le détail compétence (actuel)
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
    if (titleEl) titleEl.innerHTML = `Détail projection <span class="sb-badge">${escapeHtml(label)}</span>`;

    const indispos = Array.isArray(month?.indisponibilites) ? month.indisponibilites : [];
    const sorties = Array.isArray(month?.sorties) ? month.sorties : [];

    const fmtList = (items, type) => {
      if (!items.length) return `<div class="card-sub" style="margin:0;">Aucun événement identifié.</div>`;
      return `
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${items.map(r => {
            const person = r.personne || "Collaborateur";
            const poste = r.poste || "Poste non renseigné";
            const dates = type === "indispo"
              ? `${r.date_debut || "—"} → ${r.date_fin || "—"}`
              : `${r.date_sortie || "—"}`;
            const motif = type === "sortie" ? `<div class="card-sub" style="margin-top:2px;">${escapeHtml(r.motif || "Sortie prévue")}</div>` : "";
            return `
              <div style="border:1px solid var(--sb-gray-200); border-radius:12px; padding:10px 12px; background:#fff;">
                <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                  <div style="min-width:0;">
                    <div style="font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(person)}</div>
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
          <div class="card-title" style="margin-bottom:8px;">Indisponibilités temporaires</div>
          ${fmtList(indispos, "indispo")}
        </div>
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:8px;">Fins de contrat / sorties prévues</div>
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

