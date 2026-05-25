/* ======================================================
   static/menus/skills_besoins_formations.js
   Besoins & formations Insights
   Vue individuelle sobre : qui / quoi / délai / statut / commentaire / action
   ====================================================== */
(function () {
  let _bound = false;
  let _servicesLoaded = false;
  let _portal = null;
  let _lastData = null;
  let _loading = false;
  let _modalGroup = null;

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

  function setMsg(text, type, targetId = "bfActionMsg") {
    const el = byId(targetId);
    if (!el) return;

    const normalizedType = type === "error" ? "danger" : (type || "");
    const finalType = normalizedType === "warning" ? "info" : normalizedType;

    el.textContent = text || "";
    el.className = "sb-inline-msg";

    if (finalType) {
      el.classList.add("sb-inline-msg--" + finalType);
    }

    if (text) {
      el.classList.add("is-visible");
    } else {
      el.classList.remove("is-visible");
    }

    if (text && finalType === "success") {
      window.setTimeout(() => {
        if (el.textContent === text) {
          el.textContent = "";
          el.className = "sb-inline-msg";
        }
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

  function scoreDelay(items) {
    const maxScore = Math.max(...items.map(x => num(x.score_anticipation || x.indice_fragilite)), 0);
    if (maxScore >= 80) return "Dès que possible";
    if (maxScore >= 65) return "Sous 3 mois";
    if (maxScore >= 45) return "Sous 6 mois";
    return "Sous 12 mois";
  }

  function priorityRank(p) {
    const s = (p || "").toString().toLowerCase();
    if (s.includes("urgent")) return 4;
    if (s.includes("sécur") || s.includes("secur")) return 3;
    if (s.includes("anticip")) return 2;
    return 1;
  }

  function bestPriority(items) {
    let best = "À surveiller";
    (items || []).forEach(item => {
      if (priorityRank(item.priorite) > priorityRank(best)) best = item.priorite || best;
    });
    return best;
  }

  function statusSummary(items) {
    const list = items || [];
    if (!list.length) return { code: "a_envoyer", label: "À envoyer" };

    const statuses = new Set(list.map(x => x.statut || "a_envoyer"));
    if (statuses.size === 1) {
      const s = list[0].statut || "a_envoyer";
      return { code: s, label: list[0].statut_label || labelStatut(s) };
    }

    if (statuses.has("a_envoyer")) return { code: "a_envoyer", label: "Partiel" };
    if (statuses.has("pris_en_charge")) return { code: "pris_en_charge", label: "Pris en charge" };
    if (statuses.has("envoye_studio")) return { code: "envoye_studio", label: "Envoyé au Studio" };
    return { code: "traite", label: "Traité" };
  }

  function labelStatut(s) {
    return {
      a_envoyer: "À envoyer",
      envoye_studio: "Envoyé au Studio",
      pris_en_charge: "Pris en charge",
      traite: "Traité"
    }[s] || "—";
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
        <span class="bf-destination-label">Destination</span>
        <span class="sb-badge sb-badge--success">Studio actif</span>
        <span>${escapeHtml(dest.nom_owner || dest.id_owner || "Studio")}</span>
        <span class="sb-badge">${escapeHtml(dest.learn_actif ? "Learn actif" : "Learn non actif")}</span>
      `;
      return;
    }

    el.innerHTML = `
      <span class="bf-destination-label">Destination</span>
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
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.a_envoyer ?? 0)}</strong><span>à envoyer</span></span>
      <span class="bf-mini-kpi"><strong>${escapeHtml(k.risque_5_ans ?? 0)}</strong><span>risque 5 ans</span></span>
    `;
  }

  function labelCode(item) {
    return item.code_competence || item.code || "—";
  }

  function labelCompetence(item) {
    return item.intitule_competence || item.intitule || "Compétence";
  }

  function labelCollaborateur(item) {
    return item.collaborateur_nom_complet || [item.prenom_effectif, item.nom_effectif].filter(Boolean).join(" ") || "Collaborateur";
  }

  function labelPoste(item) {
    return item.intitule_poste || "Poste non précisé";
  }

  function groupByCollaborateur(items) {
    const map = new Map();

    (items || []).forEach(item => {
      const key = item.id_effectif_concerne || `collab:${labelCollaborateur(item)}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          id_effectif_concerne: item.id_effectif_concerne || "",
          nom: labelCollaborateur(item),
          poste: labelPoste(item),
          service: item.nom_service || "",
          items: [],
        });
      }
      map.get(key).items.push(item);
    });

    return Array.from(map.values()).sort((a, b) => a.nom.localeCompare(b.nom));
  }

  function commentSummary(items) {
    const txt = (items || [])
      .map(x => x.commentaire_manager || x.commentaire_client || "")
      .find(x => String(x || "").trim());
    return txt || "—";
  }

  function skillsSummary(items) {
    const list = (items || []).slice(0, 3);
    const html = list.map(item => `
      <span class="bf-skill-chip" title="${escapeHtml(labelCompetence(item))}">
        ${escapeHtml(labelCode(item))} · ${escapeHtml(labelCompetence(item))}
      </span>
    `).join("");

    const more = (items || []).length > 3
      ? `<span class="bf-skill-more">+${items.length - 3}</span>`
      : "";

    return html + more;
  }

  function renderRows(items, destination) {
    const wrap = byId("bfListWrap");
    if (!wrap) return;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      wrap.innerHTML = `<div class="bf-empty">Aucun besoin individuel ne correspond aux filtres.</div>`;
      return;
    }

    const canSend = !!destination?.can_send;
    const groups = groupByCollaborateur(list);

    wrap.innerHTML = groups.map(group => {
      const st = statusSummary(group.items);
      const sendableCount = group.items.filter(x => x.statut === "a_envoyer").length;
      const delay = scoreDelay(group.items);
      const prio = bestPriority(group.items);
      const actionDisabled = !canSend || sendableCount <= 0;
      const comment = commentSummary(group.items);

      return `
        <article class="bf-person-card" data-bf-group="${escapeHtml(group.key)}">
          <button type="button" class="bf-person-row bf-accordion-toggle" aria-expanded="false">
            <div class="bf-cell bf-cell--who">
              <div class="bf-person-name">${escapeHtml(group.nom)}</div>
              <div class="bf-person-poste">${escapeHtml(group.poste)}</div>
            </div>

            <div class="bf-cell bf-cell--need">
              <div class="bf-need-count">${group.items.length} compétence${group.items.length > 1 ? "s" : ""} à renforcer</div>
              <div class="bf-need-preview">Voir le détail des compétences</div>
            </div>

            <div class="bf-cell bf-cell--delay">
              <span class="bf-delay">${escapeHtml(delay)}</span>
              <span class="bf-prio">${escapeHtml(prio)}</span>
            </div>

            <div class="bf-cell bf-cell--status">
              <span class="sb-badge ${statutClass(st.code)}">${escapeHtml(st.label)}</span>
            </div>

            <div class="bf-cell bf-cell--comment" title="${escapeHtml(comment)}">
              ${escapeHtml(comment)}
            </div>

            <div class="bf-cell bf-cell--action">
              <span class="bf-accordion-icon">⌄</span>
            </div>
          </button>

          <div class="bf-accordion-panel" hidden>
            <div class="bf-accordion-inner">
              <div class="bf-competence-list">
                ${group.items.map(item => `
                  <div class="bf-competence-line">
                    <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(labelCode(item))}</span>
                    <span>${escapeHtml(labelCompetence(item))}</span>
                  </div>
                `).join("")}
              </div>

              <div class="bf-accordion-actions">
                <button type="button" class="sb-btn sb-btn--accent bf-send-btn" ${actionDisabled ? "disabled" : ""}>
                  Préparer l’envoi
                </button>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join("");

    wrap.querySelectorAll(".bf-accordion-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".bf-person-card");
        if (!card) return;

        const panel = card.querySelector(".bf-accordion-panel");
        const icon = card.querySelector(".bf-accordion-icon");
        const isOpen = btn.getAttribute("aria-expanded") === "true";

        btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
        if (panel) panel.hidden = isOpen;
        if (icon) icon.textContent = isOpen ? "⌄" : "⌃";
      });
    });

    wrap.querySelectorAll(".bf-send-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".bf-person-card");
        const group = card ? groups.find(g => g.key === card.getAttribute("data-bf-group")) : null;
        if (group) openSendModal(group, true);
      });
    });
  }

  function levelLabel(v) {
    return v || "Non évalué";
  }

  function competenceDetailHtml(item, allowCheck) {
    const checked = item.statut === "a_envoyer" ? "checked" : "";
    const disabled = item.statut === "a_envoyer" && allowCheck ? "" : "disabled";
    const risk5 = num(item.nb_sorties_prevues) + num(item.nb_retraites_estimees);
    const formation = num(item.nb_formations_existantes) > 0
      ? `${num(item.nb_formations_existantes)} formation${num(item.nb_formations_existantes) > 1 ? "s" : ""} connue${num(item.nb_formations_existantes) > 1 ? "s" : ""}`
      : "Formation à vérifier";

    return `
      <div class="bf-comp-row" data-id-comp="${escapeHtml(item.id_comp || "")}" data-id-poste="${escapeHtml(item.id_poste || "")}" data-id-effectif="${escapeHtml(item.id_effectif_concerne || "")}">
        <label class="bf-comp-check">
          <input type="checkbox" class="bf-comp-select" ${checked} ${disabled}>
        </label>

        <div class="bf-comp-main">
          <div class="bf-comp-title">
            <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(labelCode(item))}</span>
            <strong>${escapeHtml(labelCompetence(item))}</strong>
          </div>
          <div class="bf-comp-sub">${escapeHtml(item.motif_priorite || "Besoin détecté")}</div>
        </div>

        <div class="bf-comp-levels">
          <span><small>Actuel</small><strong>${escapeHtml(levelLabel(item.niveau_actuel))}</strong></span>
          <span><small>Attendu</small><strong>${escapeHtml(item.niveau_requis || item.niveau_attendu || "—")}</strong></span>
        </div>

        <div class="bf-comp-meta">
          <span>Score ${escapeHtml(item.score_anticipation || item.indice_fragilite || 0)}%</span>
          <span>Crit. ${escapeHtml(item.criticite || 0)}</span>
          ${risk5 > 0 ? `<span>Risque 5 ans</span>` : ""}
          <span>${escapeHtml(formation)}</span>
          <span>${escapeHtml(item.statut_label || "À envoyer")}</span>
        </div>
      </div>
    `;
  }

  function openSendModal(group, sendMode) {
    _modalGroup = group;

    const modal = byId("bfSendModal");
    if (!modal) return;

    const sendable = group.items.filter(x => x.statut === "a_envoyer");
    const selectedItems = sendMode ? sendable : group.items;
    const defaultDelay = scoreDelay(group.items);
    const existingComment = commentSummary(group.items);
    const comment = existingComment === "—" ? "" : existingComment;

    setText("bfModalTitle", sendMode ? "Préparer l’envoi au Studio" : "Détail du besoin collaborateur");
    setText("bfModalSub", `${group.nom} · ${group.poste}`);

    const compWrap = byId("bfModalCompetences");
    if (compWrap) {
      compWrap.innerHTML = selectedItems.map(item => competenceDetailHtml(item, sendMode)).join("");
    }

    const delai = byId("bfModalDelai");
    if (delai) delai.value = Array.from(delai.options).some(o => o.value === defaultDelay) ? defaultDelay : "Sous 6 mois";

    const periode = byId("bfModalPeriode");
    if (periode) periode.value = "";

    const precision = byId("bfModalPrecision");
    if (precision) precision.value = "";

    const commentaire = byId("bfModalCommentaire");
    if (commentaire) commentaire.value = comment;

    modal.querySelectorAll(".bf-check-list input[type='checkbox']").forEach(cb => { cb.checked = false; });
    setMsg("", "", "bfModalMsg");

    const confirm = byId("btnBfConfirmSend");
    if (confirm) confirm.style.display = sendMode ? "" : "none";

    modal.classList.add("show");
  }

  function closeModal() {
    const modal = byId("bfSendModal");
    if (modal) modal.classList.remove("show");
    _modalGroup = null;
  }

  function selectedModalItems() {
    const modal = byId("bfSendModal");
    if (!modal) return [];

    return Array.from(modal.querySelectorAll(".bf-comp-row")).filter(row => {
      const cb = row.querySelector(".bf-comp-select");
      return cb && cb.checked && !cb.disabled;
    }).map(row => ({
      id_comp: row.getAttribute("data-id-comp") || "",
      id_poste: row.getAttribute("data-id-poste") || null,
      id_effectif_concerne: row.getAttribute("data-id-effectif") || null,
    })).filter(x => x.id_comp && x.id_effectif_concerne);
  }

  async function confirmModalSend() {
    if (!_portal || !_modalGroup) return;

    const items = selectedModalItems();
    if (!items.length) {
      setMsg("Aucune compétence sélectionnée.", "warning", "bfModalMsg");
      return;
    }

    const modal = byId("bfSendModal");
    const modalites = modal
      ? Array.from(modal.querySelectorAll(".bf-check-list input[type='checkbox']:checked")).map(cb => cb.value)
      : [];

    const payload = {
      items,
      delai_souhaite: byId("bfModalDelai")?.value || "",
      periode_souhaitee: byId("bfModalPeriode")?.value || "",
      precision_periode: byId("bfModalPrecision")?.value || "",
      modalites_souhaitees: modalites,
      commentaire_manager: byId("bfModalCommentaire")?.value || ""
    };

    setMsg("Envoi au Studio…", "info", "bfModalMsg");

    try {
      const res = await _portal.apiJson(`${_portal.apiBase}/skills/besoins-formations/${encodeURIComponent(_portal.contactId)}/envoyer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      closeModal();
      await refresh();
      setMsg(res?.message || "Besoin envoyé au Studio.", "success");
    } catch (e) {
      setMsg(errMsg(e), "error", "bfModalMsg");
      console.error(e);
    }
  }

  function render(data) {
    _lastData = data || {};
    renderDestination(_lastData.destination || {});
    renderMiniKpis(_lastData.kpis || {});

    const count = Array.isArray(_lastData.items) ? _lastData.items.length : 0;
    const scope = _lastData.scope?.nom_service || "Tous les services";
    setText("bfMeta", `${count} besoin(s) individuel(s) affiché(s) · ${scope}`);
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

    const btnConfirm = byId("btnBfConfirmSend");
    if (btnConfirm) btnConfirm.addEventListener("click", confirmModalSend);

    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest("[data-bf-close]")) closeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && byId("bfSendModal")?.classList.contains("show")) closeModal();
    });
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