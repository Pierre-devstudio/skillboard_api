(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id){ return document.getElementById(id); }

  async function loadConfig() {
    const url = `${API_BASE}/portal/config/skills`;
    const r = await fetch(url);
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      // On ne bloque pas le portail si la config n'est pas accessible.
      return null;
    }
    return data;
  }

  async function initAuth() {
    if (!window.PortalAuthCommon) return null;

    const cfg = await loadConfig();
    if (!cfg || !cfg.supabase_url || !cfg.supabase_anon_key) return null;

    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "skills",
      storagePrefix: "sb",
    });

    return cfg;
  }

  async function wireLogout() {
    const btn = byId("btnLogout");
    if (!btn) return;

    const cfg = await initAuth();
    if (!cfg) {
      btn.style.display = "none";
      return;
    }

    // Affiche le bouton uniquement si session active
    let session = null;
    try {
      session = await window.PortalAuthCommon.getSession();
    } catch (_) {}

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
        // même si ça foire, on redirige: l'objectif c'est sortir
      } finally {
        btn.disabled = false;
        window.location.href = (window.PORTAL_LOGIN_URL || "/skills_login.html");
      }
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    wireLogout();
  });
})();
