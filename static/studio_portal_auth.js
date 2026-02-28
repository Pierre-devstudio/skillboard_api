(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id){ return document.getElementById(id); }

  function getQueryParam(name) {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get(name);
    } catch (_) {
      return null;
    }
  }

  function buildPortalUrlWithId(ownerId) {
    const base = "/studio/";
    return `${base}?id=${encodeURIComponent(ownerId)}`;
  }

  async function loadConfig() {
    const url = `${API_BASE}/portal/config/studio`;
    const r = await fetch(url);
    const data = await r.json().catch(() => null);
    if (!r.ok) return null;
    return data;
  }

  async function initAuth() {
    if (!window.PortalAuthCommon) return null;

    const cfg = await loadConfig();
    if (!cfg || !cfg.supabase_url || !cfg.supabase_anon_key) return null;

    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "studio",
      storagePrefix: "sb",
      apiBase: API_BASE,
      contactIdMetaKeys: ["id_owner"], // Studio = id_owner
    });

    return cfg;
  }

  async function ensurePortalEntry() {
    // Si l'URL contient déjà ?id=..., on ne touche à rien
    const id = (getQueryParam("id") || "").trim();
    if (id) {
      // Même avec ?id= présent, on doit init Supabase Auth
      // sinon topbar / apiJson ne peuvent pas lire la session.
      await initAuth();
      return;
    }

    // Pas de ?id=: on tente la session Supabase
    const cfg = await initAuth();
    const loginUrl = (window.PORTAL_LOGIN_URL || "/studio_login.html");

    if (!cfg) {
      window.location.href = loginUrl;
      return;
    }

    // Session ?
    let session = null;
    try { session = await window.PortalAuthCommon.getSession(); } catch (_) {}

    if (!session) {
      window.location.href = loginUrl;
      return;
    }

    // OwnerId (id_owner): cache local, sinon metadata, sinon fallback API (via PortalAuthCommon)
    let ownerId = null;
    try { ownerId = window.PortalAuthCommon.getContactId(); } catch (_) {}

    if (!ownerId) {
      try { ownerId = await window.PortalAuthCommon.ensureContactIdFromSession(); } catch (_) {}
    }

    if (!ownerId) {
      window.location.href = loginUrl;
      return;
    }

    window.location.href = buildPortalUrlWithId(ownerId);
  }

  async function wireLogout() {
    const btn = byId("btnLogout");
    if (!btn) return;

    const cfg = await initAuth();
    if (!cfg) {
      btn.style.display = "none";
      return;
    }

    let session = null;
    try { session = await window.PortalAuthCommon.getSession(); } catch (_) {}

    if (!session) {
      btn.style.display = "none";
      return;
    }

    btn.style.display = "inline-flex";

    btn.addEventListener("click", async () => {
      try {
        btn.disabled = true;
        await window.PortalAuthCommon.signOut();
      } catch (_) {
        // même si ça foire, on redirige
      } finally {
        btn.disabled = false;
        window.location.href = (window.PORTAL_LOGIN_URL || "/studio_login.html");
      }
    });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    await ensurePortalEntry();
    wireLogout();
  });
})();