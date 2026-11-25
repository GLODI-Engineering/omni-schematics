import { registerBottomTab } from "../shell/registries/BottomTabRegistry";
import { useIpcStore } from "../store";
import { OutputView } from "./OutputView";

let registered = false;

/**
 * Register the Output bottom tab (#170).
 *
 * Order 20, so it sits before Problems (40) — the order the keyboard
 * shortcuts imply, and `shell.focus-output` names this one.
 */
export function registerOutputSurface(): void {
  if (registered) {
    return;
  }
  registerBottomTab({
    id: "core.output",
    label: "Output",
    component: OutputView,
    order: 20,
    badge: () => {
      const count = useIpcStore.getState().output.length;
      return count === 0 ? null : count;
    },
  });
  registered = true;
}

export default registerOutputSurface;
