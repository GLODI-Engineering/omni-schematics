/**
 * The `⋯` button at the end of the toolbar, and everything behind it.
 *
 * ## Why this is DOM-driven rather than a list of React children
 *
 * The toolbar is assembled by three components — `MainToolbar` holds the File
 * and Run controls and renders `ActiveTabToolbar`, which renders whichever
 * segment the active editor tab registered (`SchematicToolbar` today). A
 * fragment flattens in the DOM but not in `React.Children`, so from
 * `MainToolbar`'s side the whole schematic segment is *one* child. Moving a
 * single rotate button into a menu is therefore not expressible as a slice of
 * children without inverting the registry — which would mean every tab's
 * toolbar becoming an array builder and `EditorTabRegistry` carrying arrays
 * instead of components.
 *
 * So this measures the row's real DOM children, hides the ones past the fold
 * with a class, and lists them in a menu whose entries click the real control.
 * The control is never re-rendered in two places: there is one button, and the
 * menu entry is a remote for it. That also keeps every existing selector
 * working — `.main-toolbar button[aria-label]`, which the integration harness
 * clicks, and `.schematic-toolbar__component`, which the e2e symbol specs
 * measure.
 *
 * ## Why the panel is a portal
 *
 * `.gs-toolbar` keeps `overflow-x: auto` (FE-144's wheel-scroll affordance is
 * still the last resort when a single control is wider than the whole row), and
 * an absolutely positioned panel inside a scroll container is clipped by it. A
 * fixed-position panel on `document.body`, placed from the button's own rect,
 * is not.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./ToolbarControls";
import { type ToolbarMeasure, toolbarVisibleCount } from "./toolbar-overflow";

/** Marks a child that is not a control: a dialog the toolbar happens to host. */
export const TOOLBAR_IGNORE_ATTR = "data-toolbar-ignore";

/** Marks a child that holds several controls, to be listed one by one. */
export const TOOLBAR_GROUP_ATTR = "data-toolbar-group";

/**
 * Marks a control that never moves into the menu.
 *
 * Run carries it. The toolbar can hide anything and stay usable except the
 * button that starts a simulation: someone opening the editor for the first
 * time looks for that one, and "it is behind the ⋯" is not an answer they can
 * arrive at. Its width is charged against the row before anything else is
 * placed, so pinning costs the controls after it rather than overlapping them.
 */
export const TOOLBAR_PIN_ATTR = "data-toolbar-pin";

/**
 * Put on a child the plan has moved into the menu. Hidden by CSS.
 *
 * An attribute rather than a class, because React owns `className` on these
 * children and a toolbar button's class string is not static — `Btn` recomputes
 * it when the control goes active or dangerous, and Run does exactly that the
 * moment a simulation starts. A class added behind React's back is wiped by the
 * next render that touches the prop; an attribute React was never given is not.
 */
export const OVERFLOWED_ATTR = "data-overflowed";

/**
 * What the `⋯` button costs before it exists.
 *
 * The first pass runs with nothing overflowing and so with no button rendered.
 * Charging zero there plans a row that exactly fills the pane, then adds the
 * button — and the control it pushes out never comes back, because the plan
 * that would notice only runs when the pane is resized. The constant is
 * `min-width` plus the row's gap; every later pass measures the real button.
 */
const OVERFLOW_BUTTON_WIDTH = 26;

const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </Icon>
);

interface OverflowEntry {
  key: string;
  label: string;
  pressed: boolean;
  disabled: boolean;
  element: HTMLElement;
}

function outerWidth(element: HTMLElement): number {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  const left = Number.parseFloat(style?.marginLeft ?? "") || 0;
  const right = Number.parseFloat(style?.marginRight ?? "") || 0;
  return element.offsetWidth + left + right;
}

function horizontalPadding(element: HTMLElement): number {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  const left = Number.parseFloat(style?.paddingLeft ?? "") || 0;
  const right = Number.parseFloat(style?.paddingRight ?? "") || 0;
  return left + right;
}

/**
 * The flex gap between controls, charged to each of them.
 *
 * Left out of the first version, and the row still scrolled 21 px at a 706 px
 * pane: twenty children at `gap: 2px` is 40 px the plan knew nothing about.
 * Charging it per item over-counts by exactly one gap, which is the right
 * direction to be wrong in.
 */
function rowGap(element: HTMLElement): number {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  return Number.parseFloat(style?.columnGap ?? "") || 0;
}

/**
 * What to call a control in the menu.
 *
 * Visible text beats `title`, because a toolbar tooltip is a sentence: the
 * canvas tools carry "Wire tool: draw wires with manual bend points — click
 * empty canvas while drawing to add a waypoint…", and a menu of five
 * paragraphs is not a menu. `aria-label` first, since that is the name the
 * button already claims for itself.
 */
function labelOf(element: HTMLElement): string {
  const aria = element.getAttribute("aria-label");
  if (aria && aria.trim() !== "") return aria.trim();
  const own = (element.textContent ?? "").trim();
  if (own !== "") return own;
  const title = element.getAttribute("title");
  if (title && title.trim() !== "") return title.split("  ")[0]?.trim() ?? title.trim();
  return "";
}

/** Every control inside one hidden child: a group contributes all of its buttons. */
function controlsIn(element: HTMLElement, index: number): OverflowEntry[] {
  const describe = (control: HTMLElement, suffix: string): OverflowEntry => ({
    key: `${index}:${suffix}`,
    label: labelOf(control),
    pressed: control.getAttribute("aria-pressed") === "true",
    disabled: (control as HTMLButtonElement).disabled === true,
    element: control,
  });

  if (element.hasAttribute(TOOLBAR_GROUP_ATTR)) {
    return [...element.querySelectorAll<HTMLElement>("button")].map((control, i) =>
      describe(control, String(i)),
    );
  }
  if (element.tagName === "BUTTON") return [describe(element, "0")];
  const inner = element.querySelector<HTMLElement>("button");
  return inner ? [describe(inner, "0")] : [];
}

export interface ToolbarOverflowProps {
  /** The row whose children are measured. */
  rowRef: React.RefObject<HTMLDivElement | null>;
}

export function ToolbarOverflow({ rowRef }: ToolbarOverflowProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /**
   * Widths by child index, recorded while the child was visible.
   *
   * A hidden child measures 0, so a plan recomputed from live measurements
   * alone can never let anything back in as the pane widens — the row would
   * shrink once and stay shrunk. Children keep their order for a given tab,
   * and the cache is dropped whenever the row's child list changes.
   */
  const widths = useRef<number[]>([]);
  const [entries, setEntries] = useState<OverflowEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const button = buttonRef.current;
    const children = ([...row.children] as HTMLElement[]).filter(
      (child) => child !== button && !child.hasAttribute(TOOLBAR_IGNORE_ATTR),
    );

    const gap = rowGap(row);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index] as HTMLElement;
      if (child.hasAttribute(OVERFLOWED_ATTR)) continue;
      const width = outerWidth(child);
      if (width > 0) widths.current[index] = width + gap;
    }

    let pinnedWidth = 0;
    const movable: { index: number; child: HTMLElement; measure: ToolbarMeasure }[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index] as HTMLElement;
      const width = widths.current[index] ?? 0;
      if (child.hasAttribute(TOOLBAR_PIN_ATTR)) {
        pinnedWidth += width;
        continue;
      }
      movable.push({
        index,
        child,
        measure: { width, separator: child.classList.contains("gs-toolbar__sep") },
      });
    }

    const rowWidth = row.clientWidth - horizontalPadding(row);
    const available = Number.isFinite(rowWidth) && rowWidth > 0 ? rowWidth - pinnedWidth : rowWidth;
    const overflowWidth = (button ? outerWidth(button) : OVERFLOW_BUTTON_WIDTH) + gap;
    const visible = toolbarVisibleCount(
      movable.map((entry) => entry.measure),
      available,
      overflowWidth,
    );

    const hidden: OverflowEntry[] = [];
    for (const [position, entry] of movable.entries()) {
      if (position < visible) {
        entry.child.removeAttribute(OVERFLOWED_ATTR);
      } else {
        entry.child.setAttribute(OVERFLOWED_ATTR, "");
        hidden.push(...controlsIn(entry.child, entry.index));
      }
    }

    setEntries((current) => {
      const same =
        current.length === hidden.length &&
        current.every(
          (entry, i) =>
            entry.key === hidden[i]?.key &&
            entry.label === hidden[i]?.label &&
            entry.pressed === hidden[i]?.pressed &&
            entry.disabled === hidden[i]?.disabled,
        );
      return same ? current : hidden;
    });
  }, [rowRef]);

  /**
   * A passive effect, not a layout one.
   *
   * `rowRef` belongs to this component's *parent* — the toolbar div it is the
   * last child of. React attaches host refs bottom-up during the layout phase,
   * so a child's `useLayoutEffect` runs before the parent's ref exists:
   * `rowRef.current` is still null and the observers are never attached. A
   * passive effect runs after the whole commit, by which time it is set.
   */
  useEffect(() => {
    const row = rowRef.current;
    measure();
    if (!row) return;

    const resize = new ResizeObserver(() => measure());
    resize.observe(row);
    // The schematic segment appears and disappears with the active tab, which
    // renumbers every child after it. Cached widths belong to the old numbering.
    const children = new MutationObserver(() => {
      widths.current = [];
      measure();
    });
    children.observe(row, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [measure, rowRef]);

  // Nothing hidden, nothing to offer. The button is not rendered at all rather
  // than disabled: a permanently dead control beside Run is worse than none.
  useEffect(() => {
    if (entries.length === 0) setOpen(false);
  }, [entries.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  if (entries.length === 0) return null;

  function toggle() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
    setOpen((value) => !value);
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>, delta: number) {
    event.preventDefault();
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="gs-toolbar__btn gs-toolbar__overflow"
        title="More tools"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreIcon />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="gs-toolbar__overflow-panel"
              role="menu"
              aria-label="More tools"
              style={{ top: `${anchor?.top ?? 0}px`, right: `${anchor?.right ?? 0}px` }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  buttonRef.current?.focus();
                } else if (event.key === "ArrowDown") {
                  moveFocus(event, 1);
                } else if (event.key === "ArrowUp") {
                  moveFocus(event, -1);
                }
              }}
            >
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  className="gs-toolbar__overflow-item"
                  disabled={entry.disabled}
                  aria-pressed={entry.pressed || undefined}
                  onClick={() => {
                    setOpen(false);
                    entry.element.click();
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default ToolbarOverflow;
