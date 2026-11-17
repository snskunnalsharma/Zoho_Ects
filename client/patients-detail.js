(function () {
  const API_ME = "/server/agency_api/api/me";
  const API_PATIENTS = "/server/agency_api/api/patients";
  const DEFAULT_PAGE_SIZE = 10;
  let pageSize = DEFAULT_PAGE_SIZE;

  const tableLoading = document.getElementById("table-loading");
  const tableError = document.getElementById("table-error");
  const tableEmpty = document.getElementById("table-empty");
  const tableWrapper = document.getElementById("table-wrapper");
  const tbody = document.getElementById("patients-tbody");
  const errorMessage = document.getElementById("error-message");

  const statTotal = document.getElementById("stat-total");
  const statPending = document.getElementById("stat-pending");
  const statActive = document.getElementById("stat-active");

  const searchInput = document.getElementById("search-input");
  const stageFilter = document.getElementById("stage-filter");
  const pageSizeFilter = document.getElementById("page-size-filter");
  const refreshBtn = document.getElementById("refresh-btn");
  const retryBtn = document.getElementById("retry-btn");

  // Pagination elements
  const paginationContainer = document.getElementById("pagination-container");
  const pageStart = document.getElementById("page-start");
  const pageEnd = document.getElementById("page-end");
  const pageTotalCount = document.getElementById("page-total-count");
  const paginationPages = document.getElementById("pagination-pages");
  const firstPageBtn = document.getElementById("first-page-btn");
  const prevPageBtn = document.getElementById("prev-page-btn");
  const nextPageBtn = document.getElementById("next-page-btn");
  const lastPageBtn = document.getElementById("last-page-btn");

  let allPatients = [];
  let currentFiltered = [];
  let currentPage = 1;

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val || "—";
  }

  function formatDate(isoStr) {
    if (!isoStr || isoStr === "—") return "—";
    try {
      const parts = isoStr.split("-");
      if (parts.length === 3) {
        const [year, month, day] = parts;
        const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      }
      return isoStr;
    } catch {
      return isoStr;
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderTableRows(patients) {
    if (!tbody) return;
    tbody.innerHTML = patients
      .map((p) => {
        const stageClass =
          p.stage?.toLowerCase() === "pending"
            ? "badge-pending"
            : p.stage?.toLowerCase() === "active"
            ? "badge-active"
            : p.stage?.toLowerCase().includes("approved")
            ? "badge-approved"
            : "badge-default";

        const certRange =
          p.startCert !== "—" || p.lastCert !== "—"
            ? `${formatDate(p.startCert)} &rarr; ${formatDate(p.lastCert)}`
            : "—";

        return `
          <tr>
            <td>
              <div class="patient-name-cell">
                <div class="patient-avatar">${escapeHtml(p.patientName.charAt(0).toUpperCase())}</div>
                <div>
                  <div class="patient-name">${escapeHtml(p.patientName)}</div>
                  
                </div>
              </div>
            </td>
            <td>
              <div><strong>${formatDate(p.dob)}</strong></div>
              <div class="patient-sub">${escapeHtml(p.gender)}</div>
            </td>
            <td>
              <span class="phone-link">${escapeHtml(p.phone)}</span>
            </td>
            <td class="address-cell">
              <span>${escapeHtml(p.street)}</span>
            </td>
            <td class="cert-cell">
              <span>${certRange}</span>
            </td>
            <td>
              <span class="status-badge ${stageClass}">${escapeHtml(p.stage)}</span>
            </td>
          </tr>
        `;
      })
      .join("");
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
          ellipsis.textContent = "…";
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

    const pages = [];
    pages.push(1);

    if (current > 3) {
      pages.push("...");
    }

    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (current < total - 2) {
      pages.push("...");
    }

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
      return;
    }

    if (tableEmpty) tableEmpty.hidden = true;
    tableWrapper.hidden = false;

    const startIndex = (currentPage - 1) * pageSize;
    const pagePatients = currentFiltered.slice(startIndex, startIndex + pageSize);

    renderTableRows(pagePatients);
    renderPagination(currentFiltered.length);
  }

  function updateStats(patients) {
    if (statTotal) statTotal.textContent = patients.length;
    const pendingCount = patients.filter((p) => p.stage?.toLowerCase() === "pending").length;
    if (statPending) statPending.textContent = pendingCount;
    const activeCount = patients.filter(
      (p) => p.stage?.toLowerCase() === "active" || (p.lastCert && p.lastCert !== "—")
    ).length;
    if (statActive) statActive.textContent = activeCount;
  }

  function applyFilters() {
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const selectedStage = stageFilter ? stageFilter.value : "ALL";

    currentFiltered = allPatients.filter((p) => {
      const matchesStage =
        selectedStage === "ALL" ||
        p.stage?.toLowerCase() === selectedStage.toLowerCase();

      const matchesQuery =
        !query ||
        p.patientName?.toLowerCase().includes(query) ||
        p.phone?.toLowerCase().includes(query) ||
        p.street?.toLowerCase().includes(query) ||
        p.id?.toLowerCase().includes(query);

      return matchesStage && matchesQuery;
    });

    currentPage = 1;
    renderCurrentPage();
  }

  async function loadAgencyInfo() {
    try {
      const res = await fetch(API_ME, { credentials: "include" });
      if (res.status === 401 || res.status === 403) {
        window.location.href = "index.html?error=" + encodeURIComponent("Please sign in to continue");
        return;
      }
      if (res.ok) {
        const data = await res.json();
        const agency = data.agency || {};
        setText("field-agency-name", agency.agencyName || agency.name);
        setText("field-portal-email", agency.portalAccessEmail || agency.email);
      }
    } catch (e) {
      console.warn("Failed to load agency details", e);
    }
  }

  async function loadPatients() {
    if (tableLoading) tableLoading.hidden = false;
    if (tableError) tableError.hidden = true;
    if (tableEmpty) tableEmpty.hidden = true;
    if (tableWrapper) tableWrapper.hidden = true;
    if (paginationContainer) paginationContainer.hidden = true;

    if (refreshBtn) {
      refreshBtn.classList.add("loading");
    }

    try {
      const response = await fetch(API_PATIENTS, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (response.status === 401 || response.status === 403) {
        window.location.href = "index.html?error=" + encodeURIComponent("Please sign in to continue");
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Unable to load patient records");
      }

      const data = await response.json();
      allPatients = data.patients || [];

      updateStats(allPatients);
      applyFilters();
    } catch (err) {
      if (tableError) tableError.hidden = false;
      if (errorMessage) errorMessage.textContent = err.message || "Failed to load patient records";
    } finally {
      if (tableLoading) tableLoading.hidden = true;
      if (refreshBtn) {
        refreshBtn.classList.remove("loading");
      }
    }
  }

  // Events
  if (searchInput) {
    searchInput.addEventListener("input", applyFilters);
  }

  if (stageFilter) {
    stageFilter.addEventListener("change", applyFilters);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadPatients);
  }

  if (retryBtn) {
    retryBtn.addEventListener("click", loadPatients);
  }

  if (firstPageBtn) {
    firstPageBtn.addEventListener("click", () => goToPage(1));
  }

  if (prevPageBtn) {
    prevPageBtn.addEventListener("click", () => goToPage(currentPage - 1));
  }

  if (nextPageBtn) {
    nextPageBtn.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(currentFiltered.length / pageSize));
      goToPage(currentPage + 1);
    });
  }

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
    currentPage = 1;
    renderCurrentPage();
  }

  if (pageSizeFilter) {
    pageSizeFilter.addEventListener("change", (e) => handlePageSizeChange(e.target.value));
  }

  // Initialize
  loadAgencyInfo();
  loadPatients();
})();
