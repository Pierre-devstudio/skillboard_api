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

    setAnalysePosteTab("competences");

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

      renderAnalysePosteCompetencesTab(data);
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

      function focusBadge(value, focusKey) {
        const v = Number(value || 0);
        const isActive = v > 0;

        if (!isActive) {
          return badge("0", false);
        }

        // badge cliquable (sans ajouter de CSS)
        return `
          <span
            class="sb-badge sb-badge-accent risk-focus"
            data-focus="${escapeHtml(focusKey)}"
            title="Afficher le détail: ${escapeHtml(focusKey)}"
            style="cursor:pointer; user-select:none;">
            ${escapeHtml(String(v))}
          </span>
        `;
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
                    <td style="font-weight:700;">${escapeHtml(poste)}</td>
                    <td>${escapeHtml(svc)}</td>
                    <td class="col-center">${focusBadge(a, "critiques-sans-porteur")}</td>
                    <td class="col-center">${focusBadge(b, "porteur-unique")}</td>
                    <td class="col-center">${focusBadge(c, "total-fragiles")}</td>
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
            // - clic colonne "Critiques sans porteur" => focus
            // - clic colonne "Porteur unique" => focus
            // - clic colonne "Total fragiles" => focus
            // ==============================
            const analyseBody = byId("analyseDetailBody");
            if (analyseBody) {
              analyseBody.addEventListener("click", async (ev) => {
                const tr = ev.target.closest("tr.risk-poste-row[data-id_poste]");
                if (!tr) return;

                const id_poste = (tr.getAttribute("data-id_poste") || "").trim();
                if (!id_poste) return;

                const id_service = (byId("analyseServiceSelect")?.value || "").trim();

                // Détecter la colonne cliquée
                let focusKey = "";
                const td = ev.target.closest("td");
                if (td && td.parentElement === tr) {
                  const tds = Array.from(tr.children).filter(n => n && n.tagName === "TD");
                  const idx = tds.indexOf(td);

                  // 0: Poste | 1: Service | 2: Critiques sans porteur | 3: Porteur unique | 4: Total fragiles
                  if (idx === 2) focusKey = "critiques-sans-porteur";
                  else if (idx === 3) focusKey = "porteur-unique";
                  else if (idx === 4) focusKey = "total-fragiles";
                }

                await showAnalysePosteDetailModal(portal, id_poste, id_service, focusKey);
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
