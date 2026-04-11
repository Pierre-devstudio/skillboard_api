(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  let _detail = null;
  let _summary = null;
  let _ownerFeatures = null;
  let _context = null;
  let _opcoOptions = [];
  let _orgItems = [];
  let _orgCollapsed = false;
  let _orgCreateKind = "";
  let _orgCreateParentId = "";
  let _orgExpandedIds = new Set();
  let _orgHistoryItems = [];
  let _ficheEditMode = false;
  let _ficheSaving = false;
  let _publicLookupLoading = false;
  let _orgWorkspaceReady = false;
  let _orgWorkspaceLoadingPromise = null;
  let _orgWorkspaceScriptPromise = null;

  function byId(id){ return document.getElementById(id); }

  function normalizeApeCode(value){
    const digits = (value || "").toString().replace(/\D+/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  }

  function normalizeWebUrl(value){
    const v = (value || "").toString().trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    return `https://${v}`;
  }

  function normalizeProfilStructurel(value){
    const v = (value || "").toString().trim().toLowerCase();
    return v || "";
  }

  function isHoldingProfil(value){
    const v = normalizeProfilStructurel(value);
    return v === "holding_multi_entreprise" || v === "holding_multi_entreprise_multi_site";
  }

  function normalizeStructureType(value){
    const v = (value || "").toString().trim().toLowerCase();
    return v === "site" ? "site" : "entreprise";
  }

  function formatProfilStructurelLabel(value){
    const v = normalizeProfilStructurel(value);
    if (v === "site_unique") return "Site unique";
    if (v === "multi_site") return "Multi-site";
    if (v === "holding_multi_entreprise") return "Holding multi-entreprise";
    if (v === "holding_multi_entreprise_multi_site") return "Holding multi-entreprise + multi-site";
    return "—";
  }

  function getOrganisationCapabilities(){
    const profil = normalizeProfilStructurel(_detail?.profil_structurel);

    return {
      profil,
      hideBlock: profil === "site_unique",
      canAddSite: profil === "multi_site" || profil === "holding_multi_entreprise_multi_site",
      canAddEntreprise: profil === "holding_multi_entreprise" || profil === "holding_multi_entreprise_multi_site",
    };
  }

  function buildStructureSpaceUrl(idEnt){
    const url = new URL(window.location.href);
    url.searchParams.set("client", idEnt);
    return url.toString();
  }

  function openStructureSpace(idEnt){
    if (!idEnt) return;
    window.location.href = buildStructureSpaceUrl(idEnt);
  }

  function renderOpcoOptions(){
    const select = byId("ficheIdOpco");
    if (!select) return;

    const selected = (_detail?.id_opco || "").toString().trim();
    const options = ['<option value="">-</option>'];

    (_opcoOptions || []).forEach(item => {
      const id = (item?.id_opco || "").toString().trim();
      const nom = (item?.nom_opco || "").toString().trim();
      if (!id || !nom) return;

      const isSelected = id === selected ? ' selected' : '';
      options.push(`<option value="${id.replace(/"/g, "&quot;")}"${isSelected}>${nom}</option>`);
    });

    select.innerHTML = options.join("");
  }

  function updateOpcoSiteLink(){
    const select = byId("ficheIdOpco");
    const link = byId("ficheOpcoSiteLink");
    const empty = byId("ficheOpcoSiteEmpty");
    if (!select || !link || !empty) return;

    const selected = (select.value || "").toString().trim();
    const found = (_opcoOptions || []).find(x => (x?.id_opco || "").toString().trim() === selected);
    const url = normalizeWebUrl(found?.site_web || "");

    if (!url) {
      link.href = "#";
      link.classList.add("is-hidden");
      empty.classList.remove("is-hidden");
      return;
    }

    link.href = url;
    link.classList.remove("is-hidden");
    empty.classList.add("is-hidden");
  }

  async function loadOpcoOptions(){
    const ownerId = getOwnerId();
    if (!ownerId) return [];

    const token = await ensureAuthReady();
    if (!token) return [];

    const data = await apiJson(
      `${API_BASE}/studio/referentiels/opco/${encodeURIComponent(ownerId)}`,
      token
    );

    return Array.isArray(data?.items) ? data.items : [];
  }

  function bindApeMask(){
    const apeEl = byId("ficheCodeApeEnt");
    if (!apeEl) return;
    if (apeEl.dataset.apeBound === "1") return;

    apeEl.dataset.apeBound = "1";

    const applyMask = () => {
      apeEl.value = normalizeApeCode(apeEl.value);
    };

    apeEl.addEventListener("input", applyMask);
    apeEl.addEventListener("change", applyMask);
    apeEl.addEventListener("blur", applyMask);
  }

  function bindOpcoSelect(){
    const select = byId("ficheIdOpco");
    if (!select) return;
    if (select.dataset.opcoBound === "1") return;

    select.dataset.opcoBound = "1";

    select.addEventListener("change", () => {
      updateOpcoSiteLink();
    });
  }

  function normalizePhoneFr(value){
    return (value || "").toString().replace(/\D+/g, "").slice(0, 10);
  }

  function normalizeSiretSiren(value){
    return (value || "").toString().replace(/\D+/g, "").slice(0, 14);
  }

  function setInputValueIfPresent(id, value){
    const el = byId(id);
    const v = (value ?? "").toString().trim();
    if (!el || !v) return;
    el.value = v;
  }

  function buildPublicLookupQuery(mode){
    if (mode === "org_create") {
      const siret = normalizeSiretSiren(inputValue("orgCreateSiretEnt"));
      if (siret.length === 14 || siret.length === 9) return siret;
      return inputValue("orgCreateNomEnt");
    }

    const siret = normalizeSiretSiren(inputValue("ficheSiretEnt"));
    if (siret.length === 14 || siret.length === 9) return siret;
    return inputValue("ficheNomEnt");
  }

  async function fetchPublicCompanyData(query){
    const ownerId = getOwnerId();
    const token = await ensureAuthReady();
    if (!token) return null;

    const qs = new URLSearchParams();
    qs.set("q", query);

    const data = await apiJson(
      `${API_BASE}/studio/referentiels/entreprises-publiques/${encodeURIComponent(ownerId)}?${qs.toString()}`,
      token
    );

    return data?.item || null;
  }

  function applyPublicCompanyToFiche(item){
    if (!item) return;

    setInputValueIfPresent("ficheNomEnt", item.nom_ent);
    setInputValueIfPresent("ficheSiretEnt", item.siret_ent);
    setDateValue("ficheDateCreation", item.date_creation);
    if (item.effectif_ent) setInputValue("ficheEffectifEnt", item.effectif_ent);

    setInputValueIfPresent("ficheAdresseEnt", item.adresse_ent);
    setInputValueIfPresent("ficheAdresseCpltEnt", item.adresse_cplt_ent);
    setInputValueIfPresent("ficheCpEnt", item.cp_ent);
    setInputValueIfPresent("ficheVilleEnt", item.ville_ent);
    setInputValueIfPresent("fichePaysEnt", item.pays_ent);

    setInputValueIfPresent("ficheIdcc", item.idcc);
    setHelp("ficheIdccHelp", item.idcc_libelle);
    setInputValueIfPresent("ficheCodeApeEnt", normalizeApeCode(item.code_ape_ent));
    setHelp("ficheCodeApeHelp", item.code_ape_intitule);

    queuePostalLookupFromCurrentValues();
  }

  function applyPublicCompanyToOrgCreate(item){
    if (!item) return;

    setInputValueIfPresent("orgCreateNomEnt", item.nom_ent);
    setInputValueIfPresent("orgCreateSiretEnt", item.siret_ent);
    setDateValue("orgCreateDateCreation", item.date_creation);
    if (item.effectif_ent) setInputValue("orgCreateEffectifEnt", item.effectif_ent);

    setInputValueIfPresent("orgCreateAdresseEnt", item.adresse_ent);
    setInputValueIfPresent("orgCreateAdresseCpltEnt", item.adresse_cplt_ent);
    setInputValueIfPresent("orgCreateCpEnt", item.cp_ent);
    setInputValueIfPresent("orgCreateVilleEnt", item.ville_ent);
    setInputValueIfPresent("orgCreatePaysEnt", item.pays_ent);

    setInputValueIfPresent("orgCreateIdcc", item.idcc);
    setHelp("orgCreateIdccHelp", item.idcc_libelle);
    setInputValueIfPresent("orgCreateCodeApeEnt", normalizeApeCode(item.code_ape_ent));
    setHelp("orgCreateCodeApeHelp", item.code_ape_intitule);
  }

  async function loadPublicCompanyIntoForm(mode){
    if (_publicLookupLoading) return;

    const isOrgCreate = mode === "org_create";
    const query = buildPublicLookupQuery(mode);

    if (isOrgCreate) {
      setOrgModalInlineError("");
    }

    if (!query) {
      if (isOrgCreate) {
        setOrgModalInlineError("Renseigne au moins un SIRET, un SIREN ou un nom avant de charger les données officielles.");
      } else {
        setMessage("Renseigne au moins un SIRET, un SIREN ou un nom avant de charger les données officielles.");
      }
      return;
    }

    const btn = isOrgCreate ? byId("btnOrgLoadPublicData") : byId("btnFicheLoadPublicData");
    const initialText = btn?.textContent || "Charger les données officielles";

    try {
      _publicLookupLoading = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Chargement...";
      }

      const item = await fetchPublicCompanyData(query);
      if (!item) {
        throw new Error("Aucune donnée publique récupérable.");
      }

      if (isOrgCreate) {
        applyPublicCompanyToOrgCreate(item);
        setOrgModalInlineError("");
      } else {
        applyPublicCompanyToFiche(item);
        setMessage("");
      }
    } catch (e) {
      if (isOrgCreate) {
        setOrgModalInlineError(e.message || "Impossible de charger les données officielles.");
      } else {
        setMessage(e.message || "Impossible de charger les données officielles.");
      }
    } finally {
      _publicLookupLoading = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = initialText;
      }
    }
  }

  function formatPhoneFr(value){
    const digits = normalizePhoneFr(value);
    return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  }

  function formatPhoneFr(value){
    const digits = normalizePhoneFr(value);
    return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  }

  function bindPhoneMask(){
    const telEl = byId("ficheTelephoneEnt");
    if (!telEl) return;
    if (telEl.dataset.phoneBound === "1") return;

    telEl.dataset.phoneBound = "1";

    const applyMask = () => {
      telEl.value = formatPhoneFr(telEl.value);
    };

    telEl.addEventListener("input", applyMask);
    telEl.addEventListener("change", applyMask);
    telEl.addEventListener("blur", applyMask);
  }

  function getOwnerId(){
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function getClientId(){
    return (new URL(window.location.href).searchParams.get("client") || "").trim();
  }

  function formatDateFr(value){
    const v = (value || "").toString().trim();
    if (!v) return "—";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return v;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function formatDateInput(value){
    const v = (value || "").toString().trim();
    if (!v) return "";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return v;
  }

  function yesNo(value){
    return value ? "Oui" : "Non";
  }

  function textOrDash(value){
    const v = (value ?? "").toString().trim();
    return v || "—";
  }

  function toInt(value){
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function syncLinkedStructuresVisibility(){
  const parentsWrap = byId("wrapNbParents");
  const childrenWrap = byId("wrapNbChildren");

  const nbParents = toInt(_detail?.nb_entites_parents);
  const nbChildren = toInt(_detail?.nb_entites_enfants);

  if (parentsWrap) {
    parentsWrap.style.display = nbParents > 0 ? "" : "none";
  }

  if (childrenWrap) {
    childrenWrap.style.display = nbChildren > 0 ? "" : "none";
  }
}

  function inputValue(id){
    const el = byId(id);
    if (!el) return "";
    return (el.value || "").toString().trim();
  }

  function normalizePostalCode(value){
    return (value || "").toString().replace(/\D+/g, "").slice(0, 5);
  }

  function normalizeCity(value){
    return (value || "").toString().trim().toUpperCase();
  }

  function clearPostalDatalists(){
    const cpList = byId("ficheCpEntList");
    const cityList = byId("ficheVilleEntList");
    if (cpList) cpList.innerHTML = "";
    if (cityList) cityList.innerHTML = "";
  }

  function setDatalistOptions(listId, items, valueKey, labelKey){
    const list = byId(listId);
    if (!list) return;

    list.innerHTML = "";
    const seen = new Set();

    (items || []).forEach(item => {
      const value = (item?.[valueKey] || "").toString().trim();
      const label = (item?.[labelKey] || "").toString().trim();

      if (!value || seen.has(value)) return;
      seen.add(value);

      const opt = document.createElement("option");
      opt.value = value;
      if (label && label !== value) {
        opt.label = label;
      }
      list.appendChild(opt);
    });
  }

  async function fetchPostalRows(params){
    const ownerId = getOwnerId();
    if (!ownerId) return [];

    const token = await ensureAuthReady();
    if (!token) return [];

    const qs = new URLSearchParams();
    if (params?.code_postal) qs.set("code_postal", params.code_postal);
    if (params?.ville) qs.set("ville", params.ville);
    qs.set("limit", String(params?.limit || 20));

    const data = await apiJson(
      `${API_BASE}/studio/referentiels/codes-postaux/${encodeURIComponent(ownerId)}?${qs.toString()}`,
      token
    );

    return Array.isArray(data?.items) ? data.items : [];
  }

  function applyPostalRowsFromCode(cpValue, rows){
    const cpEl = byId("ficheCpEnt");
    const cityEl = byId("ficheVilleEnt");
    if (!cpEl || !cityEl) return;

    const exactRows = (rows || []).filter(r => ((r.code_postal || "").toString().trim() === cpValue));
    const cityRows = exactRows.length ? exactRows : rows;

    setDatalistOptions("ficheCpEntList", rows, "code_postal", "ville");
    setDatalistOptions("ficheVilleEntList", cityRows, "ville", "code_postal");

    const villes = [...new Set(
      (cityRows || [])
        .map(r => normalizeCity(r.ville))
        .filter(Boolean)
    )];

    if (cpValue.length === 5) {
      if (villes.length === 1) {
        cityEl.value = villes[0];
      } else if (villes.length > 1) {
        const current = normalizeCity(cityEl.value);
        if (!current || !villes.includes(current)) {
          cityEl.value = "";
        } else {
          cityEl.value = current;
        }
      }
    }
  }

function applyPostalRowsFromCity(cityValue, rows){
  const cpEl = byId("ficheCpEnt");
  const cityEl = byId("ficheVilleEnt");
  if (!cpEl || !cityEl) return;

  cityEl.value = cityValue;

  const exactRows = (rows || []).filter(r => normalizeCity(r.ville) === cityValue);
  const cpRows = exactRows.length ? exactRows : rows;

  setDatalistOptions("ficheVilleEntList", rows, "ville", "code_postal");
  setDatalistOptions("ficheCpEntList", cpRows, "code_postal", "ville");

  const cps = [...new Set(
    (cpRows || [])
      .map(r => normalizePostalCode(r.code_postal))
      .filter(Boolean)
  )];

  if (cps.length === 1) {
    cpEl.value = cps[0];
  } else if (cps.length > 1) {
    const current = normalizePostalCode(cpEl.value);
    if (!current || !cps.includes(current)) {
      cpEl.value = "";
    } else {
      cpEl.value = current;
    }
  }
}

let _postalAssistTimer = null;
let _postalAssistSeq = 0;

function schedulePostalLookup(source){
  clearTimeout(_postalAssistTimer);

  _postalAssistTimer = setTimeout(async () => {
    const seq = ++_postalAssistSeq;

    const cpEl = byId("ficheCpEnt");
    const cityEl = byId("ficheVilleEnt");
    if (!cpEl || !cityEl) return;

    cpEl.value = normalizePostalCode(cpEl.value);
    cityEl.value = normalizeCity(cityEl.value);

    const cpValue = cpEl.value;
    const cityValue = cityEl.value;

    try {
      if (source === "cp") {
        if (!cpValue) {
          clearPostalDatalists();
          return;
        }

        const rows = await fetchPostalRows({ code_postal: cpValue, limit: 20 });
        if (seq !== _postalAssistSeq) return;

        applyPostalRowsFromCode(cpValue, rows);
        return;
      }

      if (!cityValue || cityValue.length < 2) {
        clearPostalDatalists();
        return;
      }

      const rows = await fetchPostalRows({ ville: cityValue, limit: 20 });
      if (seq !== _postalAssistSeq) return;

      applyPostalRowsFromCity(cityValue, rows);
    } catch (_) {
      // Pas de bandeau ni de bruit inutile sur un simple lookup référentiel
    }
  }, 180);
}

function bindPostalAssist(){
  const cpEl = byId("ficheCpEnt");
  const cityEl = byId("ficheVilleEnt");
  if (!cpEl || !cityEl) return;
  if (cpEl.dataset.postalBound === "1") return;

  cpEl.dataset.postalBound = "1";
  cityEl.dataset.postalBound = "1";

  cpEl.addEventListener("input", () => {
    cpEl.value = normalizePostalCode(cpEl.value);
    schedulePostalLookup("cp");
  });

  cpEl.addEventListener("change", () => {
    cpEl.value = normalizePostalCode(cpEl.value);
    schedulePostalLookup("cp");
  });

  cityEl.addEventListener("input", () => {
    cityEl.value = normalizeCity(cityEl.value);
    schedulePostalLookup("ville");
  });

  cityEl.addEventListener("change", () => {
    cityEl.value = normalizeCity(cityEl.value);
    schedulePostalLookup("ville");
  });

  cityEl.addEventListener("blur", () => {
    cityEl.value = normalizeCity(cityEl.value);
  });
}

  function queuePostalLookupFromCurrentValues(){
    const cpEl = byId("ficheCpEnt");
    const cityEl = byId("ficheVilleEnt");
    if (!cpEl || !cityEl) return;

    cpEl.value = normalizePostalCode(cpEl.value);
    cityEl.value = normalizeCity(cityEl.value);

    if (cpEl.value) {
      schedulePostalLookup("cp");
      return;
    }

    if (cityEl.value) {
      schedulePostalLookup("ville");
      return;
    }

    clearPostalDatalists();
  }

  function setText(id, value){
    const el = byId(id);
    if (!el) return;
    el.textContent = textOrDash(value);
  }

  function setInputValue(id, value){
    const el = byId(id);
    if (!el) return;
    el.value = (value ?? "").toString();
  }

  function setDateValue(id, value){
    const el = byId(id);
    if (!el) return;
    el.value = formatDateInput(value);
  }

  function setCheckboxValue(id, value){
    const el = byId(id);
    if (!el) return;
    el.checked = !!value;
  }

  function setHelp(id, value){
    const el = byId(id);
    if (!el) return;
    el.textContent = textOrDash(value);
  }

  function renderOrgCreateOpcoOptions(selectedId){
    const select = byId("orgCreateIdOpco");
    if (!select) return;

    const selected = (selectedId || "").toString().trim();
    const options = ['<option value="">-</option>'];

    (_opcoOptions || []).forEach(item => {
      const id = (item?.id_opco || "").toString().trim();
      const nom = (item?.nom_opco || "").toString().trim();
      if (!id || !nom) return;

      const isSelected = id === selected ? ' selected' : '';
      options.push(`<option value="${id.replace(/"/g, "&quot;")}"${isSelected}>${nom}</option>`);
    });

    select.innerHTML = options.join("");
  }

  function updateOrgCreateOpcoSiteLink(){
    const select = byId("orgCreateIdOpco");
    const link = byId("orgCreateOpcoSiteLink");
    const empty = byId("orgCreateOpcoSiteEmpty");
    if (!select || !link || !empty) return;

    const selected = (select.value || "").toString().trim();
    const found = (_opcoOptions || []).find(x => (x?.id_opco || "").toString().trim() === selected);
    const url = normalizeWebUrl(found?.site_web || "");

    if (!url) {
      link.href = "#";
      link.classList.add("is-hidden");
      empty.classList.remove("is-hidden");
      return;
    }

    link.href = url;
    link.classList.remove("is-hidden");
    empty.classList.add("is-hidden");
  }

  function renderOrgCreateProfilOptions(kind){
    const select = byId("orgCreateProfilStructurel");
    if (!select) return;

    let options = [];

    if (kind === "site") {
      options = [
        ['site_unique', 'Site unique'],
        ['multi_site', 'Multi-site'],
      ];
    } else {
      options = [
        ['site_unique', 'Site unique'],
        ['multi_site', 'Multi-site'],
        ['holding_multi_entreprise', 'Holding multi-entreprise'],
        ['holding_multi_entreprise_multi_site', 'Holding multi-entreprise + multi-site'],
      ];
    }

    select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  }

  function syncOrgCreateProfileUi(){
    const profil = normalizeProfilStructurel(inputValue("orgCreateProfilStructurel"));
    const showGroupFields = isHoldingProfil(profil);

    document.querySelectorAll(".js-org-create-group-field").forEach(el => {
      el.classList.toggle("is-hidden", !showGroupFields);
    });

    const groupOk = byId("orgCreateGroupOk");
    const tete = byId("orgCreateTeteGroupe");
    const nom = byId("orgCreateNomGroupe");
    const type = byId("orgCreateTypeGroupe");

    if (!showGroupFields) {
      if (groupOk) groupOk.checked = false;
      if (tete) tete.checked = false;
      if (nom) nom.value = "";
      if (type) type.value = "";
      return;
    }

    const isGroup = !!groupOk?.checked;

    if (tete) {
      tete.disabled = !isGroup;
      if (!isGroup) tete.checked = false;
    }
    if (nom) {
      nom.disabled = !isGroup;
      if (!isGroup) nom.value = "";
    }
    if (type) {
      type.disabled = !isGroup;
      if (!isGroup) type.value = "";
    }
  }

  function resetOrgCreateForm(kind){
    _orgCreateKind = kind;
    setOrgModalInlineError("");

    setInputValue("orgCreateNomEnt", "");
    setInputValue("orgCreateSiretEnt", "");
    setDateValue("orgCreateDateCreation", "");
    setInputValue("orgCreateEffectifEnt", "-");
    setInputValue("orgCreateNumTvaEnt", "");

    setInputValue("orgCreateAdresseEnt", "");
    setInputValue("orgCreateAdresseCpltEnt", "");
    setInputValue("orgCreateCpEnt", "");
    setInputValue("orgCreateVilleEnt", "");
    setInputValue("orgCreatePaysEnt", "");
    setInputValue("orgCreateTelephoneEnt", "");
    setInputValue("orgCreateEmailEnt", "");
    setInputValue("orgCreateSiteWeb", "");

    setInputValue("orgCreateIdcc", "");
    setHelp("orgCreateIdccHelp", "");
    setInputValue("orgCreateCodeApeEnt", "");
    setHelp("orgCreateCodeApeHelp", "");
    renderOrgCreateOpcoOptions("");
    updateOrgCreateOpcoSiteLink();

    renderOrgCreateProfilOptions(kind);
    setCheckboxValue("orgCreateGroupOk", false);
    setCheckboxValue("orgCreateTeteGroupe", false);
    setInputValue("orgCreateNomGroupe", "");
    setInputValue("orgCreateTypeGroupe", "");

    syncOrgCreateProfileUi();

    const title = byId("orgModalTitle");
    const sub = byId("orgModalSub");
    if (title) title.textContent = kind === "site" ? "Attacher un site" : "Attacher une entreprise";
    if (sub) sub.textContent = kind === "site"
      ? "Création d’un site rattaché avec son propre espace de gestion."
      : "Création d’une entreprise rattachée avec son propre espace de gestion.";
  }

  function openOrgCreateModal(kind, parentId){
    _orgCreateParentId = (parentId || getClientId() || "").trim();
    resetOrgCreateForm(kind);
    byId("modalOrgStructure")?.classList.add("show");
  }

  function closeOrgCreateModal(){
    _orgCreateParentId = "";
    byId("modalOrgStructure")?.classList.remove("show");
  }

  function readOrgCreatePayload(){
    return {
      type_structure: _orgCreateKind,
      nom_ent: inputValue("orgCreateNomEnt"),
      siret_ent: inputValue("orgCreateSiretEnt"),
      date_creation: inputValue("orgCreateDateCreation") || null,
      effectif_ent: inputValue("orgCreateEffectifEnt"),
      num_tva_ent: inputValue("orgCreateNumTvaEnt"),

      adresse_ent: inputValue("orgCreateAdresseEnt"),
      adresse_cplt_ent: inputValue("orgCreateAdresseCpltEnt"),
      cp_ent: inputValue("orgCreateCpEnt"),
      ville_ent: normalizeCity(inputValue("orgCreateVilleEnt")),
      pays_ent: inputValue("orgCreatePaysEnt"),
      telephone_ent: formatPhoneFr(inputValue("orgCreateTelephoneEnt")),
      email_ent: inputValue("orgCreateEmailEnt"),
      site_web: inputValue("orgCreateSiteWeb"),

      idcc: inputValue("orgCreateIdcc"),
      code_ape_ent: normalizeApeCode(inputValue("orgCreateCodeApeEnt")),
      id_opco: inputValue("orgCreateIdOpco"),

      profil_structurel: normalizeProfilStructurel(inputValue("orgCreateProfilStructurel")),
      group_ok: !!byId("orgCreateGroupOk")?.checked,
      tete_groupe: !!byId("orgCreateTeteGroupe")?.checked,
      nom_groupe: inputValue("orgCreateNomGroupe"),
      type_groupe: inputValue("orgCreateTypeGroupe"),
    };
  }

  async function saveOrgCreateStructure(){
    const ownerId = getOwnerId();
    const parentId = (_orgCreateParentId || getClientId() || "").trim();
    const token = await ensureAuthReady();
    if (!token) return;
    if (!parentId) {
      setMessage("Parent de rattachement introuvable.");
      return;
    }

    const btnSave = byId("btnOrgModalSave");

    try {
      if (btnSave) {
        btnSave.disabled = true;
        btnSave.textContent = "Enregistrement...";
      }

      await apiJson(
        `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(parentId)}/structures`,
        token,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(readOrgCreatePayload())
        }
      );

      _orgExpandedIds.add(parentId);
      closeOrgCreateModal();
      await loadOrganisationData();
    } catch (e) {
      setMessage(e.message || "Erreur lors de la création de la structure rattachée.");
    } finally {
      if (btnSave) {
        btnSave.disabled = false;
        btnSave.textContent = "Enregistrer";
      }
    }
  }

  function bindOrgCreateMasks(){
    const phone = byId("orgCreateTelephoneEnt");
    const ape = byId("orgCreateCodeApeEnt");
    const ville = byId("orgCreateVilleEnt");
    const opco = byId("orgCreateIdOpco");

    if (phone && phone.dataset.bound !== "1") {
      phone.dataset.bound = "1";
      const applyPhone = () => { phone.value = formatPhoneFr(phone.value); };
      phone.addEventListener("input", applyPhone);
      phone.addEventListener("change", applyPhone);
      phone.addEventListener("blur", applyPhone);
    }

    if (ape && ape.dataset.bound !== "1") {
      ape.dataset.bound = "1";
      const applyApe = () => { ape.value = normalizeApeCode(ape.value); };
      ape.addEventListener("input", applyApe);
      ape.addEventListener("change", applyApe);
      ape.addEventListener("blur", applyApe);
    }

    if (ville && ville.dataset.bound !== "1") {
      ville.dataset.bound = "1";
      const applyVille = () => { ville.value = normalizeCity(ville.value); };
      ville.addEventListener("input", applyVille);
      ville.addEventListener("change", applyVille);
      ville.addEventListener("blur", applyVille);
    }

    if (opco && opco.dataset.bound !== "1") {
      opco.dataset.bound = "1";
      opco.addEventListener("change", updateOrgCreateOpcoSiteLink);
    }
  }

  function setMessage(message){
    const box = byId("csMessage");
    if (!box) return;

    if (!message) {
      box.style.display = "none";
      box.textContent = "";
      return;
    }

    box.style.display = "block";
    box.textContent = message;
  }

  function setOrgModalInlineError(message){
    const el = byId("orgModalInlineError");
    if (!el) return;

    if (!message) {
      el.textContent = "";
      el.classList.add("is-hidden");
      return;
    }

    el.textContent = message;
    el.classList.remove("is-hidden");
  }

  let _authInitPromise = null;

  async function ensureAuthReady(){
    if (_authInitPromise) {
      return await _authInitPromise;
    }

    _authInitPromise = (async () => {
      if (!window.PortalAuthCommon) {
        throw new Error("portal_auth_common.js non chargé.");
      }

      const r = await fetch(`${API_BASE}/portal/config/studio`);
      const cfg = await r.json().catch(() => null);

      if (!r.ok || !cfg?.supabase_url || !cfg?.supabase_anon_key) {
        throw new Error("Impossible de charger la configuration Studio.");
      }

      window.PortalAuthCommon.init({
        supabaseUrl: cfg.supabase_url,
        supabaseAnonKey: cfg.supabase_anon_key,
        portalKey: "studio",
        storagePrefix: "sb",
        apiBase: API_BASE,
        contactIdMetaKeys: ["id_owner"],
      });

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      if (!session?.access_token) {
        window.location.href = "/studio_login.html";
        return null;
      }

      return session.access_token;
    })();

    try {
      return await _authInitPromise;
    } catch (e) {
      _authInitPromise = null;
      throw e;
    }
  }

  async function apiJson(url, token, options){
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, opts.headers || {}, {
      "Authorization": `Bearer ${token}`
    });

    const r = await fetch(url, opts);
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      const detail = data && (data.detail || data.message)
        ? (data.detail || data.message)
        : `Erreur HTTP ${r.status}`;
      throw new Error(detail);
    }
    return data;
  }

  function appendOrgScopeToUrl(rawUrl){
    const url = new URL(rawUrl, window.location.origin);
    const clientId = getClientId();
    const ownerId = getOwnerId();

    if (!clientId || !ownerId) return url.toString();
    if (!url.pathname.startsWith("/studio/org/")) return url.toString();
    if (url.searchParams.has("id_ent")) return url.toString();
    if (clientId === ownerId) return url.toString();

    url.searchParams.set("id_ent", clientId);
    return url.toString();
  }

  function ensureOrganisationPortalBridge(){
    window.__orgScopeOwnerId = getOwnerId();
    window.__orgScopeEntId = getClientId();

    window.__studioAuthReady = Promise.resolve(true);

    const existing = window.portal || {};

    window.portal = Object.assign({}, existing, {
      apiBase: API_BASE,
      contactId: getOwnerId(),
      async apiJson(url, options){
        const token = await ensureAuthReady();
        if (!token) throw new Error("Session Studio introuvable.");

        const scopedUrl = appendOrgScopeToUrl(url);
        const opts = Object.assign({}, options || {});
        opts.headers = Object.assign({}, opts.headers || {}, {
          "Authorization": `Bearer ${token}`
        });

        const r = await fetch(scopedUrl, opts);
        const data = await r.json().catch(() => null);

        if (!r.ok) {
          const detail = data && (data.detail || data.message)
            ? (data.detail || data.message)
            : `Erreur HTTP ${r.status}`;
          throw new Error(detail);
        }
        return data;
      },
      showAlert(type, message){
        if (!message) {
          setMessage("");
          return;
        }
        setMessage(message);
      }
    });
  }

  function ensureOrganisationScriptLoaded(){
    if (typeof window.__studioOrganisationInit !== "function") {
      throw new Error("Logique Organisation non fusionnée dans studio_client_space.js.");
    }
    return Promise.resolve();
  }

  async function loadOrganisationWorkspace(){
    const mount = byId("orgWorkspaceMount");
    const ownerId = getOwnerId();
    const clientId = getClientId();

    try {
      console.info("[OrgWorkspace] start", {
        ownerId,
        clientId,
        hasMount: !!mount,
        hasTemplate: !!byId("tplOrgWorkspace"),
        initType: typeof window.__studioOrganisationInit
      });

      if (!mount) {
        throw new Error("orgWorkspaceMount introuvable.");
      }

      ensureOrganisationPortalBridge();

      if (mount.dataset.loaded !== "1") {
        const tpl = byId("tplOrgWorkspace");
        if (!tpl || !tpl.content) {
          throw new Error("Template Organisation introuvable.");
        }

        const root = tpl.content.querySelector('#view-organisation[data-view="organisation"]');
        if (!root) {
          throw new Error("Bloc Organisation partagé introuvable.");
        }

        mount.innerHTML = "";
        mount.appendChild(root.cloneNode(true));
        mount.dataset.loaded = "1";
      }

      await ensureOrganisationScriptLoaded();

      if (typeof window.__studioOrganisationInit !== "function") {
        throw new Error("Initialisation Organisation introuvable.");
      }

      await window.__studioOrganisationInit({ force: true });

      console.info("[OrgWorkspace] done", {
        ownerId,
        clientId,
        initType: typeof window.__studioOrganisationInit
      });
    } catch (e) {
      console.error("[OrgWorkspace] error", {
        ownerId,
        clientId,
        hasMount: !!mount,
        hasTemplate: !!byId("tplOrgWorkspace"),
        initType: typeof window.__studioOrganisationInit,
        message: e?.message || String(e)
      }, e);

      throw new Error(
        `Organisation workspace: ${e?.message || e} | owner=${ownerId || "-"} | client=${clientId || "-"} | init=${typeof window.__studioOrganisationInit}`
      );
    }
  }

  function setSection(name){
    document.querySelectorAll(".menu-item[data-section]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.section === name);
    });

    document.querySelectorAll(".cs-section[data-section]").forEach(sec => {
      sec.classList.toggle("is-active", sec.dataset.section === name);
    });
  }

  function bindNavigation(){
    document.querySelectorAll(".menu-item[data-section]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const section = btn.dataset.section || "dashboard";
        setSection(section);

        if (section !== "organisation") {
          return;
        }

        try {
          setMessage("");
          await loadOrganisationWorkspace();
        } catch (e) {
          setMessage(e.message || "Erreur lors du chargement de l’organisation.");
        }
      });
    });

    byId("btnOrgHistory")?.addEventListener("click", async () => {
      try {
        setMessage("");
        setSection("organisation");
        await loadOrganisationWorkspace();
        await openOrgHistoryModal();
      } catch (e) {
        setMessage(e.message || "Erreur lors du chargement de l’historique.");
      }
    });

    byId("btnCloseTab")?.addEventListener("click", () => {
      window.close();
      setTimeout(() => {
        if (!window.closed) window.history.back();
      }, 120);
    });
  }

  function buildPortfolioUrl(){
    const ownerId = getOwnerId();
    return `/studio/?id=${encodeURIComponent(ownerId)}&view=clients`;
  }

  function renderLinks(){
    const url = buildPortfolioUrl();
    const side = byId("btnOpenPortfolioSide");
    const top = byId("btnOpenPortfolioTop");
    if (side) side.href = url;
    if (top) top.href = url;
  }

  function getCompanySheetLabel(){
    const t = (_detail?.owner_type_client || "entreprise").toString().trim().toLowerCase();
    return t === "site" ? "Fiche site" : "Fiche entreprise";
  }

  function renderDynamicLabels(){
    const label = getCompanySheetLabel();

    const navLabel = byId("navCompanySheetLabel");
    if (navLabel) navLabel.textContent = label;

    const sectionTitle = byId("sectionCompanySheetTitle");
    if (sectionTitle) sectionTitle.textContent = label;

    const sectionSub = byId("sectionCompanySheetSub");
    if (sectionSub) {
      sectionSub.textContent = label === "Fiche site"
        ? "Informations générales, administratives et de rattachement du site."
        : "Informations générales, administratives et de rattachement de l’entreprise.";
    }
  }

  function renderOrganisationRows(){
    const tbody = byId("orgStructuresTbody");
    const tableWrap = byId("orgStructuresTableWrap");
    const empty = byId("orgStructuresEmpty");
    if (!tbody || !tableWrap || !empty) return;

    const entreprises = _orgItems.filter(x => normalizeStructureType(x.type_entreprise) === "entreprise");
    const sites = _orgItems.filter(x => normalizeStructureType(x.type_entreprise) === "site");

    if (!_orgItems.length) {
      tbody.innerHTML = "";
      tableWrap.classList.add("is-hidden");
      empty.classList.remove("is-hidden");
      return;
    }

    tableWrap.classList.remove("is-hidden");
    empty.classList.add("is-hidden");

    const rows = [];

    function pushGroup(title){
      rows.push(`
        <tr class="cs-org-group-row">
          <td colspan="5">${title}</td>
        </tr>
      `);
    }

    function pushItem(item){
      const structureType = normalizeStructureType(item.type_entreprise);
      const typeLabel = structureType === "site" ? "Site rattaché" : "Entreprise rattachée";
      const badgeClass = structureType === "site" ? "cs-org-badge--site" : "cs-org-badge--entreprise";
      const ownerLabel = item.has_owner_scope ? "Oui" : "Non";
      const ownerClass = item.has_owner_scope ? "sb-badge sb-badge--success cs-org-owner" : "sb-badge cs-org-owner";

      rows.push(`
        <tr class="sb-table-row-clickable cs-org-row" data-id-ent="${item.id_ent}" data-structure-type="${structureType}">
          <td>
            <div class="cs-org-struct-cell">
              <span class="sb-badge cs-org-badge ${badgeClass}">${structureType === "site" ? "Site" : "Entreprise"}</span>
              <div class="cs-org-struct-main">
                <div class="cs-org-struct-name">${textOrDash(item.nom_ent)}</div>
                <div class="cs-org-struct-sub">${typeLabel}</div>
              </div>
            </div>
          </td>
          <td>${textOrDash(formatProfilStructurelLabel(item.profil_structurel))}</td>
          <td>${textOrDash(item.ville_ent)}</td>
          <td class="col-center"><span class="${ownerClass}">${ownerLabel}</span></td>
          <td class="col-center">
            <button type="button" class="sb-btn sb-btn--secondary sb-btn--xs" data-open-structure="${item.id_ent}">Ouvrir</button>
          </td>
        </tr>
      `);
    }

    if (entreprises.length) {
      pushGroup("Entreprises rattachées");
      entreprises.forEach(pushItem);
    }

    if (sites.length) {
      pushGroup("Sites rattachés");
      sites.forEach(pushItem);
    }

    tbody.innerHTML = rows.join("");
  }

  function getOrganisationCapabilitiesForProfil(profil){
    const p = normalizeProfilStructurel(profil);

    return {
      profil: p,
      hideBlock: p === "site_unique",
      canAddSite: p === "multi_site" || p === "holding_multi_entreprise_multi_site",
      canAddEntreprise: p === "holding_multi_entreprise" || p === "holding_multi_entreprise_multi_site",
    };
  }

  function getOrganisationCapabilitiesForItem(item){
    return getOrganisationCapabilitiesForProfil(item?.profil_structurel);
  }

  function escHtml(value){
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sortOrganisationNodes(a, b){
    const typeA = normalizeStructureType(a?.type_entreprise);
    const typeB = normalizeStructureType(b?.type_entreprise);

    if (typeA !== typeB) {
      return typeA === "entreprise" ? -1 : 1;
    }

    return (a?.nom_ent || "").localeCompare((b?.nom_ent || ""), "fr", { sensitivity: "base" });
  }

  function buildOrganisationTree(items){
    const nodeMap = new Map();

    (items || []).forEach(raw => {
      const id = (raw?.id_ent || "").toString().trim();
      if (!id) return;

      nodeMap.set(id, {
        ...raw,
        id_ent: id,
        id_ent_parent: (raw?.id_ent_parent || "").toString().trim(),
        depth: parseInt(raw?.depth, 10) || 1,
        children: [],
      });
    });

    const roots = [];

    nodeMap.forEach(node => {
      const parent = nodeMap.get(node.id_ent_parent);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    const walk = (nodes) => {
      nodes.sort(sortOrganisationNodes);
      nodes.forEach(node => walk(node.children));
    };

    walk(roots);
    return roots;
  }

  function ensureDefaultOrgExpandedIds(items){
    if (_orgExpandedIds.size > 0) return;

    (items || []).forEach(item => {
      const depth = parseInt(item?.depth, 10) || 0;
      if (depth === 1 && !!item?.has_children) {
        _orgExpandedIds.add((item.id_ent || "").toString().trim());
      }
    });
  }

  function getOrgToggleSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 6 15 12 9 18"></polyline>
      </svg>
    `;
  }

  function getOrgPlusSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14"></path>
        <path d="M5 12h14"></path>
      </svg>
    `;
  }

  function getOrgPencilSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
      </svg>
    `;
  }

  function getOrgTrashSvg(){
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M9 6V4h6v2"></path>
      </svg>
    `;
  }

  function renderOrganisationNode(node){
    const id = (node?.id_ent || "").toString().trim();
    const parentId = (node?.id_ent_parent || "").toString().trim();
    const structureType = normalizeStructureType(node?.type_entreprise);
    const badgeClass = structureType === "site" ? "cs-org-badge--site" : "cs-org-badge--entreprise";
    const ownerLabel = node?.has_owner_scope ? "Oui" : "Non";
    const ownerClass = node?.has_owner_scope ? "sb-badge sb-badge--success cs-org-owner" : "sb-badge cs-org-owner";
    const caps = getOrganisationCapabilitiesForItem(node);

    const children = Array.isArray(node?.children) ? node.children : [];
    const hasChildren = children.length > 0;
    const expanded = hasChildren && _orgExpandedIds.has(id);

    const ville = textOrDash(node?.ville_ent);
    const profil = formatProfilStructurelLabel(node?.profil_structurel);
    const countLabel = hasChildren ? ` • ${children.length} rattachement(s)` : "";

    const toggleHtml = hasChildren
      ? `
        <button
          type="button"
          class="sb-btn sb-btn--secondary cs-org-node-toggle${expanded ? " is-open" : ""}"
          data-org-toggle="${escHtml(id)}"
          title="${expanded ? "Réduire" : "Afficher"}"
          aria-label="${expanded ? "Réduire" : "Afficher"}"
        >
          ${getOrgToggleSvg()}
        </button>
      `
      : `<span class="cs-org-node-toggle-placeholder"></span>`;

    const actions = [];

    if (caps.canAddEntreprise) {
      actions.push(`
        <button
          type="button"
          class="sb-icon-btn"
          data-org-add-kind="entreprise"
          data-parent-id="${escHtml(id)}"
          title="Attacher une entreprise"
          aria-label="Attacher une entreprise"
        >
          ${getOrgPlusSvg()}
        </button>
      `);
    }

    if (caps.canAddSite) {
      actions.push(`
        <button
          type="button"
          class="sb-icon-btn"
          data-org-add-kind="site"
          data-parent-id="${escHtml(id)}"
          title="Attacher un site"
          aria-label="Attacher un site"
        >
          ${getOrgPlusSvg()}
        </button>
      `);
    }

    actions.push(`
      <button
        type="button"
        class="sb-icon-btn"
        data-org-edit-id="${escHtml(id)}"
        title="Éditer la structure"
        aria-label="Éditer la structure"
      >
        ${getOrgPencilSvg()}
      </button>
    `);

    actions.push(`
      <button
        type="button"
        class="sb-icon-btn sb-icon-btn--danger"
        data-org-detach-id="${escHtml(id)}"
        data-parent-id="${escHtml(parentId)}"
        title="Retirer du rattachement"
        aria-label="Retirer du rattachement"
      >
        ${getOrgTrashSvg()}
      </button>
    `);

    const childrenHtml = hasChildren
      ? `
        <div class="cs-org-children${expanded ? "" : " is-hidden"}" data-org-children="${escHtml(id)}">
          ${children.map(renderOrganisationNode).join("")}
        </div>
      `
      : "";

    return `
      <div class="cs-org-node cs-org-node--${structureType}" data-id-ent="${escHtml(id)}">
        <div class="cs-org-node-line" data-depth="${Math.max(1, parseInt(node?.depth, 10) || 1)}">
          ${toggleHtml}

          <div class="cs-org-node-main">
            <div class="cs-org-struct-cell">
              <span class="sb-badge cs-org-badge ${badgeClass}">${structureType === "site" ? "Site" : "Entreprise"}</span>
              <div class="cs-org-struct-main">
                <div class="cs-org-struct-name">${escHtml(textOrDash(node?.nom_ent))}</div>
                <div class="cs-org-struct-sub">${escHtml(profil)}${ville !== "—" ? ` • ${escHtml(ville)}` : ""}${countLabel}</div>
              </div>
            </div>
          </div>

          <div class="cs-org-node-right">
            <span class="${ownerClass}">${ownerLabel}</span>
            <div class="sb-icon-actions">
              ${actions.join("")}
            </div>
          </div>
        </div>

        ${childrenHtml}
      </div>
    `;
  }

  function renderOrganisationRows(){
    const host = byId("orgStructuresTree");
    const wrap = byId("orgStructuresTreeWrap");
    const empty = byId("orgStructuresEmpty");
    if (!host || !wrap || !empty) return;

    if (!_orgItems.length) {
      host.innerHTML = "";
      wrap.classList.add("is-hidden");
      empty.classList.remove("is-hidden");
      return;
    }

    const roots = buildOrganisationTree(_orgItems);

    wrap.classList.remove("is-hidden");
    empty.classList.add("is-hidden");
    host.innerHTML = roots.map(renderOrganisationNode).join("");
  }

  function renderOrganisationSection(){
    const caps = getOrganisationCapabilities();

    const blockCard = byId("orgStructuresCard");
    const body = byId("orgStructuresBody");
    const btnSite = byId("btnOrgAddSite");
    const btnEnt = byId("btnOrgAddEntreprise");
    const btnToggle = byId("btnOrgToggle");

    if (blockCard) {
      blockCard.classList.toggle("is-hidden", caps.hideBlock);
    }

    if (caps.hideBlock) {
      return;
    }

    const nbEntreprises = _orgItems.filter(x => normalizeStructureType(x.type_entreprise) === "entreprise").length;
    const nbSites = _orgItems.filter(x => normalizeStructureType(x.type_entreprise) === "site").length;

    setText("orgKpiEntreprises", nbEntreprises);
    setText("orgKpiSites", nbSites);

    if (btnSite) btnSite.classList.toggle("is-hidden", !caps.canAddSite);
    if (btnEnt) btnEnt.classList.toggle("is-hidden", !caps.canAddEntreprise);

    if (body) body.classList.toggle("is-hidden", _orgCollapsed);
    if (btnToggle) btnToggle.classList.toggle("is-collapsed", _orgCollapsed);

    renderOrganisationRows();
  }

  async function loadOrganisationData(){
    const caps = getOrganisationCapabilities();

    if (caps.hideBlock) {
      _orgItems = [];
      renderOrganisationSection();
      return;
    }

    const ownerId = getOwnerId();
    const clientId = getClientId();
    const token = await ensureAuthReady();
    if (!token) return;

    const data = await apiJson(
      `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}/structures`,
      token
    );

    _orgItems = Array.isArray(data?.items) ? data.items : [];
    ensureDefaultOrgExpandedIds(_orgItems);
    renderOrganisationSection();
  }

  async function detachOrgStructure(parentId, childId){
    const ownerId = getOwnerId();
    const pId = (parentId || "").toString().trim();
    const cId = (childId || "").toString().trim();

    if (!ownerId || !pId || !cId) return;

    const confirmed = window.confirm("Retirer cette structure va archiver toute sa branche dans le périmètre actif. Continuer ?");
    if (!confirmed) return;

    const token = await ensureAuthReady();
    if (!token) return;

    await apiJson(
      `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(pId)}/structures/${encodeURIComponent(cId)}/detach`,
      token,
      { method: "POST" }
    );

    await loadOrganisationData();
  }

  function renderOrgHistoryRows(){
    const host = byId("orgHistoryList");
    const empty = byId("orgHistoryEmpty");
    if (!host || !empty) return;

    if (!_orgHistoryItems.length) {
      host.innerHTML = "";
      empty.classList.remove("is-hidden");
      return;
    }

    empty.classList.add("is-hidden");

    host.innerHTML = _orgHistoryItems.map(item => {
      const structureType = normalizeStructureType(item?.type_entreprise);
      const badgeClass = structureType === "site" ? "cs-org-badge--site" : "cs-org-badge--entreprise";
      const ville = textOrDash(item?.ville_ent);
      const profil = formatProfilStructurelLabel(item?.profil_structurel);
      const parent = textOrDash(item?.previous_parent_name);
      const descendants = parseInt(item?.nb_descendants, 10) || 0;
      const childLabel = descendants > 0 ? ` • ${descendants} descendant(s)` : "";

      return `
        <div class="cs-history-row">
          <div class="cs-history-main">
            <span class="sb-badge cs-org-badge ${badgeClass}">${structureType === "site" ? "Site" : "Entreprise"}</span>
            <div class="cs-history-text">
              <div class="cs-history-title">${escHtml(textOrDash(item?.nom_ent))}</div>
              <div class="cs-history-sub">${escHtml(profil)}${ville !== "—" ? ` • ${escHtml(ville)}` : ""} • Ancien parent : ${escHtml(parent)}${childLabel}</div>
            </div>
          </div>

          <div class="cs-history-actions">
            <button type="button" class="sb-btn sb-btn--secondary sb-btn--xs" data-org-restore-id="${escHtml(item.id_ent)}">Réactiver ici</button>
            <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-org-promote-id="${escHtml(item.id_ent)}">Client direct</button>
          </div>
        </div>
      `;
    }).join("");
  }

  async function loadOrgHistoryData(){
    const ownerId = getOwnerId();
    const clientId = getClientId();
    const token = await ensureAuthReady();
    if (!token) return;

    const data = await apiJson(
      `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}/structures/history`,
      token
    );

    _orgHistoryItems = Array.isArray(data?.items) ? data.items : [];
    renderOrgHistoryRows();
  }

  async function restoreOrgStructureHere(idEnt){
    const ownerId = getOwnerId();
    const clientId = getClientId();
    const id = (idEnt || "").toString().trim();
    if (!ownerId || !clientId || !id) return;

    const token = await ensureAuthReady();
    if (!token) return;

    await apiJson(
      `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}/structures/${encodeURIComponent(id)}/restore_here`,
      token,
      { method: "POST" }
    );

    await loadOrganisationData();
    await loadOrgHistoryData();
  }

  async function promoteOrgStructureDirect(idEnt){
    const ownerId = getOwnerId();
    const clientId = getClientId();
    const id = (idEnt || "").toString().trim();
    if (!ownerId || !clientId || !id) return;

    const confirmed = window.confirm("Réactiver cette structure comme client direct dans le portefeuille Studio ?");
    if (!confirmed) return;

    const token = await ensureAuthReady();
    if (!token) return;

    await apiJson(
      `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}/structures/${encodeURIComponent(id)}/promote_direct`,
      token,
      { method: "POST" }
    );

    await loadOrganisationData();
    await loadOrgHistoryData();
  }

  async function openOrgHistoryModal(){
    await loadOrgHistoryData();
    byId("modalOrgHistory")?.classList.add("show");
  }

  function closeOrgHistoryModal(){
    byId("modalOrgHistory")?.classList.remove("show");
  }

  function renderHeader(){
    byId("csClientMini").textContent = _detail?.nom_ent || "Client";
    byId("csClientTitle").textContent = _detail?.nom_ent || "Client";

    const ownerName = (_context?.nom_owner || "").trim();
    const ville = (_detail?.ville_ent || "").trim();
    const pays = (_detail?.pays_ent || "").trim();

    const parts = [];
    if (ownerName) parts.push(`Owner gestionnaire : ${ownerName}`);
    if (ville) parts.push(ville);
    if (pays) parts.push(pays);

    byId("csClientSub").textContent = parts.join(" • ") || "Contexte client chargé.";

    const badges = [];
    if (_detail?.studio_actif) {
      badges.push(`<span class="cs-badge cs-badge--studio">Studio actif</span>`);
    }
    if (_detail?.gestion_acces_studio_autorisee) {
      badges.push(`<span class="cs-badge cs-badge--deleg">Gestion accès Studio</span>`);
    }
    if (_detail?.group_ok) {
      badges.push(`<span class="cs-badge cs-badge--group">${textOrDash(_detail?.type_groupe || "Groupe / réseau")}</span>`);
    }
    if (_detail?.tete_groupe) {
      badges.push(`<span class="cs-badge cs-badge--head">Tête de groupe</span>`);
    }

    byId("csClientBadges").innerHTML = badges.join("");
  }

  function renderDashboard(){
    setText("dashStudioActif", yesNo(_detail?.studio_actif));
    setText("dashDelegationStudio", yesNo(_detail?.gestion_acces_studio_autorisee));
    setText("dashGroupOk", yesNo(_detail?.group_ok));
    setText("dashParents", _detail?.nb_entites_parents);
    setText("dashChildren", _detail?.nb_entites_enfants);

    setText("sumNomEnt", _detail?.nom_ent);
    setText("sumVilleEnt", _detail?.ville_ent);
    setText("sumPaysEnt", _detail?.pays_ent);
    setText("sumEffectifEnt", _detail?.effectif_ent);
    setText("sumSiretEnt", _detail?.siret_ent);
    setText("sumNumEntreprise", _detail?.num_entreprise);

    setText("sumIdcc", _detail?.idcc);
    setText("sumIdccLibelle", _detail?.idcc_libelle);
    setText("sumCodeApe", _detail?.code_ape_ent);
    setText("sumCodeApeIntitule", _detail?.code_ape_intitule);
    setText("sumOpcoNom", _detail?.opco_nom);
    setText("sumOwnerNom", _context?.nom_owner);
  }

  function renderIdentification(){
    setInputValue("ficheNomEnt", _detail?.nom_ent);
    setInputValue("ficheSiretEnt", _detail?.siret_ent);
    setInputValue("ficheNumEntreprise", _detail?.num_entreprise);
    setDateValue("ficheDateCreation", _detail?.date_creation);
    setInputValue("ficheEffectifEnt", _detail?.effectif_ent);
    setInputValue("ficheNumTvaEnt", _detail?.num_tva_ent);

    setInputValue("ficheAdresseEnt", _detail?.adresse_ent);
    setInputValue("ficheAdresseCpltEnt", _detail?.adresse_cplt_ent);
    setInputValue("ficheCpEnt", normalizePostalCode(_detail?.cp_ent));
    setInputValue("ficheVilleEnt", normalizeCity(_detail?.ville_ent));
    setInputValue("fichePaysEnt", _detail?.pays_ent);
    setInputValue("ficheTelephoneEnt", formatPhoneFr(_detail?.telephone_ent));
    setInputValue("ficheEmailEnt", _detail?.email_ent);
    setInputValue("ficheSiteWeb", _detail?.site_web);

    setInputValue("ficheIdcc", _detail?.idcc);
    setHelp("ficheIdccHelp", _detail?.idcc_libelle);
    setInputValue("ficheCodeApeEnt", normalizeApeCode(_detail?.code_ape_ent));
    setHelp("ficheCodeApeHelp", _detail?.code_ape_intitule);

    renderOpcoOptions();
    updateOpcoSiteLink();

    setInputValue("ficheProfilStructurel", normalizeProfilStructurel(_detail?.profil_structurel));
    setCheckboxValue("ficheGroupOk", _detail?.group_ok);
    setCheckboxValue("ficheTeteGroupe", _detail?.tete_groupe);
    setInputValue("ficheNomGroupe", _detail?.nom_groupe);
    setInputValue("ficheTypeGroupe", _detail?.type_groupe);

    setText("idNbParents", _detail?.nb_entites_parents);
    setText("idNbChildren", _detail?.nb_entites_enfants);

    syncLinkedStructuresVisibility();
    syncStructureProfileUi();
    queuePostalLookupFromCurrentValues();
  }

  function readFichePayload(){
    return {
      nom_ent: inputValue("ficheNomEnt"),
      siret_ent: inputValue("ficheSiretEnt"),
      date_creation: inputValue("ficheDateCreation") || null,
      effectif_ent: inputValue("ficheEffectifEnt"),
      num_tva_ent: inputValue("ficheNumTvaEnt"),

      adresse_ent: inputValue("ficheAdresseEnt"),
      adresse_cplt_ent: inputValue("ficheAdresseCpltEnt"),
      cp_ent: inputValue("ficheCpEnt"),
      ville_ent: inputValue("ficheVilleEnt"),
      pays_ent: inputValue("fichePaysEnt"),
      telephone_ent: formatPhoneFr(inputValue("ficheTelephoneEnt")),
      email_ent: inputValue("ficheEmailEnt"),
      site_web: inputValue("ficheSiteWeb"),

      idcc: inputValue("ficheIdcc"),
      code_ape_ent: normalizeApeCode(inputValue("ficheCodeApeEnt")),
      id_opco: inputValue("ficheIdOpco"),

      profil_structurel: normalizeProfilStructurel(inputValue("ficheProfilStructurel")),
      group_ok: !!byId("ficheGroupOk")?.checked,
      tete_groupe: !!byId("ficheTeteGroupe")?.checked,
      nom_groupe: inputValue("ficheNomGroupe"),
      type_groupe: inputValue("ficheTypeGroupe"),
    };
  }

  function syncStructureProfileUi(){
    const profil = normalizeProfilStructurel(inputValue("ficheProfilStructurel"));
    const showGroupFields = isHoldingProfil(profil);

    document.querySelectorAll(".js-struct-group-field").forEach(el => {
      el.classList.toggle("is-hidden", !showGroupFields);
    });

    const groupOk = byId("ficheGroupOk");
    const tete = byId("ficheTeteGroupe");
    const nom = byId("ficheNomGroupe");
    const type = byId("ficheTypeGroupe");

    if (!showGroupFields) {
      if (groupOk) {
        groupOk.checked = false;
        groupOk.disabled = true;
      }
      if (tete) {
        tete.checked = false;
        tete.disabled = true;
      }
      if (nom) {
        nom.value = "";
        nom.disabled = true;
      }
      if (type) {
        type.value = "";
        type.disabled = true;
      }
      return;
    }

    const isGroup = !!groupOk?.checked;

    if (groupOk) {
      groupOk.disabled = !_ficheEditMode;
    }
    if (tete) {
      tete.disabled = !_ficheEditMode || !isGroup;
      if (!isGroup) tete.checked = false;
    }
    if (nom) {
      nom.disabled = !_ficheEditMode || !isGroup;
      if (!isGroup) nom.value = "";
    }
    if (type) {
      type.disabled = !_ficheEditMode || !isGroup;
      if (!isGroup) type.value = "";
    }
  }

  function setFicheEditMode(enabled){
      _ficheEditMode = !!enabled;

      const controls = document.querySelectorAll(".cs-form-ctrl, #ficheGroupOk, #ficheTeteGroupe");
      controls.forEach(el => {
          el.disabled = !_ficheEditMode;
      });

      const btnEdit = byId("btnFicheEdit");
      const btnCancel = byId("btnFicheCancel");
      const btnSave = byId("btnFicheSave");
      const btnLoadPublicData = byId("btnFicheLoadPublicData");

      if (btnEdit) {
          btnEdit.classList.toggle("is-hidden", _ficheEditMode);
      }

      if (btnCancel) {
          btnCancel.classList.toggle("is-hidden", !_ficheEditMode);
      }

      if (btnSave) {
          btnSave.classList.toggle("is-hidden", !_ficheEditMode);
      }

      if (btnLoadPublicData) {
          btnLoadPublicData.classList.toggle("is-hidden", !_ficheEditMode);
      }

      syncStructureProfileUi();
  }

  async function saveFiche(){
    if (_ficheSaving) return;

    const ownerId = getOwnerId();
    const clientId = getClientId();
    const btnSave = byId("btnFicheSave");
    const btnCancel = byId("btnFicheCancel");
    const btnEdit = byId("btnFicheEdit");

    try {
      _ficheSaving = true;
      if (btnSave) {
        btnSave.disabled = true;
        btnSave.textContent = "Enregistrement...";
      }
      if (btnCancel) btnCancel.disabled = true;
      if (btnEdit) btnEdit.disabled = true;

      const token = await ensureAuthReady();
      if (!token) return;

      const payload = readFichePayload();
      const updated = await apiJson(
        `${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}`,
        token,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      );

      _detail = updated || {};
      renderDynamicLabels();
      renderHeader();
      renderDashboard();
      renderIdentification();
      await loadOrganisationData();
      setFicheEditMode(false);
      setMessage("");
    } catch (e) {
      setMessage(e.message || "Erreur lors de l’enregistrement de la fiche.");
    } finally {
      _ficheSaving = false;
      if (btnSave) {
        btnSave.disabled = false;
        btnSave.textContent = "Enregistrer";
      }
      if (btnCancel) btnCancel.disabled = false;
      if (btnEdit) btnEdit.disabled = false;
    }
  }

  function bindOrganisationActions(){
    byId("btnOrgToggle")?.addEventListener("click", () => {
      _orgCollapsed = !_orgCollapsed;
      renderOrganisationSection();
    });

    byId("btnOrgAddSite")?.addEventListener("click", () => {
      setMessage("");
      openOrgCreateModal("site", getClientId());
    });

    byId("btnOrgAddEntreprise")?.addEventListener("click", () => {
      setMessage("");
      openOrgCreateModal("entreprise", getClientId());
    });

    byId("btnOrgModalClose")?.addEventListener("click", closeOrgCreateModal);
    byId("btnOrgModalCancel")?.addEventListener("click", closeOrgCreateModal);
    byId("btnOrgModalSave")?.addEventListener("click", async () => {
      await saveOrgCreateStructure();
    });

    byId("btnOrgHistoryClose")?.addEventListener("click", closeOrgHistoryModal);
    byId("btnOrgHistoryCancel")?.addEventListener("click", closeOrgHistoryModal);

    byId("orgCreateProfilStructurel")?.addEventListener("change", syncOrgCreateProfileUi);
    byId("orgCreateGroupOk")?.addEventListener("change", syncOrgCreateProfileUi);

    byId("orgStructuresTree")?.addEventListener("click", async (e) => {
      const toggleBtn = e.target.closest("[data-org-toggle]");
      if (toggleBtn) {
        e.preventDefault();
        e.stopPropagation();

        const id = (toggleBtn.getAttribute("data-org-toggle") || "").trim();
        if (!id) return;

        if (_orgExpandedIds.has(id)) _orgExpandedIds.delete(id);
        else _orgExpandedIds.add(id);

        renderOrganisationRows();
        return;
      }

      const addBtn = e.target.closest("[data-org-add-kind]");
      if (addBtn) {
        e.preventDefault();
        e.stopPropagation();

        const kind = (addBtn.getAttribute("data-org-add-kind") || "").trim();
        const parentId = (addBtn.getAttribute("data-parent-id") || "").trim();
        if (!kind || !parentId) return;

        setMessage("");
        openOrgCreateModal(kind, parentId);
        return;
      }

      const editBtn = e.target.closest("[data-org-edit-id]");
      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();

        const id = (editBtn.getAttribute("data-org-edit-id") || "").trim();
        if (!id) return;

        openStructureSpace(id);
        return;
      }

      const detachBtn = e.target.closest("[data-org-detach-id]");
      if (detachBtn) {
        e.preventDefault();
        e.stopPropagation();

        const id = (detachBtn.getAttribute("data-org-detach-id") || "").trim();
        const parentId = (detachBtn.getAttribute("data-parent-id") || "").trim();
        if (!id || !parentId) return;

        try {
          await detachOrgStructure(parentId, id);
          setMessage("");
        } catch (err) {
          setMessage(err?.message || "Erreur lors du retrait du rattachement.");
        }
      }
    });

    byId("orgHistoryList")?.addEventListener("click", async (e) => {
      const restoreBtn = e.target.closest("[data-org-restore-id]");
      if (restoreBtn) {
        e.preventDefault();
        e.stopPropagation();

        try {
          await restoreOrgStructureHere((restoreBtn.getAttribute("data-org-restore-id") || "").trim());
          setMessage("");
        } catch (err) {
          setMessage(err?.message || "Erreur lors de la réactivation.");
        }
        return;
      }

      const promoteBtn = e.target.closest("[data-org-promote-id]");
      if (promoteBtn) {
        e.preventDefault();
        e.stopPropagation();

        try {
          await promoteOrgStructureDirect((promoteBtn.getAttribute("data-org-promote-id") || "").trim());
          setMessage("");
        } catch (err) {
          setMessage(err?.message || "Erreur lors du passage en client direct.");
        }
      }
    });
  }

  function bindFicheActions(){
    byId("btnFicheEdit")?.addEventListener("click", () => {
      setMessage("");
      renderIdentification();
      setFicheEditMode(true);
    });

    byId("btnFicheCancel")?.addEventListener("click", () => {
      setMessage("");
      renderIdentification();
      setFicheEditMode(false);
    });

    byId("btnFicheSave")?.addEventListener("click", async () => {
      await saveFiche();
    });

    byId("btnFicheLoadPublicData")?.addEventListener("click", async () => {
      await loadPublicCompanyIntoForm("fiche");
    });

    byId("ficheProfilStructurel")?.addEventListener("change", syncStructureProfileUi);
    byId("ficheGroupOk")?.addEventListener("change", syncStructureProfileUi);
  }

  async function loadData(){
    const ownerId = getOwnerId();
    const clientId = getClientId();

    if (!ownerId) {
      throw new Error("Paramètre owner manquant dans l’URL.");
    }
    if (!clientId) {
      throw new Error("Paramètre client manquant dans l’URL.");
    }

    const token = await ensureAuthReady();
    if (!token) return;

    const [detail, clientsData, context, opcoItems] = await Promise.all([
      apiJson(`${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}`, token),
      apiJson(`${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}`, token),
      apiJson(`${API_BASE}/studio/context/${encodeURIComponent(ownerId)}`, token),
      loadOpcoOptions(),
    ]);

    _detail = detail || {};
    _summary = clientsData?.summary || {};
    _ownerFeatures = clientsData?.owner_features || {};
    _context = context || {};
    _opcoOptions = Array.isArray(opcoItems) ? opcoItems : [];

    renderLinks();
    renderDynamicLabels();
    renderHeader();
    renderDashboard();
    renderIdentification();
    await loadOrganisationData();
    setFicheEditMode(false);
    setSection("dashboard");

    loadOrganisationWorkspace({ silent: true }).catch(() => {});
  }

  window.addEventListener("DOMContentLoaded", async () => {
    bindNavigation();
    bindFicheActions();
    bindOrganisationActions();
    bindPostalAssist();
    bindPhoneMask();
    bindApeMask();
    bindOpcoSelect();
    bindOrgCreateMasks();
    renderLinks();
    setFicheEditMode(false);

    try {
      await loadData();
      setMessage("");
    } catch (e) {
      setMessage(e.message || "Erreur de chargement de l’espace client.");
    }
  });
})();


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
    let _posteAiDraftMeta = null;
    let _posteCompAiResults = { existing: [], missing: [] };
    let _posteCompCreateCtx = null;
    let _posteCompCreateDomainsLoaded = false;
    let _posteCompCreateDomainItems = [];
    let _posteCompCreateCrit = null;
    let _posteCompCreateCritEditIdx = null;
    let _iaBusyTimer = null;
    let _iaBusyStartedAt = 0;

    // --- Poste > Certifications (Exigences)
    let _posteCertItems = [];
    let _posteCertSearch = "";
    let _posteCertSearchTimer = null;

    let _posteCertAddItems = [];
    let _posteCertAddItemsAll = [];
    let _posteCertAddSearch = "";
    let _posteCertAddTimer = null;
    let _posteCertAddCategory = "";

    let _posteCertEdit = null; // objet en cours d'édition (merge cert + assoc)

    const POSTE_IMPORT_EXTENSIONS = [".doc", ".docx", ".pdf"];
    const POSTE_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
    let _posteImportFile = null;
    let _posteCcnContext = null;
    let _posteCcnAnalysis = null;   

    function getOwnerId() {
        const forced = (window.__orgScopeOwnerId || "").toString().trim();
        if (forced) return forced;

        const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
        if (pid) return pid;
        return (new URL(window.location.href).searchParams.get("id") || "").trim();
    }

    function getScopeEntId(){
        const forced = (window.__orgScopeEntId || "").toString().trim();
        if (forced) return forced;
        return getOwnerId();
    }

    function appendOrgScope(url){
        const raw = String(url || "");
        if (!raw) return raw;

        const u = new URL(raw, window.location.origin);
        const ownerId = getOwnerId();
        const entId = getScopeEntId();

        if (!entId || entId === ownerId) return u.toString();
        if (u.searchParams.has("id_ent")) return u.toString();

        u.searchParams.set("id_ent", entId);
        return u.toString();
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

    function getOrganisationRoot(){
        return document.querySelector('#view-organisation[data-view="organisation"]');
    }

    function byId(id){
        const root = getOrganisationRoot();
        if (root){
            const el = root.querySelector(`#${id}`);
            if (el) return el;
        }
        return document.getElementById(id);
    }

    function setStatus(msg, isError = false){
        const el = byId("orgStatus");
        if (!el) return;

        const text = String(msg || "").trim();
        if (!text || text === "—") {
            el.textContent = "";
            el.style.display = "none";
            return;
        }

        el.textContent = text;
        el.style.display = "";
        el.style.background = isError ? "#fff1f2" : "#f8fafc";
        el.style.borderColor = isError ? "#fecaca" : "#e5e7eb";
        el.style.color = isError ? "#991b1b" : "#334155";
    }

    function formatOrgDiag(step, extra){
        const payload = Object.assign({
            step,
            ownerId: getOwnerId(),
            scopeEntId: getScopeEntId(),
            selectedService: _selectedService || "__all__"
        }, extra || {});

        const parts = [
            `étape=${payload.step}`,
            `owner=${payload.ownerId || "-"}`,
            `scope=${payload.scopeEntId || "-"}`,
            `service=${payload.selectedService || "-"}`
        ];

        if (payload.url) parts.push(`url=${payload.url}`);
        if (payload.nbServices !== undefined) parts.push(`nbServices=${payload.nbServices}`);
        if (payload.nbPostes !== undefined) parts.push(`nbPostes=${payload.nbPostes}`);
        if (payload.nbPostesNonLies !== undefined) parts.push(`nbPostesNonLies=${payload.nbPostesNonLies}`);
        if (payload.message) parts.push(`message=${payload.message}`);

        return parts.join(" | ");
    }

    function traceOrg(step, extra){
        const line = formatOrgDiag(step, extra);
        console.info("[Organisation]", line, extra || {});
        setStatus(line, false);
    }

    function traceOrgError(step, error, extra){
        const message = error?.message || String(error);
        const line = formatOrgDiag(step, Object.assign({}, extra || {}, { message }));
        console.error("[Organisation]", line, error);
        setStatus(line, true);
    }

    function esc(s){
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    function htmlToPlainText(html){
        const div = document.createElement("div");
        div.innerHTML = String(html || "");
        return (div.textContent || div.innerText || "")
            .replace(/\u00a0/g, " ")
            .replace(/\r/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function openIaBusyOverlay(title, text){
        const ov = byId("iaBusyOverlay");
        const ttl = byId("iaBusyTitle");
        const txt = byId("iaBusyText");
        const sec = byId("iaBusySeconds");
        if (!ov) return;

        if (ttl) ttl.textContent = title || "Analyse IA en cours";
        if (txt) txt.textContent = text || "Traitement en cours...";
        if (sec) sec.textContent = "0";

        _iaBusyStartedAt = Date.now();
        if (_iaBusyTimer) clearInterval(_iaBusyTimer);
        _iaBusyTimer = setInterval(() => {
            const s = Math.max(0, Math.floor((Date.now() - _iaBusyStartedAt) / 1000));
            const el = byId("iaBusySeconds");
            if (el) el.textContent = String(s);
        }, 250);

        ov.style.display = "flex";
    }

    function closeIaBusyOverlay(){
        if (_iaBusyTimer){
            clearInterval(_iaBusyTimer);
            _iaBusyTimer = null;
        }
        const ov = byId("iaBusyOverlay");
        if (ov) ov.style.display = "none";
    }

    function normText(v){
        return String(v || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();
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

    function setPosteCompCritRing(score){
        const ring = byId("posteCompCritRing");
        const prog = byId("posteCompCritRingProg");
        const val = byId("posteCompCritRingVal");
        if (!ring || !prog || !val) return;

        const s = Math.max(0, Math.min(100, parseInt(score ?? 0, 10) || 0));
        val.textContent = String(s);
        prog.setAttribute("stroke-dasharray", `${s} 100`);

        ring.classList.remove("sb-ring--low","sb-ring--mid","sb-ring--high");
        ring.classList.add(s < 35 ? "sb-ring--low" : s < 70 ? "sb-ring--mid" : "sb-ring--high");
    }

    function setPosteCompEditNiv(v){
        const niv = (v || "B").toString().trim().toUpperCase();
        const r = document.querySelector(`input[name="posteCompEditNiv"][value="${niv}"]`);
        if (r) r.checked = true;
        refreshPosteCompNivCards();
    }

    function refreshPosteCompNivCards(){
        document.querySelectorAll("#posteCompNivGrid .sb-level-card").forEach(card => {
            const r = card.querySelector('input[type="radio"]');
            card.classList.toggle("is-selected", !!(r && r.checked));
        });
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

    function formatFileSize(bytes){
        const n = parseInt(bytes || 0, 10) || 0;
        if (n < 1024) return `${n} o`;
        if (n < (1024 * 1024)) return `${(n / 1024).toFixed(1)} Ko`;
        return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
    }

    function getPosteImportExt(filename){
        const s = String(filename || "").trim().toLowerCase();
        const i = s.lastIndexOf(".");
        return i >= 0 ? s.slice(i) : "";
    }

    function resetPosteImportState(){
        _posteImportFile = null;

        const input = byId("posteImportFileInput");
        const card = byId("posteImportFileCard");
        const name = byId("posteImportFileName");
        const meta = byId("posteImportFileMeta");
        const empty = byId("posteImportEmpty");
        const analyze = byId("btnPosteImportAnalyze");
        const change = byId("btnPosteImportChange");
        const drop = byId("posteImportDropzone");

        if (input) input.value = "";
        if (card) card.style.display = "none";
        if (name) name.textContent = "—";
        if (meta) meta.textContent = "—";
        if (empty) empty.textContent = "Aucun document sélectionné.";
        if (analyze){
            analyze.disabled = true;
            analyze.style.opacity = ".6";
        }
        if (change){
            change.disabled = true;
            change.style.opacity = ".6";
        }
        if (drop) drop.classList.remove("is-drag");
    }

    function refreshPosteImportButton(){
        const btn = byId("btnPosteImport");
        if (!btn) return;
        btn.style.display = (_posteModalMode === "create") ? "" : "none";
    }

    function refreshPosteFooterActions(){
        const isCreate = (_posteModalMode === "create");

        const bA = byId("btnPosteArchive");
        const bD = byId("btnPosteDuplicate");

        if (bA){
            bA.style.display = isCreate ? "none" : "";
            bA.disabled = isCreate;
            bA.style.opacity = isCreate ? ".6" : "";
            bA.title = "";
            if (isCreate) bA.textContent = "Archiver";
        }

        if (bD){
            bD.style.display = isCreate ? "none" : "";
            bD.disabled = isCreate;
            bD.style.opacity = isCreate ? ".6" : "";
            bD.title = "";
        }
    }

    function setPosteImportFile(file){
        if (!file) return;

        const ext = getPosteImportExt(file.name || "");
        if (!POSTE_IMPORT_EXTENSIONS.includes(ext)){
            throw new Error("Format non supporté. Utilise un fichier .doc, .docx ou .pdf.");
        }

        if ((file.size || 0) > POSTE_IMPORT_MAX_BYTES){
            throw new Error("Document trop volumineux. Limite : 15 Mo.");
        }

        _posteImportFile = file;

        const card = byId("posteImportFileCard");
        const name = byId("posteImportFileName");
        const meta = byId("posteImportFileMeta");
        const empty = byId("posteImportEmpty");
        const analyze = byId("btnPosteImportAnalyze");
        const change = byId("btnPosteImportChange");

        if (card) card.style.display = "";
        if (name) name.textContent = file.name || "Document";
        if (meta) meta.textContent = `${ext.toUpperCase().replace(".", "")} · ${formatFileSize(file.size || 0)}`;
        if (empty) empty.textContent = "Document chargé. Vérifie le fichier puis lance l’analyse.";
        if (analyze){
            analyze.disabled = false;
            analyze.style.opacity = "";
        }
        if (change){
            change.disabled = false;
            change.style.opacity = "";
        }
    }

    function openPosteImportModal(){
        if (_posteModalMode !== "create") return;
        resetPosteImportState();
        openModal("modalPosteImport");
    }

    function closePosteImportModal(){
        closeModal("modalPosteImport");
    }

    async function applyImportedPosteDraft(portal, draft){
        _posteAiDraftMeta = draft || null;

        if (draft?.intitule_poste !== undefined) byId("posteIntitule").value = String(draft.intitule_poste || "");
        if (draft?.mission_principale !== undefined) byId("posteMission").value = String(draft.mission_principale || "");
        if (draft?.responsabilites_html !== undefined) rtSetHtml("posteResp", String(draft.responsabilites_html || ""));

        await ensureNsfGroupes(portal);
        fillNsfSelect(draft?.nsf_groupe_code || "");
        fillPosteContraintesTab({
            niveau_education_minimum: draft?.niveau_education_minimum || "",
            nsf_groupe_code: draft?.nsf_groupe_code || "",
            nsf_groupe_obligatoire: !!draft?.nsf_groupe_obligatoire,
            mobilite: draft?.mobilite || "",
            risque_physique: draft?.risque_physique || "",
            perspectives_evolution: draft?.perspectives_evolution || "",
            niveau_contrainte: draft?.niveau_contrainte || "",
            detail_contrainte: draft?.detail_contrainte || "",
        });

        const sub = byId("posteModalSub");
        if (sub){
            sub.textContent = "Brouillon importé depuis un document. Vérifie puis enregistre.";
        }

        seedPosteAiModalFromCurrent();
        setPosteTab("def");
    }

    async function launchPosteImport(portal){
        if (!_posteImportFile){
            portal.showAlert("error", "Sélectionne un document avant de lancer l’analyse.");
            return;
        }

        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const btnAnalyze = byId("btnPosteImportAnalyze");
        const btnChange = byId("btnPosteImportChange");

        if (btnAnalyze){
            btnAnalyze.disabled = true;
            btnAnalyze.style.opacity = ".6";
            btnAnalyze.textContent = "Analyse…";
        }
        if (btnChange){
            btnChange.disabled = true;
            btnChange.style.opacity = ".6";
        }

        openIaBusyOverlay(
            "Lecture du document en cours",
            "Extraction du texte, analyse de la fiche et préremplissage du poste..."
        );

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const fd = new FormData();
            fd.append("file", _posteImportFile, _posteImportFile.name || "document");

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/import_document`),
                {
                    method: "POST",
                    headers,
                    body: fd,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur import document (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){}
                throw new Error(msg);
            }

            const draft = await resp.json();
            await applyImportedPosteDraft(portal, draft);

            closePosteImportModal();
            portal.showAlert("", "");
        } finally {
            closeIaBusyOverlay();

            if (btnAnalyze){
                btnAnalyze.disabled = !_posteImportFile;
                btnAnalyze.style.opacity = _posteImportFile ? "" : ".6";
                btnAnalyze.textContent = "Lancer l’analyse";
            }
            if (btnChange){
                btnChange.disabled = !_posteImportFile;
                btnChange.style.opacity = _posteImportFile ? "" : ".6";
            }
        }
    }

    async function resolveStudioAccessToken(){
        try{
            const pac = window.PortalAuthCommon;
            if (pac && typeof pac.getSession === "function"){
                const s = await pac.getSession();
                if (s && s.access_token) return String(s.access_token);
                if (s && s.session && s.session.access_token) return String(s.session.access_token);
                if (s && s.data && s.data.session && s.data.session.access_token) return String(s.data.session.access_token);
            }
        } catch(_){}

        if (window.portal && window.portal.accessToken) return String(window.portal.accessToken);
        if (window.portal && window.portal.token) return String(window.portal.token);

        return "";
    }

    function getFilenameFromContentDisposition(value){
        const raw = String(value || "").trim();
        if (!raw) return "";

        const star = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
        if (star && star[1]){
            try{
                return decodeURIComponent(star[1]).replace(/^["']|["']$/g, "").trim();
            } catch(_){
                return String(star[1]).replace(/^["']|["']$/g, "").trim();
            }
        }

        const quoted = raw.match(/filename\s*=\s*"([^"]+)"/i);
        if (quoted && quoted[1]){
            return String(quoted[1]).trim();
        }

        const plain = raw.match(/filename\s*=\s*([^;]+)/i);
        if (plain && plain[1]){
            return String(plain[1]).replace(/^["']|["']$/g, "").trim();
        }

        return "";
    }

    async function openOrgChartPdf(portal){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const viewer = window.open("", "_blank");

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/organigramme_pdf/${encodeURIComponent(ownerId)}`),
                {
                    method: "GET",
                    headers,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur PDF (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){}
                throw new Error(msg);
            }

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            if (viewer){
                viewer.location = blobUrl;
            } else {
                window.open(blobUrl, "_blank");
            }

            setTimeout(() => {
                try { URL.revokeObjectURL(blobUrl); } catch(_){}
            }, 60000);

        } catch (e){
            if (viewer) viewer.close();
            throw e;
        }
    }

    async function openPosteFichePdf(portal, idPoste){
        const ownerId = getOwnerId();
        const pid = String(idPoste || "").trim();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");
        if (!pid) throw new Error("Poste manquant.");

        const viewer = window.open("", "_blank");

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/fiche_pdf`),
                {
                    method: "GET",
                    headers,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur PDF (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){ }
                throw new Error(msg);
            }

            const suggestedName =
                getFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) ||
                "Fiche de poste.pdf";

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const escHtml = (v) => String(v || "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");

            const title = suggestedName || "Fiche de poste.pdf";

            if (viewer){
                viewer.document.open();
                viewer.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escHtml(title)}</title>
<style>
html, body {
  margin: 0;
  height: 100%;
  background: #f5f6f8;
}
body {
  display: flex;
  flex-direction: column;
}
.bar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  box-sizing: border-box;
  border-bottom: 1px solid #d7dbe2;
  background: #ffffff;
  font: 14px/1.2 Arial, sans-serif;
  color: #1f2937;
}
.bar__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.bar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid #9db3e8;
  background: #eef4ff;
  color: #28407a;
  text-decoration: none;
  font-weight: 600;
  flex: 0 0 auto;
}
.viewer {
  flex: 1;
  min-height: 0;
}
.viewer iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
</head>
<body>
  <div class="bar">
    <div class="bar__title">${escHtml(title)}</div>
    <a class="bar__btn" href="${blobUrl}" download="${escHtml(title)}">Télécharger</a>
  </div>
  <div class="viewer">
    <iframe src="${blobUrl}" title="${escHtml(title)}"></iframe>
  </div>
</body>
</html>`);
                viewer.document.close();

                try{
                    viewer.addEventListener("beforeunload", () => {
                        try { URL.revokeObjectURL(blobUrl); } catch(_){}
                    }, { once: true });
                } catch(_){}
            } else {
                window.open(blobUrl, "_blank");
                setTimeout(() => {
                    try { URL.revokeObjectURL(blobUrl); } catch(_){}
                }, 60000);
            }

        } catch (e){
            if (viewer) viewer.close();
            throw e;
        }
    }

    function serviceMeta(nbPostes, nbCollabs){
        return `${nbPostes} poste(s) · ${nbCollabs} collaborateur(s)`;
    }

    function syncSelectedServiceContext(){
        if (!_selectedService || _selectedService === "__all__"){
            _selectedService = "__all__";
            _selectedServiceName = "Tous les services";
            return;
        }

        if (_selectedService === "__none__"){
            _selectedServiceName = "Non lié";
            return;
        }

        const svc = (_services || []).find(x => x.id_service === _selectedService);
        if (!svc){
            _selectedService = "__all__";
            _selectedServiceName = "Tous les services";
            return;
        }

        _selectedServiceName = svc.nom_service || "Service";
    }

    function getPosteBlockTitle(){
        if (!_selectedService || _selectedService === "__all__"){
            return "Tous les postes";
        }

        if (_selectedService === "__none__"){
            return "Postes non liés";
        }

        return `Postes du service ${_selectedServiceName || ""}`.trim();
    }

    function refreshPosteBlockTitle(){
        const el = byId("posteBlockTitle");
        if (!el) return;
        el.textContent = getPosteBlockTitle();
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

        refreshPosteBlockTitle();
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

        const url = `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`;
        traceOrg("services:start", { url });

        try {
            const data = await portal.apiJson(url);

            _totaux = data.totaux || { nb_postes: 0, nb_collabs: 0 };
            _nonLie = data.non_lie || { nb_postes: 0, nb_collabs: 0 };
            _services = data.services || [];

            if (!_loaded) {
                _selectedService = "__all__";
                _selectedServiceName = "Tous les services";
            }

            syncSelectedServiceContext();
            renderServices();
            refreshPosteBlockTitle();
            updateAddButtonState();

            traceOrg("services:ok", {
                url,
                nbServices: _services.length,
                nbPostes: _totaux.nb_postes || 0,
                nbPostesNonLies: _nonLie.nb_postes || 0
            });
        } catch (e) {
            traceOrgError("services:error", e, { url });
            throw e;
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

        traceOrg("postes:start", { url });

        try {
            const data = await portal.apiJson(url);

            const host = byId("posteList");
            if (!host) {
                traceOrg("postes:no-host", { url });
                return;
            }

            host.innerHTML = "";

            const postes = data.postes || [];
            if (!postes.length) {
                const empty = document.createElement("div");
                empty.className = "card-sub";
                empty.textContent = "Aucun poste à afficher.";
                host.appendChild(empty);

                traceOrg("postes:empty", {
                    url,
                    nbPostes: 0
                });
                return;
            }

            const iconEdit = `
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
            `;

            const iconTrash = `
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                </svg>
            `;

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

                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const pdfBtn = document.createElement("button");
                pdfBtn.type = "button";
                pdfBtn.className = "sb-icon-btn sb-icon-btn--doc";
                pdfBtn.title = "Exporter pdf";
                pdfBtn.setAttribute("aria-label", "Exporter pdf");
                pdfBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>';
                pdfBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try { await openPosteFichePdf(portal, p.id_poste); }
                    catch (err) { portal.showAlert("error", err?.message || String(err)); }
                });
                actions.appendChild(pdfBtn);

                const editBtn = document.createElement("button");
                editBtn.type = "button";
                editBtn.className = "sb-icon-btn";
                editBtn.title = "Voir/Modifier";
                editBtn.setAttribute("aria-label", "Voir/Modifier");
                editBtn.innerHTML = iconEdit;
                editBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openEditPosteModal(portal, p);
                });
                actions.appendChild(editBtn);

                const archiveBtn = document.createElement("button");
                archiveBtn.type = "button";
                archiveBtn.className = "sb-icon-btn sb-icon-btn--danger";
                archiveBtn.title = (p.actif === false) ? "Restaurer" : "Archiver";
                archiveBtn.setAttribute("aria-label", (p.actif === false) ? "Restaurer" : "Archiver");
                archiveBtn.innerHTML = iconTrash;
                archiveBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try { await toggleArchivePosteFromList(portal, p); }
                    catch (err) { portal.showAlert("error", err?.message || String(err)); }
                });
                actions.appendChild(archiveBtn);

                right.appendChild(actions);

                row.appendChild(left);
                row.appendChild(right);

                row.style.cursor = "pointer";
                row.addEventListener("click", () => openEditPosteModal(portal, p));

                host.appendChild(row);
            });

            traceOrg("postes:ok", {
                url,
                nbPostes: postes.length
            });
        } catch (e) {
            traceOrgError("postes:error", e, { url });
            throw e;
        }
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

        const btnAi = byId("btnPosteAi");
        if (btnAi){
            btnAi.style.display = (tab === "def") ? "" : "none";
        }
    }

    // ------------------------------------------------------
    // Poste > Exigences > Contraintes
    // ------------------------------------------------------
    let _posteContraintesInit = false;
    let _posteRhInit = false;
    let _nsfGroupesLoaded = false;
    let _nsfGroupes = [];

    function _fillSelect(el, items){
    if (!el) return;
    el.innerHTML = "";
    (items || []).forEach(it => {
        const opt = document.createElement("option");
        opt.value = it.value ?? "";
        opt.dataset.shortText = it.shortText ?? it.text ?? "";
        opt.dataset.longText = it.longText ?? it.text ?? "";
        opt.dataset.helpText = it.helpText ?? it.longText ?? it.text ?? "";
        opt.textContent = opt.dataset.shortText || "";
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

        const val = (v ?? "").toString();
        const tag = (el.tagName || "").toUpperCase();

        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"){
            el.value = val;
        } else {
            el.textContent = val;
        }
    }

    function _setSelectDisplayMode(el, mode){
    if (!el) return;
    Array.from(el.options || []).forEach(opt => {
        const shortTxt = opt.dataset.shortText || opt.textContent || "";
        const longTxt = opt.dataset.longText || shortTxt;
        opt.textContent = (mode === "full") ? longTxt : shortTxt;
    });
    }

    function _bindSelectShortValueDisplay(selectId, helpId){
    const sel = byId(selectId);
    const help = byId(helpId);
    if (!sel || !help) return;

    const applyShortAndHelp = () => {
        _setSelectDisplayMode(sel, "short");

        const opt = sel.options[sel.selectedIndex];
        const txt = (opt?.dataset?.helpText || opt?.dataset?.longText || "").trim();

        if (txt && txt !== "—"){
            help.textContent = txt;
            help.style.display = "";
            sel.title = txt;
        } else {
            help.textContent = "";
            help.style.display = "none";
            sel.title = "";
        }
    };

    if (!sel._sbShortDisplayBound){
        sel._sbShortDisplayBound = true;

        const showFull = () => _setSelectDisplayMode(sel, "full");

        sel.addEventListener("mousedown", showFull);
        sel.addEventListener("focus", showFull);
        sel.addEventListener("click", showFull);

        sel.addEventListener("change", () => {
            setTimeout(() => applyShortAndHelp(), 0);
        });

        sel.addEventListener("blur", () => {
            applyShortAndHelp();
        });
    }

    sel._sbRefreshHelp = applyShortAndHelp;
    applyShortAndHelp();
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
        { value:"", text:"—", shortText:"—", longText:"—", helpText:"" },
        { value:"Aucun", shortText:"Aucun", longText:"Aucun : pas de risque identifié.", helpText:"Aucun : pas de risque identifié." },
        { value:"Faible", shortText:"Faible", longText:"Faible : exposition occasionnelle, faible intensité.", helpText:"Faible : exposition occasionnelle, faible intensité." },
        { value:"Modéré", shortText:"Modéré", longText:"Modéré : exposition régulière mais maîtrisée.", helpText:"Modéré : exposition régulière mais maîtrisée." },
        { value:"Élevé", shortText:"Élevé", longText:"Élevé : risque important, pouvant générer une pathologie.", helpText:"Élevé : risque important, pouvant générer une pathologie." },
        { value:"Critique", shortText:"Critique", longText:"Critique : risque vital ou accident grave possible.", helpText:"Critique : risque vital ou accident grave possible." }
    ]);

    _fillSelect(byId("posteCtrNivContrainte"), [
        { value:"", text:"—", shortText:"—", longText:"—", helpText:"" },
        { value:"Aucune", shortText:"Aucune", longText:"Aucune : poste standard, sans pression ni particularité.", helpText:"Aucune : poste standard, sans pression ni particularité." },
        { value:"Modérée", shortText:"Modérée", longText:"Modérée : quelques contraintes psychosociales/organisationnelles.", helpText:"Modérée : quelques contraintes psychosociales/organisationnelles." },
        { value:"Élevée", shortText:"Élevée", longText:"Élevée : forte pression, conditions difficiles, grande responsabilité.", helpText:"Élevée : forte pression, conditions difficiles, grande responsabilité." },
        { value:"Critique", shortText:"Critique", longText:"Critique : stress ou responsabilité vitale.", helpText:"Critique : stress ou responsabilité vitale." }
    ]);

    _bindSelectShortValueDisplay("posteCtrRisquePhys", "posteCtrRisquePhysHelp");
    _bindSelectShortValueDisplay("posteCtrNivContrainte", "posteCtrNivContrainteHelp");
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
    // Poste > Paramétrage RH
    // ------------------------------------------------------
    function rhSourceLabel(v){
        const s = (v || "").toString().trim().toLowerCase();
        if (s === "studio") return "Studio";
        if (s === "desktop") return "Desktop";
        if (s === "insights") return "Insights";
        return "—";
    }

    function formatRhDateMaj(v){
        const s = (v || "").toString().trim();
        if (!s) return "—";

        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
        if (m){
            const dd = m[3];
            const mm = m[2];
            const yy = m[1];
            const hh = m[4] || "";
            const mi = m[5] || "";
            return hh && mi ? `${dd}/${mm}/${yy} ${hh}:${mi}` : `${dd}/${mm}/${yy}`;
        }

        const d = new Date(s);
        if (!Number.isNaN(d.getTime())){
            return d.toLocaleString("fr-FR", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            });
        }

        return s;
    }

    function refreshPosteRhCriticiteHelp(){
        const sel = byId("posteRhCriticite");
        const help = byId("posteRhCriticiteHelp");
        if (!sel || !help) return;

        const v = (sel.value || "").trim();
        if (v === "1"){
            help.textContent = "1 = Faible : poste peu sensible, impact limité.";
        } else if (v === "2"){
            help.textContent = "2 = Modérée : poste important, impact réel sur l’activité.";
        } else if (v === "3"){
            help.textContent = "3 = Forte : poste clé, difficile à remplacer ou à sécuriser.";
        } else {
            help.textContent = "";
        }
    }

    function refreshPosteRhDateFinVisibility(){
        const statut = (byId("posteRhStatut")?.value || "").trim().toLowerCase();
        const wrap = byId("posteRhDateFinWrap");
        const fin = byId("posteRhDateFin");
        if (!wrap || !fin) return;

        const show = (statut === "gele" || statut === "temporaire");
        wrap.style.display = show ? "" : "none";

        if (!show){
            fin.value = "";
        }
    }

    function initPosteRhTab(){
        if (_posteRhInit) return;
        _posteRhInit = true;

        _fillSelect(byId("posteRhStatut"), [
            { value:"actif", text:"Actif" },
            { value:"a_pourvoir", text:"À pourvoir" },
            { value:"gele", text:"Gelé" },
            { value:"temporaire", text:"Temporaire" },
            { value:"archive", text:"Archivé (RH)" }
        ]);

        _fillSelect(byId("posteRhStrategie"), [
            { value:"interne", text:"Interne" },
            { value:"externe", text:"Externe" },
            { value:"mixte", text:"Mixte" }
        ]);

        _fillSelect(byId("posteRhCriticite"), [
            { value:"1", text:"1 - Faible" },
            { value:"2", text:"2 - Modérée" },
            { value:"3", text:"3 - Forte" }
        ]);

        byId("posteRhStatut")?.addEventListener("change", refreshPosteRhDateFinVisibility);
        byId("posteRhCriticite")?.addEventListener("change", refreshPosteRhCriticiteHelp);

        if (typeof bindStepButtons === "function"){
            bindStepButtons(byId("posteBlocRh"));
        }

        refreshPosteRhCriticiteHelp();
        refreshPosteRhDateFinVisibility();
    }

    function fillPosteRhTab(detail, isCreate){
        initPosteRhTab();

        _selectByValue("posteRhStatut", detail?.statut_poste || "actif");
        _selectByValue("posteRhStrategie", detail?.strategie_pourvoi || "mixte");
        _setValue("posteRhDateDebut", detail?.date_debut_validite || "");
        _setValue("posteRhDateFin", detail?.date_fin_validite || "");
        _setValue("posteRhNbTitulaires", detail?.nb_titulaires_cible ?? 1);
        _selectByValue("posteRhCriticite", detail?.criticite_poste ?? 2);
        _setChecked("posteRhVerrouille", detail?.param_rh_verrouille);
        _setValue("posteRhCommentaire", detail?.param_rh_commentaire || "");

        const src = detail?.param_rh_source || (isCreate ? "studio" : "");
        _setValue("posteRhSource", rhSourceLabel(src));

        const maj = detail?.param_rh_date_maj || "";
        _setValue("posteRhDateMaj", isCreate && !maj ? "Création à l’enregistrement" : formatRhDateMaj(maj));

        refreshPosteRhCriticiteHelp();
        refreshPosteRhDateFinVisibility();
    }

        // ------------------------------------------------------
    // Poste > Paramétrage RH > Cotation conventionnelle
    // ------------------------------------------------------
    function _posteCcnDefaultSummary(isCreate){
        return isCreate
            ? "Enregistre d’abord le poste pour lancer une cotation traçable."
            : "Aucune cotation conventionnelle enregistrée.";
    }

    function resetPosteCcnUi(isCreate){
        _posteCcnContext = null;
        _posteCcnAnalysis = null;

        _setValue("posteCcnConvention", isCreate ? "Disponible après enregistrement du poste" : "Chargement…");
        _setValue("posteCcnStatus", isCreate ? "Brouillon non enregistré" : "Chargement…");
        _setValue("posteCcnResult", "—");
        _setValue("posteCcnCategory", "—");
        _setValue("posteCcnSummary", _posteCcnDefaultSummary(!!isCreate));

        _setValue("posteCcnModalConvention", "—");
        _setValue("posteCcnModalVersion", "—");
        _setValue("posteCcnModalPoste", "—");
        _setValue("posteCcnModalService", "—");
        _setValue("posteCcnModalBase", "");

        _setValue("posteCcnPropCoeff", "—");
        _setValue("posteCcnPropPalier", "—");
        _setValue("posteCcnPropCategorie", "—");
        _setValue("posteCcnPropPoints", "—");
        _setValue("posteCcnPropResume", "");
        _setValue("posteCcnPropJustification", "");

        _setValue("posteCcnFinalCoefficient", "");
        _setValue("posteCcnFinalPalier", "");
        _setValue("posteCcnFinalCategorie", "");
        _setValue("posteCcnFinalJustification", "");

        const tbody = byId("posteCcnCriteriaTbody");
        if (tbody) tbody.innerHTML = "";
        const empty = byId("posteCcnCriteriaEmpty");
        if (empty) empty.style.display = "";

        const reuse = byId("btnPosteCcnReuse");
        if (reuse){
            reuse.disabled = true;
            reuse.style.opacity = ".6";
        }

        const sub = byId("posteCcnSub");
        if (sub){
            sub.textContent = isCreate
                ? "Enregistre le poste, puis lance l’assistant de cotation conventionnelle."
                : "Assistant dédié à la cotation de l’emploi selon la convention collective détectée.";
        }
    }

    function getPosteCcnReferential(){
        return _posteCcnContext?.referential || null;
    }

    function findPosteCcnPalierByCoefficient(coef){
        const ref = getPosteCcnReferential() || {};
        const n = parseInt(coef ?? 0, 10);
        if (!Number.isFinite(n) || n <= 0) return null;

        const paliers = Array.isArray(ref?.paliers) ? ref.paliers : [];
        if (paliers.length){
            for (const it of paliers){
                const min = parseInt(it?.coef_min ?? 0, 10) || 0;
                const max = (it?.coef_max === null || it?.coef_max === undefined) ? 999999 : (parseInt(it.coef_max, 10) || 999999);
                if (n >= min && n <= max){
                    return {
                        palier: parseInt(it?.palier ?? 0, 10) || 0,
                        groupe: "",
                        raw: it
                    };
                }
            }
            return null;
        }

        const cmap = Array.isArray(ref?.classification_map) ? ref.classification_map : [];
        for (const it of cmap){
            const min = parseInt(it?.points_min ?? 0, 10) || 0;
            const max = parseInt(it?.points_max ?? 0, 10) || 0;
            if (n >= min && n <= max){
                return {
                    palier: parseInt(it?.classe ?? 0, 10) || 0,
                    groupe: (it?.groupe || "").toString().trim().toUpperCase(),
                    raw: it
                };
            }
        }

        return null;
    }

    function countPosteCcnCadreConditions(criteria){
        const rows = Array.isArray(criteria) ? criteria : [];
        const marche = (code) => parseInt((rows.find(x => String(x?.code || "").trim() === code)?.marche) ?? 0, 10) || 0;
        let ok = 0;
        if (marche("management") >= 3) ok += 1;
        if (marche("ampleur_connaissances") >= 4) ok += 1;
        if (marche("autonomie") >= 6) ok += 1;
        return ok;
    }

    function computePosteCcnCategory(coef, criteria){
        const ref = getPosteCcnReferential() || {};
        const n = parseInt(coef ?? 0, 10);
        if (!Number.isFinite(n) || n <= 0) return "";

        const cmap = Array.isArray(ref?.classification_map) ? ref.classification_map : [];
        if (cmap.length){
            const band = findPosteCcnPalierByCoefficient(n);
            const grp = (band?.groupe || "").toString().trim().toUpperCase();
            if (!grp) return "";
            const cadreGroups = new Set((ref?.cadre_groups || ["F","G","H","I"]).map(x => String(x || "").trim().toUpperCase()));
            return `Groupe ${grp} · ${cadreGroups.has(grp) ? "Cadre" : "Non-cadre"}`;
        }

        if (n >= 350) return "Cadre";
        if (n >= 310 && n <= 349){
            const rows = Array.isArray(criteria) ? criteria : [];
            const marche = (code) => parseInt((rows.find(x => String(x?.code || "").trim() === code)?.marche) ?? 0, 10) || 0;
            let ok = 0;
            if (marche("management") >= 3) ok += 1;
            if (marche("ampleur_connaissances") >= 4) ok += 1;
            if (marche("autonomie") >= 6) ok += 1;
            return ok >= 2 ? "Cadre" : "Agent de maîtrise / technicien";
        }
        if (n >= 171) return "Agent de maîtrise / technicien";
        if (n >= 100) return "Employé";
        return "";
    }

    function formatPosteCcnResultText(data){
        const coef = parseInt(data?.coefficient ?? 0, 10) || 0;
        const palier = parseInt(data?.palier ?? 0, 10) || 0;
        return (!coef && !palier) ? "—" : `Coef. ${coef || "—"} · Palier ${palier || "—"}`;
    }

    function renderPosteCcnCriteriaRows(analysis){
        const tbody = byId("posteCcnCriteriaTbody");
        const empty = byId("posteCcnCriteriaEmpty");
        if (!tbody || !empty) return;

        tbody.innerHTML = "";
        const rows = [];

        (Array.isArray(analysis?.criteres) ? analysis.criteres : []).forEach(x => {
            rows.push({
                libelle: x?.libelle || x?.code || "Critère",
                niveau: `M${parseInt(x?.marche ?? 0, 10) || 0}`,
                points: parseInt(x?.points ?? 0, 10) || 0,
                justification: x?.justification || ""
            });
        });

        (Array.isArray(analysis?.bonifications) ? analysis.bonifications : []).forEach(x => {
            rows.push({
                libelle: x?.libelle || x?.code || "Bonification",
                niveau: x?.niveau_label || `M${parseInt(x?.marche ?? 0, 10) || 0}`,
                points: parseInt(x?.points ?? 0, 10) || 0,
                justification: x?.justification || ""
            });
        });

        if (!rows.length){
            empty.style.display = "";
            return;
        }

        empty.style.display = "none";

        rows.forEach(r => {
            const tr = document.createElement("tr");

            const tdLib = document.createElement("td");
            tdLib.textContent = r.libelle || "—";

            const tdNiv = document.createElement("td");
            tdNiv.style.textAlign = "center";
            const badge = document.createElement("span");
            badge.className = "sb-badge sb-badge--ccn-level";
            badge.textContent = r.niveau || "—";
            tdNiv.appendChild(badge);

            const tdPts = document.createElement("td");
            tdPts.style.textAlign = "center";
            tdPts.textContent = String(r.points ?? "—");

            const tdJust = document.createElement("td");
            tdJust.textContent = r.justification || "—";

            tr.appendChild(tdLib);
            tr.appendChild(tdNiv);
            tr.appendChild(tdPts);
            tr.appendChild(tdJust);
            tbody.appendChild(tr);
        });
    }

    function fillPosteCcnDecision(data){
        _setValue("posteCcnFinalCoefficient", data?.coefficient || "");
        _setValue("posteCcnFinalJustification", data?.justification || "");
        refreshPosteCcnDecisionDerived();
    }

    function fillPosteCcnProposal(analysis){
        _posteCcnAnalysis = analysis || null;
        const proposal = analysis?.proposal || {};

        _setValue("posteCcnPropCoeff", proposal?.coefficient ?? "—");
        _setValue("posteCcnPropPalier", proposal?.palier ?? "—");
        _setValue("posteCcnPropCategorie", proposal?.categorie_professionnelle || "—");
        _setValue("posteCcnPropPoints", analysis?.total_points ?? "—");
        _setValue("posteCcnPropResume", proposal?.resume_cotation || "");
        _setValue("posteCcnPropJustification", analysis?.justification_globale || "");

        renderPosteCcnCriteriaRows(analysis);

        const reuse = byId("btnPosteCcnReuse");
        if (reuse){
            reuse.disabled = !analysis?.proposal;
            reuse.style.opacity = reuse.disabled ? ".6" : "";
        }
    }

    function refreshPosteCcnDecisionDerived(){
        const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
        if (!Number.isFinite(coef) || coef <= 0){
            _setValue("posteCcnFinalPalier", "");
            _setValue("posteCcnFinalCategorie", "");
            return;
        }
        const criteria = _posteCcnAnalysis?.criteres || _posteCcnContext?.dossier?.proposition_json?.criteres || [];
        _setValue("posteCcnFinalPalier", findPosteCcnPalierByCoefficient(coef)?.palier ?? "");
        _setValue("posteCcnFinalCategorie", computePosteCcnCategory(coef, criteria));
    }

    function fillPosteCcnContext(ctx){
        _posteCcnContext = ctx || null;

        const conventionTxt = ctx?.convention_label
            ? `${ctx.convention_label}${ctx?.idcc ? ` (IDCC ${ctx.idcc})` : ""}`
            : (ctx?.idcc ? `IDCC ${ctx.idcc}` : "Convention non détectée");

        _setValue("posteCcnConvention", conventionTxt);
        _setValue("posteCcnModalConvention", conventionTxt);
        _setValue("posteCcnModalVersion", ctx?.version_label || "—");
        _setValue("posteCcnModalPoste", ctx?.poste?.intitule_poste || "—");
        _setValue("posteCcnModalService", ctx?.poste?.nom_service || "Non lié");

        const base = [];
        if (ctx?.poste?.mission_principale) base.push(`Mission : ${ctx.poste.mission_principale}`);
        if (ctx?.poste?.competences_count !== undefined) base.push(`Compétences requises : ${ctx.poste.competences_count}`);
        if (ctx?.poste?.certifications_count !== undefined) base.push(`Certifications : ${ctx.poste.certifications_count}`);
        _setValue("posteCcnModalBase", base.join("\n"));

        let status = "Non démarré";
        let result = "—";
        let category = "—";
        let summary = _posteCcnDefaultSummary(false);

        const dossier = ctx?.dossier || null;
        const proposal = dossier?.proposition_json || null;
        const validation = dossier?.validation_json || null;

        if (!ctx?.supported){
            status = "Convention non supportée";
            summary = ctx?.support_message || "L’assistant n’est pas disponible pour cette convention.";
        } else if (validation && Object.keys(validation).length){
            status = "Validée";
            result = formatPosteCcnResultText(validation);
            summary = validation?.justification || proposal?.proposal?.resume_cotation || _posteCcnDefaultSummary(false);
            category = validation?.categorie_professionnelle || proposal?.proposal?.categorie_professionnelle || "—";
        } else if (proposal && Object.keys(proposal).length){
            status = "Brouillon";
            result = formatPosteCcnResultText(proposal?.proposal || proposal);
            summary = proposal?.justification_globale || proposal?.proposal?.resume_cotation || _posteCcnDefaultSummary(false);
            category = proposal?.proposal?.categorie_professionnelle || "—";
        }

        _setValue("posteCcnStatus", status);
        _setValue("posteCcnResult", result);
        _setValue("posteCcnCategory", category);
        _setValue("posteCcnSummary", summary);

        fillPosteCcnProposal(proposal && Object.keys(proposal).length ? proposal : null);

        if (validation && Object.keys(validation).length){
            fillPosteCcnDecision({
                coefficient: validation.coefficient,
                justification: validation.justification || ""
            });
        } else if (proposal?.proposal){
            fillPosteCcnDecision({
                coefficient: proposal.proposal.coefficient,
                justification: proposal.justification_globale || proposal.proposal.resume_cotation || ""
            });
        } else {
            fillPosteCcnDecision({ coefficient: "", justification: "" });
        }

        const sub = byId("posteCcnSub");
        if (sub){
            sub.textContent = ctx?.supported
                ? "Assistant dédié à la cotation de l’emploi selon la convention collective détectée."
                : (ctx?.support_message || "Convention non encore supportée.");
        }
    }

    async function loadPosteCcnContext(portal){
        if (!_editingPosteId) return null;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/ccn_context`;
        const ctx = await portal.apiJson(url);
        fillPosteCcnContext(ctx);
        return ctx;
    }

    async function openPosteCcnModal(portal){
        await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== _editingPosteId){
            await loadPosteCcnContext(portal);
        }
        openModal("modalPosteCcn");
    }

    function closePosteCcnModal(){
        closeModal("modalPosteCcn");
    }

    function reusePosteCcnProposal(){
        const proposal = _posteCcnAnalysis?.proposal || _posteCcnContext?.dossier?.proposition_json?.proposal || null;
        const justification = _posteCcnAnalysis?.justification_globale || _posteCcnContext?.dossier?.proposition_json?.justification_globale || "";
        if (!proposal) return;
        fillPosteCcnDecision({
            coefficient: proposal.coefficient,
            justification: justification || proposal.resume_cotation || ""
        });
    }

    async function runPosteCcnAnalysis(portal){
        const pid = await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== pid){
            await loadPosteCcnContext(portal);
        }
        if (!_posteCcnContext?.supported){
            portal.showAlert("error", _posteCcnContext?.support_message || "Convention non supportée.");
            return;
        }

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/propose`;

        const btn = byId("btnPosteCcnAnalyze");
        if (btn){
            btn.disabled = true;
            btn.style.opacity = ".6";
            btn.textContent = "Analyse…";
        }

        openIaBusyOverlay(
            "Cotation conventionnelle en cours",
            "Lecture du poste, application du référentiel conventionnel et génération de la justification..."
        );

        try{
            const res = await portal.apiJson(url, { method: "POST" });
            const analysis = res?.proposition || null;

            fillPosteCcnProposal(analysis);
            reusePosteCcnProposal();

            if (_posteCcnContext){
                if (!_posteCcnContext.dossier) _posteCcnContext.dossier = {};
                _posteCcnContext.dossier.proposition_json = analysis || {};
            }

            _setValue("posteCcnStatus", "Proposition non enregistrée");
            _setValue("posteCcnResult", formatPosteCcnResultText(analysis?.proposal || {}));
            _setValue("posteCcnCategory", analysis?.proposal?.categorie_professionnelle || "—");
            _setValue(
                "posteCcnSummary",
                analysis?.justification_globale || analysis?.proposal?.resume_cotation || "Proposition IA prête à être revue."
            );

            portal.showAlert("", "");
        } finally {
            closeIaBusyOverlay();
            if (btn){
                btn.disabled = false;
                btn.style.opacity = "";
                btn.textContent = "Lancer l’analyse";
            }
        }
    }

    async function savePosteCcnDecision(portal){
        const pid = await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== pid){
            await loadPosteCcnContext(portal);
        }
        if (!_posteCcnContext?.supported){
            portal.showAlert("error", _posteCcnContext?.support_message || "Convention non supportée.");
            return;
        }

        const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
        const ref = getPosteCcnReferential() || {};
        const is3248 = Array.isArray(ref?.classification_map) && ref.classification_map.length > 0;
        const minCoef = is3248 ? 6 : 100;

        if (!Number.isFinite(coef) || coef < minCoef){
            portal.showAlert("error", is3248
                ? "La cotation retenue doit être supérieure ou égale à 6."
                : "Le coefficient retenu doit être supérieur ou égal à 100."
            );
            return;
        }

        const justification = (byId("posteCcnFinalJustification")?.value || "").trim();
        if (!justification){
            portal.showAlert("error", "La justification retenue est obligatoire.");
            return;
        }

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/save`;

        const btn = byId("btnPosteCcnSave");
        if (btn){
            btn.disabled = true;
            btn.style.opacity = ".6";
        }

        try{
            await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    coefficient_retenu: coef,
                    justification_retenue: justification,
                    proposition_json: _posteCcnAnalysis || _posteCcnContext?.dossier?.proposition_json || {}
                }),
            });
            await loadPosteCcnContext(portal);
            portal.showAlert("", "");
        } finally {
            if (btn){
                btn.disabled = false;
                btn.style.opacity = "";
            }
        }
    }

    function resetPosteAiModalFields(){
        byId("posteAiIntitule") && (byId("posteAiIntitule").value = "");
        byId("posteAiContexte") && (byId("posteAiContexte").value = "");
        byId("posteAiTaches") && (byId("posteAiTaches").value = "");
        byId("posteAiOutils") && (byId("posteAiOutils").value = "");
        byId("posteAiEnvironnement") && (byId("posteAiEnvironnement").value = "");
        byId("posteAiInteractions") && (byId("posteAiInteractions").value = "");
        byId("posteAiContraintes") && (byId("posteAiContraintes").value = "");
    }

    function seedPosteAiModalFromCurrent(){
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const respHtml = rtGetHtml("posteResp");
        const respTxt = htmlToPlainText(respHtml);
        const ctr = (byId("posteCtrDetailContrainte")?.value || "").trim();
        const pieces = [];
        if ((byId("posteCtrMobilite")?.value || "").trim()) pieces.push(`Mobilité: ${(byId("posteCtrMobilite").value || "").trim()}`);
        if ((byId("posteCtrRisquePhys")?.value || "").trim()) pieces.push(`Risques physiques: ${(byId("posteCtrRisquePhys").value || "").trim()}`);
        if ((byId("posteCtrNivContrainte")?.value || "").trim()) pieces.push(`Niveau de contraintes: ${(byId("posteCtrNivContrainte").value || "").trim()}`);
        if ((byId("posteCtrPerspEvol")?.value || "").trim()) pieces.push(`Perspectives: ${(byId("posteCtrPerspEvol").value || "").trim()}`);
        if ((byId("posteCtrEduMin")?.value || "").trim()) pieces.push(`Niveau d'étude minimum: ${(byId("posteCtrEduMin").value || "").trim()}`);
        const mergedCtr = [ctr, pieces.join(" | ")].filter(Boolean).join("\n");

        if (byId("posteAiIntitule") && !byId("posteAiIntitule").value.trim()) byId("posteAiIntitule").value = title;
        if (byId("posteAiContexte") && !byId("posteAiContexte").value.trim()) byId("posteAiContexte").value = mission;
        if (byId("posteAiTaches") && !byId("posteAiTaches").value.trim()) byId("posteAiTaches").value = respTxt;
        if (byId("posteAiContraintes") && !byId("posteAiContraintes").value.trim()) byId("posteAiContraintes").value = mergedCtr;
    }

    function openPosteAiModal(){
        const ttl = byId("posteAiTitle");
        const sub = byId("posteAiSub");
        if (ttl) ttl.textContent = (_posteModalMode === "edit") ? "Proposer des textes de remplacement avec l’IA" : "Générer une fiche de poste avec l’IA";
        if (sub) sub.textContent = (_posteModalMode === "edit")
            ? "L’IA reformule et enrichit la fiche actuelle sans changer le métier visé."
            : "L’IA propose un brouillon exploitable à partir de tes éléments et d’une recherche web.";
        seedPosteAiModalFromCurrent();
        openModal("modalPosteAi");
    }

    function closePosteAiModal(){
        closeModal("modalPosteAi");
    }

    async function generatePosteAiDraft(portal){
        const ownerId = getOwnerId();
        const payload = {
            mode: _posteModalMode || "create",
            id_poste: _editingPosteId || null,
            current_intitule_poste: (byId("posteIntitule")?.value || "").trim() || null,
            current_mission_principale: (byId("posteMission")?.value || "").trim() || null,
            current_responsabilites_html: rtGetHtml("posteResp").trim() || null,
            intitule: (byId("posteAiIntitule")?.value || "").trim(),
            contexte: (byId("posteAiContexte")?.value || "").trim() || null,
            taches: (byId("posteAiTaches")?.value || "").trim() || null,
            outils: (byId("posteAiOutils")?.value || "").trim() || null,
            environnement: (byId("posteAiEnvironnement")?.value || "").trim() || null,
            interactions: (byId("posteAiInteractions")?.value || "").trim() || null,
            contraintes: (byId("posteAiContraintes")?.value || "").trim() || null,
        };

        if (!payload.intitule){
            portal.showAlert("error", "Intitulé du poste obligatoire pour lancer la génération IA.");
            return;
        }

            const btn = byId("btnPosteAiGenerate");
            if (btn){ btn.disabled = true; btn.style.opacity = ".6"; btn.textContent = "Génération…"; }

            openIaBusyOverlay(
                "Génération IA de la fiche de poste",
                "Recherche web, analyse du contexte métier et rédaction du brouillon..."
            );

            try{
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_draft`;
            const draft = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            _posteAiDraftMeta = draft || null;
            if (draft?.intitule_poste !== undefined) byId("posteIntitule").value = String(draft.intitule_poste || "");
            if (draft?.mission_principale !== undefined) byId("posteMission").value = String(draft.mission_principale || "");
            if (draft?.responsabilites_html !== undefined) rtSetHtml("posteResp", String(draft.responsabilites_html || ""));

            await ensureNsfGroupes(portal);
            fillNsfSelect(draft?.nsf_groupe_code || "");
            fillPosteContraintesTab({
                niveau_education_minimum: draft?.niveau_education_minimum || "",
                nsf_groupe_code: draft?.nsf_groupe_code || "",
                nsf_groupe_obligatoire: !!draft?.nsf_groupe_obligatoire,
                mobilite: draft?.mobilite || "",
                risque_physique: draft?.risque_physique || "",
                perspectives_evolution: draft?.perspectives_evolution || "",
                niveau_contrainte: draft?.niveau_contrainte || "",
                detail_contrainte: draft?.detail_contrainte || "",
            });

            closePosteAiModal();
            portal.showAlert("", "");
        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        } finally {
            closeIaBusyOverlay();
            if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.textContent = "Générer"; }
        }
    }

    function resetPosteCompAiUi(){
        _posteCompAiResults = { existing: [], missing: [] };
        const loading = byId("posteCompAiLoading");
        const summary = byId("posteCompAiSummary");
        const exWrap = byId("posteCompAiExistingWrap");
        const miWrap = byId("posteCompAiMissingWrap");
        const exList = byId("posteCompAiExistingList");
        const miList = byId("posteCompAiMissingList");
        if (loading){ loading.style.display = "none"; loading.textContent = "Analyse en cours…"; }
        if (summary){ summary.style.display = "none"; summary.textContent = ""; }
        if (exWrap) exWrap.style.display = "none";
        if (miWrap) miWrap.style.display = "none";
        if (exList) exList.innerHTML = "";
        if (miList) miList.innerHTML = "";
    }

    function buildPosteCompAiPayload(){
        return {
            id_poste: _editingPosteId || null,
            intitule_poste: (byId("posteIntitule")?.value || "").trim() || null,
            mission_principale: (byId("posteMission")?.value || "").trim() || null,
            responsabilites_html: rtGetHtml("posteResp").trim() || null,
            ai_contexte: (byId("posteAiContexte")?.value || "").trim() || null,
            ai_taches: (byId("posteAiTaches")?.value || "").trim() || null,
            ai_outils: (byId("posteAiOutils")?.value || "").trim() || null,
            ai_environnement: (byId("posteAiEnvironnement")?.value || "").trim() || null,
            ai_interactions: (byId("posteAiInteractions")?.value || "").trim() || null,
            ai_contraintes: (byId("posteAiContraintes")?.value || "").trim() || null,
            niveau_education_minimum: (byId("posteCtrEduMin")?.value || "").trim() || null,
            nsf_groupe_code: (byId("posteCtrNsfGroupe")?.value || "").trim() || null,
            nsf_groupe_obligatoire: !!byId("posteCtrNsfOblig")?.checked,
            mobilite: (byId("posteCtrMobilite")?.value || "").trim() || null,
            risque_physique: (byId("posteCtrRisquePhys")?.value || "").trim() || null,
            perspectives_evolution: (byId("posteCtrPerspEvol")?.value || "").trim() || null,
            niveau_contrainte: (byId("posteCtrNivContrainte")?.value || "").trim() || null,
            detail_contrainte: (byId("posteCtrDetailContrainte")?.value || "").trim() || null,
            existing_competence_ids: (_posteCompItems || []).map(x => x.id_competence).filter(Boolean),
        };
    }

    async function ensurePosteCompCreateDomains(portal){
        if (_posteCompCreateDomainsLoaded) return;
        _posteCompCreateDomainsLoaded = true;

        try{
            const ownerId = getOwnerId();
            const url = `${portal.apiBase}/studio/catalog/domaines/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url);
            _posteCompCreateDomainItems = Array.isArray(r?.items) ? r.items : [];
        } catch(_){
            _posteCompCreateDomainItems = [];
        }
    }

    function fillPosteCompCreateDomainSelect(selectedId){
        const sel = byId("posteCompCreateDomaine");
        if (!sel) return;

        const keep = (selectedId ?? sel.value ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_posteCompCreateDomainItems || []).forEach(d => {
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

    function posteCompCreateEmptyCrit(){
        return { Nom:"", Eval:["","","",""] };
    }

    function parsePosteCompCreateGrille(v){
        if (!v) return null;
        if (typeof v === "object") return v;
        if (typeof v === "string"){
            try { return JSON.parse(v); } catch(_) { return null; }
        }
        return null;
    }

    function resetPosteCompCreateCrit(){
        _posteCompCreateCrit = [
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit()
        ];
        _posteCompCreateCritEditIdx = null;
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function loadPosteCompCreateCritFromJson(grille){
        const g = parsePosteCompCreateGrille(grille) || {};
        _posteCompCreateCrit = [
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit()
        ];

        for (let i=1;i<=4;i++){
            const k = "Critere" + i;
            const node = g[k] || {};
            const nom = (node.Nom || "").toString();
            const ev = Array.isArray(node.Eval) ? node.Eval : [];
            _posteCompCreateCrit[i-1] = {
                Nom: nom,
                Eval: [
                    (ev[0] || "").toString(),
                    (ev[1] || "").toString(),
                    (ev[2] || "").toString(),
                    (ev[3] || "").toString()
                ]
            };
        }

        _posteCompCreateCritEditIdx = null;
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function buildPosteCompCreateGrilleJson(){
        const out = {};
        for (let i=1;i<=4;i++){
            const c = (_posteCompCreateCrit && _posteCompCreateCrit[i-1]) ? _posteCompCreateCrit[i-1] : posteCompCreateEmptyCrit();
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

    function usedPosteCompCreateCritCount(){
        if (!_posteCompCreateCrit) return 0;
        let n = 0;
        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            if (!c) continue;
            if ((c.Nom || "").trim()) n++;
        }
        return n;
    }

    function nextEmptyPosteCompCreateCritIndex(){
        if (!_posteCompCreateCrit) return 0;
        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const hasNom = (c?.Nom || "").trim().length > 0;
            const hasEval = (c?.Eval || []).some(x => (x || "").trim().length > 0);
            if (!hasNom && !hasEval) return i;
        }
        return -1;
    }

    function showPosteCompCreateCritEditor(idx){
        _posteCompCreateCritEditIdx = idx;

        const ed = byId("posteCompCreateCritEditor");
        if (!ed) return;

        const title = byId("posteCompCreateCritEditorTitle");
        if (title) title.textContent = `Critère ${idx+1}`;

        const c = _posteCompCreateCrit[idx] || posteCompCreateEmptyCrit();

        byId("posteCompCreateCritNom").value = c.Nom || "";
        byId("posteCompCreateCritEval1").value = c.Eval?.[0] || "";
        byId("posteCompCreateCritEval2").value = c.Eval?.[1] || "";
        byId("posteCompCreateCritEval3").value = c.Eval?.[2] || "";
        byId("posteCompCreateCritEval4").value = c.Eval?.[3] || "";

        ed.style.display = "";
    }

    function hidePosteCompCreateCritEditor(){
        const ed = byId("posteCompCreateCritEditor");
        if (ed) ed.style.display = "none";
        _posteCompCreateCritEditIdx = null;
    }

    function renderPosteCompCreateCritList(){
        const host = byId("posteCompCreateCritList");
        const btnAdd = byId("btnPosteCompCreateAddCrit");
        if (!host) return;

        if (!_posteCompCreateCrit){
            _posteCompCreateCrit = [
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit()
            ];
        }

        host.innerHTML = "";

        const used = usedPosteCompCreateCritCount();
        if (btnAdd){
            btnAdd.disabled = used >= 4;
            btnAdd.style.opacity = btnAdd.disabled ? ".6" : "";
            btnAdd.title = btnAdd.disabled ? "Maximum 4 critères." : "";
        }

        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
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
                showPosteCompCreateCritEditor(i);
                acc.classList.add("is-open");
            });

            actions.appendChild(btnEdit);
            body.appendChild(ul);
            body.appendChild(actions);
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

    function savePosteCompCreateCritFromEditor(portal){
        if (_posteCompCreateCritEditIdx === null || _posteCompCreateCritEditIdx === undefined) return;

        const nom = (byId("posteCompCreateCritNom").value || "").trim();
        const e1 = (byId("posteCompCreateCritEval1").value || "").trim();
        const e2 = (byId("posteCompCreateCritEval2").value || "").trim();
        const e3 = (byId("posteCompCreateCritEval3").value || "").trim();
        const e4 = (byId("posteCompCreateCritEval4").value || "").trim();

        if (!nom){
            portal.showAlert("error", "Nom du critère obligatoire.");
            return;
        }
        if (!e1 || !e2 || !e3 || !e4){
            portal.showAlert("error", "Les 4 niveaux d’évaluation sont obligatoires.");
            return;
        }

        _posteCompCreateCrit[_posteCompCreateCritEditIdx] = { Nom: nom, Eval:[e1,e2,e3,e4] };
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function validatePosteCompCreateCritBeforeSave(portal){
        if (!_posteCompCreateCrit){
            _posteCompCreateCrit = [
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit()
            ];
        }

        if (usedPosteCompCreateCritCount() < 1){
            portal.showAlert("error", "Ajoute au moins 1 critère d’évaluation.");
            return false;
        }

        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const nom = (c?.Nom || "").trim();
            const ev = c?.Eval || ["","","",""];
            const anyEval = ev.some(x => (x || "").trim().length > 0);

            if (!nom && !anyEval) continue;

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

    function bindPosteCompCreateMaxLen(id, max){
        const el = byId(id);
        if (!el || el._sbMaxBound) return;
        el._sbMaxBound = true;

        el.setAttribute("maxlength", String(max));

        el.addEventListener("input", () => {
            const v = (el.value || "");
            if (v.length > max) el.value = v.slice(0, max);
        });
    }

    function closePosteCompCreateModal(){
        closeModal("modalPosteCompCreate");
        _posteCompCreateCtx = null;
        hidePosteCompCreateCritEditor();
    }

    async function openPosteCompCreateModalFromAi(portal, idx, addAfter){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;

        _posteCompCreateCtx = {
            idx: idx,
            addAfter: !!addAfter,
            draft: JSON.parse(JSON.stringify(it || {}))
        };

        await ensurePosteCompCreateDomains(portal);

        const badge = byId("posteCompCreateBadge");
        if (badge){
            badge.style.display = "none";
            badge.textContent = "";
        }

        byId("posteCompCreateTitle").textContent = "Créer une compétence";
        byId("posteCompCreateSub").textContent = "Brouillon proposé par l’IA. Tu valides / ajustes avant création.";

        byId("posteCompCreateIntitule").value = (it.intitule || "");
        byId("posteCompCreateDesc").value = (it.description || "");
        byId("posteCompCreateEtat").value = "à valider";
        byId("posteCompCreateNivA").value = (it.niveaua || "");
        byId("posteCompCreateNivB").value = (it.niveaub || "");
        byId("posteCompCreateNivC").value = (it.niveauc || "");

        fillPosteCompCreateDomainSelect(it.domaine_id || "");
        loadPosteCompCreateCritFromJson(it.grille_evaluation || null);

        openModal("modalPosteCompCreate");
    }

    function promoteMissingAiCompetenceToExisting(meta){
        if (!_posteCompCreateCtx) return;

        const idx = _posteCompCreateCtx.idx;
        const added = !!meta?.added;
        const etat = (meta?.etat || "à valider").toString();
        const title = (byId("posteCompCreateIntitule")?.value || "").trim();
        const domainId = (byId("posteCompCreateDomaine")?.value || "").trim();
        const domainMeta = getPosteCompCreateDomainMetaById(domainId);
        const domainLabel = (domainMeta?.titre_court || domainMeta?.titre || "").toString().trim();

        const missing = Array.isArray(_posteCompAiResults?.missing) ? _posteCompAiResults.missing : [];
        const src = (missing[idx] || _posteCompCreateCtx.draft || {});

        if (idx >= 0 && idx < missing.length){
            missing.splice(idx, 1);
        }

        const existing = Array.isArray(_posteCompAiResults?.existing) ? _posteCompAiResults.existing : [];
        existing.unshift({
            id_comp: meta?.id_comp || "",
            code: meta?.code || "",
            intitule: title || (src.intitule || ""),
            domaine: domainId || (src.domaine_id || ""),
            domaine_titre_court: domainLabel || (src.domaine_label || ""),
            domaine_couleur: domainMeta?.couleur || src.domaine_couleur || null,
            etat: etat,
            recommended_level: (src.recommended_level || "B"),
            recommended_level_label: (src.recommended_level_label || "Avancé"),
            freq_usage: parseInt(src.freq_usage ?? 0, 10) || 0,
            impact_resultat: parseInt(src.impact_resultat ?? 0, 10) || 0,
            dependance: parseInt(src.dependance ?? 0, 10) || 0,
            _already_added: added
        });

        _posteCompAiResults.existing = existing;
        _posteCompAiResults.missing = missing;
    }

    async function savePosteCompCreateModal(portal, addAfter){
        if (!_posteCompCreateCtx) return;

        const ownerId = getOwnerId();
        const title = (byId("posteCompCreateIntitule").value || "").trim();
        const dom = (byId("posteCompCreateDomaine").value || "").trim();
        const etat = (byId("posteCompCreateEtat").value || "à valider").trim();
        const desc = (byId("posteCompCreateDesc").value || "").trim();
        const a = (byId("posteCompCreateNivA").value || "").trim();
        const b = (byId("posteCompCreateNivB").value || "").trim();
        const c = (byId("posteCompCreateNivC").value || "").trim();

        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return;
        }

        if (!validatePosteCompCreateCritBeforeSave(portal)) return;

        const btnMain = addAfter ? byId("btnPosteCompCreateAdd") : byId("btnPosteCompCreateOnly");
        if (btnMain){
            btnMain.disabled = true;
            btnMain.style.opacity = ".6";
        }

        try{
            const grille = buildPosteCompCreateGrilleJson();

            const created = await portal.apiJson(
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

            if (addAfter){
                const pid = await ensureEditingPoste(portal);
                const draft = _posteCompCreateCtx?.draft || {};
                await portal.apiJson(
                    `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`,
                    {
                        method: "POST",
                        headers: { "Content-Type":"application/json" },
                        body: JSON.stringify({
                            id_competence: created.id_comp,
                            niveau_requis: (draft.recommended_level || "B"),
                            freq_usage: parseInt(draft.freq_usage ?? 0, 10) || 0,
                            impact_resultat: parseInt(draft.impact_resultat ?? 0, 10) || 0,
                            dependance: parseInt(draft.dependance ?? 0, 10) || 0
                        })
                    }
                );
                await loadPosteCompetences(portal);
            }

            promoteMissingAiCompetenceToExisting({
                id_comp: created.id_comp,
                code: created.code,
                etat: etat,
                added: !!addAfter
            });
            renderPosteCompAiResults();

            closePosteCompCreateModal();
            portal.showAlert("", "");
        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        } finally {
            if (btnMain){
                btnMain.disabled = false;
                btnMain.style.opacity = "";
            }
        }
    }

    function getPosteCompCreateDomainMetaById(id){
        const did = String(id || "").trim();
        if (!did) return null;
        return (_posteCompCreateDomainItems || []).find(x => String(x?.id_domaine_competence || "").trim() === did) || null;
    }

    function buildAiCompDomainBadge(label, couleur){
        const txt = String(label || "").trim();
        if (!txt) return null;

        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--comp-domain";

        const dot = document.createElement("span");
        dot.className = "sb-dot";

        const rgb = argbIntToRgbTuple(couleur);
        if (rgb){
            dom.style.setProperty("--sb-domain-rgb", rgb.css);
        }

        dom.appendChild(dot);
        dom.appendChild(document.createTextNode(txt));
        return dom;
    }

    function renderPosteCompAiResults(){
        const summary = byId("posteCompAiSummary");
        const exWrap = byId("posteCompAiExistingWrap");
        const miWrap = byId("posteCompAiMissingWrap");
        const exList = byId("posteCompAiExistingList");
        const miList = byId("posteCompAiMissingList");
        if (!summary || !exWrap || !miWrap || !exList || !miList) return;

        const existing = Array.isArray(_posteCompAiResults?.existing) ? _posteCompAiResults.existing : [];
        const missing = Array.isArray(_posteCompAiResults?.missing) ? _posteCompAiResults.missing : [];

        summary.textContent = `${existing.length} compétence(s) trouvée(s) dans le référentiel, ${missing.length} à créer.`;
        summary.style.display = "";

        exList.innerHTML = "";
        miList.innerHTML = "";
        exWrap.style.display = existing.length ? "" : "none";
        miWrap.style.display = missing.length ? "" : "none";

        existing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = (it.code || "—");

            const wrap = document.createElement("div");

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = (it.intitule || "");

            const meta = document.createElement("div");
            meta.style.display = "flex";
            meta.style.gap = "8px";
            meta.style.flexWrap = "wrap";
            meta.style.margin = "6px 0 0 0";

            const dom = buildAiCompDomainBadge(it.domaine_titre_court || "", it.domaine_couleur);
            if (dom) meta.appendChild(dom);

            if (((it.etat || "").toLowerCase()) === "à valider"){
                const et = document.createElement("span");
                et.className = "sb-badge sb-badge--accent-soft";
                et.textContent = "À valider";
                meta.appendChild(et);
            }

            wrap.appendChild(title);
            wrap.appendChild(meta);

            left.appendChild(code);
            left.appendChild(wrap);

            const right = document.createElement("div");
            right.className = "sb-row-right";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-btn sb-btn--accent sb-btn--xs";
            btn.textContent = it._already_added ? "Ajoutée" : "Ajouter";
            btn.disabled = !!it._already_added;
            btn.style.opacity = it._already_added ? ".6" : "";
            btn.addEventListener("click", async () => {
                if (it._already_added) return;
                try { await addExistingCompetenceFromAi(window.portal, idx); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btn);
            row.appendChild(left);
            row.appendChild(right);
            exList.appendChild(row);
        });

        missing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card";
            row.style.alignItems = "flex-start";

            const left = document.createElement("div");
            left.className = "sb-row-left";
            left.style.alignItems = "flex-start";

            const wrap = document.createElement("div");
            wrap.style.minWidth = "0";

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = (it.intitule || "");

            const meta = document.createElement("div");
            meta.style.display = "flex";
            meta.style.gap = "8px";
            meta.style.flexWrap = "wrap";
            meta.style.margin = "6px 0 0 0";

            const dom = buildAiCompDomainBadge(it.domaine_label || "", it.domaine_couleur);
            if (dom) meta.appendChild(dom);

            const desc = document.createElement("div");
            desc.className = "card-sub";
            desc.style.margin = "8px 0 0 0";
            desc.textContent = (it.description || "");

            wrap.appendChild(title);
            if (meta.childNodes.length) wrap.appendChild(meta);
            if ((it.description || "").trim()) wrap.appendChild(desc);

            left.appendChild(wrap);

            const right = document.createElement("div");
            right.className = "sb-actions";
            right.style.display = "flex";
            right.style.flexDirection = "column";
            right.style.gap = "8px";
            right.style.flexShrink = "0";

            const btnAdd = document.createElement("button");
            btnAdd.type = "button";
            btnAdd.className = "sb-btn sb-btn--accent sb-btn--xs";
            btnAdd.textContent = "Créer et ajouter";
            btnAdd.addEventListener("click", async () => {
                try { await openPosteCompCreateModalFromAi(window.portal, idx, true); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            const btnOnly = document.createElement("button");
            btnOnly.type = "button";
            btnOnly.className = "sb-btn sb-btn--soft sb-btn--xs";
            btnOnly.textContent = "Créer seulement";
            btnOnly.addEventListener("click", async () => {
                try { await openPosteCompCreateModalFromAi(window.portal, idx, false); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btnAdd);
            right.appendChild(btnOnly);

            row.appendChild(left);
            row.appendChild(right);
            miList.appendChild(row);
        });
    }

    async function openPosteCompAiModal(portal){
        const title = (byId("posteIntitule")?.value || "").trim();
        if (!title){
            portal.showAlert("error", "Renseigne au moins l’intitulé du poste avant la recherche IA.");
            return;
        }

        resetPosteCompAiUi();

        const loading = byId("posteCompAiLoading");
        if (loading) loading.style.display = "";

        openIaBusyOverlay(
            "Recherche IA des compétences",
            "Analyse du poste, recherche web et rapprochement avec le catalogue de compétences..."
        );

        try{
            const ownerId = getOwnerId();
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_search`;
            const res = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(buildPosteCompAiPayload()),
            });
            _posteCompAiResults = {
                existing: Array.isArray(res?.existing) ? res.existing : [],
                missing: Array.isArray(res?.missing) ? res.missing : [],
            };
            renderPosteCompAiResults();
            openModal("modalPosteCompAi");
        } finally {
            closeIaBusyOverlay();
            if (loading) loading.style.display = "none";
        }
    }

    async function ensureEditingPoste(portal){
        if (_posteModalMode === "edit" && _editingPosteId) return _editingPosteId;
        await savePosteFromModal(portal, { keepOpen: true, silent: true, statusMessage: "Poste créé." });
        if (!_editingPosteId) throw new Error("Le poste n’a pas pu être créé avant l’ajout des compétences.");
        return _editingPosteId;
    }

    async function addExistingCompetenceFromAi(portal, idx){
        const it = (_posteCompAiResults?.existing || [])[idx];
        if (!it || !it.id_comp) return;

        const pid = await ensureEditingPoste(portal);
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;

        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id_competence: it.id_comp,
                niveau_requis: it.recommended_level || "B",
                freq_usage: parseInt(it.freq_usage ?? 0, 10) || 0,
                impact_resultat: parseInt(it.impact_resultat ?? 0, 10) || 0,
                dependance: parseInt(it.dependance ?? 0, 10) || 0,
            }),
        });

        it._already_added = true;
        renderPosteCompAiResults();
        await loadPosteCompetences(portal);
    }

    async function createMissingCompetenceFromAi(portal, idx){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;
        const pid = await ensureEditingPoste(portal);
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_create`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id_poste: pid, draft: it }),
        });
        await loadPosteCompetences(portal);
        const btn = document.querySelector(`[data-ai-missing-create="${idx}"]`);
        if (btn){ btn.disabled = true; btn.textContent = `Créée (${r?.code || "OK"})`; }
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

        const levelMeta = (niv) => {
            const v = String(niv || "").trim().toUpperCase();
            if (v === "A") return { text: "A - Initial", cls: "sb-badge--niv-a" };
            if (v === "B") return { text: "B - Avancé", cls: "sb-badge--niv-b" };
            if (v === "C") return { text: "C - Expert", cls: "sb-badge--niv-c" };
            return { text: "—", cls: "" };
        };

        const critMeta = (score) => {
            const n = parseInt(score ?? 0, 10);
            if (Number.isNaN(n)) return { text: "—", cls: "sb-crit-badge--low" };
            if (n >= 70) return { text: String(n), cls: "sb-crit-badge--high" };
            if (n >= 35) return { text: String(n), cls: "sb-crit-badge--mid" };
            return { text: String(n), cls: "sb-crit-badge--low" };
        };

        const iconEdit = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
        `;

        const iconTrash = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/>
                <path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
            </svg>
        `;

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

            const tdComp = document.createElement("td");
            const compWrap = document.createElement("div");
            compWrap.className = "sb-comp-cell";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = it.code || "—";

            const title = document.createElement("div");
            title.className = "sb-comp-cell__title";
            title.textContent = it.intitule || "";

            compWrap.appendChild(code);
            compWrap.appendChild(title);
            tdComp.appendChild(compWrap);

            const tdNiv = document.createElement("td");
            tdNiv.style.textAlign = "center";
            const lvl = levelMeta(it.niveau_requis);
            const bn = document.createElement("span");
            bn.className = `sb-badge sb-badge--niv ${lvl.cls}`.trim();
            bn.textContent = lvl.text;
            tdNiv.appendChild(bn);

            const tdCrit = document.createElement("td");
            tdCrit.style.textAlign = "center";
            const crit = critMeta(it.poids_criticite);
            const bc = document.createElement("span");
            bc.className = `sb-badge sb-crit-badge ${crit.cls}`.trim();
            bc.textContent = crit.text;
            tdCrit.appendChild(bc);

            const tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";

            if (isAdmin()){
                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const btnEdit = document.createElement("button");
                btnEdit.type = "button";
                btnEdit.className = "sb-icon-btn";
                btnEdit.title = "Modifier";
                btnEdit.setAttribute("aria-label", "Modifier");
                btnEdit.innerHTML = iconEdit;
                btnEdit.addEventListener("click", () => openPosteCompEditModal(it));

                const btnRem = document.createElement("button");
                btnRem.type = "button";
                btnRem.className = "sb-icon-btn sb-icon-btn--danger";
                btnRem.title = "Retirer";
                btnRem.setAttribute("aria-label", "Retirer");
                btnRem.innerHTML = iconTrash;
                btnRem.addEventListener("click", async () => {
                    if (!confirm(`Retirer la compétence "${it.code || ""} – ${it.intitule || ""}" du poste ?`)) return;
                    try { await removePosteCompetence(window.portal, it.id_competence); }
                    catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnRem);
                tdAct.appendChild(actions);
            } else {
                tdAct.textContent = "—";
            }

            tr.appendChild(tdComp);
            tr.appendChild(tdNiv);
            tr.appendChild(tdCrit);
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
        setPosteCompEditNiv(_posteCompEdit.niveau_requis || "B");

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
        const fu = parseInt(byId("posteCompEditFreq")?.value || "0", 10) || 0;
        const im = parseInt(byId("posteCompEditImpact")?.value || "0", 10) || 0;
        const de = parseInt(byId("posteCompEditDep")?.value || "0", 10) || 0;

        const f = Math.max(0, Math.min(10, fu));
        const i = Math.max(0, Math.min(10, im));
        const d = Math.max(0, Math.min(10, de));

        const elF = byId("posteCompEditFreqTxt");
        const elI = byId("posteCompEditImpactTxt");
        const elD = byId("posteCompEditDepTxt");

        if (elF) elF.textContent = `${f}/10`;
        if (elI) elI.textContent = `${i}/10`;
        if (elD) elD.textContent = `${d}/10`;

        const dd = calcCritDisplay(f, i, d);
        setPosteCompCritRing(dd.total);
    }

    async function savePosteCompEdit(portal){
        if (!_editingPosteId || !_posteCompEdit) return;

        const ownerId = getOwnerId();

        const niv = (document.querySelector('input[name="posteCompEditNiv"]:checked')?.value || "B").trim().toUpperCase();
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

    function formatValidityMonths(v){
        const n = parseInt(v ?? "", 10);
        if (!Number.isFinite(n) || n <= 0) return "—";
        return `${n} mois`;
    }

    function getPosteCertValidityLabel(it){
        const ov = parseInt(it?.validite_override ?? "", 10);
        if (Number.isFinite(ov) && ov > 0) return `${ov} mois`;
        const base = parseInt(it?.duree_validite ?? "", 10);
        if (Number.isFinite(base) && base > 0) return `${base} mois`;
        return "—";
    }

    function buildPosteCertBaseInfo(it){
        const parts = [];
        const base = formatValidityMonths(it?.duree_validite);
        const delai = formatValidityMonths(it?.delai_renouvellement);

        parts.push(`Validité catalogue : ${base}`);
        if (delai !== "—") parts.push(`Délai de renouvellement : ${delai}`);

        return parts.join(" · ");
    }

    function buildPosteCertAddMeta(it){
        const parts = [];

        const cat = (it?.categorie || "").toString().trim();
        if (cat) parts.push(`Catégorie : ${cat}`);

        parts.push(`Validité catalogue : ${formatValidityMonths(it?.duree_validite)}`);

        const delai = formatValidityMonths(it?.delai_renouvellement);
        if (delai !== "—") parts.push(`Délai de renouvellement : ${delai}`);

        return parts.join(" · ");
    }

    async function loadPosteCertifications(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        const data = await portal.apiJson(url);
        _posteCertItems = data.items || [];
        renderPosteCertifications();
    }

    function renderPosteCertifications(){
        const tb = byId("posteCertTbody");
        const empty = byId("posteCertEmpty");
        if (!tb) return;

        const iconEdit = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
        `;

        const iconTrash = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/>
                <path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
            </svg>
        `;

        const q = (_posteCertSearch || "").toLowerCase();
        const items = (_posteCertItems || []).filter(it => {
            if (!q) return true;
            const s = `${it.nom_certification || ""} ${it.categorie || ""} ${it.commentaire || ""}`.toLowerCase();
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

            const tdCat = document.createElement("td");
            const cat = (it.categorie || "").toString().trim();
            if (cat){
                const b = document.createElement("span");
                b.className = "sb-badge sb-badge--poste-soft";
                b.textContent = cat;
                tdCat.appendChild(b);
            } else {
                tdCat.textContent = "—";
            }

            const tdNom = document.createElement("td");
            const certWrap = document.createElement("div");
            certWrap.className = "sb-comp-cell";

            const title = document.createElement("div");
            title.className = "sb-comp-cell__title";
            title.textContent = it.nom_certification || "";

            certWrap.appendChild(title);
            tdNom.appendChild(certWrap);

            const tdVal = document.createElement("td");
            tdVal.style.textAlign = "center";
            tdVal.textContent = getPosteCertValidityLabel(it);
            if (it.validite_override !== null && it.validite_override !== undefined && String(it.validite_override).trim() !== ""){
                tdVal.title = `Validité catalogue : ${formatValidityMonths(it.duree_validite)}`;
            }

            const tdLvl = document.createElement("td");
            tdLvl.style.textAlign = "center";
            const bl = document.createElement("span");
            bl.className = `sb-badge ${String(it.niveau_exigence || "").toLowerCase() === "souhaité" ? "sb-badge--poste-soft" : "sb-badge--accent-soft"}`;
            bl.textContent = it.niveau_exigence || "—";
            tdLvl.appendChild(bl);

            const tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";

            if (isAdmin()){
                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const btnEdit = document.createElement("button");
                btnEdit.type = "button";
                btnEdit.className = "sb-icon-btn";
                btnEdit.title = "Modifier";
                btnEdit.setAttribute("aria-label", "Modifier");
                btnEdit.innerHTML = iconEdit;
                btnEdit.addEventListener("click", () => openPosteCertEditModal(it));

                const btnRem = document.createElement("button");
                btnRem.type = "button";
                btnRem.className = "sb-icon-btn sb-icon-btn--danger";
                btnRem.title = "Retirer";
                btnRem.setAttribute("aria-label", "Retirer");
                btnRem.innerHTML = iconTrash;
                btnRem.addEventListener("click", async () => {
                    if (!confirm(`Retirer la certification "${it.nom_certification || ""}" du poste ?`)) return;
                    try { await removePosteCertification(window.portal, it.id_certification); }
                    catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnRem);
                tdAct.appendChild(actions);
            } else {
                tdAct.textContent = "—";
            }

            tr.appendChild(tdCat);
            tr.appendChild(tdNom);
            tr.appendChild(tdVal);
            tr.appendChild(tdLvl);
            tr.appendChild(tdAct);

            tb.appendChild(tr);
        });
    }

    function openPosteCertAddModal(){
        if (!isAdmin()) return;
        if (!_editingPosteId) return;

        byId("posteCertAddSearch").value = "";
        _posteCertAddSearch = "";
        _posteCertAddCategory = "";
        byId("posteCertAddList").innerHTML = "";

        const sel = byId("posteCertAddCategory");
        if (sel) sel.value = "";

        openModal("modalPosteCertAdd");
        loadPosteCertAddList(window.portal).catch(()=>{});
    }

    function refreshPosteCertAddCategoryOptions(items){
        const sel = byId("posteCertAddCategory");
        if (!sel) return;

        const keep = (sel.value || "").trim();
        const map = new Map();

        (items || []).forEach(it => {
            const cat = (it.categorie || "").toString().trim() || "__none__";
            const label = (it.categorie || "").toString().trim() || "Sans catégorie";
            if (!map.has(cat)) map.set(cat, label);
        });

        sel.innerHTML = "";
        sel.appendChild(new Option("Toutes", ""));
        sel.appendChild(new Option("Sans catégorie", "__none__"));

        Array.from(map.entries())
            .filter(([id]) => id !== "__none__")
            .sort((a,b) => a[1].localeCompare(b[1], "fr", { sensitivity:"base" }))
            .forEach(([id, label]) => sel.appendChild(new Option(label, id)));

        if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
        else sel.value = "";

        _posteCertAddCategory = (sel.value || "").trim();
    }

    function applyPosteCertAddCategoryFilter(items){
        const cat = (_posteCertAddCategory || "").trim();
        if (!cat) return (items || []).slice();

        if (cat === "__none__"){
            return (items || []).filter(it => !((it.categorie || "").toString().trim()));
        }
        return (items || []).filter(it => ((it.categorie || "").toString().trim() === cat));
    }

    async function loadPosteCertAddList(portal){
        const ownerId = getOwnerId();
        const url =
            `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}` +
            `?q=${encodeURIComponent(_posteCertAddSearch)}`;

        const data = await portal.apiJson(url);
        let items = data.items || [];

        const existing = new Set((_posteCertItems || []).map(x => x.id_certification));
        items = items.filter(it => !existing.has(it.id_certification));

        _posteCertAddItemsAll = items;
        refreshPosteCertAddCategoryOptions(_posteCertAddItemsAll);
        _posteCertAddItems = applyPosteCertAddCategoryFilter(_posteCertAddItemsAll);
        renderPosteCertAddList();
    }

    function renderPosteCertAddList(){
        const host = byId("posteCertAddList");
        if (!host) return;
        host.innerHTML = "";

        const items = _posteCertAddItems || [];
        if (!items.length){
            const e = document.createElement("div");
            e.className = "card-sub";
            e.textContent = "Aucune certification à afficher.";
            host.appendChild(e);
            return;
        }

        items.forEach(it => {
            const row = document.createElement("div");
            row.className = "sb-row-card";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const wrap = document.createElement("div");

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = it.nom_certification || "";

            const meta = document.createElement("div");
            meta.className = "card-sub";
            meta.style.margin = "4px 0 0 0";
            meta.textContent = buildPosteCertAddMeta(it);

            wrap.appendChild(title);
            wrap.appendChild(meta);
            left.appendChild(wrap);

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-btn sb-btn--accent sb-btn--xs";
            btn.textContent = "Ajouter";
            btn.addEventListener("click", () => {
                closeModal("modalPosteCertAdd");
                openPosteCertEditModal({
                    id_certification: it.id_certification,
                    nom_certification: it.nom_certification,
                    description: it.description,
                    categorie: it.categorie,
                    duree_validite: it.duree_validite,
                    delai_renouvellement: it.delai_renouvellement,
                    validite_override: null,
                    niveau_exigence: "requis",
                    commentaire: ""
                }, true);
            });

            row.appendChild(left);
            row.appendChild(btn);

            host.appendChild(row);
        });
    }

    async function loadPosteCertCreateCategories(portal){
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}?q=`;
        const data = await portal.apiJson(url);

        const list = byId("posteCertCreateCategoryList");
        if (!list) return;

        const values = Array.from(
            new Set(
                (data.items || [])
                    .map(it => (it.categorie || "").toString().trim())
                    .filter(Boolean)
            )
        ).sort((a, b) => a.localeCompare(b, "fr", { sensitivity:"base" }));

        list.innerHTML = "";
        values.forEach(v => {
            const opt = document.createElement("option");
            opt.value = v;
            list.appendChild(opt);
        });
    }

    function bindStepButtons(host){
        if (!host) return;

        host.querySelectorAll(".sb-stepper-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const targetId = (btn.getAttribute("data-stepper-target") || "").trim();
                const delta = parseInt(btn.getAttribute("data-stepper-delta") || "0", 10);
                const input = byId(targetId);
                if (!input || !Number.isFinite(delta) || !delta) return;

                const min = parseInt(input.getAttribute("min") || "0", 10);
                const step = parseInt(input.getAttribute("step") || "1", 10) || 1;

                let cur = parseInt((input.value || "").trim(), 10);
                if (!Number.isFinite(cur)) {
                    cur = Math.max(min || step, step);
                } else {
                    cur += (delta * step);
                }

                if (Number.isFinite(min)) cur = Math.max(min, cur);

                input.value = String(cur);
                input.dispatchEvent(new Event("input", { bubbles:true }));
                input.dispatchEvent(new Event("change", { bubbles:true }));
            });
        });
    }

    async function openPosteCertCreateModal(portal){
        if (!isAdmin()) return;

        closeModal("modalPosteCertAdd");

        byId("posteCertCreateName").value = (_posteCertAddSearch || "").trim();
        byId("posteCertCreateCategory").value =
            (_posteCertAddCategory && _posteCertAddCategory !== "__none__")
                ? _posteCertAddCategory
                : "";
        byId("posteCertCreateValidity").value = "";
        byId("posteCertCreateRenewal").value = "";
        byId("posteCertCreateDescription").value = "";

        openModal("modalPosteCertCreate");
        await loadPosteCertCreateCategories(portal);
    }

    function closePosteCertCreateModal(reopenAdd){
        closeModal("modalPosteCertCreate");
        if (reopenAdd) openModal("modalPosteCertAdd");
    }

    async function savePosteCertCreate(portal){
        const ownerId = getOwnerId();

        const nom = (byId("posteCertCreateName")?.value || "").trim();
        const categorie = (byId("posteCertCreateCategory")?.value || "").trim() || null;
        const description = (byId("posteCertCreateDescription")?.value || "").trim() || null;

        if (!nom){
            portal.showAlert("error", "Le nom de la certification est obligatoire.");
            return;
        }

        const rawValidity = (byId("posteCertCreateValidity")?.value || "").trim();
        const rawRenewal = (byId("posteCertCreateRenewal")?.value || "").trim();

        let duree_validite = null;
        let delai_renouvellement = null;

        if (rawValidity){
            if (!/^\d+$/.test(rawValidity)) {
                portal.showAlert("error", "La validité catalogue doit être un entier positif.");
                return;
            }
            duree_validite = parseInt(rawValidity, 10);
            if (!Number.isFinite(duree_validite) || duree_validite <= 0){
                portal.showAlert("error", "La validité catalogue doit être supérieure à 0.");
                return;
            }
        }

        if (rawRenewal){
            if (!/^\d+$/.test(rawRenewal)) {
                portal.showAlert("error", "Le délai de renouvellement doit être un entier positif.");
                return;
            }
            delai_renouvellement = parseInt(rawRenewal, 10);
            if (!Number.isFinite(delai_renouvellement) || delai_renouvellement <= 0){
                portal.showAlert("error", "Le délai de renouvellement doit être supérieur à 0.");
                return;
            }
        }

        const url = `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}`;
        const data = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                nom_certification: nom,
                categorie: categorie,
                description: description,
                duree_validite: duree_validite,
                delai_renouvellement: delai_renouvellement
            })
        });

        const it = data?.item || {};
        closeModal("modalPosteCertCreate");
        closeModal("modalPosteCertAdd");

        openPosteCertEditModal({
            id_certification: it.id_certification,
            nom_certification: it.nom_certification,
            description: it.description,
            categorie: it.categorie,
            duree_validite: it.duree_validite,
            delai_renouvellement: it.delai_renouvellement,
            validite_override: null,
            niveau_exigence: "requis",
            commentaire: ""
        }, true);
    }

    function openPosteCertEditModal(it, isNew){
        _posteCertEdit = { ...(it || {}) };
        _posteCertEdit._isNew = !!isNew;

        byId("posteCertEditTitle").textContent = (_posteCertEdit.nom_certification || "Certification").toString();

        const cat = (_posteCertEdit.categorie || "").toString().trim();
        byId("posteCertEditSub").textContent = cat || "Sans catégorie";

        byId("posteCertEditBaseInfo").textContent = buildPosteCertBaseInfo(_posteCertEdit);
        byId("posteCertEditOverride").value =
            (_posteCertEdit.validite_override !== null && _posteCertEdit.validite_override !== undefined)
                ? String(_posteCertEdit.validite_override)
                : "";
        byId("posteCertEditLevel").value = (_posteCertEdit.niveau_exigence || "requis");
        byId("posteCertEditComment").value = (_posteCertEdit.commentaire || "");

        openModal("modalPosteCertEdit");
    }

    async function savePosteCertEdit(portal){
        if (!_editingPosteId || !_posteCertEdit) return;

        const ownerId = getOwnerId();

        const rawOverride = (byId("posteCertEditOverride")?.value || "").trim();
        let validiteOverride = null;

        if (rawOverride){
            if (!/^\d+$/.test(rawOverride)) {
                portal.showAlert("error", "La validité spécifique doit être un entier positif.");
                return;
            }
            validiteOverride = parseInt(rawOverride, 10);
            if (!Number.isFinite(validiteOverride) || validiteOverride <= 0){
                portal.showAlert("error", "La validité spécifique doit être supérieure à 0.");
                return;
            }
        }

        const niveau = (byId("posteCertEditLevel")?.value || "requis").trim();
        const commentaire = (byId("posteCertEditComment")?.value || "").trim() || null;

        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                id_certification: _posteCertEdit.id_certification,
                validite_override: validiteOverride,
                niveau_exigence: niveau,
                commentaire: commentaire
            })
        });

        closeModal("modalPosteCertEdit");
        portal.showAlert("", "");
        await loadPosteCertifications(portal);
    }

    async function removePosteCertification(portal, id_certification){
        if (!_editingPosteId) return;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_certification)}/remove`;
        await portal.apiJson(url, { method: "POST" });
        portal.showAlert("", "");
        await loadPosteCertifications(portal);
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

        refreshPosteImportButton();
        resetPosteImportState();

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
        resetPosteAiModalFields();
        _posteAiDraftMeta = null;
        resetPosteCompAiUi();

        refreshPosteFooterActions();

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Créer";

        fillPosteContraintesTab({});
        resetPosteCcnUi(true);
        fillPosteRhTab({}, true);

        _posteCompItems = [];
        _posteCompSearch = "";
        if (byId("posteCompSearch")) byId("posteCompSearch").value = "";
        renderPosteCompetences();

        _posteCertItems = [];
        _posteCertSearch = "";
        if (byId("posteCertSearch")) byId("posteCertSearch").value = "";
        renderPosteCertifications();

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

        refreshPosteImportButton();
        resetPosteImportState();
        closePosteImportModal();
        
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
        resetPosteCompAiUi();

        // On pré-remplit ce qu'on a déjà (le détail complet arrive à l'étape 2)
        byId("posteIntitule").value = (p && p.intitule) ? String(p.intitule) : "";

        refreshPosteFooterActions();
        setPosteModalActif((p && p.actif !== false));

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Enregistrer";
        fillPosteRhTab({}, false);
        resetPosteCcnUi(false);

        _posteCompItems = [];
        renderPosteCompetences();

        _posteCertItems = [];
        renderPosteCertifications();

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
            fillPosteRhTab(d, false);
            await loadPosteCcnContext(portal);
            await loadPosteCompetences(portal);
            await loadPosteCertifications(portal);

            // --- Définition (remplissage robuste: si champ supprimé, pas d'erreur)
            const elCodCli = byId("posteCodifClient"); if (elCodCli) elCodCli.value = (d.codif_client || "");
            const elInt = byId("posteIntitule"); if (elInt) elInt.value = (d.intitule_poste || "");
            const elMis = byId("posteMission"); if (elMis) elMis.value = (d.mission_principale || "");

            // Responsabilités: richtext si présent, sinon textarea
            if (typeof rtSetHtml === "function") rtSetHtml("posteResp", d.responsabilites || "");
            else { const elResp = byId("posteResp"); if (elResp) elResp.value = (d.responsabilites || ""); }
            seedPosteAiModalFromCurrent();

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
        closeIaBusyOverlay();
        closeModal("modalPosteCompCreate");
        closeModal("modalPosteImport");
        closeModal("modalPoste");
        resetPosteImportState();
    }

        function getPosteModalActif(){
        const card = document.querySelector("#modalPoste .sb-modal-card");
        return (card && card.dataset.actif === "0") ? false : true;
    }

    async function savePosteFromModal(portal, options){
        const opts = options || {};
        const keepOpen = !!opts.keepOpen;
        const silent = !!opts.silent;
        const ownerId = getOwnerId();

        const sid = (byId("posteService")?.value || "").trim();
        const codc = (byId("posteCodifClient")?.value || "").trim();
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const resp = rtGetHtml("posteResp").trim();

        if (!sid){
            portal.showAlert("error", "Sélectionne un service.");
            return null;
        }
        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return null;
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
            statut_poste: (byId("posteRhStatut")?.value || "actif").trim(),
            date_debut_validite: (byId("posteRhDateDebut")?.value || "").trim() || null,
            date_fin_validite: (byId("posteRhDateFinWrap")?.style.display === "none")
                ? null
                : ((byId("posteRhDateFin")?.value || "").trim() || null),
            nb_titulaires_cible: null,
            criticite_poste: null,
            strategie_pourvoi: (byId("posteRhStrategie")?.value || "mixte").trim(),
            param_rh_verrouille: !!byId("posteRhVerrouille")?.checked,
            param_rh_commentaire: (byId("posteRhCommentaire")?.value || "").trim() || null,
        };

        const rawNbTit = (byId("posteRhNbTitulaires")?.value || "").trim();
        const nbTit = parseInt(rawNbTit || "1", 10);
        if (!Number.isFinite(nbTit) || nbTit < 1){
            portal.showAlert("error", "Le nombre de titulaires cible doit être supérieur ou égal à 1.");
            return null;
        }
        payload.nb_titulaires_cible = nbTit;

        const rawCrit = (byId("posteRhCriticite")?.value || "").trim();
        const crit = parseInt(rawCrit || "2", 10);
        if (!Number.isFinite(crit) || crit < 1 || crit > 3){
            portal.showAlert("error", "La criticité du poste doit être comprise entre 1 et 3.");
            return null;
        }
        payload.criticite_poste = crit;

        if (payload.date_debut_validite && payload.date_fin_validite && payload.date_fin_validite < payload.date_debut_validite){
            portal.showAlert("error", "La date de fin de validité doit être postérieure ou égale à la date de début.");
            return null;
        }

        if (_posteModalMode === "create"){
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            await loadServices(portal);
            await loadPostes(portal);

            if (keepOpen){
                const pid = (r?.id_poste || "").toString().trim();
                const code = (r?.codif_poste || "").toString().trim();
                _posteModalMode = "edit";
                _editingPosteId = pid || _editingPosteId;
                const modal = byId("modalPoste");
                if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");
                byId("posteModalTitle").textContent = title || "Poste";
                byId("posteModalSub").textContent = "Mise à jour / transfert de service / archivage.";
                const badge = byId("posteModalBadge");
                if (badge){
                    badge.textContent = code || "";
                    badge.style.display = code ? "" : "none";
                }
                refreshPosteFooterActions();
                const bS = byId("btnPosteSave");
                if (bS) bS.textContent = "Enregistrer";
                setPosteModalActif(true);
                seedPosteAiModalFromCurrent();
                if (!silent) setStatus(opts.statusMessage || "Poste créé.");
                return r;
            }

            if (!silent) setStatus(opts.statusMessage || "Poste créé.");
            closePosteModal();
            return r;

        } else {
            const pid = (_editingPosteId || "").trim();
            if (!pid) throw new Error("id_poste manquant (edit).");

            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            _posteDetailCache.delete(pid);

            await loadServices(portal);
            await loadPostes(portal);

            if (!keepOpen){
                if (!silent) setStatus(opts.statusMessage || "Poste enregistré.");
                closePosteModal();
            } else if (!silent) {
                setStatus(opts.statusMessage || "Poste enregistré.");
            }
            return r || { ok: true };
        }
    }

    async function toggleArchivePosteFromList(portal, poste){
        const ownerId = getOwnerId();
        const pid = (poste && poste.id_poste) ? String(poste.id_poste).trim() : "";
        if (!pid) return;

        const isActif = !(poste && poste.actif === false);
        const wantArchive = isActif; // actif => archive ; archivé => restaure

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`;
        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ archive: wantArchive }),
        });

        _posteDetailCache.delete(pid);

        await loadServices(portal);
        await loadPostes(portal);

        setStatus(wantArchive ? "Poste archivé." : "Poste restauré.");
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
        byId("svcModalSub").textContent = "Renommer / Changer le service parent.";
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

        _selectedService = "__all__";
        _selectedServiceName = "Tous les services";

        await loadServices(portal);
        await loadPostes(portal);

        refreshPosteBlockTitle();
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

        byId("btnOpenOrgChart")?.addEventListener("click", async () => {
            try { await openOrgChartPdf(portal); }
            catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

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

        const pcsCert = byId("posteCertSearch");
        if (pcsCert){
          pcsCert.addEventListener("input", () => {
            _posteCertSearch = (pcsCert.value || "").trim();
            if (_posteCertSearchTimer) clearTimeout(_posteCertSearchTimer);
            _posteCertSearchTimer = setTimeout(() => renderPosteCertifications(), 200);
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
        const orgRoot = getOrganisationRoot();
        if (orgRoot && !orgRoot._svcActionsBound){
            orgRoot._svcActionsBound = true;

            orgRoot.addEventListener("click", (e) => {
                const btnAdd = e.target.closest("#btnSvcAdd");
                if (btnAdd){
                    e.preventDefault();
                    e.stopPropagation();
                    openCreateService();
                    return;
                }

                const btnEdit = e.target.closest("#btnSvcEdit");
                if (btnEdit){
                    e.preventDefault();
                    e.stopPropagation();
                    openEditService();
                    return;
                }

                const btnArchive = e.target.closest("#btnSvcArchive");
                if (btnArchive){
                    e.preventDefault();
                    e.stopPropagation();
                    openArchiveService();
                }
            });
        }

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

        byId("btnPosteImport")?.addEventListener("click", () => {
            try { openPosteImportModal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteImport")?.addEventListener("click", () => closePosteImportModal());
        byId("btnPosteImportCancel")?.addEventListener("click", () => closePosteImportModal());
        byId("btnPosteImportChange")?.addEventListener("click", () => {
            byId("posteImportFileInput")?.click();
        });
        byId("btnPosteImportAnalyze")?.addEventListener("click", async () => {
            try { await launchPosteImport(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        const posteImportInput = byId("posteImportFileInput");
        posteImportInput?.addEventListener("change", (e) => {
            try{
                const file = e?.target?.files?.[0];
                if (!file) return;
                setPosteImportFile(file);
            } catch(err){
                portal.showAlert("error", err?.message || String(err));
                resetPosteImportState();
            }
        });

        const posteImportDrop = byId("posteImportDropzone");
        if (posteImportDrop){
            posteImportDrop.addEventListener("click", () => {
                byId("posteImportFileInput")?.click();
            });

            posteImportDrop.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " "){
                    e.preventDefault();
                    byId("posteImportFileInput")?.click();
                }
            });

            ["dragenter", "dragover"].forEach(evt => {
                posteImportDrop.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    posteImportDrop.classList.add("is-drag");
                });
            });

            ["dragleave", "dragend", "drop"].forEach(evt => {
                posteImportDrop.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (evt !== "drop"){
                        posteImportDrop.classList.remove("is-drag");
                    }
                });
            });

            posteImportDrop.addEventListener("drop", (e) => {
                posteImportDrop.classList.remove("is-drag");
                try{
                    const file = e?.dataTransfer?.files?.[0];
                    if (!file) return;
                    setPosteImportFile(file);
                } catch(err){
                    portal.showAlert("error", err?.message || String(err));
                    resetPosteImportState();
                }
            });
        }

        const mpi = byId("modalPosteImport");
        if (mpi && !mpi._sbBound){
            mpi._sbBound = true;

            mpi.addEventListener("click", (e) => {
                if (e.target === mpi) closePosteImportModal();
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteImport");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteImportModal();
            });
        }

        byId("btnPosteAi")?.addEventListener("click", () => {
            try { openPosteAiModal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteAiX")?.addEventListener("click", closePosteAiModal);
        byId("btnPosteAiCancel")?.addEventListener("click", closePosteAiModal);
        byId("btnPosteAiGenerate")?.addEventListener("click", async () => {
            try { await generatePosteAiDraft(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCcnOpen")?.addEventListener("click", async () => {
            try { await openPosteCcnModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnX")?.addEventListener("click", closePosteCcnModal);
        byId("btnPosteCcnCancel")?.addEventListener("click", closePosteCcnModal);
        byId("btnPosteCcnAnalyze")?.addEventListener("click", async () => {
            try { await runPosteCcnAnalysis(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnReuse")?.addEventListener("click", () => {
            try { reusePosteCcnProposal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnSave")?.addEventListener("click", async () => {
            try { await savePosteCcnDecision(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("posteCcnFinalCoefficient")?.addEventListener("input", refreshPosteCcnDecisionDerived);

        const mccn = byId("modalPosteCcn");
        if (mccn && !mccn._sbBound){
            mccn._sbBound = true;

            mccn.addEventListener("click", (e) => {
                if (e.target === mccn) closePosteCcnModal();
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteCcn");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteCcnModal();
            });
        }

        byId("btnPosteCompAi")?.addEventListener("click", async () => {
            try { await openPosteCompAiModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCompAiX")?.addEventListener("click", () => closeModal("modalPosteCompAi"));
        byId("btnPosteCompAiClose")?.addEventListener("click", () => closeModal("modalPosteCompAi"));

        byId("btnPosteCompCreateX")?.addEventListener("click", () => closePosteCompCreateModal());
        byId("btnPosteCompCreateCancel")?.addEventListener("click", () => closePosteCompCreateModal());

        byId("btnPosteCompCreateAdd")?.addEventListener("click", async () => {
            try { await savePosteCompCreateModal(portal, true); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateOnly")?.addEventListener("click", async () => {
            try { await savePosteCompCreateModal(portal, false); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateAddCrit")?.addEventListener("click", () => {
            const idx = nextEmptyPosteCompCreateCritIndex();
            if (idx < 0) return;
            showPosteCompCreateCritEditor(idx);
        });

        byId("btnPosteCompCreateCritSave")?.addEventListener("click", () => {
            try { savePosteCompCreateCritFromEditor(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateCritCancel")?.addEventListener("click", () => hidePosteCompCreateCritEditor());

        bindPosteCompCreateMaxLen("posteCompCreateNivA", 230);
        bindPosteCompCreateMaxLen("posteCompCreateNivB", 230);
        bindPosteCompCreateMaxLen("posteCompCreateNivC", 230);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval1", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval2", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval3", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval4", 120);

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
        byId("posteCompAddDomain")?.addEventListener("change", (e) => {
        _posteCompAddDomain = (e.target.value || "").trim();
        _posteCompAddItems = applyPosteCompAddDomainFilter(_posteCompAddItemsAll);
        renderPosteCompAddList();
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
        document.querySelectorAll('input[name="posteCompEditNiv"]').forEach(r => {
            r.addEventListener("change", refreshPosteCompNivCards);
        });

        // Certifications
        byId("btnPosteCertAdd")?.addEventListener("click", () => {
          try { openPosteCertAddModal(); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCertCreate")?.addEventListener("click", async () => {
          try { await openPosteCertCreateModal(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteCertAdd")?.addEventListener("click", () => closeModal("modalPosteCertAdd"));

        const certSearch = byId("posteCertAddSearch");
        if (certSearch){
          certSearch.addEventListener("input", () => {
            _posteCertAddSearch = (certSearch.value || "").trim();
            if (_posteCertAddTimer) clearTimeout(_posteCertAddTimer);
            _posteCertAddTimer = setTimeout(() => loadPosteCertAddList(portal).catch(()=>{}), 250);
          });
        }

        byId("posteCertAddCategory")?.addEventListener("change", (e) => {
          _posteCertAddCategory = (e.target.value || "").trim();
          _posteCertAddItems = applyPosteCertAddCategoryFilter(_posteCertAddItemsAll);
          renderPosteCertAddList();
        });

        bindStepButtons(byId("modalPosteCertCreate"));
        bindStepButtons(byId("modalPosteCertEdit"));
        byId("btnClosePosteCertCreate")?.addEventListener("click", () => closePosteCertCreateModal(true));
        byId("btnPosteCertCreateCancel")?.addEventListener("click", () => closePosteCertCreateModal(true));
        byId("btnPosteCertCreateSave")?.addEventListener("click", async () => {
          try { await savePosteCertCreate(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteCertEdit")?.addEventListener("click", () => closeModal("modalPosteCertEdit"));
        byId("btnPosteCertEditCancel")?.addEventListener("click", () => closeModal("modalPosteCertEdit"));
        byId("btnPosteCertEditSave")?.addEventListener("click", async () => {
          try { await savePosteCertEdit(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
    }

    async function init(force = false){
        try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}

        const portal = window.portal;
        const root = getOrganisationRoot();

        traceOrg("init:start", {
            force: !!force,
            hasPortal: !!portal,
            hasRoot: !!root
        });

        if (!portal || !root) {
            traceOrg("init:skip", {
                force: !!force,
                hasPortal: !!portal,
                hasRoot: !!root
            });
            return;
        }

        if (_loaded && !force) {
            traceOrg("init:cached", {
                nbServices: (_services || []).length,
                nbPostes: (_totaux?.nb_postes || 0)
            });
            return;
        }

        await ensureRole(portal);
        traceOrg("init:role", { role: _roleCode || "user" });

        bindOnce(portal);

        await loadServices(portal);
        await loadPostes(portal);

        _loaded = true;

        traceOrg("init:done", {
            nbServices: (_services || []).length,
            nbPostes: (_totaux?.nb_postes || 0),
            nbPostesNonLies: (_nonLie?.nb_postes || 0)
        });
    }

    window.__studioOrganisationInit = async function(options){
        const force = !!(options && options.force);
        try {
            await init(force);
        } catch (e) {
            if (window.portal && window.portal.showAlert) {
                window.portal.showAlert("error", "Erreur organisation : " + (e?.message || e));
            }
            setStatus("Erreur de chargement.");
            throw e;
        }
    };

    if (getOrganisationRoot() && window.portal) {
        window.__studioOrganisationInit().catch(() => {});
    }

})();