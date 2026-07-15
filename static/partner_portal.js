(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  window.portal.registerMenu({
    view: "dashboard",
    htmlUrl: "/menu_partner/partner_dashboard.html"
  });

  window.portal.registerMenu({
    view: "informations",
    htmlUrl: "/menu_partner/partner_informations.html"
  });

  const COMING_SOON = "/menu_partner/partner_coming_soon.html";

  window.portal.registerMenu({ view: "competences", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "clients", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "interventions", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "plans_actions", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "comptes_rendus", htmlUrl: COMING_SOON });
  window.portal.registerMenu({ view: "echanges", htmlUrl: COMING_SOON });

  function byId(id){ return document.getElementById(id); }

  function buildPortalUrlWithId(consultantId) {
    return `/partner/?id=${encodeURIComponent(consultantId)}`;
  }

  function formatProfileLabel(p) {
    const fullName = [p?.prenom || "", p?.nom || ""].join(" ").trim();
    const owner = (p?.nom_owner || "").trim();
    if (fullName && owner) return `${fullName} - ${owner}`;
    return fullName || owner || "Profil";
  }

  async function tryFillTopbar() {
    const info = byId("topbarInfo");
    const name = byId("topbarName");
    const sel = byId("selPartnerProfile");

    if (info) info.textContent = "Chargementâ€¦";
    if (name) name.textContent = "Partner";

    try {
      if (!window.PortalAuthCommon) return;

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      const token = session?.access_token || "";
      if (!token) return;

      const rMe = await fetch(`${API_BASE}/partner/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await rMe.json().catch(() => null);

      if (rMe.ok && me) {
        if (info) info.textContent = (me.email || "");
      }

      const rScope = await fetch(`${API_BASE}/partner/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const scope = await rScope.json().catch(() => null);

      let currentProfile = null;

      if (rScope.ok && scope && Array.isArray(scope.profiles) && scope.profiles.length) {
        const currentId = (new URL(window.location.href).searchParams.get("id") || "").trim();

        currentProfile = currentId
          ? scope.profiles.find(p => p && p.id_consultant === currentId)
          : null;

        currentProfile = currentProfile || scope.profiles[0] || null;

        const fullName = currentProfile
          ? [currentProfile.prenom || "", currentProfile.nom || ""].join(" ").trim()
          : "";

        if (name) name.textContent = fullName || "Partner";

        if (sel) {
          if (scope.profiles.length > 1) {
            sel.innerHTML = `<option value="">Profilâ€¦</option>`;

            scope.profiles.forEach(p => {
              const opt = document.createElement("option");
              opt.value = p.id_consultant || "";
              opt.textContent = formatProfileLabel(p);

              if ((p.id_consultant || "") === (currentProfile?.id_consultant || "")) {
                opt.selected = true;
              }

              sel.appendChild(opt);
            });

            sel.style.display = "inline-flex";
            sel.onchange = () => {
              const v = (sel.value || "").trim();
              if (!v) return;
              window.location.href = buildPortalUrlWithId(v);
            };
          } else {
            sel.style.display = "none";
          }
        }
      } else {
        if (name) name.textContent = "Partner";
        if (sel) sel.style.display = "none";
      }
    } catch (_) {
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try { await (window.__partnerAuthReady || Promise.resolve(null)); } catch (_) {}
    tryFillTopbar();
  });
})();
