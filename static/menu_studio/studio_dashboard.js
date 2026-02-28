// menu_studio/studio_dashboard.js
(function () {
  function byId(id) { return document.getElementById(id); }

  async function loadMe() {
    const base = String((window.portal && window.portal.apiBase) || "https://skillboard-services.onrender.com").replace(/\/+$/, "");
    const url = `${base}/studio/me`;

    if (!window.portal || typeof window.portal.apiJson !== "function") return null;

    try {
      return await window.portal.apiJson(url);
    } catch (_) {
      return null;
    }
  }

  async function applyWelcome() {
    const prenomEl = byId("welcomePrenom");
    const commaEl = byId("welcomeComma");
    const titleEl = byId("welcomeTitle");

    if (!titleEl) return;

    const me = await loadMe();
    const prenom = (me && me.prenom) ? String(me.prenom).trim() : "";

    if (!prenom) {
      // fallback propre si pas de mapping renseigné
      if (prenomEl) prenomEl.textContent = "";
      if (commaEl) commaEl.style.display = "none";
      titleEl.textContent = "Bienvenue";
      return;
    }

    if (prenomEl) prenomEl.textContent = prenom;
    if (commaEl) commaEl.style.display = "";
  }

  applyWelcome();
})();