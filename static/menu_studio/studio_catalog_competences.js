(function () {
  let _bound = false;
  let _items = [];
  let _q = "";
  let _qTimer = null;
  let _show = "active";
  let _dom = new Set();   // id_domaine_competence sélectionnés
  let _onlyPending = false;
  let _itemsAll = [];     // liste brute reçue de l’API (avant filtres UI)
  let _domainsLoaded = false;
  let _domainItems = [];
  let _metricsLoaded = false;

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
    if (c === "supervisor") return 2;
    return 1;
  }

  function isSupervisor(){
    return roleRank(_roleCode || "user") >= 2;
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  async function ensureRole(portal){
    if (_roleCode && ["admin","supervisor","user"].includes(_roleCode)) return;

    const ownerId = getOwnerId();
    if (!ownerId) { _roleCode = "user"; return; }

    try {
      const ctx = await portal.apiJson(`${portal.apiBase}/studio/context/${encodeURIComponent(ownerId)}`);
      const rc = (ctx && ctx.role_code ? String(ctx.role_code) : "user").trim().toLowerCase();
      _roleCode = ["admin","supervisor","user"].includes(rc) ? rc : "user";
      window.__studioRoleCode = _roleCode;
    } catch (_) {
      const rc = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
      _roleCode = ["admin","supervisor","user"].includes(rc) ? rc : "user";
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

  function htmlEsc(v){
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pendingKey(value){
    const plain = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    return plain === "a valider" || plain === "a_valider" || plain === "avalider";
  }

  function iconSvg(kind){
    if (kind === "edit") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4.5L19 9.5a2.1 2.1 0 0 0-3-3L5.5 17H4v3Z"></path><path d="M14.5 7 17 9.5"></path></svg>`;
    }
    if (kind === "archive") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M6 7l1 13h10l1-13"></path><path d="M9 7V4h6v3"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>`;
    }
    if (kind === "pdf") {
      return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>`;
    }
    return "";
  }

  async function resolveStudioAccessToken(){
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        if (session && session.access_token) return String(session.access_token);
      }
    } catch (_) {}
    if (window.portal && window.portal.accessToken) return String(window.portal.accessToken);
    if (window.portal && window.portal.token) return String(window.portal.token);
    return "";
  }

  function openPdfLoadingWindow(title){
    const safeTitle = htmlEsc(title || "Document PDF");
    const win = window.open("", "_blank");
    if (!win) throw new Error("Le navigateur a bloqué l’ouverture du PDF.");

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
html,body{height:100%;margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827;}
.pdf-loading{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;}
.pdf-loading__spinner{width:34px;height:34px;border-radius:999px;border:4px solid rgba(17,24,39,.12);border-top-color:#355caa;animation:pdfSpin .8s linear infinite;}
.pdf-loading__text{font-size:14px;color:#475467;}
iframe{width:100%;height:100%;border:0;background:#fff;}
@keyframes pdfSpin{to{transform:rotate(360deg);}}
</style>
</head>
<body>
<div class="pdf-loading"><div class="pdf-loading__spinner"></div><div class="pdf-loading__text">Génération du PDF…</div></div>
</body>
</html>`);
    win.document.close();
    return win;
  }

  function renderPdfBlobInWindow(win, blob, title){
    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = htmlEsc(title || "Document PDF");

    if (!win || win.closed){
      window.open(blobUrl, "_blank");
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch(_){} }, 5 * 60 * 1000);
      return;
    }

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>html,body{height:100%;margin:0;background:#f3f4f6;}iframe{width:100%;height:100%;border:0;background:#fff;}</style>
</head>
<body><iframe src="${blobUrl}" title="${safeTitle}"></iframe></body>
</html>`);
    win.document.close();

    const revoke = () => { try { URL.revokeObjectURL(blobUrl); } catch(_){} };
    try { win.addEventListener("beforeunload", revoke, { once: true }); } catch(_){}
    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function fetchPdfBlob(url){
    const headers = {};
    const token = await resolveStudioAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      credentials: "same-origin"
    });

    if (!res.ok){
      let detail = `HTTP ${res.status}`;
      try {
        const js = await res.clone().json();
        detail = js?.detail || js?.message || detail;
      } catch (_) {
        try {
          const txt = await res.text();
          if (txt) detail = txt;
        } catch (_) {}
      }
      throw new Error(detail);
    }

    return await res.blob();
  }

  async function openSkillSheetPdf(portal, item, popupWin){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const compId = String(item?.id_comp || item?.id_competence || "").trim();
    if (!compId) throw new Error("Compétence introuvable.");

    const title = `Fiche compétence - ${String(item?.code || "").trim() ? `${String(item.code).trim()} - ` : ""}${String(item?.intitule || "").trim() || "Compétence"}`;
    const url = `${portal.apiBase}/studio/org/competences/fiche_pdf/${encodeURIComponent(ownerId)}/${encodeURIComponent(compId)}`;
    const blob = await fetchPdfBlob(url);
    renderPdfBlobInWindow(popupWin, blob, title);
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function domainRowsFromItems(){
    const map = new Map();
    (_itemsAll || []).forEach(it => {
      const id = (it.domaine || "").toString().trim();
      if (!id) return;

      const label = (it.domaine_titre_court || it.domaine || "").toString().trim();
      if (!label) return;

      if (!map.has(id)) map.set(id, { label, couleur: it.domaine_couleur });
    });

    return Array.from(map.entries())
      .sort((a, b) => a[1].label.localeCompare(b[1].label, "fr", { sensitivity: "base" }))
      .map(([id, d]) => ({ id, label: d.label, couleur: d.couleur }));
  }

  function refreshDomainChecks(){
    const host = byId("catCompsDomainChecks");
    if (!host) return;

    const rows = domainRowsFromItems();
    const available = new Set(rows.map(d => d.id));
    _dom = new Set(Array.from(_dom || []).filter(id => available.has(id)));

    host.innerHTML = "";

    if (!rows.length){
      const empty = document.createElement("div");
      empty.className = "studio-catalog-comp-filter-empty";
      empty.textContent = "Aucun domaine disponible.";
      host.appendChild(empty);
      refreshFilterCounts();
      return;
    }

    rows.forEach(d => {
      const label = document.createElement("label");
      label.className = "studio-catalog-comp-check-item studio-catalog-comp-check-item--domain";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = d.id;
      input.checked = _dom.has(d.id);
      input.addEventListener("change", () => {
        if (input.checked) _dom.add(d.id);
        else _dom.delete(d.id);
        refreshFilterCounts();
        applyUiFiltersAndRender();
      });

      const dot = document.createElement("span");
      dot.className = "studio-catalog-comp-domain-dot";
      const rgb = argbIntToRgbTuple(d.couleur);
      if (rgb) dot.style.setProperty("--sb-domain-rgb", rgb.css);

      const text = document.createElement("span");
      text.className = "studio-catalog-comp-check-label";
      text.textContent = d.label;

      label.appendChild(input);
      label.appendChild(dot);
      label.appendChild(text);
      host.appendChild(label);
    });

    refreshFilterCounts();
  }

  function refreshFilterCounts(){
    const domainCount = byId("catCompsDomainCount");
    const domains = domainRowsFromItems();
    if (domainCount) domainCount.textContent = String(_dom.size || domains.length || 0);

    const statusCount = byId("catCompsStatusCount");
    if (statusCount) statusCount.textContent = _onlyPending ? "1" : "0";

    const pendingCard = byId("catCompsKpiToValidate");
    if (pendingCard) pendingCard.setAttribute("aria-pressed", _onlyPending ? "true" : "false");
  }

  function applyUiFiltersAndRender(){
    const selectedDomains = _dom || new Set();
    _items = (_itemsAll || []).filter(it => {
      const domId = (it.domaine || "").toString().trim();
      if (selectedDomains.size > 0 && !selectedDomains.has(domId)) return false;
      if (_onlyPending && !pendingKey(it.etat)) return false;
      return true;
    });
    refreshFilterCounts();
    renderList();
  }

  function updateMetrics(items){
    const rows = Array.isArray(items) ? items : [];
    const activeRows = rows.filter(it => !it.masque);
    const pendingRows = activeRows.filter(it => pendingKey(it.etat));

    const total = byId("catCompsKpiTotal");
    if (total) total.textContent = String(activeRows.length);

    const pending = byId("catCompsKpiPending");
    if (pending) pending.textContent = String(pendingRows.length);
  }

  async function loadMetrics(portal){
    const ownerId = getOwnerId();
    if (!ownerId) return;

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}?q=&show=all`
    );
    updateMetrics((data && data.items) ? data.items : []);
    _metricsLoaded = true;
  }

  function renderDomainBadge(it){
    const domLabel = (it.domaine_titre_court || it.domaine || "").toString().trim();
    const dom = document.createElement("span");
    dom.className = "sb-badge sb-badge--comp-domain studio-catalog-scope";

    const dot = document.createElement("span");
    dot.className = "sb-dot";

    const rgb = argbIntToRgbTuple(it.domaine_couleur);
    if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb.css);

    dom.appendChild(dot);
    dom.appendChild(document.createTextNode(domLabel || "—"));
    return dom;
  }

  function renderList(){
    const host = byId("catCompsList");
    const empty = byId("catCompsEmpty");
    if (!host) return;
    host.innerHTML = "";

    if (empty) empty.style.display = _items.length ? "none" : "";

    if (!_items.length) {
      setStatus("Aucune compétence trouvée.");
      return;
    }

    const table = document.createElement("div");
    table.className = "studio-catalog-comp-table";

    const head = document.createElement("div");
    head.className = "studio-catalog-comp-table-row studio-catalog-comp-table-head";
    ["Compétence", "Domaine", "Actions"].forEach((label, idx) => {
      const cell = document.createElement("div");
      cell.className = `studio-catalog-comp-table-cell${idx === 2 ? " studio-catalog-comp-table-cell--actions" : ""}`;
      cell.textContent = label;
      head.appendChild(cell);
    });
    table.appendChild(head);

    _items.forEach(it => {
      const row = document.createElement("div");
      row.className = "studio-catalog-comp-table-row";
      if (it.masque) row.classList.add("is-archived");
      if (pendingKey(it.etat)) row.classList.add("is-pending");

      const compCell = document.createElement("div");
      compCell.className = "studio-catalog-comp-table-cell studio-catalog-comp-table-cell--competence";

      const code = document.createElement("span");
      code.className = "sb-badge sb-badge--comp studio-catalog-comp-code";
      code.textContent = it.code || "—";

      const titleWrap = document.createElement("div");
      titleWrap.className = "studio-catalog-comp-title-wrap";

      const title = document.createElement("div");
      title.className = "studio-catalog-comp-title";
      title.textContent = it.intitule || "";
      titleWrap.appendChild(title);

      if (pendingKey(it.etat) || it.masque){
        const meta = document.createElement("div");
        meta.className = "studio-catalog-comp-meta";
        meta.textContent = it.masque ? "Archivée" : "À valider";
        titleWrap.appendChild(meta);
      }

      compCell.appendChild(code);
      compCell.appendChild(titleWrap);

      const domainCell = document.createElement("div");
      domainCell.className = "studio-catalog-comp-table-cell studio-catalog-comp-table-cell--domain";
      domainCell.appendChild(renderDomainBadge(it));

      const actionCell = document.createElement("div");
      actionCell.className = "studio-catalog-comp-table-cell studio-catalog-comp-table-cell--actions";

      const actions = document.createElement("div");
      actions.className = "sb-icon-actions";

      if (isSupervisor()) {
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-icon-btn";
        btnEdit.title = "Modifier";
        btnEdit.setAttribute("aria-label", "Modifier la compétence");
        btnEdit.innerHTML = iconSvg("edit");
        btnEdit.addEventListener("click", () => openEdit(window.portal, it));
        actions.appendChild(btnEdit);
      }

      const btnPdf = document.createElement("button");
      btnPdf.type = "button";
      btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
      btnPdf.title = "Exporter la fiche compétence";
      btnPdf.setAttribute("aria-label", "Exporter la fiche compétence");
      btnPdf.innerHTML = iconSvg("pdf");
      btnPdf.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        let popupWin = null;
        try {
          const title = `Fiche compétence - ${it.code || ""} ${it.intitule || ""}`.trim();
          popupWin = openPdfLoadingWindow(title);
          await openSkillSheetPdf(window.portal, it, popupWin);
        } catch (err) {
          try { if (popupWin && !popupWin.closed) popupWin.close(); } catch(_) {}
          window.portal?.showAlert?.("error", err?.message || String(err));
        }
      });
      actions.appendChild(btnPdf);

      if (isSupervisor()) {
        if (!it.masque) {
          const btnArch = document.createElement("button");
          btnArch.type = "button";
          btnArch.className = "sb-icon-btn sb-icon-btn--danger";
          btnArch.title = "Archiver";
          btnArch.setAttribute("aria-label", "Archiver la compétence");
          btnArch.innerHTML = iconSvg("archive");
          btnArch.addEventListener("click", () => openArchive(it));
          actions.appendChild(btnArch);
        } else {
          const arch = document.createElement("span");
          arch.className = "sb-badge sb-badge--poste studio-catalog-archive-badge";
          arch.textContent = "Archivée";
          actions.appendChild(arch);
        }
      }

      actionCell.appendChild(actions);

      row.appendChild(compCell);
      row.appendChild(domainCell);
      row.appendChild(actionCell);
      table.appendChild(row);
    });

    host.appendChild(table);
    const suffix = _items.length > 1 ? "s" : "";
    setStatus(`${_items.length} compétence${suffix} affichée${suffix}.`);
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

    refreshDomainChecks();
    applyUiFiltersAndRender();
    if (!_metricsLoaded) await loadMetrics(portal);
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
            if (draft?.niveaud !== undefined && byId("compNivD")) byId("compNivD").value = String(draft.niveaud || "");
            if (draft?.niveaud !== undefined && byId("compNivD")) byId("compNivD").value = String(draft.niveaud || "");

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
        if (byId("compNivD")) byId("compNivD").value = "";

        await ensureDomains(portal);
        fillAiDomainSelect("");
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
      const code = (it && it.code) ? String(it.code) : "";
      b.textContent = code;
      b.style.display = code ? "" : "none";
    }

    byId("compModalTitle").textContent = (it && it.intitule) ? String(it.intitule) : "Compétence";

    const sub = byId("compModalSub");
    if (sub){ sub.textContent = ""; sub.style.display = "none"; }

    openModal("modalCompEdit");

    await ensureDomains(portal);
    fillDomainSelect((it && it.domaine) ? it.domaine : "");

    const ownerId = getOwnerId();
    const detail = await portal.apiJson(
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`
    );

    loadCritFromJson(detail.grille_evaluation);

    const b2 = byId("compModalBadge");
    if (b2){
      const code = (detail && detail.code) ? String(detail.code) : "";
      b2.textContent = code;
      b2.style.display = code ? "" : "none";
    }

    if (detail && detail.intitule){
      byId("compModalTitle").textContent = String(detail.intitule);
    }

    byId("compIntitule").value = (detail.intitule || "");
    fillDomainSelect(detail.domaine || "");
    byId("compEtat").value = (detail.etat || "valide");
    byId("compDesc").value = (detail.description || "");
    byId("compNivA").value = (detail.niveaua || "");
    byId("compNivB").value = (detail.niveaub || "");
    byId("compNivC").value = (detail.niveauc || "");
    if (byId("compNivD")) byId("compNivD").value = (detail.niveaud || "");
  }

async function save(portal){
    const ownerId = getOwnerId();

    const title = (byId("compIntitule").value || "").trim();
    const dom = (byId("compDomaine").value || "").trim();
    const etat = (byId("compEtat").value || "valide").trim();
    const desc = (byId("compDesc").value || "").trim();
    const nivA = (byId("compNivA").value || "").trim();
    const nivB = (byId("compNivB").value || "").trim();
    const nivC = (byId("compNivC").value || "").trim();
    const nivD = (byId("compNivD")?.value || "").trim();

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
      niveaua: nivA || null,
      niveaub: nivB || null,
      niveauc: nivC || null,
      niveaud: nivD || null,
      grille_evaluation: buildGrilleJson()
    };

    const url = _modalMode === "create"
      ? `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}`
      : `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`;

    if (_modalMode !== "create" && !_editingId) return;

    await portal.apiJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    closeModal("modalCompEdit");
    portal.showAlert("", "");
    await loadMetrics(portal);
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
    await loadMetrics(portal);
    await loadList(portal);
  }

  function toggleFilters(){
    const layout = document.querySelector("#view-catalog_competences .studio-catalog-comp-layout");
    const panel = byId("catCompsFilterPanel");
    const btn = byId("catCompsFiltersToggle");
    if (!layout || !panel || !btn) return;

    const isCollapsed = !layout.classList.contains("is-filters-collapsed");
    layout.classList.toggle("is-filters-collapsed", isCollapsed);
    panel.setAttribute("aria-hidden", isCollapsed ? "true" : "false");
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.setAttribute("title", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
    btn.setAttribute("aria-label", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
  }

  function toggleFilterSection(btn){
    const section = btn && btn.closest(".studio-catalog-comp-filter-accordion");
    if (!section) return;

    const isOpen = !section.classList.contains("is-open");
    section.classList.toggle("is-open", isOpen);
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  function resetFilters(portal){
    const search = byId("catCompsSearch");
    if (search) search.value = "";

    const show = byId("catCompsShow");
    if (show) show.value = "active";

    const pending = byId("catCompsOnlyPending");
    if (pending) pending.checked = false;

    _q = "";
    _show = "active";
    _onlyPending = false;
    _dom = new Set();

    refreshDomainChecks();
    loadList(portal).catch(() => {});
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    if (!isSupervisor()) {
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
    bindMaxLen("compNivD", 230);

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
    s?.addEventListener("input", () => {
      _q = (s.value || "").trim();
      if (_qTimer) clearTimeout(_qTimer);
      _qTimer = setTimeout(() => loadList(portal).catch(() => {}), 250);
    });

    const sh = byId("catCompsShow");
    sh?.addEventListener("change", () => {
      _show = (sh.value || "active").trim();
      _dom = new Set();
      loadList(portal).catch(() => {});
    });

    const pending = byId("catCompsOnlyPending");
    pending?.addEventListener("change", () => {
      _onlyPending = !!pending.checked;
      refreshFilterCounts();
      applyUiFiltersAndRender();
    });

    byId("catCompsResetFilters")?.addEventListener("click", () => resetFilters(portal));
    byId("catCompsFiltersToggle")?.addEventListener("click", toggleFilters);

    byId("catCompsKpiToValidate")?.addEventListener("click", () => {
      const previousShow = _show;
      _onlyPending = !_onlyPending;
      if (_onlyPending){
        _show = "active";
        const show = byId("catCompsShow");
        if (show) show.value = "active";
      }
      const input = byId("catCompsOnlyPending");
      if (input) input.checked = _onlyPending;
      refreshFilterCounts();
      if (_onlyPending && previousShow !== "active") loadList(portal).catch(() => {});
      else applyUiFiltersAndRender();
    });

    document.querySelectorAll('#view-catalog_competences [data-cat-comp-filter-toggle]').forEach(btn => {
      btn.addEventListener("click", () => toggleFilterSection(btn));
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
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) window.portal.showAlert("error", "Erreur catalogue compétences : " + (e?.message || e));
    setStatus("Erreur de chargement.");
  });
})();