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
  let _lastDetailPostes = [];
  let _lastDetailCollaborateurs = [];

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


  function iconSvg(name) {
    const icons = {
      description: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg>`,
      levels: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"/><path d="M9 19v-6"/><path d="M14 19V9"/><path d="M19 19V3"/></svg>`,
      grid: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
      postes: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M4 12h16"/></svg>`,
      collabs: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      domain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>`,
      criteria: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
      users: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      eye: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
      doc: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8.5 15.5h7"></path><path d="M8.5 18.5h5"></path></svg>`,
    };
    return icons[name] || "";
  }

  function sectionTitleHtml(icon, title) {
    return `<div class="ref-modal-section-titleline"><span class="ref-modal-section-icon" aria-hidden="true">${iconSvg(icon)}</span><div class="card-title ref-modal-section-title">${escapeHtml(title)}</div></div>`;
  }

  function formatDateFR(iso) {
    const s = (iso || "").toString().trim();
    if (!s) return "—";
    const ymd = s.slice(0, 10);
    const parts = ymd.split("-");
    if (parts.length !== 3) return escapeHtml(s);
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function stripEvalLevelPrefix(value) {
    return (value || "").toString().trim().replace(/^\s*(débutant|debutant|intermédiaire|intermediaire|avancé|avance|expert)\s*[:\-–—]\s*/i, "");
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

  function ensureCertifsHeaderAlignment() {
    const table = byId("tblRefCertifs");
    const exigenceHeader = table?.querySelector("thead th:nth-child(4)");
    if (exigenceHeader) exigenceHeader.classList.add("col-center");
  }

  function certifRequirementBadge(value) {
    const raw = (value || "").toString().trim();
    const normalized = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

    if (normalized === "requis") {
      return `<span class="sb-badge sb-badge-certif-requis">Requis</span>`;
    }

    if (normalized === "souhaite" || normalized === "souhaitee") {
      return `<span class="sb-badge sb-badge-certif-souhaite">Souhaité</span>`;
    }

    return `<span class="sb-badge">${escapeHtml(raw || "—")}</span>`;
  }

  function renderCertifs(list) {
    const body = byId("tblRefCertifsBody");
    if (!body) return;

    ensureCertifsHeaderAlignment();
    body.innerHTML = "";
    const rank = (v) => {
      const s = (v || "").toString().toLowerCase();
      if (s === "requis") return 0;
      if (s === "souhaite" || s === "souhaité") return 1;
      return 2;
    };

    const categoryKey = (item) => {
      const v = (item?.categorie || "").toString().trim();
      return v || "zzzzzz";
    };

    const items = Array.isArray(list) ? [...list] : [];
    items.sort((a, b) => {
      const ca = categoryKey(a).localeCompare(categoryKey(b), "fr", { sensitivity: "base" });
      if (ca !== 0) return ca;
      const ra = rank(a?.niveau_exigence_max);
      const rb = rank(b?.niveau_exigence_max);
      if (ra !== rb) return ra - rb;
      return (a?.nom_certification || "").toString().localeCompare((b?.nom_certification || "").toString(), "fr", { sensitivity: "base" });
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
        <td class="col-center" style="white-space:nowrap;">${certifRequirementBadge(it.niveau_exigence_max)}</td>
        <td class="col-center col-postes">${it.nb_postes_concernes ?? 0}</td>
        <td class="col-center col-possedes">${it.nb_collaborateurs_possedant ?? 0}</td>
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

  function countGridCriteria(grid) {
    if (!grid || typeof grid !== "object") return 0;
    let n = 0;
    Object.keys(grid).forEach(k => {
      const c = grid[k] || {};
      const evalsRaw = Array.isArray(c.Eval || c.eval) ? (c.Eval || c.eval) : [];
      const evals = (evalsRaw || []).map(x => (x ?? "").toString().trim()).filter(Boolean);
      if (evals.length) n += 1;
    });
    return n;
  }

  function renderGridEvaluation(grid) {
    if (!grid || typeof grid !== "object") return "";

    const keys = Object.keys(grid);
    if (!keys.length) return "";

    const rows = [];
    keys.forEach(k => {
      const c = grid[k] || {};
      const nomRaw = (c.Nom ?? c.nom ?? "").toString().trim();
      const evalsRaw = Array.isArray(c.Eval || c.eval) ? (c.Eval || c.eval) : [];
      const evals = (evalsRaw || [])
        .map(x => stripEvalLevelPrefix(x))
        .map(x => (x ?? "").toString().trim())
        .filter(x => x.length);

      if (!evals.length) return;
      rows.push({ title: nomRaw || k, evals });
    });

    if (!rows.length) return "";

    const items = rows.map((item, idx) => {
      const isOpen = idx === 0;
      return `
        <div class="sb-accordion ref-criteria-accordion${isOpen ? " is-open" : ""}">
          <button type="button" class="sb-acc-head ref-criteria-head${isOpen ? " is-open" : ""}" data-ref-criteria-toggle aria-expanded="${isOpen ? "true" : "false"}">
            <span class="ref-criteria-title">${escapeHtml(item.title)}</span>
            <span class="ref-criteria-meta">
              <span class="sb-badge sb-badge-critere">Critère ${idx + 1}</span>
              <span class="sb-acc-chevron">▾</span>
            </span>
          </button>
          <div class="sb-acc-body ref-criteria-body"${isOpen ? "" : " style=\"display:none;\""}>
            <ul>
              ${item.evals.map(x => `<li>${escapeHtml(x)}</li>`).join("")}
            </ul>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="card ref-modal-card" style="padding:12px; margin:0;">
        ${sectionTitleHtml("grid", "Grille d’évaluation")}
        <div class="ref-criteria-list">${items}</div>
      </div>
    `;
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

    if (isCertif) {
      let html = `<div class="card ref-modal-card" style="padding:12px; margin:0;">
        ${sectionTitleHtml("postes", "Postes concernés")}
        <div class="table-wrap ref-modal-table-wrap">
          <table class="sb-table sb-ref-postes-table sb-ref-cert-postes-table">
            <thead><tr><th class="ref-col-poste">Poste</th><th class="ref-col-service">Service</th><th class="col-center ref-col-exigence">Exigence</th><th class="col-center ref-col-validite">Validité</th></tr></thead>
            <tbody>`;

      if (!list.length) {
        html += `<tr><td colspan="4">—</td></tr>`;
      } else {
        list.forEach(p => {
          const poste = escapeHtml(((p.intitule_poste || "").toString().trim()) || ((p.codif_poste || "").toString().trim()) || "—");
          const service = escapeHtml(p.nom_service || "—");
          const ex = escapeHtml(p.niveau_exigence || "—");
          const base = (baseValidite === null || baseValidite === undefined) ? null : Number(baseValidite);
          const ovRaw = (p.validite_override === null || p.validite_override === undefined) ? null : Number(p.validite_override);
          const eff = (ovRaw !== null) ? ovRaw : base;
          let vlabel = "—";
          if (eff !== null) vlabel = (eff === 0 ? "Permanent" : `${eff} mois`);

          html += `<tr>
            <td class="ref-col-poste">${poste}</td>
            <td class="ref-col-service">${service}</td>
            <td class="col-center ref-col-exigence" style="white-space:nowrap;">${ex}</td>
            <td class="col-center ref-col-validite" style="white-space:nowrap;">${escapeHtml(vlabel)}</td>
          </tr>`;
        });
      }

      html += `</tbody></table></div></div>`;
      return html;
    }

    let html = `<div class="card ref-modal-card" style="padding:12px; margin:0;">
      ${sectionTitleHtml("postes", "Postes concernés")}
      <div class="table-wrap ref-modal-table-wrap">
        <table class="sb-table sb-ref-postes-table sb-ref-postes-actions-table">
          <thead><tr><th class="ref-col-poste">Poste</th><th class="ref-col-service">Service</th><th class="col-center ref-col-niveau">Niveau requis</th><th class="col-center ref-col-criticite">Criticité</th><th class="col-center ref-col-actions">Actions</th></tr></thead>
          <tbody>`;

    if (!list.length) {
      html += `<tr><td colspan="5">—</td></tr>`;
    } else {
      list.forEach(p => {
        const idPoste = escapeHtml(p.id_poste || "");
        const code = (p.codif_poste || "").toString().trim();
        const title = ((p.intitule_poste || "").toString().trim()) || code || "—";
        const service = escapeHtml(p.nom_service || "—");
        const niv = refLevelBadge(p.niveau_requis);
        const crit = renderCritBadge(p.poids_criticite);

        html += `<tr data-ref-id-poste="${idPoste}">
          <td class="ref-col-poste"><div class="ref-poste-titleline">${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span>` : ""}<span class="ref-poste-title">${escapeHtml(title)}</span></div></td>
          <td class="ref-col-service">${service}</td>
          <td class="col-center ref-col-niveau">${niv}</td>
          <td class="col-center ref-col-criticite">${crit}</td>
          <td class="col-center ref-col-actions"><div class="sb-icon-actions ref-row-actions"><button type="button" class="sb-icon-btn" data-ref-poste-action="detail" data-id-poste="${idPoste}" title="Voir la fiche poste" aria-label="Voir la fiche poste">${iconSvg("eye")}</button><button type="button" class="sb-icon-btn sb-icon-btn--doc" data-ref-poste-action="pdf" data-id-poste="${idPoste}" title="Ouvrir la fiche poste PDF" aria-label="Ouvrir la fiche poste PDF">${iconSvg("doc")}</button></div></td>
        </tr>`;
      });
    }

    html += `</tbody></table></div></div>`;
    return html;
  }

  function renderCollaborateursTable(collaborateurs) {
    const list = Array.isArray(collaborateurs) ? collaborateurs : [];

    let html = `<div class="card ref-modal-card" style="padding:12px; margin:0;">
      ${sectionTitleHtml("collabs", "Collaborateurs concernés")}
      <div class="table-wrap ref-modal-table-wrap">
        <table class="sb-table sb-ref-collabs-table">
          <thead><tr><th class="ref-col-collab">Collaborateur</th><th class="ref-col-collab-poste">Poste</th><th class="col-center ref-col-niveau">Niveau atteint</th><th class="col-center ref-col-date">Dernière éval.</th><th class="col-center ref-col-actions">Actions</th></tr></thead>
          <tbody>`;

    if (!list.length) {
      html += `<tr><td colspan="5">Aucun collaborateur évalué sur cette compétence.</td></tr>`;
    } else {
      list.forEach(c => {
        const idEff = escapeHtml(c.id_effectif || "");
        const fullName = `${c.prenom_effectif || ""} ${(c.nom_effectif || "").toString().toUpperCase()}`.trim() || "—";
        const poste = ((c.intitule_poste || "").toString().trim()) || "—";
        const niv = refLevelBadge(c.niveau_actuel);
        const date = formatDateFR(c.date_derniere_eval);

        html += `<tr data-ref-id-effectif="${idEff}">
          <td class="ref-col-collab"><strong>${escapeHtml(fullName)}</strong></td>
          <td class="ref-col-collab-poste">${escapeHtml(poste)}</td>
          <td class="col-center ref-col-niveau">${niv}</td>
          <td class="col-center ref-col-date">${date}</td>
          <td class="col-center ref-col-actions"><div class="sb-icon-actions ref-row-actions"><button type="button" class="sb-icon-btn" data-ref-collab-action="detail" data-id-effectif="${idEff}" title="Voir la fiche collaborateur" aria-label="Voir la fiche collaborateur">${iconSvg("eye")}</button></div></td>
        </tr>`;
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
    const postesList = Array.isArray(data?.postes_concernes) ? data.postes_concernes : [];
    const collabsList = Array.isArray(data?.collaborateurs_concernes) ? data.collaborateurs_concernes : [];
    _lastDetailPostes = postesList;
    _lastDetailCollaborateurs = collabsList;

    const title = code
      ? { html: `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span><span class="sb-ref-title-text">${escapeHtml(label)}</span>` }
      : label;
    const sub = "";

    const domLabel = dom
      ? (dom.titre_court || dom.titre || dom.id_domaine_competence || "Domaine").toString()
      : "—";
    const criteriaCount = countGridCriteria(c.grille_evaluation);

    const summary = `
      <div class="ref-modal-kpi-strip">
        <div class="ref-modal-kpi-card ref-modal-kpi-card--domain"><div class="ref-modal-kpi-icon" aria-hidden="true">${iconSvg("domain")}</div><div><div class="ref-modal-kpi-label">Domaine</div><div class="ref-modal-kpi-value">${escapeHtml(domLabel)}</div></div></div>
        <div class="ref-modal-kpi-card ref-modal-kpi-card--postes"><div class="ref-modal-kpi-icon" aria-hidden="true">${iconSvg("postes")}</div><div><div class="ref-modal-kpi-label">Postes concernés</div><div class="ref-modal-kpi-value">${postesList.length}</div></div></div>
        <div class="ref-modal-kpi-card ref-modal-kpi-card--criteria"><div class="ref-modal-kpi-icon" aria-hidden="true">${iconSvg("criteria")}</div><div><div class="ref-modal-kpi-label">Critères</div><div class="ref-modal-kpi-value">${criteriaCount}</div></div></div>
        <div class="ref-modal-kpi-card ref-modal-kpi-card--collabs"><div class="ref-modal-kpi-icon" aria-hidden="true">${iconSvg("users")}</div><div><div class="ref-modal-kpi-label">Salariés concernés</div><div class="ref-modal-kpi-value">${collabsList.length}</div></div></div>
      </div>
    `;

    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;

    const levels = `
      <div class="card ref-modal-card" style="padding:12px; margin:0;">
        ${sectionTitleHtml("levels", "Niveaux de maîtrise")}
        <div class="ref-levels-table">
          <div class="ref-level-row">${levelBadgeHtml("A", "Débutant")}<div class="ref-level-text">${escapeHtml(c.niveaua || "—")}</div></div>
          <div class="ref-level-row">${levelBadgeHtml("B", "Intermédiaire")}<div class="ref-level-text">${escapeHtml(c.niveaub || "—")}</div></div>
          <div class="ref-level-row">${levelBadgeHtml("C", "Avancé")}<div class="ref-level-text">${escapeHtml(c.niveauc || "—")}</div></div>
          <div class="ref-level-row">${levelBadgeHtml("D", "Expert")}<div class="ref-level-text">${escapeHtml(c.niveaud || "—")}</div></div>
        </div>
      </div>
    `;

    const grid = renderGridEvaluation(c.grille_evaluation);
    const postes = renderPostesTable(postesList, false, null);
    const collaborateurs = renderCollaborateursTable(collabsList);

    const body = `
      <div class="ref-modal-stack">
        ${summary}
        <div class="card ref-modal-card" style="padding:12px; margin:0;">
          ${sectionTitleHtml("description", "Description")}
          ${desc}
        </div>
        ${levels}
        ${grid}
        ${postes}
        ${collaborateurs}
      </div>
    `;

    return { title, sub, body };
  }

  function renderCertifHoldersTable(collaborateurs) {
    const list = Array.isArray(collaborateurs) ? collaborateurs : [];

    let html = `<div class="card ref-modal-card" style="padding:12px; margin:0;">
      ${sectionTitleHtml("users", "Collaborateurs détenteurs")}
      <div class="table-wrap ref-modal-table-wrap">
        <table class="sb-table sb-ref-cert-holders-table">
          <thead><tr><th class="ref-col-collab">Prénom nom</th><th class="ref-col-poste">Poste</th><th class="col-center ref-col-date-obt">Date d’obtention</th><th class="col-center ref-col-date-renouv">Date renouvellement</th></tr></thead>
          <tbody>`;

    if (!list.length) {
      html += `<tr><td colspan="4">Aucun collaborateur détenteur de cette certification.</td></tr>`;
    } else {
      list.forEach(c => {
        const fullName = `${c.prenom_effectif || ""} ${(c.nom_effectif || "").toString().toUpperCase()}`.trim() || "—";
        const poste = ((c.intitule_poste || "").toString().trim()) || "—";
        const obt = formatDateFR(c.date_obtention);
        const renouv = formatDateFR(c.date_renouvellement);

        html += `<tr>
          <td class="ref-col-collab"><strong>${escapeHtml(fullName)}</strong></td>
          <td class="ref-col-poste">${escapeHtml(poste)}</td>
          <td class="col-center ref-col-date-obt">${obt}</td>
          <td class="col-center ref-col-date-renouv">${renouv}</td>
        </tr>`;
      });
    }

    html += `</tbody></table></div></div>`;
    return html;
  }

  function buildCertifDetailView(data) {
    const c = data?.certification || {};
    const title = c.nom_certification || "Certification";
    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;
    const postes = renderPostesTable(data?.postes_concernes || [], true, c.duree_validite);
    const collaborateurs = renderCertifHoldersTable(data?.collaborateurs_detenteurs || []);

    const body = `
      <div class="ref-modal-stack">
        <div class="card ref-modal-card" style="padding:12px; margin:0;">
          ${sectionTitleHtml("description", "Description")}
          ${desc}
        </div>
        ${postes}
        ${collaborateurs}
      </div>
    `;

    return { title, sub: "", body };
  }

  async function fetchReferentielCompetencePdfBlob(portal, id_contact, id_service, id_comp) {
    const url =
      `${portal.apiBase}/skills/referentiel/competences/fiche_pdf/` +
      `${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_comp)}`;

    const headers = new Headers();
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      let msg = `Erreur PDF (${resp.status})`;
      try {
        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const js = await resp.json();
          msg = js?.detail || js?.message || JSON.stringify(js);
        } else {
          msg = await resp.text() || msg;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    return await resp.blob();
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

  function setSessionValue(key, value) {
    try {
      window.sessionStorage.setItem(key, String(value || ""));
    } catch (_) {}
  }

  function setSessionJson(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value || {}));
    } catch (_) {}
  }

  function buildPostePayloadForOrganisation(row, idPoste) {
    const src = row || {};
    const id = String(src?.id_poste || idPoste || "").trim();
    return {
      id_poste: id,
      codif_poste: String(src?.codif_poste || "").trim(),
      codif_client: String(src?.codif_client || src?.code_poste || "").trim(),
      intitule_poste: String(src?.intitule_poste || src?.intitule || "").trim(),
      id_service: String(src?.id_service || "").trim(),
      nom_service: String(src?.nom_service || "").trim(),
      isresponsable: !!src?.isresponsable
    };
  }

  function portalSwitchView(viewName) {
    const name = String(viewName || "").trim();
    if (!name) return Promise.resolve(false);

    if (window.portal && typeof window.portal.switchView === "function") {
      return Promise.resolve(window.portal.switchView(name)).then(() => true);
    }

    try {
      window.location.hash = name;
      return Promise.resolve(true);
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  function findDetailPoste(idPoste) {
    const id = String(idPoste || "").trim();
    return _lastDetailPostes.find(x => String(x?.id_poste || "") === id) || null;
  }

  function findDetailCollaborateur(idEffectif) {
    const id = String(idEffectif || "").trim();
    return _lastDetailCollaborateurs.find(x => String(x?.id_effectif || "") === id) || null;
  }

  async function openPosteFromReferentiel(idPoste) {
    const row = findDetailPoste(idPoste) || { id_poste: idPoste };
    const payload = buildPostePayloadForOrganisation(row, idPoste);
    if (!payload.id_poste) throw new Error("Poste manquant.");

    setSessionValue("skills_org_open_poste_id", payload.id_poste);
    setSessionValue("skills_org_open_poste_action", "detail");
    setSessionJson("skills_org_open_poste_payload", payload);
    closeModal();
    await portalSwitchView("votre-organisation");
  }

  async function openPostePdfFromReferentiel(idPoste) {
    const row = findDetailPoste(idPoste) || { id_poste: idPoste };
    const payload = buildPostePayloadForOrganisation(row, idPoste);
    if (!payload.id_poste) throw new Error("Poste manquant.");

    setSessionValue("skills_org_open_poste_id", payload.id_poste);
    setSessionValue("skills_org_open_poste_action", "pdf");
    setSessionJson("skills_org_open_poste_payload", payload);
    closeModal();
    await portalSwitchView("votre-organisation");
  }

  async function openCollaborateurFromReferentiel(idEffectif) {
    const row = findDetailCollaborateur(idEffectif) || { id_effectif: idEffectif };
    const id = String(row?.id_effectif || idEffectif || "").trim();
    if (!id) throw new Error("Collaborateur introuvable.");

    setSessionValue("skills_collab_open_id_effectif", id);
    closeModal();
    await portalSwitchView("vos-collaborateurs");
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
        if (e.target === modal) {
          closeModal();
          return;
        }

        const criteriaBtn = e.target.closest("[data-ref-criteria-toggle]");
        if (criteriaBtn) {
          const acc = criteriaBtn.closest(".ref-criteria-accordion");
          const body = acc?.querySelector(".ref-criteria-body");
          const isOpen = criteriaBtn.getAttribute("aria-expanded") === "true";
          criteriaBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
          criteriaBtn.classList.toggle("is-open", !isOpen);
          if (acc) acc.classList.toggle("is-open", !isOpen);
          if (body) body.style.display = isOpen ? "none" : "";
          return;
        }

        const posteBtn = e.target.closest("[data-ref-poste-action]");
        if (posteBtn) {
          const idPoste = posteBtn.getAttribute("data-id-poste") || "";
          const action = posteBtn.getAttribute("data-ref-poste-action") || "detail";
          if (!idPoste) return;
          (async () => {
            if (action === "pdf") await openPostePdfFromReferentiel(idPoste);
            else await openPosteFromReferentiel(idPoste);
          })().catch(err => portal.showAlert("error", (action === "pdf" ? "Erreur PDF poste : " : "Erreur fiche poste : ") + err.message));
          return;
        }

        const collabBtn = e.target.closest("[data-ref-collab-action]");
        if (collabBtn) {
          const idEffectif = collabBtn.getAttribute("data-id-effectif") || "";
          if (!idEffectif) return;
          openCollaborateurFromReferentiel(idEffectif)
            .catch(err => portal.showAlert("error", "Erreur fiche collaborateur : " + err.message));
        }
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
