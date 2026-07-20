(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  let cache = null;
  function byId(id){ return document.getElementById(id); }

  function openModal() {
    const m = byId("ppBreakModal");
    if (m) m.style.display = "flex";
    const today = new Date().toISOString().slice(0,10);
    if (byId("ppBreakStart") && !byId("ppBreakStart").value) byId("ppBreakStart").value = today;
    if (byId("ppBreakEnd") && !byId("ppBreakEnd").value) byId("ppBreakEnd").value = today;
  }
  function closeModal() {
    const m = byId("ppBreakModal");
    if (m) m.style.display = "none";
    const msg = byId("ppBreakMsg");
    if (msg) msg.textContent = "";
  }

  function renderBreaks(rows) {
    const el = byId("ppBreakList");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = P.itemEmpty("Aucune indisponibilité déclarée.");
      return;
    }
    el.innerHTML = rows.map(r => `<div class="pp-list-row">
      <div><div class="pp-row-title">${P.fmtDate(r.date_debut)} → ${P.fmtDate(r.date_fin)}</div><div class="pp-row-sub">Indisponibilité déclarée</div></div>
      <button class="pp-icon-btn" data-break-archive="${P.escapeHtml(r.id_break)}" title="Archiver">🗑</button>
    </div>`).join("");
    el.querySelectorAll("[data-break-archive]").forEach(btn => {
      btn.onclick = async () => {
        const idEffectif = P.getEffectifId();
        await P.api(`/people/calendrier/${encodeURIComponent(idEffectif)}/breaks/${encodeURIComponent(btn.getAttribute("data-break-archive"))}/archive`, { method: "POST" }).catch(() => null);
        load();
      };
    });
  }

  function renderTrainings(rows) {
    const el = byId("ppTrainingList");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = P.itemEmpty("Aucune formation programmée.");
      return;
    }
    el.innerHTML = rows.map(r => `<div class="pp-list-row">
      <div><div class="pp-row-title">${P.escapeHtml(r.titre)}</div><div class="pp-row-sub">${P.fmtDate(r.date_debut_formation)} → ${P.fmtDate(r.date_fin_formation)} · ${P.escapeHtml(r.organisme || "Organisme non renseigné")}</div></div>
      ${P.badge(r.etat_action || r.etat_invitation || "programmé", "soft")}
    </div>`).join("");
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    cache = await P.api(`/people/calendrier/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (cache.error) {
      const el = byId("ppBreakList");
      if (el) el.innerHTML = P.itemEmpty(cache.error);
      return;
    }
    renderBreaks(cache.indisponibilites || []);
    renderTrainings(cache.formations || []);
  }

  async function saveBreak() {
    const id = P.getEffectifId();
    const msg = byId("ppBreakMsg");
    const start = byId("ppBreakStart")?.value || "";
    const end = byId("ppBreakEnd")?.value || "";
    if (msg) msg.textContent = "Enregistrement…";
    const res = await P.api(`/people/calendrier/${encodeURIComponent(id)}/breaks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date_debut: start, date_fin: end })
    }).catch(err => ({ error: err.message }));
    if (res.error) {
      if (msg) msg.textContent = res.error;
      return;
    }
    closeModal();
    load();
  }

  byId("ppBtnOpenBreak")?.addEventListener("click", openModal);
  byId("ppBreakClose")?.addEventListener("click", closeModal);
  byId("ppBreakCancel")?.addEventListener("click", closeModal);
  byId("ppBreakSave")?.addEventListener("click", saveBreak);
  load();
})();
