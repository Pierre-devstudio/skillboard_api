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

    if (info) info.textContent = "Chargement…";
    if (name) name.textContent = "Studio";

    try {
      if (!window.PortalAuthCommon) return;

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      const token = session?.access_token || "";
      if (!token) return;

      // 1) Email
      const rMe = await fetch(`${API_BASE}/studio/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await rMe.json().catch(() => null);
      if (rMe.ok && me) {
        if (info) info.textContent = (me.email || "");
      }

      // 2) Nom owner (scope)
      const rScope = await fetch(`${API_BASE}/studio/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const scope = await rScope.json().catch(() => null);

      let ownerName = "";
      if (rScope.ok && scope && Array.isArray(scope.owners) && scope.owners.length) {
        const currentId = (new URL(window.location.href).searchParams.get("id") || "").trim();
        const found = currentId ? scope.owners.find(o => o && o.id_owner === currentId) : null;
        ownerName = (found?.nom_owner || scope.owners[0]?.nom_owner || "").trim();
      }

      if (name) name.textContent = ownerName || "Studio";
    } catch (_) {
      // on laisse le fallback
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    // Attendre explicitement l'init auth (pas un pari à 0ms)
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    tryFillTopbar();
  });
})();