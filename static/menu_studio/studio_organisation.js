(function () {
    let _bound = false;
    let _loaded = false;

    let _services = [];
    let _totaux = { nb_postes: 0, nb_collabs: 0 };
    let _nonLie = { nb_postes: 0, nb_collabs: 0 };

    let _selectedService = "__all__"; // "__all__", "__none__", ou id_service
    let _selectedServiceName = "Tous les services";
    let _selectedServiceStats = { nb_postes: 0, nb_collabs: 0 };

    let _posteSearch = "";
    let _posteSearchTimer = null;

    let _catalogSearch = "";
    let _catalogTimer = null;

    let _serviceModalMode = "create"; // create | edit
    let _editingServiceId = null;
    let _serviceModalReturnTarget = null; // null | poste_create | poste_select

    let _showArchivedPostes = false;

    let _posteModalMode = "create"; // create | edit
    let _editingPosteId = null;
    let _editingPosteListItem = null;
    let _posteHistoryActive = false;
    let _posteHistoryBound = false;

    // --- Poste > CompÃ©tences (Exigences)
    let _posteCompItems = [];
    let _posteCompSearch = "";
    let _posteCompSearchTimer = null;
    let _posteCompExpanded = false;
    const POSTE_COMP_COLLAPSED_LIMIT = 7;

    let _posteCompAddItems = [];
    let _posteCompAddSearch = "";
    let _posteCompAddTimer = null;
    let _posteCompAddIncludeToValidate = false;

    let _posteCompAddDomain = "";
    let _posteCompAddItemsAll = [];

    let _posteCompEdit = null; // objet en cours d'Ã©dition (merge comp + assoc)
    let _posteAiDraftMeta = null;
    let _posteCompAiResults = { existing: [], missing: [] };
    let _posteCompCreateCtx = null;
    let _posteCompCreateFrameCtx = null;
    let _posteCompAiSearchAbort = null;
    let _posteCompAiSearchRunId = 0;
    let _posteCompCreateDomainsLoaded = false;
    let _posteCompCreateDomainItems = [];
    let _posteCompCreateCrit = null;
    let _posteCompCreateCritEditIdx = null;
    let _posteCompImportFile = null;
    let _iaBusyTimer = null;
    let _iaBusyStartedAt = 0;
    let _iaBusyLongWarnAt = 200;
    let _iaBusyHintDefault = "Cette opÃ©ration peut prendre quelques minutes";
    let _iaBusyHintLong = "La durÃ©e de cette opÃ©ration est anormalement longue, appuyez sur Ã‰chap pour annuler et relancer la recherche";

    // --- Poste > Certifications (Exigences)
    let _posteCertItems = [];
    let _posteCertSearch = "";
    let _posteCertSearchTimer = null;

    let _posteCertAddItems = [];
    let _posteCertAddItemsAll = [];
    let _posteCertAddSearch = "";
    let _posteCertAddTimer = null;
    let _posteCertAddCategory = "";

    let _posteCertEdit = null; // objet en cours d'Ã©dition (merge cert + assoc)

    const POSTE_IMPORT_EXTENSIONS = [".doc", ".docx", ".pdf"];
    const POSTE_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
    let _posteImportFile = null;
    let _posteCcnContext = null;
    let _posteCcnAnalysis = null;

    let _orgCcnController = null;
    let _orgCcnAssetsPromise = null;
    let _posteSaveInlineTimer = null;

    function getStudioOrganisationAssetUrl(filename){
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const current = scripts.find(s => (s.getAttribute('src') || '').includes('studio_organisation.js'));

        if (current){
            return new URL(filename, current.src).toString();
        }

        return new URL(`/menu_studio/${filename}`, window.location.origin).toString();
    }

    function loadExternalScriptOnce(src){
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-studio-org-ccn="${src}"]`);
            if (existing){
                if (existing.dataset.loaded === "1") { resolve(); return; }
                existing.addEventListener("load", () => resolve(), { once: true });
                existing.addEventListener("error", () => reject(new Error(`Impossible de charger ${src}`)), { once: true });
                return;
            }

            const script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.dataset.studioOrgCcn = src;
            script.addEventListener("load", () => {
                script.dataset.loaded = "1";
                resolve();
            }, { once: true });
            script.addEventListener("error", () => reject(new Error(`Impossible de charger ${src}`)), { once: true });
            document.head.appendChild(script);
        });
    }

    async function ensureStudioOrganisationCcnController(portal){
        if (_orgCcnController) return _orgCcnController;

        if (!_orgCcnAssetsPromise){
            _orgCcnAssetsPromise = (async () => {
                if (!window.__studioOrganisationCcn){
                    await loadExternalScriptOnce(getStudioOrganisationAssetUrl("studio_organisation_ccn.js"));
                }

                if (!window.__studioOrganisationCcn){
                    throw new Error("Composant CCN introuvable aprÃ¨s chargement.");
                }

                const root = getOrganisationRoot();
                await window.__studioOrganisationCcn.ensureMounted(root, {
                    htmlUrl: getStudioOrganisationAssetUrl("studio_organisation_ccn.html"),
                    blockSlotId: "posteCcnSlot",
                    modalSlotId: "posteCcnModalSlot"
                });
            })();
        }

        await _orgCcnAssetsPromise;

        if (!_orgCcnController){
            _orgCcnController = window.__studioOrganisationCcn.createController({
                byId,
                setValue: _setValue,
                openModal,
                closeModal,
                ensureEditingPoste,
                getOwnerId,
                getEditingPosteId: () => _editingPosteId,
                openIaBusyOverlay,
                closeIaBusyOverlay,
            });
        }

        if (_orgCcnController && portal){
            _orgCcnController.bindOnce(portal);
        }

        return _orgCcnController;
    }

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
        // Si le rÃ´le est dÃ©jÃ  connu, on ne refait rien
        if (_roleCode && ["admin","supervisor","user"].includes(_roleCode)) return;

        const ownerId = getOwnerId();
        if (!ownerId) { _roleCode = "user"; return; }

        try {
            const ctx = await portal.apiJson(`${portal.apiBase}/studio/context/${encodeURIComponent(ownerId)}`);
            const rc = (ctx && ctx.role_code ? String(ctx.role_code) : "user").trim().toLowerCase();
            _roleCode = ["admin","supervisor","user"].includes(rc) ? rc : "user";
            window.__studioRoleCode = _roleCode; // synchronise le reste de lâ€™app
        } catch (_) {
            // fallback safe
            const rc = (window.__studioRoleCode || "user").toString().trim().toLowerCase();
            _roleCode = ["admin","supervisor","user"].includes(rc) ? rc : "user";
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

    function setBtnLabel(btnOrId, label){
        const btn = (typeof btnOrId === "string") ? byId(btnOrId) : btnOrId;
        if (!btn) return;
        const span = btn.querySelector(".sb-btn-label");
        if (span) span.textContent = label;
        else btn.textContent = label;
    }



    function nsLevelKey(v){
        const raw = String(v ?? "").trim();
        const norm = raw.normalize("NFD").replace(/[Ì€-Í¯]/g, "").toLowerCase();
        if (!norm || norm === "-" || norm === "â€”") return "";
        if (norm === "a" || norm.includes("initial") || norm.includes("debutant")) return "A";
        if (norm === "b" || norm.includes("intermediaire") || norm.includes("interm")) return "B";
        if (norm === "c" || norm.includes("avance") || norm.includes("advanced")) return "C";
        if (norm === "d" || norm.includes("expert")) return "D";
        return "";
    }

    function nsLevelLabel(v){
        const k = nsLevelKey(v);
        return ({ A:"DÃ©butant", B:"IntermÃ©diaire", C:"AvancÃ©", D:"Expert" })[k] || (String(v ?? "").trim() || "â€”");
    }

    function setStatus(msg, isError = false){
        const el = byId("orgStatus");
        if (!el) return;

        const text = String(msg || "").trim();
        if (!text || text === "â€”") {
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

    function resetPosteSaveInlineMsg(){
        if (_posteSaveInlineTimer){
            clearTimeout(_posteSaveInlineTimer);
            _posteSaveInlineTimer = null;
        }

        const el = byId("posteSaveInlineMsg");
        if (!el) return;

        el.textContent = "";
        el.classList.remove("is-error");
        el.classList.add("is-hidden");
    }

    function showPosteSaveInlineMsg(message, isError){
        const el = byId("posteSaveInlineMsg");
        if (!el) return;

        if (_posteSaveInlineTimer){
            clearTimeout(_posteSaveInlineTimer);
            _posteSaveInlineTimer = null;
        }

        el.textContent = message || "EnregistrÃ© avec succÃ¨s";
        el.classList.toggle("is-error", !!isError);
        el.classList.remove("is-hidden");

        _posteSaveInlineTimer = setTimeout(() => {
            resetPosteSaveInlineMsg();
        }, isError ? 4200 : 2800);
    }

    function formatOrgDiag(step, extra){
        const payload = Object.assign({
            step,
            ownerId: getOwnerId(),
            scopeEntId: getScopeEntId(),
            selectedService: _selectedService || "__all__"
        }, extra || {});

        const parts = [
            `Ã©tape=${payload.step}`,
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
        div.innerHTML = repairAiTextEncodingGlitches(String(html || ""));
        return (div.textContent || div.innerText || "")
            .replace(/\u00a0/g, " ")
            .replace(/\r/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }


    function repairAiTextEncodingGlitches(value){
        let s = String(value ?? "");
        if (!s) return "";

        try{
            if (/&(?:[a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/.test(s)){
                const ta = document.createElement("textarea");
                ta.innerHTML = s;
                s = ta.value;
            }
        } catch(_){ }

        s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
            try { return String.fromCharCode(parseInt(h, 16)); } catch(_) { return _; }
        });

        const cp1252 = {
            "80":"â‚¬", "82":"â€™", "83":"Æ’", "84":"â€ž", "85":"â€¦", "86":"â€ ", "87":"â€¡",
            "88":"Ë†", "89":"â€°", "8a":"Å ", "8b":"â€¹", "8c":"Å’", "8e":"Å½",
            "91":"â€˜", "92":"â€™", "93":"â€œ", "94":"â€", "95":"â€¢", "96":"â€“", "97":"â€”",
            "98":"Ëœ", "99":"â„¢", "9a":"Å¡", "9b":"â€º", "9c":"Å“", "9e":"Å¾", "9f":"Å¸",
            "a0":" ", "ab":"Â«", "bb":"Â»"
        };

        s = s.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => cp1252[String(h || "").toLowerCase()] || m);

        const letters = "A-Za-zÃ€-Ã–Ã˜-Ã¶Ã¸-Ã¿";
        s = s.replace(new RegExp("\\b([ldjtmncsLDJTMNCS])(?:b4|92|4)(?=[" + letters + "])", "g"), "$1â€™");
        s = s.replace(new RegExp("\\b([qQ])u(?:b4|92|4)(?=[" + letters + "])", "g"), "$1uâ€™");
        s = s.replace(/\b9c(?=uvre|uvr|il|ufs?\b)/gi, "Å“");
        s = s.replace(/\b9(?=uvre|uvr|il|ufs?\b)/gi, "Å“");

        const repairs = [
            // Fragments sans ambiguÃ¯tÃ© constatÃ©s dans les sorties IA/web.
            // Les autres accents passent par les formes explicites \xHH / \uHHHH.
            ["e0","Ã "], ["e7","Ã§"], ["e8","Ã¨"], ["e9","Ã©"],
            ["f4","Ã´"], ["f9","Ã¹"], ["c7","Ã‡"], ["c8","Ãˆ"], ["c9","Ã‰"], ["d9","Ã™"]
        ];

        repairs.forEach(([code, ch]) => {
            const mid = new RegExp("([" + letters + "])" + code + "(?=[" + letters + "])", "g");
            const start = new RegExp("\\b" + code + "(?=[" + letters + "])", "g");
            s = s.replace(mid, (_, p1) => p1 + ch);
            s = s.replace(start, ch);
        });

        return s;
    }

    function repairAiDraftPayload(value){
        if (typeof value === "string") return repairAiTextEncodingGlitches(value);
        if (Array.isArray(value)) return value.map(repairAiDraftPayload);
        if (value && typeof value === "object"){
            const out = {};
            Object.keys(value).forEach(k => { out[k] = repairAiDraftPayload(value[k]); });
            return out;
        }
        return value;
    }

    function openIaBusyOverlay(title, text, hintDefault, hintLong){
        const ov = byId("iaBusyOverlay");
        const ttl = byId("iaBusyTitle");
        const txt = byId("iaBusyText");
        const sec = byId("iaBusySeconds");
        const hint = byId("iaBusyHint");
        if (!ov) return;

        if (ttl) ttl.textContent = title || "Analyse IA en cours";
        if (txt) txt.textContent = text || "Traitement en cours...";
        if (sec) sec.textContent = "0";

        _iaBusyHintDefault = hintDefault || "Cette opÃ©ration peut prendre quelques minutes";
        _iaBusyHintLong = hintLong || "La durÃ©e de cette opÃ©ration est anormalement longue, appuyez sur Ã‰chap pour annuler et relancer la recherche";

        if (hint) {
            hint.textContent = _iaBusyHintDefault;
            hint.classList.remove("is-warning");
        }

        _iaBusyStartedAt = Date.now();
        if (_iaBusyTimer) clearInterval(_iaBusyTimer);
        _iaBusyTimer = setInterval(() => {
            const s = Math.max(0, Math.floor((Date.now() - _iaBusyStartedAt) / 1000));

            const el = byId("iaBusySeconds");
            if (el) el.textContent = String(s);

            const hintEl = byId("iaBusyHint");
            if (hintEl){
                if (s >= _iaBusyLongWarnAt){
                    hintEl.textContent = _iaBusyHintLong;
                    hintEl.classList.add("is-warning");
                } else {
                    hintEl.textContent = _iaBusyHintDefault;
                    hintEl.classList.remove("is-warning");
                }
            }
        }, 250);

        ov.style.display = "flex";
    }

    function closeIaBusyOverlay(){
        if (_iaBusyTimer){
            clearInterval(_iaBusyTimer);
            _iaBusyTimer = null;
        }

        const hint = byId("iaBusyHint");
        if (hint){
            hint.textContent = _iaBusyHintDefault;
            hint.classList.remove("is-warning");
        }

        const ov = byId("iaBusyOverlay");
        if (ov) ov.style.display = "none";
    }

    function isAbortError(error){
        return !!error && (
            error.name === "AbortError"
            || String(error?.message || "").toLowerCase().includes("aborted")
            || String(error?.message || "").toLowerCase().includes("abort")
        );
    }

    function isIaBusyVisible(){
        const ov = byId("iaBusyOverlay");
        return !!(ov && ov.style.display && ov.style.display !== "none");
    }

    function abortPosteCompAiSearch(reason){
        _posteCompAiSearchRunId += 1;
        if (_posteCompAiSearchAbort){
            try { _posteCompAiSearchAbort.abort(); } catch (_) {}
            _posteCompAiSearchAbort = null;
        }
        closeIaBusyOverlay();
        const loading = byId("posteCompAiLoading");
        if (loading) loading.style.display = "none";
        if (reason === "escape"){
            const summary = byId("posteCompAiSummary");
            if (summary){
                summary.textContent = "Recherche IA annulÃ©e.";
                summary.style.display = "";
            }
        }
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


    function normalizeAiBadgeRgb(value){
        const fromArgb = argbIntToRgbTuple(value);
        if (fromArgb && fromArgb.css) return fromArgb.css;

        const raw = String(value ?? "").trim();
        if (!raw) return "";

        const hex = raw.match(/^#?([0-9a-fA-F]{6})$/);
        if (hex){
            const n = parseInt(hex[1], 16);
            return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
        }

        const rgb = raw.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
        if (rgb){
            const r = Math.max(0, Math.min(255, parseInt(rgb[1], 10) || 0));
            const g = Math.max(0, Math.min(255, parseInt(rgb[2], 10) || 0));
            const b = Math.max(0, Math.min(255, parseInt(rgb[3], 10) || 0));
            return `${r},${g},${b}`;
        }

        return "";
    }

    function buildAiCompDomainBadge(label, couleur){
        const text = String(label || "").trim();
        if (!text) return null;

        const dom = document.createElement("span");
        dom.className = "sb-badge sb-badge--comp-domain";

        const rgb = normalizeAiBadgeRgb(couleur);
        if (rgb) dom.style.setProperty("--sb-domain-rgb", rgb);

        const dot = document.createElement("span");
        dot.className = "sb-dot";

        dom.appendChild(dot);
        dom.appendChild(document.createTextNode(text));
        return dom;
    }

    function buildAiMatchBadge(label, score){
        let text = String(label || "").trim();
        const n = Number(score);

        if (!text && Number.isFinite(n)){
            text = n >= 0.85 ? "Correspondance forte" : (n >= 0.65 ? "Correspondance probable" : "Ã€ contrÃ´ler");
        }
        if (!text) return null;

        const norm = normText(text);
        const badge = document.createElement("span");
        badge.className = "sb-badge sb-badge--ai-match";

        if (norm.includes("fort") || norm.includes("recommand") || norm.includes("retenu") || (Number.isFinite(n) && n >= 0.85)){
            badge.classList.add("sb-badge--ai-match-recommended");
        } else if (norm.includes("probable") || norm.includes("propos") || norm.includes("moyen") || (Number.isFinite(n) && n >= 0.65)){
            badge.classList.add("sb-badge--ai-match-proposed");
        } else {
            badge.classList.add("sb-badge--ai-match-review");
        }

        badge.textContent = text;
        return badge;
    }

    function buildAiMatchScoreText(score, matchPercent){
        const n = Number(score);
        const pctRaw = Number(matchPercent);
        let pct = Number.isFinite(pctRaw) ? pctRaw : null;

        if (pct === null && Number.isFinite(n)){
            pct = n <= 1 ? n * 100 : n;
        }
        if (pct === null) return document.createTextNode("");

        const span = document.createElement("span");
        span.className = "sb-ai-match-score";
        span.textContent = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
        return span;
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
        const niv = nsLevelKey(v) || "C";
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
        const cleanHtml = repairAiTextEncodingGlitches(html || "");
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") el.value = cleanHtml;
        else el.innerHTML = cleanHtml;
    }

    const RT_MAIN_ACTIVITY_PLACEHOLDER = "ActivitÃ© principale Ã  renseigner";
    const RT_SUB_ACTIVITY_PLACEHOLDER = "Sous-activitÃ© Ã  renseigner";

    function rtFocusAndSelectNode(node){
        if (!node) return;

        const range = document.createRange();
        range.selectNodeContents(node);

        const sel = window.getSelection();
        if (!sel) return;

        sel.removeAllRanges();
        sel.addRange(range);
    }

    function rtEnsureMainList(ed){
        if (!ed) return null;

        let ol = Array.from(ed.children || []).find(el => {
            return (el.tagName || "").toUpperCase() === "OL";
        });

        if (!ol){
            ol = document.createElement("ol");
            ed.appendChild(ol);
        }

        return ol;
    }

    function rtCreateTextSpan(text, className){
        const span = document.createElement("span");
        span.className = className || "";
        span.textContent = text || "";
        return span;
    }

    function rtGetMainItems(ed){
        const ol = rtEnsureMainList(ed);
        if (!ol) return [];
        return Array.from(ol.children || []).filter(el => {
            return (el.tagName || "").toUpperCase() === "LI";
        });
    }

    function rtGetCurrentMainItem(ed){
        if (!ed) return null;

        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;

        let node = sel.anchorNode;
        if (!node) return null;
        if (node.nodeType === 3) node = node.parentElement;
        if (!node || !node.closest) return null;

        const ol = Array.from(ed.children || []).find(el => {
            return (el.tagName || "").toUpperCase() === "OL";
        });
        if (!ol) return null;

        let li = node.closest("li");
        if (!li || !ed.contains(li)) return null;

        while (li && li.parentElement !== ol){
            li = li.parentElement ? li.parentElement.closest("li") : null;
        }

        return (li && li.parentElement === ol) ? li : null;
    }

    function rtAppendMainActivity(ed, shouldFocus){
        const ol = rtEnsureMainList(ed);
        if (!ol) return null;

        const li = document.createElement("li");
        const label = rtCreateTextSpan(RT_MAIN_ACTIVITY_PLACEHOLDER, "sb-rt-main-label");
        li.appendChild(label);

        const ul = document.createElement("ul");
        li.appendChild(ul);

        ol.appendChild(li);

        if (shouldFocus !== false){
            ed.focus();
            rtFocusAndSelectNode(label);
        }

        return li;
    }

    function rtAddMainActivity(id){
        const ed = byId(id);
        if (!ed) return;

        rtAppendMainActivity(ed, true);
    }

    function rtAddSubActivity(id){
        const ed = byId(id);
        if (!ed) return;

        let mainLi = rtGetCurrentMainItem(ed);

        if (!mainLi){
            const items = rtGetMainItems(ed);
            mainLi = items.length ? items[items.length - 1] : null;
        }

        if (!mainLi){
            mainLi = rtAppendMainActivity(ed, false);
        }

        if (!mainLi) return;

        let ul = Array.from(mainLi.children || []).find(el => {
            return (el.tagName || "").toUpperCase() === "UL";
        });

        if (!ul){
            ul = document.createElement("ul");
            mainLi.appendChild(ul);
        }

        const subLi = document.createElement("li");
        const label = rtCreateTextSpan(RT_SUB_ACTIVITY_PLACEHOLDER, "sb-rt-sub-label");
        subLi.appendChild(label);
        ul.appendChild(subLi);

        ed.focus();
        rtFocusAndSelectNode(label);
    }

    function rtGetStructuredHtml(id){
        const el = byId(id);
        if (!el) return "";

        const tag = (el.tagName || "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "INPUT") return el.value || "";

        const clone = el.cloneNode(true);

        clone.querySelectorAll(".sb-rt-main-label, .sb-rt-sub-label").forEach(node => {
            const txt = (node.textContent || "").replace(/\u00a0/g, " ").trim();
            if (txt === RT_MAIN_ACTIVITY_PLACEHOLDER || txt === RT_SUB_ACTIVITY_PLACEHOLDER){
                node.textContent = "";
            }
        });

        Array.from(clone.querySelectorAll("li")).reverse().forEach(li => {
            const txt = (li.textContent || "").replace(/\u00a0/g, " ").trim();
            if (!txt) li.remove();
        });

        Array.from(clone.querySelectorAll("ul, ol")).reverse().forEach(list => {
            if (!list.querySelector("li")) list.remove();
        });

        const txt = (clone.textContent || "").replace(/\u00a0/g, " ").trim();
        return txt ? (clone.innerHTML || "") : "";
    }

    function rtGetPosteRespHtml(){
        return rtGetStructuredHtml("posteResp").trim();
    }

    function bindRichtext(id){
        const ed = byId(id);
        if (!ed) return;

        const wrap = ed.closest(".sb-richtext");
        const bar = wrap ? wrap.querySelector(".sb-richtext-bar") : null;
        if (!bar || bar._sbBound) return;

        bar._sbBound = true;

        // Paste propre : on Ã©vite le HTML Word/Outlook, sinon la fiche de poste devient une dÃ©charge CSS.
        ed.addEventListener("paste", (e) => {
            try{
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData("text/plain") || "";
                document.execCommand("insertText", false, text);
            } catch(_){}
        });

        bar.querySelectorAll("[data-rt-action]").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const action = btn.getAttribute("data-rt-action") || "";
                if (action === "main-activity") {
                    rtAddMainActivity(id);
                    return;
                }

                if (action === "sub-activity") {
                    rtAddSubActivity(id);
                    return;
                }
            });
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

    function hasStudioOrgServices(){
        return Array.isArray(_services) && _services.some(s => s && s.id_service);
    }

    function closeServiceModal(){
        _serviceModalReturnTarget = null;
        closeModal("modalService");
    }

    function showOrgPopup(title, message){
        const root = getOrganisationRoot() || document.body;
        let modal = byId("modalOrgPopup") || document.getElementById("modalOrgPopup");

        if (!modal){
            modal = document.createElement("div");
            modal.className = "sb-modal";
            modal.id = "modalOrgPopup";
            modal.style.display = "none";
            modal.innerHTML = `
              <div class="sb-modal-card" style="max-width:520px;">
                <div class="sb-modal-head">
                  <div>
                    <div class="card-title" id="orgPopupTitle" style="margin-bottom:2px;">Information</div>
                    <div class="card-sub" id="orgPopupMessage" style="margin:0;">â€”</div>
                  </div>
                  <button type="button" class="sb-modal-x" id="btnCloseOrgPopup" aria-label="Fermer">&times;</button>
                </div>
                <div class="sb-modal-body">
                  <div class="sb-modal-actions">
                    <button type="button" class="sb-btn sb-btn--accent" id="btnOkOrgPopup">Compris</button>
                  </div>
                </div>
              </div>`;
            root.appendChild(modal);

            modal.addEventListener("click", (e) => {
                if (e.target === modal) closeModal("modalOrgPopup");
            });
            modal.querySelector("#btnCloseOrgPopup")?.addEventListener("click", () => closeModal("modalOrgPopup"));
            modal.querySelector("#btnOkOrgPopup")?.addEventListener("click", () => closeModal("modalOrgPopup"));
        }

        const t = modal.querySelector("#orgPopupTitle");
        const m = modal.querySelector("#orgPopupMessage");
        if (t) t.textContent = title || "Information";
        if (m) m.textContent = message || "Action impossible.";
        openModal("modalOrgPopup");
    }

    function getPendingPosteCompAiCount(){
        const existing = Array.isArray(_posteCompAiResults?.existing) ? _posteCompAiResults.existing : [];
        const missing = Array.isArray(_posteCompAiResults?.missing) ? _posteCompAiResults.missing : [];

        const pendingExisting = existing.filter(it => !it?._already_added).length;
        const pendingMissing = missing.length;

        return pendingExisting + pendingMissing;
    }

    function closePosteCompAiModal(forceClose = false){
        const pending = getPendingPosteCompAiCount();

        if (!forceClose && pending > 0){
            const msg = pending > 1
                ? "Si vous fermez maintenant, les propositions de compÃ©tences non enregistrÃ©es seront perdues. Il faudra relancer la recherche IA pour les retrouver.\n\nVoulez-vous vraiment fermer ?"
                : "Si vous fermez maintenant, la proposition de compÃ©tence non enregistrÃ©e sera perdue. Il faudra relancer la recherche IA pour la retrouver.\n\nVoulez-vous vraiment fermer ?";

            if (!window.confirm(msg)){
                return false;
            }
        }

        closeModal("modalPosteCompAi");
        closeModal("modalPosteCompCreateFrame");
        _posteCompAiResults = { existing: [], missing: [] };
        _posteCompCreateCtx = null;
        _posteCompCreateFrameCtx = null;
        resetPosteCompAiUi();
        return true;
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
        if (name) name.textContent = "â€”";
        if (meta) meta.textContent = "â€”";
        if (empty) empty.textContent = "Aucun document sÃ©lectionnÃ©.";
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
            if (isCreate) setBtnLabel(bA, "Archiver");
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
            throw new Error("Format non supportÃ©. Utilise un fichier .doc, .docx ou .pdf.");
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
        if (meta) meta.textContent = `${ext.toUpperCase().replace(".", "")} Â· ${formatFileSize(file.size || 0)}`;
        if (empty) empty.textContent = "Document chargÃ©. VÃ©rifie le fichier puis lance lâ€™analyse.";
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
        draft = repairAiDraftPayload(draft || {});
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
            sub.textContent = "Brouillon importÃ© depuis un document. VÃ©rifie puis enregistre.";
        }

        seedPosteAiModalFromCurrent();
        setPosteTab("def");
    }

    async function launchPosteImport(portal){
        if (!_posteImportFile){
            portal.showAlert("error", "SÃ©lectionne un document avant de lancer lâ€™analyse.");
            return;
        }

        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const btnAnalyze = byId("btnPosteImportAnalyze");
        const btnChange = byId("btnPosteImportChange");

        if (btnAnalyze){
            btnAnalyze.disabled = true;
            btnAnalyze.style.opacity = ".6";
            btnAnalyze.textContent = "Analyseâ€¦";
        }
        if (btnChange){
            btnChange.disabled = true;
            btnChange.style.opacity = ".6";
        }

        openIaBusyOverlay(
            "Lecture du document en cours",
            "Extraction du texte, analyse de la fiche et prÃ©remplissage du poste..."
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
                btnAnalyze.textContent = "Lancer lâ€™analyse";
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


    function htmlEsc(s){
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    async function fetchOrgPdfBlob(url){
        const headers = {};
        const token = await resolveStudioAccessToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const scopedUrl = appendOrgScope(url);

        const res = await fetch(scopedUrl, {
            method: "GET",
            headers,
            cache: "no-store",
            credentials: "same-origin",
        });

        if (!res.ok){
            let detail = `HTTP ${res.status}`;
            try{
                const js = await res.clone().json();
                detail = js?.detail || js?.message || detail;
            } catch(_){
                try{
                    const txt = await res.text();
                    if (txt) detail = txt;
                } catch(_){}
            }
            throw new Error(detail);
        }

        return await res.blob();
    }

    function openPdfLoadingWindow(title){
        const safeTitle = htmlEsc(title || "Document PDF");
        const win = window.open("", "_blank");

        if (!win){
            throw new Error("Le navigateur a bloquÃ© lâ€™ouverture du PDF.");
        }

        win.document.open();
        win.document.write(`<!doctype html>
    <html lang="fr">
    <head>
    <meta charset="utf-8">
    <title>${safeTitle}</title>
    <style>
        html,body{
        height:100%;
        margin:0;
        background:#f3f4f6;
        font-family: var(--ns-font-ui);
        color:#111827;
        }
        .pdf-loading{
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
        flex-direction:column;
        gap:12px;
        }
        .pdf-loading__spinner{
        width:34px;
        height:34px;
        border-radius:999px;
        border:4px solid rgba(17,24,39,.12);
        border-top-color:#355caa;
        animation:pdfSpin .8s linear infinite;
        }
        .pdf-loading__text{
        font-size: var(--ns-text-md);
        color:#475467;
        }
        iframe{
        width:100%;
        height:100%;
        border:0;
        background:#fff;
        }
        @keyframes pdfSpin{
        to{ transform:rotate(360deg); }
        }
    </style>
    </head>
    <body>
    <div class="pdf-loading">
        <div class="pdf-loading__spinner"></div>
        <div class="pdf-loading__text">GÃ©nÃ©ration du PDFâ€¦</div>
    </div>
    </body>
    </html>`);
        win.document.close();

        return win;
    }

    function renderPdfBlobInWindow(win, blob, title){
        const blobUrl = URL.createObjectURL(blob);
        const safeTitle = htmlEsc(title || "Document PDF");

        if (!win || win.closed){
            window.open(blobUrl, "_blank");
            setTimeout(() => {
                try { URL.revokeObjectURL(blobUrl); } catch(_){}
            }, 5 * 60 * 1000);
            return;
        }

        win.document.open();
        win.document.write(`<!doctype html>
    <html lang="fr">
    <head>
    <meta charset="utf-8">
    <title>${safeTitle}</title>
    <style>
        html,body{height:100%;margin:0;background:#f3f4f6;}
        iframe{width:100%;height:100%;border:0;background:#fff;}
    </style>
    </head>
    <body>
    <iframe src="${blobUrl}" title="${safeTitle}"></iframe>
    </body>
    </html>`);
        win.document.close();

        const revoke = () => {
            try { URL.revokeObjectURL(blobUrl); } catch(_){}
        };

        try{
            win.addEventListener("beforeunload", revoke, { once: true });
        } catch(_){}

        setTimeout(revoke, 5 * 60 * 1000);
    }

    async function openOrgSkillSheetPdf(portal, item, popupWin){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner introuvable.");

        const compId = String(item?.id_comp || item?.id_competence || "").trim();
        if (!compId) throw new Error("CompÃ©tence introuvable.");

        const title = `Fiche compÃ©tence - ${String(item?.code || "").trim() ? `${String(item.code).trim()} - ` : ""}${String(item?.intitule || "").trim() || "CompÃ©tence"}`;
        const url = `${portal.apiBase}/studio/org/competences/fiche_pdf/${encodeURIComponent(ownerId)}/${encodeURIComponent(compId)}`;
        const blob = await fetchOrgPdfBlob(url);

        renderPdfBlobInWindow(popupWin, blob, title);
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

            const suggestedName =
                getFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) ||
                "Organigramme de l'organisation.pdf";

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const escHtml = (v) => String(v || "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");

            const title = suggestedName || "Organigramme de l'organisation.pdf";

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
  font-weight: var(--ns-weight-semibold);
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
  font-weight: var(--ns-weight-semibold);
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
    <a class="bar__btn" href="${blobUrl}" download="${escHtml(title)}">TÃ©lÃ©charger</a>
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
  font-weight: var(--ns-weight-semibold);
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
  font-weight: var(--ns-weight-semibold);
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
    <a class="bar__btn" href="${blobUrl}" download="${escHtml(title)}">TÃ©lÃ©charger</a>
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

    function syncSelectedServiceContext(){
        if (!_selectedService || _selectedService === "__all__"){
            _selectedService = "__all__";
            _selectedServiceName = "Tous les services";
            return;
        }

        if (_selectedService === "__none__"){
            _selectedServiceName = "Non liÃ©";
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
            return "Tous les services";
        }

        if (_selectedService === "__none__"){
            return "Non liÃ©";
        }

        return _selectedServiceName || "Service";
    }

    function getSelectedServiceStats(){
        if (!_selectedService || _selectedService === "__all__"){
            return {
                nb_postes: Number(_totaux?.nb_postes || 0),
                nb_collabs: Number(_totaux?.nb_collabs || 0),
                nb_services: (_services || []).length
            };
        }

        if (_selectedService === "__none__"){
            return {
                nb_postes: Number(_nonLie?.nb_postes || 0),
                nb_collabs: Number(_nonLie?.nb_collabs || 0),
                nb_services: 0
            };
        }

        return {
            nb_postes: Number(_selectedServiceStats?.nb_postes || 0),
            nb_collabs: Number(_selectedServiceStats?.nb_collabs || 0),
            nb_services: 1
        };
    }

    function refreshPosteBlockTitle(){
        const title = byId("posteBlockTitle");
        if (title) title.textContent = getPosteBlockTitle();

        const stats = getSelectedServiceStats();
        const sub = byId("orgScopeSub");
        if (sub){
            sub.textContent = `${stats.nb_postes} poste(s) Â· ${stats.nb_collabs} collaborateur(s)`;
        }

        const statPostes = byId("orgStatPostes");
        if (statPostes) statPostes.textContent = String(stats.nb_postes);

        const statCollabs = byId("orgStatCollabs");
        if (statCollabs) statCollabs.textContent = String(stats.nb_collabs);

        const statServices = byId("orgStatServices");
        if (statServices) statServices.textContent = String(stats.nb_services);
    }

    function renderServices(){
        const host = byId("svcList");
        if (!host) return;
        host.innerHTML = "";

        // Pseudo: Tous les services
        host.appendChild(buildSvcRow("__all__", "Tous les services", 0, _totaux.nb_postes, _totaux.nb_collabs));

        // Services rÃ©els
        (_services || []).forEach(s => {
        host.appendChild(buildSvcRow(s.id_service, s.nom_service, s.depth, s.nb_postes, s.nb_collabs));
        });

        // Pseudo "Non liÃ©" volontairement masquÃ© dans Studio Organisation

        applySvcActive();
    }

    function buildSvcRow(id, name, depth, nbPostes, nbCollabs){
        const row = document.createElement("div");
        row.className = "sb-list-item sb-list-item--clickable org-service-row";
        row.dataset.sid = id;

        const left = document.createElement("div");
        left.className = "sb-list-title";
        left.style.paddingLeft = `${Math.min(6, Math.max(0, depth)) * 14}px`;
        left.textContent = name;

        const chevron = document.createElement("span");
        chevron.className = "org-service-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "â€º";

        row.appendChild(left);
        row.appendChild(chevron);

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
        _selectedServiceStats = {
            nb_postes: Number(nbPostes || 0),
            nb_collabs: Number(nbCollabs || 0)
        };

        refreshPosteBlockTitle();
        applySvcActive();
        updateAddButtonState();
        loadPostes(window.portal).catch(() => {});
    }

    function updateAddButtonState(){
        const btn = byId("btnAddFromCatalog");
        if (!btn) return;

        const ok = isAdmin();
        const hasServices = hasStudioOrgServices();

        btn.disabled = !ok;
        btn.style.opacity = ok ? "" : ".6";
        btn.title = !ok
            ? "AccÃ¨s admin requis."
            : (hasServices ? "" : "CrÃ©er un service avant d'ajouter un poste.");
    }

    async function loadServices(portal){
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");

        const url = appendOrgScope(`${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`);
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
            if (!_selectedService || _selectedService === "__all__"){
                _selectedServiceStats = { nb_postes: _totaux.nb_postes || 0, nb_collabs: _totaux.nb_collabs || 0 };
            } else if (_selectedService === "__none__"){
                _selectedServiceStats = { nb_postes: _nonLie.nb_postes || 0, nb_collabs: _nonLie.nb_collabs || 0 };
            } else {
                const selected = (_services || []).find(x => x.id_service === _selectedService);
                _selectedServiceStats = {
                    nb_postes: selected ? (selected.nb_postes || 0) : 0,
                    nb_collabs: selected ? (selected.nb_collabs || 0) : 0
                };
            }
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

        const url = appendOrgScope(
            `${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}` +
            `?service=${encodeURIComponent(_selectedService)}` +
            `&q=${encodeURIComponent(_posteSearch)}` +
            `&include_archived=${_showArchivedPostes ? "1" : "0"}`
        );

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
                empty.className = "org-empty-state";
                empty.textContent = "Aucun poste Ã  afficher.";
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
                code.textContent = p.code || "â€”";

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
                    arch.textContent = "ARCHIVÃ‰";
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
            btn.classList.toggle("is-active", isOn);
            btn.setAttribute("aria-selected", isOn ? "true" : "false");
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

        if (txt && txt !== "â€”"){
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
        { value:"",  text:"â€”" },
        { value:"0", text:"Aucun diplÃ´me" },
        { value:"3", text:"Niveau 3 : CAP, BEP" },
        { value:"4", text:"Niveau 4 : Bac" },
        { value:"5", text:"Niveau 5 : Bac+2 (BTS, DUT)" },
        { value:"6", text:"Niveau 6 : Bac+3 (Licence, BUT)" },
        { value:"7", text:"Niveau 7 : Bac+5 (Master, IngÃ©nieur, Grandes Ã©coles)" },
        { value:"8", text:"Niveau 8 : Bac+8 (Doctorat)" }
    ]);

    _fillSelect(byId("posteCtrMobilite"), [
        { value:"", text:"â€”" },
        { value:"Aucune", text:"Aucune" },
        { value:"Rare", text:"Rare" },
        { value:"Occasionnelle", text:"Occasionnelle" },
        { value:"FrÃ©quente", text:"FrÃ©quente" }
    ]);

    _fillSelect(byId("posteCtrPerspEvol"), [
        { value:"", text:"â€”" },
        { value:"Aucune", text:"Aucune" },
        { value:"Faible", text:"Faible" },
        { value:"ModÃ©rÃ©e", text:"ModÃ©rÃ©e" },
        { value:"Forte", text:"Forte" },
        { value:"Rapide", text:"Rapide" }
    ]);

    _fillSelect(byId("posteCtrRisquePhys"), [
        { value:"", text:"â€”", shortText:"â€”", longText:"â€”", helpText:"" },
        { value:"Aucun", shortText:"Aucun", longText:"Aucun : pas de risque identifiÃ©.", helpText:"Aucun : pas de risque identifiÃ©." },
        { value:"Faible", shortText:"Faible", longText:"Faible : exposition occasionnelle, faible intensitÃ©.", helpText:"Faible : exposition occasionnelle, faible intensitÃ©." },
        { value:"ModÃ©rÃ©", shortText:"ModÃ©rÃ©", longText:"ModÃ©rÃ© : exposition rÃ©guliÃ¨re mais maÃ®trisÃ©e.", helpText:"ModÃ©rÃ© : exposition rÃ©guliÃ¨re mais maÃ®trisÃ©e." },
        { value:"Ã‰levÃ©", shortText:"Ã‰levÃ©", longText:"Ã‰levÃ© : risque important, pouvant gÃ©nÃ©rer une pathologie.", helpText:"Ã‰levÃ© : risque important, pouvant gÃ©nÃ©rer une pathologie." },
        { value:"Critique", shortText:"Critique", longText:"Critique : risque vital ou accident grave possible.", helpText:"Critique : risque vital ou accident grave possible." }
    ]);

    _fillSelect(byId("posteCtrNivContrainte"), [
        { value:"", text:"â€”", shortText:"â€”", longText:"â€”", helpText:"" },
        { value:"Aucune", shortText:"Aucune", longText:"Aucune : poste standard, sans pression ni particularitÃ©.", helpText:"Aucune : poste standard, sans pression ni particularitÃ©." },
        { value:"ModÃ©rÃ©e", shortText:"ModÃ©rÃ©e", longText:"ModÃ©rÃ©e : quelques contraintes psychosociales/organisationnelles.", helpText:"ModÃ©rÃ©e : quelques contraintes psychosociales/organisationnelles." },
        { value:"Ã‰levÃ©e", shortText:"Ã‰levÃ©e", longText:"Ã‰levÃ©e : forte pression, conditions difficiles, grande responsabilitÃ©.", helpText:"Ã‰levÃ©e : forte pression, conditions difficiles, grande responsabilitÃ©." },
        { value:"Critique", shortText:"Critique", longText:"Critique : stress ou responsabilitÃ© vitale.", helpText:"Critique : stress ou responsabilitÃ© vitale." }
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
        // on ne bloque pas le modal pour Ã§a
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
        opt0.textContent = "â€”";
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
    // Poste > ParamÃ©trage RH
    // ------------------------------------------------------
    function rhSourceLabel(v){
        const s = (v || "").toString().trim().toLowerCase();
        if (s === "studio") return "Studio";
        if (s === "desktop") return "Desktop";
        if (s === "insights") return "Insights";
        return "â€”";
    }

    function formatRhDateMaj(v){
        const s = (v || "").toString().trim();
        if (!s) return "â€”";

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
            help.textContent = "1 = Faible : poste peu sensible, impact limitÃ©.";
        } else if (v === "2"){
            help.textContent = "2 = ModÃ©rÃ©e : poste important, impact rÃ©el sur lâ€™activitÃ©.";
        } else if (v === "3"){
            help.textContent = "3 = Forte : poste clÃ©, difficile Ã  remplacer ou Ã  sÃ©curiser.";
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
            { value:"a_pourvoir", text:"Ã€ pourvoir" },
            { value:"gele", text:"GelÃ©" },
            { value:"temporaire", text:"Temporaire" },
            { value:"archive", text:"ArchivÃ© (RH)" }
        ]);

        _fillSelect(byId("posteRhStrategie"), [
            { value:"interne", text:"Interne" },
            { value:"externe", text:"Externe" },
            { value:"mixte", text:"Mixte" }
        ]);

        _fillSelect(byId("posteRhCriticite"), [
            { value:"1", text:"1 - Faible" },
            { value:"2", text:"2 - ModÃ©rÃ©e" },
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
        _setValue("posteRhCommentaire", detail?.param_rh_commentaire || "");

        const src = detail?.param_rh_source || (isCreate ? "studio" : "");
        _setValue("posteRhSource", rhSourceLabel(src));

        const maj = detail?.param_rh_date_maj || "";
        _setValue("posteRhDateMaj", isCreate && !maj ? "CrÃ©ation Ã  lâ€™enregistrement" : formatRhDateMaj(maj));

        refreshPosteRhCriticiteHelp();
        refreshPosteRhDateFinVisibility();
    }

        // ------------------------------------------------------
    // Poste > ParamÃ©trage RH > Cotation conventionnelle
    // ------------------------------------------------------
    function resetPosteCcnUi(isCreate){
        if (_orgCcnController){
            _orgCcnController.resetUi(!!isCreate);
        }
    }

    async function loadPosteCcnContext(portal){
        const ctrl = await ensureStudioOrganisationCcnController(portal);
        if (!ctrl) return null;
        return await ctrl.loadContext(portal);
    }

    async function refreshPosteCcnContextAfterSave(portal){
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        try{
            await loadPosteCcnContext(portal);
        } catch(e){
            console.warn("[Studio][Organisation] Impossible de rafraÃ®chir la cotation conventionnelle aprÃ¨s enregistrement du poste", e);
        }
    }

    async function openPosteCcnModal(portal){
        const ctrl = await ensureStudioOrganisationCcnController(portal);
        if (!ctrl) return;
        await ctrl.openModal(portal);
    }

    function closePosteCcnModal(){
        if (_orgCcnController){
            _orgCcnController.closeModal();
        }
    }

    function reusePosteCcnProposal(){
        if (_orgCcnController){
            _orgCcnController.reuseProposal();
        }
    }

    async function runPosteCcnAnalysis(portal){
        const ctrl = await ensureStudioOrganisationCcnController(portal);
        if (!ctrl) return;
        await ctrl.runAnalysis(portal);
    }

    async function savePosteCcnDecision(portal){
        const ctrl = await ensureStudioOrganisationCcnController(portal);
        if (!ctrl) return;
        await ctrl.saveDecision(portal);
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
        const respHtml = rtGetPosteRespHtml();
        const respTxt = htmlToPlainText(respHtml);
        const ctr = (byId("posteCtrDetailContrainte")?.value || "").trim();
        const pieces = [];
        if ((byId("posteCtrMobilite")?.value || "").trim()) pieces.push(`MobilitÃ©: ${(byId("posteCtrMobilite").value || "").trim()}`);
        if ((byId("posteCtrRisquePhys")?.value || "").trim()) pieces.push(`Risques physiques: ${(byId("posteCtrRisquePhys").value || "").trim()}`);
        if ((byId("posteCtrNivContrainte")?.value || "").trim()) pieces.push(`Niveau de contraintes: ${(byId("posteCtrNivContrainte").value || "").trim()}`);
        if ((byId("posteCtrPerspEvol")?.value || "").trim()) pieces.push(`Perspectives: ${(byId("posteCtrPerspEvol").value || "").trim()}`);
        if ((byId("posteCtrEduMin")?.value || "").trim()) pieces.push(`Niveau d'Ã©tude minimum: ${(byId("posteCtrEduMin").value || "").trim()}`);
        const mergedCtr = [ctr, pieces.join(" | ")].filter(Boolean).join("\n");

        if (byId("posteAiIntitule") && !byId("posteAiIntitule").value.trim()) byId("posteAiIntitule").value = title;
        if (byId("posteAiContexte") && !byId("posteAiContexte").value.trim()) byId("posteAiContexte").value = mission;
        if (byId("posteAiTaches") && !byId("posteAiTaches").value.trim()) byId("posteAiTaches").value = respTxt;
        if (byId("posteAiContraintes") && !byId("posteAiContraintes").value.trim()) byId("posteAiContraintes").value = mergedCtr;
    }

    function openPosteAiModal(){
        const ttl = byId("posteAiTitle");
        const sub = byId("posteAiSub");

        if (ttl) ttl.textContent = (_posteModalMode === "edit")
            ? "Proposer des textes de remplacement avec lâ€™IA"
            : "GÃ©nÃ©rer une fiche de poste avec lâ€™IA";

        if (sub) sub.textContent = (_posteModalMode === "edit")
            ? "Lâ€™IA reformule et enrichit la fiche actuelle sans changer le mÃ©tier visÃ©."
            : "Lâ€™IA propose un brouillon exploitable Ã  partir de tes Ã©lÃ©ments et dâ€™une recherche web.";

        resetPosteAiModalFields();
        seedPosteAiModalFromCurrent();
        openModal("modalPosteAi");
    }

    function closePosteAiModal(){
        resetPosteAiModalFields();
        closeModal("modalPosteAi");
    }

    async function generatePosteAiDraft(portal){
        const ownerId = getOwnerId();
        const payload = {
            mode: _posteModalMode || "create",
            id_poste: _editingPosteId || null,
            current_intitule_poste: (byId("posteIntitule")?.value || "").trim() || null,
            current_mission_principale: (byId("posteMission")?.value || "").trim() || null,
            current_responsabilites_html: rtGetPosteRespHtml() || null,
            intitule: (byId("posteAiIntitule")?.value || "").trim(),
            contexte: (byId("posteAiContexte")?.value || "").trim() || null,
            taches: (byId("posteAiTaches")?.value || "").trim() || null,
            outils: (byId("posteAiOutils")?.value || "").trim() || null,
            environnement: (byId("posteAiEnvironnement")?.value || "").trim() || null,
            interactions: (byId("posteAiInteractions")?.value || "").trim() || null,
            contraintes: (byId("posteAiContraintes")?.value || "").trim() || null,
        };

        if (!payload.intitule){
            portal.showAlert("error", "IntitulÃ© du poste obligatoire pour lancer la gÃ©nÃ©ration IA.");
            return;
        }

            const btn = byId("btnPosteAiGenerate");
            if (btn){ btn.disabled = true; btn.style.opacity = ".6"; btn.textContent = "GÃ©nÃ©rationâ€¦"; }

            openIaBusyOverlay(
                "GÃ©nÃ©ration IA de la fiche de poste",
                "Recherche web, analyse du contexte mÃ©tier et rÃ©daction du brouillon..."
            );

            try{
            const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_draft`);
            let draft = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            draft = repairAiDraftPayload(draft || {});
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
            if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.textContent = "GÃ©nÃ©rer"; }
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
        if (loading){ loading.style.display = "none"; loading.textContent = "Analyse en coursâ€¦"; }
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
            responsabilites_html: rtGetPosteRespHtml() || null,
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
        opt0.textContent = "â€”";
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

    function getPosteCompCreateDomainMetaById(domainId){
        const id = (domainId || "").toString().trim();
        if (!id) return null;

        return (_posteCompCreateDomainItems || []).find(d =>
            (d.id_domaine_competence || "").toString().trim() === id
        ) || null;
    }

    function resolvePosteCompCreateDomainIdFromAiItem(item){
        const explicitId = (item?.domaine_id || "").toString().trim();
        if (explicitId && getPosteCompCreateDomainMetaById(explicitId)) return explicitId;

        const rawLabel = (item?.domaine_label || item?.domaine_hint || item?.domaine || "").toString().trim().toLowerCase();
        if (!rawLabel) return explicitId || "";

        const found = (_posteCompCreateDomainItems || []).find(d => {
            const id = (d.id_domaine_competence || "").toString().trim().toLowerCase();
            const titre = (d.titre || "").toString().trim().toLowerCase();
            const court = (d.titre_court || "").toString().trim().toLowerCase();
            return rawLabel === id || rawLabel === titre || rawLabel === court;
        });

        return (found?.id_domaine_competence || explicitId || "").toString().trim();
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
        reorderPosteCompCreateCrit();
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

        reorderPosteCompCreateCrit();
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

    function reorderPosteCompCreateCrit(){
        if (!Array.isArray(_posteCompCreateCrit)) return;

        const filled = [];
        const empty = [];

        for (let i = 0; i < _posteCompCreateCrit.length; i++){
            const c = _posteCompCreateCrit[i] || posteCompCreateEmptyCrit();
            const hasNom = (c.Nom || "").trim().length > 0;
            const hasEval = Array.isArray(c.Eval) && c.Eval.some(x => (x || "").trim().length > 0);

            if (hasNom || hasEval) filled.push(c);
            else empty.push(posteCompCreateEmptyCrit());
        }

        _posteCompCreateCrit = [...filled, ...empty].slice(0, 4);
        while (_posteCompCreateCrit.length < 4){
            _posteCompCreateCrit.push(posteCompCreateEmptyCrit());
        }
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
        if (title) title.textContent = `CritÃ¨re ${idx+1}`;

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

            if (used >= 4){
                btnAdd.title = "Maximum 4 critÃ¨res.";
            } else if (used >= 3){
                btnAdd.title = "4e critÃ¨re seulement si nÃ©cessaire.";
            } else {
                btnAdd.title = "1 Ã  3 critÃ¨res suffisent dans la plupart des cas.";
            }
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
            t.textContent = `CritÃ¨re ${i+1} â€“ ${nom}`;
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

                const btnDelete = document.createElement("button");
                btnDelete.type = "button";
                btnDelete.className = "sb-btn sb-btn--soft sb-btn--xs";
                btnDelete.textContent = "Supprimer";
                btnDelete.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    _posteCompCreateCrit[i] = posteCompCreateEmptyCrit();
                    reorderPosteCompCreateCrit();
                    hidePosteCompCreateCritEditor();
                    renderPosteCompCreateCritList();
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnDelete);
                body.appendChild(ul);
                body.appendChild(actions);
                acc.appendChild(head);
                acc.appendChild(body);
                host.appendChild(acc);
        }

        if (!host.children.length){
            const empty = document.createElement("div");
            empty.className = "card-sub";
            empty.textContent = "Aucun critÃ¨re. Ajoute au moins 1 critÃ¨re.";
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
            portal.showAlert("error", "Nom du critÃ¨re obligatoire.");
            return;
        }
        if (!e1 || !e2 || !e3 || !e4){
            portal.showAlert("error", "Les 4 niveaux dâ€™Ã©valuation sont obligatoires.");
            return;
        }

        _posteCompCreateCrit[_posteCompCreateCritEditIdx] = { Nom: nom, Eval:[e1,e2,e3,e4] };
        reorderPosteCompCreateCrit();
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
            portal.showAlert("error", "Ajoute au moins 1 critÃ¨re dâ€™Ã©valuation.");
            return false;
        }

        for (let i=0;i<4;i++){
            const c = _posteCompCreateCrit[i];
            const nom = (c?.Nom || "").trim();
            const ev = c?.Eval || ["","","",""];
            const anyEval = ev.some(x => (x || "").trim().length > 0);

            if (!nom && !anyEval) continue;

            if (!nom){
                portal.showAlert("error", `CritÃ¨re ${i+1} : nom obligatoire.`);
                return false;
            }
            for (let k=0;k<4;k++){
                if (!(ev[k] || "").trim()){
                    portal.showAlert("error", `CritÃ¨re ${i+1} : niveau ${k+1} obligatoire.`);
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
        closePosteCompImportModal();
        closeModal("modalPosteCompCreate");
        _posteCompCreateCtx = null;
        hidePosteCompCreateCritEditor();
    }

    function setPosteCompCreateFrameMsg(message, isError){
        const el = byId("posteCompCreateFrameMsg");
        if (!el) return;
        el.textContent = message || "";
        el.style.color = isError ? "#b42318" : "";
    }

    function fillPosteCompCreateFrameDomainSelect(selectedId){
        const sel = byId("posteCompCreateFrameDomaine");
        if (!sel) return;
        const selected = (selectedId || "").toString();
        sel.innerHTML = '<option value="">â€”</option>';
        (_posteCompCreateDomainItems || []).forEach(d => {
            const opt = document.createElement("option");
            opt.value = d.id_domaine_competence || "";
            opt.textContent = d.titre_court || d.titre || d.id_domaine_competence || "Domaine";
            sel.appendChild(opt);
        });
        sel.value = selected;
        if (selected && sel.value !== selected) sel.value = "";
    }

    function closePosteCompCreateFrameModal(){
        closeModal("modalPosteCompCreateFrame");
        _posteCompCreateFrameCtx = null;
        setPosteCompCreateFrameMsg("");
    }

    async function openPosteCompCreateModalFromAi(portal, idx, addAfter){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;

        _posteCompCreateFrameCtx = {
            idx: idx,
            addAfter: !!addAfter,
            draft: JSON.parse(JSON.stringify(it || {}))
        };

        await ensurePosteCompCreateDomains(portal);
        const resolvedDomainId = resolvePosteCompCreateDomainIdFromAiItem(it);
        fillPosteCompCreateFrameDomainSelect(resolvedDomainId || "");

        byId("posteCompCreateFrameIntitule").value = (it.intitule || "");
        byId("posteCompCreateFrameDesc").value = (it.description || "");
        byId("posteCompCreateFrameNbCrit").value = "3";
        byId("posteCompCreateFrameWhy").value = (it.why_needed || "");
        setPosteCompCreateFrameMsg("");

        openModal("modalPosteCompCreateFrame");
    }

    function readPosteCompCreateFrameDraft(portal){
        if (!_posteCompCreateFrameCtx) return null;

        const base = JSON.parse(JSON.stringify(_posteCompCreateFrameCtx.draft || {}));
        const title = (byId("posteCompCreateFrameIntitule")?.value || "").trim();
        const desc = (byId("posteCompCreateFrameDesc")?.value || "").trim();
        const dom = (byId("posteCompCreateFrameDomaine")?.value || "").trim();
        const why = (byId("posteCompCreateFrameWhy")?.value || "").trim();
        let nb = parseInt((byId("posteCompCreateFrameNbCrit")?.value || "3").trim(), 10);
        if (![1,2,3,4].includes(nb)) nb = 3;

        if (!title){
            setPosteCompCreateFrameMsg("IntitulÃ© obligatoire.", true);
            return null;
        }
        if (!why){
            setPosteCompCreateFrameMsg("PrÃ©cise ce que cette compÃ©tence doit permettre dâ€™Ã©valuer.", true);
            return null;
        }

        base.intitule = title;
        base.description = desc || base.description || "";
        base.domaine_id = dom || null;
        base.why_needed = why;
        base.nb_criteres = nb;
        return base;
    }

    async function preparePosteCompCreateModalFromFrame(portal){
        const framed = readPosteCompCreateFrameDraft(portal);
        if (!framed || !_posteCompCreateFrameCtx) return;

        const ctx = {
            idx: _posteCompCreateFrameCtx.idx,
            addAfter: !!_posteCompCreateFrameCtx.addAfter,
            draft: JSON.parse(JSON.stringify(framed || {}))
        };

        closePosteCompCreateFrameModal();
        await preparePosteCompCreateModal(portal, ctx);
    }

    async function openPosteCompCreateManualModalFromAi(portal, idx, addAfter){
        const it = (_posteCompAiResults?.missing || [])[idx];
        if (!it) return;

        await ensurePosteCompCreateDomains(portal);
        const resolvedDomainId = resolvePosteCompCreateDomainIdFromAiItem(it);

        _posteCompCreateCtx = {
            idx: idx,
            addAfter: !!addAfter,
            manual: true,
            draft: JSON.parse(JSON.stringify(it || {}))
        };

        const badge = byId("posteCompCreateBadge");
        if (badge){
            badge.style.display = "";
            badge.textContent = "CrÃ©ation manuelle";
        }

        byId("posteCompCreateTitle").textContent = "CrÃ©er une compÃ©tence";
        byId("posteCompCreateSub").textContent = "CrÃ©ation manuelle depuis la proposition IA. ComplÃ¨te les niveaux et la grille avant validation.";

        byId("posteCompCreateIntitule").value = (it.intitule || "");
        byId("posteCompCreateDesc").value = (it.description || "");
        byId("posteCompCreateEtat").value = "Ã  valider";
        byId("posteCompCreateNivA").value = "";
        byId("posteCompCreateNivB").value = "";
        byId("posteCompCreateNivC").value = "";
        if (byId("posteCompCreateNivD")) byId("posteCompCreateNivD").value = "";

        fillPosteCompCreateDomainSelect(resolvedDomainId || "");
        resetPosteCompCreateCrit();

        openModal("modalPosteCompCreate");
    }

    async function preparePosteCompCreateModal(portal, ctx){
        if (!ctx) return;

        _posteCompCreateCtx = {
            idx: ctx.idx,
            addAfter: !!ctx.addAfter,
            draft: JSON.parse(JSON.stringify(ctx.draft || {}))
        };

        await ensurePosteCompCreateDomains(portal);

        let prepared = JSON.parse(JSON.stringify(ctx.draft || {}));
        const nbCrit = parseInt(prepared.nb_criteres || 3, 10);

        openIaBusyOverlay(
            "PrÃ©paration de la compÃ©tence",
            "GÃ©nÃ©ration des niveaux de maÃ®trise et de la grille dâ€™Ã©valuation...",
            "Cette opÃ©ration peut prendre quelques instants",
            "La gÃ©nÃ©ration est longue. Ã‰chap ferme lâ€™attente cÃ´tÃ© Ã©cran, sans crÃ©er la compÃ©tence."
        );

        try{
            const ownerId = getOwnerId();
            const pid = (_posteModalMode === "edit" && _editingPosteId) ? _editingPosteId : null;

            const res = await portal.apiJson(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_prepare`),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id_poste: pid,
                        draft: prepared,
                        nb_criteres: [1,2,3,4].includes(nbCrit) ? nbCrit : 3
                    })
                }
            );

            if (res && res.draft && typeof res.draft === "object"){
                prepared = res.draft;
            }
            if (typeof repairAiDraftPayload === "function"){
                prepared = repairAiDraftPayload(prepared || {});
            }
        } catch (e){
            console.warn("[PosteCompCreate][prepare]", e);
        } finally {
            closeIaBusyOverlay();
        }

        _posteCompCreateCtx.draft = JSON.parse(JSON.stringify(prepared || {}));

        const badge = byId("posteCompCreateBadge");
        if (badge){
            badge.style.display = "none";
            badge.textContent = "";
        }

        byId("posteCompCreateTitle").textContent = "CrÃ©er une compÃ©tence";
        byId("posteCompCreateSub").textContent = "Brouillon proposÃ© par lâ€™IA. Tu valides / ajustes avant crÃ©ation.";

        byId("posteCompCreateIntitule").value = (prepared.intitule || "");
        byId("posteCompCreateDesc").value = (prepared.description || "");
        byId("posteCompCreateEtat").value = "Ã  valider";
        byId("posteCompCreateNivA").value = (prepared.niveaua || "");
        byId("posteCompCreateNivB").value = (prepared.niveaub || "");
        byId("posteCompCreateNivC").value = (prepared.niveauc || "");
        if (byId("posteCompCreateNivD")) byId("posteCompCreateNivD").value = (prepared.niveaud || "");

        fillPosteCompCreateDomainSelect(prepared.domaine_id || "");
        loadPosteCompCreateCritFromJson(prepared.grille_evaluation || null);
        ensurePosteCompCreateActionButtons(portal);

        openModal("modalPosteCompCreate");
    }

function promoteMissingAiCompetenceToExisting(meta){
        if (!_posteCompCreateCtx) return;

        const idx = _posteCompCreateCtx.idx;
        const added = !!meta?.added;
        const etat = (meta?.etat || "Ã  valider").toString();
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
        const recLevel = nsLevelKey(src.recommended_level) || "C";
        existing.unshift({
            id_comp: meta?.id_comp || "",
            code: meta?.code || "",
            intitule: title || (src.intitule || ""),
            domaine: domainId || (src.domaine_id || ""),
            domaine_titre_court: domainLabel || (src.domaine_label || ""),
            domaine_couleur: domainMeta?.couleur || src.domaine_couleur || null,
            etat: etat,
            recommended_level: recLevel,
            recommended_level_label: src.recommended_level_label || nsLevelLabel(recLevel),
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
        const etat = (byId("posteCompCreateEtat").value || "Ã  valider").trim();
        const desc = (byId("posteCompCreateDesc").value || "").trim();
        const nivA = (byId("posteCompCreateNivA").value || "").trim();
        const nivB = (byId("posteCompCreateNivB").value || "").trim();
        const nivC = (byId("posteCompCreateNivC").value || "").trim();
        const nivD = (byId("posteCompCreateNivD")?.value || "").trim();

        if (!title){
            portal.showAlert("error", "IntitulÃ© obligatoire.");
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
            const draftSrc = _posteCompCreateCtx?.draft || {};
            const pid = addAfter ? await ensureEditingPoste(portal) : (_editingPosteId || null);
            const recLevel = nsLevelKey(draftSrc.recommended_level) || "C";

            const created = await portal.apiJson(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_create`),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        id_poste: pid,
                        add_to_poste: !!addAfter,
                        draft: {
                            intitule: title,
                            description: desc || null,
                            domaine_id: dom || null,
                            etat: etat || null,
                            niveaua: nivA || null,
                            niveaub: nivB || null,
                            niveauc: nivC || null,
                            niveaud: nivD || null,
                            grille_evaluation: grille,
                            recommended_level: recLevel,
                            freq_usage: parseInt(draftSrc.freq_usage ?? 0, 10) || 0,
                            impact_resultat: parseInt(draftSrc.impact_resultat ?? 0, 10) || 0,
                            dependance: parseInt(draftSrc.dependance ?? 0, 10) || 0,
                            search_terms: Array.isArray(draftSrc.search_terms) ? draftSrc.search_terms : []
                        }
                    })
                }
            );

            if (addAfter){
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
        } finally {
            if (btnMain){
                btnMain.disabled = false;
                btnMain.style.opacity = "";
            }
        }
    }


    function normalizePosteCompAiRole(value){
        const n = normText(value || "");
        if (n.includes("transversal")) return "transversal";
        if (n.includes("complement")) return "complementaire";
        if (n.includes("coeur") || n.includes("cÅ“ur")) return "coeur";
        return "coeur";
    }

    function applyPosteCompAiRoleCardStyle(row, importance){
        if (!row) return;
        const role = normalizePosteCompAiRole(importance);
        const palette = {
            coeur: { border: "#f59e0b", rgb: "245,158,11" },
            complementaire: { border: "#22c55e", rgb: "34,197,94" },
            transversal: { border: "#8b5cf6", rgb: "139,92,246" }
        };
        const p = palette[role] || palette.coeur;
        row.dataset.aiCompRole = role;
        row.style.borderColor = p.border;
        row.style.boxShadow = `0 8px 22px rgba(${p.rgb}, .16)`;
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

        if (!existing.length && !missing.length){
            summary.textContent = "Aucune compÃ©tence structurante exploitable nâ€™a Ã©tÃ© retenue pour ce poste avec les Ã©lÃ©ments fournis.";
        } else {
            summary.textContent = `${existing.length} compÃ©tence(s) trouvÃ©e(s) dans le rÃ©fÃ©rentiel, ${missing.length} Ã  crÃ©er.`;
        }
        summary.style.display = "";

        exList.innerHTML = "";
        miList.innerHTML = "";
        exWrap.style.display = existing.length ? "" : "none";
        miWrap.style.display = missing.length ? "" : "none";

        existing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card sb-ai-existing-row";

            const left = document.createElement("div");
            left.className = "sb-row-left";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = (it.code || "â€”");

            const wrap = document.createElement("div");
            wrap.style.minWidth = "0";

            const title = document.createElement("div");
            title.className = "sb-row-title";
            title.textContent = (it.intitule || "");

            const meta = document.createElement("div");
            meta.style.display = "flex";
            meta.style.gap = "8px";
            meta.style.flexWrap = "wrap";
            meta.style.alignItems = "center";
            meta.style.margin = "6px 0 0 0";

            const dom = buildAiCompDomainBadge(it.domaine_titre_court || "", it.domaine_couleur);
            if (dom) meta.appendChild(dom);

            if (((it.etat || "").toLowerCase()) === "Ã  valider"){
                const et = document.createElement("span");
                et.className = "sb-badge sb-badge--draft";
                et.textContent = "Brouillon";
                meta.appendChild(et);
            }

            wrap.appendChild(title);
            wrap.appendChild(meta);

            left.appendChild(code);
            left.appendChild(wrap);

            const matchCol = document.createElement("div");
            matchCol.className = "sb-ai-existing-match";

            const matchBadge = buildAiMatchBadge(it.match_label || "", it.match_score);
            if (matchBadge) matchCol.appendChild(matchBadge);

            if (it.match_score !== undefined && it.match_score !== null){
                matchCol.appendChild(buildAiMatchScoreText(it.match_score, it.match_percent));
            }

            const right = document.createElement("div");
            right.className = "sb-row-right sb-ai-existing-actions";

            const btnPdf = document.createElement("button");
            btnPdf.type = "button";
            btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
            btnPdf.title = "Voir fiche";
            btnPdf.setAttribute("aria-label", "Voir fiche compÃ©tence");
            btnPdf.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <path d="M14 2v6h6"/>
                    <path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-3z"/>
                    <path d="M13 13v3"/>
                    <path d="M13 13h3"/>
                    <path d="M16 13v3"/>
                </svg>
            `;
            btnPdf.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const titlePdf = `Fiche compÃ©tence - ${String(it.code || "").trim() ? `${String(it.code).trim()} - ` : ""}${String(it.intitule || "").trim() || "CompÃ©tence"}`;
                let popupWin = null;

                try{
                    popupWin = openPdfLoadingWindow(titlePdf);
                    await openOrgSkillSheetPdf(window.portal, it, popupWin);
                } catch(err){
                    if (popupWin && !popupWin.closed){
                        try { popupWin.close(); } catch(_){}
                    }
                    window.portal.showAlert("error", err?.message || String(err));
                }
            });

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sb-btn sb-btn--accent sb-btn--xs";
            btn.textContent = it._already_added ? "AjoutÃ©e" : "Ajouter";
            btn.disabled = !!it._already_added;
            btn.style.opacity = it._already_added ? ".6" : "";
            btn.addEventListener("click", async () => {
                if (it._already_added) return;
                try { await addExistingCompetenceFromAi(window.portal, idx); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btnPdf);
            right.appendChild(btn);

            row.appendChild(left);
            row.appendChild(matchCol);
            row.appendChild(right);
            exList.appendChild(row);
        });

        missing.forEach((it, idx) => {
            const row = document.createElement("div");
            row.className = "sb-row-card";
            applyPosteCompAiRoleCardStyle(row, it.importance);
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
            right.style.alignItems = "stretch";
            right.style.gap = "8px";
            right.style.flexShrink = "0";
            right.style.minWidth = "116px";

            const btnGenerate = document.createElement("button");
            btnGenerate.type = "button";
            btnGenerate.className = "sb-btn sb-btn--ai sb-btn--xs";
            btnGenerate.textContent = "GÃ©nÃ©rer IA";
            btnGenerate.title = "GÃ©nÃ©rer les niveaux de maÃ®trise et la grille dâ€™Ã©valuation avec lâ€™IA";
            btnGenerate.addEventListener("click", async () => {
                try { await openPosteCompCreateModalFromAi(window.portal, idx, false); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            const btnManual = document.createElement("button");
            btnManual.type = "button";
            btnManual.className = "sb-btn sb-btn--outline sb-btn--xs";
            btnManual.textContent = "CrÃ©er";
            btnManual.title = "CrÃ©er manuellement la compÃ©tence Ã  partir du titre, du domaine et de la description";
            btnManual.addEventListener("click", async () => {
                try { await openPosteCompCreateManualModalFromAi(window.portal, idx, false); }
                catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
            });

            right.appendChild(btnGenerate);
            right.appendChild(btnManual);

            row.appendChild(left);
            row.appendChild(right);
            miList.appendChild(row);
        });
    }

    async function openPosteCompAiModal(portal){
        const title = (byId("posteIntitule")?.value || "").trim();
        if (!title){
            portal.showAlert("error", "Renseigne au moins lâ€™intitulÃ© du poste avant la recherche IA.");
            return;
        }

        abortPosteCompAiSearch();
        resetPosteCompAiUi();

        const runId = ++_posteCompAiSearchRunId;
        const controller = new AbortController();
        _posteCompAiSearchAbort = controller;

        const loading = byId("posteCompAiLoading");
        if (loading) loading.style.display = "";

        openIaBusyOverlay(
            "Recherche IA des compÃ©tences",
            "Analyse du poste et rapprochement avec le catalogue de compÃ©tences...",
            "Cette opÃ©ration peut prendre quelques minutes",
            "La durÃ©e est anormalement longue. Appuyez sur Ã‰chap pour annuler cÃ´tÃ© Ã©cran, puis relancer."
        );

        try{
            const ownerId = getOwnerId();
            const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_search`);

            const res = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(buildPosteCompAiPayload()),
                signal: controller.signal,
            });

            if (runId !== _posteCompAiSearchRunId || controller.signal.aborted){
                return;
            }

            _posteCompAiResults = {
                existing: Array.isArray(res?.existing) ? res.existing : [],
                missing: Array.isArray(res?.missing) ? res.missing : [],
            };
            renderPosteCompAiResults();
            openModal("modalPosteCompAi");
        } catch(e){
            if (isAbortError(e) || controller.signal.aborted) return;
            throw e;
        } finally {
            if (runId === _posteCompAiSearchRunId){
                _posteCompAiSearchAbort = null;
                closeIaBusyOverlay();
                if (loading) loading.style.display = "none";
            }
        }
    }

    async function ensureEditingPoste(portal){
        if (_posteModalMode === "edit" && _editingPosteId) return _editingPosteId;
        await savePosteFromModal(portal, { keepOpen: true, silent: true, statusMessage: "Poste crÃ©Ã©." });
        if (!_editingPosteId) throw new Error("Le poste nâ€™a pas pu Ãªtre crÃ©Ã© avant lâ€™ajout des compÃ©tences.");
        return _editingPosteId;
    }

    async function addExistingCompetenceFromAi(portal, idx){
        const it = (_posteCompAiResults?.existing || [])[idx];
        if (!it || !it.id_comp) return;

        const pid = await ensureEditingPoste(portal);
        const ownerId = getOwnerId();
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`);

        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id_competence: it.id_comp,
                niveau_requis: nsLevelKey(it.recommended_level) || "C",
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
        const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/ai_comp_create`);
        const r = await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id_poste: pid, draft: it }),
        });
        await loadPosteCompetences(portal);
        const btn = document.querySelector(`[data-ai-missing-create="${idx}"]`);
        if (btn){ btn.disabled = true; btn.textContent = `CrÃ©Ã©e (${r?.code || "OK"})`; }
    }

    // ------------------------------------------------------
    // Poste > Exigences > CompÃ©tences
    // ------------------------------------------------------
    async function loadPosteCompetences(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`);
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
        _posteCompExpanded = false;
        renderPosteCompetences();
    }

    function renderPosteCompetences(){
        const tb = byId("posteCompTbody");
        const empty = byId("posteCompEmpty");
        const more = byId("posteCompMore");
        const moreText = byId("posteCompMoreText");
        if (!tb) return;

        const levelMeta = (niv) => {
            const key = nsLevelKey(niv);
            if (key) {
                return { text: nsLevelLabel(key), cls: `sb-badge--niv sb-badge--niv-${key.toLowerCase()}` };
            }
            return { text: "â€”", cls: "sb-badge--outline-accent" };
        };

        const critMeta = (score) => {
            const n = parseInt(score ?? 0, 10);
            if (Number.isNaN(n)) return { text: "â€”", cls: "sb-crit-badge--low" };
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

        const iconPdf = `
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <path d="M14 2v6h6"/>
                <path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-3z"/>
                <path d="M13 13v3"/>
                <path d="M13 13h3"/>
                <path d="M16 13v3"/>
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
            if (more) more.style.display = "none";
            return;
        }
        if (empty) empty.style.display = "none";

        const limit = POSTE_COMP_COLLAPSED_LIMIT;
        const hidden = Math.max(0, items.length - limit);
        const visibleItems = _posteCompExpanded ? items : items.slice(0, limit);

        visibleItems.forEach(it => {
            const tr = document.createElement("tr");

            const tdComp = document.createElement("td");
            const compWrap = document.createElement("div");
            compWrap.className = "sb-comp-cell";

            const code = document.createElement("span");
            code.className = "sb-badge sb-badge--comp";
            code.textContent = it.code || "â€”";

            const title = document.createElement("div");
            title.className = "sb-comp-cell__title";
            title.textContent = it.intitule || "";
            title.title = it.intitule || "";

            const statutEval = (it.statut_eval || "proposition").toString().trim().toLowerCase();
            const isProposal = statutEval === "proposition";
            if (isProposal){
                title.classList.add("sb-comp-cell__title--proposal");
                title.title = `${it.intitule || ""} â€” compÃ©tence prÃ©Ã©valuÃ©e, Ã  confirmer par lâ€™enregistrement de lâ€™Ã©valuation.`;
            }

            compWrap.appendChild(code);
            compWrap.appendChild(title);
            if (isProposal){
                const hint = document.createElement("span");
                hint.className = "sb-comp-cell__proposal-hint";
                hint.textContent = "?";
                hint.title = "CompÃ©tence prÃ©Ã©valuÃ©e : lâ€™intitulÃ© reste orange jusquâ€™Ã  lâ€™enregistrement complet de lâ€™Ã©valuation.";
                hint.setAttribute("aria-label", hint.title);
                compWrap.appendChild(hint);
            }
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
            tdAct.className = "sb-table-action-cell";

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

                const btnPdf = document.createElement("button");
                btnPdf.type = "button";
                btnPdf.className = "sb-icon-btn sb-icon-btn--doc";
                btnPdf.title = "Voir la fiche compÃ©tence PDF";
                btnPdf.setAttribute("aria-label", "Voir la fiche compÃ©tence PDF");
                btnPdf.innerHTML = iconPdf;
                btnPdf.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const titlePdf = `Fiche compÃ©tence - ${String(it.code || "").trim() ? `${String(it.code).trim()} - ` : ""}${String(it.intitule || "").trim() || "CompÃ©tence"}`;
                    let popupWin = null;

                    try{
                        popupWin = openPdfLoadingWindow(titlePdf);
                        await openOrgSkillSheetPdf(window.portal, it, popupWin);
                    } catch(err){
                        if (popupWin && !popupWin.closed){
                            try { popupWin.close(); } catch(_){}
                        }
                        window.portal.showAlert("error", err?.message || String(err));
                    }
                });

                const btnRem = document.createElement("button");
                btnRem.type = "button";
                btnRem.className = "sb-icon-btn sb-icon-btn--danger";
                btnRem.title = "Retirer";
                btnRem.setAttribute("aria-label", "Retirer");
                btnRem.innerHTML = iconTrash;
                btnRem.addEventListener("click", async () => {
                    if (!confirm(`Retirer la compÃ©tence "${it.code || ""} â€“ ${it.intitule || ""}" du poste ?`)) return;
                    try { await removePosteCompetence(window.portal, it.id_competence); }
                    catch(e){ window.portal.showAlert("error", e?.message || String(e)); }
                });

                actions.appendChild(btnEdit);
                actions.appendChild(btnPdf);
                actions.appendChild(btnRem);
                tdAct.appendChild(actions);
            } else {
                tdAct.textContent = "â€”";
            }

            tr.appendChild(tdComp);
            tr.appendChild(tdNiv);
            tr.appendChild(tdCrit);
            tr.appendChild(tdAct);

            tb.appendChild(tr);
        });

        if (more){
            more.style.display = hidden > 0 ? "flex" : "none";
            more.classList.toggle("is-expanded", !!_posteCompExpanded);
            more.setAttribute("aria-expanded", _posteCompExpanded ? "true" : "false");
            if (moreText){
                moreText.textContent = _posteCompExpanded
                    ? "Voir moins de compÃ©tences"
                    : `Voir plus de compÃ©tences (${hidden})`;
            }
        }
    }


    function getPosteCompAddSelectedDomainLabel(){
        const sel = byId("posteCompAddDomain");
        if (!sel) return "";
        const opt = sel.options ? sel.options[sel.selectedIndex] : null;
        const val = (sel.value || "").trim();
        if (!val || val === "__none__") return "";
        return (opt?.textContent || "").trim();
    }

    function buildPosteCompDraftFromAddSearch(){
        const search = (byId("posteCompAddSearch")?.value || _posteCompAddSearch || "").trim();
        const domainId = (_posteCompAddDomain || "").trim();
        return {
            intitule: search,
            description: "",
            domaine_id: (domainId && domainId !== "__none__") ? domainId : "",
            domaine_label: getPosteCompAddSelectedDomainLabel(),
            domaine_hint: getPosteCompAddSelectedDomainLabel(),
            recommended_level: "C",
            freq_usage: 0,
            impact_resultat: 0,
            dependance: 0,
            search_terms: search ? [search] : [],
            why_needed: "",
            type_competence: "generique",
            importance: "coeur"
        };
    }

    function ensurePosteCompAddCreateAction(){
        const list = byId("posteCompAddList");
        if (!list) return;

        let action = byId("posteCompAddCreateAction");
        if (!action){
            action = document.createElement("div");
            action.id = "posteCompAddCreateAction";
            action.style.display = "flex";
            action.style.justifyContent = "flex-end";
            action.style.gap = "8px";
            action.style.marginTop = "14px";
            action.style.paddingTop = "12px";
            action.style.borderTop = "1px solid #e5e7eb";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.id = "btnPosteCompAddCreateNew";
            btn.className = "sb-btn sb-btn--accent";
            btn.textContent = "CrÃ©er une compÃ©tence";
            btn.addEventListener("click", async () => {
                try { await openPosteCompCreateManualModalFromCatalog(window.portal); }
                catch(e){ window.portal?.showAlert?.("error", e?.message || String(e)); }
            });

            action.appendChild(btn);
            list.insertAdjacentElement("afterend", action);
        }
    }

    function ensurePosteCompCreateActionButtons(portal){
        const mainBtn = byId("btnPosteCompCreateOnly");
        if (!mainBtn) return;

        const parent = mainBtn.parentElement;
        if (!parent) return;

        let btnImport = byId("btnPosteCompCreateImportDoc");
        if (!btnImport){
            btnImport = document.createElement("button");
            btnImport.type = "button";
            btnImport.id = "btnPosteCompCreateImportDoc";
            btnImport.textContent = "Importer";
            btnImport.title = "Importer un PDF, DOC ou DOCX pour prÃ©remplir la fiche compÃ©tence.";
            btnImport.addEventListener("click", () => openPosteCompImportModal());
        }
        btnImport.className = "sb-btn sb-btn--outline";

        let btnIa = byId("btnPosteCompCreateGenerateCurrent");
        if (!btnIa){
            btnIa = document.createElement("button");
            btnIa.type = "button";
            btnIa.id = "btnPosteCompCreateGenerateCurrent";
            btnIa.textContent = "GÃ©nÃ©rer IA";
            btnIa.title = "Cadrer la compÃ©tence puis gÃ©nÃ©rer les niveaux et critÃ¨res.";
            btnIa.addEventListener("click", async () => {
                try { await openPosteCompCreateFrameFromCurrentCreate(portal); }
                catch(e){ portal.showAlert("error", e?.message || String(e)); }
            });
        }
        btnIa.className = "sb-btn sb-btn--ai";

        // Ordre voulu : Importer | GÃ©nÃ©rer IA | Enregistrer / CrÃ©er.
        parent.insertBefore(btnImport, mainBtn);
        parent.insertBefore(btnIa, mainBtn);
    }

    function buildPosteCompCreateDraftFromCurrent(){
        const base = JSON.parse(JSON.stringify(_posteCompCreateCtx?.draft || {}));
        const title = (byId("posteCompCreateIntitule")?.value || "").trim();
        const desc = (byId("posteCompCreateDesc")?.value || "").trim();
        const dom = (byId("posteCompCreateDomaine")?.value || "").trim();
        const etat = (byId("posteCompCreateEtat")?.value || "Ã  valider").trim();

        base.intitule = title || base.intitule || "";
        base.description = desc || base.description || "";
        base.domaine_id = dom || base.domaine_id || "";
        base.etat = etat || base.etat || "Ã  valider";
        base.niveaua = (byId("posteCompCreateNivA")?.value || base.niveaua || "").trim();
        base.niveaub = (byId("posteCompCreateNivB")?.value || base.niveaub || "").trim();
        base.niveauc = (byId("posteCompCreateNivC")?.value || base.niveauc || "").trim();
        base.niveaud = (byId("posteCompCreateNivD")?.value || base.niveaud || "").trim();

        const meta = getPosteCompCreateDomainMetaById(dom);
        if (meta){
            base.domaine_label = (meta.titre_court || meta.titre || "").toString();
            base.domaine_hint = base.domaine_label;
        }

        if (!Array.isArray(base.search_terms)) base.search_terms = base.intitule ? [base.intitule] : [];
        if (!base.recommended_level) base.recommended_level = "C";
        if (base.freq_usage === undefined) base.freq_usage = 0;
        if (base.impact_resultat === undefined) base.impact_resultat = 0;
        if (base.dependance === undefined) base.dependance = 0;
        return base;
    }

    async function openPosteCompCreateFrameFromCurrentCreate(portal){
        if (!_posteCompCreateCtx){
            portal.showAlert("error", "Aucune compÃ©tence en cours de crÃ©ation.");
            return;
        }
        await ensurePosteCompCreateDomains(portal);
        const draft = buildPosteCompCreateDraftFromCurrent();
        if (!draft.intitule){
            portal.showAlert("error", "Renseigne au moins lâ€™intitulÃ© de la compÃ©tence avant de lancer lâ€™IA.");
            return;
        }

        _posteCompCreateFrameCtx = {
            idx: Number.isInteger(_posteCompCreateCtx.idx) ? _posteCompCreateCtx.idx : -1,
            addAfter: _posteCompCreateCtx.addAfter !== false,
            draft: JSON.parse(JSON.stringify(draft || {}))
        };

        fillPosteCompCreateFrameDomainSelect(draft.domaine_id || "");
        byId("posteCompCreateFrameIntitule").value = draft.intitule || "";
        byId("posteCompCreateFrameDesc").value = draft.description || "";
        byId("posteCompCreateFrameNbCrit").value = String(draft.nb_criteres || "3");
        byId("posteCompCreateFrameWhy").value = draft.why_needed || "";
        setPosteCompCreateFrameMsg("");

        closeModal("modalPosteCompCreate");
        openModal("modalPosteCompCreateFrame");
    }

    async function openPosteCompCreateManualModalFromCatalog(portal){
        await ensurePosteCompCreateDomains(portal);
        const draft = buildPosteCompDraftFromAddSearch();
        _posteCompCreateCtx = { idx: -1, addAfter: true, draft: JSON.parse(JSON.stringify(draft || {})) };

        const badge = byId("posteCompCreateBadge");
        if (badge){ badge.style.display = ""; badge.textContent = "CrÃ©ation manuelle"; }

        byId("posteCompCreateTitle").textContent = "CrÃ©er une compÃ©tence";
        byId("posteCompCreateSub").textContent = "CrÃ©ation depuis le poste. ComplÃ¨te la fiche manuellement ou utilise GÃ©nÃ©rer IA / Importer.";
        byId("posteCompCreateIntitule").value = draft.intitule || "";
        byId("posteCompCreateDesc").value = draft.description || "";
        byId("posteCompCreateEtat").value = "Ã  valider";
        byId("posteCompCreateNivA").value = "";
        byId("posteCompCreateNivB").value = "";
        byId("posteCompCreateNivC").value = "";
        if (byId("posteCompCreateNivD")) byId("posteCompCreateNivD").value = "";

        fillPosteCompCreateDomainSelect(draft.domaine_id || "");
        resetPosteCompCreateCrit();
        ensurePosteCompCreateActionButtons(portal);
        closeModal("modalPosteCompAdd");
        openModal("modalPosteCompCreate");
    }

    function ensurePosteCompImportModal(){
        let modal = byId("modalPosteCompImport") || document.getElementById("modalPosteCompImport");
        if (modal) return modal;

        const root = getOrganisationRoot() || document.body;
        modal = document.createElement("div");
        modal.className = "sb-modal";
        modal.id = "modalPosteCompImport";
        modal.style.display = "none";
        modal.innerHTML = `
          <div class="sb-modal-card" style="max-width:620px;">
            <div class="sb-modal-head">
              <div>
                <div class="card-title">Importer un document</div>
                <div class="card-sub">PDF, DOC ou DOCX. Le texte extrait alimentera la fiche compÃ©tence et le cadrage IA.</div>
              </div>
              <button type="button" class="sb-modal-x" id="btnClosePosteCompImport" aria-label="Fermer">&times;</button>
            </div>
            <div class="sb-modal-body">
              <input type="file" id="posteCompImportFileInput" accept=".pdf,.doc,.docx" style="display:none;" />
              <div id="posteCompImportDropzone" class="sb-import-drop" style="border:1px dashed #cbd5e1;border-radius:14px;padding:18px;background:#f8fafc;cursor:pointer;">
                <div style="font-weight: var(--ns-weight-bold);margin-bottom:4px;">DÃ©poser un document ou cliquer pour sÃ©lectionner</div>
                <div class="card-sub" id="posteCompImportEmpty">Aucun document sÃ©lectionnÃ©.</div>
              </div>
              <div id="posteCompImportFileCard" class="sb-row-card" style="display:none;margin-top:12px;">
                <div class="sb-row-left">
                  <span class="sb-badge sb-badge--accent-soft">DOC</span>
                  <div>
                    <div class="sb-row-title" id="posteCompImportFileName">â€”</div>
                    <div class="card-sub" id="posteCompImportFileMeta">â€”</div>
                  </div>
                </div>
              </div>
              <div id="posteCompImportMsg" class="card-sub" style="margin-top:10px;"></div>
              <div class="sb-modal-actions" style="margin-top:16px;">
                <button type="button" class="sb-btn sb-btn--soft" id="btnPosteCompImportChange" disabled>Changer</button>
                <button type="button" class="sb-btn sb-btn--accent" id="btnPosteCompImportAnalyze" disabled>Importer le texte</button>
              </div>
            </div>
          </div>`;
        root.appendChild(modal);

        modal.addEventListener("click", (e) => { if (e.target === modal) closePosteCompImportModal(); });
        modal.querySelector("#btnClosePosteCompImport")?.addEventListener("click", closePosteCompImportModal);
        modal.querySelector("#posteCompImportDropzone")?.addEventListener("click", () => modal.querySelector("#posteCompImportFileInput")?.click());
        modal.querySelector("#btnPosteCompImportChange")?.addEventListener("click", () => modal.querySelector("#posteCompImportFileInput")?.click());
        modal.querySelector("#posteCompImportFileInput")?.addEventListener("change", (e) => {
            try { setPosteCompImportFile(e.target.files?.[0] || null); }
            catch(err){ window.portal?.showAlert?.("error", err?.message || String(err)); }
        });
        modal.querySelector("#btnPosteCompImportAnalyze")?.addEventListener("click", async () => {
            try { await runPosteCompImport(window.portal); }
            catch(err){ window.portal?.showAlert?.("error", err?.message || String(err)); }
        });
        return modal;
    }

    function resetPosteCompImportState(){
        _posteCompImportFile = null;
        const modal = ensurePosteCompImportModal();
        const input = modal.querySelector("#posteCompImportFileInput");
        const card = modal.querySelector("#posteCompImportFileCard");
        const name = modal.querySelector("#posteCompImportFileName");
        const meta = modal.querySelector("#posteCompImportFileMeta");
        const empty = modal.querySelector("#posteCompImportEmpty");
        const msg = modal.querySelector("#posteCompImportMsg");
        const analyze = modal.querySelector("#btnPosteCompImportAnalyze");
        const change = modal.querySelector("#btnPosteCompImportChange");
        if (input) input.value = "";
        if (card) card.style.display = "none";
        if (name) name.textContent = "â€”";
        if (meta) meta.textContent = "â€”";
        if (empty) empty.textContent = "Aucun document sÃ©lectionnÃ©.";
        if (msg) msg.textContent = "";
        if (analyze){ analyze.disabled = true; analyze.style.opacity = ".6"; }
        if (change){ change.disabled = true; change.style.opacity = ".6"; }
    }

    function getPosteCompImportExt(filename){
        const s = String(filename || "").trim().toLowerCase();
        const i = s.lastIndexOf(".");
        return i >= 0 ? s.slice(i) : "";
    }

    function setPosteCompImportFile(file){
        if (!file) return;
        const ext = getPosteCompImportExt(file.name || "");
        if (!POSTE_IMPORT_EXTENSIONS.includes(ext)) throw new Error("Format non supportÃ©. Utilise un fichier .doc, .docx ou .pdf.");
        if ((file.size || 0) > POSTE_IMPORT_MAX_BYTES) throw new Error("Document trop volumineux. Limite : 15 Mo.");
        _posteCompImportFile = file;
        const modal = ensurePosteCompImportModal();
        const card = modal.querySelector("#posteCompImportFileCard");
        const name = modal.querySelector("#posteCompImportFileName");
        const meta = modal.querySelector("#posteCompImportFileMeta");
        const empty = modal.querySelector("#posteCompImportEmpty");
        const analyze = modal.querySelector("#btnPosteCompImportAnalyze");
        const change = modal.querySelector("#btnPosteCompImportChange");
        if (card) card.style.display = "";
        if (name) name.textContent = file.name || "Document";
        if (meta) meta.textContent = `${ext.toUpperCase().replace(".", "")} Â· ${formatFileSize(file.size || 0)}`;
        if (empty) empty.textContent = "Document chargÃ©. Lance lâ€™import pour alimenter la fiche.";
        if (analyze){ analyze.disabled = false; analyze.style.opacity = ""; }
        if (change){ change.disabled = false; change.style.opacity = ""; }
    }

    function openPosteCompImportModal(){
        ensurePosteCompImportModal();
        resetPosteCompImportState();
        openModal("modalPosteCompImport");
    }

    function closePosteCompImportModal(){
        closeModal("modalPosteCompImport");
    }

    function mergePosteCompImportedDescription(current, imported){
        const c = String(current || "").trim();
        const i = String(imported || "").trim();
        if (!i) return c;
        if (!c) return i;
        if (c.includes(i.slice(0, Math.min(80, i.length)))) return c;
        return `${c}\n\n${i}`.trim();
    }


    function hasPosteCompCreateCritContent(){
        try { return usedPosteCompCreateCritCount() > 0; }
        catch(_) { return false; }
    }

    function setPosteCompCreateValueIfUseful(id, value, overwriteEmptyOnly){
        const el = byId(id);
        if (!el) return false;
        const v = repairAiTextEncodingGlitches(value || "").trim();
        if (!v) return false;
        if (overwriteEmptyOnly && (el.value || "").trim()) return false;
        el.value = v;
        return true;
    }

    function applyPosteCompImportedDraft(data){
        data = repairAiDraftPayload(data || {});
        const extractedText = repairAiTextEncodingGlitches(data.extracted_text || data.import_context || "");

        setPosteCompCreateValueIfUseful("posteCompCreateIntitule", data.intitule || data.title_hint || "", true);

        if (data.description){
            const descEl = byId("posteCompCreateDesc");
            if (descEl){
                const current = (descEl.value || "").trim();
                const imported = repairAiTextEncodingGlitches(data.description || "").trim();
                // Si l'ancien import avait tout jetÃ© dans la description, on remplace par la description catÃ©gorisÃ©e.
                if (!current || current.length > 1400 || current === extractedText.slice(0, current.length)){
                    descEl.value = imported;
                } else {
                    descEl.value = mergePosteCompImportedDescription(current, imported);
                }
            }
        }

        if (data.domaine_id){
            const sel = byId("posteCompCreateDomaine");
            if (sel){
                sel.value = data.domaine_id;
                if (sel.value !== String(data.domaine_id || "")) sel.value = "";
            }
        }

        setPosteCompCreateValueIfUseful("posteCompCreateNivA", data.niveaua || "", true);
        setPosteCompCreateValueIfUseful("posteCompCreateNivB", data.niveaub || "", true);
        setPosteCompCreateValueIfUseful("posteCompCreateNivC", data.niveauc || "", true);
        setPosteCompCreateValueIfUseful("posteCompCreateNivD", data.niveaud || "", true);

        if (data.grille_evaluation && !hasPosteCompCreateCritContent()){
            loadPosteCompCreateCritFromJson(data.grille_evaluation || null);
        }

        const titleEl = byId("posteCompCreateIntitule");
        const descEl = byId("posteCompCreateDesc");
        const domEl = byId("posteCompCreateDomaine");

        if (_posteCompCreateCtx){
            _posteCompCreateCtx.draft = Object.assign({}, _posteCompCreateCtx.draft || {}, {
                intitule: titleEl?.value || _posteCompCreateCtx.draft?.intitule || "",
                description: descEl?.value || _posteCompCreateCtx.draft?.description || "",
                domaine_id: domEl?.value || _posteCompCreateCtx.draft?.domaine_id || "",
                domaine_hint: data.domaine_hint || _posteCompCreateCtx.draft?.domaine_hint || "",
                niveaua: byId("posteCompCreateNivA")?.value || _posteCompCreateCtx.draft?.niveaua || "",
                niveaub: byId("posteCompCreateNivB")?.value || _posteCompCreateCtx.draft?.niveaub || "",
                niveauc: byId("posteCompCreateNivC")?.value || _posteCompCreateCtx.draft?.niveauc || "",
                niveaud: byId("posteCompCreateNivD")?.value || _posteCompCreateCtx.draft?.niveaud || "",
                grille_evaluation: data.grille_evaluation || _posteCompCreateCtx.draft?.grille_evaluation || null,
                import_context: extractedText,
                import_filename: data.filename || _posteCompImportFile?.name || ""
            });
        }
    }

    async function runPosteCompImport(portal){
        if (!_posteCompImportFile){ portal.showAlert("error", "SÃ©lectionne un document avant dâ€™importer."); return; }
        const ownerId = getOwnerId();
        if (!ownerId) throw new Error("Owner manquant (?id=...).");
        const modal = ensurePosteCompImportModal();
        const btn = modal.querySelector("#btnPosteCompImportAnalyze");
        const msg = modal.querySelector("#posteCompImportMsg");
        if (btn){ btn.disabled = true; btn.style.opacity = ".6"; btn.textContent = "Analyseâ€¦"; }
        if (msg) msg.textContent = "Extraction et classement du texte en coursâ€¦";
        try{
            const token = await resolveStudioAccessToken();
            const headers = {};
            if (token) headers["Authorization"] = `Bearer ${token}`;
            const fd = new FormData();
            fd.append("file", _posteCompImportFile, _posteCompImportFile.name || "document");
            const resp = await fetch(
                appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/competence_import_document`),
                { method:"POST", headers, body:fd, credentials:"same-origin" }
            );
            if (!resp.ok){
                let detail = `Erreur import document (${resp.status})`;
                try{ const err = await resp.json(); if (err && err.detail) detail = String(err.detail); } catch(_){ }
                throw new Error(detail);
            }
            const data = await resp.json();
            applyPosteCompImportedDraft(data || {});
            if (msg) msg.textContent = "Document importÃ© et rÃ©parti dans la fiche compÃ©tence.";
            closePosteCompImportModal();
        } finally {
            if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.textContent = "Importer le texte"; }
        }
    }


    function openPosteCompAddModal(){
        if (!isAdmin()) return;
        if (!_editingPosteId) return;

        byId("posteCompAddSearch").value = "";
        _posteCompAddSearch = "";
        byId("posteCompAddList").innerHTML = "";
        ensurePosteCompAddCreateAction();
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

        // Filtre etat: active/valide (toujours) + Ã  valider si checkbox
        items = items.filter(it => {
        const et = (it.etat || "").toLowerCase();
        if (et === "active" || et === "valide") return true;
        if (_posteCompAddIncludeToValidate && et === "Ã  valider") return true;
        return false;
        });

        // Exclure dÃ©jÃ  rattachÃ©es (actives)
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
        e.textContent = "Aucune compÃ©tence Ã  afficher.";
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
        code.textContent = it.code || "â€”";

        const title = document.createElement("div");
        title.className = "sb-row-title";
        title.textContent = it.intitule || "";

        left.appendChild(code);
        left.appendChild(title);

        const right = document.createElement("div");
        right.className = "sb-row-right";

        if ((it.etat || "").toLowerCase() === "Ã  valider"){
            const v = document.createElement("span");
            v.className = "sb-badge sb-badge--accent-soft";
            v.textContent = "Ã€ valider";
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
            niveaud: "",

            // defaults association
            niveau_requis: "C",
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

        const b = byId("posteCompEditBadge");
        const code = (_posteCompEdit.code || "").toString().trim();
        if (b){
            b.textContent = code;
            b.style.display = code ? "" : "none";
        }
        byId("posteCompEditTitle").textContent = (_posteCompEdit.intitule || "CompÃ©tence").toString();

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

        byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "â€”");
        byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "â€”");
        byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "â€”");
        if (byId("posteCompRefD")) byId("posteCompRefD").textContent = (_posteCompEdit.niveaud || "â€”");

        setPosteCompEditNiv(_posteCompEdit.niveau_requis || "C");

        byId("posteCompEditFreq").value = String(_posteCompEdit.freq_usage ?? 0);
        byId("posteCompEditImpact").value = String(_posteCompEdit.impact_resultat ?? 0);
        byId("posteCompEditDep").value = String(_posteCompEdit.dependance ?? 0);

        refreshPosteCompEditCritDisplay();
        openModal("modalPosteCompEdit");

        if ((!_posteCompEdit.niveaua || !_posteCompEdit.niveaud) && _posteCompEdit.id_competence){
            (async () => {
                try{
                    const detail = await fetchCompetenceDetail(window.portal, _posteCompEdit.id_competence);
                    _posteCompEdit.niveaua = detail.niveaua || "";
                    _posteCompEdit.niveaub = detail.niveaub || "";
                    _posteCompEdit.niveauc = detail.niveauc || "";
                    _posteCompEdit.niveaud = detail.niveaud || "";
                    byId("posteCompRefA").textContent = (_posteCompEdit.niveaua || "â€”");
                    byId("posteCompRefB").textContent = (_posteCompEdit.niveaub || "â€”");
                    byId("posteCompRefC").textContent = (_posteCompEdit.niveauc || "â€”");
                    if (byId("posteCompRefD")) byId("posteCompRefD").textContent = (_posteCompEdit.niveaud || "â€”");
                } catch(_){ }
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

        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`);
        await portal.apiJson(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
            id_competence: _posteCompEdit.id_competence,
            niveau_requis: niv,
            freq_usage: fu,
            impact_resultat: im,
            dependance: de,
            valider_eval: true
        })
        });

        closeModal("modalPosteCompEdit");
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    async function removePosteCompetence(portal, id_comp){
        if (!_editingPosteId) return;
        const ownerId = getOwnerId();
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_competences/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_comp)}/remove`);
        await portal.apiJson(url, { method: "POST" });
        portal.showAlert("", "");
        await loadPosteCompetences(portal);
    }

    function formatValidityMonths(v){
        const n = parseInt(v ?? "", 10);
        if (!Number.isFinite(n) || n <= 0) return "â€”";
        return `${n} mois`;
    }

    function getPosteCertValidityLabel(it){
        const ov = parseInt(it?.validite_override ?? "", 10);
        if (Number.isFinite(ov) && ov > 0) return `${ov} mois`;
        const base = parseInt(it?.duree_validite ?? "", 10);
        if (Number.isFinite(base) && base > 0) return `${base} mois`;
        return "â€”";
    }

    function buildPosteCertBaseInfo(it){
        const parts = [];
        const base = formatValidityMonths(it?.duree_validite);
        const delai = formatValidityMonths(it?.delai_renouvellement);

        parts.push(`ValiditÃ© catalogue : ${base}`);
        if (delai !== "â€”") parts.push(`DÃ©lai de renouvellement : ${delai}`);

        return parts.join(" Â· ");
    }

    function buildPosteCertAddMeta(it){
        const parts = [];

        const cat = (it?.categorie || "").toString().trim();
        if (cat) parts.push(`CatÃ©gorie : ${cat}`);

        parts.push(`ValiditÃ© catalogue : ${formatValidityMonths(it?.duree_validite)}`);

        const delai = formatValidityMonths(it?.delai_renouvellement);
        if (delai !== "â€”") parts.push(`DÃ©lai de renouvellement : ${delai}`);

        return parts.join(" Â· ");
    }

    async function loadPosteCertifications(portal){
        if (!_editingPosteId) return;

        const ownerId = getOwnerId();
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`);
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
            tdCat.textContent = cat || "â€”";

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
                tdVal.title = `ValiditÃ© catalogue : ${formatValidityMonths(it.duree_validite)}`;
            }

            const tdLvl = document.createElement("td");
            tdLvl.style.textAlign = "center";
            const bl = document.createElement("span");
            bl.className = `sb-badge ${String(it.niveau_exigence || "").toLowerCase() === "souhaitÃ©" ? "sb-badge--poste-soft" : "sb-badge--accent-soft"}`;
            bl.textContent = it.niveau_exigence || "â€”";
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
                tdAct.textContent = "â€”";
            }

            tr.appendChild(tdNom);
            tr.appendChild(tdCat);
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
            const label = (it.categorie || "").toString().trim() || "Sans catÃ©gorie";
            if (!map.has(cat)) map.set(cat, label);
        });

        sel.innerHTML = "";
        sel.appendChild(new Option("Toutes", ""));
        sel.appendChild(new Option("Sans catÃ©gorie", "__none__"));

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
            e.textContent = "Aucune certification Ã  afficher.";
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
                portal.showAlert("error", "La validitÃ© catalogue doit Ãªtre un entier positif.");
                return;
            }
            duree_validite = parseInt(rawValidity, 10);
            if (!Number.isFinite(duree_validite) || duree_validite <= 0){
                portal.showAlert("error", "La validitÃ© catalogue doit Ãªtre supÃ©rieure Ã  0.");
                return;
            }
        }

        if (rawRenewal){
            if (!/^\d+$/.test(rawRenewal)) {
                portal.showAlert("error", "Le dÃ©lai de renouvellement doit Ãªtre un entier positif.");
                return;
            }
            delai_renouvellement = parseInt(rawRenewal, 10);
            if (!Number.isFinite(delai_renouvellement) || delai_renouvellement <= 0){
                portal.showAlert("error", "Le dÃ©lai de renouvellement doit Ãªtre supÃ©rieur Ã  0.");
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
        byId("posteCertEditSub").textContent = cat || "Sans catÃ©gorie";

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
                portal.showAlert("error", "La validitÃ© spÃ©cifique doit Ãªtre un entier positif.");
                return;
            }
            validiteOverride = parseInt(rawOverride, 10);
            if (!Number.isFinite(validiteOverride) || validiteOverride <= 0){
                portal.showAlert("error", "La validitÃ© spÃ©cifique doit Ãªtre supÃ©rieure Ã  0.");
                return;
            }
        }

        const niveau = (byId("posteCertEditLevel")?.value || "requis").trim();
        const commentaire = (byId("posteCertEditComment")?.value || "").trim() || null;

        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}`);
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
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_certifications/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingPosteId)}/${encodeURIComponent(id_certification)}/remove`);
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
        const url = appendOrgScope(`${portal.apiBase}/studio/org/poste_detail/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`);
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
            setBtnLabel(bA, isActif ? "Archiver" : "Restaurer");
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
            opt.textContent = `${"â€”".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
            sel.appendChild(opt);
        });

        sel.value = selectedId || "";
    }

    function setOrganisationHistoryState(){
        try {
            const current = history.state || {};
            history.replaceState({ ...current, novoskillView: "organisation", posteId: null }, "", window.location.href);
        } catch (_) {}
    }

    function pushPosteHistoryState(posteId){
        if (_posteHistoryActive) return;
        try {
            setOrganisationHistoryState();
            history.pushState({ novoskillView: "organisation", posteId: String(posteId || "") }, "", window.location.href);
            _posteHistoryActive = true;
        } catch (_) {}
    }

    function closePostePageFromNavigation(){
        if (!_posteHistoryActive && !byId("modalPoste")?.classList.contains("is-poste-page")) return;
        _posteHistoryActive = false;
        closePosteModal({ fromHistory: true });
        setOrganisationHistoryState();
    }

    function bindPosteHistoryOnce(){
        if (_posteHistoryBound) return;
        _posteHistoryBound = true;
        window.addEventListener("popstate", () => {
            if (_posteHistoryActive || byId("modalPoste")?.classList.contains("is-poste-page")) {
                _posteHistoryActive = false;
                closePosteModal({ fromHistory: true });
            }
        });
    }

    function setPostePageMode(enabled){
        const root = getOrganisationRoot();
        const modal = byId("modalPoste");
        const content = root ? root.closest(".content") : null;
        if (root) root.classList.toggle("is-poste-page", !!enabled);
        if (modal) modal.classList.toggle("is-poste-page", !!enabled);
        if (content) content.classList.toggle("is-poste-page", !!enabled);

        document.body.classList.toggle("studio-poste-page-open", !!enabled);
        if (enabled){
            const topbar = document.querySelector(".studio-topbar");
            const topbarHeight = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
            document.body.style.setProperty("--studio-poste-topbar-height", `${topbarHeight}px`);
        } else {
            document.body.style.removeProperty("--studio-poste-topbar-height");
        }

        const actions = byId("postePageActions");
        if (actions) actions.style.display = enabled ? "flex" : "none";
        const close = byId("btnClosePoste");
        if (close) close.style.display = enabled ? "none" : "";
        const reviewAi = byId("btnPosteReviewAi");
        if (reviewAi) reviewAi.style.display = enabled ? "inline-flex" : "none";
    }

    function textFromHtml(html){
        const box = document.createElement("div");
        box.innerHTML = html || "";
        return (box.textContent || "").replace(/\s+/g, " ").trim();
    }

    function extractMainActivities(html){
        const box = document.createElement("div");
        box.innerHTML = html || "";
        const ordered = Array.from(box.querySelectorAll("ol > li")).map(li => {
            const clone = li.cloneNode(true);
            clone.querySelectorAll("ul,ol").forEach(x => x.remove());
            return (clone.textContent || "").replace(/\s+/g, " ").trim();
        }).filter(Boolean);
        if (ordered.length) return ordered.slice(0, 8);
        return textFromHtml(html).split(/(?:\n|\r|â€¢)/).map(x => x.trim()).filter(Boolean).slice(0, 8);
    }

    function overviewStatusClass(value){
        const raw = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        if (raw.includes("actif")) return "is-success";
        if (raw.includes("temp")) return "is-warning";
        if (raw.includes("gele") || raw.includes("inactif")) return "is-neutral";
        if (raw.includes("archive")) return "is-dark";
        return "is-neutral";
    }

    function constraintLevelClass(value){
        const raw = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        if (!raw || raw === "â€”" || raw.includes("aucun")) return "is-low";
        if (raw.includes("faible") || raw.includes("locale")) return "is-low";
        if (raw.includes("modere") || raw.includes("moyen") || raw.includes("frequent")) return "is-medium";
        if (raw.includes("eleve") || raw.includes("fort") || raw.includes("critique")) return "is-high";
        return "is-neutral";
    }

    function setOverviewDl(id, rows, options){
        const host = byId(id);
        if (!host) return;
        const opts = options || {};
        host.innerHTML = "";
        (rows || []).forEach(([label, value]) => {
            const dt = document.createElement("dt"); dt.textContent = label;
            const dd = document.createElement("dd");
            const shown = value || "â€”";
            if (opts.statusLabel === label){
                const badge = document.createElement("span");
                badge.className = `studio-poste-status-badge ${overviewStatusClass(shown)}`;
                badge.textContent = shown;
                dd.appendChild(badge);
            } else if (opts.constraintBadges){
                const badge = document.createElement("span");
                badge.className = `studio-poste-constraint-badge ${constraintLevelClass(shown)}`;
                const dot = document.createElement("span"); dot.className = "studio-poste-constraint-badge__dot";
                const text = document.createElement("span"); text.textContent = shown;
                badge.append(dot, text);
                dd.appendChild(badge);
            } else {
                dd.textContent = shown;
            }
            host.append(dt, dd);
        });
    }

    function initialsForCollaborator(item){
        const first = String(item?.prenom || "").trim().charAt(0);
        const last = String(item?.nom || "").trim().charAt(0);
        return `${first}${last}`.toUpperCase() || "?";
    }

    function renderPosteCollaborators(items){
        const host = byId("posteOverviewCollaborators");
        if (!host) return;
        host.innerHTML = "";
        const rows = (items || []).filter(x => !x?.archive);
        if (!rows.length){
            const empty = document.createElement("div");
            empty.className = "studio-poste-collaborators__empty";
            empty.textContent = "Aucun collaborateur affectÃ© Ã  ce poste.";
            host.appendChild(empty);
            return;
        }
        rows.forEach(item => {
            const row = document.createElement("div");
            row.className = "studio-poste-collaborator-row";
            const avatar = document.createElement("span");
            avatar.className = "studio-poste-collaborator-avatar";
            avatar.textContent = initialsForCollaborator(item);
            const name = document.createElement("span");
            name.className = "studio-poste-collaborator-name";
            name.textContent = `${String(item?.prenom || "").trim()} ${String(item?.nom || "").trim()}`.trim() || "Collaborateur";
            const status = document.createElement("span");
            status.className = `studio-poste-collaborator-status ${item?.actif === false ? "is-unavailable" : "is-active"}`;
            const dot = document.createElement("span"); dot.className = "studio-poste-collaborator-status__dot";
            const text = document.createElement("span"); text.textContent = item?.actif === false ? "Indisponible" : "Actif";
            status.append(dot, text);
            row.append(avatar, name, status);
            host.appendChild(row);
        });
    }

    async function loadPosteCollaborators(portal){
        if (!_editingPosteId) return;
        const host = byId("posteOverviewCollaborators");
        if (host) host.innerHTML = '<div class="studio-poste-collaborators__empty">Chargementâ€¦</div>';
        try {
            const ownerId = getOwnerId();
            const qs = new URLSearchParams({ poste: _editingPosteId, active: "all", include_archived: "0" });
            const url = appendOrgScope(`${portal.apiBase}/studio/collaborateurs/list/${encodeURIComponent(ownerId)}?${qs.toString()}`);
            const data = await portal.apiJson(url);
            renderPosteCollaborators(data?.items || []);
        } catch (e) {
            if (host) host.innerHTML = '<div class="studio-poste-collaborators__empty">Impossible de charger les collaborateurs.</div>';
            console.error("Chargement collaborateurs du poste", e);
        }
    }

    function renderPosteOverview(detail){
        const d = detail || {};
        const collabs = _editingPosteListItem?.nb_collabs ?? _editingPosteListItem?.nb_collaborateurs ?? "â€”";
        const target = d.nb_titulaires_cible ?? "â€”";
        const criticalCompetences = (_posteCompItems || []).filter(it => {
            const score = Number.parseInt(it?.poids_criticite ?? "", 10);
            return Number.isFinite(score) && score > 79;
        }).length;

        _setValue("posteOverviewCollabs", String(collabs));
        _setValue("posteOverviewCollabsMeta", target === "â€”" ? "Titularisation du poste" : `${collabs} sur ${target} titulaire${Number(target) > 1 ? "s" : ""} cible${Number(target) > 1 ? "s" : ""}`);
        _setValue("posteOverviewCompetences", String((_posteCompItems || []).length));
        _setValue("posteOverviewCompetencesMeta", `${criticalCompetences} critique${criticalCompetences > 1 ? "s" : ""} (> 79 %)`);
        _setValue("posteOverviewCertifications", String((_posteCertItems || []).length));
        _setValue("posteOverviewCertificationsMeta", (_posteCertItems || []).length ? "Exigences du poste" : "Aucune certification requise");
        const crit = d.criticite_poste ?? "";
        const critLabel = ({1:"Faible",2:"ModÃ©rÃ©e",3:"Ã‰levÃ©e",4:"Critique"})[String(crit)] || String(crit || "â€”");
        _setValue("posteOverviewCriticite", critLabel);
        _setValue("posteOverviewCriticiteMeta", critLabel === "â€”" ? "Non renseignÃ©e" : "Impact sur lâ€™activitÃ©");
        _setValue("posteOverviewMission", d.mission_principale || "â€”");
        _setValue("posteOverviewComment", d.param_rh_commentaire || "â€”");

        const activities = byId("posteOverviewActivities");
        if (activities){
            activities.innerHTML = "";
            const items = extractMainActivities(d.responsabilites || "");
            (items.length ? items : ["Aucune activitÃ© principale renseignÃ©e."]).forEach(x => {
                const li = document.createElement("li"); li.textContent = x; activities.appendChild(li);
            });
        }

        const compHost = byId("posteOverviewCompList");
        if (compHost){
            compHost.innerHTML = "";
            (_posteCompItems || []).slice(0, 6).forEach(it => {
                const row = document.createElement("div");
                const levelKey = nsLevelKey(it.niveau_requis || it.niveau || "").toLowerCase();
                const code = String(it.code_competence || it.code || "").trim();
                row.innerHTML = `<span class="studio-poste-overview-skill"><span class="sb-badge sb-badge--comp"${code ? "" : " style=\"display:none;\""}>${htmlEsc(code)}</span><span>${htmlEsc(it.intitule_competence || it.intitule || it.code_competence || "CompÃ©tence")}</span></span><strong class="studio-poste-overview-badge studio-poste-overview-badge--${htmlEsc(levelKey || "default")}">${htmlEsc(nsLevelLabel(it.niveau_requis || it.niveau || ""))}</strong>`;
                compHost.appendChild(row);
            });
            if (!compHost.children.length) compHost.textContent = "Aucune compÃ©tence rattachÃ©e.";
        }

        const certHost = byId("posteOverviewCertList");
        if (certHost){
            certHost.innerHTML = "";
            (_posteCertItems || []).slice(0, 4).forEach(it => {
                const row = document.createElement("div");
                const certStatus = it.obligatoire ? "Obligatoire" : "RecommandÃ©e";
                row.innerHTML = `<span>${htmlEsc(it.intitule_certification || it.nom_certification || it.intitule || "Certification")}</span><strong class="studio-poste-overview-badge studio-poste-overview-badge--cert">${htmlEsc(certStatus)}</strong>`;
                certHost.appendChild(row);
            });
            if (!certHost.children.length) certHost.textContent = "Aucune certification rattachÃ©e.";
        }

        setOverviewDl("posteOverviewInfo", [
            ["Service", d.nom_service || _editingPosteListItem?.nom_service],
            ["Code client", d.codif_client],
            ["Statut du poste", d.statut_poste],
            ["StratÃ©gie de pourvoi", d.strategie_pourvoi],
            ["Nb titulaires cible", String(d.nb_titulaires_cible ?? "â€”")],
            ["DÃ©but de validitÃ©", d.date_debut_validite],
            ["Fin de validitÃ©", d.date_fin_validite]
        ], { statusLabel: "Statut du poste" });
        setOverviewDl("posteOverviewConstraints", [
            ["MobilitÃ©", d.mobilite],
            ["Risques physiques", d.risque_physique],
            ["Perspectives dâ€™Ã©volution", d.perspectives_evolution],
            ["Niveau de contraintes", d.niveau_contrainte]
        ], { constraintBadges: true });
    }

    function openCreatePosteModal(portal){
        if (!hasStudioOrgServices()){
            openCreateService("poste_create");
            return;
        }

        _posteModalMode = "create";
        _editingPosteId = null;
        _editingPosteListItem = null;
        _posteHistoryActive = false;
        setPostePageMode(false);
        resetPosteSaveInlineMsg();

        refreshPosteImportButton();
        resetPosteImportState();

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", "");

        byId("posteModalTitle").textContent = "Ajouter un poste";
        byId("posteModalSub").textContent = "CrÃ©ez une fiche de poste et rattachez-la au service voulu.";

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
        if (bS) setBtnLabel(bS, "CrÃ©er");

        fillPosteContraintesTab({});
        resetPosteCcnUi(true);
        fillPosteRhTab({}, true);

        _posteCompItems = [];
        _posteCompSearch = "";
        _posteCompExpanded = false;
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
        _editingPosteListItem = p || null;
        setPostePageMode(true);
        resetPosteSaveInlineMsg();
        const pid = (p && p.id_poste) ? String(p.id_poste).trim() : "";

        refreshPosteImportButton();
        resetPosteImportState();
        closePosteImportModal();

        if (!pid) return;

        _posteModalMode = "edit";
        _editingPosteId = pid;
        bindPosteHistoryOnce();
        pushPosteHistoryState(pid);

        const modal = byId("modalPoste");
        if (modal) modal.setAttribute("data-id-poste", _editingPosteId || "");

        byId("posteModalTitle").textContent =
            (p && (p.intitule_poste || p.intitule)) ? String(p.intitule_poste || p.intitule) : "Poste";
        byId("posteModalSub").textContent = "";

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

        // On prÃ©-remplit ce qu'on a dÃ©jÃ  (le dÃ©tail complet arrive Ã  l'Ã©tape 2)
        byId("posteIntitule").value = (p && p.intitule) ? String(p.intitule) : "";

        refreshPosteFooterActions();
        setPosteModalActif((p && p.actif !== false));

        const bS = byId("btnPosteSave");
        if (bS) setBtnLabel(bS, "Enregistrer");
        fillPosteRhTab({}, false);
        resetPosteCcnUi(false);

        _posteCompItems = [];
        _posteCompExpanded = false;
        renderPosteCompetences();

        _posteCertItems = [];
        renderPosteCertifications();

        setPosteTab("overview");
        openModal("modalPoste");

        // Charge le dÃ©tail (dÃ©finition + exigences/contraintes)
        (async () => {
        try{
            let d = await fetchPosteDetail(portal, _editingPosteId);
            if (!d) return;
            d = repairAiDraftPayload(d || {});

            await ensureNsfGroupes(portal);
            fillNsfSelect(d?.nsf_groupe_code || "");
            fillPosteContraintesTab(d);
            fillPosteRhTab(d, false);
            await loadPosteCcnContext(portal);
            await loadPosteCompetences(portal);
            await loadPosteCertifications(portal);
            await loadPosteCollaborators(portal);
            renderPosteOverview(d);

            // --- DÃ©finition (remplissage robuste: si champ supprimÃ©, pas d'erreur)
            const elCodCli = byId("posteCodifClient"); if (elCodCli) elCodCli.value = (d.codif_client || "");
            const elInt = byId("posteIntitule"); if (elInt) elInt.value = (d.intitule_poste || "");
            const elMis = byId("posteMission"); if (elMis) elMis.value = (d.mission_principale || "");

            // ResponsabilitÃ©s: richtext si prÃ©sent, sinon textarea
            if (typeof rtSetHtml === "function") rtSetHtml("posteResp", d.responsabilites || "");
            else { const elResp = byId("posteResp"); if (elResp) elResp.value = (d.responsabilites || ""); }
            seedPosteAiModalFromCurrent();

            // --- Exigences > Contraintes (les fonctions seront ajoutÃ©es/existent dÃ©jÃ  chez toi)
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

    function closePosteModal(options){
        const opts = options || {};
        abortPosteCompAiSearch();
        closeIaBusyOverlay();
        closeModal("modalPosteCompCreateFrame");
        closeModal("modalPosteCompCreate");
        closeModal("modalPosteImport");
        closeModal("modalPoste");
        resetPosteSaveInlineMsg();
        resetPosteImportState();
        setPostePageMode(false);
        if (_posteHistoryActive && !opts.fromHistory){
            _posteHistoryActive = false;
            try { history.back(); } catch (_) { setOrganisationHistoryState(); }
        }
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
        const resp = rtGetPosteRespHtml();

        if (!sid){
            showOrgPopup("Service obligatoire", "SÃ©lectionnez ou crÃ©ez un service pour rattacher cette fiche de poste. Le bouton + Ã  cÃ´tÃ© du champ Service permet de le crÃ©er sans quitter le poste.");
            return null;
        }
        if (!title){
            showPosteSaveInlineMsg("IntitulÃ© obligatoire.", true);
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
            param_rh_verrouille: false,
            param_rh_commentaire: (byId("posteRhCommentaire")?.value || "").trim() || null,
        };

        const rawNbTit = (byId("posteRhNbTitulaires")?.value || "").trim();
        const nbTit = parseInt(rawNbTit || "1", 10);
        if (!Number.isFinite(nbTit) || nbTit < 1){
            showPosteSaveInlineMsg("Le nombre de titulaires cible doit Ãªtre supÃ©rieur ou Ã©gal Ã  1.", true);
            return null;
        }
        payload.nb_titulaires_cible = nbTit;

        const rawCrit = (byId("posteRhCriticite")?.value || "").trim();
        const crit = parseInt(rawCrit || "2", 10);
        if (!Number.isFinite(crit) || crit < 1 || crit > 3){
            showPosteSaveInlineMsg("La criticitÃ© du poste doit Ãªtre comprise entre 1 et 3.", true);
            return null;
        }
        payload.criticite_poste = crit;

        if (payload.date_debut_validite && payload.date_fin_validite && payload.date_fin_validite < payload.date_debut_validite){
            showPosteSaveInlineMsg("La date de fin de validitÃ© doit Ãªtre postÃ©rieure ou Ã©gale Ã  la date de dÃ©but.", true);
            return null;
        }

        if (_posteModalMode === "create"){
            const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}`);
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
                byId("posteModalSub").textContent = "";
                const badge = byId("posteModalBadge");
                if (badge){
                    badge.textContent = code || "";
                    badge.style.display = code ? "" : "none";
                }
                refreshPosteFooterActions();
                const bS = byId("btnPosteSave");
                if (bS) setBtnLabel(bS, "Enregistrer");
                setPosteModalActif(true);
                seedPosteAiModalFromCurrent();
                await refreshPosteCcnContextAfterSave(portal);
                if (!silent) setStatus(opts.statusMessage || "Poste crÃ©Ã©.");
                return r;
            }

            if (!silent) setStatus(opts.statusMessage || "Poste crÃ©Ã©.");
            closePosteModal();
            return r;

        } else {
            const pid = (_editingPosteId || "").trim();
            if (!pid) throw new Error("id_poste manquant (edit).");

            const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}`);
            const r = await portal.apiJson(url, {
                method: "POST",
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify(payload),
            });

            _posteDetailCache.delete(pid);

            await loadServices(portal);
            await loadPostes(portal);

            if (!keepOpen){
                if (!silent) setStatus(opts.statusMessage || "Poste enregistrÃ©.");
                closePosteModal();
            } else {
                await refreshPosteCcnContextAfterSave(portal);
                if (!silent) setStatus(opts.statusMessage || "Poste enregistrÃ©.");
            }
            return r || { ok: true };
        }
    }

    async function toggleArchivePosteFromList(portal, poste){
        const ownerId = getOwnerId();
        const pid = (poste && poste.id_poste) ? String(poste.id_poste).trim() : "";
        if (!pid) return;

        const isActif = !(poste && poste.actif === false);
        const wantArchive = isActif; // actif => archive ; archivÃ© => restaure

        const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`);
        await portal.apiJson(url, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ archive: wantArchive }),
        });

        _posteDetailCache.delete(pid);

        await loadServices(portal);
        await loadPostes(portal);

        setStatus(wantArchive ? "Poste archivÃ©." : "Poste restaurÃ©.");
    }

    async function toggleArchivePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const isActif = getPosteModalActif();
        const wantArchive = isActif; // si actif => on archive ; si archivÃ© => on restaure

        const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/archive`);
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

        setStatus(wantArchive ? "Poste archivÃ©." : "Poste restaurÃ©.");
    }

    async function duplicatePosteFromModal(portal){
        const ownerId = getOwnerId();
        const pid = (_editingPosteId || "").trim();
        if (!pid) return;

        const sid = (byId("posteService")?.value || "").trim();
        if (!sid){
            showOrgPopup("Service obligatoire", "SÃ©lectionnez ou crÃ©ez un service cible avant de dupliquer cette fiche de poste.");
            return;
        }

        const url = appendOrgScope(`${portal.apiBase}/studio/org/postes/${encodeURIComponent(ownerId)}/${encodeURIComponent(pid)}/duplicate`);
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
            setStatus("Poste dupliquÃ©.");
        } else {
            setStatus("Poste dupliquÃ©.");
        }
    }

    // -------- Services CRUD
    function openCreateService(returnTarget){
        _serviceModalMode = "create";
        _editingServiceId = null;
        _serviceModalReturnTarget = returnTarget || null;

        byId("svcModalTitle").textContent = "CrÃ©er un service";
        byId("svcModalSub").textContent = (_serviceModalReturnTarget === "poste_create")
            ? "CrÃ©ez dâ€™abord un service pour rattacher la fiche de poste."
            : (_serviceModalReturnTarget === "poste_select")
                ? "CrÃ©ez le service Ã  rattacher Ã  cette fiche de poste."
                : "DÃ©finissez le nom et, si besoin, le parent.";
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
        opt.textContent = `${"â€”".repeat(Math.min(6, s.depth))} ${s.nom_service}`;
        sel.appendChild(opt);
        });

        sel.value = selectedId || "";
    }

    async function saveService(portal){
        const ownerId = getOwnerId();
        const name = (byId("svcName").value || "").trim();
        const parent = (byId("svcParent").value || "").trim() || null;
        const returnTarget = _serviceModalReturnTarget;

        if (!name) {
            showOrgPopup("Service obligatoire", "Renseignez le nom du service avant dâ€™enregistrer.");
            return;
        }

        let createdServiceId = null;

        if (_serviceModalMode === "create") {
            const r = await portal.apiJson(
                appendOrgScope(`${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}`),
                { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
            );
            createdServiceId = r && r.id_service ? String(r.id_service) : null;
        } else {
            if (!_editingServiceId) return;
            await portal.apiJson(
                appendOrgScope(`${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(_editingServiceId)}`),
                { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ nom_service: name, id_service_parent: parent }) }
            );
        }

        _serviceModalReturnTarget = null;
        closeModal("modalService");
        await loadServices(portal);

        if (!createdServiceId && returnTarget){
            const created = (_services || []).find(s => String(s.nom_service || "").trim().toLowerCase() === name.toLowerCase());
            createdServiceId = created && created.id_service ? String(created.id_service) : null;
        }

        if (createdServiceId){
            _selectedService = createdServiceId;
            syncSelectedServiceContext();
            renderServices();
            updateAddButtonState();
            loadPostes(portal).catch(() => {});
        }

        if (returnTarget === "poste_create"){
            openCreatePosteModal(portal);
            if (createdServiceId) fillPosteServiceSelect(createdServiceId);
            showPosteSaveInlineMsg("Service crÃ©Ã© et sÃ©lectionnÃ©");
        } else if (returnTarget === "poste_select"){
            if (createdServiceId) fillPosteServiceSelect(createdServiceId);
            showPosteSaveInlineMsg("Service crÃ©Ã© et sÃ©lectionnÃ©");
        }
    }

    function openArchiveService(){
        if (!_selectedService || _selectedService === "__all__" || _selectedService === "__none__") return;

        const s = (_services || []).find(x => x.id_service === _selectedService);
        if (!s) return;

        byId("archiveMsg").textContent = `Archiver "${s.nom_service}" ? Les postes et collaborateurs seront dÃ©tachÃ©s (Non liÃ©).`;
        openModal("modalArchive");
    }

    async function confirmArchiveService(portal){
        const ownerId = getOwnerId();
        const sid = _selectedService;
        if (!sid || sid === "__all__" || sid === "__none__") return;

        await portal.apiJson(
        appendOrgScope(`${portal.apiBase}/studio/org/services/${encodeURIComponent(ownerId)}/${encodeURIComponent(sid)}/archive`),
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
        const url = appendOrgScope(`${portal.apiBase}/studio/org/postes_catalogue/${encodeURIComponent(ownerId)}?q=${encodeURIComponent(_catalogSearch)}`);
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
        code.textContent = it.code || "â€”";

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
        appendOrgScope(`${portal.apiBase}/studio/org/postes/assign/${encodeURIComponent(ownerId)}`),
        { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id_poste: idPoste, id_service: sid }) }
        );

        closeModal("modalCatalog");
        portal.showAlert("", "");

        await loadServices(portal);
        await loadPostes(portal);

        // mettre Ã  jour meta header service sÃ©lectionnÃ©
        const row = document.querySelector(`.org-svc-item[data-sid="${CSS.escape(sid)}"] .org-svc-meta`);
        if (row) {
        // on laisse la liste reflÃ©ter les compteurs rechargÃ©s
        }
    }

    // -------- Bind
    function bindOnce(portal){
        if (_bound) return;
        _bound = true;

        // admin-only (page est admin-only, mais on blinde lâ€™UX)
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

        const pcm = byId("posteCompMore");
        if (pcm){
          pcm.addEventListener("click", () => {
            _posteCompExpanded = !_posteCompExpanded;
            renderPosteCompetences();
          });
        }

        const pcs = byId("posteCompSearch");
        if (pcs){
          pcs.addEventListener("input", () => {
            _posteCompSearch = (pcs.value || "").trim();
            _posteCompExpanded = false;
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

        byId("btnCloseService").addEventListener("click", () => closeServiceModal());
        byId("btnCancelService").addEventListener("click", () => closeServiceModal());
        byId("btnSaveService").addEventListener("click", async () => {
        try { await saveService(portal); }
        catch (e) { showOrgPopup("CrÃ©ation du service", e?.message || String(e)); }
        });

        byId("btnCloseArchive").addEventListener("click", () => closeModal("modalArchive"));
        byId("btnCancelArchive").addEventListener("click", () => closeModal("modalArchive"));
        byId("btnConfirmArchive").addEventListener("click", async () => {
        try { await confirmArchiveService(portal); }
        catch (e) { portal.showAlert("error", e?.message || String(e)); }
        });

        // Catalogue modal
        byId("btnAddFromCatalog").addEventListener("click", () => {
            try {
                if (!hasStudioOrgServices()){
                    openCreateService("poste_create");
                    return;
                }
                openCreatePosteModal(portal);
            }
            catch (e) { showOrgPopup("CrÃ©ation du poste", e?.message || String(e)); }
        });

        byId("btnPosteServiceAdd")?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            try { openCreateService("poste_select"); }
            catch (err) { showOrgPopup("CrÃ©ation du service", err?.message || String(err)); }
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
                if (e.key === "Escape" && isIaBusyVisible()){
                    e.preventDefault();
                    abortPosteCompAiSearch("escape");
                    return;
                }
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteModal();
            });
        }

        byId("btnPostePageSave")?.addEventListener("click", () => byId("btnPosteSave")?.click());
        byId("btnPosteReviewAi")?.addEventListener("click", () => byId("btnPosteAi")?.click());
        byId("btnPostePageArchive")?.addEventListener("click", () => { byId("postePageActionsDropdown").style.display = "none"; byId("btnPosteArchive")?.click(); });
        byId("btnPostePageDuplicate")?.addEventListener("click", () => { byId("postePageActionsDropdown").style.display = "none"; byId("btnPosteDuplicate")?.click(); });
        byId("btnPostePagePdf")?.addEventListener("click", async () => {
            byId("postePageActionsDropdown").style.display = "none";
            try { await openPosteFichePdf(portal, _editingPosteId); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPostePageActions")?.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            const menu = byId("postePageActionsDropdown");
            if (!menu) return;
            const open = menu.style.display !== "none";
            menu.style.display = open ? "none" : "block";
            e.currentTarget.setAttribute("aria-expanded", open ? "false" : "true");
        });
        getOrganisationRoot()?.addEventListener("click", (e) => {
            const go = e.target.closest("[data-go-tab]");
            if (go){
                e.preventDefault();
                setPosteTab(go.getAttribute("data-go-tab"));
                const focusTarget = go.getAttribute("data-focus-target");
                if (focusTarget){
                    window.setTimeout(() => {
                        const target = byId(focusTarget);
                        target?.scrollIntoView({ behavior: "smooth", block: "center" });
                        target?.focus?.();
                    }, 80);
                }
            }
            if (!e.target.closest(".studio-poste-actions-menu")){
                const menu = byId("postePageActionsDropdown"); if (menu) menu.style.display = "none";
            }
        });

        const organisationMenuItem = document.querySelector('.menu-item[data-view="organisation"]');
        if (organisationMenuItem && !organisationMenuItem.dataset.postePageResetBound){
            organisationMenuItem.dataset.postePageResetBound = "1";
            organisationMenuItem.addEventListener("click", () => closePostePageFromNavigation());
        }

        byId("btnPosteSave")?.addEventListener("click", async () => {
            try {
                resetPosteSaveInlineMsg();

                const saved = await savePosteFromModal(portal, {
                    keepOpen: true,
                    silent: true
                });

                if (saved){
                    showPosteSaveInlineMsg("EnregistrÃ© avec succÃ¨s");
                }
            }
            catch(e){
                resetPosteSaveInlineMsg();
                showPosteSaveInlineMsg(e?.message || String(e), true);
            }
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

        _orgCcnController?.bindOnce(portal);

        byId("btnPosteCompAi")?.addEventListener("click", async () => {
            try { await openPosteCompAiModal(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });
        byId("btnPosteCompAiX")?.addEventListener("click", () => closePosteCompAiModal());
        byId("btnPosteCompAiClose")?.addEventListener("click", () => closePosteCompAiModal());

        const mcai = byId("modalPosteCompAi");
        if (mcai && !mcai._sbBound){
            mcai._sbBound = true;

            mcai.addEventListener("click", (e) => {
                if (e.target === mcai) closePosteCompAiModal();
            });

            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteCompAi");
                if (e.key === "Escape" && el && el.style.display === "flex"){
                    const frameEl = byId("modalPosteCompCreateFrame");
                    if (frameEl && frameEl.style.display === "flex") return;
                    const createEl = byId("modalPosteCompCreate");
                    if (createEl && createEl.style.display === "flex") return;
                    closePosteCompAiModal();
                }
            });
        }

        byId("btnPosteCompCreateFrameX")?.addEventListener("click", () => closePosteCompCreateFrameModal());
        byId("btnPosteCompCreateFrameCancel")?.addEventListener("click", () => closePosteCompCreateFrameModal());
        byId("btnPosteCompCreateFrameGenerate")?.addEventListener("click", async () => {
            try { await preparePosteCompCreateModalFromFrame(portal); }
            catch(e){ portal.showAlert("error", e?.message || String(e)); }
        });

        const mcframe = byId("modalPosteCompCreateFrame");
        if (mcframe && !mcframe._sbBound){
            mcframe._sbBound = true;
            mcframe.addEventListener("click", (e) => {
                if (e.target === mcframe) closePosteCompCreateFrameModal();
            });
            document.addEventListener("keydown", (e) => {
                const el = byId("modalPosteCompCreateFrame");
                if (e.key === "Escape" && el && el.style.display === "flex") closePosteCompCreateFrameModal();
            });
        }

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
        bindPosteCompCreateMaxLen("posteCompCreateNivD", 230);
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
        await ensureStudioOrganisationCcnController(portal);

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
