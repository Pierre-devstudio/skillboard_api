(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  let _detail = null;
  let _summary = null;
  let _ownerFeatures = null;
  let _context = null;
  let _ficheEditMode = false;
  let _ficheSaving = false;

  function byId(id){ return document.getElementById(id); }

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

  function inputValue(id){
    const el = byId(id);
    if (!el) return "";
    return (el.value || "").toString().trim();
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

  function setMessage(message, kind){
    const box = byId("csMessage");
    if (!box) return;

    box.classList.remove("is-success", "is-error");

    if (!message) {
      box.style.display = "none";
      box.textContent = "";
      return;
    }

    if (kind === "success") {
      box.classList.add("is-success");
    } else {
      box.classList.add("is-error");
    }

    box.style.display = "block";
    box.textContent = message;
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
    setInputValue("ficheCpEnt", _detail?.cp_ent);
    setInputValue("ficheVilleEnt", _detail?.ville_ent);
    setInputValue("fichePaysEnt", _detail?.pays_ent);
    setInputValue("ficheTelephoneEnt", _detail?.telephone_ent);
    setInputValue("ficheEmailEnt", _detail?.email_ent);
    setInputValue("ficheSiteWeb", _detail?.site_web);

    setInputValue("ficheIdcc", _detail?.idcc);
    setHelp("ficheIdccHelp", _detail?.idcc_libelle);
    setInputValue("ficheCodeApeEnt", _detail?.code_ape_ent);
    setHelp("ficheCodeApeHelp", _detail?.code_ape_intitule);
    setInputValue("ficheIdOpco", _detail?.id_opco);
    setHelp("ficheOpcoHelp", _detail?.opco_nom);

    setCheckboxValue("ficheGroupOk", _detail?.group_ok);
    setCheckboxValue("ficheTeteGroupe", _detail?.tete_groupe);
    setInputValue("ficheNomGroupe", _detail?.nom_groupe);
    setInputValue("ficheTypeGroupe", _detail?.type_groupe);

    setText("idNbParents", _detail?.nb_entites_parents);
    setText("idNbChildren", _detail?.nb_entites_enfants);

    syncGroupFieldsState();
  }

  function readFichePayload(){
    return {
      nom_ent: inputValue("ficheNomEnt"),
      siret_ent: inputValue("ficheSiretEnt"),
      num_entreprise: inputValue("ficheNumEntreprise"),
      date_creation: inputValue("ficheDateCreation") || null,
      effectif_ent: inputValue("ficheEffectifEnt"),
      num_tva_ent: inputValue("ficheNumTvaEnt"),

      adresse_ent: inputValue("ficheAdresseEnt"),
      adresse_cplt_ent: inputValue("ficheAdresseCpltEnt"),
      cp_ent: inputValue("ficheCpEnt"),
      ville_ent: inputValue("ficheVilleEnt"),
      pays_ent: inputValue("fichePaysEnt"),
      telephone_ent: inputValue("ficheTelephoneEnt"),
      email_ent: inputValue("ficheEmailEnt"),
      site_web: inputValue("ficheSiteWeb"),

      idcc: inputValue("ficheIdcc"),
      code_ape_ent: inputValue("ficheCodeApeEnt"),
      id_opco: inputValue("ficheIdOpco"),

      group_ok: !!byId("ficheGroupOk")?.checked,
      tete_groupe: !!byId("ficheTeteGroupe")?.checked,
      nom_groupe: inputValue("ficheNomGroupe"),
      type_groupe: inputValue("ficheTypeGroupe"),
    };
  }

  function syncGroupFieldsState(){
    const isGroup = !!byId("ficheGroupOk")?.checked;
    const tete = byId("ficheTeteGroupe");
    const nom = byId("ficheNomGroupe");
    const type = byId("ficheTypeGroupe");

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

        if (btnEdit) {
            btnEdit.classList.toggle("is-hidden", _ficheEditMode);
        }

        if (btnCancel) {
            btnCancel.classList.toggle("is-hidden", !_ficheEditMode);
        }

        if (btnSave) {
            btnSave.classList.toggle("is-hidden", !_ficheEditMode);
        }

        syncGroupFieldsState();
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
      setFicheEditMode(false);
      setMessage("Fiche enregistrée.", "success");
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

    byId("ficheGroupOk")?.addEventListener("change", syncGroupFieldsState);
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

    const [detail, clientsData, context] = await Promise.all([
      apiJson(`${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}/${encodeURIComponent(clientId)}`, token),
      apiJson(`${API_BASE}/studio/clients/${encodeURIComponent(ownerId)}`, token),
      apiJson(`${API_BASE}/studio/context/${encodeURIComponent(ownerId)}`, token),
    ]);

    _detail = detail || {};
    _summary = clientsData?.summary || {};
    _ownerFeatures = clientsData?.owner_features || {};
    _context = context || {};

    renderLinks();
    renderDynamicLabels();
    renderHeader();
    renderDashboard();
    renderIdentification();
    setFicheEditMode(false);
    setSection("dashboard");
  }

  window.addEventListener("DOMContentLoaded", async () => {
    bindNavigation();
    bindFicheActions();
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