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

    function buildPortalUrlWithId(contactId) {
        const base = "/skills_portal.html";
        return `${base}?id=${encodeURIComponent(contactId)}`;
    }


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

    async function ensurePortalEntry() {
        // Si l'URL contient déjà ?id=..., on ne touche à rien (legacy intact)
        const id = (getQueryParam("id") || "").trim();
        if (id) return;

        // Pas de ?id=: on tente la session Supabase
        const cfg = await initAuth();
        const loginUrl = (window.PORTAL_LOGIN_URL || "/skills_login.html");

        // Si config Supabase indisponible, on renvoie login (pas d'impasse)
        if (!cfg) {
        window.location.href = loginUrl;
        return;
        }

        // Session ?
        let session = null;
        try {
        session = await window.PortalAuthCommon.getSession();
        } catch (_) {}

        if (!session) {
        window.location.href = loginUrl;
        return;
        }

        // ContactId (id_effectif) : on tente cache local, sinon metadata
        let contactId = null;
        try {
        contactId = window.PortalAuthCommon.getContactId();
        } catch (_) {}

        if (!contactId) {
        try {
            contactId = await window.PortalAuthCommon.ensureContactIdFromSession();
        } catch (_) {}
        }

        if (!contactId) {
        // Connecté mais pas rattaché à un effectif -> retour login (message géré côté login)
        window.location.href = loginUrl;
        return;
        }

        // On reste compatible 100%: on redirige vers le mode legacy ?id=...
        window.location.href = buildPortalUrlWithId(contactId);
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

  window.addEventListener("DOMContentLoaded", async () => {
    await ensurePortalEntry();
    wireLogout();
  });
})();
