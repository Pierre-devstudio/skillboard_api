(function () {
  let _bound = false;
  let _loaded = false;

  let _items = [];
  let _q = "";
  let _qTimer = null;

  let _show = "active";
  let _mine = true;
  let _clients = false;

  let _roleCode = (window.__studioRoleCode || "").toString().trim().toLowerCase();

  let _modalMode = "create"; // create | edit
  let _editingId = null;

  let _archiveId = null;

  function roleRank(code){
    const c = (code || "").toString().trim().toLowerCase();
    if (c === "admin") return 3;
    if (c === "editor") return 2;
    return 1;
  }

  function isEditor(){
    return roleRank(_roleCode || "user") >= 2;
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  async function ensureRole(portal){
    if (_roleCode && ["admin","editor","user"].includes(_roleCode)) return;

    const ownerId = getOwnerId();
    if (!ownerId) { _roleCode = "user"; return; }

    try {
      const ctx = await portal.apiJson(`${portal.apiBase}/studio/context/${encodeURIComponent(ownerId)}`);
      const rc = (ctx && ctx.role_code ? String(ctx.role_code) : "user").trim().toLowerCase();
      _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
      window.__studioRoleCode = _roleCode;
    } catch (_) {
      const rc = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
      _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
    }
  }

  function byId(id){ return document.getElementById(id); }

  function setStatus(msg){
    const el = byId("catPostesStatus");
    if (el) el.textContent = msg || "—";
  }

  function esc(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function renderList(){
    const host = byId("catPostesList");
    if (!host) return;
    host.innerHTML = "";

    if (!_items.length) {
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucune fiche de poste à afficher.";
      host.appendChild(empty);
      return;
    }

    _items.forEach(it => {
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

      const right = document.createElement("div");
      right.className = "sb-actions";

      const scope = document.createElement("span");
      scope.className = "sb-badge sb-badge--outline-accent";
      scope.textContent = it.id_service ? (it.is_mine ? "Mon entreprise" : "Client") : "Catalogue";

      const linkState = document.createElement("span");
      linkState.className = "sb-badge sb-badge--outline-accent";
      linkState.textContent = it.id_service ? "Lié" : "Non lié";

      right.appendChild(scope);
      right.appendChild(linkState);

      if (isEditor()) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-btn sb-btn--soft sb-btn--xs";
        btnEdit.textContent = "Modifier";
        btnEdit.addEventListener("click", () => openEdit(it));

        right.appendChild(btnEdit);

        if (it.actif) {
          const btnArch = document.createElement("button");
          btnArch.type = "button";
          btnArch.className = "sb-btn sb-btn--soft sb-btn--xs";
          btnArch.textContent = "Archiver";
          btnArch.addEventListener("click", () => openArchive(it));
          right.appendChild(btnArch);
        } else {
          const arch = document.createElement("span");
          arch.className = "sb-badge sb-badge--outline-accent";
          arch.textContent = "Archivé";
          right.appendChild(arch);
        }
      }

      row.appendChild(left);
      row.appendChild(right);

      host.appendChild(row);
    });
  }

  async function loadList(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner manquant (?id=...).");

    // garde-fou UX: au moins un périmètre coché
    if (!_mine && !_clients) _mine = true;

    const url =
      `${portal.apiBase}/studio/catalog/postes/${encodeURIComponent(ownerId)}`
      + `?q=${encodeURIComponent(_q)}`
      + `&show=${encodeURIComponent(_show)}`
      + `&mine=${_mine ? "1" : "0"}`
      + `&clients=${_clients ? "1" : "0"}`;

    const data = await portal.apiJson(url);
    _items = (data && data.items) ? data.items : [];
    renderList();
  }

  async function openCreate(portal){
    _modalMode = "create";
    _editingId = null;

    byId("posteModalTitle").textContent = "Créer une fiche de poste";
    byId("posteModalSub").textContent = "Création V1: Mon entreprise (Non lié).";

    byId("posteCodif").value = "…";
    byId("posteCodifClient").value = "";
    byId("posteIntitule").value = "";

    openModal("modalPosteEdit");

    try{
      const ownerId = getOwnerId();
      const data = await portal.apiJson(`${portal.apiBase}/studio/catalog/postes/${encodeURIComponent(ownerId)}/next_code`);
      byId("posteCodif").value = (data && data.codif_poste) ? String(data.codif_poste) : "PT???";
    }catch(e){
      byId("posteCodif").value = "PT???";
    }
  }

  function openEdit(it){
    _modalMode = "edit";
    _editingId = it.id_poste;

    byId("posteModalTitle").textContent = "Modifier la fiche de poste";
    byId("posteModalSub").textContent = (it.is_mine ? "Mon entreprise" : "Client") + " · " + (it.id_service ? "Lié" : "Non lié");

    byId("posteCodif").value = (it.codif_poste || "").trim();
    byId("posteCodifClient").value = (it.codif_client || "").trim();
    byId("posteIntitule").value = (it.intitule || "").trim();

    openModal("modalPosteEdit");
  }

  async function save(portal){
    const ownerId = getOwnerId();    
    const codc = (byId("posteCodifClient").value || "").trim();
    const title = (byId("posteIntitule").value || "").trim();
    
    if (!title) { portal.showAlert("error", "Intitulé obligatoire."); return; }

    if (_modalMode === "create") {
      await portal.apiJson(
        `${portal.apiBase}/studio/catalog/postes/${encodeURIComponent(ownerId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codif_client: codc || null, intitule_poste: title })
        }
      );
    } else {
      if (!_editingId) return;
      await portal.apiJson(
        `${portal.apiBase}/studio/catalog/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codif_poste: cod, codif_client: codc || null, intitule_poste: title })
        }
      );
    }

    closeModal("modalPosteEdit");
    portal.showAlert("", "");
    await loadList(portal);
  }

  function openArchive(it){
    _archiveId = it.id_poste;
    byId("posteArchiveMsg").textContent = `Archiver "${it.code || "—"} – ${it.intitule || ""}" ?`;
    openModal("modalPosteArchive");
  }

  async function confirmArchive(portal){
    const ownerId = getOwnerId();
    if (!_archiveId) return;

    await portal.apiJson(
      `${portal.apiBase}/studio/catalog/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(_archiveId)}/archive`,
      { method: "POST" }
    );

    _archiveId = null;
    closeModal("modalPosteArchive");
    portal.showAlert("", "");
    await loadList(portal);
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    if (!isEditor()) {
      const b = byId("btnPosteNew");
      if (b) b.style.display = "none";
    }

    byId("btnPosteNew").addEventListener("click", () => openCreate(portal));

    byId("btnPosteClose").addEventListener("click", () => closeModal("modalPosteEdit"));
    byId("btnPosteCancel").addEventListener("click", () => closeModal("modalPosteEdit"));
    byId("btnPosteSave").addEventListener("click", async () => {
      try { await save(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnPosteArchiveClose").addEventListener("click", () => closeModal("modalPosteArchive"));
    byId("btnPosteArchiveCancel").addEventListener("click", () => closeModal("modalPosteArchive"));
    byId("btnPosteArchiveConfirm").addEventListener("click", async () => {
      try { await confirmArchive(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    const s = byId("catPostesSearch");
    s.addEventListener("input", () => {
      _q = (s.value || "").trim();
      if (_qTimer) clearTimeout(_qTimer);
      _qTimer = setTimeout(() => loadList(portal).catch(() => {}), 250);
    });

    const sh = byId("catPostesShow");
    sh.addEventListener("change", () => {
      _show = (sh.value || "active").trim();
      loadList(portal).catch(() => {});
    });

    const cbMine = byId("catPostesMine");
    const cbClients = byId("catPostesClients");

    cbMine.addEventListener("change", () => {
      _mine = !!cbMine.checked;
      if (!_mine && !_clients) { _mine = true; cbMine.checked = true; }
      loadList(portal).catch(() => {});
    });

    cbClients.addEventListener("change", () => {
      _clients = !!cbClients.checked;
      if (!_mine && !_clients) { _mine = true; cbMine.checked = true; }
      loadList(portal).catch(() => {});
    });
  }

  async function init(){
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    const portal = window.portal;
    if (!portal) return;

    await ensureRole(portal);
    bindOnce(portal);

    setStatus("Chargement…");
    await loadList(portal);

    _loaded = true;
    setStatus("—");
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) window.portal.showAlert("error", "Erreur catalogue postes : " + (e?.message || e));
    setStatus("Erreur de chargement.");
  });
})();