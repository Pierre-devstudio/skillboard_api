(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function setMsg(text, kind) {
    const box = byId("msgBox");
    if (!box) return;
    box.className = "msg" + (kind ? (" " + kind) : "");
    box.textContent = text || "";
  }

  function setPanel(name) {
    const pLogin = byId("panelLogin");
    const pForgot = byId("panelForgot");
    if (!pLogin || !pForgot) return;
    pLogin.classList.toggle("active", name === "login");
    pForgot.classList.toggle("active", name === "forgot");
    setMsg("", "");
  }

  async function loadConfig() {
    const url = `${API_BASE}/portal/config/studio`;
    const r = await fetch(url);
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      const detail = (data && (data.detail || data.message)) ? (data.detail || data.message) : (await r.text().catch(() => ""));
      throw new Error(detail || "Impossible de charger la config du portail.");
    }
    return data;
  }

  async function initSupabase() {
    const cfg = await loadConfig();

    if (!window.PortalAuthCommon) {
      throw new Error("portal_auth_common.js non chargé.");
    }

    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "studio",
      storagePrefix: "sb",
      apiBase: API_BASE,
      contactIdMetaKeys: ["id_owner"], // IMPORTANT: Studio
    });

    return cfg;
  }

  function getRedirectUrlForReset() {
    return `${window.location.origin}/studio_reset_password.html`;
  }

  async function doLogin() {
    const btn = byId("btnLogin");
    const email = (byId("loginEmail")?.value || "").trim();
    const pass = (byId("loginPassword")?.value || "").trim();

    if (!email || !pass) {
      setMsg("Email et mot de passe obligatoires.", "error");
      return;
    }

    try {
      if (btn) btn.disabled = true;
      setMsg("Connexion en cours…", "");

      const res = await window.PortalAuthCommon.signInWithPassword(email, pass);

      // Ici, contactId = id_owner (via metadata ou via /studio/auth/context)
      const ownerId = res?.contactId || window.PortalAuthCommon.getContactId();

      if (!ownerId) {
        setMsg(
          "Connexion OK, mais ce compte n’est pas rattaché à un owner Studio (id_owner manquant).",
          "error"
        );
        return;
      }

      window.location.href = `/studio/?id=${encodeURIComponent(ownerId)}`;
    } catch (e) {
      setMsg(e.message || "Connexion impossible.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendReset() {
    const btn = byId("btnSendReset");
    const email = (byId("resetEmail")?.value || "").trim();

    if (!email) {
      setMsg("Email obligatoire.", "error");
      return;
    }

    try {
      if (btn) btn.disabled = true;
      setMsg("Envoi du lien…", "");

      const redirectTo = getRedirectUrlForReset();
      await window.PortalAuthCommon.sendPasswordResetEmail(email, redirectTo);

      setMsg("Lien envoyé si l’email existe dans le système.", "success");
    } catch (e) {
      setMsg(e.message || "Envoi impossible.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      await initSupabase();

      byId("btnLogin")?.addEventListener("click", doLogin);
      byId("loginPassword")?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") doLogin();
      });

      byId("lnkForgot")?.addEventListener("click", () => setPanel("forgot"));
      byId("lnkBack")?.addEventListener("click", () => setPanel("login"));

      byId("btnSendReset")?.addEventListener("click", sendReset);
    } catch (e) {
      setMsg(e.message || "Erreur initialisation.", "error");
    }
  });
})();