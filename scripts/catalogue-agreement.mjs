/**
 * Does the compiler agree with itself about a component, and does this editor agree with it?
 *
 * gsim-core decision 0010 split the catalogue: the compiler declares which components it
 * supports and what each one needs, this repository owns how one is drawn and described.
 * Two owners can drift, and **drift between a symbol and a specification is this project's
 * recurring defect** -- the signal-domain port mismatches the owner reported were exactly
 * that, and they happened while a single file was supposedly preventing it. A single file
 * prevented nothing. This does (gsim-core#110).
 *
 * The two sides compared here are not a file and a copy of itself, which is what made this
 * check impossible before the split and worthless if done carelessly. They are the engine's
 * **two independent answers** about the same component:
 *
 *   gsim_py.catalog()       the component library -- a data file: ports, their domains,
 *                           their order, the parameters an inspector offers
 *   gsim_py.capabilities()  the compile registry -- Rust code: the card each type emits,
 *                           the terminals it writes positionally, the parameters it reads
 *
 * A netlist is positional, so `p n cp cn` and `cp cn p n` are different circuits. Nothing
 * compared those two lists until this file, and they disagree for two components.
 *
 * Pure on purpose: `gen-engine-catalog.mjs` runs it against the live engine, and
 * `the-compiler-and-the-editor-agree.test.ts` runs it against the committed answers and
 * mutates them to prove every rule still bites.
 */

/**
 * The six fields decision 0010 moved to this repository: what a component looks like and is
 * called, as opposed to what it compiles to. gsim-core 0.7.1 stopped declaring them (its
 * #115). The generator refuses a submission that declares one again, because two owners of a
 * label is exactly the drift the split was made to end.
 */
export const DISPLAY_FIELDS = Object.freeze([
  "label",
  "category",
  "description",
  "tags",
  "main_param",
  "symbol",
]);

/** Parameters that say what a block's ports *are*, which the editor draws and no card reads. */
const PORT_SHAPING_PARAMS = new Set(["input_names", "output_names", "n_inputs", "n_operands"]);

const domainOf = (port) => port?.kind?.domain ?? "";
const isPhysical = (port) => domainOf(port).startsWith("physical");
const isSignal = (port) => domainOf(port) === "signal";
const portList = (metadata, group) => {
  const list = metadata.ports?.[group];
  return Array.isArray(list) ? list : [];
};

/**
 * Every disagreement between the two answers, as stable `rule|id|detail` keys.
 *
 * Keys rather than prose so a known one can be named exactly in `KNOWN_DISAGREEMENTS`: a
 * ratchet needs an identity it can match, and a sentence that gets reworded is not one.
 */
export function agreementFindings(catalog, capabilities) {
  const types = new Map((capabilities.types ?? []).map((type) => [type.type, type]));
  const findings = [];
  // A rule that checks nothing reports success. These are asserted by the caller before the
  // empty result is believed -- this repository has shipped four gates that were green
  // because their loop never ran.
  const checked = { components: 0, terminals: 0, outputs: 0, params: 0 };

  for (const entry of catalog.components ?? []) {
    const id = entry.id;
    const compilesTo = entry.compiles_to ?? null;
    if (compilesTo === null) continue;

    const registry = types.get(compilesTo);
    if (registry === undefined) {
      findings.push(
        `unknown-type|${id}|compiles_to ${compilesTo}, which the registry does not list`,
      );
      continue;
    }
    checked.components += 1;

    const card = registry.emits?.card ?? "nothing";
    // `card: "nothing"` is a universal component: gsim-core resolves it away before any
    // target is called (decision 0006), so no card is written, no terminal is positional and
    // no parameter is read. There is nothing for the registry to agree with, and that is the
    // right answer rather than an exemption to apologise for.
    if (card === "nothing") continue;

    const terminals = [...portList(entry, "inputs"), ...portList(entry, "outputs")];
    const physical = terminals.filter(isPhysical).map((port) => port.id);
    const nodePorts = registry.node_ports ?? [];

    if (physical.length > 0 || nodePorts.length > 0) {
      checked.terminals += Math.max(physical.length, nodePorts.length);
      if (card === "composite" && nodePorts.length === 0) {
        // A composite emits several cards, so the registry has no single positional terminal
        // list to declare. The catalogue's terminals are then unchecked -- said out loud
        // rather than skipped, because three components rely on it.
        findings.push(
          `terminal-order-unchecked|${id}|a composite card declares no terminal list, so ` +
            `${physical.join(" ")} is checked by nothing`,
        );
      } else if (physical.join(" ") !== nodePorts.join(" ")) {
        findings.push(
          `terminal-order|${id}|the catalogue draws ${physical.join(" ") || "(none)"} and the ` +
            `card writes ${nodePorts.join(" ") || "(none)"}`,
        );
      }
    }

    // A port's *nature*: the catalogue says what domain a terminal carries, the registry says
    // whether it is a node the netlist names or a signal the block drives. One port cannot be
    // both, and a port that is drawn as one and compiled as the other is gsim-core#90's shape.
    const signalOutputs = portList(entry, "outputs")
      .filter(isSignal)
      .map((port) => port.id);
    const outputPorts = registry.output_ports ?? [];
    for (const port of terminals.filter(isPhysical)) {
      if (outputPorts.includes(port.id)) {
        findings.push(
          `port-nature|${id}|'${port.id}' is drawn as ${domainOf(port)} and compiled as a ` +
            "signal output",
        );
      }
    }
    // Only when the count is fixed. `dynamic_outputs` means the engine derives the ports from
    // the block's own parameters, so the registry's list is a floor and not the answer.
    if (!registry.dynamic_outputs) {
      checked.outputs += Math.max(signalOutputs.length, outputPorts.length);
      const nature = new Set(terminals.filter(isPhysical).map((port) => port.id));
      const expected = outputPorts.filter((name) => !nature.has(name));
      if (signalOutputs.join(" ") !== expected.join(" ")) {
        findings.push(
          `signal-outputs|${id}|the catalogue offers ${signalOutputs.join(" ") || "(none)"} and ` +
            `the card drives ${expected.join(" ") || "(none)"}`,
        );
      }
    }

    const declared = (entry.params ?? []).map((param) => param.id ?? param.name);
    const read = (registry.params ?? []).map((param) => param.param);
    const required = (registry.params ?? [])
      .filter((param) => param.required)
      .map((param) => param.param);
    checked.params += declared.length;

    // The direction that catches a stale editor: the card needs a value no inspector collects.
    for (const name of required) {
      if (!declared.includes(name)) {
        findings.push(
          `required-param-undeclared|${id}|the card reads '${name}' and no field offers it`,
        );
      }
    }
    // And the direction #110 names: "a symbol offering a field the compiler will not read is
    // a field a user fills in for nothing."
    for (const name of declared) {
      if (read.includes(name)) continue;
      if (registry.dynamic_outputs && PORT_SHAPING_PARAMS.has(name)) continue;
      if (PORT_SHAPING_PARAMS.has(name)) continue;
      findings.push(`param-never-read|${id}|'${name}' is offered and no card reads it`);
    }
  }

  return { findings: findings.sort(), checked };
}

/**
 * The disagreements that exist today, each one a defect with somewhere to go.
 *
 * A ratchet, not an excuse list: `catalogueDisagreements` fails on anything not here *and*
 * on anything here that has stopped disagreeing, so the list can only shrink and shrinking it
 * is a deliberate edit. The alternative was to land this gate red, which teaches people to
 * merge past a red gate -- and this repository already has one of those (#280).
 */
export const KNOWN_DISAGREEMENTS = Object.freeze({
  // Found by this gate, and the reason it was worth writing. A SPICE E/G card is
  // `Exxx n+ n- nc+ nc-`, which is what the registry writes; the catalogue declares the
  // controlling pair first. Nothing compared them, because until 0010 there was one file.
  "terminal-order|source.dependent.vcvs|the catalogue draws cp cn p n and the card writes p n cp cn":
    "#281 -- the controlling pair is declared first and written third",
  "terminal-order|source.dependent.vccs|the catalogue draws cp cn p n and the card writes p n cp cn":
    "#281 -- the controlling pair is declared first and written third",

  // A composite emits several cards, so there is no one positional list to agree with.
  "terminal-order-unchecked|passive.transformer|a composite card declares no terminal list, so p1 n1 p2 n2 is checked by nothing":
    "#282 -- a composite's terminal order is unchecked",
  "terminal-order-unchecked|passive.mutual_inductor|a composite card declares no terminal list, so p1 n1 p2 n2 is checked by nothing":
    "#282 -- a composite's terminal order is unchecked",
  "terminal-order-unchecked|passive.inductor.coupled|a composite card declares no terminal list, so p1 n1 p2 n2 is checked by nothing":
    "#282 -- a composite's terminal order is unchecked",

  // gsim-core#90, from the other side. The editor draws sig2phys's `out` as an electrical
  // terminal to be wired into a circuit; the engine compiles it as a signal the block drives.
  // That is exactly "a sig2phys output wired into a circuit node becomes a node nothing
  // drives", visible here as a disagreement rather than as a silent wrong answer. Two
  // findings for one port, because it is wrong counted from either end: drawn as a node the
  // card does not write, and compiled as an output the catalogue does not offer.
  "port-nature|converter.sig2phys|'out' is drawn as physical-electrical and compiled as a signal output":
    "gsim-core#90 -- drawn as a node, compiled as a signal",
  "terminal-order|converter.sig2phys|the catalogue draws out and the card writes (none)":
    "gsim-core#90 -- the same port, counted from the other end",

  // Fields a user fills in for nothing, which is the defect #110 names in those words.
  // `IC` is on the owner's own list of defects from a real simulation.
  "param-never-read|passive.capacitor|'IC' is offered and no card reads it":
    "#283 -- an initial condition the card never carries",
  "param-never-read|passive.inductor|'IC' is offered and no card reads it":
    "#283 -- an initial condition the card never carries",
  "param-never-read|control.integrator|'x0' is offered and no card reads it":
    "#283 -- the integrator compiles to a pid card that reads nothing",
  "param-never-read|control.integrator|'lo' is offered and no card reads it":
    "#283 -- the integrator compiles to a pid card that reads nothing",
  "param-never-read|control.integrator|'hi' is offered and no card reads it":
    "#283 -- the integrator compiles to a pid card that reads nothing",
  "param-never-read|control.pid|'form' is offered and no card reads it":
    "#283 -- parallel or ideal form is chosen and then dropped",
});

/**
 * The gate. `{ unexpected, repaired, checked }`, all three empty-or-counted for the caller.
 *
 * `repaired` is the half that keeps the ratchet honest: a known disagreement that has been
 * fixed must be struck from the table in the same change, or the table becomes a list of
 * things that used to be wrong and nobody can tell which still are.
 */
export function catalogueDisagreements(catalog, capabilities) {
  const { findings, checked } = agreementFindings(catalog, capabilities);
  const known = new Set(Object.keys(KNOWN_DISAGREEMENTS));
  return {
    unexpected: findings.filter((finding) => !known.has(finding)),
    repaired: [...known].filter((finding) => !findings.includes(finding)).sort(),
    checked,
  };
}
