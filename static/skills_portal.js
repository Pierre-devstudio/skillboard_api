(function () {
  const portal = PortalCommon.createPortal({
    apiBase: "https://skillboard-services.onrender.com",
    queryIdParam: "id",
    topbarInfoText: "Portail Skills — JMB CONSULTANT",
  });

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
      const display = [civ, prenom, nom].filter(Boolean).join(" ").trim();

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
  view: "entretien-performance",
  htmlUrl: "/menus/skills_entretien_performance.html",
  jsUrl: "/menus/skills_entretien_performance.js",
  onShow: (p) => window.SkillsEntretienPerformance?.onShow?.(p),
  });

  // Placeholders (pour éviter les clics “vides”)      
  portal.registerMenu({ view: "catalogue-formation", placeholderTitle: "Votre catalogue de formation", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-programmer", placeholderTitle: "Actions à programmer", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-en-cours", placeholderTitle: "Actions en cours", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-passees", placeholderTitle: "Actions passées", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "vos-documents", placeholderTitle: "Vos documents", placeholderSub: "Page à venir." });

  window.addEventListener("DOMContentLoaded", async () => {
    const ok = portal.initShell();
    if (!ok) return;

    await portal.ensureContext();
    // Vue par défaut
    await portal.switchView("dashboard");
  });
})();
