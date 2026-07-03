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
  let _selectedItem = null;
  let _modalMode = "create";
  let _modalItem = null;
  let _searchTimer = null;

  const STORE_SERVICE = "sb_bf_service";
  const STORE_STATUT = "sb_bf_statut";
  const STORE_ORIGIN = "sb_bf_origine";
  const STORE_TYPE = "sb_bf_type";
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
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24"`;
    const map = {
      eye: `<svg ${attrs}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>`,
      edit: `<svg ${attrs}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
      send: `<svg ${attrs}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
      check: `<svg ${attrs}><path d="M20 6 9 17l-5-5"/></svg>`,
      close: `<svg ${attrs}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
      pdf: `<svg ${attrs}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 15h1"/><path d="M12 15h4"/></svg>`
    };
    return map[name] || "";
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
      type_demande: (byId("bfTypeSelect")?.value || "tous").trim(),
      priorite: (byId("bfPrioritySelect")?.value || "toutes").trim(),
      q: (byId("bfSearchInput")?.value || "").trim()
    };
  }

  function saveFilters() {
    const f = getFilters();
    localStorage.setItem(STORE_SERVICE, getRawService());
    localStorage.setItem(STORE_STATUT, f.statut);
    localStorage.setItem(STORE_ORIGIN, f.origine);
    localStorage.setItem(STORE_TYPE, f.type_demande);
    localStorage.setItem(STORE_PRIORITY, f.priorite);
  }

  function restoreFilters() {
    const map = [
      ["bfStatutSelect", STORE_STATUT, "a_traiter"],
      ["bfOriginSelect", STORE_ORIGIN, "tous"],
      ["bfTypeSelect", STORE_TYPE, "tous"],
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
      ? `<span class="sb-badge sb-badge--warning">Migration SQL à appliquer</span>`
      : "";
    if (dest && dest.can_send) {
      el.innerHTML = `
        <span class="bf-destination-label">Destination</span>
        <span class="sb-badge sb-badge--success">Studio actif</span>
        <span>${escapeHtml(dest.nom_owner || dest.id_owner || "Studio")}</span>
        ${dbBadge}
      `;
      return;
    }
    el.innerHTML = `
      <span class="bf-destination-label">Destination</span>
      <span class="sb-badge sb-badge--danger">Envoi bloqué</span>
      <span>${escapeHtml(dest?.reason || "Aucun Studio destinataire configuré.")}</span>
      ${dbBadge}
    `;
  }

  function renderKpis(kpis) {
    const values = [
      ["À qualifier", kpis?.a_qualifier ?? 0, "bf-kpi-icon--red", "?"],
      ["À valider", kpis?.a_valider ?? 0, "bf-kpi-icon--orange", "✓"],
      ["Transmises au Studio", kpis?.transmise_studio ?? 0, "bf-kpi-icon--violet", "↗"],
      ["Actions créées", kpis?.action_creee ?? 0, "bf-kpi-icon--green", "✓"],
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

  function typeLabel(v) {
    return {
      formation: "Formation",
      transmission: "Transmission",
      renfort: "Renfort",
      recrutement: "Recrutement",
      mobilite: "Mobilité",
      tutorat: "Tutorat",
      entretien: "Entretien",
      documentation: "Documentation",
      organisation: "Organisation",
      autre: "Autre"
    }[v] || "Demande";
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
      tous: kpis?.total ?? 0
    };
    byId("bfTabs")?.querySelectorAll(".bf-tab").forEach(btn => {
      const v = btn.getAttribute("data-bf-tab") || "";
      btn.classList.toggle("is-active", (byId("bfStatutSelect")?.value || "a_traiter") === v);
      const strong = btn.querySelector("strong");
      if (strong) strong.textContent = String(counts[v] ?? 0);
    });
  }

  function actionButtonHtml(item) {
    const id = item.id_demande_rh || "";
    if (item.statut === "a_valider" && id) {
      return `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-bf-status="validee" data-id="${escapeHtml(id)}">Valider</button>`;
    }
    if (item.statut === "validee" && id && item.type_demande === "formation") {
      return `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-bf-transmit="${escapeHtml(id)}">Transmettre</button>`;
    }
    if (item.statut === "validee") {
      return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-follow="1">Plan d’action</button>`;
    }
    if (item.statut === "transmise_studio" || item.statut === "prise_en_charge" || item.statut === "action_creee") {
      return `<button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-bf-follow="1">Voir le suivi</button>`;
    }
    return `<button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-bf-edit="${escapeHtml(id)}">Qualifier</button>`;
  }

  function renderRows() {
    const wrap = byId("bfListWrap");
    if (!wrap) return;
    const rows = Array.isArray(_lastData?.items) ? _lastData.items : [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="bf-empty">Aucune demande RH ne correspond aux filtres.</div>`;
      byId("btnBfShowMore").style.display = "none";
      renderDetail(null);
      return;
    }

    const visible = rows.slice(0, _visibleCount);
    wrap.innerHTML = `
      <div class="bf-table">
        <div class="bf-table-row bf-table-row--head">
          <div>Collaborateur</div>
          <div>Origine</div>
          <div>Type</div>
          <div>Objet</div>
          <div>Statut</div>
          <div>Échéance</div>
          <div>Actions</div>
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
            <div><span class="bf-badge ${badgeClass("origin", item.origine)}">${escapeHtml(originLabel(item.origine))}</span></div>
            <div><span class="bf-badge ${badgeClass("type", item.type_demande)}">${escapeHtml(typeLabel(item.type_demande))}</span></div>
            <div class="bf-object">
              <strong>${escapeHtml(item.objet || "Demande RH")}</strong>
              <small>${escapeHtml(item.intitule_competence || item.description || "À qualifier")}</small>
            </div>
            <div><span class="bf-badge ${badgeClass("statut", item.statut)}">${escapeHtml(item.statut_label || "À qualifier")}</span></div>
            <div class="bf-date"><span>${escapeHtml(echeanceLabel(item))}</span><small>${escapeHtml(priorityLabel(item.priorite))}</small></div>
            <div class="bf-row-actions">
              <button type="button" class="sb-icon-btn" data-bf-view="${idx}" title="Voir le détail" aria-label="Voir le détail">${icon("eye")}</button>
              <button type="button" class="sb-icon-btn" data-bf-edit="${escapeHtml(item.id_demande_rh || "")}" data-bf-index="${idx}" title="Qualifier" aria-label="Qualifier">${icon("edit")}</button>
              ${actionButtonHtml(item)}
            </div>
          </div>
        `).join("")}
      </div>
    `;

    const more = byId("btnBfShowMore");
    if (more) {
      more.style.display = rows.length > 8 ? "" : "none";
      more.textContent = _visibleCount >= rows.length ? "Voir moins" : "Voir plus";
    }

    bindRowActions();
    renderDetail(_selectedItem || visible[0] || null);
  }

  function bindRowActions() {
    const wrap = byId("bfListWrap");
    if (!wrap) return;
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
    setText("bfDetailSub", `${item.collaborateur_nom_complet || "Demande collective"} · ${typeLabel(item.type_demande)}`);
    const canValidate = item.id_demande_rh && item.statut === "a_valider";
    const canTransmit = item.id_demande_rh && item.statut === "validee" && item.type_demande === "formation";
    body.innerHTML = `
      <div class="bf-detail-section">
        <div class="bf-detail-topline">
          <span class="bf-badge ${badgeClass("statut", item.statut)}">${escapeHtml(item.statut_label || "À qualifier")}</span>
          <span class="bf-badge ${badgeClass("origin", item.origine)}">${escapeHtml(originLabel(item.origine))}</span>
          <span class="bf-badge ${badgeClass("type", item.type_demande)}">${escapeHtml(typeLabel(item.type_demande))}</span>
        </div>
        <h3>${escapeHtml(item.objet || "Demande RH")}</h3>
        <p>${escapeHtml(item.description || "Aucune justification détaillée pour le moment.")}</p>
      </div>

      <div class="bf-detail-section">
        <h4>Collaborateur</h4>
        <div class="bf-detail-person">
          <span class="bf-avatar">${escapeHtml(initials(item.collaborateur_nom_complet))}</span>
          <div><strong>${escapeHtml(item.collaborateur_nom_complet || "Demande collective")}</strong><small>${escapeHtml(item.intitule_poste || "Poste non précisé")} · ${escapeHtml(item.nom_service || "Service non précisé")}</small></div>
        </div>
      </div>

      <div class="bf-detail-section">
        <h4>Compétence ou sujet concerné</h4>
        <div class="bf-detail-chips">
          ${item.code_competence ? `<span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(item.code_competence)}</span>` : ""}
          <span>${escapeHtml(item.intitule_competence || "Aucune compétence directement rattachée")}</span>
        </div>
      </div>

      <div class="bf-detail-grid">
        <div><span>Priorité</span><strong>${escapeHtml(priorityLabel(item.priorite))}</strong></div>
        <div><span>Échéance</span><strong>${escapeHtml(echeanceLabel(item))}</strong></div>
        <div><span>Score</span><strong>${escapeHtml(item.score_anticipation || 0)}%</strong></div>
        <div><span>Criticité</span><strong>${escapeHtml(item.criticite || 0)}</strong></div>
      </div>

      <div class="bf-detail-section">
        <h4>Commentaires</h4>
        <p>${escapeHtml(item.commentaire_manager || item.commentaire_salarie || item.commentaire_client || "Aucun commentaire renseigné.")}</p>
      </div>

      <div class="bf-detail-actions">
        <button type="button" class="sb-btn sb-btn--soft" id="btnBfDetailEdit">${icon("edit", 15)}<span>Qualifier</span></button>
        ${canValidate ? `<button type="button" class="sb-btn sb-btn--accent" id="btnBfDetailValidate">${icon("check", 15)}<span>Valider</span></button>` : ""}
        ${canTransmit ? `<button type="button" class="sb-btn sb-btn--accent" id="btnBfDetailTransmit">${icon("send", 15)}<span>Transmettre</span></button>` : ""}
      </div>
    `;
    byId("btnBfDetailEdit")?.addEventListener("click", () => openDemandModal(item, "qualify"));
    byId("btnBfDetailValidate")?.addEventListener("click", () => changeStatus(item.id_demande_rh, "validee"));
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

  function openDemandModal(item, mode) {
    _modalMode = mode || "create";
    _modalItem = item || null;
    populateDemandRefs();

    const isCreate = !_modalItem;
    setText("bfDemandModalTitle", isCreate ? "Créer une demande RH" : "Qualifier la demande RH");
    setText("bfDemandModalSub", isCreate ? "Demande manager, renfort, mobilité, transmission ou formation." : `${_modalItem.collaborateur_nom_complet || "Demande collective"} · ${originLabel(_modalItem.origine)}`);

    const eff = byId("bfDemandEffectif");
    if (eff) eff.value = _modalItem?.id_effectif_concerne || "";
    const comp = byId("bfDemandCompetence");
    if (comp) comp.value = _modalItem?.id_comp || "";
    const type = byId("bfDemandType");
    if (type) type.value = _modalItem?.type_demande || "formation";
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

    const modalites = new Set(_modalItem?.modalites_souhaitees || []);
    byId("bfDemandModalites")?.querySelectorAll("input[type='checkbox']").forEach(cb => {
      cb.checked = modalites.has(cb.value);
    });
    setMsg("", "", "bfDemandModalMsg");
    byId("bfDemandModal")?.classList.add("show");
  }

  function closeDemandModal() {
    byId("bfDemandModal")?.classList.remove("show");
    _modalMode = "create";
    _modalItem = null;
  }

  function collectDemandPayload() {
    const modalites = Array.from(byId("bfDemandModalites")?.querySelectorAll("input[type='checkbox']:checked") || []).map(cb => cb.value);
    const isSignal = _modalItem && !_modalItem.id_demande_rh;
    const statut = _modalItem ? "a_valider" : "a_qualifier";
    return {
      id_effectif_concerne: byId("bfDemandEffectif")?.value || _modalItem?.id_effectif_concerne || null,
      id_comp: byId("bfDemandCompetence")?.value || _modalItem?.id_comp || null,
      id_poste: _modalItem?.id_poste || null,
      origine: isSignal ? (_modalItem.origine || "analyse") : (_modalItem?.origine || "manager"),
      source_type: isSignal ? (_modalItem.source_type || "analyse_competences") : (_modalItem?.source_type || "manager"),
      source_ref: _modalItem?.source_ref || _modalItem?.id_demande_rh || null,
      type_demande: byId("bfDemandType")?.value || "formation",
      objet: byId("bfDemandObjet")?.value || _modalItem?.objet || "Demande RH à qualifier",
      description: byId("bfDemandDescription")?.value || _modalItem?.description || "",
      statut,
      priorite: byId("bfDemandPriority")?.value || "normale",
      delai_souhaite: byId("bfDemandDelai")?.value || "",
      echeance_souhaitee: byId("bfDemandEcheance")?.value || null,
      modalites_souhaitees: modalites,
      commentaire_manager: byId("bfDemandCommentaire")?.value || "",
      niveau_attendu: _modalItem?.niveau_attendu || null,
      niveau_actuel: _modalItem?.niveau_actuel || null,
      ecart_niveau: _modalItem?.ecart_niveau || 0,
      criticite: _modalItem?.criticite || 0,
      score_anticipation: _modalItem?.score_anticipation || 0,
      payload_signal: _modalItem?.payload_signal || {}
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
      renderDetail(data?.item || null);
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
      renderDetail(data?.item || null);
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
      renderDetail(data?.item || null);
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
        type_demande: f.type_demande,
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

    ["bfServiceSelect", "bfStatutSelect", "bfOriginSelect", "bfTypeSelect", "bfPrioritySelect"].forEach(id => {
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
      if (byId("bfTypeSelect")) byId("bfTypeSelect").value = "tous";
      if (byId("bfPrioritySelect")) byId("bfPrioritySelect").value = "toutes";
      if (byId("bfSearchInput")) byId("bfSearchInput").value = "";
      await loadRefs();
      await refresh();
    });

    byId("btnBfRefresh")?.addEventListener("click", refresh);
    byId("btnBfCreateDemand")?.addEventListener("click", () => openDemandModal(null, "create"));
    byId("btnBfSaveDemand")?.addEventListener("click", saveDemandFromModal);
    byId("btnBfCloseDetail")?.addEventListener("click", () => renderDetail(null));

    byId("btnBfShowMore")?.addEventListener("click", () => {
      const total = (_lastData?.items || []).length;
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
      if (e.target && e.target.closest("[data-bf-demand-close]")) closeDemandModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && byId("bfDemandModal")?.classList.contains("show")) closeDemandModal();
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
