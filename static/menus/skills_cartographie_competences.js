/* ======================================================
   static/menus/skills_cartographie_competences.js
   - Menu "Cartographie des compétences"
   - Heatmap Poste × Domaine (WAOOOUUU)
   - Filtres: Service + Domaine
   - Modal détail (V1: résumé cellule)
   ====================================================== */

(function () {
  let _bound = false;
  let _servicesLoaded = false;
  const _cache = new Map(); // key: service|domaine

  const STORE_SERVICE = "sb_map_service";
  const STORE_DOMAINE = "sb_map_domaine";

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

  function fillDomaineSelect(domaines) {
    const sel = byId("mapDomaineSelect");
    if (!sel) return;

    const stored = localStorage.getItem(STORE_DOMAINE) || "";
    const current = (sel.value || stored || "").trim();

    sel.innerHTML = `<option value="">Tous les domaines</option>`;

    (domaines || []).forEach(d => {
      const id = d?.id_domaine_competence;
      if (!id) return;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = d.titre_court || d.titre || id;
      sel.appendChild(opt);
    });

    if (current && Array.from(sel.options).some(o => o.value === current)) sel.value = current;
    else sel.value = "";
  }

  function getFilters() {
    const id_service = (byId("mapServiceSelect")?.value || "").trim();
    const id_domaine = (byId("mapDomaineSelect")?.value || "").trim();
    return { id_service, id_domaine };
  }

  function openModal(title, sub, bodyHtml) {
    const modal = byId("modalMapDetail");
    if (!modal) return;

    const t = byId("mapModalTitle");
    const s = byId("mapModalSub");
    const b = byId("mapModalBody");

    if (t) t.textContent = title || "Détail";
    if (s) s.innerHTML = sub || "";
    if (b) b.innerHTML = bodyHtml || "";

    modal.classList.add("show");
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
    const key = `${filters.id_service || ""}|${filters.id_domaine || ""}`;
    if (_cache.has(key)) return _cache.get(key);

    const qs = buildQuery({
      id_service: filters.id_service || null,
      id_domaine: filters.id_domaine || null
    });

    const url = `${portal.apiBase}/skills/cartographie/matrice/${encodeURIComponent(portal.contactId)}${qs}`;
    const data = await portal.apiJson(url);

    _cache.set(key, data);
    return data;
  }

  async function fetchCellDetail(portal, id_poste, id_domaine, filters) {
  const params = new URLSearchParams();
  params.set("id_poste", id_poste);

  if (id_domaine) params.set("id_domaine", id_domaine);

  // pour rester cohérent avec le filtre Service en cours
  if (filters?.id_service) params.set("id_service", filters.id_service);

  const url = `${portal.apiBase}/skills/cartographie/cell/${encodeURIComponent(portal.contactId)}?${params.toString()}`;
  return await portal.apiJson(url);
  }

    function formatPorteurLabel(p) {
    if (!p) return "—";
    const prenom = (p.prenom_effectif || "").trim();
    const nom = (p.nom_effectif || "").trim();
    const full = `${prenom} ${nom}`.trim() || "—";

    const poste = (p.intitule_poste || "").trim();
    const svc = (p.nom_service || "").trim();

    // on préfère le poste, sinon service, sinon rien
    const right = poste || svc || "";

    return right ? `${full}|||${right}` : `${full}|||`;
  }

  function renderPorteursMini(porteurs) {
    const list = Array.isArray(porteurs) ? porteurs : [];
    if (!list.length) {
      return `<div class="card-sub" style="margin-top:6px; color:#6b7280;">Aucun porteur</div>`;
    }

    const max = 6;
    const shown = list.slice(0, max);

    const rows = shown.map(p => {
      const packed = formatPorteurLabel(p);
      const parts = packed.split("|||");
      const left = parts[0] || "—";
      const right = parts[1] || "";

      return `
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="font-weight:600; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(left)}
          </span>
          <span style="color:#6b7280; font-size:12px; white-space:nowrap;">
            ${escapeHtml(right || "—")}
          </span>
        </div>
      `;
    }).join("");

    const more = list.length > max
      ? `<div class="card-sub" style="margin-top:4px; color:#6b7280;">+ ${list.length - max} autre(s)</div>`
      : "";

    return `<div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">${rows}${more}</div>`;
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
  // WAOOOUUU: Heatmap table + styles inject
  // ==============================
  let _hmStylesInjected = false;

  function injectHeatmapWowStylesOnce() {
    if (_hmStylesInjected) return;
    _hmStylesInjected = true;

    const style = document.createElement("style");
    style.textContent = `
      /* Heatmap WOW */
      #view-cartographie-competences .hm-legend{
        display:flex; align-items:center; gap:8px; margin-top:10px;
        color:#6b7280; font-size:12px;
      }
      #view-cartographie-competences .hm-legend-lab{ white-space:nowrap; }

      #view-cartographie-competences .hm-swatch{
        width:24px; height:12px; border-radius:6px;
        border:1px solid rgba(0,0,0,.08); display:inline-block;
      }

      #view-cartographie-competences .hm-wrap{
        margin-top:10px;
        border:1px solid #e5e7eb;
        border-radius:12px;
        overflow:auto;
        background:#fff;
      }

      #view-cartographie-competences .hm-table{
        width:100%;
        border-collapse:separate;
        border-spacing:0;
        min-width: 680px;
      }

      #view-cartographie-competences .hm-table th,
      #view-cartographie-competences .hm-table td{
        border-bottom:1px solid #f3f4f6;
        border-right:1px solid #f3f4f6;
        padding:12px 12px;
        vertical-align:middle;
        white-space:nowrap;
      }

      #view-cartographie-competences .hm-table thead th{
        position:sticky; top:0; z-index:3;
        background:#fafafa;
        font-size:13px;
        font-weight:700;
        color:#111827;
        text-align:center;
      }

      #view-cartographie-competences .hm-rowhead{
        text-align:left !important;
        min-width: 360px;
        position:sticky;
        left:0;
        z-index:4;
        background:#fff;
      }

      #view-cartographie-competences .hm-sticky.hm-rowhead{
        background:#fafafa;
      }

      #view-cartographie-competences .hm-poste-title{
        font-weight:700; font-size:13px; color:#111827;
        overflow:hidden; text-overflow:ellipsis; max-width:520px;
      }
      #view-cartographie-competences .hm-poste-sub{
        font-size:12px; color:#6b7280;
        overflow:hidden; text-overflow:ellipsis; max-width:520px;
      }

      #view-cartographie-competences .hm-dom-dot{
        display:inline-block;
        width:12px; height:12px;
        border-radius:6px;
        border:1px solid #d1d5db;
        flex:0 0 auto;
      }

      #view-cartographie-competences .hm-dom-txt{
        display:inline-block;
        max-width:140px;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        text-align:left;
        color:#111827;
      }

      #view-cartographie-competences .hm-cell{
        text-align:center;
        font-weight:800;
        border-radius:10px;
        cursor:pointer;
        user-select:none;
        transition:transform .06s ease, filter .12s ease;
        background:#fff;
      }
      #view-cartographie-competences .hm-cell:hover{
        filter:brightness(0.98);
        transform:translateY(-1px);
      }

      #view-cartographie-competences .hm-totalcell{
        background:#f9fafb;
        font-weight:900;
      }
      #view-cartographie-competences .hm-grandtotal{
        background:#f3f4f6;
        font-weight:900;
      }
      #view-cartographie-competences .hm-totalrow td{
        position:sticky;
        bottom:0;
        background:#fff;
        z-index:2;
      }
      #view-cartographie-competences .hm-totalrow .hm-rowhead{
        background:#fff;
        z-index:5;
        font-weight:900;
      }
    `;
    document.head.appendChild(style);
  }

  function renderHeatmapWow(containerEl, domaines, postes, matrixMap) {
    const el = containerEl;
    if (!el) return;

    injectHeatmapWowStylesOnce();

    const doms = Array.isArray(domaines) ? domaines : [];
    const rows = Array.isArray(postes) ? postes : [];
    const map = (matrixMap instanceof Map) ? matrixMap : new Map();

    // Totaux + max
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

    // Couleurs "heat"
    const accentRaw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c1272d";
    const accent = normalizeColor(accentRaw);

    function bgFor(v) {
      v = Number(v || 0);
      if (v <= 0 || maxVal <= 0) return "#fff";
      const t = Math.min(1, v / maxVal);
      const a = 0.06 + 0.34 * t; // 0.06 -> 0.40
      if (accent.startsWith("#")) {
        const r = parseInt(accent.slice(1, 3), 16);
        const g = parseInt(accent.slice(3, 5), 16);
        const b = parseInt(accent.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${a})`;
      }
      // fallback si accent pas en hex
      return `rgba(193,39,45,${a})`;
    }

    // Légende (5 niveaux)
    const legend = `
      <div class="hm-legend">
        <span class="hm-legend-lab">Faible</span>
        <span class="hm-swatch" style="background:${bgFor(maxVal * 0.2)};"></span>
        <span class="hm-swatch" style="background:${bgFor(maxVal * 0.4)};"></span>
        <span class="hm-swatch" style="background:${bgFor(maxVal * 0.6)};"></span>
        <span class="hm-swatch" style="background:${bgFor(maxVal * 0.8)};"></span>
        <span class="hm-swatch" style="background:${bgFor(maxVal)};"></span>
        <span class="hm-legend-lab">Fort</span>
      </div>
    `;

    // Header
    let ths = `<th class="hm-sticky hm-rowhead">Poste</th>`;
    doms.forEach(d => {
      const fullLabel = (d.titre || d.titre_court || d.id_domaine_competence || "").toString().trim();
      const shortLabel = (d.titre_court || d.titre || d.id_domaine_competence || "").toString().trim();
      const col = normalizeColor(d.couleur ?? d.domaine_couleur) || "#e5e7eb";

      ths += `
        <th class="hm-colhead" title="${escapeHtml(fullLabel)}">
          <div style="display:flex; align-items:center; gap:8px; justify-content:flex-start;">
            <span class="hm-dom-dot" style="background:${escapeHtml(col)}; border-color:${escapeHtml(col)};"></span>
            <span class="hm-dom-txt" title="${escapeHtml(fullLabel)}">${escapeHtml(shortLabel || "—")}</span>
          </div>
        </th>
      `;
    });
    ths += `<th class="hm-colhead">Total</th>`;

    // Body rows
    let trs = "";
    rows.forEach(p => {
      const r = map.get(p.id_poste);
      const cod = (p.codif_poste || "").toString().trim();
      const intit = (p.intitule_poste || "").toString().trim();
      const svc = (p.nom_service || "").toString().trim();

      let tds = "";
      doms.forEach(d => {
        const v = (r && r.get(d.id_domaine_competence)) ? Number(r.get(d.id_domaine_competence)) : 0;
        const title = `${cod ? cod + " — " : ""}${intit || "Poste"} | ${d.titre_court || d.titre || d.id_domaine_competence} : ${v}`;
        tds += `
          <td class="hm-cell"
              data-id_poste="${escapeHtml(p.id_poste)}"
              data-id_domaine="${escapeHtml(d.id_domaine_competence)}"
              data-value="${v}"
              title="${escapeHtml(title)}"
              style="background:${escapeHtml(bgFor(v))};">
            ${v ? v : ""}
          </td>
        `;
      });

      const tot = rowTotal.get(p.id_poste) || 0;

      trs += `
        <tr>
          <td class="hm-rowhead">
            <div class="hm-poste-title">${escapeHtml(cod ? `${cod} — ${intit}` : (intit || "—"))}</div>
            <div class="hm-poste-sub">${escapeHtml(svc || "—")}</div>
          </td>
          ${tds}
          <td class="hm-cell hm-totalcell">${tot ? tot : ""}</td>
        </tr>
      `;
    });

    // Total row
    let totalRow = `<td class="hm-rowhead hm-totalrowlab">Total</td>`;
    doms.forEach(d => {
      const v = colTotal.get(d.id_domaine_competence) || 0;
      totalRow += `<td class="hm-cell hm-totalcell">${v ? v : ""}</td>`;
    });
    totalRow += `<td class="hm-cell hm-grandtotal">${grandTotal ? grandTotal : ""}</td>`;

    el.innerHTML = `
      ${legend}
      <div class="hm-wrap">
        <table class="hm-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>
            ${trs || `<tr><td class="hm-rowhead">—</td><td class="hm-cell">—</td></tr>`}
            <tr class="hm-totalrow">${totalRow}</tr>
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
    localStorage.setItem(STORE_DOMAINE, f.id_domaine || "");

    try {
      portal.showAlert("", "");
      setStatus("Chargement…");
      setCounts("—");

      const data = await fetchMatrice(portal, f);

      const rawDomaines = Array.isArray(data?.domaines) ? data.domaines : (Array.isArray(data?.domains) ? data.domains : []);
      fillDomaineSelect(rawDomaines);

      const model = buildMatrix(data);

      // filtre domaine côté UI (robuste même si API renvoie tout)
      const domainesShown = f.id_domaine
        ? (model.domaines || []).filter(d => d.id_domaine_competence === f.id_domaine)
        : (model.domaines || []);

      // rien à afficher
      const grid = byId("heatmapGrid");
      if (!grid || !(model.postes || []).length || !domainesShown.length) {
        if (grid) grid.innerHTML = "";
        setVisible("mapEmpty", true);
        setCounts("—");
        setText("kpiMapPostes", (model.postes || []).length);
        setText("kpiMapDomaines", domainesShown.length);
        setText("kpiMapCompetences", 0);
        applyScopeLabels();
        setStatus("");
        return;
      }

      setVisible("mapEmpty", false);
      applyScopeLabels();

      // render WAOOOUUU
      renderHeatmapWow(grid, domainesShown, model.postes, model.matrixMap);

      // KPI (sur domainesShown)
      let totalCompetences = 0;
      (model.postes || []).forEach(p => {
        const row = model.matrixMap.get(p.id_poste);
        if (!row) return;
        (domainesShown || []).forEach(d => {
          totalCompetences += Number(row.get(d.id_domaine_competence) || 0);
        });
      });

      setText("kpiMapPostes", (model.postes || []).length);
      setText("kpiMapDomaines", (domainesShown || []).length);
      setText("kpiMapCompetences", totalCompetences);

      setCounts(`${(model.postes || []).length} poste(s) · ${(domainesShown || []).length} domaine(s)`);

      // FIN du "chargement"
      setStatus("");

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

  function bindOnce(portal) {
    if (_bound) return;
    _bound = true;

    const selService = byId("mapServiceSelect");
    const selDom = byId("mapDomaineSelect");
    const btnReset = byId("btnMapReset");

    const btnX = byId("btnCloseMapModal");
    const btnClose = byId("btnMapModalClose");
    const modal = byId("modalMapDetail");
    const grid = byId("heatmapGrid");

    if (selService) {
      selService.addEventListener("change", () => {
        _cache.clear();
        // reset domaine au changement service pour éviter "filtre fantôme"
        if (selDom) selDom.value = "";
        refreshAll(portal);
      });
    }

    if (selDom) {
      selDom.addEventListener("change", () => {
        _cache.clear();
        refreshAll(portal);
      });
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (selService) selService.value = window.portal.serviceFilter.ALL_ID;
        if (selDom) selDom.value = "";
        _cache.clear();
        refreshAll(portal);
      });
    }

    // Click cellule => modal résumé (V1)
    // Click cellule => modal drilldown (liste compétences)
    if (grid) {
      grid.addEventListener("click", async (ev) => {
        // Support: rendu WOW (table td.hm-cell) + ancien rendu (div dataset)
        const td = ev.target.closest("td.hm-cell[data-id_poste][data-id_domaine], td.hm-cell[data-poste][data-dom]");
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
          return; // pas une cellule
        }

        if (!id_poste || !id_dom) return;


        const f = getFilters();
        const selS = byId("mapServiceSelect");
        const scope = selS ? (selS.options[selS.selectedIndex]?.textContent || "Tous les services") : "Tous les services";

        // modal "loading" instant (sinon l’utilisateur croit que ça ne fait rien)
        openModal(
          "Détail cellule",
          `<span class="sb-badge">Service : ${escapeHtml(scope)}</span>`,
          `<div class="card" style="padding:12px; margin:0;">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>`
        );

        try {
          const data = await fetchCellDetail(portal, id_poste, id_dom, f);

          const poste = data?.poste || {};
          const dom = data?.domaine || {};
          const list = Array.isArray(data?.competences) ? data.competences : [];

          const posteLabel = `${poste.codif_poste ? poste.codif_poste + " — " : ""}${poste.intitule_poste || "Poste"}`.trim();

          const domLabel = (dom.titre_court || dom.titre || dom.id_domaine_competence || "Domaine").toString();
          const domColor = normalizeColor(dom.couleur) || "#e5e7eb";

          const sub = `
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <span class="sb-badge">Service : ${escapeHtml(scope)}</span>
              <span style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid #d1d5db; border-radius:999px; font-size:12px; color:#374151; background:#fff;">
                <span style="display:inline-block; width:10px; height:10px; border-radius:999px; border:1px solid #d1d5db; background:${escapeHtml(domColor)};"></span>
                <span>${escapeHtml(domLabel)}</span>
              </span>
              <span class="sb-badge sb-badge-accent">${list.length} compétence(s)</span>
            </div>
          `;

          let body = `
            <div class="row" style="flex-direction:column; gap:12px;">
              <div class="card" style="padding:12px; margin:0;">
                <div class="card-title" style="margin-bottom:6px;">Synthèse</div>
                <div class="card-sub" style="margin:0;">
                  Poste : <b>${escapeHtml(posteLabel)}</b><br/>
                  Domaine : <b>${escapeHtml(domLabel)}</b>
                </div>
              </div>
          `;

          if (!list.length) {
            body += `
              <div class="card" style="padding:12px; margin:0;">
                <div class="card-sub" style="margin:0;">Aucune compétence trouvée pour cette cellule.</div>
              </div>
            `;
          } else {
            body += `
              <div class="card" style="padding:12px; margin:0;">
                <div class="card-title" style="margin-bottom:6px;">Compétences requises</div>

                <div class="table-wrap" style="margin-top:10px;">
                  <table class="sb-table">
                    <thead>
                      <tr>
                        <th style="width:90px;">Code</th>
                        <th>Compétence</th>
                        <th class="col-center" style="width:110px;">Niveau</th>
                        <th class="col-center" style="width:90px;">Criticité</th>
                        <th class="col-center" style="width:110px;">Couverture</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${list.map(c => {
                        const code = escapeHtml(c.code || "—");
                        const intit = escapeHtml(c.intitule || "—");
                        const niv = escapeHtml(c.niveau_requis || "—");
                        const crit = (c.poids_criticite === null || c.poids_criticite === undefined) ? "—" : escapeHtml(String(c.poids_criticite));

                        const porteurs = Array.isArray(c.porteurs) ? c.porteurs : [];
                        const nb = (c.nb_porteurs === null || c.nb_porteurs === undefined)
                          ? porteurs.length
                          : Number(c.nb_porteurs || 0);

                        const badge = nb > 0
                          ? `<span class="sb-badge sb-badge-accent">${nb}</span>`
                          : `<span class="sb-badge">0</span>`;

                        // Liste des porteurs sous l’intitulé
                        const porteursHtml = renderPorteursMini(porteurs);

                        return `
                          <tr>
                            <td style="font-weight:700; white-space:nowrap;">${code}</td>
                            <td>
                              ${intit}
                              ${porteursHtml}
                            </td>
                            <td class="col-center" style="white-space:nowrap;">${niv}</td>
                            <td class="col-center" style="white-space:nowrap;">${crit}</td>
                            <td class="col-center" style="white-space:nowrap;">${badge}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                </div>

                <div class="card-sub" style="margin-top:10px; color:#6b7280;">
                  Couverture = nombre de collaborateurs porteurs de la compétence (selon le périmètre filtré).
                </div>
              </div>
            `;
          }


          body += `</div>`;

          openModal(posteLabel || "Détail cellule", sub, body);

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
