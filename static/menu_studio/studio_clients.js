(function () {
  let _bound = false;
  let _loaded = false;
  let _items = [];
  let _selectedId = null;
  let _selectedDetail = null;
  let _refOpco = null;
  let _modalMode = "create";
  let _modalClientId = null;
  let _ownerFeatures = { studio_actif: false, gestion_acces_studio_autorisee: false, nb_acces_studio_max: 0 };

  function byId(id){ return document.getElementById(id); }

  function roleRank(code){
    const c = (code || "user").toString().trim().toLowerCase();
    if (c === "admin") return 3;
    if (c === "editor") return 2;
    return 1;
  }

  function canManage(){
    return roleRank(window.__studioRoleCode || "user") >= 2;
  }

  function esc(v){
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeValue(v){
    const s = (v ?? "").toString().trim();
    return s.length ? s : null;
  }

  function boolText(v){
    return v ? "Oui" : "Non";
  }

  function setStatus(msg){
    const el = byId("clientsStatus");
    if (!el) return;
    el.textContent = msg || "—";
  }

  function setValueOrEmpty(id, value){
    const el = byId(id);
    if (!el) return;
    el.value = value ?? "";
  }

  function getOwnerId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function formatDateFr(value){
    const v = (value || "").toString().trim();
    if (!v) return "";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return v;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function formatPhoneInput(input){
    if (!input) return;
    let digits = (input.value || "").replace(/\D/g, "");
    if (digits.startsWith("33") && digits.length >= 11) digits = "0" + digits.slice(2);
    digits = digits.slice(0, 10);
    const parts = [];
    for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
    input.value = parts.join(" ");
  }

  function formatApeInput(raw){
    const digits = (raw || "").replace(/[^\d]/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return digits.slice(0, 2) + "." + digits.slice(2);
  }

  function syncGroupFields(){
    const enabled = !!byId("frm_group_ok")?.checked;
    const nom = byId("frm_nom_groupe");
    const type = byId("frm_type_groupe");
    const tete = byId("frm_tete_groupe");
    const wrapNom = byId("frmGroupNomWrap");
    const wrapType = byId("frmGroupTypeWrap");

    if (nom) nom.disabled = !enabled;
    if (type) type.disabled = !enabled;
    if (tete) {
      tete.disabled = !enabled;
      if (!enabled) tete.checked = false;
    }
    if (wrapNom) wrapNom.style.opacity = enabled ? "1" : ".6";
    if (wrapType) wrapType.style.opacity = enabled ? "1" : ".6";

    if (!enabled) {
      if (nom) nom.value = "";
      if (type) type.value = "";
    }
  }

  async function loadRefOpco(portal){
    if (_refOpco) return _refOpco;
    _refOpco = await portal.apiJson(`${portal.apiBase}/studio/referentiels/opco`);
    return _refOpco;
  }

  function renderOpcoSelect(list, selectedId){
    const sel = byId("frm_id_opco");
    if (!sel) return;
    sel.innerHTML = `<option value="">(Non renseigné)</option>`;
    (list || []).forEach(it => {
      const opt = document.createElement("option");
      opt.value = it.id_opco;
      opt.textContent = it.nom_opco;
      sel.appendChild(opt);
    });
    sel.value = selectedId || "";
    setOpcoHintFromCurrent();
  }

  function setOpcoHintFromCurrent(){
    const sel = byId("frm_id_opco");
    const hint = byId("frm_opco_hint");
    if (!sel || !hint) return;
    const id = sel.value || "";
    if (!id) {
      hint.textContent = "—";
      return;
    }
    const item = (_refOpco || []).find(x => x.id_opco === id);
    hint.textContent = item ? (item.nom_opco || "—") : "—";
  }

  async function lookupIdcc(portal, idcc){
    const hint = byId("frm_idcc_hint");
    const v = (idcc || "").trim();
    if (!hint) return;
    if (!v) {
      hint.textContent = "—";
      return;
    }
    try {
      const r = await portal.apiJson(`${portal.apiBase}/studio/referentiels/idcc/${encodeURIComponent(v)}`);
      hint.textContent = r.libelle || "—";
    } catch (_) {
      hint.textContent = "IDCC introuvable";
    }
  }

  async function lookupApe(portal, codeApe){
    const hint = byId("frm_ape_hint");
    const v = (codeApe || "").trim();
    if (!hint) return;
    if (!v) {
      hint.textContent = "—";
      return;
    }
    try {
      const r = await portal.apiJson(`${portal.apiBase}/studio/referentiels/ape/${encodeURIComponent(v)}`);
      hint.textContent = r.intitule_ape || "—";
    } catch (_) {
      hint.textContent = "Code APE invalide ou introuvable";
    }
  }

  function renderOwnerCapability(){
    const el = byId("clientsOwnerCapability");
    if (!el) return;
    if (_ownerFeatures.gestion_acces_studio_autorisee) {
      el.textContent = `Votre owner peut déléguer des accès Studio. Quota déclaré : ${_ownerFeatures.nb_acces_studio_max || 0}.`;
      return;
    }
    if (_ownerFeatures.studio_actif) {
      el.textContent = "Votre owner utilise Studio, mais la gestion déléguée des accès Studio n’est pas autorisée sur ce périmètre.";
      return;
    }
    el.textContent = "Studio n’est pas déclaré comme actif côté capacité owner. La fiche client reste gérable, ce qui est déjà pas mal.";
  }

  function renderKpis(summary){
    byId("clientsKpiTotal").textContent = String(summary?.total_clients || 0);
    byId("clientsKpiGroup").textContent = String(summary?.nb_groupes || 0);
    byId("clientsKpiOwner").textContent = String(summary?.nb_owner_scope || 0);
    byId("clientsKpiStudioDelegue").textContent = String(summary?.nb_studio_delegue || 0);
  }

  function buildListBadges(item){
    const out = [];
    out.push(`<span class="sb-badge sb-badge--accent-soft">Client</span>`);
    if (item.group_ok) out.push(`<span class="sb-badge sb-badge--outline-accent">${esc(item.type_groupe || "Groupe")}</span>`);
    if (item.tete_groupe) out.push(`<span class="sb-badge sb-badge--status-active">Tête de groupe</span>`);
    if (item.has_owner_scope) out.push(`<span class="sb-badge sb-badge--outline-accent">Owner Studio</span>`);
    if (item.gestion_acces_studio_autorisee) out.push(`<span class="sb-badge sb-badge--status-active">Délégation Studio</span>`);
    else if (item.studio_actif) out.push(`<span class="sb-badge sb-badge--status-inactive">Studio actif</span>`);
    return out.join("");
  }

  function renderList(){
    const box = byId("clientsList");
    const q = (byId("clientsSearch")?.value || "").trim().toLowerCase();
    if (!box) return;

    const rows = (_items || []).filter(it => {
      if (!q) return true;
      const hay = [it.nom_ent, it.ville_ent, it.pays_ent, it.nom_groupe, it.type_groupe, it.email_ent]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    if (!rows.length) {
      box.innerHTML = `
        <div class="sb-empty-state">
          <div class="sb-empty-state__title">Aucun client trouvé</div>
          <div class="sb-empty-state__text">Ajuste la recherche ou crée une fiche client. Il faut bien commencer quelque part.</div>
        </div>
      `;
      return;
    }

    box.innerHTML = rows.map(it => `
      <div class="sb-list-item sb-list-item--clickable ${it.id_ent === _selectedId ? "is-active" : ""}" data-id="${esc(it.id_ent)}">
        <div class="sb-row-main">
          <div class="sb-list-title">${esc(it.nom_ent || "Entreprise sans nom")}</div>
          <div class="sb-row-badges">${buildListBadges(it)}</div>
          <div class="sb-row-meta">
            <span>${esc(it.ville_ent || "Ville non renseignée")}</span>
            ${it.pays_ent ? `<span>${esc(it.pays_ent)}</span>` : ""}
            ${it.nom_groupe ? `<span>${esc(it.nom_groupe)}</span>` : ""}
          </div>
        </div>
      </div>
    `).join("");
  }

  function hideDetail(){
    const empty = byId("clientDetailEmpty");
    const panel = byId("clientDetailPanel");
    const actions = byId("clientDetailActions");
    if (empty) empty.style.display = "block";
    if (panel) panel.style.display = "none";
    if (actions) actions.style.display = "none";
    byId("clientDetailTitle").textContent = "Détail client";
    byId("clientDetailSub").textContent = "Sélectionnez une entreprise cliente pour afficher sa fiche.";
  }

  function renderDetail(detail){
    const empty = byId("clientDetailEmpty");
    const panel = byId("clientDetailPanel");
    const actions = byId("clientDetailActions");
    if (empty) empty.style.display = "none";
    if (panel) panel.style.display = "block";
    if (actions) actions.style.display = canManage() ? "flex" : "none";

    byId("clientDetailTitle").textContent = detail.nom_ent || "Détail client";
    byId("clientDetailSub").textContent = detail.id_ent || "";

    const badges = [];
    badges.push(`<span class="sb-badge sb-badge--accent-soft">Client</span>`);
    if (detail.group_ok) badges.push(`<span class="sb-badge sb-badge--outline-accent">${esc(detail.type_groupe || "Groupe")}</span>`);
    if (detail.tete_groupe) badges.push(`<span class="sb-badge sb-badge--status-active">Tête de groupe</span>`);
    if (detail.has_owner_scope) badges.push(`<span class="sb-badge sb-badge--outline-accent">Owner Studio créé</span>`);
    else badges.push(`<span class="sb-badge sb-badge--status-inactive">Pas d’owner Studio</span>`);
    if (detail.gestion_acces_studio_autorisee) badges.push(`<span class="sb-badge sb-badge--status-active">Gestion accès Studio autorisée</span>`);
    else if (detail.studio_actif) badges.push(`<span class="sb-badge sb-badge--status-inactive">Studio actif sans délégation</span>`);
    byId("clientDetailBadges").innerHTML = badges.join("");

    setValueOrEmpty("det_nom_ent", detail.nom_ent);
    setValueOrEmpty("det_siret_ent", detail.siret_ent);
    setValueOrEmpty("det_num_entreprise", detail.num_entreprise);
    setValueOrEmpty("det_date_creation", formatDateFr(detail.date_creation));
    setValueOrEmpty("det_effectif_ent", detail.effectif_ent);
    setValueOrEmpty("det_idcc", detail.idcc);
    setValueOrEmpty("det_code_ape_ent", detail.code_ape_ent);
    setValueOrEmpty("det_adresse_ent", detail.adresse_ent);
    setValueOrEmpty("det_adresse_cplt_ent", detail.adresse_cplt_ent);
    setValueOrEmpty("det_cp_ent", detail.cp_ent);
    setValueOrEmpty("det_ville_ent", detail.ville_ent);
    setValueOrEmpty("det_pays_ent", detail.pays_ent);
    setValueOrEmpty("det_telephone_ent", detail.telephone_ent);
    setValueOrEmpty("det_email_ent", detail.email_ent);
    setValueOrEmpty("det_site_web", detail.site_web);
    setValueOrEmpty("det_num_tva_ent", detail.num_tva_ent);
    setValueOrEmpty("det_idcc_libelle", detail.idcc_libelle);
    setValueOrEmpty("det_code_ape_intitule", detail.code_ape_intitule);
    setValueOrEmpty("det_opco_nom", detail.opco_nom);
    setValueOrEmpty("det_nom_groupe", detail.nom_groupe);
    setValueOrEmpty("det_type_groupe", detail.type_groupe);
    setValueOrEmpty("det_group_ok", boolText(detail.group_ok));
    setValueOrEmpty("det_tete_groupe", boolText(detail.tete_groupe));
    setValueOrEmpty("det_nb_entites_parents", detail.nb_entites_parents);
    setValueOrEmpty("det_nb_entites_enfants", detail.nb_entites_enfants);
    setValueOrEmpty("det_has_owner_scope", boolText(detail.has_owner_scope));
    setValueOrEmpty("det_studio_actif", boolText(detail.studio_actif));
    setValueOrEmpty("det_gestion_acces_studio_autorisee", boolText(detail.gestion_acces_studio_autorisee));
    setValueOrEmpty("det_nb_acces_studio_max", detail.nb_acces_studio_max);
  }

  async function loadList(portal, preferredId){
    setStatus("Chargement…");
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    const data = await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}`);
    _items = Array.isArray(data.items) ? data.items : [];
    _ownerFeatures = data.owner_features || _ownerFeatures;

    renderOwnerCapability();
    renderKpis(data.summary || {});
    renderList();

    const targetId = preferredId || _selectedId || (_items[0] && _items[0].id_ent) || null;
    if (targetId && _items.some(x => x.id_ent === targetId)) {
      await selectClient(portal, targetId, false);
    } else {
      _selectedId = null;
      _selectedDetail = null;
      hideDetail();
    }

    _loaded = true;
    setStatus(`${_items.length} client(s)`);
  }

  async function selectClient(portal, idEnt, rerenderList){
    const ownerId = getOwnerId();
    if (!ownerId || !idEnt) return;
    _selectedId = idEnt;
    if (rerenderList !== false) renderList();
    _selectedDetail = await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(idEnt)}`);
    renderDetail(_selectedDetail);
  }

  function clearModalHints(){
    byId("frm_idcc_hint").textContent = "—";
    byId("frm_ape_hint").textContent = "—";
    byId("frm_opco_hint").textContent = "—";
  }

  async function openModal(portal, mode, detail){
    _modalMode = mode || "create";
    _modalClientId = detail?.id_ent || null;

    byId("clientModalTitle").textContent = _modalMode === "create" ? "Ajouter un client" : "Modifier le client";
    byId("clientModalSub").textContent = _modalMode === "create"
      ? "Création d’une fiche entreprise cliente rattachée à l’owner courant."
      : "Mise à jour de la fiche entreprise cliente.";

    setValueOrEmpty("frm_nom_ent", detail?.nom_ent);
    setValueOrEmpty("frm_siret_ent", detail?.siret_ent);
    setValueOrEmpty("frm_num_entreprise", detail?.num_entreprise);
    setValueOrEmpty("frm_date_creation", detail?.date_creation);
    setValueOrEmpty("frm_effectif_ent", detail?.effectif_ent);
    setValueOrEmpty("frm_idcc", detail?.idcc);
    setValueOrEmpty("frm_code_ape_ent", detail?.code_ape_ent);
    setValueOrEmpty("frm_adresse_ent", detail?.adresse_ent);
    setValueOrEmpty("frm_adresse_cplt_ent", detail?.adresse_cplt_ent);
    setValueOrEmpty("frm_cp_ent", detail?.cp_ent);
    setValueOrEmpty("frm_ville_ent", detail?.ville_ent);
    setValueOrEmpty("frm_pays_ent", detail?.pays_ent);
    setValueOrEmpty("frm_telephone_ent", detail?.telephone_ent);
    setValueOrEmpty("frm_email_ent", detail?.email_ent);
    setValueOrEmpty("frm_site_web", detail?.site_web);
    setValueOrEmpty("frm_num_tva_ent", detail?.num_tva_ent);
    setValueOrEmpty("frm_nom_groupe", detail?.nom_groupe);
    setValueOrEmpty("frm_type_groupe", detail?.type_groupe);

    const groupOk = !!detail?.group_ok;
    const teteGroupe = !!detail?.tete_groupe;
    if (byId("frm_group_ok")) byId("frm_group_ok").checked = groupOk;
    if (byId("frm_tete_groupe")) byId("frm_tete_groupe").checked = groupOk && teteGroupe;

    const opco = await loadRefOpco(portal);
    renderOpcoSelect(opco, detail?.id_opco || "");

    syncGroupFields();
    clearModalHints();
    if (detail?.idcc) byId("frm_idcc_hint").textContent = detail.idcc_libelle || "—";
    if (detail?.code_ape_ent) byId("frm_ape_hint").textContent = detail.code_ape_intitule || "—";
    if (detail?.opco_nom) byId("frm_opco_hint").textContent = detail.opco_nom || "—";

    byId("clientModal").style.display = "flex";
  }

  function closeModal(){
    byId("clientModal").style.display = "none";
  }

  function collectFormPayload(){
    return {
      nom_ent: normalizeValue(byId("frm_nom_ent")?.value),
      siret_ent: normalizeValue(byId("frm_siret_ent")?.value),
      num_entreprise: normalizeValue(byId("frm_num_entreprise")?.value),
      date_creation: normalizeValue(byId("frm_date_creation")?.value),
      effectif_ent: normalizeValue(byId("frm_effectif_ent")?.value),
      idcc: normalizeValue(byId("frm_idcc")?.value),
      code_ape_ent: normalizeValue(byId("frm_code_ape_ent")?.value),
      adresse_ent: normalizeValue(byId("frm_adresse_ent")?.value),
      adresse_cplt_ent: normalizeValue(byId("frm_adresse_cplt_ent")?.value),
      cp_ent: normalizeValue(byId("frm_cp_ent")?.value),
      ville_ent: normalizeValue(byId("frm_ville_ent")?.value),
      pays_ent: normalizeValue(byId("frm_pays_ent")?.value),
      telephone_ent: normalizeValue(byId("frm_telephone_ent")?.value),
      email_ent: normalizeValue(byId("frm_email_ent")?.value),
      site_web: normalizeValue(byId("frm_site_web")?.value),
      num_tva_ent: normalizeValue(byId("frm_num_tva_ent")?.value),
      id_opco: normalizeValue(byId("frm_id_opco")?.value),
      group_ok: !!byId("frm_group_ok")?.checked,
      tete_groupe: !!byId("frm_tete_groupe")?.checked,
      nom_groupe: normalizeValue(byId("frm_nom_groupe")?.value),
      type_groupe: normalizeValue(byId("frm_type_groupe")?.value),
    };
  }

  async function saveModal(portal){
    const ownerId = getOwnerId();
    const payload = collectFormPayload();
    if (!payload.nom_ent) {
      portal.showAlert("error", "Le nom de l’entreprise est obligatoire.");
      return;
    }

    const btn = byId("btnClientModalSave");
    if (btn) btn.disabled = true;

    try {
      let detail;
      if (_modalMode === "create") {
        detail = await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        detail = await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(_modalClientId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      closeModal();
      portal.showAlert("", "");
      await loadList(portal, detail?.id_ent || _modalClientId);
    } catch (e) {
      portal.showAlert("error", e.message || String(e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function archiveSelected(portal){
    if (!_selectedId || !_selectedDetail) return;
    const ownerId = getOwnerId();
    const ok = window.confirm(`Archiver le client "${_selectedDetail.nom_ent || ""}" ?`);
    if (!ok) return;

    await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(_selectedId)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const nextId = (_items.find(x => x.id_ent !== _selectedId) || {}).id_ent || null;
    _selectedId = null;
    _selectedDetail = null;
    await loadList(portal, nextId);
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    const btnCreate = byId("btnClientCreate");
    const btnEdit = byId("btnClientEdit");
    const btnArchive = byId("btnClientArchive");

    if (!canManage()) {
      if (btnCreate) btnCreate.style.display = "none";
      if (btnEdit) btnEdit.style.display = "none";
      if (btnArchive) btnArchive.style.display = "none";
    }

    byId("clientsSearch")?.addEventListener("input", renderList);

    byId("clientsList")?.addEventListener("click", async (ev) => {
      const row = ev.target.closest("[data-id]");
      if (!row) return;
      try {
        portal.showAlert("", "");
        await selectClient(portal, row.dataset.id, true);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
    });

    btnCreate?.addEventListener("click", async () => {
      try {
        portal.showAlert("", "");
        await openModal(portal, "create", null);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
    });

    btnEdit?.addEventListener("click", async () => {
      if (!_selectedDetail) return;
      try {
        portal.showAlert("", "");
        await openModal(portal, "edit", _selectedDetail);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
    });

    btnArchive?.addEventListener("click", async () => {
      try {
        portal.showAlert("", "");
        await archiveSelected(portal);
      } catch (e) {
        portal.showAlert("error", e.message || String(e));
      }
    });

    byId("btnClientModalClose")?.addEventListener("click", closeModal);
    byId("btnClientModalCancel")?.addEventListener("click", closeModal);
    byId("btnClientModalSave")?.addEventListener("click", async () => { await saveModal(portal); });

    byId("frm_group_ok")?.addEventListener("change", syncGroupFields);
    byId("frm_tete_groupe")?.addEventListener("change", syncGroupFields);
    byId("frm_id_opco")?.addEventListener("change", setOpcoHintFromCurrent);

    const apeInput = byId("frm_code_ape_ent");
    if (apeInput) {
      apeInput.addEventListener("input", () => { apeInput.value = formatApeInput(apeInput.value); });
      apeInput.addEventListener("blur", async () => await lookupApe(portal, apeInput.value));
    }

    const idccInput = byId("frm_idcc");
    if (idccInput) {
      idccInput.addEventListener("blur", async () => await lookupIdcc(portal, idccInput.value));
    }

    const tel = byId("frm_telephone_ent");
    if (tel) {
      tel.addEventListener("input", () => formatPhoneInput(tel));
      tel.addEventListener("blur", () => formatPhoneInput(tel));
    }
  }

  (async () => {
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}

    const portal = window.portal;
    if (!portal) return;

    try {
      bindOnce(portal);
      if (!_loaded) await loadList(portal, null);
    } catch (e) {
      if (portal.showAlert) portal.showAlert("error", "Erreur de chargement : " + (e.message || e));
      setStatus("Erreur de chargement.");
      hideDetail();
    }
  })();
})();