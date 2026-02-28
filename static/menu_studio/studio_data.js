(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function fmtBool(v) {
    if (v === true) return "Oui";
    if (v === false) return "Non";
    return "";
  }

  function addField(container, label, value) {
    const v = (value === null || value === undefined) ? "" : String(value).trim();
    if (!v) return;
    const row = document.createElement("div");
    row.className = "card-sub";
    row.innerHTML = `<strong>${esc(label)}</strong> : ${esc(v)}`;
    container.appendChild(row);
  }

  function addFieldBool(container, label, value) {
    const v = fmtBool(value);
    if (!v) return;
    addField(container, label, v);
  }

  function clear(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function composeAdresse(d) {
    const parts = [
      d?.adresse_ent,
      d?.adresse_cplt_ent,
      [d?.cp_ent, d?.ville_ent].filter(Boolean).join(" "),
      d?.pays_ent
    ].map(x => (x || "").toString().trim()).filter(Boolean);
    return parts.join(", ");
  }

  function composeAdresseContact(d) {
    const parts = [
      d?.adresse,
      [d?.cp, d?.ville].filter(Boolean).join(" "),
      d?.pays
    ].map(x => (x || "").toString().trim()).filter(Boolean);
    return parts.join(", ");
  }

  async function fetchVosDonnees() {
    await (window.__studioAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return { ok: false, msg: "Auth non initialisée." };

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return { ok: false, msg: "Session absente." };

    const idOwner = getOwnerId();
    if (!idOwner) return { ok: false, msg: "Owner manquant (?id=...)." };
    if (idOwner === "__superadmin__") return { ok: false, msg: "Mode super admin: sélectionnez un owner via ?id=..." };

    const r = await fetch(`${API_BASE}/studio/data/${encodeURIComponent(idOwner)}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const det = (data && (data.detail || data.message)) ? String(data.detail || data.message) : "";
      return { ok: false, msg: `Erreur API (${r.status}) ${det}`.trim() };
    }
    return { ok: true, data: data || {} };
  }

  async function render() {
    const statusEl = byId("dataStatus");
    const orgEl = byId("orgFields");
    const contactEl = byId("contactFields");

    if (statusEl) statusEl.textContent = "Chargement…";
    clear(orgEl);
    clear(contactEl);

    const res = await fetchVosDonnees();
    if (!res.ok) {
      if (statusEl) statusEl.textContent = res.msg || "Impossible de charger les données.";
      return;
    }

    const org = res.data.organisation || {};
    const c = res.data.contact || {};

    if (statusEl) statusEl.textContent = "Données chargées.";

    // ---- Entreprise
    addField(orgEl, "Nom", org.nom_ent);
    const adrOrg = composeAdresse(org);
    addField(orgEl, "Adresse", adrOrg);
    addField(orgEl, "Email", org.email_ent);
    addField(orgEl, "Téléphone", org.telephone_ent);
    addField(orgEl, "Site web", org.site_web);

    addField(orgEl, "SIRET", org.siret_ent);
    addField(orgEl, "Code APE", org.code_ape_ent);
    addField(orgEl, "TVA intracom", org.num_tva_ent);

    addField(orgEl, "Effectif", org.effectif_ent);
    addField(orgEl, "Date de création", org.date_creation);
    addField(orgEl, "Référence entreprise", org.num_entreprise);
    addField(orgEl, "Type d’entreprise", org.type_entreprise);
    addField(orgEl, "IDCC", org.idcc);

    addField(orgEl, "Groupe", org.nom_groupe);
    addField(orgEl, "Type de groupe", org.type_groupe);
    addFieldBool(orgEl, "Tête de groupe", org.tete_groupe);
    addFieldBool(orgEl, "Groupe OK", org.group_ok);
    addFieldBool(orgEl, "Contrat Skills", org.contrat_skills);

    // ---- Contact
    addField(contactEl, "Civilité", c.civilite);
    addField(contactEl, "Prénom", c.prenom);
    addField(contactEl, "Nom", c.nom);
    addField(contactEl, "Email", c.email);
    addField(contactEl, "Téléphone", c.telephone);

    addField(contactEl, "Fonction", c.fonction);
    const adrC = composeAdresseContact(c);
    addField(contactEl, "Adresse", adrC);

    addField(contactEl, "Date de naissance", c.date_naissance);
    addField(contactEl, "Niveau d'éducation", c.niveau_education);
    addField(contactEl, "Domaine d'éducation", c.domaine_education);

    addField(contactEl, "Type de contrat", c.type_contrat);
    addField(contactEl, "Matricule interne", c.matricule_interne);
    addField(contactEl, "Déplacements", c.business_travel);
    addField(contactEl, "Date d’entrée", c.date_entree);
    addField(contactEl, "Sortie prévue", c.date_sortie_prevue);
    addFieldBool(contactEl, "Actif", c.statut_actif);

    addField(contactEl, "Motif de sortie", c.motif_sortie);
    addFieldBool(contactEl, "Manager", c.ismanager);
    addFieldBool(contactEl, "Formateur", c.isformateur);
    addFieldBool(contactEl, "Temporaire", c.is_temp);
    addField(contactEl, "Rôle temporaire", c.role_temp);
    addField(contactEl, "Code collaborateur", c.code_effectif);

    addField(contactEl, "Commentaire", c.note_commentaire);
  }

  render();
})();