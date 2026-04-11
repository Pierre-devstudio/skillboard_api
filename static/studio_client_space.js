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

  let _orgWorkspaceScriptPromise = null;

  function ensureOrganisationScriptLoaded(){
    const alreadyLoaded = document.querySelector('script[data-studio-org-script="1"][data-loaded="1"]');
    if (alreadyLoaded) {
      return Promise.resolve();
    }

    if (_orgWorkspaceScriptPromise) {
      return _orgWorkspaceScriptPromise;
    }

    _orgWorkspaceScriptPromise = new Promise((resolve, reject) => {
      let script = document.querySelector('script[data-studio-org-script="1"]');

      const onLoad = () => {
        if (script) script.dataset.loaded = "1";
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        _orgWorkspaceScriptPromise = null;
        reject(new Error("Impossible de charger studio_organisation.js."));
      };

      const cleanup = () => {
        if (!script) return;
        script.removeEventListener("load", onLoad);
        script.removeEventListener("error", onError);
      };

      if (!script) {
        script = document.createElement("script");
        script.src = "/studio_organisation.js";
        script.dataset.studioOrgScript = "1";
        document.body.appendChild(script);
      }

      if (script.dataset.loaded === "1") {
        cleanup();
        resolve();
        return;
      }

      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
    });

    return _orgWorkspaceScriptPromise;
  }

  async function loadOrganisationWorkspace(){
    const mount = byId("orgWorkspaceMount");
    if (!mount) return;
    if (mount.dataset.loaded === "1") {
      const orgInit = window.__studioOrganisationInit;
      if (typeof orgInit === "function") {
        await orgInit({ force: true });
      }
      return;
    }

    const r = await fetch("/studio_organisation.html", { cache: "no-store" });
    if (!r.ok) {
      throw new Error(`Impossible de charger studio_organisation.html (HTTP ${r.status}).`);
    }

    const html = await r.text();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;

    const root = wrapper.querySelector('#view-organisation[data-view="organisation"]');
    if (!root) {
      throw new Error("Bloc Organisation partagé introuvable.");
    }

    mount.innerHTML = "";
    mount.appendChild(root);

    ensureOrganisationPortalBridge();

    const orgInit = window.__studioOrganisationInit;
    if (typeof orgInit === "function") {
      await orgInit({ force: true });
    }

    mount.dataset.loaded = "1";
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
      btn.addEventListener("click", () => setSection(btn.dataset.section || "dashboard"));
    });

    byId("btnOrgHistory")?.addEventListener("click", async () => {
      try {
        setMessage("");
        setSection("organisation");
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
    await loadOrganisationWorkspace();
    setFicheEditMode(false);
    setSection("dashboard");
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