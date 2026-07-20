(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  let lastItems = [];
  function byId(id){ return document.getElementById(id); }

  function row(r, saved) {
    const s = saved && Array.isArray(saved.items) ? saved.items.find(x => x.id_comp === r.id_comp) : null;
    const val = s?.niveau_auto || r.niveau_actuel || "";
    const comment = s?.commentaire || "";
    const checked = s?.besoin_accompagnement ? "checked" : "";
    return `<div class="pp-auto-row" data-id="${P.escapeHtml(r.id_comp)}">
      <div class="pp-auto-main"><div class="pp-row-title">${P.escapeHtml(r.intitule)}</div><div class="pp-row-sub">${P.escapeHtml(r.code || "")} · Niveau attendu ${P.levelLabel(r.niveau_requis)} · Niveau actuel ${P.levelLabel(r.niveau_actuel)}</div></div>
      <div class="pp-auto-fields">
        <select class="pp-auto-level"><option value="">Niveau</option><option value="A" ${val === "A" ? "selected" : ""}>A</option><option value="B" ${val === "B" ? "selected" : ""}>B</option><option value="C" ${val === "C" ? "selected" : ""}>C</option></select>
        <label class="pp-check"><input type="checkbox" class="pp-auto-need" ${checked}> Besoin d’accompagnement</label>
        <input type="text" class="pp-auto-comment" placeholder="Commentaire" value="${P.escapeHtml(comment)}">
      </div>
    </div>`;
  }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const data = await P.api(`/people/entretiens/auto-evaluation/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    const el = byId("ppAutoList");
    if (!el) return;
    if (data.error) {
      el.innerHTML = P.itemEmpty(data.error);
      return;
    }
    lastItems = data.items || [];
    const saved = data.entretien?.auto_evaluation_people || {};
    el.innerHTML = lastItems.length ? lastItems.map(r => row(r, saved)).join("") : P.itemEmpty("Aucune compétence à préparer pour le poste actuel.");
    if (byId("ppAutoComment")) byId("ppAutoComment").value = saved.commentaire_general || "";
  }

  async function save() {
    const id = P.getEffectifId();
    const msg = byId("ppAutoMsg");
    if (msg) msg.textContent = "Enregistrement…";
    const items = Array.from(document.querySelectorAll(".pp-auto-row")).map(row => ({
      id_comp: row.getAttribute("data-id") || "",
      niveau_auto: row.querySelector(".pp-auto-level")?.value || "",
      commentaire: row.querySelector(".pp-auto-comment")?.value || "",
      besoin_accompagnement: !!row.querySelector(".pp-auto-need")?.checked
    }));
    const res = await P.api(`/people/entretiens/auto-evaluation/${encodeURIComponent(id)}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, commentaire_general: byId("ppAutoComment")?.value || "" })
    }).catch(err => ({ error: err.message }));
    if (res.error) {
      if (msg) msg.textContent = res.error;
      return;
    }
    if (msg) {
      msg.textContent = "Enregistré avec succès";
      setTimeout(() => { msg.textContent = ""; }, 5000);
    }
  }

  byId("ppAutoSave")?.addEventListener("click", save);
  load();
})();
