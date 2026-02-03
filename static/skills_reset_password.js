(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function setMsg(text, kind) {
    const box = byId("msgBox");
    if (!box) return;
    box.className = "msg" + (kind ? (" " + kind) : "");
    box.textContent = text || "";
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

    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "skills",
      storagePrefix: "sb",
    });

    // Important: supabase-js + detectSessionInUrl=true dans PortalAuthCommon
    // va capter la session recovery depuis l'URL automatiquement.
  }

  async function updatePassword() {
    const btn = byId("btnUpdatePwd");
    const p1 = (byId("pwd1")?.value || "").trim();
    const p2 = (byId("pwd2")?.value || "").trim();

    if (!p1 || !p2) {
      setMsg("Mot de passe et confirmation obligatoires.", "error");
      return;
    }
    if (p1 !== p2) {
      setMsg("Les mots de passe ne correspondent pas.", "error");
      return;
    }

    try {
      if (btn) btn.disabled = true;
      setMsg("Mise à jour en cours…", "");

      await window.PortalAuthCommon.updatePassword(p1);

      setMsg("Mot de passe mis à jour. Tu peux te reconnecter.", "success");

      // Redirection vers login après 1s
      setTimeout(() => {
        window.location.href = "/skills_login.html";
      }, 1000);
    } catch (e) {
      setMsg(e.message || "Mise à jour impossible.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      await initSupabase();
      byId("btnUpdatePwd")?.addEventListener("click", updatePassword);
    } catch (e) {
      setMsg(e.message || "Erreur initialisation.", "error");
    }
  });
})();
