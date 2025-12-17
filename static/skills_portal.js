(function () {
  const portal = PortalCommon.createPortal({
    apiBase: "https://skillboard-services.onrender.com",
    queryIdParam: "id",
    topbarInfoText: "Portail Skills — JMB CONSULTANT",
  });

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

  // Placeholders (pour éviter les clics “vides”)
  portal.registerMenu({ view: "vos-collaborateurs", placeholderTitle: "Vos collaborateurs", placeholderSub: "Page à venir: effectifs + détail." });
  portal.registerMenu({ view: "referentiel-competences", placeholderTitle: "Référentiel de compétences", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "cartographie-competences", placeholderTitle: "Cartographie des compétences", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "analyse-risques", placeholderTitle: "Analyse des risques", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-programmer", placeholderTitle: "Actions à programmer", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-en-cours", placeholderTitle: "Actions en cours", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "actions-passees", placeholderTitle: "Actions passées", placeholderSub: "Page à venir." });
  portal.registerMenu({ view: "vos-documents", placeholderTitle: "Vos documents", placeholderSub: "Page à venir." });

  window.addEventListener("DOMContentLoaded", async () => {
    const ok = portal.initShell();
    if (!ok) return;

    // Vue par défaut
    await portal.switchView("dashboard");
  });
})();
