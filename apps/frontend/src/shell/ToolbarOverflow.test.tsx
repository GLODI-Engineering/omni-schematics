/**
 * #210: nothing on the toolbar may be unreachable at a narrow width.
 *
 * jsdom computes no layout, so every width here is stated explicitly — which
 * is the only way to assert this at all outside a browser, and is why the row
 * was free to truncate its last control for as long as it did.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolbarOverflow } from "./ToolbarOverflow";

let resizeCallbacks: (() => void)[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  cleanup();
});

const clicks = { alpha: 0, beta: 0, select: 0, wire: 0 };

function Harness() {
  const rowRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="gs-toolbar" role="toolbar" aria-label="Harness" ref={rowRef}>
      <button
        type="button"
        aria-label="Alpha"
        onClick={() => {
          clicks.alpha += 1;
        }}
      >
        A
      </button>
      <button
        type="button"
        aria-label="Beta"
        onClick={() => {
          clicks.beta += 1;
        }}
      >
        B
      </button>
      <div className="gs-toolbar__sep" />
      <div data-toolbar-group="Canvas tools" aria-label="Canvas workbench toolbar">
        <button
          type="button"
          onClick={() => {
            clicks.select += 1;
          }}
        >
          Select
        </button>
        <button
          type="button"
          onClick={() => {
            clicks.wire += 1;
          }}
        >
          Wire
        </button>
      </div>
      <ToolbarOverflow rowRef={rowRef} />
    </div>
  );
}

/** Give the row and every control a width, then let the ResizeObserver fire. */
function layout(rowWidth: number, childWidth = 40) {
  const row = document.querySelector(".gs-toolbar") as HTMLElement;
  Object.defineProperty(row, "clientWidth", { value: rowWidth, configurable: true });
  for (const child of [...row.children] as HTMLElement[]) {
    Object.defineProperty(child, "offsetWidth", {
      value: child.classList.contains("gs-toolbar__sep") ? 9 : childWidth,
      configurable: true,
    });
  }
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
}

describe("ToolbarOverflow", () => {
  beforeEach(() => {
    clicks.alpha = 0;
    clicks.beta = 0;
    clicks.select = 0;
    clicks.wire = 0;
  });

  it("offers no button at all when everything fits", () => {
    render(<Harness />);
    layout(1000);
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
    expect(document.querySelectorAll(".gs-toolbar > [data-overflowed]")).toHaveLength(0);
  });

  it("moves what does not fit behind the ⋯ button instead of truncating it", () => {
    render(<Harness />);
    // Room for one 40 px control plus the 40 px ⋯ button and nothing else.
    layout(90);

    expect(screen.getByRole("button", { name: "More tools" })).toBeTruthy();
    const overflowed = [...document.querySelectorAll(".gs-toolbar > [data-overflowed]")];
    expect(overflowed.length).toBeGreaterThan(0);
    // Alpha is first and stays; Beta is the first casualty.
    expect(screen.getByRole("button", { name: "Alpha" }).hasAttribute("data-overflowed")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Beta" }).hasAttribute("data-overflowed")).toBe(true);
  });

  it("lists a group's tools one by one, not as the container they sit in", () => {
    render(<Harness />);
    layout(90);
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));

    const names = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(names).toContain("Beta");
    expect(names).toContain("Select");
    expect(names).toContain("Wire");
    expect(names).not.toContain("Canvas workbench toolbar");
  });

  it("a menu entry drives the real control, which is still the one in the row", () => {
    render(<Harness />);
    layout(90);
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Wire" }));

    expect(clicks.wire).toBe(1);
    // And the menu closes, so the next click is on the toolbar again.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is reachable from the keyboard", () => {
    render(<Harness />);
    layout(90);
    const more = screen.getByRole("button", { name: "More tools" });
    fireEvent.click(more);

    const items = screen.getAllByRole("menuitem");
    // Focus lands inside the menu rather than being left on the button.
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("lets a control back into the row when the pane widens again", () => {
    render(<Harness />);
    layout(90);
    expect(screen.getByRole("button", { name: "Beta" }).hasAttribute("data-overflowed")).toBe(true);

    // A hidden child measures 0. Without the cached width taken while it was
    // visible, a row that shrank once could never grow back.
    layout(1000);
    expect(screen.getByRole("button", { name: "Beta" }).hasAttribute("data-overflowed")).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
  });

  it("does not leave the row ending on a divider", () => {
    render(<Harness />);
    // 120 px: the row needs 129, and Alpha + Beta + the divider (89) fit
    // inside the 94 px left once the ⋯ button is charged — so the plan stops
    // on the divider, which reads as a group whose contents went missing.
    layout(120);
    const separator = document.querySelector(".gs-toolbar__sep") as HTMLElement;
    expect(separator.hasAttribute("data-overflowed")).toBe(true);
  });

  it("survives a row that has not been laid out yet", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
