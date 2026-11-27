/**
 * The condition decision 0010 rests on (gsim-core#110).
 *
 * The split made two owners out of one file. Two owners can drift, and drift between a symbol
 * and a specification is this project's recurring defect. So the split is only safe while
 * something asserts agreement, and this is that something, in two halves:
 *
 *   `the-editor-owns-what-it-draws.test.ts`   this repository's half against the engine's
 *   here                                      the engine's two answers against each other
 *
 * The second half is the one a reader will not expect. The engine answers twice about the same
 * component -- `gsim_py.catalog()` from a data file, `gsim_py.capabilities()` from Rust code --
 * and nothing compared those two answers until gsim-core#110, because before the split there
 * was one file and any comparison would have been a file against a copy of itself.
 *
 * It found that two components declare their four terminals in one order and write them in
 * another (#281), that three composites' terminal order is checked by nothing (#282), and that
 * six parameters are offered in an inspector and read by no card (#283) -- one of them a
 * capacitor's `IC`, which is on the owner's own list of defects from a real simulation.
 *
 * Every rule below is exercised by breaking the input on purpose. A rule nobody has watched
 * fail is a rule nobody knows works.
 */

import { describe, expect, it } from "vitest";

import {
  DISPLAY_FIELDS,
  KNOWN_DISAGREEMENTS,
  agreementFindings,
  catalogueDisagreements,
} from "../../../../scripts/catalogue-agreement.mjs";
import displayCatalog from "./display-catalog.json" with { type: "json" };
import capabilities from "./engine-capabilities.json" with { type: "json" };
import engineCatalog from "./engine-catalog.json" with { type: "json" };

/**
 * The engine's component library, as `gsim_py.catalog()` gives it.
 *
 * Reconstructed from the committed copy rather than read from a file of its own, because the
 * generator reshapes the submission into what `loadCatalog` takes. The four fields used here
 * -- `id`, `compiles_to`, `ports`, `params` -- are passed through verbatim by that reshaping
 * (as `engineId`, `engineType`, and untouched `...rest`), so this is the engine's own answer
 * and not a rewriting of it. The capabilities file needs no reconstruction: it is committed
 * exactly as the engine sends it.
 */
type Meta = {
  engineId: string;
  engineType: string | null;
  ports?: unknown;
  params?: unknown;
};
const ENGINE_CATALOG = {
  components: (engineCatalog as { metadata: Meta }[]).map(({ metadata }) => ({
    id: metadata.engineId,
    compiles_to: metadata.engineType,
    ports: metadata.ports,
    params: metadata.params,
  })),
};

/** A deep copy, so one test's deliberate damage cannot reach the next one's input. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Catalog = typeof ENGINE_CATALOG;
type Component = Catalog["components"][number] & {
  ports?: { inputs?: Record<string, unknown>[]; outputs?: Record<string, unknown>[] };
  params?: { id?: string; name?: string }[];
};
type Capabilities = {
  types: {
    type: string;
    node_ports: string[];
    output_ports: string[];
    dynamic_outputs: boolean;
    emits: { card: string };
    params: { param: string; required?: boolean }[];
  }[];
};

const component = (catalog: Catalog, id: string): Component => {
  const found = catalog.components.find((c) => c.id === id) as Component | undefined;
  if (found === undefined) throw new Error(`${id} is not in the engine's catalogue`);
  return found;
};
const registryType = (caps: Capabilities, type: string) => {
  const found = caps.types.find((t) => t.type === type);
  if (found === undefined) throw new Error(`${type} is not in the compile registry`);
  return found;
};
const rulesFor = (findings: string[], id: string) =>
  findings.filter((f) => f.split("|")[1] === id).map((f) => f.split("|")[0]);

describe("the compiler agrees with itself about a component (gsim-core#110)", () => {
  it("has no disagreement that is not already filed", () => {
    const { unexpected } = catalogueDisagreements(ENGINE_CATALOG, capabilities);
    expect(unexpected).toEqual([]);
  });

  it("has no filed disagreement that has quietly been fixed", () => {
    // The half that keeps a ratchet from becoming a list of things that used to be wrong:
    // repairing a disagreement and leaving it in the table fails too, so the table only ever
    // describes the present.
    const { repaired } = catalogueDisagreements(ENGINE_CATALOG, capabilities);
    expect(repaired).toEqual([]);
  });

  it("checked a real number of components, terminals, outputs and parameters", () => {
    // Asserted before the two empty results above are believed. A loop that runs zero times
    // reports agreement, and that is the shape of every gate this repository has shipped green
    // while checking nothing -- four of them, the most recent found this week.
    const { checked } = agreementFindings(ENGINE_CATALOG, capabilities);
    expect(checked.components).toBeGreaterThan(60);
    expect(checked.terminals).toBeGreaterThan(40);
    expect(checked.outputs).toBeGreaterThan(40);
    expect(checked.params).toBeGreaterThan(150);
  });

  it("reports nothing at all when handed nothing, which is why the counts are asserted", () => {
    // The hazard, written down rather than left for the next reader to discover: the rules
    // cannot tell "everything agrees" from "there was nothing to look at". Only the counts can.
    const { findings, checked } = agreementFindings({ components: [] }, capabilities);
    expect(findings).toEqual([]);
    expect(checked.components).toBe(0);
  });
});

describe("each rule, watched failing", () => {
  it("names a component whose compile target the registry does not list", () => {
    const catalog = clone(ENGINE_CATALOG);
    component(catalog, "passive.resistor").compiles_to = "passive.unobtanium";
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "passive.resistor")).toContain("unknown-type");
  });

  it("names terminals written in an order the catalogue does not declare", () => {
    // The rule that found #281. A SPICE card is positional, so `p n` and `n p` are a resistor
    // the right way round and a resistor with its terminals exchanged -- and for a two-terminal
    // passive that is invisible, while for the four-terminal dependent sources it exchanges the
    // controlling pair with the output pair.
    const caps = clone(capabilities) as Capabilities;
    registryType(caps, "passive.resistor").node_ports = ["n", "p"];
    const { findings } = agreementFindings(ENGINE_CATALOG, caps);
    expect(rulesFor(findings, "passive.resistor")).toContain("terminal-order");
    expect(findings.join("\n")).toContain("the catalogue draws p n and the card writes n p");
  });

  it("names a terminal the catalogue declares and the card never writes", () => {
    const catalog = clone(ENGINE_CATALOG);
    const resistor = component(catalog, "passive.resistor");
    resistor.ports?.inputs?.push({
      id: "body",
      kind: { domain: "physical-electrical" },
      side: "top",
      offset: 10,
    });
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "passive.resistor")).toContain("terminal-order");
  });

  it("names a port drawn as a circuit node and compiled as a signal", () => {
    // gsim-core#90's shape, which is what `converter.sig2phys` does today: an output wired into
    // a circuit node becomes a node nothing drives, and the two answers say so plainly when
    // anyone compares them.
    const caps = clone(capabilities) as Capabilities;
    registryType(caps, "passive.resistor").output_ports = ["p"];
    const { findings } = agreementFindings(ENGINE_CATALOG, caps);
    expect(rulesFor(findings, "passive.resistor")).toContain("port-nature");
  });

  it("names a signal output the catalogue does not offer", () => {
    const catalog = clone(ENGINE_CATALOG);
    const gain = component(catalog, "control.gain");
    if (gain.ports?.outputs !== undefined) gain.ports.outputs = [];
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "control.gain")).toContain("signal-outputs");
  });

  it("names a value the card requires that no field offers", () => {
    // The direction that catches a stale editor: the engine starts needing something and the
    // inspector has nowhere to type it, so every placed component compiles with a default.
    const catalog = clone(ENGINE_CATALOG);
    component(catalog, "passive.resistor").params = [];
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "passive.resistor")).toContain("required-param-undeclared");
  });

  it("names a field a user can fill in for nothing", () => {
    // The rule that found #283, in gsim-core#110's own words: "a symbol offering a field the
    // compiler will not read is a field a user fills in for nothing."
    const catalog = clone(ENGINE_CATALOG);
    component(catalog, "passive.resistor").params?.push({ id: "tolerance", name: "tolerance" });
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "passive.resistor")).toContain("param-never-read");
  });

  it("fails when a filed disagreement is fixed and left in the table", () => {
    const caps = clone(capabilities) as Capabilities;
    // Repair #281 on one of the two: declare the terminals in the order the catalogue draws.
    registryType(caps, "source.dependent.vcvs").node_ports = ["cp", "cn", "p", "n"];
    const { repaired, unexpected } = catalogueDisagreements(ENGINE_CATALOG, caps);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toContain("source.dependent.vcvs");
    expect(unexpected).toEqual([]);
  });

  it("says nothing about a component that compiles to nothing", () => {
    // Not an exemption to apologise for: a universal component is resolved away before any
    // target is called (gsim-core decision 0006), so no card is written, no terminal is
    // positional and no parameter is read. There is nothing for the registry to agree with.
    const catalog = clone(ENGINE_CATALOG);
    const ground = component(catalog, "routing.ground");
    ground.params = [{ id: "nonsense", name: "nonsense" }];
    expect(registryType(capabilities as Capabilities, "routing.ground").emits.card).toBe("nothing");
    const { findings } = agreementFindings(catalog, capabilities);
    expect(rulesFor(findings, "routing.ground")).toEqual([]);
  });
});

describe("the six fields this repository owns, and only those", () => {
  it("lists the fields decision 0010 moved here", () => {
    expect([...DISPLAY_FIELDS].sort()).toEqual([
      "category",
      "description",
      "label",
      "main_param",
      "symbol",
      "tags",
    ]);
  });

  it("keeps the display catalogue to those six", () => {
    // A compile fact that drifts into this file has two owners again, and this file is the one
    // a human edits -- so a `ports` or a `params` added here by hand would be the easiest way
    // to undo the split. `gen-engine-catalog.mjs` refuses the mirror image of this: an engine
    // submission that declares one of the six.
    const owned = new Set(DISPLAY_FIELDS);
    const strays: string[] = [];
    let checked = 0;
    for (const [id, entry] of Object.entries(displayCatalog.components)) {
      checked += 1;
      for (const field of Object.keys(entry)) {
        if (!owned.has(field)) strays.push(`${id}.${field}`);
      }
    }
    expect(checked).toBeGreaterThan(70);
    expect(strays).toEqual([]);
  });

  it("files every disagreement it tolerates", () => {
    // A known entry with no issue behind it is an excuse, and the difference matters: the
    // reason this gate could land green is that all thirteen have somewhere to go.
    const unexplained = Object.entries(KNOWN_DISAGREEMENTS).filter(
      ([, why]) => !/#\d+/.test(why as string),
    );
    expect(unexplained).toEqual([]);
    expect(Object.keys(KNOWN_DISAGREEMENTS).length).toBeGreaterThan(0);
  });
});
