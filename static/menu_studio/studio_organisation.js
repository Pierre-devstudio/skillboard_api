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
  
  let _showArchivedPostes = false;

  let _posteModalMode = "create"; // create | edit
  let _editingPosteId = null;

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

    let _roleCode = (window.__studioRoleCode || "").toString().trim().toLowerCase();

    function isAdmin(){
        return (_roleCode || "user") === "admin";
    }

    async function ensureRole(portal){
        // Si le rôle est déjà connu, on ne refait rien
        if (_roleCode && ["admin","editor","user"].includes(_roleCode)) return;

        const ownerId = getOwnerId();
        if (!ownerId) { _roleCode = "user"; return; }

        try {
            const ctx = await portal.apiJson(`${portal.apiBase}/studio/context/${encodeURIComponent(ownerId)}`);
            const rc = (ctx && ctx.role_code ? String(ctx.role_code) : "user").trim().toLowerCase();
            _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
            window.__studioRoleCode = _roleCode; // synchronise le reste de l’app
        } catch (_) {
            // fallback safe
            const rc = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
            _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
        }
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

        // Pseudo "Non lié" volontairement masqué dans Studio Organisation

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

        const ok = isAdmin();
        btn.disabled = !ok;
        btn.style.opacity = ok ? "" : ".6";
        btn.title = ok ? "" : "Accès admin requis.";
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

        const url =
            `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}` +
            `?service=${encodeURIComponent(_selectedService)}` +
            `&q=${encodeURIComponent(_posteSearch)}` +
            `&include_archived=${_showArchivedPostes ? "1" : "0"}`;
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
        code.className = "sb-badge sb-badge--poste";
        code.textContent = p.code || "—";

        const title = document.createElement("div");
        title.className = "sb-row-title";
        title.textContent = p.intitule || "";

        left.appendChild(code);
        left.appendChild(title);

        if (p.actif === false) row.classList.add("is-archived");

        const right = document.createElement("div");
        right.className = "sb-row-right";

        if (p.actif === false){
        const arch = document.createElement("span");
        arch.className = "sb-badge sb-badge--accent-soft";
        arch.textContent = "ARCHIVÉ";
        right.appendChild(arch);
        }

        const badge = document.createElement("span");
        badge.className = "sb-badge sb-badge--poste-soft";
        badge.textContent = `${p.nb_collabs || 0} collab.`;
        right.appendChild(badge);

        row.appendChild(left);
        row.appendChild(right);

        row.style.cursor = "pointer";
        row.addEventListener("click", () => openEditPosteModal(portal, p));

        host.appendChild(row);
        });
    }

    function setPosteTab(tab){
        const modal = byId("modalPoste");
        if (!modal) return;

        modal.querySelectorAll("#posteTabbar [data-tab]").forEach(btn => {
            const isOn = (btn.getAttribute("data-tab") === tab);
            btn.classList.toggle("sb-btn--accent", isOn);
            btn.classList.toggle("sb-btn--soft", !isOn);
        });

        modal.querySelectorAll(".sb-tab-panel[data-panel]").forEach(p => {
            const isOn = (p.getAttribute("data-panel") === tab);
            p.classList.toggle("is-active", isOn);
        });
    }

    const _posteDetailCache = new Map(); // id_poste -> detail

    async function fetchPosteDetail(portal, id_poste){
        const pid = (id_poste || "").toString().trim();
        if (!pid) throw new Error("id_poste manquant.");

        if (_posteDetailCache.has(pid)) return _posteDetailCache.get(pid);

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;
        const data = await portal.apiJson(url);
        _posteDetailCache.set(pid, data);
        return data;
    }

    function setPosteModalActif(isActif){
        const bA = byId("btnPosteArchive");
        const card = document.querySelector("#modalPoste .sb-modal-card");
        if (card) card.dataset.actif = isActif ? "1" : "0";

        if (bA){
            bA.disabled = false;
            bA.style.opacity = "";
            bA.title = "";
            bA.textContent = isActif ? "Archiver" : "Restaurer";
        }
    }

    function fillPosteServiceSelect(selectedId){
        const sel = byId("posteService");
        if (!sel) return;

        sel.innerHTML = "";

        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "(Choisir un service)";
        sel.appendChild(opt0);

        (_services || []).forEach(s => {
            const opt = document.createElement("option");
            opt.value = s.id_service;
            opt.textContent = `${"—".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
            sel.appendChild(opt);
        });

        sel.value = selectedId || "";
    }

    function openCreatePosteModal(portal){
        _posteModalMode = "create";
        _editingPosteId = null;

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", "");

        byId("posteModalTitle").textContent = "Ajouter un poste";
        byId("posteModalSub").textContent = "Créez une fiche de poste et rattachez-la au service voulu.";

        const badge = byId("posteModalBadge");
        if (badge){ badge.style.display = "none"; badge.textContent = ""; }

        const defaultSid = (_selectedService && _selectedService !== "__all__" && _selectedService !== "__none__")
            ? _selectedService
            : "";

        fillPosteServiceSelect(defaultSid);

        byId("posteCodif").value = "";
        byId("posteCodifClient").value = "";
        byId("posteIntitule").value = "";
        byId("posteMission").value = "";
        byId("posteResp").value = "";

        // Charge le détail (codes + mission/resp + actif)
        (async () => {
            try{
                const d = await fetchPosteDetail(portal, _editingPosteId);

                byId("posteCodif").value = (d.codif_poste || "");
                byId("posteCodifClient").value = (d.codif_client || "");
                byId("posteIntitule").value = (d.intitule_poste || "");
                byId("posteMission").value = (d.mission_principale || "");
                byId("posteResp").value = (d.responsabilites || "");

                // badge code (si non déjà)
                const badge2 = byId("posteModalBadge");
                if (badge2){
                    const c = (d.codif_client || "").trim() || (d.codif_poste || "").trim();
                    if (c){ badge2.textContent = c; badge2.style.display = ""; }
                }

                setPosteModalActif(!!d.actif);

                const bD = byId("btnPosteDuplicate");
                if (bD){ bD.disabled = false; bD.style.opacity = ""; bD.title = ""; }

            } catch(e){
                portal.showAlert("error", e?.message || String(e));
            }
        })();

        // boutons (actions API à l'étape 2)
        const bA = byId("btnPosteArchive");
        const bD = byId("btnPosteDuplicate");
        if (bA){ bA.disabled = true; bA.style.opacity = ".6"; bA.title = "Disponible après création."; }
        if (bD){ bD.disabled = true; bD.style.opacity = ".6"; bD.title = "Disponible après création."; }

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Créer";

        setPosteTab("def");
        openModal("modalPoste");
    }

    function openEditPosteModal(portal, p){
        _posteModalMode = "edit";
        _editingPosteId = (p && p.id_poste) ? String(p.id_poste) : null;

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");

        byId("posteModalTitle").textContent = "Modifier le poste";
        byId("posteModalSub").textContent = "Mise à jour / transfert de service / archivage.";

        const badge = byId("posteModalBadge");
        const code = (p && p.code) ? String(p.code).trim() : "";
        if (badge){
            if (code){
                badge.textContent = code;
                badge.style.display = "";
            } else {
                badge.textContent = "";
                badge.style.display = "none";
            }
        }

        fillPosteServiceSelect((p && p.id_service) ? String(p.id_service) : "");

        // On pré-remplit ce qu'on a déjà (le détail complet arrive à l'étape 2)
        byId("posteIntitule").value = (p && p.intitule) ? String(p.intitule) : "";

        const bA = byId("btnPosteArchive");
        const bD = byId("btnPosteDuplicate");
        if (bA){ bA.disabled = true; bA.style.opacity = ".6"; bA.title = "Branchement API à l'étape 2."; }
        if (bD){ bD.disabled = true; bD.style.opacity = ".6"; bD.title = "Branchement API à l'étape 2."; }

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Enregistrer";

        setPosteTab("def");
        openModal("modalPoste");
    }

    function closePosteModal(){
        closeModal("modalPoste");
    }

        function getPosteModalActif(){
        const card = document.querySelector("#modalPoste .sb-modal-card");
        return (card && card.dataset.actif === "0") ? false : true;
    }

    async function savePosteFromModal(portal){
        const ownerId = getOwnerId();

        const sid = (byId("posteService")?.value || "").trim();
        const cod = (byId("posteCodif")?.value || "").trim();
        const codc = (byId("posteCodifClient")?.value || "").trim();
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const resp = (byId("posteResp")?.value || "").trim();

        if (!sid){
            portal.showAlert("error", "Sélectionne un service.");
            return;
        }
        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return;
        }

        if (_posteModalMode === "edit" && !cod){
            portal.showAlert("error", "Code interne obligatoire.");
            return;
        }

        const payload = {
            id_service: sid,
            codif_poste: (cod || null),
            codif_client: (codc || null),
            intitule_poste: title,
            mission_principale: (mission || null),
            responsabilites: (resp || null),
        };

        if (_posteModalMode === "create"){
            // create
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            // bascule en mode edit sur le poste créé
            const newId = (r && r.id_poste) ? String(r.id_poste) : "";
            const newCode = (r && r.codif_poste) ? String(r.codif_poste) : "";

            if (newId){
                _posteDetailCache.delete(newId);

                await loadServices(portal);
                await loadPostes(portal);

                openEditPosteModal(portal, {
                    id_poste: newId,
                    code: newCode,
                    intitule: title,
                    id_service: sid,
                    nb_collabs: 0,
                    actif: true,
                });
                setStatus("Poste créé.");
            } else {
                setStatus("Poste créé.");
                closePosteModal();
            }

        } else {
            // update
            const pid = (_editingPosteId || "").trim();
            if (!pid) throw new Error("id_poste manquant (edit).");

            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;
            await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            _posteDetailCache.delete(pid);

            await loadServices(portal);
            await loadPostes(portal);

            setStatus("Poste enregistré.");
        }
    }

    async function toggleArchivePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const isActif = getPosteModalActif();
        const wantArchive = isActif; // si actif => on archive ; si archivé => on restaure

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ archive: wantArchive }),
        });

        _posteDetailCache.delete(pid);

        await loadServices(portal);
        await loadPostes(portal);

        const nowActif = (r && typeof r.actif === "boolean") ? r.actif : !wantArchive;
        setPosteModalActif(nowActif);

        setStatus(wantArchive ? "Poste archivé." : "Poste restauré.");
    }

    async function duplicatePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const sid = (byId("posteService")?.value || "").trim();
        if (!sid){
            portal.showAlert("error", "Sélectionne un service cible avant duplication.");
            return;
        }

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/duplicate`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ id_service: sid }),
        });

        const newId = (r && r.id_poste) ? String(r.id_poste) : "";
        const newCode = (r && r.codif_poste) ? String(r.codif_poste) : "";

        await loadServices(portal);
        await loadPostes(portal);

        if (newId){
            _posteDetailCache.delete(newId);
            openEditPosteModal(portal, {
                id_poste: newId,
                code: newCode,
                intitule: (byId("posteIntitule")?.value || ""),
                id_service: sid,
                nb_collabs: 0,
                actif: true,
            });
            setStatus("Poste dupliqué.");
        } else {
            setStatus("Poste dupliqué.");
        }
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
        code.className = "sb-badge sb-badge--poste";
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

        const cbArch = byId("posteShowArchived");
        if (cbArch){
            cbArch.addEventListener("change", () => {
                _showArchivedPostes = !!cbArch.checked;
                loadPostes(portal).catch(() => {});
            });
        }

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
        byId("btnAddFromCatalog").addEventListener("click", () => {
            try { openCreatePosteModal(portal); }
            catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnCloseCatalog").addEventListener("click", () => closeModal("modalCatalog"));
        const cs = byId("catalogSearch");
        cs.addEventListener("input", () => {
        _catalogSearch = (cs.value || "").trim();
        if (_catalogTimer) clearTimeout(_catalogTimer);
        _catalogTimer = setTimeout(() => loadCatalog(portal).catch(() => {}), 250);
        });

        // Modal Poste: close / cancel / backdrop / tabs
        byId("btnClosePoste")?.addEventListener("click", closePosteModal);
        byId("btnPosteCancel")?.addEventListener("click", closePosteModal);

        const mp = byId("modalPoste");
        if (mp && !mp._sbBound){
            mp._sbBound = true;

            mp.addEventListener("click", (e) => {
                if (e.target === mp) closePosteModal();
            });

            mp.querySelectorAll("#posteTabbar [data-tab]").forEach(btn => {
                btn.addEventListener("click", () => {
                    const tab = btn.getAttribute("data-tab");
                    setPosteTab(tab);
                });
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPoste");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteModal();
            });
        }

        byId("btnPosteSave")?.addEventListener("click", async () => {
            try { await savePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteArchive")?.addEventListener("click", async () => {
            try { await toggleArchivePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteDuplicate")?.addEventListener("click", async () => {
            try { await duplicatePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
    }

    async function init(){
        try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
        const portal = window.portal;
        if (!portal) return;

        await ensureRole(portal);
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