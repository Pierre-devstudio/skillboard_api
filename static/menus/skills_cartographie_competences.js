/* ======================================================
   static/menus/skills_cartographie_competences.js
   - Menu "Cartographie des compétences"
   - Heatmap Poste × Domaine
   - Filtres: Service + Domaine
   - Modal détail (V1: résumé cellule)
   ====================================================== */

(function () {
  let _bound = false;
  let _servicesLoaded = false;
  let _cache = new Map(); // key: service|domaine

  const NON_LIE_ID = "__NON_LIE__";
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

  function setText(id, v, fallback = "–") {
    const el = byId(id);
    if (el) el.textContent = (v === null || v === undefined || v === "") ? fallback : String(v);
  }

  function setVisible(id, visible) {
    const el = byId(id);
    if (el) el.style.display = visible ? "" : "none";
  }

  function getAccentHex() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return v || "#c1272d";
  }

  function hexToRgb(hex) {
    let h = (hex || "").trim();
    if (!h) return { r: 193, g: 39, b: 45 };
    if (h.startsWith("rgb")) {
      const m = h.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
      return { r: 193, g: 39, b: 45 };
    }
    if (h[0] === "#") h = h.slice(1);
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    const n = parseInt(h, 16);
    if (isNaN(n)) return { r: 193, g: 39, b: 45 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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
    const sel = byId("mapServiceSelect");
    if (!sel) return;

    const stored = localStorage.getItem(STORE_SERVICE) || "";
    const current = sel.value || stored || "";

    sel.innerHTML = "";
    sel.insertAdjacentHTML("beforeend", `<option value="">Tous les services</option>`);
    sel.insertAdjacentHTML("beforeend", `<option value="${NON_LIE_ID}">Non liés (sans service)</option>`);

    (flat || []).forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.id_service;
      const prefix = s.depth ? "— ".repeat(Math.min(6, s.depth)) : "";
      opt.textContent = prefix + (s.nom_service || s.id_service);
      sel.appendChild(opt);
    });

    if (Array.from(sel.options).some(o => o.value === current)) {
      sel.value = current;
    } else {
      sel.value = ""; // défaut: tous
    }
  }

  function fillDomaineSelect(domaines) {
    const sel = byId("mapDomaineSelect");
    if (!sel) return;

    const stored = localStorage.getItem(STORE_DOMAINE) || "";
    const current = sel.value || stored || "";

    sel.innerHTML = `<option value="">Tous les domaines</option>`;

    (domaines || []).forEach(d => {
      const id = d?.id_domaine_competence;
      if (!id) return;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = d.titre_court || d.titre || id;
      sel.appendChild(opt);
    });

    if (current && Array.from(sel.options).some(o => o.value === current)) {
      sel.value = current;
    } else {
      sel.value = "";
    }
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
    // on réutilise l'endpoint organisation (déjà en place)
    const nodes = await portal.apiJson(`${portal.apiBase}/skills/organisation/services/${encodeURIComponent(portal.contactId)}`);
    const flat = flattenServices(Array.isArray(nodes) ? nodes : []);
    fillServiceSelect(flat);
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

  function buildMatrix(data) {
  // On accepte plusieurs formats (robuste)
  const rawDomaines = Array.isArray(data?.domaines) ? data.domaines : (Array.isArray(data?.domains) ? data.domains : []);
  const postes = Array.isArray(data?.postes) ? data.postes : (Array.isArray(data?.rows) ? data.rows : []);

  // Normalisation domaines (id parfois pas nommé pareil côté API)
  const domaines = (rawDomaines || []).map(d => {
    if (!d) return d;
    const id =
      d.id_domaine_competence ||
      d.id_domaine ||
      d.domaine ||
      d.id ||
      null;

    return {
      ...d,
      id_domaine_competence: id
    };
  }).filter(d => d && d.id_domaine_competence);

  // matrixMap[id_poste][id_domaine] = count
  const matrixMap = new Map();

  function setCell(id_poste, id_dom, count) {
    if (!id_poste || !id_dom) return;
    if (!matrixMap.has(id_poste)) matrixMap.set(id_poste, new Map());
    matrixMap.get(id_poste).set(id_dom, Number(count || 0));
  }

  // Support: cells ou matrix liste (ton cas), ou matrix objet
  const cells = Array.isArray(data?.cells)
    ? data.cells
    : (Array.isArray(data?.matrix) ? data.matrix : []);

  if (cells.length) {
    cells.forEach(c => {
      const id_poste =
        c?.id_poste ||
        c?.idPoste ||
        c?.poste_id ||
        null;

      const id_dom =
        c?.id_domaine_competence ||
        c?.id_domaine ||
        c?.domaine ||
        c?.idDomaineCompetence ||
        null;

      const count =
        c?.nb_competences ??
        c?.nb_comp ??
        c?.nb ??
        c?.count ??
        c?.total ??
        0;

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


  function renderHeatmap(portal, data, filters) {
    const grid = byId("heatmapGrid");
    if (!grid) return;

    const empty = byId("mapEmpty");

    const { domaines, postes, matrixMap } = buildMatrix(data);

    // domaine filter (client-side, au cas où l’API renvoie tout)
    let domainesShown = domaines;
    if (filters.id_domaine) {
      domainesShown = domaines.filter(d => d?.id_domaine_competence === filters.id_domaine);
    }

    // si rien => vide
    if (!postes.length || !domainesShown.length) {
      grid.innerHTML = "";
      setVisible("mapEmpty", true);
      setText("mapCount", "—");
      setText("kpiMapPostes", postes.length || 0);
      setText("kpiMapDomaines", domainesShown.length || 0);
      setText("kpiMapCompetences", 0);
      return;
    }

    if (empty) empty.style.display = "none";

    // Scope labels
    const sel = byId("mapServiceSelect");
    const serviceLabel = sel ? (sel.options[sel.selectedIndex]?.textContent || "Tous les services") : "Tous les services";
    setText("mapScopeLabel", `Service : ${serviceLabel}`);
    setText("kpiMapScope", serviceLabel);

    // compute max / total
    let maxVal = 0;
    let total = 0;

    postes.forEach(p => {
      const row = matrixMap.get(p.id_poste) || new Map();
      domainesShown.forEach(d => {
        const did = d.id_domaine_competence;
        const v = Number(row.get(did) || 0);
        if (v > maxVal) maxVal = v;
        total += v;
      });
    });

    setText("kpiMapPostes", postes.length);
    setText("kpiMapDomaines", domainesShown.length);
    setText("kpiMapCompetences", total);

    setText("mapCount", `${postes.length} poste(s) · ${domainesShown.length} domaine(s)`);

    // build grid
    const labelCol = "minmax(320px, 1fr)";
    const domCol = "52px";
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = `${labelCol} repeat(${domainesShown.length}, ${domCol})`;
    grid.style.gridAutoRows = "46px";
    grid.style.border = "1px solid #e5e7eb";
    grid.style.borderRadius = "10px";
    grid.style.overflow = "hidden";
    grid.style.background = "#fff";

    const accent = hexToRgb(getAccentHex());

    function cellBase(div, isHeader) {
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.justifyContent = "center";
      div.style.borderRight = "1px solid #f3f4f6";
      div.style.borderBottom = "1px solid #f3f4f6";
      div.style.padding = "8px";
      div.style.fontSize = "12px";
      div.style.userSelect = "none";
      if (isHeader) {
        div.style.fontWeight = "600";
        div.style.background = "#fafafa";
        div.style.position = "sticky";
        div.style.top = "0";
        div.style.zIndex = "2";
      }
      return div;
    }

    function leftHeader(div) {
      div.style.justifyContent = "flex-start";
      div.style.position = "sticky";
      div.style.left = "0";
      div.style.zIndex = "3";
      return div;
    }

    function leftCell(div) {
      div.style.justifyContent = "flex-start";
      div.style.position = "sticky";
      div.style.left = "0";
      div.style.zIndex = "1";
      div.style.background = "#fff";
      return div;
    }

    function intensityBg(v) {
      if (!v || v <= 0 || maxVal <= 0) return "#ffffff";
      const t = Math.min(1, v / maxVal);
      // alpha 0.05 -> 0.38
      const a = 0.05 + (0.33 * t);
      return `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${a})`;
    }

    grid.innerHTML = "";

    // Header row (top)
    const h0 = cellBase(document.createElement("div"), true);
    leftHeader(h0);
    h0.textContent = "Poste";
    grid.appendChild(h0);

    domainesShown.forEach(d => {
      const hd = cellBase(document.createElement("div"), true);
      const label = (d.titre_court || d.titre || d.id_domaine_competence || "Domaine").toString();
      const col = normalizeColor(d.couleur) || "#e5e7eb";

      hd.title = label;

      hd.innerHTML = `
        <span style="
          display:inline-block; width:14px; height:14px;
          border-radius:6px; border:1px solid #d1d5db;
          background:${escapeHtml(col)};
        "></span>
      `;
      grid.appendChild(hd);
    });

    // Rows
    postes.forEach(p => {
      const row = matrixMap.get(p.id_poste) || new Map();

      const lp = cellBase(document.createElement("div"), false);
      leftCell(lp);

      const cod = (p.codif_poste || "").trim();
      const intit = (p.intitule_poste || "").trim();
      const svc = (p.nom_service || "").trim();

      lp.style.flexDirection = "column";
      lp.style.alignItems = "flex-start";
      lp.style.lineHeight = "1.1";

      lp.innerHTML = `
        <div style="font-weight:600; font-size:13px; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">
          ${escapeHtml(cod ? `${cod} — ${intit}` : (intit || "—"))}
        </div>
        <div style="font-size:12px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">
          ${escapeHtml(svc || "—")}
        </div>
      `;

      lp.title = cod ? `${cod} — ${intit}` : intit;
      grid.appendChild(lp);

      domainesShown.forEach(d => {
        const did = d.id_domaine_competence;
        const v = Number(row.get(did) || 0);

        const c = cellBase(document.createElement("div"), false);
        c.style.cursor = "pointer";
        c.style.background = intensityBg(v);

        c.dataset.id_poste = p.id_poste;
        c.dataset.id_domaine = did;
        c.dataset.value = String(v);

        c.title = `${cod ? cod + " — " : ""}${intit || "Poste"} | ${d.titre_court || d.titre || did} : ${v} compétence(s)`;

        c.innerHTML = v > 0
          ? `<span style="font-weight:700; color:#111827;">${v}</span>`
          : `<span style="color:#9ca3af;">·</span>`;

        // hover
        c.addEventListener("mouseenter", () => {
          c.style.outline = "2px solid rgba(17,24,39,0.12)";
          c.style.outlineOffset = "-2px";
        });
        c.addEventListener("mouseleave", () => {
          c.style.outline = "none";
        });

        grid.appendChild(c);
      });
    });
  }

  async function refreshAll(portal) {
    const f = getFilters();

    // persist
    localStorage.setItem(STORE_SERVICE, f.id_service || "");
    localStorage.setItem(STORE_DOMAINE, f.id_domaine || "");

    try {
      portal.showAlert("", "");

      const data = await fetchMatrice(portal, f);

      // domaines (pour remplir le filtre)
      const domaines = Array.isArray(data?.domaines) ? data.domaines : (Array.isArray(data?.domains) ? data.domains : []);
      fillDomaineSelect(domaines);

      renderHeatmap(portal, data, f);

    } catch (e) {
      portal.showAlert("error", "Erreur cartographie : " + e.message);
      console.error(e);
      // fallback
      const grid = byId("heatmapGrid");
      if (grid) grid.innerHTML = "";
      setVisible("mapEmpty", true);
      setText("mapCount", "—");
      setText("kpiMapPostes", "–");
      setText("kpiMapDomaines", "–");
      setText("kpiMapCompetences", "–");
      setText("kpiMapScope", "–");
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
        refreshAll(portal);
      });
    }

    if (selDom) {
      selDom.addEventListener("change", () => {
        // pas besoin de vider cache si l’API renvoie tout, mais on garde simple
        _cache.clear();
        refreshAll(portal);
      });
    }

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (selService) selService.value = "";
        if (selDom) selDom.value = "";
        _cache.clear();
        refreshAll(portal);
      });
    }

    // Click cellule => modal résumé (V1)
    if (grid) {
      grid.addEventListener("click", (ev) => {
        const cell = ev.target.closest("div[data-id_poste][data-id_domaine]");
        if (!cell) return;

        const id_poste = cell.dataset.id_poste;
        const id_dom = cell.dataset.id_domaine;
        const val = Number(cell.dataset.value || 0);

        const selS = byId("mapServiceSelect");
        const scope = selS ? (selS.options[selS.selectedIndex]?.textContent || "Tous les services") : "Tous les services";

        const selD = byId("mapDomaineSelect");
        let domLabel = "Domaine";
        if (selD) {
          const opt = Array.from(selD.options).find(o => o.value === id_dom);
          domLabel = opt ? opt.textContent : domLabel;
        }

        const title = `Cellule ${escapeHtml(domLabel)}`;
        const sub = `<span class="sb-badge">Service : ${escapeHtml(scope)}</span>`;
        const body = `
          <div class="row" style="flex-direction:column; gap:12px;">
            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">Résumé</div>
              <div class="card-sub" style="margin:0;">
                Cette cellule contient <b>${val}</b> compétence(s) requise(s) pour ce poste dans ce domaine.
              </div>
            </div>

            <div class="card" style="padding:12px; margin:0;">
              <div class="card-title" style="margin-bottom:6px;">Actions</div>
              <div class="card-sub" style="margin:0;">
                V1: on est en mode cartographie (macro). Le drilldown “liste des compétences” arrivera juste après.
              </div>
            </div>
          </div>
        `;

        openModal(title, sub, body);
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
        await ensureContext(portal);

        if (!_servicesLoaded) {
          await loadServices(portal);

          // restore filtres après chargement services
          const selService = byId("mapServiceSelect");
          const storedService = localStorage.getItem(STORE_SERVICE) || "";
          if (selService && Array.from(selService.options).some(o => o.value === storedService)) {
            selService.value = storedService;
          } else if (selService) {
            selService.value = "";
          }

          const selDom = byId("mapDomaineSelect");
          const storedDom = localStorage.getItem(STORE_DOMAINE) || "";
          if (selDom && Array.from(selDom.options).some(o => o.value === storedDom)) {
            selDom.value = storedDom;
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
