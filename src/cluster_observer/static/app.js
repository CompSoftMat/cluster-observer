const summaryNode = document.getElementById("summary");
const clusterNavNode = document.getElementById("cluster-nav");
const clustersNode = document.getElementById("clusters");
const lastUpdatedNode = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const dashboardTitleNode = document.getElementById("dashboard-title");

let refreshHandle = null;
let activeClusterName = null;

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

function jobRow(job) {
  return `
    <tr>
      <td data-label="Job" class="col-job"><code>${escapeHtml(job.job_id || "-")}</code></td>
      <td data-label="User" class="col-user">${escapeHtml(job.user || "-")}</td>
      <td data-label="State" class="col-state"><span class="${stateClass(job.state)}">${escapeHtml(job.state || "-")}</span></td>
      <td data-label="Submitted" class="col-time">${escapeHtml(job.submitted_at || "-")}</td>
      <td data-label="Queue" class="col-queue">${escapeHtml(job.queue || "-")}</td>
      <td data-label="GPUs" class="col-gpu">${escapeHtml(job.gpu || "-")}</td>
      <td data-label="Used" class="col-time">${escapeHtml(job.used_walltime || "-")}</td>
      <td data-label="Requested" class="col-time">${escapeHtml(job.requested_walltime || "-")}</td>
      <td data-label="Scheduled" class="col-time">${escapeHtml(job.scheduled_start_time || "-")}</td>
    </tr>
  `;
}

function renderFilterChips(filters) {
  return Object.entries(filters)
    .map(([key, values]) => `<span class="filter-chip">${escapeHtml(key)}: ${escapeHtml(values.join(", "))}</span>`)
    .join("");
}

function compareJobs(left, right) {
  const leftSubmitted = left.submitted_at || "";
  const rightSubmitted = right.submitted_at || "";
  if (leftSubmitted !== rightSubmitted) {
    return leftSubmitted.localeCompare(rightSubmitted);
  }
  return (left.job_id || "").localeCompare(right.job_id || "");
}

function renderJobTable(jobs) {
  const sortedJobs = [...jobs].sort(compareJobs);
  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>User</th>
            <th>State</th>
            <th>Submitted</th>
            <th>Queue</th>
            <th>GPUs</th>
            <th>Used</th>
            <th>Requested</th>
            <th>Scheduled</th>
          </tr>
        </thead>
        <tbody>${sortedJobs.map(jobRow).join("")}</tbody>
      </table>
    </div>
  `;
}

function renderSubgroup(title, count, jobs, extraClass = "") {
  if (!jobs.length) {
    return "";
  }
  return `
    <section class="job-subgroup${extraClass ? ` ${extraClass}` : ""}">
      <div class="job-subgroup-head">
        <h4 class="job-subgroup-name">${escapeHtml(title)}</h4>
        <span class="job-subgroup-count">${count} jobs</span>
      </div>
      ${renderJobTable(jobs)}
    </section>
  `;
}

function renderGroup(group) {
  const runningJobs = group.jobs.filter(job => (job.state || "").toUpperCase() === "R");
  const remainingJobs = group.jobs.filter(job => (job.state || "").toUpperCase() !== "R");
  const sections = [
    renderSubgroup("Running", runningJobs.length, runningJobs, "job-subgroup-running"),
    renderSubgroup("Queued / Held / Other", remainingJobs.length, remainingJobs, "job-subgroup-other"),
  ].filter(Boolean);
  const body = sections.length
    ? sections.join("")
    : `<p class="empty">No matching jobs for this filter group.</p>`;
  return `
    <section class="job-group">
      <div class="job-group-head">
        <div>
          <h3 class="job-group-name">${escapeHtml(group.name)}</h3>
          <div class="job-group-filters">${renderFilterChips(group.filters)}</div>
        </div>
        <span class="job-group-count">${group.job_count} jobs</span>
      </div>
      ${body}
    </section>
  `;
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

function renderClusterCard(cluster) {
  const statusClass = cluster.ok ? "status-pill" : "status-pill error";
  const body = cluster.ok
    ? cluster.job_groups.length
      ? cluster.job_groups.map(renderGroup).join("")
      : `<p class="empty">No matching jobs for configured filters.</p>`
    : `<p class="error">${cluster.error}</p>`;

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
        <span class="${statusClass}">${cluster.ok ? "reachable" : "error"}</span>
      </div>
      ${body}
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

  clusterNavNode.innerHTML = `
    <p class="cluster-nav-title">Clusters</p>
    ${payload.clusters.map(cluster => clusterTab(cluster, cluster.cluster === activeClusterName)).join("")}
  `;
  clustersNode.innerHTML = renderClusterCard(selectedCluster);

  for (const button of clusterNavNode.querySelectorAll("[data-cluster-name]")) {
    button.addEventListener("click", () => {
      activeClusterName = button.dataset.clusterName;
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
