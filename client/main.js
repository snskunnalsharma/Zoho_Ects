(function () {
  const form = document.getElementById("login-form");
  const banner = document.getElementById("error-banner");
  const submitBtn = document.getElementById("login-btn");
  const credentialInput = document.getElementById("credential");
  const toggleBtn = document.getElementById("toggle-credential");

  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error && banner) {
    banner.hidden = false;
    banner.textContent = error;
  }

  function showError(message) {
    if (!banner) return;
    banner.hidden = false;
    banner.textContent = message;
  }

  if (toggleBtn && credentialInput) {
    toggleBtn.addEventListener("click", () => {
      const showing = credentialInput.type === "text";
      credentialInput.type = showing ? "password" : "text";
      toggleBtn.textContent = showing ? "Show" : "Hide";
      toggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
      toggleBtn.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password"
      );
    });
  }

  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const portalEmail = document.getElementById("portal-email").value.trim();
    const credential = credentialInput.value;

    if (!portalEmail || !credential) {
      showError("Enter Portal Access Email and Credential");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";

    try {
      const response = await fetch("/server/agency_api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ portalEmail, credential }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "Login failed");
      }

      window.location.href = payload.redirectTo || "/app/dashboard.html";
    } catch (err) {
      showError(err.message || "Login failed");
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue";
    }
  });
})();
