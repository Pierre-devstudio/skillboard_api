/* ======================================================
   static/menus/skills_cartographie_competences.js
   - Menu "Cartographie des compétences"
   - Heatmap Poste × Domaine (WAOOOUUU)
   - Filtres: Service + Recherche + Domaines multiples
   - Modal détail (V1: résumé cellule)
   ====================================================== */

(function () {
  let _bound = false;
  let _servicesLoaded = false;
  const _cache = new Map(); // key: service
  let _searchTimer = null;
  let _lastDomaines = [];
  let _advancedMode = "competence";
  let _advancedTimer = null;

  const STORE_SERVICE = "sb_map_service";
  const STORE_DOMAINES = "sb_map_domaines";
  const STORE_FILTERS_OPEN = "sb_map_filters_open";
  const STORE_DOMAINES_OPEN = "sb_map_domaines_open";

  function byId(id) { return document.getElementById(id); }

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
    if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl")) return s;

    // int ARGB signé WinForms (ex: -256)
    if (/^-?\d+$/.test(s)) {
      const n = parseInt(s, 10);
      const u = (n >>> 0);
      const r = (u >> 16) & 255;
      const g = (u >> 8) & 255;
      const b = u & 255;
      return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
    }
    return s;
  }

  function safeTrim(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number") return String(v).trim();
    return "";
  }

  function levelKey4(v) {
    const raw = safeTrim(v);
    const norm = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!norm || norm === "-" || norm === "—") return "";
    if (norm === "a" || norm.includes("initial") || norm.includes("debutant")) return "A";
    if (norm === "b" || norm.includes("intermediaire") || norm.includes("interm")) return "B";
    if (norm === "c" || norm.includes("avance")) return "C";
    if (norm === "d" || norm.includes("expert")) return "D";
    return "";
  }

  function levelLabel4(v) {
    const k = levelKey4(v);
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" })[k] || (safeTrim(v) || "—");
  }

  function levelBadgeHtml4(v, title = "Niveau") {
    const k = levelKey4(v);
    const label = levelLabel4(v);
    const cls = k ? `sb-badge-niv sb-badge-niv-${k.toLowerCase()}` : "sb-badge-niv";
    return `<span class="sb-badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  /**
   * Code poste affiché :
   * - on préfère le code interne (si présent)
   * - sinon fallback sur le code PT (codif_poste)
   */
  function getPosteCodeDisplay(p) {
    if (!p) return "";
    return safeTrim(p.codif_client) || safeTrim(p.codif_poste);
  }


  function setText(id, v, fallback = "–") {
    const el = byId(id);
    if (!el) return;
    el.textContent = (v === null || v === undefined || v === "") ? fallback : String(v);
  }

  function setVisible(id, visible) {
    const el = byId(id);
    if (el) el.style.display = visible ? "" : "none";
  }

  function setStatus(text) {
    const st = byId("hmStatus") || byId("mapStatus"); // tolérant
    if (st) st.textContent = text || "";
  }

  function setCounts(text) {
    const ct = byId("hmCounts") || byId("mapCount"); // tolérant
    if (ct) ct.textContent = text || "—";
  }

  function parseStoredDomaines() {
    try {
      const raw = localStorage.getItem(STORE_DOMAINES) || "[]";
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(x => String(x || "").trim()).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  function getSelectedDomaines() {
    return Array.from(document.querySelectorAll("#mapDomainesList input[data-id_domaine]:checked"))
      .map(input => (input.getAttribute("data-id_domaine") || "").trim())
      .filter(Boolean);
  }

  function setSelectedDomaines(ids) {
    const set = new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean));
    document.querySelectorAll("#mapDomainesList input[data-id_domaine]").forEach(input => {
      const id = (input.getAttribute("data-id_domaine") || "").trim();
      input.checked = set.has(id);
    });
  }

  function renderDomainesChecklist(domaines) {
    const host = byId("mapDomainesList");
    if (!host) return;

    const items = Array.isArray(domaines) ? domaines : [];
    const previous = getSelectedDomaines();
    const stored = parseStoredDomaines();
    const current = previous.length ? previous : stored;
    const selected = new Set(current);

    host.innerHTML = items.map(d => {
      const id = d?.id_domaine_competence;
      if (!id) return "";
      const label = (d.titre_court || d.titre || id || "Domaine").toString().trim();
      const color = normalizeColor(d.couleur ?? d.domaine_couleur) || "#9ca3af";
      const checked = selected.has(id) ? " checked" : "";
      return `
        <label class="map-domain-check" title="${escapeHtml(label)}">
          <input type="checkbox" data-id_domaine="${escapeHtml(id)}"${checked} />
          <span class="map-domain-dot" style="--dom-color:${escapeHtml(color)}" aria-hidden="true"></span>
          <span class="map-domain-label">${escapeHtml(label)}</span>
        </label>
      `;
    }).join("") || `<div class="card-sub" style="margin:0;">Aucun domaine disponible.</div>`;
  }

  function filterPostesBySearch(postes, q) {
    const needle = (q || "").toString().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!needle) return Array.isArray(postes) ? postes : [];

    return (Array.isArray(postes) ? postes : []).filter(p => {
      const hay = [
        p?.codif_poste,
        p?.codif_client,
        getPosteCodeDisplay(p),
        p?.intitule_poste,
      ].map(v => (v || "").toString())
        .join(" ")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      return hay.includes(needle);
    });
  }

  function getFilters() {
    const rawS = (byId("mapServiceSelect")?.value || "").trim();
    const id_service = window.portal.serviceFilter.toQueryId(rawS); // "__ALL__" => null
    const q = (byId("mapSearch")?.value || "").trim();
    const domaines = getSelectedDomaines();
    return { id_service, q, domaines };
  }


  function openModal(title, sub, bodyHtml) {
    const modal = byId("modalMapDetail");
    if (!modal) return;

    const t = byId("mapModalTitle");
    const s = byId("mapModalSub");
    const b = byId("mapModalBody");

    if (t) {
      if (title && typeof title === "object") {
        const code = safeTrim(title.code);
        const text = safeTrim(title.text) || "Détail";
        t.innerHTML = `
          <div class="map-modal-titleline">
            ${code ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(code)}</span>` : ``}
            <span class="map-modal-titletext">${escapeHtml(text)}</span>
          </div>
        `;
      } else {
        t.textContent = title || "Détail";
      }
    }

    if (s) {
      s.innerHTML = sub || "";
      s.style.display = sub ? "" : "none";
    }
    if (b) b.innerHTML = bodyHtml || "";

    modal.classList.add("show", "is-map-detail-modal");
    modal.setAttribute("aria-hidden", "false");

    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function closeModal() {
    const modal = byId("modalMapDetail");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  
  async function loadServices(portal) {
    // Filtre service : géré UNE SEULE FOIS (portal_common.js)
    await portal.serviceFilter.populateSelect({
      portal,
      selectId: "mapServiceSelect",
      storageKey: STORE_SERVICE,
      labelAll: "Tous les services",
      labelNonLie: "Non lié",
      includeAll: true,
      includeNonLie: true,
      allowIndent: true
    });

    _servicesLoaded = true;
  }


  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === null || v === undefined || v === "") return;
      usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }

  async function fetchMatrice(portal, filters) {
    const key = `${filters.id_service || ""}`;
    if (_cache.has(key)) return _cache.get(key);

    const svc = filters?.id_service;
    const qs = buildQuery({
      id_service: (svc && svc !== window.portal.serviceFilter.ALL_ID) ? svc : null
    });

    const url = `${portal.apiBase}/skills/cartographie/matrice/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _cache.set(key, data);
    return data;
  }

  async function fetchCellDetail(portal, id_poste, id_domaine, filters, includePorteurs = false) {
    const params = new URLSearchParams();
    params.set("id_poste", id_poste);

    if (id_domaine) params.set("id_domaine", id_domaine);

    // cohérent avec le filtre Service en cours
    const svc = filters?.id_service;
    if (svc && svc !== window.portal.serviceFilter.ALL_ID) {
      params.set("id_service", svc);
    }

    // NEW: porteurs désactivés par défaut (drill-down éventuel plus tard)
    params.set("include_porteurs", includePorteurs ? "true" : "false");

    const url = `${portal.apiBase}/skills/cartographie/cell/${encodeURIComponent(portal.contactId)}?${params.toString()}`;
    return await portal.apiJson(url);
  }


  async function fetchAdvancedSearch(portal, mode, query, filters) {
    const params = new URLSearchParams();
    params.set("mode", mode === "collaborateur" ? "collaborateur" : "competence");
    params.set("q", query || "");
    params.set("limit", "80");

    const svc = filters?.id_service;
    if (svc && svc !== window.portal.serviceFilter.ALL_ID) {
      params.set("id_service", svc);
    }

    const url = `${portal.apiBase}/skills/cartographie/recherche_avancee/${encodeURIComponent(portal.contactId)}?${params.toString()}`;
    return await portal.apiJson(url);
  }

  function setAdvancedStatus(text) {
    const el = byId("mapAdvancedStatus");
    if (el) el.textContent = text || "";
  }

  function openAdvancedModal() {
    const modal = byId("modalMapAdvancedSearch");
    if (!modal) return;

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setAdvancedMode(_advancedMode || "competence");
    setAdvancedStatus("Saisissez au moins 2 caractères pour lancer la recherche.");
    renderAdvancedEmpty();

    const input = byId("mapAdvancedSearchInput");
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
  }

  function closeAdvancedModal() {
    const modal = byId("modalMapAdvancedSearch");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function setAdvancedMode(mode) {
    _advancedMode = mode === "collaborateur" ? "collaborateur" : "competence";

    document.querySelectorAll("[data-map-advanced-mode]").forEach(btn => {
      const active = btn.getAttribute("data-map-advanced-mode") === _advancedMode;
      btn.classList.toggle("is-active", active);
    });

    const input = byId("mapAdvancedSearchInput");
    if (input) {
      input.placeholder = _advancedMode === "collaborateur"
        ? "Nom ou prénom du collaborateur..."
        : "Code, intitulé de compétence...";
    }

    renderAdvancedEmpty();
    setAdvancedStatus("Saisissez au moins 2 caractères pour lancer la recherche.");
  }

  function renderAdvancedEmpty() {
    const head = byId("mapAdvancedTableHead");
    const body = byId("mapAdvancedTableBody");
    if (head) head.innerHTML = "";
    if (body) body.innerHTML = `<tr><td class="map-advanced-empty">Aucune recherche lancée.</td></tr>`;
  }

  function advancedLevelBadge(value) {
    return window.NovoskillLevels
      ? window.NovoskillLevels.badgeHtml(value || "—", "Niveau détenu")
      : levelBadgeHtml4(value || "—", "Niveau détenu");
  }

  function renderAdvancedResults(data, mode) {
    const head = byId("mapAdvancedTableHead");
    const body = byId("mapAdvancedTableBody");
    if (!head || !body) return;

    const items = Array.isArray(data?.items) ? data.items : [];
    const total = Number(data?.total || items.length || 0);

    if (mode === "collaborateur") {
      head.innerHTML = `
        <tr>
          <th>Collaborateur</th>
          <th>Compétence</th>
          <th class="col-center">Niveau détenu</th>
          <th>Poste actuel</th>
          <th class="col-center">Dernière éval.</th>
        </tr>
      `;

      if (!items.length) {
        body.innerHTML = `<tr><td class="map-advanced-empty" colspan="5">Aucun résultat pour cette recherche.</td></tr>`;
        setAdvancedStatus("Aucun résultat trouvé.");
        return;
      }

      body.innerHTML = items.map(it => {
        const person = `${safeTrim(it.prenom_effectif)} ${safeTrim(it.nom_effectif)}`.trim() || "—";
        const code = safeTrim(it.code);
        const comp = safeTrim(it.intitule) || "—";
        return `
          <tr>
            <td><strong>${escapeHtml(person)}</strong></td>
            <td>
              <div class="map-advanced-comp-line">
                ${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ``}
                <span>${escapeHtml(comp)}</span>
              </div>
            </td>
            <td class="col-center">${advancedLevelBadge(it.niveau_actuel)}</td>
            <td>${escapeHtml(safeTrim(it.intitule_poste) || "—")}</td>
            <td class="col-center">${escapeHtml(formatDateFr(it.date_derniere_eval))}</td>
          </tr>
        `;
      }).join("");
      setAdvancedStatus(`${total} résultat(s).`);
      return;
    }

    head.innerHTML = `
      <tr>
        <th>Compétence</th>
        <th>Collaborateur</th>
        <th>Poste actuel</th>
        <th class="col-center">Niveau détenu</th>
        <th class="col-center">Dernière éval.</th>
      </tr>
    `;

    if (!items.length) {
      body.innerHTML = `<tr><td class="map-advanced-empty" colspan="5">Aucun résultat pour cette recherche.</td></tr>`;
      setAdvancedStatus("Aucun résultat trouvé.");
      return;
    }

    body.innerHTML = items.map(it => {
      const code = safeTrim(it.code);
      const comp = safeTrim(it.intitule) || "—";
      const person = `${safeTrim(it.prenom_effectif)} ${safeTrim(it.nom_effectif)}`.trim();
      return `
        <tr>
          <td>
            <div class="map-advanced-comp-line">
              ${code ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ``}
              <span>${escapeHtml(comp)}</span>
            </div>
          </td>
          <td>${person ? escapeHtml(person) : `<span class="sb-muted">Aucun détenteur identifié</span>`}</td>
          <td>${escapeHtml(safeTrim(it.intitule_poste) || "—")}</td>
          <td class="col-center">${person ? advancedLevelBadge(it.niveau_actuel) : `<span class="sb-badge">—</span>`}</td>
          <td class="col-center">${escapeHtml(formatDateFr(it.date_derniere_eval))}</td>
        </tr>
      `;
    }).join("");
    setAdvancedStatus(`${total} résultat(s).`);
  }

  function formatDateFr(value) {
    const s = safeTrim(value);
    if (!s) return "—";
    const ymd = s.slice(0, 10);
    const parts = ymd.split("-");
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return s;
  }

  async function runAdvancedSearch(portal) {
    const input = byId("mapAdvancedSearchInput");
    const q = (input?.value || "").trim();
    if (q.length < 2) {
      renderAdvancedEmpty();
      setAdvancedStatus("Saisissez au moins 2 caractères pour lancer la recherche.");
      return;
    }

    try {
      setAdvancedStatus("Recherche en cours…");
      const data = await fetchAdvancedSearch(portal, _advancedMode, q, getFilters());
      renderAdvancedResults(data, _advancedMode);
    } catch (e) {
      setAdvancedStatus("Erreur pendant la recherche.");
      const body = byId("mapAdvancedTableBody");
      if (body) body.innerHTML = `<tr><td class="map-advanced-empty">${escapeHtml(e.message || "Erreur inconnue")}</td></tr>`;
    }
  }

  function mapIconSvg(name) {
    const icons = {
      domain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>`,
      postes: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>`,
      skills: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
      users: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      section: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M8.5 12.5 7 22l5-3 5 3-1.5-9.5"/></svg>`,
      doc: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>`,
      search: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`
    };
    return icons[name] || "";
  }

  function mapModalKpiCard(icon, tone, label, value) {
    return `
      <div class="map-detail-kpi-card map-detail-kpi-card--${escapeHtml(tone || "default")}">
        <div class="map-detail-kpi-card__icon" aria-hidden="true">${mapIconSvg(icon)}</div>
        <div>
          <div class="map-detail-kpi-card__label">${escapeHtml(label)}</div>
          <div class="map-detail-kpi-card__value">${escapeHtml(value)}</div>
        </div>
      </div>
    `;
  }

  function mapCritBadgeHtml(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return `<span class="sb-crit-badge sb-crit-l1">—</span>`;
    const v = Math.max(0, Math.min(100, Math.round(n)));
    const level = v >= 80 ? 5 : (v >= 60 ? 4 : (v >= 40 ? 3 : (v >= 20 ? 2 : 1)));
    return `<span class="sb-crit-badge sb-crit-l${level}" title="Criticité ${v}">${escapeHtml(String(v))}</span>`;
  }

  function mapCoverageState(comp, cible, pauseActive) {
    if (pauseActive) return "paused";
    const nbQual = Number(comp?.nb_porteurs_qualifies || 0);
    const target = Math.max(1, Number(cible || 1));
    if (nbQual >= target) return "ok";
    if (nbQual > 0) return "partial";
    return "none";
  }

  function mapCoverageIndicatorHtml(comp, cible, pauseActive) {
    const state = mapCoverageState(comp, cible, pauseActive);
    const nbQual = Number(comp?.nb_porteurs_qualifies || 0);
    const nbDispo = Number(comp?.nb_porteurs_disponibles ?? comp?.nb_porteurs ?? 0);
    const nbBrut = Number(comp?.nb_porteurs ?? 0);
    const target = Math.max(1, Number(cible || 1));
    const labels = {
      ok: "Couvert",
      partial: "Partiellement couvert",
      none: "Non couvert",
      paused: "Poste en pause"
    };
    const title = `${labels[state] || "Couverture"} — Qualifiés: ${nbQual} | Disponibles: ${nbDispo} | Bruts: ${nbBrut} | Cible: ${target}`;
    return `<span class="map-coverage-dot map-coverage-dot--${state}" title="${escapeHtml(title)}" aria-label="${escapeHtml(labels[state] || "Couverture")}"></span>`;
  }

  function mapSafeFilenamePart(v, maxLen = 90) {
    const raw = (v || "").toString().trim() || "document";
    return raw
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen)
      .trim() || "document";
  }

  async function mapApiPdfBlob(url) {
    const headers = new Headers();
    headers.set("Accept", "application/pdf");
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      let msg = `Erreur PDF (${res.status})`;
      try {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const js = await res.json();
          msg = js?.detail || js?.message || JSON.stringify(js);
        } else {
          msg = await res.text() || msg;
        }
      } catch (_) {}
      throw new Error(msg);
    }
    return await res.blob();
  }

  function mapRenderPdfBlobInWindow(popupWin, blob, title) {
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
  <style>html,body{height:100%;margin:0;background:#f3f4f6;}iframe{width:100%;height:100%;border:0;background:#fff;}</style>
</head>
<body><iframe src="${blobUrl}" title="${safeTitle}"></iframe></body>
</html>`);
    win.document.close();

    const revoke = () => { try { URL.revokeObjectURL(blobUrl); } catch (_) {} };
    try { win.addEventListener("beforeunload", revoke, { once: true }); } catch (_) {}
    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function openMapCompetenceFichePdf(portal, comp, popupWin) {
    const idComp = safeTrim(comp?.id_comp);
    if (!portal?.contactId || !portal?.apiBase || !idComp) throw new Error("Compétence introuvable.");

    const code = safeTrim(comp?.code);
    const intitule = safeTrim(comp?.intitule) || "Compétence";
    const title = `${code ? `${code} - ` : ""}${intitule}`;
    const url = `${portal.apiBase}/skills/analyse/competences/fiche_pdf/${encodeURIComponent(portal.contactId)}/${encodeURIComponent(idComp)}?_=${Date.now()}`;
    const blob = await mapApiPdfBlob(url);
    mapRenderPdfBlobInWindow(popupWin, blob, `Fiche compétence - ${mapSafeFilenamePart(title)}`);
  }

  function buildMatrix(data) {
    const rawDomaines = Array.isArray(data?.domaines) ? data.domaines : (Array.isArray(data?.domains) ? data.domains : []);
    const postes = Array.isArray(data?.postes) ? data.postes : (Array.isArray(data?.rows) ? data.rows : []);

    const domaines = (rawDomaines || []).map(d => {
      if (!d) return d;
      const id = d.id_domaine_competence || d.id_domaine || d.domaine || d.id || null;
      return { ...d, id_domaine_competence: id };
    }).filter(d => d && d.id_domaine_competence);

    const matrixMap = new Map();

    function setCell(id_poste, id_dom, count) {
      if (!id_poste || !id_dom) return;
      if (!matrixMap.has(id_poste)) matrixMap.set(id_poste, new Map());
      matrixMap.get(id_poste).set(id_dom, Number(count || 0));
    }

    const cells = Array.isArray(data?.cells)
      ? data.cells
      : (Array.isArray(data?.matrix) ? data.matrix : []);

    if (cells.length) {
      cells.forEach(c => {
        const id_poste = c?.id_poste || c?.idPoste || c?.poste_id || null;
        const id_dom = c?.id_domaine_competence || c?.id_domaine || c?.domaine || c?.idDomaineCompetence || null;
        const count = c?.nb_competences ?? c?.nb_comp ?? c?.nb ?? c?.count ?? c?.total ?? 0;
        setCell(id_poste, id_dom, count);
      });
    }

    const rawMatrix = data?.matrix;
    if (!cells.length && rawMatrix && typeof rawMatrix === "object" && !Array.isArray(rawMatrix)) {
      Object.keys(rawMatrix).forEach(pid => {
        const row = rawMatrix[pid];
        if (!row || typeof row !== "object") return;
        Object.keys(row).forEach(did => setCell(pid, did, row[did]));
      });
    }

    return { domaines, postes, matrixMap };
  }

    // ==============================
  // V2: Matrice Poste × Domaine
  // - 1 ligne par poste
  // - 1 barre par domaine visible
  // - clic sur une barre => on réutilise le modal cellule
  // ==============================

  function renderHistogramBars(containerEl, domaines, postes, matrixMap) {
    const el = containerEl;
    if (!el) return;

    const rows = Array.isArray(postes) ? postes : [];
    const map = (matrixMap instanceof Map) ? matrixMap : new Map();

    // Domaines triés alphabétique (clé = titre_court/titre/id)
    const doms = (Array.isArray(domaines) ? domaines : []).slice().sort((a, b) => {
      const ka = ((a?.titre_court || a?.titre || a?.id_domaine_competence || "") + "").trim().toLowerCase();
      const kb = ((b?.titre_court || b?.titre || b?.id_domaine_competence || "") + "").trim().toLowerCase();
      return ka.localeCompare(kb, "fr", { sensitivity: "base" });
    });

    // Totaux + max (pour échelle barres)
    const rowTotal = new Map();
    const colTotal = new Map();
    let maxVal = 0;

    rows.forEach(p => {
      const r = map.get(p.id_poste);
      let sum = 0;
      doms.forEach(d => {
        const v = (r && r.get(d.id_domaine_competence)) ? Number(r.get(d.id_domaine_competence)) : 0;
        sum += v;
        colTotal.set(d.id_domaine_competence, (colTotal.get(d.id_domaine_competence) || 0) + v);
        if (v > maxVal) maxVal = v;
      });
      rowTotal.set(p.id_poste, sum);
    });

    const grandTotal = Array.from(rowTotal.values()).reduce((a, b) => a + b, 0);

    function barHeight(v) {
      v = Number(v || 0);
      if (v <= 0 || maxVal <= 0) return 0;
      const h = Math.round((v / maxVal) * 30); // max 30px
      return Math.max(2, h); // barre visible si v>0
    }

    // Header (dots only)
    let ths = `<th class="hb-sticky hb-rowhead">Poste</th>`;
    doms.forEach(d => {
      const fullLabel = (d.titre || d.titre_court || d.id_domaine_competence || "").toString().trim();
      const col = normalizeColor(d.couleur ?? d.domaine_couleur) || "#e5e7eb";
      ths += `
        <th title="${escapeHtml(fullLabel)}">
          <span class="hb-dom-dot" style="background:${escapeHtml(col)}; border-color:${escapeHtml(col)};"></span>
        </th>
      `;
    });
    ths += `<th>Total</th>`;

    // Body rows
    let trs = "";
    rows.forEach(p => {
      const r = map.get(p.id_poste);
      const cod = getPosteCodeDisplay(p);
      const intit = (p.intitule_poste || "").toString().trim();
      let tds = "";
      doms.forEach(d => {
        const v = (r && r.get(d.id_domaine_competence)) ? Number(r.get(d.id_domaine_competence)) : 0;
        const col = normalizeColor(d.couleur ?? d.domaine_couleur) || "#e5e7eb";
        const h = barHeight(v);

        const title = `${cod ? cod + " — " : ""}${intit || "Poste"} | ${d.titre_court || d.titre || d.id_domaine_competence} : ${v}`;

        tds += `
          <td class="hb-cell"
              data-id_poste="${escapeHtml(p.id_poste)}"
              data-id_domaine="${escapeHtml(d.id_domaine_competence)}"
              data-value="${v}"
              title="${escapeHtml(title)}">
            <div class="hb-barbox">
              ${h > 0 ? `<div class="hb-bar" style="height:${h}px; background:${escapeHtml(col)};"></div>` : ``}
            </div>
          </td>
        `;
      });

      const tot = rowTotal.get(p.id_poste) || 0;

      trs += `
        <tr>
          <td class="hb-rowhead">
            <div class="hb-poste-line">
              ${cod ? `<span class="sb-badge sb-badge-ref-poste-code hb-poste-code">${escapeHtml(cod)}</span>` : ``}
              <span class="hb-poste-title">${escapeHtml(intit || "—")}</span>
            </div>
          </td>
          ${tds}
          <td class="hb-totalcell hb-totalclick"
              data-id_poste="${escapeHtml(p.id_poste)}"
              data-id_domaine=""
              data-value="${tot}"
              title="Voir toutes les compétences du poste (${tot})">
            ${tot ? tot : ""}
          </td>
        </tr>
      `;
    });

    // Total row (chiffres)
    let totalRow = `<td class="hb-rowhead">Total</td>`;
    doms.forEach(d => {
      const v = colTotal.get(d.id_domaine_competence) || 0;
      totalRow += `<td class="hb-totalcell">${v ? v : ""}</td>`;
    });
    totalRow += `<td class="hb-grandtotal">${grandTotal ? grandTotal : ""}</td>`;

    el.innerHTML = `
      <div class="hb-wrap">
        <table class="hb-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>
            ${trs || `<tr><td class="hb-rowhead">—</td><td class="hb-totalcell">—</td></tr>`}
            <tr class="hb-totalrow">${totalRow}</tr>
          </tbody>
        </table>
      </div>
    `;
  }

  function applyScopeLabels() {
    const sel = byId("mapServiceSelect");
    const label = sel?.selectedOptions?.[0]?.textContent || "Tous les services";
    const scopeLabel = byId("mapScopeLabel");
    if (scopeLabel) scopeLabel.textContent = `Service : ${label}`;
    setText("kpiMapScope", label);
  }

  async function refreshAll(portal) {
    const f = getFilters();

    localStorage.setItem(STORE_SERVICE, f.id_service || "");

    try {
      portal.showAlert("", "");
      setStatus("Chargement…");
      setCounts("—");

      const data = await fetchMatrice(portal, f);
      const rawDomaines = Array.isArray(data?.domaines) ? data.domaines : (Array.isArray(data?.domains) ? data.domains : []);

      const model = buildMatrix(data);
      _lastDomaines = model.domaines || [];
      renderDomainesChecklist(_lastDomaines);
      if (f.domaines && f.domaines.length) setSelectedDomaines(f.domaines);

      const activeDomaines = getSelectedDomaines();
      localStorage.setItem(STORE_DOMAINES, JSON.stringify(activeDomaines));

      const selectedIds = new Set(activeDomaines || []);
      const domainesShown = selectedIds.size
        ? (model.domaines || []).filter(d => selectedIds.has(d.id_domaine_competence))
        : (model.domaines || []);

      const postesShown = filterPostesBySearch(model.postes || [], f.q);

      const grid = byId("heatmapGrid");
      if (!grid || !postesShown.length || !domainesShown.length) {
        if (grid) grid.innerHTML = "";
        setVisible("mapEmpty", true);
        setCounts("—");
        setText("kpiMapPostes", postesShown.length);
        setText("kpiMapDomaines", domainesShown.length);
        setText("kpiMapCompetences", 0);
        applyScopeLabels();
        setStatus("Visualisez les domaines mobilisés par chaque poste. Cliquez sur une cellule pour voir le détail.");
        return;
      }

      setVisible("mapEmpty", false);
      applyScopeLabels();

      renderHistogramBars(grid, domainesShown, postesShown, model.matrixMap);

      let totalCompetences = 0;
      postesShown.forEach(p => {
        const row = model.matrixMap.get(p.id_poste);
        if (!row) return;
        domainesShown.forEach(d => {
          totalCompetences += Number(row.get(d.id_domaine_competence) || 0);
        });
      });

      setText("kpiMapPostes", postesShown.length);
      setText("kpiMapDomaines", domainesShown.length);
      setText("kpiMapCompetences", totalCompetences);
      setCounts("—");
      setStatus("Visualisez les domaines mobilisés par chaque poste. Cliquez sur une cellule pour voir le détail.");

    } catch (e) {
      portal.showAlert("error", "Erreur cartographie : " + e.message);
      console.error(e);

      const grid = byId("heatmapGrid");
      if (grid) grid.innerHTML = "";

      setVisible("mapEmpty", true);
      setCounts("—");
      setText("kpiMapPostes", "–");
      setText("kpiMapDomaines", "–");
      setText("kpiMapCompetences", "–");
      setText("kpiMapScope", "–");
      setStatus("Erreur de chargement");
    }
  }

  function setCardCollapsed(cardId, toggleId, storageKey, collapsed) {
    const card = byId(cardId);
    const btn = byId(toggleId);
    if (!card || !btn) return;

    card.classList.toggle("is-collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("title", collapsed ? "Déplier" : "Replier");
    btn.setAttribute("aria-label", collapsed ? "Déplier" : "Replier");
    localStorage.setItem(storageKey, collapsed ? "0" : "1");
  }

  function initCollapsibleCard(cardId, toggleId, storageKey) {
    const btn = byId(toggleId);
    const stored = localStorage.getItem(storageKey);
    const collapsed = stored === "0";
    setCardCollapsed(cardId, toggleId, storageKey, collapsed);

    if (!btn) return;
    btn.addEventListener("click", () => {
      const card = byId(cardId);
      setCardCollapsed(cardId, toggleId, storageKey, !(card?.classList?.contains("is-collapsed")));
    });
  }

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    const selService = byId("mapServiceSelect");
    const search = byId("mapSearch");
    const domainList = byId("mapDomainesList");
    const btnReset = byId("btnMapReset");
    const btnApply = byId("btnMapApply");

    const btnAdvanced = byId("btnMapAdvancedSearch");
    const advancedInput = byId("mapAdvancedSearchInput");
    const btnAdvancedRun = byId("btnMapAdvancedRun");
    const btnAdvancedCloseX = byId("btnCloseMapAdvancedModal");
    const btnAdvancedClose = byId("btnMapAdvancedClose");
    const advancedModal = byId("modalMapAdvancedSearch");

    const btnX = byId("btnCloseMapModal");
    const btnClose = byId("btnMapModalClose");
    const modal = byId("modalMapDetail");
    const grid = byId("heatmapGrid");

    if (modal) {
      modal.addEventListener("click", async (ev) => {
        const btnPdf = ev.target?.closest?.("[data-map-comp-pdf]");
        if (!btnPdf) return;

        ev.preventDefault();
        ev.stopPropagation();

        const raw = btnPdf.getAttribute("data-map-comp-pdf") || "{}";
        let comp = {};
        try { comp = JSON.parse(raw); } catch (_) { comp = {}; }

        let popup = null;
        try {
          popup = window.open("about:blank", "_blank");
          if (popup) {
            popup.document.write("<p style='font-family:Arial,sans-serif;padding:20px;'>Génération du PDF…</p>");
          }
          await openMapCompetenceFichePdf(portal, comp, popup);
        } catch (e) {
          try {
            if (popup && !popup.closed) {
              popup.document.body.innerHTML = `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;padding:20px;color:#991b1b;">${escapeHtml(e.message || "Erreur PDF")}</pre>`;
            }
          } catch (_) {}
          portal.showAlert("error", (e && e.message) ? e.message : "Action indisponible.");
        }
      });
    }


    if (btnAdvanced) {
      btnAdvanced.addEventListener("click", () => openAdvancedModal());
    }

    document.querySelectorAll("[data-map-advanced-mode]").forEach(btn => {
      btn.addEventListener("click", () => {
        setAdvancedMode(btn.getAttribute("data-map-advanced-mode"));
        if (advancedInput) advancedInput.focus();
      });
    });

    if (btnAdvancedRun) btnAdvancedRun.addEventListener("click", () => runAdvancedSearch(portal));
    if (advancedInput) {
      advancedInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") runAdvancedSearch(portal);
      });
      advancedInput.addEventListener("input", () => {
        if (_advancedTimer) clearTimeout(_advancedTimer);
        _advancedTimer = setTimeout(() => runAdvancedSearch(portal), 350);
      });
    }

    const closeAdvanced = () => closeAdvancedModal();
    if (btnAdvancedCloseX) btnAdvancedCloseX.addEventListener("click", closeAdvanced);
    if (btnAdvancedClose) btnAdvancedClose.addEventListener("click", closeAdvanced);
    if (advancedModal) {
      advancedModal.addEventListener("click", (e) => {
        if (e.target === advancedModal) closeAdvancedModal();
      });
    }

    initCollapsibleCard("mapFilterCard", "btnMapFiltersToggle", STORE_FILTERS_OPEN);
    initCollapsibleCard("mapDomainCard", "btnMapDomainesToggle", STORE_DOMAINES_OPEN);

    if (selService) {
      selService.addEventListener("change", () => {
        _cache.clear();
        refreshAll(portal);
      });
    }

    if (search) {
      search.addEventListener("input", () => {
        if (_searchTimer) clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => refreshAll(portal), 180);
      });
    }

    if (domainList) {
      domainList.addEventListener("change", (ev) => {
        const input = ev.target?.closest?.("input[data-id_domaine]");
        if (!input) return;
        localStorage.setItem(STORE_DOMAINES, JSON.stringify(getSelectedDomaines()));
        refreshAll(portal);
      });
    }

    if (btnApply) {
      btnApply.addEventListener("click", () => refreshAll(portal));
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (selService) selService.value = window.portal.serviceFilter.ALL_ID;
        if (search) search.value = "";
        setSelectedDomaines([]);
        localStorage.removeItem(STORE_DOMAINES);
        _cache.clear();
        refreshAll(portal);
      });
    }

    // Click cellule => modal résumé (V1)
    // Click cellule => modal drilldown (liste compétences)
    if (grid) {
      grid.addEventListener("click", async (ev) => {
        // Support: rendu WOW (table td.hm-cell) + ancien rendu (div dataset)
        const td = ev.target.closest(
          "td.hb-cell[data-id_poste][data-id_domaine], td.hb-totalclick[data-id_poste], td.hm-cell[data-id_poste][data-id_domaine], td.hm-cell[data-poste][data-dom]"
        );
        const dv = ev.target.closest("div[data-id_poste][data-id_domaine]");

        let id_poste = "";
        let id_dom = "";

        if (td) {
          id_poste = (td.getAttribute("data-id_poste") || td.getAttribute("data-poste") || "").trim();
          id_dom   = (td.getAttribute("data-id_domaine") || td.getAttribute("data-dom") || "").trim();
        } else if (dv) {
          id_poste = (dv.dataset.id_poste || "").trim();
          id_dom = (dv.dataset.id_domaine || "").trim();
        } else {
          return;
        }

        if (!id_poste) return;

        // si id_dom vide => clic sur Total poste (tous domaines)
        const isPosteTotal = !id_dom;


        if (td) {
          id_poste = (td.getAttribute("data-id_poste") || td.getAttribute("data-poste") || "").trim();
          id_dom   = (td.getAttribute("data-id_domaine") || td.getAttribute("data-dom") || "").trim();
        } else if (dv) {
          id_poste = (dv.dataset.id_poste || "").trim();
          id_dom = (dv.dataset.id_domaine || "").trim();
        } else {
          return; // pas une cellule
        }

        if (!id_poste) return;


        const f = getFilters();
        const selS = byId("mapServiceSelect");
        const scope = selS ? (selS.options[selS.selectedIndex]?.textContent || "Tous les services") : "Tous les services";

        // modal "loading" instant (sinon l’utilisateur croit que ça ne fait rien)
        openModal(
          isPosteTotal ? "Détail poste" : "Détail cellule",
          `<span class="sb-badge">Service : ${escapeHtml(scope)}</span>`,
          `<div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>`
        );


        try {
          const data = await fetchCellDetail(portal, id_poste, (id_dom || null), f);

          const poste = data?.poste || {};
          const dom = data?.domaine || {};
          const list = Array.isArray(data?.competences) ? data.competences : [];

          const posteCode = getPosteCodeDisplay(poste);
          const posteLabel = ((poste.intitule_poste || "").toString().trim()) || "Poste";

          const domLabel = isPosteTotal
            ? "Tous les domaines"
            : (dom.titre_court || dom.titre || dom.id_domaine_competence || "Domaine").toString();

          const domColor = isPosteTotal
            ? "#e5e7eb"
            : (normalizeColor(dom.couleur) || "#e5e7eb");

          // Tri: criticité décroissante, puis niveau requis décroissant (C > B > A)
          function toCrit(v) {
            const n = Number(v);
            return Number.isFinite(n) ? n : -1;
          }
          function toNivRank(v) {
            if (window.NovoskillLevels) return window.NovoskillLevels.rank(v);
            const s = (v ?? "").toString().trim().toUpperCase();
            if (!s) return -1;
            const c = s[0];
            if (c === "A") return 1;
            if (c === "B") return 2;
            if (c === "C") return 3;
            if (c === "D") return 4;
            const m = s.match(/^\d+/);
            return m ? Number(m[0]) : -1;
          }

          const listSorted = list.slice().sort((a, b) => {
            const ca = toCrit(a?.poids_criticite);
            const cb = toCrit(b?.poids_criticite);
            if (cb !== ca) return cb - ca;

            const na = toNivRank(a?.niveau_requis);
            const nb = toNivRank(b?.niveau_requis);
            if (nb !== na) return nb - na;

            // stabilité: code puis intitulé
            const coda = (a?.code || "").toString();
            const codb = (b?.code || "").toString();
            const dc = codb.localeCompare(coda, "fr", { sensitivity: "base" });
            if (dc !== 0) return dc;

            const ia = (a?.intitule || "").toString();
            const ib = (b?.intitule || "").toString();
            return ia.localeCompare(ib, "fr", { sensitivity: "base" });
          });


          const prh = (poste && poste.param_rh) ? poste.param_rh : {};
          const cible = Number(prh?.nb_titulaires_cible || 1);
          const pauseActive = !!prh?.pause_active;
          const nbPostesConcernes = Number(data?.nb_postes_concernes ?? (isPosteTotal ? 1 : 0));
          const nbNonCouvertes = Number(
            data?.nb_competences_non_couvertes ??
            listSorted.filter(c => mapCoverageState(c, cible, pauseActive) !== "ok").length
          );

          const body = `
            <div class="map-detail-modal-body">
              <div class="map-detail-kpi-grid">
                ${mapModalKpiCard("domain", "domain", "Domaine", domLabel)}
                ${mapModalKpiCard("postes", "postes", "Postes concernés", String(Number.isFinite(nbPostesConcernes) && nbPostesConcernes > 0 ? nbPostesConcernes : 1))}
                ${mapModalKpiCard("skills", "skills", "Compétences requises", String(list.length))}
                ${mapModalKpiCard("users", "users", "Compétences non couvertes", String(Math.max(0, nbNonCouvertes || 0)))}
              </div>

              <div class="card map-detail-table-card">
                <div class="map-detail-section-titleline">
                  <span class="map-detail-section-icon" aria-hidden="true">${mapIconSvg("section")}</span>
                  <div class="card-title map-detail-section-title">Compétences requises</div>
                </div>

                ${!list.length ? `
                  <div class="card-sub" style="margin:10px 0 0 0;">Aucune compétence trouvée pour cette cellule.</div>
                ` : `
                  <div class="table-wrap map-detail-table-wrap">
                    <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover map-detail-table">
                      <thead>
                        <tr>
                          <th>Compétence</th>
                          <th class="col-center">Niveau requis</th>
                          <th class="col-center">Criticité</th>
                          <th class="col-center">Couverture</th>
                          <th class="col-center" aria-label="Actions"></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${listSorted.map(c => {
                          const compJson = escapeHtml(JSON.stringify({
                            id_comp: c.id_comp || "",
                            code: c.code || "",
                            intitule: c.intitule || ""
                          }));
                          const code = safeTrim(c.code) || "—";
                          const intit = safeTrim(c.intitule) || "—";
                          const niv = window.NovoskillLevels
                            ? window.NovoskillLevels.badgeHtml(c.niveau_requis || "—", "Niveau requis")
                            : levelBadgeHtml4(c.niveau_requis || "—", "Niveau requis");

                          return `
                            <tr>
                              <td class="map-detail-comp-cell">
                                <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>
                                <span class="map-detail-comp-title">${escapeHtml(intit)}</span>
                              </td>
                              <td class="col-center map-detail-level-cell">${niv}</td>
                              <td class="col-center map-detail-crit-cell">${mapCritBadgeHtml(c.poids_criticite)}</td>
                              <td class="col-center map-detail-coverage-cell">${mapCoverageIndicatorHtml(c, cible, pauseActive)}</td>
                              <td class="col-center map-detail-actions-cell">
                                <div class="sb-icon-actions map-detail-actions">
                                  <button type="button"
                                          class="sb-icon-btn sb-icon-btn--doc"
                                          data-map-comp-pdf="${compJson}"
                                          title="PDF fiche compétence"
                                          aria-label="PDF fiche compétence">
                                    ${mapIconSvg("doc")}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          `;
                        }).join("")}
                      </tbody>
                    </table>
                  </div>
                `}
              </div>
            </div>
          `;

          const posteTitleOnly = ((poste.intitule_poste || "").toString().trim());
          const posteModalTitle = posteTitleOnly || posteCode || (isPosteTotal ? "Détail poste" : "Détail cellule");

          openModal({ code: posteCode, text: posteModalTitle }, "", body);

        } catch (e) {
          openModal(
            "Détail cellule",
            `<span class="sb-badge">Service : ${escapeHtml(scope)}</span>`,
            `<div class="card" style="padding:12px; margin:0;">
              <div class="card-sub" style="margin:0;">Erreur : ${escapeHtml(e.message || "inconnue")}</div>
            </div>`
          );
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

  window.SkillsCartographieCompetences = {
    onShow: async (portal) => {
      try {
        bindOnce(portal);
        
        if (!_servicesLoaded) {
          await loadServices(portal);

          // restore service après chargement options
          const selService = byId("mapServiceSelect");
          const storedService = (localStorage.getItem(STORE_SERVICE) || "").trim();
          if (selService && storedService && Array.from(selService.options).some(o => o.value === storedService)) {
            selService.value = storedService;
          } else if (selService) {
            selService.value = "";
          }
        }

        await refreshAll(portal);
      } catch (e) {
        portal.showAlert("error", "Erreur cartographie : " + e.message);
        console.error(e);
      }
    }
  };
})();
