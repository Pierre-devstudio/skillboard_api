/* ======================================================
   static/menus/skills_besoins_formations.js
   - Besoins & formations Insights
   - MVP: signaux dynamiques -> demande envoyée Studio
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

  function priorityClass(p) {
    const s = (p || "").toString().toLowerCase();
    if (s.includes("urgent")) return "bf-prio--urgent";
    if (s.includes("sécur") || s.includes("secur")) return "bf-prio--secure";
    if (s.includes("anticip")) return "bf-prio--anticipate";
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

  function num(v) {
    const n = Number(v || 0);
    return isNaN(n) ? 0 : n;
  }

  function renderDestination(dest) {
    const el = byId("bfDestinationText");
    if (!el) return;

    if (dest && dest.can_send) {
      const learn = dest.learn_actif ? "Learn actif" : "Learn non actif";
      el.innerHTML = `
        <span class="sb-badge sb-badge--success">Studio actif</span>
        <span>${escapeHtml(dest.nom_owner || dest.id_owner || "Studio")}</span>
        <span class="sb-badge">${escapeHtml(learn)}</span>
      `;
      return;
    }

    el.innerHTML = `
      <span class="sb-badge sb-badge--danger">Envoi bloqué</span>
      <span>${escapeHtml(dest?.reason || "Aucun Studio destinataire configuré.")}</span>
    `;
  }

  function renderKpis(kpis) {
    const k = kpis || {};
    setText("bfKpiAEnvoyer", k.a_envoyer ?? 0, "0");
    setText("bfKpiEnvoyes", k.envoye_studio ?? 0, "0");
    setText("bfKpiFormation", k.formation_existante ?? 0, "0");
    setText("bfKpi5Ans", k.risque_5_ans ?? 0, "0");
  }

  function rowKey(item) {
    return `${item.id_comp || ""}@@${item.id_poste || ""}`;
  }

  function indicatorHtml(item) {
    const score = num(item.score_anticipation || item.indice_fragilite);
    const crit = num(item.criticite);
    const toTrain = item.nb_personnes_a_former;
    const titulaire = item.nb_titulaires_poste;
    const future = num(item.nb_sorties_prevues) + num(item.nb_retraites_estimees);
    const indispo = num(item.nb_indispos_actuelles);

    const parts = [
      `<span class="sb-badge">Score ${score}%</span>`,
      `<span class="sb-badge">Crit. ${crit}</span>`
    ];

    if (toTrain !== null && toTrain !== undefined) {
      parts.push(`<span class="sb-badge">À former ${escapeHtml(toTrain)}/${escapeHtml(titulaire ?? "—")}</span>`);
    }
    if (future > 0) parts.push(`<span class="sb-badge sb-badge--warning">Risque 5 ans ${future}</span>`);
    if (indispo > 0) parts.push(`<span class="sb-badge sb-badge--danger">Indispo ${indispo}</span>`);
    if (item.is_signal_actuel === false) parts.push(`<span class="sb-badge">Signal historisé</span>`);

    return `<div class="bf-badges">${parts.join("")}</div>`;
  }

  function renderRows(items, destination) {
    const wrap = byId("bfTableWrap");
    if (!wrap) return;

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      wrap.innerHTML = `<div class="card-sub">Aucun besoin ne correspond aux filtres.</div>`;
      return;
    }

    const canSend = !!destination?.can_send;

    wrap.innerHTML = `
      <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover bf-table">
        <thead>
          <tr>
            <th style="width:34px;"><input type="checkbox" id="bfCheckAll" ${canSend ? "" : "disabled"}></th>
            <th>Besoin</th>
            <th>Qui ?</th>
            <th>Priorité</th>
            <th>Indicateurs</th>
            <th>Formation</th>
            <th>Statut</th>
            <th>Commentaire</th>
            <th style="width:110px;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((item) => {
            const key = rowKey(item);
            const isSendable = canSend && item.statut === "a_envoyer";
            const code = item.code || "—";
            const comp = item.intitule || "Compétence";
            const poste = item.intitule_poste || "Poste non précisé";
            const niv = item.niveau_requis ? `Niveau attendu ${item.niveau_requis}` : "Niveau attendu non précisé";
            const formCount = num(item.nb_formations_existantes);
            const formation = formCount > 0
              ? `<span class="sb-badge sb-badge--success">${formCount} formation${formCount > 1 ? "s" : ""}</span>`
              : `<span class="sb-badge">À vérifier</span>`;
            return `
              <tr data-bf-key="${escapeHtml(key)}" data-id-comp="${escapeHtml(item.id_comp || "")}" data-id-poste="${escapeHtml(item.id_poste || "")}">
                <td><input type="checkbox" class="bf-row-check" ${isSendable ? "" : "disabled"}></td>
                <td>
                  <div class="bf-need-main">
                    <span class="sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>
                    <span class="bf-need-title">${escapeHtml(comp)}</span>
                  </div>
                  <div class="bf-need-sub">${escapeHtml(niv)}</div>
                </td>
                <td>
                  <div class="bf-poste">${escapeHtml(poste)}</div>
                  <div class="bf-need-sub">${escapeHtml(item.nom_service || "Tous services / non précisé")}</div>
                </td>
                <td>
                  <span class="bf-prio ${priorityClass(item.priorite)}">${escapeHtml(item.priorite || "À surveiller")}</span>
                  <div class="bf-need-sub">${escapeHtml(item.motif_priorite || "—")}</div>
                </td>
                <td>${indicatorHtml(item)}</td>
                <td>${formation}</td>
                <td><span class="sb-badge ${statutClass(item.statut)}">${escapeHtml(item.statut_label || "—")}</span></td>
                <td>
                  <textarea class="sb-ctrl bf-comment" rows="2" placeholder="Commentaire optionnel" ${isSendable ? "" : "disabled"}>${escapeHtml(item.commentaire_client || "")}</textarea>
                </td>
                <td>
                  <button type="button" class="sb-btn sb-btn--xs bf-send-one" ${isSendable ? "" : "disabled"}>Envoyer</button>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;

    const checkAll = byId("bfCheckAll");
    if (checkAll) {
      checkAll.addEventListener("change", () => {
        wrap.querySelectorAll(".bf-row-check:not(:disabled)").forEach(cb => { cb.checked = checkAll.checked; });
      });
    }

    wrap.querySelectorAll(".bf-send-one").forEach(btn => {
      btn.addEventListener("click", async () => {
        const tr = btn.closest("tr[data-bf-key]");
        if (!tr) return;
        await sendRows([tr]);
      });
    });
  }

  function render(data) {
    _lastData = data || {};
    renderDestination(_lastData.destination || {});
    renderKpis(_lastData.kpis || {});

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
      qs.set("limit", "200");

      const data = await _portal.apiJson(`${_portal.apiBase}/skills/besoins-formations/${encodeURIComponent(_portal.contactId)}?${qs.toString()}`);
      render(data);
      setMsg("", "");
    } catch (e) {
      setMsg("Erreur système, impossible de charger les besoins.", "error");
      const wrap = byId("bfTableWrap");
      if (wrap) wrap.innerHTML = `<div class="card-sub">${escapeHtml(errMsg(e))}</div>`;
      console.error(e);
    } finally {
      _loading = false;
    }
  }

  function selectedRows() {
    const wrap = byId("bfTableWrap");
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll("tr[data-bf-key]")).filter(tr => {
      const cb = tr.querySelector(".bf-row-check");
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
      items: list.map(tr => ({
        id_comp: tr.getAttribute("data-id-comp") || "",
        id_poste: tr.getAttribute("data-id-poste") || null,
        commentaire_client: tr.querySelector(".bf-comment")?.value || ""
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