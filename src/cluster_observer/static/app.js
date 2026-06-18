const summaryNode = document.getElementById("summary");
const clustersNode = document.getElementById("clusters");
const lastUpdatedNode = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh-button");
const dashboardTitleNode = document.getElementById("dashboard-title");

let refreshHandle = null;

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

function renderClusters(payload) {
  clustersNode.innerHTML = "";

  for (const cluster of payload.clusters) {
    const card = document.createElement("article");
    card.className = "cluster-card";
    const statusClass = cluster.ok ? "status-pill" : "status-pill error";
    const body = cluster.ok
      ? cluster.jobs.length
        ? `
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
              <tbody>${cluster.jobs.map(jobRow).join("")}</tbody>
            </table>
          </div>
        `
        : `<p class="empty">No matching jobs for project filter.</p>`
      : `<p class="error">${cluster.error}</p>`;

    card.innerHTML = `
      <div class="cluster-head">
        <div>
          <h2 class="cluster-name">${cluster.cluster}</h2>
          <div class="cluster-meta">
            <span>${cluster.host}</span>
            <span>${cluster.job_count} jobs</span>
            <span>${cluster.duration_seconds}s fetch</span>
          </div>
        </div>
        <span class="${statusClass}">${cluster.ok ? "reachable" : "error"}</span>
      </div>
      ${body}
    `;
    clustersNode.appendChild(card);
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
