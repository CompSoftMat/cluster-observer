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

function connectedJobs(root, linksFor) {
  const seen = new Set([root]);
  const stack = [];
  stack.push(root);
  while (stack.length) {
    for (const {id} of linksFor(stack.pop())) {
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(id);
    }
  }
  return seen;
}

function layoutDependencyGraph(selected, predecessors, successors) {
  const ids = connectedJobs(selected, id => [
    ...(predecessors.get(id) || []), ...(successors.get(id) || []),
  ]);
  const remaining = new Map([...ids].map(id => [id, (predecessors.get(id) || []).length]));
  const levels = new Map();
  const ready = [...ids].filter(id => remaining.get(id) === 0);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    for (const link of successors.get(id) || []) {
      levels.set(link.id, Math.max(levels.get(link.id) || 0, (levels.get(id) || 0) + 1));
      remaining.set(link.id, remaining.get(link.id) - 1);
      if (remaining.get(link.id) === 0) ready.push(link.id);
    }
  }
  const lanes = new Map();
  const nodes = new Map();
  for (const id of ids) {
    const level = levels.get(id) || 0;
    const lane = lanes.get(level) || 0;
    nodes.set(id, {x: 8 + level * 225, y: 8 + lane * 78});
    lanes.set(level, lane + 1);
  }
  return nodes;
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

  function dependencyGraph(selected) {
    const nodes = layoutDependencyGraph(selected, predecessors, successors);
    const upstream = connectedJobs(selected, id => predecessors.get(id) || []);
    const edges = [];
    const cards = [];
    let width = 0;
    let height = 0;
    for (const [id, {x, y}] of nodes) {
      width = Math.max(width, x + 188);
      height = Math.max(height, y + 70);
      const target = jobsById.get(id);
      const running = id !== selected && upstream.has(id) && (target?.state || "").toUpperCase() === "R";
      const links = predecessors.get(id) || [];
      for (const link of links) {
        const parent = nodes.get(link.id);
        const start = parent.x + 180;
        const bend = x > start ? (x + start) / 2 : Math.max(x, parent.x) + 194;
        const end = x > start ? x : x + 180;
        const top = parent.y + 30;
        const bottom = y + 30;
        width = Math.max(width, bend + 8);
        for (const [left, lineTop, w, lineHeight] of [
          [Math.min(start, bend), top, Math.abs(bend - start), 1],
          [bend, Math.min(top, bottom), 1, Math.abs(bottom - top)],
          [Math.min(bend, end), bottom, Math.abs(end - bend), 1],
        ]) {
          edges.push(h("span", {class: "dependency-edge", "aria-hidden": "true",
            style: {left: left + "px", top: lineTop + "px", width: w + "px", height: lineHeight + "px"}}));
        }
      }
      const status = target?.status_label || target?.state || "Outside snapshot";
      const types = [...new Set(links.map(link => link.type).filter(Boolean))].join(", ");
      cards.push(h(target ? "button" : "div", {
        key: id,
        class: ["dependency-node", {selected: id === selected, running}],
        style: {left: x + "px", top: y + "px"},
        ...(target ? {type: "button", onClick: () => showJob(target), "aria-pressed": id === selected} : {}),
        title: [id, status, ...links.map(link => `${link.type || "depends on"}: ${link.id}`)].join("\n"),
      }, [
        h("code", id),
        h("small", [id === selected ? "Selected" : running ? "Running prerequisite" : status, types].filter(Boolean).join(" · ")),
      ]));
    }
    function centerSelected({el}) {
      const node = nodes.get(selected);
      el.scrollLeft = node.x - (el.clientWidth - 180) / 2;
      el.scrollTop = node.y - (el.clientHeight - 60) / 2;
    }
    return h("div", {key: selected, class: "dependency-viewport", tabindex: 0,
      "aria-label": "Dependency graph", onVnodeMounted: centerSelected}, [
      h("div", {class: "dependency-graph", style: {width: width + "px", height: height + "px"}}, [...edges, ...cards]),
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
          h("p", "Prerequisites → dependent jobs · current snapshot"),
          dependencyGraph(current.job_id),
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
