(function () {
  let _bound = false;
  let _config = null;

  function byId(id){ return document.getElementById(id); }

  function getEffectifId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function htmlEsc(v){
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getErrorMessage(err){
    if (!err) return "Erreur inconnue.";
    if (typeof err === "string") return err;

    if (err.message && typeof err.message === "string" && err.message !== "[object Object]"){
      return err.message;
    }

    if (err.detail){
      if (typeof err.detail === "string") return err.detail;

      try{
        return JSON.stringify(err.detail, null, 2);
      } catch(_){}
    }

    try{
      const txt = JSON.stringify(err, null, 2);
      if (txt && txt !== "{}") return txt;
    } catch(_){}

    return "Erreur inconnue.";
  }

  function setStatus(msg, kind){
    const el = byId("learnLmsStatus");
    if (!el) return;

    el.classList.remove("is-ok", "is-error");

    if (!msg){
      el.textContent = "";
      return;
    }

    el.textContent = msg;

    if (kind === "ok") el.classList.add("is-ok");
    if (kind === "error") el.classList.add("is-error");
  }

  function setSuccess(msg){
    const el = byId("learnLmsSaveSuccess");
    if (!el) return;

    window.clearTimeout(el._hideTimer);

    if (!msg){
      el.style.display = "none";
      el.textContent = "";
      return;
    }

    el.textContent = msg;
    el.style.display = "inline-flex";

    el._hideTimer = window.setTimeout(() => {
      el.style.display = "none";
      el.textContent = "";
    }, 5000);
  }

  function syncProviderFields(){
    const provider = byId("learnLmsProvider")?.value || "manual";
    const fields = byId("learnLmsLaraFields");
    const testBtn = byId("btnLearnLmsTest");

    if (fields) fields.style.display = provider === "lara" ? "grid" : "none";
    if (testBtn) testBtn.style.display = provider === "lara" ? "" : "none";
  }

  function fillConfig(cfg){
    _config = cfg || {};

    const provider = byId("learnLmsProvider");
    const base = byId("learnLmsBaseUrl");
    const api = byId("learnLmsApiId");
    const visibility = byId("learnLmsVisibility");
    const language = byId("learnLmsLanguage");
    const hint = byId("learnLmsSecretHint");

    if (provider) provider.value = cfg?.provider_code || "manual";
    if (base) base.value = cfg?.base_url || "";
    if (api) api.value = "";

    if (visibility) visibility.value = String(cfg?.visibility_type ?? 3);
    if (language) language.value = String(cfg?.language ?? 3);

    if (hint){
      if (cfg?.has_secret){
        hint.textContent = "ApiID déjà enregistré. Saisissez une nouvelle clé uniquement pour la remplacer.";
      } else {
        hint.textContent = "Aucun ApiID enregistré.";
      }
    }

    syncProviderFields();
  }

  function buildPayload(){
    return {
      provider_code: byId("learnLmsProvider")?.value || "manual",
      base_url: (byId("learnLmsBaseUrl")?.value || "").trim() || null,
      api_id: (byId("learnLmsApiId")?.value || "").trim() || null,
      visibility_type: parseInt(byId("learnLmsVisibility")?.value || "3", 10),
      language: parseInt(byId("learnLmsLanguage")?.value || "3", 10)
    };
  }

  async function loadConfig(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    const cfg = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/config`
    );

    fillConfig(cfg);
  }

  async function saveConfig(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    setStatus("", "");

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/config`,
      {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(buildPayload())
      }
    );

    fillConfig(res?.config || {});
    setSuccess("Configuration enregistrée");
    setStatus("Configuration enregistrée.", "ok");
  }

  async function testConfig(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    setStatus("Test de connexion en cours...", "");

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/test`,
      { method:"POST" }
    );

    const msg = [
      res?.message || "Connexion validée.",
      res?.workspace_type_label ? `Type : ${res.workspace_type_label}` : "",
      res?.provider_label ? `Fournisseur : ${res.provider_label}` : ""
    ].filter(Boolean).join(" • ");

    setStatus(msg, "ok");
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    byId("learnLmsProvider")?.addEventListener("change", syncProviderFields);

    byId("btnLearnLmsSave")?.addEventListener("click", async () => {
      try{
        await saveConfig(portal);
      } catch(e){
        setStatus(getErrorMessage(e), "error");
        portal.showAlert("error", getErrorMessage(e));
      }
    });

    byId("btnLearnLmsTest")?.addEventListener("click", async () => {
      try{
        await testConfig(portal);
      } catch(e){
        setStatus(getErrorMessage(e), "error");
        portal.showAlert("error", getErrorMessage(e));
      }
    });
  }

  async function init(){
    try {
      await (window.__learnAuthReady || Promise.resolve(null));
    } catch(_){}

    const portal = window.portal;
    if (!portal) return;

    bindOnce(portal);
    await loadConfig(portal);
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert){
      window.portal.showAlert("error", "Erreur informations Learn : " + getErrorMessage(e));
    }
  });
})();