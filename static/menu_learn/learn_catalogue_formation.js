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

  let _detailContenus = [];
  let _detailPlans = [];

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

  function renderCompetenceList(hostId, searchId, selected, onChange){
    const host = byId(hostId);
    if (!host) return;

    const q = (byId(searchId)?.value || "").trim().toLowerCase();
    const rows = (_refs?.competences || []).filter(c => {
      if (!q) return true;

      return [
        c.code || "",
        c.intitule || "",
        c.domaine_titre_court || "",
        c.domaine_titre || ""
      ].join(" ").toLowerCase().includes(q);
    });

    host.innerHTML = "";

    rows.forEach(c => {
      const id = String(c.id_comp || "").trim();
      if (!id) return;

      const row = document.createElement("label");
      row.className = "lf-ref-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.includes(id);
      cb.addEventListener("change", () => onChange(id, cb.checked));

      const txt = document.createElement("div");
      txt.className = "lf-ref-text";
      txt.innerHTML = `
        <span class="sb-badge sb-badge--comp">${htmlEsc(c.code || "—")}</span>
        <span>${htmlEsc(c.intitule || "")}</span>
      `;

      row.appendChild(cb);
      row.appendChild(txt);

      host.appendChild(row);
    });

    if (!host.children.length){
      const empty = document.createElement("div");
      empty.className = "card-sub";
      empty.textContent = "Aucune compétence trouvée.";
      host.appendChild(empty);
    }
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

  function renderCompetences(){
    renderCompetenceList(
      "formCompStagList",
      "formCompStagSearch",
      _selectedCompStag,
      (id, checked) => {
        _selectedCompStag = toggleIn(_selectedCompStag, id, checked);
        renderCompetences();
      }
    );

    renderCompetenceList(
      "formCompFormList",
      "formCompFormSearch",
      _selectedCompForm,
      (id, checked) => {
        _selectedCompForm = toggleIn(_selectedCompForm, id, checked);
        renderCompetences();
      }
    );
  }

  function renderContenus(){
    const host = byId("formContenusList");
    if (!host) return;

    host.innerHTML = "";

    if (!_detailContenus.length){
      host.innerHTML = `<div class="card-sub">Aucun contenu détaillé n’est encore rattaché à cette formation.</div>`;
      return;
    }

    _detailContenus.forEach(l => {
      const div = document.createElement("div");
      div.className = "lf-mini-card";
      div.innerHTML = `
        <div class="lf-mini-title">${htmlEsc(l.titre_sequence || "Séquence")}</div>
        <div class="card-sub">${htmlEsc(l.objectif || "")}</div>
        <div class="lf-mini-body">${htmlEsc(l.contenu || "—").replaceAll("\n", "<br>")}</div>
      `;
      host.appendChild(div);
    });
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
      div.className = "lf-mini-card";
      div.innerHTML = `
        <div class="lf-mini-title">
          <span class="sb-badge sb-badge--plan">${htmlEsc(p.codification || "PLAN")}</span>
          ${htmlEsc(p.titre || "Plan pédagogique")}
        </div>
        <div class="card-sub">
          ${htmlEsc(p.modalite_generale || "—")} • ${htmlEsc(p.duree_totale || "0")} h • ${htmlEsc(p.nb_blocs || "0")} bloc(s)
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

  async function openCreate(portal){
    if (!isSupervisor()) return;
    setSuccess("");

    await ensureRefs(portal);

    _modalMode = "create";
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

    const badge = byId("formModalBadge");
    if (badge && created?.code){
        badge.textContent = created.code;
        badge.style.display = "";
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

    const bNew = byId("btnFormNew");

    if (bNew){
      bNew.style.display = isSupervisor() ? "" : "none";
      bNew.addEventListener("click", () => openCreate(portal));
    }

    document.querySelectorAll("#formTabs .sb-form-tab").forEach(btn => {
      btn.addEventListener("click", () => setTab(btn.dataset.tab || "identite"));
    });

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
    byId("formCompStagSearch")?.addEventListener("input", renderCompetences);
    byId("formCompFormSearch")?.addEventListener("input", renderCompetences);

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