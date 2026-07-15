/* ======================================================
   static/menus/skills_besoins_formations.js
   Demandes RH Insights
   Centre d'émission, qualification et transmission des demandes RH
   ====================================================== */
(function () {
  let _bound = false;
  let _servicesLoaded = false;
  let _portal = null;
  let _lastData = null;
  let _refs = { effectifs: [], competences: [] };
  let _loading = false;
  let _visibleCount = 8;
  let _viewMode = "grouped";
  let _openGroups = new Set();
  let _selectedItem = null;
  let _modalMode = "create";
  let _modalItem = null;
  let _searchTimer = null;

  const STORE_SERVICE = "sb_bf_service";
  const STORE_STATUT = "sb_bf_statut";
  const STORE_ORIGIN = "sb_bf_origine";
  const STORE_FINALITE = "sb_bf_finalite";
  const STORE_PRIORITY = "sb_bf_priorite";

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return (s ?? "").toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function errMsg(e) {
    if (!e) return "Erreur inconnue";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }

  function num(v) {
    const n = Number(v || 0);
    return isNaN(n) ? 0 : n;
  }

  function setText(id, value, fallback = "—") {
    const el = byId(id);
    if (!el) return;
    el.textContent = (value === null || value === undefined || value === "") ? fallback : String(value);
  }

  function setMsg(text, type, targetId = "bfActionMsg") {
    const el = byId(targetId);
    if (!el) return;
    const normalizedType = type === "error" ? "danger" : (type || "");
    el.textContent = text || "";
    el.className = "sb-inline-msg";
    if (normalizedType) el.classList.add("sb-inline-msg--" + normalizedType);
    if (text) el.classList.add("is-visible");
    if (text && normalizedType === "success") {
      window.setTimeout(() => {
        if (el.textContent === text) {
          el.textContent = "";
          el.className = "sb-inline-msg";
        }
      }, 4500);
    }
  }

  function icon(name, size = 16) {
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    const map = {
      eye: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-d54a8d543d1f"></use></svg>`,
      edit: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-3df90b3a05b1"></use></svg>`,
      send: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>`,
      check: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>`,
      close: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>`,
      pdf: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>`,
      list: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-pdf"></use></svg>`,
      group: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-3b584a1d8627"></use></svg>`,
      chevronDown: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-2a1c6f77cc47"></use></svg>`,
      chevronUp: `<svg ${attrs} class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-analysis"></use></svg>`
    };
    return map[name] || "";
  }

  function objectTitle(item) {
    const objet = String(item?.objet || "").trim();
    if (objet) return objet;
    if (isAnalyseProposal(item)) return "Renforcer l’autonomie sur une compétence clé";
    if (item?.intitule_competence) return "Renforcer une compétence";
    return "Demande RH";
  }

  function objectSub(item) {
    if (isAnalyseProposal(item) && item?.intitule_competence) return item.intitule_competence;
    return item?.intitule_competence || item?.description || "À qualifier";
  }

  function getRawService() {
    return (byId("bfServiceSelect")?.value || "").trim();
  }

  function getQueryService() {
    return window.portal.serviceFilter.toQueryId(getRawService());
  }

  function getFilters() {
    return {
      id_service: getQueryService(),
      statut: (byId("bfStatutSelect")?.value || "a_traiter").trim(),
      origine: (byId("bfOriginSelect")?.value || "tous").trim(),
      finalite_terrain: (byId("bfFinaliteSelect")?.value || "tous").trim(),
      priorite: (byId("bfPrioritySelect")?.value || "toutes").trim(),
      q: (byId("bfSearchInput")?.value || "").trim()
    };
  }

  function saveFilters() {
    const f = getFilters();
    localStorage.setItem(STORE_SERVICE, getRawService());
    localStorage.setItem(STORE_STATUT, f.statut);
    localStorage.setItem(STORE_ORIGIN, f.origine);
    localStorage.setItem(STORE_FINALITE, f.finalite_terrain);
    localStorage.setItem(STORE_PRIORITY, f.priorite);
  }

  function restoreFilters() {
    const map = [
      ["bfStatutSelect", STORE_STATUT, "a_traiter"],
      ["bfOriginSelect", STORE_ORIGIN, "tous"],
      ["bfFinaliteSelect", STORE_FINALITE, "tous"],
      ["bfPrioritySelect", STORE_PRIORITY, "toutes"],
    ];
    map.forEach(([id, key, defv]) => {
      const el = byId(id);
      if (!el) return;
      const v = (localStorage.getItem(key) || defv).trim();
      if (Array.from(el.options).some(o => o.value === v)) el.value = v;
    });
    const selService = byId("bfServiceSelect");
    const storedService = (localStorage.getItem(STORE_SERVICE) || "").trim();
    if (selService && storedService) {
      const exists = Array.from(selService.options || []).some(o => String(o.value || "") === storedService);
      if (exists) selService.value = storedService;
    }
  }

  async function loadServices(portal) {
    await portal.serviceFilter.populateSelect({
      portal,
      selectId: "bfServiceSelect",
      storageKey: STORE_SERVICE,
      labelAll: "Tous les services",
      labelNonLie: "Non lié",
      includeAll: true,
      includeNonLie: true,
      allowIndent: true
    });
    _servicesLoaded = true;
  }

  function apiUrl(path, params) {
    const qs = new URLSearchParams(params || {});
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return `${_portal.apiBase}${path}${suffix}`;
  }

  function renderDestination(dest, tableReady) {
    const el = byId("bfDestinationText");
    if (!el) return;
    const dbBadge = tableReady === false
      ? `<span class="ns-badge sb-badge sb-badge--warning">Migration SQL à appliquer</span>`
      : "";
    if (dest && dest.can_send) {
      el.innerHTML = `
        <span class="bf-destination-label">Destination</span>
        <span class="ns-badge sb-badge sb-badge--success">Studio actif</span>
        <span>${escapeHtml(dest.nom_owner || dest.id_owner || "Studio")}</span>
        ${dbBadge}
      `;
      return;
    }
    el.innerHTML = `
      <span class="bf-destination-label">Destination</span>
      <span class="ns-badge sb-badge sb-badge--danger">Envoi bloqué</span>
      <span>${escapeHtml(dest?.reason || "Aucun Studio destinataire configuré.")}</span>
      ${dbBadge}
    `;
  }

  function renderKpis(kpis) {
    const values = [
      ["À traiter", kpis?.a_traiter ?? 0, "bf-kpi-icon--red", "?"],
      ["Prêtes à transmettre", kpis?.validee ?? 0, "bf-kpi-icon--green", "✓"],
      ["Transmises au Studio", kpis?.transmise_studio ?? 0, "bf-kpi-icon--violet", "↗"],
      ["Reportées", kpis?.reportee ?? 0, "bf-kpi-icon--orange", "⏸"],
    ];
    const el = byId("bfKpiGrid");
    if (!el) return;
    el.innerHTML = values.map(([label, value, klass, ico]) => `
      <div class="card bf-kpi-card">
        <span class="bf-kpi-icon ${klass}" aria-hidden="true">${escapeHtml(ico)}</span>
        <div>
          <div class="bf-kpi-label">${escapeHtml(label)}</div>
          <div class="bf-kpi-value">${escapeHtml(value)}</div>
        </div>
      </div>
    `).join("");
  }

  function isAnalyseProposal(item) {
    return item && item.origine === "analyse" && item.is_signal_actuel && !item.id_demande_rh;
  }

  function finalityValue(item) {
    const value = (item?.finalite_terrain || item?.payload_signal?.finalite_terrain || "").toString().trim();
    const allowed = new Set([
      "monter_competence",
      "securiser_poste",
      "preparer_evolution",
      "renforcer_equipe",
      "anticiper_depart",
      "capitaliser_savoir",
      "traiter_demande_salarie",
      "besoin_rh"
    ]);
    if (allowed.has(value)) return value;
    if (isAnalyseProposal(item) || item?.intitule_competence || item?.id_comp) return "monter_competence";
    return "besoin_rh";
  }

  function finalityLabel(item) {
    if (item?.finalite_label) return item.finalite_label;
    return {
      monter_competence: "Monter en compétence",
      securiser_poste: "Sécuriser un poste",
      preparer_evolution: "Préparer une évolution",
      renforcer_equipe: "Renforcer une équipe",
      anticiper_depart: "Anticiper un départ",
      capitaliser_savoir: "Capitaliser un savoir-faire",
      traiter_demande_salarie: "Traiter une demande salarié",
      besoin_rh: "Besoin RH"
    }[finalityValue(item)] || "Besoin RH";
  }

  function whyTitle(item) {
    return item?.origine === "analyse" ? "Pourquoi Novoskill propose cette demande ?" : "Justification de la demande";
  }

  function whyProposalText(item) {
    if (item?.pourquoi_proposition) return item.pourquoi_proposition;
    if (isAnalyseProposal(item)) {
      const comp = item.intitule_competence || "cette compétence";
      const actuel = item.niveau_actuel_label || item.niveau_actuel || "non évalué";
      const attendu = item.niveau_attendu_label || item.niveau_attendu || "attendu";
      return `Novoskill propose cette demande car le niveau actuel sur ${comp} (${actuel}) est inférieur au niveau attendu (${attendu}) pour le poste occupé.`;
    }
    return item?.description || "Aucune justification détaillée pour le moment.";
  }

  function originLabel(v) {
    return {
      analyse: "Analyse",
      simulation: "Simulation",
      manager: "Manager",
      salarie: "Salarié",
      entretien: "Entretien"
    }[v] || "Manager";
  }

  function badgeClass(kind, value) {
    if (kind === "statut") {
      return {
        a_qualifier: "bf-badge--red",
        a_valider: "bf-badge--orange",
        validee: "bf-badge--green",
        transmise_studio: "bf-badge--blue",
        prise_en_charge: "bf-badge--violet",
        action_creee: "bf-badge--green",
        reportee: "bf-badge--orange",
        refusee: "bf-badge--gray",
        classee: "bf-badge--gray"
      }[value] || "bf-badge--gray";
    }
    if (kind === "type") {
      return {
        formation: "bf-badge--blue",
        transmission: "bf-badge--violet",
        renfort: "bf-badge--cyan",
        recrutement: "bf-badge--red",
        mobilite: "bf-badge--orange",
        tutorat: "bf-badge--green",
        entretien: "bf-badge--gray",
        documentation: "bf-badge--gray",
        organisation: "bf-badge--cyan",
        autre: "bf-badge--gray"
      }[value] || "bf-badge--gray";
    }
    return {
      analyse: "bf-badge--violet",
      simulation: "bf-badge--orange",
      manager: "bf-badge--green",
      salarie: "bf-badge--blue",
      entretien: "bf-badge--gray"
    }[value] || "bf-badge--gray";
  }

  function priorityLabel(v) {
    return {
      critique: "Critique",
      haute: "Haute",
      normale: "Normale",
      basse: "Basse"
    }[v] || "Normale";
  }

  function initials(name) {
    const parts = (name || "").split(/\s+/).filter(Boolean);
    return (parts[0]?.[0] || "D") + (parts[1]?.[0] || "");
  }

  function dateLabel(value) {
    const s = (value || "").toString().slice(0, 10);
    if (!s) return "—";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function echeanceLabel(item) {
    return item.echeance_souhaitee ? dateLabel(item.echeance_souhaitee) : (item.delai_souhaite || item.delai_recommande || "—");
  }

  function renderTabs(kpis) {
    const counts = {
      a_traiter: kpis?.a_traiter ?? 0,
      validee: kpis?.validee ?? 0,
      transmise_studio: kpis?.transmise_studio ?? 0,
      reportee: kpis?.reportee ?? 0,
      tous: kpis?.total ?? 0
    };
    byId("bfTabs")?.querySelectorAll(".bf-tab").forEach(btn => {
      const v = btn.getAttribute("data-bf-tab") || "";
      btn.classList.toggle("is-active", (byId("bfStatutSelect")?.value || "a_traiter") === v);
      const strong = btn.querySelector("strong");
      if (strong) strong.textContent = String(counts[v] ?? 0);
    });
  }

  function isToQualify(item) {
    return !item?.id_demande_rh || item?.statut === "a_qualifier" || item?.statut === "a_valider";
  }

  function isTransmittedStatus(statut) {
    return statut === "transmise_studio" || statut === "prise_en_charge" || statut === "action_creee";
  }

  function actionButtonHtml(item, index) {
    const id = item.id_demande_rh || "";
    const idxAttr = Number.isInteger(index) ? ` data-bf-index="${index}"` : "";
    if (isToQualify(item)) {
      return `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-bf-edit="${escapeHtml(id)}"${idxAttr}>Qualifier</button>`;
    }
    if (item.statut === "validee" && id && item.id_comp && item.id_effectif_concerne) {
      return `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-bf-transmit="${escapeHtml(id)}">Transmettre</button>`;
    }
    if (item.statut === "validee" && id) {
      return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-edit="${escapeHtml(id)}"${idxAttr}>Modifier</button>`;
    }
    if (item.statut === "reportee" && id) {
      return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-status="validee" data-id="${escapeHtml(id)}">Réactiver</button>`;
    }
    if (isTransmittedStatus(item.statut)) {
      return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-follow="1">Voir le suivi</button>`;
    }
    return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-edit="${escapeHtml(id)}"${idxAttr}>Modifier</button>`;
  }

  function itemStableKey(item, index) {
    return String(item?.id_demande_rh || item?.source_ref || `idx_${index}`);
  }

  function groupStableKey(item) {
    return String(item?.id_effectif_concerne || item?.id_effectif || item?.collaborateur_nom_complet || "demande_collective");
  }

  function statusOrder(statut) {
    return {
      a_qualifier: 1,
      a_valider: 2,
      validee: 3,
      transmise_studio: 4,
      prise_en_charge: 5,
      action_creee: 6,
      reportee: 7,
      refusee: 8,
      classee: 9
    }[statut] || 9;
  }

  function priorityOrder(priorite) {
    return {
      critique: 1,
      haute: 2,
      normale: 3,
      basse: 4
    }[priorite] || 3;
  }

  function buildGroups(rows) {
    const map = new Map();
    rows.forEach((item, index) => {
      const key = groupStableKey(item);
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: item.collaborateur_nom_complet || "Demande collective",
          poste: item.intitule_poste || "Poste non précisé",
          service: item.nom_service || "Service non précisé",
          items: []
        });
      }
      map.get(key).items.push({ item, index });
    });
    return Array.from(map.values());
  }

  function groupBestPriority(group) {
    const first = [...group.items].sort((a, b) => priorityOrder(a.item.priorite) - priorityOrder(b.item.priorite))[0]?.item || {};
    return first.priorite || "normale";
  }

  function groupMainStatus(group) {
    const first = [...group.items].sort((a, b) => statusOrder(a.item.statut) - statusOrder(b.item.statut))[0]?.item || {};
    return first.statut || "a_qualifier";
  }

  function groupMainStatusLabel(group) {
    const first = [...group.items].sort((a, b) => statusOrder(a.item.statut) - statusOrder(b.item.statut))[0]?.item || {};
    return first.statut_label || { a_qualifier: "À qualifier", a_valider: "À qualifier", validee: "Prête à transmettre", transmise_studio: "Transmise", prise_en_charge: "Prise en charge", action_creee: "Action créée", reportee: "Reportée", refusee: "Refusée", classee: "Classée" }[first.statut] || "À qualifier";
  }

  function groupMainEcheance(group) {
    const dated = group.items
      .map(x => x.item)
      .filter(x => x.echeance_souhaitee)
      .sort((a, b) => String(a.echeance_souhaitee || "").localeCompare(String(b.echeance_souhaitee || "")))[0];
    return echeanceLabel(dated || group.items[0]?.item || {});
  }

  function updateViewToggle() {
    const text = byId("bfViewToggleText");
    const ico = byId("bfViewToggleIcon");
    const btn = byId("btnBfViewToggle");
    if (text) text.textContent = _viewMode === "grouped" ? "Vue liste" : "Vue groupée";
    if (ico) ico.innerHTML = _viewMode === "grouped" ? icon("list", 15) : icon("group", 15);
    if (btn) btn.setAttribute("aria-pressed", _viewMode === "grouped" ? "true" : "false");
  }

  function renderListRows(rows) {
    const visible = rows.slice(0, _visibleCount);
    return `
      <div class="bf-table bf-table--list">
        <div class="bf-table-row bf-table-row--head">
          <div>Collaborateur</div>
          <div class="bf-cell--center">Origine</div>
          <div class="bf-cell--center">Finalité</div>
          <div>Objet</div>
          <div class="bf-cell--center">Statut</div>
          <div class="bf-cell--center">Échéance</div>
          <div class="bf-cell--center">Actions</div>
        </div>
        ${visible.map((item, idx) => `
          <div class="bf-table-row ${idx === 0 ? "is-suggested" : ""}" data-bf-row="${idx}">
            <div class="bf-who">
              <span class="bf-avatar">${escapeHtml(initials(item.collaborateur_nom_complet))}</span>
              <div>
                <strong>${escapeHtml(item.collaborateur_nom_complet || "Demande collective")}</strong>
                <small>${escapeHtml(item.intitule_poste || "Poste non précisé")} · ${escapeHtml(item.nom_service || "Service non précisé")}</small>
              </div>
            </div>
            <div class="bf-cell--center"><span class="ns-badge bf-badge ${badgeClass("origin", item.origine)}">${escapeHtml(originLabel(item.origine))}</span></div>
            <div class="bf-cell--center"><span class="ns-badge bf-badge bf-badge--blue">${escapeHtml(finalityLabel(item))}</span></div>
            <div class="bf-object">
              <strong>${escapeHtml(objectTitle(item))}</strong>
              <small>${escapeHtml(objectSub(item))}</small>
            </div>
            <div class="bf-cell--center bf-status-cell"><span class="ns-badge bf-badge ${badgeClass("statut", item.statut)}">${escapeHtml(item.statut_label || "À qualifier")}</span></div>
            <div class="bf-date bf-cell--center"><span>${escapeHtml(echeanceLabel(item))}</span><small>${escapeHtml(priorityLabel(item.priorite))}</small></div>
            <div class="bf-row-actions">
              <button type="button" class="sb-icon-btn bf-square-action-btn" data-bf-view="${idx}" title="Voir le détail" aria-label="Voir le détail">${icon("eye")}</button>
              ${actionButtonHtml(item, idx)}
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderGroupedRows(rows) {
    const groups = buildGroups(rows);
    const visibleGroups = groups.slice(0, _visibleCount);
    return `
      <div class="bf-group-stack">
        ${visibleGroups.map((group, gidx) => {
          const isOpen = _openGroups.has(group.key);
          const mainStatus = groupMainStatus(group);
          const mainPriority = groupBestPriority(group);
          return `
            <div class="bf-group-card ${gidx === 0 ? "is-suggested" : ""} ${isOpen ? "is-open" : ""}">
              <button type="button" class="bf-group-row" data-bf-group-toggle="${escapeHtml(encodeURIComponent(group.key))}" aria-expanded="${isOpen ? "true" : "false"}">
                <div class="bf-who">
                  <span class="bf-avatar">${escapeHtml(initials(group.name))}</span>
                  <div>
                    <strong>${escapeHtml(group.name)}</strong>
                    <small>${escapeHtml(group.poste)} · ${escapeHtml(group.service)}</small>
                  </div>
                </div>
                <div class="bf-group-count">
                  <strong>${group.items.length}</strong>
                  <small>${group.items.every(x => isAnalyseProposal(x.item)) ? (group.items.length > 1 ? "propositions" : "proposition") : (group.items.length > 1 ? "demandes" : "demande")}</small>
                </div>
                <div class="bf-cell--center"><span class="ns-badge bf-badge ${badgeClass("statut", mainStatus)}">${escapeHtml(groupMainStatusLabel(group))}</span></div>
                <div class="bf-date bf-cell--center"><span>${escapeHtml(groupMainEcheance(group))}</span><small>${escapeHtml(priorityLabel(mainPriority))}</small></div>
                <span class="bf-group-chevron" aria-hidden="true">${isOpen ? icon("chevronUp", 15) : icon("chevronDown", 15)}</span>
              </button>
              ${isOpen ? `
                <div class="bf-group-panel">
                  <div class="bf-group-demand-row bf-group-demand-row--head">
                    <div class="bf-cell--center">Origine</div>
                    <div class="bf-cell--center">Finalité</div>
                    <div>Objet</div>
                    <div class="bf-cell--center">Statut</div>
                    <div class="bf-cell--center">Échéance</div>
                    <div class="bf-cell--center">Actions</div>
                  </div>
                  ${group.items.map(({ item, index }) => `
                    <div class="bf-group-demand-row" data-bf-row="${index}" data-bf-key="${escapeHtml(itemStableKey(item, index))}">
                      <div class="bf-cell--center"><span class="ns-badge bf-badge ${badgeClass("origin", item.origine)}">${escapeHtml(originLabel(item.origine))}</span></div>
                      <div class="bf-cell--center"><span class="ns-badge bf-badge bf-badge--blue">${escapeHtml(finalityLabel(item))}</span></div>
                      <div class="bf-object">
                        <strong>${escapeHtml(objectTitle(item))}</strong>
                        <small>${escapeHtml(objectSub(item))}</small>
                      </div>
                      <div class="bf-cell--center bf-status-cell"><span class="ns-badge bf-badge ${badgeClass("statut", item.statut)}">${escapeHtml(item.statut_label || "À qualifier")}</span></div>
                      <div class="bf-date bf-cell--center"><span>${escapeHtml(echeanceLabel(item))}</span><small>${escapeHtml(priorityLabel(item.priorite))}</small></div>
                      <div class="bf-row-actions">
                        <button type="button" class="sb-icon-btn bf-square-action-btn" data-bf-view="${index}" title="Voir le détail" aria-label="Voir le détail">${icon("eye")}</button>
                        ${actionButtonHtml(item, index)}
                      </div>
                    </div>
                  `).join("")}
                </div>
              ` : ""}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function renderRows() {
    const wrap = byId("bfListWrap");
    if (!wrap) return;
    updateViewToggle();
    const rows = Array.isArray(_lastData?.items) ? _lastData.items : [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="bf-empty">Aucune demande RH ne correspond aux filtres.</div>`;
      byId("btnBfShowMore").style.display = "none";
      renderDetail(null);
      return;
    }

    wrap.innerHTML = _viewMode === "grouped"
      ? renderGroupedRows(rows)
      : renderListRows(rows);

    const totalUnits = _viewMode === "grouped" ? buildGroups(rows).length : rows.length;
    const more = byId("btnBfShowMore");
    if (more) {
      more.style.display = totalUnits > 8 ? "" : "none";
      more.textContent = _visibleCount >= totalUnits ? "Voir moins" : "Voir plus";
    }

    bindRowActions();
    if (_selectedItem) {
      const selectedId = String(_selectedItem.id_demande_rh || _selectedItem.source_ref || "");
      const updated = selectedId
        ? rows.find(x => String(x.id_demande_rh || x.source_ref || "") === selectedId)
        : null;
      if (updated && byId("bfDetailPanel")?.classList.contains("is-open")) {
        renderDetail(updated);
      } else {
        renderDetail(null);
      }
    }
  }

  function bindRowActions() {
    const wrap = byId("bfListWrap");
    if (!wrap) return;
    wrap.querySelectorAll("[data-bf-group-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = decodeURIComponent(btn.getAttribute("data-bf-group-toggle") || "");
        if (!key) return;
        if (_openGroups.has(key)) _openGroups.delete(key);
        else _openGroups.add(key);
        renderRows();
      });
    });
    wrap.querySelectorAll("[data-bf-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-bf-view"));
        const item = (_lastData?.items || [])[idx];
        renderDetail(item || null);
      });
    });
    wrap.querySelectorAll("[data-bf-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idxRaw = btn.getAttribute("data-bf-index");
        const idx = idxRaw === null ? -1 : Number(idxRaw);
        const item = idx >= 0 ? (_lastData?.items || [])[idx] : findItem(btn.getAttribute("data-bf-edit"));
        openDemandModal(item || null, item ? "qualify" : "create");
      });
    });
    wrap.querySelectorAll("[data-bf-status]").forEach(btn => {
      btn.addEventListener("click", () => changeStatus(btn.getAttribute("data-id"), btn.getAttribute("data-bf-status")));
    });
    wrap.querySelectorAll("[data-bf-transmit]").forEach(btn => {
      btn.addEventListener("click", () => transmitDemand(btn.getAttribute("data-bf-transmit")));
    });
    wrap.querySelectorAll("[data-bf-follow]").forEach(btn => {
      btn.addEventListener("click", () => setMsg("Le suivi détaillé remontera dans Plan d’actions quand le retour Studio sera câblé.", "info"));
    });
  }

  function findItem(id) {
    if (!id) return null;
    return (_lastData?.items || []).find(x => String(x.id_demande_rh || "") === String(id));
  }

  function renderDetail(item) {
    _selectedItem = item || null;
    const panel = byId("bfDetailPanel");
    const body = byId("bfDetailBody");
    if (!panel || !body) return;
    if (!item) {
      panel.classList.remove("is-open");
      setText("bfDetailSub", "Sélectionnez une demande.");
      body.innerHTML = `<div class="bf-empty">Aucune demande sélectionnée.</div>`;
      return;
    }
    panel.classList.add("is-open");
    setText("bfDetailSub", `${item.collaborateur_nom_complet || "Demande collective"} · ${finalityLabel(item)}`);
    const canEdit = item.id_demande_rh && !isTransmittedStatus(item.statut);
    const canQualify = isToQualify(item);
    const canReactivate = item.id_demande_rh && item.statut === "reportee";
    const canTransmit = item.id_demande_rh && item.statut === "validee" && item.id_comp && item.id_effectif_concerne;
    body.innerHTML = `
      <div class="bf-detail-section">
        <div class="bf-detail-topline">
          <span class="ns-badge bf-badge ${badgeClass("statut", item.statut)}">${escapeHtml(item.statut_label || "À qualifier")}</span>
          <span class="ns-badge bf-badge ${badgeClass("origin", item.origine)}">${escapeHtml(originLabel(item.origine))}</span>
          <span class="ns-badge bf-badge bf-badge--blue">${escapeHtml(finalityLabel(item))}</span>
        </div>
        <h3>${escapeHtml(objectTitle(item))}</h3>
        <p>${escapeHtml(objectSub(item))}</p>
      </div>

      <div class="bf-detail-section">
        <h4>Collaborateur</h4>
        <div class="bf-detail-person">
          <span class="bf-avatar">${escapeHtml(initials(item.collaborateur_nom_complet))}</span>
          <div><strong>${escapeHtml(item.collaborateur_nom_complet || "Demande collective")}</strong><small>${escapeHtml(item.intitule_poste || "Poste non précisé")} · ${escapeHtml(item.nom_service || "Service non précisé")}</small></div>
        </div>
      </div>

      <div class="bf-detail-section bf-detail-section--why">
        <h4>${escapeHtml(whyTitle(item))}</h4>
        <p>${escapeHtml(whyProposalText(item))}</p>
        ${isAnalyseProposal(item) ? `<div class="bf-detail-note">Cette proposition sert à confirmer le besoin terrain avant transmission au Studio. Les actions lancées seront suivies dans Plan d’actions.</div>` : ""}
      </div>

      <div class="bf-detail-section">
        <h4>Compétence ou sujet concerné</h4>
        <div class="bf-detail-chips">
          ${item.code_competence ? `<span class="ns-badge sb-badge sb-badge-ref-comp-code">${escapeHtml(item.code_competence)}</span>` : ""}
          <span>${escapeHtml(item.intitule_competence || "Aucune compétence directement rattachée")}</span>
        </div>
      </div>

      <div class="bf-detail-grid">
        <div><span>Priorité</span><strong>${escapeHtml(priorityLabel(item.priorite))}</strong></div>
        <div><span>Échéance</span><strong>${escapeHtml(echeanceLabel(item))}</strong></div>
        <div><span>Niveau actuel</span><strong>${escapeHtml(item.niveau_actuel_label || item.niveau_actuel || "—")}</strong></div>
        <div><span>Niveau attendu</span><strong>${escapeHtml(item.niveau_attendu_label || item.niveau_attendu || "—")}</strong></div>
      </div>

      <div class="bf-detail-section">
        <h4>Commentaires</h4>
        <p>${escapeHtml(item.commentaire_manager || item.commentaire_salarie || item.commentaire_client || "Aucun commentaire renseigné.")}</p>
      </div>

      <div class="bf-detail-actions">
        ${canEdit || canQualify ? `<button type="button" class="sb-btn sb-btn--soft" id="btnBfDetailEdit">${icon("edit", 15)}<span>${canQualify ? "Qualifier" : "Modifier"}</span></button>` : ""}
        ${canReactivate ? `<button type="button" class="sb-btn sb-btn--soft" id="btnBfDetailReactivate">${icon("check", 15)}<span>Réactiver</span></button>` : ""}
        ${canTransmit ? `<button type="button" class="sb-btn sb-btn--accent" id="btnBfDetailTransmit">${icon("send", 15)}<span>Transmettre</span></button>` : ""}
      </div>
    `;
    byId("btnBfDetailEdit")?.addEventListener("click", () => openDemandModal(item, canQualify ? "qualify" : "edit"));
    byId("btnBfDetailReactivate")?.addEventListener("click", () => changeStatus(item.id_demande_rh, "validee"));
    byId("btnBfDetailTransmit")?.addEventListener("click", () => transmitDemand(item.id_demande_rh));
  }

  function populateDemandRefs() {
    const eff = byId("bfDemandEffectif");
    const comp = byId("bfDemandCompetence");
    if (eff) {
      eff.innerHTML = `<option value="">Demande collective / non rattachée</option>` + (_refs.effectifs || []).map(e => {
        const name = [e.prenom_effectif, e.nom_effectif].filter(Boolean).join(" ").trim() || "Collaborateur";
        const sub = [e.intitule_poste, e.nom_service].filter(Boolean).join(" · ");
        return `<option value="${escapeHtml(e.id_effectif)}">${escapeHtml(name)}${sub ? " — " + escapeHtml(sub) : ""}</option>`;
      }).join("");
    }
    if (comp) {
      comp.innerHTML = `<option value="">Aucune compétence directe</option>` + (_refs.competences || []).map(c => {
        return `<option value="${escapeHtml(c.id_comp)}">${escapeHtml(c.code || "")}${c.code ? " · " : ""}${escapeHtml(c.intitule || "Compétence")}</option>`;
      }).join("");
    }
  }

  function demandDecisionMode(item) {
    if (!item) return "validee";
    if (item.statut === "reportee") return "reportee";
    return "validee";
  }

  function shouldShowDecision(item) {
    return !!item && (!item.id_demande_rh || item.statut === "a_qualifier" || item.statut === "a_valider" || item.statut === "reportee");
  }

  function getDemandDecision() {
    return byId("bfDemandDecisionToggle")?.classList.contains("is-report") ? "reportee" : "validee";
  }

  function setDemandDecision(value) {
    const decision = value === "reportee" ? "reportee" : "validee";
    const toggle = byId("bfDemandDecisionToggle");
    if (!toggle) return;
    toggle.classList.toggle("is-report", decision === "reportee");
    toggle.querySelectorAll("[data-bf-decision]").forEach(btn => {
      btn.classList.toggle("is-active", btn.getAttribute("data-bf-decision") === decision);
    });
  }

  function openDemandModal(item, mode) {
    _modalMode = mode || "create";
    _modalItem = item || null;
    populateDemandRefs();

    const isCreate = !_modalItem;
    const isQualify = shouldShowDecision(_modalItem);
    setText("bfDemandModalTitle", isCreate ? "Créer une demande RH" : (isQualify ? "Qualifier la demande RH" : "Modifier la demande RH"));
    setText("bfDemandModalSub", isCreate
      ? "Décrivez le besoin terrain. La demande sera directement prête à transmettre."
      : `${_modalItem.collaborateur_nom_complet || "Demande collective"} · ${originLabel(_modalItem.origine)}`);

    const eff = byId("bfDemandEffectif");
    if (eff) eff.value = _modalItem?.id_effectif_concerne || "";
    const comp = byId("bfDemandCompetence");
    if (comp) comp.value = _modalItem?.id_comp || "";
    const finalite = byId("bfDemandFinalite");
    if (finalite) finalite.value = finalityValue(_modalItem);
    const priority = byId("bfDemandPriority");
    if (priority) priority.value = _modalItem?.priorite || "normale";
    const objet = byId("bfDemandObjet");
    if (objet) objet.value = _modalItem?.objet || "";
    const desc = byId("bfDemandDescription");
    if (desc) desc.value = _modalItem?.description || "";
    const delai = byId("bfDemandDelai");
    if (delai) delai.value = _modalItem?.delai_souhaite || _modalItem?.delai_recommande || "";
    const echeance = byId("bfDemandEcheance");
    if (echeance) echeance.value = (_modalItem?.echeance_souhaitee || "").slice(0, 10);
    const comment = byId("bfDemandCommentaire");
    if (comment) comment.value = _modalItem?.commentaire_manager || "";

    const decisionCard = byId("bfDemandDecisionCard");
    if (decisionCard) decisionCard.hidden = !isQualify;
    setDemandDecision(demandDecisionMode(_modalItem));

    setMsg("", "", "bfDemandModalMsg");
    byId("bfDemandModal")?.classList.add("show");
  }

  function closeDemandModal() {
    byId("bfDemandModal")?.classList.remove("show");
    _modalMode = "create";
    _modalItem = null;
  }

  function collectDemandPayload() {
    const finaliteTerrain = byId("bfDemandFinalite")?.value || finalityValue(_modalItem);
    const isSignal = _modalItem && !_modalItem.id_demande_rh;
    const statut = !_modalItem
      ? "validee"
      : (shouldShowDecision(_modalItem) ? getDemandDecision() : (_modalItem.statut || "validee"));
    return {
      id_effectif_concerne: byId("bfDemandEffectif")?.value || _modalItem?.id_effectif_concerne || null,
      id_comp: byId("bfDemandCompetence")?.value || _modalItem?.id_comp || null,
      id_poste: _modalItem?.id_poste || null,
      origine: isSignal ? (_modalItem.origine || "analyse") : (_modalItem?.origine || "manager"),
      source_type: isSignal ? (_modalItem.source_type || "analyse_competences") : (_modalItem?.source_type || "manager"),
      source_ref: _modalItem?.source_ref || _modalItem?.id_demande_rh || null,
      type_demande: "autre",
      objet: byId("bfDemandObjet")?.value || _modalItem?.objet || "Demande RH à qualifier",
      description: byId("bfDemandDescription")?.value || _modalItem?.description || "",
      statut,
      priorite: byId("bfDemandPriority")?.value || "normale",
      delai_souhaite: byId("bfDemandDelai")?.value || "",
      echeance_souhaitee: byId("bfDemandEcheance")?.value || null,
      modalites_souhaitees: [],
      commentaire_manager: byId("bfDemandCommentaire")?.value || "",
      niveau_attendu: _modalItem?.niveau_attendu || null,
      niveau_actuel: _modalItem?.niveau_actuel || null,
      ecart_niveau: _modalItem?.ecart_niveau || 0,
      criticite: _modalItem?.criticite || 0,
      score_anticipation: _modalItem?.score_anticipation || 0,
      payload_signal: { ...(_modalItem?.payload_signal || {}), finalite_terrain: finaliteTerrain }
    };
  }

  async function saveDemandFromModal() {
    if (!_portal) return;
    const payload = collectDemandPayload();
    if (!payload.objet || !payload.objet.trim()) {
      setMsg("Objet de demande obligatoire.", "warning", "bfDemandModalMsg");
      return;
    }
    setMsg("Enregistrement…", "info", "bfDemandModalMsg");
    try {
      const existingId = _modalItem?.id_demande_rh || "";
      const url = existingId
        ? apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(existingId)}/qualifier`)
        : apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}`);
      const data = await _portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      closeDemandModal();
      await refresh();
      setMsg(data?.message || "Demande RH enregistrée.", "success");
    } catch (e) {
      setMsg(errMsg(e), "error", "bfDemandModalMsg");
      console.error(e);
    }
  }

  async function changeStatus(id, statut) {
    if (!_portal || !id || !statut) return;
    setMsg("Mise à jour du statut…", "info");
    try {
      const data = await _portal.apiJson(apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}/statut`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statut })
      });
      await refresh();
      setMsg(data?.message || "Statut mis à jour.", "success");
    } catch (e) {
      setMsg(errMsg(e), "error");
      console.error(e);
    }
  }

  async function transmitDemand(id) {
    if (!_portal || !id) return;
    setMsg("Transmission au Studio…", "info");
    try {
      const data = await _portal.apiJson(apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(id)}/transmettre-studio`), { method: "POST" });
      await refresh();
      setMsg(data?.message || "Demande transmise au Studio.", "success");
    } catch (e) {
      setMsg(errMsg(e), "error");
      console.error(e);
    }
  }

  async function loadRefs() {
    if (!_portal) return;
    try {
      const f = getFilters();
      const params = {};
      if (f.id_service) params.id_service = f.id_service;
      _refs = await _portal.apiJson(apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}/refs`, params));
      populateDemandRefs();
    } catch (e) {
      console.warn("Référentiels Demandes RH indisponibles", e);
      _refs = { effectifs: [], competences: [] };
    }
  }

  function render(data) {
    _lastData = data || {};
    renderDestination(_lastData.destination || {}, _lastData.table_ready);
    renderKpis(_lastData.kpis || {});
    renderTabs(_lastData.kpis || {});
    const count = Array.isArray(_lastData.items) ? _lastData.items.length : 0;
    const scope = _lastData.scope?.nom_service || "Tous les services";
    setText("bfMeta", `${count} demande(s) affichée(s) · ${scope}`);
    renderRows();
  }

  async function refresh() {
    if (!_portal || _loading) return;
    _loading = true;
    _visibleCount = 8;
    saveFilters();
    setMsg("Chargement…", "info");
    try {
      const f = getFilters();
      const params = {
        statut: f.statut,
        origine: f.origine,
        finalite_terrain: f.finalite_terrain,
        priorite: f.priorite,
        limit: "400"
      };
      if (f.id_service) params.id_service = f.id_service;
      if (f.q) params.q = f.q;
      const data = await _portal.apiJson(apiUrl(`/skills/demandes-rh/${encodeURIComponent(_portal.contactId)}`, params));
      render(data);
      setMsg("", "");
    } catch (e) {
      setMsg("Erreur système, impossible de charger les demandes RH.", "error");
      const wrap = byId("bfListWrap");
      if (wrap) wrap.innerHTML = `<div class="bf-empty">${escapeHtml(errMsg(e))}</div>`;
      console.error(e);
    } finally {
      _loading = false;
    }
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    ["bfServiceSelect", "bfStatutSelect", "bfOriginSelect", "bfFinaliteSelect", "bfPrioritySelect"].forEach(id => {
      const el = byId(id);
      if (!el) return;
      el.addEventListener("change", async () => {
        if (id === "bfServiceSelect") await loadRefs();
        await refresh();
      });
    });

    byId("bfSearchInput")?.addEventListener("input", () => {
      window.clearTimeout(_searchTimer);
      _searchTimer = window.setTimeout(refresh, 350);
    });

    byId("btnBfReset")?.addEventListener("click", async () => {
      const allId = window.portal.serviceFilter.ALL_ID || "__ALL__";
      if (byId("bfServiceSelect")) byId("bfServiceSelect").value = allId;
      if (byId("bfStatutSelect")) byId("bfStatutSelect").value = "a_traiter";
      if (byId("bfOriginSelect")) byId("bfOriginSelect").value = "tous";
      if (byId("bfFinaliteSelect")) byId("bfFinaliteSelect").value = "tous";
      if (byId("bfPrioritySelect")) byId("bfPrioritySelect").value = "toutes";
      if (byId("bfSearchInput")) byId("bfSearchInput").value = "";
      await loadRefs();
      await refresh();
    });

    byId("btnBfRefresh")?.addEventListener("click", refresh);
    byId("btnBfViewToggle")?.addEventListener("click", () => {
      _viewMode = _viewMode === "grouped" ? "list" : "grouped";
      _visibleCount = 8;
      renderRows();
    });
    byId("btnBfCreateDemand")?.addEventListener("click", () => openDemandModal(null, "create"));
    byId("bfDemandDecisionToggle")?.querySelectorAll("[data-bf-decision]").forEach(btn => {
      btn.addEventListener("click", () => setDemandDecision(btn.getAttribute("data-bf-decision")));
    });
    byId("btnBfSaveDemand")?.addEventListener("click", saveDemandFromModal);
    byId("btnBfCloseDetail")?.addEventListener("click", () => renderDetail(null));

    byId("btnBfShowMore")?.addEventListener("click", () => {
      const rows = Array.isArray(_lastData?.items) ? _lastData.items : [];
      const total = _viewMode === "grouped" ? buildGroups(rows).length : rows.length;
      _visibleCount = _visibleCount >= total ? 8 : Math.min(total, _visibleCount + 8);
      renderRows();
    });

    byId("bfTabs")?.querySelectorAll(".bf-tab").forEach(btn => {
      btn.addEventListener("click", async () => {
        const v = btn.getAttribute("data-bf-tab") || "a_traiter";
        if (byId("bfStatutSelect")) byId("bfStatutSelect").value = v;
        await refresh();
      });
    });

    document.addEventListener("click", (e) => {
      const target = e.target;
      if (!target || typeof target.closest !== "function") return;

      if (target.closest("[data-bf-demand-close]")) {
        closeDemandModal();
        return;
      }

      const detailPanel = byId("bfDetailPanel");
      if (!detailPanel?.classList.contains("is-open")) return;
      if (target.closest("#bfDetailPanel")) return;
      if (target.closest("[data-bf-view]")) return;
      renderDetail(null);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && byId("bfDemandModal")?.classList.contains("show")) {
        closeDemandModal();
        return;
      }
      if (e.key === "Escape" && byId("bfDetailPanel")?.classList.contains("is-open")) {
        renderDetail(null);
      }
    });
  }

  window.SkillsBesoinsFormations = {
    onShow: async (portal) => {
      _portal = portal;
      try {
        bindOnce();
        if (!_servicesLoaded) await loadServices(portal);
        restoreFilters();
        await loadRefs();
        await refresh();
      } catch (e) {
        setMsg("Erreur Demandes RH : " + errMsg(e), "error");
        console.error(e);
      }
    }
  };
})();
