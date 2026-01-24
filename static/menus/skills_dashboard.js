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

      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };

})();
