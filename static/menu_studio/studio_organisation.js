(function () {
  let _bound = false;
  let _loaded = false;

  let _services = [];
  let _totaux = { nb_postes: 0, nb_collabs: 0 };
  let _nonLie = { nb_postes: 0, nb_collabs: 0 };

  let _selectedService = "__all__"; // "__all__", "__none__", ou id_service
  let _selectedServiceName = "Tous les services";

  let _posteSearch = "";
  let _posteSearchTimer = null;

  let _catalogSearch = "";
  let _catalogTimer = null;

  let _serviceModalMode = "create"; // create | edit
  let _editingServiceId = null;

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function isAdmin(){
    return (window.__studioRoleCode || "user").toString().trim().toLowerCase() === "admin";
  }

  function byId(id){ return document.getElementById(id); }

  function setStatus(msg){
    const el = byId("orgStatus");
    if (el) el.textContent = msg || "—";
  }

  function esc(s){
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }
  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function serviceMeta(nbPostes, nbCollabs){
    return `${nbPostes} poste(s) · ${nbCollabs} collaborateur(s)`;
  }

  function renderServices(){
    const host = byId("svcList");
    if (!host) return;
    host.innerHTML = "";

    // Pseudo: Tous les services
    host.appendChild(buildSvcRow("__all__", "Tous les services", 0, _totaux.nb_postes, _totaux.nb_collabs));

    // Services réels
    (_services || []).forEach(s => {
      host.appendChild(buildSvcRow(s.id_service, s.nom_service, s.depth, s.nb_postes, s.nb_collabs));
    });

    // Pseudo: Non lié
    host.appendChild(buildSvcRow("__none__", "Non lié", 0, _nonLie.nb_postes, _nonLie.nb_collabs));

    applySvcActive();
  }

  function buildSvcRow(id, name, depth, nbPostes, nbCollabs){
    const row = document.createElement("div");
    row.className = "sb-list-item sb-list-item--clickable";
    row.dataset.sid = id;

    const left = document.createElement("div");
    left.className = "sb-list-title";
    left.style.paddingLeft = `${Math.min(6, Math.max(0, depth)) * 14}px`;
    left.textContent = name;

    const right = document.createElement("div");
    right.className = "sb-list-meta";
    right.textContent = `${nbPostes} · ${nbCollabs}`;

    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener("click", () => selectService(id, name, nbPostes, nbCollabs));
    return row;
  }

  function applySvcActive(){
    document.querySelectorAll(".sb-list-item[data-sid]").forEach(el => {
      const sid = el.dataset.sid;
      el.classList.toggle("is-active", sid === _selectedService);
    });
  }

  function selectService(id, name, nbPostes, nbCollabs){
    _selectedService = id;
    _selectedServiceName = name;

    const t = byId("svcTitle");
    const m = byId("svcMeta");
    if (t) t.textContent = name || "Service";
    if (m) m.textContent = serviceMeta(nbPostes || 0, nbCollabs || 0);

    applySvcActive();
    updateAddButtonState();
    loadPostes(window.portal).catch(() => {});
  }

  function updateAddButtonState(){
    const btn = byId("btnAddFromCatalog");
    if (!btn) return;

    const ok = isAdmin() && _selectedService && _selectedService !== "__all__" && _selectedService !== "__none__";
    btn.disabled = !ok;
    btn.style.opacity = ok ? "" : ".6";
    btn.title = ok ? "" : "Sélectionnez un service (hors 'Tous' / 'Non lié').";
  }

  async function loadServices(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    const data = await portal.apiJson(`${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`);
    _totaux = data.totaux || { nb_postes: 0, nb_collabs: 0 };
    _nonLie = data.non_lie || { nb_postes: 0, nb_collabs: 0 };
    _services = data.services || [];

    renderServices();

    // sélection initiale
    if (!_loaded) {
      const t = byId("svcTitle");
      const m = byId("svcMeta");
      if (t) t.textContent = "Tous les services";
      if (m) m.textContent = serviceMeta(_totaux.nb_postes, _totaux.nb_collabs);
      _selectedService = "__all__";
      _selectedServiceName = "Tous les services";
      updateAddButtonState();
    }
  }

  async function loadPostes(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}?service=${encodeURIComponent(_selectedService)}&q=${encodeURIComponent(_posteSearch)}`;
    const data = await portal.apiJson(url);

    const host = byId("posteList");
    if (!host) return;
    host.innerHTML = "";

    const postes = data.postes || [];
    if (!postes.length) {
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucun poste à afficher.";
      host.appendChild(empty);
      return;
    }

    postes.forEach(p => {
      const row = document.createElement("div");
      row.className = "sb-row-card";

      const left = document.createElement("div");
      left.className = "sb-row-left";

      const code = document.createElement("span");
      code.className = "sb-badge sb-badge--accent-soft";
      code.textContent = p.code || "—";

      const title = document.createElement("div");
      title.className = "sb-row-title";
      title.textContent = p.intitule || "";

      left.appendChild(code);
      left.appendChild(title);

      const badge = document.createElement("span");
      badge.className = "sb-badge sb-badge--outline-accent";
      badge.textContent = `${p.nb_collabs || 0} collab.`;

      row.appendChild(left);
      row.appendChild(badge);

      host.appendChild(row);
    });
  }

  // -------- Services CRUD
  function openCreateService(){
    _serviceModalMode = "create";
    _editingServiceId = null;

    byId("svcModalTitle").textContent = "Créer un service";
    byId("svcModalSub").textContent = "Définissez le nom et, si besoin, le parent.";
    byId("svcName").value = "";
    fillParentSelect(null);

    openModal("modalService");
  }

  function openEditService(){
    if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

    const s = (_services || []).find(x => x.id_service === _selectedService);
    if (!s) return;

    _serviceModalMode = "edit";
    _editingServiceId = s.id_service;

    byId("svcModalTitle").textContent = "Modifier le service";
    byId("svcModalSub").textContent = "Renommer / changer le parent (anti-cycle appliqué).";
    byId("svcName").value = s.nom_service || "";
    fillParentSelect(s.id_service_parent || null, s.id_service);

    openModal("modalService");
  }

  function fillParentSelect(selectedId, excludeId){
    const sel = byId("svcParent");
    if (!sel) return;

    sel.innerHTML = `<option value="">(Aucun)</option>`;
    (_services || []).forEach(s => {
      if (excludeId && s.id_service === excludeId) return;
      const opt = document.createElement("option");
      opt.value = s.id_service;
      opt.textContent = `${"—".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
      sel.appendChild(opt);
    });

    sel.value = selectedId || "";
  }

  async function saveService(portal){
    const ownerId = getOwnerId();
    const name = (byId("svcName").value || "").trim();
    const parent = (byId("svcParent").value || "").trim() || null;

    if (!name) {
      portal.showAlert("error", "Nom de service obligatoire.");
      return;
    }

    if (_serviceModalMode === "create") {
      await portal.apiJson(
        `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`,
        { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
      );
    } else {
      if (!_editingServiceId) return;
      await portal.apiJson(
        `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingServiceId)}`,
        { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
      );
    }

    closeModal("modalService");
    portal.showAlert("", "");
    await loadServices(portal);
  }

  function openArchiveService(){
    if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

    const s = (_services || []).find(x => x.id_service === _selectedService);
    if (!s) return;

    byId("archiveMsg").textContent = `Archiver "${s.nom_service}" ? Les postes et collaborateurs seront détachés (Non lié).`;
    openModal("modalArchive");
  }

  async function confirmArchiveService(portal){
    const ownerId = getOwnerId();
    const sid = _selectedService;
    if (!sid || sid === "__all__" || sid === "__none__") return;

    await portal.apiJson(
      `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(sid)}/archive`,
      { method: "POST" }
    );

    closeModal("modalArchive");
    portal.showAlert("", "");

    // retour sur "Tous les services"
    _selectedService = "__all__";
    _selectedServiceName = "Tous les services";
    await loadServices(portal);
    await loadPostes(portal);

    const t = byId("svcTitle");
    const m = byId("svcMeta");
    if (t) t.textContent = "Tous les services";
    if (m) m.textContent = serviceMeta(_totaux.nb_postes, _totaux.nb_collabs);
    updateAddButtonState();
  }

  // -------- Catalogue
  async function openCatalog(portal){
    if (!isAdmin()) return;
    if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

    byId("catalogSearch").value = "";
    _catalogSearch = "";
    byId("catalogList").innerHTML = "";

    openModal("modalCatalog");
    await loadCatalog(portal);
  }

  async function loadCatalog(portal){
    const ownerId = getOwnerId();
    const url = `${portal.apiBase}/studio/org/postes_catalogue/${encodeURIComponent(ownerId)}?q=${encodeURIComponent(_catalogSearch)}`;
    const data = await portal.apiJson(url);

    const host = byId("catalogList");
    if (!host) return;
    host.innerHTML = "";

    const items = data.items || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucun poste dans le catalogue.";
      host.appendChild(empty);
      return;
    }

    items.forEach(it => {
      const row = document.createElement("div");
      row.className = "sb-row-card";

      const left = document.createElement("div");
      left.className = "sb-row-left";

      const code = document.createElement("span");
      code.className = "sb-badge sb-badge--accent-soft";
      code.textContent = it.code || "—";

      const title = document.createElement("div");
      title.className = "sb-row-title";
      title.textContent = it.intitule || "";

      left.appendChild(code);
      left.appendChild(title);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sb-btn sb-btn--accent sb-btn--xs";
      btn.textContent = "Ajouter";
      btn.addEventListener("click", async () => {
        await assignPosteFromCatalog(portal, it.id_poste);
      });

      row.appendChild(left);
      row.appendChild(btn);
      host.appendChild(row);
    });
  }

  async function assignPosteFromCatalog(portal, idPoste){
    const ownerId = getOwnerId();
    const sid = _selectedService;
    if (!sid || sid === "__all__" || sid === "__none__") return;

    await portal.apiJson(
      `${portal.apiBase}/studio/org/postes/assign/${encodeURIComponent(ownerId)}`,
      { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id_poste: idPoste, id_service: sid }) }
    );

    closeModal("modalCatalog");
    portal.showAlert("", "");

    await loadServices(portal);
    await loadPostes(portal);

    // mettre à jour meta header service sélectionné
    const row = document.querySelector(`.org-svc-item[data-sid="${CSS.escape(sid)}"] .org-svc-meta`);
    if (row) {
      // on laisse la liste refléter les compteurs rechargés
    }
  }

  // -------- Bind
  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    // admin-only (page est admin-only, mais on blinde l’UX)
    if (!isAdmin()) {
      const a = byId("btnSvcAdd"); if (a) a.style.display = "none";
      const b = byId("btnSvcEdit"); if (b) b.style.display = "none";
      const c = byId("btnSvcArchive"); if (c) c.style.display = "none";
      const d = byId("btnAddFromCatalog"); if (d) d.style.display = "none";
    }

    // Search postes
    const ps = byId("posteSearch");
    ps.addEventListener("input", () => {
      _posteSearch = (ps.value || "").trim();
      if (_posteSearchTimer) clearTimeout(_posteSearchTimer);
      _posteSearchTimer = setTimeout(() => loadPostes(portal).catch(() => {}), 250);
    });

    // Service actions
    byId("btnSvcAdd").addEventListener("click", () => openCreateService());
    byId("btnSvcEdit").addEventListener("click", () => openEditService());
    byId("btnSvcArchive").addEventListener("click", () => openArchiveService());

    byId("btnCloseService").addEventListener("click", () => closeModal("modalService"));
    byId("btnCancelService").addEventListener("click", () => closeModal("modalService"));
    byId("btnSaveService").addEventListener("click", async () => {
      try { await saveService(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnCloseArchive").addEventListener("click", () => closeModal("modalArchive"));
    byId("btnCancelArchive").addEventListener("click", () => closeModal("modalArchive"));
    byId("btnConfirmArchive").addEventListener("click", async () => {
      try { await confirmArchiveService(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    // Catalogue modal
    byId("btnAddFromCatalog").addEventListener("click", async () => {
      try { await openCatalog(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnCloseCatalog").addEventListener("click", () => closeModal("modalCatalog"));
    const cs = byId("catalogSearch");
    cs.addEventListener("input", () => {
      _catalogSearch = (cs.value || "").trim();
      if (_catalogTimer) clearTimeout(_catalogTimer);
      _catalogTimer = setTimeout(() => loadCatalog(portal).catch(() => {}), 250);
    });
  }

  async function init(){
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    const portal = window.portal;
    if (!portal) return;

    bindOnce(portal);

    setStatus("Chargement…");
    await loadServices(portal);
    await loadPostes(portal);

    _loaded = true;
    setStatus("—");
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) window.portal.showAlert("error", "Erreur organisation : " + (e?.message || e));
    setStatus("Erreur de chargement.");
  });
})();