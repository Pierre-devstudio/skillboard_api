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

  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        portal.showAlert("", "");

        // Contexte + topbar sont déjà centralisés dans portal.ensureContext()
        // (voir skills_portal.js). On lit juste le ctx pour afficher le prénom.
        const ctx = portal.context || await portal.ensureContext();

        renderWelcome(ctx);
        await tryLoadDashBanner(portal);

      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du dashboard : " + (e?.message || e));
      }
    }
  };

})();
