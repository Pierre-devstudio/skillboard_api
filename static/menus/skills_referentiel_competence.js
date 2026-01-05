(function () {
  const NON_LIE_ID = "__NON_LIE__";

  let _bound = false;
  let _servicesLoaded = false;
  let _activeTab = "competences"; // competences | certifs
  let _searchTimer = null;

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

    if (bComp) bComp.classList.toggle("btn-primary", tab === "competences");
    if (bComp) bComp.classList.toggle("btn-secondary", tab !== "competences");
    if (bCert) bCert.classList.toggle("btn-primary", tab === "certifs");
    if (bCert) bCert.classList.toggle("btn-secondary", tab !== "certifs");

    const wrapComp = byId("wrapRefCompetences");
    const wrapCert = byId("wrapRefCertifs");

    if (wrapComp) wrapComp.style.display = (tab === "competences") ? "" : "none";
    if (wrapCert) wrapCert.style.display = (tab === "certifs") ? "" : "none";
  }

  function flattenServices(nodes) {
    const out = [];
    function rec(list, depth) {
      (list || []).forEach(n => {
        if (!n || !n.id_service) return;
        out.push({
          id_service: n.id_service,
          nom_service: n.nom_service || n.id_service,
          depth: depth || 0
        });
        if (n.children && n.children.length) rec(n.children, (depth || 0) + 1);
      });
    }
    rec(nodes || [], 0);
    return out;
  }

  function fillServiceSelect(flat) {
    const sel = byId("refServiceSelect");
    if (!sel) return;

    const current = sel.value || localStorage.getItem("sb_ref_service") || "";

    sel.innerHTML = `<option value="" disabled>Sélectionnez un service…</option>`;

    (flat || []).forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.id_service;
      const prefix = s.depth ? "— ".repeat(Math.min(6, s.depth)) : "";
      opt.textContent = prefix + (s.nom_service || s.id_service);
      sel.appendChild(opt);
    });

    // restore if possible
    if (current && Array.from(sel.options).some(o => o.value === current)) {
      sel.value = current;
    } else if (flat && flat.length) {
      sel.value = flat[0].id_service;
    } else {
      sel.value = "";
    }
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
    const niv = item.niveaux_complets ? `<span class="sb-badge sb-badge-accent">A/B/C ok</span>` : `<span class="sb-badge">Niveaux incomplets</span>`;
    const grid = item.grille_presente ? `<span class="sb-badge sb-badge-accent">Grille ok</span>` : `<span class="sb-badge">Sans grille</span>`;
    return `<div style="display:flex; gap:6px; flex-wrap:wrap;">${niv}${grid}</div>`;
  }

  function domaineCell(item) {
    const label = (item.domaine_titre_court || item.domaine_titre || item.id_domaine_competence || "Domaine").toString();
    const c = normalizeColor(item.domaine_couleur);
    const color = c ? c : "#e5e7eb";
    const safeLabel = escapeHtml(label);
    return `<span class="domain-dot" title="${safeLabel}" style="background:${escapeHtml(color)};"></span>`;
  }

  function niveauRequisCell(item) {
    const a = (item.niveau_requis_min || "").trim();
    const b = (item.niveau_requis_max || "").trim();
    if (!a && !b) return "—";
    if (a && b && a !== b) return `${escapeHtml(a)} → ${escapeHtml(b)}`;
    return escapeHtml(a || b);
  }

  function renderCompetences(list) {
    const body = byId("tblRefCompetencesBody");
    if (!body) return;

    body.innerHTML = "";
    (list || []).forEach(it => {
      const tr = document.createElement("tr");
      tr.setAttribute("data-id_comp", it.id_comp);

      tr.innerHTML = `
        <td class="col-dom">${domaineCell(it)}</td>
        <td class="col-code">${escapeHtml(it.code)}</td>
        <td class="col-title">${escapeHtml(it.intitule)}</td>
        <td class="col-center col-level">${niveauRequisCell(it)}</td>
        <td class="col-center col-postes">${it.nb_postes_concernes ?? 0}</td>
        <td class="col-center col-detail"><button type="button" class="btn-secondary btn-xs" data-action="detail">Détail</button></td>
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

      const validite = (it.duree_validite === null || it.duree_validite === undefined)
        ? "—"
        : `${it.duree_validite} mois`;

      tr.innerHTML = `
        <td class="col-title" style="font-weight:600;">${escapeHtml(it.nom_certification)}</td>
        <td>${escapeHtml(it.categorie || "—")}</td>
        <td style="white-space:nowrap;">${escapeHtml(validite)}</td>
        <td class="col-center" style="white-space:nowrap;">${escapeHtml(it.niveau_exigence_max || "—")}</td>
        <td class="col-center col-postes">${it.nb_postes_concernes ?? 0}</td>
        <td class="col-center col-detail"><button type="button" class="btn-secondary btn-xs" data-action="detail">Détail</button></td>
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

    if (t) t.textContent = title || "Détail";
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

  async function ensureContext(portal) {
    if (portal.context) return portal.context;
    const ctx = await portal.apiJson(`${portal.apiBase}/skills/context/${encodeURIComponent(portal.contactId)}`);
    portal.context = ctx;

    const civ = (ctx.civilite || "").trim();
    const prenom = (ctx.prenom || "").trim();
    const nom = (ctx.nom || "").trim();
    const display = [civ, prenom, nom].filter(Boolean).join(" ").trim();

    portal.setTopbar(display || "Contact", "Portail Skills — JMB CONSULTANT");
    return ctx;
  }

  async function loadServices(portal) {
    portal.showAlert("", "");
    const nodes = await portal.apiJson(`${portal.apiBase}/skills/organisation/services/${encodeURIComponent(portal.contactId)}`);
    const flat = flattenServices(Array.isArray(nodes) ? nodes : []);
    fillServiceSelect(flat);
    _servicesLoaded = true;
  }

  function getFilters() {
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    const id_domaine = (byId("refDomaineSelect")?.value || "").trim();
    const q = (byId("refSearch")?.value || "").trim();
    const etat = (byId("refEtatSelect")?.value || "").trim();

    return { id_service, id_domaine, q, etat };
  }

  function setScopeLabel(serviceName) {
    const el = byId("refScopeLabel");
    if (!el) return;
    el.innerHTML = `Service : <b>${escapeHtml(serviceName || "—")}</b>`;
  }

  function setCountsForTab(count, tab) {
    const el = byId("refCount");
    if (!el) return;

    if (tab === "certifs") el.textContent = `${count ?? 0} certification(s) requise(s)`;
    else el.textContent = `${count ?? 0} compétence(s) requise(s)`;
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
    if (!f.id_service) return;

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
        setScopeLabel(data?.service?.nom_service || "");
        fillDomaineSelect(data?.domaines || []);

        setText("kpiRefPostes", data?.kpis?.nb_postes ?? "–");
        setText("kpiRefCompetences", data?.kpis?.nb_items ?? "–");
        setText("kpiRefNiveaux", (data?.kpis?.pct_niveaux_complets ?? null) === null ? "–" : `${data.kpis.pct_niveaux_complets}%`);
        setText("kpiRefGrille", (data?.kpis?.pct_grille_eval ?? null) === null ? "–" : `${data.kpis.pct_grille_eval}%`);

        if (_activeTab === "competences") {
          const list = Array.isArray(data?.competences) ? data.competences : [];
          renderCompetences(list);
          setCountsForTab(list.length, "competences");
          showEmptyIfNeeded(list.length);
        }
      }

      // Certifications
      if (cert.status === "fulfilled" && cert.value) {
        const data = cert.value;
        setText("kpiRefCertifs", data?.kpis?.nb_items ?? "–");

        if (_activeTab === "certifs") {
          const list = Array.isArray(data?.certifications) ? data.certifications : [];
          renderCertifs(list);
          setCountsForTab(list.length, "certifs");
          showEmptyIfNeeded(list.length);
        }
      }

      // Si onglet actif mais chargement a échoué
      if (_activeTab === "competences" && (comp.status !== "fulfilled")) {
        renderCompetences([]);
        setCountsForTab(0, "competences");
        showEmptyIfNeeded(0);
      }
      if (_activeTab === "certifs" && (cert.status !== "fulfilled")) {
        renderCertifs([]);
        setCountsForTab(0, "certifs");
        showEmptyIfNeeded(0);
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
            <span class="sb-badge">${escapeHtml(k)}</span>
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

  function renderPostesTable(postes, isCertif) {
    const list = Array.isArray(postes) ? postes : [];
    const title = isCertif ? "Postes concernés" : "Postes concernés (niveau requis)";
    const cols = isCertif
      ? ["Poste", "Service", "Exigence", "Validité override"]
      : ["Poste", "Service", "Niveau", "Criticité"];

    const ths = cols.map((c, idx) => {
      const center = (!isCertif && (idx === 2 || idx === 3)) || (isCertif && (idx === 2 || idx === 3));
      return `<th${center ? ` class="col-center"` : ""}>${escapeHtml(c)}</th>`;
    }).join("");

    let html = `<div class="card" style="padding:12px; margin:0;">
      <div class="card-title" style="margin-bottom:6px;">${escapeHtml(title)}</div>
      <div class="card-sub" style="margin:0;">${list.length} poste(s) impacté(s).</div>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="sb-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>`;

    if (!list.length) {
      html += `<tr><td colspan="${cols.length}">—</td></tr>`;
    } else {
      list.forEach(p => {
        const poste = escapeHtml((p.codif_poste ? `${p.codif_poste} — ` : "") + (p.intitule_poste || ""));
        const service = escapeHtml(p.nom_service || "—");
        if (isCertif) {
          const ex = escapeHtml(p.niveau_exigence || "—");
          const ov = (p.validite_override === null || p.validite_override === undefined) ? "—" : `${p.validite_override} mois`;
          html += `<tr>
            <td>${poste}</td>
            <td>${service}</td>
            <td class="col-center" style="white-space:nowrap;">${ex}</td>
            <td class="col-center" style="white-space:nowrap;">${escapeHtml(ov)}</td>
          </tr>`;
        } else {
          const niv = escapeHtml(p.niveau_requis || "—");
          const crit = (p.poids_criticite === null || p.poids_criticite === undefined) ? "—" : `${p.poids_criticite}`;
          html += `<tr>
            <td>${poste}</td>
            <td>${service}</td>
            <td class="col-center" style="white-space:nowrap;">${niv}</td>
            <td class="col-center" style="white-space:nowrap;">${escapeHtml(crit)}</td>
          </tr>`;
        }
      });
    }

    html += `</tbody></table></div></div>`;
    return html;
  }

  async function openCompetenceDetail(portal, id_comp) {
    const id_contact = portal.contactId;
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    if (!id_service) return;

    const url = `${portal.apiBase}/skills/referentiel/competence/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_comp)}`;
    const data = await portal.apiJson(url);

    const c = data?.competence || {};
    const dom = c?.domaine || null;

    const title = `${c.code || ""} — ${c.intitule || "Compétence"}`.trim();
    let sub = "";
    if (dom) {
      const label = (dom.titre_court || dom.titre || dom.id_domaine_competence || "Domaine").toString();
      const col = normalizeColor(dom.couleur) || "#e5e7eb";
      sub = `<span class="domain-pill" title="${escapeHtml(label)}"><span class="domain-dot" style="background:${escapeHtml(col)};"></span><span>${escapeHtml(label)}</span></span>`;
    }

    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;

    const levels = `
      <div class="card" style="padding:12px; margin:0;">
        <div class="card-title" style="margin-bottom:6px;">Niveaux</div>
        <div class="row" style="flex-direction:column; gap:10px; margin-top:10px;">
          <div><span class="sb-badge sb-badge-accent">A</span> ${escapeHtml(c.niveaua || "—")}</div>
          <div><span class="sb-badge sb-badge-accent">B</span> ${escapeHtml(c.niveaub || "—")}</div>
          <div><span class="sb-badge sb-badge-accent">C</span> ${escapeHtml(c.niveauc || "—")}</div>
        </div>
      </div>
    `;

    const grid = renderGridEvaluation(c.grille_evaluation);
    const postes = renderPostesTable(data?.postes_concernes || [], false);

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

    openModal(title, sub, body);
  }

  async function openCertifDetail(portal, id_certification) {
    const id_contact = portal.contactId;
    const id_service = (byId("refServiceSelect")?.value || "").trim();
    if (!id_service) return;

    const url = `${portal.apiBase}/skills/referentiel/certification/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_service)}/${encodeURIComponent(id_certification)}`;
    const data = await portal.apiJson(url);

    const c = data?.certification || {};
    const title = c.nom_certification || "Certification";

    const badges = [];
    if (c.categorie) badges.push(`<span class="sb-badge">${escapeHtml(c.categorie)}</span>`);
    if (c.duree_validite !== null && c.duree_validite !== undefined) badges.push(`<span class="sb-badge sb-badge-accent">${escapeHtml(c.duree_validite)} mois</span>`);
    const sub = badges.join(" ");

    const desc = c.description ? `<div class="card-sub" style="margin-top:0;">${escapeHtml(c.description)}</div>` : `<div class="card-sub" style="margin-top:0;">—</div>`;

    const postes = renderPostesTable(data?.postes_concernes || [], true);

    const body = `
      <div class="row" style="flex-direction:column; gap:12px;">
        <div class="card" style="padding:12px; margin:0;">
          <div class="card-title" style="margin-bottom:6px;">Description</div>
          ${desc}
        </div>
        ${postes}
      </div>
    `;

    openModal(title, sub, body);
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

    const tabComp = byId("tabRefCompetences");
    const tabCert = byId("tabRefCertifs");

    const tbodyComp = byId("tblRefCompetencesBody");
    const tbodyCert = byId("tblRefCertifsBody");

    const btnX = byId("btnCloseRefModal");
    const btnClose = byId("btnRefModalClose");
    const modal = byId("modalRefDetail");

    if (selService) {
      selService.addEventListener("change", () => {
        _cacheComp.clear();
        _cacheCert.clear();
        // reset domaine au changement de service (sinon filtre vide et utilisateur croit que "ça bug")
        if (selDom) selDom.value = "";
        refreshAll(portal);
      });
    }

    const refreshDebounced = () => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => refreshAll(portal), 250);
    };

    if (selDom) selDom.addEventListener("change", refreshDebounced);
    if (selEtat) selEtat.addEventListener("change", refreshDebounced);

    if (txtSearch) {
      txtSearch.addEventListener("input", refreshDebounced);
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (selDom) selDom.value = "";
        if (txtSearch) txtSearch.value = "";
        if (selEtat) selEtat.value = "active";
        refreshAll(portal);
      });
    }

    if (tabComp) {
      tabComp.addEventListener("click", async () => {
        setActiveTab("competences");
        await refreshAll(portal);
      });
    }

    if (tabCert) {
      tabCert.addEventListener("click", async () => {
        setActiveTab("certifs");
        await refreshAll(portal);
      });
    }

    if (tbodyComp) {
      tbodyComp.addEventListener("click", async (ev) => {
        const tr = ev.target.closest("tr");
        const id_comp = tr?.getAttribute("data-id_comp");
        if (!id_comp) return;
        try {
          await openCompetenceDetail(portal, id_comp);
        } catch (e) {
          portal.showAlert("error", "Erreur détail compétence : " + e.message);
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
        await ensureContext(portal);

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
