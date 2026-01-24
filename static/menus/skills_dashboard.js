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
    const note = byId("agePyramidNote");
    if (!body) return;

    const bandsRaw = Array.isArray(data?.bands) ? data.bands : [];

    // Ordre pyramide: +60 en haut, <25 en bas
    const order = ["60+", "55-59", "45-54", "35-44", "25-34", "<25"];
    const rank = new Map(order.map((k, i) => [k, i]));
    const bands = bandsRaw.slice().sort((a, b) => {
      const ra = rank.has(a?.label) ? rank.get(a.label) : 999;
      const rb = rank.has(b?.label) ? rank.get(b.label) : 999;
      return ra - rb;
    });

    // max commun (même échelle gauche/droite)
    let max = 0;
    for (const b of bands){
      const f = Number(b?.femmes || 0);
      const m = Number(b?.hommes || 0);
      if (f > max) max = f;
      if (m > max) max = m;
    }

    if (!bands.length || max <= 0){
      body.innerHTML = `<div class="card-sub" style="margin:0;">Aucune donnée exploitable</div>`;
      if (note){
        note.style.display = "none";
        note.textContent = "";
      }
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

    // Qualité data
    if (note){
      const total = Number(data?.total_actifs || 0);
      const unkBirth = Number(data?.unknown_birth || 0);
      const unkGender = Number(data?.unknown_gender || 0);

      const parts = [];
      if (total) parts.push(`Actifs: ${total}`);
      if (unkBirth) parts.push(`Dates de naissance manquantes: ${unkBirth}`);
      if (unkGender) parts.push(`Sexe non renseigné: ${unkGender}`);

      if (parts.length){
        note.textContent = parts.join(" • ");
        note.style.display = "";
      } else {
        note.textContent = "";
        note.style.display = "none";
      }
    }
  }

  async function tryLoadAgePyramid(portal){
    const body = byId("agePyramidBody");
    const note = byId("agePyramidNote");
    if (!body) return;

    body.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;
    if (note){
      note.style.display = "none";
      note.textContent = "";
    }

    try{
      const url = `${portal.apiBase}/skills/dashboard/age-pyramid/${encodeURIComponent(portal.contactId)}`;
      const data = await portal.apiJson(url);
      renderAgePyramid(data);
    } catch (e){
      body.innerHTML = `<div class="card-sub" style="margin:0;">Erreur de chargement</div>`;
      if (note){
        note.style.display = "none";
        note.textContent = "";
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

      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };

})();
