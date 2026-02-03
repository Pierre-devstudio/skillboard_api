/* ======================================================
   portal_common.js (version "définitive" et robuste)
   - Gestion menu / vues (HTML par menu)
   - Chargement automatique du JS du menu si présent
   - API helper + alert + topbar + sidebar mobile
   - Compat PortalCommon (pour skills_portal.js existant)
   ====================================================== */

(function () {
  const DEFAULT_API_BASE =
    window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  // On merge pour ne pas exploser si tu as déjà un objet portal quelque part
  const portal = window.portal || {};

  // -----------------------------
  // Helpers DOM / URL
  // -----------------------------
  function getQueryParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function ensureViewsMount() {
    // On veut un endroit dédié pour injecter les sections de menus
    // Priorité: #viewsMount, sinon on le crée dans .content
    let mount = byId("viewsMount");
    if (mount) return mount;

    const content =
      document.querySelector(".content") ||
      document.querySelector("main") ||
      document.body;

    mount = document.createElement("div");
    mount.id = "viewsMount";

    // Si alertContainer existe, on insère juste après (sinon fin)
    const alert = byId("alertContainer");
    if (alert && alert.parentElement === content) {
      content.insertBefore(mount, alert.nextSibling);
    } else {
      content.appendChild(mount);
    }
    return mount;
  }

  function showAlert(type, message) {
    const container = byId("alertContainer");
    if (!container) return;

    if (!message) {
      container.innerHTML = "";
      return;
    }

    const safeType = type === "error" || type === "success" ? type : "";
    container.innerHTML = `<div class="alert ${safeType}">${message}</div>`;
  }

  function setTopbar(name, info) {
    const n = byId("topbarName");
    const i = byId("topbarInfo");
    if (n) n.textContent = name || "";
    if (i) i.textContent = info || "";
  }

  // -----------------------------
  // API helper
  // -----------------------------
  async function apiJson(url, options) {
    const opts = options ? Object.assign({}, options) : {};
    const headers = new Headers(opts.headers || {});

    // 1) JWT Supabase (si session active)
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session && session.access_token ? String(session.access_token) : "";
        if (token && !headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
      }
    } catch (_) {
      // Pas de session / supabase pas initialisé: on laisse vivre le legacy
    }

    // 2) Contexte entreprise (super admin) - stocké côté front
    try {
      const entId = localStorage.getItem("sb_skills_active_ent") || "";
      if (entId && !headers.has("X-Ent-Id")) {
        headers.set("X-Ent-Id", entId);
      }
    } catch (_) {}

    opts.headers = headers;

    const resp = await fetch(url, opts);
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const body = ct.includes("application/json") ? await resp.json() : await resp.text();

    if (!resp.ok) {
      const detail =
        typeof body === "string"
          ? body
          : (body && (body.detail || body.message)) || JSON.stringify(body);
      throw new Error(detail || `HTTP ${resp.status}`);
    }
    return body;
  }


  // -----------------------------
  // Chargement JS "once"
  // -----------------------------
  const _loadedScripts = new Set();

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (!src) return resolve();
      if (_loadedScripts.has(src)) return resolve();

      const s = document.createElement("script");
      s.src = src;
      s.async = true;

      s.onload = () => {
        _loadedScripts.add(src);
        resolve();
      };
      s.onerror = () => {
        reject(new Error(`Script introuvable ou non chargé: ${src}`));
      };

      document.head.appendChild(s);
    });
  }

  // -----------------------------
  // Menus
  // -----------------------------
  portal.apiBase = portal.apiBase || DEFAULT_API_BASE;
  portal.contactId = portal.contactId || null;
  portal.context = portal.context || null;

  portal.menus = portal.menus || new Map(); // view -> { view, htmlUrl, jsUrl?, onShow? }
  const _loadedViews = new Set(); // viewName déjà injectée

  portal.registerMenu = function registerMenu(menu) {
    if (!menu || !menu.view) return;

    const m = Object.assign({}, menu);

    // Si jsUrl pas fourni, on tente un auto-guess (sans l’imposer).
    // Exemple: /menus/skills_organisation.html -> /menus/skills_organisation.js
    if (!m.jsUrl && m.htmlUrl && m.htmlUrl.endsWith(".html")) {
      m.jsUrl = m.htmlUrl.slice(0, -5) + ".js";
      m._jsGuessed = true; // juste pour debug interne
    }

    portal.menus.set(m.view, m);
  };

  // -----------------------------
  // Sidebar mobile
  // -----------------------------
  function openSidebarMobile() {
    const sidebar = byId("sidebar");
    const backdrop = byId("backdrop");
    if (sidebar) sidebar.classList.add("open");
    if (backdrop) backdrop.classList.add("show");
  }

  function closeSidebarMobile() {
    const sidebar = byId("sidebar");
    const backdrop = byId("backdrop");
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("show");
  }

  portal.openSidebarMobile = openSidebarMobile;
  portal.closeSidebarMobile = closeSidebarMobile;

  // -----------------------------
  // View switching
  // -----------------------------
  async function injectMenuHtml(viewName, htmlUrl) {
    if (!htmlUrl) return;

    const mount = ensureViewsMount();
    const resp = await fetch(htmlUrl);
    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(`Impossible de charger la vue (${resp.status}) : ${htmlUrl}`);
    }

    // On injecte tel quel (ton menu doit fournir une <section id="view-xxx">)
    const tmp = document.createElement("div");
    tmp.innerHTML = text;

    // Si la section attendue n’existe pas, on wrap (ça évite le “rien ne s’affiche”)
    const expectedId = `view-${viewName}`;
    const expected = tmp.querySelector(`#${CSS.escape(expectedId)}`);

    if (!expected) {
      const wrap = document.createElement("section");
      wrap.id = expectedId;
      wrap.style.display = "none";
      while (tmp.firstChild) wrap.appendChild(tmp.firstChild);
      mount.appendChild(wrap);
    } else {
      // On append tous les enfants du tmp
      while (tmp.firstChild) {
        mount.appendChild(tmp.firstChild);
      }
    }
  }

  function setActiveMenuItem(viewName) {
    document.querySelectorAll(".menu-item").forEach((item) => {
      const v = item.getAttribute("data-view");
      item.classList.toggle("active", v === viewName);
    });
  }

  function showOnlySection(viewName) {
    const mount = ensureViewsMount();
    const expectedId = `view-${viewName}`;

    // On masque toutes les sections de menus
    mount.querySelectorAll("section[id^='view-']").forEach((sec) => {
      sec.style.display = sec.id === expectedId ? "block" : "none";
    });
  }

  portal.switchView = async function switchView(viewName) {
    const menu = portal.menus.get(viewName);

    if (!menu) {
      showAlert("error", `Menu introuvable: ${viewName}`);
      return;
    }

    try {
      showAlert("", "");

      // 1) Charger/injecter le HTML une seule fois
      if (!_loadedViews.has(viewName)) {
        await injectMenuHtml(viewName, menu.htmlUrl);
        _loadedViews.add(viewName);
      }

      // 2) Afficher la section
      showOnlySection(viewName);
      setActiveMenuItem(viewName);

      // 3) Charger le JS du menu (si dispo)
      if (menu.jsUrl) {
        try {
          await loadScriptOnce(menu.jsUrl);
        } catch (e) {
          console.warn(e.message);
        }
      }

      // 4) Appeler onShow (si fourni)
      if (typeof menu.onShow === "function") {
        await menu.onShow(portal);
      }

      closeSidebarMobile();
    } catch (e) {
      showAlert("error", `Erreur affichage "${viewName}" : ${e.message}`);
      console.error(e);
      closeSidebarMobile();
    }
  };

  // -----------------------------
  // Init (wiring)
  // -----------------------------
  portal.init = function init() {
    portal.contactId = getQueryParam("id");

    if (!portal.contactId) {
      const loginUrl = (window.PORTAL_LOGIN_URL || "").toString().trim();
      const msg = loginUrl
        ? `Identifiant manquant dans l’URL. <a href="${loginUrl}">Se connecter</a>`
        : "Identifiant manquant dans l’URL. Le lien utilisé n’est pas valide.";

      showAlert("error", msg);
      return;
    }

    // Hamburger + backdrop
    const btnMenu = byId("btnMenuToggle");
    const backdrop = byId("backdrop");

    if (btnMenu) {
      btnMenu.addEventListener("click", () => {
        const sidebar = byId("sidebar");
        if (sidebar && sidebar.classList.contains("open")) closeSidebarMobile();
        else openSidebarMobile();
      });
    }

    if (backdrop) {
      backdrop.addEventListener("click", () => closeSidebarMobile());
    }

    // Menu click
    document.querySelectorAll(".menu-item").forEach((item) => {
      if (item.classList.contains("disabled")) return;

      item.addEventListener("click", () => {
        const view = item.getAttribute("data-view");
        portal.switchView(view);
      });
    });

    // Vue par défaut: item déjà "active" sinon "dashboard" sinon premier menu
    const active = document.querySelector(".menu-item.active");
    let defaultView = active ? active.getAttribute("data-view") : null;

    if (!defaultView && portal.menus.has("dashboard")) defaultView = "dashboard";

    if (!defaultView) {
      const first = document.querySelector(".menu-item:not(.disabled)");
      defaultView = first ? first.getAttribute("data-view") : null;
    }

    if (defaultView) {
      portal.switchView(defaultView);
    }
  };

    // ======================================================
  // SERVICES (filtre service) — point unique de gestion
  // - Source: GET /skills/organisation/services/{id_contact}
  // - Objectif: plus aucun menu ne 'réinvente' le select service
  // - Ordre: Tous les services -> services -> Non lié
  // ======================================================

  const SERVICE_ALL_ID = "__ALL__";
  const SERVICE_NON_LIE_ID = "__NON_LIE__";

  function _normServiceId(raw) {
    const s = (raw ?? "").toString().trim();
    if (!s) return SERVICE_ALL_ID;
    if (s === "__TOUS__") return SERVICE_ALL_ID; // legacy toléré
    if (s === SERVICE_ALL_ID) return SERVICE_ALL_ID;
    if (s === SERVICE_NON_LIE_ID) return SERVICE_NON_LIE_ID;
    return s;
  }

  function _isAllService(id) {
    return _normServiceId(id) === SERVICE_ALL_ID;
  }

  function _toQueryServiceId(id) {
    const n = _normServiceId(id);
    return n === SERVICE_ALL_ID ? null : n;
  }

  function _flattenServicesTree(nodes) {
    const out = [];

    function walk(list, depth) {
      (Array.isArray(list) ? list : []).forEach(n => {
        if (!n) return;
        const id = _normServiceId(n.id_service);
        const label = (n.nom_service ?? id).toString().trim();

        out.push({
          id_service: id,
          nom_service: label,
          depth: depth || 0
        });

        if (Array.isArray(n.children) && n.children.length) {
          walk(n.children, (depth || 0) + 1);
        }
      });
    }

    walk(nodes, 0);
    return out;
  }

  function _fillServiceSelect(selectId, flat, opts) {
    const sel = typeof selectId === "string" ? byId(selectId) : selectId;
    if (!sel) return;

    const options = opts || {};
    const includeAll = options.includeAll !== false;
    const includeNonLie = options.includeNonLie !== false;
    const allowIndent = options.allowIndent !== false;

    const labelAll = options.labelAll || "Tous les services";
    const labelNonLie = options.labelNonLie || "Non lié";

    const storageKey = options.storageKey || null;
    const preferId = _normServiceId(
      sel.value ||
      (storageKey ? localStorage.getItem(storageKey) : "") ||
      SERVICE_ALL_ID
    );

    // Dédoublonnage + séparation ALL / NON_LIE / services
    let allItem = null;
    let nonItem = null;
    const services = [];
    const seen = new Set();

    (Array.isArray(flat) ? flat : []).forEach(x => {
      if (!x) return;

      const id = _normServiceId(x.id_service);
      const name = (x.nom_service ?? id).toString().trim();
      const depth = Number.isFinite(x.depth) ? x.depth : 0;

      // garde-fou anti-“Tous les services” injecté côté métier
      if (id !== SERVICE_ALL_ID && name.toLowerCase() === "tous les services") return;
      if (id !== SERVICE_NON_LIE_ID && name.toLowerCase() === "non lié") {
        // on laisse passer s'il est vraiment "non lié" métier, sinon on s'aligne sur l'id spécial
      }

      if (id === SERVICE_ALL_ID) {
        if (!allItem) allItem = { id_service: SERVICE_ALL_ID, nom_service: labelAll, depth: 0 };
        return;
      }

      if (id === SERVICE_NON_LIE_ID) {
        if (!nonItem) nonItem = { id_service: SERVICE_NON_LIE_ID, nom_service: labelNonLie, depth: 0 };
        return;
      }

      if (seen.has(id)) return;
      seen.add(id);

      services.push({ id_service: id, nom_service: name, depth });
    });

    if (!allItem) allItem = { id_service: SERVICE_ALL_ID, nom_service: labelAll, depth: 0 };
    if (!nonItem) nonItem = { id_service: SERVICE_NON_LIE_ID, nom_service: labelNonLie, depth: 0 };

    sel.innerHTML = "";

    function addOpt(item) {
      const opt = document.createElement("option");
      opt.value = item.id_service;
      const depth = Math.min(6, item.depth || 0);
      const indent = allowIndent && depth > 0 ? "\u00A0\u00A0".repeat(depth) : ""; // NBSP
      const marker = allowIndent && depth > 0 ? "› " : "";
      const prefix = indent + marker;

      opt.textContent = prefix + item.nom_service;
      sel.appendChild(opt);
    }

    if (includeAll) addOpt(allItem);
    services.forEach(addOpt);
    if (includeNonLie) addOpt(nonItem);

    // restore selection
    const ids = Array.from(sel.options).map(o => o.value);
    if (ids.includes(preferId)) sel.value = preferId;
    else if (includeAll) sel.value = SERVICE_ALL_ID;
    else sel.value = ids[0] || "";

    // persist selection
    if (storageKey) {
      localStorage.setItem(storageKey, _normServiceId(sel.value));
      sel.addEventListener("change", () => {
        localStorage.setItem(storageKey, _normServiceId(sel.value));
      });
    }
  }

  async function _populateServiceSelect(params) {
    const portalRef = params?.portal || portal;
    const contactId = params?.contactId || portalRef?.contactId;
    const selectId = params?.selectId;

    if (!portalRef || !contactId || !selectId) return;

    const nodes = await portalRef.apiJson(
      `${portalRef.apiBase}/skills/organisation/services/${encodeURIComponent(contactId)}`
    );

    const flat = _flattenServicesTree(Array.isArray(nodes) ? nodes : []);
    _fillServiceSelect(selectId, flat, params);
  }

  portal.serviceFilter = {
    ALL_ID: SERVICE_ALL_ID,
    NON_LIE_ID: SERVICE_NON_LIE_ID,
    normalizeId: _normServiceId,
    isAll: _isAllService,
    toQueryId: _toQueryServiceId,
    flattenTree: _flattenServicesTree,
    fillSelect: _fillServiceSelect,
    populateSelect: _populateServiceSelect
  };


  // Expose helpers (pratique dans les menus)
  portal.getQueryParam = getQueryParam;
  portal.showAlert = showAlert;
  portal.setTopbar = setTopbar;
  portal.apiJson = apiJson;

  // ======================================================
  // COMPAT "PortalCommon" (ancien contrat)
  // - ton skills_portal.js attend PortalCommon.createPortal(...)
  // - et/ou PortalCommon.registerMenu(...)
  // ======================================================
  portal.createPortal = portal.createPortal || function createPortal(cfg) {
    // cfg peut contenir { apiBase: "..." } (on accepte, on n'impose rien)
    try {
      if (cfg && cfg.apiBase) portal.apiBase = cfg.apiBase;
    } catch (_) { /* no-op */ }
    return portal;
  };

  window.portal = portal;
  window.PortalCommon = portal;

  // Auto-init (si DOM prêt)
  window.addEventListener("DOMContentLoaded", () => {
    // Si tu veux désactiver l’auto-init: window.PORTAL_NO_AUTOINIT = true
    if (window.PORTAL_NO_AUTOINIT) return;
    portal.init();
  });
})();
