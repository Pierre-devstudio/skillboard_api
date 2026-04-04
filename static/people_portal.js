(function () {
  const API_BASE = window.PORTAL_API_BASE || "https://skillboard-services.onrender.com";

  window.portal.registerMenu({
    view: "dashboard",
    htmlUrl: "/menu_people/people_dashboard.html"
  });

  window.portal.registerMenu({
    view: "informations",
    htmlUrl: "/menu_people/people_informations.html"
  });

  window.portal.registerMenu({
    view: "calendrier",
    htmlUrl: "/menu_people/people_calendrier.html"
  });

  window.portal.registerMenu({
    view: "parcours",
    htmlUrl: "/menu_people/people_parcours.html"
  });

  window.portal.registerMenu({
    view: "competences",
    htmlUrl: "/menu_people/people_competences.html"
  });

  window.portal.registerMenu({
    view: "auto_evaluation",
    htmlUrl: "/menu_people/people_auto_evaluation.html"
  });

  window.portal.registerMenu({
    view: "formations",
    htmlUrl: "/menu_people/people_formations.html"
  });

  function byId(id){ return document.getElementById(id); }

  function buildPortalUrlWithId(effectifId) {
    return `/people/?id=${encodeURIComponent(effectifId)}`;
  }

  function formatProfileLabel(p) {
    const fullName = [p?.prenom || "", p?.nom || ""].join(" ").trim();
    const ent = (p?.nom_owner || "").trim();
    if (fullName && ent) return `${fullName} - ${ent}`;
    return fullName || ent || "Profil";
  }

  async function tryFillTopbar() {
    const info = byId("topbarInfo");
    const name = byId("topbarName");
    const sel = byId("selPeopleProfile");

    if (info) info.textContent = "Chargement…";
    if (name) name.textContent = "People";

    try {
      if (!window.PortalAuthCommon) return;

      const session = await window.PortalAuthCommon.getSession().catch(() => null);
      const token = session?.access_token || "";
      if (!token) return;

      const rMe = await fetch(`${API_BASE}/people/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const me = await rMe.json().catch(() => null);

      if (rMe.ok && me) {
        if (info) info.textContent = (me.email || "");
      }

      const rScope = await fetch(`${API_BASE}/people/me/scope`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const scope = await rScope.json().catch(() => null);

      let currentProfile = null;

      if (rScope.ok && scope && Array.isArray(scope.profiles) && scope.profiles.length) {
        const currentId = (new URL(window.location.href).searchParams.get("id") || "").trim();
        currentProfile = currentId
          ? scope.profiles.find(p => p && p.id_effectif === currentId)
          : null;

        currentProfile = currentProfile || scope.profiles[0] || null;

        const fullName = currentProfile
          ? [currentProfile.prenom || "", currentProfile.nom || ""].join(" ").trim()
          : "";

        if (name) name.textContent = fullName || "People";

        if (sel) {
          if (scope.profiles.length > 1) {
            sel.innerHTML = `<option value="">Profil…</option>`;
            scope.profiles.forEach(p => {
              const opt = document.createElement("option");
              opt.value = p.id_effectif || "";
              opt.textContent = formatProfileLabel(p);
              if ((p.id_effectif || "") === (currentProfile?.id_effectif || "")) {
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
        if (name) name.textContent = "People";
        if (sel) sel.style.display = "none";
      }
    } catch (_) {
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try { await (window.__peopleAuthReady || Promise.resolve(null)); } catch (_) {}
    tryFillTopbar();
  });
})();