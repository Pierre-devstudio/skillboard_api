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
    const url = `${API_BASE}/portal/config/skills`;
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

    // Init client Supabase avec storage isolé par portail
    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "skills",
      storagePrefix: "sb",
      apiBase: API_BASE,
    });

    return cfg;
  }

  function getRedirectUrlForReset() {
    // Les fichiers statics sont servis à la racine dans ton portail (cf /skills_portal.js)
    // Donc la page reset sera: /skills_reset_password.html
    return `${window.location.origin}/skills_reset_password.html`;
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

      // contactId (id_effectif) doit venir du user_metadata côté Supabase
      const contactId = res?.contactId || window.PortalAuthCommon.getContactId();

      if (!contactId) {
        setMsg(
          "Connexion OK, mais ce compte n’est pas rattaché à un effectif Skills (id_effectif manquant).",
          "error"
        );
        return;
      }

      // On reste compatible 100% legacy: portail actuel = ?id=...
      window.location.href = `/insights/?id=${encodeURIComponent(contactId)}`;
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

  // Wiring
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      await initSupabase();

      // UI handlers
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
