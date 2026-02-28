(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id){ return document.getElementById(id); }

  async function tryFillTopbar() {
    const info = byId("topbarInfo");
    const name = byId("topbarName");

    if (info) info.textContent = "Studio — Dashboard";

    // Si on peut, on affiche l’email connecté (sans bloquer si API pas prête)
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
    } catch (_) {
      // silence: on ne flingue pas l’UI pour un détail
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    // Menu unique: Dashboard
    window.portal.registerMenu({
      view: "dashboard",
      htmlUrl: "/menu_studio/studio_dashboard.html"
    });

    await tryFillTopbar();
  });
})();