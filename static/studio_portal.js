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

      // 1) Me (email)
      const rMe = await fetch(`${API_BASE}/studio/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await rMe.json().catch(() => null);
      if (!rMe.ok || !me) return;

      // 2) Scope (owner name)
      let ownerName = "";
      const rScope = await fetch(`${API_BASE}/studio/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const scope = await rScope.json().catch(() => null);

      if (rScope.ok && scope && Array.isArray(scope.owners) && scope.owners.length) {
        const currentId =
          (window.portal && window.portal.contactId) ||
          (new URL(window.location.href).searchParams.get("id") || "");

        if (currentId && currentId !== "__superadmin__") {
          const found = scope.owners.find(o => (o && o.id_owner) === currentId);
          ownerName = found ? (found.nom_owner || "") : "";
        }

        // standard: 1 owner attendu
        if (!ownerName && scope.mode === "standard") {
          ownerName = scope.owners[0]?.nom_owner || "";
        }

        // super_admin sans owner sélectionné
        if (!ownerName && scope.mode === "super_admin") {
          ownerName = "Super admin";
        }
      }

      // Affichage demandé : email + nom owner
      if (name) name.textContent = ownerName || "Studio";
      if (info) info.textContent = (me.email || "");
    } catch (_) {
      // silencieux: topbar reste sur fallback
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    tryFillTopbar();
  });
})();