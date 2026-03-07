(function () {
  let _bound = false;
  let _items = [];
  let _q = "";
  let _qTimer = null;
  let _show = "active";
  let _dom = "";          // id_domaine_competence sélectionné
  let _itemsAll = [];     // liste brute reçue de l’API (avant filtre domaine)
  let _domainsLoaded = false;
  let _domainItems = [];

    async function ensureDomains(portal){
        if (_domainsLoaded) return;
        _domainsLoaded = true;

        try{
            const ownerId = getOwnerId();
            const url = `${portal.apiBase}/studio/catalog/domaines/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url);
            _domainItems = Array.isArray(r?.items) ? r.items : [];
        } catch(e){
            _domainItems = [];
        }
    }

    function fillDomainSelect(selectedId){
        const sel = byId("compDomaine");
        if (!sel) return;

        const keep = (selectedId ?? sel.value ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_domainItems || []).forEach(d => {
            const id = (d.id_domaine_competence || "").toString().trim();
            if (!id) return;

            const label = (d.titre_court || d.titre || id).toString().trim();
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = label;
            opt.title = (d.titre || label || "").toString();
            sel.appendChild(opt);
        });

        sel.value = keep || "";
    }
    
    function fillAiDomainSelect(selectedId){
        const sel = byId("compAiDomaine");
        if (!sel) return;

        const keep = (selectedId ?? sel.value ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_domainItems || []).forEach(d => {
            const id = (d.id_domaine_competence || "").toString().trim();
            if (!id) return;

            const label = (d.titre_court || d.titre || id).toString().trim();
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = label;
            sel.appendChild(opt);
        });

        sel.value = keep || "";
    }

  let _roleCode = (window.__studioRoleCode || "").toString().trim().toLowerCase();

  let _modalMode = "create"; // create | edit
  let _editingId = null;

  let _archiveId = null;

  // -------------------- Grille d'évaluation (Critères) --------------------
    let _crit = null;               // Array[4] : { Nom, Eval[4] }
    let _critEditIdx = null;        // 0..3

    function emptyCrit(){
    return { Nom:"", Eval:["","","",""] };
    }

    function resetCrit(){
    _crit = [emptyCrit(), emptyCrit(), emptyCrit(), emptyCrit()];
    _critEditIdx = null;
    hideCritEditor();
    renderCritList();
    }

    function parseGrilleObject(v){
    if (!v) return null;
    if (typeof v === "object") return v;
    if (typeof v === "string"){
        try { return JSON.parse(v); } catch(_) { return null; }
    }
    return null;
    }

    function loadCritFromJson(grille){
    const g = parseGrilleObject(grille) || {};
    _crit = [emptyCrit(), emptyCrit(), emptyCrit(), emptyCrit()];

    for (let i=1;i<=4;i++){
        const k = "Critere" + i;
        const node = g[k] || {};
        const nom = (node.Nom || "").toString();
        const ev = Array.isArray(node.Eval) ? node.Eval : [];
        _crit[i-1] = {
        Nom: nom,
        Eval: [
            (ev[0] || "").toString(),
            (ev[1] || "").toString(),
            (ev[2] || "").toString(),
            (ev[3] || "").toString()
        ]
        };
    }
    _critEditIdx = null;
    hideCritEditor();
    renderCritList();
    }

    function buildGrilleJson(){
    // Toujours Critere1..Critere4
    const out = {};
    for (let i=1;i<=4;i++){
        const c = (_crit && _crit[i-1]) ? _crit[i-1] : emptyCrit();
        out["Critere"+i] = {
        Nom: (c.Nom || "").toString(),
        Eval: [
            (c.Eval?.[0] || "").toString(),
            (c.Eval?.[1] || "").toString(),
            (c.Eval?.[2] || "").toString(),
            (c.Eval?.[3] || "").toString(),
        ]
        };
    }
    return out;
    }

    function usedCritCount(){
    if (!_crit) return 0;
    let n = 0;
    for (let i=0;i<4;i++){
        const c = _crit[i];
        if (!c) continue;
        if ((c.Nom || "").trim()) n++;
    }
    return n;
    }

    function nextEmptyCritIndex(){
    if (!_crit) return 0;
    for (let i=0;i<4;i++){
        const c = _crit[i];
        const hasNom = (c?.Nom || "").trim().length > 0;
        const hasEval = (c?.Eval || []).some(x => (x || "").trim().length > 0);
        if (!hasNom && !hasEval) return i;
    }
    return -1;
    }

    function showCritEditor(idx){
    _critEditIdx = idx;

    const ed = byId("compCritEditor");
    if (!ed) return;

    const title = byId("compCritEditorTitle");
    if (title) title.textContent = `Critère ${idx+1}`;

    const c = _crit[idx] || emptyCrit();

    byId("compCritNom").value = c.Nom || "";
    byId("compCritEval1").value = c.Eval?.[0] || "";
    byId("compCritEval2").value = c.Eval?.[1] || "";
    byId("compCritEval3").value = c.Eval?.[2] || "";
    byId("compCritEval4").value = c.Eval?.[3] || "";

    ed.style.display = "";
    }

    function hideCritEditor(){
    const ed = byId("compCritEditor");
    if (ed) ed.style.display = "none";
    _critEditIdx = null;
    }

    function renderCritList(){
    const host = byId("compCritList");
    const btnAdd = byId("btnCompAddCrit");
    if (!host) return;

    if (!_crit) _crit = [emptyCrit(), emptyCrit(), emptyCrit(), emptyCrit()];

    host.innerHTML = "";

    const used = usedCritCount();
    if (btnAdd){
        btnAdd.disabled = used >= 4;
        btnAdd.style.opacity = btnAdd.disabled ? ".6" : "";
        btnAdd.title = btnAdd.disabled ? "Maximum 4 critères." : "";
    }

    // Affiche uniquement les critères renseignés
    for (let i=0;i<4;i++){
        const c = _crit[i];
        const nom = (c?.Nom || "").trim();
        if (!nom) continue;

        const acc = document.createElement("div");
        acc.className = "sb-acc";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "sb-acc-head";
        head.addEventListener("click", () => {
        acc.classList.toggle("is-open");
        });

        const t = document.createElement("div");
        t.className = "sb-acc-title";
        t.textContent = `Critère ${i+1} – ${nom}`;

        head.appendChild(t);

        const body = document.createElement("div");
        body.className = "sb-acc-body";

        const ul = document.createElement("div");
        ul.className = "sb-crit-evals";

        const labels = ["Niveau 1","Niveau 2","Niveau 3","Niveau 4"];
        for (let k=0;k<4;k++){
        const row = document.createElement("div");
        row.className = "sb-crit-eval-row";

        const lab = document.createElement("div");
        lab.className = "label";
        lab.textContent = labels[k];

        const txt = document.createElement("div");
        txt.textContent = (c.Eval?.[k] || "").toString();

        row.appendChild(lab);
        row.appendChild(txt);
        ul.appendChild(row);
        }

        const actions = document.createElement("div");
        actions.className = "sb-acc-actions";

        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-btn sb-btn--soft sb-btn--xs";
        btnEdit.textContent = "Modifier";
        btnEdit.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCritEditor(i);
        acc.classList.add("is-open");
        });

        actions.appendChild(btnEdit);

        body.appendChild(ul);
        body.appendChild(actions);

        acc.appendChild(head);
        acc.appendChild(body);

        host.appendChild(acc);
    }

    // Message si rien
    if (!host.children.length){
        const empty = document.createElement("div");
        empty.className = "card-sub";
        empty.textContent = "Aucun critère. Ajoute au moins 1 critère.";
        host.appendChild(empty);
    }
    }

    function saveCritFromEditor(portal){
    if (_critEditIdx === null || _critEditIdx === undefined) return;

    const nom = (byId("compCritNom").value || "").trim();
    const e1 = (byId("compCritEval1").value || "").trim();
    const e2 = (byId("compCritEval2").value || "").trim();
    const e3 = (byId("compCritEval3").value || "").trim();
    const e4 = (byId("compCritEval4").value || "").trim();

    if (!nom){
        portal.showAlert("error", "Nom du critère obligatoire.");
        return;
    }
    if (!e1 || !e2 || !e3 || !e4){
        portal.showAlert("error", "Les 4 niveaux d’évaluation sont obligatoires.");
        return;
    }

    _crit[_critEditIdx] = { Nom: nom, Eval:[e1,e2,e3,e4] };
    hideCritEditor();
    renderCritList();
    }

  function validateCritBeforeSave(portal){
    if (!_crit) _crit = [emptyCrit(), emptyCrit(), emptyCrit(), emptyCrit()];

    // Au moins 1 critère
    if (usedCritCount() < 1){
        portal.showAlert("error", "Ajoute au moins 1 critère d’évaluation.");
        return false;
    }

    // Pas de critères partiels
    for (let i=0;i<4;i++){
        const c = _crit[i];
        const nom = (c?.Nom || "").trim();
        const ev = c?.Eval || ["","","",""];
        const anyEval = ev.some(x => (x || "").trim().length > 0);

        if (!nom && !anyEval) continue; // critère vide autorisé

        if (!nom){
        portal.showAlert("error", `Critère ${i+1} : nom obligatoire.`);
        return false;
        }
        for (let k=0;k<4;k++){
        if (!(ev[k] || "").trim()){
            portal.showAlert("error", `Critère ${i+1} : niveau ${k+1} obligatoire.`);
            return false;
        }
        }
    }
    return true;
  }

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

  function argbIntToRgbTuple(v){
    if (v === null || v === undefined) return null;

    let n;
    if (typeof v === "number") n = v;
    else {
        const s = String(v).trim();
        if (!s) return null;
        n = parseInt(s, 10);
        if (Number.isNaN(n)) return null;
    }

    const u = (n >>> 0);                 // unsigned 32
    const r = (u >> 16) & 255;
    const g = (u >> 8) & 255;
    const b = u & 255;
    return { r, g, b, css: `${r},${g},${b}` };
    }

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

    function refreshDomainOptions(){
        const sel = byId("catCompsDomain");
        if (!sel) return;

        const keep = (sel.value || "").trim();

        // domaines présents dans la liste courante
        const map = new Map(); // id -> { label, couleur }
        (_itemsAll || []).forEach(it => {
            const id = (it.domaine || "").toString().trim();
            if (!id) return;

            const label = (it.domaine_titre_court || it.domaine || "").toString().trim();
            if (!label) return;

            if (!map.has(id)) {
            map.set(id, { label: label, couleur: it.domaine_couleur });
            }
        });

        // reset options
        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "Tous";
        sel.appendChild(opt0);

        // tri par label
        Array.from(map.entries())
            .sort((a, b) => a[1].label.localeCompare(b[1].label, "fr", { sensitivity: "base" }))
            .forEach(([id, d]) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = d.label;
            sel.appendChild(opt);
            });

        // restore selection if possible
        if (keep && map.has(keep)) sel.value = keep;
        else sel.value = "";
        _dom = (sel.value || "").trim();
        }

        function applyDomainFilterAndRender(){
        const dom = (_dom || "").trim();
        if (!dom){
            _items = Array.isArray(_itemsAll) ? _itemsAll.slice() : [];
        } else {
            _items = (_itemsAll || []).filter(it => (it.domaine || "").toString().trim() === dom);
        }
        renderList();
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
      code.className = "sb-badge sb-badge--comp";
      code.textContent = it.code || "—";

      const title = document.createElement("div");
      title.className = "sb-row-title";
      title.textContent = it.intitule || "";

      left.appendChild(code);
      left.appendChild(title);

      const right = document.createElement("div");
      right.className = "sb-actions";

        // --- Badge Domaine (remplace UUID + active/archivé)
        const domLabel = (it.domaine_titre_court || it.domaine || "").toString().trim();
        if (domLabel){
            const dom = document.createElement("span");
            dom.className = "sb-badge sb-badge--comp-domain";

            const dot = document.createElement("span");
            dot.className = "sb-dot";

            const rgb = argbIntToRgbTuple(it.domaine_couleur);
            if (rgb){
                dom.style.setProperty("--sb-domain-rgb", rgb.css);
            }

            dom.appendChild(dot);
            dom.appendChild(document.createTextNode(domLabel));
            right.appendChild(dom);
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
    _itemsAll = (data && data.items) ? data.items : [];

    refreshDomainOptions();
    applyDomainFilterAndRender();
  }

    function openAiModal(){
        openModal("modalCompAi");
    }
    function closeAiModal(){
        closeModal("modalCompAi");
    }

    async function generateAiDraft(portal){
        const objectif = (byId("compAiObjectif")?.value || "").trim();
        const contexte = (byId("compAiContexte")?.value || "").trim();
        const dom = (byId("compAiDomaine")?.value || "").trim();

        let nb = parseInt((byId("compAiNbCrit")?.value || "3").trim(), 10);
        if (![2,3,4].includes(nb)) nb = 3;

        if (!objectif){
            portal.showAlert("error", "Objectif obligatoire.");
            return;
        }

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/ai_draft`;

        const btn = byId("btnCompAiGenerate");
        if (btn){ btn.disabled = true; btn.style.opacity = ".6"; btn.textContent = "Génération…"; }

        try{
            const draft = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
            objectif: objectif,
            contexte: contexte || null,
            domaine_id: dom || null,
            nb_criteres: nb
            })
            });

            // Hydratation formulaire principal
            if (draft?.intitule) byId("compIntitule").value = String(draft.intitule);
            if (draft?.description !== undefined) byId("compDesc").value = String(draft.description || "");
            if (draft?.niveaua !== undefined) byId("compNivA").value = String(draft.niveaua || "");
            if (draft?.niveaub !== undefined) byId("compNivB").value = String(draft.niveaub || "");
            if (draft?.niveauc !== undefined) byId("compNivC").value = String(draft.niveauc || "");

            // Domaine (draft.domaine_id = id_domaine_competence)
            await ensureDomains(portal);
            fillDomainSelect(draft?.domaine_id || "");

            // Grille d'évaluation
            if (typeof loadCritFromJson === "function"){
            loadCritFromJson(draft?.grille_evaluation || null);
            }

            closeAiModal();
            portal.showAlert("", ""); // silence
        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        } finally {
            if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.textContent = "Générer"; }
        }
    }

    async function openCreate(portal){
        _modalMode = "create";
        _editingId = null;

        const b = byId("compModalBadge");
        if (b){ b.style.display = "none"; b.textContent = ""; }

        byId("compModalTitle").textContent = "Créer une compétence";

        const aiBtn = byId("btnCompAi");
        if (aiBtn) aiBtn.style.display = "";

        const sub = byId("compModalSub");
        if (sub){ sub.textContent = ""; sub.style.display = "none"; }

        byId("compIntitule").value = "";
        byId("compDomaine").value = "";
        byId("compEtat").value = "valide";
        byId("compDesc").value = "";
        byId("compNivA").value = "";
        byId("compNivB").value = "";
        byId("compNivC").value = "";
        

        await ensureDomains(portal);

        fillAiDomainSelect(""); // prépare le select du modal IA
        byId("compAiObjectif") && (byId("compAiObjectif").value = "");
        byId("compAiContexte") && (byId("compAiContexte").value = "");

        fillDomainSelect("");


        resetCrit();

        openModal("modalCompEdit");
    }

  async function openEdit(portal, it){
    _modalMode = "edit";
    _editingId = it.id_comp;
    const aiBtn = byId("btnCompAi");
    if (aiBtn) aiBtn.style.display = "none";

    const b = byId("compModalBadge");
    if (b){
    const c = (it && it.code) ? String(it.code) : "";
    b.textContent = c;
    b.style.display = c ? "" : "none";
    }

    byId("compModalTitle").textContent = (it && it.intitule) ? String(it.intitule) : "Compétence";

    const sub = byId("compModalSub");
    if (sub){ sub.textContent = ""; sub.style.display = "none"; }

    openModal("modalCompEdit");

    await ensureDomains(portal);
    fillDomainSelect((it && it.domaine) ? it.domaine : "");

    const ownerId = getOwnerId();
    const d = await portal.apiJson(
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`
    );

    loadCritFromJson(d.grille_evaluation);

    const b2 = byId("compModalBadge");
    if (b2){
    const c2 = (d && d.code) ? String(d.code) : "";
    b2.textContent = c2;
    b2.style.display = c2 ? "" : "none";
    }

    if (d && d.intitule){
    byId("compModalTitle").textContent = String(d.intitule);
    }


    byId("compIntitule").value = (d.intitule || "");
    fillDomainSelect(d.domaine || "");
    byId("compEtat").value = (d.etat || "valide");
    byId("compDesc").value = (d.description || "");
    byId("compNivA").value = (d.niveaua || "");
    byId("compNivB").value = (d.niveaub || "");
    byId("compNivC").value = (d.niveauc || "");

    
  }

  async function save(portal){
    const ownerId = getOwnerId();
    
    const title = (byId("compIntitule").value || "").trim();
    const dom = (byId("compDomaine").value || "").trim();
    const etat = (byId("compEtat").value || "valide").trim();
    const desc = (byId("compDesc").value || "").trim();
    const a = (byId("compNivA").value || "").trim();
    const b = (byId("compNivB").value || "").trim();
    const c = (byId("compNivC").value || "").trim();
    


    if (!title){
      portal.showAlert("error", "Intitulé obligatoire.");
      return;
    }

    if (!validateCritBeforeSave(portal)) return;

    const grille = buildGrilleJson();

    if (_modalMode === "create") {
      await portal.apiJson(
        `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}`,
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

    // IA: ouverture/fermeture/génération
    byId("btnCompAi")?.addEventListener("click", async () => {
    try{
        await ensureDomains(portal);
        fillAiDomainSelect(byId("compDomaine")?.value || "");
        const nbSel = byId("compAiNbCrit");
        if (nbSel) nbSel.value = "3";
        openAiModal();
    } catch(e){
        portal.showAlert("error", e?.message || String(e));
    }
    });

    byId("btnCompAiX")?.addEventListener("click", closeAiModal);
    byId("btnCompAiCancel")?.addEventListener("click", closeAiModal);

    byId("btnCompAiGenerate")?.addEventListener("click", async () => {
    await generateAiDraft(portal);
    });

    // Grille: boutons + init
    byId("btnCompAddCrit")?.addEventListener("click", () => {
    const idx = nextEmptyCritIndex();
    if (idx < 0) return;
    showCritEditor(idx);
    });

    byId("btnCompCritSave")?.addEventListener("click", () => {
    try { saveCritFromEditor(portal); } catch(e){ portal.showAlert("error", e?.message || String(e)); }
    });

    byId("btnCompCritCancel")?.addEventListener("click", () => hideCritEditor());

    // init par défaut (au cas où)
    resetCrit();

    function bindMaxLen(id, max){
        const el = byId(id);
        if (!el || el._sbMaxBound) return;
        el._sbMaxBound = true;

        el.setAttribute("maxlength", String(max));

        el.addEventListener("input", () => {
            const v = (el.value || "");
            if (v.length > max) el.value = v.slice(0, max);
        });
    }

    bindMaxLen("compNivA", 230);
    bindMaxLen("compNivB", 230);
    bindMaxLen("compNivC", 230);

    bindMaxLen("compCritEval1", 120);
    bindMaxLen("compCritEval2", 120);
    bindMaxLen("compCritEval3", 120);
    bindMaxLen("compCritEval4", 120);

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

    const domSel = byId("catCompsDomain");
    domSel.addEventListener("change", () => {
    _dom = (domSel.value || "").trim();
    applyDomainFilterAndRender();
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