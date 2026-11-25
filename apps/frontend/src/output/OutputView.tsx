/**
 * The bottom panel's Output tab.
 *
 * ## Why this file exists at all (#170)
 *
 * `focusBottomTab("core.output")` sets the panel visible and the active tab to
 * an id **nothing registered**, and `BottomPanel` renders the component the
 * registry holds for the active id — so pressing Run, `Ctrl+Shift+U` or
 * `Ctrl+2` opened the panel onto nothing and it rendered `null`, including the
 * tab strip, leaving no way to click across to Problems either. The types and
 * `BottomTabRegistry.test.ts` both said `core.output` existed while no code
 * created it, which is why nothing caught it.
 *
 * `docs/DEVELOPMENT.md` still lists `output/LogView.test.tsx` and
 * `output/OutputTab.test.tsx` against a directory that did not exist, so an
 * Output tab was here once and was removed without its callers. This is it
 * back, registered, with the invariant tested.
 *
 * ## What it shows, and what the VS Code Output panel shows
 *
 * Both, deliberately, and they are not the same thing. VS Code's Output panel
 * is where a run's output belongs when there is a VS Code (#139): it has
 * levels, a filter and a gear menu, and the extension host writes the solver's
 * two streams into it as they arrive. This tab is `useIpcStore.output` — what
 * the editor itself appended, netlist included — and it is the only Output a
 * browser-hosted shell has at all, where there is no host to forward to.
 */
import { useEffect, useRef } from "react";

import { useIpcStore } from "../store";

export function OutputView() {
  const lines = useIpcStore((state) => state.output);
  const bottom = useRef<HTMLDivElement | null>(null);

  // Follow the tail, which is where a run's newest line is. Only when the
  // lines change, so a user who scrolled up to read a netlist is not yanked
  // back by an unrelated re-render.
  useEffect(() => {
    // Guarded because jsdom does not implement it — unguarded, every test that
    // renders this tab fails inside a passive effect with a stack that names
    // React rather than this line.
    const element = bottom.current;
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "end" });
    }
  }, [lines.length]);

  if (lines.length === 0) {
    return <div className="output-view__empty">No output yet. Run a simulation.</div>;
  }

  return (
    <div className="output-view" aria-label="Output">
      {lines.map((text, index) => (
        // The index is the identity: these are append-only log lines, two of
        // which are routinely identical ("" between sections), so the text
        // cannot be the key.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
        <div className="output-view__line" key={index}>
          {text === "" ? " " : text}
        </div>
      ))}
      <div ref={bottom} />
    </div>
  );
}

export default OutputView;
