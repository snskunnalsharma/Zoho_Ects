(function () {
  const API_ME = "/server/agency_api/api/me";
  const API_THERAPISTS = "/server/agency_api/api/therapists";
  const API_SEND_CREDENTIALS = "/server/agency_api/api/therapists/send-credentials";
  const DEFAULT_PAGE_SIZE = 8;
  let pageSize = DEFAULT_PAGE_SIZE;

  const tableLoading = document.getElementById("table-loading");
  const tableError = document.getElementById("table-error");
  const tableEmpty = document.getElementById("table-empty");
  const tableWrapper = document.getElementById("table-wrapper");
  const tbody = document.getElementById("therapist-tbody");
  const errorMessage = document.getElementById("error-message");

  const statTotal = document.getElementById("stat-total");
  const statTotalLabel = document.getElementById("stat-total-label");
  const statPt = document.getElementById("stat-pt");
  const statOt = document.getElementById("stat-ot");
  const statSt = document.getElementById("stat-st");

  const searchInput = document.getElementById("search-input");
  const searchClearBtn = document.getElementById("search-clear-btn");
  const searchGlobalIndicator = document.getElementById("search-global-indicator");
  const searchGlobalText = document.getElementById("search-global-text");
  const resetGlobalSearchBtn = document.getElementById("reset-global-search-btn");

  // Search Scope Toggle elements (Agency Search vs Global Search)
  const searchScopeToggle = document.getElementById("search-scope-toggle");
  const scopeLabelAgency = document.getElementById("scope-label-agency");
  const scopeLabelGlobal = document.getElementById("scope-label-global");
  let searchScope = "agency"; // "agency" | "global"

  const roleFilter = document.getElementById("role-filter");
  const disciplineFilter = document.getElementById("discipline-filter");
  const pageSizeFilter = document.getElementById("page-size-filter");
  const refreshBtn = document.getElementById("refresh-btn");
  const retryBtn = document.getElementById("retry-btn");

  // Selection & Action elements
  const sendCredentialsBtn = document.getElementById("send-credentials-btn");
  const selectedBadge = document.getElementById("selected-badge");
  const selectAllCheckbox = document.getElementById("select-all-therapists");
  const actionAlert = document.getElementById("action-alert");
  const actionAlertText = document.getElementById("action-alert-text");
  const actionAlertClose = document.getElementById("action-alert-close");

  // Show/Hide Column Visibility elements
  const colVisBtn = document.getElementById("col-vis-btn");
  const colVisMenu = document.getElementById("col-vis-menu");
  const colVisMenuList = document.getElementById("col-vis-menu-list");
  const colVisResetBtn = document.getElementById("col-vis-reset-btn");

  const COLUMN_DEFINITIONS = [
    { key: "name", label: "Therapist Name", defaultVisible: true },
    { key: "discipline", label: "Discipline", defaultVisible: true },
    { key: "agency", label: "Agency", defaultVisible: false },
    { key: "email", label: "Email Address", defaultVisible: false },
    { key: "phone", label: "Phone Number", defaultVisible: false },
    { key: "cityStateZip", label: "City / State / Zip", defaultVisible: false },
    { key: "address", label: "Mailing Address", defaultVisible: false },
    { key: "status", label: "Status", defaultVisible: false },
  ];
  const STORAGE_KEY_COLUMNS = "ects_therapist_columns_visibility_v3";
  let columnVisibility = {};

  // Pagination elements
  const paginationContainer = document.getElementById("pagination-container");
  const pageSizeSelect = document.getElementById("page-size-select");
  const pageStart = document.getElementById("page-start");
  const pageEnd = document.getElementById("page-end");
  const pageTotalCount = document.getElementById("page-total-count");
  const paginationPages = document.getElementById("pagination-pages");
  const firstPageBtn = document.getElementById("first-page-btn");
  const prevPageBtn = document.getElementById("prev-page-btn");
  const nextPageBtn = document.getElementById("next-page-btn");
  const lastPageBtn = document.getElementById("last-page-btn");

  let allAgencyTherapists = [];
  let displayedTherapists = [];
  let currentFiltered = [];
  let currentPage = 1;
  const selectedTherapistIds = new Set();
  let alertTimer = null;
  let searchDebounceTimer = null;
  let currentSearchSeq = 0;
  let currentSearchAbortController = null;
  let isGlobalSearchActive = false;
  let currentAgencyName = "";

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showAlert(type, content, isHtml = false, duration = null) {
    if (!actionAlert || !actionAlertText) return;
    if (alertTimer) {
      clearTimeout(alertTimer);
      alertTimer = null;
    }

    if (isHtml) {
      actionAlertText.innerHTML = content;
    } else {
      const isSuccess = type === "success";
      actionAlertText.innerHTML = `
        <div class="toast-section">
          <div class="toast-header-row" style="align-items: flex-start; gap: 0.65rem;">
            <span class="toast-header-icon ${isSuccess ? "toast-header-icon-success" : "toast-header-icon-error"}" style="margin-top: 2px;">
              ${isSuccess
                ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="16 9 10 15 7 12"></polyline></svg>`
                : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
              }
            </span>
            <div style="display: flex; flex-direction: column; gap: 0.25rem;">
              <span class="toast-header-title" style="font-weight: 600; font-size: 0.92rem; line-height: 1.45; color: #1e293b;">${escapeHtml(content)}</span>
            </div>
          </div>
        </div>
      `;
    }

    actionAlert.hidden = false;
    if (duration && typeof duration === "number" && duration > 0) {
      alertTimer = setTimeout(hideAlert, duration);
    }
  }

  function hideAlert() {
    if (actionAlert) actionAlert.hidden = true;
    if (alertTimer) {
      clearTimeout(alertTimer);
      alertTimer = null;
    }
  }

  function matchDisciplineCode(recordDisc, filterDisc) {
    if (!filterDisc || filterDisc === "ALL") return true;
    const rd = (recordDisc || "").trim().toUpperCase();
    const fd = filterDisc.trim().toUpperCase();

    if (fd === "NONE") {
      return !rd || rd === "â€”" || rd === "-" || rd === "NONE" || rd === "N/A" || rd === "NULL" || rd === "UNDEFINED";
    }

    if (fd === "STA" || fd === "SLPA") {
      return (
        rd === "STA" ||
        rd === "SLPA" ||
        /\bSTA\b/i.test(rd) ||
        /\bSLPA\b/i.test(rd) ||
        rd.includes("SPEECH THERAPY ASSISTANT") ||
        rd.includes("SPEECH LANGUAGE PATHOLOGY ASSISTANT") ||
        (rd.includes("SPEECH") && (rd.includes("ASSISTANT") || rd.includes("ASST")))
      );
    }

    if (fd === "ST" || fd === "SLP") {
      // Must NOT match STA or Assistant
      if (
        rd === "STA" ||
        rd === "SLPA" ||
        /\bSTA\b/i.test(rd) ||
        /\bSLPA\b/i.test(rd) ||
        (rd.includes("SPEECH") && (rd.includes("ASSISTANT") || rd.includes("ASST")))
      ) {
        return false;
      }
      return (
        rd === "ST" ||
        rd === "SLP" ||
        /\bST\b/i.test(rd) ||
        /\bSLP\b/i.test(rd) ||
        rd.includes("SPEECH THERAPIST") ||
        rd.includes("SPEECH LANGUAGE PATHOLOGIST") ||
        (rd.includes("SPEECH") && !rd.includes("ASSISTANT"))
      );
    }

    if (fd === "PT") {
      if (rd === "PTA" || /\bPTA\b/i.test(rd) || (rd.includes("PHYSICAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")))) {
        return false;
      }
      return rd === "PT" || /\bPT\b/i.test(rd) || (rd.includes("PHYSICAL") && !rd.includes("ASSISTANT"));
    }

    if (fd === "PTA") {
      return rd === "PTA" || /\bPTA\b/i.test(rd) || (rd.includes("PHYSICAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")));
    }

    if (fd === "OT") {
      if (rd === "COTA" || /\bCOTA\b/i.test(rd) || (rd.includes("OCCUPATIONAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")))) {
        return false;
      }
      return rd === "OT" || /\bOT\b/i.test(rd) || (rd.includes("OCCUPATIONAL") && !rd.includes("ASSISTANT"));
    }

    if (fd === "COTA") {
      return rd === "COTA" || /\bCOTA\b/i.test(rd) || (rd.includes("OCCUPATIONAL") && (rd.includes("ASSISTANT") || rd.includes("ASST")));
    }

    if (fd === "MSW") {
      return rd === "MSW" || /\bMSW\b/i.test(rd) || rd.includes("SOCIAL");
    }

    return rd === fd || rd.includes(fd);
  }

  function detectDisciplineQuery(query) {
    if (!query) return null;
    const q = query.trim().toLowerCase();

    // STA / Speech Therapy Assistant
    if (
      q === "sta" ||
      q === "slpa" ||
      q === "speech therapy assistant" ||
      q === "speech therapist assistant" ||
      q === "speech assistant" ||
      q.includes("speech therapy assistant") ||
      q.includes("speech assistant")
    ) {
      return "STA";
    }

    // ST / Speech Therapist / Speech Therapy
    if (
      q === "st" ||
      q === "slp" ||
      q === "speech" ||
      q === "speech therapist" ||
      q === "speech therapy" ||
      q === "speech language pathologist" ||
      q === "speech pathologist" ||
      (q.includes("speech") && !q.includes("assistant"))
    ) {
      return "ST";
    }

    // PTA / Physical Therapist Assistant
    if (
      q === "pta" ||
      q === "physical therapist assistant" ||
      q === "physical therapy assistant" ||
      q === "physical assistant" ||
      q.includes("physical therapy assistant") ||
      q.includes("physical therapist assistant")
    ) {
      return "PTA";
    }

    // PT / Physical Therapist / Physical Therapy
    if (
      q === "pt" ||
      q === "physical" ||
      q === "physical therapist" ||
      q === "physical therapy" ||
      (q.includes("physical") && !q.includes("assistant"))
    ) {
      return "PT";
    }

    // COTA / Occupational Therapy Assistant
    if (
      q === "cota" ||
      q === "ota" ||
      q === "occupational therapy assistant" ||
      q === "occupational therapist assistant" ||
      q === "certified occupational therapy assistant" ||
      q.includes("occupational therapy assistant") ||
      q.includes("occupational therapist assistant")
    ) {
      return "COTA";
    }

    // OT / Occupational Therapist / Occupational Therapy
    if (
      q === "ot" ||
      q === "occupational" ||
      q === "occupational therapist" ||
      q === "occupational therapy" ||
      (q.includes("occupational") && !q.includes("assistant"))
    ) {
      return "OT";
    }

    // MSW / Medical Social Worker
    if (
      q === "msw" ||
      q === "medical social worker" ||
      q === "social worker" ||
      q === "social work" ||
      q.includes("medical social worker") ||
      q.includes("social worker")
    ) {
      return "MSW";
    }

    return null;
  }

  function matchesBasicText(t, qLower) {
    if (!qLower) return true;
    if ((t.name || "").toLowerCase().includes(qLower)) return true;
    if ((t.email || "").toLowerCase().includes(qLower)) return true;
    if (Array.isArray(t.emails) && t.emails.some((e) => (e || "").toLowerCase().includes(qLower))) return true;
    if ((t.phone || "").toLowerCase().includes(qLower)) return true;
    const cleanDigits = qLower.replace(/\D/g, "");
    if (cleanDigits.length >= 3 && Array.isArray(t.phones) && t.phones.some((p) => (p || "").includes(cleanDigits))) return true;
    if ((t.city || "").toLowerCase().includes(qLower)) return true;
    if ((t.state || "").toLowerCase().includes(qLower)) return true;
    if ((t.zip || "").toLowerCase().includes(qLower)) return true;
    if ((t.address || "").toLowerCase().includes(qLower)) return true;
    if ((t.agencyName || "").toLowerCase().includes(qLower)) return true;
    if ((t.discipline || "").toLowerCase().includes(qLower)) return true;

    // Check aggregated agencies
    if (Array.isArray(t.agencies) && t.agencies.some((a) => (a || "").toLowerCase().includes(qLower))) {
      return true;
    }

    // Check aggregated disciplines
    if (Array.isArray(t.disciplines) && t.disciplines.some((d) => (d || "").toLowerCase().includes(qLower))) {
      return true;
    }

    // Check aggregated locations
    if (Array.isArray(t.locations) && t.locations.some((loc) => {
      const full = (loc.fullAddress || "").toLowerCase();
      const c = (loc.city || "").toLowerCase();
      const z = (loc.zip || "").toLowerCase();
      return full.includes(qLower) || c.includes(qLower) || z.includes(qLower);
    })) {
      return true;
    }

    // Check aggregated licenses
    if (Array.isArray(t.licenses) && t.licenses.some((lic) => String(lic || "").toLowerCase().includes(qLower))) {
      return true;
    }

    return false;
  }

  function hasAvailableDiscipline(t) {
    if (!t) return false;
    const d = (t.discipline || "").trim().toUpperCase();
    if (d && d !== "â€”" && d !== "-" && d !== "NONE" && d !== "N/A" && d !== "NULL") {
      return true;
    }
    if (Array.isArray(t.disciplines) && t.disciplines.length > 0) {
      return t.disciplines.some((disc) => {
        const s = String(disc || "").trim().toUpperCase();
        return Boolean(s && s !== "â€”" && s !== "-" && s !== "NONE" && s !== "N/A" && s !== "NULL");
      });
    }
    return false;
  }

  function matchesSearchText(t, query) {
    if (!query) return true;
    if (!hasAvailableDiscipline(t)) {
      return false;
    }
    const qLower = query.toLowerCase().trim();

    // 1. Exact match on discipline name, code, or phrase
    const exactDisc = detectDisciplineQuery(qLower);
    if (exactDisc) {
      return matchDisciplineCode(t.discipline, exactDisc);
    }

    // 2. Check if query combines a discipline with other keywords (e.g. "Dallas ST" or "Prosper PT")
    const words = qLower.split(/\s+/).filter(Boolean);
    let matchedDiscInQuery = null;
    const otherWords = [];

    for (const w of words) {
      const d = detectDisciplineQuery(w);
      if (d && !matchedDiscInQuery) {
        matchedDiscInQuery = d;
      } else {
        otherWords.push(w);
      }
    }

    if (matchedDiscInQuery) {
      if (!matchDisciplineCode(t.discipline, matchedDiscInQuery)) {
        return false;
      }
      if (otherWords.length > 0) {
        return matchesBasicText(t, otherWords.join(" "));
      }
      return true;
    }

    // 3. Normal text search on name, location, email, phone, agency
    return matchesBasicText(t, qLower);
  }

  function deduplicateTherapists(list) {
    if (!Array.isArray(list)) return [];
    const resultList = [];
    const idIndex = new Map();
    const nameIndex = new Map();
    const emailIndex = new Map();
    const namePhoneIndex = new Map();

    for (const item of list) {
      if (!item) continue;
      const id = String(item.id || item.contactId || "").trim();

      // Prepare matching keys
      const cleanEmail = (item.email || "").trim().toLowerCase();
      const hasValidEmail = Boolean(cleanEmail && cleanEmail !== "â€”" && cleanEmail !== "-" && cleanEmail.includes("@"));

      const cleanPhone = (item.phone || item.mobile || "").replace(/\D/g, "");
      const hasValidPhone = cleanPhone.length >= 7;

      const fullName = (item.name || `${item.firstName || ""} ${item.lastName || ""}`).trim();
      const cleanName = fullName.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isMeaningfulName = Boolean(cleanName && cleanName !== "therapist" && cleanName.length >= 2);

      // Entity resolution: Match by ID -> Same Name -> Same Email -> Same Phone
      let existing = null;
      if (id && idIndex.has(id)) {
        existing = idIndex.get(id);
      } else if (isMeaningfulName && nameIndex.has(cleanName)) {
        existing = nameIndex.get(cleanName);
      } else if (hasValidEmail && emailIndex.has(cleanEmail)) {
        existing = emailIndex.get(cleanEmail);
      } else if (isMeaningfulName && hasValidPhone && namePhoneIndex.has(`${cleanName}|${cleanPhone}`)) {
        existing = namePhoneIndex.get(`${cleanName}|${cleanPhone}`);
      }

      if (!existing) {
        const copy = { ...item };
        copy.ids = id ? [id] : [];
        if (Array.isArray(item.ids)) {
          copy.ids = Array.from(new Set([...copy.ids, ...item.ids]));
        }
        copy.emails = hasValidEmail ? [cleanEmail] : (copy.email && copy.email.includes("@") ? [copy.email.toLowerCase()] : []);
        copy.phones = hasValidPhone ? [cleanPhone] : [];

        // Normalize locations
        if (Array.isArray(copy.locations) && copy.locations.length > 0) {
          copy.locations = copy.locations.filter(Boolean);
        } else if (copy.address && copy.address !== "â€”") {
          copy.locations = [
            {
              fullAddress: copy.address,
              city: copy.city && copy.city !== "â€”" ? copy.city : "",
              state: copy.state && copy.state !== "â€”" ? copy.state : "",
              zip: copy.zip && copy.zip !== "â€”" ? copy.zip : "",
            },
          ];
        } else {
          copy.locations = [];
        }

        // Normalize licenses
        if (Array.isArray(copy.licenses)) {
          copy.licenses = copy.licenses.filter(Boolean);
        } else if (copy.license && copy.license !== "â€”") {
          copy.licenses = [copy.license];
        } else {
          copy.licenses = [];
        }

        // Normalize disciplines
        if (Array.isArray(copy.disciplines)) {
          copy.disciplines = copy.disciplines.filter(Boolean);
        } else if (copy.discipline && copy.discipline !== "â€”") {
          copy.disciplines = [copy.discipline];
        } else {
          copy.disciplines = [];
        }

        // Normalize agencies
        if (Array.isArray(copy.agencies)) {
          copy.agencies = copy.agencies.filter(Boolean);
        } else if (copy.agencyName && copy.agencyName !== "â€”") {
          copy.agencies = [copy.agencyName];
        } else {
          copy.agencies = [];
        }

        resultList.push(copy);
        if (id) idIndex.set(id, copy);
        if (isMeaningfulName) nameIndex.set(cleanName, copy);
        if (hasValidEmail) emailIndex.set(cleanEmail, copy);
        if (isMeaningfulName && hasValidPhone) namePhoneIndex.set(`${cleanName}|${cleanPhone}`, copy);
      } else {
        // Merge into existing
        if (id && !existing.ids.includes(id)) {
          existing.ids.push(id);
        }
        if (id) idIndex.set(id, existing);
        if (isMeaningfulName) nameIndex.set(cleanName, existing);
        if (hasValidEmail) {
          emailIndex.set(cleanEmail, existing);
          if (!Array.isArray(existing.emails)) existing.emails = [];
          if (!existing.emails.includes(cleanEmail)) {
            existing.emails.push(cleanEmail);
          }
        }
        if (hasValidPhone) {
          if (!Array.isArray(existing.phones)) existing.phones = [];
          if (!existing.phones.includes(cleanPhone)) {
            existing.phones.push(cleanPhone);
          }
        }
        if (isMeaningfulName && hasValidPhone) namePhoneIndex.set(`${cleanName}|${cleanPhone}`, existing);

        // Merge locations
        const newLocations = Array.isArray(item.locations) && item.locations.length > 0
          ? item.locations
          : item.address && item.address !== "â€”"
          ? [{
              fullAddress: item.address,
              city: item.city && item.city !== "â€”" ? item.city : "",
              state: item.state && item.state !== "â€”" ? item.state : "",
              zip: item.zip && item.zip !== "â€”" ? item.zip : "",
            }]
          : [];

        newLocations.forEach((loc) => {
          if (!loc || !loc.fullAddress || loc.fullAddress === "â€”") return;
          const already = existing.locations.some(
            (l) => (l.fullAddress || "").toLowerCase() === loc.fullAddress.toLowerCase()
          );
          if (!already) {
            existing.locations.push(loc);
          }
        });

        // Merge licenses
        const newLicenses = Array.isArray(item.licenses)
          ? item.licenses
          : item.license && item.license !== "â€”"
          ? [item.license]
          : [];
        newLicenses.forEach((lic) => {
          if (lic && !existing.licenses.includes(lic)) {
            existing.licenses.push(lic);
          }
        });

        // Merge disciplines
        const newDiscs = Array.isArray(item.disciplines)
          ? item.disciplines
          : item.discipline && item.discipline !== "â€”"
          ? [item.discipline]
          : [];
        newDiscs.forEach((d) => {
          if (d && !existing.disciplines.includes(d)) {
            existing.disciplines.push(d);
            if (!existing.discipline || existing.discipline === "â€”") {
              existing.discipline = d;
            } else if (!existing.discipline.toLowerCase().includes(d.toLowerCase())) {
              existing.discipline = `${existing.discipline}, ${d}`;
            }
          }
        });

        // Merge agencies
        const newAgencies = Array.isArray(item.agencies)
          ? item.agencies
          : item.agencyName && item.agencyName !== "â€”"
          ? [item.agencyName]
          : [];
        newAgencies.forEach((ag) => {
          if (ag && !existing.agencies.includes(ag)) {
            existing.agencies.push(ag);
          }
        });

        // Contact info fallbacks
        if ((!existing.email || existing.email === "â€”") && item.email && item.email !== "â€”") {
          existing.email = item.email;
        }
        if ((!existing.phone || existing.phone === "â€”") && item.phone && item.phone !== "â€”") {
          existing.phone = item.phone;
        }
      }
    }

    return resultList;
  }

  function getDisciplineClass(disc) {
    const d = (disc || "").toUpperCase();
    if (
      d === "STA" ||
      d === "SLPA" ||
      /\bSTA\b/i.test(d) ||
      /\bSLPA\b/i.test(d) ||
      (d.includes("SPEECH") && (d.includes("ASSISTANT") || d.includes("ASST")))
    ) {
      return "disc-badge disc-sta";
    }
    if (d === "PTA" || /\bPTA\b/i.test(d) || (d.includes("PHYSICAL") && (d.includes("ASSISTANT") || d.includes("ASST")))) {
      return "disc-badge disc-pt";
    }
    if (d === "COTA" || /\bCOTA\b/i.test(d) || (d.includes("OCCUPATIONAL") && (d.includes("ASSISTANT") || d.includes("ASST")))) {
      return "disc-badge disc-ot";
    }
    if (d.includes("PT") || d.includes("PHYSICAL")) return "disc-badge disc-pt";
    if (d.includes("OT") || d.includes("OCCUPATIONAL")) return "disc-badge disc-ot";
    if (d.includes("ST") || d.includes("SLP") || d.includes("SPEECH")) return "disc-badge disc-st";
    if (d.includes("MSW") || d.includes("SOCIAL")) return "disc-badge disc-msw";
    return "disc-badge";
  }

  function getStatusClass(status) {
    const s = (status || "").toLowerCase();
    if (s === "active" || s === "approved" || s === "seeing") return "status-badge badge-active";
    if (s.includes("onboard") || s === "pending" || s.includes("assign")) return "status-badge badge-pending";
    if (s === "inactive" || s === "terminated" || s === "discharged") return "status-badge badge-danger";
    return "status-badge badge-default";
  }

  function resolveRole(t) {
    if (!t) return "Therapist";
    if (t.role && typeof t.role === "string" && t.role.trim()) {
      const r = t.role.trim().toLowerCase();
      if (r.includes("assistant") && (r.includes("therapist") || r.includes("supervisor"))) return "Therapist / Asst";
      if (r.includes("assistant")) return "Assistant";
      if (r.includes("supervisor") || r.includes("therapist")) return "Therapist";
    }
    const d = (t.discipline || "").trim().toUpperCase();
    if (
      d === "PTA" ||
      d === "COTA" ||
      d === "STA" ||
      d === "SLPA" ||
      /\bSTA\b/i.test(d) ||
      /\bPTA\b/i.test(d) ||
      /\bCOTA\b/i.test(d) ||
      d.includes("ASSISTANT") ||
      d.endsWith("A")
    ) {
      return "Assistant";
    }
    return "Therapist";
  }

  function getRoleBadgeHtml(role) {
    const r = (role || "Therapist").toLowerCase();
    if (r.includes("assistant") && r.includes("therapist")) {
      return `<span class="role-badge role-dual">Therapist / Asst</span>`;
    }
    if (r.includes("assistant")) {
      return `<span class="role-badge role-assistant">Assistant</span>`;
    }
    return `<span class="role-badge role-therapist">Therapist</span>`;
  }

  function getCurrentPageTherapists() {
    const startIndex = (currentPage - 1) * pageSize;
    return currentFiltered.slice(startIndex, startIndex + pageSize);
  }

  function updateSelectionUI() {
    const totalSelected = selectedTherapistIds.size;

    if (selectedBadge) {
      selectedBadge.textContent = totalSelected;
      selectedBadge.hidden = totalSelected === 0;
    }

    if (sendCredentialsBtn) {
      sendCredentialsBtn.hidden = false;
      sendCredentialsBtn.disabled = false;
      sendCredentialsBtn.title =
        totalSelected > 0
          ? `Send credentials for ${totalSelected} selected therapist${totalSelected === 1 ? "" : "s"}`
          : "Select therapists from the list to send credentials";

      if (totalSelected > 0) {
        sendCredentialsBtn.classList.remove("btn-outline");
        sendCredentialsBtn.classList.add("btn-primary");
      } else {
        sendCredentialsBtn.classList.remove("btn-primary");
        sendCredentialsBtn.classList.add("btn-outline");
      }
    }

    if (tbody) {
      const rows = tbody.querySelectorAll("tr");
      rows.forEach((row) => {
        const checkbox = row.querySelector(".therapist-row-checkbox");
        if (checkbox) {
          const id = checkbox.getAttribute("data-id");
          const isSelected = selectedTherapistIds.has(id);
          checkbox.checked = isSelected;
          row.classList.toggle("row-selected", isSelected);
        }
      });
    }

    if (selectAllCheckbox) {
      const pageTherapists = getCurrentPageTherapists();
      if (pageTherapists.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
      } else {
        const selectedOnPage = pageTherapists.filter((t) =>
          selectedTherapistIds.has(t.id)
        ).length;

        if (selectedOnPage === pageTherapists.length) {
          selectAllCheckbox.checked = true;
          selectAllCheckbox.indeterminate = false;
        } else if (selectedOnPage > 0) {
          selectAllCheckbox.checked = false;
          selectAllCheckbox.indeterminate = true;
        } else {
          selectAllCheckbox.checked = false;
          selectAllCheckbox.indeterminate = false;
        }
      }
    }
  }

  function renderTableRows(list) {
    if (!tbody) return;
    tbody.innerHTML = list
      .map((t) => {
        const discClass = getDisciplineClass(t.discipline);
        const statusClass = getStatusClass(t.status);
        const role = resolveRole(t);
        const roleBadge = getRoleBadgeHtml(role);
        const isSelected = selectedTherapistIds.has(t.id);
        const isAssistant = role === "Assistant";

        const cityStateZip = [
          t.city !== "â€”" ? t.city : "",
          t.state !== "â€”" ? t.state : "",
          t.zip !== "â€”" ? t.zip : "",
        ]
          .filter(Boolean)
          .join(", ") || "â€”";

        const emailLink = t.email && t.email !== "â€”"
          ? `<a class="text-link" href="mailto:${escapeHtml(t.email)}">${escapeHtml(t.email)}</a>`
          : `<span class="text-muted">â€”</span>`;

        const phoneLink = t.phone && t.phone !== "â€”"
          ? `<a class="phone-link" href="tel:${escapeHtml(t.phone)}">${escapeHtml(t.phone)}</a>`
          : `<span class="text-muted">â€”</span>`;

        // Surface multiple disciplines if present
        let discHtml = "";
        if (Array.isArray(t.disciplines) && t.disciplines.length > 1) {
          discHtml = t.disciplines
            .map((d) => `<span class="${getDisciplineClass(d)}" style="margin-right: 4px; display: inline-block;">${escapeHtml(d)}</span>`)
            .join("");
        } else {
          discHtml = `<span class="${discClass}">${escapeHtml(t.discipline)}</span>`;
        }

        // Surface multiple locations if present
        let addressHtml = `<span>${escapeHtml(t.address)}</span>`;
        if (Array.isArray(t.locations) && t.locations.length > 1) {
          const extraLocs = t.locations.slice(1);
          const tooltip = extraLocs
            .map((l) => `${l.fullAddress}${l.city ? ` (${l.city}, ${l.state || ""} ${l.zip || ""})` : ""}`)
            .join("\n");
          addressHtml += `<div class="location-extra-badge" title="${escapeHtml(tooltip)}">+${extraLocs.length} more location${extraLocs.length > 1 ? "s" : ""}</div>`;
        }

        // Surface multiple agencies if present
        let agencyHtml = `<span class="agency-pill" title="${escapeHtml(t.agencyName || currentAgencyName || 'â€”')}">${escapeHtml(t.agencyName || currentAgencyName || "â€”")}</span>`;
        if (Array.isArray(t.agencies) && t.agencies.length > 1) {
          const extraAgencies = t.agencies.filter((a) => a !== (t.agencyName || currentAgencyName));
          if (extraAgencies.length > 0) {
            agencyHtml += `<div class="location-extra-badge" style="display: block; margin-top: 2px;" title="${escapeHtml(extraAgencies.join(', '))}">+${extraAgencies.length} other agenc${extraAgencies.length > 1 ? "ies" : "y"}</div>`;
          }
        }

        // Surface licenses under name if present
        let nameHtml = `<div class="patient-name">${escapeHtml(t.name)}</div>`;
        if (Array.isArray(t.licenses) && t.licenses.length > 0) {
          const licText = t.licenses.join(", ");
          nameHtml += `<div style="font-size: 0.72rem; color: #64748b; font-weight: 500; margin-top: 1px;" title="License: ${escapeHtml(licText)}">Lic: ${escapeHtml(licText)}</div>`;
        }

        return `
          <tr class="${isSelected ? "row-selected" : ""}">
            <td class="td-checkbox">
              <input
                type="checkbox"
                class="custom-checkbox therapist-row-checkbox"
                data-id="${escapeHtml(t.id)}"
                aria-label="Select ${escapeHtml(t.name)}"
                ${isSelected ? "checked" : ""}
              />
            </td>
            <td data-col="name">
              ${nameHtml}
            </td>
            <td data-col="discipline">
              ${discHtml}
            </td>
            <td data-col="agency">
              ${agencyHtml}
            </td>
            <td data-col="email">
              ${emailLink}
            </td>
            <td data-col="phone">
              ${phoneLink}
            </td>
            <td data-col="cityStateZip">
              <div><strong>${escapeHtml(cityStateZip)}</strong></div>
            </td>
            <td class="address-cell" data-col="address">
              ${addressHtml}
            </td>
            <td data-col="status">
              <span class="${statusClass}">${escapeHtml(t.status || t.layout || "Active")}</span>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".therapist-row-checkbox").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-id");
        if (e.target.checked) {
          selectedTherapistIds.add(id);
        } else {
          selectedTherapistIds.delete(id);
        }
        updateSelectionUI();
      });
    });

    updateSelectionUI();
  }

  function renderPagination(totalItems) {
    if (!paginationContainer) return;

    if (totalItems === 0) {
      paginationContainer.hidden = true;
      return;
    }

    paginationContainer.hidden = false;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    if (currentPage > totalPages) {
      currentPage = totalPages;
    } else if (currentPage < 1) {
      currentPage = 1;
    }

    const start = (currentPage - 1) * pageSize + 1;
    const end = Math.min(currentPage * pageSize, totalItems);

    if (pageStart) pageStart.textContent = start;
    if (pageEnd) pageEnd.textContent = end;
    if (pageTotalCount) pageTotalCount.textContent = totalItems;

    if (firstPageBtn) firstPageBtn.disabled = currentPage === 1;
    if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
    if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
    if (lastPageBtn) lastPageBtn.disabled = currentPage === totalPages;

    if (paginationPages) {
      paginationPages.innerHTML = "";
      const pageNumbers = getPaginationPages(currentPage, totalPages);

      pageNumbers.forEach((item) => {
        if (item === "...") {
          const ellipsis = document.createElement("span");
          ellipsis.className = "pagination-ellipsis";
          ellipsis.textContent = "â€¦";
          paginationPages.appendChild(ellipsis);
        } else {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `pagination-btn ${item === currentPage ? "active" : ""}`;
          btn.textContent = item;
          btn.setAttribute("aria-label", `Page ${item}`);
          btn.addEventListener("click", () => goToPage(item));
          paginationPages.appendChild(btn);
        }
      });
    }
  }

  function getPaginationPages(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [1];
    if (current > 3) pages.push("...");
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (current < total - 2) pages.push("...");
    pages.push(total);
    return pages;
  }

  function goToPage(page) {
    const totalPages = Math.max(1, Math.ceil(currentFiltered.length / pageSize));
    if (page < 1 || page > totalPages || page === currentPage) return;
    currentPage = page;
    renderCurrentPage();

    if (tableWrapper) {
      tableWrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function renderCurrentPage() {
    if (!tableWrapper || !tbody) return;

    if (!currentFiltered || currentFiltered.length === 0) {
      tableWrapper.hidden = true;
      if (paginationContainer) paginationContainer.hidden = true;
      if (tableEmpty) tableEmpty.hidden = false;
      updateSelectionUI();
      return;
    }

    if (tableEmpty) tableEmpty.hidden = true;
    tableWrapper.hidden = false;

    const pageTherapists = getCurrentPageTherapists();
    renderTableRows(pageTherapists);
    renderPagination(currentFiltered.length);
  }

  function updateStats(list, selectedDisc) {
    const targetList = Array.isArray(list) ? list : [];
    if (statTotal) statTotal.textContent = targetList.length;

    if (statTotalLabel) {
      const disc = (selectedDisc || (disciplineFilter ? disciplineFilter.value : "ALL")).trim().toUpperCase();
      switch (disc) {
        case "NONE":
          statTotalLabel.textContent = "Non-Discipline Contacts";
          break;
        case "PT":
          statTotalLabel.textContent = "Physical Therapists (PT)";
          break;
        case "PTA":
          statTotalLabel.textContent = "PT Assistants (PTA)";
          break;
        case "OT":
          statTotalLabel.textContent = "Occupational Therapists (OT)";
          break;
        case "COTA":
          statTotalLabel.textContent = "OT Assistants (COTA)";
          break;
        case "ST":
          statTotalLabel.textContent = "Speech Therapists (ST)";
          break;
        case "STA":
          statTotalLabel.textContent = "Speech Assistants (STA)";
          break;
        case "MSW":
          statTotalLabel.textContent = "Social Workers (MSW)";
          break;
        default:
          statTotalLabel.textContent = "Active Therapists";
          break;
      }
    }

    const ptCount = targetList.filter((t) => {
      const d = (t.discipline || "").toUpperCase();
      return matchDisciplineCode(d, "PT") || matchDisciplineCode(d, "PTA");
    }).length;
    if (statPt) statPt.textContent = ptCount;

    const otCount = targetList.filter((t) => {
      const d = (t.discipline || "").toUpperCase();
      return matchDisciplineCode(d, "OT") || matchDisciplineCode(d, "COTA");
    }).length;
    if (statOt) statOt.textContent = otCount;

    // ST count strictly excludes STA / Speech Assistant
    const stCount = targetList.filter((t) => {
      const d = (t.discipline || "").toUpperCase();
      return matchDisciplineCode(d, "ST");
    }).length;
    if (statSt) statSt.textContent = stCount;
  }

  function applyFilters() {
    const selectedDisc = disciplineFilter ? disciplineFilter.value.trim().toUpperCase() : "ALL";
    const selectedRole = roleFilter ? roleFilter.value.trim().toUpperCase() : "ALL";
    const query = searchInput ? searchInput.value.trim() : "";

    currentFiltered = displayedTherapists.filter((t) => {
      const isStatusActive = (t.status || "").trim().toLowerCase() === "active";
      if (!isStatusActive) return false;

      const role = resolveRole(t).toUpperCase();

      const matchesRole =
        selectedRole === "ALL" ||
        ((selectedRole === "THERAPIST" || selectedRole === "SUPERVISOR") && (role.includes("SUPERVISOR") || role.includes("THERAPIST"))) ||
        (selectedRole === "ASSISTANT" && role.includes("ASSISTANT"));

      let matchesDisc = matchDisciplineCode(t.discipline, selectedDisc);
      if (selectedDisc === "NONE" && Array.isArray(t.disciplines) && t.disciplines.length > 0) {
        const hasValidDiscipline = t.disciplines.some((d) => {
          const s = String(d || "").trim().toUpperCase();
          return s && s !== "â€”" && s !== "-" && s !== "NONE" && s !== "N/A" && s !== "NULL";
        });
        if (hasValidDiscipline) {
          matchesDisc = false;
        }
      }

      let matchesText = true;
      if (query) {
        if (!hasAvailableDiscipline(t)) {
          return false;
        }
        matchesText = matchesSearchText(t, query);
      }

      return matchesRole && matchesDisc && matchesText;
    });

    currentPage = 1;
    renderCurrentPage();
    updateStats(currentFiltered, selectedDisc);
  }

  // -------------------------------------------------------------
  // TASK 2: GLOBAL SEARCH LOGIC (ACROSS ALL AGENCIES)
  // -------------------------------------------------------------

  async function performGlobalSearch(query) {
    const q = (query !== undefined ? query : (searchInput ? searchInput.value.trim() : "")).trim();

    if (!q) {
      resetSearch();
      return;
    }

    const selectedDisc = disciplineFilter ? disciplineFilter.value.trim().toUpperCase() : "ALL";

    // Cancel any previous pending search and track this sequence
    const searchSeq = ++currentSearchSeq;
    if (currentSearchAbortController) {
      try {
        currentSearchAbortController.abort();
      } catch (e) {}
    }
    currentSearchAbortController = new AbortController();

    if (tableLoading) tableLoading.hidden = false;
    if (tableEmpty) tableEmpty.hidden = true;
    if (tableWrapper) tableWrapper.hidden = true;

    try {
      const detectedDisc = detectDisciplineQuery(q);
      let url = `${API_THERAPISTS}?search=${encodeURIComponent(q)}`;
      if (detectedDisc) {
        url += `&discipline=${encodeURIComponent(detectedDisc)}`;
      }

      const response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: currentSearchAbortController.signal,
      });

      // Ignore late/stale responses
      if (searchSeq !== currentSearchSeq) {
        return;
      }

      if (!response.ok) {
        throw new Error("Global search request failed");
      }

      const data = await response.json();

      // Check again if query changed while parsing JSON
      if (searchSeq !== currentSearchSeq) {
        return;
      }

      const rawTherapists = deduplicateTherapists(data.therapists || []);

      displayedTherapists = rawTherapists
        .filter((t) => (t.status || "").trim().toLowerCase() === "active")
        .filter((t) => hasAvailableDiscipline(t))
        .map((t) => {
          t.role = resolveRole(t);
          return t;
        });

      // Merge any matching agency therapists so agency therapists are always included
      const activeDiscFilter = detectedDisc || ((selectedDisc && selectedDisc !== "ALL" && selectedDisc !== "NONE") ? selectedDisc : null);
      if (allAgencyTherapists.length > 0) {
        const agencyMatches = allAgencyTherapists.filter((t) => {
          if (!hasAvailableDiscipline(t)) return false;
          const mDisc = activeDiscFilter ? matchDisciplineCode(t.discipline, activeDiscFilter) : true;
          const mText = q ? matchesSearchText(t, q) : true;
          return mDisc && mText;
        });
        if (agencyMatches.length > 0) {
          displayedTherapists = deduplicateTherapists([...agencyMatches, ...displayedTherapists]);
        }
      }

      isGlobalSearchActive = true;

      if (searchGlobalIndicator && searchGlobalText) {
        searchGlobalIndicator.hidden = false;
        let noticeText = `Showing <strong>${displayedTherapists.length}</strong> therapists across <strong>all agencies</strong>`;
        if (detectedDisc) {
          noticeText += ` with discipline <strong>${escapeHtml(detectedDisc)}</strong>`;
        }
        if (q && q.toUpperCase() !== detectedDisc) {
          noticeText += ` for <em>"${escapeHtml(q)}"</em>`;
        }
        searchGlobalText.innerHTML = noticeText;
      }

      updateStats(displayedTherapists);
      applyFilters();
    } catch (err) {
      if (err.name === "AbortError" || searchSeq !== currentSearchSeq) {
        return; // Silently ignore superseded search requests
      }
      console.error("[Global Search Error]", err);
      // Fallback: search in-memory agency therapists
      displayedTherapists = deduplicateTherapists([...allAgencyTherapists]);
      isGlobalSearchActive = false;
      updateStats(displayedTherapists);
      applyFilters();
      showAlert("error", "Failed to search therapists across agencies: " + err.message);
    } finally {
      if (searchSeq === currentSearchSeq && tableLoading) {
        tableLoading.hidden = true;
      }
    }
  }

  function setSearchScope(newScope, triggerSearch = true) {
    if (newScope !== "agency" && newScope !== "global") return;
    searchScope = newScope;

    const isGlobal = searchScope === "global";
    if (searchScopeToggle) {
      searchScopeToggle.checked = isGlobal;
    }

    if (scopeLabelAgency) {
      scopeLabelAgency.classList.toggle("is-active", !isGlobal);
    }
    if (scopeLabelGlobal) {
      scopeLabelGlobal.classList.toggle("is-active", isGlobal);
    }

    if (searchInput) {
      searchInput.placeholder = isGlobal
        ? "Search all therapists globally by name, discipline, email, cityâ€¦"
        : "Search agency therapists by name, discipline, email, phoneâ€¦";
    }

    if (!triggerSearch) return;

    const query = searchInput ? searchInput.value.trim() : "";

    if (isGlobal) {
      if (query) {
        performGlobalSearch(query);
      } else {
        displayedTherapists = [...allAgencyTherapists];
        isGlobalSearchActive = false;
        if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
        updateStats(displayedTherapists);
        applyFilters();
      }
    } else {
      // Switching to Agency search: strictly agency records
      if (currentSearchAbortController) {
        try {
          currentSearchAbortController.abort();
        } catch (e) {}
        currentSearchAbortController = null;
      }
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      displayedTherapists = [...allAgencyTherapists];
      isGlobalSearchActive = false;
      if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
      if (tableLoading) tableLoading.hidden = true;
      updateStats(displayedTherapists);
      applyFilters();
    }
  }

  function handleSearchInput() {
    const query = searchInput ? searchInput.value.trim() : "";

    if (searchClearBtn) {
      searchClearBtn.hidden = !query;
    }

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }

    if (!query) {
      currentSearchSeq++;
      if (currentSearchAbortController) {
        try {
          currentSearchAbortController.abort();
        } catch (e) {}
        currentSearchAbortController = null;
      }
      // Restore logged-in agency therapists and assistants
      displayedTherapists = [...allAgencyTherapists];
      isGlobalSearchActive = false;
      if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
      if (tableLoading) tableLoading.hidden = true;
      updateStats(displayedTherapists);
      applyFilters();
      return;
    }

    if (searchScope === "global") {
      // Instant local preview
      applyFilters();

      // Debounce global server search across ALL agencies by 400ms
      searchDebounceTimer = setTimeout(() => {
        performGlobalSearch(query);
      }, 400);
    } else {
      // Agency Search: Search ONLY records of the logged-in agency
      if (currentSearchAbortController) {
        try {
          currentSearchAbortController.abort();
        } catch (e) {}
        currentSearchAbortController = null;
      }
      displayedTherapists = [...allAgencyTherapists];
      isGlobalSearchActive = false;
      if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
      if (tableLoading) tableLoading.hidden = true;
      applyFilters();
    }
  }

  function resetSearch() {
    currentSearchSeq++;
    if (currentSearchAbortController) {
      try {
        currentSearchAbortController.abort();
      } catch (e) {}
      currentSearchAbortController = null;
    }
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (searchInput) searchInput.value = "";
    if (searchClearBtn) searchClearBtn.hidden = true;
    if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
    if (tableLoading) tableLoading.hidden = true;
    displayedTherapists = [...allAgencyTherapists];
    isGlobalSearchActive = false;
    updateStats(displayedTherapists);
    applyFilters();
  }

  async function loadAgencyInfo() {
    try {
      const res = await fetch(API_ME, { credentials: "include" });
      if (res.status === 401 || res.status === 403) {
        window.location.href = "index.html?error=" + encodeURIComponent("Please sign in to continue");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.agency?.agencyName) {
        currentAgencyName = data.agency.agencyName;
      } else if (data.user?.displayName) {
        currentAgencyName = data.user.displayName;
      }
    } catch (e) {
      console.warn("Failed to load agency session", e);
    }
  }

  async function loadTherapists() {
    if (tableLoading) tableLoading.hidden = false;
    if (tableError) tableError.hidden = true;
    if (tableEmpty) tableEmpty.hidden = true;
    if (tableWrapper) tableWrapper.hidden = true;
    if (paginationContainer) paginationContainer.hidden = true;
    if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;

    if (refreshBtn) refreshBtn.classList.add("loading");

    try {
      const response = await fetch(API_THERAPISTS, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (response.status === 401 || response.status === 403) {
        window.location.href = "index.html?error=" + encodeURIComponent("Please sign in to continue");
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Unable to load therapist records");
      }

      const data = await response.json();
      if (data.agencyName) {
        currentAgencyName = data.agencyName;
      }

      const rawTherapists = deduplicateTherapists(data.therapists || []);
      allAgencyTherapists = rawTherapists
        .filter((t) => (t.status || "").trim().toLowerCase() === "active")
        .map((t) => {
          t.role = resolveRole(t);
          if (!t.agencyName && currentAgencyName) {
            t.agencyName = currentAgencyName;
          }
          return t;
        });
      displayedTherapists = [...allAgencyTherapists];
      isGlobalSearchActive = false;

      updateStats(displayedTherapists);
      applyFilters();
    } catch (err) {
      if (tableError) tableError.hidden = false;
      if (errorMessage) errorMessage.textContent = err.message || "Failed to load therapist records";
    } finally {
      if (tableLoading) tableLoading.hidden = true;
      if (refreshBtn) refreshBtn.classList.remove("loading");
    }
  }

  function formatCredentialsResponseAlert(payload) {
    // ── Helpers ─────────────────────────────────────────────────────────────
    function resolveTherapistName(t) {
      if (t.name && t.name !== "Unknown Therapist" && t.name !== "Therapist") return t.name;
      const match = displayedTherapists.find((item) => String(item.id) === String(t.id));
      return match ? match.name : (t.name || "Therapist");
    }

    function makeSuccessHtml(msg) {
      return `
        <div class="toast-section">
          <div class="toast-header-row" style="align-items: flex-start; gap: 0.65rem;">
            <span class="toast-header-icon toast-header-icon-success" style="margin-top: 2px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="16 9 10 15 7 12"></polyline></svg>
            </span>
            <div style="display: flex; flex-direction: column; gap: 0.25rem;">
              <span class="toast-header-title" style="font-weight: 600; font-size: 0.92rem; line-height: 1.45; color: #1e293b;">${escapeHtml(msg)}</span>
            </div>
          </div>
        </div>`;
    }

    function makeWarningHtml(msg) {
      return `
        <div class="toast-section">
          <div class="toast-header-row" style="align-items: flex-start; gap: 0.65rem;">
            <span class="toast-header-icon toast-header-icon-error" style="margin-top: 2px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </span>
            <div style="display: flex; flex-direction: column; gap: 0.35rem;">
              <span class="toast-header-title" style="font-weight: 600; font-size: 0.92rem; line-height: 1.45; color: #1e293b;">${escapeHtml(msg)}</span>
            </div>
          </div>
        </div>`;
    }

    function makeErrorHtml(msg) {
      return `
        <div class="toast-section">
          <div class="toast-header-row" style="align-items: flex-start; gap: 0.65rem;">
            <span class="toast-header-icon toast-header-icon-error" style="margin-top: 2px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </span>
            <div style="display: flex; flex-direction: column; gap: 0.35rem;">
              <span class="toast-header-title" style="font-weight: 600; font-size: 0.92rem; line-height: 1.45; color: #1e293b;">${escapeHtml(msg)}</span>
            </div>
          </div>
        </div>`;
    }

    // ── Map new API response shape ──────────────────────────────────────────
    // New API shape: { ok, success, send_status, message,
    //   sentTherapists[], unconfirmedTherapists[], missingTherapists[] }
    const sentTherapists        = Array.isArray(payload.sentTherapists)        ? payload.sentTherapists        : [];
    const unconfirmedTherapists = Array.isArray(payload.unconfirmedTherapists) ? payload.unconfirmedTherapists : [];
    const missingTherapists     = Array.isArray(payload.missingTherapists)     ? payload.missingTherapists     : [];

    // Also support legacy credentialCheck shape for backwards compatibility
    const check = payload.credentialCheck;
    if (check) {
      if (Array.isArray(check.availableTherapists)) sentTherapists.push(...check.availableTherapists);
      if (Array.isArray(check.missingTherapists))   missingTherapists.push(...check.missingTherapists);
    }

    const sentNames        = sentTherapists.map(resolveTherapistName).join(", ");
    const unconfirmedNames = unconfirmedTherapists.map(resolveTherapistName).join(", ");
    const missingNames     = missingTherapists.map(resolveTherapistName).join(", ");

    // ── Determine status ────────────────────────────────────────────────────
    const legacyStatus = payload.credentialStatus || payload.status || "";
    const sendStatus   = (payload.send_status || "").toLowerCase();
    const isOk         = payload.ok === true || payload.success === true;

    // Hard errors (legacy)
    if (legacyStatus === "ERROR") {
      return {
        type: "error",
        isHtml: false,
        duration: 14000,
        content: payload.credentialMessage || payload.message || "Unable to verify credential documents.",
      };
    }

    // No documents found (legacy)
    if (legacyStatus === "NO_DOCUMENTS") {
      const msg = payload.credentialMessage || payload.message ||
        (missingTherapists.length === 1
          ? `The credential document for ${missingNames} is currently unavailable. Our team has been notified.`
          : `The credential documents for ${missingNames} are currently unavailable. Our team has been notified.`);
      return { type: "error", isHtml: true, duration: 14000, content: makeErrorHtml(msg) };
    }

    // Partial success (legacy)
    if (legacyStatus === "PARTIAL_SUCCESS") {
      const agencyName = payload.agencyName || "Agency";
      const msg = payload.credentialMessage || payload.message ||
        `Email sent for ${agencyName}: ${sentNames}. No documents found for: ${missingNames}.`;
      return { type: "warning", isHtml: true, duration: 14000, content: makeWarningHtml(msg) };
    }

    // Fully confirmed sent (legacy SUCCESS, or new shape with sentTherapists populated)
    if (legacyStatus === "SUCCESS" ||
        (sentTherapists.length > 0 && unconfirmedTherapists.length === 0 && missingTherapists.length === 0)) {
      const msg = payload.credentialMessage || payload.message ||
        `Credentials sent successfully for: ${sentNames || "selected therapist(s)"}.`;
      return { type: "success", isHtml: true, duration: 9000, content: makeSuccessHtml(msg) };
    }

    // Submitted to CRM automation — processing, not yet confirmed (new API: send_status = "submitted")
    if (sendStatus === "submitted" || (isOk && unconfirmedTherapists.length > 0)) {
      const names = unconfirmedNames || missingNames || "selected therapist(s)";
      const msg = payload.message ||
        `Credential request submitted for: ${names}. The email will be delivered shortly once the automation completes.`;
      return { type: "success", isHtml: true, duration: 10000, content: makeSuccessHtml(msg) };
    }

    // Sent with some missing
    if (sentTherapists.length > 0 && missingTherapists.length > 0) {
      const msg = payload.message ||
        `Credentials sent for: ${sentNames}. No documents found for: ${missingNames}.`;
      return { type: "warning", isHtml: true, duration: 14000, content: makeWarningHtml(msg) };
    }

    // Generic success when ok/success = true but no specific shape matched
    if (isOk) {
      const msg = payload.credentialMessage || payload.message || "Credential request submitted successfully.";
      return { type: "success", isHtml: true, duration: 9000, content: makeSuccessHtml(msg) };
    }

    // Final error fallback
    return {
      type: "error",
      isHtml: false,
      duration: 8000,
      content: payload.credentialMessage || payload.message || "Unable to complete the credential request.",
    };
  }
  async function handleSendCredentials() {
    if (selectedTherapistIds.size === 0) {
      showAlert("error", "Please select at least one therapist to send credentials.");
      return;
    }

    const therapistIds = Array.from(selectedTherapistIds);

    if (sendCredentialsBtn) {
      sendCredentialsBtn.disabled = true;
      const btnSpan = sendCredentialsBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "Sending";
    }

    hideAlert();

    try {
      const res = await fetch(API_SEND_CREDENTIALS, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ therapistIds }),
      });

      const payload = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        window.location.href = "index.html?error=" + encodeURIComponent("Please sign in to continue");
        return;
      }

      if (!res.ok) {
        throw new Error(payload.message || `Server returned error status ${res.status}`);
      }

      const alertInfo = formatCredentialsResponseAlert(payload);
      showAlert(alertInfo.type, alertInfo.content, alertInfo.isHtml, alertInfo.duration);

      const sendStatus = String(payload.send_status || "").toLowerCase();
      if (sendStatus === "all" || sendStatus === "partial") {
        selectedTherapistIds.clear();
        updateSelectionUI();
      }
    } catch (err) {
      showAlert("error", err.message || "An error occurred while sending credentials.");
    } finally {
      if (sendCredentialsBtn) {
        const btnSpan = sendCredentialsBtn.querySelector("span");
        if (btnSpan) btnSpan.textContent = "Send Credentials";
        updateSelectionUI();
      }
    }
  }

  // Event Listeners
  if (searchInput) {
    searchInput.addEventListener("input", handleSearchInput);
  }

  if (searchClearBtn) {
    searchClearBtn.addEventListener("click", resetSearch);
  }

  if (resetGlobalSearchBtn) {
    resetGlobalSearchBtn.addEventListener("click", () => {
      setSearchScope("agency", false);
      resetSearch();
    });
  }

  // Search Scope Toggle events (Agency Search vs Global Search)
  if (searchScopeToggle) {
    searchScopeToggle.addEventListener("change", (e) => {
      setSearchScope(e.target.checked ? "global" : "agency");
    });
  }

  if (scopeLabelAgency) {
    scopeLabelAgency.addEventListener("click", () => {
      setSearchScope("agency");
    });
    scopeLabelAgency.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSearchScope("agency");
      }
    });
  }

  if (scopeLabelGlobal) {
    scopeLabelGlobal.addEventListener("click", () => {
      setSearchScope("global");
    });
    scopeLabelGlobal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSearchScope("global");
      }
    });
  }

  if (roleFilter) {
    roleFilter.addEventListener("change", applyFilters);
  }

  if (disciplineFilter) {
    disciplineFilter.addEventListener("change", () => {
      if (searchScope === "global" && searchInput && searchInput.value.trim()) {
        performGlobalSearch(searchInput.value.trim());
      } else {
        if (isGlobalSearchActive && searchScope !== "global") {
          displayedTherapists = [...allAgencyTherapists];
          isGlobalSearchActive = false;
          if (searchGlobalIndicator) searchGlobalIndicator.hidden = true;
        }
        applyFilters();
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      resetSearch();
      loadTherapists();
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", loadTherapists);
  }

  if (sendCredentialsBtn) {
    sendCredentialsBtn.addEventListener("click", handleSendCredentials);
  }

  if (actionAlert) {
    actionAlert.addEventListener("click", (e) => {
      if (e.target === actionAlert) hideAlert();
    });
  }

  if (actionAlertClose) {
    actionAlertClose.addEventListener("click", hideAlert);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && actionAlert && !actionAlert.hidden) {
      hideAlert();
    }
  });

  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener("change", (e) => {
      const pageTherapists = getCurrentPageTherapists();
      if (e.target.checked) {
        pageTherapists.forEach((t) => selectedTherapistIds.add(t.id));
      } else {
        pageTherapists.forEach((t) => selectedTherapistIds.delete(t.id));
      }
      updateSelectionUI();
    });
  }

  if (firstPageBtn) firstPageBtn.addEventListener("click", () => goToPage(1));
  if (prevPageBtn) prevPageBtn.addEventListener("click", () => goToPage(currentPage - 1));
  if (nextPageBtn) nextPageBtn.addEventListener("click", () => goToPage(currentPage + 1));
  if (lastPageBtn) {
    lastPageBtn.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(currentFiltered.length / pageSize));
      goToPage(totalPages);
    });
  }

  function handlePageSizeChange(newSize) {
    const parsed = parseInt(newSize, 10);
    if (!parsed || parsed <= 0) return;
    pageSize = parsed;
    if (pageSizeFilter && pageSizeFilter.value !== String(pageSize)) {
      pageSizeFilter.value = String(pageSize);
    }
    if (pageSizeSelect && pageSizeSelect.value !== String(pageSize)) {
      pageSizeSelect.value = String(pageSize);
    }
    currentPage = 1;
    renderCurrentPage();
  }

  if (pageSizeFilter) {
    pageSizeFilter.addEventListener("change", (e) => handlePageSizeChange(e.target.value));
  }
  if (pageSizeSelect) {
    pageSizeSelect.addEventListener("change", (e) => handlePageSizeChange(e.target.value));
  }

  // Column Visibility Handlers
  function loadColumnVisibility() {
    columnVisibility = {};
    COLUMN_DEFINITIONS.forEach((c) => {
      columnVisibility[c.key] = c.defaultVisible !== false;
    });

    try {
      const saved = localStorage.getItem(STORAGE_KEY_COLUMNS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          COLUMN_DEFINITIONS.forEach((c) => {
            if (typeof parsed[c.key] === "boolean") {
              columnVisibility[c.key] = parsed[c.key];
            }
          });
        }
      }
    } catch (e) {
      console.warn("Failed to read column visibility preference:", e);
    }
  }

  function saveColumnVisibility() {
    try {
      localStorage.setItem(STORAGE_KEY_COLUMNS, JSON.stringify(columnVisibility));
    } catch (e) {
      console.warn("Failed to save column visibility preference:", e);
    }
  }

  function applyColumnVisibility() {
    if (!tableWrapper) return;
    COLUMN_DEFINITIONS.forEach((c) => {
      const isVisible = columnVisibility[c.key] !== false;
      tableWrapper.classList.toggle(`col-hide-${c.key}`, !isVisible);
    });
  }

  function renderColumnVisibilityMenu() {
    if (!colVisMenuList) return;
    colVisMenuList.innerHTML = COLUMN_DEFINITIONS.map((col) => {
      const isChecked = columnVisibility[col.key] !== false;
      return `
        <label class="col-toggle-item" for="col-toggle-${col.key}">
          <span class="col-toggle-label">${escapeHtml(col.label)}</span>
          <div class="toggle-switch">
            <input
              type="checkbox"
              id="col-toggle-${col.key}"
              data-col-key="${col.key}"
              ${isChecked ? "checked" : ""}
            />
            <span class="toggle-slider"></span>
          </div>
        </label>
      `;
    }).join("");

    colVisMenuList.querySelectorAll("input[data-col-key]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const key = e.target.getAttribute("data-col-key");
        columnVisibility[key] = e.target.checked;
        saveColumnVisibility();
        applyColumnVisibility();
      });
    });
  }

  function toggleColumnVisibilityMenu(forceOpen) {
    if (!colVisMenu || !colVisBtn) return;
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : colVisMenu.hidden;
    colVisMenu.hidden = !shouldOpen;
    colVisBtn.setAttribute("aria-expanded", String(shouldOpen));
  }

  function resetAllColumns() {
    COLUMN_DEFINITIONS.forEach((c) => {
      columnVisibility[c.key] = c.defaultVisible !== false;
    });
    saveColumnVisibility();
    applyColumnVisibility();
    renderColumnVisibilityMenu();
  }

  if (colVisBtn) {
    colVisBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleColumnVisibilityMenu();
    });
  }

  if (colVisResetBtn) {
    colVisResetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetAllColumns();
    });
  }

  if (colVisMenu) {
    colVisMenu.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  document.addEventListener("click", (e) => {
    if (colVisMenu && !colVisMenu.hidden) {
      if (!colVisMenu.contains(e.target) && !colVisBtn.contains(e.target)) {
        toggleColumnVisibilityMenu(false);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && colVisMenu && !colVisMenu.hidden) {
      toggleColumnVisibilityMenu(false);
    }
  });

  // Initialize
  setSearchScope("agency", false);
  window.addEventListener("pageshow", () => {
    setSearchScope("agency", false);
  });
  loadColumnVisibility();
  applyColumnVisibility();
  renderColumnVisibilityMenu();
  loadAgencyInfo();
  loadTherapists();
})();