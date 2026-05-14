(function () {
  let _bound = false;
  let _config = null;

  function byId(id){ return document.getElementById(id); }

  function getEffectifId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function getErrorMessage(err){
    if (!err) return "Erreur inconnue.";
    if (typeof err === "string") return err;

    if (err.message && typeof err.message === "string" && err.message !== "[object Object]"){
      return err.message;
    }

    if (err.detail){
      if (typeof err.detail === "string") return err.detail;
      try{ return JSON.stringify(err.detail, null, 2); } catch(_){ }
    }

    try{
      const txt = JSON.stringify(err, null, 2);
      if (txt && txt !== "{}") return txt;
    } catch(_){ }

    return "Erreur inconnue.";
  }

  function setSuccess(msg){
    const el = byId("learnInfoLmsSuccess");
    if (!el) return;

    window.clearTimeout(el._hideTimer);

    if (!msg){
      el.textContent = "";
      el.style.display = "none";
      return;
    }

    el.textContent = msg;
    el.style.display = "inline-flex";

    el._hideTimer = window.setTimeout(() => {
      el.textContent = "";
      el.style.display = "none";
    }, 5000);
  }

  function setTestResult(msg, ok){
    const el = byId("learnLmsTestResult");
    if (!el) return;

    if (!msg){
      el.textContent = "";
      el.style.display = "none";
      el.className = "lf-lms-test-result";
      return;
    }

    el.textContent = msg;
    el.style.display = "block";
    el.className = "lf-lms-test-result " + (ok ? "is-ok" : "is-error");
  }

  function syncProviderFields(){
    const provider = (byId("learnLmsProvider")?.value || "manual").trim();
    const isLara = provider === "lara";

    document.querySelectorAll(".lf-lms-lara-field").forEach(el => {
      el.style.display = isLara ? "" : "none";
    });

    const btnTest = byId("btnLearnLmsTest");
    if (btnTest) btnTest.style.display = isLara ? "" : "none";
  }

  function fillConfig(cfg){
    _config = cfg || {};

    const provider = byId("learnLmsProvider");
    const baseUrl = byId("learnLmsBaseUrl");
    const apiId = byId("learnLmsApiId");
    const visibility = byId("learnLmsVisibility");
    const language = byId("learnLmsLanguage");
    const secretState = byId("learnLmsSecretState");

    if (provider) provider.value = _config.provider_code || "manual";
    if (baseUrl) baseUrl.value = _config.base_url || "";
    if (apiId) apiId.value = "";
    if (visibility) visibility.value = String(_config.visibility_type || 3);
    if (language) language.value = String(_config.language || 3);

    if (secretState){
      secretState.textContent = _config.has_secret
        ? "Clé ApiID enregistrée. Laissez le champ vide pour la conserver."
        : "Aucune clé enregistrée.";
    }

    syncProviderFields();
  }

  function buildPayload(){
    const provider = (byId("learnLmsProvider")?.value || "manual").trim();

    return {
      provider_code: provider,
      base_url: (byId("learnLmsBaseUrl")?.value || "").trim(),
      api_id: (byId("learnLmsApiId")?.value || "").trim(),
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

    setTestResult("", true);

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
  }

  async function testConfig(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    setTestResult("Test en cours…", true);

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/test`,
      { method:"POST" }
    );

    const parts = [
      res?.message || "Connexion validée.",
      res?.workspace_type_label ? `Type : ${res.workspace_type_label}` : "",
      res?.provider_label ? `Fournisseur : ${res.provider_label}` : ""
    ].filter(Boolean);

    setTestResult(parts.join(" • "), true);
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    byId("learnLmsProvider")?.addEventListener("change", syncProviderFields);

    byId("btnLearnLmsSave")?.addEventListener("click", async () => {
      try{
        await saveConfig(portal);
      } catch(err){
        portal.showAlert("error", getErrorMessage(err));
      }
    });

    byId("btnLearnLmsTest")?.addEventListener("click", async () => {
      try{
        await testConfig(portal);
      } catch(err){
        const msg = getErrorMessage(err);
        setTestResult(msg, false);
        portal.showAlert("error", msg);
      }
    });
  }

  async function init(){
    try {
      await (window.__learnAuthReady || Promise.resolve(null));
    } catch(_){ }

    const portal = window.portal;
    if (!portal) return;

    bindOnce(portal);
    await loadConfig(portal);
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert("error", "Erreur informations Learn : " + getErrorMessage(e));
    }
  });
})();
