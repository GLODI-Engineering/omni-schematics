/**
 * #213 — what a row in the Block Library has to say, and how little room it
 * may take saying it.
 *
 * Measured in a real VS Code before this change: a 282 px panel, 68 entries,
 * rows 56 px tall, a 4472 px list and nine components visible at a time. Two
 * rows read "Step" and two read "Scope", and each row's accessible name was a
 * run-on of the symbol's port labels ("Stepout port, signal, outStep").
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useLibraryStore } from "../store";
import { LibraryActivity } from "./LibraryActivity";
import { SidebarItem } from "./SidebarItem";
import { loadCatalogFromManifest } from "./catalog";
import { qualifiersForCollidingLabels } from "./duplicate-labels";

const CATALOG = loadCatalogFromManifest();

afterEach(cleanup);

describe("#213: a row names one component and nothing else", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      catalog: CATALOG,
      activeSimulator: "general-simulator",
      recentlyUsed: [],
    });
  });

  it("the accessible name is the component, not its port labels", () => {
    const resistor = CATALOG["passive.resistor"];
    if (!resistor) throw new Error("catalogue has no passive.resistor");
    render(<SidebarItem entry={resistor} onInsert={() => {}} />);
    const button = screen.getByRole("button", { name: "Resistor" });
    expect(button.getAttribute("aria-label")).toBe("Resistor");
  });

  it("shows the component's picture as a tile, not the canvas symbol", () => {
    const resistor = CATALOG["passive.resistor"];
    if (!resistor) throw new Error("catalogue has no passive.resistor");
    const { container } = render(<SidebarItem entry={resistor} onInsert={() => {}} />);
    expect(container.querySelector("svg.block-tile")).not.toBeNull();
    expect(container.querySelector("svg.block-symbol")).toBeNull();
  });

  it("a qualified row says which block it is, in its name and on screen", () => {
    const step = CATALOG["signal_flow.source.step"];
    if (!step) throw new Error("catalogue has no signal_flow.source.step");
    const { container } = render(
      <SidebarItem entry={step} onInsert={() => {}} qualifier="signal_flow.source.step" />,
    );
    expect(screen.getByRole("button", { name: "Step (signal_flow.source.step)" })).toBeTruthy();
    expect(container.querySelector(".library-item__qualifier")?.textContent).toBe(
      "signal_flow.source.step",
    );
  });
});

describe("#213: two blocks with the same label are told apart", () => {
  it("qualifies only the labels that actually collide", () => {
    const entries = Object.values(CATALOG);
    const qualifiers = qualifiersForCollidingLabels(entries);
    expect(qualifiers.get("signal.step")).toBe("signal.step");
    expect(qualifiers.get("signal_flow.source.step")).toBe("signal_flow.source.step");
    expect(qualifiers.get("sinks.scope")).toBe("sinks.scope");
    expect(qualifiers.get("signal_flow.sink.scope")).toBe("signal_flow.sink.scope");
    // A label nothing else shares is left alone — qualifying every row would
    // double the text in a 282 px panel for no information.
    expect(qualifiers.get("math.table_lookup")).toBeUndefined();
    expect(qualifiers.get("passive.resistor")).toBeUndefined();
  });

  it("gives the panel's two Step rows different accessible names", () => {
    useLibraryStore.setState({
      catalog: CATALOG,
      activeSimulator: "general-simulator",
      recentlyUsed: [],
    });
    render(<LibraryActivity />);
    const steps = screen.getAllByRole("button", { name: /^Step/ });
    const names = steps.map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("Step (signal.step)");
    expect(names).toContain("Step (signal_flow.source.step)");
  });
});

describe("#213: the panel does not repeat what VS Code's own title bar says", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      catalog: CATALOG,
      activeSimulator: "general-simulator",
      recentlyUsed: [],
    });
  });

  it("drops the in-webview 'Block Library' heading", () => {
    // The view's `contextualTitle` already renders "Omni Schematics: Block
    // Library" above the webview, and it truncates; a second copy inside cost
    // a row and a half of list.
    const { container } = render(<LibraryActivity />);
    expect(container.textContent).not.toContain("Block Library");
  });

  it("keeps the entry count, in the search box rather than on a line of its own", () => {
    render(<LibraryActivity />);
    const search = screen.getByLabelText("Search components");
    expect(search.getAttribute("placeholder")).toMatch(/Search \d+ components/);
  });
});

describe("#213: a family of one is not a family", () => {
  it("keeps 'Coupled Inductors' called that", () => {
    // `familyKey` groups `passive.inductor.*` as inductor variants, and
    // `passive.inductor.coupled` is the only member — so the collapse renamed
    // a four-terminal coupled pair "Inductor", which then collided with the
    // real `passive.inductor` and both rows had to be qualified to be told
    // apart. A group with one member has nothing to collapse.
    useLibraryStore.setState({
      catalog: CATALOG,
      activeSimulator: "general-simulator",
      recentlyUsed: [],
    });
    render(<LibraryActivity />);
    expect(screen.getByRole("button", { name: "Coupled Inductors" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Inductor/ })).toHaveLength(1);
  });
});
