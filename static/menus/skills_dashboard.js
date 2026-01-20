(function () {
  
  window.SkillsDashboard = {
    onShow: async (portal) => {
      try {
        await portal.ensureContext();
      } catch (e) {
        portal.showAlert("error", "Erreur de chargement du contexte : " + e.message);
        portal.setTopbar("Contact", "Portail Skills — JMB CONSULTANT");
      }
    }
  };
})();
