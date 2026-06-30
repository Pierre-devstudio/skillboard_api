(function () {
  const NON_LIE_ID = "__NON_LIE__";
  const ALL_SERVICES_ID = "__ALL__";

  let _bound = false;
  let _servicesLoaded = false;
  let _activeTab = "competences"; // competences | certifs
  let _searchTimer = null;
  let _pageSize = 10;
  let _currentPageComp = 1;
  let _currentPageCert = 1;
  let _currentCompList = [];
  let _currentCertList = [];

  // Pareto (top 20%) sur les compétences, basé sur nb_postes_concernes
  let _paretoOnly = false;      // toggle filtre ON/OFF
  let _lastCompList = [];       // dernière liste compétences (non filtrée pareto)
  let _paretoTopIds = new Set(); // ids compétences dans le top 20%
  let _paretoTopCount = 0;      // combien de compétences dans le top 20%

  // cache basique par service (évite de recharger si l’utilisateur clique 10 fois)
  const _cacheComp = new Map();   // key: service|domaine|q|etat
  const _cacheCert = new Map();   // key: service|q

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }


  function refLevelKey(value) {
    const raw = (value ?? "").toString().trim();
    if (!raw) return "";
    const up = raw.toUpperCase();
    if (["A", "B", "C", "D"].includes(up)) return up;
    const sx = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (sx === "initial" || sx === "debutant" || sx.startsWith("deb")) return "A";
    if (sx === "intermediaire" || sx.startsWith("inter")) return "B";
    if (sx === "avance" || sx === "avancee" || sx.startsWith("avan")) return "C";
    if (sx === "expert" || sx.startsWith("exp")) return "D";
    return "";
  }

  function refLevelLabel(value) {
    const k = refLevelKey(value);
    if (k === "A") return "Débutant";
    if (k === "B") return "Intermédiaire";
    if (k === "C") return "Avancé";
    if (k === "D") return "Expert";
    return "—";
  }

  function refLevelBadge(value) {
    const k = refLevelKey(value);
    if (!k) return `<span class="sb-badge">—</span>`;
    return `<span class="sb-badge sb-badge-niv sb-badge-niv-${k.toLowerCase()}">${escapeHtml(refLevelLabel(k))}</span>`;
  }

  function normalizeColor(raw) {
    if (raw === null || raw === undefined) return "";
    const s = raw.toString().trim();
    if (!s) return "";

    // déjà du CSS
    if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl")) return s;

    // certains domaines viennent de WinForms: int ARGB signé (ex: -256)
    if (/^-?\d+$/.test(s)) {
      const n = parseInt(s, 10);
      const u = (n >>> 0);
      const r = (u >> 16) & 255;
      const g = (u >> 8) & 255;
      const b = u & 255;
      return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
    }

    // sinon on laisse passer ("red", "var(--x)", etc.)
    return s;
  }

    function computeParetoTop(list) {
    const items = Array.isArray(list) ? [...list] : [];
    const n = items.length;
    if (n === 0) return { topCount: 0, ids: new Set() };

    items.sort((a, b) => (b?.nb_postes_concernes ?? 0) - (a?.nb_postes_concernes ?? 0));

    const topN = Math.max(1, Math.ceil(n * 0.2));
    const ids = new Set(items.slice(0, topN).map(x => x.id_comp));
    return { topCount: topN, ids };
  }

  function updateParetoKpi(total, topCount) {
    setText("kpiRefPareto", (total > 0) ? `${topCount}` : "–");

    const lbl = byId("kpiRefParetoLabel");
    if (lbl) lbl.textContent = _paretoOnly ? "Pareto (Top 20%) · filtré" : "Pareto (Top 20%)";

    const card = byId("kpiRefParetoCard");
    if (card) {
      card.classList.toggle("sb-card--active", _paretoOnly);
    }
  }

  function setText(id, v) {
    const el = byId(id);
    if (el) el.textContent = v ?? "–";
  }

  function setVisible(id, visible) {
    const el = byId(id);
    if (el) el.style.display = visible ? "" : "none";
  }

  function setActiveTab(tab) {
    _activeTab = tab;

    const bComp = byId("tabRefCompetences");
    const bCert = byId("tabRefCertifs");

    if (bComp) bComp.classList.add("sb-btn");
    if (bCert) bCert.classList.add("sb-btn");

    if (bComp) bComp.classList.toggle("sb-btn--accent", tab === "competences");
    if (bComp) bComp.classList.toggle("sb-btn--soft", tab !== "competences");

    if (bCert) bCert.classList.toggle("sb-btn--accent", tab === "certifs");
    if (bCert) bCert.classList.toggle("sb-btn--soft", tab !== "certifs");

    const wrapComp = byId("wrapRefCompetences");
    const wrapCert = byId("wrapRefCertifs");

    if (wrapComp) wrapComp.style.display = (tab === "competences") ? "" : "none";
    if (wrapCert) wrapCert.style.display = (tab === "certifs") ? "" : "none";
  }


  function fillDomaineSelect(domaines) {
    const sel = byId("refDomaineSelect");
    if (!sel) return;

    const current = sel.value || "";
    sel.innerHTML = `<option value="">Tous les domaines</option>`;

    (domaines || []).forEach(d => {
      if (!d || !d.id_domaine_competence) return;
      const opt = document.createElement("option");
      opt.value = d.id_domaine_competence;
      opt.textContent = (d.titre_court || d.titre || d.id_domaine_competence);
      sel.appendChild(opt);
    });

    if (current && Array.from(sel.options).some(o => o.value === current)) {
      sel.value = current;
    }
  }

  function qualityCell(item) {
    const niv = item.niveaux_complets ? `<span class="sb-badge sb-badge-accent">A/B/C/D ok</span>` : `<span class="sb-badge">Niveaux incomplets</span>`;
    const grid = item.grille_presente ? `<span class="sb-badge sb-badge-accent">Grille ok</span>` : `<span class="sb-badge">Sans grille</span>`;
    return `<div style="display:flex; gap:6px; flex-wrap:wrap;">${niv}${grid}</div>`;
  }

  function domaineCell(item) {
    const label = (item.domaine_titre_court || item.domaine_titre || item.id_domaine_competence || "Domaine").toString();
    const c = normalizeColor(item.domaine_couleur);
    const style = c ? ` style="--dom-color:${escapeHtml(c)}"` : "";
    return `<span class="sb-badge-domaine sb-badge-domaine--soft"${style}>${escapeHtml(label)}</span>`;
  }

  function levelLabelOnly(value) {
    if (window.NovoskillLevels) return window.NovoskillLevels.label(value);
    const k = (value ?? "").toString().trim().toUpperCase();
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[k]) || (value || "—");
  }

  function niveauRequisCell(item) {
    const a = (item.niveau_requis_min || "").trim();
    const b = (item.niveau_requis_max || "").trim();
    if (!a && !b) return "—";
    if (a && b && a !== b) return `${escapeHtml(levelLabelOnly(a))} → ${escapeHtml(levelLabelOnly(b))}`;
    return escapeHtml(levelLabelOnly(a || b));
  }

  function renderCompetences(list) {
    const body = byId("tblRefCompetencesBody");
    if (!body) return;

    body.innerHTML = "";
    (list || []).forEach(it => {
      const tr = document.createElement("tr");
      tr.setAttribute("data-id_comp", it.id_comp);

      const code = (it.code || "").toString().trim();
      const title = (it.intitule || "").toString().trim();

      tr.innerHTML = `
        <td class="col-title">
          <div class="ref-comp-titleline">
            ${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ""}
            <span class="ref-comp-title">${escapeHtml(title || "Compétence")}</span>
          </div>
        </td>
        <td class="col-domain">${domaineCell(it)}</td>
        <td class="col-center col-postes">${it.nb_postes_concernes ?? 0}</td>
        <td class="col-center col-detail">
          <div class="sb-icon-actions ref-row-actions">
            <button type="button" class="sb-icon-btn" data-action="detail" title="Voir le détail" aria-label="Voir le détail">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            <button type="button" class="sb-icon-btn sb-icon-btn--doc" data-action="pdf" title="Ouvrir la fiche compétence PDF" aria-label="Ouvrir la fiche compétence PDF">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"></path>
                <path d="M14 2v6h6"></path>
                <path d="M8.5 15.5h7"></path>
                <path d="M8.5 18.5h5"></path>
              </svg>
            </button>
          </div>
        </td>
      `;

      body.appendChild(tr);
    });
  }

  function renderCertifs(list) {
    const body = byId("tblRefCertifsBody");
    if (!body) return;

    body.innerHTML = "";
    const rank = (v) => {
      const s = (v || "").toString().toLowerCase();
      if (s === "requis") return 0;
      if (s === "souhaite" || s === "souhaité") return 1;
      return 2;
    };

    const items = Array.isArray(list) ? [...list] : [];
    items.sort((a, b) => {
      const ra = rank(a?.niveau_exigence_max);
      const rb = rank(b?.niveau_exigence_max);
      if (ra !== rb) return ra - rb;
      const ca = (a?.categorie || "").toString().localeCompare((b?.categorie || "").toString(), "fr");
      if (ca !== 0) return ca;
      return (a?.nom_certification || "").toString().localeCompare((b?.nom_certification || "").toString(), "fr");
    });

    items.forEach(it => {
      const tr = document.createElement("tr");
      tr.setAttribute("data-id_certification", it.id_certification);

      const validite = (it.validite_mixed === true)
        ? "Variable"
        : (it.duree_validite === null || it.duree_validite === undefined)
          ? "—"
          : (Number(it.duree_validite) === 0 ? "Permanent" : `${it.duree_validite} mois`);

      tr.innerHTML = `
        <td class="col-title" style="font-weight:600;">${escapeHtml(it.nom_certification)}</td>
        <td>${escapeHtml(it.categorie || "—")}</td>
        <td style="white-space:nowrap;">${escapeHtml(validite)}</td>
        <td class="col-center" style="white-space:nowrap;">${escapeHtml(it.niveau_exigence_max || "—")}</td>
        <td class="col-center col-postes">${it.nb_postes_concernes ?? 0}</td>
        <td class="col-center col-detail">
          <div class="sb-icon-actions ref-row-actions">
            <button type="button" class="sb-icon-btn" data-action="detail" title="Voir le détail" aria-label="Voir le détail">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
        </td>
      `;

      body.appendChild(tr);
    });
  }

  function showEmptyIfNeeded(count) {
    const empty = byId("refEmpty");
    if (!empty) return;
    empty.style.display = (count || 0) === 0 ? "" : "none";
  }

  function openModal(title, sub, htmlBody) {
    const modal = byId("modalRefDetail");
    if (!modal) return;

    const t = byId("refModalTitle");
    const s = byId("refModalSub");
    const b = byId("refModalBody");

    if (t) {
      // title peut être un string OU un objet { html: "..." } pour du rendu enrichi
      if (title && typeof title === "object" && typeof title.html === "string") t.innerHTML = title.html;
      else t.textContent = title || "Détail";
    }
    if (s) s.innerHTML = sub || "";
    if (b) b.innerHTML = htmlBody || "";

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");

    // on remet le scroll en haut (sinon l'utilisateur arrive en plein milieu)
    const body = modal.querySelector(".modal-body");
    if (body) body.scrollTop = 0;
  }

  function closeModal() {
    const modal = byId("modalRefDetail");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }
  
  async function loadServices(portal) {
    portal.showAlert("", "");

    try {
      await window.portal.serviceFilter.populateSelect({
        portal: window.portal,
        contactId: portal.contactId,
        selectId: "refServiceSelect",
        storageKey: "sb_ref_service",
        labelAll: "Tous les services",
        labelNonLie: "Non lié",
        includeAll: true,
        includeNonLie: true,
        allowIndent: true
      });

      _servicesLoaded = true;
    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement services : " + e.message);
    }
  }


  function getFilters() {
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    const id_domaine = (byId("refDomaineSelect")?.value || "").trim();
    const q = (byId("refSearch")?.value || "").trim();
    const etat = (byId("refEtatSelect")?.value || "").trim();

    return { id_service, id_domaine, q, etat };
  }

  function setScopeLabel(serviceName, id_service) {
    const title = byId("refScopeTitle");
    const sub = byId("refScopeLabel");
    const raw = (id_service || "").trim();
    const name = (serviceName || "").toString().trim();

    if (title) {
      if (!raw || raw === ALL_SERVICES_ID) title.textContent = "Référentiel de l’entreprise";
      else title.textContent = `Référentiel du service : ${name || "—"}`;
    }

    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }
  }

  function setCountsForTab(count, tab) {
    const el = byId("refCount");
    if (!el) return;

    if (tab === "certifs") el.textContent = `${count ?? 0} certification(s) requise(s)`;
    else el.textContent = `${count ?? 0} compétence(s) requise(s)`;
  }

  function getCurrentPage() {
    return _activeTab === "certifs" ? _currentPageCert : _currentPageComp;
  }

  function setCurrentPage(page) {
    const n = Math.max(1, Number(page) || 1);
    if (_activeTab === "certifs") _currentPageCert = n;
    else _currentPageComp = n;
  }

  function getActiveList() {
    return _activeTab === "certifs" ? _currentCertList : _currentCompList;
  }

  function getPagedItems(list) {
    const items = Array.isArray(list) ? list : [];
    const total = items.length;
    const pageSize = Math.max(1, Number(_pageSize) || 25);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, getCurrentPage()), totalPages);

    setCurrentPage(safePage);

    const start = total === 0 ? 0 : ((safePage - 1) * pageSize);
    const end = Math.min(start + pageSize, total);
    return { items: items.slice(start, end), total, start, end, totalPages, page: safePage, pageSize };
  }

  function updateRangeLabel(total, start, end) {
    const el = byId("refRangeLabel");
    if (!el) return;

    if (!total) {
      el.textContent = "0–0 sur 0";
      return;
    }

    el.textContent = `${start + 1}–${end} sur ${total}`;
  }

  function buildPaginationTokens(totalPages, page) {
    if (totalPages <= 5) {
      const all = [];
      for (let i = 1; i <= totalPages; i += 1) all.push(i);
      return all;
    }

    const tokens = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);

    if (start > 2) tokens.push("ellipsis-left");
    for (let i = start; i <= end; i += 1) tokens.push(i);
    if (end < totalPages - 1) tokens.push("ellipsis-right");
    tokens.push(totalPages);

    return tokens;
  }

  function renderPagination(total, totalPages, page) {
    const host = byId("refPagination");
    if (!host) return;

    const prevDisabled = page <= 1 ? ' disabled' : '';
    const nextDisabled = page >= totalPages ? ' disabled' : '';
    const tokens = buildPaginationTokens(totalPages, page);

    host.innerHTML = `
      <button type="button" class="sb-icon-btn ref-page-nav" data-page-nav="prev" title="Page précédente" aria-label="Page précédente"${prevDisabled}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
      </button>
      ${tokens.map(t => {
        if (typeof t === "string") return `<span class="ref-page-ellipsis" aria-hidden="true">…</span>`;
        return `<button type="button" class="ref-page-btn${t === page ? ' is-active' : ''}" data-page="${t}" aria-label="Page ${t}" aria-current="${t === page ? 'page' : 'false'}">${t}</button>`;
      }).join("")}
      <button type="button" class="sb-icon-btn ref-page-nav" data-page-nav="next" title="Page suivante" aria-label="Page suivante"${nextDisabled}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>
      </button>
    `;
  }

  function renderActiveList() {
    const list = getActiveList();
    const pageData = getPagedItems(list);

    if (_activeTab === "certifs") renderCertifs(pageData.items);
    else renderCompetences(pageData.items);

    setCountsForTab(pageData.total, _activeTab);
    showEmptyIfNeeded(pageData.total);
    updateRangeLabel(pageData.total, pageData.start, pageData.end);
    renderPagination(pageData.total, pageData.totalPages, pageData.page);
  }

  async function fetchCompetences(portal, id_contact, filters) {
    const { id_service, id_domaine, q, etat } = filters;
    const key = `${id_service}|${id_domaine}|${q}|${etat}`;
    if (_cacheComp.has(key)) return _cacheComp.get(key);

    const params = new URLSearchParams();
    if (id_domaine) params.set("id_domaine", id_domaine);
    if (q) params.set("q", q);
    if (etat !== "") params.set("etat", etat);

    const url = `${portal.apiBase}/skills/referentiel/competences/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}?${params.toString()}`;
    const data = await portal.apiJson(url);

    _cacheComp.set(key, data);
    return data;
  }

  async function fetchCertifs(portal, id_contact, filters) {
    const { id_service, q } = filters;
    const key = `${id_service}|${q}`;
    if (_cacheCert.has(key)) return _cacheCert.get(key);

    const params = new URLSearchParams();
    if (q) params.set("q", q);

    const url = `${portal.apiBase}/skills/referentiel/certifications/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}?${params.toString()}`;
    const data = await portal.apiJson(url);

    _cacheCert.set(key, data);
    return data;
  }

  async function refreshAll(portal) {
    const id_contact = portal?.contactId || window.portal.contactId;
    if (!id_contact) return;

    const f = getFilters();
    if (!f.id_service) f.id_service = ALL_SERVICES_ID;

    localStorage.setItem("sb_ref_service", f.id_service);

    try {
      portal.showAlert("", "");

      // Compétences + certifs (en parallèle)
      const pComp = fetchCompetences(portal, id_contact, f);
      const pCert = fetchCertifs(portal, id_contact, f);

      const [comp, cert] = await Promise.allSettled([pComp, pCert]);

      // Compétences
      if (comp.status === "fulfilled" && comp.value) {
        const data = comp.value;
        setScopeLabel(data?.service?.nom_service || "", f.id_service);
        fillDomaineSelect(data?.domaines || []);

        setText("kpiRefPostes", data?.kpis?.nb_postes ?? "–");
        setText("kpiRefCompetences", data?.kpis?.nb_items ?? "–");

        const listAll = Array.isArray(data?.competences) ? data.competences : [];
        _lastCompList = listAll;

        const p = computeParetoTop(listAll);
        _paretoTopIds = p.ids;
        _paretoTopCount = p.topCount;

        updateParetoKpi(listAll.length, _paretoTopCount);

        _currentCompList = _paretoOnly
          ? listAll.filter(x => _paretoTopIds.has(x.id_comp))
          : listAll;

        if (_activeTab === "competences") {
          renderActiveList();
        }

      }

      // Certifications
      if (cert.status === "fulfilled" && cert.value) {
        const data = cert.value;
        setText("kpiRefCertifs", data?.kpis?.nb_items ?? "–");
        _currentCertList = Array.isArray(data?.certifications) ? data.certifications : [];

        if (_activeTab === "certifs") {
          renderActiveList();
        }
      }

      // Si onglet actif mais chargement a échoué
      if (_activeTab === "competences" && (comp.status !== "fulfilled")) {
        _currentCompList = [];
        renderActiveList();
      }
      if (_activeTab === "certifs" && (cert.status !== "fulfilled")) {
        _currentCertList = [];
        renderActiveList();
      }

    } catch (e) {
      portal.showAlert("error", "Erreur référentiel : " + e.message);
      console.error(e);
    }
  }

  function renderGridEvaluation(grid) {
    if (!grid || typeof grid !== "object") return "";

    const keys = Object.keys(grid);
    if (!keys.length) return "";

    let html = `<div class="card" style="padding:12px; margin:0;">
      <div class="card-title" style="margin-bottom:6px;">Grille d’évaluation</div>
      <div class="card-sub" style="margin:0;">Critères et niveaux d’évaluation.</div>
      <div style="margin-top:10px;">`;

    // On n'affiche que les critères réellement renseignés (sinon ça fait "Critere4" avec un tiret, très glamour).
    let nbCriteres = 0;

    keys.forEach(k => {
      const c = grid[k] || {};

      const nomRaw = (c.Nom ?? c.nom ?? "").toString().trim();
      const evalsRaw = Array.isArray(c.Eval || c.eval) ? (c.Eval || c.eval) : [];
      const evals = (evalsRaw || []).map(x => (x ?? "").toString().trim()).filter(x => x.length);

      if (!evals.length) return; // critère vide => ignoré

      const nom = escapeHtml(nomRaw || k);
      nbCriteres += 1;

      html += `
        <details class="sb-accordion">
          <summary style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:600;">${nom}</span>
            <span class="sb-badge sb-badge-critere">${escapeHtml(k)}</span>
          </summary>
          <div class="sb-acc-body">
            <ul style="margin:0; padding-left:18px;">
              ${evals.map(x => `<li>${escapeHtml(x)}</li>`).join("")}
            </ul>
          </div>
        </details>
      `;
    });

    if (nbCriteres === 0) return "";

    html += `</div></div>`;
    return html;
  }

  function critLevel(raw) {
    const n = Number(raw);
    if (!isFinite(n)) return 0;

    // Tolérance si la DB stocke déjà un niveau 1..5
    if (n > 0 && n <= 5 && Number.isInteger(n)) return n;

    // Sinon on considère un score 0..100 (poids_criticite)
    if (n >= 80) return 5;
    if (n >= 60) return 4;
    if (n >= 40) return 3;
    if (n >= 20) return 2;
    return 1;
  }

  function renderCritBadge(raw) {
    const n = Number(raw);
    if (!isFinite(n)) return "—";

    const lvl = critLevel(n);
    const safe = escapeHtml(String(n));
    return `<span class="sb-crit-badge sb-crit-l${lvl}" title="Criticité : ${safe}">${safe}</span>`;
  }


  function levelBadgeHtml(value, title) {
    if (window.NovoskillLevels) return window.NovoskillLevels.badgeHtml(value, title || "Niveau de maîtrise");
    const raw = (value ?? "").toString().trim();
    const k = raw.toUpperCase();
    const map = { A: ["Débutant", "sb-badge-niv-a"], B: ["Intermédiaire", "sb-badge-niv-b"], C: ["Avancé", "sb-badge-niv-c"], D: ["Expert", "sb-badge-niv-d"] };
    const item = map[k];
    if (!item) return `<span class="sb-badge sb-badge-niv">${escapeHtml(raw || "—")}</span>`;
    return `<span class="sb-badge sb-badge-niv ${item[1]}" title="${escapeHtml(title || "Niveau de maîtrise")}">${escapeHtml(item[0])}</span>`;
  }

  function renderPostesTable(postes, isCertif, baseValidite) {
    const list = Array.isArray(postes) ? [...postes] : [];

    // Compétences: tri décroissant par criticité (puis libellé) pour cohérence UI
    if (!isCertif) {
      list.sort((a, b) => {
        const ca = (a?.poids_criticite === null || a?.poids_criticite === undefined) ? -1 : Number(a.poids_criticite);
        const cb = (b?.poids_criticite === null || b?.poids_criticite === undefined) ? -1 : Number(b.poids_criticite);
        if (cb !== ca) return cb - ca;
        const ta = (a?.intitule_poste || "").toString();
        const tb = (b?.intitule_poste || "").toString();
        const tcmp = ta.localeCompare(tb, "fr");
        if (tcmp !== 0) return tcmp;
        return (a?.codif_poste || "").toString().localeCompare((b?.codif_poste || "").toString(), "fr");
      });
    }

    const title = isCertif ? "Postes concernés" : "Postes concernés (niveau requis)";
    const cols = isCertif
      ? ["Poste", "Service", "Exigence", "Validité"]
      : ["Poste", "Service", "Niveau", "Criticité"];

    const ths = cols.map((c, idx) => {
      const center = (idx === 2 || idx === 3);
      return `<th${center ? ` class="col-center"` : ""}>${escapeHtml(c)}</th>`;
    }).join("");

    let html = `<div class="card" style="padding:12px; margin:0;">
      <div class="card-title" style="margin-bottom:6px;">${escapeHtml(title)}</div>
      <div class="card-sub" style="margin:0;">${list.length} poste(s) impacté(s).</div>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table sb-ref-postes-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>`;

    if (!list.length) {
      html += `<tr><td colspan="${cols.length}">—</td></tr>`;
    } else {
      list.forEach(p => {
        // On enlève le “code poste” : on garde uniquement l’intitulé (fallback codif si absent)
        const posteTitle = ((p.intitule_poste || "").toString().trim()) || ((p.codif_poste || "").toString().trim()) || "—";
        const poste = escapeHtml(posteTitle);
        const service = escapeHtml(p.nom_service || "—");

        if (isCertif) {
          const ex = escapeHtml(p.niveau_exigence || "—");

          const base = (baseValidite === null || baseValidite === undefined) ? null : Number(baseValidite);
          const ovRaw = (p.validite_override === null || p.validite_override === undefined) ? null : Number(p.validite_override);
          const eff = (ovRaw !== null) ? ovRaw : base;

          let vlabel = "—";
          if (eff !== null) vlabel = (eff === 0 ? "Permanent" : `${eff} mois`);

          html += `<tr>
            <td>${poste}</td>
            <td>${service}</td>
            <td class="col-center" style="white-space:nowrap;">${ex}</td>
            <td class="col-center" style="white-space:nowrap;">${escapeHtml(vlabel)}</td>
          </tr>`;
        } else {
          const niv = refLevelBadge(p.niveau_requis);
          const crit = renderCritBadge(p.poids_criticite);

          html += `<tr>
            <td>${poste}</td>
            <td>${service}</td>
            <td class="col-center" style="white-space:nowrap;">${niv}</td>
            <td class="col-center" style="white-space:nowrap;">${crit}</td>
          </tr>`;
        }
      });
    }

    html += `</tbody></table></div></div>`;
    return html;
  }


  function buildCompetenceDetailView(data) {
    const c = data?.competence || {};
    const dom = c?.domaine || null;

    const code = (c.code || "").toString().trim();
    const label = (c.intitule || "Compétence").toString().trim();

    const title = code
      ? { html: `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span><span class="sb-ref-title-text">${escapeHtml(label)}</span>` }
      : label;
    let sub = "";
    if (dom) {
      const domLabel = (dom.titre_court || dom.titre || dom.id_domaine_competence || "Domaine").toString();
      const col = normalizeColor(dom.couleur) || "#e5e7eb";
      sub = `<span class="domain-pill" title="${escapeHtml(domLabel)}"><span class="domain-dot" style="background:${escapeHtml(col)};"></span><span>${escapeHtml(domLabel)}</span></span>`;
    }

    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;

    const levels = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Niveaux</div>

        <div class="ref-levels-table">
          <div class="ref-level-row">
            ${levelBadgeHtml("A", "Débutant")}
            <div class="ref-level-text">${escapeHtml(c.niveaua || "—")}</div>
          </div>

          <div class="ref-level-row">
            ${levelBadgeHtml("B", "Intermédiaire")}
            <div class="ref-level-text">${escapeHtml(c.niveaub || "—")}</div>
          </div>

          <div class="ref-level-row">
            ${levelBadgeHtml("C", "Avancé")}
            <div class="ref-level-text">${escapeHtml(c.niveauc || "—")}</div>
          </div>

          <div class="ref-level-row">
            ${levelBadgeHtml("D", "Expert")}
            <div class="ref-level-text">${escapeHtml(c.niveaud || "—")}</div>
          </div>
        </div>
      </div>
    `;

    const grid = renderGridEvaluation(c.grille_evaluation);
    const postes = renderPostesTable(data?.postes_concernes || [], false, null);

    const body = `
      <div class="row" style="flex-direction:column; gap:12px;">
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Description</div>
          ${desc}
        </div>
        ${levels}
        ${grid}
        ${postes}
      </div>
    `;

    return { title, sub, body };
  }

  function buildCertifDetailView(data) {
    const c = data?.certification || {};
    const title = c.nom_certification || "Certification";

    const badges = [];
    if (c.categorie) badges.push(`<span class="sb-badge">${escapeHtml(c.categorie)}</span>`);
    const base = (c.duree_validite === null || c.duree_validite === undefined) ? null : Number(c.duree_validite);
    const postesList = Array.isArray(data?.postes_concernes) ? data.postes_concernes : [];

    const overrides = postesList
      .map(p => (p.validite_override === null || p.validite_override === undefined) ? null : Number(p.validite_override))
      .filter(v => v !== null);

    const distinct = Array.from(new Set(overrides));

    let effective = base;
    let differs = false;
    let mixed = false;

    if (distinct.length === 0) {
      effective = base;
      differs = false;
    } else if (distinct.length === 1) {
      effective = distinct[0];
      differs = (base !== null && effective !== base);
    } else {
      mixed = true;
      differs = true;
      effective = null;
    }

    let label = "—";
    if (mixed) label = "Variable";
    else if (effective !== null) label = (effective === 0 ? "Permanent" : `${effective} mois`);

    const styleOk = "border:1px solid rgba(34,197,94,.35); background:rgba(34,197,94,.12); color:#166534;";
    const styleBad = "border:1px solid rgba(239,68,68,.35); background:rgba(239,68,68,.10); color:#991b1b;";
    const badgeStyle = differs ? styleBad : styleOk;

    if (label !== "—") badges.push(`<span class="sb-badge" style="${badgeStyle}">${escapeHtml(label)}</span>`);

    const sub = badges.join(" ");
    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;
    const postes = renderPostesTable(data?.postes_concernes || [], true, c.duree_validite);

    const body = `
      <div class="row" style="flex-direction:column; gap:12px;">
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Description</div>
          ${desc}
        </div>
        ${postes}
      </div>
    `;

    return { title, sub, body };
  }

  async function fetchReferentielCompetencePdfBlob(portal, id_contact, id_service, id_comp) {
    const paths = [
      `/skills/referentiel/competences/fiche_pdf/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_comp)}`,
      `/skills/referentiel/competence/fiche_pdf/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_comp)}`
    ];

    const headers = new Headers();
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    let lastError = "Erreur PDF compétence.";
    for (const path of paths) {
      const resp = await fetch(`${portal.apiBase}${path}`, { headers });
      if (resp.ok) return await resp.blob();

      try {
        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const js = await resp.json();
          lastError = js?.detail || js?.message || JSON.stringify(js);
        } else {
          lastError = await resp.text() || `Erreur PDF (${resp.status})`;
        }
      } catch (_) {
        lastError = `Erreur PDF (${resp.status})`;
      }

      if (resp.status !== 404) break;
    }

    throw new Error(lastError);
  }

  function renderPdfBlobInWindow(popupWin, blob, title) {
    const win = popupWin && !popupWin.closed ? popupWin : window.open("about:blank", "_blank");
    if (!win) throw new Error("Ouverture du PDF bloquée par le navigateur.");

    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = escapeHtml(title || "Fiche compétence");

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
    try { win.addEventListener("beforeunload", revoke, { once: true }); } catch (_) {}
    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function openCompetencePdf(portal, id_comp) {
    const id_contact = portal.contactId;
    const id_service = (byId("refServiceSelect")?.value || "").trim() || ALL_SERVICES_ID;
    if (!id_contact || !id_comp) return;

    const item = _lastCompList.find(x => String(x?.id_comp || "") === String(id_comp)) || {};
    const title = `Fiche compétence - ${String(item?.code || "").trim() ? `${String(item.code).trim()} - ` : ""}${String(item?.intitule || "").trim() || "Compétence"}`;

    const popupWin = window.open("about:blank", "_blank");
    if (popupWin) popupWin.document.write("<p style='font-family:Arial,sans-serif;padding:16px;'>Ouverture du PDF…</p>");

    try {
      const blob = await fetchReferentielCompetencePdfBlob(portal, id_contact, id_service, id_comp);
      renderPdfBlobInWindow(popupWin, blob, title);
    } catch (e) {
      try { if (popupWin && !popupWin.closed) popupWin.close(); } catch (_) {}
      throw e;
    }
  }

  async function openCompetenceDetail(portal, id_comp) {
    const id_contact = portal.contactId;
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    if (!id_service) return;

    const url = `${portal.apiBase}/skills/referentiel/competence/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_comp)}`;
    const data = await portal.apiJson(url);
    const view = buildCompetenceDetailView(data);
    openModal(view.title, view.sub, view.body);
  }


  async function openCertifDetail(portal, id_certification) {
    const id_contact = portal.contactId;
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    if (!id_service) return;

    const url = `${portal.apiBase}/skills/referentiel/certification/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_certification)}`;
    const data = await portal.apiJson(url);
    const view = buildCertifDetailView(data);
    openModal(view.title, view.sub, view.body);
  }


  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    setActiveTab("competences");

    const selService = byId("refServiceSelect");
    const selDom = byId("refDomaineSelect");
    const txtSearch = byId("refSearch");
    const selEtat = byId("refEtatSelect");
    const btnReset = byId("btnRefReset");
    const btnApply = byId("btnRefApply");
    const btnFiltersToggle = byId("btnRefFiltersToggle");
    const kpiParetoCard = byId("kpiRefParetoCard");
    const pageSizeSelect = byId("refPageSizeSelect");
    const pagination = byId("refPagination");

    const tabComp = byId("tabRefCompetences");
    const tabCert = byId("tabRefCertifs");

    const tbodyComp = byId("tblRefCompetencesBody");
    const tbodyCert = byId("tblRefCertifsBody");

    const btnX = byId("btnCloseRefModal");
    const btnClose = byId("btnRefModalClose");
    const modal = byId("modalRefDetail");

    if (pageSizeSelect) pageSizeSelect.value = String(_pageSize);

    if (selService) {
      selService.addEventListener("change", () => {
        _cacheComp.clear();
        _cacheCert.clear();
        _paretoOnly = false;
        _currentPageComp = 1;
        _currentPageCert = 1;
        // reset domaine au changement de service (sinon filtre vide et utilisateur croit que "ça bug")
        if (selDom) selDom.value = "";
        refreshAll(portal);
      });
    }

    const refreshDebounced = () => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        setCurrentPage(1);
        refreshAll(portal);
      }, 250);
    };

    if (selDom) selDom.addEventListener("change", () => {
      setCurrentPage(1);
      refreshAll(portal);
    });
    if (selEtat) selEtat.addEventListener("change", () => {
      setCurrentPage(1);
      refreshAll(portal);
    });

    if (txtSearch) {
      txtSearch.addEventListener("input", refreshDebounced);
      txtSearch.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          clearTimeout(_searchTimer);
          setCurrentPage(1);
          refreshAll(portal);
        }
      });
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        // reset filtres
        if (selService) selService.value = ALL_SERVICES_ID; // <-- le vrai fix
        if (selDom) selDom.value = "";
        if (txtSearch) txtSearch.value = "";
        if (selEtat) selEtat.value = "active";

        // reset état UI
        _paretoOnly = false;
        updateParetoKpi(_lastCompList.length, _paretoTopCount);

        _currentPageComp = 1;
        _currentPageCert = 1;

        // cache + refresh
        _cacheComp.clear();
        _cacheCert.clear();
        refreshAll(portal);
      });
    }

    if (btnApply) {
      btnApply.addEventListener("click", () => {
        _currentPageComp = 1;
        _currentPageCert = 1;
        refreshAll(portal);
      });
    }

    if (btnFiltersToggle) {
      btnFiltersToggle.addEventListener("click", () => {
        const card = btnFiltersToggle.closest(".ref-filter-card");
        const isCollapsed = card ? card.classList.toggle("is-collapsed") : false;
        btnFiltersToggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        btnFiltersToggle.title = isCollapsed ? "Déplier les filtres" : "Replier les filtres";
        btnFiltersToggle.setAttribute("aria-label", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
      });
    }

    if (pageSizeSelect) {
      pageSizeSelect.addEventListener("change", () => {
        const next = Number(pageSizeSelect.value) || 10;
        _pageSize = next;
        setCurrentPage(1);
        renderActiveList();
      });
    }

    if (pagination) {
      pagination.addEventListener("click", (ev) => {
        const navBtn = ev.target.closest("[data-page-nav]");
        const pageBtn = ev.target.closest("[data-page]");

        if (navBtn) {
          if (navBtn.disabled) return;
          const dir = navBtn.getAttribute("data-page-nav");
          const current = getCurrentPage();
          setCurrentPage(dir === "prev" ? current - 1 : current + 1);
          renderActiveList();
          return;
        }

        if (pageBtn) {
          const nextPage = Number(pageBtn.getAttribute("data-page") || "1") || 1;
          setCurrentPage(nextPage);
          renderActiveList();
        }
      });
    }

    if (kpiParetoCard) {
      kpiParetoCard.addEventListener("click", () => {
        // Pareto ne s'applique qu'aux compétences
        if (_activeTab !== "competences") return;

        _paretoOnly = !_paretoOnly;
        updateParetoKpi(_lastCompList.length, _paretoTopCount);

        _currentCompList = _paretoOnly
          ? _lastCompList.filter(x => _paretoTopIds.has(x.id_comp))
          : _lastCompList;

        _currentPageComp = 1;
        renderActiveList();
      });
    }

    if (tabComp) {
      tabComp.addEventListener("click", async () => {
        setActiveTab("competences");
        renderActiveList();
        await refreshAll(portal);
      });
    }

    if (tabCert) {
      tabCert.addEventListener("click", async () => {
        setActiveTab("certifs");
        renderActiveList();
        await refreshAll(portal);
      });
    }

    if (tbodyComp) {
      tbodyComp.addEventListener("click", async (ev) => {
        const tr = ev.target.closest("tr");
        const id_comp = tr?.getAttribute("data-id_comp");
        if (!id_comp) return;

        const actionBtn = ev.target.closest("[data-action]");
        const action = actionBtn?.getAttribute("data-action") || "detail";

        try {
          if (action === "pdf") await openCompetencePdf(portal, id_comp);
          else await openCompetenceDetail(portal, id_comp);
        } catch (e) {
          const prefix = action === "pdf" ? "Erreur PDF compétence : " : "Erreur détail compétence : ";
          portal.showAlert("error", prefix + e.message);
        }
      });
    }

    if (tbodyCert) {
      tbodyCert.addEventListener("click", async (ev) => {
        const tr = ev.target.closest("tr");
        const id_cert = tr?.getAttribute("data-id_certification");
        if (!id_cert) return;

        try {
          await openCertifDetail(portal, id_cert);
        } catch (e) {
          portal.showAlert("error", "Erreur détail certification : " + e.message);
        }
      });
    }

    const close = () => closeModal();

    if (btnX) btnX.addEventListener("click", close);
    if (btnClose) btnClose.addEventListener("click", close);

    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });
    }
  }

  window.SkillsReferentielCompetence = {
    onShow: async (portal) => {
      window.__skillsPortalInstance = portal;

      try {
        bindOnce(portal);       


        if (!_servicesLoaded) await loadServices(portal);

        // premier refresh
        await refreshAll(portal);

      } catch (e) {
        portal.showAlert("error", "Erreur référentiel compétences : " + e.message);
        console.error(e);
      }
    }
  };
})();
