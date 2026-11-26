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
    expect(
      screen.getByRole("button", { name: "Step (legacy spelling) (signal_flow.source.step)" }),
    ).toBeTruthy();
    expect(container.querySelector(".library-item__qualifier")?.textContent).toBe(
      "signal_flow.source.step",
    );
  });
});

describe("#213: two blocks with the same label are told apart", () => {
  it("has nothing left to qualify: the engine stopped shipping colliding labels", () => {
    // This asserted the opposite until gsim-core 0.6.3, which renamed the two
    // legacy entries to "Step (legacy spelling)" and "Scope (legacy spelling)"
    // (gsim-core#83). Fixing the data beats working around it at display time,
    // so the stronger thing to guard now is that the data stays fixed: a new
    // collision upstream fails here rather than quietly turning the workaround
    // back on.
    const qualifiers = qualifiersForCollidingLabels(Object.values(CATALOG));
    expect([...qualifiers.keys()]).toEqual([]);
  });

  it("still qualifies a collision, for the day one is introduced", () => {
    // The mechanism is tested on a pair of its own rather than on catalogue
    // entries, so that it keeps being tested after the catalogue is corrected.
    const qualifiers = qualifiersForCollidingLabels([
      { name: "a.thing", label: "Thing" },
      { name: "b.thing", label: "Thing" },
      { name: "c.other", label: "Other" },
    ]);
    expect(qualifiers.get("a.thing")).toBe("a.thing");
    expect(qualifiers.get("b.thing")).toBe("b.thing");
    // A label nothing else shares is left alone — qualifying every row would
    // double the text in a 282 px panel for no information.
    expect(qualifiers.get("c.other")).toBeUndefined();
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
    // Distinct, which is the thing that matters, and distinct in the engine's
    // own labels rather than through a qualifier appended here: gsim-core
    // 0.6.3 named the legacy spelling for what it is.
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("Step");
    expect(names).toContain("Step (legacy spelling)");
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
