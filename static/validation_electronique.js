/* ======================================================
   static/validation_electronique.js
   Composant commun : validation électronique Novoskill
   ====================================================== */
(function () {
  "use strict";

  const state = {
    loaded: false,
    bound: false,
    options: null,
    mode: "signature_tracee",
    hasInk: false,
    drawing: false,
    canvasReady: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function veEsc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setMsg(type, text) {
    const el = $("ve_msg");
    if (!el) return;

    el.className = "sb-inline-msg";
    el.textContent = "";

    if (!text) return;

    el.textContent = text;
    el.classList.add("is-visible", `sb-inline-msg--${type || "info"}`);
  }

  function showModal() {
    const modal = $("modalValidationElectronique");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const modal = $("modalValidationElectronique");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  async function ensureLoaded() {
    if (state.loaded && $("modalValidationElectronique")) return;

    const res = await fetch("/validation_electronique.html", { cache: "no-store" });
    if (!res.ok) throw new Error("Composant de validation électronique indisponible.");

    const html = await res.text();
    const host = document.createElement("div");
    host.innerHTML = html;
    while (host.firstElementChild) {
      document.body.appendChild(host.firstElementChild);
    }

    state.loaded = true;
    bindEvents();
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;

    $("btnCloseValidationElectroniqueX")?.addEventListener("click", closeModal);

    $("modalValidationElectronique")?.addEventListener("click", (ev) => {
      if (ev.target === $("modalValidationElectronique")) closeModal();
    });

    document.querySelectorAll("#modalValidationElectronique .ve-toggle-btn").forEach(btn => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode || "signature_tracee"));
    });

    $("ve_btnClearCanvas")?.addEventListener("click", () => {
      clearCanvas();
      updateConfirmState();
    });

    $("ve_confirmSlider")?.addEventListener("input", updateConfirmState);
    $("ve_btnLater")?.addEventListener("click", signLater);
    $("ve_btnConfirm")?.addEventListener("click", confirmSignature);

    initCanvasEvents();
  }

  function setMode(mode) {
    state.mode = mode === "signature_generee" ? "signature_generee" : "signature_tracee";

    document.querySelectorAll("#modalValidationElectronique .ve-toggle-btn").forEach(btn => {
      btn.classList.toggle("is-active", (btn.dataset.mode || "") === state.mode);
    });

    $("ve_panelTracee")?.classList.toggle("is-active", state.mode === "signature_tracee");
    $("ve_panelGeneree")?.classList.toggle("is-active", state.mode === "signature_generee");

    const slider = $("ve_confirmSlider");
    if (slider) slider.value = "0";

    setMsg("info", "");
    updateConfirmState();

    if (state.mode === "signature_tracee") {
      setTimeout(resizeCanvas, 40);
    }
  }

  function signatureName() {
    const opt = state.options || {};
    return (opt.signataireName || "").toString().trim() || "Signataire";
  }

  function initCanvasEvents() {
    const canvas = $("ve_signatureCanvas");
    if (!canvas || canvas.dataset.bound === "1") return;

    canvas.dataset.bound = "1";

    const pos = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
      };
    };

    const start = (ev) => {
      if (state.mode !== "signature_tracee") return;
      ev.preventDefault();
      state.drawing = true;
      const ctx = canvas.getContext("2d");
      const p = pos(ev);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };

    const move = (ev) => {
      if (!state.drawing || state.mode !== "signature_tracee") return;
      ev.preventDefault();
      const ctx = canvas.getContext("2d");
      const p = pos(ev);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      state.hasInk = true;
      updateConfirmState();
    };

    const end = () => {
      state.drawing = false;
    };

    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointerleave", end);
    window.addEventListener("resize", () => {
      if ($("modalValidationElectronique")?.classList.contains("show")) resizeCanvas();
    });
  }

  function resizeCanvas() {
    const canvas = $("ve_signatureCanvas");
    if (!canvas) return;

    const previous = state.hasInk ? canvas.toDataURL("image/png") : null;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";

    if (previous) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = previous;
    }

    state.canvasReady = true;
  }

  function clearCanvas() {
    const canvas = $("ve_signatureCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.hasInk = false;
  }

  function updateConfirmState() {
    const btn = $("ve_btnConfirm");
    const slider = $("ve_confirmSlider");
    if (!btn || !slider) return;

    const sliderOk = Number(slider.value || 0) >= 100;
    const signOk = state.mode === "signature_generee" ? !!signatureName() : !!state.hasInk;
    btn.disabled = !(sliderOk && signOk);
  }

  function generatedSignatureDataUrl() {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 220;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = '72px "Segoe Script", "Brush Script MT", cursive';
    ctx.fillText(signatureName(), canvas.width / 2, canvas.height / 2);

    return canvas.toDataURL("image/png");
  }

  function tracedSignatureDataUrl() {
    const canvas = $("ve_signatureCanvas");
    if (!canvas || !state.hasInk) return "";
    return canvas.toDataURL("image/png");
  }

  async function signLater() {
    const opt = state.options || {};

    try {
      setMsg("info", "Enregistrement…");

      if (typeof opt.saveDocument === "function") {
        await opt.saveDocument("à signer 2/2");
      }

      closeModal();
      if (typeof opt.onLater === "function") await opt.onLater();
    } catch (e) {
      setMsg("danger", String(e?.message || e || "Erreur lors de l'enregistrement."));
    }
  }

  async function confirmSignature() {
    const opt = state.options || {};
    const apiBase = (opt.apiBase || "").toString().replace(/\/$/, "");
    const contactId = (opt.contactId || "").toString().trim();

    if (!apiBase || !contactId) {
      setMsg("danger", "Contexte de validation incomplet.");
      return;
    }

    try {
      setMsg("info", "Enregistrement de la validation…");

      let documentId = (opt.documentId || "").toString().trim();
      if (typeof opt.saveDocument === "function") {
        const saved = await opt.saveDocument("à signer 2/2");
        documentId = (saved?.id_entretien || saved?.id_document_ref || documentId || "").toString().trim();
      }

      if (!documentId) {
        throw new Error("Document introuvable après enregistrement.");
      }

      const signatureImage = state.mode === "signature_generee"
        ? generatedSignatureDataUrl()
        : tracedSignatureDataUrl();

      if (!signatureImage) {
        throw new Error("Signature manquante.");
      }

      const payload = {
        type_document: opt.typeDocument || "entretien_individuel",
        id_document_ref: documentId,
        type_signataire: opt.typeSignataire || "evaluateur",
        mode_validation: state.mode,
        signature_image: signatureImage,
        payload_validation: opt.payloadValidation || {},
      };

      const validationUrl = `${apiBase}/skills/validations-electroniques/${encodeURIComponent(contactId)}`;

      const validation = typeof opt.apiJson === "function"
        ? await opt.apiJson(validationUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await (async () => {
            const res = await fetch(validationUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(typeof opt.getAuthHeaders === "function" ? opt.getAuthHeaders() : {}),
              },
              body: JSON.stringify(payload),
            });

            if (!res.ok) {
              let msg = "Erreur lors de la validation électronique.";
              try {
                const data = await res.json();
                msg = data?.detail || msg;
              } catch (_) {}
              throw new Error(msg);
            }

            return await res.json();
          })();
      closeModal();
      if (typeof opt.onSigned === "function") await opt.onSigned(validation);
    } catch (e) {
      setMsg("danger", String(e?.message || e || "Erreur lors de la validation."));
    }
  }

  async function open(options) {
    await ensureLoaded();

    state.options = options || {};
    state.mode = "signature_tracee";
    state.hasInk = false;
    state.drawing = false;

    setMsg("info", "");

    const title = state.options.title || "Validation électronique";
    const sub = state.options.subtitle || signatureName();
    const name = signatureName();

    const titleEl = $("ve_modalTitle");
    const subEl = $("ve_modalSub");
    const generatedEl = $("ve_generatedSign");
    const slider = $("ve_confirmSlider");

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;
    if (generatedEl) generatedEl.innerHTML = veEsc(name);
    if (slider) slider.value = "0";

    setMode("signature_tracee");
    showModal();
    setTimeout(() => {
      clearCanvas();
      resizeCanvas();
      updateConfirmState();
    }, 60);
  }

  window.NovoskillValidationElectronique = {
    open,
    close: closeModal,
  };
})();
