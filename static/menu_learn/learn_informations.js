(function () {
  let _bound = false;
  let _config = null;
  let _laraworkspacetypes = [];
  let _selectedlararecoverytypeids = new set();

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
    function read(v){
      if (!v) return "";

      if (typeof v === "string"){
        return v === "[object Object]" ? "" : v;
      }

      if (v.detail) {
        const d = read(v.detail);
        if (d) return d;
      }

      if (v.message && v.message !== "[object Object]"){
        return String(v.message);
      }

      if (v.error){
        const e = read(v.error);
        if (e) return e;
      }

      if (v.errors){
        if (typeof v.errors === "string") return v.errors;

        if (v.errors.message){
          return String(v.errors.message);
        }

        try{
          return JSON.stringify(v.errors, null, 2);
        } catch(_){}
      }

      if (v.response){
        const r = read(v.response);
        if (r) return r;
      }

      if (v.raw){
        return String(v.raw);
      }

      try{
        const txt = JSON.stringify(v, null, 2);
        if (txt && txt !== "{}") return txt;
      } catch(_){}

      return "";
    }

    return read(err) || "Erreur inconnue.";
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

  function renderLaraRecoveryTypes(){
    const host = byId("lmsRecoveryTypesList");
    if (!host) return;

    host.innerHTML = "";

    if (!_laraWorkspaceTypes.length){
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucun type chargé. Si rien n’est sélectionné, tous les types exploitables seront récupérés.";
      host.appendChild(empty);
      return;
    }

    _laraWorkspaceTypes.forEach(t => {
      const id = String(t?.id || "").trim();
      if (!id) return;

      const label = String(t?.label || id).trim();

      const item = document.createElement("label");
      item.className = "lf-lms-type-check";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = id;
      cb.checked = _selectedLaraRecoveryTypeIds.has(id);

      cb.addEventListener("change", () => {
        if (cb.checked) _selectedLaraRecoveryTypeIds.add(id);
        else _selectedLaraRecoveryTypeIds.delete(id);
      });

      const span = document.createElement("span");
      span.textContent = label;

      const meta = document.createElement("small");
      meta.textContent = t?.is_default ? "Type par défaut" : "";

      item.appendChild(cb);
      item.appendChild(span);
      item.appendChild(meta);

      host.appendChild(item);
    });
  }

  function setLaraWorkspaceTypes(rows){
    _laraWorkspaceTypes = Array.isArray(rows) ? rows : [];
    renderLaraRecoveryTypes();
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

    _selectedLaraRecoveryTypeIds = new Set(
      Array.isArray(_config.lara_recovery_type_ids)
        ? _config.lara_recovery_type_ids.map(x => String(x || "").trim()).filter(Boolean)
        : []
    );

    renderLaraRecoveryTypes();

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

    let baseUrl = "";
    if (provider === "lara"){
      baseUrl = normalizeLmsUrlValue(byId("lmsBaseUrl")?.value || "");

      const baseInput = byId("lmsBaseUrl");
      if (baseInput && baseUrl){
        baseInput.value = baseUrl;
      }
    }

    return {
      provider_code: provider,
      base_url: baseUrl,
      api_id: provider === "lara" ? (byId("lmsApiId")?.value || "").trim() : "",
      visibility_type: parseInt(byId("lmsVisibilityType")?.value || "3", 10),
      language: parseInt(byId("lmsLanguage")?.value || "3", 10),
      lara_recovery_type_ids: Array.from(_selectedLaraRecoveryTypeIds)
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

  async function saveConfig(portal, options = {}){
    if (!options.silent){
      setStatus("", "");
    }

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

    if (!options.silent){
      setSuccess("Configuration enregistrée");
      setStatus("ok", "Configuration LMS enregistrée.");
    }

    return res;
  }

  async function testConfig(portal){
    setStatus("info", "Enregistrement de la configuration puis test de connexion…");

    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    await saveConfig(portal, { silent:true });

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/test`,
      { method:"POST" }
    );

    setLaraWorkspaceTypes(res?.workspace_types || []);

    setStatus(
      "ok",
      [
        res?.message || "Connexion validée.",
        res?.workspace_type_label ? `Type publication : ${res.workspace_type_label}` : "",
        res?.provider_label ? `Fournisseur : ${res.provider_label}` : "",
        Array.isArray(res?.workspace_types) ? `Types récupérables : ${res.workspace_types.length}` : ""
      ].filter(Boolean).join("\n")
    );
  }

  async function loadLaraTypes(portal){
    setStatus("info", "Lecture des types Lära…");

    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    await saveConfig(portal, { silent:true });

    const res = await portal.apiJson(
      `${portal.apiBase}/learn/informations/${encodeURIComponent(effectifId)}/lms/test`,
      { method:"POST" }
    );

    setLaraWorkspaceTypes(res?.workspace_types || []);
    setStatus("ok", `Types Lära chargés : ${(res?.workspace_types || []).length}`);
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
        console.error("Erreur enregistrement LMS", e);
      }
    });

    byId("btnLmsTest")?.addEventListener("click", async () => {
      try{
        await testConfig(portal);
      } catch(e){
        const msg = getErrorMessage(e);
        setStatus("error", msg);
        console.error("Erreur test LMS", e);
      }
    });

    byId("btnLmsLoadTypes")?.addEventListener("click", async () => {
      try{
        await loadLaraTypes(portal);
      } catch(e){
        const msg = getErrorMessage(e);
        setStatus("error", msg);
        console.error("Erreur chargement types LMS", e);
      }
    });

    byId("btnLmsClearTypes")?.addEventListener("click", () => {
      _selectedLaraRecoveryTypeIds = new Set();
      renderLaraRecoveryTypes();
      setStatus("info", "Aucun type sélectionné : tous les types exploitables seront récupérés.");
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
    const msg = getErrorMessage(e);
    setStatus("error", "Erreur informations Learn : " + msg);
    console.error("Erreur initialisation informations Learn", e);
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