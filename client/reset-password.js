(function () {
  const form = document.getElementById("reset-password-form");
  const errorBanner = document.getElementById("error-banner");
  const successBanner = document.getElementById("success-banner");
  const submitBtn = document.getElementById("reset-btn");

  const emailInput = document.getElementById("portal-email");
  const currentPasswordInput = document.getElementById("current-password");
  const newPasswordInput = document.getElementById("new-password");
  const confirmPasswordInput = document.getElementById("confirm-password");

  const toggleCurrentBtn = document.getElementById("toggle-current-password");
  const toggleNewBtn = document.getElementById("toggle-new-password");
  const toggleConfirmBtn = document.getElementById("toggle-confirm-password");

  // Pre-fill email from query param if passed e.g. reset-password.html?email=test@agency.com
  const params = new URLSearchParams(window.location.search);
  const emailParam = params.get("email") || params.get("portalEmail");
  if (emailParam && emailInput) {
    emailInput.value = emailParam;
  }

  function showError(message) {
    if (successBanner) successBanner.hidden = true;
    if (errorBanner) {
      errorBanner.hidden = false;
      errorBanner.textContent = message;
    }
  }

  function showSuccess(message) {
    if (errorBanner) errorBanner.hidden = true;
    if (successBanner) {
      successBanner.hidden = false;
      successBanner.textContent = message;
    }
  }

  function clearBanners() {
    if (errorBanner) errorBanner.hidden = true;
    if (successBanner) successBanner.hidden = true;
  }

  function setupPasswordToggle(input, btn) {
    if (!input || !btn) return;
    btn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-pressed", showing ? "false" : "true");
      btn.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password"
      );
    });
  }

  setupPasswordToggle(currentPasswordInput, toggleCurrentBtn);
  setupPasswordToggle(newPasswordInput, toggleNewBtn);
  setupPasswordToggle(confirmPasswordInput, toggleConfirmBtn);

  if (emailInput) emailInput.addEventListener("input", clearBanners);
  if (currentPasswordInput) currentPasswordInput.addEventListener("input", clearBanners);
  if (newPasswordInput) newPasswordInput.addEventListener("input", clearBanners);
  if (confirmPasswordInput) confirmPasswordInput.addEventListener("input", clearBanners);

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const portalEmail = emailInput ? emailInput.value.trim() : "";
    const currentPassword = currentPasswordInput ? currentPasswordInput.value.trim() : "";
    const newPassword = newPasswordInput ? newPasswordInput.value.trim() : "";
    const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value.trim() : "";

    if (!portalEmail) {
      showError("Enter your Portal Access Email");
      return;
    }

    if (!currentPassword) {
      showError("Enter your current password");
      return;
    }

    if (!newPassword) {
      showError("Enter your new password");
      return;
    }

    if (newPassword.length < 6) {
      showError("Password must be at least 6 characters long");
      return;
    }

    if (newPassword !== confirmPassword) {
      showError("New passwords do not match");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Updating…";
    clearBanners();

    try {
      const response = await fetch("/server/agency_api/auth/reset-password", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ portalEmail, currentPassword, newPassword }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "Failed to update password");
      }

      showSuccess(
        payload.message || "Password updated successfully. You can now sign in."
      );
      form.reset();
      setTimeout(() => {
        window.location.href = "index.html";
      }, 2000);
    } catch (err) {
      showError(err.message || "Password update failed");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Update Password";
    }
  });
})();
