(function () {
  const NON_LIE_ID = "__NON_LIE__";
  const TOUS_SERVICES_ID = "__TOUS__";


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

    function byId(id){ return document.getElementById(id); }

  function setOrgPosteTab(tab){
    const modal = byId("modalOrgPoste");
    if (!modal) return;

    modal.querySelectorAll("#orgPosteTabbar .sb-seg").forEach(btn => {
      btn.classList.toggle("is-active", btn.getAttribute("data-tab") === tab);
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

    fillPosteCompetencesTab({ competences: [] });


    // Détail (fetch)
    try {
      if (!id_poste) return;
      const detail = await fetchPosteDetail(portal, id_poste);
      fillPosteDefinitionTab(detail);
      fillPosteContraintesTab(detail);
      fillPosteCompetencesTab(detail);
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
    modal.querySelectorAll("#orgPosteTabbar .sb-seg").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        setOrgPosteTab(tab);
      });
    });

    // Esc
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("show")) {
        closeOrgPosteModal();
      }
    });
  }



  function setServiceHeader(node) {
    const title = document.getElementById("orgServiceTitle");
    const meta = document.getElementById("orgServiceMeta");

    if (!node) {
      if (title) title.textContent = "Service non sélectionné";
      if (meta) meta.textContent = "—";
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

    function renderNode(node, depth) {
      const hasChildren = node.children && node.children.length > 0;

      const label = document.createElement("div");
      label.className = "sb-tree-item";
      label.setAttribute("data-id", node.id_service);
      label.style.paddingLeft = `${10 + depth * 16}px`;

      const name = document.createElement("div");
      name.className = "sb-tree-name";
      name.textContent = node.nom_service || "Sans nom";

      const meta = document.createElement("div");
      meta.className = "sb-tree-meta";
      meta.textContent = `${node.nb_postes ?? 0} · ${node.nb_effectifs ?? 0}`;

      label.appendChild(name);
      label.appendChild(meta);

      label.addEventListener("click", () => {
        selectService(node.id_service);
        if (hasChildren) {
          // toggle "collapsed" on children wrapper
          const wrap = tree.querySelector(`.sb-tree-children[data-parent='${CSS.escape(node.id_service)}']`);
          if (wrap) wrap.classList.toggle("collapsed");
        }
      });

      tree.appendChild(label);

      if (hasChildren) {
        const childrenWrap = document.createElement("div");
        childrenWrap.className = "sb-tree-children";
        childrenWrap.setAttribute("data-parent", node.id_service);
        // par défaut: déplié
        node.children.forEach(ch => {
          renderNode(ch, depth + 1);
        });
      }
    }

    function renderNodeRec(node, depth) {
      const hasChildren = node.children && node.children.length > 0;

      const item = document.createElement("div");
      item.className = "sb-tree-item";
      item.setAttribute("data-id", node.id_service);
      item.style.paddingLeft = `${10 + depth * 16}px`;

      item.innerHTML = `
        <div class="sb-tree-name">${escapeHtml(node.nom_service || "Sans nom")}</div>
        <div class="sb-tree-meta">${escapeHtml(`${node.nb_postes ?? 0} · ${node.nb_effectifs ?? 0}`)}</div>
      `;

      item.addEventListener("click", () => {
        selectService(node.id_service);
      });

      tree.appendChild(item);

      if (hasChildren) {
        const childrenWrap = document.createElement("div");
        childrenWrap.className = "sb-tree-children";
        childrenWrap.setAttribute("data-parent", node.id_service);

        node.children.forEach(ch => renderNodeRec(ch, depth + 1));
        tree.appendChild(childrenWrap); // (wrap vide visuellement, mais sert pour CSS/structure)
      }
    }

    // rendu simple + récursif (sans wrap intermédiaire compliqué)
    function rec(list, depth) {
      (list || []).forEach(n => {
        const hasChildren = n.children && n.children.length > 0;

        const item = document.createElement("div");
        item.className = "sb-tree-item";
        item.setAttribute("data-id", n.id_service);
        item.style.paddingLeft = `${10 + depth * 16}px`;

        item.innerHTML = `
          <div class="sb-tree-name">${escapeHtml(n.nom_service || "Sans nom")}</div>
          <div class="sb-tree-meta">${escapeHtml(`${n.nb_postes ?? 0} · ${n.nb_effectifs ?? 0}`)}</div>
        `;

        item.addEventListener("click", () => selectService(n.id_service));
        tree.appendChild(item);

        if (hasChildren) rec(n.children, depth + 1);
      });
    }

    rec(nodes, 0);

    // sélection par défaut: Tous les services si présent, sinon premier service
    const tous = nodes.find(x => x.id_service === TOUS_SERVICES_ID);
    if (tous) selectService(TOUS_SERVICES_ID);
    else if (nodes.length > 0) selectService(nodes[0].id_service);

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

    list.forEach(p => {
      const row = document.createElement("div");
      row.className = "org-poste-row";

      const badgeEff = `<span class="sb-badge">${escapeHtml((p.nb_effectifs ?? 0).toString())} collab.</span>`;
      const badgeResp = p.isresponsable ? `<span class="sb-badge sb-badge-accent">Responsable</span>` : "";

      const code = (p.codif_poste || "").trim();
      const title = (p.intitule_poste || "").trim();
      const clientCode = (p.codif_client || "").trim();
      const codeBadge = clientCode || code;

      row.innerHTML = `
        <div class="sb-acc-left">
          <div class="org-poste-head">
            ${codeBadge ? `<span class="sb-badge sb-badge-poste-code">${escapeHtml(codeBadge)}</span>` : ``}
            <div class="sb-acc-title">${escapeHtml(title || "Poste")}</div>
          </div>
        </div>
        <div class="sb-acc-right">
          ${badgeResp}
          ${badgeEff}
        </div>
      `;


      // IMPORTANT: pas d'accordéon, pas de contenu déroulant.
      // Le détail viendra dans le modal (prochaine étape).
      row.addEventListener("click", () => {
        openOrgPosteModal(p);
      });


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

  function fillPosteDefinitionTab(detail) {
    const missionWrap = document.getElementById("orgPosteDefMissionWrap");
    const mission = document.getElementById("orgPosteDefMission");
    const respWrap = document.getElementById("orgPosteDefRespWrap");
    const resp = document.getElementById("orgPosteDefResp");
    const empty = document.getElementById("orgPosteDefEmpty");
    const badgeResp = document.getElementById("orgPosteDefRespBadge");
    const dateEl = document.getElementById("orgPosteDefDate");

    const m = (detail?.mission_principale || "").trim();
    const rh = (detail?.responsabilites_html || "").trim();

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
        // On garde le RTF brut en mémoire pour le round-trip futur
        resp.dataset.rtf = detail?.responsabilites || "";
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
  }

  function _setChecked(id, v){
    const el = byId(id);
    if (!el) return;
    el.checked = !!v;
  }

  function _fillSelect(el, options){
    if (!el) return;
    el.innerHTML = "";
    options.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.text;
      el.appendChild(opt);
    });
  }

  function _selectByStoredValue(selectId, stored){
    const el = byId(selectId);
    if (!el) return;

    const v = (stored ?? "").toString().trim();
    if (!v){
      el.value = "";
      return;
    }

    // match direct
    for (const opt of el.options){
      if (opt.value === v){
        el.value = v;
        return;
      }
    }

    // match normalisé (accents / casse)
    const nv = _norm(v);
    for (const opt of el.options){
      if (_norm(opt.value) === nv){
        el.value = opt.value;
        return;
      }
    }

    el.value = "";
  }

  let _contraintesSelectsInit = false;

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

        // Aide : afficher le libellé complet sélectionné (utile car <select> tronque)
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
          sel.title = txt; // tooltip natif en bonus
        } else {
          help.textContent = "";
          help.style.display = "none";
          sel.title = "";
        }
      };

      // Stocke pour réutilisation depuis fillPosteContraintesTab
      sel._sbRefreshHelp = refresh;

      // Pour le futur (quand tu enlèveras disabled)
      sel.addEventListener("change", refresh);

      refresh();
    };

    bindHelp("orgCtrRisquePhys", "orgCtrRisquePhysHelp");
    bindHelp("orgCtrNivContrainte", "orgCtrNivContrainteHelp");

  }

  function fillPosteContraintesTab(detail){
    initContraintesSelects();

    _selectByStoredValue("orgCtrEduMin", detail?.niveau_education_minimum);

    // NSF : on charge l’option “courante” (contrôle prêt pour édition future)
    const nsfSel = byId("orgCtrNsfGroupe");
    if (nsfSel){
      nsfSel.innerHTML = "";
      const code = (detail?.nsf_groupe_code ?? "").toString().trim();
      const titre = (detail?.nsf_groupe_titre ?? "").toString().trim();

      const opt = document.createElement("option");
      opt.value = code || "";
      opt.textContent = code ? (titre ? `${titre} (${code})` : code) : "—";
      nsfSel.appendChild(opt);
      nsfSel.value = code || "";
    }

    _setChecked("orgCtrNsfOblig", detail?.nsf_groupe_obligatoire);

    _selectByStoredValue("orgCtrMobilite", detail?.mobilite);

    _selectByStoredValue("orgCtrRisquePhys", detail?.risque_physique);
    const rSel = byId("orgCtrRisquePhys");
    if (rSel && typeof rSel._sbRefreshHelp === "function") rSel._sbRefreshHelp();

    _selectByStoredValue("orgCtrPerspEvol", detail?.perspectives_evolution);

    _selectByStoredValue("orgCtrNivContrainte", detail?.niveau_contrainte);
    const nSel = byId("orgCtrNivContrainte");
    if (nSel && typeof nSel._sbRefreshHelp === "function") nSel._sbRefreshHelp();

    _setValue("orgCtrDetailContrainte", detail?.detail_contrainte);

  }

    function _nivLabel(niv){
    const n = (niv || "").toString().trim().toUpperCase();
    if (n === "A") return "A - Initial";
    if (n === "B") return "B - Avancé";
    if (n === "C") return "C - Expert";
    return n || "";
  }

  function _nivClass(niv){
    const n = (niv || "").toString().trim().toUpperCase();
    if (n === "A") return "sb-badge-niv-a";
    if (n === "B") return "sb-badge-niv-b";
    if (n === "C") return "sb-badge-niv-c";
    return "";
  }

  function fillPosteCompetencesTab(detail){
    const tbody = byId("orgPosteCompTbody");
    const empty = byId("orgPosteCompEmpty");
    if (!tbody || !empty) return;

    const list = Array.isArray(detail?.competences) ? detail.competences : [];

    tbody.innerHTML = "";
    if (!list.length){
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";

    list.forEach(it => {
      const code = (it?.code || "").toString().trim();
      const title = (it?.intitule || "").toString().trim();
      const desc = (it?.description || "").toString().trim();
      const etat = (it?.etat || "").toString().trim().toLowerCase();
      const niv = (it?.niveau_requis || "").toString().trim().toUpperCase();

      const crit = it?.poids_criticite;
      const critTxt = (crit === null || crit === undefined || crit === "") ? "-" : escapeHtml(String(crit));

      const nivLbl = _nivLabel(niv);
      const nivCell = (!nivLbl) ? "-" : `<span class="sb-badge sb-badge-niv ${_nivClass(niv)}">${escapeHtml(nivLbl)}</span>`;

      const ind = (etat === "à valider" || etat === "a valider")
        ? `<span class="sb-dot-avalider" title="Compétence à valider"></span>`
        : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${code ? `<span class="sb-badge sb-badge-comp-code">${escapeHtml(code)}</span>` : "-"}</td>
        <td title="${escapeHtml(desc)}">${escapeHtml(title || "—")}</td>
        <td>${nivCell}</td>
        <td class="col-center">${critTxt}</td>
        <td class="col-center">${ind}</td>
      `;
      tbody.appendChild(tr);
    });
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
      return a.includes(q) || b.includes(q);
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
      applyPosteFilter();
      return;
    }

    const resp = await portal.apiJson(
      `${portal.apiBase}/skills/organisation/postes/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(id_service)}`
    );

    const postes = Array.isArray(resp.postes) ? resp.postes : [];
    _postesCache.set(id_service, postes);
    _currentPostes = postes;
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
    }
  };
})();
