(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  function byId(id) { return document.getElementById(id); }

  function textOrDash(value) {
    const v = (value ?? "").toString().trim();
    return v || "â€”";
  }

  function setText(id, value) {
    const el = byId(id);
    if (!el) return;
    el.textContent = textOrDash(value);
  }

  function getConsultantId() {
    const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
    if (pid) return pid;

    const qid = new URL(window.location.href).searchParams.get("id");
    return (qid || "").trim();
  }

  async function fetchProfile() {
    await (window.__partnerAuthReady || Promise.resolve(null));

    if (!window.PortalAuthCommon) return null;

    const session = await window.PortalAuthCommon.getSession().catch(() => null);
    const token = session?.access_token || "";
    if (!token) return null;

    const idConsultant = getConsultantId();
    if (!idConsultant) return null;

    const r = await fetch(`${API_BASE}/partner/profile/${encodeURIComponent(idConsultant)}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) return null;
    return data;
  }

  async function render() {
    const p = await fetchProfile();

    setText("partnerInfoNom", p?.nom);
    setText("partnerInfoPrenom", p?.prenom);
    setText("partnerInfoEmail", p?.email);
    setText("partnerInfoTelephone", p?.telephone_mobile || p?.telephone);
    setText("partnerInfoType", p?.type_consultant);
    setText("partnerInfoOwner", p?.nom_owner);

    const loc = [p?.code_postal, p?.ville, p?.position_geographique]
      .map(x => (x || "").toString().trim())
      .filter(Boolean)
      .join(" â€¢ ");

    setText("partnerInfoLocalisation", loc);
    setText("partnerInfoCode", p?.code_consultant);
  }

  render();
})();
