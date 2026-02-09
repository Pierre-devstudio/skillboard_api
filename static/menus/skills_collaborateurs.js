/* ======================================================
   static/menus/skills_collaborateurs.js
   - Menu "Vos collaborateurs"
   - Filtres (service, recherche, toggles)
   - KPI dynamiques selon le service
   - Liste cliquable (modal squelette)
   ====================================================== */

(function () {
  if (!window.portal) return;

  const API_BASE = window.portal.apiBase || "https://skillboard-services.onrender.com";

  const VIEW_NAME = "vos-collaborateurs";

  let _handlersBound = false;
  let _searchTimer = null;

  // Indisponibilités (KPI + filtre table)
  let _lastListItems = [];
  let _breakNowIds = new Set();     // collaborateurs indispo aujourd'hui
  let _breakNext30Ids = new Set();  // collaborateurs avec indispo qui démarre dans les 30j
  let _breakFocus = null;           // "now" | "next30" | null


  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return (s ?? "")
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setText(id, value, fallback = "–") {
    const el = byId(id);
    if (!el) return;
    el.textContent = value != null && value !== "" ? value : fallback;
  }

  function formatDateFR(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "–";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

    function pad2(n) { return String(n).padStart(2, "0"); }

  function toDateOnly(d) {
    const x = (d instanceof Date) ? d : new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate());
  }

  function addDays(d, n) {
    const x = toDateOnly(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function toYmd(d) {
    const x = toDateOnly(d);
    const yyyy = x.getFullYear();
    const mm = pad2(x.getMonth() + 1);
    const dd = pad2(x.getDate());
    return `${yyyy}-${mm}-${dd}`;
  }

  function parseYmd(s) {
    const v = (s || "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.length >= 10 ? v.slice(0, 10) : v);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }


  function getFilters() {
    const rawS = (byId("collabServiceSelect")?.value || "").trim();
    const id_service = window.portal.serviceFilter.toQueryId(rawS); // "__ALL__" => null
    const q = (byId("collabSearch")?.value || "").trim();

    const only_actifs = !!byId("collabOnlyActifs")?.checked;
    const include_archived = !!byId("collabIncludeArchived")?.checked;

    const only_manager = !!byId("collabOnlyManagers")?.checked;
    const only_formateur = !!byId("collabOnlyFormateurs")?.checked;
    const only_temp = !!byId("collabOnlyTemp")?.checked;

    return {
      id_service,
      q: q || null,
      only_actifs,
      include_archived,
      only_manager,
      only_formateur,
      only_temp,
      limit: 200,
      offset: 0
    };
  }

  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v === null || v === undefined) return;
      usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }


  async function loadKpis(id_contact, id_service) {
    const qs = buildQuery({ id_service: id_service || null });
    const url = `${API_BASE}/skills/collaborateurs/kpis/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

    async function loadBreaks(id_contact, params) {
    const qs = buildQuery(params || {});
    const url = `${API_BASE}/skills/collaborateurs/breaks/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  async function refreshIndispoKpis(id_contact, filters, items) {
    // Reset
    _breakNowIds = new Set();
    _breakNext30Ids = new Set();

    // Scope: même périmètre que la liste (service + filtres liste déjà appliqués)
    const list = Array.isArray(items) ? items : [];
    const ids = list.map(x => String(x?.id_effectif || "").trim()).filter(Boolean);

    if (!ids.length) {
      setText("kpiBreakNow", 0);
      setText("kpiBreakNext30", 0);
      return;
    }

    const today = toDateOnly(new Date());
    const end30 = addDays(today, 30);

    // On récupère toutes les indispos qui intersectent [today ; today+30]
    const breaks = await loadBreaks(id_contact, {
      start: toYmd(today),
      end: toYmd(end30),
      id_service: filters?.id_service || null,
      ids_effectif: ids.join(",")
    });

    const rows = Array.isArray(breaks) ? breaks : [];

    rows.forEach(b => {
      const id_eff = String(b?.id_effectif || "").trim();
      if (!id_eff) return;

      const ds = parseYmd(b?.date_debut);
      const de = parseYmd(b?.date_fin);
      if (!ds || !de) return;

      const s = toDateOnly(ds);
      const e = toDateOnly(de);

      // En cours: start <= today <= end
      if (s <= today && e >= today) {
        _breakNowIds.add(id_eff);
      }

      // A venir: start dans (today ; today+30]
      if (s > today && s <= end30) {
        _breakNext30Ids.add(id_eff);
      }
    });

    setText("kpiBreakNow", _breakNowIds.size);
    setText("kpiBreakNext30", _breakNext30Ids.size);
  }

  function applyIndispoFocus(items) {
    const list = Array.isArray(items) ? items : [];

    if (_breakFocus === "now") {
      return list.filter(x => _breakNowIds.has(String(x?.id_effectif || "")));
    }

    if (_breakFocus === "next30") {
      return list.filter(x => _breakNext30Ids.has(String(x?.id_effectif || "")));
    }

    return list;
  }


  async function loadList(id_contact, filters) {
    const qs = buildQuery(filters);
    const url = `${API_BASE}/skills/collaborateurs/list/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  async function loadIdentification(id_contact, id_effectif) {
    const url = `${API_BASE}/skills/collaborateurs/identification/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}`;
    return await window.portal.apiJson(url);
  }

    async function loadBreaks(id_contact, params) {
    const qs = buildQuery(params || {});
    const url = `${API_BASE}/skills/collaborateurs/breaks/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  function toYmd(d) {
    const x = (d instanceof Date) ? d : new Date(d);
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, "0");
    const dd = String(x.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  async function isEffectifIndispoToday(id_contact, id_effectif) {
    if (!id_contact || !id_effectif) return false;
    const today = toYmd(new Date());

    const rows = await loadBreaks(id_contact, {
      start: today,
      end: today,
      ids_effectif: String(id_effectif)
    });

    return Array.isArray(rows) && rows.length > 0;
  }


  async function loadCompetences(id_contact, id_effectif) {
    const url = `${API_BASE}/skills/collaborateurs/competences/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}`;
    return await window.portal.apiJson(url);
  }

  async function loadCertifications(id_contact, id_effectif) {
    const url = `${API_BASE}/skills/collaborateurs/certifications/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}`;
    return await window.portal.apiJson(url);
  }

  async function loadHistoriqueFormationsJmb(id_contact, id_effectif, months, include_archived) {
    const qs = new URLSearchParams();
    if (months != null && months !== "all") qs.set("months", String(months));
    if (include_archived) qs.set("include_archived", "true");

    const url =
      `${API_BASE}/skills/collaborateurs/historique/formations-jmb/` +
      `${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}` +
      (qs.toString() ? `?${qs.toString()}` : "");

    return await window.portal.apiJson(url);
  }


  function renderKpis(k) {
    setText("kpiTotal", k?.total ?? 0);
    setText("kpiActifs", k?.actifs ?? 0);
    setText("kpiSorties", k?.sorties_prevues ?? 0);
    setText("kpiManagers", k?.managers ?? 0);
    setText("kpiFormateurs", k?.formateurs ?? 0);
    setText("kpiNonLies", k?.non_lies_service ?? 0);
  }

  function updateKpiScopeLabel() {
    const sel = byId("collabServiceSelect");
    const el = byId("collabKpiScope");
    if (!sel || !el) return;

    const v = (sel.value || "").trim();

    if (window.portal.serviceFilter.isAll(v)) {
      el.textContent = "Périmètre : entreprise";
      return;
    }

    if (v === window.portal.serviceFilter.NON_LIE_ID) {
      el.textContent = "Périmètre : non liés (sans service)";
      return;
    }


    const label = sel.options[sel.selectedIndex]?.textContent || "service";
    el.textContent = `Périmètre : ${label}`;
  }

  function renderList(items) {
    const body = byId("tblCollaborateursBody");
    const empty = byId("collabEmpty");
    const count = byId("collabCount");
    if (!body || !empty) return;

    body.innerHTML = "";

    const list = Array.isArray(items) ? items : [];

    if (count) {
      count.textContent = `${list.length} collaborateur(s)`;
    }

    if (list.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    list.forEach(it => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";

      const fullName = `${it.prenom_effectif || ""} ${(it.nom_effectif || "").toUpperCase()}`.trim();

      const statutParts = [];
      if (it.archive) statutParts.push("Archivé");
      else if (it.statut_actif) statutParts.push("Actif");
      else statutParts.push("Inactif");

      if (it.is_temp) statutParts.push("Temp");
      if (it.ismanager) statutParts.push("Manager");
      if (it.isformateur) statutParts.push("Formateur");

      const statut = statutParts.join(" · ");

      const tdNom = document.createElement("td");
      tdNom.textContent = fullName || "–";
      tr.appendChild(tdNom);

      const tdService = document.createElement("td");
      tdService.textContent = it.nom_service || (it.id_service ? it.id_service : "Non lié");
      tr.appendChild(tdService);

      const tdPoste = document.createElement("td");
      tdPoste.textContent = it.intitule_poste || "–";
      tr.appendChild(tdPoste);

      const tdStatut = document.createElement("td");
      tdStatut.textContent = statut || "–";
      tr.appendChild(tdStatut);

      const tdEntree = document.createElement("td");
      tdEntree.textContent = formatDateFR(it.date_entree_entreprise_effectif);
      tr.appendChild(tdEntree);

      const tdSortie = document.createElement("td");
      tdSortie.textContent = formatDateFR(it.date_sortie_prevue);
      tr.appendChild(tdSortie);


      tr.addEventListener("click", () => openCollaborateurModal(it));

      body.appendChild(tr);
    });
  }

  function openCollaborateurModal(it) {
    const modal = byId("modalCollaborateur");
    const title = byId("collabModalTitle");
    const sub = byId("collabModalSub");
    const body = byId("collabModalBody");
    const hb = byId("collabModalBadges");
    if (hb) hb.innerHTML = "";

    if (title) title.textContent = `${it.prenom_effectif || ""} ${it.nom_effectif || ""}`.trim() || "Collaborateur";
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }


    if (body) {
      body.innerHTML = `
        <div class="sb-tabbar" role="tablist" aria-label="Onglets collaborateur">
          <button type="button" class="sb-btn sb-btn--soft" data-tab="ident" role="tab" aria-selected="true">
            Identification
          </button>
          <button type="button" class="sb-btn sb-btn--soft" data-tab="skills" role="tab" aria-selected="false">
            Compétences
          </button>
          <button type="button" class="sb-btn sb-btn--soft" data-tab="certs" role="tab" aria-selected="false">
            Certifications
          </button>
          <button type="button" class="sb-btn sb-btn--soft" data-tab="history" role="tab" aria-selected="false">
            Historique
          </button>
        </div>


        <div class="sb-tab-panel is-active" data-panel="ident" role="tabpanel">
          <div id="collabIdentPanel" class="row" style="flex-direction:column; gap:10px;">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>

        <div class="sb-tab-panel" data-panel="skills" role="tabpanel">
          <div id="collabSkillsPanel">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>

        <div class="sb-tab-panel" data-panel="certs" role="tabpanel">
          <div id="collabCertsPanel">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>

        <div class="sb-tab-panel" data-panel="history" role="tabpanel" style="display:none;">
          <div id="collabHistoryPanel">

            <!-- Filtres -->
            <div class="sb-history-filters">
              <div class="sb-field">
                <label class="sb-label" for="histPeriodSelect">Période</label>
                <select id="histPeriodSelect" class="sb-select">
                  <option value="12">12 mois</option>
                  <option value="24">24 mois</option>
                  <option value="all" selected>Tout</option>
                </select>
              </div>

              <label class="sb-check">
                <input type="checkbox" id="histIncludeArchived" />
                <span>Inclure éléments expirés/archivés</span>
              </label>
            </div>

            <!-- Accordéons -->
            <div class="sb-accordion" id="histAccJmb">
              <button type="button" class="sb-acc-head" data-acc="jmb" aria-expanded="false">
                <span>Formations effectuées avec JMBCONSULTANT</span>
                <span class="sb-acc-chevron">▾</span>
              </button>
              <div class="sb-acc-body" data-acc-body="jmb" style="display:none;">
                <div class="card-sub" style="margin:0;">Aucun élément.</div>
              </div>
            </div>

            <div class="sb-accordion" id="histAccOther">
              <button type="button" class="sb-acc-head" data-acc="other" aria-expanded="false">
                <span>Formations effectuées via autre organisme</span>
                <span class="sb-acc-chevron">▾</span>
              </button>
              <div class="sb-acc-body" data-acc-body="other" style="display:none;">
                <div class="card-sub" style="margin:0;">Aucun élément.</div>
              </div>
            </div>

            <div class="sb-accordion" id="histAccAudits">
              <button type="button" class="sb-acc-head" data-acc="audits" aria-expanded="false">
                <span>Audits des compétences</span>
                <span class="sb-acc-chevron">▾</span>
              </button>
              <div class="sb-acc-body" data-acc-body="audits" style="display:none;">
                <div class="card-sub" style="margin:0;">Aucun élément.</div>
              </div>
            </div>

            <div class="sb-accordion" id="histAccCerts">
              <button type="button" class="sb-acc-head" data-acc="certs_hist" aria-expanded="false">
                <span>Certifications</span>
                <span class="sb-acc-chevron">▾</span>
              </button>
              <div class="sb-acc-body" data-acc-body="certs_hist" style="display:none;">
                <div class="card-sub" style="margin:0;">Aucun élément.</div>
              </div>
            </div>

            <div class="sb-accordion" id="histAccMoves">
              <button type="button" class="sb-acc-head" data-acc="moves" aria-expanded="false">
                <span>Évolutions structurantes</span>
                <span class="sb-acc-chevron">▾</span>
              </button>
              <div class="sb-acc-body" data-acc-body="moves" style="display:none;">
                <div class="card-sub" style="margin:0;">Aucun élément.</div>
              </div>
            </div>

          </div>
        </div>

      `;
    }

        // Onglets modal (Identification / Compétences / Certifications)
    if (body) {
      const tabs = Array.from(body.querySelectorAll(".sb-tabbar [data-tab]"));
      const panels = Array.from(body.querySelectorAll(".sb-tab-panel[data-panel]"));

      const setActiveTab = (key) => {
        tabs.forEach(b => {
          const active = b.getAttribute("data-tab") === key;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
            // état visuel (IMPORTANT)
          b.classList.toggle("sb-btn--accent", active);
          b.classList.toggle("sb-btn--soft", !active);
        });
        panels.forEach(p => {
          const active = p.getAttribute("data-panel") === key;
          p.classList.toggle("is-active", active);
          p.style.display = active ? "" : "none";
        });
      };

      tabs.forEach(btn => {
        btn.addEventListener("click", () => {
          setActiveTab(btn.getAttribute("data-tab"));
        });
      });

      // sécurité: force l’onglet par défaut à chaque ouverture
      setActiveTab("ident");

      // Accordéons (Historique)
      const accHeads = Array.from(body.querySelectorAll(".sb-acc-head[data-acc]"));
      accHeads.forEach(btn => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-acc");
          const target = body.querySelector(`.sb-acc-body[data-acc-body="${key}"]`);
          if (!target) return;

          const isOpen = btn.getAttribute("aria-expanded") === "true";
          btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
          btn.classList.toggle("is-open", !isOpen);
          target.style.display = isOpen ? "none" : "";
        });
      });

      // ======================================================
      // Historique > Formations JMBCONSULTANT (V1 = liste + modal placeholder)
      // ======================================================

      let _histJmbLastKey = null;

      const getHistFilters = () => {
        const p = body.querySelector("#histPeriodSelect")?.value || "all";
        const months = (p === "all") ? null : parseInt(p, 10);
        const include_archived = !!body.querySelector("#histIncludeArchived")?.checked;
        return { months: (Number.isFinite(months) ? months : null), include_archived };
      };

      const getJmbAccHead = () => body.querySelector('#histAccJmb .sb-acc-head[data-acc="jmb"]');
      const getJmbAccBody = () => body.querySelector('.sb-acc-body[data-acc-body="jmb"]');

      const ensureJmbDetailModal = () => {
        let m = document.getElementById("modalCollabJmbDetail");
        if (m) return m;

        m = document.createElement("section");
        m.className = "modal";
        m.id = "modalCollabJmbDetail";
        m.setAttribute("aria-hidden", "true");

        m.innerHTML = `
          <div class="modal-card">
            <div class="modal-header">
              <div style="font-weight:600;" id="jmbDetailTitle">Détail formation</div>
              <button type="button" class="modal-x" id="btnCloseJmbDetailModal" aria-label="Fermer">×</button>
            </div>
            <div class="modal-body">
              <div class="card-sub" style="margin-top:0;" id="jmbDetailSub">Détail à venir</div>
              <div id="jmbDetailBody" style="margin-top:12px;">
                <div class="card-sub" style="margin:0;">Contenu du détail non implémenté (volontairement).</div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-secondary" id="btnJmbDetailClose">Fermer</button>
            </div>
          </div>
        `;
        document.body.appendChild(m);

        const close = () => {
          m.classList.remove("show");
          m.setAttribute("aria-hidden", "true");
        };

        m.querySelector("#btnCloseJmbDetailModal")?.addEventListener("click", close);
        m.querySelector("#btnJmbDetailClose")?.addEventListener("click", close);

        return m;
      };

      const openJmbDetailModal = (row) => {
        const m = ensureJmbDetailModal();
        const t = m.querySelector("#jmbDetailTitle");
        const s = m.querySelector("#jmbDetailSub");
        const b = m.querySelector("#jmbDetailBody");

        const titre = row?.titre_formation ? row.titre_formation : "Formation";
        const codeF = row?.code_formation ? ` • ${row.code_formation}` : "";
        const codeA = row?.code_action_formation ? ` • ${row.code_action_formation}` : "";

        if (t) t.textContent = `${titre}${codeF}${codeA}`;
        if (s) s.textContent = "Détail (contenu à venir)";
        if (b) {
          b.innerHTML = `
            <div class="card-sub" style="margin:0;">
              Modal placeholder. On branchera ici : compétences obtenues + documents SharePoint.
            </div>
          `;
        }

        m.classList.add("show");
        m.setAttribute("aria-hidden", "false");
      };

      const renderHistJmb = (data) => {
        const host = getJmbAccBody();
        if (!host) return;

        const items = Array.isArray(data?.items) ? data.items : [];
        if (items.length === 0) {
          host.innerHTML = `<div class="card-sub" style="margin:0;">Aucune formation trouvée.</div>`;
          return;
        }

        const badge = (txt) => `<span class="sb-badge">${escapeHtml(txt)}</span>`;

        const fmtEtat = (s) => {
          const v = (s ?? "").toString().trim();
          return v ? v : "–";
        };

        const fmtFin = (x) => {
          return formatDateFR(x?.date_fin_formation || x?.date_debut_formation || null);
        };

        const fmtFormation = (x) => {
          const titre = x?.titre_formation ? escapeHtml(x.titre_formation) : "–";
          const code = x?.code_formation ? ` (${escapeHtml(x.code_formation)})` : "";
          return `<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${titre}${code}</div>`;
        };


        const rows = items.map((x) => {
          const codeAction = x?.code_action_formation ? escapeHtml(x.code_action_formation) : "–";
          const etat = badge(fmtEtat(x?.etat_action));

          return `
            <tr>
              <td style="white-space:nowrap; font-weight:700;">${codeAction}</td>
              <td style="overflow:hidden; max-width:0;">${fmtFormation(x)}</td>
              <td style="text-align:center; white-space:nowrap;">${escapeHtml(fmtFin(x))}</td>
              <td style="text-align:center; white-space:nowrap;">${etat}</td>
              <td style="text-align:center;">
                <button type="button"
                        class="btn-secondary"
                        style="padding:5px 8px; font-size:12px;"
                        data-jmb-detail="${escapeHtml(x.id_action_formation_effectif || "")}">
                  Détail
                </button>
              </td>
            </tr>
          `;
        }).join("");

        host.innerHTML = `
          <div class="sb-table-wrap">
            <table class="sb-table" style="width:100%; table-layout:fixed;">
              <colgroup>
                <col style="width:50px;">
                <col>
                <col style="width:40px;">
                <col style="width:40px;">
                <col style="width:30px;">
              </colgroup>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Formation</th>
                  <th style="text-align:center;">Fin</th>
                  <th style="text-align:center;">État</th>
                  <th style="text-align:center;">&nbsp;</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;

        // Bind boutons détail
        const btns = Array.from(host.querySelectorAll("[data-jmb-detail]"));
        btns.forEach(btn => {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-jmb-detail");
            const row = items.find(r => (r.id_action_formation_effectif || "") === id);
            openJmbDetailModal(row || null);
          });
        });
      };

      const loadHistJmb = (force = false) => {
        const id_contact = window.portal?.contactId;
        if (!id_contact || !it?.id_effectif) return;

        const f = getHistFilters();
        const key = `${f.months ?? "all"}|${f.include_archived ? "1" : "0"}`;

        if (!force && _histJmbLastKey === key) return;
        _histJmbLastKey = key;

        const host = getJmbAccBody();
        if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

        loadHistoriqueFormationsJmb(id_contact, it.id_effectif, f.months, f.include_archived)
          .then(renderHistJmb)
          .catch(e => {
            if (host) host.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur chargement : ${escapeHtml(e.message || String(e))}</div>`;
            console.error(e);
          });
      };

      // Au dépliage de l'accordéon JMB -> charge
      const jmbHead = getJmbAccHead();
      if (jmbHead) {
        jmbHead.addEventListener("click", () => {
          // On se place après le toggle (le listener accordéon a déjà tourné)
          if (jmbHead.getAttribute("aria-expanded") === "true") {
            loadHistJmb(false);
          }
        });
      }

      // Si filtres changent et accordéon ouvert -> reload
      const periodSel = body.querySelector("#histPeriodSelect");
      if (periodSel) {
        periodSel.addEventListener("change", () => {
          _histJmbLastKey = null;
          if (jmbHead?.getAttribute("aria-expanded") === "true") loadHistJmb(true);
        });
      }

      const incChk = body.querySelector("#histIncludeArchived");
      if (incChk) {
        incChk.addEventListener("change", () => {
          _histJmbLastKey = null;
          if (jmbHead?.getAttribute("aria-expanded") === "true") loadHistJmb(true);
        });
      }



      // Chargement Identification (API) + rendu
      const identHost = body.querySelector("#collabIdentPanel");
      if (identHost) {
        identHost.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

        const id_contact = window.portal?.contactId;
        if (!id_contact || !it?.id_effectif) {
          identHost.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur : identifiants manquants.</div>`;
        } else {
          loadIdentification(id_contact, it.id_effectif)
            .then(async d => {
              const v = (x) => {
                const s = (x ?? "").toString().trim();
                return s ? s : "";
              };

              const vDash = (x) => {
                const s = (x ?? "").toString().trim();
                return s ? escapeHtml(s) : "–";
              };

              const safeNum = (x) => {
                if (x == null || x === "") return "";
                const n = Number(x);
                return Number.isFinite(n) ? String(n) : "";
              };

              // Badges (statuts)
              const badges = [];

              // Badge Indisponible (si indispo en cours aujourd’hui)
              

              if (d.archive) badges.push({ label: "Archivé", cls: "sb-badge--archive" });
              else if (d.statut_actif) badges.push({ label: "Actif", cls: "sb-badge--actif" });
              else badges.push({ label: "Inactif", cls: "sb-badge--inactif" });

              try {
                const indispo = await isEffectifIndispoToday(id_contact, it.id_effectif);
                if (indispo) badges.push({ label: "Indisponible", cls: "sb-badge--indispo" });
              } catch (_) {}

              if (d.is_temp) badges.push({ label: "Temp", cls: "sb-badge--temp" });
              if (d.ismanager) badges.push({ label: "Manager", cls: "sb-badge-manager" });
              if (d.isformateur) badges.push({ label: "Formateur", cls: "sb-badge--formateur" });

              const badgesHtml = badges
                .map(b => `<span class="sb-badge ${escapeHtml(b.cls)}">${escapeHtml(b.label)}</span>`)
                .join("");



              // Push badges dans le header du modal (à côté du nom)
              const headerBadges = byId("collabModalBadges");
              if (headerBadges) headerBadges.innerHTML = badgesHtml;


              // Civilité: priorité label renvoyé par l’API
              const civLabel = (d.civilite_label || "").toString().trim() || "Autre";

              // Préparation valeurs dates (input type=date attend YYYY-MM-DD)
              const dateEntree = (d.date_entree_entreprise_effectif || "").toString().slice(0, 10);
              const dateDebutPoste = (d.date_debut_poste_actuel || "").toString().slice(0, 10);
              const dateNaiss = (d.date_naissance_effectif || "").toString().slice(0, 10);
              const dateSortie = (d.date_sortie_prevue || "").toString().slice(0, 10);

              // Sortie prévue: checkbox + date (prêt pour édition, mais disabled pour l’instant)
              const hasSortie = !!dateSortie;

              // Options “Type contrat”
              const contratOptions = [
                "CDI",
                "CDD",
                "Intérim",
                "Apprentissage",
                "Professionalisation",
                "Stage",
                "Consultant",
                "Autre",
              ];

              // Options “Motif sortie” (DB stocke uniquement la catégorie)
              const motifOptions = [
                "Volontaire",
                "Subi",
                "Légal",
                "Non renseigné",
              ];

              // Niveau d’éducation: on utilise ce que renvoie l’API (label), et on prépare un select prêt édition
              // (Les valeurs codes restent côté DB, on activera l’édition plus tard)
              const eduLabel = (d.niveau_education_label || "").toString().trim();
              const eduCode = (d.niveau_education_code || "").toString().trim();

              // Rendu HTML
              identHost.innerHTML = `

                <!-- Bloc 1 : Coordonnées -->
                <div class="sb-collab-actions">
                  <button type="button" class="sb-collab-btn sb-collab-btn--edit" id="collabBtnEdit">Modifier</button>
                  <button type="button" class="sb-collab-btn sb-collab-btn--save" id="collabBtnSave" style="display:none;">Enregistrer</button>
                  <button type="button" class="sb-collab-btn sb-collab-btn--cancel" id="collabBtnCancel" style="display:none;">Annuler</button>
                </div>
                <div class="sb-collab-block">
                  <div class="sb-collab-grid">
                    <!-- civilité | nom | prenom -->
                    <div class="sb-field">
                      <div class="sb-label">Civilité</div>
                      <select class="sb-select" id="collabCiv" disabled>
                        <option value="M"${civLabel === "M" ? " selected" : ""}>M</option>
                        <option value="Mme"${civLabel === "Mme" ? " selected" : ""}>Mme</option>
                        <option value="Autre"${civLabel === "Autre" ? " selected" : ""}>Autre</option>
                      </select>
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Nom</div>
                      <input class="sb-ctrl" id="collabNom" type="text" value="${escapeHtml(v(d.nom_effectif))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Prénom</div>
                      <input class="sb-ctrl" id="collabPrenom" type="text" value="${escapeHtml(v(d.prenom_effectif))}" disabled />
                    </div>

                    <!-- adresse -->
                    <div class="sb-field" style="grid-column: 1 / -1;">
                      <div class="sb-label">Adresse</div>
                      <input class="sb-ctrl" id="collabAdr" type="text" value="${escapeHtml(v(d.adresse_effectif))}" disabled />
                    </div>

                    <!-- cp | ville | pays -->
                    <div class="sb-field">
                      <div class="sb-label">CP</div>
                      <input class="sb-ctrl" id="collabCP" type="text" value="${escapeHtml(v(d.code_postal_effectif))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Ville</div>
                      <input class="sb-ctrl" id="collabVille" type="text" value="${escapeHtml(v(d.ville_effectif))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Pays</div>
                      <input class="sb-ctrl" id="collabPays" type="text" value="${escapeHtml(v(d.pays_effectif))}" disabled />
                    </div>

                    <!-- telephone | email | date de naissance -->
                    <div class="sb-field">
                      <div class="sb-label">Téléphone</div>
                      <input class="sb-ctrl" id="collabTel" type="text" value="${escapeHtml(v(d.telephone_effectif))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Email</div>
                      <input class="sb-ctrl" id="collabEmail" type="text" value="${escapeHtml(v(d.email_effectif))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Date de naissance</div>
                      <input class="sb-ctrl" id="collabNaissance" type="date" value="${escapeHtml(dateNaiss)}" disabled />
                    </div>
                  </div>
                </div>

                <!-- Bloc 2 : Contrat & Affectation -->
                <div class="sb-collab-block">
                  <div class="sb-collab-grid">
                    <!-- matricule | service | poste actuel -->
                    <div class="sb-field">
                      <div class="sb-label">Matricule</div>
                      <input class="sb-ctrl" id="collabMatricule" type="text" value="${escapeHtml(v(d.matricule))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Service</div>
                      <select class="sb-select" id="collabService" disabled>
                        <option value="">Chargement…</option>
                      </select>
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Poste actuel</div>
                      <select class="sb-select" id="collabPoste" disabled>
                        <option value="">Chargement…</option>
                      </select>
                    </div>

                    <!-- date entree | type contrat | date debut poste -->
                    <div class="sb-field">
                      <div class="sb-label">Date entrée entreprise</div>
                      <input class="sb-ctrl" id="collabEntree" type="date" value="${escapeHtml(dateEntree)}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Type de contrat</div>
                      <select class="sb-select" id="collabContrat" disabled>
                        <option value=""></option>
                        ${contratOptions.map(x => {
                          const sel = (String(d.type_contrat || "").trim() === x) ? " selected" : "";
                          return `<option value="${escapeHtml(x)}"${sel}>${escapeHtml(x)}</option>`;
                        }).join("")}
                      </select>
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Date début poste actuel</div>
                      <input class="sb-ctrl" id="collabDebutPoste" type="date" value="${escapeHtml(dateDebutPoste)}" disabled />
                    </div>
                  </div>
                </div>

                <!-- Bloc 3 : Pilotage RH -->
                <div class="sb-collab-block">
                  <div class="sb-collab-grid">
                    <!-- Dernier diplôme obtenu | Domaine d'éducation -->
                    <div class="sb-field">
                      <div class="sb-label">Dernier diplôme obtenu</div>
                        <select class="sb-select" id="collabEduNiv" disabled>
                          <option value=""></option>                          
                          <option value="3"${eduCode === "3" ? " selected" : ""}>Niveau 3 : CAP / BEP</option>
                          <option value="4"${eduCode === "4" ? " selected" : ""}>Niveau 4 : Bac</option>
                          <option value="5"${eduCode === "5" ? " selected" : ""}>Niveau 5 : Bac+2 (BTS, DUT)</option>
                          <option value="6"${eduCode === "6" ? " selected" : ""}>Niveau 6 : Bac+3 (Licence, BUT)</option>
                          <option value="7"${eduCode === "7" ? " selected" : ""}>Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)</option>
                          <option value="8"${eduCode === "8" ? " selected" : ""}>Niveau 8 : Doctorat</option>
                          <option value="0"${eduCode === "0" ? " selected" : ""}>Aucun diplôme</option>
                        </select>
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Domaine d'éducation</div>
                      <select class="sb-select" id="collabEduDom" disabled>
                        <option value="">Chargement…</option>
                      </select>
                    </div>

                    <div></div>

                    <!-- distance | retraite -->
                    <div class="sb-field">
                      <div class="sb-label">Distance entreprise/domicile (km)</div>
                      <input class="sb-ctrl" id="collabDist" type="text" value="${escapeHtml(safeNum(d.distance_km_entreprise))}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Retraite estimée</div>
                      <input class="sb-ctrl" id="collabRetraite" type="text" value="${d.retraite_estimee != null && d.retraite_estimee !== "" ? escapeHtml(String(d.retraite_estimee)) : ""}" disabled />
                    </div>

                    <div></div>

                    <!-- sortie prévue | date sortie | motif -->
                    <div class="sb-field">
                      <div class="sb-label">Sortie prévue</div>
                      <input id="collabChkSortie" type="checkbox" ${hasSortie ? "checked" : ""} disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Date de sortie prévue</div>
                      <input class="sb-ctrl" id="collabDateSortie" type="date" value="${escapeHtml(dateSortie)}" disabled />
                    </div>

                    <div class="sb-field">
                      <div class="sb-label">Motif de sortie</div>
                      <select class="sb-select" id="collabMotifSortie" disabled>
                        <option value=""></option>
                        ${motifOptions.map(x => {
                          const sel = (String(d.motif_sortie || "").trim() === x) ? " selected" : "";
                          return `<option value="${escapeHtml(x)}"${sel}>${escapeHtml(x)}</option>`;
                        }).join("")}
                      </select>
                    </div>

                    <!-- commentaires -->
                    <div class="sb-field" style="grid-column: 1 / -1;">
                      <div class="sb-label">Commentaires</div>
                      <textarea class="sb-ctrl" id="collabComment" disabled>${escapeHtml(v(d.note_commentaire))}</textarea>
                    </div>
                  </div>
                </div>
              `;

              // -------------------------
              // Mode édition (toggle global sur l’onglet Identification)
              // -------------------------
              const editBtn = identHost.querySelector("#collabBtnEdit");
              const saveBtn = identHost.querySelector("#collabBtnSave");
              const cancelBtn = identHost.querySelector("#collabBtnCancel");

              // Champs éditables (on les activera au clic)
              const editableSelectors = [
                "#collabCiv",
                "#collabNom",
                "#collabPrenom",
                "#collabAdr",
                "#collabCP",
                "#collabVille",
                "#collabPays",
                "#collabTel",
                "#collabEmail",
                "#collabNaissance",

                "#collabMatricule",
                "#collabService",
                "#collabPoste",
                "#collabEntree",
                "#collabContrat",
                "#collabDebutPoste",

                "#collabEduNiv",
                "#collabEduDom",
                "#collabDist",
                "#collabDateSortie",
                "#collabMotifSortie",
                "#collabComment",
                "#collabChkSortie",
              ];

              const getEditableNodes = () => {
                return editableSelectors
                  .map(sel => identHost.querySelector(sel))
                  .filter(Boolean);
              };

              const snapshotValues = () => {
                const snap = {};
                editableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  if (el.type === "checkbox") snap[sel] = !!el.checked;
                  else snap[sel] = el.value;
                });
                return snap;
              };

              const restoreValues = (snap) => {
                if (!snap) return;
                editableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  if (el.type === "checkbox") el.checked = !!snap[sel];
                  else el.value = (snap[sel] ?? "");
                });
              };

              let setEditMode = (isEdit) => {
                _collabIsEdit = !!isEdit;

                // Toggle enabled/disabled sur tous les champs
                getEditableNodes().forEach(el => {
                  if (!el) return;

                  // Retraite estimée reste non éditable (calcul)
                  if (el.id === "collabRetraite") return;

                  el.disabled = !isEdit;
                });

                // Boutons
                if (editBtn) editBtn.style.display = isEdit ? "none" : "";
                if (saveBtn) saveBtn.style.display = isEdit ? "" : "none";
                if (cancelBtn) cancelBtn.style.display = isEdit ? "" : "none";

                // Sortie prévue: dépendances
                syncSortie();
              };



              let _collabEditSnap = snapshotValues();
              setEditMode(false);
              
              // Etat global édition (pour éviter les closures foireuses)
              var _collabIsEdit = false;

              function syncSortie() {
                const chk = identHost.querySelector("#collabChkSortie");
                const dt = identHost.querySelector("#collabDateSortie");
                const motif = identHost.querySelector("#collabMotifSortie");
                if (!chk || !dt || !motif) return;

                // Hors édition: tout reste bloqué
                if (!_collabIsEdit) {
                  dt.disabled = true;
                  motif.disabled = true;
                  return;
                }

                // En édition: la checkbox pilote les dépendances
                const on = !!chk.checked;
                dt.disabled = !on;
                motif.disabled = !on;

                if (!on) {
                  dt.value = "";
                  motif.value = "";
                }
              }


              if (editBtn) {
                editBtn.addEventListener("click", () => {
                  _collabEditSnap = snapshotValues();
                  setEditMode(true);
                });
              }

              // Bind une seule fois sur la checkbox sortie prévue
              const chkEl = identHost.querySelector("#collabChkSortie");
              if (chkEl && !chkEl._sbBoundSortie) {
                chkEl.addEventListener("change", syncSortie);
                chkEl._sbBoundSortie = true;
              }



              if (cancelBtn) {
                cancelBtn.addEventListener("click", () => {
                  restoreValues(_collabEditSnap);
                  setEditMode(false);
                });
              }

              if (saveBtn) {
                saveBtn.addEventListener("click", async () => {
                  try {
                    // Helpers
                    const q = (sel) => identHost.querySelector(sel);

                    const t = (sel) => {
                      const el = q(sel);
                      if (!el) return null;
                      const s = String(el.value ?? "").trim();
                      return s === "" ? null : s;
                    };

                    const dte = (sel) => {
                      // input type=date -> "YYYY-MM-DD" ou null
                      return t(sel);
                    };

                    const chk = (sel) => {
                      const el = q(sel);
                      return !!(el && el.checked);
                    };

                    const num = (sel) => {
                      const el = q(sel);
                      if (!el) return null;
                      const s = String(el.value ?? "").trim().replace(",", ".");
                      if (!s) return null;
                      const n = Number(s);
                      return Number.isFinite(n) ? n : null;
                    };

                    // Sortie prévue: si décoché -> NULL date + motif
                    const sortieOn = chk("#collabChkSortie");

                    const payload = {
                      // Bloc 1
                      civilite_label: t("#collabCiv"),
                      nom_effectif: t("#collabNom"),
                      prenom_effectif: t("#collabPrenom"),
                      adresse_effectif: t("#collabAdr"),
                      code_postal_effectif: t("#collabCP"),
                      ville_effectif: t("#collabVille"),
                      pays_effectif: t("#collabPays"),
                      telephone_effectif: t("#collabTel"),
                      email_effectif: t("#collabEmail"),
                      date_naissance_effectif: dte("#collabNaissance"),

                      // Bloc 2
                      // Règle métier: toujours dans matricule_interne
                      matricule_interne: t("#collabMatricule"),
                      id_service: t("#collabService"),
                      id_poste_actuel: t("#collabPoste"),
                      date_entree_entreprise_effectif: dte("#collabEntree"),
                      type_contrat: t("#collabContrat"),
                      date_debut_poste_actuel: dte("#collabDebutPoste"),

                      // Bloc 3
                      niveau_education: t("#collabEduNiv"),
                      // Domaine éducation: stocker le texte choisi (pas d'id derrière)
                      domaine_education: t("#collabEduDom"),
                      distance_km_entreprise: num("#collabDist"),

                      date_sortie_prevue: sortieOn ? dte("#collabDateSortie") : null,
                      motif_sortie: sortieOn ? t("#collabMotifSortie") : null,
                      note_commentaire: t("#collabComment"),
                    };

                    
                    // Appel API (POST JSON) - IMPORTANT: passer par portal.apiJson (auth + contexte entreprise)
                    const url = `${API_BASE}/skills/collaborateurs/identification/${encodeURIComponent(id_contact)}/${encodeURIComponent(it.id_effectif)}`;

                    const data = await window.portal.apiJson(
                      url,
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                      }
                    );

                    // Sécurité: l'API renvoie normalement { ok: true }
                    if (!data || data.ok !== true) {
                      const msg = (data && (data.detail || data.message))
                        ? (data.detail || data.message)
                        : "Erreur enregistrement (réponse invalide).";
                      throw new Error(msg);
                    }

                    // Succès: on met à jour le snapshot et on repasse en lecture seule
                    _collabEditSnap = snapshotValues();
                    setEditMode(false);

                    // (Optionnel) feedback léger
                    // window.portal.toast && window.portal.toast("Enregistré", "success");

                  } catch (e) {
                    console.error(e);
                    const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                    alert(`Erreur enregistrement: ${msg}`);
                  }
                });
              }


              // -------------------------
              // Chargement des listes (services / postes / domaines NSF)
              // -------------------------
              const qs = (obj) => {
                const p = new URLSearchParams();
                Object.keys(obj || {}).forEach(k => {
                  const val = obj[k];
                  if (val == null) return;
                  const s = String(val).trim();
                  if (!s) return;
                  p.set(k, s);
                });
                const q = p.toString();
                return q ? `?${q}` : "";
              };

              const selService = identHost.querySelector("#collabService");
              const selPoste = identHost.querySelector("#collabPoste");
              const selDomEdu = identHost.querySelector("#collabEduDom");

              const fillSelect = (sel, items, selectedId, emptyLabel) => {
                if (!sel) return;
                const arr = Array.isArray(items) ? items : [];
                const opt0 = `<option value="">${escapeHtml(emptyLabel || "")}</option>`;
                const opts = arr.map(x => {
                  const id = (x?.id ?? "").toString();
                  const label = (x?.label ?? "").toString();
                  const selAttr = (selectedId && String(selectedId) === String(id)) ? " selected" : "";
                  return `<option value="${escapeHtml(id)}"${selAttr}>${escapeHtml(label)}</option>`;
                }).join("");
                sel.innerHTML = opt0 + opts;
              };

              const fillSelectStrings = (sel, items, selectedLabel, emptyLabel) => {
                if (!sel) return;
                const arr = Array.isArray(items) ? items : [];
                const opt0 = `<option value="">${escapeHtml(emptyLabel || "")}</option>`;
                const opts = arr.map(t => {
                  const label = (t ?? "").toString();
                  const selAttr = (selectedLabel && String(selectedLabel) === String(label)) ? " selected" : "";
                  return `<option value="${escapeHtml(label)}"${selAttr}>${escapeHtml(label)}</option>`;
                }).join("");
                sel.innerHTML = opt0 + opts;
              };

              // Services
              try {
                const servicesUrl = `${API_BASE}/skills/collaborateurs/listes/services/${encodeURIComponent(id_contact)}`;
                const services = await window.portal.apiJson(servicesUrl);
                fillSelect(selService, services, d.id_service || "", "Non lié");
              } catch (e) {
                if (selService) selService.innerHTML = `<option value="">Erreur chargement</option>`;
                console.error(e);
              }

              // Postes (filtre service)
              const loadPostes = async (idServ) => {
                try {
                  const postesUrl = `${API_BASE}/skills/collaborateurs/listes/postes/${encodeURIComponent(id_contact)}${qs({ id_service: idServ || "" })}`;
                  const postes = await window.portal.apiJson(postesUrl);
                  fillSelect(selPoste, postes, d.id_poste_actuel || "", "");
                } catch (e) {
                  if (selPoste) {
                    const msg = (e && (e.message || e.detail)) ? String(e.message || e.detail) : String(e);
                    selPoste.innerHTML = `<option value="">Erreur chargement: ${escapeHtml(msg)}</option>`;
                  }
                  console.error(e);
                }
              };
              await loadPostes(d.id_service || "");

              // Domaine éducation (NSF)
              try {
                const domUrl = `${API_BASE}/skills/collaborateurs/listes/nsf_domaines/${encodeURIComponent(id_contact)}`;
                const doms = await window.portal.apiJson(domUrl);
                fillSelectStrings(selDomEdu, doms, d.domaine_education || "", "");
              } catch (e) {
                if (selDomEdu) selDomEdu.innerHTML = `<option value="">Erreur chargement</option>`;
                console.error(e);
              }

              // Prêt édition: si demain on active le service select, on recharge les postes
              if (selService && selPoste) {
                selService.addEventListener("change", () => {
                  loadPostes(selService.value || "");
                });
              }
            })
            .catch(e => {
              identHost.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur chargement identification : ${escapeHtml(e.message || String(e))}</div>`;
              console.error(e);
            });
        }

              // Chargement Compétences (lazy: au premier clic onglet)
              let _skillsLoaded = false;

              const renderCompetences = (data) => {
                const host = body.querySelector("#collabSkillsPanel");
                if (!host) return;

                const items = Array.isArray(data?.items) ? data.items : [];

                if (items.length === 0) {
                  host.innerHTML = `<div class="card-sub" style="margin:0;">Aucune compétence trouvée.</div>`;
                  return;
                }

                const badge = (txt) => `<span class="sb-badge">${escapeHtml(txt)}</span>`;

                const fmtDate = (d) => formatDateFR(d);

                const rows = items.map(x => {
                  const cur = (x.niveau_actuel || "").trim();
                  const d = formatDateFR(x.date_derniere_eval);

                  const isReq = !!x.is_required;

                  const domTitleRaw = (x.domaine_titre || "").toString().trim();
                  const domTitle = domTitleRaw ? domTitleRaw : "Domaine";
                  const domColorRaw = (x.domaine_couleur || "").toString().trim();
                  const domStyle = domColorRaw ? ` style="--dom-color:${escapeHtml(domColorRaw)}"` : "";

                  const badges = [];
                  if (x.code) badges.push(`<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(x.code)}</span>`);
                  if (isReq) badges.push(`<span class="sb-badge">Requis</span>`);
                  badges.push(`<span class="sb-badge sb-badge-domaine"${domStyle}>${escapeHtml(domTitle)}</span>`);

                  return `
                    <tr>
                      <td>
                        <div class="sb-comp-title">${escapeHtml(x.intitule || "")}</div>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px;">
                          ${badges.join("")}
                        </div>
                      </td>
                      <td style="text-align:center;">${escapeHtml(cur || "–")}</td>
                      <td style="text-align:center;">${escapeHtml(d)}</td>
                    </tr>
                  `;
                }).join("");

                host.innerHTML = `
                  <div class="card-sub" style="margin:10px 0 10px 0;">
                    Poste actuel: <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                  </div>

                  <div class="sb-table-wrap">
                    <table class="sb-table">
                      <thead>
                        <tr>
                          <th>Compétence</th>
                          <th style="width:90px; text-align:center;">Niv. Actuel</th>
                          <th style="width:140px; text-align:center;">Dernière éval.</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rows}
                      </tbody>
                    </table>
                  </div>
                `;

              };

              const loadSkillsIfNeeded = () => {
                if (_skillsLoaded) return;
                _skillsLoaded = true;

                const host = body.querySelector("#collabSkillsPanel");
                if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

                const id_contact = window.portal?.contactId;
                if (!id_contact || !it?.id_effectif) {
                  if (host) host.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur : identifiants manquants.</div>`;
                  return;
                }

                loadCompetences(id_contact, it.id_effectif)
                  .then(renderCompetences)
                  .catch(e => {
                    if (host) host.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur chargement compétences : ${escapeHtml(e.message || String(e))}</div>`;
                    console.error(e);
                  });
              };

              // Hook: au clic onglet "Compétences"
              tabs.forEach(btn => {
                if (btn.getAttribute("data-tab") === "skills") {
                  btn.addEventListener("click", loadSkillsIfNeeded);
                }
              });

              // Chargement Certifications (lazy: au premier clic onglet)
              let _certsLoaded = false;

              const renderCertifications = (data) => {
                const host = body.querySelector("#collabCertsPanel");
                if (!host) return;

                const items = Array.isArray(data?.items) ? data.items : [];

                if (items.length === 0) {
                  host.innerHTML = `<div class="card-sub" style="margin:0;">Aucune certification trouvée.</div>`;
                  return;
                }

                const badge = (txt) => `<span class="sb-badge">${escapeHtml(txt)}</span>`;

                const fmtValidite = (n) => {
                  if (n == null) return "–";
                  const v = Number(n);
                  if (!Number.isFinite(v)) return "–";
                  if (v <= 0) return "Permanent";
                  return `${v} mois`;
                };

                const fmtDelai = (n) => (n == null ? "–" : `${n} j`);
                const fmtObt = (x) => (x?.is_acquired ? formatDateFR(x.date_obtention) : "–");

                const getExpIso = (x) => x?.date_expiration || x?.date_expiration_calculee || null;
                const fmtExp = (x) => (x?.is_acquired ? formatDateFR(getExpIso(x)) : "–");

                const statutLabel = (x) => {
                  if (!x?.is_acquired) return "Non acquis";
                  const s = (x?.statut_validite || "").toString().toLowerCase();
                  if (s === "valide") return "Valide";
                  if (s === "a_renouveler") return "À renouveler";
                  if (s === "expiree") return "Expirée";
                  return "–";
                };

                const rows = items.map(x => {
                  const badges = [];

                  if (x.categorie) badges.push(badge(x.categorie));

                  if (x.is_required) {
                    const ne = (x.niveau_exigence || "requis").toString().toLowerCase();
                    badges.push(badge(ne.includes("souhait") ? "Souhaité" : "Requis"));
                  } else {
                    badges.push(badge("Hors poste"));
                  }

                  const statut = statutLabel(x);
                  const jr = x?.jours_restants != null ? `${x.jours_restants} j` : "–";

                  return `
                    <tr>
                      <td>
                        <div class="sb-comp-title">${escapeHtml(x.nom_certification || "")}</div>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px;">
                          ${badges.join("")}
                        </div>
                      </td>

                      <td style="text-align:center;">
                        <div>${escapeHtml(fmtValidite(x.validite_attendue))}</div>
                        <div class="card-sub" style="margin:6px 0 0 0;">Renouv.: ${escapeHtml(fmtDelai(x.delai_renouvellement))}</div>
                      </td>

                      <td style="text-align:center;">
                        ${badge(statut)}
                        <div class="card-sub" style="margin:6px 0 0 0;">${escapeHtml(jr)}</div>
                      </td>

                      <td style="text-align:center;">
                        <div>${escapeHtml(fmtObt(x))}</div>
                        <div class="card-sub" style="margin:6px 0 0 0;">${escapeHtml(fmtExp(x))}</div>
                      </td>
                    </tr>
                  `;
                }).join("");

                host.innerHTML = `
                  <div class="card-sub" style="margin:0 0 10px 0;">
                    Poste: <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                  </div>

                  <div class="sb-table-wrap">
                    <table class="sb-table">
                      <thead>
                        <tr>
                          <th>Certification</th>
                          <th style="width:160px; text-align:center;">Validité</th>
                          <th style="width:160px; text-align:center;">État</th>
                          <th style="width:180px; text-align:center;">Dates</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rows}
                      </tbody>
                    </table>
                  </div>
                `;
              };

              const loadCertsIfNeeded = () => {
                if (_certsLoaded) return;
                _certsLoaded = true;

                const host = body.querySelector("#collabCertsPanel");
                if (host) host.innerHTML = `<div class="card-sub" style="margin:0;">Chargement…</div>`;

                const id_contact = window.portal?.contactId;
                if (!id_contact || !it?.id_effectif) {
                  if (host) host.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur : identifiants manquants.</div>`;
                  return;
                }

                loadCertifications(id_contact, it.id_effectif)
                  .then(renderCertifications)
                  .catch(e => {
                    if (host) host.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur chargement certifications : ${escapeHtml(e.message || String(e))}</div>`;
                    console.error(e);
                  });
              };

              // Hook: au clic onglet "Certifications"
              tabs.forEach(btn => {
                if (btn.getAttribute("data-tab") === "certs") {
                  btn.addEventListener("click", loadCertsIfNeeded);
                }
              });

      }
    }


    if (modal) {
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeCollaborateurModal() {
    const modal = byId("modalCollaborateur");
    if (modal) {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function refreshAll(id_contact) {
    if (!id_contact) return;

    try {
      window.portal.showAlert("", "");

      const filters = getFilters();

      updateKpiScopeLabel();

      // KPIs filtrés uniquement sur service (le reste c’est des filtres “liste”)
      const kpis = await loadKpis(id_contact, filters.id_service);
      renderKpis(kpis);

      const items = await loadList(id_contact, filters);

      // Base pour KPI + filtre “focus”
      _lastListItems = Array.isArray(items) ? items : [];

      // KPI indispos (si fonctions présentes)
      try {
        if (typeof refreshIndispoKpis === "function") {
          await refreshIndispoKpis(id_contact, filters, _lastListItems);
        }
      } catch (_) {}

      const listToRender = (typeof applyIndispoFocus === "function")
        ? applyIndispoFocus(_lastListItems)
        : _lastListItems;

      renderList(listToRender);


    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement collaborateurs : " + e.message);
      console.error(e);
    }
  }

  async function initMenu(portalCtx) {
    const id_contact = portalCtx?.contactId || window.portal.contactId;
    if (!id_contact) return;

    // Bind handlers une seule fois
    if (!_handlersBound) {
      _handlersBound = true;

      const selService = byId("collabServiceSelect");
      const inputSearch = byId("collabSearch");

      const chkActifs = byId("collabOnlyActifs");
      const chkArchived = byId("collabIncludeArchived");
      const chkManagers = byId("collabOnlyManagers");
      const chkFormateurs = byId("collabOnlyFormateurs");
      const chkTemp = byId("collabOnlyTemp");

      const btnReset = byId("btnCollabReset");
      const btnOpenPlanning = byId("btnOpenIndispoPlanning");

      if (btnReset) {
        btnReset.addEventListener("click", () => {
          if (selService) selService.value = window.portal.serviceFilter.ALL_ID;
          if (inputSearch) inputSearch.value = "";
          if (chkActifs) chkActifs.checked = true;
          if (chkArchived) chkArchived.checked = false;
          if (chkManagers) chkManagers.checked = false;
          if (chkFormateurs) chkFormateurs.checked = false;
          if (chkTemp) chkTemp.checked = false;

          refreshAll(id_contact);
        });
      }

      if (btnOpenPlanning) {
        btnOpenPlanning.addEventListener("click", () => {
          window.location.hash = "planning-indispo";
          if (window.portal && typeof window.portal.switchView === "function") {
            window.portal.switchView("planning-indispo");
          }
        });
      }

            const kpiNowCard = byId("kpiBreakNowCard");
      const kpiNext30Card = byId("kpiBreakNext30Card");

      const toggleFocus = async (mode) => {
        _breakFocus = (_breakFocus === mode) ? null : mode;

        // Re-render immédiat depuis la dernière liste chargée
        const listToRender = (typeof applyIndispoFocus === "function")
          ? applyIndispoFocus(_lastListItems)
          : _lastListItems;

        renderList(listToRender);
      };

      if (kpiNowCard) {
        kpiNowCard.addEventListener("click", () => toggleFocus("now"));
      }

      if (kpiNext30Card) {
        kpiNext30Card.addEventListener("click", () => toggleFocus("next30"));
      }


      const btnClose = byId("btnCloseCollabModal");
      const btnClose2 = byId("btnCollabModalClose");
      const modal = byId("modalCollaborateur");

      if (btnClose) btnClose.addEventListener("click", () => closeCollaborateurModal());
      if (btnClose2) btnClose2.addEventListener("click", () => closeCollaborateurModal());
      if (modal) {
        modal.addEventListener("click", (e) => {
          if (e.target === modal) closeCollaborateurModal();
        });
      }
    }

    // Services (source unique + anti-doublons)
    try {
      await window.portal.serviceFilter.populateSelect({
        portal: window.portal,
        contactId: id_contact,
        selectId: "collabServiceSelect",
        storageKey: "sb_collab_service",
        labelAll: "Tous les services",
        labelNonLie: "Non lié",
        includeAll: true,
        includeNonLie: true,
        allowIndent: true
      });
    } catch (e) {
      window.portal.showAlert("error", "Erreur chargement services : " + e.message);
    }


    // Premier refresh complet
    await refreshAll(id_contact);
  }

  // Expose function for portal.onShow (optional)
  window.skillsCollaborateurs = window.skillsCollaborateurs || {};
  window.skillsCollaborateurs.onShow = initMenu;
})();
