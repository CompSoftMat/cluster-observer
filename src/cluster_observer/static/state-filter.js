import {createApp, h, ref} from "./vue.runtime.js";

const stateLegend = `R — Running
Q — Queued
H — Held
H/DEP — Waiting for dependency
B — Array parent / begun
E — Exiting
S — Suspended
T — In transit
W — Waiting for scheduled execution
U — Suspended by scheduler
M — Moved to another server
X — Finished/deleted array subjob
F or C — Finished
/OK — Completed successfully
/ERR — Failed
/CAN — Explicitly cancelled
/? — Finished; outcome unknown

Hover a badge for exit codes and predecessor IDs. Completion refers to the job or segment. Whole-chain progress requires campaign metadata.`;

const StateFilter = {
  props: ["states", "selected"],
  setup(props) {
    const tooltip = ref(null);

    function positionTooltip(event) {
      const anchor = event.currentTarget.getBoundingClientRect();
      const popup = tooltip.value;
      const margin = 8;
      const below = Math.max(0, window.innerHeight - anchor.bottom - margin);
      const above = Math.max(0, anchor.top - margin);
      const openAbove = popup.scrollHeight > below && above > below;
      popup.style.maxHeight = `${openAbove ? above : below}px`;
      popup.style.left = `${Math.max(margin, Math.min(anchor.left, document.documentElement.clientWidth - popup.offsetWidth - margin))}px`;
      popup.style.top = `${openAbove ? anchor.top - popup.offsetHeight : anchor.bottom}px`;
    }

    return () => {
      const options = [h("option", {value: ""}, "All states")];
      if (props.selected && !props.states.some(state => state.value === props.selected)) {
        options.push(h("option", {value: props.selected}, `${props.selected} (0)`));
      }
      for (const state of props.states) {
        options.push(h("option", {value: state.value}, `${state.label || state.value} (${state.count})`));
      }
      return [
        h("div", {class: "state-filter-label"}, [
          h("label", {for: "state-filter"}, "State"),
          h("span", {class: "state-help", onPointerenter: positionTooltip, onFocusin: positionTooltip}, [
            h("button", {
              type: "button",
              class: "state-help-button",
              "aria-label": "State meanings",
              "aria-describedby": "state-meanings",
            }, "?"),
            h("span", {ref: tooltip, id: "state-meanings", role: "tooltip", class: "state-help-tooltip"}, stateLegend),
          ]),
        ]),
        h("select", {id: "state-filter", value: props.selected, "data-filter-key": "state"}, options),
      ];
    };
  },
};

export function mountStateFilter(node, states, selected) {
  const app = createApp(StateFilter, {states, selected});
  app.mount(node);
  return () => app.unmount();
}
