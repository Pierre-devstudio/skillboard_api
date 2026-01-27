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

  async function loadList(id_contact, filters) {
    const qs = buildQuery(filters);
    const url = `${API_BASE}/skills/collaborateurs/list/${encodeURIComponent(id_contact)}${qs}`;
    return await window.portal.apiJson(url);
  }

  async function loadIdentification(id_contact, id_effectif) {
    const url = `${API_BASE}/skills/collaborateurs/identification/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}`;
    return await window.portal.apiJson(url);
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

    if (title) title.textContent = `${it.prenom_effectif || ""} ${it.nom_effectif || ""}`.trim() || "Collaborateur";
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }


    if (body) {
      body.innerHTML = `
        <div class="sb-tabbar" role="tablist" aria-label="Onglets collaborateur">
          <button type="button" class="sb-seg sb-seg--soft is-active" data-tab="ident" role="tab" aria-selected="true">
            Identification
          </button>
          <button type="button" class="sb-seg sb-seg--soft" data-tab="skills" role="tab" aria-selected="false">
            Compétences
          </button>
          <button type="button" class="sb-seg sb-seg--soft" data-tab="certs" role="tab" aria-selected="false">
            Certifications
          </button>
          <button type="button" class="sb-seg sb-seg--soft" data-tab="history" role="tab" aria-selected="false">
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
            .then(d => {
              const v = (x) => {
                const s = (x ?? "").toString().trim();
                return s ? escapeHtml(s) : "–";
              };

              const badges = [];
              if (d.archive) badges.push("Archivé");
              else if (d.statut_actif) badges.push("Actif");
              else badges.push("Inactif");

              if (d.is_temp) badges.push("Temp");
              if (d.ismanager) badges.push("Manager");
              if (d.isformateur) badges.push("Formateur");

              const badgesHtml = badges
                .map(lbl => `<span class="sb-badge">${escapeHtml(lbl)}</span>`)
                .join("");

              const showRetraite = d.retraite_estimee != null && d.retraite_estimee !== "";

              identHost.innerHTML = `
                <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px;">
                  ${badgesHtml}
                </div>

                <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:12px 18px;">

                  <div class="sb-field">
                    <div class="label">Service</div>
                    <div class="value">${v(d.nom_service || (d.id_service ? d.id_service : "Non lié"))}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Poste</div>
                    <div class="value">${v(d.intitule_poste)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Matricule</div>
                    <div class="value">${v(d.matricule)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Type de contrat</div>
                    <div class="value">${v(d.type_contrat)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Entrée entreprise</div>
                    <div class="value">${formatDateFR(d.date_entree_entreprise_effectif)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Début poste actuel</div>
                    <div class="value">${formatDateFR(d.date_debut_poste_actuel)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Sortie prévue</div>
                    <div class="value">${formatDateFR(d.date_sortie_prevue)}</div>
                  </div>

                  ${showRetraite ? `
                  <div class="sb-field">
                    <div class="label">Retraite estimée</div>
                    <div class="value">${v(d.retraite_estimee)}</div>
                  </div>` : `
                  <div class="sb-field">
                    <div class="label">Retraite estimée</div>
                    <div class="value">–</div>
                  </div>`}

                  <div class="sb-field">
                    <div class="label">Email</div>
                    <div class="value">${v(d.email_effectif)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Téléphone</div>
                    <div class="value">${v(d.telephone_effectif)}</div>
                  </div>

                  <div class="sb-field" style="grid-column: 1 / -1;">
                    <div class="label">Adresse</div>
                    <div class="value">
                      ${v(d.adresse_effectif)}<br/>
                      ${v(d.code_postal_effectif)} ${v(d.ville_effectif)}<br/>
                      ${v(d.pays_effectif)}
                    </div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Distance (km)</div>
                    <div class="value">${d.distance_km_entreprise != null ? escapeHtml(String(d.distance_km_entreprise)) : "–"}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Niveau d’éducation</div>
                    <div class="value">${v(d.niveau_education_label)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Domaine d’éducation</div>
                    <div class="value">${v(d.domaine_education)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Date de naissance</div>
                    <div class="value">${formatDateFR(d.date_naissance_effectif)}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Postes précédents</div>
                    <div class="value">${(d.nb_postes_precedents ?? 0).toString()}</div>
                  </div>

                  <div class="sb-field">
                    <div class="label">Motif sortie</div>
                    <div class="value">${v(d.motif_sortie)}</div>
                  </div>

                  <div class="sb-field" style="grid-column: 1 / -1;">
                    <div class="label">Commentaire</div>
                    <div class="value">${v(d.note_commentaire)}</div>
                  </div>

                </div>
              `;
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
                  if (x.code) badges.push(`<span class="sb-badge">${escapeHtml(x.code)}</span>`);
                  if (isReq) badges.push(`<span class="sb-badge">Requis</span>`);
                  badges.push(`<span class="sb-badge sb-badge-domain"${domStyle}>${escapeHtml(domTitle)}</span>`);

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
                  <div class="card-sub" style="margin:0 0 10px 0;">
                    Poste: <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                  </div>

                  <div class="sb-table-wrap">
                    <table class="sb-table">
                      <thead>
                        <tr>
                          <th>Compétence</th>
                          <th style="width:90px; text-align:center;">Actuel</th>
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
      renderList(items);

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

      if (selService) {
        selService.addEventListener("change", () => {
          refreshAll(id_contact);
        });
      }

      if (inputSearch) {
        inputSearch.addEventListener("input", () => {
          clearTimeout(_searchTimer);
          _searchTimer = setTimeout(() => refreshAll(id_contact), 250);
        });
      }

      const onToggle = () => refreshAll(id_contact);

      if (chkActifs) chkActifs.addEventListener("change", onToggle);
      if (chkArchived) chkArchived.addEventListener("change", onToggle);
      if (chkManagers) chkManagers.addEventListener("change", onToggle);
      if (chkFormateurs) chkFormateurs.addEventListener("change", onToggle);
      if (chkTemp) chkTemp.addEventListener("change", onToggle);

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
