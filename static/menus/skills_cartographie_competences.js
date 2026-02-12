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

  function safeTrim(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number") return String(v).trim();
    return "";
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
    const rawS = (byId("mapServiceSelect")?.value || "").trim();
    const id_service = window.portal.serviceFilter.toQueryId(rawS); // "__ALL__" => null
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

    const svc = filters?.id_service;
    const qs = buildQuery({
      id_service: (svc && svc !== window.portal.serviceFilter.ALL_ID) ? svc : null,
      id_domaine: filters?.id_domaine || null
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
  // V2: Histogrammes par ligne (Poste × Domaine)
  // - 1 ligne par poste
  // - 1 barre par domaine (ordre alphabétique)
  // - légende des couleurs 1 seule fois en haut
  // - clic sur une barre => on réutilise le modal cellule (point 3)
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

    // Légende couleurs (1 seule fois)
    const legend = `
      <div class="hb-dom-legend">
        ${doms.map(d => {
          const fullLabel = (d.titre || d.titre_court || d.id_domaine_competence || "").toString().trim();
          const shortLabel = (d.titre_court || d.titre || d.id_domaine_competence || "").toString().trim();
          const col = normalizeColor(d.couleur ?? d.domaine_couleur) || "#e5e7eb";
          return `
            <span class="hb-leg-item" title="${escapeHtml(fullLabel)}">
              <span class="hb-leg-dot" style="background:${escapeHtml(col)}; border-color:${escapeHtml(col)};"></span>
              <span class="hb-leg-txt">${escapeHtml(shortLabel || "—")}</span>
            </span>
          `;
        }).join("")}
      </div>
    `;

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
      const svc = (p.nom_service || "").toString().trim();

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
            ${cod ? `<div class="hb-poste-code"><span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(cod)}</span></div>` : ``}
            <div class="hb-poste-title">${escapeHtml(intit || "—")}</div>
            <div class="hb-poste-sub">${escapeHtml(svc || "—")}</div>
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
      ${legend}
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

      // render V2: histogrammes par ligne
      renderHistogramBars(grid, domainesShown, model.postes, model.matrixMap);

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
            const s = (v ?? "").toString().trim().toUpperCase();
            if (!s) return -1;
            const c = s[0];
            if (c === "A") return 1;
            if (c === "B") return 2;
            if (c === "C") return 3;
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

          const fmtDate = (v) => {
            const s = (v ?? "").toString().trim();
            const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || "—");
          };

          const pauseLabel = (() => {
            const d1 = prh?.date_debut_validite;
            const d2 = prh?.date_fin_validite;

            if (!pauseActive) return "";
            if (!d1 && !d2) return "Pause indéfinie";
            if (!d1 && d2) return `Pause jusqu’au ${fmtDate(d2)}`;
            if (d1 && !d2) return `Pause à partir du ${fmtDate(d1)} (indéfinie)`;
            return `Pause du ${fmtDate(d1)} au ${fmtDate(d2)}`;
          })();

          const sub = `
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <span class="sb-badge">Service : ${escapeHtml(scope)}</span>

              <span style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px; border:1px solid #d1d5db; border-radius:999px; font-size:12px; color:#374151; background:#fff;">
                <span style="display:inline-block; width:10px; height:10px; border-radius:999px; border:1px solid #d1d5db; background:${escapeHtml(domColor)};"></span>
                <span>${escapeHtml(domLabel)}</span>
              </span>

              <span class="sb-badge">Titulaires cible : <b>${escapeHtml(String(cible))}</b></span>

              ${pauseActive ? `<span class="sb-badge sb-badge--warning" title="${escapeHtml(pauseLabel)}">Poste en pause</span>` : ``}

              <span class="sb-badge sb-badge-accent">${list.length} compétence(s)</span>
            </div>
          `;


          let body = `
            <div class="row" style="flex-direction:column; gap:12px;">
              <div class="card" style="padding:12px; margin:0;">
                <div class="card-title" style="margin-bottom:6px;">Synthèse</div>
                <div class="card-sub" style="margin:0;">
                  ${posteCode ? `<span class="sb-badge sb-badge-ref-poste-code">${escapeHtml(posteCode)}</span><br/>` : ``}
                  Poste : <b>${escapeHtml(posteLabel)}</b><br/>
                  Domaine de compétence : <b>${escapeHtml(domLabel)}</b><br/>
                  Titulaires cible : <b>${escapeHtml(String(cible))}</b>
                  ${pauseActive ? `<br/><span class="sb-badge sb-badge--warning" title="${escapeHtml(pauseLabel)}">Poste en pause</span>` : ``}
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
                  <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover">
                    <thead>
                      <tr>
                        <th style="width:90px;">Code</th>
                        <th>Compétence</th>
                        <th class="col-center" style="width:70px;">Niveau</th>
                        <th class="col-center" style="width:70px;">Criticité</th>
                        <th class="col-center" style="width:140px;">Couv. titulaires</th>
                        <th class="col-center" style="width:70px;">Gap</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${listSorted.map(c => {
                        const code = escapeHtml(c.code || "—");
                        const intit = escapeHtml(c.intitule || "—");
                        const niv = escapeHtml(c.niveau_requis || "—");
                        const crit = (c.poids_criticite === null || c.poids_criticite === undefined) ? "—" : escapeHtml(String(c.poids_criticite));

                        const nbBrut = (c.nb_porteurs === null || c.nb_porteurs === undefined)
                          ? 0
                          : Number(c.nb_porteurs || 0);

                        const nbDispo = (c.nb_porteurs_disponibles === null || c.nb_porteurs_disponibles === undefined)
                          ? nbBrut
                          : Number(c.nb_porteurs_disponibles || 0);

                        const nbQual = (c.nb_porteurs_qualifies === null || c.nb_porteurs_qualifies === undefined)
                          ? nbDispo
                          : Number(c.nb_porteurs_qualifies || 0);

                        const gap = (c.gap_qualifie === null || c.gap_qualifie === undefined)
                          ? Math.max(0, Number(cible || 1) - Number(nbQual || 0))
                          : Number(c.gap_qualifie || 0);

                        const covTitle = `Titulaires qualifiés: ${nbQual} | Titulaires dispo: ${nbDispo} | Titulaires bruts: ${nbBrut} | Cible: ${cible}`;


                        let coverCls = "sb-badge sb-badge--danger";
                        if (pauseActive) {
                          coverCls = "sb-badge";
                        } else if (nbQual >= cible) {
                          coverCls = "sb-badge sb-badge--success";
                        } else if (nbQual > 0) {
                          coverCls = "sb-badge sb-badge--warning";
                        }

                        const gapCls = pauseActive
                          ? "sb-badge"
                          : (gap === 0 ? "sb-badge sb-badge--success" : "sb-badge sb-badge--danger");

                        const badgeCover = `<span class="${coverCls}" title="${escapeHtml(covTitle)}">${escapeHtml(String(nbQual))}</span>`;
                        const badgeGap = `<span class="${gapCls}">${escapeHtml(String(gap))}</span>`;

                        return `
                          <tr>
                            <td style="font-weight:700; white-space:nowrap;">${code}</td>
                            <td>${intit}</td>
                            <td class="col-center" style="white-space:nowrap;">${niv}</td>
                            <td class="col-center" style="white-space:nowrap;">${crit}</td>
                            <td class="col-center" style="white-space:nowrap;">${badgeCover}</td>
                            <td class="col-center" style="white-space:nowrap;">${badgeGap}</td>
                          </tr>
                        `;

                      }).join("")}
                    </tbody>
                  </table>
                </div>

                <div class="card-sub" style="margin-top:10px; color:#6b7280;">
                  Couverture titulaires = titulaires actuels du poste, disponibles aujourd’hui (hors indisponibilités) dont le niveau actuel est ≥ au niveau requis.<br/>
                  Gap = max(0, titulaires cible − couverture titulaires).
                  ${pauseActive ? `<br/><b>Poste en pause</b> : indicateurs affichés à titre informatif (hors périmètre).` : ``}
                </div>
              </div>
            `;
          }


          body += `</div>`;

          const posteTitleOnly = ((poste.intitule_poste || "").toString().trim());
          const posteModalTitle = posteTitleOnly || posteCode || (isPosteTotal ? "Détail poste" : "Détail cellule");

          openModal(posteModalTitle, sub, body);

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
