(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  let selectedComp = "";
  let searchTimer = null;
  function byId(id){ return document.getElementById(id); }

  function compRow(r, required) {
    return `<div class="pp-list-row">
      <div><div class="pp-row-title">${P.escapeHtml(r.intitule)}</div><div class="pp-row-sub">${P.escapeHtml(r.code || "")} Â· ${P.escapeHtml(r.domaine || "Domaine non renseignÃ©")}</div></div>
      <div class="pp-row-badges">
        ${required ? P.levelBadge(r.niveau_requis) : ""}
        ${P.levelBadge(r.niveau_actuel)}
      </div>
    </div>`;
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const data = await P.api(`/people/demo/competences/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (data.error) {
      const el = byId("ppPosteComps");
      if (el) el.innerHTML = P.itemEmpty(data.error);
      return;
    }
    const poste = byId("ppPosteComps");
    const autres = byId("ppOtherComps");
    if (poste) poste.innerHTML = (data.poste || []).length ? data.poste.map(r => compRow(r, true)).join("") : P.itemEmpty("Aucune compÃ©tence rattachÃ©e au poste.");
    if (autres) autres.innerHTML = (data.autres || []).length ? data.autres.map(r => compRow(r, false)).join("") : P.itemEmpty("Aucune compÃ©tence complÃ©mentaire dÃ©clarÃ©e.");
  }

  function openModal() {
    selectedComp = "";
    byId("ppCompAdd").disabled = true;
    const m = byId("ppCompModal");
    if (m) m.style.display = "flex";
    loadCatalogue();
  }
  function closeModal() {
    const m = byId("ppCompModal");
    if (m) m.style.display = "none";
    const msg = byId("ppCompMsg");
    if (msg) msg.textContent = "";
  }

  async function loadCatalogue() {
    const id = P.getEffectifId();
    const q = byId("ppCompSearch")?.value || "";
    const el = byId("ppCatalogueList");
    if (!el) return;
    el.innerHTML = P.itemEmpty("Recherche en cours...");
    const data = await P.api(`/people/demo/competences/${encodeURIComponent(id)}/catalogue?q=${encodeURIComponent(q)}`).catch(err => ({ error: err.message }));
    if (data.error) {
      el.innerHTML = P.itemEmpty(data.error);
      return;
    }
    const rows = data.items || [];
    if (!rows.length) {
      el.innerHTML = P.itemEmpty("Aucune compÃ©tence disponible avec ces critÃ¨res.");
      return;
    }
    el.innerHTML = rows.map(r => `<button type="button" class="pp-select-row" data-id="${P.escapeHtml(r.id_comp)}"><span><strong>${P.escapeHtml(r.intitule)}</strong><small>${P.escapeHtml(r.code || "")} Â· ${P.escapeHtml(r.domaine || "Domaine non renseignÃ©")}</small></span></button>`).join("");
    el.querySelectorAll("[data-id]").forEach(btn => {
      btn.onclick = () => {
        selectedComp = btn.getAttribute("data-id") || "";
        el.querySelectorAll(".pp-select-row").forEach(b => b.classList.remove("is-selected"));
        btn.classList.add("is-selected");
        byId("ppCompAdd").disabled = !selectedComp;
      };
    });
  }

  async function addComp() {
    if (!selectedComp) return;
    const id = P.getEffectifId();
    const msg = byId("ppCompMsg");
    if (msg) msg.textContent = "Ajout en coursâ€¦";
    const res = await P.api(`/people/demo/competences/${encodeURIComponent(id)}/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_comp: selectedComp, niveau_actuel: byId("ppCompLevel")?.value || "" })
    }).catch(err => ({ error: err.message }));
    if (res.error) {
      if (msg) msg.textContent = res.error;
      return;
    }
    closeModal();
    load();
  }

  byId("ppBtnOpenCompModal")?.addEventListener("click", openModal);
  byId("ppCompClose")?.addEventListener("click", closeModal);
  byId("ppCompCancel")?.addEventListener("click", closeModal);
  byId("ppCompAdd")?.addEventListener("click", addComp);
  byId("ppCompSearch")?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCatalogue, 250);
  });
  load();
})();
