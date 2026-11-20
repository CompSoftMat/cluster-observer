import {createApp, h, ref} from "./vue.runtime.js";

export function openJobDetails(initialJob, jobsById, trigger) {
  if (!initialJob) return;
  const dialog = document.createElement("dialog");
  dialog.className = "job-details";
  dialog.setAttribute("aria-labelledby", "job-details-title");
  const job = ref(initialJob);
  const previousJobs = ref([]);
  const copyMessage = ref("");
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
      const fields = [
        ["User", current.user_alias ? `${current.user_alias} (${current.user})` : current.user],
        ["Project", current.project],
        ["Queue", current.queue],
        ["Resources", `${resourceCount(current.cpu)} CPU / ${resourceCount(current.gpu)} GPU`],
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
          h("button", {type: "button", onClick: () => dialog.close(), autofocus: true}, "Close"),
        ]),
        h("div", {role: "status", class: "job-details-copy"}, copyMessage.value),
        previousJobs.value.length
          ? h("button", {type: "button", onClick: () => showJob(previousJobs.value.pop(), false)}, "Back to previous job")
          : null,
        h("dl", {class: "job-details-fields"}, fields.flatMap(([label, value]) => [
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
