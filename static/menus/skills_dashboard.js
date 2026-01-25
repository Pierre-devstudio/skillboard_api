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



      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };

})();
