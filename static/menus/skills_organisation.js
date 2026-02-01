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

    // Détail (fetch)
    try {
      if (!id_poste) return;
      const detail = await fetchPosteDetail(portal, id_poste);
      fillPosteDefinitionTab(detail);
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
