(function () {
  const DEFAULT_HTML_URL = "/studio_organisation_ccn.html";
  let _htmlPromise = null;

  async function fetchHtml(url){
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok){
      throw new Error(`Impossible de charger le composant CCN (${resp.status}).`);
    }
    return await resp.text();
  }

  async function ensureHtml(url){
    if (!_htmlPromise){
      _htmlPromise = fetchHtml(url || DEFAULT_HTML_URL);
    }
    return await _htmlPromise;
  }

  function cloneTemplate(doc, id){
    const tpl = doc.getElementById(id);
    if (!tpl || !tpl.content){
      throw new Error(`Template CCN introuvable: ${id}`);
    }
    return tpl.content.cloneNode(true);
  }

  async function ensureMounted(root, options){
    const htmlUrl = (options && options.htmlUrl) || DEFAULT_HTML_URL;
    const blockSlotId = (options && options.blockSlotId) || "posteCcnSlot";
    const modalSlotId = (options && options.modalSlotId) || "posteCcnModalSlot";

    if (!root) throw new Error("Racine Organisation introuvable pour le composant CCN.");

    const blockSlot = root.querySelector(`#${blockSlotId}`);
    const modalSlot = root.querySelector(`#${modalSlotId}`);
    if (!blockSlot || !modalSlot){
      throw new Error("Slots CCN introuvables dans la vue Organisation.");
    }

    if (blockSlot.dataset.ccnMounted === "1" && modalSlot.dataset.ccnMounted === "1"){
      return;
    }

    const html = await ensureHtml(htmlUrl);
    const doc = new DOMParser().parseFromString(html, "text/html");

    blockSlot.innerHTML = "";
    blockSlot.appendChild(cloneTemplate(doc, "tplStudioOrganisationCcnBlock"));
    blockSlot.dataset.ccnMounted = "1";

    modalSlot.innerHTML = "";
    modalSlot.appendChild(cloneTemplate(doc, "tplStudioOrganisationCcnModal"));
    modalSlot.dataset.ccnMounted = "1";
  }

  function createController(deps){
    const byId = deps.byId;
    const setValue = deps.setValue;
    const openModal = deps.openModal;
    const closeModal = deps.closeModal;
    const ensureEditingPoste = deps.ensureEditingPoste;
    const getOwnerId = deps.getOwnerId;
    const getEditingPosteId = deps.getEditingPosteId;
    const openIaBusyOverlay = deps.openIaBusyOverlay;
    const closeIaBusyOverlay = deps.closeIaBusyOverlay;

    let _ctx = null;
    let _analysis = null;
    let _bound = false;

    function defaultSummary(isCreate){
      return isCreate
        ? "Enregistre d’abord le poste pour lancer une cotation traçable."
        : "Aucune cotation conventionnelle enregistrée.";
    }

    function getReferential(){
      return _ctx?.referential || null;
    }

    function getMode(){
      return String(getReferential()?.mode || "").trim().toLowerCase();
    }

    function getResultLabels(){
      const labels = getReferential()?.result_labels || {};
      return {
        coefficient: String(labels.coefficient || "Coefficient").trim(),
        palier: String(labels.palier || "Palier").trim(),
        categorie: String(labels.categorie || "Catégorie").trim(),
        points: String(labels.points || "Points").trim(),
      };
    }

    function setText(id, text){
      const el = byId(id);
      if (el) el.textContent = String(text || "");
    }

    function applyResultLabels(){
      const labels = getResultLabels();
      const mode = getMode();

      setText("posteCcnResultLabel", `${labels.coefficient} / ${labels.palier} retenu`);
      setText("posteCcnCategoryLabel", `${labels.categorie} retenue`);
      setText("posteCcnPropCoeffLabel", `${labels.coefficient} proposé`);
      setText("posteCcnPropPalierLabel", `${labels.palier} proposé`);
      setText("posteCcnPropCategorieLabel", `${labels.categorie} proposée`);
      setText("posteCcnPropPointsLabel", mode === "group_level" ? "Repère" : labels.points);
      setText("posteCcnCritHeadLevel", mode === "group_level" ? labels.coefficient : "Niveau");
      setText("posteCcnCritHeadPoints", mode === "group_level" ? "Repère" : labels.points);
      setText("posteCcnFinalCoefficientLabel", `${labels.coefficient} retenu`);
      setText("posteCcnFinalPalierLabel", `${labels.palier} retenu`);
      setText("posteCcnFinalCategorieLabel", `${labels.categorie} retenue`);

      const coefEl = byId("posteCcnFinalCoefficient");
      const palierEl = byId("posteCcnFinalPalier");
      if (coefEl){
        coefEl.min = "1";
        coefEl.step = "1";
        if (mode === "group_level") coefEl.max = "9";
        else coefEl.removeAttribute("max");
      }
      if (palierEl){
        if (mode === "group_level"){
          palierEl.readOnly = false;
          palierEl.min = "1";
          palierEl.max = "3";
          palierEl.step = "1";
        } else {
          palierEl.readOnly = true;
          palierEl.removeAttribute("max");
        }
      }
    }

    function getAllowedLevels(groupNo){
      const key = String(parseInt(groupNo ?? 0, 10) || 0);
      const raw = getReferential()?.levels_by_group?.[key];
      if (!Array.isArray(raw) || !raw.length) return [1];
      const out = raw
        .map(x => parseInt(x, 10))
        .filter(x => Number.isFinite(x) && x > 0);
      return out.length ? out : [1];
    }

    function normalizeLevel(groupNo, levelNo){
      const allowed = getAllowedLevels(groupNo);
      const n = parseInt(levelNo ?? 0, 10);
      if (Number.isFinite(n) && allowed.includes(n)) return n;
      return allowed[0] || 1;
    }

    function findPalierByCoefficient(coef){
      const ref = getReferential() || {};
      const mode = getMode();
      const n = parseInt(coef ?? 0, 10);
      if (!Number.isFinite(n) || n <= 0) return null;

      if (mode === "group_level"){
        const meta = Array.isArray(ref.group_definitions)
          ? ref.group_definitions.find(x => (parseInt(x?.group ?? 0, 10) || 0) === n)
          : null;
        return { palier: null, groupe: n, raw: meta || null };
      }

      const paliers = Array.isArray(ref.paliers) ? ref.paliers : [];
      if (paliers.length){
        for (const it of paliers){
          const min = parseInt(it?.coef_min ?? 0, 10) || 0;
          const max = (it?.coef_max === null || it?.coef_max === undefined) ? 999999 : (parseInt(it.coef_max, 10) || 999999);
          if (n >= min && n <= max){
            return {
              palier: parseInt(it?.palier ?? 0, 10) || 0,
              groupe: "",
              raw: it
            };
          }
        }
        return null;
      }

      const cmap = Array.isArray(ref.classification_map) ? ref.classification_map : [];
      for (const it of cmap){
        const min = parseInt(it?.points_min ?? 0, 10) || 0;
        const max = parseInt(it?.points_max ?? 0, 10) || 0;
        if (n >= min && n <= max){
          return {
            palier: parseInt(it?.classe ?? 0, 10) || 0,
            groupe: String(it?.groupe || "").trim().toUpperCase(),
            raw: it
          };
        }
      }

      return null;
    }

    function computeCategory(coef, criteria){
      const ref = getReferential() || {};
      const mode = getMode();
      const n = parseInt(coef ?? 0, 10);
      if (!Number.isFinite(n) || n <= 0) return "";

      if (mode === "group_level"){
        const meta = Array.isArray(ref.group_definitions)
          ? ref.group_definitions.find(x => (parseInt(x?.group ?? 0, 10) || 0) === n)
          : null;
        return String(meta?.short_title || meta?.title || `Groupe ${n}`).trim();
      }

      const cmap = Array.isArray(ref.classification_map) ? ref.classification_map : [];
      if (cmap.length){
        const band = findPalierByCoefficient(n);
        const grp = String(band?.groupe || "").trim().toUpperCase();
        if (!grp) return "";
        const cadreGroups = new Set((ref?.cadre_groups || ["F","G","H","I"]).map(x => String(x || "").trim().toUpperCase()));
        return `Groupe ${grp} · ${cadreGroups.has(grp) ? "Cadre" : "Non-cadre"}`;
      }

      if (n >= 350) return "Cadre";
      if (n >= 310 && n <= 349){
        const rows = Array.isArray(criteria) ? criteria : [];
        const marche = (code) => parseInt((rows.find(x => String(x?.code || "").trim() === code)?.marche) ?? 0, 10) || 0;
        let ok = 0;
        if (marche("management") >= 3) ok += 1;
        if (marche("ampleur_connaissances") >= 4) ok += 1;
        if (marche("autonomie") >= 6) ok += 1;
        return ok >= 2 ? "Cadre" : "Agent de maîtrise / technicien";
      }
      if (n >= 171) return "Agent de maîtrise / technicien";
      if (n >= 100) return "Employé";
      return "";
    }

    function formatResultText(data){
      const mode = getMode();
      const coef = parseInt(data?.coefficient ?? 0, 10) || 0;
      const palier = parseInt(data?.palier ?? 0, 10) || 0;
      if (mode === "group_level"){
        return (!coef && !palier) ? "—" : `Groupe ${coef || "—"} · Niveau ${palier || "—"}`;
      }
      return (!coef && !palier) ? "—" : `Coef. ${coef || "—"} · Palier ${palier || "—"}`;
    }

    function renderCriteriaRows(analysis){
      const tbody = byId("posteCcnCriteriaTbody");
      const empty = byId("posteCcnCriteriaEmpty");
      if (!tbody || !empty) return;

      tbody.innerHTML = "";
      const rows = [];
      const mode = String(analysis?.mode || getMode() || "").trim().toLowerCase();

      (Array.isArray(analysis?.criteres) ? analysis.criteres : []).forEach(x => {
        rows.push({
          libelle: x?.libelle || x?.code || "Critère",
          niveau: mode === "group_level" ? `G${parseInt(x?.marche ?? 0, 10) || 0}` : `M${parseInt(x?.marche ?? 0, 10) || 0}`,
          points: mode === "group_level" ? "—" : (parseInt(x?.points ?? 0, 10) || 0),
          justification: x?.justification || ""
        });
      });

      (Array.isArray(analysis?.bonifications) ? analysis.bonifications : []).forEach(x => {
        rows.push({
          libelle: x?.libelle || x?.code || "Bonification",
          niveau: x?.niveau_label || `M${parseInt(x?.marche ?? 0, 10) || 0}`,
          points: parseInt(x?.points ?? 0, 10) || 0,
          justification: x?.justification || ""
        });
      });

      if (!rows.length){
        empty.style.display = "";
        return;
      }

      empty.style.display = "none";
      rows.forEach(r => {
        const tr = document.createElement("tr");

        const tdLib = document.createElement("td");
        tdLib.textContent = r.libelle || "—";

        const tdNiv = document.createElement("td");
        tdNiv.style.textAlign = "center";
        const badge = document.createElement("span");
        badge.className = "sb-badge sb-badge--ccn-level";
        badge.textContent = r.niveau || "—";
        tdNiv.appendChild(badge);

        const tdPts = document.createElement("td");
        tdPts.style.textAlign = "center";
        tdPts.textContent = String(r.points ?? "—");

        const tdJust = document.createElement("td");
        tdJust.textContent = r.justification || "—";

        tr.appendChild(tdLib);
        tr.appendChild(tdNiv);
        tr.appendChild(tdPts);
        tr.appendChild(tdJust);
        tbody.appendChild(tr);
      });
    }

    function fillDecision(data){
      setValue("posteCcnFinalCoefficient", data?.coefficient || "");
      setValue("posteCcnFinalPalier", data?.palier || "");
      setValue("posteCcnFinalJustification", data?.justification || "");
      refreshDecisionDerived();
    }

    function fillProposal(analysis){
      _analysis = analysis || null;
      const proposal = analysis?.proposal || {};
      const mode = String(analysis?.mode || getMode() || "").trim().toLowerCase();

      setValue("posteCcnPropCoeff", proposal?.coefficient ?? "—");
      setValue("posteCcnPropPalier", proposal?.palier ?? "—");
      setValue("posteCcnPropCategorie", proposal?.categorie_professionnelle || "—");
      setValue("posteCcnPropPoints", mode === "group_level" ? "—" : (analysis?.total_points ?? "—"));
      setValue("posteCcnPropResume", proposal?.resume_cotation || "");
      setValue("posteCcnPropJustification", analysis?.justification_globale || "");

      renderCriteriaRows(analysis);

      const reuse = byId("btnPosteCcnReuse");
      if (reuse){
        reuse.disabled = !analysis?.proposal;
        reuse.style.opacity = reuse.disabled ? ".6" : "";
      }
    }

    function refreshDecisionDerived(){
      const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
      const mode = getMode();

      if (!Number.isFinite(coef) || coef <= 0){
        setValue("posteCcnFinalPalier", "");
        setValue("posteCcnFinalCategorie", "");
        return;
      }

      const criteria = _analysis?.criteres || _ctx?.dossier?.proposition_json?.criteres || [];
      if (mode === "group_level"){
        const currentLevel = parseInt((byId("posteCcnFinalPalier")?.value || "").trim(), 10);
        const normalized = normalizeLevel(coef, currentLevel);
        setValue("posteCcnFinalPalier", normalized);
        setValue("posteCcnFinalCategorie", computeCategory(coef, criteria));
        return;
      }

      setValue("posteCcnFinalPalier", findPalierByCoefficient(coef)?.palier ?? "");
      setValue("posteCcnFinalCategorie", computeCategory(coef, criteria));
    }

    function fillContext(ctx){
      _ctx = ctx || null;
      applyResultLabels();

      const conventionTxt = ctx?.convention_label
        ? `${ctx.convention_label}${ctx?.idcc ? ` (IDCC ${ctx.idcc})` : ""}`
        : (ctx?.idcc ? `IDCC ${ctx.idcc}` : "Convention non détectée");

      setValue("posteCcnConvention", conventionTxt);
      setValue("posteCcnModalConvention", conventionTxt);
      setValue("posteCcnModalVersion", ctx?.version_label || "—");
      setValue("posteCcnModalPoste", ctx?.poste?.intitule_poste || "—");
      setValue("posteCcnModalService", ctx?.poste?.nom_service || "Non lié");

      const base = [];
      if (ctx?.poste?.mission_principale) base.push(`Mission : ${ctx.poste.mission_principale}`);
      if (ctx?.poste?.competences_count !== undefined) base.push(`Compétences requises : ${ctx.poste.competences_count}`);
      if (ctx?.poste?.certifications_count !== undefined) base.push(`Certifications : ${ctx.poste.certifications_count}`);
      setValue("posteCcnModalBase", base.join("\n"));

      let status = "Non démarré";
      let result = "—";
      let category = "—";
      let summary = defaultSummary(false);

      const dossier = ctx?.dossier || null;
      const proposal = dossier?.proposition_json || null;
      const validation = dossier?.validation_json || null;

      if (!ctx?.supported){
        status = "Convention non supportée";
        summary = ctx?.support_message || "L’assistant n’est pas disponible pour cette convention.";
      } else if (validation && Object.keys(validation).length){
        status = "Validée";
        result = formatResultText(validation);
        summary = validation?.justification || proposal?.proposal?.resume_cotation || defaultSummary(false);
        category = validation?.categorie_professionnelle || proposal?.proposal?.categorie_professionnelle || "—";
      } else if (proposal && Object.keys(proposal).length){
        status = "Brouillon";
        result = formatResultText(proposal?.proposal || proposal);
        summary = proposal?.justification_globale || proposal?.proposal?.resume_cotation || defaultSummary(false);
        category = proposal?.proposal?.categorie_professionnelle || "—";
      }

      setValue("posteCcnStatus", status);
      setValue("posteCcnResult", result);
      setValue("posteCcnCategory", category);
      setValue("posteCcnSummary", summary);

      fillProposal(proposal && Object.keys(proposal).length ? proposal : null);

      if (validation && Object.keys(validation).length){
        fillDecision({
          coefficient: validation.coefficient,
          palier: validation.palier,
          justification: validation.justification || ""
        });
      } else if (proposal?.proposal){
        fillDecision({
          coefficient: proposal.proposal.coefficient,
          palier: proposal.proposal.palier,
          justification: proposal.justification_globale || proposal.proposal.resume_cotation || ""
        });
      } else {
        fillDecision({ coefficient: "", palier: "", justification: "" });
      }

      const sub = byId("posteCcnSub");
      if (sub){
        sub.textContent = ctx?.supported
          ? "Assistant dédié à la cotation de l’emploi selon la convention collective détectée."
          : (ctx?.support_message || "Convention non encore supportée.");
      }
    }

    async function loadContext(portal){
      const pid = String(getEditingPosteId() || "").trim();
      if (!pid) return null;
      const ownerId = getOwnerId();
      const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_context`;
      const ctx = await portal.apiJson(url);
      fillContext(ctx);
      return ctx;
    }

    async function openCcnModal(portal){
      const pid = await ensureEditingPoste(portal);
      if (!_ctx || _ctx?.poste?.id_poste !== pid){
        await loadContext(portal);
      }
      openModal("modalPosteCcn");
    }

    function closeCcnModal(){
      closeModal("modalPosteCcn");
    }

    function reuseProposal(){
      const proposal = _analysis?.proposal || _ctx?.dossier?.proposition_json?.proposal || null;
      const justification = _analysis?.justification_globale || _ctx?.dossier?.proposition_json?.justification_globale || "";
      if (!proposal) return;
      fillDecision({
        coefficient: proposal.coefficient,
        palier: proposal.palier,
        justification: justification || proposal.resume_cotation || ""
      });
    }

    async function runAnalysis(portal){
      const pid = await ensureEditingPoste(portal);
      if (!_ctx || _ctx?.poste?.id_poste !== pid){
        await loadContext(portal);
      }
      if (!_ctx?.supported){
        portal.showAlert("error", _ctx?.support_message || "Convention non supportée.");
        return;
      }

      const ownerId = getOwnerId();
      const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/propose`;

      const btn = byId("btnPosteCcnAnalyze");
      if (btn){
        btn.disabled = true;
        btn.style.opacity = ".6";
        btn.textContent = "Analyse…";
      }

      openIaBusyOverlay(
        "Cotation conventionnelle en cours",
        "Lecture du poste, application du référentiel conventionnel et génération de la justification..."
      );

      try {
        const res = await portal.apiJson(url, { method: "POST" });
        const analysis = res?.proposition || null;

        fillProposal(analysis);
        reuseProposal();

        if (_ctx){
          if (!_ctx.dossier) _ctx.dossier = {};
          _ctx.dossier.proposition_json = analysis || {};
        }

        setValue("posteCcnStatus", "Proposition non enregistrée");
        setValue("posteCcnResult", formatResultText(analysis?.proposal || {}));
        setValue("posteCcnCategory", analysis?.proposal?.categorie_professionnelle || "—");
        setValue(
          "posteCcnSummary",
          analysis?.justification_globale || analysis?.proposal?.resume_cotation || "Proposition IA prête à être revue."
        );

        portal.showAlert("", "");
      } finally {
        closeIaBusyOverlay();
        if (btn){
          btn.disabled = false;
          btn.style.opacity = "";
          btn.textContent = "Lancer l’analyse";
        }
      }
    }

    async function saveDecision(portal){
      const pid = await ensureEditingPoste(portal);
      if (!_ctx || _ctx?.poste?.id_poste !== pid){
        await loadContext(portal);
      }
      if (!_ctx?.supported){
        portal.showAlert("error", _ctx?.support_message || "Convention non supportée.");
        return;
      }

      const mode = getMode();
      const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
      const palier = parseInt((byId("posteCcnFinalPalier")?.value || "").trim(), 10);
      const ref = getReferential() || {};
      const is3248 = Array.isArray(ref?.classification_map) && ref.classification_map.length > 0 && mode !== "group_level";

      if (mode === "group_level"){
        if (!Number.isFinite(coef) || coef < 1 || coef > 9){
          portal.showAlert("error", "Le groupe retenu doit être compris entre 1 et 9.");
          return;
        }
        const allowed = getAllowedLevels(coef);
        if (!Number.isFinite(palier) || !allowed.includes(palier)){
          portal.showAlert("error", `Le niveau retenu n’est pas autorisé pour le groupe ${coef}.`);
          return;
        }
      } else {
        const minCoef = is3248 ? 6 : 100;
        if (!Number.isFinite(coef) || coef < minCoef){
          portal.showAlert("error", is3248
            ? "La cotation retenue doit être supérieure ou égale à 6."
            : "Le coefficient retenu doit être supérieur ou égal à 100."
          );
          return;
        }
      }

      const justification = (byId("posteCcnFinalJustification")?.value || "").trim();
      if (!justification){
        portal.showAlert("error", "La justification retenue est obligatoire.");
        return;
      }

      const ownerId = getOwnerId();
      const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/save`;

      const btn = byId("btnPosteCcnSave");
      if (btn){
        btn.disabled = true;
        btn.style.opacity = ".6";
      }

      try {
        await portal.apiJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            coefficient_retenu: coef,
            palier_retenu: Number.isFinite(palier) ? palier : null,
            justification_retenue: justification,
            proposition_json: _analysis || _ctx?.dossier?.proposition_json || {}
          }),
        });
        await loadContext(portal);
        closeCcnModal();
        portal.showAlert("", "");
      } finally {
        if (btn){
          btn.disabled = false;
          btn.style.opacity = "";
        }
      }
    }

    function resetUi(isCreate){
      _ctx = null;
      _analysis = null;
      applyResultLabels();

      setValue("posteCcnConvention", isCreate ? "Disponible après enregistrement du poste" : "Chargement…");
      setValue("posteCcnStatus", isCreate ? "Brouillon non enregistré" : "Chargement…");
      setValue("posteCcnResult", "—");
      setValue("posteCcnCategory", "—");
      setValue("posteCcnSummary", defaultSummary(!!isCreate));

      setValue("posteCcnModalConvention", "—");
      setValue("posteCcnModalVersion", "—");
      setValue("posteCcnModalPoste", "—");
      setValue("posteCcnModalService", "—");
      setValue("posteCcnModalBase", "");

      setValue("posteCcnPropCoeff", "—");
      setValue("posteCcnPropPalier", "—");
      setValue("posteCcnPropCategorie", "—");
      setValue("posteCcnPropPoints", "—");
      setValue("posteCcnPropResume", "");
      setValue("posteCcnPropJustification", "");

      setValue("posteCcnFinalCoefficient", "");
      setValue("posteCcnFinalPalier", "");
      setValue("posteCcnFinalCategorie", "");
      setValue("posteCcnFinalJustification", "");

      const tbody = byId("posteCcnCriteriaTbody");
      if (tbody) tbody.innerHTML = "";
      const empty = byId("posteCcnCriteriaEmpty");
      if (empty) empty.style.display = "";

      const reuse = byId("btnPosteCcnReuse");
      if (reuse){
        reuse.disabled = true;
        reuse.style.opacity = ".6";
      }

      const sub = byId("posteCcnSub");
      if (sub){
        sub.textContent = isCreate
          ? "Enregistre le poste, puis lance l’assistant de cotation conventionnelle."
          : "Assistant dédié à la cotation de l’emploi selon la convention collective détectée.";
      }
    }

    function bindOnce(portal){
      if (_bound) return;
      _bound = true;

      byId("btnPosteCcnOpen")?.addEventListener("click", async () => {
        try { await openCcnModal(portal); }
        catch(e){ portal.showAlert("error", e?.message || String(e)); }
      });
      byId("btnPosteCcnX")?.addEventListener("click", closeCcnModal);
      byId("btnPosteCcnCancel")?.addEventListener("click", closeCcnModal);
      byId("btnPosteCcnAnalyze")?.addEventListener("click", async () => {
        try { await runAnalysis(portal); }
        catch(e){ portal.showAlert("error", e?.message || String(e)); }
      });
      byId("btnPosteCcnReuse")?.addEventListener("click", () => {
        try { reuseProposal(); }
        catch(e){ portal.showAlert("error", e?.message || String(e)); }
      });
      byId("btnPosteCcnSave")?.addEventListener("click", async () => {
        try { await saveDecision(portal); }
        catch(e){ portal.showAlert("error", e?.message || String(e)); }
      });
      byId("posteCcnFinalCoefficient")?.addEventListener("input", refreshDecisionDerived);
      byId("posteCcnFinalPalier")?.addEventListener("input", () => {
        if (getMode() === "group_level") refreshDecisionDerived();
      });

      const mccn = byId("modalPosteCcn");
      if (mccn && !mccn._sbBound){
        mccn._sbBound = true;
        mccn.addEventListener("click", (e) => {
          if (e.target === mccn) closeCcnModal();
        });
        document.addEventListener("keydown", (e) => {
          const el = byId("modalPosteCcn");
          if (e.key === "Escape" && el && el.style.display === "flex") closeCcnModal();
        });
      }
    }

    return {
      bindOnce,
      resetUi,
      getReferential,
      loadContext,
      openModal: openCcnModal,
      closeModal: closeCcnModal,
      reuseProposal,
      runAnalysis,
      saveDecision,
    };
  }

  window.__studioOrganisationCcn = {
    ensureMounted,
    createController,
  };
})();