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
      const details = document.createElement("details");
      details.className = "sb-accordion";

      const badgeEff = `<span class="sb-badge">${escapeHtml((p.nb_effectifs ?? 0).toString())} collab.</span>`;
      const badgeResp = p.isresponsable ? `<span class="sb-badge sb-badge-accent">Responsable</span>` : "";

      const code = (p.codif_poste || "").trim();
      const title = (p.intitule_poste || "").trim();

      details.innerHTML = `
        <summary>
          <div class="sb-acc-left">
            <div class="sb-acc-title">${escapeHtml(title || "Poste")}</div>
            <div class="sb-acc-sub">${escapeHtml(code)}</div>
          </div>
          <div class="sb-acc-right">
            ${badgeEff}
            ${badgeResp}
          </div>
        </summary>
        <div class="sb-acc-body">
          ${p.mission_principale ? `<div class="sb-field"><div class="label">Mission principale</div><div class="value">${escapeHtml(p.mission_principale)}</div></div>` : ""}
          ${(p.responsabilites_html || p.responsabilites) ? `
            <div class="sb-field text-block">
              <div class="label">Responsabilités</div>
              <div class="value sb-richtext">
                ${p.responsabilites_html ? p.responsabilites_html : escapeHtml(p.responsabilites)}
              </div>
            </div>
          ` : ""}
          ${p.mobilite ? `<div class="sb-field"><div class="label">Mobilité</div><div class="value">${escapeHtml(p.mobilite)}</div></div>` : ""}
          ${p.niveau_contrainte ? `<div class="sb-field"><div class="label">Niveau contrainte</div><div class="value">${escapeHtml(p.niveau_contrainte)}</div></div>` : ""}
          ${p.detail_contrainte ? `<div class="sb-field"><div class="label">Détail contrainte</div><div class="value">${escapeHtml(p.detail_contrainte)}</div></div>` : ""}
          ${p.perspectives_evolution ? `<div class="sb-field"><div class="label">Perspectives</div><div class="value">${escapeHtml(p.perspectives_evolution)}</div></div>` : ""}
          ${p.niveau_education_minimum ? `<div class="sb-field"><div class="label">Niveau requis</div><div class="value">${escapeHtml(p.niveau_education_minimum)}</div></div>` : ""}
          ${p.risque_physique ? `<div class="sb-field"><div class="label">Risque physique</div><div class="value">${escapeHtml(p.risque_physique)}</div></div>` : ""}
          ${(!p.mission_principale && !p.responsabilites && !p.mobilite && !p.niveau_contrainte && !p.detail_contrainte && !p.perspectives_evolution && !p.niveau_education_minimum && !p.risque_physique)
            ? `<div class="card-sub" style="margin:0;">Aucune description renseignée.</div>` : ""
          }
        </div>
      `;

      container.appendChild(details);
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

      try {
        bindOnce(portal);        
        if (!_servicesLoaded) await loadServices(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur organisation : " + e.message);
      }
    }
  };
})();
