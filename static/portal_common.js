/* ======================================================
   portal_common.js (version "définitive" et robuste)
   - Gestion menu / vues (HTML par menu)
   - Chargement automatique du JS du menu si présent
   - API helper + alert + topbar + sidebar mobile
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
    const resp = await fetch(url, options || {});
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
      // Important: on ne casse pas tout si le fichier n’existe pas,
      // mais si onShow dépend d’un global, tu verras l’erreur clairement.
      if (menu.jsUrl) {
        try {
          await loadScriptOnce(menu.jsUrl);
        } catch (e) {
          // Soft warning (utile en dev si un menu n’a pas de JS)
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
      showAlert(
        "error",
        "Identifiant manquant dans l’URL. Le lien utilisé n’est pas valide."
      );
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
        // pas de await ici: on fire-and-forget, mais avec gestion d’erreur interne
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

  // Expose helpers (pratique dans les menus)
  portal.getQueryParam = getQueryParam;
  portal.showAlert = showAlert;
  portal.setTopbar = setTopbar;
  portal.apiJson = apiJson;

  window.portal = portal;

  // Auto-init (si DOM prêt)
  window.addEventListener("DOMContentLoaded", () => {
    // Si tu veux désactiver l’auto-init un jour: window.PORTAL_NO_AUTOINIT = true
    if (window.PORTAL_NO_AUTOINIT) return;
    portal.init();
  });
})();
