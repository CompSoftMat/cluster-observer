const summaryNode = document.getElementById("summary");
const clusterNavNode = document.getElementById("cluster-nav");
const clustersNode = document.getElementById("clusters");
const lastUpdatedNode = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const dashboardTitleNode = document.getElementById("dashboard-title");

const PAGE_SIZE = 40;
const FACET_PREVIEW_LIMIT = 10;
const FILTER_KEYS = ["user", "queue", "state", "project"];
const STATE_ORDER = { R: 0, Q: 1, H: 2 };

let refreshHandle = null;
let activeClusterName = null;
const clusterViewState = {};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stateClass(state) {
  const normalized = (state || "").toUpperCase();
  if (normalized === "R") {
    return "job-state running";
  }
  if (normalized === "Q") {
    return "job-state queued";
  }
  if (normalized === "H") {
    return "job-state held";
  }
  return "job-state";
}

function ensureViewState(clusterName) {
  if (!clusterViewState[clusterName]) {
    clusterViewState[clusterName] = {
      selectedPreset: "",
      user: "",
      queue: "",
      state: "",
      project: "",
      search: "",
      sortKey: "submitted_at",
      sortDirection: "asc",
      page: 1,
    };
  }
  return clusterViewState[clusterName];
}

function renderSummary(payload) {
  summaryNode.innerHTML = "";
  const stats = [
    ["Clusters OK", `${payload.ok_clusters} / ${payload.total_clusters}`],
    ["Tracked Jobs", String(payload.total_jobs)],
    ["Refresh Every", `${payload.refresh_seconds}s`],
  ];

  for (const [label, value] of stats) {
    const card = document.createElement("article");
    card.className = "stat";
    card.innerHTML = `<span class="stat-label">${label}</span><span class="stat-value">${value}</span>`;
    summaryNode.appendChild(card);
  }
}

function renderFilterChips(filters) {
  const entries = Object.entries(filters || {});
  if (!entries.length) {
    return `<span class="filter-chip">all jobs</span>`;
  }
  return entries
    .map(([key, values]) => `<span class="filter-chip">${escapeHtml(key)}: ${escapeHtml(values.join(", "))}</span>`)
    .join("");
}

function clusterTab(cluster, isActive) {
  const statusClass = cluster.ok ? "status-pill" : "status-pill error";
  return `
    <button class="cluster-tab${isActive ? " active" : ""}" type="button" data-cluster-name="${escapeHtml(cluster.cluster)}">
      <div class="cluster-tab-head">
        <span class="cluster-tab-name">${escapeHtml(cluster.cluster)}</span>
        <span class="${statusClass}">${cluster.ok ? "ok" : "error"}</span>
      </div>
      <div class="cluster-tab-meta">
        <span>${cluster.job_count} jobs</span>
        <span>${cluster.duration_seconds}s</span>
      </div>
    </button>
  `;
}

function sortCountItems(items) {
  return [...(items || [])].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return String(left.value).localeCompare(String(right.value));
  });
}

function optionMarkup(label, items, selectedValue) {
  return `
    <option value="">All ${escapeHtml(label)}</option>
    ${sortCountItems(items)
      .map(item => `<option value="${escapeHtml(item.value)}"${item.value === selectedValue ? " selected" : ""}>${escapeHtml(item.value)} (${item.count})</option>`)
      .join("")}
  `;
}

function jobMatchesFilterMap(job, filters) {
  for (const [key, allowedValues] of Object.entries(filters || {})) {
    const jobValue = job[key] || "";
    if (!allowedValues.includes(jobValue)) {
      return false;
    }
  }
  return true;
}

function jobMatchesView(job, viewState, presetFilters) {
  if (!jobMatchesFilterMap(job, presetFilters)) {
    return false;
  }
  for (const key of FILTER_KEYS) {
    const selectedValue = viewState[key];
    if (!selectedValue) {
      continue;
    }
    const jobValue = key === "state" ? (job[key] || "").toUpperCase() : (job[key] || "");
    const expectedValue = key === "state" ? selectedValue.toUpperCase() : selectedValue;
    if (jobValue !== expectedValue) {
      return false;
    }
  }
  const search = (viewState.search || "").trim().toLowerCase();
  if (!search) {
    return true;
  }
  const haystack = [
    job.job_id,
    job.user,
    job.queue,
    job.project,
    job.state,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function numericValue(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueForSort(job, sortKey) {
  if (sortKey === "gpu") {
    return numericValue(job.gpu);
  }
  if (sortKey === "state") {
    const normalized = (job.state || "").toUpperCase();
    return STATE_ORDER[normalized] ?? 9;
  }
  return job[sortKey] || "";
}

function compareJobs(left, right, sortKey, sortDirection) {
  const leftValue = valueForSort(left, sortKey);
  const rightValue = valueForSort(right, sortKey);
  let result = 0;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    result = leftValue - rightValue;
  } else {
    result = String(leftValue).localeCompare(String(rightValue));
  }
  if (result === 0) {
    result = (left.job_id || "").localeCompare(right.job_id || "");
  }
  return sortDirection === "desc" ? -result : result;
}

function filteredJobs(cluster, viewState) {
  const preset = (cluster.job_groups || []).find(group => group.name === viewState.selectedPreset);
  const presetFilters = preset?.filters || {};
  return cluster.jobs.filter(job => jobMatchesView(job, viewState, presetFilters));
}

function summaryCard(label, value, accent = "") {
  return `
    <article class="cluster-stat${accent ? ` ${accent}` : ""}">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value">${escapeHtml(value)}</span>
    </article>
  `;
}

function facetButton(key, item, activeValue) {
  const isActive = item.value === activeValue;
  return `
    <button class="facet-chip${isActive ? " active" : ""}" type="button" data-facet-key="${escapeHtml(key)}" data-facet-value="${escapeHtml(item.value)}">
      <span>${escapeHtml(item.value)}</span>
      <strong>${item.count}</strong>
    </button>
  `;
}

function renderFacetSection(title, key, items, activeValue) {
  const visibleItems = sortCountItems(items).slice(0, FACET_PREVIEW_LIMIT);
  if (!visibleItems.length) {
    return "";
  }
  return `
    <section class="facet-card">
      <div class="facet-card-head">
        <h3 class="facet-card-title">${escapeHtml(title)}</h3>
        <span class="job-group-count">${items.length} values</span>
      </div>
      <div class="facet-chip-list">
        ${visibleItems.map(item => facetButton(key, item, activeValue)).join("")}
      </div>
    </section>
  `;
}

function jobRow(job) {
  return `
    <tr>
      <td data-label="Job" class="col-job"><code>${escapeHtml(job.job_id || "-")}</code></td>
      <td data-label="User" class="col-user">${escapeHtml(job.user || "-")}</td>
      <td data-label="State" class="col-state"><span class="${stateClass(job.state)}">${escapeHtml(job.state || "-")}</span></td>
      <td data-label="Project" class="col-project">${escapeHtml(job.project || "-")}</td>
      <td data-label="Queue" class="col-queue">${escapeHtml(job.queue || "-")}</td>
      <td data-label="GPUs" class="col-gpu">${escapeHtml(job.gpu || "-")}</td>
      <td data-label="Submitted" class="col-time">${escapeHtml(job.submitted_at || "-")}</td>
      <td data-label="Used" class="col-time">${escapeHtml(job.used_walltime || "-")}</td>
      <td data-label="Requested" class="col-time">${escapeHtml(job.requested_walltime || "-")}</td>
      <td data-label="Scheduled" class="col-time">${escapeHtml(job.scheduled_start_time || "-")}</td>
    </tr>
  `;
}

function sortableHeader(label, sortKey, viewState) {
  const isActive = viewState.sortKey === sortKey;
  const direction = isActive ? viewState.sortDirection : "";
  return `
    <th class="sortable${isActive ? " active" : ""}" data-sort-key="${escapeHtml(sortKey)}">
      <button class="sort-button" type="button" data-sort-key="${escapeHtml(sortKey)}">
        <span>${escapeHtml(label)}</span>
        <span class="sort-indicator">${isActive ? escapeHtml(direction === "desc" ? "↓" : "↑") : "·"}</span>
      </button>
    </th>
  `;
}

function renderJobTable(jobs, viewState) {
  if (!jobs.length) {
    return `<p class="empty">No jobs match the current filters.</p>`;
  }
  const sortedJobs = [...jobs].sort((left, right) =>
    compareJobs(left, right, viewState.sortKey, viewState.sortDirection)
  );
  const pageCount = Math.max(1, Math.ceil(sortedJobs.length / PAGE_SIZE));
  const page = Math.min(viewState.page, pageCount);
  viewState.page = page;
  const pageStart = (page - 1) * PAGE_SIZE;
  const pageJobs = sortedJobs.slice(pageStart, pageStart + PAGE_SIZE);
  const pageEnd = Math.min(sortedJobs.length, pageStart + PAGE_SIZE);
  return `
    <section class="results-card">
      <div class="results-head">
        <div>
          <h3 class="job-group-name">Filtered Jobs</h3>
          <p class="results-meta">Showing ${pageStart + 1}-${pageEnd} of ${sortedJobs.length} jobs</p>
        </div>
        <div class="pagination">
          <button type="button" data-page-delta="-1"${page <= 1 ? " disabled" : ""}>Prev</button>
          <span class="pagination-label">Page ${page} / ${pageCount}</span>
          <button type="button" data-page-delta="1"${page >= pageCount ? " disabled" : ""}>Next</button>
        </div>
      </div>
      <div class="table-shell">
        <table>
          <thead>
            <tr>
              ${sortableHeader("Job", "job_id", viewState)}
              ${sortableHeader("User", "user", viewState)}
              ${sortableHeader("State", "state", viewState)}
              ${sortableHeader("Project", "project", viewState)}
              ${sortableHeader("Queue", "queue", viewState)}
              ${sortableHeader("GPUs", "gpu", viewState)}
              ${sortableHeader("Submitted", "submitted_at", viewState)}
              ${sortableHeader("Used", "used_walltime", viewState)}
              ${sortableHeader("Requested", "requested_walltime", viewState)}
              ${sortableHeader("Scheduled", "scheduled_start_time", viewState)}
            </tr>
          </thead>
          <tbody>${pageJobs.map(jobRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPresetButtons(cluster, viewState) {
  if (!(cluster.job_groups || []).length) {
    return "";
  }
  return `
    <section class="controls-card">
      <div class="facet-card-head">
        <h3 class="facet-card-title">Quick Presets</h3>
        <button type="button" class="secondary-button" data-action="clear-preset">Clear preset</button>
      </div>
      <div class="preset-list">
        ${cluster.job_groups.map(group => `
          <button class="preset-button${group.name === viewState.selectedPreset ? " active" : ""}" type="button" data-preset-name="${escapeHtml(group.name)}">
            <span class="preset-name">${escapeHtml(group.name)}</span>
            <span class="preset-count">${group.job_count}</span>
          </button>
        `).join("")}
      </div>
      <div class="preset-details">
        ${viewState.selectedPreset
          ? renderFilterChips((cluster.job_groups.find(group => group.name === viewState.selectedPreset) || {}).filters || {})
          : `<span class="empty">Preset filters are optional. Use them as one-click starting points.</span>`}
      </div>
    </section>
  `;
}

function renderControls(cluster, viewState) {
  const summary = cluster.summary || {};
  return `
    <section class="controls-card">
      <div class="facet-card-head">
        <h3 class="facet-card-title">Live Filters</h3>
        <button type="button" class="secondary-button" data-action="clear-filters">Clear filters</button>
      </div>
      <div class="control-grid">
        <label class="control-field">
          <span>User</span>
          <select data-filter-key="user">${optionMarkup("users", summary.user_counts || [], viewState.user)}</select>
        </label>
        <label class="control-field">
          <span>Queue</span>
          <select data-filter-key="queue">${optionMarkup("queues", summary.queue_counts || [], viewState.queue)}</select>
        </label>
        <label class="control-field">
          <span>State</span>
          <select data-filter-key="state">${optionMarkup("states", summary.state_counts || [], viewState.state)}</select>
        </label>
        <label class="control-field">
          <span>Project</span>
          <select data-filter-key="project">${optionMarkup("projects", summary.project_counts || [], viewState.project)}</select>
        </label>
        <label class="control-field control-field-search">
          <span>Search</span>
          <input type="search" value="${escapeHtml(viewState.search)}" placeholder="job id, user, queue, project" data-filter-key="search">
        </label>
      </div>
    </section>
  `;
}

function renderClusterCard(cluster, viewState) {
  const statusClass = cluster.ok ? "status-pill" : "status-pill error";
  if (!cluster.ok) {
    return `
      <article class="cluster-card">
        <div class="cluster-head">
          <div>
            <h2 class="cluster-name">${escapeHtml(cluster.cluster)}</h2>
            <div class="cluster-meta">
              <span>${escapeHtml(cluster.host)}</span>
              <span>${cluster.job_count} jobs</span>
              <span>${cluster.duration_seconds}s fetch</span>
            </div>
          </div>
          <span class="${statusClass}">error</span>
        </div>
        <p class="error">${escapeHtml(cluster.error)}</p>
      </article>
    `;
  }

  const filtered = filteredJobs(cluster, viewState);
  const summary = cluster.summary || {};
  return `
    <article class="cluster-card">
      <div class="cluster-head">
        <div>
          <h2 class="cluster-name">${escapeHtml(cluster.cluster)}</h2>
          <div class="cluster-meta">
            <span>${escapeHtml(cluster.host)}</span>
            <span>${cluster.job_count} jobs</span>
            <span>${cluster.duration_seconds}s fetch</span>
          </div>
        </div>
        <span class="${statusClass}">reachable</span>
      </div>

      <section class="cluster-summary-grid">
        ${summaryCard("Jobs", String(summary.total_jobs || 0))}
        ${summaryCard("Running", String(summary.running_jobs || 0), "cluster-stat-running")}
        ${summaryCard("Queued", String(summary.queued_jobs || 0), "cluster-stat-queued")}
        ${summaryCard("Held", String(summary.held_jobs || 0), "cluster-stat-held")}
        ${summaryCard("Users", String(summary.users_count || 0))}
        ${summaryCard("Projects", String(summary.projects_count || 0))}
      </section>

      ${renderPresetButtons(cluster, viewState)}
      ${renderControls(cluster, viewState)}

      <section class="facets-grid">
        ${renderFacetSection("Top Users", "user", summary.user_counts || [], viewState.user)}
        ${renderFacetSection("Queues", "queue", summary.queue_counts || [], viewState.queue)}
        ${renderFacetSection("States", "state", summary.state_counts || [], viewState.state)}
        ${renderFacetSection("Top Projects", "project", summary.project_counts || [], viewState.project)}
      </section>

      ${renderJobTable(filtered, viewState)}
    </article>
  `;
}

function renderClusters(payload) {
  clusterNavNode.innerHTML = "";
  clustersNode.innerHTML = "";

  if (!payload.clusters.length) {
    clusterNavNode.innerHTML = `<p class="empty">No clusters configured.</p>`;
    clustersNode.innerHTML = `<p class="empty">No cluster data available.</p>`;
    return;
  }

  const selectedCluster =
    payload.clusters.find(cluster => cluster.cluster === activeClusterName) || payload.clusters[0];
  activeClusterName = selectedCluster.cluster;
  const viewState = ensureViewState(activeClusterName);

  clusterNavNode.innerHTML = `
    <p class="cluster-nav-title">Clusters</p>
    ${payload.clusters.map(cluster => clusterTab(cluster, cluster.cluster === activeClusterName)).join("")}
  `;
  clustersNode.innerHTML = renderClusterCard(selectedCluster, viewState);

  for (const button of clusterNavNode.querySelectorAll("[data-cluster-name]")) {
    button.addEventListener("click", () => {
      activeClusterName = button.dataset.clusterName;
      renderClusters(payload);
    });
  }

  attachClusterHandlers(selectedCluster, payload);
}

function attachClusterHandlers(cluster, payload) {
  const viewState = ensureViewState(cluster.cluster);

  for (const element of clustersNode.querySelectorAll("[data-filter-key]")) {
    const handler = element.tagName === "INPUT" ? "input" : "change";
    element.addEventListener(handler, () => {
      viewState[element.dataset.filterKey] = element.value;
      viewState.page = 1;
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-preset-name]")) {
    button.addEventListener("click", () => {
      viewState.selectedPreset = button.dataset.presetName;
      viewState.page = 1;
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-facet-key][data-facet-value]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.facetKey;
      const value = button.dataset.facetValue;
      viewState[key] = viewState[key] === value ? "" : value;
      viewState.page = 1;
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-sort-key]")) {
    button.addEventListener("click", () => {
      const sortKey = button.dataset.sortKey;
      if (viewState.sortKey === sortKey) {
        viewState.sortDirection = viewState.sortDirection === "asc" ? "desc" : "asc";
      } else {
        viewState.sortKey = sortKey;
        viewState.sortDirection = sortKey === "submitted_at" ? "asc" : "desc";
      }
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-page-delta]")) {
    button.addEventListener("click", () => {
      viewState.page = Math.max(1, viewState.page + Number.parseInt(button.dataset.pageDelta, 10));
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-action='clear-filters']")) {
    button.addEventListener("click", () => {
      for (const key of FILTER_KEYS) {
        viewState[key] = "";
      }
      viewState.search = "";
      viewState.page = 1;
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-action='clear-preset']")) {
    button.addEventListener("click", () => {
      viewState.selectedPreset = "";
      viewState.page = 1;
      renderClusters(payload);
    });
  }
}

async function refresh() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.dashboard_title) {
      const title = payload.dashboard_title;
      document.title = title;
      dashboardTitleNode.textContent = title;
    }
    renderSummary(payload);
    renderClusters(payload);
    lastUpdatedNode.textContent = `Last updated ${new Date(payload.generated_at_epoch * 1000).toLocaleString()}`;
    scheduleRefresh(payload.refresh_seconds);
  } catch (error) {
    lastUpdatedNode.textContent = `Refresh failed: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
  }
}

function scheduleRefresh(seconds) {
  if (refreshHandle) {
    clearTimeout(refreshHandle);
  }
  refreshHandle = setTimeout(refresh, seconds * 1000);
}

refreshButton.addEventListener("click", refresh);
refresh();
