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
const SLOW_FETCH_SECONDS = 5;
const PREFERRED_USER_KEY = "cluster-observer.preferred-user";

let refreshHandle = null;
let lastGeneratedEpoch = null;
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
      showBreakdowns: false,
      preferredUserLoaded: false,
    };
  }
  return clusterViewState[clusterName];
}

function loadPreferredUser() {
  try {
    return window.localStorage.getItem(PREFERRED_USER_KEY) || "";
  } catch (error) {
    return "";
  }
}

function savePreferredUser(user) {
  try {
    if (user) {
      window.localStorage.setItem(PREFERRED_USER_KEY, user);
    } else {
      window.localStorage.removeItem(PREFERRED_USER_KEY);
    }
  } catch (error) {
    // Browsers can disable local storage; filtering should still work for this visit.
  }
}

function applyPreferredUser(cluster, viewState) {
  if (viewState.preferredUserLoaded) {
    return;
  }
  const users = cluster.summary?.user_counts || [];
  if (!cluster.ok && !users.length) {
    return;
  }
  viewState.preferredUserLoaded = true;
  const preferredUser = loadPreferredUser();
  if (preferredUser) {
    viewState.user = preferredUser;
  }
}

function renderSummary(payload) {
  const hasProblems = payload.ok_clusters !== payload.total_clusters;
  summaryNode.innerHTML = `
    <span class="global-stat${hasProblems ? " warning" : ""}">
      <strong>${payload.ok_clusters}/${payload.total_clusters}</strong> online
    </span>
    <span class="global-stat"><strong>${payload.total_jobs}</strong> jobs</span>
  `;
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
  const statusClass = cluster.stale ? "status-pill stale" : (cluster.ok ? "status-pill" : "status-pill error");
  const statusLabel = cluster.stale ? "stale" : (cluster.ok ? "ok" : "error");
  const summary = cluster.summary || {};
  const slowFetch = Number(cluster.duration_seconds) >= SLOW_FETCH_SECONDS;
  const fetchDetail = (cluster.stale || !cluster.ok || slowFetch)
    ? `<span>${cluster.duration_seconds}s fetch</span>`
    : "";
  return `
    <button class="cluster-tab${isActive ? " active" : ""}" type="button" data-cluster-name="${escapeHtml(cluster.cluster)}">
      <div class="cluster-tab-head">
        <span class="cluster-tab-name">${escapeHtml(cluster.cluster)}</span>
        <span class="${statusClass}">${statusLabel}</span>
      </div>
      <div class="cluster-tab-meta">
        <span><strong class="running-count">R ${summary.running_jobs || 0}</strong></span>
        <span><strong class="queued-count">Q ${summary.queued_jobs || 0}</strong></span>
        ${(summary.held_jobs || 0) > 0 ? `<span><strong class="held-count">H ${summary.held_jobs}</strong></span>` : ""}
        <span>${summary.running_cpu_total || 0} CPU · ${summary.running_gpu_total || 0} GPU</span>
        ${fetchDetail}
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
  const hasSelectedValue = items.some(item => item.value === selectedValue);
  const rememberedOption = selectedValue && !hasSelectedValue
    ? `<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)} (0)</option>`
    : "";
  return `
    <option value="">All ${escapeHtml(label)}</option>
    ${rememberedOption}
    ${sortCountItems(items)
      .map(item => `<option value="${escapeHtml(item.value)}"${item.value === selectedValue ? " selected" : ""}>${escapeHtml(item.label || item.value)} (${item.count})</option>`)
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
    job.user_alias,
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
  if (sortKey === "resources") {
    return numericValue(job.gpu) * 1000000 + numericValue(job.cpu);
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

function facetButton(key, item, activeValue) {
  const isActive = item.value === activeValue;
  return `
    <button class="facet-chip${isActive ? " active" : ""}" type="button" data-facet-key="${escapeHtml(key)}" data-facet-value="${escapeHtml(item.value)}">
      <span>${escapeHtml(item.label || item.value)}</span>
      <strong>${item.count}</strong>
    </button>
  `;
}

function userLabel(job) {
  if (!job.user_alias) {
    return job.user || "-";
  }
  return `${job.user_alias} (${job.user})`;
}

function resourceLabel(job) {
  if (job.resource_shape) {
    return job.resource_shape.replaceAll("x (", "× (");
  }
  const resources = [];
  if (numericValue(job.cpu) > 0) {
    resources.push(`${job.cpu} CPU`);
  }
  if (numericValue(job.gpu) > 0) {
    resources.push(`${job.gpu} GPU`);
  }
  return resources.join(" / ") || "-";
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
  const used = job.used_walltime || "—";
  const requested = job.requested_walltime || "—";
  return `
    <tr>
      <td data-label="Job" class="col-job">
        <code>${escapeHtml(job.job_id || "-")}</code>
        <span class="row-secondary">${escapeHtml(job.project || "no project")} · ${escapeHtml(job.submitted_at || "submit time unavailable")}</span>
      </td>
      <td data-label="User" class="col-user">${escapeHtml(userLabel(job))}</td>
      <td data-label="State" class="col-state"><span class="${stateClass(job.state)}">${escapeHtml(job.state || "-")}</span></td>
      <td data-label="Queue" class="col-queue">${escapeHtml(job.queue || "-")}</td>
      <td data-label="Resources" class="col-resource">${escapeHtml(resourceLabel(job))}</td>
      <td data-label="Walltime" class="col-time"><span class="walltime-used">${escapeHtml(used)}</span><span class="walltime-separator"> / </span>${escapeHtml(requested)}</td>
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
              ${sortableHeader("Job · submitted", "submitted_at", viewState)}
              ${sortableHeader("User", "user", viewState)}
              ${sortableHeader("State", "state", viewState)}
              ${sortableHeader("Queue", "queue", viewState)}
              ${sortableHeader("CPU / GPU", "resources", viewState)}
              ${sortableHeader("Walltime", "used_walltime", viewState)}
              ${sortableHeader("Scheduled", "scheduled_start_time", viewState)}
            </tr>
          </thead>
          <tbody>${pageJobs.map(jobRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderControls(cluster, viewState) {
  const summary = cluster.summary || {};
  const groups = cluster.job_groups || [];
  return `
    <section class="controls-card">
      <div class="controls-head">
        <div class="controls-title-row">
          <h3 class="facet-card-title">Jobs</h3>
          <div class="preset-list">
            ${groups.map(group => `
              <button class="preset-button${group.name === viewState.selectedPreset ? " active" : ""}" type="button" data-preset-name="${escapeHtml(group.name)}">
                <span class="preset-name">${escapeHtml(group.name)}</span>
                <span class="preset-count">${group.job_count}</span>
              </button>
            `).join("")}
          </div>
        </div>
        <button type="button" class="secondary-button" data-action="clear-all">Clear</button>
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
      ${viewState.selectedPreset
        ? `<div class="active-preset">${renderFilterChips((groups.find(group => group.name === viewState.selectedPreset) || {}).filters || {})}</div>`
        : ""}
    </section>
  `;
}

function renderBreakdowns(summary, viewState) {
  return `
    <section class="breakdowns">
      <button class="breakdown-toggle" type="button" data-action="toggle-breakdowns" aria-expanded="${viewState.showBreakdowns}">
        <span>${viewState.showBreakdowns ? "Hide" : "Show"} breakdowns</span>
        <span aria-hidden="true">${viewState.showBreakdowns ? "↑" : "↓"}</span>
      </button>
      ${viewState.showBreakdowns ? `
        <div class="facets-grid">
          ${renderFacetSection("Top Users", "user", summary.user_counts || [], viewState.user)}
          ${renderFacetSection("Queues", "queue", summary.queue_counts || [], viewState.queue)}
          ${renderFacetSection("Projects", "project", summary.project_counts || [], viewState.project)}
        </div>
      ` : ""}
    </section>
  `;
}

function renderClusterCard(cluster, viewState) {
  const statusClass = cluster.stale ? "status-pill stale" : (cluster.ok ? "status-pill" : "status-pill error");
  if (!cluster.ok && !cluster.stale) {
    return `
      <article class="cluster-card">
        <div class="cluster-head">
          <div>
            <h2 class="cluster-name">${escapeHtml(cluster.cluster)}</h2>
            <div class="cluster-meta">
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
              <span>${cluster.job_count} jobs tracked</span>
              ${Number(cluster.duration_seconds) >= SLOW_FETCH_SECONDS ? `<span>${cluster.duration_seconds}s fetch</span>` : ""}
            </div>
        </div>
        <span class="${statusClass}">${cluster.stale ? "stale data" : "reachable"}</span>
      </div>

      ${cluster.stale
        ? `<p class="stale-warning">Latest collection failed: ${escapeHtml(cluster.error)}. Showing the last successful snapshot from ${new Date(cluster.last_success_epoch * 1000).toLocaleString()}.</p>`
        : ""}

      <section class="cluster-metrics" aria-label="Cluster job summary">
        <span><strong class="running-count">${summary.running_jobs || 0}</strong> running</span>
        <span><strong class="queued-count">${summary.queued_jobs || 0}</strong> queued</span>
        <span><strong class="held-count">${summary.held_jobs || 0}</strong> held</span>
        <span><strong>${summary.running_cpu_total || 0} CPU / ${summary.running_gpu_total || 0} GPU</strong> active</span>
      </section>

      ${renderControls(cluster, viewState)}
      ${renderBreakdowns(summary, viewState)}
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
  applyPreferredUser(selectedCluster, viewState);

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
      if (element.dataset.filterKey === "user") {
        savePreferredUser(element.value);
      }
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

  for (const button of clustersNode.querySelectorAll("[data-action='clear-all']")) {
    button.addEventListener("click", () => {
      for (const key of FILTER_KEYS) {
        viewState[key] = "";
      }
      viewState.search = "";
      viewState.selectedPreset = "";
      viewState.page = 1;
      renderClusters(payload);
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-action='toggle-breakdowns']")) {
    button.addEventListener("click", () => {
      viewState.showBreakdowns = !viewState.showBreakdowns;
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
    lastGeneratedEpoch = payload.generated_at_epoch;
    renderUpdateAge();
    scheduleRefresh(payload.refresh_seconds);
  } catch (error) {
    lastUpdatedNode.textContent = `Refresh failed: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
  }
}

function renderUpdateAge() {
  if (!lastGeneratedEpoch) {
    return;
  }
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - lastGeneratedEpoch));
  let ageLabel = "just now";
  if (ageSeconds >= 60) {
    ageLabel = `${Math.floor(ageSeconds / 60)}m ago`;
  } else if (ageSeconds >= 10) {
    ageLabel = `${ageSeconds}s ago`;
  }
  lastUpdatedNode.textContent = `Updated ${ageLabel}`;
}

function scheduleRefresh(seconds) {
  if (refreshHandle) {
    clearTimeout(refreshHandle);
  }
  refreshHandle = setTimeout(refresh, seconds * 1000);
}

refreshButton.addEventListener("click", refresh);
setInterval(renderUpdateAge, 10000);
refresh();
