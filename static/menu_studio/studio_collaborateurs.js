(function () {
  let _bound = false;

  let _ctx = null;
  let _items = [];
  let _search = "";
  let _searchTimer = null;
  let _filterService = "__all__";
  let _filterPoste = "__all__";
  let _filterActive = "all";
  let _showArchived = false;

  let _modalMode = "create";
  let _editingId = null;

  function byId(id){ return document.getElementById(id); }

  function esc(s){
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function isEntrepriseMode(){
    return !!(_ctx && _ctx.source_kind === "entreprise");
  }

  function setStatus(msg){
    const el = byId("collabStatus");
    if (el) el.textContent = msg || "—";
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function fillSelect(el, items, valueKey, labelKey, firstValue, firstLabel){
    if (!el) return;
    let html = "";
    if (firstLabel !== undefined) {
      html += `<option value="${esc(firstValue || "")}">${esc(firstLabel || "")}</option>`;
    }
    (items || []).forEach(it => {
      html += `<option value="${esc(it?.[valueKey] || "")}">${esc(it?.[labelKey] || "")}</option>`;
    });
    el.innerHTML = html;
  }

  function renderTop(){
    const sub = byId("collabPageSub");
    const badge = byId("collabSourceBadge");

    if (sub) {
      const src = (_ctx?.source_label || "").trim();
      const name = (_ctx?.source_name || _ctx?.nom_owner || "").trim();
      sub.textContent = src && name ? `${src} · ${name}` : (name || src || "Gestion des collaborateurs.");
    }

    if (badge) {
      badge.textContent = isEntrepriseMode() ? "Client" : "Mon entreprise";
    }
  }

  function renderStats(stats){
    byId("kpiTotalVal").textContent = String(stats?.total || 0);
    byId("kpiActifsVal").textContent = String(stats?.actifs || 0);
    byId("kpiInactifsVal").textContent = String(stats?.inactifs || 0);
    byId("kpiArchivesVal").textContent = String(stats?.archives || 0);
  }

  function renderFilters(){
    const serviceWrap = byId("collabServiceField");
    const posteWrap = byId("collabPosteField");

    if (serviceWrap) serviceWrap.style.display = isEntrepriseMode() ? "" : "none";
    if (posteWrap) posteWrap.style.display = isEntrepriseMode() ? "" : "none";

    fillSelect(byId("collabFilterService"), _ctx?.services || [], "id_service", "label", "__all__", "Tous les services");
    fillSelect(byId("collabFilterPoste"), _ctx?.postes || [], "id_poste", "label", "__all__", "Tous les postes");

    if (byId("collabFilterService")) byId("collabFilterService").value = _filterService;
    if (byId("collabFilterPoste")) byId("collabFilterPoste").value = _filterPoste;
    if (byId("collabFilterActive")) byId("collabFilterActive").value = _filterActive;
    if (byId("collabShowArchived")) byId("collabShowArchived").checked = !!_showArchived;
  }

  function hydrateFormSelects(){
    fillSelect(byId("collabCivilite"), [
      { value: "M.", label: "M." },
      { value: "Mme", label: "Mme" },
      { value: "Autre", label: "Autre" }
    ], "value", "label", "", "—");

    fillSelect(byId("collabService"), _ctx?.services || [], "id_service", "label", "", "Aucun service");
    fillSelect(byId("collabPoste"), _ctx?.postes || [], "id_poste", "label", "", "Aucun poste");

    fillSelect(byId("collabTypeContrat"), [
      { value: "", label: "—" },
      { value: "CDI", label: "CDI" },
      { value: "CDD", label: "CDD" },
      { value: "Alternance", label: "Alternance" },
      { value: "Intérim", label: "Intérim" },
      { value: "Stage", label: "Stage" },
      { value: "Freelance", label: "Freelance" },
      { value: "Autre", label: "Autre" }
    ], "value", "label");
  }

  function toggleFormBySource(){
    const rhBloc = byId("collabRhBloc");
    const userBloc = byId("collabUserBloc");
    const hint = byId("collabModalSourceHint");

    if (rhBloc) rhBloc.style.display = isEntrepriseMode() ? "" : "none";
    if (userBloc) userBloc.style.display = isEntrepriseMode() ? "none" : "";
    if (hint) {
      hint.textContent = isEntrepriseMode()
        ? "Mode client : identité, contact et rattachement RH."
        : "Mode mon entreprise : identité et contact. Les champs RH n’existent pas dans tbl_utilisateur.";
    }
  }

  function refreshServiceFromPoste(){
    if (!isEntrepriseMode()) return;

    const selPoste = byId("collabPoste");
    const selService = byId("collabService");
    if (!selPoste || !selService) return;

    const idPoste = (selPoste.value || "").trim();
    if (!idPoste) {
      selService.disabled = false;
      return;
    }

    const p = (_ctx?.postes || []).find(x => (x?.id_poste || "") === idPoste);
    if (p) {
      selService.value = p.id_service || "";
      selService.disabled = true;
      return;
    }

    selService.disabled = false;
  }

  function renderList(){
    const host = byId("collabList");
    const empty = byId("collabEmpty");
    if (!host || !empty) return;

    if (!_items.length) {
      host.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";

    host.innerHTML = _items.map(it => {
      const fullName = `${it.civilite ? `${it.civilite} ` : ""}${it.prenom || ""} ${it.nom || ""}`.trim();
      const meta = [];

      if (it.email) meta.push(esc(it.email));
      if (it.telephone) meta.push(esc(it.telephone));

      if (isEntrepriseMode()) {
        if (it.nom_service) meta.push(`Service : ${esc(it.nom_service)}`);
        if (it.poste_label) meta.push(`Poste : ${esc(it.poste_label)}`);
        if (it.type_contrat) meta.push(esc(it.type_contrat));
        if (it.code_effectif) meta.push(`Code : ${esc(it.code_effectif)}`);
      } else {
        if (it.fonction) meta.push(`Fonction : ${esc(it.fonction)}`);
      }

      const badges = [];
      badges.push(`<span class="sb-badge sb-badge--outline-accent">${it.archive ? "Archivé" : (it.actif ? "Actif" : "Inactif")}</span>`);
      if (it.ismanager) badges.push(`<span class="sb-badge sb-badge--accent-soft">Manager</span>`);
      if (it.isformateur) badges.push(`<span class="sb-badge sb-badge--accent-soft">Formateur</span>`);
      if (it.is_temp) badges.push(`<span class="sb-badge sb-badge--accent-soft">Temporaire</span>`);
      if (!isEntrepriseMode() && it.fonction) badges.push(`<span class="sb-badge sb-badge--outline-accent">${esc(it.fonction)}</span>`);

      return `
        <div class="sb-row-card ${it.archive ? "is-archived" : ""}">
          <div class="sb-row-left">
            <div class="sb-row-main">
              <div class="sb-row-title">${esc(fullName || "Collaborateur sans nom")}</div>
              <div class="sb-row-badges">${badges.join("")}</div>
              <div class="sb-row-meta">
                ${meta.length ? meta.map(x => `<span>${x}</span>`).join("") : `<span>—</span>`}
              </div>
            </div>
          </div>
          <div class="sb-row-right">
            <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="edit" data-id="${esc(it.id_collaborateur)}">Modifier</button>
            ${it.archive ? "" : `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="archive" data-id="${esc(it.id_collaborateur)}">Archiver</button>`}
          </div>
        </div>
      `;
    }).join("");
  }

  async function loadContext(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    _ctx = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/context/${encodeURIComponent(ownerId)}`);
    renderTop();
    renderFilters();
    hydrateFormSelects();
    toggleFormBySource();
  }

  async function loadList(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const qs = new URLSearchParams();
    if (_search) qs.set("q", _search);
    qs.set("service", _filterService || "__all__");
    qs.set("poste", _filterPoste || "__all__");
    qs.set("active", _filterActive || "all");
    qs.set("include_archived", _showArchived ? "1" : "0");

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/list/${encodeURIComponent(ownerId)}?${qs.toString()}`);
    _items = Array.isArray(data?.items) ? data.items : [];
    renderStats(data?.stats || { total: 0, actifs: 0, inactifs: 0, archives: 0 });
    renderList();
  }

  function refreshTempRoleVisibility(){
    const wrap = byId("collabTempRoleField");
    const chk = byId("collabTemp");
    if (wrap) wrap.style.display = chk && chk.checked ? "" : "none";
  }

  function refreshSortieVisibility(){
    const wrapDate = byId("collabDateSortieField");
    const wrapMotif = byId("collabMotifSortieField");
    const chk = byId("collabHaveDateFin");
    const show = !!(chk && chk.checked);
    if (wrapDate) wrapDate.style.display = show ? "" : "none";
    if (wrapMotif) wrapMotif.style.display = show ? "" : "none";
  }

  function clearForm(){
    [
      "collabPrenom","collabNom","collabEmail","collabTel","collabTel2","collabAdresse",
      "collabCodePostal","collabVille","collabPays","collabFonction","collabObservations",
      "collabMatricule","collabCodeEffectif","collabBusinessTravel","collabNiveauEdu",
      "collabDomaineEdu","collabDateNaissance","collabDateEntree","collabDateDebutPoste",
      "collabDateSortie","collabMotifSortie","collabNote","collabTempRole"
    ].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });

    if (byId("collabCivilite")) byId("collabCivilite").value = "";
    if (byId("collabService")) byId("collabService").value = "";
    if (byId("collabPoste")) byId("collabPoste").value = "";
    if (byId("collabTypeContrat")) byId("collabTypeContrat").value = "";

    if (byId("collabActif")) byId("collabActif").checked = true;
    if (byId("collabManager")) byId("collabManager").checked = false;
    if (byId("collabFormateur")) byId("collabFormateur").checked = false;
    if (byId("collabTemp")) byId("collabTemp").checked = false;
    if (byId("collabHaveDateFin")) byId("collabHaveDateFin").checked = false;

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId("btnCollabArchive");
    if (btnArchive) btnArchive.style.display = "none";
  }

  function setModalHeader(title, sub){
    if (byId("collabModalTitle")) byId("collabModalTitle").textContent = title || "Collaborateur";
    if (byId("collabModalSub")) byId("collabModalSub").textContent = sub || "—";
  }

  function buildPayload(){
    const p = {
      civilite: byId("collabCivilite")?.value || null,
      prenom: byId("collabPrenom")?.value || null,
      nom: byId("collabNom")?.value || null,
      email: byId("collabEmail")?.value || null,
      telephone: byId("collabTel")?.value || null,
      telephone2: byId("collabTel2")?.value || null,
      adresse: byId("collabAdresse")?.value || null,
      code_postal: byId("collabCodePostal")?.value || null,
      ville: byId("collabVille")?.value || null,
      pays: byId("collabPays")?.value || null,
      actif: !!byId("collabActif")?.checked,
      fonction: byId("collabFonction")?.value || null,
      observations: byId("collabObservations")?.value || null,

      id_service: byId("collabService")?.value || null,
      id_poste_actuel: byId("collabPoste")?.value || null,
      type_contrat: byId("collabTypeContrat")?.value || null,
      matricule_interne: byId("collabMatricule")?.value || null,
      business_travel: byId("collabBusinessTravel")?.value || null,
      date_naissance: byId("collabDateNaissance")?.value || null,
      date_entree_entreprise: byId("collabDateEntree")?.value || null,
      date_debut_poste_actuel: byId("collabDateDebutPoste")?.value || null,
      date_sortie_prevue: byId("collabDateSortie")?.value || null,
      niveau_education: byId("collabNiveauEdu")?.value || null,
      domaine_education: byId("collabDomaineEdu")?.value || null,
      motif_sortie: byId("collabMotifSortie")?.value || null,
      note_commentaire: byId("collabNote")?.value || null,
      havedatefin: !!byId("collabHaveDateFin")?.checked,
      ismanager: !!byId("collabManager")?.checked,
      isformateur: !!byId("collabFormateur")?.checked,
      is_temp: !!byId("collabTemp")?.checked,
      role_temp: byId("collabTempRole")?.value || null,
      code_effectif: byId("collabCodeEffectif")?.value || null
    };

    if (!isEntrepriseMode()) {
      p.id_service = null;
      p.id_poste_actuel = null;
      p.type_contrat = null;
      p.matricule_interne = null;
      p.business_travel = null;
      p.date_naissance = null;
      p.date_entree_entreprise = null;
      p.date_debut_poste_actuel = null;
      p.date_sortie_prevue = null;
      p.niveau_education = null;
      p.domaine_education = null;
      p.motif_sortie = null;
      p.note_commentaire = null;
      p.havedatefin = false;
      p.ismanager = false;
      p.isformateur = false;
      p.is_temp = false;
      p.role_temp = null;
      p.code_effectif = null;
    }

    return p;
  }

  async function openCreateModal(){
    _modalMode = "create";
    _editingId = null;
    clearForm();
    toggleFormBySource();
    setModalHeader("Nouveau collaborateur", _ctx?.source_label || "Collaborateur");
    openModal("modalCollaborateur");
  }

  async function openEditModal(portal, id){
    const ownerId = getOwnerId();
    if (!ownerId || !id) return;

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`);

    _modalMode = "edit";
    _editingId = id;

    clearForm();
    toggleFormBySource();

    if (byId("collabCivilite")) byId("collabCivilite").value = data?.civilite || "";
    if (byId("collabPrenom")) byId("collabPrenom").value = data?.prenom || "";
    if (byId("collabNom")) byId("collabNom").value = data?.nom || "";
    if (byId("collabEmail")) byId("collabEmail").value = data?.email || "";
    if (byId("collabTel")) byId("collabTel").value = data?.telephone || "";
    if (byId("collabTel2")) byId("collabTel2").value = data?.telephone2 || "";
    if (byId("collabAdresse")) byId("collabAdresse").value = data?.adresse || "";
    if (byId("collabCodePostal")) byId("collabCodePostal").value = data?.code_postal || "";
    if (byId("collabVille")) byId("collabVille").value = data?.ville || "";
    if (byId("collabPays")) byId("collabPays").value = data?.pays || "";
    if (byId("collabActif")) byId("collabActif").checked = !!data?.actif;
    if (byId("collabFonction")) byId("collabFonction").value = data?.fonction || "";
    if (byId("collabObservations")) byId("collabObservations").value = data?.observations || "";

    if (isEntrepriseMode()) {
      if (byId("collabService")) byId("collabService").value = data?.id_service || "";
      if (byId("collabPoste")) byId("collabPoste").value = data?.id_poste_actuel || "";
      if (byId("collabTypeContrat")) byId("collabTypeContrat").value = data?.type_contrat || "";
      if (byId("collabMatricule")) byId("collabMatricule").value = data?.matricule_interne || "";
      if (byId("collabCodeEffectif")) byId("collabCodeEffectif").value = data?.code_effectif || "";
      if (byId("collabBusinessTravel")) byId("collabBusinessTravel").value = data?.business_travel || "";
      if (byId("collabNiveauEdu")) byId("collabNiveauEdu").value = data?.niveau_education || "";
      if (byId("collabDomaineEdu")) byId("collabDomaineEdu").value = data?.domaine_education || "";
      if (byId("collabDateNaissance")) byId("collabDateNaissance").value = data?.date_naissance || "";
      if (byId("collabDateEntree")) byId("collabDateEntree").value = data?.date_entree_entreprise || "";
      if (byId("collabDateDebutPoste")) byId("collabDateDebutPoste").value = data?.date_debut_poste_actuel || "";
      if (byId("collabDateSortie")) byId("collabDateSortie").value = data?.date_sortie_prevue || "";
      if (byId("collabMotifSortie")) byId("collabMotifSortie").value = data?.motif_sortie || "";
      if (byId("collabNote")) byId("collabNote").value = data?.note_commentaire || "";
      if (byId("collabHaveDateFin")) byId("collabHaveDateFin").checked = !!data?.havedatefin || !!data?.date_sortie_prevue;
      if (byId("collabManager")) byId("collabManager").checked = !!data?.ismanager;
      if (byId("collabFormateur")) byId("collabFormateur").checked = !!data?.isformateur;
      if (byId("collabTemp")) byId("collabTemp").checked = !!data?.is_temp;
      if (byId("collabTempRole")) byId("collabTempRole").value = data?.role_temp || "";
    }

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId("btnCollabArchive");
    if (btnArchive) btnArchive.style.display = data?.archive ? "none" : "";

    const fullName = `${data?.prenom || ""} ${data?.nom || ""}`.trim();
    setModalHeader(fullName || "Collaborateur", data?.archive ? "Archivé" : (data?.actif ? "Actif" : "Inactif"));
    openModal("modalCollaborateur");
  }

  async function saveModal(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const payload = buildPayload();
    const url = _modalMode === "edit" && _editingId
      ? `${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`
      : `${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}`;

    await portal.apiJson(url, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    closeModal("modalCollaborateur");
    portal.showAlert("success", _modalMode === "edit" ? "Collaborateur mis à jour." : "Collaborateur ajouté.");
    await loadList(portal);
  }

  async function archiveCollaborateur(portal, id){
    const ownerId = getOwnerId();
    if (!ownerId || !id) return;
    if (!window.confirm("Archiver ce collaborateur ?")) return;

    await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}/archive`, {
      method: "POST"
    });

    if (_editingId === id) closeModal("modalCollaborateur");
    portal.showAlert("success", "Collaborateur archivé.");
    await loadList(portal);
  }

  function bindListActions(portal){
    byId("collabList")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;

      const act = btn.getAttribute("data-act") || "";
      const id = btn.getAttribute("data-id") || "";

      try {
        if (act === "edit") await openEditModal(portal, id);
        if (act === "archive") await archiveCollaborateur(portal, id);
      } catch (err) {
        portal.showAlert("error", err?.message || String(err));
      }
    });
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    bindListActions(portal);

    byId("btnCollabAdd")?.addEventListener("click", () => {
      openCreateModal().catch(e => portal.showAlert("error", e?.message || String(e)));
    });

    byId("collabSearch")?.addEventListener("input", (e) => {
      _search = (e.target.value || "").trim();
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        loadList(portal).catch(err => portal.showAlert("error", err?.message || String(err)));
      }, 250);
    });

    byId("collabFilterService")?.addEventListener("change", (e) => {
      _filterService = (e.target.value || "__all__").trim();
      loadList(portal).catch(err => portal.showAlert("error", err?.message || String(err)));
    });

    byId("collabFilterPoste")?.addEventListener("change", (e) => {
      _filterPoste = (e.target.value || "__all__").trim();
      loadList(portal).catch(err => portal.showAlert("error", err?.message || String(err)));
    });

    byId("collabFilterActive")?.addEventListener("change", (e) => {
      _filterActive = (e.target.value || "all").trim();
      loadList(portal).catch(err => portal.showAlert("error", err?.message || String(err)));
    });

    byId("collabShowArchived")?.addEventListener("change", (e) => {
      _showArchived = !!e.target.checked;
      loadList(portal).catch(err => portal.showAlert("error", err?.message || String(err)));
    });

    byId("btnCloseCollaborateur")?.addEventListener("click", () => closeModal("modalCollaborateur"));
    byId("btnCollabCancel")?.addEventListener("click", () => closeModal("modalCollaborateur"));

    byId("btnCollabSave")?.addEventListener("click", async () => {
      try { await saveModal(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnCollabArchive")?.addEventListener("click", async () => {
      try {
        if (_editingId) await archiveCollaborateur(portal, _editingId);
      } catch (e) {
        portal.showAlert("error", e?.message || String(e));
      }
    });

    byId("collabPoste")?.addEventListener("change", refreshServiceFromPoste);
    byId("collabTemp")?.addEventListener("change", refreshTempRoleVisibility);
    byId("collabHaveDateFin")?.addEventListener("change", refreshSortieVisibility);
  }

  async function init(){
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    const portal = window.portal;
    if (!portal) return;

    bindOnce(portal);
    setStatus("Chargement…");
    await loadContext(portal);
    await loadList(portal);
    setStatus("—");
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert("error", "Erreur collaborateurs : " + (e?.message || e));
    }
    setStatus("Erreur de chargement.");
  });
})();