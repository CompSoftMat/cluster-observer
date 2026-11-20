import {createApp, h, ref} from "./vue.runtime.js";

const stateLegend = [
  ["R", "Running"],
  ["Q", "Queued"],
  ["H", "Held"],
  ["H/DEP", "Waiting for dependency"],
  ["B", "Array parent / begun"],
  ["E", "Exiting"],
  ["S", "Suspended"],
  ["T", "In transit"],
  ["W", "Waiting for scheduled execution"],
  ["U", "Suspended by scheduler"],
  ["M", "Moved to another server"],
  ["X", "Finished/deleted array subjob"],
  ["F or C", "Finished"],
  ["/OK", "Completed successfully"],
  ["/ERR", "Failed"],
  ["/CAN", "Explicitly cancelled"],
  ["/?", "Finished; outcome unknown"],
];

const StateFilter = {
  props: ["states", "selected", "onSelect"],
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
      return [
        h("div", {class: "state-filter-label"}, [
          h("label", {for: "state-filter"}, "State"),
          h("div", {class: "state-help", onPointerenter: positionTooltip, onFocusin: positionTooltip}, [
            h("button", {
              type: "button",
              class: "state-help-button",
              "aria-label": "State meanings",
              "aria-describedby": "state-meanings",
            }, "?"),
            h("div", {ref: tooltip, id: "state-meanings", role: "tooltip", class: "state-help-tooltip"}, [
              h("dl", {class: "state-legend"}, stateLegend.flatMap(([code, meaning]) => [
                h("dt", h("code", code)),
                h("dd", meaning),
              ])),
              h("p", {class: "state-legend-note"}, "Hover a badge for exit codes and predecessor IDs. Completion refers to the job or segment. Whole-chain progress requires campaign metadata."),
            ]),
          ]),
        ]),
        h("details", {class: "state-choices"}, [
          h("summary", {id: "state-filter"}, props.selected.map(value =>
            props.states.find(state => state.value === value)?.label || value
          ).join(", ") || "All states"),
          h("div", {class: "state-choice-list"}, [
            h("button", {type: "button", onClick: () => props.onSelect([])}, "All states"),
            ...props.states.map(state => h("label", {key: state.value}, [
              h("input", {
                type: "checkbox",
                value: state.value,
                checked: props.selected.includes(state.value),
                onChange: event => {
                  const next = props.selected.filter(value => value !== state.value);
                  if (event.target.checked) next.push(state.value);
                  props.onSelect(next, state.value);
                },
              }),
              `${state.label || state.value} (${state.count})`,
            ])),
          ]),
        ]),
      ];
    };
  },
};

export function mountStateFilter(node, states, selected, onSelect) {
  const app = createApp(StateFilter, {states, selected, onSelect});
  app.mount(node);
  return () => app.unmount();
}
