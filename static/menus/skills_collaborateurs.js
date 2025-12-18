/* ======================================================
   static/menus/skills_collaborateurs.js
   - Menu "Vos collaborateurs"
   - Filtres (service, recherche, toggles)
   - KPI dynamiques selon le service
   - Liste cliquable (modal squelette)
   ====================================================== */

(function () {
  if (!window.portal) return;

  const API_BASE = window.portal.apiBase || "https://skillboard-services.onrender.com";

  const SERVICE_NON_LIE = "__NON_LIE__";
  const VIEW_NAME = "vos-collaborateurs";

  let _handlersBound = false;
  let _searchTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return (s ?? "")
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setText(id, value, fallback = "–") {
    const el = byId(id);
    if (!el) return;
    el.textContent = value != null && value !== "" ? value : fallback;
  }

  function formatDateFR(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "–";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function getFilters() {
    const id_service = byId("collabServiceSelect")?.value || "";
    const q = (byId("collabSearch")?.value || "").trim();

    const only_actifs = !!byId("collabOnlyActifs")?.checked;
    const include_archived = !!byId("collabIncludeArchived")?.checked;

    const only_manager = !!byId("collabOnlyManagers")?.checked;
    const only_formateur = !!byId("collabOnlyFormateurs")?.checked;
    const only_temp = !!byId("collabOnlyTemp")?.checked;

    return {
      id_service: id_service || null,
      q: q || null,
      only_actifs,
      include_archived,
      only_manager,
      only_formateur,
      only_temp,
      limit: 200,
      offset: 0
    };
  }

  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === null || v === undefined) return;
      usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }

  async function loadServices(id_contact) {
    const url = `${API_BASE}/skills/collaborateurs/services/${encodeURIComponent(id_contact)}`;
    return await window.portal.apiJson(url);
  }

  async function loadKpis(id_contact, id_service) {
    const qs = buildQuery({ id_service: id_service || null });
    const url = `${API_BASE}/skills/collaborateurs/kpis/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  async function loadList(id_contact, filters) {
    const qs = buildQuery(filters);
    const url = `${API_BASE}/skills/collaborateurs/list/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  function renderServicesSelect(items) {
    const sel = byId("collabServiceSelect");
    if (!sel) return;

    const current = sel.value || "";

    sel.innerHTML = `<option value="">Tous les services</option>`;

    (items || []).forEach(s => {
      if (!s || !s.id_service) return;
      const opt = document.createElement("option");
      opt.value = s.id_service;
      opt.textContent = s.nom_service || s.id_service;
      sel.appendChild(opt);
    });

    // restore selection if possible
    if (current) sel.value = current;
  }

  function renderKpis(k) {
    setText("kpiTotal", k?.total ?? 0);
    setText("kpiActifs", k?.actifs ?? 0);
    setText("kpiSorties", k?.sorties_prevues ?? 0);
    setText("kpiManagers", k?.managers ?? 0);
    setText("kpiFormateurs", k?.formateurs ?? 0);
    setText("kpiNonLies", k?.non_lies_service ?? 0);
  }

  function updateKpiScopeLabel() {
    const sel = byId("collabServiceSelect");
    const el = byId("collabKpiScope");
    if (!sel || !el) return;

    const v = sel.value || "";
    if (!v) {
      el.textContent = "Périmètre : entreprise";
      return;
    }

    if (v === SERVICE_NON_LIE) {
      el.textContent = "Périmètre : non liés (sans service)";
      return;
    }

    const label = sel.options[sel.selectedIndex]?.textContent || "service";
    el.textContent = `Périmètre : ${label}`;
  }

  function renderList(items) {
    const body = byId("tblCollaborateursBody");
    const empty = byId("collabEmpty");
    const count = byId("collabCount");
    if (!body || !empty) return;

    body.innerHTML = "";

    const list = Array.isArray(items) ? items : [];

    if (count) {
      count.textContent = `${list.length} collaborateur(s)`;
    }

    if (list.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    list.forEach(it => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";

      const fullName = `${it.prenom_effectif || ""} ${(it.nom_effectif || "").toUpperCase()}`.trim();

      const statutParts = [];
      if (it.archive) statutParts.push("Archivé");
      else if (it.statut_actif) statutParts.push("Actif");
      else statutParts.push("Inactif");

      if (it.is_temp) statutParts.push("Temp");
      if (it.ismanager) statutParts.push("Manager");
      if (it.isformateur) statutParts.push("Formateur");

      const statut = statutParts.join(" · ");

      const tdNom = document.createElement("td");
      tdNom.textContent = fullName || "–";
      tr.appendChild(tdNom);

      const tdService = document.createElement("td");
      tdService.textContent = it.nom_service || (it.id_service ? it.id_service : "Non lié");
      tr.appendChild(tdService);

      const tdPoste = document.createElement("td");
      tdPoste.textContent = it.intitule_poste || "–";
      tr.appendChild(tdPoste);

      const tdStatut = document.createElement("td");
      tdStatut.textContent = statut || "–";
      tr.appendChild(tdStatut);

      const tdEntree = document.createElement("td");
      tdEntree.textContent = formatDateFR(it.date_entree_entreprise_effectif);
      tr.appendChild(tdEntree);

      const tdSortie = document.createElement("td");
      tdSortie.textContent = formatDateFR(it.date_sortie_prevue);
      tr.appendChild(tdSortie);

      const tdContact = document.createElement("td");
      const mail = (it.email_effectif || "").trim();
      const tel = (it.telephone_effectif || "").trim();

      const parts = [];
      if (mail) parts.push(`📧 ${mail}`);
      if (tel) parts.push(`📞 ${tel}`);
      tdContact.textContent = parts.length ? parts.join("  ") : "–";
      tr.appendChild(tdContact);

      tr.addEventListener("click", () => openCollaborateurModal(it));

      body.appendChild(tr);
    });
  }

  function openCollaborateurModal(it) {
    const modal = byId("modalCollaborateur");
    const title = byId("collabModalTitle");
    const sub = byId("collabModalSub");
    const body = byId("collabModalBody");

    if (title) title.textContent = `${it.prenom_effectif || ""} ${it.nom_effectif || ""}`.trim() || "Collaborateur";
    if (sub) sub.textContent = "Détail collaborateur (lecture/édition à venir).";

    if (body) {
      body.innerHTML = `
        <div class="row" style="flex-direction:column; gap:10px;">
          <div class="sb-field">
            <div class="label">Service</div>
            <div class="value">${escapeHtml(it.nom_service || (it.id_service ? it.id_service : "Non lié"))}</div>
          </div>
          <div class="sb-field">
            <div class="label">Poste</div>
            <div class="value">${escapeHtml(it.intitule_poste || "–")}</div>
          </div>
          <div class="sb-field">
            <div class="label">Email</div>
            <div class="value">${escapeHtml(it.email_effectif || "–")}</div>
          </div>
          <div class="sb-field">
            <div class="label">Téléphone</div>
            <div class="value">${escapeHtml(it.telephone_effectif || "–")}</div>
          </div>
        </div>
      `;
    }

    if (modal) {
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeCollaborateurModal() {
    const modal = byId("modalCollaborateur");
    if (modal) {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function refreshAll(id_contact) {
    if (!id_contact) return;

    try {
      window.portal.showAlert("", "");

      const filters = getFilters();

      updateKpiScopeLabel();

      // KPIs filtrés uniquement sur service (le reste c’est des filtres “liste”)
      const kpis = await loadKpis(id_contact, filters.id_service);
      renderKpis(kpis);

      const items = await loadList(id_contact, filters);
      renderList(items);

    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement collaborateurs : " + e.message);
      console.error(e);
    }
  }

  async function initMenu(portalCtx) {
    const id_contact = portalCtx?.contactId || window.portal.contactId;
    if (!id_contact) return;

    // Bind handlers une seule fois
    if (!_handlersBound) {
      _handlersBound = true;

      const selService = byId("collabServiceSelect");
      const inputSearch = byId("collabSearch");

      const chkActifs = byId("collabOnlyActifs");
      const chkArchived = byId("collabIncludeArchived");
      const chkManagers = byId("collabOnlyManagers");
      const chkFormateurs = byId("collabOnlyFormateurs");
      const chkTemp = byId("collabOnlyTemp");

      const btnReset = byId("btnCollabReset");

      if (selService) {
        selService.addEventListener("change", () => {
          refreshAll(id_contact);
        });
      }

      if (inputSearch) {
        inputSearch.addEventListener("input", () => {
          clearTimeout(_searchTimer);
          _searchTimer = setTimeout(() => refreshAll(id_contact), 250);
        });
      }

      const onToggle = () => refreshAll(id_contact);

      if (chkActifs) chkActifs.addEventListener("change", onToggle);
      if (chkArchived) chkArchived.addEventListener("change", onToggle);
      if (chkManagers) chkManagers.addEventListener("change", onToggle);
      if (chkFormateurs) chkFormateurs.addEventListener("change", onToggle);
      if (chkTemp) chkTemp.addEventListener("change", onToggle);

      if (btnReset) {
        btnReset.addEventListener("click", () => {
          if (selService) selService.value = "";
          if (inputSearch) inputSearch.value = "";
          if (chkActifs) chkActifs.checked = true;
          if (chkArchived) chkArchived.checked = false;
          if (chkManagers) chkManagers.checked = false;
          if (chkFormateurs) chkFormateurs.checked = false;
          if (chkTemp) chkTemp.checked = false;

          refreshAll(id_contact);
        });
      }

      const btnClose = byId("btnCloseCollabModal");
      const btnClose2 = byId("btnCollabModalClose");
      const modal = byId("modalCollaborateur");

      if (btnClose) btnClose.addEventListener("click", () => closeCollaborateurModal());
      if (btnClose2) btnClose2.addEventListener("click", () => closeCollaborateurModal());
      if (modal) {
        modal.addEventListener("click", (e) => {
          if (e.target === modal) closeCollaborateurModal();
        });
      }
    }

    // Services (1 shot à chaque entrée sur le menu, c'est OK)
    try {
      const services = await loadServices(id_contact);
      renderServicesSelect(services);
    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement services : " + e.message);
    }

    // Premier refresh complet
    await refreshAll(id_contact);
  }

  // Expose function for portal.onShow (optional)
  window.skillsCollaborateurs = window.skillsCollaborateurs || {};
  window.skillsCollaborateurs.onShow = initMenu;
})();
