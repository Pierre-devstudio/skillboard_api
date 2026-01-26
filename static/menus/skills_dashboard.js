/* ======================================================
   static/menus/skills_dashboard.js
   - Dashboard (squelette)
   - Bienvenue [Prénom]
   - Bandeau info (caché si vide)
   - 6 tuiles (placeholders)
   ====================================================== */

(function () {

  function byId(id) { return document.getElementById(id); }

  function renderWelcome(ctx) {
    const prenom = (ctx?.prenom || "").toString().trim();
    const elPrenom = byId("welcomePrenom");
    if (!elPrenom) return;

    if (prenom) {
      elPrenom.textContent = prenom;
      elPrenom.style.display = "inline";
    } else {
      elPrenom.textContent = "";
      elPrenom.style.display = "none";
    }
  }

  async function tryLoadDashBanner(portal) {
    const banner = byId("dashInfoBanner");
    if (!banner) return;

    // par défaut: caché
    banner.style.display = "none";

    // Endpoint à créer côté API (bloc Python ensuite).
    // Tant qu'il n'existe pas ou renvoie vide => bandeau reste invisible.
    try {
      const url = `${portal.apiBase}/skills/dashboard/banner/${encodeURIComponent(portal.contactId)}`;
      const data = await portal.apiJson(url);

      const message = (data?.message ?? "").toString().trim();
      if (!message) return;

      const titre = (data?.titre ?? "").toString().trim();

      const elTitle = byId("dashInfoTitle");
      const elText = byId("dashInfoText");

      if (elTitle) elTitle.textContent = titre || "Les nouveautés dans Skillboard Insights";
      if (elText) elText.textContent = message;

      banner.style.display = "";
    } catch {
      banner.style.display = "none";
    }
  }

  function renderAgePyramid(data){
    const body = byId("agePyramidBody");
    const noteRoot = byId("agePyramidNote");
    const quality = byId("agePyramidQuality");

    if (!body) return;

    const setTxt = (id, v) => {
      const el = byId(id);
      if (el) el.textContent = v;
    };

    const fmtPct = (v) => {
      if (typeof v !== "number" || !isFinite(v)) return "–";
      return v.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
    };

    const fmtRatio = (v) => {
      if (v === null || v === undefined || typeof v !== "number" || !isFinite(v)) return "–";
      return v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    // reset qualité (interdit d'afficher les manquants)
    if (quality) quality.textContent = "";

    // ----- KPI (sous la pyramide)
    const totalAgeKnown = Number(data?.risk_sortie_total || 0);
    const seniors58 = Number(data?.risk_sortie_count || 0);
    const juniors = Number(data?.releve_junior || 0);
    const seniorsForRatio = Number(data?.releve_senior || 0);

    // KPI 1 — Risque de sortie (58+)
    if (totalAgeKnown > 0){
      setTxt("kpiRiskSortie", fmtPct(Number(data?.risk_sortie_pct || 0)));
      setTxt("kpiRiskSortieSub", `${seniors58} salarié(s) (58+)`);
    } else {
      setTxt("kpiRiskSortie", "–");
      setTxt("kpiRiskSortieSub", "Données âge indisponibles");
    }

    // KPI 2 — Capacité de relève
    if (seniorsForRatio > 0){
      setTxt("kpiCapaciteReleve", fmtRatio(Number(data?.releve_ratio)));
      setTxt("kpiCapaciteReleveSub", `<35: ${juniors} • 58+: ${seniorsForRatio}`);
    } else if (totalAgeKnown > 0){
      setTxt("kpiCapaciteReleve", "–");
      setTxt("kpiCapaciteReleveSub", "Aucun senior 58+");
    } else {
      setTxt("kpiCapaciteReleve", "–");
      setTxt("kpiCapaciteReleveSub", "");
    }

    // KPI 3 — Transmission en danger (experts)
    const compTotal = Number(data?.transmission_comp_total || 0);
    const compDanger = Number(data?.transmission_comp_danger || 0);

    if (compTotal > 0){
      setTxt("kpiTransmissionDanger", fmtPct(Number(data?.transmission_pct || 0)));
      const transSub = document.querySelector("#agePyramidKpis .sb-agepyr-kpi--trans .sb-agepyr-kpi-sub");
      if (transSub) transSub.textContent = `Experts (C) proches de sortie • ${compDanger}/${compTotal}`;
    } else {
      setTxt("kpiTransmissionDanger", "–");
      const transSub = document.querySelector("#agePyramidKpis .sb-agepyr-kpi--trans .sb-agepyr-kpi-sub");
      if (transSub) transSub.textContent = "Aucun expert (C) identifié";
    }

    // Afficher le bloc KPI si on a au moins une info exploitable
    if (noteRoot){
      const hasKpi = (totalAgeKnown > 0) || (compTotal > 0);
      noteRoot.style.display = hasKpi ? "" : "none";
    }

    // ----- Pyramide (barres)
    const bandsRaw = Array.isArray(data?.bands) ? data.bands : [];
    const order = ["60+", "55-59", "45-54", "35-44", "25-34", "<25"];
    const rank = new Map(order.map((k, i) => [k, i]));
    const bands = bandsRaw.slice().sort((a, b) => {
      const ra = rank.has(a?.label) ? rank.get(a.label) : 999;
      const rb = rank.has(b?.label) ? rank.get(b.label) : 999;
      return ra - rb;
    });

    let max = 0;
    for (const b of bands){
      const f = Number(b?.femmes || 0);
      const m = Number(b?.hommes || 0);
      if (f > max) max = f;
      if (m > max) max = m;
    }

    if (!bands.length || max <= 0){
      body.innerHTML = `<div class="card-sub" style="margin:0;">Aucune donnée exploitable</div>`;
      return;
    }

    body.innerHTML = "";

    for (const b of bands){
      const label = (b?.label ?? "").toString().trim();
      const femmes = Number(b?.femmes || 0);
      const hommes = Number(b?.hommes || 0);

      const row = document.createElement("div");
      row.className = "sb-agepyr-row";

      const left = document.createElement("div");
      left.className = "sb-agepyr-side sb-agepyr-side--f";

      const barF = document.createElement("div");
      barF.className = "sb-agepyr-bar sb-agepyr-bar--f";
      barF.style.width = ((femmes / max) * 100).toFixed(2) + "%";
      barF.title = `Femmes: ${femmes}`;
      left.appendChild(barF);

      const lab = document.createElement("div");
      lab.className = "sb-agepyr-lab";
      lab.textContent = label;

      const right = document.createElement("div");
      right.className = "sb-agepyr-side sb-agepyr-side--m";

      const barM = document.createElement("div");
      barM.className = "sb-agepyr-bar sb-agepyr-bar--m";
      barM.style.width = ((hommes / max) * 100).toFixed(2) + "%";
      barM.title = `Hommes: ${hommes}`;
      right.appendChild(barM);

      row.appendChild(left);
      row.appendChild(lab);
      row.appendChild(right);

      body.appendChild(row);
    }
  }


  async function tryLoadAgePyramid(portal){
    const body = byId("agePyramidBody");
    const noteRoot = byId("agePyramidNote");
    const quality = byId("agePyramidQuality");
    if (!body) return;

    body.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

    // IMPORTANT: on masque, mais on n'efface jamais le contenu HTML du conteneur KPI
    if (noteRoot) noteRoot.style.display = "none";
    if (quality) quality.textContent = "";

    try{
      const url = `${portal.apiBase}/skills/dashboard/age-pyramid/${encodeURIComponent(portal.contactId)}`;
      const data = await portal.apiJson(url);
      renderAgePyramid(data);
    } catch (e){
      body.innerHTML = `<div class="card-sub" style="margin:0;">Erreur de chargement</div>`;
      if (noteRoot) noteRoot.style.display = "none";
      if (quality) quality.textContent = "";
    }
  }


  function renderGlobalGauge(svg, gaugeMin, gaugeMax, value){
    let gMin = Number(gaugeMin ?? 0);
    let gMax = Number(gaugeMax ?? 1);
    if (!isFinite(gMin)) gMin = 0;
    if (!isFinite(gMax)) gMax = 1;
    if (gMax < gMin) { const t = gMin; gMin = gMax; gMax = t; }

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const range = Math.max(1e-9, (gMax - gMin));

    const tFromValue = (v) => (clamp(v, gMin, gMax) - gMin) / range;

    // 180° (gauche) -> 360° (droite) en passant par 270° (haut)
    const angleFromT = (t) => 180 + (180 * t);

    const cx = 120;
    const cy = 120;
    const r = 90;
    const rNeedle = 74;

    const polar = (angleDeg, radius) => {
      const rad = (angleDeg * Math.PI) / 180;
      return {
        x: cx + (radius * Math.cos(rad)),
        y: cy + (radius * Math.sin(rad)), // SVG: +sin vers le bas
      };
    };

    const arcPath = (a1, a2) => {
      if (a2 < a1) { const t = a1; a1 = a2; a2 = t; }
      const p1 = polar(a1, r);
      const p2 = polar(a2, r);
      const diff = Math.abs(a2 - a1);
      const large = (diff <= 180) ? "0" : "1";
      const sweep = "1";
      return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    };

    // zones: 20% / 30% / 50% sur la plage [min..max]
    const a0 = angleFromT(0.0);
    const a1 = angleFromT(0.2);
    const a2 = angleFromT(0.5);
    const a3 = angleFromT(1.0);

    const bgD = arcPath(180, 360);
    const z1D = arcPath(a0, a1);
    const z2D = arcPath(a1, a2);
    const z3D = arcPath(a2, a3);

    const aNeedle = angleFromT(tFromValue(clamp(Number(value ?? 0), gMin, gMax)));
    const pNeedle = polar(aNeedle, rNeedle);

    // stroke-linecap butt => jonctions propres entre segments
    svg.innerHTML = `
      <path d="${bgD}"
            stroke="rgba(0,0,0,.10)"
            stroke-width="16"
            fill="none"
            stroke-linecap="round"></path>

      <path d="${z1D}"
            stroke="var(--accent)"
            stroke-width="14"
            fill="none"
            stroke-linecap="butt"></path>

      <path d="${z2D}"
            stroke="#f59e0b"
            stroke-width="14"
            fill="none"
            stroke-linecap="butt"></path>

      <path d="${z3D}"
            stroke="#16a34a"
            stroke-width="14"
            fill="none"
            stroke-linecap="butt"></path>

      <line x1="${cx}" y1="${cy}" x2="${pNeedle.x.toFixed(2)}" y2="${pNeedle.y.toFixed(2)}"
            stroke="rgba(0,0,0,.65)"
            stroke-width="3"
            stroke-linecap="round"></line>

      <circle cx="${cx}" cy="${cy}" r="6" fill="rgba(0,0,0,.65)"></circle>
    `;
  }

  async function tryLoadGlobalGauge(portal){
    const svg = byId("globalGaugeSvg");
    const note = byId("globalGaugeNote");
    if (!svg) return;

    if (note){
      note.style.display = "";
      note.textContent = "Chargement…";
    }
    svg.innerHTML = "";

    try{
      // Périmètre futur (droits) : si portal.scopeServiceId est défini, on le passe.
      const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
      const qs = serviceId ? `?id_service=${encodeURIComponent(serviceId)}` : "";

      const url = `${portal.apiBase}/skills/dashboard/global-gauge/${encodeURIComponent(portal.contactId)}${qs}`;
      const data = await portal.apiJson(url);

      const gMin = Number(data?.gauge_min ?? 0);
      const gMax = Number(data?.gauge_max ?? 0);
      const score = Number(data?.score ?? 0);
      const nb = Number(data?.nb_items ?? 0);

      // Pas de chiffres affichés: uniquement visu + message si vide/KO
      if (!isFinite(gMin) || !isFinite(gMax) || !isFinite(score) || nb <= 0 || gMax <= gMin){
        renderGlobalGauge(svg, 0, 1, 0);
        if (note){
          note.style.display = "";
          note.textContent = "Aucune compétence critique (poids > 80) sur les postes actuels.";
        }

        const scopeEl = byId("globalGaugeScope");
        if (scopeEl){
          const serviceId2 = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
          scopeEl.textContent = serviceId2 ? "Périmètre : Service" : "Périmètre : Entreprise";
        }

        return;
      }

      const needle = Math.max(gMin, Math.min(gMax, score));
      renderGlobalGauge(svg, gMin, gMax, needle);

      if (note){
        note.style.display = "none";
        note.textContent = "";
      }

      const scopeEl = byId("globalGaugeScope");
      if (scopeEl){
        // futur droits: si scopeServiceId défini -> service, sinon entreprise
        const serviceId2 = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
        scopeEl.textContent = serviceId2 ? "Périmètre : Service" : "Périmètre : Entreprise";
      }


    } catch (e){
      renderGlobalGauge(svg, 0, 1, 0);
      if (note){
        note.style.display = "";
        note.textContent = "Erreur de chargement de la jauge.";
      }
      const scopeEl = byId("globalGaugeScope");
      if (scopeEl){
        const serviceId2 = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
        scopeEl.textContent = serviceId2 ? "Périmètre : Service" : "Périmètre : Entreprise";
      }

    }
  }

  function renderRing(svg, pct01){
    if (!svg) return;

    let p = Number(pct01 ?? 0);
    if (!isFinite(p)) p = 0;
    p = Math.max(0, Math.min(1, p));

    const cx = 60, cy = 60;
    const r = 46;              // rayon
    const stroke = 12;         // épaisseur anneau
    const circ = 2 * Math.PI * r;
    const filled = circ * p;

    const bg = `
      <circle class="sb-ring-bg"
              cx="${cx}" cy="${cy}" r="${r}"
              stroke-width="${stroke}"></circle>
    `;

    // IMPORTANT: si 0%, on n’affiche pas le cercle de progression (sinon “point” à cause du round cap)
    const prog = (p > 0.0001) ? `
      <circle class="sb-ring-prog"
              cx="${cx}" cy="${cy}" r="${r}"
              stroke-width="${stroke}"
              stroke-dasharray="${filled.toFixed(2)} ${circ.toFixed(2)}"></circle>
    ` : "";

    svg.innerHTML = bg + prog;

  }

  async function tryLoadNoTraining12m(portal){
    const svg = byId("noTrain12mSvg");
    const elPct = byId("noTrain12mPct");
    const elSub = byId("noTrain12mSub");
    const note = byId("noTrain12mNote");

    if (!svg) return;

    // état initial
    renderRing(svg, 0);
    if (elPct) elPct.textContent = "–%";
    if (elSub) elSub.textContent = "";
    if (note){
      note.style.display = "";
      note.textContent = "Chargement…";
    }

    try{
      const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
      const qs = serviceId ? `?id_service=${encodeURIComponent(serviceId)}` : "";

      const url = `${portal.apiBase}/skills/dashboard/no-training-12m/${encodeURIComponent(portal.contactId)}${qs}`;
      // DEBUG dur: on veut le vrai statut + le detail serveur (au lieu de “Erreur de chargement.”)
      const res = await fetch(url, { headers: { "Accept": "application/json" } });

      if (!res.ok){
        let detail = "";
        try{
          const j = await res.json();
          detail = j && j.detail ? String(j.detail) : JSON.stringify(j);
        } catch {
          detail = await res.text();
        }
        throw new Error(`HTTP ${res.status} - ${detail}`.slice(0, 300));
      }

      const data = await res.json();


      const total = Number(data?.total_effectif ?? 0);
      const countNo = Number(data?.count_no_training_12m ?? 0);
      let pct = Number(data?.pct_no_training_12m ?? 0);

      if (!isFinite(pct)) pct = 0;
      pct = Math.max(0, Math.min(100, pct));

      if (!total || total <= 0){
        renderRing(svg, 0);
        if (elPct) elPct.textContent = "–%";
        if (elSub) elSub.textContent = "";
        if (note){
          note.style.display = "";
          note.textContent = "Aucun effectif actif (périmètre).";
        }
        return;
      }

      renderRing(svg, pct / 100);

      if (elPct){
        elPct.textContent = pct.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + "%";
      }
      if (elSub){
        elSub.textContent = `${countNo} / ${total} salarié(s)`;
      }
      if (note){
        note.style.display = "none";
        note.textContent = "";
      }

    } catch (e){
      renderRing(svg, 0);
      if (elPct) elPct.textContent = "–%";
      if (elSub) elSub.textContent = "";
      if (note){
        note.style.display = "";
        note.textContent = `Erreur: ${String(e && e.message ? e.message : e)}`;
      }
    }
  }

    async function tryLoadNoPerformance12m(portal){
    const svg = byId("noPerf12mSvg");
    const elPct = byId("noPerf12mPct");
    const elSub = byId("noPerf12mSub");
    const note = byId("noPerf12mNote");

    if (!svg) return;

    // état initial
    renderRing(svg, 0);
    if (elPct) elPct.textContent = "–%";
    if (elSub) elSub.textContent = "";
    if (note){
      note.style.display = "";
      note.textContent = "Chargement…";
    }

    try{
      // périmètre futur (droits)
      const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
      const qs = serviceId ? `?id_service=${encodeURIComponent(serviceId)}` : "";

      const url = `${portal.apiBase}/skills/dashboard/no-performance-12m/${encodeURIComponent(portal.contactId)}${qs}`;
      const data = await portal.apiJson(url);

      const total = Number(data?.total_effectif ?? 0);
      const countNo = Number(data?.count_no_perf_12m ?? 0);
      let pct = Number(data?.pct_no_perf_12m ?? 0);

      if (!isFinite(pct)) pct = 0;
      pct = Math.max(0, Math.min(100, pct));

      if (!total || total <= 0){
        renderRing(svg, 0);
        if (elPct) elPct.textContent = "–%";
        if (elSub) elSub.textContent = "";
        if (note){
          note.style.display = "";
          note.textContent = "Aucun effectif actif (périmètre).";
        }
        return;
      }

      // Ici, on affiche le % "à risque" (sans point performance)
      renderRing(svg, pct / 100);

      if (elPct){
        elPct.textContent = pct.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + "%";
      }
      if (elSub){
        elSub.textContent = `${countNo} / ${total} salarié(s)`;
      }
      if (note){
        note.style.display = "none";
        note.textContent = "";
      }

    } catch (e){
      renderRing(svg, 0);
      if (elPct) elPct.textContent = "–%";
      if (elSub) elSub.textContent = "";
      if (note){
        note.style.display = "";
        note.textContent = "Erreur de chargement.";
      }
    }
  }

    function fmtDateShortFR(isoDate) {
    if (!isoDate) return "";
    const d = new Date(String(isoDate).slice(0, 10) + "T00:00:00");
    if (isNaN(d.getTime())) return String(isoDate);

    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();

    const now = new Date();
    return (yyyy === now.getFullYear()) ? `${dd}/${mm}` : `${dd}/${mm}/${yyyy}`;
  }

  function fmtTrainingDateRange(item) {
    const d1 = item?.date_debut_formation ? fmtDateShortFR(item.date_debut_formation) : "";
    const d2 = item?.date_fin_formation ? fmtDateShortFR(item.date_fin_formation) : "";

    if (d1 && d2 && d1 !== d2) return `${d1} - ${d2}`;
    return d1 || d2 || "";
  }

  async function tryLoadUpcomingTrainings(portal) {
    const list = byId("upTrainList");
    const badge = byId("upTrainBadge");
    const more = byId("upTrainMore");
    const note = byId("upTrainNote");

    if (!list) return;

    list.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    if (badge) badge.style.display = "none";
    if (more) more.style.display = "none";
    if (note) note.style.display = "none";

    try {
      const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
      const qs = serviceId ? `?id_service=${encodeURIComponent(serviceId)}` : "";

      const url = `${portal.apiBase}/skills/dashboard/upcoming-trainings/${encodeURIComponent(portal.contactId)}${qs}`;
      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const items = Array.isArray(data?.items) ? data.items : [];

      if (!total || total <= 0 || items.length === 0) {
        list.innerHTML = `<div class="card-sub" style="margin:0;">Aucune formation programmée.</div>`;
        if (badge) badge.style.display = "none";
        if (more) more.style.display = "none";
        if (note) note.style.display = "none";
        return;
      }

      // Badge: nombre total à venir
      if (badge) {
        badge.textContent = `${total}`;
        badge.style.display = "";
      }

      // Rendu 3 lignes max (API limite déjà à 3)
      list.innerHTML = items.map(it => {
        const dateTxt = fmtTrainingDateRange(it) || "Date à préciser";
        const title = (it?.label ?? "").toString().trim() || "Formation";
        const n = Number(it?.nb_participants ?? 0);
        const countTxt = `${isFinite(n) ? n : 0} pers.`;

        return `
          <div class="sb-uptrain-row">
            <div class="sb-uptrain-date">${dateTxt}</div>
            <div class="sb-uptrain-title" title="${title.replace(/"/g, "&quot;")}">${title}</div>
            <div class="sb-uptrain-count">${countTxt}</div>
          </div>
        `;
      }).join("");

      // +N autres
      const remaining = total - items.length;
      if (more) {
        if (remaining > 0) {
          more.textContent = `+${remaining} autre(s) formation(s)`;
          more.style.display = "";
        } else {
          more.style.display = "none";
        }
      }

      if (note) note.style.display = "none";

    } catch (e) {
      list.innerHTML = `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`;
      if (badge) badge.style.display = "none";
      if (more) more.style.display = "none";
      if (note) {
        note.style.display = "none";
        note.textContent = "";
      }
    }
  }

    async function tryLoadCertifsExpiring(portal) {
    const list = byId("certExpList");
    const badge = byId("certExpBadge");
    const more = byId("certExpMore");
    const note = byId("certExpNote");

    if (!list) return;

    list.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    if (badge) badge.style.display = "none";
    if (more) more.style.display = "none";
    if (note) note.style.display = "none";

    try {
      const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
      const qs = serviceId ? `?days=60&id_service=${encodeURIComponent(serviceId)}` : `?days=60`;

      const url = `${portal.apiBase}/skills/dashboard/certifs-expiring/${encodeURIComponent(portal.contactId)}${qs}`;
      const data = await portal.apiJson(url);

      const totalInstances = Number(data?.total_instances ?? 0);
      const totalGroups = Number(data?.total_groups ?? 0);
      const items = Array.isArray(data?.items) ? data.items : [];

      if (!totalInstances || totalInstances <= 0 || items.length === 0) {
        list.innerHTML = `<div class="card-sub" style="margin:0;">Aucun renouvellement à prévoir.</div>`;
        if (badge) badge.style.display = "none";
        if (more) more.style.display = "none";
        return;
      }

      if (badge) {
        badge.textContent = `${totalInstances}`;
        badge.style.display = "";
      }

      list.innerHTML = items.map(it => {
        const dateTxt = fmtDateShortFR(it?.date_expiration) || "Date ?";
        const title = (it?.certification ?? "").toString().trim() || "Certification";
        const n = Number(it?.nb_personnes ?? 0);
        const countTxt = `${isFinite(n) ? n : 0} pers.`;

        return `
          <div class="sb-uptrain-row">
            <div class="sb-uptrain-date">${dateTxt}</div>
            <div class="sb-uptrain-title" title="${title.replace(/"/g, "&quot;")}">${title}</div>
            <div class="sb-uptrain-count">${countTxt}</div>
          </div>
        `;
      }).join("");

      const remaining = totalGroups - items.length;
      if (more) {
        if (remaining > 0) {
          more.textContent = `+${remaining} autre(s) certification(s)`;
          more.style.display = "";
        } else {
          more.style.display = "none";
        }
      }

    } catch (e) {
      list.innerHTML = `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`;
      if (badge) badge.style.display = "none";
      if (more) more.style.display = "none";
    }
  }

  function openModal(id){
    const m = byId(id);
    if (!m) return;
    m.classList.add("show");
    m.setAttribute("aria-hidden", "false");

    const body = m.querySelector(".modal-body");
    if (body) body.scrollTop = 0;
  }

  function closeModal(id){
    const m = byId(id);
    if (!m) return;
    m.classList.remove("show");
    m.setAttribute("aria-hidden", "true");
  }

  function setDashDetailModal(title, sub, html){
    const t = byId("modalDashDetailTitle");
    const s = byId("modalDashDetailSub");
    const b = byId("modalDashDetailBody");
    if (t) t.textContent = title || "Détail";
    if (s) s.textContent = sub || "";
    if (b) b.innerHTML = html || "";
  }

    async function loadDashDetailNoPerf12m(portal, title, scope, offset){
    const limit = 50;

    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/no-performance-12m/detail/${encodeURIComponent(portal.contactId)}${qs}`;

    // mini helper local pour éviter les injections HTML
    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    try{
      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const seuil = Number(data?.seuil_couverture ?? 0.7);
      const seuilPct = Math.round(seuil * 100);

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          Règle : point performance OK si couverture ≥ <b>${seuilPct}%</b> (compétences actives auditées sur 12 mois).
          <br>
          <b>${total}</b> salarié(s) concerné(s) sur ce périmètre.
        </div>
      `;

      if (!rows.length){
        html += `<div class="card-sub" style="margin:0;">Aucun salarié concerné.</div>`;
        setDashDetailModal(title, scope, html);
        return;
      }

      html += `
        <div class="table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Salarié</th>
                <th>Service</th>
                <th>Poste</th>
                <th>Couverture</th>
                <th>Audits &lt; 12 mois</th>
                <th>Dernier audit</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const nom = `${esc(r?.prenom)} ${esc(r?.nom)}`.trim();
                const service = esc(r?.service ?? "");
                const poste = esc(r?.poste ?? "");
                const cov = Number(r?.couverture_pct ?? 0);
                const covTxt = (isFinite(cov) ? cov.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : "0") + "%";

                const a = Number(r?.nb_comp_auditees_12m ?? 0);
                const t = Number(r?.nb_comp_total ?? 0);
                const auditsTxt = `${isFinite(a) ? a : 0} / ${isFinite(t) ? t : 0}`;

                // fmtDateShortFR existe déjà (utilisée sur tes autres tuiles). Si non, affiche brut.
                const da = r?.date_dernier_audit ? (typeof fmtDateShortFR === "function" ? fmtDateShortFR(r.date_dernier_audit) : esc(r.date_dernier_audit)) : "";

                return `
                  <tr>
                    <td>${nom || "-"}</td>
                    <td>${service || "-"}</td>
                    <td>${poste || "-"}</td>
                    <td><b>${covTxt}</b></td>
                    <td>${auditsTxt}</td>
                    <td>${da || "-"}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;

      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < total;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(total / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashDetailPrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashDetailNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      setDashDetailModal(title, scope, html);

      const btnPrev = byId("btnDashDetailPrev");
      const btnNext = byId("btnDashDetailNext");

      if (btnPrev){
        btnPrev.onclick = async () => {
          if (!canPrev) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailNoPerf12m(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }

      if (btnNext){
        btnNext.onclick = async () => {
          if (!canNext) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailNoPerf12m(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`);
    }
  }

    async function loadDashDetailNoTraining12m(portal, title, scope, offset){
    const limit = 50;

    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/no-training-12m/detail/${encodeURIComponent(portal.contactId)}${qs}`;

    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    try{
      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const totalEff = Number(data?.total_effectif ?? 0);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const mois = Number(data?.periode_mois ?? 12);

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          Période : <b>${isFinite(mois) ? mois : 12}</b> mois.
          <br>
          <b>${total}</b> salarié(s) sans formation sur <b>${totalEff}</b> (périmètre).
        </div>
      `;

      if (!rows.length){
        html += `<div class="card-sub" style="margin:0;">Aucun salarié concerné.</div>`;
        setDashDetailModal(title, scope, html);
        return;
      }

      html += `
        <div class="table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Salarié</th>
                <th>Service</th>
                <th>Poste</th>
                <th>Dernière formation</th>
                <th>Jours</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const nom = `${esc(r?.prenom)} ${esc(r?.nom)}`.trim();
                const service = esc(r?.service ?? "");
                const poste = esc(r?.poste ?? "");

                const df = r?.date_derniere_formation
                  ? (typeof fmtDateShortFR === "function" ? fmtDateShortFR(r.date_derniere_formation) : esc(r.date_derniere_formation))
                  : "-";

                const j = r?.jours_depuis_derniere_formation;
                const jours = (j === null || j === undefined || j === "") ? "-" : esc(j);

                return `
                  <tr>
                    <td>${nom || "-"}</td>
                    <td>${service || "-"}</td>
                    <td>${poste || "-"}</td>
                    <td><b>${df}</b></td>
                    <td>${jours}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;

      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < total;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(total / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashDetailPrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashDetailNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      setDashDetailModal(title, scope, html);

      const btnPrev = byId("btnDashDetailPrev");
      const btnNext = byId("btnDashDetailNext");

      if (btnPrev){
        btnPrev.onclick = async () => {
          if (!canPrev) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailNoTraining12m(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }

      if (btnNext){
        btnNext.onclick = async () => {
          if (!canNext) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailNoTraining12m(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`);
    }
  }

    async function loadDashDetailCertifsExpiring(portal, title, scope, offset){
    const limit = 50;

    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?days=60&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/certifs-expiring/detail/${encodeURIComponent(portal.contactId)}${qs}`;

    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    try{
      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const days = Number(data?.days ?? 60);

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          Fenêtre : <b>${isFinite(days) ? days : 60}</b> jours.
          <br>
          <b>${total}</b> certification(s) à renouveler (instances nominatives) sur ce périmètre.
        </div>
      `;

      if (!rows.length){
        html += `<div class="card-sub" style="margin:0;">Aucun renouvellement à prévoir.</div>`;
        setDashDetailModal(title, scope, html);
        return;
      }

      html += `
        <div class="table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Expiration</th>
                <th>J-</th>
                <th>Certification</th>
                <th>Salarié</th>
                <th>Service</th>
                <th>Poste</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const exp = r?.date_expiration
                  ? (typeof fmtDateShortFR === "function" ? fmtDateShortFR(r.date_expiration) : esc(r.date_expiration))
                  : "-";
                const j = Number(r?.jours_avant_expiration ?? 0);
                const jTxt = isFinite(j) ? String(j) : "0";

                const cert = esc(r?.certification ?? "");
                const nom = `${esc(r?.prenom)} ${esc(r?.nom)}`.trim();
                const service = esc(r?.service ?? "");
                const poste = esc(r?.poste ?? "");

                return `
                  <tr>
                    <td><b>${exp}</b></td>
                    <td>${jTxt}</td>
                    <td>${cert || "-"}</td>
                    <td>${nom || "-"}</td>
                    <td>${service || "-"}</td>
                    <td>${poste || "-"}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;

      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < total;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(total / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashDetailPrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashDetailNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      setDashDetailModal(title, scope, html);

      const btnPrev = byId("btnDashDetailPrev");
      const btnNext = byId("btnDashDetailNext");

      if (btnPrev){
        btnPrev.onclick = async () => {
          if (!canPrev) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailCertifsExpiring(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }

      if (btnNext){
        btnNext.onclick = async () => {
          if (!canNext) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailCertifsExpiring(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`);
    }
  }

    async function loadDashDetailUpcomingTrainings(portal, title, scope, offset){
    const limit = 20;

    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/upcoming-trainings/detail/${encodeURIComponent(portal.contactId)}${qs}`;

    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    const fmtRange = (it) => {
      const d1 = it?.date_debut_formation ? (typeof fmtDateShortFR === "function" ? fmtDateShortFR(it.date_debut_formation) : esc(it.date_debut_formation)) : "";
      const d2 = it?.date_fin_formation ? (typeof fmtDateShortFR === "function" ? fmtDateShortFR(it.date_fin_formation) : esc(it.date_fin_formation)) : "";
      if (d1 && d2 && d1 !== d2) return `${d1} - ${d2}`;
      return d1 || d2 || "-";
    };

    try{
      const data = await portal.apiJson(url);

      const totalSessions = Number(data?.total_sessions ?? 0);
      const items = Array.isArray(data?.items) ? data.items : [];

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          <b>${totalSessions}</b> session(s) à venir sur ce périmètre.
        </div>
      `;

      if (!items.length){
        html += `<div class="card-sub" style="margin:0;">Aucune formation programmée.</div>`;
        setDashDetailModal(title, scope, html);
        return;
      }

      html += items.map(it => {
        const sid = esc(it?.id_action_formation ?? "");
        const label = esc(it?.label ?? "Formation");
        const dates = fmtRange(it);
        const nb = Number(it?.nb_participants ?? 0);
        const nbTxt = isFinite(nb) ? nb : 0;

        const parts = Array.isArray(it?.participants) ? it.participants : [];

        const partTable = parts.length ? `
          <div class="table-wrap" style="margin-top:8px;">
            <table class="sb-table">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Service</th>
                  <th>Poste</th>
                </tr>
              </thead>
              <tbody>
                ${parts.map(p => {
                  const nom = `${esc(p?.prenom)} ${esc(p?.nom)}`.trim();
                  const service = esc(p?.service ?? "");
                  const poste = esc(p?.poste ?? "");
                  return `
                    <tr>
                      <td>${nom || "-"}</td>
                      <td>${service || "-"}</td>
                      <td>${poste || "-"}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="sb-muted" style="margin-top:6px;">Aucun participant.</div>`;

        return `
          <div style="border:1px solid #f1f5f9; border-radius:12px; padding:10px 12px; margin-bottom:10px; background:#fff;">
            <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px;">
              <div style="font-weight:800; font-size:13px; color:#111827; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${label}">
                ${label}
              </div>
              <div class="sb-muted" style="white-space:nowrap;">${dates}</div>
            </div>

            <div style="margin-top:2px; display:flex; justify-content:space-between; align-items:center;">
              <div class="sb-muted">ID: ${sid || "-"}</div>
              <div style="font-weight:800; font-size:12px; white-space:nowrap;">${nbTxt} pers.</div>
            </div>

            ${partTable}
          </div>
        `;
      }).join("");

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;

      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < totalSessions;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(totalSessions / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashDetailPrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashDetailNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      setDashDetailModal(title, scope, html);

      const btnPrev = byId("btnDashDetailPrev");
      const btnNext = byId("btnDashDetailNext");

      if (btnPrev){
        btnPrev.onclick = async () => {
          if (!canPrev) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailUpcomingTrainings(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }

      if (btnNext){
        btnNext.onclick = async () => {
          if (!canNext) return;
          setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
          await loadDashDetailUpcomingTrainings(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Erreur de chargement.</div>`);
    }
  }

    async function loadDashDetailAgePyramidSeniors(portal, title, scope, offset){
    const limit = 50;
    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?age_min=58&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/age-pyramid/detail-seniors/${encodeURIComponent(portal.contactId)}${qs}`;

    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    const tabsHtml = (active) => `
      <div class="sb-dash-tabs">
        <button type="button" class="btn-secondary sb-dash-tab ${active === "seniors" ? "sb-dash-tab--active" : ""}" data-age-tab="seniors">Seniors (≥58)</button>
        <button type="button" class="btn-secondary sb-dash-tab ${active === "trans" ? "sb-dash-tab--active" : ""}" data-age-tab="trans">Transmission en danger</button>
      </div>
      <div id="dashAgeTabContent"></div>
    `;

    try{
      setDashDetailModal(title, scope, tabsHtml("seniors"));
      bindDashAgeTabs(portal, title, scope);

      const host = byId("dashAgeTabContent");
      if (host){
        host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
      }

      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const ageMin = Number(data?.age_min ?? 58);

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          Liste des salariés âgés de <b>${isFinite(ageMin) ? ageMin : 58} ans</b> et plus.
          <br><b>${total}</b> personne(s) sur ce périmètre.
        </div>
      `;

      if (!rows.length){
        html += `<div class="card-sub" style="margin:0;">Aucun senior identifié.</div>`;
        byId("dashAgeTabContent").innerHTML = html;
        return;
      }

      html += `
        <div class="table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Salarié</th>
                <th>Âge</th>
                <th>Service</th>
                <th>Poste</th>
                <th>Comp. Expert</th>
                <th>Retraite</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const nom = `${esc(r?.prenom)} ${esc(r?.nom)}`.trim();
                const age = Number(r?.age ?? 0);
                const service = esc(r?.service ?? "");
                const poste = esc(r?.poste ?? "");
                const nbExp = Number(r?.nb_comp_expert ?? 0);
                const ret = (r?.retraite_estimee === null || r?.retraite_estimee === undefined || r?.retraite_estimee === "") ? "-" : esc(r?.retraite_estimee);
                return `
                  <tr>
                    <td>${nom || "-"}</td>
                    <td><b>${isFinite(age) ? age : 0}</b></td>
                    <td>${service || "-"}</td>
                    <td>${poste || "-"}</td>
                    <td>${isFinite(nbExp) ? nbExp : 0}</td>
                    <td>${ret}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;
      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < total;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(total / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashAgePrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashAgeNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      byId("dashAgeTabContent").innerHTML = html;

      const prev = byId("btnDashAgePrev");
      const next = byId("btnDashAgeNext");

      if (prev){
        prev.onclick = async () => {
          if (!canPrev) return;
          await loadDashDetailAgePyramidSeniors(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }
      if (next){
        next.onclick = async () => {
          if (!canNext) return;
          await loadDashDetailAgePyramidSeniors(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      setDashDetailModal(title, scope, tabsHtml("seniors"));
      bindDashAgeTabs(portal, title, scope);

      const host = byId("dashAgeTabContent");
      if (host){
        host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
      }

    }
  }

  async function loadDashDetailAgePyramidTransmissionDanger(portal, title, scope, offset){
    const limit = 50;
    const serviceId = (portal && portal.scopeServiceId) ? String(portal.scopeServiceId).trim() : "";
    const qs =
      `?age_min=58&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
      (serviceId ? `&id_service=${encodeURIComponent(serviceId)}` : "");

    const url = `${portal.apiBase}/skills/dashboard/age-pyramid/detail-transmission-danger/${encodeURIComponent(portal.contactId)}${qs}`;
    

    const esc = (v) => String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    const tabsHtml = (active) => `
      <div class="sb-dash-tabs">
        <button type="button" class="btn-secondary sb-dash-tab ${active === "seniors" ? "sb-dash-tab--active" : ""}" data-age-tab="seniors">Seniors (≥58)</button>
        <button type="button" class="btn-secondary sb-dash-tab ${active === "trans" ? "sb-dash-tab--active" : ""}" data-age-tab="trans">Transmission en danger</button>
      </div>
      <div id="dashAgeTabContent"></div>
    `;

    try{
      setDashDetailModal(title, scope, tabsHtml("trans"));
      bindDashAgeTabs(portal, title, scope);

      const host = byId("dashAgeTabContent");
      if (host){
        host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
      }

      const data = await portal.apiJson(url);

      const total = Number(data?.total ?? 0);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const ageMin = Number(data?.age_min ?? 58);

      let html = `
        <div class="sb-muted" style="margin-bottom:10px;">
          Détail nominatif des <b>experts</b> (niveau “Expert”) âgés de <b>${isFinite(ageMin) ? ageMin : 58} ans</b> et plus,
          sur des compétences où la transmission est considérée “en danger” (majorité stricte d’experts = seniors).
          <br><b>${total}</b> ligne(s) sur ce périmètre.
        </div>
      `;

      if (!rows.length){
        html += `<div class="card-sub" style="margin:0;">Aucun risque de transmission identifié.</div>`;
        byId("dashAgeTabContent").innerHTML = html;
        return;
      }

      html += `
        <div class="table-wrap">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Compétence</th>
                <th>Expert</th>
                <th>Âge</th>
                <th>Service</th>
                <th>Poste</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const comp = esc(r?.competence ?? "");
                const code = esc(r?.code_comp ?? "");
                const compLabel = code ? `${code} - ${comp}` : (comp || "-");

                const nom = `${esc(r?.prenom)} ${esc(r?.nom)}`.trim();
                const age = Number(r?.age ?? 0);
                const service = esc(r?.service ?? "");
                const poste = esc(r?.poste ?? "");
                return `
                  <tr>
                    <td>${compLabel}</td>
                    <td>${nom || "-"}</td>
                    <td><b>${isFinite(age) ? age : 0}</b></td>
                    <td>${service || "-"}</td>
                    <td>${poste || "-"}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      const curOffset = Number(data?.offset ?? offset) || 0;
      const curLimit = Number(data?.limit ?? limit) || limit;
      const canPrev = curOffset > 0;
      const canNext = (curOffset + curLimit) < total;

      html += `
        <div class="sb-dash-pager">
          <div class="sb-muted">Page : ${Math.floor(curOffset / curLimit) + 1} / ${Math.max(1, Math.ceil(total / curLimit))}</div>
          <div>
            <button type="button" class="btn-secondary" id="btnDashAgePrev" ${canPrev ? "" : "disabled"}>Précédent</button>
            <button type="button" class="btn-secondary" id="btnDashAgeNext" ${canNext ? "" : "disabled"}>Suivant</button>
          </div>
        </div>
      `;

      byId("dashAgeTabContent").innerHTML = html;

      const prev = byId("btnDashAgePrev");
      const next = byId("btnDashAgeNext");

      if (prev){
        prev.onclick = async () => {
          if (!canPrev) return;
          await loadDashDetailAgePyramidTransmissionDanger(portal, title, scope, Math.max(0, curOffset - curLimit));
        };
      }
      if (next){
        next.onclick = async () => {
          if (!canNext) return;
          await loadDashDetailAgePyramidTransmissionDanger(portal, title, scope, curOffset + curLimit);
        };
      }

    } catch (e){
      // On affiche l'erreur réelle (HTTP + message) au lieu d'un vague "Erreur de chargement."
      const msg = (e && e.message) ? String(e.message) : String(e || "Erreur inconnue");
      setDashDetailModal(title, scope, tabsHtml("trans"));
      bindDashAgeTabs(portal, title, scope);

      const host = byId("dashAgeTabContent");
      if (host){
        host.innerHTML = `<div class="card-sub" style="margin:0;">Erreur: ${msg}</div>`;
      }
    }

  }

  function bindDashAgeTabs(portal, title, scope){
    const root = byId("modalDashDetailBody");
    if (!root) return;

    root.querySelectorAll("[data-age-tab]").forEach(btn => {
      btn.onclick = async () => {
        const tab = btn.getAttribute("data-age-tab");
        if (tab === "seniors"){
          await loadDashDetailAgePyramidSeniors(portal, title, scope, 0);
        } else {
          await loadDashDetailAgePyramidTransmissionDanger(portal, title, scope, 0);
        }
      };
    });
  }



  async function openDashDetailForTile(portal, tileEl){
    const kpiKey = (tileEl?.dataset?.kpi || "").trim();
    const titleEl = tileEl.querySelector(".sb-dash-tile-title");
    const title = titleEl ? titleEl.textContent.replace(/\s+/g, " ").trim() : "Détail";

    const scope = (portal && portal.scopeServiceId) ? "Périmètre : Service" : "Périmètre : Entreprise";
    setDashDetailModal(title, scope, `<div class="card-sub" style="margin:0;">Chargement…</div>`);
    openModal("modalDashDetail");

    if (kpiKey === "sans-point-performance-12m"){
      await loadDashDetailNoPerf12m(portal, title, scope, 0);
      return;
    }

    if (kpiKey === "sans-formation-12m"){
      await loadDashDetailNoTraining12m(portal, title, scope, 0);
      return;
    }

    if (kpiKey === "certifications-renouveler-60j"){
      await loadDashDetailCertifsExpiring(portal, title, scope, 0);
      return;
    }

    if (kpiKey === "formations-programmees"){
      await loadDashDetailUpcomingTrainings(portal, title, scope, 0);
      return;
    }

    if (kpiKey === "pyramide-ages"){
      await loadDashDetailAgePyramidSeniors(portal, title, scope, 0);
      return;
    }


    // Pour l’instant: placeholder par KPI (on branchera les endpoints détail ensuite)
    let body = `<div class="sb-muted">Aucun détail branché pour <b>${kpiKey || "kpi"}</b> (à faire tuile par tuile).</div>`;

    // Exemple de table placeholder (histoire de valider le rendu)
    body += `
      <table class="sb-table" style="margin-top:10px;">
        <thead><tr><th>Colonne</th><th>Valeur</th></tr></thead>
        <tbody>
          <tr><td>kpi</td><td>${(kpiKey || "-")}</td></tr>
          <tr><td>scope</td><td>${scope}</td></tr>
        </tbody>
      </table>
    `;

    setDashDetailModal(title, scope, body);
  }

  function bindDashTiles(portal){
    const root = byId("view-dashboard");
    if (!root) return;

    // Fermeture modal
    const x = byId("btnDashDetailClose");
    const x2 = byId("btnDashDetailClose2");
    if (x) x.onclick = () => closeModal("modalDashDetail");
    if (x2) x2.onclick = () => closeModal("modalDashDetail");

    const modal = byId("modalDashDetail");
    if (modal){
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal("modalDashDetail");
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("show")) closeModal("modalDashDetail");
      });
    }

    // Clic tuiles
    root.querySelectorAll(".sb-dash-tile[data-kpi]").forEach(tile => {
      tile.setAttribute("tabindex", "0");

      tile.addEventListener("click", () => {
        openDashDetailForTile(portal, tile);
      });

      tile.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " "){
          e.preventDefault();
          openDashDetailForTile(portal, tile);
        }
      });
    });
  }



  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        portal.showAlert("", "");

        // Contexte + topbar sont déjà centralisés dans portal.ensureContext()
        // (voir skills_portal.js). On lit juste le ctx pour afficher le prénom.
        const ctx = portal.context || await portal.ensureContext();

        renderWelcome(ctx);
        await tryLoadDashBanner(portal);
        await tryLoadAgePyramid(portal);
        await tryLoadGlobalGauge(portal);
        await tryLoadNoTraining12m(portal);
        await tryLoadNoPerformance12m(portal);
        await tryLoadUpcomingTrainings(portal);
        await tryLoadCertifsExpiring(portal);
        await tryLoadAgePyramid(portal);

        bindDashTiles(portal);


      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };

})();
