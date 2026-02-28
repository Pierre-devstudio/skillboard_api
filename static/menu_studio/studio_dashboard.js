(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  async function fetchMe() {
    await (window.__studioAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return null;

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return null;

    const r = await fetch(`${API_BASE}/studio/me`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) return null;
    return data;
  }

  async function applyWelcome() {
    const prenomEl = byId("welcomePrenom");
    const commaEl = byId("welcomeComma");
    const titleEl = byId("welcomeTitle");
    if (!titleEl) return;

    const me = await fetchMe();
    const prenom = (me?.prenom || "").toString().trim();

    if (!prenom) {
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