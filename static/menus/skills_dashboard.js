(function () {
  async function ensureContext(portal) {
    if (portal.context) return portal.context;

    portal.showAlert("", "");
    const id = portal.contactId;

    const ctx = await portal.apiJson(`${portal.apiBase}/skills/context/${encodeURIComponent(id)}`);
    portal.context = ctx;

    const civ = (ctx.civilite || "").trim();
    const prenom = (ctx.prenom || "").trim();
    const nom = (ctx.nom || "").trim();
    const display = [civ, prenom, nom].filter(Boolean).join(" ").trim();

    portal.setTopbar(display || "Contact", "Portail Skills — JMB CONSULTANT");

    const wt = document.getElementById("welcomeTitle");
    if (wt) wt.textContent = display ? `Bienvenue, ${display}` : "Bienvenue";

    return ctx;
  }

  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        await ensureContext(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du contexte : " + e.message);
        portal.setTopbar("Contact", "Portail Skills — JMB CONSULTANT");
      }
    }
  };
})();
