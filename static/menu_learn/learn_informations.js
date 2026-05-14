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
    if (err.message && err.message !== "[object Object]") return err.message;

    if (err.detail){
      if (typeof err.detail === "string") return err.detail;
      try { return JSON.stringify(err.detail, null, 2); } catch(_){}
    }

    try{
      const txt = JSON.stringify(err, null, 2);
      if (txt && txt !== "{}") return txt;
    } catch(_){}

    return "Erreur inconnue.";
  }

  function setSuccess(msg){
    const el = byId("lmsSaveSuccess");
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

  function setStatus(type, msg){
    const box = byId("lmsStatusBox");
    if (!box) return;

    if (!msg){
      box.style.display = "none";
      box.className = "lf-lms-status";
      box.innerHTML = "";
      return;
    }

    box.style.display = "";
    box.className = `lf-lms-status is-${type || "info"}`;
    box.innerHTML = htmlEsc(msg).replaceAll("\n", "<br>");
  }

  function syncProviderUi(){
    const provider = byId("lmsProvider")?.value || "manual";
    const isLara = provider === "lara";

    document.querySelectorAll(".lf-lms-lara-field").forEach(el => {
      el.style.display = isLara ? "" : "none";
    });

    const btnTest = byId("btnLmsTest");
    if (btnTest) btnTest.style.display = isLara ? "" : "none";

    const badge = byId("lmsConfigBadge");
    if (badge){
      if (isLara && _config?.configured){
        badge.textContent = "Lära configuré";
      } else if (isLara) {
        badge.textContent = "Lära à configurer";
      } else {
        badge.textContent = "Export manuel";
      }
    }
  }

  function fillConfig(cfg){
    _config = cfg || {};

    const provider = byId("lmsProvider");
    const base = byId("lmsBaseUrl");
    const api = byId("lmsApiId");
    const vis = byId("lmsVisibilityType");
    const lang = byId("lmsLanguage");
    const hint = byId("lmsSecretHint");

    if (provider) provider.value = _config.provider_code || "manual";
    if (base) base.value = _config.base_url || "";
    if (api) api.value = "";
    if (vis) vis.value = String(_config.visibility_type || 3);
    if (lang) lang.value = String(_config.language || 3);

    if (hint){
      hint.className = `lf-lms-secret-hint ${_config.has_secret ? "is-ok" : "is-empty"}`;
      hint.textContent = _config.has_secret
        ? "Clé ApiID enregistrée. Laissez le champ vide pour la conserver."
        : "Aucune clé ApiID enregistrée.";
    }

    syncProviderUi();
  }

  function buildPayload(){
    const provider = byId("lmsProvider")?.value || "manual";

    return {
      provider_code: provider,
      base_url: provider === "lara" ? (byId("lmsBaseUrl")?.value || "").trim() : "",
      api_id: provider === "lara" ? (byId("lmsApiId")?.value || "").trim() : "",
      visibility_type: parseInt(byId("lmsVisibilityType")?.value || "3", 10),
      language: parseInt(byId("lmsLanguage")?.value || "3", 10)
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
    setStatus("", "");

    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

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

    if (portal.showAlert){
      portal.showAlert("success", "Configuration LMS enregistrée");
    }
  }

  async function testConfig(portal){
    setStatus("info", "Test de connexion en cours…");

    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/test`,
      { method:"POST" }
    );

    setStatus(
      "ok",
      [
        res?.message || "Connexion validée.",
        res?.workspace_type_label ? `Type : ${res.workspace_type_label}` : "",
        res?.provider_label ? `Fournisseur : ${res.provider_label}` : ""
      ].filter(Boolean).join("\n")
    );
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    byId("lmsProvider")?.addEventListener("change", () => {
      syncProviderUi();
      setStatus("", "");
    });

    byId("btnLmsSave")?.addEventListener("click", async () => {
      try{
        await saveConfig(portal);
      } catch(e){
        const msg = getErrorMessage(e);
        setStatus("error", msg);
        portal.showAlert?.("error", msg);
      }
    });

    byId("btnLmsTest")?.addEventListener("click", async () => {
      try{
        await testConfig(portal);
      } catch(e){
        const msg = getErrorMessage(e);
        setStatus("error", msg);
        portal.showAlert?.("error", msg);
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
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert("error", "Erreur informations Learn : " + (e?.message || e));
    }
  });

    function normalizeLmsUrlValue(value){
    let url = String(value || "").trim();

    if (!url) return "";

    if (!/^https?:\/\//i.test(url)){
      url = "https://" + url;
    }

    url = url.replace(/\/+$/g, "");

    const suffixes = [
      "/workspace/gettypes",
      "/workspace/create",
      "/workspace/edit",
      "/workspace/geturl",
      "/workspace/get",
      "/provider/getlist"
    ];

    const lower = url.toLowerCase();

    for (const suffix of suffixes){
      if (lower.endsWith(suffix)){
        url = url.slice(0, -suffix.length).replace(/\/+$/g, "");
        break;
      }
    }

    if (!url.toLowerCase().includes("/lmsapi")){
      url += "/lmsapi";
    }

    return url;
  }

  function normalizeLmsBaseUrlInput(){
    const el = byId("lmsBaseUrl");
    if (!el) return;

    const normalized = normalizeLmsUrlValue(el.value);

    if (normalized && normalized !== el.value){
      el.value = normalized;
    }
  }

  function bindLmsUrlNormalizer(){
    const el = byId("lmsBaseUrl");
    if (!el || el.dataset.urlNormalizerBound === "1") return;

    el.dataset.urlNormalizerBound = "1";

    el.addEventListener("blur", normalizeLmsBaseUrlInput);
    el.addEventListener("change", normalizeLmsBaseUrlInput);

    const btnSave = byId("btnLmsSave");
    if (btnSave && btnSave.dataset.urlNormalizerBound !== "1"){
      btnSave.dataset.urlNormalizerBound = "1";
      btnSave.addEventListener("click", normalizeLmsBaseUrlInput, true);
    }

    const btnTest = byId("btnLmsTest");
    if (btnTest && btnTest.dataset.urlNormalizerBound !== "1"){
      btnTest.dataset.urlNormalizerBound = "1";
      btnTest.addEventListener("click", normalizeLmsBaseUrlInput, true);
    }
  }

  bindLmsUrlNormalizer();
})();