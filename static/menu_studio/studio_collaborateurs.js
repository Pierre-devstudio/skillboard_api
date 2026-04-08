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
  const COLLAB_LIST_SHOW_PDF_BTN = false;

  let _hiddenCodeEffectif = null;
  let _hiddenBusinessTravel = null;
  let _hiddenIsTemp = false;
  let _hiddenTempRole = null;

  let _nsfGroupes = [];
  let _nsfGroupesLoaded = false;

  let _collabSkillItems = [];
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
      void inserted;
      void skipped;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = previousText || 'Importer les compétences du poste';
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

  async function addCompetenceToCollaborateur(portal, idComp){
    if (!_editingId) throw new Error("Enregistrez d’abord le collaborateur.");

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    await portal.apiJson(
      `${portal.apiBase}/studio/collaborateurs/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingId)}/add`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_comp: idComp })
      }
    );

    closeModal('modalCollabCompAdd');
    _tabLoaded.skills = false;
    await loadTabIfNeeded(portal, 'skills');
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
    if (byId('collabSkillEvalScoreCoef')) byId('collabSkillEvalScoreCoef').textContent = '—';
    if (byId('collabSkillEvalScore24')) byId('collabSkillEvalScore24').textContent = '—';
    if (byId('collabSkillEvalLevel')) byId('collabSkillEvalLevel').textContent = '—';

    const obs = byId('collabSkillEvalObservation');
    if (obs){
      obs.value = '';
      obs.disabled = true;
    }

    const btnSave = byId('btnCollabSkillEvalSave');
    if (btnSave) btnSave.disabled = true;

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
        <div style="font-weight:600;">Guide de notation</div>
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
    if (score24 >= 6 && score24 <= 9) return 'Initial';
    if (score24 >= 10 && score24 <= 18) return 'Avancé';
    if (score24 >= 19 && score24 <= 24) return 'Expert';
    return '—';
  }

  function recalcCollabSkillEvalScore(){
    if (!_collabSkillEvalState.id_effectif_competence) return;

    const enabled = getCollabSkillEvalEnabledCriteria();
    const coefEl = byId('collabSkillEvalScoreCoef');
    const rawEl = byId('collabSkillEvalScoreRaw');
    const scoreEl = byId('collabSkillEvalScore24');
    const levelEl = byId('collabSkillEvalLevel');

    if (!enabled.length){
      if (coefEl) coefEl.textContent = '—';
      if (rawEl) rawEl.textContent = '—';
      if (scoreEl) scoreEl.textContent = '—';
      if (levelEl) levelEl.textContent = '—';
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
    if (coefEl) coefEl.textContent = String(calc.coef);

    if (!filled){
      if (rawEl) rawEl.textContent = '—';
      if (scoreEl) scoreEl.textContent = '—';
      if (levelEl) levelEl.textContent = '—';
      return;
    }

    if (rawEl) rawEl.textContent = String(sum);
    if (scoreEl) scoreEl.textContent = String(calc.score24);

    if (filled === enabled.length) {
      if (levelEl) levelEl.textContent = levelFromCollabSkillEvalScore(calc.score24);
    } else {
      if (levelEl) levelEl.textContent = '—';
    }
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
      byId('collabSkillEvalCurrent').textContent = (data?.niveau_actuel || '—').toString().trim() || '—';
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

      domain.textContent = label;
      domain.style.display = label ? 'inline-block' : 'none';

      domain.style.background = '';
      domain.style.border = '';
      domain.style.color = '';
      domain.style.padding = '';
      domain.style.borderRadius = '';
      domain.style.fontSize = '';
      domain.style.lineHeight = '';

      const col = normalizeStudioColor(data?.domaine_couleur);
      if (label && col){
        domain.style.display = 'inline-block';
        domain.style.padding = '3px 8px';
        domain.style.borderRadius = '999px';
        domain.style.border = `1px solid ${col}`;
        domain.style.background = col;
        domain.style.color = pickStudioTextColor(col);
        domain.style.fontSize = '12px';
        domain.style.lineHeight = '18px';
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

    const obs = byId('collabSkillEvalObservation');
    if (obs){
      obs.disabled = enabledCount === 0;
      obs.value = (data?.last_audit?.observation || '').toString();
    }

    const btnSave = byId('btnCollabSkillEvalSave');
    if (btnSave) btnSave.disabled = enabledCount === 0;

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
    const niveau = levelFromCollabSkillEvalScore(calc.score24);
    if (!niveau || niveau === '—') throw new Error('Impossible de déterminer le niveau.');

    const ownerId = getOwnerId();
    if (!ownerId) throw new Error('Owner introuvable.');

    const observation = (byId('collabSkillEvalObservation')?.value || '').trim();

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
          methode_eval: 'Évaluation Studio'
        })
      }
    );

    if (byId('collabSkillEvalCurrent')) byId('collabSkillEvalCurrent').textContent = niveau;
    if (byId('collabSkillEvalLastEval')) byId('collabSkillEvalLastEval').textContent = `Dernière éval : ${formatDateFR(res?.date_audit)}`;
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

    return res;
  }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
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

    host.innerHTML = _items.map(it => {
      const fullName = `${it.prenom || ""} ${it.nom || ""}`.trim() || "Collaborateur sans nom";
      const email = it.email || "—";
      const posteActuel = it.poste_label || "—";
      const accessSummary = Array.isArray(it.access_summary) ? it.access_summary : [];

      return `
        <div class="sb-row-card ${it.archive ? "is-archived" : ""}">
          <div
            class="sb-row-left"
            style="display:grid; grid-template-columns:minmax(180px,220px) minmax(260px,1.35fr) minmax(220px,1fr); gap:18px; align-items:center; flex:1 1 auto; min-width:0;"
          >
            <div class="sb-row-title">${esc(fullName)}</div>

            <div style="font-size:13px; font-weight:400; color:#374151; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(email)}
            </div>

            <div style="font-size:13px; font-weight:400; color:#374151; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${esc(posteActuel)}
            </div>
          </div>

          <div class="sb-row-right" style="flex:0 0 auto; gap:14px;">
            <div style="display:flex; align-items:center; justify-content:flex-end; min-width:120px;">
              ${renderConsoleIcons(accessSummary)}
            </div>

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
                data-id="${esc(it.id_collaborateur)}"
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
                      data-id="${esc(it.id_collaborateur)}"
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
    if (wrap) wrap.style.display = "none";
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
    [
      "collabPrenom","collabNom","collabEmail","collabTel","collabTel2","collabAdresse",
      "collabCodePostal","collabVille","collabPays","collabObservations","collabMatricule",
      "collabNiveauEdu","collabDomaineEdu","collabDateNaissance","collabDateEntree",
      "collabDateDebutPoste","collabDateSortie","collabMotifSortie","collabNote"
    ].forEach(id => {
      const el = byId(id);
      if (el) el.value = "";
    });

    _hiddenCodeEffectif = null;
    _hiddenBusinessTravel = null;
    _hiddenIsTemp = false;
    _hiddenTempRole = null;

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

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId("btnCollabArchive");
    if (btnArchive) btnArchive.style.display = "none";
  }

  function setModalHeader(title){
    if (byId("collabModalTitle")) byId("collabModalTitle").textContent = title || "Collaborateur";
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

    if (data?.ismanager) badges.push({ label: "Manager", cls: "sb-badge sb-badge--outline-accent" });
    if (data?.isformateur) badges.push({ label: "Formateur", cls: "sb-badge sb-badge--outline-accent" });

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
      business_travel: _hiddenBusinessTravel,
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
      is_temp: _hiddenIsTemp,
      role_temp: _hiddenTempRole,
      code_effectif: _hiddenCodeEffectif
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
    _collabSkillItems = items.slice();

    const poste = getCurrentPosteForSkills();
    const canSync = !!_editingId && !!poste.id;
    const canAdd = !!_editingId;
    const posteLabel = poste.label || data?.intitule_poste || '–';

    const iconTrash = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4h6v2"/>
      </svg>
    `;

    const rows = items.map(x => {
      const niveau = (x.niveau_actuel || '').trim() || '–';
      const lastEval = formatDateFR(x.date_derniere_eval);
      const idComp = (x.id_comp || '').toString().trim();
      const idEffectifComp = (x.id_effectif_competence || '').toString().trim();
      const rowAttrs = idEffectifComp
        ? `class="sb-table-row-clickable" data-act="open-skill-eval" data-id-effectif-comp="${esc(idEffectifComp)}" tabindex="0"`
        : '';

      return `
        <tr ${rowAttrs}>
          <td>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              ${x.code ? `<span class="sb-badge sb-badge-ref-comp-code">${esc(x.code)}</span>` : ''}
              <div class="sb-comp-title">${esc(x.intitule || '')}</div>
            </div>
          </td>
          <td style="text-align:center;">${esc(niveau)}</td>
          <td style="text-align:center;">${esc(lastEval)}</td>
          <td style="width:52px; text-align:center;">
            ${
              idComp
                ? `
                  <button
                    type="button"
                    class="sb-icon-btn sb-icon-btn--danger"
                    data-act="remove-skill"
                    data-id-comp="${esc(idComp)}"
                    title="Retirer la compétence"
                    aria-label="Retirer la compétence"
                  >
                    ${iconTrash}
                  </button>
                `
                : ``
            }
          </td>
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
            class="sb-btn sb-btn--poste-soft"
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
                    <th style="width:52px;"></th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `
          : `<div class="card-sub" style="margin:0;">Aucune compétence trouvée.</div>`
      }

      ${
        canAdd
          ? `
            <div class="sb-actions" style="justify-content:flex-end; margin-top:10px;">
              <button
                type="button"
                class="sb-btn sb-btn--accent sb-btn--xs"
                id="btnCollabCompAdd"
              >
                Ajouter une compétence
              </button>
            </div>
          `
          : ``
      }
    `;

    const btnSync = byId('btnSyncCollabSkillsFromPoste');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        try {
          await syncCompetencesFromSelectedPoste(portal);
        } catch (e) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e));
        }
      });
    }

    const btnAdd = byId('btnCollabCompAdd');
    if (btnAdd) {
      btnAdd.addEventListener('click', async () => {
        try {
          await openCollabCompAddModal(portal);
        } catch (e) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e));
        }
      });
    }

    host.querySelectorAll('[data-act="remove-skill"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
          btn.disabled = true;
          await removeCompetenceFromCollaborateur(portal, btn.getAttribute('data-id-comp'));
        } catch (e2) {
          btn.disabled = false;
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(e2));
        }
      });
    });

    host.querySelectorAll('[data-act="open-skill-eval"]').forEach(row => {
      row.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;

        try {
          await openCollabSkillEvalModal(portal, row.getAttribute('data-id-effectif-comp'));
        } catch (err) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(err));
        }
      });

      row.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();

        try {
          await openCollabSkillEvalModal(portal, row.getAttribute('data-id-effectif-comp'));
        } catch (err) {
          if (portal.showAlert) portal.showAlert('error', getErrorMessage(err));
        }
      });
    });
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
    setModalBadges({ actif: true, archive: false });
    setModalHeader('Nouveau collaborateur');
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
    if (byId('collabNote')) byId('collabNote').value = data?.note_commentaire || '';
    if (byId('collabHaveDateFin')) byId('collabHaveDateFin').checked = !!data?.havedatefin || !!data?.date_sortie_prevue;
    if (byId('collabManager')) byId('collabManager').checked = !!data?.ismanager;
    if (byId('collabFormateur')) byId('collabFormateur').checked = !!data?.isformateur;

    refreshTempRoleVisibility();
    refreshSortieVisibility();
    refreshServiceFromPoste();

    const btnArchive = byId('btnCollabArchive');
    if (btnArchive) btnArchive.style.display = data?.archive ? 'none' : '';

    const fullName = `${data?.prenom || ''} ${data?.nom || ''}`.trim();
    setModalHeader(fullName || 'Collaborateur');
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
      setModalHeader(`${payload.prenom || ''} ${payload.nom || ''}`.trim() || 'Collaborateur');
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

    byId('btnCloseCollabCompAdd')?.addEventListener('click', () => closeModal('modalCollabCompAdd'));

    byId('btnCloseCollabSkillEval')?.addEventListener('click', () => closeModal('modalCollabSkillEval'));
    byId('btnCollabSkillEvalCancel')?.addEventListener('click', () => closeModal('modalCollabSkillEval'));

    byId('btnCollabSkillEvalSave')?.addEventListener('click', async () => {
      try {
        setCollabSkillEvalMsg(false, '');
        const btn = byId('btnCollabSkillEvalSave');
        if (btn) btn.disabled = true;
        await saveCollabSkillEval(portal);
      } catch (e) {
        setCollabSkillEvalMsg(false, `Échec de l'enregistrement - ${getErrorMessage(e)}`);
      } finally {
        const btn = byId('btnCollabSkillEvalSave');
        if (btn && getCollabSkillEvalEnabledCriteria().length > 0) btn.disabled = false;
      }
    });

    for (let i = 1; i <= 4; i++) {
      byId(`collabSkillEvalCritNote${i}`)?.addEventListener('change', recalcCollabSkillEvalScore);
      byId(`collabSkillEvalCritNote${i}`)?.addEventListener('input', recalcCollabSkillEvalScore);
    }

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

    bindPhoneMask(byId('collabTel'));
    bindPhoneMask(byId('collabTel2'));

    byId('collabPoste')?.addEventListener('change', refreshServiceFromPoste);
    byId('collabTemp')?.addEventListener('change', refreshTempRoleVisibility);
    byId('collabHaveDateFin')?.addEventListener('change', refreshSortieVisibility);

    byId('modalCollabSkillEval')?.addEventListener('click', (e) => {
      if (e.target === byId('modalCollabSkillEval')) closeModal('modalCollabSkillEval');
    });
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