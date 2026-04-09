(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  // IMPORTANT : enregistrer les menus AVANT portal.init()
  window.portal.registerMenu({
    view: "dashboard",
    htmlUrl: "/menu_studio/studio_dashboard.html"
    // js auto-guess -> /menu_studio/studio_dashboard.js
  });

  window.portal.registerMenu({
    view: "data",
    htmlUrl: "/menu_studio/studio_data.html"
    // js auto-guess -> /menu_studio/studio_data.js
  });

  window.portal.registerMenu({
    view: "organisation",
    htmlUrl: "/menu_studio/studio_organisation.html"
    // js auto-guess -> /menu_studio/studio_organisation.js
  });

  window.portal.registerMenu({
    view: "catalog_postes",
    htmlUrl: "/menu_studio/studio_catalog_postes.html"
    // js auto-guess -> /menu_studio/studio_catalog_postes.js
  });

  window.portal.registerMenu({
    view: "catalog_competences",
    htmlUrl: "/menu_studio/studio_catalog_competences.html"
    // js auto-guess -> /menu_studio/studio_catalog_competences.js
  });

  window.portal.registerMenu({
    view: "collaborateurs",
    htmlUrl: "/menu_studio/studio_collaborateurs.html"
    // js auto-guess -> /menu_studio/studio_collaborateurs.js
  });

  window.portal.registerMenu({
    view: "clients",
    htmlUrl: "/menu_studio/studio_clients.html"
    // js auto-guess -> /menu_studio/studio_clients.js
  });

  // Placeholders (menu complet)
  const COMING_SOON = "/menu_studio/studio_coming_soon.html";
  
  window.portal.registerMenu({ view: "access", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "partners", htmlUrl: COMING_SOON });

  
  window.portal.registerMenu({ view: "catalog_formations", htmlUrl: COMING_SOON });

  window.portal.registerMenu({ view: "pilotage_clients", htmlUrl: COMING_SOON });

  window.portal.registerMenu({ view: "factures", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "documents", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "evolutions", htmlUrl: COMING_SOON });

  function byId(id){ return document.getElementById(id); }

    function roleRank(code){
    const c = (code || "").toString().trim().toLowerCase();
    if (c === "admin") return 3;
    if (c === "editor") return 2;
    return 1; // user
  }

  function applyMenuGating(roleCode){
    window.__studioRoleCode = (roleCode || "user").toString().trim().toLowerCase();

    const myRank = roleRank(window.__studioRoleCode);

    document.querySelectorAll(".menu-item[data-min-role]").forEach(el => {
      const need = (el.dataset.minRole || "user").toString().trim().toLowerCase();
      const ok = myRank >= roleRank(need);
      el.style.display = ok ? "" : "none";
    });

    // Nettoyage separators: pas de séparateur seul / double
    const menu = document.querySelector(".menu");
    if (!menu) return;

    const kids = Array.from(menu.children);

    // 1) cacher les sep sans voisin visible
    kids.forEach((el, idx) => {
      if (!el.classList.contains("menu-sep")) return;

      const prev = kids.slice(0, idx).reverse().find(x => x.style.display !== "none" && !x.classList.contains("menu-sep"));
      const next = kids.slice(idx + 1).find(x => x.style.display !== "none" && !x.classList.contains("menu-sep"));

      el.style.display = (prev && next) ? "" : "none";
    });

    // 2) cacher les doubles sep
    let lastSepVisible = false;
    kids.forEach(el => {
      const isSep = el.classList.contains("menu-sep") && el.style.display !== "none";
      if (isSep && lastSepVisible) el.style.display = "none";
      lastSepVisible = isSep;
    });
  }

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
      let roleCode = "user";

      if (rScope.ok && scope && Array.isArray(scope.owners) && scope.owners.length) {
        const currentId = (new URL(window.location.href).searchParams.get("id") || "").trim();
        const found = currentId ? scope.owners.find(o => o && o.id_owner === currentId) : null;
        const cur = found || scope.owners[0] || null;

        ownerName = (cur?.nom_owner || "").trim();
        roleCode = (cur?.role_code || "user").toString().trim().toLowerCase();
      }

      if (name) name.textContent = ownerName || "Studio";
      applyMenuGating(roleCode);
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