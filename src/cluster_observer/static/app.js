import {mountStateFilter} from "./state-filter.js";
import {openJobDetails} from "./job-details.js";

const summaryNode = document.getElementById("summary");
const clusterNavNode = document.getElementById("cluster-nav");
const clustersNode = document.getElementById("clusters");
const lastUpdatedNode = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const dashboardTitleNode = document.getElementById("dashboard-title");

const PAGE_SIZE = 40;
const FACET_PREVIEW_LIMIT = 10;
const FILTER_KEYS = ["user", "queue", "project"];
const SAVED_VIEWS_KEY = "cluster-observer.saved-views";
const VIEW_FIELDS = [...FILTER_KEYS, "state", "search", "selectedPreset", "sortKey", "sortDirection"];
const OUTCOMES = {
  successful: "Successful", failed: "Failed", cancelled: "Cancelled", unknown: "Outcome unknown",
};
const STATE_ORDER = { R: 0, Q: 1, H: 2 };
const SLOW_FETCH_SECONDS = 5;
const PREFERRED_USER_KEY = "cluster-observer.preferred-user";

let lastGeneratedEpoch = null;
let activeClusterName = null;
let showingMyViews = false;
const clusterViewState = Object.create(null);
const overviewStates = new Map();
const savedViews = loadSavedViews();

function loadSavedViews() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SAVED_VIEWS_KEY));
    if (Array.isArray(stored?.views)) return stored;
  } catch {
    // Start with an empty list if storage is unavailable.
  }
  return {views: [], defaultName: ""};
}

function persistSavedViews() {
  try {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
  } catch {
    window.alert("Browser storage is unavailable. Saved views will last until you reload.");
  }
}

function applySavedView(view, payload) {
  if (!payload.clusters.some(cluster => cluster.cluster === view.cluster)) return false;
  activeClusterName = view.cluster;
  const state = ensureViewState(view.cluster);
  for (const key of VIEW_FIELDS) state[key] = view.filters[key];
  state.state = [...view.filters.state];
  state.preferredUserLoaded = true;
  state.page = 1;
  return true;
}

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
      state: [],
      project: "",
      search: "",
      sortKey: "submitted_at",
      sortDirection: "asc",
      page: 1,
      showBreakdowns: false,
      showMoreFilters: false,
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

function optionMarkup(label, items, selectedValue, defaultLabel = `All ${label}`) {
  const hasSelectedValue = items.some(item => item.value === selectedValue);
  const rememberedOption = selectedValue && !hasSelectedValue
    ? `<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)} (0)</option>`
    : "";
  return `
    <option value="">${escapeHtml(defaultLabel)}</option>
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
  if (viewState.state.length &&
      !viewState.state.includes((job.state || "").toUpperCase()) &&
      !viewState.state.includes(`outcome:${job.outcome}`)) {
    return false;
  }
  for (const key of FILTER_KEYS) {
    const selectedValue = viewState[key];
    if (!selectedValue) {
      continue;
    }
    if ((job[key] || "") !== selectedValue) {
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

function configuredProjects(cluster) {
  return [...new Set((cluster.job_groups || []).flatMap(group => group.filters?.project || []))];
}

function filteredJobs(cluster, viewState) {
  const preset = (cluster.job_groups || []).find(group => group.name === viewState.selectedPreset);
  const projects = configuredProjects(cluster);
  const presetFilters = preset?.filters || (projects.length ? {project: projects} : {});
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
  return `${job.cpu === "" || job.cpu == null ? "unknown" : job.cpu} CPU / ${job.gpu === "" || job.gpu == null ? "unknown" : job.gpu} GPU`;
}

function statusMarkup(job) {
  const state = job.raw_state || job.state || "?";
  const suffix = {successful: "OK", failed: "ERR", cancelled: "CAN", unknown: "?"}[job.outcome];
  const dependencies = job.dependency_job_ids || [];
  const badge = suffix ? `${state}/${suffix}` : state === "H" && dependencies.length ? "H/DEP" : state;
  const details = [job.status_label || state, `PBS: ${state}`];
  if (job.exit_status != null) details.push(`Exit status: ${job.exit_status}`);
  if (state === "H" && dependencies.length) details.push(`Predecessor: ${dependencies.join(", ")}`);
  if (job.outcome) details.push("Job/segment result; whole-chain progress requires campaign metadata.");
  const explanation = escapeHtml(details.join(" · "));
  return `<span tabindex="0" title="${explanation}" aria-label="${explanation}" class="${stateClass(job.state)} ${escapeHtml(job.outcome || "")}">${escapeHtml(badge)}</span>`;
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
        <button class="job-id-button" type="button" data-job-id="${escapeHtml(job.job_id)}"><code>${escapeHtml(job.job_id)}</code></button>
        <button class="job-copy-button" type="button" data-copy-job-id="${escapeHtml(job.job_id)}" title="Copy job ID" aria-label="Copy job ID"><span aria-hidden="true">⧉</span></button>
        ${job.project ? `<span class="row-secondary">${escapeHtml(job.project)}</span>` : ""}
      </td>
      <td data-label="User" class="col-user">${escapeHtml(userLabel(job))}</td>
      <td data-label="State" class="col-state">${statusMarkup(job)}</td>
      <td data-label="Queue" class="col-queue">${escapeHtml(job.queue || "-")}</td>
      <td data-label="Resources" class="col-resource">${escapeHtml(resourceLabel(job))}</td>
      <td data-label="Walltime" class="col-time"><span class="walltime-used">${escapeHtml(used)}</span><span class="walltime-separator"> / </span>${escapeHtml(requested)}</td>
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
              ${sortableHeader("Job", "submitted_at", viewState)}
              ${sortableHeader("User", "user", viewState)}
              ${sortableHeader("State", "state", viewState)}
              ${sortableHeader("Queue", "queue", viewState)}
              ${sortableHeader("CPU / GPU", "resources", viewState)}
              ${sortableHeader("Walltime", "used_walltime", viewState)}
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
  const projects = configuredProjects(cluster);
  const projectItems = projects.length
    ? projects.map(value => (summary.project_counts || []).find(item => item.value === value) || {value, count: 0})
    : summary.project_counts || [];
  const groups = (cluster.job_groups || []).filter(group => {
    const keys = Object.keys(group.filters || {});
    return keys.length && !(keys.length === 1 && keys[0] === "project" && group.name === "project");
  });
  const scopeLabel = projects.length ? "All lab projects" : "All jobs";
  const activeMore = [viewState.queue && `Queue: ${viewState.queue}`, viewState.selectedPreset].filter(Boolean);
  return `
    <section class="controls-card">
      <div class="controls-head">
        <h3 class="facet-card-title">Jobs</h3>
        <div class="job-control-actions">
        <details class="saved-views">
          <summary class="secondary-button">Views <span aria-hidden="true">▾</span></summary>
          <div class="saved-view-menu">
            <div class="saved-view-actions">
              <button type="button" data-open-my-views>Open My Views</button>
              <button type="button" data-view-action="save">Save current view</button>
            </div>
            ${savedViews.views.map((view, index) => `<div class="saved-view-row">
              <button class="saved-view-name" type="button" data-view-action="apply" data-view-index="${index}">${escapeHtml(view.name)} <small>${escapeHtml(view.cluster)}</small></button>
              <button type="button" data-view-action="default" data-view-index="${index}">${savedViews.defaultName === view.name ? "Clear default" : "Set default"}</button>
              <button type="button" data-view-action="delete" data-view-index="${index}">Delete</button>
            </div>`).join("")}
          </div>
        </details>
        <button type="button" class="secondary-button" data-action="clear-all">Reset to defaults</button>
        </div>
      </div>
      <div class="control-grid">
        <label class="control-field">
          <span>Project</span>
          <select data-filter-key="project">${optionMarkup("projects", projectItems, viewState.project, viewState.selectedPreset ? "Any project in preset" : scopeLabel)}</select>
        </label>
        <label class="control-field">
          <span>User</span>
          <select data-filter-key="user">${optionMarkup("users", summary.user_counts || [], viewState.user)}</select>
        </label>
        <div class="control-field" id="state-filter-mount"></div>
        <label class="control-field control-field-search">
          <span>Search</span>
          <input type="search" value="${escapeHtml(viewState.search)}" placeholder="job id, user, queue, project" data-filter-key="search">
        </label>
      </div>
      <details class="more-filters"${viewState.showMoreFilters ? " open" : ""}>
        <summary>More filters${activeMore.length ? ` · ${escapeHtml(activeMore.join(" · "))}` : ""}</summary>
        <label class="control-field">
          <span>Queue</span>
          <select data-filter-key="queue">${optionMarkup("queues", summary.queue_counts || [], viewState.queue)}</select>
        </label>
        ${groups.length ? `<div class="preset-list">
          <button type="button" class="preset-button" data-preset-name="">${scopeLabel}</button>
          ${groups.map(group => `
            <button class="preset-button${group.name === viewState.selectedPreset ? " active" : ""}" type="button" data-preset-name="${escapeHtml(group.name)}">${escapeHtml(group.name)} · ${group.job_count}</button>
          `).join("")}
        </div>` : ""}
      </details>
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

function quotaBar(label, used, limit, ownUsed = 0) {
  if (used == null || ownUsed == null) {
    return `<div class="quota-row"><div class="quota-label"><span>${escapeHtml(label)}</span><strong>usage unknown / ${limit}</strong></div></div>`;
  }
  const percent = Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  const own = Math.min(used, Math.max(0, ownUsed));
  const external = Math.max(0, used - own);
  const ownPercent = Math.min(100, limit > 0 ? (own / limit) * 100 : 0);
  const externalPercent = Math.max(0, percent - ownPercent);
  const over = limit > 0 && used > limit;
  return `
    <div class="quota-row">
      <div class="quota-label"><span>${escapeHtml(label)}</span><strong>${used} / ${limit}${own ? ` · own ${own} · external ${external}` : ""}</strong></div>
      <div class="quota-track" role="progressbar" aria-label="${escapeHtml(label)} quota" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${limit}">
        <span class="quota-fill external${over ? " over" : ""}" style="width: ${externalPercent}%"></span><span class="quota-fill own${over ? " over" : ""}" style="width: ${ownPercent}%"></span>
      </div>
    </div>
  `;
}

function renderProjectQuotas(cluster) {
  const configuredGroups = cluster.quota_groups || [];
  const legacyGroups = Object.entries(cluster.project_quotas || {}).map(([project, limits]) => ({
    name: `pbs:${project}`,
    label: project,
    source: "pbs",
    color: "pbs",
    cpu: limits.cpu,
    gpu: limits.gpu,
    used_cpu: 0,
    used_gpu: 0,
  }));
  const groups = configuredGroups.length ? configuredGroups : legacyGroups;
  if (!groups.length) {
    return "";
  }
  return `
    <section class="quota-card" aria-label="Project resource quotas">
      <div class="quota-head">
        <h3>Project quotas</h3>
        <span>currently running · own / external</span>
      </div>
      <div class="quota-grid">
        ${[...groups].sort((left, right) => String(left.label).localeCompare(String(right.label))).map(group => {
          const sourceClass = group.color === "manual" || group.source === "configured" ? " manual" : " pbs";
          const bars = [];
          if (group.cpu !== null && group.cpu !== undefined) {
            bars.push(quotaBar("CPU", group.used_cpu, group.cpu, group.own_used_cpu));
          }
          if (group.gpu !== null && group.gpu !== undefined) {
            bars.push(quotaBar("GPU", group.used_gpu, group.gpu, group.own_used_gpu));
          }
          return `
            <article class="quota-project${sourceClass}">
              <div class="quota-project-name"><span>${escapeHtml(group.label || group.name)}</span><small>${escapeHtml(group.source || "configured")}</small></div>
              ${bars.join("")}
              ${group.cpu === null || group.cpu === undefined ? `<span class="quota-unlimited">CPU: ${group.used_cpu ?? "unknown"} active · no limit reported</span>` : ""}
            </article>
          `;
        }).join("")}
      </div>
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
        <span><strong>${summary.running_cpu_total ?? "unknown"} CPU / ${summary.running_gpu_total ?? "unknown"} GPU</strong> active</span>
      </section>

      ${renderProjectQuotas(cluster)}
      ${renderControls(cluster, viewState)}
      ${renderBreakdowns(summary, viewState)}
      ${renderJobTable(filtered, viewState)}
    </article>
  `;
}

let unmountStateFilter;

function deleteSavedView(view) {
  if (!window.confirm(`Delete “${view.name}”?`)) return false;
  if (savedViews.defaultName === view.name) savedViews.defaultName = "";
  savedViews.views.splice(savedViews.views.indexOf(view), 1);
  overviewStates.delete(view);
  persistSavedViews();
  return true;
}

function renderMyViews(payload) {
  clustersNode.innerHTML = `
    <section class="my-views-page">
      <h2>My Views</h2>
      ${savedViews.views.length ? savedViews.views.map((view, index) => `
        <article class="cluster-card my-view-card" data-overview-index="${index}">
          <header class="my-view-header">
            <div><h3>${escapeHtml(view.name)}</h3><p>${escapeHtml(view.cluster)}</p></div>
            <button class="secondary-button" type="button" data-delete-view aria-label="Delete view ${escapeHtml(view.name)}">Delete</button>
          </header>
          <div data-overview-table></div>
        </article>`).join("") : '<p class="empty">Save a view from a cluster’s Views menu to see it here.</p>'}
    </section>`;

  for (const card of clustersNode.querySelectorAll("[data-overview-index]")) {
    const view = savedViews.views[Number(card.dataset.overviewIndex)];
    card.querySelector("[data-delete-view]").addEventListener("click", () => {
      if (deleteSavedView(view)) renderClusters(payload);
    });
    const cluster = payload.clusters.find(item => item.cluster === view.cluster);
    const table = card.querySelector("[data-overview-table]");
    if (!cluster || (!cluster.ok && !cluster.stale)) {
      table.textContent = "Cluster data unavailable.";
      continue;
    }
    if (cluster.stale) {
      const warning = document.createElement("p");
      warning.className = "stale-warning";
      warning.textContent = "Showing the last successful snapshot.";
      card.insertBefore(warning, table);
    }
    const state = overviewStates.get(view) || {...view.filters, page: 1};
    overviewStates.set(view, state);
    table.innerHTML = renderJobTable(filteredJobs(cluster, state), state);
    attachJobTableHandlers(table, cluster, state, () => renderClusters(payload));
  }
}

function renderClusters(payload) {
  unmountStateFilter?.();
  unmountStateFilter = undefined;
  clusterNavNode.innerHTML = "";
  clustersNode.innerHTML = "";

  if (!payload.clusters.length) {
    clusterNavNode.innerHTML = `<p class="empty">No clusters configured.</p>`;
    clustersNode.innerHTML = `<p class="empty">No cluster data available.</p>`;
    return;
  }

  if (activeClusterName === null) {
    const defaultView = savedViews.views.find(view => view.name === savedViews.defaultName);
    if (defaultView) applySavedView(defaultView, payload);
  }

  const selectedCluster =
    payload.clusters.find(cluster => cluster.cluster === activeClusterName) || payload.clusters[0];
  activeClusterName = selectedCluster.cluster;
  const viewState = ensureViewState(activeClusterName);
  applyPreferredUser(selectedCluster, viewState);

  clusterNavNode.innerHTML = `
    <p class="cluster-nav-title">Clusters</p>
    <button type="button" class="secondary-button my-views-nav" data-open-my-views aria-pressed="${showingMyViews}">My Views</button>
    ${payload.clusters.map(cluster => clusterTab(cluster, !showingMyViews && cluster.cluster === activeClusterName)).join("")}
  `;
  for (const button of clusterNavNode.querySelectorAll("[data-cluster-name]")) {
    button.addEventListener("click", () => {
      showingMyViews = false;
      activeClusterName = button.dataset.clusterName;
      renderClusters(payload);
    });
  }
  function openMyViews() {
    showingMyViews = true;
    renderClusters(payload);
    clustersNode.querySelector("h2")?.scrollIntoView({block: "nearest"});
  }
  clusterNavNode.querySelector("[data-open-my-views]").addEventListener("click", openMyViews);
  if (showingMyViews) {
    renderMyViews(payload);
    return;
  }
  clustersNode.innerHTML = renderClusterCard(selectedCluster, viewState);
  clustersNode.querySelector("[data-open-my-views]")?.addEventListener("click", openMyViews);
  const stateFilter = clustersNode.querySelector("#state-filter-mount");
  if (stateFilter) {
    const counts = new Map((selectedCluster.summary?.state_counts || []).map(item => [item.value, item]));
    for (const value of ["R", "Q", "H"]) {
      if (!counts.has(value)) counts.set(value, {value, count: 0});
    }
    for (const [outcome, label] of Object.entries(OUTCOMES)) {
      const value = `outcome:${outcome}`;
      const count = selectedCluster.jobs.filter(job => job.outcome === outcome).length;
      counts.set(value, {value, label, count});
    }
    for (const value of viewState.state) {
      if (!counts.has(value)) counts.set(value, {value, count: 0});
    }
    unmountStateFilter = mountStateFilter(
      stateFilter,
      [...counts.values()],
      viewState.state,
      (next, value) => {
        viewState.state = next;
        viewState.page = 1;
        renderClusters(payload);
        const choices = clustersNode.querySelector(".state-choices");
        choices.open = true;
        const option = [...choices.querySelectorAll("input")].find(input => input.value === value);
        (option || choices.querySelector("button")).focus({preventScroll: true});
      },
    );
  }

  attachClusterHandlers(selectedCluster, payload);
}

async function copyTableJobId(button) {
  const id = button.dataset.copyJobId;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    if (!button.isConnected) return;
    // The dashboard can be served over plain HTTP, where Clipboard API access is limited.
    const input = document.createElement("textarea");
    input.value = id;
    input.readOnly = true;
    input.style.cssText = "position: fixed; inset: 0 auto auto 0; opacity: 0";
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      // Select the visible ID so it can still be copied manually.
    } finally {
      input.remove();
      button.focus({preventScroll: true});
    }
    if (!copied) {
      const range = document.createRange();
      range.selectNodeContents(button.previousElementSibling);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.title = "Job ID selected. Use your copy shortcut.";
      return;
    }
  }
  button.firstElementChild.textContent = "✓";
  button.title = "Copied";
  window.setTimeout(() => {
    button.firstElementChild.textContent = "⧉";
    button.title = "Copy job ID";
  }, 1200);
}

function attachClusterHandlers(cluster, payload) {
  const viewState = ensureViewState(cluster.cluster);
  for (const button of clustersNode.querySelectorAll("[data-view-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.viewAction;
      const index = Number(button.dataset.viewIndex);
      const view = savedViews.views[index];
      if (action === "save") {
        const name = window.prompt("Name this view")?.trim();
        if (!name) return;
        const existing = savedViews.views.findIndex(item => item.name === name);
        if (existing >= 0 && !window.confirm(`Replace “${name}”?`)) return;
        const filters = Object.fromEntries(VIEW_FIELDS.map(key => [key, viewState[key]]));
        const entry = {name, cluster: cluster.cluster, filters};
        if (existing < 0) savedViews.views.push(entry);
        else savedViews.views[existing] = entry;
      } else if (action === "apply") {
        if (!applySavedView(view, payload)) {
          window.alert("This view’s cluster is unavailable.");
          return;
        }
        renderClusters(payload);
        return;
      } else if (action === "default") {
        savedViews.defaultName = savedViews.defaultName === view.name ? "" : view.name;
      } else if (action === "delete") {
        if (!deleteSavedView(view)) return;
        renderClusters(payload);
        const menu = clustersNode.querySelector(".saved-views");
        if (menu) menu.open = true;
        return;
      }
      overviewStates.clear();
      persistSavedViews();
      renderClusters(payload);
      const menu = clustersNode.querySelector(".saved-views");
      if (menu) menu.open = true;
    });
  }
  attachJobTableHandlers(clustersNode, cluster, viewState, () => renderClusters(payload));
  const moreFilters = clustersNode.querySelector(".more-filters");
  moreFilters?.addEventListener("toggle", () => {
    if (moreFilters.isConnected) viewState.showMoreFilters = moreFilters.open;
  });

  for (const element of clustersNode.querySelectorAll("[data-filter-key]")) {
    const handler = element.tagName === "INPUT" ? "input" : "change";
    element.addEventListener(handler, () => {
      viewState[element.dataset.filterKey] = element.value;
      if (element.dataset.filterKey === "user" && element.value) {
        savePreferredUser(element.value);
      }
      viewState.page = 1;
      const cursor = element.tagName === "INPUT" ? element.selectionStart : null;
      renderClusters(payload);
      if (cursor !== null) {
        const search = clustersNode.querySelector('input[data-filter-key="search"]');
        search?.focus({preventScroll: true});
        search?.setSelectionRange(cursor, cursor);
      }
    });
  }

  for (const button of clustersNode.querySelectorAll("[data-preset-name]")) {
    button.addEventListener("click", () => {
      viewState.selectedPreset = button.dataset.presetName;
      viewState.project = "";
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

  for (const button of clustersNode.querySelectorAll("[data-action='clear-all']")) {
    button.addEventListener("click", () => {
      for (const key of FILTER_KEYS) {
        viewState[key] = "";
      }
      viewState.search = "";
      viewState.state = [];
      viewState.user = loadPreferredUser();
      viewState.showMoreFilters = false;
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

function attachJobTableHandlers(container, cluster, viewState, render) {
  const jobsById = new Map((cluster.jobs || []).map(job => [job.job_id, job]));
  for (const button of container.querySelectorAll("[data-job-id]")) {
    button.addEventListener("click", () => {
      openJobDetails(jobsById.get(button.dataset.jobId), jobsById, button);
    });
  }
  for (const button of container.querySelectorAll("[data-copy-job-id]")) {
    button.addEventListener("click", () => copyTableJobId(button));
  }
  for (const button of container.querySelectorAll(".sort-button")) {
    button.addEventListener("click", () => {
      const sortKey = button.dataset.sortKey;
      if (viewState.sortKey === sortKey) {
        viewState.sortDirection = viewState.sortDirection === "asc" ? "desc" : "asc";
      } else {
        viewState.sortKey = sortKey;
        viewState.sortDirection = sortKey === "submitted_at" ? "asc" : "desc";
      }
      render();
    });
  }

  for (const button of container.querySelectorAll("[data-page-delta]")) {
    button.addEventListener("click", () => {
      viewState.page = Math.max(1, viewState.page + Number.parseInt(button.dataset.pageDelta, 10));
      render();
    });
  }
}

async function refresh(force = false) {
  refreshButton.disabled = true;
  try {
    const endpoint = force ? "/api/jobs?refresh=1" : "/api/jobs";
    const response = await fetch(endpoint, { cache: "no-store" });
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

refreshButton.addEventListener("click", () => refresh(true));
document.addEventListener("pointerdown", event => {
  const menu = clustersNode.querySelector(".saved-views[open]");
  if (menu && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", event => {
  const menu = clustersNode.querySelector(".saved-views[open]");
  if (event.key === "Escape" && menu && !document.querySelector("dialog[open]")) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
setInterval(renderUpdateAge, 10000);
refresh(false);
