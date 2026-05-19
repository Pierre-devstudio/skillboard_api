(function () {
  const portal = PortalCommon.createPortal({
    apiBase: "https://skillboard-services.onrender.com",
    queryIdParam: "id",
    topbarInfoText: "Portail Skills — JMB CONSULTANT",
  });

    // URL propre: on supprime le #... dès qu'on quitte le planning
  const _origSwitchView = (typeof portal.switchView === "function") ? portal.switchView.bind(portal) : null;
  if (_origSwitchView) {
    portal.switchView = async (viewName, ...args) => {
      const v = String(viewName || "").trim();

      // Toutes les vues "classiques" => URL sans hash
      if (v && v !== "planning-indispo") {
        const base = window.location.pathname + window.location.search;
        if (window.location.hash) {
          history.replaceState(null, document.title, base);
        }
      }

      return await _origSwitchView(viewName, ...args);
    };
  }


    // Contexte + topbar centralisés (évite de dupliquer ensureContext dans chaque menu)
  portal.ensureContext = async () => {
    if (portal.context) return portal.context;
    if (portal._contextPromise) return portal._contextPromise;

    portal._contextPromise = (async () => {
      const ctx = await portal.apiJson(
        `${portal.apiBase}/skills/context/${encodeURIComponent(portal.contactId)}`
      );
      portal.context = ctx;

      const civ = (ctx.civilite || "").trim();
      const prenom = (ctx.prenom || "").trim();
      const nom = (ctx.nom || "").trim();
      const display = [prenom, nom].filter(Boolean).join(" ").trim();

      portal.setTopbar(display || "Contact", portal.topbarInfoText || "Portail Skills — JMB CONSULTANT");
      return ctx;
    })();

    try {
      return await portal._contextPromise;
    } catch (e) {
      portal._contextPromise = null; // autorise un retry en cas d'échec
      throw e;
    }
  };


  // Dashboard (HTML + JS)
  portal.registerMenu({
    view: "dashboard",
    htmlUrl: "/menus/skills_dashboard.html",
    onShow: (p) => window.SkillsDashboard.onShow(p),
  });

  // Vos informations (HTML + JS)
  portal.registerMenu({
    view: "vos-informations",
    htmlUrl: "/menus/skills_informations.html",
    onShow: (p) => window.SkillsInformations.onShow(p),
  });

  // Votre organisation (HTML + JS)
  portal.registerMenu({
    view: "votre-organisation",
    htmlUrl: "/menus/skills_organisation.html",
    jsUrl: "/menus/skills_organisation.js",
    onShow: (p) => window.SkillsOrganisation.onShow(p),
  });

  portal.registerMenu({
    view: "vos-collaborateurs",
    htmlUrl: "/menus/skills_collaborateurs.html",
    onShow: (p) => window.skillsCollaborateurs?.onShow?.(p)
  });

  portal.registerMenu({
    view: "planning-indispo",
    htmlUrl: "/menus/skills_planning_indispo.html",
    jsUrl: "/menus/skills_planning_indispo.js",
    onShow: (p) => window.SkillsPlanningIndispo?.onShow?.(p),
  });


  portal.registerMenu({
    view: "referentiel-competences",
    htmlUrl: "/menus/skills_referentiel_competence.html",
    onShow: (p) => window.SkillsReferentielCompetence.onShow(p),
  });

  portal.registerMenu({
    view: "cartographie-competences",
    htmlUrl: "/menus/skills_cartographie_competences.html",
    jsUrl: "/menus/skills_cartographie_competences.js", // optionnel (auto-guess), mais on le met pour être clair
    onShow: (p) => window.SkillsCartographieCompetences?.onShow?.(p),
  });

  portal.registerMenu({
    view: "analyse-competences",
    htmlUrl: "/menus/skills_analyse.html",
    jsUrl: "/menus/skills_analyse.js",
    onShow: (p) => window.SkillsAnalyse?.onShow?.(p),
  });

  portal.registerMenu({
    view: "besoins-formations",
    htmlUrl: "/menus/skills_besoins_formations.html",
    jsUrl: "/menus/skills_besoins_formations.js",
    onShow: (p) => window.SkillsBesoinsFormations?.onShow?.(p),
  });

  portal.registerMenu({
    view: "entretien-performance",
    htmlUrl: "/menus/skills_entretien_performance.html",
    jsUrl: "/menus/skills_entretien_performance.js",
    onShow: (p) => window.SkillsEntretienPerformance?.onShow?.(p),
  });



  // Placeholders (pour éviter les clics “vides”)
  const COMING_SOON = "/menus/skills_coming_soon.html";

  portal.registerMenu({ view: "simulations-rh", htmlUrl: COMING_SOON });
  portal.registerMenu({ view: "plan-actions", htmlUrl: COMING_SOON });
  portal.registerMenu({ view: "abonnement-facturation", htmlUrl: COMING_SOON });
  portal.registerMenu({ view: "accompagnement", htmlUrl: COMING_SOON });

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      await portal.ensureContext();
    } catch (_) {}

    const getViewFromHash = () => {
      const rawHash = (window.location.hash || "").replace(/^#/, "").trim();
      const view = rawHash ? rawHash.split(/[?&]/)[0].replace(/^\/+/, "").trim() : "";
      return view || "dashboard";
    };

    const initialView = getViewFromHash();
    if (initialView && initialView !== "dashboard") {
      await portal.switchView(initialView);
    }

    window.addEventListener("hashchange", () => {
      const view = getViewFromHash();
      if (view) portal.switchView(view);
    });
  });
})();
