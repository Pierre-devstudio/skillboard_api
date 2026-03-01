(function () {
  let _bound = false;
  let _loaded = false;

  let _initialOrg = null;
  let _initialContact = null;
  let _refOpco = null;

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function setStatus(msg) {
    const el = document.getElementById("dataStatus");
    if (!el) return;
    el.textContent = msg || "—";
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

  function setEntrepriseEditMode(isEdit) {
    document.querySelectorAll("[data-editable-ent='1']").forEach(el => el.disabled = !isEdit);
    const b1 = document.getElementById("btnEditEntreprise");
    const b2 = document.getElementById("btnSaveEntreprise");
    const b3 = document.getElementById("btnCancelEntreprise");
    if (b1) b1.style.display = isEdit ? "none" : "inline-flex";
    if (b2) b2.style.display = isEdit ? "inline-flex" : "none";
    if (b3) b3.style.display = isEdit ? "inline-flex" : "none";
  }

  function setContactEditMode(isEdit) {
    document.querySelectorAll("[data-editable-ct='1']").forEach(el => el.disabled = !isEdit);
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

  function setOpcoHintFromCurrent() {
    const sel = document.getElementById("ent_id_opco");
    if (!sel) return;
    const id = sel.value || "";
    if (!id) { setTextOrDash("opcoHint", "—", false); return; }
    const item = (_refOpco || []).find(x => x.id_opco === id);
    setTextOrDash("opcoHint", item ? item.nom_opco : "—", false);
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

    setTextOrDash("opcoHint", org.opco_nom || "—", false);
  }

  function renderContact(ct) {
    const civ = document.getElementById("ct_civ_ca");
    if (civ) civ.value = (ct.civilite || "").trim();

    setValueOrEmpty("ct_prenom_ca", ct.prenom);
    setValueOrEmpty("ct_nom_ca", ct.nom);

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
    setStatus("Chargement…");
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

    setEntrepriseEditMode(false);
    setContactEditMode(false);

    _loaded = true;
    setStatus("—");
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
    return {
      civilite: normalizeValue(document.getElementById("ct_civ_ca")?.value),
      prenom: normalizeValue(document.getElementById("ct_prenom_ca")?.value),
      nom: normalizeValue(document.getElementById("ct_nom_ca")?.value),
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
      portal.showAlert("success", "Aucune modification à enregistrer.");
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

    portal.showAlert("success", "Informations entreprise enregistrées.");
    setEntrepriseEditMode(false);
  }

  async function saveContact(portal) {
    const ownerId = getOwnerId();
    const current = collectContactFromUI();

    if (!current.nom || current.nom.trim().length === 0) {
      portal.showAlert("error", "Le nom du contact est obligatoire.");
      return;
    }

    const allowed = ["civilite","prenom","nom","email","telephone","telephone2","observations"];
    const patch = buildPatchFromInitial(_initialContact, current, allowed);

    if (Object.keys(patch).length === 0) {
      portal.showAlert("success", "Aucune modification à enregistrer.");
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

    portal.showAlert("success", "Informations du contact enregistrées.");
    setContactEditMode(false);
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

    document.getElementById("btnEditEntreprise").addEventListener("click", async () => {
      try {
        if (!_loaded) await loadData(portal);
        portal.showAlert("", "");
        setEntrepriseEditMode(true);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
    });

    document.getElementById("btnCancelEntreprise").addEventListener("click", () => cancelEntreprise(portal));
    document.getElementById("btnSaveEntreprise").addEventListener("click", async () => {
      try { await saveEntreprise(portal); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement entreprise : " + (e.message || e)); }
    });

    document.getElementById("btnEditContact").addEventListener("click", async () => {
      try {
        if (!_loaded) await loadData(portal);
        portal.showAlert("", "");
        setContactEditMode(true);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
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

    const opcoSel = document.getElementById("ent_id_opco");
    if (opcoSel) {
      opcoSel.addEventListener("change", () => setOpcoHintFromCurrent());
    }

    ["ent_telephone_ent", "ct_tel_ca", "ct_tel2_ca"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => formatPhoneInput(el));
      el.addEventListener("blur", () => formatPhoneInput(el));
    });

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
      setStatus("Erreur de chargement.");
    }
  })();
})();