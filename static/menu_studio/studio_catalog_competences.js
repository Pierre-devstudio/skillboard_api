(function () {
  let _bound = false;
  let _items = [];
  let _q = "";
  let _qTimer = null;
  let _show = "active";

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
    const el = byId("catCompsStatus");
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

  function renderList(){
    const host = byId("catCompsList");
    if (!host) return;
    host.innerHTML = "";

    if (!_items.length) {
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucune compétence à afficher.";
      host.appendChild(empty);
      return;
    }

    _items.forEach(it => {
      const row = document.createElement("div");
      row.className = "sb-row-card";
      if (it.masque) row.classList.add("is-archived");

      const left = document.createElement("div");
      left.className = "sb-row-left";

      const code = document.createElement("span");
      code.className = "sb-badge sb-badge--poste";
      code.textContent = it.code || "—";

      const title = document.createElement("div");
      title.className = "sb-row-title";
      title.textContent = it.intitule || "";

      left.appendChild(code);
      left.appendChild(title);

      const right = document.createElement("div");
      right.className = "sb-actions";

      if (it.domaine){
        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--poste-soft";
        dom.textContent = it.domaine;
        right.appendChild(dom);
      }

      if (it.etat){
        const st = document.createElement("span");
        st.className = "sb-badge sb-badge--poste-soft";
        st.textContent = it.etat;
        right.appendChild(st);
      }

      if (isEditor()) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-btn sb-btn--soft sb-btn--xs";
        btnEdit.textContent = "Modifier";
        btnEdit.addEventListener("click", () => openEdit(portal, it));
        right.appendChild(btnEdit);

        if (!it.masque) {
          const btnArch = document.createElement("button");
          btnArch.type = "button";
          btnArch.className = "sb-btn sb-btn--soft sb-btn--xs";
          btnArch.textContent = "Archiver";
          btnArch.addEventListener("click", () => openArchive(it));
          right.appendChild(btnArch);
        } else {
          const arch = document.createElement("span");
          arch.className = "sb-badge sb-badge--poste";
          arch.textContent = "Archivée";
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

    const url =
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}`
      + `?q=${encodeURIComponent(_q)}`
      + `&show=${encodeURIComponent(_show)}`;

    const data = await portal.apiJson(url);
    _items = (data && data.items) ? data.items : [];
    renderList();
  }

  async function openCreate(portal){
    _modalMode = "create";
    _editingId = null;

    byId("compModalTitle").textContent = "Créer une compétence";
    byId("compModalSub").textContent = "";
    byId("compModalSub").style.display = "none";

    byId("compCode").readOnly = false;
    byId("compCode").value = "…";
    byId("compIntitule").value = "";
    byId("compDomaine").value = "";
    byId("compEtat").value = "valide";
    byId("compDesc").value = "";
    byId("compNivA").value = "";
    byId("compNivB").value = "";
    byId("compNivC").value = "";
    byId("compGrille").value = "";

    openModal("modalCompEdit");

    try{
      const ownerId = getOwnerId();
      const r = await portal.apiJson(`${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/next_code`);
      byId("compCode").value = (r && r.code) ? String(r.code) : "CP????";
    }catch(_){
      byId("compCode").value = "CP????";
    }
  }

  async function openEdit(portal, it){
    _modalMode = "edit";
    _editingId = it.id_comp;

    byId("compModalTitle").textContent = it.intitule || "Modifier la compétence";
    byId("compModalSub").textContent = it.code || "";
    byId("compModalSub").style.display = "";

    openModal("modalCompEdit");

    const ownerId = getOwnerId();
    const d = await portal.apiJson(
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`
    );

    byId("compCode").value = (d.code || "");
    byId("compCode").readOnly = true;

    byId("compIntitule").value = (d.intitule || "");
    byId("compDomaine").value = (d.domaine || "");
    byId("compEtat").value = (d.etat || "valide");
    byId("compDesc").value = (d.description || "");
    byId("compNivA").value = (d.niveaua || "");
    byId("compNivB").value = (d.niveaub || "");
    byId("compNivC").value = (d.niveauc || "");

    byId("compGrille").value = d.grille_evaluation ? JSON.stringify(d.grille_evaluation, null, 2) : "";
  }

  async function save(portal){
    const ownerId = getOwnerId();

    const code = (byId("compCode").value || "").trim();
    const title = (byId("compIntitule").value || "").trim();
    const dom = (byId("compDomaine").value || "").trim();
    const etat = (byId("compEtat").value || "valide").trim();
    const desc = (byId("compDesc").value || "").trim();
    const a = (byId("compNivA").value || "").trim();
    const b = (byId("compNivB").value || "").trim();
    const c = (byId("compNivC").value || "").trim();
    const grilleRaw = (byId("compGrille").value || "").trim();

    if (_modalMode === "create" && !code){
      portal.showAlert("error", "Code obligatoire.");
      return;
    }
    if (!title){
      portal.showAlert("error", "Intitulé obligatoire.");
      return;
    }

    let grille = null;
    if (grilleRaw){
      try { grille = JSON.parse(grilleRaw); }
      catch(e){
        portal.showAlert("error", "JSON invalide dans la grille d’évaluation.");
        return;
      }
    }

    if (_modalMode === "create") {
      await portal.apiJson(
        `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: code,
            intitule: title,
            domaine: dom || null,
            etat: etat || null,
            description: desc || null,
            niveaua: a || null,
            niveaub: b || null,
            niveauc: c || null,
            grille_evaluation: grille
          })
        }
      );
    } else {
      if (!_editingId) return;
      await portal.apiJson(
        `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intitule: title,
            domaine: dom || null,
            etat: etat || null,
            description: desc || null,
            niveaua: a || null,
            niveaub: b || null,
            niveauc: c || null,
            grille_evaluation: grille
          })
        }
      );
    }

    closeModal("modalCompEdit");
    portal.showAlert("", "");
    await loadList(portal);
  }

  function openArchive(it){
    _archiveId = it.id_comp;
    byId("compArchiveMsg").textContent = `Archiver "${it.code || "—"} – ${it.intitule || ""}" ?`;
    openModal("modalCompArchive");
  }

  async function confirmArchive(portal){
    const ownerId = getOwnerId();
    if (!_archiveId) return;

    await portal.apiJson(
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_archiveId)}/archive`,
      { method: "POST" }
    );

    _archiveId = null;
    closeModal("modalCompArchive");
    portal.showAlert("", "");
    await loadList(portal);
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    if (!isEditor()) {
      const b = byId("btnCompNew");
      if (b) b.style.display = "none";
    }

    byId("btnCompNew").addEventListener("click", () => openCreate(portal));

    byId("btnCompX").addEventListener("click", () => closeModal("modalCompEdit"));
    byId("btnCompCancel").addEventListener("click", () => closeModal("modalCompEdit"));
    byId("btnCompSave").addEventListener("click", async () => {
      try { await save(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnCompArchiveX").addEventListener("click", () => closeModal("modalCompArchive"));
    byId("btnCompArchiveCancel").addEventListener("click", () => closeModal("modalCompArchive"));
    byId("btnCompArchiveConfirm").addEventListener("click", async () => {
      try { await confirmArchive(portal); }
      catch (e) { portal.showAlert("error", e?.message || String(e)); }
    });

    const s = byId("catCompsSearch");
    s.addEventListener("input", () => {
      _q = (s.value || "").trim();
      if (_qTimer) clearTimeout(_qTimer);
      _qTimer = setTimeout(() => loadList(portal).catch(() => {}), 250);
    });

    const sh = byId("catCompsShow");
    sh.addEventListener("change", () => {
      _show = (sh.value || "active").trim();
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
    setStatus("—");
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) window.portal.showAlert("error", "Erreur catalogue compétences : " + (e?.message || e));
    setStatus("Erreur de chargement.");
  });
})();