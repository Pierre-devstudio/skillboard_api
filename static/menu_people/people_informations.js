(function () {
  const P = window.PeoplePortal;
  if (!P) return;

  let currentProfile = {};

  function byId(id) { return document.getElementById(id); }
  function valueOrDash(value) { const text = value == null ? "" : String(value).trim(); return text || "–"; }
  function icon(symbol) { return `<svg viewBox="0 0 24 24" class="ns-icon-use" aria-hidden="true"><use href="/novoskill_icons.svg#${symbol}"></use></svg>`; }
  function summaryItem(label, value, symbol) {
    return `<div class="people-information-summary-item"><span class="people-information-summary-icon" aria-hidden="true">${icon(symbol)}</span><span class="people-information-summary-content"><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${P.escapeHtml(valueOrDash(value))}</strong></span></div>`;
  }
  function companyItem(label, value) { return `<div class="people-information-company-item"><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${P.escapeHtml(valueOrDash(value))}</strong></div>`; }
  function projectionItem(label, value, wide) { return `<div class="people-information-projection-item${wide ? " people-information-projection-item--wide" : ""}"><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${P.escapeHtml(valueOrDash(value))}</strong></div>`; }
  function roleItem(label, active, symbol) { return `<div class="people-information-role-item${active ? " is-active" : ""}"><span class="people-information-summary-icon" aria-hidden="true">${icon(symbol)}</span><span><span class="people-information-summary-label">${P.escapeHtml(label)}</span><strong>${active ? "Oui" : "Non"}</strong></span></div>`; }

  function setMessage(host, text, isError) {
    if (!host) return;
    host.textContent = text || "";
    host.classList.toggle("is-error", Boolean(isError));
    host.classList.toggle("is-success", Boolean(text) && !isError);
  }

  function render(profile) {
    currentProfile = profile || {};
    const identity = byId("ppInfoIdentity");
    if (identity) {
      const fullName = [profile.civilite, profile.prenom, profile.nom].filter(Boolean).join(" ");
      const addressLine2 = [profile.code_postal, profile.ville].filter(Boolean).join(" ");
      const address = [profile.adresse, addressLine2].filter(Boolean).join("\n");
      identity.innerHTML = [
        summaryItem("Nom", fullName, "ns-icon-user"), summaryItem("Email", profile.email, "ns-icon-comment"),
        summaryItem("Adresse", address, "ns-icon-organisation"), summaryItem("Pays", profile.pays, "ns-icon-globe"),
        summaryItem("Téléphone", profile.telephone, "ns-icon-info"), summaryItem("Date de naissance", P.fmtDate(profile.date_naissance), "ns-icon-calendar")
      ].join("");
    }
    const company = byId("ppInfoCompany");
    if (company) company.innerHTML = [companyItem("Entreprise", profile.nom_owner), companyItem("Matricule", profile.matricule), companyItem("Service", profile.nom_service), companyItem("Poste actuel", profile.intitule_poste), companyItem("Type de contrat", profile.type_contrat), companyItem("Date d’entrée", P.fmtDate(profile.date_entree)), companyItem("Début dans le poste", P.fmtDate(profile.date_debut_poste))].join("");
    const projection = byId("ppInfoProjection");
    if (projection) projection.innerHTML = `<section class="people-information-projection-zone"><div class="people-information-projection-zone-title"><span class="people-information-summary-icon" aria-hidden="true">${icon("ns-icon-checklist")}</span><span>Formation</span></div><div class="people-information-projection-grid">${projectionItem("Dernier diplôme obtenu", profile.niveau_education, false)}${projectionItem("Domaine d’éducation", profile.domaine_education, true)}</div></section><section class="people-information-projection-zone"><div class="people-information-projection-zone-title"><span class="people-information-summary-icon" aria-hidden="true">${icon("ns-icon-job")}</span><span>Poste et perspectives</span></div><div class="people-information-projection-grid">${projectionItem("Mission principale", profile.mission_principale, true)}${projectionItem("Perspectives d’évolution", profile.perspectives_evolution, true)}</div></section>`;
    const roles = byId("ppInfoRoles");
    if (roles) roles.innerHTML = [roleItem("Manager", Boolean(profile.ismanager), "ns-icon-user"), roleItem("Formateur", Boolean(profile.isformateur), "ns-icon-checklist")].join("");
    const initials = byId("ppProfileInitials");
    if (initials) initials.textContent = `${String(profile.prenom || "").charAt(0)}${String(profile.nom || "").charAt(0)}`.toUpperCase() || "–";
  }

  function fillForm() {
    const map = { ppIdentityCivilite: "civilite", ppIdentityPrenom: "prenom", ppIdentityNom: "nom", ppIdentityTelephone: "telephone", ppIdentityAdresse: "adresse", ppIdentityCodePostal: "code_postal", ppIdentityVille: "ville", ppIdentityPays: "pays", ppIdentityDateNaissance: "date_naissance" };
    Object.entries(map).forEach(([id, key]) => { const el = byId(id); if (el) el.value = currentProfile[key] || ""; });
  }

  function setEditMode(active) {
    const summary = byId("ppInfoIdentity"); const form = byId("ppIdentityForm"); const edit = byId("ppIdentityEdit");
    if (summary) summary.hidden = active; if (form) form.hidden = !active; if (edit) edit.hidden = active;
    if (active) fillForm();
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
    setMessage(errorHost, "", false); render(data.profile || {}); await loadPhoto(id);
  }

  byId("ppIdentityEdit")?.addEventListener("click", () => setEditMode(true));
  byId("ppIdentityCancel")?.addEventListener("click", () => { setMessage(byId("ppIdentityMessage"), "", false); setEditMode(false); });
  byId("ppIdentityForm")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const id = P.getEffectifId(); const msg = byId("ppIdentityMessage"); const save = byId("ppIdentitySave");
    if (save) save.disabled = true;
    const payload = { civilite: byId("ppIdentityCivilite")?.value || "", prenom: byId("ppIdentityPrenom")?.value || "", nom: byId("ppIdentityNom")?.value || "", telephone: byId("ppIdentityTelephone")?.value || "", adresse: byId("ppIdentityAdresse")?.value || "", code_postal: byId("ppIdentityCodePostal")?.value || "", ville: byId("ppIdentityVille")?.value || "", pays: byId("ppIdentityPays")?.value || "", date_naissance: byId("ppIdentityDateNaissance")?.value || null };
    const result = await P.api(`/people/informations/${encodeURIComponent(id)}/identity`, { method: "PATCH", body: JSON.stringify(payload) }).catch(err => ({ error: err.message }));
    if (save) save.disabled = false;
    if (result.error) { setMessage(msg, result.error, true); return; }
    render(result.profile || payload); setEditMode(false); setMessage(byId("ppInfoError"), "Informations enregistrées.", false);
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
