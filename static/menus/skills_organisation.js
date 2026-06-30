(function () {
  const NON_LIE_ID = "__NON_LIE__";
  const TOUS_SERVICES_ID = "__ALL__";


  let _bound = false;
  let _servicesLoaded = false;

  let _selectedServiceId = null;
  let _serviceIndex = new Map();     // id_service -> node
  let _postesCache = new Map();      // id_service -> postes[]
  let _currentPostes = [];           // postes courants (pour filtre)

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function repairAiTextEncodingGlitches(value) {
    let s = String(value ?? "");
    if (!s) return "";

    try {
      if (/&(?:[a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/.test(s)) {
        const ta = document.createElement("textarea");
        ta.innerHTML = s;
        s = ta.value;
      }
    } catch (_) {}

    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
      try { return String.fromCharCode(parseInt(h, 16)); } catch (_) { return _; }
    });

    const cp1252 = {"91":"‘", "92":"’", "93":"“", "94":"”", "95":"•", "96":"–", "97":"—", "9c":"œ", "8c":"Œ", "a0":" ", "ab":"«", "bb":"»"};
    s = s.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => cp1252[String(h || "").toLowerCase()] || m);

    const letters = "A-Za-zÀ-ÖØ-öø-ÿ";
    s = s.replace(new RegExp("\\b([ldjtmncsLDJTMNCS])(?:b4|92|4)(?=[" + letters + "])", "g"), "$1’");
    s = s.replace(/\b9c(?=uvre|uvr|il|ufs?\b)/gi, "œ");
    s = s.replace(/\b9(?=uvre|uvr|il|ufs?\b)/gi, "œ");

    [["e0","à"], ["e7","ç"], ["e8","è"], ["e9","é"], ["f4","ô"], ["f9","ù"], ["c7","Ç"], ["c8","È"], ["c9","É"], ["d9","Ù"]]
      .forEach(([code, ch]) => {
        s = s.replace(new RegExp("([" + letters + "])" + code + "(?=[" + letters + "])", "g"), (_, p1) => p1 + ch);
        s = s.replace(new RegExp("\\b" + code + "(?=[" + letters + "])", "g"), ch);
      });

    return s;
  }

    function byId(id){ return document.getElementById(id); }

  function setOrgPosteTab(tab){
    const modal = byId("modalOrgPoste");
    if (!modal) return;

    modal.querySelectorAll("#orgPosteTabbar [data-tab]").forEach(btn => {
      const isOn = (btn.getAttribute("data-tab") === tab);
      btn.classList.toggle("is-active", isOn);
      btn.setAttribute("aria-selected", isOn ? "true" : "false");
    });

    modal.querySelectorAll(".sb-tab-panel").forEach(p => {
      const isOn = (p.getAttribute("data-panel") === tab);
      p.classList.toggle("is-active", isOn);
    });
  }

  async function openOrgPosteModal(p){
    const portal = window.__skillsPortalInstance;
    if (!portal) return;

    const modal = document.getElementById("modalOrgPoste");
    if (!modal) return;

    const badge = document.getElementById("orgPosteModalBadge");
    const title = document.getElementById("orgPosteModalTitle");

    const code = ((p?.codif_client || p?.codif_poste || "") + "").trim();
    const lib = ((p?.intitule_poste || "") + "").trim();
    const id_poste = (p?.id_poste || "").trim();

    // Contexte (utile pour save RH)
    modal.setAttribute("data-id-poste", id_poste);

    // Reset RH édition
    _rhEdit.editing = false;
    _rhEdit.snapshot = null;
    _setRhEditMode(false);

    // Header
    if (badge){
      if (code){
        badge.textContent = code;
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }
    }
    if (title){
      title.textContent = lib || "Poste";
    }

    // Ouvre le modal + onglet def
    setOrgPosteTab("def");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    // Placeholder rapide (évite effet “vide”)
    fillPosteDefinitionTab({
      mission_principale: "",
      responsabilites_html: "",
      responsabilites: "",
      isresponsable: !!p?.isresponsable,
      date_maj: ""
    });

    fillPosteContraintesTab({});
    fillPosteCompetencesTab({ competences: [] });
    fillPosteCertificationsTab({ certifications: [] });
    fillPosteParamRhTab({});
    fillPosteCotationTab({ __force_empty: true });


    // Détail (fetch)
    try {
      if (!id_poste) return;
      const detail = await fetchPosteDetail(portal, id_poste);
      fillPosteDefinitionTab(detail);
      fillPosteContraintesTab(detail);
      fillPosteCompetencesTab(detail);
      fillPosteCertificationsTab(detail);
      fillPosteParamRhTab(detail);
    } catch (e) {
      portal.showAlert("error", "Erreur chargement poste : " + e.message);
    }
  }


  function closeOrgPosteModal(){
    const modal = byId("modalOrgPoste");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function bindOrgPosteModalOnce(){
    const modal = byId("modalOrgPoste");
    if (!modal) return;

    if (modal.getAttribute("data-bound") === "1") return;
    modal.setAttribute("data-bound", "1");

    // Close buttons
    byId("orgPosteModalClose")?.addEventListener("click", closeOrgPosteModal);
    byId("orgPosteModalX")?.addEventListener("click", closeOrgPosteModal);

    // Click backdrop (zone grisée = .modal)
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeOrgPosteModal();
    });

    // Tabs
    modal.querySelectorAll("#orgPosteTabbar [data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        setOrgPosteTab(tab);
      });
    });

    // Param RH buttons (bind once)
    const btnEdit = byId("orgRhBtnEdit");
    const btnSave = byId("orgRhBtnSave");
    const btnCancel = byId("orgRhBtnCancel");

    if (btnEdit && !btnEdit._sbBound){
      btnEdit._sbBound = true;
      btnEdit.addEventListener("click", (e) => {
        e.preventDefault();
        _rhEnterEditMode();
      });
    }

    if (btnCancel && !btnCancel._sbBound){
      btnCancel._sbBound = true;
      btnCancel.addEventListener("click", (e) => {
        e.preventDefault();
        _rhCancelEdit();
      });
    }

    if (btnSave && !btnSave._sbBound){
      btnSave._sbBound = true;
      btnSave.addEventListener("click", (e) => {
        e.preventDefault();
        _rhSaveEdit();
      });
    }

    // Contraintes buttons (bind once)
    const btnCtrEdit = byId("orgCtrBtnEdit");
    const btnCtrSave = byId("orgCtrBtnSave");
    const btnCtrCancel = byId("orgCtrBtnCancel");
    const btnCompMore = byId("orgPosteCompMore");

    if (btnCtrEdit && !btnCtrEdit._sbBound){
      btnCtrEdit._sbBound = true;
      btnCtrEdit.addEventListener("click", (e) => {
        e.preventDefault();
        _ctrEnterEditMode();
      });
    }

    if (btnCtrCancel && !btnCtrCancel._sbBound){
      btnCtrCancel._sbBound = true;
      btnCtrCancel.addEventListener("click", (e) => {
        e.preventDefault();
        _ctrCancelEdit();
      });
    }

    if (btnCtrSave && !btnCtrSave._sbBound){
      btnCtrSave._sbBound = true;
      btnCtrSave.addEventListener("click", (e) => {
        e.preventDefault();
        _ctrSaveEdit();
      });
    }

    if (btnCompMore && !btnCompMore._sbBound){
      btnCompMore._sbBound = true;
      btnCompMore.addEventListener("click", (e) => {
        e.preventDefault();
        _orgCompState.expanded = !_orgCompState.expanded;
        _renderPosteCompetencesRows();
      });
    }

    bindOrgCompCritModalOnce();
    bindOrgCertValidModalOnce();

    const clearCtrOnChange = byId("orgPosteBlocContraintes");
    if (clearCtrOnChange && !clearCtrOnChange._sbInlineClearBound){
      clearCtrOnChange._sbInlineClearBound = true;
      ["input", "change"].forEach(evtName => {
        clearCtrOnChange.addEventListener(evtName, () => _clearInlineMsg("orgCtrMsg"));
      });
    }

    const clearRhOnChange = byId("orgPosteBlocRh");
    if (clearRhOnChange && !clearRhOnChange._sbInlineClearBound){
      clearRhOnChange._sbInlineClearBound = true;
      ["input", "change"].forEach(evtName => {
        clearRhOnChange.addEventListener(evtName, () => _clearInlineMsg("orgRhMsg"));
      });
    }


    // Esc
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("show")) {
        closeOrgPosteModal();
      }
    });
  }


    // ============================
  // Paramétrage RH: édition / save / cancel
  // ============================
  let _rhEdit = { editing:false, snapshot:null };

  function _rhGetEditableIds(){
    return [
      "orgRhStatut",
      "orgRhCriticite",
      "orgRhStrategie",
      "orgRhNbTitulaires",
      "orgRhDateDebut",
      "orgRhDateFin",
      "orgRhCommentaire"
    ];
  }

  function _rhSetDisabled(ids, disabled){
    ids.forEach(id => {
      const el = byId(id);
      if (el) el.disabled = !!disabled;
    });
  }

  function _rhSetButtons(editing){
    const btnEdit = byId("orgRhBtnEdit");
    const btnSave = byId("orgRhBtnSave");
    const btnCancel = byId("orgRhBtnCancel");

    if (btnEdit) btnEdit.style.display = editing ? "none" : "";
    if (btnSave) btnSave.style.display = editing ? "" : "none";
    if (btnCancel) btnCancel.style.display = editing ? "" : "none";
  }

  function _rhFormatNowDateOnly(){
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear());
    return `${dd}/${mm}/${yy}`;
  }

    function _rhIsStatutSansFin(statut){
    const s = (statut || "").toString().trim().toLowerCase();
    return (s === "actif" || s === "a_pourvoir");
  }

  function _rhApplyFinValiditeVisibility(){
    const sel = byId("orgRhStatut");
    const statut = sel ? sel.value : "";

    const inputFin = byId("orgRhDateFin");
    if (!inputFin) return;

    // On masque le bloc complet (label + input)
    const wrap = inputFin.closest(".sb-field") || inputFin.parentElement;
    if (!wrap) return;

    if (_rhIsStatutSansFin(statut)){
      wrap.style.display = "none";
      inputFin.value = "";
      inputFin.disabled = true;
    } else {
      wrap.style.display = "";
      inputFin.disabled = !_rhEdit.editing;
    }
  }

  function _rhBindStatutChangeOnce(){
    const sel = byId("orgRhStatut");
    if (!sel || sel._sbRhBound) return;
    sel._sbRhBound = true;

    sel.addEventListener("change", () => {
      _rhApplyFinValiditeVisibility();
    });
  }

  function _rhReadForm(){
    return {
      statut_poste: (byId("orgRhStatut")?.value || "").trim(),
      criticite_poste: (byId("orgRhCriticite")?.value || "").trim(),
      strategie_pourvoi: (byId("orgRhStrategie")?.value || "").trim(),
      nb_titulaires_cible: (byId("orgRhNbTitulaires")?.value || "").trim(),
      date_debut_validite: (byId("orgRhDateDebut")?.value || "").trim(),
      date_fin_validite: (byId("orgRhDateFin")?.value || "").trim(),
      param_rh_commentaire: (byId("orgRhCommentaire")?.value ?? "").toString(),

      // affichage (read-only)
      param_rh_source: (byId("orgRhSource")?.value || "").trim(),
      param_rh_date_maj: (byId("orgRhDateMaj")?.value || "").trim()
    };
  }

  function _rhWriteForm(v){
    _selectByStoredValue("orgRhStatut", v?.statut_poste);
    _selectByStoredValue("orgRhCriticite", (v?.criticite_poste ?? "").toString());
    _selectByStoredValue("orgRhStrategie", v?.strategie_pourvoi);

    _setValue("orgRhNbTitulaires", (v?.nb_titulaires_cible ?? "").toString());
    _setValue("orgRhDateDebut", (v?.date_debut_validite ?? "").toString());
    _setValue("orgRhDateFin", (v?.date_fin_validite ?? "").toString());
    _setValue("orgRhCommentaire", (v?.param_rh_commentaire ?? "").toString());

    _setValue("orgRhSource", (v?.param_rh_source ?? "").toString());
    _setValue("orgRhDateMaj", (v?.param_rh_date_maj ?? "").toString());
  }

  function _rhSelectedText(selectId){
    const el = byId(selectId);
    if (!el) return "";
    const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    return (opt?.textContent || "").trim();
  }

  function _rhSyncViewFromCurrentForm(){
    _setText("orgRhViewStatut", _rhSelectedText("orgRhStatut"));
    _setText("orgRhViewCriticite", _rhSelectedText("orgRhCriticite"));
    _setText("orgRhViewStrategie", _rhSelectedText("orgRhStrategie"));
    _setText("orgRhViewNbTitulaires", byId("orgRhNbTitulaires")?.value || "");
    _setText("orgRhViewDateDebut", formatDateOnly(byId("orgRhDateDebut")?.value || ""));
    _setText("orgRhViewSource", byId("orgRhSource")?.value || "");
    _setText("orgRhViewDateMaj", byId("orgRhDateMaj")?.value || "");
    _setText("orgRhViewCommentaire", byId("orgRhCommentaire")?.value || "");

    const finRow = byId("orgRhViewDateFinRow");
    const finVal = formatDateOnly(byId("orgRhDateFin")?.value || "");
    _setText("orgRhViewDateFin", finVal);
    if (finRow) finRow.style.display = finVal ? "" : "none";
  }

  function _pickFirstString(obj, keys){
    for (const key of keys){
      const v = obj?.[key];
      if (v !== null && v !== undefined){
        const s = String(v).trim();
        if (s) return s;
      }
    }
    return "";
  }

  function fillPosteCotationTab(detail){
    if (detail?.__force_empty){
      _setText("orgRhCotationCategorie", "");
      _setText("orgRhCotationCoefficient", "");
      return;
    }

    const categorieKeys = [
      "rh_cotation_categorie_retendue",
      "rh_categorie_retendue",
      "categorie_retendue",
      "categorie_retenue",
      "categorie_conventionnelle",
      "categorie_conventionnelle_retendue",
      "categorie_professionnelle"
    ];

    const coefficientKeys = [
      "rh_cotation_coefficient_palier_retenu",
      "rh_coefficient_palier_retenu",
      "coefficient_palier_retenu",
      "coefficient_palier",
      "coefficient_palier_affichage"
    ];

    const coeffOnlyKeys = [
      "rh_cotation_coefficient_retenu",
      "rh_coefficient_retenu",
      "coefficient_retenu",
      "coefficient"
    ];

    const palierKeys = [
      "rh_cotation_palier_retenu",
      "rh_palier_retenu",
      "palier_retenu",
      "palier"
    ];

    const hasRawCotation = [...categorieKeys, ...coefficientKeys, ...coeffOnlyKeys, ...palierKeys]
      .some(key => {
        const v = detail?.[key];
        return v !== null && v !== undefined && String(v).trim() !== "";
      });

    if (!hasRawCotation) return;

    const categorie = _pickFirstString(detail, categorieKeys);

    let coefficient = _pickFirstString(detail, coefficientKeys);

    if (!coefficient){
      const coeff = _pickFirstString(detail, coeffOnlyKeys);
      const palierRaw = _pickFirstString(detail, palierKeys);
      let palier = palierRaw;
      if (palier && !/^palier\b/i.test(palier)) palier = `Palier ${palier}`;
      coefficient = [coeff, palier].filter(Boolean).join(" / ");
    }

    _setText("orgRhCotationCategorie", categorie);
    _setText("orgRhCotationCoefficient", coefficient);
  }

  function _setRhEditMode(editing){
    _rhEdit.editing = !!editing;

    // source + date maj restent toujours non éditables
    _rhSetDisabled(["orgRhSource", "orgRhDateMaj"], true);

    // champs RH
    _rhSetDisabled(_rhGetEditableIds(), !editing);

    // stepper
    const minus = byId("orgRhNbMinus");
    const plus = byId("orgRhNbPlus");
    if (minus) minus.disabled = !editing;
    if (plus) plus.disabled = !editing;

    const bloc = byId("orgPosteBlocRh");
    const view = byId("orgRhView");
    const edit = byId("orgRhEdit");
    if (bloc) bloc.classList.toggle("is-editing", !!editing);
    if (view) view.style.display = editing ? "none" : "";
    if (edit) edit.style.display = editing ? "" : "none";

    _rhSetButtons(editing);
    _rhApplyFinValiditeVisibility();
    _rhSyncViewFromCurrentForm();
  }

  function _rhEnterEditMode(){
    if (_rhEdit.editing) return;

    _rhEdit.snapshot = _rhReadForm();
    _setRhEditMode(true);

    // affichage immédiat (sans attendre le serveur)
    _setValue("orgRhSource", "insights");
    _setValue("orgRhDateMaj", _rhFormatNowDateOnly());
  }

  function _rhCancelEdit(){
    if (!_rhEdit.editing) return;

    if (_rhEdit.snapshot){
      _rhWriteForm(_rhEdit.snapshot);
    }
    _rhEdit.snapshot = null;
    _setRhEditMode(false);
  }

  async function _rhSaveEdit(){
    const portal = window.__skillsPortalInstance;
    if (!portal) return;

    const modal = byId("modalOrgPoste");
    const id_poste = modal?.getAttribute("data-id-poste") || "";
    if (!id_poste) {
      _showInlineMsg("orgRhMsg", "danger", "Impossible d’enregistrer : id_poste manquant.");
      return;
    }

    const v = _rhReadForm();

    // Validation minimale dates (contrainte DB)
    const d1 = v.date_debut_validite || "";
    const d2 = v.date_fin_validite || "";
    if (d1 && d2 && d2 < d1){
      _showInlineMsg("orgRhMsg", "danger", "La date de fin doit être ≥ à la date de début.");
      return;
    }

    const statutNorm = (v.statut_poste || "actif").trim().toLowerCase();

    // Defaults si l'utilisateur laisse "—"
    const payload = {
      statut_poste: statutNorm || "actif",
      criticite_poste: Number(v.criticite_poste || 2),
      strategie_pourvoi: v.strategie_pourvoi || "mixte",
      nb_titulaires_cible: Number(v.nb_titulaires_cible || 1),
      date_debut_validite: v.date_debut_validite || null,
      date_fin_validite: _rhIsStatutSansFin(statutNorm) ? null : (v.date_fin_validite || null),
      param_rh_commentaire: (v.param_rh_commentaire || "").trim() || null
      // source/date_maj/verrouille forcés côté API
    };

    try {
      const url = `${portal.apiBase}/skills/organisation/poste_param_rh_update/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_poste)}`;

      const updated = await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const merged = Object.assign({}, _posteDetailCache.get(id_poste) || {}, updated || {});

      // cache détail
      _posteDetailCache.set(id_poste, merged);

      // refresh UI (retour lecture)
      fillPosteParamRhTab(merged);
      _showInlineMsg("orgRhMsg", "success", "Paramétrage RH enregistré.");
      
    } catch (e) {
      _showInlineMsg("orgRhMsg", "danger", "Erreur enregistrement RH : " + e.message);
    }
  }


  function _countServicesForSelection(id_service) {
    if (id_service === TOUS_SERVICES_ID) {
      let count = 0;
      _serviceIndex.forEach((node, key) => {
        if (key !== TOUS_SERVICES_ID && key !== NON_LIE_ID) count += 1;
      });
      return count;
    }
    if (id_service === NON_LIE_ID) return 0;
    return id_service ? 1 : 0;
  }

  function updateServiceStats(node, postes) {
    const statPostes = document.getElementById("orgStatPostes");
    const statCollabs = document.getElementById("orgStatCollabs");
    const statServices = document.getElementById("orgStatServices");
    const list = Array.isArray(postes) ? postes : [];
    const nbPostes = list.length;
    const nbEff = list.reduce((sum, item) => sum + Number(item?.nb_effectifs || 0), 0);
    const nbServices = _countServicesForSelection(node?.id_service || "");
    if (statPostes) statPostes.textContent = String(nbPostes);
    if (statCollabs) statCollabs.textContent = String(nbEff);
    if (statServices) statServices.textContent = String(nbServices);
  }

  function setServiceHeader(node) {
    const title = document.getElementById("orgServiceTitle");
    const meta = document.getElementById("orgServiceMeta");

    if (!node) {
      if (title) title.textContent = "Service non sélectionné";
      if (meta) meta.textContent = "—";
      updateServiceStats(null, []);
      return;
    }

    if (title) title.textContent = node.nom_service || "Service";
    const nbPostes = node.nb_postes ?? 0;
    const nbEff = node.nb_effectifs ?? 0;
    if (meta) meta.textContent = `${nbPostes} poste(s) · ${nbEff} collaborateur(s)`;
  }

  function setActiveTreeItem(id_service) {
    document.querySelectorAll("#orgTree .sb-tree-item").forEach(el => {
      el.classList.toggle("active", el.getAttribute("data-id") === id_service);
    });
  }

  function indexNodes(nodes) {
    function rec(list) {
      (list || []).forEach(n => {
        _serviceIndex.set(n.id_service, n);
        if (n.children && n.children.length) rec(n.children);
      });
    }
    rec(nodes);
  }

  function renderTree(nodes) {
    const tree = document.getElementById("orgTree");
    if (!tree) return;

    tree.innerHTML = "";
    _serviceIndex.clear();
    indexNodes(nodes);

    function rec(list, depth) {
      (list || []).forEach(n => {
        const item = document.createElement("div");
        item.className = "sb-tree-item";
        item.setAttribute("data-id", n.id_service);
        item.setAttribute("data-depth", String(depth));
        if (depth > 0) item.classList.add("org-tree-item-child");

        item.innerHTML = `
          <div class="sb-tree-name">${escapeHtml(n.nom_service || "Sans nom")}</div>
          <div class="org-tree-arrow" aria-hidden="true">›</div>
        `;

        item.addEventListener("click", () => selectService(n.id_service));
        tree.appendChild(item);

        if (n.children && n.children.length) rec(n.children, depth + 1);
      });
    }

    rec(nodes, 0);

    // sélection par défaut: Tous les services si présent, sinon premier service
    const tous = (nodes || []).find(x => x.id_service === TOUS_SERVICES_ID);
    if (tous) selectService(TOUS_SERVICES_ID);
    else if ((nodes || []).length > 0) selectService(nodes[0].id_service);
  }

  async function resolveInsightsAccessToken() {
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        if (session && session.access_token) return String(session.access_token);
      }
    } catch (_) {}
    return "";
  }

  function getFilenameFromContentDisposition(value){
    const raw = String(value || "").trim();
    if (!raw) return "";
    const star = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (star && star[1]){
      try { return decodeURIComponent(star[1]).replace(/^["']|["']$/g, "").trim(); }
      catch(_) { return String(star[1]).replace(/^["']|["']$/g, "").trim(); }
    }
    const quoted = raw.match(/filename\s*=\s*"([^"]+)"/i);
    if (quoted && quoted[1]) return String(quoted[1]).trim();
    const plain = raw.match(/filename\s*=\s*([^;]+)/i);
    if (plain && plain[1]) return String(plain[1]).replace(/^["']|["']$/g, "").trim();
    return "";
  }

  function sanitizePdfFilenamePart(value, fallback) {
    let s = String(value || "").trim();
    if (!s) s = String(fallback || "Document").trim();
    s = s.replace(/[\/:*?"<>|]+/g, " ");
    s = s.replace(/\s+/g, " ").trim().replace(/^[ ._-]+|[ ._-]+$/g, "");
    return s || String(fallback || "Document").trim() || "Document";
  }

  function buildPdfFilename(code, title, fallbackCode, fallbackTitle) {
    const c = sanitizePdfFilenamePart(code, fallbackCode || "Document");
    const t = sanitizePdfFilenamePart(title, fallbackTitle || "PDF");
    return `${c} - ${t}.pdf`;
  }

  async function fetchOrganisationPdfBlob(url, fallbackFilename) {
    const headers = {};
    const token = await resolveInsightsAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
    if (!resp.ok) {
      let msg = `Erreur PDF (${resp.status})`;
      try { const err = await resp.json(); if (err && err.detail) msg = String(err.detail); } catch (_) {}
      throw new Error(msg);
    }
    return {
      blob: await resp.blob(),
      filename: getFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) || fallbackFilename || "Document.pdf",
    };
  }

  function openPdfViewerWindow(title) {
    const safeTitle = escapeHtml(title || "Document PDF");
    const win = window.open("", "_blank");
    if (!win) throw new Error("Le navigateur a bloqué l’ouverture du PDF.");
    win.document.open();
    win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8" /><title>${safeTitle}</title><style>html,body{margin:0;height:100%;background:#f5f6f8}body{display:flex;flex-direction:column}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;box-sizing:border-box;border-bottom:1px solid #d7dbe2;background:#fff;font:14px/1.2 Arial,sans-serif;color:#1f2937}.bar__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.bar__status{display:flex;align-items:center;gap:10px;color:#667085}.bar__spinner{width:18px;height:18px;border-radius:999px;border:3px solid rgba(17,24,39,.12);border-top-color:#355caa;animation:pdfSpin .8s linear infinite}.viewer{flex:1;min-height:0}.viewer iframe{width:100%;height:100%;border:0;background:#fff}@keyframes pdfSpin{to{transform:rotate(360deg)}} </style></head><body><div class="bar"><div class="bar__title">${safeTitle}</div><div class="bar__status"><div class="bar__spinner"></div><span>Génération du PDF…</span></div></div><div class="viewer"></div></body></html>`);
    win.document.close();
    return win;
  }

  function renderPdfBlobInViewer(win, blob, title) {
    const safeFilename = String(title || "Document PDF").trim() || "Document PDF";
    const pdfFile = new File([blob], safeFilename, { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(pdfFile);
    const safeTitle = escapeHtml(safeFilename);

    if (!win || win.closed) {
      window.open(blobUrl, "_blank");
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch(_){} }, 60000);
      return;
    }

    win.document.open();
    win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8" /><title>${safeTitle}</title><style>html,body{margin:0;height:100%;background:#f5f6f8}body{display:flex;flex-direction:column}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;box-sizing:border-box;border-bottom:1px solid #d7dbe2;background:#fff;font:14px/1.2 Arial,sans-serif;color:#1f2937}.bar__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.bar__btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#334155;text-decoration:none;font-weight:600}.viewer{flex:1;min-height:0}.viewer iframe{width:100%;height:100%;border:0;background:#fff}</style></head><body><div class="bar"><div class="bar__title">${safeTitle}</div><a class="bar__btn" href="${blobUrl}" download="${safeTitle}">Télécharger</a></div><div class="viewer"><iframe src="${blobUrl}" title="${safeTitle}"></iframe></div></body></html>`);
    win.document.close();
    try { win.addEventListener("beforeunload", () => { try { URL.revokeObjectURL(blobUrl); } catch(_){} }, { once:true }); } catch(_) {}
    setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch(_){} }, 5 * 60 * 1000);
  }

  async function openPosteFichePdf(portal, posteOrId) {
    const raw = (posteOrId && typeof posteOrId === "object") ? posteOrId : { id_poste: posteOrId };
    const pid = String(raw?.id_poste || posteOrId || "").trim();
    if (!portal?.contactId) throw new Error("Contact introuvable.");
    if (!pid) throw new Error("Poste manquant.");

    const code = String(raw?.codif_client || raw?.codif_poste || raw?.code_poste || "").trim();
    const title = String(raw?.intitule_poste || raw?.intitule || "Poste").trim();
    const fallbackFilename = buildPdfFilename(code || pid, title, "Poste", "Poste");
    const viewer = openPdfViewerWindow(fallbackFilename);
    try {
      const url = `${portal.apiBase}/skills/organisation/postes/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(pid)}/fiche_pdf`;
      const { blob, filename } = await fetchOrganisationPdfBlob(url, fallbackFilename);
      renderPdfBlobInViewer(viewer, blob, filename || fallbackFilename);
    } catch (err) {
      if (viewer && !viewer.closed) viewer.close();
      throw err;
    }
  }

  async function openOrgCompetenceFichePdf(portal, item) {
    const cid = String(item?.id_competence || item?.id_comp || "").trim();
    if (!portal?.contactId) throw new Error("Contact introuvable.");
    if (!cid) throw new Error("Compétence manquante.");

    const code = String(item?.code || "").trim();
    const title = String(item?.intitule || "Compétence").trim();
    const fallbackFilename = buildPdfFilename(code || cid, title, "Compétence", "Compétence");
    const viewer = openPdfViewerWindow(fallbackFilename);

    try {
      const url = `${portal.apiBase}/skills/organisation/competences/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(cid)}/fiche_pdf`;
      const { blob, filename } = await fetchOrganisationPdfBlob(url, fallbackFilename);
      renderPdfBlobInViewer(viewer, blob, filename || fallbackFilename);
    } catch (err) {
      if (viewer && !viewer.closed) viewer.close();
      throw err;
    }
  }

  function renderPostes(list) {
    const container = document.getElementById("postesContainer");
    const empty = document.getElementById("postesEmpty");
    if (!container || !empty) return;

    container.innerHTML = "";
    empty.style.display = "none";

    if (!list || list.length === 0) {
      empty.style.display = "block";
      return;
    }

    const iconEye = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const iconPdf = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>';

    list.forEach(p => {
      const row = document.createElement("div");
      row.className = "org-poste-row";

      const left = document.createElement("div");
      left.className = "sb-acc-left org-poste-row__main";

      const head = document.createElement("div");
      head.className = "org-poste-head";

      const code = (p.codif_poste || "").trim();
      const title = (p.intitule_poste || "").trim();
      const clientCode = (p.codif_client || "").trim();
      const codeBadge = clientCode || code;

      if (codeBadge) {
        const badge = document.createElement("span");
        badge.className = "sb-badge sb-badge-ref-poste-code";
        badge.textContent = codeBadge;
        head.appendChild(badge);
      }

      const titleNode = document.createElement("div");
      titleNode.className = "sb-acc-title";
      titleNode.textContent = title || "Poste";
      head.appendChild(titleNode);
      left.appendChild(head);

      const right = document.createElement("div");
      right.className = "sb-acc-right org-poste-row__actions";

      if (p.isresponsable) {
        const badgeResp = document.createElement("span");
        badgeResp.className = "sb-badge sb-badge-manager";
        badgeResp.textContent = "Responsable";
        right.appendChild(badgeResp);
      }

      const badgeEff = document.createElement("span");
      badgeEff.className = "sb-badge org-poste-row__count";
      badgeEff.textContent = `${(p.nb_effectifs ?? 0).toString()} collab.`;
      right.appendChild(badgeEff);

      const actions = document.createElement("div");
      actions.className = "sb-icon-actions org-poste-row__icon-actions";

      const eyeBtn = document.createElement("button");
      eyeBtn.type = "button";
      eyeBtn.className = "sb-icon-btn";
      eyeBtn.title = "Voir la fiche";
      eyeBtn.setAttribute("aria-label", "Voir la fiche");
      eyeBtn.innerHTML = iconEye;
      eyeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openOrgPosteModal(p);
      });
      actions.appendChild(eyeBtn);

      const pdfBtn = document.createElement("button");
      pdfBtn.type = "button";
      pdfBtn.className = "sb-icon-btn";
      pdfBtn.title = "Voir le PDF";
      pdfBtn.setAttribute("aria-label", "Voir le PDF");
      pdfBtn.innerHTML = iconPdf;
      pdfBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const portal = window.__skillsPortalInstance;
        if (!portal) return;
        try {
          await openPosteFichePdf(portal, p);
        } catch (err) {
          portal.showAlert("error", err?.message || String(err));
        }
      });
      actions.appendChild(pdfBtn);

      right.appendChild(actions);
      row.appendChild(left);
      row.appendChild(right);

      row.addEventListener("click", () => openOrgPosteModal(p));
      container.appendChild(row);
    });
  }

  function formatDateOnly(v) {
    if (!v) return "";
    const s = String(v);
    // ISO "YYYY-MM-DD..." -> "DD/MM/YYYY"
    if (s.length >= 10 && s[4] === "-" && s[7] === "-") {
      const y = s.substring(0, 4);
      const m = s.substring(5, 7);
      const d = s.substring(8, 10);
      return `${d}/${m}/${y}`;
    }
    return s;
  }

  const _posteDetailCache = new Map(); // id_poste -> detail

  function formatDateOnly(v) {
    if (!v) return "";
    const s = String(v);
    if (s.length >= 10 && s[4] === "-" && s[7] === "-") {
      const y = s.substring(0, 4);
      const m = s.substring(5, 7);
      const d = s.substring(8, 10);
      return `${d}/${m}/${y}`;
    }
    return s;
  }

  async function fetchPosteDetail(portal, id_poste) {
    if (_posteDetailCache.has(id_poste)) return _posteDetailCache.get(id_poste);

    const url = `${portal.apiBase}/skills/organisation/poste_detail/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_poste)}`;
    const data = await portal.apiJson(url);
    _posteDetailCache.set(id_poste, data);
    return data;
  }

  function _isEmptyRichNode(node){
    if (!node) return true;
    if (node.nodeType === Node.TEXT_NODE) return !(node.textContent || "").trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return false;

    const tag = node.tagName.toLowerCase();
    if (tag === "br") return true;
    if (!["p", "div", "span"].includes(tag)) return false;

    const txt = (node.textContent || "").replace(/\u00a0/g, " ").trim();
    const hasMedia = !!node.querySelector("img,svg,table,ol,ul");
    return !txt && !hasMedia;
  }

  function _cleanResponsibilitiesHtml(container){
    if (!container) return;

    while (container.firstChild && _isEmptyRichNode(container.firstChild)){
      container.removeChild(container.firstChild);
    }

    while (container.lastChild && _isEmptyRichNode(container.lastChild)){
      container.removeChild(container.lastChild);
    }
  }

  function fillPosteDefinitionTab(detail) {
    const missionWrap = document.getElementById("orgPosteDefMissionWrap");
    const mission = document.getElementById("orgPosteDefMission");
    const respWrap = document.getElementById("orgPosteDefRespWrap");
    const resp = document.getElementById("orgPosteDefResp");
    const empty = document.getElementById("orgPosteDefEmpty");
    const badgeResp = document.getElementById("orgPosteDefRespBadge");
    const dateEl = document.getElementById("orgPosteDefDate");

    const m = repairAiTextEncodingGlitches(detail?.mission_principale || "").trim();
    const rh = repairAiTextEncodingGlitches(detail?.responsabilites_html || "").trim();

    // Badge responsable (bloc)
    if (badgeResp) {
      badgeResp.style.display = detail?.isresponsable ? "" : "none";
    }

    // Mission
    if (missionWrap && mission) {
      if (m) {
        mission.textContent = m;
        missionWrap.style.display = "";
      } else {
        mission.textContent = "";
        missionWrap.style.display = "none";
      }
    }

    // Responsabilités (HTML)
    if (respWrap && resp) {
      if (rh) {
        resp.innerHTML = rh;
        _cleanResponsibilitiesHtml(resp);
        // On garde le RTF brut en mémoire pour le round-trip futur
        resp.dataset.rtf = repairAiTextEncodingGlitches(detail?.responsabilites || "");
        respWrap.style.display = "";
      } else {
        resp.innerHTML = "";
        resp.dataset.rtf = "";
        respWrap.style.display = "none";
      }
    }

    // Empty
    if (empty) {
      empty.style.display = (!m && !rh) ? "" : "none";
    }

    // Date maj (date only)
    if (dateEl) {
      const d = formatDateOnly(detail?.date_maj);
      if (d) {
        dateEl.textContent = `Dernière mise à jour : ${d}`;
        dateEl.style.display = "";
      } else {
        dateEl.textContent = "";
        dateEl.style.display = "none";
      }
    }
  }

    function _norm(s){
    return (s ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function _setValue(id, v){
    const el = byId(id);
    if (!el) return;
    el.value = (v ?? "");
    if (el.tagName === "SELECT") _refreshSelectTitleEl(el);
  }

  function _setText(id, v){
    const el = byId(id);
    if (!el) return;
    const s = (v ?? "").toString().trim();
    el.textContent = s || "—";
  }

  function _setChecked(id, v){
    const el = byId(id);
    if (!el) return;
    if (el.type === "hidden") {
      el.value = v ? "oui" : "non";
    } else {
      el.checked = !!v;
    }
  }

  function _refreshSelectTitleEl(el){
    if (!el) return;
    const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    const txt = (opt?.textContent || "").trim();
    el.title = txt && txt !== "—" ? txt : "";
  }

  function _fillSelect(el, options){
    if (!el) return;
    el.innerHTML = "";
    options.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.text;
      opt.title = o.text;
      el.appendChild(opt);
    });

    if (!el._sbSelectTitleBound){
      el._sbSelectTitleBound = true;
      el.addEventListener("change", () => _refreshSelectTitleEl(el));
    }

    _refreshSelectTitleEl(el);
  }

  function _selectByStoredValue(selectId, stored){
    const el = byId(selectId);
    if (!el) return;

    const v = (stored ?? "").toString().trim();
    if (!v){
      el.value = "";
      _refreshSelectTitleEl(el);
      return;
    }

    // match direct
    for (const opt of el.options){
      if (opt.value === v){
        el.value = v;
        _refreshSelectTitleEl(el);
        return;
      }
    }

    // match normalisé (accents / casse)
    const nv = _norm(v);
    for (const opt of el.options){
      if (_norm(opt.value) === nv){
        el.value = opt.value;
        _refreshSelectTitleEl(el);
        return;
      }
    }

    el.value = "";
    _refreshSelectTitleEl(el);
  }

  let _contraintesSelectsInit = false;
  let _ctrEdit = { editing:false, snapshot:null };
  let _ctrNsfGroupes = [];
  let _orgCompState = { list:[], expanded:false };
  let _orgCompCritEdit = null;
  let _orgCertValidEdit = null;
  const _inlineMsgTimers = Object.create(null);

  function _showInlineMsg(id, type, text){
    const el = byId(id);
    if (!el) return;

    if (_inlineMsgTimers[id]) clearTimeout(_inlineMsgTimers[id]);

    const baseClasses = ["sb-inline-msg", "sb-modal-inline-msg"];
    if (el.classList.contains("org-rh-msg")) baseClasses.push("org-rh-msg");
    else baseClasses.push("org-ctr-msg");
    baseClasses.push(`sb-inline-msg--${type || "info"}`, "is-visible");

    el.className = baseClasses.join(" ");
    el.textContent = text || "";

    const hide = () => {
      el.classList.remove("is-visible");
      el.textContent = "";
    };

    _inlineMsgTimers[id] = setTimeout(hide, 5000);

    setTimeout(() => {
      const onDocClick = (ev) => {
        if (el.contains(ev.target)) return;
        const actions = el.closest(".sb-actions");
        if (actions && actions.contains(ev.target)) return;
        if (_inlineMsgTimers[id]) clearTimeout(_inlineMsgTimers[id]);
        hide();
        document.removeEventListener("click", onDocClick, true);
      };
      document.addEventListener("click", onDocClick, true);
    }, 0);
  }

  function _clearInlineMsg(id){
    const el = byId(id);
    if (!el) return;
    if (_inlineMsgTimers[id]) {
      clearTimeout(_inlineMsgTimers[id]);
      _inlineMsgTimers[id] = null;
    }
    el.classList.remove("is-visible");
    el.textContent = "";
  }

  function _ctrGetEditableIds(){
    return [
      "orgCtrEduMin",
      "orgCtrNsfGroupe",
      "orgCtrNsfObligView",
      "orgCtrMobilite",
      "orgCtrRisquePhys",
      "orgCtrPerspEvol",
      "orgCtrNivContrainte",
      "orgCtrDetailContrainte"
    ];
  }

  function _ctrSetDisabled(disabled){
    _ctrGetEditableIds().forEach(id => {
      const el = byId(id);
      if (el) el.disabled = !!disabled;
    });
  }

  function _ctrSetButtons(editing){
    const btnEdit = byId("orgCtrBtnEdit");
    const btnSave = byId("orgCtrBtnSave");
    const btnCancel = byId("orgCtrBtnCancel");
    if (btnEdit) btnEdit.style.display = editing ? "none" : "";
    if (btnSave) btnSave.style.display = editing ? "" : "none";
    if (btnCancel) btnCancel.style.display = editing ? "" : "none";
  }

  function _setCtrEditMode(editing){
    _ctrEdit.editing = !!editing;
    _ctrSetDisabled(!editing);
    _ctrSetButtons(editing);
    const bloc = byId("orgPosteBlocContraintes");
    if (bloc) bloc.classList.toggle("is-editing", !!editing);
  }

  function _ctrReadForm(){
    const nsfOblig = (byId("orgCtrNsfObligView")?.value || "non") === "oui";
    return {
      niveau_education_minimum: byId("orgCtrEduMin")?.value || "",
      nsf_groupe_code: byId("orgCtrNsfGroupe")?.value || "",
      nsf_groupe_titre: byId("orgCtrNsfGroupe")?.selectedOptions?.[0]?.textContent?.replace(/\s*\([^)]*\)\s*$/, "") || "",
      nsf_groupes: _ctrNsfGroupes.slice(),
      nsf_groupe_obligatoire: nsfOblig,
      mobilite: byId("orgCtrMobilite")?.value || "",
      risque_physique: byId("orgCtrRisquePhys")?.value || "",
      perspectives_evolution: byId("orgCtrPerspEvol")?.value || "",
      niveau_contrainte: byId("orgCtrNivContrainte")?.value || "",
      detail_contrainte: byId("orgCtrDetailContrainte")?.value || ""
    };
  }

  function _fillNsfGroupeSelect(list, selectedCode, selectedTitle){
    const nsfSel = byId("orgCtrNsfGroupe");
    if (!nsfSel) return;

    const source = Array.isArray(list) && list.length ? list : _ctrNsfGroupes;
    if (Array.isArray(list) && list.length) _ctrNsfGroupes = list.slice();

    const code = (selectedCode ?? "").toString().trim();
    const titre = (selectedTitle ?? "").toString().trim();

    nsfSel.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "—";
    empty.title = "—";
    nsfSel.appendChild(empty);

    let selectedFound = !code;
    (source || []).forEach(row => {
      const optCode = (row?.code ?? "").toString().trim();
      const optTitle = (row?.titre ?? "").toString().trim();
      if (!optCode) return;
      const opt = document.createElement("option");
      opt.value = optCode;
      opt.textContent = optTitle ? `${optTitle} (${optCode})` : optCode;
      opt.title = opt.textContent;
      nsfSel.appendChild(opt);
      if (optCode === code) selectedFound = true;
    });

    if (code && !selectedFound){
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = titre ? `${titre} (${code})` : code;
      opt.title = opt.textContent;
      nsfSel.appendChild(opt);
    }

    if (!nsfSel._sbSelectTitleBound){
      nsfSel._sbSelectTitleBound = true;
      nsfSel.addEventListener("change", () => _refreshSelectTitleEl(nsfSel));
    }

    nsfSel.value = code || "";
    _refreshSelectTitleEl(nsfSel);
  }

  function _ctrWriteForm(v){
    _selectByStoredValue("orgCtrEduMin", v?.niveau_education_minimum);
    _fillNsfGroupeSelect(v?.nsf_groupes, v?.nsf_groupe_code, v?.nsf_groupe_titre);

    _setChecked("orgCtrNsfOblig", v?.nsf_groupe_obligatoire);
    _selectByStoredValue("orgCtrNsfObligView", v?.nsf_groupe_obligatoire ? "oui" : "non");
    _selectByStoredValue("orgCtrMobilite", v?.mobilite);
    _selectByStoredValue("orgCtrRisquePhys", v?.risque_physique);
    _selectByStoredValue("orgCtrPerspEvol", v?.perspectives_evolution);
    _selectByStoredValue("orgCtrNivContrainte", v?.niveau_contrainte);
    _setValue("orgCtrDetailContrainte", v?.detail_contrainte || "");

  }

  function _ctrEnterEditMode(){
    if (_ctrEdit.editing) return;
    _ctrEdit.snapshot = _ctrReadForm();
    _setCtrEditMode(true);
  }

  function _ctrCancelEdit(){
    if (!_ctrEdit.editing) return;
    if (_ctrEdit.snapshot) _ctrWriteForm(_ctrEdit.snapshot);
    _ctrEdit.snapshot = null;
    _setCtrEditMode(false);
  }

  async function _ctrSaveEdit(){
    const portal = window.__skillsPortalInstance;
    if (!portal) return;

    const modal = byId("modalOrgPoste");
    const id_poste = modal?.getAttribute("data-id-poste") || "";
    if (!id_poste){
      _showInlineMsg("orgCtrMsg", "danger", "Poste introuvable : enregistrement impossible.");
      return;
    }

    const v = _ctrReadForm();
    const payload = {
      niveau_education_minimum: v.niveau_education_minimum || null,
      nsf_groupe_code: v.nsf_groupe_code || null,
      nsf_groupe_obligatoire: !!v.nsf_groupe_obligatoire,
      mobilite: v.mobilite || null,
      risque_physique: v.risque_physique || null,
      perspectives_evolution: v.perspectives_evolution || null,
      niveau_contrainte: v.niveau_contrainte || null,
      detail_contrainte: (v.detail_contrainte || "").trim() || null
    };

    try {
      const url = `${portal.apiBase}/skills/organisation/poste_contraintes_update/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_poste)}`;
      const updated = await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const merged = Object.assign({}, _posteDetailCache.get(id_poste) || {}, updated || {}, v);
      _posteDetailCache.set(id_poste, merged);
      fillPosteContraintesTab(merged);
      _showInlineMsg("orgCtrMsg", "success", "Contraintes enregistrées.");
    } catch (e) {
      _showInlineMsg("orgCtrMsg", "danger", "Erreur enregistrement : " + e.message);
    }
  }

  function initContraintesSelects(){
    if (_contraintesSelectsInit) return;
    _contraintesSelectsInit = true;

    // Niveau éducation (valeurs stockées : "0","3","4","5","6","7","8")
    _fillSelect(byId("orgCtrEduMin"), [
      { value:"",  text:"—" },
      { value:"0", text:"Aucun diplôme" },
      { value:"3", text:"Niveau 3 : CAP, BEP" },
      { value:"4", text:"Niveau 4 : Bac" },
      { value:"5", text:"Niveau 5 : Bac+2 (BTS, DUT)" },
      { value:"6", text:"Niveau 6 : Bac+3 (Licence, BUT)" },
      { value:"7", text:"Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)" },
      { value:"8", text:"Niveau 8 : Bac+8 (Doctorat)" }
    ]);

        // Mobilité
    _fillSelect(byId("orgCtrMobilite"), [
      { value:"", text:"—" },
      { value:"Aucune", text:"Aucune" },
      { value:"Rare", text:"Rare" },
      { value:"Occasionnelle", text:"Occasionnelle" },
      { value:"Fréquente", text:"Fréquente" }
    ]);

    // Perspectives évolution
    _fillSelect(byId("orgCtrPerspEvol"), [
      { value:"", text:"—" },
      { value:"Aucune", text:"Aucune" },
      { value:"Faible", text:"Faible" },
      { value:"Modérée", text:"Modérée" },
      { value:"Forte", text:"Forte" },
      { value:"Rapide", text:"Rapide" }
    ]);


    // Risques physiques (valeurs stockées : "Aucun","Faible","Modéré","Élevé","Critique")
    _fillSelect(byId("orgCtrRisquePhys"), [
      { value:"", text:"—" },
      { value:"Aucun", text:"Aucun : pas de risque identifié." },
      { value:"Faible", text:"Faible : exposition occasionnelle, faible intensité." },
      { value:"Modéré", text:"Modéré : exposition régulière mais maîtrisée." },
      { value:"Élevé", text:"Élevé : risque important, pouvant générer une pathologie." },
      { value:"Critique", text:"Critique : risque vital ou accident grave possible." }
    ]);

    // Niveau contraintes (valeurs stockées : "Aucune","Modérée","Élevée","Critique")
    _fillSelect(byId("orgCtrNivContrainte"), [
      { value:"", text:"—" },
      { value:"Aucune", text:"Aucune : poste standard, sans pression ni particularité." },
      { value:"Modérée", text:"Modérée : quelques contraintes psychosociales/organisationnelles." },
      { value:"Élevée", text:"Élevée : forte pression, conditions difficiles, grande responsabilité." },
      { value:"Critique", text:"Critique : stress ou responsabilité vitale." }
    ]);

    // Les libellés complets sont visibles dans le select et dans les options.

  }

  function fillPosteContraintesTab(detail){
    initContraintesSelects();
    _ctrWriteForm(detail || {});
    _ctrEdit.snapshot = null;
    _setCtrEditMode(false);
  }

    function _nivLabel(niv){
    const n = (niv || "").toString().trim().toUpperCase();
    if (n === "A") return "Débutant";
    if (n === "B") return "Intermédiaire";
    if (n === "C") return "Avancé";
    if (n === "D") return "Expert";
    return n || "";
  }

  function _nivClass(niv){
    const n = (niv || "").toString().trim().toUpperCase();
    if (n === "A") return "sb-badge-niv-a";
    if (n === "B") return "sb-badge-niv-b";
    if (n === "C") return "sb-badge-niv-c";
    if (n === "D") return "sb-badge-niv-d";
    return "";
  }

  function fillPosteCompetencesTab(detail){
    _orgCompState.list = Array.isArray(detail?.competences) ? detail.competences : [];
    _orgCompState.expanded = false;
    _renderPosteCompetencesRows();
  }

  function _renderPosteCompetencesRows(){
    const tbody = byId("orgPosteCompTbody");
    const empty = byId("orgPosteCompEmpty");
    const btnMore = byId("orgPosteCompMore");
    const btnText = byId("orgPosteCompMoreText");
    if (!tbody || !empty) return;

    const list = Array.isArray(_orgCompState.list) ? _orgCompState.list : [];
    const limit = 5;
    const visible = _orgCompState.expanded ? list : list.slice(0, limit);

    tbody.innerHTML = "";
    if (!list.length){
      empty.style.display = "";
      if (btnMore) btnMore.style.display = "none";
      return;
    }
    empty.style.display = "none";

    visible.forEach(it => {
      const code = (it?.code || "").toString().trim();
      const title = (it?.intitule || "").toString().trim();
      const desc = (it?.description || "").toString().trim();
      const niv = (it?.niveau_requis || "").toString().trim().toUpperCase();

      const crit = it?.poids_criticite;
      const critTxt = (crit === null || crit === undefined || crit === "") ? "" : String(crit).trim();

      const nivLbl = _nivLabel(niv);
      const nivCell = (!nivLbl) ? "—" : `<span class="sb-badge sb-badge-niv ${_nivClass(niv)}">${escapeHtml(nivLbl)}</span>`;

      const tr = document.createElement("tr");
      const critVal = Number(critTxt);
      const lvl =
        !isFinite(critVal) ? 0 :
        (critVal >= 80 ? 5 :
        critVal >= 60 ? 4 :
        critVal >= 40 ? 3 :
        critVal >= 20 ? 2 : 1);

      const critHtml = isFinite(critVal)
        ? `<span class="sb-crit-badge sb-crit-l${lvl}" title="Criticité : ${escapeHtml(String(critVal))}">${escapeHtml(String(critVal))}</span>`
        : "—";

      tr.innerHTML = `
        <td class="col-center">${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : "-"}</td>
        <td title="${escapeHtml(desc)}">${escapeHtml(title || "—")}</td>
        <td class="col-center">${nivCell}</td>
        <td class="col-center">${critHtml}</td>
        <td class="col-center"><div class="sb-icon-actions org-exi-row-actions"></div></td>
      `;

      const actions = tr.querySelector(".org-exi-row-actions");
      if (actions){
        const btnCrit = document.createElement("button");
        btnCrit.type = "button";
        btnCrit.className = "sb-icon-btn";
        btnCrit.title = "Évaluer la criticité";
        btnCrit.setAttribute("aria-label", "Évaluer la criticité");
        btnCrit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>';
        btnCrit.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openOrgCompCritModal(it);
        });
        actions.appendChild(btnCrit);

        const btnPdf = document.createElement("button");
        btnPdf.type = "button";
        btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
        btnPdf.title = "Ouvrir la fiche compétence PDF";
        btnPdf.setAttribute("aria-label", "Ouvrir la fiche compétence PDF");
        btnPdf.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>';
        btnPdf.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const portal = window.__skillsPortalInstance;
          if (!portal) return;
          try {
            await openOrgCompetenceFichePdf(portal, it);
          } catch (err) {
            portal.showAlert("error", err?.message || String(err));
          }
        });
        actions.appendChild(btnPdf);
      }

      tbody.appendChild(tr);
    });

    if (btnMore){
      const hidden = Math.max(0, list.length - limit);
      btnMore.style.display = hidden > 0 ? "flex" : "none";
      btnMore.classList.toggle("is-expanded", !!_orgCompState.expanded);
      if (btnText) btnText.textContent = _orgCompState.expanded
        ? "Voir moins de compétences"
        : `Voir plus de compétences (${hidden})`;
    }
  }

  function fillPosteCertificationsTab(detail){
    const tbody = byId("orgPosteCertTbody");
    const empty = byId("orgPosteCertEmpty");
    if (!tbody || !empty) return;

    const list = Array.isArray(detail?.certifications) ? detail.certifications : [];

    tbody.innerHTML = "";
    if (!list.length){
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";

    list.forEach(it => {
      const nom = (it?.nom_certification || "").toString().trim();
      const desc = (it?.description || "").toString().trim();
      const cat = (it?.categorie || "").toString().trim();
      const validity = _getCertEffectiveValidity(it);
      const validityTitle = validity.isOverride
        ? `Validité spécifique au poste. ${_buildCertBaseInfo(it)}`
        : _buildCertBaseInfo(it);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td title="${escapeHtml(desc)}">${escapeHtml(nom || "—")}</td>
        <td>${escapeHtml(cat || "-")}</td>
        <td class="col-center" title="${escapeHtml(validityTitle)}">${escapeHtml(validity.label)}</td>
        <td class="col-center">${_certRequirementBadge(it?.niveau_exigence)}</td>
        <td class="col-center"><div class="sb-icon-actions org-exi-row-actions"></div></td>
      `;

      const actions = tr.querySelector(".org-exi-row-actions");
      if (actions){
        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "sb-icon-btn";
        btnEdit.title = "Modifier le paramétrage de la certification";
        btnEdit.setAttribute("aria-label", "Modifier le paramétrage de la certification");
        btnEdit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
        btnEdit.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openOrgCertValidModal(it);
        });
        actions.appendChild(btnEdit);
      }

      tbody.appendChild(tr);
    });
  }

  function _calcCritScore(freq, impact, dep){
    const f = Math.max(0, Math.min(10, parseInt(freq ?? 0, 10) || 0));
    const i = Math.max(0, Math.min(10, parseInt(impact ?? 0, 10) || 0));
    const d = Math.max(0, Math.min(10, parseInt(dep ?? 0, 10) || 0));
    return { f, i, d, total: Math.max(0, Math.min(100, (f * 2) + (i * 5) + (d * 3))) };
  }

  function _setOrgCompCritRing(score){
    const s = Math.max(0, Math.min(100, parseInt(score ?? 0, 10) || 0));
    const prog = byId("orgCompCritRingProg");
    const val = byId("orgCompCritRingVal");
    if (prog) prog.setAttribute("stroke-dasharray", `${s} 100`);
    if (val) val.textContent = String(s);
  }

  function _refreshOrgCompCritDisplay(){
    const dd = _calcCritScore(byId("orgCompCritFreq")?.value, byId("orgCompCritImpact")?.value, byId("orgCompCritDep")?.value);
    if (byId("orgCompCritFreqTxt")) byId("orgCompCritFreqTxt").textContent = `${dd.f}/10`;
    if (byId("orgCompCritImpactTxt")) byId("orgCompCritImpactTxt").textContent = `${dd.i}/10`;
    if (byId("orgCompCritDepTxt")) byId("orgCompCritDepTxt").textContent = `${dd.d}/10`;
    _setOrgCompCritRing(dd.total);
  }

  function _refreshOrgCompCritNivCards(){
    document.querySelectorAll('#orgCompCritNivGrid .org-comp-level-card').forEach(card => {
      const r = card.querySelector('input[type="radio"]');
      card.classList.toggle('is-selected', !!(r && r.checked));
    });
  }

  function _setOrgCompCritNiv(v){
    const niv = ((v || '').toString().trim().toUpperCase() || 'C');
    const finalNiv = ['A','B','C','D'].includes(niv) ? niv : 'C';
    const r = document.querySelector(`#orgCompCritNivGrid input[name="orgCompCritNiv"][value="${finalNiv}"]`);
    if (r) r.checked = true;
    _refreshOrgCompCritNivCards();
  }

  function _getOrgCompCritNiv(){
    const r = document.querySelector('#orgCompCritNivGrid input[name="orgCompCritNiv"]:checked');
    const v = (r?.value || 'C').toString().trim().toUpperCase();
    return ['A','B','C','D'].includes(v) ? v : 'C';
  }

  function _setOrgCompCritLevelTexts(it){
    _setText('orgCompCritRefA', it?.niveaua || 'Premiers repères, exécution accompagnée.');
    _setText('orgCompCritRefB', it?.niveaub || 'Exécution régulière sur situations simples.');
    _setText('orgCompCritRefC', it?.niveauc || 'Autonomie sur situations courantes et aléas modérés.');
    _setText('orgCompCritRefD', it?.niveaud || 'Maîtrise complète, sécurisation et transmission.');
  }

  function openOrgCompCritModal(it){
    _orgCompCritEdit = Object.assign({}, it || {});

    const badge = byId("orgCompCritBadge");
    const code = (_orgCompCritEdit.code || "").toString().trim();
    if (badge){
      badge.textContent = code;
      badge.style.display = code ? "" : "none";
    }
    _setText("orgCompCritTitle", _orgCompCritEdit.intitule || "Compétence");
    _setOrgCompCritLevelTexts(_orgCompCritEdit);
    _setOrgCompCritNiv(_orgCompCritEdit.niveau_requis || "C");

    _setValue("orgCompCritFreq", String(_orgCompCritEdit.freq_usage ?? 0));
    _setValue("orgCompCritImpact", String(_orgCompCritEdit.impact_resultat ?? 0));
    _setValue("orgCompCritDep", String(_orgCompCritEdit.dependance ?? 0));
    _refreshOrgCompCritDisplay();

    const modal = byId("modalOrgPosteCompCrit");
    if (modal){
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeOrgCompCritModal(){
    const modal = byId("modalOrgPosteCompCrit");
    if (modal){
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
    _orgCompCritEdit = null;
  }

  async function saveOrgCompCrit(){
    const portal = window.__skillsPortalInstance;
    if (!portal || !_orgCompCritEdit) return;

    const modal = byId("modalOrgPoste");
    const id_poste = modal?.getAttribute("data-id-poste") || "";
    const id_competence = (_orgCompCritEdit.id_competence || _orgCompCritEdit.id_comp || "").toString().trim();
    if (!id_poste || !id_competence){
      _showInlineMsg("orgCompCritMsg", "danger", "Poste ou compétence introuvable.");
      return;
    }

    const payload = {
      id_competence,
      niveau_requis: _getOrgCompCritNiv(),
      freq_usage: parseInt(byId("orgCompCritFreq")?.value || "0", 10) || 0,
      impact_resultat: parseInt(byId("orgCompCritImpact")?.value || "0", 10) || 0,
      dependance: parseInt(byId("orgCompCritDep")?.value || "0", 10) || 0,
      valider_eval: true
    };

    try {
      const url = `${portal.apiBase}/skills/organisation/poste_competence_update/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_poste)}`;
      const updated = await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });

      _posteDetailCache.set(id_poste, updated);
      fillPosteCompetencesTab(updated);
      closeOrgCompCritModal();
    } catch (e) {
      _showInlineMsg("orgCompCritMsg", "danger", "Erreur enregistrement : " + e.message);
    }
  }

  function bindOrgCompCritModalOnce(){
    const modal = byId("modalOrgPosteCompCrit");
    if (!modal || modal.getAttribute("data-bound") === "1") return;
    modal.setAttribute("data-bound", "1");

    byId("orgCompCritX")?.addEventListener("click", closeOrgCompCritModal);
    byId("orgCompCritCancel")?.addEventListener("click", closeOrgCompCritModal);
    byId("orgCompCritSave")?.addEventListener("click", (e) => { e.preventDefault(); saveOrgCompCrit(); });
    ["orgCompCritFreq", "orgCompCritImpact", "orgCompCritDep"].forEach(id => {
      byId(id)?.addEventListener("input", _refreshOrgCompCritDisplay);
    });
    modal.querySelectorAll('#orgCompCritNivGrid input[name="orgCompCritNiv"]').forEach(r => {
      r.addEventListener("change", _refreshOrgCompCritNivCards);
    });
    modal.querySelectorAll('#orgCompCritNivGrid .org-comp-level-card').forEach(card => {
      card.addEventListener("click", () => {
        const r = card.querySelector('input[type="radio"]');
        if (r) r.checked = true;
        _refreshOrgCompCritNivCards();
      });
    });
    modal.addEventListener("click", (e) => { if (e.target === modal) closeOrgCompCritModal(); });
  }

  function openOrgCertValidModal(it){
    _orgCertValidEdit = Object.assign({}, it || {});
    _setText("orgCertValidTitle", _orgCertValidEdit.nom_certification || "Certification");
    _setText("orgCertValidSub", _orgCertValidEdit.categorie || "Sans catégorie");
    _setValue("orgCertValidOverride", (_orgCertValidEdit.validite_override ?? "").toString());
    _setText("orgCertValidBaseInfo", _buildCertBaseInfo(_orgCertValidEdit));
    _setValue("orgCertValidLevel", (_orgCertValidEdit.niveau_exigence || "requis").toString().trim().toLowerCase());
    _setValue("orgCertValidComment", (_orgCertValidEdit.commentaire || "").toString());
    _showInlineMsg("orgCertValidMsg", "", "");

    const modal = byId("modalOrgPosteCertValid");
    if (modal){
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeOrgCertValidModal(){
    const modal = byId("modalOrgPosteCertValid");
    if (modal){
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
    _orgCertValidEdit = null;
  }

  async function saveOrgCertValid(){
    const portal = window.__skillsPortalInstance;
    if (!portal || !_orgCertValidEdit) return;

    const modal = byId("modalOrgPoste");
    const id_poste = modal?.getAttribute("data-id-poste") || "";
    const id_certification = (_orgCertValidEdit.id_certification || "").toString().trim();
    if (!id_poste || !id_certification){
      _showInlineMsg("orgCertValidMsg", "danger", "Poste ou certification introuvable.");
      return;
    }

    const raw = (byId("orgCertValidOverride")?.value || "").trim();
    if (raw && !/^\d+$/.test(raw)){
      _showInlineMsg("orgCertValidMsg", "danger", "La validité doit être un nombre de mois.");
      return;
    }

    try {
      const url = `${portal.apiBase}/skills/organisation/poste_certification_update/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_poste)}`;
      const updated = await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          id_certification,
          validite_override: raw ? parseInt(raw, 10) : null,
          niveau_exigence: (byId("orgCertValidLevel")?.value || "requis").trim().toLowerCase(),
          commentaire: (byId("orgCertValidComment")?.value || "").trim() || null
        })
      });

      _posteDetailCache.set(id_poste, updated);
      fillPosteCertificationsTab(updated);
      closeOrgCertValidModal();
    } catch (e) {
      _showInlineMsg("orgCertValidMsg", "danger", "Erreur enregistrement : " + e.message);
    }
  }

  function bindOrgCertValidModalOnce(){
    const modal = byId("modalOrgPosteCertValid");
    if (!modal || modal.getAttribute("data-bound") === "1") return;
    modal.setAttribute("data-bound", "1");

    byId("orgCertValidX")?.addEventListener("click", closeOrgCertValidModal);
    byId("orgCertValidCancel")?.addEventListener("click", closeOrgCertValidModal);
    byId("orgCertValidSave")?.addEventListener("click", (e) => { e.preventDefault(); saveOrgCertValid(); });

    const step = (delta) => {
      const input = byId("orgCertValidOverride");
      if (!input) return;
      const cur = parseInt(input.value || "0", 10);
      const next = Math.max(1, (Number.isFinite(cur) && cur > 0 ? cur : 0) + delta);
      input.value = String(next);
    };
    byId("orgCertValidMinus")?.addEventListener("click", () => step(-1));
    byId("orgCertValidPlus")?.addEventListener("click", () => step(1));
    modal.addEventListener("click", (e) => { if (e.target === modal) closeOrgCertValidModal(); });
  }

  function _formatValidityMonths(v){
    const n = parseInt(v ?? "", 10);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `${n} mois`;
  }

  function _getCertEffectiveValidity(it){
    const override = parseInt(it?.validite_override ?? "", 10);
    if (Number.isFinite(override) && override > 0){
      return { label: `${override} mois`, isOverride: true };
    }

    const base = parseInt(it?.duree_validite ?? "", 10);
    if (Number.isFinite(base) && base > 0){
      return { label: `${base} mois`, isOverride: false };
    }

    return { label: "—", isOverride: false };
  }

  function _certRequirementBadge(v){
    const raw = (v || "requis").toString().trim().toLowerCase();
    const isSouhaite = raw === "souhaité" || raw === "souhaite";
    const label = isSouhaite ? "Souhaité" : "Requis";
    const cls = isSouhaite ? "org-cert-req-badge org-cert-req-badge--soft" : "org-cert-req-badge org-cert-req-badge--strong";
    return `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  function _buildCertBaseInfo(it){
    const parts = [`Validité catalogue : ${_formatValidityMonths(it?.duree_validite)}`];
    const renewal = _formatValidityMonths(it?.delai_renouvellement);
    if (renewal !== "—") parts.push(`Délai de renouvellement : ${renewal}`);
    return parts.join(" · ");
  }

  let _rhSelectsInit = false;

  function initRhSelects(){
    if (_rhSelectsInit) return;
    _rhSelectsInit = true;

    _fillSelect(byId("orgRhStatut"), [
      { value:"", text:"—" },
      { value:"actif", text:"Actif" },
      { value:"a_pourvoir", text:"À pourvoir" },
      { value:"gele", text:"Gelé" },
      { value:"temporaire", text:"Temporaire" },
      { value:"archive", text:"Archivé" }
    ]);

    _fillSelect(byId("orgRhCriticite"), [
      { value:"", text:"—" },
      { value:"0", text:"0 - Non critique" },
      { value:"1", text:"1 - Faible" },
      { value:"2", text:"2 - Important" },
      { value:"3", text:"3 - Élevé" },
      { value:"4", text:"4 - Critique" }
    ]);

    _fillSelect(byId("orgRhStrategie"), [
      { value:"", text:"—" },
      { value:"interne", text:"Interne" },
      { value:"externe", text:"Externe" },
      { value:"mixte", text:"Mixte" }
    ]);
  }

  function _toIsoDate(v){
    if (!v) return "";
    const s = String(v);
    // si déjà YYYY-MM-DD
    if (s.length >= 10 && s[4] === "-" && s[7] === "-") return s.substring(0,10);
    return "";
  }

  function _formatMajForRh(v){
    const d = formatDateOnly(v);
    return d || "";
  }

  function fillPosteParamRhTab(detail){
    initRhSelects();
    _rhBindStatutChangeOnce();

    const src = (detail?.rh_param_rh_source ?? "").toString().trim();
    const maj = _formatMajForRh(detail?.rh_param_rh_date_maj);

    // Valeurs
    _selectByStoredValue("orgRhStatut", detail?.rh_statut_poste);
    _selectByStoredValue("orgRhCriticite", (detail?.rh_criticite_poste ?? "").toString());
    _selectByStoredValue("orgRhStrategie", detail?.rh_strategie_pourvoi);

    _setValue("orgRhNbTitulaires", (detail?.rh_nb_titulaires_cible ?? "").toString());
    _setValue("orgRhDateDebut", _toIsoDate(detail?.rh_date_debut_validite));
    _setValue("orgRhDateFin", _toIsoDate(detail?.rh_date_fin_validite));

    _setValue("orgRhSource", src || "—");
    _setValue("orgRhDateMaj", maj || "—");

    _setValue("orgRhCommentaire", detail?.rh_param_rh_commentaire ?? "");

    // Stepper boutons (bind une fois)
    const minus = byId("orgRhNbMinus");
    const plus = byId("orgRhNbPlus");
    const nb = byId("orgRhNbTitulaires");

    const bindOnce = (btn, delta) => {
      if (!btn || btn._sbBound) return;
      btn._sbBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!nb || nb.disabled) return;

        const min = Number(nb.min || 0);
        const cur = Number(nb.value || 0);
        const next = Math.max(min, cur + delta);
        nb.value = String(next);
      });
    };

    bindOnce(minus, -1);
    bindOnce(plus, +1);

    // Retour en lecture systématique quand on remplit depuis API
    _rhEdit.snapshot = null;
    _setRhEditMode(false);
    _rhApplyFinValiditeVisibility();
    _rhSyncViewFromCurrentForm();
    fillPosteCotationTab(detail);

  }


  function applyPosteFilter() {
    const q = (document.getElementById("posteSearch")?.value || "").trim().toLowerCase();
    if (!q) {
      renderPostes(_currentPostes);
      return;
    }
    const filtered = _currentPostes.filter(p => {
      const a = (p.codif_poste || "").toLowerCase();
      const b = (p.intitule_poste || "").toLowerCase();
      const c = (p.codif_client || "").toLowerCase();
      return a.includes(q) || b.includes(q) || c.includes(q);
    });

    renderPostes(filtered);
  }

  async function loadServices(portal) {
    portal.showAlert("", "");
    const nodes = await portal.apiJson(`${portal.apiBase}/skills/organisation/services/${encodeURIComponent(portal.contactId)}`);
    _servicesLoaded = true;
    renderTree(Array.isArray(nodes) ? nodes : []);
  }

  async function loadPostesForService(portal, id_service) {
    if (_postesCache.has(id_service)) {
      _currentPostes = _postesCache.get(id_service) || [];
      updateServiceStats(_serviceIndex.get(id_service) || { id_service }, _currentPostes);
      applyPosteFilter();
      return;
    }

    const resp = await portal.apiJson(
      `${portal.apiBase}/skills/organisation/postes/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_service)}`
    );

    const postes = Array.isArray(resp.postes) ? resp.postes : [];
    _postesCache.set(id_service, postes);
    _currentPostes = postes;
    updateServiceStats(_serviceIndex.get(id_service) || { id_service }, postes);
    applyPosteFilter();
  }

  async function selectService(id_service) {
    _selectedServiceId = id_service;
    setActiveTreeItem(id_service);

    const node = _serviceIndex.get(id_service);
    setServiceHeader(node || { nom_service: "Service", nb_postes: 0, nb_effectifs: 0 });

    const portal = window.__skillsPortalInstance;
    if (!portal) return;

    try {
      portal.showAlert("", "");
      document.getElementById("postesContainer").innerHTML = `<div class="card-sub">Chargement…</div>`;
      document.getElementById("postesEmpty").style.display = "none";
      updateServiceStats(node || { id_service }, []);

      await loadPostesForService(portal, id_service);
    } catch (e) {
      portal.showAlert("error", "Erreur chargement postes : " + e.message);
      document.getElementById("postesContainer").innerHTML = `<div class="card-sub">Impossible de charger les postes.</div>`;
    }
  }

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    const search = document.getElementById("posteSearch");
    if (search) {
      let t = null;
      search.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => applyPosteFilter(), 180);
      });
    }
  }

  window.SkillsOrganisation = {
    onShow: async (portal) => {
      window.__skillsPortalInstance = portal;
      bindOrgPosteModalOnce();

      try {
        bindOnce(portal);        
        if (!_servicesLoaded) await loadServices(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur organisation : " + e.message);
      }
    },

    openPosteModal: async (poste) => {
      const portal = window.__skillsPortalInstance || window.portal;
      if (portal) window.__skillsPortalInstance = portal;
      bindOrgPosteModalOnce();
      await openOrgPosteModal(poste || {});
    },

    openPostePdf: async (poste) => {
      const portal = window.__skillsPortalInstance || window.portal;
      if (!portal) throw new Error("Portail indisponible.");
      await openPosteFichePdf(portal, poste || {});
    }
  };
})();
