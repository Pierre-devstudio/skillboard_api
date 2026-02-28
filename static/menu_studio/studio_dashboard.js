(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function getOwnerId() {
    // Source prioritaire: portal.contactId (si déjà initialisé)
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;

    // Fallback: querystring ?id=
    const qid = new URL(window.location.href).searchParams.get("id");
    return (qid || "").trim();
  }

  async function fetchContext() {
    await (window.__studioAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return null;

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return null;

    const idOwner = getOwnerId();
    if (!idOwner || idOwner === "__superadmin__") return null;

    const r = await fetch(`${API_BASE}/studio/context/${encodeURIComponent(idOwner)}`, {
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

    const ctx = await fetchContext();
    const prenom = (ctx?.prenom || "").toString().trim();

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