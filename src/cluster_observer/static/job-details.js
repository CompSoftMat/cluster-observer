import {createApp, h, ref} from "./vue.runtime.js";

function jobLinks(job) {
  const types = new Map();
  for (const clause of (job.depend || "").split(",")) {
    const [type, ...ids] = clause.trim().split(":");
    if (type.startsWith("after")) {
      for (const id of ids) types.set(id.trim(), type);
    }
  }
  return (job.dependency_job_ids || []).map(id => ({id, type: types.get(id)}));
}

function dependencyRows(root, linksFor) {
  const seen = new Set([root]);
  const stack = [];
  const rows = [];
  function pushLinks(id, depth) {
    for (const link of [...linksFor(id)].reverse()) stack.push({...link, depth});
  }
  pushLinks(root, 1);
  while (stack.length) {
    const link = stack.pop();
    const repeated = seen.has(link.id);
    rows.push({...link, repeated});
    if (!repeated) {
      seen.add(link.id);
      pushLinks(link.id, link.depth + 1);
    }
  }
  return rows;
}

export function openJobDetails(initialJob, jobsById, trigger) {
  if (!initialJob) return;
  const dialog = document.createElement("dialog");
  dialog.className = "job-details";
  dialog.setAttribute("aria-labelledby", "job-details-title");
  const job = ref(initialJob);
  const previousJobs = ref([]);
  const copyMessage = ref("");
  const showDependencies = ref(false);
  const predecessors = new Map();
  const successors = new Map();
  for (const entry of jobsById.values()) {
    const links = jobLinks(entry);
    predecessors.set(entry.job_id, links);
    for (const {id, type} of links) {
      if (!successors.has(id)) successors.set(id, []);
      successors.get(id).push({id: entry.job_id, type});
    }
  }

  function dependencySection(title, links, id) {
    const rows = dependencyRows(id, key => links.get(key) || []);
    return h("section", [
      h("h3", title),
      rows.length ? h("ul", {class: "dependency-chain"}, rows.map(row => {
        const target = jobsById.get(row.id);
        const notes = [row.type, target ? target.status_label || target.state : "Outside snapshot",
          row.repeated ? "Already shown" : ""].filter(Boolean);
        return h("li", {style: {paddingInlineStart: `${Math.min(row.depth - 1, 8) * 0.8}rem`}}, [
          h("span", {"aria-hidden": "true"}, "↳ "),
          target ? h("button", {type: "button", class: "job-id-button", onClick: () => showJob(target)}, row.id)
            : h("code", row.id),
          h("small", notes.join(" · ")),
        ]);
      })) : h("p", "None reported"),
    ]);
  }
  const resourceCount = value => value == null || value === "" ? "Unknown" : value;

  function showJob(next, remember = true) {
    if (remember) previousJobs.value.push(job.value);
    job.value = next;
    copyMessage.value = "";
  }

  async function copyId() {
    const id = job.value.job_id;
    try {
      await navigator.clipboard.writeText(id);
      if (job.value.job_id === id) copyMessage.value = "Copied";
    } catch {
      if (job.value.job_id !== id) return;
      const range = document.createRange();
      range.selectNodeContents(dialog.querySelector("#job-details-title"));
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      copyMessage.value = "Job ID selected. Use your usual copy shortcut.";
    }
  }

  const app = createApp({
    setup: () => () => {
      const current = job.value;
      const resources = `${resourceCount(current.cpu)} CPU / ${resourceCount(current.gpu)} GPU`;
      const layout = current.resource_shape?.replaceAll("x (", "× (");
      const fields = [
        ["User", current.user_alias ? `${current.user_alias} (${current.user})` : current.user],
        ["Project", current.project],
        ["Queue", current.queue],
        ["Resources", resources],
        ...(layout && layout !== resources ? [["Resource layout", layout]] : []),
        ["Walltime used", current.used_walltime],
        ["Walltime requested", current.requested_walltime],
        ["Submitted", current.submitted_at],
        ["Scheduled start", current.scheduled_start_time],
        ["PBS state", current.raw_state || current.state],
        ["Status", current.status_label],
      ];
      if (current.exit_status != null) fields.push(["Exit status", String(current.exit_status)]);
      if (current.comment?.trim()) fields.push(["PBS comment", current.comment]);
      const dependencies = current.dependency_job_ids || [];
      if (dependencies.length) {
        fields.push(["Predecessors", h("ul", dependencies.map(id => {
          const target = jobsById.get(id);
          return h("li", {key: id}, target
            ? h("button", {type: "button", class: "job-id-button", onClick: () => showJob(target)}, id)
            : h("code", id));
        }))]);
      }
      return [
        h("header", {class: "job-details-header"}, [
          h("h2", {id: "job-details-title"}, current.job_id),
          h("button", {type: "button", onClick: copyId}, "Copy ID"),
          h("button", {
            type: "button", "aria-pressed": showDependencies.value,
            onClick: () => { showDependencies.value = !showDependencies.value; },
          }, showDependencies.value ? "Job details" : "Dependencies"),
          h("button", {type: "button", onClick: () => dialog.close(), autofocus: true}, "Close"),
        ]),
        h("div", {role: "status", class: "job-details-copy"}, copyMessage.value),
        previousJobs.value.length
          ? h("button", {type: "button", onClick: () => showJob(previousJobs.value.pop(), false)}, "Back to previous job")
          : null,
        showDependencies.value ? h("div", {class: "dependency-pane"}, [
          h("p", "Links reported in the current cluster snapshot."),
          dependencySection("Upstream · prerequisites", predecessors, current.job_id),
          dependencySection("Downstream · dependent jobs", successors, current.job_id),
        ]) : h("dl", {class: "job-details-fields"}, fields.flatMap(([label, value]) => [
          h("dt", label),
          h("dd", value || "Unknown"),
        ])),
      ];
    },
  });

  function isBackdrop(event) {
    if (event.target !== dialog) return false;
    const {left, right, top, bottom} = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX >= right ||
      event.clientY < top || event.clientY >= bottom;
  }

  let startedOnBackdrop = false;
  dialog.addEventListener("pointerdown", event => {
    startedOnBackdrop = isBackdrop(event);
  });
  dialog.addEventListener("click", event => {
    if (startedOnBackdrop && isBackdrop(event)) dialog.close();
    startedOnBackdrop = false;
  });

  dialog.addEventListener("close", () => {
    app.unmount();
    dialog.remove();
    if (trigger.isConnected) trigger.focus({preventScroll: true});
  }, {once: true});
  document.body.append(dialog);
  app.mount(dialog);
  dialog.showModal();
}
