(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function getOwnerId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;

    const qid = new URL(window.location.href).searchParams.get("id");
    return (qid || "").trim();
  }

  function textOrDash(v) {
    const s = (v === null || v === undefined) ? "" : String(v);
    const t = s.trim();
    return t ? t : "—";
  }

  async function fetchData() {
    await (window.__studioAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return { ok: false, msg: "Auth non initialisée." };

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return { ok: false, msg: "Session absente." };

    const idOwner = getOwnerId();
    if (!idOwner) return { ok: false, msg: "Owner manquant (?id=...)." };
    if (idOwner === "__superadmin__") return { ok: false, msg: "Mode super admin: sélectionnez un owner via ?id=..." };

    const r = await fetch(`${API_BASE}/studio/data/${encodeURIComponent(idOwner)}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const det = (data && (data.detail || data.message)) ? String(data.detail || data.message) : "";
      return { ok: false, msg: `Erreur API (${r.status}) ${det}`.trim() };
    }
    return { ok: true, data: data || {} };
  }

  async function render() {
    const statusEl = byId("dataStatus");
    const ownerNameEl = byId("dataOwnerName");
    const ownerIdEl = byId("dataOwnerId");
    const userEmailEl = byId("dataUserEmail");
    const userPrenomEl = byId("dataUserPrenom");
    const refTypeEl = byId("dataUserRefType");
    const refIdEl = byId("dataUserRefId");

    if (statusEl) statusEl.textContent = "Chargement…";

    const res = await fetchData();

    if (!res.ok) {
      if (statusEl) statusEl.textContent = res.msg || "Impossible de charger les données.";
      if (ownerNameEl) ownerNameEl.textContent = "—";
      if (ownerIdEl) ownerIdEl.textContent = "—";
      if (userEmailEl) userEmailEl.textContent = "—";
      if (userPrenomEl) userPrenomEl.textContent = "—";
      if (refTypeEl) refTypeEl.textContent = "—";
      if (refIdEl) refIdEl.textContent = "—";
      return;
    }

    const d = res.data || {};
    if (statusEl) statusEl.textContent = "Données chargées.";

    if (ownerNameEl) ownerNameEl.textContent = textOrDash(d.nom_owner);
    if (ownerIdEl) ownerIdEl.textContent = textOrDash(d.id_owner);

    if (userEmailEl) userEmailEl.textContent = textOrDash(d.email);
    if (userPrenomEl) userPrenomEl.textContent = textOrDash(d.prenom);

    if (refTypeEl) refTypeEl.textContent = textOrDash(d.user_ref_type);
    if (refIdEl) refIdEl.textContent = textOrDash(d.id_user_ref);
  }

  render();
})();