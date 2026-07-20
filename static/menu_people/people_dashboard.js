(function () {
  const P = window.PeoplePortal;
  if (!P) return;

  const RING_RADIUS = 62;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  function byId(id){ return document.getElementById(id); }

  function masteryLevel(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return "Non évalué";
    if (value <= 25) return "Débutant";
    if (value <= 50) return "Intermédiaire";
    if (value <= 75) return "Avancé";
    return "Expert";
  }

  function setMasteryRing(score) {
    const value = Math.max(0, Math.min(100, Number(score) || 0));
    const ring = byId("ppDashMasteryRing");
    const pct = byId("ppDashMastery");
    const level = byId("ppDashMasteryLevel");

    if (ring) {
      ring.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
      ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - value / 100)}`;
    }
    if (pct) pct.textContent = `${Math.round(value)}%`;
    if (level) level.textContent = masteryLevel(value);
  }

  function eventDateValue(event) {
    const raw = event.date_debut_formation || event.date_debut || "";
    const value = new Date(String(raw).slice(0, 10) + "T00:00:00");
    return Number.isNaN(value.getTime()) ? null : value;
  }

  function eventRow(event) {
    const isFormation = Boolean(event.id_action_formation);
    const date = event.date_debut_formation || event.date_debut;
    const title = isFormation ? (event.titre || "Formation programmée") : "Indisponibilité";
    const kind = isFormation ? "Formation" : "Calendrier";

    return `<div class="people-dashboard-event-row">
      <div class="people-dashboard-event-date">${P.escapeHtml(P.fmtDate(date))}</div>
      <div>
        <div class="people-dashboard-event-title">${P.escapeHtml(title)}</div>
        <div class="people-dashboard-event-kind">${P.escapeHtml(kind)}</div>
      </div>
    </div>`;
  }

  async function loadEvents(id) {
    const target = byId("ppDashEvents");
    if (!target) return;

    const data = await P.api(`/people/calendrier/${encodeURIComponent(id)}`).catch(() => null);
    if (!data) {
      target.innerHTML = P.itemEmpty("Les prochains événements sont indisponibles.");
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const events = []
      .concat(Array.isArray(data.formations) ? data.formations : [])
      .concat(Array.isArray(data.indisponibilites) ? data.indisponibilites : [])
      .filter(event => {
        const date = eventDateValue(event);
        return date && date >= today;
      })
      .sort((a, b) => eventDateValue(a) - eventDateValue(b))
      .slice(0, 3);

    target.innerHTML = events.length
      ? events.map(eventRow).join("")
      : P.itemEmpty("Aucun événement prochain dans votre calendrier.");
  }

  function bindLinks() {
    document.querySelectorAll("#view-dashboard [data-people-view]").forEach(button => {
      button.addEventListener("click", () => {
        const view = String(button.dataset.peopleView || "").trim();
        const menuItem = view ? document.querySelector(`.menu-item[data-view="${view}"]`) : null;
        if (menuItem) menuItem.click();
      });
    });
  }

  async function load() {
    bindLinks();

    const id = P.getEffectifId();
    if (!id) return;

    const data = await P.api(`/people/dashboard/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    if (data.error) {
      const target = byId("ppDashProfile");
      if (target) target.innerHTML = P.itemEmpty(data.error);
      setMasteryRing(0);
      return;
    }

    const profile = data.profile || {};
    const kpis = data.kpis || {};

    const prenom = String(profile.prenom || "").trim();
    const prenomEl = byId("ppDashPrenom");
    if (prenomEl) prenomEl.textContent = prenom || "";

    const posteEl = byId("ppDashPoste");
    if (posteEl) posteEl.textContent = profile.intitule_poste || "Poste non renseigné";

    setMasteryRing(kpis.maitrise_poste);

    const situation = byId("ppDashProfile");
    if (situation) {
      situation.innerHTML = [
        P.infoRow("Entreprise", profile.nom_owner),
        P.infoRow("Service", profile.nom_service),
        P.infoRow("Poste", profile.intitule_poste),
        P.infoRow("Dernière évaluation", kpis.derniere_evaluation ? P.fmtDate(kpis.derniere_evaluation) : "Non renseignée")
      ].join("");
    }

    loadEvents(id);
  }

  load();
})();
