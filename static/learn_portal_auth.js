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

  function buildPortalUrlWithId(effectifId) {
    const base = "/learn/";
    return `${base}?id=${encodeURIComponent(effectifId)}`;
  }

  window.__learnAuthReady = null;

  async function loadConfig() {
    const url = `${API_BASE}/portal/config/learn`;
    const r = await fetch(url);
    const data = await r.json().catch(() => null);
    if (!r.ok) return null;
    return data;
  }

  async function fetchAuthContext(token) {
    const r = await fetch(`${API_BASE}/learn/auth/context`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) return null;
    return data;
  }

  async function initAuth() {
    if (window.__learnAuthReady) return window.__learnAuthReady;

    window.__learnAuthReady = (async () => {
      if (!window.PortalAuthCommon) return null;

      const cfg = await loadConfig();
      if (!cfg || !cfg.supabase_url || !cfg.supabase_anon_key) return null;

      window.PortalAuthCommon.init({
        supabaseUrl: cfg.supabase_url,
        supabaseAnonKey: cfg.supabase_anon_key,
        portalKey: "learn",
        storagePrefix: "sb",
        apiBase: API_BASE,
        contactIdMetaKeys: ["id_effectif", "id_contact"],
      });

      return cfg;
    })();

    try {
      return await window.__learnAuthReady;
    } catch (e) {
      window.__learnAuthReady = null;
      throw e;
    }
  }

  async function ensurePortalEntry() {
    const id = (getQueryParam("id") || "").trim();
    if (id) {
      await initAuth();
      return;
    }

    const cfg = await initAuth();
    const loginUrl = (window.PORTAL_LOGIN_URL || "/learn_login.html");

    if (!cfg) {
      window.location.href = loginUrl;
      return;
    }

    let session = null;
    try { session = await window.PortalAuthCommon.getSession(); } catch (_) {}

    if (!session) {
      window.location.href = loginUrl;
      return;
    }

    const token = session?.access_token || "";
    if (!token) {
      window.location.href = loginUrl;
      return;
    }

    let effectifId = null;

    try { effectifId = window.PortalAuthCommon.getContactId(); } catch (_) {}
    if (!effectifId) {
      try { effectifId = await window.PortalAuthCommon.ensureContactIdFromSession(); } catch (_) {}
    }

    if (!effectifId) {
      const ctx = await fetchAuthContext(token);
      effectifId = (ctx?.id_effectif || "").trim();
    }

    if (!effectifId) {
      window.location.href = loginUrl;
      return;
    }

    window.location.href = buildPortalUrlWithId(effectifId);
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
      } finally {
        btn.disabled = false;
        window.location.href = (window.PORTAL_LOGIN_URL || "/learn_login.html");
      }
    });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    await ensurePortalEntry();
    wireLogout();
  });
})();