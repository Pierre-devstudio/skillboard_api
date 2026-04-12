(function () {
    let _bound = false;
    let _loaded = false;

    let _services = [];
    let _totaux = { nb_postes: 0, nb_collabs: 0 };
    let _nonLie = { nb_postes: 0, nb_collabs: 0 };

    let _selectedService = "__all__"; // "__all__", "__none__", ou id_service
    let _selectedServiceName = "Tous les services";

    let _posteSearch = "";
    let _posteSearchTimer = null;

    let _catalogSearch = "";
    let _catalogTimer = null;

    let _serviceModalMode = "create"; // create | edit
    let _editingServiceId = null;
    
    let _showArchivedPostes = false;

    let _posteModalMode = "create"; // create | edit
    let _editingPosteId = null;

    // --- Poste > Compétences (Exigences)
    let _posteCompItems = [];
    let _posteCompSearch = "";
    let _posteCompSearchTimer = null;

    let _posteCompAddItems = [];
    let _posteCompAddSearch = "";
    let _posteCompAddTimer = null;
    let _posteCompAddIncludeToValidate = false;

    let _posteCompAddDomain = "";
    let _posteCompAddItemsAll = [];

    let _posteCompEdit = null; // objet en cours d'édition (merge comp + assoc)
    let _posteAiDraftMeta = null;
    let _posteCompAiResults = { existing: [], missing: [] };
    let _posteCompCreateCtx = null;
    let _posteCompCreateDomainsLoaded = false;
    let _posteCompCreateDomainItems = [];
    let _posteCompCreateCrit = null;
    let _posteCompCreateCritEditIdx = null;
    let _iaBusyTimer = null;
    let _iaBusyStartedAt = 0;

    // --- Poste > Certifications (Exigences)
    let _posteCertItems = [];
    let _posteCertSearch = "";
    let _posteCertSearchTimer = null;

    let _posteCertAddItems = [];
    let _posteCertAddItemsAll = [];
    let _posteCertAddSearch = "";
    let _posteCertAddTimer = null;
    let _posteCertAddCategory = "";

    let _posteCertEdit = null; // objet en cours d'édition (merge cert + assoc)

    const POSTE_IMPORT_EXTENSIONS = [".doc", ".docx", ".pdf"];
    const POSTE_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
    let _posteImportFile = null;
    let _posteCcnContext = null;
    let _posteCcnAnalysis = null;   

    function getOwnerId() {
        const forced = (window.__orgScopeOwnerId || "").toString().trim();
        if (forced) return forced;

        const pid = (window.portal && window.portal.contactId) ? String(window.portal.contactId).trim() : "";
        if (pid) return pid;
        return (new URL(window.location.href).searchParams.get("id") || "").trim();
    }

    function getScopeEntId(){
        const forced = (window.__orgScopeEntId || "").toString().trim();
        if (forced) return forced;
        return getOwnerId();
    }

    function appendOrgScope(url){
        const raw = String(url || "");
        if (!raw) return raw;

        const u = new URL(raw, window.location.origin);
        const ownerId = getOwnerId();
        const entId = getScopeEntId();

        if (!entId || entId === ownerId) return u.toString();
        if (u.searchParams.has("id_ent")) return u.toString();

        u.searchParams.set("id_ent", entId);
        return u.toString();
    }

    let _roleCode = (window.__studioRoleCode || "").toString().trim().toLowerCase();

    function isAdmin(){
        return (_roleCode || "user") === "admin";
    }

    async function ensureRole(portal){
        // Si le rôle est déjà connu, on ne refait rien
        if (_roleCode && ["admin","editor","user"].includes(_roleCode)) return;

        const ownerId = getOwnerId();
        if (!ownerId) { _roleCode = "user"; return; }

        try {
            const ctx = await portal.apiJson(`${portal.apiBase}/studio/context/${encodeURIComponent(ownerId)}`);
            const rc = (ctx && ctx.role_code ? String(ctx.role_code) : "user").trim().toLowerCase();
            _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
            window.__studioRoleCode = _roleCode; // synchronise le reste de l’app
        } catch (_) {
            // fallback safe
            const rc = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
            _roleCode = ["admin","editor","user"].includes(rc) ? rc : "user";
        }
    }

    function getOrganisationRoot(){
        return document.querySelector('#view-organisation[data-view="organisation"]');
    }

    function byId(id){
        const root = getOrganisationRoot();
        if (root){
            const el = root.querySelector(`#${id}`);
            if (el) return el;
        }
        return document.getElementById(id);
    }

    function setStatus(msg, isError = false){
        const el = byId("orgStatus");
        if (!el) return;

        const text = String(msg || "").trim();
        if (!text || text === "—") {
            el.textContent = "";
            el.style.display = "none";
            return;
        }

        el.textContent = text;
        el.style.display = "";
        el.style.background = isError ? "#fff1f2" : "#f8fafc";
        el.style.borderColor = isError ? "#fecaca" : "#e5e7eb";
        el.style.color = isError ? "#991b1b" : "#334155";
    }

    function formatOrgDiag(step, extra){
        const payload = Object.assign({
            step,
            ownerId: getOwnerId(),
            scopeEntId: getScopeEntId(),
            selectedService: _selectedService || "__all__"
        }, extra || {});

        const parts = [
            `étape=${payload.step}`,
            `owner=${payload.ownerId || "-"}`,
            `scope=${payload.scopeEntId || "-"}`,
            `service=${payload.selectedService || "-"}`
        ];

        if (payload.url) parts.push(`url=${payload.url}`);
        if (payload.nbServices !== undefined) parts.push(`nbServices=${payload.nbServices}`);
        if (payload.nbPostes !== undefined) parts.push(`nbPostes=${payload.nbPostes}`);
        if (payload.nbPostesNonLies !== undefined) parts.push(`nbPostesNonLies=${payload.nbPostesNonLies}`);
        if (payload.message) parts.push(`message=${payload.message}`);

        return parts.join(" | ");
    }

    function traceOrg(step, extra){
        const line = formatOrgDiag(step, extra);
        console.info("[Organisation]", line, extra || {});
        setStatus(line, false);
    }

    function traceOrgError(step, error, extra){
        const message = error?.message || String(error);
        const line = formatOrgDiag(step, Object.assign({}, extra || {}, { message }));
        console.error("[Organisation]", line, error);
        setStatus(line, true);
    }

    function esc(s){
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    function htmlToPlainText(html){
        const div = document.createElement("div");
        div.innerHTML = String(html || "");
        return (div.textContent || div.innerText || "")
            .replace(/\u00a0/g, " ")
            .replace(/\r/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function openIaBusyOverlay(title, text){
        const ov = byId("iaBusyOverlay");
        const ttl = byId("iaBusyTitle");
        const txt = byId("iaBusyText");
        const sec = byId("iaBusySeconds");
        if (!ov) return;

        if (ttl) ttl.textContent = title || "Analyse IA en cours";
        if (txt) txt.textContent = text || "Traitement en cours...";
        if (sec) sec.textContent = "0";

        _iaBusyStartedAt = Date.now();
        if (_iaBusyTimer) clearInterval(_iaBusyTimer);
        _iaBusyTimer = setInterval(() => {
            const s = Math.max(0, Math.floor((Date.now() - _iaBusyStartedAt) / 1000));
            const el = byId("iaBusySeconds");
            if (el) el.textContent = String(s);
        }, 250);

        ov.style.display = "flex";
    }

    function closeIaBusyOverlay(){
        if (_iaBusyTimer){
            clearInterval(_iaBusyTimer);
            _iaBusyTimer = null;
        }
        const ov = byId("iaBusyOverlay");
        if (ov) ov.style.display = "none";
    }

    function normText(v){
        return String(v || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();
    }

    function argbIntToRgbTuple(v){
        if (v === null || v === undefined) return null;
        let n;
        if (typeof v === "number") n = v;
        else {
            const s = String(v).trim();
            if (!s) return null;
            n = parseInt(s, 10);
            if (Number.isNaN(n)) return null;
        }
        const u = (n >>> 0);
        const r = (u >> 16) & 255;
        const g = (u >> 8) & 255;
        const b = u & 255;
        return { r, g, b, css: `${r},${g},${b}` };
    }

    function calcCritDisplay(fu, im, de){
        const f = Math.max(0, Math.min(10, parseInt(fu ?? 0, 10) || 0));
        const i = Math.max(0, Math.min(10, parseInt(im ?? 0, 10) || 0));
        const d = Math.max(0, Math.min(10, parseInt(de ?? 0, 10) || 0));
        const f20 = f * 2;
        const i50 = i * 5;
        const d30 = d * 3;
        const total = Math.max(0, Math.min(100, f20 + i50 + d30));
        return { f, i, d, f20, i50, d30, total };
    }

    function setPosteCompCritRing(score){
        const ring = byId("posteCompCritRing");
        const prog = byId("posteCompCritRingProg");
        const val = byId("posteCompCritRingVal");
        if (!ring || !prog || !val) return;

        const s = Math.max(0, Math.min(100, parseInt(score ?? 0, 10) || 0));
        val.textContent = String(s);
        prog.setAttribute("stroke-dasharray", `${s} 100`);

        ring.classList.remove("sb-ring--low","sb-ring--mid","sb-ring--high");
        ring.classList.add(s < 35 ? "sb-ring--low" : s < 70 ? "sb-ring--mid" : "sb-ring--high");
    }

    function setPosteCompEditNiv(v){
        const niv = (v || "B").toString().trim().toUpperCase();
        const r = document.querySelector(`input[name="posteCompEditNiv"][value="${niv}"]`);
        if (r) r.checked = true;
        refreshPosteCompNivCards();
    }

    function refreshPosteCompNivCards(){
        document.querySelectorAll("#posteCompNivGrid .sb-level-card").forEach(card => {
            const r = card.querySelector('input[type="radio"]');
            card.classList.toggle("is-selected", !!(r && r.checked));
        });
    }

    function rtGetHtml(id){
        const el = byId(id);
        if (!el) return "";
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") return el.value || "";
        return el.innerHTML || "";
    }

    function rtSetHtml(id, html){
        const el = byId(id);
        if (!el) return;
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") el.value = html || "";
        else el.innerHTML = html || "";
    }

    function bindRichtext(id){
        const ed = byId(id);
        if (!ed) return;

        const wrap = ed.closest(".sb-richtext");
        const bar = wrap ? wrap.querySelector(".sb-richtext-bar") : null;
        if (!bar || bar._sbBound) return;

        bar._sbBound = true;

        // Paste propre (évite le HTML Word/Outlook)
        ed.addEventListener("paste", (e) => {
            try{
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
            document.execCommand("insertText", false, text);
            } catch(_){}
        });

        bar.querySelectorAll("[data-cmd]").forEach(btn => {
            btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            ed.focus();
            const cmd = btn.getAttribute("data-cmd");
            if (!cmd) return;
            document.execCommand(cmd, false, null);
            });
        });
    }

    function openModal(id){
        const el = byId(id);
        if (el) el.style.display = "flex";
    }

    function closeModal(id){
        const el = byId(id);
        if (el) el.style.display = "none";
    }

    function formatFileSize(bytes){
        const n = parseInt(bytes || 0, 10) || 0;
        if (n < 1024) return `${n} o`;
        if (n < (1024 * 1024)) return `${(n / 1024).toFixed(1)} Ko`;
        return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
    }

    function getPosteImportExt(filename){
        const s = String(filename || "").trim().toLowerCase();
        const i = s.lastIndexOf(".");
        return i >= 0 ? s.slice(i) : "";
    }

    function resetPosteImportState(){
        _posteImportFile = null;

        const input = byId("posteImportFileInput");
        const card = byId("posteImportFileCard");
        const name = byId("posteImportFileName");
        const meta = byId("posteImportFileMeta");
        const empty = byId("posteImportEmpty");
        const analyze = byId("btnPosteImportAnalyze");
        const change = byId("btnPosteImportChange");
        const drop = byId("posteImportDropzone");

        if (input) input.value = "";
        if (card) card.style.display = "none";
        if (name) name.textContent = "—";
        if (meta) meta.textContent = "—";
        if (empty) empty.textContent = "Aucun document sélectionné.";
        if (analyze){
            analyze.disabled = true;
            analyze.style.opacity = ".6";
        }
        if (change){
            change.disabled = true;
            change.style.opacity = ".6";
        }
        if (drop) drop.classList.remove("is-drag");
    }

    function refreshPosteImportButton(){
        const btn = byId("btnPosteImport");
        if (!btn) return;
        btn.style.display = (_posteModalMode === "create") ? "" : "none";
    }

    function refreshPosteFooterActions(){
        const isCreate = (_posteModalMode === "create");

        const bA = byId("btnPosteArchive");
        const bD = byId("btnPosteDuplicate");

        if (bA){
            bA.style.display = isCreate ? "none" : "";
            bA.disabled = isCreate;
            bA.style.opacity = isCreate ? ".6" : "";
            bA.title = "";
            if (isCreate) bA.textContent = "Archiver";
        }

        if (bD){
            bD.style.display = isCreate ? "none" : "";
            bD.disabled = isCreate;
            bD.style.opacity = isCreate ? ".6" : "";
            bD.title = "";
        }
    }

    function setPosteImportFile(file){
        if (!file) return;

        const ext = getPosteImportExt(file.name || "");
        if (!POSTE_IMPORT_EXTENSIONS.includes(ext)){
            throw new Error("Format non supporté. Utilise un fichier .doc, .docx ou .pdf.");
        }

        if ((file.size || 0) > POSTE_IMPORT_MAX_BYTES){
            throw new Error("Document trop volumineux. Limite : 15 Mo.");
        }

        _posteImportFile = file;

        const card = byId("posteImportFileCard");
        const name = byId("posteImportFileName");
        const meta = byId("posteImportFileMeta");
        const empty = byId("posteImportEmpty");
        const analyze = byId("btnPosteImportAnalyze");
        const change = byId("btnPosteImportChange");

        if (card) card.style.display = "";
        if (name) name.textContent = file.name || "Document";
        if (meta) meta.textContent = `${ext.toUpperCase().replace(".", "")} · ${formatFileSize(file.size || 0)}`;
        if (empty) empty.textContent = "Document chargé. Vérifie le fichier puis lance l’analyse.";
        if (analyze){
            analyze.disabled = false;
            analyze.style.opacity = "";
        }
        if (change){
            change.disabled = false;
            change.style.opacity = "";
        }
    }

    function openPosteImportModal(){
        if (_posteModalMode !== "create") return;
        resetPosteImportState();
        openModal("modalPosteImport");
    }

    function closePosteImportModal(){
        closeModal("modalPosteImport");
    }

    async function applyImportedPosteDraft(portal, draft){
        _posteAiDraftMeta = draft || null;

        if (draft?.intitule_poste !== undefined) byId("posteIntitule").value = String(draft.intitule_poste || "");
        if (draft?.mission_principale !== undefined) byId("posteMission").value = String(draft.mission_principale || "");
        if (draft?.responsabilites_html !== undefined) rtSetHtml("posteResp", String(draft.responsabilites_html || ""));

        await ensureNsfGroupes(portal);
        fillNsfSelect(draft?.nsf_groupe_code || "");
        fillPosteContraintesTab({
            niveau_education_minimum: draft?.niveau_education_minimum || "",
            nsf_groupe_code: draft?.nsf_groupe_code || "",
            nsf_groupe_obligatoire: !!draft?.nsf_groupe_obligatoire,
            mobilite: draft?.mobilite || "",
            risque_physique: draft?.risque_physique || "",
            perspectives_evolution: draft?.perspectives_evolution || "",
            niveau_contrainte: draft?.niveau_contrainte || "",
            detail_contrainte: draft?.detail_contrainte || "",
        });

        const sub = byId("posteModalSub");
        if (sub){
            sub.textContent = "Brouillon importé depuis un document. Vérifie puis enregistre.";
        }

        seedPosteAiModalFromCurrent();
        setPosteTab("def");
    }

    async function launchPosteImport(portal){
        if (!_posteImportFile){
            portal.showAlert("error", "Sélectionne un document avant de lancer l’analyse.");
            return;
        }

        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const btnAnalyze = byId("btnPosteImportAnalyze");
        const btnChange = byId("btnPosteImportChange");

        if (btnAnalyze){
            btnAnalyze.disabled = true;
            btnAnalyze.style.opacity = ".6";
            btnAnalyze.textContent = "Analyse…";
        }
        if (btnChange){
            btnChange.disabled = true;
            btnChange.style.opacity = ".6";
        }

        openIaBusyOverlay(
            "Lecture du document en cours",
            "Extraction du texte, analyse de la fiche et préremplissage du poste..."
        );

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const fd = new FormData();
            fd.append("file", _posteImportFile, _posteImportFile.name || "document");

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/import_document`),
                {
                    method: "POST",
                    headers,
                    body: fd,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur import document (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){}
                throw new Error(msg);
            }

            const draft = await resp.json();
            await applyImportedPosteDraft(portal, draft);

            closePosteImportModal();
            portal.showAlert("", "");
        } finally {
            closeIaBusyOverlay();

            if (btnAnalyze){
                btnAnalyze.disabled = !_posteImportFile;
                btnAnalyze.style.opacity = _posteImportFile ? "" : ".6";
                btnAnalyze.textContent = "Lancer l’analyse";
            }
            if (btnChange){
                btnChange.disabled = !_posteImportFile;
                btnChange.style.opacity = _posteImportFile ? "" : ".6";
            }
        }
    }

    async function resolveStudioAccessToken(){
        try{
            const pac = window.PortalAuthCommon;
            if (pac && typeof pac.getSession === "function"){
                const s = await pac.getSession();
                if (s && s.access_token) return String(s.access_token);
                if (s && s.session && s.session.access_token) return String(s.session.access_token);
                if (s && s.data && s.data.session && s.data.session.access_token) return String(s.data.session.access_token);
            }
        } catch(_){}

        if (window.portal && window.portal.accessToken) return String(window.portal.accessToken);
        if (window.portal && window.portal.token) return String(window.portal.token);

        return "";
    }

    function getFilenameFromContentDisposition(value){
        const raw = String(value || "").trim();
        if (!raw) return "";

        const star = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
        if (star && star[1]){
            try{
                return decodeURIComponent(star[1]).replace(/^["']|["']$/g, "").trim();
            } catch(_){
                return String(star[1]).replace(/^["']|["']$/g, "").trim();
            }
        }

        const quoted = raw.match(/filename\s*=\s*"([^"]+)"/i);
        if (quoted && quoted[1]){
            return String(quoted[1]).trim();
        }

        const plain = raw.match(/filename\s*=\s*([^;]+)/i);
        if (plain && plain[1]){
            return String(plain[1]).replace(/^["']|["']$/g, "").trim();
        }

        return "";
    }

    async function openOrgChartPdf(portal){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const viewer = window.open("", "_blank");

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/organigramme_pdf/${encodeURIComponent(ownerId)}`),
                {
                    method: "GET",
                    headers,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur PDF (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){}
                throw new Error(msg);
            }

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            if (viewer){
                viewer.location = blobUrl;
            } else {
                window.open(blobUrl, "_blank");
            }

            setTimeout(() => {
                try { URL.revokeObjectURL(blobUrl); } catch(_){}
            }, 60000);

        } catch (e){
            if (viewer) viewer.close();
            throw e;
        }
    }

    async function openPosteFichePdf(portal, idPoste){
        const ownerId = getOwnerId();
        const pid = String(idPoste || "").trim();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");
        if (!pid) throw new Error("Poste manquant.");

        const viewer = window.open("", "_blank");

        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token){
                headers["Authorization"] = `Bearer ${token}`;
            }

            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/fiche_pdf`),
                {
                    method: "GET",
                    headers,
                    credentials: "same-origin",
                }
            );

            if (!resp.ok){
                let msg = `Erreur PDF (${resp.status})`;
                try{
                    const err = await resp.json();
                    if (err && err.detail) msg = String(err.detail);
                } catch(_){ }
                throw new Error(msg);
            }

            const suggestedName =
                getFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) ||
                "Fiche de poste.pdf";

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const escHtml = (v) => String(v || "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");

            const title = suggestedName || "Fiche de poste.pdf";

            if (viewer){
                viewer.document.open();
                viewer.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escHtml(title)}</title>
<style>
html, body {
  margin: 0;
  height: 100%;
  background: #f5f6f8;
}
body {
  display: flex;
  flex-direction: column;
}
.bar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  box-sizing: border-box;
  border-bottom: 1px solid #d7dbe2;
  background: #ffffff;
  font: 14px/1.2 Arial, sans-serif;
  color: #1f2937;
}
.bar__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.bar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid #9db3e8;
  background: #eef4ff;
  color: #28407a;
  text-decoration: none;
  font-weight: 600;
  flex: 0 0 auto;
}
.viewer {
  flex: 1;
  min-height: 0;
}
.viewer iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
</head>
<body>
  <div class="bar">
    <div class="bar__title">${escHtml(title)}</div>
    <a class="bar__btn" href="${blobUrl}" download="${escHtml(title)}">Télécharger</a>
  </div>
  <div class="viewer">
    <iframe src="${blobUrl}" title="${escHtml(title)}"></iframe>
  </div>
</body>
</html>`);
                viewer.document.close();

                try{
                    viewer.addEventListener("beforeunload", () => {
                        try { URL.revokeObjectURL(blobUrl); } catch(_){}
                    }, { once: true });
                } catch(_){}
            } else {
                window.open(blobUrl, "_blank");
                setTimeout(() => {
                    try { URL.revokeObjectURL(blobUrl); } catch(_){}
                }, 60000);
            }

        } catch (e){
            if (viewer) viewer.close();
            throw e;
        }
    }

    function serviceMeta(nbPostes, nbCollabs){
        return `${nbPostes} poste(s) · ${nbCollabs} collaborateur(s)`;
    }

    function syncSelectedServiceContext(){
        if (!_selectedService || _selectedService === "__all__"){
            _selectedService = "__all__";
            _selectedServiceName = "Tous les services";
            return;
        }

        if (_selectedService === "__none__"){
            _selectedServiceName = "Non lié";
            return;
        }

        const svc = (_services || []).find(x => x.id_service === _selectedService);
        if (!svc){
            _selectedService = "__all__";
            _selectedServiceName = "Tous les services";
            return;
        }

        _selectedServiceName = svc.nom_service || "Service";
    }

    function getPosteBlockTitle(){
        if (!_selectedService || _selectedService === "__all__"){
            return "Tous les postes";
        }

        if (_selectedService === "__none__"){
            return "Postes non liés";
        }

        return `Postes du service ${_selectedServiceName || ""}`.trim();
    }

    function refreshPosteBlockTitle(){
        const el = byId("posteBlockTitle");
        if (!el) return;
        el.textContent = getPosteBlockTitle();
    }

    function renderServices(){
        const host = byId("svcList");
        if (!host) return;
        host.innerHTML = "";

        // Pseudo: Tous les services
        host.appendChild(buildSvcRow("__all__", "Tous les services", 0, _totaux.nb_postes, _totaux.nb_collabs));

        // Services réels
        (_services || []).forEach(s => {
        host.appendChild(buildSvcRow(s.id_service, s.nom_service, s.depth, s.nb_postes, s.nb_collabs));
        });

        // Pseudo "Non lié" volontairement masqué dans Studio Organisation

        applySvcActive();
    }

    function buildSvcRow(id, name, depth, nbPostes, nbCollabs){
        const row = document.createElement("div");
        row.className = "sb-list-item sb-list-item--clickable";
        row.dataset.sid = id;

        const left = document.createElement("div");
        left.className = "sb-list-title";
        left.style.paddingLeft = `${Math.min(6, Math.max(0, depth)) * 14}px`;
        left.textContent = name;

        const right = document.createElement("div");
        right.className = "sb-list-meta";
        right.textContent = `${nbPostes} · ${nbCollabs}`;

        row.appendChild(left);
        row.appendChild(right);

        row.addEventListener("click", () => selectService(id, name, nbPostes, nbCollabs));
        return row;
    }

    function applySvcActive(){
        document.querySelectorAll(".sb-list-item[data-sid]").forEach(el => {
        const sid = el.dataset.sid;
        el.classList.toggle("is-active", sid === _selectedService);
        });
    }

    function selectService(id, name, nbPostes, nbCollabs){
        _selectedService = id;
        _selectedServiceName = name;

        refreshPosteBlockTitle();
        applySvcActive();
        updateAddButtonState();
        loadPostes(window.portal).catch(() => {});
    }

    function updateAddButtonState(){
        const btn = byId("btnAddFromCatalog");
        if (!btn) return;

        const ok = isAdmin();
        btn.disabled = !ok;
        btn.style.opacity = ok ? "" : ".6";
        btn.title = ok ? "" : "Accès admin requis.";
    }

    async function loadServices(portal){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const url = `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`;
        traceOrg("services:start", { url });

        try {
            const data = await portal.apiJson(url);

            _totaux = data.totaux || { nb_postes: 0, nb_collabs: 0 };
            _nonLie = data.non_lie || { nb_postes: 0, nb_collabs: 0 };
            _services = data.services || [];

            if (!_loaded) {
                _selectedService = "__all__";
                _selectedServiceName = "Tous les services";
            }

            syncSelectedServiceContext();
            renderServices();
            refreshPosteBlockTitle();
            updateAddButtonState();

            traceOrg("services:ok", {
                url,
                nbServices: _services.length,
                nbPostes: _totaux.nb_postes || 0,
                nbPostesNonLies: _nonLie.nb_postes || 0
            });
        } catch (e) {
            traceOrgError("services:error", e, { url });
            throw e;
        }
    }

    async function loadPostes(portal){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const url =
            `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}` +
            `?service=${encodeURIComponent(_selectedService)}` +
            `&q=${encodeURIComponent(_posteSearch)}` +
            `&include_archived=${_showArchivedPostes ? "1" : "0"}`;

        traceOrg("postes:start", { url });

        try {
            const data = await portal.apiJson(url);

            const host = byId("posteList");
            if (!host) {
                traceOrg("postes:no-host", { url });
                return;
            }

            host.innerHTML = "";

            const postes = data.postes || [];
            if (!postes.length) {
                const empty = document.createElement("div");
                empty.className = "card-sub";
                empty.textContent = "Aucun poste à afficher.";
                host.appendChild(empty);

                traceOrg("postes:empty", {
                    url,
                    nbPostes: 0
                });
                return;
            }

            const iconEdit = `
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
            `;

            const iconTrash = `
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                </svg>
            `;

            postes.forEach(p => {
                const row = document.createElement("div");
                row.className = "sb-row-card";

                const left = document.createElement("div");
                left.className = "sb-row-left";

                const code = document.createElement("span");
                code.className = "sb-badge sb-badge--poste";
                code.textContent = p.code || "—";

                const title = document.createElement("div");
                title.className = "sb-row-title";
                title.textContent = p.intitule || "";

                left.appendChild(code);
                left.appendChild(title);

                if (p.actif === false) row.classList.add("is-archived");

                const right = document.createElement("div");
                right.className = "sb-row-right";

                if (p.actif === false){
                    const arch = document.createElement("span");
                    arch.className = "sb-badge sb-badge--accent-soft";
                    arch.textContent = "ARCHIVÉ";
                    right.appendChild(arch);
                }

                const badge = document.createElement("span");
                badge.className = "sb-badge sb-badge--poste-soft";
                badge.textContent = `${p.nb_collabs || 0} collab.`;
                right.appendChild(badge);

                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const pdfBtn = document.createElement("button");
                pdfBtn.type = "button";
                pdfBtn.className = "sb-icon-btn sb-icon-btn--doc";
                pdfBtn.title = "Exporter pdf";
                pdfBtn.setAttribute("aria-label", "Exporter pdf");
                pdfBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h5"/></svg>';
                pdfBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try { await openPosteFichePdf(portal, p.id_poste); }
                    catch (err) { portal.showAlert("error", err?.message || String(err)); }
                });
                actions.appendChild(pdfBtn);

                const editBtn = document.createElement("button");
                editBtn.type = "button";
                editBtn.className = "sb-icon-btn";
                editBtn.title = "Voir/Modifier";
                editBtn.setAttribute("aria-label", "Voir/Modifier");
                editBtn.innerHTML = iconEdit;
                editBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openEditPosteModal(portal, p);
                });
                actions.appendChild(editBtn);

                const archiveBtn = document.createElement("button");
                archiveBtn.type = "button";
                archiveBtn.className = "sb-icon-btn sb-icon-btn--danger";
                archiveBtn.title = (p.actif === false) ? "Restaurer" : "Archiver";
                archiveBtn.setAttribute("aria-label", (p.actif === false) ? "Restaurer" : "Archiver");
                archiveBtn.innerHTML = iconTrash;
                archiveBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try { await toggleArchivePosteFromList(portal, p); }
                    catch (err) { portal.showAlert("error", err?.message || String(err)); }
                });
                actions.appendChild(archiveBtn);

                right.appendChild(actions);

                row.appendChild(left);
                row.appendChild(right);

                row.style.cursor = "pointer";
                row.addEventListener("click", () => openEditPosteModal(portal, p));

                host.appendChild(row);
            });

            traceOrg("postes:ok", {
                url,
                nbPostes: postes.length
            });
        } catch (e) {
            traceOrgError("postes:error", e, { url });
            throw e;
        }
    }

    function setPosteTab(tab){
        const modal = byId("modalPoste");
        if (!modal) return;

        modal.querySelectorAll("#posteTabbar [data-tab]").forEach(btn => {
            const isOn = (btn.getAttribute("data-tab") === tab);
            btn.classList.toggle("sb-btn--accent", isOn);
            btn.classList.toggle("sb-btn--soft", !isOn);
        });

        modal.querySelectorAll(".sb-tab-panel[data-panel]").forEach(p => {
            const isOn = (p.getAttribute("data-panel") === tab);
            p.classList.toggle("is-active", isOn);
        });

        const btnAi = byId("btnPosteAi");
        if (btnAi){
            btnAi.style.display = (tab === "def") ? "" : "none";
        }
    }

    // ------------------------------------------------------
    // Poste > Exigences > Contraintes
    // ------------------------------------------------------
    let _posteContraintesInit = false;
    let _posteRhInit = false;
    let _nsfGroupesLoaded = false;
    let _nsfGroupes = [];

    function _fillSelect(el, items){
    if (!el) return;
    el.innerHTML = "";
    (items || []).forEach(it => {
        const opt = document.createElement("option");
        opt.value = it.value ?? "";
        opt.dataset.shortText = it.shortText ?? it.text ?? "";
        opt.dataset.longText = it.longText ?? it.text ?? "";
        opt.dataset.helpText = it.helpText ?? it.longText ?? it.text ?? "";
        opt.textContent = opt.dataset.shortText || "";
        el.appendChild(opt);
    });
    }

    function _selectByValue(id, v){
    const el = byId(id);
    if (!el) return;
    const val = (v ?? "").toString().trim();
    el.value = val;
    }

    function _setChecked(id, v){
    const el = byId(id);
    if (!el) return;
    el.checked = !!v;
    }

    function _setValue(id, v){
        const el = byId(id);
        if (!el) return;

        const val = (v ?? "").toString();
        const tag = (el.tagName || "").toUpperCase();

        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"){
            el.value = val;
        } else {
            el.textContent = val;
        }
    }

    function _setSelectDisplayMode(el, mode){
    if (!el) return;
    Array.from(el.options || []).forEach(opt => {
        const shortTxt = opt.dataset.shortText || opt.textContent || "";
        const longTxt = opt.dataset.longText || shortTxt;
        opt.textContent = (mode === "full") ? longTxt : shortTxt;
    });
    }

    function _bindSelectShortValueDisplay(selectId, helpId){
    const sel = byId(selectId);
    const help = byId(helpId);
    if (!sel || !help) return;

    const applyShortAndHelp = () => {
        _setSelectDisplayMode(sel, "short");

        const opt = sel.options[sel.selectedIndex];
        const txt = (opt?.dataset?.helpText || opt?.dataset?.longText || "").trim();

        if (txt && txt !== "—"){
            help.textContent = txt;
            help.style.display = "";
            sel.title = txt;
        } else {
            help.textContent = "";
            help.style.display = "none";
            sel.title = "";
        }
    };

    if (!sel._sbShortDisplayBound){
        sel._sbShortDisplayBound = true;

        const showFull = () => _setSelectDisplayMode(sel, "full");

        sel.addEventListener("mousedown", showFull);
        sel.addEventListener("focus", showFull);
        sel.addEventListener("click", showFull);

        sel.addEventListener("change", () => {
            setTimeout(() => applyShortAndHelp(), 0);
        });

        sel.addEventListener("blur", () => {
            applyShortAndHelp();
        });
    }

    sel._sbRefreshHelp = applyShortAndHelp;
    applyShortAndHelp();
    }

    function initPosteContraintesSelects(){
    if (_posteContraintesInit) return;
    _posteContraintesInit = true;

    _fillSelect(byId("posteCtrEduMin"), [
        { value:"",  text:"—" },
        { value:"0", text:"Aucun diplôme" },
        { value:"3", text:"Niveau 3 : CAP, BEP" },
        { value:"4", text:"Niveau 4 : Bac" },
        { value:"5", text:"Niveau 5 : Bac+2 (BTS, DUT)" },
        { value:"6", text:"Niveau 6 : Bac+3 (Licence, BUT)" },
        { value:"7", text:"Niveau 7 : Bac+5 (Master, Ingénieur, Grandes écoles)" },
        { value:"8", text:"Niveau 8 : Bac+8 (Doctorat)" }
    ]);

    _fillSelect(byId("posteCtrMobilite"), [
        { value:"", text:"—" },
        { value:"Aucune", text:"Aucune" },
        { value:"Rare", text:"Rare" },
        { value:"Occasionnelle", text:"Occasionnelle" },
        { value:"Fréquente", text:"Fréquente" }
    ]);

    _fillSelect(byId("posteCtrPerspEvol"), [
        { value:"", text:"—" },
        { value:"Aucune", text:"Aucune" },
        { value:"Faible", text:"Faible" },
        { value:"Modérée", text:"Modérée" },
        { value:"Forte", text:"Forte" },
        { value:"Rapide", text:"Rapide" }
    ]);

    _fillSelect(byId("posteCtrRisquePhys"), [
        { value:"", text:"—", shortText:"—", longText:"—", helpText:"" },
        { value:"Aucun", shortText:"Aucun", longText:"Aucun : pas de risque identifié.", helpText:"Aucun : pas de risque identifié." },
        { value:"Faible", shortText:"Faible", longText:"Faible : exposition occasionnelle, faible intensité.", helpText:"Faible : exposition occasionnelle, faible intensité." },
        { value:"Modéré", shortText:"Modéré", longText:"Modéré : exposition régulière mais maîtrisée.", helpText:"Modéré : exposition régulière mais maîtrisée." },
        { value:"Élevé", shortText:"Élevé", longText:"Élevé : risque important, pouvant générer une pathologie.", helpText:"Élevé : risque important, pouvant générer une pathologie." },
        { value:"Critique", shortText:"Critique", longText:"Critique : risque vital ou accident grave possible.", helpText:"Critique : risque vital ou accident grave possible." }
    ]);

    _fillSelect(byId("posteCtrNivContrainte"), [
        { value:"", text:"—", shortText:"—", longText:"—", helpText:"" },
        { value:"Aucune", shortText:"Aucune", longText:"Aucune : poste standard, sans pression ni particularité.", helpText:"Aucune : poste standard, sans pression ni particularité." },
        { value:"Modérée", shortText:"Modérée", longText:"Modérée : quelques contraintes psychosociales/organisationnelles.", helpText:"Modérée : quelques contraintes psychosociales/organisationnelles." },
        { value:"Élevée", shortText:"Élevée", longText:"Élevée : forte pression, conditions difficiles, grande responsabilité.", helpText:"Élevée : forte pression, conditions difficiles, grande responsabilité." },
        { value:"Critique", shortText:"Critique", longText:"Critique : stress ou responsabilité vitale.", helpText:"Critique : stress ou responsabilité vitale." }
    ]);

    _bindSelectShortValueDisplay("posteCtrRisquePhys", "posteCtrRisquePhysHelp");
    _bindSelectShortValueDisplay("posteCtrNivContrainte", "posteCtrNivContrainteHelp");
    }

    async function ensureNsfGroupes(portal){
    if (_nsfGroupesLoaded) return;
    _nsfGroupesLoaded = true;

    try{
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/nsf_groupes/${encodeURIComponent(ownerId)}`;
        const r = await portal.apiJson(url);
        _nsfGroupes = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
    } catch(e){
        // on ne bloque pas le modal pour ça
        _nsfGroupes = [];
    }
    }

    function fillNsfSelect(currentCode){
        const sel = byId("posteCtrNsfGroupe");
        if (!sel) return;

        const code = (currentCode ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_nsfGroupes || []).forEach(g => {
            const c = (g.code ?? "").toString().trim();
            const t = (g.titre ?? "").toString().trim();
            if (!c) return;
            const opt = document.createElement("option");
            opt.value = c;
            opt.textContent = t ? `${t} (${c})` : c;
            sel.appendChild(opt);
        });

        sel.value = code || "";
    }

    function fillPosteContraintesTab(detail){
        initPosteContraintesSelects();

        _selectByValue("posteCtrEduMin", detail?.niveau_education_minimum);
        _setChecked("posteCtrNsfOblig", detail?.nsf_groupe_obligatoire);
        _selectByValue("posteCtrMobilite", detail?.mobilite);
        _selectByValue("posteCtrRisquePhys", detail?.risque_physique);
        _selectByValue("posteCtrPerspEvol", detail?.perspectives_evolution);
        _selectByValue("posteCtrNivContrainte", detail?.niveau_contrainte);
        _setValue("posteCtrDetailContrainte", detail?.detail_contrainte);

        const rSel = byId("posteCtrRisquePhys");
        if (rSel && typeof rSel._sbRefreshHelp === "function") rSel._sbRefreshHelp();

        const nSel = byId("posteCtrNivContrainte");
        if (nSel && typeof nSel._sbRefreshHelp === "function") nSel._sbRefreshHelp();
    }

    // ------------------------------------------------------
    // Poste > Paramétrage RH
    // ------------------------------------------------------
    function rhSourceLabel(v){
        const s = (v || "").toString().trim().toLowerCase();
        if (s === "studio") return "Studio";
        if (s === "desktop") return "Desktop";
        if (s === "insights") return "Insights";
        return "—";
    }

    function formatRhDateMaj(v){
        const s = (v || "").toString().trim();
        if (!s) return "—";

        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
        if (m){
            const dd = m[3];
            const mm = m[2];
            const yy = m[1];
            const hh = m[4] || "";
            const mi = m[5] || "";
            return hh && mi ? `${dd}/${mm}/${yy} ${hh}:${mi}` : `${dd}/${mm}/${yy}`;
        }

        const d = new Date(s);
        if (!Number.isNaN(d.getTime())){
            return d.toLocaleString("fr-FR", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            });
        }

        return s;
    }

    function refreshPosteRhCriticiteHelp(){
        const sel = byId("posteRhCriticite");
        const help = byId("posteRhCriticiteHelp");
        if (!sel || !help) return;

        const v = (sel.value || "").trim();
        if (v === "1"){
            help.textContent = "1 = Faible : poste peu sensible, impact limité.";
        } else if (v === "2"){
            help.textContent = "2 = Modérée : poste important, impact réel sur l’activité.";
        } else if (v === "3"){
            help.textContent = "3 = Forte : poste clé, difficile à remplacer ou à sécuriser.";
        } else {
            help.textContent = "";
        }
    }

    function refreshPosteRhDateFinVisibility(){
        const statut = (byId("posteRhStatut")?.value || "").trim().toLowerCase();
        const wrap = byId("posteRhDateFinWrap");
        const fin = byId("posteRhDateFin");
        if (!wrap || !fin) return;

        const show = (statut === "gele" || statut === "temporaire");
        wrap.style.display = show ? "" : "none";

        if (!show){
            fin.value = "";
        }
    }

    function initPosteRhTab(){
        if (_posteRhInit) return;
        _posteRhInit = true;

        _fillSelect(byId("posteRhStatut"), [
            { value:"actif", text:"Actif" },
            { value:"a_pourvoir", text:"À pourvoir" },
            { value:"gele", text:"Gelé" },
            { value:"temporaire", text:"Temporaire" },
            { value:"archive", text:"Archivé (RH)" }
        ]);

        _fillSelect(byId("posteRhStrategie"), [
            { value:"interne", text:"Interne" },
            { value:"externe", text:"Externe" },
            { value:"mixte", text:"Mixte" }
        ]);

        _fillSelect(byId("posteRhCriticite"), [
            { value:"1", text:"1 - Faible" },
            { value:"2", text:"2 - Modérée" },
            { value:"3", text:"3 - Forte" }
        ]);

        byId("posteRhStatut")?.addEventListener("change", refreshPosteRhDateFinVisibility);
        byId("posteRhCriticite")?.addEventListener("change", refreshPosteRhCriticiteHelp);

        if (typeof bindStepButtons === "function"){
            bindStepButtons(byId("posteBlocRh"));
        }

        refreshPosteRhCriticiteHelp();
        refreshPosteRhDateFinVisibility();
    }

    function fillPosteRhTab(detail, isCreate){
        initPosteRhTab();

        _selectByValue("posteRhStatut", detail?.statut_poste || "actif");
        _selectByValue("posteRhStrategie", detail?.strategie_pourvoi || "mixte");
        _setValue("posteRhDateDebut", detail?.date_debut_validite || "");
        _setValue("posteRhDateFin", detail?.date_fin_validite || "");
        _setValue("posteRhNbTitulaires", detail?.nb_titulaires_cible ?? 1);
        _selectByValue("posteRhCriticite", detail?.criticite_poste ?? 2);
        _setChecked("posteRhVerrouille", detail?.param_rh_verrouille);
        _setValue("posteRhCommentaire", detail?.param_rh_commentaire || "");

        const src = detail?.param_rh_source || (isCreate ? "studio" : "");
        _setValue("posteRhSource", rhSourceLabel(src));

        const maj = detail?.param_rh_date_maj || "";
        _setValue("posteRhDateMaj", isCreate && !maj ? "Création à l’enregistrement" : formatRhDateMaj(maj));

        refreshPosteRhCriticiteHelp();
        refreshPosteRhDateFinVisibility();
    }

        // ------------------------------------------------------
    // Poste > Paramétrage RH > Cotation conventionnelle
    // ------------------------------------------------------
    function _posteCcnDefaultSummary(isCreate){
        return isCreate
            ? "Enregistre d’abord le poste pour lancer une cotation traçable."
            : "Aucune cotation conventionnelle enregistrée.";
    }

    function resetPosteCcnUi(isCreate){
        _posteCcnContext = null;
        _posteCcnAnalysis = null;

        _setValue("posteCcnConvention", isCreate ? "Disponible après enregistrement du poste" : "Chargement…");
        _setValue("posteCcnStatus", isCreate ? "Brouillon non enregistré" : "Chargement…");
        _setValue("posteCcnResult", "—");
        _setValue("posteCcnCategory", "—");
        _setValue("posteCcnSummary", _posteCcnDefaultSummary(!!isCreate));

        _setValue("posteCcnModalConvention", "—");
        _setValue("posteCcnModalVersion", "—");
        _setValue("posteCcnModalPoste", "—");
        _setValue("posteCcnModalService", "—");
        _setValue("posteCcnModalBase", "");

        _setValue("posteCcnPropCoeff", "—");
        _setValue("posteCcnPropPalier", "—");
        _setValue("posteCcnPropCategorie", "—");
        _setValue("posteCcnPropPoints", "—");
        _setValue("posteCcnPropResume", "");
        _setValue("posteCcnPropJustification", "");

        _setValue("posteCcnFinalCoefficient", "");
        _setValue("posteCcnFinalPalier", "");
        _setValue("posteCcnFinalCategorie", "");
        _setValue("posteCcnFinalJustification", "");

        const tbody = byId("posteCcnCriteriaTbody");
        if (tbody) tbody.innerHTML = "";
        const empty = byId("posteCcnCriteriaEmpty");
        if (empty) empty.style.display = "";

        const reuse = byId("btnPosteCcnReuse");
        if (reuse){
            reuse.disabled = true;
            reuse.style.opacity = ".6";
        }

        const sub = byId("posteCcnSub");
        if (sub){
            sub.textContent = isCreate
                ? "Enregistre le poste, puis lance l’assistant de cotation conventionnelle."
                : "Assistant dédié à la cotation de l’emploi selon la convention collective détectée.";
        }
    }

    function getPosteCcnReferential(){
        return _posteCcnContext?.referential || null;
    }

    function findPosteCcnPalierByCoefficient(coef){
        const ref = getPosteCcnReferential() || {};
        const n = parseInt(coef ?? 0, 10);
        if (!Number.isFinite(n) || n <= 0) return null;

        const paliers = Array.isArray(ref?.paliers) ? ref.paliers : [];
        if (paliers.length){
            for (const it of paliers){
                const min = parseInt(it?.coef_min ?? 0, 10) || 0;
                const max = (it?.coef_max === null || it?.coef_max === undefined) ? 999999 : (parseInt(it.coef_max, 10) || 999999);
                if (n >= min && n <= max){
                    return {
                        palier: parseInt(it?.palier ?? 0, 10) || 0,
                        groupe: "",
                        raw: it
                    };
                }
            }
            return null;
        }

        const cmap = Array.isArray(ref?.classification_map) ? ref.classification_map : [];
        for (const it of cmap){
            const min = parseInt(it?.points_min ?? 0, 10) || 0;
            const max = parseInt(it?.points_max ?? 0, 10) || 0;
            if (n >= min && n <= max){
                return {
                    palier: parseInt(it?.classe ?? 0, 10) || 0,
                    groupe: (it?.groupe || "").toString().trim().toUpperCase(),
                    raw: it
                };
            }
        }

        return null;
    }

    function countPosteCcnCadreConditions(criteria){
        const rows = Array.isArray(criteria) ? criteria : [];
        const marche = (code) => parseInt((rows.find(x => String(x?.code || "").trim() === code)?.marche) ?? 0, 10) || 0;
        let ok = 0;
        if (marche("management") >= 3) ok += 1;
        if (marche("ampleur_connaissances") >= 4) ok += 1;
        if (marche("autonomie") >= 6) ok += 1;
        return ok;
    }

    function computePosteCcnCategory(coef, criteria){
        const ref = getPosteCcnReferential() || {};
        const n = parseInt(coef ?? 0, 10);
        if (!Number.isFinite(n) || n <= 0) return "";

        const cmap = Array.isArray(ref?.classification_map) ? ref.classification_map : [];
        if (cmap.length){
            const band = findPosteCcnPalierByCoefficient(n);
            const grp = (band?.groupe || "").toString().trim().toUpperCase();
            if (!grp) return "";
            const cadreGroups = new Set((ref?.cadre_groups || ["F","G","H","I"]).map(x => String(x || "").trim().toUpperCase()));
            return `Groupe ${grp} · ${cadreGroups.has(grp) ? "Cadre" : "Non-cadre"}`;
        }

        if (n >= 350) return "Cadre";
        if (n >= 310 && n <= 349){
            const rows = Array.isArray(criteria) ? criteria : [];
            const marche = (code) => parseInt((rows.find(x => String(x?.code || "").trim() === code)?.marche) ?? 0, 10) || 0;
            let ok = 0;
            if (marche("management") >= 3) ok += 1;
            if (marche("ampleur_connaissances") >= 4) ok += 1;
            if (marche("autonomie") >= 6) ok += 1;
            return ok >= 2 ? "Cadre" : "Agent de maîtrise / technicien";
        }
        if (n >= 171) return "Agent de maîtrise / technicien";
        if (n >= 100) return "Employé";
        return "";
    }

    function formatPosteCcnResultText(data){
        const coef = parseInt(data?.coefficient ?? 0, 10) || 0;
        const palier = parseInt(data?.palier ?? 0, 10) || 0;
        return (!coef && !palier) ? "—" : `Coef. ${coef || "—"} · Palier ${palier || "—"}`;
    }

    function renderPosteCcnCriteriaRows(analysis){
        const tbody = byId("posteCcnCriteriaTbody");
        const empty = byId("posteCcnCriteriaEmpty");
        if (!tbody || !empty) return;

        tbody.innerHTML = "";
        const rows = [];

        (Array.isArray(analysis?.criteres) ? analysis.criteres : []).forEach(x => {
            rows.push({
                libelle: x?.libelle || x?.code || "Critère",
                niveau: `M${parseInt(x?.marche ?? 0, 10) || 0}`,
                points: parseInt(x?.points ?? 0, 10) || 0,
                justification: x?.justification || ""
            });
        });

        (Array.isArray(analysis?.bonifications) ? analysis.bonifications : []).forEach(x => {
            rows.push({
                libelle: x?.libelle || x?.code || "Bonification",
                niveau: x?.niveau_label || `M${parseInt(x?.marche ?? 0, 10) || 0}`,
                points: parseInt(x?.points ?? 0, 10) || 0,
                justification: x?.justification || ""
            });
        });

        if (!rows.length){
            empty.style.display = "";
            return;
        }

        empty.style.display = "none";

        rows.forEach(r => {
            const tr = document.createElement("tr");

            const tdLib = document.createElement("td");
            tdLib.textContent = r.libelle || "—";

            const tdNiv = document.createElement("td");
            tdNiv.style.textAlign = "center";
            const badge = document.createElement("span");
            badge.className = "sb-badge sb-badge--ccn-level";
            badge.textContent = r.niveau || "—";
            tdNiv.appendChild(badge);

            const tdPts = document.createElement("td");
            tdPts.style.textAlign = "center";
            tdPts.textContent = String(r.points ?? "—");

            const tdJust = document.createElement("td");
            tdJust.textContent = r.justification || "—";

            tr.appendChild(tdLib);
            tr.appendChild(tdNiv);
            tr.appendChild(tdPts);
            tr.appendChild(tdJust);
            tbody.appendChild(tr);
        });
    }

    function fillPosteCcnDecision(data){
        _setValue("posteCcnFinalCoefficient", data?.coefficient || "");
        _setValue("posteCcnFinalJustification", data?.justification || "");
        refreshPosteCcnDecisionDerived();
    }

    function fillPosteCcnProposal(analysis){
        _posteCcnAnalysis = analysis || null;
        const proposal = analysis?.proposal || {};

        _setValue("posteCcnPropCoeff", proposal?.coefficient ?? "—");
        _setValue("posteCcnPropPalier", proposal?.palier ?? "—");
        _setValue("posteCcnPropCategorie", proposal?.categorie_professionnelle || "—");
        _setValue("posteCcnPropPoints", analysis?.total_points ?? "—");
        _setValue("posteCcnPropResume", proposal?.resume_cotation || "");
        _setValue("posteCcnPropJustification", analysis?.justification_globale || "");

        renderPosteCcnCriteriaRows(analysis);

        const reuse = byId("btnPosteCcnReuse");
        if (reuse){
            reuse.disabled = !analysis?.proposal;
            reuse.style.opacity = reuse.disabled ? ".6" : "";
        }
    }

    function refreshPosteCcnDecisionDerived(){
        const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
        if (!Number.isFinite(coef) || coef <= 0){
            _setValue("posteCcnFinalPalier", "");
            _setValue("posteCcnFinalCategorie", "");
            return;
        }
        const criteria = _posteCcnAnalysis?.criteres || _posteCcnContext?.dossier?.proposition_json?.criteres || [];
        _setValue("posteCcnFinalPalier", findPosteCcnPalierByCoefficient(coef)?.palier ?? "");
        _setValue("posteCcnFinalCategorie", computePosteCcnCategory(coef, criteria));
    }

    function fillPosteCcnContext(ctx){
        _posteCcnContext = ctx || null;

        const conventionTxt = ctx?.convention_label
            ? `${ctx.convention_label}${ctx?.idcc ? ` (IDCC ${ctx.idcc})` : ""}`
            : (ctx?.idcc ? `IDCC ${ctx.idcc}` : "Convention non détectée");

        _setValue("posteCcnConvention", conventionTxt);
        _setValue("posteCcnModalConvention", conventionTxt);
        _setValue("posteCcnModalVersion", ctx?.version_label || "—");
        _setValue("posteCcnModalPoste", ctx?.poste?.intitule_poste || "—");
        _setValue("posteCcnModalService", ctx?.poste?.nom_service || "Non lié");

        const base = [];
        if (ctx?.poste?.mission_principale) base.push(`Mission : ${ctx.poste.mission_principale}`);
        if (ctx?.poste?.competences_count !== undefined) base.push(`Compétences requises : ${ctx.poste.competences_count}`);
        if (ctx?.poste?.certifications_count !== undefined) base.push(`Certifications : ${ctx.poste.certifications_count}`);
        _setValue("posteCcnModalBase", base.join("\n"));

        let status = "Non démarré";
        let result = "—";
        let category = "—";
        let summary = _posteCcnDefaultSummary(false);

        const dossier = ctx?.dossier || null;
        const proposal = dossier?.proposition_json || null;
        const validation = dossier?.validation_json || null;

        if (!ctx?.supported){
            status = "Convention non supportée";
            summary = ctx?.support_message || "L’assistant n’est pas disponible pour cette convention.";
        } else if (validation && Object.keys(validation).length){
            status = "Validée";
            result = formatPosteCcnResultText(validation);
            summary = validation?.justification || proposal?.proposal?.resume_cotation || _posteCcnDefaultSummary(false);
            category = validation?.categorie_professionnelle || proposal?.proposal?.categorie_professionnelle || "—";
        } else if (proposal && Object.keys(proposal).length){
            status = "Brouillon";
            result = formatPosteCcnResultText(proposal?.proposal || proposal);
            summary = proposal?.justification_globale || proposal?.proposal?.resume_cotation || _posteCcnDefaultSummary(false);
            category = proposal?.proposal?.categorie_professionnelle || "—";
        }

        _setValue("posteCcnStatus", status);
        _setValue("posteCcnResult", result);
        _setValue("posteCcnCategory", category);
        _setValue("posteCcnSummary", summary);

        fillPosteCcnProposal(proposal && Object.keys(proposal).length ? proposal : null);

        if (validation && Object.keys(validation).length){
            fillPosteCcnDecision({
                coefficient: validation.coefficient,
                justification: validation.justification || ""
            });
        } else if (proposal?.proposal){
            fillPosteCcnDecision({
                coefficient: proposal.proposal.coefficient,
                justification: proposal.justification_globale || proposal.proposal.resume_cotation || ""
            });
        } else {
            fillPosteCcnDecision({ coefficient: "", justification: "" });
        }

        const sub = byId("posteCcnSub");
        if (sub){
            sub.textContent = ctx?.supported
                ? "Assistant dédié à la cotation de l’emploi selon la convention collective détectée."
                : (ctx?.support_message || "Convention non encore supportée.");
        }
    }

    async function loadPosteCcnContext(portal){
        if (!_editingPosteId) return null;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/ccn_context`;
        const ctx = await portal.apiJson(url);
        fillPosteCcnContext(ctx);
        return ctx;
    }

    async function openPosteCcnModal(portal){
        await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== _editingPosteId){
            await loadPosteCcnContext(portal);
        }
        openModal("modalPosteCcn");
    }

    function closePosteCcnModal(){
        closeModal("modalPosteCcn");
    }

    function reusePosteCcnProposal(){
        const proposal = _posteCcnAnalysis?.proposal || _posteCcnContext?.dossier?.proposition_json?.proposal || null;
        const justification = _posteCcnAnalysis?.justification_globale || _posteCcnContext?.dossier?.proposition_json?.justification_globale || "";
        if (!proposal) return;
        fillPosteCcnDecision({
            coefficient: proposal.coefficient,
            justification: justification || proposal.resume_cotation || ""
        });
    }

    async function runPosteCcnAnalysis(portal){
        const pid = await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== pid){
            await loadPosteCcnContext(portal);
        }
        if (!_posteCcnContext?.supported){
            portal.showAlert("error", _posteCcnContext?.support_message || "Convention non supportée.");
            return;
        }

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/propose`;

        const btn = byId("btnPosteCcnAnalyze");
        if (btn){
            btn.disabled = true;
            btn.style.opacity = ".6";
            btn.textContent = "Analyse…";
        }

        openIaBusyOverlay(
            "Cotation conventionnelle en cours",
            "Lecture du poste, application du référentiel conventionnel et génération de la justification..."
        );

        try{
            const res = await portal.apiJson(url, { method: "POST" });
            const analysis = res?.proposition || null;

            fillPosteCcnProposal(analysis);
            reusePosteCcnProposal();

            if (_posteCcnContext){
                if (!_posteCcnContext.dossier) _posteCcnContext.dossier = {};
                _posteCcnContext.dossier.proposition_json = analysis || {};
            }

            _setValue("posteCcnStatus", "Proposition non enregistrée");
            _setValue("posteCcnResult", formatPosteCcnResultText(analysis?.proposal || {}));
            _setValue("posteCcnCategory", analysis?.proposal?.categorie_professionnelle || "—");
            _setValue(
                "posteCcnSummary",
                analysis?.justification_globale || analysis?.proposal?.resume_cotation || "Proposition IA prête à être revue."
            );

            portal.showAlert("", "");
        } finally {
            closeIaBusyOverlay();
            if (btn){
                btn.disabled = false;
                btn.style.opacity = "";
                btn.textContent = "Lancer l’analyse";
            }
        }
    }

    async function savePosteCcnDecision(portal){
        const pid = await ensureEditingPoste(portal);
        if (!_posteCcnContext || _posteCcnContext?.poste?.id_poste !== pid){
            await loadPosteCcnContext(portal);
        }
        if (!_posteCcnContext?.supported){
            portal.showAlert("error", _posteCcnContext?.support_message || "Convention non supportée.");
            return;
        }

        const coef = parseInt((byId("posteCcnFinalCoefficient")?.value || "").trim(), 10);
        const ref = getPosteCcnReferential() || {};
        const is3248 = Array.isArray(ref?.classification_map) && ref.classification_map.length > 0;
        const minCoef = is3248 ? 6 : 100;

        if (!Number.isFinite(coef) || coef < minCoef){
            portal.showAlert("error", is3248
                ? "La cotation retenue doit être supérieure ou égale à 6."
                : "Le coefficient retenu doit être supérieur ou égal à 100."
            );
            return;
        }

        const justification = (byId("posteCcnFinalJustification")?.value || "").trim();
        if (!justification){
            portal.showAlert("error", "La justification retenue est obligatoire.");
            return;
        }

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/ccn_assistant/save`;

        const btn = byId("btnPosteCcnSave");
        if (btn){
            btn.disabled = true;
            btn.style.opacity = ".6";
        }

        try{
            await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    coefficient_retenu: coef,
                    justification_retenue: justification,
                    proposition_json: _posteCcnAnalysis || _posteCcnContext?.dossier?.proposition_json || {}
                }),
            });
            await loadPosteCcnContext(portal);
            portal.showAlert("", "");
        } finally {
            if (btn){
                btn.disabled = false;
                btn.style.opacity = "";
            }
        }
    }

    function resetPosteAiModalFields(){
        byId("posteAiIntitule") && (byId("posteAiIntitule").value = "");
        byId("posteAiContexte") && (byId("posteAiContexte").value = "");
        byId("posteAiTaches") && (byId("posteAiTaches").value = "");
        byId("posteAiOutils") && (byId("posteAiOutils").value = "");
        byId("posteAiEnvironnement") && (byId("posteAiEnvironnement").value = "");
        byId("posteAiInteractions") && (byId("posteAiInteractions").value = "");
        byId("posteAiContraintes") && (byId("posteAiContraintes").value = "");
    }

    function seedPosteAiModalFromCurrent(){
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const respHtml = rtGetHtml("posteResp");
        const respTxt = htmlToPlainText(respHtml);
        const ctr = (byId("posteCtrDetailContrainte")?.value || "").trim();
        const pieces = [];
        if ((byId("posteCtrMobilite")?.value || "").trim()) pieces.push(`Mobilité: ${(byId("posteCtrMobilite").value || "").trim()}`);
        if ((byId("posteCtrRisquePhys")?.value || "").trim()) pieces.push(`Risques physiques: ${(byId("posteCtrRisquePhys").value || "").trim()}`);
        if ((byId("posteCtrNivContrainte")?.value || "").trim()) pieces.push(`Niveau de contraintes: ${(byId("posteCtrNivContrainte").value || "").trim()}`);
        if ((byId("posteCtrPerspEvol")?.value || "").trim()) pieces.push(`Perspectives: ${(byId("posteCtrPerspEvol").value || "").trim()}`);
        if ((byId("posteCtrEduMin")?.value || "").trim()) pieces.push(`Niveau d'étude minimum: ${(byId("posteCtrEduMin").value || "").trim()}`);
        const mergedCtr = [ctr, pieces.join(" | ")].filter(Boolean).join("\n");

        if (byId("posteAiIntitule") && !byId("posteAiIntitule").value.trim()) byId("posteAiIntitule").value = title;
        if (byId("posteAiContexte") && !byId("posteAiContexte").value.trim()) byId("posteAiContexte").value = mission;
        if (byId("posteAiTaches") && !byId("posteAiTaches").value.trim()) byId("posteAiTaches").value = respTxt;
        if (byId("posteAiContraintes") && !byId("posteAiContraintes").value.trim()) byId("posteAiContraintes").value = mergedCtr;
    }

    function openPosteAiModal(){
        const ttl = byId("posteAiTitle");
        const sub = byId("posteAiSub");
        if (ttl) ttl.textContent = (_posteModalMode === "edit") ? "Proposer des textes de remplacement avec l’IA" : "Générer une fiche de poste avec l’IA";
        if (sub) sub.textContent = (_posteModalMode === "edit")
            ? "L’IA reformule et enrichit la fiche actuelle sans changer le métier visé."
            : "L’IA propose un brouillon exploitable à partir de tes éléments et d’une recherche web.";
        seedPosteAiModalFromCurrent();
        openModal("modalPosteAi");
    }

    function closePosteAiModal(){
        closeModal("modalPosteAi");
    }

    async function generatePosteAiDraft(portal){
        const ownerId = getOwnerId();
        const payload = {
            mode: _posteModalMode || "create",
            id_poste: _editingPosteId || null,
            current_intitule_poste: (byId("posteIntitule")?.value || "").trim() || null,
            current_mission_principale: (byId("posteMission")?.value || "").trim() || null,
            current_responsabilites_html: rtGetHtml("posteResp").trim() || null,
            intitule: (byId("posteAiIntitule")?.value || "").trim(),
            contexte: (byId("posteAiContexte")?.value || "").trim() || null,
            taches: (byId("posteAiTaches")?.value || "").trim() || null,
            outils: (byId("posteAiOutils")?.value || "").trim() || null,
            environnement: (byId("posteAiEnvironnement")?.value || "").trim() || null,
            interactions: (byId("posteAiInteractions")?.value || "").trim() || null,
            contraintes: (byId("posteAiContraintes")?.value || "").trim() || null,
        };

        if (!payload.intitule){
            portal.showAlert("error", "Intitulé du poste obligatoire pour lancer la génération IA.");
            return;
        }

            const btn = byId("btnPosteAiGenerate");
            if (btn){ btn.disabled = true; btn.style.opacity = ".6"; btn.textContent = "Génération…"; }

            openIaBusyOverlay(
                "Génération IA de la fiche de poste",
                "Recherche web, analyse du contexte métier et rédaction du brouillon..."
            );

            try{
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_draft`;
            const draft = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            _posteAiDraftMeta = draft || null;
            if (draft?.intitule_poste !== undefined) byId("posteIntitule").value = String(draft.intitule_poste || "");
            if (draft?.mission_principale !== undefined) byId("posteMission").value = String(draft.mission_principale || "");
            if (draft?.responsabilites_html !== undefined) rtSetHtml("posteResp", String(draft.responsabilites_html || ""));

            await ensureNsfGroupes(portal);
            fillNsfSelect(draft?.nsf_groupe_code || "");
            fillPosteContraintesTab({
                niveau_education_minimum: draft?.niveau_education_minimum || "",
                nsf_groupe_code: draft?.nsf_groupe_code || "",
                nsf_groupe_obligatoire: !!draft?.nsf_groupe_obligatoire,
                mobilite: draft?.mobilite || "",
                risque_physique: draft?.risque_physique || "",
                perspectives_evolution: draft?.perspectives_evolution || "",
                niveau_contrainte: draft?.niveau_contrainte || "",
                detail_contrainte: draft?.detail_contrainte || "",
            });

            closePosteAiModal();
            portal.showAlert("", "");
        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        } finally {
            closeIaBusyOverlay();
            if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.textContent = "Générer"; }
        }
    }

    function resetPosteCompAiUi(){
        _posteCompAiResults = { existing: [], missing: [] };
        const loading = byId("posteCompAiLoading");
        const summary = byId("posteCompAiSummary");
        const exWrap = byId("posteCompAiExistingWrap");
        const miWrap = byId("posteCompAiMissingWrap");
        const exList = byId("posteCompAiExistingList");
        const miList = byId("posteCompAiMissingList");
        if (loading){ loading.style.display = "none"; loading.textContent = "Analyse en cours…"; }
        if (summary){ summary.style.display = "none"; summary.textContent = ""; }
        if (exWrap) exWrap.style.display = "none";
        if (miWrap) miWrap.style.display = "none";
        if (exList) exList.innerHTML = "";
        if (miList) miList.innerHTML = "";
    }

    function buildPosteCompAiPayload(){
        return {
            id_poste: _editingPosteId || null,
            intitule_poste: (byId("posteIntitule")?.value || "").trim() || null,
            mission_principale: (byId("posteMission")?.value || "").trim() || null,
            responsabilites_html: rtGetHtml("posteResp").trim() || null,
            ai_contexte: (byId("posteAiContexte")?.value || "").trim() || null,
            ai_taches: (byId("posteAiTaches")?.value || "").trim() || null,
            ai_outils: (byId("posteAiOutils")?.value || "").trim() || null,
            ai_environnement: (byId("posteAiEnvironnement")?.value || "").trim() || null,
            ai_interactions: (byId("posteAiInteractions")?.value || "").trim() || null,
            ai_contraintes: (byId("posteAiContraintes")?.value || "").trim() || null,
            niveau_education_minimum: (byId("posteCtrEduMin")?.value || "").trim() || null,
            nsf_groupe_code: (byId("posteCtrNsfGroupe")?.value || "").trim() || null,
            nsf_groupe_obligatoire: !!byId("posteCtrNsfOblig")?.checked,
            mobilite: (byId("posteCtrMobilite")?.value || "").trim() || null,
            risque_physique: (byId("posteCtrRisquePhys")?.value || "").trim() || null,
            perspectives_evolution: (byId("posteCtrPerspEvol")?.value || "").trim() || null,
            niveau_contrainte: (byId("posteCtrNivContrainte")?.value || "").trim() || null,
            detail_contrainte: (byId("posteCtrDetailContrainte")?.value || "").trim() || null,
            existing_competence_ids: (_posteCompItems || []).map(x => x.id_competence).filter(Boolean),
        };
    }

    async function ensurePosteCompCreateDomains(portal){
        if (_posteCompCreateDomainsLoaded) return;
        _posteCompCreateDomainsLoaded = true;

        try{
            const ownerId = getOwnerId();
            const url = `${portal.apiBase}/studio/catalog/domaines/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url);
            _posteCompCreateDomainItems = Array.isArray(r?.items) ? r.items : [];
        } catch(_){
            _posteCompCreateDomainItems = [];
        }
    }

    function fillPosteCompCreateDomainSelect(selectedId){
        const sel = byId("posteCompCreateDomaine");
        if (!sel) return;

        const keep = (selectedId ?? sel.value ?? "").toString().trim();

        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "—";
        sel.appendChild(opt0);

        (_posteCompCreateDomainItems || []).forEach(d => {
            const id = (d.id_domaine_competence || "").toString().trim();
            if (!id) return;

            const label = (d.titre_court || d.titre || id).toString().trim();
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = label;
            opt.title = (d.titre || label || "").toString();
            sel.appendChild(opt);
        });

        sel.value = keep || "";
    }

    function posteCompCreateEmptyCrit(){
        return { Nom:"", Eval:["","","",""] };
    }

    function parsePosteCompCreateGrille(v){
        if (!v) return null;
        if (typeof v === "object") return v;
        if (typeof v === "string"){
            try { return JSON.parse(v); } catch(_) { return null; }
        }
        return null;
    }

    function resetPosteCompCreateCrit(){
        _posteCompCreateCrit = [
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit()
        ];
        _posteCompCreateCritEditIdx = null;
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function loadPosteCompCreateCritFromJson(grille){
        const g = parsePosteCompCreateGrille(grille) || {};
        _posteCompCreateCrit = [
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit(),
            posteCompCreateEmptyCrit()
        ];

        for (let i=1;i<=4;i++){
            const k = "Critere" + i;
            const node = g[k] || {};
            const nom = (node.Nom || "").toString();
            const ev = Array.isArray(node.Eval) ? node.Eval : [];
            _posteCompCreateCrit[i-1] = {
                Nom: nom,
                Eval: [
                    (ev[0] || "").toString(),
                    (ev[1] || "").toString(),
                    (ev[2] || "").toString(),
                    (ev[3] || "").toString()
                ]
            };
        }

        _posteCompCreateCritEditIdx = null;
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function buildPosteCompCreateGrilleJson(){
        const out = {};
        for (let i=1;i<=4;i++){
            const c = (_posteCompCreateCrit && _posteCompCreateCrit[i-1]) ? _posteCompCreateCrit[i-1] : posteCompCreateEmptyCrit();
            out["Critere"+i] = {
                Nom: (c.Nom || "").toString(),
                Eval: [
                    (c.Eval?.[0] || "").toString(),
                    (c.Eval?.[1] || "").toString(),
                    (c.Eval?.[2] || "").toString(),
                    (c.Eval?.[3] || "").toString(),
                ]
            };
        }
        return out;
    }

    function usedPosteCompCreateCritCount(){
        if (!_posteCompCreateCrit) return 0;
        let n = 0;
        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            if (!c) continue;
            if ((c.Nom || "").trim()) n++;
        }
        return n;
    }

    function nextEmptyPosteCompCreateCritIndex(){
        if (!_posteCompCreateCrit) return 0;
        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const hasNom = (c?.Nom || "").trim().length > 0;
            const hasEval = (c?.Eval || []).some(x => (x || "").trim().length > 0);
            if (!hasNom && !hasEval) return i;
        }
        return -1;
    }

    function showPosteCompCreateCritEditor(idx){
        _posteCompCreateCritEditIdx = idx;

        const ed = byId("posteCompCreateCritEditor");
        if (!ed) return;

        const title = byId("posteCompCreateCritEditorTitle");
        if (title) title.textContent = `Critère ${idx+1}`;

        const c = _posteCompCreateCrit[idx] || posteCompCreateEmptyCrit();

        byId("posteCompCreateCritNom").value = c.Nom || "";
        byId("posteCompCreateCritEval1").value = c.Eval?.[0] || "";
        byId("posteCompCreateCritEval2").value = c.Eval?.[1] || "";
        byId("posteCompCreateCritEval3").value = c.Eval?.[2] || "";
        byId("posteCompCreateCritEval4").value = c.Eval?.[3] || "";

        ed.style.display = "";
    }

    function hidePosteCompCreateCritEditor(){
        const ed = byId("posteCompCreateCritEditor");
        if (ed) ed.style.display = "none";
        _posteCompCreateCritEditIdx = null;
    }

    function renderPosteCompCreateCritList(){
        const host = byId("posteCompCreateCritList");
        const btnAdd = byId("btnPosteCompCreateAddCrit");
        if (!host) return;

        if (!_posteCompCreateCrit){
            _posteCompCreateCrit = [
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit()
            ];
        }

        host.innerHTML = "";

        const used = usedPosteCompCreateCritCount();
        if (btnAdd){
            btnAdd.disabled = used >= 4;
            btnAdd.style.opacity = btnAdd.disabled ? ".6" : "";
            btnAdd.title = btnAdd.disabled ? "Maximum 4 critères." : "";
        }

        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const nom = (c?.Nom || "").trim();
            if (!nom) continue;

            const acc = document.createElement("div");
            acc.className = "sb-acc";

            const head = document.createElement("button");
            head.type = "button";
            head.className = "sb-acc-head";
            head.addEventListener("click", () => acc.classList.toggle("is-open"));

            const t = document.createElement("div");
            t.className = "sb-acc-title";
            t.textContent = `Critère ${i+1} – ${nom}`;
            head.appendChild(t);

            const body = document.createElement("div");
            body.className = "sb-acc-body";

            const ul = document.createElement("div");
            ul.className = "sb-crit-evals";

            const labels = ["Niveau 1","Niveau 2","Niveau 3","Niveau 4"];
            for (let k=0;k<4;k++){
                const row = document.createElement("div");
                row.className = "sb-crit-eval-row";

                const lab = document.createElement("div");
                lab.className = "label";
                lab.textContent = labels[k];

                const txt = document.createElement("div");
                txt.textContent = (c.Eval?.[k] || "").toString();

                row.appendChild(lab);
                row.appendChild(txt);
                ul.appendChild(row);
            }

            const actions = document.createElement("div");
            actions.className = "sb-acc-actions";

            const btnEdit = document.createElement("button");
            btnEdit.type = "button";
            btnEdit.className = "sb-btn sb-btn--soft sb-btn--xs";
            btnEdit.textContent = "Modifier";
            btnEdit.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPosteCompCreateCritEditor(i);
                acc.classList.add("is-open");
            });

            actions.appendChild(btnEdit);
            body.appendChild(ul);
            body.appendChild(actions);
            acc.appendChild(head);
            acc.appendChild(body);
            host.appendChild(acc);
        }

        if (!host.children.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucun critère. Ajoute au moins 1 critère.";
            host.appendChild(empty);
        }
    }

    function savePosteCompCreateCritFromEditor(portal){
        if (_posteCompCreateCritEditIdx === null || _posteCompCreateCritEditIdx === undefined) return;

        const nom = (byId("posteCompCreateCritNom").value || "").trim();
        const e1 = (byId("posteCompCreateCritEval1").value || "").trim();
        const e2 = (byId("posteCompCreateCritEval2").value || "").trim();
        const e3 = (byId("posteCompCreateCritEval3").value || "").trim();
        const e4 = (byId("posteCompCreateCritEval4").value || "").trim();

        if (!nom){
            portal.showAlert("error", "Nom du critère obligatoire.");
            return;
        }
        if (!e1 || !e2 || !e3 || !e4){
            portal.showAlert("error", "Les 4 niveaux d’évaluation sont obligatoires.");
            return;
        }

        _posteCompCreateCrit[_posteCompCreateCritEditIdx] = { Nom: nom, Eval:[e1,e2,e3,e4] };
        hidePosteCompCreateCritEditor();
        renderPosteCompCreateCritList();
    }

    function validatePosteCompCreateCritBeforeSave(portal){
        if (!_posteCompCreateCrit){
            _posteCompCreateCrit = [
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit(),
                posteCompCreateEmptyCrit()
            ];
        }

        if (usedPosteCompCreateCritCount() < 1){
            portal.showAlert("error", "Ajoute au moins 1 critère d’évaluation.");
            return false;
        }

        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const nom = (c?.Nom || "").trim();
            const ev = c?.Eval || ["","","",""];
            const anyEval = ev.some(x => (x || "").trim().length > 0);

            if (!nom && !anyEval) continue;

            if (!nom){
                portal.showAlert("error", `Critère ${i+1} : nom obligatoire.`);
                return false;
            }
            for (let k=0;k<4;k++){
                if (!(ev[k] || "").trim()){
                    portal.showAlert("error", `Critère ${i+1} : niveau ${k+1} obligatoire.`);
                    return false;
                }
            }
        }
        return true;
    }

    function bindPosteCompCreateMaxLen(id, max){
        const el = byId(id);
        if (!el || el._sbMaxBound) return;
        el._sbMaxBound = true;

        el.setAttribute("maxlength", String(max));

        el.addEventListener("input", () => {
            const v = (el.value || "");
            if (v.length > max) el.value = v.slice(0, max);
        });
    }

    function closePosteCompCreateModal(){
        closeModal("modalPosteCompCreate");
        _posteCompCreateCtx = null;
        hidePosteCompCreateCritEditor();
    }

    async function openPosteCompCreateModalFromAi(portal, idx, addAfter){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;

        _posteCompCreateCtx = {
            idx: idx,
            addAfter: !!addAfter,
            draft: JSON.parse(JSON.stringify(it || {}))
        };

        await ensurePosteCompCreateDomains(portal);

        const badge = byId("posteCompCreateBadge");
        if (badge){
            badge.style.display = "none";
            badge.textContent = "";
        }

        byId("posteCompCreateTitle").textContent = "Créer une compétence";
        byId("posteCompCreateSub").textContent = "Brouillon proposé par l’IA. Tu valides / ajustes avant création.";

        byId("posteCompCreateIntitule").value = (it.intitule || "");
        byId("posteCompCreateDesc").value = (it.description || "");
        byId("posteCompCreateEtat").value = "à valider";
        byId("posteCompCreateNivA").value = (it.niveaua || "");
        byId("posteCompCreateNivB").value = (it.niveaub || "");
        byId("posteCompCreateNivC").value = (it.niveauc || "");

        fillPosteCompCreateDomainSelect(it.domaine_id || "");
        loadPosteCompCreateCritFromJson(it.grille_evaluation || null);

        openModal("modalPosteCompCreate");
    }

    function promoteMissingAiCompetenceToExisting(meta){
        if (!_posteCompCreateCtx) return;

        const idx = _posteCompCreateCtx.idx;
        const added = !!meta?.added;
        const etat = (meta?.etat || "à valider").toString();
        const title = (byId("posteCompCreateIntitule")?.value || "").trim();
        const domainId = (byId("posteCompCreateDomaine")?.value || "").trim();
        const domainMeta = getPosteCompCreateDomainMetaById(domainId);
        const domainLabel = (domainMeta?.titre_court || domainMeta?.titre || "").toString().trim();

        const missing = Array.isArray(_posteCompAiResults?.missing) ? _posteCompAiResults.missing : [];
        const src = (missing[idx] || _posteCompCreateCtx.draft || {});

        if (idx >= 0 && idx < missing.length){
            missing.splice(idx, 1);
        }

        const existing = Array.isArray(_posteCompAiResults?.existing) ? _posteCompAiResults.existing : [];
        existing.unshift({
            id_comp: meta?.id_comp || "",
            code: meta?.code || "",
            intitule: title || (src.intitule || ""),
            domaine: domainId || (src.domaine_id || ""),
            domaine_titre_court: domainLabel || (src.domaine_label || ""),
            domaine_couleur: domainMeta?.couleur || src.domaine_couleur || null,
            etat: etat,
            recommended_level: (src.recommended_level || "B"),
            recommended_level_label: (src.recommended_level_label || "Avancé"),
            freq_usage: parseInt(src.freq_usage ?? 0, 10) || 0,
            impact_resultat: parseInt(src.impact_resultat ?? 0, 10) || 0,
            dependance: parseInt(src.dependance ?? 0, 10) || 0,
            _already_added: added
        });

        _posteCompAiResults.existing = existing;
        _posteCompAiResults.missing = missing;
    }

    async function savePosteCompCreateModal(portal, addAfter){
        if (!_posteCompCreateCtx) return;

        const ownerId = getOwnerId();
        const title = (byId("posteCompCreateIntitule").value || "").trim();
        const dom = (byId("posteCompCreateDomaine").value || "").trim();
        const etat = (byId("posteCompCreateEtat").value || "à valider").trim();
        const desc = (byId("posteCompCreateDesc").value || "").trim();
        const a = (byId("posteCompCreateNivA").value || "").trim();
        const b = (byId("posteCompCreateNivB").value || "").trim();
        const c = (byId("posteCompCreateNivC").value || "").trim();

        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return;
        }

        if (!validatePosteCompCreateCritBeforeSave(portal)) return;

        const btnMain = addAfter ? byId("btnPosteCompCreateAdd") : byId("btnPosteCompCreateOnly");
        if (btnMain){
            btnMain.disabled = true;
            btnMain.style.opacity = ".6";
        }

        try{
            const grille = buildPosteCompCreateGrilleJson();

            const created = await portal.apiJson(
                `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        intitule: title,
                        domaine: dom || null,
                        etat: etat || null,
                        description: desc || null,
                        niveaua: a || null,
                        niveaub: b || null,
                        niveauc: c || null,
                        grille_evaluation: grille
                    })
                }
            );

            if (addAfter){
                const pid = await ensureEditingPoste(portal);
                const draft = _posteCompCreateCtx?.draft || {};
                await portal.apiJson(
                    `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`,
                    {
                        method: "POST",
                        headers: { "Content-Type":"application/json" },
                        body: JSON.stringify({
                            id_competence: created.id_comp,
                            niveau_requis: (draft.recommended_level || "B"),
                            freq_usage: parseInt(draft.freq_usage ?? 0, 10) || 0,
                            impact_resultat: parseInt(draft.impact_resultat ?? 0, 10) || 0,
                            dependance: parseInt(draft.dependance ?? 0, 10) || 0
                        })
                    }
                );
                await loadPosteCompetences(portal);
            }

            promoteMissingAiCompetenceToExisting({
                id_comp: created.id_comp,
                code: created.code,
                etat: etat,
                added: !!addAfter
            });
            renderPosteCompAiResults();

            closePosteCompCreateModal();
            portal.showAlert("", "");
        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        } finally {
            if (btnMain){
                btnMain.disabled = false;
                btnMain.style.opacity = "";
            }
        }
    }

    function getPosteCompCreateDomainMetaById(id){
        const did = String(id || "").trim();
        if (!did) return null;
        return (_posteCompCreateDomainItems || []).find(x => String(x?.id_domaine_competence || "").trim() === did) || null;
    }

    function buildAiCompDomainBadge(label, couleur){
        const txt = String(label || "").trim();
        if (!txt) return null;

        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--comp-domain";

        const dot = document.createElement("span");
        dot.className = "sb-dot";

        const rgb = argbIntToRgbTuple(couleur);
        if (rgb){
            dom.style.setProperty("--sb-domain-rgb", rgb.css);
        }

        dom.appendChild(dot);
        dom.appendChild(document.createTextNode(txt));
        return dom;
    }

    function renderPosteCompAiResults(){
        const summary = byId("posteCompAiSummary");
        const exWrap = byId("posteCompAiExistingWrap");
        const miWrap = byId("posteCompAiMissingWrap");
        const exList = byId("posteCompAiExistingList");
        const miList = byId("posteCompAiMissingList");
        if (!summary || !exWrap || !miWrap || !exList || !miList) return;

        const existing = Array.isArray(_posteCompAiResults?.existing) ? _posteCompAiResults.existing : [];
        const missing = Array.isArray(_posteCompAiResults?.missing) ? _posteCompAiResults.missing : [];

        summary.textContent = `${existing.length} compétence(s) trouvée(s) dans le référentiel, ${missing.length} à créer.`;
        summary.style.display = "";

        exList.innerHTML = "";
        miList.innerHTML = "";
        exWrap.style.display = existing.length ? "" : "none";
        miWrap.style.display = missing.length ? "" : "none";

        existing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = (it.code || "—");

            const wrap = document.createElement("div");

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = (it.intitule || "");

            const meta = document.createElement("div");
            meta.style.display = "flex";
            meta.style.gap = "8px";
            meta.style.flexWrap = "wrap";
            meta.style.margin = "6px 0 0 0";

            const dom = buildAiCompDomainBadge(it.domaine_titre_court || "", it.domaine_couleur);
            if (dom) meta.appendChild(dom);

            if (((it.etat || "").toLowerCase()) === "à valider"){
                const et = document.createElement("span");
                et.className = "sb-badge sb-badge--accent-soft";
                et.textContent = "À valider";
                meta.appendChild(et);
            }

            wrap.appendChild(title);
            wrap.appendChild(meta);

            left.appendChild(code);
            left.appendChild(wrap);

            const right = document.createElement("div");
            right.className = "sb-row-right";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-btn sb-btn--accent sb-btn--xs";
            btn.textContent = it._already_added ? "Ajoutée" : "Ajouter";
            btn.disabled = !!it._already_added;
            btn.style.opacity = it._already_added ? ".6" : "";
            btn.addEventListener("click", async () => {
                if (it._already_added) return;
                try { await addExistingCompetenceFromAi(window.portal, idx); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btn);
            row.appendChild(left);
            row.appendChild(right);
            exList.appendChild(row);
        });

        missing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card";
            row.style.alignItems = "flex-start";

            const left = document.createElement("div");
            left.className = "sb-row-left";
            left.style.alignItems = "flex-start";

            const wrap = document.createElement("div");
            wrap.style.minWidth = "0";

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = (it.intitule || "");

            const meta = document.createElement("div");
            meta.style.display = "flex";
            meta.style.gap = "8px";
            meta.style.flexWrap = "wrap";
            meta.style.margin = "6px 0 0 0";

            const dom = buildAiCompDomainBadge(it.domaine_label || "", it.domaine_couleur);
            if (dom) meta.appendChild(dom);

            const desc = document.createElement("div");
            desc.className = "card-sub";
            desc.style.margin = "8px 0 0 0";
            desc.textContent = (it.description || "");

            wrap.appendChild(title);
            if (meta.childNodes.length) wrap.appendChild(meta);
            if ((it.description || "").trim()) wrap.appendChild(desc);

            left.appendChild(wrap);

            const right = document.createElement("div");
            right.className = "sb-actions";
            right.style.display = "flex";
            right.style.flexDirection = "column";
            right.style.gap = "8px";
            right.style.flexShrink = "0";

            const btnAdd = document.createElement("button");
            btnAdd.type = "button";
            btnAdd.className = "sb-btn sb-btn--accent sb-btn--xs";
            btnAdd.textContent = "Créer et ajouter";
            btnAdd.addEventListener("click", async () => {
                try { await openPosteCompCreateModalFromAi(window.portal, idx, true); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            const btnOnly = document.createElement("button");
            btnOnly.type = "button";
            btnOnly.className = "sb-btn sb-btn--soft sb-btn--xs";
            btnOnly.textContent = "Créer seulement";
            btnOnly.addEventListener("click", async () => {
                try { await openPosteCompCreateModalFromAi(window.portal, idx, false); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btnAdd);
            right.appendChild(btnOnly);

            row.appendChild(left);
            row.appendChild(right);
            miList.appendChild(row);
        });
    }

    async function openPosteCompAiModal(portal){
        const title = (byId("posteIntitule")?.value || "").trim();
        if (!title){
            portal.showAlert("error", "Renseigne au moins l’intitulé du poste avant la recherche IA.");
            return;
        }

        resetPosteCompAiUi();

        const loading = byId("posteCompAiLoading");
        if (loading) loading.style.display = "";

        openIaBusyOverlay(
            "Recherche IA des compétences",
            "Analyse du poste, recherche web et rapprochement avec le catalogue de compétences..."
        );

        try{
            const ownerId = getOwnerId();
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_search`;
            const res = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(buildPosteCompAiPayload()),
            });
            _posteCompAiResults = {
                existing: Array.isArray(res?.existing) ? res.existing : [],
                missing: Array.isArray(res?.missing) ? res.missing : [],
            };
            renderPosteCompAiResults();
            openModal("modalPosteCompAi");
        } finally {
            closeIaBusyOverlay();
            if (loading) loading.style.display = "none";
        }
    }

    async function ensureEditingPoste(portal){
        if (_posteModalMode === "edit" && _editingPosteId) return _editingPosteId;
        await savePosteFromModal(portal, { keepOpen: true, silent: true, statusMessage: "Poste créé." });
        if (!_editingPosteId) throw new Error("Le poste n’a pas pu être créé avant l’ajout des compétences.");
        return _editingPosteId;
    }

    async function addExistingCompetenceFromAi(portal, idx){
        const it = (_posteCompAiResults?.existing || [])[idx];
        if (!it || !it.id_comp) return;

        const pid = await ensureEditingPoste(portal);
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;

        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id_competence: it.id_comp,
                niveau_requis: it.recommended_level || "B",
                freq_usage: parseInt(it.freq_usage ?? 0, 10) || 0,
                impact_resultat: parseInt(it.impact_resultat ?? 0, 10) || 0,
                dependance: parseInt(it.dependance ?? 0, 10) || 0,
            }),
        });

        it._already_added = true;
        renderPosteCompAiResults();
        await loadPosteCompetences(portal);
    }

    async function createMissingCompetenceFromAi(portal, idx){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;
        const pid = await ensureEditingPoste(portal);
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_create`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id_poste: pid, draft: it }),
        });
        await loadPosteCompetences(portal);
        const btn = document.querySelector(`[data-ai-missing-create="${idx}"]`);
        if (btn){ btn.disabled = true; btn.textContent = `Créée (${r?.code || "OK"})`; }
    }

    // ------------------------------------------------------
    // Poste > Exigences > Compétences
    // ------------------------------------------------------
    async function loadPosteCompetences(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        const data = await portal.apiJson(url);

        const items = Array.isArray(data?.items) ? data.items.slice() : [];

        items.sort((a, b) => {
            const critA = Number.isFinite(parseInt(a?.poids_criticite ?? "", 10))
                ? parseInt(a.poids_criticite, 10)
                : -1;
            const critB = Number.isFinite(parseInt(b?.poids_criticite ?? "", 10))
                ? parseInt(b.poids_criticite, 10)
                : -1;

            if (critA !== critB) return critB - critA;

            const intA = (a?.intitule || "").toString().trim();
            const intB = (b?.intitule || "").toString().trim();
            const cmpInt = intA.localeCompare(intB, "fr", { sensitivity: "base" });
            if (cmpInt !== 0) return cmpInt;

            const codeA = (a?.code || "").toString().trim();
            const codeB = (b?.code || "").toString().trim();
            return codeA.localeCompare(codeB, "fr", { sensitivity: "base" });
        });

        _posteCompItems = items;
        renderPosteCompetences();
    }
    
    function renderPosteCompetences(){
        const tb = byId("posteCompTbody");
        const empty = byId("posteCompEmpty");
        if (!tb) return;

        const levelMeta = (niv) => {
            const v = String(niv || "").trim().toUpperCase();
            if (v === "A") return { text: "A - Initial", cls: "sb-badge--niv-a" };
            if (v === "B") return { text: "B - Avancé", cls: "sb-badge--niv-b" };
            if (v === "C") return { text: "C - Expert", cls: "sb-badge--niv-c" };
            return { text: "—", cls: "" };
        };

        const critMeta = (score) => {
            const n = parseInt(score ?? 0, 10);
            if (Number.isNaN(n)) return { text: "—", cls: "sb-crit-badge--low" };
            if (n >= 70) return { text: String(n), cls: "sb-crit-badge--high" };
            if (n >= 35) return { text: String(n), cls: "sb-crit-badge--mid" };
            return { text: String(n), cls: "sb-crit-badge--low" };
        };

        const iconEdit = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
        `;

        const iconTrash = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/>
                <path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
            </svg>
        `;

        const q = (_posteCompSearch || "").toLowerCase();
        const items = (_posteCompItems || []).filter(it => {
            if (!q) return true;
            const s = `${it.code || ""} ${it.intitule || ""}`.toLowerCase();
            return s.includes(q);
        });

        tb.innerHTML = "";

        if (!items.length){
            if (empty) empty.style.display = "";
            return;
        }
        if (empty) empty.style.display = "none";

        items.forEach(it => {
            const tr = document.createElement("tr");

            const tdComp = document.createElement("td");
            const compWrap = document.createElement("div");
            compWrap.className = "sb-comp-cell";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = it.code || "—";

            const title = document.createElement("div");
            title.className = "sb-comp-cell__title";
            title.textContent = it.intitule || "";

            compWrap.appendChild(code);
            compWrap.appendChild(title);
            tdComp.appendChild(compWrap);

            const tdNiv = document.createElement("td");
            tdNiv.style.textAlign = "center";
            const lvl = levelMeta(it.niveau_requis);
            const bn = document.createElement("span");
            bn.className = `sb-badge sb-badge--niv ${lvl.cls}`.trim();
            bn.textContent = lvl.text;
            tdNiv.appendChild(bn);

            const tdCrit = document.createElement("td");
            tdCrit.style.textAlign = "center";
            const crit = critMeta(it.poids_criticite);
            const bc = document.createElement("span");
            bc.className = `sb-badge sb-crit-badge ${crit.cls}`.trim();
            bc.textContent = crit.text;
            tdCrit.appendChild(bc);

            const tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";

            if (isAdmin()){
                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const btnEdit = document.createElement("button");
                btnEdit.type = "button";
                btnEdit.className = "sb-icon-btn";
                btnEdit.title = "Modifier";
                btnEdit.setAttribute("aria-label", "Modifier");
                btnEdit.innerHTML = iconEdit;
                btnEdit.addEventListener("click", () => openPosteCompEditModal(it));

                const btnRem = document.createElement("button");
                btnRem.type = "button";
                btnRem.className = "sb-icon-btn sb-icon-btn--danger";
                btnRem.title = "Retirer";
                btnRem.setAttribute("aria-label", "Retirer");
                btnRem.innerHTML = iconTrash;
                btnRem.addEventListener("click", async () => {
                    if (!confirm(`Retirer la compétence "${it.code || ""} – ${it.intitule || ""}" du poste ?`)) return;
                    try { await removePosteCompetence(window.portal, it.id_competence); }
                    catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnRem);
                tdAct.appendChild(actions);
            } else {
                tdAct.textContent = "—";
            }

            tr.appendChild(tdComp);
            tr.appendChild(tdNiv);
            tr.appendChild(tdCrit);
            tr.appendChild(tdAct);

            tb.appendChild(tr);
        });
    }

    function openPosteCompAddModal(){
        if (!isAdmin()) return;
        if (!_editingPosteId) return;

        byId("posteCompAddSearch").value = "";
        _posteCompAddSearch = "";
        byId("posteCompAddList").innerHTML = "";
        const cb = byId("posteCompAddShowToValidate");
        if (cb) cb.checked = false;
        _posteCompAddIncludeToValidate = false;


        openModal("modalPosteCompAdd");
        loadPosteCompAddList(window.portal).catch(()=>{});
    }

    function refreshPosteCompAddDomainOptions(items){
        const sel = byId("posteCompAddDomain");
        if (!sel) return;

        const keep = (sel.value || "").trim();

        const map = new Map(); // id -> label
        (items || []).forEach(it => {
            const id = (it.domaine || "").toString().trim() || "__none__";
            const label = (it.domaine_titre_court || it.domaine || "").toString().trim() || "Sans domaine";
            if (!map.has(id)) map.set(id, label);
        });

        // reset options
        sel.innerHTML = "";
        sel.appendChild(new Option("Tous", ""));
        sel.appendChild(new Option("Sans domaine", "__none__"));

        Array.from(map.entries())
            .filter(([id]) => id !== "__none__")
            .sort((a,b) => a[1].localeCompare(b[1], "fr", { sensitivity:"base" }))
            .forEach(([id,label]) => sel.appendChild(new Option(label, id)));

        // restore
        if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
        else sel.value = "";
        _posteCompAddDomain = (sel.value || "").trim();
        }

        function applyPosteCompAddDomainFilter(items){
        const dom = (_posteCompAddDomain || "").trim();
        if (!dom) return (items || []).slice();

        if (dom === "__none__"){
            return (items || []).filter(it => !((it.domaine || "").toString().trim()));
        }
        return (items || []).filter(it => ((it.domaine || "").toString().trim() === dom));
    }

    async function loadPosteCompAddList(portal){
        const ownerId = getOwnerId();
        const url =
        `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}` +
        `?q=${encodeURIComponent(_posteCompAddSearch)}` +
        `&show=active`;

        const data = await portal.apiJson(url);
        let items = data.items || [];

        // Filtre etat: active/valide (toujours) + à valider si checkbox
        items = items.filter(it => {
        const et = (it.etat || "").toLowerCase();
        if (et === "active" || et === "valide") return true;
        if (_posteCompAddIncludeToValidate && et === "à valider") return true;
        return false;
        });

        // Exclure déjà rattachées (actives)
        const existing = new Set((_posteCompItems || []).map(x => x.id_competence));
        items = items.filter(it => !existing.has(it.id_comp));

        _posteCompAddItemsAll = items;
        refreshPosteCompAddDomainOptions(_posteCompAddItemsAll);
        _posteCompAddItems = applyPosteCompAddDomainFilter(_posteCompAddItemsAll);
        renderPosteCompAddList();
    }

    function renderPosteCompAddList(){
        const host = byId("posteCompAddList");
        if (!host) return;
        host.innerHTML = "";

        const items = _posteCompAddItems || [];
        if (!items.length){
        const e = document.createElement("div");
        e.className = "card-sub";
        e.textContent = "Aucune compétence à afficher.";
        host.appendChild(e);
        return;
        }

        items.forEach(it => {
        const row = document.createElement("div");
        row.className = "sb-row-card";

        const left = document.createElement("div");
        left.className = "sb-row-left";

        const code = document.createElement("span");
        code.className = "sb-badge sb-badge--comp";
        code.textContent = it.code || "—";

        const title = document.createElement("div");
        title.className = "sb-row-title";
        title.textContent = it.intitule || "";

        left.appendChild(code);
        left.appendChild(title);

        const right = document.createElement("div");
        right.className = "sb-row-right";

        if ((it.etat || "").toLowerCase() === "à valider"){
            const v = document.createElement("span");
            v.className = "sb-badge sb-badge--accent-soft";
            v.textContent = "À valider";
            right.appendChild(v);
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sb-btn sb-btn--accent sb-btn--xs";
        btn.textContent = "Ajouter";
        btn.addEventListener("click", () => {
            closeModal("modalPosteCompAdd");
            openPosteCompEditModal({
            id_competence: it.id_comp,
            code: it.code,
            intitule: it.intitule,
            etat: it.etat,
            domaine: it.domaine,
            domaine_titre_court: it.domaine_titre_court,
            domaine_couleur: it.domaine_couleur,

            // valeurs ref (on les charge au besoin via detail)
            niveaua: "",
            niveaub: "",
            niveauc: "",

            // defaults association
            niveau_requis: "B",
            freq_usage: 0,
            impact_resultat: 0,
            dependance: 0,
            poids_criticite: null,
            }, true);
        });

        row.appendChild(left);
        row.appendChild(right);
        row.appendChild(btn);

        host.appendChild(row);
        });
    }

    async function fetchCompetenceDetail(portal, id_comp){
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/catalog/competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(id_comp)}`;
        return await portal.apiJson(url);
    }

    function openPosteCompEditModal(it, isNew){
        _posteCompEdit = { ...(it || {}) };
        _posteCompEdit._isNew = !!isNew;

        // Header badge code + titre
        const b = byId("posteCompEditBadge");
        const code = (_posteCompEdit.code || "").toString().trim();
        if (b){
        b.textContent = code;
        b.style.display = code ? "" : "none";
        }
        byId("posteCompEditTitle").textContent = (_posteCompEdit.intitule || "Compétence").toString();

        // Domaine badge
        const dom = byId("posteCompEditDomain");
        const domTxt = byId("posteCompEditDomainTxt");
        const domLabel = (_posteCompEdit.domaine_titre_court || _posteCompEdit.domaine || "").toString().trim();
        if (dom && domTxt){
        if (domLabel){
            domTxt.textContent = domLabel;
            const rgb = argbIntToRgbTuple(_posteCompEdit.domaine_couleur);
            if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb.css);
            dom.style.display = "";
        } else {
            dom.style.display = "none";
        }
        }

        // Ref niveaux (lecture)
        byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "—");
        byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "—");
        byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "—");

        // Form
        setPosteCompEditNiv(_posteCompEdit.niveau_requis || "B");

        byId("posteCompEditFreq").value = String(_posteCompEdit.freq_usage ?? 0);
        byId("posteCompEditImpact").value = String(_posteCompEdit.impact_resultat ?? 0);
        byId("posteCompEditDep").value = String(_posteCompEdit.dependance ?? 0);

        refreshPosteCompEditCritDisplay();

        openModal("modalPosteCompEdit");

        // Charge le détail compétence si on n'a pas les niveaux A/B/C
        if (!_posteCompEdit.niveaua && _posteCompEdit.id_competence){
        (async () => {
            try{
            const d = await fetchCompetenceDetail(window.portal, _posteCompEdit.id_competence);
            _posteCompEdit.niveaua = d.niveaua || "";
            _posteCompEdit.niveaub = d.niveaub || "";
            _posteCompEdit.niveauc = d.niveauc || "";
            byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "—");
            byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "—");
            byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "—");
            } catch(_){}
        })();
        }
    }

    function refreshPosteCompEditCritDisplay(){
        const fu = parseInt(byId("posteCompEditFreq")?.value || "0", 10) || 0;
        const im = parseInt(byId("posteCompEditImpact")?.value || "0", 10) || 0;
        const de = parseInt(byId("posteCompEditDep")?.value || "0", 10) || 0;

        const f = Math.max(0, Math.min(10, fu));
        const i = Math.max(0, Math.min(10, im));
        const d = Math.max(0, Math.min(10, de));

        const elF = byId("posteCompEditFreqTxt");
        const elI = byId("posteCompEditImpactTxt");
        const elD = byId("posteCompEditDepTxt");

        if (elF) elF.textContent = `${f}/10`;
        if (elI) elI.textContent = `${i}/10`;
        if (elD) elD.textContent = `${d}/10`;

        const dd = calcCritDisplay(f, i, d);
        setPosteCompCritRing(dd.total);
    }

    async function savePosteCompEdit(portal){
        if (!_editingPosteId || !_posteCompEdit) return;

        const ownerId = getOwnerId();

        const niv = (document.querySelector('input[name="posteCompEditNiv"]:checked')?.value || "B").trim().toUpperCase();
        const fu = parseInt(byId("posteCompEditFreq").value || "0", 10) || 0;
        const im = parseInt(byId("posteCompEditImpact").value || "0", 10) || 0;
        const de = parseInt(byId("posteCompEditDep").value || "0", 10) || 0;

        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
            id_competence: _posteCompEdit.id_competence,
            niveau_requis: niv,
            freq_usage: fu,
            impact_resultat: im,
            dependance: de
        })
        });

        closeModal("modalPosteCompEdit");
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    async function removePosteCompetence(portal, id_comp){
        if (!_editingPosteId) return;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_comp)}/remove`;
        await portal.apiJson(url, { method: "POST" });
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    function formatValidityMonths(v){
        const n = parseInt(v ?? "", 10);
        if (!Number.isFinite(n) || n <= 0) return "—";
        return `${n} mois`;
    }

    function getPosteCertValidityLabel(it){
        const ov = parseInt(it?.validite_override ?? "", 10);
        if (Number.isFinite(ov) && ov > 0) return `${ov} mois`;
        const base = parseInt(it?.duree_validite ?? "", 10);
        if (Number.isFinite(base) && base > 0) return `${base} mois`;
        return "—";
    }

    function buildPosteCertBaseInfo(it){
        const parts = [];
        const base = formatValidityMonths(it?.duree_validite);
        const delai = formatValidityMonths(it?.delai_renouvellement);

        parts.push(`Validité catalogue : ${base}`);
        if (delai !== "—") parts.push(`Délai de renouvellement : ${delai}`);

        return parts.join(" · ");
    }

    function buildPosteCertAddMeta(it){
        const parts = [];

        const cat = (it?.categorie || "").toString().trim();
        if (cat) parts.push(`Catégorie : ${cat}`);

        parts.push(`Validité catalogue : ${formatValidityMonths(it?.duree_validite)}`);

        const delai = formatValidityMonths(it?.delai_renouvellement);
        if (delai !== "—") parts.push(`Délai de renouvellement : ${delai}`);

        return parts.join(" · ");
    }

    async function loadPosteCertifications(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        const data = await portal.apiJson(url);
        _posteCertItems = data.items || [];
        renderPosteCertifications();
    }

    function renderPosteCertifications(){
        const tb = byId("posteCertTbody");
        const empty = byId("posteCertEmpty");
        if (!tb) return;

        const iconEdit = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
        `;

        const iconTrash = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/>
                <path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
            </svg>
        `;

        const q = (_posteCertSearch || "").toLowerCase();
        const items = (_posteCertItems || []).filter(it => {
            if (!q) return true;
            const s = `${it.nom_certification || ""} ${it.categorie || ""} ${it.commentaire || ""}`.toLowerCase();
            return s.includes(q);
        });

        tb.innerHTML = "";

        if (!items.length){
            if (empty) empty.style.display = "";
            return;
        }
        if (empty) empty.style.display = "none";

        items.forEach(it => {
            const tr = document.createElement("tr");

            const tdCat = document.createElement("td");
            const cat = (it.categorie || "").toString().trim();
            if (cat){
                const b = document.createElement("span");
                b.className = "sb-badge sb-badge--poste-soft";
                b.textContent = cat;
                tdCat.appendChild(b);
            } else {
                tdCat.textContent = "—";
            }

            const tdNom = document.createElement("td");
            const certWrap = document.createElement("div");
            certWrap.className = "sb-comp-cell";

            const title = document.createElement("div");
            title.className = "sb-comp-cell__title";
            title.textContent = it.nom_certification || "";

            certWrap.appendChild(title);
            tdNom.appendChild(certWrap);

            const tdVal = document.createElement("td");
            tdVal.style.textAlign = "center";
            tdVal.textContent = getPosteCertValidityLabel(it);
            if (it.validite_override !== null && it.validite_override !== undefined && String(it.validite_override).trim() !== ""){
                tdVal.title = `Validité catalogue : ${formatValidityMonths(it.duree_validite)}`;
            }

            const tdLvl = document.createElement("td");
            tdLvl.style.textAlign = "center";
            const bl = document.createElement("span");
            bl.className = `sb-badge ${String(it.niveau_exigence || "").toLowerCase() === "souhaité" ? "sb-badge--poste-soft" : "sb-badge--accent-soft"}`;
            bl.textContent = it.niveau_exigence || "—";
            tdLvl.appendChild(bl);

            const tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";

            if (isAdmin()){
                const actions = document.createElement("div");
                actions.className = "sb-icon-actions";

                const btnEdit = document.createElement("button");
                btnEdit.type = "button";
                btnEdit.className = "sb-icon-btn";
                btnEdit.title = "Modifier";
                btnEdit.setAttribute("aria-label", "Modifier");
                btnEdit.innerHTML = iconEdit;
                btnEdit.addEventListener("click", () => openPosteCertEditModal(it));

                const btnRem = document.createElement("button");
                btnRem.type = "button";
                btnRem.className = "sb-icon-btn sb-icon-btn--danger";
                btnRem.title = "Retirer";
                btnRem.setAttribute("aria-label", "Retirer");
                btnRem.innerHTML = iconTrash;
                btnRem.addEventListener("click", async () => {
                    if (!confirm(`Retirer la certification "${it.nom_certification || ""}" du poste ?`)) return;
                    try { await removePosteCertification(window.portal, it.id_certification); }
                    catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnRem);
                tdAct.appendChild(actions);
            } else {
                tdAct.textContent = "—";
            }

            tr.appendChild(tdCat);
            tr.appendChild(tdNom);
            tr.appendChild(tdVal);
            tr.appendChild(tdLvl);
            tr.appendChild(tdAct);

            tb.appendChild(tr);
        });
    }

    function openPosteCertAddModal(){
        if (!isAdmin()) return;
        if (!_editingPosteId) return;

        byId("posteCertAddSearch").value = "";
        _posteCertAddSearch = "";
        _posteCertAddCategory = "";
        byId("posteCertAddList").innerHTML = "";

        const sel = byId("posteCertAddCategory");
        if (sel) sel.value = "";

        openModal("modalPosteCertAdd");
        loadPosteCertAddList(window.portal).catch(()=>{});
    }

    function refreshPosteCertAddCategoryOptions(items){
        const sel = byId("posteCertAddCategory");
        if (!sel) return;

        const keep = (sel.value || "").trim();
        const map = new Map();

        (items || []).forEach(it => {
            const cat = (it.categorie || "").toString().trim() || "__none__";
            const label = (it.categorie || "").toString().trim() || "Sans catégorie";
            if (!map.has(cat)) map.set(cat, label);
        });

        sel.innerHTML = "";
        sel.appendChild(new Option("Toutes", ""));
        sel.appendChild(new Option("Sans catégorie", "__none__"));

        Array.from(map.entries())
            .filter(([id]) => id !== "__none__")
            .sort((a,b) => a[1].localeCompare(b[1], "fr", { sensitivity:"base" }))
            .forEach(([id, label]) => sel.appendChild(new Option(label, id)));

        if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
        else sel.value = "";

        _posteCertAddCategory = (sel.value || "").trim();
    }

    function applyPosteCertAddCategoryFilter(items){
        const cat = (_posteCertAddCategory || "").trim();
        if (!cat) return (items || []).slice();

        if (cat === "__none__"){
            return (items || []).filter(it => !((it.categorie || "").toString().trim()));
        }
        return (items || []).filter(it => ((it.categorie || "").toString().trim() === cat));
    }

    async function loadPosteCertAddList(portal){
        const ownerId = getOwnerId();
        const url =
            `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}` +
            `?q=${encodeURIComponent(_posteCertAddSearch)}`;

        const data = await portal.apiJson(url);
        let items = data.items || [];

        const existing = new Set((_posteCertItems || []).map(x => x.id_certification));
        items = items.filter(it => !existing.has(it.id_certification));

        _posteCertAddItemsAll = items;
        refreshPosteCertAddCategoryOptions(_posteCertAddItemsAll);
        _posteCertAddItems = applyPosteCertAddCategoryFilter(_posteCertAddItemsAll);
        renderPosteCertAddList();
    }

    function renderPosteCertAddList(){
        const host = byId("posteCertAddList");
        if (!host) return;
        host.innerHTML = "";

        const items = _posteCertAddItems || [];
        if (!items.length){
            const e = document.createElement("div");
            e.className = "card-sub";
            e.textContent = "Aucune certification à afficher.";
            host.appendChild(e);
            return;
        }

        items.forEach(it => {
            const row = document.createElement("div");
            row.className = "sb-row-card";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const wrap = document.createElement("div");

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = it.nom_certification || "";

            const meta = document.createElement("div");
            meta.className = "card-sub";
            meta.style.margin = "4px 0 0 0";
            meta.textContent = buildPosteCertAddMeta(it);

            wrap.appendChild(title);
            wrap.appendChild(meta);
            left.appendChild(wrap);

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-btn sb-btn--accent sb-btn--xs";
            btn.textContent = "Ajouter";
            btn.addEventListener("click", () => {
                closeModal("modalPosteCertAdd");
                openPosteCertEditModal({
                    id_certification: it.id_certification,
                    nom_certification: it.nom_certification,
                    description: it.description,
                    categorie: it.categorie,
                    duree_validite: it.duree_validite,
                    delai_renouvellement: it.delai_renouvellement,
                    validite_override: null,
                    niveau_exigence: "requis",
                    commentaire: ""
                }, true);
            });

            row.appendChild(left);
            row.appendChild(btn);

            host.appendChild(row);
        });
    }

    async function loadPosteCertCreateCategories(portal){
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}?q=`;
        const data = await portal.apiJson(url);

        const list = byId("posteCertCreateCategoryList");
        if (!list) return;

        const values = Array.from(
            new Set(
                (data.items || [])
                    .map(it => (it.categorie || "").toString().trim())
                    .filter(Boolean)
            )
        ).sort((a, b) => a.localeCompare(b, "fr", { sensitivity:"base" }));

        list.innerHTML = "";
        values.forEach(v => {
            const opt = document.createElement("option");
            opt.value = v;
            list.appendChild(opt);
        });
    }

    function bindStepButtons(host){
        if (!host) return;

        host.querySelectorAll(".sb-stepper-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const targetId = (btn.getAttribute("data-stepper-target") || "").trim();
                const delta = parseInt(btn.getAttribute("data-stepper-delta") || "0", 10);
                const input = byId(targetId);
                if (!input || !Number.isFinite(delta) || !delta) return;

                const min = parseInt(input.getAttribute("min") || "0", 10);
                const step = parseInt(input.getAttribute("step") || "1", 10) || 1;

                let cur = parseInt((input.value || "").trim(), 10);
                if (!Number.isFinite(cur)) {
                    cur = Math.max(min || step, step);
                } else {
                    cur += (delta * step);
                }

                if (Number.isFinite(min)) cur = Math.max(min, cur);

                input.value = String(cur);
                input.dispatchEvent(new Event("input", { bubbles:true }));
                input.dispatchEvent(new Event("change", { bubbles:true }));
            });
        });
    }

    async function openPosteCertCreateModal(portal){
        if (!isAdmin()) return;

        closeModal("modalPosteCertAdd");

        byId("posteCertCreateName").value = (_posteCertAddSearch || "").trim();
        byId("posteCertCreateCategory").value =
            (_posteCertAddCategory && _posteCertAddCategory !== "__none__")
                ? _posteCertAddCategory
                : "";
        byId("posteCertCreateValidity").value = "";
        byId("posteCertCreateRenewal").value = "";
        byId("posteCertCreateDescription").value = "";

        openModal("modalPosteCertCreate");
        await loadPosteCertCreateCategories(portal);
    }

    function closePosteCertCreateModal(reopenAdd){
        closeModal("modalPosteCertCreate");
        if (reopenAdd) openModal("modalPosteCertAdd");
    }

    async function savePosteCertCreate(portal){
        const ownerId = getOwnerId();

        const nom = (byId("posteCertCreateName")?.value || "").trim();
        const categorie = (byId("posteCertCreateCategory")?.value || "").trim() || null;
        const description = (byId("posteCertCreateDescription")?.value || "").trim() || null;

        if (!nom){
            portal.showAlert("error", "Le nom de la certification est obligatoire.");
            return;
        }

        const rawValidity = (byId("posteCertCreateValidity")?.value || "").trim();
        const rawRenewal = (byId("posteCertCreateRenewal")?.value || "").trim();

        let duree_validite = null;
        let delai_renouvellement = null;

        if (rawValidity){
            if (!/^\d+$/.test(rawValidity)) {
                portal.showAlert("error", "La validité catalogue doit être un entier positif.");
                return;
            }
            duree_validite = parseInt(rawValidity, 10);
            if (!Number.isFinite(duree_validite) || duree_validite <= 0){
                portal.showAlert("error", "La validité catalogue doit être supérieure à 0.");
                return;
            }
        }

        if (rawRenewal){
            if (!/^\d+$/.test(rawRenewal)) {
                portal.showAlert("error", "Le délai de renouvellement doit être un entier positif.");
                return;
            }
            delai_renouvellement = parseInt(rawRenewal, 10);
            if (!Number.isFinite(delai_renouvellement) || delai_renouvellement <= 0){
                portal.showAlert("error", "Le délai de renouvellement doit être supérieur à 0.");
                return;
            }
        }

        const url = `${portal.apiBase}/studio/org/certifications_catalogue/${encodeURIComponent(ownerId)}`;
        const data = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                nom_certification: nom,
                categorie: categorie,
                description: description,
                duree_validite: duree_validite,
                delai_renouvellement: delai_renouvellement
            })
        });

        const it = data?.item || {};
        closeModal("modalPosteCertCreate");
        closeModal("modalPosteCertAdd");

        openPosteCertEditModal({
            id_certification: it.id_certification,
            nom_certification: it.nom_certification,
            description: it.description,
            categorie: it.categorie,
            duree_validite: it.duree_validite,
            delai_renouvellement: it.delai_renouvellement,
            validite_override: null,
            niveau_exigence: "requis",
            commentaire: ""
        }, true);
    }

    function openPosteCertEditModal(it, isNew){
        _posteCertEdit = { ...(it || {}) };
        _posteCertEdit._isNew = !!isNew;

        byId("posteCertEditTitle").textContent = (_posteCertEdit.nom_certification || "Certification").toString();

        const cat = (_posteCertEdit.categorie || "").toString().trim();
        byId("posteCertEditSub").textContent = cat || "Sans catégorie";

        byId("posteCertEditBaseInfo").textContent = buildPosteCertBaseInfo(_posteCertEdit);
        byId("posteCertEditOverride").value =
            (_posteCertEdit.validite_override !== null && _posteCertEdit.validite_override !== undefined)
                ? String(_posteCertEdit.validite_override)
                : "";
        byId("posteCertEditLevel").value = (_posteCertEdit.niveau_exigence || "requis");
        byId("posteCertEditComment").value = (_posteCertEdit.commentaire || "");

        openModal("modalPosteCertEdit");
    }

    async function savePosteCertEdit(portal){
        if (!_editingPosteId || !_posteCertEdit) return;

        const ownerId = getOwnerId();

        const rawOverride = (byId("posteCertEditOverride")?.value || "").trim();
        let validiteOverride = null;

        if (rawOverride){
            if (!/^\d+$/.test(rawOverride)) {
                portal.showAlert("error", "La validité spécifique doit être un entier positif.");
                return;
            }
            validiteOverride = parseInt(rawOverride, 10);
            if (!Number.isFinite(validiteOverride) || validiteOverride <= 0){
                portal.showAlert("error", "La validité spécifique doit être supérieure à 0.");
                return;
            }
        }

        const niveau = (byId("posteCertEditLevel")?.value || "requis").trim();
        const commentaire = (byId("posteCertEditComment")?.value || "").trim() || null;

        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`;
        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                id_certification: _posteCertEdit.id_certification,
                validite_override: validiteOverride,
                niveau_exigence: niveau,
                commentaire: commentaire
            })
        });

        closeModal("modalPosteCertEdit");
        portal.showAlert("", "");
        await loadPosteCertifications(portal);
    }

    async function removePosteCertification(portal, id_certification){
        if (!_editingPosteId) return;
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_certification)}/remove`;
        await portal.apiJson(url, { method: "POST" });
        portal.showAlert("", "");
        await loadPosteCertifications(portal);
    }

    const _posteDetailCache = new Map(); // id_poste -> detail

    async function fetchPosteDetail(portal, id_poste){
        const pid = (id_poste || "").toString().trim();
        if (!pid) return null;

        if (_posteDetailCache.has(pid)) return _posteDetailCache.get(pid);

        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/poste_detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;
        const data = await portal.apiJson(url);
        _posteDetailCache.set(pid, data);
        return data;
    }

    function setPosteModalActif(isActif){
        const bA = byId("btnPosteArchive");
        const card = document.querySelector("#modalPoste .sb-modal-card");
        if (card) card.dataset.actif = isActif ? "1" : "0";

        if (bA){
            bA.disabled = false;
            bA.style.opacity = "";
            bA.title = "";
            bA.textContent = isActif ? "Archiver" : "Restaurer";
        }
    }

    function fillPosteServiceSelect(selectedId){
        const sel = byId("posteService");
        if (!sel) return;

        sel.innerHTML = "";

        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "(Choisir un service)";
        sel.appendChild(opt0);

        (_services || []).forEach(s => {
            const opt = document.createElement("option");
            opt.value = s.id_service;
            opt.textContent = `${"—".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
            sel.appendChild(opt);
        });

        sel.value = selectedId || "";
    }

    function openCreatePosteModal(portal){
        _posteModalMode = "create";
        _editingPosteId = null;

        refreshPosteImportButton();
        resetPosteImportState();

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", "");

        byId("posteModalTitle").textContent = "Ajouter un poste";
        byId("posteModalSub").textContent = "Créez une fiche de poste et rattachez-la au service voulu.";

        const badge = byId("posteModalBadge");
        if (badge){ badge.style.display = "none"; badge.textContent = ""; }

        const defaultSid = (_selectedService && _selectedService !== "__all__" && _selectedService !== "__none__")
            ? _selectedService
            : "";

        fillPosteServiceSelect(defaultSid);

        
        byId("posteCodifClient").value = "";
        byId("posteIntitule").value = "";
        byId("posteMission").value = "";
        rtSetHtml("posteResp", "");
        resetPosteAiModalFields();
        _posteAiDraftMeta = null;
        resetPosteCompAiUi();

        refreshPosteFooterActions();

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Créer";

        fillPosteContraintesTab({});
        resetPosteCcnUi(true);
        fillPosteRhTab({}, true);

        _posteCompItems = [];
        _posteCompSearch = "";
        if (byId("posteCompSearch")) byId("posteCompSearch").value = "";
        renderPosteCompetences();

        _posteCertItems = [];
        _posteCertSearch = "";
        if (byId("posteCertSearch")) byId("posteCertSearch").value = "";
        renderPosteCertifications();

        (async () => {
        try{
            await ensureNsfGroupes(portal);
            fillNsfSelect("");
        } catch(_){}
        })();

        setPosteTab("def");
        openModal("modalPoste");
    }

    function openEditPosteModal(portal, p){
        _posteModalMode = "edit";
        const pid = (p && p.id_poste) ? String(p.id_poste).trim() : "";

        refreshPosteImportButton();
        resetPosteImportState();
        closePosteImportModal();
        
        if (!pid) return;

        _posteModalMode = "edit";
        _editingPosteId = pid;

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");

        byId("posteModalTitle").textContent =
            (p && (p.intitule_poste || p.intitule)) ? String(p.intitule_poste || p.intitule) : "Poste";
        byId("posteModalSub").textContent = "Mise à jour / transfert de service / archivage.";

        const badge = byId("posteModalBadge");
        const code = (p && p.code) ? String(p.code).trim() : "";
        if (badge){
            if (code){
                badge.textContent = code;
                badge.style.display = "";
            } else {
                badge.textContent = "";
                badge.style.display = "none";
            }
        }

        fillPosteServiceSelect((p && p.id_service) ? String(p.id_service) : "");
        resetPosteCompAiUi();

        // On pré-remplit ce qu'on a déjà (le détail complet arrive à l'étape 2)
        byId("posteIntitule").value = (p && p.intitule) ? String(p.intitule) : "";

        refreshPosteFooterActions();
        setPosteModalActif((p && p.actif !== false));

        const bS = byId("btnPosteSave");
        if (bS) bS.textContent = "Enregistrer";
        fillPosteRhTab({}, false);
        resetPosteCcnUi(false);

        _posteCompItems = [];
        renderPosteCompetences();

        _posteCertItems = [];
        renderPosteCertifications();

        setPosteTab("def");
        openModal("modalPoste");

        // Charge le détail (définition + exigences/contraintes)
        (async () => {
        try{
            const d = await fetchPosteDetail(portal, _editingPosteId);
            if (!d) return;

            await ensureNsfGroupes(portal);
            fillNsfSelect(d?.nsf_groupe_code || "");
            fillPosteContraintesTab(d);
            fillPosteRhTab(d, false);
            await loadPosteCcnContext(portal);
            await loadPosteCompetences(portal);
            await loadPosteCertifications(portal);

            // --- Définition (remplissage robuste: si champ supprimé, pas d'erreur)
            const elCodCli = byId("posteCodifClient"); if (elCodCli) elCodCli.value = (d.codif_client || "");
            const elInt = byId("posteIntitule"); if (elInt) elInt.value = (d.intitule_poste || "");
            const elMis = byId("posteMission"); if (elMis) elMis.value = (d.mission_principale || "");

            // Responsabilités: richtext si présent, sinon textarea
            if (typeof rtSetHtml === "function") rtSetHtml("posteResp", d.responsabilites || "");
            else { const elResp = byId("posteResp"); if (elResp) elResp.value = (d.responsabilites || ""); }
            seedPosteAiModalFromCurrent();

            // --- Exigences > Contraintes (les fonctions seront ajoutées/existent déjà chez toi)
            if (typeof ensureNsfGroupes === "function") {
            await ensureNsfGroupes(portal);
            if (typeof fillNsfSelect === "function") fillNsfSelect(d?.nsf_groupe_code || "");
            }
            if (typeof fillPosteContraintesTab === "function") fillPosteContraintesTab(d);

            // Actif / buttons
            if (typeof setPosteModalActif === "function") setPosteModalActif(!!d.actif);

            const bD = byId("btnPosteDuplicate");
            if (bD){ bD.disabled = false; bD.style.opacity = ""; bD.title = ""; }

        } catch(e){
            portal.showAlert("error", e?.message || String(e));
        }
        })();
    }

    function closePosteModal(){
        closeIaBusyOverlay();
        closeModal("modalPosteCompCreate");
        closeModal("modalPosteImport");
        closeModal("modalPoste");
        resetPosteImportState();
    }

        function getPosteModalActif(){
        const card = document.querySelector("#modalPoste .sb-modal-card");
        return (card && card.dataset.actif === "0") ? false : true;
    }

    async function savePosteFromModal(portal, options){
        const opts = options || {};
        const keepOpen = !!opts.keepOpen;
        const silent = !!opts.silent;
        const ownerId = getOwnerId();

        const sid = (byId("posteService")?.value || "").trim();
        const codc = (byId("posteCodifClient")?.value || "").trim();
        const title = (byId("posteIntitule")?.value || "").trim();
        const mission = (byId("posteMission")?.value || "").trim();
        const resp = rtGetHtml("posteResp").trim();

        if (!sid){
            portal.showAlert("error", "Sélectionne un service.");
            return null;
        }
        if (!title){
            portal.showAlert("error", "Intitulé obligatoire.");
            return null;
        }

        const payload = {
            id_service: sid,
            codif_client: (codc || null),
            intitule_poste: title,
            mission_principale: (mission || null),
            responsabilites: (resp || null),
            niveau_education_minimum: (byId("posteCtrEduMin")?.value || "").trim() || null,
            nsf_groupe_code: (byId("posteCtrNsfGroupe")?.value || "").trim() || null,
            nsf_groupe_obligatoire: !!byId("posteCtrNsfOblig")?.checked,
            mobilite: (byId("posteCtrMobilite")?.value || "").trim() || null,
            risque_physique: (byId("posteCtrRisquePhys")?.value || "").trim() || null,
            perspectives_evolution: (byId("posteCtrPerspEvol")?.value || "").trim() || null,
            niveau_contrainte: (byId("posteCtrNivContrainte")?.value || "").trim() || null,
            detail_contrainte: (byId("posteCtrDetailContrainte")?.value || "").trim() || null,
            statut_poste: (byId("posteRhStatut")?.value || "actif").trim(),
            date_debut_validite: (byId("posteRhDateDebut")?.value || "").trim() || null,
            date_fin_validite: (byId("posteRhDateFinWrap")?.style.display === "none")
                ? null
                : ((byId("posteRhDateFin")?.value || "").trim() || null),
            nb_titulaires_cible: null,
            criticite_poste: null,
            strategie_pourvoi: (byId("posteRhStrategie")?.value || "mixte").trim(),
            param_rh_verrouille: !!byId("posteRhVerrouille")?.checked,
            param_rh_commentaire: (byId("posteRhCommentaire")?.value || "").trim() || null,
        };

        const rawNbTit = (byId("posteRhNbTitulaires")?.value || "").trim();
        const nbTit = parseInt(rawNbTit || "1", 10);
        if (!Number.isFinite(nbTit) || nbTit < 1){
            portal.showAlert("error", "Le nombre de titulaires cible doit être supérieur ou égal à 1.");
            return null;
        }
        payload.nb_titulaires_cible = nbTit;

        const rawCrit = (byId("posteRhCriticite")?.value || "").trim();
        const crit = parseInt(rawCrit || "2", 10);
        if (!Number.isFinite(crit) || crit < 1 || crit > 3){
            portal.showAlert("error", "La criticité du poste doit être comprise entre 1 et 3.");
            return null;
        }
        payload.criticite_poste = crit;

        if (payload.date_debut_validite && payload.date_fin_validite && payload.date_fin_validite < payload.date_debut_validite){
            portal.showAlert("error", "La date de fin de validité doit être postérieure ou égale à la date de début.");
            return null;
        }

        if (_posteModalMode === "create"){
            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            await loadServices(portal);
            await loadPostes(portal);

            if (keepOpen){
                const pid = (r?.id_poste || "").toString().trim();
                const code = (r?.codif_poste || "").toString().trim();
                _posteModalMode = "edit";
                _editingPosteId = pid || _editingPosteId;
                const modal = byId("modalPoste");
                if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");
                byId("posteModalTitle").textContent = title || "Poste";
                byId("posteModalSub").textContent = "Mise à jour / transfert de service / archivage.";
                const badge = byId("posteModalBadge");
                if (badge){
                    badge.textContent = code || "";
                    badge.style.display = code ? "" : "none";
                }
                refreshPosteFooterActions();
                const bS = byId("btnPosteSave");
                if (bS) bS.textContent = "Enregistrer";
                setPosteModalActif(true);
                seedPosteAiModalFromCurrent();
                if (!silent) setStatus(opts.statusMessage || "Poste créé.");
                return r;
            }

            if (!silent) setStatus(opts.statusMessage || "Poste créé.");
            closePosteModal();
            return r;

        } else {
            const pid = (_editingPosteId || "").trim();
            if (!pid) throw new Error("id_poste manquant (edit).");

            const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`;
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            _posteDetailCache.delete(pid);

            await loadServices(portal);
            await loadPostes(portal);

            if (!keepOpen){
                if (!silent) setStatus(opts.statusMessage || "Poste enregistré.");
                closePosteModal();
            } else if (!silent) {
                setStatus(opts.statusMessage || "Poste enregistré.");
            }
            return r || { ok: true };
        }
    }

    async function toggleArchivePosteFromList(portal, poste){
        const ownerId = getOwnerId();
        const pid = (poste && poste.id_poste) ? String(poste.id_poste).trim() : "";
        if (!pid) return;

        const isActif = !(poste && poste.actif === false);
        const wantArchive = isActif; // actif => archive ; archivé => restaure

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`;
        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ archive: wantArchive }),
        });

        _posteDetailCache.delete(pid);

        await loadServices(portal);
        await loadPostes(portal);

        setStatus(wantArchive ? "Poste archivé." : "Poste restauré.");
    }

    async function toggleArchivePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const isActif = getPosteModalActif();
        const wantArchive = isActif; // si actif => on archive ; si archivé => on restaure

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ archive: wantArchive }),
        });

        _posteDetailCache.delete(pid);

        await loadServices(portal);
        await loadPostes(portal);

        const nowActif = (r && typeof r.actif === "boolean") ? r.actif : !wantArchive;
        setPosteModalActif(nowActif);

        setStatus(wantArchive ? "Poste archivé." : "Poste restauré.");
    }

    async function duplicatePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const sid = (byId("posteService")?.value || "").trim();
        if (!sid){
            portal.showAlert("error", "Sélectionne un service cible avant duplication.");
            return;
        }

        const url = `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/duplicate`;
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ id_service: sid }),
        });

        const newId = (r && r.id_poste) ? String(r.id_poste) : "";
        const newCode = (r && r.codif_poste) ? String(r.codif_poste) : "";

        await loadServices(portal);
        await loadPostes(portal);

        if (newId){
            _posteDetailCache.delete(newId);
            openEditPosteModal(portal, {
                id_poste: newId,
                code: newCode,
                intitule: (byId("posteIntitule")?.value || ""),
                id_service: sid,
                nb_collabs: 0,
                actif: true,
            });
            setStatus("Poste dupliqué.");
        } else {
            setStatus("Poste dupliqué.");
        }
    }

    // -------- Services CRUD
    function openCreateService(){
        _serviceModalMode = "create";
        _editingServiceId = null;

        byId("svcModalTitle").textContent = "Créer un service";
        byId("svcModalSub").textContent = "Définissez le nom et, si besoin, le parent.";
        byId("svcName").value = "";
        fillParentSelect(null);

        openModal("modalService");
    }

    function openEditService(){
        if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

        const s = (_services || []).find(x => x.id_service === _selectedService);
        if (!s) return;

        _serviceModalMode = "edit";
        _editingServiceId = s.id_service;

        byId("svcModalTitle").textContent = "Modifier le service";
        byId("svcModalSub").textContent = "Renommer / Changer le service parent.";
        byId("svcName").value = s.nom_service || "";
        fillParentSelect(s.id_service_parent || null, s.id_service);

        openModal("modalService");
    }

    function fillParentSelect(selectedId, excludeId){
        const sel = byId("svcParent");
        if (!sel) return;

        sel.innerHTML = `<option value="">(Aucun)</option>`;
        (_services || []).forEach(s => {
        if (excludeId && s.id_service === excludeId) return;
        const opt = document.createElement("option");
        opt.value = s.id_service;
        opt.textContent = `${"—".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
        sel.appendChild(opt);
        });

        sel.value = selectedId || "";
    }

    async function saveService(portal){
        const ownerId = getOwnerId();
        const name = (byId("svcName").value || "").trim();
        const parent = (byId("svcParent").value || "").trim() || null;

        if (!name) {
        portal.showAlert("error", "Nom de service obligatoire.");
        return;
        }

        if (_serviceModalMode === "create") {
        await portal.apiJson(
            `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`,
            { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
        );
        } else {
        if (!_editingServiceId) return;
        await portal.apiJson(
            `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingServiceId)}`,
            { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
        );
        }

        closeModal("modalService");
        portal.showAlert("", "");
        await loadServices(portal);
    }

    function openArchiveService(){
        if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

        const s = (_services || []).find(x => x.id_service === _selectedService);
        if (!s) return;

        byId("archiveMsg").textContent = `Archiver "${s.nom_service}" ? Les postes et collaborateurs seront détachés (Non lié).`;
        openModal("modalArchive");
    }

    async function confirmArchiveService(portal){
        const ownerId = getOwnerId();
        const sid = _selectedService;
        if (!sid || sid === "__all__" || sid === "__none__") return;

        await portal.apiJson(
        `${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(sid)}/archive`,
        { method: "POST" }
        );

        closeModal("modalArchive");
        portal.showAlert("", "");

        _selectedService = "__all__";
        _selectedServiceName = "Tous les services";

        await loadServices(portal);
        await loadPostes(portal);

        refreshPosteBlockTitle();
        updateAddButtonState();
    }

    // -------- Catalogue
    async function openCatalog(portal){
        if (!isAdmin()) return;
        if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

        byId("catalogSearch").value = "";
        _catalogSearch = "";
        byId("catalogList").innerHTML = "";

        openModal("modalCatalog");
        await loadCatalog(portal);
    }

    async function loadCatalog(portal){
        const ownerId = getOwnerId();
        const url = `${portal.apiBase}/studio/org/postes_catalogue/${encodeURIComponent(ownerId)}?q=${encodeURIComponent(_catalogSearch)}`;
        const data = await portal.apiJson(url);

        const host = byId("catalogList");
        if (!host) return;
        host.innerHTML = "";

        const items = data.items || [];
        if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "card-sub";
        empty.textContent = "Aucun poste dans le catalogue.";
        host.appendChild(empty);
        return;
        }

        items.forEach(it => {
        const row = document.createElement("div");
        row.className = "sb-row-card";

        const left = document.createElement("div");
        left.className = "sb-row-left";

        const code = document.createElement("span");
        code.className = "sb-badge sb-badge--comp";
        code.textContent = it.code || "—";

        const title = document.createElement("div");
        title.className = "sb-row-title";
        title.textContent = it.intitule || "";

        left.appendChild(code);
        left.appendChild(title);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sb-btn sb-btn--accent sb-btn--xs";
        btn.textContent = "Ajouter";
        btn.addEventListener("click", async () => {
            await assignPosteFromCatalog(portal, it.id_poste);
        });

        row.appendChild(left);
        row.appendChild(btn);
        host.appendChild(row);
        });
    }

    async function assignPosteFromCatalog(portal, idPoste){
        const ownerId = getOwnerId();
        const sid = _selectedService;
        if (!sid || sid === "__all__" || sid === "__none__") return;

        await portal.apiJson(
        `${portal.apiBase}/studio/org/postes/assign/${encodeURIComponent(ownerId)}`,
        { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id_poste: idPoste, id_service: sid }) }
        );

        closeModal("modalCatalog");
        portal.showAlert("", "");

        await loadServices(portal);
        await loadPostes(portal);

        // mettre à jour meta header service sélectionné
        const row = document.querySelector(`.org-svc-item[data-sid="${CSS.escape(sid)}"] .org-svc-meta`);
        if (row) {
        // on laisse la liste refléter les compteurs rechargés
        }
    }

    // -------- Bind
    function bindOnce(portal){
        if (_bound) return;
        _bound = true;

        // admin-only (page est admin-only, mais on blinde l’UX)
        if (!isAdmin()) {
        const a = byId("btnSvcAdd"); if (a) a.style.display = "none";
        const b = byId("btnSvcEdit"); if (b) b.style.display = "none";
        const c = byId("btnSvcArchive"); if (c) c.style.display = "none";
        const d = byId("btnAddFromCatalog"); if (d) d.style.display = "none";
        }

        byId("btnOpenOrgChart")?.addEventListener("click", async () => {
            try { await openOrgChartPdf(portal); }
            catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        // Search postes
        const ps = byId("posteSearch");
        ps.addEventListener("input", () => {
        _posteSearch = (ps.value || "").trim();
        if (_posteSearchTimer) clearTimeout(_posteSearchTimer);
        _posteSearchTimer = setTimeout(() => loadPostes(portal).catch(() => {}), 250);
        });

        const pcs = byId("posteCompSearch");
        if (pcs){
          pcs.addEventListener("input", () => {
            _posteCompSearch = (pcs.value || "").trim();
            if (_posteCompSearchTimer) clearTimeout(_posteCompSearchTimer);
            _posteCompSearchTimer = setTimeout(() => renderPosteCompetences(), 200);
          });
        }

        const pcsCert = byId("posteCertSearch");
        if (pcsCert){
          pcsCert.addEventListener("input", () => {
            _posteCertSearch = (pcsCert.value || "").trim();
            if (_posteCertSearchTimer) clearTimeout(_posteCertSearchTimer);
            _posteCertSearchTimer = setTimeout(() => renderPosteCertifications(), 200);
          });
        }

        const cbArch = byId("posteShowArchived");
        if (cbArch){
            cbArch.addEventListener("change", () => {
                _showArchivedPostes = !!cbArch.checked;
                loadPostes(portal).catch(() => {});
            });
        }

        // Service actions
        const orgRoot = getOrganisationRoot();
        if (orgRoot && !orgRoot._svcActionsBound){
            orgRoot._svcActionsBound = true;

            orgRoot.addEventListener("click", (e) => {
                const btnAdd = e.target.closest("#btnSvcAdd");
                if (btnAdd){
                    e.preventDefault();
                    e.stopPropagation();
                    openCreateService();
                    return;
                }

                const btnEdit = e.target.closest("#btnSvcEdit");
                if (btnEdit){
                    e.preventDefault();
                    e.stopPropagation();
                    openEditService();
                    return;
                }

                const btnArchive = e.target.closest("#btnSvcArchive");
                if (btnArchive){
                    e.preventDefault();
                    e.stopPropagation();
                    openArchiveService();
                }
            });
        }

        byId("btnCloseService").addEventListener("click", () => closeModal("modalService"));
        byId("btnCancelService").addEventListener("click", () => closeModal("modalService"));
        byId("btnSaveService").addEventListener("click", async () => {
        try { await saveService(portal); }
        catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnCloseArchive").addEventListener("click", () => closeModal("modalArchive"));
        byId("btnCancelArchive").addEventListener("click", () => closeModal("modalArchive"));
        byId("btnConfirmArchive").addEventListener("click", async () => {
        try { await confirmArchiveService(portal); }
        catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        // Catalogue modal
        byId("btnAddFromCatalog").addEventListener("click", () => {
            try { openCreatePosteModal(portal); }
            catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnCloseCatalog").addEventListener("click", () => closeModal("modalCatalog"));
        const cs = byId("catalogSearch");
        cs.addEventListener("input", () => {
        _catalogSearch = (cs.value || "").trim();
        if (_catalogTimer) clearTimeout(_catalogTimer);
        _catalogTimer = setTimeout(() => loadCatalog(portal).catch(() => {}), 250);
        });

        // Modal Poste: close / cancel / backdrop / tabs
        byId("btnClosePoste")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePosteModal();
        });

        byId("btnPosteCancel")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePosteModal();
        });

        bindRichtext("posteResp");

        const mp = byId("modalPoste");
        if (mp && !mp._sbBound){
            mp._sbBound = true;

            mp.addEventListener("click", (e) => {
                if (e.target === mp) closePosteModal();
            });

            mp.querySelectorAll("#posteTabbar [data-tab]").forEach(btn => {
                btn.addEventListener("click", () => {
                    const tab = btn.getAttribute("data-tab");
                    setPosteTab(tab);
                });
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPoste");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteModal();
            });
        }

        byId("btnPosteSave")?.addEventListener("click", async () => {
            try { await savePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteArchive")?.addEventListener("click", async () => {
            try { await toggleArchivePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteDuplicate")?.addEventListener("click", async () => {
            try { await duplicatePosteFromModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteImport")?.addEventListener("click", () => {
            try { openPosteImportModal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteImport")?.addEventListener("click", () => closePosteImportModal());
        byId("btnPosteImportCancel")?.addEventListener("click", () => closePosteImportModal());
        byId("btnPosteImportChange")?.addEventListener("click", () => {
            byId("posteImportFileInput")?.click();
        });
        byId("btnPosteImportAnalyze")?.addEventListener("click", async () => {
            try { await launchPosteImport(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        const posteImportInput = byId("posteImportFileInput");
        posteImportInput?.addEventListener("change", (e) => {
            try{
                const file = e?.target?.files?.[0];
                if (!file) return;
                setPosteImportFile(file);
            } catch(err){
                portal.showAlert("error", err?.message || String(err));
                resetPosteImportState();
            }
        });

        const posteImportDrop = byId("posteImportDropzone");
        if (posteImportDrop){
            posteImportDrop.addEventListener("click", () => {
                byId("posteImportFileInput")?.click();
            });

            posteImportDrop.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " "){
                    e.preventDefault();
                    byId("posteImportFileInput")?.click();
                }
            });

            ["dragenter", "dragover"].forEach(evt => {
                posteImportDrop.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    posteImportDrop.classList.add("is-drag");
                });
            });

            ["dragleave", "dragend", "drop"].forEach(evt => {
                posteImportDrop.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (evt !== "drop"){
                        posteImportDrop.classList.remove("is-drag");
                    }
                });
            });

            posteImportDrop.addEventListener("drop", (e) => {
                posteImportDrop.classList.remove("is-drag");
                try{
                    const file = e?.dataTransfer?.files?.[0];
                    if (!file) return;
                    setPosteImportFile(file);
                } catch(err){
                    portal.showAlert("error", err?.message || String(err));
                    resetPosteImportState();
                }
            });
        }

        const mpi = byId("modalPosteImport");
        if (mpi && !mpi._sbBound){
            mpi._sbBound = true;

            mpi.addEventListener("click", (e) => {
                if (e.target === mpi) closePosteImportModal();
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteImport");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteImportModal();
            });
        }

        byId("btnPosteAi")?.addEventListener("click", () => {
            try { openPosteAiModal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteAiX")?.addEventListener("click", closePosteAiModal);
        byId("btnPosteAiCancel")?.addEventListener("click", closePosteAiModal);
        byId("btnPosteAiGenerate")?.addEventListener("click", async () => {
            try { await generatePosteAiDraft(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCcnOpen")?.addEventListener("click", async () => {
            try { await openPosteCcnModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnX")?.addEventListener("click", closePosteCcnModal);
        byId("btnPosteCcnCancel")?.addEventListener("click", closePosteCcnModal);
        byId("btnPosteCcnAnalyze")?.addEventListener("click", async () => {
            try { await runPosteCcnAnalysis(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnReuse")?.addEventListener("click", () => {
            try { reusePosteCcnProposal(); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCcnSave")?.addEventListener("click", async () => {
            try { await savePosteCcnDecision(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("posteCcnFinalCoefficient")?.addEventListener("input", refreshPosteCcnDecisionDerived);

        const mccn = byId("modalPosteCcn");
        if (mccn && !mccn._sbBound){
            mccn._sbBound = true;

            mccn.addEventListener("click", (e) => {
                if (e.target === mccn) closePosteCcnModal();
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteCcn");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteCcnModal();
            });
        }

        byId("btnPosteCompAi")?.addEventListener("click", async () => {
            try { await openPosteCompAiModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCompAiX")?.addEventListener("click", () => closeModal("modalPosteCompAi"));
        byId("btnPosteCompAiClose")?.addEventListener("click", () => closeModal("modalPosteCompAi"));

        byId("btnPosteCompCreateX")?.addEventListener("click", () => closePosteCompCreateModal());
        byId("btnPosteCompCreateCancel")?.addEventListener("click", () => closePosteCompCreateModal());

        byId("btnPosteCompCreateAdd")?.addEventListener("click", async () => {
            try { await savePosteCompCreateModal(portal, true); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateOnly")?.addEventListener("click", async () => {
            try { await savePosteCompCreateModal(portal, false); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateAddCrit")?.addEventListener("click", () => {
            const idx = nextEmptyPosteCompCreateCritIndex();
            if (idx < 0) return;
            showPosteCompCreateCritEditor(idx);
        });

        byId("btnPosteCompCreateCritSave")?.addEventListener("click", () => {
            try { savePosteCompCreateCritFromEditor(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCompCreateCritCancel")?.addEventListener("click", () => hidePosteCompCreateCritEditor());

        bindPosteCompCreateMaxLen("posteCompCreateNivA", 230);
        bindPosteCompCreateMaxLen("posteCompCreateNivB", 230);
        bindPosteCompCreateMaxLen("posteCompCreateNivC", 230);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval1", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval2", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval3", 120);
        bindPosteCompCreateMaxLen("posteCompCreateCritEval4", 120);

        byId("btnPosteCompAdd")?.addEventListener("click", () => {
          try { openPosteCompAddModal(); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        // Modal Add
        byId("btnClosePosteCompAdd")?.addEventListener("click", () => closeModal("modalPosteCompAdd"));
        const cas = byId("posteCompAddSearch");
        if (cas){
          cas.addEventListener("input", () => {
            _posteCompAddSearch = (cas.value || "").trim();
            if (_posteCompAddTimer) clearTimeout(_posteCompAddTimer);
            _posteCompAddTimer = setTimeout(() => loadPosteCompAddList(portal).catch(()=>{}), 250);
          });
        }
        byId("posteCompAddShowToValidate")?.addEventListener("change", (e) => {
          _posteCompAddIncludeToValidate = !!e.target.checked;
          loadPosteCompAddList(portal).catch(()=>{});
        });
        byId("posteCompAddDomain")?.addEventListener("change", (e) => {
        _posteCompAddDomain = (e.target.value || "").trim();
        _posteCompAddItems = applyPosteCompAddDomainFilter(_posteCompAddItemsAll);
        renderPosteCompAddList();
        });

        // Modal Edit
        byId("btnClosePosteCompEdit")?.addEventListener("click", () => closeModal("modalPosteCompEdit"));
        byId("btnPosteCompEditCancel")?.addEventListener("click", () => closeModal("modalPosteCompEdit"));
        byId("btnPosteCompEditSave")?.addEventListener("click", async () => {
          try { await savePosteCompEdit(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("posteCompEditFreq")?.addEventListener("input", refreshPosteCompEditCritDisplay);
        byId("posteCompEditImpact")?.addEventListener("input", refreshPosteCompEditCritDisplay);
        byId("posteCompEditDep")?.addEventListener("input", refreshPosteCompEditCritDisplay);
        document.querySelectorAll('input[name="posteCompEditNiv"]').forEach(r => {
            r.addEventListener("change", refreshPosteCompNivCards);
        });

        // Certifications
        byId("btnPosteCertAdd")?.addEventListener("click", () => {
          try { openPosteCertAddModal(); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnPosteCertCreate")?.addEventListener("click", async () => {
          try { await openPosteCertCreateModal(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteCertAdd")?.addEventListener("click", () => closeModal("modalPosteCertAdd"));

        const certSearch = byId("posteCertAddSearch");
        if (certSearch){
          certSearch.addEventListener("input", () => {
            _posteCertAddSearch = (certSearch.value || "").trim();
            if (_posteCertAddTimer) clearTimeout(_posteCertAddTimer);
            _posteCertAddTimer = setTimeout(() => loadPosteCertAddList(portal).catch(()=>{}), 250);
          });
        }

        byId("posteCertAddCategory")?.addEventListener("change", (e) => {
          _posteCertAddCategory = (e.target.value || "").trim();
          _posteCertAddItems = applyPosteCertAddCategoryFilter(_posteCertAddItemsAll);
          renderPosteCertAddList();
        });

        bindStepButtons(byId("modalPosteCertCreate"));
        bindStepButtons(byId("modalPosteCertEdit"));
        byId("btnClosePosteCertCreate")?.addEventListener("click", () => closePosteCertCreateModal(true));
        byId("btnPosteCertCreateCancel")?.addEventListener("click", () => closePosteCertCreateModal(true));
        byId("btnPosteCertCreateSave")?.addEventListener("click", async () => {
          try { await savePosteCertCreate(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        byId("btnClosePosteCertEdit")?.addEventListener("click", () => closeModal("modalPosteCertEdit"));
        byId("btnPosteCertEditCancel")?.addEventListener("click", () => closeModal("modalPosteCertEdit"));
        byId("btnPosteCertEditSave")?.addEventListener("click", async () => {
          try { await savePosteCertEdit(portal); }
          catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
    }

    async function init(force = false){
        try { await (window.__studioAuthReady || Promise.resolve(null)); } catch (_) {}

        const portal = window.portal;
        const root = getOrganisationRoot();

        traceOrg("init:start", {
            force: !!force,
            hasPortal: !!portal,
            hasRoot: !!root
        });

        if (!portal || !root) {
            traceOrg("init:skip", {
                force: !!force,
                hasPortal: !!portal,
                hasRoot: !!root
            });
            return;
        }

        if (_loaded && !force) {
            traceOrg("init:cached", {
                nbServices: (_services || []).length,
                nbPostes: (_totaux?.nb_postes || 0)
            });
            return;
        }

        await ensureRole(portal);
        traceOrg("init:role", { role: _roleCode || "user" });

        bindOnce(portal);

        await loadServices(portal);
        await loadPostes(portal);

        _loaded = true;

        traceOrg("init:done", {
            nbServices: (_services || []).length,
            nbPostes: (_totaux?.nb_postes || 0),
            nbPostesNonLies: (_nonLie?.nb_postes || 0)
        });
    }

    window.__studioOrganisationInit = async function(options){
        const force = !!(options && options.force);
        try {
            await init(force);
        } catch (e) {
            if (window.portal && window.portal.showAlert) {
                window.portal.showAlert("error", "Erreur organisation : " + (e?.message || e));
            }
            setStatus("Erreur de chargement.");
            throw e;
        }
    };

    if (getOrganisationRoot() && window.portal) {
        window.__studioOrganisationInit().catch(() => {});
    }

})();