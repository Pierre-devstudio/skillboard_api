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
    const url = `${API_BASE}/portal/config/learn`;
    const r = await fetch(url);
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      const detail = (data && (data.detail || data.message))
        ? (data.detail || data.message)
        : (await r.text().catch(() => ""));
      throw new Error(detail || "Impossible de charger la config du portail.");
    }
    return data;
  }

  async function initSupabase() {
    const cfg = await loadConfig();

    if (!window.PortalAuthCommon) {
      throw new Error("portal_auth_common.js non chargÃ©.");
    }

    window.PortalAuthCommon.init({
      supabaseUrl: cfg.supabase_url,
      supabaseAnonKey: cfg.supabase_anon_key,
      portalKey: "learn",
      storagePrefix: "sb",
    });
  }

  async function activateAccesses() {
    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";

    if (!token) {
      throw new Error("Mot de passe enregistrÃ©, mais session dâ€™activation introuvable. Relance le lien reÃ§u par email.");
    }

    const r = await fetch(`${API_BASE}/learn/auth/activate`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      throw new Error(
        (data && (data.detail || data.message))
          ? (data.detail || data.message)
          : "Mot de passe enregistrÃ©, mais activation des accÃ¨s Learn impossible."
      );
    }

    return data;
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
      setMsg("Mise Ã  jour en coursâ€¦", "");

      await window.PortalAuthCommon.updatePassword(p1);
      await activateAccesses();

      setMsg("Mot de passe mis Ã  jour. Tes accÃ¨s Learn sont actifs. Tu peux te reconnecter.", "success");

      setTimeout(() => {
        window.location.href = "/learn_login.html";
      }, 1000);
    } catch (e) {
      setMsg(e.message || "Mise Ã  jour impossible.", "error");
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
