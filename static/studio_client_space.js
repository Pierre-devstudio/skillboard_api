(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  let _detail = null;
  let _summary = null;
  let _ownerFeatures = null;
  let _context = null;

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

  function yesNo(value){
    return value ? "Oui" : "Non";
  }

  function textOrDash(value){
    const v = (value ?? "").toString().trim();
    return v || "—";
  }

  function setText(id, value){
    const el = byId(id);
    if (!el) return;
    el.textContent = textOrDash(value);
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
    setText("idNomEnt", _detail?.nom_ent);
    setText("idSiretEnt", _detail?.siret_ent);
    setText("idNumEntreprise", _detail?.num_entreprise);
    setText("idDateCreation", formatDateFr(_detail?.date_creation));
    setText("idEffectifEnt", _detail?.effectif_ent);
    setText("idNumTvaEnt", _detail?.num_tva_ent);

    setText("idAdresseEnt", _detail?.adresse_ent);
    setText("idAdresseCpltEnt", _detail?.adresse_cplt_ent);
    setText("idCpEnt", _detail?.cp_ent);
    setText("idVilleEnt", _detail?.ville_ent);
    setText("idPaysEnt", _detail?.pays_ent);
    setText("idTelephoneEnt", _detail?.telephone_ent);
    setText("idEmailEnt", _detail?.email_ent);
    setText("idSiteWeb", _detail?.site_web);

    setText("idIdcc", _detail?.idcc);
    setText("idIdccLibelle", _detail?.idcc_libelle);
    setText("idCodeApeEnt", _detail?.code_ape_ent);
    setText("idCodeApeIntitule", _detail?.code_ape_intitule);
    setText("idOpcoNom", _detail?.opco_nom);

    setText("idGroupOk", yesNo(_detail?.group_ok));
    setText("idTeteGroupe", yesNo(_detail?.tete_groupe));
    setText("idNomGroupe", _detail?.nom_groupe);
    setText("idTypeGroupe", _detail?.type_groupe);
    setText("idNbParents", _detail?.nb_entites_parents);
    setText("idNbChildren", _detail?.nb_entites_enfants);
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
    renderHeader();
    renderDashboard();
    renderIdentification();
    setSection("dashboard");
  }

  window.addEventListener("DOMContentLoaded", async () => {
    bindNavigation();
    renderLinks();
    try {
      await loadData();
      setMessage("");
    } catch (e) {
      setMessage(e.message || "Erreur de chargement de l’espace client.");
    }
  });
})();