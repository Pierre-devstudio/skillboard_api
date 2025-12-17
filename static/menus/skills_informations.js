(function () {
  let _bound = false;
  let _loaded = false;

  let _initialEntreprise = null;
  let _initialContact = null;
  let _refOpco = null;

  function setValueOrEmpty(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value ?? "";
  }

  function setTextOrDash(id, value, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (value != null && value !== "") ? value : "—";
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

  function setEntrepriseEditMode(isEdit) {
    document.querySelectorAll("[data-editable-ent='1']").forEach(el => el.disabled = !isEdit);
    document.getElementById("btnEditEntreprise").style.display = isEdit ? "none" : "inline-block";
    document.getElementById("btnSaveEntreprise").style.display = isEdit ? "inline-block" : "none";
    document.getElementById("btnCancelEntreprise").style.display = isEdit ? "inline-block" : "none";
  }

  function setContactEditMode(isEdit) {
    document.querySelectorAll("[data-editable-ct='1']").forEach(el => el.disabled = !isEdit);
    document.getElementById("btnEditContact").style.display = isEdit ? "none" : "inline-block";
    document.getElementById("btnSaveContact").style.display = isEdit ? "inline-block" : "none";
    document.getElementById("btnCancelContact").style.display = isEdit ? "inline-block" : "none";
  }

  async function loadRefOpco(portal) {
    if (_refOpco) return _refOpco;
    _refOpco = await portal.apiJson(`${portal.apiBase}/skills/referentiels/opco`);
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
      const r = await portal.apiJson(`${portal.apiBase}/skills/referentiels/idcc/${encodeURIComponent(v)}`);
      setTextOrDash("idccHint", r.libelle || "—", false);
    } catch {
      setTextOrDash("idccHint", "IDCC introuvable", true);
    }
  }

  function formatApeInput(raw) {
    let digits = (raw || "").replace(/[^\d]/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return digits.slice(0, 2) + "." + digits.slice(2);
  }

  async function lookupApe(portal, codeApe) {
    const v = (codeApe || "").trim();
    if (!v) { setTextOrDash("apeHint", "—", false); return; }
    try {
      const r = await portal.apiJson(`${portal.apiBase}/skills/referentiels/ape/${encodeURIComponent(v)}`);
      setTextOrDash("apeHint", r.intitule_ape || "—", false);
    } catch {
      setTextOrDash("apeHint", "Code APE invalide ou introuvable", true);
    }
  }

  function renderEntreprise(ent) {
    setValueOrEmpty("ent_nom_ent", ent.nom_ent);
    setValueOrEmpty("ent_siret_ent", ent.siret_ent);
    setValueOrEmpty("ent_num_tva_ent", ent.num_tva_ent);

    setValueOrEmpty("ent_adresse_ent", ent.adresse_ent);
    setValueOrEmpty("ent_adresse_cplt_ent", ent.adresse_cplt_ent);
    setValueOrEmpty("ent_cp_ent", ent.cp_ent);
    setValueOrEmpty("ent_ville_ent", ent.ville_ent);
    setValueOrEmpty("ent_pays_ent", ent.pays_ent);

    setValueOrEmpty("ent_telephone_ent", ent.telephone_ent);
    setValueOrEmpty("ent_email_ent", ent.email_ent);
    setValueOrEmpty("ent_site_web", ent.site_web);

    setValueOrEmpty("ent_code_ape_ent", ent.code_ape_ent);
    setTextOrDash("apeHint", ent.code_ape_intitule || "—", false);

    setValueOrEmpty("ent_idcc", ent.idcc);
    setTextOrDash("idccHint", ent.idcc_libelle || "—", false);

    setTextOrDash("opcoHint", ent.opco_nom || "—", false);
  }

  function renderContact(ct) {
    document.getElementById("ct_civ_ca").value = (ct.civ_ca || "").trim();
    setValueOrEmpty("ct_prenom_ca", ct.prenom_ca);
    setValueOrEmpty("ct_nom_ca", ct.nom_ca);
    setValueOrEmpty("ct_role_ca", ct.role_ca);
    setValueOrEmpty("ct_tel_ca", ct.tel_ca);
    setValueOrEmpty("ct_tel2_ca", ct.tel2_ca);
    setValueOrEmpty("ct_mail_ca", ct.mail_ca);

    const obs = document.getElementById("ct_obs_ca");
    if (obs) obs.value = ct.obs_ca ?? "";
  }

  async function loadInformations(portal) {
    portal.showAlert("", "");
    const data = await portal.apiJson(`${portal.apiBase}/skills/informations/${encodeURIComponent(portal.contactId)}`);

    const ent = data.entreprise || {};
    const ct = data.contact || {};

    _initialEntreprise = { ...ent };
    _initialContact = { ...ct };

    const opco = await loadRefOpco(portal);
    renderOpcoSelect(opco, ent.id_opco || "");

    renderEntreprise(ent);
    renderContact(ct);

    setEntrepriseEditMode(false);
    setContactEditMode(false);

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
    return {
      civ_ca: normalizeValue(document.getElementById("ct_civ_ca")?.value),
      prenom_ca: normalizeValue(document.getElementById("ct_prenom_ca")?.value),
      nom_ca: normalizeValue(document.getElementById("ct_nom_ca")?.value),
      role_ca: normalizeValue(document.getElementById("ct_role_ca")?.value),
      tel_ca: normalizeValue(document.getElementById("ct_tel_ca")?.value),
      tel2_ca: normalizeValue(document.getElementById("ct_tel2_ca")?.value),
      mail_ca: normalizeValue(document.getElementById("ct_mail_ca")?.value),
      obs_ca: normalizeValue(document.getElementById("ct_obs_ca")?.value),
    };
  }

  async function saveEntreprise(portal) {
    const current = collectEntrepriseFromUI();
    const allowed = [
      "adresse_ent","adresse_cplt_ent","cp_ent","ville_ent","pays_ent",
      "email_ent","telephone_ent","site_web",
      "siret_ent","code_ape_ent","num_tva_ent","idcc","id_opco"
    ];
    const patch = buildPatchFromInitial(_initialEntreprise, current, allowed);

    if (Object.keys(patch).length === 0) {
      portal.showAlert("success", "Aucune modification à enregistrer.");
      setEntrepriseEditMode(false);
      return;
    }

    const data = await portal.apiJson(
      `${portal.apiBase}/skills/informations/entreprise/${encodeURIComponent(portal.contactId)}`,
      { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(patch) }
    );

    _initialEntreprise = { ...data.entreprise };
    _initialContact = { ...data.contact };

    const opco = await loadRefOpco(portal);
    renderOpcoSelect(opco, data.entreprise.id_opco || "");
    renderEntreprise(data.entreprise);

    portal.showAlert("success", "Informations entreprise enregistrées.");
    setEntrepriseEditMode(false);
  }

  async function saveContact(portal) {
    const current = collectContactFromUI();
    const allowed = ["civ_ca","prenom_ca","nom_ca","role_ca","tel_ca","tel2_ca","mail_ca","obs_ca"];
    const patch = buildPatchFromInitial(_initialContact, current, allowed);

    if (patch.nom_ca != null && patch.nom_ca.trim().length === 0) {
      portal.showAlert("error", "Le nom du contact est obligatoire.");
      return;
    }

    if (Object.keys(patch).length === 0) {
      portal.showAlert("success", "Aucune modification à enregistrer.");
      setContactEditMode(false);
      return;
    }

    const data = await portal.apiJson(
      `${portal.apiBase}/skills/informations/contact/${encodeURIComponent(portal.contactId)}`,
      { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(patch) }
    );

    _initialEntreprise = { ...data.entreprise };
    _initialContact = { ...data.contact };

    renderContact(data.contact);

    portal.showAlert("success", "Informations du contact enregistrées.");
    setContactEditMode(false);
  }

  function cancelEntrepriseEdits(portal) {
    if (_initialEntreprise) {
      renderOpcoSelect(_refOpco || [], _initialEntreprise.id_opco || "");
      renderEntreprise(_initialEntreprise);
    }
    setEntrepriseEditMode(false);
    portal.showAlert("", "");
  }

  function cancelContactEdits(portal) {
    if (_initialContact) renderContact(_initialContact);
    setContactEditMode(false);
    portal.showAlert("", "");
  }

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    // Entreprise buttons
    document.getElementById("btnEditEntreprise").addEventListener("click", async () => {
      try {
        if (!_loaded) await loadInformations(portal);
        portal.showAlert("", "");
        setEntrepriseEditMode(true);
      } catch (e) {
        portal.showAlert("error", e.message);
      }
    });

    document.getElementById("btnCancelEntreprise").addEventListener("click", () => cancelEntrepriseEdits(portal));
    document.getElementById("btnSaveEntreprise").addEventListener("click", async () => {
      try { await saveEntreprise(portal); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement entreprise : " + e.message); }
    });

    // Contact buttons
    document.getElementById("btnEditContact").addEventListener("click", async () => {
      try {
        if (!_loaded) await loadInformations(portal);
        portal.showAlert("", "");
        setContactEditMode(true);
      } catch (e) {
        portal.showAlert("error", e.message);
      }
    });

    document.getElementById("btnCancelContact").addEventListener("click", () => cancelContactEdits(portal));
    document.getElementById("btnSaveContact").addEventListener("click", async () => {
      try { await saveContact(portal); }
      catch (e) { portal.showAlert("error", "Erreur enregistrement contact : " + e.message); }
    });

    // APE format + lookup
    const apeInput = document.getElementById("ent_code_ape_ent");
    apeInput.addEventListener("input", () => {
      apeInput.value = formatApeInput(apeInput.value);
    });
    apeInput.addEventListener("blur", async () => lookupApe(portal, apeInput.value));

    // IDCC lookup
    document.getElementById("ent_idcc").addEventListener("blur", async () => {
      await lookupIdcc(portal, document.getElementById("ent_idcc").value);
    });

    // OPCO hint
    document.getElementById("ent_id_opco").addEventListener("change", () => setOpcoHintFromCurrent());

    setEntrepriseEditMode(false);
    setContactEditMode(false);
  }

  window.SkillsInformations = {
    onShow: async (portal) => {
      try {
        bindOnce(portal);
        if (!_loaded) await loadInformations(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur de chargement des informations : " + e.message);
      }
    }
  };
})();
