(function () {
  let _bound = false;
  let _ctx = null;
  let _items = [];
  let _globalItems = [];

  let _search = "";
  let _searchTimer = null;
  let _filterService = "__all__";
  let _filterPoste = "__all__";
  let _filterActive = "active";
  let _filterManager = false;
  let _filterFormateur = false;
  let _showArchived = false;

  let _modalMode = "create";
  let _editingId = null;
  let _tabLoaded = { skills: false, certs: false, history: false, rights: false };

  function byId(id){ return document.getElementById(id); }

  function esc(s){
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatPhoneFr(value){
    const digits = String(value || "").replace(/\D+/g, "").slice(0, 10);
    return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  }

  function bindPhoneMask(input){
    if (!input || input.dataset.phoneMaskBound === "1") return;
    input.dataset.phoneMaskBound = "1";

    const apply = () => { input.value = formatPhoneFr(input.value); };
    input.addEventListener("input", apply);
    input.addEventListener("blur", apply);
    input.addEventListener("paste", () => setTimeout(apply, 0));
  }

  function getErrorMessage(err){
    if (!err) return "Erreur inconnue.";
    if (typeof err === "string") return err;
    if (typeof err.message === "string" && err.message.trim()) return err.message;
    if (typeof err.detail === "string" && err.detail.trim()) return err.detail;
    if (err.detail && typeof err.detail === "object") {
      try {
        if (Array.isArray(err.detail)) return err.detail.map(x => x?.msg || JSON.stringify(x)).join(" | ");
        return JSON.stringify(err.detail);
      } catch (_) {}
    }
    try { return JSON.stringify(err); } catch (_) {}
    return String(err);
  }

  function formatDateFR(value){
    const s = String(value || "").trim();
    if (!s) return "–";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString("fr-FR");
  }

  function getConsoleDefs(){
    return Array.isArray(_ctx?.consoles) ? _ctx.consoles : [];
  }

  function getConsoleDef(consoleCode){
    const code = String(consoleCode || '').trim().toLowerCase();
    return getConsoleDefs().find(x => String(x?.console_code || '').trim().toLowerCase() === code) || null;
  }

  function getConsoleLabel(consoleCode){
    const def = getConsoleDef(consoleCode);
    if (def?.label) return String(def.label).trim();
    const code = String(consoleCode || '').trim().toLowerCase();
    if (code === 'studio') return 'Studio';
    if (code === 'insights') return 'Insights';
    if (code === 'people') return 'People';
    if (code === 'partner') return 'Partner';
    if (code === 'learn') return 'Learn';
    return code || 'Console';
  }

  function getRoleLabel(roleCode){
    const code = String(roleCode || '').trim().toLowerCase();
    if (code === 'admin') return 'Administrateur';
    if (code === 'editor') return 'Éditeur';
    if (code === 'user') return 'Utilisateur';
    return 'Aucun accès';
  }

  function getConsoleIconUrl(consoleCode){
    const def = getConsoleDef(consoleCode);
    const file = String(def?.icon_file || '').trim();
    if (!file) return '';
    return `/${file}`;
  }


  function renderConsoleIcons(accessSummary){
    const items = Array.isArray(accessSummary) ? accessSummary : [];
    if (!items.length) return '<span class="sb-console-dash">—</span>';

    return `
      <div class="sb-console-inline">
        ${items.map(it => {
          const label = getConsoleLabel(it?.console_code);
          const roleLabel = getRoleLabel(it?.role_code);
          const iconUrl = getConsoleIconUrl(it?.console_code);

          if (!iconUrl) return '';

          return `
            <span class="sb-console-chip" title="${esc(label)} - ${esc(roleLabel)}">
              <img
                src="${esc(iconUrl)}"
                alt="${esc(label)}"
                loading="lazy"
                onerror="this.style.display='none'; this.parentElement && this.parentElement.classList.add('sb-console-chip--muted');"
              />
            </span>
          `;
        }).join('')}
      </div>
    `;
  }

  function buildRightsPayload(){
    const payload = {};
    document.querySelectorAll('#collabRightsPanel [data-console-role]').forEach(sel => {
      const code = String(sel.getAttribute('data-console-role') || '').trim().toLowerCase();
      if (!code) return;
      payload[code] = String(sel.value || 'none').trim().toLowerCase();
    });
    return payload;
  }

  function getCurrentPosteForSkills(){
    const sel = byId('collabPoste');
    const id = (sel?.value || '').trim();
    const label = id && sel ? ((sel.options?.[sel.selectedIndex]?.textContent || '').trim()) : '';
    return { id, label };
  }

  async function syncCompetencesFromSelectedPoste(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const poste = getCurrentPosteForSkills();
    if (!poste.id) throw new Error("Sélectionnez un poste actuel.");

    const btn = byId('btnSyncCollabSkillsFromPoste');
    const previousText = btn ? btn.textContent : '';

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Import…';
    }

    try {
      const data = await portal.apiJson(
        `${portal.apiBase}/studio/collaborateurs/competences/sync-poste/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_poste_actuel: poste.id })
        }
      );

      _tabLoaded.skills = false;
      await loadTabIfNeeded(portal, 'skills');

      const inserted = Number(data?.inserted || 0);
      const skipped = Number(data?.skipped_existing || 0);
      const msg = inserted > 0
        ? `${inserted} compétence(s) ajoutée(s). ${skipped} déjà présente(s).`
        : `Aucune compétence ajoutée. ${skipped} déjà présente(s).`;

      if (portal.showAlert) portal.showAlert('success', msg);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = previousText || 'Importer les compétences du poste';
      }
    }
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function isEntrepriseMode(){
    return !!(_ctx && _ctx.source_kind === "entreprise");
  }

  function setStatus(msg){
    const el = byId("collabStatus");
    if (el) el.textContent = msg || "—";
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function fillSelect(el, items, valueKey, labelKey, firstValue, firstLabel){
    if (!el) return;
    let html = "";
    if (firstLabel !== undefined) {
      html += `<option value="${esc(firstValue || "")}">${esc(firstLabel || "")}</option>`;
    }
    (items || []).forEach(it => {
      html += `<option value="${esc(it?.[valueKey] || "")}">${esc(it?.[labelKey] || "")}</option>`;
    });
    el.innerHTML = html;
  }

  function renderTop(){
    const sub = byId("collabPageSub");
    if (sub) sub.textContent = "Enregistrez, gérez et archivez vos collaborateurs.";
  }

  function computeGlobalStats(items){
    const arr = Array.isArray(items) ? items : [];
    return {
      total: arr.length,
      actifs: arr.filter(x => !!x && !x.archive && !!x.actif).length,
      inactifs: arr.filter(x => !!x && !x.archive && !x.actif).length,
      archives: arr.filter(x => !!x && !!x.archive).length
    };
  }

  function renderStats(stats){
    byId("kpiTotalVal").textContent = String(stats?.total || 0);
    byId("kpiActifsVal").textContent = String(stats?.actifs || 0);
    byId("kpiInactifsVal").textContent = String(stats?.inactifs || 0);
    byId("kpiArchivesVal").textContent = String(stats?.archives || 0);
  }

  function renderFilters(){
    const serviceWrap = byId("collabServiceField");
    const posteWrap = byId("collabPosteField");

    if (serviceWrap) serviceWrap.style.display = "";
    if (posteWrap) posteWrap.style.display = "";

    fillSelect(byId("collabFilterService"), _ctx?.services || [], "id_service", "label", "__all__", "Tous les services");
    fillSelect(byId("collabFilterPoste"), _ctx?.postes || [], "id_poste", "label", "__all__", "Tous les postes");

    if (byId("collabFilterService")) byId("collabFilterService").value = _filterService;
    if (byId("collabFilterPoste")) byId("collabFilterPoste").value = _filterPoste;
    if (byId("collabFilterActive")) byId("collabFilterActive").value = _filterActive;
    if (byId("collabFilterManager")) byId("collabFilterManager").checked = !!_filterManager;
    if (byId("collabFilterFormateur")) byId("collabFilterFormateur").checked = !!_filterFormateur;
    if (byId("collabShowArchived")) byId("collabShowArchived").checked = !!_showArchived;
  }

  function hydrateFormSelects(){
    fillSelect(byId("collabCivilite"), [
      { value: "M.", label: "M." },
      { value: "Mme", label: "Mme" },
      { value: "Autre", label: "Autre" }
    ], "value", "label", "", "—");

    fillSelect(byId("collabService"), _ctx?.services || [], "id_service", "label", "", "Aucun service");
    fillSelect(byId("collabPoste"), _ctx?.postes || [], "id_poste", "label", "", "Aucun poste");

    fillSelect(byId("collabTypeContrat"), [
      { value: "", label: "—" },
      { value: "CDI", label: "CDI" },
      { value: "CDD", label: "CDD" },
      { value: "Alternance", label: "Alternance" },
      { value: "Intérim", label: "Intérim" },
      { value: "Stage", label: "Stage" },
      { value: "Freelance", label: "Freelance" },
      { value: "Autre", label: "Autre" }
    ], "value", "label");
  }

  function setSourceHint(){
    const hint = byId("collabModalSourceHint");
    if (!hint) return;
    hint.textContent = isEntrepriseMode()
      ? "Mode client : données collaborateur sécurisées sur l’entreprise owner."
      : "Mode mon entreprise : tbl_utilisateur + référentiel RH unifié via id_utilisateur = id_effectif.";
  }

  function refreshServiceFromPoste(){
    const selPoste = byId("collabPoste");
    const selService = byId("collabService");
    if (!selPoste || !selService) return;

    const idPoste = (selPoste.value || "").trim();
    if (!idPoste) {
      selService.disabled = false;
      return;
    }

    const p = (_ctx?.postes || []).find(x => (x?.id_poste || "") === idPoste);
    if (p) {
      selService.value = p.id_service || "";
      selService.disabled = true;
      return;
    }

    selService.disabled = false;
  }

  function applyExtraFrontFilters(items){
    let arr = Array.isArray(items) ? items.slice() : [];

    if (_filterManager || _filterFormateur) {
      arr = arr.filter(it => {
        const isManager = !!it?.ismanager;
        const isFormateur = !!it?.isformateur;
        if (_filterManager && _filterFormateur) return isManager || isFormateur;
        if (_filterManager) return isManager;
        if (_filterFormateur) return isFormateur;
        return true;
      });
    }

    return arr;
  }

  function renderList(){
    const host = byId("collabList");
    const empty = byId("collabEmpty");
    if (!host || !empty) return;

    if (!_items.length) {
      host.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";

    host.innerHTML = _items.map(it => {
      const fullName = `${it.prenom || ""} ${it.nom || ""}`.trim() || "Collaborateur sans nom";
      const email = it.email || "—";
      const posteActuel = it.poste_label || "—";
      const accessSummary = Array.isArray(it.access_summary) ? it.access_summary : [];

      return `
        <div class="sb-row-card ${it.archive ? "is-archived" : ""}">
          <div class="sb-row-left" style="display:grid; grid-template-columns:minmax(180px,220px) minmax(260px,1.35fr) minmax(180px,1fr) minmax(120px,.85fr); gap:18px; align-items:center; flex:1 1 auto; min-width:0;">
            <div class="sb-row-title">${esc(fullName)}</div>

            <div style="font-size:13px; font-weight:400; color:#374151; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(email)}
            </div>

            <div style="font-size:13px; font-weight:400; color:#374151; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(posteActuel)}
            </div>

            <div>
              ${renderConsoleIcons(accessSummary)}
            </div>
          </div>

          <div class="sb-row-right" style="flex:0 0 auto;">
            <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="edit" data-id="${esc(it.id_collaborateur)}">Modifier</button>
            ${it.archive ? "" : `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-act="archive" data-id="${esc(it.id_collaborateur)}">Archiver</button>`}
          </div>
        </div>
      `;
    }).join("");
  }

  async function fetchList(portal, args){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const qs = new URLSearchParams();
    if (args.q) qs.set("q", args.q);
    qs.set("service", args.service || "__all__");
    qs.set("poste", args.poste || "__all__");
    qs.set("active", args.active || "all");
    qs.set("include_archived", args.include_archived ? "1" : "0");

    return await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/list/${encodeURIComponent(ownerId)}?${qs.toString()}`);
  }

  async function loadContext(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    _ctx = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/context/${encodeURIComponent(ownerId)}`);
    renderTop();
    renderFilters();
    hydrateFormSelects();
    setSourceHint();
  }

  async function loadGlobalStats(portal){
    const data = await fetchList(portal, {
      q: "",
      service: "__all__",
      poste: "__all__",
      active: "all",
      include_archived: true
    });

    _globalItems = Array.isArray(data?.items) ? data.items : [];
    renderStats(computeGlobalStats(_globalItems));
  }

  async function loadList(portal){
    const data = await fetchList(portal, {
      q: _search,
      service: _filterService,
      poste: _filterPoste,
      active: _filterActive,
      include_archived: _showArchived
    });

    let items = Array.isArray(data?.items) ? data.items : [];
    items = applyExtraFrontFilters(items);
    _items = items;
    renderList();
  }

  function refreshTempRoleVisibility(){
    const wrap = byId("collabTempRoleField");
    const chk = byId("collabTemp");
    if (wrap) wrap.style.display = chk && chk.checked ? "" : "none";
  }

  function refreshSortieVisibility(){
    const wrapDate = byId("collabDateSortieField");
    const wrapMotif = byId("collabMotifSortieField");
    const chk = byId("collabHaveDateFin");
    const show = !!(chk && chk.checked);
    if (wrapDate) wrapDate.style.display = show ? "" : "none";
    if (wrapMotif) wrapMotif.style.display = show ? "" : "none";
  }

  function clearForm(){
    [
      "collabPrenom","collabNom","collabEmail","collabTel","collabTel2","collabAdresse",
      "collabCodePostal","collabVille","collabPays","collabObservations","collabMatricule",
      "collabCodeEffectif","collabBusinessTravel","collabNiveauEdu","collabDomaineEdu",
      "collabDateNaissance","collabDateEntree","collabDateDebutPoste","collabDateSortie",
      "collabMotifSortie","collabNote","collabTempRole"
    ].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });

    if (byId("collabCivilite")) byId("collabCivilite").value = "";
    if (byId("collabService")) {
      byId("collabService").value = "";
      byId("collabService").disabled = false;
    }
    if (byId("collabPoste")) byId("collabPoste").value = "";
    if (byId("collabTypeContrat")) byId("collabTypeContrat").value = "";

    if (byId("collabActif")) byId("collabActif").checked = true;
    if (byId("collabManager")) byId("collabManager").checked = false;
    if (byId("collabFormateur")) byId("collabFormateur").checked = false;
    if (byId("collabTemp")) byId("collabTemp").checked = false;
    if (byId("collabHaveDateFin")) byId("collabHaveDateFin").checked = false;

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId("btnCollabArchive");
    if (btnArchive) btnArchive.style.display = "none";
  }

  function setModalHeader(title, sub){
    if (byId("collabModalTitle")) byId("collabModalTitle").textContent = title || "Collaborateur";
    if (byId("collabModalSub")) byId("collabModalSub").textContent = sub || "—";
  }

  function setModalBadges(data){
    const host = byId("collabModalBadges");
    if (!host) return;

    const badges = [];
    badges.push(data?.archive ? "Archivé" : (data?.actif ? "Actif" : "Inactif"));
    if (data?.is_temp) badges.push("Temporaire");
    if (data?.ismanager) badges.push("Manager");
    if (data?.isformateur) badges.push("Formateur");

    host.innerHTML = badges.map((label, idx) => {
      const cls = idx === 0 ? "sb-badge sb-badge--accent-soft" : "sb-badge sb-badge--outline-accent";
      return `<span class="${cls}">${esc(label)}</span>`;
    }).join("");
  }

  function buildPayload(){
    const posteId = byId("collabPoste")?.value || null;
    return {
      civilite: byId("collabCivilite")?.value || null,
      prenom: byId("collabPrenom")?.value || null,
      nom: byId("collabNom")?.value || null,
      email: byId("collabEmail")?.value || null,
      telephone: formatPhoneFr(byId("collabTel")?.value || null),
      telephone2: formatPhoneFr(byId("collabTel2")?.value || null),
      adresse: byId("collabAdresse")?.value || null,
      code_postal: byId("collabCodePostal")?.value || null,
      ville: byId("collabVille")?.value || null,
      pays: byId("collabPays")?.value || null,
      actif: !!byId("collabActif")?.checked,
      fonction: posteId,
      observations: byId("collabObservations")?.value || null,
      id_service: byId("collabService")?.value || null,
      id_poste_actuel: posteId,
      type_contrat: byId("collabTypeContrat")?.value || null,
      matricule_interne: byId("collabMatricule")?.value || null,
      business_travel: byId("collabBusinessTravel")?.value || null,
      date_naissance: byId("collabDateNaissance")?.value || null,
      date_entree_entreprise: byId("collabDateEntree")?.value || null,
      date_debut_poste_actuel: byId("collabDateDebutPoste")?.value || null,
      date_sortie_prevue: byId("collabDateSortie")?.value || null,
      niveau_education: byId("collabNiveauEdu")?.value || null,
      domaine_education: byId("collabDomaineEdu")?.value || null,
      motif_sortie: byId("collabMotifSortie")?.value || null,
      note_commentaire: byId("collabNote")?.value || null,
      havedatefin: !!byId("collabHaveDateFin")?.checked,
      ismanager: !!byId("collabManager")?.checked,
      isformateur: !!byId("collabFormateur")?.checked,
      is_temp: !!byId("collabTemp")?.checked,
      role_temp: byId("collabTempRole")?.value || null,
      code_effectif: byId("collabCodeEffectif")?.value || null
    };
  }

  function activateModalTab(tab){
    document.querySelectorAll('#collabModalBody [data-tab]').forEach(btn => {
      const isActive = (btn.getAttribute('data-tab') || '') === tab;
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (isActive) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });

    document.querySelectorAll('#collabModalBody [data-panel]').forEach(panel => {
      const isActive = (panel.getAttribute('data-panel') || '') === tab;
      panel.classList.toggle('is-active', isActive);
    });
  }

  function setPanelMessage(panelId, message, tone){
    const host = byId(panelId);
    if (!host) return;
    const color = tone === 'error' ? ' color:#b91c1c;' : '';
    host.innerHTML = `<div class="card-sub" style="margin:0;${color}">${esc(message)}</div>`;
  }

  function resetDetailPanels(){
    _tabLoaded = { skills: false, certs: false, history: false, rights: false };

    if (_editingId) {
      setPanelMessage('collabSkillsPanel', 'Ouvrez l’onglet pour charger les compétences.');
      setPanelMessage('collabCertsPanel', 'Ouvrez l’onglet pour charger les certifications.');
      setPanelMessage('collabHistoryPanel', 'Ouvrez l’onglet pour charger l’historique.');
      setPanelMessage('collabRightsPanel', 'Ouvrez l’onglet pour charger les droits d’accès.');
    } else {
      setPanelMessage('collabSkillsPanel', 'Enregistrez d’abord le collaborateur pour accéder aux compétences.');
      setPanelMessage('collabCertsPanel', 'Enregistrez d’abord le collaborateur pour accéder aux certifications.');
      setPanelMessage('collabHistoryPanel', 'Enregistrez d’abord le collaborateur pour accéder à l’historique.');
      setPanelMessage('collabRightsPanel', 'Enregistrez d’abord le collaborateur pour gérer les droits d’accès.');
    }
  }

  function renderCompetences(data, portal){
    const host = byId('collabSkillsPanel');
    if (!host) return;

    const items = Array.isArray(data?.items) ? data.items : [];
    const poste = getCurrentPosteForSkills();
    const canSync = !!_editingId && !!poste.id;
    const posteLabel = poste.label || data?.intitule_poste || '–';

    const rows = items.map(x => {
      const niveau = (x.niveau_actuel || '').trim() || '–';
      const lastEval = formatDateFR(x.date_derniere_eval);
      const domTitle = (x.domaine_titre || '').toString().trim() || 'Catégorie';
      const domColor = (x.domaine_couleur || '').toString().trim();
      const domStyle = domColor ? ` style="--dom-color:${esc(domColor)}"` : '';

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              ${x.code ? `<span class="sb-badge sb-badge-ref-comp-code">${esc(x.code)}</span>` : ''}
              <div class="sb-comp-title">${esc(x.intitule || '')}</div>
            </div>
            <div style="margin-top:6px;">
              <span class="sb-badge sb-badge-domaine"${domStyle}>${esc(domTitle)}</span>
            </div>
          </td>
          <td style="text-align:center;">${esc(niveau)}</td>
          <td style="text-align:center;">${esc(lastEval)}</td>
        </tr>
      `;
    }).join('');

    host.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 10px 0;">
        <div class="card-sub" style="margin:0;">
          Poste actuel : <strong>${esc(posteLabel)}</strong>
        </div>
        ${canSync ? `
          <button
            type="button"
            class="sb-btn sb-btn--soft"
            id="btnSyncCollabSkillsFromPoste"
          >
            Importer les compétences du poste
          </button>
        ` : ``}
      </div>

      ${
        items.length
          ? `
            <div class="sb-table-wrap">
              <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
                <thead>
                  <tr>
                    <th>Compétence</th>
                    <th style="width:120px; text-align:center;">Niv. actuel</th>
                    <th style="width:140px; text-align:center;">Dernière éval.</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `
          : `<div class="card-sub" style="margin:0;">Aucune compétence trouvée.</div>`
      }
    `;

    const btn = byId('btnSyncCollabSkillsFromPoste');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          await syncCompetencesFromSelectedPoste(portal);
        } catch (e) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e));
        }
      });
    }
  }

  function renderCertifications(data){
    const host = byId('collabCertsPanel');
    if (!host) return;
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucune certification trouvée.</div>`;
      return;
    }

    const rows = items.map(x => {
      const badges = [];
      if (x.categorie) badges.push(`<span class="sb-badge sb-badge--outline-accent">${esc(x.categorie)}</span>`);
      badges.push(`<span class="sb-badge sb-badge--accent-soft">${esc(x.is_required ? 'Requis' : 'Hors poste')}</span>`);

      let statut = '–';
      const s = String(x.statut_validite || '').toLowerCase();
      if (!x.is_acquired) statut = 'Non acquis';
      else if (s === 'valide') statut = 'Valide';
      else if (s === 'a_renouveler') statut = 'À renouveler';
      else if (s === 'expiree') statut = 'Expirée';

      const validite = x.validite_attendue == null ? '–' : (Number(x.validite_attendue) <= 0 ? 'Permanent' : `${x.validite_attendue} mois`);
      const jours = x.jours_restants == null ? '–' : `${x.jours_restants} j`;

      return `
        <tr>
          <td>
            <div style="font-weight:700; color:#111827;">${esc(x.nom_certification || '')}</div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">${badges.join('')}</div>
          </td>
          <td style="text-align:center;">${esc(validite)}</td>
          <td style="text-align:center;">
            <div>${esc(statut)}</div>
            <div class="card-sub" style="margin:6px 0 0 0;">${esc(jours)}</div>
          </td>
          <td style="text-align:center;">${esc(formatDateFR(x.date_obtention))}</td>
          <td style="text-align:center;">${esc(formatDateFR(x.date_expiration || x.date_expiration_calculee))}</td>
        </tr>
      `;
    }).join('');

    host.innerHTML = `
      <div class="card-sub" style="margin:0 0 10px 0;">Poste actuel : <strong>${esc(data?.intitule_poste || '–')}</strong></div>
      <div class="sb-table-wrap">
        <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
          <thead>
            <tr>
              <th>Certification</th>
              <th style="width:120px; text-align:center;">Validité</th>
              <th style="width:140px; text-align:center;">État</th>
              <th style="width:130px; text-align:center;">Obtention</th>
              <th style="width:130px; text-align:center;">Expiration</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderHistory(data){
    const host = byId('collabHistoryPanel');
    if (!host) return;
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      host.innerHTML = `<div class="card-sub" style="margin:0;">Aucun historique trouvé.</div>`;
      return;
    }

    const rows = items.map(x => `
      <tr>
        <td style="white-space:nowrap;">${esc(x.code_action_formation || '–')}</td>
        <td>${esc(x.titre_formation || '–')}</td>
        <td style="text-align:center;">${esc(formatDateFR(x.date_debut_formation))}</td>
        <td style="text-align:center;">${esc(formatDateFR(x.date_fin_formation))}</td>
        <td style="text-align:center;">${esc(x.etat_action || '–')}</td>
      </tr>
    `).join('');

    host.innerHTML = `
      <div class="card-sub" style="margin:0 0 10px 0;">Formations effectuées avec JMBCONSULTANT.</div>
      <div class="sb-table-wrap">
        <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
          <thead>
            <tr>
              <th style="width:110px;">Code</th>
              <th>Formation</th>
              <th style="width:120px; text-align:center;">Début</th>
              <th style="width:120px; text-align:center;">Fin</th>
              <th style="width:120px; text-align:center;">État</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderRights(data, portal){
    const host = byId('collabRightsPanel');
    if (!host) return;

    const consoles = Array.isArray(data?.consoles) ? data.consoles : [];
    const savedEmail = String(data?.email || '').trim();
    const hasEmail = !!savedEmail;

    const rows = consoles.map(item => {
      const consoleCode = String(item?.console_code || '').trim().toLowerCase();
      const label = getConsoleLabel(consoleCode);
      const iconUrl = getConsoleIconUrl(consoleCode);
      const contractActive = !!item?.contract_active;
      const roleCode = String(item?.role_code || 'none').trim().toLowerCase() || 'none';
      const roleLabel = getRoleLabel(roleCode);
      const disabled = !contractActive || !hasEmail;

      const stateText = contractActive
        ? `<strong>Console active</strong><br>${hasEmail ? 'Accès gérable pour ce collaborateur.' : 'Renseignez et enregistrez un email pour ouvrir l’accès.'}`
        : `<strong>Console non incluse</strong><br>Le contrat owner ne permet pas cette console.`;

      return `
        <div class="sb-access-row ${disabled ? 'is-disabled' : ''}">
          <div class="sb-access-console">
            <div class="sb-access-console-icon">
              ${iconUrl ? `
                <img
                  src="${esc(iconUrl)}"
                  alt="${esc(label)}"
                  loading="lazy"
                  onerror="this.style.display='none'; this.parentElement && this.parentElement.classList.add('sb-console-chip--muted');"
                />
              ` : ''}
            </div>
            <div style="min-width:0;">
              <div class="sb-access-console-title">${esc(label)}</div>
              <div class="sb-access-console-sub">Profil actuel : ${esc(roleLabel)}</div>
            </div>
          </div>

          <div>
            <select data-console-role="${esc(consoleCode)}" ${disabled ? 'disabled' : ''}>
              <option value="none" ${roleCode === 'none' ? 'selected' : ''}>Aucun accès</option>
              <option value="user" ${roleCode === 'user' ? 'selected' : ''}>Utilisateur</option>
              <option value="editor" ${roleCode === 'editor' ? 'selected' : ''}>Éditeur</option>
              <option value="admin" ${roleCode === 'admin' ? 'selected' : ''}>Administrateur</option>
            </select>
          </div>

          <div class="sb-access-state">${stateText}</div>
        </div>
      `;
    }).join('');

    host.innerHTML = `
      <div class="sb-stack sb-stack--sm">
        <div class="card-sub" style="margin:0;">
          Définissez les accès console du collaborateur. <strong>Email enregistré :</strong> ${esc(savedEmail || 'non renseigné')}
        </div>

        ${hasEmail ? '' : `<div class="sb-access-note">Aucun accès ne peut être ouvert tant que l’email n’est pas renseigné et enregistré sur le collaborateur.</div>`}

        <div class="sb-access-grid">${rows}</div>

        <div class="sb-actions" style="justify-content:flex-end; margin-top:4px;">
          <button type="button" class="sb-btn sb-btn--accent" id="btnCollabSaveRights">Enregistrer les droits</button>
        </div>
      </div>
    `;

    const btn = byId('btnCollabSaveRights');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          btn.disabled = true;
          await saveRights(portal);
        } catch (e) {
          portal.showAlert('error', getErrorMessage(e));
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  async function saveRights(portal){
    if (!_editingId) throw new Error('Enregistrez d’abord le collaborateur.');
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/acces/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRightsPayload())
    });

    renderRights(data, portal);
    _tabLoaded.rights = true;
    await loadList(portal);    
  }

  async function loadTabIfNeeded(portal, tab){
    if (!_editingId || _tabLoaded[tab]) return;
    _tabLoaded[tab] = true;

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    if (tab === 'skills') {
      setPanelMessage('collabSkillsPanel', 'Chargement…');
      const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`);
      renderCompetences(data, portal);
      return;
    }

    if (tab === 'certs') {
      setPanelMessage('collabCertsPanel', 'Chargement…');
      const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`);
      renderCertifications(data);
      return;
    }

    if (tab === 'history') {
      setPanelMessage('collabHistoryPanel', 'Chargement…');
      const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/historique/formations-jmb/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`);
      renderHistory(data);
      return;
    }

    if (tab === 'rights') {
      setPanelMessage('collabRightsPanel', 'Chargement…');
      const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/acces/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`);
      renderRights(data, portal);
    }
  }

  async function openCreateModal(){
    _modalMode = 'create';
    _editingId = null;
    clearForm();
    setSourceHint();
    setModalBadges({ actif: true, archive: false });
    setModalHeader('Nouveau collaborateur', _ctx?.source_label || 'Collaborateur');
    activateModalTab('ident');
    resetDetailPanels();
    openModal('modalCollaborateur');
  }

  async function openEditModal(portal, id){
    const ownerId = getOwnerId();
    if (!ownerId || !id) return;

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`);

    _modalMode = 'edit';
    _editingId = id;

    clearForm();
    setSourceHint();

    if (byId('collabCivilite')) byId('collabCivilite').value = data?.civilite || '';
    if (byId('collabPrenom')) byId('collabPrenom').value = data?.prenom || '';
    if (byId('collabNom')) byId('collabNom').value = data?.nom || '';
    if (byId('collabEmail')) byId('collabEmail').value = data?.email || '';
    if (byId('collabTel')) byId('collabTel').value = formatPhoneFr(data?.telephone || '');
    if (byId('collabTel2')) byId('collabTel2').value = formatPhoneFr(data?.telephone2 || '');
    if (byId('collabAdresse')) byId('collabAdresse').value = data?.adresse || '';
    if (byId('collabCodePostal')) byId('collabCodePostal').value = data?.code_postal || '';
    if (byId('collabVille')) byId('collabVille').value = data?.ville || '';
    if (byId('collabPays')) byId('collabPays').value = data?.pays || '';
    if (byId('collabActif')) byId('collabActif').checked = !!data?.actif;
    if (byId('collabService')) byId('collabService').value = data?.id_service || '';
    if (byId('collabPoste')) byId('collabPoste').value = data?.id_poste_actuel || data?.fonction || '';
    if (byId('collabTypeContrat')) byId('collabTypeContrat').value = data?.type_contrat || '';
    if (byId('collabMatricule')) byId('collabMatricule').value = data?.matricule_interne || '';
    if (byId('collabCodeEffectif')) byId('collabCodeEffectif').value = data?.code_effectif || '';
    if (byId('collabBusinessTravel')) byId('collabBusinessTravel').value = data?.business_travel || '';
    if (byId('collabNiveauEdu')) byId('collabNiveauEdu').value = data?.niveau_education || '';
    if (byId('collabDomaineEdu')) byId('collabDomaineEdu').value = data?.domaine_education || '';
    if (byId('collabDateNaissance')) byId('collabDateNaissance').value = data?.date_naissance || '';
    if (byId('collabDateEntree')) byId('collabDateEntree').value = data?.date_entree_entreprise || '';
    if (byId('collabDateDebutPoste')) byId('collabDateDebutPoste').value = data?.date_debut_poste_actuel || '';
    if (byId('collabDateSortie')) byId('collabDateSortie').value = data?.date_sortie_prevue || '';
    if (byId('collabMotifSortie')) byId('collabMotifSortie').value = data?.motif_sortie || '';
    if (byId('collabObservations')) byId('collabObservations').value = data?.observations || '';
    if (byId('collabNote')) byId('collabNote').value = data?.note_commentaire || '';
    if (byId('collabHaveDateFin')) byId('collabHaveDateFin').checked = !!data?.havedatefin || !!data?.date_sortie_prevue;
    if (byId('collabManager')) byId('collabManager').checked = !!data?.ismanager;
    if (byId('collabFormateur')) byId('collabFormateur').checked = !!data?.isformateur;
    if (byId('collabTemp')) byId('collabTemp').checked = !!data?.is_temp;
    if (byId('collabTempRole')) byId('collabTempRole').value = data?.role_temp || '';

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId('btnCollabArchive');
    if (btnArchive) btnArchive.style.display = data?.archive ? 'none' : '';

    const fullName = `${data?.prenom || ''} ${data?.nom || ''}`.trim();
    setModalHeader(fullName || 'Collaborateur', data?.archive ? 'Archivé' : (data?.actif ? 'Actif' : 'Inactif'));
    setModalBadges(data || {});
    activateModalTab('ident');
    resetDetailPanels();
    openModal('modalCollaborateur');
  }

  async function saveModal(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const payload = buildPayload();
    const url = _modalMode === 'edit' && _editingId
      ? `${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`
      : `${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}`;

    const data = await portal.apiJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (_modalMode === 'create' && data?.id_collaborateur) {
      _modalMode = 'edit';
      _editingId = data.id_collaborateur;
      setModalHeader(`${payload.prenom || ''} ${payload.nom || ''}`.trim() || 'Collaborateur', payload.actif ? 'Actif' : 'Inactif');
      setModalBadges({ actif: !!payload.actif, archive: false, ismanager: !!payload.ismanager, isformateur: !!payload.isformateur, is_temp: !!payload.is_temp });
      resetDetailPanels();
    }

    closeModal('modalCollaborateur');
    await loadGlobalStats(portal);
    await loadList(portal);
  }

  async function archiveCollaborateur(portal, id){
    const ownerId = getOwnerId();
    if (!ownerId || !id) return;
    if (!window.confirm('Archiver ce collaborateur ?')) return;

    await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}/archive`, {
      method: 'POST'
    });

    if (_editingId === id) closeModal('modalCollaborateur');
    await loadGlobalStats(portal);
    await loadList(portal);
  }

  function bindListActions(portal){
    byId('collabList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;

      const act = btn.getAttribute('data-act') || '';
      const id = btn.getAttribute('data-id') || '';

      try {
        if (act === 'edit') await openEditModal(portal, id);
        if (act === 'archive') await archiveCollaborateur(portal, id);
      } catch (err) {
        portal.showAlert('error', getErrorMessage(err));
      }
    });
  }

  function bindTabs(portal){
    document.querySelectorAll('#collabModalBody [data-tab]').forEach(btn => {
      if (btn.dataset.tabBound === '1') return;
      btn.dataset.tabBound = '1';

      btn.addEventListener('click', async () => {
        const tab = btn.getAttribute('data-tab') || 'ident';
        activateModalTab(tab);
        if (tab === 'ident') return;
        try {
          await loadTabIfNeeded(portal, tab);
        } catch (e) {
          const panelId = tab === 'skills'
            ? 'collabSkillsPanel'
            : (tab === 'certs'
              ? 'collabCertsPanel'
              : (tab === 'history' ? 'collabHistoryPanel' : 'collabRightsPanel'));
          setPanelMessage(panelId, getErrorMessage(e), 'error');
        }
      });
    });
  }

  function bindOnce(portal){
    if (_bound) return;
    _bound = true;

    bindListActions(portal);
    bindTabs(portal);

    byId('btnCollabAdd')?.addEventListener('click', () => {
      openCreateModal().catch(e => portal.showAlert('error', getErrorMessage(e)));
    });

    byId('collabSearch')?.addEventListener('input', (e) => {
      _search = (e.target.value || '').trim();
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
      }, 250);
    });

    byId('collabFilterService')?.addEventListener('change', (e) => {
      _filterService = (e.target.value || '__all__').trim();
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabFilterPoste')?.addEventListener('change', (e) => {
      _filterPoste = (e.target.value || '__all__').trim();
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabFilterActive')?.addEventListener('change', (e) => {
      _filterActive = (e.target.value || 'active').trim();
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabFilterManager')?.addEventListener('change', (e) => {
      _filterManager = !!e.target.checked;
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabFilterFormateur')?.addEventListener('change', (e) => {
      _filterFormateur = !!e.target.checked;
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabShowArchived')?.addEventListener('change', (e) => {
      _showArchived = !!e.target.checked;
      loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('btnCloseCollaborateur')?.addEventListener('click', () => closeModal('modalCollaborateur'));
    byId('btnCollabCancel')?.addEventListener('click', () => closeModal('modalCollaborateur'));

    byId('btnCollabSave')?.addEventListener('click', async () => {
      try {
        await saveModal(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabArchive')?.addEventListener('click', async () => {
      try {
        if (_editingId) await archiveCollaborateur(portal, _editingId);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    bindPhoneMask(byId('collabTel'));
    bindPhoneMask(byId('collabTel2'));

    byId('collabPoste')?.addEventListener('change', refreshServiceFromPoste);
    byId('collabTemp')?.addEventListener('change', refreshTempRoleVisibility);
    byId('collabHaveDateFin')?.addEventListener('change', refreshSortieVisibility);
  }

  async function init(){
    try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}
    const portal = window.portal;
    if (!portal) return;

    bindOnce(portal);
    setStatus('Chargement…');
    await loadContext(portal);
    await loadGlobalStats(portal);
    await loadList(portal);
    setStatus('—');
  }

  init().catch(e => {
    if (window.portal && window.portal.showAlert) {
      window.portal.showAlert('error', 'Erreur collaborateurs : ' + getErrorMessage(e));
    }
    setStatus('Erreur de chargement.');
  });
})();