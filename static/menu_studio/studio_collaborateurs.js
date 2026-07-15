(function () {
  let _bound = false;
  let _loaded = false;
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
  let _sortKey = 'collaborateur';
  let _sortDir = 'asc';
  let _page = 1;
  let _pageSize = 25;
  let _bulkSendSelectedIds = new Set();
  let _drawerCollaborateurId = "";

  let _modalMode = "create";
  let _editingId = null;
  let _tabLoaded = { skills: false, certs: false, history: false, rights: false };
  const COLLAB_LIST_SHOW_PDF_BTN = false;

  let _hiddenCodeEffectif = null;
  let _hiddenBusinessTravel = null;
  let _hiddenIsTemp = false;
  let _hiddenTempRole = null;
  let _hiddenTelephone2 = null;
  let _hiddenNoteCommentaire = null;

  let _nsfGroupes = [];
  let _nsfGroupesLoaded = false;

  let _collabSkillItems = [];
  let _collabSkillSorts = {
    required: { key: 'competence', dir: 'asc' },
    other: { key: 'competence', dir: 'asc' }
  };
  let _collabCompAddItems = [];
  let _collabCompAddItemsAll = [];
  let _collabCompAddSearch = "";
  let _collabCompAddTimer = null;
  let _collabCompAddIncludeToValidate = false;
  let _collabCompAddDomain = "";

  let _collabSkillEvalState = {
    id_effectif_competence: "",
    id_comp: "",
    grille_evaluation: null,
    last_audit: null
  };

  let _collabCertItems = [];
  let _collabCertAddItems = [];
  let _collabCertAddItemsAll = [];
  let _collabCertAddSearch = "";
  let _collabCertAddTimer = null;
  let _collabCertAddCategory = "";

  let _collabCertEditState = {
    id_effectif_certification: "",
    id_certification: "",
    id_preuve_doc: "",
    preuve_nom_fichier: "",
    proofFile: null,
  };

  function getCollaborateursRoot(){
    return document.querySelector('#view-collaborateurs[data-view="collaborateurs"]');
  }

  function byId(id){
    const root = getCollaborateursRoot();
    if (root){
      const el = root.querySelector(`#${id}`);
      if (el) return el;
    }
    return document.getElementById(id);
  }



  function nsLevelKey(v){
    const raw = String(v ?? "").trim();
    const norm = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (!norm || norm === "-" || norm === "—") return "";
    if (norm === "a" || norm.includes("initial") || norm.includes("debutant")) return "A";
    if (norm === "b" || norm.includes("intermediaire") || norm.includes("interm")) return "B";
    if (norm === "c" || norm.includes("avance") || norm.includes("advanced")) return "C";
    if (norm === "d" || norm.includes("expert")) return "D";
    return "";
  }

  function nsLevelLabel(v){
    const k = nsLevelKey(v);
    return ({ A:"Débutant", B:"Intermédiaire", C:"Avancé", D:"Expert" })[k] || (String(v ?? "").trim() || "—");
  }

  function collabSkillLevelLabel(v){
    return nsLevelLabel(v);
  }

  function nsLevelFromScore24(score24){
    const n = Number(score24);
    if (!Number.isFinite(n)) return "";
    if (n <= 6) return "A";
    if (n <= 12) return "B";
    if (n <= 18) return "C";
    return "D";
  }

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

    function normalizeCollabPostalCode(value){
    return (value || "").toString().replace(/\D+/g, "").slice(0, 5);
  }

  function normalizeCollabCity(value){
    return (value || "").toString().trim().toUpperCase();
  }

  function clearCollabPostalDatalists(){
    const cpList = byId("collabCodePostalList");
    const cityList = byId("collabVilleList");
    if (cpList) cpList.innerHTML = "";
    if (cityList) cityList.innerHTML = "";
  }

  function setCollabDatalistOptions(listId, items, valueKey, labelKey){
    const list = byId(listId);
    if (!list) return;

    list.innerHTML = "";
    const seen = new Set();

    (items || []).forEach(item => {
      const value = (item?.[valueKey] || "").toString().trim();
      const label = (item?.[labelKey] || "").toString().trim();

      if (!value || seen.has(value)) return;
      seen.add(value);

      const opt = document.createElement("option");
      opt.value = value;
      if (label && label !== value) {
        opt.label = label;
      }
      list.appendChild(opt);
    });
  }

  async function fetchCollabPostalRows(portal, params){
    const ownerId = getOwnerId();
    if (!ownerId) return [];

    const qs = new URLSearchParams();
    if (params?.code_postal) qs.set("code_postal", params.code_postal);
    if (params?.ville) qs.set("ville", params.ville);
    qs.set("limit", String(params?.limit || 20));

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/referentiels/codes-postaux/${encodeURIComponent(ownerId)}?${qs.toString()}`
    );

    return Array.isArray(data?.items) ? data.items : [];
  }

  function applyCollabPostalRowsFromCode(cpValue, rows){
    const cpEl = byId("collabCodePostal");
    const cityEl = byId("collabVille");
    if (!cpEl || !cityEl) return;

    const exactRows = (rows || []).filter(r => ((r.code_postal || "").toString().trim() === cpValue));
    const cityRows = exactRows.length ? exactRows : rows;

    setCollabDatalistOptions("collabCodePostalList", rows, "code_postal", "ville");
    setCollabDatalistOptions("collabVilleList", cityRows, "ville", "code_postal");

    const villes = [...new Set(
      (cityRows || [])
        .map(r => normalizeCollabCity(r.ville))
        .filter(Boolean)
    )];

    if (cpValue.length === 5) {
      if (villes.length === 1) {
        cityEl.value = villes[0];
      } else if (villes.length > 1) {
        const current = normalizeCollabCity(cityEl.value);
        if (!current || !villes.includes(current)) {
          cityEl.value = "";
        } else {
          cityEl.value = current;
        }
      }
    }
  }

  function applyCollabPostalRowsFromCity(cityValue, rows){
    const cpEl = byId("collabCodePostal");
    const cityEl = byId("collabVille");
    if (!cpEl || !cityEl) return;

    cityEl.value = cityValue;

    const exactRows = (rows || []).filter(r => normalizeCollabCity(r.ville) === cityValue);
    const cpRows = exactRows.length ? exactRows : rows;

    setCollabDatalistOptions("collabVilleList", rows, "ville", "code_postal");
    setCollabDatalistOptions("collabCodePostalList", cpRows, "code_postal", "ville");

    const cps = [...new Set(
      (cpRows || [])
        .map(r => normalizeCollabPostalCode(r.code_postal))
        .filter(Boolean)
    )];

    if (cps.length === 1) {
      cpEl.value = cps[0];
    } else if (cps.length > 1) {
      const current = normalizeCollabPostalCode(cpEl.value);
      if (!current || !cps.includes(current)) {
        cpEl.value = "";
      } else {
        cpEl.value = current;
      }
    }
  }

  let _collabPostalAssistTimer = null;
  let _collabPostalAssistSeq = 0;

  function scheduleCollabPostalLookup(portal, source){
    clearTimeout(_collabPostalAssistTimer);

    _collabPostalAssistTimer = setTimeout(async () => {
      const seq = ++_collabPostalAssistSeq;

      const cpEl = byId("collabCodePostal");
      const cityEl = byId("collabVille");
      if (!cpEl || !cityEl) return;

      cpEl.value = normalizeCollabPostalCode(cpEl.value);
      cityEl.value = normalizeCollabCity(cityEl.value);

      const cpValue = cpEl.value;
      const cityValue = cityEl.value;

      try {
        if (source === "cp") {
          if (!cpValue) {
            clearCollabPostalDatalists();
            return;
          }

          const rows = await fetchCollabPostalRows(portal, { code_postal: cpValue, limit: 20 });
          if (seq !== _collabPostalAssistSeq) return;

          applyCollabPostalRowsFromCode(cpValue, rows);
          return;
        }

        if (!cityValue || cityValue.length < 2) {
          clearCollabPostalDatalists();
          return;
        }

        const rows = await fetchCollabPostalRows(portal, { ville: cityValue, limit: 20 });
        if (seq !== _collabPostalAssistSeq) return;

        applyCollabPostalRowsFromCity(cityValue, rows);
      } catch (_) {
      }
    }, 180);
  }

  function bindCollabPostalAssist(portal){
    const cpEl = byId("collabCodePostal");
    const cityEl = byId("collabVille");
    if (!cpEl || !cityEl) return;
    if (cpEl.dataset.postalBound === "1") return;

    cpEl.dataset.postalBound = "1";
    cityEl.dataset.postalBound = "1";

    cpEl.addEventListener("input", () => {
      cpEl.value = normalizeCollabPostalCode(cpEl.value);
      scheduleCollabPostalLookup(portal, "cp");
    });

    cpEl.addEventListener("change", () => {
      cpEl.value = normalizeCollabPostalCode(cpEl.value);
      scheduleCollabPostalLookup(portal, "cp");
    });

    cityEl.addEventListener("input", () => {
      cityEl.value = normalizeCollabCity(cityEl.value);
      scheduleCollabPostalLookup(portal, "ville");
    });

    cityEl.addEventListener("change", () => {
      cityEl.value = normalizeCollabCity(cityEl.value);
      scheduleCollabPostalLookup(portal, "ville");
    });

    cityEl.addEventListener("blur", () => {
      cityEl.value = normalizeCollabCity(cityEl.value);
    });
  }

  function queueCollabPostalLookupFromCurrentValues(portal){
    const cpEl = byId("collabCodePostal");
    const cityEl = byId("collabVille");
    if (!cpEl || !cityEl) return;

    cpEl.value = normalizeCollabPostalCode(cpEl.value);
    cityEl.value = normalizeCollabCity(cityEl.value);

    if (cpEl.value) {
      scheduleCollabPostalLookup(portal, "cp");
      return;
    }

    if (cityEl.value) {
      scheduleCollabPostalLookup(portal, "ville");
      return;
    }

    clearCollabPostalDatalists();
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


  function collabModalSvg(name){
    const icons = {
      contract: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h6"/></svg>',
      skills: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>',
      certs: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
      medal: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M8.5 12.5 7 22l5-3 5 3-1.5-9.5"/></svg>',
      calendar: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
      org: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8.5" y="14" width="7" height="7" rx="1"/><path d="M6.5 10v2a2 2 0 0 0 2 2H12"/><path d="M17.5 10v2a2 2 0 0 1-2 2H12"/></svg>',
      school: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>',
      import: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/><path d="M5 17v4"/><path d="M19 17v4"/></svg>'
    };
    return icons[name] || icons.contract;
  }

  function formatDateFR(value){
    const s = String(value || "").trim();
    if (!s) return "–";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString("fr-FR");
  }

  function historyPosteSourceLabel(value){
    const s = String(value || '').trim().toLowerCase();
    if (s === 'sirh') return 'SIRH';
    if (s === 'import') return 'Import';
    if (s === 'admin') return 'Admin';
    return 'Manuel';
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
    if (code === 'supervisor') return 'Superviseur';
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
    const previousHtml = btn ? btn.innerHTML : '';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>Import…</span>';
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
      void inserted;
      void skipped;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = previousHtml || `<span class="sb-btn-icon" aria-hidden="true">${collabModalSvg('import')}</span><span>Importer les compétences du poste</span>`;
      }
    }
  }

  async function syncCertificationsFromSelectedPoste(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const poste = getCurrentPosteForSkills();
    if (!poste.id) throw new Error("Sélectionnez un poste actuel.");

    const btn = byId('btnSyncCollabCertsFromPoste');
    const previousHtml = btn ? btn.innerHTML : '';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>Import…</span>';
    }

    try {
      await portal.apiJson(
        `${portal.apiBase}/studio/collaborateurs/certifications/sync-poste/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_poste_actuel: poste.id })
        }
      );

      _tabLoaded.certs = false;
      await loadTabIfNeeded(portal, 'certs');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = previousHtml || `<span class="sb-btn-icon" aria-hidden="true">${collabModalSvg('import')}</span><span>Importer les certifications du poste</span>`;
      }
    }
  }


  async function removeCompetenceFromCollaborateur(portal, idComp){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const id = String(idComp || '').trim();
    if (!id) throw new Error("Compétence introuvable.");

    await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/remove`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_comp: id })
      }
    );

    _tabLoaded.skills = false;
    await loadTabIfNeeded(portal, 'skills');
  }

  function resetCollabCompAddState(){
    if (byId('collabCompAddSearch')) byId('collabCompAddSearch').value = '';
    if (byId('collabCompAddList')) byId('collabCompAddList').innerHTML = '';

    const cb = byId('collabCompAddShowToValidate');
    if (cb) cb.checked = false;

    const sel = byId('collabCompAddDomain');
    if (sel){
      sel.innerHTML = `
        <option value="">Tous</option>
        <option value="__none__">Sans domaine</option>
      `;
      sel.value = '';
    }

    _collabCompAddSearch = '';
    _collabCompAddItems = [];
    _collabCompAddItemsAll = [];
    _collabCompAddIncludeToValidate = false;
    _collabCompAddDomain = '';
  }

  function refreshCollabCompAddDomainOptions(items){
    const sel = byId('collabCompAddDomain');
    if (!sel) return;

    const keep = (sel.value || '').trim();
    const map = new Map();

    (items || []).forEach(it => {
      const id = (it.domaine || '').toString().trim() || '__none__';
      const label = (
        it.domaine_titre_court ||
        it.domaine_titre ||
        it.domaine ||
        ''
      ).toString().trim() || 'Sans domaine';

      if (!map.has(id)) map.set(id, label);
    });

    sel.innerHTML = '';
    sel.appendChild(new Option('Tous', ''));
    sel.appendChild(new Option('Sans domaine', '__none__'));

    Array.from(map.entries())
      .filter(([id]) => id !== '__none__')
      .sort((a, b) => a[1].localeCompare(b[1], 'fr', { sensitivity: 'base' }))
      .forEach(([id, label]) => sel.appendChild(new Option(label, id)));

    if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
    else sel.value = '';

    _collabCompAddDomain = (sel.value || '').trim();
  }

  function applyCollabCompAddDomainFilter(items){
    const dom = (_collabCompAddDomain || '').trim();
    if (!dom) return (items || []).slice();

    if (dom === '__none__'){
      return (items || []).filter(it => !((it.domaine || '').toString().trim()));
    }

    return (items || []).filter(it => ((it.domaine || '').toString().trim() === dom));
  }

  function renderCollabCompAddList(portal){
    const host = byId('collabCompAddList');
    if (!host) return;
    host.innerHTML = '';

    const items = _collabCompAddItems || [];
    if (!items.length){
      const e = document.createElement('div');
      e.className = 'card-sub';
      e.textContent = 'Aucune compétence à afficher.';
      host.appendChild(e);
      return;
    }

    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'sb-row-card';

      const left = document.createElement('div');
      left.className = 'sb-row-left';

      const code = document.createElement('span');
      code.className = 'sb-badge sb-badge--comp';
      code.textContent = it.code || '—';

      const title = document.createElement('div');
      title.className = 'sb-row-title';
      title.textContent = it.intitule || '';

      left.appendChild(code);
      left.appendChild(title);

      const right = document.createElement('div');
      right.className = 'sb-row-right';

      if ((it.etat || '').toLowerCase() === 'à valider'){
        const v = document.createElement('span');
        v.className = 'sb-badge sb-badge--accent-soft';
        v.textContent = 'À valider';
        right.appendChild(v);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sb-btn sb-btn--accent sb-btn--xs';
      btn.textContent = 'Ajouter';
      btn.addEventListener('click', async () => {
        try {
          btn.disabled = true;
          await addCompetenceToCollaborateur(portal, it.id_comp);
        } catch (e) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e));
          btn.disabled = false;
        }
      });

      row.appendChild(left);
      row.appendChild(right);
      row.appendChild(btn);

      host.appendChild(row);
    });
  }

  async function loadCollabCompAddList(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const url =
      `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}` +
      `?q=${encodeURIComponent(_collabCompAddSearch)}` +
      `&show=active`;

    const data = await portal.apiJson(url);
    let items = Array.isArray(data?.items) ? data.items : [];

    items = items.filter(it => {
      const et = (it.etat || '').toLowerCase();
      if (et === 'active' || et === 'valide') return true;
      if (_collabCompAddIncludeToValidate && et === 'à valider') return true;
      return false;
    });

    const existing = new Set(
      (_collabSkillItems || [])
        .map(x => (x.id_comp || '').toString().trim())
        .filter(Boolean)
    );

    items = items.filter(it => {
      const idComp = (it.id_comp || '').toString().trim();
      return idComp && !existing.has(idComp);
    });

    _collabCompAddItemsAll = items;
    refreshCollabCompAddDomainOptions(_collabCompAddItemsAll);
    _collabCompAddItems = applyCollabCompAddDomainFilter(_collabCompAddItemsAll);
    renderCollabCompAddList(portal);
  }

  async function openCollabCompAddModal(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");
    resetCollabCompAddState();
    openModal('modalCollabCompAdd');
    await loadCollabCompAddList(portal);
  }

  async function addCompetenceToCollaborateur(portal, idComp, opts = {}){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const payload = { id_comp: idComp };
    const niveauActuel = (opts?.niveau_actuel || '').toString().trim();
    if (niveauActuel) payload.niveau_actuel = niveauActuel;

    await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/add`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (opts?.closeModal !== false) {
      closeModal('modalCollabCompAdd');
    }

    _tabLoaded.skills = false;
    await loadTabIfNeeded(portal, 'skills');
  }

    function certificationStateLabel(code){
    const s = String(code || '').trim().toLowerCase();
    if (s === 'a_obtenir') return 'À obtenir';
    if (s === 'en_cours') return 'En cours';
    if (s === 'acquise') return 'Acquise';
    if (s === 'a_renouveler') return 'À renouveler';
    if (s === 'expiree') return 'Expirée';
    return '–';
  }

  function certificationMonthLabel(value){
    if (value == null || value === '') return '–';
    const n = Number(value);
    if (!Number.isFinite(n)) return '–';
    if (n <= 0) return 'Permanent';
    return `${n} mois`;
  }

  function applyCollabScopeToUrl(rawUrl){
    const raw = String(rawUrl || '').trim();
    if (!raw) return raw;

    const url = new URL(raw, window.location.origin);
    const ownerId = getOwnerId();
    const entId = (window.__collabScopeEntId || '').toString().trim();

    if (!ownerId || !entId) return url.toString();
    if (ownerId === entId) return url.toString();
    if (url.searchParams.has('id_ent')) return url.toString();

    const scopedPrefixes = [
      '/studio/collaborateurs/',
      '/studio/org/'
    ];

    const mustScope = scopedPrefixes.some(prefix => url.pathname.startsWith(prefix));
    if (!mustScope) return url.toString();

    url.searchParams.set('id_ent', entId);
    return url.toString();
  }

  async function collabApiJson(portal, url, options = {}){
    return await portal.apiJson(applyCollabScopeToUrl(url), options);
  }

  async function loadHistorySection(portal, url){
    try {
      return await collabApiJson(portal, url);
    } catch (e) {
      return { items: [], error: getErrorMessage(e) };
    }
  }

  async function fetchAuthJson(url, options = {}){
    const headers = new Headers(options.headers || {});
    const token = await getPortalAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const scopedUrl = applyCollabScopeToUrl(url);
    const res = await fetch(scopedUrl, { ...options, headers });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const js = await res.clone().json();
        detail = js?.detail || js?.message || detail;
      } catch (_) {
        try {
          const txt = await res.text();
          if (txt) detail = txt;
        } catch (_) {}
      }
      throw new Error(detail);
    }

    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      return await res.json();
    }

    return {};
  }

  async function openFetchedBinary(url){
    const blob = await fetchPdfBlob(url);
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    }, 5 * 60 * 1000);
  }

  function bindCollabStepperButtons(host){
    if (!host) return;

    host.querySelectorAll('.sb-stepper-btn').forEach(btn => {
      if (btn.dataset.collabStepperBound === '1') return;
      btn.dataset.collabStepperBound = '1';

      btn.addEventListener('click', () => {
        const targetId = (btn.getAttribute('data-stepper-target') || '').trim();
        const delta = parseInt(btn.getAttribute('data-stepper-delta') || '0', 10);
        const input = byId(targetId);
        if (!input || !Number.isFinite(delta) || !delta) return;

        const min = parseInt(input.getAttribute('min') || '0', 10);
        const step = parseInt(input.getAttribute('step') || '1', 10) || 1;

        let cur = parseInt((input.value || '').trim(), 10);
        if (!Number.isFinite(cur)) {
          cur = Math.max(min || step, step);
        } else {
          cur += (delta * step);
        }

        if (Number.isFinite(min)) cur = Math.max(min, cur);

        input.value = String(cur);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function resetCollabCertAddState(){
    if (byId('collabCertAddSearch')) byId('collabCertAddSearch').value = '';
    if (byId('collabCertAddList')) byId('collabCertAddList').innerHTML = '';

    const sel = byId('collabCertAddCategory');
    if (sel){
      sel.innerHTML = `
        <option value="">Toutes</option>
        <option value="__none__">Sans catégorie</option>
      `;
      sel.value = '';
    }

    _collabCertAddSearch = '';
    _collabCertAddItems = [];
    _collabCertAddItemsAll = [];
    _collabCertAddCategory = '';
  }

  function refreshCollabCertAddCategoryOptions(items){
    const sel = byId('collabCertAddCategory');
    if (!sel) return;

    const keep = (sel.value || '').trim();
    const map = new Map();

    (items || []).forEach(it => {
      const value = (it.categorie || '').toString().trim() || '__none__';
      const label = (it.categorie || '').toString().trim() || 'Sans catégorie';
      if (!map.has(value)) map.set(value, label);
    });

    sel.innerHTML = '';
    sel.appendChild(new Option('Toutes', ''));
    sel.appendChild(new Option('Sans catégorie', '__none__'));

    Array.from(map.entries())
      .filter(([id]) => id !== '__none__')
      .sort((a, b) => a[1].localeCompare(b[1], 'fr', { sensitivity: 'base' }))
      .forEach(([id, label]) => sel.appendChild(new Option(label, id)));

    if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
    else sel.value = '';

    _collabCertAddCategory = (sel.value || '').trim();
  }

  function applyCollabCertAddCategoryFilter(items){
    const cat = (_collabCertAddCategory || '').trim();
    if (!cat) return (items || []).slice();

    if (cat === '__none__'){
      return (items || []).filter(it => !((it.categorie || '').toString().trim()));
    }

    return (items || []).filter(it => ((it.categorie || '').toString().trim() === cat));
  }

  function renderCollabCertAddList(portal){
    const host = byId('collabCertAddList');
    if (!host) return;
    host.innerHTML = '';

    const items = _collabCertAddItems || [];
    if (!items.length){
      const e = document.createElement('div');
      e.className = 'card-sub';
      e.textContent = 'Aucune certification à afficher.';
      host.appendChild(e);
      return;
    }

    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'sb-row-card';

      const left = document.createElement('div');
      left.className = 'sb-row-left';

      const main = document.createElement('div');
      main.style.minWidth = '0';

      const title = document.createElement('div');
      title.className = 'sb-row-title';
      title.textContent = it.nom_certification || '';

      const meta = document.createElement('div');
      meta.className = 'card-sub';
      meta.style.margin = '4px 0 0 0';
      meta.textContent = (it.categorie || 'Sans catégorie').toString();

      main.appendChild(title);
      main.appendChild(meta);
      left.appendChild(main);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sb-btn sb-btn--accent sb-btn--xs';
      btn.textContent = 'Ajouter';
      btn.addEventListener('click', async () => {
        try {
          btn.disabled = true;
          await addCertificationToCollaborateur(portal, it.id_certification);
        } catch (e) {
          btn.disabled = false;
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e));
        }
      });

      row.appendChild(left);
      row.appendChild(btn);

      host.appendChild(row);
    });
  }

  async function loadCollabCertAddList(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const url =
      `${portal.apiBase}/studio/collaborateurs/certifications_catalogue/${encodeURIComponent(ownerId)}` +
      `?q=${encodeURIComponent(_collabCertAddSearch)}` +
      `&categorie=${encodeURIComponent(_collabCertAddCategory)}`;

    const data = await portal.apiJson(url);
    let items = Array.isArray(data?.items) ? data.items : [];

    const existing = new Set(
      (_collabCertItems || [])
        .map(x => (x.id_certification || '').toString().trim())
        .filter(Boolean)
    );

    items = items.filter(it => {
      const idCert = (it.id_certification || '').toString().trim();
      return idCert && !existing.has(idCert);
    });

    _collabCertAddItemsAll = items;
    refreshCollabCertAddCategoryOptions(_collabCertAddItemsAll);
    _collabCertAddItems = applyCollabCertAddCategoryFilter(_collabCertAddItemsAll);
    renderCollabCertAddList(portal);
  }


  async function loadCollabCertCreateCategories(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const url = `${portal.apiBase}/studio/collaborateurs/certifications_catalogue/${encodeURIComponent(ownerId)}?q=`;
    const data = await portal.apiJson(url);

    const list = byId('collabCertCreateCategoryList');
    if (!list) return;

    const values = Array.from(
      new Set(
        (data.items || [])
          .map(it => (it.categorie || '').toString().trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

    list.innerHTML = '';
    values.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      list.appendChild(opt);
    });
  }

  async function openCollabCertCreateModal(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    closeModal('modalCollabCertAdd');

    byId('collabCertCreateName').value = (_collabCertAddSearch || '').trim();
    byId('collabCertCreateCategory').value =
      (_collabCertAddCategory && _collabCertAddCategory !== '__none__')
        ? _collabCertAddCategory
        : '';
    byId('collabCertCreateValidity').value = '';
    byId('collabCertCreateRenewal').value = '';
    byId('collabCertCreateDescription').value = '';

    openModal('modalCollabCertCreate');
    await loadCollabCertCreateCategories(portal);
  }

  function closeCollabCertCreateModal(reopenAdd){
    closeModal('modalCollabCertCreate');
    if (reopenAdd) openModal('modalCollabCertAdd');
  }

  async function saveCollabCertCreate(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const nom = (byId('collabCertCreateName')?.value || '').trim();
    const categorie = (byId('collabCertCreateCategory')?.value || '').trim() || null;
    const description = (byId('collabCertCreateDescription')?.value || '').trim() || null;

    if (!nom){
      portal.showAlert('error', 'Le nom de la certification est obligatoire.');
      return;
    }

    const rawValidity = (byId('collabCertCreateValidity')?.value || '').trim();
    const rawRenewal = (byId('collabCertCreateRenewal')?.value || '').trim();

    let duree_validite = null;
    let delai_renouvellement = null;

    if (rawValidity){
      if (!/^\d+$/.test(rawValidity)) {
        portal.showAlert('error', 'La validité catalogue doit être un entier positif.');
        return;
      }
      duree_validite = parseInt(rawValidity, 10);
      if (!Number.isFinite(duree_validite) || duree_validite <= 0){
        portal.showAlert('error', 'La validité catalogue doit être supérieure à 0.');
        return;
      }
    }

    if (rawRenewal){
      if (!/^\d+$/.test(rawRenewal)) {
        portal.showAlert('error', 'Le délai de renouvellement doit être un entier positif.');
        return;
      }
      delai_renouvellement = parseInt(rawRenewal, 10);
      if (!Number.isFinite(delai_renouvellement) || delai_renouvellement <= 0){
        portal.showAlert('error', 'Le délai de renouvellement doit être supérieur à 0.');
        return;
      }
    }

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/certifications_catalogue/${encodeURIComponent(ownerId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nom_certification: nom,
          categorie: categorie,
          description: description,
          duree_validite: duree_validite,
          delai_renouvellement: delai_renouvellement
        })
      }
    );

    const it = data?.item || {};

    closeModal('modalCollabCertCreate');
    closeModal('modalCollabCertAdd');

    const addRes = await addCertificationToCollaborateur(
      portal,
      it.id_certification,
      { closeModal: false }
    );

    const addedId = String(addRes?.id_effectif_certification || '').trim();
    const addedItem =
      (_collabCertItems || []).find(x => String(x?.id_effectif_certification || '').trim() === addedId)
      || (_collabCertItems || []).find(x => String(x?.id_certification || '').trim() === String(it.id_certification || '').trim())
      || null;

    if (addedItem){
      openCollabCertEditModal(addedItem);
    }
  }

  async function openCollabCertAddModal(portal){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");
    resetCollabCertAddState();
    openModal('modalCollabCertAdd');
    await loadCollabCertAddList(portal);
  }

  async function addCertificationToCollaborateur(portal, idCertification, opts = {}){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const res = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/add`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_certification: idCertification
        })
      }
    );

    if (opts?.closeModal !== false) {
      closeModal('modalCollabCertAdd');
    }

    _tabLoaded.certs = false;
    await loadTabIfNeeded(portal, 'certs');

    return res;
  }

  function resetCollabCertEditState(){
    _collabCertEditState = {
      id_effectif_certification: "",
      id_certification: "",
      id_preuve_doc: "",
      preuve_nom_fichier: "",
      proofFile: null,
    };

    if (byId('collabCertEditTitle')) byId('collabCertEditTitle').textContent = '—';
    if (byId('collabCertEtat')) byId('collabCertEtat').value = 'a_obtenir';
    if (byId('collabCertDateObtention')) byId('collabCertDateObtention').value = '';
    if (byId('collabCertDateExpiration')) byId('collabCertDateExpiration').value = '';
    if (byId('collabCertOrganisme')) byId('collabCertOrganisme').value = '';
    if (byId('collabCertReference')) byId('collabCertReference').value = '';
    if (byId('collabCertCommentaire')) byId('collabCertCommentaire').value = '';
    if (byId('collabCertProofFile')) byId('collabCertProofFile').value = '';

    refreshCollabCertProofUi();
  }

  function refreshCollabCertProofUi(){
    const nameEl = byId('collabCertProofName');
    const metaEl = byId('collabCertProofMeta');
    const openBtn = byId('btnCollabCertProofOpen');

    if (_collabCertEditState.proofFile){
      if (nameEl) nameEl.textContent = _collabCertEditState.proofFile.name || 'Document sélectionné';
      if (metaEl) metaEl.textContent = 'Le document sera enregistré avec la certification.';
      if (openBtn) openBtn.disabled = true;
      return;
    }

    if (_collabCertEditState.preuve_nom_fichier){
      if (nameEl) nameEl.textContent = _collabCertEditState.preuve_nom_fichier;
      if (metaEl) metaEl.textContent = 'Document preuve déjà enregistré.';
      if (openBtn) openBtn.disabled = false;
      return;
    }

    if (nameEl) nameEl.textContent = 'Aucun document preuve';
    if (metaEl) metaEl.textContent = 'PDF, PNG, JPEG ou WEBP · 5 Mo max.';
    if (openBtn) openBtn.disabled = true;
  }

  function openCollabCertEditModal(item){
    resetCollabCertEditState();

    _collabCertEditState.id_effectif_certification = String(item?.id_effectif_certification || '').trim();
    _collabCertEditState.id_certification = String(item?.id_certification || '').trim();
    _collabCertEditState.id_preuve_doc = String(item?.id_preuve_doc || '').trim();
    _collabCertEditState.preuve_nom_fichier = String(item?.preuve_nom_fichier || '').trim();

    if (byId('collabCertEditTitle')) byId('collabCertEditTitle').textContent = item?.nom_certification || 'Certification';
    if (byId('collabCertEtat')) byId('collabCertEtat').value = String(item?.etat || 'a_obtenir').trim() || 'a_obtenir';
    if (byId('collabCertDateObtention')) byId('collabCertDateObtention').value = item?.date_obtention || '';
    if (byId('collabCertDateExpiration')) byId('collabCertDateExpiration').value = item?.date_expiration || '';
    if (byId('collabCertOrganisme')) byId('collabCertOrganisme').value = item?.organisme || '';
    if (byId('collabCertReference')) byId('collabCertReference').value = item?.reference || '';
    if (byId('collabCertCommentaire')) byId('collabCertCommentaire').value = item?.commentaire || '';

    refreshCollabCertProofUi();
    openModal('modalCollabCertEdit');
  }

  async function openCollabCertProof(portal){
    if (!_editingId) throw new Error('Collaborateur introuvable.');
    if (!_collabCertEditState.id_effectif_certification) throw new Error('Certification introuvable.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    await openFetchedBinary(
      `${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(_collabCertEditState.id_effectif_certification)}/preuve`
    );
  }

  async function uploadCollabCertProof(portal, idEffectifCertification, fileObj){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');
    if (!idEffectifCertification) throw new Error('Certification introuvable.');
    if (!fileObj) return null;

    const fd = new FormData();
    fd.append('file', fileObj);

    return await fetchAuthJson(
      `${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(idEffectifCertification)}/preuve`,
      {
        method: 'POST',
        body: fd,
      }
    );
  }

  async function saveCollabCertEdit(portal){
    if (!_editingId) throw new Error('Collaborateur introuvable.');
    if (!_collabCertEditState.id_effectif_certification) throw new Error('Certification introuvable.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(_collabCertEditState.id_effectif_certification)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          etat: byId('collabCertEtat')?.value || 'a_obtenir',
          date_obtention: byId('collabCertDateObtention')?.value || null,
          date_expiration: byId('collabCertDateExpiration')?.value || null,
          organisme: byId('collabCertOrganisme')?.value || null,
          reference: byId('collabCertReference')?.value || null,
          commentaire: byId('collabCertCommentaire')?.value || null,
        })
      }
    );

    if (_collabCertEditState.proofFile){
      await uploadCollabCertProof(portal, _collabCertEditState.id_effectif_certification, _collabCertEditState.proofFile);
    }

    closeModal('modalCollabCertEdit');
    _tabLoaded.certs = false;
    await loadTabIfNeeded(portal, 'certs');
  }

  async function archiveCertificationForCollaborateur(portal, idEffectifCertification){
    if (!_editingId) throw new Error('Collaborateur introuvable.');
    if (!idEffectifCertification) throw new Error('Certification introuvable.');
    if (!window.confirm('Archiver cette certification ?')) return;

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(idEffectifCertification)}/archive`,
      { method: 'POST' }
    );

    _tabLoaded.certs = false;
    await loadTabIfNeeded(portal, 'certs');
  }

  function setCollabSkillEvalMsg(isOk, text){
    const el = byId('collabSkillEvalSaveMsg');
    if (!el) return;

    if (!text){
      el.style.display = 'none';
      el.textContent = '';
      el.style.fontWeight = '';
      el.style.whiteSpace = '';
      el.style.padding = '';
      el.style.borderRadius = '';
      el.style.border = '';
      el.style.background = '';
      el.style.color = '';
      return;
    }

    el.style.display = 'inline-block';
    el.textContent = text;
    el.style.fontWeight = '600';
    el.style.whiteSpace = 'nowrap';
    el.style.padding = '6px 10px';
    el.style.borderRadius = '10px';
    el.style.border = '1px solid ' + (isOk ? '#0a7a2f' : '#b42318');
    el.style.background = isOk ? 'rgba(10,122,47,.08)' : 'rgba(180,35,24,.08)';
    el.style.color = isOk ? '#0a7a2f' : '#b42318';
  }

  function resetCollabSkillEvalModal(){
    _collabSkillEvalState = {
      id_effectif_competence: "",
      id_comp: "",
      grille_evaluation: null,
      last_audit: null
    };

    if (byId('collabSkillEvalHint')) byId('collabSkillEvalHint').textContent = 'Chargement…';
    const codeBadge = byId('collabSkillEvalCompCode');
    if (codeBadge){
      codeBadge.textContent = '';
      codeBadge.style.display = 'none';
    }

    if (byId('collabSkillEvalCompTitle')) byId('collabSkillEvalCompTitle').textContent = '—';
    if (byId('collabSkillEvalCurrent')) byId('collabSkillEvalCurrent').textContent = '—';
    if (byId('collabSkillEvalLastEval')) byId('collabSkillEvalLastEval').textContent = '—';
    if (byId('collabSkillEvalLastAuditMeta')) byId('collabSkillEvalLastAuditMeta').textContent = '';

    const domain = byId('collabSkillEvalCompDomain');
    if (domain){
      domain.textContent = '';
      domain.style.display = 'none';
      domain.style.background = '';
      domain.style.border = '';
      domain.style.color = '';
      domain.style.padding = '';
      domain.style.borderRadius = '';
      domain.style.fontSize = '';
      domain.style.lineHeight = '';
    }

    for (let i = 1; i <= 4; i++) {
      const tr = document.querySelector(`#modalCollabSkillEval tr[data-crit="${i}"]`);
      if (tr) tr.style.display = '';

      const lbl = byId(`collabSkillEvalCritLabel${i}`);
      if (lbl) lbl.textContent = '—';

      const sel = byId(`collabSkillEvalCritNote${i}`);
      if (sel){
        sel.value = '';
        sel.disabled = true;
      }

      const com = byId(`collabSkillEvalCritCom${i}`);
      if (com){
        com.value = '';
        com.disabled = true;
      }
    }

    if (byId('collabSkillEvalScoreRaw')) byId('collabSkillEvalScoreRaw').textContent = '—';
    if (byId('collabSkillEvalScore24')) byId('collabSkillEvalScore24').textContent = '—';
    if (byId('collabSkillEvalLevel')) byId('collabSkillEvalLevel').textContent = '—';

    const methodSel = byId('collabSkillEvalMethod');
    if (methodSel){
      methodSel.value = '';
      methodSel.disabled = true;
    }

    const obs = byId('collabSkillEvalObservation');
    if (obs){
      obs.value = '';
      obs.disabled = true;
    }

    refreshCollabSkillEvalSaveState();

    setCollabSkillEvalMsg(false, '');
  }

  function normalizeStudioColor(raw){
    const s = String(raw || '').trim();
    if (!s) return '';

    if (s.startsWith('#') || s.startsWith('rgb') || s.startsWith('hsl')) return s;

    if (/^-?\d+$/.test(s)){
      const n = parseInt(s, 10);
      const u = (n >>> 0);
      const r = (u >> 16) & 255;
      const g = (u >> 8) & 255;
      const b = u & 255;
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }

    return s;
  }

  function pickStudioTextColor(bg){
    const s = String(bg || '').trim();
    if (!s.startsWith('#') || s.length !== 7) return '#111827';

    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    return lum >= 160 ? '#111827' : '#fff';
  }

  function colorToRgbTriplet(raw){
    const s = normalizeStudioColor(raw);
    if (!s) return '';

    if (/^#([0-9a-f]{6})$/i.test(s)){
      const hex = s.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `${r},${g},${b}`;
    }

    const m = s.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    if (m){
      return `${m[1]},${m[2]},${m[3]}`;
    }

    return '';
  }

  function ensureCollabSkillGuidePopover(){
    let pop = document.getElementById('collabSkillGuidePopover');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'collabSkillGuidePopover';
    pop.className = 'card';
    pop.style.position = 'fixed';
    pop.style.zIndex = '10050';
    pop.style.display = 'none';
    pop.style.maxWidth = '460px';
    pop.style.padding = '12px';
    pop.style.boxShadow = '0 12px 28px rgba(0,0,0,.18)';
    pop.style.border = '1px solid #e5e7eb';
    pop.style.borderRadius = '12px';

    pop.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="font-weight:var(--ns-weight-semibold, 600);">Guide de notation</div>
        <button type="button" class="sb-modal-x" id="btnCloseCollabSkillGuide" aria-label="Fermer">×</button>
      </div>
      <div class="card-sub" id="collabSkillGuideTitle" style="margin-top:6px;"></div>
      <div id="collabSkillGuideBody" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;"></div>
    `;

    document.body.appendChild(pop);

    const close = () => closeCollabSkillGuidePopover();
    document.getElementById('btnCloseCollabSkillGuide')?.addEventListener('click', close);

    document.addEventListener('click', (ev) => {
      const p = document.getElementById('collabSkillGuidePopover');
      if (!p || p.style.display === 'none') return;
      const t = ev.target;
      if (p.contains(t)) return;
      if (t && t.closest && t.closest('.collab-skill-crit-help')) return;
      close();
    });

    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);

    return pop;
  }

  function closeCollabSkillGuidePopover(){
    const pop = document.getElementById('collabSkillGuidePopover');
    if (!pop) return;
    pop.style.display = 'none';
  }

  function openCollabSkillGuidePopover(anchorEl, critIndex, critLabel, evals, selectedNote){
    const pop = ensureCollabSkillGuidePopover();
    if (!pop || !anchorEl) return;

    const tr = anchorEl.closest('tr');
    const noteSelect = tr ? tr.querySelector('select[id^="collabSkillEvalCritNote"]') : null;

    const title = document.getElementById('collabSkillGuideTitle');
    if (title){
      const lbl = String(critLabel || '').trim();
      title.textContent = lbl ? `Critère ${critIndex} : ${lbl}` : `Critère ${critIndex}`;
    }

    const body = document.getElementById('collabSkillGuideBody');
    if (body) body.innerHTML = '';

    const arr = Array.isArray(evals) ? evals : [];

    for (let i = 1; i <= 4; i++) {
      const txt = (arr[i - 1] || '').toString().trim();

      const line = document.createElement('div');
      line.style.display = 'flex';
      line.style.gap = '10px';
      line.style.alignItems = 'flex-start';
      line.style.padding = '8px 10px';
      line.style.border = '1px solid #e5e7eb';
      line.style.borderRadius = '10px';
      line.style.cursor = 'pointer';
      line.style.background = (String(selectedNote || '') === String(i)) ? 'rgba(230,228,33,.14)' : '#fff';

      const badge = document.createElement('span');
      badge.className = 'sb-badge sb-badge--accent-soft';
      badge.textContent = String(i);
      badge.style.minWidth = '28px';
      badge.style.justifyContent = 'center';

      const text = document.createElement('div');
      text.style.flex = '1';
      text.style.minWidth = '0';
      text.textContent = txt || '—';

      line.appendChild(badge);
      line.appendChild(text);

      line.addEventListener('click', () => {
        if (noteSelect && !noteSelect.disabled) {
          noteSelect.value = String(i);
          noteSelect.dispatchEvent(new Event('input', { bubbles: true }));
          noteSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeCollabSkillGuidePopover();
      });

      if (body) body.appendChild(line);
    }

    pop.style.display = 'block';
    pop.style.left = '0px';
    pop.style.top = '0px';

    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth || 360;
    const ph = pop.offsetHeight || 220;
    const pad = 10;

    let left = r.left;
    let top = r.bottom + 8;

    if (left + pw > window.innerWidth - pad) left = window.innerWidth - pw - pad;
    if (left < pad) left = pad;

    if (top + ph > window.innerHeight - pad) {
      top = r.top - ph - 8;
      if (top < pad) top = pad;
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function getCollabSkillEvalEnabledCriteria(){
    const arr = [];
    for (let i = 1; i <= 4; i++) {
      const lbl = (byId(`collabSkillEvalCritLabel${i}`)?.textContent || '').trim();
      const sel = byId(`collabSkillEvalCritNote${i}`);
      const com = byId(`collabSkillEvalCritCom${i}`);
      if (!sel) continue;
      if (!lbl || lbl === '—') continue;
      if (sel.disabled) continue;

      arr.push({
        idx: i,
        code_critere: `Critere${i}`,
        select: sel,
        input: com
      });
    }
    return arr;
  }

  function computeCollabSkillEvalScore(sum, nbCrit){
    let coef = 1;
    if (nbCrit === 4) coef = 1.5;
    else if (nbCrit === 3) coef = 2;
    else if (nbCrit === 2) coef = 3;
    else if (nbCrit === 1) coef = 6;

    return { coef, score24: Math.round((sum * coef) * 10) / 10 };
  }

  function levelFromCollabSkillEvalScore(score24){
    const key = nsLevelFromScore24(score24);
    return key ? nsLevelLabel(key) : '—';
  }

  function levelCodeFromCollabSkillEvalScore(score24){
    return nsLevelFromScore24(score24);
  }

  function score24ToMasteryPct(score24){
    const n = Number(score24);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round((n / 24) * 100)));
  }

  function getCollabSkillEvalMethods(){
    return [
      'Observation en situation de travail',
      'Entretien professionnel',
      'Retour manager / tuteur',
      'Retour formation',
      'Examen / Certification'
    ];
  }

  function normalizeCollabSkillEvalMethod(value){
    const raw = String(value || '').trim();
    if (!raw) return '';
    return getCollabSkillEvalMethods().find(x => x === raw) || '';
  }

  function refreshCollabSkillEvalSaveState(){
    const btn = byId('btnCollabSkillEvalSave');
    if (!btn) return;

    const enabledCount = getCollabSkillEvalEnabledCriteria().length;
    const methodValue = normalizeCollabSkillEvalMethod(byId('collabSkillEvalMethod')?.value || '');

    btn.disabled = enabledCount === 0 || !methodValue;
  }

  function recalcCollabSkillEvalScore(){
    if (!_collabSkillEvalState.id_effectif_competence) return;

    const enabled = getCollabSkillEvalEnabledCriteria();
    const rawEl = byId('collabSkillEvalScoreRaw');
    const scoreEl = byId('collabSkillEvalScore24');
    const levelEl = byId('collabSkillEvalLevel');

    if (!enabled.length){
      if (rawEl) rawEl.textContent = '—';
      if (scoreEl) scoreEl.textContent = '—';
      if (levelEl) levelEl.textContent = '—';
      refreshCollabSkillEvalSaveState();
      return;
    }

    let sum = 0;
    let filled = 0;

    enabled.forEach(c => {
      const v = (c.select.value || '').trim();
      if (!v) return;
      const note = parseInt(v, 10);
      if (!Number.isNaN(note)) {
        sum += note;
        filled += 1;
      }
    });

    const calc = computeCollabSkillEvalScore(sum, enabled.length);

    if (!filled){
      if (rawEl) rawEl.textContent = '—';
      if (scoreEl) scoreEl.textContent = '—';
      if (levelEl) levelEl.textContent = '—';
      refreshCollabSkillEvalSaveState();
      return;
    }

    if (rawEl) rawEl.textContent = String(sum);

    const masteryPct = score24ToMasteryPct(calc.score24);
    if (scoreEl) {
      scoreEl.textContent = masteryPct == null ? '—' : `${masteryPct} %`;
    }

    if (filled === enabled.length) {
      if (levelEl) levelEl.textContent = collabSkillLevelLabel(levelFromCollabSkillEvalScore(calc.score24));
    } else {
      if (levelEl) levelEl.textContent = '—';
    }

    refreshCollabSkillEvalSaveState();
  }

  function fillCollabSkillEvalModal(data){
    _collabSkillEvalState = {
      id_effectif_competence: String(data?.id_effectif_competence || '').trim(),
      id_comp: String(data?.id_comp || '').trim(),
      grille_evaluation: data?.grille_evaluation || {},
      last_audit: data?.last_audit || null
    };

    if (byId('collabSkillEvalHint')) {
      byId('collabSkillEvalHint').textContent = data?.last_audit?.id_audit_competence
        ? 'Dernier audit rechargé. Modifiez puis enregistrez si nécessaire.'
        : 'Aucun audit existant. Renseignez l’évaluation puis enregistrez.';
    }

    const codeTxt = (data?.code || '').toString().trim();
    const titleTxt = (data?.intitule || '').toString().trim();

    const codeBadge = byId('collabSkillEvalCompCode');
    if (codeBadge){
      codeBadge.textContent = codeTxt || '';
      codeBadge.style.display = codeTxt ? 'inline-flex' : 'none';
    }

    if (byId('collabSkillEvalCompTitle')) {
      byId('collabSkillEvalCompTitle').textContent = titleTxt || '—';
    }

    if (byId('collabSkillEvalCurrent')) {
      byId('collabSkillEvalCurrent').textContent = collabSkillLevelLabel(data?.niveau_actuel || '—');
    }

    if (byId('collabSkillEvalLastEval')) {
      byId('collabSkillEvalLastEval').textContent = data?.date_derniere_eval
        ? `Dernière éval : ${formatDateFR(data.date_derniere_eval)}`
        : 'Jamais évaluée';
    }

    if (byId('collabSkillEvalLastAuditMeta')) {
      const parts = [];
      if (data?.last_audit?.date_audit) parts.push(formatDateFR(data.last_audit.date_audit));
      if (data?.last_audit?.nom_evaluateur) parts.push(data.last_audit.nom_evaluateur);
      if (data?.last_audit?.methode_eval) parts.push(data.last_audit.methode_eval);

      byId('collabSkillEvalLastAuditMeta').textContent = parts.length
        ? `Dernier audit : ${parts.join(' • ')}`
        : '';
    }

    const domain = byId('collabSkillEvalCompDomain');
    if (domain){
      const label = (
        data?.domaine_titre ||
        data?.domaine ||
        ''
      ).toString().trim();

      domain.innerHTML = '';
      domain.style.display = label ? 'inline-flex' : 'none';
      domain.style.removeProperty('--sb-domain-rgb');

      const rgb = colorToRgbTriplet(data?.domaine_couleur);
      if (rgb){
        domain.style.setProperty('--sb-domain-rgb', rgb);
      }

      if (label){
        domain.innerHTML = `<span class="sb-dot"></span><span>${esc(label)}</span>`;
      }
    }

    const grid = (data?.grille_evaluation && typeof data.grille_evaluation === 'object') ? data.grille_evaluation : {};
    const keys = Object.keys(grid).sort((a, b) => {
      const ma = String(a).match(/(\d+)/);
      const mb = String(b).match(/(\d+)/);
      return (ma ? parseInt(ma[1], 10) : 999) - (mb ? parseInt(mb[1], 10) : 999);
    });

    const savedCriteria = Array.isArray(data?.last_audit?.detail_eval?.criteres)
      ? data.last_audit.detail_eval.criteres
      : [];

    let enabledCount = 0;

    for (let i = 1; i <= 4; i++) {
      const key = keys[i - 1];
      const cfg = key ? (grid[key] || {}) : null;

      const label = cfg ? (cfg.Nom ?? cfg.nom ?? '').toString().trim() : '';
      const evalsRaw = cfg ? (Array.isArray(cfg.Eval || cfg.eval) ? (cfg.Eval || cfg.eval) : []) : [];
      const evalsAll = evalsRaw.map(v => (v ?? '').toString().trim());
      const evalsNonEmpty = evalsAll.filter(v => v.length > 0);

      const enabled = !!key && (label.length > 0 || evalsNonEmpty.length > 0);

      const tr = document.querySelector(`#modalCollabSkillEval tr[data-crit="${i}"]`);
      const lbl = byId(`collabSkillEvalCritLabel${i}`);
      const sel = byId(`collabSkillEvalCritNote${i}`);
      const com = byId(`collabSkillEvalCritCom${i}`);

      if (tr) tr.style.display = enabled ? '' : 'none';

      if (!enabled){
        if (lbl) lbl.textContent = '—';
        if (sel){
          sel.value = '';
          sel.disabled = true;
        }
        if (com){
          com.value = '';
          com.disabled = true;
        }
        continue;
      }

      if (lbl){
        lbl.innerHTML = '';

        const txt = document.createElement('span');
        txt.textContent = label || key || '';
        lbl.appendChild(txt);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'collab-skill-crit-help';
        btn.textContent = 'i';
        btn.title = 'Guide de notation';
        btn.setAttribute('aria-label', 'Guide de notation');
        btn.style.marginLeft = '10px';
        btn.style.width = '22px';
        btn.style.height = '22px';
        btn.style.borderRadius = '999px';
        btn.style.border = '1px solid #d1d5db';
        btn.style.background = '#fff';
        btn.style.color = '#111';
        btn.style.fontWeight = '700';
        btn.style.fontSize = '13px';
        btn.style.lineHeight = '20px';
        btn.style.padding = '0';
        btn.style.cursor = 'pointer';

        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openCollabSkillGuidePopover(btn, i, label, evalsAll, sel ? (sel.value || '') : '');
        });

        lbl.appendChild(btn);
      }

      if (sel) sel.disabled = false;
      if (com) com.disabled = false;

      const saved = savedCriteria.find(x => String(x?.code_critere || '').trim() === `Critere${i}`) || null;
      if (sel) sel.value = saved?.niveau != null ? String(saved.niveau) : '';
      if (com) com.value = (saved?.commentaire || '').toString();

      enabledCount += 1;
    }

    const methodSel = byId('collabSkillEvalMethod');
    if (methodSel){
      methodSel.value = normalizeCollabSkillEvalMethod(data?.last_audit?.methode_eval || '');
      methodSel.disabled = enabledCount === 0;
    }

    const obs = byId('collabSkillEvalObservation');
    if (obs){
      obs.disabled = enabledCount === 0;
      obs.value = (data?.last_audit?.observation || '').toString();
    }

    refreshCollabSkillEvalSaveState();

    if (enabledCount === 0 && byId('collabSkillEvalHint')) {
      byId('collabSkillEvalHint').textContent = 'Aucun critère d’évaluation paramétré sur cette compétence.';
    }

    recalcCollabSkillEvalScore();
  }

  async function openCollabSkillEvalModal(portal, idEffectifCompetence){
    if (!_editingId) throw new Error('Enregistrez d’abord le collaborateur.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const idEc = String(idEffectifCompetence || '').trim();
    if (!idEc) throw new Error('Ligne compétence introuvable.');

    resetCollabSkillEvalModal();
    openModal('modalCollabSkillEval');

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/competences/evaluation/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(idEc)}`
    );

    fillCollabSkillEvalModal(data);
  }

  async function saveCollabSkillEval(portal){
    if (!_editingId) throw new Error('Collaborateur introuvable.');
    if (!_collabSkillEvalState.id_effectif_competence) throw new Error('Compétence non sélectionnée.');

    const enabled = getCollabSkillEvalEnabledCriteria();
    if (!enabled.length) throw new Error('Aucun critère actif pour cette compétence.');

    let sum = 0;
    const criteres = [];

    for (const c of enabled) {
      const raw = (c.select.value || '').trim();
      if (!raw) throw new Error('Notes incomplètes : renseigne tous les critères.');

      const note = parseInt(raw, 10);
      if (!note || note < 1 || note > 4) throw new Error('Note invalide (1..4).');

      sum += note;
      criteres.push({
        code_critere: c.code_critere,
        niveau: note,
        commentaire: (c.input?.value || '').trim() || null
      });
    }

    const calc = computeCollabSkillEvalScore(sum, enabled.length);
    const niveau = levelCodeFromCollabSkillEvalScore(calc.score24);
    if (!niveau || niveau === '—') throw new Error('Impossible de déterminer le niveau.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const observation = (byId('collabSkillEvalObservation')?.value || '').trim();

    const methodeEval = normalizeCollabSkillEvalMethod(byId('collabSkillEvalMethod')?.value || '');
    if (!methodeEval) throw new Error("Sélectionnez une méthode d’évaluation.");

    const res = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/competences/evaluation/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/save`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_effectif_competence: _collabSkillEvalState.id_effectif_competence,
          id_comp: _collabSkillEvalState.id_comp,
          resultat_eval: calc.score24,
          niveau_actuel: niveau,
          observation: observation || null,
          criteres,
          methode_eval: methodeEval
        })
      }
    );

    if (byId('collabSkillEvalCurrent')) byId('collabSkillEvalCurrent').textContent = collabSkillLevelLabel(niveau);
    if (byId('collabSkillEvalLastEval')) byId('collabSkillEvalLastEval').textContent = `Dernière éval : ${formatDateFR(res?.date_audit)}`;

    const methodSel = byId('collabSkillEvalMethod');
    if (methodSel){
      methodSel.value = normalizeCollabSkillEvalMethod(res?.methode_eval || methodeEval);
    }

    if (byId('collabSkillEvalLastAuditMeta')) {
      const parts = [];
      if (res?.date_audit) parts.push(formatDateFR(res.date_audit));
      if (res?.nom_evaluateur) parts.push(res.nom_evaluateur);
      if (res?.methode_eval) parts.push(res.methode_eval);
      byId('collabSkillEvalLastAuditMeta').textContent = parts.join(' • ');
    }

    _collabSkillEvalState.last_audit = {
      id_audit_competence: res?.id_audit_competence || '',
      date_audit: res?.date_audit || null,
      nom_evaluateur: res?.nom_evaluateur || null,
      methode_eval: res?.methode_eval || null,
      observation: observation || null,
      detail_eval: { criteres }
    };

    setCollabSkillEvalMsg(true, 'Évaluation enregistrée');

    _tabLoaded.skills = false;
    await loadTabIfNeeded(portal, 'skills');

    closeModal('modalCollabSkillEval');

    return res;
  }

  function getOwnerId(){
    const forced = (window.__collabScopeOwnerId || "").toString().trim();
    if (forced) return forced;

    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;

    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  function setStatus(msg){
    const el = byId("collabStatus");
    if (!el) return;
    const txt = String(msg || "").trim();
    el.textContent = (!txt || txt === "—") ? "Retrouvez et filtrez vos collaborateurs." : txt;
  }

    function htmlEsc(s){
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function getPortalAccessToken(){
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === 'function') {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token || session?.session?.access_token || '';
        if (token) return String(token).trim();
      }
    } catch (_) {}
    return '';
  }

  async function fetchPdfBlob(url){
    const headers = {};
    const token = await getPortalAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const scopedUrl = applyCollabScopeToUrl(url);

    const res = await fetch(scopedUrl, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const js = await res.clone().json();
        detail = js?.detail || js?.message || detail;
      } catch (_) {
        try {
          const txt = await res.text();
          if (txt) detail = txt;
        } catch (_) {}
      }
      throw new Error(detail);
    }

    return await res.blob();
  }

  function openPdfLoadingWindow(title){
    const safeTitle = htmlEsc(title || 'Document PDF');
    const win = window.open('', '_blank');

    if (!win) {
      throw new Error("Le navigateur a bloqué l’ouverture du PDF.");
    }

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    html,body{
      height:100%;
      margin:0;
      background:#f3f4f6;
      font-family:var(--ns-font-ui);
      color:#111827;
    }
    .pdf-loading{
      height:100%;
      display:flex;
      align-items:center;
      justify-content:center;
      flex-direction:column;
      gap:12px;
    }
    .pdf-loading__spinner{
      width:34px;
      height:34px;
      border-radius:999px;
      border:4px solid rgba(17,24,39,.12);
      border-top-color:#355caa;
      animation:pdfSpin .8s linear infinite;
    }
    .pdf-loading__text{
      font-size:var(--ns-text-md, 0.875rem);
      color:#475467;
    }
    iframe{
      width:100%;
      height:100%;
      border:0;
      background:#fff;
    }
    @keyframes pdfSpin{
      to{ transform:rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="pdf-loading">
    <div class="pdf-loading__spinner"></div>
    <div class="pdf-loading__text">Génération du PDF…</div>
  </div>
</body>
</html>`);
    win.document.close();

    return win;
  }

  function renderPdfBlobInWindow(win, blob, title){
    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = htmlEsc(title || 'Document PDF');

    if (!win || win.closed){
      window.open(blobUrl, '_blank');
      setTimeout(() => {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }, 5 * 60 * 1000);
      return;
    }

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    html,body{height:100%;margin:0;background:#f3f4f6;}
    iframe{width:100%;height:100%;border:0;background:#fff;}
  </style>
</head>
<body>
  <iframe src="${blobUrl}" title="${safeTitle}"></iframe>
</body>
</html>`);
    win.document.close();

    const revoke = () => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    };

    try {
      win.addEventListener('beforeunload', revoke, { once: true });
    } catch (_) {}

    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function openCollabSkillSheetPdf(portal, idComp, popupWin){
    if (!_editingId) throw new Error('Collaborateur introuvable.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const compId = String(idComp || '').trim();
    if (!compId) throw new Error('Compétence introuvable.');

    const row = (_collabSkillItems || []).find(x => String(x?.id_comp || '').trim() === compId) || null;
    const title = row
      ? `Fiche compétence - ${String(row.code || '').trim() ? `${row.code} - ` : ''}${String(row.intitule || '').trim() || 'Compétence'}`
      : 'Fiche compétence';

    const url = `${portal.apiBase}/studio/collaborateurs/competences/fiche_pdf/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/${encodeURIComponent(compId)}`;
    const blob = await fetchPdfBlob(url);

    renderPdfBlobInWindow(popupWin, blob, title);
  }

  function setCollabSaveMsg(text){
    const el = byId("collabSaveMsg");
    if (!el) return;

    if (!text){
      el.style.display = "none";
      el.textContent = "Enregistré avec succès";
      return;
    }

    el.textContent = text;
    el.style.display = "inline-block";
  }

  function openModal(id){
    const el = byId(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id){
    const el = byId(id);
    if (el) el.style.display = "none";
  }

  function setDrawerText(id, value, fallback = "–"){
    const el = byId(id);
    if (!el) return;
    const v = String(value ?? "").trim();
    el.textContent = v || fallback;
  }

  function findCollaborateurItem(id){
    const cid = String(id || "").trim();
    if (!cid) return null;

    const pools = [
      Array.isArray(_items) ? _items : [],
      Array.isArray(_globalItems) ? _globalItems : []
    ];

    for (const list of pools){
      const found = list.find(x => String(x?.id_collaborateur || "").trim() === cid);
      if (found) return found;
    }

    return null;
  }

  function drawerStatusLabel(it){
    if (it?.archive) return "Archivé";
    return it?.actif ? "Actif" : "Inactif";
  }

  function drawerStatusClass(it){
    if (it?.archive) return "is-archived";
    return it?.actif ? "is-active" : "is-inactive";
  }

  function renderDrawerRoles(it){
    const roles = [];
    if (it?.ismanager) roles.push('<span class="collab-role-badge collab-role-badge--manager">Manager</span>');
    if (it?.isformateur) roles.push('<span class="collab-role-badge collab-role-badge--formateur">Formateur</span>');
    if (it?.is_temp) roles.push('<span class="collab-role-badge">Temporaire</span>');
    return roles.length ? roles.join('') : '<span class="card-sub" style="margin:0;">—</span>';
  }

  function renderCollabDrawer(it){
    const cid = String(it?.id_collaborateur || "").trim();
    const fullName = collabFullName(it);
    const initials = collabInitials(it?.prenom, it?.nom);
    const avatarTone = collabAvatarTone(cid || fullName);
    const avatar = byId('collabDrawerAvatar');
    const status = byId('collabDrawerStatus');
    const roles = byId('collabDrawerRoles');

    if (avatar){
      avatar.className = `collab-avatar collab-drawer-avatar collab-avatar--${avatarTone}`;
      avatar.textContent = initials;
    }

    setDrawerText('collabDrawerName', fullName, 'Collaborateur');
    setDrawerText('collabDrawerService', it?.nom_service, '—');
    setDrawerText('collabDrawerPoste', splitPosteLabel(it?.poste_label).title, '—');
    setDrawerText('collabDrawerDateEntree', formatDateFR(it?.date_entree), '—');
    setDrawerText('collabDrawerDateSortie', formatDateFR(it?.date_sortie_prevue), '—');
    setDrawerText('collabDrawerContrat', it?.type_contrat, '—');
    setDrawerText('collabDrawerEmail', it?.email, '—');
    setDrawerText('collabDrawerTelephone', formatPhoneFr(it?.telephone || ''), '—');

    if (status){
      status.className = `collab-drawer-status ${drawerStatusClass(it)}`;
      status.textContent = drawerStatusLabel(it);
    }

    if (roles) roles.innerHTML = renderDrawerRoles(it);
  }

  function openCollabDrawer(id){
    const cid = String(id || "").trim();
    const it = findCollaborateurItem(cid);
    if (!it) return;

    _drawerCollaborateurId = cid;
    renderCollabDrawer(it);

    const drawer = byId('collabSideDrawer');
    const backdrop = byId('collabDrawerBackdrop');
    if (backdrop){
      backdrop.classList.add('is-open');
      backdrop.setAttribute('aria-hidden', 'false');
    }
    if (drawer){
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
    }
  }

  function closeCollabDrawer(){
    const drawer = byId('collabSideDrawer');
    const backdrop = byId('collabDrawerBackdrop');
    if (drawer){
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop){
      backdrop.classList.remove('is-open');
      backdrop.setAttribute('aria-hidden', 'true');
    }
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

  function formatLicenseAvailability(item){
    if (item?.is_unlimited) return 'Illimité';
    const available = Number(item?.available_access ?? 0);
    const max = Number(item?.max_access ?? 0);
    return `${Math.max(available, 0)} / ${Math.max(max, 0)}`;
  }

  function renderLicenseKpis(){
    const host = byId('collabLicenseKpis');
    if (!host) return;
    host.innerHTML = '';
    host.style.display = 'none';
  }

    function purgeBulkSendSelection(){
    const allowed = new Set(
      [...(Array.isArray(_globalItems) ? _globalItems : []), ...(Array.isArray(_items) ? _items : [])]
        .map(x => String(x?.id_collaborateur || '').trim())
        .filter(Boolean)
    );

    Array.from(_bulkSendSelectedIds).forEach(id => {
      if (!allowed.has(id)) _bulkSendSelectedIds.delete(id);
    });

    refreshBulkSendButton();
  }

  function refreshBulkSendButton(){
    const btn = byId('btnCollabSendBulk');
    if (!btn) return;

    const count = _bulkSendSelectedIds.size;
    const label = btn.querySelector('.sb-btn-label');
    btn.disabled = count === 0;

    const text = count > 0 ? `Envoyer les accès (${count})` : 'Envoyer les accès';
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  function refreshModalSendButton(){
    const btn = byId('btnCollabSendOne');
    if (!btn) return;

    const activeTabBtn = document.querySelector('#modalCollaborateur [data-tab].is-active');
    const activeTab = (activeTabBtn?.getAttribute('data-tab') || '').trim();

    const show = !!_editingId && activeTab === 'rights';
    btn.style.display = show ? '' : 'none';
  }

  async function sendSingleAccessMail(portal, collaboratorId){
    const ownerId = getOwnerId();
    const cid = String(collaboratorId || '').trim();
    if (!ownerId || !cid) throw new Error("Collaborateur introuvable.");

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/acces/send/${encodeURIComponent(ownerId)}/${encodeURIComponent(cid)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const target = (data?.email || '').trim() || 'le collaborateur';
    portal.showAlert('', `Mail d’accès envoyé à ${target}.`);
    return data;
  }

  async function sendBulkAccessMails(portal){
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error("Owner introuvable.");

    const ids = Array.from(_bulkSendSelectedIds).map(x => String(x || '').trim()).filter(Boolean);
    if (!ids.length) return;

    if (!window.confirm(`Envoyer les accès à ${ids.length} collaborateur(s) sélectionné(s) ?`)) return;

    const data = await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/acces-bulk/send/${encodeURIComponent(ownerId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids_collaborateurs: ids })
      }
    );

    _bulkSendSelectedIds.clear();
    refreshBulkSendButton();

    const sent = Number(data?.sent_count || 0);
    const skipped = Number(data?.skipped_count || 0);
    const errors = Number(data?.error_count || 0);

    let msg = `${sent} mail(s) envoyé(s).`;
    if (skipped > 0) msg += ` ${skipped} ignoré(s).`;
    if (errors > 0) msg += ` ${errors} en erreur.`;

    portal.showAlert('', msg);
    return data;
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

  function _normLoose(v){
    return String(v || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  async function ensureCollabNsfGroupes(portal){
    if (_nsfGroupesLoaded) return;
    _nsfGroupesLoaded = true;

    try{
      const ownerId = getOwnerId();
      if (!ownerId){
        _nsfGroupes = [];
        return;
      }

      const data = await portal.apiJson(`${portal.apiBase}/studio/org/nsf_groupes/${encodeURIComponent(ownerId)}`);
      _nsfGroupes = Array.isArray(data?.items) ? data.items : [];
    } catch(_){
      _nsfGroupes = [];
    }
  }

  function fillCollabEducationSelects(){
    fillSelect(byId("collabNiveauEdu"), [
      { value: "", label: "—" },
      { value: "0", label: "Aucun diplôme" },
      { value: "3", label: "Niveau 3 : CAP, BEP" },
      { value: "4", label: "Niveau 4 : Bac" },
      { value: "5", label: "Niveau 5 : Bac+2 (BTS, DUT)" },
      { value: "6", label: "Niveau 6 : Bac+3 (Licence, BUT)" },
      { value: "7", label: "Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)" },
      { value: "8", label: "Niveau 8 : Bac+8 (Doctorat)" }
    ], "value", "label");

    const items = (_nsfGroupes || []).map(x => {
      const code = String(x?.code || "").trim();
      const titre = String(x?.titre || "").trim();
      return {
        value: code,
        label: (titre && code) ? `${titre} (${code})` : (titre || code),
        titre
      };
    });

    fillSelect(byId("collabDomaineEdu"), items, "value", "label", "", "—");

    const sel = byId("collabDomaineEdu");
    if (sel){
      Array.from(sel.options || []).forEach((opt, idx) => {
        if (idx === 0) return;
        const item = items[idx - 1] || {};
        opt.dataset.code = item.value || "";
        opt.dataset.titre = item.titre || "";
      });
    }
  }

  function setSelectValueLoose(id, value){
    const el = byId(id);
    if (!el) return;

    const raw = String(value || "").trim();
    if (!raw){
      el.value = "";
      return;
    }

    const opts = Array.from(el.options || []);
    const direct = opts.find(opt => String(opt.value || "").trim() === raw);
    if (direct){
      el.value = direct.value;
      return;
    }

    const n = _normLoose(raw);
    const loose = opts.find(opt => {
      const ov = _normLoose(opt.value || "");
      const ot = _normLoose(opt.textContent || "");
      const oc = _normLoose(opt.dataset.code || "");
      const od = _normLoose(opt.dataset.titre || "");
      return ov === n || ot === n || oc === n || od === n || ot.includes(n) || od.includes(n);
    });

    el.value = loose ? loose.value : "";
  }

  async function hydrateFormSelects(portal){
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

    await ensureCollabNsfGroupes(portal);
    fillCollabEducationSelects();
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


  function normalizeCollabSortValue(value){
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function collabFullName(it){
    return `${it?.prenom || ''} ${it?.nom || ''}`.trim() || 'Collaborateur sans nom';
  }

  function getCollabSortValue(it, key){
    if (key === 'collaborateur') return normalizeCollabSortValue(collabFullName(it));
    if (key === 'service') return normalizeCollabSortValue(it?.nom_service || '');
    if (key === 'poste') return normalizeCollabSortValue(splitPosteLabel(it?.poste_label).title || it?.poste_label || '');
    if (key === 'roles') {
      const archived = !!it?.archive;
      const active = !!it?.actif && !archived;
      const status = archived ? 'archive' : (active ? 'actif' : 'inactif');
      return normalizeCollabSortValue(`${status} ${it?.ismanager ? 'manager' : ''} ${it?.isformateur ? 'formateur' : ''}`);
    }
    if (key === 'access') {
      const summary = Array.isArray(it?.access_summary) ? it.access_summary : [];
      return normalizeCollabSortValue(summary.map(x => `${x?.console || ''} ${x?.actif ? '1' : '0'}`).join(' '));
    }
    return '';
  }

  function getSortedCollaborateurs(items){
    const arr = Array.isArray(items) ? items.slice() : [];
    const dir = _sortDir === 'desc' ? -1 : 1;
    const key = _sortKey || 'collaborateur';

    arr.sort((a, b) => {
      const va = getCollabSortValue(a, key);
      const vb = getCollabSortValue(b, key);
      const cmp = va.localeCompare(vb, 'fr', { sensitivity: 'base', numeric: true });
      if (cmp !== 0) return cmp * dir;
      return normalizeCollabSortValue(collabFullName(a)).localeCompare(normalizeCollabSortValue(collabFullName(b)), 'fr', { sensitivity: 'base', numeric: true });
    });

    return arr;
  }

  function getCollabPageData(items){
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const size = Math.max(1, Number(_pageSize) || 25);
    const totalPages = Math.max(1, Math.ceil(total / size));
    if (_page > totalPages) _page = totalPages;
    if (_page < 1) _page = 1;

    const start = total ? ((_page - 1) * size) : 0;
    const end = Math.min(start + size, total);
    return {
      total,
      totalPages,
      page: _page,
      pageSize: size,
      start,
      end,
      items: list.slice(start, end)
    };
  }

  function buildCollabPaginationTokens(totalPages, page){
    if (totalPages <= 5) {
      const all = [];
      for (let i = 1; i <= totalPages; i += 1) all.push(i);
      return all;
    }

    const tokens = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);

    if (start > 2) tokens.push('ellipsis-left');
    for (let i = start; i <= end; i += 1) tokens.push(i);
    if (end < totalPages - 1) tokens.push('ellipsis-right');
    tokens.push(totalPages);
    return tokens;
  }

  function renderCollabSortHead(key, label){
    const active = _sortKey === key;
    const dir = active ? _sortDir : '';
    const ariaSort = active ? (_sortDir === 'desc' ? 'descending' : 'ascending') : 'none';
    return `
      <button type="button" class="collab-sort-head${active ? ' is-active' : ''}" data-sort-collab="${esc(key)}" aria-sort="${ariaSort}">
        <span>${esc(label)}</span>
        <span class="collab-sort-arrows" aria-hidden="true">
          <span class="collab-sort-arrow collab-sort-arrow--up${active && dir === 'asc' ? ' is-active' : ''}">▲</span>
          <span class="collab-sort-arrow collab-sort-arrow--down${active && dir === 'desc' ? ' is-active' : ''}">▼</span>
        </span>
      </button>
    `;
  }

  function renderCollabPagination(pageData){
    const total = pageData.total || 0;
    const totalPages = pageData.totalPages || 1;
    const page = pageData.page || 1;
    const prevDisabled = page <= 1 ? ' disabled' : '';
    const nextDisabled = page >= totalPages ? ' disabled' : '';
    const tokens = buildCollabPaginationTokens(totalPages, page);
    const range = total ? `${pageData.start + 1} – ${pageData.end} sur ${total}` : '0 sur 0';

    return `
      <div class="collab-page-size-wrap">
        <select class="sb-select collab-page-size-select" data-collab-page-size aria-label="Nombre d'éléments par page">
          <option value="25"${_pageSize === 25 ? ' selected' : ''}>25 par page</option>
          <option value="50"${_pageSize === 50 ? ' selected' : ''}>50 par page</option>
          <option value="100"${_pageSize === 100 ? ' selected' : ''}>100 par page</option>
        </select>
      </div>
      <div class="collab-pagination" aria-label="Pagination collaborateurs">
        <button type="button" class="sb-icon-btn collab-page-nav" data-page-nav="prev" title="Page précédente" aria-label="Page précédente"${prevDisabled}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        ${tokens.map(t => {
          if (typeof t === 'string') return '<span class="collab-page-ellipsis" aria-hidden="true">…</span>';
          return `<button type="button" class="collab-page-btn${t === page ? ' is-active' : ''}" data-page="${t}" aria-label="Page ${t}" aria-current="${t === page ? 'page' : 'false'}">${t}</button>`;
        }).join('')}
        <button type="button" class="sb-icon-btn collab-page-nav" data-page-nav="next" title="Page suivante" aria-label="Page suivante"${nextDisabled}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      </div>
      <div class="collab-range-label">${esc(range)}</div>
    `;
  }

  function collabInitials(firstName, lastName){
    const first = String(firstName || '').trim();
    const last = String(lastName || '').trim();
    const letters = `${first.charAt(0)}${last.charAt(0)}`.trim();
    return (letters || '–').toUpperCase();
  }

  function collabAvatarTone(value){
    const tones = ['lime', 'violet', 'sky', 'mint', 'peach', 'cyan', 'rose', 'amber'];
    const raw = String(value || '');
    let sum = 0;
    for (let i = 0; i < raw.length; i += 1) sum += raw.charCodeAt(i);
    return tones[sum % tones.length];
  }

  function splitPosteLabel(label){
    const raw = String(label || '').trim();
    if (!raw || raw === '—') return { code: '', title: '—' };

    const parts = raw.split('·');
    if (parts.length >= 2) {
      return {
        code: parts.shift().trim(),
        title: parts.join('·').trim() || '—'
      };
    }

    return { code: '', title: raw };
  }

  function renderPosteCell(posteLabel){
    const p = splitPosteLabel(posteLabel);
    return `
      <div class="collab-poste-cell">
        ${p.code ? `<span class="sb-badge sb-badge--poste collab-poste-code">${esc(p.code)}</span>` : ''}
        <span class="collab-poste-title">${esc(p.title)}</span>
      </div>
    `;
  }

  function renderStatusRoles(it){
    const archived = !!it?.archive;
    const active = !!it?.actif && !archived;
    const statusLabel = archived ? 'Archivé' : (active ? 'Actif' : 'Inactif');
    const statusClass = archived ? 'is-archived' : (active ? 'is-active' : 'is-inactive');

    return `
      <div class="collab-status-stack">
        <span class="collab-status-dot ${statusClass}">${esc(statusLabel)}</span>
        <span class="collab-role-line">
          ${it?.ismanager ? '<span class="collab-role-badge collab-role-badge--manager">Manager</span>' : ''}
          ${it?.isformateur ? '<span class="collab-role-badge collab-role-badge--formateur">Formateur</span>' : ''}
        </span>
      </div>
    `;
  }

  function setCollabFiltersCollapsed(collapsed){
    const card = byId('collabListCard') || document.querySelector('#view-collaborateurs .collab-list-card');
    const body = byId('collabFilterBody');
    const btn = byId('btnCollabFiltersToggle');
    const isCollapsed = !!collapsed;

    if (card) card.classList.toggle('is-filters-collapsed', isCollapsed);
    if (body) body.style.display = isCollapsed ? 'none' : '';
    if (btn) {
      btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      btn.title = isCollapsed ? 'Déplier les filtres' : 'Replier les filtres';
      btn.setAttribute('aria-label', isCollapsed ? 'Déplier les filtres' : 'Replier les filtres');
    }
  }

  function resetCollaborateurFilters(portal){
    _search = '';
    _filterActive = 'active';
    _filterService = '__all__';
    _filterPoste = '__all__';
    _filterManager = false;
    _filterFormateur = false;
    _showArchived = false;
    _page = 1;

    if (byId('collabSearch')) byId('collabSearch').value = '';
    if (byId('collabFilterActive')) byId('collabFilterActive').value = 'active';
    if (byId('collabFilterService')) byId('collabFilterService').value = '__all__';
    if (byId('collabFilterPoste')) byId('collabFilterPoste').value = '__all__';
    if (byId('collabFilterManager')) byId('collabFilterManager').checked = false;
    if (byId('collabFilterFormateur')) byId('collabFilterFormateur').checked = false;
    if (byId('collabShowArchived')) byId('collabShowArchived').checked = false;

    loadList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
  }

  function renderList(){
    const host = byId("collabList");
    const empty = byId("collabEmpty");
    if (!host || !empty) return;

    if (!_items.length) {
      host.innerHTML = "";
      empty.style.display = "block";
      refreshBulkSendButton();
      return;
    }

    empty.style.display = "none";

    const iconPdf = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/>
        <path d="M14 2v6h6"/>
        <path d="M8.5 15.5h7"/>
        <path d="M8.5 18.5h5"/>
      </svg>
    `;

    const iconEdit = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    `;

    const iconTrash = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4h6v2"/>
      </svg>
    `;

    const sortedItems = getSortedCollaborateurs(_items);
    const pageData = getCollabPageData(sortedItems);
    const pageItems = pageData.items;

    const rows = pageItems.map(it => {
      const cid = String(it.id_collaborateur || '').trim();
      const fullName = collabFullName(it);
      const email = it.email || "—";
      const service = String(it.nom_service || '').trim() || '—';
      const accessSummary = Array.isArray(it.access_summary) ? it.access_summary : [];
      const selectedForSend = _bulkSendSelectedIds.has(cid);
      const avatarTone = collabAvatarTone(cid || fullName);

      return `
        <div class="collab-table-row ${it.archive ? "is-archived" : ""} ${selectedForSend ? "is-selected-send" : ""}" data-collab-row="${esc(cid)}">
          <div class="collab-table-cell collab-table-cell--check">
            <label class="sb-collab-send-check" title="Sélectionner pour l’envoi des accès">
              <input type="checkbox" data-select-collab="${esc(cid)}" ${selectedForSend ? 'checked' : ''} />
            </label>
          </div>

          <div class="collab-table-cell collab-table-cell--identity">
            <span class="collab-avatar collab-avatar--${esc(avatarTone)}" aria-hidden="true">${esc(collabInitials(it.prenom, it.nom))}</span>
            <span class="collab-identity-text">
              <span class="collab-identity-name">${esc(fullName)}</span>
              <span class="collab-identity-mail">${esc(email)}</span>
            </span>
          </div>

          <div class="collab-table-cell collab-table-cell--service">${esc(service)}</div>
          <div class="collab-table-cell collab-table-cell--poste">${renderPosteCell(it.poste_label)}</div>
          <div class="collab-table-cell collab-table-cell--roles">${renderStatusRoles(it)}</div>

          <div class="collab-table-cell collab-table-cell--access">
            ${renderConsoleIcons(accessSummary)}
          </div>

          <div class="collab-table-cell collab-table-cell--actions">
            <div class="sb-icon-actions">
              <button
                type="button"
                class="sb-icon-btn sb-icon-btn--doc"
                title="PDF"
                aria-label="PDF"
                style="display:${COLLAB_LIST_SHOW_PDF_BTN ? "inline-flex" : "none"};"
              >
                ${iconPdf}
              </button>

              <button
                type="button"
                class="sb-icon-btn"
                data-act="edit"
                data-id="${esc(cid)}"
                title="Voir/Modifier"
                aria-label="Voir/Modifier"
              >
                ${iconEdit}
              </button>

              ${
                it.archive
                  ? ""
                  : `
                    <button
                      type="button"
                      class="sb-icon-btn sb-icon-btn--danger"
                      data-act="archive"
                      data-id="${esc(cid)}"
                      title="Archiver"
                      aria-label="Archiver"
                    >
                      ${iconTrash}
                    </button>
                  `
              }
            </div>
          </div>
        </div>
      `;
    }).join("");

    host.innerHTML = `
      <div class="collab-table">
        <div class="collab-table-row collab-table-head">
          <div class="collab-table-cell collab-table-cell--check"></div>
          <div class="collab-table-cell">${renderCollabSortHead('collaborateur', 'Collaborateur')}</div>
          <div class="collab-table-cell">${renderCollabSortHead('service', 'Service')}</div>
          <div class="collab-table-cell">${renderCollabSortHead('poste', 'Poste')}</div>
          <div class="collab-table-cell">${renderCollabSortHead('roles', 'Statut & rôles')}</div>
          <div class="collab-table-cell">${renderCollabSortHead('access', 'Accès')}</div>
          <div class="collab-table-cell collab-table-cell--actions">Actions</div>
        </div>
        ${rows}
      </div>
      <div class="collab-table-foot">
        ${renderCollabPagination(pageData)}
      </div>
    `;

    refreshBulkSendButton();
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
    renderLicenseKpis();
    await hydrateFormSelects(portal);
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
    purgeBulkSendSelection();
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
    _page = 1;
    purgeBulkSendSelection();
    renderList();
  }

  function refreshTempRoleVisibility(){
    const wrap = byId("collabTempRoleField");
    if (wrap) wrap.style.display = "none";
  }

  function setCollabRetraiteEstimee(value){
    const chk = byId("collabHaveDateFin");
    const retraite = byId("collabRetraiteEstimee");
    const n = parseInt(value, 10);
    const label = (Number.isFinite(n) && n > 1900) ? String(n) : "";

    if (retraite) retraite.value = label;

    refreshSortieVisibility();
  }

  function refreshSortieVisibility(){
    const wrapDate = byId("collabDateSortieField");
    const wrapMotif = byId("collabMotifSortieField");
    const chk = byId("collabHaveDateFin");
    const show = !!(chk && chk.checked);

    if (wrapDate) wrapDate.classList.toggle("is-hidden", !show);
    if (wrapMotif) wrapMotif.classList.toggle("is-hidden", !show);
  }

  function clearForm(){
    setCollabSaveMsg("");
    [
      "collabPrenom","collabNom","collabEmail","collabTel","collabAdresse",
      "collabCodePostal","collabVille","collabPays","collabObservations","collabMatricule",
      "collabNiveauEdu","collabDomaineEdu","collabDateNaissance","collabDateEntree",
      "collabDateDebutPoste","collabDateSortie","collabMotifSortie","collabRetraiteEstimee"
    ].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });

    _hiddenCodeEffectif = null;
    _hiddenBusinessTravel = null;
    _hiddenIsTemp = false;
    _hiddenTempRole = null;
    _hiddenTelephone2 = null;
    _hiddenNoteCommentaire = null;

    if (byId("collabCivilite")) byId("collabCivilite").value = "";
    if (byId("collabService")) {
      byId("collabService").value = "";
      byId("collabService").disabled = false;
    }
    if (byId("collabPoste")) byId("collabPoste").value = "";
    if (byId("collabTypeContrat")) byId("collabTypeContrat").value = "";
    if (byId("collabNiveauEdu")) byId("collabNiveauEdu").value = "";
    if (byId("collabDomaineEdu")) byId("collabDomaineEdu").value = "";

    if (byId("collabActif")) byId("collabActif").checked = true;
    if (byId("collabManager")) byId("collabManager").checked = false;
    if (byId("collabFormateur")) byId("collabFormateur").checked = false;
    if (byId("collabHaveDateFin")) byId("collabHaveDateFin").checked = false;

    setCollabRetraiteEstimee(null);

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId("btnCollabArchive");
    if (btnArchive) btnArchive.style.display = "none";
  }

  function modalCollabInitials(prenom, nom){
    const p = String(prenom || "").trim();
    const n = String(nom || "").trim();
    const raw = `${p ? p[0] : ""}${n ? n[0] : ""}`.trim();
    return raw ? raw.toUpperCase() : "--";
  }

  function getSelectedLabel(id){
    const el = byId(id);
    if (!el) return "";
    const opt = el.options?.[el.selectedIndex];
    return String(opt?.textContent || el.value || "").trim();
  }

  function normalizeModalContextLabel(value){
    return String(value || "")
      .replace(/^—\s*/, "")
      .replace(/^Tous\s+/i, "")
      .trim();
  }

  function setModalHeader(title, data){
    const prenom = data?.prenom || byId("collabPrenom")?.value || "";
    const nom = data?.nom || byId("collabNom")?.value || "";
    const fullTitle = title || `${prenom || ""} ${nom || ""}`.trim() || "Collaborateur";

    if (byId("collabModalTitle")) byId("collabModalTitle").textContent = fullTitle;
    if (byId("collabModalAvatar")) byId("collabModalAvatar").textContent = modalCollabInitials(prenom, nom);

    const sub = byId("collabModalSubline");
    if (sub){
      const poste = normalizeModalContextLabel(data?.poste_label || data?.poste_actuel || getSelectedLabel("collabPoste"));
      const service = normalizeModalContextLabel(data?.service_label || data?.service || getSelectedLabel("collabService"));
      const line = [poste, service].filter(Boolean).join(" · ");
      sub.textContent = line || (_modalMode === "create" ? "Création d’un collaborateur" : "Collaborateur sans poste renseigné");
    }
  }

  function setModalBadges(data){
    const host = byId("collabModalBadges");
    if (!host) return;

    const badges = [];

    if (data?.archive) {
      badges.push({ label: "Archivé", cls: "sb-badge sb-badge--status-archive" });
    } else if (data?.actif) {
      badges.push({ label: "Actif", cls: "sb-badge sb-badge--status-active" });
    } else {
      badges.push({ label: "Inactif", cls: "sb-badge sb-badge--status-inactive" });
    }

    if (data?.ismanager) badges.push({ label: "Manager", cls: "sb-badge sb-badge-manager" });
    if (data?.isformateur) badges.push({ label: "Formateur", cls: "sb-badge sb-badge--formateur" });

    host.innerHTML = badges.map(x => `<span class="${x.cls}">${esc(x.label)}</span>`).join("");
  }

  function buildPayload(){
    const posteId = byId("collabPoste")?.value || null;

    return {
      civilite: byId("collabCivilite")?.value || null,
      prenom: byId("collabPrenom")?.value || null,
      nom: byId("collabNom")?.value || null,
      email: byId("collabEmail")?.value || null,
      telephone: formatPhoneFr(byId("collabTel")?.value || null),
      telephone2: byId("collabTel2") ? formatPhoneFr(byId("collabTel2")?.value || null) : _hiddenTelephone2,
      adresse: byId("collabAdresse")?.value || null,
      code_postal: normalizeCollabPostalCode(byId("collabCodePostal")?.value || null) || null,
      ville: normalizeCollabCity(byId("collabVille")?.value || null) || null,
      pays: byId("collabPays")?.value || null,
      actif: !!byId("collabActif")?.checked,
      fonction: posteId,
      observations: byId("collabObservations")?.value || null,
      id_service: byId("collabService")?.value || null,
      id_poste_actuel: posteId,
      type_contrat: byId("collabTypeContrat")?.value || null,
      matricule_interne: byId("collabMatricule")?.value || null,
      business_travel: _hiddenBusinessTravel,
      date_naissance: byId("collabDateNaissance")?.value || null,
      date_entree_entreprise: byId("collabDateEntree")?.value || null,
      date_debut_poste_actuel: byId("collabDateDebutPoste")?.value || null,
      date_sortie_prevue: byId("collabDateSortie")?.value || null,
      niveau_education: byId("collabNiveauEdu")?.value || null,
      domaine_education: byId("collabDomaineEdu")?.value || null,
      motif_sortie: byId("collabMotifSortie")?.value || null,
      note_commentaire: byId("collabNote") ? (byId("collabNote")?.value || null) : _hiddenNoteCommentaire,
      havedatefin: !!byId("collabHaveDateFin")?.checked,
      ismanager: !!byId("collabManager")?.checked,
      isformateur: !!byId("collabFormateur")?.checked,
      is_temp: _hiddenIsTemp,
      role_temp: _hiddenTempRole,
      code_effectif: _hiddenCodeEffectif
    };
  }

  function activateModalTab(tab){
    document.querySelectorAll('#modalCollaborateur [data-tab]').forEach(btn => {
      const isActive = (btn.getAttribute('data-tab') || '') === tab;
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (isActive) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });

    document.querySelectorAll('#collabModalBody [data-panel]').forEach(panel => {
      const isActive = (panel.getAttribute('data-panel') || '') === tab;
      panel.classList.toggle('is-active', isActive);
    });

    if (typeof refreshModalSendButton === 'function') {
      refreshModalSendButton();
    }
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

    const ownedItems = Array.isArray(data?.owned_items)
      ? data.owned_items.slice()
      : (Array.isArray(data?.items) ? data.items.slice() : []);

    _collabSkillItems = ownedItems.slice();

    const poste = getCurrentPosteForSkills();
    const posteLabel = poste.label || data?.intitule_poste || '–';
    const canAdd = !!_editingId;

    const levelMeta = (niv) => {
      const key = nsLevelKey(niv);
      if (key) return { text: nsLevelLabel(key), cls: `sb-badge--niv sb-badge--niv-${key.toLowerCase()}` };
      return { text: '—', cls: 'sb-badge--outline-accent' };
    };

    const levelRank = (niv) => {
      const key = nsLevelKey(niv);
      const order = { A:1, B:2, C:3, D:4 };
      return order[key] || 0;
    };

    const parseDateValue = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return 0;
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`) || 0;
      const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (fr) return Number(`${fr[3]}${fr[2]}${fr[1]}`) || 0;
      const d = Date.parse(raw);
      return Number.isFinite(d) ? d : 0;
    };

    const skillSortValue = (item, key) => {
      if (key === 'niveau') return levelRank(item?.niveau_actuel);
      if (key === 'date_eval') return parseDateValue(item?.date_derniere_eval);
      return String(item?.intitule || item?.code || '').toLocaleLowerCase('fr');
    };

    const compareSkillRows = (a, b, scope) => {
      const state = _collabSkillSorts[scope] || { key:'competence', dir:'asc' };
      const av = skillSortValue(a, state.key);
      const bv = skillSortValue(b, state.key);
      let res = 0;
      if (typeof av === 'number' && typeof bv === 'number') res = av - bv;
      else res = String(av).localeCompare(String(bv), 'fr', { sensitivity:'base', numeric:true });
      if (res === 0) {
        res = String(a?.intitule || '').localeCompare(String(b?.intitule || ''), 'fr', { sensitivity:'base', numeric:true });
      }
      return state.dir === 'desc' ? -res : res;
    };

    const requiredOwned = ownedItems.filter(x => !!x?.is_required).sort((a, b) => compareSkillRows(a, b, 'required'));
    const otherOwned = ownedItems.filter(x => !x?.is_required).sort((a, b) => compareSkillRows(a, b, 'other'));

    const validatedCount = requiredOwned.filter(x => {
      const cur = nsLevelKey(x?.niveau_actuel);
      const req = nsLevelKey(x?.niveau_requis || x?.niveau_attendu || x?.niveau_actuel);
      const order = { A:1, B:2, C:3, D:4 };
      return cur && req && (order[cur] || 0) >= (order[req] || 0);
    }).length;

    const buildCompCell = (code, intitule) => {
      const title = String(intitule || '').trim();
      return `
        <div class="sb-collab-skill-titleline">
          ${code ? `<span class="sb-badge sb-badge--comp">${esc(code)}</span>` : ''}
          <span class="sb-collab-skill-title" title="${esc(title)}">${esc(title || 'Compétence')}</span>
        </div>
      `;
    };

    const iconPdf = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>`;
    const iconEval = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
    const iconTrash = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    const iconPlus = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;

    const sortHead = (scope, key, label, cls = '') => {
      const state = _collabSkillSorts[scope] || { key:'competence', dir:'asc' };
      const active = state.key === key;
      const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : '↕';
      return `
        <th class="${cls}">
          <button type="button" class="sb-collab-sort-head${active ? ' is-active' : ''}" data-skill-sort="${esc(scope)}" data-skill-sort-key="${esc(key)}" aria-label="Trier par ${esc(label)}">
            <span>${esc(label)}</span>
            <span class="sb-collab-sort-indicator" aria-hidden="true">${arrow}</span>
          </button>
        </th>
      `;
    };

    const renderOwnedRows = (rows) => {
      if (!rows.length) return `<tr><td colspan="4" class="sb-collab-skill-empty">Aucune compétence dans cette catégorie.</td></tr>`;
      return rows.map(x => {
        const lastEval = formatDateFR(x.date_derniere_eval);
        const idComp = (x.id_comp || '').toString().trim();
        const idEffectifComp = (x.id_effectif_competence || '').toString().trim();
        const lvl = levelMeta(x.niveau_actuel);
        const rowAttrs = idEffectifComp ? `class="sb-table-row-clickable" data-act="open-skill-eval" data-id-effectif-comp="${esc(idEffectifComp)}" tabindex="0"` : '';
        return `
          <tr ${rowAttrs}>
            <td>${buildCompCell(x.code || '', x.intitule || '')}</td>
            <td class="col-center"><span class="sb-badge ${lvl.cls}">${esc(lvl.text)}</span></td>
            <td class="col-center">${esc(lastEval)}</td>
            <td class="sb-table-action-cell">
              <div class="sb-icon-actions">
                ${idComp ? `<button type="button" class="sb-icon-btn" data-act="open-skill-sheet-btn" data-id-comp="${esc(idComp)}" title="Voir la fiche" aria-label="Voir la fiche">${iconPdf}</button>` : ``}
                ${idEffectifComp ? `<button type="button" class="sb-icon-btn" data-act="open-skill-eval-btn" data-id-effectif-comp="${esc(idEffectifComp)}" title="Évaluer la compétence" aria-label="Évaluer la compétence">${iconEval}</button>` : ``}
                ${idComp ? `<button type="button" class="sb-icon-btn sb-icon-btn--danger" data-act="remove-skill" data-id-comp="${esc(idComp)}" title="Retirer la compétence" aria-label="Retirer la compétence">${iconTrash}</button>` : ``}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    };

    const renderOwnedSection = (title, rows, modifier, scope) => `
      <div class="sb-collab-skill-section ${modifier || ''}">
        <div class="sb-collab-skill-section-head">
          <div class="sb-collab-skill-section-title">${esc(title)}</div>
          <span class="sb-badge">${rows.length}</span>
        </div>
        <div class="sb-table-wrap">
          <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-skills-table sb-collab-skills-table--owned">
            <thead>
              <tr>
                ${sortHead(scope, 'competence', 'Compétence')}
                ${sortHead(scope, 'niveau', 'Niveau actuel', 'col-center sb-collab-skill-col-level')}
                ${sortHead(scope, 'date_eval', 'Dernière éval.', 'col-center sb-collab-skill-col-date')}
                <th class="col-center sb-collab-skill-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>${renderOwnedRows(rows)}</tbody>
          </table>
        </div>
      </div>
    `;

    host.innerHTML = `
      <div class="sb-collab-metrics">
        <div class="sb-collab-metric sb-collab-metric--red"><span aria-hidden="true">${collabModalSvg('contract')}</span><strong>${requiredOwned.length}</strong><em>Compétences requises<br>détenues</em></div>
        <div class="sb-collab-metric sb-collab-metric--blue"><span aria-hidden="true">${collabModalSvg('skills')}</span><strong>${validatedCount}</strong><em>Compétences validées<br>au niveau requis ou supérieur</em></div>
        <div class="sb-collab-metric sb-collab-metric--green"><span aria-hidden="true">${collabModalSvg('certs')}</span><strong>${otherOwned.length}</strong><em>Autres compétences<br>détenues</em></div>
      </div>

      <div class="sb-collab-tab-actions">
        ${canAdd ? `<button type="button" class="sb-btn sb-btn--secondary sb-btn--xs" id="btnSyncCollabSkillsFromPoste"><span class="sb-btn-icon" aria-hidden="true">${collabModalSvg('import')}</span><span>Importer les compétences du poste</span></button>` : ``}
        ${canAdd ? `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" id="btnCollabCompAdd"><span class="sb-btn-icon" aria-hidden="true">${iconPlus}</span><span>Ajouter une compétence</span></button>` : ``}
      </div>

      ${renderOwnedSection('Compétences requises détenues par le collaborateur', requiredOwned, 'sb-collab-skill-section--required', 'required')}
      ${renderOwnedSection('Autres compétences détenues', otherOwned, 'sb-collab-skill-section--other', 'other')}
    `;

    host.querySelectorAll('[data-skill-sort]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const scope = String(btn.getAttribute('data-skill-sort') || '').trim();
        const key = String(btn.getAttribute('data-skill-sort-key') || '').trim();
        if (!scope || !key) return;
        const current = _collabSkillSorts[scope] || { key:'competence', dir:'asc' };
        _collabSkillSorts[scope] = {
          key,
          dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc'
        };
        renderCompetences(data, portal);
      });
    });

    const btnSyncSkills = byId('btnSyncCollabSkillsFromPoste');
    if (btnSyncSkills) btnSyncSkills.addEventListener('click', async () => {
      try { await syncCompetencesFromSelectedPoste(portal); }
      catch(e){ if (portal.showAlert) portal.showAlert('error', getErrorMessage(e)); }
    });

    const btnAdd = byId('btnCollabCompAdd');
    if (btnAdd) btnAdd.addEventListener('click', async () => {
      try { await openCollabCompAddModal(portal); }
      catch(e){ if (portal.showAlert) portal.showAlert('error', getErrorMessage(e)); }
    });

    host.querySelectorAll('[data-act="open-skill-sheet-btn"]').forEach(btn => {
      btn.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await openCollabSkillSheetPdf(portal, btn.getAttribute('data-id-comp')); });
    });
    host.querySelectorAll('[data-act="open-skill-eval"], [data-act="open-skill-eval-btn"]').forEach(el => {
      el.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await openCollabSkillEvalModal(portal, el.getAttribute('data-id-effectif-comp')); });
      el.addEventListener('keydown', async (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); await openCollabSkillEvalModal(portal, el.getAttribute('data-id-effectif-comp')); } });
    });
    host.querySelectorAll('[data-act="remove-skill"]').forEach(btn => {
      btn.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await removeSkillFromCollaborateur(portal, btn.getAttribute('data-id-comp')); });
    });
  }

  function renderCertifications(data, portal){
    const host = byId('collabCertsPanel');
    if (!host) return;

    const items = Array.isArray(data?.items) ? data.items.slice() : [];
    _collabCertItems = items.slice();

    const poste = getCurrentPosteForSkills();
    const posteLabel = poste.label || data?.intitule_poste || '–';
    const canAdd = !!_editingId;

    const iconPen = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
    const iconTrash = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

    const requiredCount = items.filter(x => !!x.is_required_poste || !!x.is_wanted_poste).length;
    const acquiredCount = items.filter(x => String(x.etat || '').toLowerCase() === 'obtenue' || String(x.etat || '').toLowerCase() === 'valide' || !!x.date_obtention).length;
    const watchCount = items.filter(x => {
      const state = String(x.etat || '').toLowerCase();
      return state.includes('renouvel') || state.includes('expire') || !!x.date_expiration_effective || !!x.date_expiration_calculee;
    }).length;

    const stateBadge = (x) => {
      const label = x.etat_label || certificationStateLabel(x.etat);
      const raw = String(x.etat || '').toLowerCase();
      let cls = 'sb-collab-cert-status--neutral';
      if (raw.includes('obten') || raw.includes('valide')) cls = 'sb-collab-cert-status--ok';
      if (raw.includes('renouvel')) cls = 'sb-collab-cert-status--warn';
      if (raw.includes('expire')) cls = 'sb-collab-cert-status--danger';
      return `<span class="sb-badge sb-collab-cert-status ${cls}">${esc(label || '—')}</span>`;
    };

    const requirementBadge = (x) => {
      if (x.is_required_poste) return `<span class="sb-badge sb-collab-cert-badge sb-collab-cert-badge--required">Requis</span>`;
      if (x.is_wanted_poste) return `<span class="sb-badge sb-collab-cert-badge sb-collab-cert-badge--wanted">Souhaité</span>`;
      return `<span class="sb-badge sb-collab-cert-badge">Hors poste</span>`;
    };

    const rows = items.map(x => `
      <tr>
        <td>
          <div class="sb-collab-cert-title">${esc(x.nom_certification || 'Certification')}</div>
          <div class="sb-collab-cert-badges">
            ${x.categorie ? `<span class="sb-badge sb-collab-cert-badge">${esc(x.categorie)}</span>` : ``}
            ${requirementBadge(x)}
          </div>
        </td>
        <td class="col-center"><strong>${esc(certificationMonthLabel(x.validite_attendue))}</strong></td>
        <td class="col-center">${stateBadge(x)}</td>
        <td class="col-center"><strong>${esc(formatDateFR(x.date_obtention))}</strong><span class="sb-collab-cert-sub">Exp. ${esc(formatDateFR(x.date_expiration_effective || x.date_expiration || x.date_expiration_calculee))}</span></td>
        <td class="sb-table-action-cell">
          <div class="sb-icon-actions">
            <button type="button" class="sb-icon-btn" data-act="edit-cert" data-id-effectif-certification="${esc(x.id_effectif_certification || '')}" title="Modifier la certification" aria-label="Modifier la certification">${iconPen}</button>
            <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-act="archive-cert" data-id-effectif-certification="${esc(x.id_effectif_certification || '')}" title="Archiver la certification" aria-label="Archiver la certification">${iconTrash}</button>
          </div>
        </td>
      </tr>
    `).join('');

    host.innerHTML = `
      <div class="sb-collab-metrics">
        <div class="sb-collab-metric sb-collab-metric--red"><span aria-hidden="true">${collabModalSvg('medal')}</span><strong>${requiredCount}</strong><em>Certifications<br>requises / souhaitées</em></div>
        <div class="sb-collab-metric sb-collab-metric--green"><span aria-hidden="true">${collabModalSvg('certs')}</span><strong>${acquiredCount}</strong><em>Certifications<br>obtenues</em></div>
        <div class="sb-collab-metric sb-collab-metric--blue"><span aria-hidden="true">${collabModalSvg('calendar')}</span><strong>${watchCount}</strong><em>À surveiller<br>ou renouveler</em></div>
      </div>

      <div class="sb-collab-tab-actions">
        ${canAdd ? `<button type="button" class="sb-btn sb-btn--secondary sb-btn--xs" id="btnSyncCollabCertsFromPoste"><span class="sb-btn-icon" aria-hidden="true">${collabModalSvg('import')}</span><span>Importer les certifications du poste</span></button>` : ``}
        ${canAdd ? `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" id="btnCollabCertAdd"><span class="sb-btn-icon" aria-hidden="true">${collabModalSvg('medal')}</span><span>Ajouter une certification</span></button>` : ``}
      </div>

      <div class="sb-collab-cert-section">
        <div class="sb-collab-skill-section-head">
          <div class="sb-collab-skill-section-title">Certifications du collaborateur</div>
          <span class="sb-badge">${items.length}</span>
        </div>
        ${items.length ? `
          <div class="sb-table-wrap">
            <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-certs-table">
              <thead><tr><th>Certification</th><th class="col-center" style="width:130px;">Validité</th><th class="col-center" style="width:140px;">État</th><th class="col-center" style="width:170px;">Dates</th><th class="col-center" style="width:94px;">Actions</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : `<div class="sb-collab-empty-card">Aucune certification enregistrée pour ce collaborateur.</div>`}
      </div>
    `;

    const btnSyncCerts = byId('btnSyncCollabCertsFromPoste');
    if (btnSyncCerts) btnSyncCerts.addEventListener('click', async () => {
      try { await syncCertificationsFromSelectedPoste(portal); }
      catch(e){ if (portal.showAlert) portal.showAlert('error', getErrorMessage(e)); }
    });

    const btnAdd = byId('btnCollabCertAdd');
    if (btnAdd) btnAdd.addEventListener('click', async () => {
      try { await openCollabCertAddModal(portal); }
      catch(e){ if (portal.showAlert) portal.showAlert('error', getErrorMessage(e)); }
    });

    host.querySelectorAll('[data-act="edit-cert"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = String(btn.getAttribute('data-id-effectif-certification') || '').trim();
        const item = (_collabCertItems || []).find(x => String(x?.id_effectif_certification || '').trim() === id) || null;
        if (item) openCollabCertEditModal(item);
      });
    });
    host.querySelectorAll('[data-act="archive-cert"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        try { await archiveCertificationForCollaborateur(portal, btn.getAttribute('data-id-effectif-certification')); }
        catch(err){ if (portal.showAlert) portal.showAlert('error', getErrorMessage(err)); }
      });
    });
  }

  function renderHistory(data){
    const host = byId('collabHistoryPanel');
    if (!host) return;

    const evolutionItems = Array.isArray(data?.evolutions?.items)
      ? data.evolutions.items
      : (Array.isArray(data?.postes?.items) ? data.postes.items : []);
    const formationItems = Array.isArray(data?.formations_jmb?.items) ? data.formations_jmb.items : [];
    const auditItems = Array.isArray(data?.audits?.items) ? data.audits.items : [];

    const evolutionRows = evolutionItems.length ? evolutionItems.map(x => {
      const code = (x.code_poste || '').toString().trim();
      const intitule = (x.intitule_poste || '').toString().trim() || 'Poste';
      const service = (x.nom_service || '').toString().trim();
      return `
        <tr>
          <td class="col-center"><span class="sb-collab-history-action-code">${esc(code || '–')}</span></td>
          <td><div class="sb-collab-history-formation">${esc(intitule)}</div>${service ? `<div class="sb-collab-history-code">${esc(service)}</div>` : ''}</td>
          <td class="col-center">${esc(formatDateFR(x.date_debut))}</td>
          <td class="col-center">${esc(formatDateFR(x.date_fin))}</td>
          <td class="col-center"><span class="sb-badge sb-collab-history-status--neutral">${esc(x.source_changement_label || historyPosteSourceLabel(x.source_changement))}</span></td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="5" class="sb-collab-skill-empty">Aucune évolution structurante enregistrée.</td></tr>`;

    const formationError = (data?.formations_jmb?.error || '').toString().trim();
    const formationRows = formationError
      ? `<tr><td colspan="5" class="sb-collab-skill-empty">Impossible de charger les formations JMB : ${esc(formationError)}</td></tr>`
      : (formationItems.length ? formationItems.map(x => `
        <tr>
          <td class="col-center"><span class="sb-collab-history-action-code">${esc(x.code_action_formation || x.code_formation || '–')}</span></td>
          <td><div class="sb-collab-history-formation">${esc(x.titre_formation || 'Formation')}</div>${x.code_formation ? `<div class="sb-collab-history-code">${esc(x.code_formation)}</div>` : ''}</td>
          <td class="col-center">${esc(formatDateFR(x.date_debut_formation))}</td>
          <td class="col-center">${esc(formatDateFR(x.date_fin_formation))}</td>
          <td class="col-center"><span class="sb-badge sb-collab-history-status--blue">${esc(x.etat_action || '—')}</span></td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="sb-collab-skill-empty">Aucune formation JMB enregistrée.</td></tr>`);

    const auditRows = auditItems.length ? auditItems.map(x => `
      <tr>
        <td class="col-center"><span class="sb-collab-history-action-code">${esc(x.code_competence || '–')}</span></td>
        <td><div class="sb-collab-history-formation">${esc(x.intitule_competence || 'Compétence')}</div>${x.methode_eval ? `<div class="sb-collab-history-code">${esc(x.methode_eval)}</div>` : ''}</td>
        <td class="col-center">${esc(formatDateFR(x.date_audit))}</td>
        <td class="col-center"><span class="sb-badge sb-collab-history-status--blue">${esc(x.niveau_label || x.niveau_actuel || '—')}</span></td>
        <td class="col-center">${esc(x.nom_evaluateur || '—')}</td>
      </tr>
    `).join('') : `<tr><td colspan="5" class="sb-collab-skill-empty">Aucun audit de compétence enregistré.</td></tr>`;

    host.innerHTML = `
      <div class="sb-history-accordion-list">
        <div class="sb-acc sb-accordion sb-history-accordion is-open" id="studioHistAccJmb">
          <button type="button" class="sb-acc-head is-open" data-acc="jmb" aria-expanded="true">
            <span class="sb-history-acc-title"><span class="sb-history-acc-icon" aria-hidden="true">${collabModalSvg('school')}</span><span>Formations effectuées avec JMBCONSULTANT</span></span>
            <span class="sb-acc-chevron">▾</span>
          </button>
          <div class="sb-acc-body" data-acc-body="jmb">
            <div class="sb-table-wrap">
              <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-history-table">
                <thead><tr><th class="col-center" style="width:130px;">Code</th><th>Formation</th><th class="col-center" style="width:120px;">Début</th><th class="col-center" style="width:120px;">Fin</th><th class="col-center" style="width:140px;">État</th></tr></thead>
                <tbody>${formationRows}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="sb-acc sb-accordion sb-history-accordion" id="studioHistAccMoves">
          <button type="button" class="sb-acc-head" data-acc="moves" aria-expanded="false">
            <span class="sb-history-acc-title"><span class="sb-history-acc-icon" aria-hidden="true">${collabModalSvg('trend')}</span><span>Évolutions structurantes</span></span>
            <span class="sb-acc-chevron">▾</span>
          </button>
          <div class="sb-acc-body" data-acc-body="moves" style="display:none;">
            <div class="sb-table-wrap">
              <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-history-table">
                <thead><tr><th class="col-center" style="width:110px;">Code</th><th>Poste</th><th class="col-center" style="width:120px;">Début</th><th class="col-center" style="width:120px;">Fin</th><th class="col-center" style="width:140px;">Source</th></tr></thead>
                <tbody>${evolutionRows}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="sb-acc sb-accordion sb-history-accordion" id="studioHistAccAudits">
          <button type="button" class="sb-acc-head" data-acc="audits" aria-expanded="false">
            <span class="sb-history-acc-title"><span class="sb-history-acc-icon" aria-hidden="true">${collabModalSvg('audit')}</span><span>Audits des compétences</span></span>
            <span class="sb-acc-chevron">▾</span>
          </button>
          <div class="sb-acc-body" data-acc-body="audits" style="display:none;">
            <div class="sb-table-wrap">
              <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-history-table">
                <thead><tr><th class="col-center" style="width:130px;">Code</th><th>Compétence</th><th class="col-center" style="width:120px;">Date</th><th class="col-center" style="width:150px;">Niveau</th><th class="col-center" style="width:170px;">Évaluateur</th></tr></thead>
                <tbody>${auditRows}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    host.querySelectorAll('.sb-history-accordion .sb-acc-head').forEach(btn => {
      btn.addEventListener('click', () => {
        const acc = btn.getAttribute('data-acc') || '';
        const body = host.querySelector(`[data-acc-body="${acc}"]`);
        const open = btn.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.closest('.sb-history-accordion')?.classList.toggle('is-open', open);
        if (body) body.style.display = open ? 'block' : 'none';
      });
    });
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
      const hasAccess = !!item?.has_access;
      const isUnlimited = !!item?.is_unlimited;
      const maxAccess = Number(item?.max_access ?? 0);
      const usedAccess = Number(item?.used_access ?? 0);
      const availableAccess = Number(item?.available_access ?? 0);

      const quotaLabel = contractActive
        ? (isUnlimited ? 'Licence disponible : Illimité' : `Licence disponible : ${Math.max(availableAccess, 0)} / ${Math.max(maxAccess, 0)}`)
        : 'Licence non incluse dans l’abonnement';

      const quotaBlocked = contractActive && hasEmail && !isUnlimited && !hasAccess && availableAccess <= 0;
      const disabled = (!contractActive && !hasAccess) || (!hasEmail && !hasAccess) || quotaBlocked;

      let stateText = '';
      if (!contractActive) {
        stateText = `<strong>Console non incluse</strong><br>Le contrat owner ne permet pas cette console.`;
      } else if (!hasEmail && !hasAccess) {
        stateText = `<strong>Email manquant</strong><br>Renseignez et enregistrez un email pour ouvrir l’accès.`;
      } else if (quotaBlocked) {
        stateText = `<strong>Quota atteint</strong><br>Aucune licence supplémentaire disponible pour cette console.`;
      } else if (hasAccess && !isUnlimited && availableAccess <= 0) {
        stateText = `<strong>Quota atteint</strong><br>Ce collaborateur a déjà une licence sur cette console. Vous pouvez conserver ou retirer cet accès.`;
      } else {
        stateText = `<strong>Console active</strong><br>${hasEmail || hasAccess ? 'Accès gérable pour ce collaborateur.' : 'Renseignez et enregistrez un email pour ouvrir l’accès.'}`;
      }

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
              <div class="sb-access-console-license">${esc(quotaLabel)}</div>
            </div>
          </div>

          <div>
            <select data-console-role="${esc(consoleCode)}" ${disabled ? 'disabled' : ''}>
              <option value="none" ${roleCode === 'none' ? 'selected' : ''}>Aucun accès</option>
              <option value="user" ${roleCode === 'user' ? 'selected' : ''}>Utilisateur</option>
              <option value="supervisor" ${roleCode === 'supervisor' ? 'selected' : ''}>Superviseur</option>
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
      </div>
    `;
  }

  async function saveRights(portal, options){
    const opts = options || {};

    if (!_editingId) throw new Error('Enregistrez d’abord le collaborateur.');
    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/acces/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRightsPayload())
    });

    if (!opts.skipRender) {
      renderRights(data, portal);
    }

    _tabLoaded.rights = true;

    if (opts.refreshContext !== false) {
      await loadContext(portal);
    }

    if (opts.refreshList !== false) {
      await loadList(portal);
    }

    return data;
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
      renderCertifications(data, portal);
      return;
    }

    if (tab === 'history') {
      setPanelMessage('collabHistoryPanel', 'Chargement…');
      const [formationsJmb, evolutions, audits] = await Promise.all([
        loadHistorySection(portal, `${portal.apiBase}/studio/collaborateurs/historique/formations-jmb/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`),
        loadHistorySection(portal, `${portal.apiBase}/studio/collaborateurs/historique/evolutions/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`),
        loadHistorySection(portal, `${portal.apiBase}/studio/collaborateurs/historique/audits/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}`)
      ]);
      renderHistory({ formations_jmb: formationsJmb, evolutions, audits });
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
    setModalBadges({ actif: true, archive: false });
    setModalHeader('Nouveau collaborateur', { prenom: '', nom: '' });
    activateModalTab('ident');
    resetDetailPanels();
    refreshModalSendButton();
    openModal('modalCollaborateur');
  }

  async function openEditModal(portal, id){
    const ownerId = getOwnerId();
    if (!ownerId || !id) return;

    const data = await portal.apiJson(`${portal.apiBase}/studio/collaborateurs/detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`);

    _modalMode = 'edit';
    _editingId = id;

    clearForm();

    if (byId('collabCivilite')) byId('collabCivilite').value = data?.civilite || '';
    if (byId('collabPrenom')) byId('collabPrenom').value = data?.prenom || '';
    if (byId('collabNom')) byId('collabNom').value = data?.nom || '';
    if (byId('collabEmail')) byId('collabEmail').value = data?.email || '';
    if (byId('collabTel')) byId('collabTel').value = formatPhoneFr(data?.telephone || '');
    _hiddenTelephone2 = formatPhoneFr(data?.telephone2 || null);
    if (byId('collabTel2')) byId('collabTel2').value = _hiddenTelephone2 || '';
    if (byId('collabAdresse')) byId('collabAdresse').value = data?.adresse || '';
    if (byId('collabCodePostal')) byId('collabCodePostal').value = data?.code_postal || '';
    if (byId('collabVille')) byId('collabVille').value = data?.ville || '';
    if (byId('collabPays')) byId('collabPays').value = data?.pays || '';
    if (byId('collabActif')) byId('collabActif').checked = !!data?.actif;
    if (byId('collabService')) byId('collabService').value = data?.id_service || '';
    if (byId('collabPoste')) byId('collabPoste').value = data?.id_poste_actuel || data?.fonction || '';
    if (byId('collabTypeContrat')) byId('collabTypeContrat').value = data?.type_contrat || '';
    if (byId('collabMatricule')) byId('collabMatricule').value = data?.matricule_interne || '';

    _hiddenCodeEffectif = data?.code_effectif || null;
    _hiddenBusinessTravel = data?.business_travel || null;
    _hiddenIsTemp = !!data?.is_temp;
    _hiddenTempRole = data?.role_temp || null;

    setSelectValueLoose('collabNiveauEdu', data?.niveau_education || '');
    setSelectValueLoose('collabDomaineEdu', data?.domaine_education || '');

    if (byId('collabDateNaissance')) byId('collabDateNaissance').value = data?.date_naissance || '';
    if (byId('collabDateEntree')) byId('collabDateEntree').value = data?.date_entree_entreprise || '';
    if (byId('collabDateDebutPoste')) byId('collabDateDebutPoste').value = data?.date_debut_poste_actuel || '';
    if (byId('collabDateSortie')) byId('collabDateSortie').value = data?.date_sortie_prevue || '';
    if (byId('collabMotifSortie')) byId('collabMotifSortie').value = data?.motif_sortie || '';
    if (byId('collabObservations')) byId('collabObservations').value = data?.observations || '';
    _hiddenNoteCommentaire = data?.note_commentaire || null;
    if (byId('collabNote')) byId('collabNote').value = _hiddenNoteCommentaire || '';
    if (byId('collabHaveDateFin')) byId('collabHaveDateFin').checked = !!data?.havedatefin || !!data?.date_sortie_prevue;
    if (byId('collabManager')) byId('collabManager').checked = !!data?.ismanager;
    if (byId('collabFormateur')) byId('collabFormateur').checked = !!data?.isformateur;

    setCollabRetraiteEstimee(data?.retraite_estimee ?? null);

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId('btnCollabArchive');
    if (btnArchive) btnArchive.style.display = data?.archive ? 'none' : '';

    const fullName = `${data?.prenom || ''} ${data?.nom || ''}`.trim();
    setModalHeader(fullName || 'Collaborateur', data || {});
    setModalBadges(data || {});
    activateModalTab('ident');
    resetDetailPanels();
    refreshModalSendButton();
    openModal('modalCollaborateur');
  }

  async function saveModal(portal, options){
    const opts = options || {};
    setCollabSaveMsg("");

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

    setCollabRetraiteEstimee(data?.retraite_estimee ?? null);

    if (_modalMode === 'create' && data?.id_collaborateur) {
      _modalMode = 'edit';
      _editingId = data.id_collaborateur;
      setModalHeader(`${payload.prenom || ''} ${payload.nom || ''}`.trim() || 'Collaborateur', { prenom: payload.prenom, nom: payload.nom });
      setModalBadges({
        actif: !!payload.actif,
        archive: false,
        ismanager: !!payload.ismanager,
        isformateur: !!payload.isformateur,
        is_temp: !!payload.is_temp
      });
      resetDetailPanels();
    }

    const rightsLoaded = _tabLoaded.rights && !!document.querySelector('#collabRightsPanel [data-console-role]');
    if (rightsLoaded && _editingId) {
      await saveRights(portal, {
        skipRender: !opts.keepOpen,
        refreshContext: false,
        refreshList: false
      });
    }

    /* IMPORTANT :
      le poste actuel peut avoir changé, donc les onglets dépendants du poste
      doivent être invalidés après chaque enregistrement. */
    _tabLoaded.skills = false;
    _tabLoaded.certs = false;
    _tabLoaded.history = false;

    await loadGlobalStats(portal);
    await loadList(portal);

    if (!opts.keepOpen) {
      closeModal('modalCollaborateur');
    } else {
      const activeTab = document.querySelector('#collabModalBody [data-panel].is-active')?.getAttribute('data-panel') || 'ident';

      if (activeTab === 'skills' && _editingId) {
        await loadTabIfNeeded(portal, 'skills');
      }

      if (activeTab === 'certs' && _editingId) {
        await loadTabIfNeeded(portal, 'certs');
      }

      if (activeTab === 'history' && _editingId) {
        await loadTabIfNeeded(portal, 'history');
      }

      refreshModalSendButton();
      setCollabSaveMsg('Enregistré avec succès');
    }

    return _editingId || data?.id_collaborateur || null;
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
    const host = byId('collabList');

    host?.addEventListener('change', (e) => {
      const pageSizeSelect = e.target.closest('[data-collab-page-size]');
      if (pageSizeSelect) {
        const nextSize = parseInt(pageSizeSelect.value, 10);
        _pageSize = Number.isFinite(nextSize) && nextSize > 0 ? nextSize : 25;
        _page = 1;
        renderList();
        return;
      }

      const cb = e.target.closest('input[data-select-collab]');
      if (!cb) return;

      const cid = String(cb.getAttribute('data-select-collab') || '').trim();
      if (!cid) return;

      if (cb.checked) _bulkSendSelectedIds.add(cid);
      else _bulkSendSelectedIds.delete(cid);

      refreshBulkSendButton();
      renderList();
    });

    host?.addEventListener('click', async (e) => {
      if (e.target.closest('input[data-select-collab]')) return;

      const sortBtn = e.target.closest('[data-sort-collab]');
      if (sortBtn) {
        const key = String(sortBtn.getAttribute('data-sort-collab') || '').trim();
        if (key) {
          if (_sortKey === key) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
          else {
            _sortKey = key;
            _sortDir = 'asc';
          }
          _page = 1;
          renderList();
        }
        return;
      }

      const pageBtn = e.target.closest('[data-page], [data-page-nav]');
      if (pageBtn) {
        const sortedItems = getSortedCollaborateurs(_items);
        const pageData = getCollabPageData(sortedItems);
        const nav = pageBtn.getAttribute('data-page-nav') || '';
        const rawPage = pageBtn.getAttribute('data-page') || '';
        if (nav === 'prev') _page = Math.max(1, pageData.page - 1);
        else if (nav === 'next') _page = Math.min(pageData.totalPages, pageData.page + 1);
        else {
          const nextPage = parseInt(rawPage, 10);
          if (Number.isFinite(nextPage)) _page = Math.min(Math.max(1, nextPage), pageData.totalPages);
        }
        renderList();
        return;
      }

      const btn = e.target.closest('button[data-act]');
      if (btn) {
        const act = btn.getAttribute('data-act') || '';
        const id = btn.getAttribute('data-id') || '';

        try {
          if (act === 'edit') await openEditModal(portal, id);
          if (act === 'archive') await archiveCollaborateur(portal, id);
        } catch (err) {
          portal.showAlert('error', getErrorMessage(err));
        }
        return;
      }

      const row = e.target.closest('.collab-table-row[data-collab-row]');
      if (!row) return;

      openCollabDrawer(row.getAttribute('data-collab-row') || '');
    });
  }

  function bindTabs(portal){
    document.querySelectorAll('#modalCollaborateur [data-tab]').forEach(btn => {
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

    byId('btnCollabDrawerClose')?.addEventListener('click', closeCollabDrawer);
    byId('collabDrawerBackdrop')?.addEventListener('click', closeCollabDrawer);

    byId('btnCollabDrawerOpen')?.addEventListener('click', async () => {
      const id = String(_drawerCollaborateurId || '').trim();
      if (!id) return;
      closeCollabDrawer();
      try {
        await openEditModal(portal, id);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabDrawerEval')?.addEventListener('click', () => {
      portal.showAlert('', 'La page Entretiens et évaluations sera branchée dans un prochain chantier.');
    });

    byId('btnCollabDrawerPlan')?.addEventListener('click', () => {
      portal.showAlert('', 'Le planning sera branché dans un prochain chantier.');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCollabDrawer();
    });

    byId('btnCollabAdd')?.addEventListener('click', () => {
      openCreateModal().catch(e => portal.showAlert('error', getErrorMessage(e)));
    });

    byId('btnCollabSendBulk')?.addEventListener('click', async () => {
      try {
        await sendBulkAccessMails(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabResetFilters')?.addEventListener('click', () => {
      resetCollaborateurFilters(portal);
    });

    byId('btnCollabFiltersToggle')?.addEventListener('click', () => {
      const card = byId('collabListCard') || document.querySelector('#view-collaborateurs .collab-list-card');
      setCollabFiltersCollapsed(!(card?.classList.contains('is-filters-collapsed')));
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

    ["collabPrenom", "collabNom", "collabService", "collabPoste"].forEach((id) => {
      byId(id)?.addEventListener('input', () => setModalHeader(null));
      byId(id)?.addEventListener('change', () => setModalHeader(null));
    });

    byId('btnCloseCollaborateur')?.addEventListener('click', () => closeModal('modalCollaborateur'));
    byId('btnCollabCancel')?.addEventListener('click', () => closeModal('modalCollaborateur'));

    byId('modalCollaborateur')?.addEventListener('click', (e) => {
      const saveBtn = byId('btnCollabSave');
      if (saveBtn && (e.target === saveBtn || saveBtn.contains(e.target))) return;
      setCollabSaveMsg('');
    });

    byId('btnCollabSave')?.addEventListener('click', async () => {
      try {
        await saveModal(portal, { keepOpen: true });
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabSendOne')?.addEventListener('click', async () => {
      try {
        const cid = await saveModal(portal, { keepOpen: true });
        await sendSingleAccessMail(portal, cid || _editingId);
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

    byId('btnCloseCollabCompAdd')?.addEventListener('click', () => closeModal('modalCollabCompAdd'));

    byId('btnCloseCollabCertAdd')?.addEventListener('click', () => closeModal('modalCollabCertAdd'));
    byId('btnCloseCollabCertEdit')?.addEventListener('click', () => closeModal('modalCollabCertEdit'));
    byId('btnCollabCertEditCancel')?.addEventListener('click', () => closeModal('modalCollabCertEdit'));

    byId('btnCloseCollabSkillEval')?.addEventListener('click', () => closeModal('modalCollabSkillEval'));
    byId('btnCollabSkillEvalCancel')?.addEventListener('click', () => closeModal('modalCollabSkillEval'));

    byId('btnCollabCertEditSave')?.addEventListener('click', async () => {
      try {
        await saveCollabCertEdit(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabCertProofPick')?.addEventListener('click', () => {
      byId('collabCertProofFile')?.click();
    });

    byId('collabCertProofFile')?.addEventListener('change', (e) => {
      const fileObj = e?.target?.files?.[0] || null;
      _collabCertEditState.proofFile = fileObj;
      refreshCollabCertProofUi();
    });

    byId('btnCollabCertProofOpen')?.addEventListener('click', async () => {
      try {
        await openCollabCertProof(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCollabSkillEvalSave')?.addEventListener('click', async () => {
      try {
        setCollabSkillEvalMsg(false, '');
        const btn = byId('btnCollabSkillEvalSave');
        if (btn) btn.disabled = true;
        await saveCollabSkillEval(portal);
      } catch (e) {
        setCollabSkillEvalMsg(false, `Échec de l'enregistrement - ${getErrorMessage(e)}`);
      } finally {
        refreshCollabSkillEvalSaveState();
      }
    });

    for (let i = 1; i <= 4; i++) {
      byId(`collabSkillEvalCritNote${i}`)?.addEventListener('change', recalcCollabSkillEvalScore);
      byId(`collabSkillEvalCritNote${i}`)?.addEventListener('input', recalcCollabSkillEvalScore);
    }

    byId('collabSkillEvalMethod')?.addEventListener('change', refreshCollabSkillEvalSaveState);
    byId('collabSkillEvalMethod')?.addEventListener('input', refreshCollabSkillEvalSaveState);

    const collabCompSearch = byId('collabCompAddSearch');
    if (collabCompSearch){
      collabCompSearch.addEventListener('input', () => {
        _collabCompAddSearch = (collabCompSearch.value || '').trim();
        if (_collabCompAddTimer) clearTimeout(_collabCompAddTimer);
        _collabCompAddTimer = setTimeout(() => {
          loadCollabCompAddList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
        }, 250);
      });
    }

    byId('collabCompAddShowToValidate')?.addEventListener('change', (e) => {
      _collabCompAddIncludeToValidate = !!e.target.checked;
      loadCollabCompAddList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    byId('collabCompAddDomain')?.addEventListener('change', (e) => {
      _collabCompAddDomain = (e.target.value || '').trim();
      _collabCompAddItems = applyCollabCompAddDomainFilter(_collabCompAddItemsAll);
      renderCollabCompAddList(portal);
    });

    const collabCertSearch = byId('collabCertAddSearch');
    if (collabCertSearch){
      collabCertSearch.addEventListener('input', () => {
        _collabCertAddSearch = (collabCertSearch.value || '').trim();
        if (_collabCertAddTimer) clearTimeout(_collabCertAddTimer);
        _collabCertAddTimer = setTimeout(() => {
          loadCollabCertAddList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
        }, 250);
      });
    }

    byId('collabCertAddCategory')?.addEventListener('change', (e) => {
      _collabCertAddCategory = (e.target.value || '').trim();
      loadCollabCertAddList(portal).catch(err => portal.showAlert('error', getErrorMessage(err)));
    });

    bindCollabStepperButtons(byId('modalCollabCertCreate'));

    byId('btnCollabCertCreate')?.addEventListener('click', async () => {
      try {
        await openCollabCertCreateModal(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    byId('btnCloseCollabCertCreate')?.addEventListener('click', () => closeCollabCertCreateModal(true));
    byId('btnCollabCertCreateCancel')?.addEventListener('click', () => closeCollabCertCreateModal(true));

    byId('btnCollabCertCreateSave')?.addEventListener('click', async () => {
      try {
        await saveCollabCertCreate(portal);
      } catch (e) {
        portal.showAlert('error', getErrorMessage(e));
      }
    });

    bindPhoneMask(byId('collabTel'));
    if (byId('collabTel2')) bindPhoneMask(byId('collabTel2'));
    bindCollabPostalAssist(portal);

    byId('collabPoste')?.addEventListener('change', refreshServiceFromPoste);
    byId('collabTemp')?.addEventListener('change', refreshTempRoleVisibility);
    byId('collabHaveDateFin')?.addEventListener('change', refreshSortieVisibility);

    byId('modalCollabCertAdd')?.addEventListener('click', (e) => {
      if (e.target === byId('modalCollabCertAdd')) closeModal('modalCollabCertAdd');
    });

    byId('modalCollabCertCreate')?.addEventListener('click', (e) => {
      if (e.target === byId('modalCollabCertCreate')) closeCollabCertCreateModal(true);
    });

    byId('modalCollabCertEdit')?.addEventListener('click', (e) => {
      if (e.target === byId('modalCollabCertEdit')) closeModal('modalCollabCertEdit');
    });

    byId('modalCollabSkillEval')?.addEventListener('click', (e) => {
      if (e.target === byId('modalCollabSkillEval')) closeModal('modalCollabSkillEval');
    });
  }

  async function init(force = false){
    try {
      await (window.__studioAuthReady || Promise.resolve(null));
    } catch (_) {}

    const portal = window.portal;
    const root = getCollaborateursRoot();

    if (!portal || !root){
      return;
    }

    if (_loaded && !force){
      return;
    }

    _loaded = true;

    bindOnce(portal);
    setStatus('Chargement…');

    await loadContext(portal);
    await loadGlobalStats(portal);
    await loadList(portal);

    setStatus('—');
  }

  function handleInitError(e){
    const msg = getErrorMessage(e);
    setStatus(msg);
    if (window.portal?.showAlert){
      window.portal.showAlert('error', msg);
    }
  }

  window.__studioCollaborateursInit = async function(options){
    try {
      await init(!!(options && options.force));
    } catch (e) {
      handleInitError(e);
      throw e;
    }
  };

  if (getCollaborateursRoot() && window.portal){
    window.__studioCollaborateursInit().catch(() => {});
  }
})();