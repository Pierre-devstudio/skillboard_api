(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  // IMPORTANT : enregistrer les menus AVANT portal.init()
  window.portal.registerMenu({
    view: "dashboard",
    htmlUrl: "/menu_studio/studio_dashboard.html"
    // js auto-guess -> on crée un fichier vide studio_dashboard.js (voir étape 1.2)
  });

  function byId(id){ return document.getElementById(id); }

  async function tryFillTopbar() {
    const info = byId("topbarInfo");
    const name = byId("topbarName");

    if (info) info.textContent = "Studio — Dashboard";

    // Optionnel: affiche l’email si l’API Studio répond déjà
    try {
      if (!window.PortalAuthCommon) return;

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      const token = session?.access_token || "";
      if (!token) return;

      const r = await fetch(`${API_BASE}/studio/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await r.json().catch(() => null);
      if (!r.ok || !me) return;

      if (name) name.textContent = (me.email || "Studio");
    } catch (_) {}
  }

  window.addEventListener("DOMContentLoaded", () => {
    tryFillTopbar();
  });
})();