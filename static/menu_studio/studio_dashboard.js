(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";
  const DEFAULT_CRITICITE = 70;
  let _bound = false;
  let _serviceOptionsReady = false;
  let _contextLoaded = false;

  function byId(id){ return document.getElementById(id); }
  function esc(v){ return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
  function n(v){ const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }
  function pct(v){ const x = Math.max(0, Math.min(100, n(v))); return `${Math.round(x)}%`; }
  function setText(id, value){ const el = byId(id); if (el) el.textContent = value == null || value === "" ? "—" : String(value); }

  function getOwnerId(){
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;
    return (new URL(window.location.href).searchParams.get("id") || "").trim();
  }

  async function getToken(){
    await (window.__studioAuthReady || Promise.resolve(null));
    const session = await (window.PortalAuthCommon?.getSession?.() || Promise.resolve(null)).catch(() => null);
    return session?.access_token || "";
  }

  function getFilters(){
    const criticite = Math.max(0, Math.min(100, Math.round(n(byId("studioDashCriticite")?.value || DEFAULT_CRITICITE))));
    return {
      id_service: (byId("studioDashService")?.value || "").toString().trim(),
      criticite_min: criticite,
    };
  }

  function setStatus(message, isError){
    const el = byId("studioDashStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", !!isError);
    el.style.display = message ? "block" : "none";
  }

  function openClientSpace(idEnt){
    const ownerId = getOwnerId();
    if (!ownerId || !idEnt) return;
    window.open(`/studio_client_space.html?id=${encodeURIComponent(ownerId)}&client=${encodeURIComponent(idEnt)}`, "_blank", "noopener");
  }

  function setServiceFilter(idService){
    const select = byId("studioDashService");
    if (!select) return;
    select.value = idService || "";
    load().catch(e => setStatus(e.message || String(e), true));
  }

  function setGauge(value){
    const v = Math.max(0, Math.min(100, n(value)));
    const needle = byId("studioDashHealthNeedle");
    if (needle) needle.style.transform = `translateX(-50%) rotate(${Math.round(-90 + (v * 1.8))}deg)`;
  }

  function setRing(id, value){
    const el = byId(id);
    if (!el) return;
    const v = Math.max(0, Math.min(100, n(value)));
    el.style.setProperty("--studio-ring", `${Math.round(v * 3.6)}deg`);
  }

  function badgeClass(priority){
    const p = (priority || "").toString().toLowerCase();
    if (p === "danger") return "studio-dash-badge--danger";
    if (p === "surveillance") return "studio-dash-badge--watch";
    if (p === "stable") return "studio-dash-badge--stable";
    return "";
  }

  async function loadContext(ownerId, token){
    if (_contextLoaded || !ownerId || !token) return;
    _contextLoaded = true;
    try{
      const r = await fetch(`${API_BASE}/studio/context/${encodeURIComponent(ownerId)}`, {
        headers: { "Authorization": `Bearer ${token}` },
        credentials: "same-origin"
      });
      const ctx = await r.json().catch(() => null);
      if (!r.ok || !ctx) return;
      const prenom = (ctx.prenom || "").toString().trim();
      setText("studioDashWelcome", prenom ? `Bienvenue ${prenom}` : "Bienvenue");
    }catch(_){
      setText("studioDashWelcome", "Bienvenue");
    }
  }

  function applyServiceOptions(data){
    const select = byId("studioDashService");
    if (!select) return;
    const current = select.value || "";
    const opts = Array.isArray(data?.scope_options) && data.scope_options.length
      ? data.scope_options
      : [{ value:"", label:"Tous les services" }];
    const html = opts.map(o => `<option value="${esc(o.value || "")}">${esc(o.label || "Service")}</option>`).join("");
    if (!_serviceOptionsReady || select.dataset.lastOptions !== html){
      select.innerHTML = html;
      select.dataset.lastOptions = html;
      _serviceOptionsReady = true;
    }
    const valid = opts.some(o => String(o.value || "") === current);
    select.value = valid ? current : "";
  }

  function renderRiskBars(items){
    const el = byId("studioDashRiskBars");
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 10) : [];
    if (!rows.length){
      el.innerHTML = `<div class="studio-dash-empty">Aucun point de surveillance.</div>`;
      return;
    }
    el.innerHTML = rows.map(r => {
      const val = Math.max(0, Math.min(100, n(r.risk_pct)));
      const cls = r.priority === "danger" ? "is-danger" : (r.priority === "surveillance" ? "is-watch" : "is-stable");
      const label = esc(r.label || r.nom_service || r.intitule_poste || "Élément");
      const idService = r.id_service ? esc(r.id_service) : "";
      const attrs = idService ? `data-service="${idService}"` : "";
      return `<button type="button" class="studio-dash-risk-bar ${cls}" ${attrs} title="${label} : ${Math.round(val)}%"><span class="studio-dash-risk-bar-fill" style="height:${Math.max(8, Math.round(val))}%"></span><span class="studio-dash-risk-bar-value">${Math.round(val)}%</span><span class="studio-dash-risk-bar-label">${label}</span></button>`;
    }).join("");
    el.querySelectorAll("[data-service]").forEach(btn => btn.addEventListener("click", () => setServiceFilter(btn.dataset.service || "")));
  }

  function renderActions(items){
    const el = byId("studioDashActions");
    if (!el) return;
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length){
      el.innerHTML = `<div class="studio-dash-empty">Aucune action prioritaire.</div>`;
      return;
    }
    el.innerHTML = rows.slice(0, 8).map(a => {
      const client = a.id_ent ? `<button type="button" class="studio-dash-link" data-client="${esc(a.id_ent)}">Ouvrir</button>` : "";
      return `<div class="studio-dash-action-row"><div class="studio-dash-action-main"><span class="studio-dash-badge ${badgeClass(a.priority)}">${esc(a.priority_label || "Action")}</span><strong>${esc(a.title || "Action")}</strong><span>${esc(a.subtitle || "")}</span></div>${client}</div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(btn => btn.addEventListener("click", () => openClientSpace(btn.dataset.client)));
  }

  function renderLinkedStructures(items){
    const el = byId("studioDashLinkedStructureItems");
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 8) : [];
    if (!rows.length){
      el.innerHTML = `<div class="studio-dash-empty">Aucun site ou client prioritaire.</div>`;
      return;
    }
    el.innerHTML = rows.map(r => {
      const label = esc(r.nom_ent || "Structure");
      const sub = `${Math.round(n(r.risk_pct))}% risque · ${n(r.postes_danger)} poste(s) en danger`;
      return `<div class="studio-dash-mini-row studio-dash-mini-row--click" data-client="${esc(r.id_ent)}"><div><strong>${label}</strong><span>${esc(sub)}</span></div><span class="studio-dash-badge ${badgeClass(r.priority)}">${esc(r.priority_label || "")}</span></div>`;
    }).join("");
    el.querySelectorAll("[data-client]").forEach(row => row.addEventListener("click", () => openClientSpace(row.dataset.client)));
  }

  function renderSignal(value){
    const el = byId("studioDashReliabilitySignal");
    if (!el) return;
    const v = Math.max(0, Math.min(100, n(value)));
    const active = Math.ceil(v / 20);
    el.innerHTML = [1,2,3,4,5].map(i => `<span class="${i <= active ? "is-active" : ""}" style="height:${16 + i * 7}px"></span>`).join("");
  }

  function render(data){
    applyServiceOptions(data);

    const main = data.main || {};
    const p = main.portfolio || {};
    const demandes = main.demandes_formation || {};
    const entretiens = main.entretiens || {};
    const ref = main.referentiel || {};
    const tr = main.transmission || {};
    const reliability = main.reliability || {};
    const linked = data.linked || {};

    setStatus("");
    setText("studioDashHealthPct", pct(p.health_pct));
    setText("studioDashHealthLabel", p.health_label || "Analyse interne");
    setGauge(p.health_pct);

    setText("studioDashRiskTitle", main.risk_title || "Services à surveiller");
    setText("studioDashNbDanger", n(p.items_danger));
    setText("studioDashNbWatch", n(p.items_surveillance));
    setText("studioDashNbStable", n(p.items_stables));
    renderRiskBars(main.risk_items || []);

    setText("studioDashDemandesOpen", n(demandes.ouvertes));
    setText("studioDashDemandesUrgentes", n(demandes.urgentes));
    setText("studioDashDemandesInProgress", n(demandes.prises_en_charge));
    renderActions(main.actions_prioritaires || []);

    setText("studioDashFormationTotal", n(demandes.a_instruire));
    setText("studioDashFormationLabel", `${n(demandes.a_instruire)} à qualifier · ${n(demandes.urgentes)} urgent(s)`);
    setRing("studioDashFormationDonut", demandes.ouvertes ? Math.min(100, 20 + n(demandes.urgentes) * 15) : 0);

    setText("studioDashEntretiensTodo", n(entretiens.a_realiser));
    setText("studioDashEntretiensProgress", n(entretiens.en_cours));
    setText("studioDashEntretiensSign", n(entretiens.a_signer));

    setText("studioDashTransmissionPct", pct(tr.pct));
    setText("studioDashTransmissionLabel", `${n(tr.postes_risque)} poste(s) à sécuriser`);
    setRing("studioDashTransmissionRing", tr.pct);

    setText("studioDashPostesSansComp", n(ref.postes_sans_competence));
    setText("studioDashCompSansDomaine", n(ref.competences_sans_domaine));
    setText("studioDashCollabSansPoste", n(ref.collaborateurs_sans_poste));
    setText("studioDashReliabilityPct", pct(reliability.pct));
    renderSignal(reliability.pct);

    const linkedSection = byId("studioDashLinkedSection");
    const showLinked = !!linked.visible;
    if (linkedSection) linkedSection.style.display = showLinked ? "block" : "none";
    if (showLinked){
      const lp = linked.portfolio || {};
      const count = `${n(lp.structures_danger)} / ${n(lp.structures_total)}`;
      setText("studioDashLinkedCount", count);
      renderLinkedStructures(linked.structures_prioritaires || []);
    }
  }

  async function load(){
    const ownerId = getOwnerId();
    if (!ownerId){ setStatus("Accès Studio introuvable.", true); return; }
    const token = await getToken();
    if (!token){ setStatus("Session expirée.", true); return; }

    await loadContext(ownerId, token);

    const f = getFilters();
    setText("studioDashCriticiteLabel", `≥ ${f.criticite_min}`);
    setStatus("Chargement…");

    const url = new URL(`${API_BASE}/studio/dashboard/overview/${encodeURIComponent(ownerId)}`);
    if (f.id_service) url.searchParams.set("id_service", f.id_service);
    url.searchParams.set("criticite_min", String(f.criticite_min));

    const r = await fetch(url.toString(), { headers: { "Authorization": `Bearer ${token}` }, credentials: "same-origin" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.detail || `Erreur HTTP ${r.status}`);
    render(data || {});
  }

  function bind(){
    if (_bound) return;
    _bound = true;
    byId("studioDashService")?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashCriticite")?.addEventListener("input", () => setText("studioDashCriticiteLabel", `≥ ${getFilters().criticite_min}`));
    byId("studioDashCriticite")?.addEventListener("change", () => load().catch(e => setStatus(e.message || String(e), true)));
    byId("studioDashRefresh")?.addEventListener("click", () => load().catch(e => setStatus(e.message || String(e), true)));
  }

  bind();
  load().catch(e => setStatus(e.message || String(e), true));
})();
