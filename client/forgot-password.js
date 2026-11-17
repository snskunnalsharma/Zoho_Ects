(function () {
  const form = document.getElementById("forgot-form");
  const errorBanner = document.getElementById("error-banner");
  const successBanner = document.getElementById("success-banner");
  const submitBtn = document.getElementById("forgot-btn");
  const emailInput = document.getElementById("portal-email");

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

  if (emailInput) {
    emailInput.addEventListener("input", clearBanners);
  }

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const portalEmail = emailInput ? emailInput.value.trim() : "";

    if (!portalEmail) {
      showError("Enter your Portal Access Email");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(portalEmail)) {
      showError("Please enter a valid email address");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Requesting…";
    clearBanners();

    try {
      const response = await fetch("/server/agency_api/auth/forgot-password", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ portalEmail }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload.message || "No account found with this Portal Access Email"
        );
      }

      showSuccess(
        payload.message ||
          "Password reset requested. Check your email or CRM workflow."
      );
      form.reset();
    } catch (err) {
      showError(err.message || "Reset request failed");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Request reset";
    }
  });
})();
