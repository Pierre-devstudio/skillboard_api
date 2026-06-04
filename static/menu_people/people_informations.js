(function () {
  const P = window.PeoplePortal;
  if (!P) return;
  function byId(id){ return document.getElementById(id); }

  async function load() {
    const id = P.getEffectifId();
    if (!id) return;
    const data = await P.api(`/people/demo/profile/${encodeURIComponent(id)}`).catch(err => ({ error: err.message }));
    const p = data.profile || {};
    const identity = byId("ppInfoIdentity");
    const poste = byId("ppInfoPoste");
    const mission = byId("ppInfoMission");

    if (data.error) {
      if (identity) identity.innerHTML = P.itemEmpty(data.error);
      return;
    }

    if (identity) {
      identity.innerHTML = [
        P.infoRow("Nom", [p.prenom, p.nom].filter(Boolean).join(" ")),
        P.infoRow("Civilité", p.civilite),
        P.infoRow("Email", p.email),
        P.infoRow("Téléphone", p.telephone),
        P.infoRow("Adresse", [p.adresse, p.code_postal, p.ville, p.pays].filter(Boolean).join(" - ")),
        P.infoRow("Matricule", p.matricule)
      ].join("");
    }

    if (poste) {
      poste.innerHTML = [
        P.infoRow("Entreprise", p.nom_owner),
        P.infoRow("Service", p.nom_service),
        P.infoRow("Poste actuel", p.intitule_poste),
        P.infoRow("Contrat", p.type_contrat),
        P.infoRow("Date d’entrée", P.fmtDate(p.date_entree)),
        P.infoRow("Début sur le poste", P.fmtDate(p.date_debut_poste)),
        P.infoRow("Niveau d’études", p.niveau_education)
      ].join("");
    }

    if (mission) {
      mission.innerHTML = `<div class="pp-rich">${P.escapeHtml(p.mission_principale || "Mission principale non renseignée.")}</div>
      <div class="pp-section-sep"></div>
      <div class="pp-muted-title">Perspectives d’évolution</div>
      <div class="pp-rich">${P.escapeHtml(p.perspectives_evolution || "Non renseignées.")}</div>`;
    }
  }

  load();
})();
