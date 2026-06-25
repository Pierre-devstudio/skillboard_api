/* ======================================================
   static/menus/skills_simulations_rh.js
   Simulation RH - atelier de scénarios d'organisation
   ====================================================== */

(function () {
  let _bound = false;
  let _portal = null;
  let _optionsLoaded = false;
  let _options = { postes: [], effectifs: [], competences: [], requirements: [], recommendations: {} };
  let _selectedPosteId = "";
  let _selectedBrick = "mobilite_effectif";
  let _scenario = [];
  let _lastResult = null;
  let _lastCvAnalysis = null;
  let _context = null;

  const STORE_COMPARE = "sb_simulations_rh_compare_v3";
  const STORE_SERVICE = "sb_simulations_rh_service";
  const STORE_CRIT = "sb_simulations_rh_criticite";
  const STORE_CONTEXT = "sb_simulations_rh_context_v1";

  const BRICKS = {
    mobilite_effectif: {
      title: "Déplacer une personne",
      short: "Tester une mobilité, un remplacement ou un renfort humain.",
      icon: "⇄",
      group: "immediate",
      temporalite: "immediate",
    },
    transfert_charge: {
      title: "Transférer une charge",
      short: "Déplacer une activité ou une compétence attendue vers un autre poste.",
      icon: "⇢",
      group: "immediate",
      temporalite: "immediate",
    },
    renfort_poste: {
      title: "Ajouter un renfort",
      short: "Tester un relais interne, un profil virtuel ou un CV candidat.",
      icon: "+",
      group: "immediate",
      temporalite: "immediate",
    },
    depart_effectif: {
      title: "Retirer une personne",
      short: "Tester une sortie ou une absence longue avec durée.",
      icon: "−",
      group: "immediate",
      temporalite: "immediate",
    },
    renforcer_titulaire: {
      title: "Renforcer le titulaire",
      short: "Projeter la mise à niveau du titulaire sur les compétences attendues du poste.",
      icon: "⇡",
      group: "projected",
      temporalite: "development",
    },
    montee_competence: {
      title: "Projeter une compétence",
      short: "Mesurer l’impact si un niveau cible est atteint.",
      icon: "↗",
      group: "projected",
      temporalite: "development",
    },
  };

  function byId(id) { return document.getElementById(id); }
  function esc(s) { return (s ?? "").toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
  function int(v) { return Math.round(num(v)); }
  function errMsg(e) { if (!e) return "Erreur inconnue"; if (typeof e === "string") return e; if (e.message) return e.message; if (e.detail) return typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail); try { return JSON.stringify(e); } catch (_) { return String(e); } }

  function setStatus(message, type) {
    const el = byId("simStatus");
    if (!el) return;
    if (!message) {
      el.style.display = "none";
      el.textContent = "";
      el.className = "sb-hint";
      return;
    }
    el.style.display = "block";
    el.className = "sb-hint" + (type === "error" ? " error" : "");
    el.textContent = message;
  }

  function apiUrl(path, params) {
    const url = new URL(`${_portal.apiBase}${path}`);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
    });
    return url.toString();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getCriticiteMin() {
    const raw = parseInt(byId("simCriticiteRange")?.value || localStorage.getItem(STORE_CRIT) || "70", 10);
    return Number.isNaN(raw) ? 70 : Math.max(0, Math.min(100, raw));
  }

  function setCriticiteMin(v) {
    const raw = (v === null || v === undefined || v === "") ? "70" : String(v);
    const parsed = parseInt(raw, 10);
    const n = Math.max(0, Math.min(100, Number.isNaN(parsed) ? 70 : parsed));
    const input = byId("simCriticiteRange");
    const label = byId("simCriticiteValue");
    if (input) input.value = String(n);
    if (label) label.textContent = String(n);
    localStorage.setItem(STORE_CRIT, String(n));
    return n;
  }

  function getServiceId() {
    return window.portal?.serviceFilter?.toQueryId?.(byId("simServiceSelect")?.value || "") || null;
  }

  function posteById(id) { return (_options.postes || []).find(p => String(p.id_poste || "") === String(id || "")) || null; }
  function effectifById(id) { return (_options.effectifs || []).find(e => String(e.id_effectif || "") === String(id || "")) || null; }
  function compById(id) { return (_options.competences || []).find(c => String(c.id_comp || "") === String(id || "")) || (_options.requirements || []).find(c => String(c.id_comp || "") === String(id || "")) || null; }

  function posteCode(p) {
    if (!p) return "";
    return String(p.codif_client || p.codif_poste || "").trim();
  }

  function posteLabel(p) {
    if (!p) return "Poste";
    const code = posteCode(p);
    return `${code ? code + " · " : ""}${p.intitule_poste || "Poste"}`;
  }

  function posteTitle(p) {
    return (p?.intitule_poste || "Poste").toString().trim() || "Poste";
  }

  function posteShort(p) {
    const code = posteCode(p);
    return code || posteTitle(p);
  }

  function effectifLabel(e) {
    if (!e) return "Collaborateur";
    const poste = (e.intitule_poste || "").trim();
    return `${e.nom_complet || "Collaborateur"}${poste ? " — " + poste : ""}`;
  }

  function compLabel(c) {
    if (!c) return "Compétence";
    const code = (c.code || "").trim();
    return `${code ? code + " · " : ""}${c.intitule || "Compétence"}`;
  }

  function compShort(c) {
    const code = (c?.code || "").toString().trim();
    return code || (c?.intitule || "Compétence");
  }

  function levelLabel(code) {
    const c = (code || "").toString().trim().toUpperCase();
    return ({ A: "Débutant", B: "Intermédiaire", C: "Avancé", D: "Expert" }[c]) || c || "niveau cible";
  }

  function brickKind(b) {
    if (!b) return "Action";
    if (b.type === "recrutement_virtuel") return "Profil virtuel";
    if (b.type === "recrutement_cv") return "Analyse CV";
    if (b.type === "relais_interne") return "Relais interne";
    if (b.type === "absence_effectif") return "Absence longue";
    if (b.type === "depart_effectif") return "Départ";
    if (b.type === "transfert_charge") return "Charge transférée";
    if (b.type === "renforcer_titulaire") return "Renforcement titulaire";
    if (b.type === "montee_competence") return "Compétence projetée";
    return "Déplacement";
  }

  function brickSummary(b) {
    if (!b) return "Action RH";
    const eff = effectifById(b.id_effectif);
    const source = posteById(b.id_poste);
    const target = posteById(b.id_poste_cible || b.id_poste);
    const comp = compById(b.id_comp);
    const person = eff?.nom_complet || "Collaborateur";

    if (b.type === "transfert_charge") {
      return `${compShort(comp)} · ${posteShort(source)} → ${posteShort(target)}`;
    }
    if (b.type === "recrutement_virtuel") {
      return `Profil virtuel · ${posteShort(target)}`;
    }
    if (b.type === "recrutement_cv") {
      return `${b.candidat_nom || "Candidat CV"} · ${posteShort(target)}`;
    }
    if (b.type === "relais_interne") {
      return `${person} · relais ${posteShort(target)}`;
    }
    if (b.type === "absence_effectif") {
      return `${person} · ${b.duree_libelle || "durée à confirmer"}`;
    }
    if (b.type === "depart_effectif") {
      return person;
    }
    if (b.type === "renforcer_titulaire") {
      return `${person} · mise à niveau ${posteShort(target)}`;
    }
    if (b.type === "montee_competence") {
      return `${person} · ${compShort(comp)} → ${levelLabel(b.niveau_simule)}`;
    }
    return `${person} → ${posteShort(target)}`;
  }

  function deltaText(v) {
    const n = int(v);
    if (n === 0) return "0 pt";
    return `${n > 0 ? "+" : ""}${n} pt${Math.abs(n) > 1 ? "s" : ""}`;
  }

  function deltaBadge(v, inverse) {
    const n = int(v);
    const good = inverse ? n > 0 : n < 0;
    const bad = inverse ? n < 0 : n > 0;
    const cls = good ? "sb-badge--success" : bad ? "sb-badge--warning" : "";
    return `<span class="sb-badge ${cls}">${esc(deltaText(n))}</span>`;
  }

  function trendWord(delta, inverse) {
    const n = int(delta);
    if (n === 0) return "stable";
    const good = inverse ? n > 0 : n < 0;
    return good ? "amélioration" : "dégradation";
  }

  function trendClass(delta, inverse) {
    const n = int(delta);
    if (n === 0) return "is-neutral";
    const good = inverse ? n > 0 : n < 0;
    return good ? "is-good" : "is-bad";
  }

  function ensureResultVisualStyles() {
    if (document.getElementById("simResultVisualStylesV3")) return;
    const style = document.createElement("style");
    style.id = "simResultVisualStylesV3";
    style.textContent = `
      .sim-result-overview-grid--compact{grid-template-columns:1.35fr 1fr .9fr .9fr;}
      .sim-result-focus-ring-card{border:1px solid var(--sb-gray-200);border-radius:14px;padding:12px;background:#fff;box-shadow:0 10px 24px rgba(15,23,42,.04);}
      .sim-result-focus-ring-card.is-good{border-color:color-mix(in srgb,var(--sb-success) 32%,var(--sb-gray-200));}
      .sim-result-focus-ring-card.is-bad{border-color:color-mix(in srgb,var(--sb-warning) 32%,var(--sb-gray-200));}
      .sim-result-focus-ring-layout{display:flex;align-items:center;gap:14px;margin-top:8px;}
      .sim-result-ring{--ring-pct:0;width:84px;height:84px;flex:0 0 84px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--accent) calc(var(--ring-pct)*1%),#eef2f7 0);position:relative;}
      .sim-result-ring::after{content:"";position:absolute;inset:9px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 1px rgba(15,23,42,.04);}
      .sim-result-ring span{position:relative;z-index:1;color:var(--sb-gray-900);font-size:20px;font-weight:700;}
      .sim-result-ring small{font-size:11px;font-weight:600;color:var(--sb-gray-500);margin-left:1px;}
      .sim-result-focus-copy{min-width:0;}
      .sim-result-focus-title{font-size:14px;font-weight:700;color:var(--sb-gray-900);line-height:1.35;}
      .sim-result-focus-meta{margin-top:6px;font-size:13px;font-weight:600;color:var(--sb-gray-700);}
      .sim-result-focus-note{margin-top:4px;font-size:12px;color:var(--sb-gray-500);}
      .sim-result-title{font-size:16px!important;line-height:1.35!important;font-weight:700!important;}
      .sim-result-label,.sim-result-metric-label{font-weight:700!important;}
      .sim-result-section-title{font-size:15px!important;font-weight:700!important;}
      @media(max-width:1180px){.sim-result-overview-grid--compact{grid-template-columns:1fr 1fr;}}
      @media(max-width:760px){.sim-result-overview-grid--compact{grid-template-columns:1fr;}.sim-result-focus-ring-layout{align-items:flex-start;}.sim-result-ring{width:72px;height:72px;flex-basis:72px;}}
    `;
    document.head.appendChild(style);
  }

  function ensureCvRenfortStyles() {
    if (document.getElementById("simCvRenfortStylesV1")) return;
    const style = document.createElement("style");
    style.id = "simCvRenfortStylesV1";
    style.textContent = `
      .sim-cv-upload-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
      .sim-cv-upload-zone{display:flex;align-items:center;gap:12px;min-height:72px;border:1px dashed color-mix(in srgb,var(--accent) 35%,#cbd5e1);border-radius:14px;background:linear-gradient(180deg,#fff 0%,color-mix(in srgb,var(--accent) 4%,#fff) 100%);padding:12px;cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease;}
      .sim-cv-upload-zone:hover{border-color:var(--accent);box-shadow:0 10px 24px color-mix(in srgb,var(--accent) 10%,transparent);transform:translateY(-1px);}
      .sim-cv-upload-icon{width:38px;height:38px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);font-weight:800;font-size:18px;flex:0 0 auto;}
      .sim-cv-upload-copy{min-width:0;display:flex;flex-direction:column;gap:3px;}
      .sim-cv-upload-copy strong{font-size:13px;font-weight:700;color:var(--sb-gray-900);}
      .sim-cv-upload-copy small{font-size:12px;color:var(--sb-gray-500);line-height:1.35;}
      .sim-cv-upload-copy em{font-style:normal;font-size:12px;color:var(--sb-gray-700);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
      .sim-cv-file-input{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;}
      .sim-cv-analysis-actions{display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;}
      .sim-cv-modal-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:12px;align-items:start;}
      .sim-cv-modal-side{border:1px solid var(--sb-gray-200);border-radius:14px;padding:12px;background:#fff;display:flex;flex-direction:column;align-items:center;gap:10px;}
      .sim-cv-modal-summary{border:1px solid var(--sb-gray-200);border-radius:14px;padding:12px;background:#fff;}
      .sim-cv-modal-summary p{margin:0;color:var(--sb-gray-700);font-size:13px;line-height:1.55;}
      .sim-cv-modal-chip-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
      .sim-cv-mini-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px;}
      .sim-cv-mini-card{border:1px solid var(--sb-gray-200);border-radius:12px;padding:10px;background:#fff;}
      .sim-cv-mini-card h4{margin:0 0 6px 0;font-size:12px;font-weight:700;color:var(--sb-gray-900);}
      .sim-cv-mini-card ul{margin:0;padding-left:16px;color:var(--sb-gray-700);font-size:12px;line-height:1.45;}
      @media(max-width:980px){.sim-cv-upload-grid,.sim-cv-modal-grid,.sim-cv-mini-list{grid-template-columns:1fr;}}
    `;
    document.head.appendChild(style);
  }

  function cvUploadZoneHtml(inputId, nameId, title, subtitle, accept) {
    return `
      <div class="sim-cv-upload">
        <input type="file" id="${esc(inputId)}" class="sim-cv-file-input" accept="${esc(accept || ".pdf,.doc,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain")}">
        <label class="sim-cv-upload-zone" for="${esc(inputId)}">
          <span class="sim-cv-upload-icon">+</span>
          <span class="sim-cv-upload-copy">
            <strong>${esc(title)}</strong>
            <small>${esc(subtitle)}</small>
            <em id="${esc(nameId)}">Aucun fichier sélectionné</em>
          </span>
        </label>
      </div>`;
  }

  function bindCvUploadZone(inputId, nameId) {
    const input = byId(inputId);
    const nameEl = byId(nameId);
    if (!input || !nameEl) return;
    const sync = () => {
      const file = input.files?.[0] || null;
      nameEl.textContent = file ? file.name : "Aucun fichier sélectionné";
    };
    input.addEventListener("change", sync);
    sync();
  }

  function cvScoreRing(score100) {
    const s = Math.max(0, Math.min(100, int(score100)));
    const hue = Math.round(12 + (s * 1.08));
    const color = `hsl(${hue} 70% 45%)`;
    const size = 108;
    const stroke = 10;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - s / 100);
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
        <div style="position:relative;width:${size}px;height:${size}px;">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="position:absolute;inset:0;">
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
            <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}" transform="rotate(-90 ${size / 2} ${size / 2})" />
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
            <div style="font-weight:800;font-size:28px;line-height:1;">${s}<span style="font-size:12px;font-weight:700;">%</span></div>
          </div>
        </div>
        <div class="card-sub" style="margin:0;">Adéquation</div>
      </div>`;
  }

  function cvLevelBadge(level) {
    const v = (level || "—").toString().trim() || "—";
    return `<span class="sb-badge">${esc(levelLabel(v) || v)}</span>`;
  }

  function ensureCvAnalysisModal() {
    ensureCvRenfortStyles();
    let modal = byId("modalSimCvAnalysis");
    if (modal) return modal;
    const html = `
      <div class="modal" id="modalSimCvAnalysis" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div class="modal-title-inline">
              <span id="simCvAnalysisModalTitle" style="font-weight:600;">Analyse CV</span>
              <span class="sb-badge sb-badge--candidat" id="simCvAnalysisModalBadge">Candidat CV</span>
              <span class="sb-badge sb-badge-ref-poste-code" id="simCvAnalysisPosteCode" style="display:none;"></span>
              <span id="simCvAnalysisPosteText" style="font-weight:600;"></span>
            </div>
            <button type="button" class="modal-x" id="btnCloseSimCvAnalysisModal" aria-label="Fermer">×</button>
          </div>
          <div class="modal-body" id="simCvAnalysisModalBody"></div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimCvAnalysisModalClose">Fermer</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalSimCvAnalysis");
    byId("btnCloseSimCvAnalysisModal")?.addEventListener("click", closeCvAnalysisModal);
    byId("btnSimCvAnalysisModalClose")?.addEventListener("click", closeCvAnalysisModal);
    modal?.addEventListener("click", ev => { if (ev.target === modal) closeCvAnalysisModal(); });
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && byId("modalSimCvAnalysis")?.classList.contains("show")) closeCvAnalysisModal();
    });
    return modal;
  }

  function closeCvAnalysisModal() {
    const modal = byId("modalSimCvAnalysis");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function openCvAnalysisModal(data) {
    const modal = ensureCvAnalysisModal();
    if (!modal || !data) return;
    const poste = posteById(data.id_poste) || {};
    const code = posteCode(poste);
    const matching = Array.isArray(data.matching_poste) ? data.matching_poste : [];
    const needs = Array.isArray(data.besoins_generes) ? data.besoins_generes : [];
    const fav = Array.isArray(data.points_favorables) ? data.points_favorables : [];
    const vigil = Array.isArray(data.points_vigilance) ? data.points_vigilance : [];
    const questions = Array.isArray(data.questions_entretien) ? data.questions_entretien : [];

    const title = byId("simCvAnalysisModalTitle");
    const codeEl = byId("simCvAnalysisPosteCode");
    const textEl = byId("simCvAnalysisPosteText");
    const body = byId("simCvAnalysisModalBody");
    if (title) title.textContent = data.nom_candidat || "Candidat CV";
    if (codeEl) {
      codeEl.textContent = code || "";
      codeEl.style.display = code ? "inline-flex" : "none";
    }
    if (textEl) textEl.textContent = posteTitle(poste);

    if (body) {
      body.innerHTML = `
        <div class="sim-cv-modal-grid">
          <div class="sim-cv-modal-side">
            ${cvScoreRing(data.adequation_pct || 0)}
            <div style="text-align:center;">
              <div class="card-sub" style="margin:0;">Besoins détectés</div>
              <div style="font-size:22px;font-weight:800;color:var(--sb-gray-900);">${esc(needs.length)}</div>
            </div>
          </div>
          <div class="sim-cv-modal-summary">
            <div class="card-title" style="font-size:15px;font-weight:700;margin:0 0 6px 0;">Lecture recruteur</div>
            <p>${esc(data.lecture_recruteur || data.resume_profil || "Analyse disponible.")}</p>
            <div class="sim-cv-modal-chip-row">
              ${matching.slice(0, 6).map(x => `<span class="sb-badge">${esc(x.code || x.intitule || "Compétence")}</span>`).join("")}
            </div>
          </div>
        </div>

        <div class="table-wrap" style="margin-top:12px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>Compétence attendue</th>
                <th style="width:110px;">Requis</th>
                <th style="width:120px;">Estimé CV</th>
                <th style="width:110px;" class="col-center">Couverture</th>
                <th>Preuve / écart</th>
              </tr>
            </thead>
            <tbody>
              ${matching.length ? matching.map(row => `
                <tr>
                  <td>
                    <strong>${esc(row.code || "—")}</strong>
                    <div class="card-sub" style="margin:2px 0 0 0;">${esc(row.intitule || "Compétence")}</div>
                  </td>
                  <td>${cvLevelBadge(row.niveau_requis)}</td>
                  <td>${row.niveau_estime ? cvLevelBadge(row.niveau_estime) : `<span class="sb-badge sb-badge--warning">Non démontré</span>`}</td>
                  <td class="col-center"><span class="sb-badge ${int(row.couverture_pct) >= 75 ? "sb-badge--success" : int(row.couverture_pct) >= 50 ? "" : "sb-badge--warning"}">${esc(int(row.couverture_pct))}%</span></td>
                  <td>
                    <div>${esc(row.preuve_cv || "Preuve non explicite dans le CV.")}</div>
                    ${row.ecart ? `<div class="card-sub" style="margin:3px 0 0 0;">Écart : ${esc(row.ecart)}</div>` : ""}
                  </td>
                </tr>`).join("") : `<tr><td colspan="5" class="col-center" style="color:#6b7280;">Aucune correspondance détaillée retournée.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="sim-cv-mini-list">
          <div class="sim-cv-mini-card">
            <h4>Points favorables</h4>
            <ul>${fav.length ? fav.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>À confirmer en entretien.</li>`}</ul>
          </div>
          <div class="sim-cv-mini-card">
            <h4>Points de vigilance</h4>
            <ul>${vigil.length ? vigil.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>Aucun point majeur remonté.</li>`}</ul>
          </div>
          <div class="sim-cv-mini-card">
            <h4>Questions d’entretien</h4>
            <ul>${questions.length ? questions.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>Préciser les expériences liées au poste.</li>`}</ul>
          </div>
        </div>
      `;
    }

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    const mb = modal.querySelector(".modal-body");
    if (mb) mb.scrollTop = 0;
  }

  function fillSelect(el, list, valueKey, labelFn, placeholder) {
    if (!el) return;
    const previous = el.value;
    el.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder || "Sélectionner…";
    el.appendChild(opt0);
    (Array.isArray(list) ? list : []).forEach(item => {
      const opt = document.createElement("option");
      opt.value = item[valueKey] || "";
      opt.textContent = labelFn(item);
      el.appendChild(opt);
    });
    if (previous && Array.from(el.options).some(o => o.value === previous)) el.value = previous;
  }

  async function populateServices() {
    if (!window.portal?.serviceFilter?.populateSelect) return;
    await window.portal.serviceFilter.populateSelect({
      portal: _portal,
      contactId: _portal.contactId,
      selectId: "simServiceSelect",
      storageKey: STORE_SERVICE,
      includeAll: true,
      includeNonLie: true,
      labelAll: "Tous les services",
      labelNonLie: "Non liés",
    });
  }

  async function loadOptions(force, opts = {}) {
    if (_optionsLoaded && !force) return _options;
    if (!_portal || !_portal.contactId) return _options;
    const silent = !!opts.silent;
    if (!silent) setStatus("Chargement des données RH…");
    const data = await _portal.apiJson(apiUrl(`/skills/simulations/options/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin(),
    }));
    _options = {
      postes: Array.isArray(data?.postes) ? data.postes : [],
      effectifs: Array.isArray(data?.effectifs) ? data.effectifs : [],
      competences: Array.isArray(data?.competences) ? data.competences : [],
      requirements: Array.isArray(data?.requirements) ? data.requirements : [],
      recommendations: data?.recommendations || {},
      scope: data?.scope || null,
    };
    _optionsLoaded = true;
    if (!silent) setStatus("");
    if (!_selectedPosteId && _options.postes.length) _selectedPosteId = _options.postes[0].id_poste || "";
    renderAll();
    return _options;
  }

  function consumeContext() {
    const ctx = readJson(STORE_CONTEXT, null);
    if (!ctx || typeof ctx !== "object") return null;
    try { localStorage.removeItem(STORE_CONTEXT); } catch (_) {}
    return ctx;
  }

  function applyContextFilters(ctx) {
    if (!ctx) return;

    if (ctx.criticite_min !== null && ctx.criticite_min !== undefined && ctx.criticite_min !== "") {
      setCriticiteMin(ctx.criticite_min);
    }

    const sel = byId("simServiceSelect");
    if (!sel) return;

    const raw = (ctx.service_raw || "").toString().trim();
    const queryId = (ctx.id_service || "").toString().trim();
    const options = Array.from(sel.options || []);

    if (raw && options.some(o => (o.value || "").toString().trim() === raw)) {
      sel.value = raw;
      return;
    }

    if (queryId && window.portal?.serviceFilter?.toQueryId) {
      const match = options.find(o => window.portal.serviceFilter.toQueryId(o.value || "") === queryId);
      if (match) {
        sel.value = match.value;
        return;
      }
    }
  }

  function applyContext(ctx) {
    if (!ctx) return;
    _context = ctx;
    const posteId = ctx.poste_id || ctx.id_poste || ctx.id_poste_cible || "";
    if (posteId) _selectedPosteId = posteId;
    renderAll();
    setStatus("");
  }

  function recommendationsForPoste(posteId) {
    return ((_options.recommendations || {}).candidats_par_poste || {})[posteId] || [];
  }

  function requirementsForPoste(posteId) {
    const seen = new Set();
    return (_options.requirements || []).filter(r => String(r.id_poste || "") === String(posteId || "")).filter(r => {
      const k = String(r.id_comp || "");
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function titulairesForPoste(posteId) {
    const pid = String(posteId || "").trim();
    return (_options.effectifs || []).filter(e => String(e.id_poste_actuel || "").trim() === pid);
  }

  function relaisCandidatesForPoste(posteId) {
    const pid = String(posteId || "").trim();
    const recs = recommendationsForPoste(pid);
    const byId = new Map();
    recs.forEach(r => {
      const eid = String(r.id_effectif || "").trim();
      if (!eid) return;
      byId.set(eid, {
        ...r,
        id_effectif: eid,
        nom_complet: r.nom_complet || "Collaborateur",
        intitule_poste: r.poste_actuel || "",
        nom_service: r.nom_service || "",
        _score: Number(r.score_pct || 0),
      });
    });
    (_options.effectifs || []).forEach(e => {
      const eid = String(e.id_effectif || "").trim();
      if (!eid || String(e.id_poste_actuel || "").trim() === pid || byId.has(eid)) return;
      byId.set(eid, { ...e, _score: 0 });
    });
    return Array.from(byId.values()).sort((a, b) => Number(b._score || 0) - Number(a._score || 0) || String(a.nom_complet || "").localeCompare(String(b.nom_complet || "")));
  }

  function relaisCandidateLabel(e) {
    const score = Number(e._score || e.score_pct || 0);
    const poste = (e.intitule_poste || e.poste_actuel || "").trim();
    return `${e.nom_complet || "Collaborateur"}${score ? " · " + score + "%" : ""}${poste ? " — " + poste : ""}`;
  }

  function renderPostePicker() {
    const title = byId("simFocusPosteTitle");
    if (title) title.textContent = _context ? "Poste de départ - Issu de l’analyse" : "Poste de départ";

    const sel = byId("simFocusPosteSelect");
    fillSelect(sel, _options.postes || [], "id_poste", posteLabel, "Choisir un poste…");
    if (sel && _selectedPosteId && Array.from(sel.options).some(o => o.value === _selectedPosteId)) sel.value = _selectedPosteId;

    const p = posteById(_selectedPosteId);
    const meta = byId("simFocusPosteMeta");
    if (meta) {
      const code = posteCode(p);
      meta.innerHTML = p ? `
        <div class="sim-lego-focus-title">
          ${code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : ""}
          <span class="sim-lego-focus-label">${esc(p.intitule_poste || "Poste")}</span>
        </div>
        <div class="sim-workshop-meta-row">
          <span>${esc(p.nom_service || "Tous les services")}</span>
          <span>Cible titulaires : ${esc(p.nb_titulaires_cible ?? "—")}</span>
          <span>${esc(p.cotation_label || "Cotation à compléter")}</span>
        </div>
      ` : `<div class="sim-empty-state">Choisissez le poste à travailler.</div>`;
    }
  }

  function renderRecommendations() {
    const card = byId("simRecommendationsCard");
    const root = byId("simRecommendations");
    if (!root) return;
    if (_selectedBrick !== "mobilite_effectif") {
      if (card) card.style.display = "none";
      root.innerHTML = "";
      return;
    }
    if (card) card.style.display = "";
    const rows = recommendationsForPoste(_selectedPosteId).slice(0, 6);
    if (!rows.length) {
      root.innerHTML = `<div class="sim-empty-state">Aucun profil proche identifié pour ce poste. Vous pouvez tout de même tester un renfort ou une mobilité manuelle.</div>`;
      return;
    }
    root.innerHTML = rows.map((r, idx) => `
      <div class="sim-lego-person-card ${idx === 0 ? "is-best" : ""}">
        <div class="sim-lego-person-main">
          <div class="sim-lego-person-title">${esc(r.nom_complet || "Collaborateur")}</div>
          <div class="card-sub" style="margin-top:2px;">${esc(r.poste_actuel || "Poste actuel non renseigné")} · ${esc(r.nom_service || "")}</div>
          <div class="sim-lego-person-gaps">
            ${(r.competences_a_renforcer || []).slice(0, 3).map(c => `<span>${esc(c.code || c.intitule || "Compétence")}</span>`).join("")}
          </div>
        </div>
        <div class="sim-lego-person-score">
          <span class="sb-badge ${idx === 0 ? "sb-badge--success" : ""}">${esc(r.score_pct || 0)}%</span>
          <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-sim-add-move="${esc(r.id_effectif)}">Tester mobilité</button>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-prepare-training="${esc(r.id_effectif)}">Projeter niveau</button>
        </div>
      </div>
    `).join("");

    root.querySelectorAll("[data-sim-add-move]").forEach(btn => btn.addEventListener("click", () => {
      const eid = btn.getAttribute("data-sim-add-move") || "";
      const eff = effectifById(eid);
      addBrick({
        type: "mobilite_effectif",
        id_effectif: eid,
        id_poste: _selectedPosteId,
        id_poste_cible: _selectedPosteId,
        temporalite: "immediate",
        libelle: `Déplacer ${eff?.nom_complet || "un collaborateur"} vers ${posteLabel(posteById(_selectedPosteId))}`,
      });
    }));

    root.querySelectorAll("[data-sim-prepare-training]").forEach(btn => btn.addEventListener("click", () => {
      const eid = btn.getAttribute("data-sim-prepare-training") || "";
      const rec = recommendationsForPoste(_selectedPosteId).find(x => String(x.id_effectif || "") === eid) || {};
      const gap = (rec.competences_a_renforcer || [])[0] || requirementsForPoste(_selectedPosteId)[0];
      if (!gap) return setStatus("Aucune compétence à renforcer identifiée pour cette personne.", "error");
      addBrick({
        type: "montee_competence",
        id_effectif: eid,
        id_poste: _selectedPosteId,
        id_comp: gap.id_comp,
        niveau_simule: gap.niveau_requis || "C",
        temporalite: "development",
        libelle: `Projeter ${effectifById(eid)?.nom_complet || "un collaborateur"} au niveau attendu sur ${gap.code || gap.intitule || "une compétence"}`,
      });
    }));
  }

  function renderPalette() {
    const root = byId("simBrickPalette");
    if (!root) return;
    const main = Object.entries(BRICKS).filter(([, b]) => b.group === "immediate");
    const projected = Object.entries(BRICKS).filter(([, b]) => b.group === "projected");
    function buttonHtml(key, b) {
      return `
        <button type="button" class="sim-lego-brick ${_selectedBrick === key ? "is-active" : ""} ${b.group === "projected" ? "is-secondary" : ""}" data-sim-brick="${esc(key)}">
          <span class="sim-lego-brick-icon">${esc(b.icon || "•")}</span>
          <span><strong>${esc(b.title)}</strong><small>${esc(b.short)}</small></span>
        </button>`;
    }
    root.innerHTML = `
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Organisation immédiate</div>
        <div class="sim-lego-brick-grid">${main.map(([key, b]) => buttonHtml(key, b)).join("")}</div>
      </div>
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Projection après montée en compétence</div>
        <div class="sim-lego-brick-grid">${projected.map(([key, b]) => buttonHtml(key, b)).join("")}</div>
      </div>
    `;
    root.querySelectorAll("[data-sim-brick]").forEach(btn => btn.addEventListener("click", () => {
      _selectedBrick = btn.getAttribute("data-sim-brick") || "mobilite_effectif";
      renderBuilderFields();
      renderRecommendations();
      renderPalette();
    }));
  }

  function renderBuilderFields() {
    const root = byId("simBrickEditor");
    if (!root) return;
    const p = posteById(_selectedPosteId);
    const posteOptions = _options.postes || [];
    const effectifs = _options.effectifs || [];
    const reqs = requirementsForPoste(_selectedPosteId);
    const brick = BRICKS[_selectedBrick] || BRICKS.mobilite_effectif;

    const intro = `<div class="sim-brick-editor-title"><span>${esc(brick.icon || "•")}</span><strong>${esc(brick.title)}</strong></div>`;

    if (_selectedBrick === "renfort_poste") {
      const relais = relaisCandidatesForPoste(_selectedPosteId);
      _lastCvAnalysis = null;
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Mode de renfort</div><select id="simBrickRenfortMode" class="sb-select"><option value="relais_interne">Relais interne</option><option value="recrutement_virtuel">Recrutement · profil virtuel</option><option value="analyse_cv">Recrutement · analyse CV</option></select></div>
          <div class="info-item"><div class="label">Poste à renforcer</div><select id="simBrickPoste" class="sb-select"></select></div>
        </div>

        <div id="simRenfortRelaisPanel" class="sim-renfort-mode-panel">
          <div class="sim-form-grid">
            <div class="info-item sb-span-2"><div class="label">Relais interne proposé</div><select id="simBrickEffectif" class="sb-select"></select></div>
          </div>
          <div class="card-sub sim2-muted-top">Les personnes sont proposées dans l’ordre des meilleurs profils disponibles pour ce poste. Le moteur projette le relais sur les compétences dépendantes.</div>
        </div>

        <div id="simRenfortVirtuelPanel" class="sim-renfort-mode-panel" style="display:none;">
          <div class="card-sub sim2-muted-top">Le moteur ajoute un profil virtuel couvrant les compétences attendues du poste. Utile pour comparer avec un relais interne.</div>
        </div>

        <div id="simRenfortCvPanel" class="sim-renfort-mode-panel" style="display:none;">
          <div class="sim-cv-upload-grid">
            ${cvUploadZoneHtml("simBrickCvFile", "simBrickCvFileName", "Ajouter le CV candidat", "PDF, DOCX ou TXT · obligatoire", ".pdf,.doc,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain")}
            ${cvUploadZoneHtml("simBrickMotivationFile", "simBrickMotivationFileName", "Ajouter une lettre de motivation", "PDF, DOCX ou TXT · optionnel", ".pdf,.doc,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain")}
          </div>
          <div class="sim-form-grid" style="margin-top:10px;">
            <div class="info-item sb-span-2"><div class="label">Notes complémentaires / contexte candidat</div><textarea id="simBrickCvProjet" class="sb-input" rows="3" placeholder="Optionnel : disponibilité, contexte RH, éléments transmis hors CV et lettre..."></textarea></div>
          </div>
          <div class="sb-actions" style="margin-top:10px;">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimAnalyseCv">Analyser le CV</button>
          </div>
          <div id="simCvAnalysisPreview" class="sim-empty-state" style="margin-top:10px;">Analysez le CV avant d’ajouter le candidat au scénario.</div>
        </div>
      `;
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un poste…");
      if (byId("simBrickPoste")) byId("simBrickPoste").value = _selectedPosteId || "";
      fillSelect(byId("simBrickEffectif"), relais, "id_effectif", relaisCandidateLabel, relais.length ? "Choisir un relais interne…" : "Aucun relais proposé…");

      const modeSel = byId("simBrickRenfortMode");
      const syncRenfortMode = () => {
        const mode = modeSel?.value || "relais_interne";
        const panels = {
          relais_interne: byId("simRenfortRelaisPanel"),
          recrutement_virtuel: byId("simRenfortVirtuelPanel"),
          analyse_cv: byId("simRenfortCvPanel"),
        };
        Object.entries(panels).forEach(([key, el]) => { if (el) el.style.display = key === mode ? "" : "none"; });
      };
      modeSel?.addEventListener("change", syncRenfortMode);
      byId("simBrickPoste")?.addEventListener("change", () => {
        const pid = byId("simBrickPoste")?.value || _selectedPosteId || "";
        fillSelect(byId("simBrickEffectif"), relaisCandidatesForPoste(pid), "id_effectif", relaisCandidateLabel, "Choisir un relais interne…");
        _lastCvAnalysis = null;
        const preview = byId("simCvAnalysisPreview");
        if (preview) preview.innerHTML = "Analysez le CV avant d’ajouter le candidat au scénario.";
      });
      ensureCvRenfortStyles();
      bindCvUploadZone("simBrickCvFile", "simBrickCvFileName");
      bindCvUploadZone("simBrickMotivationFile", "simBrickMotivationFileName");
      byId("btnSimAnalyseCv")?.addEventListener("click", analyseCvForRenfort);
      syncRenfortMode();
      return;
    }

    if (_selectedBrick === "depart_effectif") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Personne retirée du scénario</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Nature</div><select id="simBrickDepartType" class="sb-select"><option value="depart_effectif">Départ / sortie</option><option value="absence_effectif">Absence longue</option></select></div>
          <div class="info-item" id="simBrickAbsenceDurationWrap" style="display:none;"><div class="label">Durée simulée</div><select id="simBrickAbsenceDuration" class="sb-select"><option value="30">1 mois</option><option value="60">2 mois</option><option value="90" selected>3 mois</option><option value="180">6 mois</option><option value="365">12 mois</option></select></div>
        </div>
        <div class="card-sub sim2-muted-top" id="simBrickDepartHint">Pour une absence longue, Novoskill mesure l’état du périmètre pendant la période simulée.</div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
      const typeSel = byId("simBrickDepartType");
      const toggleAbsenceDuration = () => {
        const isAbsence = (typeSel?.value || "") === "absence_effectif";
        const wrap = byId("simBrickAbsenceDurationWrap");
        if (wrap) wrap.style.display = isAbsence ? "" : "none";
      };
      typeSel?.addEventListener("change", toggleAbsenceDuration);
      toggleAbsenceDuration();
      return;
    }

    if (_selectedBrick === "transfert_charge") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Poste source</div><select id="simBrickPosteSource" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Poste cible</div><select id="simBrickPoste" class="sb-select"></select></div>
          <div class="info-item sb-span-2"><div class="label">Charge / compétence transférée</div><select id="simBrickCompetence" class="sb-select"></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique allège le poste source et ajoute cette exigence au poste cible.</div>
      `;
      fillSelect(byId("simBrickPosteSource"), posteOptions, "id_poste", posteLabel, "Choisir le poste source…");
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir le poste cible…");
      if (byId("simBrickPosteSource")) byId("simBrickPosteSource").value = _selectedPosteId || "";
      const sourceSel = byId("simBrickPosteSource");
      const fillSourceReqs = () => {
        const src = sourceSel?.value || _selectedPosteId || "";
        fillSelect(byId("simBrickCompetence"), requirementsForPoste(src), "id_comp", compLabel, "Choisir l’activité / compétence…");
      };
      sourceSel?.addEventListener("change", fillSourceReqs);
      fillSourceReqs();
      return;
    }

    if (_selectedBrick === "renforcer_titulaire") {
      const titulaires = titulairesForPoste(_selectedPosteId);
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Titulaire concerné</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Poste</div><input type="text" class="sb-input" value="${esc(posteTitle(p))}" disabled></div>
          <div class="info-item"><div class="label">Niveau visé</div><input type="text" class="sb-input" value="Niveau attendu du poste" disabled></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique projette la mise à niveau du titulaire sur les compétences du poste où le niveau attendu n’est pas atteint.</div>
      `;
      fillSelect(byId("simBrickEffectif"), titulaires.length ? titulaires : effectifs, "id_effectif", effectifLabel, titulaires.length ? "Choisir un titulaire…" : "Choisir une personne…");
      return;
    }

    if (_selectedBrick === "montee_competence") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Personne concernée</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Compétence</div><select id="simBrickCompetence" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Niveau visé</div><select id="simBrickNiveau" class="sb-select"><option value="A">Débutant</option><option value="B">Intermédiaire</option><option value="C" selected>Avancé</option><option value="D">Expert</option></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique projette l’état si le niveau cible est atteint. Le besoin réel se traite ensuite dans Besoins & formations.</div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
      fillSelect(byId("simBrickCompetence"), reqs.length ? reqs : (_options.competences || []), "id_comp", compLabel, "Choisir une compétence…");
      return;
    }

    root.innerHTML = `
      ${intro}
      <div class="sim-form-grid">
        <div class="info-item"><div class="label">Personne déplacée</div><select id="simBrickEffectif" class="sb-select"></select></div>
        <div class="info-item"><div class="label">Poste cible</div><select id="simBrickPoste" class="sb-select"></select></div>
      </div>
      <div class="card-sub sim2-muted-top">Le poste d’origine est automatiquement surveillé pour détecter l’effet domino.</div>
    `;
    fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personne…");
    fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un poste…");
    if (byId("simBrickPoste")) byId("simBrickPoste").value = (p?.id_poste || _selectedPosteId || "");
  }


  async function analyseCvForRenfort() {
    const posteId = byId("simBrickPoste")?.value || _selectedPosteId || "";
    const file = byId("simBrickCvFile")?.files?.[0] || null;
    const motivationFile = byId("simBrickMotivationFile")?.files?.[0] || null;
    const preview = byId("simCvAnalysisPreview");
    if (!posteId) return setStatus("Choisissez le poste à renforcer avant l’analyse CV.", "error");
    if (!file) return setStatus("Ajoutez le CV candidat avant de lancer l’analyse.", "error");

    const fd = new FormData();
    fd.append("id_poste", posteId);
    fd.append("projet_professionnel", byId("simBrickCvProjet")?.value || "");
    fd.append("cv_file", file);
    if (motivationFile) fd.append("motivation_file", motivationFile);

    if (preview) preview.innerHTML = "Analyse IA du CV en cours…";
    setStatus("Analyse IA du CV en cours…");
    try {
      const data = await _portal.apiJson(apiUrl(`/skills/simulations/analyse-cv/${encodeURIComponent(_portal.contactId)}`, {
        id_service: getServiceId(),
        criticite_min: getCriticiteMin(),
      }), {
        method: "POST",
        body: fd,
      });
      _lastCvAnalysis = data || null;
      const needs = Array.isArray(data?.besoins_generes) ? data.besoins_generes : [];
      if (preview) {
        preview.innerHTML = `
          <div class="sim-lego-person-card is-best">
            <div class="sim-lego-person-main">
              <div class="sim-lego-person-title">${esc(data?.nom_candidat || "Candidat CV")}</div>
              <div class="card-sub" style="margin-top:2px;">Adéquation estimée : ${esc(data?.adequation_pct || 0)}% · ${esc(needs.length)} besoin${needs.length > 1 ? "s" : ""} détecté${needs.length > 1 ? "s" : ""}</div>
              <div class="sim-lego-person-gaps">
                ${needs.slice(0, 4).map(n => `<span>${esc(n.code || n.intitule || "Compétence")}</span>`).join("")}
              </div>
            </div>
            <div class="sim-lego-person-score">
              <span class="sb-badge sb-badge--success">CV analysé</span>
              <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-cv-view-analysis>Voir l’analyse</button>
            </div>
          </div>
          ${(data?.points_vigilance || []).length ? `<div class="card-sub sim2-muted-top">À vérifier : ${esc((data.points_vigilance || []).slice(0, 2).join(" · "))}</div>` : ""}
          <div class="sim-cv-analysis-actions">
            <button type="button" class="sb-btn sb-btn--soft" data-sim-cv-view-analysis>Voir l’analyse complète</button>
          </div>
        `;
        preview.querySelectorAll("[data-sim-cv-view-analysis]").forEach(btn => btn.addEventListener("click", () => openCvAnalysisModal(_lastCvAnalysis)));
      }
      setStatus("Analyse CV prête à ajouter au scénario.");
    } catch (e) {
      _lastCvAnalysis = null;
      if (preview) preview.innerHTML = `<div class="sim-empty-state">Analyse CV impossible : ${esc(errMsg(e))}</div>`;
      setStatus(errMsg(e), "error");
    }
  }

  function addBrick(payload) {
    const item = { id: `brick_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...payload };
    _scenario.push(item);
    renderScenario();
    renderScenarioPreview();
    setStatus("Brique ajoutée au scénario.");
  }

  function addBrickFromEditor() {
    const posteId = byId("simBrickPoste")?.value || _selectedPosteId || "";
    const sourcePosteId = byId("simBrickPosteSource")?.value || _selectedPosteId || "";
    const effId = byId("simBrickEffectif")?.value || "";
    const compId = byId("simBrickCompetence")?.value || "";
    const niveau = byId("simBrickNiveau")?.value || "C";
    const absenceDuration = byId("simBrickAbsenceDuration")?.value || "90";
    const absenceDurationLabel = byId("simBrickAbsenceDuration")?.selectedOptions?.[0]?.textContent || "3 mois";

    if (_selectedBrick === "renfort_poste") {
      const mode = byId("simBrickRenfortMode")?.value || "relais_interne";
      if (!posteId) return setStatus("Choisissez un poste à renforcer.", "error");

      if (mode === "relais_interne") {
        if (!effId) return setStatus("Choisissez le relais interne à tester.", "error");
        return addBrick({
          type: "relais_interne",
          id_effectif: effId,
          id_poste: posteId,
          id_poste_cible: posteId,
          temporalite: "development",
          libelle: `Créer un relais interne avec ${effectifById(effId)?.nom_complet || "un collaborateur"} sur ${posteLabel(posteById(posteId))}`
        });
      }

      if (mode === "analyse_cv") {
        if (!_lastCvAnalysis || String(_lastCvAnalysis.id_poste || "") !== String(posteId || "")) {
          return setStatus("Analysez le CV avant d’ajouter ce renfort au scénario.", "error");
        }
        return addBrick({
          type: "recrutement_cv",
          id_poste: posteId,
          id_poste_cible: posteId,
          id_analyse_cv: _lastCvAnalysis.id_analyse_cv || null,
          candidat_nom: _lastCvAnalysis.nom_candidat || "Candidat CV",
          competences_cv: _lastCvAnalysis.competences_cv || [],
          analyse_cv_json: _lastCvAnalysis,
          temporalite: "immediate",
          libelle: `Tester le recrutement de ${_lastCvAnalysis.nom_candidat || "candidat CV"} sur ${posteLabel(posteById(posteId))}`
        });
      }

      return addBrick({ type: "recrutement_virtuel", id_poste: posteId, id_poste_cible: posteId, temporalite: "immediate", libelle: `Ajouter un profil virtuel sur ${posteLabel(posteById(posteId))}` });
    }

    if (_selectedBrick === "depart_effectif") {
      if (!effId) return setStatus("Choisissez la personne à retirer du scénario.", "error");
      const t = byId("simBrickDepartType")?.value || "depart_effectif";
      return addBrick({
        type: t,
        id_effectif: effId,
        temporalite: "immediate",
        duree_jours: t === "absence_effectif" ? absenceDuration : null,
        duree_libelle: t === "absence_effectif" ? absenceDurationLabel : null,
        libelle: `${t === "absence_effectif" ? "Absence longue" : "Départ"} de ${effectifById(effId)?.nom_complet || "collaborateur"}${t === "absence_effectif" ? ` · ${absenceDurationLabel}` : ""}`
      });
    }

    if (_selectedBrick === "transfert_charge") {
      if (!sourcePosteId || !posteId || !compId) return setStatus("Choisissez le poste source, le poste cible et la charge transférée.", "error");
      if (sourcePosteId === posteId) return setStatus("Le poste source et le poste cible doivent être différents.", "error");
      return addBrick({ type: "transfert_charge", id_poste: sourcePosteId, id_poste_cible: posteId, id_comp: compId, temporalite: "immediate", libelle: `Transférer ${compLabel(compById(compId))} de ${posteLabel(posteById(sourcePosteId))} vers ${posteLabel(posteById(posteId))}` });
    }

    if (_selectedBrick === "renforcer_titulaire") {
      if (!effId) return setStatus("Choisissez le titulaire à renforcer.", "error");
      return addBrick({
        type: "renforcer_titulaire",
        id_effectif: effId,
        id_poste: _selectedPosteId,
        id_poste_cible: _selectedPosteId,
        temporalite: "development",
        libelle: `Renforcer ${effectifById(effId)?.nom_complet || "titulaire"} sur ${posteLabel(posteById(_selectedPosteId))}`
      });
    }

    if (_selectedBrick === "montee_competence") {
      if (!effId || !compId) return setStatus("Choisissez une personne et une compétence.", "error");
      return addBrick({ type: "montee_competence", id_effectif: effId, id_poste: _selectedPosteId, id_comp: compId, niveau_simule: niveau, temporalite: "development", libelle: `Projeter ${effectifById(effId)?.nom_complet || "collaborateur"} au niveau ${niveau} sur ${compLabel(compById(compId))}` });
    }

    if (!effId || !posteId) return setStatus("Choisissez une personne et un poste cible.", "error");
    return addBrick({ type: "mobilite_effectif", id_effectif: effId, id_poste: posteId, id_poste_cible: posteId, temporalite: "immediate", libelle: `Déplacer ${effectifById(effId)?.nom_complet || "collaborateur"} vers ${posteLabel(posteById(posteId))}` });
  }

  function renderScenario() {
    const root = byId("simScenarioBricks");
    if (!root) return;
    if (!_scenario.length) {
      root.innerHTML = `<div class="sim-empty-state">Votre scénario est vide. Ajoutez une brique à gauche.</div>`;
      return;
    }
    root.innerHTML = _scenario.map((b, idx) => {
      const key = (b.type === "recrutement_virtuel" || b.type === "recrutement_cv" || b.type === "relais_interne") ? "renfort_poste" : (b.type === "absence_effectif" || b.type === "depart_effectif" ? "depart_effectif" : b.type);
      const meta = BRICKS[key] || BRICKS.mobilite_effectif;
      return `
        <div class="sim-lego-scenario-brick ${b.temporalite === "development" ? "is-dev" : ""}">
          <div class="sim-lego-scenario-icon">${esc(meta.icon || "•")}</div>
          <div class="sim-lego-scenario-copy">
            <div class="sim-lego-brick-index">Brique ${idx + 1} · ${esc(brickKind(b))}</div>
            <div class="sim-lego-brick-label">${esc(brickSummary(b))}</div>
          </div>
          <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-remove-brick="${idx}">Retirer</button>
        </div>`;
    }).join("");
    root.querySelectorAll("[data-sim-remove-brick]").forEach(btn => btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-sim-remove-brick") || -1);
      if (idx >= 0) _scenario.splice(idx, 1);
      renderScenario();
      renderScenarioPreview();
    }));
  }

  function renderScenarioPreview() {
    const root = byId("simScenarioPreview");
    if (!root) return;
    if (!_scenario.length) {
      root.innerHTML = `
        <div class="sim-workshop-scenario-empty">
          <strong>${esc(posteTitle(posteById(_selectedPosteId)))}</strong>
          <span>Ajoutez au moins une brique pour analyser l’impact.</span>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="sim-lego-preview-title">${esc(posteTitle(posteById(_selectedPosteId)))}</div>
    `;
  }

  function buildPayload() {
    return {
      titre: `Scénario organisation · ${posteLabel(posteById(_selectedPosteId))}`,
      objectif: "Tester une organisation RH composée de plusieurs briques.",
      id_poste_focus: _selectedPosteId || null,
      hypotheses: _scenario.map(b => ({
        type: b.type,
        id_effectif: b.id_effectif || null,
        id_poste: b.id_poste || b.id_poste_cible || null,
        id_poste_cible: b.id_poste_cible || b.id_poste || null,
        id_comp: b.id_comp || null,
        niveau_simule: b.niveau_simule || null,
        libelle: b.libelle || null,
        temporalite: b.temporalite || null,
        id_analyse_cv: b.id_analyse_cv || null,
        candidat_nom: b.candidat_nom || null,
        competences_cv: b.competences_cv || null,
        analyse_cv_json: b.analyse_cv_json || null,
      })),
    };
  }

  async function evaluateScenario() {
    await loadOptions(false);
    if (!_scenario.length) return setStatus("Ajoutez au moins une brique au scénario.", "error");
    setStatus("Calcul des impacts du scénario…");
    const payload = buildPayload();
    const result = await _portal.apiJson(apiUrl(`/skills/simulations/evaluer/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin(),
    }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    _lastResult = result;
    setStatus("");
    renderResult(result);
    switchTab("result");
  }

  function metricCard(label, before, after, inverse, opts) {
    const b = int(before);
    const a = int(after);
    const delta = a - b;
    const suffix = opts?.suffix || "pts";
    const deltaLabel = typeof opts?.deltaLabel === "function"
      ? opts.deltaLabel(delta)
      : `${delta > 0 ? "+" : ""}${delta} ${suffix}`;
    return `
      <div class="sim-result-metric-card ${trendClass(delta, inverse)}">
        <div class="sim-result-metric-label">${esc(label)}</div>
        <div class="sim-result-metric-values">${esc(b)} <span>→</span> ${esc(a)}</div>
        <div class="sim-result-compare-bars">
          <div class="sim-result-compare-line">
            <span>Avant</span>
            <div class="sim-result-compare-track"><div class="sim-result-compare-fill is-before" style="width:${Math.max(0, Math.min(100, b))}%"></div></div>
          </div>
          <div class="sim-result-compare-line">
            <span>Après</span>
            <div class="sim-result-compare-track"><div class="sim-result-compare-fill ${trendClass(delta, inverse)}" style="width:${Math.max(0, Math.min(100, a))}%"></div></div>
          </div>
        </div>
        <div class="sim-result-metric-delta">${esc(deltaLabel)}</div>
      </div>`;
  }

  function gaugeTone(score) {
    if (score >= 70) return "is-good";
    if (score <= 40) return "is-bad";
    return "is-watch";
  }

  function gaugeLabel(score) {
    if (score >= 70) return "Favorable";
    if (score <= 40) return "À sécuriser";
    return "À étudier";
  }

  function focusFragilityRing(result, current, finalSummary) {
    const focus = result?.poste_focus || null;
    const hasFocus = !!focus;
    const before = hasFocus ? int(focus.fragilite_avant) : int(current.fragilite_moyenne);
    const after = hasFocus ? int(focus.fragilite_projete) : int(finalSummary.fragilite_moyenne);
    const delta = after - before;
    const tone = trendClass(delta, true);
    const pct = Math.max(0, Math.min(100, after));
    const title = hasFocus ? "Poste étudié" : "Périmètre analysé";
    const name = hasFocus ? (focus.intitule_poste || "Poste") : "Fragilité moyenne";
    const code = hasFocus ? (focus.codif_client || focus.codif_poste || "") : "";
    return `
      <div class="sim-result-focus-ring-card ${tone}">
        <div class="sim-result-metric-label">${esc(title)}</div>
        <div class="sim-result-focus-ring-layout">
          <div class="sim-result-ring" style="--ring-pct:${pct};">
            <span>${esc(after)}<small>%</small></span>
          </div>
          <div class="sim-result-focus-copy">
            <div class="sim-result-focus-title">${code ? `<span class="sb-badge sb-badge--code">${esc(code)}</span> ` : ""}${esc(name)}</div>
            <div class="sim-result-focus-meta">Fragilité ${esc(before)} → ${esc(after)} · ${esc(deltaText(delta))}</div>
            <div class="sim-result-focus-note">${hasFocus ? "Lecture centrée sur le poste de départ." : "Lecture moyenne du périmètre."}</div>
          </div>
        </div>
      </div>`;
  }

  function compactImpactCard(label, value, detail, tone) {
    return `
      <div class="sim-result-count-card ${tone || ""}">
        <div class="sim-result-metric-label">${esc(label)}</div>
        <div class="sim-result-count-main">${esc(value)}</div>
        <div class="sim-result-count-sub">${esc(detail || "")}</div>
      </div>`;
  }

  function impactBarRows(items, limit, kind) {
    const list = Array.isArray(items) ? items.slice(0, limit || 8) : [];
    if (!list.length) return `<div class="sim-empty-state">${kind === "service" ? "Aucun service" : "Aucun poste"} ne varie de façon significative.</div>`;
    return list.map(item => {
      const before = int(item.fragilite_avant);
      const after = int(item.fragilite_apres);
      const delta = int(item.delta || 0);
      const tone = delta < 0 ? "is-good" : delta > 0 ? "is-bad" : "is-neutral";
      const code = item.codif_client || item.codif_poste || "";
      const title = kind === "service" ? (item.nom_service || "Service") : (item.intitule_poste || "Poste");
      const sub = kind === "service" ? "Lecture moyenne du service" : (item.nom_service || "");
      return `
        <div class="sim-impact-bar-card ${tone}">
          <div class="sim-impact-bar-head">
            <div>
              <div class="sim-impact-title">${kind === "service" ? esc(title) : `${code ? `<span class="sb-badge sb-badge--code">${esc(code)}</span> ` : ""}${esc(title)}`}</div>
              <div class="card-sub" style="margin:4px 0 0 0;">${esc(sub)}</div>
            </div>
            <div class="sim-impact-bar-side">
              <div class="sim-impact-score">${esc(before)} → ${esc(after)}</div>
              <div>${deltaBadge(delta)}</div>
            </div>
          </div>
          <div class="sim-impact-bar-lines">
            <div class="sim-impact-bar-line">
              <span>Avant</span>
              <div class="sim-impact-bar-track"><div class="sim-impact-bar-fill is-before" style="width:${Math.max(0, Math.min(100, before))}%"></div></div>
              <strong>${before}</strong>
            </div>
            <div class="sim-impact-bar-line">
              <span>Après</span>
              <div class="sim-impact-bar-track"><div class="sim-impact-bar-fill ${tone}" style="width:${Math.max(0, Math.min(100, after))}%"></div></div>
              <strong>${after}</strong>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  function renderDevelopmentNeeds(result) {
    const needs = result?.developpement?.besoins_formation || [];
    if (!needs.length) return `<div class="sim-empty-state">Aucun besoin complémentaire de montée en compétence détecté sur les mobilités du scénario.</div>`;
    return needs.slice(0, 8).map(n => `
      <div class="sim-lego-dev-row">
        <div>
          <div class="sim-impact-title">${esc(n.nom_complet || "Collaborateur")}</div>
          <div class="card-sub" style="margin:3px 0 0 0;">${esc(n.code ? n.code + " · " : "")}${esc(n.intitule || "Compétence")} · niveau attendu ${esc(n.niveau_requis || "—")}</div>
        </div>
        <span class="sb-badge ${Number(n.couverture_pct || 0) < 60 ? "sb-badge--warning" : ""}">${esc(n.lecture || "À renforcer")}</span>
      </div>
    `).join("");
  }

  function buildResultNarrative(result, current, immediat, projete, finalSummary, finalImpact, hasProjected, needs) {
    const imSummary = immediat?.summary || {};
    const imDelta = int(imSummary.fragilite_moyenne) - int(current.fragilite_moyenne);
    const finalDelta = int(finalSummary.fragilite_moyenne) - int(current.fragilite_moyenne);
    const improved = int(finalImpact.postes_securises || 0);
    const degraded = int(finalImpact.postes_degrades || 0);
    const topPost = (finalImpact.postes_impactes || immediat?.impact?.postes_impactes || [])[0] || null;

    let title = "Le scénario produit un impact limité à ce stade.";
    if (improved > 0 && degraded === 0 && finalDelta < 0) {
      title = `Le scénario améliore ${improved} poste${improved > 1 ? "s" : ""} sans dégradation visible sur le périmètre.`;
    } else if (improved > 0 && degraded > 0) {
      title = `Le scénario sécurise une partie du périmètre, mais déplace aussi le risque sur ${degraded} poste${degraded > 1 ? "s" : ""}.`;
    } else if (degraded > 0 || finalDelta > 0) {
      title = `Le scénario augmente le niveau de vigilance sur le périmètre étudié.`;
    }

    const summaryParts = [];
    summaryParts.push(`La fragilité moyenne passe de ${int(current.fragilite_moyenne)} à ${int(finalSummary.fragilite_moyenne)} (${deltaText(finalDelta)}).`);
    if (topPost) {
      summaryParts.push(`${topPost.intitule_poste || "Le poste principal"} est ${int(topPost.delta || 0) < 0 ? "le plus amélioré" : int(topPost.delta || 0) > 0 ? "le plus fragilisé" : "le plus impacté"}.`);
    }

    const rhParts = [];
    if (improved > 0 && degraded === 0) {
      rhParts.push(`Le scénario peut servir de base de discussion avec le manager ou le RH, car il améliore le poste étudié sans créer d’alerte visible sur les autres postes.`);
    } else if (improved > 0 && degraded > 0) {
      rhParts.push(`Le scénario apporte un gain local, mais il doit être arbitré avec prudence car il déplace une partie de la fragilité vers d’autres postes ou services.`);
    } else if (degraded > 0) {
      rhParts.push(`Le scénario n’est pas recommandé en l’état : il crée davantage de tensions qu’il n’en résout.`);
    } else {
      rhParts.push(`Le scénario a un effet modéré. Il reste utile pour comparer plusieurs options avant décision.`);
    }
    if (hasProjected && needs.length) {
      rhParts.push(`Une partie du résultat dépend d’une montée en compétence projetée. Les besoins détectés devront être confirmés avant arbitrage.`);
    } else if (hasProjected) {
      rhParts.push(`L’effet projeté suppose que la montée en compétence simulée soit réellement atteinte.`);
    }

    const vigilance = [];
    if (degraded > 0) vigilance.push(`Vérifier les postes ou services fragilisés avant de retenir ce scénario.`);
    if (needs.length) vigilance.push(`Prévoir le traitement des besoins de montée en compétence générés par le scénario.`);    if (!degraded && !needs.length) vigilance.push(`Confirmer la faisabilité terrain : disponibilité des personnes, charge réelle et calendrier.`);
    if (!hasProjected) vigilance.push(`Le résultat présenté porte sur l’effet organisationnel direct du scénario.`);

    return {
      title,
      summary: summaryParts.join(" "),
      rh: rhParts.join(" "),
      vigilance,
    };
  }

  function renderResult(result) {
    ensureResultVisualStyles();
    const root = byId("simResultContainer");
    if (!root) return;
    if (!result) {
      root.innerHTML = `<div class="card"><div class="card-title">Résultat du scénario</div><div class="card-sub sim2-muted-top">Construisez un scénario puis lancez le calcul.</div></div>`;
      return;
    }

    const current = result.actuel || {};
    const immediat = result.resultats?.immediat || { summary: result.simule || {}, impact: result.impact || {} };
    const projete = result.resultats?.projete || { summary: result.simule || {}, impact: result.impact || {} };
    const imSummary = immediat.summary || {};
    const prSummary = projete.summary || {};
    const imImpact = immediat.impact || {};
    const prImpact = projete.impact || result.impact || {};
    const needs = result?.developpement?.besoins_formation || [];
    const hasProjected = needs.length > 0 || _scenario.some(b => ["montee_competence", "projection_competence", "renforcer_titulaire", "relais_interne", "recrutement_cv"].includes((b?.type || "").toString()));
    const finalSummary = hasProjected ? prSummary : imSummary;
    const finalImpact = hasProjected ? prImpact : imImpact;
    const finalDelta = int(finalSummary.fragilite_moyenne) - int(current.fragilite_moyenne);
    const focusDelta = result?.poste_focus ? int(result.poste_focus.delta_projete) : finalDelta;
    const narrative = buildResultNarrative(result, current, immediat, projete, finalSummary, finalImpact, hasProjected, needs);
    const improvedCount = int(finalImpact.postes_securises || 0);
    const degradedCount = int(finalImpact.postes_degrades || 0);
    const impactedCount = Array.isArray(finalImpact.postes_impactes) ? finalImpact.postes_impactes.length : 0;

    root.innerHTML = `
      <div class="card sim-result-hero ${trendClass(focusDelta, true)}">
        <div class="sim-result-hero-top">
          <div>
            <div class="sim-result-label">Résultat du scénario</div>
            <div class="sim-result-title">${esc(narrative.title)}</div>
            <div class="sim-result-sub">${esc(narrative.summary)}</div>
          </div>
          <div class="sb-actions sb-actions--end">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimBackBuild">Modifier</button>
            <button type="button" class="sb-btn sb-btn--accent" id="btnSimAddCompare">Conserver</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimShowCompare">Comparer</button>
          </div>
        </div>
        <div class="sim-result-overview-grid sim-result-overview-grid--compact">
          ${focusFragilityRing(result, current, finalSummary)}
          ${metricCard("Fragilité moyenne du périmètre", current.fragilite_moyenne, finalSummary.fragilite_moyenne, true)}
          ${compactImpactCard("Postes", `${improvedCount} amélioré${improvedCount > 1 ? "s" : ""}`, `${degradedCount} dégradé${degradedCount > 1 ? "s" : ""} · ${impactedCount} impacté${impactedCount > 1 ? "s" : ""}`, degradedCount > 0 ? "is-watch" : "is-good")}
          ${compactImpactCard("Besoins générés", `${needs.length}`, hasProjected ? "Issus des projections ou mobilités du scénario." : "Aucun besoin projeté dans ce scénario.", needs.length ? "is-watch" : "is-good")}
        </div>
      </div>

      <div class="sim-result-main-grid">
        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">Synthèse de lecture</div>
          <div class="sim-result-summary-stack">
            <div class="sim-result-summary-block">
              <div class="sim-result-summary-label">Lecture RH</div>
              <p>${esc(narrative.rh)}</p>
            </div>
            <div class="sim-result-summary-block">
              <div class="sim-result-summary-label">Points de vigilance</div>
              <ul class="sim-result-bullet-list">
                ${narrative.vigilance.map(item => `<li>${esc(item)}</li>`).join("")}
              </ul>
            </div>
          </div>
        </div>

        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">Postes impactés par le scénario</div>
          <div class="card-sub sim2-muted-top">Lecture avant / après sur les postes dont la fragilité évolue le plus.</div>
          <div class="sim-impact-bar-list">${impactBarRows(finalImpact.postes_impactes || imImpact.postes_impactes || [], 8, "poste")}</div>
        </div>
      </div>

      <div class="sim-result-main-grid" style="margin-top:12px;">
        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">Services concernés</div>
          <div class="card-sub sim2-muted-top">Lecture visuelle par service pour repérer l’effet domino.</div>
          <div class="sim-impact-bar-list">${impactBarRows(finalImpact.services_impactes || imImpact.services_impactes || [], 8, "service")}</div>
        </div>

        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">${hasProjected ? "Projection après montée en compétence" : "Lecture du périmètre"}</div>
          <div class="sim-result-projection-note">${hasProjected ? `Le scénario contient une projection de montée en compétence. La fragilité moyenne du périmètre passe de ${esc(int(current.fragilite_moyenne))} à ${esc(int(prSummary.fragilite_moyenne))}.` : "Aucune projection de montée en compétence n’est activée dans ce scénario."}</div>
        </div>
      </div>

      <div class="card sim-result-readable-card" style="margin-top:12px;">
        <div class="card-title sim-result-section-title">Besoins générés par le scénario</div>
        <div class="card-sub sim2-muted-top">Ces besoins ne sont pas envoyés automatiquement. Ils servent à préparer l’étape Besoins & formations / Studio.</div>
        <div class="sim-lego-dev-list">${renderDevelopmentNeeds(result)}</div>
      </div>

      <details class="sim2-details sim-result-technical">
        <summary>Détail technique</summary>
        <div class="sim2-detail-body">
          <div class="sim-result-main-grid">
            <div>
              <div class="sim-result-detail-title">Postes impactés en immédiat</div>
              ${impactBarRows(imImpact.postes_impactes || [], 20, "poste")}
            </div>
            <div>
              <div class="sim-result-detail-title">Postes impactés en projeté</div>
              ${impactBarRows(prImpact.postes_impactes || [], 20, "poste")}
            </div>
          </div>
          <details class="sim2-details" style="margin-top:12px;">
            <summary>Cotation et données complémentaires</summary>
            <div class="sim2-detail-body">
              <div class="card-sub" style="margin:0 0 8px 0;">${esc(result.conseil?.impact_cotation || "Cotation à vérifier si le scénario modifie les responsabilités ou la classification.")}</div>
              ${(result.cotation?.postes_non_cotes || []).length ? `<div class="sim-empty-state">Postes sans cotation : ${(result.cotation.postes_non_cotes || []).map(p => esc(p.codif_poste ? p.codif_poste + " · " + p.intitule_poste : p.intitule_poste)).join(", ")}</div>` : `<div class="sim-empty-state">Aucune alerte de cotation remontée.</div>`}
            </div>
          </details>
        </div>
      </details>
    `;

    byId("btnSimBackBuild")?.addEventListener("click", () => switchTab("build"));
    byId("btnSimAddCompare")?.addEventListener("click", addLastResultToCompare);
    byId("btnSimShowCompare")?.addEventListener("click", () => switchTab("compare"));
  }

  function readCompare() {
    const list = readJson(STORE_COMPARE, []);
    return Array.isArray(list) ? list : [];
  }

  function writeCompare(list) {
    writeJson(STORE_COMPARE, Array.isArray(list) ? list : []);
    renderCompare();
    updateCompareCount();
  }

  function updateCompareCount() {
    const el = byId("simCompareCount");
    if (el) el.textContent = String(readCompare().length);
  }

  function addLastResultToCompare() {
    if (!_lastResult) return;
    const list = readCompare();
    list.unshift({ id: `sim_${Date.now()}`, saved_at: new Date().toISOString(), result: _lastResult });
    writeCompare(list.slice(0, 8));
    switchTab("compare");
  }

  function renderCompare() {
    const root = byId("simCompareContainer");
    if (!root) return;
    const list = readCompare();
    updateCompareCount();
    if (!list.length) {
      root.innerHTML = `<div class="card"><div class="sim-empty-state">Aucun scénario conservé.</div><div class="sb-actions" style="margin-top:12px;"><button type="button" class="sb-btn sb-btn--soft" id="btnSimCompareBackBuild">Retour au scénario</button></div></div>`;
      byId("btnSimCompareBackBuild")?.addEventListener("click", () => switchTab("build"));
      return;
    }
    root.innerHTML = `
      <div class="card sim-compare-readable">
        ${list.map((x, idx) => {
          const r = x.result || {};
          const imDelta = r.resultats?.immediat?.ecart?.fragilite_moyenne || 0;
          const prDelta = r.resultats?.projete?.ecart?.fragilite_moyenne || r.ecart?.fragilite_moyenne || 0;
          const impact = r.resultats?.projete?.impact || r.impact || {};
          return `
            <div class="sim-compare-card">
              <div>
                <div class="sim-impact-title">${esc(r.titre || "Scénario")}</div>
                <div class="card-sub" style="margin-top:3px;">${esc(r.scope?.nom_service || "Tous les services")}</div>
              </div>
              <div class="sim-compare-metrics">
                <span>Immédiat ${deltaBadge(imDelta)}</span>
                <span>Projeté ${deltaBadge(prDelta)}</span>
                <span>${esc(impact.postes_degrades || 0)} poste(s) dégradé(s)</span>
              </div>
              <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-remove-compare="${idx}">Retirer</button>
            </div>`;
        }).join("")}
      </div>`;
    root.querySelectorAll("[data-remove-compare]").forEach(btn => btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-remove-compare") || -1);
      const next = readCompare();
      if (idx >= 0) next.splice(idx, 1);
      writeCompare(next);
    }));
  }

  function switchTab(tab) {
    const wanted = tab || "build";
    document.querySelectorAll(".sim-tab-btn").forEach(btn => btn.classList.toggle("is-active", btn.getAttribute("data-sim-tab") === wanted));
    document.querySelectorAll(".sim-panel").forEach(panel => {
      panel.style.display = panel.getAttribute("data-sim-panel") === wanted ? "block" : "none";
    });
    if (wanted === "compare") renderCompare();
  }

  function renderAll() {
    renderPostePicker();
    renderRecommendations();
    renderPalette();
    renderBuilderFields();
    renderScenario();
    renderScenarioPreview();
    renderCompare();
  }

  function resetScenario() {
    _scenario = [];
    _lastResult = null;
    renderAll();
    renderResult(null);
    switchTab("build");
    setStatus("");
  }

  function bindOnce() {
    if (_bound) return;
    _bound = true;
    document.querySelectorAll(".sim-tab-btn").forEach(btn => btn.addEventListener("click", () => switchTab(btn.getAttribute("data-sim-tab") || "build")));
    byId("simFocusPosteSelect")?.addEventListener("change", e => { _selectedPosteId = e.target.value || ""; renderAll(); });
    byId("btnSimAddBrick")?.addEventListener("click", addBrickFromEditor);
    byId("btnSimEvaluate")?.addEventListener("click", () => evaluateScenario().catch(e => setStatus(errMsg(e), "error")));
    byId("btnSimResetScenario")?.addEventListener("click", resetScenario);
    byId("btnSimReloadOptions")?.addEventListener("click", () => { _optionsLoaded = false; loadOptions(true).catch(e => setStatus(errMsg(e), "error")); });
    byId("btnSimClearCompare")?.addEventListener("click", () => writeCompare([]));
    byId("simCriticiteRange")?.addEventListener("input", e => setCriticiteMin(e.target.value));
    byId("simCriticiteRange")?.addEventListener("change", () => {
      _optionsLoaded = false;
      loadOptions(true, { silent: true }).catch(e => setStatus(errMsg(e), "error"));
    });
    byId("simServiceSelect")?.addEventListener("change", () => { _optionsLoaded = false; loadOptions(true).catch(e => setStatus(errMsg(e), "error")); });
  }

  async function onShow(portal) {
    _portal = portal;
    bindOnce();
    setCriticiteMin(localStorage.getItem(STORE_CRIT) || 70);
    renderAll();
    updateCompareCount();
    try {
      await populateServices();
      const ctx = consumeContext();
      if (ctx) {
        applyContextFilters(ctx);
        _optionsLoaded = false;
      }
      await loadOptions(false);
      if (ctx) applyContext(ctx);
    } catch (e) {
      setStatus(errMsg(e), "error");
    }
  }

  window.SkillsSimulationsRH = { onShow };
})();
