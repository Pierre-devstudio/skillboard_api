/* ======================================================
   static/menus/skills_simulations_rh.js
   Simulation RH - atelier de scÃ©narios d'organisation
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
  let _lastSavedScenario = null;
  let _historyLoaded = false;
  let _historyItems = [];
  let _historyDetailCache = new Map();
  let _compareIds = [];
  let _compareAnalysis = null;
  let _compareAnalysisIds = "";
  let _saveIntent = "save";
  let _context = null;

  const STORE_COMPARE = "sb_simulations_rh_compare_v3";
  const STORE_SERVICE = "sb_simulations_rh_service";
  const STORE_CRIT = "sb_simulations_rh_criticite";
  const STORE_CONTEXT = "sb_simulations_rh_context_v1";

  const BRICKS = {
    mobilite_effectif: {
      title: "DÃ©placer une personne",
      short: "Tester une mobilitÃ©, un remplacement ou un renfort humain.",
      icon: "â‡„",
      group: "immediate",
      temporalite: "immediate",
    },
    transfert_charge: {
      title: "TransfÃ©rer une charge",
      short: "DÃ©placer une activitÃ© ou une compÃ©tence attendue vers un autre poste.",
      icon: "â‡¢",
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
      short: "Tester une sortie ou une absence longue avec durÃ©e.",
      icon: "âˆ’",
      group: "immediate",
      temporalite: "immediate",
    },
    renforcer_titulaire: {
      title: "Renforcer le titulaire",
      short: "Projeter la mise Ã  niveau du titulaire sur les compÃ©tences attendues du poste.",
      icon: "â‡¡",
      group: "projected",
      temporalite: "development",
    },
    montee_competence: {
      title: "Projeter une compÃ©tence",
      short: "Mesurer lâ€™impact si un niveau cible est atteint.",
      icon: "â†—",
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
    return `${code ? code + " Â· " : ""}${p.intitule_poste || "Poste"}`;
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
    return `${e.nom_complet || "Collaborateur"}${poste ? " â€” " + poste : ""}`;
  }

  function compLabel(c) {
    if (!c) return "CompÃ©tence";
    const code = (c.code || "").trim();
    return `${code ? code + " Â· " : ""}${c.intitule || "CompÃ©tence"}`;
  }

  function compShort(c) {
    const code = (c?.code || "").toString().trim();
    return code || (c?.intitule || "CompÃ©tence");
  }

  function levelLabel(code) {
    const c = (code || "").toString().trim().toUpperCase();
    return ({ A: "DÃ©butant", B: "IntermÃ©diaire", C: "AvancÃ©", D: "Expert" }[c]) || c || "niveau cible";
  }

  function brickKind(b) {
    if (!b) return "Action";
    if (b.type === "recrutement_virtuel") return "Profil virtuel";
    if (b.type === "recrutement_cv") return "Analyse CV";
    if (b.type === "relais_interne") return "Relais interne";
    if (b.type === "absence_effectif") return "Absence longue";
    if (b.type === "depart_effectif") return "DÃ©part";
    if (b.type === "transfert_charge") return "Charge transfÃ©rÃ©e";
    if (b.type === "renforcer_titulaire") return "Renforcement titulaire";
    if (b.type === "montee_competence") return "CompÃ©tence projetÃ©e";
    return "DÃ©placement";
  }

  function brickSummary(b) {
    if (!b) return "Action RH";
    const eff = effectifById(b.id_effectif);
    const source = posteById(b.id_poste);
    const target = posteById(b.id_poste_cible || b.id_poste);
    const comp = compById(b.id_comp);
    const person = eff?.nom_complet || "Collaborateur";

    if (b.type === "transfert_charge") {
      return `${compShort(comp)} Â· ${posteShort(source)} â†’ ${posteShort(target)}`;
    }
    if (b.type === "recrutement_virtuel") {
      return `Profil virtuel Â· ${posteShort(target)}`;
    }
    if (b.type === "recrutement_cv") {
      return `${b.candidat_nom || "Candidat CV"} Â· ${posteShort(target)}`;
    }
    if (b.type === "relais_interne") {
      return `${person} Â· relais ${posteShort(target)}`;
    }
    if (b.type === "absence_effectif") {
      return `${person} Â· ${b.duree_libelle || "durÃ©e Ã  confirmer"}`;
    }
    if (b.type === "depart_effectif") {
      return person;
    }
    if (b.type === "renforcer_titulaire") {
      return `${person} Â· mise Ã  niveau ${posteShort(target)}`;
    }
    if (b.type === "montee_competence") {
      return `${person} Â· ${compShort(comp)} â†’ ${levelLabel(b.niveau_simule)}`;
    }
    return `${person} â†’ ${posteShort(target)}`;
  }

  function deltaText(v) {
    const n = int(v);
    if (n === 0) return "0%";
    return `${n > 0 ? "+" : ""}${n}%`;
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
    return good ? "amÃ©lioration" : "dÃ©gradation";
  }

  function trendClass(delta, inverse) {
    const n = int(delta);
    if (n === 0) return "is-neutral";
    const good = inverse ? n > 0 : n < 0;
    return good ? "is-good" : "is-bad";
  }

  function ensureResultVisualStyles() {
    // Styles principaux dÃ©placÃ©s dans skills_portal_theme.css pour Ã©viter les surcharges inline.
  }

  function ensureCvRenfortStyles() {
    if (document.getElementById("simCvRenfortStylesV1")) return;
    const style = document.createElement("style");
    style.id = "simCvRenfortStylesV1";
    style.textContent = `
      .sim-cv-upload-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
      .sim-cv-upload-zone{display:flex;align-items:center;gap:12px;min-height:72px;border:1px dashed color-mix(in srgb,var(--accent) 35%,#cbd5e1);border-radius:14px;background:linear-gradient(180deg,#fff 0%,color-mix(in srgb,var(--accent) 4%,#fff) 100%);padding:12px;cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease;}
      .sim-cv-upload-zone:hover{border-color:var(--accent);box-shadow:0 10px 24px color-mix(in srgb,var(--accent) 10%,transparent);transform:translateY(-1px);}
      .sim-cv-upload-icon{width:38px;height:38px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);font-weight: var(--ns-weight-bold);font-size: var(--ns-title-sm);flex:0 0 auto;}
      .sim-cv-upload-copy{min-width:0;display:flex;flex-direction:column;gap:3px;}
      .sim-cv-upload-copy strong{font-size: var(--ns-text-sm);font-weight: var(--ns-weight-bold);color:var(--sb-gray-900);}
      .sim-cv-upload-copy small{font-size: var(--ns-text-xs);color:var(--sb-gray-500);line-height: var(--ns-leading-ui);}
      .sim-cv-upload-copy em{font-style:normal;font-size: var(--ns-text-xs);color:var(--sb-gray-700);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
      .sim-cv-file-input{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;}
      .sim-cv-analysis-actions{display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;}
      .sim-cv-loading-state{display:flex;align-items:center;gap:10px;color:var(--sb-gray-700);font-size: var(--ns-text-sm);}
      .sim-cv-loading-ring{width:22px;height:22px;border-radius:50%;border:3px solid #e5e7eb;border-top-color:var(--accent);animation:simCvSpin .85s linear infinite;flex:0 0 auto;}
      .sim-cv-error-title{font-weight: var(--ns-weight-bold);color:var(--sb-gray-900);margin-bottom:4px;}
      .sim-cv-error-text{font-size: var(--ns-text-sm);line-height: var(--ns-leading-body);color:var(--sb-gray-700);}
      @keyframes simCvSpin{to{transform:rotate(360deg);}}
      .sim-cv-modal-title-stack{display:flex;flex-direction:column;gap:4px;min-width:0;}
      .sim-cv-modal-title-line,.sim-cv-modal-title-sub{display:flex;align-items:center;gap:8px;min-width:0;}
      .sim-cv-modal-title-line span:first-child,.sim-cv-modal-title-sub span:last-child{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .sim-cv-modal-grid{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:start;}
      .sim-cv-modal-side{border:1px solid var(--sb-gray-200);border-radius:14px;padding:12px;background:#fff;display:flex;flex-direction:column;align-items:center;gap:10px;}
      .sim-cv-modal-summary{border:1px solid var(--sb-gray-200);border-radius:14px;padding:12px;background:#fff;}
      .sim-cv-comp-cell{display:flex;align-items:center;gap:8px;min-width:0;}
      .sim-cv-comp-cell .sim-cv-comp-title{font-size: var(--ns-text-sm);font-weight: var(--ns-weight-semibold);color:var(--sb-gray-900);line-height: var(--ns-leading-ui);}
      .sim-cv-proof{font-size: var(--ns-text-xs);line-height: var(--ns-leading-body);color:var(--sb-gray-700);}
      .sim-cv-undemonstrated{display:inline-flex;align-items:center;justify-content:center;min-width:96px;height:22px;padding:0 10px;border:1px solid rgba(124,58,237,.32);border-radius:999px;background:rgba(124,58,237,.06);color:#6d28d9;font-size: var(--ns-text-xs);font-weight: var(--ns-weight-bold);line-height: var(--ns-leading-tight);white-space:nowrap;box-sizing:border-box;}
      .sim-cv-center{text-align:center;}
      .sim-cv-modal-summary p{margin:0;color:var(--sb-gray-700);font-size: var(--ns-text-sm);line-height: var(--ns-leading-body);}
      .sim-cv-modal-chip-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
      .sim-cv-mini-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px;}
      .sim-cv-mini-card{border:1px solid var(--sb-gray-200);border-radius:12px;padding:10px;background:#fff;}
      .sim-cv-mini-card h4{margin:0 0 6px 0;font-size: var(--ns-text-xs);font-weight: var(--ns-weight-bold);color:var(--sb-gray-900);}
      .sim-cv-mini-card ul{margin:0;padding-left:16px;color:var(--sb-gray-700);font-size: var(--ns-text-xs);line-height: var(--ns-leading-body);}
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
            <em id="${esc(nameId)}">Aucun fichier sÃ©lectionnÃ©</em>
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
      nameEl.textContent = file ? file.name : "Aucun fichier sÃ©lectionnÃ©";
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
            <div style="font-weight: var(--ns-weight-bold);font-size: var(--ns-kpi);line-height: var(--ns-leading-tight);">${s}<span style="font-size: var(--ns-text-xs);font-weight: var(--ns-weight-bold);">%</span></div>
          </div>
        </div>
        <div class="card-sub" style="margin:0;">AdÃ©quation</div>
      </div>`;
  }

  function cvLevelBadge(level) {
    const raw = (level || "").toString().trim().toUpperCase();
    const rank = ({ A: 1, B: 2, C: 3, D: 4 }[raw]) || 0;
    if (!rank) return `<span class="sim-cv-undemonstrated">Non dÃ©montrÃ©</span>`;
    return `<span class="sb-badge sb-badge-niv sb-badge-niv-${raw.toLowerCase()}">${esc(levelLabel(raw))}</span>`;
  }

  function ensureCvAnalysisModal() {
    ensureCvRenfortStyles();
    let modal = byId("modalSimCvAnalysis");
    if (modal) return modal;
    const html = `
      <div class="modal" id="modalSimCvAnalysis" aria-hidden="true">
        <div class="modal-card modal-card--wide">
          <div class="modal-header">
            <div class="sim-cv-modal-title-stack">
              <div class="sim-cv-modal-title-line">
                <span id="simCvAnalysisModalTitle" style="font-weight: var(--ns-weight-semibold);">Analyse CV</span>
                <span class="sb-badge sb-badge--candidat" id="simCvAnalysisModalBadge">Candidat CV</span>
              </div>
              <div class="sim-cv-modal-title-sub">
                <span class="sb-badge sb-badge-ref-poste-code" id="simCvAnalysisPosteCode" style="display:none;"></span>
                <span id="simCvAnalysisPosteText" style="font-weight: var(--ns-weight-semibold);"></span>
              </div>
            </div>
            <button type="button" class="modal-x" id="btnCloseSimCvAnalysisModal" aria-label="Fermer">Ã—</button>
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
          </div>
          <div class="sim-cv-modal-summary">
            <div class="card-title" style="font-size: var(--ns-text-lg);font-weight: var(--ns-weight-bold);margin:0 0 6px 0;">Avis Novoskill</div>
            <p>${esc(data.lecture_recruteur || data.resume_profil || "Analyse disponible.")}</p>
          </div>
        </div>

        <div class="table-wrap" style="margin-top:12px;">
          <table class="sb-table">
            <thead>
              <tr>
                <th>CompÃ©tence attendue</th>
                <th style="width:130px;" class="col-center">Niveau<br>requis</th>
                <th style="width:150px;" class="col-center">Estimation<br>Novoskill</th>
                <th>Preuve</th>
              </tr>
            </thead>
            <tbody>
              ${matching.length ? matching.map(row => `
                <tr>
                  <td>
                    <div class="sim-cv-comp-cell">
                      <span class="sb-badge sb-badge-ref-comp-code">${esc(row.code || "â€”")}</span>
                      <span class="sim-cv-comp-title">${esc(row.intitule || "CompÃ©tence")}</span>
                    </div>
                  </td>
                  <td class="col-center">${cvLevelBadge(row.niveau_requis)}</td>
                  <td class="col-center">${cvLevelBadge(row.niveau_estime)}</td>
                  <td><div class="sim-cv-proof">${esc(row.preuve_cv || "Non dÃ©montrÃ© dans le CV.")}</div></td>
                </tr>`).join("") : `<tr><td colspan="4" class="col-center" style="color:#6b7280;">Aucune correspondance dÃ©taillÃ©e retournÃ©e.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="sim-cv-mini-list">
          <div class="sim-cv-mini-card">
            <h4>Points favorables</h4>
            <ul>${fav.length ? fav.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>Ã€ confirmer en entretien.</li>`}</ul>
          </div>
          <div class="sim-cv-mini-card">
            <h4>Points de vigilance</h4>
            <ul>${vigil.length ? vigil.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>Aucun point majeur remontÃ©.</li>`}</ul>
          </div>
          <div class="sim-cv-mini-card">
            <h4>Questions dâ€™entretien</h4>
            <ul>${questions.length ? questions.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("") : `<li>PrÃ©ciser les expÃ©riences liÃ©es au poste.</li>`}</ul>
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
    opt0.textContent = placeholder || "SÃ©lectionnerâ€¦";
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
      labelNonLie: "Non liÃ©s",
    });
  }

  async function loadOptions(force, opts = {}) {
    if (_optionsLoaded && !force) return _options;
    if (!_portal || !_portal.contactId) return _options;
    const silent = !!opts.silent;
    if (!silent) setStatus("Chargement des donnÃ©es RHâ€¦");
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
    return `${e.nom_complet || "Collaborateur"}${score ? " Â· " + score + "%" : ""}${poste ? " â€” " + poste : ""}`;
  }

  function renderPostePicker() {
    const title = byId("simFocusPosteTitle");
    if (title) title.textContent = _context ? "Poste de dÃ©part - Issu de lâ€™analyse" : "Poste de dÃ©part";

    const sel = byId("simFocusPosteSelect");
    fillSelect(sel, _options.postes || [], "id_poste", posteLabel, "Choisir un posteâ€¦");
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
          <span>Cible titulaires : ${esc(p.nb_titulaires_cible ?? "â€”")}</span>
          <span>${esc(p.cotation_label || "Cotation Ã  complÃ©ter")}</span>
        </div>
      ` : `<div class="sim-empty-state">Choisissez le poste Ã  travailler.</div>`;
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
      root.innerHTML = `<div class="sim-empty-state">Aucun profil proche identifiÃ© pour ce poste. Vous pouvez tout de mÃªme tester un renfort ou une mobilitÃ© manuelle.</div>`;
      return;
    }
    root.innerHTML = rows.map((r, idx) => `
      <div class="sim-lego-person-card ${idx === 0 ? "is-best" : ""}">
        <div class="sim-lego-person-main">
          <div class="sim-lego-person-title">${esc(r.nom_complet || "Collaborateur")}</div>
          <div class="card-sub sim-lego-person-sub">${esc(r.poste_actuel || "Poste actuel non renseignÃ©")} Â· ${esc(r.nom_service || "")}</div>
        </div>
        <div class="sim-lego-person-score">
          <span class="sb-badge ${idx === 0 ? "sb-badge--success" : ""}">${esc(r.score_pct || 0)}%</span>
          <div class="sim-lego-person-actions">
            <button type="button" class="sb-btn sb-btn--accent sb-btn--xs" data-sim-add-move="${esc(r.id_effectif)}"><span class="sim-btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg></span><span>Tester mobilitÃ©</span></button>
            <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-prepare-training="${esc(r.id_effectif)}"><span class="sim-btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-6"/><path d="M4 20h16"/></svg></span><span>Projeter niveau</span></button>
          </div>
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
        libelle: `DÃ©placer ${eff?.nom_complet || "un collaborateur"} vers ${posteLabel(posteById(_selectedPosteId))}`,
      });
    }));

    root.querySelectorAll("[data-sim-prepare-training]").forEach(btn => btn.addEventListener("click", () => {
      const eid = btn.getAttribute("data-sim-prepare-training") || "";
      const rec = recommendationsForPoste(_selectedPosteId).find(x => String(x.id_effectif || "") === eid) || {};
      const gap = (rec.competences_a_renforcer || [])[0] || requirementsForPoste(_selectedPosteId)[0];
      if (!gap) return setStatus("Aucune compÃ©tence Ã  renforcer identifiÃ©e pour cette personne.", "error");
      addBrick({
        type: "montee_competence",
        id_effectif: eid,
        id_poste: _selectedPosteId,
        id_comp: gap.id_comp,
        niveau_simule: gap.niveau_requis || "C",
        temporalite: "development",
        libelle: `Projeter ${effectifById(eid)?.nom_complet || "un collaborateur"} au niveau attendu sur ${gap.code || gap.intitule || "une compÃ©tence"}`,
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
          <span class="sim-lego-brick-icon">${esc(b.icon || "â€¢")}</span>
          <span><strong>${esc(b.title)}</strong><small>${esc(b.short)}</small></span>
        </button>`;
    }
    root.innerHTML = `
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Organisation immÃ©diate</div>
        <div class="sim-lego-brick-grid">${main.map(([key, b]) => buttonHtml(key, b)).join("")}</div>
      </div>
      <div class="sim-lego-brick-group">
        <div class="sim-lego-brick-group-title">Projection aprÃ¨s montÃ©e en compÃ©tence</div>
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

    const intro = `<div class="sim-brick-editor-title"><span>${esc(brick.icon || "â€¢")}</span><strong>${esc(brick.title)}</strong></div>`;

    if (_selectedBrick === "renfort_poste") {
      const relais = relaisCandidatesForPoste(_selectedPosteId);
      _lastCvAnalysis = null;
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Mode de renfort</div><select id="simBrickRenfortMode" class="sb-select"><option value="relais_interne">Relais interne</option><option value="recrutement_virtuel">Recrutement Â· profil virtuel</option><option value="analyse_cv">Recrutement Â· analyse CV</option></select></div>
          <div class="info-item"><div class="label">Poste Ã  renforcer</div><select id="simBrickPoste" class="sb-select"></select></div>
        </div>

        <div id="simRenfortRelaisPanel" class="sim-renfort-mode-panel">
          <div class="sim-form-grid">
            <div class="info-item sb-span-2"><div class="label">Relais interne proposÃ©</div><select id="simBrickEffectif" class="sb-select"></select></div>
          </div>
          <div class="card-sub sim2-muted-top">Les personnes sont proposÃ©es dans lâ€™ordre des meilleurs profils disponibles pour ce poste. Le moteur projette le relais sur les compÃ©tences dÃ©pendantes.</div>
        </div>

        <div id="simRenfortVirtuelPanel" class="sim-renfort-mode-panel" style="display:none;">
          <div class="card-sub sim2-muted-top">Le moteur ajoute un profil virtuel couvrant les compÃ©tences attendues du poste. Utile pour comparer avec un relais interne.</div>
        </div>

        <div id="simRenfortCvPanel" class="sim-renfort-mode-panel" style="display:none;">
          <div class="sim-cv-upload-grid">
            ${cvUploadZoneHtml("simBrickCvFile", "simBrickCvFileName", "Ajouter le CV candidat", "PDF, DOCX ou TXT Â· obligatoire", ".pdf,.doc,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain")}
            ${cvUploadZoneHtml("simBrickMotivationFile", "simBrickMotivationFileName", "Ajouter une lettre de motivation", "PDF, DOCX ou TXT Â· optionnel", ".pdf,.doc,.docx,.txt,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain")}
          </div>
          <div class="sim-form-grid" style="margin-top:10px;">
            <div class="info-item sb-span-2"><div class="label">Notes complÃ©mentaires / contexte candidat</div><textarea id="simBrickCvProjet" class="sb-input" rows="3" placeholder="Optionnel : disponibilitÃ©, contexte RH, Ã©lÃ©ments transmis hors CV et lettre..."></textarea></div>
          </div>
          <div class="sb-actions" style="margin-top:10px;">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimAnalyseCv">Analyser le CV</button>
          </div>
          <div id="simCvAnalysisPreview" class="sim-empty-state" style="margin-top:10px;">Analysez le CV avant dâ€™ajouter le candidat au scÃ©nario.</div>
        </div>
      `;
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un posteâ€¦");
      if (byId("simBrickPoste")) byId("simBrickPoste").value = _selectedPosteId || "";
      fillSelect(byId("simBrickEffectif"), relais, "id_effectif", relaisCandidateLabel, relais.length ? "Choisir un relais interneâ€¦" : "Aucun relais proposÃ©â€¦");

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
        fillSelect(byId("simBrickEffectif"), relaisCandidatesForPoste(pid), "id_effectif", relaisCandidateLabel, "Choisir un relais interneâ€¦");
        _lastCvAnalysis = null;
        const preview = byId("simCvAnalysisPreview");
        if (preview) preview.innerHTML = "Analysez le CV avant dâ€™ajouter le candidat au scÃ©nario.";
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
          <div class="info-item"><div class="label">Personne retirÃ©e du scÃ©nario</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Nature</div><select id="simBrickDepartType" class="sb-select"><option value="depart_effectif">DÃ©part / sortie</option><option value="absence_effectif">Absence longue</option></select></div>
          <div class="info-item" id="simBrickAbsenceDurationWrap" style="display:none;"><div class="label">DurÃ©e simulÃ©e</div><select id="simBrickAbsenceDuration" class="sb-select"><option value="30">1 mois</option><option value="60">2 mois</option><option value="90" selected>3 mois</option><option value="180">6 mois</option><option value="365">12 mois</option></select></div>
        </div>
        <div class="card-sub sim2-muted-top" id="simBrickDepartHint">Pour une absence longue, Novoskill mesure lâ€™Ã©tat du pÃ©rimÃ¨tre pendant la pÃ©riode simulÃ©e.</div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personneâ€¦");
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
          <div class="info-item sb-span-2"><div class="label">Charge / compÃ©tence transfÃ©rÃ©e</div><select id="simBrickCompetence" class="sb-select"></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique allÃ¨ge le poste source et ajoute cette exigence au poste cible.</div>
      `;
      fillSelect(byId("simBrickPosteSource"), posteOptions, "id_poste", posteLabel, "Choisir le poste sourceâ€¦");
      fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir le poste cibleâ€¦");
      if (byId("simBrickPosteSource")) byId("simBrickPosteSource").value = _selectedPosteId || "";
      const sourceSel = byId("simBrickPosteSource");
      const fillSourceReqs = () => {
        const src = sourceSel?.value || _selectedPosteId || "";
        fillSelect(byId("simBrickCompetence"), requirementsForPoste(src), "id_comp", compLabel, "Choisir lâ€™activitÃ© / compÃ©tenceâ€¦");
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
          <div class="info-item"><div class="label">Titulaire concernÃ©</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Poste</div><input type="text" class="sb-input" value="${esc(posteTitle(p))}" disabled></div>
          <div class="info-item"><div class="label">Niveau visÃ©</div><input type="text" class="sb-input" value="Niveau attendu du poste" disabled></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique projette la mise Ã  niveau du titulaire sur les compÃ©tences du poste oÃ¹ le niveau attendu nâ€™est pas atteint.</div>
      `;
      fillSelect(byId("simBrickEffectif"), titulaires.length ? titulaires : effectifs, "id_effectif", effectifLabel, titulaires.length ? "Choisir un titulaireâ€¦" : "Choisir une personneâ€¦");
      return;
    }

    if (_selectedBrick === "montee_competence") {
      root.innerHTML = `
        ${intro}
        <div class="sim-form-grid">
          <div class="info-item"><div class="label">Personne concernÃ©e</div><select id="simBrickEffectif" class="sb-select"></select></div>
          <div class="info-item"><div class="label">CompÃ©tence</div><select id="simBrickCompetence" class="sb-select"></select></div>
          <div class="info-item"><div class="label">Niveau visÃ©</div><select id="simBrickNiveau" class="sb-select"><option value="A">DÃ©butant</option><option value="B">IntermÃ©diaire</option><option value="C" selected>AvancÃ©</option><option value="D">Expert</option></select></div>
        </div>
        <div class="card-sub sim2-muted-top">Cette brique projette lâ€™Ã©tat si le niveau cible est atteint. Le besoin rÃ©el se traite ensuite dans Besoins & formations.</div>
      `;
      fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personneâ€¦");
      fillSelect(byId("simBrickCompetence"), reqs.length ? reqs : (_options.competences || []), "id_comp", compLabel, "Choisir une compÃ©tenceâ€¦");
      return;
    }

    root.innerHTML = `
      ${intro}
      <div class="sim-form-grid">
        <div class="info-item"><div class="label">Personne dÃ©placÃ©e</div><select id="simBrickEffectif" class="sb-select"></select></div>
        <div class="info-item"><div class="label">Poste cible</div><select id="simBrickPoste" class="sb-select"></select></div>
      </div>
      <div class="card-sub sim2-muted-top">Le poste dâ€™origine est automatiquement surveillÃ© pour dÃ©tecter lâ€™effet domino.</div>
    `;
    fillSelect(byId("simBrickEffectif"), effectifs, "id_effectif", effectifLabel, "Choisir une personneâ€¦");
    fillSelect(byId("simBrickPoste"), posteOptions, "id_poste", posteLabel, "Choisir un posteâ€¦");
    if (byId("simBrickPoste")) byId("simBrickPoste").value = (p?.id_poste || _selectedPosteId || "");
  }


  function cvAnalysisLoadingHtml() {
    return `
      <div class="sim-empty-state">
        <div class="sim-cv-loading-state">
          <span class="sim-cv-loading-ring" aria-hidden="true"></span>
          <span>Analyse IA du CV en coursâ€¦</span>
        </div>
      </div>`;
  }

  function cvAnalysisReadableError(e) {
    let msg = errMsg(e);
    try {
      const parsed = typeof msg === "string" && msg.trim().startsWith("{") ? JSON.parse(msg) : null;
      if (parsed?.detail) msg = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
    } catch (_) {
      /* garde le message brut */
    }

    msg = String(msg || "").trim();
    msg = msg.replace(/^skills\/simulations\/analyse-cv error:\s*/i, "");
    msg = msg.replace(/^Analyse CV IA impossible\s*:\s*/i, "");

    const lower = msg.toLowerCase();
    if (lower.includes("extraction pdf impossible") || lower.includes("pypdf")) {
      return "Le PDF nâ€™a pas pu Ãªtre lu automatiquement. Essayez un PDF texte, un DOCX ou un fichier TXT.";
    }
    if (lower.includes("extraction docx impossible") || lower.includes("python-docx")) {
      return "Le document Word nâ€™a pas pu Ãªtre lu automatiquement. Essayez un DOCX valide ou un fichier TXT.";
    }
    if (lower.includes("texte extrait") && lower.includes("insuffisant")) {
      return "Le fichier a Ã©tÃ© ouvert, mais le texte rÃ©cupÃ©rÃ© est trop faible pour produire une analyse fiable. Le CV est peut-Ãªtre scannÃ© comme une image.";
    }
    if (lower.includes("cv vide") || lower.includes("illisible")) {
      return "Le fichier transmis est vide ou illisible. Choisissez un autre CV.";
    }
    if (lower.includes("trop volumineux")) {
      return msg;
    }
    if (lower.includes("api key") || lower.includes("non configur")) {
      return "Lâ€™analyse IA nâ€™est pas configurÃ©e sur le serveur. La clÃ© API doit Ãªtre renseignÃ©e avant dâ€™utiliser cette fonction.";
    }
    if (lower.includes("non json") || lower.includes("json")) {
      return "Lâ€™IA a rÃ©pondu dans un format inexploitable. Relancez lâ€™analyse ou vÃ©rifiez le contenu du CV.";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "Lâ€™analyse a mis trop de temps Ã  rÃ©pondre. RÃ©essayez dans quelques instants.";
    }

    return msg || "Le CV nâ€™a pas pu Ãªtre analysÃ©. VÃ©rifiez le fichier puis relancez lâ€™analyse.";
  }

  async function analyseCvForRenfort() {
    const posteId = byId("simBrickPoste")?.value || _selectedPosteId || "";
    const file = byId("simBrickCvFile")?.files?.[0] || null;
    const motivationFile = byId("simBrickMotivationFile")?.files?.[0] || null;
    const preview = byId("simCvAnalysisPreview");
    if (!posteId) return setStatus("Choisissez le poste Ã  renforcer avant lâ€™analyse CV.", "error");
    if (!file) return setStatus("Ajoutez le CV candidat avant de lancer lâ€™analyse.", "error");

    const fd = new FormData();
    fd.append("id_poste", posteId);
    fd.append("projet_professionnel", byId("simBrickCvProjet")?.value || "");
    fd.append("cv_file", file);
    if (motivationFile) fd.append("motivation_file", motivationFile);

    if (preview) preview.innerHTML = cvAnalysisLoadingHtml();
    setStatus("Analyse IA du CV en coursâ€¦");
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
              <div class="card-sub" style="margin-top:2px;">AdÃ©quation estimÃ©e : ${esc(data?.adequation_pct || 0)}% Â· ${esc(needs.length)} besoin${needs.length > 1 ? "s" : ""} dÃ©tectÃ©${needs.length > 1 ? "s" : ""}</div>
            </div>
            <div class="sim-lego-person-score">
              <span class="sb-badge sb-badge--success">CV analysÃ©</span>
            </div>
          </div>
          ${(data?.points_vigilance || []).length ? `<div class="card-sub sim2-muted-top">Ã€ vÃ©rifier : ${esc((data.points_vigilance || []).slice(0, 2).join(" Â· "))}</div>` : ""}
          <div class="sim-cv-analysis-actions">
            <button type="button" class="sb-btn sb-btn--soft" data-sim-cv-view-analysis>Voir lâ€™analyse complÃ¨te</button>
          </div>
        `;
        preview.querySelector("[data-sim-cv-view-analysis]")?.addEventListener("click", () => openCvAnalysisModal(_lastCvAnalysis));
      }
      setStatus("Analyse CV prÃªte Ã  ajouter au scÃ©nario.");
    } catch (e) {
      _lastCvAnalysis = null;
      const readable = cvAnalysisReadableError(e);
      if (preview) {
        preview.innerHTML = `
          <div class="sim-empty-state">
            <div class="sim-cv-error-title">CV non analysÃ©</div>
            <div class="sim-cv-error-text">${esc(readable)}</div>
          </div>`;
      }
      setStatus(readable, "error");
    }
  }

  function addBrick(payload) {
    const item = { id: `brick_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...payload };
    _scenario.push(item);
    renderScenario();
    renderScenarioPreview();
    setStatus("Brique ajoutÃ©e au scÃ©nario.");
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
      if (!posteId) return setStatus("Choisissez un poste Ã  renforcer.", "error");

      if (mode === "relais_interne") {
        if (!effId) return setStatus("Choisissez le relais interne Ã  tester.", "error");
        return addBrick({
          type: "relais_interne",
          id_effectif: effId,
          id_poste: posteId,
          id_poste_cible: posteId,
          temporalite: "development",
          libelle: `CrÃ©er un relais interne avec ${effectifById(effId)?.nom_complet || "un collaborateur"} sur ${posteLabel(posteById(posteId))}`
        });
      }

      if (mode === "analyse_cv") {
        if (!_lastCvAnalysis || String(_lastCvAnalysis.id_poste || "") !== String(posteId || "")) {
          return setStatus("Analysez le CV avant dâ€™ajouter ce renfort au scÃ©nario.", "error");
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
      if (!effId) return setStatus("Choisissez la personne Ã  retirer du scÃ©nario.", "error");
      const t = byId("simBrickDepartType")?.value || "depart_effectif";
      return addBrick({
        type: t,
        id_effectif: effId,
        temporalite: "immediate",
        duree_jours: t === "absence_effectif" ? absenceDuration : null,
        duree_libelle: t === "absence_effectif" ? absenceDurationLabel : null,
        libelle: `${t === "absence_effectif" ? "Absence longue" : "DÃ©part"} de ${effectifById(effId)?.nom_complet || "collaborateur"}${t === "absence_effectif" ? ` Â· ${absenceDurationLabel}` : ""}`
      });
    }

    if (_selectedBrick === "transfert_charge") {
      if (!sourcePosteId || !posteId || !compId) return setStatus("Choisissez le poste source, le poste cible et la charge transfÃ©rÃ©e.", "error");
      if (sourcePosteId === posteId) return setStatus("Le poste source et le poste cible doivent Ãªtre diffÃ©rents.", "error");
      return addBrick({ type: "transfert_charge", id_poste: sourcePosteId, id_poste_cible: posteId, id_comp: compId, temporalite: "immediate", libelle: `TransfÃ©rer ${compLabel(compById(compId))} de ${posteLabel(posteById(sourcePosteId))} vers ${posteLabel(posteById(posteId))}` });
    }

    if (_selectedBrick === "renforcer_titulaire") {
      if (!effId) return setStatus("Choisissez le titulaire Ã  renforcer.", "error");
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
      if (!effId || !compId) return setStatus("Choisissez une personne et une compÃ©tence.", "error");
      return addBrick({ type: "montee_competence", id_effectif: effId, id_poste: _selectedPosteId, id_comp: compId, niveau_simule: niveau, temporalite: "development", libelle: `Projeter ${effectifById(effId)?.nom_complet || "collaborateur"} au niveau ${niveau} sur ${compLabel(compById(compId))}` });
    }

    if (!effId || !posteId) return setStatus("Choisissez une personne et un poste cible.", "error");
    return addBrick({ type: "mobilite_effectif", id_effectif: effId, id_poste: posteId, id_poste_cible: posteId, temporalite: "immediate", libelle: `DÃ©placer ${effectifById(effId)?.nom_complet || "collaborateur"} vers ${posteLabel(posteById(posteId))}` });
  }

  function renderScenario() {
    const root = byId("simScenarioBricks");
    if (!root) return;
    if (!_scenario.length) {
      root.innerHTML = `<div class="sim-empty-state">Votre scÃ©nario est vide. Ajoutez une brique Ã  gauche.</div>`;
      return;
    }
    root.innerHTML = _scenario.map((b, idx) => {
      const key = (b.type === "recrutement_virtuel" || b.type === "recrutement_cv" || b.type === "relais_interne") ? "renfort_poste" : (b.type === "absence_effectif" || b.type === "depart_effectif" ? "depart_effectif" : b.type);
      const meta = BRICKS[key] || BRICKS.mobilite_effectif;
      return `
        <div class="sim-lego-scenario-brick ${b.temporalite === "development" ? "is-dev" : ""}">
          <div class="sim-lego-scenario-icon">${esc(meta.icon || "â€¢")}</div>
          <div class="sim-lego-scenario-copy">
            <div class="sim-lego-brick-index">Brique ${idx + 1} Â· ${esc(brickKind(b))}</div>
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
          <span>Ajoutez au moins une brique pour analyser lâ€™impact.</span>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="sim-lego-preview-title">${esc(posteTitle(posteById(_selectedPosteId)))}</div>
    `;
  }

  function buildPayload() {
    return {
      titre: `ScÃ©nario organisation Â· ${posteLabel(posteById(_selectedPosteId))}`,
      objectif: "Tester une organisation RH composÃ©e de plusieurs briques.",
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
    if (!_scenario.length) return setStatus("Ajoutez au moins une brique au scÃ©nario.", "error");
    setStatus("Calcul des impacts du scÃ©narioâ€¦");
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
    _lastSavedScenario = null;
    setStatus("");
    renderResult(result);
    switchTab("result");
  }

  function metricCard(label, before, after, inverse, opts) {
    const b = int(before);
    const a = int(after);
    const delta = a - b;
    const suffix = opts?.suffix || "%";
    const deltaLabel = typeof opts?.deltaLabel === "function"
      ? opts.deltaLabel(delta)
      : (suffix === "%" ? `${delta > 0 ? "+" : ""}${delta}%` : `${delta > 0 ? "+" : ""}${delta} ${suffix}`);
    return `
      <div class="sim-result-metric-card ${trendClass(delta, inverse)}">
        <div class="sim-result-metric-label">${esc(label)}</div>
        <div class="sim-result-metric-values">${esc(b)} <span>â†’</span> ${esc(a)}</div>
        <div class="sim-result-compare-bars">
          <div class="sim-result-compare-line">
            <span>Avant</span>
            <div class="sim-result-compare-track"><div class="sim-result-compare-fill is-before" style="width:${Math.max(0, Math.min(100, b))}%"></div></div>
          </div>
          <div class="sim-result-compare-line">
            <span>AprÃ¨s</span>
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
    if (score <= 40) return "Ã€ sÃ©curiser";
    return "Ã€ Ã©tudier";
  }

  function focusFragilityRing(result, current, finalSummary) {
    const focus = result?.poste_focus || null;
    const hasFocus = !!focus;
    const before = hasFocus ? int(focus.fragilite_avant) : int(current.fragilite_moyenne);
    const after = hasFocus ? int(focus.fragilite_projete) : int(finalSummary.fragilite_moyenne);
    const delta = after - before;
    const tone = trendClass(delta, true);
    const pct = Math.max(0, Math.min(100, after));
    const title = hasFocus ? "Poste Ã©tudiÃ©" : "PÃ©rimÃ¨tre analysÃ©";
    const name = hasFocus ? (focus.intitule_poste || "Poste") : "FragilitÃ© moyenne";
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
            <div class="sim-result-focus-meta">FragilitÃ© ${esc(before)} â†’ ${esc(after)} Â· ${esc(deltaText(delta))}</div>
            <div class="sim-result-focus-note">${hasFocus ? "Lecture centrÃ©e sur le poste de dÃ©part." : "Lecture moyenne du pÃ©rimÃ¨tre."}</div>
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
    if (!list.length) return `<div class="sim-empty-state">${kind === "service" ? "Aucun service" : "Aucun poste"} ne varie de faÃ§on significative.</div>`;
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
              <div class="sim-impact-score">${esc(before)} â†’ ${esc(after)}</div>
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
              <span>AprÃ¨s</span>
              <div class="sim-impact-bar-track"><div class="sim-impact-bar-fill ${tone}" style="width:${Math.max(0, Math.min(100, after))}%"></div></div>
              <strong>${after}</strong>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  function renderDevelopmentNeeds(result) {
    const needs = result?.developpement?.besoins_formation || [];
    if (!needs.length) return `<div class="sim-empty-state">Aucun besoin complÃ©mentaire de montÃ©e en compÃ©tence dÃ©tectÃ© sur les mobilitÃ©s du scÃ©nario.</div>`;
    return needs.slice(0, 8).map(n => `
      <div class="sim-lego-dev-row">
        <div>
          <div class="sim-impact-title">${esc(n.nom_complet || "Collaborateur")}</div>
          <div class="card-sub" style="margin:3px 0 0 0;">${esc(n.code ? n.code + " Â· " : "")}${esc(n.intitule || "CompÃ©tence")} Â· niveau attendu ${esc(n.niveau_requis || "â€”")}</div>
        </div>
        <span class="sb-badge ${Number(n.couverture_pct || 0) < 60 ? "sb-badge--warning" : ""}">${esc(n.lecture || "Ã€ renforcer")}</span>
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

    let title = "Le scÃ©nario produit un impact limitÃ© Ã  ce stade.";
    if (improved > 0 && degraded === 0 && finalDelta < 0) {
      title = `Le scÃ©nario amÃ©liore ${improved} poste${improved > 1 ? "s" : ""} sans dÃ©gradation visible sur le pÃ©rimÃ¨tre.`;
    } else if (improved > 0 && degraded > 0) {
      title = `Le scÃ©nario sÃ©curise une partie du pÃ©rimÃ¨tre, mais dÃ©place aussi le risque sur ${degraded} poste${degraded > 1 ? "s" : ""}.`;
    } else if (degraded > 0 || finalDelta > 0) {
      title = `Le scÃ©nario augmente le niveau de vigilance sur le pÃ©rimÃ¨tre Ã©tudiÃ©.`;
    }

    const summaryParts = [];
    summaryParts.push(`La fragilitÃ© moyenne passe de ${int(current.fragilite_moyenne)} Ã  ${int(finalSummary.fragilite_moyenne)} (${deltaText(finalDelta)}).`);
    if (topPost) {
      summaryParts.push(`${topPost.intitule_poste || "Le poste principal"} est ${int(topPost.delta || 0) < 0 ? "le plus amÃ©liorÃ©" : int(topPost.delta || 0) > 0 ? "le plus fragilisÃ©" : "le plus impactÃ©"}.`);
    }

    const rhParts = [];
    if (improved > 0 && degraded === 0) {
      rhParts.push(`Vous disposez dâ€™une option favorable : le poste Ã©tudiÃ© se renforce et le pÃ©rimÃ¨tre ne montre pas de dÃ©gradation visible. Le scÃ©nario mÃ©rite dâ€™Ãªtre conservÃ© pour comparaison, sous rÃ©serve de confirmer les moyens terrain.`);
    } else if (improved > 0 && degraded > 0) {
      rhParts.push(`Vous gagnez sur une partie du pÃ©rimÃ¨tre, mais lâ€™hypothÃ¨se transfÃ¨re aussi du risque. Lâ€™arbitrage doit porter sur le bÃ©nÃ©fice rÃ©el du poste sÃ©curisÃ© face aux postes ou services fragilisÃ©s.`);
    } else if (degraded > 0) {
      rhParts.push(`Le scÃ©nario nâ€™est pas suffisamment robuste en lâ€™Ã©tat : il augmente la fragilitÃ© du pÃ©rimÃ¨tre ou crÃ©e des tensions visibles. Il doit Ãªtre ajustÃ© avant dâ€™Ãªtre prÃ©sentÃ© comme option dâ€™organisation.`);
    } else {
      rhParts.push(`Le scÃ©nario produit peu dâ€™effet mesurable. Il peut servir de point de comparaison, mais il ne constitue pas encore une rÃ©ponse suffisante au diagnostic de fragilitÃ©.`);
    }
    if (hasProjected && needs.length) {
      rhParts.push(`La projection reste conditionnÃ©e au traitement effectif des besoins dÃ©tectÃ©s. Ces besoins doivent Ãªtre planifiÃ©s avant dâ€™engager la dÃ©cision.`);
    } else if (hasProjected) {
      rhParts.push(`La projection suppose que les niveaux de compÃ©tence simulÃ©s soient rÃ©ellement atteints et confirmÃ©s sur le terrain.`);
    }

    const vigilance = [];
    if (degraded > 0) vigilance.push(`VÃ©rifier les postes ou services fragilisÃ©s avant de retenir ce scÃ©nario.`);
    if (needs.length) vigilance.push(`PrÃ©voir le traitement des besoins de montÃ©e en compÃ©tence gÃ©nÃ©rÃ©s par le scÃ©nario.`);    if (!degraded && !needs.length) vigilance.push(`Confirmer la faisabilitÃ© terrain : disponibilitÃ© des personnes, charge rÃ©elle et calendrier.`);
    if (!hasProjected) vigilance.push(`Le rÃ©sultat prÃ©sentÃ© porte sur lâ€™effet organisationnel direct du scÃ©nario.`);

    return {
      title,
      summary: summaryParts.join(" "),
      rh: rhParts.join(" "),
      vigilance,
    };
  }

  function simResultMiniIcon(icon, tone) {
    return `<span class="sim-result-ui-icon ${tone || ""}">${esc(icon || "")}</span>`;
  }

  function simResultBarLine(label, before, after, opts = {}) {
    const b = Math.max(0, Math.min(100, int(before)));
    const a = Math.max(0, Math.min(100, int(after)));
    const delta = int(after) - int(before);
    const tone = trendClass(delta, opts.inverse !== false);
    const right = opts.showRight === false ? "" : `<strong>${esc(a)}</strong>`;
    return `
      <div class="sim-result-linebar">
        <div class="sim-result-linebar-head">
          <span>${esc(label)}</span>
          <b>${esc(int(before))} â†’ ${esc(int(after))}</b>
          ${deltaBadge(delta)}
        </div>
        <div class="sim-result-linebar-row">
          <em>Avant</em>
          <div class="sim-result-linebar-track"><div class="sim-result-linebar-fill is-before" style="width:${b}%"></div></div>
          <strong>${esc(b)}</strong>
        </div>
        <div class="sim-result-linebar-row">
          <em>AprÃ¨s</em>
          <div class="sim-result-linebar-track"><div class="sim-result-linebar-fill ${tone}" style="width:${a}%"></div></div>
          ${right}
        </div>
      </div>`;
  }

  function simResultGaugeCard(label, before, after) {
    const b = Math.max(0, Math.min(100, int(before)));
    const a = Math.max(0, Math.min(100, int(after)));
    const delta = a - b;
    return `
      <div class="sim-result-decision-card sim-result-decision-card--gauge">
        <div class="sim-result-card-head">${simResultMiniIcon("âŒ", "is-blue")}<span>${esc(label)}</span></div>
        <div class="sim-result-gauge-values">
          <div><strong>${esc(b)}</strong><small>Avant</small></div>
          <div class="sim-result-delta-mid ${delta < 0 ? "is-good" : delta > 0 ? "is-bad" : ""}">${esc(deltaText(delta))}</div>
          <div><strong>${esc(a)}</strong><small>AprÃ¨s</small></div>
        </div>
        <div class="sim-result-gradient-gauge">
          <div class="sim-result-gradient-scale"></div>
          <span class="sim-result-gauge-dot is-before" style="left:${b}%"></span>
          <span class="sim-result-gauge-dot is-after" style="left:${a}%"></span>
        </div>
        <div class="sim-result-gauge-meta"><span>0</span><span>50</span><span>100</span></div>
      </div>`;
  }

  function simResultFocusCard(result, current, finalSummary) {
    const focus = result?.poste_focus || null;
    const before = focus ? int(focus.fragilite_avant) : int(current.fragilite_moyenne);
    const after = focus ? int(focus.fragilite_projete) : int(finalSummary.fragilite_moyenne);
    const delta = after - before;
    const code = focus ? (focus.codif_client || focus.codif_poste || "") : "";
    const name = focus ? (focus.intitule_poste || "Poste") : "PÃ©rimÃ¨tre analysÃ©";
    const pct = Math.max(0, Math.min(100, after));
    return `
      <div class="sim-result-decision-card sim-result-decision-card--focus ${trendClass(delta, true)}">
        <div class="sim-result-card-head"><span>Poste Ã©tudiÃ©</span></div>
        <div class="sim-result-focus-ui">
          <div class="sim-result-modern-ring" style="--sim-ring:${pct};"><span>${esc(after)}<small>%</small></span></div>
          <div class="sim-result-focus-text">
            <div>${code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : ""}<strong>${esc(name)}</strong></div>
            <p>FragilitÃ© ${esc(before)} â†’ ${esc(after)} ${deltaBadge(delta)}</p>
            <small>Lecture centrÃ©e sur le poste de dÃ©part.</small>
          </div>
        </div>
      </div>`;
  }

  function simResultCountCard(label, value, detail, icon, tone) {
    return `
      <div class="sim-result-decision-card sim-result-decision-card--count ${tone || ""}">
        <div class="sim-result-card-head">${simResultMiniIcon(icon || "â€¢", tone || "")}<span>${esc(label)}</span></div>
        <div class="sim-result-count-value">${esc(value)}</div>
        <div class="sim-result-count-detail">${esc(detail || "")}</div>
      </div>`;
  }

  function simResultEffectPanel(title, subtitle, icon, rows) {
    return `
      <div class="sim-result-effect-panel">
        <div class="sim-result-effect-title">${simResultMiniIcon(icon || "â€¢", icon === "â†—" ? "is-green" : "is-blue")}<div><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</div></div>
        <div class="sim-result-effect-lines">${rows.join("")}</div>
      </div>`;
  }

  function simResultImpactCards(items, limit, kind) {
    const list = Array.isArray(items) ? items.slice(0, limit || 4) : [];
    if (!list.length) return `<div class="sim-empty-state">Aucun ${kind === "service" ? "service" : "poste"} ne varie de faÃ§on significative.</div>`;
    return list.map(item => {
      const before = int(item.fragilite_avant);
      const after = int(item.fragilite_apres);
      const delta = int(item.delta || 0);
      const tone = delta < 0 ? "is-good" : delta > 0 ? "is-bad" : "is-neutral";
      const code = item.codif_client || item.codif_poste || "";
      const title = kind === "service" ? (item.nom_service || "Service") : (item.intitule_poste || "Poste");
      const sub = kind === "service" ? "Lecture moyenne du service" : (item.nom_service || "");
      return `
        <div class="sim-result-impact-modern ${tone}">
          <div class="sim-result-impact-modern-head">
            <div>
              <div class="sim-result-impact-modern-title">${kind === "service" ? esc(title) : `${code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : ""}<strong>${esc(title)}</strong>`}</div>
              <div class="sim-result-impact-modern-sub">${esc(sub)}</div>
            </div>
            <div class="sim-result-impact-modern-delta"><span>${esc(before)} â†’ ${esc(after)}</span>${deltaBadge(delta)}</div>
          </div>
          <div class="sim-result-linebar-row"><em>Avant</em><div class="sim-result-linebar-track"><div class="sim-result-linebar-fill is-before" style="width:${Math.max(0, Math.min(100, before))}%"></div></div><strong>${esc(before)}</strong></div>
          <div class="sim-result-linebar-row"><em>AprÃ¨s</em><div class="sim-result-linebar-track"><div class="sim-result-linebar-fill ${tone}" style="width:${Math.max(0, Math.min(100, after))}%"></div></div><strong>${esc(after)}</strong></div>
        </div>`;
    }).join("");
  }

  function simResultImpactLegend(impact) {
    const improved = int(impact?.postes_securises || 0);
    const degraded = int(impact?.postes_degrades || 0);
    const impacted = Array.isArray(impact?.postes_impactes) ? impact.postes_impactes.length : 0;
    return `
      <div class="sim-result-impact-legend">
        <span class="is-good">â†‘ AmÃ©liorÃ© (${esc(improved)})</span>
        <span>â€“ Stable (0)</span>
        <span class="is-bad">â†“ DÃ©gradÃ© (${esc(degraded)})</span>
        <span class="is-blue">â€¢ ImpactÃ© (${esc(impacted)})</span>
      </div>`;
  }

  function simPdfIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 14h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  }

  function simEyeIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
  }

  function simTrashIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  async function simApiBlob(url) {
    const headers = new Headers();
    headers.set("Accept", "application/pdf");
    try {
      if (window.PortalAuthCommon && typeof window.PortalAuthCommon.getSession === "function") {
        const session = await window.PortalAuthCommon.getSession();
        const token = session?.access_token ? String(session.access_token) : "";
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
    } catch (_) {}

    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      let detail = "";
      if (ct.includes("application/json")) {
        try {
          const js = await res.json();
          detail = js?.detail || js?.message || JSON.stringify(js);
        } catch (_) { detail = ""; }
      } else {
        try { detail = await res.text(); } catch (_) { detail = ""; }
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return await res.blob();
  }

  function buildSimCompetenceFichePdfUrl(compKey) {
    const key = String(compKey || "").trim();
    if (!_portal?.contactId || !_portal?.apiBase || !key) return "";
    const qs = new URLSearchParams();
    qs.set("_", String(Date.now()));
    return `${_portal.apiBase}/skills/analyse/competences/fiche_pdf/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(key)}?${qs.toString()}`;
  }

  async function openSimCompetenceFichePdf(compKey) {
    const url = buildSimCompetenceFichePdfUrl(compKey);
    if (!url) return setStatus("Impossible de retrouver la fiche compÃ©tence Ã  exporter.", "error");
    const win = window.open("about:blank", "_blank");
    if (!win) return setStatus("Le navigateur a bloquÃ© lâ€™ouverture du PDF. Autorisez les fenÃªtres pour Novoskill puis rÃ©essayez.", "error");
    try {
      win.document.write("<p style='font-family: var(--ns-font-ui);padding:20px;'>GÃ©nÃ©ration du documentâ€¦</p>");
      const blob = await simApiBlob(url);
      const blobUrl = URL.createObjectURL(blob);
      win.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      try {
        win.document.body.innerHTML = `<pre style="font-family: var(--ns-font-ui);white-space:pre-wrap;padding:20px;color:#991b1b;">Erreur gÃ©nÃ©ration document : ${esc(errMsg(e))}</pre>`;
      } catch (_) {}
      setStatus(errMsg(e), "error");
    }
  }

  function needPriorityLabel(n, idx) {
    const lecture = String(n?.lecture || "").toLowerCase();
    const pct = Number(n?.couverture_pct || 0);
    if (idx === 0 || pct < 50 || lecture.includes("prior")) return "Prioritaire";
    if (pct < 75 || lecture.includes("Ã©cart") || lecture.includes("renforcer")) return "Ã€ consolider";
    return "Ã€ vÃ©rifier";
  }

  function renderDevelopmentNeedsCompact(result) {
    const needs = result?.developpement?.besoins_formation || [];
    if (!needs.length) return `<div class="sim-empty-state">Aucun besoin complÃ©mentaire de montÃ©e en compÃ©tence dÃ©tectÃ© sur ce scÃ©nario.</div>`;
    const groups = new Map();
    needs.forEach(n => {
      const name = n.nom_complet || "Collaborateur";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(n);
    });
    return `
      <div class="sim-result-needs-accordion-list">
        ${Array.from(groups.entries()).map(([name, rows], groupIdx) => `
          <details class="sim-result-needs-accordion" ${groupIdx === 0 ? "open" : ""}>
            <summary>
              <span>${esc(name)} - ${esc(rows.length)} besoin${rows.length > 1 ? "s" : ""} identifiÃ©${rows.length > 1 ? "s" : ""}</span>
              <b>${rows.length}</b>
            </summary>
            <div class="sim-result-needs-accordion-body">
              ${rows.map((n, idx) => {
                const compKey = n.id_comp || n.id_competence || n.code || "";
                const priority = needPriorityLabel(n, idx);
                return `
                  <div class="sim-result-need-line">
                    <div class="sim-result-need-line-main">
                      <span class="sb-badge sb-badge-ref-comp-code">${esc(n.code || "â€”")}</span>
                      <span>${esc(n.intitule || "CompÃ©tence Ã  renforcer")}</span>
                    </div>
                    <div class="sim-result-need-line-actions">
                      <span class="sim-result-priority-badge ${priority === "Prioritaire" ? "is-priority" : ""}">${esc(priority)}</span>
                      ${compKey ? `<button type="button" class="sb-icon-btn sb-icon-btn--doc" data-sim-need-comp-pdf="${esc(compKey)}" title="Voir la fiche compÃ©tence PDF" aria-label="Voir la fiche compÃ©tence PDF">${simPdfIconSvg()}</button>` : ""}
                    </div>
                  </div>`;
              }).join("")}
            </div>
          </details>`).join("")}
      </div>`;
  }

  function renderResult(result) {
    ensureResultVisualStyles();
    const root = byId("simResultContainer");
    if (!root) return;
    if (!result) {
      root.innerHTML = `<div class="card"><div class="card-title">RÃ©sultat du scÃ©nario</div><div class="card-sub sim2-muted-top">Construisez un scÃ©nario puis lancez le calcul.</div></div>`;
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
    const focus = result?.poste_focus || null;
    const focusBefore = focus ? int(focus.fragilite_avant) : int(current.fragilite_moyenne);
    const focusImmediate = focus ? int(focus.fragilite_immediate) : int(imSummary.fragilite_moyenne);
    const focusProjected = focus ? int(focus.fragilite_projete) : int(finalSummary.fragilite_moyenne);
    const focusDelta = focusProjected - focusBefore;
    const focusCode = focus ? (focus.codif_client || focus.codif_poste || "") : "";
    const narrative = buildResultNarrative(result, current, immediat, projete, finalSummary, finalImpact, hasProjected, needs);
    const improvedCount = int(finalImpact.postes_securises || 0);
    const degradedCount = int(finalImpact.postes_degrades || 0);
    const impactedCount = Array.isArray(finalImpact.postes_impactes) ? finalImpact.postes_impactes.length : 0;
    const savedId = result.id_scenario || _lastSavedScenario?.id_scenario || "";
    const saveLabel = savedId ? "EnregistrÃ©" : "Conserver";

    const immediateRows = [
      simResultBarLine(focus ? `Poste Ã©tudiÃ© (${focusCode || "â€”"})` : "Poste Ã©tudiÃ©", focusBefore, focusImmediate),
      simResultBarLine("PÃ©rimÃ¨tre global", current.fragilite_moyenne, imSummary.fragilite_moyenne),
    ];
    const projectedRows = [
      simResultBarLine(focus ? `Poste Ã©tudiÃ© (${focusCode || "â€”"})` : "Poste Ã©tudiÃ©", focusBefore, focusProjected),
      simResultBarLine("PÃ©rimÃ¨tre global", current.fragilite_moyenne, prSummary.fragilite_moyenne),
    ];

    root.innerHTML = `
      <div class="card sim-result-decision ${trendClass(focusDelta, true)}">
        <div class="sim-result-decision-top">
          <div class="sim-result-decision-titleline">
            <span class="sim-result-star">âœ§</span>
            <div>
              <div class="sim-result-label">RÃ©sultat du scÃ©nario</div>
              <div class="sim-result-title">${esc(narrative.title)}</div>
              <div class="sim-result-sub">${esc(narrative.summary)}</div>
            </div>
          </div>
          <div class="sb-actions sb-actions--end sim-result-actions">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimBackBuild">Modifier</button>
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimShowSetup">HypothÃ¨ses et rÃ©glages</button>
            <button type="button" class="sb-btn ${savedId ? "sb-btn--soft" : "sb-btn--accent"}" id="btnSimSaveScenario">${esc(saveLabel)}</button>
            <button type="button" class="sb-btn sb-btn--accent" id="btnSimAddComparator">Ajouter au comparateur</button>
          </div>
        </div>
        <div class="sim-result-decision-grid">
          ${simResultFocusCard(result, current, finalSummary)}
          ${simResultGaugeCard("FragilitÃ© moyenne du pÃ©rimÃ¨tre", current.fragilite_moyenne, finalSummary.fragilite_moyenne)}
          ${simResultCountCard("Postes impactÃ©s", `${improvedCount} amÃ©liorÃ©${improvedCount > 1 ? "s" : ""}`, `${degradedCount} dÃ©gradÃ©${degradedCount > 1 ? "s" : ""} Â· ${impactedCount} impactÃ©${impactedCount > 1 ? "s" : ""}`, "â˜‘", degradedCount > 0 ? "is-watch" : "is-good")}
          ${simResultCountCard("Besoins gÃ©nÃ©rÃ©s", `${needs.length}`, hasProjected ? "Issus des projections ou mobilitÃ©s du scÃ©nario." : "Aucun besoin projetÃ© dans ce scÃ©nario.", "â—‡", needs.length ? "is-violet" : "is-good")}
        </div>
      </div>

      <div class="sim-result-two-col" style="margin-top:12px;">
        <div class="card sim-result-readable-card sim-result-rh-card">
          <div class="card-title sim-result-section-title">Commentaires Novoskill</div>
          <div class="sim-result-rh-callout is-positive">
            ${simResultMiniIcon("ðŸ‘", "is-green")}
            <div><strong>Analyse Novoskill</strong><p>${esc(narrative.rh)}</p></div>
          </div>
          <div class="sim-result-rh-callout is-warning">
            ${simResultMiniIcon("âš ", "is-orange")}
            <div><strong>Points de vigilance</strong><p>${esc(narrative.vigilance.join(" "))}</p></div>
          </div>
        </div>

        <div class="card sim-result-readable-card sim-result-effects-card">
          <div class="card-title sim-result-section-title">Effets du scÃ©nario</div>
          <div class="sim-result-effects-grid">
            ${simResultEffectPanel("Impact immÃ©diat", "AprÃ¨s application directe des hypothÃ¨ses", "â—·", immediateRows)}
            ${simResultEffectPanel("AprÃ¨s traitement des besoins", hasProjected ? "AprÃ¨s montÃ©e en compÃ©tence ou besoins couverts" : "Aucune projection activÃ©e", "â†—", projectedRows)}
          </div>
        </div>
      </div>

      <div class="sim-result-two-col sim-result-impact-row-main" style="margin-top:12px;">
        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">Postes impactÃ©s</div>
          <div class="sim-result-impact-modern-list">${simResultImpactCards(finalImpact.postes_impactes || imImpact.postes_impactes || [], 3, "poste")}</div>
          ${simResultImpactLegend(finalImpact)}
        </div>
        <div class="card sim-result-readable-card">
          <div class="card-title sim-result-section-title">Services concernÃ©s</div>
          <div class="sim-result-impact-modern-list">${simResultImpactCards(finalImpact.services_impactes || imImpact.services_impactes || [], 3, "service")}</div>
        </div>
      </div>

      <div class="card sim-result-readable-card sim-result-needs-card" style="margin-top:12px;">
        <div class="sim-result-needs-head">
          <div>
            <div class="card-title sim-result-section-title">Besoins Ã  traiter</div>
            <div class="card-sub sim2-muted-top">Vous pouvez traiter ces besoins dans le menu â€œBesoins & formationsâ€.</div>
          </div>
        </div>
        ${renderDevelopmentNeedsCompact(result)}
      </div>

      <details class="sim2-details sim-result-technical">
        <summary>DÃ©tail technique</summary>
        <div class="sim2-detail-body">
          <div class="sim-result-detail-title">Cotation et donnÃ©es complÃ©mentaires</div>
          <div class="card-sub" style="margin:0 0 8px 0;">${esc((result.conseil?.impact_cotation || "Cotation conventionnelle Ã  vÃ©rifier si le scÃ©nario modifie les responsabilitÃ©s ou la classification.").replace(/Studio/g, "cotation conventionnelle"))}</div>
          ${(result.cotation?.postes_non_cotes || []).length ? `<div class="sim-empty-state">Postes sans cotation conventionnelle : ${(result.cotation.postes_non_cotes || []).map(p => esc(p.codif_poste ? p.codif_poste + " Â· " + p.intitule_poste : p.intitule_poste)).join(", ")}</div>` : `<div class="sim-empty-state">Aucune alerte de cotation conventionnelle remontÃ©e.</div>`}
        </div>
      </details>
    `;

    byId("btnSimBackBuild")?.addEventListener("click", () => switchTab("build"));
    byId("btnSimShowSetup")?.addEventListener("click", () => openScenarioSetupModal(result));
    byId("btnSimSaveScenario")?.addEventListener("click", () => openSaveScenarioModal("save"));
    byId("btnSimAddComparator")?.addEventListener("click", () => addCurrentResultToComparator().catch(e => setStatus(errMsg(e), "error")));
    root.querySelectorAll("[data-sim-need-comp-pdf]").forEach(btn => btn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const compKey = btn.getAttribute("data-sim-need-comp-pdf") || "";
      if (compKey) openSimCompetenceFichePdf(compKey);
    }));
  }

  function suggestedScenarioTitle() {
    const focus = _lastResult?.poste_focus || {};
    const code = focus.codif_client || focus.codif_poste || posteCode(posteById(_selectedPosteId));
    const title = focus.intitule_poste || posteTitle(posteById(_selectedPosteId));
    if (code && title) return `SÃ©curisation ${code} - ${title}`;
    if (title) return `ScÃ©nario RH - ${title}`;
    return "ScÃ©nario RH Ã  comparer";
  }

  function fmtDateTime(v) {
    if (!v) return "Date non renseignÃ©e";
    try {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) + " Â· " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return String(v).slice(0, 16);
    }
  }

  function resultScenarioId(result) {
    return result?.id_scenario || _lastSavedScenario?.id_scenario || "";
  }

  function compareStorageRaw() {
    const raw = readJson(STORE_COMPARE, []);
    return Array.isArray(raw) ? raw : [];
  }

  function readCompareIds() {
    const ids = compareStorageRaw()
      .map(x => typeof x === "string" ? x : (x?.id || x?.id_scenario || x?.result?.id_scenario || ""))
      .map(x => String(x || "").trim())
      .filter(Boolean);
    return Array.from(new Set(ids)).slice(0, 4);
  }

  function writeCompareIds(ids) {
    const nextIds = Array.from(new Set((ids || []).map(x => String(x || "").trim()).filter(Boolean))).slice(0, 4);
    const nextKey = nextIds.join("|");
    if (nextKey !== _compareAnalysisIds) {
      _compareAnalysis = null;
      _compareAnalysisIds = "";
    }
    _compareIds = nextIds;
    writeJson(STORE_COMPARE, _compareIds);
    updateCompareCount();
    renderHistorySelectionState();
    renderCompare();
  }

  function updateCompareCount() {
    const count = readCompareIds().length;
    const el = byId("simCompareCount");
    if (el) el.textContent = String(count);
    const btn = byId("btnSimHistoryCompare");
    if (btn) {
      btn.textContent = "Comparer";
      btn.disabled = count < 2;
      btn.title = count < 2 ? "SÃ©lectionnez au moins deux scÃ©narios." : "Comparer les scÃ©narios sÃ©lectionnÃ©s.";
    }
  }

  function ensureIdInComparator(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    const ids = readCompareIds();
    if (!ids.includes(sid)) ids.push(sid);
    writeCompareIds(ids);
  }

  function removeIdFromComparator(id) {
    const sid = String(id || "").trim();
    writeCompareIds(readCompareIds().filter(x => x !== sid));
  }

  function ensureSaveScenarioModal() {
    let modal = byId("modalSimSaveScenario");
    if (modal) return modal;
    const html = `
      <div class="modal" id="modalSimSaveScenario" aria-hidden="true">
        <div class="modal-card sim-save-modal-card">
          <div class="modal-header">
            <div class="modal-title-inline">
              <span id="simSaveScenarioModalTitle" style="font-weight: var(--ns-weight-bold);">Conserver le scÃ©nario</span>
            </div>
            <button type="button" class="modal-x" id="btnCloseSimSaveScenario" aria-label="Fermer">Ã—</button>
          </div>
          <div class="modal-body">
            <div class="card-sub" style="margin:0 0 8px 0;">Nom du scÃ©nario</div>
            <textarea id="simSaveScenarioTitle" class="sb-ctrl" rows="3" placeholder="Nom du scÃ©nario..."></textarea>
            <div id="simSaveScenarioStatus" class="sb-hint" style="display:none;"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--soft" id="btnCancelSimSaveScenario">Annuler</button>
            <button type="button" class="sb-btn sb-btn--accent" id="btnConfirmSimSaveScenario">Conserver</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalSimSaveScenario");
    const close = () => closeSaveScenarioModal();
    byId("btnCloseSimSaveScenario")?.addEventListener("click", close);
    byId("btnCancelSimSaveScenario")?.addEventListener("click", close);
    byId("btnConfirmSimSaveScenario")?.addEventListener("click", confirmSaveScenario);
    modal?.addEventListener("click", ev => { if (ev.target === modal) close(); });
    return modal;
  }

  function closeSaveScenarioModal() {
    const modal = byId("modalSimSaveScenario");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function setSaveScenarioStatus(message, type) {
    const el = byId("simSaveScenarioStatus");
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

  function openSaveScenarioModal(intent = "save") {
    if (!_lastResult) return;
    const existing = resultScenarioId(_lastResult);
    if (existing && intent !== "compare") {
      setStatus("Ce scÃ©nario est dÃ©jÃ  enregistrÃ©.");
      return;
    }
    _saveIntent = intent || "save";
    const modal = ensureSaveScenarioModal();
    const input = byId("simSaveScenarioTitle");
    const title = byId("simSaveScenarioModalTitle");
    const confirm = byId("btnConfirmSimSaveScenario");
    if (title) title.textContent = _saveIntent === "compare" ? "Enregistrer et ajouter au comparateur" : "Conserver le scÃ©nario";
    if (confirm) confirm.textContent = _saveIntent === "compare" ? "Enregistrer et ajouter" : "Conserver";
    if (input) {
      input.value = _lastResult.titre_nom || _lastResult.titre || suggestedScenarioTitle();
      setTimeout(() => input.focus(), 30);
    }
    setSaveScenarioStatus("");
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  async function saveScenarioToDatabase(title) {
    if (!_portal?.contactId || !_lastResult) return null;
    const existing = resultScenarioId(_lastResult);
    if (existing) return _lastSavedScenario || { id_scenario: existing, titre: title || _lastResult.titre || suggestedScenarioTitle() };
    return await _portal.apiJson(apiUrl(`/skills/simulations/scenarios/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
      criticite_min: getCriticiteMin(),
    }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        titre: title,
        objectif: _lastResult.objectif || "Tester une organisation RH composÃ©e de plusieurs hypothÃ¨ses.",
        id_poste_focus: _lastResult.poste_focus?.id_poste || _selectedPosteId || null,
        hypotheses: _lastResult.hypotheses || buildPayload().hypotheses,
        resultat: _lastResult,
      }),
    });
  }

  async function confirmSaveScenario() {
    if (!_lastResult) return;
    const input = byId("simSaveScenarioTitle");
    const title = (input?.value || "").trim() || suggestedScenarioTitle();
    const btn = byId("btnConfirmSimSaveScenario");
    if (btn) btn.disabled = true;
    setSaveScenarioStatus(_saveIntent === "compare" ? "Enregistrement et ajout au comparateurâ€¦" : "Enregistrement du scÃ©narioâ€¦");
    try {
      const saved = await saveScenarioToDatabase(title);
      _lastSavedScenario = saved || null;
      const sid = saved?.id_scenario || _lastResult.id_scenario || null;
      _lastResult = { ..._lastResult, titre: title, titre_nom: title, id_scenario: sid };
      if (sid) _historyDetailCache.set(sid, { id_scenario: sid, titre: title, resultat_json: _lastResult, hypotheses_json: _lastResult.hypotheses || buildPayload().hypotheses });
      closeSaveScenarioModal();
      setStatus(_saveIntent === "compare" ? "ScÃ©nario enregistrÃ© et ajoutÃ© au comparateur." : "ScÃ©nario enregistrÃ©.");
      _historyLoaded = false;
      if (_saveIntent === "compare" && sid) {
        ensureIdInComparator(sid);
        switchTab("history");
      } else {
        renderResult(_lastResult);
      }
    } catch (e) {
      setSaveScenarioStatus(errMsg(e), "error");
    } finally {
      if (btn) btn.disabled = false;
      _saveIntent = "save";
    }
  }

  async function addCurrentResultToComparator() {
    if (!_lastResult) return;
    const sid = resultScenarioId(_lastResult);
    if (sid) {
      ensureIdInComparator(sid);
      setStatus("ScÃ©nario ajoutÃ© au comparateur.");
      switchTab("history");
      return;
    }
    openSaveScenarioModal("compare");
  }

  function setupValue(label, value) {
    return `<div class="sim-setup-kv"><span>${esc(label)}</span><strong>${esc(value || "â€”")}</strong></div>`;
  }

  function scenarioHypothesesHtml(hypotheses) {
    const rows = Array.isArray(hypotheses) ? hypotheses : [];
    if (!rows.length) return `<div class="sim-empty-state">Aucune hypothÃ¨se conservÃ©e avec ce scÃ©nario.</div>`;
    return `<div class="sim-setup-hyp-list">${rows.map((h, idx) => `
      <div class="sim-setup-hyp-row">
        <div class="sim-setup-hyp-index">${esc(idx + 1)}</div>
        <div>
          <div class="sim-impact-title">${esc(brickKind(h))}</div>
          <div class="card-sub" style="margin-top:3px;">${esc(h.libelle || brickSummary(h))}</div>
        </div>
      </div>`).join("")}</div>`;
  }

  function ensureScenarioSetupModal() {
    let modal = byId("modalSimScenarioSetup");
    if (modal) return modal;
    const html = `
      <div class="modal" id="modalSimScenarioSetup" aria-hidden="true">
        <div class="modal-card modal-card--medium">
          <div class="modal-header">
            <div class="modal-title-inline"><span style="font-weight: var(--ns-weight-bold);">HypothÃ¨ses et rÃ©glages</span></div>
            <button type="button" class="modal-x" id="btnCloseSimScenarioSetup" aria-label="Fermer">Ã—</button>
          </div>
          <div class="modal-body" id="simScenarioSetupBody"></div>
          <div class="modal-footer">
            <button type="button" class="sb-btn sb-btn--soft" id="btnSimScenarioSetupClose">Fermer</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    modal = byId("modalSimScenarioSetup");
    const close = () => closeScenarioSetupModal();
    byId("btnCloseSimScenarioSetup")?.addEventListener("click", close);
    byId("btnSimScenarioSetupClose")?.addEventListener("click", close);
    modal?.addEventListener("click", ev => { if (ev.target === modal) close(); });
    return modal;
  }

  function closeScenarioSetupModal() {
    const modal = byId("modalSimScenarioSetup");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  function openScenarioSetupModal(result) {
    const modal = ensureScenarioSetupModal();
    const body = byId("simScenarioSetupBody");
    const r = result || _lastResult || {};
    const focus = r.poste_focus || posteById(_selectedPosteId) || {};
    const code = focus.codif_client || focus.codif_poste || posteCode(focus);
    const scope = r.scope || {};
    const crit = r.reference_calcul?.criticite_min ?? r.criticite_min ?? getCriticiteMin();
    const hypotheses = r.hypotheses || _scenario || [];
    if (body) {
      body.innerHTML = `
        <div class="sim-setup-grid">
          ${setupValue("Poste Ã©tudiÃ©", `${code ? code + " Â· " : ""}${focus.intitule_poste || posteTitle(focus)}`)}
          ${setupValue("PÃ©rimÃ¨tre", scope.nom_service || "Tous les services")}
          ${setupValue("CriticitÃ© minimale", `${crit}%`)}
          ${setupValue("HypothÃ¨ses", `${hypotheses.length}`)}
        </div>
        <div class="sim-setup-section-title">HypothÃ¨ses utilisÃ©es</div>
        ${scenarioHypothesesHtml(hypotheses)}
      `;
    }
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  async function fetchHistoryScenarios(force = false) {
    if (_historyLoaded && !force) return _historyItems;
    if (!_portal?.contactId) return [];
    const data = await _portal.apiJson(apiUrl(`/skills/simulations/scenarios/${encodeURIComponent(_portal.contactId)}`, {
      id_service: getServiceId(),
    }));
    _historyItems = Array.isArray(data?.items) ? data.items : [];
    _historyLoaded = true;
    return _historyItems;
  }

  async function fetchScenarioDetail(id) {
    const sid = String(id || "").trim();
    if (!sid) return null;
    if (_historyDetailCache.has(sid)) return _historyDetailCache.get(sid);
    const data = await _portal.apiJson(apiUrl(`/skills/simulations/scenarios/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(sid)}`, {}));
    _historyDetailCache.set(sid, data);
    return data;
  }

  function scenarioPosteLabelFromItem(item) {
    const p = item?.poste_focus || {};
    const code = p.codif_client || p.codif_poste || "";
    return `${code ? code + " Â· " : ""}${p.intitule_poste || "Poste non renseignÃ©"}`;
  }

  function signedPercent(v) {
    const n = int(v);
    if (n === 0) return "0%";
    return `${n > 0 ? "+" : ""}${n}%`;
  }

  function scenarioMetricsFromResult(result) {
    const r = result || {};
    const focus = r.poste_focus || {};
    const resultats = r.resultats || {};
    const finalSummary = resultats.projete?.summary || resultats.immediat?.summary || r.simule || {};
    const current = r.actuel || {};
    const beforePoste = int(focus.fragilite_avant ?? current.fragilite_moyenne ?? 0);
    const afterPoste = int(focus.fragilite_projete ?? finalSummary.fragilite_moyenne ?? beforePoste);
    const beforeGlobal = int(current.fragilite_moyenne ?? 0);
    const afterGlobal = int(finalSummary.fragilite_moyenne ?? beforeGlobal);
    const needs = Array.isArray(r.developpement?.besoins_formation) ? r.developpement.besoins_formation.length : 0;
    const impact = resultats.projete?.impact || r.impact || {};
    return {
      impactPoste: afterPoste - beforePoste,
      impactGlobal: afterGlobal - beforeGlobal,
      besoins: needs,
      postesAmeliores: int(impact.postes_securises || 0),
      postesDegrades: int(impact.postes_degrades || 0),
    };
  }

  function scenarioMetricsFromItem(item) {
    const resume = item?.resume || {};
    if (Object.prototype.hasOwnProperty.call(resume, "impact_poste_pct")) {
      return {
        impactPoste: int(resume.impact_poste_pct),
        impactGlobal: int(resume.impact_global_pct),
        besoins: int(resume.besoins_count),
        postesAmeliores: int(resume.postes_securises),
        postesDegrades: int(resume.postes_degrades),
      };
    }
    return scenarioMetricsFromResult(item?.resultat_json || item?.result || {});
  }

  function simMetricChip(label, value, toneInverse = true) {
    const n = int(value);
    const tone = trendClass(n, toneInverse);
    return `<span class="sim-history-metric ${tone}"><small>${esc(label)}</small><strong>${esc(signedPercent(n))}</strong></span>`;
  }

  function renderHistorySelectionState() {
    const ids = readCompareIds();
    document.querySelectorAll("[data-sim-history-check]").forEach(input => {
      const id = input.getAttribute("data-sim-history-check") || "";
      input.checked = ids.includes(id);
      input.closest(".sim-history-row-card")?.classList.toggle("is-selected", input.checked);
    });
    updateCompareCount();
  }

  function historyRowHtml(item) {
    const id = item.id_scenario || "";
    const p = item.poste_focus || {};
    const code = p.codif_client || p.codif_poste || "";
    const service = item.scope?.nom_service || "Tous les services";
    const m = scenarioMetricsFromItem(item);
    return `
      <div class="sim-history-row-card">
        <label class="sim-history-check" title="Ajouter au comparateur">
          <input type="checkbox" data-sim-history-check="${esc(id)}" aria-label="Ajouter au comparateur">
          <span>Comparer</span>
        </label>
        <div class="sim-history-main">
          <div class="sim-history-title">${esc(item.titre || "ScÃ©nario RH")}</div>
          <div class="card-sub" style="margin-top:3px;">${esc(fmtDateTime(item.created_at))}</div>
        </div>
        <div class="sim-history-poste">
          ${code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : ""}
          <div><strong>${esc(p.intitule_poste || "Poste non renseignÃ©")}</strong><small>${esc(service)}</small></div>
        </div>
        <div class="sim-history-metrics">
          ${simMetricChip("Impact poste", m.impactPoste)}
          ${simMetricChip("Impact global", m.impactGlobal)}
          <span class="sim-history-metric is-violet"><small>Besoins</small><strong>${esc(m.besoins)}</strong></span>
        </div>
        <div class="sim-history-actions">
          <button type="button" class="sb-icon-btn" data-sim-history-open="${esc(id)}" title="Voir le rÃ©sultat" aria-label="Voir le rÃ©sultat">${simEyeIconSvg()}</button>
          <button type="button" class="sb-icon-btn sb-icon-btn--danger" data-sim-history-delete="${esc(id)}" title="Supprimer le scÃ©nario" aria-label="Supprimer le scÃ©nario">${simTrashIconSvg()}</button>
        </div>
      </div>`;
  }

  async function deleteScenarioFromHistory(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    const item = _historyItems.find(x => String(x.id_scenario || "") === sid) || {};
    const title = item.titre || "ce scÃ©nario";
    if (!window.confirm(`Supprimer ${title} de lâ€™historique ?`)) return;
    await _portal.apiJson(apiUrl(`/skills/simulations/scenarios/${encodeURIComponent(_portal.contactId)}/${encodeURIComponent(sid)}`, {}), { method: "DELETE" });
    removeIdFromComparator(sid);
    _historyDetailCache.delete(sid);
    _historyLoaded = false;
    setStatus("ScÃ©nario supprimÃ© de lâ€™historique.");
    await renderHistory(true);
  }

  async function renderHistory(force = false) {
    const root = byId("simHistoryContainer");
    if (!root) return;
    root.innerHTML = `<div class="card"><div class="sim-empty-state">Chargement de lâ€™historiqueâ€¦</div></div>`;
    try {
      const items = await fetchHistoryScenarios(force);
      if (!items.length) {
        root.innerHTML = `<div class="card"><div class="sim-empty-state">Aucun scÃ©nario enregistrÃ© pour le moment.</div></div>`;
        renderCompare();
        return;
      }
      root.innerHTML = `
        <div class="sim-history-list">
          ${items.map(historyRowHtml).join("")}
        </div>`;
      root.querySelectorAll("[data-sim-history-open]").forEach(btn => btn.addEventListener("click", () => openScenarioFromHistory(btn.getAttribute("data-sim-history-open") || "").catch(e => setStatus(errMsg(e), "error"))));
      root.querySelectorAll("[data-sim-history-delete]").forEach(btn => btn.addEventListener("click", () => deleteScenarioFromHistory(btn.getAttribute("data-sim-history-delete") || "").catch(e => setStatus(errMsg(e), "error"))));
      root.querySelectorAll("[data-sim-history-check]").forEach(input => input.addEventListener("change", () => {
        const id = input.getAttribute("data-sim-history-check") || "";
        if (input.checked) ensureIdInComparator(id);
        else removeIdFromComparator(id);
      }));
      renderHistorySelectionState();
      renderCompare();
    } catch (e) {
      root.innerHTML = `<div class="card"><div class="sim-empty-state">Impossible de charger lâ€™historique : ${esc(errMsg(e))}</div></div>`;
    }
  }

  async function openScenarioFromHistory(id) {
    const data = await fetchScenarioDetail(id);
    if (!data) return;
    const result = data.resultat_json || {};
    _lastResult = {
      ...result,
      id_scenario: data.id_scenario,
      titre: data.titre || result.titre,
      titre_nom: data.titre || result.titre_nom,
      hypotheses: data.hypotheses_json || result.hypotheses || [],
      criticite_min: data.criticite_min,
    };
    _lastSavedScenario = { id_scenario: data.id_scenario, titre: data.titre || result.titre || "ScÃ©nario RH" };
    _scenario = Array.isArray(data.hypotheses_json) ? data.hypotheses_json : (_lastResult.hypotheses || []);
    _selectedPosteId = data.id_poste_focus || result.poste_focus?.id_poste || _selectedPosteId;
    renderResult(_lastResult);
    switchTab("result");
  }

  async function selectedComparatorDetails() {
    const ids = readCompareIds();
    const details = await Promise.all(ids.map(id => fetchScenarioDetail(id).catch(() => null)));
    return details.filter(Boolean);
  }

  function hypothesisCompactHtml(detail) {
    const hyps = Array.isArray(detail?.hypotheses_json) ? detail.hypotheses_json : [];
    if (!hyps.length) return `<span class="sim-compare-hyp-empty">Aucune hypothÃ¨se dÃ©taillÃ©e</span>`;
    return `
      <div class="sim-compare-hyp-list">
        ${hyps.slice(0, 3).map(h => `<span>${esc(brickKind(h))}</span>`).join("")}
        ${hyps.length > 3 ? `<span>+${esc(hyps.length - 3)}</span>` : ""}
      </div>`;
  }

  function compareCardHtml(detail) {
    const r = detail?.resultat_json || detail?.result || {};
    const focus = r.poste_focus || {};
    const m = scenarioMetricsFromResult(r);
    const title = detail?.titre || r.titre || "ScÃ©nario RH";
    const code = focus.codif_client || focus.codif_poste || "";
    const poste = focus.intitule_poste || "Poste Ã©tudiÃ©";
    return `
      <div class="sim-compare-tile ${trendClass(m.impactPoste, true)}">
        <div class="sim-compare-tile-head">
          <div class="sim-compare-tile-title">${esc(title)}</div>
          <button type="button" class="sb-icon-btn" data-remove-compare="${esc(detail.id_scenario)}" title="Retirer du comparateur" aria-label="Retirer du comparateur">Ã—</button>
        </div>
        <div class="sim-compare-poste-line">
          ${code ? `<span class="sb-badge sb-badge-ref-poste-code">${esc(code)}</span>` : ""}
          <span>${esc(poste)}</span>
        </div>
        <div class="sim-compare-section-label">HypothÃ¨ses</div>
        ${hypothesisCompactHtml(detail)}
        <div class="sim-compare-results-box">
          <div><span>Impact poste</span><strong class="${trendClass(m.impactPoste, true)}">${esc(signedPercent(m.impactPoste))}</strong></div>
          <div><span>Impact global</span><strong class="${trendClass(m.impactGlobal, true)}">${esc(signedPercent(m.impactGlobal))}</strong></div>
          <div><span>Besoins</span><strong>${esc(m.besoins)}</strong></div>
        </div>
        <button type="button" class="sb-btn sb-btn--soft sb-btn--xs" data-sim-compare-open="${esc(detail.id_scenario)}">Voir le rÃ©sultat</button>
      </div>`;
  }

  function compareAnalysisHtml() {
    const a = _compareAnalysis;
    if (!a) return `<div id="simCompareAnalysis" class="sim-compare-analysis-slot"></div>`;
    const arbitrages = Array.isArray(a.arbitrages) ? a.arbitrages : [];
    const points = Array.isArray(a.points_vigilance) ? a.points_vigilance : [];
    return `
      <div id="simCompareAnalysis" class="sim-compare-analysis-card">
        <div class="sim-compare-analysis-title">${esc(a.titre || "Analyse comparative Novoskill")}</div>
        <p class="sim-compare-analysis-lead">${esc(a.synthese || "")}</p>
        <div class="sim-compare-analysis-block"><strong>Lecture comparative</strong><p>${esc(a.lecture || "")}</p></div>
        <div class="sim-compare-analysis-block"><strong>ScÃ©nario Ã  privilÃ©gier selon lâ€™objectif</strong><p>${esc(a.scenario_a_privilegier || "")}</p></div>
        ${arbitrages.length ? `<div class="sim-compare-analysis-grid">${arbitrages.map(row => `
          <div><span>${esc(row.objectif || "Objectif")}</span><strong>${esc(row.scenario || "ScÃ©nario")}</strong><p>${esc(row.justification || "")}</p></div>`).join("")}</div>` : ""}
        ${points.length ? `<div class="sim-compare-analysis-block"><strong>Points de vigilance</strong><ul>${points.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${a.prochaine_etape ? `<div class="sim-compare-next">${esc(a.prochaine_etape)}</div>` : ""}
      </div>`;
  }

  async function runCompareAnalysis() {
    const ids = readCompareIds();
    if (ids.length < 2) return setStatus("SÃ©lectionnez au moins deux scÃ©narios Ã  comparer.", "error");
    const slot = byId("simCompareAnalysis");
    if (slot) slot.innerHTML = `<div class="sim-empty-state">GÃ©nÃ©ration de lâ€™analyse comparative Novoskillâ€¦</div>`;
    const btn = byId("btnSimRunCompare");
    if (btn) btn.disabled = true;
    try {
      const data = await _portal.apiJson(apiUrl(`/skills/simulations/scenarios/${encodeURIComponent(_portal.contactId)}/comparer`, {}), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      _compareAnalysis = data?.analyse || null;
      _compareAnalysisIds = ids.join("|");
      setStatus("Analyse comparative gÃ©nÃ©rÃ©e.");
      renderCompare();
    } catch (e) {
      if (slot) slot.innerHTML = `<div class="sim-empty-state">Impossible de gÃ©nÃ©rer lâ€™analyse comparative : ${esc(errMsg(e))}</div>`;
      setStatus(errMsg(e), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderCompare() {
    const historyPanel = document.querySelector('[data-sim-panel="history"]');
    const historyVisible = !!historyPanel && historyPanel.style.display !== "none";
    const root = (historyVisible ? byId("simHistoryCompareContainer") : byId("simCompareContainer")) || byId("simHistoryCompareContainer") || byId("simCompareContainer");
    if (!root) return;
    const ids = readCompareIds();
    const idsKey = ids.join("|");
    updateCompareCount();
    if (!ids.length) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = `<div class="card"><div class="sim-empty-state">Chargement du comparateurâ€¦</div></div>`;
    selectedComparatorDetails().then(details => {
      if (!details.length) {
        root.innerHTML = `<div class="card"><div class="sim-empty-state">Aucun scÃ©nario comparable. SÃ©lectionnez des scÃ©narios enregistrÃ©s dans lâ€™historique.</div></div>`;
        return;
      }
      if (_compareAnalysisIds !== idsKey) _compareAnalysis = null;
      root.innerHTML = `
        <div class="card sim-compare-readable">
          <div class="sim2-hero-layout sim-compare-headline">
            <div>
              <div class="card-title">Comparateur</div>
              <div class="card-sub sim2-muted-top">${details.length} scÃ©nario${details.length > 1 ? "s" : ""} sÃ©lectionnÃ©${details.length > 1 ? "s" : ""}. SÃ©lectionnez 2 Ã  4 scÃ©narios pour gÃ©nÃ©rer une synthÃ¨se comparative.</div>
            </div>
            <div class="sb-actions sb-actions--end">
              <button type="button" class="sb-btn sb-btn--accent" id="btnSimRunCompare" ${details.length < 2 ? "disabled" : ""}>Comparer</button>
              <button type="button" class="sb-btn sb-btn--soft" id="btnSimClearCompareInline">Vider</button>
            </div>
          </div>
          <div class="sim-compare-tiles">${details.map(compareCardHtml).join("")}</div>
          ${compareAnalysisHtml()}
        </div>`;
      root.querySelectorAll("[data-remove-compare]").forEach(btn => btn.addEventListener("click", () => removeIdFromComparator(btn.getAttribute("data-remove-compare") || "")));
      root.querySelectorAll("[data-sim-compare-open]").forEach(btn => btn.addEventListener("click", () => openScenarioFromHistory(btn.getAttribute("data-sim-compare-open") || "").catch(e => setStatus(errMsg(e), "error"))));
      byId("btnSimClearCompareInline")?.addEventListener("click", () => writeCompareIds([]));
      byId("btnSimRunCompare")?.addEventListener("click", () => runCompareAnalysis());
    }).catch(e => {
      root.innerHTML = `<div class="card"><div class="sim-empty-state">Impossible de charger le comparateur : ${esc(errMsg(e))}</div></div>`;
    });
  }

  function switchTab(tab) {
    const wanted = tab || "build";
    document.querySelectorAll(".sim-tab-btn").forEach(btn => {
      const key = btn.getAttribute("data-sim-tab") || "build";
      const active = key === wanted || (wanted === "result" && key === "build") || (wanted === "compare" && key === "history");
      btn.classList.toggle("is-active", active);
    });
    document.querySelectorAll(".sim-panel").forEach(panel => {
      panel.style.display = panel.getAttribute("data-sim-panel") === wanted ? "block" : "none";
    });
    if (wanted === "history") renderHistory(false).catch(e => setStatus(errMsg(e), "error"));
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
    _lastSavedScenario = null;
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
    byId("btnSimHistoryRefresh")?.addEventListener("click", () => { _historyLoaded = false; renderHistory(true).catch(e => setStatus(errMsg(e), "error")); });
    byId("btnSimClearCompare")?.addEventListener("click", () => writeCompareIds([]));
    byId("simCriticiteRange")?.addEventListener("input", e => setCriticiteMin(e.target.value));
    byId("simCriticiteRange")?.addEventListener("change", () => {
      _optionsLoaded = false;
      loadOptions(true, { silent: true }).catch(e => setStatus(errMsg(e), "error"));
    });
    byId("simServiceSelect")?.addEventListener("change", () => {
      _optionsLoaded = false;
      _historyLoaded = false;
      loadOptions(true).catch(e => setStatus(errMsg(e), "error"));
      if (document.querySelector('[data-sim-panel="history"]')?.style.display !== "none") renderHistory(true).catch(e => setStatus(errMsg(e), "error"));
    });
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
