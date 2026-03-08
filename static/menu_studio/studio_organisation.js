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

    // --- Poste > Compétences (Exigences)
    let _posteCompItems = [];
    let _posteCompSearch = "";
    let _posteCompSearchTimer = null;

    let _posteCompAddItems = [];
    let _posteCompAddSearch = "";
    let _posteCompAddTimer = null;
    let _posteCompAddIncludeToValidate = false;

    let _posteCompAddDomain = "";
    let _posteCompAddItemsAll = [];

    let _posteCompEdit = null; // objet en cours d'édition (merge comp + assoc)

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
        const u = (n >>> 0);
        const r = (u >> 16) & 255;
        const g = (u >> 8) & 255;
        const b = u & 255;
        return { r, g, b, css: `${r},${g},${b}` };
    }

    function calcCritDisplay(fu, im, de){
        const f = Math.max(0, Math.min(10, parseInt(fu ?? 0, 10) || 0));
        const i = Math.max(0, Math.min(10, parseInt(im ?? 0, 10) || 0));
        const d = Math.max(0, Math.min(10, parseInt(de ?? 0, 10) || 0));
        const f20 = f * 2;
        const i50 = i * 5;
        const d30 = d * 3;
        const total = Math.max(0, Math.min(100, f20 + i50 + d30));
        return { f, i, d, f20, i50, d30, total };
    }

    function rtGetHtml(id){
        const el = byId(id);
        if (!el) return "";
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") return el.value || "";
        return el.innerHTML || "";
    }

    function rtSetHtml(id, html){
        const el = byId(id);
        if (!el) return;
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") el.value = html || "";
        else el.innerHTML = html || "";
    }

    function bindRichtext(id){
        const ed = byId(id);
        if (!ed) return;

        const wrap = ed.closest(".sb-richtext");
        const bar = wrap ? wrap.querySelector(".sb-richtext-bar") : null;
        if (!bar || bar._sbBound) return;

        bar._sbBound = true;

        // Paste propre (évite le HTML Word/Outlook)
        ed.addEventListener("paste", (e) => {
            try{
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
            document.execCommand("insertText", false, text);
            } catch(_){}
        });

        bar.querySelectorAll("[data-cmd]").forEach(btn => {
            btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            ed.focus();
            const cmd = btn.getAttribute("data-cmd");
            if (!cmd) return;
            document.execCommand(cmd, false, null);
            });
        });
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

    // ------------------------------------------------------
    // Poste > Exigences > Contraintes
    // ------------------------------------------------------
    let _posteContraintesInit = false;
    let _nsfGroupesLoaded = false;
    let _nsfGroupes = [];

    function _fillSelect(el, items){
    if (!el) return;
    el.innerHTML = "";
    (items || []).forEach(it => {
        const opt = document.createElement("option");
        opt.value = it.value ?? "";
        opt.textContent = it.text ?? "";
        el.appendChild(opt);
    });
    }

    function _selectByValue(id, v){
    const el = byId(id);
    if (!el) return;
    const val = (v ?? "").toString().trim();
    el.value = val;
    }

    function _setChecked(id, v){
    const el = byId(id);
    if (!el) return;
    el.checked = !!v;
    }

    function _setValue(id, v){
    const el = byId(id);
    if (!el) return;
    el.value = (v ?? "").toString();
    }

    function initPosteContraintesSelects(){
    if (_posteContraintesInit) return;
    _posteContraintesInit = true;

    _fillSelect(byId("posteCtrEduMin"), [
        { value:"",  text:"—" },
        { value:"0", text:"Aucun diplôme" },
        { value:"3", text:"Niveau 3 : CAP, BEP" },
        { value:"4", text:"Niveau 4 : Bac" },
        { value:"5", text:"Niveau 5 : Bac+2 (BTS, DUT)" },
        { value:"6", text:"Niveau 6 : Bac+3 (Licence, BUT)" },
        { value:"7", text:"Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)" },
        { value:"8", text:"Niveau 8 : Bac+8 (Doctorat)" }
    ]);

    _fillSelect(byId("posteCtrMobilite"), [
        { value:"", text:"—" },
        { value:"Aucune", text:"Aucune" },
        { value:"Rare", text:"Rare" },
        { value:"Occasionnelle", text:"Occasionnelle" },
        { value:"Fréquente", text:"Fréquente" }
    ]);

    _fillSelect(byId("posteCtrPerspEvol"), [
        { value:"", text:"—" },
        { value:"Aucune", text:"Aucune" },
        { value:"Faible", text:"Faible" },
        { value:"Modérée", text:"Modérée" },
        { value:"Forte", text:"Forte" },
        { value:"Rapide", text:"Rapide" }
    ]);

    _fillSelect(byId("posteCtrRisquePhys"), [
        { value:"", text:"—" },
        { value:"Aucun", text:"Aucun : pas de risque identifié." },
        { value:"Faible", text:"Faible : exposition occasionnelle, faible intensité." },
        { value:"Modéré", text:"Modéré : exposition régulière mais maîtrisée." },
        { value:"Élevé", text:"Élevé : risque important, pouvant générer une pathologie." },
        { value:"Critique", text:"Critique : risque vital ou accident grave possible." }
    ]);

    _fillSelect(byId("posteCtrNivContrainte"), [
        { value:"", text:"—" },
        { value:"Aucune", text:"Aucune : poste standard, sans pression ni particularité." },
        { value:"Modérée", text:"Modérée : quelques contraintes psychosociales/organisationnelles." },
        { value:"Élevée", text:"Élevée : forte pression, conditions difficiles, grande responsabilité." },
        { value:"Critique", text:"Critique : stress ou responsabilité vitale." }
    ]);

    const bindHelp = (selectId, helpId) => {
        const sel = byId(selectId);
        const help = byId(helpId);
        if (!sel || !help) return;

        const refresh = () => {
        const opt = sel.options[sel.selectedIndex];
        const txt = (opt?.textContent || "").trim();
        if (txt && txt !== "—") {
            help.textContent = txt;
            help.style.display = "";
            sel.title = txt;
        } else {
            help.textContent = "";
            help.style.display = "none";
            sel.title = "";
        }
        };

        sel._sbRefreshHelp = refresh;
        sel.addEventListener("change", refresh);
        refresh();
    };

    bindHelp("posteCtrRisquePhys", "posteCtrRisquePhysHelp");
    bindHelp("posteCtrNivContrainte", "posteCtrNivContrainteHelp");
    }

    async function ensureNsfGroupes(portal){
    if (_nsfGroupesLoaded) return;
    _nsfGroupesLoaded = true;

    try{
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/nsf_groupes/${encodeURIComponent(ownerId)}`;
        const r = await portal.apiJson(url);
        _nsfGroupes = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
    } catch(e){
        // on ne bloque pas le modal pour ça
        _nsfGroupes = [];
    }
    }

    function fillNsfSelect(currentCode){
        const sel = byId("posteCtrNsfGroupe");
        if (!sel) return;

        const code = (currentCode ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_nsfGroupes || []).forEach(g => {
            const c = (g.code ?? "").toString().trim();
            const t = (g.titre ?? "").toString().trim();
            if (!c) return;
            const opt = document.createElement("option");
            opt.value = c;
            opt.textContent = t ? `${t} (${c})` : c;
            sel.appendChild(opt);
        });

        sel.value = code || "";
    }

    function fillPosteContraintesTab(detail){
        initPosteContraintesSelects();

        _selectByValue("posteCtrEduMin", detail?.niveau_education_minimum);
        _setChecked("posteCtrNsfOblig", detail?.nsf_groupe_obligatoire);
        _selectByValue("posteCtrMobilite", detail?.mobilite);
        _selectByValue("posteCtrRisquePhys", detail?.risque_physique);
        _selectByValue("posteCtrPerspEvol", detail?.perspectives_evolution);
        _selectByValue("posteCtrNivContrainte", detail?.niveau_contrainte);
        _setValue("posteCtrDetailContrainte", detail?.detail_contrainte);

        const rSel = byId("posteCtrRisquePhys");
        if (rSel && typeof rSel._sbRefreshHelp === "function") rSel._sbRefreshHelp();

        const nSel = byId("posteCtrNivContrainte");
        if (nSel && typeof nSel._sbRefreshHelp === "function") nSel._sbRefreshHelp();
    }

    // ------------------------------------------------------
    // Poste > Exigences > Compétences
    // ------------------------------------------------------
    async function loadPosteCompetences(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        const data = await portal.apiJson(url);
        _posteCompItems = data.items || [];
        renderPosteCompetences();
    }

    function renderPosteCompetences(){
        const tb = byId("posteCompTbody");
        const empty = byId("posteCompEmpty");
        if (!tb) return;

        const q = (_posteCompSearch || "").toLowerCase();
        const items = (_posteCompItems || []).filter(it => {
        if (!q) return true;
        const s = `${it.code || ""} ${it.intitule || ""}`.toLowerCase();
        return s.includes(q);
        });

        tb.innerHTML = "";

        if (!items.length){
        if (empty) empty.style.display = "";
        return;
        }
        if (empty) empty.style.display = "none";

        items.forEach(it => {
        const tr = document.createElement("tr");

        // Domaine badge
        const tdDom = document.createElement("td");
        const domLabel = (it.domaine_titre_court || it.domaine || "").toString().trim();
        if (domLabel){
            const b = document.createElement("span");
            b.className = "sb-badge sb-badge--comp-domain";
            const dot = document.createElement("span");
            dot.className = "sb-dot";
            const rgb = argbIntToRgbTuple(it.domaine_couleur);
            if (rgb) b.style.setProperty("--sb-domain-rgb", rgb.css);
            b.appendChild(dot);
            b.appendChild(document.createTextNode(domLabel));
            tdDom.appendChild(b);
        } else {
            tdDom.textContent = "—";
        }

        const tdCode = document.createElement("td");
        tdCode.textContent = it.code || "—";

        const tdTit = document.createElement("td");
        tdTit.textContent = it.intitule || "";

        const tdNiv = document.createElement("td");
        tdNiv.style.textAlign = "center";
        const bn = document.createElement("span");
        bn.className = "sb-badge sb-badge--poste-soft";
        bn.textContent = it.niveau_requis || "—";
        tdNiv.appendChild(bn);

        const tdCrit = document.createElement("td");
        tdCrit.style.textAlign = "center";
        tdCrit.textContent = (it.poids_criticite ?? "—");

        const tdInd = document.createElement("td");
        tdInd.style.textAlign = "center";
        if ((it.etat || "").toLowerCase() === "à valider"){
            const b = document.createElement("span");
            b.className = "sb-badge sb-badge--accent-soft";
            b.textContent = "À valider";
            tdInd.appendChild(b);
        } else {
            tdInd.textContent = "—";
        }

        const tdAct = document.createElement("td");
        tdAct.style.textAlign = "right";

        if (isAdmin()){
            const btnEdit = document.createElement("button");
            btnEdit.type = "button";
            btnEdit.className = "sb-btn sb-btn--soft sb-btn--xs";
            btnEdit.textContent = "Modifier";
            btnEdit.addEventListener("click", () => openPosteCompEditModal(it));
            tdAct.appendChild(btnEdit);

            const btnRem = document.createElement("button");
            btnRem.type = "button";
            btnRem.className = "sb-btn sb-btn--soft sb-btn--xs";
            btnRem.textContent = "Retirer";
            btnRem.style.marginLeft = "6px";
            btnRem.addEventListener("click", async () => {
            if (!confirm(`Retirer la compétence "${it.code || ""} – ${it.intitule || ""}" du poste ?`)) return;
            try { await removePosteCompetence(window.portal, it.id_competence); }
            catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });
            tdAct.appendChild(btnRem);
        } else {
            tdAct.textContent = "—";
        }

        tr.appendChild(tdDom);
        tr.appendChild(tdCode);
        tr.appendChild(tdTit);
        tr.appendChild(tdNiv);
        tr.appendChild(tdCrit);
        tr.appendChild(tdInd);
        tr.appendChild(tdAct);

        tb.appendChild(tr);
        });
    }

    function openPosteCompAddModal(){
        if (!isAdmin()) return;
        if (!_editingPosteId) return;

        byId("posteCompAddSearch").value = "";
        _posteCompAddSearch = "";
        byId("posteCompAddList").innerHTML = "";
        const cb = byId("posteCompAddShowToValidate");
        if (cb) cb.checked = false;
        _posteCompAddIncludeToValidate = false;
        byId("posteCompAddDomain")?.addEventListener("change", (e) => {
            _posteCompAddDomain = (e.target.value || "").trim();
            _posteCompAddItems = applyPosteCompAddDomainFilter(_posteCompAddItemsAll);
            renderPosteCompAddList();
        });

        openModal("modalPosteCompAdd");
        loadPosteCompAddList(window.portal).catch(()=>{});
    }

    function refreshPosteCompAddDomainOptions(items){
        const sel = byId("posteCompAddDomain");
        if (!sel) return;

        const keep = (sel.value || "").trim();

        const map = new Map(); // id -> label
        (items || []).forEach(it => {
            const id = (it.domaine || "").toString().trim() || "__none__";
            const label = (it.domaine_titre_court || it.domaine || "").toString().trim() || "Sans domaine";
            if (!map.has(id)) map.set(id, label);
        });

        // reset options
        sel.innerHTML = "";
        sel.appendChild(new Option("Tous", ""));
        sel.appendChild(new Option("Sans domaine", "__none__"));

        Array.from(map.entries())
            .filter(([id]) => id !== "__none__")
            .sort((a,b) => a[1].localeCompare(b[1], "fr", { sensitivity:"base" }))
            .forEach(([id,label]) => sel.appendChild(new Option(label, id)));

        // restore
        if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
        else sel.value = "";
        _posteCompAddDomain = (sel.value || "").trim();
        }

        function applyPosteCompAddDomainFilter(items){
        const dom = (_posteCompAddDomain || "").trim();
        if (!dom) return (items || []).slice();

        if (dom === "__none__"){
            return (items || []).filter(it => !((it.domaine || "").toString().trim()));
        }
        return (items || []).filter(it => ((it.domaine || "").toString().trim() === dom));
    }

    async function loadPosteCompAddList(portal){
        const ownerId = getOwnerId();
        const url =
        `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}` +
        `?q=${encodeURIComponent(_posteCompAddSearch)}` +
        `&show=active`;

        const data = await portal.apiJson(url);
        let items = data.items || [];

        // Filtre etat: active/valide (toujours) + à valider si checkbox
        items = items.filter(it => {
        const et = (it.etat || "").toLowerCase();
        if (et === "active" || et === "valide") return true;
        if (_posteCompAddIncludeToValidate && et === "à valider") return true;
        return false;
        });

        // Exclure déjà rattachées (actives)
        const existing = new Set((_posteCompItems || []).map(x => x.id_competence));
        items = items.filter(it => !existing.has(it.id_comp));

        _posteCompAddItemsAll = items;
        refreshPosteCompAddDomainOptions(_posteCompAddItemsAll);
        _posteCompAddItems = applyPosteCompAddDomainFilter(_posteCompAddItemsAll);
        renderPosteCompAddList();
    }

    function renderPosteCompAddList(){
        const host = byId("posteCompAddList");
        if (!host) return;
        host.innerHTML = "";

        const items = _posteCompAddItems || [];
        if (!items.length){
        const e = document.createElement("div");
        e.className = "card-sub";
        e.textContent = "Aucune compétence à afficher.";
        host.appendChild(e);
        return;
        }

        items.forEach(it => {
        const row = document.createElement("div");
        row.className = "sb-row-card";

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

        if ((it.etat || "").toLowerCase() === "à valider"){
            const v = document.createElement("span");
            v.className = "sb-badge sb-badge--accent-soft";
            v.textContent = "À valider";
            right.appendChild(v);
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sb-btn sb-btn--accent sb-btn--xs";
        btn.textContent = "Ajouter";
        btn.addEventListener("click", () => {
            closeModal("modalPosteCompAdd");
            openPosteCompEditModal({
            id_competence: it.id_comp,
            code: it.code,
            intitule: it.intitule,
            etat: it.etat,
            domaine: it.domaine,
            domaine_titre_court: it.domaine_titre_court,
            domaine_couleur: it.domaine_couleur,

            // valeurs ref (on les charge au besoin via detail)
            niveaua: "",
            niveaub: "",
            niveauc: "",

            // defaults association
            niveau_requis: "B",
            freq_usage: 0,
            impact_resultat: 0,
            dependance: 0,
            poids_criticite: null,
            }, true);
        });

        row.appendChild(left);
        row.appendChild(right);
        row.appendChild(btn);

        host.appendChild(row);
        });
    }

    async function fetchCompetenceDetail(portal, id_comp){
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(id_comp)}`;
        return await portal.apiJson(url);
    }

    function openPosteCompEditModal(it, isNew){
        _posteCompEdit = { ...(it || {}) };
        _posteCompEdit._isNew = !!isNew;

        // Header badge code + titre
        const b = byId("posteCompEditBadge");
        const code = (_posteCompEdit.code || "").toString().trim();
        if (b){
        b.textContent = code;
        b.style.display = code ? "" : "none";
        }
        byId("posteCompEditTitle").textContent = (_posteCompEdit.intitule || "Compétence").toString();

        // Domaine badge
        const dom = byId("posteCompEditDomain");
        const domTxt = byId("posteCompEditDomainTxt");
        const domLabel = (_posteCompEdit.domaine_titre_court || _posteCompEdit.domaine || "").toString().trim();
        if (dom && domTxt){
        if (domLabel){
            domTxt.textContent = domLabel;
            const rgb = argbIntToRgbTuple(_posteCompEdit.domaine_couleur);
            if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb.css);
            dom.style.display = "";
        } else {
            dom.style.display = "none";
        }
        }

        // Ref niveaux (lecture)
        byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "—");
        byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "—");
        byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "—");

        // Form
        byId("posteCompEditNiv").value = (_posteCompEdit.niveau_requis || "B");

        byId("posteCompEditFreq").value = String(_posteCompEdit.freq_usage ?? 0);
        byId("posteCompEditImpact").value = String(_posteCompEdit.impact_resultat ?? 0);
        byId("posteCompEditDep").value = String(_posteCompEdit.dependance ?? 0);

        refreshPosteCompEditCritDisplay();

        openModal("modalPosteCompEdit");

        // Charge le détail compétence si on n'a pas les niveaux A/B/C
        if (!_posteCompEdit.niveaua && _posteCompEdit.id_competence){
        (async () => {
            try{
            const d = await fetchCompetenceDetail(window.portal, _posteCompEdit.id_competence);
            _posteCompEdit.niveaua = d.niveaua || "";
            _posteCompEdit.niveaub = d.niveaub || "";
            _posteCompEdit.niveauc = d.niveauc || "";
            byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "—");
            byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "—");
            byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "—");
            } catch(_){}
        })();
        }
    }

    function refreshPosteCompEditCritDisplay(){
        const fu = parseInt(byId("posteCompEditFreq").value || "0", 10) || 0;
        const im = parseInt(byId("posteCompEditImpact").value || "0", 10) || 0;
        const de = parseInt(byId("posteCompEditDep").value || "0", 10) || 0;

        const d = calcCritDisplay(fu, im, de);

        byId("posteCompEditFreqTxt").textContent = `${d.f}/10 → ${d.f20}/20`;
        byId("posteCompEditImpactTxt").textContent = `${d.i}/10 → ${d.i50}/50`;
        byId("posteCompEditDepTxt").textContent = `${d.d}/10 → ${d.d30}/30`;

        const cur = (_posteCompEdit && _posteCompEdit.poids_criticite != null) ? _posteCompEdit.poids_criticite : "—";
        byId("posteCompEditCrit").textContent = `Prévision: ${d.total}/100 (actuel: ${cur})`;
    }

    async function savePosteCompEdit(portal){
        if (!_editingPosteId || !_posteCompEdit) return;

        const ownerId = getOwnerId();

        const niv = (byId("posteCompEditNiv").value || "B").trim().toUpperCase();
        const fu = parseInt(byId("posteCompEditFreq").value || "0", 10) || 0;
        const im = parseInt(byId("posteCompEditImpact").value || "0", 10) || 0;
        const de = parseInt(byId("posteCompEditDep").value || "0", 10) || 0;

        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
            id_competence: _posteCompEdit.id_competence,
            niveau_requis: niv,
            freq_usage: fu,
            impact_resultat: im,
            dependance: de
        })
        });

        closeModal("modalPosteCompEdit");
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    async function removePosteCompetence(portal, id_comp){
        if (!_editingPosteId) return;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_comp)}/remove`;
        await portal.apiJson(url, { method: "POST" });
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    const _posteDetailCache = new Map(); // id_poste -> detail

    async function fetchPosteDetail(portal, id_poste){
        const pid = (id_poste || "").toString().trim();
        if (!pid) return null;

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

        
        byId("posteCodifClient").value = "";
        byId("posteIntitule").value = "";
        byId("posteMission").value = "";
        rtSetHtml("posteResp", "");

        // boutons (actions API à l'étape 2)
        const bA = byId("btnPosteArchive");
        const bD = byId("btnPosteDuplicate");
        if (bA){ bA.disabled = true; bA.style.opacity = ".6"; bA.title = "Disponible après création."; }
        if (bD){ bD.disabled = true; bD.style.opacity = ".6"; bD.title = "Disponible après création."; }

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Créer";

        fillPosteContraintesTab({});
        (async () => {
        try{
            await ensureNsfGroupes(portal);
            fillNsfSelect("");
        } catch(_){}
        })();

        setPosteTab("def");
        openModal("modalPoste");
    }

    function openEditPosteModal(portal, p){
        _posteModalMode = "edit";
        const pid = (p && p.id_poste) ? String(p.id_poste).trim() : "";
        if (!pid) return;

        _posteModalMode = "edit";
        _editingPosteId = pid;

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");

        byId("posteModalTitle").textContent =
            (p && (p.intitule_poste || p.intitule)) ? String(p.intitule_poste || p.intitule) : "Poste";
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

        // Charge le détail (définition + exigences/contraintes)
        (async () => {
        try{
            const d = await fetchPosteDetail(portal, _editingPosteId);
            if (!d) return;

            await ensureNsfGroupes(portal);
            fillNsfSelect(d?.nsf_groupe_code || "");
            fillPosteContraintesTab(d);
            await loadPosteCompetences(portal);

            // --- Définition (remplissage robuste: si champ supprimé, pas d'erreur)
            const elCodCli = byId("posteCodifClient"); if (elCodCli) elCodCli.value = (d.codif_client || "");
            const elInt = byId("posteIntitule"); if (elInt) elInt.value = (d.intitule_poste || "");
            const elMis = byId("posteMission"); if (elMis) elMis.value = (d.mission_principale || "");

            // Responsabilités: richtext si présent, sinon textarea
            if (typeof rtSetHtml === "function") rtSetHtml("posteResp", d.responsabilites || "");
            else { const elResp = byId("posteResp"); if (elResp) elResp.value = (d.responsabilites || ""); }

            // --- Exigences > Contraintes (les fonctions seront ajoutées/existent déjà chez toi)
            if (typeof ensureNsfGroupes === "function") {
            await ensureNsfGroupes(portal);
            if (typeof fillNsfSelect === "function") fillNsfSelect(d?.nsf_groupe_code || "");
            }
            if (typeof fillPosteContraintesTab === "function") fillPosteContraintesTab(d);

            // Actif / buttons
            if (typeof setPosteModalActif === "function") setPosteModalActif(!!d.actif);

            const bD = byId("btnPosteDuplicate");
            if (bD){ bD.disabled = false; bD.style.opacity = ""; bD.title = ""; }

        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        }
        })();
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
        const codc = (byId("posteCodifClient")?.value || "").trim();
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const resp = rtGetHtml("posteResp").trim();

        if (!sid){
            portal.showAlert("error", "Sélectionne un service.");
            return;
        }
        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return;
        }

        const payload = {
            id_service: sid,            
            codif_client: (codc || null),
            intitule_poste: title,
            mission_principale: (mission || null),
            responsabilites: (resp || null),
            niveau_education_minimum: (byId("posteCtrEduMin")?.value || "").trim() || null,
            nsf_groupe_code: (byId("posteCtrNsfGroupe")?.value || "").trim() || null,
            nsf_groupe_obligatoire: !!byId("posteCtrNsfOblig")?.checked,
            mobilite: (byId("posteCtrMobilite")?.value || "").trim() || null,
            risque_physique: (byId("posteCtrRisquePhys")?.value || "").trim() || null,
            perspectives_evolution: (byId("posteCtrPerspEvol")?.value || "").trim() || null,
            niveau_contrainte: (byId("posteCtrNivContrainte")?.value || "").trim() || null,
            detail_contrainte: (byId("posteCtrDetailContrainte")?.value || "").trim() || null,
        };

        if (_posteModalMode === "create"){
            // create
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            
            // refresh + fermeture modal
            await loadServices(portal);
            await loadPostes(portal);

            setStatus("Poste créé.");
            closePosteModal();

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
            closePosteModal();
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
        code.className = "sb-badge sb-badge--comp";
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

        const pcs = byId("posteCompSearch");
        if (pcs){
          pcs.addEventListener("input", () => {
            _posteCompSearch = (pcs.value || "").trim();
            if (_posteCompSearchTimer) clearTimeout(_posteCompSearchTimer);
            _posteCompSearchTimer = setTimeout(() => renderPosteCompetences(), 200);
          });
        }

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
        byId("btnClosePoste")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePosteModal();
        });

        byId("btnPosteCancel")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePosteModal();
        });

        bindRichtext("posteResp");

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

                byId("btnPosteCompAdd")?.addEventListener("click", () => {
          try { openPosteCompAddModal(); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        // Modal Add
        byId("btnClosePosteCompAdd")?.addEventListener("click", () => closeModal("modalPosteCompAdd"));
        const cas = byId("posteCompAddSearch");
        if (cas){
          cas.addEventListener("input", () => {
            _posteCompAddSearch = (cas.value || "").trim();
            if (_posteCompAddTimer) clearTimeout(_posteCompAddTimer);
            _posteCompAddTimer = setTimeout(() => loadPosteCompAddList(portal).catch(()=>{}), 250);
          });
        }
        byId("posteCompAddShowToValidate")?.addEventListener("change", (e) => {
          _posteCompAddIncludeToValidate = !!e.target.checked;
          loadPosteCompAddList(portal).catch(()=>{});
        });

        // Modal Edit
        byId("btnClosePosteCompEdit")?.addEventListener("click", () => closeModal("modalPosteCompEdit"));
        byId("btnPosteCompEditCancel")?.addEventListener("click", () => closeModal("modalPosteCompEdit"));
        byId("btnPosteCompEditSave")?.addEventListener("click", async () => {
          try { await savePosteCompEdit(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("posteCompEditFreq")?.addEventListener("input", refreshPosteCompEditCritDisplay);
        byId("posteCompEditImpact")?.addEventListener("input", refreshPosteCompEditCritDisplay);
        byId("posteCompEditDep")?.addEventListener("input", refreshPosteCompEditCritDisplay);
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