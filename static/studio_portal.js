(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const COMING_SOON = "/menu_studio/studio_coming_soon.html";

  function byId(id){ return document.getElementById(id); }

  function registerView(view, htmlUrl){
    window.portal.registerMenu({ view, htmlUrl });
  }

  function updateComingSoonTitle(){
    const active = document.querySelector(".menu-item.active");
    const title = active ? active.textContent.trim() : "Fonctionnalité";
    const section = document.querySelector("#viewsMount section[style*='block']") || document.querySelector("section[id^='view-']:not([style*='none'])");
    const el = section ? section.querySelector("#comingSoonTitle") : byId("comingSoonTitle");
    if (el) el.textContent = title;
  }

  function registerSoon(view){
    window.portal.registerMenu({
      view,
      htmlUrl: COMING_SOON,
      onShow: updateComingSoonTitle
    });
  }

  // IMPORTANT : enregistrer les menus AVANT portal.init()
  registerView("dashboard", "/menu_studio/studio_dashboard.html");
  registerView("data", "/menu_studio/studio_data.html");
  registerView("organisation", "/menu_studio/studio_organisation.html");
  registerView("collaborateurs", "/menu_studio/studio_collaborateurs.html");
  registerView("catalog_postes", "/menu_studio/studio_catalog_postes.html");
  registerView("catalog_competences", "/menu_studio/studio_catalog_competences.html");
  registerView("clients", "/menu_studio/studio_clients.html");
  registerView("planification_rh", "/menu_studio/studio_planification_rh.html");
  registerView("calendrier_rh", "/menu_studio/studio_calendrier_rh.html");

  registerSoon("cartographie_competences");
  registerSoon("analyse_rh");
  registerSoon("demandes_rh");
  registerSoon("simulateur_rh");
  registerSoon("arbitrages_rh");
  registerSoon("plan_actions");
  registerSoon("synthese_multisite");
  registerSoon("console_status");
  registerSoon("abonnement_facturation");
  registerSoon("parametres");
  registerSoon("accompagnement");

  function roleRank(code){
    const c = (code || "").toString().trim().toLowerCase();
    if (c === "admin") return 3;
    if (c === "supervisor") return 2;
    return 1;
  }

  function cleanupMenuSeparators(){
    const menu = document.querySelector(".menu");
    if (!menu) return;

    const kids = Array.from(menu.children);
    const isSeparator = (el) => el.classList.contains("menu-separator") || el.classList.contains("menu-sep");
    const isVisible = (el) => el.style.display !== "none";

    kids.forEach((el, idx) => {
      if (!isSeparator(el)) return;

      const prev = kids.slice(0, idx).reverse().find(x => isVisible(x) && !isSeparator(x));
      const next = kids.slice(idx + 1).find(x => isVisible(x) && !isSeparator(x));
      el.style.display = (prev && next) ? "" : "none";
    });

    let lastSepVisible = false;
    kids.forEach(el => {
      const sepVisible = isSeparator(el) && isVisible(el);
      if (sepVisible && lastSepVisible) el.style.display = "none";
      lastSepVisible = sepVisible;
    });
  }

  function applyMenuGating(roleCode){
    window.__studioRoleCode = (roleCode || "user").toString().trim().toLowerCase();
    const myRank = roleRank(window.__studioRoleCode);

    document.querySelectorAll(".menu-item[data-min-role], .menu-section-title[data-min-role]").forEach(el => {
      const need = (el.dataset.minRole || "user").toString().trim().toLowerCase();
      el.style.display = myRank >= roleRank(need) ? "" : "none";
    });

    cleanupMenuSeparators();
  }

  function closeSettingsMenu(){
    const btn = byId("btnStudioSettings");
    const menu = byId("studioSettingsMenu");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (menu){
      menu.classList.remove("is-open");
      menu.setAttribute("aria-hidden", "true");
    }
  }

  function toggleSettingsMenu(){
    const btn = byId("btnStudioSettings");
    const menu = byId("studioSettingsMenu");
    if (!btn || !menu) return;
    const open = !menu.classList.contains("is-open");
    menu.classList.toggle("is-open", open);
    menu.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function bindCalendarButton(){
    const btn = byId("btnStudioRhCalendar");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      closeSettingsMenu();
      if (window.portal && typeof window.portal.switchView === "function") {
        await window.portal.switchView("calendrier_rh");
      }
    });
  }

  function bindSettingsMenu(){
    const btn = byId("btnStudioSettings");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleSettingsMenu();
    });

    document.querySelectorAll("[data-settings-view]").forEach(item => {
      item.addEventListener("click", async () => {
        const view = item.getAttribute("data-settings-view") || "";
        closeSettingsMenu();
        if (view && window.portal && typeof window.portal.switchView === "function") {
          await window.portal.switchView(view);
        }
      });
    });

    document.addEventListener("click", (ev) => {
      const wrap = ev.target.closest?.(".studio-settings-wrap");
      if (!wrap) closeSettingsMenu();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeSettingsMenu();
    });
  }

  async function tryFillTopbar() {
    const info = byId("topbarInfo");
    const userName = byId("topbarUserName");
    const userRole = byId("topbarUserRole");
    const name = byId("topbarName");
    const subtitle = byId("topbarSubtitle");

    if (info) info.style.display = "";
    if (userName) userName.textContent = "Chargement…";
    if (userRole) userRole.textContent = "";
    if (name) name.textContent = "Studio";
    if (subtitle) subtitle.textContent = "Console Studio · Abonnement actif";

    try {
      if (!window.PortalAuthCommon) return;

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      const token = session?.access_token || "";
      if (!token) return;

      let displayName = "";
      let fallbackEmail = "";

      const rMe = await fetch(`${API_BASE}/studio/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await rMe.json().catch(() => null);

      if (rMe.ok && me) {
        const prenom = (me.prenom || "").toString().trim();
        const nom = (me.nom || "").toString().trim();
        fallbackEmail = (me.email || "").toString().trim();
        displayName = `${prenom} ${nom}`.trim() || fallbackEmail;
      }

      const rScope = await fetch(`${API_BASE}/studio/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const scope = await rScope.json().catch(() => null);

      let ownerName = "";
      let roleCode = "user";
      let roleLabel = "Utilisateur";

      if (rScope.ok && scope && Array.isArray(scope.owners) && scope.owners.length) {
        const currentId = (new URL(window.location.href).searchParams.get("id") || "").trim();
        const found = currentId ? scope.owners.find(o => o && o.id_owner === currentId) : null;
        const cur = found || scope.owners[0] || null;

        ownerName = (cur?.nom_owner || "").trim();
        roleCode = (cur?.role_code || "user").toString().trim().toLowerCase();
        roleLabel = (cur?.role_label || "Utilisateur").toString().trim();
      }

      if (name) name.textContent = ownerName ? `${ownerName} (Studio)` : "Studio";
      if (subtitle) subtitle.textContent = "Console Studio · Abonnement actif";
      if (userName) userName.textContent = displayName || "Utilisateur";
      if (userRole) userRole.textContent = roleLabel || "Utilisateur";

      applyMenuGating(roleCode);
    } catch (_) {
      if (userName) userName.textContent = "Utilisateur";
      if (userRole) userRole.textContent = "";
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    bindSettingsMenu();
    bindCalendarButton();
    applyMenuGating("user");
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    tryFillTopbar();
  });
})();
