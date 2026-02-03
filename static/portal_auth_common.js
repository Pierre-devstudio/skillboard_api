/* ======================================================
   portal_auth_common.js
   - Wrapper Supabase Auth (multi-portails)
   - Stocke un "contactId" (id_effectif) pour alimenter le portail
   - Support "mot de passe oublié" (reset email + update password)
   ====================================================== */

(function () {
  const g = window;

  // Namespace global
  const AuthCommon = g.PortalAuthCommon || {};

  // Etat interne
  let _client = null;
  let _cfg = {
    supabaseUrl: null,
    supabaseAnonKey: null,
    storagePrefix: "sb",          // prefix global
    portalKey: "generic",         // ex: "skills", "people", "partner"
    apiBase: null,               // ex: "https://xxx.onrender.com" (pour appeler /skills/me)
    contactIdMetaKeys: ["id_effectif", "contact_id", "id_contact"], // ordre de fallback
  };

  function _storageKey(suffix) {
    return `${_cfg.storagePrefix}_${_cfg.portalKey}_${suffix}`;
  }

  function _setLocal(key, val) {
    try {
      if (val === null || val === undefined || val === "") localStorage.removeItem(key);
      else localStorage.setItem(key, String(val));
    } catch (_) {}
  }

  function _getLocal(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function _requireSupabaseLoaded() {
    // Tu chargeras supabase-js dans la page login/reset (pas dans le portail)
    // Ici on vérifie juste qu'on a bien la factory.
    const supa = g.supabase;
    if (!supa || typeof supa.createClient !== "function") {
      throw new Error("Supabase JS non chargé (window.supabase.createClient introuvable).");
    }
    return supa;
  }

  function init(config) {
    const c = config || {};

    _cfg.supabaseUrl = c.supabaseUrl || _cfg.supabaseUrl;
    _cfg.supabaseAnonKey = c.supabaseAnonKey || _cfg.supabaseAnonKey;
    _cfg.portalKey = c.portalKey || _cfg.portalKey;
    _cfg.apiBase = c.apiBase || _cfg.apiBase;
    _cfg.storagePrefix = c.storagePrefix || _cfg.storagePrefix;

    if (!_cfg.supabaseUrl || !_cfg.supabaseAnonKey) {
      // On n'explose pas au init si tu n'as pas encore injecté les clés,
      // mais toute action Auth lèvera une erreur claire.
      _client = null;
      return null;
    }

    const supa = _requireSupabaseLoaded();

    // storageKey dédié par portail
    const storageKey = _storageKey("auth");

    _client = supa.createClient(_cfg.supabaseUrl, _cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: localStorage,
        storageKey: storageKey,
        detectSessionInUrl: true, // utile pour reset password (recovery)
      },
    });

    return _client;
  }

  function getClient() {
    if (_client) return _client;
    // si init pas fait / pas de clés -> erreur explicite
    if (!_cfg.supabaseUrl || !_cfg.supabaseAnonKey) {
      throw new Error("Supabase non initialisé: supabaseUrl / supabaseAnonKey manquants.");
    }
    // si supabase-js pas chargé
    _requireSupabaseLoaded();
    throw new Error("Supabase non initialisé: appelle PortalAuthCommon.init({...}) avant.");
  }

  function _extractContactIdFromUser(user) {
    if (!user) return null;

    const meta = user.user_metadata || {};
    for (const k of _cfg.contactIdMetaKeys) {
      const v = meta[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
    }

    // fallback optionnel: si tu décides plus tard de le mettre dans app_metadata
    const appMeta = user.app_metadata || {};
    for (const k of _cfg.contactIdMetaKeys) {
      const v = appMeta[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
    }

    return null;
  }

  async function _fetchSkillsContextFromApi(accessToken) {
    try {
      const token = (accessToken || "").trim();
      const base = (_cfg.apiBase || "").trim();
      if (!token || !base) return null;
      if (_cfg.portalKey !== "skills") return null;

      const r = await fetch(`${base}/skills/auth/context`, {
        headers: { "Authorization": `Bearer ${token}` }
      });

      const ctx = await r.json().catch(() => null);
      if (!r.ok) return null;
      return ctx;
    } catch (_) {
      return null;
    }
  }



  // ---- ContactId (cache local) ----
  function setContactId(contactId) {
    _setLocal(_storageKey("contact_id"), contactId);
  }

  function getContactId() {
    return _getLocal(_storageKey("contact_id"));
  }

  function clearContactId() {
    _setLocal(_storageKey("contact_id"), null);
  }

  // ---- Auth ----
  async function signInWithPassword(email, password) {
    const client = getClient();
    const e = (email || "").trim();
    const p = (password || "").trim();

    if (!e || !p) throw new Error("Email et mot de passe obligatoires.");

    const { data, error } = await client.auth.signInWithPassword({ email: e, password: p });
    if (error) throw new Error(error.message || "Connexion impossible.");

    const user = data?.user || null;
    let contactId = _extractContactIdFromUser(user);

    // Standard: on stocke le contactId si dispo
    if (contactId) {
      setContactId(contactId);
      return { user, session: data?.session || null, contactId };
    }

    // Pas de metadata: on demande le contexte à l'API Skillboard
    const token = data?.session?.access_token || "";
    const ctx = await _fetchSkillsContextFromApi(token);

    // Super-admin: pas besoin d'id_effectif
    if (ctx && ctx.is_super_admin) {
      contactId = "__superadmin__";
      setContactId(contactId);
      return { user, session: data?.session || null, contactId };
    }

    // User client: mapping DB -> id_effectif
    if (ctx && ctx.id_effectif) {
      contactId = String(ctx.id_effectif).trim();
      if (contactId) {
        setContactId(contactId);
        return { user, session: data?.session || null, contactId };
      }
    }

    return { user, session: data?.session || null, contactId: null };


  }

  async function signOut() {
    const client = getClient();
    await client.auth.signOut();
    clearContactId();
  }

  async function getSession() {
    const client = getClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw new Error(error.message || "Session illisible.");
    return data?.session || null;
  }

  async function ensureContactIdFromSession() {
    const client = getClient();
    const { data, error } = await client.auth.getUser();
    if (error) return null;

    const user = data?.user || null;
    let contactId = _extractContactIdFromUser(user);

    if (contactId) {
      setContactId(contactId);
      return contactId;
    }

    // Pas de metadata: on demande le contexte à l'API Skillboard
    const session = await getSession().catch(() => null);
    const token = session?.access_token || "";
    const ctx = await _fetchSkillsContextFromApi(token);

    if (ctx && ctx.is_super_admin) {
      contactId = "__superadmin__";
      setContactId(contactId);
      return contactId;
    }

    if (ctx && ctx.id_effectif) {
      contactId = String(ctx.id_effectif).trim();
      if (contactId) {
        setContactId(contactId);
        return contactId;
      }
    }

    return null;


  }

  async function sendPasswordResetEmail(email, redirectTo) {
    const client = getClient();
    const e = (email || "").trim();
    if (!e) throw new Error("Email obligatoire.");

    const opts = {};
    if (redirectTo) opts.redirectTo = redirectTo;

    const { data, error } = await client.auth.resetPasswordForEmail(e, opts);
    if (error) throw new Error(error.message || "Envoi reset impossible.");
    return data || {};
  }

  async function updatePassword(newPassword) {
    const client = getClient();
    const p = (newPassword || "").trim();
    if (!p) throw new Error("Mot de passe obligatoire.");

    const { data, error } = await client.auth.updateUser({ password: p });
    if (error) throw new Error(error.message || "Mise à jour du mot de passe impossible.");
    return data || {};
  }

  // ---- Helpers navigation (optionnels) ----
  function redirect(url) {
    if (!url) return;
    try {
      window.location.href = url;
    } catch (_) {}
  }

  AuthCommon.init = init;
  AuthCommon.getClient = getClient;

  AuthCommon.setContactId = setContactId;
  AuthCommon.getContactId = getContactId;
  AuthCommon.clearContactId = clearContactId;

  AuthCommon.signInWithPassword = signInWithPassword;
  AuthCommon.signOut = signOut;
  AuthCommon.getSession = getSession;
  AuthCommon.ensureContactIdFromSession = ensureContactIdFromSession;

  AuthCommon.sendPasswordResetEmail = sendPasswordResetEmail;
  AuthCommon.updatePassword = updatePassword;

  AuthCommon.redirect = redirect;

  g.PortalAuthCommon = AuthCommon;
})();
