(function () {
  const API_ME = "/server/agency_api/api/me";
  const DEFAULT_FORM_URL =
    "https://forms.zohopublic.com/eaglecreektherapyservices/form/PatientReferralForm/formperma/Iv84Mm6yJ1Q6qjJctjoYY2zmmB0t7_YjncLn10nlbBs";

  const loadingState = document.getElementById("loading-state");
  const errorState = document.getElementById("error-state");
  const agencySummary = document.getElementById("agency-summary");
  const formFrame = document.getElementById("zoho-form");
  const formFallback = document.getElementById("form-fallback");

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = value || "—";
    }
  }

  function isPlaceholderForm(url) {
    return (
      !url ||
      url.includes("YOUR_ORG") ||
      url.includes("YOUR_FORM") ||
      url.includes("YOUR_PERMA_LINK")
    );
  }

  /** Prefill Zoho Form SingleLine (Agency Name) & Email via URL params. */
  function buildPrefilledFormUrl(baseUrl, agency, portalEmail) {
    const agencyName = (agency.agencyName || agency.name || "").trim();
    const email = (portalEmail || agency.portalAccessEmail || agency.email || "").trim();
    try {
      const url = new URL(baseUrl, window.location.origin);
      if (agencyName) {
        url.searchParams.set("SingleLine", agencyName);
      }
      if (email) {
        url.searchParams.set("Email", email);
      }
      return url.toString();
    } catch {
      let result = baseUrl;
      if (agencyName) {
        const join = result.includes("?") ? "&" : "?";
        result = `${result}${join}SingleLine=${encodeURIComponent(agencyName)}`;
      }
      if (email) {
        const join = result.includes("?") ? "&" : "?";
        result = `${result}${join}Email=${encodeURIComponent(email)}`;
      }
      return result;
    }
  }

  let hasInitialFormLoaded = false;

  function syncFormHeight(event) {
    if (!formFrame || !event) return;
    const origin = String(event.origin || "");
    if (
      !origin.includes("zoho") &&
      !origin.includes("zfrmz") &&
      !origin.includes("zohopublic") &&
      !origin.includes("zohocdn")
    ) {
      return;
    }

    let height = null;
    const data = event.data;
    if (typeof data === "number") {
      height = data;
    } else if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        height = parsed.zfHeight || parsed.height || null;
      } catch {
        const asNumber = Number(data);
        if (!Number.isNaN(asNumber) && asNumber > 200) height = asNumber;
      }
    } else if (data && typeof data === "object") {
      height = data.zfHeight || data.height || null;
    }

    // Check for explicit submission / formthankyoupage events from Zoho Forms
    let isSubmitEvent = false;
    if (typeof data === "string") {
      const lower = data.toLowerCase();
      if (
        lower.includes("formthankyoupage") ||
        lower.includes("thankyou") ||
        lower.includes("thank_you") ||
        lower.includes("zfsubmitted") ||
        lower.includes("form_submitted") ||
        lower.includes("formsubmitted") ||
        lower.includes("zf_submission")
      ) {
        isSubmitEvent = true;
      }
    } else if (data && typeof data === "object") {
      const dataStr = JSON.stringify(data).toLowerCase();
      if (
        data.zfSubmitted ||
        data.isSubmitted ||
        data.type === "form_submit" ||
        data.type === "zf_submission" ||
        data.event === "submit" ||
        data.action === "submitted" ||
        dataStr.includes("formthankyoupage") ||
        dataStr.includes("thankyou") ||
        dataStr.includes("thank_you")
      ) {
        isSubmitEvent = true;
      }
    }

    if (isSubmitEvent) {
      window.location.href = "thank-you.html";
      return;
    }

    if (height && height > 200) {
      formFrame.style.height = `${height}px`;
    }
  }

  // When form is submitted inside the iframe, the iframe navigates to Zoho's thank-you page
  // (which loads formthankyoupage.js), firing a subsequent load event
  if (formFrame) {
    formFrame.addEventListener("load", () => {
      if (formFrame.src && formFrame.src !== "about:blank") {
        if (!hasInitialFormLoaded) {
          hasInitialFormLoaded = true;
        } else {
          // Form submitted and navigated to thank-you view
          window.location.href = "thank-you.html";
        }
      }
    });
  }

  window.addEventListener("message", syncFormHeight);

  async function loadDashboard() {
    try {
      const response = await fetch(API_ME, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (response.status === 401 || response.status === 403) {
        window.location.href =
          "/app/index.html?error=" +
          encodeURIComponent("Please sign in to continue");
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Unable to load agency details");
      }

      const data = await response.json();
      const agency = data.agency || {};
      const user = data.user || {};
      const portalEmail = agency.portalAccessEmail || agency.email || user.email;

      setText("field-agency-name", agency.agencyName || agency.name);
      setText("field-portal-email", portalEmail);

      if (loadingState) loadingState.hidden = true;
      if (agencySummary) agencySummary.hidden = false;

      const targetFormUrl =
        !isPlaceholderForm(data.formEmbedUrl) && data.formEmbedUrl
          ? data.formEmbedUrl
          : DEFAULT_FORM_URL;

      if (formFrame) {
        formFrame.src = buildPrefilledFormUrl(targetFormUrl, agency, portalEmail);
      }
    } catch (err) {
      if (loadingState) loadingState.hidden = true;
      if (errorState) {
        errorState.hidden = false;
        errorState.textContent = err.message || "Something went wrong";
      }
    }
  }

  loadDashboard();

  // Change Password Modal handling
  const openModalBtn = document.getElementById("open-change-password-btn");
  const closeModalBtn = document.getElementById("close-modal-btn");
  const cancelModalBtn = document.getElementById("cancel-modal-btn");
  const modalBackdrop = document.getElementById("password-modal");
  const changePasswordForm = document.getElementById("change-password-form");
  const modalErrorBanner = document.getElementById("modal-error-banner");
  const modalSuccessBanner = document.getElementById("modal-success-banner");
  const savePasswordBtn = document.getElementById("save-password-btn");

  const currentPassInput = document.getElementById("current-password");
  const newPassInput = document.getElementById("modal-new-password");
  const confirmPassInput = document.getElementById("modal-confirm-password");

  const toggleCurrentBtn = document.getElementById("toggle-current-pass");
  const toggleNewBtn = document.getElementById("toggle-modal-new-pass");
  const toggleConfirmBtn = document.getElementById("toggle-modal-confirm-pass");

  function setupToggle(input, btn) {
    if (!input || !btn) return;
    btn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-pressed", showing ? "false" : "true");
    });
  }

  setupToggle(currentPassInput, toggleCurrentBtn);
  setupToggle(newPassInput, toggleNewBtn);
  setupToggle(confirmPassInput, toggleConfirmBtn);

  function showModalError(msg) {
    if (modalSuccessBanner) modalSuccessBanner.hidden = true;
    if (modalErrorBanner) {
      modalErrorBanner.hidden = false;
      modalErrorBanner.textContent = msg;
    }
  }

  function showModalSuccess(msg) {
    if (modalErrorBanner) modalErrorBanner.hidden = true;
    if (modalSuccessBanner) {
      modalSuccessBanner.hidden = false;
      modalSuccessBanner.textContent = msg;
    }
  }

  function clearModalBanners() {
    if (modalErrorBanner) modalErrorBanner.hidden = true;
    if (modalSuccessBanner) modalSuccessBanner.hidden = true;
  }

  function openModal() {
    clearModalBanners();
    if (changePasswordForm) changePasswordForm.reset();
    if (modalBackdrop) modalBackdrop.hidden = false;
  }

  function closeModal() {
    clearModalBanners();
    if (modalBackdrop) modalBackdrop.hidden = true;
  }

  if (openModalBtn) openModalBtn.addEventListener("click", openModal);
  if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
  if (cancelModalBtn) cancelModalBtn.addEventListener("click", closeModal);

  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", (e) => {
      if (e.target === modalBackdrop) closeModal();
    });
  }

  if (changePasswordForm) {
    changePasswordForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const currentPassword = currentPassInput ? currentPassInput.value.trim() : "";
      const newPassword = newPassInput ? newPassInput.value.trim() : "";
      const confirmPassword = confirmPassInput ? confirmPassInput.value.trim() : "";

      if (!currentPassword || !newPassword) {
        showModalError("Please enter current and new password");
        return;
      }

      if (newPassword.length < 6) {
        showModalError("New password must be at least 6 characters long");
        return;
      }

      if (newPassword !== confirmPassword) {
        showModalError("New passwords do not match");
        return;
      }

      savePasswordBtn.disabled = true;
      savePasswordBtn.textContent = "Updating…";
      clearModalBanners();

      try {
        const response = await fetch("/server/agency_api/api/change-password", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ currentPassword, newPassword }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.message || "Failed to change password");
        }

        showModalSuccess(payload.message || "Password changed successfully.");
        setTimeout(() => {
          closeModal();
        }, 1500);
      } catch (err) {
        showModalError(err.message || "Failed to change password");
      } finally {
        savePasswordBtn.disabled = false;
        savePasswordBtn.textContent = "Update Password";
      }
    });
  }
})();