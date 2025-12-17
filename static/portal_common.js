(function () {
  function createPortal(cfg) {
    const portal = {
      apiBase: cfg.apiBase,
      queryIdParam: cfg.queryIdParam || "id",
      topbarInfoText: cfg.topbarInfoText || "",
      contactId: null,
      context: null,
      menus: {},

      getQueryParam(name) {
        const url = new URL(window.location.href);
        return url.searchParams.get(name);
      },

      showAlert(type, message) {
        const container = document.getElementById("alertContainer");
        if (!container) return;
        if (!message) { container.innerHTML = ""; return; }
        container.innerHTML = `<div class="alert ${type}">${message}</div>`;
      },

      async apiJson(url, options) {
        const resp = await fetch(url, options || {});
        const ct = resp.headers.get("content-type") || "";
        const body = ct.includes("application/json") ? await resp.json() : await resp.text();
        if (!resp.ok) {
          const detail = (typeof body === "string") ? body : (body.detail || JSON.stringify(body));
          throw new Error(detail);
        }
        return body;
      },

      setTopbar(leftText, rightText) {
        const nameEl = document.getElementById("topbarName");
        const infoEl = document.getElementById("topbarInfo");
        if (nameEl) nameEl.textContent = leftText || "";
        if (infoEl) infoEl.textContent = rightText || "";
      },

      openSidebarMobile() {
        document.getElementById("sidebar")?.classList.add("open");
        document.getElementById("backdrop")?.classList.add("show");
      },

      closeSidebarMobile() {
        document.getElementById("sidebar")?.classList.remove("open");
        document.getElementById("backdrop")?.classList.remove("show");
      },

      registerMenu(def) {
        this.menus[def.view] = def;
      },

      async ensureViewLoaded(viewName) {
        const container = document.getElementById("viewsContainer");
        if (!container) return;

        const secId = `view-${viewName}`;
        let sec = document.getElementById(secId);
        if (sec) return;

        const def = this.menus[viewName];
        if (!def) {
          // fallback placeholder
          sec = document.createElement("section");
          sec.id = secId;
          sec.innerHTML = `
            <div class="card">
              <div class="card-title">${viewName}</div>
              <div class="card-sub">Section non déclarée.</div>
            </div>`;
          container.appendChild(sec);
          return;
        }

        if (def.htmlUrl) {
          const html = await fetch(def.htmlUrl, { cache: "no-cache" }).then(r => r.text());
          const wrapper = document.createElement("div");
          wrapper.innerHTML = html;

          const section = wrapper.querySelector(`section#${secId}`) || wrapper.querySelector("section");
          if (!section) throw new Error(`HTML menu invalide (section manquante) : ${def.htmlUrl}`);

          container.appendChild(section);
          if (typeof def.onMount === "function") def.onMount(this);
          return;
        }

        // placeholder déclaré
        sec = document.createElement("section");
        sec.id = secId;
        sec.innerHTML = `
          <div class="card">
            <div class="card-title">${def.placeholderTitle || def.label || "À venir"}</div>
            <div class="card-sub">${def.placeholderSub || "Page à venir."}</div>
          </div>`;
        container.appendChild(sec);
      },

      async switchView(viewName) {
        await this.ensureViewLoaded(viewName);

        // Hide/Show sections
        document.querySelectorAll("#viewsContainer section[id^='view-']").forEach(sec => {
          sec.style.display = (sec.id === `view-${viewName}`) ? "block" : "none";
        });

        // Active menu item
        document.querySelectorAll(".menu-item").forEach(item => {
          const v = item.getAttribute("data-view");
          item.classList.toggle("active", v === viewName);
        });

        const def = this.menus[viewName];
        if (def && typeof def.onShow === "function") {
          await def.onShow(this);
        }

        this.closeSidebarMobile();
      },

      initShell() {
        const id = this.getQueryParam(this.queryIdParam);
        if (!id) {
          this.showAlert("error", "Identifiant manquant dans l’URL. Le lien utilisé n’est pas valide.");
          return false;
        }
        this.contactId = id;

        // Menu click
        document.querySelectorAll(".menu-item").forEach(item => {
          if (item.classList.contains("disabled")) return;
          item.addEventListener("click", () => {
            const view = item.getAttribute("data-view");
            this.switchView(view);
          });
        });

        // Hamburger + backdrop
        const btnMenu = document.getElementById("btnMenuToggle");
        const backdrop = document.getElementById("backdrop");
        btnMenu?.addEventListener("click", () => {
          const sidebar = document.getElementById("sidebar");
          if (sidebar?.classList.contains("open")) this.closeSidebarMobile();
          else this.openSidebarMobile();
        });
        backdrop?.addEventListener("click", () => this.closeSidebarMobile());

        return true;
      },
    };

    return portal;
  }

  window.PortalCommon = { createPortal };
})();
