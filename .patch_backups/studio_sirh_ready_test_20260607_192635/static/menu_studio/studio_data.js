(function () {
  let _bound = false;
  let _loaded = false;

  let _initialOrg = null;
  let _initialContact = null;
  let _initialConnexion = null;
  let _connexionLoaded = false;
  let _initialSirh = null;
  let _sirhLoaded = false;
  let _refOpco = null;
  let _entLogoBlobUrl = null;
  const _saveSuccessTimers = {};

  function isAdmin(){
    const r = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
    return r === "admin";
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function formatBytes(bytes) {
    const n = parseInt(bytes || 0, 10) || 0;
    if (n < 1024) return `${n} o`;
    if (n < (1024 * 1024)) return `${(n / 1024).toFixed(1)} Ko`;
    return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  }

  async function resolveStudioAccessToken() {
    try {
      const pac = window.PortalAuthCommon;
      if (pac && typeof pac.getSession === "function") {
        const s = await pac.getSession();
        if (s && s.access_token) return String(s.access_token);
        if (s && s.session && s.session.access_token) return String(s.session.access_token);
        if (s && s.data && s.data.session && s.data.session.access_token) return String(s.data.session.access_token);
      }
    } catch (_) {}

    if (window.portal && window.portal.accessToken) return String(window.portal.accessToken);
    if (window.portal && window.portal.token) return String(window.portal.token);

    return "";
  }

  async function renderEntrepriseLogo(logoMeta) {
    const img = document.getElementById("entLogoImg");
    const empty = document.getElementById("entLogoEmpty");
    const meta = document.getElementById("entLogoMeta");
    const btnUpload = document.getElementById("btnUploadLogo");
    const btnRemove = document.getElementById("btnRemoveLogo");

    const hasLogo = !!(logoMeta && logoMeta.has_logo);
    const admin = isAdmin();

    if (btnUpload) btnUpload.style.display = admin ? "inline-flex" : "none";
    if (btnRemove) btnRemove.style.display = (admin && hasLogo) ? "inline-flex" : "none";

    if (_entLogoBlobUrl) {
      try { URL.revokeObjectURL(_entLogoBlobUrl); } catch (_) {}
      _entLogoBlobUrl = null;
    }

    if (!hasLogo) {
      if (img) {
        img.removeAttribute("src");
        img.style.display = "none";
      }
      if (empty) {
        empty.textContent = "Aucun logo enregistré.";
        empty.style.display = "";
      }
      if (meta) {
        meta.textContent = "Le logo enregistré sera réutilisé automatiquement dans les sorties PDF Studio.";
      }
      return;
    }

    if (empty) {
      empty.textContent = "Chargement du logo…";
      empty.style.display = "";
    }

    if (meta) {
      const mime = String(logoMeta.mime_type || "").replace("image/", "").toUpperCase();
      const parts = [];
      if (logoMeta.filename) parts.push(logoMeta.filename);
      if (mime) parts.push(mime);
      if (logoMeta.size_bytes) parts.push(formatBytes(logoMeta.size_bytes));
      meta.textContent = parts.join(" · ") || "Logo actif.";
    }

    try {
      const portal = window.portal;
      const ownerId = getOwnerId();
      if (!portal || !ownerId) throw new Error("Owner manquant.");

      const token = await resolveStudioAccessToken();
      const headers = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const stamp = encodeURIComponent(logoMeta.date_maj || Date.now());
      const resp = await fetch(
        `${portal.apiBase}/studio/data/logo/${encodeURIComponent(ownerId)}?v=${stamp}`,
        {
          method: "GET",
          headers,
          credentials: "same-origin",
        }
      );

      if (!resp.ok) {
        let msg = `Erreur logo (${resp.status})`;
        try {
          const err = await resp.json();
          if (err && err.detail) msg = String(err.detail);
        } catch (_) {}
        throw new Error(msg);
      }

      const blob = await resp.blob();
      _entLogoBlobUrl = URL.createObjectURL(blob);

      if (img) {
        img.onerror = () => {
          img.removeAttribute("src");
          img.style.display = "none";
          if (empty) {
            empty.textContent = "Impossible d’afficher le logo.";
            empty.style.display = "";
          }
        };
        img.src = _entLogoBlobUrl;
        img.style.display = "";
      }

      if (empty) {
        empty.textContent = "";
        empty.style.display = "none";
      }

    } catch (e) {
      if (img) {
        img.removeAttribute("src");
        img.style.display = "none";
      }
      if (empty) {
        empty.textContent = e.message || "Impossible d’afficher le logo.";
        empty.style.display = "";
      }
    }
  }

  async function uploadEntrepriseLogo(portal, file) {
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");
    if (!file) return;

    const name = String(file.name || "").toLowerCase();
    if (!/\.(png|jpg|jpeg)$/.test(name)) {
      throw new Error("Format logo non supporté. Utilise un fichier PNG ou JPG.");
    }

    if ((file.size || 0) > (2 * 1024 * 1024)) {
      throw new Error("Logo trop volumineux. Limite : 2 Mo.");
    }

    portal.showAlert("", "");

    try {
      const token = await resolveStudioAccessToken();
      const headers = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const fd = new FormData();
      fd.append("file", file, file.name || "logo");

      const resp = await fetch(
        `${portal.apiBase}/studio/data/logo/${encodeURIComponent(ownerId)}`,
        {
          method: "POST",
          headers,
          body: fd,
          credentials: "same-origin",
        }
      );

      if (!resp.ok) {
        let msg = `Erreur logo (${resp.status})`;
        try {
          const err = await resp.json();
          if (err && err.detail) msg = String(err.detail);
        } catch (_) {}
        throw new Error(msg);
      }

      await loadData(portal);
    } finally {
    }
  }

  async function archiveEntrepriseLogo(portal) {
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    portal.showAlert("", "");

    try {
      const token = await resolveStudioAccessToken();
      const headers = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const resp = await fetch(
        `${portal.apiBase}/studio/data/logo/${encodeURIComponent(ownerId)}/archive`,
        {
          method: "POST",
          headers,
          credentials: "same-origin",
        }
      );

      if (!resp.ok) {
        let msg = `Erreur retrait logo (${resp.status})`;
        try {
          const err = await resp.json();
          if (err && err.detail) msg = String(err.detail);
        } catch (_) {}
        throw new Error(msg);
      }

      await loadData(portal);
    } finally {
    }
  }

  function setValueOrEmpty(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value ?? "";
  }

  function setTextOrDash(id, value, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (value != null && String(value).trim() !== "") ? value : "—";
    el.classList.toggle("error", !!isError);
  }

  function normalizeValue(v) {
    const s = (v ?? "").toString().trim();
    return s.length === 0 ? null : s;
  }

  function hideSaveSuccess(id) {
    const el = document.getElementById(id);
    if (!el) return;

    if (_saveSuccessTimers[id]) {
      clearTimeout(_saveSuccessTimers[id]);
      delete _saveSuccessTimers[id];
    }

    el.textContent = "";
    el.style.display = "none";
  }

  function showSaveSuccess(id) {
    const el = document.getElementById(id);
    if (!el) return;

    if (_saveSuccessTimers[id]) {
      clearTimeout(_saveSuccessTimers[id]);
      delete _saveSuccessTimers[id];
    }

    el.textContent = "Enregistré avec succès";
    el.style.display = "inline-flex";

    _saveSuccessTimers[id] = setTimeout(() => {
      el.textContent = "";
      el.style.display = "none";
      delete _saveSuccessTimers[id];
    }, 5000);
  }

  function normalizeContactNom(raw) {
    const s = (raw ?? "").toString().trim().replace(/\s+/g, " ");
    return s ? s.toLocaleUpperCase("fr-FR") : "";
  }

  function normalizeContactPrenom(raw) {
    const s = (raw ?? "").toString().trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
    if (!s) return "";
    return s.charAt(0).toLocaleUpperCase("fr-FR") + s.slice(1);
  }

  function applyContactIdentityFormat() {
    const prenom = document.getElementById("ct_prenom_ca");
    const nom = document.getElementById("ct_nom_ca");

    if (prenom) prenom.value = normalizeContactPrenom(prenom.value);
    if (nom) nom.value = normalizeContactNom(nom.value);
  }

  function buildPatchFromInitial(initialObj, currentObj, allowedKeys) {
    const patch = {};
    allowedKeys.forEach(k => {
      const a = initialObj ? (initialObj[k] ?? null) : null;
      const b = currentObj ? (currentObj[k] ?? null) : null;
      const aa = (a === "") ? null : a;
      const bb = (b === "") ? null : b;
      if (aa !== bb) patch[k] = bb;
    });
    return patch;
  }

  function formatPhoneInput(input) {
    if (!input) return;

    let digits = (input.value || "").replace(/\D/g, "");
    if (digits.startsWith("33") && digits.length >= 11) digits = "0" + digits.slice(2);
    digits = digits.slice(0, 10);

    const parts = [];
    for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
    input.value = parts.join(" ");
  }

  function formatApeInput(raw) {
    let digits = (raw || "").replace(/[^\d]/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return digits.slice(0, 2) + "." + digits.slice(2);
  }


  function showSsoInfoPopup(message) {
    window.alert(message || "Information SSO indisponible.");
  }
  function setCheckbox(id, value) { const el = document.getElementById(id); if (el) el.checked = !!value; }
  function checkboxValue(id) { return !!document.getElementById(id)?.checked; }
  function renderOwnerConnexion(cfg) {
    const c = cfg || {};
    _initialConnexion = { ...c };
    setCheckbox("ownerSsoEnabled", c.sso_enabled);
    setCheckbox("ownerSsoPasswordAllowed", c.password_allowed !== false);
    setCheckbox("ownerSsoMandatory", c.sso_obligatoire);
    setValueOrEmpty("ownerSsoDomain", c.domaine_autorise);
    setValueOrEmpty("ownerSsoProviderId", c.provider_id_supabase);
    setValueOrEmpty("ownerSsoMetadataUrl", c.metadata_url);
    setValueOrEmpty("ownerSsoEmailAttr", c.attribut_email || "email");
    const xml = document.getElementById("ownerSsoMetadataXml");
    if (xml) xml.value = c.metadata_xml || "";
    const hint = document.getElementById("ownerSsoSchemaHint");
    if (hint) {
      if (c.schema_ready === false) hint.textContent = "Table SSO non installée : exécuter PATCH_SQL_SSO_CONNEXIONS.sql avant enregistrement.";
      else if (c.test_message) hint.textContent = c.test_message;
      else hint.textContent = "Le SSO complète la connexion Novoskill. Les droits restent gérés dans les accès utilisateurs.";
    }
  }
  function collectOwnerConnexionFromUI() {
    const mandatory = checkboxValue("ownerSsoMandatory");
    return {
      sso_enabled: checkboxValue("ownerSsoEnabled"),
      domaine_autorise: normalizeValue(document.getElementById("ownerSsoDomain")?.value),
      type_sso: "saml_2_0",
      metadata_url: normalizeValue(document.getElementById("ownerSsoMetadataUrl")?.value),
      metadata_xml: normalizeValue(document.getElementById("ownerSsoMetadataXml")?.value),
      provider_id_supabase: normalizeValue(document.getElementById("ownerSsoProviderId")?.value),
      attribut_email: normalizeValue(document.getElementById("ownerSsoEmailAttr")?.value) || "email",
      password_allowed: mandatory ? false : checkboxValue("ownerSsoPasswordAllowed"),
      sso_obligatoire: mandatory,
    };
  }
  function setConnexionEditMode(isEdit) {
    const admin = isAdmin();
    if (isEdit) hideSaveSuccess("connexionSaveSuccess");
    const card = document.getElementById("cardConnexions");
    if (card) card.style.display = admin ? "" : "none";
    document.querySelectorAll("[data-editable-sso='1']").forEach(el => { el.disabled = !(admin && isEdit); });
    const b1 = document.getElementById("btnEditConnexion");
    const b2 = document.getElementById("btnSaveConnexion");
    const b3 = document.getElementById("btnCancelConnexion");
    const bt = document.getElementById("btnTestConnexion");
    if (b1) b1.style.display = (!admin || isEdit) ? "none" : "inline-flex";
    if (b2) b2.style.display = (admin && isEdit) ? "inline-flex" : "none";
    if (b3) b3.style.display = (admin && isEdit) ? "inline-flex" : "none";
    if (bt) bt.style.display = admin ? "inline-flex" : "none";
  }
  async function loadConnexion(portal) {
    const ownerId = getOwnerId();
    if (!ownerId || !portal) return;
    try {
      const cfg = await portal.apiJson(`${portal.apiBase}/studio/connexions/owner/${encodeURIComponent(ownerId)}`);
      renderOwnerConnexion(cfg || {});
      _connexionLoaded = true;
    } catch (e) {
      renderOwnerConnexion({ schema_ready: false, sso_statut: "desactive", test_message: e.message || "Configuration SSO indisponible." });
    }
    setConnexionEditMode(false);
  }
  async function saveConnexion(portal) {
    const ownerId = getOwnerId();
    const payload = collectOwnerConnexionFromUI();
    const data = await portal.apiJson(`${portal.apiBase}/studio/connexions/owner/${encodeURIComponent(ownerId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    renderOwnerConnexion(data || {});
    setConnexionEditMode(false);
    showSaveSuccess("connexionSaveSuccess");
  }
  async function testConnexion(portal) {
    const ownerId = getOwnerId();
    if (!ownerId) return;
    const bt = document.getElementById("btnTestConnexion");
    const old = bt ? bt.textContent : "";
    try {
      if (bt) { bt.disabled = true; bt.textContent = "Test..."; }
      const data = await portal.apiJson(`${portal.apiBase}/studio/connexions/owner/${encodeURIComponent(ownerId)}/test`, { method: "POST" });
      renderOwnerConnexion(data || {});
      showSsoInfoPopup((data && data.test_message) || "Configuration SSO vérifiée.");
    } catch (e) { showSsoInfoPopup(e.message || String(e)); }
    finally { if (bt) { bt.disabled = false; bt.textContent = old || "Tester la configuration"; } }
  }
  function bindSsoHelpButtons() {
    document.querySelectorAll(".sb-help-dot[data-help]").forEach(btn => {
      if (btn.dataset.boundHelp === "1") return;
      btn.dataset.boundHelp = "1";
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.alert(btn.dataset.help || "Aide indisponible."); });
    });
  }



  function sirhProviderLabel(providerCode) {
    const p = String(providerCode || "manual").trim().toLowerCase();
    if (p === "ebp_paie") return "EBP Paie";
    return "Aucun connecteur";
  }

  function setSirhStatus(type, msg) {
    const box = document.getElementById("sirhStatusBox");
    if (!box) return;

    if (!msg) {
      box.style.display = "none";
      box.className = "sd-sirh-status";
      box.textContent = "";
      return;
    }

    box.style.display = "";
    box.className = `sd-sirh-status is-${type || "info"}`;
    box.textContent = msg;
  }

  function syncSirhProviderUi() {
    const provider = document.getElementById("sirhProvider")?.value || "manual";
    const hasProvider = provider !== "manual";

    document.querySelectorAll(".sd-sirh-provider-field").forEach(el => {
      el.style.display = hasProvider ? "" : "none";
    });
  }

  function renderSirhConfig(cfg) {
    const c = cfg || {};
    _initialSirh = { ...c };

    setValueOrEmpty("sirhProvider", c.provider_code || "manual");
    setValueOrEmpty("sirhBaseUrl", c.base_url || "");
    setValueOrEmpty("sirhClientId", c.client_id || c.tenant_id || "");
    setValueOrEmpty("sirhDossierCode", c.dossier_code || "");
    setValueOrEmpty("sirhApiKey", "");

    const hint = document.getElementById("sirhSecretHint");
    if (hint) {
      hint.className = `sd-sirh-secret-hint ${c.has_secret ? "is-ok" : "is-empty"}`;
      hint.textContent = c.has_secret
        ? "Clé API enregistrée. Laissez le champ vide pour la conserver."
        : "Aucune clé API enregistrée.";
    }
    syncSirhProviderUi();
    setSirhStatus("", "");
  }

  function collectSirhConfigFromUI() {
    const provider = document.getElementById("sirhProvider")?.value || "manual";

    return {
      provider_code: provider,
      base_url: provider === "manual" ? null : normalizeValue(document.getElementById("sirhBaseUrl")?.value),
      api_key: provider === "manual" ? "" : (document.getElementById("sirhApiKey")?.value || "").trim(),
      client_id: provider === "manual" ? null : normalizeValue(document.getElementById("sirhClientId")?.value),
      dossier_code: provider === "manual" ? null : normalizeValue(document.getElementById("sirhDossierCode")?.value),
    };
  }

  function setSirhEditMode(isEdit) {
    const admin = isAdmin();
    if (isEdit) hideSaveSuccess("sirhSaveSuccess");

    const card = document.getElementById("cardSirhConnectors");
    if (card) card.style.display = admin ? "" : "none";

    document.querySelectorAll("[data-editable-sirh='1']").forEach(el => {
      el.disabled = !(admin && isEdit);
    });

    const bEdit = document.getElementById("btnEditSirh");
    const bSave = document.getElementById("btnSaveSirh");
    const bCancel = document.getElementById("btnCancelSirh");

    if (bEdit) bEdit.style.display = (!admin || isEdit) ? "none" : "inline-flex";
    if (bSave) bSave.style.display = (admin && isEdit) ? "inline-flex" : "none";
    if (bCancel) bCancel.style.display = (admin && isEdit) ? "inline-flex" : "none";
  }

  async function loadSirhConfig(portal) {
    const ownerId = getOwnerId();
    if (!ownerId || !portal) return;

    try {
      const cfg = await portal.apiJson(`${portal.apiBase}/studio/sirh/owner/${encodeURIComponent(ownerId)}/config`);
      renderSirhConfig(cfg || {});
      _sirhLoaded = true;
    } catch (e) {
      renderSirhConfig({
        schema_ready: false,
        provider_code: "manual",
        configured: false,
        has_secret: false,
      });
      setSirhStatus("error", e.message || "Configuration SIRH indisponible.");
    }

    setSirhEditMode(false);
  }

  async function saveSirhConfig(portal) {
    const ownerId = getOwnerId();
    if (!ownerId) return;

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/sirh/owner/${encodeURIComponent(ownerId)}/config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectSirhConfigFromUI()),
      }
    );

    renderSirhConfig((data && data.config) || data || {});
    setSirhEditMode(false);
    showSaveSuccess("sirhSaveSuccess");
    setSirhStatus("ok", "Configuration SIRH enregistrée. Aucune synchronisation n’a été lancée.");
  }

  function bindSirhEvents(portal) {
    document.getElementById("sirhProvider")?.addEventListener("change", () => {
      syncSirhProviderUi();
      setSirhStatus("", "");
    });

    document.getElementById("btnEditSirh")?.addEventListener("click", async () => {
      try {
        if (!isAdmin()) return;
        if (!_sirhLoaded) await loadSirhConfig(portal);
        portal.showAlert("", "");
        setSirhEditMode(true);
      } catch (e) {
        showSsoInfoPopup(e.message || String(e));
      }
    });

    document.getElementById("btnCancelSirh")?.addEventListener("click", () => {
      renderSirhConfig(_initialSirh || {});
      setSirhEditMode(false);
      portal.showAlert("", "");
    });

    document.getElementById("btnSaveSirh")?.addEventListener("click", async () => {
      try {
        await saveSirhConfig(portal);
        portal.showAlert("", "");
      } catch (e) {
        setSirhStatus("error", e.message || String(e));
        portal.showAlert("error", "Erreur enregistrement SIRH : " + (e.message || e));
      }
    });
  }

  function setEntrepriseEditMode(isEdit) {
    const admin = isAdmin();

    if (isEdit) hideSaveSuccess("entSaveSuccess");

    document.querySelectorAll("[data-editable-ent='1']").forEach(el => {
      el.disabled = !(admin && isEdit);
    });

    const b1 = document.getElementById("btnEditEntreprise");
    const b2 = document.getElementById("btnSaveEntreprise");
    const b3 = document.getElementById("btnCancelEntreprise");

    if (b1) b1.style.display = (!admin || isEdit) ? "none" : "inline-flex";
    if (b2) b2.style.display = (admin && isEdit) ? "inline-flex" : "none";
    if (b3) b3.style.display = (admin && isEdit) ? "inline-flex" : "none";
  }

  function setContactEditMode(isEdit) {
    if (isEdit) hideSaveSuccess("contactSaveSuccess");

    document.querySelectorAll("[data-editable-ct='1']").forEach(el => {
      el.disabled = !isEdit;
    });

    // IMPORTANT : le champ rôle est disabled dans le HTML et n'a PAS data-editable-ct
    const b1 = document.getElementById("btnEditContact");
    const b2 = document.getElementById("btnSaveContact");
    const b3 = document.getElementById("btnCancelContact");

    if (b1) b1.style.display = isEdit ? "none" : "inline-flex";
    if (b2) b2.style.display = isEdit ? "inline-flex" : "none";
    if (b3) b3.style.display = isEdit ? "inline-flex" : "none";
  }

  async function loadRefOpco(portal) {
    if (_refOpco) return _refOpco;
    _refOpco = await portal.apiJson(`${portal.apiBase}/studio/referentiels/opco`);
    return _refOpco;
  }

  function renderOpcoSelect(list, selectedId) {
    const sel = document.getElementById("ent_id_opco");
    if (!sel) return;

    sel.innerHTML = `<option value="">(Non renseigné)</option>`;
    (list || []).forEach(it => {
      const opt = document.createElement("option");
      opt.value = it.id_opco;
      opt.textContent = it.nom_opco;
      sel.appendChild(opt);
    });

    sel.value = selectedId || "";
  }

  async function lookupIdcc(portal, idcc) {
    const v = (idcc || "").trim();
    if (!v) { setTextOrDash("idccHint", "—", false); return; }
    try {
      const r = await portal.apiJson(`${portal.apiBase}/studio/referentiels/idcc/${encodeURIComponent(v)}`);
      setTextOrDash("idccHint", r.libelle || "—", false);
    } catch {
      setTextOrDash("idccHint", "IDCC introuvable", true);
    }
  }

  async function lookupApe(portal, codeApe) {
    const v = (codeApe || "").trim();
    if (!v) { setTextOrDash("apeHint", "—", false); return; }
    try {
      const r = await portal.apiJson(`${portal.apiBase}/studio/referentiels/ape/${encodeURIComponent(v)}`);
      setTextOrDash("apeHint", r.intitule_ape || "—", false);
    } catch {
      setTextOrDash("apeHint", "Code APE invalide ou introuvable", true);
    }
  }

  function renderEntreprise(org) {
    setValueOrEmpty("ent_nom_ent", org.nom_ent);

    setValueOrEmpty("ent_siret_ent", org.siret_ent);
    setValueOrEmpty("ent_num_tva_ent", org.num_tva_ent);

    setValueOrEmpty("ent_adresse_ent", org.adresse_ent);
    setValueOrEmpty("ent_adresse_cplt_ent", org.adresse_cplt_ent);
    setValueOrEmpty("ent_cp_ent", org.cp_ent);
    setValueOrEmpty("ent_ville_ent", org.ville_ent);
    setValueOrEmpty("ent_pays_ent", org.pays_ent);

    setValueOrEmpty("ent_telephone_ent", org.telephone_ent);
    formatPhoneInput(document.getElementById("ent_telephone_ent"));

    setValueOrEmpty("ent_email_ent", org.email_ent);
    setValueOrEmpty("ent_site_web", org.site_web);

    setValueOrEmpty("ent_code_ape_ent", org.code_ape_ent);
    setTextOrDash("apeHint", org.code_ape_intitule || "—", false);

    setValueOrEmpty("ent_idcc", org.idcc);
    setTextOrDash("idccHint", org.idcc_libelle || "—", false);

    renderEntrepriseLogo(org.logo || { has_logo: false }).catch(() => {});
  }

  function renderContact(ct) {
    const civ = document.getElementById("ct_civ_ca");
    if (civ) civ.value = (ct.civilite || "").trim();

    setValueOrEmpty("ct_prenom_ca", normalizeContactPrenom(ct.prenom));
    setValueOrEmpty("ct_nom_ca", normalizeContactNom(ct.nom));

    // Lecture seule: rôle d'accès Studio
    setValueOrEmpty("ct_role_ca", ct.role);

    setValueOrEmpty("ct_tel_ca", ct.telephone);
    formatPhoneInput(document.getElementById("ct_tel_ca"));

    setValueOrEmpty("ct_tel2_ca", ct.telephone2);
    formatPhoneInput(document.getElementById("ct_tel2_ca"));

    setValueOrEmpty("ct_mail_ca", ct.email);

    const obs = document.getElementById("ct_obs_ca");
    if (obs) obs.value = ct.observations ?? "";
  }

  async function loadData(portal) {
    portal.showAlert("", "");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    const data = await portal.apiJson(`${portal.apiBase}/studio/data/${encodeURIComponent(ownerId)}`);
    const org = data.organisation || {};
    const ct = data.contact || {};

    _initialOrg = { ...org };
    _initialContact = { ...ct };

    const opco = await loadRefOpco(portal);
    renderOpcoSelect(opco, org.id_opco || "");

    renderEntreprise(org);
    renderContact(ct);
    await loadConnexion(portal);

    setEntrepriseEditMode(false);
    setContactEditMode(false);

    hideSaveSuccess("entSaveSuccess");
    hideSaveSuccess("contactSaveSuccess");

    _loaded = true;
  }

  function collectEntrepriseFromUI() {
    return {
      adresse_ent: normalizeValue(document.getElementById("ent_adresse_ent")?.value),
      adresse_cplt_ent: normalizeValue(document.getElementById("ent_adresse_cplt_ent")?.value),
      cp_ent: normalizeValue(document.getElementById("ent_cp_ent")?.value),
      ville_ent: normalizeValue(document.getElementById("ent_ville_ent")?.value),
      pays_ent: normalizeValue(document.getElementById("ent_pays_ent")?.value),

      email_ent: normalizeValue(document.getElementById("ent_email_ent")?.value),
      telephone_ent: normalizeValue(document.getElementById("ent_telephone_ent")?.value),
      site_web: normalizeValue(document.getElementById("ent_site_web")?.value),

      siret_ent: normalizeValue(document.getElementById("ent_siret_ent")?.value),
      code_ape_ent: normalizeValue(document.getElementById("ent_code_ape_ent")?.value),
      num_tva_ent: normalizeValue(document.getElementById("ent_num_tva_ent")?.value),

      idcc: normalizeValue(document.getElementById("ent_idcc")?.value),
      id_opco: normalizeValue(document.getElementById("ent_id_opco")?.value),
    };
  }

  function collectContactFromUI() {
    applyContactIdentityFormat();

    return {
      civilite: normalizeValue(document.getElementById("ct_civ_ca")?.value),
      prenom: normalizeValue(normalizeContactPrenom(document.getElementById("ct_prenom_ca")?.value)),
      nom: normalizeValue(normalizeContactNom(document.getElementById("ct_nom_ca")?.value)),
      email: normalizeValue(document.getElementById("ct_mail_ca")?.value),
      telephone: normalizeValue(document.getElementById("ct_tel_ca")?.value),
      telephone2: normalizeValue(document.getElementById("ct_tel2_ca")?.value),
      observations: normalizeValue(document.getElementById("ct_obs_ca")?.value),
      // role: lecture seule => pas envoyé
    };
  }

  async function saveEntreprise(portal) {
    const ownerId = getOwnerId();
    const current = collectEntrepriseFromUI();

    const allowed = [
      "adresse_ent","adresse_cplt_ent","cp_ent","ville_ent","pays_ent",
      "email_ent","telephone_ent","site_web",
      "siret_ent","code_ape_ent","num_tva_ent","idcc","id_opco"
    ];

    const patch = buildPatchFromInitial(_initialOrg, current, allowed);

    if (Object.keys(patch).length === 0) {
      portal.showAlert("", "");
      setEntrepriseEditMode(false);      
      return;
    }

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/data/entreprise/${encodeURIComponent(ownerId)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
    );

    const org = data.organisation || {};
    const ct = data.contact || {};

    _initialOrg = { ...org };
    _initialContact = { ...ct };

    const opco = await loadRefOpco(portal);
    renderOpcoSelect(opco, org.id_opco || "");
    renderEntreprise(org);
    renderContact(ct);

    portal.showAlert("", "");
    setEntrepriseEditMode(false);
    showSaveSuccess("entSaveSuccess");
  }

  async function saveContact(portal) {
    const ownerId = getOwnerId();
    applyContactIdentityFormat();

    const current = collectContactFromUI();

    if (!current.nom || current.nom.trim().length === 0) {
      portal.showAlert("error", "Le nom du contact est obligatoire.");
      return;
    }

    const allowed = ["civilite","prenom","nom","email","telephone","telephone2","observations"];
    const patch = buildPatchFromInitial(_initialContact, current, allowed);

    if (Object.keys(patch).length === 0) {
      portal.showAlert("", "");
      setContactEditMode(false);
      return;
    }

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/data/contact/${encodeURIComponent(ownerId)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
    );

    const org = data.organisation || {};
    const ct = data.contact || {};

    _initialOrg = { ...org };
    _initialContact = { ...ct };

    renderEntreprise(org);
    renderContact(ct);

    portal.showAlert("", "");
    setContactEditMode(false);
    showSaveSuccess("contactSaveSuccess");
  }

  function cancelEntreprise(portal) {
    if (_initialOrg) {
      renderOpcoSelect(_refOpco || [], _initialOrg.id_opco || "");
      renderEntreprise(_initialOrg);
    }
    setEntrepriseEditMode(false);
    portal.showAlert("", "");
  }

  function cancelContact(portal) {
    if (_initialContact) renderContact(_initialContact);
    setContactEditMode(false);
    portal.showAlert("", "");
  }

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;



    const btnEditConnexion = document.getElementById("btnEditConnexion");
    const btnSaveConnexion = document.getElementById("btnSaveConnexion");
    const btnCancelConnexion = document.getElementById("btnCancelConnexion");
    const btnTestConnexion = document.getElementById("btnTestConnexion");
    bindSsoHelpButtons();
    bindSirhEvents(portal);
    setConnexionEditMode(false);
    setSirhEditMode(false);
    btnEditConnexion?.addEventListener("click", async () => {
      try { if (!isAdmin()) return; if (!_connexionLoaded) await loadConnexion(portal); portal.showAlert("", ""); setConnexionEditMode(true); } catch (e) { showSsoInfoPopup(e.message || String(e)); }
    });
    btnCancelConnexion?.addEventListener("click", () => { renderOwnerConnexion(_initialConnexion || {}); setConnexionEditMode(false); portal.showAlert("", ""); });
    btnSaveConnexion?.addEventListener("click", async () => {
      try { await saveConnexion(portal); portal.showAlert("", ""); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement connexions : " + (e.message || e)); }
    });
    btnTestConnexion?.addEventListener("click", async () => { await testConnexion(portal); });

    // Entreprise: admin only (UX). L'API est déjà sécurisée en 403.
    const btnEditEnt = document.getElementById("btnEditEntreprise");
    const btnSaveEnt = document.getElementById("btnSaveEntreprise");
    const btnCancelEnt = document.getElementById("btnCancelEntreprise");
    const btnUploadLogo = document.getElementById("btnUploadLogo");
    const btnRemoveLogo = document.getElementById("btnRemoveLogo");
    const inputLogo = document.getElementById("entLogoFileInput");
    if (!isAdmin()) {
      if (btnEditEnt) btnEditEnt.style.display = "none";
      if (btnSaveEnt) btnSaveEnt.style.display = "none";
      if (btnCancelEnt) btnCancelEnt.style.display = "none";
      if (btnUploadLogo) btnUploadLogo.style.display = "none";
      if (btnRemoveLogo) btnRemoveLogo.style.display = "none";
      document.querySelectorAll("[data-editable-ent='1']").forEach(el => el.disabled = true);
    }

    document.getElementById("btnEditEntreprise").addEventListener("click", async () => {
      try {
        if (!isAdmin()) return;
        if (!_loaded) await loadData(portal);
        portal.showAlert("", "");
        setEntrepriseEditMode(true);
      } catch (e) { showSsoInfoPopup(e.message || String(e)); }
    });

    document.getElementById("btnCancelEntreprise").addEventListener("click", () => cancelEntreprise(portal));
        if (btnUploadLogo && inputLogo) {
      btnUploadLogo.addEventListener("click", () => {
        if (!isAdmin()) return;
        inputLogo.click();
      });

      inputLogo.addEventListener("change", async (e) => {
        const file = e && e.target && e.target.files ? e.target.files[0] : null;
        try {
          if (!isAdmin()) return;
          if (!file) return;
          await uploadEntrepriseLogo(portal, file);
        } catch (err) {
          portal.showAlert("error", err.message || String(err));
        } finally {
          inputLogo.value = "";
        }
      });
    }

    if (btnRemoveLogo) {
      btnRemoveLogo.addEventListener("click", async () => {
        try {
          if (!isAdmin()) return;
          await archiveEntrepriseLogo(portal);
        } catch (err) {
          portal.showAlert("error", err.message || String(err));
        }
      });
    }
    document.getElementById("btnSaveEntreprise").addEventListener("click", async () => {
      try { await saveEntreprise(portal); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement entreprise : " + (e.message || e)); }
    });

    document.getElementById("btnEditContact").addEventListener("click", async () => {
      try {
        if (!_loaded) await loadData(portal);
        portal.showAlert("", "");
        setContactEditMode(true);
      } catch (e) { showSsoInfoPopup(e.message || String(e)); }
    });

    document.getElementById("btnCancelContact").addEventListener("click", () => cancelContact(portal));
    document.getElementById("btnSaveContact").addEventListener("click", async () => {
      try { await saveContact(portal); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement contact : " + (e.message || e)); }
    });

    const apeInput = document.getElementById("ent_code_ape_ent");
    if (apeInput) {
      apeInput.addEventListener("input", () => { apeInput.value = formatApeInput(apeInput.value); });
      apeInput.addEventListener("blur", async () => lookupApe(portal, apeInput.value));
    }

    const idccInput = document.getElementById("ent_idcc");
    if (idccInput) {
      idccInput.addEventListener("blur", async () => lookupIdcc(portal, idccInput.value));
    }

    ["ent_telephone_ent", "ct_tel_ca", "ct_tel2_ca"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => formatPhoneInput(el));
      el.addEventListener("blur", () => formatPhoneInput(el));
    });

    const prenomContact = document.getElementById("ct_prenom_ca");
    if (prenomContact) {
      prenomContact.addEventListener("blur", () => {
        prenomContact.value = normalizeContactPrenom(prenomContact.value);
      });
    }

    const nomContact = document.getElementById("ct_nom_ca");
    if (nomContact) {
      nomContact.addEventListener("input", () => {
        const start = nomContact.selectionStart;
        const end = nomContact.selectionEnd;
        nomContact.value = normalizeContactNom(nomContact.value);
        try {
          nomContact.setSelectionRange(start, end);
        } catch (_) {}
      });

      nomContact.addEventListener("blur", () => {
        nomContact.value = normalizeContactNom(nomContact.value);
      });
    }

    setEntrepriseEditMode(false);
    setContactEditMode(false);
  }

  (async () => {
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}

    const portal = window.portal;
    if (!portal) return;

    try {
      bindOnce(portal);
      if (!_loaded) await loadData(portal);
    } catch (e) {
      if (portal.showAlert) portal.showAlert("error", "Erreur de chargement : " + (e.message || e));
    }
  })();
})();