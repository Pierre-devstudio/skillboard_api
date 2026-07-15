(function () {
  let _bound = false;
  let _q = "";
  let _show = "active";
  let _dom = "";
  let _qTimer = null;
  let _itemsAll = [];
  let _items = [];
  let _domainItems = [];
  let _domainsLoaded = false;
  let _roleCode = "user";
  let _canEdit = false;
  let _modalMode = "create";
  let _editingId = null;
  let _archiveId = null;
  let _crit = null;
  let _critEditIdx = null;
  let _initPromise = null;

  function byId(id){ return document.getElementById(id); }

  function delay(ms){
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function waitLearnAuthReady(){
    try {
      const p = window.__learnAuthReady;
      if (p && typeof p.then === "function") {
        await p.catch(() => null);
        return;
      }

      const started = Date.now();

      while (!window.PortalAuthCommon && (Date.now() - started) < 5000) {
        await delay(50);
      }
    } catch(_){}
  }

  function getEffectifId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function roleRank(code){
    const c = (code || "").toString().trim().toLowerCase();
    if (c === "admin") return 3;
    if (c === "supervisor") return 2;
    return 1;
  }

  function isSupervisor(){
    return _canEdit || roleRank(_roleCode) >= 2;
  }

  function htmlEsc(v){
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function argbIntToRgbTuple(v){
    if (v === null || v === undefined) return null;

    let n;
    if (typeof v === "number") {
      n = v;
    } else {
      const s = String(v).trim();
      if (!s) return null;
      n = parseInt(s, 10);
      if (Number.isNaN(n)) return null;
    }

    const u = (n >>> 0);
    const r = (u >> 16) & 255;
    const g = (u >> 8) & 255;
    const b = u & 255;

    return { r, g, b, css: `${r},${g},${b}` };
  }

  function setSuccess(msg){
    const el = byId("catCompsSuccess");
    if (!el) return;

    if (!msg){
      el.style.display = "none";
      el.textContent = "";
      return;
    }

    el.textContent = msg;
    el.style.display = "inline-flex";

    window.clearTimeout(el._hideTimer);
    el._hideTimer = window.setTimeout(() => {
      el.style.display = "none";
      el.textContent = "";
    }, 5000);
  }

  async function ensureContext(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    const ctx = await portal.apiJson(`${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/context`);

    _roleCode = (ctx?.role_code || "user").toString().trim().toLowerCase();
    if (!["admin", "supervisor", "user"].includes(_roleCode)) _roleCode = "user";

    _canEdit = !!ctx?.can_edit || roleRank(_roleCode) >= 2;
  }

  async function ensureDomains(portal){
    if (_domainsLoaded) return;
    _domainsLoaded = true;

    try{
      const effectifId = getEffectifId();
      const r = await portal.apiJson(`${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/domaines`);
      _domainItems = Array.isArray(r?.items) ? r.items : [];
    } catch(_){
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

  function refreshDomainOptions(){
    const sel = byId("catCompsDomain");
    if (!sel) return;

    const keep = (sel.value || "").trim();
    const map = new Map();

    (_itemsAll || []).forEach(it => {
      const id = (it.domaine || "").toString().trim();
      if (!id) return;

      const label = (it.domaine_titre_court || it.domaine_titre || it.domaine || "").toString().trim();
      if (!label) return;

      if (!map.has(id)) {
        map.set(id, { label: label, couleur: it.domaine_couleur });
      }
    });

    sel.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Tous";
    sel.appendChild(opt0);

    Array.from(map.entries())
      .sort((a, b) => a[1].label.localeCompare(b[1].label, "fr", { sensitivity: "base" }))
      .forEach(([id, d]) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      });

    if (keep && map.has(keep)) sel.value = keep;
    else sel.value = "";

    _dom = (sel.value || "").trim();
  }

  function applyDomainFilterAndRender(){
    const dom = (_dom || "").trim();

    _items = dom
      ? (_itemsAll || []).filter(it => (it.domaine || "").toString().trim() === dom)
      : (Array.isArray(_itemsAll) ? _itemsAll.slice() : []);

    renderList();
  }

  function iconPdf(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>
    `;
  }

  function iconEdit(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-archive"></use></svg>
    `;
  }

  function iconTrash(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-archive"></use></svg>
    `;
  }

  function renderList(){
    const host = byId("catCompsList");
    if (!host) return;

    host.innerHTML = "";

    if (!_items.length){
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
      right.className = "sb-row-right";

      const domLabel = (it.domaine_titre_court || it.domaine_titre || it.domaine || "").toString().trim();

      if (domLabel){
        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--comp-domain";

        const rgb = argbIntToRgbTuple(it.domaine_couleur);
        if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb.css);

        const dot = document.createElement("span");
        dot.className = "sb-dot";

        dom.appendChild(dot);
        dom.appendChild(document.createTextNode(domLabel));
        right.appendChild(dom);
      }

      const actions = document.createElement("div");
      actions.className = "sb-icon-actions";

      const btnPdf = document.createElement("button");
      btnPdf.type = "button";
      btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
      btnPdf.title = "Voir PDF";
      btnPdf.setAttribute("aria-label", "Voir PDF");
      btnPdf.innerHTML = iconPdf();
      btnPdf.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
          await openCompetencePdf(it);
        } catch(err){
          window.portal.showAlert("error", err?.message || String(err));
        }
      });

      actions.appendChild(btnPdf);

      if (isSupervisor()){
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-icon-btn";
        btnEdit.title = "Modifier";
        btnEdit.setAttribute("aria-label", "Modifier");
        btnEdit.innerHTML = iconEdit();
        btnEdit.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          try {
            await openEdit(window.portal, it);
          } catch(err){
            window.portal?.showAlert?.("error", err?.message || String(err));
          }
        });

        actions.appendChild(btnEdit);

        if (!it.masque){
          const btnArch = document.createElement("button");
          btnArch.type = "button";
          btnArch.className = "sb-icon-btn sb-icon-btn--danger";
          btnArch.title = "Archiver";
          btnArch.setAttribute("aria-label", "Archiver");
          btnArch.innerHTML = iconTrash();
          btnArch.addEventListener("click", () => openArchive(it));

          actions.appendChild(btnArch);
        }
      }

      right.appendChild(actions);

      row.appendChild(left);
      row.appendChild(right);

      host.appendChild(row);
    });
  }

  async function loadList(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    const url =
      `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}`
      + `?q=${encodeURIComponent(_q)}`
      + `&show=${encodeURIComponent(_show)}`;

    const data = await portal.apiJson(url);
    _itemsAll = Array.isArray(data?.items) ? data.items : [];

    refreshDomainOptions();
    applyDomainFilterAndRender();
  }

  function emptyCrit(){
    return { Nom:"", Eval:["", "", "", ""] };
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

    for (let i = 1; i <= 4; i++){
      const k = "Critere" + i;
      const node = g[k] || {};
      const ev = Array.isArray(node.Eval) ? node.Eval : [];

      _crit[i - 1] = {
        Nom: (node.Nom || "").toString(),
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
    const out = {};

    for (let i = 1; i <= 4; i++){
      const c = (_crit && _crit[i - 1]) ? _crit[i - 1] : emptyCrit();

      out["Critere" + i] = {
        Nom: (c.Nom || "").toString(),
        Eval: [
          (c.Eval?.[0] || "").toString(),
          (c.Eval?.[1] || "").toString(),
          (c.Eval?.[2] || "").toString(),
          (c.Eval?.[3] || "").toString()
        ]
      };
    }

    return out;
  }

  function usedCritCount(){
    if (!_crit) return 0;
    return _crit.filter(c => (c?.Nom || "").trim()).length;
  }

  function nextEmptyCritIndex(){
    if (!_crit) return 0;

    for (let i = 0; i < 4; i++){
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
    if (title) title.textContent = `Critère ${idx + 1}`;

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
      btnAdd.disabled = used >= 4 || !isSupervisor();
      btnAdd.style.opacity = btnAdd.disabled ? ".6" : "";
      btnAdd.title = btnAdd.disabled ? "Maximum 4 critères." : "";
    }

    for (let i = 0; i < 4; i++){
      const c = _crit[i];
      const nom = (c?.Nom || "").trim();

      if (!nom) continue;

      const acc = document.createElement("div");
      acc.className = "sb-acc";

      const head = document.createElement("button");
      head.type = "button";
      head.className = "sb-acc-head";
      head.addEventListener("click", () => acc.classList.toggle("is-open"));

      const t = document.createElement("div");
      t.className = "sb-acc-title";
      t.textContent = `Critère ${i + 1} – ${nom}`;

      head.appendChild(t);

      const body = document.createElement("div");
      body.className = "sb-acc-body";

      const ul = document.createElement("div");
      ul.className = "sb-crit-evals";

      ["Niveau 1", "Niveau 2", "Niveau 3", "Niveau 4"].forEach((label, k) => {
        const row = document.createElement("div");
        row.className = "sb-crit-eval-row";

        const lab = document.createElement("div");
        lab.className = "label";
        lab.textContent = label;

        const txt = document.createElement("div");
        txt.textContent = (c.Eval?.[k] || "").toString();

        row.appendChild(lab);
        row.appendChild(txt);

        ul.appendChild(row);
      });

      body.appendChild(ul);

      if (isSupervisor()){
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
        body.appendChild(actions);
      }

      acc.appendChild(head);
      acc.appendChild(body);

      host.appendChild(acc);
    }

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

    _crit[_critEditIdx] = { Nom: nom, Eval:[e1, e2, e3, e4] };

    hideCritEditor();
    renderCritList();
  }

  function validateCritBeforeSave(portal){
    if (!_crit) _crit = [emptyCrit(), emptyCrit(), emptyCrit(), emptyCrit()];

    if (usedCritCount() < 1){
      portal.showAlert("error", "Ajoute au moins 1 critère d’évaluation.");
      return false;
    }

    for (let i = 0; i < 4; i++){
      const c = _crit[i];
      const nom = (c?.Nom || "").trim();
      const ev = c?.Eval || ["", "", "", ""];
      const anyEval = ev.some(x => (x || "").trim().length > 0);

      if (!nom && !anyEval) continue;

      if (!nom){
        portal.showAlert("error", `Critère ${i + 1} : nom obligatoire.`);
        return false;
      }

      for (let k = 0; k < 4; k++){
        if (!(ev[k] || "").trim()){
          portal.showAlert("error", `Critère ${i + 1} : niveau ${k + 1} obligatoire.`);
          return false;
        }
      }
    }

    return true;
  }

async function openCreate(portal){
    if (!isSupervisor()) return;

    _modalMode = "create";
    _editingId = null;

    const aiBtn = byId("btnCompAi");
    if (aiBtn) aiBtn.textContent = "Concevoir avec l’IA";

    const b = byId("compModalBadge");
    if (b){
      b.style.display = "none";
      b.textContent = "";
    }

    byId("compModalTitle").textContent = "Créer une compétence";

    const sub = byId("compModalSub");
    if (sub){
      sub.textContent = "";
      sub.style.display = "none";
    }

    byId("compIntitule").value = "";
    byId("compEtat").value = "à valider";
    byId("compDesc").value = "";
    byId("compNivA").value = "";
    byId("compNivB").value = "";
    byId("compNivC").value = "";
        if (byId("compNivD")) byId("compNivD").value = "";
        if (byId("compNivD")) byId("compNivD").value = "";

    await ensureDomains(portal);

    fillDomainSelect("");
    fillAiDomainSelect("");

    byId("compAiObjectif") && (byId("compAiObjectif").value = "");
    byId("compAiContexte") && (byId("compAiContexte").value = "");
    byId("compAiDocument") && (byId("compAiDocument").value = "");

    resetCrit();

    openModal("modalCompEdit");
  }


async function openEdit(portal, it){
    if (!isSupervisor()) return;

    const compId = String(it?.id_comp || "").trim();
    if (!compId) {
      throw new Error("Identifiant compétence introuvable.");
    }

    _modalMode = "edit";
    _editingId = compId;

    const aiBtn = byId("btnCompAi");
    if (aiBtn) aiBtn.textContent = "Réviser avec l’IA";

    const b = byId("compModalBadge");
    if (b){
      const c = (it?.code || "").toString();
      b.textContent = c;
      b.style.display = c ? "" : "none";
    }

    byId("compModalTitle").textContent = (it?.intitule || "Compétence").toString();

    const sub = byId("compModalSub");
    if (sub){
      sub.textContent = "";
      sub.style.display = "none";
    }

    openModal("modalCompEdit");

    await ensureDomains(portal);

    const effectifId = getEffectifId();

    const d = await portal.apiJson(
      `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}`
    );

    const c2 = (d?.code || "").toString();

    if (b){
      b.textContent = c2;
      b.style.display = c2 ? "" : "none";
    }

    byId("compModalTitle").textContent = (d?.intitule || "Compétence").toString();

    byId("compIntitule").value = d?.intitule || "";
    fillDomainSelect(d?.domaine || "");
    byId("compEtat").value = d?.etat || "à valider";
    byId("compDesc").value = d?.description || "";
    byId("compNivA").value = d?.niveaua || "";
    byId("compNivB").value = d?.niveaub || "";
    byId("compNivC").value = d?.niveauc || "";
    if (byId("compNivD")) byId("compNivD").value = d?.niveaud || "";
    if (byId("compNivD")) byId("compNivD").value = d?.niveaud || "";

    loadCritFromJson(d?.grille_evaluation || null);
  }


  async function save(portal){
    if (!isSupervisor()) return;

    const effectifId = getEffectifId();

    const title = (byId("compIntitule").value || "").trim();
    const dom = (byId("compDomaine").value || "").trim();
    const etat = (byId("compEtat").value || "à valider").trim();
    const desc = (byId("compDesc").value || "").trim();
    const a = (byId("compNivA").value || "").trim();
    const b = (byId("compNivB").value || "").trim();
    const c = (byId("compNivC").value || "").trim();
    const d = (byId("compNivD")?.value || "").trim();
    const d = (byId("compNivD")?.value || "").trim();

    if (!title){
      portal.showAlert("error", "Intitulé obligatoire.");
      return;
    }

    if (!validateCritBeforeSave(portal)) return;

    const payload = {
      intitule: title,
      domaine: dom || null,
      etat: etat || null,
      description: desc || null,
      niveaua: a || null,
      niveaub: b || null,
      niveauc: c || null,
      niveaud: d || null,
      grille_evaluation: buildGrilleJson()
    };

    if (_modalMode === "create"){
      await portal.apiJson(
        `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}`,
        {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        }
      );
    } else {
      if (!_editingId) return;

      await portal.apiJson(
        `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}`,
        {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        }
      );
    }

    closeModal("modalCompEdit");

    window.__learnCatalogueFormationDirtyAt = Date.now();
    window.LearnCatalogueFormation?.invalidateCaches?.();

    window.dispatchEvent(new CustomEvent("learn:competence-updated", {
      detail: {
        id_comp: _editingId || null,
        at: window.__learnCatalogueFormationDirtyAt
      }
    }));

    window.portal.showAlert("", "");
    setSuccess("Enregistré avec succès");

    await loadList(portal);
  }

  function openArchive(it){
    if (!isSupervisor()) return;

    _archiveId = it.id_comp;
    byId("compArchiveMsg").textContent = `Archiver "${it.code || "—"} – ${it.intitule || ""}" ?`;

    openModal("modalCompArchive");
  }

  async function confirmArchive(portal){
    const effectifId = getEffectifId();
    if (!_archiveId) return;

    await portal.apiJson(
      `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/${encodeURIComponent(_archiveId)}/archive`,
      { method:"POST" }
    );

    _archiveId = null;

    closeModal("modalCompArchive");

    window.portal.showAlert("", "");
    setSuccess("Compétence archivée");

    await loadList(portal);
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
    const file = byId("compAiDocument")?.files?.[0] || null;

    let nb = parseInt((byId("compAiNbCrit")?.value || "3").trim(), 10);
    if (![2, 3, 4].includes(nb)) nb = 3;

    if (!objectif){
      portal.showAlert("error", "Objectif obligatoire.");
      return;
    }

    const effectifId = getEffectifId();

    const btn = byId("btnCompAiGenerate");
    if (btn){
      btn.disabled = true;
      btn.style.opacity = ".6";
      btn.textContent = "Génération…";
    }

    try{
      let draft;

      if (file){
        const fd = new FormData();
        fd.append("objectif", objectif);
        fd.append("contexte", contexte || "");
        fd.append("domaine_id", dom || "");
        fd.append("nb_criteres", String(nb));
        fd.append("document", file);

        draft = await portal.apiJson(
          `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/draft/ai-document`,
          {
            method: "POST",
            body: fd
          }
        );
      } else {
        draft = await portal.apiJson(
          `${portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}/draft/ai`,
          {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
              objectif: objectif,
              contexte: contexte || null,
              domaine_id: dom || null,
              nb_criteres: nb
            })
          }
        );
      }

      if (draft?.intitule) byId("compIntitule").value = String(draft.intitule);
      if (draft?.description !== undefined) byId("compDesc").value = String(draft.description || "");
      if (draft?.niveaua !== undefined) byId("compNivA").value = String(draft.niveaua || "");
      if (draft?.niveaub !== undefined) byId("compNivB").value = String(draft.niveaub || "");
      if (draft?.niveauc !== undefined) byId("compNivC").value = String(draft.niveauc || "");
            if (draft?.niveaud !== undefined && byId("compNivD")) byId("compNivD").value = String(draft.niveaud || "");
            if (draft?.niveaud !== undefined && byId("compNivD")) byId("compNivD").value = String(draft.niveaud || "");

      await ensureDomains(portal);

      fillDomainSelect(draft?.domaine_id || "");
      loadCritFromJson(draft?.grille_evaluation || null);

      closeAiModal();

      portal.showAlert("", "");
    } catch(e){
      portal.showAlert("error", e?.message || String(e));
    } finally {
      if (btn){
        btn.disabled = false;
        btn.style.opacity = "";
        btn.textContent = "Générer";
      }
    }
  }

  async function fetchPdfBlob(url){
    const headers = new Headers();

    try{
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function"){
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token || "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch(_){}

    const res = await fetch(url, { headers });

    if (!res.ok){
      let detail = `HTTP ${res.status}`;

      try{
        const js = await res.clone().json();
        detail = js?.detail || js?.message || detail;
      } catch(_){
        try{
          const txt = await res.text();
          if (txt) detail = txt;
        } catch(__){}
      }

      throw new Error(detail);
    }

    return await res.blob();
  }

  function openPdfLoadingWindow(title){
    const win = window.open("", "_blank");

    if (!win){
      throw new Error("Le navigateur a bloqué l’ouverture du PDF.");
    }

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${htmlEsc(title || "Document PDF")}</title>
<style>
html,body{height:100%;margin:0;background:#f3f4f6;font-family:var(--ns-font-ui);color:#111827}
.pdf-loading{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
.pdf-loading__spinner{width:34px;height:34px;border-radius:999px;border:4px solid rgba(17,24,39,.12);border-top-color:#355caa;animation:pdfSpin .8s linear infinite}
@keyframes pdfSpin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="pdf-loading">
  <div class="pdf-loading__spinner"></div>
  <div>Chargement du PDF…</div>
</div>
</body>
</html>`);
    win.document.close();

    return win;
  }

  function renderPdfBlobInWindow(win, blob, title){
    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = htmlEsc(title || "Document PDF");

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
html,body{height:100%;margin:0;background:#111827}
iframe{width:100%;height:100%;border:0;display:block}
</style>
</head>
<body>
<iframe src="${blobUrl}" title="${safeTitle}"></iframe>
</body>
</html>`);
    win.document.close();

    const revoke = () => {
      try { URL.revokeObjectURL(blobUrl); } catch(_){}
    };

    try{
      win.addEventListener("beforeunload", revoke, { once:true });
    } catch(_){}

    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function openCompetencePdf(it){
    const effectifId = getEffectifId();
    const compId = String(it?.id_comp || "").trim();

    if (!effectifId) throw new Error("Profil Learn manquant.");
    if (!compId) throw new Error("Compétence introuvable.");

    const title =
      `Fiche compétence - ${
        String(it?.code || "").trim()
          ? `${String(it.code).trim()} - `
          : ""
      }${String(it?.intitule || "").trim() || "Compétence"}`;

    let popupWin = null;

    try{
      popupWin = openPdfLoadingWindow(title);

      const url =
        `${window.portal.apiBase}/learn/competences/${encodeURIComponent(effectifId)}`
        + `/${encodeURIComponent(compId)}/fiche_pdf`;

      const blob = await fetchPdfBlob(url);

      renderPdfBlobInWindow(popupWin, blob, title);
    } catch(e){
      if (popupWin && !popupWin.closed){
        try { popupWin.close(); } catch(_){}
      }

      throw e;
    }
  }

  function bindMaxLen(id, max){
    const el = byId(id);
    if (!el || el._sbMaxBound) return;

    el._sbMaxBound = true;
    el.setAttribute("maxlength", String(max));

    el.addEventListener("input", () => {
      const v = el.value || "";
      if (v.length > max) el.value = v.slice(0, max);
    });
  }

  function bindOnce(portal){
    if (_bound) return;

    if (!byId("view-catalogue_competences") || !byId("btnCompNew")) {
      return;
    }

    _bound = true;

    const bNew = byId("btnCompNew");

    if (bNew){
      bNew.style.display = isSupervisor() ? "" : "none";
      bNew.addEventListener("click", () => openCreate(portal));
    }

    byId("btnCompX")?.addEventListener("click", () => closeModal("modalCompEdit"));
    byId("btnCompCancel")?.addEventListener("click", () => closeModal("modalCompEdit"));

    byId("btnCompSave")?.addEventListener("click", async () => {
      try {
        await save(portal);
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

byId("btnCompAi")?.addEventListener("click", async () => {
      try{
        await ensureDomains(portal);
        fillAiDomainSelect(byId("compDomaine")?.value || "");

        const nbSel = byId("compAiNbCrit");
        if (nbSel) nbSel.value = "3";

        if (_modalMode === "edit") {
          const titre = (byId("compIntitule")?.value || "").trim();
          const description = (byId("compDesc")?.value || "").trim();

          const objectifEl = byId("compAiObjectif");
          if (objectifEl) objectifEl.value = titre;

          const contexteEl = byId("compAiContexte");
          if (contexteEl) contexteEl.value = description;
        } else {
          const objectifEl = byId("compAiObjectif");
          if (objectifEl) objectifEl.value = "";

          const contexteEl = byId("compAiContexte");
          if (contexteEl) contexteEl.value = "";
        }

        openAiModal();
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

    byId("btnCompAiX")?.addEventListener("click", closeAiModal);
    byId("btnCompAiCancel")?.addEventListener("click", closeAiModal);
    byId("btnCompAiGenerate")?.addEventListener("click", async () => generateAiDraft(portal));

    byId("btnCompAddCrit")?.addEventListener("click", () => {
      const idx = nextEmptyCritIndex();
      if (idx < 0) return;
      showCritEditor(idx);
    });

    byId("btnCompCritSave")?.addEventListener("click", () => {
      try {
        saveCritFromEditor(portal);
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

    byId("btnCompCritCancel")?.addEventListener("click", hideCritEditor);

    byId("btnCompArchiveX")?.addEventListener("click", () => closeModal("modalCompArchive"));
    byId("btnCompArchiveCancel")?.addEventListener("click", () => closeModal("modalCompArchive"));

    byId("btnCompArchiveConfirm")?.addEventListener("click", async () => {
      try {
        await confirmArchive(portal);
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

    const s = byId("catCompsSearch");

    s?.addEventListener("input", () => {
      _q = (s.value || "").trim();

      if (_qTimer) clearTimeout(_qTimer);

      _qTimer = setTimeout(() => {
        loadList(portal).catch(() => {});
      }, 250);
    });

    const sh = byId("catCompsShow");

    sh?.addEventListener("change", () => {
      _show = (sh.value || "active").trim();

      loadList(portal).catch(e => {
        portal.showAlert("error", e?.message || String(e));
      });
    });

    const domSel = byId("catCompsDomain");

    domSel?.addEventListener("change", () => {
      _dom = (domSel.value || "").trim();
      applyDomainFilterAndRender();
    });

    resetCrit();

    bindMaxLen("compNivA", 230);
    bindMaxLen("compNivB", 230);
    bindMaxLen("compNivC", 230);
    bindMaxLen("compNivD", 230);
    bindMaxLen("compCritEval1", 120);
    bindMaxLen("compCritEval2", 120);
    bindMaxLen("compCritEval3", 120);
    bindMaxLen("compCritEval4", 120);
  }

  async function init(portalArg){
    await waitLearnAuthReady();

    const portal = portalArg || window.portal;
    if (!portal) return;

    if (!byId("view-catalogue_competences")) return;

    await ensureContext(portal);

    const bNew = byId("btnCompNew");
    if (bNew) bNew.style.display = isSupervisor() ? "" : "none";

    bindOnce(portal);
    await loadList(portal);
  }

  async function onShow(portal){
    if (_initPromise) return _initPromise;

    _initPromise = init(portal).finally(() => {
      _initPromise = null;
    });

    return _initPromise;
  }

  window.LearnCatalogueCompetences = Object.assign(window.LearnCatalogueCompetences || {}, {
    onShow
  });

  onShow(window.portal).catch(e => {
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert("error", "Erreur catalogue compétences : " + (e?.message || e));
    }
  });
})();