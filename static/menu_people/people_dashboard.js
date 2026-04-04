(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function getEffectifId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;

    const qid = new URL(window.location.href).searchParams.get("id");
    return (qid || "").trim();
  }

  async function fetchContext() {
    await (window.__peopleAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return null;

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return null;

    const idEffectif = getEffectifId();
    if (!idEffectif) return null;

    const r = await fetch(`${API_BASE}/people/context/${encodeURIComponent(idEffectif)}`, {
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
    const introEl = byId("welcomeIntro");

    if (!titleEl) return;

    const ctx = await fetchContext();
    const prenom = (ctx?.prenom || "").toString().trim();
    const ent = (ctx?.nom_owner || "").toString().trim();

    if (!prenom) {
      if (prenomEl) prenomEl.textContent = "";
      if (commaEl) commaEl.style.display = "none";
      titleEl.textContent = "Bienvenue";
    } else {
      if (prenomEl) prenomEl.textContent = prenom;
      if (commaEl) commaEl.style.display = "";
    }

    if (introEl) {
      if (ent) {
        introEl.textContent = `Cet espace vous permet d’accéder à vos informations People pour ${ent}.`;
      } else {
        introEl.textContent = "Cet espace vous permet d’accéder à vos informations People.";
      }
    }
  }

  applyWelcome();
})();