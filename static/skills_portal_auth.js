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
        // Cas super-admin: pas besoin d'id_effectif, on entre via X-Ent-Id + scope
        const me = await fetchMe();
        const isSuper = !!(me && me.is_super_admin);

        if (isSuper) {
            // id_contact "dummy": en mode super-admin, il ne sert pas (X-Ent-Id pilote le scope)
            window.location.href = buildPortalUrlWithId("__superadmin__");
            return;
        }

        // User standard: id_effectif obligatoire
        window.location.href = loginUrl;
        return;
        }


        // On reste compatible 100%: on redirige vers le mode legacy ?id=...
        window.location.href = buildPortalUrlWithId(contactId);
    }

    function _entLabel(e) {
        const name = (e?.nom_ent || "").toString().trim();
        const num = (e?.num_entreprise || "").toString().trim();
        if (num) return `${name} (${num})`;
        return name || (e?.id_ent || "");
    }

    function getActiveEntId() {
        try { return (localStorage.getItem("sb_skills_active_ent") || "").trim(); }
        catch (_) { return ""; }
    }

    function setActiveEnt(ent) {
        try {
        localStorage.setItem("sb_skills_active_ent", (ent?.id_ent || "").toString().trim());
        localStorage.setItem("sb_skills_active_ent_label", _entLabel(ent));
        } catch (_) {}
    }

    async function fetchMe() {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token || "";
        if (!token) return null;

        const r = await fetch(`${API_BASE}/skills/me`, {
        headers: { "Authorization": `Bearer ${token}` }
        });

        const data = await r.json().catch(() => null);
        if (!r.ok) return null;
        return data;
    }

    async function fetchScope() {
        // nécessite session
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token || "";
        if (!token) return null;

        const r = await fetch(`${API_BASE}/skills/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
        });

        const data = await r.json().catch(() => null);
        if (!r.ok) return null;
        return data;
    }

    async function wireSuperAdminSelect() {
        const sel = byId("selSuperEnt");
        if (!sel) return;

        const cfg = await initAuth();
        if (!cfg) {
        sel.style.display = "none";
        return;
        }

        // session ?
        let session = null;
        try { session = await window.PortalAuthCommon.getSession(); } catch (_) {}
        if (!session) {
        sel.style.display = "none";
        return;
        }

        const scope = await fetchScope();
        const mode = scope?.mode || "";
        const list = Array.isArray(scope?.entreprises) ? scope.entreprises : [];

        if (mode !== "super_admin" || !list.length) {
        sel.style.display = "none";
        return;
        }

        // show select
        sel.style.display = "inline-flex";

        const current = getActiveEntId();
        sel.innerHTML = "";

        list.forEach((e) => {
        const opt = document.createElement("option");
        opt.value = e.id_ent || "";
        opt.textContent = _entLabel(e);
        sel.appendChild(opt);
        });

        // default selection
        let chosen = null;
        if (current) chosen = list.find(x => (x.id_ent || "") === current) || null;
        if (!chosen) chosen = list[0];

        sel.value = chosen?.id_ent || "";
        setActiveEnt(chosen);

        // changement => on stocke + reload (prépare le futur mode id_ent)
        sel.addEventListener("change", () => {
        const id = (sel.value || "").trim();
        const ent = list.find(x => (x.id_ent || "") === id) || null;
        if (ent) setActiveEnt(ent);

        // Pour l'instant ça ne “bascule” pas les données legacy (elles dépendent de ?id=).
        // Mais ça met en place le contexte X-Ent-Id pour les endpoints qu’on va adapter ensuite.
        try { window.location.reload(); } catch (_) {}
        });
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
    wireSuperAdminSelect();
  });
})();
