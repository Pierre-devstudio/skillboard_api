(function () {
  let _bound = false;
  let _q = "";
  let _show = "active";
  let _dom = "";
  let _qTimer = null;

  let _items = [];
  let _refs = null;

  let _roleCode = "user";
  let _canEdit = false;

  let _modalMode = "create";
  let _editingId = null;
  let _archiveId = null;
  let _activeTab = "identite";

  let _selectedModalites = [];
  let _selectedPeda = [];
  let _selectedEval = [];
  let _selectedCompStag = [];
  let _selectedCompForm = [];
  let _prerequis = [];
  let _compPickerTarget = "stagiaire";
  let _compPickerSelected = new Set();
  let _compPickerSearch = "";
  let _compPickerDomain = "";

  let _detailContenus = [];
  let _contentEditId = null;
  let _contentCompetenceIds = [];
  let _dragContentId = null;

  let _detailPlans = [];
  let _importDraft = null;
  let _aiGenerationDraft = null;
  let _aiAbortController = null;
  let _aiLongTimer = null;
  let _pendingImportContenus = [];
  let _pendingCompStagCreate = [];
  let _pendingCompFormCreate = [];

  let _planMode = "create";
  let _planEditId = null;
  let _planBlocks = [];
  let _planContentSearch = "";
  let _planDragContentId = null;
  let _planDragBlockId = null;
  let _planDragSeq = null;

  function byId(id){ return document.getElementById(id); }

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

    function getErrorMessage(err){
        if (!err) return "Erreur inconnue.";

        if (typeof err === "string") return err;

        if (err.message && typeof err.message === "string" && err.message !== "[object Object]"){
            return err.message;
        }

        if (err.detail){
            if (typeof err.detail === "string") return err.detail;

            if (Array.isArray(err.detail)){
            return err.detail.map(x => {
                if (typeof x === "string") return x;

                const loc = Array.isArray(x.loc) ? x.loc.join(" > ") : "";
                const msg = x.msg || x.message || "";
                return [loc, msg].filter(Boolean).join(" : ");
            }).filter(Boolean).join("\n") || "Erreur de validation.";
            }

            try{
            return JSON.stringify(err.detail, null, 2);
            } catch(_){}
        }

        if (err.error){
            if (typeof err.error === "string") return err.error;

            try{
            return JSON.stringify(err.error, null, 2);
            } catch(_){}
        }

        try{
            const txt = JSON.stringify(err, null, 2);
            if (txt && txt !== "{}") return txt;
        } catch(_){}

        return "Erreur inconnue.";
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

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

    function setSuccess(msg){
        const el = byId("formModalSuccess");
        if (!el) return;

        window.clearTimeout(el._hideTimer);

        if (!msg){
            el.style.display = "none";
            el.textContent = "";
            return;
        }

        el.textContent = msg;
        el.style.display = "inline-flex";

        el._hideTimer = window.setTimeout(() => {
            el.style.display = "none";
            el.textContent = "";
        }, 5000);
    }

    function iconHtml(){
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16v16H4z"/>
            <path d="M8 9l-3 3 3 3"/>
            <path d="M16 9l3 3-3 3"/>
            <path d="M14 7l-4 10"/>
            </svg>
        `;
    }

    function iconPdf(){
        return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
            <path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-3z"/>
            <path d="M13 13v3"/>
            <path d="M13 13h3"/>
            <path d="M16 13v3"/>
        </svg>
        `;
    }

  function iconEdit(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    `;
  }

  function iconTrash(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"/>
        <path d="M8 6V4h8v2"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
      </svg>
    `;
  }

    function iconDoubleUp(){
    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M7 14l5-5 5 5"/>
        <path d="M7 20l5-5 5 5"/>
        </svg>
    `;
    }

    function iconDoubleDown(){
    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M7 4l5 5 5-5"/>
        <path d="M7 10l5 5 5-5"/>
        </svg>
    `;
    }

  async function ensureContext(portal){
    const effectifId = getEffectifId();
    if (!effectifId) throw new Error("Profil Learn manquant (?id=...).");

    const ctx = await portal.apiJson(`${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/context`);

    _roleCode = (ctx?.role_code || "user").toString().trim().toLowerCase();
    if (!["admin", "supervisor", "user"].includes(_roleCode)) _roleCode = "user";

    _canEdit = !!ctx?.can_edit || roleRank(_roleCode) >= 2;
  }

  async function ensureRefs(portal){
    if (_refs) return _refs;

    const effectifId = getEffectifId();
    _refs = await portal.apiJson(`${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/referentiels`);

    _refs.domaines = Array.isArray(_refs.domaines) ? _refs.domaines : [];
    _refs.fournisseurs = Array.isArray(_refs.fournisseurs) ? _refs.fournisseurs : [];
    _refs.modalites = Array.isArray(_refs.modalites) ? _refs.modalites : [];
    _refs.methodes_peda = Array.isArray(_refs.methodes_peda) ? _refs.methodes_peda : [];
    _refs.methodes_eval = Array.isArray(_refs.methodes_eval) ? _refs.methodes_eval : [];
    _refs.competences = Array.isArray(_refs.competences) ? _refs.competences : [];

    fillRefSelects();

    return _refs;
  }

  function fillRefSelects(){
    const domList = _refs?.domaines || [];

    ["catFormsDomain", "formDomaine"].forEach(id => {
      const sel = byId(id);
      if (!sel) return;

      const keep = sel.value || "";
      sel.innerHTML = "";

      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = id === "catFormsDomain" ? "Tous" : "—";
      sel.appendChild(opt0);

      domList.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.id_domaine_formation || "";
        opt.textContent = d.titre || d.titre_court || opt.value;
        sel.appendChild(opt);
      });

      sel.value = keep || "";
    });

    const fSel = byId("formFournisseur");
    if (fSel){
      const keep = fSel.value || "";
      fSel.innerHTML = `<option value="">—</option>`;

      (_refs?.fournisseurs || []).forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.id_fourn || "";
        opt.textContent = f.nom || f.code || opt.value;
        fSel.appendChild(opt);
      });

      fSel.value = keep || "";
    }
  }

    function normalizeTypeFormation(value){
        const v = String(value || "").trim().toLowerCase();

        if (v === "certifiante") return "Certifiante";
        if (v === "diplomante" || v === "diplômante") return "Diplomante";
        if (
            v === "non certifiante" ||
            v === "non-certifiante" ||
            v === "non certifiant" ||
            v === "non-certifiant"
        ) {
            return "Non Certifiante";
        }

        return "Non Certifiante";
    }

    function syncObsTypeFormation(){
        const type = normalizeTypeFormation(byId("formType")?.value || "");
        const row = byId("formObsTypeRow");
        const label = byId("formObsTypeLabel");
        const input = byId("formObsType");

        if (!row) return;

        const needsObs = type === "Certifiante" || type === "Diplomante";

        row.style.display = needsObs ? "" : "none";

        if (label){
        label.textContent = type === "Certifiante"
            ? "Certification RNCP ou RS"
            : "Niveau reconnu par l’État";
        }

        if (input){
        input.placeholder = type === "Certifiante"
            ? "Ex : RNCPXXXXX, RSXXXX, intitulé de la certification…"
            : "Ex : Niveau 5, titre reconnu par l’État, diplôme visé…";

        if (!needsObs) input.value = "";
        }
    }

    function syncFormModeActions(){
        const isCreate = _modalMode === "create";

        const btnImport = byId("btnFormImport");
        const btnGenerate = byId("btnFormGenerateAi");
        const btnReview = byId("btnFormAiReview");

        if (btnImport) btnImport.style.display = isCreate ? "" : "none";
        if (btnGenerate) btnGenerate.style.display = isCreate ? "" : "none";
        if (btnReview) btnReview.style.display = isCreate ? "none" : "";
    }

  function setTab(tab){
    _activeTab = tab || "identite";

    document.querySelectorAll("#formTabs .sb-form-tab").forEach(btn => {
      btn.classList.toggle("is-active", btn.dataset.tab === _activeTab);
    });

    document.querySelectorAll("#modalFormEdit .sb-form-panel").forEach(p => {
      p.classList.toggle("is-active", p.dataset.panel === _activeTab);
    });

    const order = ["identite", "modalites", "competences", "contenu", "plans"];
    const idx = order.indexOf(_activeTab);

    const prev = byId("btnFormPrev");
    const next = byId("btnFormNext");

    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx >= order.length - 1;
  }

  function nextTab(){
    const order = ["identite", "modalites", "competences", "contenu", "plans"];
    const idx = Math.max(0, order.indexOf(_activeTab));
    setTab(order[Math.min(order.length - 1, idx + 1)]);
  }

  function prevTab(){
    const order = ["identite", "modalites", "competences", "contenu", "plans"];
    const idx = Math.max(0, order.indexOf(_activeTab));
    setTab(order[Math.max(0, idx - 1)]);
  }

  function toggleIn(arr, id, checked){
    const v = String(id || "").trim();
    if (!v) return arr;

    const clean = arr.filter(x => x !== v);
    if (checked) clean.push(v);

    return clean;
  }

  function renderCheckGrid(hostId, rows, idKey, selected, onChange){
    const host = byId(hostId);
    if (!host) return;

    host.innerHTML = "";

    rows.forEach(r => {
      const id = String(r[idKey] || "").trim();
      if (!id) return;

      const label = r.titre || r.titre_court || id;

      const item = document.createElement("label");
      item.className = "lf-check-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.includes(id);
      cb.addEventListener("change", () => onChange(id, cb.checked));

      const span = document.createElement("span");
      span.textContent = label;

      item.appendChild(cb);
      item.appendChild(span);

      host.appendChild(item);
    });

    if (!host.children.length){
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucun élément disponible.";
      host.appendChild(empty);
    }
  }

  function renderRefChecks(){
    renderCheckGrid(
      "formModalitesList",
      _refs?.modalites || [],
      "id_mod_form",
      _selectedModalites,
      (id, checked) => { _selectedModalites = toggleIn(_selectedModalites, id, checked); }
    );

    renderCheckGrid(
      "formPedaList",
      _refs?.methodes_peda || [],
      "id_met_peda",
      _selectedPeda,
      (id, checked) => { _selectedPeda = toggleIn(_selectedPeda, id, checked); }
    );

    renderCheckGrid(
      "formEvalList",
      _refs?.methodes_eval || [],
      "id_met_eval",
      _selectedEval,
      (id, checked) => { _selectedEval = toggleIn(_selectedEval, id, checked); }
    );
  }

    function findCompetence(id){
    const cid = String(id || "").trim();
    if (!cid) return null;

    return (_refs?.competences || []).find(c => String(c.id_comp || "").trim() === cid) || null;
    }

    function makeDomainBadge(c){
    const label = (c?.domaine_titre_court || c?.domaine_titre || "").toString().trim();
    if (!label) return null;

    const dom = document.createElement("span");
    dom.className = "sb-badge sb-badge--comp-domain";

    const rgb = argbIntToRgbTuple(c?.domaine_couleur);
    if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb.css);

    const dot = document.createElement("span");
    dot.className = "sb-dot";

    dom.appendChild(dot);
    dom.appendChild(document.createTextNode(label));

    return dom;
    }

    function renderSelectedCompetenceList(hostId, selected, target){
        const host = byId(hostId);
        if (!host) return;

        host.innerHTML = "";

        const ids = Array.isArray(selected) ? selected : [];
        const rows = ids
            .map(id => findCompetence(id))
            .filter(Boolean);

        const pending = target === "stagiaire"
            ? (_pendingCompStagCreate || [])
            : (_pendingCompFormCreate || []);

        if (!rows.length && !pending.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucune compétence affectée.";
            host.appendChild(empty);
            return;
        }

        rows.forEach(c => {
            const row = document.createElement("div");
            row.className = "sb-row-card lf-comp-selected-row";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = c.code || "—";

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = c.intitule || "";

            left.appendChild(code);
            left.appendChild(title);

            const right = document.createElement("div");
            right.className = "sb-row-right";

            const domBadge = makeDomainBadge(c);
            if (domBadge) right.appendChild(domBadge);

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

            try{
                await openCompetencePdfFromFormation(c);
            } catch(err){
                window.portal.showAlert("error", getErrorMessage(err));
            }
            });

            actions.appendChild(btnPdf);

            const btnRemove = document.createElement("button");
            btnRemove.type = "button";
            btnRemove.className = "sb-icon-btn sb-icon-btn--danger";
            btnRemove.title = "Retirer";
            btnRemove.setAttribute("aria-label", "Retirer");
            btnRemove.innerHTML = iconTrash();
            btnRemove.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const id = String(c.id_comp || "").trim();

            if (target === "stagiaire"){
                _selectedCompStag = _selectedCompStag.filter(x => x !== id);
            } else {
                _selectedCompForm = _selectedCompForm.filter(x => x !== id);
            }

            renderCompetences();
            });

            actions.appendChild(btnRemove);
            right.appendChild(actions);

            row.appendChild(left);
            row.appendChild(right);

            host.appendChild(row);
        });

        pending.forEach((p, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card lf-comp-selected-row lf-comp-proposal-row";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const badge = document.createElement("span");
            badge.className = "sb-badge sb-badge--state";
            badge.textContent = "À créer";

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = p.source || "";

            left.appendChild(badge);
            left.appendChild(title);

            const right = document.createElement("div");
            right.className = "sb-row-right";

            const hint = document.createElement("span");
            hint.className = "card-sub lf-comp-proposal-hint";
            hint.textContent = "Proposition issue de l’import";

            const actions = document.createElement("div");
            actions.className = "sb-icon-actions";

            const btnRemove = document.createElement("button");
            btnRemove.type = "button";
            btnRemove.className = "sb-icon-btn sb-icon-btn--danger";
            btnRemove.title = "Retirer";
            btnRemove.setAttribute("aria-label", "Retirer");
            btnRemove.innerHTML = iconTrash();
            btnRemove.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (target === "stagiaire"){
                _pendingCompStagCreate.splice(idx, 1);
            } else {
                _pendingCompFormCreate.splice(idx, 1);
            }

            renderCompetences();
            });

            actions.appendChild(btnRemove);

            right.appendChild(hint);
            right.appendChild(actions);

            row.appendChild(left);
            row.appendChild(right);

            host.appendChild(row);
        });
    }

    function renderCompetences(){
        renderSelectedCompetenceList("formCompStagSelected", _selectedCompStag, "stagiaire");
        renderSelectedCompetenceList("formCompFormSelected", _selectedCompForm, "formateur");
    }

    function defaultPrereq(){
        return {
            id_prerequis: null,
            titre: "",
            r1: "Oui",
            r2: "Non",
            r3: "",
            ordre_affichage: (_prerequis.length || 0) + 1
        };
    }

  function normalizePrerequis(rows){
    const arr = Array.isArray(rows) ? rows : [];

    _prerequis = arr.map((p, idx) => ({
      id_prerequis: p.id_prerequis || null,
      titre: p.titre || "",
      r1: p.r1 || "Je ne maîtrise pas",
      r2: p.r2 || "J’ai besoin d’assistance",
      r3: p.r3 || "",
      ordre_affichage: p.ordre_affichage || (idx + 1)
    }));
  }

  function renderPrerequis(){
    const host = byId("formPrereqList");
    if (!host) return;

    host.innerHTML = "";

    if (!_prerequis.length){
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucun prérequis évaluables ajouté.";
      host.appendChild(empty);
      return;
    }

    _prerequis.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "lf-prereq-card";

      card.innerHTML = `
        <div class="lf-prereq-card-head">
          <div class="lf-prereq-title">Prérequis ${idx + 1}</div>
          <button type="button" class="sb-icon-btn sb-icon-btn--danger" title="Retirer" aria-label="Retirer">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18"/>
              <path d="M8 6V4h8v2"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/>
              <path d="M14 11v6"/>
            </svg>
          </button>
        </div>

        <div class="row">
          <div class="info-item" style="flex:1; min-width:260px;">
            <div class="label">Libellé du prérequis</div>
            <input type="text" class="lf-prereq-input" data-field="titre" value="${htmlEsc(p.titre || "")}" />
          </div>
        </div>

        <div class="lf-prereq-responses">
          <div class="info-item">
            <div class="label">Réponse 1</div>
            <input type="text" class="lf-prereq-input" data-field="r1" value="${htmlEsc(p.r1 || "")}" />
          </div>
          <div class="info-item">
            <div class="label">Réponse 2</div>
            <input type="text" class="lf-prereq-input" data-field="r2" value="${htmlEsc(p.r2 || "")}" />
          </div>
          <div class="info-item">
            <div class="label">Réponse 3 <span class="lf-label-muted">(optionnelle)</span></div>
            <input type="text" class="lf-prereq-input" data-field="r3" value="${htmlEsc(p.r3 || "")}" />
          </div>
        </div>
      `;

      card.querySelectorAll(".lf-prereq-input").forEach(inp => {
        inp.addEventListener("input", () => {
          const field = inp.dataset.field;
          _prerequis[idx][field] = inp.value || "";
        });
      });

      const btnRemove = card.querySelector(".sb-icon-btn--danger");
      btnRemove?.addEventListener("click", () => {
        _prerequis.splice(idx, 1);
        _prerequis.forEach((x, i) => x.ordre_affichage = i + 1);
        renderPrerequis();
      });

      host.appendChild(card);
    });
  }

  function addPrerequis(){
    _prerequis.push(defaultPrereq());
    renderPrerequis();
  }

  function buildPrerequisPayload(){
    return (_prerequis || [])
      .map((p, idx) => ({
        id_prerequis: p.id_prerequis || null,
        titre: (p.titre || "").trim(),
        r1: (p.r1 || "").trim() || "Je ne maîtrise pas",
        r2: (p.r2 || "").trim() || "J’ai besoin d’assistance",
        r3: (p.r3 || "").trim(),
        ordre_affichage: idx + 1
      }))
      .filter(p => p.titre);
  }

    function fillCompPickerDomainSelect(){
        const sel = byId("formCompPickerDomain");
        if (!sel) return;

        const keep = sel.value || "";
        const map = new Map();

        (_refs?.competences || []).forEach(c => {
            const id = String(c.domaine || "").trim();
            if (!id) return;

            const label = (c.domaine_titre_court || c.domaine_titre || id).toString().trim();
            if (!label) return;

            if (!map.has(id)) {
            map.set(id, label);
            }
        });

        sel.innerHTML = "";

        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "Tous";
        sel.appendChild(opt0);

        Array.from(map.entries())
            .sort((a, b) => a[1].localeCompare(b[1], "fr", { sensitivity:"base" }))
            .forEach(([id, label]) => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = label;
            sel.appendChild(opt);
            });

        sel.value = keep && map.has(keep) ? keep : "";
        _compPickerDomain = sel.value || "";
        }

        function currentPickerIds(){
        return _compPickerTarget === "stagiaire" ? _selectedCompStag : _selectedCompForm;
        }

        function renderCompPickerList(){
        const host = byId("formCompPickerList");
        if (!host) return;

        const already = new Set(currentPickerIds().map(x => String(x || "").trim()).filter(Boolean));
        const q = (_compPickerSearch || "").trim().toLowerCase();
        const dom = (_compPickerDomain || "").trim();

        const rows = (_refs?.competences || []).filter(c => {
            if (dom && String(c.domaine || "").trim() !== dom) return false;

            if (!q) return true;

            return [
            c.code || "",
            c.intitule || "",
            c.domaine_titre_court || "",
            c.domaine_titre || ""
            ].join(" ").toLowerCase().includes(q);
        });

        host.innerHTML = "";

        if (!rows.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucune compétence trouvée.";
            host.appendChild(empty);
            return;
        }

        rows.forEach(c => {
            const id = String(c.id_comp || "").trim();
            if (!id) return;

            const isAlready = already.has(id);

            const row = document.createElement("div");
            row.className = "lf-comp-picker-row";
            if (isAlready) row.classList.add("is-already-selected");

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = isAlready || _compPickerSelected.has(id);
            cb.disabled = isAlready;
            cb.title = isAlready ? "Déjà affectée" : "";

            cb.addEventListener("change", () => {
            if (cb.checked) _compPickerSelected.add(id);
            else _compPickerSelected.delete(id);
            });

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = c.code || "—";

            const title = document.createElement("div");
            title.className = "lf-comp-picker-title";
            title.textContent = c.intitule || "";

            const spacer = document.createElement("div");
            spacer.className = "lf-comp-picker-spacer";

            const btnPdf = document.createElement("button");
            btnPdf.type = "button";
            btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
            btnPdf.title = "Voir PDF";
            btnPdf.setAttribute("aria-label", "Voir PDF");
            btnPdf.innerHTML = iconPdf();
            btnPdf.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            try{
                await openCompetencePdfFromFormation(c);
            } catch(err){
                window.portal.showAlert("error", err?.message || String(err));
            }
            });

            row.appendChild(cb);
            row.appendChild(code);
            row.appendChild(title);
            row.appendChild(spacer);
            row.appendChild(btnPdf);

            host.appendChild(row);
        });
        }

        async function openCompPicker(target){
        if (!isSupervisor()) return;

        await ensureRefs(window.portal);

        _compPickerTarget = target === "formateur" ? "formateur" : "stagiaire";
        _compPickerSelected = new Set();
        _compPickerSearch = "";
        _compPickerDomain = "";

        const title = byId("formCompPickerTitle");
        const sub = byId("formCompPickerSub");

        if (title){
            title.textContent = _compPickerTarget === "formateur"
            ? "Ajouter des compétences requises pour le formateur"
            : "Ajouter des compétences visées pour les stagiaires";
        }

        if (sub){
            sub.textContent = _compPickerTarget === "formateur"
            ? "Sélectionnez les compétences attendues pour animer cette formation."
            : "Sélectionnez les compétences que cette formation doit permettre d’acquérir ou de renforcer.";
        }

        const search = byId("formCompPickerSearch");
        if (search) search.value = "";

        fillCompPickerDomainSelect();
        renderCompPickerList();

        openModal("modalFormCompPicker");
        }

        function closeCompPicker(){
        closeModal("modalFormCompPicker");
        _compPickerSelected = new Set();
        }

        function applyCompPickerSelection(){
        const ids = Array.from(_compPickerSelected).filter(Boolean);

        if (_compPickerTarget === "formateur"){
            const set = new Set(_selectedCompForm);
            ids.forEach(id => set.add(id));
            _selectedCompForm = Array.from(set);
        } else {
            const set = new Set(_selectedCompStag);
            ids.forEach(id => set.add(id));
            _selectedCompStag = Array.from(set);
        }

        closeCompPicker();
        renderCompetences();
    }

function getContentCompIds(l){
  if (!l) return [];

  const ids = Array.isArray(l.competences_liees_ids)
    ? l.competences_liees_ids
    : [];

  if (ids.length) return ids.map(x => String(x || "").trim()).filter(Boolean);

  if (l.id_competence) return [String(l.id_competence).trim()].filter(Boolean);

  return [];
}

function renderContentCompBadges(l){
  const items = Array.isArray(l?.competences_liees_items)
    ? l.competences_liees_items
    : [];

  if (!items.length) {
    return `<span class="card-sub" style="margin:0;">Aucune compétence liée</span>`;
  }

  return items.map(c => `
    <span class="sb-badge sb-badge--comp lf-content-comp-badge" title="${htmlEsc(c.intitule || "")}">
      ${htmlEsc(c.code || "—")}
    </span>
  `).join("");
}

    function renderContenus(){
        const host = byId("formContenusList");
        if (!host) return;

        host.innerHTML = "";

        if (!_editingId){
        if (_pendingImportContenus.length){
            _pendingImportContenus.forEach((l, idx) => {
            const div = document.createElement("div");
            div.className = "lf-content-card lf-content-card--pending";

            const compItems = (l.competences_liees || [])
                .map(id => findCompetence(id))
                .filter(Boolean);

            const badges = compItems.length
                ? compItems.map(c => `
                    <span class="sb-badge sb-badge--comp lf-content-comp-badge" title="${htmlEsc(c.intitule || "")}">
                    ${htmlEsc(c.code || "—")}
                    </span>
                `).join("")
                : `<span class="card-sub" style="margin:0;">Compétences à confirmer</span>`;

            div.innerHTML = `
                <div class="lf-content-main">
                <div class="lf-mini-title">${htmlEsc(l.titre_sequence || `Contenu ${idx + 1}`)}</div>
                <div class="card-sub">${htmlEsc(l.objectif || "")}</div>
                <div class="lf-mini-body">${htmlEsc(l.contenu || "—").replaceAll("\n", "<br>")}</div>
                </div>

                <div class="lf-content-side">
                <div class="lf-content-comp-badges">${badges}</div>
                <span class="sb-badge sb-badge--state">En attente d’enregistrement</span>
                </div>
            `;

            host.appendChild(div);
            });

            return;
        }

        host.innerHTML = `<div class="card-sub">Enregistrez d’abord la fiche formation avant d’ajouter du contenu structuré.</div>`;
        return;
        }

        if (!_detailContenus.length){
            host.innerHTML = `<div class="card-sub">Aucun contenu détaillé n’est encore rattaché à cette formation.</div>`;
            return;
        }

        _detailContenus.forEach(l => {
            const div = document.createElement("div");
            div.className = "lf-content-card";
            div.draggable = true;
            div.dataset.id = l.id_ligne_contenu || "";

            div.innerHTML = `
            <div class="lf-content-main">
                <div class="lf-mini-title">${htmlEsc(l.titre_sequence || "Séquence")}</div>
                <div class="card-sub">${htmlEsc(l.objectif || "")}</div>
                <div class="lf-mini-body">${htmlEsc(l.contenu || "—").replaceAll("\n", "<br>")}</div>
            </div>

            <div class="lf-content-side">
                <div class="lf-content-comp-badges">
                ${renderContentCompBadges(l)}
                </div>

                <div class="sb-icon-actions">
                <button type="button" class="sb-icon-btn" data-action="edit" title="Modifier" aria-label="Modifier">
                    ${iconEdit()}
                </button>
                <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-action="remove" title="Retirer" aria-label="Retirer">
                    ${iconTrash()}
                </button>
                </div>
            </div>
            `;

            div.querySelector('[data-action="edit"]')?.addEventListener("click", () => openContentModal(l));
            div.querySelector('[data-action="remove"]')?.addEventListener("click", () => archiveContent(l));

            div.addEventListener("dragstart", (e) => {
            _dragContentId = div.dataset.id || "";
            div.classList.add("is-dragging");

            if (e.dataTransfer){
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", _dragContentId);
            }
            });

            div.addEventListener("dragend", () => {
            div.classList.remove("is-dragging");
            _dragContentId = null;
            });

            div.addEventListener("dragover", (e) => {
            e.preventDefault();
            div.classList.add("is-drag-over");
            });

            div.addEventListener("dragleave", () => {
            div.classList.remove("is-drag-over");
            });

            div.addEventListener("drop", async (e) => {
            e.preventDefault();
            div.classList.remove("is-drag-over");

            const targetId = div.dataset.id || "";
            const sourceId = _dragContentId || e.dataTransfer?.getData("text/plain") || "";

            if (!sourceId || !targetId || sourceId === targetId) return;

            moveContentLocal(sourceId, targetId);
            renderContenus();

            try{
                await saveContentOrder(window.portal);
            } catch(err){
                const msg = getErrorMessage(err);
                if (msg && msg !== "[object Object]"){
                    window.portal.showAlert("error", msg);
                }
            }
            });

            host.appendChild(div);
        });
    }


    function renderContentCompetenceChecks(){
        const host = byId("formContentCompList");
        if (!host) return;

        host.innerHTML = "";

        const ids = Array.isArray(_selectedCompStag) ? _selectedCompStag : [];
        const rows = ids.map(id => findCompetence(id)).filter(Boolean);

        if (!rows.length){
            host.innerHTML = `<div class="card-sub">Aucune compétence stagiaire n’est encore affectée à la formation.</div>`;
            return;
        }

        rows.forEach(c => {
            const id = String(c.id_comp || "").trim();
            if (!id) return;

            const label = document.createElement("label");
            label.className = "lf-content-comp-check";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = _contentCompetenceIds.includes(id);

            cb.addEventListener("change", () => {
            if (cb.checked){
                if (!_contentCompetenceIds.includes(id)) _contentCompetenceIds.push(id);
            } else {
                _contentCompetenceIds = _contentCompetenceIds.filter(x => x !== id);
            }
            });

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = c.code || "—";

            const title = document.createElement("span");
            title.className = "lf-content-comp-check-title";
            title.textContent = c.intitule || "";

            label.appendChild(cb);
            label.appendChild(code);
            label.appendChild(title);

            host.appendChild(label);
        });
        }

        function openContentModal(l){
        if (!_editingId){
            window.portal.showAlert("error", "Enregistrez d’abord la fiche formation avant d’ajouter un contenu.");
            return;
        }

        _contentEditId = l?.id_ligne_contenu || null;
        _contentCompetenceIds = getContentCompIds(l);

        byId("formContentModalTitle").textContent = _contentEditId ? "Modifier le contenu" : "Ajouter un contenu";
        byId("formContentTitre").value = l?.titre_sequence || "";
        byId("formContentObjectif").value = l?.objectif || "";
        byId("formContentDetail").value = l?.contenu || "";

        renderContentCompetenceChecks();

        openModal("modalFormContent");
        }

        function closeContentModal(){
        closeModal("modalFormContent");
        _contentEditId = null;
        _contentCompetenceIds = [];
        }

        function buildContentPayload(){
        return {
            titre_sequence: (byId("formContentTitre")?.value || "").trim(),
            objectif: (byId("formContentObjectif")?.value || "").trim() || null,
            contenu: (byId("formContentDetail")?.value || "").trim() || null,
            competences_liees: _contentCompetenceIds
        };
        }

        async function saveContent(portal){
        if (!_editingId){
            portal.showAlert("error", "Enregistrez d’abord la fiche formation.");
            return;
        }

        const payload = buildContentPayload();

        if (!payload.titre_sequence){
            portal.showAlert("error", "Titre du contenu obligatoire.");
            return;
        }

        const effectifId = getEffectifId();
        let res;

        if (_contentEditId){
            res = await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}/contenus/${encodeURIComponent(_contentEditId)}`,
            {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload)
            }
            );

            const idx = _detailContenus.findIndex(x => String(x.id_ligne_contenu || "") === String(_contentEditId));
            if (idx >= 0 && res?.item) _detailContenus[idx] = res.item;
        } else {
            res = await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}/contenus`,
            {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload)
            }
            );

            if (res?.item) _detailContenus.push(res.item);
        }

        closeContentModal();
        renderContenus();
        setSuccess("Contenu enregistré");
        }

        async function archiveContent(l){
        const lid = String(l?.id_ligne_contenu || "").trim();

        if (!_editingId || !lid) return;

        const effectifId = getEffectifId();

        await window.portal.apiJson(
            `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}/contenus/${encodeURIComponent(lid)}/archive`,
            { method:"POST" }
        );

        _detailContenus = _detailContenus.filter(x => String(x.id_ligne_contenu || "") !== lid);
        _detailContenus.forEach((x, idx) => x.position = idx + 1);

        renderContenus();
        setSuccess("Contenu retiré");
        }

        function moveContentLocal(sourceId, targetId){
        const from = _detailContenus.findIndex(x => String(x.id_ligne_contenu || "") === String(sourceId));
        const to = _detailContenus.findIndex(x => String(x.id_ligne_contenu || "") === String(targetId));

        if (from < 0 || to < 0 || from === to) return;

        const [item] = _detailContenus.splice(from, 1);
        _detailContenus.splice(to, 0, item);

        _detailContenus.forEach((x, idx) => x.position = idx + 1);
        }

        async function saveContentOrder(portal){
        if (!_editingId) return;

        const effectifId = getEffectifId();
        const ids = _detailContenus.map(x => String(x.id_ligne_contenu || "").trim()).filter(Boolean);

        await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}/contenus/reorder`,
            {
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ items: ids })
            }
        );
    }
 
    function makeTmpId(prefix){
        return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    function toNumber(v){
        const n = parseFloat(String(v ?? "").replace(",", "."));
        return Number.isFinite(n) ? n : 0;
    }

    function formatHours(v){
        const n = toNumber(v);

        if (!n) return "0 h";
        if (Number.isInteger(n)) return `${n} h`;

        return `${String(Math.round(n * 100) / 100).replace(".", ",")} h`;
    }

    function getFormationDuration(){
        return toNumber(byId("formDuree")?.value || 0);
    }

    function getPlanDuration(){
        return (_planBlocks || []).reduce((acc, b) => acc + toNumber(b.duree), 0);
    }

    function fillPlanModaliteSelect(selectId, value){
        const sel = byId(selectId);
        if (!sel) return;

        const keep = String(value || "").trim();
        sel.innerHTML = "";

        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_refs?.modalites || []).forEach(m => {
            const label = (m.titre || m.titre_court || "").toString().trim();
            if (!label) return;

            const opt = document.createElement("option");
            opt.value = label;
            opt.textContent = label;
            sel.appendChild(opt);
        });

        if (keep && !Array.from(sel.options).some(o => o.value === keep)){
            const opt = document.createElement("option");
            opt.value = keep;
            opt.textContent = keep;
            sel.appendChild(opt);
        }

        sel.value = keep || "";
    }

    function updatePlanDurationUI(){
        const formation = getFormationDuration();
        const plan = getPlanDuration();
        const diff = Math.round((plan - formation) * 100) / 100;

        const fEl = byId("planDureeFormation");
        const pEl = byId("planDureeCalculee");
        const dEl = byId("planDureeEcart");
        const card = byId("planDureeEtatCard");

        if (fEl) fEl.textContent = formatHours(formation);
        if (pEl) pEl.textContent = formatHours(plan);

        if (dEl){
            if (!formation && !plan) dEl.textContent = "—";
            else if (diff === 0) dEl.textContent = "Conforme";
            else dEl.textContent = `${diff > 0 ? "+" : ""}${String(diff).replace(".", ",")} h`;
        }

        if (card){
            card.classList.remove("is-ok", "is-ko");
            if (formation || plan){
            card.classList.add(diff === 0 ? "is-ok" : "is-ko");
            }
        }
    }

    function findContent(id){
        const cid = String(id || "").trim();
        if (!cid) return null;

        return (_detailContenus || []).find(c => String(c.id_ligne_contenu || "").trim() === cid) || null;
    }

    function contentCompBadgesFromContent(c){
        const items = Array.isArray(c?.competences_liees_items) ? c.competences_liees_items : [];

        if (!items.length){
            return "";
        }

        return items.map(x => `
            <span class="sb-badge sb-badge--comp lf-content-comp-badge" title="${htmlEsc(x.intitule || "")}">
            ${htmlEsc(x.code || "—")}
            </span>
        `).join("");
    }

    function createEmptyPlanBlock(){
        return {
            tmp_id: makeTmpId("bloc"),
            titre: "",
            duree: "",
            modalite_intervention: byId("planModaliteGenerale")?.value || "",
            objectif: "",
            observations: "",
            contenus: [],
            collapsed: false
        };
    }

    function planBlockKey(b){
        return String(b.id_bloc_peda || b.tmp_id || "").trim();
    }

    function renderPlanContentLibrary(){
        const host = byId("planContentLibrary");
        if (!host) return;

        const q = (_planContentSearch || "").trim().toLowerCase();

        const rows = (_detailContenus || []).filter(c => {
            if (!q) return true;

            return [
            c.titre_sequence || "",
            c.objectif || "",
            c.contenu || ""
            ].join(" ").toLowerCase().includes(q);
        });

        host.innerHTML = "";

        if (!rows.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucun contenu disponible.";
            host.appendChild(empty);
            return;
        }

        rows.forEach(c => {
            const id = String(c.id_ligne_contenu || "").trim();
            if (!id) return;

            const item = document.createElement("div");
            item.className = "lf-plan-content-brick";
            item.draggable = true;
            item.dataset.id = id;

            item.innerHTML = `
            <div class="lf-plan-content-brick-title">${htmlEsc(c.titre_sequence || "Contenu")}</div>
            <div class="card-sub">${htmlEsc(c.objectif || "")}</div>
            <div class="lf-content-comp-badges">${contentCompBadgesFromContent(c)}</div>
            `;

            item.addEventListener("dragstart", (e) => {
            _planDragContentId = id;

            if (e.dataTransfer){
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("text/plain", id);
                e.dataTransfer.setData("application/x-learn-content", id);
            }
            });

            item.addEventListener("dragend", () => {
            _planDragContentId = null;
            });

            host.appendChild(item);
        });
    }

    function addContentToPlanBlock(blockKey, contentId, insertAt){
        const b = (_planBlocks || []).find(x => planBlockKey(x) === blockKey);
        const id = String(contentId || "").trim();

        if (!b || !id || !findContent(id)) return;

        if (!Array.isArray(b.contenus)) b.contenus = [];

        const idx = Number.isInteger(insertAt) ? insertAt : b.contenus.length;
        b.contenus.splice(Math.max(0, Math.min(idx, b.contenus.length)), 0, id);

        renderPlanBlocks();
    }

    function removeContentFromPlanBlock(blockKey, index){
        const b = (_planBlocks || []).find(x => planBlockKey(x) === blockKey);
        if (!b || !Array.isArray(b.contenus)) return;

        b.contenus.splice(index, 1);
        renderPlanBlocks();
    }

    function moveContentInsidePlanBlock(blockKey, fromIndex, toIndex){
        const b = (_planBlocks || []).find(x => planBlockKey(x) === blockKey);
        if (!b || !Array.isArray(b.contenus)) return;

        const from = parseInt(fromIndex, 10);
        const to = parseInt(toIndex, 10);

        if (!Number.isInteger(from) || !Number.isInteger(to)) return;
        if (from < 0 || to < 0 || from >= b.contenus.length || to >= b.contenus.length || from === to) return;

        const [item] = b.contenus.splice(from, 1);
        b.contenus.splice(to, 0, item);

        renderPlanBlocks();
    }

    function movePlanBlockLocal(sourceKey, targetKey){
        const from = _planBlocks.findIndex(x => planBlockKey(x) === sourceKey);
        const to = _planBlocks.findIndex(x => planBlockKey(x) === targetKey);

        if (from < 0 || to < 0 || from === to) return;

        const [item] = _planBlocks.splice(from, 1);
        _planBlocks.splice(to, 0, item);

        renderPlanBlocks();
    }

    function renderPlanBlockContents(block){
        const ids = Array.isArray(block.contenus) ? block.contenus : [];

        if (!ids.length){
            return `<div class="card-sub">Déposez ici les contenus à travailler dans cette séquence.</div>`;
        }

        return ids.map((id, idx) => {
            const c = findContent(id);

            return `
            <div class="lf-plan-seq-content" draggable="true" data-content-index="${idx}">
                <div class="lf-plan-seq-content-main">
                <span class="sb-badge sb-badge--form">${idx + 1}</span>
                <div class="lf-plan-seq-content-title">${htmlEsc(c?.titre_sequence || "Contenu introuvable")}</div>
                </div>

                <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-remove-content="${idx}" title="Retirer" aria-label="Retirer">
                ${iconTrash()}
                </button>
            </div>
            `;
        }).join("");
    }

    function renderPlanBlocks(){
        const host = byId("planBlockList");
        if (!host) return;

        host.innerHTML = "";

        if (!_planBlocks.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucune séquence. Ajoutez une première séquence pédagogique.";
            host.appendChild(empty);
            updatePlanDurationUI();
            return;
        }

        _planBlocks.forEach((b, idx) => {
            const key = planBlockKey(b);
            const isCollapsed = !!b.collapsed;

            const shortTitle = (b.titre || `Séquence ${idx + 1}`).trim();
            const shortDuree = b.duree ? formatHours(b.duree) : "Durée non définie";
            const shortModalite = (b.modalite_intervention || "Modalité non définie").trim();

            const card = document.createElement("div");
            card.className = "lf-plan-block-edit" + (isCollapsed ? " is-collapsed" : "");
            card.dataset.key = key;

            card.innerHTML = `
            <div class="lf-plan-block-edit-head">
                <div class="lf-plan-drag-handle" title="Glisser pour réordonner" draggable="true">☰</div>

                <div class="lf-plan-block-title-wrap">
                <div class="lf-plan-block-title">Séquence ${idx + 1}</div>
                <div class="lf-plan-block-summary">
                    <span>${htmlEsc(shortTitle)}</span>
                    <span>${htmlEsc(shortDuree)}</span>
                    <span>${htmlEsc(shortModalite)}</span>
                </div>
                </div>

                <button type="button" class="sb-icon-btn" data-action="toggle-block" title="${isCollapsed ? "Afficher le détail" : "Masquer le détail"}" aria-label="${isCollapsed ? "Afficher le détail" : "Masquer le détail"}">
                ${isCollapsed ? iconDoubleDown() : iconDoubleUp()}
                </button>

                <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-action="remove-block" title="Retirer la séquence" aria-label="Retirer la séquence">
                ${iconTrash()}
                </button>
            </div>

            <div class="lf-plan-block-body">
                <div class="row">
                <div class="info-item" style="flex:1; min-width:260px;">
                    <div class="label">Titre de la séquence</div>
                    <input type="text" data-field="titre" value="${htmlEsc(b.titre || "")}" />
                </div>
                </div>

                <div class="lf-plan-block-meta-row">
                <div class="info-item lf-plan-duration-field">
                    <div class="label">Durée (heures)</div>
                    <input type="number" min="0" step="0.25" data-field="duree" value="${htmlEsc(b.duree || "")}" />
                </div>

                <div class="info-item" style="flex:1; min-width:220px;">
                    <div class="label">Modalité</div>
                    <select data-field="modalite_intervention"></select>
                </div>
                </div>

                <div class="row">
                <div class="info-item" style="flex:1; min-width:260px;">
                    <div class="label">Objectif <span class="lf-label-muted">(optionnel)</span></div>
                    <input type="text" data-field="objectif" value="${htmlEsc(b.objectif || "")}" />
                </div>
                </div>

                <div class="lf-plan-seq-drop" data-drop-zone="content">
                ${renderPlanBlockContents(b)}
                </div>

                <div class="row">
                <div class="info-item" style="flex:1; min-width:260px;">
                    <div class="label">Observations</div>
                    <textarea rows="2" data-field="observations">${htmlEsc(b.observations || "")}</textarea>
                </div>
                </div>
            </div>
            `;

            const modaliteSelect = card.querySelector('select[data-field="modalite_intervention"]');
            if (modaliteSelect){
            fillPlanModaliteSelectOnElement(modaliteSelect, b.modalite_intervention || "");
            }

            card.querySelectorAll("[data-field]").forEach(el => {
            const field = el.dataset.field;

            el.addEventListener("input", () => {
                b[field] = el.value || "";
                if (field === "duree") updatePlanDurationUI();
                if (field === "titre" || field === "modalite_intervention" || field === "duree") renderPlanBlocks();
            });

            el.addEventListener("change", () => {
                b[field] = el.value || "";
                if (field === "duree") updatePlanDurationUI();
                if (field === "titre" || field === "modalite_intervention" || field === "duree") renderPlanBlocks();
            });
            });

            card.querySelector('[data-action="toggle-block"]')?.addEventListener("click", () => {
            b.collapsed = !b.collapsed;
            renderPlanBlocks();
            });

            card.querySelector('[data-action="remove-block"]')?.addEventListener("click", () => {
            _planBlocks = _planBlocks.filter(x => planBlockKey(x) !== key);
            renderPlanBlocks();
            });

            card.querySelectorAll("[data-remove-content]").forEach(btn => {
            btn.addEventListener("click", () => {
                const index = parseInt(btn.dataset.removeContent || "-1", 10);
                if (index >= 0) removeContentFromPlanBlock(key, index);
            });
            });

            card.querySelectorAll(".lf-plan-seq-content").forEach(row => {
            row.addEventListener("dragstart", (e) => {
                const index = parseInt(row.dataset.contentIndex || "-1", 10);
                _planDragSeq = { blockKey: key, index };

                row.classList.add("is-dragging");

                if (e.dataTransfer){
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-learn-plan-seq-content", `${key}|${index}`);
                e.dataTransfer.setData("text/plain", `${key}|${index}`);
                }
            });

            row.addEventListener("dragend", () => {
                row.classList.remove("is-dragging");
                _planDragSeq = null;
            });

            row.addEventListener("dragover", (e) => {
                if (_planDragSeq || _planDragContentId || e.dataTransfer?.getData("application/x-learn-content")){
                e.preventDefault();
                row.classList.add("is-drag-over");
                }
            });

            row.addEventListener("dragleave", () => {
                row.classList.remove("is-drag-over");
            });

            row.addEventListener("drop", (e) => {
                e.preventDefault();
                row.classList.remove("is-drag-over");

                const targetIndex = parseInt(row.dataset.contentIndex || "-1", 10);

                if (_planDragSeq && _planDragSeq.blockKey === key){
                moveContentInsidePlanBlock(key, _planDragSeq.index, targetIndex);
                return;
                }

                const cid = _planDragContentId
                || e.dataTransfer?.getData("application/x-learn-content")
                || "";

                if (cid){
                addContentToPlanBlock(key, cid, targetIndex);
                }
            });
            });

            const handle = card.querySelector(".lf-plan-drag-handle");
            if (handle){
            handle.addEventListener("dragstart", (e) => {
                _planDragBlockId = key;

                if (e.dataTransfer){
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
                e.dataTransfer.setData("application/x-learn-plan-block", key);
                }
            });

            handle.addEventListener("dragend", () => {
                _planDragBlockId = null;
            });
            }

            card.addEventListener("dragover", (e) => {
            if (!_planDragBlockId) return;
            e.preventDefault();
            card.classList.add("is-drag-over");
            });

            card.addEventListener("dragleave", () => {
            card.classList.remove("is-drag-over");
            });

            card.addEventListener("drop", (e) => {
            if (!_planDragBlockId) return;

            e.preventDefault();
            card.classList.remove("is-drag-over");

            const source = _planDragBlockId || e.dataTransfer?.getData("application/x-learn-plan-block") || "";
            movePlanBlockLocal(source, key);
            });

            const drop = card.querySelector('[data-drop-zone="content"]');
            if (drop){
            drop.addEventListener("dragover", (e) => {
                if (_planDragSeq || _planDragContentId || e.dataTransfer?.getData("application/x-learn-content")){
                e.preventDefault();
                drop.classList.add("is-drag-over");
                }
            });

            drop.addEventListener("dragleave", () => {
                drop.classList.remove("is-drag-over");
            });

            drop.addEventListener("drop", (e) => {
                e.preventDefault();
                drop.classList.remove("is-drag-over");

                if (_planDragSeq && _planDragSeq.blockKey === key){
                const bTarget = (_planBlocks || []).find(x => planBlockKey(x) === key);
                if (bTarget && Array.isArray(bTarget.contenus)){
                    const lastIndex = Math.max(0, bTarget.contenus.length - 1);
                    moveContentInsidePlanBlock(key, _planDragSeq.index, lastIndex);
                }
                return;
                }

                const cid = _planDragContentId
                || e.dataTransfer?.getData("application/x-learn-content")
                || e.dataTransfer?.getData("text/plain")
                || "";

                addContentToPlanBlock(key, cid);
            });
            }

            host.appendChild(card);
        });

        updatePlanDurationUI();
    }

    function fillPlanModaliteSelectOnElement(sel, value){
        if (!sel) return;

        const keep = String(value || "").trim();
        sel.innerHTML = "";

        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_refs?.modalites || []).forEach(m => {
            const label = (m.titre || m.titre_court || "").toString().trim();
            if (!label) return;

            const opt = document.createElement("option");
            opt.value = label;
            opt.textContent = label;
            sel.appendChild(opt);
        });

        if (keep && !Array.from(sel.options).some(o => o.value === keep)){
            const opt = document.createElement("option");
            opt.value = keep;
            opt.textContent = keep;
            sel.appendChild(opt);
        }

        sel.value = keep || "";
    }

    function normalizePlanDetailToBlocks(plan){
        const blocs = Array.isArray(plan?.blocs) ? plan.blocs : [];

        return blocs.map((b, idx) => ({
            id_bloc_peda: b.id_bloc_peda || null,
            tmp_id: makeTmpId("bloc"),
            titre: b.titre || "",
            duree: b.duree || "",
            modalite_intervention: b.modalite_intervention || "",
            objectif: b.objectif || "",
            observations: b.observations || "",
            position: b.position || (idx + 1),
            contenus: Array.isArray(b.sequences)
              ? b.sequences.map(s => String(s.id_ligne_contenu || "").trim()).filter(Boolean)
                : [],
            collapsed: false
        }));
    }

    async function openPlanModal(p){
        if (!_editingId){
            window.portal.showAlert("error", "Enregistrez d’abord la fiche formation avant de créer un plan pédagogique.");
            return;
        }

        await ensureRefs(window.portal);

        _planContentSearch = "";
        _planDragContentId = null;
        _planDragBlockId = null;

        const search = byId("planContentSearch");
        if (search) search.value = "";

        if (p?.id_plan_peda){
            _planMode = "edit";
            _planEditId = String(p.id_plan_peda || "").trim();

            const effectifId = getEffectifId();

            const detail = await window.portal.apiJson(
            `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(_editingId)}`
            + `/plans/${encodeURIComponent(_planEditId)}`
            );

            byId("planModalTitle").textContent = "Modifier le plan pédagogique";

            const badge = byId("planModalBadge");
            if (badge){
            badge.textContent = detail.codification || "";
            badge.style.display = detail.codification ? "" : "none";
            }

            byId("planTitre").value = detail.titre || "";
            fillPlanModaliteSelect("planModaliteGenerale", detail.modalite_generale || "");
            byId("planObservations").value = detail.commentaire || "";

            _planBlocks = normalizePlanDetailToBlocks(detail);
        } else {
            _planMode = "create";
            _planEditId = null;

            byId("planModalTitle").textContent = "Créer un plan pédagogique";

            const badge = byId("planModalBadge");
            if (badge){
            badge.textContent = "";
            badge.style.display = "none";
            }

            byId("planTitre").value = "";
            fillPlanModaliteSelect("planModaliteGenerale", "");
            byId("planObservations").value = "";
            _planBlocks = [];
        }

        renderPlanContentLibrary();
        renderPlanBlocks();
        updatePlanDurationUI();

        openModal("modalFormPlan");
    }

    function closePlanModal(){
        closeModal("modalFormPlan");
        _planMode = "create";
        _planEditId = null;
        _planBlocks = [];
        _planDragContentId = null;
        _planDragBlockId = null;
        _planDragSeq = null;
    }

    function addPlanBlock(){
        _planBlocks.push(createEmptyPlanBlock());
        renderPlanBlocks();
    }

    function buildPlanPayload(){
        return {
            titre: (byId("planTitre")?.value || "").trim(),
            modalite_generale: (byId("planModaliteGenerale")?.value || "").trim() || null,
            commentaire: (byId("planObservations")?.value || "").trim() || null,
            blocs: (_planBlocks || []).map((b, idx) => ({
            titre: (b.titre || "").trim() || `Séquence ${idx + 1}`,
            duree: (b.duree || "").toString().trim() || null,
            modalite_intervention: (b.modalite_intervention || "").trim() || null,
            objectif: (b.objectif || "").trim() || null,
            observations: (b.observations || "").trim() || null,
            contenus: Array.isArray(b.contenus) ? b.contenus : [],
            position: idx + 1
            }))
        };
    }

    async function reloadFormationTechnicalDetail(portal){
        const effectifId = getEffectifId();

        const d = await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}`
        );

        _detailContenus = Array.isArray(d.contenus) ? d.contenus : [];
        _detailPlans = Array.isArray(d.plans) ? d.plans : [];

        renderContenus();
        renderPlans();
    }

    async function savePlan(portal){
        if (!_editingId){
            portal.showAlert("error", "Enregistrez d’abord la fiche formation.");
            return;
        }

        const payload = buildPlanPayload();

        if (!payload.titre){
            portal.showAlert("error", "Titre du plan obligatoire.");
            return;
        }

        const effectifId = getEffectifId();

        if (_planMode === "edit" && _planEditId){
            await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(_editingId)}`
            + `/plans/${encodeURIComponent(_planEditId)}`,
            {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload)
            }
            );
        } else {
            await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(_editingId)}`
            + `/plans`,
            {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload)
            }
            );
        }

        closePlanModal();
        await reloadFormationTechnicalDetail(portal);
        setSuccess("Plan pédagogique enregistré");
    }

    function renderPlans(){
        const host = byId("formPlansList");
        if (!host) return;

        host.innerHTML = "";

        if (!_detailPlans.length){
            host.innerHTML = `<div class="card-sub">Aucun plan pédagogique n’est encore rattaché à cette formation.</div>`;
            return;
        }

        _detailPlans.forEach(p => {
            const div = document.createElement("div");
            div.className = "lf-plan-card";

            div.innerHTML = `
            <div class="lf-plan-head">
                <div class="lf-plan-head-main">
                <div class="lf-plan-title">
                    <span class="sb-badge sb-badge--plan">${htmlEsc(p.codification || "PLAN")}</span>
                    <span>${htmlEsc(p.titre || "Plan pédagogique")}</span>
                </div>
                <div class="card-sub" style="margin:4px 0 0 0;">
                    ${htmlEsc(p.modalite_generale || "—")} • ${htmlEsc(p.duree_totale || "0")} h • ${htmlEsc(p.nb_blocs || "0")} bloc(s)
                </div>
                </div>

                <div class="sb-icon-actions">
                <button type="button" class="sb-icon-btn sb-icon-btn--doc" data-action="pdf" title="Voir PDF" aria-label="Voir PDF">
                    ${iconPdf()}
                </button>
                <button type="button" class="sb-icon-btn" data-action="edit" title="Modifier" aria-label="Modifier">
                    ${iconEdit()}
                </button>
                <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-action="archive" title="Archiver" aria-label="Archiver">
                    ${iconTrash()}
                </button>
                </div>
            </div>

            <div class="lf-plan-blocs">
                ${(p.blocs || []).map(b => `
                <div class="lf-plan-bloc">
                    <strong>${htmlEsc(b.titre || "Bloc")}</strong>
                    <span>${htmlEsc(b.duree || "—")} h • ${htmlEsc(b.modalite_intervention || "—")}</span>
                </div>
                `).join("")}
            </div>
            `;

            div.querySelector('[data-action="pdf"]')?.addEventListener("click", async () => {
            try{
                await openPlanPdf(p);
            } catch(e){
                window.portal.showAlert("error", getErrorMessage ? getErrorMessage(e) : (e?.message || String(e)));
            }
            });

            div.querySelector('[data-action="edit"]')?.addEventListener("click", async () => {
                try{
                    await openPlanModal(p);
                } catch(e){
                    window.portal.showAlert("error", getErrorMessage(e));
                }
            });

            div.querySelector('[data-action="archive"]')?.addEventListener("click", () => {
            openPlanArchive(p);
            });

            host.appendChild(div);
        });
    }

  function renderList(){
    const host = byId("catFormsList");
    if (!host) return;

    host.innerHTML = "";

    if (!_items.length){
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucune formation à afficher.";
      host.appendChild(empty);
      return;
    }

    _items.forEach(it => {
      const row = document.createElement("div");
      row.className = "sb-row-card";
      if (it.archive || it.masque) row.classList.add("is-archived");

      const left = document.createElement("div");
      left.className = "sb-row-left";

      const code = document.createElement("span");
      code.className = "sb-badge sb-badge--form";
      code.textContent = it.code || "—";

      const titleWrap = document.createElement("div");
      titleWrap.style.minWidth = "0";

      const title = document.createElement("div");
      title.className = "sb-row-title";
      title.textContent = it.titre || "";

      const sub = document.createElement("div");
      sub.className = "card-sub";
      sub.style.margin = "2px 0 0 0";
      sub.textContent = [
        it.duree ? `${it.duree} h` : "",
        it.fournisseur_nom || "",
        it.nb_plans ? `${it.nb_plans} plan(s)` : "0 plan"
      ].filter(Boolean).join(" • ");

      titleWrap.appendChild(title);
      titleWrap.appendChild(sub);

      left.appendChild(code);
      left.appendChild(titleWrap);

      const right = document.createElement("div");
      right.className = "sb-row-right";

      const domLabel = (it.domaine_titre_court || it.domaine_titre || "").toString().trim();
      if (domLabel){
        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--form-domain";
        dom.textContent = domLabel;
        right.appendChild(dom);
      }

      if (it.etat){
        const et = document.createElement("span");
        et.className = "sb-badge sb-badge--state";
        et.textContent = it.etat;
        right.appendChild(et);
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
          await openFormationPdf(it);
        } catch(err){
          window.portal.showAlert("error", err?.message || String(err));
        }
      });

      actions.appendChild(btnPdf);

      const btnHtml = document.createElement("button");
      btnHtml.type = "button";
      btnHtml.className = "sb-icon-btn sb-icon-btn--doc";
      btnHtml.title = "Copier HTML LMS";
      btnHtml.setAttribute("aria-label", "Copier HTML LMS");
      btnHtml.innerHTML = iconHtml();
      btnHtml.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try{
          await copyFormationHtmlLms(it);
        } catch(err){
          window.portal.showAlert("error", getErrorMessage(err));
        }
      });

      actions.appendChild(btnHtml);

      if (isSupervisor()){
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-icon-btn";
        btnEdit.title = "Modifier";
        btnEdit.setAttribute("aria-label", "Modifier");
        btnEdit.innerHTML = iconEdit();
        btnEdit.addEventListener("click", async () => {
          try{
            await openEdit(window.portal, it);
          } catch(e){
            window.portal.showAlert("error", e?.message || String(e));
          }
        });

        actions.appendChild(btnEdit);

        if (!it.archive && !it.masque){
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
      `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
      + `?q=${encodeURIComponent(_q)}`
      + `&show=${encodeURIComponent(_show)}`
      + `&domaine=${encodeURIComponent(_dom)}`;

    const data = await portal.apiJson(url);
    _items = Array.isArray(data?.items) ? data.items : [];

    renderList();
  }

    function setFieldValue(id, value){
        const el = byId(id);
        if (!el) return;
        el.value = value ?? "";
    }

  function setSelectValue(id, value){
    const el = byId(id);
    if (!el) return;

    const v = (value ?? "").toString();

    const exists = Array.from(el.options || []).some(o => o.value === v);
    if (v && !exists){
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      el.appendChild(opt);
    }

    el.value = v;
  }

  function normalizeIdArray(v){
    if (!v) return [];

    if (Array.isArray(v)){
      return v.map(x => String(x || "").trim()).filter(Boolean);
    }

    if (typeof v === "string"){
      const s = v.trim();
      if (!s) return [];

      try{
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)){
          return parsed.map(x => String(x || "").trim()).filter(Boolean);
        }
      } catch(_){}

      return [];
    }

    return [];
  }

  function fillFormationModal(d){
    if (!d || !d.id_form){
      throw new Error("Détail formation vide ou invalide.");
    }

    const badge = byId("formModalBadge");
    if (badge){
      badge.textContent = d.code || "";
      badge.style.display = d.code ? "" : "none";
    }

    const modalTitle = byId("formModalTitle");
    if (modalTitle){
      modalTitle.textContent = d.titre || "Formation";
    }

    setFieldValue("formTitre", d.titre || "");
    setSelectValue("formEtat", d.etat || "à valider");
    setSelectValue("formDomaine", d.domaine || "");
    setSelectValue("formFournisseur", d.fournisseur_formation || "");
    setSelectValue("formType", normalizeTypeFormation(d.type_formation || ""));
    setFieldValue("formObsType", d.obs_type_form || "");
    syncObsTypeFormation();
    setFieldValue("formDuree", d.duree ?? "");
    setFieldValue("formTarif", d.tarif_mini ?? "");
    setFieldValue("formPresentation", d.presentation || "");
    setFieldValue("formPublic", d.public_cible || "");
    setFieldValue("formObjectifs", d.objectifs || "");
    setFieldValue("formAttestation", d.attestation_specifique || "");

    _selectedModalites = normalizeIdArray(d.modalites_ids);
    _selectedPeda = normalizeIdArray(d.methode_peda_ids);
    _selectedEval = normalizeIdArray(d.methode_eval_ids);
    _selectedCompStag = normalizeIdArray(d.competences_stagiaires_ids);
    _selectedCompForm = normalizeIdArray(d.competences_formateurs_ids);

    normalizePrerequis(d.prerequis || []);

    _detailContenus = Array.isArray(d.contenus) ? d.contenus : [];
    _detailPlans = Array.isArray(d.plans) ? d.plans : [];

    renderRefChecks();
    renderPrerequis();
    renderCompetences();
    renderContenus();
    renderPlans();

    setTab("identite");
  }

    function closeImportModal(){
        closeModal("modalFormImport");
        _importDraft = null;

        const input = byId("formImportFile");
        if (input) input.value = "";

        const name = byId("formImportFileName");
        if (name) name.textContent = "Aucun fichier sélectionné";

        const status = byId("formImportStatus");
        if (status){
            status.textContent = "";
            status.className = "lf-import-status";
        }

        const preview = byId("formImportPreview");
        if (preview) preview.style.display = "none";

        const apply = byId("btnFormImportApply");
        if (apply) apply.disabled = true;
    }

    function openImportModal(){
        if (_modalMode !== "create"){
            window.portal.showAlert("error", "L’import est disponible uniquement lors de la création d’une formation.");
            return;
        }

        closeImportModal();
        openModal("modalFormImport");
    }

    function setImportStatus(msg, kind){
        const el = byId("formImportStatus");
        if (!el) return;

        el.textContent = msg || "";
        el.className = "lf-import-status";

        if (kind) el.classList.add("is-" + kind);
    }

    function normalizeImportKey(value){
        return String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function importRowsToCreate(rows){
        return (rows || [])
            .filter(r => !(r.selected_id || "").toString().trim())
            .map(r => ({
            source: (r.source || "").toString().trim(),
            status: r.status || "non_trouve",
            matches: Array.isArray(r.matches) ? r.matches : []
            }))
            .filter(r => r.source);
    }

        function buildImportSelectedMap(draft){
        const map = new Map();
        const src = draft || _importDraft || _aiGenerationDraft || {};

        const allRows = []
            .concat(src?.competences_stagiaires_import || [])
            .concat(src?.competences_formateurs_import || []);

        allRows.forEach(r => {
            const key = normalizeImportKey(r.source || "");
            const id = (r.selected_id || "").toString().trim();

            if (key && id) {
            map.set(key, id);
            }
        });

        return map;
    }

    function enrichImportContenusWithCompetences(rows, draft){
        const map = buildImportSelectedMap(draft);

        return (rows || []).map(c => {
            const sources = Array.isArray(c.competences_sources) ? c.competences_sources : [];
            const ids = [];

            sources.forEach(src => {
            const key = normalizeImportKey(src);
            const id = map.get(key);

            if (id && !ids.includes(id)) {
                ids.push(id);
            }
            });

            return {
            ...c,
            competences_liees: ids
            };
        });
    }

    function importSelectedIds(rows){
        const ids = [];

        (rows || []).forEach(r => {
            const id = (r.selected_id || "").toString().trim();
            if (id && !ids.includes(id)) ids.push(id);
        });

        return ids;
    }

    function importStatusClass(status){
        const s = normalizeImportKey(status || "");

        if (s.includes("creer")) return "is-create";
        if (s.includes("verifier")) return "is-check";
        if (s.includes("approchant")) return "is-close";
        if (s.includes("recommande") || s.includes("match fort")) return "is-ok";

        return "";
    }

    function renderImportCompetenceRows(hostId, rows){
        const host = byId(hostId);
        if (!host) return;

        host.innerHTML = "";

        if (!rows || !rows.length){
            host.innerHTML = `<div class="card-sub">Aucune compétence détectée.</div>`;
            return;
        }

        rows.forEach((r, idx) => {
            const div = document.createElement("div");
            div.className = "lf-import-comp-row";

            const status = r.status || "à créer";
            const statusClass = importStatusClass(status);

            const options = (r.matches || []).map(m => `
            <label class="lf-import-match">
                <input type="radio"
                    name="${hostId}_${idx}"
                    value="${htmlEsc(m.id_comp || "")}"
                    ${r.selected_id === m.id_comp ? "checked" : ""} />
                <span class="sb-badge sb-badge--comp">${htmlEsc(m.code || "—")}</span>
                <span class="lf-import-match-title">${htmlEsc(m.intitule || "")}</span>
                <span class="lf-import-score">${htmlEsc(m.score || 0)}%</span>
            </label>
            `).join("");

            div.innerHTML = `
            <div class="lf-import-comp-source">
                <span>${htmlEsc(r.source || "")}</span>
                <span class="lf-import-status-pill ${statusClass}">${htmlEsc(status)}</span>
            </div>
            <div class="lf-import-matches">
                ${options || `<div class="card-sub">Aucune compétence approchante trouvée.</div>`}
            </div>
            `;

            div.querySelectorAll("input[type='radio']").forEach(rad => {
            rad.addEventListener("change", () => {
                r.selected_id = rad.value || null;
            });
            });

            host.appendChild(div);
        });
    }

    function renderImportPreview(data){
        const preview = byId("formImportPreview");
        if (preview) preview.style.display = "";

        const summary = byId("formImportSummary");
        if (summary){
            summary.innerHTML = `
            <div class="lf-result-title-card">
                <span>Titre</span>
                <strong>${htmlEsc(data.titre || "—")}</strong>
            </div>

            <div class="lf-result-summary-grid">
                <div class="lf-import-summary-item">
                <span>Type</span>
                <strong>${htmlEsc(data.type_formation || "—")}</strong>
                </div>
                <div class="lf-import-summary-item">
                <span>Durée</span>
                <strong>${data.duree ? htmlEsc(data.duree) + " h" : "—"}</strong>
                </div>
                <div class="lf-import-summary-item">
                <span>Contenus</span>
                <strong>${htmlEsc((data.contenus || []).length)}</strong>
                </div>
            </div>
            `;
        }

        renderImportCompetenceRows("formImportCompStag", data.competences_stagiaires_import || []);
        renderImportCompetenceRows("formImportCompForm", data.competences_formateurs_import || []);

        const contents = byId("formImportContents");
        if (contents){
            const rows = data.contenus || [];
            contents.innerHTML = rows.length
            ? rows.map((c, idx) => `
                <div class="lf-import-content-row">
                <span class="sb-badge sb-badge--form">${idx + 1}</span>
                <div>
                    <strong>${htmlEsc(c.titre_sequence || "Contenu")}</strong>
                    <div class="card-sub">${htmlEsc(c.objectif || "")}</div>
                </div>
                </div>
            `).join("")
            : `<div class="card-sub">Aucun contenu détecté.</div>`;
        }

        const apply = byId("btnFormImportApply");
        if (apply) apply.disabled = false;
    }

    async function analyseImportDocument(portal){
        const input = byId("formImportFile");
        const file = input?.files?.[0] || null;

        if (!file){
            setImportStatus("Sélectionne d’abord un document PDF ou Word.", "error");
            return;
        }

        const btn = byId("btnFormImportAnalyse");
        if (btn){
            btn.disabled = true;
            btn.textContent = "Analyse en cours…";
        }

        try{
            const effectifId = getEffectifId();

            const fd = new FormData();
            fd.append("document", file);

            setImportStatus("Analyse du document en cours. Oui, cette fois le robot travaille vraiment.", "loading");

            const data = await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/import_document`,
            {
                method: "POST",
                body: fd
            }
            );

            _importDraft = data;
            renderImportPreview(data);
            setImportStatus("Analyse terminée. Vérifie les propositions avant de remplir la fiche.", "ok");

        } catch(e){
            _importDraft = null;

            const apply = byId("btnFormImportApply");
            if (apply) apply.disabled = true;

            setImportStatus(getErrorMessage(e), "error");
        } finally {
            if (btn){
            btn.disabled = false;
            btn.textContent = "Analyser le document";
            }
        }
    }

    function applyImportDraft(){
        const d = _importDraft;
        if (!d){
            setImportStatus("Aucune analyse à appliquer.", "error");
            return;
        }

        setFieldValue("formTitre", d.titre || "");
        setSelectValue("formEtat", "à valider");
        setSelectValue("formType", normalizeTypeFormation(d.type_formation || ""));
        setFieldValue("formObsType", d.obs_type_form || "");
        syncObsTypeFormation();

        setFieldValue("formDuree", d.duree ?? "");
        setFieldValue("formTarif", d.tarif_mini ?? "");
        setSelectValue("formDomaine", d.domaine || "");

        setFieldValue("formPresentation", d.presentation || "");
        setFieldValue("formPublic", d.public_cible || "");
        setFieldValue("formObjectifs", d.objectifs || "");

        _selectedModalites = normalizeIdArray(d.modalites_ids);
        _selectedPeda = normalizeIdArray(d.methode_peda_ids);
        _selectedEval = normalizeIdArray(d.methode_eval_ids);

        normalizePrerequis(d.prerequis || []);

        _selectedCompStag = importSelectedIds(d.competences_stagiaires_import || []);
        _selectedCompForm = importSelectedIds(d.competences_formateurs_import || []);

        _pendingCompStagCreate = importRowsToCreate(d.competences_stagiaires_import || []);
        _pendingCompFormCreate = importRowsToCreate(d.competences_formateurs_import || []);

        _pendingImportContenus = enrichImportContenusWithCompetences(
            Array.isArray(d.contenus) ? d.contenus : [],
            d
        );

        renderRefChecks();
        renderPrerequis();
        renderCompetences();
        renderContenus();

        setTab("identite");
        closeImportModal();
        setSuccess("Document importé dans la fiche");
    }

    function closeGenerateAiModal(){
        closeModal("modalFormGenerateAi");
        _aiGenerationDraft = null;

        const preview = byId("aiFormPreview");
        if (preview) preview.style.display = "none";

        const apply = byId("btnFormGenerateApply");
        if (apply) apply.disabled = true;

        const docs = byId("aiFormDocs");
        if (docs) docs.value = "";

        const docsLabel = byId("aiFormDocsLabel");
        if (docsLabel) docsLabel.textContent = "Aucun document sélectionné.";
    }

    function openGenerateAiModal(){
        if (_modalMode !== "create"){
            window.portal.showAlert("error", "La génération IA est disponible uniquement lors de la création d’une formation.");
            return;
        }

        _aiGenerationDraft = null;

        setFieldValue("aiFormObjectif", "");
        setFieldValue("aiFormContexte", "");
        setFieldValue("aiFormPublic", "");
        setFieldValue("aiFormDuree", "");
        setFieldValue("aiFormContraintes", "");

        const preview = byId("aiFormPreview");
        if (preview) preview.style.display = "none";

        const apply = byId("btnFormGenerateApply");
        if (apply) apply.disabled = true;

        const docs = byId("aiFormDocs");
        if (docs) docs.value = "";

        const docsLabel = byId("aiFormDocsLabel");
        if (docsLabel) docsLabel.textContent = "Aucun document sélectionné.";

        openModal("modalFormGenerateAi");
    }

    function openAiWait(){
        const msg = byId("aiWaitMessage");
        if (msg) msg.textContent = "Cette opération peut prendre quelques minutes.";

        window.clearTimeout(_aiLongTimer);
        _aiLongTimer = window.setTimeout(() => {
            const m = byId("aiWaitMessage");
            if (m) m.textContent = "La durée de cette opération est anormalement longue. Appuyez sur Échap pour annuler et relancer la génération.";
        }, 200000);

        openModal("modalFormAiWait");
    }

    function closeAiWait(){
        window.clearTimeout(_aiLongTimer);
        _aiLongTimer = null;
        closeModal("modalFormAiWait");
    }

    function cancelAiGeneration(){
        if (_aiAbortController){
            _aiAbortController.abort();
            _aiAbortController = null;
        }

        closeAiWait();
    }

    function renderGenerationPreview(data){
        const preview = byId("aiFormPreview");
        if (preview) preview.style.display = "";

        const summary = byId("aiFormSummary");
        if (summary){
            summary.innerHTML = `
            <div class="lf-result-title-card">
                <span>Titre</span>
                <strong>${htmlEsc(data.titre || "—")}</strong>
            </div>

            <div class="lf-result-summary-grid">
                <div class="lf-import-summary-item">
                <span>Durée proposée</span>
                <strong>${data.duree ? htmlEsc(data.duree) + " h" : "—"}</strong>
                </div>
                <div class="lf-import-summary-item">
                <span>Analyse durée</span>
                <strong>${htmlEsc(data.duree_statut || "—")}</strong>
                </div>
                <div class="lf-import-summary-item">
                <span>Contenus</span>
                <strong>${htmlEsc((data.contenus || []).length)}</strong>
                </div>
            </div>
            `;
        }

        renderImportCompetenceRows("aiFormCompStag", data.competences_stagiaires_import || []);
        renderImportCompetenceRows("aiFormCompForm", data.competences_formateurs_import || []);

        const contents = byId("aiFormContents");
        if (contents){
            const rows = data.contenus || [];
            contents.innerHTML = rows.length
            ? rows.map((c, idx) => `
                <div class="lf-import-content-row">
                <span class="sb-badge sb-badge--form">${idx + 1}</span>
                <div>
                    <strong>${htmlEsc(c.titre_sequence || "Contenu")}</strong>
                    <div class="card-sub">${htmlEsc(c.objectif || "")}</div>
                </div>
                </div>
            `).join("")
            : `<div class="card-sub">Aucun contenu proposé.</div>`;
        }

        const report = byId("aiFormReport");
        if (report) report.textContent = data.rapport_ia || "";

        const apply = byId("btnFormGenerateApply");
        if (apply) apply.disabled = false;
    }

    async function apiJsonMultipart(url, formData, signal){
        const headers = new Headers();

        try{
            if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function"){
            const session = await window.PortalAuthCommon.getSession();
            const token = session?.access_token || "";
            if (token) headers.set("Authorization", `Bearer ${token}`);
            }
        } catch(_){}

        const resp = await fetch(url, {
            method: "POST",
            headers,
            body: formData,
            signal
        });

        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        const body = ct.includes("application/json")
            ? await resp.json().catch(() => null)
            : await resp.text().catch(() => "");

        if (!resp.ok){
            const error = new Error(getErrorMessage(body) || `HTTP ${resp.status}`);
            error.status = resp.status;
            error.body = body;
            throw error;
        }

        return body;
    }

    async function generateFormationWithAi(portal){
        const objectif = (byId("aiFormObjectif")?.value || "").trim();
        if (!objectif){
            portal.showAlert("error", "Objectif de formation obligatoire.");
            return;
        }

        const effectifId = getEffectifId();
        const fd = new FormData();
        fd.append("objectif", objectif);
        fd.append("contexte", (byId("aiFormContexte")?.value || "").trim());
        fd.append("public_vise", (byId("aiFormPublic")?.value || "").trim());
        fd.append("duree_souhaitee", (byId("aiFormDuree")?.value || "").trim());
        fd.append("contraintes", (byId("aiFormContraintes")?.value || "").trim());

        const files = Array.from(byId("aiFormDocs")?.files || []);
        files.forEach(file => fd.append("documents", file));

        _aiAbortController = new AbortController();
        openAiWait();

        try{
            const data = await apiJsonMultipart(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/generate_ai`,
            fd,
            _aiAbortController.signal
            );

            _aiGenerationDraft = data;
            renderGenerationPreview(data);
        } catch(e){
            if (e?.name !== "AbortError"){
            portal.showAlert("error", getErrorMessage(e));
            }
        } finally {
            _aiAbortController = null;
            closeAiWait();
        }
    }

    function applyGeneratedFormation(){
        const d = _aiGenerationDraft;
        if (!d){
            window.portal.showAlert("error", "Aucune génération IA à appliquer.");
            return;
        }

        setFieldValue("formTitre", d.titre || "");
        setSelectValue("formEtat", "à valider");
        setSelectValue("formType", normalizeTypeFormation(d.type_formation || ""));
        setFieldValue("formObsType", d.obs_type_form || "");
        syncObsTypeFormation();

        setFieldValue("formDuree", d.duree ?? "");
        setFieldValue("formTarif", d.tarif_mini ?? "");
        setSelectValue("formDomaine", d.domaine || "");

        setFieldValue("formPresentation", d.presentation || "");
        setFieldValue("formPublic", d.public_cible || "");
        setFieldValue("formObjectifs", d.objectifs || "");

        _selectedModalites = normalizeIdArray(d.modalites_ids);
        _selectedPeda = normalizeIdArray(d.methode_peda_ids);
        _selectedEval = normalizeIdArray(d.methode_eval_ids);

        normalizePrerequis(d.prerequis || []);

        _selectedCompStag = importSelectedIds(d.competences_stagiaires_import || []);
        _selectedCompForm = importSelectedIds(d.competences_formateurs_import || []);

        _pendingCompStagCreate = importRowsToCreate(d.competences_stagiaires_import || []);
        _pendingCompFormCreate = importRowsToCreate(d.competences_formateurs_import || []);

        _pendingImportContenus = enrichImportContenusWithCompetences(
            Array.isArray(d.contenus) ? d.contenus : [],
            d
        );

        renderRefChecks();
        renderPrerequis();
        renderCompetences();
        renderContenus();

        setTab("identite");
        closeGenerateAiModal();
        setSuccess("Génération IA injectée dans la fiche");
    }

    function downloadAiReport(){
        const txt = (_aiGenerationDraft?.rapport_ia || "").trim();
        if (!txt){
            window.portal.showAlert("error", "Aucun rapport IA à télécharger.");
            return;
        }

        const title = (_aiGenerationDraft?.titre || "formation")
            .toString()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 80) || "formation";

        const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rapport_ia_${title}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function openCreate(portal){
        if (!isSupervisor()) return;
        setSuccess("");

        await ensureRefs(portal);

        _modalMode = "create";
        syncFormModeActions();
        _editingId = null;

        const b = byId("formModalBadge");
        if (b){
        b.style.display = "none";
        b.textContent = "";
        }

        byId("formModalTitle").textContent = "Créer une formation";

        byId("formTitre").value = "";
        byId("formEtat").value = "à valider";
        byId("formDomaine").value = "";
        byId("formFournisseur").value = "";
        setSelectValue("formType", "Non Certifiante");
        setFieldValue("formObsType", "");
        syncObsTypeFormation();
        byId("formDuree").value = "";
        byId("formTarif").value = "";
        byId("formPresentation").value = "";
        byId("formPublic").value = "";
        byId("formObjectifs").value = "";
        byId("formAttestation").value = "";

        _selectedModalites = [];
        _selectedPeda = [];
        _selectedEval = [];
        _selectedCompStag = [];
        _selectedCompForm = [];
        _prerequis = [];
        _detailContenus = [];
        _detailPlans = [];
        _pendingImportContenus = [];
        _pendingCompStagCreate = [];
        _pendingCompFormCreate = [];

        renderRefChecks();
        renderPrerequis();
        renderCompetences();
        renderContenus();
        renderPlans();

        setTab("identite");
        openModal("modalFormEdit");
    }

    async function openEdit(portal, it){
        if (!isSupervisor()) return;
        setSuccess("");

        try{
        await ensureRefs(portal);

        _modalMode = "edit";
        syncFormModeActions();
        _editingId = it?.id_form || null;

        if (!_editingId){
            throw new Error("Identifiant formation manquant.");
        }

        const badge = byId("formModalBadge");
        if (badge){
            badge.textContent = it?.code || "";
            badge.style.display = it?.code ? "" : "none";
        }

        const modalTitle = byId("formModalTitle");
        if (modalTitle){
            modalTitle.textContent = it?.titre || "Chargement de la formation…";
        }

        setFieldValue("formTitre", "");
        setSelectValue("formEtat", "à valider");
        setSelectValue("formDomaine", "");
        setSelectValue("formFournisseur", "");
        setFieldValue("formType", "");
        setFieldValue("formDuree", "");
        setFieldValue("formTarif", "");
        setFieldValue("formPresentation", "");
        setFieldValue("formPublic", "");
        setFieldValue("formObjectifs", "");
        setFieldValue("formAttestation", "");

        _selectedModalites = [];
        _selectedPeda = [];
        _selectedEval = [];
        _selectedCompStag = [];
        _selectedCompForm = [];
        _prerequis = [];
        _detailContenus = [];
        _detailPlans = [];

        renderRefChecks();
        renderPrerequis();
        renderCompetences();
        renderContenus();
        renderPlans();

        setTab("identite");
        openModal("modalFormEdit");

        const effectifId = getEffectifId();

        const d = await portal.apiJson(
            `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}`
        );

        fillFormationModal(d);

        } catch(e){
        closeModal("modalFormEdit");
        portal.showAlert("error", "Impossible de charger la fiche formation : " + (e?.message || String(e)));
        }
    }

  function buildPayload(){
    return {
      titre: (byId("formTitre").value || "").trim(),
      etat: (byId("formEtat").value || "à valider").trim(),
      domaine: (byId("formDomaine").value || "").trim() || null,
      fournisseur_formation: (byId("formFournisseur").value || "").trim() || null,
      type_formation: normalizeTypeFormation(byId("formType").value || ""),
      obs_type_form: (byId("formObsType")?.value || "").trim() || null,
      duree: (byId("formDuree").value || "").trim() || null,
      tarif_mini: (byId("formTarif").value || "").trim() || null,
      presentation: (byId("formPresentation").value || "").trim() || null,
      public_cible: (byId("formPublic").value || "").trim() || null,
      objectifs: (byId("formObjectifs").value || "").trim() || null,
      attestation_specifique: (byId("formAttestation").value || "").trim() || null,
      modalites: _selectedModalites,
      methode_peda: _selectedPeda,
      methode_eval: _selectedEval,
      competences_stagiaires: _selectedCompStag,
      competences_formateurs: _selectedCompForm,
      prerequis: buildPrerequisPayload()
    };
  }

  async function save(portal){
    if (!isSupervisor()) return;

    const effectifId = getEffectifId();
    const payload = buildPayload();

    if (!payload.titre){
      portal.showAlert("error", "Titre obligatoire.");
      setTab("identite");
      return;
    }

    if (_modalMode === "create"){
    const created = await portal.apiJson(
        `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`,
        {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
        }
    );

    _modalMode = "edit";
    _editingId = created?.id_form || _editingId;
    syncFormModeActions();

    const badge = byId("formModalBadge");
    if (badge && created?.code){
        badge.textContent = created.code;
        badge.style.display = "";
    }
    if (_editingId && _pendingImportContenus.length){
    for (const c of _pendingImportContenus){
        const payloadContent = {
        titre_sequence: (c.titre_sequence || "").trim() || "Contenu",
        objectif: (c.objectif || "").trim() || null,
        contenu: (c.contenu || "").trim() || null,
        competences_liees: Array.isArray(c.competences_liees) ? c.competences_liees : []
        };

        await portal.apiJson(
        `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}/contenus`,
        {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify(payloadContent)
        }
        );
    }

    _pendingImportContenus = [];
    await reloadFormationTechnicalDetail(portal);
    }
    } else {
    if (!_editingId) return;

    await portal.apiJson(
        `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_editingId)}`,
        {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
        }
    );
    }

    window.portal.showAlert("", "");
    setSuccess("Enregistré avec succès");

    await loadList(portal);
  }

  function openArchive(it){
    if (!isSupervisor()) return;

    _archiveId = it.id_form;
    byId("formArchiveMsg").textContent = `Archiver "${it.code || "—"} – ${it.titre || ""}" ?`;

    openModal("modalFormArchive");
  }

  async function confirmArchive(portal){
    const effectifId = getEffectifId();
    if (!_archiveId) return;

    await portal.apiJson(
      `${portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}/${encodeURIComponent(_archiveId)}/archive`,
      { method:"POST" }
    );

    _archiveId = null;

    closeModal("modalFormArchive");

    window.portal.showAlert("", "");
    setSuccess("");

    await loadList(portal);
  }

    async function fetchTextWithAuth(url){
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

        return await res.text();
        }

        function openHtmlFallbackWindow(title, htmlCode){
        const win = window.open("", "_blank");

        if (!win){
            throw new Error("Le navigateur a bloqué l’ouverture du code HTML.");
        }

        const safeTitle = htmlEsc(title || "HTML LMS");
        const safeCode = htmlEsc(htmlCode || "");

        win.document.open();
        win.document.write(`<!doctype html>
        <html lang="fr">
        <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <style>
        body{margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827}
        .wrap{max-width:1100px;margin:24px auto;padding:0 18px}
        h1{font-size:20px;margin:0 0 8px}
        p{color:#64748b;margin:0 0 14px}
        textarea{width:100%;height:72vh;border:1px solid #cbd5e1;border-radius:12px;padding:14px;font-family:Consolas,monospace;font-size:13px;box-sizing:border-box;background:#fff}
        </style>
        </head>
        <body>
        <div class="wrap">
        <h1>${safeTitle}</h1>
        <p>Copiez ce code HTML puis collez-le dans votre LMS.</p>
        <textarea>${safeCode}</textarea>
        </div>
        </body>
        </html>`);
        win.document.close();
        }

        async function copyFormationHtmlLms(it){
        const effectifId = getEffectifId();
        const formId = String(it?.id_form || "").trim();

        if (!effectifId) throw new Error("Profil Learn manquant.");
        if (!formId) throw new Error("Formation introuvable.");

        const title =
            `HTML LMS - ${
            String(it?.code || "").trim()
                ? `${String(it.code).trim()} - `
                : ""
            }${String(it?.titre || "").trim() || "Formation"}`;

        const url =
            `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(formId)}/fiche_html_lms`;

        const htmlCode = await fetchTextWithAuth(url);

        try{
            if (!navigator.clipboard || !navigator.clipboard.writeText){
            throw new Error("Clipboard indisponible.");
            }

            await navigator.clipboard.writeText(htmlCode);
            setSuccess("HTML LMS copié dans le presse-papiers");
        } catch(_){
            openHtmlFallbackWindow(title, htmlCode);
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
html,body{height:100%;margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827}
.pdf-loading{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
.pdf-loading__spinner{width:34px;height:34px;border-radius:999px;border:4px solid rgba(17,24,39,.12);border-top-color:#c2410c;animation:pdfSpin .8s linear infinite}
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

    async function openCompetencePdfFromFormation(c){
        const effectifId = getEffectifId();
        const compId = String(c?.id_comp || "").trim();

        if (!effectifId) throw new Error("Profil Learn manquant.");
        if (!compId) throw new Error("Compétence introuvable.");

        const title =
            `Fiche compétence - ${
            String(c?.code || "").trim()
                ? `${String(c.code).trim()} - `
                : ""
            }${String(c?.intitule || "").trim() || "Compétence"}`;

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

    async function openPlanPdf(p){
        const effectifId = getEffectifId();
        const formId = String(_editingId || "").trim();
        const planId = String(p?.id_plan_peda || "").trim();

        if (!effectifId) throw new Error("Profil Learn manquant.");
        if (!formId) throw new Error("Formation non chargée.");
        if (!planId) throw new Error("Plan pédagogique introuvable.");

        const title =
            `Plan pédagogique - ${
            String(p?.codification || "").trim()
                ? `${String(p.codification).trim()} - `
                : ""
            }${String(p?.titre || "").trim() || "Plan pédagogique"}`;

        let popupWin = null;

        try{
            popupWin = openPdfLoadingWindow(title);

            const url =
            `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(formId)}`
            + `/plans/${encodeURIComponent(planId)}/fiche_pdf`;

            const blob = await fetchPdfBlob(url);

            renderPdfBlobInWindow(popupWin, blob, title);
        } catch(e){
            if (popupWin && !popupWin.closed){
            try { popupWin.close(); } catch(_){}
            }

            throw e;
        }
        }

        function openPlanArchive(p){
        const planId = String(p?.id_plan_peda || "").trim();

        if (!planId){
            window.portal.showAlert("error", "Plan pédagogique introuvable.");
            return;
        }

        const label = `${p?.codification || "PLAN"} – ${p?.titre || "Plan pédagogique"}`;

        if (!window.confirm(`Archiver le plan pédagogique "${label}" ?`)){
            return;
        }

        archivePlan(p).catch(e => {
            window.portal.showAlert("error", getErrorMessage ? getErrorMessage(e) : (e?.message || String(e)));
        });
        }

        async function archivePlan(p){
        const effectifId = getEffectifId();
        const formId = String(_editingId || "").trim();
        const planId = String(p?.id_plan_peda || "").trim();

        if (!effectifId) throw new Error("Profil Learn manquant.");
        if (!formId) throw new Error("Formation non chargée.");
        if (!planId) throw new Error("Plan pédagogique introuvable.");

        await window.portal.apiJson(
            `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
            + `/${encodeURIComponent(formId)}`
            + `/plans/${encodeURIComponent(planId)}/archive`,
            { method:"POST" }
        );

        _detailPlans = _detailPlans.filter(x => String(x.id_plan_peda || "") !== planId);

        renderPlans();
        setSuccess("Plan pédagogique archivé");
    }
    
  async function openFormationPdf(it){
    const effectifId = getEffectifId();
    const formId = String(it?.id_form || "").trim();

    if (!effectifId) throw new Error("Profil Learn manquant.");
    if (!formId) throw new Error("Formation introuvable.");

    const title =
      `Fiche formation - ${
        String(it?.code || "").trim()
          ? `${String(it.code).trim()} - `
          : ""
      }${String(it?.titre || "").trim() || "Formation"}`;

    let popupWin = null;

    try{
      popupWin = openPdfLoadingWindow(title);

      const url =
        `${window.portal.apiBase}/learn/formations/${encodeURIComponent(effectifId)}`
        + `/${encodeURIComponent(formId)}/fiche_pdf`;

      const blob = await fetchPdfBlob(url);

      renderPdfBlobInWindow(popupWin, blob, title);
    } catch(e){
      if (popupWin && !popupWin.closed){
        try { popupWin.close(); } catch(_){}
      }

      throw e;
    }
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    syncFormModeActions();
    const bNew = byId("btnFormNew");

    if (bNew){
      bNew.style.display = isSupervisor() ? "" : "none";
      bNew.addEventListener("click", () => openCreate(portal));
    }

    document.querySelectorAll("#formTabs .sb-form-tab").forEach(btn => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab || "identite"));
    });


    byId("btnFormImport")?.addEventListener("click", openImportModal);

    byId("btnFormGenerateAi")?.addEventListener("click", openGenerateAiModal);

    byId("btnFormGenerateX")?.addEventListener("click", closeGenerateAiModal);
    byId("btnFormGenerateCancel")?.addEventListener("click", closeGenerateAiModal);
    byId("btnFormGenerateRun")?.addEventListener("click", () => generateFormationWithAi(portal));
    byId("btnFormGenerateApply")?.addEventListener("click", applyGeneratedFormation);
    byId("btnAiReportDownload")?.addEventListener("click", downloadAiReport);

    byId("aiFormDocs")?.addEventListener("change", () => {
    const files = Array.from(byId("aiFormDocs")?.files || []);
    const label = byId("aiFormDocsLabel");
    if (label){
        label.textContent = files.length
        ? files.map(f => f.name).join(", ")
        : "Aucun document sélectionné.";
    }
    });

    document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _aiAbortController){
        cancelAiGeneration();
    }
    });

    byId("btnFormImportX")?.addEventListener("click", closeImportModal);
    byId("btnFormImportCancel")?.addEventListener("click", closeImportModal);

    byId("formImportFile")?.addEventListener("change", () => {
    const file = byId("formImportFile")?.files?.[0] || null;
    const name = byId("formImportFileName");

    if (name){
        name.textContent = file ? file.name : "Aucun fichier sélectionné";
    }

    _importDraft = null;

    const preview = byId("formImportPreview");
    if (preview) preview.style.display = "none";

    const apply = byId("btnFormImportApply");
    if (apply) apply.disabled = true;

    setImportStatus("", "");
    });

    byId("btnFormImportAnalyse")?.addEventListener("click", () => analyseImportDocument(portal));
    byId("btnFormImportApply")?.addEventListener("click", applyImportDraft);

    byId("btnFormAiReview")?.addEventListener("click", () => {
      portal.showAlert("error", "La révision IA des textes sera câblée après finalisation du modal formation.");
    });

    byId("btnFormX")?.addEventListener("click", () => {
    setSuccess("");
    closeModal("modalFormEdit");
    });

    byId("btnFormCancel")?.addEventListener("click", () => {
    setSuccess("");
    closeModal("modalFormEdit");
    });

    byId("btnFormSave")?.addEventListener("click", async () => {
      try {
        await save(portal);
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

    byId("btnFormArchiveX")?.addEventListener("click", () => closeModal("modalFormArchive"));
    byId("btnFormArchiveCancel")?.addEventListener("click", () => closeModal("modalFormArchive"));

    byId("btnFormArchiveConfirm")?.addEventListener("click", async () => {
      try {
        await confirmArchive(portal);
      } catch(e){
        portal.showAlert("error", e?.message || String(e));
      }
    });

    byId("btnFormPrereqAdd")?.addEventListener("click", addPrerequis);
    byId("formType")?.addEventListener("change", syncObsTypeFormation);

    byId("btnFormPlanNew")?.addEventListener("click", () => openPlanModal(null));

    byId("btnFormPlanX")?.addEventListener("click", closePlanModal);
    byId("btnFormPlanCancel")?.addEventListener("click", closePlanModal);

    byId("btnPlanBlockAdd")?.addEventListener("click", addPlanBlock);

    byId("planContentSearch")?.addEventListener("input", () => {
    _planContentSearch = (byId("planContentSearch")?.value || "").trim();
    renderPlanContentLibrary();
    });

    byId("planModaliteGenerale")?.addEventListener("change", () => {
    renderPlanBlocks();
    });

    byId("btnFormPlanSave")?.addEventListener("click", async () => {
    try{
        await savePlan(portal);
    } catch(e){
        portal.showAlert("error", getErrorMessage(e));
    }
    });

    byId("btnFormContentAdd")?.addEventListener("click", () => openContentModal(null));

    byId("btnFormContentX")?.addEventListener("click", closeContentModal);
    byId("btnFormContentCancel")?.addEventListener("click", closeContentModal);

    byId("btnFormContentSave")?.addEventListener("click", async () => {
    try{
        await saveContent(portal);
    } catch(e){
        portal.showAlert("error", e?.message || String(e));
    }
    });
    byId("btnFormCompStagAdd")?.addEventListener("click", () => openCompPicker("stagiaire"));
    byId("btnFormCompFormAdd")?.addEventListener("click", () => openCompPicker("formateur"));

    byId("btnFormCompPickerX")?.addEventListener("click", closeCompPicker);
    byId("btnFormCompPickerCancel")?.addEventListener("click", closeCompPicker);
    byId("btnFormCompPickerApply")?.addEventListener("click", applyCompPickerSelection);

    byId("formCompPickerSearch")?.addEventListener("input", () => {
    _compPickerSearch = (byId("formCompPickerSearch")?.value || "").trim();
    renderCompPickerList();
    });

    byId("formCompPickerDomain")?.addEventListener("change", () => {
    _compPickerDomain = (byId("formCompPickerDomain")?.value || "").trim();
    renderCompPickerList();
    });

    const s = byId("catFormsSearch");

    s?.addEventListener("input", () => {
      _q = (s.value || "").trim();

      if (_qTimer) clearTimeout(_qTimer);

      _qTimer = setTimeout(() => {
        loadList(portal).catch(() => {});
      }, 250);
    });

    const sh = byId("catFormsShow");

    sh?.addEventListener("change", () => {
      _show = (sh.value || "active").trim();

      loadList(portal).catch(e => {
        portal.showAlert("error", e?.message || String(e));
      });
    });

    const domSel = byId("catFormsDomain");

    domSel?.addEventListener("change", () => {
      _dom = (domSel.value || "").trim();

      loadList(portal).catch(e => {
        portal.showAlert("error", e?.message || String(e));
      });
    });
  }

  async function init(){
    try {
      await (window.__learnAuthReady || Promise.resolve(null));
    } catch(_){}

    const portal = window.portal;
    if (!portal) return;

    await ensureContext(portal);
    await ensureRefs(portal);
    bindOnce(portal);
    await loadList(portal);
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert("error", "Erreur catalogue formations : " + (e?.message || e));
    }
  });
})();