(function () {
  const P = window.PeoplePortal;
  if (!P) return;

  let currentProfile = {};
  let identityEditing = false;
  let educationEditing = false;
  let educationOptions = { levels: [], domains: [] };
  const saveSuccessTimers = {};

  function byId(id) { return document.getElementById(id); }
  function valueOrDash(value) { const text = value == null ? "" : String(value).trim(); return text || "–"; }
  function icon(symbol) { return `<svg viewBox="0 0 24 24" class="ns-icon-use" aria-hidden="true"><use href="/novoskill_icons.svg#${symbol}"></use></svg>`; }

  function field(label, control) {
    return `<span class="sb-field people-identity-field"><label class="sb-label">${P.escapeHtml(label)}</label>${control}</span>`;
  }

  function textInput(id, value, extra) {
    return `<input class="sb-ctrl" id="${id}" type="text" value="${P.escapeHtml(value || "")}"${extra || ""}>`;
  }

  function identityItem(label, value, symbol, editHtml, extraClass) {
    return `
      <div class="people-information-summary-item${extraClass ? ` ${extraClass}` : ""}">
        <span class="people-information-summary-icon" aria-hidden="true">${icon(symbol)}</span>
        <span class="people-information-summary-content">
          <span class="people-information-summary-label">${P.escapeHtml(label)}</span>
          <strong class="people-identity-read">${P.escapeHtml(valueOrDash(value))}</strong>
          <span class="people-identity-edit" hidden>${editHtml || ""}</span>
        </span>
      </div>`;
  }

  function companyItem(label, value) { return `<div class="people-information-company-item"><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${P.escapeHtml(valueOrDash(value))}</strong></div>`; }
  function projectionItem(label, value, wide, valueClass) {
    return `<div class="people-information-projection-item${wide ? " people-information-projection-item--wide" : ""}"><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong${valueClass ? ` class="${valueClass}"` : ""}>${P.escapeHtml(valueOrDash(value))}</strong></div>`;
  }

  function postePerspectiveLabel(value) {
    const raw = String(value || "").trim();
    const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!raw || normalized === "aucune") return "Aucune évolution formalisée pour ce poste";
    if (normalized === "faible") return "Évolution limitée dans le cadre actuel du poste";
    if (normalized === "moderee") return "Évolution possible avec élargissement progressif des responsabilités";
    if (normalized === "forte") return "Évolution importante possible vers des responsabilités élargies";
    return raw;
  }

  function selectOptions(items, selectedValue) {
    const selected = String(selectedValue || "").trim();
    return (items || []).map((item) => {
      const value = String(item?.value || "");
      return `<option value="${P.escapeHtml(value)}"${value === selected ? " selected" : ""}>${P.escapeHtml(item?.label || value || "—")}</option>`;
    }).join("");
  }

  function renderEducation(profile) {
    const read = `
      <div class="people-information-projection-grid people-education-read">
        ${projectionItem("Dernier diplôme obtenu", profile.niveau_education_label || profile.niveau_education, false)}
        ${projectionItem("Domaine d’éducation", profile.domaine_education_label || profile.domaine_education, true)}
      </div>`;
    const edit = `
      <div class="people-information-projection-grid people-education-edit" hidden>
        <span class="sb-field">
          <label class="sb-label" for="ppEducationLevel">Dernier diplôme obtenu</label>
          <select class="sb-select" id="ppEducationLevel">${selectOptions(educationOptions.levels, profile.niveau_education)}</select>
        </span>
        <span class="sb-field people-information-projection-item--wide">
          <label class="sb-label" for="ppEducationDomain">Domaine d’éducation</label>
          <select class="sb-select" id="ppEducationDomain">${selectOptions(educationOptions.domains, profile.domaine_education)}</select>
        </span>
      </div>`;

    return `<section class="people-information-projection-zone people-education-zone">
      <div class="people-information-projection-zone-head">
        <div class="people-information-projection-zone-title">
          <span class="people-information-summary-icon" aria-hidden="true">${icon("ns-icon-checklist")}</span>
          <span>Formation</span>
        </div>
        <div class="people-education-actions sb-actions">
          <span id="ppEducationMessage" class="sb-save-success" aria-live="polite"></span>
          <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="ppEducationEdit" aria-label="Modifier la formation" title="Modifier">
            ${icon("ns-icon-edit")}
          </button>
          <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="ppEducationSave" hidden>
            <span class="sb-btn-icon" aria-hidden="true">${icon("ns-icon-save")}</span>
            Enregistrer
          </button>
          <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="ppEducationCancel" hidden>
            <span class="sb-btn-icon" aria-hidden="true">${icon("ns-icon-close")}</span>
            Annuler
          </button>
        </div>
      </div>
      ${read}${edit}
    </section>`;
  }
  function roleItem(label, active, symbol, roleClass) { return `<div class="people-information-role-item${active ? " is-active" : ""}${roleClass ? ` ${roleClass}` : ""}"><span class="people-information-summary-icon" aria-hidden="true">${icon(symbol)}</span><span><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${active ? "Oui" : "Non"}</strong></span></div>`; }

  function setMessage(host, text, isError) {
    if (!host) return;
    host.textContent = text || "";
    host.classList.toggle("is-error", Boolean(isError));
    host.classList.toggle("is-success", Boolean(text) && !isError);
    host.classList.toggle("is-visible", Boolean(text));
  }


  function hideSaveSuccess(id) {
    const el = byId(id);
    if (!el) return;
    if (saveSuccessTimers[id]) {
      clearTimeout(saveSuccessTimers[id]);
      delete saveSuccessTimers[id];
    }
    el.textContent = "";
    el.style.display = "none";
    el.classList.remove("is-error");
  }

  function showSaveSuccess(id) {
    const el = byId(id);
    if (!el) return;
    hideSaveSuccess(id);
    el.textContent = "Enregistré avec succès";
    el.style.display = "inline-flex";
    saveSuccessTimers[id] = setTimeout(() => {
      el.textContent = "";
      el.style.display = "none";
      delete saveSuccessTimers[id];
    }, 5000);
  }

  function showInlineError(id, message) {
    const el = byId(id);
    if (!el) return;
    hideSaveSuccess(id);
    el.textContent = message || "Une erreur est survenue.";
    el.classList.add("is-error");
    el.style.display = "inline-flex";
  }

  function normalizeComparable(value) {
    return value == null ? "" : String(value).trim();
  }

  function renderIdentity(profile) {
    const identity = byId("ppInfoIdentity");
    if (!identity) return;

    const fullName = [profile.civilite, profile.prenom, profile.nom].filter(Boolean).join(" ");
    const addressLine2 = [profile.code_postal, profile.ville].filter(Boolean).join(" ");
    const address = [profile.adresse, addressLine2].filter(Boolean).join("\n");
    const civ = String(profile.civilite || "").trim();

    const nameEdit = `
      <span class="people-identity-name-fields">
        ${field("Civilité", `<select class="sb-select" id="ppIdentityCivilite"><option value="M."${civ === "M." ? " selected" : ""}>M.</option><option value="Mme"${civ === "Mme" ? " selected" : ""}>Mme</option><option value="-"${civ === "-" ? " selected" : ""}>-</option></select>`)}
        ${field("Prénom", textInput("ppIdentityPrenom", profile.prenom, " required"))}
        ${field("Nom", textInput("ppIdentityNom", profile.nom, " required"))}
      </span>`;

    const addressEdit = `
      <span class="people-identity-address-fields">
        ${field("Adresse", textInput("ppIdentityAdresse", profile.adresse))}
        <span class="people-identity-address-line">
          ${field("Code postal", textInput("ppIdentityCodePostal", profile.code_postal))}
          ${field("Ville", textInput("ppIdentityVille", profile.ville))}
        </span>
      </span>`;

    identity.innerHTML = [
      identityItem("Nom", fullName, "ns-icon-user", nameEdit, "people-identity-item--name"),
      identityItem("Email", profile.email, "ns-icon-comment", `<small class="people-identity-readonly-help">Contactez votre administrateur pour changer l’email.</small>`, "people-identity-item--readonly"),
      identityItem("Adresse", address, "ns-icon-organisation", addressEdit, "people-identity-item--address"),
      identityItem("Pays", profile.pays, "ns-icon-globe", field("Pays", textInput("ppIdentityPays", profile.pays))),
      identityItem("Téléphone", profile.telephone, "ns-icon-info", field("Téléphone", `<input class="sb-ctrl" id="ppIdentityTelephone" type="tel" inputmode="tel" value="${P.escapeHtml(profile.telephone || "")}">`)),
      identityItem("Date de naissance", P.fmtDate(profile.date_naissance), "ns-icon-calendar", field("Date de naissance", `<input class="sb-ctrl people-identity-date" id="ppIdentityDateNaissance" type="date" value="${P.escapeHtml(profile.date_naissance || "")}">`))
    ].join("");

    setIdentityEditMode(identityEditing, false);
  }

  function render(profile) {
    currentProfile = profile || {};
    renderIdentity(currentProfile);

    const company = byId("ppInfoCompany");
    if (company) company.innerHTML = [companyItem("Entreprise", profile.nom_owner), companyItem("Matricule", profile.matricule), companyItem("Service", profile.nom_service), companyItem("Poste actuel", profile.intitule_poste), companyItem("Type de contrat", profile.type_contrat), companyItem("Date d’entrée", P.fmtDate(profile.date_entree)), companyItem("Début dans le poste", P.fmtDate(profile.date_debut_poste))].join("");

    const projection = byId("ppInfoProjection");
    if (projection) {
      projection.innerHTML = `${renderEducation(profile)}<section class="people-information-projection-zone"><div class="people-information-projection-zone-title"><span class="people-information-summary-icon" aria-hidden="true">${icon("ns-icon-job")}</span><span>Poste et perspectives</span></div><div class="people-information-projection-grid">${projectionItem("Mission principale", profile.mission_principale, true, "people-information-projection-value--regular")}${projectionItem("Perspectives d’évolution du poste", postePerspectiveLabel(profile.perspectives_evolution), true)}</div></section>`;
      bindEducationActions();
      setEducationEditMode(educationEditing, false);
    }

    const roles = byId("ppInfoRoles");
    if (roles) roles.innerHTML = [roleItem("Manager", Boolean(profile.ismanager), "ns-icon-users", "people-information-role-item--manager"), roleItem("Formateur", Boolean(profile.isformateur), "ns-icon-legacy-05d2e7645abd", "people-information-role-item--formateur")].join("");

    const initials = byId("ppProfileInitials");
    if (initials) initials.textContent = `${String(profile.prenom || "").charAt(0)}${String(profile.nom || "").charAt(0)}`.toUpperCase() || "–";
  }

  function setIdentityEditMode(active, clearMessage = true) {
    identityEditing = Boolean(active);
    const card = document.querySelector(".people-information-card--identity");
    card?.classList.toggle("is-editing", identityEditing);

    document.querySelectorAll("#ppInfoIdentity .people-identity-read").forEach((el) => { el.hidden = identityEditing; });
    document.querySelectorAll("#ppInfoIdentity .people-identity-edit").forEach((el) => {
      el.hidden = !identityEditing || !el.innerHTML.trim();
    });

    const edit = byId("ppIdentityEdit");
    const cancel = byId("ppIdentityCancel");
    const save = byId("ppIdentitySave");
    if (edit) edit.hidden = identityEditing;
    if (cancel) cancel.hidden = !identityEditing;
    if (save) save.hidden = !identityEditing;
    if (clearMessage) hideSaveSuccess("ppIdentityMessage");
  }

  function setEducationEditMode(active, clearMessage = true) {
    educationEditing = Boolean(active);
    document.querySelector(".people-education-zone")?.classList.toggle("is-editing", educationEditing);
    const read = document.querySelector(".people-education-read");
    const editZone = document.querySelector(".people-education-edit");
    const edit = byId("ppEducationEdit");
    const cancel = byId("ppEducationCancel");
    const save = byId("ppEducationSave");
    if (read) read.hidden = educationEditing;
    if (editZone) editZone.hidden = !educationEditing;
    if (edit) edit.hidden = educationEditing;
    if (cancel) cancel.hidden = !educationEditing;
    if (save) save.hidden = !educationEditing;
    if (clearMessage) hideSaveSuccess("ppEducationMessage");
  }

  function bindEducationActions() {
    byId("ppEducationEdit")?.addEventListener("click", () => setEducationEditMode(true));
    byId("ppEducationCancel")?.addEventListener("click", () => {
      hideSaveSuccess("ppEducationMessage");
      educationEditing = false;
      render(currentProfile);
    });
    byId("ppEducationSave")?.addEventListener("click", saveEducation);
  }

  async function saveEducation() {
    const id = P.getEffectifId();
    const save = byId("ppEducationSave");
    if (!id) { showInlineError("ppEducationMessage", "Profil People indisponible."); return; }

    hideSaveSuccess("ppEducationMessage");
    const payload = {
      niveau_education: byId("ppEducationLevel")?.value || "",
      domaine_education: byId("ppEducationDomain")?.value || ""
    };
    const hasChanges =
      normalizeComparable(payload.niveau_education) !== normalizeComparable(currentProfile.niveau_education) ||
      normalizeComparable(payload.domaine_education) !== normalizeComparable(currentProfile.domaine_education);

    if (!hasChanges) {
      setEducationEditMode(false, false);
      return;
    }

    if (save) save.disabled = true;
    const result = await P.api(
      `/people/informations/${encodeURIComponent(id)}/education`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ).catch(err => ({ error: err.message }));
    if (save) save.disabled = false;
    if (result.error) { showInlineError("ppEducationMessage", result.error); return; }
    currentProfile = result.profile || { ...currentProfile, ...payload };
    educationEditing = false;
    render(currentProfile);
    showSaveSuccess("ppEducationMessage");
  }

  async function authToken() {
    const session = await window.PortalAuthCommon?.getSession().catch(() => null);
    return session?.access_token || "";
  }

  async function loadPhoto(id) {
    if (!currentProfile.has_photo) return;
    const token = await authToken(); if (!token) return;
    const response = await fetch(`${P.API_BASE}/people/informations/${encodeURIComponent(id)}/photo`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const img = byId("ppProfilePhoto"); const initials = byId("ppProfileInitials");
    if (img) { img.src = url; img.hidden = false; img.onload = () => URL.revokeObjectURL(url); }
    if (initials) initials.hidden = true;
  }

  async function load() {
    const id = P.getEffectifId(); const errorHost = byId("ppInfoError");
    if (!id) { setMessage(errorHost, "Profil People indisponible.", true); return; }
    const data = await P.api(`/people/informations/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (data.error) { setMessage(errorHost, data.error, true); return; }
    setMessage(errorHost, "", false); educationOptions = data.education_options || { levels: [], domains: [] }; render(data.profile || {}); await loadPhoto(id);
  }

  byId("ppIdentityEdit")?.addEventListener("click", () => setIdentityEditMode(true));
  byId("ppIdentityCancel")?.addEventListener("click", () => {
    hideSaveSuccess("ppIdentityMessage");
    renderIdentity(currentProfile);
    setIdentityEditMode(false, false);
  });
  byId("ppIdentitySave")?.addEventListener("click", async () => {
    const id = P.getEffectifId();
    const save = byId("ppIdentitySave");
    if (!id) { showInlineError("ppIdentityMessage", "Profil People indisponible."); return; }

    hideSaveSuccess("ppIdentityMessage");
    const payload = {
      civilite: byId("ppIdentityCivilite")?.value || "",
      prenom: byId("ppIdentityPrenom")?.value || "",
      nom: byId("ppIdentityNom")?.value || "",
      telephone: byId("ppIdentityTelephone")?.value || "",
      adresse: byId("ppIdentityAdresse")?.value || "",
      code_postal: byId("ppIdentityCodePostal")?.value || "",
      ville: byId("ppIdentityVille")?.value || "",
      pays: byId("ppIdentityPays")?.value || "",
      date_naissance: byId("ppIdentityDateNaissance")?.value || null
    };
    const identityFields = ["civilite", "prenom", "nom", "telephone", "adresse", "code_postal", "ville", "pays", "date_naissance"];
    const hasChanges = identityFields.some((key) => normalizeComparable(payload[key]) !== normalizeComparable(currentProfile[key]));

    if (!hasChanges) {
      setIdentityEditMode(false, false);
      renderIdentity(currentProfile);
      return;
    }

    if (save) save.disabled = true;
    const result = await P.api(
      `/people/informations/${encodeURIComponent(id)}/identity`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ).catch(err => ({ error: err.message }));
    if (save) save.disabled = false;
    if (result.error) { showInlineError("ppIdentityMessage", result.error); return; }
    currentProfile = result.profile || { ...currentProfile, ...payload };
    identityEditing = false;
    renderIdentity(currentProfile);
    setIdentityEditMode(false, false);
    showSaveSuccess("ppIdentityMessage");
  });

  byId("ppProfilePhotoButton")?.addEventListener("click", () => byId("ppProfilePhotoInput")?.click());
  byId("ppProfilePhotoInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; const id = P.getEffectifId(); const host = byId("ppInfoError"); if (!file || !id) return;
    const formData = new FormData(); formData.append("photo", file);
    const token = await authToken();
    const response = await fetch(`${P.API_BASE}/people/informations/${encodeURIComponent(id)}/photo`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(host, data.detail || "Impossible d’enregistrer la photo.", true); return; }
    currentProfile.has_photo = true; const img = byId("ppProfilePhoto"); const initials = byId("ppProfileInitials");
    if (img) { img.src = URL.createObjectURL(file); img.hidden = false; } if (initials) initials.hidden = true;
    setMessage(host, "Photo de profil enregistrée.", false); event.target.value = "";
  });

  load();
})();
