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
  let _collabInlineMsgTimer = null;
  let _collabHistoryBound = false;

  // Indisponibilités (KPI + filtre table)
  let _lastListItems = [];
  let _breakNowIds = new Set();     // collaborateurs indispo aujourd'hui
  let _breakNext30Ids = new Set();  // collaborateurs avec indispo qui démarre dans les 30j
  let _breakFocus = null;           // "now" | "next30" | null


  function byId(id) {
    return document.getElementById(id);
  }

  function setCollaborateurPageMode(enabled) {
    const root = byId("view-vos-collaborateurs");
    const page = byId("modalCollaborateur");
    const content = root?.closest(".content");
    if (!root || !page) return;

    Array.from(root.children).forEach(child => {
      child.style.display = child === page ? (enabled ? "" : "none") : (enabled ? "none" : "");
    });

    root.classList.toggle("is-poste-page", !!enabled);
    if (content) content.classList.toggle("is-poste-page", !!enabled);
    page.setAttribute("aria-hidden", enabled ? "false" : "true");
  }

  function showCollaborateursIndex() {
    const page = byId("modalCollaborateur");
    setCollaborateurPageMode(false);
    if (page) {
      page.removeAttribute("data-id-effectif");
    }
  }

  function showCollaborateurPage(idEffectif) {
    const page = byId("modalCollaborateur");
    if (page) page.setAttribute("data-id-effectif", String(idEffectif || ""));
    setCollaborateurPageMode(true);
  }

  function pushCollaborateurHistory(idEffectif) {
    const id = String(idEffectif || "").trim();
    if (!id || String(window.history.state?.skillsCollaborateurDetail || "") === id) return;
    try {
      const state = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
      window.history.pushState({ ...state, skillsCollaborateurDetail: id }, "", window.location.href);
    } catch (_) {}
  }

  function bindCollaborateurHistoryOnce() {
    if (_collabHistoryBound) return;
    _collabHistoryBound = true;

    window.addEventListener("popstate", async event => {
      const root = byId("view-vos-collaborateurs");
      if (!root || root.style.display === "none") return;

      const idEffectif = String(event.state?.skillsCollaborateurDetail || "").trim();
      if (!idEffectif) {
        showCollaborateursIndex();
        return;
      }

      try {
        const idContact = window.portal?.contactId;
        if (!idContact) throw new Error("Contact introuvable.");
        const detail = await loadIdentification(idContact, idEffectif);
        openCollaborateurModal(detail, { pushHistory: false });
      } catch (e) {
        window.portal?.showAlert?.("error", "Erreur fiche collaborateur : " + (e?.message || String(e)));
        showCollaborateursIndex();
      }
    });
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

  function normalizeCiviliteLabel(value) {
    const raw = (value ?? "").toString().trim();
    if (!raw) return "-";

    const key = raw
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/\./g, "");

    if (["M", "MR", "MONSIEUR"].includes(key)) return "M.";
    if (["F", "MME", "MADAME", "MLLE", "MADEMOISELLE"].includes(key)) return "Mme";

    return "-";
  }

  function formatPhoneFr(value) {
    const digits = (value ?? "").toString().replace(/\D+/g, "").slice(0, 10);
    return digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
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

  async function fetchCollaborateurCompetencePdfBlob(id_contact, id_effectif, id_comp) {
    const url = `${API_BASE}/skills/collaborateurs/competences/fiche_pdf/${encodeURIComponent(id_contact)}/${encodeURIComponent(id_effectif)}/${encodeURIComponent(id_comp)}`;

    const headers = new Headers();
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      let msg = `Erreur PDF (${resp.status})`;
      try {
        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const js = await resp.json();
          msg = js?.detail || js?.message || JSON.stringify(js);
        } else {
          msg = await resp.text() || msg;
        }
      } catch (_) {}
      throw new Error(msg);
    }

    return await resp.blob();
  }

  function renderPdfBlobInWindow(popupWin, blob, title) {
    const win = popupWin && !popupWin.closed ? popupWin : window.open("about:blank", "_blank");
    if (!win) throw new Error("Ouverture du PDF bloquée par le navigateur.");

    const blobUrl = URL.createObjectURL(blob);
    const safeTitle = escapeHtml(title || "Fiche compétence");

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    html,body{height:100%;margin:0;background:#f3f4f6;}
    iframe{width:100%;height:100%;border:0;background:#fff;}
  </style>
</head>
<body>
  <iframe src="${blobUrl}" title="${safeTitle}"></iframe>
</body>
</html>`);
    win.document.close();

    const revoke = () => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    };
    try { win.addEventListener("beforeunload", revoke, { once: true }); } catch (_) {}
    setTimeout(revoke, 5 * 60 * 1000);
  }

  async function openCollaborateurCompetencePdf(id_contact, id_effectif, item, popupWin) {
    const compId = String(item?.id_comp || "").trim();
    if (!id_contact || !id_effectif || !compId) throw new Error("Compétence introuvable.");

    const title = `Fiche compétence - ${String(item?.code || "").trim() ? `${String(item.code).trim()} - ` : ""}${String(item?.intitule || "").trim() || "Compétence"}`;
    const blob = await fetchCollaborateurCompetencePdfBlob(id_contact, id_effectif, compId);
    renderPdfBlobInWindow(popupWin, blob, title);
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

  let _selectedCollaborateur = null;

  function getCollaborateurFullName(it) {
    return `${it?.prenom_effectif || ""} ${(it?.nom_effectif || "").toUpperCase()}`.trim();
  }

  function getCollaborateurInitials(it) {
    const p = (it?.prenom_effectif || "").trim();
    const n = (it?.nom_effectif || "").trim();
    const a = p ? p[0] : "";
    const b = n ? n[0] : "";
    return `${a}${b}`.toUpperCase() || "–";
  }

  function getCollaborateurRoles(it) {
    const roles = [];
    if (it?.is_temp) roles.push("Temporaire");
    if (it?.ismanager) roles.push("Manager");
    if (it?.isformateur) roles.push("Formateur");
    if (!roles.length) roles.push("Employé");
    return roles;
  }

  function getCollaborateurStatusLabel(it) {
    if (it?.archive) return "Archivé";
    return it?.statut_actif ? "Actif" : "Inactif";
  }

  function getCollaborateurStatusClass(it) {
    if (it?.archive) return "ns-collab-status--archived";
    return it?.statut_actif ? "ns-collab-status--active" : "ns-collab-status--inactive";
  }

  function getCollaborateurRoleClass(role) {
    const key = (role || "").toString().trim().toLowerCase();
    if (key === "manager") return "ns-badge ns-badge-role ns-badge-role--manager";
    if (key === "formateur") return "ns-badge ns-badge-role ns-badge-role--formateur";
    if (key === "temporaire") return "ns-badge ns-badge-status ns-badge-status--info";
    return "ns-badge ns-badge-role";
  }

  function getCollaborateurRoleContextClass(role) {
    const key = (role || "").toString().trim().toLowerCase();
    if (key === "manager") return "ns-badge-role--manager";
    if (key === "formateur") return "ns-badge-role--formateur";
    return "";
  }

  function renderRolePills(it) {
    return getCollaborateurRoles(it)
      .map(r => `<span class="${getCollaborateurRoleClass(r)}">${escapeHtml(r)}</span>`)
      .join("");
  }

  function collabIcon(name) {
    const icons = {
      user: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-user"></use></svg>`,
      skills: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>`,
      certs: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-certification"></use></svg>`,
      history: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-324f7e924d36"></use></svg>`,
      building: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-organisation"></use></svg>`,
      briefcase: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-job"></use></svg>`,
      contract: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-c489f3162892"></use></svg>`,
      calendar: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-calendar"></use></svg>`,
      phone: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-e05784c1bb4a"></use></svg>`,
      graduation: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-0476721b1003"></use></svg>`,
      comment: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-comment"></use></svg>`,
      school: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-0476721b1003"></use></svg>`,
      org: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-organisation"></use></svg>`,
      globe: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-globe"></use></svg>`,
      audit: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-c675e9d5bc92"></use></svg>`,
      medal: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-certification"></use></svg>`,
      edit: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-edit"></use></svg>`,
      save: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-save"></use></svg>`,
      cancel: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-close"></use></svg>`,
      trend: `<svg viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-analysis"></use></svg>`
    };
    return icons[name] || "";
  }

  function renderModalSummaryItem(icon, label, value) {
    return `
      <div class="sb-collab-summary-item">
        <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon(icon)}</span>
        <span>
          <span class="sb-collab-summary-label">${escapeHtml(label)}</span>
          <strong>${escapeHtml(value || "–")}</strong>
        </span>
      </div>
    `;
  }

  function setInlineMsg(host, type, text) {
    const msg = host?.querySelector?.(".sb-collab-inline-msg");
    if (!msg) return;

    if (_collabInlineMsgTimer) {
      clearTimeout(_collabInlineMsgTimer);
      _collabInlineMsgTimer = null;
    }

    const scope = host?.closest?.("#collabIdentPanel") || host;
    scope?.querySelectorAll?.(".sb-collab-inline-msg").forEach(other => {
      if (other === msg) return;
      other.textContent = "";
      other.classList.remove("is-visible", "is-success", "is-error", "is-info");
    });

    msg.textContent = text || "";
    msg.classList.remove("is-visible", "is-success", "is-error", "is-info");

    if (!text) return;

    msg.classList.add("is-visible", type === "error" ? "is-error" : (type === "success" ? "is-success" : "is-info"));

    _collabInlineMsgTimer = setTimeout(() => {
      setInlineMsg(host, "info", "");
    }, 5000);
  }

  function clearInlineMsg(host) {
    setInlineMsg(host, "info", "");
  }

  function refreshSelectSelectedSoftState(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    scope.querySelectorAll("select.sb-select").forEach(sel => {
      sel.classList.remove("sb-select--selected-soft");
    });
  }

  function renderCollaborateurPreview(it) {
    const empty = byId("collabPreviewEmpty");
    const content = byId("collabPreviewContent");

    if (!it) {
      _selectedCollaborateur = null;
      if (empty) empty.style.display = "";
      if (content) content.style.display = "none";
      return;
    }

    _selectedCollaborateur = it;
    if (empty) empty.style.display = "none";
    if (content) content.style.display = "";

    const fullName = getCollaborateurFullName(it);
    setText("collabPreviewAvatar", getCollaborateurInitials(it), "–");
    setText("collabPreviewName", fullName, "Collaborateur");
    const previewStatus = byId("collabPreviewStatus");
    if (previewStatus) {
      previewStatus.classList.remove("ns-collab-status--active", "ns-collab-status--inactive", "ns-collab-status--archived");
      previewStatus.classList.add(getCollaborateurStatusClass(it));
    }
    setText("collabPreviewStatusText", getCollaborateurStatusLabel(it));
    setText("collabPreviewService", it.nom_service || (it.id_service ? it.id_service : "Non lié"));
    setText("collabPreviewPoste", it.intitule_poste || "–");
    setText("collabPreviewEntree", formatDateFR(it.date_entree_entreprise_effectif));
    setText("collabPreviewSortie", formatDateFR(it.date_sortie_prevue));
    setText("collabPreviewContrat", it.type_contrat || "–");
    setText("collabPreviewEmail", it.email_effectif || "–");
    setText("collabPreviewPhone", it.telephone_effectif || "–");

    const roles = byId("collabPreviewRoles");
    if (roles) roles.innerHTML = renderRolePills(it);
  }

  function cssEscapeValue(value) {
    const s = String(value || "");
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function fireDomEvent(el, type) {
    if (!el) return;
    try {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (_) {
      try {
        const evt = document.createEvent("Event");
        evt.initEvent(type, true, true);
        el.dispatchEvent(evt);
      } catch (_) {}
    }
  }

  function prepareEntretienCollaborateurPreselect(it) {
    const idEff = String(it?.id_effectif || "").trim();
    if (!idEff) return;

    const fullName = getCollaborateurFullName(it);
    const serviceId = String(it?.id_service || "").trim();

    try {
      window.sessionStorage.setItem("skills_ep_preselect_id_effectif", idEff);
      window.sessionStorage.setItem("skills_ep_preselect_nom", fullName);
      window.sessionStorage.setItem("skills_ep_preselect_id_service", serviceId);
      window.sessionStorage.setItem("ep_preselect_id_effectif", idEff);
      window.sessionStorage.setItem("ep_preselect_id_service", serviceId);
      window.sessionStorage.setItem("novoskill_ep_preselect_id_effectif", idEff);
    } catch (_) {}

    const detail = {
      id_effectif: idEff,
      idEffectif: idEff,
      id_collaborateur: idEff,
      id_service: serviceId,
      serviceId,
      nom: fullName,
      collaborateur: fullName
    };

    try {
      if (window.SkillsEntretienPerformance && typeof window.SkillsEntretienPerformance.preselectCollaborateur === "function") {
        window.SkillsEntretienPerformance.preselectCollaborateur(detail);
        return;
      }
    } catch (_) {}

    try {
      window.dispatchEvent(new CustomEvent("novoskill:entretien-preselect", { detail }));
    } catch (_) {}
  }

  function selectCollaborateurRow(id_effectif) {
    const body = byId("tblCollaborateursBody");
    if (!body) return;
    Array.from(body.querySelectorAll("tr[data-id-effectif]")).forEach(tr => {
      tr.classList.toggle("is-selected", tr.getAttribute("data-id-effectif") === String(id_effectif || ""));
    });
  }

  function renderList(items) {
    const body = byId("tblCollaborateursBody");
    const empty = byId("collabEmpty");
    const count = byId("collabCount");
    const range = byId("collabRangeLabel");
    if (!body || !empty) return;

    body.innerHTML = "";

    const list = Array.isArray(items) ? items : [];

    if (count) {
      count.textContent = `${list.length} collaborateur(s)`;
    }
    if (range) {
      range.textContent = list.length ? `1 – ${list.length} sur ${list.length}` : "0 – 0 sur 0";
    }

    if (list.length === 0) {
      empty.style.display = "block";
      renderCollaborateurPreview(null);
      return;
    }
    empty.style.display = "none";

    const currentId = _selectedCollaborateur?.id_effectif || "";
    let selected = list.find(x => String(x?.id_effectif || "") === String(currentId));
    if (!selected) selected = list[0];

    list.forEach(it => {
      const tr = document.createElement("tr");
      const idEff = String(it?.id_effectif || "");
      tr.setAttribute("data-id-effectif", idEff);

      const fullName = getCollaborateurFullName(it);
      const statusLabel = getCollaborateurStatusLabel(it);
      const statusCls = getCollaborateurStatusClass(it);

      tr.innerHTML = `
        <td>
          <div class="collab-person-cell">
            <span class="collab-avatar">${escapeHtml(getCollaborateurInitials(it))}</span>
            <strong>${escapeHtml(fullName || "–")}</strong>
          </div>
        </td>
        <td>${escapeHtml(it.nom_service || (it.id_service ? it.id_service : "Non lié"))}</td>
        <td>${escapeHtml(it.intitule_poste || "–")}</td>
        <td><span class="ns-collab-status ${escapeHtml(statusCls)}"><span class="ns-collab-status__dot" aria-hidden="true"></span><span>${escapeHtml(statusLabel || "–")}</span></span></td>
      `;

      tr.addEventListener("click", () => {
        renderCollaborateurPreview(it);
        selectCollaborateurRow(idEff);
      });

      tr.addEventListener("dblclick", () => openCollaborateurModal(it));

      body.appendChild(tr);
    });

    renderCollaborateurPreview(selected);
    selectCollaborateurRow(selected?.id_effectif);
  }

  function openCollaborateurModal(it, options) {
    const modal = byId("modalCollaborateur");
    const idEffectif = String(it?.id_effectif || "").trim();
    showCollaborateurPage(idEffectif);
    if (options?.pushHistory !== false) pushCollaborateurHistory(idEffectif);
    const title = byId("collabModalTitle");
    const sub = byId("collabModalSub");
    const body = byId("collabModalBody");
    const hb = byId("collabModalBadges");
    const avatar = byId("collabModalAvatar");
    const status = byId("collabModalStatus");
    if (hb) hb.innerHTML = renderRolePills(it);

    if (title) title.textContent = `${it.prenom_effectif || ""} ${it.nom_effectif || ""}`.trim() || "Collaborateur";
    if (avatar) avatar.textContent = getCollaborateurInitials(it);
    setText("collabModalPoste", it?.intitule_poste || "–");
    setText("collabModalService", it?.nom_service || "–");
    setText("collabModalDateEntree", formatDateFR(it?.date_entree_entreprise_effectif));
    setText("collabModalContrat", it?.type_contrat || "–");
    setText("collabModalDatePoste", "–");
    setText("collabModalManager", "–");
    if (status) {
      const statusClass = getCollaborateurStatusClass(it);
      status.className = `ns-collab-status ${statusClass} sb-collab-profile-status`;
      status.setAttribute("aria-label", `Statut : ${getCollaborateurStatusLabel(it)}`);
    }
    if (sub) {
      sub.textContent = "";
      sub.style.display = "none";
    }


    if (body) {
      body.innerHTML = `
        <div class="sb-tab-panel is-active" data-panel="overview" role="tabpanel">
          <div id="collabOverviewPanel">
            <div class="card-sub" style="margin:0;">Chargement…</div>
          </div>
        </div>

        <div class="sb-tab-panel" data-panel="ident" role="tabpanel">
          <div id="collabIdentPanel" class="sb-collab-ident-panel">
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

            <div class="sb-history-accordion-list">
              <div class="sb-accordion sb-history-accordion is-open" id="histAccJmb">
                <button type="button" class="sb-acc-head is-open" data-acc="jmb" aria-expanded="true">
                  <span class="sb-history-acc-title">
                    <span class="sb-history-acc-icon" aria-hidden="true">${collabIcon("school")}</span>
                    <span>Formations effectuées avec JMBCONSULTANT</span>
                  </span>
                  <span class="sb-acc-chevron">▾</span>
                </button>
                <div class="sb-acc-body" data-acc-body="jmb">
                  <div class="card-sub" style="margin:0;">Chargement…</div>
                </div>
              </div>

              <div class="sb-accordion sb-history-accordion" id="histAccOther">
                <button type="button" class="sb-acc-head" data-acc="other" aria-expanded="false">
                  <span class="sb-history-acc-title">
                    <span class="sb-history-acc-icon" aria-hidden="true">${collabIcon("org")}</span>
                    <span>Formations effectuées via autre organisme</span>
                  </span>
                  <span class="sb-acc-chevron">▾</span>
                </button>
                <div class="sb-acc-body" data-acc-body="other" style="display:none;">
                  <div class="sb-history-empty">${collabIcon("contract")}<span>Aucun élément.</span></div>
                </div>
              </div>

              <div class="sb-accordion sb-history-accordion" id="histAccAudits">
                <button type="button" class="sb-acc-head" data-acc="audits" aria-expanded="false">
                  <span class="sb-history-acc-title">
                    <span class="sb-history-acc-icon" aria-hidden="true">${collabIcon("audit")}</span>
                    <span>Audits des compétences</span>
                  </span>
                  <span class="sb-acc-chevron">▾</span>
                </button>
                <div class="sb-acc-body" data-acc-body="audits" style="display:none;">
                  <div class="sb-history-empty">${collabIcon("contract")}<span>Aucun élément.</span></div>
                </div>
              </div>

              <div class="sb-accordion sb-history-accordion" id="histAccCerts">
                <button type="button" class="sb-acc-head" data-acc="certs_hist" aria-expanded="false">
                  <span class="sb-history-acc-title">
                    <span class="sb-history-acc-icon" aria-hidden="true">${collabIcon("medal")}</span>
                    <span>Certifications</span>
                  </span>
                  <span class="sb-acc-chevron">▾</span>
                </button>
                <div class="sb-acc-body" data-acc-body="certs_hist" style="display:none;">
                  <div class="sb-history-empty">${collabIcon("contract")}<span>Aucun élément.</span></div>
                </div>
              </div>

              <div class="sb-accordion sb-history-accordion" id="histAccMoves">
                <button type="button" class="sb-acc-head" data-acc="moves" aria-expanded="false">
                  <span class="sb-history-acc-title">
                    <span class="sb-history-acc-icon" aria-hidden="true">${collabIcon("trend")}</span>
                    <span>Évolutions structurantes</span>
                  </span>
                  <span class="sb-acc-chevron">▾</span>
                </button>
                <div class="sb-acc-body" data-acc-body="moves" style="display:none;">
                  <div class="sb-history-empty">${collabIcon("contract")}<span>Aucun élément.</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

        // Onglets modal (Identification / Compétences / Certifications)
    if (body) {
      const tabs = Array.from(modal?.querySelectorAll("#collabModalTabbar [data-tab]") || []);
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
      setActiveTab("overview");

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
          <div class="modal-card modal-card--medium">
            <div class="modal-header">
              <div class="card-title" id="jmbDetailTitle">Détail formation</div>
              <button type="button" class="modal-x" id="btnCloseJmbDetailModal" aria-label="Fermer">×</button>
            </div>
            <div class="modal-body">
              <div class="card-sub" id="jmbDetailSub">Détail à venir</div>
              <div id="jmbDetailBody" class="sb-modal-content">
                <div class="card-sub" style="margin:0;">Contenu du détail non implémenté (volontairement).</div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="sb-btn sb-btn--soft" id="btnJmbDetailClose">Fermer</button>
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
          host.innerHTML = `<div class="sb-history-empty">${collabIcon("contract")}<span>Aucune formation trouvée.</span></div>`;
          return;
        }

        const fmtEtat = (s) => {
          const v = (s ?? "").toString().trim();
          return v ? v : "–";
        };

        const fmtEtatClass = (s) => {
          const v = (s ?? "").toString().trim().toLowerCase();
          if (v.includes("termin")) return "sb-collab-history-status--done";
          if (v.includes("démarr") || v.includes("demarr") || v.includes("cours")) return "sb-collab-history-status--blue";
          return "sb-collab-history-status--neutral";
        };

        const fmtFin = (x) => {
          return formatDateFR(x?.date_fin_formation || x?.date_debut_formation || null);
        };

        const fmtFormation = (x) => {
          const titre = x?.titre_formation ? escapeHtml(x.titre_formation) : "–";
          const code = x?.code_formation ? ` <span class="sb-collab-history-code">(${escapeHtml(x.code_formation)})</span>` : "";
          return `<div class="sb-collab-history-formation">${titre}${code}</div>`;
        };

        const rows = items.map((x) => {
          const codeAction = x?.code_action_formation ? escapeHtml(x.code_action_formation) : "–";
          const etat = fmtEtat(x?.etat_action);

          return `
            <tr>
              <td><span class="sb-collab-history-action-code">${codeAction}</span></td>
              <td>${fmtFormation(x)}</td>
              <td class="col-center">${escapeHtml(fmtFin(x))}</td>
              <td class="col-center">
                <span class="ns-badge sb-badge sb-collab-history-status ${fmtEtatClass(etat)}">${escapeHtml(etat)}</span>
              </td>
              <td class="col-center">
                <button type="button"
                        class="sb-btn sb-btn--soft sb-btn--xs"
                        data-jmb-detail="${escapeHtml(x.id_action_formation_effectif || "")}">
                  Détail
                </button>
              </td>
            </tr>
          `;
        }).join("");

        host.innerHTML = `
          <div class="sb-table-wrap">
            <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-history-table">
              <thead>
                <tr>
                  <th style="width:120px;">Code</th>
                  <th>Formation</th>
                  <th class="col-center" style="width:120px;">Fin</th>
                  <th class="col-center" style="width:130px;">État</th>
                  <th class="col-center" style="width:80px;">&nbsp;</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;

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

      tabs.forEach(btn => {
        if (btn.getAttribute("data-tab") === "history") {
          btn.addEventListener("click", () => {
            if (jmbHead?.getAttribute("aria-expanded") === "true") loadHistJmb(false);
          });
        }
      });



      // Chargement Vue d’ensemble
      const overviewHost = body.querySelector("#collabOverviewPanel");
      if (overviewHost) {
        const id_contact = window.portal?.contactId;

        if (!id_contact || !it?.id_effectif) {
          overviewHost.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur : identifiants manquants.</div>`;
        } else {
          Promise.all([
            loadIdentification(id_contact, it.id_effectif),
            loadCompetences(id_contact, it.id_effectif),
            loadCertifications(id_contact, it.id_effectif),
            loadHistoriqueFormationsJmb(id_contact, it.id_effectif, null, false),
          ])
            .then(async ([ident, skillsData, certsData, formationsData]) => {
              const skills = Array.isArray(skillsData?.items) ? skillsData.items : [];
              const certs = Array.isArray(certsData?.items) ? certsData.items : [];
              const formations = Array.isArray(formationsData?.items) ? formationsData.items : [];
              const requiredSkills = skills.filter(x => !!x?.is_required);

              const order = { A: 1, B: 2, C: 3, D: 4 };
              const levelKey = (v) => (window.NovoskillLevels && typeof window.NovoskillLevels.key === "function")
                ? window.NovoskillLevels.key(v)
                : String(v || "").trim().toUpperCase().slice(0, 1);

              const validatedSkills = requiredSkills.filter(x => {
                const current = levelKey(x?.niveau_actuel);
                const required = levelKey(x?.niveau_requis);
                return !!current && !!required && (order[current] || 0) >= (order[required] || 0);
              }).length;

              const notEvaluatedSkills = requiredSkills.filter(x => !String(x?.niveau_actuel || "").trim()).length;
              const skillsToStrengthen = Math.max(0, requiredSkills.length - validatedSkills - notEvaluatedSkills);
              const acquiredCerts = certs.filter(x => !!x?.is_acquired).length;
              const validCerts = certs.filter(x => String(x?.statut_validite || "").toLowerCase() === "valide").length;
              const renewCerts = certs.filter(x => String(x?.statut_validite || "").toLowerCase() === "a_renouveler").length;
              const expiredCerts = certs.filter(x => String(x?.statut_validite || "").toLowerCase() === "expiree").length;
              const adequationPercent = requiredSkills.length
                ? Math.round((validatedSkills / requiredSkills.length) * 100)
                : 0;
              const adequationHue = Math.round((Math.max(0, Math.min(100, adequationPercent)) / 100) * 120);
              const levelCounts = { A: 0, B: 0, C: 0, D: 0 };
              skills.forEach((skill) => {
                const current = levelKey(skill?.niveau_actuel);
                if (Object.prototype.hasOwnProperty.call(levelCounts, current)) levelCounts[current] += 1;
              });

              const formatDate = (iso) => {
                const raw = String(iso || "").trim();
                if (!raw) return "–";
                const parsed = new Date(raw);
                if (Number.isNaN(parsed.getTime())) return "–";
                return parsed.toLocaleDateString("fr-FR");
              };

              const latestByDate = (items, fields) => {
                return [...items].sort((a, b) => {
                  const dateA = fields.map(field => a?.[field]).find(Boolean);
                  const dateB = fields.map(field => b?.[field]).find(Boolean);
                  return new Date(dateB || 0).getTime() - new Date(dateA || 0).getTime();
                })[0] || null;
              };

              const latestEvaluatedSkill = latestByDate(
                skills.filter(skill => skill?.date_derniere_eval),
                ["date_derniere_eval"]
              );
              const latestFormation = latestByDate(
                formations,
                ["date_fin_formation", "date_debut_formation"]
              );
              const latestCertification = latestByDate(
                certs.filter(cert => cert?.is_acquired),
                ["date_obtention", "date_expiration_calculee", "date_expiration"]
              );
              const nearestCertification = [...certs]
                .filter(cert => cert?.is_acquired && (cert?.date_expiration_calculee || cert?.date_expiration))
                .sort((a, b) => new Date(a.date_expiration_calculee || a.date_expiration).getTime() - new Date(b.date_expiration_calculee || b.date_expiration).getTime())[0] || null;

              const activityRows = [
                {
                  icon: "audit",
                  title: "Dernière évaluation",
                  detail: latestEvaluatedSkill
                    ? `${latestEvaluatedSkill.code ? `${latestEvaluatedSkill.code} · ` : ""}${latestEvaluatedSkill.intitule || "Compétence évaluée"}`
                    : "Aucune évaluation enregistrée",
                  meta: latestEvaluatedSkill ? formatDate(latestEvaluatedSkill.date_derniere_eval) : "–",
                },
                {
                  icon: "graduation",
                  title: "Dernière formation",
                  detail: latestFormation?.titre_formation || "Aucune formation enregistrée",
                  meta: latestFormation ? formatDate(latestFormation.date_fin_formation || latestFormation.date_debut_formation) : "–",
                },
                {
                  icon: "certs",
                  title: "Dernière certification",
                  detail: latestCertification?.nom_certification || "Aucune certification enregistrée",
                  meta: latestCertification
                    ? (latestCertification.date_expiration_calculee || latestCertification.date_expiration
                      ? `Valide jusqu’au ${formatDate(latestCertification.date_expiration_calculee || latestCertification.date_expiration)}`
                      : formatDate(latestCertification.date_obtention))
                    : "–",
                },
                {
                  icon: "calendar",
                  title: "Prochaine échéance RH",
                  detail: nearestCertification?.nom_certification || "Aucune échéance identifiée",
                  meta: nearestCertification
                    ? `Échéance : ${formatDate(nearestCertification.date_expiration_calculee || nearestCertification.date_expiration)}`
                    : "–",
                },
              ];

              const attentionRows = [
                requiredSkills.length && validatedSkills === requiredSkills
                  ? { state: "ok", title: "Aucun point bloquant", detail: "Toutes les compétences requises sont maîtrisées." }
                  : { state: "danger", title: `${requiredSkills.length - validatedSkills} compétence${requiredSkills.length - validatedSkills > 1 ? "s" : ""} à renforcer`, detail: "Le niveau requis du poste reste à atteindre." },
                renewCerts || expiredCerts
                  ? { state: "warning", title: `${renewCerts + expiredCerts} certification${renewCerts + expiredCerts > 1 ? "s" : ""} à surveiller`, detail: expiredCerts ? `${expiredCerts} expirée${expiredCerts > 1 ? "s" : ""}` : "Renouvellement prochain" }
                  : { state: "ok", title: "Certifications à jour", detail: "Aucune certification à renouveler prochainement." },
                skillsToStrengthen || notEvaluatedSkills
                  ? { state: "info", title: "1 action RH à planifier", detail: notEvaluatedSkills ? "Planifier les évaluations manquantes." : "Prévoir une action de développement des compétences." }
                  : { state: "ok", title: "Aucune action RH prioritaire", detail: "La situation ne nécessite pas d’action immédiate." },
              ];

              const formatSeniority = (iso) => {
                const raw = String(iso || "").trim();
                if (!raw) return "–";
                const start = new Date(raw);
                if (Number.isNaN(start.getTime())) return "–";
                const now = new Date();
                let years = now.getFullYear() - start.getFullYear();
                const anniversaryPending = now.getMonth() < start.getMonth()
                  || (now.getMonth() === start.getMonth() && now.getDate() < start.getDate());
                if (anniversaryPending) years -= 1;
                if (years <= 0) return "Moins d’un an";
                return `${years} an${years > 1 ? "s" : ""}`;
              };

              let unavailableToday = false;
              try {
                unavailableToday = await isEffectifIndispoToday(id_contact, it.id_effectif);
              } catch (_) {}

              const roles = [];
              if (ident?.ismanager) roles.push("Manager");
              if (ident?.isformateur) roles.push("Formateur");
              if (ident?.is_temp) roles.push("Temporaire");

              const statusLabel = ident?.archive
                ? "Archivé"
                : (ident?.statut_actif ? (unavailableToday ? "Indisponible" : "Actif") : "Inactif");

              const statusBadgeClass = ident?.archive || !ident?.statut_actif
                ? "ns-badge-status--neutral"
                : (unavailableToday ? "ns-badge-status--warning" : "ns-badge-status--success");

              overviewHost.innerHTML = `
                <div class="sb-collab-metrics">
                  <section class="sb-collab-block collab-kpi-card--manager studio-poste-overview-card">
                    <div class="studio-poste-overview-card__head">
                      <span class="studio-poste-overview-card__icon studio-poste-overview-card__icon--blue" aria-hidden="true">${collabIcon("user")}</span>
                      <div class="studio-rh-panel-title">Situation</div>
                    </div>
                    <div class="studio-poste-overview-list">
                      <div><span class="sb-modal-titleline"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-calendar"></use></svg>Ancienneté</span><strong>${escapeHtml(formatSeniority(ident?.date_entree_entreprise_effectif))}</strong></div>
                      <div><span class="sb-modal-titleline"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-legacy-c489f3162892"></use></svg>Type de contrat</span><strong>${escapeHtml(ident?.type_contrat || "–")}</strong></div>
                      <div><span class="sb-modal-titleline"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-user"></use></svg>Statut</span><strong><span class="ns-badge ns-badge-status ${statusBadgeClass}">${escapeHtml(statusLabel)}</span></strong></div>
                      <div><span class="sb-modal-titleline"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-organisation"></use></svg>Service</span><strong>${escapeHtml(ident?.nom_service || it?.nom_service || "–")}</strong></div>
                    </div>
                  </section>

                  <section class="sb-collab-block collab-kpi-card--manager studio-poste-overview-card">
                    <div class="studio-poste-overview-card__head">
                      <span class="studio-poste-overview-card__icon" aria-hidden="true">${collabIcon("skills")}</span>
                      <div class="studio-rh-panel-title">Compétences</div>
                    </div>
                    <div class="studio-poste-overview-list">
                      <div>
                        <span aria-hidden="true"></span>
                        <span class="sb-modal-titleline">
                          <span>Maitrise du poste</span>
                          <span class="sim-result-modern-ring" style="--sim-ring:${adequationPercent};--accent:hsl(${adequationHue} 72% 42%)">
                            <span>${adequationPercent}%</span>
                          </span>
                        </span>
                      </div>
                      <div><span class="sb-modal-titleline"><span class="ns-badge ns-badge-level ns-badge-level--beginner">Débutant</span><strong style="color:var(--ns-danger-text)">${levelCounts.A}</strong> compétence${levelCounts.A > 1 ? "s" : ""} acquise${levelCounts.A > 1 ? "s" : ""} au niveau Débutant</span></div>
                      <div><span class="sb-modal-titleline"><span class="ns-badge ns-badge-level ns-badge-level--intermediate">Intermédiaire</span><strong style="color:var(--ns-warning-text)">${levelCounts.B}</strong> compétence${levelCounts.B > 1 ? "s" : ""} acquise${levelCounts.B > 1 ? "s" : ""} au niveau Intermédiaire</span></div>
                      <div><span class="sb-modal-titleline"><span class="ns-badge ns-badge-level ns-badge-level--advanced">Avancé</span><strong style="color:var(--ns-info-text)">${levelCounts.C}</strong> compétence${levelCounts.C > 1 ? "s" : ""} acquise${levelCounts.C > 1 ? "s" : ""} au niveau Avancé</span></div>
                      <div><span class="sb-modal-titleline"><span class="ns-badge ns-badge-level ns-badge-level--expert">Expert</span><strong style="color:var(--ns-success-text)">${levelCounts.D}</strong> compétence${levelCounts.D > 1 ? "s" : ""} acquise${levelCounts.D > 1 ? "s" : ""} au niveau Expert</span></div>
                    </div>
                    <button type="button" class="studio-poste-overview-link" data-overview-tab="skills">Voir le détail des compétences →</button>
                  </section>

                  <section class="sb-collab-block collab-kpi-card--formateur studio-poste-overview-card">
                    <div class="studio-poste-overview-card__head">
                      <span class="studio-poste-overview-card__icon studio-poste-overview-card__icon--violet" aria-hidden="true">${collabIcon("certs")}</span>
                      <div class="studio-rh-panel-title">Certifications</div>
                    </div>
                    <div class="studio-poste-overview-list">
                      <div><span class="sb-modal-titleline"><span class="sb-tip-dot sb-tip-dot--g" aria-hidden="true"></span><strong>${validCerts}</strong><span>Certification valide</span></span></div>
                      <div><span class="sb-modal-titleline"><span class="sb-tip-dot sb-tip-dot--y" aria-hidden="true"></span><strong>${renewCerts}</strong><span>À renouveler prochainement</span></span></div>
                      <div><span class="sb-modal-titleline"><span class="sb-tip-dot sb-tip-dot--r" aria-hidden="true"></span><strong>${expiredCerts}</strong><span>Expirée</span></span></div>
                    </div>
                    <button type="button" class="studio-poste-overview-link" data-overview-tab="certs">Voir le détail des certifications →</button>
                  </section>
                </div>

                <div class="sb-collab-overview-secondary">
                  <section class="sb-collab-block studio-poste-overview-card">
                    <div class="studio-poste-overview-card__head">
                      <span class="studio-poste-overview-card__icon studio-poste-overview-card__icon--blue" aria-hidden="true">${collabIcon("history")}</span>
                      <div class="studio-rh-panel-title">Activité récente</div>
                    </div>
                    <div class="sb-collab-overview-events">
                      ${activityRows.map(row => `
                        <div class="sb-collab-overview-event">
                          <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon(row.icon)}</span>
                          <span class="sb-collab-overview-event__content">
                            <strong>${escapeHtml(row.title)}</strong>
                            <span>${escapeHtml(row.detail)}</span>
                          </span>
                          <span class="sb-collab-overview-event__meta">${escapeHtml(row.meta)}</span>
                        </div>
                      `).join("")}
                    </div>
                  </section>

                  <section class="sb-collab-block studio-poste-overview-card">
                    <div class="studio-poste-overview-card__head">
                      <span class="studio-poste-overview-card__icon studio-poste-overview-card__icon--orange" aria-hidden="true">${collabIcon("trend")}</span>
                      <div class="studio-rh-panel-title">Points d’attention</div>
                    </div>
                    <div class="sb-collab-overview-events">
                      ${attentionRows.map(row => `
                        <div class="sb-collab-overview-event">
                          <span class="sb-collab-overview-state sb-collab-overview-state--${row.state}" aria-hidden="true"></span>
                          <span class="sb-collab-overview-event__content">
                            <strong>${escapeHtml(row.title)}</strong>
                            <span>${escapeHtml(row.detail)}</span>
                          </span>
                        </div>
                      `).join("")}
                    </div>
                  </section>
                </div>
              `;

              overviewHost.querySelectorAll("[data-overview-tab]").forEach((button) => {
                button.addEventListener("click", () => {
                  const tab = button.getAttribute("data-overview-tab");
                  modal?.querySelector(`[data-tab="${tab}"]`)?.click();
                });
              });
            })
            .catch(e => {
              overviewHost.innerHTML = `<div class="card-sub" style="margin:0; color:#b91c1c;">Erreur chargement vue d’ensemble : ${escapeHtml(e.message || String(e))}</div>`;
              console.error(e);
            });
        }
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

              // Le header conserve uniquement les rôles sous forme de badges.
              const roleBadges = [];
              if (d.is_temp) roleBadges.push({ label: "Temp", cls: getCollaborateurRoleClass("Temporaire") });
              if (d.ismanager) roleBadges.push({ label: "Manager", cls: getCollaborateurRoleClass("Manager") });
              if (d.isformateur) roleBadges.push({ label: "Formateur", cls: getCollaborateurRoleClass("Formateur") });

              const headerBadges = byId("collabModalBadges");
              if (headerBadges) {
                headerBadges.innerHTML = roleBadges
                  .map(b => `<span class="${escapeHtml(b.cls)}">${escapeHtml(b.label)}</span>`)
                  .join("");
              }

              let indisponible = false;
              try {
                indisponible = await isEffectifIndispoToday(id_contact, it.id_effectif);
              } catch (_) {}

              const headerStatus = byId("collabModalStatus");
              if (headerStatus) {
                const statusClass = d.archive
                  ? "ns-collab-status--archived"
                  : (d.statut_actif
                    ? (indisponible ? "ns-collab-status--unavailable" : "ns-collab-status--active")
                    : "ns-collab-status--inactive");
                const statusLabel = d.archive
                  ? "Archivé"
                  : (d.statut_actif ? (indisponible ? "Indisponible" : "Actif") : "Inactif");
                headerStatus.className = `ns-collab-status ${statusClass} sb-collab-profile-status`;
                headerStatus.setAttribute("aria-label", `Statut : ${statusLabel}`);
              }

              setText("collabModalPoste", d.intitule_poste || "–");
              setText("collabModalService", d.nom_service || "–");
              setText("collabModalDateEntree", formatDateFR(d.date_entree_entreprise_effectif));
              setText("collabModalContrat", d.type_contrat || "–");
              setText("collabModalDatePoste", formatDateFR(d.date_debut_poste_actuel));
              setText("collabModalManager", "–");


              // Civilité: alignement Studio (M. / Mme / -)
              const civLabel = normalizeCiviliteLabel(d.civilite_label || d.civilite_effectif);

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
                <div class="sb-collab-ident-main">
                  <div class="sb-collab-block sb-collab-block--personal">
                    <div class="sb-collab-block-title">
                      <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon("user")}</span>
                      <span>Identité et coordonnées</span>
                      <div class="sb-collab-ident-actions sb-modal-edit-actions">
                        <span class="sb-collab-inline-msg sb-modal-inline-msg" aria-live="polite"></span>
                        <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="collabBtnCancel" style="display:none;">
                          <span class="sb-btn-icon" aria-hidden="true">${collabIcon("cancel")}</span>
                          Annuler
                        </button>
                        <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="collabBtnSave" style="display:none;">
                          <span class="sb-btn-icon" aria-hidden="true">${collabIcon("save")}</span>
                          Enregistrer
                        </button>
                        <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="collabBtnEdit" title="Modifier" aria-label="Modifier l’identité et les coordonnées">
                          ${collabIcon("edit")}
                        </button>
                      </div>
                    </div>
                    <div class="sb-collab-ident-read-grid">
                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("user")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Nom</span>
                            <strong id="collabNameRead">${escapeHtml([civLabel, v(d.prenom_effectif), v(d.nom_effectif)].filter(Boolean).join(" "))}</strong>
                            <span class="sb-collab-name-fields" id="collabNameEdit" hidden>
                              <span class="sb-field sb-collab-name-field sb-collab-name-field--civ">
                                <label class="sb-label" for="collabCiv">Civ.</label>
                                <select class="sb-select" id="collabCiv" disabled>
                                  <option value="M."${civLabel === "M." ? " selected" : ""}>M.</option>
                                  <option value="Mme"${civLabel === "Mme" ? " selected" : ""}>Mme</option>
                                  <option value="-"${civLabel === "-" ? " selected" : ""}>-</option>
                                </select>
                              </span>
                              <span class="sb-field sb-collab-name-field sb-collab-name-field--prenom">
                                <label class="sb-label" for="collabPrenom">Prénom</label>
                                <input class="sb-ctrl" id="collabPrenom" type="text" value="${escapeHtml(v(d.prenom_effectif))}" disabled />
                              </span>
                              <span class="sb-field sb-collab-name-field sb-collab-name-field--nom">
                                <label class="sb-label" for="collabNom">Nom</label>
                                <input class="sb-ctrl" id="collabNom" type="text" value="${escapeHtml(v(d.nom_effectif))}" disabled />
                              </span>
                            </span>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("comment")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Email</span>
                            <strong id="collabEmailRead">${escapeHtml(v(d.email_effectif))}</strong>
                            <span id="collabEmailEdit" hidden>
                              <input class="sb-ctrl" id="collabEmail" type="text" value="${escapeHtml(v(d.email_effectif))}" disabled />
                            </span>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item sb-collab-summary-item--address">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("building")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Adresse</span>
                            <strong class="sb-collab-address-fields" id="collabAddressRead">
                              <span id="collabAddressReadLine1">${escapeHtml(v(d.adresse_effectif))}</span>
                              <span id="collabAddressReadLine2">${escapeHtml([v(d.code_postal_effectif), v(d.ville_effectif)].filter(Boolean).join(" "))}</span>
                            </strong>
                            <span class="sb-collab-address-fields" id="collabAddressEdit" hidden>
                              <span class="sb-field sb-collab-address-field sb-collab-address-field--street">
                                <label class="sb-label" for="collabAdr">Adresse</label>
                                <input class="sb-ctrl" id="collabAdr" type="text" value="${escapeHtml(v(d.adresse_effectif))}" disabled />
                              </span>
                              <span class="sb-collab-address-line">
                                <span class="sb-field sb-collab-address-field sb-collab-address-field--cp">
                                  <label class="sb-label" for="collabCP">Code postal</label>
                                  <input class="sb-ctrl" id="collabCP" type="text" value="${escapeHtml(v(d.code_postal_effectif))}" disabled />
                                </span>
                                <span class="sb-field sb-collab-address-field sb-collab-address-field--city">
                                  <label class="sb-label" for="collabVille">Ville</label>
                                  <input class="sb-ctrl" id="collabVille" type="text" value="${escapeHtml(v(d.ville_effectif))}" disabled />
                                </span>
                              </span>
                            </span>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("globe")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Pays</span>
                            <strong id="collabPaysRead">${escapeHtml(v(d.pays_effectif))}</strong>
                            <span id="collabPaysEdit" hidden>
                              <input class="sb-ctrl" id="collabPays" type="text" value="${escapeHtml(v(d.pays_effectif))}" disabled />
                            </span>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("phone")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Téléphone</span>
                            <strong id="collabTelRead">${escapeHtml(formatPhoneFr(d.telephone_effectif))}</strong>
                            <span id="collabTelEdit" hidden>
                              <input class="sb-ctrl" id="collabTel" type="text" inputmode="numeric" maxlength="14" placeholder="00 00 00 00 00" value="${escapeHtml(formatPhoneFr(d.telephone_effectif))}" disabled />
                            </span>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-summary-strip">
                        <div class="sb-collab-summary-item">
                          <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("calendar")}</span>
                          <span>
                            <span class="sb-collab-summary-label">Date de naissance</span>
                            <strong id="collabNaissanceRead">${escapeHtml(formatDateFR(d.date_naissance_effectif))}</strong>
                            <span id="collabNaissanceEdit" hidden>
                              <input class="sb-ctrl" id="collabNaissance" type="date" value="${escapeHtml(dateNaiss)}" disabled />
                            </span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="sb-collab-block sb-collab-block--company">
                    <div class="sb-collab-block-title">
                      <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon("briefcase")}</span>
                      <span>Situation dans l'entreprise</span>
                      <div class="sb-collab-ident-actions sb-modal-edit-actions">
                        <span class="sb-collab-inline-msg sb-modal-inline-msg" aria-live="polite"></span>
                        <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="collabCompanyBtnCancel" style="display:none;">
                          <span class="sb-btn-icon" aria-hidden="true">${collabIcon("cancel")}</span>
                          Annuler
                        </button>
                        <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="collabCompanyBtnSave" style="display:none;">
                          <span class="sb-btn-icon" aria-hidden="true">${collabIcon("save")}</span>
                          Enregistrer
                        </button>
                        <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="collabCompanyBtnEdit" title="Modifier" aria-label="Modifier la situation dans l’entreprise">
                          ${collabIcon("edit")}
                        </button>
                      </div>
                    </div>
                    <div class="sb-collab-company-rows">
                      <div class="sb-collab-company-row">
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Matricule</span>
                          <strong id="collabMatriculeRead">${vDash(d.matricule)}</strong>
                          <span id="collabMatriculeEdit" style="display:none;">
                            <input class="sb-ctrl" id="collabMatricule" type="text" value="${escapeHtml(v(d.matricule))}" disabled />
                          </span>
                        </div>
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Service</span>
                          <strong id="collabServiceRead">${vDash(d.nom_service)}</strong>
                          <span id="collabServiceEdit" style="display:none;">
                            <select class="sb-select" id="collabService" disabled>
                              <option value="">Chargement…</option>
                            </select>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-company-row">
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Poste actuel</span>
                          <strong id="collabPosteRead">${vDash(d.intitule_poste)}</strong>
                          <span id="collabPosteEdit" style="display:none;">
                            <select class="sb-select" id="collabPoste" disabled>
                              <option value="">Chargement…</option>
                            </select>
                          </span>
                        </div>
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Type de contrat</span>
                          <strong id="collabContratRead">${vDash(d.type_contrat)}</strong>
                          <span id="collabContratEdit" style="display:none;">
                            <select class="sb-select" id="collabContrat" disabled>
                              <option value=""></option>
                              ${contratOptions.map(x => {
                                const sel = (String(d.type_contrat || "").trim() === x) ? " selected" : "";
                                return `<option value="${escapeHtml(x)}"${sel}>${escapeHtml(x)}</option>`;
                              }).join("")}
                            </select>
                          </span>
                        </div>
                      </div>

                      <div class="sb-collab-company-row">
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Date d'entrée</span>
                          <strong id="collabEntreeRead">${escapeHtml(formatDateFR(d.date_entree_entreprise_effectif) || "–")}</strong>
                          <span id="collabEntreeEdit" style="display:none;">
                            <input class="sb-ctrl" id="collabEntree" type="date" value="${escapeHtml(dateEntree)}" disabled />
                          </span>
                        </div>
                        <div class="sb-collab-company-cell">
                          <span class="sb-collab-summary-label">Début dans le poste</span>
                          <strong id="collabDebutPosteRead">${escapeHtml(formatDateFR(d.date_debut_poste_actuel) || "–")}</strong>
                          <span id="collabDebutPosteEdit" style="display:none;">
                            <input class="sb-ctrl" id="collabDebutPoste" type="date" value="${escapeHtml(dateDebutPoste)}" disabled />
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="sb-collab-block sb-collab-block--projection">
                  <div class="sb-collab-block-title">
                    <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon("graduation")}</span>
                    <span>Parcours et projection</span>
                    <div class="sb-collab-ident-actions sb-modal-edit-actions">
                      <span class="sb-collab-inline-msg sb-modal-inline-msg" aria-live="polite"></span>
                      <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="collabProjectionBtnCancel" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("cancel")}</span>
                        Annuler
                      </button>
                      <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="collabProjectionBtnSave" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("save")}</span>
                        Enregistrer
                      </button>
                      <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="collabProjectionBtnEdit" title="Modifier" aria-label="Modifier le parcours et la projection">
                        ${collabIcon("edit")}
                      </button>
                    </div>
                  </div>
                  <div class="sb-collab-projection-content">
                    <section class="sb-collab-projection-zone sb-collab-projection-zone--formation">
                      <div class="sb-collab-projection-zone-title">
                        <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("graduation")}</span>
                        <span>Formation</span>
                      </div>
                      <div class="sb-collab-projection-formation-grid">
                        <input type="hidden" id="collabDist" value="${escapeHtml(safeNum(d.distance_km_entreprise))}" />
                        <div class="sb-collab-projection-item">
                          <span class="sb-collab-summary-label">Dernier diplôme obtenu</span>
                          <strong id="collabEduNivRead">${escapeHtml(eduLabel || "–")}</strong>
                          <span id="collabEduNivEdit" style="display:none;">
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
                          </span>
                        </div>

                        <div class="sb-collab-projection-item sb-collab-projection-item--wide">
                          <span class="sb-collab-summary-label">Domaine d'éducation</span>
                          <strong id="collabEduDomRead">${vDash(d.domaine_education)}</strong>
                          <span id="collabEduDomEdit" style="display:none;">
                            <select class="sb-select" id="collabEduDom" disabled>
                              <option value="">Chargement…</option>
                            </select>
                          </span>
                        </div>
                      </div>
                    </section>

                    <section class="sb-collab-projection-zone sb-collab-projection-zone--projection">
                      <div class="sb-collab-block-subtitle">Projection</div>
                      <div class="sb-collab-projection-compact-grid">
                        <div class="sb-collab-projection-item">
                          <span class="sb-collab-summary-label">Retraite estimée</span>
                          <strong id="collabRetraiteRead">${d.retraite_estimee != null && d.retraite_estimee !== "" ? escapeHtml(String(d.retraite_estimee)) : "–"}</strong>
                          <span id="collabRetraiteEdit" style="display:none;">
                            <input class="sb-ctrl" id="collabRetraite" type="text" value="${d.retraite_estimee != null && d.retraite_estimee !== "" ? escapeHtml(String(d.retraite_estimee)) : ""}" disabled />
                          </span>
                        </div>

                        <div class="sb-collab-projection-item">
                          <span class="sb-collab-summary-label">Sortie prévue</span>
                          <strong id="collabSortieRead">${hasSortie ? "Oui" : "Non"}</strong>
                          <label class="sb-check sb-collab-sortie-check" id="collabSortieEdit" style="display:none;">
                            <input id="collabChkSortie" type="checkbox" ${hasSortie ? "checked" : ""} disabled />
                            <span>Sortie prévue</span>
                          </label>
                        </div>

                        <div class="sb-collab-projection-item">
                          <span class="sb-collab-summary-label">Date de sortie prévue</span>
                          <strong id="collabDateSortieRead">${escapeHtml(formatDateFR(d.date_sortie_prevue) || "–")}</strong>
                          <span id="collabDateSortieEdit" style="display:none;">
                            <input class="sb-ctrl" id="collabDateSortie" type="date" value="${escapeHtml(dateSortie)}" disabled />
                          </span>
                        </div>

                        <div class="sb-collab-projection-item">
                          <span class="sb-collab-summary-label">Motif de sortie</span>
                          <strong id="collabMotifSortieRead">${vDash(d.motif_sortie)}</strong>
                          <span id="collabMotifSortieEdit" style="display:none;">
                            <select class="sb-select" id="collabMotifSortie" disabled>
                              <option value=""></option>
                              ${motifOptions.map(x => {
                                const sel = (String(d.motif_sortie || "").trim() === x) ? " selected" : "";
                                return `<option value="${escapeHtml(x)}"${sel}>${escapeHtml(x)}</option>`;
                              }).join("")}
                            </select>
                          </span>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>

                <div class="sb-collab-block sb-collab-block--roles">
                  <div class="sb-collab-block-title">
                    <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon("org")}</span>
                    <span>Rôles et responsabilités</span>
                    <div class="sb-collab-ident-actions sb-modal-edit-actions">
                      <span class="sb-collab-inline-msg sb-modal-inline-msg" aria-live="polite"></span>
                      <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="collabRolesBtnCancel" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("cancel")}</span>
                        Annuler
                      </button>
                      <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="collabRolesBtnSave" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("save")}</span>
                        Enregistrer
                      </button>
                      <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="collabRolesBtnEdit" title="Modifier" aria-label="Modifier les rôles et responsabilités">
                        ${collabIcon("edit")}
                      </button>
                    </div>
                  </div>
                  <div class="sb-collab-roles-grid">
                    <div class="sb-collab-role-item ${getCollaborateurRoleContextClass("Manager")}">
                      <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("user")}</span>
                      <span>
                        <span class="sb-collab-summary-label">Manager</span>
                        <strong id="collabIsManagerRead" class="${d.ismanager ? "is-positive" : ""}">${d.ismanager ? "Oui" : "Non"}</strong>
                        <label class="sb-check sb-collab-role-check" id="collabIsManagerEdit" style="display:none;">
                          <input id="collabIsManager" type="checkbox" ${d.ismanager ? "checked" : ""} disabled />
                          <span>Manager</span>
                        </label>
                      </span>
                    </div>

                    <div class="sb-collab-role-item ${getCollaborateurRoleContextClass("Formateur")}">
                      <span class="sb-collab-summary-icon" aria-hidden="true">${collabIcon("graduation")}</span>
                      <span>
                        <span class="sb-collab-summary-label">Formateur</span>
                        <strong id="collabIsFormateurRead" class="${d.isformateur ? "is-positive" : ""}">${d.isformateur ? "Oui" : "Non"}</strong>
                        <label class="sb-check sb-collab-role-check" id="collabIsFormateurEdit" style="display:none;">
                          <input id="collabIsFormateur" type="checkbox" ${d.isformateur ? "checked" : ""} disabled />
                          <span>Formateur</span>
                        </label>
                      </span>
                    </div>
                  </div>
                </div>

                <div class="sb-collab-block sb-collab-comment-card">
                  <div class="sb-collab-block-title">
                    <span class="sb-collab-overview-event__icon" aria-hidden="true">${collabIcon("comment")}</span>
                    <span>Commentaire interne</span>
                    <div class="sb-collab-ident-actions sb-modal-edit-actions">
                      <span class="sb-collab-inline-msg sb-modal-inline-msg" aria-live="polite"></span>
                      <button type="button" class="sb-btn sb-btn--soft sb-modal-btn sb-modal-btn--cancel" id="collabCommentBtnCancel" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("cancel")}</span>
                        Annuler
                      </button>
                      <button type="button" class="sb-btn sb-btn--accent sb-modal-btn sb-modal-btn--save" id="collabCommentBtnSave" style="display:none;">
                        <span class="sb-btn-icon" aria-hidden="true">${collabIcon("save")}</span>
                        Enregistrer
                      </button>
                      <button type="button" class="sb-icon-btn sb-modal-btn sb-modal-btn--edit" id="collabCommentBtnEdit" title="Modifier" aria-label="Modifier le commentaire interne">
                        ${collabIcon("edit")}
                      </button>
                    </div>
                  </div>
                  <div class="sb-field">
                    <textarea class="sb-ctrl" id="collabComment" disabled>${escapeHtml(v(d.note_commentaire))}</textarea>
                  </div>
                </div>
              `;

              // -------------------------
              // Mode édition ciblé sur la carte Identité et coordonnées
              // -------------------------
              const editBtn = identHost.querySelector("#collabBtnEdit");
              const saveBtn = identHost.querySelector("#collabBtnSave");
              const cancelBtn = identHost.querySelector("#collabBtnCancel");
              const personalActions = saveBtn?.closest(".sb-collab-ident-actions") || identHost;

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
              ];

              const companyEditableSelectors = [
                "#collabMatricule",
                "#collabService",
                "#collabPoste",
                "#collabEntree",
                "#collabDebutPoste",
                "#collabContrat",
              ];

              const projectionEditableSelectors = [
                "#collabEduNiv",
                "#collabEduDom",
                "#collabRetraite",
                "#collabChkSortie",
                "#collabDateSortie",
                "#collabMotifSortie",
              ];

              const commentEditableSelectors = [
                "#collabComment",
              ];

              const roleEditableSelectors = [
                "#collabIsManager",
                "#collabIsFormateur",
              ];

              const getEditableNodes = () => {
                return editableSelectors
                  .map(sel => identHost.querySelector(sel))
                  .filter(Boolean);
              };

              const getCompanyEditableNodes = () => {
                return companyEditableSelectors
                  .map(sel => identHost.querySelector(sel))
                  .filter(Boolean);
              };

              const getProjectionEditableNodes = () => {
                return projectionEditableSelectors
                  .map(sel => identHost.querySelector(sel))
                  .filter(Boolean);
              };

              const getCommentEditableNodes = () => {
                return commentEditableSelectors
                  .map(sel => identHost.querySelector(sel))
                  .filter(Boolean);
              };

              const getRoleEditableNodes = () => {
                return roleEditableSelectors
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

              const snapshotCompanyValues = () => {
                const snap = {};
                companyEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  snap[sel] = el.value;
                });
                return snap;
              };

              const snapshotProjectionValues = () => {
                const snap = {};
                projectionEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  snap[sel] = el.type === "checkbox" ? !!el.checked : el.value;
                });
                return snap;
              };

              const snapshotCommentValues = () => {
                const snap = {};
                commentEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  snap[sel] = el.value;
                });
                return snap;
              };

              const snapshotRoleValues = () => {
                const snap = {};
                roleEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  snap[sel] = !!el.checked;
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

              const restoreCompanyValues = (snap) => {
                if (!snap) return;
                companyEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  el.value = (snap[sel] ?? "");
                });
              };

              const restoreProjectionValues = (snap) => {
                if (!snap) return;
                projectionEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  if (el.type === "checkbox") el.checked = !!snap[sel];
                  else el.value = (snap[sel] ?? "");
                });
              };

              const restoreCommentValues = (snap) => {
                if (!snap) return;
                commentEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  el.value = (snap[sel] ?? "");
                });
              };

              const restoreRoleValues = (snap) => {
                if (!snap) return;
                roleEditableSelectors.forEach(sel => {
                  const el = identHost.querySelector(sel);
                  if (!el) return;
                  el.checked = !!snap[sel];
                });
              };

              const syncIdentityReadValues = () => {
                const readName = identHost.querySelector("#collabNameRead");
                const readAddressLine1 = identHost.querySelector("#collabAddressReadLine1");
                const readAddressLine2 = identHost.querySelector("#collabAddressReadLine2");
                const readEmail = identHost.querySelector("#collabEmailRead");
                const readPays = identHost.querySelector("#collabPaysRead");
                const readTel = identHost.querySelector("#collabTelRead");
                const readNaissance = identHost.querySelector("#collabNaissanceRead");
                const valueOf = (selector) => {
                  const node = identHost.querySelector(selector);
                  return node ? String(node.value || "").trim() : "";
                };

                if (readName) {
                  readName.textContent = [valueOf("#collabCiv"), valueOf("#collabPrenom"), valueOf("#collabNom")]
                    .filter(Boolean)
                    .join(" ");
                }
                if (readAddressLine1) readAddressLine1.textContent = valueOf("#collabAdr");
                if (readAddressLine2) {
                  readAddressLine2.textContent = [valueOf("#collabCP"), valueOf("#collabVille")]
                    .filter(Boolean)
                    .join(" ");
                }
                if (readEmail) readEmail.textContent = valueOf("#collabEmail");
                if (readPays) readPays.textContent = valueOf("#collabPays");
                if (readTel) readTel.textContent = formatPhoneFr(valueOf("#collabTel"));
                if (readNaissance) readNaissance.textContent = formatDateFR(valueOf("#collabNaissance"));
              };

              const syncCompanyReadValues = () => {
                const valueOf = (selector) => {
                  const node = identHost.querySelector(selector);
                  return node ? String(node.value || "").trim() : "";
                };
                const selectedLabel = (selector) => {
                  const node = identHost.querySelector(selector);
                  if (!node) return "";
                  const opt = node.options && node.selectedIndex >= 0 ? node.options[node.selectedIndex] : null;
                  return opt ? String(opt.textContent || "").trim() : "";
                };
                const setRead = (selector, value) => {
                  const node = identHost.querySelector(selector);
                  if (node) node.textContent = value || "–";
                };

                setRead("#collabMatriculeRead", valueOf("#collabMatricule"));
                setRead("#collabServiceRead", selectedLabel("#collabService"));
                setRead("#collabPosteRead", selectedLabel("#collabPoste"));
                setRead("#collabEntreeRead", formatDateFR(valueOf("#collabEntree")));
                setRead("#collabDebutPosteRead", formatDateFR(valueOf("#collabDebutPoste")));
                setRead("#collabContratRead", selectedLabel("#collabContrat"));
              };


              const syncProjectionReadValues = () => {
                const valueOf = (selector) => {
                  const node = identHost.querySelector(selector);
                  return node ? String(node.value || "").trim() : "";
                };
                const selectedLabel = (selector) => {
                  const node = identHost.querySelector(selector);
                  if (!node) return "";
                  const opt = node.options && node.selectedIndex >= 0 ? node.options[node.selectedIndex] : null;
                  return opt ? String(opt.textContent || "").trim() : "";
                };
                const setRead = (selector, value) => {
                  const node = identHost.querySelector(selector);
                  if (node) node.textContent = value || "–";
                };
                const sortie = identHost.querySelector("#collabChkSortie");

                setRead("#collabEduNivRead", selectedLabel("#collabEduNiv"));
                setRead("#collabEduDomRead", selectedLabel("#collabEduDom"));
                setRead("#collabRetraiteRead", valueOf("#collabRetraite"));
                setRead("#collabSortieRead", sortie && sortie.checked ? "Oui" : "Non");
                setRead("#collabDateSortieRead", formatDateFR(valueOf("#collabDateSortie")));
                setRead("#collabMotifSortieRead", selectedLabel("#collabMotifSortie"));
              };

              const syncRoleReadValues = () => {
                const setRoleRead = (readSelector, inputSelector) => {
                  const readNode = identHost.querySelector(readSelector);
                  const inputNode = identHost.querySelector(inputSelector);
                  if (!readNode || !inputNode) return;
                  const enabled = !!inputNode.checked;
                  readNode.textContent = enabled ? "Oui" : "Non";
                  readNode.classList.toggle("is-positive", enabled);
                };

                setRoleRead("#collabIsManagerRead", "#collabIsManager");
                setRoleRead("#collabIsFormateurRead", "#collabIsFormateur");
              };

              const syncHeaderRoleBadges = () => {
                const headerBadges = byId("collabModalBadges");
                if (!headerBadges) return;
                const badges = [];
                if (d.is_temp) badges.push({ label: "Temp", cls: getCollaborateurRoleClass("Temporaire") });
                if (!!identHost.querySelector("#collabIsManager")?.checked) badges.push({ label: "Manager", cls: getCollaborateurRoleClass("Manager") });
                if (!!identHost.querySelector("#collabIsFormateur")?.checked) badges.push({ label: "Formateur", cls: getCollaborateurRoleClass("Formateur") });
                headerBadges.innerHTML = badges
                  .map(b => `<span class="${escapeHtml(b.cls)}">${escapeHtml(b.label)}</span>`)
                  .join("");
              };

              let setEditMode = (isEdit) => {
                _collabIsEdit = !!isEdit;
                identHost.classList.toggle("is-editing", !!isEdit);
                if (isEdit) setInlineMsg(personalActions, "info", "");

                const nameRead = identHost.querySelector("#collabNameRead");
                const nameEdit = identHost.querySelector("#collabNameEdit");
                const addressRead = identHost.querySelector("#collabAddressRead");
                const addressEdit = identHost.querySelector("#collabAddressEdit");
                const readEditPairs = [
                  [identHost.querySelector("#collabEmailRead"), identHost.querySelector("#collabEmailEdit")],
                  [identHost.querySelector("#collabPaysRead"), identHost.querySelector("#collabPaysEdit")],
                  [identHost.querySelector("#collabTelRead"), identHost.querySelector("#collabTelEdit")],
                  [identHost.querySelector("#collabNaissanceRead"), identHost.querySelector("#collabNaissanceEdit")],
                ];
                if (!isEdit) syncIdentityReadValues();
                if (nameRead) nameRead.style.display = isEdit ? "none" : "";
                if (nameEdit) nameEdit.style.display = isEdit ? "flex" : "none";
                if (addressRead) addressRead.style.display = isEdit ? "none" : "flex";
                if (addressEdit) addressEdit.style.display = isEdit ? "flex" : "none";
                readEditPairs.forEach(([readNode, editNode]) => {
                  if (readNode) readNode.style.display = isEdit ? "none" : "";
                  if (editNode) editNode.style.display = isEdit ? "flex" : "none";
                });

                getEditableNodes().forEach(el => {
                  if (!el) return;
                  el.disabled = !isEdit;
                });

                if (editBtn) editBtn.style.display = isEdit ? "none" : "";
                if (saveBtn) saveBtn.style.display = isEdit ? "" : "none";
                if (cancelBtn) cancelBtn.style.display = isEdit ? "" : "none";

              };

              const companyEditBtn = identHost.querySelector("#collabCompanyBtnEdit");
              const companySaveBtn = identHost.querySelector("#collabCompanyBtnSave");
              const companyCancelBtn = identHost.querySelector("#collabCompanyBtnCancel");
              const companyActions = companySaveBtn?.closest(".sb-collab-ident-actions") || identHost;
              const companyReadEditPairs = [
                [identHost.querySelector("#collabMatriculeRead"), identHost.querySelector("#collabMatriculeEdit")],
                [identHost.querySelector("#collabServiceRead"), identHost.querySelector("#collabServiceEdit")],
                [identHost.querySelector("#collabPosteRead"), identHost.querySelector("#collabPosteEdit")],
                [identHost.querySelector("#collabEntreeRead"), identHost.querySelector("#collabEntreeEdit")],
                [identHost.querySelector("#collabDebutPosteRead"), identHost.querySelector("#collabDebutPosteEdit")],
                [identHost.querySelector("#collabContratRead"), identHost.querySelector("#collabContratEdit")],
              ];


              const projectionEditBtn = identHost.querySelector("#collabProjectionBtnEdit");
              const projectionSaveBtn = identHost.querySelector("#collabProjectionBtnSave");
              const projectionCancelBtn = identHost.querySelector("#collabProjectionBtnCancel");
              const projectionActions = projectionSaveBtn?.closest(".sb-collab-ident-actions") || identHost;
              const projectionReadEditPairs = [
                [identHost.querySelector("#collabEduNivRead"), identHost.querySelector("#collabEduNivEdit")],
                [identHost.querySelector("#collabEduDomRead"), identHost.querySelector("#collabEduDomEdit")],
                [identHost.querySelector("#collabRetraiteRead"), identHost.querySelector("#collabRetraiteEdit")],
                [identHost.querySelector("#collabSortieRead"), identHost.querySelector("#collabSortieEdit")],
                [identHost.querySelector("#collabDateSortieRead"), identHost.querySelector("#collabDateSortieEdit")],
                [identHost.querySelector("#collabMotifSortieRead"), identHost.querySelector("#collabMotifSortieEdit")],
              ];

              const commentEditBtn = identHost.querySelector("#collabCommentBtnEdit");
              const commentSaveBtn = identHost.querySelector("#collabCommentBtnSave");
              const commentCancelBtn = identHost.querySelector("#collabCommentBtnCancel");
              const commentActions = commentSaveBtn?.closest(".sb-collab-ident-actions") || identHost;

              const rolesEditBtn = identHost.querySelector("#collabRolesBtnEdit");
              const rolesSaveBtn = identHost.querySelector("#collabRolesBtnSave");
              const rolesCancelBtn = identHost.querySelector("#collabRolesBtnCancel");
              const rolesActions = rolesSaveBtn?.closest(".sb-collab-ident-actions") || identHost;
              const roleReadEditPairs = [
                [identHost.querySelector("#collabIsManagerRead"), identHost.querySelector("#collabIsManagerEdit")],
                [identHost.querySelector("#collabIsFormateurRead"), identHost.querySelector("#collabIsFormateurEdit")],
              ];

              let setCompanyEditMode = (isEdit) => {
                identHost.classList.toggle("is-company-editing", !!isEdit);
                if (!isEdit) syncCompanyReadValues();

                companyReadEditPairs.forEach(([readNode, editNode]) => {
                  if (readNode) readNode.style.display = isEdit ? "none" : "";
                  if (editNode) editNode.style.display = isEdit ? "flex" : "none";
                });

                getCompanyEditableNodes().forEach(el => {
                  if (!el) return;
                  el.disabled = !isEdit;
                });

                if (companyEditBtn) companyEditBtn.style.display = isEdit ? "none" : "";
                if (companySaveBtn) companySaveBtn.style.display = isEdit ? "" : "none";
                if (companyCancelBtn) companyCancelBtn.style.display = isEdit ? "" : "none";
              };


              let setProjectionEditMode = (isEdit) => {
                _collabProjectionIsEdit = !!isEdit;
                identHost.classList.toggle("is-projection-editing", !!isEdit);
                if (!isEdit) syncProjectionReadValues();

                projectionReadEditPairs.forEach(([readNode, editNode]) => {
                  if (readNode) readNode.style.display = isEdit ? "none" : "";
                  if (editNode) editNode.style.display = isEdit ? "flex" : "none";
                });

                getProjectionEditableNodes().forEach(el => {
                  if (!el) return;
                  el.disabled = !isEdit;
                });
                syncSortie();

                if (projectionEditBtn) projectionEditBtn.style.display = isEdit ? "none" : "";
                if (projectionSaveBtn) projectionSaveBtn.style.display = isEdit ? "" : "none";
                if (projectionCancelBtn) projectionCancelBtn.style.display = isEdit ? "" : "none";
              };

              let setCommentEditMode = (isEdit) => {
                identHost.classList.toggle("is-comment-editing", !!isEdit);
                getCommentEditableNodes().forEach(el => {
                  if (!el) return;
                  el.disabled = !isEdit;
                });

                if (commentEditBtn) commentEditBtn.style.display = isEdit ? "none" : "";
                if (commentSaveBtn) commentSaveBtn.style.display = isEdit ? "" : "none";
                if (commentCancelBtn) commentCancelBtn.style.display = isEdit ? "" : "none";
              };

              let setRoleEditMode = (isEdit) => {
                identHost.classList.toggle("is-roles-editing", !!isEdit);
                if (!isEdit) syncRoleReadValues();

                roleReadEditPairs.forEach(([readNode, editNode]) => {
                  if (readNode) readNode.style.display = isEdit ? "none" : "";
                  if (editNode) editNode.style.display = isEdit ? "flex" : "none";
                });

                getRoleEditableNodes().forEach(el => {
                  if (!el) return;
                  el.disabled = !isEdit;
                });

                if (rolesEditBtn) rolesEditBtn.style.display = isEdit ? "none" : "";
                if (rolesSaveBtn) rolesSaveBtn.style.display = isEdit ? "" : "none";
                if (rolesCancelBtn) rolesCancelBtn.style.display = isEdit ? "" : "none";
              };

              let _collabEditSnap = snapshotValues();
              let _collabCompanyEditSnap = snapshotCompanyValues();
              let _collabProjectionEditSnap = snapshotProjectionValues();
              let _collabCommentEditSnap = snapshotCommentValues();
              let _collabRoleEditSnap = snapshotRoleValues();
              var _collabIsEdit = false;
              var _collabProjectionIsEdit = false;
              setEditMode(false);
              setCompanyEditMode(false);
              setProjectionEditMode(false);
              setCommentEditMode(false);
              setRoleEditMode(false);
              refreshSelectSelectedSoftState(identHost);

              identHost.addEventListener("change", (ev) => {
                if (ev.target && ev.target.matches && ev.target.matches("select.sb-select")) {
                  refreshSelectSelectedSoftState(identHost);
                }
                if (ev.target && ev.target.closest && ev.target.closest(".sb-collab-ident-panel")) {
                  clearInlineMsg(identHost);
                }
              });

              identHost.addEventListener("input", (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest(".sb-collab-ident-panel")) {
                  clearInlineMsg(identHost);
                }
              });

              const collabModal = byId("modalCollaborateur");
              if (collabModal && !collabModal._sbClearInlineMsgBound) {
                collabModal._sbClearInlineMsgBound = true;
                collabModal.addEventListener("click", (ev) => {
                  const target = ev.target;
                  if (!target || !target.closest) return;
                  if (target.closest(".sb-collab-ident-actions")) return;
                  if (target.closest("input, select, textarea, button")) return;
                  clearInlineMsg(collabModal);
                });
              }

              function syncSortie() {
                const chk = identHost.querySelector("#collabChkSortie");
                const dt = identHost.querySelector("#collabDateSortie");
                const motif = identHost.querySelector("#collabMotifSortie");
                if (!chk || !dt || !motif) return;

                // Hors édition: tout reste bloqué
                if (!_collabProjectionIsEdit) {
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

              if (companyEditBtn) {
                companyEditBtn.addEventListener("click", () => {
                  _collabCompanyEditSnap = snapshotCompanyValues();
                  setCompanyEditMode(true);
                });
              }

              if (projectionEditBtn) {
                projectionEditBtn.addEventListener("click", () => {
                  _collabProjectionEditSnap = snapshotProjectionValues();
                  setProjectionEditMode(true);
                });
              }

              if (commentEditBtn) {
                commentEditBtn.addEventListener("click", () => {
                  _collabCommentEditSnap = snapshotCommentValues();
                  setCommentEditMode(true);
                });
              }

              if (rolesEditBtn) {
                rolesEditBtn.addEventListener("click", () => {
                  _collabRoleEditSnap = snapshotRoleValues();
                  setRoleEditMode(true);
                });
              }

              // Bind une seule fois sur la checkbox sortie prévue
              const chkEl = identHost.querySelector("#collabChkSortie");
              if (chkEl && !chkEl._sbBoundSortie) {
                chkEl.addEventListener("change", syncSortie);
                chkEl._sbBoundSortie = true;
              }

              const telEl = identHost.querySelector("#collabTel");
              if (telEl && !telEl._sbBoundPhoneFormat) {
                telEl.addEventListener("input", () => {
                  const start = telEl.selectionStart;
                  const before = telEl.value;
                  telEl.value = formatPhoneFr(telEl.value);
                  if (document.activeElement === telEl && start != null) {
                    const delta = telEl.value.length - before.length;
                    const pos = Math.max(0, Math.min(telEl.value.length, start + delta));
                    try { telEl.setSelectionRange(pos, pos); } catch (_) {}
                  }
                });
                telEl._sbBoundPhoneFormat = true;
              }



              if (cancelBtn) {
                cancelBtn.addEventListener("click", () => {
                  restoreValues(_collabEditSnap);
                  setEditMode(false);
                  setInlineMsg(personalActions, "info", "");
                });
              }

              if (companyCancelBtn) {
                companyCancelBtn.addEventListener("click", () => {
                  restoreCompanyValues(_collabCompanyEditSnap);
                  setCompanyEditMode(false);
                  setInlineMsg(companyActions, "info", "");
                });
              }

              if (projectionCancelBtn) {
                projectionCancelBtn.addEventListener("click", () => {
                  restoreProjectionValues(_collabProjectionEditSnap);
                  setProjectionEditMode(false);
                  setInlineMsg(projectionActions, "info", "");
                });
              }

              if (commentCancelBtn) {
                commentCancelBtn.addEventListener("click", () => {
                  restoreCommentValues(_collabCommentEditSnap);
                  setCommentEditMode(false);
                  setInlineMsg(commentActions, "info", "");
                });
              }

              if (rolesCancelBtn) {
                rolesCancelBtn.addEventListener("click", () => {
                  restoreRoleValues(_collabRoleEditSnap);
                  setRoleEditMode(false);
                  setInlineMsg(rolesActions, "info", "");
                });
              }

              const q = (sel) => identHost.querySelector(sel);

              const t = (sel) => {
                const el = q(sel);
                if (!el) return null;
                const s = String(el.value ?? "").trim();
                return s === "" ? null : s;
              };

              const dte = (sel) => t(sel);

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

              const intOrNull = (sel) => {
                const el = q(sel);
                if (!el) return null;
                const s = String(el.value ?? "").trim();
                if (!s) return null;
                const n = parseInt(s, 10);
                return Number.isFinite(n) ? n : null;
              };

              const postIdentificationSection = async (section, payload) => {
                const allowedSections = new Set([
                  "identite",
                  "situation",
                  "parcours",
                  "roles",
                  "commentaire",
                ]);
                if (!allowedSections.has(section)) {
                  throw new Error(`Section d'identification inconnue : ${section}`);
                }
                const url = `${API_BASE}/skills/collaborateurs/identification/${encodeURIComponent(id_contact)}/${encodeURIComponent(it.id_effectif)}/${encodeURIComponent(section)}`;
                const data = await window.portal.apiJson(
                  url,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  }
                );

                if (!data || data.ok !== true) {
                  const msg = (data && (data.detail || data.message))
                    ? (data.detail || data.message)
                    : "Erreur enregistrement (réponse invalide).";
                  throw new Error(msg);
                }

                return data;
              };

              const saveCollaborateurIdentity = async () => {
                try {
                  const payload = {
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
                  };

                  await postIdentificationSection("identite", payload);
                  _collabEditSnap = snapshotValues();
                  setEditMode(false);
                  setInlineMsg(personalActions, "success", "Enregistré");

                  if (title) {
                    title.textContent = `${payload.prenom_effectif || ""} ${(payload.nom_effectif || "").toUpperCase()}`.trim() || "Collaborateur";
                  }
                } catch (e) {
                  console.error(e);
                  const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                  setInlineMsg(personalActions, "error", `Erreur enregistrement : ${msg}`);
                }
              };

              const saveCollaborateurCompany = async () => {
                try {
                  const payload = {
                    matricule_interne: t("#collabMatricule"),
                    id_service: t("#collabService"),
                    id_poste_actuel: t("#collabPoste"),
                    date_entree_entreprise_effectif: dte("#collabEntree"),
                    type_contrat: t("#collabContrat"),
                    date_debut_poste_actuel: dte("#collabDebutPoste"),
                  };

                  await postIdentificationSection("situation", payload);
                  _collabCompanyEditSnap = snapshotCompanyValues();
                  setCompanyEditMode(false);
                  setInlineMsg(companyActions, "success", "Enregistré");
                  setText("collabModalPoste", identHost.querySelector("#collabPosteRead")?.textContent || "–");
                  setText("collabModalService", identHost.querySelector("#collabServiceRead")?.textContent || "–");
                  setText("collabModalDateEntree", identHost.querySelector("#collabEntreeRead")?.textContent || "–");
                  setText("collabModalContrat", identHost.querySelector("#collabContratRead")?.textContent || "–");
                  setText("collabModalDatePoste", identHost.querySelector("#collabDebutPosteRead")?.textContent || "–");
                  refreshSelectSelectedSoftState(identHost);
                } catch (e) {
                  console.error(e);
                  const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                  setInlineMsg(companyActions, "error", `Erreur enregistrement : ${msg}`);
                }
              };

              const saveCollaborateurProjection = async () => {
                try {
                  const sortieOn = chk("#collabChkSortie");
                  const payload = {
                    niveau_education: t("#collabEduNiv"),
                    domaine_education: t("#collabEduDom"),
                    distance_km_entreprise: num("#collabDist"),
                    retraite_estimee: intOrNull("#collabRetraite"),
                    date_sortie_prevue: sortieOn ? dte("#collabDateSortie") : null,
                    motif_sortie: sortieOn ? t("#collabMotifSortie") : null,
                  };

                  await postIdentificationSection("parcours", payload);
                  _collabProjectionEditSnap = snapshotProjectionValues();
                  setProjectionEditMode(false);
                  setInlineMsg(projectionActions, "success", "Enregistré");
                  refreshSelectSelectedSoftState(identHost);
                } catch (e) {
                  console.error(e);
                  const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                  setInlineMsg(projectionActions, "error", `Erreur enregistrement : ${msg}`);
                }
              };

              const saveCollaborateurComment = async () => {
                try {
                  const payload = {
                    note_commentaire: t("#collabComment"),
                  };

                  await postIdentificationSection("commentaire", payload);
                  _collabCommentEditSnap = snapshotCommentValues();
                  setCommentEditMode(false);
                  setInlineMsg(commentActions, "success", "Enregistré");
                } catch (e) {
                  console.error(e);
                  const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                  setInlineMsg(commentActions, "error", `Erreur enregistrement : ${msg}`);
                }
              };

              const saveCollaborateurRoles = async () => {
                try {
                  const payload = {
                    ismanager: chk("#collabIsManager"),
                    isformateur: chk("#collabIsFormateur"),
                  };

                  const data = await postIdentificationSection("roles", payload);
                  const savedIsManager = (typeof data.ismanager === "boolean") ? data.ismanager : !!payload.ismanager;
                  const savedIsFormateur = (typeof data.isformateur === "boolean") ? data.isformateur : !!payload.isformateur;
                  const roleManagerInput = identHost.querySelector("#collabIsManager");
                  const roleFormateurInput = identHost.querySelector("#collabIsFormateur");
                  if (roleManagerInput) roleManagerInput.checked = savedIsManager;
                  if (roleFormateurInput) roleFormateurInput.checked = savedIsFormateur;
                  d.ismanager = savedIsManager;
                  d.isformateur = savedIsFormateur;

                  _collabRoleEditSnap = snapshotRoleValues();
                  setRoleEditMode(false);
                  syncHeaderRoleBadges();
                  setInlineMsg(rolesActions, "success", "Enregistré");
                } catch (e) {
                  console.error(e);
                  const msg = (e && e.message) ? e.message : (typeof e === "string" ? e : JSON.stringify(e));
                  setInlineMsg(rolesActions, "error", `Erreur enregistrement : ${msg}`);
                }
              };

              if (saveBtn) {
                saveBtn.addEventListener("click", saveCollaborateurIdentity);
              }

              if (companySaveBtn) {
                companySaveBtn.addEventListener("click", saveCollaborateurCompany);
              }

              if (projectionSaveBtn) {
                projectionSaveBtn.addEventListener("click", saveCollaborateurProjection);
              }

              if (commentSaveBtn) {
                commentSaveBtn.addEventListener("click", saveCollaborateurComment);
              }

              if (rolesSaveBtn) {
                rolesSaveBtn.addEventListener("click", saveCollaborateurRoles);
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
                refreshSelectSelectedSoftState(identHost);
                if (typeof syncCompanyReadValues === "function") syncCompanyReadValues();
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
                refreshSelectSelectedSoftState(identHost);
                if (typeof syncProjectionReadValues === "function") syncProjectionReadValues();
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
                const requiredItems = items.filter(x => !!x?.is_required);
                const otherItems = items.filter(x => !x?.is_required);

                if (items.length === 0) {
                  host.innerHTML = `<div class="sb-collab-empty-card">Aucune compétence trouvée.</div>`;
                  return;
                }

                const levelLabel = (v) => window.NovoskillLevels ? window.NovoskillLevels.label(v) : ((v || "–").toString());
                const levelClass = (v) => window.NovoskillLevels ? window.NovoskillLevels.cssClass(v) : "";

                const countValidated = requiredItems.filter(x => {
                  const cur = (x?.niveau_actuel || "").toString().trim();
                  const req = (x?.niveau_requis || "").toString().trim();
                  if (!cur || !req) return false;
                  const order = { A: 1, B: 2, C: 3, D: 4 };
                  const key = (v) => (window.NovoskillLevels && typeof window.NovoskillLevels.key === "function")
                    ? window.NovoskillLevels.key(v)
                    : String(v || "").trim().toUpperCase().slice(0, 1);
                  return (order[key(cur)] || 0) >= (order[key(req)] || 0);
                }).length;

                const renderDomainBadge = (x) => {
                  const domTitleRaw = (x?.domaine_titre || x?.domaine || "").toString().trim();
                  const domTitle = domTitleRaw || "Domaine";
                  const domColorRaw = (x?.domaine_couleur || "").toString().trim();
                  const domStyle = domColorRaw ? ` style="--dom-color:${escapeHtml(domColorRaw)}"` : "";
                  return `<span class="ns-badge sb-badge-domaine sb-badge-domaine--soft"${domStyle}>${escapeHtml(domTitle)}</span>`;
                };

                const renderRows = (rows) => {
                  if (!rows.length) {
                    return `<tr><td colspan="5" class="sb-collab-skill-empty">Aucune compétence dans cette catégorie.</td></tr>`;
                  }

                  return rows.map(x => {
                    const cur = levelLabel(x.niveau_actuel);
                    const req = levelLabel(x.niveau_requis || x.niveau_actuel);
                    const d = formatDateFR(x.date_derniere_eval);
                    const code = (x.code || "").toString().trim();
                    const title = (x.intitule || "").toString().trim();
                    const levelCls = levelClass(x.niveau_requis || x.niveau_actuel);

                    return `
                      <tr>
                        <td>
                          <div class="sb-collab-skill-titleline">
                            ${code ? `<span class="ns-badge sb-badge sb-badge-ref-comp-code">${escapeHtml(code)}</span>` : ""}
                            <span class="sb-collab-skill-title">${escapeHtml(title || "Compétence")}</span>
                          </div>
                        </td>
                        <td>${renderDomainBadge(x)}</td>
                        <td class="col-center">
                          <span class="ns-badge sb-badge sb-badge-niv ${escapeHtml(levelCls)}">${escapeHtml(req || cur || "–")}</span>
                        </td>
                        <td class="col-center">${escapeHtml(d)}</td>
                        <td class="col-center">
                          <button type="button" class="sb-icon-btn sb-icon-btn--doc" data-skill-pdf="${escapeHtml(x.id_comp || "")}" title="Voir la fiche compétence PDF" aria-label="Voir la fiche compétence PDF">
                            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ns-icon-use"><use href="/novoskill_icons.svg#ns-icon-competence"></use></svg>
                          </button>
                        </td>
                      </tr>
                    `;
                  }).join("");
                };

                const renderTable = (title, rows, modifier) => `
                  <div class="sb-collab-skill-section ${modifier || ""}">
                    <div class="sb-collab-skill-section-head">
                      <div class="sb-collab-skill-section-title">${escapeHtml(title)}</div>
                      <span class="ns-badge sb-badge">${rows.length}</span>
                    </div>
                    <div class="sb-table-wrap">
                      <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-skills-table">
                        <thead>
                          <tr>
                            <th>Compétence</th>
                            <th style="width:210px;">Domaine</th>
                            <th class="col-center" style="width:120px;">Niveau requis</th>
                            <th class="col-center" style="width:130px;">Dernière éval.</th>
                            <th class="col-center" style="width:62px;">PDF</th>
                          </tr>
                        </thead>
                        <tbody>${renderRows(rows)}</tbody>
                      </table>
                    </div>
                  </div>
                `;

                host.innerHTML = `
                  <div class="card-sub sb-collab-tab-context">
                    Poste actuel : <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                  </div>

                  <div class="sb-collab-metrics">
                    <div class="sb-collab-metric sb-collab-metric--red">
                      <span aria-hidden="true">${collabIcon("contract")}</span>
                      <strong>${requiredItems.length}</strong>
                      <em>Compétences requises<br>par le poste</em>
                    </div>
                    <div class="sb-collab-metric sb-collab-metric--blue">
                      <span aria-hidden="true">${collabIcon("contract")}</span>
                      <strong>${countValidated}</strong>
                      <em>Compétences validées<br>au niveau requis ou supérieur</em>
                    </div>
                    <div class="sb-collab-metric sb-collab-metric--green">
                      <span aria-hidden="true">${collabIcon("certs")}</span>
                      <strong>${otherItems.length}</strong>
                      <em>Autres compétences<br>détenues</em>
                    </div>
                  </div>

                  ${renderTable("Compétences requises par le poste", requiredItems, "sb-collab-skill-section--required")}
                  ${renderTable("Autres compétences détenues", otherItems, "sb-collab-skill-section--other")}
                `;

                const id_contact = window.portal?.contactId;
                const id_effectif = it?.id_effectif;

                host.querySelectorAll("[data-skill-pdf]").forEach(btn => {
                  btn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const compId = btn.getAttribute("data-skill-pdf") || "";
                    const item = items.find(x => String(x?.id_comp || "").trim() === compId) || null;
                    const popupWin = window.open("about:blank", "_blank");
                    if (popupWin) {
                      popupWin.document.write("<p style='font-family:var(--ns-font-ui);padding:16px;'>Génération du PDF…</p>");
                    }

                    try {
                      btn.disabled = true;
                      await openCollaborateurCompetencePdf(id_contact, id_effectif, item, popupWin);
                    } catch (err) {
                      try { if (popupWin && !popupWin.closed) popupWin.close(); } catch (_) {}
                      window.portal?.showAlert?.("error", "Erreur PDF compétence : " + (err?.message || err));
                    } finally {
                      btn.disabled = false;
                    }
                  });
                });
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

                const statutInfo = (x) => {
                  if (!x?.is_acquired) return { label: "Non acquis", cls: "sb-collab-cert-status--neutral" };
                  const s = (x?.statut_validite || "").toString().toLowerCase();
                  if (s === "valide") return { label: "Valide", cls: "sb-collab-cert-status--ok" };
                  if (s === "a_renouveler") return { label: "À renouveler", cls: "sb-collab-cert-status--warn" };
                  if (s === "expiree") return { label: "Expirée", cls: "sb-collab-cert-status--danger" };
                  return { label: "–", cls: "sb-collab-cert-status--neutral" };
                };

                const requiredCount = items.filter(x => !!x?.is_required).length;
                const acquiredCount = items.filter(x => !!x?.is_acquired).length;
                const renewCount = items.filter(x => ["a_renouveler", "expiree"].includes((x?.statut_validite || "").toString().toLowerCase())).length;

                if (items.length === 0) {
                  host.innerHTML = `
                    <div class="card-sub sb-collab-tab-context">
                      Poste actuel : <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                    </div>
                    <div class="sb-collab-empty-card">Aucune certification trouvée.</div>
                  `;
                  return;
                }

                const renderRequirementBadge = (x) => {
                  if (!x?.is_required) return `<span class="ns-badge sb-badge sb-collab-cert-badge">Hors poste</span>`;
                  const ne = (x.niveau_exigence || "requis").toString().toLowerCase();
                  const label = ne.includes("souhait") ? "Souhaité" : "Requis";
                  return `<span class="ns-badge sb-badge sb-collab-cert-badge sb-collab-cert-badge--required">${escapeHtml(label)}</span>`;
                };

                const rows = items.map(x => {
                  const statut = statutInfo(x);
                  const jr = x?.jours_restants != null ? `${x.jours_restants} j` : "–";
                  const categorie = (x.categorie || "").toString().trim();

                  return `
                    <tr>
                      <td>
                        <div class="sb-collab-cert-title">${escapeHtml(x.nom_certification || "Certification")}</div>
                        <div class="sb-collab-cert-badges">
                          ${categorie ? `<span class="ns-badge sb-badge sb-collab-cert-badge">${escapeHtml(categorie)}</span>` : ""}
                          ${renderRequirementBadge(x)}
                        </div>
                      </td>

                      <td class="col-center">
                        <strong>${escapeHtml(fmtValidite(x.validite_attendue))}</strong>
                        <span class="sb-collab-cert-sub">Renouv. : ${escapeHtml(fmtDelai(x.delai_renouvellement))}</span>
                      </td>

                      <td class="col-center">
                        <span class="ns-badge sb-badge sb-collab-cert-status ${escapeHtml(statut.cls)}">${escapeHtml(statut.label)}</span>
                        <span class="sb-collab-cert-sub">${escapeHtml(jr)}</span>
                      </td>

                      <td class="col-center">
                        <strong>${escapeHtml(fmtObt(x))}</strong>
                        <span class="sb-collab-cert-sub">${escapeHtml(fmtExp(x))}</span>
                      </td>
                    </tr>
                  `;
                }).join("");

                host.innerHTML = `
                  <div class="card-sub sb-collab-tab-context">
                    Poste actuel : <strong>${escapeHtml(data.intitule_poste || "–")}</strong>
                  </div>

                  <div class="sb-collab-metrics">
                    <div class="sb-collab-metric sb-collab-metric--red">
                      <span aria-hidden="true">${collabIcon("medal")}</span>
                      <strong>${requiredCount}</strong>
                      <em>Certifications<br>requises / souhaitées</em>
                    </div>
                    <div class="sb-collab-metric sb-collab-metric--green">
                      <span aria-hidden="true">${collabIcon("certs")}</span>
                      <strong>${acquiredCount}</strong>
                      <em>Certifications<br>acquises</em>
                    </div>
                    <div class="sb-collab-metric sb-collab-metric--blue">
                      <span aria-hidden="true">${collabIcon("calendar")}</span>
                      <strong>${renewCount}</strong>
                      <em>À surveiller<br>ou renouveler</em>
                    </div>
                  </div>

                  <div class="sb-collab-cert-section">
                    <div class="sb-collab-skill-section-head">
                      <div class="sb-collab-skill-section-title">Certifications du collaborateur</div>
                      <span class="ns-badge sb-badge">${items.length}</span>
                    </div>

                    <div class="sb-table-wrap">
                      <table class="sb-table sb-table--airy sb-table--zebra sb-table--hover sb-collab-certs-table">
                        <thead>
                          <tr>
                            <th>Certification</th>
                            <th class="col-center" style="width:160px;">Validité</th>
                            <th class="col-center" style="width:160px;">État</th>
                            <th class="col-center" style="width:180px;">Dates</th>
                          </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                      </table>
                    </div>
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


    if (modal) modal.setAttribute("aria-hidden", "false");
  }

  function closeCollaborateurModal() {
    showCollaborateursIndex();
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

    bindCollaborateurHistoryOnce();
    showCollaborateursIndex();
    try {
      const state = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
      window.history.replaceState({ ...state, skillsCollaborateurDetail: null }, "", window.location.href);
    } catch (_) {}

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
      const btnApply = byId("btnCollabApply");
      const btnFiltersToggle = byId("btnCollabFiltersToggle");
      const btnRefresh = byId("btnCollabRefresh");
      const btnOpenPlanning = byId("btnOpenIndispoPlanning");
      const btnPreviewOpen = byId("btnCollabPreviewOpen");
      const btnPreviewEval = byId("btnCollabPreviewEval");
      const btnPreviewPlan = byId("btnCollabPreviewPlan");
      const tableSearchMirror = byId("collabTableSearchMirror");

      // Filtre service: appliquer immédiatement au changement
      if (selService) {
        selService.addEventListener("change", () => {
          _breakFocus = null; // on reset le focus indispo si on change de périmètre
          refreshAll(id_contact);
        });
      }

      if (btnReset) {
        btnReset.addEventListener("click", () => {
          if (selService) selService.value = window.portal.serviceFilter.ALL_ID;
          if (inputSearch) inputSearch.value = "";
          if (tableSearchMirror) tableSearchMirror.value = "";
          if (chkActifs) chkActifs.checked = true;
          if (chkArchived) chkArchived.checked = false;
          if (chkManagers) chkManagers.checked = false;
          if (chkFormateurs) chkFormateurs.checked = false;
          if (chkTemp) chkTemp.checked = false;

          refreshAll(id_contact);
        });
      }

      if (btnApply) {
        btnApply.addEventListener("click", () => {
          _breakFocus = null;
          refreshAll(id_contact);
        });
      }

      if (btnFiltersToggle) {
        btnFiltersToggle.addEventListener("click", () => {
          const card = btnFiltersToggle.closest(".collab-filter-card");
          const isCollapsed = card ? card.classList.toggle("is-collapsed") : false;
          btnFiltersToggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
          btnFiltersToggle.title = isCollapsed ? "Déplier les filtres" : "Replier les filtres";
          btnFiltersToggle.setAttribute("aria-label", isCollapsed ? "Déplier les filtres" : "Replier les filtres");
        });
      }

      if (btnRefresh) {
        btnRefresh.addEventListener("click", () => refreshAll(id_contact));
      }

      if (tableSearchMirror && inputSearch) {
        tableSearchMirror.addEventListener("input", () => {
          inputSearch.value = tableSearchMirror.value;
          _breakFocus = null;
          clearTimeout(_searchTimer);
          _searchTimer = setTimeout(() => refreshAll(id_contact), 250);
        });
      }

      if (inputSearch && tableSearchMirror) {
        inputSearch.addEventListener("input", () => {
          if (tableSearchMirror.value !== inputSearch.value) tableSearchMirror.value = inputSearch.value;
        });
      }

      if (btnPreviewOpen) {
        btnPreviewOpen.addEventListener("click", () => {
          if (_selectedCollaborateur) openCollaborateurModal(_selectedCollaborateur);
        });
      }

      if (btnPreviewEval) {
        btnPreviewEval.addEventListener("click", async () => {
          if (!_selectedCollaborateur) return;

          prepareEntretienCollaborateurPreselect(_selectedCollaborateur);

          if (window.portal && typeof window.portal.switchView === "function") {
            await window.portal.switchView("entretien-performance");
          } else {
            window.location.hash = "entretien-performance";
          }
        });
      }

      if (btnPreviewPlan) {
        btnPreviewPlan.addEventListener("click", () => {
          window.location.hash = "planning-indispo";
          if (window.portal && typeof window.portal.switchView === "function") {
            window.portal.switchView("planning-indispo");
          }
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
    await processReferentielPendingCollaborateurAction();
  }

  async function processReferentielPendingCollaborateurAction() {
    let id = "";
    try {
      id = String(window.sessionStorage.getItem("skills_collab_open_id_effectif") || "").trim();
      if (id) window.sessionStorage.removeItem("skills_collab_open_id_effectif");
    } catch (_) {}

    if (!id) return;

    try {
      const id_contact = window.portal?.contactId;
      if (!id_contact) throw new Error("Contact introuvable.");
      const detail = await loadIdentification(id_contact, id);
      openCollaborateurModal(detail);
    } catch (e) {
      window.portal?.showAlert?.("error", "Erreur fiche collaborateur : " + (e?.message || String(e)));
    }
  }

  // Expose function for portal.onShow (optional)
  const collabPublicApi = window.skillsCollaborateurs || window.SkillsCollaborateurs || {};
  collabPublicApi.onShow = initMenu;
  collabPublicApi.openCollaborateurModalById = async (id_effectif) => {
    const id_contact = window.portal?.contactId;
    const id = (id_effectif || "").toString().trim();
    if (!id_contact) throw new Error("Contact introuvable.");
    if (!id) throw new Error("Collaborateur introuvable.");
    const detail = await loadIdentification(id_contact, id);
    openCollaborateurModal(detail);
  };

  window.skillsCollaborateurs = collabPublicApi;
  window.SkillsCollaborateurs = collabPublicApi;
})();
