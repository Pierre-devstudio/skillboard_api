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

    function buildClientSpaceUrl(idEnt){
        const ownerId = getOwnerId();
        if (!ownerId || !idEnt) return "";
        return `/studio_client_space.html?id=${encodeURIComponent(ownerId)}&client=${encodeURIComponent(idEnt)}`;
    }

    function openClientSpace(idEnt){
        const url = buildClientSpaceUrl(idEnt);
        if (!url) return;
        window.open(url, "_blank", "noopener");
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
        byId("clientsKpiOwner").textContent = String(summary?.nb_studio_actif || 0);
        byId("clientsKpiStudioDelegue").textContent = String(summary?.nb_studio_delegue || 0);
    }

  function getProfilStructInfo(value){
    const v = (value || "").toString().trim().toLowerCase();

    if (v === "site_unique") {
      return { label: "Site unique", cls: "sb-client-profile-dot--site-unique" };
    }
    if (v === "multi_site") {
      return { label: "Multi-site", cls: "sb-client-profile-dot--multi-site" };
    }
    if (v === "holding_multi_entreprise") {
      return { label: "Holding multi-entreprise", cls: "sb-client-profile-dot--holding" };
    }
    if (v === "holding_multi_entreprise_multi_site") {
      return { label: "Holding multi-entreprise + multi-site", cls: "sb-client-profile-dot--holding-multi-site" };
    }

    return { label: "Profil non renseigné", cls: "sb-client-profile-dot--unknown" };
  }

  function getStudioOwnerInfo(item){
    const hasOwnerScope = !!item?.has_owner_scope;
    const studioActif = !!item?.studio_actif;

    if (!hasOwnerScope) {
      return {
        text: "—",
        cls: "sb-client-studio-flag--off",
        title: "Pas d’owner Studio"
      };
    }

    if (studioActif) {
      return {
        text: "S",
        cls: "sb-client-studio-flag--on",
        title: "Owner Studio actif"
      };
    }

    return {
      text: "S",
      cls: "sb-client-studio-flag--idle",
      title: "Owner Studio déclaré"
    };
  }

  function getPdfIconSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"></path>
        <path d="M14 2v6h6"></path>
        <path d="M8.5 15.5h7"></path>
        <path d="M8.5 18.5h5"></path>
      </svg>
    `;
  }

  function getPencilIconSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
      </svg>
    `;
  }

  function getTrashIconSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M9 6V4h6v2"></path>
      </svg>
    `;
  }

  function renderList(){
    const body = byId("clientsTableBody");
    const empty = byId("clientsEmpty");
    const q = (byId("clientsSearch")?.value || "").trim().toLowerCase();

    if (!body || !empty) return;

    const rows = (_items || []).filter(it => {
      if (!q) return true;

      const hay = [
        it.nom_ent,
        it.cp_ent,
        it.ville_ent,
        it.nom_groupe,
        it.type_groupe,
        it.email_ent
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });

    if (!rows.length) {
      body.innerHTML = "";
      empty.classList.remove("is-hidden");
      return;
    }

    empty.classList.add("is-hidden");

    body.innerHTML = rows.map(it => {
      const profile = getProfilStructInfo(it.profil_structurel);
      const studio = getStudioOwnerInfo(it);
      const active = it.id_ent === _selectedId ? " is-active" : "";

      return `
        <tr class="sb-table-row-clickable sb-client-row${active}" data-id="${esc(it.id_ent)}">
          <td>
            <div class="sb-client-table-name">${esc(it.nom_ent || "Entreprise sans nom")}</div>
          </td>
          <td>${esc(it.cp_ent || "—")}</td>
          <td>${esc(it.ville_ent || "—")}</td>
          <td style="text-align:center;">
            <span
              class="sb-client-profile-dot ${profile.cls}"
              title="${esc(profile.label)}"
              aria-label="${esc(profile.label)}"
            ></span>
          </td>
          <td style="text-align:center;">
            <span
              class="sb-client-studio-flag ${studio.cls}"
              title="${esc(studio.title)}"
              aria-label="${esc(studio.title)}"
            >${esc(studio.text)}</span>
          </td>
          <td style="text-align:center;">
            <div class="sb-icon-actions sb-client-actions">
              <button
                type="button"
                class="sb-icon-btn sb-icon-btn--doc is-hidden"
                data-action="pdf"
                data-id="${esc(it.id_ent)}"
                title="PDF"
                aria-label="PDF"
              >
                ${getPdfIconSvg()}
              </button>

              <button
                type="button"
                class="sb-icon-btn"
                data-action="edit"
                data-id="${esc(it.id_ent)}"
                title="Ouvrir l’espace de gestion"
                aria-label="Ouvrir l’espace de gestion"
              >
                ${getPencilIconSvg()}
              </button>

              <button
                type="button"
                class="sb-icon-btn sb-icon-btn--danger"
                data-action="archive"
                data-id="${esc(it.id_ent)}"
                title="Archiver"
                aria-label="Archiver"
              >
                ${getTrashIconSvg()}
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function openClientWorkspace(idEnt){
    const id = (idEnt || "").toString().trim();
    if (!id) return;

    _selectedId = id;
    renderList();
    openClientSpace(id);
  }

  async function archiveClient(portal, idEnt){
    const id = (idEnt || "").toString().trim();
    if (!id) return;

    const item = (_items || []).find(x => x.id_ent === id);
    const nom = item?.nom_ent || "ce client";

    const ok = window.confirm(`Archiver le client "${nom}" ?`);
    if (!ok) return;

    const ownerId = getOwnerId();
    await portal.apiJson(`${portal.apiBase}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const nextId = (_items.find(x => x.id_ent !== id) || {}).id_ent || null;
    _selectedId = nextId || null;
    _selectedDetail = null;

    await loadList(portal, _selectedId);
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

    _selectedId = (preferredId && _items.some(x => x.id_ent === preferredId))
      ? preferredId
      : ((_selectedId && _items.some(x => x.id_ent === _selectedId)) ? _selectedId : null);

    _selectedDetail = null;
    renderList();

    _loaded = true;
    setStatus(`${_items.length} client(s)`);
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

    if (!canManage()) {
      if (btnCreate) btnCreate.style.display = "none";
    }

    byId("clientsSearch")?.addEventListener("input", renderList);

    byId("clientsTableBody")?.addEventListener("click", async (ev) => {
      const actionBtn = ev.target.closest("[data-action]");
      if (actionBtn) {
        ev.preventDefault();
        ev.stopPropagation();

        const id = (actionBtn.dataset.id || "").trim();
        if (!id) return;

        try {
          portal.showAlert("", "");

          if (actionBtn.dataset.action === "archive") {
            await archiveClient(portal, id);
            return;
          }

          if (actionBtn.dataset.action === "edit") {
            openClientWorkspace(id);
            return;
          }

          if (actionBtn.dataset.action === "pdf") {
            return;
          }
        } catch (e) {
          portal.showAlert("error", e.message || String(e));
        }
        return;
      }

      const row = ev.target.closest("tr[data-id]");
      if (!row) return;

      try {
        portal.showAlert("", "");
        openClientWorkspace(row.dataset.id);
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
      const body = byId("clientsTableBody");
      const empty = byId("clientsEmpty");
      if (body) body.innerHTML = "";
      if (empty) empty.classList.remove("is-hidden");
    }
  })();
})();