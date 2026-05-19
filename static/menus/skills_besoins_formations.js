/* ======================================================
   static/menus/skills_besoins_formations.js
   Besoins & formations Insights
   Lecture manager : poste -> collaborateur -> compétences
   ====================================================== */
(function () {
  let _bound = false;
  let _servicesLoaded = false;
  let _portal = null;
  let _lastData = null;
  let _loading = false;

  const STORE_SERVICE = "sb_bf_service";
  const STORE_STATUT = "sb_bf_statut";
  const STORE_FRAG = "sb_bf_fragilite_min";
  const STORE_CRIT = "sb_bf_criticite_min";

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

  function clampInt(v, min, max, defv) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return defv;
    return Math.max(min, Math.min(max, n));
  }

  function setText(id, value, fallback = "—") {
    const el = byId(id);
    if (!el) return;
    el.textContent = (value === null || value === undefined || value === "") ? fallback : String(value);
  }

  function setMsg(text, type) {
    const el = byId("bfActionMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "bf-action-msg" + (type ? " bf-action-msg--" + type : "");
    if (text && type === "success") {
      window.setTimeout(() => {
        if (el.textContent === text) el.textContent = "";
      }, 5000);
    }
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
      statut: (byId("bfStatutSelect")?.value || "tous").trim(),
      fragilite_min: clampInt(byId("bfFragiliteRange")?.value, 0, 100, 0),
      criticite_min: clampInt(byId("bfCriticiteRange")?.value, 0, 100, 70)
    };
  }

  function saveFilters() {
    const f = getFilters();
    localStorage.setItem(STORE_SERVICE, getRawService());
    localStorage.setItem(STORE_STATUT, f.statut);
    localStorage.setItem(STORE_FRAG, String(f.fragilite_min));
    localStorage.setItem(STORE_CRIT, String(f.criticite_min));
  }

  function applyFilterLabels() {
    setText("bfFragiliteValue", byId("bfFragiliteRange")?.value || "0", "0");
    setText("bfCriticiteValue", byId("bfCriticiteRange")?.value || "70", "70");
  }

  function restoreFilters() {
    const statut = (localStorage.getItem(STORE_STATUT) || "tous").trim();
    const frag = clampInt(localStorage.getItem(STORE_FRAG), 0, 100, 0);
    const crit = clampInt(localStorage.getItem(STORE_CRIT), 0, 100, 70);

    const selStatut = byId("bfStatutSelect");
    if (selStatut && Array.from(selStatut.options).some(o => o.value === statut)) selStatut.value = statut;

    const rFrag = byId("bfFragiliteRange");
    if (rFrag) rFrag.value = String(frag);

    const rCrit = byId("bfCriticiteRange");
    if (rCrit) rCrit.value = String(crit);

    const selService = byId("bfServiceSelect");
    const storedService = (localStorage.getItem(STORE_SERVICE) || "").trim();
    if (selService && storedService) {
      const exists = Array.from(selService.options || []).some(o => String(o.value || "") === storedService);
      if (exists) selService.value = storedService;
    }

    applyFilterLabels();
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

  function priorityRank(p) {
    const s = (p || "").toString().toLowerCase();
    if (s.includes("urgent")) return 4;
    if (s.includes("sécur") || s.includes("secur")) return 3;
    if (s.includes("anticip")) return 2;
    return 1;
  }

  function priorityClass(p) {
    const r = priorityRank(p);
    if (r === 4) return "bf-prio--urgent";
    if (r === 3) return "bf-prio--secure";
    if (r === 2) return "bf-prio--anticipate";
    return "bf-prio--watch";
  }

  function statutClass(statut) {
    const s = (statut || "").toString();
    if (s === "a_envoyer") return "sb-badge--warning";
    if (s === "envoye_studio") return "sb-badge--info";
    if (s === "pris_en_charge") return "sb-badge--violet";
    if (s === "traite") return "sb-badge--success";
    return "";
  }

  function renderDestination(dest) {
    const el = byId("bfDestinationText");
    if (!el) return;

    if (dest && dest.can_send) {
      el.innerHTML = `
        <span class="sb-badge sb-badge--success">Studio actif</span>
        <span>${escapeHtml(dest.nom_owner || dest.id_owner || "Studio")}</span>
        <span class="sb-badge">${escapeHtml(dest.learn_actif ? "Learn actif" : "Learn non actif")}</span>
      `;
      return;
    }

    el.innerHTML = `
      <span class="sb-badge sb-badge--danger">Envoi bloqué</span>
      <span>${escapeHtml(dest?.reason || "Aucun Studio destinataire configuré.")}</span>
    `;
  }

  function renderMiniKpis(kpis) {
    const k = kpis || {};
    const el = byId("bfMiniKpis");
    if (!el) return;
    el.innerHTML = `
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.total ?? 0)}</strong><span>besoins</span></span>
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.collaborateurs ?? 0)}</strong><span>collaborateurs</span></span>
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.postes ?? 0)}</strong><span>postes</span></span>
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.risque_5_ans ?? 0)}</strong><span>risque 5 ans</span></span>
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.formation_existante ?? 0)}</strong><span>formations connues</span></span>
    `;
  }

  function rowKey(item) {
    return `${item.id_comp || ""}@@${item.id_poste || ""}@@${item.id_effectif_concerne || ""}`;
  }

  function labelCode(item) {
    return item.code_competence || item.code || "—";
  }

  function labelCompetence(item) {
    return item.intitule_competence || item.intitule || "Compétence";
  }

  function labelCollaborateur(item) {
    return item.collaborateur_nom_complet || [item.prenom_effectif, item.nom_effectif].filter(Boolean).join(" ") || "Besoin collectif";
  }

  function labelPoste(item) {
    return item.intitule_poste || "Poste non précisé";
  }

  function groupItems(items) {
    const postes = new Map();

    (items || []).forEach(item => {
      const posteKey = item.id_poste || `poste:${labelPoste(item)}`;
      if (!postes.has(posteKey)) {
        postes.set(posteKey, {
          key: posteKey,
          title: labelPoste(item),
          code_poste: item.code_poste || "",
          service: item.nom_service || "Service non précisé",
          items: [],
          people: new Map(),
          score: 0,
          priority: item.priorite || "À surveiller"
        });
      }

      const poste = postes.get(posteKey);
      poste.items.push(item);
      poste.score = Math.max(poste.score, num(item.score_anticipation || item.indice_fragilite));
      if (priorityRank(item.priorite) > priorityRank(poste.priority)) poste.priority = item.priorite;

      const personKey = item.id_effectif_concerne || `collectif:${posteKey}`;
      if (!poste.people.has(personKey)) {
        poste.people.set(personKey, {
          key: personKey,
          title: labelCollaborateur(item),
          type: item.id_effectif_concerne ? "individuel" : "collectif",
          items: [],
          score: 0,
          priority: item.priorite || "À surveiller"
        });
      }
      const person = poste.people.get(personKey);
      person.items.push(item);
      person.score = Math.max(person.score, num(item.score_anticipation || item.indice_fragilite));
      if (priorityRank(item.priorite) > priorityRank(person.priority)) person.priority = item.priorite;
    });

    return Array.from(postes.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.title.localeCompare(b.title);
    });
  }

  function formationBadge(item) {
    const n = num(item.nb_formations_existantes);
    if (n > 0) return `<span class="sb-badge sb-badge--success">${n} formation${n > 1 ? "s" : ""}</span>`;
    return `<span class="sb-badge">À vérifier</span>`;
  }

  function levelHtml(item) {
    const current = item.niveau_actuel || "Non évalué";
    const expected = item.niveau_requis || item.niveau_attendu || "—";
    return `
      <span class="bf-level"><span>Actuel</span><strong>${escapeHtml(current)}</strong></span>
      <span class="bf-level"><span>Attendu</span><strong>${escapeHtml(expected)}</strong></span>
    `;
  }

  function indicatorHtml(item) {
    const score = num(item.score_anticipation || item.indice_fragilite);
    const crit = num(item.criticite);
    const future = num(item.nb_sorties_prevues) + num(item.nb_retraites_estimees);
    const indispo = num(item.nb_indispos_actuelles) + num(item.collaborateur_indisponible);
    const parts = [
      `<span class="bf-chip">Score ${score}%</span>`,
      `<span class="bf-chip">Crit. ${crit}</span>`
    ];
    if (future > 0) parts.push(`<span class="bf-chip bf-chip--warn">Risque 5 ans ${future}</span>`);
    if (indispo > 0) parts.push(`<span class="bf-chip bf-chip--danger">Indispo</span>`);
    if (item.is_signal_actuel === false) parts.push(`<span class="bf-chip">Historisé</span>`);
    return parts.join("");
  }

  function renderNeedRow(item, canSend) {
    const isSendable = canSend && item.statut === "a_envoyer";
    return `
      <div class="bf-need-row" data-bf-key="${escapeHtml(rowKey(item))}" data-id-comp="${escapeHtml(item.id_comp || "")}" data-id-poste="${escapeHtml(item.id_poste || "")}" data-id-effectif="${escapeHtml(item.id_effectif_concerne || "")}">
        <div class="bf-need-check"><input type="checkbox" class="bf-row-check" ${isSendable ? "" : "disabled"}></div>
        <div class="bf-need-content">
          <div class="bf-need-titleline">
            <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(labelCode(item))}</span>
            <strong>${escapeHtml(labelCompetence(item))}</strong>
          </div>
          <div class="bf-need-detail">
            <span>${escapeHtml(item.motif_priorite || "À analyser")}</span>
            <span class="bf-dot">•</span>
            <span>${escapeHtml(item.priorite || "À surveiller")}</span>
          </div>
        </div>
        <div class="bf-need-levels">${levelHtml(item)}</div>
        <div class="bf-need-indicators">${indicatorHtml(item)}</div>
        <div class="bf-need-formation">${formationBadge(item)}</div>
        <div class="bf-need-status"><span class="sb-badge ${statutClass(item.statut)}">${escapeHtml(item.statut_label || "—")}</span></div>
        <div class="bf-need-comment"><textarea class="sb-ctrl bf-comment" rows="2" placeholder="Commentaire" ${isSendable ? "" : "disabled"}>${escapeHtml(item.commentaire_client || "")}</textarea></div>
        <div class="bf-need-action"><button type="button" class="sb-btn sb-btn--xs bf-send-one" ${isSendable ? "" : "disabled"}>Envoyer</button></div>
      </div>
    `;
  }

  function renderRows(items, destination) {
    const wrap = byId("bfListWrap");
    if (!wrap) return;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      wrap.innerHTML = `<div class="bf-empty">Aucun besoin ne correspond aux filtres.</div>`;
      return;
    }

    const canSend = !!destination?.can_send;
    const postes = groupItems(list);

    wrap.innerHTML = postes.map(poste => {
      const people = Array.from(poste.people.values()).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.title.localeCompare(b.title);
      });
      const sendable = poste.items.filter(x => x.statut === "a_envoyer").length;
      const collabCount = people.filter(p => p.type === "individuel").length;
      return `
        <article class="bf-poste-card">
          <header class="bf-poste-head">
            <div class="bf-group-check"><input type="checkbox" class="bf-poste-check" ${canSend && sendable ? "" : "disabled"}></div>
            <div class="bf-poste-title">
              <div>
                ${poste.code_poste ? `<span class="sb-badge sb-badge--poste-soft">${escapeHtml(poste.code_poste)}</span>` : ""}
                <strong>${escapeHtml(poste.title)}</strong>
              </div>
              <span>${escapeHtml(poste.service)} · ${collabCount} collaborateur${collabCount > 1 ? "s" : ""} · ${poste.items.length} besoin${poste.items.length > 1 ? "s" : ""}</span>
            </div>
            <div class="bf-poste-meta">
              <span class="bf-prio ${priorityClass(poste.priority)}">${escapeHtml(poste.priority || "À surveiller")}</span>
              <span class="bf-chip">Score max ${poste.score}%</span>
            </div>
          </header>
          <div class="bf-people-list">
            ${people.map(person => `
              <section class="bf-person-card">
                <div class="bf-person-head">
                  <div class="bf-group-check"><input type="checkbox" class="bf-person-check" ${canSend && person.items.some(x => x.statut === "a_envoyer") ? "" : "disabled"}></div>
                  <div class="bf-person-title">
                    <strong>${escapeHtml(person.title)}</strong>
                    <span>${person.type === "collectif" ? "Besoin collectif / renfort à identifier" : "Collaborateur concerné"}</span>
                  </div>
                  <div class="bf-person-meta">
                    <span class="bf-chip">${person.items.length} compétence${person.items.length > 1 ? "s" : ""}</span>
                    <span class="bf-prio ${priorityClass(person.priority)}">${escapeHtml(person.priority || "À surveiller")}</span>
                  </div>
                </div>
                <div class="bf-needs-list">
                  ${person.items.map(item => renderNeedRow(item, canSend)).join("")}
                </div>
              </section>
            `).join("")}
          </div>
        </article>
      `;
    }).join("");

    bindRenderedActions(wrap);
  }

  function bindRenderedActions(wrap) {
    wrap.querySelectorAll(".bf-poste-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const card = cb.closest(".bf-poste-card");
        if (!card) return;
        card.querySelectorAll(".bf-row-check:not(:disabled), .bf-person-check:not(:disabled)").forEach(x => { x.checked = cb.checked; });
      });
    });

    wrap.querySelectorAll(".bf-person-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const card = cb.closest(".bf-person-card");
        if (!card) return;
        card.querySelectorAll(".bf-row-check:not(:disabled)").forEach(x => { x.checked = cb.checked; });
      });
    });

    wrap.querySelectorAll(".bf-send-one").forEach(btn => {
      btn.addEventListener("click", async () => {
        const row = btn.closest(".bf-need-row");
        if (!row) return;
        await sendRows([row]);
      });
    });
  }

  function render(data) {
    _lastData = data || {};
    renderDestination(_lastData.destination || {});
    renderMiniKpis(_lastData.kpis || {});

    const count = Array.isArray(_lastData.items) ? _lastData.items.length : 0;
    const scope = _lastData.scope?.nom_service || "Tous les services";
    setText("bfMeta", `${count} besoin(s) affiché(s) · ${scope}`);
    renderRows(_lastData.items || [], _lastData.destination || {});
  }

  async function refresh() {
    if (!_portal || _loading) return;
    _loading = true;
    setMsg("Chargement…", "info");
    saveFilters();
    applyFilterLabels();

    try {
      const f = getFilters();
      const qs = new URLSearchParams();
      if (f.id_service) qs.set("id_service", f.id_service);
      qs.set("statut", f.statut || "tous");
      qs.set("fragilite_min", String(f.fragilite_min));
      qs.set("criticite_min", String(f.criticite_min));
      qs.set("limit", "300");

      const data = await _portal.apiJson(`${_portal.apiBase}/skills/besoins-formations/${encodeURIComponent(_portal.contactId)}?${qs.toString()}`);
      render(data);
      setMsg("", "");
    } catch (e) {
      setMsg("Erreur système, impossible de charger les besoins.", "error");
      const wrap = byId("bfListWrap");
      if (wrap) wrap.innerHTML = `<div class="bf-empty">${escapeHtml(errMsg(e))}</div>`;
      console.error(e);
    } finally {
      _loading = false;
    }
  }

  function selectedRows() {
    const wrap = byId("bfListWrap");
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll(".bf-need-row")).filter(row => {
      const cb = row.querySelector(".bf-row-check");
      return cb && cb.checked && !cb.disabled;
    });
  }

  async function sendRows(rows) {
    if (!_portal) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      setMsg("Sélectionne au moins un besoin à envoyer.", "warning");
      return;
    }

    const payload = {
      items: list.map(row => ({
        id_comp: row.getAttribute("data-id-comp") || "",
        id_poste: row.getAttribute("data-id-poste") || null,
        id_effectif_concerne: row.getAttribute("data-id-effectif") || null,
        commentaire_client: row.querySelector(".bf-comment")?.value || ""
      })).filter(x => x.id_comp)
    };

    if (!payload.items.length) {
      setMsg("Aucun besoin exploitable dans la sélection.", "warning");
      return;
    }

    setMsg("Envoi au Studio…", "info");
    try {
      const res = await _portal.apiJson(`${_portal.apiBase}/skills/besoins-formations/${encodeURIComponent(_portal.contactId)}/envoyer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const okMsg = res?.message || "Besoin envoyé au Studio.";
      await refresh();
      setMsg(okMsg, "success");
    } catch (e) {
      setMsg(errMsg(e), "error");
      console.error(e);
    }
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;

    ["bfServiceSelect", "bfStatutSelect"].forEach(id => {
      const el = byId(id);
      if (el) el.addEventListener("change", refresh);
    });

    ["bfFragiliteRange", "bfCriticiteRange"].forEach(id => {
      const el = byId(id);
      if (el) {
        el.addEventListener("input", applyFilterLabels);
        el.addEventListener("change", refresh);
      }
    });

    const btnReset = byId("btnBfReset");
    if (btnReset) {
      btnReset.addEventListener("click", async () => {
        const selService = byId("bfServiceSelect");
        if (selService) selService.value = window.portal.serviceFilter.ALL_ID || "__ALL__";
        const selStatut = byId("bfStatutSelect");
        if (selStatut) selStatut.value = "tous";
        const frag = byId("bfFragiliteRange");
        if (frag) frag.value = "0";
        const crit = byId("bfCriticiteRange");
        if (crit) crit.value = "70";
        applyFilterLabels();
        await refresh();
      });
    }

    const btnRefresh = byId("btnBfRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", refresh);

    const btnSend = byId("btnBfSendSelected");
    if (btnSend) btnSend.addEventListener("click", async () => sendRows(selectedRows()));
  }

  window.SkillsBesoinsFormations = {
    onShow: async (portal) => {
      _portal = portal;
      try {
        bindOnce();
        if (!_servicesLoaded) await loadServices(portal);
        restoreFilters();
        await refresh();
      } catch (e) {
        setMsg("Erreur besoins & formations : " + errMsg(e), "error");
        console.error(e);
      }
    }
  };
})();