import {createApp, h} from "./vue.runtime.js";

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
          h("span", {class: "state-help"}, [
            h("button", {
              type: "button",
              class: "state-help-button",
              "aria-label": "State meanings",
              "aria-describedby": "state-meanings",
            }, "?"),
            h("span", {id: "state-meanings", role: "tooltip", class: "state-help-tooltip"}, stateLegend),
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
